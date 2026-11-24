/**
 * @fileoverview Unit tests for UpdateLinkedTaskPostFunction.
 * @module src/workflow-engine/handlers/post-functions/update-linked-task.post.spec
 * @author Prince Jadiya
 */

import type { ModuleRef } from '@nestjs/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  UpdateLinkedTaskPostFunction,
  type UpdateLinkedTaskConfig,
} from './update-linked-task.post';
import type { IEvaluationContext } from '../handler.types';
import { WorkflowEngineService } from '../../workflow-engine.service';

type EngineMock = Pick<
  WorkflowEngineService,
  'resolveTransitionByStatusChange' | 'executeTransition'
> & {
  resolveTransitionByStatusChange: jest.Mock;
  executeTransition: jest.Mock;
};

type ModuleRefMock = { get: jest.Mock };

/**
 * Default engine behavior used by the legacy-path tests: report no path so
 * the handler falls back to the direct UPDATE the tests already cover. Tests
 * that exercise the engine-routing path override these mocks explicitly.
 */
function buildEngineMock(): EngineMock {
  return {
    resolveTransitionByStatusChange: jest
      .fn()
      .mockResolvedValue({ error: 'no_path' }),
    executeTransition: jest.fn().mockResolvedValue({}),
  };
}

describe('UpdateLinkedTaskPostFunction', () => {
  let engine: EngineMock;
  let moduleRef: ModuleRefMock;
  let handler: UpdateLinkedTaskPostFunction;

  beforeEach(() => {
    engine = buildEngineMock();
    // The handler resolves the engine lazily through ModuleRef (the engine
    // depends on HandlerRegistryService, which constructs this handler — a
    // direct injection would be a DI cycle). Mirror the container: resolve
    // the WorkflowEngineService token, reject anything else.
    moduleRef = {
      get: jest.fn((token: unknown) => {
        if (token === WorkflowEngineService) return engine;
        throw new Error(`Unexpected moduleRef.get(${String(token)})`);
      }),
    };
    handler = new UpdateLinkedTaskPostFunction(
      moduleRef as unknown as ModuleRef,
    );
  });
  const fieldId = '123e4567-e89b-12d3-a456-426614174000';
  const statusId = '123e4567-e89b-12d3-a456-426614174001';
  const parentId = '00000000-0000-0000-0000-00000000aaaa';
  const childId = '00000000-0000-0000-0000-00000000bbbb';
  const peerId = '00000000-0000-0000-0000-00000000cccc';
  const relationTypeId = '00000000-0000-0000-0000-00000000eeee';

  const ctx = (
    overrides: Partial<IEvaluationContext> = {},
  ): IEvaluationContext => ({
    organizationId: 'org-1',
    spaceId: 'space-1',
    taskId: 'task-1',
    task: { id: 'task-1', parent_task_id: parentId },
    transitionId: 'tx-1',
    transition: null,
    userId: 'user-1',
    user: null,
    userRoles: [],
    userGroups: [],
    customFieldValues: {},
    ...overrides,
  });

  /**
   * Build a txn that handles the lookups for each relation kind. The
   * `linked` argument supplies the linked task row (or null for "outside org").
   */
  function makeTxn(
    opts: {
      /** Linked task row returned by the org-membership fetch. */
      linked?: {
        id: string;
        organization_id: string;
        custom_field_values: Record<string, unknown> | null;
      } | null;
      /** Result of the SELECT id for relation=child or task_relationships. */
      childResult?: { id?: string } | null;
      /** relation_types lookup result. */
      relationTypeResult?: { id?: string } | null;
      /** task_relationships lookup result. */
      relationshipResult?: Record<string, unknown> | null;
      /** Error injection. */
      fetchError?: { message: string } | null;
      updateError?: { message: string } | null;
    } = {},
  ): {
    txn: SupabaseClient;
    update: jest.Mock;
    fromCalls: string[];
  } {
    const fromCalls: string[] = [];

    // ---- tasks (fetch + update) ----
    const fetchMaybeSingle = jest.fn().mockResolvedValue({
      data:
        opts.linked === undefined
          ? {
              id: peerId,
              organization_id: 'org-1',
              custom_field_values: null,
            }
          : opts.linked,
      error: opts.fetchError ?? null,
    });
    const fetchEqId = jest
      .fn()
      .mockReturnValue({ maybeSingle: fetchMaybeSingle });
    const tasksSelect = jest.fn().mockReturnValue({ eq: fetchEqId });

    const updateEqOrg = jest
      .fn()
      .mockResolvedValue({ data: null, error: opts.updateError ?? null });
    const updateEqId = jest.fn().mockReturnValue({ eq: updateEqOrg });
    const update = jest.fn().mockReturnValue({ eq: updateEqId });

    // ---- tasks SELECT for relation=child ----
    const childMaybeSingle = jest.fn().mockResolvedValue({
      data: opts.childResult === undefined ? { id: childId } : opts.childResult,
      error: null,
    });
    const childLimit = jest
      .fn()
      .mockReturnValue({ maybeSingle: childMaybeSingle });
    const childEqOrg = jest.fn().mockReturnValue({ limit: childLimit });
    const childEqParent = jest.fn().mockReturnValue({ eq: childEqOrg });
    // Build a select-chain that branches on the column-name passed to .eq()
    // The handler does: .select('id').eq('parent_task_id', taskId).eq('organization_id', org).limit(1).maybeSingle()
    const tasksSelectChild = jest.fn().mockReturnValue({ eq: childEqParent });

    // ---- relation_types ----
    const relationTypeMaybeSingle = jest.fn().mockResolvedValue({
      data:
        opts.relationTypeResult === undefined
          ? { id: relationTypeId }
          : opts.relationTypeResult,
      error: null,
    });
    const relationTypeLimit = jest
      .fn()
      .mockReturnValue({ maybeSingle: relationTypeMaybeSingle });
    const relationTypeEqOrg = jest
      .fn()
      .mockReturnValue({ limit: relationTypeLimit });
    const relationTypeEqName = jest
      .fn()
      .mockReturnValue({ eq: relationTypeEqOrg });
    const relationTypesSelect = jest
      .fn()
      .mockReturnValue({ eq: relationTypeEqName });

    // ---- task_relationships ----
    // Handler chain: .select(...).eq(organization_id).eq(relation_type_id) then
    // either .eq(source_id|target_id) (blocks / blocked_by) or .or(...)
    // (relates_to, which is symmetric). The query builder is AWAITED directly —
    // no .limit()/.maybeSingle() — and must resolve to a ROW ARRAY, because the
    // handler supports fanning out to multiple peers.
    const relationshipRows =
      opts.relationshipResult === undefined
        ? [
            {
              source_id: 'task-1',
              target_id: peerId,
              source_type: 'task',
              target_type: 'task',
            },
          ]
        : opts.relationshipResult === null
          ? []
          : [opts.relationshipResult];

    // A thenable that keeps returning itself for .eq()/.or() so any filter
    // order resolves to the same row array.
    const makeRelationshipQuery = (): Record<string, unknown> => {
      const q: Record<string, unknown> = {};

      q.eq = jest.fn().mockReturnValue(q);
      q.or = jest.fn().mockReturnValue(q);
      q.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: relationshipRows, error: null });

      return q;
    };
    const relationshipsSelect = jest
      .fn()
      .mockImplementation(() => makeRelationshipQuery());

    // ---- custom_fields (field_key resolution) ----
    // Handler chain: .select('field_key').eq('id',…).eq('organization_id',…).maybeSingle()
    const customFieldsMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: { field_key: 'tcf_key' }, error: null });
    const customFieldsEqOrg = jest
      .fn()
      .mockReturnValue({ maybeSingle: customFieldsMaybeSingle });
    const customFieldsEqId = jest
      .fn()
      .mockReturnValue({ eq: customFieldsEqOrg });
    const customFieldsSelect = jest
      .fn()
      .mockReturnValue({ eq: customFieldsEqId });

    // ---- task_statuses (status key + completion flag) ----
    // The direct fallback resolves the status meta so it can write the
    // denormalized `status` text (+ completed_at) alongside `status_id`.
    // Handler chain: .select('key, is_completed').eq('id',…).eq('organization_id',…).maybeSingle()
    const taskStatusesMaybeSingle = jest.fn().mockResolvedValue({
      data: { key: 'in_progress', is_completed: false },
      error: null,
    });
    const taskStatusesEqOrg = jest
      .fn()
      .mockReturnValue({ maybeSingle: taskStatusesMaybeSingle });
    const taskStatusesEqId = jest
      .fn()
      .mockReturnValue({ eq: taskStatusesEqOrg });
    const taskStatusesSelect = jest
      .fn()
      .mockReturnValue({ eq: taskStatusesEqId });

    let tasksFromCallCount = 0;

    const from = jest.fn().mockImplementation((tableName: string) => {
      fromCalls.push(tableName);
      if (tableName === 'tasks') {
        tasksFromCallCount += 1;

        // The first tasks call for relation=child is a SELECT for the child id;
        // the next is the SELECT(id, org, cfv); the last is UPDATE. We return
        // a uniform object that supports select+update; the chain shape decides
        // which mock fires.
        if (tasksFromCallCount === 1 && opts.childResult !== undefined) {
          return { select: tasksSelectChild, update };
        }

        return { select: tasksSelect, update };
      }
      if (tableName === 'relation_types') {
        return { select: relationTypesSelect };
      }
      if (tableName === 'task_relationships') {
        return { select: relationshipsSelect };
      }
      if (tableName === 'custom_fields') {
        return { select: customFieldsSelect };
      }
      if (tableName === 'task_statuses') {
        return { select: taskStatusesSelect };
      }
      throw new Error(`Unexpected from(${tableName})`);
    });
    const txn = { from } as unknown as SupabaseClient;

    return { txn, update, fromCalls };
  }

  describe('schema', () => {
    it('accepts a field-only config', () => {
      const r = handler.schema.safeParse({
        type: 'update_linked_task',
        relation: 'parent',
        set_field_id: fieldId,
        set_field_value: 'done',
      });

      expect(r.success).toBe(true);
    });

    it('accepts a status-only config', () => {
      const r = handler.schema.safeParse({
        type: 'update_linked_task',
        relation: 'child',
        set_status_id: statusId,
      });

      expect(r.success).toBe(true);
    });

    it('accepts both field and status set', () => {
      const r = handler.schema.safeParse({
        type: 'update_linked_task',
        relation: 'blocks',
        set_field_id: fieldId,
        set_field_value: 7,
        set_status_id: statusId,
      });

      expect(r.success).toBe(true);
    });

    it('rejects config with neither field nor status', () => {
      const r = handler.schema.safeParse({
        type: 'update_linked_task',
        relation: 'relates_to',
      });

      expect(r.success).toBe(false);
    });

    it('rejects unknown relation', () => {
      const r = handler.schema.safeParse({
        type: 'update_linked_task',
        relation: 'cousins',
        set_field_id: fieldId,
      });

      expect(r.success).toBe(false);
    });

    it('rejects non-uuid set_field_id', () => {
      const r = handler.schema.safeParse({
        type: 'update_linked_task',
        relation: 'parent',
        set_field_id: 'not-a-uuid',
      });

      expect(r.success).toBe(false);
    });

    it('rejects non-uuid set_status_id', () => {
      const r = handler.schema.safeParse({
        type: 'update_linked_task',
        relation: 'parent',
        set_status_id: 'not-a-uuid',
      });

      expect(r.success).toBe(false);
    });
  });

  describe('run', () => {
    it('updates the parent task status when relation=parent', async () => {
      const { txn, update } = makeTxn();
      const cfg: UpdateLinkedTaskConfig = {
        type: 'update_linked_task',
        relation: 'parent',
        set_status_id: statusId,
      };

      await handler.run(cfg, ctx({ txn }));

      // The direct fallback also writes the denormalized `status` text and
      // completed_at, mirroring the engine's own status write — status_id alone
      // would leave the task's visible status stale.
      expect(update).toHaveBeenCalledWith({
        status_id: statusId,
        status: 'in_progress',
        completed_at: null,
      });
    });

    it('merges custom_field_values when set_field_id is supplied', async () => {
      const { txn, update } = makeTxn({
        linked: {
          id: parentId,
          organization_id: 'org-1',
          custom_field_values: { other: 1 },
        },
      });
      const cfg: UpdateLinkedTaskConfig = {
        type: 'update_linked_task',
        relation: 'parent',
        set_field_id: fieldId,
        set_field_value: 'urgent',
      };

      await handler.run(cfg, ctx({ txn }));

      // Keyed by the resolved field_key ('tcf_key'), NOT the field_id UUID.
      expect(update).toHaveBeenCalledWith({
        custom_field_values: { other: 1, tcf_key: 'urgent' },
      });
    });

    it('no-ops when relation=parent but the task has no parent', async () => {
      const { txn, update } = makeTxn();
      const cfg: UpdateLinkedTaskConfig = {
        type: 'update_linked_task',
        relation: 'parent',
        set_status_id: statusId,
      };

      await handler.run(
        cfg,
        ctx({ txn, task: { id: 'task-1', parent_task_id: null } }),
      );
      expect(update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the linked task is in a different org', async () => {
      const { txn, update } = makeTxn({
        linked: {
          id: parentId,
          organization_id: 'other-org',
          custom_field_values: null,
        },
      });
      const cfg: UpdateLinkedTaskConfig = {
        type: 'update_linked_task',
        relation: 'parent',
        set_status_id: statusId,
      };

      await expect(handler.run(cfg, ctx({ txn }))).rejects.toThrow(
        /outside org/,
      );
      expect(update).not.toHaveBeenCalled();
    });

    it('throws when the linked task is not found', async () => {
      const { txn } = makeTxn({ linked: null });
      const cfg: UpdateLinkedTaskConfig = {
        type: 'update_linked_task',
        relation: 'parent',
        set_status_id: statusId,
      };

      await expect(handler.run(cfg, ctx({ txn }))).rejects.toThrow(
        /linked task .* not found/,
      );
    });

    it('throws when ctx.txn is missing', async () => {
      const cfg: UpdateLinkedTaskConfig = {
        type: 'update_linked_task',
        relation: 'parent',
        set_status_id: statusId,
      };

      await expect(handler.run(cfg, ctx())).rejects.toThrow(/requires ctx.txn/);
    });

    it('throws when the UPDATE errors', async () => {
      const { txn } = makeTxn({ updateError: { message: 'pg write down' } });
      const cfg: UpdateLinkedTaskConfig = {
        type: 'update_linked_task',
        relation: 'parent',
        set_status_id: statusId,
      };

      await expect(handler.run(cfg, ctx({ txn }))).rejects.toThrow(
        /pg write down/,
      );
    });

    it('resolves through task_relationships for relation=blocks', async () => {
      const { txn, update, fromCalls } = makeTxn();
      const cfg: UpdateLinkedTaskConfig = {
        type: 'update_linked_task',
        relation: 'blocks',
        set_status_id: statusId,
      };

      await handler.run(cfg, ctx({ txn }));
      expect(fromCalls).toContain('relation_types');
      expect(fromCalls).toContain('task_relationships');
      expect(update).toHaveBeenCalledWith({
        status_id: statusId,
        status: 'in_progress',
        completed_at: null,
      });
    });

    it('no-ops when relation_type does not exist for the org', async () => {
      const { txn, update } = makeTxn({ relationTypeResult: null });
      const cfg: UpdateLinkedTaskConfig = {
        type: 'update_linked_task',
        relation: 'relates_to',
        set_status_id: statusId,
      };

      await handler.run(cfg, ctx({ txn }));
      expect(update).not.toHaveBeenCalled();
    });

    // ----------------------------------------------------------------
    // Engine routing (B2 fix — design Part 2.18 recursion guard)
    // ----------------------------------------------------------------

    it('B2 — routes status change through engine.executeTransition with transitionDepth=1 when a path resolves', async () => {
      const txnResult = makeTxn();
      const resolvedTransitionId = '00000000-0000-0000-0000-00000000ffff';

      engine.resolveTransitionByStatusChange.mockResolvedValueOnce({
        transition: { id: resolvedTransitionId, name: 'Resolve' },
      });
      const cfg: UpdateLinkedTaskConfig = {
        type: 'update_linked_task',
        relation: 'parent',
        set_status_id: statusId,
      };

      await handler.run(cfg, ctx({ txn: txnResult.txn }));

      expect(engine.resolveTransitionByStatusChange).toHaveBeenCalledTimes(1);
      expect(engine.resolveTransitionByStatusChange).toHaveBeenCalledWith(
        parentId,
        statusId,
        expect.objectContaining({ userId: 'user-1', organizationId: 'org-1' }),
      );
      expect(engine.executeTransition).toHaveBeenCalledTimes(1);
      const call = (engine.executeTransition.mock.calls[0] as unknown[])[0] as {
        taskId: string;
        transitionId: string;
        transitionDepth: number;
      };

      expect(call.taskId).toBe(parentId);
      expect(call.transitionId).toBe(resolvedTransitionId);
      expect(call.transitionDepth).toBe(1);
      // Engine path replaces the direct UPDATE; no UPDATE was issued.
      expect(txnResult.update).not.toHaveBeenCalled();
    });

    it('B2 — propagates ctx.transition_depth into the engine call (depth+1)', async () => {
      const txnResult = makeTxn();

      engine.resolveTransitionByStatusChange.mockResolvedValueOnce({
        transition: { id: 'tx-foo', name: 'Whatever' },
      });
      const cfg: UpdateLinkedTaskConfig = {
        type: 'update_linked_task',
        relation: 'parent',
        set_status_id: statusId,
      };

      await handler.run(cfg, ctx({ txn: txnResult.txn, transition_depth: 1 }));
      const call2 = (
        engine.executeTransition.mock.calls[0] as unknown[]
      )[0] as {
        transitionDepth: number;
      };

      // ctx had transition_depth=1 → child engine call gets depth=2 → engine
      // refuses with a recursion error (verified separately in engine spec).
      expect(call2.transitionDepth).toBe(2);
    });

    it('B2 — falls back to direct UPDATE when engine reports no_path', async () => {
      const txnResult = makeTxn();
      // Default mock already returns no_path; explicit for clarity.
      engine.resolveTransitionByStatusChange.mockResolvedValueOnce({
        error: 'no_path',
      });
      const cfg: UpdateLinkedTaskConfig = {
        type: 'update_linked_task',
        relation: 'parent',
        set_status_id: statusId,
      };

      await handler.run(cfg, ctx({ txn: txnResult.txn }));

      expect(engine.executeTransition).not.toHaveBeenCalled();
      expect(txnResult.update).toHaveBeenCalledWith({
        status_id: statusId,
        status: 'in_progress',
        completed_at: null,
      });
    });

    it('B2 — falls back to direct UPDATE when engine reports multiple_paths', async () => {
      const txnResult = makeTxn();

      engine.resolveTransitionByStatusChange.mockResolvedValueOnce({
        error: 'multiple_paths',
        candidates: [
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
        ],
      });
      const cfg: UpdateLinkedTaskConfig = {
        type: 'update_linked_task',
        relation: 'parent',
        set_status_id: statusId,
      };

      await handler.run(cfg, ctx({ txn: txnResult.txn }));

      expect(engine.executeTransition).not.toHaveBeenCalled();
      expect(txnResult.update).toHaveBeenCalledWith({
        status_id: statusId,
        status: 'in_progress',
        completed_at: null,
      });
    });

    it('B2 — field-only updates do NOT touch the engine', async () => {
      const txnResult = makeTxn();
      const cfg: UpdateLinkedTaskConfig = {
        type: 'update_linked_task',
        relation: 'parent',
        set_field_id: fieldId,
        set_field_value: 'green',
      };

      await handler.run(cfg, ctx({ txn: txnResult.txn }));

      expect(engine.resolveTransitionByStatusChange).not.toHaveBeenCalled();
      expect(engine.executeTransition).not.toHaveBeenCalled();
      expect(txnResult.update).toHaveBeenCalledWith({
        custom_field_values: { tcf_key: 'green' },
      });
    });
  });

  describe('findReferences', () => {
    it('returns the field reference when only set_field_id is set', () => {
      const refs = handler.findReferences({
        type: 'update_linked_task',
        relation: 'parent',
        set_field_id: fieldId,
        set_field_value: 'x',
      });

      expect(refs).toEqual([{ kind: 'field', id: fieldId }]);
    });

    it('returns the status reference when only set_status_id is set', () => {
      const refs = handler.findReferences({
        type: 'update_linked_task',
        relation: 'child',
        set_status_id: statusId,
      });

      expect(refs).toEqual([{ kind: 'status', id: statusId }]);
    });

    it('returns both refs when both are set', () => {
      const refs = handler.findReferences({
        type: 'update_linked_task',
        relation: 'blocks',
        set_field_id: fieldId,
        set_field_value: 7,
        set_status_id: statusId,
      });

      expect(refs).toEqual([
        { kind: 'field', id: fieldId },
        { kind: 'status', id: statusId },
      ]);
    });
  });
});
