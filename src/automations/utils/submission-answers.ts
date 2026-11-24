import jexl from 'jexl';

import { expandLayoutFields } from '../../form-builder/logic/expand-layout-fields';

/**
 * jexl transforms that render a whole form submission as one string.
 *
 * Why these exist: substitute() leaves a placeholder untouched when it resolves to an object, so
 * `{{ trigger.submission.data }}` can never print anything. Picking answers one field at a time is
 * also impossible for a form the automation author does not control. These turn the entire answer
 * set into text in one token:
 *
 *   {{ trigger.submission|answersTable }}
 *   {{ trigger.submission|answersJson }}
 *   {{ trigger.submission|answersText }}
 *
 * The submission is piped whole (not `.data`) because labels come from `field_snapshot`, the frozen
 * field definitions already carried on the trigger payload — so no DB lookup is needed, and a form
 * edited after the fact does not change how an old submission reads.
 */

interface SnapshotField {
  field_key?: string;
  label?: string;
  field_type?: string;
  sort_order?: number;
}

export interface SubmissionLike {
  data?: Record<string, unknown> | null;
  field_snapshot?: SnapshotField[] | null;
}

/**
 * Answers that must never be reproduced in a message.
 *
 * A `password` field's value is stored in the submission like any other answer, so an unfiltered
 * dump posts the secret in clear text into Slack/Teams/email. The field is still listed, so the
 * reader can see it was filled in, but the value is replaced.
 */
const REDACTED_TYPES = new Set(['password']);

const REDACTED_PLACEHOLDER = '••••••';

// Elements that never hold an answer — they can appear in field_snapshot but never in data.
const NON_VALUE_TYPES = new Set([
  'heading',
  'paragraph',
  'divider',
  'image',
  'page_break',
  'recaptcha',
  'layout',
]);

/**
 * Turns an inline `data:` answer into a link when the caller has uploaded it somewhere, otherwise
 * names the file type. Camera/signature/multi-photo answers are stored as base64 with no URL, so
 * without this they cannot be displayed by any chat client.
 */
export type MediaResolver = (dataUrl: string) => string | undefined;

/** Renders one answer as flat text. Objects and arrays are common (address, file lists, grids). */
export function formatValue(
  value: unknown,
  resolveMedia?: MediaResolver,
): string {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value))
    return value
      .map((v) => formatValue(v, resolveMedia))
      .filter(Boolean)
      .join(', ');

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    // An uploaded file or recording carries a real URL — emit that, so the message links to the
    // thing itself (chat clients preview an image URL) instead of naming it unclickably. Falls back
    // to the display name when there is no URL.
    if (typeof obj.url === 'string' && obj.url)
      return typeof obj.name === 'string' && obj.name
        ? `${obj.name} — ${obj.url}`
        : obj.url;

    if (typeof obj.name === 'string') return obj.name;

    return Object.values(obj)
      .map((v) => formatValue(v, resolveMedia))
      .filter(Boolean)
      .join(', ');
  }

  if (typeof value === 'string' && value.startsWith('data:')) {
    const hosted = resolveMedia?.(value);

    if (hosted) return hosted;

    // Signature/camera/photo answers are inline base64. The bytes are meaningless in a message, so
    // name the kind of file instead of pasting kilobytes of it.
    const semicolon = value.indexOf(';');
    const mime = semicolon > 5 ? value.slice(5, semicolon) : '';

    return mime ? `(${mime})` : '(file)';
  }

  return String(value);
}

/**
 * Answer rows in the form's own field order, labelled the way the form author named them.
 * Keys present in `data` but absent from the snapshot still appear, keyed raw, so nothing is lost.
 */
function answerRows(
  submission: SubmissionLike,
): Array<{ label: string; value: unknown; redacted?: boolean }> {
  const data = submission?.data ?? {};

  const raw = Array.isArray(submission?.field_snapshot)
    ? submission.field_snapshot
    : [];

  // field_snapshot stores a Layout container as ONE row; its cells live in that row's options and
  // are what `data` is actually keyed by. Without this every layout-based form falls back to raw
  // keys like `cell_msyw0stscw7bov`. Same expander the submit path uses, so the keys line up.
  const snapshot = expandLayoutFields(
    raw
      .filter((f): f is SnapshotField & { field_key: string } => !!f?.field_key)
      .map((f) => ({
        ...f,
        field_type: f.field_type ?? '',
        options: (f as { options?: unknown }).options ?? null,
      })),
  ).sort(
    // expandLayoutFields appends cells at the end, which would print a Layout's fields after every
    // other field. Cells inherit their container's sort_order, so this puts them back where the
    // form shows them; sort is stable, so cells keep their own row/column order.
    (a, b) =>
      (a.sort_order ?? Number.MAX_SAFE_INTEGER) -
      (b.sort_order ?? Number.MAX_SAFE_INTEGER),
  );

  const rows: Array<{ label: string; value: unknown; redacted?: boolean }> = [];
  const used = new Set<string>();

  for (const field of snapshot) {
    const key = field?.field_key;

    if (!key || used.has(key)) continue;
    if (field.field_type && NON_VALUE_TYPES.has(field.field_type)) continue;
    if (!(key in data)) continue;

    used.add(key);
    rows.push({
      label: field.label || key,
      value: data[key],
      redacted: !!field.field_type && REDACTED_TYPES.has(field.field_type),
    });
  }

  for (const [key, value] of Object.entries(data)) {
    if (used.has(key)) continue;

    used.add(key);
    rows.push({ label: key, value });
  }

  return rows;
}

/**
 * An aligned table inside a code fence.
 *
 * Slack has no table support in mrkdwn: a markdown pipe-table posts as literal
 * "| Field | Answer |" text in a proportional font, which is what this used to
 * produce. A fenced block is rendered monospace by Slack, Teams and email
 * clients alike, so padding the columns is what actually makes them line up.
 */
export function answersTable(
  submission: SubmissionLike,
  resolveMedia?: MediaResolver,
): string {
  const rows = answerRows(submission);

  if (!rows.length) return '';

  // Newlines would break row alignment; backticks could terminate the fence early.
  const cell = (text: string) =>
    text.replace(/\s*\n\s*/g, ' ').replace(/`/g, "'");

  const entries = rows.map((row) => ({
    label: cell(row.label),
    value: row.redacted
      ? REDACTED_PLACEHOLDER
      : cell(formatValue(row.value, resolveMedia)),
  }));

  const labelWidth = Math.min(
    Math.max(...entries.map((e) => e.label.length), 'Field'.length),
    MAX_LABEL_WIDTH,
  );

  const lines = [
    `${'Field'.padEnd(labelWidth)} | Answer`,
    `${'-'.repeat(labelWidth)}-+-${'-'.repeat(6)}`,
    ...entries.map((e) => `${e.label.padEnd(labelWidth)} | ${e.value}`),
  ];

  return ['```', ...lines, '```'].join('\n');
}

/**
 * Keeps booleans and numbers as real JSON types, but names an inline base64 answer instead of
 * embedding it — a signature or photo data URL runs to tens of kilobytes and drowns the rest of the
 * output while telling the reader nothing.
 */
function jsonSafe(value: unknown, resolveMedia?: MediaResolver): unknown {
  if (typeof value === 'string')
    return value.startsWith('data:') ? formatValue(value, resolveMedia) : value;

  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, resolveMedia));

  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        jsonSafe(v, resolveMedia),
      ]),
    );

  return value;
}

/** Pretty JSON keyed by field label, with the original value types preserved. */
export function answersJson(
  submission: SubmissionLike,
  resolveMedia?: MediaResolver,
): string {
  const out: Record<string, unknown> = {};

  for (const row of answerRows(submission)) {
    // Two fields can share a label; suffix rather than silently overwrite an answer.
    let key = row.label;
    let n = 2;

    while (key in out) key = `${row.label} (${n++})`;

    out[key] = row.redacted
      ? REDACTED_PLACEHOLDER
      : jsonSafe(row.value, resolveMedia);
  }

  return JSON.stringify(out, null, 2);
}

// Beyond this a single long label would push every answer off to the right.
const MAX_LABEL_WIDTH = 28;

/**
 * One answer per line, labels padded into a column so the values line up.
 *
 * Unanswered fields are dropped — a message listing half a dozen blank optional fields reads worse
 * than one that only shows what the person actually filled in. The table and JSON forms keep every
 * field, since those are usually wanted as a complete record.
 */
export function answersText(
  submission: SubmissionLike,
  resolveMedia?: MediaResolver,
): string {
  const rows = answerRows(submission)
    .map((row) => ({
      label: row.label,
      text: row.redacted
        ? REDACTED_PLACEHOLDER
        : formatValue(row.value, resolveMedia),
    }))
    .filter((row) => row.text !== '');

  if (!rows.length) return '';

  const width = Math.min(
    Math.max(...rows.map((row) => row.label.length)),
    MAX_LABEL_WIDTH,
  );

  const body = rows
    .map((row) => {
      // A multi-line answer (long text) keeps its line breaks, indented to the value column so the
      // block still reads as one column of answers.
      const continuation = '\n' + ' '.repeat(width + 1);

      return `${row.label.padEnd(width)} ${row.text.split('\n').join(continuation)}`;
    })
    .join('\n');

  return body;
}

jexl.addTransform('answersTable', answersTable as (value: unknown) => string);
jexl.addTransform('answersJson', answersJson as (value: unknown) => string);
jexl.addTransform('answersText', answersText as (value: unknown) => string);
