import { ConflictException, NotFoundException } from '@nestjs/common';

import {
  AgentUndoService,
  deepestFirst,
  withDescendants,
} from './agent-undo.service';

type Row = Record<string, unknown>;

const USER = { userId: 'u1', organizationId: 'org-1' };
const ADMIN = { userId: 'adm', organizationId: 'org-1' };
const RUN = {
  id: 'run-1',
  organization_id: 'org-1',
  conversation_id: 'c1',
  invoker_id: 'u1',
};

const action = (
  id: string,
  ordinal: number,
  kind: string,
  over: Row = {},
): Row => ({
  id,
  run_id: 'run-1',
  organization_id: 'org-1',
  ordinal,
  kind,
  status: 'executed',
  depends_on: null,
  entity_type: kind === 'subtask' ? 'task' : kind,
  entity_id: `e-${id}`,
  target_space_id: 's1',
  executed_at: '2026-11-05T10:00:00Z',
  exec_token: `tok-${id}`,
  ...over,
});

function build(
  actions: Row[],
  over: {
    admin?: boolean;
    run?: Row | null;
    mayDelete?: jest.Mock;
    plans?: Row;
    tasks?: Row;
  } = {},
) {
  const runRow = over.run === undefined ? RUN : over.run;
  const from = (table: string) => {
    const q: Record<string, unknown> = {};
    let org: unknown;
    for (const m of ['select', 'order', 'in']) q[m] = () => q;
    q.eq = (col: string, value: unknown) => {
      if (col === 'organization_id') org = value;
      return q;
    };
    q.maybeSingle = () =>
      Promise.resolve({
        data:
          table === 'agent_runs' && org === RUN.organization_id
            ? runRow
            : table === 'tasks'
              ? {
                  id: 'e-a',
                  key: 'A-T1',
                  summary: 'Robert task',
                  space_id: 's1',
                }
              : null,
        error: null,
      });
    q.then = (done: (r: unknown) => unknown) =>
      Promise.resolve({ data: actions, error: null }).then(done);
    return q;
  };
  const calls: string[] = [];
  const done = (e: string) => ({ deleted: true, blockers: [] as Row[], e });
  const runs = {
    claimUndo: jest.fn((_o: string, _u: string, _a: boolean, ids: string[]) =>
      Promise.resolve(actions.filter((a) => ids.includes(a.id as string))),
    ),
    completeUndo: jest.fn().mockResolvedValue({ completed: true }),
    touchUndo: jest.fn().mockResolvedValue(1),
    undoBlockers: jest.fn().mockResolvedValue([]),
    undoTask: jest.fn(
      (a: { taskId: string }): Promise<unknown> => (
        calls.push(a.taskId),
        Promise.resolve(done(a.taskId))
      ),
    ),
    undoPage: jest.fn(
      (a: { pageId: string }) => (
        calls.push(a.pageId),
        Promise.resolve(done(a.pageId))
      ),
    ),
    undoProcess: jest.fn(
      (a: { processId: string }) => (
        calls.push(a.processId),
        Promise.resolve(done(a.processId))
      ),
    ),
    undoPlan: jest.fn(
      (a: { planId: string }) => (
        calls.push(`plan:${a.planId}`),
        Promise.resolve(done(a.planId))
      ),
    ),
    undoPlanItem: jest.fn(
      (a: { taskId: string }) => (
        calls.push(`item:${a.taskId}`),
        Promise.resolve(done(a.taskId))
      ),
    ),
  };
  const views = {
    announce: jest.fn().mockResolvedValue(undefined),
    viewOne: jest.fn().mockResolvedValue({ id: 'run-1' }),
  };
  const access = {
    getReadable: jest.fn().mockResolvedValue({ conversation: {} }),
  };
  const rules = {
    isTenantAdmin: jest.fn().mockResolvedValue(!!over.admin),
    mayDelete: over.mayDelete ?? jest.fn().mockResolvedValue(true),
  };
  const service = new AgentUndoService(
    { getClient: () => ({ from }) } as never,
    runs as never,
    views as never,
    access as never,
    rules as never,
    over.plans as never,
    over.tasks as never,
  );
  return { service, runs, views, access, rules, calls };
}
const outcomes = (runs: { completeUndo: jest.Mock }) =>
  Object.fromEntries(
    runs.completeUndo.mock.calls.map(([a]) => [
      a.actionId,
      a.reason ?? a.outcome,
    ]),
  );

describe('AgentUndoService', () => {
  describe('plans and plan items (1.22)', () => {
    const plansOf = () => ({
      planOfTask: jest.fn().mockResolvedValue('e-plan'),
      recalculate: jest.fn().mockResolvedValue(undefined),
    });

    it('undoes the items bottom up through the plan item Undo, then the plan, and renumbers once', async () => {
      const plans = plansOf();
      const { service, calls } = build(
        [
          action('plan', 1, 'plan'),
          action('phase', 2, 'plan_item', {
            depends_on: 1,
            entity_type: 'task',
          }),
          action('child', 3, 'plan_item', {
            depends_on: 2,
            entity_type: 'task',
          }),
        ],
        { plans },
      );
      await service.undo(USER as never, 'run-1');
      expect(calls).toEqual(['item:e-child', 'item:e-phase', 'plan:e-plan']);
      expect(plans.recalculate).toHaveBeenCalledTimes(1);
      expect([...(plans.recalculate.mock.calls[0][0] as Set<string>)]).toEqual([
        'e-plan',
      ]);
    });

    it('a blocked item is not renumbered and its plan stays', async () => {
      const plans = plansOf();
      const { service, runs } = build(
        [
          action('plan', 1, 'plan'),
          action('item', 2, 'plan_item', {
            depends_on: 1,
            entity_type: 'task',
          }),
        ],
        {
          plans,
        },
      );
      runs.undoPlanItem.mockResolvedValue({
        deleted: false,
        blockers: [{ code: 'baseline_taken', count: 1, by: null }],
      } as never);
      runs.undoPlan.mockResolvedValue({
        deleted: false,
        blockers: [{ code: 'has_items', count: 1, by: null }],
      } as never);
      await service.undo(USER as never, 'run-1');
      expect(outcomes(runs)).toEqual({
        item: 'baseline_taken',
        plan: 'has_items',
      });
      expect(plans.recalculate).not.toHaveBeenCalled();
    });
  });

  describe('who may press it', () => {
    it('answers 404 to anyone else, not 403', async () => {
      const { service, runs } = build([action('a', 1, 'task')]);
      await expect(
        service.undo(
          { userId: 'u2', organizationId: 'org-1' } as never,
          'run-1',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(runs.claimUndo).not.toHaveBeenCalled();
    });

    it('reads the run in the tenant of the person pressing, never by id alone', async () => {
      const { service, runs } = build([action('a', 1, 'task')], {
        admin: true,
      });
      await expect(
        service.undo(
          { userId: 'adm', organizationId: 'org-9' } as never,
          'run-1',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(runs.claimUndo).not.toHaveBeenCalled();
    });

    it('answers 404 for a run of another tenant', async () => {
      const { service, runs } = build([action('a', 1, 'task')], { run: null });
      await expect(service.undo(USER as never, 'run-9')).rejects.toThrow(
        NotFoundException,
      );
      expect(runs.claimUndo).not.toHaveBeenCalled();
    });

    it('lets a tenant admin who is in the conversation, as themselves', async () => {
      const { service, runs } = build([action('a', 1, 'task')], {
        admin: true,
      });
      await service.undo(ADMIN as never, 'run-1');
      expect(runs.claimUndo).toHaveBeenCalledWith('org-1', 'adm', true, ['a']);
      expect(runs.undoTask.mock.calls[0][0]).toMatchObject({ actorId: 'adm' });
      expect(runs.completeUndo.mock.calls[0][0]).toMatchObject({
        actorId: 'adm',
        outcome: 'undone',
      });
    });

    it('answers 404 to a tenant admin outside the conversation', async () => {
      const { service, access, runs } = build([action('a', 1, 'task')], {
        admin: true,
      });
      access.getReadable.mockRejectedValue(new NotFoundException());
      await expect(service.undo(ADMIN as never, 'run-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(runs.claimUndo).not.toHaveBeenCalled();
    });

    it('blocks whoever has no delete permission right now, and deletes nothing', async () => {
      const { service, runs } = build([action('a', 1, 'task')], {
        mayDelete: jest.fn().mockResolvedValue(false),
      });
      await service.undo(USER as never, 'run-1');
      expect(runs.undoTask).not.toHaveBeenCalled();
      expect(outcomes(runs)).toEqual({ a: 'no_permission' });
    });
  });

  describe('what it claims', () => {
    it('leaves spaces and member changes alone in a batch', async () => {
      const { service, runs } = build([
        action('sp', 1, 'space'),
        action('m', 2, 'space_member_add'),
        action('t', 3, 'task'),
      ]);
      await service.undo(USER as never, 'run-1');
      expect(runs.claimUndo.mock.calls[0][3]).toEqual(['t']);
    });

    it('answers 409 with the fresh card when nothing could be claimed: double click, expired, second tab', async () => {
      const { service, runs, views } = build([action('a', 1, 'task')]);
      runs.claimUndo.mockResolvedValue([]);
      const err = await service
        .undo(USER as never, 'run-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'undo_changed',
        data: { run: { id: 'run-1' } },
      });
      expect(views.viewOne).toHaveBeenCalled();
    });

    it('answers 409 when only a space was pressed', async () => {
      const { service, runs } = build([action('sp', 1, 'space')]);
      await expect(
        service.undo(USER as never, 'run-1', ['sp']),
      ).rejects.toThrow(ConflictException);
      expect(runs.claimUndo).not.toHaveBeenCalled();
    });
  });

  describe('the order and the outcome', () => {
    it('runs each kind through its own function, children before parents', async () => {
      const { service, calls, runs } = build([
        action('p1', 1, 'process'),
        action('p2', 2, 'process', { depends_on: 1 }),
        action('t', 3, 'task', { depends_on: 2 }),
        action('s', 4, 'subtask', { depends_on: 3 }),
        action('w', 5, 'wiki_page', { depends_on: 1 }),
      ]);
      await service.undo(USER as never, 'run-1');
      expect(calls).toEqual(['e-s', 'e-t', 'e-w', 'e-p2', 'e-p1']);
      expect(runs.completeUndo).toHaveBeenCalledTimes(5);
    });

    it('a batch goes as far as it can and says which stayed and why', async () => {
      const { service, runs } = build([
        action('p', 1, 'task'),
        action('k', 2, 'subtask', { depends_on: 1 }),
        action('free', 3, 'task'),
      ]);
      runs.undoTask.mockImplementation((a: { taskId: string }) =>
        Promise.resolve(
          a.taskId === 'e-k'
            ? {
                deleted: false,
                blockers: [{ code: 'has_comments', count: 1, by: null }],
              }
            : a.taskId === 'e-p'
              ? {
                  deleted: false,
                  blockers: [{ code: 'has_subtasks', count: 1, by: null }],
                }
              : { deleted: true, blockers: [] },
        ),
      );
      await service.undo(USER as never, 'run-1');
      expect(outcomes(runs)).toEqual({
        k: 'has_comments',
        p: 'has_subtasks',
        free: 'undone',
      });
      const blocked = runs.completeUndo.mock.calls
        .map(([a]) => a)
        .find((a) => a.actionId === 'k');
      expect(blocked).toMatchObject({
        outcome: 'blocked',
        reasonParams: { count: 1 },
      });
    });

    it('a failed item does not hide the others', async () => {
      const { service, runs } = build([
        action('a', 1, 'task'),
        action('b', 2, 'task'),
      ]);
      runs.undoTask.mockImplementation((a: { taskId: string }) =>
        a.taskId === 'e-b'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ deleted: true, blockers: [] }),
      );
      await service.undo(USER as never, 'run-1');
      expect(outcomes(runs)).toEqual({ a: 'undone', b: 'undo_failed' });
    });

    it('calls an object someone deleted gone, without an error', async () => {
      const { service, runs } = build([action('a', 1, 'task')]);
      runs.undoTask.mockRejectedValue(
        new NotFoundException('chat: task not found'),
      );
      await expect(service.undo(USER as never, 'run-1')).resolves.toBeDefined();
      expect(outcomes(runs)).toEqual({ a: 'gone' });
    });

    it('a child that stays keeps its parent: deleting the parent would take the child along', async () => {
      // Children go first: the child is refused (no delete right), so the parent must not go.
      const mayDelete = jest.fn((_u: unknown, a: { id: string }) =>
        Promise.resolve(a.id !== 'child'),
      );
      const { service, runs } = build(
        [
          action('parent', 1, 'task'),
          action('child', 2, 'subtask', { depends_on: 1 }),
          action('other', 3, 'task'),
        ],
        { mayDelete },
      );
      await service.undo(USER as never, 'run-1');
      expect(runs.undoTask.mock.calls.map((c) => c[0].taskId)).toEqual([
        'e-other',
      ]);
      const outcome = (id: string) =>
        runs.completeUndo.mock.calls.find((c) => c[0].actionId === id)?.[0];
      expect(outcome('child')).toMatchObject({
        outcome: 'blocked',
        reason: 'no_permission',
      });
      expect(outcome('parent')).toMatchObject({
        outcome: 'blocked',
        reason: 'child_kept',
      });
      expect(outcome('other')).toMatchObject({ outcome: 'undone' });
    });

    it('a child whose Undo failed keeps its parent too; a gone child does not', async () => {
      const { service, runs } = build([
        action('parent', 1, 'task'),
        action('child', 2, 'subtask', { depends_on: 1 }),
      ]);
      runs.undoTask.mockImplementation((a: { taskId: string }) =>
        a.taskId === 'e-child'
          ? Promise.reject(new Error('connection reset'))
          : Promise.resolve({ deleted: true, blockers: [] }),
      );
      await service.undo(USER as never, 'run-1');
      expect(runs.undoTask).toHaveBeenCalledTimes(1);
      expect(
        runs.completeUndo.mock.calls.find(
          (c) => c[0].actionId === 'parent',
        )?.[0],
      ).toMatchObject({ outcome: 'blocked', reason: 'child_kept' });

      const gone = build([
        action('parent', 1, 'task'),
        action('child', 2, 'subtask', { depends_on: 1 }),
      ]);
      gone.runs.undoTask.mockImplementation((a: { taskId: string }) =>
        a.taskId === 'e-child'
          ? Promise.reject(new NotFoundException())
          : Promise.resolve({ deleted: true, blockers: [] }),
      );
      await gone.service.undo(USER as never, 'run-1');
      expect(gone.runs.undoTask).toHaveBeenCalledTimes(2);
    });

    it('a deleted task gets what a person delete does after it: files, event, audit (audit 2026-11-10)', async () => {
      const tasks = {
        afterCascadeDelete: jest.fn().mockResolvedValue(undefined),
      };
      const { service, runs } = build(
        [action('a', 1, 'task'), action('b', 2, 'task')],
        { tasks },
      );
      runs.undoTask.mockImplementation((x: { taskId: string }) =>
        Promise.resolve(
          x.taskId === 'e-a'
            ? { deleted: true, blockers: [], storage_paths: ['org/a.pdf'] }
            : {
                deleted: false,
                blockers: [{ code: 'has_comments', count: 1 }],
              },
        ),
      );
      await service.undo(USER as never, 'run-1');
      expect(tasks.afterCascadeDelete).toHaveBeenCalledTimes(1);
      expect(tasks.afterCascadeDelete).toHaveBeenCalledWith(
        'org-1',
        { id: 'e-a', key: 'A-T1', summary: 'Robert task', space_id: 's1' },
        'u1',
        expect.objectContaining({ storage_paths: ['org/a.pdf'] }),
      );
    });

    it('a card still open under a parent that was undone is cancelled, not stuck (audit 2026-11-10)', async () => {
      const { service, runs } = build([
        action('parent', 1, 'task'),
        action('child', 2, 'subtask', { depends_on: 1, status: 'proposed' }),
        action('grandchild', 3, 'subtask', {
          depends_on: 2,
          status: 'proposed',
        }),
        action('other', 4, 'task', { status: 'proposed' }),
      ]);
      (runs as Record<string, jest.Mock>).cancelActions = jest
        .fn()
        .mockResolvedValue(2);
      await service.undo(USER as never, 'run-1');
      expect(
        (runs as Record<string, jest.Mock>).cancelActions,
      ).toHaveBeenCalledWith('org-1', 'parent_undone', {
        actionIds: ['child', 'grandchild'],
      });
    });

    it('keeps its claim fresh before each item, so the sweep never takes over live work (audit 2026-11-10)', async () => {
      const { service, runs } = build([
        action('a', 1, 'task'),
        action('b', 2, 'task'),
      ]);
      await service.undo(USER as never, 'run-1');
      const touches = (runs as Record<string, jest.Mock>).touchUndo.mock.calls;
      expect(touches).toEqual([
        ['org-1', ['b', 'a'], ['tok-b', 'tok-a']],
        ['org-1', ['a'], ['tok-a']],
      ]);
    });

    it('a link Undo takes only the link: never the task, no after-delete steps, its own plan renumbered (1.22.1)', async () => {
      const recalculate = jest.fn().mockResolvedValue(undefined);
      const tasks = { afterCascadeDelete: jest.fn() };
      const { service, runs } = build([action('lnk', 1, 'plan_link', { entity_type: 'plan_link' })], {
        tasks,
        plans: { recalculate, planOfTask: jest.fn() },
      });
      (runs as Record<string, jest.Mock>).undoPlanLink = jest.fn().mockResolvedValue({ deleted: true, blockers: [], plan_id: 'plan-x' });
      await service.undo(USER as never, 'run-1');
      expect((runs as Record<string, jest.Mock>).undoPlanLink).toHaveBeenCalledWith(expect.objectContaining({ linkId: 'e-lnk' }));
      expect(runs.undoTask).not.toHaveBeenCalled();
      expect(tasks.afterCascadeDelete).not.toHaveBeenCalled();
      expect(recalculate).toHaveBeenCalledWith(new Set(['plan-x']));
    });

    it('checks permission again for each item', async () => {
      const mayDelete = jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const { service, runs } = build(
        [action('a', 1, 'task'), action('b', 2, 'task')],
        { mayDelete },
      );
      await service.undo(USER as never, 'run-1');
      expect(mayDelete).toHaveBeenCalledTimes(2);
      expect(runs.undoTask).toHaveBeenCalledTimes(1);
    });

    it('tells every open card and answers with the fresh run', async () => {
      const { service, views } = build([action('a', 1, 'task')]);
      await expect(service.undo(USER as never, 'run-1')).resolves.toEqual({
        id: 'run-1',
      });
      expect(views.announce).toHaveBeenCalledWith('run-1');
    });
  });

  describe('pressing one card', () => {
    const tree = () => [
      action('p', 1, 'task'),
      action('k', 2, 'subtask', { depends_on: 1 }),
      action('other', 3, 'task'),
    ];

    it('takes its children of the same run along', async () => {
      const { service, runs, calls } = build(tree());
      await service.undo(USER as never, 'run-1', ['p']);
      expect(runs.claimUndo.mock.calls[0][3].sort()).toEqual(['k', 'p']);
      expect(calls).toEqual(['e-k', 'e-p']);
    });

    it('touches nothing in the tree when anything in it is blocked', async () => {
      const { service, runs } = build(tree());
      runs.undoBlockers.mockResolvedValue([
        { code: 'has_subtasks', count: 1, by: null },
      ]);
      await service.undo(USER as never, 'run-1', ['p']);
      expect(runs.undoTask).not.toHaveBeenCalled();
      expect(outcomes(runs)).toEqual({
        p: 'has_subtasks',
        k: 'parent_blocked',
      });
    });

    it('a child alone goes on its own', async () => {
      const { service, runs, calls } = build(tree());
      await service.undo(USER as never, 'run-1', ['k']);
      expect(runs.claimUndo.mock.calls[0][3]).toEqual(['k']);
      expect(calls).toEqual(['e-k']);
    });
  });

  describe('helpers', () => {
    it('withDescendants follows the whole chain, and only open ones', () => {
      const all = [
        action('a', 1, 'process'),
        action('b', 2, 'process', { depends_on: 1 }),
        action('c', 3, 'task', { depends_on: 2 }),
        action('d', 4, 'task', { depends_on: 3, status: 'undone' }),
      ] as never[];
      expect(
        withDescendants([all[0]], all).map((x: { id: string }) => x.id),
      ).toEqual(['a', 'b', 'c']);
    });

    it('deepestFirst does not depend on the card order', () => {
      const all = [
        action('c', 1, 'task', { depends_on: 3 }),
        action('b', 2, 'task'),
        action('a', 3, 'task', { depends_on: 2 }),
      ] as never[];
      expect(deepestFirst(all, all).map((x: { id: string }) => x.id)).toEqual([
        'c',
        'a',
        'b',
      ]);
    });
  });
});
