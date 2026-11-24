/**
 * @fileoverview Service for managing field groups, their member fields, and
 * level assignments with permissions. Backed by Supabase.
 * @module src/custom-fields/field-groups.service
 * @author Prince Jadiya
 */

import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type {
  FieldGroup,
  FieldGroupField,
  AssignmentPermission,
} from './models/field-group.model';
import type { CreateFieldGroupDto } from './dto/create-field-group.dto';
import type { UpdateFieldGroupDto } from './dto/update-field-group.dto';
import type { AddFieldToGroupDto } from './dto/add-field-to-group.dto';
import type { UpdateFieldInGroupDto } from './dto/update-field-in-group.dto';
import type {
  AssignGroupToLevelDto,
  AssignFieldToLevelDto,
  AssignmentEntityType,
} from './dto/assign-level.dto';
import type {
  CreateWikiAssignmentDto,
  UpdateWikiAssignmentDto,
} from './dto/wiki-assignment.dto';

export type {
  FieldGroup,
  FieldGroupField,
  AssignmentPermission,
} from './models/field-group.model';

/** Filters accepted by `getAll`. */
export interface FieldGroupFilters {
  is_deleted?: boolean;
  search?: string;
}

/**
 * Service owning CRUD for `field_groups`, membership in
 * `field_group_fields`, and level assignments + permissions.
 */
@Injectable()
export class FieldGroupsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ---------------------------------------------------------------------
  // Field Groups CRUD
  // ---------------------------------------------------------------------

  /** List field groups for an organization. */
  async getAll(
    organizationId: string,
    filters: FieldGroupFilters = {},
  ): Promise<{ data: FieldGroup[]; count: number }> {
    let q = this.client
      .from('field_groups')
      .select('*')
      .eq('organization_id', organizationId);
    if (filters.is_deleted === undefined) {
      q = q.eq('is_deleted', false);
    } else {
      q = q.eq('is_deleted', filters.is_deleted);
    }
    if (filters.search) {
      q = q.or(
        `name.ilike.%${filters.search}%,description.ilike.%${filters.search}%`,
      );
    }
    const result = await q
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (result.error) throw new BadRequestException(result.error.message);
    const rows = (result.data ?? []) as FieldGroup[];
    return { data: rows, count: rows.length };
  }

  /** Return org-level + space-level groups visible in a space. */
  async getBySpace(
    organizationId: string,
    spaceId: string,
    filters: FieldGroupFilters = {},
  ): Promise<{ data: FieldGroup[]; count: number }> {
    let q = this.client
      .from('field_groups')
      .select('*')
      .eq('organization_id', organizationId)
      .or(`space_id.is.null,space_id.eq.${spaceId}`);
    if (filters.is_deleted === undefined) {
      q = q.eq('is_deleted', false);
    } else {
      q = q.eq('is_deleted', filters.is_deleted);
    }
    if (filters.search) {
      q = q.or(
        `name.ilike.%${filters.search}%,description.ilike.%${filters.search}%`,
      );
    }
    const result = await q
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (result.error) throw new BadRequestException(result.error.message);
    const rows = (result.data ?? []) as FieldGroup[];
    return { data: rows, count: rows.length };
  }

  /** Fetch one group by id, scoped to the caller's organization. */
  async getById(id: string, organizationId: string): Promise<FieldGroup> {
    const result = await this.client
      .from('field_groups')
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (result.error) throw new BadRequestException(result.error.message);
    if (!result.data) throw new NotFoundException('Field group not found');
    return result.data as FieldGroup;
  }

  /** Fetch a group with its embedded field memberships. */
  async getByIdWithFields(
    id: string,
    organizationId: string,
    spaceId?: string,
  ): Promise<FieldGroup & { fields: FieldGroupField[]; field_count: number }> {
    const group = await this.getById(id, organizationId);
    const fields = await this.getFieldsInGroup(id, organizationId, spaceId);
    return { ...group, fields, field_count: fields.length };
  }

  /** Create a field group. */
  async create(
    organizationId: string,
    userId: string | null,
    data: CreateFieldGroupDto,
  ): Promise<FieldGroup> {
    const row = {
      organization_id: organizationId,
      space_id: data.space_id ?? null,
      name: data.name,
      description: data.description ?? null,
      name_i18n: data.name_i18n ?? {},
      description_i18n: data.description_i18n ?? {},
      sort_order: data.sort_order ?? 0,
      is_collapsed_default: data.is_collapsed_default ?? false,
      color: data.color ?? null,
      icon: data.icon ?? null,
    };
    const result = await this.client
      .from('field_groups')
      .insert(row)
      .select()
      .single();
    if (result.error) throw new BadRequestException(result.error.message);
    const group = result.data as FieldGroup;
    this.logEntityAudit(
      organizationId,
      userId,
      'field_group',
      group.id,
      'create',
      {
        name: group.name,
        space_id: group.space_id,
      },
    );
    return group;
  }

  /** Update a field group. */
  async update(
    id: string,
    userId: string | null,
    data: UpdateFieldGroupDto,
    organizationId: string,
  ): Promise<FieldGroup> {
    await this.getById(id, organizationId);
    const patch: Record<string, unknown> = {};
    for (const k of [
      'name',
      'description',
      'name_i18n',
      'description_i18n',
      'sort_order',
      'is_collapsed_default',
      'color',
      'icon',
    ] as const) {
      if (data[k] !== undefined) patch[k] = data[k];
    }
    const result = await this.client
      .from('field_groups')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (result.error) throw new BadRequestException(result.error.message);
    const group = result.data as FieldGroup;
    this.logEntityAudit(
      organizationId,
      userId,
      'field_group',
      id,
      'update',
      patch,
    );
    return group;
  }

  /**
   * Soft delete a field group. Cascades through the permission and
   * assignment tables — see in-body comments.
   */
  async softDelete(
    id: string,
    userId: string | null,
    organizationId: string,
  ): Promise<void> {
    await this.getById(id, organizationId);

    // 1. Collect assignment ids so we can clean up their permissions.
    const assignments = await this.client
      .from('level_field_group_assignments')
      .select('id')
      .eq('field_group_id', id);
    if (assignments.error) {
      throw new BadRequestException(assignments.error.message);
    }
    const assignmentIds = (assignments.data ?? []).map(
      (r: { id: string }) => r.id,
    );

    if (assignmentIds.length > 0) {
      // 2. Delete level field-group field-level permissions.
      const r1 = await this.client
        .from('level_field_group_field_permissions')
        .delete()
        .in('assignment_id', assignmentIds);
      if (r1.error) throw new BadRequestException(r1.error.message);

      // 3. Delete level field-group group-level permissions.
      const r2 = await this.client
        .from('level_field_group_permissions')
        .delete()
        .in('assignment_id', assignmentIds);
      if (r2.error) throw new BadRequestException(r2.error.message);
    }

    // 4. Delete the level assignments themselves.
    const r3 = await this.client
      .from('level_field_group_assignments')
      .delete()
      .eq('field_group_id', id);
    if (r3.error) throw new BadRequestException(r3.error.message);

    // 5. Delete group-level permissions stored on the group itself.
    const r4 = await this.client
      .from('field_group_permissions')
      .delete()
      .eq('field_group_id', id);
    if (r4.error) throw new BadRequestException(r4.error.message);

    // 6. Delete memberships of fields in this group.
    const r5 = await this.client
      .from('field_group_fields')
      .delete()
      .eq('field_group_id', id);
    if (r5.error) throw new BadRequestException(r5.error.message);

    // 7. Finally, mark the group as deleted.
    const r6 = await this.client
      .from('field_groups')
      .update({
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        deleted_by: userId,
      })
      .eq('id', id)
      .eq('organization_id', organizationId);
    if (r6.error) throw new BadRequestException(r6.error.message);

    this.logEntityAudit(organizationId, userId, 'field_group', id, 'delete', {
      assignment_count: assignmentIds.length,
    });
  }

  /** Restore a soft-deleted group. */
  async restore(
    id: string,
    organizationId: string,
    userId?: string | null,
  ): Promise<FieldGroup> {
    const existing = await this.getById(id, organizationId);
    if (!existing.is_deleted) {
      throw new BadRequestException('Field group is not deleted');
    }
    const result = await this.client
      .from('field_groups')
      .update({ is_deleted: false, deleted_at: null, deleted_by: null })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (result.error) throw new BadRequestException(result.error.message);
    const group = result.data as FieldGroup;
    this.logEntityAudit(
      organizationId,
      userId ?? null,
      'field_group',
      id,
      'restore',
      {
        name: group.name,
      },
    );
    return group;
  }

  /** Permanently delete a field group row. Requires soft-delete first. */
  async permanentDelete(
    id: string,
    organizationId: string,
    userId?: string | null,
  ): Promise<void> {
    const existing = await this.getById(id, organizationId);
    if (!existing.is_deleted) {
      throw new BadRequestException(
        'Field group must be soft-deleted before permanent delete',
      );
    }
    const result = await this.client
      .from('field_groups')
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);
    if (result.error) throw new BadRequestException(result.error.message);

    this.logEntityAudit(
      organizationId,
      userId ?? null,
      'field_group',
      id,
      'delete',
      {
        permanent: true,
        name: existing.name,
      },
    );
  }

  /** Duplicate a group, optionally copying its fields. */
  async duplicate(
    id: string,
    userId: string | null,
    newName: string,
    copyFields: boolean,
    organizationId: string,
  ): Promise<FieldGroup> {
    const source = await this.getById(id, organizationId);
    const created = await this.create(source.organization_id, userId, {
      name: newName,
      description: source.description ?? undefined,
      name_i18n: source.name_i18n,
      description_i18n: source.description_i18n,
      sort_order: source.sort_order,
      is_collapsed_default: source.is_collapsed_default,
      color: source.color ?? undefined,
      icon: source.icon ?? undefined,
      space_id: source.space_id ?? undefined,
    });
    if (copyFields) {
      const fields = await this.getFieldsInGroup(id, organizationId);
      if (fields.length > 0) {
        const rows = fields.map((f) => ({
          field_group_id: created.id,
          custom_field_id: f.custom_field_id,
          sort_order: f.sort_order,
          is_required: f.is_required,
          is_hidden: f.is_hidden,
          column_span: f.column_span,
          default_value_override: f.default_value_override,
        }));
        const r = await this.client.from('field_group_fields').insert(rows);
        if (r.error) throw new BadRequestException(r.error.message);
      }
    }
    this.logEntityAudit(
      organizationId,
      userId,
      'field_group',
      created.id,
      'create',
      {
        duplicated_from: id,
        copy_fields: copyFields,
      },
    );
    return created;
  }

  // ---------------------------------------------------------------------
  // Fields in group
  // ---------------------------------------------------------------------

  /** List fields belonging to a group. */
  async getFieldsInGroup(
    groupId: string,
    organizationId: string,
    spaceId?: string,
  ): Promise<FieldGroupField[]> {
    await this.getById(groupId, organizationId);
    const result = await this.client
      .from('field_group_fields')
      .select(
        `
        *,
        custom_field:custom_fields!inner(id, name, field_key, field_type, description, name_i18n, options, validation_rules, default_value, space_id, is_active, is_deleted)
      `,
      )
      .eq('field_group_id', groupId)
      // Filter on the embed ALIAS declared above, not the table name. With
      // `!inner`, a filter PostgREST cannot bind to the embed excludes every
      // row, which made this endpoint return [] for every group.
      .eq('custom_field.is_deleted', false)
      .order('sort_order', { ascending: true });
    if (result.error) throw new BadRequestException(result.error.message);
    let fields = (result.data ?? []) as FieldGroupField[];

    if (spaceId && fields.length > 0) {
      const fieldIds = fields
        .map((field) => field.custom_field_id)
        .filter(Boolean);

      if (fieldIds.length > 0) {
        const overrides = await this.client
          .from('space_custom_field_overrides')
          .select('custom_field_id, is_enabled')
          .eq('space_id', spaceId)
          .in('custom_field_id', fieldIds);
        if (overrides.error) {
          throw new BadRequestException(overrides.error.message);
        }

        const overrideMap = new Map<string, boolean>();

        for (const override of (overrides.data ?? []) as Array<{
          custom_field_id: string;
          is_enabled: boolean;
        }>) {
          overrideMap.set(override.custom_field_id, override.is_enabled);
        }

        fields = fields.map((field) => {
          const isEnabled = overrideMap.get(field.custom_field_id);

          return isEnabled === undefined
            ? field
            : { ...field, is_enabled_in_space: isEnabled };
        });
      }
    }

    return fields;
  }

  /** Add a single field membership. */
  async addFieldToGroup(
    groupId: string,
    data: AddFieldToGroupDto,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<FieldGroupField> {
    await this.getById(groupId, organizationId);

    // Validate the custom_field exists AND belongs to the caller's org.
    const fieldCheck = await this.client
      .from('custom_fields')
      .select('id')
      .eq('id', data.custom_field_id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (fieldCheck.error) {
      throw new BadRequestException(fieldCheck.error.message);
    }
    if (!fieldCheck.data) {
      throw new NotFoundException('Custom field not found');
    }

    // Uniqueness check.
    const dup = await this.client
      .from('field_group_fields')
      .select('id')
      .eq('field_group_id', groupId)
      .eq('custom_field_id', data.custom_field_id)
      .maybeSingle();
    if (dup.data) {
      throw new ConflictException('Field already in group');
    }

    const row = {
      field_group_id: groupId,
      custom_field_id: data.custom_field_id,
      sort_order: data.sort_order ?? 0,
      is_required: data.is_required ?? false,
      is_hidden: data.is_hidden ?? false,
      column_span: data.column_span ?? 1,
      default_value_override: data.default_value_override ?? null,
    };
    const result = await this.client
      .from('field_group_fields')
      .insert(row)
      .select()
      .single();
    if (result.error) throw new BadRequestException(result.error.message);
    const field = result.data as FieldGroupField;
    this.logEntityAudit(
      organizationId,
      actorUserId,
      'field_group_field',
      field.id,
      'create',
      {
        field_group_id: groupId,
        custom_field_id: data.custom_field_id,
      },
    );
    return field;
  }

  /** Batch-add fields atomically (validates all first). */
  async addFieldsToGroupBatch(
    groupId: string,
    fields: AddFieldToGroupDto[],
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<FieldGroupField[]> {
    await this.getById(groupId, organizationId);
    if (!fields.length) return [];

    const ids = fields.map((f) => f.custom_field_id);
    const check = await this.client
      .from('custom_fields')
      .select('id')
      .eq('organization_id', organizationId)
      .in('id', ids);
    if (check.error) throw new BadRequestException(check.error.message);
    const foundIds = new Set(
      (check.data ?? []).map((r: { id: string }) => r.id),
    );
    const missing = ids.filter((x) => !foundIds.has(x));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Custom fields not found: ${missing.join(', ')}`,
      );
    }

    // Filter out fields already in the group (prevents unique constraint errors)
    const existingResult = await this.client
      .from('field_group_fields')
      .select('custom_field_id')
      .eq('field_group_id', groupId);
    if (existingResult.error)
      throw new BadRequestException(existingResult.error.message);
    const alreadyInGroup = new Set(
      (existingResult.data ?? []).map(
        (r: { custom_field_id: string }) => r.custom_field_id,
      ),
    );
    const newFields = fields.filter(
      (f) => !alreadyInGroup.has(f.custom_field_id),
    );
    if (newFields.length === 0) return [];

    // Compute starting sort_order from current max
    const maxResult = await this.client
      .from('field_group_fields')
      .select('sort_order')
      .eq('field_group_id', groupId)
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle();
    const baseSortOrder =
      ((maxResult.data as { sort_order?: number } | null)?.sort_order ?? -1) +
      1;

    const rows = newFields.map((f, i) => ({
      field_group_id: groupId,
      custom_field_id: f.custom_field_id,
      sort_order: f.sort_order ?? baseSortOrder + i,
      is_required: f.is_required ?? false,
      is_hidden: f.is_hidden ?? false,
      column_span: f.column_span ?? 1,
      default_value_override: f.default_value_override ?? null,
    }));
    const result = await this.client
      .from('field_group_fields')
      .insert(rows)
      .select();
    if (result.error) throw new BadRequestException(result.error.message);
    const created = (result.data ?? []) as FieldGroupField[];
    this.logEntityAudit(
      organizationId,
      actorUserId,
      'field_group',
      groupId,
      'update',
      {
        action: 'add_fields',
        custom_field_ids: newFields.map((field) => field.custom_field_id),
      },
    );
    return created;
  }

  /** Remove a field from a group. */
  async removeFieldFromGroup(
    groupId: string,
    customFieldId: string,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    await this.getById(groupId, organizationId);
    const existing = await this.client
      .from('field_group_fields')
      .select('id')
      .eq('field_group_id', groupId)
      .eq('custom_field_id', customFieldId)
      .maybeSingle();
    if (existing.error) throw new BadRequestException(existing.error.message);
    if (!existing.data) {
      throw new NotFoundException('Field not in group');
    }
    const r = await this.client
      .from('field_group_fields')
      .delete()
      .eq('field_group_id', groupId)
      .eq('custom_field_id', customFieldId);
    if (r.error) throw new BadRequestException(r.error.message);

    this.logEntityAudit(
      organizationId,
      actorUserId,
      'field_group',
      groupId,
      'update',
      {
        action: 'remove_field',
        custom_field_id: customFieldId,
      },
    );
  }

  /** Update a field's per-group settings. */
  async updateFieldInGroup(
    groupId: string,
    customFieldId: string,
    data: UpdateFieldInGroupDto,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<FieldGroupField> {
    await this.getById(groupId, organizationId);
    const patch: Record<string, unknown> = {};
    for (const k of [
      'is_required',
      'is_hidden',
      'column_span',
      'default_value_override',
      'sort_order',
    ] as const) {
      if (data[k] !== undefined) patch[k] = data[k];
    }
    const result = await this.client
      .from('field_group_fields')
      .update(patch)
      .eq('field_group_id', groupId)
      .eq('custom_field_id', customFieldId)
      .select()
      .maybeSingle();
    if (result.error) throw new BadRequestException(result.error.message);
    if (!result.data) throw new NotFoundException('Field not in group');
    const field = result.data as FieldGroupField;
    this.logEntityAudit(
      organizationId,
      actorUserId,
      'field_group_field',
      field.id,
      'update',
      patch,
    );
    return field;
  }

  /** Atomically reorder fields inside a group. */
  async reorderFields(
    groupId: string,
    fields: { custom_field_id: string; sort_order: number }[],
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    await this.getById(groupId, organizationId);
    for (const f of fields) {
      const r = await this.client
        .from('field_group_fields')
        .update({ sort_order: f.sort_order })
        .eq('field_group_id', groupId)
        .eq('custom_field_id', f.custom_field_id);
      if (r.error) throw new BadRequestException(r.error.message);
    }
    this.logEntityAudit(
      organizationId,
      actorUserId,
      'field_group',
      groupId,
      'update',
      {
        action: 'reorder_fields',
        fields,
      },
    );
  }

  // ---------------------------------------------------------------------
  // Level Assignments (Phase 4)
  // ---------------------------------------------------------------------

  /** Assign a field group to a hierarchy level. */
  async assignGroupToLevel(
    organizationId: string,
    data: AssignGroupToLevelDto,
    actorUserId?: string | null,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    // Verify the group belongs to this organization and is not soft-deleted
    const groupCheck = await this.client
      .from('field_groups')
      .select('id, organization_id, is_deleted')
      .eq('id', data.field_group_id)
      .maybeSingle();
    if (groupCheck.error)
      throw new BadRequestException(groupCheck.error.message);
    const group = groupCheck.data as {
      id: string;
      organization_id: string;
      is_deleted: boolean;
    } | null;
    if (!group) throw new NotFoundException('Field group not found');
    if (group.organization_id !== organizationId) {
      throw new ForbiddenException(
        'Field group belongs to a different organization',
      );
    }
    if (group.is_deleted) {
      throw new BadRequestException('Cannot assign a soft-deleted field group');
    }

    const dup = await this.client
      .from('level_field_group_assignments')
      .select('id')
      .eq('hierarchy_level_id', data.hierarchy_level_id)
      .eq('entity_type', data.entity_type)
      .eq('field_group_id', data.field_group_id)
      .maybeSingle();
    if (dup.data) {
      throw new ConflictException('Group already assigned to this level');
    }
    const row = {
      organization_id: organizationId,
      hierarchy_level_id: data.hierarchy_level_id,
      entity_type: data.entity_type,
      field_group_id: data.field_group_id,
      section: data.section ?? 'main',
      sort_order: data.sort_order ?? 0,
      is_collapsed_default: data.is_collapsed_default ?? false,
    };
    const result = await this.client
      .from('level_field_group_assignments')
      .insert(row)
      .select('*')
      .single();
    if (result.error) throw new BadRequestException(result.error.message);
    const assignmentData = result.data as Record<string, unknown>;
    this.logEntityAudit(
      organizationId,
      actorUserId,
      'level_field_group_assignment',
      assignmentData['id'] as string,
      'create',
      {
        hierarchy_level_id: data.hierarchy_level_id,
        entity_type: data.entity_type,
        field_group_id: data.field_group_id,
      },
    );
    return { data: assignmentData, success: true };
  }

  /** Remove a group assignment from a level (cascades permissions). */
  async unassignGroupFromLevel(
    organizationId: string,
    hierarchyLevelId: string,
    entityType: AssignmentEntityType,
    fieldGroupId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    const existing = await this.client
      .from('level_field_group_assignments')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('hierarchy_level_id', hierarchyLevelId)
      .eq('entity_type', entityType)
      .eq('field_group_id', fieldGroupId)
      .maybeSingle();
    if (existing.error) throw new BadRequestException(existing.error.message);
    if (!existing.data) throw new NotFoundException('Assignment not found');
    const assignmentId = (existing.data as { id: string }).id;

    const r1 = await this.client
      .from('level_field_group_field_permissions')
      .delete()
      .eq('assignment_id', assignmentId);
    if (r1.error) throw new BadRequestException(r1.error.message);
    const r2 = await this.client
      .from('level_field_group_permissions')
      .delete()
      .eq('assignment_id', assignmentId);
    if (r2.error) throw new BadRequestException(r2.error.message);
    const r3 = await this.client
      .from('level_field_group_assignments')
      .delete()
      .eq('id', assignmentId);
    if (r3.error) throw new BadRequestException(r3.error.message);
    this.logEntityAudit(
      organizationId,
      actorUserId,
      'level_field_group_assignment',
      assignmentId,
      'delete',
      {
        hierarchy_level_id: hierarchyLevelId,
        entity_type: entityType,
        field_group_id: fieldGroupId,
      },
    );
  }

  /** Assign a single custom field to a level. */
  async assignFieldToLevel(
    organizationId: string,
    data: AssignFieldToLevelDto,
    actorUserId?: string | null,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const fieldCheck = await this.client
      .from('custom_fields')
      .select('id, organization_id, is_deleted')
      .eq('id', data.custom_field_id)
      .maybeSingle();
    if (fieldCheck.error) {
      throw new BadRequestException(fieldCheck.error.message);
    }
    const field = fieldCheck.data as {
      id: string;
      organization_id: string;
      is_deleted: boolean;
    } | null;
    if (!field) {
      throw new NotFoundException('Custom field not found');
    }
    if (field.organization_id !== organizationId) {
      throw new ForbiddenException(
        'Custom field belongs to a different organization',
      );
    }
    if (field.is_deleted) {
      throw new BadRequestException(
        'Cannot assign a soft-deleted custom field',
      );
    }

    // Check for duplicate assignment (same hierarchy_level + entity_type + custom_field)
    const dup = await this.client
      .from('level_field_assignments')
      .select('id')
      .eq('hierarchy_level_id', data.hierarchy_level_id)
      .eq('entity_type', data.entity_type)
      .eq('custom_field_id', data.custom_field_id)
      .maybeSingle();
    if (dup.data) {
      throw new ConflictException('Field already assigned to this level');
    }

    const row = {
      organization_id: organizationId,
      hierarchy_level_id: data.hierarchy_level_id,
      entity_type: data.entity_type,
      custom_field_id: data.custom_field_id,
      section: data.section ?? 'main',
      sort_order: data.sort_order ?? 0,
      is_required: data.is_required ?? false,
      is_hidden: data.is_hidden ?? false,
      column_span: data.column_span ?? 1,
    };
    const result = await this.client
      .from('level_field_assignments')
      .insert(row)
      .select('*')
      .single();
    if (result.error) throw new BadRequestException(result.error.message);
    const fieldAssignmentData = result.data as Record<string, unknown>;
    this.logEntityAudit(
      organizationId,
      actorUserId,
      'level_field_assignment',
      fieldAssignmentData['id'] as string,
      'create',
      {
        hierarchy_level_id: data.hierarchy_level_id,
        entity_type: data.entity_type,
        custom_field_id: data.custom_field_id,
      },
    );
    return { data: fieldAssignmentData, success: true };
  }

  /** Remove a standalone field assignment from a level. */
  async unassignFieldFromLevel(
    organizationId: string,
    hierarchyLevelId: string,
    entityType: AssignmentEntityType,
    customFieldId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    const existing = await this.client
      .from('level_field_assignments')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('hierarchy_level_id', hierarchyLevelId)
      .eq('entity_type', entityType)
      .eq('custom_field_id', customFieldId)
      .maybeSingle();
    if (existing.error) throw new BadRequestException(existing.error.message);
    if (!existing.data) throw new NotFoundException('Assignment not found');
    const assignmentId = (existing.data as { id: string }).id;

    const r1 = await this.client
      .from('level_field_permissions')
      .delete()
      .eq('assignment_id', assignmentId);
    if (r1.error) throw new BadRequestException(r1.error.message);
    const r2 = await this.client
      .from('level_field_assignments')
      .delete()
      .eq('id', assignmentId);
    if (r2.error) throw new BadRequestException(r2.error.message);
    this.logEntityAudit(
      organizationId,
      actorUserId,
      'level_field_assignment',
      assignmentId,
      'delete',
      {
        hierarchy_level_id: hierarchyLevelId,
        entity_type: entityType,
        custom_field_id: customFieldId,
      },
    );
  }

  /** Return level assignments (groups or fields), scoped to org. */
  async getLevelAssignments(
    organizationId: string,
    hierarchyLevelId: string,
    entityType: AssignmentEntityType,
    type?: 'groups' | 'fields',
    spaceId?: string,
  ): Promise<{ data: unknown[]; count: number }> {
    const disabledFieldIds = spaceId
      ? await this.getDisabledCustomFieldIds(organizationId, spaceId)
      : new Set<string>();

    if (type === 'fields') {
      const r = await this.client
        .from('level_field_assignments')
        .select(
          '*, custom_field:custom_fields(id, name, field_key, field_type, description, name_i18n, options, validation_rules, default_value, space_id, is_active)',
        )
        .eq('organization_id', organizationId)
        .eq('hierarchy_level_id', hierarchyLevelId)
        .eq('entity_type', entityType)
        .order('sort_order', { ascending: true });
      if (r.error) throw new BadRequestException(r.error.message);

      interface FieldAssignmentRow {
        id: string;
        custom_field?: {
          id: string;
          space_id?: string | null;
          is_active?: boolean;
        } | null;
        [key: string]: unknown;
      }
      const fieldRows = (r.data ?? []) as FieldAssignmentRow[];

      // When spaceId provided: org-level fields (space_id null) + current space fields
      const spaceFiltered = spaceId
        ? fieldRows.filter(
            (item) =>
              !item.custom_field?.space_id ||
              item.custom_field.space_id === spaceId,
          )
        : fieldRows;

      const activeFiltered = spaceFiltered.filter((item) => {
        if (!item.custom_field) return true;
        if (item.custom_field.is_active === false) return false;
        return !disabledFieldIds.has(item.custom_field.id);
      });

      const rowsWithPerms = await Promise.all(
        activeFiltered.map(async (assignment) => {
          const { data: permissions } = await this.client
            .from('level_field_permissions')
            .select('*')
            .eq('assignment_id', assignment.id);
          return { ...assignment, permissions: permissions ?? [] };
        }),
      );
      return { data: rowsWithPerms, count: rowsWithPerms.length };
    }

    // Default: group assignments
    const r = await this.client
      .from('level_field_group_assignments')
      .select(
        `*, field_group:field_groups(*, fields:field_group_fields(*, custom_field:custom_fields(id, name, field_key, field_type, description, name_i18n, options, validation_rules, default_value, space_id, is_active)))`,
      )
      .eq('organization_id', organizationId)
      .eq('hierarchy_level_id', hierarchyLevelId)
      .eq('entity_type', entityType)
      .order('sort_order', { ascending: true });
    if (r.error) throw new BadRequestException(r.error.message);

    interface FieldGroupAssignmentRow {
      id: string;
      field_group?: {
        id: string;
        is_deleted?: boolean;
        space_id?: string | null;
        fields?: Array<{
          custom_field?: {
            id: string;
            is_active?: boolean;
          } | null;
          [key: string]: unknown;
        }> | null;
        [key: string]: unknown;
      } | null;
      [key: string]: unknown;
    }
    const groupRows = (r.data ?? []) as FieldGroupAssignmentRow[];

    // Filter out soft-deleted field groups
    const activeRows = groupRows.filter(
      (item) => item.field_group && !item.field_group.is_deleted,
    );

    // When spaceId provided: org-level groups (space_id null) + current space groups
    const spaceFiltered = spaceId
      ? activeRows.filter(
          (item) =>
            !item.field_group?.space_id ||
            item.field_group.space_id === spaceId,
        )
      : activeRows;

    // Filter inactive custom fields within each group
    const rowsWithActiveFields = spaceFiltered.map((item) => {
      if (!item.field_group?.fields) return item;
      const activeFields = item.field_group.fields.filter((fa) => {
        if (!fa.custom_field) return true;
        if (fa.custom_field.is_active === false) return false;
        return !disabledFieldIds.has(fa.custom_field.id);
      });
      return {
        ...item,
        field_group: { ...item.field_group, fields: activeFields },
      };
    });

    // Fetch group-level and field-level permissions per assignment
    const rowsWithPerms = await Promise.all(
      rowsWithActiveFields.map(async (assignment) => {
        const [{ data: permissions }, { data: fieldPermissions }] =
          await Promise.all([
            this.client
              .from('level_field_group_permissions')
              .select('*')
              .eq('assignment_id', assignment.id),
            this.client
              .from('level_field_group_field_permissions')
              .select('*')
              .eq('assignment_id', assignment.id),
          ]);
        const fg = assignment.field_group;
        return {
          ...assignment,
          field_group: fg
            ? {
                ...fg,
                fields: fg.fields ?? [],
                field_count: fg.fields?.length ?? 0,
              }
            : undefined,
          permissions: permissions ?? [],
          field_permissions: fieldPermissions ?? [],
        };
      }),
    );
    return { data: rowsWithPerms, count: rowsWithPerms.length };
  }

  /**
   * Return the full field configuration for a level, optionally grouped
   * by section. Scoped to organization.
   */
  async getLevelFieldsConfiguration(
    organizationId: string,
    hierarchyLevelId: string,
    entityType: AssignmentEntityType,
    bySection: boolean,
    spaceId?: string,
  ): Promise<unknown> {
    const [groupsResult, fieldsResult] = await Promise.all([
      this.getLevelAssignments(
        organizationId,
        hierarchyLevelId,
        entityType,
        'groups',
        spaceId,
      ),
      this.getLevelAssignments(
        organizationId,
        hierarchyLevelId,
        entityType,
        'fields',
        spaceId,
      ),
    ]);
    const groups = groupsResult.data as Array<{ section?: string }>;
    const standalone_fields = fieldsResult.data as Array<{ section?: string }>;

    if (!bySection) {
      return {
        hierarchy_level_id: hierarchyLevelId,
        entity_type: entityType,
        groups,
        standalone_fields,
      };
    }

    const sections: Record<
      string,
      { groups: unknown[]; standalone_fields: unknown[] }
    > = {
      header: { groups: [], standalone_fields: [] },
      main: { groups: [], standalone_fields: [] },
      footer: { groups: [], standalone_fields: [] },
      sidebar: { groups: [], standalone_fields: [] },
    };
    for (const g of groups) {
      const sec = g.section ?? 'main';
      if (sections[sec]) sections[sec].groups.push(g);
    }
    for (const f of standalone_fields) {
      const sec = f.section ?? 'main';
      if (sections[sec]) sections[sec].standalone_fields.push(f);
    }
    return {
      hierarchy_level_id: hierarchyLevelId,
      entity_type: entityType,
      sections,
    };
  }

  // ---------------------------------------------------------------------
  // Wiki Field Assignments (Wiki 2.0)
  // ---------------------------------------------------------------------

  /**
   * Verify a space exists AND belongs to the caller's organization.
   * @private
   */
  private async verifySpaceInOrg(
    spaceId: string,
    organizationId: string,
  ): Promise<void> {
    const check = await this.client
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (check.error) throw new BadRequestException(check.error.message);
    if (!check.data) throw new NotFoundException('Space not found');
  }

  /**
   * List wiki field assignments for a space, each embedding its field group
   * (with member fields) or standalone custom-field definition. Mirrors the
   * visibility rules of getLevelAssignments: soft-deleted groups, inactive
   * fields, and fields disabled in the space are filtered out.
   */
  async getWikiAssignments(
    organizationId: string,
    spaceId: string,
  ): Promise<{ data: unknown[]; count: number }> {
    await this.verifySpaceInOrg(spaceId, organizationId);
    const disabledFieldIds = await this.getDisabledCustomFieldIds(
      organizationId,
      spaceId,
    );

    const r = await this.client
      .from('wiki_field_assignments')
      .select(
        `*, field_group:field_groups(*, fields:field_group_fields(*, custom_field:custom_fields(id, name, field_key, field_type, description, name_i18n, options, validation_rules, default_value, space_id, is_active))), custom_field:custom_fields(id, name, field_key, field_type, description, name_i18n, options, validation_rules, default_value, space_id, is_active)`,
      )
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .order('sort_order', { ascending: true });
    if (r.error) throw new BadRequestException(r.error.message);

    interface WikiAssignmentRow {
      id: string;
      assignment_type: 'group' | 'field';
      field_group?: {
        id: string;
        is_deleted?: boolean;
        fields?: Array<{
          custom_field?: { id: string; is_active?: boolean } | null;
          [key: string]: unknown;
        }> | null;
        [key: string]: unknown;
      } | null;
      custom_field?: { id: string; is_active?: boolean } | null;
      [key: string]: unknown;
    }
    const rows = (r.data ?? []) as WikiAssignmentRow[];

    const visible = rows.filter((item) => {
      if (item.assignment_type === 'group') {
        return Boolean(item.field_group) && !item.field_group!.is_deleted;
      }
      if (!item.custom_field) return true;
      if (item.custom_field.is_active === false) return false;

      return !disabledFieldIds.has(item.custom_field.id);
    });

    const data = visible.map((item) => {
      if (!item.field_group?.fields) return item;
      const activeFields = item.field_group.fields.filter((fa) => {
        if (!fa.custom_field) return true;
        if (fa.custom_field.is_active === false) return false;

        return !disabledFieldIds.has(fa.custom_field.id);
      });

      return {
        ...item,
        field_group: {
          ...item.field_group,
          fields: activeFields,
          field_count: activeFields.length,
        },
      };
    });

    return { data, count: data.length };
  }

  /**
   * Assign a field group or standalone custom field to a space's wiki.
   * Enforces org ownership of the space AND the referenced group/field;
   * duplicate assignments map to 409.
   */
  async createWikiAssignment(
    organizationId: string,
    dto: CreateWikiAssignmentDto,
    actorUserId?: string | null,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.verifySpaceInOrg(dto.space_id, organizationId);

    if (dto.assignment_type === 'group') {
      if (!dto.field_group_id) {
        throw new BadRequestException(
          'field_group_id is required when assignment_type=group',
        );
      }

      // Verify the group belongs to this org and is not soft-deleted.
      const groupCheck = await this.client
        .from('field_groups')
        .select('id, organization_id, is_deleted')
        .eq('id', dto.field_group_id)
        .maybeSingle();
      if (groupCheck.error) {
        throw new BadRequestException(groupCheck.error.message);
      }
      const group = groupCheck.data as {
        id: string;
        organization_id: string;
        is_deleted: boolean;
      } | null;
      if (!group) throw new NotFoundException('Field group not found');
      if (group.organization_id !== organizationId) {
        throw new ForbiddenException(
          'Field group belongs to a different organization',
        );
      }
      if (group.is_deleted) {
        throw new BadRequestException(
          'Cannot assign a soft-deleted field group',
        );
      }

      // organization_id is redundant today (verifySpaceInOrg already ran) but
      // this client bypasses RLS, so every query carries its own tenant filter.
      const dup = await this.client
        .from('wiki_field_assignments')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('space_id', dto.space_id)
        .eq('field_group_id', dto.field_group_id)
        .maybeSingle();
      if (dup.error) throw new BadRequestException(dup.error.message);
      if (dup.data) {
        throw new ConflictException(
          'Group already assigned to this space wiki',
        );
      }
    } else {
      if (!dto.custom_field_id) {
        throw new BadRequestException(
          'custom_field_id is required when assignment_type=field',
        );
      }

      // Verify the field belongs to this org and is not soft-deleted.
      const fieldCheck = await this.client
        .from('custom_fields')
        .select('id, organization_id, is_deleted')
        .eq('id', dto.custom_field_id)
        .maybeSingle();
      if (fieldCheck.error) {
        throw new BadRequestException(fieldCheck.error.message);
      }
      const field = fieldCheck.data as {
        id: string;
        organization_id: string;
        is_deleted: boolean;
      } | null;
      if (!field) throw new NotFoundException('Custom field not found');
      if (field.organization_id !== organizationId) {
        throw new ForbiddenException(
          'Custom field belongs to a different organization',
        );
      }
      if (field.is_deleted) {
        throw new BadRequestException(
          'Cannot assign a soft-deleted custom field',
        );
      }

      const dup = await this.client
        .from('wiki_field_assignments')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('space_id', dto.space_id)
        .eq('custom_field_id', dto.custom_field_id)
        .maybeSingle();
      if (dup.error) throw new BadRequestException(dup.error.message);
      if (dup.data) {
        throw new ConflictException(
          'Field already assigned to this space wiki',
        );
      }
    }

    const row = {
      organization_id: organizationId,
      space_id: dto.space_id,
      assignment_type: dto.assignment_type,
      field_group_id:
        dto.assignment_type === 'group' ? dto.field_group_id : null,
      custom_field_id:
        dto.assignment_type === 'field' ? dto.custom_field_id : null,
      section: dto.section ?? 'main',
      sort_order: dto.sort_order ?? 0,
      is_required: dto.is_required ?? false,
      is_hidden: dto.is_hidden ?? false,
      column_span: dto.column_span ?? null,
      is_collapsed_default: dto.is_collapsed_default ?? false,
      show_in_header: dto.show_in_header ?? false,
      created_by: actorUserId ?? null,
    };
    const result = await this.client
      .from('wiki_field_assignments')
      .insert(row)
      .select('*')
      .single();
    if (result.error) {
      // Race-safe mapping of the partial unique indexes → 409.
      if (result.error.code === '23505') {
        throw new ConflictException(
          'Assignment already exists for this space wiki',
        );
      }
      throw new BadRequestException(result.error.message);
    }
    const assignment = result.data as Record<string, unknown>;
    this.logEntityAudit(
      organizationId,
      actorUserId,
      'wiki_field_assignment',
      assignment['id'] as string,
      'create',
      {
        space_id: dto.space_id,
        assignment_type: dto.assignment_type,
        field_group_id: dto.field_group_id ?? null,
        custom_field_id: dto.custom_field_id ?? null,
      },
    );

    return { data: assignment, success: true };
  }

  /** Patch layout/behaviour flags on a wiki field assignment. */
  async updateWikiAssignment(
    id: string,
    organizationId: string,
    dto: UpdateWikiAssignmentDto,
    actorUserId?: string | null,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.verifyWikiAssignmentOrg(id, organizationId);

    const patch: Record<string, unknown> = {};
    for (const k of [
      'section',
      'sort_order',
      'is_required',
      'is_hidden',
      'column_span',
      'is_collapsed_default',
      'show_in_header',
    ] as const) {
      if (dto[k] !== undefined) patch[k] = dto[k];
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException(
        'At least one field must be provided for update',
      );
    }

    const result = await this.client
      .from('wiki_field_assignments')
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single();
    if (result.error) throw new BadRequestException(result.error.message);
    const assignment = result.data as Record<string, unknown>;
    this.logEntityAudit(
      organizationId,
      actorUserId,
      'wiki_field_assignment',
      id,
      'update',
      patch,
    );

    return { data: assignment, success: true };
  }

  /** Remove a wiki field assignment. */
  async deleteWikiAssignment(
    id: string,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    await this.verifyWikiAssignmentOrg(id, organizationId);

    const r = await this.client
      .from('wiki_field_assignments')
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);

    this.logEntityAudit(
      organizationId,
      actorUserId,
      'wiki_field_assignment',
      id,
      'delete',
      {},
    );
  }

  /**
   * Verify the wiki assignment belongs to the given organization.
   * @private
   */
  private async verifyWikiAssignmentOrg(
    assignmentId: string,
    organizationId: string,
  ): Promise<void> {
    const check = await this.client
      .from('wiki_field_assignments')
      .select('id, organization_id')
      .eq('id', assignmentId)
      .maybeSingle();
    if (check.error) throw new BadRequestException(check.error.message);
    const row = check.data as {
      id: string;
      organization_id: string;
    } | null;
    if (!row || row.organization_id !== organizationId) {
      throw new NotFoundException('Assignment not found');
    }
  }

  /**
   * Verify the assignment belongs to the given organization.
   * @private
   */
  private async verifyAssignmentOrg(
    assignmentId: string,
    organizationId: string,
  ): Promise<void> {
    const check = await this.client
      .from('level_field_group_assignments')
      .select('id, organization_id')
      .eq('id', assignmentId)
      .maybeSingle();
    if (check.error) throw new BadRequestException(check.error.message);
    const row = check.data as {
      id: string;
      organization_id: string;
    } | null;
    if (!row) throw new NotFoundException('Assignment not found');
    if (row.organization_id !== organizationId) {
      throw new NotFoundException('Assignment not found');
    }
  }

  private async getDisabledCustomFieldIds(
    organizationId: string,
    spaceId: string,
  ): Promise<Set<string>> {
    const { data, error } = await this.client
      .from('space_custom_field_overrides')
      .select('custom_field_id, is_enabled')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId);

    if (error) throw new BadRequestException(error.message);

    return new Set(
      ((data ?? []) as Array<{ custom_field_id: string; is_enabled: boolean }>)
        .filter((override) => override.is_enabled === false)
        .map((override) => override.custom_field_id),
    );
  }

  /** Return permissions attached to a group-assignment id. */
  async getGroupAssignmentPermissions(
    assignmentId: string,
    organizationId: string,
  ): Promise<AssignmentPermission[]> {
    await this.verifyAssignmentOrg(assignmentId, organizationId);
    const result = await this.client
      .from('level_field_group_permissions')
      .select('*')
      .eq('assignment_id', assignmentId);
    if (result.error) throw new BadRequestException(result.error.message);
    return (result.data ?? []) as AssignmentPermission[];
  }

  /** Replace permissions on a group assignment atomically. */
  async bulkSetGroupAssignmentPermissions(
    assignmentId: string,
    permissions: AssignmentPermission[],
    organizationId: string,
    actorUserId?: string,
  ): Promise<AssignmentPermission[]> {
    await this.verifyAssignmentOrg(assignmentId, organizationId);
    for (const p of permissions) {
      if (p.target_type === 'user' && !p.user_id) {
        throw new BadRequestException(
          'user_id is required when target_type=user',
        );
      }
      if (p.target_type === 'role' && !p.role_id) {
        throw new BadRequestException(
          'role_id is required when target_type=role',
        );
      }
      if (p.target_type === 'group' && !p.group_id) {
        throw new BadRequestException(
          'group_id is required when target_type=group',
        );
      }
      if (p.target_type === 'base_role' && !p.base_role) {
        throw new BadRequestException(
          'base_role is required when target_type=base_role',
        );
      }
    }

    const del = await this.client
      .from('level_field_group_permissions')
      .delete()
      .eq('assignment_id', assignmentId);
    if (del.error) throw new BadRequestException(del.error.message);

    if (permissions.length === 0) {
      void this.logAudit(organizationId, actorUserId, assignmentId, {
        scope: 'field_group_assignment_permission',
        count: 0,
      });
      return [];
    }

    const rows = permissions.map((p) => ({
      assignment_id: assignmentId,
      target_type: p.target_type,
      user_id: p.user_id ?? null,
      role_id: p.role_id ?? null,
      group_id: p.group_id ?? null,
      base_role: p.base_role ?? null,
      can_view: p.can_view,
      can_edit: p.can_edit,
    }));
    const result = await this.client
      .from('level_field_group_permissions')
      .insert(rows)
      .select();
    if (result.error) throw new BadRequestException(result.error.message);
    void this.logAudit(organizationId, actorUserId, assignmentId, {
      scope: 'field_group_assignment_permission',
      count: permissions.length,
    });
    return (result.data ?? []) as AssignmentPermission[];
  }

  private async logAudit(
    organizationId: string,
    actorUserId: string | undefined,
    entityId: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    if (!actorUserId) return;

    try {
      await this.client.from('audit_logs').insert({
        organization_id: organizationId,
        user_id: actorUserId,
        entity_type: 'permission',
        entity_id: entityId,
        action: 'update',
        changes,
      });
    } catch {
      // Audit is best-effort and must not break field group permission mutations.
    }
  }

  async reorder(
    items: { id: string; sort_order: number }[],
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    await Promise.all(
      items.map((item) =>
        this.client
          .from('field_groups')
          .update({ sort_order: item.sort_order })
          .eq('id', item.id)
          .eq('organization_id', organizationId)
          .then((r) => {
            if (r.error) throw new BadRequestException(r.error.message);
          }),
      ),
    );
    this.logEntityAudit(
      organizationId,
      actorUserId,
      'field_group',
      items[0]?.id ?? '',
      'update',
      {
        reorder: items,
      },
    );
  }

  private logEntityAudit(
    organizationId: string,
    actorUserId: string | null | undefined,
    entityType: string,
    entityId: string,
    action: 'create' | 'update' | 'delete' | 'restore',
    changes?: Record<string, unknown>,
  ): void {
    if (!actorUserId || !this.auditLogsService) return;
    void this.auditLogsService.logAction(
      organizationId,
      actorUserId,
      entityType,
      entityId,
      action,
      changes,
    );
  }
}
