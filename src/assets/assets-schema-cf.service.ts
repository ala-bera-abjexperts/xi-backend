import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { AssignCustomFieldDto } from './dto/assign-custom-field.dto';
import type { UpdateCustomFieldAssignmentDto } from './dto/update-custom-field-assignment.dto';
import type { ReorderCustomFieldsDto } from './dto/reorder-custom-fields.dto';
import type { SyncCustomFieldsDto } from './dto/sync-custom-fields.dto';

const TABLE = 'asset_schema_custom_fields';

@Injectable()
export class AssetsSchemaCfService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getAll(
    schemaId: string,
    orgId: string,
  ): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('schema_id', schemaId)
      .eq('organization_id', orgId)
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as Record<string, unknown>[];
  }

  async assign(
    schemaId: string,
    organizationId: string,
    userId: string,
    dto: AssignCustomFieldDto,
  ): Promise<Record<string, unknown>> {
    // Check duplicate
    const { data: dup } = await this.client
      .from(TABLE)
      .select('id')
      .eq('schema_id', schemaId)
      .eq('custom_field_id', dto.custom_field_id)
      .maybeSingle();

    if (dup)
      throw new BadRequestException(
        'Custom field already assigned to this schema',
      );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        schema_id: schemaId,
        organization_id: organizationId,
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

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to assign custom field',
      );
    return data as Record<string, unknown>;
  }

  async updateAssignment(
    assignmentId: string,
    schemaId: string,
    organizationId: string,
    userId: string,
    dto: UpdateCustomFieldAssignmentDto,
  ): Promise<Record<string, unknown>> {
    const { data: existing } = await this.client
      .from(TABLE)
      .select('id')
      .eq('id', assignmentId)
      .eq('schema_id', schemaId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!existing)
      throw new NotFoundException('Custom field assignment not found');

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

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', assignmentId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to update assignment',
      );
    return data as Record<string, unknown>;
  }

  async removeAssignment(
    assignmentId: string,
    schemaId: string,
    organizationId: string,
  ): Promise<{ success: true }> {
    const { data: existing } = await this.client
      .from(TABLE)
      .select('id')
      .eq('id', assignmentId)
      .eq('schema_id', schemaId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!existing)
      throw new NotFoundException('Custom field assignment not found');

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', assignmentId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
    return { success: true };
  }

  async reorder(
    schemaId: string,
    organizationId: string,
    dto: ReorderCustomFieldsDto,
  ): Promise<{ success: true }> {
    for (const o of dto.field_orders) {
      const { error } = await this.client
        .from(TABLE)
        .update({
          sort_order: o.sort_order,
          updated_at: new Date().toISOString(),
        })
        .eq('id', o.assignment_id)
        .eq('schema_id', schemaId)
        .eq('organization_id', organizationId);

      if (error) throw new BadRequestException(error.message);
    }
    return { success: true };
  }

  async sync(
    schemaId: string,
    organizationId: string,
    userId: string,
    dto: SyncCustomFieldsDto,
  ): Promise<Record<string, unknown>[]> {
    // Delete all then insert — not atomic (no Supabase RPC transaction here).
    // If insert fails, assignments will be empty until re-synced.
    await this.client
      .from(TABLE)
      .delete()
      .eq('schema_id', schemaId)
      .eq('organization_id', organizationId);

    if (dto.custom_field_ids.length === 0) return [];

    const rows = dto.custom_field_ids.map((fieldId, idx) => ({
      schema_id: schemaId,
      organization_id: organizationId,
      custom_field_id: fieldId,
      sort_order: idx,
      is_required: false,
      is_hidden: false,
      column_span: 1,
      created_by: userId,
      updated_by: userId,
    }));

    const { data, error } = await this.client.from(TABLE).insert(rows).select();

    if (error) {
      throw new BadRequestException(
        `Failed to sync custom fields (existing assignments were cleared): ${error.message}`,
      );
    }
    return (data ?? []) as Record<string, unknown>[];
  }
}
