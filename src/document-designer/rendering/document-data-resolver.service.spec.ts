import { PayloadTooLargeException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { SavedFiltersService } from '../../saved-filters/saved-filters.service';
import type { IFilterResultItem } from '../../saved-filters/filter-query-engine';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { AssetObjectsService } from '../../assets-objects/asset-objects.service';
import {
  computeDocumentDataNeeds,
  DocumentDataResolverService,
  type IDocumentDataNeeds,
} from './document-data-resolver.service';
import type { IDocumentTemplateDefinition } from '../template-definition/template-definition.types';

const ORG = 'org-1';
const USER = 'user-1';
const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';

function noNeeds(
  overrides: Partial<IDocumentDataNeeds> = {},
): IDocumentDataNeeds {
  return {
    subtasks: false,
    linkedTasks: false,
    dynamicQuery: false,
    customFields: false,
    users: false,
    statuses: false,
    priorities: false,
    spaces: false,
    ...overrides,
  };
}

function filterRow(
  id: string,
  raw: Record<string, unknown>,
  entityType: 'task' | 'process' = 'task',
): IFilterResultItem {
  return {
    id,
    entity_type: entityType,
    key: (raw['key'] as string) ?? null,
    title: (raw['summary'] as string) ?? '',
    status: null,
    priority: null,
    assigned_to: null,
    reporter: null,
    description: null,
    start_date: null,
    request_type: null,
    space_id: (raw['space_id'] as string) ?? null,
    space_name: null,
    created_at: null,
    updated_at: null,
    due_date: null,
    custom_field_values: {},
    _entity: { id, ...raw },
  } as IFilterResultItem;
}

function engineResult(rows: IFilterResultItem[]) {
  return {
    data: {
      data: rows,
      total: rows.length,
      page: 1,
      pageSize: 50,
      hasMore: false,
      executedAt: new Date().toISOString(),
    },
  };
}

interface ChainResolved {
  data: unknown;
  error: unknown;
}

function buildChain(resolved: ChainResolved) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = jest.fn().mockImplementation(self);
  chain.eq = jest.fn().mockImplementation(self);
  chain.in = jest.fn().mockImplementation(self);
  chain.or = jest.fn().mockImplementation(self);
  chain.order = jest.fn().mockImplementation(self);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  chain.then = (
    onFulfilled: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(resolved).then(onFulfilled, onRejected);
  return chain;
}

describe('DocumentDataResolverService', () => {
  let mockFrom: jest.Mock;
  let savedFilters: {
    executeFilter: jest.Mock;
    executeAdHoc: jest.Mock;
    getPermittedTaskSpaceIds: jest.Mock;
  };
  let resolver: DocumentDataResolverService;
  let chainsByTable: Record<string, ChainResolved[]>;

  beforeEach(() => {
    chainsByTable = {
      organizations: [{ data: { name: 'Acme GmbH' }, error: null }],
    };
    mockFrom = jest.fn().mockImplementation((table: string) => {
      const queue = chainsByTable[table];
      const resolved =
        queue && queue.length > 0 ? queue.shift()! : { data: [], error: null };
      return buildChain(resolved);
    });

    savedFilters = {
      executeFilter: jest.fn(),
      executeAdHoc: jest.fn(),
      getPermittedTaskSpaceIds: jest.fn().mockResolvedValue(['space-1']),
    };

    const supabase = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const assetObjectsService = {
      getOne: jest.fn(),
    } as unknown as AssetObjectsService;

    resolver = new DocumentDataResolverService(
      supabase,
      savedFilters as unknown as SavedFiltersService,
      configService,
      assetObjectsService,
    );
  });

  describe('the AI label (SEC-06)', () => {
    const scope = { type: 'ids', ids: ['task-1', 'task-2'] } as never;
    const withLabels = () => {
      const labels = jest.fn().mockResolvedValue(new Map([['task-1', { confirmedBy: 'Carl', createdAt: '2026-11-05T10:00:00Z' }]]));
      const labelled = new DocumentDataResolverService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        { labels } as never,
      );
      return { labels, labelled };
    };

    it('asks once, only for a template that uses it', async () => {
      const { labels, labelled } = withLabels();
      await (labelled as unknown as { fillAiLabels: (p: unknown, i: unknown[]) => Promise<void> }).fillAiLabels(
        { organizationId: 'org-1', definition: { title: 'no label here' }, scope },
        [{ id: 'task-1', raw: {} }],
      );
      expect(labels).not.toHaveBeenCalled();
    });

    it('labels what Robert drafted and leaves what a person made empty', async () => {
      const { labels, labelled } = withLabels();
      const items = [
        { id: 'task-1', raw: {} as Record<string, unknown> },
        { id: 'task-2', raw: {} as Record<string, unknown> },
      ];
      await (labelled as unknown as { fillAiLabels: (p: unknown, i: unknown[]) => Promise<void> }).fillAiLabels(
        { organizationId: 'org-1', definition: { binding: { fieldKey: 'ai_label' } }, scope },
        items,
      );
      expect(labels).toHaveBeenCalledTimes(1);
      expect(items[0].raw.ai_label).toBe('Drafted by Robert · reviewed by Carl · 2026-11-05');
      expect(items[1].raw.ai_label).toBe('');
    });
  });

  it('routes an ids scope through executeAdHoc with a key-in filter', async () => {
    chainsByTable['tasks'] = [
      {
        data: [
          { id: UUID_1, key: 'T-1' },
          { id: UUID_2, key: 'T-2' },
        ],
        error: null,
      },
    ];
    savedFilters.executeAdHoc.mockResolvedValue(
      engineResult([
        filterRow(UUID_2, { key: 'T-2', summary: 'Two' }),
        filterRow(UUID_1, { key: 'T-1', summary: 'One' }),
      ]),
    );

    const context = await resolver.resolve({
      organizationId: ORG,
      userId: USER,
      sourceEntity: 'tasks',
      scope: { ids: [UUID_1, UUID_2] },
      needs: noNeeds(),
    });

    expect(savedFilters.executeAdHoc).toHaveBeenCalledWith(
      expect.objectContaining({
        source_type: 'tasks',
        query: {
          combinator: 'and',
          rules: [{ field: 'key', operator: 'in', value: ['T-1', 'T-2'] }],
        },
      }),
      ORG,
      USER,
    );
    // Requested ordering is preserved.
    expect(context.items.map((item) => item.id)).toEqual([UUID_1, UUID_2]);
  });

  it('never reads entity tables directly for query scopes', async () => {
    savedFilters.executeAdHoc.mockResolvedValue(
      engineResult([filterRow(UUID_1, { summary: 'One' })]),
    );

    await resolver.resolve({
      organizationId: ORG,
      userId: USER,
      sourceEntity: 'tasks',
      scope: { query: { combinator: 'and', rules: [] } },
      needs: noNeeds(),
    });

    const tables = (mockFrom.mock.calls as Array<[string]>).map(
      (call) => call[0],
    );
    expect(tables).not.toContain('tasks');
    expect(tables).not.toContain('business_processes');
  });

  it('uses executeFilter for saved-filter scopes without audit', async () => {
    savedFilters.executeFilter.mockResolvedValue(
      engineResult([filterRow(UUID_1, { summary: 'One' })]),
    );

    await resolver.resolve({
      organizationId: ORG,
      userId: USER,
      sourceEntity: 'tasks',
      scope: { savedFilterId: 'filter-1' },
      needs: noNeeds(),
    });

    expect(savedFilters.executeFilter).toHaveBeenCalledWith(
      'filter-1',
      ORG,
      USER,
      expect.objectContaining({ page: 1 }),
      { audit: false },
    );
  });

  it('filters engine rows to the requested entity type', async () => {
    savedFilters.executeAdHoc.mockResolvedValue(
      engineResult([
        filterRow(UUID_1, { summary: 'Task row' }, 'task'),
        filterRow(UUID_2, { title: 'Process row' }, 'process'),
      ]),
    );

    const context = await resolver.resolve({
      organizationId: ORG,
      userId: USER,
      sourceEntity: 'tasks',
      scope: { query: { combinator: 'and', rules: [] } },
      needs: noNeeds(),
    });

    expect(context.items).toHaveLength(1);
    expect(context.items[0].id).toBe(UUID_1);
  });

  it('fetches subtasks for N items, probing one extra depth level per query', async () => {
    savedFilters.executeAdHoc.mockResolvedValue(
      engineResult([
        filterRow(UUID_1, { summary: 'One' }),
        filterRow(UUID_2, { summary: 'Two' }),
      ]),
    );
    chainsByTable['tasks'] = [
      {
        data: [
          { id: 'sub-1', parent_task_id: UUID_1, summary: 'Sub 1' },
          { id: 'sub-2', parent_task_id: UUID_1, summary: 'Sub 2' },
          { id: 'sub-3', parent_task_id: UUID_2, summary: 'Sub 3' },
        ],
        error: null,
      },
    ];

    const context = await resolver.resolve({
      organizationId: ORG,
      userId: USER,
      sourceEntity: 'tasks',
      scope: { query: { combinator: 'and', rules: [] } },
      needs: noNeeds({ subtasks: true }),
    });

    // Depth-bounded frontier fetch (supports unlimited nesting): one query for
    // this level's subtasks, then one MORE probing whether sub-1/sub-2/sub-3
    // have children of their own — that probe returns empty (fixture has no
    // grandchildren) and the frontier loop stops there, at 2 queries.
    const taskTableCalls = (mockFrom.mock.calls as Array<[string]>).filter(
      (call) => call[0] === 'tasks',
    );
    expect(taskTableCalls).toHaveLength(2);
    expect(context.subtasksByItemId[UUID_1]).toHaveLength(2);
    expect(context.subtasksByItemId[UUID_2]).toHaveLength(1);
  });

  it('constrains sub-task lookups to the permitted task spaces', async () => {
    savedFilters.executeAdHoc.mockResolvedValue(
      engineResult([filterRow(UUID_1, { summary: 'One' })]),
    );
    savedFilters.getPermittedTaskSpaceIds.mockResolvedValue([
      'space-a',
      'space-b',
    ]);
    chainsByTable['tasks'] = [
      { data: [{ id: 'sub-1', parent_task_id: UUID_1 }], error: null },
    ];

    await resolver.resolve({
      organizationId: ORG,
      userId: USER,
      sourceEntity: 'tasks',
      scope: { query: { combinator: 'and', rules: [] } },
      needs: noNeeds({ subtasks: true }),
    });

    expect(savedFilters.getPermittedTaskSpaceIds).toHaveBeenCalledWith(
      USER,
      ORG,
    );
    const taskChain = mockFrom.mock.results.find(
      (_r, i) => (mockFrom.mock.calls[i] as [string])[0] === 'tasks',
    )?.value as { in: jest.Mock };

    expect(taskChain.in).toHaveBeenCalledWith('space_id', [
      'space-a',
      'space-b',
    ]);
  });

  it('returns no sub-tasks or linked tasks when the user has no permitted task space', async () => {
    savedFilters.executeAdHoc.mockResolvedValue(
      engineResult([filterRow(UUID_1, { summary: 'One' })]),
    );
    savedFilters.getPermittedTaskSpaceIds.mockResolvedValue([]);
    chainsByTable['tasks'] = [
      { data: [{ id: 'sub-1', parent_task_id: UUID_1 }], error: null },
    ];

    const context = await resolver.resolve({
      organizationId: ORG,
      userId: USER,
      sourceEntity: 'tasks',
      scope: { query: { combinator: 'and', rules: [] } },
      needs: noNeeds({ subtasks: true, linkedTasks: true }),
    });

    expect(context.subtasksByItemId).toEqual({});
    expect(context.linkedByItemId).toEqual({});
    const taskTableCalls = (mockFrom.mock.calls as Array<[string]>).filter(
      (call) => call[0] === 'tasks',
    );

    expect(taskTableCalls).toHaveLength(0);
  });

  it('throws PayloadTooLargeException when the item cap is exceeded', async () => {
    const rows = Array.from({ length: 6 }, (_, index) =>
      filterRow(`00000000-0000-4000-8000-00000000000${index}`, {
        summary: `Item ${index}`,
      }),
    );
    savedFilters.executeAdHoc.mockResolvedValue(engineResult(rows));

    await expect(
      resolver.resolve({
        organizationId: ORG,
        userId: USER,
        sourceEntity: 'tasks',
        scope: { query: { combinator: 'and', rules: [] } },
        needs: noNeeds(),
        itemLimit: 5,
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('truncates with a warning instead of throwing in preview mode', async () => {
    const rows = Array.from({ length: 6 }, (_, index) =>
      filterRow(`00000000-0000-4000-8000-00000000000${index}`, {
        summary: `Item ${index}`,
      }),
    );
    savedFilters.executeAdHoc.mockResolvedValue(engineResult(rows));

    const context = await resolver.resolve({
      organizationId: ORG,
      userId: USER,
      sourceEntity: 'tasks',
      scope: { query: { combinator: 'and', rules: [] } },
      needs: noNeeds(),
      itemLimit: 5,
      truncateOverLimit: true,
    });

    expect(context.items).toHaveLength(5);
    expect(context.warnings.some((w) => w.includes('truncated'))).toBe(true);
  });

  it('rejects a scope without any selector', async () => {
    await expect(
      resolver.resolve({
        organizationId: ORG,
        userId: USER,
        sourceEntity: 'tasks',
        scope: {},
        needs: noNeeds(),
      }),
    ).rejects.toThrow('Export scope requires');
  });

  it('restricts the users lookup to members of the exporting organization', async () => {
    const memberUuid = '33333333-3333-4333-8333-333333333333';
    const foreignUuid = '44444444-4444-4444-8444-444444444444';

    savedFilters.executeAdHoc.mockResolvedValue(
      engineResult([
        filterRow(UUID_1, {
          summary: 'One',
          assigned_to: memberUuid,
          // A planted foreign UUID in user-writable custom field values.
          custom_field_values: { spoofed: foreignUuid },
        }),
      ]),
    );
    // Membership intersection returns ONLY the real member.
    chainsByTable['organization_members'] = [
      { data: [{ user_id: memberUuid }], error: null },
    ];
    chainsByTable['users'] = [
      {
        data: [
          {
            id: memberUuid,
            first_name: 'Member',
            last_name: 'User',
            email: 'member@acme.test',
          },
        ],
        error: null,
      },
    ];

    const context = await resolver.resolve({
      organizationId: ORG,
      userId: USER,
      sourceEntity: 'tasks',
      scope: { query: { combinator: 'and', rules: [] } },
      needs: noNeeds({ users: true }),
    });

    // Membership query is org-scoped and filters the harvested ids.
    const memberCalls = (mockFrom.mock.calls as Array<[string]>).filter(
      (call) => call[0] === 'organization_members',
    );
    expect(memberCalls).toHaveLength(1);

    expect(context.lookups.usersById[memberUuid]).toBeDefined();
    // The foreign UUID never reaches the users lookup — it stays absent and
    // formats as empty downstream instead of leaking a name/email.
    expect(context.lookups.usersById[foreignUuid]).toBeUndefined();
  });

  it('chunks large .in() lookups at 100 ids per query', async () => {
    const itemCount = 250;
    const rows = Array.from({ length: itemCount }, (_, index) =>
      filterRow(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, {
        summary: `Item ${index}`,
      }),
    );
    savedFilters.executeAdHoc.mockResolvedValue(engineResult(rows));
    chainsByTable['tasks'] = [
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ];

    await resolver.resolve({
      organizationId: ORG,
      userId: USER,
      sourceEntity: 'tasks',
      scope: { query: { combinator: 'and', rules: [] } },
      needs: noNeeds({ subtasks: true }),
    });

    // 250 parent ids → ceil(250 / 100) = 3 chunked subtask queries, each with
    // ≤ 100 ids so the request URL stays under proxy limits.
    const taskTableCalls = (mockFrom.mock.calls as Array<[string]>).filter(
      (call) => call[0] === 'tasks',
    );
    expect(taskTableCalls).toHaveLength(3);
  });
});

describe('computeDocumentDataNeeds', () => {
  function definitionWith(elements: Array<Record<string, unknown>>) {
    return {
      schemaVersion: 1,
      mode: 'repeat_per_item',
      sourceEntity: 'tasks',
      page: {
        size: 'A4',
        orientation: 'portrait',
        margins: { top: 48, right: 48, bottom: 48, left: 48 },
        pageBreakMargin: 24,
      },
      elements,
    } as unknown as IDocumentTemplateDefinition;
  }

  const base = {
    id: 'el-1',
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    rotation: 0,
    positionMode: 'absolute',
    zIndex: 0,
    style: {},
  };

  it('detects loop data sources', () => {
    const needs = computeDocumentDataNeeds(
      definitionWith([
        {
          ...base,
          type: 'loop_region',
          dataSource: 'subtasks',
          itemSpacing: 4,
          itemHeight: 30,
        },
      ]),
    );
    expect(needs.subtasks).toBe(true);
    expect(needs.linkedTasks).toBe(false);
  });

  it('detects lookup needs from field bindings', () => {
    const needs = computeDocumentDataNeeds(
      definitionWith([
        {
          ...base,
          id: 'f1',
          type: 'field',
          binding: { source: 'system', fieldKey: 'assigned_to' },
        },
        {
          ...base,
          id: 'f2',
          type: 'field',
          binding: { source: 'system', fieldKey: 'status' },
        },
      ]),
    );
    expect(needs.users).toBe(true);
    expect(needs.statuses).toBe(true);
    expect(needs.priorities).toBe(false);
  });

  it('detects custom fields from bindings and cf_ conditions', () => {
    const needs = computeDocumentDataNeeds(
      definitionWith([
        {
          ...base,
          id: 't1',
          type: 'text',
          html: '<p>static</p>',
          condition: {
            combinator: 'and',
            rules: [{ field: 'cf_severity', operator: 'eq', value: 'high' }],
          },
        },
      ]),
    );
    expect(needs.customFields).toBe(true);
  });

  it('detects token usage in text elements', () => {
    const needs = computeDocumentDataNeeds(
      definitionWith([
        { ...base, id: 't1', type: 'text', html: '<p>{{space_name}}</p>' },
      ]),
    );
    expect(needs.spaces).toBe(true);
  });

  it('detects custom fields from BARE condition keys (designer contract)', () => {
    const needs = computeDocumentDataNeeds(
      definitionWith([
        {
          ...base,
          id: 't1',
          type: 'text',
          html: '<p>static</p>',
          condition: {
            combinator: 'and',
            rules: [{ field: 'severity', operator: 'eq', value: 'high' }],
          },
        },
      ]),
    );
    expect(needs.customFields).toBe(true);
  });

  it('does NOT flag known system or meta condition keys as custom fields', () => {
    const needs = computeDocumentDataNeeds(
      definitionWith([
        {
          ...base,
          id: 't1',
          type: 'text',
          html: '<p>static</p>',
          condition: {
            combinator: 'and',
            rules: [
              { field: 'status', operator: 'eq', value: 'open' },
              { field: 'itemCount', operator: 'gt', value: 1 },
            ],
          },
        },
      ]),
    );
    expect(needs.customFields).toBe(false);
  });

  it('detects custom fields from loop-region sortBy keys', () => {
    const needs = computeDocumentDataNeeds(
      definitionWith([
        {
          ...base,
          id: 'r1',
          type: 'loop_region',
          dataSource: 'subtasks',
          sortBy: 'severity',
          itemSpacing: 4,
          itemHeight: 30,
        },
      ]),
    );
    expect(needs.customFields).toBe(true);
  });
});
