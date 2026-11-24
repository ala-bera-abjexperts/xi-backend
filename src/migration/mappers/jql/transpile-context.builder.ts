/**
 * @fileoverview Builds a `TranspileContext` from migration crosswalk rows.
 *
 * Pure — takes plain row shapes, returns plain maps — so name→key/id resolution is unit-testable
 * against literal fixtures. The metadata shapes consumed here are exactly what the stages record:
 *
 *  - task-status.stage:   metadata `{ key, category, name }`, target_id = task_statuses.id
 *  - priority.stage:      metadata `{ key, rank, name }`,     target_id = task_priorities.id
 *  - issue-type.stage:    source_key = type NAME,             target_id = task type id
 *  - users.stage:         metadata `{ source_id, email, display_name, is_placeholder, ... }`,
 *                         target_id = users.id
 *  - custom-fields.stage: metadata `{ field_key, field_type, name, outcome }`
 *
 * AMBIGUITY IS RECORDED, NOT RESOLVED: two migrated users sharing a display name make that name
 * map to `null`, and the transpiler refuses a query using it. Guessing which "Alex" the customer
 * meant would translate the query into a different filter than they wrote.
 *
 * @module src/migration/mappers/jql/transpile-context.builder
 */

import type {
  CustomFieldLookup,
  ResolvedLookup,
  TranspileContext,
} from './jql-transpiler.util';

/** The subset of a `migration_entity_map` row this builder reads. */
export interface CrosswalkRowLike {
  source_id: string;
  source_key: string | null;
  target_id: string;
  status: string;
  metadata: Record<string, unknown> | null;
}

export interface TranspileContextInput {
  projectKey: string;
  projectName?: string;
  statusRows: CrosswalkRowLike[];
  priorityRows: CrosswalkRowLike[];
  issueTypeRows: CrosswalkRowLike[];
  userRows: CrosswalkRowLike[];
  customFieldRows: CrosswalkRowLike[];
  /**
   * `custom_fields.id` → that field's option list. Each option is `{ value, label }` exactly as
   * stored (field-type.registry emits `value` = the Jira option id — what the task bag stores — and
   * `label` = the display text a JQL clause names). Present only for select/radio fields; supplied
   * by boards.stage from `custom_fields.options`. Optional so pure fixtures need not provide it.
   */
  customFieldOptions?: Record<string, { value: string; label: string }[]>;
}

function lc(s: string): string {
  return s.trim().toLowerCase();
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/** Register a name → value, downgrading to AMBIGUOUS (null) when two targets share the name. */
function addUserAlias(
  map: Map<string, string | null>,
  alias: string | null,
  userId: string,
): void {
  if (!alias) return;

  const key = lc(alias);
  const existing = map.get(key);

  if (existing === undefined) {
    map.set(key, userId);
  } else if (existing !== null && existing !== userId) {
    map.set(key, null);
  }
}

export function buildTranspileContext(
  input: TranspileContextInput,
): TranspileContext {
  const statuses = new Map<string, ResolvedLookup>();

  for (const row of input.statusRows) {
    if (row.status !== 'mapped') continue;

    const key = str(row.metadata?.key);

    if (!key) continue;

    const name = str(row.metadata?.name);
    // `name` rides on the entry because `status WAS X` matches task_history's status DISPLAY names.
    const entry: ResolvedLookup = {
      key,
      id: row.target_id,
      ...(name ? { name } : {}),
    };

    statuses.set(lc(key), entry);

    if (name) statuses.set(lc(name), entry);
  }

  const priorities = new Map<string, ResolvedLookup>();

  for (const row of input.priorityRows) {
    if (row.status !== 'mapped') continue;

    const key = str(row.metadata?.key);

    if (!key) continue;

    // `rank` powers ordered comparisons (`priority > High`). Live-verified direction: 0 = Highest,
    // smaller = MORE urgent (priority.stage records the adapter's rank order, and Jira returns
    // Highest first).
    const rawRank = Number(row.metadata?.rank);
    const entry: ResolvedLookup = {
      key,
      id: row.target_id,
      ...(Number.isFinite(rawRank) ? { rank: rawRank } : {}),
    };
    const name = str(row.metadata?.name);

    priorities.set(lc(key), entry);

    if (name) priorities.set(lc(name), entry);
  }

  const issueTypes = new Map<string, string>();

  for (const row of input.issueTypeRows) {
    if (row.status !== 'mapped') continue;

    const name = str(row.source_key);

    if (name) issueTypes.set(lc(name), row.target_id);
  }

  const users = new Map<string, string | null>();

  for (const row of input.userRows) {
    // Placeholders are legitimate assignees (tasks reference them), so they resolve too.
    if (row.status !== 'mapped' && row.status !== 'placeholder') continue;

    addUserAlias(
      users,
      str(row.metadata?.source_id) ?? row.source_id,
      row.target_id,
    );
    addUserAlias(users, str(row.metadata?.display_name), row.target_id);
    addUserAlias(users, str(row.metadata?.email), row.target_id);
  }

  const customFields = new Map<string, CustomFieldLookup>();

  for (const row of input.customFieldRows) {
    if (row.status !== 'mapped') continue;
    if (row.metadata?.outcome !== 'custom_field') continue;

    const fieldKey = str(row.metadata?.field_key);
    const fieldType = str(row.metadata?.field_type);

    if (!fieldKey || !fieldType) continue;

    const lookup: CustomFieldLookup = { fieldKey, fieldType };

    // Single-value option fields need label → stored-id resolution so a JQL clause naming the
    // option by its display text ("High") emits the id the bag actually holds.
    if (fieldType === 'select' || fieldType === 'radio') {
      const opts = input.customFieldOptions?.[row.target_id];

      if (opts && opts.length > 0) {
        const optionMap = new Map<string, string>();

        for (const o of opts) {
          const label = str(o.label);
          const value = str(o.value);

          if (label && value) optionMap.set(lc(label), value);
        }

        if (optionMap.size > 0) lookup.options = optionMap;
      }
    }

    const name = str(row.metadata?.name);

    // `customfield_10138` → addressable as cf[10138].
    const numeric = /^customfield_(\d+)$/.exec(row.source_id);

    if (numeric) customFields.set(numeric[1], lookup);
    if (name) customFields.set(lc(name), lookup);

    customFields.set(lc(fieldKey), lookup);
  }

  return {
    projectKey: input.projectKey,
    ...(input.projectName ? { projectName: input.projectName } : {}),
    statuses,
    priorities,
    issueTypes,
    users,
    customFields,
  };
}
