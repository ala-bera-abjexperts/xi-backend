import {
  DockerHubError,
  dockerHubTags,
  readHubInput,
  resetDockerHubCache,
  searchDockerHub,
} from './docker-hub';
import {
  SafeGetError,
  type SafeGetResult,
} from '../shared/https/safe-https-get';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function answer(status: number, body: unknown = {}): SafeGetResult {
  return {
    status,
    headers: {},
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** A stand-in Docker Hub that answers by the start of the path. */
function hub(routes: Record<string, SafeGetResult>) {
  return jest.fn((url: string) => {
    const path = new URL(url).pathname;
    const match = Object.keys(routes).find((route) => path === route);

    return Promise.resolve(match ? routes[match] : answer(404));
  });
}

function firstUrl(get: jest.Mock): URL {
  return new URL((get.mock.calls as string[][])[0][0]);
}

beforeEach(() => resetDockerHubCache());

describe('readHubInput', () => {
  it.each([
    [
      'https://hub.docker.com/r/apache/cassandra-testing-ubuntu2004-java11',
      { repository: 'apache/cassandra-testing-ubuntu2004-java11' },
    ],
    [
      'hub.docker.com/r/apache/cassandra/tags?name=4',
      { repository: 'apache/cassandra' },
    ],
    ['https://hub.docker.com/_/python', { repository: 'python' }],
    [
      'https://hub.docker.com/layers/library/python/3.13-slim/images/sha256-1',
      { repository: 'python', tag: '3.13-slim' },
    ],
    [
      'docker pull --platform linux/arm64 cypress/included:15.7.0',
      { repository: 'cypress/included', tag: '15.7.0' },
    ],
    ['  Apache/Cassandra  ', { repository: 'apache/cassandra' }],
    ['library/python:3.13', { repository: 'python', tag: '3.13' }],
    ['docker.io/library/maven', { repository: 'maven' }],
    [`busybox@${DIGEST}`, { repository: 'busybox', digest: DIGEST }],
  ])('reads %j', (text, expected) => {
    expect(readHubInput(text)).toEqual(expected);
  });

  it.each([
    '',
    'two words',
    'ghcr.io/team/tests',
    'localhost:5000/tests',
    'a/b/c',
    'name@sha256:short',
    'name:bad tag',
    'https://hub.docker.com/search?q=python',
    '../etc/passwd',
  ])('refuses %j', (text) => {
    expect(readHubInput(text)).toBeNull();
  });
});

describe('searchDockerHub', () => {
  it('lists results with official images marked and long text cut', async () => {
    const get = hub({
      '/v2/search/repositories/': answer(200, {
        results: [
          {
            repo_name: 'cassandra',
            is_official: true,
            short_description: 'x'.repeat(500),
            pull_count: 9,
          },
          { repo_name: 'bitnami/cassandra', pull_count: 3 },
          { repo_name: 'Not A Name!' },
          { nothing: true },
        ],
      }),
    });

    const results = await searchDockerHub('cassandra', get);

    expect(results).toEqual([
      {
        repository: 'cassandra',
        official: true,
        description: 'x'.repeat(200),
        pulls: 9,
      },
      {
        repository: 'bitnami/cassandra',
        official: false,
        description: '',
        pulls: 3,
      },
    ]);
    expect(firstUrl(get).searchParams.get('query')).toBe('cassandra');
  });

  it('puts the image of a pasted link first, even when the search misses it', async () => {
    const get = hub({
      '/v2/search/repositories/': answer(200, {
        results: [{ repo_name: 'aweisberg/cassandra-testing' }],
      }),
      '/v2/repositories/apache/cassandra-testing-ubuntu2004-java11/': answer(
        200,
        {
          namespace: 'apache',
          name: 'cassandra-testing-ubuntu2004-java11',
          pull_count: 5,
        },
      ),
    });

    const results = await searchDockerHub(
      'https://hub.docker.com/r/apache/cassandra-testing-ubuntu2004-java11',
      get,
    );

    expect(results.map((item) => item.repository)).toEqual([
      'apache/cassandra-testing-ubuntu2004-java11',
      'aweisberg/cassandra-testing',
    ]);
    expect(firstUrl(get).searchParams.get('query')).toBe(
      'cassandra-testing-ubuntu2004-java11',
    );
  });

  it('asks nothing for less than two letters', async () => {
    const get = hub({});

    await expect(searchDockerHub(' p ', get)).resolves.toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it('keeps an answer for a while, but never a failure', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce(answer(503))
      .mockResolvedValue(answer(200, { results: [{ repo_name: 'python' }] }));

    await expect(searchDockerHub('python', get)).rejects.toMatchObject({
      code: 'DOCKER_HUB_UNREACHABLE',
    });
    await searchDockerHub('python', get);
    await searchDockerHub('python', get);

    expect(get).toHaveBeenCalledTimes(2);
  });

  it('asks again after five minutes, and forgets the oldest of 200 answers', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const get = jest.fn().mockResolvedValue(answer(200, { results: [] }));

    try {
      await searchDockerHub('first', get);
      now.mockReturnValue(1_000_000 + 5 * 60_000);
      await searchDockerHub('first', get);

      expect(get).toHaveBeenCalledTimes(2);

      for (let index = 0; index < 200; index++) {
        await searchDockerHub(`query${index}`, get);
      }

      get.mockClear();
      await searchDockerHub('first', get);

      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it('reports a rate limit, a broken answer and an unreachable Docker Hub', async () => {
    await expect(
      searchDockerHub('one', hub({ '/v2/search/repositories/': answer(429) })),
    ).rejects.toMatchObject({ code: 'REGISTRY_RATE_LIMITED' });
    await expect(
      searchDockerHub(
        'two',
        hub({ '/v2/search/repositories/': answer(200, 'not json') }),
      ),
    ).rejects.toMatchObject({ code: 'DOCKER_HUB_UNREACHABLE' });
    await expect(
      searchDockerHub(
        'three',
        jest.fn().mockRejectedValue(new SafeGetError('TOO_LARGE')),
      ),
    ).rejects.toBeInstanceOf(DockerHubError);
  });
});

describe('dockerHubTags', () => {
  const tag = (name: string, images: object[], digest: unknown = DIGEST) => ({
    name,
    digest,
    last_updated: '2025-05-29T00:00:00Z',
    images,
  });

  it("keeps only versions for this server's chip type, ignoring the variant", async () => {
    const get = hub({
      '/v2/repositories/library/python/tags/': answer(200, {
        next: 'https://hub.docker.com/v2/…page=2',
        results: [
          tag('3.13', [
            { os: 'linux', architecture: 'amd64', size: 10 },
            { os: 'linux', architecture: 'arm64', variant: 'v8', size: 20 },
          ]),
          tag('amd64-only', [{ os: 'linux', architecture: 'amd64' }]),
          tag('windows', [{ os: 'windows', architecture: 'arm64' }]),
          tag('attestation', [{ os: 'unknown', architecture: 'unknown' }]),
          tag('no-digest', [{ os: 'linux', architecture: 'arm64' }], null),
          tag('bad tag!', [{ os: 'linux', architecture: 'arm64' }]),
        ],
      }),
    });

    await expect(
      dockerHubTags('python', 'linux/arm64', '', get),
    ).resolves.toEqual({
      tags: [
        {
          tag: '3.13',
          digest: DIGEST,
          updated: '2025-05-29T00:00:00Z',
          size: 20,
        },
      ],
      more: true,
      other_platforms: [
        { tag: 'amd64-only', platforms: ['linux/amd64'] },
        { tag: 'windows', platforms: ['windows/arm64'] },
        { tag: 'attestation', platforms: [], reason: 'missing_details' },
        {
          tag: 'no-digest',
          platforms: ['linux/arm64'],
          reason: 'missing_details',
        },
      ],
      platform: 'linux/arm64',
    });

    const url = firstUrl(get);

    expect(url.searchParams.get('ordering')).toBe('last_updated');
    expect(url.searchParams.has('name')).toBe(false);
  });

  it('lists old schema 1 versions, which Docker Hub gives no os, only for their chip type', async () => {
    const get = hub({
      '/v2/repositories/training/webapp/tags/': answer(200, {
        results: [
          {
            ...tag('latest', [{ os: '', architecture: 'amd64', size: 5 }]),
            media_type:
              'application/vnd.docker.distribution.manifest.v1+prettyjws',
          },
          {
            ...tag('v2-no-os', [{ os: '', architecture: 'amd64' }]),
            media_type: 'application/vnd.docker.distribution.manifest.v2+json',
          },
        ],
      }),
    });
    const latest = {
      tag: 'latest',
      digest: DIGEST,
      updated: '2025-05-29T00:00:00Z',
      size: 5,
    };

    // A current-format version without an os is one Docker Hub gave no details for.
    const noOs = {
      tag: 'v2-no-os',
      platforms: [],
      reason: 'missing_details',
    };

    await expect(
      dockerHubTags('training/webapp', 'linux/amd64', '', get),
    ).resolves.toEqual({
      tags: [latest],
      more: false,
      other_platforms: [noOs],
      platform: 'linux/amd64',
    });
    await expect(
      dockerHubTags('training/webapp', 'linux/arm64', '', get),
    ).resolves.toEqual({
      tags: [],
      more: false,
      other_platforms: [{ tag: 'latest', platforms: ['linux/amd64'] }, noOs],
      platform: 'linux/arm64',
    });
  });

  it('names at most 20 versions of other chip types, without unknown entries', async () => {
    const get = hub({
      '/v2/repositories/library/old/tags/': answer(200, {
        results: [
          tag('attestation-only', [{ os: 'unknown', architecture: 'unknown' }]),
          ...Array.from({ length: 25 }, (_, index) =>
            tag(`v${index}`, [
              { os: 'linux', architecture: 'amd64' },
              { os: 'unknown', architecture: 'unknown' },
            ]),
          ),
        ],
      }),
    });

    const result = await dockerHubTags('old', 'linux/arm64', '', get);

    expect(result.tags).toEqual([]);
    expect(result.other_platforms).toHaveLength(20);
    expect(result.other_platforms?.slice(0, 2)).toEqual([
      { tag: 'attestation-only', platforms: [], reason: 'missing_details' },
      { tag: 'v0', platforms: ['linux/amd64'] },
    ]);
  });

  it('shows a version of this chip type without a digest as one Docker Hub gave no details for, never as one to pick', async () => {
    const get = hub({
      '/v2/repositories/library/half/tags/': answer(200, {
        results: [
          tag('1.0', [{ os: 'linux', architecture: 'arm64' }], null),
          tag('1.1', []),
        ],
      }),
    });

    await expect(
      dockerHubTags('half', 'linux/arm64', '', get),
    ).resolves.toEqual({
      tags: [],
      more: false,
      other_platforms: [
        { tag: '1.0', platforms: ['linux/arm64'], reason: 'missing_details' },
        { tag: '1.1', platforms: [], reason: 'missing_details' },
      ],
      platform: 'linux/arm64',
    });
  });

  it('filters by name on Docker Hub and encodes the path', async () => {
    const get = hub({
      '/v2/repositories/apache/cassandra/tags/': answer(200, { results: [] }),
    });

    await dockerHubTags('apache/cassandra', 'linux/amd64', ' 2023 ', get);

    expect(firstUrl(get).searchParams.get('name')).toBe('2023');
  });

  it('gives no versions for an unknown image or text that is not a Hub image', async () => {
    const get = hub({});

    await expect(
      dockerHubTags('apache/missing', 'linux/amd64', '', get),
    ).resolves.toEqual({ tags: [], more: false });
    await expect(
      dockerHubTags('ghcr.io/team/tests', 'linux/amd64', '', get),
    ).resolves.toEqual({ tags: [], more: false });
    expect(get).toHaveBeenCalledTimes(1);
  });
});
