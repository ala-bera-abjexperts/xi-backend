/**
 * @fileoverview Custom field validation engine. Validates values against
 * field definitions for all 22 supported field types, and coerces raw values
 * loaded from the DB into the field's native runtime type.
 * @module src/custom-fields/utils/custom-field-validation
 * @author Prince Jadiya
 */

import {
  FILE_MULTI_MAX_ITEMS,
  GRID_MAX_ROWS,
} from '../models/custom-field.model';
import type {
  CustomField,
  FieldOption,
  FieldType,
  ValidationRules,
} from '../models/custom-field.model';
import { issueGroupValueError } from './issue-group.util';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Error thrown by the validation engine. Carries the field key and display
 * name so callers can surface actionable field-scoped messages.
 */
export class FieldValidationError extends Error {
  constructor(
    public fieldKey: string,
    public fieldName: string,
    message: string,
  ) {
    super(message);
    this.name = 'FieldValidationError';
  }
}

/**
 * Validate a value against a custom field definition.
 *
 * @param field The custom field definition.
 * @param value The raw value to validate. `null` / `undefined` are skipped —
 *   the caller is responsible for the required-check.
 * @throws {FieldValidationError} When the value does not satisfy the field's
 *   type rules or its configured `validation_rules`.
 * @example
 * validateFieldValue(stringField, 'hello');
 */
export function validateFieldValue(
  field: Pick<
    CustomField,
    'field_type' | 'field_key' | 'name' | 'validation_rules' | 'options'
  >,
  value: unknown,
): void {
  if (field.field_type === 'sla_time') throw new FieldValidationError(field.field_key, field.name, 'SLA values are server-computed');
  if (value === null || value === undefined) return;

  const { field_type, name, field_key, validation_rules, options } = field;

  switch (field_type) {
    case 'string':
      validateString(field_key, name, value, validation_rules);
      return;
    case 'number':
      validateNumber(field_key, name, value, validation_rules);
      return;
    case 'editor':
      validateEditor(field_key, name, value, validation_rules);
      return;
    case 'select':
      validateSelect(field_key, name, value, options);
      return;
    case 'multiselect':
      validateMultiSelect(field_key, name, value, options);
      return;
    case 'issue_group': {
      const error = issueGroupValueError(field, value);

      if (error) throw new FieldValidationError(field_key, name, error);
      return;
    }
    case 'user_select':
      validateUuid(field_key, name, value);
      return;
    case 'user_multi':
      validateUuidArray(field_key, name, value);
      return;
    case 'checkbox':
      validateCheckbox(field_key, name, value);
      return;
    case 'radio':
      validateSelect(field_key, name, value, options);
      return;
    case 'date':
    case 'datetime':
      validateDateTime(field_key, name, value, validation_rules);
      return;
    case 'time':
      validateTime(field_key, name, value);
      return;
    case 'url':
      validateUrl(field_key, name, value);
      return;
    case 'cascading_select':
      validateCascadingSelect(field_key, name, value);
      return;
    case 'label':
      return;
    case 'wiki_page':
    case 'task':
    case 'list_item':
    case 'asset':
      validateUuid(field_key, name, value);
      return;
    case 'asset_multi':
      validateUuidArray(field_key, name, value);
      return;
    case 'grid':
      validateGrid(field_key, name, value);
      return;
    case 'file':
      validateFileRef(field_key, name, value);
      return;
    case 'file_multi':
      validateFileRefArray(field_key, name, value);
      return;
    default:
      return;
  }
}

function validateString(
  key: string,
  name: string,
  value: unknown,
  rules?: ValidationRules,
): void {
  if (typeof value !== 'string') {
    throw new FieldValidationError(key, name, `${name} must be a string`);
  }
  if (!rules) return;
  if (rules.minLength !== undefined && value.length < rules.minLength) {
    throw new FieldValidationError(
      key,
      name,
      `${name} must be at least ${rules.minLength} characters`,
    );
  }
  if (rules.maxLength !== undefined && value.length > rules.maxLength) {
    throw new FieldValidationError(
      key,
      name,
      `${name} must be at most ${rules.maxLength} characters`,
    );
  }
  if (rules.pattern && !new RegExp(rules.pattern).test(value)) {
    throw new FieldValidationError(
      key,
      name,
      rules.patternMessage ?? `${name} does not match the required pattern`,
    );
  }
}

function validateNumber(
  key: string,
  name: string,
  value: unknown,
  rules?: ValidationRules,
): void {
  const num = typeof value === 'number' ? value : parseFloat(value as string);
  if (Number.isNaN(num)) {
    throw new FieldValidationError(key, name, `${name} must be a valid number`);
  }
  if (rules?.min !== undefined && num < rules.min) {
    throw new FieldValidationError(
      key,
      name,
      `${name} must be at least ${rules.min}`,
    );
  }
  if (rules?.max !== undefined && num > rules.max) {
    throw new FieldValidationError(
      key,
      name,
      `${name} must be at most ${rules.max}`,
    );
  }
}

function validateEditor(
  key: string,
  name: string,
  value: unknown,
  rules?: ValidationRules,
): void {
  if (typeof value !== 'string') {
    throw new FieldValidationError(key, name, `${name} must be a string`);
  }
  if (rules?.maxLength !== undefined && value.length > rules.maxLength) {
    throw new FieldValidationError(
      key,
      name,
      `${name} must be at most ${rules.maxLength} characters`,
    );
  }
}

function validateSelect(
  key: string,
  name: string,
  value: unknown,
  options?: FieldOption[],
): void {
  if (typeof value !== 'string') {
    throw new FieldValidationError(key, name, `${name} must be a string`);
  }
  if (Array.isArray(options) && options.length > 0) {
    const valid = options.map((o) => o.value);
    if (!valid.includes(value)) {
      throw new FieldValidationError(key, name, `${name} has an invalid value`);
    }
  }
}

function validateMultiSelect(
  key: string,
  name: string,
  value: unknown,
  options?: FieldOption[],
): void {
  if (!Array.isArray(value)) {
    throw new FieldValidationError(key, name, `${name} must be an array`);
  }
  if (Array.isArray(options) && options.length > 0) {
    const valid = options.map((o) => o.value);
    for (const v of value as unknown[]) {
      if (typeof v !== 'string' || !valid.includes(v)) {
        throw new FieldValidationError(
          key,
          name,
          `${name} contains invalid values`,
        );
      }
    }
  }
}

function validateUuid(key: string, name: string, value: unknown): void {
  if (typeof value !== 'string') {
    throw new FieldValidationError(
      key,
      name,
      `${name} must be a user ID (string)`,
    );
  }
  if (!UUID_REGEX.test(value)) {
    throw new FieldValidationError(key, name, `${name} must be a valid UUID`);
  }
}

function validateUuidArray(key: string, name: string, value: unknown): void {
  if (!Array.isArray(value)) {
    throw new FieldValidationError(
      key,
      name,
      `${name} must be an array of user IDs`,
    );
  }
  for (const v of value) {
    if (typeof v !== 'string' || !UUID_REGEX.test(v)) {
      throw new FieldValidationError(
        key,
        name,
        `${name} contains invalid user IDs`,
      );
    }
  }
}

function validateCheckbox(key: string, name: string, value: unknown): void {
  if (
    typeof value !== 'boolean' &&
    value !== 'true' &&
    value !== 'false' &&
    value !== 0 &&
    value !== 1
  ) {
    throw new FieldValidationError(key, name, `${name} must be a boolean`);
  }
}

function validateDateTime(
  key: string,
  name: string,
  value: unknown,
  rules?: ValidationRules,
): void {
  let d: Date;
  if (value instanceof Date) {
    d = value;
  } else if (typeof value === 'string') {
    d = new Date(value);
  } else {
    throw new FieldValidationError(key, name, `${name} must be a valid date`);
  }
  if (Number.isNaN(d.getTime())) {
    throw new FieldValidationError(key, name, `${name} must be a valid date`);
  }
  if (rules?.minDate) {
    const min = new Date(rules.minDate);
    if (d < min) {
      throw new FieldValidationError(
        key,
        name,
        `${name} must be after ${min.toLocaleDateString()}`,
      );
    }
  }
  if (rules?.maxDate) {
    const max = new Date(rules.maxDate);
    if (d > max) {
      throw new FieldValidationError(
        key,
        name,
        `${name} must be before ${max.toLocaleDateString()}`,
      );
    }
  }
}

function validateTime(key: string, name: string, value: unknown): void {
  const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
  if (typeof value !== 'string' || !timeRegex.test(value)) {
    throw new FieldValidationError(
      key,
      name,
      `${name} must be a valid time (HH:MM or HH:MM:SS)`,
    );
  }
}

function validateCascadingSelect(
  key: string,
  name: string,
  value: unknown,
): void {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { levels?: unknown }).levels)
  ) {
    throw new FieldValidationError(
      key,
      name,
      `${name} must be in the form { levels: string[] }`,
    );
  }
  const levels = (value as { levels: unknown[] }).levels;
  for (const level of levels) {
    if (typeof level !== 'string') {
      throw new FieldValidationError(
        key,
        name,
        `${name} levels must all be strings`,
      );
    }
  }
}

/**
 * `grid` — an ordered array of `{ id: string, values: Record<string, cell> }`.
 *
 * Cells whose column has since been deleted are tolerated on purpose: the
 * alternative is that removing a column makes every already-saved row
 * un-resaveable.
 */
function validateGrid(key: string, name: string, value: unknown): void {
  if (!Array.isArray(value)) {
    throw new FieldValidationError(key, name, `${name} must be a list of rows`);
  }
  if (value.length > GRID_MAX_ROWS) {
    throw new FieldValidationError(
      key,
      name,
      `${name} may contain at most ${GRID_MAX_ROWS} rows`,
    );
  }
  for (const row of value as unknown[]) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new FieldValidationError(
        key,
        name,
        `${name} contains an invalid row`,
      );
    }
    const { id, values } = row as { id?: unknown; values?: unknown };
    if (typeof id !== 'string' || id.length === 0) {
      throw new FieldValidationError(
        key,
        name,
        `${name} contains a row without an id`,
      );
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new FieldValidationError(
        key,
        name,
        `${name} contains a row without cell values`,
      );
    }
    for (const cell of Object.values(values as Record<string, unknown>)) {
      if (
        cell !== null &&
        typeof cell !== 'string' &&
        typeof cell !== 'number' &&
        typeof cell !== 'boolean'
      ) {
        throw new FieldValidationError(
          key,
          name,
          `${name} contains an invalid cell value`,
        );
      }
    }
  }
}

/** `file` — a single discriminated file reference. */
function validateFileRef(key: string, name: string, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FieldValidationError(
      key,
      name,
      `${name} must be a file reference`,
    );
  }
  const ref = value as Record<string, unknown>;
  if (typeof ref.name !== 'string' || ref.name.length === 0) {
    throw new FieldValidationError(
      key,
      name,
      `${name} file reference is missing a name`,
    );
  }
  if (ref.source === 'attachment') {
    if (
      typeof ref.attachmentId !== 'string' ||
      !UUID_REGEX.test(ref.attachmentId)
    ) {
      throw new FieldValidationError(
        key,
        name,
        `${name} has an invalid attachment id`,
      );
    }
    return;
  }
  if (ref.source === 'file-explorer') {
    if (typeof ref.nodeId !== 'string' || !UUID_REGEX.test(ref.nodeId)) {
      throw new FieldValidationError(
        key,
        name,
        `${name} has an invalid file id`,
      );
    }
    return;
  }
  throw new FieldValidationError(
    key,
    name,
    `${name} has an unknown file source`,
  );
}

/** `file_multi` — an ordered array of file references. */
function validateFileRefArray(key: string, name: string, value: unknown): void {
  if (!Array.isArray(value)) {
    throw new FieldValidationError(
      key,
      name,
      `${name} must be a list of files`,
    );
  }
  if (value.length > FILE_MULTI_MAX_ITEMS) {
    throw new FieldValidationError(
      key,
      name,
      `${name} may contain at most ${FILE_MULTI_MAX_ITEMS} files`,
    );
  }
  for (const ref of value as unknown[]) {
    validateFileRef(key, name, ref);
  }
}

function validateUrl(key: string, name: string, value: unknown): void {
  if (typeof value !== 'string') {
    throw new FieldValidationError(key, name, `${name} must be a string`);
  }
  try {
    new URL(value);
  } catch {
    throw new FieldValidationError(key, name, `${name} must be a valid URL`);
  }
}

/**
 * Coerce a raw value (e.g. loaded from the database or a form input) into the
 * runtime type expected by the given field type.
 *
 * @param field The custom field (only `field_type` is used).
 * @param value The raw value to coerce.
 * @returns The coerced value, or the original value for fields that don't
 *   require coercion.
 */
export function coerceValueToFieldType(
  field: Pick<CustomField, 'field_type'>,
  value: unknown,
): unknown {
  if (value === null || value === undefined) return value;
  const t: FieldType = field.field_type;
  switch (t) {
    case 'number':
      return typeof value === 'number' ? value : parseFloat(value as string);
    case 'checkbox':
      if (value === 'false' || value === 0 || value === '') return false;
      return Boolean(value);
    case 'date':
    case 'datetime':
    case 'time':
      return value instanceof Date ? value : new Date(value as string);
    case 'multiselect':
    case 'issue_group':
    case 'user_multi':
    case 'file_multi':
    case 'asset_multi':
      return Array.isArray(value) ? value : [value];
    // A grid value is always an array of rows; a non-array is not coercible
    // into a row, so it collapses to "no rows" rather than being wrapped.
    case 'grid':
      return Array.isArray(value) ? value : [];
    default:
      return value;
  }
}
