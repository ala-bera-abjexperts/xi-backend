/**
 * @fileoverview Unit tests for ParentTransitionedTrigger.
 * @module src/workflow-engine/handlers/triggers/parent-transitioned.trigger.spec
 * @author Rajbha Manek
 */

import { ParentTransitionedTrigger } from './parent-transitioned.trigger';
import type { IEvaluationContext } from '../handler.types';

describe('ParentTransitionedTrigger', () => {
  const handler = new ParentTransitionedTrigger();
  const statusId = '123e4567-e89b-12d3-a456-426614174010';
  const workflowId = '123e4567-e89b-12d3-a456-426614174011';

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
    it('accepts a config with parent_status_id only', () => {
      const r = handler.schema.safeParse({
        type: 'parent_transitioned',
        parent_status_id: statusId,
      });

      expect(r.success).toBe(true);
    });

    it('accepts a config with parent_workflow_id only', () => {
      const r = handler.schema.safeParse({
        type: 'parent_transitioned',
        parent_workflow_id: workflowId,
      });

      expect(r.success).toBe(true);
    });

    it('accepts a config with both ids', () => {
      const r = handler.schema.safeParse({
        type: 'parent_transitioned',
        parent_status_id: statusId,
        parent_workflow_id: workflowId,
      });

      expect(r.success).toBe(true);
    });

    it('accepts an optional child_target_status_id', () => {
      const r = handler.schema.safeParse({
        type: 'parent_transitioned',
        parent_status_id: statusId,
        child_target_status_id: statusId,
      });

      expect(r.success).toBe(true);
    });

    it('rejects a non-uuid child_target_status_id', () => {
      const r = handler.schema.safeParse({
        type: 'parent_transitioned',
        parent_status_id: statusId,
        child_target_status_id: 'not-a-uuid',
      });

      expect(r.success).toBe(false);
    });

    it('rejects a config with neither id', () => {
      const r = handler.schema.safeParse({
        type: 'parent_transitioned',
      });

      expect(r.success).toBe(false);
    });

    it('rejects non-uuid parent_status_id', () => {
      const r = handler.schema.safeParse({
        type: 'parent_transitioned',
        parent_status_id: 'not-a-uuid',
      });

      expect(r.success).toBe(false);
    });

    it('rejects non-uuid parent_workflow_id', () => {
      const r = handler.schema.safeParse({
        type: 'parent_transitioned',
        parent_workflow_id: 'not-a-uuid',
      });

      expect(r.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({
        type: 'something_else',
        parent_status_id: statusId,
      });

      expect(r.success).toBe(false);
    });
  });

  describe('findReferences', () => {
    it('returns an empty array', () => {
      const refs = handler.findReferences({
        type: 'parent_transitioned',
        parent_status_id: statusId,
      });

      expect(refs).toEqual([]);
    });

    it('returns the child target status ref when set', () => {
      const refs = handler.findReferences({
        type: 'parent_transitioned',
        parent_status_id: statusId,
        child_target_status_id: statusId,
      });

      expect(refs).toEqual([{ kind: 'status', id: statusId }]);
    });
  });

  describe('subscribe (stub)', () => {
    it('subscribe() rejects with not-implemented error', async () => {
      await expect(
        handler.subscribe(
          { type: 'parent_transitioned', parent_status_id: statusId },
          ctx(),
        ),
      ).rejects.toThrow(/not implemented in v1/);
    });

    it('unsubscribe() rejects with not-implemented error', async () => {
      await expect(
        handler.unsubscribe(
          { type: 'parent_transitioned', parent_workflow_id: workflowId },
          ctx(),
        ),
      ).rejects.toThrow(/not implemented in v1/);
    });
  });
});
