import { AtlassianRequestError } from '../http/atlassian-http-client';
import type { AtlassianHttpClient } from '../http/atlassian-http-client';
import { JiraCloudAdapter } from './jira-cloud.adapter';
import { JiraServerAdapter } from './jira-server.adapter';

function makeHttp(): {
  client: AtlassianHttpClient;
  getJson: jest.Mock;
} {
  const getJson = jest.fn();

  return {
    client: { getJson } as unknown as AtlassianHttpClient,
    getJson,
  };
}

async function collect<T>(pages: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];

  for await (const page of pages) out.push(page);

  return out;
}

describe('Jira adapter recovery', () => {
  it('retries a failed Server issue cursor with smaller pages and preserves the smaller page size', async () => {
    const { client, getJson } = makeHttp();
    const adapter = new JiraServerAdapter(client);

    getJson
      .mockRejectedValueOnce(
        new AtlassianRequestError('source unavailable', 500),
      )
      .mockResolvedValueOnce({
        startAt: 0,
        total: 2,
        issues: [{ id: '1', key: 'XMQ-1', fields: { summary: 'first' } }],
      })
      .mockResolvedValueOnce({
        startAt: 1,
        total: 2,
        issues: [{ id: '2', key: 'XMQ-2', fields: { summary: 'second' } }],
      });

    const pages = await collect(adapter.iterateIssues('XMQ', { pageSize: 4 }));

    expect(pages.map((page) => page.items[0].sourceId)).toEqual(['1', '2']);
    expect(pages.map((page) => page.nextCursor)).toEqual(['1', null]);
    expect(getJson.mock.calls.map(([path]: [unknown]) => path)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('startAt=0&maxResults=4'),
        expect.stringContaining('startAt=0&maxResults=2'),
        expect.stringContaining('startAt=1&maxResults=2'),
      ]),
    );
  });

  it('rethrows a Server issue-search 5xx once the page size reaches one', async () => {
    const { client, getJson } = makeHttp();
    const adapter = new JiraServerAdapter(client);
    const terminalError = new AtlassianRequestError('source unavailable', 503);

    getJson
      .mockRejectedValueOnce(
        new AtlassianRequestError('source unavailable', 500),
      )
      .mockRejectedValueOnce(terminalError);

    await expect(
      collect(adapter.iterateIssues('XMQ', { pageSize: 2 })),
    ).rejects.toBe(terminalError);
    expect(getJson.mock.calls.map(([path]: [unknown]) => path)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('startAt=0&maxResults=2'),
        expect.stringContaining('startAt=0&maxResults=1'),
      ]),
    );
  });

  for (const [name, makeAdapter] of [
    ['Server', (client: AtlassianHttpClient) => new JiraServerAdapter(client)],
    ['Cloud', (client: AtlassianHttpClient) => new JiraCloudAdapter(client)],
  ] as const) {
    it(`${name} rethrows a history transport failure`, async () => {
      const { client, getJson } = makeHttp();
      const adapter = makeAdapter(client);
      const error = new AtlassianRequestError('source unavailable', 503);

      getJson.mockRejectedValue(error);

      await expect(adapter.getIssueHistory('10001')).rejects.toBe(error);
    });

    it(`${name} treats an empty changelog as a genuine empty history`, async () => {
      const { client, getJson } = makeHttp();
      const adapter = makeAdapter(client);

      getJson.mockResolvedValue({ changelog: { histories: [] } });

      await expect(adapter.getIssueHistory('10001')).resolves.toEqual([]);
    });
  }
});

describe.each([
  ['Server', JiraServerAdapter, '2'],
  ['Cloud', JiraCloudAdapter, '3'],
] as const)('%s required identity', (_name, Adapter, version) => {
  it.each([401, 403])(
    'rejects a denied role listing (%s) with the endpoint',
    async (status) => {
      const { client, getJson } = makeHttp();
      getJson.mockRejectedValue(new AtlassianRequestError('denied', status));
      await expect(
        new Adapter(client).getUsersAndRoles('DEMO'),
      ).rejects.toThrow(`/rest/api/${version}/project/DEMO/role`);
    },
  );
  it.each([401, 403])('rejects a denied role detail (%s)', async (status) => {
    const { client, getJson } = makeHttp();
    getJson
      .mockResolvedValueOnce({
        Members: `https://jira.test/jira/rest/api/${version}/project/DEMO/role/100`,
      })
      .mockRejectedValue(new AtlassianRequestError('denied', status));
    await expect(new Adapter(client).getUsersAndRoles('DEMO')).rejects.toThrow(
      'role/100',
    );
  });
  it('rejects denied assignable users', async () => {
    const { client, getJson } = makeHttp();
    getJson
      .mockResolvedValueOnce({})
      .mockRejectedValue(new AtlassianRequestError('denied', 403));
    await expect(new Adapter(client).getUsersAndRoles('DEMO')).rejects.toThrow(
      'user/assignable/search',
    );
  });
});

describe.each([
  ['Server', JiraServerAdapter, '2'],
  ['Cloud', JiraCloudAdapter, '3'],
] as const)('%s status detail', (_name, Adapter, version) => {
  it('uses version-specific detail without fabricated issue-type associations', async () => {
    const { client, getJson } = makeHttp();
    getJson.mockResolvedValue({
      id: '27',
      name: 'Review',
      statusCategory: { key: 'indeterminate', colorName: 'yellow' },
    });
    expect(await new Adapter(client).getStatus('27')).toMatchObject({
      sourceId: '27',
      name: 'Review',
    });
    expect(getJson).toHaveBeenCalledWith(`/rest/api/${version}/status/27`);
  });
  it('rejects incomplete status rather than inventing a category', async () => {
    const { client, getJson } = makeHttp();
    getJson.mockResolvedValue({ id: '27', name: 'Review' });
    await expect(new Adapter(client).getStatus('27')).rejects.toThrow(
      'incomplete status detail',
    );
  });
});

describe.each([
  ['Server', JiraServerAdapter],
  ['Cloud', JiraCloudAdapter],
] as const)('%s board prerequisite visibility', (_name, Adapter) => {
  it.each([403, 404])(
    'does not fabricate an empty board configuration after HTTP %s',
    async (status) => {
      const { client, getJson } = makeHttp();
      getJson
        .mockResolvedValueOnce({
          values: [{ id: 17, name: 'Board', type: 'kanban' }],
          isLast: true,
        })
        .mockRejectedValue(new AtlassianRequestError('denied', status));
      await expect(new Adapter(client).getBoards('DEMO')).resolves.toEqual([
        expect.objectContaining({
          sourceId: '17',
          configurationError: expect.stringContaining(
            'Board 17 configuration could not be read',
          ),
        }),
      ]);
    },
  );
});

describe.each([
  ['Server', JiraServerAdapter],
  ['Cloud', JiraCloudAdapter],
] as const)('%s partial board discovery', (_name, Adapter) => {
  it('retains accessible boards alongside explicit inaccessible configuration', async () => {
    const { client, getJson } = makeHttp();
    getJson.mockImplementation(async (path: string) => {
      if (path.includes('board?'))
        return {
          values: [
            { id: 17, name: 'Denied' },
            { id: 18, name: 'Accessible' },
          ],
          isLast: true,
        };
      if (path.includes('/17/configuration'))
        throw new AtlassianRequestError('denied', 403);
      if (path.includes('/18/configuration'))
        return {
          columnConfig: {
            columns: [{ name: 'Open', statuses: [{ id: '1' }] }],
          },
        };
      return {};
    });
    const boards = await new Adapter(client).getBoards('DEMO');
    expect(boards).toHaveLength(2);
    expect(boards[0].configurationError).toContain('Board 17');
    expect(boards[1].columns).toEqual([
      { name: 'Open', statusSourceIds: ['1'] },
    ]);
    expect(boards[1].configurationError).toBeUndefined();
  });
});
