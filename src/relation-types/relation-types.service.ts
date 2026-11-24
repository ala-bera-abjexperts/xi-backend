/**
 * @fileoverview Service for relation types — CRUD, system-type protection,
 * in-use protection, duplicate, toggle_active. Org-scoped.
 * @module src/relation-types/relation-types.service
 * @author Prince Jadiya
 */

import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { CreateRelationTypeDto } from './dto/create-relation-type.dto';
import type { UpdateRelationTypeDto } from './dto/update-relation-type.dto';

export interface RelationType {
  id: string;
  organization_id: string;
  name: string;
  outward_description: string;
  inward_description: string;
  name_i18n: Record<string, string>;
  outward_description_i18n: Record<string, string>;
  inward_description_i18n: Record<string, string>;
  color: string | null;
  icon: string | null;
  is_directional: boolean;
  is_system: boolean;
  is_active: boolean;
  is_deleted: boolean;
  sort_order: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class RelationTypesService {
  private static readonly TABLE = 'relation_types';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  async getAll(
    organizationId: string,
    includeInactive = false,
  ): Promise<RelationType[]> {
    let query = this.client
      .from(RelationTypesService.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('is_deleted', false);

    if (!includeInactive) {
      query = query.eq('is_active', true);
    }

    const r = await query
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as RelationType[];
  }

  async getById(id: string, organizationId: string): Promise<RelationType> {
    const r = await this.client
      .from(RelationTypesService.TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .eq('is_deleted', false)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Relation type not found');
    return r.data as RelationType;
  }

  // ------------------------------------------------------------------
  // Create
  // ------------------------------------------------------------------

  async create(
    organizationId: string,
    userId: string | null,
    dto: CreateRelationTypeDto,
  ): Promise<RelationType> {
    const input = { ...(dto as unknown as Record<string, unknown>) };
    delete input['organizationId'];

    await this.assertNameUnique(organizationId, input.name as string);

    const row = {
      organization_id: organizationId,
      name: input.name,
      outward_description: input.outward_description,
      inward_description: input.inward_description,
      name_i18n: input.name_i18n ?? {},
      outward_description_i18n: input.outward_description_i18n ?? {},
      inward_description_i18n: input.inward_description_i18n ?? {},
      color: input.color ?? '#6B7280',
      icon: input.icon ?? null,
      is_directional: input.is_directional ?? true,
      is_active: input.is_active ?? true,
      sort_order: input.sort_order ?? 0,
      created_by: userId,
      updated_by: userId,
    };
    const r = await this.client
      .from(RelationTypesService.TABLE)
      .insert(row)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const relationType = r.data as RelationType;

    this.logAudit(
      organizationId,
      userId,
      'relation_type',
      relationType.id,
      'create',
      {
        name: relationType.name,
        is_directional: relationType.is_directional,
        is_active: relationType.is_active,
      },
    );

    return relationType;
  }

  // ------------------------------------------------------------------
  // Update
  // ------------------------------------------------------------------

  async update(
    id: string,
    organizationId: string,
    userId: string | null,
    dto: UpdateRelationTypeDto,
  ): Promise<RelationType> {
    const existing = await this.getById(id, organizationId);
    if (existing.is_system) {
      throw new ForbiddenException('Cannot modify system relation types');
    }

    if (dto.name && dto.name !== existing.name) {
      await this.assertNameUnique(organizationId, dto.name, id);
    }

    const patch: Record<string, unknown> = {};
    for (const key of [
      'name',
      'outward_description',
      'inward_description',
      'name_i18n',
      'outward_description_i18n',
      'inward_description_i18n',
      'color',
      'icon',
      'is_directional',
      'is_active',
      'sort_order',
    ] as const) {
      if (dto[key] !== undefined) patch[key] = dto[key];
    }

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException(
        'At least one field must be provided for update',
      );
    }

    patch.updated_by = userId;
    patch.updated_at = new Date().toISOString();

    const r = await this.client
      .from(RelationTypesService.TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const relationType = r.data as RelationType;

    this.logAudit(
      organizationId,
      userId,
      'relation_type',
      relationType.id,
      'update',
      patch,
    );

    return relationType;
  }

  // ------------------------------------------------------------------
  // Delete
  // ------------------------------------------------------------------

  async delete(
    id: string,
    organizationId: string,
    userId?: string | null,
  ): Promise<void> {
    const existing = await this.getById(id, organizationId);
    if (existing.is_system) {
      throw new ForbiddenException('Cannot delete system relation types');
    }

    const usageCount = await this.getUsageCount(id, organizationId);
    if (usageCount > 0) {
      throw new ConflictException({
        message:
          'Cannot delete relation type that is in use. Please remove all references first.',
        data: { usageCount },
      });
    }

    // Soft-delete — table has is_deleted, deleted_at, deleted_by columns
    const r = await this.client
      .from(RelationTypesService.TABLE)
      .update({
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        deleted_by: userId ?? null,
      })
      .eq('id', id)
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);

    this.logAudit(
      organizationId,
      userId ?? null,
      'relation_type',
      id,
      'delete',
      { name: existing.name },
    );
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  async toggleActive(
    id: string,
    isActive: boolean,
    organizationId: string,
    userId?: string | null,
  ): Promise<RelationType> {
    const existing = await this.getById(id, organizationId);
    if (existing.is_system) {
      throw new ForbiddenException(
        'Cannot change active status of system relation types',
      );
    }
    const r = await this.client
      .from(RelationTypesService.TABLE)
      .update({
        is_active: isActive,
        updated_by: userId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const relationType = r.data as RelationType;

    this.logAudit(
      organizationId,
      userId ?? null,
      'relation_type',
      relationType.id,
      'update',
      { is_active: isActive },
    );

    return relationType;
  }

  async duplicate(
    id: string,
    organizationId: string,
    userId: string | null,
    newName?: string,
  ): Promise<RelationType> {
    const source = await this.getById(id, organizationId);
    const duplicateName = newName?.trim() || `${source.name} (Copy)`;
    await this.assertNameUnique(organizationId, duplicateName);
    return this.create(organizationId, userId, {
      name: duplicateName,
      outward_description: source.outward_description,
      inward_description: source.inward_description,
      name_i18n: source.name_i18n,
      outward_description_i18n: source.outward_description_i18n,
      inward_description_i18n: source.inward_description_i18n,
      color: source.color,
      icon: source.icon,
      is_directional: source.is_directional,
      is_active: true,
      sort_order: source.sort_order + 1,
    });
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async getUsageCount(
    id: string,
    organizationId: string,
  ): Promise<number> {
    let total = 0;

    for (const table of [
      'task_relationships',
      'process_relationships',
      'asset_item_relations',
    ]) {
      const r = await this.client
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('relation_type_id', id)
        .eq('organization_id', organizationId);
      if (r.error) throw new BadRequestException(r.error.message);
      total += r.count ?? 0;
    }

    return total;
  }

  private logAudit(
    organizationId: string,
    userId: string | null | undefined,
    entityType: string,
    entityId: string,
    action: 'create' | 'update' | 'delete',
    changes?: Record<string, unknown>,
  ): void {
    if (!userId) return;
    void this.auditLogsService.logAction(
      organizationId,
      userId,
      entityType,
      entityId,
      action,
      changes,
    );
  }

  async reorder(
    items: { id: string; sort_order: number }[],
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    await Promise.all(
      items.map((item) =>
        this.client
          .from(RelationTypesService.TABLE)
          .update({ sort_order: item.sort_order })
          .eq('id', item.id)
          .eq('organization_id', organizationId)
          .then((r) => {
            if (r.error) throw new BadRequestException(r.error.message);
          }),
      ),
    );
    this.logAudit(
      organizationId,
      actorUserId,
      'relation_type',
      items[0]?.id,
      'update',
      { reorder: items },
    );
  }

  private async assertNameUnique(
    organizationId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    let query = this.client
      .from(RelationTypesService.TABLE)
      .select('id')
      .eq('organization_id', organizationId)
      .eq('name', name)
      .eq('is_deleted', false);

    if (excludeId) {
      query = query.neq('id', excludeId);
    }

    const r = await query.maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (r.data) {
      throw new ConflictException(
        `A relation type with name '${name}' already exists`,
      );
    }
  }
}
