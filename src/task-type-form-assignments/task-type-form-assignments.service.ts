/**
 * @fileoverview Service for task-type form assignments — attaches forms to
 * (space, task_type_level) pairs.
 * @module src/task-type-form-assignments/task-type-form-assignments.service
 */
import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { UpsertTaskTypeFormAssignmentDto } from './dto/upsert-task-type-form-assignment.dto';

export interface TaskTypeFormAssignment {
  id: string;
  organization_id: string;
  space_id: string;
  task_type_level_id: string;
  form_id: string;
  display_mode: 'only_on_create' | 'inline';
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  form: { id: string; name: string | null; status: string | null } | null;
}

@Injectable()
export class TaskTypeFormAssignmentsService {
  private static readonly TABLE = 'task_type_form_assignments';

  // `!inner` + `.eq('form.is_deleted', false)` hides attachments whose form was
  // soft-deleted — form deletion never fires the ON DELETE CASCADE FK.
  private static readonly SELECT =
    '*, form:form_builder!inner(id, name, status)';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async listForSpace(
    spaceId: string,
    organizationId: string,
  ): Promise<TaskTypeFormAssignment[]> {
    const r = await this.client
      .from(TaskTypeFormAssignmentsService.TABLE)
      .select(TaskTypeFormAssignmentsService.SELECT)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('form.is_deleted', false)
      .order('task_type_level_id', { ascending: true })
      .order('sort_order', { ascending: true });

    if (r.error) throw new BadRequestException(r.error.message);

    return (r.data ?? []) as unknown as TaskTypeFormAssignment[];
  }

  /**
   * Forms attached to a task type within a space, including the `'*'`
   * catch-all rows that apply to every type.
   *
   * Fetches both candidate sets in one round trip and orders them in JS —
   * PostgREST cannot order by a CASE expression. Type-specific rows always
   * rank above `'*'` rows (same precedence as
   * `WorkflowAssignmentsService.findActiveAssignmentForType`), except that
   * here `'*'` is additive rather than a fallback: both are returned.
   *
   * @param spaceId - space owning the task
   * @param taskTypeLevelId - task type identifier (matches task_hierarchy_configurations.config.levels[].id)
   * @param organizationId - calling org
   */
  async listForTaskType(
    spaceId: string,
    taskTypeLevelId: string,
    organizationId: string,
  ): Promise<TaskTypeFormAssignment[]> {
    const r = await this.client
      .from(TaskTypeFormAssignmentsService.TABLE)
      .select(TaskTypeFormAssignmentsService.SELECT)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('form.is_deleted', false)
      .in('task_type_level_id', [taskTypeLevelId, '*']);

    if (r.error) {
      // Table not yet migrated — return nothing so the task view still renders.
      if (r.error.message?.includes('schema cache')) return [];
      throw new BadRequestException(r.error.message);
    }
    const rows = (r.data ?? []) as unknown as TaskTypeFormAssignment[];

    return rows.sort((a, b) => {
      const aWildcard = a.task_type_level_id === '*' ? 1 : 0;
      const bWildcard = b.task_type_level_id === '*' ? 1 : 0;

      if (aWildcard !== bWildcard) return aWildcard - bWildcard;

      return a.sort_order - b.sort_order;
    });
  }

  async upsert(
    spaceId: string,
    organizationId: string,
    dto: UpsertTaskTypeFormAssignmentDto,
    actorUserId?: string | null,
  ): Promise<TaskTypeFormAssignment> {
    const spaceR = await this.client
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (spaceR.error) throw new BadRequestException(spaceR.error.message);
    if (!spaceR.data) throw new NotFoundException('Space not found');

    // The form must live in the same space/org and still exist — 404, not 403,
    // so a probe cannot distinguish "wrong tenant" from "gone".
    const formR = await this.client
      .from('form_builder')
      .select('id')
      .eq('id', dto.form_id)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (formR.error) throw new BadRequestException(formR.error.message);
    if (!formR.data) throw new NotFoundException('Form not found');

    const row = {
      organization_id: organizationId,
      space_id: spaceId,
      task_type_level_id: dto.task_type_level_id,
      form_id: dto.form_id,
      display_mode: dto.display_mode ?? 'inline',
      sort_order: dto.sort_order ?? 0,
      created_by: actorUserId ?? null,
      updated_at: new Date().toISOString(),
    };
    // Re-attaching the same (space, type, form) only re-orders it, so the
    // unique key doubles as the upsert target instead of raising a 409.
    const r = await this.client
      .from(TaskTypeFormAssignmentsService.TABLE)
      .upsert(row, { onConflict: 'space_id,task_type_level_id,form_id' })
      .select(TaskTypeFormAssignmentsService.SELECT)
      .single();

    if (r.error) throw new BadRequestException(r.error.message);

    return r.data as unknown as TaskTypeFormAssignment;
  }

  async remove(
    id: string,
    spaceId: string,
    organizationId: string,
  ): Promise<void> {
    const r = await this.client
      .from(TaskTypeFormAssignmentsService.TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .select('id')
      .maybeSingle();

    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Form assignment not found');
  }
}
