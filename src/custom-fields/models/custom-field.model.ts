/**
 * @fileoverview Domain models and types for custom fields. Defines the 22
 * supported field types, field option shape, validation rule schema, and the
 * `CustomField` row contract matching the `custom_fields` table.
 * @module src/custom-fields/models/custom-field.model
 * @author Prince Jadiya
 */

/**
 * Supported custom field types — the SINGLE source of truth.
 *
 * `CreateCustomFieldDto` and `UpdateCustomFieldDto` both `@IsIn(FIELD_TYPES)`
 * against this array. They used to each keep their own copy, and the update
 * copy was never widened when `grid`/`file`/`file_multi` were added, so editing
 * a field of a new type 400'd. Deriving `FieldType` from the array makes the
 * two impossible to drift apart.
 *
 * Adding a value here is still not enough on its own — it must also be added to
 * the frontend `FieldTypeEnum` and to the `custom_fields_field_type_check` DB
 * constraint (via a migration), or inserts fail with a raw check-constraint
 * violation.
 */
export const FIELD_TYPES = [
  'string',
  'number',
  'editor',
  'select',
  'multiselect',
  'user_select',
  'user_multi',
  'checkbox',
  'radio',
  'label',
  'date',
  'time',
  'datetime',
  'url',
  'cascading_select',
  'wiki_page',
  'task',
  'list_item',
  'list_item_multi',
  'grid',
  'file',
  'file_multi',
  'asset',
  'asset_multi',
  'sla_time',
  'issue_group',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * Scope of a custom field — organization-wide or scoped to a single space.
 */
export type FieldScope = 'organization' | 'space';

/**
 * A single option entry for select/multiselect/radio/cascading_select fields.
 */
export interface FieldOption {
  value: string;
  label: string;
  color?: string;
  icon?: string;
  isDefault?: boolean;
  parent_value?: string;
  level?: number;

  // `issue_group` only. `value` is a UUID, so a rename never touches a ticket.
  description?: string | null;
  lead_user_id?: string | null;
  status?: 'active' | 'archived';
  created_by?: string | null;

  // `grid` only — a grid column is an option (value = column key, label =
  // header) plus a cell editor, so grid columns reuse the `options` column
  // instead of introducing a second config column.
  column_type?: GridColumnType;
  width?: number;
  choices?: Array<{ value: string; label: string }>;
}

/**
 * Cell editor used for a `grid` column. Same single-source-of-truth treatment
 * as `FIELD_TYPES` — `FieldOptionDto.column_type` validates against this array.
 */
export const GRID_COLUMN_TYPES = [
  'text',
  'number',
  'date',
  'select',
  'checkbox',
] as const;

export type GridColumnType = (typeof GRID_COLUMN_TYPES)[number];

/** Hard caps mirrored on the frontend (`src/models/custom-field.model.ts`). */
export const GRID_MAX_ROWS = 100;
export const FILE_MULTI_MAX_ITEMS = 25;

/** Column width bounds (px) accepted for a `grid` column definition. */
export const GRID_MIN_COLUMN_WIDTH = 80;
export const GRID_MAX_COLUMN_WIDTH = 600;

/** One row of a `grid` field value. */
export interface GridRow {
  id: string;
  values: Record<string, string | number | boolean | null>;
}

/**
 * A file reference stored in a `file` / `file_multi` value. Uploads always land
 * in the PRIVATE `attachments` bucket via the `/attachments` API — never the
 * public `wiki-attachments` bucket, whose public URLs bypass permission checks.
 */
export type FileFieldRef =
  | {
      source: 'file-explorer';
      nodeId: string;
      name: string;
      mime?: string | null;
      size?: number | null;
    }
  | {
      source: 'attachment';
      attachmentId: string;
      name: string;
      mime?: string | null;
      size?: number | null;
    };

/**
 * Validation rules persisted in `custom_fields.validation_rules`.
 */
export interface ValidationRules {
  /** `issue_group` only. */
  issue_group?: { selection_mode?: 'single' | 'multi' };
  required?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  patternMessage?: string;
  patternMessage_i18n?: Record<string, string>;
  minDate?: string;
  maxDate?: string;
}

/**
 * Row contract for the `custom_fields` table.
 */
export interface CustomField {
  id: string;
  organization_id: string;
  space_id: string | null;
  scope: FieldScope;
  name: string;
  field_key: string;
  field_type: FieldType;
  description: string | null;
  description_i18n: Record<string, string>;
  name_i18n: Record<string, string>;
  default_value: unknown;
  options: FieldOption[];
  validation_rules: ValidationRules;
  contexts: string[];
  is_system: boolean;
  is_active: boolean;
  sort_order: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  deleted_at: string | null;
  deleted_by: string | null;
}

/** Field types that require an `options` array to be defined. */
export const FIELD_TYPES_WITH_OPTIONS: FieldType[] = [
  'select',
  'multiselect',
  'radio',
  'cascading_select',
  'issue_group',
];

/** Entity types that custom fields can be attached to via level assignments. */
export const ENTITY_TYPES = ['process', 'task', 'list_item'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * Known app-level values for `custom_fields.contexts`. The column is a free
 * jsonb string array (no DB CHECK) and DTOs deliberately do not enforce this
 * list — it documents the vocabulary shared with the frontend. `wiki` marks a
 * field as available on wiki pages (Wiki 2.0).
 */
export const FIELD_CONTEXTS = ['process', 'task', 'list', 'wiki'] as const;
export type FieldContext = (typeof FIELD_CONTEXTS)[number];

/** Layout sections used by level field assignments. */
export const SECTIONS = ['header', 'main', 'footer', 'sidebar'] as const;
export type Section = (typeof SECTIONS)[number];
