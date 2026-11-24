/**
 * @fileoverview Unit tests for SetResolutionPostFunction.
 * @module src/workflow-engine/handlers/post-functions/set-resolution.post.spec
 * @author Prince Jadiya
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  SetResolutionPostFunction,
  type SetResolutionConfig,
} from './set-resolution.post';
import type { IEvaluationContext } from '../handler.types';

describe('SetResolutionPostFunction', () => {
  const handler = new SetResolutionPostFunction();
  const resolutionId = '123e4567-e89b-12d3-a456-426614174000';

  const ctx = (
    overrides: Partial<IEvaluationContext> = {},
  ): IEvaluationContext => ({
    organizationId: 'org-1',
    spaceId: 'space-1',
    taskId: 'task-1',
    task: null,
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
   * Build a txn mock that returns `resolution` for the resolutions lookup and
   * records the UPDATE payload on tasks.
   */
  function makeTxn(
    opts: {
      resolution?: { id: string } | null;
      selectError?: { message: string } | null;
      updateError?: { message: string } | null;
    } = {},
  ): {
    txn: SupabaseClient;
    update: jest.Mock;
    fromCalls: string[];
  } {
    const fromCalls: string[] = [];

    const resolutionMaybeSingle = jest.fn().mockResolvedValue({
      data:
        opts.resolution === undefined ? { id: resolutionId } : opts.resolution,
      error: opts.selectError ?? null,
    });
    const resolutionLimit = jest
      .fn()
      .mockReturnValue({ maybeSingle: resolutionMaybeSingle });
    const resolutionEqOrg = jest
      .fn()
      .mockReturnValue({ limit: resolutionLimit });
    const resolutionEqId = jest.fn().mockReturnValue({ eq: resolutionEqOrg });
    const resolutionSelect = jest.fn().mockReturnValue({ eq: resolutionEqId });

    const updateEqOrg = jest
      .fn()
      .mockResolvedValue({ data: null, error: opts.updateError ?? null });
    const updateEqId = jest.fn().mockReturnValue({ eq: updateEqOrg });
    const update = jest.fn().mockReturnValue({ eq: updateEqId });

    const from = jest.fn().mockImplementation((tableName: string) => {
      fromCalls.push(tableName);
      if (tableName === 'resolutions') {
        return { select: resolutionSelect };
      }

      return { update };
    });
    const txn = { from } as unknown as SupabaseClient;

    return { txn, update, fromCalls };
  }

  describe('schema', () => {
    it('accepts a valid config', () => {
      const r = handler.schema.safeParse({
        type: 'set_resolution',
        resolution_id: resolutionId,
      });

      expect(r.success).toBe(true);
    });

    it('rejects non-uuid resolution_id', () => {
      const r = handler.schema.safeParse({
        type: 'set_resolution',
        resolution_id: 'not-a-uuid',
      });

      expect(r.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({
        type: 'clear_resolution',
        resolution_id: resolutionId,
      });

      expect(r.success).toBe(false);
    });

    it('rejects missing resolution_id', () => {
      const r = handler.schema.safeParse({ type: 'set_resolution' });

      expect(r.success).toBe(false);
    });
  });

  describe('run', () => {
    it('updates tasks.resolution_id and tasks.resolved_at', async () => {
      const { txn, update, fromCalls } = makeTxn();
      const cfg: SetResolutionConfig = {
        type: 'set_resolution',
        resolution_id: resolutionId,
      };

      await handler.run(cfg, ctx({ txn }));
      expect(fromCalls).toEqual(['resolutions', 'tasks']);
      const call = (update.mock.calls[0] as unknown[])[0] as Record<
        string,
        unknown
      >;

      expect(call.resolution_id).toBe(resolutionId);
      expect(typeof call.resolved_at).toBe('string');
    });

    it('throws BadRequestException when resolution is in a different org', async () => {
      const { txn, update } = makeTxn({ resolution: null });
      const cfg: SetResolutionConfig = {
        type: 'set_resolution',
        resolution_id: resolutionId,
      };

      await expect(handler.run(cfg, ctx({ txn }))).rejects.toThrow(
        /not found in org/,
      );
      expect(update).not.toHaveBeenCalled();
    });

    it('throws when the resolutions lookup errors', async () => {
      const { txn } = makeTxn({ selectError: { message: 'lookup down' } });
      const cfg: SetResolutionConfig = {
        type: 'set_resolution',
        resolution_id: resolutionId,
      };

      await expect(handler.run(cfg, ctx({ txn }))).rejects.toThrow(
        /lookup down/,
      );
    });

    it('throws when the tasks update errors', async () => {
      const { txn } = makeTxn({ updateError: { message: 'write down' } });
      const cfg: SetResolutionConfig = {
        type: 'set_resolution',
        resolution_id: resolutionId,
      };

      await expect(handler.run(cfg, ctx({ txn }))).rejects.toThrow(
        /write down/,
      );
    });

    it('throws when ctx.txn is missing', async () => {
      const cfg: SetResolutionConfig = {
        type: 'set_resolution',
        resolution_id: resolutionId,
      };

      await expect(handler.run(cfg, ctx())).rejects.toThrow(/requires ctx.txn/);
    });
  });

  describe('findReferences', () => {
    it('returns the resolution id', () => {
      const refs = handler.findReferences({
        type: 'set_resolution',
        resolution_id: resolutionId,
      });

      expect(refs).toEqual([{ kind: 'resolution', id: resolutionId }]);
    });
  });
});
