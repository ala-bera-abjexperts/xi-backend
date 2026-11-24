/**
 * Shared parity vectors for the Form Builder logic engines. The frontend mirror
 * lives at `src/lib/form-builder/__fixtures__/logic-vectors.ts` with byte-identical
 * DATA. Both the Jest (BE) and Vitest (FE) specs run these through their own engine
 * copies — same inputs, same expected outputs => parity.
 */

export interface ExprVector {
  expr: string;
  values: Record<string, unknown>;
  expected: number;
}

// arithmetic, precedence, functions, coercion, div0
export const EXPR_VECTORS: ExprVector[] = [
  { expr: '{a}+{b}', values: { a: 2, b: 3 }, expected: 5 },
  { expr: '{a}-{b}', values: { a: 2, b: 3 }, expected: -1 },
  { expr: '{a}*{b}', values: { a: 2, b: 3 }, expected: 6 },
  { expr: '{a}/{b}', values: { a: 6, b: 3 }, expected: 2 },
  { expr: '{a}-{b}*{c}', values: { a: 10, b: 2, c: 3 }, expected: 4 },
  { expr: '({a}+{b})*{c}', values: { a: 1, b: 2, c: 3 }, expected: 9 },
  { expr: '-{a}', values: { a: 5 }, expected: -5 },
  { expr: '-{a}+{b}', values: { a: 5, b: 8 }, expected: 3 },
  { expr: 'min({a},{b},{c})', values: { a: 3, b: 1, c: 2 }, expected: 1 },
  { expr: 'max({a},{b})', values: { a: 3, b: 7 }, expected: 7 },
  { expr: 'round({a})', values: { a: 2.6 }, expected: 3 },
  { expr: 'abs({a})', values: { a: -4 }, expected: 4 },
  { expr: 'sum({a},{b},{c})', values: { a: 1, b: 2, c: 3 }, expected: 6 },
  {
    expr: 'sum({a},{b})*round({c})',
    values: { a: 1, b: 2, c: 1.4 },
    expected: 3,
  },
  { expr: '{a}+{missing}', values: { a: 5 }, expected: 5 },
  { expr: '{a}', values: { a: '7' }, expected: 7 },
  { expr: '{a}', values: { a: true }, expected: 1 },
  { expr: '{a}', values: { a: 'abc' }, expected: 0 },
  { expr: '{a}*2', values: { a: '' }, expected: 0 },
  { expr: '10/{a}', values: { a: 0 }, expected: 0 },
  { expr: '{a}/{b}', values: { a: 5, b: 0 }, expected: 0 },
];

// each of these must throw ExpressionError at compile time
export const THROWING_EXPRESSIONS: string[] = [
  '',
  '   ',
  '{a}+',
  'foo({a})',
  '{a b}',
  '{a',
  '1 2',
  '()',
];

export interface OpVector {
  value: unknown;
  operator: string;
  target: unknown;
  expected: boolean;
}

// operator coercion table — the single most parity-critical surface
export const OP_VECTORS: OpVector[] = [
  { value: 5, operator: 'eq', target: 5, expected: true },
  { value: 5, operator: 'eq', target: '5', expected: true },
  { value: 'abc', operator: 'eq', target: 'abc', expected: true },
  { value: 'abc', operator: 'eq', target: 'abd', expected: false },
  { value: 'abc', operator: 'neq', target: 'abd', expected: true },
  { value: true, operator: 'eq', target: true, expected: true },
  { value: 'hello', operator: 'contains', target: 'ell', expected: true },
  { value: ['a', 'b'], operator: 'contains', target: 'b', expected: true },
  { value: ['a', 'b'], operator: 'contains', target: 'z', expected: false },
  { value: 'hello', operator: 'beginsWith', target: 'he', expected: true },
  { value: 'hello', operator: 'endsWith', target: 'lo', expected: true },
  { value: 5, operator: 'gt', target: 3, expected: true },
  { value: 3, operator: 'gt', target: 5, expected: false },
  { value: 'x', operator: 'gt', target: 3, expected: false },
  { value: 5, operator: 'gte', target: 5, expected: true },
  { value: 3, operator: 'lt', target: 5, expected: true },
  { value: 5, operator: 'lte', target: 5, expected: true },
  { value: 5, operator: 'between', target: [1, 10], expected: true },
  { value: 15, operator: 'between', target: [1, 10], expected: false },
  { value: 15, operator: 'notBetween', target: [1, 10], expected: true },
  { value: 'b', operator: 'in', target: ['a', 'b', 'c'], expected: true },
  { value: 'd', operator: 'in', target: ['a', 'b'], expected: false },
  { value: 'd', operator: 'notIn', target: ['a', 'b'], expected: true },
  { value: '', operator: 'isEmpty', target: null, expected: true },
  { value: [], operator: 'isEmpty', target: null, expected: true },
  { value: 'x', operator: 'isEmpty', target: null, expected: false },
  { value: 'x', operator: 'isNotEmpty', target: null, expected: true },
  { value: null, operator: 'null', target: null, expected: true },
  { value: 'x', operator: 'weird_unknown_op', target: 'y', expected: false },
];

export interface GroupVector {
  // IFilterRuleGroup-shaped, kept as `any` so fixtures stay import-free
  group: any;
  values: Record<string, unknown>;
  expected: boolean;
}

export const GROUP_VECTORS: GroupVector[] = [
  {
    group: {
      combinator: 'and',
      rules: [
        { field: 'a', operator: 'eq', value: 1 },
        { field: 'b', operator: 'eq', value: 2 },
      ],
    },
    values: { a: 1, b: 2 },
    expected: true,
  },
  {
    group: {
      combinator: 'and',
      rules: [
        { field: 'a', operator: 'eq', value: 1 },
        { field: 'b', operator: 'eq', value: 2 },
      ],
    },
    values: { a: 1, b: 3 },
    expected: false,
  },
  {
    group: {
      combinator: 'or',
      rules: [
        { field: 'a', operator: 'eq', value: 1 },
        { field: 'b', operator: 'eq', value: 2 },
      ],
    },
    values: { a: 9, b: 2 },
    expected: true,
  },
  {
    group: {
      combinator: 'and',
      not: true,
      rules: [{ field: 'a', operator: 'eq', value: 1 }],
    },
    values: { a: 1 },
    expected: false,
  },
  {
    group: {
      combinator: 'and',
      rules: [
        { field: 'a', operator: 'gt', value: 0 },
        {
          combinator: 'or',
          rules: [
            { field: 'b', operator: 'eq', value: 'x' },
            { field: 'b', operator: 'eq', value: 'y' },
          ],
        },
      ],
    },
    values: { a: 5, b: 'y' },
    expected: true,
  },
  { group: { combinator: 'and', rules: [] }, values: {}, expected: true },
];

export interface CalcVector {
  calcs: { fieldKey: string; refs: string[] }[];
  // for each pair [X, Y], X must appear before Y in the topo order
  before?: [string, string][];
  cycle?: boolean;
}

export const CALC_VECTORS: CalcVector[] = [
  {
    calcs: [
      { fieldKey: 'total', refs: ['sub', 'tax'] },
      { fieldKey: 'sub', refs: ['price', 'qty'] },
      { fieldKey: 'tax', refs: ['sub'] },
    ],
    before: [
      ['sub', 'total'],
      ['tax', 'total'],
      ['sub', 'tax'],
    ],
  },
  { calcs: [{ fieldKey: 'a', refs: ['x', 'y'] }], before: [] },
  {
    calcs: [
      { fieldKey: 'a', refs: ['b'] },
      { fieldKey: 'b', refs: ['a'] },
    ],
    cycle: true,
  },
  { calcs: [{ fieldKey: 'a', refs: ['a'] }], cycle: true },
];
