import type { IEvaluationContext } from './handler.types';
import { resolveFieldValue, systemFieldLabel } from './system-fields';

describe('systemFieldLabel', () => {
  it('returns the friendly label for a known system field id', () => {
    expect(systemFieldLabel('sys:assigned_to')).toBe('Assigned to');
    expect(systemFieldLabel('sys:status_id')).toBe('Status');
    expect(systemFieldLabel('sys:due_date')).toBe('Due date');
  });

  it('returns null for a custom-field UUID', () => {
    expect(systemFieldLabel('11111111-2222-3333-4444-555555555555')).toBeNull();
  });

  it('returns null for an unknown system key', () => {
    expect(systemFieldLabel('sys:does_not_exist')).toBeNull();
  });
});

describe('resolveFieldValue', () => {
  const FIELD_ID = '11111111-2222-3333-4444-555555555555';

  function ctx(overrides: Partial<IEvaluationContext>): IEvaluationContext {
    return {
      customFieldValues: {},
      task: null,
      ...overrides,
    } as IEvaluationContext;
  }

  it('reads a custom field by UUID from customFieldValuesById when present', () => {
    // tasks.custom_field_values is persisted slug-keyed; the engine also exposes
    // a UUID-keyed view. A rule addressing the field by its UUID must read the
    // by-id view, not the raw slug-keyed blob.
    const c = ctx({
      customFieldValues: { my_slug: 'set-via-sidebar' },
      customFieldValuesById: { [FIELD_ID]: 'set-via-sidebar' },
    });

    expect(resolveFieldValue(FIELD_ID, c)).toBe('set-via-sidebar');
  });

  it('falls back to slug-keyed customFieldValues when the by-id map is absent', () => {
    const c = ctx({ customFieldValues: { [FIELD_ID]: 'legacy-uuid-keyed' } });

    expect(resolveFieldValue(FIELD_ID, c)).toBe('legacy-uuid-keyed');
  });

  it('resolves a sys: field from the task row, ignoring the field maps', () => {
    const c = ctx({
      task: { status_id: 'status-9' },
      customFieldValuesById: { 'sys:status_id': 'ignored' },
    });

    expect(resolveFieldValue('sys:status_id', c)).toBe('status-9');
  });
});
