/**
 * @fileoverview Trigger: fires when an inbound HTTP webhook hits the configured
 * slug. Subscribe/unsubscribe runtime is implemented in Prompt 6 — in v1 only
 * the schema and references are exercised.
 * @module src/workflow-engine/handlers/triggers/inbound-webhook.trigger
 * @author Rajbha Manek
 */

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type {
  IEvaluationContext,
  IRuleReference,
  ITriggerHandler,
} from '../handler.types';

const cfgSchema = z.object({
  type: z.literal('inbound_webhook'),
  slug: z
    .string()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'lowercase letters, digits, and hyphens only'),
  secret: z.string().min(8).max(128).optional(),
  expected_event_type: z.string().max(100).optional(),
});

export type InboundWebhookConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class InboundWebhookTrigger implements ITriggerHandler<InboundWebhookConfig> {
  readonly type = 'inbound_webhook';
  readonly phase = 'trigger' as const;
  readonly schema = cfgSchema;

  subscribe(cfg: InboundWebhookConfig, ctx: IEvaluationContext): Promise<void> {
    void cfg;
    void ctx;
    return Promise.reject(
      new Error('inbound_webhook subscribe runtime not implemented in v1'),
    );
  }

  unsubscribe(
    cfg: InboundWebhookConfig,
    ctx: IEvaluationContext,
  ): Promise<void> {
    void cfg;
    void ctx;
    return Promise.reject(
      new Error('inbound_webhook subscribe runtime not implemented in v1'),
    );
  }

  findReferences(cfg: InboundWebhookConfig): IRuleReference[] {
    void cfg;

    return [];
  }
}
