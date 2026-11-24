/**
 * @fileoverview Source-agnostic field definition (system or custom).
 * Maps in Phase 5 through the field-type registry (`schemaType`/`schemaCustom` → one of the
 * 19 XISUITE custom-field types) to `CustomFieldsService.create` with `field_key = cf_{id}`.
 */

export interface NormalizedFieldOption {
  /** Stable option id from the source. */
  id: string;
  value: string;
  color?: string;
  /** Cascading-select children. */
  children?: NormalizedFieldOption[];
}

export interface NormalizedField {
  /** Stable field id — system key ("summary") or custom id ("customfield_10012"). */
  sourceId: string;
  name: string;
  isCustom: boolean;
  /** Jira `schema.type` — string/number/date/datetime/array/option/user/… */
  schemaType: string;
  /** Jira `schema.custom` plugin key (e.g. "…:multiselect") — custom fields only. */
  schemaCustom?: string;
  /** Jira `schema.items` for array types (e.g. "option", "user", "string"). */
  schemaItems?: string;
  required: boolean;
  allowedValues?: NormalizedFieldOption[];
  /** Issue type sourceIds this field appears on (from createmeta) — dedupe key stays sourceId. */
  issueTypeSourceIds?: string[];
}
