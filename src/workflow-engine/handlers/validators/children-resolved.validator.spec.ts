/**
 * @fileoverview Unit tests for ChildrenResolvedValidator.
 * @module src/workflow-engine/handlers/validators/children-resolved.validator.spec
 * @author Rajbha Manek
 */

import {
  ChildrenResolvedValidator,
  type ChildrenResolvedConfig,
} from './children-resolved.validator';
import type { IEvaluationContext } from '../handler.types';

describe('ChildrenResolvedValidator', () => {
  const handler = new ChildrenResolvedValidator();

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
    it('accepts a minimal config', () => {
      const r = handler.schema.safeParse({ type: 'children_resolved' });

      expect(r.success).toBe(true);
    });

    it('accepts a config with custom message', () => {
      const r = handler.schema.safeParse({
        type: 'children_resolved',
        message: 'Resolve children first',
      });

      expect(r.success).toBe(true);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({ type: 'something_else' });

      expect(r.success).toBe(false);
    });

    it('rejects message longer than 200 chars', () => {
      const r = handler.schema.safeParse({
        type: 'children_resolved',
        message: 'x'.repeat(201),
      });

      expect(r.success).toBe(false);
    });
  });

  describe('validate', () => {
    const cfg: ChildrenResolvedConfig = { type: 'children_resolved' };

    it('ok when no children are unresolved', async () => {
      const result = await handler.validate(
        cfg,
        ctx({ task: { children_unresolved_count: 0 } }),
      );

      expect(result.ok).toBe(true);
    });

    it('invalid when there are unresolved children', async () => {
      const result = await handler.validate(
        cfg,
        ctx({ task: { children_unresolved_count: 3 } }),
      );

      expect(result.ok).toBe(false);
      expect(result.fieldPath).toBe('children');
    });

    it('invalid when children_unresolved_count is undefined (defensive)', async () => {
      const result = await handler.validate(cfg, ctx({ task: {} }));

      expect(result.ok).toBe(false);
    });

    it('invalid when task is null', async () => {
      const result = await handler.validate(cfg, ctx({ task: null }));

      expect(result.ok).toBe(false);
    });

    it('uses custom message on failure', async () => {
      const result = await handler.validate(
        { ...cfg, message: 'Close subtasks first' },
        ctx({ task: { children_unresolved_count: 1 } }),
      );

      expect(result.message).toBe('Close subtasks first');
    });
  });

  describe('findReferences', () => {
    it('returns empty list', () => {
      const refs = handler.findReferences();

      expect(refs).toEqual([]);
    });
  });
});
