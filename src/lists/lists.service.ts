/**
 * @fileoverview Service for asset schemas + items — mirrors asset.service.ts from the
 * risk-management-app frontend. Uses asset_schemas / asset_items / asset_item_changes.
 * @module src/lists/lists.service
 */

import { storageSafeFileName } from '../common/upload-filename';
import { UPLOAD_LIMITS } from '../common/upload-limits';
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import * as XLSX from 'xlsx';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { CreateListSchemaDto } from './dto/create-list-schema.dto';
import type { UpdateListSchemaDto } from './dto/update-list-schema.dto';
import type { CreateListItemDto } from './dto/create-list-item.dto';
import type { UpdateListItemDto } from './dto/update-list-item.dto';
import type { ReorderListItemsDto } from './dto/reorder-list-items.dto';
import type { AssignCustomFieldDto } from '../assets/dto/assign-custom-field.dto';
import type { UpdateCustomFieldAssignmentDto } from '../assets/dto/update-custom-field-assignment.dto';
import type { ReorderCustomFieldsDto } from '../assets/dto/reorder-custom-fields.dto';
import type { SyncCustomFieldsDto } from '../assets/dto/sync-custom-fields.dto';

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface IListColumnConfig {
  columnId: string;
  label: string;
  width?: number;
  cellType?: string;
  order: number;
  required?: boolean;
  resizable?: boolean;
  reorderable?: boolean;
  dropdownOptions?: unknown[];
  validation?: {
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  };
}

export interface ListSchema {
  id: string;
  organization_id: string;
  space_id: string;
  name: string;
  key: string | null;
  description: string | null;
  icon: string | null;
  fields_definition: Record<string, unknown>[];
  column_config: IListColumnConfig[];
  settings: Record<string, unknown>;
  permissions: Record<string, unknown>;
  field_group_ids: string[];
  status: string;
  version: number;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListItem {
  id: string;
  organization_id: string;
  space_id: string;
  schema_id: string;
  title: string;
  description: string | null;
  fields_data: Record<string, unknown>;
  custom_field_values: Record<string, unknown>;
  row_order: number;
  is_archived: boolean;
  archived_at: string | null;
  archived_by: string | null;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListItemChange {
  id: string;
  item_id: string;
  schema_id: string;
  organization_id: string;
  change_type: string;
  column_id: string | null;
  old_value: unknown;
  new_value: unknown;
  metadata: Record<string, unknown> | null;
  changed_by: string;
  changed_at: string;
}

export interface ItemFilters {
  page?: number;
  page_size?: number;
  search?: string;
  sort_column?: string;
  sort_direction?: 'asc' | 'desc';
  is_archived?: boolean | string;
  column_filters?: Record<string, string>;
}

export interface ListImportError {
  row: number;
  field?: string;
  message: string;
}

export interface ListImportResult {
  created: number;
  skipped: number;
  failed: number;
  errors: ListImportError[];
  items: ListItem[];
}

export interface ListSchemaImportResult {
  schema: ListSchema;
  importResult: ListImportResult;
}

interface ParsedSpreadsheetRow {
  rowNumber: number;
  values: unknown[];
}

interface ParsedSpreadsheet {
  headers: string[];
  rows: ParsedSpreadsheetRow[];
  fileBaseName: string;
}

interface PreparedImportItem {
  title: string;
  description?: string | null;
  fields_data: Record<string, unknown>;
}

interface PreparedImport {
  items: PreparedImportItem[];
  skipped: number;
  errors: ListImportError[];
}

interface ImportColumnMapping {
  header: string;
  index: number;
  column: IListColumnConfig;
}

export interface ListImportSuggestedMapping {
  csvHeader: string;
  suggestedColumnId: string | null;
  suggestedColumnLabel: string | null;
}

export interface ListImportPreview {
  headers: string[];
  sampleRows: string[][];
  suggestedMappings: ListImportSuggestedMapping[];
  totalRows: number;
  fileType: 'csv' | 'xls' | 'xlsx';
}

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ListsService {
  private static readonly IMPORT_MAX_FILE_BYTES = UPLOAD_LIMITS.IMPORT;
  private static readonly IMPORT_MAX_ROWS = 1000;
  private static readonly IMPORT_MAX_COLUMNS = 100;
  private static readonly IMPORT_TITLE_MAX_LENGTH = 500;
  private static readonly IMPORT_SUPPORTED_EXTENSIONS = new Set([
    '.csv',
    '.xls',
    '.xlsx',
  ]);
  private static readonly IMPORT_SUPPORTED_MIME_TYPES = new Set([
    'text/csv',
    'application/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]);
  private static readonly IMPORT_TITLE_HEADERS = new Set([
    'title',
    'name',
    'item',
  ]);
  private static readonly IMPORT_DESCRIPTION_HEADERS = new Set([
    'description',
    'desc',
  ]);

  private static readonly SCHEMAS_TABLE = 'asset_schemas';
  private static readonly ITEMS_TABLE = 'asset_items';
  private static readonly CHANGES_TABLE = 'asset_item_changes';
  private static readonly CUSTOM_FIELDS_TABLE = 'asset_schema_custom_fields';
  private static readonly COMMENTS_TABLE = 'asset_item_comments';
  private static readonly ATTACHMENTS_TABLE = 'asset_item_attachments';
  private static readonly ATTACHMENTS_BUCKET = 'list-attachments';
  private static readonly LINKS_TABLE = 'asset_item_links';
  private static readonly RELATIONS_TABLE = 'asset_item_relations';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly outboxService?: AutomationEventOutboxService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  // ── Schema CRUD ────────────────────────────────────────────────────────────

  async getSchemas(
    organizationId: string,
    spaceId?: string,
    filters?: { is_archived?: string; search?: string },
  ): Promise<ListSchema[]> {
    let query = this.db
      .from(ListsService.SCHEMAS_TABLE)
      .select('*')
      .eq('organization_id', organizationId);

    if (spaceId) query = query.eq('space_id', spaceId);

    // is_archived='true' means include archived schemas (return all, both active and inactive)
    // is_archived not provided (or 'false') means return only active schemas
    if (filters?.is_archived !== 'true') {
      query = query.eq('is_active', true);
    }

    if (filters?.search) {
      const safe = filters.search.replace(/[,.()"'\\]/g, '');
      if (safe.length > 0) query = query.ilike('name', `%${safe}%`);
    }

    const r = await query.order('name');
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as ListSchema[];
  }

  async getSchemaById(id: string, organizationId: string): Promise<ListSchema> {
    const r = await this.db
      .from(ListsService.SCHEMAS_TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('List schema not found');
    return r.data as ListSchema;
  }

  async getSchemaByKey(
    key: string,
    organizationId: string,
  ): Promise<ListSchema> {
    const r = await this.db
      .from(ListsService.SCHEMAS_TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('key', key)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('List schema not found');
    return r.data as ListSchema;
  }

  async createSchema(
    organizationId: string,
    userId: string,
    dto: CreateListSchemaDto,
  ): Promise<ListSchema> {
    const dtoRec = dto as unknown as Record<string, unknown>;
    const fieldsDefinition =
      (dtoRec['fields_definition'] as Record<string, unknown>[]) ?? [];
    let columnConfig: IListColumnConfig[] =
      (dtoRec['column_config'] as IListColumnConfig[]) ?? [];

    // Auto-generate column_config from fields_definition when not provided
    if (columnConfig.length === 0 && fieldsDefinition.length > 0) {
      columnConfig = fieldsDefinition.map(
        (field: Record<string, unknown>, index: number) => ({
          columnId: field['key'] as string,
          label: field['label'] as string,
          width: 150,
          cellType: this.mapFieldTypeToCell(field['type'] as string),
          order: index,
          required: (field['required'] as boolean) || false,
          resizable: true,
          reorderable: true,
          dropdownOptions: field['options'] as unknown[],
        }),
      );
    }

    if (columnConfig.length > 0) {
      this.validateColumnConfig(columnConfig);
    }

    const row: Record<string, unknown> = {
      organization_id: organizationId,
      space_id: dto.space_id,
      name: dto.name,
      description: dto.description ?? null,
      key:
        dto.key ??
        (dto.name
          .replace(/[^a-zA-Z0-9]/g, '')
          .toUpperCase()
          .substring(0, 20) ||
          `LIST${Date.now().toString().slice(-6)}`),
      icon: dto.icon ?? null,
      fields_definition: fieldsDefinition,
      column_config: columnConfig,
      settings: dtoRec['settings'] ?? {},
      permissions: dtoRec['permissions'] ?? { viewers: [], editors: [] },
      field_group_ids: dtoRec['field_group_ids'] ?? [],
      status: dtoRec['status'] ?? 'active',
      version: dtoRec['version'] ?? 1,
      is_active: true,
      created_by: userId,
      updated_by: userId,
    };

    const r = await this.db
      .from(ListsService.SCHEMAS_TABLE)
      .insert(row)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    return r.data as ListSchema;
  }

  async updateSchema(
    id: string,
    organizationId: string,
    userId: string,
    dto: UpdateListSchemaDto,
  ): Promise<ListSchema> {
    await this.getSchemaById(id, organizationId);

    const patch: Record<string, unknown> = {
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };

    const dtoRec = dto as Record<string, unknown>;
    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.description !== undefined) patch['description'] = dto.description;
    if (dtoRec['key'] !== undefined) patch['key'] = dtoRec['key'];
    if (dtoRec['icon'] !== undefined) patch['icon'] = dtoRec['icon'];
    if (dtoRec['fields_definition'] !== undefined)
      patch['fields_definition'] = dtoRec['fields_definition'];
    if (dtoRec['column_config'] !== undefined) {
      this.validateColumnConfig(dtoRec['column_config'] as IListColumnConfig[]);
      patch['column_config'] = dtoRec['column_config'];
    }
    if (dto.settings !== undefined) patch['settings'] = dto.settings;
    if (dtoRec['permissions'] !== undefined)
      patch['permissions'] = dtoRec['permissions'];
    if (dtoRec['field_group_ids'] !== undefined)
      patch['field_group_ids'] = dtoRec['field_group_ids'];
    if (dtoRec['status'] !== undefined) patch['status'] = dtoRec['status'];
    if (dtoRec['version'] !== undefined) patch['version'] = dtoRec['version'];
    if (dtoRec['is_active'] !== undefined)
      patch['is_active'] = dtoRec['is_active'];

    const r = await this.db
      .from(ListsService.SCHEMAS_TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    return r.data as ListSchema;
  }

  // Soft delete — sets is_active=false (matches frontend asset.service)
  async deleteSchema(id: string, organizationId: string): Promise<void> {
    await this.getSchemaById(id, organizationId);
    const r = await this.db
      .from(ListsService.SCHEMAS_TABLE)
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);
  }

  async restoreSchema(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<ListSchema> {
    await this.getSchemaById(id, organizationId);
    const r = await this.db
      .from(ListsService.SCHEMAS_TABLE)
      .update({
        is_active: true,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    return r.data as ListSchema;
  }

  async permanentDeleteSchema(
    id: string,
    organizationId: string,
  ): Promise<void> {
    await this.getSchemaById(id, organizationId);

    const r1 = await this.db
      .from(ListsService.ITEMS_TABLE)
      .delete()
      .eq('schema_id', id)
      .eq('organization_id', organizationId);
    if (r1.error) throw new BadRequestException(r1.error.message);

    const r2 = await this.db
      .from(ListsService.SCHEMAS_TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);
    if (r2.error) throw new BadRequestException(r2.error.message);
  }

  // ── Column Operations ──────────────────────────────────────────────────────

  async addColumn(
    schemaId: string,
    organizationId: string,
    userId: string,
    column: IListColumnConfig,
  ): Promise<ListSchema> {
    const schema = await this.getSchemaById(schemaId, organizationId);
    const columns: IListColumnConfig[] = [...(schema.column_config ?? [])];

    if (columns.some((c) => c.columnId === column.columnId)) {
      throw new ConflictException(
        `Column with ID '${column.columnId}' already exists`,
      );
    }

    column.order = columns.length;
    columns.push(column);

    const r = await this.db
      .from(ListsService.SCHEMAS_TABLE)
      .update({
        column_config: columns,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', schemaId)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    return r.data as ListSchema;
  }

  async removeColumn(
    schemaId: string,
    organizationId: string,
    columnId: string,
    userId: string,
  ): Promise<ListSchema> {
    const schema = await this.getSchemaById(schemaId, organizationId);
    const columns: IListColumnConfig[] = (schema.column_config ?? [])
      .filter((c) => c.columnId !== columnId)
      .map((c, i) => ({ ...c, order: i }));

    const r = await this.db
      .from(ListsService.SCHEMAS_TABLE)
      .update({
        column_config: columns,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', schemaId)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    return r.data as ListSchema;
  }

  async renameColumn(
    schemaId: string,
    organizationId: string,
    columnId: string,
    newLabel: string,
    userId: string,
  ): Promise<ListSchema> {
    const schema = await this.getSchemaById(schemaId, organizationId);
    const columns: IListColumnConfig[] = (schema.column_config ?? []).map(
      (c) => (c.columnId === columnId ? { ...c, label: newLabel } : c),
    );

    const r = await this.db
      .from(ListsService.SCHEMAS_TABLE)
      .update({
        column_config: columns,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', schemaId)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    return r.data as ListSchema;
  }

  async reorderColumns(
    schemaId: string,
    organizationId: string,
    newOrder: { columnId: string; order: number }[],
    userId: string,
  ): Promise<ListSchema> {
    const schema = await this.getSchemaById(schemaId, organizationId);
    const orderMap = new Map(newOrder.map((o) => [o.columnId, o.order]));
    const columns: IListColumnConfig[] = (schema.column_config ?? [])
      .map((c) => ({ ...c, order: orderMap.get(c.columnId) ?? c.order }))
      .sort((a, b) => a.order - b.order);

    const r = await this.db
      .from(ListsService.SCHEMAS_TABLE)
      .update({
        column_config: columns,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', schemaId)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    return r.data as ListSchema;
  }

  // ── Item CRUD ──────────────────────────────────────────────────────────────

  async getItems(
    organizationId: string,
    schemaId: string,
    filters: ItemFilters,
  ): Promise<{
    data: ListItem[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    await this.getSchemaById(schemaId, organizationId);

    const page = filters.page ?? 1;
    const pageSize = filters.page_size ?? 25;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = this.db
      .from(ListsService.ITEMS_TABLE)
      .select(
        '*, updated_by_user:users!asset_items_updated_by_fkey(id, first_name, last_name, email, avatar_url)',
        {
          count: 'exact',
        },
      )
      .eq('schema_id', schemaId)
      .eq('organization_id', organizationId);

    if (filters.is_archived !== undefined) {
      query = query.eq(
        'is_archived',
        filters.is_archived === 'true' || filters.is_archived === true,
      );
    } else {
      query = query.eq('is_archived', false);
    }

    if (filters.search) {
      const safe = filters.search.replace(/[,.()"'\\]/g, '');
      if (safe.length > 0) {
        query = query.ilike('title', `%${safe}%`);
      }
    }

    if (filters.column_filters) {
      Object.entries(filters.column_filters).forEach(([columnId, value]) => {
        if (value === undefined || value === null || value === '') return;

        // SECURITY (H10): both key and value are interpolated into a PostgREST
        // .or() filter string. Allowlist the column key to a plain identifier to
        // block filter/column injection, and double-quote + escape the value so
        // it cannot break out of the filter grammar (e.g. `,or(...)`).
        if (!/^[A-Za-z0-9_]+$/.test(columnId)) return;

        const safeVal =
          '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

        query = query.or(
          `fields_data->>${columnId}.eq.${safeVal},custom_field_values->>${columnId}.eq.${safeVal}`,
        );
      });
    }

    const sortCol = filters.sort_column ?? 'row_order';
    const ascending = (filters.sort_direction ?? 'asc') === 'asc';

    if (['row_order', 'created_at', 'title'].includes(sortCol)) {
      query = query.order(sortCol, { ascending });
    } else {
      query = query.order('row_order', { ascending: true });
    }

    const r = await query.range(from, to);
    if (r.error) throw new BadRequestException(r.error.message);
    return {
      data: (r.data ?? []) as ListItem[],
      total: r.count ?? 0,
      page,
      pageSize,
    };
  }

  async getItemById(id: string, organizationId: string): Promise<ListItem> {
    const r = await this.db
      .from(ListsService.ITEMS_TABLE)
      .select(
        '*, updated_by_user:users!asset_items_updated_by_fkey(id, first_name, last_name, email, avatar_url)',
      )
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('List item not found');
    return r.data as ListItem;
  }

  async createItem(
    organizationId: string,
    userId: string,
    dto: CreateListItemDto,
  ): Promise<ListItem> {
    const schema = await this.getSchemaById(dto.schema_id, organizationId);

    // Build default values from column config
    const defaultFieldsData: Record<string, unknown> = {};
    for (const col of schema.column_config ?? []) {
      if (col.cellType === 'checkbox') defaultFieldsData[col.columnId] = false;
    }

    const fieldsData = {
      ...defaultFieldsData,
      ...(dto.fields_data ?? {}),
    };

    // Validate required fields against column config
    if (schema.column_config?.length) {
      const validation = this.validateFieldsData(
        fieldsData,
        schema.column_config,
      );
      if (!validation.valid) {
        throw new BadRequestException(validation.errors.join('; '));
      }
    }

    // Auto row_order: max existing + 1
    const maxResult = await this.db
      .from(ListsService.ITEMS_TABLE)
      .select('row_order')
      .eq('schema_id', dto.schema_id)
      .order('row_order', { ascending: false })
      .limit(1)
      .maybeSingle();
    const maxRow = maxResult.data as { row_order: number } | null;
    const rowOrder = dto.row_order ?? (maxRow ? maxRow.row_order + 1 : 0);

    const row = {
      organization_id: organizationId,
      space_id:
        dto.space_id ??
        (schema as unknown as Record<string, unknown>)['space_id'],
      schema_id: dto.schema_id,
      title: dto.title ?? '',
      description: dto.description ?? null,
      fields_data: fieldsData,
      custom_field_values: dto.custom_field_values ?? {},
      row_order: rowOrder,
      is_archived: dto.is_archived ?? false,
      version: dto.version ?? 1,
      created_by: userId,
      updated_by: userId,
    };

    const r = await this.db
      .from(ListsService.ITEMS_TABLE)
      .insert(row)
      .select(
        '*, updated_by_user:users!asset_items_updated_by_fkey(id, first_name, last_name, email, avatar_url)',
      )
      .single();
    if (r.error) throw new BadRequestException(r.error.message);

    const createdItem = r.data as ListItem & {
      space_id: string;
      schema_id: string;
      title: string;
    };

    void this.logChange({
      item_id: createdItem.id,
      schema_id: dto.schema_id,
      organization_id: organizationId,
      change_type: 'row_create',
      new_value: fieldsData,
      changed_by: userId,
    });

    void this.outboxService?.write(
      organizationId,
      createdItem.space_id,
      'app.asset.created',
      {
        asset: {
          id: createdItem.id,
          title: createdItem.title,
          schema_id: createdItem.schema_id,
          space_id: createdItem.space_id,
          organization_id: organizationId,
        },
      },
    );

    return createdItem;
  }

  async updateItem(
    id: string,
    organizationId: string,
    userId: string,
    dto: UpdateListItemDto,
  ): Promise<ListItem> {
    // Fetch current for version check
    const fetchR = await this.db
      .from(ListsService.ITEMS_TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (fetchR.error) throw new BadRequestException(fetchR.error.message);
    if (!fetchR.data) throw new NotFoundException('List item not found');
    const current = fetchR.data as ListItem & {
      version: number;
      schema_id: string;
    };

    // Optimistic lock — only enforce when version is provided
    if (dto.version !== undefined && current.version !== dto.version) {
      throw new ConflictException(
        'This item was modified by another user. Please refresh and try again.',
      );
    }

    const updateData: Record<string, unknown> = {
      version: current.version + 1,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };

    if (dto.title !== undefined) updateData['title'] = dto.title;
    if (dto.description !== undefined)
      updateData['description'] = dto.description;
    if (dto.fields_data !== undefined)
      updateData['fields_data'] = dto.fields_data;
    if (dto.custom_field_values !== undefined)
      updateData['custom_field_values'] = dto.custom_field_values;
    if (dto.row_order !== undefined) updateData['row_order'] = dto.row_order;

    if (dto.is_archived !== undefined) {
      updateData['is_archived'] = dto.is_archived;
      if (dto.is_archived) {
        updateData['archived_at'] = new Date().toISOString();
        updateData['archived_by'] = userId;
      } else {
        updateData['archived_at'] = null;
        updateData['archived_by'] = null;
      }
    }

    const r = await this.db
      .from(ListsService.ITEMS_TABLE)
      .update(updateData)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select(
        '*, updated_by_user:users!asset_items_updated_by_fkey(id, first_name, last_name, email, avatar_url)',
      )
      .single();
    if (r.error) throw new BadRequestException(r.error.message);

    // Log field changes
    const newFieldsData = dto.fields_data;
    if (newFieldsData) {
      const oldFields = current.fields_data ?? {};
      const allKeys = new Set([
        ...Object.keys(oldFields),
        ...Object.keys(newFieldsData),
      ]);
      for (const columnId of allKeys) {
        const oldVal = oldFields[columnId];
        const newVal = newFieldsData[columnId];
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          void this.logChange({
            item_id: id,
            schema_id: current.schema_id,
            organization_id: organizationId,
            change_type: 'cell_update',
            column_id: columnId,
            old_value: { [columnId]: oldVal },
            new_value: { [columnId]: newVal },
            changed_by: userId,
          });
        }
      }
    }

    if (dto.title && dto.title !== current.title) {
      void this.logChange({
        item_id: id,
        schema_id: current.schema_id,
        organization_id: organizationId,
        change_type: 'title_update',
        old_value: { title: current.title },
        new_value: { title: dto.title },
        changed_by: userId,
      });
    }

    const updated = r.data as ListItem & {
      space_id: string;
      schema_id: string;
      title: string;
    };

    void this.outboxService?.write(
      organizationId,
      updated.space_id ?? current.space_id,
      'app.asset.updated',
      {
        asset: {
          id: updated.id,
          title: updated.title,
          schema_id: updated.schema_id ?? current.schema_id,
          space_id: updated.space_id ?? current.space_id,
          organization_id: organizationId,
        },
        changedFields: Object.keys(dto).filter((k) => k !== 'version'),
      },
    );

    return r.data as ListItem;
  }

  async deleteItem(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const fetchR = await this.db
      .from(ListsService.ITEMS_TABLE)
      .select('schema_id, fields_data')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (fetchR.error) throw new BadRequestException(fetchR.error.message);
    if (!fetchR.data) throw new NotFoundException('List item not found');
    const current = fetchR.data as { schema_id: string; fields_data: unknown };

    const r = await this.db
      .from(ListsService.ITEMS_TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);

    void this.logChange({
      item_id: id,
      schema_id: current.schema_id,
      organization_id: organizationId,
      change_type: 'row_delete',
      old_value: current.fields_data,
      changed_by: userId,
    });
  }

  async archiveItem(
    id: string,
    organizationId: string,
    userId: string,
    version: number,
  ): Promise<ListItem> {
    const result = await this.updateItem(id, organizationId, userId, {
      is_archived: true,
      version,
    } as any);
    void this.logChange({
      item_id: id,
      schema_id: result.schema_id,
      organization_id: organizationId,
      change_type: 'row_archive',
      changed_by: userId,
    });
    return result;
  }

  async restoreItem(
    id: string,
    organizationId: string,
    userId: string,
    version: number,
  ): Promise<ListItem> {
    const result = await this.updateItem(id, organizationId, userId, {
      is_archived: false,
      version,
    } as any);
    void this.logChange({
      item_id: id,
      schema_id: result.schema_id,
      organization_id: organizationId,
      change_type: 'row_restore',
      changed_by: userId,
    });
    return result;
  }

  // ── Bulk Operations ────────────────────────────────────────────────────────

  async bulkUpdateCells(
    organizationId: string,
    userId: string,
    updates: {
      item_id: string;
      column_id: string;
      value: unknown;
      version: number;
    }[],
  ): Promise<ListItem[]> {
    const results: ListItem[] = [];
    const grouped = new Map<
      string,
      { column_id: string; value: unknown; version: number }[]
    >();

    for (const u of updates) {
      if (!grouped.has(u.item_id)) grouped.set(u.item_id, []);
      grouped.get(u.item_id)!.push(u);
    }

    for (const [itemId, cellUpdates] of grouped) {
      const fetchR = await this.db
        .from(ListsService.ITEMS_TABLE)
        .select('*')
        .eq('id', itemId)
        .eq('organization_id', organizationId)
        .maybeSingle();
      if (fetchR.error || !fetchR.data) continue;
      const current = fetchR.data as ListItem & {
        version: number;
        schema_id: string;
      };

      if (current.version !== cellUpdates[0].version) continue;

      const newFieldsData = {
        ...current.fields_data,
      };
      for (const cu of cellUpdates) newFieldsData[cu.column_id] = cu.value;

      const r = await this.db
        .from(ListsService.ITEMS_TABLE)
        .update({
          fields_data: newFieldsData,
          version: current.version + 1,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', itemId)
        .eq('organization_id', organizationId)
        .select()
        .maybeSingle();
      if (r.error || !r.data) continue;
      results.push(r.data as ListItem);

      for (const cu of cellUpdates) {
        const oldVal = current.fields_data?.[cu.column_id];
        if (JSON.stringify(oldVal) !== JSON.stringify(cu.value)) {
          void this.logChange({
            item_id: itemId,
            schema_id: current.schema_id,
            organization_id: organizationId,
            change_type: 'cell_update',
            column_id: cu.column_id,
            old_value: { [cu.column_id]: oldVal },
            new_value: { [cu.column_id]: cu.value },
            changed_by: userId,
          });
        }
      }
    }

    return results;
  }

  async bulkDeleteItems(
    ids: string[],
    organizationId: string,
    userId: string,
  ): Promise<void> {
    for (const id of ids) {
      await this.deleteItem(id, organizationId, userId);
    }
  }

  async bulkArchiveItems(
    ids: string[],
    organizationId: string,
    userId: string,
  ): Promise<void> {
    for (const id of ids) {
      const r = await this.db
        .from(ListsService.ITEMS_TABLE)
        .select('version')
        .eq('id', id)
        .eq('organization_id', organizationId)
        .maybeSingle();
      if (r.data) {
        await this.archiveItem(
          id,
          organizationId,
          userId,
          (r.data as { version: number }).version,
        );
      }
    }
  }

  async bulkRestoreItems(
    ids: string[],
    organizationId: string,
    userId: string,
  ): Promise<void> {
    for (const id of ids) {
      const r = await this.db
        .from(ListsService.ITEMS_TABLE)
        .select('version')
        .eq('id', id)
        .eq('organization_id', organizationId)
        .maybeSingle();
      if (r.data) {
        await this.restoreItem(
          id,
          organizationId,
          userId,
          (r.data as { version: number }).version,
        );
      }
    }
  }

  async reorderItems(
    organizationId: string,
    dto: ReorderListItemsDto,
  ): Promise<void> {
    await this.getSchemaById(dto.list_id, organizationId);

    if (dto.item_ids.length === 0) return;

    // Was one sequential UPDATE per item — one PostgREST HTTP round trip each, on
    // every drag. Now two requests regardless of list length.
    //
    // The read is load-bearing, not an optimisation: it re-applies the same
    // `schema_id` + `organization_id` scoping the per-row updates had, so an id
    // from another list or another tenant simply doesn't come back and is
    // skipped. Upserting the caller's ids directly would drop that check.
    const existing = await this.db
      .from(ListsService.ITEMS_TABLE)
      .select('*')
      .eq('schema_id', dto.list_id)
      .eq('organization_id', organizationId)
      .in('id', dto.item_ids);

    if (existing.error) throw new BadRequestException(existing.error.message);

    const orderById = new Map(dto.item_ids.map((id, index) => [id, index]));
    const now = new Date().toISOString();

    const rows = (
      (existing.data ?? []) as unknown as Array<Record<string, unknown>>
    ).map((row) => ({
      ...row,
      row_order: orderById.get(row['id'] as string) ?? row['row_order'],
      updated_at: now,
    }));

    if (rows.length === 0) return;

    const upserted = await this.db
      .from(ListsService.ITEMS_TABLE)
      .upsert(rows, { onConflict: 'id' });

    if (upserted.error) throw new BadRequestException(upserted.error.message);
  }

  async reorderRows(
    schemaId: string,
    organizationId: string,
    userId: string,
    orders: { item_id: string; row_order: number }[],
  ): Promise<void> {
    await this.getSchemaById(schemaId, organizationId);
    for (const order of orders) {
      const r = await this.db
        .from(ListsService.ITEMS_TABLE)
        .update({
          row_order: order.row_order,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.item_id)
        .eq('schema_id', schemaId)
        .eq('organization_id', organizationId)
        .select('id')
        .maybeSingle();
      if (r.error) throw new BadRequestException(r.error.message);
      if (r.data) {
        void this.logChange({
          item_id: order.item_id,
          schema_id: schemaId,
          organization_id: organizationId,
          change_type: 'row_reorder',
          new_value: { row_order: order.row_order },
          changed_by: userId,
        });
      }
    }
  }

  // ── History ────────────────────────────────────────────────────────────────

  async getItemHistory(
    itemId: string,
    organizationId: string,
  ): Promise<ListItemChange[]> {
    const r = await this.db
      .from(ListsService.CHANGES_TABLE)
      .select(
        '*, changed_by_user:users!asset_item_changes_changed_by_fkey(id, first_name, last_name, email, avatar_url)',
      )
      .eq('item_id', itemId)
      .eq('organization_id', organizationId)
      .order('changed_at', { ascending: false });
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as ListItemChange[];
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  async exportToCSV(schemaId: string, organizationId: string): Promise<string> {
    const schema = await this.getSchemaById(schemaId, organizationId);
    const { data: items } = await this.getItems(organizationId, schemaId, {
      page: 1,
      page_size: 10000,
      sort_direction: 'asc',
    });

    const columns = [...(schema.column_config ?? [])].sort(
      (a, b) => a.order - b.order,
    );
    const headers = ['Title', ...columns.map((c) => c.label)];
    const csvRows = [
      headers.map((h) => `"${h.replace(/"/g, '""')}"`).join(','),
    ];

    for (const item of items) {
      const row = [
        `"${String(item.title || '').replace(/"/g, '""')}"`,
        ...columns.map((col) => {
          const value = item.fields_data?.[col.columnId] ?? '';
          const cellStr =
            value === null || value === undefined
              ? ''
              : typeof value === 'object'
                ? JSON.stringify(value)
                : String(value as string | number | boolean);
          return `"${cellStr.replace(/"/g, '""')}"`;
        }),
      ];
      csvRows.push(row.join(','));
    }

    return csvRows.join('\n');
  }

  async exportToXlsx(
    schemaId: string,
    organizationId: string,
  ): Promise<Buffer> {
    const schema = await this.getSchemaById(schemaId, organizationId);
    const { data: items } = await this.getItems(organizationId, schemaId, {
      page: 1,
      page_size: 10000,
      sort_direction: 'asc',
    });

    const columns = [...(schema.column_config ?? [])].sort(
      (a, b) => a.order - b.order,
    );
    const headers = ['Title', ...columns.map((c) => c.label)];
    const dataRows = items.map((item) => [
      String(item.title || ''),
      ...columns.map((col) => {
        const value = item.fields_data?.[col.columnId] ?? '';

        if (value === null || value === undefined) return '';
        if (typeof value === 'object') return JSON.stringify(value);

        return String(value as string | number | boolean);
      }),
    ]);

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
    const workbook = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Export');

    return XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }) as Buffer;
  }

  async previewImportFile(
    schemaId: string,
    organizationId: string,
    file: Express.Multer.File,
    options: { spaceId?: string } = {},
  ): Promise<ListImportPreview> {
    const schema = await this.getSchemaById(schemaId, organizationId);

    if (options.spaceId && schema.space_id !== options.spaceId) {
      throw new NotFoundException('List schema not found');
    }

    const parsed = this.parseSpreadsheetFile(file);
    const extension = this.getFileExtension(file.originalname);
    const fileType: 'csv' | 'xls' | 'xlsx' =
      extension === '.xlsx' ? 'xlsx' : extension === '.xls' ? 'xls' : 'csv';

    const columns = schema.column_config ?? [];
    const columnsByKey = new Map<string, IListColumnConfig>();

    for (const column of columns) {
      columnsByKey.set(this.normalizeComparable(column.columnId), column);
      columnsByKey.set(this.normalizeComparable(column.label), column);
    }

    const suggestedMappings: ListImportSuggestedMapping[] = parsed.headers.map(
      (header) => {
        const column = columnsByKey.get(this.normalizeComparable(header));

        return {
          csvHeader: header,
          suggestedColumnId: column?.columnId ?? null,
          suggestedColumnLabel: column?.label ?? null,
        };
      },
    );

    const PREVIEW_ROWS = 5;
    const sampleRows = parsed.rows.slice(0, PREVIEW_ROWS).map((row) =>
      parsed.headers.map((_, i) => {
        const v = row.values[i];

        if (v === null || v === undefined) return '';

        return String(v);
      }),
    );

    return {
      headers: parsed.headers,
      sampleRows,
      suggestedMappings,
      totalRows: parsed.rows.length,
      fileType,
    };
  }

  // ── Import ─────────────────────────────────────────────────────────────────

  async importItemsFromFile(
    organizationId: string,
    userId: string,
    schemaId: string,
    file: Express.Multer.File,
    options: { spaceId?: string } = {},
  ): Promise<ListImportResult> {
    const schema = await this.getSchemaById(schemaId, organizationId);

    if (options.spaceId && schema.space_id !== options.spaceId) {
      throw new NotFoundException('List schema not found');
    }

    if (schema.is_active === false) {
      throw new BadRequestException('Cannot import into an archived list');
    }

    const parsed = this.parseSpreadsheetFile(file);
    const titleIndex = this.findTitleHeaderIndex(parsed.headers);

    if (titleIndex === -1) {
      throw new BadRequestException(
        'Import file must include a Title, Name, or Item column',
      );
    }

    const descriptionIndex = this.findDescriptionHeaderIndex(parsed.headers);
    const columnMappings = this.mapExistingImportColumns(
      parsed.headers,
      schema.column_config ?? [],
      titleIndex,
      descriptionIndex,
    );
    const prepared = this.prepareImportItems(parsed, {
      schema,
      titleIndex,
      descriptionIndex,
      columnMappings,
    });

    return this.createPreparedImportItems(
      organizationId,
      userId,
      schema,
      prepared,
    );
  }

  async importSchemaFromFile(
    organizationId: string,
    userId: string,
    spaceId: string,
    file: Express.Multer.File,
    options: { name?: string } = {},
  ): Promise<ListSchemaImportResult> {
    const parsed = this.parseSpreadsheetFile(file);
    let titleIndex = this.findTitleHeaderIndex(parsed.headers);

    if (titleIndex === -1) titleIndex = 0;

    const descriptionIndex = this.findDescriptionHeaderIndex(parsed.headers);
    const { columnConfig, fieldDefinitions, columnMappings } =
      this.buildGeneratedImportColumns(
        parsed.headers,
        titleIndex,
        descriptionIndex,
      );

    if (columnConfig.length > ListsService.IMPORT_MAX_COLUMNS) {
      throw new BadRequestException(
        `Import file has too many columns. Maximum ${ListsService.IMPORT_MAX_COLUMNS} generated columns are allowed`,
      );
    }

    const provisionalSchema = {
      id: '__import_preview__',
      organization_id: organizationId,
      space_id: spaceId,
      name: this.sanitizeImportedListName(options.name, parsed.fileBaseName),
      key: null,
      description: null,
      icon: 'bx-table',
      fields_definition: fieldDefinitions,
      column_config: columnConfig,
      settings: {},
      permissions: {},
      field_group_ids: [],
      status: 'active',
      version: 1,
      is_active: true,
      created_by: userId,
      updated_by: userId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } satisfies ListSchema;
    const prepared = this.prepareImportItems(parsed, {
      schema: provisionalSchema,
      titleIndex,
      descriptionIndex,
      columnMappings,
    });
    const schema = await this.createSchema(organizationId, userId, {
      space_id: spaceId,
      name: provisionalSchema.name,
      type: 'table',
      icon: provisionalSchema.icon,
      fields_definition: fieldDefinitions,
      column_config:
        columnConfig as unknown as CreateListSchemaDto['column_config'],
      settings: {},
      permissions: { viewers: [], editors: [] },
    });
    const importResult = await this.createPreparedImportItems(
      organizationId,
      userId,
      schema,
      prepared,
    );

    return { schema, importResult };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private parseSpreadsheetFile(file: Express.Multer.File): ParsedSpreadsheet {
    if (!file) {
      throw new BadRequestException('Import file is required');
    }

    if (!file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Import file is empty');
    }

    if (file.size > ListsService.IMPORT_MAX_FILE_BYTES) {
      throw new BadRequestException(
        `Import file exceeds ${ListsService.IMPORT_MAX_FILE_BYTES / 1024 / 1024}MB limit`,
      );
    }

    const extension = this.getFileExtension(file.originalname);
    const mimeType = (file.mimetype || '').toLowerCase();
    const hasSupportedExtension =
      ListsService.IMPORT_SUPPORTED_EXTENSIONS.has(extension);
    const hasSupportedMime =
      ListsService.IMPORT_SUPPORTED_MIME_TYPES.has(mimeType);

    if (!hasSupportedExtension && !hasSupportedMime) {
      throw new BadRequestException(
        'Unsupported import file type. Upload a CSV, XLS, or XLSX file',
      );
    }

    let workbook: XLSX.WorkBook;

    try {
      workbook = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
    } catch {
      throw new BadRequestException('Unable to read import file');
    }

    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
      throw new BadRequestException('Import file does not contain a worksheet');
    }

    const worksheet = workbook.Sheets[firstSheetName];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      blankrows: false,
      defval: '',
      raw: false,
    });
    const nonEmptyRows = matrix
      .map((values, index) => ({ rowNumber: index + 1, values }))
      .filter((row) => !this.isEmptySpreadsheetRow(row.values));

    if (nonEmptyRows.length === 0) {
      throw new BadRequestException('Import file is empty');
    }

    const headerRow = nonEmptyRows[0];
    const headers = this.trimTrailingEmptyCells(headerRow.values).map((value) =>
      this.cleanHeader(value),
    );

    if (headers.length === 0 || headers.some((header) => header.length === 0)) {
      throw new BadRequestException('Import file has an invalid header row');
    }

    if (headers.length > ListsService.IMPORT_MAX_COLUMNS + 2) {
      throw new BadRequestException(
        `Import file has too many columns. Maximum ${ListsService.IMPORT_MAX_COLUMNS} data columns are allowed`,
      );
    }

    const normalizedHeaders = headers.map((header) =>
      this.normalizeComparable(header),
    );

    if (normalizedHeaders.length !== new Set(normalizedHeaders).size) {
      throw new BadRequestException(
        'Import file contains duplicate column headers',
      );
    }

    const rows = nonEmptyRows.slice(1).map((row) => ({
      rowNumber: row.rowNumber,
      values: headers.map((_, index) => row.values[index] ?? ''),
    }));

    if (rows.length === 0) {
      throw new BadRequestException('Import file does not contain data rows');
    }

    if (rows.length > ListsService.IMPORT_MAX_ROWS) {
      throw new BadRequestException(
        `Import file has too many rows. Maximum ${ListsService.IMPORT_MAX_ROWS} rows are allowed`,
      );
    }

    return {
      headers,
      rows,
      fileBaseName: this.getFileBaseName(file.originalname),
    };
  }

  private mapExistingImportColumns(
    headers: string[],
    columns: IListColumnConfig[],
    titleIndex: number,
    descriptionIndex: number,
  ): ImportColumnMapping[] {
    const columnsByKey = new Map<string, IListColumnConfig>();

    for (const column of columns) {
      columnsByKey.set(this.normalizeComparable(column.columnId), column);
      columnsByKey.set(this.normalizeComparable(column.label), column);
    }

    const mappings: ImportColumnMapping[] = [];
    const unknownHeaders: string[] = [];

    headers.forEach((header, index) => {
      if (index === titleIndex || index === descriptionIndex) return;

      const column = columnsByKey.get(this.normalizeComparable(header));

      if (!column) {
        unknownHeaders.push(header);
        return;
      }

      mappings.push({ header, index, column });
    });

    if (unknownHeaders.length > 0) {
      throw new BadRequestException(
        `Import file contains columns that do not exist in this list: ${unknownHeaders.join(', ')}`,
      );
    }

    return mappings;
  }

  private buildGeneratedImportColumns(
    headers: string[],
    titleIndex: number,
    descriptionIndex: number,
  ): {
    columnConfig: IListColumnConfig[];
    fieldDefinitions: Record<string, unknown>[];
    columnMappings: ImportColumnMapping[];
  } {
    const usedColumnIds = new Set<string>();
    const columnConfig: IListColumnConfig[] = [];
    const fieldDefinitions: Record<string, unknown>[] = [];
    const columnMappings: ImportColumnMapping[] = [];

    headers.forEach((header, index) => {
      if (index === titleIndex || index === descriptionIndex) return;

      const columnId = this.buildUniqueColumnId(header, usedColumnIds);
      const column: IListColumnConfig = {
        columnId,
        label: header,
        width: 180,
        cellType: 'text',
        order: columnConfig.length,
        required: false,
        resizable: true,
        reorderable: true,
      };

      columnConfig.push(column);
      fieldDefinitions.push({
        key: columnId,
        label: header,
        type: 'text',
        required: false,
      });
      columnMappings.push({ header, index, column });
    });

    return { columnConfig, fieldDefinitions, columnMappings };
  }

  private prepareImportItems(
    parsed: ParsedSpreadsheet,
    options: {
      schema: ListSchema;
      titleIndex: number;
      descriptionIndex: number;
      columnMappings: ImportColumnMapping[];
    },
  ): PreparedImport {
    const errors: ListImportError[] = [];
    const items: PreparedImportItem[] = [];
    let skipped = 0;

    for (const row of parsed.rows) {
      const title = this.valueToString(row.values[options.titleIndex]).trim();
      const description =
        options.descriptionIndex >= 0
          ? this.valueToString(row.values[options.descriptionIndex]).trim()
          : '';
      const fieldsData: Record<string, unknown> = {};
      let rowHasMappedValue = title.length > 0 || description.length > 0;

      for (const mapping of options.columnMappings) {
        const rawValue = row.values[mapping.index];

        if (!this.isBlankValue(rawValue)) rowHasMappedValue = true;

        const coerced = this.coerceImportValue(
          rawValue,
          mapping.column,
          row.rowNumber,
          mapping.header,
        );

        if (coerced.error) {
          errors.push(coerced.error);
          continue;
        }

        if (coerced.value !== undefined) {
          fieldsData[mapping.column.columnId] = coerced.value;
        }
      }

      if (!rowHasMappedValue) {
        skipped += 1;
        continue;
      }

      if (!title) {
        errors.push({
          row: row.rowNumber,
          field: parsed.headers[options.titleIndex],
          message: 'Title is required',
        });
      }

      if (title.length > ListsService.IMPORT_TITLE_MAX_LENGTH) {
        errors.push({
          row: row.rowNumber,
          field: parsed.headers[options.titleIndex],
          message: `Title must be at most ${ListsService.IMPORT_TITLE_MAX_LENGTH} characters`,
        });
      }

      const validation = this.validateFieldsData(
        fieldsData,
        options.schema.column_config ?? [],
      );

      for (const message of validation.errors) {
        errors.push({ row: row.rowNumber, message });
      }

      items.push({
        title,
        description: description || null,
        fields_data: fieldsData,
      });
    }

    if (items.length === 0 && errors.length === 0) {
      throw new BadRequestException('Import file does not contain data rows');
    }

    if (errors.length > 0) {
      throw new BadRequestException(this.formatImportErrors(errors));
    }

    return { items, skipped, errors };
  }

  private async createPreparedImportItems(
    organizationId: string,
    userId: string,
    schema: ListSchema,
    prepared: PreparedImport,
  ): Promise<ListImportResult> {
    const items: ListItem[] = [];

    for (const item of prepared.items) {
      const created = await this.createItem(organizationId, userId, {
        schema_id: schema.id,
        space_id: schema.space_id,
        title: item.title,
        description: item.description ?? undefined,
        fields_data: item.fields_data,
      });

      items.push(created);
    }

    return {
      created: items.length,
      skipped: prepared.skipped,
      failed: 0,
      errors: [],
      items,
    };
  }

  private coerceImportValue(
    rawValue: unknown,
    column: IListColumnConfig,
    rowNumber: number,
    header: string,
  ): { value?: unknown; error?: ListImportError } {
    if (this.isBlankValue(rawValue)) return { value: undefined };

    const textValue = this.valueToString(rawValue).trim();

    switch (column.cellType) {
      case 'number': {
        const numericValue = this.parseImportNumber(textValue);

        if (numericValue === null) {
          return {
            error: {
              row: rowNumber,
              field: header,
              message: `${header} must be a valid number`,
            },
          };
        }

        return { value: numericValue };
      }

      case 'checkbox': {
        const boolValue = this.parseImportBoolean(textValue);

        if (boolValue === null) {
          return {
            error: {
              row: rowNumber,
              field: header,
              message: `${header} must be true or false`,
            },
          };
        }

        return { value: boolValue };
      }

      case 'multiselect':
        return {
          value: textValue
            .split(/[;,\n]/)
            .map((value) => value.trim())
            .filter(Boolean),
        };

      default:
        return { value: textValue };
    }
  }

  private parseImportNumber(value: string): number | null {
    const normalized =
      /^\d+,\d+$/.test(value) && !value.includes('.')
        ? value.replace(',', '.')
        : value.replace(/,/g, '');
    const parsed = Number(normalized);

    return Number.isFinite(parsed) ? parsed : null;
  }

  private parseImportBoolean(value: string): boolean | null {
    const normalized = value.trim().toLowerCase();

    if (
      ['true', 'yes', 'y', '1', 'x', 'checked', 'ja', 'wahr'].includes(
        normalized,
      )
    ) {
      return true;
    }

    if (
      ['false', 'no', 'n', '0', 'unchecked', 'nein', 'falsch'].includes(
        normalized,
      )
    ) {
      return false;
    }

    return null;
  }

  private findTitleHeaderIndex(headers: string[]): number {
    return headers.findIndex((header) =>
      ListsService.IMPORT_TITLE_HEADERS.has(this.normalizeComparable(header)),
    );
  }

  private findDescriptionHeaderIndex(headers: string[]): number {
    return headers.findIndex((header) =>
      ListsService.IMPORT_DESCRIPTION_HEADERS.has(
        this.normalizeComparable(header),
      ),
    );
  }

  private cleanHeader(value: unknown): string {
    return this.valueToString(value)
      .replace(/^\uFEFF/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeComparable(value: string): string {
    return value
      .replace(/^\uFEFF/, '')
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ');
  }

  private buildUniqueColumnId(
    header: string,
    usedColumnIds: Set<string>,
  ): string {
    const base =
      header
        .toLowerCase()
        .replace(/^\uFEFF/, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48) || 'column';
    let candidate = base;
    let suffix = 2;

    while (usedColumnIds.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }

    usedColumnIds.add(candidate);

    return candidate;
  }

  private sanitizeImportedListName(
    requestedName: string | undefined,
    fileBaseName: string,
  ): string {
    const rawName = requestedName || fileBaseName || 'Imported List';
    const cleaned = rawName.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

    return (cleaned || 'Imported List').slice(0, 200);
  }

  private getFileExtension(fileName = ''): string {
    const match = fileName.toLowerCase().match(/\.[^.]+$/);

    return match?.[0] ?? '';
  }

  private getFileBaseName(fileName = ''): string {
    const nameOnly = fileName.split(/[\\/]/).pop() || 'Imported List';

    return nameOnly.replace(/\.[^.]+$/, '');
  }

  private trimTrailingEmptyCells(values: unknown[]): unknown[] {
    let end = values.length;

    while (end > 0 && this.isBlankValue(values[end - 1])) end -= 1;

    return values.slice(0, end);
  }

  private isEmptySpreadsheetRow(values: unknown[]): boolean {
    return values.every((value) => this.isBlankValue(value));
  }

  private isBlankValue(value: unknown): boolean {
    return (
      value === null ||
      value === undefined ||
      this.valueToString(value).trim() === ''
    );
  }

  private valueToString(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    if (value === null || value === undefined) return '';

    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') {
      return value.toString();
    }

    if (typeof value === 'bigint' || typeof value === 'symbol') {
      return value.toString();
    }

    if (typeof value === 'object') {
      try {
        return JSON.stringify(value) ?? '';
      } catch {
        return '';
      }
    }

    return '';
  }

  private formatImportErrors(errors: ListImportError[]): string {
    const preview = errors
      .slice(0, 5)
      .map((error) => {
        const field = error.field ? ` ${error.field}` : '';

        return `row ${error.row}${field}: ${error.message}`;
      })
      .join('; ');
    const suffix =
      errors.length > 5 ? `; and ${errors.length - 5} more error(s)` : '';

    return `Import validation failed: ${preview}${suffix}`;
  }

  private validateColumnConfig(columns: IListColumnConfig[]): void {
    const ids = columns.map((c) => c.columnId);
    if (ids.length !== new Set(ids).size) {
      throw new BadRequestException(
        'Duplicate column IDs found in column configuration',
      );
    }
  }

  private mapFieldTypeToCell(fieldType: string): string {
    const map: Record<string, string> = {
      text: 'text',
      number: 'number',
      date: 'date',
      select: 'dropdown',
      user: 'user',
      boolean: 'checkbox',
    };
    return map[fieldType] ?? 'text';
  }

  private validateFieldsData(
    fieldsData: Record<string, unknown>,
    columnConfig: IListColumnConfig[],
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const col of columnConfig) {
      const value = fieldsData[col.columnId];

      if (
        col.required &&
        (value === null || value === undefined || value === '')
      ) {
        errors.push(`${col.label} is required`);
        continue;
      }

      if (value === null || value === undefined || value === '') continue;

      if (col.validation && typeof value === 'string') {
        const { minLength, maxLength, pattern } = col.validation;
        if (minLength !== undefined && value.length < minLength)
          errors.push(`${col.label} must be at least ${minLength} characters`);
        if (maxLength !== undefined && value.length > maxLength)
          errors.push(`${col.label} must be at most ${maxLength} characters`);
        if (pattern) {
          try {
            if (!new RegExp(pattern).test(value))
              errors.push(`${col.label} has invalid format`);
          } catch {
            // invalid regex — ignore
          }
        }
      }

      if (col.cellType === 'url' && typeof value === 'string') {
        try {
          new URL(value);
        } catch {
          errors.push(`${col.label} must be a valid URL`);
        }
      }

      if (col.cellType === 'email' && typeof value === 'string') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
          errors.push(`${col.label} must be a valid email`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // ── Custom Field Assignments ───────────────────────────────────────────────

  async getCustomFields(
    schemaId: string,
    organizationId: string,
  ): Promise<unknown[]> {
    await this.getSchemaById(schemaId, organizationId);
    const r = await this.db
      .from(ListsService.CUSTOM_FIELDS_TABLE)
      .select(
        `
        *,
        custom_field:custom_fields(
          id, name, field_key, field_type, description,
          options, validation_rules, is_active, name_i18n, description_i18n
        )
      `,
      )
      .eq('schema_id', schemaId)
      .order('sort_order', { ascending: true });
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as unknown[];
  }

  async assignCustomField(
    schemaId: string,
    organizationId: string,
    userId: string,
    dto: AssignCustomFieldDto,
  ): Promise<unknown> {
    await this.getSchemaById(schemaId, organizationId);

    // Check duplicate
    const exists = await this.db
      .from(ListsService.CUSTOM_FIELDS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('schema_id', schemaId)
      .eq('custom_field_id', dto.custom_field_id);
    if ((exists.count ?? 0) > 0) {
      throw new ConflictException(
        'Custom field is already assigned to this schema',
      );
    }

    const r = await this.db
      .from(ListsService.CUSTOM_FIELDS_TABLE)
      .insert({
        organization_id: organizationId,
        schema_id: schemaId,
        custom_field_id: dto.custom_field_id,
        sort_order: dto.sort_order ?? 0,
        is_required: dto.is_required ?? false,
        is_hidden: dto.is_hidden ?? false,
        column_span: dto.column_span ?? 1,
        default_value_override: dto.default_value_override ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    return r.data;
  }

  async updateCustomFieldAssignment(
    assignmentId: string,
    userId: string,
    dto: UpdateCustomFieldAssignmentDto,
    organizationId: string,
  ): Promise<unknown> {
    // SECURITY (M): verify the assignment's schema belongs to the caller's org
    // before mutating — previously scoped by assignment id only (cross-tenant).
    const existing = await this.db
      .from(ListsService.CUSTOM_FIELDS_TABLE)
      .select('schema_id')
      .eq('id', assignmentId)
      .maybeSingle();

    if (!existing.data)
      throw new NotFoundException('Custom field assignment not found');

    await this.getSchemaById(existing.data.schema_id as string, organizationId);

    const patch: Record<string, unknown> = {
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };
    if (dto.sort_order !== undefined) patch['sort_order'] = dto.sort_order;
    if (dto.is_required !== undefined) patch['is_required'] = dto.is_required;
    if (dto.is_hidden !== undefined) patch['is_hidden'] = dto.is_hidden;
    if (dto.column_span !== undefined) patch['column_span'] = dto.column_span;
    if (dto.default_value_override !== undefined)
      patch['default_value_override'] = dto.default_value_override;

    const r = await this.db
      .from(ListsService.CUSTOM_FIELDS_TABLE)
      .update(patch)
      .eq('id', assignmentId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data)
      throw new NotFoundException('Custom field assignment not found');
    return r.data;
  }

  async removeCustomField(
    assignmentId: string,
    organizationId: string,
  ): Promise<void> {
    // SECURITY (M): verify the assignment's schema belongs to the caller's org.
    const existing = await this.db
      .from(ListsService.CUSTOM_FIELDS_TABLE)
      .select('schema_id')
      .eq('id', assignmentId)
      .maybeSingle();

    if (!existing.data)
      throw new NotFoundException('Custom field assignment not found');

    await this.getSchemaById(existing.data.schema_id as string, organizationId);

    const r = await this.db
      .from(ListsService.CUSTOM_FIELDS_TABLE)
      .delete()
      .eq('id', assignmentId);
    if (r.error) throw new BadRequestException(r.error.message);
  }

  async reorderCustomFields(
    schemaId: string,
    organizationId: string,
    dto: ReorderCustomFieldsDto,
  ): Promise<void> {
    await this.getSchemaById(schemaId, organizationId);
    for (const { assignment_id, sort_order } of dto.field_orders) {
      const r = await this.db
        .from(ListsService.CUSTOM_FIELDS_TABLE)
        .update({ sort_order, updated_at: new Date().toISOString() })
        .eq('id', assignment_id)
        .eq('schema_id', schemaId);
      if (r.error) throw new BadRequestException(r.error.message);
    }
  }

  async syncCustomFields(
    schemaId: string,
    organizationId: string,
    userId: string,
    dto: SyncCustomFieldsDto,
  ): Promise<unknown[]> {
    await this.getSchemaById(schemaId, organizationId);

    // Delete all existing
    const del = await this.db
      .from(ListsService.CUSTOM_FIELDS_TABLE)
      .delete()
      .eq('schema_id', schemaId);
    if (del.error) throw new BadRequestException(del.error.message);

    if (dto.custom_field_ids.length === 0) return [];

    const records = dto.custom_field_ids.map((fieldId, index) => ({
      organization_id: organizationId,
      schema_id: schemaId,
      custom_field_id: fieldId,
      sort_order: index,
      is_required: false,
      is_hidden: false,
      column_span: 1,
      created_by: userId,
      updated_by: userId,
    }));

    const r = await this.db
      .from(ListsService.CUSTOM_FIELDS_TABLE)
      .insert(records)
      .select();
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as unknown[];
  }

  // ── Item Custom Field Values ───────────────────────────────────────────────

  async getItemCustomFieldValues(itemId: string, organizationId: string) {
    const item = await this.getItemById(itemId, organizationId);
    return { data: item.custom_field_values ?? {}, version: item.version };
  }

  async updateItemCustomFieldValues(
    itemId: string,
    organizationId: string,
    userId: string,
    customFieldValues: Record<string, unknown>,
    version: number,
  ): Promise<ListItem> {
    return this.updateItem(itemId, organizationId, userId, {
      custom_field_values: customFieldValues,
      version,
    } as any);
  }

  // ── Item History ───────────────────────────────────────────────────────────
  // (getItemHistory already defined above — controller route wires it in)

  // ── Comments ──────────────────────────────────────────────────────────────

  async getComments(
    itemId: string,
    organizationId: string,
  ): Promise<unknown[]> {
    const r = await this.db
      .from(ListsService.COMMENTS_TABLE)
      .select(
        '*, created_by_user:users!asset_item_comments_created_by_fkey(id, first_name, last_name, email, avatar_url)',
      )
      .eq('item_id', itemId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as unknown[];
  }

  async createComment(
    itemId: string,
    organizationId: string,
    userId: string,
    content: string,
  ): Promise<unknown> {
    const r = await this.db
      .from(ListsService.COMMENTS_TABLE)
      .insert({
        item_id: itemId,
        organization_id: organizationId,
        content,
        created_by: userId,
      })
      .select(
        '*, created_by_user:users!asset_item_comments_created_by_fkey(id, first_name, last_name, email, avatar_url)',
      )
      .single();
    if (r.error) throw new BadRequestException(r.error.message);

    // Fire-and-forget: log comment_added — must not block the response
    void (async () => {
      const itemR = await this.db
        .from(ListsService.ITEMS_TABLE)
        .select('schema_id')
        .eq('id', itemId)
        .maybeSingle();
      const schemaId = (itemR.data as Record<string, unknown>)
        ?.schema_id as string;
      if (schemaId) {
        await this.logChange({
          item_id: itemId,
          schema_id: schemaId,
          organization_id: organizationId,
          change_type: 'comment_added',
          new_value: {
            comment_id: (r.data as Record<string, unknown>)?.id,
            content_preview: content.substring(0, 150),
          },
          changed_by: userId,
        });
      }
    })();

    return r.data;
  }

  async updateComment(
    commentId: string,
    organizationId: string,
    userId: string,
    content: string,
  ): Promise<unknown> {
    // Fetch old content and item_id before updating — needed for before/after history
    const oldR = await this.db
      .from(ListsService.COMMENTS_TABLE)
      .select('content, item_id')
      .eq('id', commentId)
      .maybeSingle();
    const oldContent = (oldR.data as Record<string, unknown>)?.content as
      | string
      | undefined;
    const itemId = (oldR.data as Record<string, unknown>)?.item_id as
      | string
      | undefined;

    const r = await this.db
      .from(ListsService.COMMENTS_TABLE)
      .update({ content, updated_at: new Date().toISOString() })
      .eq('id', commentId)
      .eq('organization_id', organizationId)
      .eq('created_by', userId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Comment not found');

    // Fire-and-forget: log comment_updated with old and new content preview
    if (itemId) {
      void (async () => {
        const itemR = await this.db
          .from(ListsService.ITEMS_TABLE)
          .select('schema_id')
          .eq('id', itemId)
          .maybeSingle();
        const schemaId = (itemR.data as Record<string, unknown>)
          ?.schema_id as string;
        if (schemaId) {
          await this.logChange({
            item_id: itemId,
            schema_id: schemaId,
            organization_id: organizationId,
            change_type: 'comment_updated',
            old_value: {
              comment_id: commentId,
              content_preview: (oldContent ?? '').substring(0, 150),
            },
            new_value: {
              comment_id: commentId,
              content_preview: content.substring(0, 150),
            },
            changed_by: userId,
          });
        }
      })();
    }

    return r.data;
  }

  async deleteComment(
    commentId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    // Fetch comment content and item_id BEFORE deleting — needed for history
    const commentR = await this.db
      .from(ListsService.COMMENTS_TABLE)
      .select('content, item_id')
      .eq('id', commentId)
      .maybeSingle();
    const oldContent = (commentR.data as Record<string, unknown>)?.content as
      | string
      | undefined;
    const itemId = (commentR.data as Record<string, unknown>)?.item_id as
      | string
      | undefined;

    const r = await this.db
      .from(ListsService.COMMENTS_TABLE)
      .delete()
      .eq('id', commentId)
      .eq('organization_id', organizationId)
      .eq('created_by', userId);
    if (r.error) throw new BadRequestException(r.error.message);

    // Fire-and-forget: log comment_deleted with deleted content preview
    if (itemId) {
      void (async () => {
        const itemR = await this.db
          .from(ListsService.ITEMS_TABLE)
          .select('schema_id')
          .eq('id', itemId)
          .maybeSingle();
        const schemaId = (itemR.data as Record<string, unknown>)
          ?.schema_id as string;
        if (schemaId) {
          await this.logChange({
            item_id: itemId,
            schema_id: schemaId,
            organization_id: organizationId,
            change_type: 'comment_deleted',
            old_value: {
              comment_id: commentId,
              content_preview: (oldContent ?? '').substring(0, 150),
            },
            changed_by: userId,
          });
        }
      })();
    }
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  async getAttachments(
    itemId: string,
    organizationId: string,
  ): Promise<unknown[]> {
    const r = await this.db
      .from(ListsService.ATTACHMENTS_TABLE)
      .select('*')
      .eq('item_id', itemId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as unknown[];
  }

  async uploadAttachment(
    itemId: string,
    organizationId: string,
    schemaId: string,
    file: Express.Multer.File,
    userId: string,
  ): Promise<unknown> {
    // The object KEY must be ASCII-safe: an umlaut or a space in the filename reaches Supabase
    // Storage verbatim and the upload fails, which is how an ordinary German filename broke this
    // endpoint. Every other upload path in the app sanitises the same way; the untouched filename is
    // still what gets stored on the row for display.
    const sanitizedName = storageSafeFileName(file.originalname);
    const filePath = `${organizationId}/${schemaId}/${itemId}/${Date.now()}_${sanitizedName}`;

    const { error: uploadError } = await this.db.storage
      .from(ListsService.ATTACHMENTS_BUCKET)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) throw new BadRequestException(uploadError.message);

    const r = await this.db
      .from(ListsService.ATTACHMENTS_TABLE)
      .insert({
        item_id: itemId,
        organization_id: organizationId,
        file_name: file.originalname,
        file_path: filePath,
        file_size: file.size,
        mime_type: file.mimetype,
        uploaded_by: userId,
      })
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);

    // Fire-and-forget: log attachment_added
    void (async () => {
      const itemR = await this.db
        .from(ListsService.ITEMS_TABLE)
        .select('schema_id')
        .eq('id', itemId)
        .maybeSingle();
      const sid = (itemR.data as Record<string, unknown>)?.schema_id as string;
      if (sid) {
        await this.logChange({
          item_id: itemId,
          schema_id: sid,
          organization_id: organizationId,
          change_type: 'attachment_added',
          new_value: {
            file_name: file.originalname,
            file_size: file.size,
          },
          changed_by: userId,
        });
      }
    })();

    return r.data;
  }

  async getAttachmentDownloadUrl(
    attachmentId: string,
    organizationId: string,
  ): Promise<string> {
    const meta = await this.db
      .from(ListsService.ATTACHMENTS_TABLE)
      .select('file_path')
      .eq('id', attachmentId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (meta.error) throw new BadRequestException(meta.error.message);
    if (!meta.data) throw new NotFoundException('Attachment not found');

    const filePath = (meta.data as { file_path: string }).file_path;
    const { data, error } = await this.db.storage
      .from(ListsService.ATTACHMENTS_BUCKET)
      .createSignedUrl(filePath, 3600);
    if (error) throw new BadRequestException(error.message);
    return data?.signedUrl ?? '';
  }

  async deleteAttachment(
    attachmentId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    // Fetch attachment metadata for storage removal and history logging
    const meta = await this.db
      .from(ListsService.ATTACHMENTS_TABLE)
      .select('item_id, file_path, file_name, file_size')
      .eq('id', attachmentId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (meta.error) throw new BadRequestException(meta.error.message);
    if (!meta.data) throw new NotFoundException('Attachment not found');

    const {
      item_id: itemId,
      file_path: filePath,
      file_name: fileName,
      file_size: fileSize,
    } = meta.data as {
      item_id: string;
      file_path: string;
      file_name: string;
      file_size: number;
    };

    if (filePath) {
      await this.db.storage
        .from(ListsService.ATTACHMENTS_BUCKET)
        .remove([filePath]);
    }

    const r = await this.db
      .from(ListsService.ATTACHMENTS_TABLE)
      .delete()
      .eq('id', attachmentId)
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);

    // Fire-and-forget: log attachment_deleted with file metadata
    if (itemId) {
      void (async () => {
        const itemR = await this.db
          .from(ListsService.ITEMS_TABLE)
          .select('schema_id')
          .eq('id', itemId)
          .maybeSingle();
        const schemaId = (itemR.data as Record<string, unknown>)
          ?.schema_id as string;
        if (schemaId) {
          await this.logChange({
            item_id: itemId,
            schema_id: schemaId,
            organization_id: organizationId,
            change_type: 'attachment_deleted',
            old_value: {
              attachment_id: attachmentId,
              file_name: fileName,
              file_size: fileSize,
            },
            changed_by: userId,
          });
        }
      })();
    }
  }

  // ── Links ──────────────────────────────────────────────────────────────────

  async getLinks(itemId: string, organizationId: string): Promise<unknown[]> {
    const r = await this.db
      .from(ListsService.LINKS_TABLE)
      .select('*')
      .eq('source_id', itemId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as unknown[];
  }

  async createLink(
    itemId: string,
    organizationId: string,
    userId: string,
    data: {
      target_type: string;
      target_id: string;
      link_type?: string;
      source_type?: string;
      source_id?: string;
    },
  ): Promise<unknown> {
    const r = await this.db
      .from(ListsService.LINKS_TABLE)
      .insert({
        organization_id: organizationId,
        source_type: data.source_type ?? 'asset_item',
        source_id: data.source_id ?? itemId,
        target_type: data.target_type,
        target_id: data.target_id,
        link_type: data.link_type ?? null,
        created_by: userId,
      })
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    return r.data;
  }

  async deleteLink(linkId: string, organizationId: string): Promise<void> {
    const r = await this.db
      .from(ListsService.LINKS_TABLE)
      .delete()
      .eq('id', linkId)
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);
  }

  async getLinksForTaskGroupedBySchema(
    taskId: string,
    organizationId: string,
  ): Promise<{
    links: unknown[];
    groups: Array<{
      schema: Record<string, unknown>;
      items: Record<string, unknown>[];
    }>;
  }> {
    const sourceLinks = await this.db
      .from(ListsService.LINKS_TABLE)
      .select('*')
      .eq('source_type', 'task')
      .eq('source_id', taskId)
      .eq('target_type', 'asset_item')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (sourceLinks.error)
      throw new BadRequestException(sourceLinks.error.message);

    const targetLinks = await this.db
      .from(ListsService.LINKS_TABLE)
      .select('*')
      .eq('target_type', 'task')
      .eq('target_id', taskId)
      .eq('source_type', 'asset_item')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (targetLinks.error)
      throw new BadRequestException(targetLinks.error.message);

    const links = [
      ...((sourceLinks.data ?? []) as Array<Record<string, unknown>>),
      ...((targetLinks.data ?? []) as Array<Record<string, unknown>>),
    ];
    const itemIds = [
      ...new Set(
        links
          .map((link) =>
            link.source_type === 'asset_item' ? link.source_id : link.target_id,
          )
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];

    if (itemIds.length === 0) return { links, groups: [] };

    const itemResult = await this.db
      .from(ListsService.ITEMS_TABLE)
      .select(
        'id, title, schema_id, fields_data, version, is_archived, row_order',
      )
      .in('id', itemIds)
      .eq('organization_id', organizationId)
      .eq('is_archived', false);

    if (itemResult.error)
      throw new BadRequestException(itemResult.error.message);

    const items = (itemResult.data ?? []) as Array<Record<string, unknown>>;
    const schemaIds = [
      ...new Set(
        items
          .map((item) => item.schema_id)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];

    if (schemaIds.length === 0) return { links, groups: [] };

    const schemaResult = await this.db
      .from(ListsService.SCHEMAS_TABLE)
      .select('id, name, key, icon, column_config, space_id')
      .in('id', schemaIds)
      .eq('organization_id', organizationId);

    if (schemaResult.error)
      throw new BadRequestException(schemaResult.error.message);

    return {
      links,
      groups: ((schemaResult.data ?? []) as Array<Record<string, unknown>>).map(
        (schema) => ({
          schema,
          items: items.filter((item) => item.schema_id === schema.id),
        }),
      ),
    };
  }

  async getTaskListDisplayConfig(
    spaceId: string,
    schemaId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.db
      .from('task_list_display_config')
      .select('visible_columns')
      .eq('space_id', spaceId)
      .eq('schema_id', schemaId)
      .maybeSingle();

    if (result.error) throw new BadRequestException(result.error.message);
    return result.data as Record<string, unknown> | null;
  }

  async upsertTaskListDisplayConfig(
    spaceId: string,
    schemaId: string,
    visibleColumns: string[],
  ): Promise<{ success: true }> {
    const result = await this.db.from('task_list_display_config').upsert(
      {
        space_id: spaceId,
        schema_id: schemaId,
        visible_columns: visibleColumns,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'space_id,schema_id' },
    );

    if (result.error) throw new BadRequestException(result.error.message);
    return { success: true };
  }

  // ── Relations ─────────────────────────────────────────────────────────────

  async getRelations(
    itemId: string,
    organizationId: string,
  ): Promise<unknown[]> {
    const r = await this.db
      .from(ListsService.RELATIONS_TABLE)
      .select(
        `
        *,
        relation_type:relation_types!asset_item_relations_relation_type_id_fkey(id,name,name_i18n,outward_description,inward_description,outward_description_i18n,inward_description_i18n,color,icon,is_directional),
        source_item:asset_items!asset_item_relations_source_item_id_fkey(id,title,schema_id,schema:asset_schemas!asset_items_schema_id_fkey(id,name,key,icon)),
        target_item:asset_items!asset_item_relations_target_item_id_fkey(id,title,schema_id,schema:asset_schemas!asset_items_schema_id_fkey(id,name,key,icon)),
        created_by_user:users!asset_item_relations_created_by_fkey(id,first_name,last_name,email,avatar_url)
      `,
      )
      .eq('organization_id', organizationId)
      .or(`source_item_id.eq.${itemId},target_item_id.eq.${itemId}`)
      .order('created_at', { ascending: false });
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as unknown[];
  }

  async createRelation(
    sourceItemId: string,
    targetItemId: string,
    relationTypeId: string,
    organizationId: string,
    userId: string,
  ): Promise<unknown> {
    const r = await this.db
      .from(ListsService.RELATIONS_TABLE)
      .insert({
        organization_id: organizationId,
        source_item_id: sourceItemId,
        target_item_id: targetItemId,
        relation_type_id: relationTypeId,
        created_by: userId,
      })
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);

    void (async () => {
      try {
        const { data } = await this.db
          .from('asset_items')
          .select('id, title, schema_id, organization_id, space_id')
          .eq('id', sourceItemId)
          .maybeSingle();
        const item = data as {
          id: string;
          title: string | null;
          schema_id: string | null;
          organization_id: string;
          space_id: string | null;
        } | null;

        if (item?.organization_id) {
          await this.outboxService?.write(
            item.organization_id,
            item.space_id ?? '',
            'app.asset.relation_added',
            {
              sourceItemId,
              schemaId: item.schema_id,
              assetItem: {
                id: item.id,
                title: item.title ?? '',
                schema_id: item.schema_id ?? '',
                organization_id: item.organization_id,
              },
              relatedAssetItemId: targetItemId,
              relationType: relationTypeId,
            },
          );
        }
      } catch (err) {
        console.error(
          '[lists.service] asset.relation_added outbox error:',
          err,
        );
      }
    })();

    return r.data;
  }

  async deleteRelation(
    relationId: string,
    organizationId: string,
  ): Promise<void> {
    const r = await this.db
      .from(ListsService.RELATIONS_TABLE)
      .delete()
      .eq('id', relationId)
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);
  }

  // ── Schema Column Operations ───────────────────────────────────────────────
  // addColumn, removeColumn, renameColumn, reorderColumns already defined above

  private async logChange(change: {
    item_id: string;
    schema_id: string;
    organization_id: string;
    change_type: string;
    column_id?: string;
    old_value?: unknown;
    new_value?: unknown;
    metadata?: Record<string, unknown>;
    changed_by: string;
  }): Promise<void> {
    try {
      await this.db.from(ListsService.CHANGES_TABLE).insert(change);
    } catch {
      // Silently ignore audit logging failures
    }
  }
}
