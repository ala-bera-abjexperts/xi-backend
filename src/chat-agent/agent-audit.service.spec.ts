import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { ChatConversationsService } from '../chat/chat-conversations.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  AgentAuditService,
  csvCell,
  MAX_AUDIT_EXPORT,
} from './agent-audit.service';
import type { AgentRunsRepository } from './agent-runs.repository';

type Row = Record<string, unknown>;

/**
 * agent_audit_events with `total` rows (seq total..1, newest first), built on demand, so the
 * export cap can be tested with more rows than it allows.
 */
function auditTable(total: number, rowOf: (seq: number) => Row) {
  const calls: [string, unknown[]][] = [];
  const from = () => {
    let before = Infinity;
    let max = Infinity;
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (...args: unknown[]) => (calls.push(['eq', args]), q),
      gte: (...args: unknown[]) => (calls.push(['gte', args]), q),
      lte: (...args: unknown[]) => (calls.push(['lte', args]), q),
      lt: (_col: string, value: string) => ((before = Number(value)), q),
      order: () => q,
      limit: (n: number) => ((max = n), q),
      then: (resolve: (v: unknown) => unknown) => {
        const data: Row[] = [];
        for (
          let seq = Math.min(total, before - 1);
          seq >= 1 && data.length < max;
          seq--
        )
          data.push(rowOf(seq));
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return q;
  };
  return { from, calls };
}

const row = (seq: number): Row => ({
  seq,
  occurred_at: '2026-10-22T10:00:00Z',
  event: 'action.confirmed',
  run_id: 'run-1',
  action_id: 'act-1',
  conversation_id: 'conv-1',
  actor_id: 'user-me',
  impersonated_by: seq === 3 ? 'user-sa' : null,
  entity_type: 'task',
  entity_id: 'task-1',
  data: { ordinal: 1 },
});

describe('AgentAuditService', () => {
  const user = { userId: 'user-me', organizationId: 'org-1' } as RequestUser;
  let table: ReturnType<typeof auditTable>;
  let recordAudit: jest.Mock;
  let loadUsers: jest.Mock;
  let service: AgentAuditService;

  const build = (total: number, rowOf = row) => {
    table = auditTable(total, rowOf);
    service = new AgentAuditService(
      {
        getClient: () => ({ from: table.from }),
      } as unknown as SupabaseAdminService,
      { loadUsers } as unknown as ChatConversationsService,
      { recordAudit } as unknown as AgentRunsRepository,
    );
  };

  beforeEach(() => {
    recordAudit = jest.fn().mockResolvedValue(undefined);
    loadUsers = jest.fn((ids: string[]) =>
      Promise.resolve(
        new Map(ids.map((id) => [id, { name: `Name of ${id}` }])),
      ),
    );
    build(5);
  });

  it('pages newest first inside the caller organization, with names joined', async () => {
    const first = await service.list(user, { limit: 2 });

    expect(first.events.map((e) => e.seq)).toEqual(['5', '4']);
    expect(first.nextCursor).toBe('4');
    expect(first.events[0]).toEqual({
      seq: '5',
      occurredAt: '2026-10-22T10:00:00Z',
      event: 'action.confirmed',
      actor: { id: 'user-me', name: 'Name of user-me' },
      runId: 'run-1',
      actionId: 'act-1',
      conversationId: 'conv-1',
      entity: { type: 'task', id: 'task-1' },
      data: { ordinal: 1 },
    });
    expect(table.calls).toContainEqual(['eq', ['organization_id', 'org-1']]);

    const second = await service.list(user, { limit: 2, cursor: '4' });
    expect(second.events.map((e) => e.seq)).toEqual(['3', '2']);
    expect(second.events[0].impersonatedBy).toEqual({
      id: 'user-sa',
      name: 'Name of user-sa',
    });

    const last = await service.list(user, { limit: 2, cursor: '2' });
    expect(last).toMatchObject({ nextCursor: null });
  });

  it('applies the filters; a day alone means the whole day', async () => {
    await service.list(user, {
      from: '2026-10-01',
      to: '2026-10-22',
      actorId: 'user-x',
      event: 'run.feedback',
      conversationId: 'conv-9',
      runId: 'run-9',
    });

    expect(table.calls).toEqual(
      expect.arrayContaining([
        ['gte', ['occurred_at', '2026-10-01']],
        ['lte', ['occurred_at', '2026-10-22T23:59:59.999Z']],
        ['eq', ['actor_id', 'user-x']],
        ['eq', ['event', 'run.feedback']],
        ['eq', ['conversation_id', 'conv-9']],
        ['eq', ['run_id', 'run-9']],
      ]),
    );
  });

  it('exports CSV with formula cells defused, and audits the export', async () => {
    build(2, (seq) => ({ ...row(seq), data: { note: '=HYPERLINK("x")' } }));
    loadUsers.mockResolvedValue(
      new Map([['user-me', { name: '@evil, "Me"' }]]),
    );

    const { body, capped } = await service.export(user, { format: 'csv' });
    const lines = body.trim().split('\r\n');

    expect(capped).toBe(false);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      'seq,occurred_at,event,actor_id,actor_name,impersonated_by,impersonated_by_name,run_id,action_id,conversation_id,entity_type,entity_id,data',
    );
    expect(lines[1]).toContain(`"'@evil, ""Me"""`);
    expect(recordAudit).toHaveBeenCalledWith({
      organizationId: 'org-1',
      event: 'audit.exported',
      actorId: 'user-me',
      impersonatedBy: null,
      data: { format: 'csv', rows: 2, capped: false },
    });
  });

  it(`caps the export at ${MAX_AUDIT_EXPORT} rows and says so`, async () => {
    build(MAX_AUDIT_EXPORT + 7);

    const { body, capped } = await service.export(user, { format: 'json' });
    const events = JSON.parse(body) as { seq: string }[];

    expect(capped).toBe(true);
    expect(events).toHaveLength(MAX_AUDIT_EXPORT);
    expect(events[0].seq).toBe(String(MAX_AUDIT_EXPORT + 7));
    expect(new Set(events.map((e) => e.seq)).size).toBe(MAX_AUDIT_EXPORT);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rows: MAX_AUDIT_EXPORT,
          capped: true,
        }) as Row,
      }),
    );
  });
});

describe('csvCell', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+49 170', "'+49 170"],
    ['-5', "'-5"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    [null, ''],
    [7, '7'],
    [{ a: 1 }, '"{""a"":1}"'],
  ])('%p → %p', (value, cell) => {
    expect(csvCell(value)).toBe(cell);
  });
});
