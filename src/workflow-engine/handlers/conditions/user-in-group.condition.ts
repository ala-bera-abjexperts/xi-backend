/**
 * @fileoverview Condition: the current user belongs to a given group.
 * @module src/workflow-engine/handlers/conditions/user-in-group.condition
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
  type: z.literal('user_in_group'),
  group_id: z.string().uuid(),
});

export type UserInGroupConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class UserInGroupCondition implements IConditionHandler<UserInGroupConfig> {
  readonly type = 'user_in_group';
  readonly phase = 'condition' as const;
  readonly schema = cfgSchema;

  evaluate(cfg: UserInGroupConfig, ctx: IEvaluationContext): Promise<boolean> {
    return Promise.resolve(ctx.userGroups.includes(cfg.group_id));
  }

  findReferences(cfg: UserInGroupConfig): IRuleReference[] {
    return [{ kind: 'group', id: cfg.group_id }];
  }
}
