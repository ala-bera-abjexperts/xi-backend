/**
 * @fileoverview Condition: the task has at least N attachments.
 * @module src/workflow-engine/handlers/conditions/has-attachments.condition
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
  type: z.literal('has_attachments'),
  min: z.number().int().min(0).default(1),
});

export type HasAttachmentsConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class HasAttachmentsCondition implements IConditionHandler<HasAttachmentsConfig> {
  readonly type = 'has_attachments';
  readonly phase = 'condition' as const;
  readonly schema = cfgSchema;

  evaluate(
    cfg: HasAttachmentsConfig,
    ctx: IEvaluationContext,
  ): Promise<boolean> {
    if (ctx.task === null) return Promise.resolve(cfg.min === 0);
    const raw = ctx.task.attachment_count;
    const count = typeof raw === 'number' ? raw : 0;

    return Promise.resolve(count >= cfg.min);
  }

  findReferences(cfg: HasAttachmentsConfig): IRuleReference[] {
    void cfg;

    return [];
  }
}
