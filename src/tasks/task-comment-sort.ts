import {
  TASK_COMMENT_TIE_SORTS,
  type TaskCommentSort,
  type TaskCommentTieSort,
} from '../users/dto/save-task-comment-preferences.dto';

interface CommentRow {
  id?: string;
  content?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  author?: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
  } | null;
}

const collator = new Intl.Collator(undefined, {
  sensitivity: 'base',
  numeric: true,
});

const time = (value?: string | null): number => Date.parse(value ?? '') || 0;

// Visible text only, so tags and attributes never decide the order
const plainText = (html?: string | null): string =>
  (html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const authorName = (row: CommentRow): string =>
  [row.author?.first_name, row.author?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim() ||
  row.author?.email ||
  '';

// Empty values (system comments, image-only text) always go last
const compareText = (a: string, b: string, direction: 1 | -1): number => {
  if (!a !== !b) return a ? -1 : 1;

  return direction * collator.compare(a, b);
};

const byCreated = (a: CommentRow, b: CommentRow): number =>
  time(a.created_at) - time(b.created_at) ||
  (a.id ?? '').localeCompare(b.id ?? '');

// Each compares only its own time, so a later key in the sequence still applies on a tie
const tieOrders: Record<
  TaskCommentTieSort,
  (a: CommentRow, b: CommentRow) => number
> = {
  oldest: (a, b) => time(a.created_at) - time(b.created_at),
  newest: (a, b) => time(b.created_at) - time(a.created_at),
  updated_desc: (a, b) => time(b.updated_at) - time(a.updated_at),
  updated_asc: (a, b) => time(a.updated_at) - time(b.updated_at),
};

const tieField = (sort: TaskCommentTieSort): string =>
  sort.startsWith('updated') ? 'updated' : 'created';

/** Valid tie orders in the given sequence, keeping the first pick per field (created / updated). */
export function normalizeTieSorts(value: unknown): TaskCommentTieSort[] {
  if (!Array.isArray(value)) return [];
  const picked: TaskCommentTieSort[] = [];
  for (const item of value) {
    if (
      TASK_COMMENT_TIE_SORTS.includes(item as TaskCommentTieSort) &&
      !picked.some((p) => tieField(p) === tieField(item as TaskCommentTieSort))
    )
      picked.push(item as TaskCommentTieSort);
  }

  return picked;
}

/** Parses `?then=updated_desc,oldest`; null when a value is unknown or a field repeats. */
export function parseTieSortsQuery(
  raw: string | undefined,
): TaskCommentTieSort[] | null {
  if (!raw) return [];
  const items = raw.split(',');
  const picked = normalizeTieSorts(items);

  return picked.length === items.length ? picked : null;
}

/** Returns a new array in the requested order; name and text ties follow `then` in sequence, then oldest first. */
export function sortTaskComments<T extends CommentRow>(
  rows: T[],
  sort: TaskCommentSort,
  then: TaskCommentTieSort[] = [],
): T[] {
  const texts = new Map<T, string>();
  const textOf = (row: T): string => {
    if (!texts.has(row)) texts.set(row, plainText(row.content));

    return texts.get(row) ?? '';
  };

  const compare: Record<TaskCommentSort, (a: T, b: T) => number> = {
    oldest: byCreated,
    newest: (a, b) => byCreated(b, a),
    updated_desc: (a, b) =>
      time(b.updated_at) - time(a.updated_at) || byCreated(b, a),
    updated_asc: (a, b) =>
      time(a.updated_at) - time(b.updated_at) || byCreated(a, b),
    author_asc: (a, b) =>
      compareText(authorName(a), authorName(b), 1) || tie(a, b),
    author_desc: (a, b) =>
      compareText(authorName(a), authorName(b), -1) || tie(a, b),
    message_asc: (a, b) => compareText(textOf(a), textOf(b), 1) || tie(a, b),
    message_desc: (a, b) => compareText(textOf(a), textOf(b), -1) || tie(a, b),
  };
  const tie = (a: T, b: T): number => {
    for (const order of then) {
      const result = tieOrders[order](a, b);
      if (result) return result;
    }

    return byCreated(a, b);
  };

  return [...rows].sort(compare[sort]);
}
