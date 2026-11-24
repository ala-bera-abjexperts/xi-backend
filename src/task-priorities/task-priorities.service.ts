/**
 * @fileoverview Service for configurable task priorities (CRUD, defaults,
 * in-use protection, reorder, duplicate). Org-scoped with optional
 * space-level entries.
 * @module src/task-priorities/task-priorities.service
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
import type { CreateTaskPriorityDto } from './dto/create-task-priority.dto';
import type { UpdateTaskPriorityDto } from './dto/update-task-priority.dto';

export interface TaskPriority {
  id: string;
  organization_id: string;
  space_id: string | null;
  name: string;
  key: string;
  color: string;
  icon: string | null;
  sort_order: number;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class TaskPrioritiesService {
  private static readonly TABLE = 'task_priorities';
  private static readonly TASKS_TABLE = 'tasks';

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
    filters?: { is_active?: string; search?: string },
  ): Promise<TaskPriority[]> {
    let query = this.client
      .from(TaskPrioritiesService.TABLE)
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
    if (filters?.search) {
      query = query.ilike('name', `%${filters.search}%`);
    }

    const r = await query
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as TaskPriority[];
  }

  async getById(id: string, organizationId: string): Promise<TaskPriority> {
    const r = await this.client
      .from(TaskPrioritiesService.TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Task priority not found');
    return r.data as TaskPriority;
  }

  async getByKey(
    organizationId: string,
    spaceId: string | null,
    key: string,
  ): Promise<TaskPriority | null> {
    let query = this.client
      .from(TaskPrioritiesService.TABLE)
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
    return (r.data as TaskPriority) ?? null;
  }

  async getDefault(
    organizationId: string,
    spaceId?: string,
  ): Promise<TaskPriority | null> {
    if (spaceId) {
      const spaceDefault = await this.client
        .from(TaskPrioritiesService.TABLE)
        .select('*')
        .eq('organization_id', organizationId)
        .eq('space_id', spaceId)
        .eq('is_default', true)
        .maybeSingle();
      if (spaceDefault.data) return spaceDefault.data as TaskPriority;
    }
    const orgDefault = await this.client
      .from(TaskPrioritiesService.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .is('space_id', null)
      .eq('is_default', true)
      .maybeSingle();
    if (orgDefault.error)
      throw new BadRequestException(orgDefault.error.message);
    return (orgDefault.data as TaskPriority) ?? null;
  }

  // ------------------------------------------------------------------
  // Create
  // ------------------------------------------------------------------

  async create(
    organizationId: string,
    dto: CreateTaskPriorityDto,
    actorUserId?: string | null,
  ): Promise<TaskPriority> {
    const spaceId = dto.space_id ?? null;
    await this.assertSpaceInOrganization(organizationId, spaceId);
    await this.assertKeyUnique(organizationId, spaceId, dto.key);

    let clearedDefaults: Pick<TaskPriority, 'id' | 'name' | 'space_id'>[] = [];

    const row = {
      organization_id: organizationId,
      space_id: spaceId,
      name: dto.name,
      key: dto.key,
      color: dto.color,
      icon: dto.icon ?? null,
      sort_order: dto.sort_order ?? 0,
      is_default: false,
      is_active: dto.is_active ?? true,
    };
    const r = await this.client
      .from(TaskPrioritiesService.TABLE)
      .insert(row)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const created = r.data as TaskPriority;

    if (dto.is_default) {
      try {
        clearedDefaults = await this.promoteDefaultInScope(
          organizationId,
          created.space_id,
          created.id,
          false,
        );
        created.is_default = true;
      } catch (error) {
        await this.deleteCreatedPriorityBestEffort(created.id, organizationId);
        throw error;
      }
    }

    this.logAudit(organizationId, actorUserId, created.id, 'create', {
      name: created.name,
      key: created.key,
      space_id: created.space_id,
      is_default: created.is_default,
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
    dto: UpdateTaskPriorityDto,
    actorUserId?: string | null,
  ): Promise<TaskPriority> {
    const existing = await this.getById(id, organizationId);

    let clearedDefaults: Pick<TaskPriority, 'id' | 'name' | 'space_id'>[] = [];

    const patch: Record<string, unknown> = {};
    for (const key of [
      'name',
      'color',
      'icon',
      'sort_order',
      'is_active',
    ] as const) {
      if (dto[key] !== undefined) patch[key] = dto[key];
    }
    if (dto.is_default === false) patch['is_default'] = false;

    if (Object.keys(patch).length === 0) {
      if (dto.is_default) {
        clearedDefaults = await this.promoteDefaultInScope(
          organizationId,
          existing.space_id,
          id,
          existing.is_default,
        );
        this.logAudit(organizationId, actorUserId, id, 'update', {
          is_default: true,
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
      return existing;
    }

    const r = await this.client
      .from(TaskPrioritiesService.TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const updated = r.data as TaskPriority;

    if (dto.is_default) {
      clearedDefaults = await this.promoteDefaultInScope(
        organizationId,
        existing.space_id,
        id,
        existing.is_default,
      );
      updated.is_default = true;
    }

    this.logAudit(organizationId, actorUserId, id, 'update', {
      ...patch,
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
        'Cannot delete priority that is in use by tasks. Please reassign tasks first.',
      );
    }

    const r = await this.client
      .from(TaskPrioritiesService.TABLE)
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
  ): Promise<TaskPriority> {
    await this.getById(id, organizationId);

    if (!isActive) {
      const inUse = await this.isInUse(id, organizationId);
      if (inUse) {
        throw new ConflictException(
          'Cannot deactivate priority that is in use by tasks.',
        );
      }
    }

    const r = await this.client
      .from(TaskPrioritiesService.TABLE)
      .update({ is_active: isActive })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const updated = r.data as TaskPriority;
    this.logAudit(organizationId, actorUserId, id, 'update', {
      is_active: isActive,
    });
    return updated;
  }

  async setDefault(
    id: string,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<TaskPriority> {
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
    const r = await this.client.rpc('reorder_task_priorities', {
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
  ): Promise<TaskPriority> {
    const source = await this.getById(id, organizationId);
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
        sort_order: source.sort_order + 1,
        is_active: source.is_active,
        is_default: false,
      },
      actorUserId,
    );
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  async isInUse(id: string, organizationId?: string): Promise<boolean> {
    let query = this.client
      .from(TaskPrioritiesService.TASKS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('priority_id', id);
    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }
    const r = await query;
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.count ?? 0) > 0;
  }

  private async clearDefaultInScope(
    organizationId: string,
    spaceId: string | null,
    excludeId: string,
  ): Promise<Pick<TaskPriority, 'id' | 'name' | 'space_id'>[]> {
    let query = this.client
      .from(TaskPrioritiesService.TABLE)
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
    return (r.data ?? []) as Pick<TaskPriority, 'id' | 'name' | 'space_id'>[];
  }

  private async promoteDefaultInScope(
    organizationId: string,
    spaceId: string | null,
    targetId: string,
    targetWasDefault: boolean,
  ): Promise<Pick<TaskPriority, 'id' | 'name' | 'space_id'>[]> {
    const set = await this.client
      .from(TaskPrioritiesService.TABLE)
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
          .from(TaskPrioritiesService.TABLE)
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

  private async deleteCreatedPriorityBestEffort(
    id: string,
    organizationId: string,
  ): Promise<void> {
    await this.client
      .from(TaskPrioritiesService.TABLE)
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
      .from(TaskPrioritiesService.TABLE)
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
        `A priority with key '${key}' already exists in this scope`,
      );
    }
  }

  private generateKey(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/^(\d)/, 'p_$1') || 'priority'
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
      'task_priority',
      entityId,
      action,
      changes,
    );
  }

  private logClearedDefaultAudits(
    organizationId: string,
    actorUserId: string | null | undefined,
    clearedDefaults: Pick<TaskPriority, 'id' | 'name' | 'space_id'>[],
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
