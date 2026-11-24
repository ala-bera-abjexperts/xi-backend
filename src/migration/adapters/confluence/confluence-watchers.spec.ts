import type { AtlassianHttpClient } from '../http/atlassian-http-client';
import { AtlassianRequestError } from '../http/atlassian-http-client';
import { ConfluenceCloudAdapter } from './confluence-cloud.adapter';
import { ConfluenceServerAdapter } from './confluence-server.adapter';

function httpStub(responses: unknown[]) {
  const getJson = jest.fn();

  for (const response of responses) {
    if (response instanceof Error) getJson.mockRejectedValueOnce(response);
    else getJson.mockResolvedValueOnce(response);
  }

  return {
    getJson,
    http: { getJson } as unknown as AtlassianHttpClient,
  };
}

describe('Confluence watcher extraction', () => {
  describe('Cloud', () => {
    it('uses the authoritative page route and normalizes nested account identities', async () => {
      const { http, getJson } = httpStub([
        {
          results: [
            {
              watcher: {
                accountId: 'acct-1',
                displayName: 'Ada Lovelace',
                email: 'ada@example.test',
                active: true,
              },
            },
            { watcher: { accountId: 'acct-1', displayName: 'Duplicate' } },
          ],
          _links: {
            next: '/wiki/rest/api/content/42/notification/child-created?cursor=next',
          },
        },
      ]);

      const page = await new ConfluenceCloudAdapter(http).getPageWatchers(
        '42',
        {
          pageSize: 25,
        },
      );

      expect(getJson).toHaveBeenCalledWith(
        '/wiki/rest/api/content/42/notification/child-created?limit=25',
      );
      expect(page).toEqual({
        items: [
          {
            sourceId: 'acct-1',
            displayName: 'Ada Lovelace',
            email: 'ada@example.test',
            active: true,
          },
        ],
        nextCursor:
          '/wiki/rest/api/content/42/notification/child-created?cursor=next',
        total: null,
      });
    });

    it('uses the exact space route and follows an opaque next-link cursor verbatim', async () => {
      const cursor = '/wiki/rest/api/space/ENG/watch?start=50&limit=50';
      const { http, getJson } = httpStub([
        {
          results: [{ watcher: { accountId: 'acct-2', publicName: 'Grace' } }],
        },
      ]);

      const page = await new ConfluenceCloudAdapter(http).getSpaceWatchers(
        'ENG',
        {
          cursor,
        },
      );

      expect(getJson).toHaveBeenCalledWith(cursor);
      expect(page.items[0]).toMatchObject({
        sourceId: 'acct-2',
        displayName: 'Grace',
      });
      expect(page.nextCursor).toBeNull();
    });
  });

  describe('Server/Data Center', () => {
    it('uses the page watcher route and prefers userKey over username', async () => {
      const { http, getJson } = httpStub([
        {
          results: [
            {
              userKey: 'stable-key',
              username: 'legacy-name',
              displayName: 'Lin',
              emailAddress: 'lin@example.test',
              active: false,
            },
            { username: 'fallback-name', displayName: 'Fallback' },
            {
              userKey: 'stable-name-key',
              name: 'legacy-name-field',
              displayName: 'Legacy name field',
            },
          ],
          totalSize: 3,
        },
      ]);

      const page = await new ConfluenceServerAdapter(http).getPageWatchers(
        'p/1',
        {
          pageSize: 20,
        },
      );

      expect(getJson).toHaveBeenCalledWith(
        '/rest/api/content/p%2F1/watchers?limit=20',
      );
      expect(page).toMatchObject({
        items: [
          {
            sourceId: 'stable-key',
            username: 'legacy-name',
            displayName: 'Lin',
            email: 'lin@example.test',
            active: false,
          },
          {
            sourceId: 'fallback-name',
            username: 'fallback-name',
            displayName: 'Fallback',
          },
          {
            sourceId: 'stable-name-key',
            username: 'legacy-name-field',
            displayName: 'Legacy name field',
          },
        ],
        total: 3,
        nextCursor: null,
      });
    });

    it('accepts nested watcher shapes on the space route and collapses duplicates', async () => {
      const { http, getJson } = httpStub([
        {
          results: [
            { watcher: { userKey: 'key-1', displayName: 'One' } },
            { userKey: 'key-1', displayName: 'Duplicate' },
          ],
          _links: { next: '/rest/api/space/OPS/watchers?start=2' },
        },
      ]);

      const page = await new ConfluenceServerAdapter(http).getSpaceWatchers(
        'OPS',
      );

      expect(getJson).toHaveBeenCalledWith(
        '/rest/api/space/OPS/watchers?limit=100',
      );
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBe('/rest/api/space/OPS/watchers?start=2');
    });
  });

  it.each([
    ['Cloud', (http: AtlassianHttpClient) => new ConfluenceCloudAdapter(http)],
    [
      'Server',
      (http: AtlassianHttpClient) => new ConfluenceServerAdapter(http),
    ],
  ])(
    '%s rejects a repeated next cursor so pagination cannot stall',
    async (_name, make) => {
      const cursor = '/same-cursor';
      const { http } = httpStub([{ results: [], _links: { next: cursor } }]);

      await expect(
        make(http).getPageWatchers('42', { cursor }),
      ).rejects.toThrow(/repeated.*cursor|no progress/i);
    },
  );

  it('returns an empty terminal page and preserves permission failures', async () => {
    const empty = httpStub([{ results: [] }]);
    await expect(
      new ConfluenceCloudAdapter(empty.http).getSpaceWatchers('EMPTY'),
    ).resolves.toEqual({ items: [], nextCursor: null, total: null });

    const forbidden = new AtlassianRequestError('forbidden', 403);
    const denied = httpStub([forbidden]);
    await expect(
      new ConfluenceServerAdapter(denied.http).getSpaceWatchers('LOCKED'),
    ).rejects.toBe(forbidden);
  });

  it('rejects malformed identities and incomplete terminal pages as fidelity failures', async () => {
    const malformed = httpStub([
      { results: [{ watcher: { displayName: 'No id' } }] },
    ]);
    await expect(
      new ConfluenceCloudAdapter(malformed.http).getPageWatchers('42'),
    ).rejects.toThrow(/identity fidelity/i);

    const partial = httpStub([{ results: [{ userKey: 'one' }], totalSize: 2 }]);
    await expect(
      new ConfluenceServerAdapter(partial.http).getPageWatchers('42'),
    ).rejects.toThrow(/reported 2.*exposed only 1/i);
  });
});
