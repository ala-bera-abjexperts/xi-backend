/**
 * @fileoverview Unit tests for ClearResolutionPostFunction.
 * @module src/workflow-engine/handlers/post-functions/clear-resolution.post.spec
 * @author Rajbha Manek
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ClearResolutionPostFunction,
  type ClearResolutionConfig,
} from './clear-resolution.post';
import type { IEvaluationContext } from '../handler.types';

describe('ClearResolutionPostFunction', () => {
  const handler = new ClearResolutionPostFunction();

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

  function makeTxn(updateError: { message: string } | null = null): {
    txn: SupabaseClient;
    update: jest.Mock;
    eqId: jest.Mock;
    eqOrg: jest.Mock;
  } {
    const eqOrg = jest
      .fn()
      .mockResolvedValue({ data: null, error: updateError });
    const eqId = jest.fn().mockReturnValue({ eq: eqOrg });
    const update = jest.fn().mockReturnValue({ eq: eqId });
    const from = jest.fn().mockReturnValue({ update });
    const txn = { from } as unknown as SupabaseClient;

    return { txn, update, eqId, eqOrg };
  }

  describe('schema', () => {
    it('accepts a valid config', () => {
      const r = handler.schema.safeParse({ type: 'clear_resolution' });

      expect(r.success).toBe(true);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({ type: 'set_resolution' });

      expect(r.success).toBe(false);
    });

    it('rejects missing type', () => {
      const r = handler.schema.safeParse({});

      expect(r.success).toBe(false);
    });
  });

  describe('run', () => {
    it('updates tasks setting resolution_id and resolved_at to null', async () => {
      const { txn, update, eqId, eqOrg } = makeTxn();
      const cfg: ClearResolutionConfig = { type: 'clear_resolution' };

      await handler.run(cfg, ctx({ txn }));
      expect(update).toHaveBeenCalledWith({
        resolution_id: null,
        resolved_at: null,
      });
      expect(eqId).toHaveBeenCalledWith('id', 'task-1');
      expect(eqOrg).toHaveBeenCalledWith('organization_id', 'org-1');
    });

    it('throws when Supabase returns an error', async () => {
      const { txn } = makeTxn({ message: 'pg down' });
      const cfg: ClearResolutionConfig = { type: 'clear_resolution' };

      await expect(handler.run(cfg, ctx({ txn }))).rejects.toThrow(/pg down/);
    });

    it('throws when ctx.txn is missing', async () => {
      const cfg: ClearResolutionConfig = { type: 'clear_resolution' };

      await expect(handler.run(cfg, ctx())).rejects.toThrow(/requires ctx.txn/);
    });

    it('throws when ctx.taskId is missing', async () => {
      const { txn } = makeTxn();
      const cfg: ClearResolutionConfig = { type: 'clear_resolution' };

      await expect(
        handler.run(cfg, ctx({ txn, taskId: null })),
      ).rejects.toThrow(/requires ctx.taskId/);
    });
  });

  describe('findReferences', () => {
    it('returns empty array', () => {
      const refs = handler.findReferences({ type: 'clear_resolution' });

      expect(refs).toEqual([]);
    });
  });
});
