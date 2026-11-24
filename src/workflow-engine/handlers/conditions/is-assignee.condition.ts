/**
 * @fileoverview Condition: the current user is the assignee of the task.
 * @module src/workflow-engine/handlers/conditions/is-assignee.condition
 * @author Rajbha Manek
 */

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type {
  IConditionHandler,
  IEvaluationContext,
  IRuleReference,
} from '../handler.types';

const cfgSchema = z.object({
  type: z.literal('is_assignee'),
});

export type IsAssigneeConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class IsAssigneeCondition implements IConditionHandler<IsAssigneeConfig> {
  readonly type = 'is_assignee';
  readonly phase = 'condition' as const;
  readonly schema = cfgSchema;

  evaluate(cfg: IsAssigneeConfig, ctx: IEvaluationContext): Promise<boolean> {
    void cfg;
    if (ctx.userId === null || ctx.task === null) return Promise.resolve(false);
    const assigned = ctx.task.assigned_to;

    return Promise.resolve(assigned === ctx.userId);
  }

  findReferences(cfg: IsAssigneeConfig): IRuleReference[] {
    void cfg;

    return [];
  }
}
