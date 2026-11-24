import { AtlassianRequestError } from '../http/atlassian-http-client';
import type { AtlassianHttpClient } from '../http/atlassian-http-client';
import { JiraCloudAdapter } from './jira-cloud.adapter';

function adapterWith(implementation: (path: string) => unknown): {
  adapter: JiraCloudAdapter;
  getJson: jest.Mock;
} {
  const getJson = jest.fn(implementation);

  return {
    adapter: new JiraCloudAdapter({
      getJson,
    } as unknown as AtlassianHttpClient),
    getJson,
  };
}

async function collect<T>(pages: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];

  for await (const page of pages) out.push(page);

  return out;
}

describe('JiraCloudAdapter completeness', () => {
  it('fails explicitly when issue search repeats a next-page token', async () => {
    const { adapter } = adapterWith(() => ({
      issues: [{ id: '1', key: 'ADT-1', fields: { summary: 'one' } }],
      isLast: false,
      nextPageToken: 'same-token',
    }));

    await expect(collect(adapter.iterateIssues('ADT'))).rejects.toThrow(
      /repeated.*token/i,
    );
  });

  it('fails explicitly when issue search claims another page but makes no progress', async () => {
    const { adapter } = adapterWith(() => ({
      issues: [],
      isLast: false,
      nextPageToken: 'next-token',
    }));

    await expect(collect(adapter.iterateIssues('ADT'))).rejects.toThrow(
      /no progress/i,
    );
  });

  it('derives an exact issue count through enhanced token search', async () => {
    let call = 0;
    const { adapter, getJson } = adapterWith(() => {
      call += 1;

      return call === 1
        ? {
            issues: [
              { id: '1', key: 'ADT-1', fields: {} },
              { id: '2', key: 'ADT-2', fields: {} },
            ],
            isLast: false,
            nextPageToken: 'page-2',
          }
        : {
            issues: [{ id: '3', key: 'ADT-3', fields: {} }],
            isLast: true,
          };
    });

    await expect(adapter.countIssues('ADT')).resolves.toBe(3);
    expect(getJson.mock.calls.map(([path]: [string]) => path)).toEqual([
      expect.stringContaining('/rest/api/3/search/jql?'),
      expect.stringContaining('nextPageToken=page-2'),
    ]);
    expect(getJson).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('fields=id'),
    );
  });

  it('fetches every changelog page and preserves oldest-first order', async () => {
    const { adapter, getJson } = adapterWith((path) => {
      if (path.includes('startAt=0')) {
        return {
          startAt: 0,
          total: 2,
          isLast: false,
          values: [{ id: '10', created: '2024-01-01T00:00:00.000Z' }],
        };
      }

      return {
        startAt: 1,
        total: 2,
        isLast: true,
        values: [{ id: '11', created: '2024-01-02T00:00:00.000Z' }],
      };
    });

    await expect(adapter.getIssueHistory('10001')).resolves.toEqual([
      expect.objectContaining({ sourceId: '10' }),
      expect.objectContaining({ sourceId: '11' }),
    ]);
    expect(getJson.mock.calls.map(([path]: [string]) => path)).toEqual([
      expect.stringContaining('/issue/10001/changelog?startAt=0'),
      expect.stringContaining('/issue/10001/changelog?startAt=1'),
    ]);
  });

  it('paginates screens before reading matching project tabs', async () => {
    const { adapter, getJson } = adapterWith((path) => {
      if (path.includes('/screens?startAt=0')) {
        return {
          isLast: false,
          values: [{ id: 1, name: 'OTHER: Screen' }],
        };
      }
      if (path.includes('/screens?startAt=1')) {
        return {
          isLast: true,
          values: [{ id: 2, name: 'ADT: Main' }],
        };
      }
      if (path.endsWith('/screens/2/tabs')) {
        return [{ id: 20, name: 'Details' }];
      }
      if (path.endsWith('/screens/2/tabs/20/fields')) {
        return [{ id: 'customfield_10001' }];
      }

      throw new Error(`unexpected ${path}`);
    });

    await expect(adapter.getScreens('ADT')).resolves.toEqual([
      {
        sourceId: '2',
        name: 'ADT: Main',
        tabs: [
          {
            sourceId: '20',
            name: 'Details',
            fieldSourceIds: ['customfield_10001'],
          },
        ],
      },
    ]);
    expect(getJson).toHaveBeenCalledWith(
      expect.stringContaining('/screens?startAt=1'),
    );
  });

  it('uses the paginated group resource and keeps stable Cloud group ids', async () => {
    const { adapter, getJson } = adapterWith((path) =>
      path.includes('startAt=0')
        ? {
            isLast: false,
            values: [{ groupId: 'g-1', name: 'Developers' }],
          }
        : {
            isLast: true,
            values: [{ groupId: 'g-2', name: 'Operators' }],
          },
    );

    await expect(adapter.listGroups()).resolves.toEqual([
      { sourceId: 'g-1', name: 'Developers' },
      { sourceId: 'g-2', name: 'Operators' },
    ]);
    expect(getJson.mock.calls.map(([path]: [string]) => path)).toEqual([
      expect.stringContaining('/group/bulk?startAt=0'),
      expect.stringContaining('/group/bulk?startAt=1'),
    ]);
  });

  it('records the documented screen fallback instead of silently presenting missing layout data', async () => {
    const forbidden = new AtlassianRequestError('forbidden', 403);
    const { adapter } = adapterWith(() => Promise.reject(forbidden));

    await expect(adapter.getScreens('ADT')).resolves.toEqual([
      expect.objectContaining({
        tabs: [],
        migrationWarnings: [expect.stringMatching(/unreadable.*403/i)],
      }),
    ]);
  });

  it('propagates permission failures for selected groups and memberships', async () => {
    const forbidden = new AtlassianRequestError('forbidden', 403);
    const { adapter } = adapterWith(() => Promise.reject(forbidden));

    await expect(adapter.listGroups()).rejects.toBe(forbidden);
    await expect(adapter.getGroupMembers('g-1')).rejects.toBe(forbidden);
  });

  it('reads the project workflow scheme and preserves issue-type mappings', async () => {
    const { adapter } = adapterWith((path) => {
      if (path.includes('/project/ADT?')) return { id: '10000', key: 'ADT' };
      if (path.includes('/workflowscheme/project?')) {
        return { values: [{ workflowScheme: { id: 20000 } }] };
      }
      if (path.endsWith('/workflowscheme/20000')) {
        return {
          defaultWorkflow: 'jira',
          issueTypeMappings: {
            '10001': 'Delivery workflow',
            '10002': 'Delivery workflow',
            '10003': 'Bug workflow',
          },
        };
      }

      throw new Error(`unexpected ${path}`);
    });

    await expect(adapter.getWorkflows('ADT')).resolves.toEqual([
      expect.objectContaining({
        sourceId: 'jira',
        issueTypeSourceIds: ['*'],
        isDefault: true,
      }),
      expect.objectContaining({
        sourceId: 'Delivery workflow',
        issueTypeSourceIds: ['10001', '10002'],
        isDefault: false,
      }),
      expect.objectContaining({
        sourceId: 'Bug workflow',
        issueTypeSourceIds: ['10003'],
        isDefault: false,
      }),
    ]);
  });

  it('paginates boards and records an explicit warning when enrichment is permission-gated', async () => {
    const forbidden = new AtlassianRequestError('forbidden', 403);
    const { adapter, getJson } = adapterWith((path) => {
      if (path.includes('/board?') && path.includes('startAt=0')) {
        return {
          isLast: false,
          values: [{ id: 1, name: 'First', type: 'kanban' }],
        };
      }
      if (path.includes('/board?') && path.includes('startAt=1')) {
        return {
          isLast: true,
          values: [{ id: 2, name: 'Second', type: 'scrum' }],
        };
      }
      if (path.includes('/configuration')) return { columnConfig: {} };
      if (path.includes('/rapidviewconfig/')) return Promise.reject(forbidden);

      throw new Error(`unexpected ${path}`);
    });

    await expect(adapter.getBoards('ADT')).resolves.toEqual([
      expect.objectContaining({
        sourceId: '1',
        enriched: false,
        migrationWarnings: [expect.stringMatching(/enrichment.*403/i)],
      }),
      expect.objectContaining({
        sourceId: '2',
        enriched: false,
        migrationWarnings: [expect.stringMatching(/enrichment.*403/i)],
      }),
    ]);
    expect(getJson).toHaveBeenCalledWith(
      expect.stringContaining('/board?projectKeyOrId=ADT&startAt=1'),
    );
  });

  it('paginates every selected sprint page', async () => {
    const { adapter, getJson } = adapterWith((path) =>
      path.includes('startAt=0')
        ? {
            isLast: false,
            values: [{ id: 10, name: 'Sprint 1', state: 'closed' }],
          }
        : {
            isLast: true,
            values: [{ id: 11, name: 'Sprint 2', state: 'active' }],
          },
    );

    await expect(adapter.getSprints('1')).resolves.toEqual([
      expect.objectContaining({ sourceId: '10' }),
      expect.objectContaining({ sourceId: '11' }),
    ]);
    expect(getJson).toHaveBeenCalledWith(
      expect.stringContaining('/board/1/sprint?startAt=1'),
    );
  });
});
