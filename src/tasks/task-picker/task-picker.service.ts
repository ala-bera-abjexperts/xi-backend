import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TasksService } from '../tasks.service';

export const PICKER_MAX_PAGE_SIZE = 50;
export const PICKER_LOOKUP_MAX_IDS = 200;

export interface TaskPickerSpace {
  id: string;
  key: string;
  name: string;
}

/** Only what a picker row / whiteboard card shows: no description, no custom fields. */
export interface TaskPickerItem {
  id: string;
  key: string;
  summary: string;
  spaceId: string;
  spaceKey: string;
  status: { name: string; color: string | null; isCompleted: boolean } | null;
  priority: { name: string; color: string | null; icon: string | null } | null;
  assignee: { id: string; name: string; avatarUrl: string | null } | null;
  /** tasks.task_type_id: 'task', 'bug', 'story', … (shown as the card's type icon). */
  type: string | null;
  updatedAt: string;
}

/** The `getAll(..., withRelations)` columns this service reads. */
interface PickerRow {
  id: string;
  key: string | null;
  summary: string | null;
  space_id: string | null;
  status: string | null;
  priority: string | null;
  priority_id: string | null;
  updated_at: string;
  task_type_id?: string | null;
  status_config: {
    name: string;
    color: string | null;
    is_completed: boolean | null;
  } | null;
  space: { key: string } | null;
  assignee: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    avatar_url: string | null;
  } | null;
}

interface PriorityRow {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
}

/**
 * Membership-checked task reads for pickers (whiteboard "Import from Tasks").
 *
 * GET /tasks?spaceId= trusts org-level can_view_tasks and never checks space membership; this
 * service only reads spaces from TasksService.getAccessibleTaskSpaces (admin/owner: all
 * non-archived org spaces, otherwise member spaces with view_tasks) that also have the Tasks
 * module on for the tenant and the space. Anything outside that set is a uniform 404 / `missing`.
 */
@Injectable()
export class TaskPickerService {
  constructor(
    private readonly tasks: TasksService,
    private readonly orgModules: OrganizationModulesService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  async listSpaces(
    user: RequestUser,
  ): Promise<{ spaces: TaskPickerSpace[]; truncated: boolean }> {
    const { spaces, truncated } = await this.accessibleSpaces(user);

    return {
      spaces: [...spaces.values()].sort((a, b) => a.name.localeCompare(b.name)),
      truncated,
    };
  }

  async search(
    user: RequestUser,
    q: { spaceId: string; search?: string; page: number; pageSize: number },
  ): Promise<{
    items: TaskPickerItem[];
    page: number;
    hasMore: boolean;
    total: number;
  }> {
    const { spaces } = await this.accessibleSpaces(user);

    if (!spaces.has(q.spaceId)) throw new NotFoundException('Space not found');

    const res = await this.tasks.getAll(user.organizationId, {
      space_id: q.spaceId,
      search: q.search?.trim() || undefined,
      page: q.page,
      pageSize: Math.min(q.pageSize, PICKER_MAX_PAGE_SIZE),
      withRelations: true,
      sortBy: 'updated_at',
      sortDir: 'desc',
    });

    return {
      items: await this.toItems(
        user.organizationId,
        res.data as unknown as PickerRow[],
        spaces,
      ),
      page: res.page,
      hasMore: res.hasMore,
      total: res.total,
    };
  }

  async lookup(
    user: RequestUser,
    ids: string[],
  ): Promise<{ items: TaskPickerItem[]; missing: string[] }> {
    const unique = [...new Set(ids)];

    if (unique.length === 0 || unique.length > PICKER_LOOKUP_MAX_IDS) {
      throw new BadRequestException(
        `Between 1 and ${PICKER_LOOKUP_MAX_IDS} ids are required`,
      );
    }

    const { spaces } = await this.accessibleSpaces(user);
    let rows: PickerRow[] = [];

    if (spaces.size > 0) {
      const res = await this.tasks.getAll(user.organizationId, {
        ids: unique.join(','),
        withRelations: true,
      });

      // getAll filters by organization only; drop anything outside the caller's spaces.
      rows = (res.data as unknown as PickerRow[]).filter(
        (r) => typeof r.space_id === 'string' && spaces.has(r.space_id),
      );
    }

    const items = await this.toItems(user.organizationId, rows, spaces);
    const found = new Set(items.map((i) => i.id));

    return { items, missing: unique.filter((id) => !found.has(id)) };
  }

  /** Accessible spaces ∩ Tasks module on (tenant + space). */
  private async accessibleSpaces(user: RequestUser) {
    const empty = {
      spaces: new Map<string, TaskPickerSpace>(),
      truncated: false,
    };

    if (
      !user.organizationId ||
      !(await this.orgModules.isEnabled(user.organizationId, 'tasks'))
    )
      return empty;

    const { spaceIds, spacesById, truncated } =
      await this.tasks.getAccessibleTaskSpaces(user);

    if (spaceIds.length === 0) return { ...empty, truncated };

    const enabled = new Set(
      await this.orgModules.getEnabledSpaceIds(
        user.organizationId,
        'tasks',
        spaceIds,
      ),
    );
    const spaces = new Map<string, TaskPickerSpace>();

    for (const id of spaceIds) {
      const s = spacesById.get(id);

      if (s && enabled.has(id)) spaces.set(id, s);
    }

    return { spaces, truncated };
  }

  private async toItems(
    organizationId: string,
    rows: PickerRow[],
    spaces: Map<string, TaskPickerSpace>,
  ): Promise<TaskPickerItem[]> {
    const priorityIds = [
      ...new Set(
        rows
          .map((r) => r.priority_id)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    const priorities = new Map<string, PriorityRow>();

    if (priorityIds.length) {
      const { data, error } = await this.supabaseAdmin
        .getClient()
        .from('task_priorities')
        .select('id, name, color, icon')
        .eq('organization_id', organizationId)
        .in('id', priorityIds);

      if (error) throw new BadRequestException(error.message);
      for (const p of (data ?? []) as PriorityRow[]) priorities.set(p.id, p);
    }

    return rows.map((r) => {
      const status = r.status_config;
      const p = r.priority_id ? priorities.get(r.priority_id) : undefined;
      const a = r.assignee;
      const spaceId = r.space_id ?? '';

      return {
        id: r.id,
        key: r.key ?? '',
        summary: r.summary ?? '',
        spaceId,
        spaceKey: spaces.get(spaceId)?.key ?? r.space?.key ?? '',
        status: status
          ? {
              name: status.name,
              color: status.color ?? null,
              isCompleted: status.is_completed === true,
            }
          : r.status
            ? { name: r.status, color: null, isCompleted: false }
            : null,
        priority: p
          ? { name: p.name, color: p.color ?? null, icon: p.icon ?? null }
          : r.priority
            ? { name: r.priority, color: null, icon: null }
            : null,
        assignee: a
          ? {
              id: a.id,
              name:
                [a.first_name, a.last_name].filter(Boolean).join(' ') ||
                a.email ||
                '',
              avatarUrl: a.avatar_url ?? null,
            }
          : null,
        type: r.task_type_id ?? null,
        updatedAt: r.updated_at,
      };
    });
  }
}
