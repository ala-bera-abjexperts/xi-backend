import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { CreateAssetSchemaDto } from './dto/create-asset-schema.dto';
import type { UpdateAssetSchemaDto } from './dto/update-asset-schema.dto';
import type { AddColumnDto } from './dto/add-column.dto';
import type { ReorderColumnsDto } from './dto/reorder-columns.dto';
import type { RenameColumnDto } from './dto/rename-column.dto';

const TABLE = 'asset_schemas';
const ITEMS_TABLE = 'asset_items';

@Injectable()
export class AssetsSchemasService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getAll(
    spaceId: string,
    organizationId: string,
  ): Promise<{ data: Record<string, unknown>[]; count: number }> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    return { data: rows, count: rows.length };
  }

  async getById(
    schemaId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('id', schemaId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Schema not found');
    return data as Record<string, unknown>;
  }

  async getByKey(
    key: string,
    spaceId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('key', key)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Schema not found');
    return data as Record<string, unknown>;
  }

  async create(
    spaceId: string,
    organizationId: string,
    userId: string,
    dto: CreateAssetSchemaDto,
  ): Promise<Record<string, unknown>> {
    // Check key uniqueness per space across all rows (DB UNIQUE covers all, not just active)
    const { data: existing } = await this.client
      .from(TABLE)
      .select('id')
      .eq('space_id', spaceId)
      .eq('key', dto.key)
      .maybeSingle();

    if (existing)
      throw new BadRequestException(
        `Schema key "${dto.key}" already exists in this space`,
      );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        organization_id: organizationId,
        space_id: spaceId,
        name: dto.name,
        key: dto.key,
        description: dto.description ?? null,
        icon: dto.icon ?? null,
        fields_definition: dto.fields_definition ?? [],
        column_config: dto.column_config ?? [],
        settings: dto.settings ?? {},
        permissions: dto.permissions ?? {},
        field_group_ids: dto.field_group_ids ?? [],
        status: 'active',
        is_active: true,
        version: 1,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to create schema',
      );
    return data as Record<string, unknown>;
  }

  async update(
    schemaId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
    dto: UpdateAssetSchemaDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.getById(schemaId, spaceId, organizationId);

    const patch: Record<string, unknown> = {
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };

    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.description !== undefined) patch['description'] = dto.description;
    if (dto.icon !== undefined) patch['icon'] = dto.icon;
    if (dto.column_config !== undefined)
      patch['column_config'] = dto.column_config;
    if (dto.settings !== undefined) patch['settings'] = dto.settings;
    if (dto.permissions !== undefined) patch['permissions'] = dto.permissions;
    if (dto.field_group_ids !== undefined)
      patch['field_group_ids'] = dto.field_group_ids;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', schemaId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to update schema',
      );
    return { data: data as Record<string, unknown>, success: true };
  }

  async softDelete(
    schemaId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    await this.getById(schemaId, spaceId, organizationId);

    const { error } = await this.client
      .from(TABLE)
      .update({
        is_active: false,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', schemaId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
    return { success: true, message: 'Schema deleted' };
  }

  async exportCsv(
    schemaId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<string> {
    const schema = await this.getById(schemaId, spaceId, organizationId);
    const columnConfig =
      (schema['column_config'] as Record<string, unknown>[] | undefined) ?? [];

    const { data, error } = await this.client
      .from(ITEMS_TABLE)
      .select('*')
      .eq('schema_id', schemaId)
      .eq('organization_id', organizationId)
      .eq('is_archived', false)
      .order('row_order', { ascending: true })
      .limit(10000);

    if (error) throw new BadRequestException(error.message);
    const items = (data ?? []) as Record<string, unknown>[];

    const sortedCols = [...columnConfig].sort(
      (a, b) => ((a['order'] as number) ?? 0) - ((b['order'] as number) ?? 0),
    );
    const headers = ['Title', ...sortedCols.map((c) => c['label'] as string)];

    const csvRows = [
      headers.map((h) => `"${h.replace(/"/g, '""')}"`).join(','),
      ...items.map((item) => {
        const fieldsData =
          (item['fields_data'] as Record<string, unknown>) ?? {};
        const cells = sortedCols.map((col) => {
          const raw = fieldsData[col['columnId'] as string];
          const str = (
            raw == null
              ? ''
              : typeof raw === 'object'
                ? JSON.stringify(raw)
                : String(raw as string | number | boolean)
          ).replace(/"/g, '""');
          return `"${str}"`;
        });
        return [
          `"${((item['title'] as string | null | undefined) ?? '').replace(/"/g, '""')}"`,
          ...cells,
        ].join(',');
      }),
    ];

    return csvRows.join('\n');
  }

  // ── Column Operations ──────────────────────────────────────────────────────

  async addColumn(
    schemaId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
    dto: AddColumnDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const schema = await this.getById(schemaId, spaceId, organizationId);
    const existing =
      (schema['column_config'] as Record<string, unknown>[]) ?? [];

    if (existing.some((c) => c['columnId'] === dto.column.columnId)) {
      throw new BadRequestException(
        `Column ID "${dto.column.columnId}" already exists`,
      );
    }

    const newCol = {
      ...dto.column,
      order: dto.column.order ?? existing.length,
      width: dto.column.width ?? 150,
      cellType: dto.column.cellType ?? 'text',
      required: dto.column.required ?? false,
      resizable: dto.column.resizable ?? true,
      reorderable: dto.column.reorderable ?? true,
    };

    const updatedConfig = [...existing, newCol];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({
        column_config: updatedConfig,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', schemaId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(error?.message ?? 'Failed to add column');
    return { data: data as Record<string, unknown>, success: true };
  }

  async reorderColumns(
    schemaId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
    dto: ReorderColumnsDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const schema = await this.getById(schemaId, spaceId, organizationId);
    const existing =
      (schema['column_config'] as Record<string, unknown>[]) ?? [];

    const orderMap = new Map(
      dto.column_order.map((o) => [o.columnId, o.order]),
    );
    const updatedConfig = existing.map((col) => ({
      ...col,
      order: orderMap.has(col['columnId'] as string)
        ? orderMap.get(col['columnId'] as string)
        : col['order'],
    }));

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({
        column_config: updatedConfig,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', schemaId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to reorder columns',
      );
    return { data: data as Record<string, unknown>, success: true };
  }

  async renameColumn(
    schemaId: string,
    columnId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
    dto: RenameColumnDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const schema = await this.getById(schemaId, spaceId, organizationId);
    const existing =
      (schema['column_config'] as Record<string, unknown>[]) ?? [];

    if (!existing.some((c) => c['columnId'] === columnId)) {
      throw new NotFoundException('Column not found');
    }

    const updatedConfig = existing.map((col) =>
      col['columnId'] === columnId ? { ...col, label: dto.new_label } : col,
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({
        column_config: updatedConfig,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', schemaId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to rename column',
      );
    return { data: data as Record<string, unknown>, success: true };
  }

  async removeColumn(
    schemaId: string,
    columnId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const schema = await this.getById(schemaId, spaceId, organizationId);
    const existing =
      (schema['column_config'] as Record<string, unknown>[]) ?? [];

    if (!existing.some((c) => c['columnId'] === columnId)) {
      throw new NotFoundException('Column not found');
    }

    const filtered = existing.filter((c) => c['columnId'] !== columnId);
    // Re-index order values
    const reindexed = filtered.map((col, idx) => ({ ...col, order: idx }));

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({
        column_config: reindexed,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', schemaId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to remove column',
      );
    return { data: data as Record<string, unknown>, success: true };
  }
}
