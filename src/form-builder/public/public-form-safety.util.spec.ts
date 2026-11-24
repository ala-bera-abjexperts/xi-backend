import {
  findPubliclyUnsafeTypes,
  isCustomUserSelect,
  sanitizeLayoutOptions,
} from './public-form-safety.util';

describe('sanitizeLayoutOptions', () => {
  it('preserves the grid knobs and every safely-typed cell', () => {
    const result = sanitizeLayoutOptions({
      rows: 1,
      columns: 2,
      gap: 12,
      rowGap: 12,
      align: 'stretch',
      columnPreset: 'equal',
      mode: 'grid',
      flexDirection: 'row',
      wrap: true,
      justify: 'start',
      cells: [
        [
          { type: 'short_text', label: 'First name', fieldKey: 'a' },
          { type: 'email', label: 'Email', fieldKey: 'b' },
        ],
      ],
    });

    expect(result).toEqual({
      rows: 1,
      columns: 2,
      gap: 12,
      rowGap: 12,
      align: 'stretch',
      columnPreset: 'equal',
      mode: 'grid',
      flexDirection: 'row',
      wrap: true,
      justify: 'start',
      cells: [
        [
          { type: 'short_text', label: 'First name', fieldKey: 'a' },
          { type: 'email', label: 'Email', fieldKey: 'b' },
        ],
      ],
    });
  });

  it('collapses an unrecognised cell type to an empty cell', () => {
    // `hidden` is publishable by the 2026-09-10 owner decision, so an unrecognised type is what
    // still exercises the whitelist rejection here.
    const result = sanitizeLayoutOptions({
      rows: 1,
      columns: 1,
      cells: [[{ type: 'not_a_real_type', label: 'Secret', fieldKey: 'a' }]],
    });

    expect(result?.cells).toEqual([[{ type: '', label: '' }]]);
  });

  it('keeps a hidden cell — hidden is publishable by owner decision', () => {
    const result = sanitizeLayoutOptions({
      rows: 1,
      columns: 1,
      cells: [[{ type: 'hidden', label: 'Secret', fieldKey: 'a' }]],
    });

    expect(result?.cells).toEqual([[{ type: 'hidden', label: 'Secret', fieldKey: 'a' }]]);
  });

  it('falls back to numeric/enum defaults for a malformed grid config', () => {
    const result = sanitizeLayoutOptions({ rows: 'many', cells: 'nope' });

    expect(result).toMatchObject({
      rows: 2,
      columns: 2,
      mode: 'grid',
      cells: [],
    });
  });

  it('returns null for a non-object value', () => {
    expect(sanitizeLayoutOptions(null)).toBeNull();
    expect(sanitizeLayoutOptions('x')).toBeNull();
  });
});

describe('findPubliclyUnsafeTypes — layout cell scanning', () => {
  // Every palette type is publishable now, so the cell scan is exercised with an unrecognised
  // type — the whitelist still rejects anything it has never assessed.
  it('flags an unrecognised type nested in a layout cell', () => {
    const unsafe = findPubliclyUnsafeTypes([
      {
        field_type: 'layout',
        options: { cells: [[{ type: 'not_a_real_type' }]] },
      },
    ]);

    expect(unsafe).toEqual(['not_a_real_type']);
  });

  it('does not flag a hidden cell — hidden is publishable by owner decision', () => {
    const unsafe = findPubliclyUnsafeTypes([
      {
        field_type: 'layout',
        options: { cells: [[{ type: 'hidden' }]] },
      },
    ]);

    expect(unsafe).toEqual([]);
  });

  it('does not flag a layout whose cells are all publicly safe', () => {
    const unsafe = findPubliclyUnsafeTypes([
      {
        field_type: 'layout',
        options: { cells: [[{ type: 'short_text' }, { type: 'email' }]] },
      },
    ]);

    expect(unsafe).toEqual([]);
  });

  it('allows products nested in a cell with no payment context', () => {
    const unsafe = findPubliclyUnsafeTypes([
      { field_type: 'layout', options: { cells: [[{ type: 'products' }]] } },
    ]);

    expect(unsafe).toEqual([]);
  });
});

describe('findPubliclyUnsafeTypes — user_select', () => {
  it('allows a custom-source user_select', () => {
    const unsafe = findPubliclyUnsafeTypes([
      {
        field_type: 'user_select',
        validation_rules: { userSource: 'custom' },
      },
    ]);

    expect(unsafe).toEqual([]);
  });

  // Was blocked because space/organization sources resolve the member directory. Allowed now by
  // owner decision; isCustomUserSelect is still covered below because other call sites use it.
  it('allows a space-source user_select', () => {
    const unsafe = findPubliclyUnsafeTypes([
      { field_type: 'user_select', validation_rules: { userSource: 'space' } },
    ]);

    expect(unsafe).toEqual([]);
  });
});

describe('isCustomUserSelect', () => {
  it('is true only when userSource is exactly "custom"', () => {
    expect(
      isCustomUserSelect({ validation_rules: { userSource: 'custom' } }),
    ).toBe(true);
    expect(
      isCustomUserSelect({ validation_rules: { userSource: 'space' } }),
    ).toBe(false);
    expect(isCustomUserSelect({ validation_rules: null })).toBe(false);
    expect(isCustomUserSelect({})).toBe(false);
  });
});
