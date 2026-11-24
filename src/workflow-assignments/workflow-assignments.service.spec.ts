/**
 * @fileoverview Unit tests for WorkflowAssignmentsService — covers the
 * findActiveAssignmentForType resolver used by the workflow engine plus the
 * P7 admin-migration paths through update()/delete() that wire the
 * migrate_tasks_for_assignment_change RPC, the orphan-conflict detector
 * (post BLOCKER fix), and the per-orphan suggestMapping helper.
 * @module src/workflow-assignments/workflow-assignments.service.spec
 * @author Rajbha Manek
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { WorkflowAssignmentsService } from './workflow-assignments.service';
import type { WorkflowAssignment } from './workflow-assignments.service';

interface ResolvedRow {
  data: unknown;
  error: unknown;
  count?: number | null;
}

interface MockChain {
  select: jest.Mock;
  eq: jest.Mock;
  in: jest.Mock;
  or: jest.Mock;
  not: jest.Mock;
  order: jest.Mock;
  limit: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  upsert: jest.Mock;
  delete: jest.Mock;
  single: jest.Mock;
  maybeSingle: jest.Mock;
  then: (onFulfilled: (v: unknown) => unknown) => Promise<unknown>;
}

describe('WorkflowAssignmentsService', () => {
  let service: WorkflowAssignmentsService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;
  let auditLogsService: { createLog: jest.Mock; logAction: jest.Mock };

  const ORG = 'org-1';
  const SPACE = 'space-1';
  const LEVEL = 'level-1';
  const ACTOR = 'user-1';

  function buildChain(resolved: ResolvedRow): MockChain {
    const chain: Partial<MockChain> = {};
    const self = (): MockChain => chain as MockChain;

    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
    chain.not = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.upsert = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);

    return chain as MockChain;
  }

  /**
   * Router helper: lets a test register one chain per table. Each `from(table)`
   * returns the chain configured for that table; an unrecognised table fails
   * the test loudly so we don't accidentally let a query through unmocked.
   */
  function buildTableRouter(tables: Record<string, MockChain>): jest.Mock {
    return jest.fn((tableName: string) => {
      // Use `in` so we don't trigger no-misused-promises on the thenable chain.
      if (!(tableName in tables)) {
        throw new Error(`Unexpected from(${tableName}) call in test`);
      }

      return tables[tableName];
    });
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    mockRpc = jest.fn();
    auditLogsService = {
      createLog: jest.fn().mockResolvedValue(undefined),
      logAction: jest.fn().mockResolvedValue(undefined),
    };
    const supa = {
      getClient: () => ({ from: mockFrom, rpc: mockRpc }),
    } as unknown as SupabaseAdminService;

    service = new WorkflowAssignmentsService(
      supa,
      auditLogsService as unknown as AuditLogsService,
    );
  });

  function makeAssignment(
    overrides: Partial<WorkflowAssignment> = {},
  ): WorkflowAssignment {
    return {
      id: 'asgn-1',
      organization_id: ORG,
      space_id: SPACE,
      task_type_level_id: LEVEL,
      workflow_id: 'wf-1',
      is_default: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  describe('findActiveAssignmentForType', () => {
    it('does not swallow schema-cache connectivity failures during task creation', async () => {
      mockFrom.mockReturnValue(
        buildChain({
          data: null,
          error: {
            message: 'Could not query the database for the schema cache',
            code: 'PGRST002',
          },
          status: 503,
        } as never),
      );
      await expect(
        service.findActiveAssignmentForType(ORG, SPACE, LEVEL),
      ).rejects.toMatchObject({ cause: { status: 503, code: 'PGRST002' } });
    });
    it('returns the type-specific row when it exists', async () => {
      const specific = makeAssignment({
        id: 'asgn-specific',
        task_type_level_id: LEVEL,
        is_default: false,
      });
      const chain = buildChain({ data: [specific], error: null });

      mockFrom.mockReturnValue(chain);

      const result = await service.findActiveAssignmentForType(
        ORG,
        SPACE,
        LEVEL,
      );

      expect(result).not.toBeNull();
      expect(result?.id).toBe('asgn-specific');
      expect(result?.task_type_level_id).toBe(LEVEL);

      expect(mockFrom).toHaveBeenCalledWith('workflow_assignments');
      expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(chain.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(chain.in).toHaveBeenCalledWith('task_type_level_id', [LEVEL, '*']);
    });

    it('falls back to the org-default wildcard when no type-specific row exists', async () => {
      const wildcard = makeAssignment({
        id: 'asgn-wildcard',
        task_type_level_id: '*',
        is_default: true,
      });
      const chain = buildChain({ data: [wildcard], error: null });

      mockFrom.mockReturnValue(chain);

      const result = await service.findActiveAssignmentForType(
        ORG,
        SPACE,
        LEVEL,
      );

      expect(result).not.toBeNull();
      expect(result?.id).toBe('asgn-wildcard');
      expect(result?.task_type_level_id).toBe('*');
    });

    it('returns null when neither a type-specific nor wildcard row exists', async () => {
      const chain = buildChain({ data: [], error: null });

      mockFrom.mockReturnValue(chain);

      const result = await service.findActiveAssignmentForType(
        ORG,
        SPACE,
        LEVEL,
      );

      expect(result).toBeNull();
    });
  });

  describe('create()', () => {
    it('inserts the row and writes a single create audit log', async () => {
      const created = makeAssignment({ id: 'asgn-new' });
      const spaces = buildChain({ data: { id: SPACE }, error: null });
      const workflows = buildChain({
        data: { id: 'wf-1', initial_status_id: 's1' },
        error: null,
      });
      const assignments = buildChain({ data: created, error: null });

      mockFrom.mockImplementation(
        buildTableRouter({
          spaces,
          workflows,
          workflow_assignments: assignments,
        }),
      );

      const result = await service.create(
        ORG,
        {
          space_id: SPACE,
          task_type_level_id: LEVEL,
          workflow_id: 'wf-1',
        },
        ACTOR,
      );

      expect(result.id).toBe('asgn-new');
      expect(auditLogsService.logAction).toHaveBeenCalledTimes(1);
      expect(auditLogsService.logAction).toHaveBeenCalledWith(
        ORG,
        ACTOR,
        'workflow_assignment',
        'asgn-new',
        'create',
        expect.objectContaining({
          space_id: SPACE,
          task_type_level_id: LEVEL,
          workflow_id: 'wf-1',
        }),
      );
      expect(auditLogsService.createLog).not.toHaveBeenCalled();
    });

    it('rejects assigning a workflow with no initial status (422) and never inserts', async () => {
      const spaces = buildChain({ data: { id: SPACE }, error: null });
      const workflows = buildChain({
        data: { id: 'wf-1', initial_status_id: null },
        error: null,
      });
      const assignments = buildChain({ data: null, error: null });

      mockFrom.mockImplementation(
        buildTableRouter({
          spaces,
          workflows,
          workflow_assignments: assignments,
        }),
      );

      await expect(
        service.create(
          ORG,
          {
            space_id: SPACE,
            task_type_level_id: LEVEL,
            workflow_id: 'wf-1',
          },
          ACTOR,
        ),
      ).rejects.toThrow('no initial status');

      expect(assignments.insert).not.toHaveBeenCalled();
      expect(auditLogsService.logAction).not.toHaveBeenCalled();
    });

    it('rejects assigning a space-scoped workflow to a different space and never inserts', async () => {
      const spaces = buildChain({ data: { id: SPACE }, error: null });
      const workflows = buildChain({
        data: { id: 'wf-1', initial_status_id: 's1', space_id: 'space-2' },
        error: null,
      });
      const assignments = buildChain({ data: null, error: null });

      mockFrom.mockImplementation(
        buildTableRouter({
          spaces,
          workflows,
          workflow_assignments: assignments,
        }),
      );

      await expect(
        service.create(
          ORG,
          {
            space_id: SPACE,
            task_type_level_id: LEVEL,
            workflow_id: 'wf-1',
          },
          ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(assignments.insert).not.toHaveBeenCalled();
      expect(auditLogsService.logAction).not.toHaveBeenCalled();
    });
  });

  describe('update() — migration paths', () => {
    /**
     * Helper that wires the chain map for the typical update() flow:
     *   1. getById → workflow_assignments (maybeSingle)
     *   2. new workflow lookup → workflows (maybeSingle)
     *   3. detectOrphanConflict → workflow_nodes (old + new) + tasks (count)
     *   4. when migration_map is supplied → suggestMapping → workflow_nodes + task_statuses
     *   5. when no migration_map → straight UPDATE path → workflow_assignments
     */
    function wireUpdateChains(opts: {
      existing: WorkflowAssignment;
      newWorkflowExists?: boolean;
      oldStatusIds: string[];
      newStatusIds: string[];
      orphanTaskCount: number;
      taskStatuses?: Array<{
        id: string;
        key: string | null;
        name: string | null;
        category_id: string | null;
        sort_order: number | null;
      }>;
      finalAssignment?: WorkflowAssignment;
    }) {
      // 1. getById — workflow_assignments .maybeSingle()
      // 5. UPDATE — workflow_assignments .single()
      // We share one chain object across both. .maybeSingle resolves to the
      // existing row; .single resolves to the patched row.
      const assignmentsChain = buildChain({
        data: opts.existing,
        error: null,
      });

      assignmentsChain.maybeSingle = jest
        .fn()
        .mockResolvedValueOnce({ data: opts.existing, error: null });

      if (opts.finalAssignment) {
        assignmentsChain.single = jest
          .fn()
          .mockResolvedValueOnce({ data: opts.finalAssignment, error: null });
      }

      // 2. workflows lookup — single .maybeSingle call
      const workflowsChain = buildChain({
        data:
          opts.newWorkflowExists === false
            ? null
            : { id: 'wf-2', initial_status_id: 's1' },
        error: null,
      });

      // 3. workflow_nodes — called 3 times (old, new in detectOrphanConflict;
      //    then suggestMapping calls it once more for the target). We use a
      //    single chain whose `then` queue cycles through OLD → NEW → TARGET.
      const oldNodesPayload = {
        data: opts.oldStatusIds.map((id) => ({ status_id: id })),
        error: null,
      };
      const newNodesPayload = {
        data: opts.newStatusIds.map((id) => ({ status_id: id })),
        error: null,
      };
      const targetNodesPayload = {
        data: opts.newStatusIds.map((id) => ({ status_id: id })),
        error: null,
      };
      const nodesQueue = [oldNodesPayload, newNodesPayload, targetNodesPayload];
      const nodesChain = buildChain(oldNodesPayload);

      nodesChain.then = (onFulfilled) => {
        const next = nodesQueue.shift() ?? oldNodesPayload;

        return Promise.resolve(next).then(onFulfilled);
      };

      // 4. tasks count — head:true
      const tasksChain = buildChain({
        data: null,
        error: null,
        count: opts.orphanTaskCount,
      });

      // 5. task_statuses lookup for suggestMapping
      const statusesChain = buildChain({
        data: opts.taskStatuses ?? [],
        error: null,
      });

      mockFrom.mockImplementation(
        buildTableRouter({
          workflow_assignments: assignmentsChain,
          workflows: workflowsChain,
          workflow_nodes: nodesChain,
          tasks: tasksChain,
          task_statuses: statusesChain,
        }),
      );

      return {
        assignmentsChain,
        workflowsChain,
        nodesChain,
        tasksChain,
        statusesChain,
      };
    }

    it('throws ConflictException with all three IWorkflowConflict fields when orphans exist and no migration_map is provided', async () => {
      const existing = makeAssignment({ workflow_id: 'wf-1' });

      wireUpdateChains({
        existing,
        oldStatusIds: ['status-old', 'status-shared'],
        newStatusIds: ['status-shared'],
        orphanTaskCount: 5,
        taskStatuses: [
          {
            id: 'status-old',
            key: 'in_progress',
            name: 'In Progress',
            category_id: 'cat-todo',
            sort_order: 2,
          },
          {
            id: 'status-shared',
            key: 'shared',
            name: 'Shared',
            category_id: 'cat-todo',
            sort_order: 1,
          },
        ],
      });

      let caught: ConflictException | undefined;

      try {
        await service.update('asgn-1', ORG, { workflow_id: 'wf-2' }, ACTOR);
      } catch (err) {
        caught = err as ConflictException;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      const body = caught?.getResponse() as {
        message: string;
        data: {
          affected_count: number;
          orphan_statuses: string[];
          suggested_mappings: Record<string, string | null>;
        };
      };

      expect(body.data.affected_count).toBe(5);
      expect(body.data.orphan_statuses).toEqual(['status-old']);
      expect(body.data.suggested_mappings).toHaveProperty('status-old');
      // status-old shares category cat-todo with status-shared → category match wins
      expect(body.data.suggested_mappings['status-old']).toBe('status-shared');
    });

    it('runs the migration RPC with locked parameters and writes a single workflow.assignment.changed audit row', async () => {
      const existing = makeAssignment({ workflow_id: 'wf-1' });
      const updated = makeAssignment({ workflow_id: 'wf-2' });

      // Wire chains for the orphan-detection arm; suggestMapping won't run
      // again from the RPC path (it ran inside detectOrphanConflict to build
      // the conflict payload, but the RPC itself does the actual migration).
      wireUpdateChains({
        existing,
        oldStatusIds: ['status-old'],
        newStatusIds: ['status-new'],
        orphanTaskCount: 3,
        taskStatuses: [
          {
            id: 'status-old',
            key: 'open',
            name: 'Open',
            category_id: null,
            sort_order: 1,
          },
          {
            id: 'status-new',
            key: 'open',
            name: 'Open',
            category_id: null,
            sort_order: 1,
          },
        ],
      });

      mockRpc.mockResolvedValueOnce({
        data: {
          tasks_migrated: 3,
          orphan_count: 1,
          migrated_task_ids: ['task-1', 'task-2', 'task-3'],
          truncated: false,
          assignment: updated,
        },
        error: null,
      });

      const result = await service.update(
        'asgn-1',
        ORG,
        {
          workflow_id: 'wf-2',
          migration_map: { 'status-old': 'status-new' },
        },
        ACTOR,
      );

      expect(result.workflow_id).toBe('wf-2');
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith(
        'migrate_tasks_for_assignment_change',
        {
          p_assignment_id: 'asgn-1',
          p_new_workflow_id: 'wf-2',
          p_migration_map: { 'status-old': 'status-new' },
          p_user_id: ACTOR,
          p_organization_id: ORG,
        },
      );

      expect(auditLogsService.createLog).toHaveBeenCalledTimes(1);
      const createLogArgs = auditLogsService.createLog.mock.calls[0] as [
        string,
        string,
        {
          entity_type: string;
          entity_id: string;
          action: string;
          changes: Record<string, unknown>;
        },
      ];

      expect(createLogArgs[0]).toBe(ORG);
      expect(createLogArgs[1]).toBe(ACTOR);
      expect(createLogArgs[2].entity_type).toBe('workflow_assignment');
      expect(createLogArgs[2].entity_id).toBe('asgn-1');
      expect(createLogArgs[2].action).toBe('workflow.assignment.changed');
      expect(createLogArgs[2].changes).toMatchObject({
        from_workflow_id: 'wf-1',
        to_workflow_id: 'wf-2',
        space_id: SPACE,
        task_type_level_id: LEVEL,
        migration_map: { 'status-old': 'status-new' },
        tasks_migrated_count: 3,
        orphan_count: 1,
        migrated_tasks: ['task-1', 'task-2', 'task-3'],
        migrated_tasks_truncated: false,
      });
      // The migration path must NOT also write a CRUD 'update' audit row.
      expect(auditLogsService.logAction).not.toHaveBeenCalled();
    });

    it('throws BadRequestException BEFORE calling the RPC when migration_map is missing entries', async () => {
      const existing = makeAssignment({ workflow_id: 'wf-1' });

      wireUpdateChains({
        existing,
        oldStatusIds: ['status-a', 'status-b'],
        newStatusIds: ['status-c'],
        orphanTaskCount: 7,
        taskStatuses: [
          {
            id: 'status-a',
            key: 'a',
            name: 'A',
            category_id: null,
            sort_order: 1,
          },
          {
            id: 'status-b',
            key: 'b',
            name: 'B',
            category_id: null,
            sort_order: 2,
          },
          {
            id: 'status-c',
            key: 'c',
            name: 'C',
            category_id: null,
            sort_order: 1,
          },
        ],
      });

      // migration_map covers 'status-a' only — 'status-b' is missing → 400.
      let caught: BadRequestException | undefined;

      try {
        await service.update(
          'asgn-1',
          ORG,
          {
            workflow_id: 'wf-2',
            migration_map: { 'status-a': 'status-c' },
          },
          ACTOR,
        );
      } catch (err) {
        caught = err as BadRequestException;
      }

      expect(caught).toBeInstanceOf(BadRequestException);
      const body = caught?.getResponse() as {
        message: string;
        missing: string[];
      };

      expect(body.missing).toEqual(['status-b']);
      // Critically: the RPC must NOT have been called yet.
      expect(mockRpc).not.toHaveBeenCalled();
      expect(auditLogsService.createLog).not.toHaveBeenCalled();
    });

    it('short-circuits when dto.workflow_id matches the existing assignment (idempotent no-op)', async () => {
      const existing = makeAssignment({ workflow_id: 'wf-1' });

      // Only getById needs to fire — no other queries, no RPC, no audit.
      const assignmentsChain = buildChain({ data: existing, error: null });

      assignmentsChain.maybeSingle = jest
        .fn()
        .mockResolvedValueOnce({ data: existing, error: null });

      mockFrom.mockImplementation(
        buildTableRouter({ workflow_assignments: assignmentsChain }),
      );

      const result = await service.update(
        'asgn-1',
        ORG,
        { workflow_id: 'wf-1' },
        ACTOR,
      );

      expect(result).toBe(existing);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(auditLogsService.createLog).not.toHaveBeenCalled();
      expect(auditLogsService.logAction).not.toHaveBeenCalled();
      // workflows table should never be queried in the short-circuit path.
      expect(mockFrom).not.toHaveBeenCalledWith('workflows');
    });

    it('rejects updating to a space-scoped workflow from another space before conflict scans', async () => {
      const existing = makeAssignment({ workflow_id: 'wf-1', space_id: SPACE });
      const assignmentsChain = buildChain({ data: existing, error: null });

      assignmentsChain.maybeSingle = jest
        .fn()
        .mockResolvedValueOnce({ data: existing, error: null });

      const workflowsChain = buildChain({
        data: { id: 'wf-2', initial_status_id: 's1', space_id: 'space-2' },
        error: null,
      });

      mockFrom.mockImplementation(
        buildTableRouter({
          workflow_assignments: assignmentsChain,
          workflows: workflowsChain,
        }),
      );

      await expect(
        service.update('asgn-1', ORG, { workflow_id: 'wf-2' }, ACTOR),
      ).rejects.toThrow(BadRequestException);

      expect(mockFrom).not.toHaveBeenCalledWith('workflow_nodes');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(assignmentsChain.update).not.toHaveBeenCalled();
      expect(auditLogsService.createLog).not.toHaveBeenCalled();
      expect(auditLogsService.logAction).not.toHaveBeenCalled();
    });
  });

  describe('delete() — orphaned-task gating', () => {
    function wireDeleteChains(opts: {
      existing: WorkflowAssignment;
      statusIds: string[];
      orphanTaskCount: number;
      deleteError?: { code?: string; message: string } | null;
    }) {
      const assignmentsChain = buildChain({
        data: opts.existing,
        error: null,
      });

      assignmentsChain.maybeSingle = jest
        .fn()
        .mockResolvedValueOnce({ data: opts.existing, error: null });
      assignmentsChain.then = (onFulfilled) =>
        Promise.resolve({ data: null, error: opts.deleteError ?? null }).then(
          onFulfilled,
        );

      const nodesChain = buildChain({
        data: opts.statusIds.map((id) => ({ status_id: id })),
        error: null,
      });
      const tasksChain = buildChain({
        data: null,
        error: null,
        count: opts.orphanTaskCount,
      });

      mockFrom.mockImplementation(
        buildTableRouter({
          workflow_assignments: assignmentsChain,
          workflow_nodes: nodesChain,
          tasks: tasksChain,
        }),
      );

      return { assignmentsChain, nodesChain, tasksChain };
    }

    it('throws ConflictException when live tasks exist and acknowledge_orphaned_tasks is not set', async () => {
      const existing = makeAssignment();

      wireDeleteChains({
        existing,
        statusIds: ['status-x'],
        orphanTaskCount: 4,
      });

      let caught: ConflictException | undefined;

      try {
        await service.delete(
          'asgn-1',
          ORG,
          { acknowledge_orphaned_tasks: false },
          ACTOR,
        );
      } catch (err) {
        caught = err as ConflictException;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      const body = caught?.getResponse() as {
        message: string;
        data: {
          affected_count: number;
          orphan_statuses: string[];
          suggested_mappings: Record<string, string | null>;
        };
      };

      expect(body.data.affected_count).toBe(4);
      expect(body.data.orphan_statuses).toEqual(['status-x']);
      // Delete has no target workflow, so suggested_mappings is always empty.
      expect(body.data.suggested_mappings).toEqual({});
      expect(auditLogsService.logAction).not.toHaveBeenCalled();
    });

    it('proceeds and writes a delete audit when acknowledge_orphaned_tasks=true', async () => {
      const existing = makeAssignment();

      wireDeleteChains({
        existing,
        statusIds: ['status-x'],
        orphanTaskCount: 4,
      });

      await service.delete(
        'asgn-1',
        ORG,
        { acknowledge_orphaned_tasks: true },
        ACTOR,
      );

      expect(auditLogsService.logAction).toHaveBeenCalledTimes(1);
      expect(auditLogsService.logAction).toHaveBeenCalledWith(
        ORG,
        ACTOR,
        'workflow_assignment',
        'asgn-1',
        'delete',
        expect.objectContaining({
          space_id: SPACE,
          workflow_id: 'wf-1',
        }),
      );
      expect(auditLogsService.createLog).not.toHaveBeenCalled();
    });
  });

  describe('detectOrphanConflict — BLOCKER regression', () => {
    it('does NOT call .eq("organization_id", …) on workflow_nodes queries', async () => {
      const existing = makeAssignment({ workflow_id: 'wf-1' });
      const assignmentsChain = buildChain({ data: existing, error: null });

      assignmentsChain.maybeSingle = jest
        .fn()
        .mockResolvedValueOnce({ data: existing, error: null });

      const workflowsChain = buildChain({
        data: { id: 'wf-2', initial_status_id: 's1' },
        error: null,
      });
      const nodesChain = buildChain({ data: [], error: null });
      const tasksChain = buildChain({ data: null, error: null, count: 0 });

      mockFrom.mockImplementation(
        buildTableRouter({
          workflow_assignments: assignmentsChain,
          workflows: workflowsChain,
          workflow_nodes: nodesChain,
          tasks: tasksChain,
        }),
      );

      // Provide a final-assignment row for the straight UPDATE path that
      // executes once detectOrphanConflict returns null (no orphans).
      assignmentsChain.single = jest.fn().mockResolvedValueOnce({
        data: makeAssignment({ workflow_id: 'wf-2' }),
        error: null,
      });

      await service.update('asgn-1', ORG, { workflow_id: 'wf-2' }, ACTOR);

      // Every .eq() call on the workflow_nodes chain must scope by workflow_id
      // or kind — NEVER by organization_id (column doesn't exist on that table).
      const eqCalls = nodesChain.eq.mock.calls as unknown as unknown[][];

      for (const call of eqCalls) {
        expect(call[0]).not.toBe('organization_id');
      }
      // Sanity: at least one of the calls must scope by workflow_id, proving
      // the chain was actually exercised.
      expect(eqCalls.some((c) => c[0] === 'workflow_id')).toBe(true);
    });
  });

  describe('suggestMapping (via detectOrphanConflict)', () => {
    it('prefers exact key match over category match over first-available', async () => {
      const existing = makeAssignment({ workflow_id: 'wf-1' });

      const assignmentsChain = buildChain({ data: existing, error: null });

      assignmentsChain.maybeSingle = jest
        .fn()
        .mockResolvedValueOnce({ data: existing, error: null });

      const workflowsChain = buildChain({
        data: { id: 'wf-2', initial_status_id: 's1' },
        error: null,
      });

      // Three orphans, each exercising a different priority rule.
      const oldStatusIds = ['orphan-exact', 'orphan-category', 'orphan-none'];
      const newStatusIds = ['target-match', 'target-cat', 'target-first'];
      const oldNodes = {
        data: oldStatusIds.map((id) => ({ status_id: id })),
        error: null,
      };
      const newNodes = {
        data: newStatusIds.map((id) => ({ status_id: id })),
        error: null,
      };
      // suggestMapping re-queries workflow_nodes for the target set.
      const targetNodes = {
        data: newStatusIds.map((id) => ({ status_id: id })),
        error: null,
      };
      const nodesQueue = [oldNodes, newNodes, targetNodes];
      const nodesChain = buildChain(oldNodes);

      nodesChain.then = (onFulfilled) => {
        const next = nodesQueue.shift() ?? oldNodes;

        return Promise.resolve(next).then(onFulfilled);
      };

      const tasksChain = buildChain({ data: null, error: null, count: 12 });
      const statusesChain = buildChain({
        data: [
          // Orphans
          {
            id: 'orphan-exact',
            key: 'done',
            name: 'Done',
            category_id: 'cat-done',
            sort_order: 9,
          },
          {
            id: 'orphan-category',
            key: 'review',
            name: 'Review',
            category_id: 'cat-mid',
            sort_order: 4,
          },
          {
            id: 'orphan-none',
            key: 'archived',
            name: 'Archived',
            category_id: 'cat-archived',
            sort_order: 99,
          },
          // Targets
          {
            id: 'target-match',
            key: 'done',
            name: 'Completed',
            category_id: 'cat-different',
            sort_order: 30,
          },
          {
            id: 'target-cat',
            key: 'inprogress',
            name: 'In Progress',
            category_id: 'cat-mid',
            sort_order: 20,
          },
          {
            id: 'target-first',
            key: 'todo',
            name: 'To Do',
            category_id: 'cat-todo',
            sort_order: 10,
          },
        ],
        error: null,
      });

      mockFrom.mockImplementation(
        buildTableRouter({
          workflow_assignments: assignmentsChain,
          workflows: workflowsChain,
          workflow_nodes: nodesChain,
          tasks: tasksChain,
          task_statuses: statusesChain,
        }),
      );

      let caught: ConflictException | undefined;

      try {
        await service.update('asgn-1', ORG, { workflow_id: 'wf-2' }, ACTOR);
      } catch (err) {
        caught = err as ConflictException;
      }

      const body = caught?.getResponse() as {
        data: { suggested_mappings: Record<string, string | null> };
      };

      // Rule 1: exact key match (done → done)
      expect(body.data.suggested_mappings['orphan-exact']).toBe('target-match');
      // Rule 2: shared cat-mid category → target-cat
      expect(body.data.suggested_mappings['orphan-category']).toBe(
        'target-cat',
      );
      // Rule 3: no key match, no shared category → first by sort_order (target-first)
      expect(body.data.suggested_mappings['orphan-none']).toBe('target-first');
    });
  });

  describe('NotFoundException coverage', () => {
    it('throws NotFoundException when getById finds nothing', async () => {
      const assignmentsChain = buildChain({ data: null, error: null });

      mockFrom.mockImplementation(
        buildTableRouter({ workflow_assignments: assignmentsChain }),
      );

      await expect(service.getById('missing', ORG)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
