import {
  TenantAiError,
  type TenantAiService,
} from '../ai-automation/tenant-ai.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type {
  AgentContext,
  AgentContextService,
} from './agent-context.service';
import type { AgentActionExecutorService } from './agent-action-executor.service';
import type { AgentResolverService } from './agent-resolver.service';
import type { AgentRunViewService } from './agent-run-view.service';
import {
  AgentRunWorkerService,
  cutReply,
  mergeUnaskedChildPages,
  namedIn,
  fileNotes,
  focusFiles,
  macroNotes,
  filesInScope,
  answerBesideCard,
  refersToFiles,
  doneNames,
  isTheRest,
  unsupportedNote,
  withoutDoneRows,
  withoutEarlierTasks,
  spokenRequest,
  revisedIntents,
  scopeLine,
  tableFilters,
  proposalLine,
  withoutFieldEchoes,
  RETRY_DELAYS_MS,
  handleMatchesName,
} from './agent-run-worker.service';
import type { AgentRunRow, AgentRunsRepository } from './agent-runs.repository';
import type { AgentSettingsService } from './agent-settings.service';
import { isRobertWorkerEnabled } from './agent.constants';

jest.mock('./agent.constants', () => ({
  ...jest.requireActual<object>('./agent.constants'),
  isRobertWorkerEnabled: jest.fn(() => true),
}));

const plan = (over: Record<string, unknown> = {}) => ({
  reply: 'Ihr habt Freitag vereinbart.',
  reply_language: 'de',
  object_language: 'de',
  context: { action: 'ok', n: null, since: null },
  intents: [],
  more_items: false,
  unsupported: 'none',
  ...over,
});

const person = { said: null, participant: null, is_requester: false };
const date = { said: null, iso: null };
const intent = {
  ref: 'i1',
  kind: 'task',
  title: 'Angebot schicken',
  description: null,
  sources: ['m1'],
  space: null,
  type: null,
  status: null,
  priority: { said: null, level: 'none' },
  assignee: person,
  due: date,
  labels: [],
  parent: { item: null, key: null, said: null },
  asset_type: [],
  facts: [],
  owner: person,
  parent_page: null,
  page_type: null,
  publish: false,
  general_knowledge: false,
  body: [],
  plan: null,
  milestone: false,
  start: date,
  end: date,
};

const answer = (data: unknown = plan()) => ({
  data,
  promptTokens: 1000,
  completionTokens: 200,
  model: 'gpt-4.1-mini',
});

const context = (over: Partial<AgentContext> = {}): AgentContext => ({
  request: '@Robert was haben wir vereinbart?',
  messages: [
    {
      handle: 'm1',
      authorHandle: 'P1',
      at: '2026-10-22T10:02:00Z',
      text: 'Freitag?',
    },
    {
      handle: 'm2',
      authorHandle: 'P2',
      at: '2026-10-22T10:31:00Z',
      text: 'Ja.',
    },
  ],
  people: [
    { handle: 'P1', name: 'Prince' },
    { handle: 'P2', name: 'Ala' },
  ],
  invokerHandle: 'P1',
  handleToUserId: { P1: 'user-1', P2: 'user-2' },
  messageIds: ['msg-a', 'msg-b'],
  seqs: [4, 5],
  minSeq: 4,
  capped: false,
  ...over,
});

/** Thenable query double answering `result` to whatever is built. */
function query(result: Record<string, unknown>) {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then')
          return (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ error: null, ...result }).then(resolve);
        return () => proxy;
      },
    },
  );
  return proxy;
}

describe('AgentRunWorkerService', () => {
  let now: number;
  let run: AgentRunRow & { lease_token: string };
  let runs: Record<string, jest.Mock>;
  let load: jest.Mock;
  let views: Record<string, jest.Mock>;
  let settings: Record<string, jest.Mock>;
  let ai: Record<string, jest.Mock>;
  let tables: Record<string, Record<string, unknown>>;
  let resolver: Record<string, jest.Mock>;
  let executor: Record<string, jest.Mock>;
  let worker: AgentRunWorkerService;

  /** The n-th request to the provider. */
  const request = (n = 0) =>
    (ai.generateJson.mock.calls as unknown[][])[n][0] as Record<
      string,
      unknown
    >;

  const finalized = () =>
    (runs.finalizeRun.mock.calls as unknown[][])[0]?.[0] as
      | Record<string, unknown>
      | undefined;

  beforeEach(() => {
    now = Date.now();
    run = {
      id: 'run-1',
      organization_id: 'org-1',
      conversation_id: 'conv-1',
      trigger_message_id: 'msg-b',
      invoker_id: 'user-1',
      lease_token: 'lease-1',
      deadline_at: new Date(now + 300_000).toISOString(),
      reserved_tokens: 60_000,
      tokens_in: 0,
      tokens_out: 0,
      timezone: 'Europe/Vienna',
      trigger_seq: 5,
      thread_root_id: null,
    } as AgentRunRow & { lease_token: string };
    runs = {
      setStep: jest.fn().mockResolvedValue(true),
      recordModelCall: jest.fn().mockResolvedValue({
        recorded: true,
        remaining: 50_000,
        alert80: false,
      }),
      finalizeRun: jest
        .fn()
        .mockResolvedValue({ finalized: true, status: 'completed' }),
      heartbeat: jest.fn().mockResolvedValue([]),
      reapRuns: jest.fn().mockResolvedValue([]),
      claimRuns: jest.fn().mockResolvedValue([]),
      expireActions: jest.fn().mockResolvedValue(0),
      cancelRemovedRequesters: jest.fn().mockResolvedValue([]),
      reclaimStuckActions: jest.fn().mockResolvedValue([]),
    };
    resolver = {
      batch: jest.fn((args: object) => ({
        ...args,
        siblings: new Map(),
        memo: new Map(),
      })),
      resolve: jest.fn(
        (_batch: unknown, action: { intent: { title: string } }) =>
          Promise.resolve({
            title: action.intent.title,
            description: null,
            confirmable: true,
            fields: [],
            create: { spaceId: 'space-1', taskTypeId: 'task' },
          }),
      ),
      hidesFromAudience: jest.fn().mockResolvedValue(false),
      spaceNamedIn: jest.fn().mockResolvedValue(null),
    };
    executor = { reconcile: jest.fn().mockResolvedValue(undefined) };
    load = jest.fn().mockResolvedValue(context());
    views = {
      announce: jest.fn().mockResolvedValue(undefined),
      announceRow: jest.fn().mockResolvedValue(undefined),
    };
    settings = {
      notifyBudgetAlert: jest.fn().mockResolvedValue(undefined),
      notifyProviderProblem: jest.fn().mockResolvedValue(undefined),
    };
    ai = {
      resolveConfig: jest
        .fn()
        .mockResolvedValue({ provider: 'openai', apiKey: 'k', model: null }),
      resolveModel: jest.fn().mockReturnValue('gpt-4.1-mini'),
      generateJson: jest.fn().mockResolvedValue(answer()),
    };
    tables = {
      chat_conversations: {
        data: { id: 'conv-1', kind: 'group', dm_key: null, space_id: null },
      },
      chat_members: { data: null, count: 3 },
      agent_runs: { data: run },
    };
    worker = new AgentRunWorkerService(
      {
        getClient: () => ({ from: (table: string) => query(tables[table]) }),
      } as unknown as SupabaseAdminService,
      runs as unknown as AgentRunsRepository,
      { load } as unknown as AgentContextService,
      views as unknown as AgentRunViewService,
      settings as unknown as AgentSettingsService,
      ai as unknown as TenantAiService,
      resolver as unknown as AgentResolverService,
      executor as unknown as AgentActionExecutorService,
    );
  });

  afterEach(() => {
    worker.onModuleDestroy();
    jest.useRealTimers();
  });

  describe('tasks proposed before: the newest, enough of them (audit 2026-11-10)', () => {
    it('reads the newest 2000 earlier items, not the oldest 120, and keeps them oldest first', async () => {
      const calls: Record<string, unknown[][]> = {};
      const recorder = (table: string, rows: unknown[]) => {
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop: string) {
              if (prop === 'then')
                return (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
              return (...args: unknown[]) => {
                (calls[`${table}.${prop}`] ??= []).push(args);
                return proxy;
              };
            },
          },
        );
        return proxy;
      };
      const rows = [
        { kind: 'task', status: 'executed', entity_id: 'b', intent: { title: 'Newer' }, overrides: {}, resolved: { title: 'Newer' } },
        { kind: 'task', status: 'executed', entity_id: 'a', intent: { title: 'Older' }, overrides: {}, resolved: { title: 'Older' } },
      ];
      const w = new AgentRunWorkerService(
        { getClient: () => ({ from: (t: string) => recorder(t, t === 'agent_runs' ? [{ id: 'run-0' }] : t === 'agent_actions' ? rows : []) }) } as unknown as SupabaseAdminService,
        runs as unknown as AgentRunsRepository,
        { load } as unknown as AgentContextService,
        views as unknown as AgentRunViewService,
        settings as unknown as AgentSettingsService,
        ai as unknown as TenantAiService,
        resolver as unknown as AgentResolverService,
        executor as unknown as AgentActionExecutorService,
      );
      const out = (await (w as unknown as { earlierTasks: (r: unknown) => Promise<{ title: string }[]> }).earlierTasks(run));
      w.onModuleDestroy();
      expect(calls['agent_actions.order']).toEqual([['created_at', { ascending: false }]]);
      expect(calls['agent_actions.limit']).toEqual([[2000]]);
      expect(out.map((t) => t.title)).toEqual(['Older', 'Newer']);
      // 1.22.1 fix and 1.23: links and suggestions count as earlier too (same request twice).
      expect(calls['agent_actions.in']).toContainEqual([
        'kind',
        expect.arrayContaining(['plan_link', 'plan_dependency', 'plan_dates', 'plan_risk', 'plan_stakeholder', 'plan_baseline']),
      ]);
    });
  });

  describe('tasks proposed before (1.19)', () => {
    it('tells the model what this person already has here, so "the rest" is not the same again', async () => {
      tables.agent_runs = { data: [{ id: 'run-0' }], error: null };
      tables.agent_actions = {
        // Newest first, as the query asks for them.
        data: [
          { status: 'proposed', intent: { title: 'REQ-004 filter', space: 'AMBER' }, overrides: null, resolved: null },
          { status: 'executed', intent: { title: 'Old title', space: 'AMBER' }, overrides: { title: 'REQ-002 labels' }, resolved: {} },
        ],
        error: null,
      };
      ai.generateJson.mockResolvedValue(answer(plan({ reply: 'None left.', reply_language: 'en' })));
      await worker.execute(run);

      const prompt = String(request().prompt);
      expect(prompt).toContain('"earlier_tasks":[{"title":"REQ-002 labels","space":"AMBER","state":"created"},{"title":"REQ-004 filter","space":"AMBER","state":"open"}]');
    });

    it('leaves the prompt as it was without any', async () => {
      ai.generateJson.mockResolvedValue(answer(plan({ reply: 'Hi.', reply_language: 'en' })));
      await worker.execute(run);
      expect(String(request().prompt)).not.toContain('earlier_tasks');
    });
  });

  describe('shared files (1.18)', () => {
    it('waits for the upload when the request is the first message in the chat (1.19)', async () => {
      jest.useRealTimers();
      const read = jest.fn((_who: unknown, files: { handle: string; name: string }[]) => Promise.resolve(files.map((f) => ({ ...f, text: 'Go-live 15 Dec', truncated: false }))));
      const withFiles = new AgentRunWorkerService(
        { getClient: () => ({ from: (table: string) => query(tables[table]) }) } as unknown as SupabaseAdminService,
        runs as unknown as AgentRunsRepository,
        { load } as unknown as AgentContextService,
        views as unknown as AgentRunViewService,
        settings as unknown as AgentSettingsService,
        ai as unknown as TenantAiService,
        resolver as unknown as AgentResolverService,
        executor as unknown as AgentActionExecutorService,
        undefined,
        { read, taskFiles: jest.fn().mockResolvedValue([]) } as never,
      );
      const only = context({ request: '@Robert summarise this' });
      const one = { ...only, messages: only.messages.slice(-1).map((m) => ({ ...m, handle: 'm1' })), messageIds: only.messageIds.slice(-1) };
      load
        .mockResolvedValueOnce({ ...one, pendingFiles: { m1: 1 } })
        .mockResolvedValue({ ...one, files: [{ messageHandle: 'm1', attachmentId: 'att', name: 'notes.pdf', mime: null, size: 1 }] });
      ai.generateJson.mockResolvedValue(answer(plan({ reply: 'Done.', reply_language: 'en' })));
      await withFiles.execute(run);
      withFiles.onModuleDestroy();

      expect(load).toHaveBeenCalledTimes(2);
      expect(String(request().prompt)).toContain('"name":"notes.pdf"');
      expect(String(request().prompt)).not.toContain('still_uploading');
    }, 15_000);

    it('reads the files of the request as the invoker, lists older ones unread, and says what it could not read', async () => {
      const read = jest.fn((_who: unknown, files: { handle: string; name: string }[]) =>
        Promise.resolve(
          files.map((f) =>
            f.name === 'scan.pdf'
              ? { ...f, text: '', truncated: false, unreadable: 'scanned' }
              : { ...f, text: 'Go-live 15 Dec', truncated: false },
          ),
        ),
      );
      const filesService = { read, taskFiles: jest.fn().mockResolvedValue([]) };
      const withFiles = new AgentRunWorkerService(
        { getClient: () => ({ from: (table: string) => query(tables[table]) }) } as unknown as SupabaseAdminService,
        runs as unknown as AgentRunsRepository,
        { load } as unknown as AgentContextService,
        views as unknown as AgentRunViewService,
        settings as unknown as AgentSettingsService,
        ai as unknown as TenantAiService,
        resolver as unknown as AgentResolverService,
        executor as unknown as AgentActionExecutorService,
        undefined,
        filesService as never,
      );
      load.mockResolvedValue(
        context({
          request: '@Robert what is in the attached files?',
          files: [
            { messageHandle: 'm1', attachmentId: 'att-old', name: 'old.docx', mime: null, size: 1 },
            { messageHandle: 'm2', attachmentId: 'att-notes', name: 'notes.pdf', mime: null, size: 1 },
            { messageHandle: 'm2', attachmentId: 'att-scan', name: 'scan.pdf', mime: null, size: 1 },
          ],
        }),
      );
      ai.generateJson.mockResolvedValue(answer(plan({ reply: 'The notes say go-live is on 15 Dec.', reply_language: 'en' })));
      await withFiles.execute(run);
      withFiles.onModuleDestroy();

      expect(read).toHaveBeenCalledWith({ userId: run.invoker_id, organizationId: run.organization_id }, expect.any(Array), expect.stringContaining('attached files'), 70_000);
      const prompt = String(request().prompt);
      expect(prompt).toContain('"name":"notes.pdf","from":"m2","text":"Go-live 15 Dec"');
      expect(prompt).toContain('"files":["F1","F2"]');
      expect((finalized()?.result as Record<string, unknown>).reply_text).toBe(
        'The notes say go-live is on 15 Dec. I can\'t read "scan.pdf" yet: it is a scanned page or an image.',
      );
    });
  });

  describe('a follow-up on an open page proposal (1.17)', () => {
    const para = (text: string) => ({ type: 'paragraph', level: null, text, title: null, items: [], rows: [], variant: null, language: null, refs: [], labels: [] });
    const oldIntent = (over: Record<string, unknown> = {}) => ({
      ...intent,
      kind: 'wiki_page',
      title: 'Shop plan',
      page_type: 'project',
      space: 'AMBER',
      labels: ['launch'],
      body: [para('Budget agreed [m5] with @P1.')],
      wiki: {
        people: { P1: { userId: 'user-1', name: 'Prince' } },
        messages: { m5: 'msg-a' },
        tasks: {},
        pages: {},
        items: {},
        readSpaces: [],
        restricted: false,
        missing: [],
      },
      ...over,
    });
    const row = (over: Record<string, unknown> = {}) => ({
      id: 'act-old',
      run_id: 'run-0',
      ordinal: 1,
      status: 'proposed',
      expires_at: '2099-01-01T00:00:00Z',
      created_at: new Date().toISOString(),
      intent: oldIntent(),
      overrides: { title: 'Launch plan' },
      resolved: { title: 'Shop plan' },
      ...over,
    });
    const revisedPage = (over: Record<string, unknown> = {}) => ({
      ...intent,
      kind: 'wiki_page',
      title: 'Shop plan',
      revises: true,
      body: [para('Budget agreed [m1] with @P1.'), para('Risks: the theme may slip.')],
      ...over,
    });
    const ask = (request: string, rows: unknown[], answerIntents: unknown[] | null = null) => {
      load.mockResolvedValue(context({ request: `@Robert ${request}` }));
      tables.agent_runs = { data: [{ id: 'run-0', trigger_seq: 3 }], count: 0 };
      tables.agent_actions = { data: rows };
      if (answerIntents)
        ai.generateJson.mockResolvedValue(
          answer(plan({ reply: 'Done.', reply_language: 'en', object_language: 'en', intents: answerIntents })),
        );
    };
    const stored = () => finalized() as { actions: Record<string, unknown>[]; supersede: string[]; result: Record<string, unknown> };

    it('shows the model the open page in this run\'s handles and replaces it, keeping the card edits', async () => {
      ask('add a risks section', [row()], [revisedPage()]);
      await worker.execute(run);

      const prompt = String(request().prompt);
      expect(prompt).toContain('"open_proposal"');
      expect(prompt).toContain('Budget agreed [m1] with @P1.'); // m5 of the old run is m1 here
      expect(prompt).toContain('"card_changes":{"title":"Launch plan"}');
      expect(resolver.resolve).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ overrides: { title: 'Launch plan' } }),
      );
      const out = stored();
      expect(out.supersede).toEqual(['act-old']);
      expect(out.actions[0]).toMatchObject({
        overrides: { title: 'Launch plan' },
        intent: expect.objectContaining({ revision_of: 'act-old', revision_no: 1, labels: ['launch'], space: 'AMBER' }) as object,
      });
      expect(out.result.reply_text).toBe('Here is the updated page, please check and confirm it.');
      expect(String(out.result.stale_reply_text)).toContain('changed or was confirmed');
      expect(views.announce).toHaveBeenCalledWith('run-0', true);
    });

    it('lets the request set a field the person had edited on the card', async () => {
      ask('rename it to Go-live plan', [row()], [revisedPage({ title: 'Go-live plan' })]);
      await worker.execute(run);
      expect(stored().actions[0].overrides).toBeUndefined();
    });

    it('keeps the open card when the model returns no page', async () => {
      ask('add a risks section', [row()], []);
      await worker.execute(run);
      expect(stored().supersede).toEqual([]);
      expect(stored().actions).toEqual([]);
    });

    it('asks which page when two proposals are open and the request names neither', async () => {
      ask('add a risks section', [row(), row({ id: 'act-2', run_id: 'run-9', resolved: { title: 'FAQ' }, overrides: {} })]);
      tables.agent_runs = { data: [{ id: 'run-0', trigger_seq: 3 }, { id: 'run-9', trigger_seq: 2 }], count: 0 };
      await worker.execute(run);
      expect(ai.generateJson).not.toHaveBeenCalled();
      expect(stored().result.reply_text).toBe('Which page should I change: "Launch plan" or "FAQ"?');
      expect(stored().actions).toEqual([]);
    });

    it('takes the newest card when two open proposals have the same title (1.19)', async () => {
      ask('add a risks section', [row(), row({ id: 'act-2', run_id: 'run-9' })]);
      tables.agent_runs = { data: [{ id: 'run-0', trigger_seq: 3 }, { id: 'run-9', trigger_seq: 2 }], count: 0 };
      await worker.execute(run);
      expect(ai.generateJson).toHaveBeenCalledTimes(1);
      expect(String(request().prompt)).toContain('open_proposal');
    });

    it('says the page was already created, without a model call', async () => {
      ask('add a risks section', [row({ status: 'executed' })]);
      await worker.execute(run);
      expect(ai.generateJson).not.toHaveBeenCalled();
      expect(stored().result.reply_text).toBe('The page "Launch plan" was already created; please change it in the wiki.');
    });

    it('stops after five changes in a row', async () => {
      ask('add a risks section', [row({ intent: oldIntent({ revision_no: 5 }) })]);
      await worker.execute(run);
      expect(ai.generateJson).not.toHaveBeenCalled();
      expect(String(stored().result.reply_text)).toContain('changed 5 times');
    });

    it('brings back the version before on "undo", without a model call', async () => {
      const previous = row({ id: 'act-prev', status: 'cancelled', intent: oldIntent({ title: 'First draft' }), overrides: {} });
      ask('undo that', [row({ id: 'act-cur', intent: oldIntent({ revision_of: 'act-prev', revision_no: 1 }) }), previous]);
      await worker.execute(run);
      expect(ai.generateJson).not.toHaveBeenCalled();
      const out = stored();
      expect(out.supersede).toEqual(['act-cur']);
      expect(out.actions[0].intent).toMatchObject({ title: 'First draft', revision_of: null, revision_no: 2 });
    });

    it('keeps the page language on a follow-up in another language, unless it asks to translate', async () => {
      ask('füge einen Abschnitt mit den nächsten Schritten hinzu', [row({ intent: oldIntent({ object_language: 'en' }) })]);
      ai.generateJson.mockResolvedValue(answer(plan({ reply: 'x', reply_language: 'de', object_language: 'de', intents: [revisedPage()] })));
      await worker.execute(run);
      expect(String(request().prompt)).toContain('"language":"en"');
      expect(stored().actions[0].intent).toMatchObject({ object_language: 'en' });
      expect(stored().result.reply_text).toBe('Hier ist die geänderte Seite, bitte prüfe und bestätige sie.');

      runs.finalizeRun.mockClear();
      ask('übersetze die Seite auf Deutsch', [row({ intent: oldIntent({ object_language: 'en' }) })]);
      ai.generateJson.mockResolvedValue(answer(plan({ reply: 'x', reply_language: 'de', object_language: 'de', intents: [revisedPage()] })));
      await worker.execute(run);
      expect(stored().actions[0].intent).toMatchObject({ object_language: 'de' });
    });

    it('leaves a request that is no change alone', async () => {
      ask('what did we decide?', [row()]);
      ai.generateJson.mockResolvedValue(answer(plan({ reply: 'Friday.', reply_language: 'en' })));
      await worker.execute(run);
      expect(String(request().prompt)).not.toContain('open_proposal');
      expect(stored().supersede).toEqual([]);
    });
  });

  describe('a run', () => {
    it('never points at a card the model did not return (1.16)', async () => {
      ai.generateJson.mockResolvedValue(
        answer(plan({ reply: 'I have prepared the project page, please check and confirm.', reply_language: 'en' })),
      );
      await worker.execute(run);
      // In the request's language (the fixture asks in German).
      expect((finalized()?.result as Record<string, unknown>).reply_text).toBe(
        'Ich konnte den Vorschlag diesmal nicht zusammenstellen. Bitte frag mich noch einmal.',
      );
    });

    it('reads, asks the provider once and stores the answer with every result key', async () => {
      await worker.execute(run);

      expect(runs.setStep.mock.calls).toEqual([
        ['run-1', 'lease-1', 'reading'],
        ['run-1', 'lease-1', 'understanding'],
      ]);
      expect(load).toHaveBeenCalledWith(run);
      const [req] = ai.generateJson.mock.calls[0] as [Record<string, unknown>];
      expect(req).toMatchObject({
        provider: 'openai',
        model: 'gpt-4.1-mini',
        schemaName: 'robert_plan',
        timeoutMs: 280_000,
        maxOutputTokens: 28_000,
      });
      expect(req.signal).toBeInstanceOf(AbortSignal);
      expect(runs.recordModelCall).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          leaseToken: 'lease-1',
          tokensIn: 1000,
          tokensOut: 200,
          ok: true,
          errorKind: null,
        }),
      );

      const stored = finalized();
      expect(stored).toMatchObject({
        runId: 'run-1',
        leaseToken: 'lease-1',
        status: 'completed',
        errorCode: null,
        visibility: 'conversation',
        actions: [],
        audit: { intents: 0 },
      });
      expect(stored?.result).toEqual({
        reply_text: 'Ihr habt Freitag vereinbart.',
        reply_lang: 'de',
        object_lang: null,
        more_items: false,
        unsupported: 'none',
        context_message_ids: ['msg-a', 'msg-b'],
        context_min_seq: 4,
        context_capped: false,
        provider: 'openai',
        model: 'gpt-4.1-mini',
        prompt_version: '1.23.0',
        prompt_hash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
        prompt_text: expect.stringContaining(
          'was haben wir vereinbart?',
        ) as string,
      });
      // Every state change is announced; the end also to the whole conversation.
      expect(views.announce).toHaveBeenCalledWith('run-1');
      expect(views.announce).toHaveBeenLastCalledWith('run-1', true);
      // The request is German, so the prompt says so (decided in code, not by the model).
      expect(request().system).toContain('Answer in German');
    });

    it('keeps an answer in another language than asked, and logs it without text', async () => {
      load.mockResolvedValue(
        context({ request: '@Robert what did we agree?' }),
      );
      const warn = jest
        .spyOn(
          (worker as unknown as { logger: { warn: (m: string) => void } })
            .logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      await worker.execute(run);

      expect(request().system).toContain('Answer in English');
      expect(finalized()?.result).toMatchObject({ reply_lang: 'de' });
      expect(warn).toHaveBeenCalledWith(
        'Robert run run-1 answered in de, asked in en',
      );
    });

    it('proposes task intents, resolved as the invoker, and keeps who a handle stood for', async () => {
      const child = {
        ...intent,
        ref: 'i2',
        kind: 'subtask',
        title: 'Preise prüfen',
        parent: { item: 'i1', key: null, said: null },
        assignee: { said: 'Ala', participant: 'P2', is_requester: false },
      };
      ai.generateJson.mockResolvedValue(
        answer(plan({ intents: [intent, child] })),
      );
      await worker.execute(run);

      expect(resolver.batch).toHaveBeenCalledWith({
        invoker: { userId: 'user-1', organizationId: 'org-1' },
        conversation: expect.objectContaining({
          id: 'conv-1',
          kind: 'group',
        }) as object,
        timezone: 'Europe/Vienna',
      });
      const stored = finalized();
      expect(stored).toMatchObject({
        visibility: 'conversation',
        audit: { intents: 2, deferred: 0, unsupported_kinds: [] },
        result: expect.objectContaining({
          object_lang: 'de',
          scope: {
            spaces: [{ id: 'space-1', perm: 'create_tasks' }],
            refs: [],
          },
        }) as object,
      });
      const actions = stored?.actions as Record<string, unknown>[];
      expect(actions).toHaveLength(2);
      expect(actions[0]).toMatchObject({
        kind: 'task',
        depends_on: null,
        target_space_id: 'space-1',
        entity_type: 'task',
      });
      // "i1" became the ordinal of the earlier proposal; "P2" became Ala's user id.
      expect(actions[1]).toMatchObject({
        kind: 'subtask',
        depends_on: 1,
        intent: expect.objectContaining({
          assignee: expect.objectContaining({ user_id: 'user-2' }) as object,
        }) as object,
      });
    });

    it('fills a space the model left empty from the space the request names, never over one it set', async () => {
      resolver.spaceNamedIn.mockResolvedValue('AMBER');
      ai.generateJson.mockResolvedValue(
        answer(
          plan({
            intents: [
              { ...intent, space: null },
              { ...intent, ref: 'i2', space: 'Finance' },
            ],
          }),
        ),
      );
      await worker.execute(run);

      const actions = finalized()?.actions as {
        intent: { space: string | null };
      }[];
      expect(actions.map((a) => a.intent.space)).toEqual(['AMBER', 'Finance']);
    });

    it('never lets an item depend on itself; a parent the model listed later is placed first (audit 2026-11-10)', async () => {
      ai.generateJson.mockResolvedValue(
        answer(
          plan({
            intents: [
              { ...intent, parent: { item: 'i2', key: null, said: null } },
              {
                ...intent,
                ref: 'i2',
                parent: { item: 'i2', key: null, said: null },
              },
            ],
          }),
        ),
      );
      await worker.execute(run);

      const actions = finalized()?.actions as { depends_on: unknown; intent: { ref: string } }[];
      expect(actions.map((a) => [a.intent.ref, a.depends_on])).toEqual([
        ['i2', null],
        ['i1', 1],
      ]);
    });

    it('narrows the run to its invoker when a member could not see a target space', async () => {
      resolver.hidesFromAudience.mockResolvedValue(true);
      ai.generateJson.mockResolvedValue(answer(plan({ intents: [intent] })));
      await worker.execute(run);

      expect(resolver.hidesFromAudience).toHaveBeenCalledWith(
        expect.anything(),
        ['space-1'],
      );
      expect(finalized()).toMatchObject({ visibility: 'invoker' });
    });

    describe('what Robert read narrows who sees the answer (audit 2026-11-10)', () => {
      const withRefs = (refs: object) =>
        new AgentRunWorkerService(
          { getClient: () => ({ from: (table: string) => query(tables[table]) }) } as unknown as SupabaseAdminService,
          runs as unknown as AgentRunsRepository,
          { load } as unknown as AgentContextService,
          views as unknown as AgentRunViewService,
          settings as unknown as AgentSettingsService,
          ai as unknown as TenantAiService,
          resolver as unknown as AgentResolverService,
          executor as unknown as AgentActionExecutorService,
          { load: jest.fn().mockResolvedValue({ tasks: [], pages: [], missing: [], ...refs }) } as never,
        );
      const task = (spaceId: string) => ({ id: 't1', key: 'HR-12', spaceId, summary: 'Salary review', subtasks: [] });

      it('a reply that read a task some member cannot see is the invoker\'s only', async () => {
        resolver.hidesFromAudience.mockImplementation((_b: unknown, ids: string[]) =>
          Promise.resolve(ids.includes('hr-space')),
        );
        ai.generateJson.mockResolvedValue(answer(plan({ reply: 'HR-12 is about salaries.', reply_language: 'en' })));
        const w = withRefs({ tasks: [task('hr-space')] });
        await w.execute(run);
        w.onModuleDestroy();
        expect(resolver.hidesFromAudience).toHaveBeenCalledWith(expect.anything(), ['hr-space']);
        expect(finalized()).toMatchObject({ visibility: 'invoker' });
        expect(finalized()?.result).toMatchObject({ scope: { refs: [{ type: 'task', id: 't1' }] } });
      });

      it('a restricted page read makes it the invoker\'s only, whoever can see its space', async () => {
        ai.generateJson.mockResolvedValue(answer(plan({ reply: 'The page says…', reply_language: 'en' })));
        const w = withRefs({ pages: [{ id: 'p1', spaceId: 'team', restricted: true, title: 'Board notes' }] });
        await w.execute(run);
        w.onModuleDestroy();
        expect(finalized()).toMatchObject({ visibility: 'invoker' });
      });

      it('what everyone can see keeps the answer shared', async () => {
        resolver.hidesFromAudience.mockResolvedValue(false);
        ai.generateJson.mockResolvedValue(answer(plan({ reply: 'TEAM-3 is done.', reply_language: 'en' })));
        const w = withRefs({ tasks: [task('team')] });
        await w.execute(run);
        w.onModuleDestroy();
        expect(finalized()).toMatchObject({ visibility: 'conversation' });
      });

      it('a card in a shared space still narrows when what it was written from is private', async () => {
        resolver.hidesFromAudience.mockImplementation((_b: unknown, ids: string[]) =>
          Promise.resolve(ids.includes('hr-space')),
        );
        ai.generateJson.mockResolvedValue(answer(plan({ intents: [intent] })));
        const w = withRefs({ tasks: [task('hr-space')] });
        await w.execute(run);
        w.onModuleDestroy();
        expect(finalized()).toMatchObject({ visibility: 'invoker' });
      });
    });

    it('says what it cannot do beside the cards: a delete or a change asked with them (audit 2026-11-10)', async () => {
      ai.generateJson.mockResolvedValue(answer(plan({ intents: [intent], unsupported: 'delete' })));
      await worker.execute(run);
      expect(String((finalized()?.result as { reply_text?: string } | undefined)?.reply_text)).toContain('Löschen kann ich nichts');
      expect(unsupportedNote('update', 'de')).toMatch(/ändern/);
      expect(unsupportedNote('none', 'en')).toBeNull();
      expect(unsupportedNote(null, 'en')).toBeNull();
    });

    it('a dependency names its other card by ordinal, never by the model ref (1.22.1)', async () => {
      const dep = { item: 'i1', key: null, said: null, type: 'finish_to_start', this_is: 'successor', words: 'after Build ends' };
      ai.generateJson.mockResolvedValue(
        answer(
          plan({
            intents: [
              { ...intent, ref: 'i1', kind: 'plan_item', title: 'Build' },
              { ...intent, ref: 'i2', kind: 'plan_item', title: 'Pen test', depends: [dep] },
            ],
          }),
        ),
      );
      await worker.execute(run);
      const actions = finalized()?.actions as { intent: { depends?: { ordinal: number | null }[] } }[];
      expect(actions[1].intent.depends?.[0].ordinal).toBe(1);
    });

    it('two items with the same ref are both proposed, not one dropped (audit 2026-11-10)', async () => {
      ai.generateJson.mockResolvedValue(
        answer(plan({ intents: [intent, { ...intent, title: 'Zweite Aufgabe' }] })),
      );
      await worker.execute(run);
      expect((finalized()?.actions as unknown[]).length).toBe(2);
    });

    it('counts the kinds it cannot create yet, without storing them', async () => {
      ai.generateJson.mockResolvedValue(
        answer(
          plan({
            intents: [
              { ...intent, kind: 'asset_object' },
              { ...intent, ref: 'i2', kind: 'asset_object' },
            ],
          }),
        ),
      );
      await worker.execute(run);

      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(finalized()).toMatchObject({
        actions: [],
        audit: {
          intents: 2,
          deferred: 2,
          unsupported_kinds: ['asset_object'],
        },
      });
      expect(finalized()?.result).not.toHaveProperty('scope');
    });

    it('still answers when the proposals cannot be built at all', async () => {
      tables.chat_conversations = { data: null };
      jest
        .spyOn(
          (worker as unknown as { logger: { error: (m: string) => void } })
            .logger,
          'error',
        )
        .mockImplementation(() => undefined);
      ai.generateJson.mockResolvedValue(answer(plan({ intents: [intent] })));
      await worker.execute(run);

      expect(finalized()).toMatchObject({
        status: 'completed',
        actions: [],
        visibility: 'invoker',
      });
    });

    it('keeps a run private in a group of more than 50 members', async () => {
      tables.chat_members = { data: null, count: 51 };
      await worker.execute(run);

      expect(finalized()?.visibility).toBe('invoker');
    });

    it('re-reads once when the model asks for other messages, and never calls a third time', async () => {
      const wider = plan({ context: { action: 'last_n', n: 30, since: null } });
      ai.generateJson
        .mockResolvedValueOnce(answer(wider))
        .mockResolvedValueOnce(answer(wider));
      const reread = context({ messageIds: ['msg-z'], minSeq: 2 });
      load.mockResolvedValueOnce(context()).mockResolvedValueOnce(reread);

      await worker.execute(run);

      expect(runs.setStep).toHaveBeenLastCalledWith(
        'run-1',
        'lease-1',
        'rereading',
      );
      expect(load).toHaveBeenLastCalledWith(run, {
        ask: { action: 'last_n', n: 30, since: null },
        before: context(),
      });
      expect(ai.generateJson).toHaveBeenCalledTimes(2);
      expect(finalized()).toMatchObject({
        status: 'completed',
        result: expect.objectContaining({
          context_message_ids: ['msg-z'],
          context_min_seq: 2,
        }) as object,
      });
    });

    it('finishes with the answer it has when the budget runs out between the two calls', async () => {
      ai.generateJson.mockResolvedValue(
        answer(plan({ context: { action: 'earlier', n: null, since: null } })),
      );
      runs.recordModelCall.mockResolvedValue({
        recorded: true,
        remaining: 0,
        alert80: false,
      });

      await worker.execute(run);

      expect(ai.generateJson).toHaveBeenCalledTimes(1);
      expect(finalized()?.status).toBe('completed');
    });

    it('asks for no more output than the run has left', async () => {
      run.tokens_in = 55_000;
      run.tokens_out = 1_000;
      await worker.execute(run);

      expect(request()).toMatchObject({
        maxOutputTokens: 4_000,
      });
    });

    it('limits a call to the time left before the deadline', async () => {
      run.deadline_at = new Date(Date.now() + 20_000).toISOString();
      await worker.execute(run);

      const { timeoutMs } = request() as {
        timeoutMs: number;
      };
      expect(timeoutMs).toBeLessThanOrEqual(20_000);
      expect(timeoutMs).toBeGreaterThan(15_000);
    });

    it('delivers the 80% budget alert when the booking says so', async () => {
      runs.recordModelCall.mockResolvedValue({
        recorded: true,
        remaining: 50_000,
        alert80: true,
      });
      await worker.execute(run);

      expect(settings.notifyBudgetAlert).toHaveBeenCalledWith('org-1', 80);
    });

    it('stops quietly when the booking says the lease is lost', async () => {
      runs.recordModelCall.mockResolvedValue({
        recorded: false,
        remaining: 0,
        alert80: false,
      });
      await worker.execute(run);

      expect(runs.finalizeRun).not.toHaveBeenCalled();
    });

    it('stops quietly when a step cannot be stored (lease lost)', async () => {
      runs.setStep.mockResolvedValue(false);
      await worker.execute(run);

      expect(ai.generateJson).not.toHaveBeenCalled();
      expect(runs.finalizeRun).not.toHaveBeenCalled();
    });

    it('ends the run as failed when its answer cannot be stored, so no claim runs it again', async () => {
      runs.finalizeRun.mockRejectedValueOnce(new Error('22P05'));
      await worker.execute(run);

      expect(runs.finalizeRun).toHaveBeenCalledTimes(2);
      expect((runs.finalizeRun.mock.calls as unknown[][])[1][0]).toMatchObject({
        leaseToken: 'lease-1',
        status: 'failed',
        errorCode: 'failed',
        result: expect.objectContaining({ reply_text: null }) as object,
      });
      expect(views.announce).toHaveBeenCalledWith('run-1', true);
    });

    it('tries a failed run only once when it cannot be stored', async () => {
      runs.finalizeRun.mockRejectedValue(new Error('down'));
      await worker.execute(run);

      expect(runs.finalizeRun).toHaveBeenCalledTimes(2);
    });

    it('announces nothing when the finalize comes too late', async () => {
      runs.finalizeRun.mockResolvedValue({ finalized: false, status: null });
      await worker.execute(run);

      expect(views.announce).not.toHaveBeenCalledWith('run-1', true);
    });
  });

  describe('failures', () => {
    it('books a failed answer the provider billed and ends the run as failed', async () => {
      const err = Object.assign(new TenantAiError('invalid_output', 'bad'), {
        promptTokens: 900,
        completionTokens: 50,
      });
      ai.generateJson.mockRejectedValue(err);

      await worker.execute(run);

      expect(runs.recordModelCall).toHaveBeenCalledWith(
        expect.objectContaining({
          tokensIn: 900,
          tokensOut: 50,
          ok: false,
          errorKind: 'invalid_output',
        }),
      );
      expect(finalized()).toMatchObject({
        status: 'failed',
        errorCode: 'failed',
        result: expect.objectContaining({ reply_text: null }) as object,
      });
      expect(ai.generateJson).toHaveBeenCalledTimes(1);
    });

    it('fails an answer that does not fit the plan schema, after booking it', async () => {
      ai.generateJson.mockResolvedValue(answer({ reply: 42 }));
      await worker.execute(run);

      expect(runs.recordModelCall).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, errorKind: 'invalid_output' }),
      );
      expect(finalized()).toMatchObject({
        status: 'failed',
        errorCode: 'failed',
      });
    });

    it('tells the Robert managers once about a wrong key, and never retries it', async () => {
      ai.generateJson.mockRejectedValue(new TenantAiError('auth', 'nope'));
      await worker.execute(run);

      expect(ai.generateJson).toHaveBeenCalledTimes(1);
      expect(finalized()).toMatchObject({
        status: 'failed',
        errorCode: 'invalid_key',
      });
      expect(settings.notifyProviderProblem).toHaveBeenCalledWith('org-1');
    });

    it('fails as invalid_key when the configuration cannot be used', async () => {
      ai.resolveConfig.mockRejectedValue(
        new TenantAiError('not_configured', 'none'),
      );
      await worker.execute(run);

      expect(ai.generateJson).not.toHaveBeenCalled();
      expect(finalized()).toMatchObject({ errorCode: 'invalid_key' });
    });

    it('retries a rate-limited provider after 1, 3 and 9 seconds, then succeeds', async () => {
      jest.useFakeTimers({ now });
      const limited = new TenantAiError('rate_limited', 'slow down');
      ai.generateJson
        .mockRejectedValueOnce(limited)
        .mockRejectedValueOnce(limited)
        .mockRejectedValueOnce(limited);
      const done = worker.execute(run);

      for (const delay of RETRY_DELAYS_MS) {
        await jest.advanceTimersByTimeAsync(delay - 1);
        const calls = ai.generateJson.mock.calls.length;
        await jest.advanceTimersByTimeAsync(1);
        expect(ai.generateJson.mock.calls.length).toBe(calls + 1);
      }
      await done;

      expect(runs.recordModelCall).toHaveBeenCalledTimes(4);
      expect(finalized()?.status).toBe('completed');
    });

    it('gives up after three retries with the code of the last error', async () => {
      jest.useFakeTimers({ now });
      ai.generateJson.mockRejectedValue(
        new TenantAiError('provider_down', '503'),
      );
      const done = worker.execute(run);
      await jest.advanceTimersByTimeAsync(13_000);
      await done;

      expect(ai.generateJson).toHaveBeenCalledTimes(4);
      expect(finalized()).toMatchObject({
        status: 'failed',
        errorCode: 'provider_down',
      });
    });

    it('does not retry past the deadline', async () => {
      run.deadline_at = new Date(Date.now() + 500).toISOString();
      ai.generateJson.mockRejectedValue(
        new TenantAiError('rate_limited', '429'),
      );
      await worker.execute(run);

      expect(ai.generateJson).toHaveBeenCalledTimes(1);
      expect(finalized()).toMatchObject({ errorCode: 'rate_limited' });
    });

    it('never retries a timeout', async () => {
      ai.generateJson.mockRejectedValue(new TenantAiError('timeout', 'x'));
      await worker.execute(run);

      expect(ai.generateJson).toHaveBeenCalledTimes(1);
      expect(finalized()).toMatchObject({ errorCode: 'timeout' });
    });

    it('asks once for a shorter answer after one cut off at the limit (1.19)', async () => {
      ai.generateJson.mockRejectedValue(new TenantAiError('too_large', 'x'));
      await worker.execute(run);

      expect(ai.generateJson).toHaveBeenCalledTimes(2);
      expect(String((ai.generateJson.mock.calls[0][0] as { system: string }).system)).not.toContain('cut off at the length limit');
      expect(String((ai.generateJson.mock.calls[1][0] as { system: string }).system)).toContain('cut off at the length limit');
      expect(finalized()).toMatchObject({ errorCode: 'too_large' });
    });

    it('finishes normally when the shorter answer fits (1.19)', async () => {
      ai.generateJson.mockRejectedValueOnce(new TenantAiError('too_large', 'x')).mockResolvedValueOnce(answer(plan({ reply: 'Short answer.', reply_language: 'en' })));
      await worker.execute(run);

      expect(ai.generateJson).toHaveBeenCalledTimes(2);
      expect(finalized()).toMatchObject({ errorCode: null });
    });

    it('fails when the invoker can no longer read the conversation', async () => {
      load.mockRejectedValue(new Error('Conversation not found'));
      await worker.execute(run);

      expect(ai.generateJson).not.toHaveBeenCalled();
      expect(finalized()).toMatchObject({
        status: 'failed',
        errorCode: 'failed',
      });
    });
  });

  describe('stop', () => {
    /** A provider call that only ends when it is aborted, with the given error. */
    const hangUntilAborted = (err: Error) =>
      ai.generateJson.mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(err)),
          ),
      );

    it('aborts at the heartbeat that reports a Stop, and ends as cancelled, not as a timeout', async () => {
      // The provider reports the abort as its own timeout: the Stop must still win.
      hangUntilAborted(new TenantAiError('timeout', 'aborted'));
      runs.heartbeat.mockResolvedValue([
        { run_id: 'run-1', cancel_requested: true },
      ]);
      const done = worker.execute(run);
      await new Promise((resolve) => setImmediate(resolve));

      await worker.heartbeat();
      await done;

      expect(runs.heartbeat).toHaveBeenCalledWith(['lease-1']);
      // The tokens of the aborted call are still booked.
      expect(runs.recordModelCall).toHaveBeenCalled();
      expect(finalized()).toMatchObject({
        status: 'cancelled',
        errorCode: null,
      });
    });

    it('aborts at once on this instance when Stop is pressed', async () => {
      hangUntilAborted(new TenantAiError('cancelled', 'aborted'));
      const done = worker.execute(run);
      await new Promise((resolve) => setImmediate(resolve));

      expect(worker.abort('run-1')).toBe(true);
      await done;

      expect(finalized()).toMatchObject({ status: 'cancelled' });
      expect(worker.abort('run-1')).toBe(false);
    });

    it('cancels during a retry pause without waiting for it', async () => {
      jest.useFakeTimers({ now });
      ai.generateJson.mockRejectedValue(new TenantAiError('rate_limited', 'x'));
      const done = worker.execute(run);
      await jest.advanceTimersByTimeAsync(10);

      worker.abort('run-1');
      await done;

      expect(ai.generateJson).toHaveBeenCalledTimes(1);
      expect(finalized()).toMatchObject({ status: 'cancelled' });
    });

    it('aborts a run whose lease the heartbeat no longer renews; its late finalize changes nothing', async () => {
      hangUntilAborted(new TenantAiError('cancelled', 'aborted'));
      runs.finalizeRun.mockResolvedValue({ finalized: false, status: null });
      const done = worker.execute(run);
      await new Promise((resolve) => setImmediate(resolve));

      await worker.heartbeat();
      await done;

      expect(views.announce).not.toHaveBeenCalledWith('run-1', true);
    });

    it('leaves a renewed run alone', async () => {
      hangUntilAborted(new TenantAiError('cancelled', 'aborted'));
      runs.heartbeat.mockResolvedValue([
        { run_id: 'run-1', cancel_requested: false },
      ]);
      const done = worker.execute(run);
      await new Promise((resolve) => setImmediate(resolve));

      await worker.heartbeat();
      expect(runs.finalizeRun).not.toHaveBeenCalled();

      worker.abort('run-1');
      await done;
    });

    it('sends no heartbeat while nothing is in flight', async () => {
      await worker.heartbeat();
      expect(runs.heartbeat).not.toHaveBeenCalled();
    });
  });

  describe('sweep and timers', () => {
    it('expires old proposals and reconciles Confirms that hung, before the runs', async () => {
      const stuck = { id: 'act-1', status: 'executing', exec_token: 't2' };
      runs.reclaimStuckActions.mockResolvedValue([stuck]);

      await worker.sweep();

      expect(runs.expireActions).toHaveBeenCalledWith(100);
      expect(runs.reclaimStuckActions).toHaveBeenCalledWith(20);
      expect(executor.reconcile).toHaveBeenCalledWith(stuck);
      expect(runs.reapRuns).toHaveBeenCalled();
    });

    it('closes the cards of whoever lost access, and tells their open cards', async () => {
      runs.cancelRemovedRequesters.mockResolvedValue(['run-3', 'run-4']);

      await worker.sweep();

      expect(runs.cancelRemovedRequesters).toHaveBeenCalledWith(100);
      expect(views.announce).toHaveBeenCalledWith('run-3');
      expect(views.announce).toHaveBeenCalledWith('run-4');
    });

    it('tells the open cards of the runs whose proposals it expired', async () => {
      tables.agent_actions = {
        data: [{ run_id: 'run-7' }, { run_id: 'run-7' }, { run_id: 'run-8' }],
      };
      runs.expireActions.mockResolvedValue(3);

      await worker.sweep();

      expect(views.announce).toHaveBeenCalledWith('run-7');
      expect(views.announce).toHaveBeenCalledWith('run-8');
      expect(views.announce).toHaveBeenCalledTimes(2);
    });

    it('still reaps and claims runs when the proposal sweep fails', async () => {
      jest
        .spyOn(
          (worker as unknown as { logger: { error: (m: string) => void } })
            .logger,
          'error',
        )
        .mockImplementation(() => undefined);
      runs.expireActions.mockRejectedValue(new Error('db down'));

      await worker.sweep();

      expect(runs.reapRuns).toHaveBeenCalled();
      expect(runs.claimRuns).toHaveBeenCalled();
    });

    it('announces reaped runs and runs the claimed ones', async () => {
      const reaped = { ...run, id: 'run-0', status: 'failed' };
      runs.reapRuns.mockResolvedValue([reaped]);
      runs.claimRuns.mockResolvedValue([run]);

      await worker.sweep();
      await new Promise((resolve) => setImmediate(resolve));

      expect(views.announceRow).toHaveBeenCalledWith(reaped);
      expect(views.announceRow).toHaveBeenCalledWith(run);
      expect(runs.claimRuns).toHaveBeenCalledWith(20);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(ai.generateJson).toHaveBeenCalled();
    });

    it('claims only what is left of the 20 runs in flight here', async () => {
      hangUntilAbortedAll();
      for (let i = 0; i < 3; i++) void worker.execute({ ...run, id: `r${i}` });

      await worker.sweep();
      expect(runs.claimRuns).toHaveBeenCalledWith(17);
      for (let i = 0; i < 3; i++) worker.abort(`r${i}`);
    });

    function hangUntilAbortedAll() {
      ai.generateJson.mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_, reject) =>
            signal.addEventListener('abort', () =>
              reject(new TenantAiError('cancelled', 'x')),
            ),
          ),
      );
    }

    it('never sweeps twice at the same time, and survives a failing sweep', async () => {
      let release: (rows: unknown[]) => void = () => {};
      runs.reapRuns.mockReturnValueOnce(
        new Promise((resolve) => (release = resolve)),
      );
      const first = worker.sweep();
      await worker.sweep();
      // The first one is past the proposal sweep and waits in reapRuns.
      await new Promise((resolve) => setImmediate(resolve));
      expect(runs.reapRuns).toHaveBeenCalledTimes(1);
      release([]);
      await first;

      runs.reapRuns.mockRejectedValueOnce(new Error('db down'));
      await expect(worker.sweep()).resolves.toBeUndefined();
      await worker.sweep();
      expect(runs.reapRuns).toHaveBeenCalledTimes(3);
    });

    it('heartbeats every 5 s and sweeps every 15 s on unref()ed timers, until shutdown', async () => {
      jest.useFakeTimers({ now });
      const heartbeat = jest.spyOn(worker, 'heartbeat');
      const sweep = jest.spyOn(worker, 'sweep');
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      worker.onModuleInit();
      const timers = setIntervalSpy.mock.results.map(
        (r) => r.value as NodeJS.Timeout,
      );
      expect(timers.every((t) => !t.hasRef())).toBe(true);

      await jest.advanceTimersByTimeAsync(15_000);
      expect(heartbeat).toHaveBeenCalledTimes(3);
      expect(sweep).toHaveBeenCalledTimes(1);

      worker.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(heartbeat).toHaveBeenCalledTimes(3);
      expect(sweep).toHaveBeenCalledTimes(1);
      setIntervalSpy.mockRestore();
    });

    it('does nothing at all with ROBERT_WORKER_ENABLED=false', () => {
      jest.mocked(isRobertWorkerEnabled).mockReturnValueOnce(false);
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      worker.onModuleInit();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });

    it('runs a run handed over by the start after the current work, loaded by its lease', async () => {
      worker.runLeased('run-1', 'lease-1');
      expect(runs.setStep).not.toHaveBeenCalled();

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(runs.setStep).toHaveBeenCalledWith('run-1', 'lease-1', 'reading');
    });

    it('skips a handed-over run that is already gone', async () => {
      tables.agent_runs = { data: null };
      worker.runLeased('run-1', 'lease-1');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(runs.setStep).not.toHaveBeenCalled();
    });
  });
});

describe('handleMatchesName', () => {
  const context = {
    people: [
      { handle: 'P1', name: 'Prince Jadiya' },
      { handle: 'P2', name: 'Ala Bera' },
      { handle: 'P3', name: 'Rajbha Manek' },
    ],
  };

  it.each([
    [{ said: 'Rajbha', participant: 'P3' }, true],
    [{ said: 'rajbha manek', participant: 'P3' }, true],
    [{ said: '@Ala', participant: 'P2' }, true],
    [{ said: null, participant: 'P2' }, true],
    // The model named Rajbha but pointed at Ala: the name decides, never the handle.
    [{ said: 'Rajbha', participant: 'P2' }, false],
    [{ said: 'Ala', participant: 'P9' }, false],
    [{ said: 'Ala', participant: null }, false],
  ])('%j → %s', (assignee, expected) => {
    expect(handleMatchesName(context, assignee)).toBe(expected);
  });
});

describe('worker reply and intent clean-up (1.15.1)', () => {
  it('writes the lead-in itself, in the request language', () => {
    expect(proposalLine(['task'], 'en')).toBe('Here is the task, please check and confirm it.');
    expect(proposalLine(['task', 'subtask', 'task'], 'en')).toBe('Here are the 3 tasks, please check and confirm them.');
    expect(proposalLine(['wiki_page'], 'de')).toBe('Hier ist die Seite, bitte prüfe und bestätige sie.');
    expect(proposalLine(['wiki_page', 'task'], 'de')).toBe('Hier sind meine Vorschläge, bitte prüfe und bestätige sie.');
  });

  it('says in one line which asked-for macros it cannot add, and when a chart became a table (1.16)', () => {
    expect(macroNotes('project page with a gantt chart and a draw.io diagram', false, 'en')).toEqual([
      "I can't add a Gantt chart or a diagram yet; the rest of the page is ready.",
    ]);
    expect(macroNotes('Projektseite mit Gantt-Diagramm und Budget-Diagramm', true, 'de')).toEqual([
      'Folgendes kann ich noch nicht einfügen: ein Gantt-Diagramm. Der Rest der Seite ist fertig.',
      'Für ein Diagramm fehlen belegte Zahlen, deshalb stehen sie als Tabelle auf der Seite.',
    ]);
    expect(macroNotes('meeting notes about the onboarding form and the logo image', false, 'en')).toEqual([]);
  });

  it('keeps the filters of a live task table only as far as the request names them (1.16)', () => {
    const b = (over: Record<string, unknown>) =>
      ({ type: 'task_table', level: null, text: null, title: null, items: [], rows: [], variant: null, language: null, refs: [], labels: [], ...over }) as never;
    const people = [{ handle: 'P1', name: 'Prince Jadiya' }, { handle: 'P2', name: 'Rajbha Manek' }];
    expect(tableFilters([b({ refs: ['P1'], text: 'all open tasks', items: ['Open'] })], { request: 'a live list of all open tasks', people })).toEqual([
      expect.objectContaining({ refs: [], text: null, items: ['Open'] }),
    ]);
    expect(tableFilters([b({ refs: ['P1', 'P2'], text: 'android', items: ['Done'] })], { request: "rajbha's android tasks", people })).toEqual([
      expect.objectContaining({ refs: ['P2'], text: 'android', items: [] }),
    ]);
    expect(tableFilters([b({ refs: ['P1'], type: 'task_cards', labels: ['open'] })], { request: 'open tasks please', people })).toEqual([
      expect.objectContaining({ type: 'task_table', refs: [], items: ['open'], labels: [] }),
    ]);
    expect(tableFilters([b({ labels: ['high priority'], text: 'high priority' })], { request: 'tasks labelled high priority', people })).toEqual([
      expect.objectContaining({ type: 'task_table', items: ['high priority'], labels: [], text: 'high priority' }),
    ]);
    // People on a heading are no task cards.
    expect(tableFilters([b({ type: 'heading', text: 'Open tasks', refs: ['P2', 'T1'] })], { request: 'page', people })).toEqual([
      expect.objectContaining({ refs: ['T1'] }),
    ]);
  });

  it('adds a report the request names when the model left it out, on the leading page only (1.16)', () => {
    const people: { handle: string; name: string }[] = [];
    const types = (request: string, top = true) => tableFilters([], { request, people }, top).map((x) => `${x.type}:${x.items.join(',')}`);
    expect(types('decision log with a report of all decisions and a live list of all open tasks')).toEqual(['decision_report:', 'task_table:Open']);
    expect(types('Entscheidungsprotokoll mit allen Entscheidungen')).toEqual(['decision_report:']);
    expect(types('a report of all decisions', false)).toEqual([]);
    expect(types('meeting notes')).toEqual([]);
    expect(tableFilters([{ type: 'task_cards', level: null, text: null, title: null, items: [], rows: [], variant: null, language: null, refs: ['T1'], labels: [] }], { request: 'with a live list of all open tasks', people }).map((x) => x.type)).toEqual(['task_cards', 'task_table']);
  });

  it('tells the model a page still comes when the request asks for macros it cannot build (1.16)', () => {
    expect(scopeLine('page with a gantt chart')).toContain('The request asks for a Gantt chart, which cannot be added: still return the wiki_page intent');
    expect(scopeLine('page with a budget chart')).not.toContain('cannot be added');
    expect(scopeLine('add a risks section', true)).toContain('The open_proposal in the data is open now and this request changes it');
    expect(scopeLine('add a risks section')).not.toContain('open_proposal');
  });

  it('says plainly which file it could not use, only when the request relies on files (1.18)', () => {
    const f = (over: Record<string, unknown>) => ({ handle: 'F1', attachmentId: 'a', name: 'scan.pdf', mime: null, size: 1, from: 'm1', text: '', truncated: false, ...over }) as never;
    expect(refersToFiles('create tasks from the attached PDF')).toBe(true);
    expect(refersToFiles('erstelle Aufgaben aus dem Dokument')).toBe(true);
    expect(refersToFiles('meeting notes please')).toBe(false);
    expect(fileNotes({ request: 'tasks from this document' }, [f({ unreadable: 'scanned' })], 'en')).toEqual([
      'I can\'t read "scan.pdf" yet: it is a scanned page or an image.',
    ]);
    expect(fileNotes({ request: 'tasks from this document' }, [], 'en')).toEqual(["I don't see a file here that I could read."]);
    // Files exist, but none is the one asked about: no note about unrelated files.
    expect(fileNotes({ request: 'what does plan.txt say?' }, [], 'en', true)).toEqual([]);
    const ctx = { request: 'what does scan.pdf say?', messages: [{ handle: 'm1' }, { handle: 'm2' }] } as never;
    expect(focusFiles(ctx, [f({ from: 'm1' }), f({ from: 'm1', name: 'other.png', handle: 'F2' })])).toHaveLength(1);
    expect(fileNotes({ request: 'what did we decide?' }, [f({ unreadable: 'scanned' })], 'en')).toEqual([]);
    expect(fileNotes({ request: 'Seite aus der Datei' }, [f({ unreadable: 'no_access', name: 'x.docx' })], 'de')).toEqual([
      '„x.docx“ kann ich für dich nicht öffnen.',
    ]);
    expect(fileNotes({ request: 'from the file' }, [f({ text: 'abc', truncated: true, name: 'long.pdf' })], 'en')).toEqual([
      '"long.pdf" is long, so I read only part of it and something may be missing.',
    ]);
  });

  it('names the files it did not read, and judges the language without file names (1.19)', () => {
    const f = (over: Record<string, unknown>) => ({ handle: 'F1', attachmentId: 'a', name: 'x.pdf', mime: null, size: 1, from: 'm1', text: 'abc', truncated: false, ...over }) as never;
    expect(fileNotes({ request: 'from these files' }, [f({}), f({ name: 'note1.txt', text: '', unreadable: 'not_read' })], 'en')).toEqual([
      'I read at most 8 files at once, so I did not read "note1.txt".',
    ]);
    expect(spokenRequest({ request: 'what was decided in Protokoll März (final).docx?', files: [{ name: 'Protokoll März (final).docx' } as never] })).toBe('what was decided in  ?');
  });

  it('takes what is already done out of "the rest", whatever the model returns (1.19)', () => {
    const task = (title: string) => ({ kind: 'task', title }) as never;
    const plan = (intents: never[]) => ({ intents, more_items: false, reply: 'Here', reply_language: 'en' }) as never;
    const earlier = [{ title: 'REQ-002: labels' }, { title: 'Book the rooms' }];
    const out = withoutEarlierTasks(plan([task('REQ-002: labels, reworded'), task('book the rooms!'), task('REQ-004: filter')]), 'now create the rest', earlier);
    expect(out.intents).toEqual([task('REQ-004: filter')]);
    expect(out.more_items).toBe(true);
    // Nothing new: said so.
    const none = withoutEarlierTasks(plan([task('REQ-002: labels')]), 'die restlichen bitte', earlier);
    expect(none.intents).toEqual([]);
    expect(none.reply).toContain("can't find anything");
    expect(withoutDoneRows('REQ-002 | a\nREQ-004 | b\nplain', earlier)).toBe('REQ-004 | b\nplain');
    expect(withoutDoneRows('REQ-002 | a', [{ title: 'No id' }])).toBe('REQ-002 | a');
    // The same ID twice in one answer counts once, on any request.
    expect(withoutEarlierTasks(plan([task('REQ-9: a'), task('REQ-9: a, reworded'), task('Other')]), 'create tasks', []).intents).toEqual([task('REQ-9: a'), task('Other')]);
    // Asked again on purpose, or a different request: untouched.
    const same = plan([task('REQ-002: labels')]);
    expect(withoutEarlierTasks(same, 'create REQ-002 again', earlier)).toBe(same);
    expect(withoutEarlierTasks(same, 'now create the rest', [])).toBe(same);
  });

  it('"weitere" with a new title in quotes is a new item, not "the rest" (audit 2026-11-10)', () => {
    expect(isTheRest("Lege weitere Aufgabe 'Review' an")).toBe(false);
    expect(isTheRest('add the others: "Budget check"')).toBe(false);
    expect(isTheRest('erstelle die weiteren Aufgaben')).toBe(true);
    expect(isTheRest('now create the rest')).toBe(true);
    expect(isTheRest('die restlichen "REQ" Zeilen')).toBe(true);
  });

  it('a code shared by different items is not their row ID (audit 2026-11-10)', () => {
    const task = (title: string) => ({ kind: 'task', title }) as never;
    const plan = (intents: never[]) => ({ intents, more_items: false, reply: 'Here', reply_language: 'en' }) as never;
    // Two different tasks about one standard: both stay, in any request.
    const iso = [task('ISO-27001 A.5 map the controls'), task('ISO-27001 A.8 audit the assets'), task('Map ISO-27001 scope')];
    expect(withoutEarlierTasks(plan(iso), 'create tasks', []).intents).toEqual(iso);
    expect(withoutEarlierTasks(plan([task('SHA-256 checksums'), task('SHA-256 key rotation')]), 'create', []).intents).toHaveLength(2);
    // "The rest" from a file where the code leads many rows: compared by title, so A.8 is new.
    const file = ['ISO-27001 A.5 map the controls', 'ISO-27001 A.8 audit the assets', 'ISO-27001 A.9 access'];
    const rest = withoutEarlierTasks(
      plan([task('ISO-27001 A.8 audit the assets'), task('ISO-27001 A.9 access')]),
      'now create the rest',
      [{ title: 'ISO-27001 A.5 map the controls' }],
      file,
    );
    expect(rest.intents).toEqual([task('ISO-27001 A.8 audit the assets'), task('ISO-27001 A.9 access')]);
    expect(withoutDoneRows(file.join('\n'), [{ title: 'ISO-27001 A.5 map the controls' }])).toBe(file.join('\n'));
    // The model is told the done rows by ID only where the ID names one row.
    expect(doneNames([{ title: 'REQ-002: labels' }, { title: 'ISO-27001 A.5 map' }, { title: 'ISO-27001 A.8 audit' }])).toEqual([
      'REQ-002',
      'ISO-27001 A.5 map',
      'ISO-27001 A.8 audit',
    ]);
    // A code in the middle of a title is never a row ID.
    expect(withoutDoneRows('Map REQ-002 again\nREQ-004 | b', [{ title: 'REQ-002: labels' }])).toBe('Map REQ-002 again\nREQ-004 | b');
  });

  it('does not mix an older document into a request about this one (1.19)', () => {
    const files = [
      { messageHandle: 'm1', name: 'spec.pdf' },
      { messageHandle: 'm3', name: 'plan.xlsx' },
      { messageHandle: 'm3', name: 'plan-notes.docx' },
    ] as never[];
    const messages = [{ handle: 'm1' }, { handle: 'm2' }, { handle: 'm3' }, { handle: 'm4' }] as never[];
    const names = (request: string, msgs = messages) =>
      (files as { messageHandle: string; name: string }[]).filter(filesInScope({ request, messages: msgs, files }))
        .map((f) => f.name);
    // On the request itself.
    expect(names('a page from this plan', messages.slice(0, 3))).toEqual(['plan.xlsx', 'plan-notes.docx']);
    // The nearest message with files.
    expect(names('what does the spreadsheet say?')).toEqual(['plan.xlsx', 'plan-notes.docx']);
    // Named, or asked for together.
    expect(names('and what does spec.pdf say?')).toEqual(['spec.pdf', 'plan.xlsx', 'plan-notes.docx']);
    expect(names('compare the plan with the earlier spec')).toHaveLength(3);
    expect(names('go-live date in these documents')).toHaveLength(3);
  });

  it('asks for the whole list when the request says every or all (1.19)', () => {
    expect(scopeLine('tasks for every Must requirement')).toContain('Never stop early');
    expect(scopeLine('Aufgaben für alle Punkte')).toContain('Never stop early');
    expect(scopeLine('now create the rest')).toContain('Never stop early');
    expect(scopeLine('create a task for the login bug')).not.toContain('Never stop early');
    expect(scopeLine('small talk about tall walls')).not.toContain('Never stop early');
  });

  it('keeps the answer to a question asked beside a card, and nothing about the card (1.19)', () => {
    const asked = 'create tasks for the next steps and tell me when the cut-over is';
    expect(answerBesideCard('I created 4 tasks for you. The production cut-over is on 20 April 2027.', asked)).toBe('The production cut-over is on 20 April 2027.');
    expect(answerBesideCard('Here are the tasks, please confirm them.', asked)).toBe('');
    expect(answerBesideCard('The grand total is 99,30,567 [F1].', asked)).toBe('The grand total is 99,30,567.');
    // No question: the fixed line stands alone, as before.
    expect(answerBesideCard('The cut-over is on 20 April 2027.', 'create tasks for the next steps')).toBe('');
    expect(answerBesideCard(undefined, asked)).toBe('');
  });

  it('tells the person when a file tried to give orders (1.19)', () => {
    const f = { handle: 'F1', attachmentId: 'a', name: 'x.pdf', mime: null, size: 1, from: 'm1', text: 'abc', truncated: false, injections: 1 } as never;
    expect(fileNotes({ request: 'from the file' }, [f], 'en')[0]).toContain('text aimed at an AI assistant');
  });

  it('counts a file on the request and ordinary words pointing at one as being about the file (1.19)', () => {
    expect(refersToFiles('create tasks from these minutes')).toBe(true);
    expect(refersToFiles('from this plan: what is the budget?')).toBe(true);
    expect(refersToFiles('the open action items in the spec above')).toBe(true);
    expect(refersToFiles('what is the plan for today?')).toBe(false);
    expect(refersToFiles('back in 5 minutes')).toBe(false);
    const f = (over: Record<string, unknown>) => ({ handle: 'F1', attachmentId: 'a', name: 'scan.pdf', mime: null, size: 1, from: 'm1', text: '', truncated: false, ...over }) as never;
    // "what did we decide?" with a file on that very message: the note is still said.
    expect(fileNotes({ request: 'what did we decide?' }, [f({ unreadable: 'locked', name: 'pay.pdf' })], 'en', true, true)).toEqual([
      '"pay.pdf" is password protected, so I can\'t read it.',
    ]);
    // "the spec above": the newest message with files, not every file in the chat.
    const ctx = { request: 'tasks from the spec above', messages: [{ handle: 'm1' }, { handle: 'm2' }, { handle: 'm3' }] } as never;
    const files = [f({ from: 'm2', handle: 'F1', name: 'new.pdf' }), f({ from: 'm1', handle: 'F2', name: 'old.pdf' })];
    expect((focusFiles(ctx, files) as { name: string }[]).map((x) => x.name)).toEqual(['new.pdf']);
  });

  it('says how much of a file it read, and what it could not read in it (1.19)', () => {
    const f = (over: Record<string, unknown>) => ({ handle: 'F1', attachmentId: 'a', name: 'x.pdf', mime: null, size: 1, from: 'm1', text: 'abc', truncated: false, ...over }) as never;
    const request = { request: 'from the file' };
    expect(fileNotes(request, [f({ truncated: true, readPercent: 34 })], 'en')[0]).toContain('I read about 34%');
    expect(fileNotes(request, [f({ truncated: true, readPercent: 34 })], 'de')[0]).toContain('etwa 34 %');
    expect(fileNotes(request, [f({ scannedPages: [3, 4, 5] })], 'en')).toEqual(['Pages 3, 4, 5 of "x.pdf" are scans, so I couldn\'t read them: what you asked may be there.']);
    expect(fileNotes(request, [f({ scannedPages: [2] })], 'en')).toEqual(['Page 2 of "x.pdf" is a scan, so I couldn\'t read it: what you asked may be there.']);
    expect(fileNotes(request, [f({ pictures: 2 })], 'en')).toEqual(['I can\'t read text inside the pictures in "x.pdf".']);
    expect(fileNotes(request, [f({ hidden: ['slide 4', 'sheet "Old"'] })], 'en')).toEqual(['I left out what is hidden in "x.pdf" (slide 4, sheet "Old").']);
    expect(fileNotes(request, [f({ text: '', unreadable: 'empty' })], 'en')).toEqual(['"x.pdf" is empty.']);
    expect(fileNotes(request, [f({ text: '', unreadable: 'type', name: 'o.doc' })], 'en')[0]).toContain('share it as PDF, Word, Excel or PowerPoint');
  });

  it('leaves internal handles in brackets out of the reply (1.18)', () => {
    expect(cutReply('Only Ala Bera (P1) agreed, see (m3, m4) and (F1).')).toBe('Only Ala Bera agreed, see and.');
    expect(cutReply('Version (2026) stays.')).toBe('Version (2026) stays.');
    expect(cutReply('It owes 40,221 (page 1). [F1]')).toBe('It owes 40,221 (page 1).');
    expect(cutReply('See [m3, F2] and [Page 4].')).toBe('See and [Page 4].');
  });

  it('keeps a reply within 4,000 characters', () => {
    const long = 'word '.repeat(1_500);
    expect(cutReply(long).length).toBeLessThanOrEqual(4_000);
    expect(cutReply(long).endsWith('…')).toBe(true);
    expect(cutReply('short')).toBe('short');
  });

  it('drops the sentences that only repeat the card', () => {
    expect(withoutFieldEchoes('Update the ISMS policy to quarterly reviews. Assigned to Ala Bera.')).toBe('Update the ISMS policy to quarterly reviews.');
    expect(withoutFieldEchoes('Fix the TLS config before the audit. Owner: Rajbha. Due by Monday 10 November.')).toBe('Fix the TLS config before the audit.');
    expect(withoutFieldEchoes('Renew the certificate to keep submitting builds, assigned to Rajbha.')).toBe('Renew the certificate to keep submitting builds.');
    expect(withoutFieldEchoes('Assigned to Ala.')).toBe('Assigned to Ala.');
    expect(withoutFieldEchoes(null)).toBeNull();
  });

  it('finds words the request names, accents and case aside', () => {
    expect(namedIn('label it android please', 'Android')).toBe(true);
    expect(namedIn('fix the push thing, urgent', 'urgent')).toBe(true);
    expect(namedIn('fix the push thing', 'urgent')).toBe(false);
  });
});


describe('revisedIntents (1.17)', () => {
  const page = (ref: string, parent: string | null = null) =>
    ({ ref, kind: 'wiki_page', title: ref, parent: { item: parent, key: null, said: null }, body: [] }) as never;
  const open = (ref: string, parent: string | null = null) =>
    ({ id: `act-${ref}`, runId: 'run-0', ordinal: 1, title: ref, overrides: {}, blocks: [], intent: { ...(page(ref, parent) as object), labels: [], wiki: {} } }) as never;

  it('keeps a child page the model left out', () => {
    const { intents, revised } = revisedIntents([page('i1')], [open('i1'), open('i2', 'i1')]);
    expect((intents as { ref: string }[]).map((i) => i.ref)).toEqual(['i1', 'i2']);
    expect([...revised.keys()]).toEqual(['i1', 'i2']);
  });

  it('matches pages in order, and a page beyond the open ones is a new page', () => {
    const { intents, revised } = revisedIntents([page('i1'), page('i2'), page('i9')], [open('i1'), open('i2', 'i1')]);
    expect((intents as { ref: string }[]).map((i) => i.ref)).toEqual(['i1', 'i2', 'i9']);
    expect([...revised.keys()]).toEqual(['i1', 'i2']);
  });

  it('is no revision when the model returns no page', () => {
    expect(revisedIntents([], [open('i1')]).revised.size).toBe(0);
  });
});

describe('one page stays one page (1.15.2)', () => {
  const page = (ref: string, over: Record<string, unknown> = {}) =>
    ({
      ref,
      kind: 'wiki_page',
      title: ref === 'i1' ? 'Meeting notes' : 'Details',
      sources: [ref === 'i1' ? 'm1' : 'm2'],
      parent: { item: null, key: null, said: null },
      body: [{ type: 'paragraph', level: null, text: `Body of ${ref}`, title: null, items: [], rows: [], variant: null, language: null, refs: [], labels: [] }],
      ...over,
    }) as never;

  it('merges a child page nobody asked for into its parent', () => {
    const out = mergeUnaskedChildPages(
      [page('i1'), page('i2', { parent: { item: 'i1', key: null, said: null } })],
      'write this up as meeting notes in the AMBER wiki',
    ) as unknown as { ref: string; body: { text: string }[]; sources: string[] }[];
    expect(out.map((i) => i.ref)).toEqual(['i1']);
    expect(out[0].body.map((b) => b.text)).toEqual(['Body of i1', 'Details', 'Body of i2']);
    expect(out[0].sources).toEqual(['m1', 'm2']);
  });

  it('keeps child pages that were asked for', () => {
    const intents = [page('i1'), page('i2', { parent: { item: 'i1', key: null, said: null } })];
    expect(mergeUnaskedChildPages(intents, 'an onboarding page and a child page for each step')).toHaveLength(2);
    expect(mergeUnaskedChildPages(intents, 'eine Seite mit Unterseiten für jeden Schritt')).toHaveLength(2);
  });
});
