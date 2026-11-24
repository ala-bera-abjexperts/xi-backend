/**
 * @fileoverview Unit tests for ParentStatusIsCondition.
 * @module src/workflow-engine/handlers/conditions/parent-status-is.condition.spec
 * @author Rajbha Manek
 */

import {
  ParentStatusIsCondition,
  type ParentStatusIsConfig,
} from './parent-status-is.condition';
import type { IEvaluationContext } from '../handler.types';

describe('ParentStatusIsCondition', () => {
  const handler = new ParentStatusIsCondition();
  const statusId = '123e4567-e89b-12d3-a456-426614174000';
  const otherStatusId = '223e4567-e89b-42d3-a456-426614174000';
  const categoryId = '323e4567-e89b-42d3-a456-426614174000';
  const otherCategoryId = '423e4567-e89b-42d3-a456-426614174000';

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
    it('accepts parent_status_id only', () => {
      const r = handler.schema.safeParse({
        type: 'parent_status_is',
        parent_status_id: statusId,
      });

      expect(r.success).toBe(true);
    });

    it('accepts parent_category_id only', () => {
      const r = handler.schema.safeParse({
        type: 'parent_status_is',
        parent_category_id: categoryId,
      });

      expect(r.success).toBe(true);
    });

    it('rejects when both are set', () => {
      const r = handler.schema.safeParse({
        type: 'parent_status_is',
        parent_status_id: statusId,
        parent_category_id: categoryId,
      });

      expect(r.success).toBe(false);
    });

    it('rejects when neither is set', () => {
      const r = handler.schema.safeParse({ type: 'parent_status_is' });

      expect(r.success).toBe(false);
    });

    it('rejects non-uuid parent_status_id', () => {
      const r = handler.schema.safeParse({
        type: 'parent_status_is',
        parent_status_id: 'not-a-uuid',
      });

      expect(r.success).toBe(false);
    });
  });

  describe('evaluate — by parent_status_id', () => {
    const cfg: ParentStatusIsConfig = {
      type: 'parent_status_is',
      parent_status_id: statusId,
    };

    it('true when matches', async () => {
      expect(
        await handler.evaluate(
          cfg,
          ctx({ task: { parent_status_id: statusId } }),
        ),
      ).toBe(true);
    });

    it('false when differs', async () => {
      expect(
        await handler.evaluate(
          cfg,
          ctx({ task: { parent_status_id: otherStatusId } }),
        ),
      ).toBe(false);
    });

    it('false when task is null', async () => {
      expect(await handler.evaluate(cfg, ctx({ task: null }))).toBe(false);
    });
  });

  describe('evaluate — by parent_category_id', () => {
    const cfg: ParentStatusIsConfig = {
      type: 'parent_status_is',
      parent_category_id: categoryId,
    };

    it('true when category matches', async () => {
      expect(
        await handler.evaluate(
          cfg,
          ctx({ task: { parent_status_category_id: categoryId } }),
        ),
      ).toBe(true);
    });

    it('false when category differs', async () => {
      expect(
        await handler.evaluate(
          cfg,
          ctx({ task: { parent_status_category_id: otherCategoryId } }),
        ),
      ).toBe(false);
    });
  });

  describe('findReferences', () => {
    it('returns the status id when set', () => {
      expect(
        handler.findReferences({
          type: 'parent_status_is',
          parent_status_id: statusId,
        }),
      ).toEqual([{ kind: 'status', id: statusId }]);
    });

    it('returns the category id when set', () => {
      expect(
        handler.findReferences({
          type: 'parent_status_is',
          parent_category_id: categoryId,
        }),
      ).toEqual([{ kind: 'category', id: categoryId }]);
    });
  });
});
