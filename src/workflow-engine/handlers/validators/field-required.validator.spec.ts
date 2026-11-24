/**
 * @fileoverview Unit tests for FieldRequiredValidator.
 * @module src/workflow-engine/handlers/validators/field-required.validator.spec
 * @author Rajbha Manek
 */

import {
  FieldRequiredValidator,
  type FieldRequiredConfig,
} from './field-required.validator';
import type { IEvaluationContext } from '../handler.types';

describe('FieldRequiredValidator', () => {
  const handler = new FieldRequiredValidator();
  const fieldId = '123e4567-e89b-12d3-a456-426614174001';

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
    it('accepts a valid config', () => {
      const r = handler.schema.safeParse({
        type: 'field_required',
        field_id: fieldId,
      });

      expect(r.success).toBe(true);
    });

    it('accepts a valid config with custom message', () => {
      const r = handler.schema.safeParse({
        type: 'field_required',
        field_id: fieldId,
        message: 'Please fill in',
      });

      expect(r.success).toBe(true);
    });

    it('rejects non-uuid field_id', () => {
      const r = handler.schema.safeParse({
        type: 'field_required',
        field_id: 'not-a-uuid',
      });

      expect(r.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({
        type: 'something_else',
        field_id: fieldId,
      });

      expect(r.success).toBe(false);
    });

    it('rejects message longer than 200 chars', () => {
      const r = handler.schema.safeParse({
        type: 'field_required',
        field_id: fieldId,
        message: 'x'.repeat(201),
      });

      expect(r.success).toBe(false);
    });
  });

  describe('validate', () => {
    const cfg: FieldRequiredConfig = {
      type: 'field_required',
      field_id: fieldId,
    };

    it('invalid when value is empty string', async () => {
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: '' } }),
      );

      expect(result.ok).toBe(false);
      expect(result.fieldPath).toBe(fieldId);
    });

    it('invalid when value is null', async () => {
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: null } }),
      );

      expect(result.ok).toBe(false);
    });

    it('invalid when value is an empty array', async () => {
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: [] } }),
      );

      expect(result.ok).toBe(false);
    });

    it('invalid when field is missing entirely', async () => {
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: {} }),
      );

      expect(result.ok).toBe(false);
      expect(result.message).toBe('This field is required');
    });

    it('ok when value is a non-empty string', async () => {
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: 'hello' } }),
      );

      expect(result.ok).toBe(true);
    });

    it('ok when value is a non-empty array', async () => {
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: ['a'] } }),
      );

      expect(result.ok).toBe(true);
    });

    it('ok when value is the number zero', async () => {
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: 0 } }),
      );

      expect(result.ok).toBe(true);
    });

    it('returns the custom message when provided', async () => {
      const result = await handler.validate(
        { ...cfg, message: 'Please provide a value' },
        ctx({ customFieldValues: {} }),
      );

      expect(result.message).toBe('Please provide a value');
    });
  });

  describe('findReferences', () => {
    it('returns the field id', () => {
      const refs = handler.findReferences({
        type: 'field_required',
        field_id: fieldId,
      });

      expect(refs).toEqual([{ kind: 'field', id: fieldId }]);
    });
  });
});
