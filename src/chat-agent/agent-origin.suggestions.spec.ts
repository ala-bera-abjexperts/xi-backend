/**
 * Robert 1.23: "Suggested by Robert · reviewed by … · date" on the risks and stakeholders tabs.
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

describe('AgentOriginService: suggested risks and stakeholders (1.23)', () => {
  it('a label per row Robert suggested, none for a person\'s; one origin read for the whole list', async () => {
    const { service, db } = build({
      chat_messages: [{ id: 'm1', seq: 5, thread_root_id: null, deleted_at: null, conversation_id: 'c1', organization_id: 'org-1' }],
      agent_object_origins: [
        origin('plan_risk', 'r1'),
        origin('plan_risk', 'r2'),
        origin('plan_stakeholder', 'r3'),
      ],
    });
    const labels = await service.suggestedLabels(
      { userId: 'viewer', organizationId: 'org-1' } as never,
      'org-1',
      'plan_risk',
      ['r1', 'r2', 'r3', 'person-risk'],
    );
    expect(Object.keys(labels).sort()).toEqual(['r1', 'r2']);
    expect(labels.r1).toMatchObject({ confirmedBy: 'Anna Berg', createdAt: '2026-11-13T10:00:00Z', source: { kind: 'link', conversationId: 'c1' } });
    // Both rows share one conversation: its access is read once, never per row.
    expect(db.calls.filter((t) => t === 'agent_object_origins')).toHaveLength(1);
    expect(db.calls.filter((t) => t === 'chat_conversations')).toHaveLength(1);
  });

  it('someone outside the conversation gets "a private conversation", no link and no text', async () => {
    const { service } = build({ agent_object_origins: [origin('plan_stakeholder', 's1')] });
    const labels = await service.suggestedLabels({ userId: 'outsider', organizationId: 'org-1' } as never, 'org-1', 'plan_stakeholder', ['s1']);
    expect(labels.s1.source).toEqual({ kind: 'private' });
  });

  it('another tenant sees nothing; a failed read shows no label instead of breaking the list', async () => {
    const { service } = build({ agent_object_origins: [origin('plan_risk', 'r1')] });
    expect(await service.suggestedLabels({ userId: 'viewer', organizationId: 'org-2' } as never, 'org-2', 'plan_risk', ['r1'])).toEqual({});
    const broken = new AgentOriginService({ getClient: () => ({ from: () => { throw new Error('down'); } }) } as never, {} as never);
    expect(await broken.suggestedLabels({ userId: 'v', organizationId: 'org-1' } as never, 'org-1', 'plan_risk', ['r1'])).toEqual({});
  });
});
