/**
 * @fileoverview Condition: the current user belongs to a given role.
 * @module src/workflow-engine/handlers/conditions/user-in-role.condition
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
  type: z.literal('user_in_role'),
  role_id: z.string().uuid(),
});

export type UserInRoleConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class UserInRoleCondition implements IConditionHandler<UserInRoleConfig> {
  readonly type = 'user_in_role';
  readonly phase = 'condition' as const;
  readonly schema = cfgSchema;

  evaluate(cfg: UserInRoleConfig, ctx: IEvaluationContext): Promise<boolean> {
    return Promise.resolve(ctx.userRoles.includes(cfg.role_id));
  }

  findReferences(cfg: UserInRoleConfig): IRuleReference[] {
    return [{ kind: 'role', id: cfg.role_id }];
  }
}
