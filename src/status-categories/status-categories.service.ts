/**
 * @fileoverview Service for status categories — org-scoped groupings for task statuses.
 * @module src/status-categories/status-categories.service
 * @author Rajbha Manek
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
import type { CreateStatusCategoryDto } from './dto/create-status-category.dto';
import type { UpdateStatusCategoryDto } from './dto/update-status-category.dto';

export interface StatusCategory {
  id: string;
  organization_id: string;
  space_id: string | null;
  name: string;
  key: string;
  color: string;
  text_color: string;
  sort_order: number;
  is_system: boolean;
  is_done_like: boolean;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class StatusCategoriesService {
  private static readonly TABLE = 'status_categories';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getAll(
    organizationId: string,
    spaceId?: string,
  ): Promise<StatusCategory[]> {
    let query = this.client
      .from(StatusCategoriesService.TABLE)
      .select('*')
      .eq('organization_id', organizationId);

    if (spaceId) {
      query = query.or(`space_id.is.null,space_id.eq.${spaceId}`);
    } else {
      query = query.is('space_id', null);
    }

    const r = await query
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as StatusCategory[];
  }

  async getById(id: string, organizationId: string): Promise<StatusCategory> {
    const r = await this.client
      .from(StatusCategoriesService.TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Status category not found');
    return r.data as StatusCategory;
  }

  async create(
    organizationId: string,
    dto: CreateStatusCategoryDto,
    actorUserId?: string | null,
  ): Promise<StatusCategory> {
    // H3: Validate space_id belongs to this org (mirrors TaskStatusesService.assertSpaceInOrganization)
    if (dto.space_id) {
      const spaceR = await this.client
        .from('spaces')
        .select('id')
        .eq('id', dto.space_id)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (spaceR.error) throw new BadRequestException(spaceR.error.message);
      if (!spaceR.data) throw new NotFoundException('Space not found');
    }

    const row = {
      organization_id: organizationId,
      space_id: dto.space_id ?? null,
      name: dto.name,
      key: dto.key,
      color: dto.color,
      text_color: dto.text_color ?? '#FFFFFF',
      sort_order: dto.sort_order ?? 0,
      is_system: false,
      is_done_like: dto.is_done_like ?? false,
    };
    const r = await this.client
      .from(StatusCategoriesService.TABLE)
      .insert(row)
      .select()
      .single();

    if (r.error) {
      if (r.error.code === '23505')
        throw new ConflictException(
          `A category with key '${dto.key}' already exists in this scope`,
        );
      throw new BadRequestException(r.error.message);
    }
    const created = r.data as StatusCategory;

    this.logAudit(organizationId, actorUserId, created.id, 'create', {
      name: created.name,
      key: created.key,
    });
    return created;
  }

  async update(
    id: string,
    organizationId: string,
    dto: UpdateStatusCategoryDto,
    actorUserId?: string | null,
  ): Promise<StatusCategory> {
    await this.getById(id, organizationId);
    const patch: Record<string, unknown> = {};

    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.color !== undefined) patch['color'] = dto.color;
    if (dto.text_color !== undefined) patch['text_color'] = dto.text_color;
    if (dto.sort_order !== undefined) patch['sort_order'] = dto.sort_order;
    if (dto.is_done_like !== undefined)
      patch['is_done_like'] = dto.is_done_like;

    if (Object.keys(patch).length === 0)
      throw new BadRequestException(
        'At least one field must be provided for update',
      );

    const r = await this.client
      .from(StatusCategoriesService.TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (r.error) throw new BadRequestException(r.error.message);
    this.logAudit(organizationId, actorUserId, id, 'update', patch);
    return r.data as StatusCategory;
  }

  async delete(
    id: string,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    const existing = await this.getById(id, organizationId);

    if (existing.is_system) {
      throw new ConflictException('Cannot delete a system status category');
    }

    // SVC-H4: the task_statuses.category_id FK is ON DELETE RESTRICT, so a
    // delete with referencing statuses fails with Postgres 23503. Pre-count
    // for a friendly 409 instead of leaking a raw FK error as a 400.
    const refCount = await this.client
      .from('task_statuses')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('category_id', id);

    if (refCount.error) throw new BadRequestException(refCount.error.message);

    if ((refCount.count ?? 0) > 0) {
      throw new ConflictException(
        `Cannot delete category: ${refCount.count} status(es) still use it. Reassign them first.`,
      );
    }

    const r = await this.client
      .from(StatusCategoriesService.TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (r.error) {
      // Defensive: a status was attached between the count and the delete.
      if ((r.error as { code?: string }).code === '23503') {
        throw new ConflictException(
          'Cannot delete category: statuses still reference it. Reassign them first.',
        );
      }
      throw new BadRequestException(r.error.message);
    }
    this.logAudit(organizationId, actorUserId, id, 'delete', {
      name: existing.name,
      key: existing.key,
    });
  }

  async reorder(
    items: { id: string; sort_order: number }[],
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    // H4: Parallelise updates instead of sequential N+1; items array is capped at 500
    // by @ArrayMaxSize on the DTO so Promise.all is safe here.
    await Promise.all(
      items.map((item) =>
        this.client
          .from(StatusCategoriesService.TABLE)
          .update({ sort_order: item.sort_order })
          .eq('id', item.id)
          .eq('organization_id', organizationId)
          .then((r) => {
            if (r.error) throw new BadRequestException(r.error.message);
          }),
      ),
    );
    this.logAudit(organizationId, actorUserId, items[0]?.id, 'update', {
      reorder: items,
    });
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
      'status_category',
      entityId,
      action,
      changes,
    );
  }
}
