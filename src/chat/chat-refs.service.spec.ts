import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../permissions/permissions.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { WikiPermissionsService } from '../wiki/wiki-permissions.service';
import { ChatRefsService } from './chat-refs.service';

/** Thenable query double that records builder calls. */
function chain(data: unknown) {
  const calls: Array<[string, unknown[]]> = [];
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data, error: null }).then(resolve);
        }
        if (prop === 'calls') return calls;
        return (...args: unknown[]) => {
          calls.push([prop, args]);
          return proxy;
        };
      },
    },
  );
  return proxy as Record<string, unknown> & {
    calls: Array<[string, unknown[]]>;
  };
}

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T3 = '33333333-3333-4333-8333-333333333333';
const W1 = '44444444-4444-4444-8444-444444444444';
const W2 = '55555555-5555-4555-8555-555555555555';
const W3 = '66666666-6666-4666-8666-666666666666';

describe('ChatRefsService', () => {
  const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;

  let tables: Record<string, unknown[]>;
  let queries: Record<string, ReturnType<typeof chain>>;
  let hasSpacePermission: jest.Mock;
  let assertPageAccess: jest.Mock;
  let service: ChatRefsService;

  beforeEach(() => {
    queries = {};
    tables = {
      tasks: [
        {
          id: T1,
          key: 'OPS-1',
          summary: 'Patch firewall',
          priority: 'high',
          due_date: '2026-10-10',
          space_id: 'space-open',
          status_config: { name: 'In progress', color: '#00f' },
          space: { key: 'OPS', name: 'Operations' },
          assignee: { first_name: 'Ada', last_name: 'L', email: 'a@x' },
        },
        {
          id: T2,
          key: 'SEC-9',
          summary: 'Secret incident',
          priority: null,
          due_date: null,
          space_id: 'space-closed',
          status_config: null,
          space: { key: 'SEC', name: 'Security' },
          assignee: null,
        },
      ],
      wiki_pages: [
        {
          id: W1,
          title: 'Runbook',
          space_id: 'space-open',
          is_archived: false,
          space: { key: 'OPS', name: 'Operations' },
        },
        {
          id: W2,
          title: 'Restricted page',
          space_id: 'space-open',
          is_archived: false,
          space: { key: 'OPS', name: 'Operations' },
        },
        {
          id: W3,
          title: 'Old page',
          space_id: 'space-open',
          is_archived: true,
          space: { key: 'OPS', name: 'Operations' },
        },
      ],
    };
    const from = jest.fn((table: string) => {
      queries[table] = chain(tables[table] ?? []);
      return queries[table];
    });
    hasSpacePermission = jest.fn((_u: string, _o: string, spaceId: string) =>
      Promise.resolve(spaceId === 'space-open'),
    );
    assertPageAccess = jest.fn((pageId: string) =>
      pageId === W2 ? Promise.reject(new Error('no')) : Promise.resolve(),
    );
    service = new ChatRefsService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      { hasSpacePermission } as unknown as PermissionsService,
      { assertPageAccess } as unknown as WikiPermissionsService,
    );
  });

  it('resolves tasks: ok with card data, restricted without a title, deleted when missing or in another tenant', async () => {
    const { results } = await service.resolve(user, [
      { type: 'task', id: T1 },
      { type: 'task', id: T2 },
      { type: 'task', id: T3 },
      { type: 'task', id: T1 },
    ]);

    expect(queries.tasks.calls).toContainEqual([
      'eq',
      ['organization_id', 'org-1'],
    ]);
    expect(queries.tasks.calls).toContainEqual(['in', ['id', [T1, T2, T3]]]);
    expect(results).toEqual([
      {
        type: 'task',
        id: T1,
        status: 'ok',
        title: 'Patch firewall',
        key: 'OPS-1',
        spaceKey: 'OPS',
        spaceName: 'Operations',
        url: '/spaces/OPS/tasks/view/OPS-1',
        task: {
          statusName: 'In progress',
          statusColor: '#00f',
          priority: 'high',
          assigneeName: 'Ada L',
          dueDate: '2026-10-10',
        },
      },
      { type: 'task', id: T2, status: 'restricted' },
      { type: 'task', id: T3, status: 'deleted' },
    ]);
    expect(hasSpacePermission).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      'space-open',
      'view_tasks',
    );
  });

  it('resolves wiki pages through the space and page-level checks', async () => {
    const { results } = await service.resolve(user, [
      { type: 'wiki_page', id: W1 },
      { type: 'wiki_page', id: W2 },
      { type: 'wiki_page', id: W3 },
    ]);

    expect(queries.wiki_pages.calls).toContainEqual([
      'eq',
      ['organization_id', 'org-1'],
    ]);
    expect(results).toEqual([
      {
        type: 'wiki_page',
        id: W1,
        status: 'ok',
        title: 'Runbook',
        spaceKey: 'OPS',
        spaceName: 'Operations',
        url: `/spaces/OPS/wiki/${W1}`,
      },
      { type: 'wiki_page', id: W2, status: 'restricted' },
      { type: 'wiki_page', id: W3, status: 'deleted' },
    ]);
    expect(assertPageAccess).toHaveBeenCalledWith(
      W1,
      'user-1',
      'space-open',
      'can_view',
    );
    // One space permission check shared by both pages in the space.
    expect(hasSpacePermission).toHaveBeenCalledTimes(1);
  });

  it('never leaks a title for a restricted ref', async () => {
    const { results } = await service.resolve(user, [
      { type: 'task', id: T2 },
      { type: 'wiki_page', id: W2 },
    ]);

    expect(JSON.stringify(results)).not.toMatch(/Secret|Restricted page/);
  });

  it('answers restricted for types without a resolver, without querying', async () => {
    const { results } = await service.resolve(user, [{ type: 'plan', id: T1 }]);

    expect(results).toEqual([{ type: 'plan', id: T1, status: 'restricted' }]);
    expect(Object.keys(queries)).toEqual([]);
  });
});
