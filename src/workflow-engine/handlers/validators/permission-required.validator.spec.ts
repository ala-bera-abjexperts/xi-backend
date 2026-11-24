/**
 * @fileoverview Unit tests for PermissionRequiredValidator.
 * @module src/workflow-engine/handlers/validators/permission-required.validator.spec
 * @author Rajbha Manek
 */

import {
  PermissionRequiredValidator,
  type PermissionRequiredConfig,
} from './permission-required.validator';
import type { IEvaluationContext } from '../handler.types';

describe('PermissionRequiredValidator', () => {
  const handler = new PermissionRequiredValidator();
  const permKey = 'can_close_tasks';

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
        type: 'permission_required',
        permission_key: permKey,
      });

      expect(r.success).toBe(true);
    });

    it('accepts config with custom message', () => {
      const r = handler.schema.safeParse({
        type: 'permission_required',
        permission_key: permKey,
        message: 'You cannot do that',
      });

      expect(r.success).toBe(true);
    });

    it('rejects empty permission_key', () => {
      const r = handler.schema.safeParse({
        type: 'permission_required',
        permission_key: '',
      });

      expect(r.success).toBe(false);
    });

    it('rejects permission_key longer than 80 chars', () => {
      const r = handler.schema.safeParse({
        type: 'permission_required',
        permission_key: 'x'.repeat(81),
      });

      expect(r.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({
        type: 'something_else',
        permission_key: permKey,
      });

      expect(r.success).toBe(false);
    });
  });

  describe('validate', () => {
    const cfg: PermissionRequiredConfig = {
      type: 'permission_required',
      permission_key: permKey,
    };

    it('ok when user has the permission', async () => {
      const result = await handler.validate(
        cfg,
        ctx({ user: { permissions: { [permKey]: true } } }),
      );

      expect(result.ok).toBe(true);
    });

    it('invalid when user lacks the permission', async () => {
      const result = await handler.validate(
        cfg,
        ctx({ user: { permissions: { other_perm: true } } }),
      );

      expect(result.ok).toBe(false);
      expect(result.message).toContain(permKey);
    });

    it('invalid when permission is explicitly false', async () => {
      const result = await handler.validate(
        cfg,
        ctx({ user: { permissions: { [permKey]: false } } }),
      );

      expect(result.ok).toBe(false);
    });

    it('invalid when user object has no permissions field', async () => {
      const result = await handler.validate(cfg, ctx({ user: {} }));

      expect(result.ok).toBe(false);
    });

    it('invalid when user is null', async () => {
      const result = await handler.validate(cfg, ctx({ user: null }));

      expect(result.ok).toBe(false);
    });

    it('uses custom message on failure', async () => {
      const result = await handler.validate(
        { ...cfg, message: 'Need admin role' },
        ctx({ user: null }),
      );

      expect(result.message).toBe('Need admin role');
    });
  });

  describe('findReferences', () => {
    it('returns the permission key', () => {
      const refs = handler.findReferences({
        type: 'permission_required',
        permission_key: permKey,
      });

      expect(refs).toEqual([{ kind: 'permission', id: permKey }]);
    });
  });
});
