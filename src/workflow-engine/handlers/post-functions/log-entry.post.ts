/**
 * @fileoverview Post-function: writes a short log entry into the server log.
 * v1 uses `console.log` (via NestJS Logger) — there is no dedicated
 * `workflow_log` table in the v1 schema and widening the audit_logs action
 * union just for this rule is too noisy. Operators can grep the server log
 * with the [workflow.log_entry] prefix; the engine's own audit_logs row for
 * the transition still captures the rule under `rules_evaluated`.
 * @module src/workflow-engine/handlers/post-functions/log-entry.post
 * @author Rajbha Manek
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { TemplatingService } from '../../templating/expand';
import { buildTokenContext } from './add-comment.post';
import type {
  IPostFunctionHandler,
  IEvaluationContext,
  IRuleReference,
} from '../handler.types';

const cfgSchema = z.object({
  type: z.literal('log_entry'),
  template: z.string().min(1).max(1000),
});

export type LogEntryConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class LogEntryPostFunction implements IPostFunctionHandler<LogEntryConfig> {
  readonly type = 'log_entry';
  readonly phase = 'post_function' as const;
  readonly schema = cfgSchema;

  private readonly logger = new Logger(LogEntryPostFunction.name);

  constructor(private readonly templating: TemplatingService) {}

  run(cfg: LogEntryConfig, ctx: IEvaluationContext): Promise<void> {
    if (!ctx.taskId) {
      return Promise.reject(
        new BadRequestException('log_entry requires ctx.taskId'),
      );
    }

    const tokens = buildTokenContext(ctx);
    const rendered = this.templating.expand(cfg.template, tokens);

    // Tagged so operators can filter on `[workflow.log_entry]` without picking
    // up other transition-level log lines.
    this.logger.log(
      `[workflow.log_entry] org=${ctx.organizationId} task=${ctx.taskId} transition=${ctx.transitionId} msg="${rendered}"`,
    );

    return Promise.resolve();
  }

  findReferences(cfg: LogEntryConfig): IRuleReference[] {
    void cfg;

    return [];
  }
}
