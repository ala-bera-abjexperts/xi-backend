/**
 * @fileoverview Server-side ordering for the paginated task list (`GET /tasks`). XE-T519.
 *
 * The list is paginated on the server, so a sort has to happen here — sorting in the browser
 * only reorders the page it already holds. Kept dependency-free for the same reason as
 * `legacy-status.util.ts`: specs that import `tasks.service.ts` cannot load under Jest.
 *
 * @module src/tasks/task-list-sort.util
 * @author Prince Jadiya
 */

/** Sortable list columns (the task table's column ids) → `tasks` columns. Anything else is ignored. */
const SORTABLE_COLUMNS: Readonly<Record<string, string>> = {
  // The number in the key, not the text: `key` is "DEFAULT-T12", so a text sort puts T10 before T2.
  // `key_number` is a PostgREST computed field (migration 20260922120000_task_key_number).
  key: 'key_number',
  summary: 'summary',
  status: 'status',
  priority: 'priority',
  due_date: 'due_date',
  created_at: 'created_at',
  updated_at: 'updated_at',
};

/** Same key shape the filter engine accepts; it is interpolated into the order expression. */
const CUSTOM_FIELD_KEY_REGEX = /^[A-Za-z0-9_]+$/;

interface OrderableQuery<Q> {
  order(
    column: string,
    options: { ascending: boolean; nullsFirst?: boolean },
  ): Q;
}

/** The DB column/expression for a requested sort, or `null` when it is not sortable. */
export function resolveTaskSortColumn(sortBy?: string | null): string | null {
  if (!sortBy) return null;

  if (sortBy.startsWith('cf_')) {
    const key = sortBy.slice(3);

    return CUSTOM_FIELD_KEY_REGEX.test(key)
      ? `custom_field_values->>${key}`
      : null;
  }

  return SORTABLE_COLUMNS[sortBy] ?? null;
}

/**
 * Order the list query. A requested sort puts empty values last and ends on `id`: without a
 * unique tie-breaker, rows sharing a value (every "open" task) have no stable order, so the
 * same task can appear on two pages while another never appears. No (or an unknown) sort
 * keeps the default manual order — `sort_order`, newest first — which drag-to-reorder relies on.
 */
export function applyTaskListOrder<Q extends OrderableQuery<Q>>(
  query: Q,
  sortBy?: string | null,
  sortDir?: string | null,
): Q {
  const column = resolveTaskSortColumn(sortBy);

  if (!column) {
    return query
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
  }

  return query
    .order(column, { ascending: sortDir !== 'desc', nullsFirst: false })
    .order('id', { ascending: true });
}
