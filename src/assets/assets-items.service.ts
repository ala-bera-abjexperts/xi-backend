import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AssetsHistoryService } from './assets-history.service';
import type { CreateAssetItemDto } from './dto/create-asset-item.dto';
import type { UpdateAssetItemDto } from './dto/update-asset-item.dto';
import type {
  BulkUpdateItemsDto,
  BulkItemIdsDto,
} from './dto/bulk-update-items.dto';
import type { ReorderItemsDto } from './dto/reorder-items.dto';
import type { UpdateCustomFieldValuesDto } from './dto/update-custom-fields-values.dto';

const TABLE = 'asset_items';
const ATTACHMENTS_TABLE = 'asset_item_attachments';
const STORAGE_BUCKET = 'list-attachments';

const SORTABLE_COLUMNS = new Set([
  'row_order',
  'title',
  'created_at',
  'updated_at',
  'is_archived',
]);

@Injectable()
export class AssetsItemsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly history: AssetsHistoryService,
    @Optional() private readonly outboxService?: AutomationEventOutboxService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getAll(
    spaceId: string,
    organizationId: string,
    query: {
      schemaId: string;
      page?: number;
      page_size?: number;
      search?: string;
      sort_column?: string;
      sort_direction?: string;
      is_archived?: string;
    },
  ): Promise<{
    data: Record<string, unknown>[];
    total: number;
    page: number;
    page_size: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.page_size ?? 25));
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let q = this.client
      .from(TABLE)
      .select(
        '*, updated_by_user:users!asset_items_updated_by_fkey(id,first_name,last_name,email,avatar_url)',
        { count: 'exact' },
      )
      .eq('schema_id', query.schemaId)
      .eq('organization_id', organizationId);

    if (query.is_archived !== undefined) {
      q = q.eq('is_archived', query.is_archived === 'true');
    } else {
      q = q.eq('is_archived', false);
    }

    if (query.search) {
      const safe = query.search.replace(/[%_]/g, '\\$&');
      q = q.ilike('title', `%${safe}%`);
    }

    const sortCol = SORTABLE_COLUMNS.has(query.sort_column ?? '')
      ? query.sort_column!
      : 'row_order';
    const ascending = (query.sort_direction ?? 'asc') === 'asc';
    q = q.order(sortCol, { ascending });

    const { data, error, count } = await q.range(from, to);
    if (error) throw new BadRequestException(error.message);

    return {
      data: (data ?? []) as Record<string, unknown>[],
      total: count ?? 0,
      page,
      page_size: pageSize,
    };
  }

  async getById(
    itemId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .select(
        '*, updated_by_user:users!asset_items_updated_by_fkey(id,first_name,last_name,email,avatar_url)',
      )
      .eq('id', itemId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Item not found');
    return data as Record<string, unknown>;
  }

  async create(
    spaceId: string,
    organizationId: string,
    userId: string,
    dto: CreateAssetItemDto,
  ): Promise<Record<string, unknown>> {
    const { data: maxRow } = await this.client
      .from(TABLE)
      .select('row_order')
      .eq('schema_id', dto.schema_id)
      .order('row_order', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextOrder = maxRow
      ? ((maxRow as Record<string, unknown>)['row_order'] as number) + 1
      : 1;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        organization_id: organizationId,
        space_id: spaceId,
        schema_id: dto.schema_id,
        title: dto.title,
        description: dto.description ?? null,
        fields_data: dto.fields_data ?? {},
        custom_field_values: dto.custom_field_values ?? {},
        row_order: nextOrder,
        is_archived: dto.is_archived ?? false,
        version: 1,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(error?.message ?? 'Failed to create item');

    const created = data as Record<string, unknown>;
    await this.history
      .logChange(
        created['id'] as string,
        dto.schema_id,
        organizationId,
        'row_create',
        userId,
      )
      .catch(() => undefined);

    void this.outboxService?.write(
      organizationId,
      spaceId,
      'app.asset.created',
      {
        asset: {
          id: created['id'],
          title: created['title'],
          schema_id: created['schema_id'],
          space_id: spaceId,
          organization_id: organizationId,
        },
      },
    );

    return created;
  }

  async update(
    itemId: string,
    organizationId: string,
    userId: string,
    dto: UpdateAssetItemDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const existing = await this.getById(itemId, organizationId);
    console.log(
      'Existing item version:',
      existing['version'],
      'DTO version:',
      dto.version,
    );
    if ((existing['version'] as number) !== dto.version) {
      throw new BadRequestException(
        'This item was modified by another user. Please refresh and try again.',
      );
    }

    const patch: Record<string, unknown> = {
      version: dto.version + 1,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };

    if (dto.title !== undefined) patch['title'] = dto.title;
    if (dto.description !== undefined) patch['description'] = dto.description;
    if (dto.fields_data !== undefined) patch['fields_data'] = dto.fields_data;
    if (dto.custom_field_values !== undefined)
      patch['custom_field_values'] = dto.custom_field_values;
    if (dto.row_order !== undefined) patch['row_order'] = dto.row_order;
    if (dto.is_archived !== undefined) {
      patch['is_archived'] = dto.is_archived;
      if (dto.is_archived) {
        patch['archived_at'] = new Date().toISOString();
        patch['archived_by'] = userId;
      } else {
        patch['archived_at'] = null;
        patch['archived_by'] = null;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', itemId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(error?.message ?? 'Failed to update item');

    const updated = data as Record<string, unknown>;
    const schemaId = existing['schema_id'] as string;

    const auditPromises: Promise<void>[] = [];
    if (dto.title !== undefined && dto.title !== existing['title']) {
      auditPromises.push(
        this.history
          .logChange(itemId, schemaId, organizationId, 'title_update', userId, {
            oldValue: existing['title'],
            newValue: dto.title,
          })
          .catch(() => undefined),
      );
    }
    if (
      dto.is_archived !== undefined &&
      dto.is_archived !== existing['is_archived']
    ) {
      const changeType = dto.is_archived ? 'row_archive' : 'row_restore';
      auditPromises.push(
        this.history
          .logChange(itemId, schemaId, organizationId, changeType, userId)
          .catch(() => undefined),
      );
    }
    if (dto.fields_data) {
      const oldFields =
        (existing['fields_data'] as Record<string, unknown>) ?? {};
      for (const [colId, newVal] of Object.entries(dto.fields_data)) {
        if (oldFields[colId] !== newVal) {
          auditPromises.push(
            this.history
              .logChange(
                itemId,
                schemaId,
                organizationId,
                'cell_update',
                userId,
                {
                  columnId: colId,
                  oldValue: oldFields[colId],
                  newValue: newVal,
                },
              )
              .catch(() => undefined),
          );
        }
      }
    }
    await Promise.all(auditPromises);

    const changedFields = Object.keys(dto).filter((k) => k !== 'version');

    void this.outboxService?.write(
      organizationId,
      existing['space_id'] as string,
      'app.asset.updated',
      {
        asset: {
          id: updated['id'],
          title: updated['title'],
          schema_id: updated['schema_id'],
          space_id: updated['space_id'],
          organization_id: organizationId,
        },
        changedFields,
      },
    );

    return { data: updated, success: true };
  }

  async delete(
    itemId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    const existing = await this.getById(itemId, organizationId);

    // Clean up storage files before deleting item (cascade deletes DB rows but not storage blobs)

    const { data: attachments } = await this.client
      .from(ATTACHMENTS_TABLE)
      .select('file_path')
      .eq('item_id', itemId)
      .eq('organization_id', organizationId);

    if (attachments && (attachments as Record<string, unknown>[]).length > 0) {
      const paths = (attachments as Record<string, unknown>[]).map(
        (a) => a['file_path'] as string,
      );
      await this.client.storage.from(STORAGE_BUCKET).remove(paths);
    }

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', itemId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    await this.history
      .logChange(
        itemId,
        existing['schema_id'] as string,
        organizationId,
        'row_delete',
        userId,
      )
      .catch(() => undefined);

    return { success: true, message: 'Item deleted' };
  }

  async bulkUpdate(
    spaceId: string,
    organizationId: string,
    userId: string,
    dto: BulkUpdateItemsDto,
  ): Promise<{ data: Record<string, unknown>[]; success: true }> {
    const grouped = new Map<string, typeof dto.updates>();
    for (const u of dto.updates) {
      const existing = grouped.get(u.item_id) ?? [];
      existing.push(u);
      grouped.set(u.item_id, existing);
    }

    const results: Record<string, unknown>[] = [];

    for (const [itemId, updates] of grouped.entries()) {
      const item = await this.getById(itemId, organizationId);
      const expectedVersion = updates[0].version;

      // All updates for the same item must agree on the version
      if (updates.some((u) => u.version !== expectedVersion)) {
        throw new BadRequestException(
          `Item ${itemId}: conflicting versions in bulk update`,
        );
      }

      if ((item['version'] as number) !== expectedVersion) {
        throw new BadRequestException(
          `Item ${itemId}: modified by another user. Please refresh and try again.`,
        );
      }

      const currentFields =
        (item['fields_data'] as Record<string, unknown>) ?? {};
      const newFields = { ...currentFields };
      for (const u of updates) {
        newFields[u.column_id] = u.value;
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await this.client
        .from(TABLE)
        .update({
          fields_data: newFields,
          version: expectedVersion + 1,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', itemId)
        .eq('organization_id', organizationId)
        .select()
        .single();

      if (error || !data)
        throw new BadRequestException(
          error?.message ?? `Failed to update item ${itemId}`,
        );
      results.push(data as Record<string, unknown>);

      const schemaId = item['schema_id'] as string;
      for (const u of updates) {
        await this.history
          .logChange(itemId, schemaId, organizationId, 'cell_update', userId, {
            columnId: u.column_id,
            oldValue: currentFields[u.column_id],
            newValue: u.value,
          })
          .catch(() => undefined);
      }
    }

    return { data: results, success: true };
  }

  async bulkDelete(
    organizationId: string,
    userId: string,
    dto: BulkItemIdsDto,
  ): Promise<{ success: true; message: string }> {
    // Fetch items first for schema_id resolution, then delete, then audit
    const itemsForAudit: Array<{ id: string; schema_id: string }> = [];
    for (const itemId of dto.ids) {
      const item = await this.getById(itemId, organizationId).catch(() => null);
      if (item) {
        itemsForAudit.push({
          id: itemId,
          schema_id: item['schema_id'] as string,
        });
      }
    }

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .in('id', dto.ids)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    for (const { id, schema_id } of itemsForAudit) {
      await this.history
        .logChange(id, schema_id, organizationId, 'row_delete', userId)
        .catch(() => undefined);
    }

    return { success: true, message: `${dto.ids.length} items deleted` };
  }

  async bulkArchive(
    organizationId: string,
    userId: string,
    dto: BulkItemIdsDto,
  ): Promise<{ success: true; message: string }> {
    // Fetch items for schema_id before archiving
    const itemsForAudit: Array<{ id: string; schema_id: string }> = [];
    for (const itemId of dto.ids) {
      const item = await this.getById(itemId, organizationId).catch(() => null);
      if (item) {
        itemsForAudit.push({
          id: itemId,
          schema_id: item['schema_id'] as string,
        });
      }
    }

    const { error } = await this.client
      .from(TABLE)
      .update({
        is_archived: true,
        archived_at: new Date().toISOString(),
        archived_by: userId,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .in('id', dto.ids)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    for (const { id, schema_id } of itemsForAudit) {
      await this.history
        .logChange(id, schema_id, organizationId, 'row_archive', userId)
        .catch(() => undefined);
    }

    return { success: true, message: `${dto.ids.length} items archived` };
  }

  async reorder(
    organizationId: string,
    userId: string,
    dto: ReorderItemsDto,
  ): Promise<{ success: true }> {
    for (const o of dto.orders) {
      const { error } = await this.client
        .from(TABLE)
        .update({
          row_order: o.row_order,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', o.item_id)
        .eq('organization_id', organizationId);

      if (error) throw new BadRequestException(error.message);
    }
    return { success: true };
  }

  async getHistory(
    itemId: string,
    organizationId: string,
    page = 1,
    pageSize = 50,
  ): Promise<{
    data: Record<string, unknown>[];
    total: number;
    page: number;
    page_size: number;
  }> {
    const clampedPage = Math.max(1, page);
    const clampedSize = Math.min(100, Math.max(1, pageSize));
    const from = (clampedPage - 1) * clampedSize;
    const to = from + clampedSize - 1;

    const { data, error, count } = await this.client
      .from('asset_item_changes')
      .select(
        '*, changed_by_user:users!asset_item_changes_changed_by_fkey(id,first_name,last_name,email,avatar_url)',
        { count: 'exact' },
      )
      .eq('item_id', itemId)
      .eq('organization_id', organizationId)
      .order('changed_at', { ascending: false })
      .range(from, to);

    if (error) throw new BadRequestException(error.message);
    return {
      data: (data ?? []) as Record<string, unknown>[],
      total: count ?? 0,
      page: clampedPage,
      page_size: clampedSize,
    };
  }

  async getCustomFieldValues(
    itemId: string,
    organizationId: string,
  ): Promise<{
    data: Record<string, unknown>;
    version: number;
    success: true;
  }> {
    const item = await this.getById(itemId, organizationId);
    return {
      data: (item['custom_field_values'] as Record<string, unknown>) ?? {},
      version: item['version'] as number,
      success: true,
    };
  }

  async updateCustomFieldValues(
    itemId: string,
    organizationId: string,
    userId: string,
    dto: UpdateCustomFieldValuesDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const existing = await this.getById(itemId, organizationId);

    if ((existing['version'] as number) !== dto.version) {
      throw new BadRequestException(
        'This item was modified by another user. Please refresh and try again.',
      );
    }

    const oldValues =
      (existing['custom_field_values'] as Record<string, unknown>) ?? {};

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({
        custom_field_values: dto.customFieldValues,
        version: dto.version + 1,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', itemId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to update custom fields',
      );

    const schemaId = existing['schema_id'] as string;
    for (const [fieldId, newVal] of Object.entries(dto.customFieldValues)) {
      if (oldValues[fieldId] !== newVal) {
        await this.history
          .logChange(itemId, schemaId, organizationId, 'cell_update', userId, {
            columnId: fieldId,
            oldValue: oldValues[fieldId],
            newValue: newVal,
          })
          .catch(() => undefined);
      }
    }

    return { data: data as Record<string, unknown>, success: true };
  }
}
