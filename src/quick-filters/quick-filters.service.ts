import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { CreateQuickFilterDto } from './dto/create-quick-filter.dto';
import type { ReorderQuickFiltersDto } from './dto/reorder-quick-filters.dto';
import type { UpdateQuickFilterDto } from './dto/update-quick-filter.dto';

const TABLE = 'board_quick_filters';
const USER_STATE_TABLE = 'board_quick_filter_user_state';

@Injectable()
export class QuickFiltersService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async verifyBoard(
    boardId: string,
    organizationId: string,
  ): Promise<{ id: string }> {
    const { data, error } = await this.client
      .from('boards')
      .select('id')
      .eq('id', boardId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Board not found');
    return data as { id: string };
  }

  private async verifyFilter(
    filterId: string,
    boardId: string,
  ): Promise<Record<string, unknown>> {
    const qfResult = (await this.client
      .from(TABLE)
      .select('*')
      .eq('id', filterId)
      .eq('board_id', boardId)
      .maybeSingle()) as {
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    };

    if (qfResult.error) throw new BadRequestException(qfResult.error.message);
    if (!qfResult.data) throw new NotFoundException('Quick filter not found');
    return qfResult.data;
  }

  async create(
    boardId: string,
    organizationId: string,
    userId: string,
    dto: CreateQuickFilterDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.verifyBoard(boardId, organizationId);

    let nextOrder = dto.sort_order ?? 0;
    if (dto.sort_order === undefined) {
      const { data: maxRow } = await this.client
        .from(TABLE)
        .select('sort_order')
        .eq('board_id', boardId)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();

      nextOrder =
        ((maxRow as Record<string, unknown> | null)?.['sort_order'] as
          | number
          | undefined) !== undefined
          ? ((maxRow as Record<string, unknown>)['sort_order'] as number) + 1
          : 0;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        board_id: boardId,
        name: dto.name,
        query: dto.query,
        description: dto.description ?? null,
        sort_order: nextOrder,
        is_enabled: dto.is_enabled ?? true,
        created_by: userId,
      })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    this.logAudit(
      organizationId,
      userId,
      (data as Record<string, unknown>)['id'] as string,
      'create',
      {
        board_id: boardId,
        name: dto.name,
        sort_order: nextOrder,
        is_enabled: dto.is_enabled ?? true,
      },
    );
    return { data: data as Record<string, unknown>, success: true };
  }

  async update(
    filterId: string,
    boardId: string,
    organizationId: string,
    userId: string,
    dto: UpdateQuickFilterDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.verifyBoard(boardId, organizationId);
    const existing = await this.verifyFilter(filterId, boardId);

    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.query !== undefined) patch['query'] = dto.query;
    if (dto.description !== undefined) patch['description'] = dto.description;
    if (dto.sort_order !== undefined) patch['sort_order'] = dto.sort_order;
    if (dto.is_enabled !== undefined) patch['is_enabled'] = dto.is_enabled;

    if (Object.keys(patch).length === 0) {
      return { data: existing, success: true };
    }

    patch['updated_at'] = new Date().toISOString();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', filterId)
      .eq('board_id', boardId)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    this.logAudit(organizationId, userId, filterId, 'update', {
      board_id: boardId,
      ...patch,
    });
    return { data: data as Record<string, unknown>, success: true };
  }

  async delete(
    filterId: string,
    boardId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    await this.verifyBoard(boardId, organizationId);
    const existing = await this.verifyFilter(filterId, boardId);

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', filterId)
      .eq('board_id', boardId);

    if (error) throw new BadRequestException(error.message);
    this.logAudit(organizationId, userId, filterId, 'delete', {
      board_id: boardId,
      name: existing['name'],
    });
    return { success: true, message: 'Quick filter deleted' };
  }

  async reorder(
    boardId: string,
    organizationId: string,
    userId: string,
    dto: ReorderQuickFiltersDto,
  ): Promise<{ success: true }> {
    await this.verifyBoard(boardId, organizationId);

    if (dto.quick_filters.length === 0) return { success: true };
    const { error } = await this.client.rpc('reorder_board_quick_filters', {
      p_board_id: boardId,
      p_organization_id: organizationId,
      p_items: dto.quick_filters,
    });
    if (error) {
      if (/not found/i.test(error.message)) {
        throw new NotFoundException('Quick filter not found');
      }
      throw new BadRequestException(error.message);
    }

    this.logAudit(organizationId, userId, dto.quick_filters[0]?.id, 'update', {
      board_id: boardId,
      quick_filters: dto.quick_filters,
    });

    return { success: true };
  }

  async setUserState(
    boardId: string,
    filterId: string,
    organizationId: string,
    userId: string,
    isActive: boolean,
  ): Promise<{ success: true }> {
    await this.verifyBoard(boardId, organizationId);
    await this.verifyFilter(filterId, boardId);

    const { error } = await this.client.from(USER_STATE_TABLE).upsert(
      {
        board_id: boardId,
        quick_filter_id: filterId,
        user_id: userId,
        is_active: isActive,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'quick_filter_id,user_id' },
    );

    if (error) throw new BadRequestException(error.message);
    return { success: true };
  }

  private logAudit(
    organizationId: string,
    userId: string | null | undefined,
    entityId: string | null | undefined,
    action: 'create' | 'update' | 'delete',
    changes?: Record<string, unknown>,
  ): void {
    if (!userId || !entityId || !this.auditLogsService) return;
    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'board_quick_filter',
      entityId,
      action,
      changes,
    );
  }
}
