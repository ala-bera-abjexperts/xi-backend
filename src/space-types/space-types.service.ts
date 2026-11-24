import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { CreateSpaceTypeDto } from './dto/create-space-type.dto';
import type { UpdateSpaceTypeDto } from './dto/update-space-type.dto';

const TABLE = 'space_types';

const DEFAULT_SPACE_TYPES = [
  { name: 'Compliance', key: 'COMPLIANCE', color: '#6B7280', is_default: true },
  {
    name: 'Information Security',
    key: 'INFORMATION_SECURITY',
    color: '#6B7280',
    is_default: true,
  },
  {
    name: 'Quality Management',
    key: 'QUALITY_MANAGEMENT',
    color: '#6B7280',
    is_default: true,
  },
  {
    name: 'Risk Management',
    key: 'RISK_MANAGEMENT',
    color: '#6B7280',
    is_default: true,
  },
  {
    name: 'Project Management',
    key: 'PROJECT_MANAGEMENT',
    color: '#6B7280',
    is_default: true,
  },
  { name: 'Operations', key: 'OPERATIONS', color: '#6B7280', is_default: true },
  { name: 'Other', key: 'OTHER', color: '#6B7280', is_default: true },
];

function generateSpaceTypeKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 50);
}

@Injectable()
export class SpaceTypesService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getAll(
    organizationId: string,
    filter?: { is_active?: boolean; is_deleted?: boolean; search?: string },
  ): Promise<{
    data: Record<string, unknown>[];
    count: number;
    success: true;
  }> {
    await this.ensureDefaults(organizationId);

    let query = this.client
      .from(TABLE)
      .select('*')
      .eq('organization_id', organizationId);

    if (filter?.is_active !== undefined) {
      query = query.eq('is_active', filter.is_active);
    }
    if (filter?.is_deleted !== undefined) {
      query = query.eq('is_deleted', filter.is_deleted);
    } else {
      query = query.eq('is_deleted', false);
    }
    if (filter?.search) {
      const safe = filter.search.replace(/[,.()"'\\]/g, '');
      if (safe.length > 0) {
        query = query.or(
          `name.ilike.%${safe}%,description.ilike.%${safe}%,key.ilike.%${safe}%`,
        );
      }
    }

    const { data, error } = await query.order('sort_order', {
      ascending: true,
    });
    if (error) throw new BadRequestException(error.message);

    const types = (data ?? []) as Record<string, unknown>[];
    const stats = await this.computeStats(organizationId);

    const withStats = types.map((t) => ({
      ...t,
      ...(stats[t['id'] as string] ?? {
        total_spaces: 0,
        active_spaces: 0,
        archived_spaces: 0,
        deleted_spaces: 0,
      }),
    }));

    return { data: withStats, count: withStats.length, success: true };
  }

  async getById(
    id: string,
    organizationId: string,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Space type not found');
    return { data: data as Record<string, unknown>, success: true };
  }

  async create(
    organizationId: string,
    userId: string,
    dto: CreateSpaceTypeDto,
  ): Promise<{
    data: Record<string, unknown>;
    success: true;
    message: string;
  }> {
    const key = generateSpaceTypeKey(dto.name);
    await this.assertKeyAvailable(organizationId, key);

    const stInsertResult = (await this.client
      .from(TABLE)
      .insert({
        organization_id: organizationId,
        name: dto.name,
        key,
        description: dto.description ?? null,
        icon: dto.icon ?? null,
        color: dto.color ?? '#6B7280',
        sort_order: dto.sort_order ?? 0,
        is_active: true,
        is_deleted: false,
        is_default: false,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single()) as {
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    };
    const { data, error } = stInsertResult;

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to create space type',
      );
    }

    this.logAudit(organizationId, userId, data['id'] as string, 'create', {
      name: dto.name,
      key,
      is_active: true,
    });

    return {
      data,
      success: true,
      message: 'Space type created successfully',
    };
  }

  async update(
    id: string,
    organizationId: string,
    userId: string,
    dto: UpdateSpaceTypeDto,
  ): Promise<{
    data: Record<string, unknown>;
    success: true;
    message: string;
  }> {
    const { data: existing } = await this.getById(id, organizationId);

    const patch: Record<string, unknown> = {
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };
    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.description !== undefined) patch['description'] = dto.description;
    if (dto.icon !== undefined) patch['icon'] = dto.icon;
    if (dto.color !== undefined) patch['color'] = dto.color;
    if (dto.sort_order !== undefined) patch['sort_order'] = dto.sort_order;
    if (dto.is_active !== undefined) patch['is_active'] = dto.is_active;

    const updatableFields = Object.keys(patch).filter(
      (k) => k !== 'updated_by' && k !== 'updated_at',
    );
    if (updatableFields.length === 0) {
      throw new BadRequestException(
        'At least one field must be provided for update',
      );
    }

    if (dto.name && dto.name !== existing['name']) {
      const newKey = generateSpaceTypeKey(dto.name);
      await this.assertKeyAvailable(organizationId, newKey, id);
      patch['key'] = newKey;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to update space type',
      );
    }

    this.logAudit(organizationId, userId, id, 'update', patch);

    return {
      data: data as Record<string, unknown>,
      success: true,
      message: 'Space type updated successfully',
    };
  }

  async delete(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    const { data: existing } = await this.getById(id, organizationId);

    if (existing['is_default']) {
      throw new BadRequestException('Cannot delete default space types');
    }

    const { error } = await this.client
      .from(TABLE)
      .update({
        is_deleted: true,
        is_active: false,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
    this.logAudit(organizationId, userId, id, 'delete', {
      name: existing['name'],
      key: existing['key'],
    });
    return { success: true, message: 'Space type deleted successfully' };
  }

  async restore(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<{
    data: Record<string, unknown>;
    success: true;
    message: string;
  }> {
    const { data: existing } = await this.getById(id, organizationId);

    if (!existing['is_deleted']) {
      throw new BadRequestException('Space type is not deleted');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({
        is_deleted: false,
        is_active: true,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to restore space type',
      );
    }

    this.logAudit(organizationId, userId, id, 'restore', {
      is_deleted: false,
      is_active: true,
    });

    return {
      data: data as Record<string, unknown>,
      success: true,
      message: 'Space type restored successfully',
    };
  }

  async toggleActive(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<{
    data: Record<string, unknown>;
    success: true;
    message: string;
  }> {
    const { data: existing } = await this.getById(id, organizationId);

    const currentlyActive = existing['is_active'] as boolean;

    if (currentlyActive && existing['is_default']) {
      throw new BadRequestException('Cannot deactivate default space types');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({
        is_active: !currentlyActive,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to toggle space type',
      );
    }

    const message = currentlyActive
      ? 'Space type deactivated'
      : 'Space type activated';
    this.logAudit(organizationId, userId, id, 'update', {
      is_active: !currentlyActive,
    });
    return { data: data as Record<string, unknown>, success: true, message };
  }

  private async ensureDefaults(organizationId: string): Promise<void> {
    const { count } = await this.client
      .from(TABLE)
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId);

    if ((count ?? 0) > 0) return;

    const rows = DEFAULT_SPACE_TYPES.map((t, i) => ({
      organization_id: organizationId,
      name: t.name,
      key: t.key,
      color: t.color,
      sort_order: i,
      is_active: true,
      is_deleted: false,
      is_default: true,
    }));

    await this.client.from(TABLE).insert(rows);
  }

  private async computeStats(organizationId: string): Promise<
    Record<
      string,
      {
        total_spaces: number;
        active_spaces: number;
        archived_spaces: number;
        deleted_spaces: number;
      }
    >
  > {
    const { data } = await this.client
      .from('spaces')
      .select('space_type_id, is_active, is_archived, is_deleted')
      .eq('organization_id', organizationId);

    const stats: Record<
      string,
      {
        total_spaces: number;
        active_spaces: number;
        archived_spaces: number;
        deleted_spaces: number;
      }
    > = {};

    for (const s of (data ?? []) as Array<{
      space_type_id: string | null;
      is_active: boolean;
      is_archived: boolean;
      is_deleted: boolean;
    }>) {
      const tid = s.space_type_id;
      if (!tid) continue;
      if (!stats[tid])
        stats[tid] = {
          total_spaces: 0,
          active_spaces: 0,
          archived_spaces: 0,
          deleted_spaces: 0,
        };
      stats[tid].total_spaces++;
      if (s.is_active && !s.is_archived && !s.is_deleted)
        stats[tid].active_spaces++;
      if (s.is_archived) stats[tid].archived_spaces++;
      if (s.is_deleted) stats[tid].deleted_spaces++;
    }

    return stats;
  }

  private async assertKeyAvailable(
    organizationId: string,
    key: string,
    excludeId?: string,
  ): Promise<void> {
    let query = this.client
      .from(TABLE)
      .select('id')
      .eq('organization_id', organizationId)
      .eq('key', key);

    if (excludeId) query = query.neq('id', excludeId);

    const { data } = await query.maybeSingle();
    if (data) {
      throw new ConflictException(
        `A space type with key "${key}" already exists`,
      );
    }
  }

  private logAudit(
    organizationId: string,
    userId: string | null | undefined,
    entityId: string,
    action: 'create' | 'update' | 'delete' | 'restore',
    changes?: Record<string, unknown>,
  ): void {
    if (!userId || !this.auditLogsService) return;
    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'space_type',
      entityId,
      action,
      changes,
    );
  }
}
