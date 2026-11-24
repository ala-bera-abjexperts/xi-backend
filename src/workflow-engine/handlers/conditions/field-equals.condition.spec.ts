/**
 * @fileoverview Unit tests for FieldEqualsCondition.
 * @module src/workflow-engine/handlers/conditions/field-equals.condition.spec
 * @author Rajbha Manek
 */

import {
  FieldEqualsCondition,
  type FieldEqualsConfig,
} from './field-equals.condition';
import type { IEvaluationContext } from '../handler.types';

describe('FieldEqualsCondition', () => {
  const handler = new FieldEqualsCondition();
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

  describe('schema', () => {
    it('accepts a valid string value', () => {
      const r = handler.schema.safeParse({
        type: 'field_equals',
        field_id: fieldId,
        value: 'hello',
      });

      expect(r.success).toBe(true);
    });

    it('accepts a valid number value', () => {
      const r = handler.schema.safeParse({
        type: 'field_equals',
        field_id: fieldId,
        value: 42,
      });

      expect(r.success).toBe(true);
    });

    it('accepts a null value', () => {
      const r = handler.schema.safeParse({
        type: 'field_equals',
        field_id: fieldId,
        value: null,
      });

      expect(r.success).toBe(true);
    });

    it('rejects non-uuid field_id', () => {
      const r = handler.schema.safeParse({
        type: 'field_equals',
        field_id: 'not-a-uuid',
        value: 'x',
      });

      expect(r.success).toBe(false);
    });

    it('rejects array value', () => {
      const r = handler.schema.safeParse({
        type: 'field_equals',
        field_id: fieldId,
        value: ['a', 'b'],
      });

      expect(r.success).toBe(false);
    });
  });

  describe('evaluate', () => {
    const make = (value: FieldEqualsConfig['value']): FieldEqualsConfig => ({
      type: 'field_equals',
      field_id: fieldId,
      value,
    });

    it('true when string matches', async () => {
      expect(
        await handler.evaluate(
          make('done'),
          ctx({ customFieldValues: { [fieldId]: 'done' } }),
        ),
      ).toBe(true);
    });

    it('true when number matches', async () => {
      expect(
        await handler.evaluate(
          make(7),
          ctx({ customFieldValues: { [fieldId]: 7 } }),
        ),
      ).toBe(true);
    });

    it('true when boolean matches', async () => {
      expect(
        await handler.evaluate(
          make(true),
          ctx({ customFieldValues: { [fieldId]: true } }),
        ),
      ).toBe(true);
    });

    it('true when null matches', async () => {
      expect(
        await handler.evaluate(
          make(null),
          ctx({ customFieldValues: { [fieldId]: null } }),
        ),
      ).toBe(true);
    });

    it('false when value is undefined (missing field)', async () => {
      expect(
        await handler.evaluate(make(null), ctx({ customFieldValues: {} })),
      ).toBe(false);
    });

    it('false when types differ (number vs string)', async () => {
      expect(
        await handler.evaluate(
          make(7),
          ctx({ customFieldValues: { [fieldId]: '7' } }),
        ),
      ).toBe(false);
    });
  });

  describe('findReferences', () => {
    it('returns the field id', () => {
      const refs = handler.findReferences({
        type: 'field_equals',
        field_id: fieldId,
        value: 'x',
      });

      expect(refs).toEqual([{ kind: 'field', id: fieldId }]);
    });
  });
});
