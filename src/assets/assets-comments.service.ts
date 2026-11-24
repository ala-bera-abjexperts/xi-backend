import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AssetsHistoryService } from './assets-history.service';
import type { CreateCommentDto } from './dto/create-comment.dto';
import type { UpdateCommentDto } from './dto/update-comment.dto';

const TABLE = 'asset_item_comments';
const ITEMS_TABLE = 'asset_items';

@Injectable()
export class AssetsCommentsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly history: AssetsHistoryService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async resolveSchemaId(itemId: string): Promise<string | null> {
    const { data } = await this.client
      .from(ITEMS_TABLE)
      .select('schema_id')
      .eq('id', itemId)
      .maybeSingle();
    return data
      ? ((data as Record<string, unknown>)['schema_id'] as string)
      : null;
  }

  async getAll(
    itemId: string,
    organizationId: string,
  ): Promise<{ data: Record<string, unknown>[]; count: number }> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(
        '*, user:users!asset_item_comments_created_by_fkey(first_name,last_name,avatar_url)',
      )
      .eq('item_id', itemId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    return { data: rows, count: rows.length };
  }

  async create(
    itemId: string,
    organizationId: string,
    userId: string,
    dto: CreateCommentDto,
  ): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        item_id: itemId,
        organization_id: organizationId,
        content: dto.content,
        created_by: userId,
      })
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to create comment',
      );

    const schemaId = await this.resolveSchemaId(itemId);
    if (schemaId) {
      await this.history
        .logChange(
          itemId,
          schemaId,
          organizationId,
          'description_update',
          userId,
          {
            metadata: { action: 'comment_added' },
          },
        )
        .catch(() => undefined);
    }
    return data as Record<string, unknown>;
  }

  async update(
    commentId: string,
    itemId: string,
    organizationId: string,
    userId: string,
    dto: UpdateCommentDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const { data: existing, error: fetchError } = await this.client
      .from(TABLE)
      .select('created_by')
      .eq('id', commentId)
      .eq('item_id', itemId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (fetchError) throw new BadRequestException(fetchError.message);
    if (!existing) throw new NotFoundException('Comment not found');
    if ((existing as Record<string, unknown>)['created_by'] !== userId) {
      throw new BadRequestException(
        'Only the comment author can edit this comment',
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({ content: dto.content, updated_at: new Date().toISOString() })
      .eq('id', commentId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to update comment',
      );

    const schemaId = await this.resolveSchemaId(itemId);
    if (schemaId) {
      await this.history
        .logChange(
          itemId,
          schemaId,
          organizationId,
          'description_update',
          userId,
          {
            metadata: { action: 'comment_updated' },
          },
        )
        .catch(() => undefined);
    }
    return { data: data as Record<string, unknown>, success: true };
  }

  async delete(
    commentId: string,
    itemId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    const { data: existing, error: fetchError } = await this.client
      .from(TABLE)
      .select('created_by')
      .eq('id', commentId)
      .eq('item_id', itemId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (fetchError) throw new BadRequestException(fetchError.message);
    if (!existing) throw new NotFoundException('Comment not found');
    if ((existing as Record<string, unknown>)['created_by'] !== userId) {
      throw new BadRequestException(
        'Only the comment author can delete this comment',
      );
    }

    const schemaId = await this.resolveSchemaId(itemId);

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', commentId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    if (schemaId) {
      await this.history
        .logChange(
          itemId,
          schemaId,
          organizationId,
          'description_update',
          userId,
          {
            metadata: { action: 'comment_deleted' },
          },
        )
        .catch(() => undefined);
    }
    return { success: true, message: 'Comment deleted' };
  }
}
