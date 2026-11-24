/**
 * @fileoverview Condition: a custom field's value strictly equals a literal.
 * @module src/workflow-engine/handlers/conditions/field-equals.condition
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
  isSystemFieldId,
  isValidRuleFieldId,
  resolveFieldValue,
} from '../system-fields';

const cfgSchema = z.object({
  type: z.literal('field_equals'),
  // A custom-field UUID or a known system field key (e.g. `sys:status_id`).
  field_id: z.string().refine(isValidRuleFieldId, {
    message: 'field_id must be a custom-field UUID or a known system field key',
  }),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

export type FieldEqualsConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class FieldEqualsCondition implements IConditionHandler<FieldEqualsConfig> {
  readonly type = 'field_equals';
  readonly phase = 'condition' as const;
  readonly schema = cfgSchema;

  // eslint-disable-next-line @typescript-eslint/require-await -- sync body; async to satisfy IConditionHandler contract
  async evaluate(
    cfg: FieldEqualsConfig,
    ctx: IEvaluationContext,
  ): Promise<boolean> {
    const current = resolveFieldValue(cfg.field_id, ctx);

    // Undefined is never equal to a configured literal (even null).
    if (current === undefined) return false;

    return Object.is(current, cfg.value);
  }

  findReferences(cfg: FieldEqualsConfig): IRuleReference[] {
    // System fields (`sys:*`) are not custom-field references — skip them so
    // org-scope reference checks never treat them as dangling field ids.
    if (isSystemFieldId(cfg.field_id)) return [];

    return [{ kind: 'field', id: cfg.field_id }];
  }
}
