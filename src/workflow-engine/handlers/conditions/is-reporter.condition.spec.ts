/**
 * @fileoverview Unit tests for IsReporterCondition.
 * @module src/workflow-engine/handlers/conditions/is-reporter.condition.spec
 * @author Rajbha Manek
 */

import {
  IsReporterCondition,
  type IsReporterConfig,
} from './is-reporter.condition';
import type { IEvaluationContext } from '../handler.types';

describe('IsReporterCondition', () => {
  const handler = new IsReporterCondition();

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
      const r = handler.schema.safeParse({ type: 'is_reporter' });

      expect(r.success).toBe(true);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({ type: 'is_assignee' });

      expect(r.success).toBe(false);
    });

    it('rejects missing type', () => {
      const r = handler.schema.safeParse({});

      expect(r.success).toBe(false);
    });
  });

  describe('evaluate', () => {
    const cfg: IsReporterConfig = { type: 'is_reporter' };

    it('true when user created the task', async () => {
      expect(
        await handler.evaluate(
          cfg,
          ctx({ userId: 'user-1', task: { created_by: 'user-1' } }),
        ),
      ).toBe(true);
    });

    it('false when user did not create the task', async () => {
      expect(
        await handler.evaluate(
          cfg,
          ctx({ userId: 'user-1', task: { created_by: 'user-2' } }),
        ),
      ).toBe(false);
    });

    it('false when userId is null', async () => {
      expect(
        await handler.evaluate(
          cfg,
          ctx({ userId: null, task: { created_by: 'user-1' } }),
        ),
      ).toBe(false);
    });

    it('false when task is null', async () => {
      expect(
        await handler.evaluate(cfg, ctx({ userId: 'user-1', task: null })),
      ).toBe(false);
    });
  });

  describe('findReferences', () => {
    it('returns an empty list', () => {
      expect(handler.findReferences({ type: 'is_reporter' })).toEqual([]);
    });
  });
});
