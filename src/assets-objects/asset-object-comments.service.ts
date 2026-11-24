import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AssetObjectHistoryService } from './asset-object-history.service';
import type { CreateAssetObjectCommentDto } from './dto/create-asset-object-comment.dto';
import type { UpdateAssetObjectCommentDto } from './dto/update-asset-object-comment.dto';

const TABLE = 'asset_object_comments';
const OBJECTS_TABLE = 'asset_objects';

@Injectable()
export class AssetObjectCommentsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly history: AssetObjectHistoryService,
    private readonly outboxService: AutomationEventOutboxService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async resolveObjectMeta(
    objectId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<{ schemaId: string | null; name: string | null }> {
    const { data } = await this.client
      .from(OBJECTS_TABLE)
      .select('schema_id, name')
      .eq('id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!data) return { schemaId: null, name: null };

    const row = data as Record<string, unknown>;

    return {
      schemaId: row['schema_id'] as string | null,
      name: row['name'] as string | null,
    };
  }

  async getAll(
    objectId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<{ data: Record<string, unknown>[]; count: number }> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(
        '*, user:users!asset_object_comments_created_by_fkey(id,first_name,last_name,avatar_url)',
      )
      .eq('object_id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    const rows = (data ?? []) as Record<string, unknown>[];

    return { data: rows, count: rows.length };
  }

  async create(
    objectId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
    dto: CreateAssetObjectCommentDto,
  ): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        object_id: objectId,
        space_id: spaceId,
        organization_id: organizationId,
        content: dto.content,
        created_by: userId,
      })
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to create comment',
      );
    }

    const { schemaId, name: assetName } = await this.resolveObjectMeta(
      objectId,
      spaceId,
      organizationId,
    );

    if (schemaId) {
      await this.history
        .logChange(
          objectId,
          schemaId,
          organizationId,
          spaceId,
          'comment_added',
          userId,
          {
            metadata: { commentId: (data as Record<string, unknown>)['id'] },
          },
        )
        .catch(() => undefined);
    }

    void this.outboxService.write(
      organizationId,
      spaceId,
      'app.asset_object.comment_added',
      {
        asset: {
          id: objectId,
          name: assetName ?? '',
          schema_id: schemaId ?? null,
          space_id: spaceId,
          organization_id: organizationId,
        },
        asset_id: objectId,
        schema_id: schemaId ?? null,
        space_id: spaceId,
        organization_id: organizationId,
        comment: {
          id: (data as Record<string, unknown>)['id'] as string,
          body: dto.content,
          author_id: userId,
        },
        created_by: userId,
        author_user_id: userId,
      },
    );

    return data as Record<string, unknown>;
  }

  async update(
    commentId: string,
    objectId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
    dto: UpdateAssetObjectCommentDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const { data: existing, error: fetchError } = await this.client
      .from(TABLE)
      .select('created_by')
      .eq('id', commentId)
      .eq('object_id', objectId)
      .eq('space_id', spaceId)
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
      .eq('space_id', spaceId)
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to update comment',
      );
    }

    const { schemaId, name: assetName } = await this.resolveObjectMeta(
      objectId,
      spaceId,
      organizationId,
    );

    if (schemaId) {
      await this.history
        .logChange(
          objectId,
          schemaId,
          organizationId,
          spaceId,
          'comment_updated',
          userId,
          {
            metadata: { commentId },
          },
        )
        .catch(() => undefined);
    }

    void this.outboxService.write(
      organizationId,
      spaceId,
      'app.asset_object.comment_updated',
      {
        asset: {
          id: objectId,
          name: assetName ?? '',
          schema_id: schemaId ?? null,
          space_id: spaceId,
          organization_id: organizationId,
        },
        asset_id: objectId,
        schema_id: schemaId ?? null,
        space_id: spaceId,
        organization_id: organizationId,
        comment: {
          id: commentId,
          body: dto.content,
          author_id: userId,
        },
        updated_by: userId,
      },
    );

    return { data: data as Record<string, unknown>, success: true };
  }

  async delete(
    commentId: string,
    objectId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    const { data: existing, error: fetchError } = await this.client
      .from(TABLE)
      .select('created_by, content')
      .eq('id', commentId)
      .eq('object_id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (fetchError) throw new BadRequestException(fetchError.message);
    if (!existing) throw new NotFoundException('Comment not found');

    if ((existing as Record<string, unknown>)['created_by'] !== userId) {
      throw new BadRequestException(
        'Only the comment author can delete this comment',
      );
    }

    const commentBody = (existing as Record<string, unknown>)[
      'content'
    ] as string;

    const { schemaId, name: assetName } = await this.resolveObjectMeta(
      objectId,
      spaceId,
      organizationId,
    );

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', commentId)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId);

    if (error) throw new BadRequestException(error.message);

    if (schemaId) {
      await this.history
        .logChange(
          objectId,
          schemaId,
          organizationId,
          spaceId,
          'comment_deleted',
          userId,
          {
            metadata: { commentId },
          },
        )
        .catch(() => undefined);
    }

    void this.outboxService.write(
      organizationId,
      spaceId,
      'app.asset_object.comment_deleted',
      {
        asset: {
          id: objectId,
          name: assetName ?? '',
          schema_id: schemaId ?? null,
          space_id: spaceId,
          organization_id: organizationId,
        },
        asset_id: objectId,
        schema_id: schemaId ?? null,
        space_id: spaceId,
        organization_id: organizationId,
        comment: {
          id: commentId,
          body: commentBody,
          author_id: userId,
        },
        deleted_by: userId,
      },
    );

    return { success: true, message: 'Comment deleted' };
  }
}
