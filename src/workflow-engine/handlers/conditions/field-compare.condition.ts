/**
 * @fileoverview Condition: a custom field's value satisfies a comparator op.
 * @module src/workflow-engine/handlers/conditions/field-compare.condition
 * @author Rajbha Manek
 */

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type {
  IConditionHandler,
  IEvaluationContext,
  IRuleReference,
} from '../handler.types';
import {
  coerceOrderable,
  isSystemFieldId,
  isValidRuleFieldId,
  resolveFieldValue,
} from '../system-fields';

const cfgSchema = z.object({
  type: z.literal('field_compare'),
  // A custom-field UUID or a known system field key (e.g. `sys:due_date`).
  field_id: z.string().refine(isValidRuleFieldId, {
    message: 'field_id must be a custom-field UUID or a known system field key',
  }),
  op: z.enum([
    'eq',
    'ne',
    'gt',
    'lt',
    'gte',
    'lte',
    'in',
    'not_in',
    'contains',
    'starts_with',
    'ends_with',
    'is_empty',
    'is_not_empty',
  ]),
  value: z.unknown(),
});

export type FieldCompareConfig = z.infer<typeof cfgSchema>;

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;

  return false;
}

@Injectable()
export class FieldCompareCondition implements IConditionHandler<FieldCompareConfig> {
  readonly type = 'field_compare';
  readonly phase = 'condition' as const;
  readonly schema = cfgSchema;

  // eslint-disable-next-line @typescript-eslint/require-await -- sync body; async to satisfy IConditionHandler contract
  async evaluate(
    cfg: FieldCompareConfig,
    ctx: IEvaluationContext,
  ): Promise<boolean> {
    const current = resolveFieldValue(cfg.field_id, ctx);
    const isSystem = isSystemFieldId(cfg.field_id);

    switch (cfg.op) {
      case 'eq': {
        if (current === undefined) return false;

        return Object.is(current, cfg.value);
      }
      case 'ne': {
        if (current === undefined) return false;

        return !Object.is(current, cfg.value);
      }
      case 'gt':
      case 'lt':
      case 'gte':
      case 'lte': {
        // System fields (e.g. dates) coerce ISO strings → epoch ms so range
        // comparisons work. Custom fields keep the strict numeric contract so
        // existing behavior is unchanged.
        let a: number;
        let b: number;

        if (isSystem) {
          a = coerceOrderable(current);
          b = coerceOrderable(cfg.value);
          if (Number.isNaN(a) || Number.isNaN(b)) return false;
        } else {
          if (typeof current !== 'number' || typeof cfg.value !== 'number') {
            return false;
          }
          a = current;
          b = cfg.value;
        }
        if (cfg.op === 'gt') return a > b;
        if (cfg.op === 'lt') return a < b;
        if (cfg.op === 'gte') return a >= b;

        return a <= b;
      }
      case 'in': {
        if (!Array.isArray(cfg.value)) return false;

        return (cfg.value as unknown[]).some((v) => Object.is(v, current));
      }
      case 'not_in': {
        if (!Array.isArray(cfg.value)) return false;

        return !(cfg.value as unknown[]).some((v) => Object.is(v, current));
      }
      case 'contains': {
        if (typeof current !== 'string' || typeof cfg.value !== 'string') {
          return false;
        }

        return current.includes(cfg.value);
      }
      case 'starts_with': {
        if (typeof current !== 'string' || typeof cfg.value !== 'string') {
          return false;
        }

        return current.startsWith(cfg.value);
      }
      case 'ends_with': {
        if (typeof current !== 'string' || typeof cfg.value !== 'string') {
          return false;
        }

        return current.endsWith(cfg.value);
      }
      case 'is_empty': {
        return isEmpty(current);
      }
      case 'is_not_empty': {
        return !isEmpty(current);
      }
    }
  }

  findReferences(cfg: FieldCompareConfig): IRuleReference[] {
    // System fields (`sys:*`) are not custom-field references.
    if (isSystemFieldId(cfg.field_id)) return [];

    return [{ kind: 'field', id: cfg.field_id }];
  }
}
