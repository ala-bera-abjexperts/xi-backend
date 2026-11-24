/**
 * @fileoverview Unit tests for GroupCondition (recursive ANY/ALL).
 * @module src/workflow-engine/handlers/conditions/group.condition.spec
 * @author Rajbha Manek
 */

import { GroupCondition, type GroupConfig } from './group.condition';
import { UserInRoleCondition } from './user-in-role.condition';
import { IsAssigneeCondition } from './is-assignee.condition';
import { HandlerRegistryService } from '../handler-registry.service';
import { WORKFLOW_HANDLERS } from '../handler.types';
import type { AnyHandler, IEvaluationContext } from '../handler.types';
import { Test } from '@nestjs/testing';

describe('GroupCondition', () => {
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

  let handler: GroupCondition;

  beforeEach(async () => {
    const userInRole = new UserInRoleCondition();
    const isAssignee = new IsAssigneeCondition();
    const groupHandler = new GroupCondition();
    const moduleRef = await Test.createTestingModule({
      providers: [
        HandlerRegistryService,
        { provide: GroupCondition, useValue: groupHandler },
        { provide: UserInRoleCondition, useValue: userInRole },
        { provide: IsAssigneeCondition, useValue: isAssignee },
        {
          provide: WORKFLOW_HANDLERS,
          useFactory: (
            g: GroupCondition,
            r: UserInRoleCondition,
            a: IsAssigneeCondition,
          ): AnyHandler[] => [g, r, a],
          inject: [GroupCondition, UserInRoleCondition, IsAssigneeCondition],
        },
      ],
    }).compile();

    handler = moduleRef.get(GroupCondition);
    // Force HandlerRegistryService to materialise so setRegistry() is invoked.
    moduleRef.get(HandlerRegistryService);
  });

  describe('schema', () => {
    it('accepts a valid all/any group', () => {
      const r = handler.schema.safeParse({
        type: 'group',
        op: 'all',
        children: [],
      });

      expect(r.success).toBe(true);
    });

    it('rejects unknown op', () => {
      const r = handler.schema.safeParse({
        type: 'group',
        op: 'xor',
        children: [],
      });

      expect(r.success).toBe(false);
    });

    it('rejects more than 50 children', () => {
      const children = new Array(51).fill({ type: 'is_assignee' });
      const r = handler.schema.safeParse({
        type: 'group',
        op: 'all',
        children,
      });

      expect(r.success).toBe(false);
    });

    it('rejects depth-6 nested groups', () => {
      let nested: unknown = { type: 'group', op: 'all', children: [] };

      for (let i = 0; i < 5; i++) {
        nested = { type: 'group', op: 'all', children: [nested] };
      }
      const r = handler.schema.safeParse(nested);

      expect(r.success).toBe(false);
    });

    it('accepts depth-5 nested groups', () => {
      let nested: unknown = { type: 'group', op: 'all', children: [] };

      for (let i = 0; i < 4; i++) {
        nested = { type: 'group', op: 'all', children: [nested] };
      }
      const r = handler.schema.safeParse(nested);

      expect(r.success).toBe(true);
    });

    it('accepts leaf conditions inside the deepest allowed group', () => {
      let nested: unknown = {
        type: 'group',
        op: 'all',
        children: [{ type: 'is_assignee' }],
      };

      for (let i = 0; i < 4; i++) {
        nested = { type: 'group', op: 'all', children: [nested] };
      }
      const r = handler.schema.safeParse(nested);

      expect(r.success).toBe(true);
    });
  });

  describe('evaluate — empty groups', () => {
    it('empty all group is true', async () => {
      const cfg: GroupConfig = { type: 'group', op: 'all', children: [] };

      expect(await handler.evaluate(cfg, ctx())).toBe(true);
    });

    it('empty any group is false', async () => {
      const cfg: GroupConfig = { type: 'group', op: 'any', children: [] };

      expect(await handler.evaluate(cfg, ctx())).toBe(false);
    });
  });

  describe('evaluate — mixed children', () => {
    it('all: one true + one false → false', async () => {
      const cfg: GroupConfig = {
        type: 'group',
        op: 'all',
        children: [
          { type: 'user_in_role', role_id: roleId },
          { type: 'is_assignee' },
        ],
      };

      expect(await handler.evaluate(cfg, ctx({ userRoles: [roleId] }))).toBe(
        false,
      );
    });

    it('any: one true + one false → true', async () => {
      const cfg: GroupConfig = {
        type: 'group',
        op: 'any',
        children: [
          { type: 'user_in_role', role_id: roleId },
          { type: 'is_assignee' },
        ],
      };

      expect(await handler.evaluate(cfg, ctx({ userRoles: [roleId] }))).toBe(
        true,
      );
    });

    it('all: both true → true', async () => {
      const cfg: GroupConfig = {
        type: 'group',
        op: 'all',
        children: [
          { type: 'user_in_role', role_id: roleId },
          { type: 'is_assignee' },
        ],
      };

      expect(
        await handler.evaluate(
          cfg,
          ctx({
            userRoles: [roleId],
            userId: 'user-1',
            task: { assigned_to: 'user-1' },
          }),
        ),
      ).toBe(true);
    });

    it('any: all false → false', async () => {
      const cfg: GroupConfig = {
        type: 'group',
        op: 'any',
        children: [
          { type: 'user_in_role', role_id: roleId },
          { type: 'is_assignee' },
        ],
      };

      expect(await handler.evaluate(cfg, ctx())).toBe(false);
    });

    it('returns false for unknown child types', async () => {
      const cfg: GroupConfig = {
        type: 'group',
        op: 'any',
        children: [{ type: 'unknown_handler' }],
      };

      expect(await handler.evaluate(cfg, ctx())).toBe(false);
    });
  });

  describe('evaluate — nested groups', () => {
    it('nested all inside any: true when nested is true', async () => {
      const cfg: GroupConfig = {
        type: 'group',
        op: 'any',
        children: [
          {
            type: 'group',
            op: 'all',
            children: [{ type: 'user_in_role', role_id: roleId }],
          },
        ],
      };

      expect(await handler.evaluate(cfg, ctx({ userRoles: [roleId] }))).toBe(
        true,
      );
    });

    it('deeply nested groups are evaluated', async () => {
      const cfg: GroupConfig = {
        type: 'group',
        op: 'all',
        children: [
          {
            type: 'group',
            op: 'any',
            children: [
              { type: 'is_assignee' },
              { type: 'user_in_role', role_id: roleId },
            ],
          },
        ],
      };

      expect(await handler.evaluate(cfg, ctx({ userRoles: [roleId] }))).toBe(
        true,
      );
    });
  });

  describe('findReferences', () => {
    it('aggregates references from children', () => {
      const refs = handler.findReferences({
        type: 'group',
        op: 'all',
        children: [
          { type: 'user_in_role', role_id: roleId },
          { type: 'is_assignee' },
        ],
      });

      expect(refs).toEqual([{ kind: 'role', id: roleId }]);
    });

    it('ignores unknown child types', () => {
      const refs = handler.findReferences({
        type: 'group',
        op: 'all',
        children: [{ type: 'unknown_type' }],
      });

      expect(refs).toEqual([]);
    });
  });
});
