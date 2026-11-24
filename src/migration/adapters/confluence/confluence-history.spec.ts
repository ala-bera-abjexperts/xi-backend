/**
 * @fileoverview Revision-history reads for both Confluence editions.
 *
 * The live test connection is Server, so Cloud is only ever exercised here — these recorded
 * payloads are the whole of the Cloud guarantee and are deliberately shaped like the real v2
 * envelopes (cursor in `_links.next`, `message` on the version, per-version download link).
 *
 * @module src/migration/adapters/confluence/confluence-history.spec
 * @author Prince Jadiya
 */

import type { AtlassianHttpClient } from '../http/atlassian-http-client';
import { ConfluenceServerAdapter } from './confluence-server.adapter';
import { ConfluenceCloudAdapter } from './confluence-cloud.adapter';

function httpStub(routes: Record<string, unknown>, probeOk = true) {
  const seen: string[] = [];

  return {
    seen,
    http: {
      getJson: jest.fn((path: string) => {
        seen.push(path);

        const hit = Object.keys(routes).find((key) => path.startsWith(key));

        if (!hit) throw new Error(`unexpected path ${path}`);

        return Promise.resolve(routes[hit]);
      }),
      probe: jest
        .fn()
        .mockResolvedValue({ ok: probeOk, status: probeOk ? 200 : 404 }),
    } as unknown as AtlassianHttpClient,
  };
}

const VERSION_LIST = {
  results: [
    {
      number: 1,
      when: '2024-01-01T10:00:00.000Z',
      message: 'created',
      minorEdit: false,
      by: { userKey: 'user-a' },
    },
    {
      number: 2,
      when: '2024-02-01T10:00:00.000Z',
      message: '',
      minorEdit: true,
      by: { userKey: 'user-b' },
    },
    { number: 3, when: '2024-03-01T10:00:00.000Z', by: { userKey: 'user-a' } },
  ],
  _links: {},
};

describe('Confluence revision history', () => {
  it('hydrates every Cloud revision across cursors without re-encoding download links', async () => {
    const { http, seen } = httpStub({
      '/wiki/api/v2/attachments/a/versions?limit=50': {
        results: [{ number: 2 }],
        _links: {
          base: 'https://cloud.test/wiki',
          next: '/wiki/api/v2/attachments/a/versions?cursor=next',
        },
      },
      '/wiki/api/v2/attachments/a/versions?cursor=next': {
        results: [{ number: 1 }, { number: 2 }],
      },
      '/wiki/api/v2/attachments/a?version=1': {
        title: 'old name.xlsx',
        version: { number: 1, authorId: 'cloud-account' },
        fileSize: 10,
        mediaType: 'application/vnd.ms-excel',
        downloadLink:
          'https://cloud.test/wiki/download/old%20name.xlsx?version=1',
      },
      '/wiki/api/v2/attachments/a?version=2': {
        title: 'new.xlsx',
        version: { number: 2 },
        downloadLink: '/download/new.xlsx?version=2',
      },
    });
    const result = await new ConfluenceCloudAdapter(http).getAttachmentVersions(
      'a',
    );
    expect(result).toMatchObject([
      {
        version: 1,
        authorSourceId: 'cloud-account',
        sizeBytes: 10,
        downloadUrl:
          'https://cloud.test/wiki/download/old%20name.xlsx?version=1',
      },
      {
        version: 2,
        downloadUrl: 'https://cloud.test/wiki/download/new.xlsx?version=2',
      },
    ]);
    expect(seen).toHaveLength(4);
  });

  it('rejects Cloud current bytes returned for a requested historical revision', async () => {
    const { http } = httpStub({
      '/wiki/api/v2/attachments/a/versions': { results: [{ number: 1 }] },
      '/wiki/api/v2/attachments/a?version=1': {
        version: { number: 2 },
        downloadLink: '/current.xlsx',
      },
    });
    await expect(
      new ConfluenceCloudAdapter(http).getAttachmentVersions('a'),
    ).rejects.toThrow(/version 1/);
  });

  it('hydrates Server attachment versions from their historical content, preserving each binary URL and filename', async () => {
    const { http, seen } = httpStub({
      '/rest/experimental/content/att-1/version': {
        results: [{ number: 2 }, { number: 1 }],
        _links: { base: 'https://confluence.test' },
      },
      '/rest/api/content/att-1?expand=': {
        title: 'approved.xlsx',
        version: { number: 2 },
        extensions: { fileSize: 200 },
        _links: { download: '/download/attachments/1/approved.xlsx?version=2' },
      },
      '/rest/api/content/att-1?status=historical&version=1': {
        title: 'draft.xlsx',
        version: { number: 1, message: 'First register' },
        extensions: { fileSize: 100 },
        _links: { download: '/download/attachments/1/draft.xlsx?version=1' },
      },
    });
    const versions = await new ConfluenceServerAdapter(
      http,
    ).getAttachmentVersions('att-1');
    expect(versions).toMatchObject([
      {
        version: 1,
        filename: 'draft.xlsx',
        sizeBytes: 100,
        message: 'First register',
        downloadUrl:
          'https://confluence.test/download/attachments/1/draft.xlsx?version=1',
      },
      {
        version: 2,
        filename: 'approved.xlsx',
        sizeBytes: 200,
        downloadUrl:
          'https://confluence.test/download/attachments/1/approved.xlsx?version=2',
      },
    ]);
    expect(seen).toHaveLength(3);
  });

  it('rejects a Server attachment revision that resolves to different current bytes', async () => {
    const { http } = httpStub({
      '/rest/experimental/content/att-1/version': {
        results: [{ number: 2 }, { number: 1 }],
        _links: {},
      },
      '/rest/api/content/att-1?expand=': { version: { number: 2 } },
      '/rest/api/content/att-1?status=historical&version=1': {
        version: { number: 2 },
      },
    });
    await expect(
      new ConfluenceServerAdapter(http).getAttachmentVersions('att-1'),
    ).rejects.toThrow(/version.*1/i);
  });
  describe.each([
    [
      'server',
      () => new ConfluenceServerAdapter(httpStub({}).http),
      '/rest/experimental/content/page-1/version',
    ],
    [
      'cloud',
      () => new ConfluenceCloudAdapter(httpStub({}).http),
      '/wiki/api/v2/pages/page-1/versions',
    ],
  ])('%s adapter', (edition, _make, versionsPath) => {
    function adapterFor(routes: Record<string, unknown>, probeOk = true) {
      const stub = httpStub(routes, probeOk);
      const adapter =
        edition === 'server'
          ? new ConfluenceServerAdapter(stub.http)
          : new ConfluenceCloudAdapter(stub.http);

      return { adapter, ...stub };
    }

    it('lists revisions oldest-first and flags the current one', async () => {
      const { adapter } = adapterFor({ [versionsPath]: VERSION_LIST });

      const versions = await adapter.getPageVersions('page-1');

      expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
      expect(versions[2]?.current).toBe(true);
      expect(versions[0]?.current).toBe(false);
    });

    it('carries the change message, minor-edit flag and author through', async () => {
      const { adapter } = adapterFor({ [versionsPath]: VERSION_LIST });

      const versions = await adapter.getPageVersions('page-1');

      expect(versions[0]).toMatchObject({
        message: 'created',
        minorEdit: false,
        authorSourceId: 'user-a',
      });
      // An empty version comment must become undefined, not a stored empty string.
      expect(versions[1]?.message).toBeUndefined();
      expect(versions[1]?.minorEdit).toBe(true);
    });

    it('asks for the historical body with status=historical so the source cannot serve current', async () => {
      const { adapter, seen } = adapterFor({
        '/rest/api/content/page-1?status=historical': {
          title: 'Earlier page title',
          body: { storage: { value: '<p>v2 body</p>' } },
        },
        '/wiki/rest/api/content/page-1?status=historical': {
          title: 'Earlier page title',
          body: { storage: { value: '<p>v2 body</p>' } },
        },
      });

      const body = await adapter.getPageBodyAtVersion('page-1', 2, 'storage');

      expect(body).toEqual({
        format: 'storage',
        value: '<p>v2 body</p>',
        title: 'Earlier page title',
      });
      expect(seen.some((p) => p.includes('status=historical'))).toBe(true);
      expect(seen.some((p) => p.includes('version=2'))).toBe(true);
    });

    it('returns null when the source lists a revision but withholds its body', async () => {
      const { adapter } = adapterFor({
        '/rest/api/content/page-1?status=historical': { body: {} },
        '/wiki/rest/api/content/page-1?status=historical': { body: {} },
      });

      await expect(
        adapter.getPageBodyAtVersion('page-1', 2, 'storage'),
      ).resolves.toBeNull();
    });

    it('reports history as unsupported when the probe fails', async () => {
      const { adapter } = adapterFor({}, false);

      await expect(adapter.supportsHistory()).resolves.toBe(false);
    });

    it('probes only once and reuses the answer', async () => {
      const { adapter, http } = adapterFor({}, true);

      await adapter.supportsHistory();
      await adapter.supportsHistory();

      expect((http.probe as jest.Mock).mock.calls).toHaveLength(1);
    });

    it('builds a per-version attachment download URL against the site origin', async () => {
      const attachment = {
        id: 'att-1',
        title: 'handbook.pdf',
        version: {
          number: 1,
          when: '2024-01-01T10:00:00.000Z',
          message: 'first upload',
        },
        extensions: { fileSize: 1024, mediaType: 'application/pdf' },
        _links: { download: '/download/attachments/1/handbook.pdf' },
      };
      const { adapter } = adapterFor({
        '/rest/experimental/content/att-1/version': {
          results: [{ number: 1 }],
          _links: { base: 'https://confluence.test/' },
        },
        '/rest/api/content/att-1?expand=': attachment,
        '/wiki/api/v2/attachments/att-1/versions': {
          results: [
            {
              number: 1,
              createdAt: '2024-01-01T10:00:00.000Z',
              message: 'first upload',
            },
          ],
          _links: { base: 'https://confluence.test/' },
        },
        '/wiki/api/v2/attachments/att-1?version=1': {
          ...attachment,
          _links: { base: 'https://confluence.test/' },
          downloadLink: '/download/attachments/1/handbook.pdf',
        },
      });

      const versions = await adapter.getAttachmentVersions('att-1');

      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        version: 1,
        filename: 'handbook.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        message: 'first upload',
        downloadUrl:
          'https://confluence.test/download/attachments/1/handbook.pdf',
      });
    });
  });
});
