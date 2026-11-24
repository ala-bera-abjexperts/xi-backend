/**
 * @fileoverview Unit tests for SetFieldValuePostFunction.
 * @module src/workflow-engine/handlers/post-functions/set-field-value.post.spec
 * @author Rajbha Manek
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  SetFieldValuePostFunction,
  type SetFieldValueConfig,
} from './set-field-value.post';
import type { IEvaluationContext } from '../handler.types';

describe('SetFieldValuePostFunction', () => {
  const handler = new SetFieldValuePostFunction();
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

  /**
   * Build a txn mock that returns `current` from the SELECT, and records the
   * payload of the UPDATE. Optionally returns an error on either step.
   */
  function makeTxn(
    opts: {
      current?: Record<string, unknown> | null;
      selectError?: { message: string } | null;
      updateError?: { message: string } | null;
      notFound?: boolean;
      fieldKey?: string | null;
      fieldLookupError?: { message: string } | null;
      field?: Record<string, unknown>;
    } = {},
  ): {
    txn: SupabaseClient;
    selectFrom: jest.Mock;
    update: jest.Mock;
  } {
    // custom_fields lookup: .select('field_key').eq('id').eq('organization_id').maybeSingle()
    const resolvedFieldKey =
      opts.fieldKey === undefined ? 'tcf_key' : opts.fieldKey;
    const cfMaybeSingle = jest.fn().mockResolvedValue({
      data:
        resolvedFieldKey === null
          ? null
          : { field_key: resolvedFieldKey, ...opts.field },
      error: opts.fieldLookupError ?? null,
    });
    const cfSelect = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({ maybeSingle: cfMaybeSingle }),
      }),
    });

    // tasks fetch: .select('custom_field_values').eq('id').eq('organization_id').maybeSingle()
    const taskData = opts.notFound
      ? null
      : { custom_field_values: opts.current ?? {} };
    const taskMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: taskData, error: opts.selectError ?? null });
    const taskSelect = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({ maybeSingle: taskMaybeSingle }),
      }),
    });

    // tasks update: .update({...}).eq('id').eq('organization_id')
    const update = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest
          .fn()
          .mockResolvedValue({ data: null, error: opts.updateError ?? null }),
      }),
    });

    const selectFrom = jest.fn();
    const from = jest.fn().mockImplementation((tableName: string) => {
      selectFrom(tableName);

      if (tableName === 'custom_fields') return { select: cfSelect };

      return { select: taskSelect, update };
    });
    const txn = { from } as unknown as SupabaseClient;

    return { txn, selectFrom, update };
  }

  describe('schema', () => {
    it('accepts a string value', () => {
      const r = handler.schema.safeParse({
        type: 'set_field_value',
        field_id: fieldId,
        value: 'hello',
      });

      expect(r.success).toBe(true);
    });

    it('accepts a number value', () => {
      const r = handler.schema.safeParse({
        type: 'set_field_value',
        field_id: fieldId,
        value: 42,
      });

      expect(r.success).toBe(true);
    });

    it('accepts a boolean value', () => {
      const r = handler.schema.safeParse({
        type: 'set_field_value',
        field_id: fieldId,
        value: true,
      });

      expect(r.success).toBe(true);
    });

    it('accepts a null value', () => {
      const r = handler.schema.safeParse({
        type: 'set_field_value',
        field_id: fieldId,
        value: null,
      });

      expect(r.success).toBe(true);
    });

    it('accepts an array value', () => {
      const r = handler.schema.safeParse({
        type: 'set_field_value',
        field_id: fieldId,
        value: ['a', 1, true],
      });

      expect(r.success).toBe(true);
    });

    it('accepts a record value', () => {
      const r = handler.schema.safeParse({
        type: 'set_field_value',
        field_id: fieldId,
        value: { nested: 'value' },
      });

      expect(r.success).toBe(true);
    });

    it('rejects non-uuid field_id', () => {
      const r = handler.schema.safeParse({
        type: 'set_field_value',
        field_id: 'not-a-uuid',
        value: 'x',
      });

      expect(r.success).toBe(false);
    });

    it('rejects missing value', () => {
      const r = handler.schema.safeParse({
        type: 'set_field_value',
        field_id: fieldId,
      });

      expect(r.success).toBe(false);
    });
  });

  describe('run', () => {
    it('merges the value into existing custom_field_values', async () => {
      const { txn, update } = makeTxn({ current: { other: 'keep' } });
      const cfg: SetFieldValueConfig = {
        type: 'set_field_value',
        field_id: fieldId,
        value: 'hello',
      };

      await handler.run(cfg, ctx({ txn }));

      // Keyed by the resolved field_key ('tcf_key'), NOT the field_id UUID.
      expect(update).toHaveBeenCalledWith({
        custom_field_values: { other: 'keep', tcf_key: 'hello' },
      });
    });

    it('overwrites the existing key when set again', async () => {
      const { txn, update } = makeTxn({
        current: { tcf_key: 'old', sibling: 1 },
      });
      const cfg: SetFieldValueConfig = {
        type: 'set_field_value',
        field_id: fieldId,
        value: 'new',
      };

      await handler.run(cfg, ctx({ txn }));
      expect(update).toHaveBeenCalledWith({
        custom_field_values: { tcf_key: 'new', sibling: 1 },
      });
    });

    it('starts from {} when custom_field_values is null', async () => {
      const { txn, update } = makeTxn({ current: null });
      const cfg: SetFieldValueConfig = {
        type: 'set_field_value',
        field_id: fieldId,
        value: 42,
      };

      await handler.run(cfg, ctx({ txn }));
      expect(update).toHaveBeenCalledWith({
        custom_field_values: { tcf_key: 42 },
      });
    });

    it('skips the write when the field_id resolves to no field', async () => {
      const { txn, update } = makeTxn({ fieldKey: null });
      const cfg: SetFieldValueConfig = {
        type: 'set_field_value',
        field_id: fieldId,
        value: 'x',
      };

      await handler.run(cfg, ctx({ txn }));
      expect(update).not.toHaveBeenCalled();
    });

    it('throws when the task does not exist in org', async () => {
      const { txn } = makeTxn({ notFound: true });
      const cfg: SetFieldValueConfig = {
        type: 'set_field_value',
        field_id: fieldId,
        value: 'x',
      };

      await expect(handler.run(cfg, ctx({ txn }))).rejects.toThrow(/not found/);
    });

    it('throws when the SELECT errors', async () => {
      const { txn } = makeTxn({ selectError: { message: 'select bad' } });
      const cfg: SetFieldValueConfig = {
        type: 'set_field_value',
        field_id: fieldId,
        value: 'x',
      };

      await expect(handler.run(cfg, ctx({ txn }))).rejects.toThrow(
        /select bad/,
      );
    });

    it('throws when the UPDATE errors', async () => {
      const { txn } = makeTxn({ updateError: { message: 'update bad' } });
      const cfg: SetFieldValueConfig = {
        type: 'set_field_value',
        field_id: fieldId,
        value: 'x',
      };

      await expect(handler.run(cfg, ctx({ txn }))).rejects.toThrow(
        /update bad/,
      );
    });

    it('throws when ctx.txn is missing', async () => {
      const cfg: SetFieldValueConfig = {
        type: 'set_field_value',
        field_id: fieldId,
        value: 'x',
      };

      await expect(handler.run(cfg, ctx())).rejects.toThrow(/requires ctx.txn/);
    });

    it('skips the write when field_id is whitespace', async () => {
      const { txn, update } = makeTxn();
      const cfg: SetFieldValueConfig = {
        type: 'set_field_value',
        field_id: '   ',
        value: 'x',
      };

      await handler.run(cfg, ctx({ txn }));
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('run (issue_group field)', () => {
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';
    const OLD = '33333333-3333-4333-8333-333333333333';
    const issueGroup = (mode: 'single' | 'multi' = 'multi') => ({
      field_type: 'issue_group',
      name: 'Release',
      validation_rules: { issue_group: { selection_mode: mode } },
      options: [
        { value: A, label: 'A' },
        { value: B, label: 'B' },
        { value: OLD, label: 'Old', status: 'archived' },
      ],
    });
    const cfg = (value: SetFieldValueConfig['value']): SetFieldValueConfig => ({
      type: 'set_field_value',
      field_id: fieldId,
      value,
    });

    it('writes a valid selection', async () => {
      const { txn, update } = makeTxn({ field: issueGroup() });

      await handler.run(cfg([A, B]), ctx({ txn }));

      expect(update).toHaveBeenCalledWith({
        custom_field_values: { tcf_key: [A, B] },
      });
    });

    it.each([
      ['a non-array value', A, 'multi'],
      ['an unknown option', [A, 'nope'], 'multi'],
      ['two values in single mode', [A, B], 'single'],
      ['an archived option the task does not hold', [OLD], 'multi'],
    ] as const)('skips %s', async (_, value, mode) => {
      const { txn, update } = makeTxn({ field: issueGroup(mode) });

      await handler.run(cfg(value as never), ctx({ txn }));

      expect(update).not.toHaveBeenCalled();
    });

    it('keeps an archived option the task already holds', async () => {
      const { txn, update } = makeTxn({
        field: issueGroup(),
        current: { tcf_key: [OLD] },
      });

      await handler.run(cfg([OLD, A]), ctx({ txn }));

      expect(update).toHaveBeenCalledWith({
        custom_field_values: { tcf_key: [OLD, A] },
      });
    });
  });

  describe('findReferences', () => {
    it('returns the field id', () => {
      const refs = handler.findReferences({
        type: 'set_field_value',
        field_id: fieldId,
        value: 'x',
      });

      expect(refs).toEqual([{ kind: 'field', id: fieldId }]);
    });
  });
});
