/**
 * @fileoverview Unit tests for UserInGroupCondition.
 * @module src/workflow-engine/handlers/conditions/user-in-group.condition.spec
 * @author Rajbha Manek
 */

import {
  UserInGroupCondition,
  type UserInGroupConfig,
} from './user-in-group.condition';
import type { IEvaluationContext } from '../handler.types';

describe('UserInGroupCondition', () => {
  const handler = new UserInGroupCondition();
  const groupId = '123e4567-e89b-12d3-a456-426614174000';

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
        type: 'user_in_group',
        group_id: groupId,
      });

      expect(r.success).toBe(true);
    });

    it('rejects non-uuid group_id', () => {
      const r = handler.schema.safeParse({
        type: 'user_in_group',
        group_id: 'not-a-uuid',
      });

      expect(r.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({
        type: 'user_in_role',
        group_id: groupId,
      });

      expect(r.success).toBe(false);
    });
  });

  describe('evaluate', () => {
    const cfg: UserInGroupConfig = { type: 'user_in_group', group_id: groupId };

    it('true when user has the group', async () => {
      expect(
        await handler.evaluate(cfg, ctx({ userGroups: [groupId, 'other'] })),
      ).toBe(true);
    });

    it('false when user does not have the group', async () => {
      expect(await handler.evaluate(cfg, ctx({ userGroups: ['other'] }))).toBe(
        false,
      );
    });

    it('false when userGroups is empty', async () => {
      expect(await handler.evaluate(cfg, ctx({ userGroups: [] }))).toBe(false);
    });
  });

  describe('findReferences', () => {
    it('returns the group id', () => {
      const refs = handler.findReferences({
        type: 'user_in_group',
        group_id: groupId,
      });

      expect(refs).toEqual([{ kind: 'group', id: groupId }]);
    });
  });
});
