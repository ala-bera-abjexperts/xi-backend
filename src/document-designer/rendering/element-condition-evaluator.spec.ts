import { ElementConditionEvaluator } from './element-condition-evaluator';
import type { IFilterRuleGroup } from '../../saved-filters/filter-query-engine';

function group(rules: IFilterRuleGroup['rules']): IFilterRuleGroup {
  return { combinator: 'and', rules };
}

describe('ElementConditionEvaluator', () => {
  const taskEvaluator = new ElementConditionEvaluator('task');

  it('shows the element when no condition is set', () => {
    expect(taskEvaluator.evaluate(null, { status: 'open' })).toEqual({
      show: true,
    });
    expect(taskEvaluator.evaluate(undefined, {}).show).toBe(true);
  });

  it('shows the element for an empty rule group', () => {
    expect(taskEvaluator.evaluate(group([]), { status: 'open' }).show).toBe(
      true,
    );
  });

  it('evaluates equality against raw fields', () => {
    const condition = group([
      { field: 'status', operator: 'eq', value: 'open' },
    ]);
    expect(taskEvaluator.evaluate(condition, { status: 'open' }).show).toBe(
      true,
    );
    expect(taskEvaluator.evaluate(condition, { status: 'closed' }).show).toBe(
      false,
    );
  });

  it('maps cf_<key> fields to custom_field_values', () => {
    const condition = group([
      { field: 'cf_severity', operator: 'eq', value: 'high' },
    ]);
    expect(
      taskEvaluator.evaluate(condition, {
        custom_field_values: { severity: 'high' },
      }).show,
    ).toBe(true);
    expect(
      taskEvaluator.evaluate(condition, {
        custom_field_values: { severity: 'low' },
      }).show,
    ).toBe(false);
  });

  it("aliases 'title' to 'summary' for tasks", () => {
    const condition = group([
      { field: 'title', operator: 'contains', value: 'Report' },
    ]);
    expect(
      taskEvaluator.evaluate(condition, { summary: 'Monthly Report' }).show,
    ).toBe(true);
    expect(
      taskEvaluator.evaluate(condition, { summary: 'Weekly digest' }).show,
    ).toBe(false);
  });

  it("bridges 'name' to 'title' for processes", () => {
    const processEvaluator = new ElementConditionEvaluator('process');
    const condition = group([
      { field: 'title', operator: 'contains', value: 'GDPR' },
    ]);
    expect(
      processEvaluator.evaluate(condition, { title: 'GDPR Review' }).show,
    ).toBe(true);
  });

  it('fails open on malformed conditions', () => {
    const malformed = {
      combinator: 'and',
      rules: [{ field: 'status', operator: 'eq', value: 'open' }],
    } as IFilterRuleGroup;
    // Circular data would make a naive evaluator throw; ours must fail open.
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const result = taskEvaluator.evaluate(malformed, circular);
    expect(result.show).toBeDefined();
  });

  it('resolves BARE custom field keys from custom_field_values (designer contract)', () => {
    const condition = group([
      { field: 'severity', operator: 'eq', value: 'high' },
    ]);
    expect(
      taskEvaluator.evaluate(condition, {
        custom_field_values: { severity: 'high' },
      }).show,
    ).toBe(true);
    expect(
      taskEvaluator.evaluate(condition, {
        custom_field_values: { severity: 'low' },
      }).show,
    ).toBe(false);
  });

  it('never lets a bare custom field key shadow a real row column', () => {
    const condition = group([
      { field: 'status', operator: 'eq', value: 'open' },
    ]);
    expect(
      taskEvaluator.evaluate(condition, {
        status: 'open',
        custom_field_values: { status: 'shadowed' },
      }).show,
    ).toBe(true);
  });

  it("bridges 'space_name' from the nested space join", () => {
    const condition = group([
      { field: 'space_name', operator: 'contains', value: 'Ops' },
    ]);
    expect(
      taskEvaluator.evaluate(condition, {
        space: { name: 'Ops Space' },
      }).show,
    ).toBe(true);
    expect(
      taskEvaluator.evaluate(condition, {
        space: { name: 'Finance' },
      }).show,
    ).toBe(false);
  });

  describe('meta-only context (fixed_document statics/anchored)', () => {
    const meta = {
      exportDate: new Date('2026-07-19T10:00:00Z'),
      exportedByUserId: 'user-1',
      itemCount: 3,
    };

    it('evaluates meta-field rules meaningfully without warnings', () => {
      const condition = group([
        { field: 'itemCount', operator: 'gt', value: 2 },
      ]);
      const result = taskEvaluator.evaluate(condition, null, meta);
      expect(result.show).toBe(true);
      expect(result.warning).toBeUndefined();

      const hides = group([{ field: 'itemCount', operator: 'gt', value: 5 }]);
      expect(taskEvaluator.evaluate(hides, null, meta).show).toBe(false);
    });

    it('treats item-field references as non-matching WITH a warning', () => {
      const condition = group([
        { field: 'status', operator: 'eq', value: 'done' },
      ]);
      const result = taskEvaluator.evaluate(condition, null, meta);

      expect(result.show).toBe(false);
      expect(result.warning).toContain('status');
      expect(result.warning).toContain('no item context');
    });

    it('still shows for empty conditions with no item context', () => {
      expect(taskEvaluator.evaluate(group([]), null, meta).show).toBe(true);
      expect(taskEvaluator.evaluate(null, null, meta).show).toBe(true);
    });
  });
});
