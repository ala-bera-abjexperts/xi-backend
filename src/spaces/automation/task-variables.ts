import type { SupabaseClient } from '@supabase/supabase-js';

import type { EvalContext } from '../../automations/utils/expression';

/** Roots that must not be shadowed by a custom field whose field_key collides. */
const RESERVED_ROOTS = new Set(['trigger', 'nodes', 'context', 'task']);

export interface TaskVariables {
  ctx: EvalContext;
  /** field_key -> resolved value, for required-variable checks and diagnostics. */
  values: Record<string, unknown>;
  shadowed: string[];
}

interface TaskRow {
  id: string;
  key: string;
  summary: string;
  space_id: string | null;
  organization_id: string;
  custom_field_values: Record<string, unknown> | null;
}

/** Strips control characters that would corrupt a name or label downstream. */
function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

/** Safe scalar rendering — an object never becomes "[object Object]". */
function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (value === null || value === undefined) return '';

  return JSON.stringify(value) ?? '';
}

function fileName(entry: unknown): string {
  return typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as { name?: unknown }).name === 'string'
    ? (entry as { name: string }).name
    : '';
}

/**
 * Renders one stored custom-field value for template substitution.
 *
 * Native scalars are returned unchanged so a whole-string placeholder keeps its type
 * (see deepSubstitute). Only shapes with no sensible literal form are stringified.
 */
export function formatFieldValue(
  fieldType: string | undefined,
  raw: unknown,
): unknown {
  if (raw === null || raw === undefined) return undefined;

  switch (fieldType) {
    // Scalars — pass through with their type intact.
    case 'string':
    case 'number':
    case 'url':
    case 'editor':
    case 'select':
    case 'radio':
    case 'label':
    case 'date':
    case 'time':
    case 'datetime':
    case 'checkbox':
      return typeof raw === 'string' ? clean(raw) : raw;

    // Single uuid references — the id is the only value available without an extra query.
    case 'user_select':
    case 'task':
    case 'wiki_page':
    case 'list_item':
    case 'asset':
      return toText(raw);

    case 'multiselect':
    case 'user_multi':
    case 'list_item_multi':
    case 'asset_multi':
      return Array.isArray(raw) ? raw.map(toText).join(', ') : toText(raw);

    case 'file':
      return clean(fileName(raw));

    case 'file_multi':
      return Array.isArray(raw)
        ? raw.map(fileName).filter(Boolean).map(clean).join(', ')
        : '';

    case 'cascading_select': {
      const levels = (raw as { levels?: unknown[] })?.levels;

      return Array.isArray(levels) ? levels.map(toText).join(' > ') : '';
    }

    case 'grid':
      return JSON.stringify(raw);

    default:
      // Unknown or deleted field definition — keep scalars, stringify the rest.
      if (typeof raw === 'string') return clean(raw);
      if (typeof raw === 'number' || typeof raw === 'boolean') return raw;

      return JSON.stringify(raw);
  }
}

/**
 * Reads the triggering task and turns its custom_field_values into a substitution context.
 *
 * Task custom fields are not carried on the automation trigger payload, so the only way to
 * reach them is this query — see the module README note in the action.
 *
 * Values are exposed twice: bare (`{{ project_number }}`) for short templates, and under
 * `task.custom_fields` for an unambiguous path. A field_key colliding with a reserved root
 * is reported in `shadowed` rather than silently winning or losing.
 */
export async function buildTaskVariables(
  supabase: SupabaseClient,
  taskId: string,
  organizationId: string,
): Promise<TaskVariables | null> {
  const { data: task } = await supabase
    .from('tasks')
    .select('id, key, summary, space_id, organization_id, custom_field_values')
    .eq('id', taskId)
    .eq('organization_id', organizationId)
    .maybeSingle<TaskRow>();

  if (!task) return null;

  // Scope to the task's OWN space, which may differ from the automation's space.
  // Soft-deleted rows share the field_key of a re-created field; without this the type
  // lookup below can resolve to the dead definition and mis-render the value.
  let fieldQuery = supabase
    .from('custom_fields')
    .select('field_key, field_type, options')
    .eq('organization_id', task.organization_id)
    .eq('is_deleted', false);

  fieldQuery = task.space_id
    ? fieldQuery.or(`space_id.is.null,space_id.eq.${task.space_id}`)
    : fieldQuery.is('space_id', null);

  const { data: fieldDefs } = await fieldQuery;

  const typeByKey = new Map<string, string>(
    (fieldDefs ?? []).map((f: { field_key: string; field_type: string }) => [
      f.field_key,
      f.field_type,
    ]),
  );

  // Issue group values are option ids; templates want the names people see.
  const issueGroupOptions = new Map<
    string,
    Array<{ value: string; label: string }>
  >(
    (fieldDefs ?? [])
      .filter((f: { field_type: string }) => f.field_type === 'issue_group')
      .map(
        (f: {
          field_key: string;
          options: Array<{ value: string; label: string }> | null;
        }) => [f.field_key, f.options ?? []],
      ),
  );

  const values: Record<string, unknown> = {};
  const bare: Record<string, unknown> = {};
  const shadowed: string[] = [];

  for (const [fieldKey, raw] of Object.entries(
    task.custom_field_values ?? {},
  )) {
    const groupOptions = issueGroupOptions.get(fieldKey);
    const formatted = groupOptions
      ? (raw as string[] | null)
          ?.map((id) => groupOptions.find((o) => o.value === id)?.label ?? id)
          .join(', ')
      : formatFieldValue(typeByKey.get(fieldKey), raw);

    if (formatted === undefined) continue;

    values[fieldKey] = formatted;

    // A reserved root keeps its meaning; the field stays reachable via task.custom_fields.
    if (RESERVED_ROOTS.has(fieldKey)) {
      shadowed.push(fieldKey);
      continue;
    }

    bare[fieldKey] = formatted;
  }

  const ctx = {
    ...bare,
    trigger: {},
    nodes: {},
    context: {},
    task: {
      id: task.id,
      key: task.key,
      summary: task.summary,
      space_id: task.space_id,
      custom_fields: values,
    },
  } as unknown as EvalContext;

  return { ctx, values, shadowed };
}
