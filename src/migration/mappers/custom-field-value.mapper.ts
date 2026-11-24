/**
 * @fileoverview Jira custom-field VALUES → the shapes XISUITE's renderers actually accept.
 *
 * Pure and dependency-free ON PURPOSE (same reason as `crosswalk-gate.util.ts`): the stages that use
 * this import NestJS services and transitively jsdom, which will not transform under this repo's
 * Jest config. Keeping the rules here makes them directly testable.
 *
 * WHY THIS EXISTS: storing Jira's raw JSON is not "migrating the value". Jira returns an option as
 * `{id, self, value, disabled}` and a multi-select as an ARRAY of those. `CustomFieldInput` renders
 * a select via `field.options.find(o => o.value === value)?.label` and a multiselect by mapping an
 * array of those same scalars — so handing it an object renders nothing at best. Verified live: the
 * migrated task detail page threw
 *   `Objects are not valid as a React child (found: object with keys {id, self, value, disabled})`
 * 14 times and rendered BLANK, even though every value was present and correct in the database.
 *
 * THE KEY IDENTITY: `field-type.registry.ts` builds each option as `{ value: opt.id, label: opt.value }`
 * — the XISUITE option *value* is the Jira option *id*. So an option value maps to `String(raw.id)`,
 * which is exactly what the renderer looks up. Getting this backwards (using Jira's `value`) would
 * silently match nothing and display raw ids.
 */

/** A Jira option/entity blob: `{id, value}` for options, `{name}`/`{key}` for entities. */
interface JiraValueObject {
  id?: string | number;
  value?: string;
  name?: string;
  key?: string;
  accountId?: string;
  child?: JiraValueObject;
}

const isObject = (v: unknown): v is JiraValueObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Stringify ONLY primitives. Anything object-shaped returns null so it can be handled structurally
 * — `String({})` yields the literal "[object Object]", which would be written straight into a task
 * field and shown to the user as data.
 */
const toScalarString = (v: unknown): string | null => {
  if (typeof v === 'string') return v;

  if (
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    typeof v === 'bigint'
  ) {
    return String(v);
  }

  return null;
};

/** The XISUITE option value for a Jira option — its ID, matching `field.options[].value`. */
function optionValue(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;

  if (isObject(raw)) {
    return raw.id !== undefined && raw.id !== null ? String(raw.id) : null;
  }

  // Already a scalar (some Jira fields return bare strings) — trust it.
  return toScalarString(raw);
}

/** Human-readable text for entity pickers (project/version/group) that degrade to a label. */
function displayText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;

  if (Array.isArray(raw)) {
    const parts = raw.map(displayText).filter((s): s is string => !!s);

    return parts.length > 0 ? parts.join(', ') : null;
  }

  if (isObject(raw)) {
    const text = raw.name ?? raw.value ?? raw.key;

    return text !== undefined && text !== null ? String(text) : null;
  }

  return toScalarString(raw);
}

/** The source-side stable id for a Jira user, matching `JiraAdapterBase.userStableId`. */
export function jiraUserStableId(raw: unknown): string | null {
  if (!isObject(raw)) return toScalarString(raw);

  const id = raw.name ?? raw.key ?? raw.accountId;

  return id !== undefined && id !== null ? String(id) : null;
}

/**
 * Convert one raw Jira value to the shape XISUITE stores/renders for `fieldType`.
 *
 * @param resolveUser - Jira user stable id → XISUITE user id (the crosswalk). Users that do not
 *   resolve are DROPPED rather than written as a raw Jira username: the renderer treats the value
 *   as a user id, so a username would render as a broken/missing user forever.
 * @returns the value to store, or `undefined` to omit the field entirely (never write `null` —
 *   an absent key and an explicit null render differently downstream).
 */
export function toXisuiteFieldValue(
  raw: unknown,
  fieldType: string,
  resolveUser: (sourceId: string) => string | null = () => null,
): unknown {
  if (raw === null || raw === undefined) return undefined;
  if (Array.isArray(raw) && raw.length === 0) return undefined;

  switch (fieldType) {
    case 'multiselect': {
      const items = Array.isArray(raw) ? raw : [raw];
      const values = items
        .map(optionValue)
        .filter((v): v is string => v !== null);

      return values.length > 0 ? values : undefined;
    }

    case 'select':
    case 'radio':
      return optionValue(raw) ?? undefined;

    case 'cascading_select': {
      // Jira nests the child under the parent. The renderer does a FLAT option lookup and the
      // options array holds both levels, so the child id is the most specific value that still
      // resolves; `parent_value` on the option lets a hierarchical renderer rebuild "Alpha > Alpha One".
      if (isObject(raw) && raw.child) {
        return optionValue(raw.child) ?? optionValue(raw) ?? undefined;
      }

      return optionValue(raw) ?? undefined;
    }

    case 'user_select': {
      const sourceId = jiraUserStableId(raw);

      return sourceId ? (resolveUser(sourceId) ?? undefined) : undefined;
    }

    case 'user_multi': {
      const items = Array.isArray(raw) ? raw : [raw];
      const ids = items
        .map(jiraUserStableId)
        .filter((s): s is string => !!s)
        .map(resolveUser)
        .filter((id): id is string => !!id);

      return ids.length > 0 ? ids : undefined;
    }

    case 'checkbox':
      // Jira's job/hidden switches arrive as the STRINGS "true"/"false"; `Boolean("false")` is true.
      if (typeof raw === 'string') return raw.toLowerCase() === 'true';

      return Boolean(raw);

    case 'label':
      return displayText(raw) ?? undefined;

    default: {
      // Scalars (string/number/date/datetime/url/editor) arrive usable. An OBJECT here means the
      // registry degraded an entity picker to text — render its name rather than "[object Object]".
      if (Array.isArray(raw) || isObject(raw)) {
        return displayText(raw) ?? undefined;
      }

      return raw;
    }
  }
}
