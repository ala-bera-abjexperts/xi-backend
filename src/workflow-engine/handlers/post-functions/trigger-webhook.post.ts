/**
 * @fileoverview Post-function: fires an outbound HTTPS webhook with optional
 * headers and a body template. Captures the runtime token context at enqueue
 * time and stores it alongside the raw `body_template`; the cron dispatcher
 * renders the body AND resolves the HMAC secret at drain time so that secret
 * rotations between enqueue and dispatch take effect (design Part 5.3 + Part
 * 10.3 secret-rotation note).
 *
 * Only HTTPS URLs are accepted — plain HTTP is rejected at config-validation
 * time to prevent accidental exfiltration over unencrypted channels.
 * @module src/workflow-engine/handlers/post-functions/trigger-webhook.post
 * @author Rajbha Manek
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { isIP } from 'net';
import { z } from 'zod';

import {
  assertPublicHttpUrl,
  isBlockedAddress,
} from '../../../common/security/ssrf-guard';
import { WorkflowOutboxService } from '../../../workflow-outbox/workflow-outbox.service';
import { TemplatingService } from '../../templating/expand';
import { buildTokenContext } from './add-comment.post';
import type {
  IPostFunctionHandler,
  IEvaluationContext,
  IRuleReference,
} from '../handler.types';

const cfgSchema = z.object({
  type: z.literal('trigger_webhook'),
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), {
      message: 'Only HTTPS webhook URLs are allowed',
    })
    .refine(
      (u) => {
        // Synchronous save-time guard for literal-IP hosts (DNS-based
        // hostname checks happen at dispatch via assertPublicHttpUrl).
        try {
          const host = new URL(u).hostname.replace(/^\[|\]$/g, '');

          return !(isIP(host) && isBlockedAddress(host));
        } catch {
          return false;
        }
      },
      { message: 'Webhook URL must not target a private/internal address' },
    ),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH']).default('POST'),
  headers: z.record(z.string(), z.string()).optional(),
  body_template: z.string().max(10000).optional(),
  /** Inline HMAC secret — used when no secret_ref is provided. */
  secret: z.string().min(1).max(200).optional(),
  /** Per-org secret store key (resolved by the dispatcher in a future milestone). */
  secret_ref: z.string().min(1).max(200).optional(),
});

export type TriggerWebhookConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class TriggerWebhookPostFunction implements IPostFunctionHandler<TriggerWebhookConfig> {
  readonly type = 'trigger_webhook';
  readonly phase = 'post_function' as const;
  readonly schema = cfgSchema;

  private readonly logger = new Logger(TriggerWebhookPostFunction.name);

  constructor(
    private readonly outbox: WorkflowOutboxService,
    private readonly templating: TemplatingService,
  ) {}

  async run(cfg: TriggerWebhookConfig, ctx: IEvaluationContext): Promise<void> {
    if (!ctx.taskId) {
      throw new BadRequestException('trigger_webhook requires ctx.taskId');
    }

    // SSRF guard at enqueue time — resolves the host and rejects internal
    // targets before the row is durably queued.
    await assertPublicHttpUrl(cfg.url);

    // ENG-M4: an inline secret is persisted on the outbox row in v1. Warn so
    // operators prefer a secret_ref (vault-backed) once that store ships.
    if (cfg.secret) {
      this.logger.warn(
        'trigger_webhook configured with an inline secret; it will be stored on the outbox row. Prefer secret_ref once a secret store is available.',
      );
    }

    // Capture the token context now; the dispatcher renders body_template
    // against it at drain time so that any HMAC secret rotation between
    // enqueue and dispatch is honored. Outbox row shape mirrors
    // `FireWebhookPayload` in fire-webhook.dispatcher.ts.
    const tokens = buildTokenContext(ctx);

    await this.outbox.enqueue({
      organizationId: ctx.organizationId,
      taskId: ctx.taskId,
      transitionId: ctx.transitionId,
      ruleType: 'trigger_webhook',
      payload: {
        cfg: {
          url: cfg.url,
          method: cfg.method,
          headers: cfg.headers ?? {},
          body_template: cfg.body_template,
          secret: cfg.secret,
          secret_ref: cfg.secret_ref,
        },
        context: tokens,
      },
    });
  }

  findReferences(cfg: TriggerWebhookConfig): IRuleReference[] {
    void cfg;

    return [];
  }
}
