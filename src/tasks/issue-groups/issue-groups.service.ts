import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { CustomField } from '../../custom-fields/models/custom-field.model';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TaskHierarchyConfigService } from '../../task-hierarchy-config/task-hierarchy-config.service';
import { TasksService } from '../tasks.service';
import type {
  IssueGroupFiltersDto,
  IssueGroupTasksQueryDto,
} from './issue-groups.dto';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type IssueGroupField = CustomField & { space_id: string; task_type_ids: string[] };

interface CountRow {
  option_value: string | null;
  status_category_id: string | null;
  task_count: number;
  is_total: boolean;
}

export interface CategoryCount {
  categoryId: string | null;
  count: number;
}

function csv(value?: string): string[] | null {
  const items = (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  return items.length > 0 ? items : null;
}

function uuids(value?: string): string[] | null {
  const items = csv(value)?.filter((v) => UUID_REGEX.test(v));

  return items?.length ? items : null;
}

/** Same cleaning as `TasksService.getAll`: these characters would break a PostgREST `or()`. */
function cleanSearch(value?: string): string | null {
  return value?.trim().replace(/[,.()"'\\]/g, '') || null;
}

/**
 * Menu, counts and ticket lists of the Issue groups page. Counts (`issue_group_counts`) and lists
 * (`getTasks`) must apply the same filters, or the numbers stop matching what is listed.
 */
@Injectable()
export class IssueGroupsService {
  constructor(
    private readonly tasks: TasksService,
    private readonly permissions: PermissionsService,
    private readonly hierarchy: TaskHierarchyConfigService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getMenu(user: RequestUser, spaceId: string) {
    await this.assertCanViewTasks(user, spaceId);
    const fields = await this.loadUsableFields(user.organizationId, spaceId);

    return fields.map((f) => ({ id: f.id, name: f.name }));
  }

  async getField(user: RequestUser, fieldId: string) {
    return this.resolveField(user, fieldId);
  }

  async getSummary(
    user: RequestUser,
    fieldId: string,
    filters: IssueGroupFiltersDto,
  ) {
    const field = await this.resolveField(user, fieldId);

    const { data, error } = await this.client.rpc('issue_group_counts', {
      p_org: user.organizationId,
      p_space: field.space_id,
      p_field_key: field.field_key,
      p_task_types: this.taskTypesFor(field, filters),
      p_search: cleanSearch(filters.search),
      p_status_ids: uuids(filters.statusIds),
      p_priority_ids: uuids(filters.priorityIds),
      p_assignees: uuids(filters.assigneeIds),
      p_labels: csv(filters.labels),
      p_hide_done: filters.hideDone === 'true',
    });

    if (error) throw new BadRequestException(error.message);

    const rows = (data ?? []) as CountRow[];
    const groups = new Map<string | null, { count: number; byCategory: CategoryCount[] }>();
    const totalByCategory: CategoryCount[] = [];
    let total = 0;

    for (const row of rows) {
      const count = Number(row.task_count);
      const entry = { categoryId: row.status_category_id, count };

      if (row.is_total) {
        total += count;
        totalByCategory.push(entry);
        continue;
      }

      const group = groups.get(row.option_value) ?? { count: 0, byCategory: [] };

      group.count += count;
      group.byCategory.push(entry);
      groups.set(row.option_value, group);
    }

    return {
      total,
      totalByCategory,
      groups: [...groups].map(([optionId, group]) => ({ optionId, ...group })),
      categories: await this.loadCategories(rows),
    };
  }

  async getTasks(
    user: RequestUser,
    fieldId: string,
    q: IssueGroupTasksQueryDto,
  ) {
    const field = await this.resolveField(user, fieldId);
    const column = `custom_field_values->${field.field_key}`;
    const doneIds =
      q.hideDone === 'true' ? await this.doneStatusIds(field.space_id, user.organizationId) : [];
    const search = cleanSearch(q.search);
    const statusIds = uuids(q.statusIds);
    const priorityIds = uuids(q.priorityIds);
    const assigneeIds = uuids(q.assigneeIds);
    const labels = csv(q.labels);

    return this.tasks.getAll(user.organizationId, {
      space_id: field.space_id,
      page: q.page ?? 1,
      pageSize: q.pageSize ?? 25,
      withRelations: true,
      sortBy: q.sortBy,
      sortDir: q.sortDir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the PostgREST builder type
      refine: (query: any) => {
        let next = query.in('task_type_id', this.taskTypesFor(field, q));

        next =
          q.option === 'none'
            ? next.or(`${column}.is.null,${column}.eq.[],${column}.eq.null`)
            : next.contains('custom_field_values', {
                [field.field_key]: [q.option],
              });

        if (search) {
          next = next.or(
            `summary.ilike.%${search}%,description.ilike.%${search}%,key.ilike.%${search}%`,
          );
        }
        if (statusIds) next = next.in('status_id', statusIds);
        if (priorityIds) next = next.in('priority_id', priorityIds);
        if (assigneeIds) next = next.in('assigned_to', assigneeIds);
        if (labels) {
          next = next.or(
            labels
              .map((label) => `labels.cs.${JSON.stringify([label])}`)
              .join(','),
          );
        }
        if (doneIds.length > 0) {
          next = next.or(
            `status_id.is.null,status_id.not.in.(${doneIds.join(',')})`,
          );
        }

        return next;
      },
    });
  }

  /** Counted across every ticket of the space: a type that lost the field still holds its values. */
  async getOptionUsage(user: RequestUser, fieldId: string, optionId: string) {
    const field = await this.resolveField(user, fieldId, false);
    const { count, error } = await this.client
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', user.organizationId)
      .eq('space_id', field.space_id)
      .contains('custom_field_values', { [field.field_key]: [optionId] });

    if (error) throw new BadRequestException(error.message);

    return { count: count ?? 0 };
  }

  private async assertCanViewTasks(user: RequestUser, spaceId: string) {
    const access = await this.permissions.getUserSpacePermissions(
      user.userId,
      user.organizationId,
      spaceId,
    );

    if (!access.isMember || access.permissions['view_tasks'] !== true) {
      throw new NotFoundException('Issue group not found');
    }
  }

  /** `requireUsable: false` is for the settings dialog, which also edits fields not in the menu. */
  private async resolveField(
    user: RequestUser,
    fieldId: string,
    requireUsable = true,
  ): Promise<IssueGroupField> {
    const { data, error } = await this.client
      .from('custom_fields')
      .select('*')
      .eq('id', fieldId)
      .eq('organization_id', user.organizationId)
      .eq('field_type', 'issue_group')
      .or('is_deleted.is.null,is_deleted.eq.false')
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);

    const row = data as CustomField | null;

    if (!row?.space_id) throw new NotFoundException('Issue group not found');

    await this.assertCanViewTasks(user, row.space_id);

    if (!requireUsable) {
      return { ...row, space_id: row.space_id, task_type_ids: [] };
    }

    const usable = await this.loadUsableFields(
      user.organizationId,
      row.space_id,
      row.id,
    );

    if (!usable[0]) throw new NotFoundException('Issue group not found');

    return usable[0];
  }

  /**
   * Active fields attached to at least one issue type of the space, directly or through a field
   * group, with at least one active option. Assignments are keyed by a level id like `task` that
   * is not tied to a space, so they are narrowed to the levels this space actually has.
   */
  private async loadUsableFields(
    organizationId: string,
    spaceId: string,
    fieldId?: string,
  ): Promise<IssueGroupField[]> {
    let query = this.client
      .from('custom_fields')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('field_type', 'issue_group')
      .eq('is_active', true)
      .or('is_deleted.is.null,is_deleted.eq.false');

    if (fieldId) query = query.eq('id', fieldId);

    const { data, error } = await query
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    const fields = ((data ?? []) as CustomField[]).filter((f) =>
      (f.options ?? []).some((o) => o.status !== 'archived'),
    );

    if (fields.length === 0) return [];

    const typesByField = await this.loadTaskTypes(
      organizationId,
      spaceId,
      fields.map((f) => f.id),
    );

    return fields.flatMap((f) => {
      const task_type_ids = [...(typesByField.get(f.id) ?? [])];

      return task_type_ids.length > 0
        ? [{ ...f, space_id: spaceId, task_type_ids }]
        : [];
    });
  }

  private async loadTaskTypes(
    organizationId: string,
    spaceId: string,
    fieldIds: string[],
  ): Promise<Map<string, Set<string>>> {
    const [{ config }, direct, grouped] = await Promise.all([
      this.hierarchy.getConfig(organizationId, spaceId),
      this.client
        .from('level_field_assignments')
        .select('custom_field_id, hierarchy_level_id, is_hidden')
        .eq('organization_id', organizationId)
        .eq('entity_type', 'task')
        .in('custom_field_id', fieldIds),
      this.client
        .from('field_group_fields')
        .select('custom_field_id, field_group_id, is_hidden')
        .in('custom_field_id', fieldIds),
    ]);

    if (direct.error) throw new BadRequestException(direct.error.message);
    if (grouped.error) throw new BadRequestException(grouped.error.message);

    const spaceLevels = new Set(config.levels.map((level) => level.id));
    const result = new Map<string, Set<string>>();

    const add = (fieldId: string, levelId: string) => {
      if (!spaceLevels.has(levelId)) return;

      result.set(fieldId, (result.get(fieldId) ?? new Set()).add(levelId));
    };

    for (const row of (direct.data ?? []) as Array<{
      custom_field_id: string;
      hierarchy_level_id: string;
      is_hidden: boolean | null;
    }>) {
      if (row.is_hidden !== true) add(row.custom_field_id, row.hierarchy_level_id);
    }

    const groupRows = ((grouped.data ?? []) as Array<{
      custom_field_id: string;
      field_group_id: string;
      is_hidden: boolean | null;
    }>).filter((row) => row.is_hidden !== true);

    if (groupRows.length === 0) return result;

    const groupIds = [...new Set(groupRows.map((row) => row.field_group_id))];
    const [levels, liveGroups] = await Promise.all([
      this.client
        .from('level_field_group_assignments')
        .select('field_group_id, hierarchy_level_id')
        .eq('organization_id', organizationId)
        .eq('entity_type', 'task')
        .in('field_group_id', groupIds),
      this.client
        .from('field_groups')
        .select('id')
        .in('id', groupIds)
        .or('is_deleted.is.null,is_deleted.eq.false'),
    ]);

    if (levels.error) throw new BadRequestException(levels.error.message);
    if (liveGroups.error) throw new BadRequestException(liveGroups.error.message);

    const live = new Set(
      ((liveGroups.data ?? []) as Array<{ id: string }>).map((g) => g.id),
    );

    for (const level of (levels.data ?? []) as Array<{
      field_group_id: string;
      hierarchy_level_id: string;
    }>) {
      if (!live.has(level.field_group_id)) continue;

      for (const row of groupRows) {
        if (row.field_group_id === level.field_group_id) {
          add(row.custom_field_id, level.hierarchy_level_id);
        }
      }
    }

    return result;
  }

  /** The issue type filter can only narrow: types without the field are never part of the page. */
  private taskTypesFor(
    field: IssueGroupField,
    filters: IssueGroupFiltersDto,
  ): string[] {
    const wanted = csv(filters.taskTypeIds);

    return wanted
      ? field.task_type_ids.filter((id) => wanted.includes(id))
      : field.task_type_ids;
  }

  private async doneStatusIds(
    spaceId: string,
    organizationId: string,
  ): Promise<string[]> {
    const { data, error } = await this.client
      .from('task_statuses')
      .select('id, is_completed, category:status_categories(is_done_like)')
      .eq('organization_id', organizationId)
      .or(`space_id.is.null,space_id.eq.${spaceId}`);

    if (error) throw new BadRequestException(error.message);

    return ((data ?? []) as unknown as Array<{
      id: string;
      is_completed: boolean | null;
      category: { is_done_like?: boolean } | null;
    }>)
      .filter((s) => s.is_completed === true || s.category?.is_done_like === true)
      .map((s) => s.id);
  }

  private async loadCategories(rows: CountRow[]) {
    const ids = [
      ...new Set(
        rows
          .map((row) => row.status_category_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    if (ids.length === 0) return [];

    const { data, error } = await this.client
      .from('status_categories')
      .select('id, name, key, color, sort_order, is_done_like')
      .in('id', ids)
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    return data ?? [];
  }
}
