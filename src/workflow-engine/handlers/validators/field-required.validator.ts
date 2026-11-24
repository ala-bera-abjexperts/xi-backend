/**
 * @fileoverview Validator: requires custom field <field_id> to be non-empty.
 * @module src/workflow-engine/handlers/validators/field-required.validator
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
  type: z.literal('field_required'),
  field_id: z.string().uuid(),
  message: z.string().max(200).optional(),
});

export type FieldRequiredConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class FieldRequiredValidator implements IValidatorHandler<FieldRequiredConfig> {
  readonly type = 'field_required';
  readonly phase = 'validator' as const;
  readonly schema = cfgSchema;

  validate(
    cfg: FieldRequiredConfig,
    ctx: IEvaluationContext,
  ): Promise<IValidatorResult> {
    const value = (ctx.customFieldValuesById ?? ctx.customFieldValues)[
      cfg.field_id
    ];
    const isEmpty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);

    if (isEmpty) {
      return Promise.resolve({
        ok: false,
        message: cfg.message ?? 'This field is required',
        fieldPath: cfg.field_id,
      });
    }

    return Promise.resolve({ ok: true });
  }

  findReferences(cfg: FieldRequiredConfig): IRuleReference[] {
    return [{ kind: 'field', id: cfg.field_id }];
  }
}
