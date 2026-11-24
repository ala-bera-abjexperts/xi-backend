import {
  applyDevFilter,
  DEV_FILTERS,
  devFilterCondition,
  isDevFilter,
} from './git-dev-filter.util';

describe('git-dev-filter.util', () => {
  it.each([
    ['has_pr', 'git_pr_count.gt.0', 'git_pr_count.eq.0'],
    ['no_pr', 'git_pr_count.eq.0', 'git_pr_count.gt.0'],
    ['pr_open', 'git_open_pr_count.gt.0', 'git_open_pr_count.eq.0'],
    ['pr_merged', 'git_merged_pr_count.gt.0', 'git_merged_pr_count.eq.0'],
    [
      'build_failing',
      'git_build_state.eq.failed',
      'or(git_build_state.is.null,git_build_state.neq.failed)',
    ],
  ] as const)('%s → %s, negated %s', (value, match, negated) => {
    expect(devFilterCondition(value)).toBe(match);
    expect(devFilterCondition(value, true)).toBe(negated);
  });

  it('covers every filter', () => {
    for (const value of DEV_FILTERS)
      expect(devFilterCondition(value)).toMatch(/^git_/);
  });

  it('validates values', () => {
    expect(isDevFilter('build_failing')).toBe(true);
    expect(isDevFilter('build_failed')).toBe(false);
    expect(isDevFilter(undefined)).toBe(false);
  });

  it('applies the condition through .or()', () => {
    const query = { or: jest.fn().mockReturnThis() };

    expect(applyDevFilter(query, 'no_pr')).toBe(query);
    expect(query.or).toHaveBeenCalledWith('git_pr_count.eq.0');
  });
});
