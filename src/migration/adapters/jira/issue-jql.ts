/**
 * @fileoverview Compose the JQL a Jira issue read actually runs. Pure — no HTTP, no DI.
 *
 * The admin's optional `scope.jql` narrows a migration, but it cannot be trusted verbatim for two
 * reasons that are both silent-corruption risks rather than mere inconvenience:
 *
 *  1. **Stable order is mandatory.** Issue paging is OFFSET-based (`startAt`). Jira's default order
 *     is not stable, so a query without `ORDER BY` can return the same issue on two pages and skip
 *     another entirely — a migration that silently loses issues while reporting success. Every query
 *     is therefore forced to `ORDER BY key ASC`.
 *  2. **The project filter is not optional.** A job migrates ONE project into ONE space. A JQL of
 *     `project = OTHER` (or one with no project clause at all) would pull foreign issues into this
 *     job's space and crosswalk. The project predicate is always AND-ed in, so a user filter can only
 *     ever NARROW the job's own project, never widen or redirect it.
 *
 * Hence: `project = "KEY" AND (<user filter, ORDER BY stripped>) ORDER BY key ASC`.
 */

/**
 * Trailing `ORDER BY …` — JQL permits it only at the end, so a tail match is exact.
 *
 * `(^|\s)` matters: a filter that is ONLY an order clause (`"ORDER BY created DESC"`) has no leading
 * whitespace, and without the `^` alternative it would survive into `AND (ORDER BY created DESC)` —
 * invalid JQL that fails the whole read. The alternation also keeps the match on a word boundary, so
 * `sort_order = 3` and `summary ~ "reorder"` are untouched.
 */
const ORDER_BY_TAIL = /(^|\s)ORDER\s+BY\s+[\s\S]*$/i;

/** JQL string literals are double-quoted; a `"` in a project key would break out of the clause. */
function quoteProjectKey(projectKey: string): string {
  return projectKey.replace(/"/g, '');
}

/**
 * Strip a trailing ORDER BY from a user filter. Keeping theirs would defeat the stable-order
 * guarantee; two ORDER BY clauses is simply invalid JQL.
 */
export function stripOrderBy(jql: string): string {
  return jql.replace(ORDER_BY_TAIL, '').trim();
}

/**
 * The JQL for one project, optionally narrowed by the admin's filter.
 *
 * @param projectKey the job's project — always enforced.
 * @param userJql    `scope.jql`; blank/absent → the whole project.
 */
export function buildIssueJql(
  projectKey: string,
  userJql?: string | null,
): string {
  const base = `project = "${quoteProjectKey(projectKey)}"`;
  const filter = typeof userJql === 'string' ? stripOrderBy(userJql) : '';

  if (!filter) return `${base} ORDER BY key ASC`;

  // Parenthesised so a user's top-level OR cannot escape the project predicate:
  // `project = "A" AND (x OR y)` — never `project = "A" AND x OR y`, which parses as
  // `(project = "A" AND x) OR y` and would migrate foreign issues.
  return `${base} AND (${filter}) ORDER BY key ASC`;
}
