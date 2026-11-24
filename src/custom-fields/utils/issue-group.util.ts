/**
 * @fileoverview Rules of the `issue_group` custom field. Kept dependency-free so the field
 * service, the task write path and the value validator all apply the same checks.
 *
 * Values are always stored as an array of option ids, whatever the selection mode: the mode only
 * limits the length, so switching single → multi needs no data change. Option ids are UUIDs, so a
 * rename never touches a ticket.
 *
 * @module src/custom-fields/utils/issue-group.util
 */

import type { FieldOption, ValidationRules } from '../models/custom-field.model';

export const ISSUE_GROUP_MAX_FIELDS_PER_SPACE = 50;
export const ISSUE_GROUP_MAX_OPTIONS = 200;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Multi unless the field says single: a missing mode must not reject values that already exist. */
export function isSingleIssueGroup(
  rules?: ValidationRules | Record<string, unknown> | null,
): boolean {
  const config = (rules as ValidationRules | null | undefined)?.issue_group;

  return config?.selection_mode === 'single';
}

/** First rule the option list breaks, or `null` when it is valid. */
export function issueGroupOptionsError(options: unknown): string | null {
  if (!Array.isArray(options)) return 'Options are required';

  const list = options as FieldOption[];

  if (list.length > ISSUE_GROUP_MAX_OPTIONS) {
    return `A field can have at most ${ISSUE_GROUP_MAX_OPTIONS} options`;
  }

  if (!list.some((o) => o.status !== 'archived')) {
    return 'At least one active option is required';
  }

  const values = new Set<string>();
  const labels = new Set<string>();

  for (const option of list) {
    if (!UUID_REGEX.test(option.value ?? '')) return 'Invalid option id';
    if (values.has(option.value)) return 'Option ids must be unique';
    values.add(option.value);

    const label = (option.label ?? '').trim().toLocaleLowerCase();

    if (!label) return 'Option name is required';
    if (labels.has(label)) return `Duplicate option name "${option.label}"`;
    labels.add(label);
  }

  return null;
}

/** Why `value` cannot be stored on a ticket, or `null` when it can. Archived options are checked by the caller. */
export function issueGroupValueError(
  field: {
    name: string;
    options?: FieldOption[] | null;
    validation_rules?: ValidationRules | Record<string, unknown> | null;
  },
  value: unknown,
): string | null {
  if (!Array.isArray(value)) return `${field.name} must be an array`;

  if (isSingleIssueGroup(field.validation_rules) && value.length > 1) {
    return `${field.name} allows only one value`;
  }

  const known = new Set((field.options ?? []).map((o) => o.value));

  return value.every((v) => typeof v === 'string' && known.has(v))
    ? null
    : `${field.name} contains an unknown option`;
}
