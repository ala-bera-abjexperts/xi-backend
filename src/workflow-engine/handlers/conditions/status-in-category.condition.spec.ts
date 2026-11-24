/**
 * @fileoverview Unit tests for StatusInCategoryCondition.
 * @module src/workflow-engine/handlers/conditions/status-in-category.condition.spec
 * @author Rajbha Manek
 */

import {
  StatusInCategoryCondition,
  type StatusInCategoryConfig,
} from './status-in-category.condition';
import type { IEvaluationContext } from '../handler.types';

describe('StatusInCategoryCondition', () => {
  const handler = new StatusInCategoryCondition();
  const categoryId = '123e4567-e89b-12d3-a456-426614174000';
  const otherCategoryId = '223e4567-e89b-42d3-a456-426614174000';

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
        type: 'status_in_category',
        category_id: categoryId,
      });

      expect(r.success).toBe(true);
    });

    it('rejects non-uuid category_id', () => {
      const r = handler.schema.safeParse({
        type: 'status_in_category',
        category_id: 'not-a-uuid',
      });

      expect(r.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({
        type: 'something_else',
        category_id: categoryId,
      });

      expect(r.success).toBe(false);
    });
  });

  describe('evaluate', () => {
    const cfg: StatusInCategoryConfig = {
      type: 'status_in_category',
      category_id: categoryId,
    };

    it('true when task status_category_id matches', async () => {
      expect(
        await handler.evaluate(
          cfg,
          ctx({ task: { status_category_id: categoryId } }),
        ),
      ).toBe(true);
    });

    it('false when task status_category_id differs', async () => {
      expect(
        await handler.evaluate(
          cfg,
          ctx({ task: { status_category_id: otherCategoryId } }),
        ),
      ).toBe(false);
    });

    it('false when task is null', async () => {
      expect(await handler.evaluate(cfg, ctx({ task: null }))).toBe(false);
    });

    it('false when status_category_id is missing on task', async () => {
      expect(await handler.evaluate(cfg, ctx({ task: { id: 'task-1' } }))).toBe(
        false,
      );
    });
  });

  describe('findReferences', () => {
    it('returns the category id', () => {
      expect(
        handler.findReferences({
          type: 'status_in_category',
          category_id: categoryId,
        }),
      ).toEqual([{ kind: 'category', id: categoryId }]);
    });
  });
});
