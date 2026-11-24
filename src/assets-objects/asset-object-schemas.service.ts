import { storageSafeFileName } from '../common/upload-filename';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { formatMaxUpload, UPLOAD_LIMITS } from '../common/upload-limits';
import { assertImageMime } from '../common/upload-mime';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { AssetSort } from './asset-sort.util';
import type { CreateAssetObjectSchemaDto } from './dto/create-asset-object-schema.dto';
import type { UpdateAssetObjectSchemaDto } from './dto/update-asset-object-schema.dto';

const TABLE = 'asset_object_schemas';
const TYPES_TABLE = 'asset_object_types';
const KEY_SEQ_TABLE = 'asset_object_key_sequences';
const IMAGES_BUCKET = 'asset-object-images';
/** Object images accept any `image/*` type, SVG included — this endpoint has always allowed SVG. */
const IMAGE_MIME_OPTS = { allowSvg: true } as const;

const MAX_IMAGE_SIZE_BYTES = UPLOAD_LIMITS.SMALL_IMAGE;

@Injectable()
export class AssetObjectSchemasService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async list(
    spaceId: string,
    organizationId: string,
    sort?: AssetSort | null,
  ): Promise<Record<string, unknown>[]> {
    let query = this.client
      .from(TABLE)
      .select('*')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    // Name-ascending stays the fallback so every other schema picker keeps its alphabetical order;
    // only an explicit sortField (including sort_order) overrides it.
    query = sort
      ? query
          .order(sort.field, { ascending: sort.ascending })
          .order('name', { ascending: true })
      : query.order('name', { ascending: true });

    const { data, error } = await query;

    if (error) throw new BadRequestException(error.message);

    return (data ?? []) as Record<string, unknown>[];
  }

  /**
   * Applies a client-supplied order. The client sends every id it is displaying, so there is no
   * index to translate and the archived rows it filtered out keep their positions.
   */
  async reorder(
    spaceId: string,
    organizationId: string,
    items: Array<{ id: string; sort_order: number }>,
  ): Promise<{ success: true }> {
    if (items.length === 0) return { success: true };

    // Archived schemas are not shown on the reorderable tab, so a request naming one is forged.
    const { data, error } = await this.client
      .from(TABLE)
      .select('id, sort_order')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_archived', false);

    if (error) throw new BadRequestException(error.message);

    const current = new Map(
      (data ?? []).map((row) => {
        const r = row as { id: string; sort_order: number };

        return [r.id, r.sort_order] as const;
      }),
    );

    const foreign = items.find((i) => !current.has(i.id));

    if (foreign) {
      throw new BadRequestException(
        `Schema ${foreign.id} does not belong to this space`,
      );
    }

    // Only rows that actually move are written: every UPDATE fires trg_aos_updated_at, so
    // rewriting untouched rows would scramble "sort by recently updated".
    const changed = items.filter((i) => current.get(i.id) !== i.sort_order);

    await Promise.all(
      changed.map((i) =>
        this.client
          .from(TABLE)
          .update({ sort_order: i.sort_order })
          .eq('id', i.id)
          .eq('space_id', spaceId)
          .eq('organization_id', organizationId),
      ),
    );

    return { success: true };
  }

  async getOne(
    id: string,
    spaceId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Asset schema not found');

    return data as Record<string, unknown>;
  }

  async create(
    dto: CreateAssetObjectSchemaDto,
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        organization_id: organizationId,
        space_id: spaceId,
        name: dto.name,
        object_key: dto.object_key,
        description: dto.description ?? null,
        icon: dto.icon ?? null,
        color: dto.color ?? null,
        permissions: dto.permissions ?? {},
        settings: dto.settings ?? {},
        is_archived: dto.is_archived ?? false,
        version: 1,
        created_by: userId,
        updated_by: userId,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException(
          `A schema with key "${dto.object_key}" already exists in this space`,
        );
      }

      throw new BadRequestException(error.message);
    }

    // Provision the per-schema key-sequence counter row
    await this.client.from(KEY_SEQ_TABLE).insert({
      schema_id: (data as Record<string, unknown>).id,
      organization_id: organizationId,
      space_id: spaceId,
      last_number: 0,
    });

    return data as Record<string, unknown>;
  }

  async update(
    id: string,
    dto: UpdateAssetObjectSchemaDto,
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const patch: Record<string, unknown> = {
      updated_by: userId,
      version: dto.version + 1,
    };

    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.icon !== undefined) patch.icon = dto.icon;
    if (dto.color !== undefined) patch.color = dto.color;
    if (dto.permissions !== undefined) patch.permissions = dto.permissions;
    if (dto.settings !== undefined) patch.settings = dto.settings;
    if (dto.is_archived !== undefined) patch.is_archived = dto.is_archived;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('version', dto.version)
      .select('*')
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) {
      // Either stale version or not found — check which
      const exists = await this.client
        .from(TABLE)
        .select('id')
        .eq('id', id)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (!exists.data) throw new NotFoundException('Asset schema not found');

      throw new ConflictException('Stale version — refresh and retry');
    }

    return data as Record<string, unknown>;
  }

  async archive(
    id: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true }> {
    const { error } = await this.client
      .from(TABLE)
      .update({ is_archived: true, updated_by: userId })
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    return { success: true };
  }

  async uploadImage(
    schemaId: string,
    spaceId: string,
    organizationId: string,
    file: Express.Multer.File,
  ): Promise<Record<string, unknown>> {
    const row = await this.getOne(schemaId, spaceId, organizationId);

    if (!file) throw new BadRequestException('File is required');

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      throw new BadRequestException(
        `Image exceeds maximum size of ${formatMaxUpload(MAX_IMAGE_SIZE_BYTES)}`,
      );
    }

    assertImageMime(file.mimetype, IMAGE_MIME_OPTS);

    const sanitizedName = storageSafeFileName(file.originalname);
    const filePath = `schemas/${organizationId}/${schemaId}/${Date.now()}-${sanitizedName}`;

    const oldImagePath = row['image_path'] as string | null;

    if (oldImagePath) {
      await this.client.storage.from(IMAGES_BUCKET).remove([oldImagePath]);
    }

    const { error: uploadError } = await this.client.storage
      .from(IMAGES_BUCKET)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError)
      throw new BadRequestException(`Upload failed: ${uploadError.message}`);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({ image_path: filePath })
      .eq('id', schemaId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .select('*')
      .single();

    if (error || !data) {
      await this.client.storage.from(IMAGES_BUCKET).remove([filePath]);
      throw new BadRequestException(
        error?.message ?? 'Failed to update schema image',
      );
    }

    return data as Record<string, unknown>;
  }

  async deleteImage(
    schemaId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const row = await this.getOne(schemaId, spaceId, organizationId);
    const imagePath = row['image_path'] as string | null;

    if (imagePath) {
      await this.client.storage.from(IMAGES_BUCKET).remove([imagePath]);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({ image_path: null })
      .eq('id', schemaId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .select('*')
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to remove schema image',
      );

    return data as Record<string, unknown>;
  }

  async delete(
    id: string,
    spaceId: string,
    organizationId: string,
  ): Promise<{ success: true }> {
    // Pre-check: reject if child types exist (cascades are disabled intentionally
    // so we surface a clear error instead of silently removing the tree)
    const { count, error: countError } = await this.client
      .from(TYPES_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('schema_id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (countError) throw new BadRequestException(countError.message);

    const childTypeCount = count ?? 0;

    if (childTypeCount > 0) {
      throw new ConflictException({
        message: `Cannot delete schema — it has ${childTypeCount} object type(s). Delete all types first.`,
        childTypeCount,
        // objectCount: 0 — asset_objects table added
      });
    }

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
