/**
 * @fileoverview Unit tests for WorkflowTriggerRegistryService — verifies the
 * cache rebuild semantics, child-fan-out matching, sibling-failure isolation,
 * and the workflow.published rebuild hook.
 * @module src/workflow-engine/workflow-trigger-registry.service.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowTriggerRegistryService } from './workflow-trigger-registry.service';

const ORG = 'org-1';
const PARENT_TASK_ID = 'task-parent';
const PARENT_WORKFLOW_ID = 'wf-parent';
const CHILD_WORKFLOW_ID = 'wf-child';
const PARENT_STATUS_ID = '123e4567-e89b-12d3-a456-426614174010';
const OTHER_STATUS_ID = '123e4567-e89b-12d3-a456-426614174099';
const TRANSITION_A = 'tx-a';
const TRANSITION_B = 'tx-b';
const CHILD_1 = 'child-1';
const CHILD_2 = 'child-2';

function makeUser(): RequestUser {
  return {
    authUserId: 'auth-1',
    userId: 'user-1',
    email: 'u@x.com',
    organizationId: ORG,
    role: 'admin',
    isActive: true,
    memberships: [
      { organizationId: ORG, organizationSlug: 'org-1', role: 'admin' },
    ],
  };
}

/**
 * Build a Supabase admin mock whose `.from('workflow_transitions')...`
 * chain resolves to {@link triggerRows} and whose `.from('tasks')...`
 * chain resolves to {@link childRows}.
 */
function buildSupabaseMock(opts: {
  triggerRows: Array<Record<string, unknown>>;
  childRows: Array<Record<string, unknown>>;
  triggerError?: { message: string } | null;
  childError?: { message: string } | null;
}): {
  admin: SupabaseAdminService;
  from: jest.Mock;
  insertSpy: jest.Mock;
} {
  // Records every workflow_trigger_events insert as (table, values) so tests
  // can assert the persisted outcome without depending on insert ordering.
  const insertSpy = jest.fn();

  const from = jest.fn((table: string) => {
    if (table === 'workflow_transitions') {
      const chain: Record<string, unknown> = {};

      // The registry chains: .select().eq().eq().neq() and awaits the
      // chain. `.contains` is kept on the mock for backwards-compatibility
      // with older revisions; current code path does not call it. Every
      // method but the terminal awaitable returns chain; the awaitable
      // resolves via a `then` shim.
      const self = () => chain;

      chain.select = jest.fn().mockImplementation(self);
      chain.filter = jest.fn().mockImplementation(self);
      chain.contains = jest.fn().mockImplementation(self);
      chain.eq = jest.fn().mockImplementation(self);
      chain.neq = jest.fn().mockImplementation(self);
      chain.then = (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve({
          data: opts.triggerError ? null : opts.triggerRows,
          error: opts.triggerError ?? null,
        }).then(onFulfilled);

      return chain;
    }
    if (table === 'tasks') {
      const chain: Record<string, unknown> = {};
      const self = () => chain;

      chain.select = jest.fn().mockImplementation(self);
      chain.eq = jest.fn().mockImplementation(self);
      chain.then = (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve({
          data: opts.childError ? null : opts.childRows,
          error: opts.childError ?? null,
        }).then(onFulfilled);

      return chain;
    }
    if (table === 'workflow_trigger_events') {
      return {
        insert: (v: Record<string, unknown>) => {
          insertSpy(table, v);

          return Promise.resolve({ data: null, error: null });
        },
      };
    }
    throw new Error(`Unexpected from(${table}) call`);
  });

  const admin = {
    getClient: () => ({ from }),
  } as unknown as SupabaseAdminService;

  return { admin, from, insertSpy };
}

/** Pull just the inserted values recorded by the trigger-event insert spy. */
function insertedRows(insertSpy: jest.Mock): Array<Record<string, unknown>> {
  const calls = insertSpy.mock.calls as Array<
    [string, Record<string, unknown>]
  >;

  return calls.map((call) => call[1]);
}

/** Build a stub engine whose executeTransition is a jest.fn() the test owns. */
function buildEngine(): {
  engine: WorkflowEngineService;
  executeTransition: jest.Mock;
  resolveTransitionByStatusChange: jest.Mock;
} {
  const executeTransition = jest.fn().mockResolvedValue({});
  const resolveTransitionByStatusChange = jest.fn();

  return {
    engine: {
      executeTransition,
      resolveTransitionByStatusChange,
    } as unknown as WorkflowEngineService,
    executeTransition,
    resolveTransitionByStatusChange,
  };
}

describe('WorkflowTriggerRegistryService', () => {
  describe('rebuildCache', () => {
    it('populates the cache from active, non-draft workflows', async () => {
      const { admin } = buildSupabaseMock({
        triggerRows: [
          {
            id: TRANSITION_A,
            workflow_id: CHILD_WORKFLOW_ID,
            triggers: [
              {
                type: 'parent_transitioned',
                parent_status_id: PARENT_STATUS_ID,
              },
            ],
            workflows: {
              id: CHILD_WORKFLOW_ID,
              organization_id: ORG,
              is_active: true,
              is_draft: false,
            },
          },
          {
            id: TRANSITION_B,
            workflow_id: CHILD_WORKFLOW_ID,
            triggers: [
              {
                type: 'parent_transitioned',
                parent_workflow_id: PARENT_WORKFLOW_ID,
              },
              // A non-parent_transitioned entry mixed in must be ignored.
              { type: 'cron', expression: '0 9 * * *' },
            ],
            workflows: {
              id: CHILD_WORKFLOW_ID,
              organization_id: ORG,
              is_active: true,
              is_draft: false,
            },
          },
        ],
        childRows: [],
      });

      const { engine } = buildEngine();
      const svc = new WorkflowTriggerRegistryService(admin, engine);

      await svc.rebuildCache();

      // 2 transitions × 1 parent_transitioned entry each = 2 cache rows.
      // The cron entry on tx-b must be filtered out.
      expect((svc as unknown as { cache: unknown[] }).cache).toHaveLength(2);
      expect((svc as unknown as { cacheLoaded: boolean }).cacheLoaded).toBe(
        true,
      );
    });
  });

  describe('onTaskTransitioned — match', () => {
    it('fires executeTransition for each child when parent_status_id matches', async () => {
      const { admin } = buildSupabaseMock({
        triggerRows: [
          {
            id: TRANSITION_A,
            workflow_id: CHILD_WORKFLOW_ID,
            triggers: [
              {
                type: 'parent_transitioned',
                parent_status_id: PARENT_STATUS_ID,
              },
            ],
            workflows: {
              id: CHILD_WORKFLOW_ID,
              organization_id: ORG,
              is_active: true,
              is_draft: false,
            },
          },
        ],
        childRows: [{ id: CHILD_1 }, { id: CHILD_2 }],
      });

      const { engine, executeTransition } = buildEngine();
      const svc = new WorkflowTriggerRegistryService(admin, engine);

      await svc.rebuildCache();
      await svc.onTaskTransitioned({
        task: {
          id: PARENT_TASK_ID,
          organization_id: ORG,
          workflow_id: PARENT_WORKFLOW_ID,
        },
        fromStatusId: OTHER_STATUS_ID,
        toStatusId: PARENT_STATUS_ID,
        transition: { id: 'parent-tx' },
        user: makeUser(),
      });

      expect(executeTransition).toHaveBeenCalledTimes(2);
      expect(executeTransition).toHaveBeenNthCalledWith(1, {
        taskId: CHILD_1,
        transitionId: TRANSITION_A,
        screenInput: {},
        user: expect.objectContaining({ userId: 'user-1' }) as unknown,
        transitionDepth: 1,
      });
      expect(executeTransition).toHaveBeenNthCalledWith(2, {
        taskId: CHILD_2,
        transitionId: TRANSITION_A,
        screenInput: {},
        user: expect.objectContaining({ userId: 'user-1' }) as unknown,
        transitionDepth: 1,
      });
    });
  });

  describe('onTaskTransitioned — no match', () => {
    it('does not fire when parent_status_id does not match', async () => {
      const { admin } = buildSupabaseMock({
        triggerRows: [
          {
            id: TRANSITION_A,
            workflow_id: CHILD_WORKFLOW_ID,
            triggers: [
              {
                type: 'parent_transitioned',
                parent_status_id: PARENT_STATUS_ID,
              },
            ],
            workflows: {
              id: CHILD_WORKFLOW_ID,
              organization_id: ORG,
              is_active: true,
              is_draft: false,
            },
          },
        ],
        childRows: [{ id: CHILD_1 }],
      });

      const { engine, executeTransition } = buildEngine();
      const svc = new WorkflowTriggerRegistryService(admin, engine);

      await svc.rebuildCache();
      await svc.onTaskTransitioned({
        task: {
          id: PARENT_TASK_ID,
          organization_id: ORG,
          workflow_id: PARENT_WORKFLOW_ID,
        },
        fromStatusId: PARENT_STATUS_ID,
        // Different from parent_status_id in the cached config.
        toStatusId: OTHER_STATUS_ID,
        transition: { id: 'parent-tx' },
        user: makeUser(),
      });

      expect(executeTransition).not.toHaveBeenCalled();
    });
  });

  describe('onTaskTransitioned — sibling isolation', () => {
    it('continues firing siblings when one child transition throws', async () => {
      const { admin } = buildSupabaseMock({
        triggerRows: [
          {
            id: TRANSITION_A,
            workflow_id: CHILD_WORKFLOW_ID,
            triggers: [
              {
                type: 'parent_transitioned',
                parent_status_id: PARENT_STATUS_ID,
              },
            ],
            workflows: {
              id: CHILD_WORKFLOW_ID,
              organization_id: ORG,
              is_active: true,
              is_draft: false,
            },
          },
        ],
        childRows: [{ id: CHILD_1 }, { id: CHILD_2 }],
      });

      const { engine, executeTransition } = buildEngine();

      // First child throws; the registry must still call the second.
      executeTransition
        .mockRejectedValueOnce(new Error('child 1 blew up'))
        .mockResolvedValueOnce({});

      const svc = new WorkflowTriggerRegistryService(admin, engine);

      await svc.rebuildCache();
      await svc.onTaskTransitioned({
        task: {
          id: PARENT_TASK_ID,
          organization_id: ORG,
          workflow_id: PARENT_WORKFLOW_ID,
        },
        fromStatusId: OTHER_STATUS_ID,
        toStatusId: PARENT_STATUS_ID,
        transition: { id: 'parent-tx' },
        user: makeUser(),
      });

      expect(executeTransition).toHaveBeenCalledTimes(2);
      expect(executeTransition).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ taskId: CHILD_2, transitionDepth: 1 }),
      );
    });
  });

  describe('onTaskTransitioned — trigger-event logging', () => {
    const singleParentStatusTrigger = [
      {
        id: TRANSITION_A,
        workflow_id: CHILD_WORKFLOW_ID,
        triggers: [
          {
            type: 'parent_transitioned',
            parent_status_id: PARENT_STATUS_ID,
          },
        ],
        workflows: {
          id: CHILD_WORKFLOW_ID,
          organization_id: ORG,
          is_active: true,
          is_draft: false,
        },
      },
    ];

    const matchingEvent = {
      task: {
        id: PARENT_TASK_ID,
        organization_id: ORG,
        workflow_id: PARENT_WORKFLOW_ID,
      },
      fromStatusId: OTHER_STATUS_ID,
      toStatusId: PARENT_STATUS_ID,
      transition: { id: 'parent-tx' },
      user: makeUser(),
    };

    it('logs fired when a child transition succeeds', async () => {
      const { admin, insertSpy } = buildSupabaseMock({
        triggerRows: singleParentStatusTrigger,
        childRows: [{ id: CHILD_1, space_id: 'space-1' }],
      });

      const { engine } = buildEngine();
      const svc = new WorkflowTriggerRegistryService(admin, engine);

      await svc.rebuildCache();
      await svc.onTaskTransitioned(matchingEvent);

      const rows = insertedRows(insertSpy);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          outcome: 'fired',
          subject_task_id: CHILD_1,
          space_id: 'space-1',
          trigger_type: 'parent_transitioned',
        }),
      );
    });

    it('logs no_op (skip) when the child is not in the from-status', async () => {
      const { admin, insertSpy } = buildSupabaseMock({
        triggerRows: singleParentStatusTrigger,
        childRows: [{ id: CHILD_1, space_id: 'space-1' }],
      });

      const { engine, executeTransition } = buildEngine();

      executeTransition.mockRejectedValueOnce(
        new BadRequestException('Transition not available from current status'),
      );

      const svc = new WorkflowTriggerRegistryService(admin, engine);

      await svc.rebuildCache();
      await svc.onTaskTransitioned(matchingEvent);

      const rows = insertedRows(insertSpy);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({ outcome: 'no_op', subject_task_id: CHILD_1 }),
      );
    });

    it('logs no_op (skip), NOT error, when the child is on a different workflow', async () => {
      const { admin, insertSpy } = buildSupabaseMock({
        triggerRows: singleParentStatusTrigger,
        childRows: [{ id: CHILD_1, space_id: 'space-1' }],
      });

      const { engine, executeTransition } = buildEngine();

      executeTransition.mockRejectedValueOnce(
        new NotFoundException('Transition not found in workflow'),
      );

      const svc = new WorkflowTriggerRegistryService(admin, engine);

      await svc.rebuildCache();
      await svc.onTaskTransitioned(matchingEvent);

      const rows = insertedRows(insertSpy);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({ outcome: 'no_op' }));
    });

    it('logs no_op (skip), NOT error, when a condition blocks the child', async () => {
      const { admin, insertSpy } = buildSupabaseMock({
        triggerRows: singleParentStatusTrigger,
        childRows: [{ id: CHILD_1, space_id: 'space-1' }],
      });

      const { engine, executeTransition } = buildEngine();

      executeTransition.mockRejectedValueOnce(
        new ForbiddenException('Condition failed: parent_status_is'),
      );

      const svc = new WorkflowTriggerRegistryService(admin, engine);

      await svc.rebuildCache();
      await svc.onTaskTransitioned(matchingEvent);

      const rows = insertedRows(insertSpy);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({ outcome: 'no_op' }));
    });

    it('logs error only for a genuinely unexpected failure', async () => {
      const { admin, insertSpy } = buildSupabaseMock({
        triggerRows: singleParentStatusTrigger,
        childRows: [{ id: CHILD_1, space_id: 'space-1' }],
      });

      const { engine, executeTransition } = buildEngine();

      executeTransition.mockRejectedValueOnce(new Error('boom'));

      const svc = new WorkflowTriggerRegistryService(admin, engine);

      await svc.rebuildCache();
      await svc.onTaskTransitioned(matchingEvent);

      const rows = insertedRows(insertSpy);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({ outcome: 'error', message: 'boom' }),
      );
    });

    it('logs no_op (Parent has no child tasks) when the matched parent has no children', async () => {
      const { admin, insertSpy } = buildSupabaseMock({
        triggerRows: singleParentStatusTrigger,
        childRows: [],
      });

      const { engine, executeTransition } = buildEngine();

      const svc = new WorkflowTriggerRegistryService(admin, engine);

      await svc.rebuildCache();
      await svc.onTaskTransitioned(matchingEvent);

      // No children → no transition attempts, but the match is still recorded.
      expect(executeTransition).not.toHaveBeenCalled();

      const rows = insertedRows(insertSpy);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          outcome: 'no_op',
          subject_task_id: null,
          message: 'Parent has no child tasks',
          trigger_type: 'parent_transitioned',
        }),
      );
    });

    const targetTrigger = [
      {
        id: TRANSITION_A,
        workflow_id: CHILD_WORKFLOW_ID,
        triggers: [
          {
            type: 'parent_transitioned',
            parent_status_id: PARENT_STATUS_ID,
            child_target_status_id: 'target-status-1',
          },
        ],
        workflows: {
          id: CHILD_WORKFLOW_ID,
          organization_id: ORG,
          is_active: true,
          is_draft: false,
        },
      },
    ];

    it("with child_target_status_id, resolves the child's OWN transition to the target and fires", async () => {
      const { admin, insertSpy } = buildSupabaseMock({
        triggerRows: targetTrigger,
        childRows: [{ id: CHILD_1, space_id: 'space-1' }],
      });

      const { engine, executeTransition, resolveTransitionByStatusChange } =
        buildEngine();

      resolveTransitionByStatusChange.mockResolvedValue({
        transition: { id: 'child-tx-9' },
      });

      const svc = new WorkflowTriggerRegistryService(admin, engine);

      await svc.rebuildCache();
      await svc.onTaskTransitioned(matchingEvent);

      expect(resolveTransitionByStatusChange).toHaveBeenCalledWith(
        CHILD_1,
        'target-status-1',
        expect.anything(),
      );
      expect(executeTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: CHILD_1,
          transitionId: 'child-tx-9',
        }),
      );

      const rows = insertedRows(insertSpy);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({ outcome: 'fired', subject_task_id: CHILD_1 }),
      );
    });

    it('with child_target_status_id, logs no_op (no transition) without executing', async () => {
      const { admin, insertSpy } = buildSupabaseMock({
        triggerRows: targetTrigger,
        childRows: [{ id: CHILD_1, space_id: 'space-1' }],
      });

      const { engine, executeTransition, resolveTransitionByStatusChange } =
        buildEngine();

      resolveTransitionByStatusChange.mockResolvedValue({ error: 'no_path' });

      const svc = new WorkflowTriggerRegistryService(admin, engine);

      await svc.rebuildCache();
      await svc.onTaskTransitioned(matchingEvent);

      expect(executeTransition).not.toHaveBeenCalled();

      const rows = insertedRows(insertSpy);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          outcome: 'no_op',
          message: 'No transition to the target status',
        }),
      );
    });
  });

  describe('onWorkflowPublished', () => {
    it('triggers a cache rebuild', async () => {
      const { admin } = buildSupabaseMock({
        triggerRows: [],
        childRows: [],
      });

      const { engine } = buildEngine();
      const svc = new WorkflowTriggerRegistryService(admin, engine);
      const rebuildSpy = jest.spyOn(svc, 'rebuildCache');

      await svc.onWorkflowPublished();

      expect(rebuildSpy).toHaveBeenCalledTimes(1);
    });
  });
});
