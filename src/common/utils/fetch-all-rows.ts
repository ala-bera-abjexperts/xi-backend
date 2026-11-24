/**
 * @fileoverview Paged full-result-set reader for code that AGGREGATES in JavaScript.
 * @module src/common/utils/fetch-all-rows
 */

import { BadRequestException } from '@nestjs/common';

/**
 * PostgREST caps every response at `max_rows` (1000 — see
 * risk-management-app/supabase/config.toml). Any code that fetches a list and
 * then reduces/counts/sums it in JavaScript therefore computes its answer over
 * at most 1000 rows.
 *
 * That is not a slow query, it is a WRONG NUMBER, and it is invisible in exactly
 * the places you would look for it: small tenants fit under the cap and read
 * correctly, so the bug only appears on the largest customer. Measured on real
 * data: a "tasks by status" widget rendered `open: 771` against a true 16,741 —
 * a 95.4% undercount, with no error and no warning.
 *
 * Use this wherever a JS reduce/filter/count runs over a fetched list whose size
 * is driven by tenant data. Do NOT use it to page a list that is merely being
 * returned to the client — that wants real pagination, not "fetch everything".
 *
 * @param buildPage Builds one page's query. Called with a half-open-ish inclusive
 *   `[from, to]` range matching PostgREST's `.range()`. It MUST apply a stable
 *   `.order()` — without one, Postgres may return overlapping or missing rows
 *   across pages and the aggregate is silently wrong again, in a subtler way.
 *
 * @param maxRows Safety ceiling. Defaults to `AGGREGATE_MAX_ROWS` for aggregates;
 *   migration passes `Infinity` because a source space may be any size.
 *
 * @returns The rows, plus `truncated` if the safety ceiling was hit. `truncated`
 *   is returned rather than thrown so a caller can surface a partial result
 *   instead of failing an entire dashboard — but it should never fire in
 *   practice, and exists so a runaway dataset degrades visibly rather than
 *   silently, which is the exact failure mode this function removes.
 */
export const AGGREGATE_PAGE_SIZE = 1000;
export const AGGREGATE_MAX_ROWS = 100_000;

export async function fetchAllRows<T>(
  buildPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  maxRows: number = AGGREGATE_MAX_ROWS,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];

  for (let from = 0; from < maxRows; from += AGGREGATE_PAGE_SIZE) {
    const { data, error } = await buildPage(
      from,
      from + AGGREGATE_PAGE_SIZE - 1,
    );

    if (error) throw new BadRequestException(error.message);

    const batch = data ?? [];
    rows.push(...batch);

    // A short page means the server had nothing more to give.
    if (batch.length < AGGREGATE_PAGE_SIZE) {
      return { rows, truncated: false };
    }
  }

  return { rows, truncated: true };
}
