import { createHash } from 'crypto';

import {
  dockerHubTags,
  resetDockerHubCache,
  searchDockerHub,
} from '../docker-hub/docker-hub';
import type { SafeGetResult } from '../shared/https/safe-https-get';
import {
  checkImage,
  findingDetail,
  parseUserImageRef,
  reviewImageInRegistry,
} from './custom-image-review';

// Nothing here may reach a real registry.
jest.mock('https', () => ({ request: jest.fn() }));

const HEX = 'a'.repeat(64);
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const MAX = 5 * 1024 ** 3;

function answer(status: number, body: unknown = {}): SafeGetResult {
  return {
    status,
    headers: {},
    body: Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)),
  };
}

function blob(value: unknown): { body: Buffer; digest: string } {
  const body = Buffer.from(JSON.stringify(value));

  return {
    body,
    digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
  };
}

function registry(routes: Record<string, SafeGetResult>) {
  return jest.fn((url: string) => {
    const match = Object.keys(routes).find((path) => url.endsWith(path));

    return Promise.resolve(match ? routes[match] : answer(404));
  });
}

const refFor = (digest: string) =>
  parseUserImageRef(`ghcr.io/team/tests@${digest}`, ['ghcr.io']);

describe('findingDetail', () => {
  it('removes control characters and keeps at most 300 characters', () => {
    expect(findingDetail('linux\u0000/\u001bamd64\u0007')).toBe('linux/amd64');
    expect(findingDetail('x'.repeat(1000))).toHaveLength(300);
  });
});

describe('checkImage with text from inside the image', () => {
  it('cleans and cuts the platform, label names and volume paths it reports', () => {
    const long = `/data${'\u0001'.repeat(5)}${'v'.repeat(400)}`;
    const review = checkImage(
      { config: { size: 1 }, layers: [] },
      {
        os: 'linux\u001b[31m',
        architecture: 'a'.repeat(400),
        config: {
          Labels: { 'xisuite.secret\u0000': 'x' },
          Volumes: { [long]: {} },
        },
      },
      'linux/amd64',
      MAX,
    );
    const details = review.findings.map((item) => item.detail);

    expect(review.findings.map((item) => item.code)).toEqual([
      'IMAGE_WRONG_PLATFORM',
      'IMAGE_BAD_LABELS',
      'IMAGE_HAS_VOLUMES',
    ]);
    details.forEach((detail) => {
      expect(detail.length).toBeLessThanOrEqual(300);
      // eslint-disable-next-line no-control-regex
      expect(detail).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    });
  });

  it('skips layers and a settings entry that are not objects', () => {
    const review = checkImage(
      { config: 'x', layers: [null, 7, { size: 10 }] },
      { os: 'linux', architecture: 'amd64' },
      'linux/amd64',
      MAX,
    );

    expect(review.sizeBytes).toBe(10);
    expect(review.findings).toEqual([]);
  });
});

describe('reviewImageInRegistry with a crafted description', () => {
  it('skips index entries that are not objects', async () => {
    const index = blob({
      mediaType: OCI_INDEX,
      manifests: [null, 'x', 3, { mediaType: OCI_MANIFEST, platform: null }],
    });
    const get = registry({
      [`manifests/${index.digest}`]: answer(200, index.body),
    });

    await expect(
      reviewImageInRegistry(refFor(index.digest), 'linux/amd64', MAX, get),
    ).rejects.toMatchObject({ code: 'IMAGE_PLATFORM_MISSING' });
  });

  it('refuses a manifest whose settings entry is not an object', async () => {
    const manifest = blob({
      mediaType: OCI_MANIFEST,
      config: `sha256:${HEX}`,
      layers: [],
    });
    const get = registry({
      [`manifests/${manifest.digest}`]: answer(200, manifest.body),
    });

    await expect(
      reviewImageInRegistry(refFor(manifest.digest), 'linux/amd64', MAX, get),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MANIFEST' });
  });

  it('reads a manifest whose layer list holds entries that are not objects', async () => {
    const config = blob({ os: 'linux', architecture: 'amd64' });
    const manifest = blob({
      mediaType: OCI_MANIFEST,
      config: { digest: config.digest, size: 2 },
      layers: [null, 'x', { size: 3 }],
    });
    const get = registry({
      [`manifests/${manifest.digest}`]: answer(200, manifest.body),
      [`blobs/${config.digest}`]: answer(200, config.body),
    });

    const review = await reviewImageInRegistry(
      refFor(manifest.digest),
      'linux/amd64',
      MAX,
      get,
    );

    expect(review.sizeBytes).toBe(5);
  });
});

describe('Docker Hub answers', () => {
  const DIGEST = `sha256:${HEX}`;

  beforeEach(() => resetDockerHubCache());

  it('skips results that are not objects and cleans the description', async () => {
    const get = jest.fn(() =>
      Promise.resolve(
        answer(200, {
          results: [
            null,
            'python',
            {
              repo_name: 'python',
              short_description: `Py\u0000thon\u001b${'d'.repeat(400)}`,
            },
          ],
        }),
      ),
    );

    const list = await searchDockerHub('python', get);

    expect(list).toHaveLength(1);
    expect(list[0].repository).toBe('python');
    expect(list[0].description).toHaveLength(200);
    expect(list[0].description.startsWith('Python')).toBe(true);
  });

  it('keeps only a short, readable update date and skips broken entries', async () => {
    const image = { os: 'linux', architecture: 'amd64', size: 5 };
    const get = jest.fn(() =>
      Promise.resolve(
        answer(200, {
          results: [
            null,
            { name: 'bad', digest: DIGEST, images: [null, 'x'] },
            {
              name: 'a',
              digest: DIGEST,
              last_updated: '2026-11-01T10:00:00Z',
              images: [image],
            },
            {
              name: 'b',
              digest: DIGEST,
              last_updated: 'not a date',
              images: [image],
            },
            {
              name: 'c',
              digest: DIGEST,
              last_updated: `2026-11-01T10:00:00Z${' '.repeat(40)}`,
              images: [image],
            },
          ],
        }),
      ),
    );

    const { tags } = await dockerHubTags('python', 'linux/amd64', '', get);

    expect(tags.map((item) => [item.tag, item.updated])).toEqual([
      ['a', '2026-11-01T10:00:00Z'],
      ['b', null],
      ['c', null],
    ]);
  });
});
