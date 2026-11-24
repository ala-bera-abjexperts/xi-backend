/**
 *
 * Three kinds of rule exist:
 *   - plain        → a PostgREST fragment (correct at any scale)
 *   - reference    → an `!inner` embed on asset_object_references
 *   - formula      → jexl, computed per read, never stored → memory only
 *
 * ── THE OR TRAP (read before changing anything here) ─────────────────────────
 * Under an `and` combinator you may narrow with SQL first and then evaluate the
 * rest in memory — the SQL step only removes rows that would have failed anyway.
 *
 * Under `or` you may NOT. Applying any SQL rule to the query would drop rows
 * that the formula/reference rule alone should have matched, and the result
 * looks completely plausible. So a single non-SQL rule under `or` forces the
 * ENTIRE group into memory.
 */

import { BadRequestException } from '@nestjs/common';

import jexl from 'jexl';

import { buildFilterFragments, ruleToFragment } from './asset-rule-translator';

import type {
  AssetFieldKind,
  AssetFilterFieldMap,
  AssetReferenceDirection,
  IAssetFilterField,
  IAssetFilterGroup,
  IAssetFilterPlan,
  IAssetFilterRule,
} from './asset-filter.types';

/** Operators a reference rule can express through an `!inner` embed. */
const EMBEDDABLE_REFERENCE_OPERATORS = new Set(['eq', 'contains']);

/**
 * Reference targets for the rows being evaluated in memory, keyed
 * `<objectId>:<attributeId>` → set of target object ids.
 *
 * Needed because `attribute_values` holds reference target NAMES after
 * enrichment, while filter rules carry target IDs.
 */
export type AssetReferenceIndex = Map<string, Set<string>>;

/** Key builder shared by the index producer and consumer. */
export function referenceKey(
  objectId: string | undefined,
  attributeId: string | undefined,
  direction: AssetReferenceDirection = 'outgoing',
): string {
  const base = `${objectId ?? ''}:${attributeId ?? ''}`;

  // Only the reverse reading is suffixed, so existing keys stay byte-identical.
  return direction === 'incoming' ? `${base}:incoming` : base;
}

/** Both readings of a reference are answered from the reference index. */
export function isReferenceKind(kind: AssetFieldKind | undefined): boolean {
  return kind === 'attr_reference' || kind === 'attr_reference_reverse';
}

/** Which end of the link a field's rule sits on. */
export function directionForKind(
  kind: AssetFieldKind | undefined,
): AssetReferenceDirection {
  return kind === 'attr_reference_reverse' ? 'incoming' : 'outgoing';
}

/** True when a group needs reference targets resolved before evaluation. */
export function groupNeedsReferenceIndex(
  rules: IAssetFilterRule[],
  fields: AssetFilterFieldMap,
): boolean {
  return rules.some((r) => isReferenceKind(fields.get(r.field)?.kind));
}

/** Which link directions a group actually reads, so only those are queried. */
export function referenceDirectionsFor(
  rules: IAssetFilterRule[],
  fields: AssetFilterFieldMap,
): AssetReferenceDirection[] {
  const directions = new Set<AssetReferenceDirection>();

  for (const rule of rules) {
    const kind = fields.get(rule.field)?.kind;

    if (isReferenceKind(kind)) directions.add(directionForKind(kind));
  }

  return [...directions];
}

function fieldFor(
  rule: IAssetFilterRule,
  fields: AssetFilterFieldMap,
): IAssetFilterField {
  const field = fields.get(rule.field);

  if (!field) {
    throw new BadRequestException(`Unknown filter field: ${rule.field}`);
  }

  return field;
}

/**
 * Builds an execution plan for a rule group.
 *
 * Falls back to `memory` mode whenever SQL cannot express the group faithfully.
 * Preferring a slightly slower but CORRECT plan over a fast wrong one is
 * deliberate.
 */
export function buildFilterPlan(
  group: IAssetFilterGroup | null | undefined,
  fields: AssetFilterFieldMap,
): IAssetFilterPlan | null {
  if (!group || !Array.isArray(group.rules) || group.rules.length === 0) {
    return null;
  }

  const combinator = group.combinator;

  const referenceRules = group.rules.filter((r) =>
    isReferenceKind(fieldFor(r, fields).kind),
  );

  const formulaRules = group.rules.filter(
    (r) => fieldFor(r, fields).kind === 'attr_formula',
  );

  // A reference rule is only embeddable when it is a single positive match.
  // `!inner` cannot express "has no such reference", and two embeds would
  // intersect at the child level rather than the parent.
  const embeddable =
    referenceRules.length === 1 &&
    combinator === 'and' &&
    EMBEDDABLE_REFERENCE_OPERATORS.has(referenceRules[0].operator);

  const needsMemory =
    formulaRules.length > 0 ||
    (referenceRules.length > 0 && !embeddable) ||
    // See THE OR TRAP above.
    (combinator === 'or' &&
      (referenceRules.length > 0 || formulaRules.length > 0));

  if (needsMemory) {
    return {
      mode: 'memory',
      fragments: [],
      embed: null,
      memoryRules: group.rules,
      combinator,
    };
  }

  const sqlRules = group.rules.filter(
    (r) => !isReferenceKind(fieldFor(r, fields).kind),
  );

  let embed = null as IAssetFilterPlan['embed'];

  if (embeddable) {
    const rule = referenceRules[0];
    const field = fieldFor(rule, fields);

    if (!field.attributeId) {
      throw new BadRequestException(
        `Reference field "${rule.field}" is missing its attribute id`,
      );
    }

    const target = rule.value;

    if (typeof target !== 'string' || target.length === 0) {
      throw new BadRequestException(
        `Filter on "${rule.field}" requires a target object`,
      );
    }

    const direction = directionForKind(field.kind);

    embed = {
      attributeId: field.attributeId,
      targetObjectId: target,
      // Omitted for the original direction so the embed shape is unchanged.
      ...(direction === 'incoming' ? { direction } : {}),
    };
  }

  return {
    mode: 'sql',
    fragments: buildFilterFragments({ combinator, rules: sqlRules }, fields),
    embed,
    memoryRules: [],
    combinator,
  };
}

// ============================================================================
// In-memory evaluation
// ============================================================================

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);

    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return '';
}

/**
 * Compares by the field's declared type, so the in-memory path agrees with the
 * SQL path. Numbers compare numerically; everything else compares as text —
 * ISO-8601 dates sort chronologically as text, which is why dates need no
 * special case.
 */
function compareOrdinal(
  left: unknown,
  right: unknown,
  numeric: boolean,
): number | null {
  if (numeric) {
    const a = toNumber(left);
    const b = toNumber(right);

    if (a === null || b === null) return null;

    return a === b ? 0 : a < b ? -1 : 1;
  }

  const a = toText(left);
  const b = toText(right);

  if (a === '' || b === '') return null;

  return a === b ? 0 : a < b ? -1 : 1;
}

/** Case-insensitive, matching the SQL path's `ilike`. */
function containsText(haystack: unknown, needle: unknown): boolean {
  if (Array.isArray(haystack)) {
    return haystack.some(
      (item) => toText(item).toLowerCase() === toText(needle).toLowerCase(),
    );
  }

  return toText(haystack).toLowerCase().includes(toText(needle).toLowerCase());
}

/**
 * Evaluates one rule against one already-enriched row.
 *
 * The row must already carry reference values and computed formula values —
 * i.e. this runs AFTER the service's enrichment step, never before.
 */
export function evaluateRuleInMemory(
  row: Record<string, unknown>,
  rule: IAssetFilterRule,
  fields: AssetFilterFieldMap,
  referenceIndex?: AssetReferenceIndex,
): boolean {
  const field = fieldFor(rule, fields);

  // Reference rules MUST be answered from the reference index, never from
  // attribute_values. Enrichment merges references in as target *names*
  // (asset-objects.service.ts), while the rule carries the target's *id* — so
  // comparing the two always fails and the whole AND group silently returns
  // nothing.
  if (isReferenceKind(field.kind)) {
    const targets =
      referenceIndex?.get(
        referenceKey(
          row['id'] as string | undefined,
          field.attributeId,
          directionForKind(field.kind),
        ),
      ) ?? new Set<string>();

    switch (rule.operator) {
      case 'isEmpty':
        return targets.size === 0;
      case 'isNotEmpty':
        return targets.size > 0;
      case 'eq':
      case 'contains':
        return targets.has(toText(rule.value));
      case 'neq':
      case 'notContains':
        return !targets.has(toText(rule.value));
      default:
        // Fail closed rather than guessing.
        return false;
    }
  }

  const raw = field.column
    ? row[field.column]
    : ((row['attribute_values'] ?? {}) as Record<string, unknown>)[
        field.fieldKey as string
      ];

  const numeric =
    field.kind === 'attr_number' ||
    (field.kind === 'attr_formula' &&
      (field.resultType === 'integer' || field.resultType === 'float'));

  switch (rule.operator) {
    case 'isEmpty':
      return isEmptyValue(raw);
    case 'isNotEmpty':
      return !isEmptyValue(raw);

    case 'eq':
      return numeric
        ? compareOrdinal(raw, rule.value, true) === 0
        : toText(raw) === toText(rule.value);
    case 'neq':
      return numeric
        ? compareOrdinal(raw, rule.value, true) !== 0
        : toText(raw) !== toText(rule.value);

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const cmp = compareOrdinal(raw, rule.value, numeric);

      // A null/incomparable value never satisfies an ordinal comparison —
      // matching SQL, where NULL comparisons are never true.
      if (cmp === null) return false;

      return rule.operator === 'gt'
        ? cmp > 0
        : rule.operator === 'gte'
          ? cmp >= 0
          : rule.operator === 'lt'
            ? cmp < 0
            : cmp <= 0;
    }

    case 'contains':
      return containsText(raw, rule.value);
    case 'notContains':
      return !containsText(raw, rule.value);

    case 'beginsWith':
      return toText(raw)
        .toLowerCase()
        .startsWith(toText(rule.value).toLowerCase());
    case 'endsWith':
      return toText(raw)
        .toLowerCase()
        .endsWith(toText(rule.value).toLowerCase());

    case 'between':
    case 'notBetween': {
      if (!Array.isArray(rule.value) || rule.value.length !== 2) return false;

      const lo = compareOrdinal(raw, rule.value[0], numeric);
      const hi = compareOrdinal(raw, rule.value[1], numeric);

      if (lo === null || hi === null) return false;

      const inside = lo >= 0 && hi <= 0;

      return rule.operator === 'between' ? inside : !inside;
    }

    case 'in':
    case 'notIn': {
      const list = Array.isArray(rule.value)
        ? rule.value
        : toText(rule.value).split(',');

      const hit = list.some((v) => toText(v).trim() === toText(raw));

      return rule.operator === 'in' ? hit : !hit;
    }

    default:
      // Fail closed, matching the SQL translator.
      return false;
  }
}

/** Applies a whole group in memory. */
export function evaluateGroupInMemory(
  row: Record<string, unknown>,
  rules: IAssetFilterRule[],
  combinator: 'and' | 'or',
  fields: AssetFilterFieldMap,
  referenceIndex?: AssetReferenceIndex,
): boolean {
  // An empty group is a no-op, never "match nothing".
  if (rules.length === 0) return true;

  return combinator === 'or'
    ? rules.some((r) => evaluateRuleInMemory(row, r, fields, referenceIndex))
    : rules.every((r) => evaluateRuleInMemory(row, r, fields, referenceIndex));
}

/**
 * Re-exported so the service can validate a reference rule's fragment shape
 * without importing the translator directly.
 */
export { ruleToFragment };

/**
 * Evaluates a formula the same way the read path does, so a filter and the
 * displayed value can never disagree.
 */
export function evaluateFormulaValue(
  expression: string,
  attributeValues: Record<string, unknown>,
): unknown {
  try {
    const evalFn = jexl.evalSync.bind(jexl) as (
      e: string,
      c: unknown,
    ) => unknown;

    return evalFn(expression, attributeValues);
  } catch {
    // Matches evaluateFormulas: an invalid expression yields null, not an error.
    return null;
  }
}
