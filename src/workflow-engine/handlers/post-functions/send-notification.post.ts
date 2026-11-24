/**
 * @fileoverview Post-function: queues a notification to one or more recipients
 * (assignee, reporter, watchers, specific user/group, or role). Renders the
 * subject + body templates synchronously and enqueues a workflow_outbox row
 * for the cron dispatcher to fan out via in-app + email channels. The dispatcher
 * resolves the recipient identities at drain time so dynamic membership stays
 * fresh between enqueue and delivery.
 * @module src/workflow-engine/handlers/post-functions/send-notification.post
 * @author Rajbha Manek
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { WorkflowOutboxService } from '../../../workflow-outbox/workflow-outbox.service';
import { TemplatingService } from '../../templating/expand';
import { buildTokenContext } from './add-comment.post';
import type {
  IPostFunctionHandler,
  IEvaluationContext,
  IRuleReference,
} from '../handler.types';

const recipientSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assignee') }),
  z.object({ kind: z.literal('reporter') }),
  z.object({ kind: z.literal('watchers') }),
  z.object({ kind: z.literal('specific_user'), user_id: z.string().uuid() }),
  z.object({ kind: z.literal('specific_group'), group_id: z.string().uuid() }),
  z.object({ kind: z.literal('role'), role_id: z.string().uuid() }),
]);

const cfgSchema = z.object({
  type: z.literal('send_notification'),
  recipients: z.array(recipientSchema).min(1).max(20),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
  attach_task_as_pdf: z.boolean().default(false),
});

export type SendNotificationConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class SendNotificationPostFunction implements IPostFunctionHandler<SendNotificationConfig> {
  readonly type = 'send_notification';
  readonly phase = 'post_function' as const;
  readonly schema = cfgSchema;

  constructor(
    private readonly outbox: WorkflowOutboxService,
    private readonly templating: TemplatingService,
  ) {}

  async run(
    cfg: SendNotificationConfig,
    ctx: IEvaluationContext,
  ): Promise<void> {
    if (!ctx.taskId) {
      throw new BadRequestException('send_notification requires ctx.taskId');
    }

    const tokens = buildTokenContext(ctx);
    const renderedSubject = this.templating.expand(cfg.subject, tokens);
    const renderedBody = this.templating.expand(cfg.body, tokens);

    // Outbox row shape mirrors SendNotificationPayload in the dispatcher:
    // `cfg` carries the rendered strings + recipient kinds the drainer needs;
    // `context` is the token-context snapshot so future per-recipient
    // personalisation (e.g. {{recipient.first_name}}) can re-expand later.
    await this.outbox.enqueue({
      organizationId: ctx.organizationId,
      taskId: ctx.taskId,
      transitionId: ctx.transitionId,
      ruleType: 'send_notification',
      payload: {
        cfg: {
          recipients: cfg.recipients,
          subject: renderedSubject,
          body: renderedBody,
          attach_task_as_pdf: cfg.attach_task_as_pdf,
        },
        context: tokens,
      },
    });
  }

  findReferences(cfg: SendNotificationConfig): IRuleReference[] {
    const refs: IRuleReference[] = [];

    for (const r of cfg.recipients) {
      switch (r.kind) {
        case 'specific_user':
          refs.push({ kind: 'user', id: r.user_id });
          break;
        case 'specific_group':
          refs.push({ kind: 'group', id: r.group_id });
          break;
        case 'role':
          refs.push({ kind: 'role', id: r.role_id });
          break;
        // assignee / reporter / watchers carry no static reference
      }
    }

    return refs;
  }
}
