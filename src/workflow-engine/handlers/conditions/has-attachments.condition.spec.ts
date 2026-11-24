/**
 * @fileoverview Unit tests for HasAttachmentsCondition.
 * @module src/workflow-engine/handlers/conditions/has-attachments.condition.spec
 * @author Rajbha Manek
 */

import {
  HasAttachmentsCondition,
  type HasAttachmentsConfig,
} from './has-attachments.condition';
import type { IEvaluationContext } from '../handler.types';

describe('HasAttachmentsCondition', () => {
  const handler = new HasAttachmentsCondition();

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
        type: 'has_attachments',
        min: 3,
      });

      expect(r.success).toBe(true);
    });

    it('applies default min=1 when omitted', () => {
      const r = handler.schema.safeParse({ type: 'has_attachments' });

      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.min).toBe(1);
      }
    });

    it('rejects negative min', () => {
      const r = handler.schema.safeParse({
        type: 'has_attachments',
        min: -1,
      });

      expect(r.success).toBe(false);
    });

    it('rejects non-integer min', () => {
      const r = handler.schema.safeParse({
        type: 'has_attachments',
        min: 1.5,
      });

      expect(r.success).toBe(false);
    });
  });

  describe('evaluate', () => {
    it('true when attachment_count >= min', async () => {
      const cfg: HasAttachmentsConfig = { type: 'has_attachments', min: 2 };

      expect(
        await handler.evaluate(cfg, ctx({ task: { attachment_count: 3 } })),
      ).toBe(true);
    });

    it('true when attachment_count equals min', async () => {
      const cfg: HasAttachmentsConfig = { type: 'has_attachments', min: 2 };

      expect(
        await handler.evaluate(cfg, ctx({ task: { attachment_count: 2 } })),
      ).toBe(true);
    });

    it('false when attachment_count below min', async () => {
      const cfg: HasAttachmentsConfig = { type: 'has_attachments', min: 2 };

      expect(
        await handler.evaluate(cfg, ctx({ task: { attachment_count: 1 } })),
      ).toBe(false);
    });

    it('false when attachment_count is missing (treated as 0) and min > 0', async () => {
      const cfg: HasAttachmentsConfig = { type: 'has_attachments', min: 1 };

      expect(await handler.evaluate(cfg, ctx({ task: {} }))).toBe(false);
    });

    it('true when min=0 even if attachment_count is missing', async () => {
      const cfg: HasAttachmentsConfig = { type: 'has_attachments', min: 0 };

      expect(await handler.evaluate(cfg, ctx({ task: {} }))).toBe(true);
    });
  });

  describe('findReferences', () => {
    it('returns an empty list', () => {
      expect(
        handler.findReferences({ type: 'has_attachments', min: 1 }),
      ).toEqual([]);
    });
  });
});
