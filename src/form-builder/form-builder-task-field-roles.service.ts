import { BadRequestException, Injectable } from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';

const TABLE = 'form_builder_task_field_roles';

// Mirrors the CHECK constraint in the migration — prevents invalid task_field values
// from reaching the DB even if the HTTP layer is hit directly.
//
// A task_field is either one of these built-ins, or 'custom:<field_key>' targeting a task
// custom field (tasks.custom_field_values is a flat jsonb keyed by custom_fields.field_key).
const VALID_TASK_FIELDS = new Set([
  'task_type',
  'priority',
  'status',
  'parent_task',
  'summary',
  'description',
  'assigned_to',
  'reporter',
  'start_date',
  'due_date',
  'progress',
]);

// Keep in lockstep with the CHECK constraint regex in the migration.
const CUSTOM_TASK_FIELD_RE = /^custom:[A-Za-z0-9_-]+$/;

export interface ITaskFieldRoleRow {
  id: string;
  form_id: string;
  field_key: string;
  task_field: string;
  space_id: string;
}

function isValidTaskField(taskField: string): boolean {
  return (
    VALID_TASK_FIELDS.has(taskField) || CUSTOM_TASK_FIELD_RE.test(taskField)
  );
}

@Injectable()
export class FormBuilderTaskFieldRolesService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async list(formId: string): Promise<ITaskFieldRoleRow[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('form_id', formId);

    if (error) throw new BadRequestException(error.message);

    return (data ?? []) as ITaskFieldRoleRow[];
  }

  async sync(
    formId: string,
    spaceId: string,
    mappings: Record<string, string | null>,
  ) {
    // Delete all existing rows for this form before re-inserting
    const { error: deleteError } = await this.client
      .from(TABLE)
      .delete()
      .eq('form_id', formId);

    if (deleteError) throw new BadRequestException(deleteError.message);

    // Build insert list — skip null, empty-string, and unknown task field values
    const toInsert = Object.entries(mappings)
      .filter(
        ([taskField, fieldKey]) => !!fieldKey && isValidTaskField(taskField),
      )
      .map(([taskField, fieldKey]) => ({
        form_id: formId,
        field_key: fieldKey as string,
        task_field: taskField,
        space_id: spaceId,
      }));

    if (toInsert.length > 0) {
      const { error: insertError } = await this.client
        .from(TABLE)
        .insert(toInsert);

      if (insertError) throw new BadRequestException(insertError.message);
    }

    return { synced: toInsert.length };
  }
}
