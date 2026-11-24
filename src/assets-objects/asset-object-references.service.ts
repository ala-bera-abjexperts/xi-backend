import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AssetObjectHistoryService } from './asset-object-history.service';
import type { CreateAssetObjectReferenceDto } from './dto/create-asset-object-reference.dto';

const TABLE = 'asset_object_references';
const OBJECTS_TABLE = 'asset_objects';

type ObjectRow = Record<string, unknown> & {
  id: string;
  schema_id: string;
  space_id: string;
  organization_id: string;
};

@Injectable()
export class AssetObjectReferencesService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly history: AssetObjectHistoryService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async loadObject(
    id: string,
    spaceId: string,
    organizationId: string,
  ): Promise<ObjectRow> {
    const { data, error } = await this.client
      .from(OBJECTS_TABLE)
      .select('id,schema_id,space_id,organization_id')
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException(`Asset object ${id} not found`);

    return data as ObjectRow;
  }

  async getGrouped(
    spaceId: string,
    organizationId: string,
    objectId: string,
  ): Promise<{
    outbound: Record<string, unknown>[];
    inbound: Record<string, unknown>[];
  }> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(
        `*,
        relation_type:relation_types!asset_object_references_relation_type_id_fkey(
          id,name,color,icon,outward_description,inward_description,is_directional
        ),
        attribute:asset_object_type_attributes!asset_object_references_attribute_id_fkey(
          id,name,field_key,options
        ),
        source_object:asset_objects!asset_object_references_source_object_id_fkey(
          id,object_key,name,object_type_id,image_path
        ),
        target_object:asset_objects!asset_object_references_target_object_id_fkey(
          id,object_key,name,object_type_id,image_path
        )`,
      )
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .or(`source_object_id.eq.${objectId},target_object_id.eq.${objectId}`)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    const rows = (data ?? []) as (Record<string, unknown> & {
      source_object_id: string;
      target_object_id: string;
    })[];

    const outbound = rows.filter((r) => r.source_object_id === objectId);
    const inbound = rows.filter((r) => r.target_object_id === objectId);

    return { outbound, inbound };
  }

  async create(
    spaceId: string,
    organizationId: string,
    userId: string,
    sourceObjectId: string,
    dto: CreateAssetObjectReferenceDto,
  ): Promise<Record<string, unknown>> {
    // 1. Self-reference guard
    if (dto.target_object_id === sourceObjectId) {
      throw new BadRequestException('An object cannot reference itself');
    }
    // 1. Self-reference guard
    if (dto.target_object_id === sourceObjectId) {
      throw new BadRequestException('An object cannot reference itself');
    }

    // 2. Load both objects — 404 if either is missing or out-of-tenant/space
    const [source, target] = await Promise.all([
      this.loadObject(sourceObjectId, spaceId, organizationId),
      this.loadObject(dto.target_object_id, spaceId, organizationId),
    ]);

    // 3. Cross-space leak guard (C5 — DB FKs cannot enforce this cross-row)
    if (source.space_id !== target.space_id) {
      throw new BadRequestException(
        'Source and target objects must be in the same space',
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        organization_id: organizationId,
        space_id: spaceId,
        source_object_id: sourceObjectId,
        target_object_id: dto.target_object_id,
        attribute_id: dto.attribute_id ?? null,
        relation_type_id: dto.relation_type_id ?? null,
        created_by: userId,
      })
      .select()
      .single();

    if (error) {
      // E5: dual partial unique indexes — catch duplicate reference
      if (error.code === '23505') {
        throw new BadRequestException('This reference already exists');
      }

      throw new BadRequestException(error.message);
    }

    const ref = data as Record<string, unknown>;
    const refId = ref['id'] as string;

    await this.history
      .logChange(
        sourceObjectId,
        source.schema_id,
        organizationId,
        spaceId,
        'reference_added',
        userId,
        {
          metadata: {
            targetObjectId: dto.target_object_id,
            referenceId: refId,
          },
        },
      )
      .catch(() => undefined);

    return ref;
  }

  async delete(
    spaceId: string,
    organizationId: string,
    userId: string,
    objectId: string,
    referenceId: string,
  ): Promise<{ success: true }> {
    // Load the reference to verify ownership and get schema_id for history
    const { data: existing, error: fetchError } = await this.client
      .from(TABLE)
      .select(
        'id,source_object_id,schema_id:asset_objects!asset_object_references_source_object_id_fkey(schema_id)',
      )
      .eq('id', referenceId)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .maybeSingle();

    if (fetchError) throw new BadRequestException(fetchError.message);
    if (!existing) throw new NotFoundException('Reference not found');

    const row = existing as Record<string, unknown>;
    const sourceObjectId = row['source_object_id'] as string;

    // Verify the referenced object is either source or target of this relation
    const { data: refCheck } = await this.client
      .from(TABLE)
      .select('id')
      .eq('id', referenceId)
      .or(`source_object_id.eq.${objectId},target_object_id.eq.${objectId}`)
      .maybeSingle();

    if (!refCheck)
      throw new NotFoundException('Reference not found for this object');

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', referenceId)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId);

    if (error) throw new BadRequestException(error.message);

    // Load schema_id for history
    const { data: objRow } = await this.client
      .from(OBJECTS_TABLE)
      .select('schema_id')
      .eq('id', sourceObjectId)
      .maybeSingle();

    const schemaId = objRow
      ? ((objRow as Record<string, unknown>)['schema_id'] as string)
      : '';

    if (schemaId) {
      await this.history
        .logChange(
          sourceObjectId,
          schemaId,
          organizationId,
          spaceId,
          'reference_removed',
          userId,
          {
            metadata: { referenceId },
          },
        )
        .catch(() => undefined);
    }

    return { success: true };
  }
}
