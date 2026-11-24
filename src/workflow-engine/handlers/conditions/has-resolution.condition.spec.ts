/**
 * @fileoverview Unit tests for HasResolutionCondition.
 * @module src/workflow-engine/handlers/conditions/has-resolution.condition.spec
 * @author Rajbha Manek
 */

import {
  HasResolutionCondition,
  type HasResolutionConfig,
} from './has-resolution.condition';
import type { IEvaluationContext } from '../handler.types';

describe('HasResolutionCondition', () => {
  const handler = new HasResolutionCondition();
  const resolutionId = '123e4567-e89b-12d3-a456-426614174000';
  const otherResolutionId = '223e4567-e89b-42d3-a456-426614174000';

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
    it('accepts a valid config with resolution_id', () => {
      const r = handler.schema.safeParse({
        type: 'has_resolution',
        resolution_id: resolutionId,
      });

      expect(r.success).toBe(true);
    });

    it('accepts a valid config without resolution_id', () => {
      const r = handler.schema.safeParse({ type: 'has_resolution' });

      expect(r.success).toBe(true);
    });

    it('rejects non-uuid resolution_id', () => {
      const r = handler.schema.safeParse({
        type: 'has_resolution',
        resolution_id: 'not-a-uuid',
      });

      expect(r.success).toBe(false);
    });
  });

  describe('evaluate — specific resolution', () => {
    const cfg: HasResolutionConfig = {
      type: 'has_resolution',
      resolution_id: resolutionId,
    };

    it('true when task has matching resolution', async () => {
      expect(
        await handler.evaluate(
          cfg,
          ctx({ task: { resolution_id: resolutionId } }),
        ),
      ).toBe(true);
    });

    it('false when task has different resolution', async () => {
      expect(
        await handler.evaluate(
          cfg,
          ctx({ task: { resolution_id: otherResolutionId } }),
        ),
      ).toBe(false);
    });

    it('false when task has no resolution', async () => {
      expect(
        await handler.evaluate(cfg, ctx({ task: { resolution_id: null } })),
      ).toBe(false);
    });
  });

  describe('evaluate — any resolution', () => {
    const cfg: HasResolutionConfig = { type: 'has_resolution' };

    it('true when task has any resolution', async () => {
      expect(
        await handler.evaluate(
          cfg,
          ctx({ task: { resolution_id: otherResolutionId } }),
        ),
      ).toBe(true);
    });

    it('false when task has no resolution (null)', async () => {
      expect(
        await handler.evaluate(cfg, ctx({ task: { resolution_id: null } })),
      ).toBe(false);
    });

    it('false when task has no resolution_id field', async () => {
      expect(await handler.evaluate(cfg, ctx({ task: {} }))).toBe(false);
    });

    it('false when task is null', async () => {
      expect(await handler.evaluate(cfg, ctx({ task: null }))).toBe(false);
    });
  });

  describe('findReferences', () => {
    it('returns the resolution id when set', () => {
      expect(
        handler.findReferences({
          type: 'has_resolution',
          resolution_id: resolutionId,
        }),
      ).toEqual([{ kind: 'resolution', id: resolutionId }]);
    });

    it('returns an empty list when resolution_id is omitted', () => {
      expect(handler.findReferences({ type: 'has_resolution' })).toEqual([]);
    });
  });
});
