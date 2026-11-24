/**
 * @fileoverview Regression: linking an existing task into a plan must persist the
 *               schedule sent with it.
 * @module src/plans/plans.linked-item-schedule
 * @author Prince Jadiya
 */

import { PlansService } from './plans.service';

/**
 * `plan_tasks` is a pure join table — plan_id, task_id, item_type, wbs_number,
 * sort_order, colour. There is nowhere in it to put a date or a percentage, so a
 * plan item's schedule can only live on the task row.
 *
 * `addItem` used to honour that only on the branch that CREATES a task. Given a
 * `linked_task_id` it assigned the id and dropped everything else, so the endpoint
 * validated `start_date`/`end_date`/`progress`/`estimated_hours`, answered 201 and
 * persisted none of them — a Gantt embed then drew every linked item at 0% with no
 * bar, and nothing anywhere reported a failure.
 */
describe('PlansService.addItem — linked task schedule', () => {
  const PLAN = 'plan-1';
  const SPACE = 'space-1';
  const TASK = 'task-1';
  const ORG = 'org-1';

  /** Chainable that is also awaitable, so `.update().eq().eq()` resolves. */
  const chain = (result: unknown) => {
    const node: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'lt', 'order', 'limit']) {
      node[method] = jest.fn(() => node);
    }
    node['maybeSingle'] = jest.fn().mockResolvedValue(result);
    node['single'] = jest.fn().mockResolvedValue(result);
    node['then'] = (resolve: (value: unknown) => unknown) => resolve(result);

    return node;
  };

  const makeService = () => {
    const taskUpdate = jest.fn(() => chain({ data: null, error: null }));

    const tasksTable = {
      select: jest.fn(() =>
        chain({ data: { id: TASK, space_id: SPACE }, error: null }),
      ),
      update: taskUpdate,
    };

    const planTasksTable = {
      select: jest.fn(() => chain({ data: null, error: null, count: 0 })),
      insert: jest.fn(() => chain({ data: { id: 'pt-1' }, error: null })),
    };

    const client = {
      from: jest.fn((table: string) => {
        if (table === 'tasks') return tasksTable;
        if (table === 'plan_tasks') return planTasksTable;

        return chain({ data: null, error: null });
      }),
    };

    const service = new PlansService(
      { getClient: () => client } as never,
      {} as never,
      {} as never,
    );

    // Access control and bookkeeping are covered by their own specs.
    jest
      .spyOn(
        service as never as { verifyPlanAccess: unknown },
        'verifyPlanAccess',
      )
      .mockResolvedValue({ id: PLAN, space_id: SPACE } as never);
    jest
      .spyOn(service as never as { recalculateWbs: unknown }, 'recalculateWbs')
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(
        service as never as { logMutationAudit: unknown },
        'logMutationAudit',
      )
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(service as never as { mapItemRow: unknown }, 'mapItemRow')
      .mockReturnValue({ id: 'pt-1' } as never);

    return { service, taskUpdate };
  };

  it('writes the dates, progress and estimate onto the linked task', async () => {
    const { service, taskUpdate } = makeService();

    await service.addItem(PLAN, ORG, 'user-1', {
      linked_task_id: TASK,
      name: 'Gateway API migration',
      start_date: '2026-09-01',
      end_date: '2026-09-30',
      progress: 35,
      estimated_hours: 72,
    } as never);

    expect(taskUpdate).toHaveBeenCalledTimes(1);
    expect(taskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        start_date: '2026-09-01',
        end_date: '2026-09-30',
        due_date: '2026-09-30',
        progress: 35,
        estimated_time: 72 * 60, // hours are stored as minutes
      }),
    );
  });

  it('leaves the task alone when the link carries no schedule', async () => {
    const { service, taskUpdate } = makeService();

    await service.addItem(PLAN, ORG, 'user-1', {
      linked_task_id: TASK,
      name: 'Gateway API migration',
    } as never);

    expect(taskUpdate).not.toHaveBeenCalled();
  });
});
