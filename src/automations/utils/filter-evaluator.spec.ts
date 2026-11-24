/**
 * @fileoverview Unit tests for FilterEvaluator's "Linked to" branch (XE-T532)
 * and a regression guard that scalar in/notIn/eq evaluation is unchanged.
 *
 * @module src/automations/utils/filter-evaluator.spec
 * @author Prince Jadiya
 */

import {
  FilterEvaluator,
  hasRuleForField,
  type IFilterRuleGroup,
} from './filter-evaluator';

const rule = (field: string, operator: string, value: unknown) =>
  ({
    combinator: 'and',
    rules: [{ field, operator, value }],
  }) as IFilterRuleGroup;

const evalTask = (group: IFilterRuleGroup, data: Record<string, unknown>) =>
  new FilterEvaluator('task').evaluate(group, data);

describe('FilterEvaluator linked_to', () => {
  const data = { linked_to: ['t11-uuid', 'XSD-T11'] };

  it('matches on intersection for in, inverts for notIn', () => {
    expect(evalTask(rule('linked_to', 'in', 'XSD-T11'), data)).toBe(true);
    expect(evalTask(rule('linked_to', 'in', 'XSD-T99'), data)).toBe(false);
    expect(evalTask(rule('linked_to', 'notIn', 'XSD-T11'), data)).toBe(false);
    expect(evalTask(rule('linked_to', 'notIn', 'XSD-T99'), data)).toBe(true);
  });

  it('accepts comma string, array and {keys} values', () => {
    expect(evalTask(rule('linked_to', 'in', 'XSD-T1, XSD-T11'), data)).toBe(
      true,
    );
    expect(evalTask(rule('linked_to', 'in', ['XSD-T11']), data)).toBe(true);
    expect(
      evalTask(
        rule('linked_to', 'in', { keys: ['XSD-T11'], recursive: true }),
        data,
      ),
    ).toBe(true);
  });

  it('is case-insensitive on both sides', () => {
    expect(evalTask(rule('linked_to', 'in', 'xsd-t11'), data)).toBe(true);
    expect(evalTask(rule('linked_to', 'in', 'T11-UUID'), data)).toBe(true);
  });

  it('treats missing data as no links: in false, notIn true', () => {
    expect(evalTask(rule('linked_to', 'in', 'XSD-T11'), {})).toBe(false);
    expect(evalTask(rule('linked_to', 'notIn', 'XSD-T11'), {})).toBe(true);
  });

  it('maps neq like notIn and eq like in', () => {
    expect(evalTask(rule('linked_to', 'neq', 'XSD-T11'), data)).toBe(false);
    expect(evalTask(rule('linked_to', 'eq', 'XSD-T11'), data)).toBe(true);
  });

  it('regression: scalar in/notIn/eq on other fields are unchanged', () => {
    const task = { status: 'open' };
    expect(evalTask(rule('status', 'in', 'open,closed'), task)).toBe(true);
    expect(evalTask(rule('status', 'notIn', 'open'), task)).toBe(false);
    expect(evalTask(rule('status', 'eq', 'open'), task)).toBe(true);
    // eq stays case-sensitive for scalar fields.
    expect(evalTask(rule('status', 'eq', 'OPEN'), task)).toBe(false);
    expect(evalTask(rule('status', 'in', 'OPEN'), task)).toBe(false);
  });
});

describe('hasRuleForField', () => {
  it('finds a rule nested in an OR group', () => {
    const group = {
      combinator: 'and',
      rules: [
        { field: 'status', operator: 'eq', value: 'open' },
        {
          combinator: 'or',
          rules: [{ field: 'linked_to', operator: 'in', value: 'XSD-T11' }],
        },
      ],
    } as IFilterRuleGroup;

    expect(hasRuleForField(group, 'linked_to')).toBe(true);
    expect(hasRuleForField(group, 'parent')).toBe(false);
  });

  it('skips null / non-object rule entries instead of throwing', () => {
    const group = {
      combinator: 'and',
      rules: [null, 'junk', { field: 'linked_to', operator: 'in', value: 'A' }],
    } as unknown as IFilterRuleGroup;

    expect(hasRuleForField(group, 'linked_to')).toBe(true);
    expect(hasRuleForField(group, 'parent')).toBe(false);
  });

  it('returns false for a malformed group', () => {
    expect(hasRuleForField({} as IFilterRuleGroup, 'linked_to')).toBe(false);
  });

  it.each([['junk'], [{ field: 'linked_to' }], [42]])(
    'returns false, without throwing, when rules is not an array (%p)',
    (rules) => {
      const group = { combinator: 'and', rules } as unknown as IFilterRuleGroup;

      expect(hasRuleForField(group, 'linked_to')).toBe(false);
    },
  );
});
