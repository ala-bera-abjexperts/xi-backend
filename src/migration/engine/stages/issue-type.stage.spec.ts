import type { TaskHierarchyConfigService } from '../../../task-hierarchy-config/task-hierarchy-config.service';
import type { ITaskTypeLevel } from '../../../task-hierarchy-config/models/task-hierarchy-config.model';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type {
  IJiraSourceAdapter,
  Page,
} from '../../adapters/source-adapter.interface';
import type {
  NormalizedIssue,
  NormalizedIssueType,
} from '../../model/normalized';
import { IssueTypeStage } from './issue-type.stage';
import type { StageContext } from './stage.interface';

const ORG = '00000000-0000-4000-8000-000000000001';
const SPACE = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-000000000003';
const CONNECTION = 'connection-1';

type DbRow = Record<string, unknown>;
type DbFixture = {
  data?: DbRow[] | null;
  error?: { message: string } | null;
};

type MockQueryChain = {
  select: (...args: unknown[]) => MockQueryChain;
  eq: (column: string, value: unknown) => MockQueryChain;
  in: (column: string, values: unknown[]) => MockQueryChain;
  then: <TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => Promise<TResult1 | TResult2>;
};

type TestAdapter = Omit<IJiraSourceAdapter, 'iterateIssues'> & {
  iterateIssues: jest.Mock;
};

const issueType = (
  sourceId: string,
  name: string,
  hierarchyHint: NonNullable<NormalizedIssueType['hierarchyHint']> = 'standard',
): NormalizedIssueType => ({
  sourceId,
  name,
  isSubtask: hierarchyHint === 'subtask',
  hierarchyHint,
});

const issue = (
  sourceId: string,
  issueTypeSourceId: string,
  parentSourceId?: string,
): NormalizedIssue => ({
  sourceId,
  key: sourceId,
  summary: sourceId,
  issueTypeSourceId,
  statusSourceId: 'status-1',
  parentSourceId,
  labels: [],
  customFields: {},
  attachments: [],
  comments: [],
  links: [],
});

const level = (
  id: string,
  allowedParentTypes: string[] = [],
  allowedChildTypes: string[] = [],
): ITaskTypeLevel => ({
  id,
  name: id,
  name_i18n: {},
  description: null,
  description_i18n: {},
  icon: null,
  color: '#3B82F6',
  text_color: '#FFFFFF',
  parent_level_id: null,
  allowed_parent_types: allowedParentTypes,
  allowed_child_types: allowedChildTypes,
  max_depth: 10,
  default_status: 'open',
  default_priority: 'medium',
  field_group_ids: [],
  allowed_statuses: ['open'],
  sort_order: 0,
  is_active: true,
});

function makeAdapter(
  issueTypes: NormalizedIssueType[],
  pages: Page<NormalizedIssue>[],
  scanError?: Error,
): TestAdapter {
  // Async generators need no awaited work when their source pages are in-memory test data.
  // eslint-disable-next-line @typescript-eslint/require-await
  const iterateIssues = jest.fn(async function* () {
    for (const page of pages) yield page;
    if (scanError) throw scanError;
  });

  return {
    product: 'jira',
    deployment: 'server',
    listProjects: jest.fn(),
    getIssueTypes: jest.fn().mockResolvedValue(issueTypes),
    iterateIssues,
  } as unknown as TestAdapter;
}

function makeHarness(
  adapter: TestAdapter,
  existingLevels: ITaskTypeLevel[] = [],
  existingVersion = '1.0',
  dbFixtures: Record<string, DbFixture> = {},
) {
  let currentLevels = existingLevels;
  const hierarchyService = {
    getConfig: jest.fn(() =>
      Promise.resolve({
        config: { version: existingVersion, levels: currentLevels },
        record: currentLevels.length > 0 ? { id: 'config-1' } : null,
        isDefault: currentLevels.length === 0,
      }),
    ),
    saveConfig: jest.fn(
      (
        _orgId: string,
        _spaceId: string,
        config: { levels: ITaskTypeLevel[] },
      ) => {
        currentLevels = config.levels;
        return Promise.resolve({ id: 'config-1' });
      },
    ),
  };
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    in: jest.fn(),
  };
  const from = jest.fn((table: string) => {
    const equalities: [string, unknown][] = [];
    const inclusions: [string, unknown[]][] = [];
    const chain: MockQueryChain = {
      select: (...args: unknown[]) => {
        query.select(...args);
        return chain;
      },
      eq: (column: string, value: unknown) => {
        query.eq(column, value);
        equalities.push([column, value]);
        return chain;
      },
      in: (column: string, values: unknown[]) => {
        query.in(column, values);
        inclusions.push([column, values]);
        return chain;
      },
      then: <TResult1 = unknown, TResult2 = never>(
        onfulfilled?:
          | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null,
      ) => {
        const fixture = dbFixtures[table] ?? { data: [], error: null };
        const data = (fixture.data ?? []).filter(
          (row) =>
            equalities.every(([column, value]) => row[column] === value) &&
            inclusions.every(([column, values]) =>
              values.includes(row[column]),
            ),
        );

        return Promise.resolve({
          data: fixture.data === null ? null : data,
          error: fixture.error ?? null,
        }).then(onfulfilled, onrejected);
      },
    };

    return chain;
  });
  const supabaseAdmin = {
    getClient: () => ({ from }),
  };
  const mappedSourceIds = new Set<string>();
  const entityMap = {
    getTarget: jest.fn().mockResolvedValue({
      status: 'mapped',
      target_id: SPACE,
    }),
    getTargets: jest.fn(() => {
      const targets = new Map<string, { status: string }>();
      for (const sourceId of mappedSourceIds) {
        targets.set(sourceId, { status: 'mapped' });
      }
      return Promise.resolve(targets);
    }),
    recordMapping: jest.fn(({ sourceId }: { sourceId: string }) => {
      mappedSourceIds.add(sourceId);
      return Promise.resolve();
    }),
  };
  const ctx = {
    orgId: ORG,
    dryRun: false,
    job: {
      id: 'job-1',
      connection_id: CONNECTION,
      source_kind: 'jira_project',
      source_ref: 'PROJ',
      target_space_id: SPACE,
      scope: {},
      options: {},
    },
    run: {
      id: 'run-1',
      created_by: USER,
      config_snapshot: {},
    },
    entityMap,
    getAdapter: jest.fn().mockResolvedValue(adapter),
    log: jest.fn(),
  } as unknown as StageContext;
  const stage = new IssueTypeStage(
    hierarchyService as unknown as TaskHierarchyConfigService,
    supabaseAdmin as unknown as SupabaseAdminService,
  );

  return { ctx, entityMap, from, hierarchyService, query, stage };
}

async function produceAndProcess(stage: IssueTypeStage, ctx: StageContext) {
  const produced = await stage.produce(ctx);
  const [seed] = produced.items;

  await stage.processItem(ctx, {
    payload: seed.payload,
  } as unknown as Parameters<IssueTypeStage['processItem']>[1]);
}

function savedLevels(
  hierarchyService: ReturnType<typeof makeHarness>['hierarchyService'],
): ITaskTypeLevel[] {
  const config = hierarchyService.saveConfig.mock.calls.at(-1)?.[2] as {
    levels: ITaskTypeLevel[];
  };

  return config.levels;
}

describe('IssueTypeStage observed Jira hierarchy recovery', () => {
  it('recovers an observed Initiative -> Massnahme standard-to-standard edge', async () => {
    const adapter = makeAdapter(
      [
        issueType('type-init', 'Initiative'),
        issueType('type-mass', 'Massnahme'),
        issueType('type-epic', 'Epic', 'epic'),
        issueType('type-sub', 'Sub-task', 'subtask'),
      ],
      [
        {
          items: [
            issue('issue-mass', 'type-mass', 'issue-init'),
            issue('issue-init', 'type-init'),
          ],
          nextCursor: null,
          total: 2,
        },
      ],
    );
    const { ctx, hierarchyService, query, stage } = makeHarness(adapter);

    await produceAndProcess(stage, ctx);

    const levels = savedLevels(hierarchyService);
    expect(
      levels.find((item) => item.id === 'initiative')?.allowed_child_types,
    ).toEqual(['sub_task', 'massnahme']);
    expect(
      levels.find((item) => item.id === 'massnahme')?.allowed_parent_types,
    ).toEqual(['epic', 'initiative']);
    expect(query.eq).toHaveBeenCalledWith('run_id', 'run-1');
  });

  it('recovers every observed pair across multiple source pages', async () => {
    const adapter = makeAdapter(
      [
        issueType('type-init', 'Initiative'),
        issueType('type-mass', 'Massnahme'),
        issueType('type-work', 'Arbeitspaket'),
        issueType('type-review', 'Abnahme'),
        issueType('type-epic', 'Epic', 'epic'),
        issueType('type-sub', 'Sub-task', 'subtask'),
      ],
      [
        {
          items: [issue('issue-work', 'type-work', 'issue-mass')],
          nextCursor: '1',
          total: 4,
        },
        {
          items: [
            issue('issue-mass', 'type-mass', 'issue-init'),
            issue('issue-review', 'type-review', 'issue-mass'),
            issue('issue-init', 'type-init'),
          ],
          nextCursor: null,
          total: 4,
        },
      ],
    );
    const { ctx, hierarchyService, stage } = makeHarness(adapter);

    await produceAndProcess(stage, ctx);

    const levels = savedLevels(hierarchyService);
    expect(
      levels.find((item) => item.id === 'initiative')?.allowed_child_types,
    ).toEqual(['sub_task', 'massnahme']);
    expect(levels.find((item) => item.id === 'massnahme')).toEqual(
      expect.objectContaining({
        allowed_parent_types: ['epic', 'initiative'],
        allowed_child_types: ['sub_task', 'arbeitspaket', 'abnahme'],
      }),
    );
    expect(
      levels.find((item) => item.id === 'arbeitspaket')?.allowed_parent_types,
    ).toEqual(['epic', 'massnahme']);
  });

  it('immutably merges observed pairs into the target space config', async () => {
    const existing = [
      level('legacy-parent'),
      level('legacy-child'),
      level('initiative', ['legacy-parent'], ['legacy-child']),
      level('massnahme', ['legacy-parent'], ['legacy-child']),
    ];
    const before = structuredClone(existing);
    const adapter = makeAdapter(
      [
        issueType('type-init', 'Initiative'),
        issueType('type-mass', 'Massnahme'),
      ],
      [
        {
          items: [
            issue('issue-mass', 'type-mass', 'issue-init'),
            issue('issue-init', 'type-init'),
          ],
          nextCursor: null,
          total: 2,
        },
      ],
    );
    const { ctx, hierarchyService, stage } = makeHarness(
      adapter,
      existing,
      '2.0',
    );

    await produceAndProcess(stage, ctx);

    expect(existing).toEqual(before);
    expect(hierarchyService.saveConfig).toHaveBeenCalledWith(
      ORG,
      SPACE,
      expect.objectContaining({ version: '2.0' }),
      USER,
      'migration',
    );
    const levels = savedLevels(hierarchyService);
    expect(
      levels.find((item) => item.id === 'initiative')?.allowed_child_types,
    ).toEqual(['legacy-child', 'massnahme']);
    expect(
      levels.find((item) => item.id === 'massnahme')?.allowed_parent_types,
    ).toEqual(['legacy-parent', 'initiative']);
  });

  it('does not duplicate recovered pairs on retry', async () => {
    const adapter = makeAdapter(
      [
        issueType('type-init', 'Initiative'),
        issueType('type-mass', 'Massnahme'),
        issueType('type-epic', 'Epic', 'epic'),
        issueType('type-sub', 'Sub-task', 'subtask'),
      ],
      [
        {
          items: [
            issue('issue-mass', 'type-mass', 'issue-init'),
            issue('issue-init', 'type-init'),
          ],
          nextCursor: null,
          total: 2,
        },
      ],
    );
    const { ctx, hierarchyService, stage } = makeHarness(adapter);
    const produced = await stage.produce(ctx);
    const item = {
      payload: produced.items[0].payload,
    } as unknown as Parameters<IssueTypeStage['processItem']>[1];

    await stage.processItem(ctx, item);
    await stage.processItem(ctx, item);

    expect(hierarchyService.saveConfig).toHaveBeenCalledTimes(1);
    const levels = savedLevels(hierarchyService);
    expect(
      levels.find((entry) => entry.id === 'initiative')?.allowed_child_types,
    ).toEqual(['sub_task', 'massnahme']);
    expect(
      levels.find((entry) => entry.id === 'massnahme')?.allowed_parent_types,
    ).toEqual(['epic', 'initiative']);
  });

  it('preserves existing empty arrays as wildcard hierarchy rules', async () => {
    const existing = [level('initiative'), level('massnahme')];
    const adapter = makeAdapter(
      [
        issueType('type-init', 'Initiative'),
        issueType('type-mass', 'Massnahme'),
      ],
      [
        {
          items: [
            issue('issue-mass', 'type-mass', 'issue-init'),
            issue('issue-init', 'type-init'),
          ],
          nextCursor: null,
          total: 2,
        },
      ],
    );
    const { ctx, hierarchyService, stage } = makeHarness(adapter, existing);

    await produceAndProcess(stage, ctx);

    expect(hierarchyService.saveConfig).not.toHaveBeenCalled();
    expect(existing).toEqual([level('initiative'), level('massnahme')]);
  });

  it('preserves fresh empty arrays as wildcard hierarchy rules', async () => {
    const adapter = makeAdapter(
      [
        issueType('type-init', 'Initiative'),
        issueType('type-mass', 'Massnahme'),
      ],
      [
        {
          items: [
            issue('issue-mass', 'type-mass', 'issue-init'),
            issue('issue-init', 'type-init'),
          ],
          nextCursor: null,
          total: 2,
        },
      ],
    );
    const { ctx, hierarchyService, stage } = makeHarness(adapter);

    await produceAndProcess(stage, ctx);

    const levels = savedLevels(hierarchyService);
    expect(
      levels.find((item) => item.id === 'initiative')?.allowed_child_types,
    ).toEqual([]);
    expect(
      levels.find((item) => item.id === 'massnahme')?.allowed_parent_types,
    ).toEqual([]);
  });

  it('does not invent an edge when the parent is outside the scanned scope', async () => {
    const adapter = makeAdapter(
      [
        issueType('type-init', 'Initiative'),
        issueType('type-mass', 'Massnahme'),
      ],
      [
        {
          items: [issue('issue-mass', 'type-mass', 'out-of-scope-parent')],
          nextCursor: null,
          total: 1,
        },
      ],
    );
    const { ctx, hierarchyService, stage } = makeHarness(adapter);
    ctx.run.config_snapshot = { scope: { jql: 'labels = migrate-me' } };

    await produceAndProcess(stage, ctx);

    expect(adapter.iterateIssues).toHaveBeenCalledWith(
      'PROJ',
      expect.objectContaining({
        fields: ['issuetype', 'parent'],
        jql: 'labels = migrate-me',
      }),
    );
    const levels = savedLevels(hierarchyService);
    expect(
      levels.find((item) => item.id === 'initiative')?.allowed_child_types,
    ).toEqual([]);
    expect(
      levels.find((item) => item.id === 'massnahme')?.allowed_parent_types,
    ).toEqual([]);
  });

  it('propagates a source failure during the complete issue pre-pass', async () => {
    const adapter = makeAdapter(
      [
        issueType('type-init', 'Initiative'),
        issueType('type-mass', 'Massnahme'),
      ],
      [
        {
          items: [issue('issue-init', 'type-init')],
          nextCursor: '1',
          total: 2,
        },
      ],
      new Error('Jira scan failed'),
    );
    const { ctx, hierarchyService, stage } = makeHarness(adapter);

    await expect(produceAndProcess(stage, ctx)).rejects.toThrow(
      'Jira scan failed',
    );
    expect(hierarchyService.saveConfig).not.toHaveBeenCalled();
  });

  it('does not scan issues when the project has no issue types', async () => {
    const adapter = makeAdapter([], [], new Error('must not scan'));
    const { ctx, stage } = makeHarness(adapter);
    const produced = await stage.produce(ctx);

    await expect(
      stage.processItem(ctx, {
        payload: produced.items[0].payload,
      } as unknown as Parameters<IssueTypeStage['processItem']>[1]),
    ).resolves.toEqual({
      kind: 'skipped',
      reason: 'project has no issue types',
    });
    expect(adapter.iterateIssues).not.toHaveBeenCalled();
  });

  it('does not scan issues for a dry run', async () => {
    const adapter = makeAdapter(
      [issueType('type-init', 'Initiative')],
      [],
      new Error('must not scan'),
    );
    const { ctx, stage } = makeHarness(adapter);
    ctx.dryRun = true;
    const produced = await stage.produce(ctx);

    await expect(
      stage.processItem(ctx, {
        payload: produced.items[0].payload,
      } as unknown as Parameters<IssueTypeStage['processItem']>[1]),
    ).resolves.toEqual({ kind: 'planned' });
    expect(adapter.iterateIssues).not.toHaveBeenCalled();
  });

  it('does not scan issues while the target space is blocked', async () => {
    const adapter = makeAdapter(
      [issueType('type-init', 'Initiative')],
      [],
      new Error('must not scan'),
    );
    const { ctx, entityMap, stage } = makeHarness(adapter);
    entityMap.getTarget.mockResolvedValue(null);
    const produced = await stage.produce(ctx);

    await expect(
      stage.processItem(ctx, {
        payload: produced.items[0].payload,
      } as unknown as Parameters<IssueTypeStage['processItem']>[1]),
    ).resolves.toEqual({
      kind: 'blocked',
      waitingFor: { entityType: 'space', sourceId: 'PROJ' },
    });
    expect(adapter.iterateIssues).not.toHaveBeenCalled();
  });

  it('uses live statuses referenced by this run even when their crosswalk belongs to an older run', async () => {
    const adapter = makeAdapter(
      [issueType('type-story', 'Story')],
      [{ items: [], nextCursor: null, total: 0 }],
    );
    const { ctx, from, hierarchyService, stage } = makeHarness(
      adapter,
      [],
      '1.0',
      {
        migration_run_items: {
          data: [
            {
              organization_id: ORG,
              run_id: 'run-1',
              stage: 'task_statuses',
              entity_type: 'task_status',
              item_kind: 'entity',
              source_ref: 'jira-status-backlog',
              status: 'succeeded',
              target_id: 'target-backlog',
              payload: { statusCategory: 'new' },
            },
            {
              organization_id: ORG,
              run_id: 'run-1',
              stage: 'task_statuses',
              entity_type: 'task_status',
              item_kind: 'entity',
              source_ref: 'jira-status-selected',
              status: 'skipped',
              target_id: 'target-selected',
              payload: { statusCategory: 'indeterminate' },
            },
          ],
        },
        task_statuses: {
          data: [
            {
              id: 'target-backlog',
              organization_id: ORG,
              key: 'backlog',
            },
            {
              id: 'target-selected',
              organization_id: ORG,
              key: 'selected_for_development',
            },
          ],
        },
        migration_entity_map: {
          data: [
            {
              organization_id: ORG,
              source_connection_id: CONNECTION,
              run_id: 'old-run',
              entity_type: 'task_status',
              status: 'mapped',
              metadata: { key: 'wrong_old_key', category: 'done' },
            },
          ],
        },
      },
    );

    await produceAndProcess(stage, ctx);

    const [story] = savedLevels(hierarchyService);
    expect(story.allowed_statuses).toEqual(
      expect.arrayContaining(['backlog', 'selected_for_development']),
    );
    expect(story.default_status).toBe('backlog');
    expect(from).toHaveBeenCalledWith('migration_run_items');
    expect(from).toHaveBeenCalledWith('task_statuses');
    expect(from).not.toHaveBeenCalledWith('migration_entity_map');
  });

  it('excludes status rows that are not terminal entity items from this run', async () => {
    const adapter = makeAdapter(
      [issueType('type-task', 'Task')],
      [{ items: [], nextCursor: null, total: 0 }],
    );
    const { ctx, hierarchyService, stage } = makeHarness(adapter, [], '1.0', {
      migration_run_items: {
        data: [
          {
            organization_id: ORG,
            run_id: 'run-1',
            stage: 'task_statuses',
            entity_type: 'task_status',
            item_kind: 'entity',
            status: 'succeeded',
            target_id: 'target-backlog',
            payload: { statusCategory: 'new' },
          },
          {
            organization_id: ORG,
            run_id: 'another-run',
            stage: 'task_statuses',
            entity_type: 'task_status',
            item_kind: 'entity',
            status: 'succeeded',
            target_id: 'target-other-run',
            payload: { statusCategory: 'new' },
          },
          {
            organization_id: ORG,
            run_id: 'run-1',
            stage: 'task_statuses',
            entity_type: 'task_status',
            item_kind: 'entity',
            status: 'dead',
            target_id: 'target-dead',
            payload: { statusCategory: 'done' },
          },
          {
            organization_id: ORG,
            run_id: 'run-1',
            stage: 'task_statuses',
            entity_type: 'task_status',
            item_kind: 'collection',
            status: 'succeeded',
            target_id: 'target-collection',
            payload: { statusCategory: 'done' },
          },
        ],
      },
      task_statuses: {
        data: [
          { id: 'target-backlog', organization_id: ORG, key: 'backlog' },
          {
            id: 'target-other-run',
            organization_id: ORG,
            key: 'other_project_status',
          },
          { id: 'target-dead', organization_id: ORG, key: 'dead_status' },
          {
            id: 'target-collection',
            organization_id: ORG,
            key: 'collection_status',
          },
        ],
      },
    });

    await produceAndProcess(stage, ctx);

    const [task] = savedLevels(hierarchyService);
    expect(task.allowed_statuses).toContain('backlog');
    expect(task.allowed_statuses).not.toEqual(
      expect.arrayContaining([
        'other_project_status',
        'dead_status',
        'collection_status',
      ]),
    );
  });

  it('fails instead of silently narrowing the hierarchy when a terminal status target is missing', async () => {
    const adapter = makeAdapter(
      [issueType('type-task', 'Task')],
      [{ items: [], nextCursor: null, total: 0 }],
    );
    const { ctx, hierarchyService, stage } = makeHarness(adapter, [], '1.0', {
      migration_run_items: {
        data: [
          {
            organization_id: ORG,
            run_id: 'run-1',
            stage: 'task_statuses',
            entity_type: 'task_status',
            item_kind: 'entity',
            status: 'skipped',
            target_id: 'missing-target',
            payload: { statusCategory: 'new' },
          },
        ],
      },
      task_statuses: { data: [] },
    });

    await expect(produceAndProcess(stage, ctx)).rejects.toThrow();
    expect(hierarchyService.saveConfig).not.toHaveBeenCalled();
  });

  it('fails when a terminal task-status item has no target id', async () => {
    const adapter = makeAdapter(
      [issueType('type-task', 'Task')],
      [{ items: [], nextCursor: null, total: 0 }],
    );
    const { ctx, hierarchyService, stage } = makeHarness(adapter, [], '1.0', {
      migration_run_items: {
        data: [
          {
            organization_id: ORG,
            run_id: 'run-1',
            stage: 'task_statuses',
            entity_type: 'task_status',
            item_kind: 'entity',
            status: 'succeeded',
            target_id: null,
            payload: { statusCategory: 'new' },
          },
        ],
      },
      task_statuses: { data: [] },
    });

    await expect(produceAndProcess(stage, ctx)).rejects.toThrow(
      'A completed task-status item has no target status',
    );
    expect(hierarchyService.saveConfig).not.toHaveBeenCalled();
  });

  it('fails when a terminal task-status item points at a status with no live key', async () => {
    const adapter = makeAdapter(
      [issueType('type-task', 'Task')],
      [{ items: [], nextCursor: null, total: 0 }],
    );
    const { ctx, hierarchyService, stage } = makeHarness(adapter, [], '1.0', {
      migration_run_items: {
        data: [
          {
            organization_id: ORG,
            run_id: 'run-1',
            stage: 'task_statuses',
            entity_type: 'task_status',
            item_kind: 'entity',
            status: 'skipped',
            target_id: 'target-backlog',
            payload: { statusCategory: 'new' },
          },
        ],
      },
      task_statuses: {
        data: [{ id: 'target-backlog', organization_id: ORG, key: null }],
      },
    });

    await expect(produceAndProcess(stage, ctx)).rejects.toThrow(
      'Completed task-status target "target-backlog" no longer exists',
    );
    expect(hierarchyService.saveConfig).not.toHaveBeenCalled();
  });

  it.each([
    ['migration_run_items', 'status item lookup failed'],
    ['task_statuses', 'live status lookup failed'],
  ])('propagates a %s query error', async (failedTable, message) => {
    const adapter = makeAdapter(
      [issueType('type-task', 'Task')],
      [{ items: [], nextCursor: null, total: 0 }],
    );
    const { ctx, hierarchyService, stage } = makeHarness(adapter, [], '1.0', {
      migration_run_items: {
        data: [
          {
            organization_id: ORG,
            run_id: 'run-1',
            stage: 'task_statuses',
            entity_type: 'task_status',
            item_kind: 'entity',
            status: 'succeeded',
            target_id: 'target-backlog',
            payload: { statusCategory: 'new' },
          },
        ],
        error: failedTable === 'migration_run_items' ? { message } : null,
      },
      task_statuses: {
        data: [{ id: 'target-backlog', organization_id: ORG, key: 'backlog' }],
        error: failedTable === 'task_statuses' ? { message } : null,
      },
    });

    await expect(produceAndProcess(stage, ctx)).rejects.toThrow();
    expect(hierarchyService.saveConfig).not.toHaveBeenCalled();
  });
});
