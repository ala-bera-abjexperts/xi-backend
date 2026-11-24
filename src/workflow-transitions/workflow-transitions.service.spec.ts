/**
 * @fileoverview Unit tests for WorkflowTransitionsService.saveRules — covers the
 * happy path plus the three failure modes (Zod validation failure, cross-org
 * reference, and cross-org transition lookup).
 * @module src/workflow-transitions/workflow-transitions.service.spec
 * @author Rajbha Manek
 */

/* eslint-disable @typescript-eslint/unbound-method */

import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { HandlerRegistryService } from '../workflow-engine/handlers/handler-registry.service';
import type { IRuleReference } from '../workflow-engine/handlers/handler.types';
import type { SaveRulesDto } from './dto/save-rules.dto';
import { WorkflowTransitionsService } from './workflow-transitions.service';

describe('WorkflowTransitionsService', () => {
  let service: WorkflowTransitionsService;
  let mockFrom: jest.Mock;
  let registry: jest.Mocked<HandlerRegistryService>;
  let auditLogsService: jest.Mocked<AuditLogsService>;

  const ORG = 'org-1';
  const TX_ID = 'tx-1';
  const ACTOR = 'user-1';

  function joinedWorkflow(overrides: Record<string, unknown> = {}) {
    return {
      organization_id: ORG,
      is_active: false,
      is_draft: false,
      is_archived: false,
      ...overrides,
    };
  }

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
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

  /**
   * Build a `from` implementation that returns chains keyed by table name.
   * For tables whose value is an array, consecutive calls pop the next chain
   * — so a single test can stub SELECT vs UPDATE on the same table.
   */
  function makeFromImpl(
    map: Record<
      string,
      ReturnType<typeof buildChain> | ReturnType<typeof buildChain>[]
    >,
  ) {
    const queues: Record<string, ReturnType<typeof buildChain>[]> = {};

    for (const [table, value] of Object.entries(map)) {
      queues[table] = Array.isArray(value) ? [...value] : [value];
    }

    return (table: string) => {
      const queue = queues[table];

      if (!queue || queue.length === 0) {
        throw new Error(`Unexpected from(${table}) call in test`);
      }
      // Always re-use the last chain once the queue is drained so the same
      // table can be referenced repeatedly inside the SUT without forcing
      // tests to stub every call site.
      return queue.length > 1 ? queue.shift()! : queue[0];
    };
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    registry = {
      validatePayload: jest.fn(),
      collectReferences: jest.fn(),
    } as unknown as jest.Mocked<HandlerRegistryService>;

    auditLogsService = {
      logAction: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogsService>;

    service = new WorkflowTransitionsService(supa, registry, auditLogsService);
  });

  const emptyDto = (): SaveRulesDto =>
    ({
      conditions: [],
      validators: [],
      post_functions: [],
      triggers: [],
    }) as SaveRulesDto;

  describe('saveRules', () => {
    it('persists valid payload and returns updated row', async () => {
      const selectChain = buildChain({
        data: {
          id: TX_ID,
          workflow_id: 'w1',
          workflows: joinedWorkflow(),
        },
        error: null,
      });
      const updatedRow = {
        id: TX_ID,
        workflow_id: 'w1',
        name: 'Go',
        description: null,
        kind: 'regular',
        to_node_id: 'node-1',
        screen_field_group_id: null,
        conditions: [],
        validators: [],
        post_functions: [],
        triggers: [],
        properties: {},
        sort_order: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-05-17T00:00:00Z',
      };
      const updateChain = buildChain({ data: updatedRow, error: null });

      mockFrom.mockImplementation(
        makeFromImpl({
          workflow_transitions: [selectChain, updateChain],
        }),
      );

      registry.validatePayload.mockReturnValue(undefined);
      registry.collectReferences.mockReturnValue([] as IRuleReference[]);

      const result = await service.saveRules(TX_ID, ORG, emptyDto(), ACTOR);

      expect(result).toEqual(updatedRow);
      expect(registry.validatePayload).toHaveBeenCalledTimes(1);
      expect(registry.collectReferences).toHaveBeenCalledTimes(1);

      // The select chain was used for the org-verification join.
      expect(selectChain.select).toHaveBeenCalledWith(
        'id, workflow_id, workflows!inner(organization_id, is_active, is_draft, is_archived)',
      );
      expect(selectChain.eq).toHaveBeenCalledWith('id', TX_ID);
      expect(selectChain.maybeSingle).toHaveBeenCalledTimes(1);

      // The update chain wrote all four JSONB columns plus updated_at.
      expect(updateChain.update).toHaveBeenCalledTimes(1);
      const updateMock = updateChain.update as jest.Mock;
      const updateCalls = updateMock.mock.calls as Array<
        [Record<string, unknown>]
      >;
      const updateArg = updateCalls[0][0];

      expect(updateArg.conditions).toEqual([]);
      expect(updateArg.validators).toEqual([]);
      expect(updateArg.post_functions).toEqual([]);
      expect(updateArg.triggers).toEqual([]);
      expect(typeof updateArg.updated_at).toBe('string');
      expect(updateChain.eq).toHaveBeenCalledWith('id', TX_ID);
      expect(updateChain.single).toHaveBeenCalledTimes(1);

      // Best-effort audit log fired.
      expect(auditLogsService.logAction).toHaveBeenCalledTimes(1);
      const auditCall = auditLogsService.logAction.mock.calls[0];

      expect(auditCall[0]).toBe(ORG);
      expect(auditCall[1]).toBe(ACTOR);
      expect(auditCall[2]).toBe('workflow_transition');
      expect(auditCall[3]).toBe(TX_ID);
      expect(auditCall[4]).toBe('update');
      const changes = auditCall[5] as Record<string, unknown>;

      expect(changes.action).toBe('save_rules');
      expect(changes.conditions_count).toBe(0);
      expect(changes.validators_count).toBe(0);
      expect(changes.post_functions_count).toBe(0);
      expect(changes.triggers_count).toBe(0);
    });

    it('surfaces UnprocessableEntityException from validatePayload (unknown rule type)', async () => {
      const selectChain = buildChain({
        data: {
          id: TX_ID,
          workflow_id: 'w1',
          workflows: joinedWorkflow(),
        },
        error: null,
      });
      const updateChain = buildChain({ data: null, error: null });

      mockFrom.mockImplementation(
        makeFromImpl({
          workflow_transitions: [selectChain, updateChain],
        }),
      );

      registry.validatePayload.mockImplementation(() => {
        throw new UnprocessableEntityException({
          message: 'Invalid rule',
          data: {
            issues: [
              {
                phase: 'conditions',
                index: 0,
                type: 'unknown_type',
                path: 'type',
                message: 'unknown',
              },
            ],
          },
        });
      });

      let caught: unknown;

      try {
        await service.saveRules(TX_ID, ORG, emptyDto(), ACTOR);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(UnprocessableEntityException);
      const response = (
        caught as UnprocessableEntityException
      ).getResponse() as {
        message?: string;
        data?: { issues?: Array<Record<string, unknown>> };
      };

      expect(response.data?.issues).toBeDefined();
      expect(response.data?.issues?.[0]?.type).toBe('unknown_type');

      // UPDATE was never attempted because validation failed first.
      expect(updateChain.update).not.toHaveBeenCalled();
      expect(auditLogsService.logAction).not.toHaveBeenCalled();
    });

    it('rejects cross-org reference with 422 + missing list', async () => {
      const selectChain = buildChain({
        data: {
          id: TX_ID,
          workflow_id: 'w1',
          workflows: joinedWorkflow(),
        },
        error: null,
      });
      const updateChain = buildChain({ data: null, error: null });
      // task_statuses lookup returns zero rows -> the referenced status
      // is treated as cross-org and reported via `missing`.
      const statusChain = buildChain({ data: [], error: null });

      mockFrom.mockImplementation(
        makeFromImpl({
          workflow_transitions: [selectChain, updateChain],
          task_statuses: statusChain,
        }),
      );

      registry.validatePayload.mockReturnValue(undefined);
      registry.collectReferences.mockReturnValue([
        { kind: 'status', id: 'status-foreign' },
      ] as IRuleReference[]);

      let caught: unknown;

      try {
        await service.saveRules(TX_ID, ORG, emptyDto(), ACTOR);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(UnprocessableEntityException);
      const response = (
        caught as UnprocessableEntityException
      ).getResponse() as {
        message?: string;
        data?: { missing?: Array<{ kind: string; id: string }> };
      };

      expect(response.data?.missing).toEqual([
        { kind: 'status', id: 'status-foreign' },
      ]);

      // Verify the lookup was scoped to this org.
      expect(statusChain.select).toHaveBeenCalledWith('id');
      expect(statusChain.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(statusChain.in).toHaveBeenCalledWith('id', ['status-foreign']);

      // UPDATE was never attempted because a ref was cross-org.
      expect(updateChain.update).not.toHaveBeenCalled();
      expect(auditLogsService.logAction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for transition in another org', async () => {
      const selectChain = buildChain({
        data: {
          id: TX_ID,
          workflow_id: 'w1',
          workflows: joinedWorkflow({ organization_id: 'org-OTHER' }),
        },
        error: null,
      });
      const updateChain = buildChain({ data: null, error: null });

      mockFrom.mockImplementation(
        makeFromImpl({
          workflow_transitions: [selectChain, updateChain],
        }),
      );

      let caught: unknown;

      try {
        await service.saveRules(TX_ID, ORG, emptyDto(), ACTOR);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(NotFoundException);
      expect((caught as NotFoundException).message).toBe(
        'Transition not found',
      );

      // Cross-org access must short-circuit before any further work.
      expect(registry.validatePayload).not.toHaveBeenCalled();
      expect(registry.collectReferences).not.toHaveBeenCalled();
      expect(updateChain.update).not.toHaveBeenCalled();
      expect(auditLogsService.logAction).not.toHaveBeenCalled();
    });

    it('rejects direct rule edits on active non-draft workflows', async () => {
      const selectChain = buildChain({
        data: {
          id: TX_ID,
          workflow_id: 'w1',
          workflows: joinedWorkflow({ is_active: true, is_draft: false }),
        },
        error: null,
      });
      const updateChain = buildChain({ data: null, error: null });

      mockFrom.mockImplementation(
        makeFromImpl({
          workflow_transitions: [selectChain, updateChain],
        }),
      );

      await expect(
        service.saveRules(TX_ID, ORG, emptyDto(), ACTOR),
      ).rejects.toThrow(ConflictException);
      expect(registry.validatePayload).not.toHaveBeenCalled();
      expect(registry.collectReferences).not.toHaveBeenCalled();
      expect(updateChain.update).not.toHaveBeenCalled();
      expect(auditLogsService.logAction).not.toHaveBeenCalled();
    });

    it('rejects direct rule edits on archived workflows', async () => {
      const selectChain = buildChain({
        data: {
          id: TX_ID,
          workflow_id: 'w1',
          workflows: joinedWorkflow({ is_archived: true }),
        },
        error: null,
      });
      const updateChain = buildChain({ data: null, error: null });

      mockFrom.mockImplementation(
        makeFromImpl({
          workflow_transitions: [selectChain, updateChain],
        }),
      );

      await expect(
        service.saveRules(TX_ID, ORG, emptyDto(), ACTOR),
      ).rejects.toThrow(ConflictException);
      expect(registry.validatePayload).not.toHaveBeenCalled();
      expect(registry.collectReferences).not.toHaveBeenCalled();
      expect(updateChain.update).not.toHaveBeenCalled();
      expect(auditLogsService.logAction).not.toHaveBeenCalled();
    });
  });
});
