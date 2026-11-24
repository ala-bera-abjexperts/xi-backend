/**
 * @fileoverview Unit tests for CronTrigger (stub).
 * @module src/workflow-engine/handlers/triggers/cron.trigger.spec
 * @author Rajbha Manek
 */

import { CronTrigger } from './cron.trigger';
import type { IEvaluationContext } from '../handler.types';

describe('CronTrigger', () => {
  const handler = new CronTrigger();

  const ctx = (
    overrides: Partial<IEvaluationContext> = {},
  ): IEvaluationContext => ({
    organizationId: 'org-1',
    spaceId: 'space-1',
    taskId: null,
    task: null,
    transitionId: 'tx-1',
    transition: null,
    userId: null,
    user: null,
    userRoles: [],
    userGroups: [],
    customFieldValues: {},
    ...overrides,
  });

  describe('schema', () => {
    it('accepts a valid config and defaults timezone to UTC', () => {
      const r = handler.schema.safeParse({
        type: 'cron',
        expression: '0 9 * * 1-5',
      });

      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.timezone).toBe('UTC');
      }
    });

    it('accepts a config with explicit timezone', () => {
      const r = handler.schema.safeParse({
        type: 'cron',
        expression: '*/15 * * * *',
        timezone: 'Europe/Berlin',
      });

      expect(r.success).toBe(true);
    });

    it('rejects expression shorter than 5 chars', () => {
      const r = handler.schema.safeParse({
        type: 'cron',
        expression: '* *',
      });

      expect(r.success).toBe(false);
    });

    it('rejects expression longer than 100 chars', () => {
      const r = handler.schema.safeParse({
        type: 'cron',
        expression: 'x'.repeat(101),
      });

      expect(r.success).toBe(false);
    });

    it('rejects empty timezone', () => {
      const r = handler.schema.safeParse({
        type: 'cron',
        expression: '0 9 * * 1-5',
        timezone: '',
      });

      expect(r.success).toBe(false);
    });

    it('rejects timezone longer than 80 chars', () => {
      const r = handler.schema.safeParse({
        type: 'cron',
        expression: '0 9 * * 1-5',
        timezone: 'x'.repeat(81),
      });

      expect(r.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({
        type: 'something_else',
        expression: '0 9 * * 1-5',
      });

      expect(r.success).toBe(false);
    });
  });

  describe('findReferences', () => {
    it('returns an empty array', () => {
      const refs = handler.findReferences({
        type: 'cron',
        expression: '0 9 * * 1-5',
        timezone: 'UTC',
      });

      expect(refs).toEqual([]);
    });
  });

  describe('subscribe (stub)', () => {
    it('subscribe() rejects with not-implemented error', async () => {
      await expect(
        handler.subscribe(
          { type: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' },
          ctx(),
        ),
      ).rejects.toThrow(/not implemented in v1/);
    });

    it('unsubscribe() rejects with not-implemented error', async () => {
      await expect(
        handler.unsubscribe(
          { type: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' },
          ctx(),
        ),
      ).rejects.toThrow(/not implemented in v1/);
    });
  });
});
