/**
 * @fileoverview Service for configurable task statuses — CRUD, transition
 * management, default handling, in-use protection, reorder, duplicate.
 * Org-scoped with optional space-level entries.
 * @module src/task-statuses/task-statuses.service
 * @author Prince Jadiya
 */

import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { CreateTaskStatusDto } from './dto/create-task-status.dto';
import type { UpdateTaskStatusDto } from './dto/update-task-status.dto';

export interface TaskStatus {
  id: string;
  organization_id: string;
  space_id: string | null;
  category_id: string | null;
  name: string;
  key: string;
  color: string;
  icon: string | null;
  sort_order: number;
  is_default: boolean;
  is_completed: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface TaskStatusWithTransitions extends TaskStatus {
  allowed_transitions: string[];
}

@Injectable()
export class TaskStatusesService {
  private static readonly TABLE = 'task_statuses';
  private static readonly TRANSITIONS_TABLE = 'task_status_transitions';
  private static readonly TASKS_TABLE = 'tasks';
  private static readonly WORKFLOW_NODES_TABLE = 'workflow_nodes';
  // Hard cap on workflow-name listing in the conflict error message — keeps
  // payloads bounded when a status appears on many workflows.
  private static readonly WORKFLOW_REFS_LIST_LIMIT = 5;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  async getAll(
    organizationId: string,
    spaceId?: string,
    filters?: { is_active?: string; is_completed?: string; search?: string },
  ): Promise<TaskStatus[]> {
    let query = this.client
      .from(TaskStatusesService.TABLE)
      .select('*')
      .eq('organization_id', organizationId);

    if (spaceId) {
      query = query.or(`space_id.is.null,space_id.eq.${spaceId}`);
    } else {
      query = query.is('space_id', null);
    }

    if (filters?.is_active !== undefined) {
      query = query.eq('is_active', filters.is_active === 'true');
    }
    if (filters?.is_completed !== undefined) {
      query = query.eq('is_completed', filters.is_completed === 'true');
    }
    if (filters?.search) {
      query = query.ilike('name', `%${filters.search}%`);
    }

    const r = await query
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as TaskStatus[];
  }

  async getById(id: string, organizationId: string): Promise<TaskStatus> {
    const r = await this.client
      .from(TaskStatusesService.TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Task status not found');
    return r.data as TaskStatus;
  }

  async getByIdWithTransitions(
    id: string,
    organizationId: string,
  ): Promise<TaskStatusWithTransitions> {
    const status = await this.getById(id, organizationId);
    const transitions = await this.getTransitions(id, organizationId);
    return { ...status, allowed_transitions: transitions };
  }

  async getByKey(
    organizationId: string,
    spaceId: string | null,
    key: string,
  ): Promise<TaskStatus | null> {
    let query = this.client
      .from(TaskStatusesService.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('key', key);
    if (spaceId) {
      query = query.eq('space_id', spaceId);
    } else {
      query = query.is('space_id', null);
    }
    const r = await query.maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data as TaskStatus) ?? null;
  }

  async getDefault(
    organizationId: string,
    spaceId?: string,
  ): Promise<TaskStatus | null> {
    if (spaceId) {
      const spaceDefault = await this.client
        .from(TaskStatusesService.TABLE)
        .select('*')
        .eq('organization_id', organizationId)
        .eq('space_id', spaceId)
        .eq('is_default', true)
        .maybeSingle();
      if (spaceDefault.data) return spaceDefault.data as TaskStatus;
    }
    const orgDefault = await this.client
      .from(TaskStatusesService.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .is('space_id', null)
      .eq('is_default', true)
      .maybeSingle();
    if (orgDefault.error)
      throw new BadRequestException(orgDefault.error.message);
    return (orgDefault.data as TaskStatus) ?? null;
  }

  async getCompletedStatuses(
    organizationId: string,
    spaceId?: string,
  ): Promise<TaskStatus[]> {
    let query = this.client
      .from(TaskStatusesService.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('is_completed', true);
    if (spaceId) {
      query = query.or(`space_id.is.null,space_id.eq.${spaceId}`);
    } else {
      query = query.is('space_id', null);
    }
    const r = await query.order('sort_order', { ascending: true });
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as TaskStatus[];
  }

  async isValidTransition(
    fromStatusId: string,
    toStatusId: string,
    organizationId: string,
  ): Promise<boolean> {
    const r = await this.client
      .from(TaskStatusesService.TRANSITIONS_TABLE)
      .select('id')
      .eq('from_status_id', fromStatusId)
      .eq('to_status_id', toStatusId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    return !!r.data;
  }

  // ------------------------------------------------------------------
  // Create
  // ------------------------------------------------------------------

  async create(
    organizationId: string,
    dto: CreateTaskStatusDto,
    actorUserId?: string | null,
  ): Promise<TaskStatus> {
    const spaceId = dto.space_id ?? null;
    await this.assertSpaceInOrganization(organizationId, spaceId);
    await this.assertKeyUnique(organizationId, spaceId, dto.key);
    await this.assertCategoryInOrganization(organizationId, dto.category_id);

    let clearedDefaults: Pick<TaskStatus, 'id' | 'name' | 'space_id'>[] = [];

    const row: Record<string, unknown> = {
      organization_id: organizationId,
      space_id: spaceId,
      name: dto.name,
      key: dto.key,
      color: dto.color,
      icon: dto.icon ?? null,
      sort_order: dto.sort_order ?? 0,
      is_default: false,
      is_completed: dto.is_completed ?? false,
      is_active: dto.is_active ?? true,
    };
    // category_id is nullable; when omitted, the DB trigger
    // task_statuses_auto_category() will populate it based on is_completed.
    if (dto.category_id !== undefined) {
      row['category_id'] = dto.category_id;
    }
    const r = await this.client
      .from(TaskStatusesService.TABLE)
      .insert(row)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);

    const created = r.data as TaskStatus;

    try {
      if (dto.allowed_transitions && dto.allowed_transitions.length > 0) {
        await this.setTransitionsInternal(
          created.id,
          dto.allowed_transitions,
          organizationId,
          created.space_id,
        );
      }

      if (dto.is_default) {
        clearedDefaults = await this.promoteDefaultInScope(
          organizationId,
          created.space_id,
          created.id,
          false,
        );
        created.is_default = true;
      }
    } catch (error) {
      await this.deleteCreatedStatusBestEffort(created.id, organizationId);
      throw error;
    }

    this.logAudit(organizationId, actorUserId, created.id, 'create', {
      name: created.name,
      key: created.key,
      space_id: created.space_id,
      is_default: created.is_default,
      is_completed: created.is_completed,
      is_active: created.is_active,
      ...(clearedDefaults.length > 0
        ? { cleared_default_ids: clearedDefaults.map((row) => row.id) }
        : {}),
    });
    this.logClearedDefaultAudits(organizationId, actorUserId, clearedDefaults);

    return created;
  }

  // ------------------------------------------------------------------
  // Update
  // ------------------------------------------------------------------

  async update(
    id: string,
    organizationId: string,
    dto: UpdateTaskStatusDto,
    actorUserId?: string | null,
  ): Promise<TaskStatus> {
    const existing = await this.getById(id, organizationId);
    if (dto.key !== undefined && dto.key !== existing.key) {
      throw new BadRequestException('Status key cannot be changed');
    }
    await this.assertCategoryInOrganization(organizationId, dto.category_id);

    let clearedDefaults: Pick<TaskStatus, 'id' | 'name' | 'space_id'>[] = [];

    const patch: Record<string, unknown> = {};
    for (const key of [
      'name',
      'color',
      'icon',
      'sort_order',
      'is_completed',
      'is_active',
      'category_id',
    ] as const) {
      if (dto[key] !== undefined) patch[key] = dto[key];
    }
    if (dto.is_default === false) patch['is_default'] = false;

    const shouldCapturePreviousTransitions =
      dto.allowed_transitions !== undefined &&
      (Object.keys(patch).length > 0 || dto.is_default === true);
    const previousTransitions = shouldCapturePreviousTransitions
      ? await this.getTransitions(id, organizationId)
      : null;

    if (Object.keys(patch).length === 0) {
      try {
        if (dto.allowed_transitions !== undefined) {
          await this.setTransitionsInternal(
            id,
            dto.allowed_transitions,
            organizationId,
            existing.space_id,
          );
        }

        if (dto.is_default) {
          clearedDefaults = await this.promoteDefaultInScope(
            organizationId,
            existing.space_id,
            id,
            existing.is_default,
          );
          this.logAudit(organizationId, actorUserId, id, 'update', {
            is_default: true,
            ...(dto.allowed_transitions !== undefined
              ? { allowed_transitions: dto.allowed_transitions }
              : {}),
            ...(clearedDefaults.length > 0
              ? { cleared_default_ids: clearedDefaults.map((row) => row.id) }
              : {}),
          });
          this.logClearedDefaultAudits(
            organizationId,
            actorUserId,
            clearedDefaults,
          );
          return { ...existing, is_default: true };
        }

        if (dto.allowed_transitions !== undefined) {
          this.logAudit(organizationId, actorUserId, id, 'update', {
            allowed_transitions: dto.allowed_transitions,
          });
        }
      } catch (error) {
        if (previousTransitions) {
          await this.setTransitionsInternalBestEffort(
            id,
            previousTransitions,
            organizationId,
            existing.space_id,
          );
        }

        throw error;
      }
      return existing;
    }

    const r = await this.client
      .from(TaskStatusesService.TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    let updated = r.data as TaskStatus;

    try {
      // The task_statuses_auto_category_on_update trigger replaces category_id
      // with the org's done/todo category when is_completed changes and
      // category_id is unchanged in the same UPDATE. Re-apply an explicit
      // category; is_completed is unchanged now, so the trigger is a no-op.
      if (
        dto.category_id !== undefined &&
        updated.category_id !== dto.category_id
      ) {
        const fix = await this.client
          .from(TaskStatusesService.TABLE)
          .update({ category_id: dto.category_id })
          .eq('id', id)
          .eq('organization_id', organizationId)
          .select()
          .single();
        if (fix.error) throw new BadRequestException(fix.error.message);
        updated = fix.data as TaskStatus;
      }

      if (dto.allowed_transitions !== undefined) {
        await this.setTransitionsInternal(
          id,
          dto.allowed_transitions,
          organizationId,
          existing.space_id,
        );
      }

      if (dto.is_default) {
        clearedDefaults = await this.promoteDefaultInScope(
          organizationId,
          existing.space_id,
          id,
          existing.is_default,
        );
        updated.is_default = true;
      }
    } catch (error) {
      await this.restoreStatusPatchBestEffort(
        id,
        organizationId,
        existing,
        patch,
      );

      if (previousTransitions) {
        await this.setTransitionsInternalBestEffort(
          id,
          previousTransitions,
          organizationId,
          existing.space_id,
        );
      }

      throw error;
    }

    this.logAudit(organizationId, actorUserId, id, 'update', {
      ...patch,
      ...(dto.allowed_transitions !== undefined
        ? { allowed_transitions: dto.allowed_transitions }
        : {}),
      ...(clearedDefaults.length > 0
        ? { cleared_default_ids: clearedDefaults.map((row) => row.id) }
        : {}),
    });
    this.logClearedDefaultAudits(organizationId, actorUserId, clearedDefaults);

    return updated;
  }

  // ------------------------------------------------------------------
  // Delete
  // ------------------------------------------------------------------

  async delete(
    id: string,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    const existing = await this.getById(id, organizationId);

    const inUse = await this.isInUse(id, organizationId);
    if (inUse) {
      throw new ConflictException(
        'Cannot delete status that is in use by tasks. Please reassign tasks first.',
      );
    }

    // Pre-check workflow_nodes refs: the FK is ON DELETE RESTRICT so the DB
    // would refuse the delete anyway, but the raw 23503 produces a poor error
    // message. Surface a clean ConflictException with workflow names instead.
    const wfRefs = await this.findWorkflowsUsingStatus(id, organizationId);
    if (wfRefs.count > 0) {
      const names = wfRefs.samples.map((s) => s.name).join(', ');
      const suffix =
        wfRefs.count > wfRefs.samples.length
          ? ` (and ${wfRefs.count - wfRefs.samples.length} more)`
          : '';
      throw new ConflictException(
        `Cannot delete status used by workflow(s): ${names}${suffix}. Remove the status from the workflow canvas first.`,
      );
    }

    // Cascade-delete transitions referencing this status.
    const r1 = await this.client
      .from(TaskStatusesService.TRANSITIONS_TABLE)
      .delete()
      .eq('from_status_id', id);
    if (r1.error) throw new BadRequestException(r1.error.message);
    const r2 = await this.client
      .from(TaskStatusesService.TRANSITIONS_TABLE)
      .delete()
      .eq('to_status_id', id);
    if (r2.error) throw new BadRequestException(r2.error.message);

    const r = await this.client
      .from(TaskStatusesService.TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);

    this.logAudit(organizationId, actorUserId, id, 'delete', {
      name: existing.name,
      key: existing.key,
      space_id: existing.space_id,
    });
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  async toggleActive(
    id: string,
    isActive: boolean,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<TaskStatus> {
    await this.getById(id, organizationId);

    if (!isActive) {
      const inUse = await this.isInUse(id, organizationId);
      if (inUse) {
        throw new ConflictException(
          'Cannot deactivate status that is in use by tasks.',
        );
      }
    }

    const r = await this.client
      .from(TaskStatusesService.TABLE)
      .update({ is_active: isActive })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const updated = r.data as TaskStatus;
    this.logAudit(organizationId, actorUserId, id, 'update', {
      is_active: isActive,
    });
    return updated;
  }

  async setDefault(
    id: string,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<TaskStatus> {
    const existing = await this.getById(id, organizationId);
    const clearedDefaults = await this.promoteDefaultInScope(
      organizationId,
      existing.space_id,
      id,
      existing.is_default,
    );
    const updated = await this.getById(id, organizationId);
    this.logAudit(organizationId, actorUserId, id, 'update', {
      is_default: true,
      space_id: updated.space_id,
      ...(clearedDefaults.length > 0
        ? { cleared_default_ids: clearedDefaults.map((row) => row.id) }
        : {}),
    });
    this.logClearedDefaultAudits(organizationId, actorUserId, clearedDefaults);
    return updated;
  }

  async reorder(
    items: { id: string; sort_order: number }[],
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    const r = await this.client.rpc('reorder_task_statuses', {
      p_organization_id: organizationId,
      p_items: items,
    });
    if (r.error) {
      if (/not found/i.test(r.error.message)) {
        throw new NotFoundException(r.error.message);
      }
      throw new BadRequestException(r.error.message);
    }

    this.logAudit(organizationId, actorUserId, items[0]?.id, 'update', {
      items,
    });
  }

  async duplicate(
    id: string,
    organizationId: string,
    newName: string,
    actorUserId?: string | null,
  ): Promise<TaskStatus> {
    const source = await this.getById(id, organizationId);
    const transitions = await this.getTransitions(id, organizationId);
    const newKey = this.generateKey(newName);
    await this.assertKeyUnique(organizationId, source.space_id, newKey);
    return this.create(
      organizationId,
      {
        name: newName,
        key: newKey,
        color: source.color,
        icon: source.icon,
        space_id: source.space_id ?? undefined,
        category_id: source.category_id ?? undefined,
        sort_order: source.sort_order + 1,
        is_default: false,
        is_completed: source.is_completed,
        is_active: source.is_active,
        allowed_transitions: transitions,
      },
      actorUserId,
    );
  }

  // ------------------------------------------------------------------
  // Transitions
  // ------------------------------------------------------------------

  async getTransitions(
    statusId: string,
    organizationId: string,
  ): Promise<string[]> {
    const r = await this.client
      .from(TaskStatusesService.TRANSITIONS_TABLE)
      .select('to_status_id')
      .eq('from_status_id', statusId)
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []).map(
      (row: { to_status_id: string }) => row.to_status_id,
    );
  }

  async setTransitions(
    statusId: string,
    toStatusIds: string[],
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    const status = await this.getById(statusId, organizationId);
    await this.setTransitionsInternal(
      statusId,
      toStatusIds,
      organizationId,
      status.space_id,
    );
    this.logAudit(organizationId, actorUserId, statusId, 'update', {
      allowed_transitions: toStatusIds,
    });
  }

  async addTransition(
    fromStatusId: string,
    toStatusId: string,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    const from = await this.getById(fromStatusId, organizationId);
    await this.getById(toStatusId, organizationId);
    const r = await this.client
      .from(TaskStatusesService.TRANSITIONS_TABLE)
      .insert({
        organization_id: organizationId,
        space_id: from.space_id,
        from_status_id: fromStatusId,
        to_status_id: toStatusId,
      });
    if (r.error) throw new BadRequestException(r.error.message);
    this.logAudit(organizationId, actorUserId, fromStatusId, 'update', {
      added_transition_to: toStatusId,
    });
  }

  async removeTransition(
    fromStatusId: string,
    toStatusId: string,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    await this.getById(fromStatusId, organizationId);
    const r = await this.client
      .from(TaskStatusesService.TRANSITIONS_TABLE)
      .delete()
      .eq('from_status_id', fromStatusId)
      .eq('to_status_id', toStatusId)
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);
    this.logAudit(organizationId, actorUserId, fromStatusId, 'update', {
      removed_transition_to: toStatusId,
    });
  }

  // ------------------------------------------------------------------
  // Helpers (private)
  // ------------------------------------------------------------------

  private async setTransitionsInternal(
    statusId: string,
    toStatusIds: string[],
    organizationId: string,
    spaceId: string | null,
  ): Promise<void> {
    const r = await this.client.rpc('replace_task_status_transitions', {
      p_status_id: statusId,
      p_organization_id: organizationId,
      p_space_id: spaceId,
      p_to_status_ids: toStatusIds,
    });
    if (r.error) throw new BadRequestException(r.error.message);
  }

  private async setTransitionsInternalBestEffort(
    statusId: string,
    toStatusIds: string[],
    organizationId: string,
    spaceId: string | null,
  ): Promise<void> {
    try {
      await this.setTransitionsInternal(
        statusId,
        toStatusIds,
        organizationId,
        spaceId,
      );
    } catch {
      // Best-effort rollback only; preserve the original update error.
    }
  }

  private async restoreStatusPatchBestEffort(
    id: string,
    organizationId: string,
    existing: TaskStatus,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const restore: Record<string, unknown> = {};

    for (const key of Object.keys(patch) as Array<keyof TaskStatus>) {
      restore[key] = existing[key] ?? null;
    }

    if (Object.keys(restore).length === 0) return;

    try {
      await this.client
        .from(TaskStatusesService.TABLE)
        .update(restore)
        .eq('id', id)
        .eq('organization_id', organizationId);
    } catch {
      // Best-effort rollback only; preserve the original update error.
    }
  }

  async isInUse(id: string, organizationId?: string): Promise<boolean> {
    let query = this.client
      .from(TaskStatusesService.TASKS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('status_id', id);
    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }
    const r = await query;
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.count ?? 0) > 0;
  }

  /**
   * Return up to {@link WORKFLOW_REFS_LIST_LIMIT} workflows in the calling org
   * that reference this status via a `workflow_nodes` row, plus the total
   * reference count. Used to produce a clean 409 instead of letting the
   * `ON DELETE RESTRICT` FK surface a raw Postgres 23503 error.
   *
   * @returns `{ count, samples }` where `samples` is at most N rows of
   *   `{ id, name }` for the conflict-message UX, and `count` is the total.
   */
  async findWorkflowsUsingStatus(
    id: string,
    organizationId: string,
  ): Promise<{ count: number; samples: Array<{ id: string; name: string }> }> {
    // Total count — `head: true` skips data transfer.
    const countQ = await this.client
      .from(TaskStatusesService.WORKFLOW_NODES_TABLE)
      .select('id, workflows!inner(organization_id)', {
        count: 'exact',
        head: true,
      })
      .eq('status_id', id)
      .eq('workflows.organization_id', organizationId);
    if (countQ.error) throw new BadRequestException(countQ.error.message);

    const count = countQ.count ?? 0;

    if (count === 0) return { count: 0, samples: [] };

    // Sample rows for the message — bounded by the constant.
    const sampleQ = await this.client
      .from(TaskStatusesService.WORKFLOW_NODES_TABLE)
      .select('workflows!inner(id, name, organization_id)')
      .eq('status_id', id)
      .eq('workflows.organization_id', organizationId)
      .limit(TaskStatusesService.WORKFLOW_REFS_LIST_LIMIT);
    if (sampleQ.error) throw new BadRequestException(sampleQ.error.message);

    // Supabase join shape may be either a single object or a one-element array
    // depending on FK type inference; normalize both into a flat list.
    const samples: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();

    for (const row of (sampleQ.data ?? []) as Array<{
      workflows: { id: string; name: string } | { id: string; name: string }[];
    }>) {
      const wf = Array.isArray(row.workflows)
        ? row.workflows[0]
        : row.workflows;
      if (wf && !seen.has(wf.id)) {
        seen.add(wf.id);
        samples.push({ id: wf.id, name: wf.name });
      }
    }

    return { count, samples };
  }

  private async clearDefaultInScope(
    organizationId: string,
    spaceId: string | null,
    excludeId: string,
  ): Promise<Pick<TaskStatus, 'id' | 'name' | 'space_id'>[]> {
    let query = this.client
      .from(TaskStatusesService.TABLE)
      .update({ is_default: false })
      .eq('organization_id', organizationId)
      .eq('is_default', true)
      .neq('id', excludeId);

    if (spaceId) {
      query = query.eq('space_id', spaceId);
    } else {
      query = query.is('space_id', null);
    }

    const r = await query.select('id, name, space_id');
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as Pick<TaskStatus, 'id' | 'name' | 'space_id'>[];
  }

  private async promoteDefaultInScope(
    organizationId: string,
    spaceId: string | null,
    targetId: string,
    targetWasDefault: boolean,
  ): Promise<Pick<TaskStatus, 'id' | 'name' | 'space_id'>[]> {
    const set = await this.client
      .from(TaskStatusesService.TABLE)
      .update({ is_default: true })
      .eq('id', targetId)
      .eq('organization_id', organizationId)
      .select('id')
      .single();
    if (set.error) throw new BadRequestException(set.error.message);

    try {
      return await this.clearDefaultInScope(organizationId, spaceId, targetId);
    } catch (error) {
      if (!targetWasDefault) {
        await this.client
          .from(TaskStatusesService.TABLE)
          .update({ is_default: false })
          .eq('id', targetId)
          .eq('organization_id', organizationId);
      }
      throw error;
    }
  }

  private async assertSpaceInOrganization(
    organizationId: string,
    spaceId: string | null,
  ): Promise<void> {
    if (!spaceId) return;

    const r = await this.client
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Space not found');
  }

  // Defense-in-depth: the FK on task_statuses.category_id only enforces
  // existence in status_categories; it does NOT verify org scope. Because
  // this service runs through the service-role admin client, RLS on
  // status_categories is bypassed. Without this guard a caller from Org A
  // could attach a category_id belonging to Org B.
  private async assertCategoryInOrganization(
    organizationId: string,
    categoryId: string | null | undefined,
  ): Promise<void> {
    if (!categoryId) return;

    const r = await this.client
      .from('status_categories')
      .select('id')
      .eq('id', categoryId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) {
      throw new BadRequestException(
        'category_id does not belong to this organization',
      );
    }
  }

  private async deleteCreatedStatusBestEffort(
    id: string,
    organizationId: string,
  ): Promise<void> {
    await this.client
      .from(TaskStatusesService.TRANSITIONS_TABLE)
      .delete()
      .eq('from_status_id', id)
      .eq('organization_id', organizationId);
    await this.client
      .from(TaskStatusesService.TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);
  }

  private async assertKeyUnique(
    organizationId: string,
    spaceId: string | null,
    key: string,
  ): Promise<void> {
    let query = this.client
      .from(TaskStatusesService.TABLE)
      .select('id')
      .eq('organization_id', organizationId)
      .eq('key', key);

    if (spaceId) {
      query = query.eq('space_id', spaceId);
    } else {
      query = query.is('space_id', null);
    }

    const r = await query.maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (r.data) {
      throw new ConflictException(
        `A status with key '${key}' already exists in this scope`,
      );
    }
  }

  private generateKey(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/^(\d)/, 's_$1') || 'status'
    );
  }

  private logAudit(
    organizationId: string,
    actorUserId: string | null | undefined,
    entityId: string | null | undefined,
    action: 'create' | 'update' | 'delete',
    changes?: Record<string, unknown>,
  ): void {
    if (!actorUserId || !entityId || !this.auditLogsService) return;
    void this.auditLogsService.logAction(
      organizationId,
      actorUserId,
      'task_status',
      entityId,
      action,
      changes,
    );
  }

  private logClearedDefaultAudits(
    organizationId: string,
    actorUserId: string | null | undefined,
    clearedDefaults: Pick<TaskStatus, 'id' | 'name' | 'space_id'>[],
  ): void {
    for (const row of clearedDefaults) {
      this.logAudit(organizationId, actorUserId, row.id, 'update', {
        is_default: false,
        name: row.name,
        space_id: row.space_id,
      });
    }
  }
}
