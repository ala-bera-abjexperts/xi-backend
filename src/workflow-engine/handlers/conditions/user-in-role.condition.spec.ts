/**
 * @fileoverview Unit tests for UserInRoleCondition.
 * @module src/workflow-engine/handlers/conditions/user-in-role.condition.spec
 * @author Rajbha Manek
 */

import {
  UserInRoleCondition,
  type UserInRoleConfig,
} from './user-in-role.condition';
import type { IEvaluationContext } from '../handler.types';

describe('UserInRoleCondition', () => {
  const handler = new UserInRoleCondition();
  const roleId = '123e4567-e89b-12d3-a456-426614174000';

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

  describe('schema', () => {
    it('accepts a valid config', () => {
      const r = handler.schema.safeParse({
        type: 'user_in_role',
        role_id: roleId,
      });

      expect(r.success).toBe(true);
    });

    it('rejects non-uuid role_id', () => {
      const r = handler.schema.safeParse({
        type: 'user_in_role',
        role_id: 'not-a-uuid',
      });

      expect(r.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({
        type: 'something_else',
        role_id: roleId,
      });

      expect(r.success).toBe(false);
    });
  });

  describe('evaluate', () => {
    const cfg: UserInRoleConfig = { type: 'user_in_role', role_id: roleId };

    it('true when user has the role', async () => {
      expect(
        await handler.evaluate(cfg, ctx({ userRoles: [roleId, 'other'] })),
      ).toBe(true);
    });

    it('false when user does not have the role', async () => {
      expect(await handler.evaluate(cfg, ctx({ userRoles: ['other'] }))).toBe(
        false,
      );
    });

    it('false when userRoles is empty', async () => {
      expect(await handler.evaluate(cfg, ctx({ userRoles: [] }))).toBe(false);
    });
  });

  describe('findReferences', () => {
    it('returns the role id', () => {
      const refs = handler.findReferences({
        type: 'user_in_role',
        role_id: roleId,
      });

      expect(refs).toEqual([{ kind: 'role', id: roleId }]);
    });
  });
});
