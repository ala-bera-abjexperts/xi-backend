/**
 * Robert 1.22.1: the "Added to plan" lines of a task, and the row markers of a plan view.
 */
import { AgentOriginService } from './agent-origin.service';

type Row = Record<string, unknown>;

/** A tiny query fake: equality and `in` filters on flat or dotted keys, counts each query. */
function fakeDb(tables: Record<string, Row[]>) {
  const calls: string[] = [];
  const from = (table: string) => {
    calls.push(table);
    const filters: ((row: Row) => boolean)[] = [];
    const get = (row: Row, col: string) =>
      col
        .split('.')
        .reduce<unknown>((v, k) => (v as Row | undefined)?.[k], row);
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, value: unknown) => (
        filters.push((r) => get(r, col) === value),
        q
      ),
      in: (col: string, values: unknown[]) => (
        filters.push((r) => values.includes(get(r, col))),
        q
      ),
      maybeSingle: () =>
        Promise.resolve({
          data:
            (tables[table] ?? []).filter((r) =>
              filters.every((f) => f(r)),
            )[0] ?? null,
          error: null,
        }),
      then: (done: (v: unknown) => unknown) =>
        Promise.resolve({
          data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))),
          error: null,
        }).then(done),
    };
    return q;
  };
  return { from, calls };
}

const origin = (entity_type: string, entity_id: string, over: Row = {}) => ({
  organization_id: 'org-1',
  entity_type,
  entity_id,
  conversation_id: 'c1',
  trigger_message_id: 'm1',
  source_message_ids: [],
  invoker_id: 'u1',
  confirmer_id: 'u1',
  created_at: '2026-11-13T10:00:00Z',
  ...over,
});

function build(tables: Record<string, Row[]>) {
  const db = fakeDb({
    users: [{ id: 'u1', first_name: 'Anna', last_name: 'Berg' }],
    chat_conversations: [
      { id: 'c1', kind: 'group', space_id: null, organization_id: 'org-1' },
    ],
    chat_members: [
      { conversation_id: 'c1', user_id: 'viewer', organization_id: 'org-1' },
    ],
    ...tables,
  });
  const service = new AgentOriginService(
    { getClient: () => ({ from: db.from }) } as never,
    {
      isAdminOrOwner: jest.fn().mockResolvedValue(false),
      getUserSpacePermissions: jest.fn(),
    } as never,
  );
  return { service, db };
}

describe('AgentOriginService: plan links (1.22.1)', () => {
  it('one line per plan Robert added the task to, and none for a link a person made', async () => {
    const { service } = build({
      plan_tasks: [
        {
          id: 'l-robert',
          plan_id: 'p1',
          task_id: 't1',
          plan: { plan_key: 'A-P1', name: 'Q4', organization_id: 'org-1' },
        },
        {
          id: 'l-person',
          plan_id: 'p2',
          task_id: 't1',
          plan: { plan_key: 'A-P2', name: 'Other', organization_id: 'org-1' },
        },
      ],
      agent_object_origins: [
        origin('plan_link', 'l-robert'),
        origin('task', 't1'),
      ],
    });
    const lines = await service.addedToPlans(
      { userId: 'viewer', organizationId: 'org-1' } as never,
      { id: 't1', organization_id: 'org-1' },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      planId: 'p1',
      planKey: 'A-P1',
      planName: 'Q4',
      confirmedBy: 'Anna Berg',
    });
  });

  it('a link that is gone (undone, or removed and added again by a person) shows nothing', async () => {
    const { service } = build({
      // The person's re-added link is a new row: the old origin no longer points at any row.
      plan_tasks: [
        {
          id: 'l-new',
          plan_id: 'p1',
          task_id: 't1',
          plan: { plan_key: 'A-P1', name: 'Q4', organization_id: 'org-1' },
        },
      ],
      agent_object_origins: [origin('plan_link', 'l-old')],
    });
    expect(
      await service.addedToPlans(
        { userId: 'viewer', organizationId: 'org-1' } as never,
        { id: 't1', organization_id: 'org-1' },
      ),
    ).toEqual([]);
  });

  it('the markers of a plan: drafted, added or none, in a few queries for any number of rows', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: `l${i}`,
      plan_id: 'p1',
      task_id: `t${i}`,
    }));
    const { service, db } = build({
      plan_tasks: rows,
      agent_object_origins: [
        origin('task', 't0'),
        origin('plan_link', 'l1'),
        origin('plan_link', 'l-elsewhere'),
      ],
    });
    const marks = await service.planMarkers(
      'org-1',
      'p1',
      rows.map((r) => r.task_id),
    );
    expect(marks.get('t0')).toBe('drafted');
    expect(marks.get('t1')).toBe('added');
    expect(marks.has('t2')).toBe(false);
    // One drafted lookup, one link list, one link-origin lookup, plus one names read: never per row.
    expect(db.calls.length).toBeLessThanOrEqual(4);
  });
});
