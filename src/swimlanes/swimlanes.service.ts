import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { CreateSwimlaneDto } from './dto/create-swimlane.dto';
import type { UpdateSwimlaneDto } from './dto/update-swimlane.dto';
import type { ReorderSwimlanesDto } from './dto/reorder-swimlanes.dto';

const TABLE = 'board_swimlanes';

@Injectable()
export class SwimlanesService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async verifyBoard(
    boardId: string,
    organizationId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('boards')
      .select('id')
      .eq('id', boardId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Board not found');
  }

  async getAll(
    boardId: string,
    organizationId: string,
  ): Promise<{ data: Record<string, unknown>[]; count: number }> {
    await this.verifyBoard(boardId, organizationId);

    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('board_id', boardId)
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    return { data: rows, count: rows.length };
  }

  async create(
    boardId: string,
    organizationId: string,
    dto: CreateSwimlaneDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.verifyBoard(boardId, organizationId);

    let sortOrder = dto.sort_order;
    if (sortOrder === undefined) {
      const { data: maxRow } = await this.client
        .from(TABLE)
        .select('sort_order')
        .eq('board_id', boardId)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();

      sortOrder =
        maxRow != null
          ? ((maxRow as Record<string, unknown>)['sort_order'] as number) + 1
          : 0;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        board_id: boardId,
        name: dto.name,
        query: dto.query ?? null,
        description: dto.description ?? null,
        sort_order: sortOrder,
        is_default: dto.is_default ?? false,
      })
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to create swimlane',
      );
    return { data: data as Record<string, unknown>, success: true };
  }

  async update(
    swimlaneId: string,
    boardId: string,
    organizationId: string,
    dto: UpdateSwimlaneDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.verifyBoard(boardId, organizationId);

    const { data: existing, error: fetchErr } = await this.client
      .from(TABLE)
      .select('id')
      .eq('id', swimlaneId)
      .eq('board_id', boardId)
      .maybeSingle();

    if (fetchErr) throw new BadRequestException(fetchErr.message);
    if (!existing) throw new NotFoundException('Swimlane not found');

    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.query !== undefined) patch['query'] = dto.query;
    if (dto.description !== undefined) patch['description'] = dto.description;
    if (dto.sort_order !== undefined) patch['sort_order'] = dto.sort_order;
    if (dto.is_default !== undefined) patch['is_default'] = dto.is_default;

    if (Object.keys(patch).length === 0) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data: current } = await this.client
        .from(TABLE)
        .select('*')
        .eq('id', swimlaneId)
        .single();
      return {
        data: (current ?? {}) as Record<string, unknown>,
        success: true,
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', swimlaneId)
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to update swimlane',
      );
    return { data: data as Record<string, unknown>, success: true };
  }

  async delete(
    swimlaneId: string,
    boardId: string,
    organizationId: string,
  ): Promise<{ success: true; message: string }> {
    await this.verifyBoard(boardId, organizationId);

    const { data: row, error: fetchErr } = await this.client
      .from(TABLE)
      .select('id, is_default')
      .eq('id', swimlaneId)
      .eq('board_id', boardId)
      .maybeSingle();

    if (fetchErr) throw new BadRequestException(fetchErr.message);
    if (!row) throw new NotFoundException('Swimlane not found');

    if ((row as Record<string, unknown>)['is_default'] === true) {
      throw new BadRequestException(
        'Cannot delete the default swimlane. It serves as the catch-all for unmatched tasks.',
      );
    }

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', swimlaneId);

    if (error) throw new BadRequestException(error.message);
    return { success: true, message: 'Swimlane deleted' };
  }

  async reorder(
    boardId: string,
    organizationId: string,
    dto: ReorderSwimlanesDto,
  ): Promise<{ success: true }> {
    await this.verifyBoard(boardId, organizationId);

    if (dto.swimlanes.length === 0) return { success: true };

    for (const item of dto.swimlanes) {
      const { error } = await this.client
        .from(TABLE)
        .update({ sort_order: item.sort_order })
        .eq('id', item.id)
        .eq('board_id', boardId);

      if (error) throw new BadRequestException(error.message);
    }

    return { success: true };
  }
}
