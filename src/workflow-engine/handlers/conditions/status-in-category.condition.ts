/**
 * @fileoverview Condition: the task's current status belongs to a given category.
 * Reads `ctx.task.status_category_id` from the free-form task record.
 * @module src/workflow-engine/handlers/conditions/status-in-category.condition
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
  type: z.literal('status_in_category'),
  category_id: z.string().uuid(),
});

export type StatusInCategoryConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class StatusInCategoryCondition implements IConditionHandler<StatusInCategoryConfig> {
  readonly type = 'status_in_category';
  readonly phase = 'condition' as const;
  readonly schema = cfgSchema;

  evaluate(
    cfg: StatusInCategoryConfig,
    ctx: IEvaluationContext,
  ): Promise<boolean> {
    if (ctx.task === null) return Promise.resolve(false);
    const category = ctx.task.status_category_id;

    return Promise.resolve(category === cfg.category_id);
  }

  findReferences(cfg: StatusInCategoryConfig): IRuleReference[] {
    return [{ kind: 'category', id: cfg.category_id }];
  }
}
