import { Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

const CHANGES_TABLE = 'asset_item_changes';

// Must match the DB CHECK constraint on asset_item_changes.change_type
export type AssetChangeType =
  | 'cell_update'
  | 'row_create'
  | 'row_delete'
  | 'row_archive'
  | 'row_restore'
  | 'row_reorder'
  | 'bulk_update'
  | 'column_add'
  | 'column_remove'
  | 'column_rename'
  | 'column_reorder'
  | 'title_update'
  | 'description_update';

@Injectable()
export class AssetsHistoryService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async logChange(
    itemId: string,
    schemaId: string,
    organizationId: string,
    changeType: AssetChangeType,
    changedBy: string,
    payload?: {
      columnId?: string;
      oldValue?: unknown;
      newValue?: unknown;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.client.from(CHANGES_TABLE).insert({
      item_id: itemId,
      schema_id: schemaId,
      organization_id: organizationId,
      change_type: changeType,
      column_id: payload?.columnId ?? null,
      old_value: payload?.oldValue ?? null,
      new_value: payload?.newValue ?? null,
      metadata: payload?.metadata ?? null,
      changed_by: changedBy,
    });
  }
}
