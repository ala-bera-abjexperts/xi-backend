import { BadRequestException } from '@nestjs/common';

import {
  assertValidFilterGroup,
  buildAssetFilterFields,
  parseFilterParam,
} from './asset-filter-fields';

import { buildFilterFragments, ruleToFragment } from './asset-rule-translator';

const ATTRS = [
  { field_key: 'cpu', data_type: 'integer' },
  { field_key: 'ratio', data_type: 'float' },
  { field_key: 'env', data_type: 'text' },
  { field_key: 'active', data_type: 'bool' },
  { field_key: 'purchased', data_type: 'date' },
  { field_key: 'tags', data_type: 'multiselect' },
  // Excluded — not filterable in SQL.
  { field_key: 'owner_ref', data_type: 'object_reference' },
  { field_key: 'total', data_type: 'formula' },
  { field_key: 'divider', data_type: 'tab_separator' },
];

const FIELDS = buildAssetFilterFields(ATTRS);

const frag = (field: string, operator: string, value?: unknown) =>
  ruleToFragment({ field, operator, value }, FIELDS);

describe('buildAssetFilterFields', () => {
  it('exposes base columns', () => {
    expect(FIELDS.get('name')?.column).toBe('name');
    expect(FIELDS.get('object_key')?.kind).toBe('column_text');
  });

  it('maps attribute data types to storage kinds', () => {
    expect(FIELDS.get('attr_cpu')?.kind).toBe('attr_number');
    expect(FIELDS.get('attr_ratio')?.kind).toBe('attr_number');
    expect(FIELDS.get('attr_env')?.kind).toBe('attr_text');
    expect(FIELDS.get('attr_active')?.kind).toBe('attr_bool');
    expect(FIELDS.get('attr_purchased')?.kind).toBe('attr_date');
    expect(FIELDS.get('attr_tags')?.kind).toBe('attr_array');
  });

  it('exposes reference and formula fields with non-SQL kinds', () => {
    // These ARE filterable, just not by a plain SQL fragment:
    //   reference → !inner embed on asset_object_references
    //   formula   → bounded in-memory evaluation (jexl, never persisted)
    // `buildFilterPlan` routes them away from the fragment path.
    expect(FIELDS.get('attr_owner_ref')?.kind).toBe('attr_reference');
    expect(FIELDS.get('attr_total')?.kind).toBe('attr_formula');
  });

  it('still excludes tab_separator, which holds no value at all', () => {
    expect(FIELDS.has('attr_divider')).toBe(false);
  });

  it('ignores field_keys that do not match the allowed pattern', () => {
    const m = buildAssetFilterFields([
      { field_key: 'Bad Key;drop', data_type: 'text' },
    ]);

    expect(m.has('attr_Bad Key;drop')).toBe(false);
  });
});

describe('encoding rules', () => {
  it('NEVER emits a :: cast in any fragment', () => {
    // PostgREST silently DISCARDS casts on the filter LHS, so a cast would
    // produce wrong rows with no error. This guards the whole operator surface.
    const all = [
      frag('attr_cpu', 'gt', 9),
      frag('attr_cpu', 'between', [1, 5]),
      frag('attr_env', 'contains', 'prod'),
      frag('attr_purchased', 'lte', '2024-06-01'),
      frag('attr_active', 'eq', true),
      frag('attr_tags', 'contains', 'x'),
      frag('attr_env', 'isEmpty'),
      frag('attr_cpu', 'isNotEmpty'),
      frag('name', 'in', ['a', 'b']),
    ];

    for (const f of all) expect(f).not.toContain('::');
  });

  it('uses -> (jsonb) for numbers so comparison is numeric, not lexicographic', () => {
    // The bug this prevents: as text, "10" < "9", so `cpu > 9` would drop 10.
    expect(frag('attr_cpu', 'gt', 9)).toBe('attribute_values->cpu.gt.9');
  });

  it('uses ->> (text) for strings and dates', () => {
    expect(frag('attr_env', 'eq', 'prod')).toBe(
      'attribute_values->>env.eq.prod',
    );
    expect(frag('attr_purchased', 'gte', '2024-01-01')).toBe(
      'attribute_values->>purchased.gte.2024-01-01',
    );
  });

  it('uses eq for booleans, never is', () => {
    // `is.true` errors: "argument of IS TRUE must be type boolean, not jsonb".
    const f = frag('attr_active', 'eq', true);

    expect(f).toBe('attribute_values->active.eq.true');
    expect(f).not.toContain('is.');
  });

  it('uses containment for multi-value attributes', () => {
    expect(frag('attr_tags', 'contains', 'x')).toBe(
      'attribute_values->tags.cs.["x"]',
    );
  });
});

describe('operators', () => {
  it('builds ilike patterns for the string operators', () => {
    expect(frag('name', 'contains', 'srv')).toBe('name.ilike.%srv%');
    expect(frag('name', 'beginsWith', 'srv')).toBe('name.ilike.srv%');
    expect(frag('name', 'endsWith', 'srv')).toBe('name.ilike.%srv');
  });

  it('places `not` AFTER the operand for column-level negation', () => {
    // A leading `not.` is only valid before a nested and()/or() group. Inside a
    // logic tree `not.name.ilike.%x%` is a 400: "unexpected \"n\" expecting
    // logic operator (and, or)". Verified against live PostgREST.
    expect(frag('name', 'notContains', 'srv')).toBe('name.not.ilike.%srv%');
    expect(frag('name', 'neq', 'x')).toBe('name.not.eq.x');
    expect(frag('name', 'notIn', ['a', 'b'])).toBe('name.not.in.(a,b)');
    expect(frag('attr_active', 'neq', true)).toBe(
      'attribute_values->active.not.eq.true',
    );
    expect(frag('attr_tags', 'notContains', 'x')).toBe(
      'attribute_values->tags.not.cs.["x"]',
    );

    for (const f of [
      frag('name', 'notContains', 'srv'),
      frag('name', 'neq', 'x'),
      frag('name', 'notIn', ['a']),
    ]) {
      expect(f.startsWith('not.')).toBe(false);
    }
  });

  it('keeps the leading not. form for group negation, where it IS valid', () => {
    expect(frag('attr_cpu', 'notBetween', [2, 8])).toBe(
      'not.and(attribute_values->cpu.gte.2,attribute_values->cpu.lte.8)',
    );
  });

  it('escapes LIKE wildcards in user input', () => {
    // A user searching for "50%" must not get "50 followed by anything".
    //
    // Escaping is deliberately TWO layers:
    //   1. LIKE layer   — `%` becomes `\%` so SQL treats it as a literal.
    //   2. PostgREST    — the value now contains `\`, so it is double-quoted
    //                     and the backslash doubled.
    // PostgREST unescapes `\\` to `\` inside quotes, so ILIKE finally receives
    // the pattern `%50\%%` = anything + a literal `%` + anything.
    expect(frag('name', 'contains', '50%')).toBe('name.ilike."%50\\\\%%"');
    expect(frag('name', 'contains', 'a_b')).toBe('name.ilike."%a\\\\_b%"');
  });

  it('quotes values containing PostgREST metacharacters', () => {
    // An unquoted comma would split the or() list and corrupt the query.
    expect(frag('name', 'eq', 'a,b')).toBe('name.eq."a,b"');
    expect(frag('name', 'eq', 'a.b')).toBe('name.eq."a.b"');
    expect(frag('name', 'eq', 'say "hi"')).toBe('name.eq."say \\"hi\\""');
  });

  it('expands between into a bounded and-group', () => {
    expect(frag('attr_cpu', 'between', [2, 8])).toBe(
      'and(attribute_values->cpu.gte.2,attribute_values->cpu.lte.8)',
    );
  });

  it('treats a missing key, null and empty string as empty for text', () => {
    expect(frag('attr_env', 'isEmpty')).toBe(
      'or(attribute_values->>env.is.null,attribute_values->>env.eq.)',
    );
    expect(frag('attr_env', 'isNotEmpty')).toBe(
      'and(attribute_values->>env.not.is.null,attribute_values->>env.neq.)',
    );
  });

  it('uses a plain null check for non-text fields', () => {
    expect(frag('attr_cpu', 'isEmpty')).toBe('attribute_values->cpu.is.null');
  });

  it('accepts in as an array or a csv string', () => {
    expect(frag('name', 'in', ['a', 'b'])).toBe('name.in.(a,b)');
    expect(frag('name', 'in', 'a,b')).toBe('name.in.(a,b)');
  });
});

describe('validation', () => {
  it('rejects an unknown field loudly rather than returning zero rows', () => {
    expect(() => frag('attr_nope', 'eq', 1)).toThrow(BadRequestException);
  });

  it('rejects an unknown operator', () => {
    expect(() => frag('name', 'sqlInject', 1)).toThrow(BadRequestException);
  });

  it('rejects non-numeric values for numeric fields', () => {
    expect(() => frag('attr_cpu', 'gt', 'abc')).toThrow(BadRequestException);
  });

  it('rejects string operators on numeric fields', () => {
    expect(() => frag('attr_cpu', 'contains', '1')).toThrow(
      BadRequestException,
    );
  });

  it('rejects unsupported operators on boolean and array fields', () => {
    expect(() => frag('attr_active', 'gt', true)).toThrow(BadRequestException);
    expect(() => frag('attr_tags', 'gt', 'x')).toThrow(BadRequestException);
  });

  it('rejects a malformed between payload', () => {
    expect(() => frag('attr_cpu', 'between', [1])).toThrow(BadRequestException);
    expect(() => frag('attr_cpu', 'between', 5)).toThrow(BadRequestException);
  });

  it('rejects an empty in list rather than emitting invalid SQL', () => {
    // `in.()` is a syntax error, not an empty result.
    expect(() => frag('name', 'in', [])).toThrow(BadRequestException);
  });

  it('rejects over-long values', () => {
    expect(() => frag('name', 'eq', 'x'.repeat(1001))).toThrow(
      BadRequestException,
    );
  });

  it('rejects nested groups', () => {
    expect(() =>
      assertValidFilterGroup({
        combinator: 'and',
        rules: [{ combinator: 'or', rules: [] }],
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects a not-group', () => {
    expect(() =>
      assertValidFilterGroup({ combinator: 'and', rules: [], not: true }),
    ).toThrow(BadRequestException);
  });

  it('rejects a bad combinator and malformed rules', () => {
    expect(() =>
      assertValidFilterGroup({ combinator: 'xor', rules: [] }),
    ).toThrow(BadRequestException);
    expect(() =>
      assertValidFilterGroup({ combinator: 'and', rules: [{ field: 'name' }] }),
    ).toThrow(BadRequestException);
  });

  it('caps the number of rules', () => {
    const rules = Array.from({ length: 51 }, () => ({
      field: 'name',
      operator: 'eq',
      value: 'x',
    }));

    expect(() => assertValidFilterGroup({ combinator: 'and', rules })).toThrow(
      BadRequestException,
    );
  });
});

describe('buildFilterFragments', () => {
  const group = (combinator: 'and' | 'or') => ({
    combinator,
    rules: [
      { field: 'attr_cpu', operator: 'gt', value: 8 },
      { field: 'attr_env', operator: 'eq', value: 'prod' },
    ],
  });

  it('emits one fragment per rule for AND', () => {
    // Chained single-element or() calls combine as AND.
    expect(buildFilterFragments(group('and'), FIELDS)).toEqual([
      'attribute_values->cpu.gt.8',
      'attribute_values->>env.eq.prod',
    ]);
  });

  it('emits one combined fragment for OR', () => {
    expect(buildFilterFragments(group('or'), FIELDS)).toEqual([
      'attribute_values->cpu.gt.8,attribute_values->>env.eq.prod',
    ]);
  });

  it('rejects an oversized filter with 400 instead of letting it 414', () => {
    // MEASURED: the stack answers 414 "URI too long" past ~8 KB. Guarding by
    // rule COUNT alone is not enough — these 20 rules are under the 50-rule cap
    // and every value is under the 1000-char cap, yet together they blow the URL.
    const rules = Array.from({ length: 20 }, () => ({
      field: 'name',
      operator: 'eq',
      value: 'x'.repeat(900),
    }));

    expect(() =>
      buildFilterFragments({ combinator: 'and', rules }, FIELDS),
    ).toThrow(BadRequestException);
  });

  it('rejects an oversized OR group too (single joined fragment)', () => {
    const rules = Array.from({ length: 20 }, () => ({
      field: 'name',
      operator: 'eq',
      value: 'y'.repeat(900),
    }));

    expect(() =>
      buildFilterFragments({ combinator: 'or', rules }, FIELDS),
    ).toThrow(BadRequestException);
  });

  it('measures the budget AFTER url-encoding, not raw length', () => {
    // Spaces and unicode inflate under percent-encoding (a space is %20, so 3x).
    // A raw-length check would wave this through and then 414 at runtime.
    const rules = Array.from({ length: 12 }, () => ({
      field: 'name',
      operator: 'eq',
      value: 'ä '.repeat(300),
    }));

    expect(() =>
      buildFilterFragments({ combinator: 'and', rules }, FIELDS),
    ).toThrow(BadRequestException);
  });

  it('allows a realistic filter well within budget', () => {
    const rules = Array.from({ length: 8 }, () => ({
      field: 'name',
      operator: 'contains',
      value: 'server-01',
    }));

    expect(() =>
      buildFilterFragments({ combinator: 'and', rules }, FIELDS),
    ).not.toThrow();
  });

  it('treats an empty or absent group as no filter, never match-nothing', () => {
    expect(buildFilterFragments(null, FIELDS)).toEqual([]);
    expect(buildFilterFragments(undefined, FIELDS)).toEqual([]);
    expect(
      buildFilterFragments({ combinator: 'and', rules: [] }, FIELDS),
    ).toEqual([]);
  });
});

describe('parseFilterParam', () => {
  it('returns null for absent, blank or empty-rule filters', () => {
    expect(parseFilterParam(undefined)).toBeNull();
    expect(parseFilterParam('   ')).toBeNull();
    expect(parseFilterParam('{"combinator":"and","rules":[]}')).toBeNull();
  });

  it('rejects invalid JSON', () => {
    expect(() => parseFilterParam('{nope')).toThrow(BadRequestException);
  });

  it('parses a valid group', () => {
    const parsed = parseFilterParam(
      '{"combinator":"or","rules":[{"field":"name","operator":"eq","value":"x"}]}',
    );

    expect(parsed?.combinator).toBe('or');
    expect(parsed?.rules).toHaveLength(1);
  });
});
