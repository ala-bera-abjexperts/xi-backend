/**
 * @fileoverview Validator: requires all child tasks to be resolved.
 *
 * The evaluator must place `children_unresolved_count: number` on `ctx.task`
 * before calling this handler. Undefined or non-zero counts fail.
 * @module src/workflow-engine/handlers/validators/children-resolved.validator
 * @author Rajbha Manek
 */

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type {
  IValidatorHandler,
  IEvaluationContext,
  IValidatorResult,
  IRuleReference,
} from '../handler.types';

const cfgSchema = z.object({
  type: z.literal('children_resolved'),
  message: z.string().max(200).optional(),
});

export type ChildrenResolvedConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class ChildrenResolvedValidator implements IValidatorHandler<ChildrenResolvedConfig> {
  readonly type = 'children_resolved';
  readonly phase = 'validator' as const;
  readonly schema = cfgSchema;

  validate(
    cfg: ChildrenResolvedConfig,
    ctx: IEvaluationContext,
  ): Promise<IValidatorResult> {
    if (!ctx.task) {
      return Promise.resolve({
        ok: false,
        message: cfg.message ?? 'Task context missing',
        fieldPath: 'children',
      });
    }

    const count = (ctx.task as { children_unresolved_count?: number })
      .children_unresolved_count;

    if (count === undefined || count !== 0) {
      return Promise.resolve({
        ok: false,
        message:
          cfg.message ?? 'All child tasks must be resolved before continuing',
        fieldPath: 'children',
      });
    }

    return Promise.resolve({ ok: true });
  }

  findReferences(): IRuleReference[] {
    return [];
  }
}
