/**
 * @fileoverview Unit tests for FieldRangeValidator.
 * @module src/workflow-engine/handlers/validators/field-range.validator.spec
 * @author Rajbha Manek
 */

import {
  FieldRangeValidator,
  type FieldRangeConfig,
} from './field-range.validator';
import type { IEvaluationContext } from '../handler.types';

describe('FieldRangeValidator', () => {
  const handler = new FieldRangeValidator();
  const fieldId = '123e4567-e89b-12d3-a456-426614174003';

  const ctx = (
    overrides: Partial<IEvaluationContext> = {},
  ): IEvaluationContext => ({
    organizationId: 'org-1',
    spaceId: 'space-1',
    taskId: 'task-1',
    task: null,
    transitionId: 'tx-1',
    transition: null,
    userId: 'user-1',
    user: null,
    userRoles: [],
    userGroups: [],
    customFieldValues: {},
    ...overrides,
  });

  describe('schema', () => {
    it('accepts a config with min only', () => {
      const r = handler.schema.safeParse({
        type: 'field_range',
        field_id: fieldId,
        min: 0,
      });

      expect(r.success).toBe(true);
    });

    it('accepts a config with max only', () => {
      const r = handler.schema.safeParse({
        type: 'field_range',
        field_id: fieldId,
        max: 100,
      });

      expect(r.success).toBe(true);
    });

    it('accepts a config with both', () => {
      const r = handler.schema.safeParse({
        type: 'field_range',
        field_id: fieldId,
        min: 0,
        max: 100,
      });

      expect(r.success).toBe(true);
    });

    it('rejects a config with neither min nor max', () => {
      const r = handler.schema.safeParse({
        type: 'field_range',
        field_id: fieldId,
      });

      expect(r.success).toBe(false);
    });

    it('rejects non-uuid field_id', () => {
      const r = handler.schema.safeParse({
        type: 'field_range',
        field_id: 'not-a-uuid',
        min: 0,
      });

      expect(r.success).toBe(false);
    });
  });

  describe('validate', () => {
    it('ok when value is within range', async () => {
      const cfg: FieldRangeConfig = {
        type: 'field_range',
        field_id: fieldId,
        min: 0,
        max: 100,
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: 50 } }),
      );

      expect(result.ok).toBe(true);
    });

    it('ok when value equals min boundary', async () => {
      const cfg: FieldRangeConfig = {
        type: 'field_range',
        field_id: fieldId,
        min: 0,
        max: 100,
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: 0 } }),
      );

      expect(result.ok).toBe(true);
    });

    it('ok when value equals max boundary', async () => {
      const cfg: FieldRangeConfig = {
        type: 'field_range',
        field_id: fieldId,
        min: 0,
        max: 100,
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: 100 } }),
      );

      expect(result.ok).toBe(true);
    });

    it('invalid when value is below min', async () => {
      const cfg: FieldRangeConfig = {
        type: 'field_range',
        field_id: fieldId,
        min: 10,
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: 5 } }),
      );

      expect(result.ok).toBe(false);
      expect(result.fieldPath).toBe(fieldId);
    });

    it('invalid when value is above max', async () => {
      const cfg: FieldRangeConfig = {
        type: 'field_range',
        field_id: fieldId,
        max: 10,
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: 15 } }),
      );

      expect(result.ok).toBe(false);
    });

    it('invalid when field is missing', async () => {
      const cfg: FieldRangeConfig = {
        type: 'field_range',
        field_id: fieldId,
        min: 0,
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: {} }),
      );

      expect(result.ok).toBe(false);
    });

    it('invalid when value is NaN (non-numeric string)', async () => {
      const cfg: FieldRangeConfig = {
        type: 'field_range',
        field_id: fieldId,
        min: 0,
        max: 100,
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: 'abc' } }),
      );

      expect(result.ok).toBe(false);
    });

    it('ok with only-min when value above min', async () => {
      const cfg: FieldRangeConfig = {
        type: 'field_range',
        field_id: fieldId,
        min: 5,
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: 999 } }),
      );

      expect(result.ok).toBe(true);
    });

    it('ok with only-max when value below max', async () => {
      const cfg: FieldRangeConfig = {
        type: 'field_range',
        field_id: fieldId,
        max: 5,
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: -100 } }),
      );

      expect(result.ok).toBe(true);
    });

    it('coerces numeric string value', async () => {
      const cfg: FieldRangeConfig = {
        type: 'field_range',
        field_id: fieldId,
        min: 0,
        max: 100,
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: '42' } }),
      );

      expect(result.ok).toBe(true);
    });
  });

  describe('findReferences', () => {
    it('returns the field id', () => {
      const refs = handler.findReferences({
        type: 'field_range',
        field_id: fieldId,
        min: 0,
      });

      expect(refs).toEqual([{ kind: 'field', id: fieldId }]);
    });
  });
});
