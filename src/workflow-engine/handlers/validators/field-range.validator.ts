/**
 * @fileoverview Validator: requires numeric field <field_id> within [min, max].
 * At least one of min or max must be provided.
 * @module src/workflow-engine/handlers/validators/field-range.validator
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

const cfgSchema = z
  .object({
    type: z.literal('field_range'),
    field_id: z.string().uuid(),
    min: z.number().optional(),
    max: z.number().optional(),
    message: z.string().max(200).optional(),
  })
  .refine((d) => d.min !== undefined || d.max !== undefined, {
    message: 'At least one of min or max must be provided',
  });

export type FieldRangeConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class FieldRangeValidator implements IValidatorHandler<FieldRangeConfig> {
  readonly type = 'field_range';
  readonly phase = 'validator' as const;
  readonly schema = cfgSchema;

  validate(
    cfg: FieldRangeConfig,
    ctx: IEvaluationContext,
  ): Promise<IValidatorResult> {
    const raw = (ctx.customFieldValuesById ?? ctx.customFieldValues)[
      cfg.field_id
    ];

    if (raw === undefined || raw === null || raw === '') {
      return Promise.resolve({
        ok: false,
        message: cfg.message ?? 'Value is required and must be a number',
        fieldPath: cfg.field_id,
      });
    }

    const num = Number(raw);

    if (Number.isNaN(num)) {
      return Promise.resolve({
        ok: false,
        message: cfg.message ?? 'Value must be a number',
        fieldPath: cfg.field_id,
      });
    }
    if (cfg.min !== undefined && num < cfg.min) {
      return Promise.resolve({
        ok: false,
        message: cfg.message ?? `Value must be >= ${cfg.min}`,
        fieldPath: cfg.field_id,
      });
    }
    if (cfg.max !== undefined && num > cfg.max) {
      return Promise.resolve({
        ok: false,
        message: cfg.message ?? `Value must be <= ${cfg.max}`,
        fieldPath: cfg.field_id,
      });
    }

    return Promise.resolve({ ok: true });
  }

  findReferences(cfg: FieldRangeConfig): IRuleReference[] {
    return [{ kind: 'field', id: cfg.field_id }];
  }
}
