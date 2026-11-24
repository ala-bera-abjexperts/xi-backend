/**
 * @fileoverview Org-scoped GDPR service — spreadsheet, records, columns,
 * comments, attachments, history, and CSV export.
 * @module src/gdpr/gdpr.service
 */

import { storageSafeFileName } from '../common/upload-filename';
import { formatMaxUpload, UPLOAD_LIMITS } from '../common/upload-limits';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { sanitizeRichText } from '../common/utils/sanitize-rich-text';
import type { UpdateSpreadsheetDto } from './dto/update-spreadsheet.dto';
import type { AddColumnDto } from './dto/add-column.dto';
import type { RenameColumnDto } from './dto/rename-column.dto';
import type { ReorderColumnsDto } from './dto/reorder-columns.dto';
import type { CreateRecordDto } from './dto/create-record.dto';
import type { UpdateRecordDto } from './dto/update-record.dto';
import type { ListRecordsQueryDto } from './dto/list-records-query.dto';
import type { BulkUpdateCellsDto } from './dto/bulk-update-cells.dto';
import type { ReorderRecordsDto } from './dto/reorder-records.dto';
import type { ToggleArchiveDto } from './dto/toggle-archive.dto';
import type { CreateGdprCommentDto } from './dto/create-gdpr-comment.dto';
import type { UpdateGdprCommentDto } from './dto/update-gdpr-comment.dto';

const GDPR_BUCKET = 'gdpr-attachments';
const SIGNED_URL_EXPIRY = 3600; // matches risk-management-app default
const MAX_BULK_ITEMS = 100;
/** Attachments carry NO type restriction; the size cap is the abuse control. */
const MAX_FILE_SIZE = UPLOAD_LIMITS.ATTACHMENT;

const USER_SELECT = 'id, first_name, last_name, email, avatar_url';
const RECORD_SELECT = `*, updated_by_user:users!updated_by(${USER_SELECT})`;
const COMMENT_SELECT = `*, created_by_user:users!created_by(${USER_SELECT})`;
const ATTACHMENT_SELECT = `*, uploaded_by_user:users!uploaded_by(${USER_SELECT})`;

@Injectable()
export class GdprService {
  private static readonly SPREADSHEETS = 'gdpr_spreadsheets';
  private static readonly RECORDS = 'gdpr_records';
  private static readonly COMMENTS = 'gdpr_record_comments';
  private static readonly ATTACHMENTS = 'gdpr_record_attachments';
  private static readonly CHANGES = 'gdpr_record_changes';

  private readonly logger = new Logger(GdprService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogs?: AuditLogsService,
    @Optional() private readonly outboxService?: AutomationEventOutboxService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private sanitizeCellValue(value: unknown): unknown {
    if (typeof value === 'string') return sanitizeRichText(value) ?? '';
    if (Array.isArray(value))
      return value.map((item) => this.sanitizeCellValue(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([key, nested]) => [key, this.sanitizeCellValue(nested)],
        ),
      );
    }
    return value;
  }

  private sanitizeCellData(
    cellData: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (!cellData) return {};
    return Object.fromEntries(
      Object.entries(cellData).map(([key, value]) => [
        key,
        this.sanitizeCellValue(value),
      ]),
    );
  }

  // ------------------------------------------------------------------ //
  // Spreadsheet                                                          //
  // ------------------------------------------------------------------ //

  async getOrCreateSpreadsheet(
    orgId: string,
    userId: string,
  ): Promise<unknown> {
    const existing = await this.client
      .from(GdprService.SPREADSHEETS)
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle();
    if (existing.error) {
      throw new BadRequestException(existing.error.message);
    }
    if (existing.data) {
      return existing.data as unknown;
    }
    const defaultColumns = this.getDefaultColumns();
    const ins = await this.client
      .from(GdprService.SPREADSHEETS)
      .insert({
        organization_id: orgId,
        title: 'GDPR Data Processing Records',
        description:
          'Record of Processing Activities (RoPA) as per Article 30 GDPR',
        column_config: defaultColumns,
        sticky_columns: { left: 1, top: 1, right: 0, bottom: 0 },
        default_row_height: 32,
        created_by: userId,
        updated_by: userId,
      })
      .select('*')
      .single();
    if (ins.error) {
      throw new BadRequestException(ins.error.message);
    }
    return ins.data as unknown;
  }

  async getSpreadsheetWithRecords(
    orgId: string,
    userId: string,
    filters: ListRecordsQueryDto = {},
  ): Promise<Record<string, unknown>> {
    const spreadsheet = (await this.getOrCreateSpreadsheet(
      orgId,
      userId,
    )) as Record<string, unknown>;
    const records = await this.queryRecords(
      orgId,
      {
        ...filters,
        spreadsheet_id: (spreadsheet['id'] as string) || filters.spreadsheet_id,
      },
      false,
    );

    return {
      ...spreadsheet,
      records: records.data,
    };
  }

  async updateSpreadsheet(
    orgId: string,
    userId: string,
    dto: UpdateSpreadsheetDto,
  ): Promise<unknown> {
    const sheet = await this.getSpreadsheetOrThrow(orgId);
    const upd = await this.client
      .from(GdprService.SPREADSHEETS)
      .update({
        ...dto,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', (sheet as Record<string, unknown>)['id'])
      .select('*')
      .single();
    if (upd.error) {
      throw new BadRequestException(upd.error.message);
    }
    return upd.data as unknown;
  }

  // ------------------------------------------------------------------ //
  // Columns                                                              //
  // ------------------------------------------------------------------ //

  async addColumn(
    orgId: string,
    userId: string,
    dto: AddColumnDto,
  ): Promise<unknown> {
    const sheet = await this.getSpreadsheetOrThrow(orgId);
    const sheetRow = sheet as Record<string, unknown>;
    const spreadsheetId = sheetRow['id'] as string;
    const columns = ((sheetRow['column_config'] as unknown[]) ?? []).slice();
    const column = this.normalizeColumnInput(dto, columns.length);

    // Prevent duplicate columnId (matches IColumnConfig field name)
    const exists = columns.some(
      (c) => (c as Record<string, unknown>)['columnId'] === column['columnId'],
    );
    if (exists) {
      throw new BadRequestException(
        `Column '${String(column['columnId'])}' already exists`,
      );
    }

    // `position` is the insert index only — exclude it from the stored column data
    const insertAt = dto.position !== undefined ? dto.position : columns.length;
    columns.splice(insertAt, 0, column);

    // Sort by `order` to maintain display ordering
    const reorderedColumns = columns.map((col, index) => ({
      ...(col as Record<string, unknown>),
      order: index,
    }));

    const upd = await this.client
      .from(GdprService.SPREADSHEETS)
      .update({
        column_config: reorderedColumns,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', spreadsheetId)
      .select('*')
      .single();
    if (upd.error) {
      throw new BadRequestException(upd.error.message);
    }
    await this.logAuditAction(
      orgId,
      userId,
      'gdpr_spreadsheet',
      spreadsheetId,
      'update',
      {
        action: 'column_add',
        column_id: column['columnId'],
      },
    );
    return upd.data as unknown;
  }

  async removeColumn(
    orgId: string,
    columnId: string,
    userId: string,
  ): Promise<unknown> {
    const sheet = await this.getSpreadsheetOrThrow(orgId);
    const sheetRow = sheet as Record<string, unknown>;
    const spreadsheetId = sheetRow['id'] as string;
    let columns = ((sheetRow['column_config'] as unknown[]) ?? []).slice();
    const before = columns.length;
    columns = columns.filter(
      (c) => (c as Record<string, unknown>)['columnId'] !== columnId,
    );
    if (columns.length === before) {
      throw new NotFoundException(`Column '${columnId}' not found`);
    }

    const upd = await this.client
      .from(GdprService.SPREADSHEETS)
      .update({
        column_config: columns,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', spreadsheetId)
      .select('*')
      .single();
    if (upd.error) {
      throw new BadRequestException(upd.error.message);
    }
    await this.logAuditAction(
      orgId,
      userId,
      'gdpr_spreadsheet',
      spreadsheetId,
      'update',
      {
        action: 'column_remove',
        column_id: columnId,
      },
    );
    return upd.data as unknown;
  }

  async renameColumn(
    orgId: string,
    columnId: string,
    userId: string,
    dto: RenameColumnDto,
  ): Promise<unknown> {
    const sheet = await this.getSpreadsheetOrThrow(orgId);
    const sheetRow = sheet as Record<string, unknown>;
    const spreadsheetId = sheetRow['id'] as string;
    const columns = ((sheetRow['column_config'] as unknown[]) ?? []).slice();
    const col = columns.find(
      (c) => (c as Record<string, unknown>)['columnId'] === columnId,
    ) as Record<string, unknown> | undefined;
    if (!col) {
      throw new NotFoundException(`Column '${columnId}' not found`);
    }
    const nextLabel = dto.label ?? dto.new_label;
    if (!nextLabel) {
      throw new BadRequestException('Column label is required');
    }
    col['label'] = nextLabel;

    const upd = await this.client
      .from(GdprService.SPREADSHEETS)
      .update({
        column_config: columns,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', spreadsheetId)
      .select('*')
      .single();
    if (upd.error) {
      throw new BadRequestException(upd.error.message);
    }
    await this.logAuditAction(
      orgId,
      userId,
      'gdpr_spreadsheet',
      spreadsheetId,
      'update',
      {
        action: 'column_rename',
        column_id: columnId,
        new_label: nextLabel,
      },
    );
    return upd.data as unknown;
  }

  async reorderColumns(
    orgId: string,
    userId: string,
    dto: ReorderColumnsDto,
  ): Promise<unknown> {
    const sheet = await this.getSpreadsheetOrThrow(orgId);
    const sheetRow = sheet as Record<string, unknown>;
    const spreadsheetId = sheetRow['id'] as string;
    const columns = ((sheetRow['column_config'] as unknown[]) ?? []).slice();

    const orderMap = new Map(
      dto.column_orders.map((c) => [c.column_id, c.new_order]),
    );
    columns.forEach((c) => {
      const col = c as Record<string, unknown>;
      const newOrder = orderMap.get(col['columnId'] as string);
      if (newOrder !== undefined) col['order'] = newOrder;
    });
    columns.sort(
      (a, b) =>
        ((a as Record<string, unknown>)['order'] as number) -
        ((b as Record<string, unknown>)['order'] as number),
    );

    const upd = await this.client
      .from(GdprService.SPREADSHEETS)
      .update({
        column_config: columns,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', spreadsheetId)
      .select('*')
      .single();
    if (upd.error) {
      throw new BadRequestException(upd.error.message);
    }
    await this.logAuditAction(
      orgId,
      userId,
      'gdpr_spreadsheet',
      spreadsheetId,
      'update',
      {
        action: 'column_reorder',
        column_orders: dto.column_orders,
      },
    );
    return upd.data as unknown;
  }

  // ------------------------------------------------------------------ //
  // Records                                                              //
  // ------------------------------------------------------------------ //

  async listRecords(
    orgId: string,
    filters: ListRecordsQueryDto,
  ): Promise<{
    data: unknown[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    return this.queryRecords(orgId, filters, true);
  }

  async createRecord(
    orgId: string,
    userId: string,
    dto: CreateRecordDto,
  ): Promise<unknown> {
    // Must resolve spreadsheet_id before inserting
    const sheet = await this.getOrCreateSpreadsheet(orgId, userId);
    const sheetRow = sheet as Record<string, unknown>;
    const spreadsheetId = sheetRow['id'] as string;

    // Auto-increment row_order: use max existing + 1 when not provided
    let rowOrder = dto.row_order;
    if (rowOrder === undefined) {
      const { data: maxRow } = await this.client
        .from(GdprService.RECORDS)
        .select('row_order')
        .eq('organization_id', orgId)
        .order('row_order', { ascending: false })
        .limit(1)
        .maybeSingle();
      rowOrder = maxRow
        ? ((maxRow as Record<string, unknown>)['row_order'] as number) + 1
        : 0;
    }

    const sanitizedCellData = this.sanitizeCellData(dto.cell_data);

    const ins = await this.client
      .from(GdprService.RECORDS)
      .insert({
        spreadsheet_id: spreadsheetId,
        organization_id: orgId,
        cell_data: sanitizedCellData,
        row_order: rowOrder,
        assignee_id: dto.assignee_id ?? null,
        created_by: userId,
        version: 1,
      })
      .select(RECORD_SELECT)
      .single();
    if (ins.error) {
      throw new BadRequestException(ins.error.message);
    }
    const newRecord = ins.data as Record<string, unknown>;
    await this.logChange({
      organization_id: orgId,
      spreadsheet_id: spreadsheetId,
      record_id: newRecord['id'] as string,
      changed_by: userId,
      change_type: 'row_create',
      new_value: sanitizedCellData,
      metadata: {},
    });
    await this.logAuditAction(
      orgId,
      userId,
      'gdpr_record',
      newRecord['id'] as string,
      'create',
      { spreadsheet_id: spreadsheetId },
    );

    void this.outboxService?.write(orgId, '', 'app.gdpr.record_added', {
      record: {
        id: newRecord['id'],
        organization_id: orgId,
        spreadsheet_id: spreadsheetId,
      },
    });

    return ins.data as unknown;
  }

  async getRecord(id: string, orgId: string): Promise<unknown> {
    return this.getRecordOrThrow(id, orgId);
  }

  async updateRecord(
    id: string,
    orgId: string,
    userId: string,
    dto: UpdateRecordDto,
  ): Promise<unknown> {
    const existing = await this.getRecordOrThrow(id, orgId);
    const existingRow = existing as Record<string, unknown>;

    if ((existingRow['version'] as number) !== dto.version) {
      throw new ConflictException(
        `Record version mismatch — expected ${String(existingRow['version'])}, got ${String(dto.version)}`,
      );
    }

    const payload: Record<string, unknown> = {
      version: dto.version + 1,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };
    const sanitizedCellData =
      dto.cell_data !== undefined
        ? this.sanitizeCellData(dto.cell_data)
        : undefined;
    if (sanitizedCellData !== undefined)
      payload['cell_data'] = sanitizedCellData;
    if (dto.row_order !== undefined) payload['row_order'] = dto.row_order;
    if (dto.is_archived !== undefined) payload['is_archived'] = dto.is_archived;
    if ('assignee_id' in dto) payload['assignee_id'] = dto.assignee_id ?? null;

    const upd = await this.client
      .from(GdprService.RECORDS)
      .update(payload)
      .eq('id', id)
      .eq('organization_id', orgId)
      .eq('version', dto.version)
      .select(RECORD_SELECT)
      .single();
    if (upd.error?.code === 'PGRST116' || !upd.data) {
      throw new ConflictException(
        'Record was updated by another user. Please refresh and try again.',
      );
    }
    if (upd.error) {
      throw new BadRequestException(upd.error.message);
    }
    await this.logChange({
      organization_id: orgId,
      spreadsheet_id: existingRow['spreadsheet_id'] as string,
      record_id: id,
      changed_by: userId,
      change_type: 'cell_update',
      old_value: existingRow['cell_data'],
      new_value: sanitizedCellData ?? existingRow['cell_data'],
      metadata: {
        previous_version: dto.version,
        row_order: dto.row_order,
        is_archived: dto.is_archived,
        assignee_id: dto.assignee_id,
      },
    });
    await this.logAuditAction(orgId, userId, 'gdpr_record', id, 'update', {
      previous_version: dto.version,
      fields: Object.keys(payload).filter(
        (key) => !['updated_by', 'updated_at'].includes(key),
      ),
    });
    return upd.data as unknown;
  }

  async deleteRecord(
    id: string,
    orgId: string,
    userId?: string,
  ): Promise<void> {
    const record = await this.getRecordOrThrow(id, orgId);
    const recordRow = record as Record<string, unknown>;

    const { data: attachments, error: attachmentError } = await this.client
      .from(GdprService.ATTACHMENTS)
      .select('file_path')
      .eq('record_id', id)
      .eq('organization_id', orgId);
    if (attachmentError) {
      throw new BadRequestException(attachmentError.message);
    }
    const storagePaths = ((attachments ?? []) as Record<string, unknown>[])
      .map((attachment) => attachment['file_path'] as string | undefined)
      .filter((path): path is string => Boolean(path));

    const { error } = await this.client
      .from(GdprService.RECORDS)
      .delete()
      .eq('id', id)
      .eq('organization_id', orgId);
    if (error) {
      throw new BadRequestException(error.message);
    }
    await this.removeStorageObjects(storagePaths, `record ${id}`);
    if (userId) {
      await this.logAuditAction(orgId, userId, 'gdpr_record', id, 'delete', {
        spreadsheet_id: recordRow['spreadsheet_id'],
        old_value: recordRow['cell_data'],
      });
    }
  }

  async toggleArchive(
    id: string,
    orgId: string,
    userId: string,
    dto: ToggleArchiveDto,
  ): Promise<unknown> {
    const existing = await this.getRecordOrThrow(id, orgId);
    const existingRow = existing as Record<string, unknown>;

    const expectedVersion = (existingRow['version'] as number) ?? 1;
    if (dto.version && expectedVersion !== dto.version) {
      throw new ConflictException(
        `Record version mismatch — expected ${String(existingRow['version'])}, got ${String(dto.version)}`,
      );
    }

    const upd = await this.client
      .from(GdprService.RECORDS)
      .update({
        is_archived: dto.is_archived,
        version: expectedVersion + 1,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', orgId)
      .eq('version', expectedVersion)
      .select(RECORD_SELECT)
      .single();
    if (upd.error?.code === 'PGRST116' || !upd.data) {
      throw new ConflictException(
        'Record was updated by another user. Please refresh and try again.',
      );
    }
    if (upd.error) {
      throw new BadRequestException(upd.error.message);
    }
    const updRow = upd.data as Record<string, unknown>;
    await this.logChange({
      organization_id: orgId,
      spreadsheet_id: updRow['spreadsheet_id'] as string,
      record_id: id,
      changed_by: userId,
      change_type: dto.is_archived ? 'row_delete' : 'row_create',
      metadata: { is_archived: dto.is_archived },
    });
    await this.logAuditAction(
      orgId,
      userId,
      'gdpr_record',
      id,
      dto.is_archived ? 'archive' : 'restore',
      { previous_version: existingRow['version'] },
    );
    return upd.data as unknown;
  }

  async bulkUpdateCells(
    orgId: string,
    userId: string,
    dto: BulkUpdateCellsDto,
  ): Promise<unknown[]> {
    if (dto.updates.length > MAX_BULK_ITEMS) {
      throw new BadRequestException(
        `Bulk update limited to ${String(MAX_BULK_ITEMS)} items`,
      );
    }

    // Batch-read current cell_data + version for all unique records
    const ids = [...new Set(dto.updates.map((u) => u.record_id))];
    const { data: existingRows, error: fetchErr } = await this.client
      .from(GdprService.RECORDS)
      .select('id, version, cell_data')
      .in('id', ids)
      .eq('organization_id', orgId);

    if (fetchErr) {
      throw new BadRequestException(fetchErr.message);
    }

    type RecordSnapshot = {
      version: number;
      cell_data: Record<string, unknown>;
    };
    const recordMap = new Map<string, RecordSnapshot>(
      (existingRows ?? []).map((r) => {
        const row = r as Record<string, unknown>;
        return [
          row['id'] as string,
          {
            version: row['version'] as number,
            cell_data: (row['cell_data'] as Record<string, unknown>) ?? {},
          },
        ];
      }),
    );

    // Group updates by record_id so we merge all column changes in one write
    const byRecord = new Map<string, typeof dto.updates>();
    dto.updates.forEach((item) => {
      if (!byRecord.has(item.record_id)) byRecord.set(item.record_id, []);
      byRecord.get(item.record_id)!.push(item);
    });

    const updatedRecords: unknown[] = [];
    const failed: string[] = [];

    for (const [recordId, items] of Array.from(byRecord.entries())) {
      const snapshot = recordMap.get(recordId);
      // All items for the same record must agree on version.
      const expectedVersion = items[0].version;
      const hasMixedVersions = items.some(
        (item) => item.version !== expectedVersion,
      );
      if (
        !snapshot ||
        snapshot.version !== expectedVersion ||
        hasMixedVersions
      ) {
        items.forEach(() => failed.push(recordId));
        continue;
      }

      const mergedCellData = { ...snapshot.cell_data };
      const changes: Record<string, { old: unknown; new: unknown }> = {};
      items.forEach((item) => {
        changes[item.column_id] = {
          old: mergedCellData[item.column_id],
          new: this.sanitizeCellValue(item.value),
        };
        mergedCellData[item.column_id] = changes[item.column_id].new;
      });

      const upd = await this.client
        .from(GdprService.RECORDS)
        .update({
          cell_data: mergedCellData,
          version: expectedVersion + 1,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', recordId)
        .eq('organization_id', orgId)
        .eq('version', expectedVersion)
        .select(RECORD_SELECT)
        .single();

      if (upd.error || !upd.data) {
        failed.push(recordId);
      } else {
        updatedRecords.push(upd.data as unknown);
        const updatedRow = upd.data as Record<string, unknown>;
        for (const [columnId, change] of Object.entries(changes)) {
          await this.logChange({
            organization_id: orgId,
            spreadsheet_id: updatedRow['spreadsheet_id'] as string,
            record_id: recordId,
            changed_by: userId,
            change_type: 'cell_update',
            column_id: columnId,
            old_value: change.old,
            new_value: change.new,
          });
        }
        await this.logAuditAction(
          orgId,
          userId,
          'gdpr_record',
          recordId,
          'update',
          {
            action: 'bulk_cell_update',
            columns: Object.keys(changes),
            previous_version: expectedVersion,
          },
        );
      }
    }

    if (failed.length > 0) {
      throw new ConflictException(
        `Failed to update ${String(failed.length)} cell update(s). Please refresh and try again.`,
      );
    }

    return updatedRecords;
  }

  async reorderRecords(
    orgId: string,
    userId: string,
    dto: ReorderRecordsDto,
  ): Promise<{ updated: number }> {
    const updates = dto.updates.map((u) => ({
      record_id: u.record_id,
      row_order: u.row_order ?? u.new_order,
    }));
    if (updates.some((u) => u.row_order === undefined)) {
      throw new BadRequestException(
        'Each row update must include row_order or new_order',
      );
    }

    const results = await Promise.all(
      updates.map((u) =>
        this.client
          .from(GdprService.RECORDS)
          .update({
            row_order: u.row_order,
            updated_by: userId,
            updated_at: new Date().toISOString(),
          })
          .eq('id', u.record_id)
          .eq('organization_id', orgId),
      ),
    );
    const failed = results.filter((r) => r.error);
    if (failed.length) {
      throw new BadRequestException(
        `Failed to reorder ${String(failed.length)} record(s)`,
      );
    }
    await Promise.all(
      updates.map((update) =>
        this.logChange({
          organization_id: orgId,
          spreadsheet_id:
            dto.spreadsheet_id ?? dto.spreadsheetId ?? update.record_id,
          record_id: update.record_id,
          changed_by: userId,
          change_type: 'row_reorder',
          new_value: { row_order: update.row_order },
        }),
      ),
    );
    await this.logAuditAction(
      orgId,
      userId,
      'gdpr_spreadsheet',
      dto.spreadsheet_id ?? null,
      'update',
      {
        action: 'row_reorder',
        updates,
      },
    );
    return { updated: updates.length };
  }

  // ------------------------------------------------------------------ //
  // Comments                                                             //
  // ------------------------------------------------------------------ //

  async getComments(recordId: string, orgId: string): Promise<unknown[]> {
    await this.getRecordOrThrow(recordId, orgId);
    const { data, error } = await this.client
      .from(GdprService.COMMENTS)
      .select(COMMENT_SELECT)
      .eq('record_id', recordId)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: true });
    if (error) {
      throw new BadRequestException(error.message);
    }
    return (data ?? []) as unknown[];
  }

  async getCommentCount(
    recordId: string,
    orgId: string,
  ): Promise<{ count: number }> {
    await this.getRecordOrThrow(recordId, orgId);
    const { count, error } = await this.client
      .from(GdprService.COMMENTS)
      .select('*', { count: 'exact', head: true })
      .eq('record_id', recordId)
      .eq('organization_id', orgId);

    if (error) {
      throw new BadRequestException(error.message);
    }

    return { count: count ?? 0 };
  }

  async createComment(
    recordId: string,
    orgId: string,
    userId: string,
    dto: CreateGdprCommentDto,
  ): Promise<unknown> {
    const record = await this.getRecordOrThrow(recordId, orgId);
    const recordRow = record as Record<string, unknown>;
    const sanitizedContent = sanitizeRichText(dto.content) ?? '';
    const ins = await this.client
      .from(GdprService.COMMENTS)
      .insert({
        record_id: recordId,
        organization_id: orgId,
        content: sanitizedContent,
        created_by: userId,
      })
      .select(
        '*,created_by_user:users!created_by(id, first_name, last_name, email, avatar_url)',
      )
      .single();
    if (ins.error) {
      throw new BadRequestException(ins.error.message);
    }
    const comment = ins.data as Record<string, unknown>;
    await this.logChange({
      organization_id: orgId,
      spreadsheet_id: recordRow['spreadsheet_id'] as string,
      record_id: recordId,
      changed_by: userId,
      change_type: 'cell_update',
      new_value: { comment_added: sanitizedContent.substring(0, 100) },
      metadata: {
        action: 'comment_created',
        comment_id: comment['id'],
        content_length: sanitizedContent.length,
      },
    });
    await this.logAuditAction(
      orgId,
      userId,
      'gdpr_comment',
      comment['id'] as string,
      'create',
      {
        record_id: recordId,
      },
    );
    return ins.data as unknown;
  }

  async updateComment(
    recordId: string,
    commentId: string,
    orgId: string,
    userId: string,
    dto: UpdateGdprCommentDto,
  ): Promise<unknown> {
    const record = await this.getRecordOrThrow(recordId, orgId);
    const recordRow = record as Record<string, unknown>;
    const existing = await this.client
      .from(GdprService.COMMENTS)
      .select('id, created_by, content')
      .eq('id', commentId)
      .eq('record_id', recordId)
      .eq('organization_id', orgId)
      .single();
    if (existing.error || !existing.data) {
      throw new NotFoundException(`Comment ${commentId} not found`);
    }
    if ((existing.data as Record<string, unknown>)['created_by'] !== userId) {
      throw new ForbiddenException('Only the comment author can edit it');
    }
    const sanitizedContent = sanitizeRichText(dto.content) ?? '';
    const upd = await this.client
      .from(GdprService.COMMENTS)
      .update({
        content: sanitizedContent,
        updated_at: new Date().toISOString(),
      })
      .eq('id', commentId)
      .eq('record_id', recordId)
      .select(
        '*,created_by_user:users!created_by(id, first_name, last_name, email, avatar_url) ',
      )
      .single();
    if (upd.error) {
      throw new BadRequestException(upd.error.message);
    }
    const existingRow = existing.data as Record<string, unknown>;
    await this.logChange({
      organization_id: orgId,
      spreadsheet_id: recordRow['spreadsheet_id'] as string,
      record_id: recordId,
      changed_by: userId,
      change_type: 'cell_update',
      old_value: {
        comment_updated_from: (typeof existingRow['content'] === 'string'
          ? existingRow['content']
          : ''
        ).substring(0, 100),
      },
      new_value: { comment_updated_to: sanitizedContent.substring(0, 100) },
      metadata: { action: 'comment_updated', comment_id: commentId },
    });
    await this.logAuditAction(
      orgId,
      userId,
      'gdpr_comment',
      commentId,
      'update',
      {
        record_id: recordId,
      },
    );
    return upd.data as unknown;
  }

  async deleteComment(
    recordId: string,
    commentId: string,
    orgId: string,
    userId: string,
  ): Promise<void> {
    const record = await this.getRecordOrThrow(recordId, orgId);
    const recordRow = record as Record<string, unknown>;
    const existing = await this.client
      .from(GdprService.COMMENTS)
      .select('id, created_by, content')
      .eq('id', commentId)
      .eq('record_id', recordId)
      .eq('organization_id', orgId)
      .single();
    if (existing.error || !existing.data) {
      throw new NotFoundException(`Comment ${commentId} not found`);
    }
    if ((existing.data as Record<string, unknown>)['created_by'] !== userId) {
      throw new ForbiddenException('Only the comment author can delete it');
    }
    const existingRow = existing.data as Record<string, unknown>;
    const { error } = await this.client
      .from(GdprService.COMMENTS)
      .delete()
      .eq('id', commentId)
      .eq('record_id', recordId)
      .eq('organization_id', orgId);
    if (error) {
      throw new BadRequestException(error.message);
    }
    await this.logChange({
      organization_id: orgId,
      spreadsheet_id: recordRow['spreadsheet_id'] as string,
      record_id: recordId,
      changed_by: userId,
      change_type: 'cell_update',
      old_value: {
        comment_deleted: (typeof existingRow['content'] === 'string'
          ? existingRow['content']
          : ''
        ).substring(0, 100),
      },
      metadata: { action: 'comment_deleted', deleted_comment_id: commentId },
    });
    await this.logAuditAction(
      orgId,
      userId,
      'gdpr_comment',
      commentId,
      'delete',
      {
        record_id: recordId,
      },
    );
  }

  // ------------------------------------------------------------------ //
  // Attachments                                                          //
  // ------------------------------------------------------------------ //

  async getAttachments(recordId: string, orgId: string): Promise<unknown[]> {
    await this.getRecordOrThrow(recordId, orgId);
    const { data, error } = await this.client
      .from(GdprService.ATTACHMENTS)
      .select(ATTACHMENT_SELECT)
      .eq('record_id', recordId)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false });
    if (error) {
      throw new BadRequestException(error.message);
    }
    return (data ?? []) as unknown[];
  }

  async uploadAttachment(
    recordId: string,
    orgId: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<unknown> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    const record = await this.getRecordOrThrow(recordId, orgId);
    const recordRow = record as Record<string, unknown>;

    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException(
        `File exceeds the maximum allowed size of ${formatMaxUpload(MAX_FILE_SIZE)}`,
      );
    }
    const sanitized = storageSafeFileName(file.originalname);
    const path = `${orgId}/${recordId}/${Date.now()}-${sanitized}`;

    const { error: uploadErr } = await this.client.storage
      .from(GDPR_BUCKET)
      .upload(path, file.buffer, { contentType: file.mimetype });
    if (uploadErr) {
      throw new BadRequestException(uploadErr.message);
    }

    const ins = await this.client
      .from(GdprService.ATTACHMENTS)
      .insert({
        record_id: recordId,
        organization_id: orgId,
        file_name: file.originalname,
        file_path: path,
        file_size: file.size,
        mime_type: file.mimetype,
        uploaded_by: userId,
      })
      .select(
        '*, uploaded_by_user:users!uploaded_by(id, first_name, last_name, email, avatar_url)',
      )
      .single();
    if (ins.error) {
      // Rollback: remove the uploaded file to avoid orphan in storage
      await this.client.storage.from(GDPR_BUCKET).remove([path]);
      throw new BadRequestException(ins.error.message);
    }
    const attachment = ins.data as Record<string, unknown>;
    await this.logChange({
      organization_id: orgId,
      spreadsheet_id: recordRow['spreadsheet_id'] as string,
      record_id: recordId,
      changed_by: userId,
      change_type: 'cell_update',
      new_value: { attachment_uploaded: file.originalname },
      metadata: {
        action: 'attachment_uploaded',
        attachment_id: attachment['id'],
        file_name: file.originalname,
        file_size: file.size,
        mime_type: file.mimetype,
      },
    });
    await this.logAuditAction(
      orgId,
      userId,
      'gdpr_attachment',
      attachment['id'] as string,
      'create',
      {
        record_id: recordId,
        file_name: file.originalname,
      },
    );
    return ins.data as unknown;
  }

  async getAttachmentSignedUrl(
    recordId: string,
    attachmentId: string,
    orgId: string,
  ): Promise<{ url: string; expiresIn: number }> {
    await this.getRecordOrThrow(recordId, orgId);
    const att = await this.client
      .from(GdprService.ATTACHMENTS)
      .select('file_path')
      .eq('id', attachmentId)
      .eq('record_id', recordId)
      .eq('organization_id', orgId)
      .single();
    if (att.error || !att.data) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }
    const filePath = (att.data as Record<string, unknown>)[
      'file_path'
    ] as string;
    const { data: urlData, error: urlErr } = await this.client.storage
      .from(GDPR_BUCKET)
      .createSignedUrl(filePath, SIGNED_URL_EXPIRY);
    if (urlErr || !urlData?.signedUrl) {
      throw new BadRequestException('Failed to generate signed URL');
    }
    // Return `url` key to match risk-management-app response shape
    return { url: urlData.signedUrl, expiresIn: SIGNED_URL_EXPIRY };
  }

  async deleteAttachment(
    recordId: string,
    attachmentId: string,
    orgId: string,
    userId?: string,
  ): Promise<void> {
    const record = await this.getRecordOrThrow(recordId, orgId);
    const recordRow = record as Record<string, unknown>;
    const att = await this.client
      .from(GdprService.ATTACHMENTS)
      .select('file_path, file_name, file_size, mime_type')
      .eq('id', attachmentId)
      .eq('record_id', recordId)
      .eq('organization_id', orgId)
      .single();
    if (att.error || !att.data) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }
    const filePath = (att.data as Record<string, unknown>)[
      'file_path'
    ] as string;

    const { error } = await this.client
      .from(GdprService.ATTACHMENTS)
      .delete()
      .eq('id', attachmentId)
      .eq('record_id', recordId)
      .eq('organization_id', orgId);
    if (error) {
      throw new BadRequestException(error.message);
    }
    await this.removeStorageObjects([filePath], `attachment ${attachmentId}`);
    if (userId) {
      const attRow = att.data as Record<string, unknown>;
      await this.logChange({
        organization_id: orgId,
        spreadsheet_id: recordRow['spreadsheet_id'] as string,
        record_id: recordId,
        changed_by: userId,
        change_type: 'cell_update',
        old_value: { attachment_deleted: attRow['file_name'] },
        metadata: {
          action: 'attachment_deleted',
          deleted_attachment_id: attachmentId,
          file_name: attRow['file_name'],
          file_size: attRow['file_size'],
          mime_type: attRow['mime_type'],
        },
      });
      await this.logAuditAction(
        orgId,
        userId,
        'gdpr_attachment',
        attachmentId,
        'delete',
        {
          record_id: recordId,
          file_name: attRow['file_name'],
        },
      );
    }
  }

  // ------------------------------------------------------------------ //
  // History                                                              //
  // ------------------------------------------------------------------ //

  async getHistory(recordId: string, orgId: string): Promise<unknown[]> {
    await this.getRecordOrThrow(recordId, orgId);
    const { data, error } = await this.client
      .from(GdprService.CHANGES)
      .select(`*, changed_by_user:users!changed_by(${USER_SELECT})`)
      .eq('record_id', recordId)
      .eq('organization_id', orgId)
      .order('changed_at', { ascending: false });
    if (error) {
      throw new BadRequestException(error.message);
    }
    return (data ?? []) as unknown[];
  }

  // ------------------------------------------------------------------ //
  // Export                                                               //
  // ------------------------------------------------------------------ //

  async exportToCsv(
    orgId: string,
    userId: string,
  ): Promise<{ csvContent: string; filename: string }> {
    const sheet = await this.getOrCreateSpreadsheet(orgId, userId);
    const sheetRow = sheet as Record<string, unknown>;

    const { data, error } = await this.client
      .from(GdprService.RECORDS)
      .select('*')
      .eq('organization_id', orgId)
      .eq('is_archived', false)
      .order('row_order', { ascending: true })
      .limit(10_000);
    if (error) {
      throw new BadRequestException(error.message);
    }

    const records = (data ?? []) as Record<string, unknown>[];
    const configuredColumns = (sheetRow['column_config'] as unknown[]) ?? [];

    // When column_config is empty (default on auto-create), discover columns
    // dynamically from cell_data so the export is never silently empty.
    let headers: string[];
    let columnIds: string[];

    if (configuredColumns.length > 0) {
      headers = configuredColumns.map(
        (c) => (c as Record<string, unknown>)['label'] as string,
      );
      columnIds = configuredColumns.map(
        (c) =>
          ((c as Record<string, unknown>)['columnId'] ??
            (c as Record<string, unknown>)['column_id']) as string,
      );
    } else {
      const keySet = new Set<string>();
      records.forEach((r) => {
        const cellData = (r['cell_data'] as Record<string, unknown>) ?? {};
        Object.keys(cellData).forEach((k) => keySet.add(k));
      });
      columnIds = Array.from(keySet).sort();
      headers = columnIds;
    }

    const escapeCsv = (val: unknown): string => {
      let str: string;
      if (val === null || val === undefined) {
        str = '';
      } else if (typeof val === 'object') {
        str = JSON.stringify(val);
      } else {
        str = String(val as string | number | boolean);
      }
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const rows = [
      headers.map(escapeCsv).join(','),
      ...records.map((r) => {
        const cellData = (r['cell_data'] as Record<string, unknown>) ?? {};
        return columnIds.map((cid) => escapeCsv(cellData[cid])).join(',');
      }),
    ];

    const filename = `gdpr-export-${new Date().toISOString().slice(0, 10)}.csv`;
    return { csvContent: rows.join('\n'), filename };
  }

  // ------------------------------------------------------------------ //
  // Private helpers                                                      //
  // ------------------------------------------------------------------ //

  private async getRecordOrThrow(id: string, orgId: string): Promise<unknown> {
    const r = await this.client
      .from(GdprService.RECORDS)
      .select(RECORD_SELECT)
      .eq('id', id)
      .eq('organization_id', orgId)
      .single();
    if (r.error || !r.data) {
      throw new NotFoundException(`Record ${id} not found`);
    }
    return r.data as unknown;
  }

  private async getSpreadsheetOrThrow(orgId: string): Promise<unknown> {
    const r = await this.client
      .from(GdprService.SPREADSHEETS)
      .select('*')
      .eq('organization_id', orgId)
      .single();

    if (r.error || !r.data) {
      throw new NotFoundException(
        `GDPR spreadsheet not found for org ${orgId}`,
      );
    }
    return r.data as unknown;
  }

  private async queryRecords(
    orgId: string,
    filters: ListRecordsQueryDto,
    paginated: boolean,
  ): Promise<{
    data: unknown[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, parseInt(filters.page ?? '1', 10) || 1);
    const pageSize = Math.min(
      200,
      Math.max(
        1,
        parseInt(filters.pageSize ?? filters.page_size ?? '50', 10) || 50,
      ),
    );
    const offset = (page - 1) * pageSize;

    let q = this.client
      .from(GdprService.RECORDS)
      .select(RECORD_SELECT, { count: 'exact' })
      .eq('organization_id', orgId)
      .order('row_order', { ascending: true });

    if (filters.spreadsheet_id) {
      q = q.eq('spreadsheet_id', filters.spreadsheet_id);
    }
    if (filters.is_archived !== undefined) {
      q = q.eq('is_archived', filters.is_archived === 'true');
    }
    if (filters.assignee_id) {
      q = q.eq('assignee_id', filters.assignee_id);
    }
    if (filters.search) {
      const safe = filters.search.replace(/[%_]/g, '').trim();

      if (safe.length > 0) {
        q = q.ilike('cell_data::text', `%${safe}%`);
      }
    }

    const columnFilters = this.parseColumnFilters(filters.column_filters);
    Object.entries(columnFilters).forEach(([columnId, value]) => {
      q = q.eq(`cell_data->>${columnId}`, String(value));
    });

    if (paginated) {
      q = q.range(offset, offset + pageSize - 1);
    }

    const { data, error, count } = await q;
    if (error) {
      throw new BadRequestException(error.message);
    }

    return {
      data: (data ?? []) as unknown[],
      total: count ?? (data ?? []).length,
      page,
      pageSize,
    };
  }

  private parseColumnFilters(value?: string): Record<string, unknown> {
    if (!value) return {};
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private async removeStorageObjects(
    paths: string[],
    label: string,
  ): Promise<void> {
    if (paths.length === 0) return;

    const { error } = await this.client.storage.from(GDPR_BUCKET).remove(paths);
    if (error) {
      this.logger.error(
        `GDPR storage cleanup failed for ${label}: ${error.message}`,
      );
    }
  }

  private normalizeColumnInput(
    dto: AddColumnDto,
    fallbackOrder: number,
  ): Record<string, unknown> {
    const source = (dto.column ?? dto) as Record<string, unknown>;
    const columnId = source['columnId'];
    const label = source['label'];

    if (typeof columnId !== 'string' || !columnId.trim()) {
      throw new BadRequestException('Column ID is required');
    }
    if (typeof label !== 'string' || !label.trim()) {
      throw new BadRequestException('Column label is required');
    }

    return {
      columnId: columnId.trim(),
      label: label.trim(),
      width: typeof source['width'] === 'number' ? source['width'] : 150,
      cellType:
        typeof source['cellType'] === 'string' ? source['cellType'] : 'text',
      order:
        typeof source['order'] === 'number' ? source['order'] : fallbackOrder,
      required: source['required'] === true,
      resizable: source['resizable'] !== false,
      reorderable: source['reorderable'] !== false,
      dropdownOptions: Array.isArray(source['dropdownOptions'])
        ? source['dropdownOptions']
        : undefined,
      validation:
        source['validation'] && typeof source['validation'] === 'object'
          ? source['validation']
          : undefined,
    };
  }

  private getDefaultColumns(): Array<Record<string, unknown>> {
    return [
      {
        columnId: 'service',
        label: 'Service',
        width: 150,
        cellType: 'text',
        order: 0,
        required: true,
        resizable: true,
        reorderable: true,
      },
      {
        columnId: 'hostname',
        label: 'Hostname',
        width: 150,
        cellType: 'text',
        order: 1,
        required: false,
        resizable: true,
        reorderable: true,
      },
      {
        columnId: 'processing_type',
        label: 'Verarbeitungstyp',
        width: 150,
        cellType: 'dropdown',
        order: 2,
        required: false,
        resizable: true,
        reorderable: true,
        dropdownOptions: ['Speicherung', 'Verarbeitung'],
      },
      {
        columnId: 'data_category',
        label: 'Datenkategorie/Datentyp',
        width: 200,
        cellType: 'text',
        order: 3,
        required: false,
        resizable: true,
        reorderable: true,
      },
      {
        columnId: 'description',
        label: 'Beschreibung',
        width: 250,
        cellType: 'text',
        order: 4,
        required: false,
        resizable: true,
        reorderable: true,
      },
      {
        columnId: 'purpose',
        label: 'Zweck/Grund der Verarbeitung/Speicherung',
        width: 250,
        cellType: 'text',
        order: 5,
        required: false,
        resizable: true,
        reorderable: true,
      },
      {
        columnId: 'retention_period',
        label: 'Vorhaltezeit Ausmaß',
        width: 150,
        cellType: 'text',
        order: 6,
        required: false,
        resizable: true,
        reorderable: true,
      },
      {
        columnId: 'retention_reason',
        label: 'Vorhaltezeit Grund',
        width: 200,
        cellType: 'text',
        order: 7,
        required: false,
        resizable: true,
        reorderable: true,
      },
    ];
  }

  private async logAuditAction(
    orgId: string,
    userId: string,
    entityType: string,
    entityId: string | null | undefined,
    action: 'create' | 'update' | 'delete' | 'archive' | 'restore',
    changes?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.auditLogs) return;

    await this.auditLogs.createLog(orgId, userId, {
      entity_type: entityType,
      ...(entityId ? { entity_id: entityId } : {}),
      action,
      changes,
    });
  }

  /**
   * Log a structural change to gdpr_record_changes.
   * Field names match the DB schema exactly.
   */
  private async logChange(payload: {
    organization_id: string;
    spreadsheet_id: string;
    record_id: string;
    changed_by: string;
    change_type: string;
    old_value?: unknown;
    new_value?: unknown;
    column_id?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const { error } = await this.client.from(GdprService.CHANGES).insert({
      ...payload,
      changed_at: new Date().toISOString(),
    });
    if (error) {
      this.logger.warn(`GDPR audit write failed: ${error.message}`);
    }
  }
}
