/**
 * @fileoverview Unit tests for AssignToPostFunction.
 * @module src/workflow-engine/handlers/post-functions/assign-to.post.spec
 * @author Rajbha Manek
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { AssignToPostFunction, type AssignToConfig } from './assign-to.post';
import type { IEvaluationContext } from '../handler.types';

describe('AssignToPostFunction', () => {
  const handler = new AssignToPostFunction();
  const userId = '123e4567-e89b-12d3-a456-426614174000';
  const roleId = '123e4567-e89b-12d3-a456-426614174001';
  const groupId = '123e4567-e89b-12d3-a456-426614174002';

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

  /** Build a chainable mock that records the final update payload. */
  function makeTxn(updateError: { message: string } | null = null): {
    txn: SupabaseClient;
    update: jest.Mock;
    eqOrg: jest.Mock;
    eqId: jest.Mock;
  } {
    const eqOrg = jest
      .fn()
      .mockResolvedValue({ data: null, error: updateError });
    const eqId = jest.fn().mockReturnValue({ eq: eqOrg });
    const update = jest.fn().mockReturnValue({ eq: eqId });
    const from = jest.fn().mockReturnValue({ update });
    const txn = { from } as unknown as SupabaseClient;

    return { txn, update, eqOrg, eqId };
  }

  describe('schema', () => {
    it('accepts mode=user with user_id', () => {
      const r = handler.schema.safeParse({
        type: 'assign_to',
        mode: 'user',
        user_id: userId,
      });

      expect(r.success).toBe(true);
    });

    it('accepts mode=role with role_id', () => {
      const r = handler.schema.safeParse({
        type: 'assign_to',
        mode: 'role',
        role_id: roleId,
      });

      expect(r.success).toBe(true);
    });

    it('accepts mode=group with group_id', () => {
      const r = handler.schema.safeParse({
        type: 'assign_to',
        mode: 'group',
        group_id: groupId,
      });

      expect(r.success).toBe(true);
    });

    it('accepts mode=unassign with no id', () => {
      const r = handler.schema.safeParse({
        type: 'assign_to',
        mode: 'unassign',
      });

      expect(r.success).toBe(true);
    });

    it('rejects mode=user with non-uuid user_id', () => {
      const r = handler.schema.safeParse({
        type: 'assign_to',
        mode: 'user',
        user_id: 'not-a-uuid',
      });

      expect(r.success).toBe(false);
    });

    it('rejects unknown mode', () => {
      const r = handler.schema.safeParse({
        type: 'assign_to',
        mode: 'something',
        user_id: userId,
      });

      expect(r.success).toBe(false);
    });
  });

  describe('run', () => {
    it('updates tasks.assigned_to with the user_id for mode=user', async () => {
      const { txn, update } = makeTxn();
      const cfg: AssignToConfig = {
        type: 'assign_to',
        mode: 'user',
        user_id: userId,
      };

      await handler.run(cfg, ctx({ txn }));
      expect(update).toHaveBeenCalledWith({ assigned_to: userId });
    });

    it('sets assigned_to=null for mode=unassign', async () => {
      const { txn, update } = makeTxn();
      const cfg: AssignToConfig = {
        type: 'assign_to',
        mode: 'unassign',
      };

      await handler.run(cfg, ctx({ txn }));
      expect(update).toHaveBeenCalledWith({ assigned_to: null });
    });

    it('no-ops with a warning for mode=role', async () => {
      const { txn, update } = makeTxn();
      const warn = jest
        .spyOn(
          (handler as unknown as { logger: { warn: () => void } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);
      const cfg: AssignToConfig = {
        type: 'assign_to',
        mode: 'role',
        role_id: roleId,
      };

      await handler.run(cfg, ctx({ txn }));
      expect(update).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('no-ops with a warning for mode=group', async () => {
      const { txn, update } = makeTxn();
      const warn = jest
        .spyOn(
          (handler as unknown as { logger: { warn: () => void } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);
      const cfg: AssignToConfig = {
        type: 'assign_to',
        mode: 'group',
        group_id: groupId,
      };

      await handler.run(cfg, ctx({ txn }));
      expect(update).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('scopes the update by id and organization_id', async () => {
      const { txn, eqId, eqOrg } = makeTxn();
      const cfg: AssignToConfig = {
        type: 'assign_to',
        mode: 'user',
        user_id: userId,
      };

      await handler.run(cfg, ctx({ txn }));
      expect(eqId).toHaveBeenCalledWith('id', 'task-1');
      expect(eqOrg).toHaveBeenCalledWith('organization_id', 'org-1');
    });

    it('throws when Supabase returns an error', async () => {
      const { txn } = makeTxn({ message: 'pg failure' });
      const cfg: AssignToConfig = {
        type: 'assign_to',
        mode: 'user',
        user_id: userId,
      };

      await expect(handler.run(cfg, ctx({ txn }))).rejects.toThrow(
        /pg failure/,
      );
    });

    it('throws when ctx.txn is missing', async () => {
      const cfg: AssignToConfig = {
        type: 'assign_to',
        mode: 'unassign',
      };

      await expect(handler.run(cfg, ctx())).rejects.toThrow(/requires ctx.txn/);
    });

    it('throws when ctx.taskId is missing', async () => {
      const { txn } = makeTxn();
      const cfg: AssignToConfig = {
        type: 'assign_to',
        mode: 'unassign',
      };

      await expect(
        handler.run(cfg, ctx({ txn, taskId: null })),
      ).rejects.toThrow(/requires ctx.taskId/);
    });
  });

  describe('findReferences', () => {
    it('returns the user reference for mode=user', () => {
      const refs = handler.findReferences({
        type: 'assign_to',
        mode: 'user',
        user_id: userId,
      });

      expect(refs).toEqual([{ kind: 'user', id: userId }]);
    });

    it('returns the role reference for mode=role', () => {
      const refs = handler.findReferences({
        type: 'assign_to',
        mode: 'role',
        role_id: roleId,
      });

      expect(refs).toEqual([{ kind: 'role', id: roleId }]);
    });

    it('returns the group reference for mode=group', () => {
      const refs = handler.findReferences({
        type: 'assign_to',
        mode: 'group',
        group_id: groupId,
      });

      expect(refs).toEqual([{ kind: 'group', id: groupId }]);
    });

    it('returns empty for mode=unassign', () => {
      const refs = handler.findReferences({
        type: 'assign_to',
        mode: 'unassign',
      });

      expect(refs).toEqual([]);
    });
  });
});
