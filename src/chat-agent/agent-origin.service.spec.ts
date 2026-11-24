import { AgentOriginService } from './agent-origin.service';

type Row = Record<string, unknown>;

const ORG = 'org-1';
const ROW = { id: 't1', organization_id: ORG, created_by: 'inv', updated_by: 'inv' };
const AT = '2026-11-05T10:00:00Z';
const ME = { userId: 'me', organizationId: ORG };

function build(over: Partial<Record<string, Row[]>> = {}, canViewSpace = false) {
  const tables: Record<string, Row[]> = {
    agent_object_origins: [
      {
        organization_id: ORG,
        entity_type: 'task',
        entity_id: 't1',
        conversation_id: 'c1',
        trigger_message_id: 'm1',
        source_message_ids: ['m0', 'm1'],
        invoker_id: 'inv',
        confirmer_id: 'conf',
        created_at: AT,
      },
    ],
    chat_conversations: [{ id: 'c1', organization_id: ORG, kind: 'group', space_id: null, title: 'Secret plans' }],
    chat_members: [{ conversation_id: 'c1', organization_id: ORG, user_id: 'me', history_from_seq: 0 }],
    chat_messages: [
      { id: 'm0', conversation_id: 'c1', organization_id: ORG, seq: 4, thread_root_id: null, deleted_at: null },
      { id: 'm1', conversation_id: 'c1', organization_id: ORG, seq: 5, thread_root_id: null, deleted_at: null },
    ],
    users: [
      { id: 'inv', first_name: 'Anna', last_name: 'Invoker', email: 'a@x.test' },
      { id: 'conf', first_name: 'Carl', last_name: 'Confirmer', email: 'c@x.test' },
      { id: 'ed', first_name: 'Eva', last_name: 'Editor', email: 'e@x.test' },
    ],
    task_history: [],
    wiki_page_versions: [],
    audit_logs: [],
    ...over,
  };
  const queried: string[] = [];
  const from = (table: string) => {
    queried.push(table);
    const filters: ((r: Row) => boolean)[] = [];
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const q: Record<string, unknown> = {
      select: () => q,
      order: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      gt: (c: string, v: string) => (filters.push((r) => String(r[c]) > v), q),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
      not: (c: string, _o: string, v: string) => (filters.push((r) => !v.includes(String(r[c]))), q),
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (d: (x: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(d),
    };
    return q;
  };
  const permissions = { getViewableSpaceIds: jest.fn().mockResolvedValue(canViewSpace ? ['s1'] : []) };
  const service = new AgentOriginService({ getClient: () => ({ from }) } as never, permissions as never);
  return { service, queried, tables, permissions };
}

describe('AgentOriginService', () => {
  describe('an object a person made', () => {
    it('has no origin, after one lookup and nothing more', async () => {
      const { service, queried } = build({ agent_object_origins: [] });
      const warn = jest.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn');
      await expect(service.forObject(ME as never, 'task', ROW)).resolves.toBeNull();
      expect(queried).toEqual(['agent_object_origins']);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('the tenant', () => {
    it('comes from the row of the object, never from the request', async () => {
      const { service } = build();
      await expect(service.forObject({ userId: 'me', organizationId: 'org-9' } as never, 'task', ROW)).resolves.not.toBeNull();
      await expect(service.forObject(ME as never, 'task', { ...ROW, organization_id: 'org-9' })).resolves.toBeNull();
    });

    it('never shows an origin of a member change, though the row exists', async () => {
      const { service, queried } = build({
        agent_object_origins: [
          { organization_id: ORG, entity_type: 'space_member', entity_id: 't1', conversation_id: 'c1', trigger_message_id: 'm1', source_message_ids: [], invoker_id: 'inv', confirmer_id: 'conf', created_at: AT },
        ],
      });
      await expect(service.forObject(ME as never, 'space_member' as never, ROW)).resolves.toBeNull();
      expect(queried).toEqual([]);
    });
  });

  describe('the names', () => {
    it('says who asked and who reviewed', async () => {
      const { service } = build();
      expect(await service.forObject(ME as never, 'task', ROW)).toMatchObject({
        createdAt: AT,
        requestedBy: 'Anna Invoker',
        confirmedBy: 'Carl Confirmer',
        editedBy: [],
      });
    });

    it('never leaves a name blank when the person is gone', async () => {
      const { service } = build({ users: [] });
      const out = await service.forObject(ME as never, 'task', ROW);
      expect(out?.requestedBy).toBeNull();
      expect(out?.confirmedBy).toBeNull();
    });
  });

  describe('edited by', () => {
    const later = '2026-11-05T11:00:00Z';
    const before = '2026-11-05T09:59:59Z';

    it('adds who edited a task afterwards, once each', async () => {
      const { service } = build({
        task_history: [
          { task_id: 't1', organization_id: ORG, action: 'update', changed_by: 'ed', changed_at: later },
          { task_id: 't1', organization_id: ORG, action: 'status_change', changed_by: 'ed', changed_at: later },
          { task_id: 't1', organization_id: ORG, action: 'update', changed_by: 'inv', changed_at: later },
          { task_id: 't1', organization_id: ORG, action: 'create', changed_by: 'conf', changed_at: later },
          { task_id: 't1', organization_id: ORG, action: 'update', changed_by: 'conf', changed_at: before },
        ],
      });
      const out = await service.forObject(ME as never, 'task', ROW);
      expect(out?.editedBy?.sort()).toEqual(['Anna Invoker', 'Eva Editor']);
    });

    it('reads a page from its versions and a process from the audit log', async () => {
      const page = build({
        agent_object_origins: [{ organization_id: ORG, entity_type: 'wiki_page', entity_id: 't1', conversation_id: 'c1', trigger_message_id: 'm1', source_message_ids: [], invoker_id: 'inv', confirmer_id: 'conf', created_at: AT }],
        wiki_page_versions: [{ wiki_page_id: 't1', version: 3, changed_by: 'ed', created_at: later }, { wiki_page_id: 't1', version: 2, changed_by: 'conf', created_at: before }],
      });
      expect((await page.service.forObject(ME as never, 'wiki_page', ROW))?.editedBy).toEqual(['Eva Editor']);

      const process = build({
        agent_object_origins: [{ organization_id: ORG, entity_type: 'process', entity_id: 't1', conversation_id: 'c1', trigger_message_id: 'm1', source_message_ids: [], invoker_id: 'inv', confirmer_id: 'conf', created_at: AT }],
        audit_logs: [{ organization_id: ORG, entity_type: 'business_process', entity_id: 't1', action: 'update', user_id: 'ed', created_at: later }],
      });
      expect((await process.service.forObject(ME as never, 'process', ROW))?.editedBy).toEqual(['Eva Editor']);

      // 1.22: a plan also keeps its edits in the audit log only.
      const plan = build({
        agent_object_origins: [{ organization_id: ORG, entity_type: 'plan', entity_id: 't1', conversation_id: 'c1', trigger_message_id: 'm1', source_message_ids: [], invoker_id: 'inv', confirmer_id: 'conf', created_at: AT }],
        audit_logs: [
          { organization_id: ORG, entity_type: 'plan', entity_id: 't1', action: 'update', user_id: 'ed', created_at: later },
          { organization_id: ORG, entity_type: 'business_process', entity_id: 't1', action: 'update', user_id: 'inv', created_at: later },
        ],
      });
      expect((await plan.service.forObject(ME as never, 'plan', ROW))?.editedBy).toEqual(['Eva Editor']);
    });
  });

  describe('the way back to the conversation', () => {
    it('takes a member to the source message', async () => {
      const { service } = build();
      expect((await service.forObject(ME as never, 'task', ROW))?.source).toEqual({
        kind: 'link',
        conversationId: 'c1',
        messageId: 'm0',
        threadRootId: null,
      });
    });

    it('keeps the thread of the message', async () => {
      const { service } = build({
        chat_messages: [{ id: 'm0', conversation_id: 'c1', organization_id: ORG, seq: 4, thread_root_id: 'root', deleted_at: null }],
      });
      expect((await service.forObject(ME as never, 'task', ROW))?.source).toMatchObject({ messageId: 'm0', threadRootId: 'root' });
    });

    it('tells a non-member only that it was private: no ids, no name, no text', async () => {
      const { service, queried } = build({ chat_members: [] });
      const out = await service.forObject(ME as never, 'task', ROW);
      expect(out?.source).toEqual({ kind: 'private' });
      expect(JSON.stringify(out)).not.toContain('Secret');
      expect(JSON.stringify(out)).not.toContain('c1');
      expect(queried).not.toContain('chat_messages');
    });

    it('treats someone who joined after those messages as a non-member', async () => {
      const { service } = build({
        chat_members: [{ conversation_id: 'c1', organization_id: ORG, user_id: 'me', history_from_seq: 50 }],
      });
      expect((await service.forObject(ME as never, 'task', ROW))?.source).toEqual({ kind: 'private' });
    });

    it('a space conversation is open to who can see that space', async () => {
      const conv = [{ id: 'c1', organization_id: ORG, kind: 'space', space_id: 's1', title: 'Space chat' }];
      const open = build({ chat_conversations: conv, chat_members: [] }, true);
      expect((await open.service.forObject(ME as never, 'task', ROW))?.source).toMatchObject({ kind: 'link' });
      const closed = build({ chat_conversations: conv, chat_members: [] }, false);
      expect((await closed.service.forObject(ME as never, 'task', ROW))?.source).toEqual({ kind: 'private' });
    });

    it('goes to the next message when the first source was deleted', async () => {
      const { service } = build({
        chat_messages: [
          { id: 'm0', conversation_id: 'c1', organization_id: ORG, seq: 4, thread_root_id: null, deleted_at: AT },
          { id: 'm1', conversation_id: 'c1', organization_id: ORG, seq: 5, thread_root_id: null, deleted_at: null },
        ],
      });
      expect((await service.forObject(ME as never, 'task', ROW))?.source).toMatchObject({ messageId: 'm1' });
    });

    it('says message deleted when none is left, and the label stays', async () => {
      const { service } = build({
        chat_messages: [{ id: 'm1', conversation_id: 'c1', organization_id: ORG, seq: 5, thread_root_id: null, deleted_at: AT }],
      });
      const out = await service.forObject(ME as never, 'task', ROW);
      expect(out?.source).toEqual({ kind: 'deleted' });
      expect(out?.confirmedBy).toBe('Carl Confirmer');
    });

    it('says message deleted when the whole conversation is gone, to anyone', async () => {
      const { service } = build({ chat_conversations: [], chat_members: [], chat_messages: [] });
      expect((await service.forObject(ME as never, 'task', ROW))?.source).toEqual({ kind: 'deleted' });
    });
  });

  describe('an export', () => {
    it('reads all it needs in one batch, and only what Robert drafted', async () => {
      const { service, queried } = build();
      const out = await service.labels(ORG, ['t1', 'person-made']);
      expect([...out.keys()]).toEqual(['t1']);
      expect(out.get('t1')).toEqual({ confirmedBy: 'Carl Confirmer', createdAt: AT });
      expect(queried).toEqual(['agent_object_origins', 'users']);
    });

    it('costs one query when nothing came from Robert', async () => {
      const { service, queried } = build({ agent_object_origins: [] });
      await service.labels(ORG, ['a', 'b']);
      expect(queried).toEqual(['agent_object_origins']);
    });
  });

  describe('where no person may be named', () => {
    it('only says that Robert drafted it', async () => {
      const { service } = build();
      await expect(service.isDraftedByRobert(ORG, 'task', 't1')).resolves.toBe(true);
      await expect(service.isDraftedByRobert(ORG, 'task', 'other')).resolves.toBe(false);
      await expect(service.isDraftedByRobert('org-9', 'task', 't1')).resolves.toBe(false);
    });
  });
});
