/**
 * @fileoverview Unit tests for InboundWebhookTrigger.
 * @module src/workflow-engine/handlers/triggers/inbound-webhook.trigger.spec
 * @author Rajbha Manek
 */

import { InboundWebhookTrigger } from './inbound-webhook.trigger';
import type { IEvaluationContext } from '../handler.types';

describe('InboundWebhookTrigger', () => {
  const handler = new InboundWebhookTrigger();

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
    it('accepts a minimal valid config', () => {
      const r = handler.schema.safeParse({
        type: 'inbound_webhook',
        slug: 'deploy-prod',
      });

      expect(r.success).toBe(true);
    });

    it('accepts a config with secret and expected_event_type', () => {
      const r = handler.schema.safeParse({
        type: 'inbound_webhook',
        slug: 'deploy-prod',
        secret: 'shhhhhhhh',
        expected_event_type: 'push',
      });

      expect(r.success).toBe(true);
    });

    it('rejects slug shorter than 3 chars', () => {
      const r = handler.schema.safeParse({
        type: 'inbound_webhook',
        slug: 'ab',
      });

      expect(r.success).toBe(false);
    });

    it('rejects slug longer than 80 chars', () => {
      const r = handler.schema.safeParse({
        type: 'inbound_webhook',
        slug: 'a'.repeat(81),
      });

      expect(r.success).toBe(false);
    });

    it('rejects slug with uppercase letters', () => {
      const r = handler.schema.safeParse({
        type: 'inbound_webhook',
        slug: 'Deploy-Prod',
      });

      expect(r.success).toBe(false);
    });

    it('rejects slug with underscores or spaces', () => {
      const r = handler.schema.safeParse({
        type: 'inbound_webhook',
        slug: 'deploy_prod',
      });

      expect(r.success).toBe(false);
    });

    it('rejects secret shorter than 8 chars', () => {
      const r = handler.schema.safeParse({
        type: 'inbound_webhook',
        slug: 'deploy-prod',
        secret: 'short',
      });

      expect(r.success).toBe(false);
    });

    it('rejects expected_event_type longer than 100 chars', () => {
      const r = handler.schema.safeParse({
        type: 'inbound_webhook',
        slug: 'deploy-prod',
        expected_event_type: 'x'.repeat(101),
      });

      expect(r.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({
        type: 'something_else',
        slug: 'deploy-prod',
      });

      expect(r.success).toBe(false);
    });
  });

  describe('findReferences', () => {
    it('returns an empty array', () => {
      const refs = handler.findReferences({
        type: 'inbound_webhook',
        slug: 'deploy-prod',
      });

      expect(refs).toEqual([]);
    });
  });

  describe('subscribe (stub)', () => {
    it('subscribe() rejects with not-implemented error', async () => {
      await expect(
        handler.subscribe(
          { type: 'inbound_webhook', slug: 'deploy-prod' },
          ctx(),
        ),
      ).rejects.toThrow(/not implemented in v1/);
    });

    it('unsubscribe() rejects with not-implemented error', async () => {
      await expect(
        handler.unsubscribe(
          { type: 'inbound_webhook', slug: 'deploy-prod' },
          ctx(),
        ),
      ).rejects.toThrow(/not implemented in v1/);
    });
  });
});
