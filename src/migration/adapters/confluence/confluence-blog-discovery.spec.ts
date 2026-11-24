import { ConfluenceServerAdapter } from './confluence-server.adapter';

describe('Confluence blog inventory', () => {
  it('continues from pages to blogs and preserves the creator rather than the last editor', async () => {
    const http = {
      getJson: jest.fn(async (path: string) =>
        path.includes('type=blogpost')
          ? {
              results: [
                {
                  id: 'blog',
                  type: 'blogpost',
                  title: 'Recovery',
                  history: {
                    createdDate: '2026-09-01T00:00:00Z',
                    createdBy: {
                      username: 'owner',
                      displayName: 'Service Owner',
                    },
                  },
                  version: { number: 2, by: { username: 'editor' } },
                },
              ],
            }
          : { results: [{ id: 'page', title: 'Home' }] },
      ),
    };
    const adapter = new ConfluenceServerAdapter(http as never);
    const batches = [];
    for await (const batch of adapter.iteratePages('REV')) batches.push(batch);
    expect(batches).toHaveLength(2);
    expect(batches[0].nextCursor).toContain('type=blogpost');
    expect(batches[1].items[0]).toMatchObject({
      sourceId: 'blog',
      contentKind: 'blogpost',
      authorSourceId: 'owner',
      authorName: 'Service Owner',
      createdAt: '2026-09-01T00:00:00Z',
    });
  });
});

import { ConfluenceCloudAdapter } from './confluence-cloud.adapter';
import { AtlassianRequestError } from '../http/atlassian-http-client';

it('uses Cloud blog resources for body and related content after a page 404', async () => {
  const http = {
    getJson: jest.fn(async (path: string) => {
      if (path.includes('/pages/blog'))
        throw new AtlassianRequestError('Not found', 404);
      if (path.includes('attachments'))
        return { results: [{ id: 'file', title: 'Roster.xlsx' }] };
      return { body: { storage: { value: '<p>Recovery update</p>' } } };
    }),
  };
  const adapter = new ConfluenceCloudAdapter(http as never);
  expect(await adapter.getPageBody('blog', 'storage')).toEqual({
    format: 'storage',
    value: '<p>Recovery update</p>',
  });
  expect(http.getJson).toHaveBeenCalledWith(
    '/wiki/api/v2/blogposts/blog?body-format=storage',
  );
});

describe('Confluence sibling order and folder parents', () => {
  it('Cloud carries v2 position and parentType, dropping a non-int32 position', async () => {
    const http = {
      getJson: jest.fn(async (path: string) =>
        path.includes('/spaces?keys=')
          ? { results: [{ id: '42', key: 'AS' }] }
          : {
              results: [
                {
                  id: 'p1',
                  title: 'In folder',
                  parentId: 'f1',
                  parentType: 'folder',
                  position: 7,
                },
                { id: 'p2', title: 'Huge', position: 2 ** 40 },
              ],
            },
      ),
    };
    const batch = await new ConfluenceCloudAdapter(http as never)
      .iteratePages('AS')
      .next();
    const items = batch.value ? batch.value.items : [];

    expect(items.find((p) => p.sourceId === 'p1')).toMatchObject({
      parentSourceId: 'f1',
      parentType: 'folder',
      position: 7,
    });
    expect(items.find((p) => p.sourceId === 'p2')).not.toHaveProperty(
      'position',
    );
  });

  it('Server requests extensions.position for pages and blogs; null stays alphabetical', async () => {
    const http = {
      getJson: jest.fn(async (_path: string) => ({
        results: [
          { id: 'a', title: 'A', extensions: { position: 3 } },
          { id: 'b', title: 'B', extensions: { position: null } },
        ],
      })),
    };
    const batch = await new ConfluenceServerAdapter(http as never)
      .iteratePages('DC')
      .next();

    expect(http.getJson).toHaveBeenCalledWith(
      expect.stringContaining('type=page&limit=200&expand=ancestors,version,history.createdBy,extensions.position'),
    );
    expect(batch.value?.nextCursor).toContain('extensions.position');
    expect(batch.value?.items[0].position).toBe(3);
    expect(batch.value?.items[1]).not.toHaveProperty('position');
  });

  it('Cloud getFolder returns a folder container, and null for a deleted folder', async () => {
    const http = {
      getJson: jest.fn(async (path: string) => {
        if (path.endsWith('/gone'))
          throw new AtlassianRequestError('Not found', 404);

        return {
          id: 'f1',
          title: 'Specs',
          parentId: 'f0',
          parentType: 'folder',
          position: 1,
        };
      }),
    };
    const adapter = new ConfluenceCloudAdapter(http as never);

    expect(await adapter.getFolder('f1')).toMatchObject({
      sourceId: 'f1',
      title: 'Specs',
      contentKind: 'folder',
      parentSourceId: 'f0',
      parentType: 'folder',
      position: 1,
    });
    expect(http.getJson).toHaveBeenCalledWith('/wiki/api/v2/folders/f1');
    expect(await adapter.getFolder('gone')).toBeNull();
  });
});

it('discovers creators whose only content is a Server blog', async () => {
  const http = {
    getJson: jest.fn(async (path: string) =>
      path.includes('type=blogpost')
        ? {
            results: [
              {
                id: 'blog',
                history: {
                  createdBy: {
                    userKey: 'owner',
                    username: 'owner',
                    displayName: 'Blog Owner',
                  },
                },
              },
            ],
          }
        : { results: [] },
    ),
  };
  const users = await new ConfluenceServerAdapter(http as never).getSpaceUsers(
    'REV',
  );
  expect(users).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sourceId: 'owner', displayName: 'Blog Owner' }),
    ]),
  );
});
