import { PriorityStage } from './priority.stage';
import type { StageContext } from './stage.interface';
import type { TaskPrioritiesService } from '../../../task-priorities/task-priorities.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const CONNECTION = 'connection-1';

const priorityItem = {
  payload: {
    sourceId: 'source-priority-medium',
    derivedKey: 'medium',
    name: 'Medium',
    rank: 2,
    colorHex: '#6B7280',
    sortOrder: 3,
  },
} as unknown as Parameters<PriorityStage['processItem']>[1];

function makeCtx(existing: Record<string, unknown> | null): StageContext {
  return {
    orgId: ORG,
    dryRun: false,
    job: { id: 'job-1', connection_id: CONNECTION, source_ref: 'PROJ' },
    run: { id: 'run-1', created_by: 'user-1', config_snapshot: {} },
    entityMap: {
      getTarget: jest.fn(
        (_org: string, _connection: string, entityType: string) => {
          if (entityType === 'priority') return existing;

          if (entityType === 'space') {
            return { status: 'mapped', target_id: SPACE };
          }

          return null;
        },
      ),
      recordMapping: jest.fn(),
    },
    getAdapter: jest.fn(),
    log: jest.fn(),
  } as unknown as StageContext;
}

function makePrioritiesService() {
  return {
    getAll: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<TaskPrioritiesService, 'getAll' | 'update' | 'create'>
  >;
}

describe('PriorityStage mapped-priority recovery', () => {
  it('keeps a priority mapping that remains visible in the target space', async () => {
    const priorities = makePrioritiesService();
    const ctx = makeCtx({ status: 'mapped', target_id: 'priority-medium' });
    priorities.getAll.mockResolvedValue([
      { id: 'priority-medium', key: 'medium', space_id: SPACE },
    ]);
    priorities.update.mockResolvedValue({ id: 'priority-medium' });
    const stage = new PriorityStage(priorities as TaskPrioritiesService);

    await expect(stage.processItem(ctx, priorityItem)).resolves.toEqual({
      kind: 'skipped',
      reason: 'priority already mapped',
      targetId: 'priority-medium',
    });

    expect(priorities.getAll).toHaveBeenCalledWith(ORG, SPACE);
    expect(priorities.update).toHaveBeenCalledWith(
      'priority-medium',
      ORG,
      { sort_order: 3 },
      'user-1',
    );
    expect(ctx.entityMap.recordMapping).not.toHaveBeenCalled();
  });

  it('remaps a stale priority by adopting the visible matching key', async () => {
    const priorities = makePrioritiesService();
    const ctx = makeCtx({ status: 'mapped', target_id: 'deleted-priority' });
    priorities.getAll.mockResolvedValue([
      { id: 'priority-medium-live', key: 'medium', space_id: SPACE },
    ]);
    const stage = new PriorityStage(priorities as TaskPrioritiesService);

    await expect(stage.processItem(ctx, priorityItem)).resolves.toEqual({
      kind: 'created',
      targetId: 'priority-medium-live',
      targetTable: 'task_priorities',
    });

    expect(priorities.create).not.toHaveBeenCalled();
    expect(ctx.entityMap.recordMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'priority',
        sourceId: 'source-priority-medium',
        targetId: 'priority-medium-live',
        status: 'mapped',
      }),
    );
    expect(ctx.log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('no longer visible'),
    );
  });

  it('remaps a stale priority by creating it when no visible key can be adopted', async () => {
    const priorities = makePrioritiesService();
    const ctx = makeCtx({
      status: 'mapped',
      target_id: 'other-space-priority',
    });
    priorities.getAll.mockResolvedValue([]);
    priorities.create.mockResolvedValue({ id: 'priority-medium-new' });
    const stage = new PriorityStage(priorities as TaskPrioritiesService);

    await expect(stage.processItem(ctx, priorityItem)).resolves.toEqual({
      kind: 'created',
      targetId: 'priority-medium-new',
      targetTable: 'task_priorities',
    });

    expect(priorities.create).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ key: 'medium', space_id: SPACE }),
      'user-1',
    );
  });

  it('does not replace a mapped priority when the visibility lookup fails', async () => {
    const priorities = makePrioritiesService();
    const ctx = makeCtx({ status: 'mapped', target_id: 'priority-medium' });
    priorities.getAll.mockRejectedValue(new Error('database unavailable'));
    const stage = new PriorityStage(priorities as TaskPrioritiesService);

    await expect(stage.processItem(ctx, priorityItem)).rejects.toThrow(
      'database unavailable',
    );

    expect(priorities.create).not.toHaveBeenCalled();
    expect(ctx.entityMap.recordMapping).not.toHaveBeenCalled();
  });
});
