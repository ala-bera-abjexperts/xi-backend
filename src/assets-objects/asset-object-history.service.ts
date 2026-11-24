import { Injectable } from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';

const TABLE = 'asset_object_changes';

// Must match the DB CHECK constraint on asset_object_changes.change_type exactly
export type AssetObjectChangeType =
  | 'object_create'
  | 'object_update'
  | 'object_delete'
  | 'object_archive'
  | 'object_restore'
  | 'attribute_update'
  | 'reference_added'
  | 'reference_removed'
  | 'comment_added'
  | 'comment_updated'
  | 'comment_deleted'
  | 'attachment_added'
  | 'attachment_deleted'
  | 'type_create'
  | 'type_update'
  | 'type_delete'
  | 'type_move'
  | 'attr_def_create'
  | 'attr_def_update'
  | 'attr_def_delete'
  | 'task_link_added'
  | 'task_link_removed';

@Injectable()
export class AssetObjectHistoryService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Log a single change event to the asset_object_changes table.
   * Pass objectId = null for schema-level events (type_*, attr_def_*) where no object is involved.
   * This method never throws — history failure must never fail the main operation.
   */
  async logChange(
    objectId: string | null,
    schemaId: string,
    organizationId: string,
    spaceId: string,
    changeType: AssetObjectChangeType,
    changedBy: string,
    payload?: {
      attributeKey?: string;
      oldValue?: unknown;
      newValue?: unknown;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.client.from(TABLE).insert({
      object_id: objectId ?? null,
      schema_id: schemaId,
      organization_id: organizationId,
      space_id: spaceId,
      change_type: changeType,
      attribute_key: payload?.attributeKey ?? null,
      old_value: payload?.oldValue ?? null,
      new_value: payload?.newValue ?? null,
      metadata: payload?.metadata ?? {},
      changed_by: changedBy,
    });
  }

  async getHistory(
    objectId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(
        '*, changed_by_user:users!asset_object_changes_changed_by_fkey(id,first_name,last_name,email,avatar_url)',
      )
      .eq('object_id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('changed_at', { ascending: false });

    if (error) return [];

    return (data ?? []) as Record<string, unknown>[];
  }
}
