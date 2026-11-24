/**
 * @fileoverview Unit tests for WorkflowsService — focused on list enrichment
 * with nodes_count, transitions_count, and assignments_count.
 * @module src/workflows/workflows.service.spec
 * @author Rajbha Manek
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { WorkflowsService } from './workflows.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { WorkflowHealthService } from '../workflow-health/workflow-health.service';
import type { HandlerRegistryService } from '../workflow-engine/handlers/handler-registry.service';

// SVC-M2: publishDraft now requires the health service (the gate must not be
// silently skipped). In prod WorkflowHealthModule is always imported; in unit
// tests we inject a stub that reports no blocking errors.
const HEALTH_OK = {
  hasBlockingErrors: jest
    .fn()
    .mockResolvedValue({ blocked: false, errors: [] }),
  runLinter: jest.fn().mockResolvedValue([]),
} as unknown as WorkflowHealthService;

// saveCanvas now validates every transition rule through the handler registry
// (validateCanvasRules) and fails closed with a 400 when the registry is
// absent — it refuses to persist a canvas whose rules it cannot verify. In
// prod WorkflowsModule imports WorkflowEngineModule so the registry is always
// present; here we inject a stub that reports a clean canvas. The DTOs under
// test carry no conditions/validators/post_functions/triggers, so a real
// registry would likewise yield no issues and no references.
const REGISTRY_OK = {
  validateRule: jest.fn().mockReturnValue([]),
  collectReferences: jest.fn().mockReturnValue([]),
} as unknown as HandlerRegistryService;

describe('WorkflowsService', () => {
  let service: WorkflowsService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;

  const ORG = 'org-1';

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
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
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    mockRpc = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom, rpc: mockRpc }),
    } as unknown as SupabaseAdminService;
    service = new WorkflowsService(
      supa,
      undefined,
      undefined,
      HEALTH_OK,
      REGISTRY_OK,
    );
  });

  describe('getAll', () => {
    it('attaches nodes_count, transitions_count, assignments_count to each row', async () => {
      const workflowRows = [
        { id: 'w1', organization_id: ORG, name: 'Alpha' },
        { id: 'w2', organization_id: ORG, name: 'Beta' },
      ];

      const responseMap: Record<string, ReturnType<typeof buildChain>> = {
        workflows: buildChain({ data: workflowRows, error: null }),
        workflow_nodes: buildChain({
          data: [
            { workflow_id: 'w1' },
            { workflow_id: 'w1' },
            { workflow_id: 'w2' },
          ],
          error: null,
        }),
        workflow_transitions: buildChain({
          data: [{ workflow_id: 'w1' }],
          error: null,
        }),
        workflow_assignments: buildChain({ data: [], error: null }),
      };
      mockFrom.mockImplementation(
        (table: string) =>
          responseMap[table] ?? buildChain({ data: [], error: null }),
      );

      const result = await service.getAll(ORG);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('w1');
      expect(result[0].nodes_count).toBe(2);
      expect(result[0].transitions_count).toBe(1);
      expect(result[0].assignments_count).toBe(0);
      expect(result[1].id).toBe('w2');
      expect(result[1].nodes_count).toBe(1);
      expect(result[1].transitions_count).toBe(0);
      expect(result[1].assignments_count).toBe(0);
    });

    it('short-circuits when no workflows match — skips count queries', async () => {
      const responseMap: Record<string, ReturnType<typeof buildChain>> = {
        workflows: buildChain({ data: [], error: null }),
      };
      mockFrom.mockImplementation(
        (table: string) =>
          responseMap[table] ?? buildChain({ data: [], error: null }),
      );

      const result = await service.getAll(ORG);

      expect(result).toEqual([]);
      expect(mockFrom).toHaveBeenCalledTimes(1);
      expect(mockFrom).toHaveBeenCalledWith('workflows');
    });

    it('propagates count-query errors as BadRequestException', async () => {
      const workflowRows = [{ id: 'w1', organization_id: ORG, name: 'Alpha' }];
      const responseMap: Record<string, ReturnType<typeof buildChain>> = {
        workflows: buildChain({ data: workflowRows, error: null }),
        workflow_nodes: buildChain({
          data: null,
          error: { message: 'boom' },
        }),
        workflow_transitions: buildChain({ data: [], error: null }),
        workflow_assignments: buildChain({ data: [], error: null }),
      };
      mockFrom.mockImplementation(
        (table: string) =>
          responseMap[table] ?? buildChain({ data: [], error: null }),
      );

      await expect(service.getAll(ORG)).rejects.toThrow(BadRequestException);
      await expect(service.getAll(ORG)).rejects.toThrow('boom');
    });
  });

  describe('listTriggerEvents', () => {
    it('maps rows to camelCase and flattens the workflows(name) embed', async () => {
      const rows = [
        {
          id: 'evt-1',
          trigger_type: 'cron',
          outcome: 'fired',
          workflow_id: 'wf-1',
          transition_id: 'tr-1',
          subject_task_id: 'task-1',
          message: 'ok',
          context: { foo: 'bar' },
          created_at: '2026-07-15T00:00:00.000Z',
          workflows: { name: 'WF' },
        },
      ];

      const responseMap: Record<string, ReturnType<typeof buildChain>> = {
        workflow_trigger_events: buildChain({ data: rows, error: null }),
        tasks: buildChain({
          data: [{ id: 'task-1', key: 'BULK-T1', summary: 'Seed task' }],
          error: null,
        }),
      };
      mockFrom.mockImplementation(
        (table: string) =>
          responseMap[table] ?? buildChain({ data: [], error: null }),
      );

      const result = await service.listTriggerEvents(ORG);

      expect(mockFrom).toHaveBeenCalledWith('workflow_trigger_events');
      expect(result).toEqual([
        {
          id: 'evt-1',
          triggerType: 'cron',
          outcome: 'fired',
          workflowId: 'wf-1',
          workflowName: 'WF',
          transitionId: 'tr-1',
          subjectTaskId: 'task-1',
          subjectTaskKey: 'BULK-T1',
          subjectTaskName: 'Seed task',
          message: 'ok',
          context: { foo: 'bar' },
          createdAt: '2026-07-15T00:00:00.000Z',
        },
      ]);
    });

    it('leaves the subject task key/name null when the id resolves to no task', async () => {
      const rows = [
        {
          id: 'evt-2',
          trigger_type: 'parent_transitioned',
          outcome: 'no_op',
          workflow_id: 'wf-1',
          transition_id: 'tr-1',
          subject_task_id: 'task-gone',
          message: 'Transition not available from current status',
          context: null,
          created_at: '2026-07-15T00:00:00.000Z',
          workflows: { name: 'WF' },
        },
      ];

      const responseMap: Record<string, ReturnType<typeof buildChain>> = {
        workflow_trigger_events: buildChain({ data: rows, error: null }),
        tasks: buildChain({ data: [], error: null }),
      };
      mockFrom.mockImplementation(
        (table: string) =>
          responseMap[table] ?? buildChain({ data: [], error: null }),
      );

      const [evt] = await service.listTriggerEvents(ORG);

      expect(evt.subjectTaskId).toBe('task-gone');
      expect(evt.subjectTaskKey).toBeNull();
      expect(evt.subjectTaskName).toBeNull();
    });
  });

  describe('saveCanvas', () => {
    const WID = 'wf-1';
    const USER = 'user-1';
    const STATUS_ID = '11111111-1111-1111-1111-111111111111';
    const NODE_ID = '22222222-2222-2222-2222-222222222222';
    const TRANSITION_ID = '33333333-3333-3333-3333-333333333333';
    const TO_NODE_ID = '44444444-4444-4444-4444-444444444444';

    const baseDto = () => ({
      version: 1,
      initial_status_id: null,
      layout: { foo: 'bar' },
      nodes: [
        {
          id: NODE_ID,
          kind: 'status' as const,
          status_id: STATUS_ID,
          position_x: 0,
          position_y: 0,
        },
      ],
      transitions: [
        {
          id: TRANSITION_ID,
          name: 'Go',
          kind: 'regular',
          to_node_id: TO_NODE_ID,
        },
      ],
      transition_sources: [
        { transition_id: TRANSITION_ID, from_node_id: NODE_ID },
      ],
      decision_branches: [],
    });

    it('calls upsert_workflow_canvas with correctly mapped args and audits', async () => {
      const workflow = {
        id: WID,
        organization_id: ORG,
        space_id: null,
        is_archived: false,
        is_active: false,
        is_draft: true,
        version: 1,
        name: 'Alpha',
      };
      const returnedWorkflow = { ...workflow, version: 2, nodes: [] };

      const responseMap: Record<string, ReturnType<typeof buildChain>> = {
        workflows: buildChain({ data: workflow, error: null }),
        task_statuses: buildChain({
          data: [{ id: STATUS_ID, space_id: null }],
          error: null,
        }),
      };
      mockFrom.mockImplementation(
        (table: string) =>
          responseMap[table] ?? buildChain({ data: [], error: null }),
      );
      mockRpc.mockResolvedValue({ data: returnedWorkflow, error: null });

      const dto = baseDto();
      const result = await service.saveCanvas(WID, ORG, dto, USER);

      // saveCanvas returns the enriched getDetail() shape (workflow row +
      // nodes/transitions/sources/branches), not the raw RPC row — assert
      // identity here; the RPC-args assertion below is this test's real point.
      expect(result).toMatchObject({ id: WID });
      expect(mockRpc).toHaveBeenCalledWith(
        'upsert_workflow_canvas',
        expect.objectContaining({
          p_workflow_id: WID,
          p_organization_id: ORG,
          p_expected_version: dto.version,
          p_initial_status_id: null,
          p_layout: dto.layout,
          p_nodes: dto.nodes,
          p_transitions: dto.transitions,
          p_transition_sources: dto.transition_sources,
          p_decision_branches: dto.decision_branches,
          p_user_id: USER,
        }),
      );
    });

    it('translates sqlstate 40001 into a ConflictException with current workflow detail', async () => {
      const workflow = {
        id: WID,
        organization_id: ORG,
        space_id: null,
        is_archived: false,
        is_active: false,
        is_draft: true,
        version: 1,
        name: 'Alpha',
      };

      // getById is called twice — once at the top of saveCanvas, once
      // inside getDetail when building the conflict payload.
      const responseMap: Record<string, ReturnType<typeof buildChain>> = {
        workflows: buildChain({ data: workflow, error: null }),
        task_statuses: buildChain({
          data: [{ id: STATUS_ID, space_id: null }],
          error: null,
        }),
        workflow_nodes: buildChain({ data: [], error: null }),
        workflow_transitions: buildChain({ data: [], error: null }),
      };
      mockFrom.mockImplementation(
        (table: string) =>
          responseMap[table] ?? buildChain({ data: [], error: null }),
      );
      mockRpc.mockResolvedValue({
        data: null,
        error: { code: '40001', message: 'could not serialize access' },
      });

      const dto = baseDto();

      await expect(service.saveCanvas(WID, ORG, dto, USER)).rejects.toThrow(
        ConflictException,
      );

      // Verify the exception payload carries the current workflow detail.
      try {
        await service.saveCanvas(WID, ORG, dto, USER);
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const response = (err as ConflictException).getResponse() as {
          message: string;
          data: { current: unknown };
        };

        expect(response.message).toBe(
          'Workflow was modified by another session',
        );
        expect(response.data?.current).toBeDefined();
      }
    });

    // ----------------------------------------------------------------
    // B3 fix — emit `workflow.published` so the trigger registry refreshes
    // its parent_transitioned cache when an active workflow's canvas
    // changes (or, in P8+, when a draft is published).
    // ----------------------------------------------------------------

    it('B3 — emits workflow.published on saveCanvas of a non-draft workflow', async () => {
      const workflow = {
        id: WID,
        organization_id: ORG,
        space_id: null,
        is_archived: false,
        is_active: false,
        is_draft: false, // non-draft → emit
        version: 1,
        name: 'Alpha',
      };
      const returnedWorkflow = { ...workflow, version: 2, nodes: [] };

      const responseMap: Record<string, ReturnType<typeof buildChain>> = {
        workflows: buildChain({ data: workflow, error: null }),
        task_statuses: buildChain({
          data: [{ id: STATUS_ID, space_id: null }],
          error: null,
        }),
      };
      mockFrom.mockImplementation(
        (table: string) =>
          responseMap[table] ?? buildChain({ data: [], error: null }),
      );
      mockRpc.mockResolvedValue({ data: returnedWorkflow, error: null });

      const supa = {
        getClient: () => ({ from: mockFrom, rpc: mockRpc }),
      } as unknown as SupabaseAdminService;
      const emit = jest.fn();
      const emitter = { emit } as unknown as EventEmitter2;
      const svc = new WorkflowsService(
        supa,
        undefined,
        emitter,
        undefined,
        REGISTRY_OK,
      );

      await svc.saveCanvas(WID, ORG, baseDto(), USER);

      expect(emit).toHaveBeenCalledWith('workflow.published', {
        workflowId: WID,
        organizationId: ORG,
      });
    });

    it('B3 — does NOT emit workflow.published when saving a draft', async () => {
      const workflow = {
        id: WID,
        organization_id: ORG,
        space_id: null,
        is_archived: false,
        is_active: false,
        is_draft: true, // draft → no emit
        version: 1,
        name: 'Alpha',
      };
      const returnedWorkflow = { ...workflow, version: 2, nodes: [] };

      const responseMap: Record<string, ReturnType<typeof buildChain>> = {
        workflows: buildChain({ data: workflow, error: null }),
        task_statuses: buildChain({
          data: [{ id: STATUS_ID, space_id: null }],
          error: null,
        }),
      };
      mockFrom.mockImplementation(
        (table: string) =>
          responseMap[table] ?? buildChain({ data: [], error: null }),
      );
      mockRpc.mockResolvedValue({ data: returnedWorkflow, error: null });

      const supa = {
        getClient: () => ({ from: mockFrom, rpc: mockRpc }),
      } as unknown as SupabaseAdminService;
      const emit = jest.fn();
      const emitter = { emit } as unknown as EventEmitter2;
      const svc = new WorkflowsService(
        supa,
        undefined,
        emitter,
        undefined,
        REGISTRY_OK,
      );

      await svc.saveCanvas(WID, ORG, baseDto(), USER);

      expect(emit).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // P8 — Draft + publish lifecycle (createDraft / discardDraft /
  // getPublishPreview / publishDraft).
  //
  // These tests build per-table mock CHAINS via a small queue helper so we
  // can return different rows on successive .single()/.maybeSingle() calls
  // against the same logical table (e.g. fetching the draft then the parent
  // both from `workflows`).
  // ===========================================================================

  describe('P8 draft + publish lifecycle', () => {
    const PARENT_ID = 'wf-parent';
    const DRAFT_ID = 'wf-draft';
    const ACTOR = 'user-1';

    // Build a chain whose .single()/.maybeSingle() consumes from a queue,
    // and whose await-as-thenable resolves to the NEXT queue item too.
    // This lets us script "first call returns draft, second returns parent"
    // against successive `from('workflows')` invocations.
    //
    // Phase Z fix: widened `results` to accept extra Supabase response fields
    // like `count` (returned alongside `data` / `error` when using
    // `.select(... , { count: 'exact' })`). Without this the `tasksChain`
    // mock that asserts `affected_count` raises TS2353.
    function queueChain(
      results: Array<{ data: unknown; error: unknown; count?: unknown }>,
    ): Record<string, unknown> {
      let i = 0;

      const next = () => results[Math.min(i++, results.length - 1)];
      const chain: Record<string, unknown> = {};
      const self = () => chain;

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
      chain.single = jest
        .fn()
        .mockImplementation(() => Promise.resolve(next()));
      chain.maybeSingle = jest
        .fn()
        .mockImplementation(() => Promise.resolve(next()));
      chain.then = (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve(next()).then(onFulfilled);
      return chain;
    }

    function makeWorkflowRow(overrides: Record<string, unknown>) {
      return {
        id: 'wf',
        organization_id: ORG,
        space_id: null,
        name: 'Alpha',
        description: null,
        is_active: true,
        is_draft: false,
        is_archived: false,
        parent_workflow_id: null,
        initial_status_id: null,
        layout: {},
        version: 1,
        ...overrides,
      };
    }

    // ----- 1. createDraft happy path ----------------------------------------

    it('createDraft — copies parent canvas into new draft and emits workflow.draft.created audit', async () => {
      const parent = makeWorkflowRow({
        id: PARENT_ID,
        is_active: true,
        is_draft: false,
        name: 'Parent',
      });
      const newDraft = makeWorkflowRow({
        id: DRAFT_ID,
        is_draft: true,
        parent_workflow_id: PARENT_ID,
      });

      // Sequence of `from('workflows')` calls:
      //   1. getDetail(parent) → getById → maybeSingle(parent row)
      //   2. INSERT draft → single(newDraft row)
      //   3. getDetail(newDraft) → getById → maybeSingle(newDraft row)
      const workflowsChain = queueChain([
        { data: parent, error: null },
        { data: newDraft, error: null },
        { data: newDraft, error: null },
      ]);
      // Nodes/transitions/sources/branches are queried via .then on a chain
      // (no .single). queueChain handles those via the `.then` consumer too.
      const nodesChain = queueChain([
        { data: [], error: null }, // getDetail(parent).nodes
        { data: [], error: null }, // getDetail(newDraft).nodes
      ]);
      const transitionsChain = queueChain([
        { data: [], error: null },
        { data: [], error: null },
      ]);

      mockFrom.mockImplementation((table: string) => {
        if (table === 'workflows') return workflowsChain;
        if (table === 'workflow_nodes') return nodesChain;
        if (table === 'workflow_transitions') return transitionsChain;
        return queueChain([{ data: [], error: null }]);
      });

      const logAction = jest.fn().mockResolvedValue(undefined);
      const auditLogsService = {
        logAction,
      } as unknown as AuditLogsService;
      const supa = {
        getClient: () => ({ from: mockFrom, rpc: mockRpc }),
      } as unknown as SupabaseAdminService;
      const svc = new WorkflowsService(supa, auditLogsService);

      const result = await svc.createDraft(PARENT_ID, ORG, ACTOR);

      expect(result.id).toBe(DRAFT_ID);
      expect(logAction).toHaveBeenCalledWith(
        ORG,
        ACTOR,
        'workflow',
        DRAFT_ID,
        'workflow.draft.created',
        expect.objectContaining({
          parent_workflow_id: PARENT_ID,
          parent_name: 'Parent',
        }),
      );
    });

    // ----- 2. createDraft idempotent (23505) --------------------------------

    it('createDraft — on 23505 race, re-SELECTs and returns the existing draft (idempotent)', async () => {
      const parent = makeWorkflowRow({
        id: PARENT_ID,
        is_active: true,
        is_draft: false,
        name: 'Parent',
      });
      const existingDraft = makeWorkflowRow({
        id: DRAFT_ID,
        is_draft: true,
        parent_workflow_id: PARENT_ID,
      });

      // Sequence:
      //   1. getDetail(parent) → maybeSingle(parent)
      //   2. INSERT draft → single → ERROR 23505
      //   3. SELECT existing draft id → maybeSingle({id:DRAFT_ID})
      //   4. getDetail(existingDraft) → maybeSingle(existingDraft)
      const workflowsChain = queueChain([
        { data: parent, error: null },
        { data: null, error: { code: '23505', message: 'duplicate' } },
        { data: { id: DRAFT_ID }, error: null },
        { data: existingDraft, error: null },
      ]);
      const nodesChain = queueChain([
        { data: [], error: null },
        { data: [], error: null },
      ]);
      const transitionsChain = queueChain([
        { data: [], error: null },
        { data: [], error: null },
      ]);

      mockFrom.mockImplementation((table: string) => {
        if (table === 'workflows') return workflowsChain;
        if (table === 'workflow_nodes') return nodesChain;
        if (table === 'workflow_transitions') return transitionsChain;
        return queueChain([{ data: [], error: null }]);
      });

      const supa = {
        getClient: () => ({ from: mockFrom, rpc: mockRpc }),
      } as unknown as SupabaseAdminService;
      const svc = new WorkflowsService(supa, undefined, undefined, HEALTH_OK);

      const result = await svc.createDraft(PARENT_ID, ORG, ACTOR);

      expect(result.id).toBe(DRAFT_ID);
    });

    // ----- 3. discardDraft happy path ---------------------------------------

    it('discardDraft — deletes the draft row and audits against the parent', async () => {
      const draft = makeWorkflowRow({
        id: DRAFT_ID,
        is_draft: true,
        parent_workflow_id: PARENT_ID,
        name: 'Parent (draft)',
      });

      const workflowsChain = queueChain([
        { data: draft, error: null }, // getById(draft)
        { data: null, error: null }, // DELETE
      ]);

      mockFrom.mockImplementation((table: string) => {
        if (table === 'workflows') return workflowsChain;
        return queueChain([{ data: [], error: null }]);
      });

      const logAction = jest.fn().mockResolvedValue(undefined);
      const auditLogsService = {
        logAction,
      } as unknown as AuditLogsService;
      const supa = {
        getClient: () => ({ from: mockFrom, rpc: mockRpc }),
      } as unknown as SupabaseAdminService;
      const svc = new WorkflowsService(supa, auditLogsService);

      await svc.discardDraft(DRAFT_ID, ORG, ACTOR);

      expect(logAction).toHaveBeenCalledWith(
        ORG,
        ACTOR,
        'workflow',
        PARENT_ID,
        'workflow.draft.discarded',
        expect.objectContaining({
          draft_id: DRAFT_ID,
          draft_name: 'Parent (draft)',
        }),
      );
    });

    // ----- 4. discardDraft against a non-draft → 400 ------------------------

    it('discardDraft — throws BadRequestException when the target is not a draft', async () => {
      const notDraft = makeWorkflowRow({
        id: PARENT_ID,
        is_draft: false,
      });

      mockFrom.mockImplementation((table: string) => {
        if (table === 'workflows')
          return queueChain([{ data: notDraft, error: null }]);
        return queueChain([{ data: [], error: null }]);
      });

      await expect(service.discardDraft(PARENT_ID, ORG, ACTOR)).rejects.toThrow(
        BadRequestException,
      );
    });

    // ----- 5. getPublishPreview returns expected shape ----------------------

    it('getPublishPreview — returns added/removed/orphan_statuses + suggested_mappings', async () => {
      const STATUS_KEEP = '11111111-1111-1111-1111-111111111111';
      const STATUS_REMOVED = '22222222-2222-2222-2222-222222222222';
      const STATUS_ADDED = '33333333-3333-3333-3333-333333333333';

      const draft = makeWorkflowRow({
        id: DRAFT_ID,
        is_draft: true,
        parent_workflow_id: PARENT_ID,
      });
      const parent = makeWorkflowRow({
        id: PARENT_ID,
        is_active: true,
        is_draft: false,
      });

      // Both getDetail() calls fetch the workflow row, then nodes, then
      // transitions in sequence. We script every from() call accordingly.
      // getDetail(draft):
      //   workflows.maybeSingle → draft row
      //   workflow_nodes.then    → draft nodes [STATUS_KEEP, STATUS_ADDED]
      //   workflow_transitions.then → []
      // getDetail(parent):
      //   workflows.maybeSingle → parent row
      //   workflow_nodes.then    → parent nodes [STATUS_KEEP, STATUS_REMOVED]
      //   workflow_transitions.then → []
      // task_statuses.then       → name rows for ADDED + REMOVED
      // workflow_assignments.then → [{ space_id: 'space-1' }]
      // tasks.then (count, head) → { count: 7 }
      // workflow_nodes.then      → target draft status_id rows (used by suggestStatusMapping)
      // task_statuses.then       → status rows for orphan + target ids

      const workflowsChain = queueChain([
        { data: draft, error: null },
        { data: parent, error: null },
      ]);
      const draftNodes = [
        { id: 'n1', kind: 'status', status_id: STATUS_KEEP },
        { id: 'n2', kind: 'status', status_id: STATUS_ADDED },
      ];
      const parentNodes = [
        { id: 'n1', kind: 'status', status_id: STATUS_KEEP },
        { id: 'n3', kind: 'status', status_id: STATUS_REMOVED },
      ];
      const nodesChain = queueChain([
        { data: draftNodes, error: null }, // getDetail(draft) nodes
        { data: parentNodes, error: null }, // getDetail(parent) nodes
        // suggestStatusMapping → target nodes for draft (= draftNodes)
        {
          data: draftNodes.map((n) => ({ status_id: n.status_id })),
          error: null,
        },
      ]);
      const transitionsChain = queueChain([
        { data: [], error: null },
        { data: [], error: null },
      ]);
      const statusesChain = queueChain([
        // Names lookup for added + removed
        {
          data: [
            { id: STATUS_ADDED, name: 'New' },
            { id: STATUS_REMOVED, name: 'Old' },
          ],
          error: null,
        },
        // suggestStatusMapping bulk lookup
        {
          data: [
            {
              id: STATUS_REMOVED,
              key: 'old',
              name: 'Old',
              category_id: null,
              sort_order: 10,
            },
            {
              id: STATUS_KEEP,
              key: 'keep',
              name: 'Keep',
              category_id: null,
              sort_order: 1,
            },
            {
              id: STATUS_ADDED,
              key: 'new',
              name: 'New',
              category_id: null,
              sort_order: 2,
            },
          ],
          error: null,
        },
      ]);
      const assignmentsChain = queueChain([
        { data: [{ space_id: 'space-1' }], error: null },
      ]);
      const tasksChain = queueChain([{ count: 7, data: null, error: null }]);

      mockFrom.mockImplementation((table: string) => {
        switch (table) {
          case 'workflows':
            return workflowsChain;
          case 'workflow_nodes':
            return nodesChain;
          case 'workflow_transitions':
            return transitionsChain;
          case 'task_statuses':
            return statusesChain;
          case 'workflow_assignments':
            return assignmentsChain;
          case 'tasks':
            return tasksChain;
          default:
            return queueChain([{ data: [], error: null }]);
        }
      });

      const result = await service.getPublishPreview(DRAFT_ID, ORG);

      expect(result.added_statuses).toEqual([
        { id: STATUS_ADDED, name: 'New' },
      ]);
      expect(result.removed_statuses).toEqual([
        { id: STATUS_REMOVED, name: 'Old' },
      ]);
      expect(result.orphan_statuses).toEqual([STATUS_REMOVED]);
      expect(result.affected_count).toBe(7);
      // First available by sort_order → STATUS_KEEP (sort_order=1)
      expect(result.suggested_mappings[STATUS_REMOVED]).toBe(STATUS_KEEP);
    });

    // ----- 6. publishDraft happy path (no orphans) --------------------------

    it('publishDraft — inserts publish job, calls RPC, audits, and emits workflow.published', async () => {
      const draft = makeWorkflowRow({
        id: DRAFT_ID,
        is_draft: true,
        parent_workflow_id: PARENT_ID,
      });
      const parent = makeWorkflowRow({
        id: PARENT_ID,
        is_active: true,
        is_draft: false,
      });

      // from('workflows'): getById(draft), then getDetail(parent) at the end.
      const workflowsChain = queueChain([
        { data: draft, error: null }, // getById(draft)
        { data: parent, error: null }, // getDetail(parent) maybeSingle
      ]);
      const publishJobsChain = queueChain([
        { data: { id: 'job-1' }, error: null }, // INSERT
        { data: null, error: null }, // UPDATE succeeded
      ]);
      const nodesChain = queueChain([{ data: [], error: null }]);
      const transitionsChain = queueChain([{ data: [], error: null }]);

      mockFrom.mockImplementation((table: string) => {
        if (table === 'workflows') return workflowsChain;
        if (table === 'workflow_publish_jobs') return publishJobsChain;
        if (table === 'workflow_nodes') return nodesChain;
        if (table === 'workflow_transitions') return transitionsChain;
        return queueChain([{ data: [], error: null }]);
      });
      mockRpc.mockResolvedValue({
        data: {
          workflow: parent,
          tasks_migrated: 0,
          orphan_count: 0,
        },
        error: null,
      });

      const logAction = jest.fn().mockResolvedValue(undefined);
      const auditLogsService = {
        logAction,
      } as unknown as AuditLogsService;
      const emit = jest.fn();
      const emitter = { emit } as unknown as EventEmitter2;
      const supa = {
        getClient: () => ({ from: mockFrom, rpc: mockRpc }),
      } as unknown as SupabaseAdminService;
      const svc = new WorkflowsService(
        supa,
        auditLogsService,
        emitter,
        HEALTH_OK,
      );

      const result = await svc.publishDraft(DRAFT_ID, ORG, {}, ACTOR);

      expect(mockRpc).toHaveBeenCalledWith(
        'publish_workflow_atomic',
        expect.objectContaining({
          p_draft_id: DRAFT_ID,
          p_organization_id: ORG,
          p_migration_map: {},
          p_user_id: ACTOR,
        }),
      );
      expect(result.tasks_migrated).toBe(0);
      expect(result.orphan_count).toBe(0);
      expect(logAction).toHaveBeenCalledWith(
        ORG,
        ACTOR,
        'workflow',
        PARENT_ID,
        'workflow.published',
        expect.objectContaining({
          draft_id: DRAFT_ID,
          tasks_migrated: 0,
          orphan_count: 0,
        }),
      );
      expect(emit).toHaveBeenCalledWith('workflow.published', {
        workflowId: PARENT_ID,
        organizationId: ORG,
      });
    });

    // ----- 7. publishDraft with valid migration map -------------------------

    it('publishDraft — passes migration_map to RPC and audits successful migration counts', async () => {
      const draft = makeWorkflowRow({
        id: DRAFT_ID,
        is_draft: true,
        parent_workflow_id: PARENT_ID,
      });
      const parent = makeWorkflowRow({
        id: PARENT_ID,
        is_active: true,
        is_draft: false,
      });
      const map = {
        '22222222-2222-2222-2222-222222222222':
          '11111111-1111-1111-1111-111111111111',
      };

      const workflowsChain = queueChain([
        { data: draft, error: null },
        { data: parent, error: null },
      ]);
      const publishJobsChain = queueChain([
        { data: { id: 'job-2' }, error: null },
        { data: null, error: null },
      ]);
      const nodesChain = queueChain([{ data: [], error: null }]);
      const transitionsChain = queueChain([{ data: [], error: null }]);

      mockFrom.mockImplementation((table: string) => {
        if (table === 'workflows') return workflowsChain;
        if (table === 'workflow_publish_jobs') return publishJobsChain;
        if (table === 'workflow_nodes') return nodesChain;
        if (table === 'workflow_transitions') return transitionsChain;
        return queueChain([{ data: [], error: null }]);
      });
      mockRpc.mockResolvedValue({
        data: {
          workflow: parent,
          tasks_migrated: 3,
          orphan_count: 1,
        },
        error: null,
      });

      const logAction = jest.fn().mockResolvedValue(undefined);
      const auditLogsService = {
        logAction,
      } as unknown as AuditLogsService;
      const supa = {
        getClient: () => ({ from: mockFrom, rpc: mockRpc }),
      } as unknown as SupabaseAdminService;
      const svc = new WorkflowsService(
        supa,
        auditLogsService,
        undefined,
        HEALTH_OK,
      );

      const result = await svc.publishDraft(DRAFT_ID, ORG, map, ACTOR);

      expect(mockRpc).toHaveBeenCalledWith(
        'publish_workflow_atomic',
        expect.objectContaining({ p_migration_map: map }),
      );
      expect(result.tasks_migrated).toBe(3);
      expect(result.orphan_count).toBe(1);
      expect(logAction).toHaveBeenCalledWith(
        ORG,
        ACTOR,
        'workflow',
        PARENT_ID,
        'workflow.published',
        expect.objectContaining({
          tasks_migrated: 3,
          orphan_count: 1,
        }),
      );
    });

    // ----- 8. publishDraft 23514 → 409 with orphan_statuses_missing ---------

    it('publishDraft — translates 23514 into ConflictException with orphan_statuses_missing payload', async () => {
      const draft = makeWorkflowRow({
        id: DRAFT_ID,
        is_draft: true,
        parent_workflow_id: PARENT_ID,
      });

      const workflowsChain = queueChain([{ data: draft, error: null }]);
      const publishJobsChain = queueChain([
        { data: { id: 'job-3' }, error: null }, // INSERT
        { data: null, error: null }, // UPDATE failed
      ]);

      mockFrom.mockImplementation((table: string) => {
        if (table === 'workflows') return workflowsChain;
        if (table === 'workflow_publish_jobs') return publishJobsChain;
        return queueChain([{ data: [], error: null }]);
      });
      const missingId = '22222222-2222-2222-2222-222222222222';
      mockRpc.mockResolvedValue({
        data: null,
        error: {
          code: '23514',
          message: `Cannot publish: missing migration mapping for status(es) {${missingId}}`,
        },
      });

      const supa = {
        getClient: () => ({ from: mockFrom, rpc: mockRpc }),
      } as unknown as SupabaseAdminService;
      const svc = new WorkflowsService(supa, undefined, undefined, HEALTH_OK);

      try {
        await svc.publishDraft(DRAFT_ID, ORG, {}, ACTOR);
        fail('expected ConflictException');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const response = (err as ConflictException).getResponse() as {
          message: string;
          data: { orphan_statuses_missing: string[] };
        };

        expect(response.message).toContain('missing migration mapping');
        expect(response.data.orphan_statuses_missing).toEqual([missingId]);
      }
    });

    // ----- 9. publishDraft P0001 'Draft workflow ... not found' → 404 -------

    it('publishDraft — translates "Draft workflow ... not found" into NotFoundException with DRAFT_ALREADY_PUBLISHED', async () => {
      const draft = makeWorkflowRow({
        id: DRAFT_ID,
        is_draft: true,
        parent_workflow_id: PARENT_ID,
      });

      const workflowsChain = queueChain([{ data: draft, error: null }]);
      const publishJobsChain = queueChain([
        { data: { id: 'job-4' }, error: null },
        { data: null, error: null },
      ]);

      mockFrom.mockImplementation((table: string) => {
        if (table === 'workflows') return workflowsChain;
        if (table === 'workflow_publish_jobs') return publishJobsChain;
        return queueChain([{ data: [], error: null }]);
      });
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: `Draft workflow ${DRAFT_ID} not found` },
      });

      const supa = {
        getClient: () => ({ from: mockFrom, rpc: mockRpc }),
      } as unknown as SupabaseAdminService;
      const svc = new WorkflowsService(supa, undefined, undefined, HEALTH_OK);

      try {
        await svc.publishDraft(DRAFT_ID, ORG, {}, ACTOR);
        fail('expected NotFoundException');
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundException);
        const response = (err as NotFoundException).getResponse() as {
          message: string;
          code: string;
        };

        expect(response.code).toBe('DRAFT_ALREADY_PUBLISHED');
      }
    });

    // ----- 10. publishDraft 42501 → 403 -------------------------------------

    it('publishDraft — translates 42501 into ForbiddenException', async () => {
      const draft = makeWorkflowRow({
        id: DRAFT_ID,
        is_draft: true,
        parent_workflow_id: PARENT_ID,
      });

      const workflowsChain = queueChain([{ data: draft, error: null }]);
      const publishJobsChain = queueChain([
        { data: { id: 'job-5' }, error: null },
        { data: null, error: null },
      ]);

      mockFrom.mockImplementation((table: string) => {
        if (table === 'workflows') return workflowsChain;
        if (table === 'workflow_publish_jobs') return publishJobsChain;
        return queueChain([{ data: [], error: null }]);
      });
      mockRpc.mockResolvedValue({
        data: null,
        error: {
          code: '42501',
          message:
            'Cannot publish: migration_map target belongs to another organization',
        },
      });

      const supa = {
        getClient: () => ({ from: mockFrom, rpc: mockRpc }),
      } as unknown as SupabaseAdminService;
      const svc = new WorkflowsService(supa, undefined, undefined, HEALTH_OK);

      await expect(
        svc.publishDraft(
          DRAFT_ID,
          ORG,
          { foo: 'bar' } as unknown as Record<string, string>,
          ACTOR,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    // ----- 11. publishDraft 40001 (serialization) → 409 retryable (R1) -------

    it('publishDraft — translates 40001 into a retryable ConflictException', async () => {
      const draft = makeWorkflowRow({
        id: DRAFT_ID,
        is_draft: true,
        parent_workflow_id: PARENT_ID,
      });

      const workflowsChain = queueChain([{ data: draft, error: null }]);
      const publishJobsChain = queueChain([
        { data: { id: 'job-6' }, error: null },
        { data: null, error: null },
      ]);

      mockFrom.mockImplementation((table: string) => {
        if (table === 'workflows') return workflowsChain;
        if (table === 'workflow_publish_jobs') return publishJobsChain;
        return queueChain([{ data: [], error: null }]);
      });
      mockRpc.mockResolvedValue({
        data: null,
        error: { code: '40001', message: 'could not serialize access' },
      });

      const supa = {
        getClient: () => ({ from: mockFrom, rpc: mockRpc }),
      } as unknown as SupabaseAdminService;
      const svc = new WorkflowsService(supa, undefined, undefined, HEALTH_OK);

      try {
        await svc.publishDraft(DRAFT_ID, ORG, {}, ACTOR);
        fail('expected ConflictException');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const response = (err as ConflictException).getResponse() as {
          data: { retryable: boolean };
        };

        expect(response.data.retryable).toBe(true);
      }
    });
  });
});
