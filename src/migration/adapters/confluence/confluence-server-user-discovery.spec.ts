import type { AtlassianHttpClient } from '../http/atlassian-http-client';
import {
  collectStorageUserRefs,
  ConfluenceServerAdapter,
} from './confluence-server.adapter';

describe('collectStorageUserRefs', () => {
  it('finds stable keys and legacy usernames anywhere in storage content', () => {
    expect(
      collectStorageUserRefs(
        '<ac:task-list><ac:task><ac:task-body>' +
          '<ac:link><ri:user ri:userkey="4028808247041f1a0147043d62420005"/></ac:link>' +
          '<ac:structured-macro ac:name="user-profile"><ac:parameter ac:name="user">' +
          '<ri:user ri:username="christian.kienzl"/></ac:parameter></ac:structured-macro>' +
          '</ac:task-body></ac:task></ac:task-list>',
      ),
    ).toEqual([
      {
        sourceId: '4028808247041f1a0147043d62420005',
        lookup: 'key',
      },
      { sourceId: 'christian.kienzl', lookup: 'username' },
    ]);
  });

  it('deduplicates refs and ignores malformed user elements', () => {
    expect(
      collectStorageUserRefs(
        '<ri:user ri:userkey="same"/><ri:user ri:userkey="same"/><ri:user/>',
      ),
    ).toEqual([{ sourceId: 'same', lookup: 'key' }]);
  });
});

describe('ConfluenceServerAdapter.getSpaceUsers', () => {
  it('pages a bounded storage scan and resolves mention-only users through the Server API', async () => {
    const getJson = jest.fn((path: string) => {
      if (path.includes('start=100')) {
        return Promise.resolve({
          results: [
            {
              id: '12222471',
              body: {
                storage: {
                  value:
                    '<ac:link><ri:user ri:userkey="christian-key"/></ac:link>',
                },
              },
            },
          ],
          _links: {},
        });
      }

      if (path.startsWith('/rest/api/content?')) {
        return Promise.resolve({
          results: [
            {
              id: '12222470',
              version: {
                by: {
                  userKey: 'author-key',
                  username: 'author',
                  displayName: 'Page Author',
                },
              },
              body: {
                storage: {
                  value:
                    '<ac:link><ri:user ri:userkey="christian-key"/></ac:link>' +
                    '<ac:link><ri:user ri:username="tobias"/></ac:link>',
                },
              },
            },
          ],
          _links: { next: '/rest/api/content?start=100' },
        });
      }

      if (path === '/rest/api/user?key=christian-key') {
        return Promise.resolve({
          userKey: 'christian-key',
          username: 'christian',
          displayName: 'Christian Kienzl',
          email: 'christian@example.com',
        });
      }

      if (path === '/rest/api/user?username=tobias') {
        return Promise.resolve({
          userKey: 'tobias-key',
          username: 'tobias',
          displayName: 'Tobias Schwap',
        });
      }

      throw new Error(`unexpected path: ${path}`);
    });
    const adapter = new ConfluenceServerAdapter({
      getJson,
    } as AtlassianHttpClient);

    await expect(adapter.getSpaceUsers('APMIS')).resolves.toEqual([
      {
        sourceType: 'confluence',
        sourceId: 'author-key',
        username: 'author',
        email: undefined,
        displayName: 'Page Author',
        active: true,
      },
      {
        sourceType: 'confluence',
        sourceId: 'christian-key',
        username: 'christian',
        email: 'christian@example.com',
        displayName: 'Christian Kienzl',
        active: true,
      },
      {
        sourceType: 'confluence',
        sourceId: 'tobias',
        username: 'tobias',
        email: undefined,
        displayName: 'Tobias Schwap',
        active: true,
      },
    ]);
    expect(getJson).toHaveBeenCalledWith(
      '/rest/api/content?spaceKey=APMIS&type=page&limit=100&expand=body.storage,version.by,history.createdBy',
    );
  });

  it('keeps an honest placeholder when the user endpoint cannot name a mention', async () => {
    const getJson = jest
      .fn()
      .mockResolvedValueOnce({
        results: [
          {
            id: '12222470',
            body: {
              storage: {
                value: '<ac:link><ri:user ri:userkey="missing-key"/></ac:link>',
              },
            },
          },
        ],
        _links: {},
      })
      .mockResolvedValueOnce({ results: [] }) // no blog posts
      .mockRejectedValueOnce(new Error('403'));
    const notice = jest.fn();
    const adapter = new ConfluenceServerAdapter({
      getJson,
    } as AtlassianHttpClient);

    await expect(adapter.getSpaceUsers('APMIS', notice)).resolves.toEqual([
      {
        sourceType: 'confluence',
        sourceId: 'missing-key',
        username: undefined,
        email: undefined,
        displayName: 'Confluence user missing-key',
        active: true,
      },
    ]);
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining('could not resolve 1 mentioned user'),
      expect.objectContaining({ unresolvedUserCount: 1 }),
    );
  });

  it('stops the source scan at the page cap and reports truncation', async () => {
    const getJson = jest.fn().mockResolvedValue({
      results: Array.from({ length: 2001 }, (_, index) => ({
        id: String(index),
        body: { storage: { value: '<p>no mentions</p>' } },
      })),
      _links: { next: '/rest/api/content?start=2001' },
    });
    const notice = jest.fn();
    const adapter = new ConfluenceServerAdapter({
      getJson,
    } as AtlassianHttpClient);

    await expect(adapter.getSpaceUsers('APMIS', notice)).resolves.toEqual([]);
    expect(getJson).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining('first 2000 page(s)'),
      { userScanTruncated: true, scanned: 2000 },
    );
  });

  it('caps unique user API lookups and reports omitted refs', async () => {
    const refs = Array.from(
      { length: 501 },
      (_, index) => `<ri:user ri:userkey="user-${index}"/>`,
    ).join('');
    const getJson = jest.fn((path: string) => {
      if (path.startsWith('/rest/api/content?')) {
        return Promise.resolve({
          results: [{ id: '12222470', body: { storage: { value: refs } } }],
          _links: {},
        });
      }

      const sourceId = new URL(`https://local${path}`).searchParams.get('key');

      return Promise.resolve({ userKey: sourceId, displayName: sourceId });
    });
    const notice = jest.fn();
    const adapter = new ConfluenceServerAdapter({
      getJson,
    } as AtlassianHttpClient);

    await expect(adapter.getSpaceUsers('APMIS', notice)).resolves.toHaveLength(
      500,
    );
    expect(getJson).toHaveBeenCalledTimes(502);
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining('lookups at 500'),
      { userLookupTruncated: true, userLookupCap: 500 },
    );
  });
});
