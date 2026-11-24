/**
 * @fileoverview Registry of "system" task fields that workflow rules
 * (field_equals / field_compare conditions and decision branches) can
 * evaluate in addition to custom fields.
 *
 * A system field is persisted in rule JSON with a sentinel `field_id` of the
 * form `sys:<column>` (e.g. `sys:status_id`). This keeps the change fully
 * backward compatible: existing rules store a custom-field UUID and continue
 * to resolve from `ctx.customFieldValues`, while `sys:`-prefixed ids resolve
 * from the task row (`ctx.task[column]`). Unknown system keys resolve to
 * `undefined` so misconfigured rules fail closed (never match).
 *
 * @module src/workflow-engine/handlers/system-fields
 * @author Rajbha Manek
 */

import type { IEvaluationContext } from './handler.types';

export const SYSTEM_FIELD_PREFIX = 'sys:';

export type SystemFieldValueType =
  | 'status_ref'
  | 'priority_ref'
  | 'user_ref'
  | 'tasktype_ref'
  | 'resolution_ref'
  | 'date'
  | 'text';

export interface ISystemFieldDef {
  /** Persisted sentinel id, e.g. `sys:status_id`. */
  id: string;
  /** Column on the `tasks` row whose value backs this field. */
  column: string;
  /** Drives the value control in the UI and comparison coercion. */
  valueType: SystemFieldValueType;
  /** Human-readable label, e.g. for rule-failure messages ("Assigned to"). */
  label: string;
}

/**
 * The system fields a rule may reference. Read-only contexts only
 * (conditions / validators / decision branches) — writing system fields is
 * intentionally left to the dedicated post-functions (assign_to,
 * set_resolution) and to the transition itself (status).
 */
export const SYSTEM_FIELDS: ISystemFieldDef[] = [
  {
    id: 'sys:status_id',
    column: 'status_id',
    valueType: 'status_ref',
    label: 'Status',
  },
  {
    id: 'sys:priority_id',
    column: 'priority_id',
    valueType: 'priority_ref',
    label: 'Priority',
  },
  {
    id: 'sys:assigned_to',
    column: 'assigned_to',
    valueType: 'user_ref',
    label: 'Assigned to',
  },
  {
    id: 'sys:task_type_id',
    column: 'task_type_id',
    valueType: 'tasktype_ref',
    label: 'Task type',
  },
  {
    id: 'sys:resolution_id',
    column: 'resolution_id',
    valueType: 'resolution_ref',
    label: 'Resolution',
  },
  {
    id: 'sys:due_date',
    column: 'due_date',
    valueType: 'date',
    label: 'Due date',
  },
  {
    id: 'sys:start_date',
    column: 'start_date',
    valueType: 'date',
    label: 'Start date',
  },
  { id: 'sys:summary', column: 'summary', valueType: 'text', label: 'Summary' },
];

const BY_ID = new Map<string, ISystemFieldDef>(
  SYSTEM_FIELDS.map((f) => [f.id, f]),
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a field_id denotes a system field (vs a custom-field UUID). */
export function isSystemFieldId(fieldId: string): boolean {
  return typeof fieldId === 'string' && fieldId.startsWith(SYSTEM_FIELD_PREFIX);
}

/** Look up a system field definition by its sentinel id, or undefined. */
export function getSystemField(fieldId: string): ISystemFieldDef | undefined {
  return BY_ID.get(fieldId);
}

/** Friendly label for a known system field id (e.g. "Assigned to"), or null. */
export function systemFieldLabel(fieldId: string): string | null {
  return BY_ID.get(fieldId)?.label ?? null;
}

/**
 * Validate a rule field_id: a custom-field UUID, or a KNOWN system field key.
 * Unknown `sys:` keys are rejected so typos fail validation rather than
 * silently never matching at runtime.
 */
export function isValidRuleFieldId(fieldId: string): boolean {
  if (isSystemFieldId(fieldId)) return BY_ID.has(fieldId);

  return UUID_RE.test(fieldId);
}

/**
 * Resolve a rule field's current value from the evaluation context.
 *
 * - `sys:<col>` → the mapped column off `ctx.task` (system field).
 * - otherwise   → the custom field's value looked up by `fieldId` in
 *   `ctx.customFieldValuesById` (the UUID-keyed view), falling back to the
 *   slug-keyed `ctx.customFieldValues` when the by-id map is absent.
 *
 * Unknown system keys and a missing task both yield `undefined`.
 */
export function resolveFieldValue(
  fieldId: string,
  ctx: IEvaluationContext,
): unknown {
  if (isSystemFieldId(fieldId)) {
    const def = BY_ID.get(fieldId);

    if (!def || !ctx.task) return undefined;

    return ctx.task[def.column];
  }

  return (ctx.customFieldValuesById ?? ctx.customFieldValues)[fieldId];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/;

/**
 * Coerce a value to an orderable number for `>`, `<`, `>=`, `<=`.
 * Handles numbers, booleans, Date objects, numeric strings, and ISO date /
 * datetime strings (parsed to epoch ms). Returns NaN when not orderable.
 */
export function coerceOrderable(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();

  if (typeof v === 'string') {
    const n = Number(v);

    if (Number.isFinite(n)) return n;
    if (ISO_DATE_RE.test(v)) {
      const t = Date.parse(v);

      return Number.isNaN(t) ? Number.NaN : t;
    }
  }

  return Number.NaN;
}

/** Reduce a value to its calendar-day `yyyy-MM-dd`, or null when not a date. */
function toDatePrefix(v: unknown): string | null {
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  }

  if (typeof v === 'number') {
    const d = new Date(v);

    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  if (typeof v === 'string' && ISO_DATE_RE.test(v)) return v.slice(0, 10);

  return null;
}

/** Parse boolean-like values ("true"/"false"/"1"/"0"/"yes"/"no"), else null. */
function parseBooleanLike(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;

  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();

    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
  }

  return null;
}

/**
 * Type-aware equality for decision-branch `field_equals` / `field_in_set`.
 *
 * The editor persists the comparison `target` as a STRING, while the task's
 * current value may be a number, boolean, or `timestamptz` ISO string. Rather
 * than `Object.is` (which silently never matches across types), coerce the
 * `target` to the RUNTIME TYPE of `current` (never guess from the string, so a
 * text value like `"007"` never numeric-matches `"7"`):
 * - `current` string  → exact string compare (existing ref/text behavior),
 *   except two ISO-date-like strings compare by `yyyy-MM-dd` prefix.
 * - `current` number  → numeric compare after `Number(target)`.
 * - `current` boolean → boolean compare after boolean-parsing `target`.
 * - `date` system fields (valueType) → compare `yyyy-MM-dd` prefix of both
 *   sides so a stored `timestamptz` matches a `yyyy-MM-dd` branch value
 *   regardless of time/zone.
 *
 * Missing `current` (undefined/null) fails closed.
 */
export function valuesEqual(
  current: unknown,
  target: unknown,
  valueType?: SystemFieldValueType,
): boolean {
  if (current === undefined || current === null) return false;

  if (valueType === 'date') {
    const a = toDatePrefix(current);
    const b = toDatePrefix(target);

    return a !== null && a === b;
  }

  if (typeof current === 'number') {
    const t = typeof target === 'number' ? target : Number(target);

    return Number.isFinite(t) && current === t;
  }

  if (typeof current === 'boolean') {
    const t = parseBooleanLike(target);

    return t !== null && current === t;
  }

  if (typeof current === 'string') {
    if (
      typeof target === 'string' &&
      ISO_DATE_RE.test(current) &&
      ISO_DATE_RE.test(target)
    ) {
      return current.slice(0, 10) === target.slice(0, 10);
    }

    return typeof target === 'string'
      ? current === target
      : String(target) === current;
  }

  return Object.is(current, target);
}
