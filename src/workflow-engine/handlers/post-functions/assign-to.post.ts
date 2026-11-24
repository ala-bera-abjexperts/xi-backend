import { writeWorkflowTask } from '../write-task';
/**
 * @fileoverview Post-function: assigns the task to a user, role, group, or
 * clears the assignee. v1 implements `user` and `unassign` modes against the
 * `tasks.assigned_to` column via `ctx.txn`. `role` and `group` modes are not
 * supported in v1 (they would require resolving membership policy and picking a
 * deterministic individual) — they log a warning and no-op.
 * @module src/workflow-engine/handlers/post-functions/assign-to.post
 * @author Rajbha Manek
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import type {
  IPostFunctionHandler,
  IEvaluationContext,
  IRuleReference,
} from '../handler.types';

const cfgSchema = z.discriminatedUnion('mode', [
  z.object({
    type: z.literal('assign_to'),
    mode: z.literal('user'),
    user_id: z.string().uuid(),
  }),
  z.object({
    type: z.literal('assign_to'),
    mode: z.literal('role'),
    role_id: z.string().uuid(),
  }),
  z.object({
    type: z.literal('assign_to'),
    mode: z.literal('group'),
    group_id: z.string().uuid(),
  }),
  z.object({
    type: z.literal('assign_to'),
    mode: z.literal('unassign'),
  }),
]);

export type AssignToConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class AssignToPostFunction implements IPostFunctionHandler<AssignToConfig> {
  readonly type = 'assign_to';
  readonly phase = 'post_function' as const;
  readonly schema = cfgSchema;

  private readonly logger = new Logger(AssignToPostFunction.name);

  async run(cfg: AssignToConfig, ctx: IEvaluationContext): Promise<void> {
    if (!ctx.txn) {
      throw new BadRequestException('assign_to requires ctx.txn');
    }
    if (!ctx.taskId) {
      throw new BadRequestException('assign_to requires ctx.taskId');
    }

    // role / group modes are deferred to a later milestone — they require
    // policy lookup (who's the active assignee for this role on this space?)
    // that the v1 engine does not yet expose. Log + no-op so the rule does
    // not break the transition.
    if (cfg.mode === 'role' || cfg.mode === 'group') {
      this.logger.warn(
        `assign_to mode=${cfg.mode} not supported in v1; leaving assignee unchanged on task ${ctx.taskId}`,
      );

      return;
    }

    const newAssignee = cfg.mode === 'user' ? cfg.user_id : null;

    await writeWorkflowTask(ctx, { assigned_to: newAssignee });
  }

  findReferences(cfg: AssignToConfig): IRuleReference[] {
    switch (cfg.mode) {
      case 'user':
        return [{ kind: 'user', id: cfg.user_id }];
      case 'role':
        return [{ kind: 'role', id: cfg.role_id }];
      case 'group':
        return [{ kind: 'group', id: cfg.group_id }];
      case 'unassign':
        return [];
    }
  }
}
