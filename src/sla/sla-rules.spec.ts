import { evaluateRules, validateRules } from './sla-rules';
import { SlaFieldMetadata } from './sla.types';
const fields: SlaFieldMetadata[] = [
  { id: 'status_id', type: 'string' },
  { id: 'priority', type: 'number' },
  { id: 'cf_example', type: 'string[]' },
  { id: 'cf_sla', type: 'number', sla: true },
];
const rule = (
  field = 'status_id',
  operator = '=',
  value: unknown = 'open',
) => ({ field, operator, value });
describe('SLA deterministic rules', () => {
  it('evaluates nested AND OR NOT and explicit catch-all', () => {
    const rules = {
      combinator: 'and',
      rules: [
        rule(),
        {
          combinator: 'or',
          not: true,
          rules: [
            rule('priority', '>', 4),
            rule('cf_example', 'contains', 'blocked'),
          ],
        },
      ],
    };
    expect(
      evaluateRules(
        rules,
        { status_id: 'open', priority: 2, cf_example: ['ready'] },
        fields,
      ),
    ).toBe(true);
    expect(
      evaluateRules(
        rules,
        { status_id: 'open', priority: 6, cf_example: [] },
        fields,
      ),
    ).toBe(false);
    expect(evaluateRules({ combinator: 'and', rules: [] }, {}, fields)).toBe(
      true,
    );
  });
  it.each([
    rule('current_user'),
    rule('history'),
    rule('sla_status'),
    rule('cf_sla'),
    rule('priority', 'relative', 2),
    rule('priority', '>', 'tomorrow'),
    rule('status_id', 'in', 'open'),
    rule('status_id', '=', 'current_user'),
  ])('rejects unsupported predicates %j', (leaf) => {
    expect(() =>
      validateRules({ combinator: 'and', rules: [leaf] }, fields),
    ).toThrow();
  });
  it('fails closed for absent values and validates complete groups before matching', () => {
    expect(
      evaluateRules(
        { combinator: 'and', rules: [rule('status_id', '!=', 'closed')] },
        {},
        fields,
      ),
    ).toBe(false);
    expect(() =>
      evaluateRules(
        { combinator: 'or', rules: [rule(), rule('invalid')] },
        { status_id: 'open' },
        fields,
      ),
    ).toThrow();
    expect(() =>
      validateRules({ combinator: 'xor', rules: [] }, fields),
    ).toThrow();
  });
});

describe('SLA typed operator semantics', () => {
  const metadata: SlaFieldMetadata[] = [
    ...fields,
    { id: 'due_date', type: 'date' },
    { id: 'is_completed', type: 'boolean' },
  ];
  it.each([
    ['status_id', '=', 'open', 'open', true],
    ['status_id', '!=', 'closed', 'open', true],
    ['priority', '<', 3, 2, true],
    ['priority', '<=', 2, 2, true],
    ['priority', '>=', 2, 2, true],
    ['priority', 'in', [1, 2], 2, true],
    ['priority', 'notIn', [1, 2], 3, true],
    ['cf_example', 'in', ['a'], ['a', 'b'], true],
    ['cf_example', 'notIn', ['c'], ['a', 'b'], true],
    ['cf_example', '=', ['a', 'b'], ['b', 'a'], true],
    ['cf_example', '=', ['a', 'b'], ['a', 'a'], false],
    ['status_id', 'contains', 'pen', 'open', true],
    ['status_id', 'doesNotContain', 'x', 'open', true],
    ['status_id', 'beginsWith', 'op', 'open', true],
    ['status_id', 'endsWith', 'en', 'open', true],
    ['status_id', 'null', undefined, null, true],
    ['status_id', 'notNull', undefined, 'open', true],
    [
      'due_date',
      '=',
      '2026-09-01T01:00:00+01:00',
      '2026-09-01T00:00:00Z',
      true,
    ],
    ['due_date', 'in', ['2026-09-01'], '2026-09-01T00:00:00Z', true],
    ['due_date', 'notIn', ['2026-09-02'], '2026-09-01T00:00:00Z', true],
    ['is_completed', '=', true, true, true],
  ])(
    '%s %s uses typed literals',
    (field, operator, expected, actual, result) => {
      expect(
        evaluateRules(
          {
            combinator: 'and',
            rules: [rule(field as string, operator as string, expected)],
          },
          { [field as string]: actual },
          metadata,
        ),
      ).toBe(result);
    },
  );
  it('rejects impossible absolute dates', () => {
    expect(() =>
      validateRules(
        { combinator: 'and', rules: [rule('due_date', '=', '2026-02-30')] },
        metadata,
      ),
    ).toThrow();
  });
  it('bounds trees and rejects references and malformed values', () => {
    for (const value of [
      null,
      [],
      { combinator: 'and', not: 'true', rules: [] },
      { combinator: 'and', rules: [null] },
      { combinator: 'and', rules: [{ field: 2, operator: '=' }] },
      { combinator: 'and', rules: [{ ...rule(), valueSource: 'field' }] },
    ])
      expect(() => validateRules(value, metadata)).toThrow();
    expect(() =>
      validateRules(
        { combinator: 'and', rules: Array.from({ length: 101 }, () => rule()) },
        metadata,
      ),
    ).toThrow();
    let deep: unknown = { combinator: 'and', rules: [] };
    for (let i = 0; i < 14; i++) deep = { combinator: 'and', rules: [deep] };
    expect(() => validateRules(deep, metadata)).toThrow();
    expect(evaluateRules({ combinator: 'or', rules: [] }, {}, metadata)).toBe(
      false,
    );
  });
});

describe('SLA rejects uncaptured membership predicates', () => {
  it.each(['board_id', 'sprint_id'])(
    'rejects stored %s metadata instead of matching missing values',
    (id) => {
      const legacyMetadata: SlaFieldMetadata[] = [{ id, type: 'string' }];
      const rules = { combinator: 'and', rules: [rule(id, 'null')] };
      expect(() => validateRules(rules, legacyMetadata)).toThrow(
        `Unsupported SLA condition field: ${id}`,
      );
      expect(() => evaluateRules(rules, {}, legacyMetadata)).toThrow(
        `Unsupported SLA condition field: ${id}`,
      );
    },
  );
});
