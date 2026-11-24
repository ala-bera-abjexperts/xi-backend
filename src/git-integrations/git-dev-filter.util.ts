/**
 * Ticket 10: development filters and columns on task lists.
 *
 * `git_pr_count`, `git_open_pr_count`, `git_merged_pr_count` and `git_build_state` are PostgREST computed
 * fields on `tasks` (migration 20261025120000_git_dev_reporting.sql): selectable and filterable like
 * columns, service_role only. `git_build_state` is the Development section's build headline.
 */

export const DEV_FILTERS = [
  'has_pr',
  'pr_open',
  'pr_merged',
  'build_failing',
  'no_pr',
] as const;

export type DevFilter = (typeof DEV_FILTERS)[number];

/** Appended to a task select; never part of `*`. */
export const GIT_DEV_SELECT =
  'git_pr_count, git_open_pr_count, git_merged_pr_count, git_build_state';

export function isDevFilter(value: unknown): value is DevFilter {
  return (DEV_FILTERS as readonly unknown[]).includes(value);
}

/**
 * One PostgREST condition in `.or()` syntax, so it works alone and inside a rule group.
 * Negated: the tasks the filter does not match (a task without builds is "not failing").
 */
export function devFilterCondition(value: DevFilter, negate = false): string {
  switch (value) {
    case 'has_pr':
      return `git_pr_count.${negate ? 'eq' : 'gt'}.0`;
    case 'no_pr':
      return `git_pr_count.${negate ? 'gt' : 'eq'}.0`;
    case 'pr_open':
      return `git_open_pr_count.${negate ? 'eq' : 'gt'}.0`;
    case 'pr_merged':
      return `git_merged_pr_count.${negate ? 'eq' : 'gt'}.0`;
    case 'build_failing':
      return negate
        ? 'or(git_build_state.is.null,git_build_state.neq.failed)'
        : 'git_build_state.eq.failed';
  }
}

export function applyDevFilter<Q extends { or(filters: string): Q }>(
  query: Q,
  value: DevFilter,
  negate = false,
): Q {
  return query.or(devFilterCondition(value, negate));
}
