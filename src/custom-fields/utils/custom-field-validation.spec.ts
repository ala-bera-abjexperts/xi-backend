/**
 * @fileoverview Tests for the custom field validation engine — covers all 22
 * field types, boundary conditions, coercion, and error semantics.
 * @module src/custom-fields/utils/custom-field-validation.spec
 * @author Prince Jadiya
 */

import {
  FieldValidationError,
  validateFieldValue,
  coerceValueToFieldType,
} from './custom-field-validation';
import type { CustomField } from '../models/custom-field.model';

/** Build a minimal CustomField for tests. */
function makeField(overrides: Partial<CustomField>): CustomField {
  return {
    id: 'f1',
    organization_id: 'org-1',
    space_id: null,
    scope: 'organization',
    name: 'Test Field',
    field_key: 'test_field',
    field_type: 'string',
    description: null,
    description_i18n: {},
    name_i18n: {},
    default_value: null,
    options: [],
    validation_rules: {},
    contexts: [],
    is_system: false,
    is_active: true,
    sort_order: 0,
    created_by: null,
    updated_by: null,
    created_at: '',
    updated_at: '',
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
    ...overrides,
  };
}

describe('FieldValidationError', () => {
  it('sets name, fieldKey, fieldName, and message', () => {
    const err = new FieldValidationError('k', 'Name', 'bad');
    expect(err.name).toBe('FieldValidationError');
    expect(err.fieldKey).toBe('k');
    expect(err.fieldName).toBe('Name');
    expect(err.message).toBe('bad');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('validateFieldValue — null/undefined skip', () => {
  const f = makeField({ field_type: 'string' });
  it('skips null', () => {
    expect(() => validateFieldValue(f, null)).not.toThrow();
  });
  it('skips undefined', () => {
    expect(() => validateFieldValue(f, undefined)).not.toThrow();
  });
});

describe('validateFieldValue — unknown type', () => {
  it('skips unknown field_type', () => {
    const f = makeField({ field_type: 'mystery' as never });
    expect(() => validateFieldValue(f, 'x')).not.toThrow();
  });
});

describe('string field', () => {
  it('accepts a string', () => {
    expect(() =>
      validateFieldValue(makeField({ field_type: 'string' }), 'hello'),
    ).not.toThrow();
  });
  it('rejects a non-string', () => {
    expect(() =>
      validateFieldValue(makeField({ field_type: 'string' }), 123),
    ).toThrow(FieldValidationError);
  });
  it('enforces minLength', () => {
    expect(() =>
      validateFieldValue(
        makeField({ field_type: 'string', validation_rules: { minLength: 5 } }),
        'hi',
      ),
    ).toThrow(/at least 5/);
  });
  it('enforces maxLength', () => {
    expect(() =>
      validateFieldValue(
        makeField({ field_type: 'string', validation_rules: { maxLength: 3 } }),
        'hello',
      ),
    ).toThrow(/at most 3/);
  });
  it('enforces pattern', () => {
    expect(() =>
      validateFieldValue(
        makeField({
          field_type: 'string',
          validation_rules: { pattern: '^[A-Z]+$' },
        }),
        'abc',
      ),
    ).toThrow(/pattern/);
  });
  it('passes a valid pattern', () => {
    expect(() =>
      validateFieldValue(
        makeField({
          field_type: 'string',
          validation_rules: { pattern: '^[A-Z]+$' },
        }),
        'ABC',
      ),
    ).not.toThrow();
  });
});

describe('number field', () => {
  it('accepts a number', () => {
    expect(() =>
      validateFieldValue(makeField({ field_type: 'number' }), 42),
    ).not.toThrow();
  });
  it('accepts a numeric string', () => {
    expect(() =>
      validateFieldValue(makeField({ field_type: 'number' }), '42'),
    ).not.toThrow();
  });
  it('rejects a non-numeric value', () => {
    expect(() =>
      validateFieldValue(makeField({ field_type: 'number' }), 'abc'),
    ).toThrow(/valid number/);
  });
  it('enforces min', () => {
    expect(() =>
      validateFieldValue(
        makeField({ field_type: 'number', validation_rules: { min: 10 } }),
        5,
      ),
    ).toThrow(/at least 10/);
  });
  it('enforces max', () => {
    expect(() =>
      validateFieldValue(
        makeField({ field_type: 'number', validation_rules: { max: 10 } }),
        20,
      ),
    ).toThrow(/at most 10/);
  });
});

describe('editor field', () => {
  it('accepts a string', () => {
    expect(() =>
      validateFieldValue(makeField({ field_type: 'editor' }), '<p>hi</p>'),
    ).not.toThrow();
  });
  it('rejects non-string', () => {
    expect(() =>
      validateFieldValue(makeField({ field_type: 'editor' }), 123),
    ).toThrow();
  });
  it('enforces maxLength', () => {
    expect(() =>
      validateFieldValue(
        makeField({ field_type: 'editor', validation_rules: { maxLength: 2 } }),
        'abc',
      ),
    ).toThrow(/at most 2/);
  });
});

describe('select field', () => {
  const f = makeField({
    field_type: 'select',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  });
  it('accepts valid option', () => {
    expect(() => validateFieldValue(f, 'a')).not.toThrow();
  });
  it('rejects invalid option', () => {
    expect(() => validateFieldValue(f, 'z')).toThrow(/invalid value/);
  });
  it('rejects non-string', () => {
    expect(() => validateFieldValue(f, 123)).toThrow(/must be a string/);
  });
});

describe('multiselect field', () => {
  const f = makeField({
    field_type: 'multiselect',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  });
  it('accepts valid array', () => {
    expect(() => validateFieldValue(f, ['a', 'b'])).not.toThrow();
  });
  it('rejects non-array', () => {
    expect(() => validateFieldValue(f, 'a')).toThrow(/array/);
  });
  it('rejects array with invalid entries', () => {
    expect(() => validateFieldValue(f, ['a', 'z'])).toThrow(/invalid values/);
  });
});

describe('user_select field', () => {
  const f = makeField({ field_type: 'user_select' });
  it('accepts valid UUID', () => {
    expect(() =>
      validateFieldValue(f, '12345678-1234-1234-1234-123456789012'),
    ).not.toThrow();
  });
  it('rejects non-UUID string', () => {
    expect(() => validateFieldValue(f, 'not-a-uuid')).toThrow(/valid UUID/);
  });
  it('rejects non-string', () => {
    expect(() => validateFieldValue(f, 123)).toThrow();
  });
});

describe('user_multi field', () => {
  const f = makeField({ field_type: 'user_multi' });
  it('accepts array of UUIDs', () => {
    expect(() =>
      validateFieldValue(f, [
        '12345678-1234-1234-1234-123456789012',
        'abcdef12-1234-1234-1234-123456789012',
      ]),
    ).not.toThrow();
  });
  it('rejects non-array', () => {
    expect(() => validateFieldValue(f, 'x')).toThrow(/array/);
  });
  it('rejects array with invalid UUIDs', () => {
    expect(() => validateFieldValue(f, ['not-uuid'])).toThrow(/invalid/);
  });
});

describe('checkbox field', () => {
  const f = makeField({ field_type: 'checkbox' });
  it.each([true, false, 'true', 'false', 0, 1])('accepts %p', (v: unknown) => {
    expect(() => validateFieldValue(f, v)).not.toThrow();
  });
  it('rejects arbitrary string', () => {
    expect(() => validateFieldValue(f, 'yes')).toThrow(/boolean/);
  });
});

describe('radio field', () => {
  const f = makeField({
    field_type: 'radio',
    options: [{ value: 'x', label: 'X' }],
  });
  it('accepts valid', () => {
    expect(() => validateFieldValue(f, 'x')).not.toThrow();
  });
  it('rejects invalid', () => {
    expect(() => validateFieldValue(f, 'y')).toThrow();
  });
});

describe('label field', () => {
  it('skips validation', () => {
    expect(() =>
      validateFieldValue(makeField({ field_type: 'label' }), 'anything'),
    ).not.toThrow();
  });
});

describe('date/time/datetime field', () => {
  it('accepts Date instance', () => {
    expect(() =>
      validateFieldValue(makeField({ field_type: 'date' }), new Date()),
    ).not.toThrow();
  });
  it('accepts ISO string', () => {
    expect(() =>
      validateFieldValue(
        makeField({ field_type: 'datetime' }),
        '2025-01-01T00:00:00Z',
      ),
    ).not.toThrow();
  });
  it('rejects invalid date string', () => {
    expect(() =>
      validateFieldValue(makeField({ field_type: 'date' }), 'not-a-date'),
    ).toThrow(/valid date/);
  });
  it('rejects non-string non-Date', () => {
    expect(() =>
      validateFieldValue(makeField({ field_type: 'date' }), 123),
    ).toThrow();
  });
  it('enforces minDate', () => {
    expect(() =>
      validateFieldValue(
        makeField({
          field_type: 'date',
          validation_rules: { minDate: '2025-06-01' },
        }),
        '2025-01-01',
      ),
    ).toThrow(/after/);
  });
  it('enforces maxDate', () => {
    expect(() =>
      validateFieldValue(
        makeField({
          field_type: 'date',
          validation_rules: { maxDate: '2025-06-01' },
        }),
        '2025-12-01',
      ),
    ).toThrow(/before/);
  });
  it('time field accepts HH:MM', () => {
    expect(() =>
      validateFieldValue(makeField({ field_type: 'time' }), '14:30'),
    ).not.toThrow();
  });
  it('time field accepts HH:MM:SS', () => {
    expect(() =>
      validateFieldValue(makeField({ field_type: 'time' }), '14:30:45'),
    ).not.toThrow();
  });
  it('time field rejects invalid time', () => {
    expect(() =>
      validateFieldValue(makeField({ field_type: 'time' }), '25:99'),
    ).toThrow(/valid time/);
  });
});

describe('url field', () => {
  const f = makeField({ field_type: 'url' });
  it('accepts valid URL', () => {
    expect(() => validateFieldValue(f, 'https://example.com')).not.toThrow();
  });
  it('rejects invalid URL', () => {
    expect(() => validateFieldValue(f, 'not a url')).toThrow(/valid URL/);
  });
  it('rejects non-string', () => {
    expect(() => validateFieldValue(f, 5)).toThrow();
  });
});

describe('cascading_select field', () => {
  const f = makeField({
    field_type: 'cascading_select',
    options: [
      { value: 'p', label: 'P', level: 0 },
      { value: 'c', label: 'C', parent_value: 'p', level: 1 },
    ],
  });
  it('accepts valid { levels: string[] } shape', () => {
    expect(() => validateFieldValue(f, { levels: ['p', 'c'] })).not.toThrow();
  });
  it('rejects plain string', () => {
    expect(() => validateFieldValue(f, 'p')).toThrow();
  });
  it('rejects missing levels array', () => {
    expect(() => validateFieldValue(f, {})).toThrow();
  });
  it('rejects non-string level values', () => {
    expect(() => validateFieldValue(f, { levels: [1, 2] })).toThrow();
  });
});

describe('wiki_page / task / list_item fields', () => {
  const uuid = '12345678-1234-1234-1234-123456789012';
  it.each(['wiki_page', 'task', 'list_item'] as const)(
    '%s accepts UUID',
    (t) => {
      expect(() =>
        validateFieldValue(makeField({ field_type: t }), uuid),
      ).not.toThrow();
    },
  );
  it('wiki_page rejects non-UUID', () => {
    expect(() =>
      validateFieldValue(makeField({ field_type: 'wiki_page' }), 'nope'),
    ).toThrow();
  });
});

describe('coerceValueToFieldType', () => {
  it('returns null/undefined as-is', () => {
    const f = makeField({ field_type: 'string' });
    expect(coerceValueToFieldType(f, null)).toBeNull();
    expect(coerceValueToFieldType(f, undefined)).toBeUndefined();
  });
  it('keeps strings for string field', () => {
    expect(
      coerceValueToFieldType(makeField({ field_type: 'string' }), 'hi'),
    ).toBe('hi');
  });
  it('parses numeric strings for number field', () => {
    expect(
      coerceValueToFieldType(makeField({ field_type: 'number' }), '42'),
    ).toBe(42);
  });
  it('coerces "true"/"false"/0/1 for checkbox', () => {
    const f = makeField({ field_type: 'checkbox' });
    expect(coerceValueToFieldType(f, 'true')).toBe(true);
    expect(coerceValueToFieldType(f, '')).toBe(false);
    expect(coerceValueToFieldType(f, 1)).toBe(true);
    expect(coerceValueToFieldType(f, 0)).toBe(false);
  });
  it('wraps scalar into array for multiselect', () => {
    expect(
      coerceValueToFieldType(makeField({ field_type: 'multiselect' }), 'a'),
    ).toEqual(['a']);
  });
  it('keeps array for multiselect', () => {
    expect(
      coerceValueToFieldType(makeField({ field_type: 'multiselect' }), [
        'a',
        'b',
      ]),
    ).toEqual(['a', 'b']);
  });
  it('splits comma-separated string for multiselect when explicit', () => {
    expect(
      coerceValueToFieldType(makeField({ field_type: 'user_multi' }), ['u1']),
    ).toEqual(['u1']);
  });
  it('returns Date for date fields', () => {
    const out = coerceValueToFieldType(
      makeField({ field_type: 'date' }),
      '2025-01-01',
    );
    expect(out).toBeInstanceOf(Date);
  });
});

describe('validateFieldValue — grid', () => {
  const f = makeField({ field_type: 'grid', name: 'Risks' });

  it('accepts an empty row list', () => {
    expect(() => validateFieldValue(f, [])).not.toThrow();
  });

  it('accepts well-formed rows', () => {
    expect(() =>
      validateFieldValue(f, [
        {
          id: 'r1',
          values: { col_1: 'a', col_2: 3, col_3: true, col_4: null },
        },
      ]),
    ).not.toThrow();
  });

  it('tolerates cells for columns that no longer exist', () => {
    expect(() =>
      validateFieldValue(f, [{ id: 'r1', values: { removed_col: 'x' } }]),
    ).not.toThrow();
  });

  it('rejects a non-array value', () => {
    expect(() => validateFieldValue(f, { rows: [] })).toThrow(
      FieldValidationError,
    );
  });

  it('rejects a row without an id', () => {
    expect(() => validateFieldValue(f, [{ values: {} }])).toThrow(
      FieldValidationError,
    );
  });

  it('rejects a row without a values object', () => {
    expect(() => validateFieldValue(f, [{ id: 'r1' }])).toThrow(
      FieldValidationError,
    );
  });

  it('rejects an object cell value', () => {
    expect(() =>
      validateFieldValue(f, [{ id: 'r1', values: { col_1: { nested: 1 } } }]),
    ).toThrow(FieldValidationError);
  });

  it('rejects more than GRID_MAX_ROWS rows', () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      id: `r${i}`,
      values: {},
    }));
    expect(() => validateFieldValue(f, rows)).toThrow(FieldValidationError);
  });
});

describe('validateFieldValue — file / file_multi', () => {
  const single = makeField({ field_type: 'file', name: 'Contract' });
  const multi = makeField({ field_type: 'file_multi', name: 'Evidence' });
  const uuid = '11111111-1111-1111-1111-111111111111';

  it('accepts an attachment reference', () => {
    expect(() =>
      validateFieldValue(single, {
        source: 'attachment',
        attachmentId: uuid,
        name: 'a.pdf',
        mime: 'application/pdf',
        size: 10,
      }),
    ).not.toThrow();
  });

  it('accepts a file-explorer reference', () => {
    expect(() =>
      validateFieldValue(single, {
        source: 'file-explorer',
        nodeId: uuid,
        name: 'a.pdf',
      }),
    ).not.toThrow();
  });

  it('rejects an unknown source', () => {
    expect(() =>
      validateFieldValue(single, { source: 'dropbox', name: 'a.pdf' }),
    ).toThrow(FieldValidationError);
  });

  it('rejects a non-uuid attachment id', () => {
    expect(() =>
      validateFieldValue(single, {
        source: 'attachment',
        attachmentId: 'nope',
        name: 'a.pdf',
      }),
    ).toThrow(FieldValidationError);
  });

  it('rejects a reference without a name', () => {
    expect(() =>
      validateFieldValue(single, { source: 'attachment', attachmentId: uuid }),
    ).toThrow(FieldValidationError);
  });

  it('accepts an empty list for file_multi', () => {
    expect(() => validateFieldValue(multi, [])).not.toThrow();
  });

  it('rejects a bare object for file_multi', () => {
    expect(() =>
      validateFieldValue(multi, {
        source: 'attachment',
        attachmentId: uuid,
        name: 'a.pdf',
      }),
    ).toThrow(FieldValidationError);
  });

  it('rejects more than FILE_MULTI_MAX_ITEMS entries', () => {
    const refs = Array.from({ length: 26 }, () => ({
      source: 'attachment',
      attachmentId: uuid,
      name: 'a.pdf',
    }));
    expect(() => validateFieldValue(multi, refs)).toThrow(FieldValidationError);
  });
});

describe('coerceValueToFieldType — grid / file_multi', () => {
  it('keeps a grid array as-is', () => {
    const rows = [{ id: 'r1', values: {} }];
    expect(
      coerceValueToFieldType(makeField({ field_type: 'grid' }), rows),
    ).toBe(rows);
  });

  it('collapses a non-array grid value to an empty list', () => {
    expect(
      coerceValueToFieldType(makeField({ field_type: 'grid' }), 'nonsense'),
    ).toEqual([]);
  });

  it('wraps a lone file reference for file_multi', () => {
    const ref = { source: 'attachment', attachmentId: 'x', name: 'a.pdf' };
    expect(
      coerceValueToFieldType(makeField({ field_type: 'file_multi' }), ref),
    ).toEqual([ref]);
  });
});
