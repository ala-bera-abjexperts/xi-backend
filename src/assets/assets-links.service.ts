import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { CreateLinkDto } from './dto/create-link.dto';

const TABLE = 'asset_item_links';

@Injectable()
export class AssetsLinksService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getAll(
    itemId: string,
    organizationId: string,
  ): Promise<{ data: Record<string, unknown>[]; count: number }> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .or(`source_id.eq.${itemId},target_id.eq.${itemId}`)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    return { data: rows, count: rows.length };
  }

  async create(
    itemId: string,
    organizationId: string,
    userId: string,
    dto: CreateLinkDto,
  ): Promise<Record<string, unknown>> {
    if (dto.target_type === 'asset_item' && dto.target_id === itemId) {
      throw new BadRequestException('Cannot link an item to itself');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        organization_id: organizationId,
        source_type: 'asset_item',
        source_id: itemId,
        target_type: dto.target_type,
        target_id: dto.target_id,
        link_type: dto.link_type ?? 'related',
        created_by: userId,
      })
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(error?.message ?? 'Failed to create link');
    return data as Record<string, unknown>;
  }

  async delete(
    linkId: string,
    organizationId: string,
  ): Promise<{ success: true; message: string }> {
    const { data: existing } = await this.client
      .from(TABLE)
      .select('id')
      .eq('id', linkId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!existing) throw new NotFoundException('Link not found');

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', linkId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
    return { success: true, message: 'Link deleted' };
  }
}
