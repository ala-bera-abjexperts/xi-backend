/**
 * @fileoverview Unit tests for FieldCompareCondition.
 * @module src/workflow-engine/handlers/conditions/field-compare.condition.spec
 * @author Rajbha Manek
 */

import {
  FieldCompareCondition,
  type FieldCompareConfig,
} from './field-compare.condition';
import type { IEvaluationContext } from '../handler.types';

describe('FieldCompareCondition', () => {
  const handler = new FieldCompareCondition();
  const fieldId = '123e4567-e89b-12d3-a456-426614174000';

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

  const cfg = (
    op: FieldCompareConfig['op'],
    value: unknown,
  ): FieldCompareConfig => ({
    type: 'field_compare',
    field_id: fieldId,
    op,
    value,
  });

  describe('schema', () => {
    it('accepts a valid config', () => {
      const r = handler.schema.safeParse({
        type: 'field_compare',
        field_id: fieldId,
        op: 'eq',
        value: 1,
      });

      expect(r.success).toBe(true);
    });

    it('rejects unknown op', () => {
      const r = handler.schema.safeParse({
        type: 'field_compare',
        field_id: fieldId,
        op: 'regex',
        value: 'x',
      });

      expect(r.success).toBe(false);
    });

    it('rejects non-uuid field_id', () => {
      const r = handler.schema.safeParse({
        type: 'field_compare',
        field_id: 'not-a-uuid',
        op: 'eq',
        value: 1,
      });

      expect(r.success).toBe(false);
    });
  });

  describe('evaluate — eq / ne', () => {
    it('eq true when matches', async () => {
      expect(
        await handler.evaluate(
          cfg('eq', 1),
          ctx({ customFieldValues: { [fieldId]: 1 } }),
        ),
      ).toBe(true);
    });

    it('eq false when value is undefined', async () => {
      expect(
        await handler.evaluate(cfg('eq', 1), ctx({ customFieldValues: {} })),
      ).toBe(false);
    });

    it('ne true when differs', async () => {
      expect(
        await handler.evaluate(
          cfg('ne', 1),
          ctx({ customFieldValues: { [fieldId]: 2 } }),
        ),
      ).toBe(true);
    });

    it('ne false when value is undefined', async () => {
      expect(
        await handler.evaluate(cfg('ne', 1), ctx({ customFieldValues: {} })),
      ).toBe(false);
    });
  });

  describe('evaluate — gt / lt / gte / lte', () => {
    it('gt true', async () => {
      expect(
        await handler.evaluate(
          cfg('gt', 5),
          ctx({ customFieldValues: { [fieldId]: 6 } }),
        ),
      ).toBe(true);
    });

    it('lt true', async () => {
      expect(
        await handler.evaluate(
          cfg('lt', 5),
          ctx({ customFieldValues: { [fieldId]: 4 } }),
        ),
      ).toBe(true);
    });

    it('gte true on equality', async () => {
      expect(
        await handler.evaluate(
          cfg('gte', 5),
          ctx({ customFieldValues: { [fieldId]: 5 } }),
        ),
      ).toBe(true);
    });

    it('lte true on equality', async () => {
      expect(
        await handler.evaluate(
          cfg('lte', 5),
          ctx({ customFieldValues: { [fieldId]: 5 } }),
        ),
      ).toBe(true);
    });

    it('returns false when comparing string vs number', async () => {
      expect(
        await handler.evaluate(
          cfg('gt', 5),
          ctx({ customFieldValues: { [fieldId]: '10' } }),
        ),
      ).toBe(false);
    });
  });

  describe('evaluate — in / not_in', () => {
    it('in true when present', async () => {
      expect(
        await handler.evaluate(
          cfg('in', ['a', 'b']),
          ctx({ customFieldValues: { [fieldId]: 'b' } }),
        ),
      ).toBe(true);
    });

    it('in false when not array', async () => {
      expect(
        await handler.evaluate(
          cfg('in', 'a'),
          ctx({ customFieldValues: { [fieldId]: 'a' } }),
        ),
      ).toBe(false);
    });

    it('not_in true when absent', async () => {
      expect(
        await handler.evaluate(
          cfg('not_in', ['a', 'b']),
          ctx({ customFieldValues: { [fieldId]: 'c' } }),
        ),
      ).toBe(true);
    });
  });

  describe('evaluate — string ops', () => {
    it('contains true', async () => {
      expect(
        await handler.evaluate(
          cfg('contains', 'ell'),
          ctx({ customFieldValues: { [fieldId]: 'hello' } }),
        ),
      ).toBe(true);
    });

    it('contains false on non-string field', async () => {
      expect(
        await handler.evaluate(
          cfg('contains', 'x'),
          ctx({ customFieldValues: { [fieldId]: 42 } }),
        ),
      ).toBe(false);
    });

    it('starts_with true', async () => {
      expect(
        await handler.evaluate(
          cfg('starts_with', 'he'),
          ctx({ customFieldValues: { [fieldId]: 'hello' } }),
        ),
      ).toBe(true);
    });

    it('ends_with true', async () => {
      expect(
        await handler.evaluate(
          cfg('ends_with', 'lo'),
          ctx({ customFieldValues: { [fieldId]: 'hello' } }),
        ),
      ).toBe(true);
    });
  });

  describe('evaluate — is_empty / is_not_empty', () => {
    it('is_empty true for empty string', async () => {
      expect(
        await handler.evaluate(
          cfg('is_empty', null),
          ctx({ customFieldValues: { [fieldId]: '' } }),
        ),
      ).toBe(true);
    });

    it('is_empty true for null', async () => {
      expect(
        await handler.evaluate(
          cfg('is_empty', null),
          ctx({ customFieldValues: { [fieldId]: null } }),
        ),
      ).toBe(true);
    });

    it('is_empty true for undefined (missing field)', async () => {
      expect(
        await handler.evaluate(
          cfg('is_empty', null),
          ctx({ customFieldValues: {} }),
        ),
      ).toBe(true);
    });

    it('is_empty true for empty array', async () => {
      expect(
        await handler.evaluate(
          cfg('is_empty', null),
          ctx({ customFieldValues: { [fieldId]: [] } }),
        ),
      ).toBe(true);
    });

    it('is_not_empty true for non-empty string', async () => {
      expect(
        await handler.evaluate(
          cfg('is_not_empty', null),
          ctx({ customFieldValues: { [fieldId]: 'a' } }),
        ),
      ).toBe(true);
    });
  });

  describe('findReferences', () => {
    it('returns the field id', () => {
      expect(handler.findReferences(cfg('eq', 1))).toEqual([
        { kind: 'field', id: fieldId },
      ]);
    });
  });
});
