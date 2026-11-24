/**
 * @fileoverview Post-function: adds a comment to the task. The template is
 * expanded against a per-transition token bundle (task, transition, workflow,
 * user, …) and the rendered body is inserted into `task_comments`. When
 * `as_system=true` the row is written with `created_by=null` to denote a
 * non-user actor — the existing `task_comments` schema has no dedicated
 * boolean for this, so the convention is `created_by IS NULL ⇒ system`.
 * @module src/workflow-engine/handlers/post-functions/add-comment.post
 * @author Rajbha Manek
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { TemplatingService } from '../../templating/expand';
import type {
  IPostFunctionHandler,
  IEvaluationContext,
  IRuleReference,
} from '../handler.types';

const cfgSchema = z.object({
  type: z.literal('add_comment'),
  template: z.string().min(1).max(4000),
  as_system: z.boolean().default(false),
});

export type AddCommentConfig = z.infer<typeof cfgSchema>;

/**
 * Build the token context handed to TemplatingService.expand from an
 * IEvaluationContext. Exported so other post-function handlers (notification,
 * webhook) can share the same shape.
 */
export function buildTokenContext(
  ctx: IEvaluationContext,
): Record<string, unknown> {
  return {
    task: ctx.task ?? {},
    transition: ctx.transition ?? {},
    workflow: ctx.workflow ?? {},
    user: ctx.user ?? {},
    from_status_id: ctx.from_status_id ?? null,
    to_status_id: ctx.to_status_id ?? null,
    custom_field_values: ctx.customFieldValues ?? {},
    screen_input: ctx.screen_input ?? {},
  };
}

@Injectable()
export class AddCommentPostFunction implements IPostFunctionHandler<AddCommentConfig> {
  readonly type = 'add_comment';
  readonly phase = 'post_function' as const;
  readonly schema = cfgSchema;

  constructor(private readonly templating: TemplatingService) {}

  async run(cfg: AddCommentConfig, ctx: IEvaluationContext): Promise<void> {
    if (!ctx.txn) {
      throw new BadRequestException('add_comment requires ctx.txn');
    }
    if (!ctx.taskId) {
      throw new BadRequestException('add_comment requires ctx.taskId');
    }

    const tokens = buildTokenContext(ctx);
    const rendered = this.templating.expand(cfg.template, tokens);

    const { error } = await ctx.txn.from('task_comments').insert({
      organization_id: ctx.organizationId,
      task_id: ctx.taskId,
      content: rendered,
      // as_system=true ⇒ created_by left null. Otherwise we record the actor
      // that triggered the transition (may be null if the engine was invoked
      // by a cron/inbound webhook with no user context).
      created_by: cfg.as_system ? null : (ctx.userId ?? null),
    });

    if (error) {
      throw new BadRequestException(`add_comment failed: ${error.message}`);
    }
  }

  findReferences(cfg: AddCommentConfig): IRuleReference[] {
    void cfg;

    return [];
  }
}
