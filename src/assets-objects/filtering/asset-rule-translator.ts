/**
 *
 * 1. NEVER emit a `::` cast. PostgREST SILENTLY DISCARDS casts on the filter
 *    left-hand side — `id=like.*` and `id::text=like.*` produce the identical
 *    error. `attribute_values->>cpu::numeric` is parsed as a JSON key literally
 *    named `cpu::numeric` and returns wrong rows with no error. Proven, not
 *    theorised. `assertNoCast()` below is the guard.
 *
 * 2. Use `->` (jsonb) for numbers/booleans/null/array containment. Postgres
 *    compares jsonb numbers NUMERICALLY, which is what makes `cpu > 9` exclude
 *    9 and include 10. The `->>` (text) form compares lexicographically and is
 *    silently wrong ("10" < "9").
 *
 * 3. Use `->>` (text) for every string-shaped value, including dates.
 *    Rationale: a `->` comparison needs a JSON-quoted operand (`eq."abc"`), and
 *    inside an `or=(...)` group PostgREST consumes those double quotes as its
 *    own value quoting, leaving invalid JSON and a 400. Using `->>` for strings
 *    keeps ONE encoding that works in both the AND and OR paths. ISO-8601 dates
 *    sort chronologically as text, so dates lose nothing.
 *
 * 4. Booleans use `eq.true`, never `is.true` — `is` requires a real boolean and
 *    errors with "argument of IS TRUE must be type boolean, not type jsonb".
 *
 * 5. Column-level negation is `column.not.op.value` — the `not` goes AFTER the
 *    operand. A leading `not.` is ONLY valid before a nested `and(`/`or(` group.
 *    `not.name.ilike.*x*` inside a logic tree is a 400:
 *    "unexpected \"n\" expecting logic operator (and, or)". Verified.
 */

import { BadRequestException } from '@nestjs/common';

import {
  ASSET_FILTER_OPERATORS,
  MAX_FILTER_URL_BYTES,
  MAX_IN_VALUES,
  MAX_VALUE_LENGTH,
  NO_VALUE_OPERATORS,
} from './asset-filter.types';

import type {
  AssetFilterFieldMap,
  IAssetFilterField,
  IAssetFilterGroup,
  IAssetFilterRule,
} from './asset-filter.types';

const OPERATOR_SET = new Set<string>(ASSET_FILTER_OPERATORS);

/**
 * Escapes a value for use inside a PostgREST filter string.
 *
 * PostgREST treats `,` as a list separator and `.` as the operator separator,
 * so any value containing a metacharacter must be double-quoted, with inner
 * quotes and backslashes escaped.
 */
export function escapeFilterValue(raw: string): string {
  if (/[,.()"\\ :]/.test(raw) || raw === '') {
    return `"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  return raw;
}

/**
 * Escapes LIKE wildcards so a user typing `50%` searches for a literal `50%`
 * rather than "50 followed by anything".
 */
export function escapeLikeValue(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Joins an operand to its condition, inserting `not` in the only position
 * PostgREST accepts inside a logic tree (encoding rule 5).
 */
function condition(operand: string, rest: string, negated: boolean): string {
  return `${operand}.${negated ? 'not.' : ''}${rest}`;
}

/** Last line of defence for encoding rule 1. */
function assertNoCast(fragment: string): string {
  if (fragment.includes('::')) {
    throw new BadRequestException(
      'Internal filter error: cast operator is not supported by PostgREST',
    );
  }

  return fragment;
}

function asString(value: unknown, field: string): string {
  if (value === null || value === undefined) {
    throw new BadRequestException(`Filter on "${field}" requires a value`);
  }

  // Objects and arrays would stringify to "[object Object]" and silently
  // produce a filter that matches nothing. Reject them instead.
  if (typeof value === 'object') {
    throw new BadRequestException(
      `Filter on "${field}" requires a scalar value`,
    );
  }

  const str =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '';

  if (str === '' && typeof value !== 'string') {
    throw new BadRequestException(`Filter on "${field}" has an invalid value`);
  }

  if (str.length > MAX_VALUE_LENGTH) {
    throw new BadRequestException(
      `Filter value for "${field}" exceeds ${MAX_VALUE_LENGTH} characters`,
    );
  }

  return str;
}

function asFiniteNumber(value: unknown, field: string): number {
  const num =
    typeof value === 'number' ? value : Number(asString(value, field));

  if (!Number.isFinite(num)) {
    throw new BadRequestException(
      `Filter on "${field}" requires a numeric value`,
    );
  }

  return num;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;

  const str = asString(value, field).toLowerCase();

  if (str === 'true') return true;
  if (str === 'false') return false;

  throw new BadRequestException(`Filter on "${field}" requires true or false`);
}

/** Normalises `in` / `notIn` input, which may arrive as an array or CSV string. */
function asList(value: unknown, field: string): string[] {
  const list = Array.isArray(value)
    ? value
    : asString(value, field)
        .split(',')
        .map((s) => s.trim());

  const cleaned = list
    .filter((v) => v !== null && v !== undefined && String(v) !== '')
    .map((v) => asString(v, field));

  if (cleaned.length === 0) {
    // `in.()` is invalid SQL. An empty list matches nothing, so say so explicitly.
    throw new BadRequestException(
      `Filter on "${field}" requires at least one value`,
    );
  }

  if (cleaned.length > MAX_IN_VALUES) {
    throw new BadRequestException(
      `Filter on "${field}" exceeds ${MAX_IN_VALUES} values`,
    );
  }

  return cleaned;
}

/** Validates a 2-element bound pair for between / notBetween. */
function asPair(value: unknown, field: string): [string, string] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new BadRequestException(
      `Filter on "${field}" requires exactly two bounds`,
    );
  }

  return [asString(value[0], field), asString(value[1], field)];
}

/** The physical operand for a field: a real column, or a jsonb accessor. */
function operandFor(field: IAssetFilterField, textual: boolean): string {
  if (field.column) return field.column;

  // `->>` yields text, `->` yields jsonb. See encoding rules 2 and 3.
  return `attribute_values-${textual ? '>>' : '>'}${field.fieldKey}`;
}

/** True when the field's values are stored as JSON strings. */
function isTextual(field: IAssetFilterField): boolean {
  return (
    field.kind === 'column_text' ||
    field.kind === 'column_uuid' ||
    field.kind === 'column_timestamp' ||
    field.kind === 'attr_text' ||
    field.kind === 'attr_date'
  );
}

/**
 * Emits the PostgREST fragment for an empty / non-empty check.
 *
 * A missing JSON key and an explicit null both yield SQL NULL, so `is.null`
 * covers both. For text-shaped fields an empty string is also "empty", which
 * needs a nested or-group.
 */
function emptinessFragment(field: IAssetFilterField, negated: boolean): string {
  const jsonOperand = operandFor(field, false);
  const textOperand = operandFor(field, true);
  const textLike = isTextual(field);

  if (!textLike) {
    return negated ? `${jsonOperand}.not.is.null` : `${jsonOperand}.is.null`;
  }

  return negated
    ? `and(${textOperand}.not.is.null,${textOperand}.neq.)`
    : `or(${textOperand}.is.null,${textOperand}.eq.)`;
}

/**
 * Translates one rule into a single PostgREST filter fragment.
 *
 * Returns a string such as `name.ilike.*foo*` or `attribute_values->cpu.gt.9`,
 * suitable for use inside `.or(...)` in both the AND and OR paths.
 */
export function ruleToFragment(
  rule: IAssetFilterRule,
  fields: AssetFilterFieldMap,
): string {
  const field = fields.get(rule.field);

  if (!field) {
    // Fail loudly. The saved-filter engine's habit of collapsing unknown fields
    // to an impossible-UUID match returns zero rows silently, which is the most
    // confusing failure mode there is.
    throw new BadRequestException(`Unknown filter field: ${rule.field}`);
  }

  if (!OPERATOR_SET.has(rule.operator)) {
    throw new BadRequestException(`Unsupported operator: ${rule.operator}`);
  }

  const op = rule.operator;

  if (NO_VALUE_OPERATORS.has(op)) {
    return assertNoCast(emptinessFragment(field, op === 'isNotEmpty'));
  }

  const numeric = field.kind === 'attr_number';
  const bool = field.kind === 'attr_bool';
  const array = field.kind === 'attr_array';

  // Array-valued attributes only support membership.
  if (array) {
    if (op !== 'contains' && op !== 'notContains') {
      throw new BadRequestException(
        `Operator "${op}" is not supported for multi-value field "${rule.field}"`,
      );
    }

    const member = JSON.stringify([asString(rule.value, rule.field)]);

    return assertNoCast(
      condition(operandFor(field, false), `cs.${member}`, op === 'notContains'),
    );
  }

  if (bool) {
    if (op !== 'eq' && op !== 'neq') {
      throw new BadRequestException(
        `Operator "${op}" is not supported for boolean field "${rule.field}"`,
      );
    }

    // Encoding rule 4: `eq.true`, never `is.true`.
    return assertNoCast(
      condition(
        operandFor(field, false),
        `eq.${asBoolean(rule.value, rule.field)}`,
        op === 'neq',
      ),
    );
  }

  const operand = operandFor(field, !numeric);

  switch (op) {
    case 'eq':
    case 'neq': {
      const val = numeric
        ? String(asFiniteNumber(rule.value, rule.field))
        : escapeFilterValue(asString(rule.value, rule.field));

      return assertNoCast(condition(operand, `eq.${val}`, op === 'neq'));
    }

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const val = numeric
        ? String(asFiniteNumber(rule.value, rule.field))
        : escapeFilterValue(asString(rule.value, rule.field));

      return assertNoCast(`${operand}.${op}.${val}`);
    }

    case 'contains':
    case 'notContains':
    case 'beginsWith':
    case 'endsWith': {
      if (numeric) {
        throw new BadRequestException(
          `Operator "${op}" is not supported for numeric field "${rule.field}"`,
        );
      }

      const term = escapeLikeValue(asString(rule.value, rule.field));

      const pattern =
        op === 'beginsWith'
          ? `${term}%`
          : op === 'endsWith'
            ? `%${term}`
            : `%${term}%`;

      return assertNoCast(
        condition(
          operand,
          `ilike.${escapeFilterValue(pattern)}`,
          op === 'notContains',
        ),
      );
    }

    case 'between':
    case 'notBetween': {
      const [lo, hi] = asPair(rule.value, rule.field);

      const [loVal, hiVal] = numeric
        ? [
            String(asFiniteNumber(lo, rule.field)),
            String(asFiniteNumber(hi, rule.field)),
          ]
        : [escapeFilterValue(lo), escapeFilterValue(hi)];

      const inner = `and(${operand}.gte.${loVal},${operand}.lte.${hiVal})`;

      return assertNoCast(op === 'between' ? inner : `not.${inner}`);
    }

    case 'in':
    case 'notIn': {
      const values = asList(rule.value, rule.field);

      const encoded = values
        .map((v) =>
          numeric
            ? String(asFiniteNumber(v, rule.field))
            : escapeFilterValue(v),
        )
        .join(',');

      return assertNoCast(
        condition(operand, `in.(${encoded})`, op === 'notIn'),
      );
    }

    default:
      // Unreachable — guarded by OPERATOR_SET above. Fail closed regardless.
      throw new BadRequestException(`Unsupported operator: ${rule.operator}`);
  }
}

/**
 * Builds the fragments for a rule group.
 *
 * Both combinators go through `.or()` on the caller's side: a single-element
 * `or(...)` behaves as a plain condition, so chaining one call per rule yields
 * AND, while one call with all rules joined yields OR. Using one code path for
 * both avoids the AND/OR divergence that has already bitten the saved-filter
 * engine, where `applyRule` and `ruleToFilterString` must be kept in lockstep
 * by hand.
 *
 * Returns an empty array when there is nothing to apply — an empty group is a
 * no-op, never "match nothing".
 */
export function buildFilterFragments(
  group: IAssetFilterGroup | null | undefined,
  fields: AssetFilterFieldMap,
): string[] {
  if (!group || !Array.isArray(group.rules) || group.rules.length === 0) {
    return [];
  }

  const fragments = group.rules.map((rule) => ruleToFragment(rule, fields));

  const result = group.combinator === 'or' ? [fragments.join(',')] : fragments;

  assertWithinUrlBudget(result);

  return result;
}

/**
 * Rejects filters that would exceed the request-URL limit.
 *
 * Without this the stack answers with an opaque `414 URI too long`, which reads
 * as "the app is broken" rather than "your filter is too big". Measured ceiling
 * is ~8 KB; see MAX_FILTER_URL_BYTES.
 *
 * Length is measured AFTER url-encoding, because percent-escaping inflates
 * unicode and spaces well past their raw character count.
 */
function assertWithinUrlBudget(fragments: string[]): void {
  const encodedBytes = fragments.reduce(
    // +4 covers the `or=()` wrapper each fragment is sent in.
    (total, fragment) => total + encodeURIComponent(fragment).length + 4,
    0,
  );

  if (encodedBytes > MAX_FILTER_URL_BYTES) {
    throw new BadRequestException(
      'Filter is too large. Reduce the number of conditions or shorten the values.',
    );
  }
}
