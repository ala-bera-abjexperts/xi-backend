import {
  compileExpression,
  extractRefs,
  ExpressionError,
} from './expression-engine';
import { topoSortCalcs, CalcCycleError } from './calc-graph';
import {
  evaluateRuleGroup,
  computeFieldStates,
  LogicField,
} from './condition-evaluator';
import {
  EXPR_VECTORS,
  THROWING_EXPRESSIONS,
  OP_VECTORS,
  GROUP_VECTORS,
  CALC_VECTORS,
} from './__fixtures__/logic-vectors';

describe('expression-engine', () => {
  for (const v of EXPR_VECTORS) {
    it(`evaluates ${v.expr} = ${v.expected}`, () => {
      expect(compileExpression(v.expr)(v.values)).toBe(v.expected);
    });
  }

  for (const src of THROWING_EXPRESSIONS) {
    it(`rejects ${JSON.stringify(src)}`, () => {
      expect(() => compileExpression(src)).toThrow(ExpressionError);
    });
  }

  it('extracts unique refs in order', () => {
    expect(extractRefs('{a}+{b}*{a}-{c}')).toEqual(['a', 'b', 'c']);
  });

  it('rejects expressions over the length bound', () => {
    expect(() => compileExpression('1'.repeat(1001))).toThrow(ExpressionError);
  });
});

describe('condition-evaluator operators', () => {
  for (const v of OP_VECTORS) {
    it(`${JSON.stringify(v.value)} ${v.operator} ${JSON.stringify(
      v.target,
    )} => ${v.expected}`, () => {
      const group = {
        combinator: 'and' as const,
        rules: [{ field: 'x', operator: v.operator, value: v.target }],
      };

      expect(evaluateRuleGroup(group, { x: v.value })).toBe(v.expected);
    });
  }
});

describe('condition-evaluator rule groups', () => {
  GROUP_VECTORS.forEach((v, i) => {
    it(`group #${i} => ${v.expected}`, () => {
      expect(evaluateRuleGroup(v.group, v.values)).toBe(v.expected);
    });
  });
});

describe('calc-graph', () => {
  CALC_VECTORS.forEach((v, i) => {
    it(`vector #${i}`, () => {
      if (v.cycle) {
        expect(() => topoSortCalcs(v.calcs)).toThrow(CalcCycleError);

        return;
      }

      const order = topoSortCalcs(v.calcs);

      expect(order.length).toBe(v.calcs.length);

      for (const [before, after] of v.before ?? []) {
        expect(order.indexOf(before)).toBeLessThan(order.indexOf(after));
      }
    });
  });
});

function field(
  partial: Partial<LogicField> & { field_key: string; field_type: string },
): LogicField {
  return {
    required: false,
    is_hidden: false,
    read_only: false,
    ...partial,
  };
}

describe('computeFieldStates precedence', () => {
  it('show action reveals only when condition met', () => {
    const f = field({
      field_key: 'extra',
      field_type: 'short_text',
      conditional_logic: {
        action: 'show',
        ruleGroup: {
          combinator: 'and',
          rules: [{ field: 'q', operator: 'eq', value: 'yes' }],
        },
      },
    });

    expect(computeFieldStates([f], { q: 'yes' }).extra.visible).toBe(true);
    expect(computeFieldStates([f], { q: 'no' }).extra.visible).toBe(false);
  });

  it('static is_hidden always wins over a show action', () => {
    const f = field({
      field_key: 'extra',
      field_type: 'short_text',
      is_hidden: true,
      conditional_logic: {
        action: 'show',
        ruleGroup: {
          combinator: 'and',
          rules: [{ field: 'q', operator: 'eq', value: 'yes' }],
        },
      },
    });

    expect(computeFieldStates([f], { q: 'yes' }).extra.visible).toBe(false);
  });

  it('conditional require applies only while visible', () => {
    const f = field({
      field_key: 'extra',
      field_type: 'short_text',
      conditional_logic: {
        action: 'require',
        ruleGroup: {
          combinator: 'and',
          rules: [{ field: 'q', operator: 'eq', value: 'yes' }],
        },
      },
    });

    expect(computeFieldStates([f], { q: 'yes' }).extra.required).toBe(true);
    expect(computeFieldStates([f], { q: 'no' }).extra.required).toBe(false);
  });

  it('never requires a hidden field', () => {
    const f = field({
      field_key: 'x',
      field_type: 'short_text',
      required: true,
      is_hidden: true,
    });

    expect(computeFieldStates([f], {}).x.required).toBe(false);
  });
});
