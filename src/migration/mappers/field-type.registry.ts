/**
 * @fileoverview Jira field → XISUITE custom-field mapping. Pure + source-agnostic: it reads a
 * `NormalizedField` and decides one of three outcomes — migrate it as a custom field, recognise it
 * as something XISUITE models natively (so a later phase owns it), or skip it.
 *
 * The three-way split is the whole point. A live census of the Jira 8.22.4 test instance found 13
 * custom fields and EVERY one was plugin-internal plumbing (`gh-*` agile, `jpo-*` portfolio,
 * devsummary, teams) — zero user-defined fields. Migrating `custom:*` indiscriminately would
 * manufacture bogus "Sprint"/"Epic Link"/"Rank" custom fields that duplicate native concepts and
 * collide with what the boards/sprints phase creates. Over-migration is the real failure mode here,
 * not under-mapping — so exclusion is enforced BEFORE any type mapping runs.
 *
 * The vendor/system catalog below still has to be complete: customer instances DO have real
 * user-defined fields, and this tool ships to them.
 */

import type {
  FieldOption,
  FieldType,
  ValidationRules,
} from '../../custom-fields/models/custom-field.model';
import { FIELD_TYPES_WITH_OPTIONS } from '../../custom-fields/models/custom-field.model';
import type {
  NormalizedField,
  NormalizedFieldOption,
} from '../model/normalized';

/** Jira's stock custom-field type namespace. */
const CFT = 'com.atlassian.jira.plugin.system.customfieldtypes:';

/**
 * What a later phase owns natively. These are NOT custom fields — XISUITE models each as a
 * first-class concept, so the crosswalk records the correspondence and the issues/boards phases
 * consume it.
 */
export type NativeTarget = 'sprint' | 'parent_task_id' | 'rank' | 'title';

export type FieldMappingOutcome =
  | {
      kind: 'custom_field';
      fieldKey: string;
      fieldType: FieldType;
      options: FieldOption[];
      validationRules: ValidationRules;
      /** Set when fidelity was reduced; the stage logs this to `migration_logs`. */
      lossy?: string;
    }
  | { kind: 'native'; native: NativeTarget; reason: string }
  | { kind: 'skip'; reason: string };

/**
 * Agile/portfolio plugin fields that XISUITE models natively. Measured in use on the test box:
 * gh-epic-link ×10, gh-sprint ×5, gh-epic-label ×2 across KAN+SDP createmeta.
 */
const NATIVE_PASSTHROUGH: Record<
  string,
  { native: NativeTarget; reason: string }
> = {
  'com.pyxis.greenhopper.jira:gh-sprint': {
    native: 'sprint',
    reason:
      'Jira Sprint field → native sprint membership (boards/sprints phase)',
  },
  'com.pyxis.greenhopper.jira:gh-epic-link': {
    native: 'parent_task_id',
    reason:
      'Jira Epic Link → native parent/child task hierarchy (issues phase)',
  },
  'com.pyxis.greenhopper.jira:gh-lexo-rank': {
    native: 'rank',
    reason: 'Jira Rank (LexoRank) → native board ranking (boards phase)',
  },
  'com.pyxis.greenhopper.jira:gh-epic-label': {
    native: 'title',
    reason: 'Jira Epic Name → the epic task title (issues phase)',
  },
};

/**
 * Plugin-internal fields with no XISUITE counterpart and no user-authored content to preserve.
 * Skipped deliberately (and logged) rather than migrated into meaningless custom fields.
 */
const EXCLUDED_PREFIXES: { prefix: string; reason: string }[] = [
  {
    prefix: 'com.atlassian.jpo:',
    reason: 'Advanced Roadmaps (JPO) plugin-internal scheduling field',
  },
  {
    prefix: 'com.atlassian.jira.plugins.jira-development-integration-plugin:',
    reason: 'Development-tools summary is a computed blob, not stored data',
  },
];

const EXCLUDED_EXACT: Record<string, string> = {
  'com.pyxis.greenhopper.jira:gh-epic-status':
    'Epic status is derived from the epic task status',
  'com.pyxis.greenhopper.jira:gh-epic-color':
    'Cosmetic epic colour has no target equivalent',
};

/** Jira stock custom-field types → XISUITE types. */
const VENDOR_MAP: Record<string, FieldType> = {
  [`${CFT}textfield`]: 'string',
  [`${CFT}textarea`]: 'editor',
  [`${CFT}select`]: 'select',
  [`${CFT}multiselect`]: 'multiselect',
  [`${CFT}radiobuttons`]: 'radio',
  // NOT 'checkbox': XISUITE's `checkbox` is a standalone boolean and is absent from
  // FIELD_TYPES_WITH_OPTIONS, so mapping here would drop every allowed value on the floor
  // (options are only emitted for option-bearing types) AND skip the empty-option downgrade
  // that flags lossiness — silent data loss. Jira's multicheckboxes is pick-many-from-a-list,
  // which is exactly `multiselect`.
  [`${CFT}multicheckboxes`]: 'multiselect',
  [`${CFT}datepicker`]: 'date',
  [`${CFT}datetime`]: 'datetime',
  [`${CFT}float`]: 'number',
  [`${CFT}importid`]: 'number',
  [`${CFT}url`]: 'url',
  [`${CFT}labels`]: 'label',
  [`${CFT}userpicker`]: 'user_select',
  [`${CFT}multiuserpicker`]: 'user_multi',
  [`${CFT}cascadingselect`]: 'cascading_select',
  [`${CFT}readonlyfield`]: 'string',
  // Group/version/project pickers reference source-side entities XISUITE has no equivalent for →
  // preserve the human-readable value as a label rather than drop the data.
  [`${CFT}grouppicker`]: 'label',
  [`${CFT}multigrouppicker`]: 'label',
  [`${CFT}version`]: 'label',
  [`${CFT}multiversion`]: 'label',
  [`${CFT}project`]: 'label',
  'com.atlassian.teams:rm-teams-custom-field-team': 'label',
};

/** Vendor keys whose value is an opaque source-side reference → flagged lossy when migrated. */
const LOSSY_VENDOR = new Set([
  `${CFT}grouppicker`,
  `${CFT}multigrouppicker`,
  `${CFT}version`,
  `${CFT}multiversion`,
  `${CFT}project`,
  'com.atlassian.teams:rm-teams-custom-field-team',
]);

/** `schema.type` (+ `schema.items`) fallback when the vendor key is unknown. */
const SYSTEM_TYPE_MAP: Record<string, FieldType> = {
  string: 'string',
  number: 'number',
  date: 'date',
  datetime: 'datetime',
  user: 'user_select',
  option: 'select',
  'option-with-child': 'cascading_select',
};

/** `schema.type: 'array'` dispatches on `schema.items`. */
const ARRAY_ITEM_MAP: Record<string, FieldType> = {
  string: 'label',
  user: 'user_multi',
  option: 'multiselect',
  group: 'label',
  version: 'label',
};

/**
 * An options-requiring type whose source had no `allowedValues` must degrade — the service throws
 * `BadRequestException` on an empty options array, which would fail the whole item for what is
 * really a fidelity loss. Degrade + log instead of dying.
 */
const EMPTY_OPTION_DOWNGRADE: Partial<Record<FieldType, FieldType>> = {
  select: 'string',
  radio: 'string',
  multiselect: 'label',
  cascading_select: 'string',
};

/**
 * `custom_fields.field_key` is regex-constrained (`^[a-z][a-z0-9_]*$`) at the DTO layer. Stage code
 * calls the service directly and bypasses that check, so conform here — a bad key would otherwise
 * only surface as a DB/API error much later.
 */
export function toFieldKey(sourceId: string): string {
  const slug = sourceId.toLowerCase().replace(/[^a-z0-9_]+/g, '_');

  return `cf_${slug}`.replace(/_+$/, '');
}

/**
 * Jira nests cascading options (`children[]`); XISUITE flattens them (`parent_value` + `level`).
 * Option `value` keys on the Jira option **id**, never the display value — the test data is German
 * and display values are localized and mutable.
 */
function buildOptions(
  allowed: NormalizedFieldOption[] | undefined,
): FieldOption[] {
  const out: FieldOption[] = [];

  for (const opt of allowed ?? []) {
    out.push({
      value: opt.id,
      label: opt.value,
      ...(opt.color ? { color: opt.color } : {}),
      level: 0,
    });

    for (const child of opt.children ?? []) {
      out.push({
        value: child.id,
        label: child.value,
        ...(child.color ? { color: child.color } : {}),
        parent_value: opt.id,
        level: 1,
      });
    }
  }

  return out;
}

function resolveType(field: NormalizedField): {
  type: FieldType;
  lossy?: string;
} {
  const vendor = field.schemaCustom;

  if (vendor && VENDOR_MAP[vendor]) {
    return {
      type: VENDOR_MAP[vendor],
      ...(LOSSY_VENDOR.has(vendor)
        ? {
            lossy: `"${vendor}" references a Jira-side entity with no XISUITE equivalent — migrated as a text label`,
          }
        : {}),
    };
  }

  if (field.schemaType === 'array') {
    const mapped = field.schemaItems
      ? ARRAY_ITEM_MAP[field.schemaItems]
      : undefined;

    if (mapped) return { type: mapped };

    return {
      type: 'label',
      lossy: `Unrecognised array item type "${field.schemaItems ?? '?'}" — migrated as labels`,
    };
  }

  const mapped = field.schemaType
    ? SYSTEM_TYPE_MAP[field.schemaType]
    : undefined;

  if (mapped) return { type: mapped };

  return {
    type: 'string',
    lossy: `Unrecognised field type "${field.schemaCustom ?? field.schemaType ?? '?'}" — migrated as text`,
  };
}

/**
 * Decide what to do with one Jira field. Never throws: an unmappable field degrades to text with a
 * lossy note, because failing the item would strand the whole issue-type's field set.
 */
export function mapField(field: NormalizedField): FieldMappingOutcome {
  // System fields (summary/assignee/priority/issuetype/components/…) are native task columns owned
  // by the issues phase — they are not custom fields. The census measured 22×system:string,
  // 20×system:user etc., so this branch carries most of the traffic.
  if (!field.isCustom) {
    return {
      kind: 'skip',
      reason: `System field "${field.name}" maps to a native task column (issues phase)`,
    };
  }

  const vendor = field.schemaCustom;

  if (vendor) {
    const native = NATIVE_PASSTHROUGH[vendor];

    if (native)
      return { kind: 'native', native: native.native, reason: native.reason };

    const exact = EXCLUDED_EXACT[vendor];

    if (exact) return { kind: 'skip', reason: exact };

    const prefixed = EXCLUDED_PREFIXES.find((e) => vendor.startsWith(e.prefix));

    if (prefixed) return { kind: 'skip', reason: prefixed.reason };
  }

  const { type, lossy } = resolveType(field);
  const options = buildOptions(field.allowedValues);

  let finalType = type;
  let finalLossy = lossy;

  if (FIELD_TYPES_WITH_OPTIONS.includes(type) && options.length === 0) {
    const downgraded = EMPTY_OPTION_DOWNGRADE[type] ?? 'string';

    finalType = downgraded;
    finalLossy = `"${field.name}" is a ${type} with no selectable values on the source — migrated as ${downgraded}`;
  }

  const validationRules: ValidationRules = field.required
    ? { required: true }
    : {};

  return {
    kind: 'custom_field',
    fieldKey: toFieldKey(field.sourceId),
    fieldType: finalType,
    // Options only carry meaning for option-bearing types; a downgrade discards them by design.
    options: FIELD_TYPES_WITH_OPTIONS.includes(finalType) ? options : [],
    validationRules,
    ...(finalLossy ? { lossy: finalLossy } : {}),
  };
}
