/**
 *
 * Field names are NEVER taken from user input — a rule's `field` is looked up
 * in this map and rejected if absent. That is what makes the translator safe
 * against injection through column names.
 */

import { BadRequestException } from '@nestjs/common';

import { MAX_FILTER_RULES } from './asset-filter.types';

import type {
  AssetFieldKind,
  AssetFilterFieldMap,
  IAssetFilterGroup,
} from './asset-filter.types';

/** Prefix distinguishing a schema attribute from a real column. */
export const ATTRIBUTE_FIELD_PREFIX = 'attr_';

/** Same attribute, read from the target end — "assets listed on the given object". */
export const REVERSE_ATTRIBUTE_FIELD_PREFIX = 'refby_';

export const NON_FILTERABLE_DATA_TYPES = new Set(['tab_separator']);

/** The `field_key` format enforced at creation; also keeps a key out of PostgREST filter syntax. */
export const ATTRIBUTE_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

/**
 * Attribute kinds whose stored value orders meaningfully in SQL, via
 * `attribute_values->>key`. References live in a join table and formulas are
 * never persisted, so neither exists in the column; arrays have no single sort
 * key. Numbers order as text, the same as everything read out of that column.
 */
export const SORTABLE_ATTRIBUTE_KINDS = new Set<AssetFieldKind>([
  'attr_text',
  'attr_number',
  'attr_bool',
  'attr_date',
]);

/** Real columns on `asset_objects` that may be filtered. */
const BASE_FIELDS: Array<{
  key: string;
  column: string;
  kind: AssetFieldKind;
}> = [
  { key: 'name', column: 'name', kind: 'column_text' },
  { key: 'object_key', column: 'object_key', kind: 'column_text' },
  { key: 'description', column: 'description', kind: 'column_text' },
  { key: 'object_type_id', column: 'object_type_id', kind: 'column_uuid' },
  { key: 'created_at', column: 'created_at', kind: 'column_timestamp' },
  { key: 'updated_at', column: 'updated_at', kind: 'column_timestamp' },
];

/** Maps an attribute's declared data type to its physical storage shape. */
export function kindForDataType(dataType: string): AssetFieldKind | null {
  switch (dataType) {
    case 'integer':
    case 'float':
      return 'attr_number';

    case 'bool':
      return 'attr_bool';

    case 'date':
    case 'datetime':
      return 'attr_date';

    case 'multiselect':
    case 'user_multi':
      return 'attr_array';

    // Values live in asset_object_references, not in attribute_values.
    case 'object_reference':
      return 'attr_reference';

    // Computed per read with jexl; never persisted.
    case 'formula':
      return 'attr_formula';

    case 'text':
    case 'textarea':
    case 'select':
    case 'url':
    case 'email':
    case 'status':
    case 'user':
      return 'attr_text';

    default:
      // Unknown or non-filterable type — excluded rather than guessed at.
      return null;
  }
}

export interface IAttributeRow {
  field_key: string;
  data_type: string;
  /** Needed to scope a reference embed to this specific attribute. */
  id?: string;
  /** Holds `formula` and `result_type` for calculated attributes. */
  options?: Record<string, unknown> | null;
}

/**
 * Builds the filterable-field allowlist from the base columns plus the given
 * attribute definitions.
 *
 * Attributes are keyed `attr_<field_key>`. `field_key` is already constrained
 * to `/^[a-z][a-z0-9_]{0,49}$/` at creation, but it is re-validated here so a
 * hand-crafted or legacy row can never reach a filter string.
 */
export function buildAssetFilterFields(
  attributes: IAttributeRow[],
): AssetFilterFieldMap {
  const map: AssetFilterFieldMap = new Map();

  for (const base of BASE_FIELDS) {
    map.set(base.key, {
      key: base.key,
      kind: base.kind,
      column: base.column,
    });
  }

  for (const attr of attributes ?? []) {
    if (NON_FILTERABLE_DATA_TYPES.has(attr.data_type)) continue;

    const kind = kindForDataType(attr.data_type);

    if (!kind) continue;
    if (!ATTRIBUTE_FIELD_KEY_PATTERN.test(attr.field_key)) continue;

    const key = `${ATTRIBUTE_FIELD_PREFIX}${attr.field_key}`;

    // Two object types in one schema may declare the same field_key. They share
    // one JSON key in attribute_values, so a single entry is correct — first
    // definition wins and the kinds are expected to agree.
    if (!map.has(key)) {
      const opts = attr.options ?? {};

      map.set(key, {
        key,
        kind,
        fieldKey: attr.field_key,
        attributeId: attr.id,
        formula: opts['formula'] as string | undefined,
        // Mirrors evaluateFormulas, which defaults an unset result_type to float.
        resultType: (opts['result_type'] as string | undefined) ?? 'float',
      });
    }

    // A reference can be read from either end, so register a second token for
    // the reverse reading. Same attribute, opposite side of the join.
    if (kind === 'attr_reference') {
      const reverseKey = `${REVERSE_ATTRIBUTE_FIELD_PREFIX}${attr.field_key}`;

      if (!map.has(reverseKey)) {
        map.set(reverseKey, {
          key: reverseKey,
          kind: 'attr_reference_reverse',
          fieldKey: attr.field_key,
          attributeId: attr.id,
        });
      }
    }
  }

  return map;
}

/**
 * Structurally validates an untrusted rule group.
 *
 * The DTO can only declare this as a plain object: a self-referential
 * `@Type()` under `whitelist: true` silently strips nested `rules`, so the real
 * check has to happen here — the same approach the saved-filters service takes.
 *
 * Nested groups are REJECTED rather than ignored. The UI only ever emits a flat
 * group, so anything nested is a hand-crafted request and should fail loudly.
 */
export function assertValidFilterGroup(
  value: unknown,
): asserts value is IAssetFilterGroup {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException('filter must be an object');
  }

  const group = value as Record<string, unknown>;

  if (group['combinator'] !== 'and' && group['combinator'] !== 'or') {
    throw new BadRequestException("filter.combinator must be 'and' or 'or'");
  }

  if ('not' in group && group['not'] !== undefined && group['not'] !== false) {
    throw new BadRequestException('filter.not is not supported');
  }

  if (!Array.isArray(group['rules'])) {
    throw new BadRequestException('filter.rules must be an array');
  }

  const rules = group['rules'] as unknown[];

  if (rules.length > MAX_FILTER_RULES) {
    throw new BadRequestException(
      `filter.rules exceeds the maximum of ${MAX_FILTER_RULES}`,
    );
  }

  for (const entry of rules) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new BadRequestException('filter.rules entries must be objects');
    }

    const rule = entry as Record<string, unknown>;

    if ('combinator' in rule || 'rules' in rule) {
      throw new BadRequestException(
        'Nested filter groups are not supported for asset objects',
      );
    }

    if (typeof rule['field'] !== 'string' || rule['field'].length === 0) {
      throw new BadRequestException('Each filter rule needs a field');
    }

    if (typeof rule['operator'] !== 'string' || rule['operator'].length === 0) {
      throw new BadRequestException('Each filter rule needs an operator');
    }
  }
}

/**
 * Parses the `filter` query parameter, which arrives as a JSON string.
 *
 * Returns null when absent or blank, so an empty filter is a no-op rather than
 * an error or a match-nothing.
 */
export function parseFilterParam(
  raw: string | undefined,
): IAssetFilterGroup | null {
  if (!raw || raw.trim() === '') return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException('filter must be valid JSON');
  }

  assertValidFilterGroup(parsed);

  if (parsed.rules.length === 0) return null;

  return parsed;
}
