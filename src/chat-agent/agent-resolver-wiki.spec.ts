import { SPACE_PLACEHOLDER } from './pipeline/agent-wiki-render';
import type { ChatAccessService } from '../chat/chat-access.service';
import type { ChatConversationsService } from '../chat/chat-conversations.service';
import type { FieldGroupsService } from '../custom-fields/field-groups.service';
import type { OrganizationModulesService } from '../organization-modules/organization-modules.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { TaskHierarchyConfigService } from '../task-hierarchy-config/task-hierarchy-config.service';
import type { TaskPrioritiesService } from '../task-priorities/task-priorities.service';
import type { TaskStatusesService } from '../task-statuses/task-statuses.service';
import type { WikiMineWriteService } from '../wiki/wiki-mine-write.service';
import type { WikiPermissionsService } from '../wiki/wiki-permissions.service';
import type { WorkflowAssignmentsService } from '../workflow-assignments/workflow-assignments.service';
import { validateTipTapDoc } from '../common/utils/tiptap-sanitizer';
import {
  type AgentFieldView,
  type AgentResolveBatch,
  AgentResolverService,
  type AgentStoredIntent,
  type AgentWikiHandles,
  type AgentWikiPlan,
} from './agent-resolver.service';
import type { AgentRunsRepository } from './agent-runs.repository';
import type { WikiBlock } from './pipeline/agent-wiki-render';

type Row = Record<string, unknown>;

/** A PostgREST stand-in with the filters the wiki branch uses. */
function fakeDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const run = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, value: unknown) => {
        if (!col.includes('.')) filters.push((row) => row[col] === value);
        return q;
      },
      is: (col: string, value: unknown) => {
        filters.push((row) => (row[col] ?? null) === value);
        return q;
      },
      in: (col: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[col]));
        return q;
      },
      ilike: (col: string, pattern: string) => {
        const needle = pattern.replace(/%/g, '').toLowerCase();
        filters.push((row) => String(row[col] ?? '').toLowerCase().includes(needle));
        return q;
      },
      lte: (col: string, value: number) => {
        filters.push((row) => Number(row[col]) <= value);
        return q;
      },
      // Like PostgREST on a jsonb column: the value must be JSON text, an array is rejected.
      contains: (col: string, json: unknown) => {
        if (typeof json !== 'string') throw new Error('invalid input syntax for type json');
        const values = JSON.parse(json) as unknown[];
        filters.push((row) => values.every((v) => ((row[col] as unknown[]) ?? []).includes(v)));
        return q;
      },
      not: () => q,
      or: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(resolve),
    };
    return q;
  };
  return { from };
}

const ME = '00000000-0000-4000-8000-000000000001';
const AMBER = '10000000-0000-4000-8000-000000000001';
const SECRET = '10000000-0000-4000-8000-000000000002';
const VPN_A = '20000000-0000-4000-8000-000000000001';
const VPN_B = '20000000-0000-4000-8000-000000000002';
const RUNBOOKS = '20000000-0000-4000-8000-000000000003';
const LOCKED = '20000000-0000-4000-8000-000000000004';

const person = { said: null, participant: null, is_requester: false };
const date = { said: null, iso: null };
const block = (b: Partial<WikiBlock> & Pick<WikiBlock, 'type'>): WikiBlock => ({
  level: null,
  text: null,
  title: null,
  items: [],
  rows: [],
  variant: null,
  language: null,
  refs: [],
  labels: [],
  ...b,
});
const handles = (over: Partial<AgentWikiHandles> = {}): AgentWikiHandles => ({
  people: { P2: { userId: ME, name: 'Prince' } },
  messages: { m3: 'msg-3' },
  tasks: { T1: { key: 'AMBER-T25', spaceId: AMBER } },
  pages: {},
  items: {},
  readSpaces: [AMBER],
  restricted: false,
  missing: [],
  ...over,
});
const page = (over: Partial<AgentStoredIntent> = {}): AgentStoredIntent => ({
  ref: 'i1',
  kind: 'wiki_page',
  title: 'Release 2.4 notes',
  description: null,
  sources: ['m3'],
  space: 'AMBER',
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
  page_type: 'release_notes',
  publish: false,
  general_knowledge: false,
  revises: false,
  body: [
    block({ type: 'excerpt', text: 'What ships in 2.4 [m3].' }),
    block({ type: 'task_cards', refs: ['T1'] }),
  ],
  plan: null,
  milestone: false,
  start: date,
  end: date,
  wiki: handles(),
  object_language: 'en',
  ...over,
});

describe('AgentResolverService wiki pages (1.15)', () => {
  let tables: Record<string, Row[]>;
  let perms: Record<string, jest.Mock>;
  let modules: Record<string, jest.Mock>;
  let wikiPermissions: { assertPageAccess: jest.Mock };
  let wikiWrite: { mayPublishDirectly: jest.Mock };
  let runs: Record<string, jest.Mock>;
  let service: AgentResolverService;
  let batch: AgentResolveBatch;

  const field = (fields: AgentFieldView[], key: string) =>
    fields.find((f) => f.key === key) as AgentFieldView;
  const resolve = (intent: AgentStoredIntent, overrides: Row = {}, dependsOn: number | null = null) =>
    service.resolve(batch, { kind: 'wiki_page', intent, overrides, dependsOn });

  beforeEach(() => {
    tables = {
      spaces: [
        { id: AMBER, organization_id: 'org-1', key: 'AMBER', name: 'Amber', is_archived: false },
        { id: SECRET, organization_id: 'org-1', key: 'SEC', name: 'Secret', is_archived: false },
      ],
      space_members: [{ space_id: AMBER, is_active: true }, { space_id: SECRET, is_active: true }],
      chat_members: [{ conversation_id: 'conv-1', organization_id: 'org-1', user_id: ME }],
      wiki_pages: [
        { id: VPN_A, organization_id: 'org-1', space_id: AMBER, title: 'VPN', level: 0, is_archived: false, has_custom_permissions: false, path: [] },
        { id: VPN_B, organization_id: 'org-1', space_id: AMBER, title: 'vpn', level: 1, is_archived: false, has_custom_permissions: false, path: [] },
        { id: RUNBOOKS, organization_id: 'org-1', space_id: AMBER, title: 'Runbooks', level: 0, is_archived: false, has_custom_permissions: false, path: [] },
        { id: LOCKED, organization_id: 'org-1', space_id: AMBER, title: 'HR Policies', level: 0, is_archived: false, has_custom_permissions: true, path: [] },
      ],
      wiki_labels: [{ id: 'lab-1', space_id: AMBER, name: 'release' }],
      tasks: [
        { key: 'AMBER-T30', organization_id: 'org-1', space_id: AMBER, labels: ['android'] },
        { key: 'SEC-T9', organization_id: 'org-1', space_id: SECRET, labels: [] },
      ],
    };
    perms = {
      isAdminOrOwner: jest.fn().mockResolvedValue(false),
      getUserSpacePermissions: jest.fn((_u: string, _o: string, spaceId: string) =>
        Promise.resolve({
          isMember: true,
          permissions: {
            create_wiki_pages: spaceId === AMBER,
            view_tasks: spaceId === AMBER,
          },
        }),
      ),
    };
    modules = {
      isEnabled: jest.fn().mockResolvedValue(true),
      getEnabledSpaceIds: jest.fn().mockResolvedValue([AMBER, SECRET]),
    };
    wikiPermissions = { assertPageAccess: jest.fn().mockResolvedValue(undefined) };
    wikiWrite = { mayPublishDirectly: jest.fn().mockResolvedValue(true) };
    runs = { findSimilar: jest.fn().mockResolvedValue([]) };
    const db = fakeDb(tables);
    service = new AgentResolverService(
      { getClient: () => ({ from: db.from }) } as unknown as SupabaseAdminService,
      perms as unknown as PermissionsService,
      { canViewSpace: jest.fn().mockResolvedValue(true) } as unknown as ChatAccessService,
      {} as ChatConversationsService,
      {} as TaskHierarchyConfigService,
      {} as WorkflowAssignmentsService,
      {} as TaskStatusesService,
      {} as TaskPrioritiesService,
      {} as FieldGroupsService,
      modules as unknown as OrganizationModulesService,
      runs as unknown as AgentRunsRepository,
      wikiPermissions as unknown as WikiPermissionsService,
      wikiWrite as unknown as WikiMineWriteService,
    );
    batch = service.batch({
      invoker: { userId: ME, organizationId: 'org-1' },
      conversation: { id: 'conv-1', kind: 'group', space_id: null },
      timezone: 'Europe/Vienna',
    });
  });

  it('builds a confirmable page from ids it looked up, as a draft', async () => {
    const r = await resolve(page({ labels: ['release'] }));
    const plan = r.create as AgentWikiPlan;

    expect(r.confirmable).toBe(true);
    expect(plan).toMatchObject({
      kind: 'wiki_page',
      spaceId: AMBER,
      parentPageId: null,
      title: 'Release 2.4 notes',
      labelIds: ['lab-1'],
      publish: false,
      readSpaces: [AMBER],
      restricted: false,
    });
    const json = JSON.stringify(plan.doc);
    expect(json).toContain('"taskKey":"AMBER-T25"');
    expect(json).toContain('"href":"/chat/conv-1?m=msg-3"');
  });

  it('keeps a live table for a space of this request, to be filled in at Confirm', async () => {
    batch.siblings.set(1, { kind: 'space', spaceId: null, pendingSpace: 1, taskTypeId: null, title: 'New' });
    const r = await resolve(page({ space: null, body: [block({ type: 'excerpt', text: 'Status.' }), block({ type: 'task_table' })] }), {}, 1);
    expect(JSON.stringify((r.create as { doc: unknown }).doc)).toContain(`"spaceId":"${SPACE_PLACEHOLDER}"`);
  });

  it('builds no live table without a space to fill in', async () => {
    const r = await resolve(page({ space: 'nowhere', body: [block({ type: 'excerpt', text: 'Status.' }), block({ type: 'task_table' })] }));
    expect(JSON.stringify((r.create as { doc?: unknown }).doc ?? {})).not.toContain(SPACE_PLACEHOLDER);
  });

  it('needs create_wiki_pages, and the wiki module in the organization and the space', async () => {
    const secret = await resolve(page({ space: 'SEC' }));
    expect(field(secret.fields, 'space')).toMatchObject({ state: 'blocked', code: 'no_create_permission' });

    modules.getEnabledSpaceIds.mockResolvedValue([SECRET]);
    batch = service.batch({ ...batch });
    const off = await resolve(page());
    expect(field(off.fields, 'space')).toMatchObject({ state: 'blocked', code: 'module_off' });
    expect(modules.isEnabled).toHaveBeenCalledWith('org-1', 'wiki');
  });

  it('suggests the space of the material when the request names none', async () => {
    const r = await resolve(page({ space: null }));
    expect(field(r.fields, 'space')).toMatchObject({ state: 'ok', value: AMBER });
  });

  it('asks which space when the material was only read, not shown on the page', async () => {
    const r = await resolve(page({ space: null, body: [block({ type: 'paragraph', text: 'How to renew a certificate' })] }));
    expect(field(r.fields, 'space')).toMatchObject({ state: 'needs_input', code: 'unknown_space' });
  });

  it('asks which parent when two pages share its title, and offers them', async () => {
    const r = await resolve(page({ parent_page: 'VPN' }));
    const parent = field(r.fields, 'parentPage');

    expect(parent).toMatchObject({ state: 'needs_input', code: 'ambiguous_parent' });
    expect(parent.options?.map((o) => o.value)).toEqual([VPN_A, VPN_B]);
    expect(r.confirmable).toBe(false);
  });

  it('takes the one parent it finds, and says when none is found', async () => {
    const found = await resolve(page({ parent_page: 'runbooks' }));
    expect(field(found.fields, 'parentPage')).toMatchObject({ state: 'ok', value: RUNBOOKS });
    expect((found.create as AgentWikiPlan).parentPageId).toBe(RUNBOOKS);

    const missing = await resolve(page({ parent_page: 'Onboarding' }));
    expect(field(missing.fields, 'parentPage')).toMatchObject({ state: 'needs_input', code: 'parent_not_found' });
  });

  it('never offers a parent the invoker may not create under', async () => {
    wikiPermissions.assertPageAccess.mockImplementation((id: string) =>
      id === RUNBOOKS ? Promise.reject(new Error('forbidden')) : Promise.resolve(),
    );
    const r = await resolve(page({ parent_page: 'Runbooks' }));
    expect(field(r.fields, 'parentPage').state).toBe('needs_input');
    expect(field(r.fields, 'parentPage').options?.map((o) => o.value)).not.toContain(RUNBOOKS);
  });

  it('marks a page under a parent with its own access list as restricted (the card narrows)', async () => {
    const r = await resolve(page({ parent_page: 'HR Policies' }));
    expect((r.create as AgentWikiPlan).restricted).toBe(true);
  });

  it('reads "in the AMBER wiki" as the space, never as a parent page', async () => {
    const r = await resolve(page({ parent_page: 'AMBER' }));
    expect(field(r.fields, 'parentPage')).toMatchObject({ state: 'ok', value: null });
  });

  it('creates a draft when the space reviews pages first', async () => {
    wikiWrite.mayPublishDirectly.mockResolvedValue(false);
    const r = await resolve(page({ publish: true }));
    expect(field(r.fields, 'publish')).toMatchObject({ state: 'check', code: 'review_required', value: false });
    expect((r.create as AgentWikiPlan).publish).toBe(false);
    expect(r.confirmable).toBe(true);
  });

  it('blocks an empty page and flags refs it could not resolve', async () => {
    const empty = await resolve(page({ body: [block({ type: 'heading', text: 'Notes' })] }));
    expect(field(empty.fields, 'body')).toMatchObject({ state: 'blocked', code: 'empty_body' });

    const unknown = await resolve(
      page({
        body: [
          block({ type: 'paragraph', text: 'Hello' }),
          block({ type: 'task_cards', refs: ['T1', 'SEC-T9', 'NOPE-T1'] }),
        ],
      }),
    );
    expect(field(unknown.fields, 'body')).toMatchObject({
      state: 'check',
      code: 'unknown_reference',
      params: expect.objectContaining({ refs: 'SEC-T9, NOPE-T1' }),
    });
    expect(JSON.stringify((unknown.create as AgentWikiPlan).doc)).not.toContain('SEC-T9');
  });

  it('shows tasks with labels only from a space the invoker can view', async () => {
    const r = await resolve(page({ body: [block({ type: 'task_cards', labels: ['android'] })] }));
    expect(JSON.stringify((r.create as AgentWikiPlan).doc)).toContain('"taskKey":"AMBER-T30"');
  });

  it('keeps a task created in the same request as a card to fill in, and names refs it could not read', async () => {
    const r = await resolve(
      page({
        wiki: handles({ items: { i2: 2 }, missing: ['SEC-T9'] }),
        body: [block({ type: 'paragraph', text: 'Plan' }), block({ type: 'task_cards', refs: ['i2'] })],
      }),
    );
    expect((r.create as AgentWikiPlan).items).toEqual([2]);
    expect(field(r.fields, 'references')).toMatchObject({ code: 'reference_not_found', advisory: true });
  });

  it('keeps only labels the space has', async () => {
    const r = await resolve(page({ labels: ['release', 'made-up'] }));
    expect(field(r.fields, 'labels')).toMatchObject({ code: 'unknown_label', advisory: true });
    expect((r.create as AgentWikiPlan).labelIds).toEqual(['lab-1']);
  });

  it('builds the live macros from the page space only, with its statuses, labels and the stated numbers (1.16)', async () => {
    tables.task_statuses = [
      { id: 'st-open', organization_id: 'org-1', space_id: null, name: 'Open', key: 'open', is_active: true },
    ];
    tables.wiki_labels.push({ id: 'lab-2', space_id: AMBER, name: 'decision' });
    const r = await resolve(
      page({
        wiki: handles({ numbers: ['12500', '30000'] }),
        body: [
          block({ type: 'excerpt', text: 'Budget [m3].' }),
          block({ type: 'chart', rows: [['Item', 'EUR'], ['Design', '12500'], ['Dev', '30000']] }),
          block({ type: 'task_table', items: ['Open'], refs: ['P2'] }),
          block({ type: 'decision_report', labels: ['decision'] }),
        ],
      }),
    );
    const json = JSON.stringify((r.create as AgentWikiPlan).doc);
    expect(() => validateTipTapDoc(json)).not.toThrow();
    expect(json).toContain('"type":"chart"');
    expect(json).toContain(`"spaceId":"${AMBER}"`);
    expect(json).toContain('"statusIds":["st-open"]');
    expect(json).toContain('"labels":["decision"],"spaceKeys":["AMBER"]');
    expect(field(r.fields, 'macros')).toBeUndefined();
  });

  it('flags a chart it could not verify and a label of another space, and shows no live table without view_tasks (1.16)', async () => {
    perms.getUserSpacePermissions.mockResolvedValue({ isMember: true, permissions: { create_wiki_pages: true, view_tasks: false } });
    tables.wiki_labels.push({ id: 'lab-9', space_id: SECRET, name: 'finance' });
    const r = await resolve(
      page({
        body: [
          block({ type: 'excerpt', text: 'Budget [m3].' }),
          block({ type: 'chart', rows: [['Item', 'EUR'], ['Design', '12500'], ['Dev', '30000']] }),
          block({ type: 'task_table' }),
          block({ type: 'decision_report', labels: ['finance'] }),
        ],
      }),
    );
    const json = JSON.stringify((r.create as AgentWikiPlan).doc);
    expect(json).not.toContain('"type":"chart"');
    expect(json).not.toContain('ticketTable');
    expect(json).not.toContain('decisionReport');
    expect(json).not.toContain(SECRET);
    expect(field(r.fields, 'macros')).toMatchObject({ state: 'check', advisory: true, params: { codes: 'chart_unverified, unknown_label' } });
    expect(r.confirmable).toBe(true);
  });

  it('reads a task table "status" that is a label of the space tasks as those tasks (1.16)', async () => {
    tables.task_statuses = [{ id: 'st-open', organization_id: 'org-1', space_id: null, name: 'Open', key: 'open', is_active: true }];
    const r = await resolve(page({ body: [block({ type: 'excerpt', text: 'Android [m3].' }), block({ type: 'task_table', labels: ['android'] })] }));
    const json = JSON.stringify((r.create as AgentWikiPlan).doc);
    expect(json).toContain('"taskKey":"AMBER-T30"');
    expect(json).not.toContain('ticketTable');
    expect(field(r.fields, 'macros')).toBeUndefined();

    // A status given as a label stays a status filter of the live table.
    const open = await resolve(page({ body: [block({ type: 'excerpt', text: 'Open [m3].' }), block({ type: 'task_table', labels: ['open'] })] }));
    expect(JSON.stringify((open.create as AgentWikiPlan).doc)).toContain('"statusIds":["st-open"]');
  });

  it('names a cited message by the file it carries, and links a cited file to its message (1.18)', async () => {
    const r = await resolve(
      page({
        wiki: handles({
          messageLabels: { m3: 'Ala Bera, 30 Oct 10:00' },
          files: { F1: { attachmentId: 'att-1', name: 'budget.xlsx', messageId: 'msg-3' } },
        }),
        body: [block({ type: 'excerpt', text: 'From the sheet [m3].' }), block({ type: 'paragraph', text: 'Total as in [F1].' })],
      }),
    );
    const json = JSON.stringify((r.create as AgentWikiPlan).doc);
    expect(json).toContain('"text":"budget.xlsx (Ala Bera, 30 Oct 10:00)"');
    expect(json).toContain('"href":"/chat/conv-1?m=msg-3"');
    expect(() => validateTipTapDoc(json)).not.toThrow();
  });

  it('hints at a similar page the invoker can see, without blocking', async () => {
    runs.findSimilar.mockResolvedValue([{ entity_id: RUNBOOKS, space_id: AMBER, score: 0.8, exact: false }]);
    const r = await resolve(page());
    expect(field(r.fields, 'similar')).toMatchObject({ code: 'similar_page', value: RUNBOOKS, display: 'Runbooks' });
    expect(r.confirmable).toBe(true);
  });

  describe('red team: an obedient model cannot smuggle anything into a page', () => {
    const HOSTILE: [string, WikiBlock[]][] = [
      ['script and iframe in text', [block({ type: 'paragraph', text: '<script>alert(1)</script><iframe src="https://evil.example"></iframe>Hi' })]],
      ['markdown and javascript links', [block({ type: 'paragraph', text: '[click](javascript:alert(1)) ![x](data:image/png;base64,AAA) https://evil.example/x' })]],
      ['event handlers in a code block', [block({ type: 'code', text: '<img src=x onerror=alert(1)>', language: 'html" onload="x' })]],
      ['a citation of a message outside the run', [block({ type: 'paragraph', text: 'Leaked [m99] and [m3]' })]],
      ['a mention of someone outside the run', [block({ type: 'paragraph', text: 'Ping @P9 and @P2' })]],
      ['a private task by key', [block({ type: 'paragraph', text: 'x' }), block({ type: 'task_cards', refs: ['SEC-T9'] })]],
      ['a made-up page handle', [block({ type: 'paragraph', text: 'x' }), block({ type: 'include_page', refs: ['W9', '20000000-0000-4000-8000-000000000004'] })]],
      ['an unknown block type', [block({ type: 'paragraph', text: 'x' }), { ...block({ type: 'paragraph' }), type: 'rawHtml' as never, text: '<b>x</b>' }]],
      ['a huge table', [block({ type: 'table', rows: Array.from({ length: 200 }, () => Array.from({ length: 40 }, () => 'cell')) })]],
      ['a callout variant and status colour outside the lists', [block({ type: 'callout', variant: 'custom', text: 'x' }), block({ type: 'status', variant: 'black', items: ['x'] })]],
      ['labels of tasks in a space the invoker cannot view', [block({ type: 'paragraph', text: 'x' }), block({ type: 'task_cards', labels: [''] })]],
      ['200 blocks', Array.from({ length: 200 }, (_, i) => block({ type: 'paragraph', text: `p${i}` }))],
    ];

    it.each(HOSTILE)('%s', async (_name, body) => {
      const r = await resolve(page({ body, space: 'AMBER' }));
      const doc = (r.create as AgentWikiPlan).doc;
      const json = JSON.stringify(doc);

      // The wiki's own whitelist accepts it unchanged.
      expect(() => validateTipTapDoc(json)).not.toThrow();
      // Text is inert (it renders as text); what matters is every node and attribute outside it.
      const structure = JSON.stringify(doc, (key, value: unknown) => (key === 'text' ? undefined : value));
      expect(structure).not.toMatch(/script|iframe|onerror|onload|javascript:|data:|evil\.example|rawHtml|embed/i);
      expect(json).not.toMatch(/<script|<iframe|\]\(javascript:/i);
      // Links only to messages of this run.
      for (const m of json.matchAll(/"href":"([^"]+)"/g)) expect(m[1]).toBe('/chat/conv-1?m=msg-3');
      // Ids only from the run's handles or the resolver.
      for (const m of json.matchAll(/"(userId|pageId)":"([^"]+)"/g)) expect([ME]).toContain(m[2]);
      for (const m of json.matchAll(/"taskKey":"([^"]+)"/g)) expect(['AMBER-T25', 'AMBER-T30']).toContain(m[1]);
      expect(json).not.toContain('SEC-T9');
      expect(json).not.toContain(LOCKED);
      expect(json.length).toBeLessThan(400_000);
    });
  });
});

