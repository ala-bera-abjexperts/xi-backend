/**
 * @fileoverview Condition: the task has a resolution (optionally a specific one).
 * @module src/workflow-engine/handlers/conditions/has-resolution.condition
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
  type: z.literal('has_resolution'),
  resolution_id: z.string().uuid().optional(),
});

export type HasResolutionConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class HasResolutionCondition implements IConditionHandler<HasResolutionConfig> {
  readonly type = 'has_resolution';
  readonly phase = 'condition' as const;
  readonly schema = cfgSchema;

  evaluate(
    cfg: HasResolutionConfig,
    ctx: IEvaluationContext,
  ): Promise<boolean> {
    if (ctx.task === null) return Promise.resolve(false);
    const current = ctx.task.resolution_id;

    if (cfg.resolution_id !== undefined) {
      return Promise.resolve(current === cfg.resolution_id);
    }

    return Promise.resolve(current !== undefined && current !== null);
  }

  findReferences(cfg: HasResolutionConfig): IRuleReference[] {
    if (cfg.resolution_id === undefined) return [];

    return [{ kind: 'resolution', id: cfg.resolution_id }];
  }
}
