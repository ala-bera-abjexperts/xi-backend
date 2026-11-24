/**
 * Crosswalk-visibility regression for the `issues` stage.
 *
 * `migration_entity_map` is unique on (organization_id, source_connection_id, entity_type,
 * source_id) — CONNECTION-scoped — while `task_priorities` rows are SPACE-scoped. One Jira
 * connection serves many projects and Jira priority ids are global per instance, so a run for project
 * KAN rewrites the shared crosswalk rows onto KAN-space targets. A later XMQ issue carrying the same
 * `prioritySourceId` then reads a target outside its own ladder and `TasksService.create` rejects
 * every one of its issues with `Invalid priority_id`.
 *
 * `priorities.stage` already guards itself by re-reading what its space can see
 * (priority.stage.ts:137-184). These tests pin the equivalent check in `issues.stage`.
 */

jest.mock('../../../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: unknown) => value,
}));

import { IssuesStage } from './issues.stage';
import { migrationTaskIdentity } from './migration-task-identity.util';
import type {
  TaskPriority,
  TaskPrioritiesService,
} from '../../../task-priorities/task-priorities.service';
import type { MigrationRunItemRow, StageContext } from './stage.interface';

const ORG = 'org-1';
const SPACE = 'space-1';
const CONNECTION = 'connection-1';
const identity = migrationTaskIdentity(ORG, CONNECTION, '100');

interface PriorityRow {
  id: string;
  key: string;
  space_id: string | null;
}

const spacePriority: PriorityRow = {
  id: 'space-row',
  key: 'medium',
  space_id: SPACE,
};
const foreignPriority: PriorityRow = {
  id: 'other-space-row',
  key: 'medium',
  space_id: 'space-2',
};

function ladder(rows: PriorityRow[]): TaskPriority[] {
  return rows as unknown as TaskPriority[];
}

interface Setup {
  stage: IssuesStage;
  ctx: StageContext;
  item: MigrationRunItemRow;
  create: jest.Mock;
  priorities: jest.Mocked<
    Pick<TaskPrioritiesService, 'getAll' | 'create' | 'update'>
  >;
}

/**
 * A live issue whose ONLY cross-entity gate of interest is the priority. The space, issue-type and
 * status gates resolve; assignee/reporter are omitted so their best-effort paths stay cold.
 */
function setup(priorityRow: Record<string, unknown> | null): Setup {
  const create = jest.fn().mockResolvedValue({ id: identity.targetId });
  const priorities = {
    getAll: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    update: jest.fn(),
  };

  const chain: Record<string, jest.Mock> = {};
  for (const method of ['select', 'eq', 'is', 'not'])
    chain[method] = jest.fn(() => chain);
  chain.limit = jest.fn().mockResolvedValue({ data: [], error: null });

  const stage = new IssuesStage(
    { create } as never,
    { getClient: () => ({ from: () => chain }) } as never,
    priorities as unknown as TaskPrioritiesService,
  );

  const run = { id: 'run-1', created_by: 'user-1', config_snapshot: {} };

  const ctx = {
    orgId: ORG,
    dryRun: false,
    job: {
      id: 'job-1',
      connection_id: CONNECTION,
      source_ref: 'XMQ',
      options: {},
      scope: {},
    },
    run,
    log: jest.fn().mockResolvedValue(undefined),
    entityMap: {
      getExistingTarget: jest.fn().mockResolvedValue(null),
      getTarget: jest.fn(
        (_org: string, _connection: string, entityType: string) => {
          if (entityType === 'space')
            return { status: 'mapped', target_id: SPACE };
          if (entityType === 'priority') return priorityRow;

          return { status: 'mapped', target_id: `${entityType}-target` };
        },
      ),
      recordMapping: jest.fn().mockResolvedValue(undefined),
    },
  } as unknown as StageContext;

  const item = {
    payload: {
      sourceId: '100',
      key: 'XMQ-1',
      summary: 'source',
      issueTypeSourceId: 'type',
      statusSourceId: 'status',
      prioritySourceId: '10000',
      description: null,
      customFields: {},
      labels: [],
      migrationIdentity: identity,
    },
  } as unknown as MigrationRunItemRow;

  return { stage, ctx, item, create, priorities };
}

function createdPriorityId(create: jest.Mock): unknown {
  const call = create.mock.calls[0] as unknown[] | undefined;
  const dto = call?.[2] as Record<string, unknown> | undefined;

  return dto?.priority_id;
}

describe('IssuesStage priority visibility', () => {
  it('re-anchors a foreign-space priority onto the same-key row this space exposes', async () => {
    const { stage, ctx, item, create, priorities } = setup({
      status: 'mapped',
      target_id: foreignPriority.id,
      source_key: 'medium',
      metadata: {},
    });
    priorities.getAll.mockResolvedValue(ladder([spacePriority]));

    await expect(stage.processItem(ctx, item)).resolves.toEqual({
      kind: 'created',
      targetId: identity.targetId,
      targetTable: 'tasks',
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(createdPriorityId(create)).toBe(spacePriority.id);
    expect(createdPriorityId(create)).not.toBe(foreignPriority.id);
    expect(ctx.log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('outside the target space'),
      expect.anything(),
    );
  });

  it('blocks instead of writing a foreign priority_id when no same-key row exists', async () => {
    const { stage, ctx, item, create, priorities } = setup({
      status: 'mapped',
      target_id: foreignPriority.id,
      source_key: 'urgent',
      metadata: {},
    });
    priorities.getAll.mockResolvedValue(
      ladder([{ id: 'unrelated', key: 'high', space_id: SPACE }]),
    );

    await expect(stage.processItem(ctx, item)).resolves.toEqual({
      kind: 'blocked',
      waitingFor: { entityType: 'priority', sourceId: '10000' },
    });

    expect(create).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('blocking until the priorities stage repairs it'),
      expect.anything(),
    );
  });

  it('passes a crosswalk target that IS visible in the target space through unchanged', async () => {
    const inSpace = { id: 'in-space', key: 'medium', space_id: SPACE };
    const { stage, ctx, item, create, priorities } = setup({
      status: 'mapped',
      target_id: inSpace.id,
      source_key: 'medium',
      metadata: {},
    });
    priorities.getAll.mockResolvedValue(ladder([inSpace]));

    await expect(stage.processItem(ctx, item)).resolves.toMatchObject({
      kind: 'created',
    });

    expect(createdPriorityId(create)).toBe(inSpace.id);
    expect(ctx.log).not.toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('outside the target space'),
      expect.anything(),
    );
  });

  it('treats an organization-wide target (space_id null) as visible', async () => {
    const orgPriority = { id: 'org-row', key: 'medium', space_id: null };
    const { stage, ctx, item, create, priorities } = setup({
      status: 'mapped',
      target_id: orgPriority.id,
      source_key: 'medium',
      metadata: {},
    });
    priorities.getAll.mockResolvedValue(ladder([orgPriority]));

    await expect(stage.processItem(ctx, item)).resolves.toMatchObject({
      kind: 'created',
    });

    expect(createdPriorityId(create)).toBe(orgPriority.id);
  });

  it('still blocks on a MISSING priority crosswalk row (existing outcome preserved)', async () => {
    const { stage, ctx, item, create, priorities } = setup(null);

    await expect(stage.processItem(ctx, item)).resolves.toEqual({
      kind: 'blocked',
      waitingFor: { entityType: 'priority', sourceId: '10000' },
    });

    expect(create).not.toHaveBeenCalled();
    expect(priorities.getAll).not.toHaveBeenCalled();
  });

  it('reads the space priority ladder ONCE per run, not once per issue', async () => {
    const inSpace = { id: 'in-space', key: 'medium', space_id: SPACE };
    const { stage, ctx, item, priorities } = setup({
      status: 'mapped',
      target_id: inSpace.id,
      source_key: 'medium',
      metadata: {},
    });
    priorities.getAll.mockResolvedValue(ladder([inSpace]));

    await stage.processItem(ctx, item);
    await stage.processItem(ctx, {
      ...item,
      payload: {
        ...(item.payload as object),
        sourceId: '101',
        key: 'XMQ-2',
        migrationIdentity: migrationTaskIdentity(ORG, CONNECTION, '101'),
      },
    } as MigrationRunItemRow);

    expect(priorities.getAll).toHaveBeenCalledTimes(1);
    expect(priorities.getAll).toHaveBeenCalledWith(ORG, SPACE);
  });
});
