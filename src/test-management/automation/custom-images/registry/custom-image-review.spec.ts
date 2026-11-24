import { createHash } from 'crypto';
import { request } from 'https';

import {
  SafeGetError,
  safeHttpsGet,
  type SafeGetOptions,
  type SafeGetResult,
} from '../shared/https/safe-https-get';
import {
  fetchSchema1Manifest,
  maxUserImageBytes,
  imageHints,
  parseUserImageRef,
  reviewImageInRegistry,
  runnerPlatform,
  userImageRegistries,
  UserImageError,
  type UserImageRef,
  volumesLeftBehind,
} from './custom-image-review';

// Nothing here may reach a real registry.
jest.mock('https', () => ({ request: jest.fn() }));

/** The error code a refused address gives, or undefined when it is accepted. */
function refusal(value: string): string | undefined {
  try {
    parseUserImageRef(value, ALLOWED);
  } catch (error) {
    return error instanceof UserImageError ? error.code : 'OTHER';
  }

  return undefined;
}

const HEX = 'a'.repeat(64);
const ALLOWED = ['docker.io', 'ghcr.io', 'registry.example.com:5000'];

const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';

function blob(value: unknown): { body: Buffer; digest: string } {
  const body = Buffer.from(JSON.stringify(value));

  return {
    body,
    digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
  };
}

function answer(
  status: number,
  body: Buffer = Buffer.alloc(0),
  headers: Record<string, string> = {},
): SafeGetResult {
  return { status, headers, body };
}

const goodConfig = {
  os: 'linux',
  architecture: 'amd64',
  config: {
    Labels: {
      'xisuite.language': 'python',
      'xisuite.test-framework': 'pytest',
    },
  },
};

function image(config: unknown = goodConfig, layers = 2) {
  const configBlob = blob(config);
  const manifest = blob({
    mediaType: OCI_MANIFEST,
    config: { digest: configBlob.digest, size: configBlob.body.length },
    layers: Array.from({ length: layers }, () => ({
      digest: `sha256:${HEX}`,
      size: 1000,
    })),
  });

  return { configBlob, manifest };
}

function refFor(digest: string): UserImageRef {
  return parseUserImageRef(`ghcr.io/team/tests@${digest}`, ALLOWED);
}

/** A stand-in registry that answers by the end of the address. */
function registry(routes: Record<string, SafeGetResult>) {
  return jest.fn((url: string) => {
    const match = Object.keys(routes).find((path) => url.endsWith(path));

    return Promise.resolve(match ? routes[match] : answer(404));
  });
}

describe('userImageRegistries', () => {
  it('reads the allowed hosts and treats the Docker Hub names as one', () => {
    expect(userImageRegistries(' ghcr.io, index.docker.io,DOCKER.IO ')).toEqual(
      ['ghcr.io', 'docker.io'],
    );
  });

  it('drops local and IP hosts and anything that is not a host name', () => {
    expect(userImageRegistries('localhost,127.0.0.1:5000,a b,ghcr.io')).toEqual(
      ['ghcr.io'],
    );
  });

  it('is empty when nothing is set', () => {
    expect(userImageRegistries(undefined)).toEqual([]);
  });
});

describe('runnerPlatform and maxUserImageBytes', () => {
  it('uses amd64 unless arm64 is set', () => {
    expect(runnerPlatform(undefined)).toBe('linux/amd64');
    expect(runnerPlatform('linux/arm64')).toBe('linux/arm64');
    expect(runnerPlatform('windows/amd64')).toBe('linux/amd64');
  });

  it('keeps the size limit between 1 and 50 GB, else 5', () => {
    expect(maxUserImageBytes('2')).toBe(2 * 1024 ** 3);
    expect(maxUserImageBytes('0')).toBe(5 * 1024 ** 3);
    expect(maxUserImageBytes('abc')).toBe(5 * 1024 ** 3);
  });
});

describe('parseUserImageRef', () => {
  it('turns a Docker Hub short name into its full address', () => {
    expect(parseUserImageRef(`python@sha256:${HEX}`, ALLOWED)).toEqual({
      registry: 'docker.io',
      repository: 'library/python',
      digest: `sha256:${HEX}`,
      imageRef: `docker.io/library/python@sha256:${HEX}`,
    });
  });

  it('keeps a user repository and a registry with a port', () => {
    expect(
      parseUserImageRef(`team/tests@sha256:${HEX}`, ALLOWED).imageRef,
    ).toBe(`docker.io/team/tests@sha256:${HEX}`);
    expect(
      parseUserImageRef(`registry.example.com:5000/a/b@sha256:${HEX}`, ALLOWED)
        .registry,
    ).toBe('registry.example.com:5000');
  });

  it('drops a tag written next to the digest', () => {
    expect(
      parseUserImageRef(`GHCR.io/team/tests:1.2@sha256:${HEX}`, ALLOWED)
        .imageRef,
    ).toBe(`ghcr.io/team/tests@sha256:${HEX}`);
  });

  it.each([
    ['no digest', 'ghcr.io/team/tests:latest'],
    ['a short digest', 'ghcr.io/team/tests@sha256:abc'],
    ['an uppercase name', `ghcr.io/Team/tests@sha256:${HEX}`],
    ['an IP address', `10.0.0.5/team/tests@sha256:${HEX}`],
    ['localhost', `localhost:5000/team/tests@sha256:${HEX}`],
    ['a name that is too long', `ghcr.io/${'a'.repeat(500)}@sha256:${HEX}`],
  ])('refuses %s', (_, value) => {
    expect(refusal(value)).toBe('IMAGE_REF_INVALID');
  });

  it('refuses a registry the server does not allow', () => {
    expect(refusal(`quay.io/team/tests@sha256:${HEX}`)).toBe(
      'REGISTRY_NOT_ALLOWED',
    );
  });
});

describe('reviewImageInRegistry', () => {
  const MAX = 5 * 1024 ** 3;

  it('reads a clean single-platform image', async () => {
    const { configBlob, manifest } = image();
    const get = registry({
      [`manifests/${manifest.digest}`]: answer(200, manifest.body),
      [`blobs/${configBlob.digest}`]: answer(200, configBlob.body),
    });

    const review = await reviewImageInRegistry(
      refFor(manifest.digest),
      'linux/amd64',
      MAX,
      get,
    );

    expect(review).toEqual(
      expect.objectContaining({
        runRef: `ghcr.io/team/tests@${manifest.digest}`,
        language: 'python',
        testFramework: 'pytest',
        findings: [],
      }),
    );
    expect(get.mock.calls[0][0]).toBe(
      `https://ghcr.io/v2/team/tests/manifests/${manifest.digest}`,
    );
  });

  it('picks this chip type from a multi-platform image and skips attestations', async () => {
    const { configBlob, manifest } = image({
      ...goodConfig,
      architecture: 'arm64',
    });
    const index = blob({
      mediaType: OCI_INDEX,
      manifests: [
        {
          mediaType: OCI_MANIFEST,
          digest: `sha256:${'b'.repeat(64)}`,
          platform: { os: 'linux', architecture: 'amd64' },
        },
        {
          mediaType: OCI_MANIFEST,
          digest: `sha256:${'c'.repeat(64)}`,
          platform: { os: 'unknown', architecture: 'unknown' },
          annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
        },
        {
          mediaType: OCI_MANIFEST,
          digest: manifest.digest,
          platform: { os: 'linux', architecture: 'arm64', variant: 'v8' },
        },
      ],
    });
    const get = registry({
      [`manifests/${index.digest}`]: answer(200, index.body),
      [`manifests/${manifest.digest}`]: answer(200, manifest.body),
      [`blobs/${configBlob.digest}`]: answer(200, configBlob.body),
    });

    const review = await reviewImageInRegistry(
      refFor(index.digest),
      'linux/arm64',
      MAX,
      get,
    );

    expect(review.runRef).toBe(`ghcr.io/team/tests@${manifest.digest}`);
    expect(review.findings).toEqual([]);
  });

  it('refuses a multi-platform image without this chip type, and nested indexes', async () => {
    const index = blob({
      mediaType: OCI_INDEX,
      manifests: [
        {
          mediaType: OCI_INDEX,
          digest: `sha256:${'d'.repeat(64)}`,
          platform: { os: 'linux', architecture: 'amd64' },
        },
      ],
    });
    const get = registry({
      [`manifests/${index.digest}`]: answer(200, index.body),
    });

    await expect(
      reviewImageInRegistry(refFor(index.digest), 'linux/amd64', MAX, get),
    ).rejects.toMatchObject({
      code: 'IMAGE_PLATFORM_MISSING',
    });
  });

  it('refuses an answer whose bytes do not match the digest', async () => {
    const { manifest } = image();
    const get = registry({
      [`manifests/${manifest.digest}`]: answer(
        200,
        Buffer.from('{"changed":true}'),
      ),
    });

    await expect(
      reviewImageInRegistry(refFor(manifest.digest), 'linux/amd64', MAX, get),
    ).rejects.toMatchObject({
      code: 'DIGEST_MISMATCH',
    });
  });

  it('refuses a settings file that does not match its digest', async () => {
    const { configBlob, manifest } = image();
    const get = registry({
      [`manifests/${manifest.digest}`]: answer(200, manifest.body),
      [`blobs/${configBlob.digest}`]: answer(200, Buffer.from('{}')),
    });

    await expect(
      reviewImageInRegistry(refFor(manifest.digest), 'linux/amd64', MAX, get),
    ).rejects.toMatchObject({
      code: 'DIGEST_MISMATCH',
    });
  });

  it('refuses the old schema1 format', async () => {
    const old = blob({
      schemaVersion: 1,
      mediaType: 'application/vnd.docker.distribution.manifest.v1+prettyjws',
    });
    const get = registry({
      [`manifests/${old.digest}`]: answer(200, old.body),
    });

    await expect(
      reviewImageInRegistry(refFor(old.digest), 'linux/amd64', MAX, get),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_MANIFEST',
    });
  });

  describe('old schema 1 images', () => {
    const SCHEMA1 = 'application/vnd.docker.distribution.manifest.v1+prettyjws';
    const step = (settings: object) => ({
      v1Compatibility: JSON.stringify(settings),
    });

    /** A schema 1 description signed the way Docker did: the digest names the text without its signatures. */
    function signed(
      settings: object = goodConfig,
      extra: Record<string, unknown> = {},
    ) {
      const payload = JSON.stringify(
        {
          schemaVersion: 1,
          architecture: 'amd64',
          // Newest first; the newest step is an empty one Docker never stored.
          fsLayers: [
            { blobSum: `sha256:${'e'.repeat(64)}` },
            { blobSum: `sha256:${'f'.repeat(64)}` },
            { blobSum: `sha256:${'0'.repeat(64)}` },
          ],
          history: [
            step({ ...settings, throwaway: true }),
            step({ id: 'middle' }),
            step({ id: 'base' }),
          ],
          ...extra,
        },
        null,
        3,
      );
      const cut = payload.lastIndexOf('\n}');
      const header = Buffer.from(
        JSON.stringify({
          formatLength: cut,
          formatTail: Buffer.from(payload.slice(cut)).toString('base64url'),
        }),
      ).toString('base64url');
      const body = `${payload.slice(0, cut)},\n   "signatures": [{ "protected": "${header}", "signature": "x" }]${payload.slice(cut)}`;

      return {
        body: Buffer.from(body),
        digest: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
      };
    }

    const asSchema1 = (body: Buffer) =>
      answer(200, body, { 'content-type': SCHEMA1 });

    it('reads a signed old image by the digest of its signed part, without its size', async () => {
      const old = signed();
      const get = registry({
        [`manifests/${old.digest}`]: asSchema1(old.body),
      });

      const review = await reviewImageInRegistry(
        refFor(old.digest),
        'linux/amd64',
        MAX,
        get,
      );

      expect(review).toEqual(
        expect.objectContaining({
          runRef: `ghcr.io/team/tests@${old.digest}`,
          language: 'python',
          testFramework: 'pytest',
          sizeBytes: null,
          findings: [],
        }),
      );
      expect(get).toHaveBeenCalledTimes(1);
    });

    it('refuses a changed old description and a damaged signature', async () => {
      const old = signed();
      const changed = Buffer.from(
        old.body.toString().replace('"amd64"', '"arm64"'),
      );
      const broken = Buffer.from(
        old.body.toString().replace(/"protected": "[^"]+"/, '"protected": "!"'),
      );

      for (const body of [changed, broken]) {
        await expect(
          reviewImageInRegistry(
            refFor(old.digest),
            'linux/amd64',
            MAX,
            registry({ [`manifests/${old.digest}`]: asSchema1(body) }),
          ),
        ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
      }
    });

    it('lists the same problems as for a current image, counting only stored layers', async () => {
      const old = signed({
        architecture: 'amd64',
        config: { Volumes: { '/data': {} } },
      });
      const get = registry({
        [`manifests/${old.digest}`]: asSchema1(old.body),
      });

      const review = await reviewImageInRegistry(
        refFor(old.digest),
        'linux/arm64',
        MAX,
        get,
      );

      expect(review.findings.map((item) => item.code)).toEqual([
        'IMAGE_WRONG_PLATFORM',
        'IMAGE_HAS_VOLUMES',
      ]);
      expect(review.findings[0].detail).toBe('linux/amd64');
    });

    it('refuses an old description whose steps and layers do not match', async () => {
      const old = signed(goodConfig, { history: [step(goodConfig)] });

      await expect(
        reviewImageInRegistry(
          refFor(old.digest),
          'linux/amd64',
          MAX,
          registry({ [`manifests/${old.digest}`]: asSchema1(old.body) }),
        ),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_MANIFEST' });
    });

    it('hands the runner the layers oldest first, and nothing for a current image', async () => {
      const old = signed();
      const { manifest } = image();
      const get = registry({
        [`manifests/${old.digest}`]: asSchema1(old.body),
        [`manifests/${manifest.digest}`]: answer(200, manifest.body),
      });

      const found = await fetchSchema1Manifest(refFor(old.digest), get);

      expect(found?.layers.map((layer) => layer.digest)).toEqual([
        `sha256:${'0'.repeat(64)}`,
        `sha256:${'f'.repeat(64)}`,
        `sha256:${'e'.repeat(64)}`,
      ]);
      expect(found?.layers.map((layer) => layer.throwaway)).toEqual([
        false,
        false,
        true,
      ]);
      expect(found?.config).toMatchObject({
        os: 'linux',
        architecture: 'amd64',
      });
      await expect(
        fetchSchema1Manifest(refFor(manifest.digest), get),
      ).resolves.toBeNull();
    });
  });

  it('fetches an anonymous token when the registry asks for one', async () => {
    const { configBlob, manifest } = image();
    const challenge =
      'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:team/tests:pull"';
    let asked = 0;
    const get = jest.fn((url: string, headers: Record<string, string>) => {
      if (url.startsWith('https://ghcr.io/token')) {
        return Promise.resolve(answer(200, Buffer.from('{"token":"t1"}')));
      }

      if (!headers.authorization) {
        asked += 1;

        return Promise.resolve(
          answer(401, Buffer.alloc(0), { 'www-authenticate': challenge }),
        );
      }

      return Promise.resolve(
        url.endsWith(manifest.digest)
          ? answer(200, manifest.body)
          : answer(200, configBlob.body),
      );
    });

    await reviewImageInRegistry(
      refFor(manifest.digest),
      'linux/amd64',
      MAX,
      get,
    );

    expect(asked).toBe(1);
    expect(get.mock.calls[1][0]).toContain(
      'scope=repository%3Ateam%2Ftests%3Apull',
    );
    expect(get.mock.calls[2][1]).toEqual(
      expect.objectContaining({ authorization: 'Bearer t1' }),
    );
  });

  it('refuses a sign-in address that is an IP address, without sending anything', async () => {
    const { manifest } = image();

    for (const realm of ['https://10.0.0.5/token', 'https://[::1]/token']) {
      const get = jest.fn(
        (
          url: string,
          headers: Record<string, string>,
          options: SafeGetOptions,
        ) =>
          url.startsWith('https://ghcr.io/')
            ? Promise.resolve(
                answer(401, Buffer.alloc(0), {
                  'www-authenticate': `Bearer realm="${realm}"`,
                }),
              )
            : safeHttpsGet(url, headers, options),
      ) as jest.MockedFunction<typeof safeHttpsGet>;

      await expect(
        reviewImageInRegistry(refFor(manifest.digest), 'linux/amd64', MAX, get),
      ).rejects.toMatchObject({ code: 'REGISTRY_UNREACHABLE' });
      expect(get).toHaveBeenCalledTimes(2);
    }

    expect(request).not.toHaveBeenCalled();
  });

  it('reports a private image, a rate limit and an unreachable registry', async () => {
    const digest = `sha256:${HEX}`;

    await expect(
      reviewImageInRegistry(refFor(digest), 'linux/amd64', MAX, registry({})),
    ).rejects.toMatchObject({ code: 'IMAGE_NOT_PUBLIC' });
    await expect(
      reviewImageInRegistry(
        refFor(digest),
        'linux/amd64',
        MAX,
        registry({ [`manifests/${digest}`]: answer(429) }),
      ),
    ).rejects.toMatchObject({ code: 'REGISTRY_RATE_LIMITED' });
    await expect(
      reviewImageInRegistry(
        refFor(digest),
        'linux/amd64',
        MAX,
        jest.fn(() => Promise.reject(new SafeGetError('BLOCKED_HOST'))),
      ),
    ).rejects.toMatchObject({ code: 'REGISTRY_UNREACHABLE' });
  });

  it('lists every problem of an image at once', async () => {
    const { configBlob, manifest } = image(
      {
        os: 'linux',
        architecture: 'arm64',
        config: {
          Labels: {
            'com.docker.compose.project': 'supabase',
            'xisuite.run': 'x',
          },
          Volumes: { '/data': {} },
        },
      },
      101,
    );
    const get = registry({
      [`manifests/${manifest.digest}`]: answer(200, manifest.body),
      [`blobs/${configBlob.digest}`]: answer(200, configBlob.body),
    });

    const review = await reviewImageInRegistry(
      refFor(manifest.digest),
      'linux/amd64',
      1000,
      get,
    );

    expect(review.findings.map((finding) => finding.code)).toEqual([
      'IMAGE_TOO_MANY_LAYERS',
      'IMAGE_TOO_LARGE',
      'IMAGE_WRONG_PLATFORM',
      'IMAGE_BAD_LABELS',
      'IMAGE_HAS_VOLUMES',
    ]);
  });

  it('accepts an image without labels and leaves its framework to the user', async () => {
    const { configBlob, manifest } = image({ ...goodConfig, config: {} });
    const get = registry({
      [`manifests/${manifest.digest}`]: answer(200, manifest.body),
      [`blobs/${configBlob.digest}`]: answer(200, configBlob.body),
    });

    const review = await reviewImageInRegistry(
      refFor(manifest.digest),
      'linux/amd64',
      MAX,
      get,
    );

    expect(review).toMatchObject({
      language: null,
      testFramework: null,
      findings: [],
    });
  });

  it('refuses an image with only one of the two labels', async () => {
    const { configBlob, manifest } = image({
      ...goodConfig,
      config: { Labels: { 'xisuite.test-framework': 'pytest' } },
    });
    const get = registry({
      [`manifests/${manifest.digest}`]: answer(200, manifest.body),
      [`blobs/${configBlob.digest}`]: answer(200, configBlob.body),
    });

    const review = await reviewImageInRegistry(
      refFor(manifest.digest),
      'linux/amd64',
      MAX,
      get,
    );

    expect(review.findings).toEqual([
      expect.objectContaining({ code: 'IMAGE_BAD_LABELS' }),
    ]);
  });

  it('refuses badly formed label values', async () => {
    const { configBlob, manifest } = image({
      ...goodConfig,
      config: {
        Labels: {
          'xisuite.language': 'Python 3!',
          'xisuite.test-framework': 'pytest',
        },
      },
    });
    const get = registry({
      [`manifests/${manifest.digest}`]: answer(200, manifest.body),
      [`blobs/${configBlob.digest}`]: answer(200, configBlob.body),
    });

    const review = await reviewImageInRegistry(
      refFor(manifest.digest),
      'linux/amd64',
      MAX,
      get,
    );

    expect(review.findings).toEqual([
      expect.objectContaining({ code: 'IMAGE_BAD_LABELS' }),
    ]);
  });
});

describe('imageHints', () => {
  it('reads the language from a NAME_VERSION variable and the start program', () => {
    expect(
      imageHints({
        Env: ['PATH=/usr/local/bin', 'PYTHON_VERSION=3.15.2'],
        Cmd: ['python3'],
      }),
    ).toEqual({ language: 'python', testFramework: null });
  });

  it('reads both from a framework the image starts or names', () => {
    expect(
      imageHints({ Entrypoint: ['/usr/local/bin/cypress', 'run'] }),
    ).toEqual({
      language: 'javascript',
      testFramework: 'cypress',
    });
    expect(imageHints({ Env: ['PLAYWRIGHT_VERSION=1.50.0'] })).toEqual({
      language: 'javascript',
      testFramework: 'playwright',
    });
  });

  it('does not take a built-in object name for a known framework', () => {
    expect(
      imageHints({
        Env: ['CONSTRUCTOR_VERSION=1', 'TOSTRING_VERSION=2'],
        Entrypoint: ['/bin/__proto__'],
        Cmd: ['hasOwnProperty'],
      }),
    ).toEqual({ language: null, testFramework: null });
  });

  it('gives nothing for an image that names no known language or framework', () => {
    expect(imageHints({ Env: ['PATH=/bin'], Cmd: ['sh'] })).toEqual({
      language: null,
      testFramework: null,
    });
    expect(imageHints({ Env: 'bad', Cmd: [42] })).toEqual({
      language: null,
      testFramework: null,
    });
  });
});

describe('volumesLeftBehind', () => {
  it('accepts a volume at a path every run mounts itself, and nothing else', () => {
    expect(
      volumesLeftBehind(['/tmp', '/work/', '/data', '/tmp/cache', '/']),
    ).toEqual(['/data', '/tmp/cache', '/']);
  });

  it('accepts an image whose only volume is /tmp', async () => {
    const { configBlob, manifest } = image({
      ...goodConfig,
      config: { ...goodConfig.config, Volumes: { '/tmp': {} } },
    });
    const get = registry({
      [`manifests/${manifest.digest}`]: answer(200, manifest.body),
      [`blobs/${configBlob.digest}`]: answer(200, configBlob.body),
    });

    const review = await reviewImageInRegistry(
      refFor(manifest.digest),
      'linux/amd64',
      5 * 1024 ** 3,
      get,
    );

    expect(review.findings).toEqual([]);
  });
});
