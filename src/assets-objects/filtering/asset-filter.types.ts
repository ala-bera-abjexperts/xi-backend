/**
 * @fileoverview Rule-group shape for asset-object filtering.
 *
 * Deliberately self-contained: `src/saved-filters/**` is off-limits for this
 * feature, so these types are declared locally rather than imported. The shape
 * is kept identical to the saved-filter / form-builder rule model so the two
 * stay interchangeable on the wire and can share test vectors.
 */

/** A single leaf condition. `value` is absent for isEmpty / isNotEmpty. */
export interface IAssetFilterRule {
  field: string;
  operator: string;
  value?: unknown;
}

/**
 * A flat group of conditions joined by one combinator.
 *
 * Intentionally NOT recursive. The UI (mirroring the form-builder Logic tab)
 * emits a flat list, and the service guard rejects nested groups rather than
 * silently ignoring them.
 */
export interface IAssetFilterGroup {
  combinator: 'and' | 'or';
  rules: IAssetFilterRule[];
}

/** How a filterable field is physically stored, which decides its SQL encoding. */
export type AssetFieldKind =
  | 'column_text'
  | 'column_uuid'
  | 'column_timestamp'
  | 'attr_text'
  | 'attr_number'
  | 'attr_bool'
  | 'attr_date'
  | 'attr_array'
  /** Values live in asset_object_references — filtered via an !inner embed. */
  | 'attr_reference'
  /** Same rows read the other way round: the candidate is the reference TARGET. */
  | 'attr_reference_reverse'
  /** Computed per read with jexl — filtered in memory only. */
  | 'attr_formula';

/**
 * Which end of `asset_object_references` the candidate row sits on.
 *
 * `outgoing` — candidate is the source, pointing at the given object (the
 * original behaviour: "servers whose rack is X").
 * `incoming` — candidate is the target, pointed at by the given object
 * ("the submodules listed on X").
 */
export type AssetReferenceDirection = 'outgoing' | 'incoming';

export interface IAssetFilterField {
  /** Field token used on the wire, e.g. `name` or `attr_cpu_count`. */
  key: string;
  kind: AssetFieldKind;
  /** JSON key inside attribute_values; undefined for real columns. */
  fieldKey?: string;
  /** Real column name; undefined for attribute-backed fields. */
  column?: string;
  /** Attribute row id — required to scope a reference embed to this attribute. */
  attributeId?: string;
  /** jexl expression, for formula fields. */
  formula?: string;
  /** Formula result type, which decides comparison semantics. */
  resultType?: string;
}

/**
 * How a rule group must be executed.
 *
 * `sql`    — every rule is expressible as a PostgREST fragment (optionally with
 *            one reference embed). Correct at any scale.
 * `memory` — at least one rule cannot be expressed in SQL, so rows are fetched
 *            bounded and ALL rules are evaluated in memory. Results are capped.
 */
export type AssetFilterMode = 'sql' | 'memory';

/** A reference rule resolved into an !inner embed spec. */
export interface IAssetReferenceEmbed {
  attributeId: string;

  /** The object on the far end of the link, whichever end that is. */
  targetObjectId: string;

  /** Which FK the candidate joins on. Absent means `outgoing` (the original shape). */
  direction?: AssetReferenceDirection;
}

export interface IAssetFilterPlan {
  mode: AssetFilterMode;
  /** Fragments to apply via `.or(...)`; empty in memory mode. */
  fragments: string[];
  /** At most one — PostgREST can only inner-join the child set once usefully. */
  embed: IAssetReferenceEmbed | null;
  /** Rules to evaluate in memory (all of them, in memory mode). */
  memoryRules: IAssetFilterRule[];
  combinator: 'and' | 'or';
}

export type AssetFilterFieldMap = Map<string, IAssetFilterField>;

/** Operators the translator understands. Anything else is rejected with 400. */
export const ASSET_FILTER_OPERATORS = [
  'eq',
  'neq',
  'contains',
  'notContains',
  'beginsWith',
  'endsWith',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'notBetween',
  'in',
  'notIn',
  'isEmpty',
  'isNotEmpty',
] as const;

export type AssetFilterOperator = (typeof ASSET_FILTER_OPERATORS)[number];

/** Operators that take no value — a value, if sent, is ignored. */
export const NO_VALUE_OPERATORS = new Set(['isEmpty', 'isNotEmpty']);

/** Guard rails against pathological payloads. */
export const MAX_FILTER_RULES = 50;
export const MAX_IN_VALUES = 200;
export const MAX_VALUE_LENGTH = 1000;

export const MAX_FILTER_URL_BYTES = 6000;
