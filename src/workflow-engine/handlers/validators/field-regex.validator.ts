/**
 * @fileoverview Validator: requires custom field <field_id> value to match a regex.
 * @module src/workflow-engine/handlers/validators/field-regex.validator
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

/** Max length of the value the regex is tested against (ReDoS blast-radius cap). */
const MAX_TESTED_INPUT_LENGTH = 5000;

/**
 * Heuristic detector for catastrophic-backtracking ("evil") regex shapes —
 * primarily nested/consecutive quantifiers like (a+)+, (a*)*, (a+)*, a**,
 * (a+){2,}. Not exhaustive, but blocks the common ReDoS footguns at save time.
 * Combined with the input-length cap this bounds worst-case CPU.
 */
const CATASTROPHIC_QUANTIFIER = /([*+]|\{\d+,\d*\})\)?\s*([*+]|\{\d+,\d*\})/;

export function isPotentiallyCatastrophicRegex(pattern: string): boolean {
  return CATASTROPHIC_QUANTIFIER.test(pattern);
}

const cfgSchema = z
  .object({
    type: z.literal('field_regex'),
    field_id: z.string().uuid(),
    pattern: z.string().max(500),
    flags: z.string().max(10).optional(),
    message: z.string().max(200).optional(),
  })
  .superRefine((cfg, refineCtx) => {
    // Reject patterns that don't compile, or that match the catastrophic
    // heuristic, at config-save time — before they can be persisted and run.
    try {
      new RegExp(cfg.pattern, cfg.flags);
    } catch {
      refineCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pattern'],
        message: 'Invalid regular expression',
      });

      return;
    }

    if (isPotentiallyCatastrophicRegex(cfg.pattern)) {
      refineCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pattern'],
        message:
          'Regex rejected: nested quantifiers can cause catastrophic backtracking (ReDoS)',
      });
    }
  });

export type FieldRegexConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class FieldRegexValidator implements IValidatorHandler<FieldRegexConfig> {
  readonly type = 'field_regex';
  readonly phase = 'validator' as const;
  readonly schema = cfgSchema;

  // eslint-disable-next-line @typescript-eslint/require-await -- sync body; async to satisfy IValidatorHandler contract
  async validate(
    cfg: FieldRegexConfig,
    ctx: IEvaluationContext,
  ): Promise<IValidatorResult> {
    // Defence-in-depth at runtime: a pattern persisted before the save-time
    // guard existed must never execute if it is catastrophic.
    if (isPotentiallyCatastrophicRegex(cfg.pattern)) {
      return {
        ok: false,
        message: 'Validator regex is unsafe and was not evaluated',
        fieldPath: cfg.field_id,
      };
    }

    let regex: RegExp;

    try {
      regex = new RegExp(cfg.pattern, cfg.flags);
    } catch {
      return {
        ok: false,
        message: 'Invalid regex',
        fieldPath: cfg.field_id,
      };
    }

    const raw = (ctx.customFieldValuesById ?? ctx.customFieldValues)[
      cfg.field_id
    ];

    // Empty / null / non-primitive values fail this check.
    if (
      raw === undefined ||
      raw === null ||
      raw === '' ||
      (typeof raw !== 'string' &&
        typeof raw !== 'number' &&
        typeof raw !== 'boolean' &&
        typeof raw !== 'bigint')
    ) {
      return {
        ok: false,
        message: cfg.message ?? 'Value does not match required pattern',
        fieldPath: cfg.field_id,
      };
    }

    const str = String(raw);

    // Cap the tested input length to bound regex CPU on pathological inputs.
    if (str.length > MAX_TESTED_INPUT_LENGTH) {
      return {
        ok: false,
        message: cfg.message ?? 'Value is too long to validate',
        fieldPath: cfg.field_id,
      };
    }

    if (!regex.test(str)) {
      return {
        ok: false,
        message: cfg.message ?? 'Value does not match required pattern',
        fieldPath: cfg.field_id,
      };
    }

    return { ok: true };
  }

  findReferences(cfg: FieldRegexConfig): IRuleReference[] {
    return [{ kind: 'field', id: cfg.field_id }];
  }
}
