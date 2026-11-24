import {
  analyzeSplits,
  roundCents,
  type SplitRef,
} from './budget-split.analysis';

const split = (
  id: string,
  task_id: string,
  amount: number,
  overall_budget_id = 'b1',
): SplitRef => ({ id, overall_budget_id, task_id, amount });

// epic -> story -> sub; other is a separate root.
const parents = new Map<string, string | null>([
  ['epic', null],
  ['story', 'epic'],
  ['sub', 'story'],
  ['other', null],
]);

describe('analyzeSplits', () => {
  it('sums top-level splits into the allocated amount', () => {
    const result = analyzeSplits(
      [split('s1', 'epic', 400), split('s2', 'other', 100)],
      parents,
      new Map([
        ['b1', 1000],
        ['b-empty', 50],
      ]),
    );

    expect(result.budgets.get('b1')).toEqual({
      allocated_amount: 500,
      over_allocated_by: 0,
    });
    expect(result.budgets.get('b-empty')).toEqual({
      allocated_amount: 0,
      over_allocated_by: 0,
    });
    expect(result.splits.get('s1')?.parent_split_id).toBeNull();
  });

  it('nests a child under the epic split and does not count it again', () => {
    const result = analyzeSplits(
      [split('s-epic', 'epic', 400), split('s-story', 'story', 150)],
      parents,
      new Map([['b1', 1000]]),
    );

    expect(result.splits.get('s-story')).toEqual({
      parent_split_id: 's-epic',
      children_amount: 0,
      children_exceed_by: 0,
    });
    expect(result.splits.get('s-epic')?.children_amount).toBe(150);
    expect(result.budgets.get('b1')?.allocated_amount).toBe(400);
  });

  it('nests through an intermediate task without a split', () => {
    const result = analyzeSplits(
      [split('s-epic', 'epic', 400), split('s-sub', 'sub', 90)],
      parents,
      new Map([['b1', 1000]]),
    );

    expect(result.splits.get('s-sub')?.parent_split_id).toBe('s-epic');
    expect(result.budgets.get('b1')?.allocated_amount).toBe(400);
  });

  it('does not nest under a split from a different budget', () => {
    const result = analyzeSplits(
      [split('s-epic', 'epic', 400, 'b2'), split('s-story', 'story', 150)],
      parents,
      new Map([
        ['b1', 1000],
        ['b2', 1000],
      ]),
    );

    expect(result.splits.get('s-story')?.parent_split_id).toBeNull();
    expect(result.splits.get('s-epic')?.children_amount).toBe(0);
    expect(result.budgets.get('b1')?.allocated_amount).toBe(150);
    expect(result.budgets.get('b2')?.allocated_amount).toBe(400);
  });

  it('reports an over-allocated budget', () => {
    const result = analyzeSplits(
      [split('s1', 'epic', 700), split('s2', 'other', 500.5)],
      parents,
      new Map([['b1', 1000]]),
    );

    expect(result.budgets.get('b1')).toEqual({
      allocated_amount: 1200.5,
      over_allocated_by: 200.5,
    });
  });

  it('reports children exceeding their parent split', () => {
    const result = analyzeSplits(
      [
        split('s-epic', 'epic', 100),
        split('s-story', 'story', 80),
        split('s-other-child', 'sub', 30),
      ],
      new Map([
        ['epic', null],
        ['story', 'epic'],
        ['sub', 'epic'],
      ]),
      new Map([['b1', 1000]]),
    );

    expect(result.splits.get('s-epic')).toEqual({
      parent_split_id: null,
      children_amount: 110,
      children_exceed_by: 10,
    });
  });

  it('terminates on a parent_task_id cycle', () => {
    const result = analyzeSplits(
      [split('s-a', 'a', 10)],
      new Map([
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ]),
      new Map([['b1', 100]]),
    );

    expect(result.splits.get('s-a')?.parent_split_id).toBeNull();
    expect(result.budgets.get('b1')?.allocated_amount).toBe(10);
  });

  it('rounds to cents', () => {
    const result = analyzeSplits(
      [split('s1', 'epic', 0.1), split('s2', 'other', 0.2)],
      parents,
      new Map([['b1', 0.3]]),
    );

    expect(result.budgets.get('b1')).toEqual({
      allocated_amount: 0.3,
      over_allocated_by: 0,
    });
    expect(roundCents(1.005)).toBe(1.01);
  });
});
