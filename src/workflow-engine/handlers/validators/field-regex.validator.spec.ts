/**
 * @fileoverview Unit tests for FieldRegexValidator.
 * @module src/workflow-engine/handlers/validators/field-regex.validator.spec
 * @author Rajbha Manek
 */

import {
  FieldRegexValidator,
  type FieldRegexConfig,
} from './field-regex.validator';
import type { IEvaluationContext } from '../handler.types';

describe('FieldRegexValidator', () => {
  const handler = new FieldRegexValidator();
  const fieldId = '123e4567-e89b-12d3-a456-426614174002';

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
        type: 'field_regex',
        field_id: fieldId,
        pattern: '^[A-Z]+$',
      });

      expect(r.success).toBe(true);
    });

    it('accepts a valid config with flags and message', () => {
      const r = handler.schema.safeParse({
        type: 'field_regex',
        field_id: fieldId,
        pattern: '^abc$',
        flags: 'i',
        message: 'Must match',
      });

      expect(r.success).toBe(true);
    });

    it('rejects pattern longer than 500 chars', () => {
      const r = handler.schema.safeParse({
        type: 'field_regex',
        field_id: fieldId,
        pattern: 'x'.repeat(501),
      });

      expect(r.success).toBe(false);
    });

    it('rejects flags longer than 10 chars', () => {
      const r = handler.schema.safeParse({
        type: 'field_regex',
        field_id: fieldId,
        pattern: '.*',
        flags: 'gimsuy12345',
      });

      expect(r.success).toBe(false);
    });

    it('rejects non-uuid field_id', () => {
      const r = handler.schema.safeParse({
        type: 'field_regex',
        field_id: 'not-a-uuid',
        pattern: '.*',
      });

      expect(r.success).toBe(false);
    });
  });

  describe('validate', () => {
    it('ok when value matches the pattern', async () => {
      const cfg: FieldRegexConfig = {
        type: 'field_regex',
        field_id: fieldId,
        pattern: '^[A-Z]+$',
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: 'ABC' } }),
      );

      expect(result.ok).toBe(true);
    });

    it('invalid when value does not match', async () => {
      const cfg: FieldRegexConfig = {
        type: 'field_regex',
        field_id: fieldId,
        pattern: '^[A-Z]+$',
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: 'abc' } }),
      );

      expect(result.ok).toBe(false);
      expect(result.fieldPath).toBe(fieldId);
    });

    it('invalid when pattern is malformed', async () => {
      const cfg: FieldRegexConfig = {
        type: 'field_regex',
        field_id: fieldId,
        pattern: '[unclosed',
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: 'abc' } }),
      );

      expect(result.ok).toBe(false);
      expect(result.message).toBe('Invalid regex');
    });

    it('invalid when field value is missing', async () => {
      const cfg: FieldRegexConfig = {
        type: 'field_regex',
        field_id: fieldId,
        pattern: '.*',
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: {} }),
      );

      expect(result.ok).toBe(false);
    });

    it('invalid when field value is empty string', async () => {
      const cfg: FieldRegexConfig = {
        type: 'field_regex',
        field_id: fieldId,
        pattern: '.*',
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: '' } }),
      );

      expect(result.ok).toBe(false);
    });

    it('respects case-insensitive flag', async () => {
      const cfg: FieldRegexConfig = {
        type: 'field_regex',
        field_id: fieldId,
        pattern: '^abc$',
        flags: 'i',
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: 'ABC' } }),
      );

      expect(result.ok).toBe(true);
    });

    it('uses custom message on mismatch', async () => {
      const cfg: FieldRegexConfig = {
        type: 'field_regex',
        field_id: fieldId,
        pattern: '^[A-Z]+$',
        message: 'Use uppercase letters only',
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: 'abc' } }),
      );

      expect(result.message).toBe('Use uppercase letters only');
    });

    it('coerces numbers to string before testing', async () => {
      const cfg: FieldRegexConfig = {
        type: 'field_regex',
        field_id: fieldId,
        pattern: '^\\d+$',
      };
      const result = await handler.validate(
        cfg,
        ctx({ customFieldValues: { [fieldId]: 123 } }),
      );

      expect(result.ok).toBe(true);
    });
  });

  describe('findReferences', () => {
    it('returns the field id', () => {
      const refs = handler.findReferences({
        type: 'field_regex',
        field_id: fieldId,
        pattern: '.*',
      });

      expect(refs).toEqual([{ kind: 'field', id: fieldId }]);
    });
  });
});
