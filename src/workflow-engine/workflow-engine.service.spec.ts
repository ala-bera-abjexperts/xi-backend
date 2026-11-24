/**
 * @fileoverview Unit tests for WorkflowEngineService — covers the 10 documented
 * scenarios from Phase B+C+D+E:
 *   1. Happy path — getAvailableTransitions filters by condition results.
 *   2. Condition fails — transition excluded from output.
 *   3. Validator fails — executeTransition throws UnprocessableEntityException.
 *   4. Sync post-function throws — compensation reverts status; error rethrown.
 *   5. Async post-function (send_notification) — succeeds + audit-traces.
 *   6. Concurrent execution — stale expectedVersion → 409 ConflictException.
 *   7. Idempotency — same execution_id returns cached row without re-running.
 *   8. resolveTransitionByStatusChange — 0 / 1 / N candidate paths.
 *   9. runInitialPostFunctions — invokes all post-fns in order.
 *  10. Recursion depth guard — transitionDepth=2 raises BadRequestException.
 *
 * @module src/workflow-engine/workflow-engine.service.spec
 * @author Rajbha Manek
 */

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';

import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../permissions/permissions.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type {
  WorkflowAssignment,
  WorkflowAssignmentsService,
} from '../workflow-assignments/workflow-assignments.service';
import type { WorkflowOutboxService } from '../workflow-outbox/workflow-outbox.service';
import type { WatchersService } from '../watchers/watchers.service';
import type { HandlerRegistryService } from './handlers/handler-registry.service';
import type {
  IConditionHandler,
  IPostFunctionHandler,
  IValidatorHandler,
} from './handlers/handler.types';
import { FieldRequiredValidator } from './handlers/validators/field-required.validator';
import { TemplatingService } from './templating/expand';
import { WorkflowEngineService } from './workflow-engine.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const TASK_ID = 'task-1';
const WF_ID = 'wf-1';
const TRANSITION_ID = 'tx-1';
const FROM_STATUS = 'status-from';
const TO_STATUS = 'status-to';
const FROM_NODE = 'node-from';
const TO_NODE = 'node-to';

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

function makeTask(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: TASK_ID,
    organization_id: ORG,
    space_id: SPACE,
    key: 'TASK-1',
    summary: 'Test task',
    status: 'open',
    status_id: FROM_STATUS,
    priority: 'medium',
    assigned_to: null,
    task_type_id: 'level-1',
    version: 3,
    updated_at: '2026-09-05T12:00:00.000Z',
    completed_at: null,
    custom_field_values: {},
    ...overrides,
  };
}

function makeWorkflow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: WF_ID,
    organization_id: ORG,
    space_id: SPACE,
    name: 'Default',
    version: 1,
    initial_status_id: FROM_STATUS,
    is_active: true,
    is_draft: false,
    ...overrides,
  };
}

function makeAssignment(): WorkflowAssignment {
  return {
    id: 'asgn-1',
    organization_id: ORG,
    space_id: SPACE,
    task_type_level_id: 'level-1',
    workflow_id: WF_ID,
    is_default: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

interface TableHandler {
  (chain: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Build a flexible mock Supabase client. Tables are mapped to handlers that
 * accept a chain object and return it after recording the calls + setting a
 * terminal `then`. Each test wires its own table map.
 */
function buildMockClient(opts: {
  tables: Record<string, TableHandler>;
  rpcs?: Record<string, jest.Mock>;
}) {
  const from = jest.fn((tableName: string) => {
    const handler = opts.tables[tableName];

    if (!handler) {
      throw new Error(`Unexpected from(${tableName}) call`);
    }
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.contains = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.upsert = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.maybeSingle = jest.fn();
    chain.single = jest.fn();
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(onFulfilled);

    return handler(chain);
  });

  const rpc = jest.fn((name: string, args: unknown) => {
    const fn = opts.rpcs?.[name];

    if (!fn) {
      const values = args as Record<string, unknown>;
      if (name === 'sla_begin_workflow')
        return Promise.resolve({
          data: { token: 'operation-token' },
          error: null,
        });
      if (name === 'sla_write_workflow_task') {
        const chain = from('tasks') as any;
        return chain
          .update(values.p_patch)
          .eq('id', values.p_task_id)
          .eq('version', 3)
          .select()
          .single();
      }
      if (name === 'sla_finish_workflow')
        return Promise.resolve({ data: true, error: null });
      return Promise.resolve({ data: null, error: null });
    }

    return fn(args);
  });

  return { from, rpc };
}

/**
 * Build a graph mock returning standard {nodes, transitions, sources, workflow}.
 * Each table responds with the data list provided in `tableData`.
 */
function buildGraphTables(
  workflow: Record<string, unknown> | null,
  nodes: Array<Record<string, unknown>>,
  transitions: Array<Record<string, unknown>>,
  sources: Array<Record<string, unknown>>,
  task: Record<string, unknown> | null = null,
  decisionBranches: Array<Record<string, unknown>> = [],
  auditRows: Array<Record<string, unknown>> = [],
  taskUpdateResult?: { data: unknown; error: unknown },
  taskUpdateChain?: Record<string, unknown>,
  taskStatus: Record<string, unknown> = {
    key: 'in_progress',
    is_completed: false,
  },
  taskReadResult?: { data: unknown; error: unknown },
): Record<string, TableHandler> {
  return {
    tasks: (chain) => {
      // tasks may be queried for read (maybeSingle) or update (select-single).
      chain.maybeSingle = jest
        .fn()
        .mockResolvedValue(
          taskReadResult ??
            (taskUpdateResult
              ? { data: taskUpdateResult.data, error: null }
              : { data: task, error: null }),
        );
      chain.single = jest
        .fn()
        .mockResolvedValue(taskUpdateResult ?? { data: task, error: null });
      chain.then = (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(onFulfilled);
      if (taskUpdateChain) {
        Object.assign(chain, taskUpdateChain);
      }

      return chain;
    },
    workflows: (chain) => {
      chain.maybeSingle = jest
        .fn()
        .mockResolvedValue({ data: workflow, error: null });

      return chain;
    },
    workflow_nodes: (chain) => {
      chain.then = (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve({ data: nodes, error: null }).then(onFulfilled);
      chain.maybeSingle = jest.fn().mockImplementation(() => {
        // For single-node lookups (decision target resolution), use the last
        // configured eq() id to find the node.
        return Promise.resolve({ data: nodes[0] ?? null, error: null });
      });

      return chain;
    },
    workflow_transitions: (chain) => {
      chain.then = (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve({ data: transitions, error: null }).then(onFulfilled);

      return chain;
    },
    workflow_transition_sources: (chain) => {
      chain.then = (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve({ data: sources, error: null }).then(onFulfilled);

      return chain;
    },
    task_statuses: (chain) => {
      chain.maybeSingle = jest
        .fn()
        .mockResolvedValue({ data: taskStatus, error: null });

      return chain;
    },
    workflow_decision_branches: (chain) => {
      chain.then = (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve({ data: decisionBranches, error: null }).then(
          onFulfilled,
        );

      return chain;
    },
    audit_logs: (chain) => {
      // Idempotency lookup chain returns the first audit row if any.
      chain.maybeSingle = jest
        .fn()
        .mockResolvedValue({ data: auditRows[0] ?? null, error: null });

      return chain;
    },
  };
}

describe('WorkflowEngineService', () => {
  let assignments: jest.Mocked<WorkflowAssignmentsService>;
  let auditLogs: jest.Mocked<AuditLogsService>;
  let automationOutbox: jest.Mocked<AutomationEventOutboxService>;
  let outbox: jest.Mocked<WorkflowOutboxService>;
  let eventEmitter: jest.Mocked<EventEmitter2>;
  let permissionsService: jest.Mocked<PermissionsService>;
  let watchersService: { notifyTaskWatchers: jest.Mock };
  let registry: HandlerRegistryService;
  let registryGet: jest.Mock;

  beforeEach(() => {
    assignments = {
      findActiveAssignmentForType: jest
        .fn()
        .mockResolvedValue(makeAssignment()),
    } as unknown as jest.Mocked<WorkflowAssignmentsService>;

    auditLogs = {
      logAction: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogsService>;

    automationOutbox = {
      emitTaskStatusChanged: jest.fn(),
      // Plain object literal, so a missing key is a TypeError at the call site, not a silent
      // no-op — every success-path test would fail without this.
      emitWorkflowStatusReached: jest.fn(),
    } as unknown as jest.Mocked<AutomationEventOutboxService>;

    outbox = {
      enqueue: jest.fn().mockResolvedValue({ id: 'outbox-1' }),
    } as unknown as jest.Mocked<WorkflowOutboxService>;

    eventEmitter = {
      emit: jest.fn(),
    } as unknown as jest.Mocked<EventEmitter2>;

    permissionsService = {
      getUserEffectivePermissions: jest.fn().mockResolvedValue({
        user_id: 'user-1',
        base_role: 'admin',
        custom_roles: [],
        groups: [],
        effective_permissions: {},
      }),
      getUserSpacePermissions: jest.fn().mockResolvedValue({
        isMember: true,
        spaceRole: 'admin',
        globalRole: 'admin',
        permissions: {},
      }),
    } as unknown as jest.Mocked<PermissionsService>;
    watchersService = { notifyTaskWatchers: jest.fn() };

    registryGet = jest.fn();
    registry = {
      get: registryGet,
      getAll: jest.fn().mockReturnValue([]),
    } as unknown as HandlerRegistryService;
  });

  function buildEngine(supaClient: {
    from: jest.Mock;
    rpc: jest.Mock;
  }): WorkflowEngineService {
    const supa = {
      getClient: () => supaClient,
    } as unknown as SupabaseAdminService;

    return new WorkflowEngineService(
      supa,
      registry,
      new TemplatingService(),
      outbox,
      automationOutbox,
      assignments,
      auditLogs,
      eventEmitter,
      permissionsService,
      watchersService as unknown as WatchersService,
    );
  }

  // -----------------------------------------------------------------
  // 1. Happy path — getAvailableTransitions filters by condition results
  // -----------------------------------------------------------------
  describe('getAvailableTransitions — happy path', () => {
    it('returns transitions whose conditions all evaluate true', async () => {
      const trueCondition: IConditionHandler = {
        type: 'user_in_role',
        phase: 'condition',
        schema: { safeParse: jest.fn() } as never,
        evaluate: jest.fn().mockResolvedValue(true),
        findReferences: jest.fn().mockReturnValue([]),
      };

      registryGet.mockImplementation((phase: string, type: string) =>
        phase === 'condition' && type === 'user_in_role'
          ? trueCondition
          : undefined,
      );

      const client = buildMockClient({
        tables: buildGraphTables(
          makeWorkflow(),
          [
            {
              id: FROM_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: FROM_STATUS,
            },
            {
              id: TO_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: TO_STATUS,
            },
          ],
          [
            {
              id: TRANSITION_ID,
              workflow_id: WF_ID,
              name: 'Approve',
              kind: 'regular',
              to_node_id: TO_NODE,
              screen_field_group_id: null,
              conditions: [{ type: 'user_in_role', role_id: 'r1' }],
              validators: [],
              post_functions: [],
              triggers: [],
              sort_order: 0,
            },
          ],
          [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
          makeTask(),
        ),
      });

      const engine = buildEngine(client);
      const result = await engine.getAvailableTransitions(TASK_ID, makeUser());

      expect(result.workflow_assigned).toBe(true);
      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0].transition.id).toBe(TRANSITION_ID);
      expect(result.transitions[0].has_screen).toBe(false);
      expect(trueCondition.evaluate).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------
  // Status KEY-tolerant source matching (org-wide vs space-scoped duplication)
  // -----------------------------------------------------------------
  describe('getAvailableTransitions — status key fallback (scope duplication)', () => {
    // Graph whose OPEN source node references an ORG-WIDE status id, while the
    // task carries a SPACE-scoped status of the SAME key. Overrides the
    // task_statuses handler so loadWorkflowGraph resolves node keys via `.in`.
    function buildScopeMismatchClient(task: Record<string, unknown>) {
      const tables = buildGraphTables(
        makeWorkflow(),
        [
          {
            id: FROM_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: 'org-open',
          },
          {
            id: TO_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: 'org-in-progress',
          },
        ],
        [
          {
            id: TRANSITION_ID,
            workflow_id: WF_ID,
            name: 'Move to In Progress',
            kind: 'regular',
            to_node_id: TO_NODE,
            screen_field_group_id: null,
            conditions: [],
            validators: [],
            post_functions: [],
            triggers: [],
            sort_order: 0,
          },
        ],
        [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
        task,
      );

      // The task's own status key is resolved by id (enrichStatusFields), so
      // answer per queried id rather than one fixed key.
      const keyById: Record<string, string> = {
        'space-open': 'open',
        'space-archived': 'archived',
      };

      tables.task_statuses = (chain) => {
        let queriedId: string | undefined;

        chain.eq = jest.fn((column: string, value: string) => {
          if (column === 'id') queriedId = value;

          return chain;
        });
        chain.maybeSingle = jest.fn().mockImplementation(() =>
          Promise.resolve({
            data:
              queriedId && keyById[queriedId]
                ? { key: keyById[queriedId], is_completed: false }
                : null,
            error: null,
          }),
        );
        chain.then = (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve({
            data: [
              { id: 'org-open', key: 'open' },
              { id: 'org-in-progress', key: 'in_progress' },
            ],
            error: null,
          }).then(onFulfilled);

        return chain;
      };

      return buildMockClient({ tables });
    }

    it('matches a SPACE-scoped task status to the ORG-WIDE node of the same key', async () => {
      // task on space-scoped "open"; node OPEN references org-wide "open".
      const task = makeTask({ status: 'open', status_id: 'space-open' });
      const engine = buildEngine(buildScopeMismatchClient(task));

      const result = await engine.getAvailableTransitions(TASK_ID, makeUser());

      expect(result.workflow_assigned).toBe(true);
      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0].transition.id).toBe(TRANSITION_ID);
    });

    it('matches when status_id is null but the status text key equals the node key', async () => {
      const task = makeTask({ status: 'open', status_id: null });
      const engine = buildEngine(buildScopeMismatchClient(task));

      const result = await engine.getAvailableTransitions(TASK_ID, makeUser());

      expect(result.transitions).toHaveLength(1);
    });

    it('does NOT match when neither id nor key correspond to any node (no false positive)', async () => {
      const task = makeTask({
        status: 'archived',
        status_id: 'space-archived',
      });
      const engine = buildEngine(buildScopeMismatchClient(task));

      const result = await engine.getAvailableTransitions(TASK_ID, makeUser());

      expect(result.workflow_assigned).toBe(true);
      expect(result.transitions).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------
  // XE-T588: source matching uses the REAL status key, not the legacy
  // `status` text bucket (abgelehnt → 'done', backlog → 'open').
  // -----------------------------------------------------------------
  describe('source matching — real status key vs legacy status text (XE-T588)', () => {
    // Service Request shape: Done → Geschlossen (regular), Abgelehnt has no
    // outgoing transition, plus one global → Obsolete. Also Backlog and Open
    // nodes with one outgoing transition each.
    const keyById: Record<string, string> = {
      'st-done': 'done',
      'st-abgelehnt': 'abgelehnt',
      'st-geschlossen': 'geschlossen',
      'st-obsolete': 'obsolete',
      'st-backlog': 'backlog',
      'st-open': 'open',
    };
    const statusNode = (id: string, statusId: string) => ({
      id,
      workflow_id: WF_ID,
      kind: 'status',
      status_id: statusId,
    });
    const transition = (id: string, kind: string, toNodeId: string) => ({
      id,
      workflow_id: WF_ID,
      name: id,
      kind,
      to_node_id: toNodeId,
      screen_field_group_id: null,
      conditions: [],
      validators: [],
      post_functions: [],
      triggers: [],
      sort_order: 0,
    });

    function buildRealKeyClient(task: Record<string, unknown>) {
      const tables = buildGraphTables(
        makeWorkflow(),
        [
          statusNode('n-done', 'st-done'),
          statusNode('n-abgelehnt', 'st-abgelehnt'),
          statusNode('n-geschlossen', 'st-geschlossen'),
          statusNode('n-obsolete', 'st-obsolete'),
          statusNode('n-backlog', 'st-backlog'),
          statusNode('n-open', 'st-open'),
        ],
        [
          transition('tx-close', 'regular', 'n-geschlossen'),
          transition('tx-obsolete', 'global', 'n-obsolete'),
          transition('tx-from-backlog', 'regular', 'n-done'),
          transition('tx-from-open', 'regular', 'n-abgelehnt'),
        ],
        [
          { transition_id: 'tx-close', from_node_id: 'n-done' },
          { transition_id: 'tx-from-backlog', from_node_id: 'n-backlog' },
          { transition_id: 'tx-from-open', from_node_id: 'n-open' },
        ],
        task,
      );

      tables.task_statuses = (chain) => {
        let queriedId: string | undefined;

        chain.eq = jest.fn((column: string, value: string) => {
          if (column === 'id') queriedId = value;

          return chain;
        });
        chain.maybeSingle = jest.fn().mockImplementation(() =>
          Promise.resolve({
            data:
              queriedId && keyById[queriedId]
                ? { key: keyById[queriedId], is_completed: false }
                : null,
            error: null,
          }),
        );
        chain.then = (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve({
            data: Object.entries(keyById).map(([id, key]) => ({ id, key })),
            error: null,
          }).then(onFulfilled);

        return chain;
      };

      return buildMockClient({
        tables,
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: task, error: null }),
        },
      });
    }

    const ids = (r: { transitions: Array<{ transition: { id: string } }> }) =>
      r.transitions.map((t) => t.transition.id).sort();

    it('offers no Done transitions to a task in an end status whose legacy text is "done"', async () => {
      const task = makeTask({ status: 'done', status_id: 'st-abgelehnt' });
      const engine = buildEngine(buildRealKeyClient(task));

      const result = await engine.getAvailableTransitions(TASK_ID, makeUser());

      expect(result.workflow_assigned).toBe(true);
      // Only the global transition stays available from an end status.
      expect(ids(result)).toEqual(['tx-obsolete']);
    });

    it('still offers the Done node transitions to a task really in Done', async () => {
      const task = makeTask({ status: 'done', status_id: 'st-done' });
      const engine = buildEngine(buildRealKeyClient(task));

      const result = await engine.getAvailableTransitions(TASK_ID, makeUser());

      expect(ids(result)).toEqual(['tx-close', 'tx-obsolete']);
    });

    it('offers only the Backlog node transitions to a backlog task whose legacy text is "open"', async () => {
      const task = makeTask({ status: 'open', status_id: 'st-backlog' });
      const engine = buildEngine(buildRealKeyClient(task));

      const result = await engine.getAvailableTransitions(TASK_ID, makeUser());

      expect(ids(result)).toEqual(['tx-from-backlog', 'tx-obsolete']);
    });

    it('matches by legacy status text only when status_id is null', async () => {
      const task = makeTask({ status: 'done', status_id: null });
      const engine = buildEngine(buildRealKeyClient(task));

      const result = await engine.getAvailableTransitions(TASK_ID, makeUser());

      expect(ids(result)).toEqual(['tx-close', 'tx-obsolete']);
    });

    it('matches nothing but globals when the status key cannot be resolved', async () => {
      const task = makeTask({ status: 'done', status_id: 'st-unknown' });
      const engine = buildEngine(buildRealKeyClient(task));

      const result = await engine.getAvailableTransitions(TASK_ID, makeUser());

      expect(ids(result)).toEqual(['tx-obsolete']);
    });

    it('resolveTransitionByStatusChange returns no_path from an end status', async () => {
      const task = makeTask({ status: 'done', status_id: 'st-abgelehnt' });
      const engine = buildEngine(buildRealKeyClient(task));

      const result = await engine.resolveTransitionByStatusChange(
        TASK_ID,
        'st-geschlossen',
        makeUser(),
      );

      expect(result).toEqual({ error: 'no_path' });
    });

    it('executeTransition refuses another status node transition from an end status', async () => {
      const task = makeTask({ status: 'done', status_id: 'st-abgelehnt' });
      const engine = buildEngine(buildRealKeyClient(task));

      await expect(
        engine.executeTransition({
          taskId: TASK_ID,
          transitionId: 'tx-close',
          screenInput: {},
          user: makeUser(),
        }),
      ).rejects.toThrow('Transition not available from current status');
    });
  });

  // -----------------------------------------------------------------
  // 2. Condition fails — transition NOT in output
  // -----------------------------------------------------------------
  describe('getAvailableTransitions — condition fails', () => {
    it('returns a condition-blocked transition as can_execute:false with a reason', async () => {
      const falseCondition: IConditionHandler = {
        type: 'user_in_role',
        phase: 'condition',
        schema: { safeParse: jest.fn() } as never,
        evaluate: jest.fn().mockResolvedValue(false),
        findReferences: jest.fn().mockReturnValue([]),
      };

      registryGet.mockImplementation((phase: string, type: string) =>
        phase === 'condition' && type === 'user_in_role'
          ? falseCondition
          : undefined,
      );

      const client = buildMockClient({
        tables: buildGraphTables(
          makeWorkflow(),
          [
            {
              id: FROM_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: FROM_STATUS,
            },
            {
              id: TO_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: TO_STATUS,
            },
          ],
          [
            {
              id: TRANSITION_ID,
              workflow_id: WF_ID,
              name: 'Approve',
              kind: 'regular',
              to_node_id: TO_NODE,
              screen_field_group_id: null,
              conditions: [{ type: 'user_in_role', role_id: 'r1' }],
              validators: [],
              post_functions: [],
              triggers: [],
              sort_order: 0,
            },
          ],
          [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
          makeTask(),
        ),
      });

      const engine = buildEngine(client);
      const result = await engine.getAvailableTransitions(TASK_ID, makeUser());

      expect(result.workflow_assigned).toBe(true);

      // A failing condition no longer HIDES the transition — it is surfaced
      // disabled with an explanation, so the task never looks like it has no
      // transitions at all.
      expect(result.transitions).toHaveLength(1);
      expect(result.transitions[0]).toMatchObject({
        can_execute: false,
        blocked_reason: expect.stringContaining('user_in_role'),
      });

      client.rpc.mockResolvedValue({ data: makeTask(), error: null });
      await expect(
        engine.executeTransition({
          taskId: TASK_ID,
          transitionId: TRANSITION_ID,
          user: makeUser(),
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(automationOutbox.emitTaskStatusChanged).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // 3. Validator fails — executeTransition throws 422
  // -----------------------------------------------------------------
  describe('executeTransition — validator fails', () => {
    it('throws UnprocessableEntityException with data.errors', async () => {
      const validator: IValidatorHandler = {
        type: 'field_required',
        phase: 'validator',
        schema: { safeParse: jest.fn() } as never,
        validate: jest.fn().mockResolvedValue({
          ok: false,
          message: 'Required',
          fieldPath: 'fld-1',
        }),
        findReferences: jest.fn().mockReturnValue([]),
      };

      registryGet.mockImplementation((phase: string, type: string) =>
        phase === 'validator' && type === 'field_required'
          ? validator
          : undefined,
      );

      const lockedTask = makeTask();
      const client = buildMockClient({
        tables: buildGraphTables(
          makeWorkflow(),
          [
            {
              id: FROM_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: FROM_STATUS,
            },
            {
              id: TO_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: TO_STATUS,
            },
          ],
          [
            {
              id: TRANSITION_ID,
              workflow_id: WF_ID,
              name: 'Approve',
              kind: 'regular',
              to_node_id: TO_NODE,
              screen_field_group_id: null,
              conditions: [],
              validators: [{ type: 'field_required', field_id: 'fld-1' }],
              post_functions: [],
              triggers: [],
              sort_order: 0,
            },
          ],
          [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
          lockedTask,
        ),
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: lockedTask, error: null }),
        },
      });

      const engine = buildEngine(client);

      try {
        await engine.executeTransition({
          taskId: TASK_ID,
          transitionId: TRANSITION_ID,
          user: makeUser(),
        });
        fail('Expected UnprocessableEntityException');
      } catch (err) {
        expect(err).toBeInstanceOf(UnprocessableEntityException);
        const response = (
          err as UnprocessableEntityException
        ).getResponse() as {
          data: { errors: Array<{ field?: string; type?: string }> };
        };

        expect(response.data.errors).toHaveLength(1);
        expect(response.data.errors[0].field).toBe('fld-1');
        expect(response.data.errors[0].type).toBe('field_required');
      }
      expect(automationOutbox.emitTaskStatusChanged).not.toHaveBeenCalled();
      expect(watchersService.notifyTaskWatchers).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // 4. Sync post-function throws — compensation reverts status; error rethrown
  // -----------------------------------------------------------------
  describe('executeTransition — sync post-function throws', () => {
    it('reverts the task status_id and rethrows the original error', async () => {
      const failingPf: IPostFunctionHandler = {
        type: 'assign_to',
        phase: 'post_function',
        schema: {
          safeParse: jest.fn((cfg: unknown) => ({ success: true, data: cfg })),
        } as never,
        run: jest.fn().mockRejectedValue(new Error('assign failed')),
        findReferences: jest.fn().mockReturnValue([]),
      };

      registryGet.mockImplementation((phase: string, type: string) =>
        phase === 'post_function' && type === 'assign_to'
          ? failingPf
          : undefined,
      );

      const lockedTask = makeTask();
      const updatedTask = {
        ...lockedTask,
        status: 'in_progress',
        status_id: TO_STATUS,
        version: 4,
      };

      // Per-call task table behavior: first .single() resolves to updatedTask
      // (the primary status write), subsequent updates resolve to {data:null,error:null}
      // (the compensation).
      const taskUpdateCalls: jest.Mock[] = [];
      const tables = buildGraphTables(
        makeWorkflow(),
        [
          {
            id: FROM_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: FROM_STATUS,
          },
          {
            id: TO_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: TO_STATUS,
          },
        ],
        [
          {
            id: TRANSITION_ID,
            workflow_id: WF_ID,
            name: 'Approve',
            kind: 'regular',
            to_node_id: TO_NODE,
            screen_field_group_id: null,
            conditions: [],
            validators: [],
            post_functions: [{ type: 'assign_to', user_id: 'u-2' }],
            triggers: [],
            sort_order: 0,
          },
        ],
        [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
        lockedTask,
      );

      // Stub the tasks table differently for read-vs-update.
      const taskUpdates: Record<string, unknown>[] = [];
      let updateCallCount = 0;

      tables.tasks = (chain) => {
        chain.maybeSingle = jest
          .fn()
          .mockResolvedValue({ data: lockedTask, error: null });
        chain.update = jest
          .fn()
          .mockImplementation((patch: Record<string, unknown>) => {
            taskUpdates.push(patch);
            taskUpdateCalls.push(chain.update as jest.Mock);

            return chain;
          });
        // The primary update returns updatedTask; the compensation update
        // doesn't go through .single() — it's a fire-and-forget `then`.
        chain.single = jest.fn().mockImplementation(() => {
          updateCallCount++;
          if (updateCallCount === 1) {
            return Promise.resolve({ data: updatedTask, error: null });
          }

          return Promise.resolve({ data: null, error: null });
        });
        chain.then = (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(onFulfilled);

        return chain;
      };

      const client = buildMockClient({
        tables,
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: lockedTask, error: null }),
        },
      });

      const engine = buildEngine(client);

      await expect(
        engine.executeTransition({
          taskId: TASK_ID,
          transitionId: TRANSITION_ID,
          user: makeUser(),
        }),
      ).rejects.toThrow('assign failed');

      // Compensation now belongs to one fenced database transaction.
      expect(taskUpdates).toHaveLength(1);
      expect(taskUpdates[0].status_id).toBe(TO_STATUS);
      expect(taskUpdates[0].status).toBe('in_progress');
      // log_task_history credits NEW.updated_by — the write must carry the acting
      // user or history attributes the change to the previous editor. The second
      // (compensating) write moved into sla_finish_workflow, so only one remains.
      expect(taskUpdates[0].updated_by).toBe(makeUser().userId);
      expect(taskUpdates[0]).not.toHaveProperty('version');
      expect(taskUpdates[0]).not.toHaveProperty('updated_at');
      expect(client.rpc).toHaveBeenCalledWith('sla_finish_workflow', {
        p_task_id: TASK_ID,
        p_token: 'operation-token',
        p_compensated: true,
      });
      expect(client.rpc).toHaveBeenCalledWith('sla_begin_workflow', {
        p_task_id: TASK_ID,
        p_organization_id: ORG,
        p_expected_version: 3,
        p_expected_updated_at: '2026-09-05T12:00:00.000Z',
      });
      expect(automationOutbox.emitTaskStatusChanged).not.toHaveBeenCalled();
      expect(watchersService.notifyTaskWatchers).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // 5. Async post-function (send_notification) — outbox enqueue path
  // -----------------------------------------------------------------
  describe('executeTransition — async send_notification post-function', () => {
    it('treats send_notification as best-effort and records succeeded', async () => {
      const notifyPf: IPostFunctionHandler = {
        type: 'send_notification',
        phase: 'post_function',
        schema: {
          safeParse: jest.fn((cfg: unknown) => ({ success: true, data: cfg })),
        } as never,
        run: jest.fn().mockResolvedValue(undefined),
        findReferences: jest.fn().mockReturnValue([]),
      };

      registryGet.mockImplementation((phase: string, type: string) =>
        phase === 'post_function' && type === 'send_notification'
          ? notifyPf
          : undefined,
      );

      const lockedTask = makeTask();
      const updatedTask = {
        ...lockedTask,
        status: 'in_progress',
        status_id: TO_STATUS,
        version: 4,
      };
      const client = buildMockClient({
        tables: buildGraphTables(
          makeWorkflow(),
          [
            {
              id: FROM_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: FROM_STATUS,
            },
            {
              id: TO_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: TO_STATUS,
            },
          ],
          [
            {
              id: TRANSITION_ID,
              workflow_id: WF_ID,
              name: 'Approve',
              kind: 'regular',
              to_node_id: TO_NODE,
              screen_field_group_id: null,
              conditions: [],
              validators: [],
              post_functions: [
                {
                  type: 'send_notification',
                  recipients: [],
                  subject: 'x',
                  body: 'y',
                },
              ],
              triggers: [],
              sort_order: 0,
            },
          ],
          [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
          lockedTask,
          [],
          [],
          { data: updatedTask, error: null },
        ),
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: lockedTask, error: null }),
        },
      });

      const engine = buildEngine(client);
      const result = await engine.executeTransition({
        taskId: TASK_ID,
        transitionId: TRANSITION_ID,
        user: makeUser(),
      });

      expect((result as { status_id: string }).status_id).toBe(TO_STATUS);
      expect(auditLogs.logAction).toHaveBeenCalledWith(
        ORG,
        'user-1',
        'task',
        TASK_ID,
        'workflow.transition.executed',
        expect.objectContaining({
          rules_evaluated: expect.arrayContaining([
            expect.objectContaining({
              phase: 'post_function',
              type: 'send_notification',
              result: 'succeeded',
            }),
          ]),
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'task.transitioned',
        expect.objectContaining({ toStatusId: TO_STATUS }),
      );
      expect(automationOutbox.emitTaskStatusChanged).toHaveBeenCalledTimes(1);
      expect(automationOutbox.emitTaskStatusChanged).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({ status: 'open', status_id: FROM_STATUS }),
        expect.objectContaining({
          id: TASK_ID,
          key: 'TASK-1',
          status: 'in_progress',
          status_id: TO_STATUS,
        }),
        'user-1',
      );
      expect(watchersService.notifyTaskWatchers).toHaveBeenCalledWith({
        organizationId: ORG,
        spaceId: SPACE,
        taskId: TASK_ID,
        actorUserId: 'user-1',
        taskKey: 'TASK-1',
        title: 'Test task',
        changeKind: 'workflow_transition',
      });
    });

    it('records failed_best_effort when send_notification throws', async () => {
      const failingNotify: IPostFunctionHandler = {
        type: 'send_notification',
        phase: 'post_function',
        schema: {
          safeParse: jest.fn((cfg: unknown) => ({ success: true, data: cfg })),
        } as never,
        run: jest.fn().mockRejectedValue(new Error('mail down')),
        findReferences: jest.fn().mockReturnValue([]),
      };

      registryGet.mockImplementation((phase: string, type: string) =>
        phase === 'post_function' && type === 'send_notification'
          ? failingNotify
          : undefined,
      );

      const lockedTask = makeTask();
      const updatedTask = { ...lockedTask, status_id: TO_STATUS, version: 4 };
      const client = buildMockClient({
        tables: buildGraphTables(
          makeWorkflow(),
          [
            {
              id: FROM_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: FROM_STATUS,
            },
            {
              id: TO_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: TO_STATUS,
            },
          ],
          [
            {
              id: TRANSITION_ID,
              workflow_id: WF_ID,
              name: 'Approve',
              kind: 'regular',
              to_node_id: TO_NODE,
              screen_field_group_id: null,
              conditions: [],
              validators: [],
              post_functions: [
                {
                  type: 'send_notification',
                  recipients: [],
                  subject: 'x',
                  body: 'y',
                },
              ],
              triggers: [],
              sort_order: 0,
            },
          ],
          [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
          lockedTask,
          [],
          [],
          { data: updatedTask, error: null },
        ),
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: lockedTask, error: null }),
        },
      });

      const engine = buildEngine(client);
      const result = await engine.executeTransition({
        taskId: TASK_ID,
        transitionId: TRANSITION_ID,
        user: makeUser(),
      });

      // Best-effort: status still committed despite the notification failure.
      expect((result as { status_id: string }).status_id).toBe(TO_STATUS);
      expect(auditLogs.logAction).toHaveBeenCalledWith(
        ORG,
        'user-1',
        'task',
        TASK_ID,
        'workflow.transition.executed',
        expect.objectContaining({
          rules_evaluated: expect.arrayContaining([
            expect.objectContaining({
              phase: 'post_function',
              type: 'send_notification',
              result: 'failed_best_effort',
            }),
          ]),
        }),
      );
    });
  });

  // -----------------------------------------------------------------
  // 5b. Post-function mutations are reflected in the API response/event
  // -----------------------------------------------------------------
  describe('executeTransition — post-function task refresh', () => {
    it('returns and emits the task row after post-functions mutate it', async () => {
      const setResolutionPf: IPostFunctionHandler = {
        type: 'set_resolution',
        phase: 'post_function',
        schema: {
          safeParse: jest.fn((cfg: unknown) => ({ success: true, data: cfg })),
        } as never,
        run: jest.fn().mockResolvedValue(undefined),
        findReferences: jest.fn().mockReturnValue([]),
      };

      registryGet.mockImplementation((phase: string, type: string) =>
        phase === 'post_function' && type === 'set_resolution'
          ? setResolutionPf
          : undefined,
      );

      const lockedTask = makeTask();
      const updatedTask = {
        ...lockedTask,
        status_id: TO_STATUS,
        version: 4,
        resolution_id: null,
      };
      const finalTask = {
        ...updatedTask,
        resolution_id: 'resolution-done',
      };
      const client = buildMockClient({
        tables: buildGraphTables(
          makeWorkflow(),
          [
            {
              id: FROM_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: FROM_STATUS,
            },
            {
              id: TO_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: TO_STATUS,
            },
          ],
          [
            {
              id: TRANSITION_ID,
              workflow_id: WF_ID,
              name: 'Resolve',
              kind: 'regular',
              to_node_id: TO_NODE,
              screen_field_group_id: null,
              conditions: [],
              validators: [],
              post_functions: [
                {
                  type: 'set_resolution',
                  resolution_id: 'resolution-done',
                },
              ],
              triggers: [],
              sort_order: 0,
            },
          ],
          [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
          lockedTask,
          [],
          [],
          { data: updatedTask, error: null },
          undefined,
          { key: 'done', is_completed: true },
          { data: finalTask, error: null },
        ),
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: lockedTask, error: null }),
        },
      });

      const engine = buildEngine(client);
      const result = await engine.executeTransition({
        taskId: TASK_ID,
        transitionId: TRANSITION_ID,
        user: makeUser(),
      });

      expect((result as { resolution_id: string }).resolution_id).toBe(
        'resolution-done',
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'task.transitioned',
        expect.objectContaining({
          task: expect.objectContaining({ resolution_id: 'resolution-done' }),
          toStatusId: TO_STATUS,
        }),
      );
    });
  });

  // -----------------------------------------------------------------
  // 6. Concurrent execution — stale expectedVersion → 409
  // -----------------------------------------------------------------
  describe('executeTransition — concurrent execution', () => {
    it('rejects with 409 when expectedVersion does not match', async () => {
      const lockedTask = makeTask({ version: 5 });
      const client = buildMockClient({
        tables: buildGraphTables(makeWorkflow(), [], [], [], lockedTask),
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: lockedTask, error: null }),
        },
      });

      const engine = buildEngine(client);

      await expect(
        engine.executeTransition({
          taskId: TASK_ID,
          transitionId: TRANSITION_ID,
          expectedVersion: 3, // stale
          user: makeUser(),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(automationOutbox.emitTaskStatusChanged).not.toHaveBeenCalled();
    });

    it.each([
      [null, 'Optimistic concurrency lost; refresh and retry'],
      [
        { code: 'PGRST116', message: '0 rows' },
        'Optimistic concurrency lost; refresh and retry',
      ],
      [
        { code: '23514', message: 'check constraint failed' },
        'Failed to update task status',
      ],
      [
        { code: '08006', message: 'connection lost' },
        'Failed to update task status',
      ],
    ])(
      'classifies guarded update failure %j correctly',
      async (error, message) => {
        const lockedTask = makeTask({ version: 3 }) as Record<
          string,
          unknown
        > & {
          version: number;
        };
        const client = buildMockClient({
          tables: buildGraphTables(
            makeWorkflow(),
            [
              {
                id: FROM_NODE,
                workflow_id: WF_ID,
                kind: 'status',
                status_id: FROM_STATUS,
              },
              {
                id: TO_NODE,
                workflow_id: WF_ID,
                kind: 'status',
                status_id: TO_STATUS,
              },
            ],
            [
              {
                id: TRANSITION_ID,
                workflow_id: WF_ID,
                name: 'Approve',
                kind: 'regular',
                to_node_id: TO_NODE,
                screen_field_group_id: null,
                conditions: [],
                validators: [],
                post_functions: [],
                triggers: [],
                sort_order: 0,
              },
            ],
            [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
            lockedTask,
            [],
            [],
            { data: null, error },
          ),
          rpcs: {
            begin_atomic_transition: jest
              .fn()
              .mockResolvedValue({ data: lockedTask, error: null }),
          },
        });

        const engine = buildEngine(client);

        await expect(
          engine.executeTransition({
            taskId: TASK_ID,
            transitionId: TRANSITION_ID,
            expectedVersion: lockedTask.version,
            user: makeUser(),
          }),
        ).rejects.toThrow(message as string);
        expect(automationOutbox.emitTaskStatusChanged).not.toHaveBeenCalled();
      },
    );
  });

  // -----------------------------------------------------------------
  // 7. Idempotency — same execution_id returns cached row
  // -----------------------------------------------------------------
  describe('executeTransition — idempotency cache hit', () => {
    it('returns the latest task without re-running rules when execution_id is cached', async () => {
      const condition: IConditionHandler = {
        type: 'user_in_role',
        phase: 'condition',
        schema: { safeParse: jest.fn() } as never,
        evaluate: jest.fn().mockResolvedValue(true),
        findReferences: jest.fn().mockReturnValue([]),
      };

      registryGet.mockImplementation(() => condition);

      const lockedTask = makeTask({ version: 4 });
      const tables = buildGraphTables(
        makeWorkflow(),
        [],
        [],
        [],
        lockedTask,
        [],
        [{ id: 'audit-1' }], // cached audit row
      );
      const client = buildMockClient({
        tables,
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: lockedTask, error: null }),
        },
      });

      const engine = buildEngine(client);
      const result = await engine.executeTransition({
        taskId: TASK_ID,
        transitionId: TRANSITION_ID,
        executionId: 'exec-key-1',
        user: makeUser(),
      });

      expect(result).toBeTruthy();
      // No condition ran, no validator ran, no event was emitted.
      expect(condition.evaluate).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(auditLogs.logAction).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // 8. resolveTransitionByStatusChange — 0 / 1 / N candidates
  // -----------------------------------------------------------------
  describe('resolveTransitionByStatusChange', () => {
    function setupGraph(transitions: Array<Record<string, unknown>>) {
      const client = buildMockClient({
        tables: buildGraphTables(
          makeWorkflow(),
          [
            {
              id: FROM_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: FROM_STATUS,
            },
            {
              id: TO_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: TO_STATUS,
            },
          ],
          transitions,
          transitions.map((t) => ({
            transition_id: t.id,
            from_node_id: FROM_NODE,
          })),
          makeTask(),
        ),
      });

      return buildEngine(client);
    }

    it('returns {transition} on exactly one match', async () => {
      const engine = setupGraph([
        {
          id: TRANSITION_ID,
          workflow_id: WF_ID,
          name: 'Approve',
          kind: 'regular',
          to_node_id: TO_NODE,
          screen_field_group_id: null,
          conditions: [],
          validators: [],
          post_functions: [],
          triggers: [],
          sort_order: 0,
        },
      ]);

      const result = await engine.resolveTransitionByStatusChange(
        TASK_ID,
        TO_STATUS,
        makeUser(),
      );

      expect(result).toEqual({
        transition: { id: TRANSITION_ID, name: 'Approve' },
      });
    });

    it('returns no_path when zero matches', async () => {
      const engine = setupGraph([]);

      const result = await engine.resolveTransitionByStatusChange(
        TASK_ID,
        TO_STATUS,
        makeUser(),
      );

      expect(result).toEqual({ error: 'no_path' });
    });

    it('returns multiple_paths with candidates on >1 match', async () => {
      const engine = setupGraph([
        {
          id: 'tx-a',
          workflow_id: WF_ID,
          name: 'Approve',
          kind: 'regular',
          to_node_id: TO_NODE,
          screen_field_group_id: null,
          conditions: [],
          validators: [],
          post_functions: [],
          triggers: [],
          sort_order: 0,
        },
        {
          id: 'tx-b',
          workflow_id: WF_ID,
          name: 'Fast-track',
          kind: 'regular',
          to_node_id: TO_NODE,
          screen_field_group_id: null,
          conditions: [],
          validators: [],
          post_functions: [],
          triggers: [],
          sort_order: 1,
        },
      ]);

      const result = await engine.resolveTransitionByStatusChange(
        TASK_ID,
        TO_STATUS,
        makeUser(),
      );

      expect(result).toEqual({
        error: 'multiple_paths',
        candidates: [
          { id: 'tx-a', name: 'Approve' },
          { id: 'tx-b', name: 'Fast-track' },
        ],
      });
    });

    it('returns condition_failed (not no_path) when a source→target transition exists but its condition blocks it', async () => {
      const falseCondition: IConditionHandler = {
        type: 'user_in_role',
        phase: 'condition',
        schema: { safeParse: jest.fn() } as never,
        evaluate: jest.fn().mockResolvedValue(false),
        findReferences: jest.fn().mockReturnValue([]),
      };

      registryGet.mockImplementation((phase: string, type: string) =>
        phase === 'condition' && type === 'user_in_role'
          ? falseCondition
          : undefined,
      );

      const engine = setupGraph([
        {
          id: TRANSITION_ID,
          workflow_id: WF_ID,
          name: 'Start',
          kind: 'regular',
          to_node_id: TO_NODE,
          screen_field_group_id: null,
          conditions: [{ type: 'user_in_role', role_id: 'r1' }],
          validators: [],
          post_functions: [],
          triggers: [],
          sort_order: 0,
        },
      ]);

      const result = await engine.resolveTransitionByStatusChange(
        TASK_ID,
        TO_STATUS,
        makeUser(),
      );

      expect(result).toEqual({
        error: 'condition_failed',
        blockedTransition: { id: TRANSITION_ID, name: 'Start' },
      });
    });

    it('B2: resolves THROUGH a decision node when no direct status transition matches', async () => {
      const DEC_NODE = 'node-decision';
      const client = buildMockClient({
        tables: buildGraphTables(
          makeWorkflow(),
          [
            // nodes[0] is returned by the single-node lookup during decision
            // target resolution, so the branch target (TO_NODE) must be first.
            {
              id: TO_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: TO_STATUS,
            },
            {
              id: FROM_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: FROM_STATUS,
            },
            {
              id: DEC_NODE,
              workflow_id: WF_ID,
              kind: 'decision',
              status_id: null,
            },
          ],
          [
            {
              id: TRANSITION_ID,
              workflow_id: WF_ID,
              name: 'Review',
              kind: 'regular',
              to_node_id: DEC_NODE,
              screen_field_group_id: null,
              conditions: [],
              validators: [],
              post_functions: [],
              triggers: [],
              sort_order: 0,
            },
          ],
          [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
          makeTask({ priority_id: 'prio-high' }),
          [
            {
              id: 'br-1',
              decision_node_id: DEC_NODE,
              to_node_id: TO_NODE,
              expression: {
                kind: 'field_equals',
                field_id: 'sys:priority_id',
                value: 'prio-high',
              },
              sort_order: 0,
              label: null,
            },
          ],
        ),
      });

      const engine = buildEngine(client);

      const result = await engine.resolveTransitionByStatusChange(
        TASK_ID,
        TO_STATUS,
        makeUser(),
      );

      expect(result).toEqual({
        transition: { id: TRANSITION_ID, name: 'Review' },
      });
    });

    it('B2: a direct status transition still wins over a diamond that resolves to the same status (no multiple_paths regression)', async () => {
      const DEC_NODE = 'node-decision';
      const client = buildMockClient({
        tables: buildGraphTables(
          makeWorkflow(),
          [
            {
              id: TO_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: TO_STATUS,
            },
            {
              id: FROM_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: FROM_STATUS,
            },
            {
              id: DEC_NODE,
              workflow_id: WF_ID,
              kind: 'decision',
              status_id: null,
            },
          ],
          [
            {
              id: 'tx-direct',
              workflow_id: WF_ID,
              name: 'Approve',
              kind: 'regular',
              to_node_id: TO_NODE,
              screen_field_group_id: null,
              conditions: [],
              validators: [],
              post_functions: [],
              triggers: [],
              sort_order: 0,
            },
            {
              id: 'tx-diamond',
              workflow_id: WF_ID,
              name: 'Review',
              kind: 'regular',
              to_node_id: DEC_NODE,
              screen_field_group_id: null,
              conditions: [],
              validators: [],
              post_functions: [],
              triggers: [],
              sort_order: 1,
            },
          ],
          [
            { transition_id: 'tx-direct', from_node_id: FROM_NODE },
            { transition_id: 'tx-diamond', from_node_id: FROM_NODE },
          ],
          makeTask({ priority_id: 'prio-high' }),
          [
            {
              id: 'br-1',
              decision_node_id: DEC_NODE,
              to_node_id: TO_NODE,
              expression: {
                kind: 'field_equals',
                field_id: 'sys:priority_id',
                value: 'prio-high',
              },
              sort_order: 0,
              label: null,
            },
          ],
        ),
      });

      const engine = buildEngine(client);

      const result = await engine.resolveTransitionByStatusChange(
        TASK_ID,
        TO_STATUS,
        makeUser(),
      );

      // Direct match wins; the diamond is never considered (fallback-only).
      expect(result).toEqual({
        transition: { id: 'tx-direct', name: 'Approve' },
      });
    });
  });

  // -----------------------------------------------------------------
  // 9. Initial transition runs all post-functions in order
  // -----------------------------------------------------------------
  describe('runInitialPostFunctions', () => {
    it('invokes every post-function on the initial transition', async () => {
      const setPf: IPostFunctionHandler = {
        type: 'set_field_value',
        phase: 'post_function',
        schema: {
          safeParse: jest.fn((cfg: unknown) => ({ success: true, data: cfg })),
        } as never,
        run: jest.fn().mockResolvedValue(undefined),
        findReferences: jest.fn().mockReturnValue([]),
      };
      const logPf: IPostFunctionHandler = {
        type: 'log_entry',
        phase: 'post_function',
        schema: {
          safeParse: jest.fn((cfg: unknown) => ({ success: true, data: cfg })),
        } as never,
        run: jest.fn().mockResolvedValue(undefined),
        findReferences: jest.fn().mockReturnValue([]),
      };

      registryGet.mockImplementation((phase: string, type: string) => {
        if (phase !== 'post_function') return undefined;
        if (type === 'set_field_value') return setPf;
        if (type === 'log_entry') return logPf;

        return undefined;
      });

      const task = makeTask();
      const client = buildMockClient({
        tables: buildGraphTables(
          makeWorkflow(),
          [
            {
              id: FROM_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: FROM_STATUS,
            },
          ],
          [
            {
              id: 'tx-initial',
              workflow_id: WF_ID,
              name: 'Create',
              kind: 'initial',
              to_node_id: FROM_NODE,
              screen_field_group_id: null,
              conditions: [],
              validators: [],
              post_functions: [
                { type: 'set_field_value', field_id: 'f1', value: 'v' },
                { type: 'log_entry', message: 'created' },
              ],
              triggers: [],
              sort_order: 0,
            },
          ],
          [],
          task,
        ),
      });

      const engine = buildEngine(client);

      await engine.runInitialPostFunctions(TASK_ID, 'tx-initial', makeUser());

      expect(setPf.run).toHaveBeenCalledTimes(1);
      expect(logPf.run).toHaveBeenCalledTimes(1);
      expect(auditLogs.logAction).toHaveBeenCalledWith(
        ORG,
        'user-1',
        'task',
        TASK_ID,
        'workflow.transition.executed',
        expect.objectContaining({ initial: true }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'task.transitioned',
        expect.objectContaining({ initial: true }),
      );
    });
  });

  // -----------------------------------------------------------------
  // 10. Recursion depth guard — transitionDepth=2 raises
  // -----------------------------------------------------------------
  describe('executeTransition — recursion depth guard', () => {
    it('raises BadRequestException when transitionDepth exceeds 1', async () => {
      const lockedTask = makeTask();
      const client = buildMockClient({
        tables: buildGraphTables(makeWorkflow(), [], [], [], lockedTask),
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: lockedTask, error: null }),
        },
      });

      const engine = buildEngine(client);

      await expect(
        engine.executeTransition({
          taskId: TASK_ID,
          transitionId: TRANSITION_ID,
          transitionDepth: 2,
          user: makeUser(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // -----------------------------------------------------------------
  // B4 — Step 9 screen_input filtering by screen_field_group members
  // -----------------------------------------------------------------
  describe('executeTransition — screen_field_group filtering (B4)', () => {
    const FIELD_GROUP = '99999999-9999-9999-9999-999999999999';
    const ALLOWED_FIELD = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const DISALLOWED_FIELD = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    function wireScreenFieldLookup(
      graph: Record<string, TableHandler>,
      groupFieldIds: string[],
      activeFieldIds = groupFieldIds,
    ) {
      graph.field_group_fields = (chain) => {
        chain.then = (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve({
            data: groupFieldIds.map((custom_field_id) => ({ custom_field_id })),
            error: null,
          }).then(onFulfilled);

        return chain;
      };

      graph.custom_fields = (chain) => {
        chain.then = (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve({
            data: activeFieldIds.map((id) => ({ id })),
            error: null,
          }).then(onFulfilled);

        return chain;
      };
    }

    it('drops screen_input keys not in the configured screen_field_group', async () => {
      registryGet.mockImplementation(() => undefined); // no rules
      const lockedTask = makeTask();
      const updatedTask = {
        ...lockedTask,
        status_id: TO_STATUS,
        version: 4,
        custom_field_values: { [ALLOWED_FIELD]: 'kept' },
      };

      const taskUpdates: Array<Record<string, unknown>> = [];
      const graph = buildGraphTables(
        makeWorkflow(),
        [
          {
            id: FROM_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: FROM_STATUS,
          },
          {
            id: TO_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: TO_STATUS,
          },
        ],
        [
          {
            id: TRANSITION_ID,
            workflow_id: WF_ID,
            name: 'Approve',
            kind: 'regular',
            to_node_id: TO_NODE,
            // KEY DIFFERENCE: screen_field_group_id is set → filtering engages.
            screen_field_group_id: FIELD_GROUP,
            conditions: [],
            validators: [],
            post_functions: [],
            triggers: [],
            sort_order: 0,
          },
        ],
        [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
        lockedTask,
        [],
        [],
        { data: updatedTask, error: null },
        {
          update: jest
            .fn()
            .mockImplementation((patch: Record<string, unknown>) => {
              taskUpdates.push(patch);

              return {
                eq: () => ({
                  eq: () => ({
                    select: () => ({
                      single: () =>
                        Promise.resolve({ data: updatedTask, error: null }),
                    }),
                  }),
                }),
              };
            }),
        },
      );

      // Extend the graph with a field_group_fields handler returning only ALLOWED_FIELD.
      wireScreenFieldLookup(graph, [ALLOWED_FIELD]);

      const client = buildMockClient({
        tables: graph,
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: lockedTask, error: null }),
        },
      });

      const engine = buildEngine(client);

      await engine.executeTransition({
        taskId: TASK_ID,
        transitionId: TRANSITION_ID,
        screenInput: {
          [ALLOWED_FIELD]: 'kept',
          [DISALLOWED_FIELD]: 'dropped',
        },
        user: makeUser(),
      });

      // The status UPDATE's custom_field_values must contain ONLY the allowed
      // field — the disallowed key was silently dropped at Step 9.
      const statusUpdate = taskUpdates.find(
        (u) => u.status_id === TO_STATUS,
      ) as { custom_field_values?: Record<string, unknown> };

      expect(statusUpdate).toBeDefined();
      expect(statusUpdate.custom_field_values).toEqual({
        [ALLOWED_FIELD]: 'kept',
      });
      expect(statusUpdate.custom_field_values).not.toHaveProperty(
        DISALLOWED_FIELD,
      );
    });

    it('runs validators against current custom fields plus allowed screen_input', async () => {
      const validator: IValidatorHandler = {
        type: 'field_required',
        phase: 'validator',
        schema: { safeParse: jest.fn() } as never,
        validate: jest
          .fn()
          .mockImplementation(
            (
              _cfg: unknown,
              ctx: { customFieldValues: Record<string, unknown> },
            ) => ({
              ok: Boolean(ctx.customFieldValues[ALLOWED_FIELD]),
            }),
          ),
        findReferences: jest.fn().mockReturnValue([]),
      };

      registryGet.mockImplementation((phase: string, type: string) =>
        phase === 'validator' && type === 'field_required'
          ? validator
          : undefined,
      );

      const lockedTask = makeTask();
      const updatedTask = {
        ...lockedTask,
        status_id: TO_STATUS,
        version: 4,
        custom_field_values: { [ALLOWED_FIELD]: 'submitted' },
      };
      const taskUpdates: Array<Record<string, unknown>> = [];
      const graph = buildGraphTables(
        makeWorkflow(),
        [
          {
            id: FROM_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: FROM_STATUS,
          },
          {
            id: TO_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: TO_STATUS,
          },
        ],
        [
          {
            id: TRANSITION_ID,
            workflow_id: WF_ID,
            name: 'Approve',
            kind: 'regular',
            to_node_id: TO_NODE,
            screen_field_group_id: FIELD_GROUP,
            conditions: [],
            validators: [{ type: 'field_required', field_id: ALLOWED_FIELD }],
            post_functions: [],
            triggers: [],
            sort_order: 0,
          },
        ],
        [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
        lockedTask,
        [],
        [],
        { data: updatedTask, error: null },
        {
          update: jest
            .fn()
            .mockImplementation((patch: Record<string, unknown>) => {
              taskUpdates.push(patch);

              return {
                eq: () => ({
                  eq: () => ({
                    select: () => ({
                      single: () =>
                        Promise.resolve({ data: updatedTask, error: null }),
                    }),
                  }),
                }),
              };
            }),
        },
      );

      wireScreenFieldLookup(graph, [ALLOWED_FIELD]);

      const client = buildMockClient({
        tables: graph,
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: lockedTask, error: null }),
        },
      });

      const engine = buildEngine(client);

      await engine.executeTransition({
        taskId: TASK_ID,
        transitionId: TRANSITION_ID,
        screenInput: {
          [ALLOWED_FIELD]: 'submitted',
        },
        user: makeUser(),
      });

      expect(validator.validate).toHaveBeenCalledWith(
        expect.objectContaining({ field_id: ALLOWED_FIELD }),
        expect.objectContaining({
          customFieldValues: expect.objectContaining({
            [ALLOWED_FIELD]: 'submitted',
          }),
        }),
      );
      expect(taskUpdates).toContainEqual(
        expect.objectContaining({
          custom_field_values: { [ALLOWED_FIELD]: 'submitted' },
        }),
      );
    });

    it('field_required passes when the value is set by slug but the rule targets its UUID (key-mismatch fix)', async () => {
      const FIELD_SLUG = 'test_custom_field_12';
      const validator = new FieldRequiredValidator();

      registryGet.mockImplementation((phase: string, type: string) =>
        phase === 'validator' && type === 'field_required'
          ? validator
          : undefined,
      );

      // Value set via the sidebar → persisted keyed by SLUG, not the field UUID.
      const lockedTask = makeTask({
        custom_field_values: { [FIELD_SLUG]: 'dasdsad' },
      });
      const updatedTask = { ...lockedTask, status_id: TO_STATUS, version: 4 };

      const graph = buildGraphTables(
        makeWorkflow(),
        [
          {
            id: FROM_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: FROM_STATUS,
          },
          {
            id: TO_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: TO_STATUS,
          },
        ],
        [
          {
            id: TRANSITION_ID,
            workflow_id: WF_ID,
            name: 'Submit for review',
            kind: 'regular',
            to_node_id: TO_NODE,
            screen_field_group_id: null,
            conditions: [],
            validators: [{ type: 'field_required', field_id: ALLOWED_FIELD }],
            post_functions: [],
            triggers: [],
            sort_order: 0,
          },
        ],
        [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
        lockedTask,
        [],
        [],
        { data: updatedTask, error: null },
      );

      // The org id→slug map the engine now loads: field UUID → its slug.
      graph.custom_fields = (chain) => {
        chain.then = (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve({
            data: [{ id: ALLOWED_FIELD, field_key: FIELD_SLUG }],
            error: null,
          }).then(onFulfilled);

        return chain;
      };

      const client = buildMockClient({
        tables: graph,
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: lockedTask, error: null }),
        },
      });

      const engine = buildEngine(client);

      // Before the fix this threw UnprocessableEntityException ("field_required").
      await expect(
        engine.executeTransition({
          taskId: TASK_ID,
          transitionId: TRANSITION_ID,
          screenInput: {},
          user: makeUser(),
        }),
      ).resolves.toBeDefined();
    });

    it('persists screen_input as slug-keyed custom_field_values (no UUID keys leak)', async () => {
      const FIELD_SLUG = 'test_custom_field_12';

      registryGet.mockImplementation(() => undefined);

      const lockedTask = makeTask({ custom_field_values: {} });
      const updatedTask = { ...lockedTask, status_id: TO_STATUS, version: 4 };
      const taskUpdates: Array<Record<string, unknown>> = [];

      const graph = buildGraphTables(
        makeWorkflow(),
        [
          {
            id: FROM_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: FROM_STATUS,
          },
          {
            id: TO_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: TO_STATUS,
          },
        ],
        [
          {
            id: TRANSITION_ID,
            workflow_id: WF_ID,
            name: 'Submit for review',
            kind: 'regular',
            to_node_id: TO_NODE,
            screen_field_group_id: FIELD_GROUP,
            conditions: [],
            validators: [],
            post_functions: [],
            triggers: [],
            sort_order: 0,
          },
        ],
        [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
        lockedTask,
        [],
        [],
        { data: updatedTask, error: null },
        {
          update: jest
            .fn()
            .mockImplementation((patch: Record<string, unknown>) => {
              taskUpdates.push(patch);

              return {
                eq: () => ({
                  eq: () => ({
                    select: () => ({
                      single: () =>
                        Promise.resolve({ data: updatedTask, error: null }),
                    }),
                  }),
                }),
              };
            }),
        },
      );

      wireScreenFieldLookup(graph, [ALLOWED_FIELD]);

      // Override with a field_key so the engine's id→slug map is populated.
      graph.custom_fields = (chain) => {
        chain.then = (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve({
            data: [{ id: ALLOWED_FIELD, field_key: FIELD_SLUG }],
            error: null,
          }).then(onFulfilled);

        return chain;
      };

      const client = buildMockClient({
        tables: graph,
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: lockedTask, error: null }),
        },
      });

      const engine = buildEngine(client);

      await engine.executeTransition({
        taskId: TASK_ID,
        transitionId: TRANSITION_ID,
        screenInput: { [ALLOWED_FIELD]: 'submitted' },
        user: makeUser(),
      });

      // The UUID-keyed screen_input must be stored under the field SLUG.
      expect(taskUpdates).toContainEqual(
        expect.objectContaining({
          custom_field_values: { [FIELD_SLUG]: 'submitted' },
        }),
      );
    });

    it('provides screen-field requirements and submitted payload to validators', async () => {
      const validator: IValidatorHandler = {
        type: 'screen_fields_required',
        phase: 'validator',
        schema: { safeParse: jest.fn() } as never,
        validate: jest.fn().mockImplementation(
          (
            _cfg: unknown,
            ctx: {
              transition?: {
                required_field_ids?: string[];
                payload?: Record<string, unknown>;
              };
            },
          ) => ({
            ok:
              ctx.transition?.required_field_ids?.includes(ALLOWED_FIELD) ===
                true &&
              ctx.transition?.payload?.[ALLOWED_FIELD] === 'submitted',
          }),
        ),
        findReferences: jest.fn().mockReturnValue([]),
      };

      registryGet.mockImplementation((phase: string, type: string) =>
        phase === 'validator' && type === 'screen_fields_required'
          ? validator
          : undefined,
      );

      const lockedTask = makeTask();
      const updatedTask = {
        ...lockedTask,
        status_id: TO_STATUS,
        version: 4,
        custom_field_values: { [ALLOWED_FIELD]: 'submitted' },
      };
      const graph = buildGraphTables(
        makeWorkflow(),
        [
          {
            id: FROM_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: FROM_STATUS,
          },
          {
            id: TO_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: TO_STATUS,
          },
        ],
        [
          {
            id: TRANSITION_ID,
            workflow_id: WF_ID,
            name: 'Approve',
            kind: 'regular',
            to_node_id: TO_NODE,
            screen_field_group_id: FIELD_GROUP,
            conditions: [],
            validators: [
              {
                type: 'screen_fields_required',
                screen_field_group_id: FIELD_GROUP,
              },
            ],
            post_functions: [],
            triggers: [],
            sort_order: 0,
          },
        ],
        [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
        lockedTask,
        [],
        [],
        { data: updatedTask, error: null },
      );

      wireScreenFieldLookup(graph, [ALLOWED_FIELD]);

      const client = buildMockClient({
        tables: graph,
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: lockedTask, error: null }),
        },
      });

      const engine = buildEngine(client);

      await engine.executeTransition({
        taskId: TASK_ID,
        transitionId: TRANSITION_ID,
        screenInput: { [ALLOWED_FIELD]: 'submitted' },
        user: makeUser(),
      });

      expect(validator.validate).toHaveBeenCalledWith(
        expect.objectContaining({
          screen_field_group_id: FIELD_GROUP,
        }),
        expect.objectContaining({
          transition: expect.objectContaining({
            required_field_ids: [ALLOWED_FIELD],
            payload: { [ALLOWED_FIELD]: 'submitted' },
          }),
        }),
      );
    });

    it('does not require deleted or inactive fields left in a screen_field_group', async () => {
      const validator: IValidatorHandler = {
        type: 'screen_fields_required',
        phase: 'validator',
        schema: { safeParse: jest.fn() } as never,
        validate: jest.fn().mockImplementation(
          (
            _cfg: unknown,
            ctx: {
              transition?: {
                required_field_ids?: string[];
                payload?: Record<string, unknown>;
              };
            },
          ) => ({
            ok:
              JSON.stringify(ctx.transition?.required_field_ids ?? []) ===
                JSON.stringify([ALLOWED_FIELD]) &&
              ctx.transition?.payload?.[ALLOWED_FIELD] === 'submitted',
          }),
        ),
        findReferences: jest.fn().mockReturnValue([]),
      };

      registryGet.mockImplementation((phase: string, type: string) =>
        phase === 'validator' && type === 'screen_fields_required'
          ? validator
          : undefined,
      );

      const lockedTask = makeTask();
      const updatedTask = {
        ...lockedTask,
        status_id: TO_STATUS,
        version: 4,
        custom_field_values: { [ALLOWED_FIELD]: 'submitted' },
      };
      const graph = buildGraphTables(
        makeWorkflow(),
        [
          {
            id: FROM_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: FROM_STATUS,
          },
          {
            id: TO_NODE,
            workflow_id: WF_ID,
            kind: 'status',
            status_id: TO_STATUS,
          },
        ],
        [
          {
            id: TRANSITION_ID,
            workflow_id: WF_ID,
            name: 'Approve',
            kind: 'regular',
            to_node_id: TO_NODE,
            screen_field_group_id: FIELD_GROUP,
            conditions: [],
            validators: [
              {
                type: 'screen_fields_required',
                screen_field_group_id: FIELD_GROUP,
              },
            ],
            post_functions: [],
            triggers: [],
            sort_order: 0,
          },
        ],
        [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
        lockedTask,
        [],
        [],
        { data: updatedTask, error: null },
      );

      wireScreenFieldLookup(
        graph,
        [ALLOWED_FIELD, DISALLOWED_FIELD],
        [ALLOWED_FIELD],
      );

      const client = buildMockClient({
        tables: graph,
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: lockedTask, error: null }),
        },
      });

      const engine = buildEngine(client);

      await engine.executeTransition({
        taskId: TASK_ID,
        transitionId: TRANSITION_ID,
        screenInput: { [ALLOWED_FIELD]: 'submitted' },
        user: makeUser(),
      });

      expect(validator.validate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          transition: expect.objectContaining({
            required_field_ids: [ALLOWED_FIELD],
          }),
        }),
      );
    });

    it('accepts all screen_input keys when screen_field_group_id is null (legacy compat)', async () => {
      registryGet.mockImplementation(() => undefined);
      const lockedTask = makeTask();
      const updatedTask = {
        ...lockedTask,
        status_id: TO_STATUS,
        version: 4,
      };

      const taskUpdates: Array<Record<string, unknown>> = [];
      const client = buildMockClient({
        tables: buildGraphTables(
          makeWorkflow(),
          [
            {
              id: FROM_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: FROM_STATUS,
            },
            {
              id: TO_NODE,
              workflow_id: WF_ID,
              kind: 'status',
              status_id: TO_STATUS,
            },
          ],
          [
            {
              id: TRANSITION_ID,
              workflow_id: WF_ID,
              name: 'Approve',
              kind: 'regular',
              to_node_id: TO_NODE,
              screen_field_group_id: null, // legacy compat — no filtering
              conditions: [],
              validators: [],
              post_functions: [],
              triggers: [],
              sort_order: 0,
            },
          ],
          [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
          lockedTask,
          [],
          [],
          { data: updatedTask, error: null },
          {
            update: jest
              .fn()
              .mockImplementation((patch: Record<string, unknown>) => {
                taskUpdates.push(patch);

                return {
                  eq: () => ({
                    eq: () => ({
                      select: () => ({
                        single: () =>
                          Promise.resolve({ data: updatedTask, error: null }),
                      }),
                    }),
                  }),
                };
              }),
          },
        ),
        rpcs: {
          begin_atomic_transition: jest
            .fn()
            .mockResolvedValue({ data: lockedTask, error: null }),
        },
      });

      const engine = buildEngine(client);

      await engine.executeTransition({
        taskId: TASK_ID,
        transitionId: TRANSITION_ID,
        screenInput: {
          [ALLOWED_FIELD]: 'one',
          [DISALLOWED_FIELD]: 'two',
        },
        user: makeUser(),
      });

      // Without a screen_field_group_id, no filtering: both keys land.
      const statusUpdate = taskUpdates.find(
        (u) => u.status_id === TO_STATUS,
      ) as { custom_field_values?: Record<string, unknown> };

      expect(statusUpdate.custom_field_values).toEqual({
        [ALLOWED_FIELD]: 'one',
        [DISALLOWED_FIELD]: 'two',
      });
    });

    it.each([
      ['done', true, null, 'done'],
      ['selected_for_development', false, { key: 'todo' }, 'open'],
      ['custom_review', false, { key: 'in_progress' }, 'in_progress'],
      ['custom_complete', true, { key: 'done' }, 'done'],
      ['custom_cancel', true, [{ key: 'cancelled' }], 'closed'],
      ['custom_no_category', true, null, 'done'],
    ])(
      'maps workflow status %s to its legacy bucket',
      async (key, completed, category, legacy) => {
        registryGet.mockImplementation(() => undefined);
        const lockedTask = makeTask();
        const updatedTask = {
          ...lockedTask,
          status: legacy,
          status_id: TO_STATUS,
          version: 4,
        };
        const taskUpdates: Array<Record<string, unknown>> = [];

        const client = buildMockClient({
          tables: buildGraphTables(
            makeWorkflow(),
            [
              {
                id: FROM_NODE,
                workflow_id: WF_ID,
                kind: 'status',
                status_id: FROM_STATUS,
              },
              {
                id: TO_NODE,
                workflow_id: WF_ID,
                kind: 'status',
                status_id: TO_STATUS,
              },
            ],
            [
              {
                id: TRANSITION_ID,
                workflow_id: WF_ID,
                name: 'Resolve',
                kind: 'regular',
                to_node_id: TO_NODE,
                screen_field_group_id: null,
                conditions: [],
                validators: [],
                post_functions: [],
                triggers: [],
                sort_order: 0,
              },
            ],
            [{ transition_id: TRANSITION_ID, from_node_id: FROM_NODE }],
            lockedTask,
            [],
            [],
            { data: updatedTask, error: null },
            {
              update: jest
                .fn()
                .mockImplementation((patch: Record<string, unknown>) => {
                  taskUpdates.push(patch);

                  return {
                    eq: () => ({
                      eq: () => ({
                        select: () => ({
                          single: () =>
                            Promise.resolve({ data: updatedTask, error: null }),
                        }),
                      }),
                    }),
                  };
                }),
            },
            { key, is_completed: completed, status_categories: category },
          ),
          rpcs: {
            begin_atomic_transition: jest
              .fn()
              .mockResolvedValue({ data: lockedTask, error: null }),
          },
        });

        const engine = buildEngine(client);

        await engine.executeTransition({
          taskId: TASK_ID,
          transitionId: TRANSITION_ID,
          user: makeUser(),
        });

        const statusUpdate = taskUpdates.find((u) => u.status_id === TO_STATUS);

        expect(statusUpdate).toEqual(
          expect.objectContaining({
            status: legacy,
            status_id: TO_STATUS,
            completed_at: completed ? expect.any(String) : null,
          }),
        );
      },
    );
  });
});
