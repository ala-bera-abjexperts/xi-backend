/**
 * @fileoverview Types templated custom-field values for Create/Update Task. A `{{ }}` token always
 * resolves to text, so a number, checkbox or grid field would otherwise store "12.5", "true" or JSON
 * text instead of the typed value the ticket UI writes (a grid then renders empty).
 *
 * Only string values are touched and only on an exact conversion; everything else is written as
 * before. Never throws: a failed lookup leaves every value as given.
 */
import { randomUUID } from 'crypto';

import { GRID_MAX_ROWS } from '../../custom-fields/models/custom-field.model';
import type {
  FieldOption,
  GridRow,
} from '../../custom-fields/models/custom-field.model';
import type { ExecutionContext } from '../actions/types';
import { hasUnresolvedPlaceholder } from './template';

type Cell = GridRow['values'][string];

interface FieldDefinition {
  field_key: string;
  field_type: string;
  space_id: string | null;
  options: unknown;
  validation_rules: unknown;
}

const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TRUE_WORDS = new Set(['true', 'yes', '1']);
const FALSE_WORDS = new Set(['false', 'no', '0']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Column/choice names compared without case, accents, spaces or punctuation. */
function normalise(value: unknown): string {
  return (typeof value === 'string' ? value : '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function toNumber(raw: string): number | null {
  const text = raw.trim();

  if (!NUMBER_RE.test(text)) return null;

  const value = Number(text);

  return Number.isSafeInteger(Math.trunc(value)) ? value : null;
}

function toBoolean(raw: string): boolean | null {
  const text = raw.trim().toLowerCase();

  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;

  return null;
}

function isRealIsoDate(text: string): boolean {
  if (!ISO_DATE_RE.test(text)) return false;

  const date = new Date(`${text}T00:00:00Z`);

  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

function castCell(value: unknown, column: FieldOption): Cell {
  if (value === null || value === undefined) return null;

  const text =
    typeof value === 'string'
      ? value.trim()
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);

  if (text === '') return null;

  switch (column.column_type) {
    case 'number': {
      const number = typeof value === 'number' ? value : Number(text);

      return Number.isFinite(number) ? number : null;
    }

    case 'checkbox':
      return typeof value === 'boolean' ? value : toBoolean(text);

    case 'date':
      return isRealIsoDate(text.slice(0, 10)) ? text.slice(0, 10) : null;

    case 'select': {
      const wanted = normalise(text);
      const choice = column.choices?.find(
        (c) => normalise(c.value) === wanted || normalise(c.label) === wanted,
      );

      return choice ? choice.value : null;
    }

    default:
      return text;
  }
}

/** A JSON list → grid rows; null when it is not a list or no row fits a column. */
function toGridRows(
  raw: string,
  definition: FieldDefinition,
  ctx: ExecutionContext,
): GridRow[] | null {
  const key = definition.field_key;
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    parsed = undefined;
  }

  // An empty list clears the grid (e.g. an invoice without positions).
  if (Array.isArray(parsed) && parsed.length === 0) return [];

  if (!Array.isArray(parsed)) {
    ctx.logger.info(
      `Custom field "${key}": the value is not a JSON list of rows — grid field skipped`,
    );

    return null;
  }

  const columns = (
    Array.isArray(definition.options) ? (definition.options as unknown[]) : []
  ).filter(
    (option): option is FieldOption =>
      isRecord(option) &&
      typeof option.value === 'string' &&
      option.value !== '',
  );
  const byName = new Map<string, FieldOption>();

  // Labels first, so a column key wins over another column's label.
  for (const column of columns) {
    const label = normalise(column.label);

    if (label) byName.set(label, column);
  }

  for (const column of columns) byName.set(normalise(column.value), column);

  const rows: GridRow[] = [];

  for (const item of parsed as unknown[]) {
    if (!isRecord(item)) continue;

    // Already in the stored shape: keep it, only guarantee an id.
    if (isRecord(item.values)) {
      rows.push({
        id:
          typeof item.id === 'string' && item.id !== ''
            ? item.id
            : randomUUID(),
        values: item.values as GridRow['values'],
      });
      continue;
    }

    const values: GridRow['values'] = {};

    for (const [name, cell] of Object.entries(item)) {
      const column = byName.get(normalise(name));

      if (column) values[column.value] = castCell(cell, column);
    }

    if (Object.values(values).some((cell) => cell !== null)) {
      rows.push({ id: randomUUID(), values });
    }
  }

  if (rows.length === 0) {
    ctx.logger.info(
      `Custom field "${key}": no row matches a column of the grid — grid field skipped`,
    );

    return null;
  }

  const configuredMax = isRecord(definition.validation_rules)
    ? definition.validation_rules.max
    : undefined;
  const limit = Math.min(
    typeof configuredMax === 'number' && configuredMax > 0
      ? Math.floor(configuredMax)
      : GRID_MAX_ROWS,
    GRID_MAX_ROWS,
  );

  if (rows.length > limit) {
    ctx.logger.info(
      `Custom field "${key}": ${rows.length} rows — only the first ${limit} are kept`,
    );

    return rows.slice(0, limit);
  }

  return rows;
}

async function loadDefinitions(
  ctx: ExecutionContext,
  keys: string[],
): Promise<FieldDefinition[] | null> {
  try {
    const { data, error } = await ctx.supabase
      .from('custom_fields')
      .select('field_key, field_type, space_id, options, validation_rules')
      .eq('organization_id', ctx.organizationId)
      .in('field_key', keys)
      .or(`space_id.is.null,space_id.eq.${ctx.spaceId}`)
      .eq('is_active', true)
      .not('is_deleted', 'is', true);

    if (error) throw new Error(error.message);

    return (data ?? []) as FieldDefinition[];
  } catch (err) {
    ctx.logger.info(
      `Custom field types could not be read — values are written as given: ${err instanceof Error ? err.message : String(err)}`,
    );

    return null;
  }
}

/**
 * Converts, in place, string values of number / checkbox / grid custom fields.
 * @returns keys removed because their grid text could not become rows
 */
export async function coerceCustomFieldValues(
  ctx: ExecutionContext,
  values: Record<string, unknown>,
): Promise<string[]> {
  const keys = Object.keys(values).filter(
    (key) => typeof values[key] === 'string',
  );

  if (keys.length === 0) return [];

  const definitions = await loadDefinitions(ctx, keys);

  if (!definitions) return [];

  const dropped: string[] = [];

  for (const key of keys) {
    const matching = definitions.filter((d) => d.field_key === key);

    // Unknown key, or space and org definitions of different types: leave it as given.
    if (
      matching.length === 0 ||
      matching.some((d) => d.field_type !== matching[0].field_type)
    ) {
      continue;
    }

    // The space-level definition is the one the ticket shows.
    const definition = matching.find((d) => d.space_id !== null) ?? matching[0];
    const raw = values[key] as string;

    // A {{ }} that resolved to nothing must not land in a number/checkbox field as text.
    if (
      (definition.field_type === 'number' ||
        definition.field_type === 'checkbox') &&
      hasUnresolvedPlaceholder(raw)
    ) {
      ctx.logger.info(
        `Custom field "${key}" left an unresolved {{ }} token — skipped`,
      );
      delete values[key];
      continue;
    }

    if (definition.field_type === 'number') {
      const number = toNumber(raw);

      if (number !== null) values[key] = number;
    } else if (definition.field_type === 'checkbox') {
      const flag = toBoolean(raw);

      if (flag !== null) values[key] = flag;
    } else if (definition.field_type === 'grid') {
      const rows = toGridRows(raw, definition, ctx);

      if (rows) {
        values[key] = rows;
      } else {
        delete values[key];
        dropped.push(key);
      }
    }
  }

  return dropped;
}
