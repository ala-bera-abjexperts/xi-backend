import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { SetCardFieldsDto } from './dto/set-card-fields.dto';
import { CardFieldWidth } from './dto/set-card-fields.dto';

const TABLE = 'board_card_fields';

@Injectable()
export class CardFieldsService {
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

  async getCardFields(
    boardId: string,
    organizationId: string,
  ): Promise<{ data: Record<string, unknown>[] }> {
    await this.verifyBoard(boardId, organizationId);

    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('board_id', boardId)
      .order('position', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return { data: (data ?? []) as Record<string, unknown>[] };
  }

  async setCardFields(
    boardId: string,
    organizationId: string,
    dto: SetCardFieldsDto,
  ): Promise<{ data: Record<string, unknown>[]; success: true }> {
    await this.verifyBoard(boardId, organizationId);

    // Delete all existing card fields for this board
    const { error: deleteError } = await this.client
      .from(TABLE)
      .delete()
      .eq('board_id', boardId);

    if (deleteError) throw new BadRequestException(deleteError.message);

    if (dto.fields.length === 0) {
      return { data: [], success: true };
    }

    // Insert new fields
    const rows = dto.fields.map((f) => ({
      board_id: boardId,
      custom_field_id: f.custom_field_id,
      position: f.position,
      width: f.width ?? CardFieldWidth.AUTO,
      color: f.color ?? null,
    }));

    const { data, error } = await this.client
      .from(TABLE)
      .insert(rows)
      .select()
      .order('position', { ascending: true });

    if (error)
      throw new BadRequestException(
        error.message ?? 'Failed to set card fields',
      );

    return {
      data: (data ?? []) as Record<string, unknown>[],
      success: true,
    };
  }
}
