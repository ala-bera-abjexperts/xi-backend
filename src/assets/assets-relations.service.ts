import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import type { CreateRelationDto } from './dto/create-relation.dto';

const TABLE = 'asset_item_relations';

@Injectable()
export class AssetsRelationsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly outboxService?: AutomationEventOutboxService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getAll(
    itemId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(
        `
        *,
        relation_type:relation_types!asset_item_relations_relation_type_id_fkey(id,name,name_i18n,outward_description,inward_description,color,icon,is_directional),
        source_item:asset_items!asset_item_relations_source_item_id_fkey(id,title,schema_id,schema:asset_schemas!asset_items_schema_id_fkey(id,name,key,icon)),
        target_item:asset_items!asset_item_relations_target_item_id_fkey(id,title,schema_id,schema:asset_schemas!asset_items_schema_id_fkey(id,name,key,icon)),
        created_by_user:users!asset_item_relations_created_by_fkey(id,first_name,last_name,email,avatar_url)
      `,
      )
      .eq('organization_id', organizationId)
      .or(`source_item_id.eq.${itemId},target_item_id.eq.${itemId}`)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as Record<string, unknown>[];
  }

  async create(
    itemId: string,
    organizationId: string,
    userId: string,
    dto: CreateRelationDto,
  ): Promise<Record<string, unknown>> {
    if (dto.target_item_id === itemId) {
      throw new BadRequestException(
        'Cannot create a relation between an item and itself',
      );
    }

    // Check for duplicate
    const { data: dup } = await this.client
      .from(TABLE)
      .select('id')
      .eq('source_item_id', itemId)
      .eq('target_item_id', dto.target_item_id)
      .eq('relation_type_id', dto.relation_type_id)
      .maybeSingle();

    if (dup) throw new BadRequestException('This relation already exists');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        organization_id: organizationId,
        source_item_id: itemId,
        target_item_id: dto.target_item_id,
        relation_type_id: dto.relation_type_id,
        created_by: userId,
      })
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to create relation',
      );

    // Emit automation event
    void (async () => {
      const { data: item } = await this.client
        .from('asset_items')
        .select('id, title, schema_id, organization_id')
        .eq('id', itemId)
        .maybeSingle();

      if (item?.organization_id) {
        void this.outboxService?.write(
          item.organization_id as string,
          null,
          'app.asset.relation_added',
          {
            schemaId: item.schema_id,
            assetItem: {
              id: item.id,
              title: item.title ?? '',
              schema_id: item.schema_id ?? '',
              organization_id: item.organization_id,
            },
            relatedAssetItemId: dto.target_item_id,
            relationType: dto.relation_type_id,
          },
        );
      }
    })();

    return data as Record<string, unknown>;
  }

  async delete(
    relationId: string,
    organizationId: string,
  ): Promise<{ success: true }> {
    const { data: existing } = await this.client
      .from(TABLE)
      .select('id')
      .eq('id', relationId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!existing) throw new NotFoundException('Relation not found');

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', relationId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
    return { success: true };
  }
}
