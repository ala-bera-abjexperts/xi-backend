/**
 * @fileoverview Validator: requires the current user to hold a specific permission key.
 *
 * The evaluator must place the user's effective permission map on
 * `ctx.user.permissions` as `Record<string, boolean>` before calling this
 * handler. (`IEvaluationContext.user` is typed `Record<string, unknown> | null`;
 * we narrow to `permissions` here.)
 * @module src/workflow-engine/handlers/validators/permission-required.validator
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
  type: z.literal('permission_required'),
  permission_key: z.string().min(1).max(80),
  message: z.string().max(200).optional(),
});

export type PermissionRequiredConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class PermissionRequiredValidator implements IValidatorHandler<PermissionRequiredConfig> {
  readonly type = 'permission_required';
  readonly phase = 'validator' as const;
  readonly schema = cfgSchema;

  validate(
    cfg: PermissionRequiredConfig,
    ctx: IEvaluationContext,
  ): Promise<IValidatorResult> {
    if (!ctx.user) {
      return Promise.resolve({
        ok: false,
        message:
          cfg.message ?? `Missing required permission: ${cfg.permission_key}`,
        fieldPath: 'user',
      });
    }

    const perms = (ctx.user as { permissions?: Record<string, boolean> })
      .permissions;
    const has = perms?.[cfg.permission_key] === true;

    if (!has) {
      return Promise.resolve({
        ok: false,
        message:
          cfg.message ?? `Missing required permission: ${cfg.permission_key}`,
        fieldPath: 'user',
      });
    }

    return Promise.resolve({ ok: true });
  }

  findReferences(cfg: PermissionRequiredConfig): IRuleReference[] {
    return [{ kind: 'permission', id: cfg.permission_key }];
  }
}
