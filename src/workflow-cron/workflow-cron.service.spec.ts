/**
 * @fileoverview Unit tests for WorkflowCronService — verifies the jitter-safe
 * due computation, deterministic execution-id, kind/actor skip rules,
 * per-task error isolation, and that the enumeration query is scoped to
 * active + non-draft workflows. The Supabase client and WorkflowEngineService
 * are mocked; `Date.now` is stubbed so the due window is deterministic.
 * @module src/workflow-cron/workflow-cron.service.spec
 * @author Rajbha Manek
 */

import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { WorkflowEngineService } from '../workflow-engine/workflow-engine.service';
import { WorkflowCronService } from './workflow-cron.service';

const ORG = 'org-1';
const WORKFLOW_ID = 'wf-1';
const TRANSITION_ID = 'txn-1';
const SPACE_ID = 'space-1';
const CREATED_BY = 'user-1';
const TASK_1 = 'task-1';
const TASK_2 = 'task-2';

// A minute past the top of the minute so the (now-61s, now] window always
// contains the previous minute boundary for a `* * * * *` expression.
const FIXED_NOW = Date.UTC(2026, 6, 15, 12, 0, 30);

// The scheduled occurrence a `* * * * *` cron lands on inside that window.
const EXPECTED_ISO = new Date(Date.UTC(2026, 6, 15, 12, 0, 0)).toISOString();

/** Per-table `{ data, error }` results the mocked Supabase client returns. */
interface ITableResults {
  [table: string]: { data: unknown; error: { message: string } | null };
}

/**
 * Build a table-aware Supabase admin mock. Every builder method returns the
 * chain (recording its call), the chain is awaitable via `then`, and
 * `maybeSingle()` resolves to the same table result. `recorded[table]` holds
 * the ordered `[method, ...args]` tuples so tests can assert query shape.
 */
function buildSupabaseMock(results: ITableResults): {
  admin: SupabaseAdminService;
  from: jest.Mock;
  recorded: Record<string, unknown[][]>;
} {
  const recorded: Record<string, unknown[][]> = {};

  const from = jest.fn((table: string) => {
    recorded[table] ??= [];
    const result = results[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    const rec =
      (method: string) =>
      (...args: unknown[]) => {
        recorded[table].push([method, ...args]);

        return chain;
      };

    chain.select = jest.fn(rec('select'));
    chain.filter = jest.fn(rec('filter'));
    chain.eq = jest.fn(rec('eq'));
    chain.in = jest.fn(rec('in'));
    chain.order = jest.fn(rec('order'));
    chain.limit = jest.fn(rec('limit'));
    chain.maybeSingle = jest.fn(() => Promise.resolve(result));
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled);

    return chain;
  });

  const admin = {
    getClient: () => ({ from }),
  } as unknown as SupabaseAdminService;

  return { admin, from, recorded };
}

/** Stub engine whose executeTransition is a jest.fn() the test owns. */
function buildEngine(): {
  engine: WorkflowEngineService;
  executeTransition: jest.Mock;
} {
  const executeTransition = jest.fn().mockResolvedValue({});

  return {
    engine: { executeTransition } as unknown as WorkflowEngineService,
    executeTransition,
  };
}

/**
 * Build a single enumerated cron-transition row. Overrides let each test tweak
 * the kind, expression, or workflow join.
 */
function cronRow(
  overrides: {
    kind?: string;
    expression?: string;
    timezone?: string;
    createdBy?: string | null;
  } = {},
): Record<string, unknown> {
  return {
    id: TRANSITION_ID,
    workflow_id: WORKFLOW_ID,
    kind: overrides.kind ?? 'global',
    to_node_id: 'node-1',
    triggers: [
      {
        type: 'cron',
        expression: overrides.expression ?? '* * * * *',
        timezone: overrides.timezone ?? 'UTC',
      },
    ],
    workflows: {
      id: WORKFLOW_ID,
      organization_id: ORG,
      space_id: SPACE_ID,
      created_by:
        overrides.createdBy === undefined ? CREATED_BY : overrides.createdBy,
      is_active: true,
      is_draft: false,
    },
  };
}

const USER_RESULT = {
  data: { id: CREATED_BY, email: 'u@x.com', role: 'admin', is_active: true },
  error: null,
};
const ASSIGNMENT_RESULT = {
  data: [{ space_id: SPACE_ID, task_type_level_id: '*' }],
  error: null,
};

describe('WorkflowCronService', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('due cron trigger', () => {
    it('fires executeTransition with the deterministic execution-id and depth 0', async () => {
      const { admin } = buildSupabaseMock({
        workflow_transitions: { data: [cronRow()], error: null },
        users: USER_RESULT,
        workflow_assignments: ASSIGNMENT_RESULT,
        tasks: { data: [{ id: TASK_1 }], error: null },
      });
      const { engine, executeTransition } = buildEngine();
      const svc = new WorkflowCronService(admin, engine);

      const stats = await svc.runTick();

      expect(executeTransition).toHaveBeenCalledTimes(1);
      expect(executeTransition).toHaveBeenCalledWith({
        taskId: TASK_1,
        transitionId: TRANSITION_ID,
        screenInput: {},
        user: expect.objectContaining({
          userId: CREATED_BY,
          organizationId: ORG,
          appMetadata: { fired_by: 'workflow_trigger_cron' },
        }) as unknown,
        executionId: `cron:${TRANSITION_ID}:${TASK_1}:${EXPECTED_ISO}`,
        transitionDepth: 0,
      });
      expect(stats).toEqual({ due: 1, fired: 1, failed: 0 });
    });
  });

  describe('not-due cron trigger', () => {
    it('does not fire when the next occurrence is after now', async () => {
      const { admin } = buildSupabaseMock({
        // Yearly at Jan 1 00:00 — the next occurrence from the window is far
        // in the future, so occ > now → not due.
        workflow_transitions: {
          data: [cronRow({ expression: '0 0 1 1 *' })],
          error: null,
        },
        users: USER_RESULT,
        workflow_assignments: ASSIGNMENT_RESULT,
        tasks: { data: [{ id: TASK_1 }], error: null },
      });
      const { engine, executeTransition } = buildEngine();
      const svc = new WorkflowCronService(admin, engine);

      const stats = await svc.runTick();

      expect(executeTransition).not.toHaveBeenCalled();
      expect(stats).toEqual({ due: 0, fired: 0, failed: 0 });
    });
  });

  describe('initial transitions', () => {
    it('skips a kind="initial" transition entirely', async () => {
      const { admin } = buildSupabaseMock({
        workflow_transitions: {
          data: [cronRow({ kind: 'initial' })],
          error: null,
        },
        users: USER_RESULT,
        workflow_assignments: ASSIGNMENT_RESULT,
        tasks: { data: [{ id: TASK_1 }], error: null },
      });
      const { engine, executeTransition } = buildEngine();
      const svc = new WorkflowCronService(admin, engine);

      const stats = await svc.runTick();

      expect(executeTransition).not.toHaveBeenCalled();
      expect(stats.due).toBe(0);
    });
  });

  describe('missing actor', () => {
    it('skips the cron when the workflow has no created_by', async () => {
      const { admin } = buildSupabaseMock({
        workflow_transitions: {
          data: [cronRow({ createdBy: null })],
          error: null,
        },
        users: USER_RESULT,
        workflow_assignments: ASSIGNMENT_RESULT,
        tasks: { data: [{ id: TASK_1 }], error: null },
      });
      const { engine, executeTransition } = buildEngine();
      const svc = new WorkflowCronService(admin, engine);

      const stats = await svc.runTick();

      expect(executeTransition).not.toHaveBeenCalled();
      // Due was detected (window matched) but skipped for lack of identity.
      expect(stats).toEqual({ due: 1, fired: 0, failed: 0 });
    });
  });

  describe('per-task error isolation', () => {
    it('continues firing siblings when one task fire throws', async () => {
      const { admin } = buildSupabaseMock({
        workflow_transitions: { data: [cronRow()], error: null },
        users: USER_RESULT,
        workflow_assignments: ASSIGNMENT_RESULT,
        tasks: { data: [{ id: TASK_1 }, { id: TASK_2 }], error: null },
      });
      const { engine, executeTransition } = buildEngine();

      executeTransition
        .mockRejectedValueOnce(new Error('task 1 blew up'))
        .mockResolvedValueOnce({});

      const svc = new WorkflowCronService(admin, engine);

      const stats = await svc.runTick();

      expect(executeTransition).toHaveBeenCalledTimes(2);
      expect(executeTransition).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ taskId: TASK_2, transitionDepth: 0 }),
      );
      expect(stats).toEqual({ due: 1, fired: 1, failed: 1 });
    });
  });

  describe('enumeration filter', () => {
    it('scopes the enumeration to active, non-draft workflows with a cron trigger', async () => {
      const { admin, recorded } = buildSupabaseMock({
        workflow_transitions: { data: [], error: null },
      });
      const { engine } = buildEngine();
      const svc = new WorkflowCronService(admin, engine);

      await svc.runTick();

      const wtCalls = recorded['workflow_transitions'];

      expect(wtCalls).toEqual(
        expect.arrayContaining([
          ['filter', 'triggers', 'cs', '[{"type":"cron"}]'],
          ['eq', 'workflows.is_active', true],
          ['eq', 'workflows.is_draft', false],
        ]),
      );
    });
  });
});
