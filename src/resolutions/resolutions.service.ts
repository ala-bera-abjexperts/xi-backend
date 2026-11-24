/**
 * @fileoverview Service for resolutions — captures why a task was closed.
 * @module src/resolutions/resolutions.service
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
import type { CreateResolutionDto } from './dto/create-resolution.dto';
import type { UpdateResolutionDto } from './dto/update-resolution.dto';

export interface Resolution {
  id: string;
  organization_id: string;
  name: string;
  key: string;
  description: string | null;
  sort_order: number;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class ResolutionsService {
  private static readonly TABLE = 'resolutions';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getAll(organizationId: string): Promise<Resolution[]> {
    const r = await this.client
      .from(ResolutionsService.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as Resolution[];
  }

  async getById(id: string, organizationId: string): Promise<Resolution> {
    const r = await this.client
      .from(ResolutionsService.TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Resolution not found');
    return r.data as Resolution;
  }

  async create(
    organizationId: string,
    dto: CreateResolutionDto,
    actorUserId?: string | null,
  ): Promise<Resolution> {
    const row = {
      organization_id: organizationId,
      name: dto.name,
      key: dto.key,
      description: dto.description ?? null,
      sort_order: dto.sort_order ?? 0,
      // H1: Always insert with is_default=false; callers must use PATCH :id/set-default
      // to promote a resolution, which enforces the one-default-per-org invariant.
      is_default: false,
      is_active: dto.is_active ?? true,
    };
    const r = await this.client
      .from(ResolutionsService.TABLE)
      .insert(row)
      .select()
      .single();

    if (r.error) {
      if (r.error.code === '23505')
        throw new ConflictException(
          `A resolution with key '${dto.key}' already exists`,
        );
      throw new BadRequestException(r.error.message);
    }
    const created = r.data as Resolution;

    this.logAudit(organizationId, actorUserId, created.id, 'create', {
      name: created.name,
      key: created.key,
    });
    return created;
  }

  async update(
    id: string,
    organizationId: string,
    dto: UpdateResolutionDto,
    actorUserId?: string | null,
  ): Promise<Resolution> {
    await this.getById(id, organizationId);
    const patch: Record<string, unknown> = {};

    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.description !== undefined) patch['description'] = dto.description;
    if (dto.sort_order !== undefined) patch['sort_order'] = dto.sort_order;
    if (dto.is_active !== undefined) patch['is_active'] = dto.is_active;

    if (Object.keys(patch).length === 0)
      throw new BadRequestException(
        'At least one field must be provided for update',
      );

    const r = await this.client
      .from(ResolutionsService.TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (r.error) throw new BadRequestException(r.error.message);
    this.logAudit(organizationId, actorUserId, id, 'update', patch);
    return r.data as Resolution;
  }

  async delete(
    id: string,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    const existing = await this.getById(id, organizationId);

    // SVC-H3: never delete the org's default resolution — that would leave the
    // org with zero defaults (the partial unique index only prevents >1).
    if (existing.is_default) {
      throw new ConflictException(
        'Cannot delete the default resolution. Set another resolution as default first.',
      );
    }

    const r = await this.client
      .from(ResolutionsService.TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (r.error) throw new BadRequestException(r.error.message);
    this.logAudit(organizationId, actorUserId, id, 'delete', {
      name: existing.name,
      key: existing.key,
    });
  }

  async setDefault(
    id: string,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<Resolution> {
    const existing = await this.getById(id, organizationId);

    // SVC-H5: do the clear + promote in a single atomic statement via RPC so
    // there is never a "zero defaults" window or a clear-then-set TOCTOU
    // between concurrent callers. Falls back to the two-statement path if the
    // RPC hasn't been applied yet (graceful pre-migration degradation).
    const rpc = await this.client.rpc('set_default_resolution', {
      p_id: id,
      p_organization_id: organizationId,
    });

    if (rpc.error) {
      const code = (rpc.error as { code?: string }).code ?? '';
      const message = rpc.error.message ?? '';
      const rpcMissing =
        code === 'PGRST202' ||
        code === '42883' ||
        /does not exist/i.test(message) ||
        /could not find the function/i.test(message);

      if (!rpcMissing) {
        throw new BadRequestException(message);
      }

      // Fallback: clear the existing default FIRST, then promote the target.
      // The resolutions_one_default_per_org partial unique index is
      // non-deferrable, so promoting before clearing would violate it.
      const clearR = await this.client
        .from(ResolutionsService.TABLE)
        .update({ is_default: false })
        .eq('organization_id', organizationId)
        .eq('is_default', true)
        .neq('id', id);

      if (clearR.error) throw new BadRequestException(clearR.error.message);

      const setR = await this.client
        .from(ResolutionsService.TABLE)
        .update({ is_default: true })
        .eq('id', id)
        .eq('organization_id', organizationId);

      if (setR.error) throw new BadRequestException(setR.error.message);
    }

    this.logAudit(organizationId, actorUserId, id, 'update', {
      is_default: true,
      name: existing.name,
    });

    return this.getById(id, organizationId);
  }

  async reorder(
    items: { id: string; sort_order: number }[],
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    await Promise.all(
      items.map((item) =>
        this.client
          .from(ResolutionsService.TABLE)
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
      'resolution',
      entityId,
      action,
      changes,
    );
  }
}
