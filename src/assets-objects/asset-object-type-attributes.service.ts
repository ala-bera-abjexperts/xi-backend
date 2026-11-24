import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { CreateAssetObjectTypeAttributeDto } from './dto/create-asset-object-type-attribute.dto';
import type { UpdateAssetObjectTypeAttributeDto } from './dto/update-asset-object-type-attribute.dto';

const TABLE = 'asset_object_type_attributes';

@Injectable()
export class AssetObjectTypeAttributesService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async list(objectTypeId: string, spaceId: string, organizationId: string) {
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('object_type_id', objectTypeId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return data ?? [];
  }

  async create(
    dto: CreateAssetObjectTypeAttributeDto,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    // Verify the object_type_id belongs to this space/org
    const { data: typeRow, error: typeErr } = await this.client
      .from('asset_object_types')
      .select('id, schema_id')
      .eq('id', dto.object_type_id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (typeErr) throw new BadRequestException(typeErr.message);
    if (!typeRow) throw new NotFoundException('Object type not found');

    // Check field_key uniqueness within the object type
    const { data: existing } = await this.client
      .from(TABLE)
      .select('id')
      .eq('object_type_id', dto.object_type_id)
      .eq('field_key', dto.field_key)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (existing) {
      throw new ConflictException(
        `An attribute with field_key "${dto.field_key}" already exists on this object type`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        ...dto,
        schema_id: (typeRow as Record<string, unknown>).schema_id,
        space_id: spaceId,
        organization_id: organizationId,
        created_by: userId,
        updated_by: userId,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException(
          'Attribute field_key already exists on this type',
        );
      }

      throw new BadRequestException(error.message);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return data;
  }

  async update(
    id: string,
    dto: UpdateAssetObjectTypeAttributeDto,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    // Load existing row
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: existing, error: fetchErr } = await this.client
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (fetchErr) throw new BadRequestException(fetchErr.message);
    if (!existing) throw new NotFoundException('Attribute not found');

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { version: _v, ...updatePayload } = dto;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({ ...updatePayload, updated_by: userId })
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .select('*')
      .single();

    if (error) throw new BadRequestException(error.message);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return data;
  }

  async delete(id: string, spaceId: string, organizationId: string) {
    const { data: existing } = await this.client
      .from(TABLE)
      .select('id')
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!existing) throw new NotFoundException('Attribute not found');

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    return { success: true };
  }
}
