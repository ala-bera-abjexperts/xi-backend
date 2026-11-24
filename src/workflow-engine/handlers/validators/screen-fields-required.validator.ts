/**
 * @fileoverview Validator: requires every field in the transition's screen-field
 * group to be present in the transition payload.
 *
 * The evaluator must populate `ctx.transition` with:
 *   - `payload: Record<string, unknown>` — the user-supplied form values keyed
 *     by field_id
 *   - `required_field_ids: string[]` — the list of field_ids in the transition's
 *     screen-field group that the runtime requires
 *
 * The validator returns invalid with `fieldPath` set to the first missing
 * field_id; an empty `required_field_ids` list passes immediately.
 * @module src/workflow-engine/handlers/validators/screen-fields-required.validator
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
  type: z.literal('screen_fields_required'),
  screen_field_group_id: z.string().uuid(),
  message: z.string().max(200).optional(),
});

export type ScreenFieldsRequiredConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class ScreenFieldsRequiredValidator implements IValidatorHandler<ScreenFieldsRequiredConfig> {
  readonly type = 'screen_fields_required';
  readonly phase = 'validator' as const;
  readonly schema = cfgSchema;

  validate(
    cfg: ScreenFieldsRequiredConfig,
    ctx: IEvaluationContext,
  ): Promise<IValidatorResult> {
    if (!ctx.transition) {
      return Promise.resolve({
        ok: false,
        message: cfg.message ?? 'Transition payload is required',
        fieldPath: 'transition',
      });
    }

    const required =
      (ctx.transition as { required_field_ids?: string[] })
        .required_field_ids ?? [];
    const payload =
      (ctx.transition as { payload?: Record<string, unknown> }).payload ?? {};

    if (required.length === 0) {
      return Promise.resolve({ ok: true });
    }

    for (const fid of required) {
      const v = payload[fid];
      const missing =
        v === undefined ||
        v === null ||
        v === '' ||
        (Array.isArray(v) && v.length === 0);

      if (missing) {
        return Promise.resolve({
          ok: false,
          message: cfg.message ?? 'Required transition field is missing',
          fieldPath: fid,
        });
      }
    }

    return Promise.resolve({ ok: true });
  }

  findReferences(cfg: ScreenFieldsRequiredConfig): IRuleReference[] {
    return [{ kind: 'field_group', id: cfg.screen_field_group_id }];
  }
}
