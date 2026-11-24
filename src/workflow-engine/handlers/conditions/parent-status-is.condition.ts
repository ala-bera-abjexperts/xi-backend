/**
 * @fileoverview Condition: the task's parent has a given status (or status category).
 * Exactly one of parent_status_id / parent_category_id must be supplied.
 * @module src/workflow-engine/handlers/conditions/parent-status-is.condition
 * @author Rajbha Manek
 */

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type {
  IConditionHandler,
  IEvaluationContext,
  IRuleReference,
} from '../handler.types';

const cfgSchema = z
  .object({
    type: z.literal('parent_status_is'),
    parent_status_id: z.string().uuid().optional(),
    parent_category_id: z.string().uuid().optional(),
  })
  .refine(
    (v) =>
      (v.parent_status_id !== undefined ? 1 : 0) +
        (v.parent_category_id !== undefined ? 1 : 0) ===
      1,
    {
      message:
        'Exactly one of parent_status_id or parent_category_id must be set',
    },
  );

export type ParentStatusIsConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class ParentStatusIsCondition implements IConditionHandler<ParentStatusIsConfig> {
  readonly type = 'parent_status_is';
  readonly phase = 'condition' as const;
  readonly schema = cfgSchema;

  evaluate(
    cfg: ParentStatusIsConfig,
    ctx: IEvaluationContext,
  ): Promise<boolean> {
    if (ctx.task === null) return Promise.resolve(false);
    const task = ctx.task;

    if (cfg.parent_status_id !== undefined) {
      // Key-tolerant: the parent may carry an org-wide status id while the rule
      // stored the space-scoped duplicate (or vice versa). `parent_status_ids`
      // holds every status id sharing the parent's status key, so a match on
      // either the exact id or that set means the parent is in that status.
      const equivalentIds = Array.isArray(task.parent_status_ids)
        ? (task.parent_status_ids as string[])
        : [];

      return Promise.resolve(
        task.parent_status_id === cfg.parent_status_id ||
          equivalentIds.includes(cfg.parent_status_id),
      );
    }

    return Promise.resolve(
      task.parent_status_category_id === cfg.parent_category_id,
    );
  }

  findReferences(cfg: ParentStatusIsConfig): IRuleReference[] {
    if (cfg.parent_status_id !== undefined) {
      return [{ kind: 'status', id: cfg.parent_status_id }];
    }
    if (cfg.parent_category_id !== undefined) {
      return [{ kind: 'category', id: cfg.parent_category_id }];
    }

    return [];
  }
}
