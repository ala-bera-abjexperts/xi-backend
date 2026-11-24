import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';
import { hasUnresolvedPlaceholder } from '../../utils/template';
import { coerceCustomFieldValues } from '../../utils/custom-field-coercion';

export const taskAddComment: ActionDefinition = {
  kind: 'app.task.add_comment',
  category: 'app_mutation',
  type: 'action',
  label: { en: 'Add task comment', de: 'Aufgabenkommentar hinzufügen' },
  description: {
    en: 'Posts a comment on a task',
    de: 'Fügt einen Kommentar zu einer Aufgabe hinzu',
  },
  icon: 'bx-comment-add',
  inputSchema: z.unknown(),
  configSchema: z.object({
    taskId: z.string().min(1),
    body: z.string().min(1).max(10000),
  }),
  outputSchema: z.object({
    comment: z.object({
      id: z.string().uuid(),
      body: z.string(),
      task_id: z.string().uuid(),
    }),
    task: z.object({
      id: z.string().uuid(),
      key: z.string(),
      summary: z.string(),
    }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as { taskId: string; body: string };

    assertResolvedUuid('Add task comment', 'Task', conf.taskId);

    // task_comments.task_id is a bare FK, so without this a foreign uuid would comment on another tenant's task.
    const { data: target } = await ctx.supabase
      .from('tasks')
      .select('id')
      .eq('id', conf.taskId)
      .eq('organization_id', ctx.organizationId)
      .eq('space_id', ctx.spaceId)
      .maybeSingle();

    if (!target) {
      throw new Error(
        `Add task comment: task ${conf.taskId} was not found in this space.`,
      );
    }

    const { data, error } = await ctx.supabase
      .from('task_comments')
      .insert({
        task_id: conf.taskId,
        organization_id: ctx.organizationId,
        content: conf.body,
        created_by: ctx.actingUserId,
      })
      .select('id, content, task_id')
      .single();

    if (error) throw new Error(`Failed to add comment: ${error.message}`);

    const comment = data as { id: string; content: string; task_id: string };

    // The commented-on task, so a following message step can say "commented on XE-T350" rather than
    // quoting a UUID. Non-fatal: the comment is already written, and the action still returns.
    const { data: commentedTask } = await ctx.supabase
      .from('tasks')
      .select('key, summary')
      .eq('id', conf.taskId)
      .maybeSingle();

    const task = commentedTask as { key?: string; summary?: string } | null;

    return {
      comment: {
        id: comment.id,
        body: comment.content,
        task_id: comment.task_id,
      },
      task: {
        id: conf.taskId,
        key: task?.key ?? '',
        summary: task?.summary ?? '',
      },
    };
  },
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A template that resolved to nothing stays a literal "{{ ... }}" string; stop it before Postgres
// rejects it as a malformed uuid with an error that names no field.
function assertResolvedUuid(label: string, field: string, value: string): void {
  if (hasUnresolvedPlaceholder(value)) {
    throw new Error(
      `${label}: "${field}" is empty — ${value} resolved to nothing for this trigger. ` +
        'Pick a value, or use a variable the trigger actually provides.',
    );
  }

  if (!UUID_REGEX.test(value)) {
    throw new Error(`${label}: "${value}" is not a valid ${field} id.`);
  }
}

export const taskCreate: ActionDefinition = {
  kind: 'app.task.create',
  category: 'app_mutation',
  type: 'action',
  label: { en: 'Create task', de: 'Aufgabe erstellen' },
  description: {
    en: 'Creates a new task in the current space',
    de: 'Erstellt eine neue Aufgabe im aktuellen Bereich',
  },
  icon: 'bx-plus-circle',
  inputSchema: z.unknown(),
  configSchema: z.object({
    summary: z.string().min(1),
    description: z.string().optional(),
    status: z.string().optional(),
    priority: z.string().optional(),
    taskType: z.string().optional(),
    assignedTo: z.string().optional(),
    dueDate: z.string().optional(),
    parentTaskId: z.string().optional(),
    customFieldValues: z.record(z.string(), z.any()).optional(),
  }),
  outputSchema: z.object({
    task: z.object({
      id: z.string().uuid(),
      key: z.string().nullable(),
      summary: z.string(),
    }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      summary: string;
      description?: string;
      status?: string;
      priority?: string;
      taskType?: string;
      assignedTo?: string;
      dueDate?: string;
      parentTaskId?: string;
      customFieldValues?: Record<string, unknown>;
    };

    const insert: Record<string, unknown> = {
      space_id: ctx.spaceId,
      organization_id: ctx.organizationId,
      created_by: ctx.actingUserId,
      summary: conf.summary,
      task_type_id: conf.taskType ?? 'task',
      status: conf.status ?? 'open',
      priority: conf.priority ?? 'medium',
    };

    if (conf.description) insert.description = conf.description;
    if (conf.assignedTo) insert.assigned_to = conf.assignedTo;
    if (conf.dueDate) insert.due_date = conf.dueDate;
    if (conf.parentTaskId && UUID_REGEX.test(conf.parentTaskId))
      insert.parent_task_id = conf.parentTaskId;
    // Templated text becomes the typed value the ticket UI stores (number, checkbox, grid rows).
    if (conf.customFieldValues)
      await coerceCustomFieldValues(ctx, conf.customFieldValues);
    if (
      conf.customFieldValues &&
      Object.keys(conf.customFieldValues).length > 0
    ) {
      insert.custom_field_values = conf.customFieldValues;
    }

    const { data, error } = await ctx.supabase
      .from('tasks')
      .insert(insert)
      .select('id, key, summary')
      .single();

    if (error) throw new Error(`Failed to create task: ${error.message}`);

    const row = data as { id: string; key: string | null; summary: string };

    return { task: { id: row.id, key: row.key, summary: row.summary } };
  },
};

/**
 * Mirror asset-typed custom field values into the task's linked assets, so setting an `asset` field
 * also populates the "Linked assets" panel.
 *
 * Add-only on purpose: an automation must never remove a link somebody created by hand. Never throws
 * — a link problem is logged, because it must not fail an update that already succeeded.
 */
async function linkAssetFields(
  values: Record<string, unknown>,
  taskId: string,
  ctx: ExecutionContext,
): Promise<void> {
  const { data: defs, error: defErr } = await ctx.supabase
    .from('custom_fields')
    .select('field_key')
    .eq('organization_id', ctx.organizationId)
    .in('field_key', Object.keys(values))
    .in('field_type', ['asset', 'asset_multi']);

  if (defErr || !defs || defs.length === 0) return;

  const assetIds = new Set<string>();

  for (const def of defs as Array<{ field_key: string }>) {
    const raw = values[def.field_key];

    for (const candidate of Array.isArray(raw) ? raw : [raw]) {
      if (typeof candidate === 'string' && UUID_REGEX.test(candidate))
        assetIds.add(candidate);
    }
  }

  if (assetIds.size === 0) return;

  // asset_object_task_links requires the object and the task to share a space, so an asset drawn
  // from another space's inventory keeps its value but gets no link row.
  const { data: objects } = await ctx.supabase
    .from('asset_objects')
    .select('id')
    .in('id', [...assetIds])
    .eq('organization_id', ctx.organizationId)
    .eq('space_id', ctx.spaceId);

  for (const obj of (objects ?? []) as Array<{ id: string }>) {
    const { error } = await ctx.supabase
      .from('asset_object_task_links')
      .insert({
        organization_id: ctx.organizationId,
        space_id: ctx.spaceId,
        object_id: obj.id,
        task_id: taskId,
        created_by: ctx.actingUserId,
      });

    // 23505 means it is already linked, which is the state we wanted anyway.
    if (error && error.code !== '23505') {
      ctx.logger.info(
        `Update task: could not link asset ${obj.id} — ${error.message}`,
      );
    }
  }
}

export const taskUpdate: ActionDefinition = {
  kind: 'app.task.update',
  category: 'app_mutation',
  type: 'action',
  label: { en: 'Update task', de: 'Aufgabe aktualisieren' },
  description: {
    en: 'Updates fields on an existing task',
    de: 'Aktualisiert Felder einer vorhandenen Aufgabe',
  },
  icon: 'bx-edit',
  inputSchema: z.unknown(),
  configSchema: z.object({
    taskId: z.string().min(1),
    summary: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    priority: z.string().optional(),
    assignedTo: z.string().optional(),
    dueDate: z.string().optional(),
    // Editor-only: scopes the custom-field list to one task type. Never written to the task.
    taskType: z.string().optional(),
    customFieldValues: z.record(z.string(), z.any()).optional(),
  }),
  outputSchema: z.object({
    task: z.object({
      id: z.string().uuid(),
      key: z.string().nullable(),
      summary: z.string(),
    }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      taskId: string;
      summary?: string;
      description?: string;
      status?: string;
      priority?: string;
      assignedTo?: string;
      dueDate?: string;
      customFieldValues?: Record<string, unknown>;
    };

    assertResolvedUuid('Update task', 'Task', conf.taskId);

    const patch: Record<string, unknown> = {};
    const skipped: string[] = [];

    // An optional uuid/date field whose variable resolved to nothing is dropped, not written —
    // an empty assignee must not fail the whole update.
    const resolvedOrSkip = (
      field: string,
      raw?: string,
    ): string | undefined => {
      if (raw === undefined || raw === '') return undefined;

      if (hasUnresolvedPlaceholder(raw)) {
        ctx.logger.info(
          `Update task: "${field}" left an unresolved {{ }} token — skipped`,
        );
        skipped.push(field);

        return undefined;
      }

      return raw;
    };

    const assignedTo = resolvedOrSkip('Assigned to', conf.assignedTo);
    const dueDate = resolvedOrSkip('Due date', conf.dueDate);

    // Keyed by field_key (slug) — the same namespace tasks.custom_field_values uses, so unlike the
    // workflow engine's screen input there is no id-to-slug conversion to do here.
    const customFields: Record<string, unknown> = {};

    for (const [key, raw] of Object.entries(conf.customFieldValues ?? {})) {
      if (raw === undefined || raw === null || raw === '') continue;

      if (typeof raw === 'string' && hasUnresolvedPlaceholder(raw)) {
        ctx.logger.info(
          `Update task: custom field "${key}" left an unresolved {{ }} token — skipped`,
        );
        skipped.push(key);

        continue;
      }

      customFields[key] = raw;
    }

    // Templated text becomes the typed value the ticket UI stores; an unmappable grid is skipped.
    skipped.push(...(await coerceCustomFieldValues(ctx, customFields)));

    const hasCustomFields = Object.keys(customFields).length > 0;

    if (conf.summary !== undefined) patch.summary = conf.summary;
    if (conf.description !== undefined) patch.description = conf.description;
    if (conf.status !== undefined) patch.status = conf.status;
    if (conf.priority !== undefined) patch.priority = conf.priority;
    if (assignedTo !== undefined) patch.assigned_to = assignedTo;
    if (dueDate !== undefined) patch.due_date = dueDate;

    if (Object.keys(patch).length === 0 && !hasCustomFields) {
      throw new Error(
        skipped.length > 0
          ? `Update task: nothing to update — ${skipped.join(', ')} resolved to nothing for this trigger.`
          : 'Update task: at least one field must be specified',
      );
    }

    // Merge instead of replacing: custom_field_values is one blob, so writing it wholesale would
    // wipe every other custom field the ticket already carries.
    if (hasCustomFields) {
      const { data: existing, error: readErr } = await ctx.supabase
        .from('tasks')
        .select('custom_field_values')
        .eq('id', conf.taskId)
        .eq('organization_id', ctx.organizationId)
        .eq('space_id', ctx.spaceId)
        .single();

      if (readErr) {
        if (readErr.code === 'PGRST116') {
          throw new Error(
            `Update task: task ${conf.taskId} was not found in this space.`,
          );
        }

        throw new Error(`Failed to update task: ${readErr.message}`);
      }

      const current =
        (existing as { custom_field_values?: Record<string, unknown> })
          .custom_field_values ?? {};

      patch.custom_field_values = { ...current, ...customFields };
    }

    // Set after the emptiness check so it never counts as a user-supplied field.
    // log_task_history reads NEW.updated_by, so omitting it credits the previous editor.
    patch.updated_by = ctx.actingUserId;

    const { data, error } = await ctx.supabase
      .from('tasks')
      .update(patch)
      .eq('id', conf.taskId)
      .eq('organization_id', ctx.organizationId)
      .eq('space_id', ctx.spaceId)
      .select('id, key, summary')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new Error(
          `Update task: task ${conf.taskId} was not found in this space.`,
        );
      }

      throw new Error(`Failed to update task: ${error.message}`);
    }

    const row = data as { id: string; key: string | null; summary: string };

    if (hasCustomFields) await linkAssetFields(customFields, row.id, ctx);

    return { task: { id: row.id, key: row.key, summary: row.summary } };
  },
};

export const taskAssign: ActionDefinition = {
  kind: 'app.task.assign',
  category: 'app_mutation',
  type: 'action',
  label: { en: 'Assign task', de: 'Aufgabe zuweisen' },
  description: {
    en: 'Assigns a task to a user',
    de: 'Weist eine Aufgabe einem Benutzer zu',
  },
  icon: 'bx-user-check',
  inputSchema: z.unknown(),
  configSchema: z.object({
    taskId: z.string().min(1),
    userId: z.string().min(1),
  }),
  outputSchema: z.object({
    task: z.object({
      id: z.string().uuid(),
      // key/summary so a downstream message step can name the task instead of echoing its UUID.
      key: z.string().nullable(),
      summary: z.string(),
      assigned_to: z.string(),
    }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as { taskId: string; userId: string };

    assertResolvedUuid('Assign task', 'Task', conf.taskId);
    assertResolvedUuid('Assign task', 'User', conf.userId);

    const { data, error } = await ctx.supabase
      .from('tasks')
      .update({ assigned_to: conf.userId, updated_by: ctx.actingUserId })
      .eq('id', conf.taskId)
      .eq('organization_id', ctx.organizationId)
      .eq('space_id', ctx.spaceId)
      .select('id, key, summary, assigned_to')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new Error(
          `Assign task: task ${conf.taskId} was not found in this space.`,
        );
      }

      throw new Error(`Failed to assign task: ${error.message}`);
    }

    const row = data as {
      id: string;
      key: string | null;
      summary: string;
      assigned_to: string;
    };

    return {
      task: {
        id: row.id,
        key: row.key,
        summary: row.summary,
        assigned_to: row.assigned_to,
      },
    };
  },
};
