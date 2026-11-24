/**
 * @fileoverview Condition: the current user is the reporter (creator) of the task.
 * @module src/workflow-engine/handlers/conditions/is-reporter.condition
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
  type: z.literal('is_reporter'),
});

export type IsReporterConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class IsReporterCondition implements IConditionHandler<IsReporterConfig> {
  readonly type = 'is_reporter';
  readonly phase = 'condition' as const;
  readonly schema = cfgSchema;

  evaluate(cfg: IsReporterConfig, ctx: IEvaluationContext): Promise<boolean> {
    void cfg;
    if (ctx.userId === null || ctx.task === null) return Promise.resolve(false);
    const reporter = ctx.task.created_by;

    return Promise.resolve(reporter === ctx.userId);
  }

  findReferences(cfg: IsReporterConfig): IRuleReference[] {
    void cfg;

    return [];
  }
}
