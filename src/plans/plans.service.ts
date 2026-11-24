import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PermissionsService } from '../permissions/permissions.service';
import { SavedFiltersService } from '../saved-filters/saved-filters.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { fetchAllRows } from '../common/utils/fetch-all-rows';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import type { CreatePlanDto } from './dto/create-plan.dto';
import type { UpdatePlanDto } from './dto/update-plan.dto';
import type { CreatePlanItemDto } from './dto/create-plan-item.dto';
import type { UpdatePlanItemDto } from './dto/update-plan-item.dto';
import type { ReorderPlanItemsDto } from './dto/reorder-plan-items.dto';
import type { MovePlanItemDto } from './dto/move-plan-item.dto';
import type { CreatePlanStakeholderDto } from './dto/create-plan-stakeholder.dto';
import type { UpdatePlanStakeholderDto } from './dto/update-plan-stakeholder.dto';
import type { CreatePlanRiskDto } from './dto/create-plan-risk.dto';
import type { UpdatePlanRiskDto } from './dto/update-plan-risk.dto';
import type { CreatePlanDependencyDto } from './dto/create-plan-dependency.dto';
import type { CreatePlanBaselineDto } from './dto/create-plan-baseline.dto';
import type { CreatePlanPermissionDto } from './dto/create-plan-permission.dto';
import type { UpdatePlanPermissionDto } from './dto/update-plan-permission.dto';
import { PlanItemType } from './dto/create-plan-item.dto';
import { PlanPermissionLevel } from './dto/create-plan-permission.dto';
import { PlanStatus } from './dto/create-plan.dto';

const DEPENDENCY_TYPE_LABELS: Record<string, string> = {
  finish_to_start: 'Finish to Start',
  start_to_start: 'Start to Start',
  finish_to_finish: 'Finish to Finish',
  start_to_finish: 'Start to Finish',
};

const RELATION_NAME_TO_TYPE: Record<string, string> = {
  'Finish to Start': 'finish_to_start',
  'Start to Start': 'start_to_start',
  'Finish to Finish': 'finish_to_finish',
  'Start to Finish': 'start_to_finish',
};

const GANTT_RELATION_NAMES = Object.values(DEPENDENCY_TYPE_LABELS);

type PlanAccessLevel = 'view' | 'edit' | 'admin';

const PLAN_PERMISSION_RANK: Record<PlanPermissionLevel, number> = {
  [PlanPermissionLevel.VIEW]: 1,
  [PlanPermissionLevel.EDIT]: 2,
  [PlanPermissionLevel.ADMIN]: 3,
};

const REQUIRED_PLAN_PERMISSION_RANK: Record<PlanAccessLevel, number> = {
  view: 1,
  edit: 2,
  admin: 3,
};

// Select that returns the full plan item shape matching risk-management-app
const PLAN_ITEM_SELECT =
  'id, sort_order, item_type, wbs_number, is_critical_path, color, task_id, task:tasks!plan_tasks_task_id_fkey(id, key, summary, description, start_date, end_date, duration, progress, status, priority, estimated_time, actual_time, estimated_cost, actual_cost, completed_at, parent_task_id, assigned_to, task_type_id, created_by, updated_at, assignee:users!tasks_assigned_to_fkey(id, first_name, last_name, email, avatar_url))';

@Injectable()
export class PlansService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissionsService: PermissionsService,
    private readonly savedFiltersService: SavedFiltersService,
    private readonly outboxService?: AutomationEventOutboxService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async verifyPlan(
    planId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const { data, error } = await this.client
      .from('plans')
      .select(
        'id, space_id, organization_id, status, is_archived, start_date, end_date, progress, filter_id, settings',
      )
      .eq('id', planId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Plan not found');
    return data as unknown as Record<string, unknown>;
  }

  private getPlanSettings(
    plan: Record<string, unknown>,
  ): Record<string, unknown> {
    const settings = plan['settings'];
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return {};
    }
    return settings as Record<string, unknown>;
  }

  private planPermissionAllows(
    permission: PlanPermissionLevel | undefined,
    level: PlanAccessLevel,
  ): boolean {
    if (!permission) return false;
    return (
      PLAN_PERMISSION_RANK[permission] >= REQUIRED_PLAN_PERMISSION_RANK[level]
    );
  }

  /**
   * PERF: `isAdminOrOwner` depends only on (userId, organizationId), so inside a
   * per-plan loop it is loop-invariant and re-queries `organization_members` once
   * per row. Callers that iterate plans resolve it once and pass it in via
   * `precomputedIsAdminOrOwner`. Omitting the argument preserves the original
   * behaviour exactly, so single-plan callers are unaffected.
   */
  private async userCanAccessPlan(
    userId: string,
    organizationId: string,
    planId: string,
    spaceId: string,
    level: PlanAccessLevel,
    precomputedIsAdminOrOwner?: boolean,
  ): Promise<boolean> {
    const isAdminOrOwner =
      precomputedIsAdminOrOwner ??
      (await this.permissionsService.isAdminOrOwner(userId, organizationId));

    if (isAdminOrOwner) {
      return true;
    }

    const spaceAccess = await this.permissionsService.getUserSpacePermissions(
      userId,
      organizationId,
      spaceId,
    );

    if (spaceAccess.isMember) {
      const permissionKey =
        level === 'view'
          ? 'view_plans'
          : level === 'edit'
            ? 'edit_plans'
            : 'delete_plans';

      if (spaceAccess.permissions[permissionKey] === true) {
        return true;
      }
    }

    const { data: planPermission } = await this.client
      .from('plan_permissions')
      .select('permission_level')
      .eq('plan_id', planId)
      .eq('user_id', userId)
      .maybeSingle();

    const explicitLevel = (
      planPermission as { permission_level?: PlanPermissionLevel } | null
    )?.permission_level;

    return this.planPermissionAllows(explicitLevel, level);
  }

  private async assertUserCanAccessPlan(
    userId: string,
    organizationId: string,
    planId: string,
    spaceId: string,
    level: PlanAccessLevel,
  ): Promise<void> {
    if (
      !(await this.userCanAccessPlan(
        userId,
        organizationId,
        planId,
        spaceId,
        level,
      ))
    ) {
      throw new ForbiddenException('Insufficient plan permissions');
    }
  }

  private async assertSpacePlanPermission(
    userId: string,
    organizationId: string,
    spaceId: string,
    permissionKey:
      | 'view_plans'
      | 'create_plans'
      | 'edit_plans'
      | 'delete_plans',
  ): Promise<void> {
    const spaceAccess = await this.permissionsService.getUserSpacePermissions(
      userId,
      organizationId,
      spaceId,
    );

    if (
      !spaceAccess.isMember ||
      spaceAccess.permissions[permissionKey] !== true
    ) {
      throw new ForbiddenException('Insufficient space plan permissions');
    }
  }

  private async verifyPlanAccess(
    planId: string,
    organizationId: string,
    userId: string,
    level: PlanAccessLevel,
  ): Promise<Record<string, unknown>> {
    const plan = await this.verifyPlan(planId, organizationId);
    await this.assertUserCanAccessPlan(
      userId,
      organizationId,
      planId,
      (plan['space_id'] as string | null | undefined) ?? '',
      level,
    );

    return plan;
  }

  async assertCanEditPlan(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    return this.verifyPlanAccess(planId, organizationId, userId, 'edit');
  }

  private async getPlanTaskParentMap(
    planId: string,
  ): Promise<Map<string, string | null>> {
    const { data, error } = await this.client
      .from('plan_tasks')
      .select('task_id, task:tasks!plan_tasks_task_id_fkey(parent_task_id)')
      .eq('plan_id', planId);

    if (error) throw new BadRequestException(error.message);

    const parentMap = new Map<string, string | null>();
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const taskId = row['task_id'];
      const task = row['task'] as Record<string, unknown> | null;
      if (typeof taskId === 'string') {
        const parentTaskId = task?.['parent_task_id'];
        parentMap.set(
          taskId,
          typeof parentTaskId === 'string' ? parentTaskId : null,
        );
      }
    }

    return parentMap;
  }

  private assertParentDoesNotCreateCycle(
    parentMap: Map<string, string | null>,
    taskId: string,
    parentTaskId: string | null,
  ): void {
    if (!parentTaskId) return;
    if (parentTaskId === taskId) {
      throw new BadRequestException('A task cannot be its own parent');
    }

    const visited = new Set<string>();
    let current: string | null | undefined = parentTaskId;
    while (current) {
      if (current === taskId) {
        throw new BadRequestException(
          'Cannot move a task under its own descendant',
        );
      }
      if (visited.has(current)) {
        throw new BadRequestException('Task hierarchy contains a cycle');
      }
      visited.add(current);
      current = parentMap.get(current);
    }
  }

  private async validatePlanParentTaskId(
    planId: string,
    taskId: string | null,
    parentTaskId: string | null | undefined,
  ): Promise<string | null> {
    if (parentTaskId == null) return null;

    const parentMap = await this.getPlanTaskParentMap(planId);
    if (!parentMap.has(parentTaskId)) {
      throw new BadRequestException('Parent task must be in this plan');
    }

    if (taskId) {
      this.assertParentDoesNotCreateCycle(parentMap, taskId, parentTaskId);
    }

    return parentTaskId;
  }

  private mapItemRow(
    row: Record<string, unknown>,
    depth = 0,
  ): Record<string, unknown> {
    const task = row['task'] as Record<string, unknown> | null;
    return {
      // task fields
      id: task?.['id'],
      key: task?.['key'],
      name: task?.['summary'],
      description: task?.['description'],
      start_date: task?.['start_date'],
      end_date: task?.['end_date'],
      duration_days: task?.['duration'],
      progress: task?.['progress'] ?? 0,
      status: task?.['status'],
      completed_at: task?.['completed_at'],
      priority: task?.['priority'],
      assigned_to: task?.['assigned_to'],
      estimated_cost: task?.['estimated_cost'],
      actual_cost: task?.['actual_cost'],
      // estimated_time stored as minutes in tasks table
      estimated_hours:
        task?.['estimated_time'] != null
          ? Number(task['estimated_time']) / 60
          : null,
      parent_task_id: task?.['parent_task_id'],
      task_type_id: task?.['task_type_id'],
      assignee: task?.['assignee'],
      // plan-task fields
      plan_task_id: row['id'],
      item_type: row['item_type'],
      wbs_number: row['wbs_number'],
      sort_order: row['sort_order'],
      is_critical_path: row['is_critical_path'] ?? false,
      color: row['color'],
      task_id: row['task_id'],
      // tree fields
      children: [],
      depth,
    };
  }

  async hydratePlanProgress(plans: Record<string, unknown>[]): Promise<void> {
    if (plans.length === 0) return;

    const planIds = plans.map((plan) => String(plan['id'])).filter(Boolean);
    const { data, error } = await this.client
      .from('plan_tasks')
      .select('plan_id, task:tasks!plan_tasks_task_id_fkey(progress)')
      .in('plan_id', planIds);

    if (error) throw new BadRequestException(error.message);

    const progressMap = new Map<string, number[]>();
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      const planId = row['plan_id'] as string;
      const task = row['task'] as Record<string, unknown> | null;
      const value = Number(task?.['progress'] ?? 0);
      const values = progressMap.get(planId) ?? [];
      values.push(value);
      progressMap.set(planId, values);
    }

    for (const plan of plans) {
      const values = progressMap.get(String(plan['id']));
      if (values && values.length > 0) {
        plan['progress'] = Math.round(
          values.reduce((sum, value) => sum + value, 0) / values.length,
        );
      }
    }
  }

  // ---- Plans CRUD ----------------------------------------------------------

  async listPlans(
    organizationId: string,
    userId: string,
    query: {
      space_id?: string;
      search?: string;
      plan_type?: string;
      status?: string;
      owner_id?: string;
      is_archived?: boolean;
      page?: number;
      pageSize?: number;
    },
  ): Promise<{
    data: Record<string, unknown>[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
  }> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const from = (page - 1) * pageSize;
    const requestedSpaceId = query.space_id;
    const selectColumns =
      '*, owner:users!plans_owner_id_fkey(id, first_name, last_name, avatar_url), creator:users!plans_created_by_fkey(id, first_name, last_name, email)';

    if (requestedSpaceId) {
      await this.assertSpacePlanPermission(
        userId,
        organizationId,
        requestedSpaceId,
        'view_plans',
      );
    }

    if (!requestedSpaceId) {
      const fetchSize = Math.min(page * pageSize * 3, 500);
      let unrestrictedQuery = this.client
        .from('plans')
        .select(selectColumns)
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false })
        .range(0, fetchSize - 1);

      if (query.plan_type)
        unrestrictedQuery = unrestrictedQuery.eq('plan_type', query.plan_type);
      if (query.status)
        unrestrictedQuery = unrestrictedQuery.eq('status', query.status);
      if (query.owner_id)
        unrestrictedQuery = unrestrictedQuery.eq('owner_id', query.owner_id);
      unrestrictedQuery = unrestrictedQuery.eq(
        'is_archived',
        this.resolveArchivedFilter(query),
      );
      if (query.search)
        unrestrictedQuery = unrestrictedQuery.ilike(
          'name',
          `%${query.search}%`,
        );

      const { data, error } = await unrestrictedQuery;
      if (error) throw new BadRequestException(error.message);

      // PERF: resolve the loop-invariant admin/owner check once instead of once
      // per plan. An admin/owner passes `userCanAccessPlan` unconditionally, so
      // the whole per-plan permission loop collapses to a copy in that case.
      const isAdminOrOwner = await this.permissionsService.isAdminOrOwner(
        userId,
        organizationId,
      );

      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      const allowed: Record<string, unknown>[] = [];

      if (isAdminOrOwner) {
        allowed.push(...rows);
      } else {
        for (const plan of rows) {
          if (
            await this.userCanAccessPlan(
              userId,
              organizationId,
              String(plan['id']),
              (plan['space_id'] as string | null | undefined) ?? '',
              'view',
              false,
            )
          ) {
            allowed.push(plan);
          }
        }
      }

      const pageData = allowed.slice(from, from + pageSize);
      await this.hydratePlanProgress(pageData);
      const total = allowed.length;
      return {
        data: pageData,
        total,
        page,
        pageSize,
        hasMore:
          allowed.length > from + pageSize || (data ?? []).length === fetchSize,
      };
    }

    let q = this.client
      .from('plans')
      .select(selectColumns, { count: 'exact' })
      .eq('organization_id', organizationId)
      .range(from, from + pageSize - 1)
      .order('created_at', { ascending: false });

    if (requestedSpaceId) q = q.eq('space_id', requestedSpaceId);
    if (query.plan_type) q = q.eq('plan_type', query.plan_type);
    if (query.status) q = q.eq('status', query.status);
    if (query.owner_id) q = q.eq('owner_id', query.owner_id);
    q = q.eq('is_archived', this.resolveArchivedFilter(query));
    if (query.search) q = q.ilike('name', `%${query.search}%`);

    const { data, error, count } = await q;
    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as unknown as Record<string, unknown>[];

    await this.hydratePlanProgress(rows);
    const total = count ?? 0;
    return {
      data: rows,
      total,
      page,
      pageSize,
      hasMore: from + pageSize < total,
    };
  }

  async listOrganizationPlans(
    organizationId: string,
    userId: string,
    query: {
      search?: string;
      includeArchived?: boolean;
      excludePlanIds?: string[];
      page?: number;
      pageSize?: number;
    },
  ): Promise<{
    data: Record<string, unknown>[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
  }> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const from = 0;
    const requestedFrom = (page - 1) * pageSize;
    const fetchSize = Math.min(page * pageSize * 3, 500);
    const excluded = query.excludePlanIds ?? [];
    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (excluded.length > 500 || excluded.some((id) => !uuidRe.test(id))) {
      throw new BadRequestException(
        'exclude_plan_ids must be a list of valid UUIDs',
      );
    }

    let q = this.client
      .from('plans')
      .select(
        '*, owner:users!plans_owner_id_fkey(id, first_name, last_name, avatar_url), creator:users!plans_created_by_fkey(id, first_name, last_name, email), space:spaces!space_id(id, key, name)',
      )
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .range(from, from + fetchSize - 1);

    if (!query.includeArchived) q = q.eq('is_archived', false);
    if (query.search) {
      const safe = query.search.replace(/[,.()"'\\]/g, '');
      if (safe.length > 0) q = q.ilike('name', `%${safe}%`);
    }
    for (const planId of excluded) q = q.neq('id', planId);

    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    // PERF: see listPlans — the admin/owner check is loop-invariant, so resolve
    // it once per request rather than once per plan.
    const isAdminOrOwner = await this.permissionsService.isAdminOrOwner(
      userId,
      organizationId,
    );

    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    const allowed: Record<string, unknown>[] = [];

    if (isAdminOrOwner) {
      allowed.push(...rows);
    } else {
      for (const plan of rows) {
        if (
          await this.userCanAccessPlan(
            userId,
            organizationId,
            String(plan['id']),
            (plan['space_id'] as string | null | undefined) ?? '',
            'view',
            false,
          )
        ) {
          allowed.push(plan);
        }
      }
    }
    const pageData = allowed.slice(requestedFrom, requestedFrom + pageSize);
    await this.hydratePlanProgress(pageData);
    const hasMore =
      allowed.length > requestedFrom + pageSize ||
      (data ?? []).length === fetchSize;
    return {
      data: pageData,
      total: allowed.length,
      page,
      pageSize,
      hasMore,
    };
  }

  /**
   * `trusted.id` (Robert's Confirm, XE-T353 1.22): the reserved id, so a repeated create collides on
   * the primary key instead of making a second plan. Never reachable from a client.
   */
  async createPlan(
    organizationId: string,
    userId: string,
    dto: CreatePlanDto,
    trusted?: { id?: string },
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const { space_id: canonicalSpaceId, spaceId: legacySpaceId } = dto;
    const createFields = { ...(dto as unknown as Record<string, unknown>) };
    delete createFields['space_id'];
    delete createFields['spaceId'];
    delete createFields['organizationId'];
    delete createFields['organization_id'];
    const spaceId = this.normalizeRequiredAlias(
      'space_id',
      canonicalSpaceId,
      legacySpaceId,
    );

    await this.assertSpacePlanPermission(
      userId,
      organizationId,
      spaceId,
      'create_plans',
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('plans')
      .insert({
        ...createFields,
        ...(trusted?.id && { id: trusted.id }),
        space_id: spaceId,
        currency: dto.currency ?? 'EUR',
        organization_id: organizationId,
        created_by: userId,
        status: 'draft',
        progress: 0,
        sort_order: 0,
        settings: dto.settings ?? {},
      })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    const row = data as unknown as Record<string, unknown>;

    await this.client.from('plan_permissions').insert({
      plan_id: row['id'],
      user_id: userId,
      permission_level: PlanPermissionLevel.ADMIN,
    });

    void this.logMutationAudit(
      organizationId,
      userId,
      'plan',
      row['id'] as string,
      'create',
      {
        space_id: spaceId,
        name: dto.name,
        plan_type: dto.plan_type ?? 'waterfall',
      },
    );

    void this.outboxService?.write(
      organizationId,
      spaceId,
      'app.plan.created',
      {
        plan: {
          id: row['id'],
          name: row['name'],
          space_id: spaceId,
          status: row['status'],
        },
        plan_id: row['id'],
        space_id: spaceId,
        created_by: userId,
      },
    );

    return { data: row, success: true };
  }

  private normalizeRequiredAlias(
    canonicalName: string,
    canonicalValue?: string,
    legacyValue?: string,
  ): string {
    if (canonicalValue && legacyValue && canonicalValue !== legacyValue) {
      throw new BadRequestException(`${canonicalName} mismatch`);
    }

    const value = canonicalValue ?? legacyValue;
    if (!value) {
      throw new BadRequestException(`${canonicalName} is required`);
    }
    return value;
  }

  async getPlan(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Record<string, unknown> }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'view');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('plans')
      .select(
        '*, owner:users!plans_owner_id_fkey(id, first_name, last_name, avatar_url), creator:users!plans_created_by_fkey(id, first_name, last_name, email)',
      )
      .eq('id', planId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Plan not found');

    const plan = data as unknown as Record<string, unknown>;

    // Fetch items + counts + active baseline to preserve the legacy detail shape.
    const [planItemsRes, stakeholderCountRes, riskCountRes, activeBaselineRes] =
      await Promise.all([
        this.client
          .from('plan_tasks')
          .select(PLAN_ITEM_SELECT)
          .eq('plan_id', planId),
        this.client
          .from('plan_stakeholders')
          .select('id', { count: 'exact', head: true })
          .eq('plan_id', planId),
        this.client
          .from('plan_risks')
          .select('id', { count: 'exact', head: true })
          .eq('plan_id', planId),
        this.client
          .from('plan_baselines')
          .select('*')
          .eq('plan_id', planId)
          .eq('is_active', true)
          .maybeSingle(),
      ]);

    if (planItemsRes.error) {
      throw new BadRequestException(planItemsRes.error.message);
    }

    const planItems = (
      (planItemsRes.data ?? []) as unknown as Record<string, unknown>[]
    ).map((item) => this.mapItemRow(item));

    return {
      data: {
        ...plan,
        items: planItems,
        item_count: planItems.length,
        stakeholder_count: stakeholderCountRes.count ?? 0,
        risk_count: riskCountRes.count ?? 0,
        active_baseline:
          (activeBaselineRes.data as unknown as Record<
            string,
            unknown
          > | null) ?? null,
      },
    };
  }

  async setRagManually(
    planId: string,
    organizationId: string,
    userId: string,
    ragStatus: 'green' | 'amber' | 'red',
  ): Promise<Record<string, unknown>> {
    const plan = await this.verifyPlan(planId, organizationId);
    await this.assertUserCanAccessPlan(
      userId,
      organizationId,
      planId,
      (plan['space_id'] as string | null | undefined) ?? '',
      'edit',
    );
    const settings = this.getPlanSettings(plan);
    const previousRag =
      typeof settings['rag'] === 'object' && settings['rag'] !== null
        ? (settings['rag'] as Record<string, unknown>)
        : {};
    const rag = {
      status: ragStatus,
      set_manually: true,
      set_at: new Date().toISOString(),
      set_by: userId,
    };

    const ragResult = (await this.client
      .from('plans')
      .update({ settings: { ...settings, rag } })
      .eq('id', planId)
      .eq('organization_id', organizationId)
      .select()
      .single()) as { data: unknown; error: { message: string } | null };

    if (ragResult.error) throw new BadRequestException(ragResult.error.message);
    await this.logPlanAudit(organizationId, userId, planId, {
      rag_status: ragStatus,
      rag_set_manually: true,
      previous_status: previousRag['status'],
    });
    return {
      ...(ragResult.data as Record<string, unknown>),
      rag_status: ragStatus,
      rag_set_manually: true,
    };
  }

  async clearManualRag(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<{
    rag_status: 'green' | 'amber' | 'red' | 'unknown';
    rag_set_manually: false;
  }> {
    const plan = await this.verifyPlan(planId, organizationId);
    await this.assertUserCanAccessPlan(
      userId,
      organizationId,
      planId,
      (plan['space_id'] as string | null | undefined) ?? '',
      'edit',
    );
    const computed = await this.computeRag(planId, organizationId, true);
    const settings = this.getPlanSettings(plan);
    const rag = {
      status: computed,
      set_manually: false,
      set_at: null,
      set_by: null,
    };

    const { error } = await this.client
      .from('plans')
      .update({ settings: { ...settings, rag } })
      .eq('id', planId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
    await this.logPlanAudit(organizationId, userId, planId, {
      rag_status: computed,
      rag_set_manually: false,
    });
    return { rag_status: computed, rag_set_manually: false };
  }

  private async computeRag(
    planId: string,
    organizationId: string,
    ignoreManualOverride = false,
  ): Promise<'green' | 'amber' | 'red' | 'unknown'> {
    const { data, error } = await this.client
      .from('plans')
      .select('id, end_date, progress, settings')
      .eq('id', planId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Plan not found');
    const plan = data as Record<string, unknown>;
    const settings = this.getPlanSettings(plan);
    const rag =
      typeof settings['rag'] === 'object' && settings['rag'] !== null
        ? (settings['rag'] as Record<string, unknown>)
        : null;
    if (!ignoreManualOverride && rag?.['set_manually']) {
      return (
        (rag['status'] as 'green' | 'amber' | 'red' | 'unknown') ?? 'unknown'
      );
    }

    const evm = await this.getEvmMetrics(planId, organizationId);
    if (!evm) return 'unknown';
    const spi = Number(evm['schedule_performance_index'] ?? 0);
    const cpi = Number(evm['cost_performance_index'] ?? 0);
    const overdue =
      plan['end_date'] &&
      new Date(plan['end_date'] as string).getTime() < Date.now() &&
      Number(plan['progress'] ?? 0) < 100;

    if (overdue || spi < 0.85 || cpi < 0.85) return 'red';
    if (spi < 0.95 || cpi < 0.95) return 'amber';
    return 'green';
  }

  private async logPlanAudit(
    organizationId: string,
    userId: string,
    planId: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.logMutationAudit(
      organizationId,
      userId,
      'plan',
      planId,
      'update',
      changes,
    );
  }

  private async logMutationAudit(
    organizationId: string,
    userId: string | undefined,
    entityType: string,
    entityId: string,
    action: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    if (!userId) return;

    try {
      await this.client.from('audit_logs').insert({
        organization_id: organizationId,
        user_id: userId,
        entity_type: entityType,
        entity_id: entityId,
        action,
        changes,
      });
    } catch {
      // Audit failures must not break the primary mutation.
    }
  }

  async updatePlan(
    planId: string,
    organizationId: string,
    userId: string,
    dto: UpdatePlanDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const plan = await this.verifyPlanAccess(
      planId,
      organizationId,
      userId,
      'edit',
    );

    const dtoRecord = dto as Record<string, unknown>;
    const { status, is_archived } = dto;
    const updateFields = { ...dtoRecord };
    delete updateFields['id'];
    delete updateFields['organizationId'];
    delete updateFields['organization_id'];
    delete updateFields['status'];
    delete updateFields['is_archived'];
    const updateDto: Record<string, unknown> = { ...updateFields };

    const changesArchiveState =
      is_archived !== undefined ||
      status === PlanStatus.ARCHIVED ||
      (plan['is_archived'] === true && status !== undefined);

    if (changesArchiveState) {
      await this.verifyPlanAccess(planId, organizationId, userId, 'admin');

      if (is_archived === true && status && status !== PlanStatus.ARCHIVED) {
        throw new BadRequestException(
          'Archived plans must use the archived status',
        );
      }

      if (is_archived === false && status === PlanStatus.ARCHIVED) {
        throw new BadRequestException(
          'Archived status must set is_archived to true',
        );
      }

      if (status !== undefined) updateDto['status'] = status;
      if (is_archived !== undefined) updateDto['is_archived'] = is_archived;
      if (status === PlanStatus.ARCHIVED && is_archived === undefined) {
        updateDto['is_archived'] = true;
      }
      if (
        plan['is_archived'] === true &&
        status !== undefined &&
        status !== PlanStatus.ARCHIVED &&
        is_archived === undefined
      ) {
        updateDto['is_archived'] = false;
      }
      if (is_archived === true && status === undefined) {
        updateDto['status'] = PlanStatus.ARCHIVED;
      }
      if (is_archived === false && status === undefined) {
        updateDto['status'] = PlanStatus.DRAFT;
      }
    } else if (status !== undefined) {
      updateDto['status'] = status;
    }

    const filterId =
      typeof updateDto['filter_id'] === 'string'
        ? updateDto['filter_id']
        : undefined;
    if (filterId) {
      await this.savedFiltersService.getById(filterId, organizationId, userId);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('plans')
      .update({ ...updateDto, updated_at: new Date().toISOString() })
      .eq('id', planId)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    const updatedPlan = data as unknown as Record<string, unknown>;

    void this.logMutationAudit(
      organizationId,
      userId,
      'plan',
      planId,
      'update',
      { fields: Object.keys(updateDto) },
    );

    if (updateDto['status'] === 'published') {
      void this.outboxService?.write(
        organizationId,
        updatedPlan['space_id'] as string,
        'app.plan.published',
        {
          plan: {
            id: planId,
            name: updatedPlan['name'],
            space_id: updatedPlan['space_id'],
            status: updatedPlan['status'],
          },
          plan_id: planId,
          space_id: updatedPlan['space_id'],
          updated_by: userId,
        },
      );
    }

    return { data: updatedPlan, success: true };
  }

  /**
   * Resolve the `is_archived` filter for a plan list query.
   *
   * `status` and `is_archived` are perfectly correlated (`archived` <-> true), so a caller asking
   * for `status='archived'` must not also be forced through the `is_archived=false` default —
   * that combination matches nothing and is why archived plans appeared to vanish entirely.
   * An explicit `is_archived` in the query always wins.
   */
  private resolveArchivedFilter(query: {
    status?: string;
    is_archived?: boolean;
  }): boolean {
    return query.is_archived ?? query.status === 'archived';
  }

  async deletePlan(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    const plan = await this.verifyPlanAccess(
      planId,
      organizationId,
      userId,
      'admin',
    );
    if (!plan['is_archived']) {
      throw new BadRequestException('Plan must be archived before deletion');
    }

    const { error } = await this.client.from('plans').delete().eq('id', planId);
    if (error) throw new BadRequestException(error.message);
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan',
      planId,
      'delete',
      {
        status: plan['status'],
        is_archived: plan['is_archived'],
      },
    );
    return { success: true, message: 'Plan deleted' };
  }

  async archivePlan(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'admin');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('plans')
      .update({
        is_archived: true,
        status: 'archived',
        archived_at: new Date().toISOString(),
        archived_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', planId)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan',
      planId,
      'archive',
      { is_archived: true, status: 'archived' },
    );
    return { data: data as unknown as Record<string, unknown>, success: true };
  }

  async unarchivePlan(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'admin');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('plans')
      .update({
        is_archived: false,
        status: 'draft',
        archived_at: null,
        archived_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', planId)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan',
      planId,
      'restore',
      { is_archived: false, status: 'draft' },
    );
    return { data: data as unknown as Record<string, unknown>, success: true };
  }

  async refreshPlan(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ added: number; removed: number }> {
    const plan = await this.verifyPlanAccess(
      planId,
      organizationId,
      userId,
      'edit',
    );

    const filterId = plan['filter_id'] as string | null | undefined;
    if (!filterId) return { added: 0, removed: 0 };

    const filterResult = await this.savedFiltersService.executeFilter(
      filterId,
      organizationId,
      userId,
      { page: 1, pageSize: 10000 },
    );

    const filterRows = (filterResult.data.data ?? []) as Array<{
      id?: unknown;
      entity_type?: unknown;
    }>;
    const filterTasks = filterRows.filter((row) => row.entity_type === 'task');
    const rawFilterTaskIds = filterTasks
      .map((row) => row.id)
      .filter((id): id is string => typeof id === 'string');

    if (rawFilterTaskIds.length === 0) return { added: 0, removed: 0 };

    const { data: scopedTasks, error: scopedTasksError } = await this.client
      .from('tasks')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('space_id', plan['space_id'] as string)
      .in('id', rawFilterTaskIds);
    if (scopedTasksError) {
      throw new BadRequestException(scopedTasksError.message);
    }

    const filterTaskIds = ((scopedTasks ?? []) as { id: string }[]).map(
      (row) => row.id,
    );
    if (filterTaskIds.length === 0) return { added: 0, removed: 0 };

    const { data: currentRows, error: currentError } = await this.client
      .from('plan_tasks')
      .select('task_id')
      .eq('plan_id', planId);
    if (currentError) throw new BadRequestException(currentError.message);

    const currentIds = new Set(
      ((currentRows ?? []) as { task_id: string }[]).map((row) => row.task_id),
    );
    const newTaskIds = filterTaskIds.filter(
      (taskId) => !currentIds.has(taskId),
    );

    if (newTaskIds.length === 0) return { added: 0, removed: 0 };

    const { count } = await this.client
      .from('plan_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('plan_id', planId);
    let sortOrder = count ?? 0;

    const rows = newTaskIds.map((taskId) => ({
      plan_id: planId,
      task_id: taskId,
      item_type: PlanItemType.TASK,
      sort_order: sortOrder++,
    }));

    const { error: insertError } = await this.client
      .from('plan_tasks')
      .insert(rows);
    if (insertError) throw new BadRequestException(insertError.message);

    await this.recalculateWbs(planId);
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan',
      planId,
      'refresh',
      { added: newTaskIds.length, removed: 0, filter_id: filterId },
    );
    return { added: newTaskIds.length, removed: 0 };
  }

  // ---- Items ---------------------------------------------------------------

  async listItems(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Record<string, unknown>[] }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'view');

    const { data, error } = await this.client
      .from('plan_tasks')
      .select(PLAN_ITEM_SELECT)
      .eq('plan_id', planId)
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    return { data: rows.map((r) => this.mapItemRow(r)) };
  }

  async addItem(
    planId: string,
    organizationId: string,
    userId: string,
    dto: CreatePlanItemDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const plan = await this.verifyPlanAccess(
      planId,
      organizationId,
      userId,
      'edit',
    );

    let taskId: string;

    if (dto.linked_task_id) {
      const { data: existingTask, error: taskError } = (await this.client
        .from('tasks')
        .select('id, space_id')
        .eq('id', dto.linked_task_id)
        .eq('organization_id', organizationId)
        .maybeSingle()) as {
        data: { id: string; space_id: string } | null;
        error: { message: string } | null;
      };

      if (taskError) throw new BadRequestException(taskError.message);
      if (!existingTask) throw new NotFoundException('Task not found');
      if (
        existingTask.space_id !==
        ((plan['space_id'] as string | null | undefined) ?? '')
      ) {
        throw new BadRequestException('Task must belong to the plan space');
      }
      const { data: existingPlanTask, error: existingPlanTaskError } =
        await this.client
          .from('plan_tasks')
          .select('id')
          .eq('plan_id', planId)
          .eq('task_id', dto.linked_task_id)
          .maybeSingle();
      if (existingPlanTaskError) {
        throw new BadRequestException(existingPlanTaskError.message);
      }
      if (existingPlanTask) {
        throw new ConflictException('Task is already in this plan');
      }
      taskId = dto.linked_task_id;

      // Apply the schedule the caller sent with the link.
      //
      // `plan_tasks` is a pure join table (plan_id, task_id, item_type, wbs,
      // sort_order, colour) — it has nowhere to put a date or a percentage, so
      // the task row is the ONLY place a plan item's schedule can live. The
      // sibling branch below already writes exactly these fields when it creates
      // a task; this branch used to take `linked_task_id` and drop the rest on
      // the floor, so `POST /plans/:id/items` validated start_date, end_date,
      // duration_days, progress and estimated_hours, answered 201, and silently
      // persisted none of them. A Gantt embed then rendered every linked item at
      // 0% with no bar. Only fields the caller actually supplied are written, so
      // linking a task without a schedule still leaves it untouched.
      const linkedUpdates: Record<string, unknown> = {};

      if (dto.start_date !== undefined)
        linkedUpdates['start_date'] = dto.start_date;
      if (dto.end_date !== undefined) {
        linkedUpdates['end_date'] = dto.end_date;
        linkedUpdates['due_date'] = dto.end_date;
      }
      if (dto.duration_days !== undefined)
        linkedUpdates['duration'] = dto.duration_days;
      if (dto.progress !== undefined) linkedUpdates['progress'] = dto.progress;
      if (dto.estimated_hours !== undefined) {
        linkedUpdates['estimated_time'] = dto.estimated_hours * 60;
      }
      if (dto.estimated_cost !== undefined) {
        linkedUpdates['estimated_cost'] = dto.estimated_cost;
      }

      if (Object.keys(linkedUpdates).length > 0) {
        const { error: linkedUpdateError } = await this.client
          .from('tasks')
          .update(linkedUpdates)
          .eq('id', taskId)
          .eq('organization_id', organizationId);

        if (linkedUpdateError) {
          throw new BadRequestException(linkedUpdateError.message);
        }
      }
    } else {
      taskId = await this.insertPlanItemTask(
        planId,
        plan,
        organizationId,
        userId,
        dto,
      );
    }

    const { count } = await this.client
      .from('plan_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('plan_id', planId);

    const { data: planTask, error: planTaskError } = await this.client
      .from('plan_tasks')
      .insert({
        plan_id: planId,
        task_id: taskId,
        item_type: dto.item_type ?? PlanItemType.TASK,
        sort_order: dto.sort_order ?? (count ?? 0) + 1,
        color: dto.color,
      })
      .select(PLAN_ITEM_SELECT)
      .single();

    if (planTaskError) {
      if (!dto.linked_task_id) {
        await this.client.from('tasks').delete().eq('id', taskId);
      }
      throw new BadRequestException(planTaskError.message);
    }

    await this.recalculateWbs(planId);

    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_item',
      taskId,
      'create',
      {
        plan_id: planId,
        item_type: dto.item_type ?? PlanItemType.TASK,
        linked_task_id: dto.linked_task_id ?? null,
      },
    );

    return {
      data: this.mapItemRow(planTask as unknown as Record<string, unknown>),
      success: true,
    };
  }

  /**
   * The task of a new plan item, exactly as addItem writes it. `trusted.taskId` (Robert's Confirm,
   * XE-T353 1.22) is the reserved id: a repeated insert collides on the primary key instead of
   * making a second task. Never reachable from a client.
   */
  async insertPlanItemTask(
    planId: string,
    plan: Record<string, unknown>,
    organizationId: string,
    userId: string,
    dto: CreatePlanItemDto,
    trusted?: { taskId?: string; estimatedMinutes?: number },
  ): Promise<string> {
    const parentTaskId = await this.validatePlanParentTaskId(
      planId,
      null,
      dto.parent_id,
    );

    // Compute end_date from duration_days if not provided
    let end_date = dto.end_date;
    if (!end_date && dto.start_date && dto.duration_days) {
      const d = new Date(dto.start_date);
      d.setDate(d.getDate() + dto.duration_days);
      end_date = d.toISOString().slice(0, 10);
    }

    // estimated_time stored as minutes in tasks
    // Robert passes whole minutes (estimated_time is an integer); a person's call is as before.
    const estimated_time =
      trusted?.estimatedMinutes ??
      (dto.estimated_hours != null ? dto.estimated_hours * 60 : undefined);

    // Resolve task_type_id from hierarchy config when not provided.
    // Legacy plan item creation falls back to the base task type.
    let taskTypeId: string = dto.task_type_id ?? '';
    if (!taskTypeId) {
      const { data: hierarchyRow } = await this.client
        .from('task_hierarchy_configurations')
        .select('config')
        .eq('space_id', plan['space_id'])
        .maybeSingle();
      if (hierarchyRow) {
        const config =
          typeof (hierarchyRow as Record<string, unknown>)['config'] ===
          'string'
            ? (JSON.parse(
                (hierarchyRow as Record<string, unknown>)['config'] as string,
              ) as Record<string, unknown>)
            : ((hierarchyRow as Record<string, unknown>)['config'] as Record<
                string,
                unknown
              >);
        const levels =
          (config?.['levels'] as Array<Record<string, unknown>>) ?? [];
        const active =
          levels.find((l) => l['id'] === 'task' && l['is_active'] !== false) ??
          levels.find((l) => l['is_active'] !== false);
        taskTypeId = (active?.['id'] as string | undefined) ?? 'task';
      }
    }
    if (!taskTypeId) taskTypeId = 'task';

    const { data: newTask, error: createError } = await this.client
      .from('tasks')
      .insert({
        ...(trusted?.taskId && { id: trusted.taskId }),
        space_id: plan['space_id'],
        organization_id: organizationId,
        summary: dto.name,
        description: dto.description,
        start_date: dto.start_date,
        end_date,
        due_date: end_date,
        duration: dto.duration_days,
        parent_task_id: parentTaskId,
        priority: dto.priority ?? 'medium',
        assigned_to: dto.assigned_to,
        estimated_cost: dto.estimated_cost,
        estimated_time,
        task_type_id: taskTypeId,
        progress: dto.progress ?? 0,
        created_by: userId,
        status: 'open',
      })
      .select('id')
      .single();

    if (createError) throw new BadRequestException(createError.message);
    return (newTask as unknown as Record<string, unknown>)['id'] as string;
  }

  /** The audit row a person's addItem writes, for a plan item written by Robert's Confirm (1.22). */
  auditPlanItemCreated(
    organizationId: string,
    userId: string,
    taskId: string,
    planId: string,
    itemType: string,
    linkedTaskId: string | null = null,
  ): Promise<void> {
    return this.logMutationAudit(
      organizationId,
      userId,
      'plan_item',
      taskId,
      'create',
      {
        plan_id: planId,
        item_type: itemType,
        linked_task_id: linkedTaskId,
      },
    );
  }

  /**
   * Robert 1.23: the audit row a person's add or edit writes (plan_risk, plan_stakeholder, a plan
   * item's dates), for a row Robert's Confirm wrote.
   */
  auditPlanChange(
    organizationId: string,
    userId: string,
    entityType: 'plan_risk' | 'plan_stakeholder' | 'plan_item',
    entityId: string,
    action: 'create' | 'update',
    changes: Record<string, unknown>,
  ): Promise<void> {
    return this.logMutationAudit(organizationId, userId, entityType, entityId, action, changes);
  }

  /** The audit row a person's dependency gets, for one Robert wrote (1.22.1). */
  auditDependencyCreated(
    organizationId: string,
    userId: string,
    relationshipId: string,
    planId: string,
    predecessorId: string,
    successorId: string,
    dependencyType: string,
  ): Promise<void> {
    return this.logMutationAudit(
      organizationId,
      userId,
      'plan_dependency',
      relationshipId,
      'create',
      {
        plan_id: planId,
        predecessor_id: predecessorId,
        successor_id: successorId,
        dependency_type: dependencyType,
      },
    );
  }

  async getItem(
    planId: string,
    itemId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Record<string, unknown> }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'view');

    // itemId can be either plan_task.id or task.id — try both
    const { data, error } = await this.client
      .from('plan_tasks')
      .select(PLAN_ITEM_SELECT)
      .eq('plan_id', planId)
      .or(`id.eq.${itemId},task_id.eq.${itemId}`)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Plan item not found');
    return {
      data: this.mapItemRow(data as unknown as Record<string, unknown>),
    };
  }

  async updateItem(
    planId: string,
    itemId: string,
    organizationId: string,
    userId: string,
    dto: UpdatePlanItemDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'edit');

    const { data: existing, error: findError } = await this.client
      .from('plan_tasks')
      .select('id, task_id')
      .eq('plan_id', planId)
      .or(`id.eq.${itemId},task_id.eq.${itemId}`)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Plan item not found');

    const row = existing as unknown as Record<string, unknown>;
    const planTaskId = row['id'] as string;
    const taskId = row['task_id'] as string;

    // Task fields
    const taskUpdate: Record<string, unknown> = {};
    if (dto.name !== undefined) taskUpdate['summary'] = dto.name;
    if (dto.description !== undefined)
      taskUpdate['description'] = dto.description;
    if (dto.start_date !== undefined) taskUpdate['start_date'] = dto.start_date;
    if (dto.end_date !== undefined) {
      taskUpdate['end_date'] = dto.end_date;
      taskUpdate['due_date'] = dto.end_date;
    }
    if (dto.duration_days !== undefined)
      taskUpdate['duration'] = dto.duration_days;
    if (dto.priority !== undefined) taskUpdate['priority'] = dto.priority;
    if (dto.assigned_to !== undefined)
      taskUpdate['assigned_to'] = dto.assigned_to;
    if (dto.estimated_hours !== undefined)
      taskUpdate['estimated_time'] = dto.estimated_hours * 60;
    if (dto.actual_hours !== undefined)
      taskUpdate['actual_time'] = dto.actual_hours * 60;
    if (dto.estimated_cost !== undefined)
      taskUpdate['estimated_cost'] = dto.estimated_cost;
    if (dto.actual_cost !== undefined)
      taskUpdate['actual_cost'] = dto.actual_cost;
    if (dto.progress !== undefined) taskUpdate['progress'] = dto.progress;
    if (dto.status !== undefined) taskUpdate['status'] = dto.status;
    if (dto.parent_id !== undefined) {
      taskUpdate['parent_task_id'] = await this.validatePlanParentTaskId(
        planId,
        taskId,
        dto.parent_id,
      );
    }
    if (dto.task_type_id !== undefined)
      taskUpdate['task_type_id'] = dto.task_type_id;

    if (dto.start_date && dto.end_date) {
      const start = new Date(dto.start_date);
      const end = new Date(dto.end_date);
      taskUpdate['duration'] = Math.max(
        0,
        Math.round((end.getTime() - start.getTime()) / 86_400_000),
      );
    }

    if (dto.start_date && dto.duration_days != null && !dto.end_date) {
      const start = new Date(dto.start_date);
      start.setDate(start.getDate() + dto.duration_days);
      taskUpdate['end_date'] = start.toISOString();
      taskUpdate['due_date'] = taskUpdate['end_date'];
    }

    if (Object.keys(taskUpdate).length > 0) {
      taskUpdate['updated_at'] = new Date().toISOString();
      const { error } = await this.client
        .from('tasks')
        .update(taskUpdate)
        .eq('id', taskId);
      if (error) throw new BadRequestException(error.message);
    }

    // Plan task fields
    const planTaskUpdate: Record<string, unknown> = {};
    if (dto.item_type !== undefined)
      planTaskUpdate['item_type'] = dto.item_type;
    if (dto.color !== undefined) planTaskUpdate['color'] = dto.color;
    if (dto.sort_order !== undefined)
      planTaskUpdate['sort_order'] = dto.sort_order;
    if (dto.is_critical_path !== undefined)
      planTaskUpdate['is_critical_path'] = dto.is_critical_path;

    if (Object.keys(planTaskUpdate).length > 0) {
      const { error } = await this.client
        .from('plan_tasks')
        .update(planTaskUpdate)
        .eq('id', planTaskId);
      if (error) throw new BadRequestException(error.message);
    }

    await this.recalculateWbs(planId);

    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_item',
      taskId,
      'update',
      {
        plan_id: planId,
        fields: [...Object.keys(taskUpdate), ...Object.keys(planTaskUpdate)],
      },
    );

    const { data: updated, error: readError } = await this.client
      .from('plan_tasks')
      .select(PLAN_ITEM_SELECT)
      .eq('id', planTaskId)
      .single();

    if (readError) throw new BadRequestException(readError.message);
    return {
      data: this.mapItemRow(updated as unknown as Record<string, unknown>),
      success: true,
    };
  }

  async removeItem(
    planId: string,
    itemId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'edit');

    const { data: existing, error: findError } = await this.client
      .from('plan_tasks')
      .select('id')
      .eq('plan_id', planId)
      .or(`id.eq.${itemId},task_id.eq.${itemId}`)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Plan item not found');

    const planTaskId = (existing as unknown as Record<string, unknown>)[
      'id'
    ] as string;
    const { error } = await this.client
      .from('plan_tasks')
      .delete()
      .eq('id', planTaskId);
    if (error) throw new BadRequestException(error.message);

    await this.recalculateWbs(planId);
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_item',
      planTaskId,
      'delete',
      { plan_id: planId },
    );
    return { success: true, message: 'Item deleted' };
  }

  async moveItem(
    planId: string,
    itemId: string,
    organizationId: string,
    userId: string,
    dto: MovePlanItemDto,
  ): Promise<{ success: true }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'edit');

    const { data: existing, error: findError } = await this.client
      .from('plan_tasks')
      .select('id, task_id')
      .eq('plan_id', planId)
      .or(`id.eq.${itemId},task_id.eq.${itemId}`)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Plan item not found');

    const row = existing as unknown as Record<string, unknown>;
    const taskId = row['task_id'] as string;
    const planTaskId = row['id'] as string;

    const parentTaskId = await this.validatePlanParentTaskId(
      planId,
      taskId,
      dto.new_parent_id,
    );

    const taskUpdate: Record<string, unknown> = {
      parent_task_id: parentTaskId,
    };
    const { error: taskUpdateError } = await this.client
      .from('tasks')
      .update(taskUpdate)
      .eq('id', taskId);
    if (taskUpdateError) throw new BadRequestException(taskUpdateError.message);

    if (dto.sort_order !== undefined) {
      const { error: sortError } = await this.client
        .from('plan_tasks')
        .update({ sort_order: dto.sort_order })
        .eq('id', planTaskId);
      if (sortError) throw new BadRequestException(sortError.message);
    }

    await this.recalculateWbs(planId);
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_item',
      taskId,
      'move',
      {
        plan_id: planId,
        parent_task_id: parentTaskId,
        sort_order: dto.sort_order ?? null,
      },
    );
    return { success: true };
  }

  async reorderItems(
    planId: string,
    organizationId: string,
    userId: string,
    dto: ReorderPlanItemsDto,
  ): Promise<{ success: true }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'edit');

    const { data: planRows, error: planRowsError } = await this.client
      .from('plan_tasks')
      .select('id, task_id, task:tasks!plan_tasks_task_id_fkey(parent_task_id)')
      .eq('plan_id', planId);
    if (planRowsError) throw new BadRequestException(planRowsError.message);

    const planTaskIdByTaskId = new Map<string, string>();
    const parentMap = new Map<string, string | null>();
    for (const row of (planRows ?? []) as Array<Record<string, unknown>>) {
      const taskId = row['task_id'];
      if (typeof taskId !== 'string') continue;
      const planTaskId = row['id'];
      if (typeof planTaskId === 'string') {
        planTaskIdByTaskId.set(taskId, planTaskId);
      }
      const task = row['task'] as Record<string, unknown> | null;
      const parentTaskId = task?.['parent_task_id'];
      parentMap.set(
        taskId,
        typeof parentTaskId === 'string' ? parentTaskId : null,
      );
    }

    const normalizedItems = dto.items.map((item) => ({
      task_id: item.task_id ?? item.id,
      sort_order: item.sort_order,
      parent_task_id: Object.prototype.hasOwnProperty.call(
        item,
        'parent_task_id',
      )
        ? item.parent_task_id
        : item.parent_id,
    }));

    for (const item of normalizedItems) {
      if (!item.task_id || !planTaskIdByTaskId.has(item.task_id)) {
        throw new BadRequestException(
          'Every reordered task must be in this plan',
        );
      }
      if (item.parent_task_id !== undefined) {
        if (
          item.parent_task_id !== null &&
          !planTaskIdByTaskId.has(item.parent_task_id)
        ) {
          throw new BadRequestException('Parent task must be in this plan');
        }
        parentMap.set(item.task_id, item.parent_task_id ?? null);
      }
    }

    for (const item of normalizedItems) {
      if (!item.task_id) continue;
      if (item.parent_task_id !== undefined) {
        this.assertParentDoesNotCreateCycle(
          parentMap,
          item.task_id,
          item.parent_task_id ?? null,
        );
      }
    }

    for (const item of normalizedItems) {
      if (!item.task_id) continue;
      const planTaskId = planTaskIdByTaskId.get(item.task_id);
      if (!planTaskId) continue;

      const { error: orderError } = await this.client
        .from('plan_tasks')
        .update({ sort_order: item.sort_order })
        .eq('id', planTaskId);
      if (orderError) throw new BadRequestException(orderError.message);

      if (item.parent_task_id !== undefined) {
        const { error: parentError } = await this.client
          .from('tasks')
          .update({ parent_task_id: item.parent_task_id })
          .eq('id', item.task_id);
        if (parentError) throw new BadRequestException(parentError.message);
      }
    }

    await this.recalculateWbs(planId);
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_item',
      planId,
      'reorder',
      { plan_id: planId, count: dto.items.length },
    );
    return { success: true };
  }

  async recalculateWbs(planId: string): Promise<void> {
    const { data: fullRows } = await this.client
      .from('plan_tasks')
      .select(
        'id, task_id, sort_order, task:tasks!plan_tasks_task_id_fkey(parent_task_id)',
      )
      .eq('plan_id', planId)
      .order('sort_order', { ascending: true });

    if (!fullRows || fullRows.length === 0) return;

    const typed = fullRows as unknown as {
      id: string;
      task_id: string;
      sort_order: number;
      task: { parent_task_id: string | null } | null;
    }[];

    const taskIdToPlanTaskId = new Map<string, string>();
    for (const r of typed) {
      taskIdToPlanTaskId.set(r.task_id, r.id);
    }

    const childrenByParent = new Map<string | null, typeof typed>();
    for (const row of typed) {
      const parentTaskId = row.task?.parent_task_id ?? null;
      const parentPlanTaskId = parentTaskId
        ? (taskIdToPlanTaskId.get(parentTaskId) ?? null)
        : null;
      const children = childrenByParent.get(parentPlanTaskId) ?? [];
      children.push(row);
      childrenByParent.set(parentPlanTaskId, children);
    }

    for (const children of childrenByParent.values()) {
      children.sort(
        (a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0),
      );
    }

    const wbsNumbers = new Map<string, string>();
    const visited = new Set<string>();

    const assignSubtree = (row: (typeof typed)[number], wbs: string) => {
      if (visited.has(row.id)) return;
      visited.add(row.id);
      wbsNumbers.set(row.id, wbs);

      const children = childrenByParent.get(row.id) ?? [];
      children.forEach((child, index) =>
        assignSubtree(child, `${wbs}.${index + 1}`),
      );
    };

    let rootIndex = 0;
    for (const row of childrenByParent.get(null) ?? []) {
      assignSubtree(row, String(++rootIndex));
    }

    for (const row of typed) {
      if (!visited.has(row.id)) assignSubtree(row, String(++rootIndex));
    }

    await Promise.all(
      [...wbsNumbers.entries()].map(([id, wbs]) =>
        this.client.from('plan_tasks').update({ wbs_number: wbs }).eq('id', id),
      ),
    );
  }

  // ---- Dependencies --------------------------------------------------------

  async listDependencies(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Record<string, unknown>[] }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'view');

    const { data: planTasks } = await this.client
      .from('plan_tasks')
      .select('task_id')
      .eq('plan_id', planId);

    const taskIds = ((planTasks ?? []) as unknown as { task_id: string }[]).map(
      (r) => r.task_id,
    );
    if (taskIds.length === 0) return { data: [] };

    const { data: relTypes, error: relTypesError } = await this.client
      .from('relation_types')
      .select('id')
      .eq('organization_id', organizationId)
      .in('name', GANTT_RELATION_NAMES);
    if (relTypesError) throw new BadRequestException(relTypesError.message);

    const relTypeIds = ((relTypes ?? []) as { id: string }[]).map(
      (row) => row.id,
    );
    if (relTypeIds.length === 0) return { data: [] };

    const { data, error } = await this.client
      .from('task_relationships')
      .select('*, relation_type:relation_types(id, name)')
      .eq('source_type', 'task')
      .eq('target_type', 'task')
      .in('source_id', taskIds)
      .in('target_id', taskIds)
      .in('relation_type_id', relTypeIds);

    if (error) throw new BadRequestException(error.message);
    return { data: (data ?? []) as unknown as Record<string, unknown>[] };
  }

  async addDependency(
    planId: string,
    organizationId: string,
    userId: string,
    dto: CreatePlanDependencyDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'edit');

    if (dto.predecessor_id === dto.successor_id) {
      throw new BadRequestException('A task cannot depend on itself');
    }

    const { data: planTasks, error: planTasksError } = await this.client
      .from('plan_tasks')
      .select('task_id')
      .eq('plan_id', planId);
    if (planTasksError) throw new BadRequestException(planTasksError.message);

    const planTaskIds = (
      (planTasks ?? []) as unknown as { task_id: string }[]
    ).map((row) => row.task_id);
    if (!planTaskIds.includes(dto.predecessor_id)) {
      throw new BadRequestException('Predecessor task must be in this plan');
    }
    if (!planTaskIds.includes(dto.successor_id)) {
      throw new BadRequestException('Successor task must be in this plan');
    }

    const depLabel =
      DEPENDENCY_TYPE_LABELS[dto.dependency_type ?? 'finish_to_start'];
    const { data: relType } = await this.client
      .from('relation_types')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('name', depLabel)
      .maybeSingle();

    if (!relType) {
      throw new BadRequestException(
        'Gantt relation types not configured. Please configure relation types first.',
      );
    }

    const rtRow = relType as unknown as { id: string };

    const { data: ganttTypes, error: ganttTypesError } = await this.client
      .from('relation_types')
      .select('id')
      .eq('organization_id', organizationId)
      .in('name', GANTT_RELATION_NAMES);
    if (ganttTypesError) throw new BadRequestException(ganttTypesError.message);

    const ganttTypeIds = ((ganttTypes ?? []) as { id: string }[]).map(
      (row) => row.id,
    );
    const { data: relationships, error: relationshipsError } = await this.client
      .from('task_relationships')
      .select('source_id, target_id')
      .eq('source_type', 'task')
      .eq('target_type', 'task')
      .in('source_id', planTaskIds)
      .in('target_id', planTaskIds)
      .in('relation_type_id', ganttTypeIds);
    if (relationshipsError) {
      throw new BadRequestException(relationshipsError.message);
    }

    const adjacency = new Map<string, string[]>();
    for (const relationship of (relationships ?? []) as {
      source_id: string;
      target_id: string;
    }[]) {
      const successors = adjacency.get(relationship.source_id) ?? [];
      successors.push(relationship.target_id);
      adjacency.set(relationship.source_id, successors);
    }

    const visited = new Set<string>();
    const queue = [dto.successor_id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === dto.predecessor_id) {
        throw new BadRequestException(
          'Adding this dependency would create a circular reference',
        );
      }
      if (visited.has(current)) continue;
      visited.add(current);
      queue.push(...(adjacency.get(current) ?? []));
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('task_relationships')
      .insert({
        organization_id: organizationId,
        source_type: 'task',
        source_id: dto.predecessor_id,
        target_type: 'task',
        target_id: dto.successor_id,
        relation_type_id: rtRow.id,
        lag_days: dto.lag_days ?? 0,
        created_by: userId,
      })
      .select('*, relation_type:relation_types(id, name)')
      .single();

    if (error) throw new BadRequestException(error.message);
    const dependency = data as unknown as Record<string, unknown>;
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_dependency',
      dependency['id'] as string,
      'create',
      {
        plan_id: planId,
        predecessor_id: dto.predecessor_id,
        successor_id: dto.successor_id,
        dependency_type: dto.dependency_type ?? 'finish_to_start',
      },
    );
    return { data: data as unknown as Record<string, unknown>, success: true };
  }

  async removeDependency(
    planId: string,
    depId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'edit');

    const { data: planTasks, error: planTasksError } = await this.client
      .from('plan_tasks')
      .select('task_id')
      .eq('plan_id', planId);
    if (planTasksError) throw new BadRequestException(planTasksError.message);
    const planTaskIds = (
      (planTasks ?? []) as unknown as { task_id: string }[]
    ).map((row) => row.task_id);

    const { data: existing, error: existingError } = await this.client
      .from('task_relationships')
      .select('id, source_id, target_id')
      .eq('id', depId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (existingError) throw new BadRequestException(existingError.message);
    if (!existing) throw new NotFoundException('Dependency not found');

    const relationship = existing as unknown as {
      source_id: string;
      target_id: string;
    };
    if (
      !planTaskIds.includes(relationship.source_id) ||
      !planTaskIds.includes(relationship.target_id)
    ) {
      throw new NotFoundException('Dependency not found');
    }

    const { error } = await this.client
      .from('task_relationships')
      .delete()
      .eq('id', depId);
    if (error) throw new BadRequestException(error.message);
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_dependency',
      depId,
      'delete',
      {
        plan_id: planId,
        predecessor_id: relationship.source_id,
        successor_id: relationship.target_id,
      },
    );
    return { success: true };
  }

  // ---- Stakeholders --------------------------------------------------------

  async listStakeholders(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Record<string, unknown>[] }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'view');

    const { data, error } = await this.client
      .from('plan_stakeholders')
      .select(
        '*, user:users!plan_stakeholders_user_id_fkey(id, first_name, last_name, email, avatar_url)',
      )
      .eq('plan_id', planId)
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return { data: (data ?? []) as unknown as Record<string, unknown>[] };
  }

  async addStakeholder(
    planId: string,
    organizationId: string,
    userId: string,
    dto: CreatePlanStakeholderDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'edit');

    const stakeholderInput = { ...(dto as unknown as Record<string, unknown>) };
    delete stakeholderInput['plan_id'];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('plan_stakeholders')
      .insert({
        plan_id: planId,
        ...stakeholderInput,
        power_level: stakeholderInput.power_level ?? 5,
        interest_level: stakeholderInput.interest_level ?? 5,
      })
      .select(
        '*, user:users!plan_stakeholders_user_id_fkey(id, first_name, last_name, email, avatar_url)',
      )
      .single();

    if (error) throw new BadRequestException(error.message);
    const stakeholder = data as unknown as Record<string, unknown>;
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_stakeholder',
      stakeholder['id'] as string,
      'create',
      { plan_id: planId, name: stakeholderInput.name },
    );
    return { data: stakeholder, success: true };
  }

  async updateStakeholder(
    planId: string,
    stakeholderId: string,
    organizationId: string,
    userId: string,
    dto: UpdatePlanStakeholderDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'edit');

    const { data: existing, error: findError } = await this.client
      .from('plan_stakeholders')
      .select('id')
      .eq('id', stakeholderId)
      .eq('plan_id', planId)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Stakeholder not found');

    const stakeholderInput = { ...(dto as unknown as Record<string, unknown>) };
    delete stakeholderInput['id'];
    delete stakeholderInput['plan_id'];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('plan_stakeholders')
      .update({ ...stakeholderInput, updated_at: new Date().toISOString() })
      .eq('id', stakeholderId)
      .select(
        '*, user:users!plan_stakeholders_user_id_fkey(id, first_name, last_name, email, avatar_url)',
      )
      .single();

    if (error) throw new BadRequestException(error.message);
    const stakeholder = data as unknown as Record<string, unknown>;
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_stakeholder',
      stakeholderId,
      'update',
      { plan_id: planId, fields: Object.keys(stakeholderInput) },
    );
    return { data: stakeholder, success: true };
  }

  async deleteStakeholder(
    planId: string,
    stakeholderId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'edit');

    const { data: existing, error: findError } = await this.client
      .from('plan_stakeholders')
      .select('id')
      .eq('id', stakeholderId)
      .eq('plan_id', planId)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Stakeholder not found');

    const { error } = await this.client
      .from('plan_stakeholders')
      .delete()
      .eq('id', stakeholderId);
    if (error) throw new BadRequestException(error.message);
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_stakeholder',
      stakeholderId,
      'delete',
      { plan_id: planId },
    );
    return { success: true };
  }

  async getStakeholderMatrix(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<{
    plan: Record<string, unknown>;
    quadrants: unknown[];
    all_stakeholders: unknown[];
  }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'view');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: planRow, error: planError } = await this.client
      .from('plans')
      .select('*')
      .eq('id', planId)
      .eq('organization_id', organizationId)
      .single();
    if (planError) throw new BadRequestException(planError.message);
    const plan = planRow as unknown as Record<string, unknown>;

    const { data, error } = await this.client
      .from('plan_stakeholders')
      .select(
        '*, user:users!plan_stakeholders_user_id_fkey(id, first_name, last_name, email, avatar_url)',
      )
      .eq('plan_id', planId);

    if (error) throw new BadRequestException(error.message);

    const stakeholders = (data ?? []) as unknown as Record<string, unknown>[];

    const quadrants = [
      {
        quadrant: 'manage_closely',
        stakeholders: stakeholders.filter(
          (s) =>
            Number(s['power_level'] ?? 0) >= 6 &&
            Number(s['interest_level'] ?? 0) >= 6,
        ),
      },
      {
        quadrant: 'keep_satisfied',
        stakeholders: stakeholders.filter(
          (s) =>
            Number(s['power_level'] ?? 0) >= 6 &&
            Number(s['interest_level'] ?? 0) < 6,
        ),
      },
      {
        quadrant: 'keep_informed',
        stakeholders: stakeholders.filter(
          (s) =>
            Number(s['power_level'] ?? 0) < 6 &&
            Number(s['interest_level'] ?? 0) >= 6,
        ),
      },
      {
        quadrant: 'monitor',
        stakeholders: stakeholders.filter(
          (s) =>
            Number(s['power_level'] ?? 0) < 6 &&
            Number(s['interest_level'] ?? 0) < 6,
        ),
      },
    ];

    return { plan, quadrants, all_stakeholders: stakeholders };
  }

  // ---- Risks ---------------------------------------------------------------

  async listRisks(
    planId: string,
    organizationId: string,
    userId: string,
    risk_type?: string,
    is_blocker?: boolean,
  ): Promise<Record<string, unknown>[]> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'view');

    let q = this.client
      .from('plan_risks')
      .select(
        '*, owner:users!plan_risks_owner_id_fkey(id, first_name, last_name, email)',
      )
      .eq('plan_id', planId)
      .order('created_at', { ascending: true });

    if (risk_type) q = q.eq('risk_type', risk_type);
    if (is_blocker !== undefined) q = q.eq('is_blocker', is_blocker);

    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as unknown as Record<string, unknown>[];
  }

  async addRisk(
    planId: string,
    organizationId: string,
    userId: string,
    dto: CreatePlanRiskDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'edit');

    const riskInput = { ...(dto as unknown as Record<string, unknown>) };
    delete riskInput['plan_id'];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('plan_risks')
      .insert({
        plan_id: planId,
        organization_id: organizationId,
        ...riskInput,
        probability: riskInput.probability ?? 3,
        impact: riskInput.impact ?? 3,
        risk_type: riskInput.risk_type ?? 'risk',
        status: riskInput.status ?? 'identified',
        created_by: userId,
      })
      .select(
        '*, owner:users!plan_risks_owner_id_fkey(id, first_name, last_name, email)',
      )
      .single();

    if (error) throw new BadRequestException(error.message);
    const risk = data as unknown as Record<string, unknown>;
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_risk',
      risk['id'] as string,
      'create',
      {
        plan_id: planId,
        name: riskInput.name,
        risk_type: riskInput.risk_type ?? 'risk',
      },
    );
    return { data: risk, success: true };
  }

  async updateRisk(
    planId: string,
    riskId: string,
    organizationId: string,
    userId: string,
    dto: UpdatePlanRiskDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'edit');

    const { data: existing, error: findError } = await this.client
      .from('plan_risks')
      .select('id')
      .eq('id', riskId)
      .eq('plan_id', planId)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Risk not found');

    const riskInput = { ...(dto as unknown as Record<string, unknown>) };
    delete riskInput['id'];
    delete riskInput['plan_id'];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('plan_risks')
      .update({ ...riskInput, updated_at: new Date().toISOString() })
      .eq('id', riskId)
      .select(
        '*, owner:users!plan_risks_owner_id_fkey(id, first_name, last_name, email)',
      )
      .single();

    if (error) throw new BadRequestException(error.message);
    const risk = data as unknown as Record<string, unknown>;
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_risk',
      riskId,
      'update',
      { plan_id: planId, fields: Object.keys(riskInput) },
    );
    return { data: risk, success: true };
  }

  async deleteRisk(
    planId: string,
    riskId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'edit');

    const { data: existing, error: findError } = await this.client
      .from('plan_risks')
      .select('id')
      .eq('id', riskId)
      .eq('plan_id', planId)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Risk not found');

    const { error } = await this.client
      .from('plan_risks')
      .delete()
      .eq('id', riskId);
    if (error) throw new BadRequestException(error.message);
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_risk',
      riskId,
      'delete',
      { plan_id: planId },
    );
    return { success: true };
  }

  async getRiskRegister(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<{
    plan: Record<string, unknown>;
    risks: unknown[];
    opportunities: unknown[];
    matrix: unknown[][];
  }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'view');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: planRow, error: planError } = await this.client
      .from('plans')
      .select('*')
      .eq('id', planId)
      .eq('organization_id', organizationId)
      .single();
    if (planError) throw new BadRequestException(planError.message);
    const plan = planRow as unknown as Record<string, unknown>;

    const { data, error } = await this.client
      .from('plan_risks')
      .select(
        '*, owner:users!plan_risks_owner_id_fkey(id, first_name, last_name, email)',
      )
      .eq('plan_id', planId);

    if (error) throw new BadRequestException(error.message);
    const allRisks = (data ?? []) as unknown as Record<string, unknown>[];

    const risks = allRisks.filter(
      (r) => r['risk_type'] === 'risk' || !r['risk_type'],
    );
    const opportunities = allRisks.filter(
      (r) => r['risk_type'] === 'opportunity',
    );

    // Build 5×5 matrix: rows=probability(1-5), cols=impact(1-5)
    const matrix: {
      probability: number;
      impact: number;
      risks: Record<string, unknown>[];
    }[][] = Array.from({ length: 5 }, (_, pIdx) =>
      Array.from({ length: 5 }, (_, iIdx) => ({
        probability: pIdx + 1,
        impact: iIdx + 1,
        risks: risks.filter(
          (r) =>
            Number(r['probability'] ?? 3) === pIdx + 1 &&
            Number(r['impact'] ?? 3) === iIdx + 1,
        ),
      })),
    );

    return { plan, risks, opportunities, matrix };
  }

  async getRiskMatrix(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<unknown[][]> {
    return (await this.getRiskRegister(planId, organizationId, userId)).matrix;
  }

  // ---- Baselines -----------------------------------------------------------

  async listBaselines(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown>[]> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'view');

    const { data, error } = await this.client
      .from('plan_baselines')
      .select('*')
      .eq('plan_id', planId)
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as unknown as Record<string, unknown>[];
  }

  async createBaseline(
    planId: string,
    organizationId: string,
    userId: string,
    dto: CreatePlanBaselineDto,
    // Robert 1.23: the id his card reserved, so its Undo finds this baseline. People never pass it.
    opts: { id?: string } = {},
  ): Promise<{ success: true } & Record<string, unknown>> {
    const plan = await this.verifyPlanAccess(
      planId,
      organizationId,
      userId,
      'admin',
    );

    // Snapshot current plan items
    const { data: items } = await this.client
      .from('plan_tasks')
      .select(
        'id, item_type, wbs_number, task:tasks!plan_tasks_task_id_fkey(id, summary, start_date, end_date, duration, progress, estimated_cost, actual_cost)',
      )
      .eq('plan_id', planId)
      .order('sort_order', { ascending: true });

    const rows = (items ?? []) as unknown as {
      id: string;
      item_type: string;
      wbs_number: string | null;
      task: {
        id: string;
        summary: string;
        start_date: string | null;
        end_date: string | null;
        duration: number | null;
        progress: number;
        estimated_cost: number | null;
        actual_cost: number | null;
      } | null;
    }[];

    const snapshotData = {
      items: rows.map((r) => ({
        task_id: r.task?.id,
        summary: r.task?.summary,
        start_date: r.task?.start_date,
        end_date: r.task?.end_date,
        duration: r.task?.duration,
        progress: r.task?.progress ?? 0,
        estimated_cost: r.task?.estimated_cost,
        actual_cost: r.task?.actual_cost,
        item_type: r.item_type,
        wbs_number: r.wbs_number,
      })),
      // `plans.progress` is never written, so it always read 0. Average the items' progress,
      // the same figure the plan's Summary tab shows.
      plan_progress: rows.length
        ? Math.round(
            rows.reduce((sum, r) => sum + (r.task?.progress ?? 0), 0) /
              rows.length,
          )
        : 0,
      snapshot_at: new Date().toISOString(),
    };

    // Deactivate all, then create new active baseline
    await this.client
      .from('plan_baselines')
      .update({ is_active: false })
      .eq('plan_id', planId);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('plan_baselines')
      .insert({
        ...(opts.id && { id: opts.id }),
        plan_id: planId,
        name: dto.name,
        snapshot_data: snapshotData,
        created_by: userId,
        is_active: true,
        baseline_date: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    const baseline = data as unknown as Record<string, unknown>;
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_baseline',
      baseline['id'] as string,
      'create',
      { plan_id: planId, name: dto.name, is_active: true },
    );
    void this.outboxService?.write(
      organizationId,
      (plan['space_id'] as string | null | undefined) ?? '',
      'app.plan.baseline_activated',
      {
        plan: {
          id: planId,
          name: plan['name'],
          space_id: plan['space_id'],
          status: plan['status'],
        },
        plan_id: planId,
        baselineId: String(baseline['id']),
      },
    );

    return { data: baseline, success: true };
  }

  async deleteBaseline(
    planId: string,
    baselineId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true }> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'admin');

    const { data: existing, error: findError } = await this.client
      .from('plan_baselines')
      .select('id')
      .eq('id', baselineId)
      .eq('plan_id', planId)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Baseline not found');

    const { error } = await this.client
      .from('plan_baselines')
      .delete()
      .eq('id', baselineId);
    if (error) throw new BadRequestException(error.message);
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_baseline',
      baselineId,
      'delete',
      { plan_id: planId },
    );
    return { success: true };
  }

  async activateBaseline(
    planId: string,
    baselineId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const plan = await this.verifyPlanAccess(
      planId,
      organizationId,
      userId,
      'admin',
    );

    const { data: existing, error: findError } = await this.client
      .from('plan_baselines')
      .select('id')
      .eq('id', baselineId)
      .eq('plan_id', planId)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Baseline not found');

    await this.client
      .from('plan_baselines')
      .update({ is_active: false })
      .eq('plan_id', planId);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('plan_baselines')
      .update({ is_active: true })
      .eq('id', baselineId)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    const baseline = data as unknown as Record<string, unknown>;
    void this.logMutationAudit(
      organizationId,
      userId,
      'plan_baseline',
      baselineId,
      'update',
      { plan_id: planId, is_active: true },
    );
    void this.outboxService?.write(
      organizationId,
      (plan['space_id'] as string | null | undefined) ?? '',
      'app.plan.baseline_activated',
      {
        plan: {
          id: planId,
          name: plan['name'],
          space_id: plan['space_id'],
          status: plan['status'],
        },
        plan_id: planId,
        baselineId: String(baselineId),
      },
    );

    return { data: baseline, success: true };
  }

  async getEvmMetrics(
    planId: string,
    organizationId: string,
    userId?: string,
  ): Promise<Record<string, unknown> | null> {
    if (userId) {
      await this.verifyPlanAccess(planId, organizationId, userId, 'view');
    } else {
      await this.verifyPlan(planId, organizationId);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: activeBaseline } = await this.client
      .from('plan_baselines')
      .select('*')
      .eq('plan_id', planId)
      .eq('is_active', true)
      .maybeSingle();

    if (!activeBaseline) return null;

    const baseline = activeBaseline as unknown as Record<string, unknown>;
    const snapshotData = baseline['snapshot_data'] as {
      items: { estimated_cost: number | null; progress: number }[];
    } | null;

    // Paged: AC and EV below are JS reduces over these rows, so a single capped
    // request would silently under-report the plan's actual and earned cost —
    // wrong CPI/SPI on the plan and portfolio KPI screens, with no error shown.
    const { rows: items } = await fetchAllRows<Record<string, unknown>>(
      (from, to) =>
        this.client
          .from('plan_tasks')
          .select(
            'task:tasks!plan_tasks_task_id_fkey(estimated_cost, actual_cost, progress, start_date, end_date)',
          )
          .eq('plan_id', planId)
          .order('id', { ascending: true })
          .range(from, to) as never,
    );

    const currentRows = items as unknown as {
      task: {
        estimated_cost: number | null;
        actual_cost: number | null;
        progress: number;
        start_date: string | null;
        end_date: string | null;
      } | null;
    }[];

    const bac = (snapshotData?.items ?? []).reduce(
      (sum, r) => sum + (r.estimated_cost ?? 0),
      0,
    );
    if (bac === 0) return null;
    const ac = currentRows.reduce(
      (sum, r) => sum + (r.task?.actual_cost ?? 0),
      0,
    );
    const ev = currentRows.reduce(
      (sum, r) =>
        sum + (r.task?.estimated_cost ?? 0) * ((r.task?.progress ?? 0) / 100),
      0,
    );

    // Legacy PV is based on the current task date span, not plan-level dates.
    const now = Date.now();
    const startDates = currentRows
      .map((r) => r.task?.start_date)
      .filter((date): date is string => Boolean(date))
      .map((date) => new Date(date).getTime());
    const endDates = currentRows
      .map((r) => r.task?.end_date)
      .filter((date): date is string => Boolean(date))
      .map((date) => new Date(date).getTime());

    const planStart = startDates.length > 0 ? Math.min(...startDates) : now;
    const planEnd = endDates.length > 0 ? Math.max(...endDates) : now;
    const totalDuration = planEnd - planStart;
    const elapsed =
      totalDuration > 0
        ? Math.min(1, Math.max(0, (now - planStart) / totalDuration))
        : 0;
    const pv = bac * elapsed;

    const cpi = ac > 0 ? ev / ac : 0;
    const spi = pv > 0 ? ev / pv : 0;
    const cost_variance = ev - ac;
    const schedule_variance = ev - pv;
    const eac = cpi > 0 ? bac / cpi : bac;
    const vac = bac - eac;

    return {
      plan_id: planId,
      baseline_id: baseline['id'],
      as_of_date: new Date().toISOString(),
      planned_value: Math.round(pv * 100) / 100,
      earned_value: Math.round(ev * 100) / 100,
      actual_cost: Math.round(ac * 100) / 100,
      cost_variance: Math.round(cost_variance * 100) / 100,
      schedule_variance: Math.round(schedule_variance * 100) / 100,
      cost_performance_index: Math.round(cpi * 100) / 100,
      schedule_performance_index: Math.round(spi * 100) / 100,
      estimate_at_completion: Math.round(eac * 100) / 100,
      variance_at_completion: Math.round(vac * 100) / 100,
      budget_at_completion: Math.round(bac * 100) / 100,
    };
  }

  // ---- Permissions ---------------------------------------------------------

  async listPermissions(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown>[]> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'view');

    const { data, error } = await this.client
      .from('plan_permissions')
      .select(
        '*, user:users!plan_permissions_user_id_fkey(id, first_name, last_name, email, avatar_url)',
      )
      .eq('plan_id', planId);

    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as unknown as Record<string, unknown>[];
  }

  async grantPermission(
    planId: string,
    organizationId: string,
    dto: CreatePlanPermissionDto,
    actorUserId?: string,
  ): Promise<Record<string, unknown>> {
    if (!actorUserId) {
      throw new ForbiddenException('Missing permission actor');
    }
    await this.verifyPlanAccess(planId, organizationId, actorUserId, 'admin');

    const { data: existing } = await this.client
      .from('plan_permissions')
      .select('id')
      .eq('plan_id', planId)
      .eq('user_id', dto.user_id)
      .maybeSingle();

    if (existing)
      throw new ConflictException('User already has permission on this plan');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('plan_permissions')
      .insert({
        plan_id: planId,
        user_id: dto.user_id,
        permission_level: dto.permission_level ?? PlanPermissionLevel.VIEW,
      })
      .select(
        '*, user:users!plan_permissions_user_id_fkey(id, first_name, last_name, email, avatar_url)',
      )
      .single();

    if (error) throw new BadRequestException(error.message);
    const permission = data as unknown as Record<string, unknown>;
    void this.logAudit(
      organizationId,
      actorUserId,
      permission.id as string,
      'create',
      {
        scope: 'plan_permission',
        plan_id: planId,
        user_id: dto.user_id,
        permission_level: dto.permission_level ?? PlanPermissionLevel.VIEW,
      },
    );
    return permission;
  }

  async updatePermission(
    planId: string,
    permissionId: string,
    organizationId: string,
    dto: UpdatePlanPermissionDto,
    actorUserId?: string,
  ): Promise<Record<string, unknown>> {
    if (!actorUserId) {
      throw new ForbiddenException('Missing permission actor');
    }
    await this.verifyPlanAccess(planId, organizationId, actorUserId, 'admin');

    const { data: existing, error: findError } = await this.client
      .from('plan_permissions')
      .select('id')
      .eq('id', permissionId)
      .eq('plan_id', planId)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Permission not found');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('plan_permissions')
      .update({
        permission_level: dto.permission_level,
        updated_at: new Date().toISOString(),
      })
      .eq('id', permissionId)
      .select(
        '*, user:users!plan_permissions_user_id_fkey(id, first_name, last_name, email, avatar_url)',
      )
      .single();

    if (error) throw new BadRequestException(error.message);
    const permission = data as unknown as Record<string, unknown>;
    void this.logAudit(organizationId, actorUserId, permissionId, 'update', {
      scope: 'plan_permission',
      plan_id: planId,
      permission_level: dto.permission_level,
    });
    return permission;
  }

  async revokePermission(
    planId: string,
    permissionId: string,
    organizationId: string,
    actorUserId?: string,
  ): Promise<{ success: true; message: string }> {
    if (!actorUserId) {
      throw new ForbiddenException('Missing permission actor');
    }
    await this.verifyPlanAccess(planId, organizationId, actorUserId, 'admin');

    const { data: existing, error: findError } = await this.client
      .from('plan_permissions')
      .select('id')
      .eq('id', permissionId)
      .eq('plan_id', planId)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Permission not found');

    const { error } = await this.client
      .from('plan_permissions')
      .delete()
      .eq('id', permissionId);
    if (error) throw new BadRequestException(error.message);
    void this.logAudit(organizationId, actorUserId, permissionId, 'delete', {
      scope: 'plan_permission',
      plan_id: planId,
    });
    return { success: true, message: 'Permission revoked' };
  }

  private async logAudit(
    organizationId: string,
    actorUserId: string | undefined,
    entityId: string,
    action: 'create' | 'update' | 'delete',
    changes: Record<string, unknown>,
  ): Promise<void> {
    if (!actorUserId) return;

    try {
      await this.client.from('audit_logs').insert({
        organization_id: organizationId,
        user_id: actorUserId,
        entity_type: 'permission',
        entity_id: entityId,
        action,
        changes,
      });
    } catch {
      // Audit is best-effort and must not break plan permission mutations.
    }
  }

  // ---- Views ---------------------------------------------------------------

  async getGanttView(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'view');

    // Fetch full plan object (verifyPlan only selects subset)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: planRow, error: planError } = await this.client
      .from('plans')
      .select('*')
      .eq('id', planId)
      .eq('organization_id', organizationId)
      .single();
    if (planError) throw new BadRequestException(planError.message);
    const plan = planRow as unknown as Record<string, unknown>;

    // Fetch task type names from the plan space's hierarchy config first.
    let { data: configRecord } = await this.client
      .from('task_hierarchy_configurations')
      .select('config')
      .eq('organization_id', organizationId)
      .eq('space_id', plan['space_id'] as string)
      .maybeSingle();

    if (!configRecord) {
      const { data: fallbackConfig } = await this.client
        .from('task_hierarchy_configurations')
        .select('config')
        .eq('organization_id', organizationId)
        .is('space_id', null)
        .maybeSingle();
      configRecord = fallbackConfig;
    }

    const taskTypeNames: Record<string, string> = {};
    const configLevels = (
      configRecord?.config as
        | { levels?: { id: string; name: string }[] }
        | null
        | undefined
    )?.levels;
    if (configLevels) {
      for (const l of configLevels) {
        taskTypeNames[l.id] = l.name;
      }
    }

    const { data: items, error } = await this.client
      .from('plan_tasks')
      .select(
        'id, wbs_number, item_type, is_critical_path, color, task_id, task:tasks!plan_tasks_task_id_fkey(id, key, summary, start_date, end_date, due_date, duration, progress, priority, status, parent_task_id, assigned_to, task_type_id, assignee:users!tasks_assigned_to_fkey(id, first_name, last_name), process:business_processes!tasks_process_id_fkey(id, title))',
      )
      .eq('plan_id', planId)
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    const rows = (items ?? []) as unknown as {
      id: string;
      wbs_number: string | null;
      item_type: string;
      is_critical_path: boolean;
      color: string | null;
      task_id: string;
      task: {
        id: string;
        key: string | null;
        summary: string;
        start_date: string | null;
        end_date: string | null;
        due_date: string | null;
        duration: number | null;
        progress: number;
        priority: string | null;
        status: string | null;
        parent_task_id: string | null;
        assigned_to: string | null;
        task_type_id: string | null;
        assignee: { id: string; first_name: string; last_name: string } | null;
        process: { id: string; title: string } | null;
      } | null;
    }[];

    const taskIds = rows.filter((r) => r.task).map((r) => r.task!.id);
    const taskIdSet = new Set(taskIds);

    const { data: relationTypes } = await this.client
      .from('relation_types')
      .select('id, name')
      .eq('organization_id', organizationId)
      .in('name', GANTT_RELATION_NAMES);
    const relationTypeIds = ((relationTypes ?? []) as { id: string }[]).map(
      (row) => row.id,
    );

    const { data: deps } =
      taskIds.length > 0 && relationTypeIds.length > 0
        ? await this.client
            .from('task_relationships')
            .select(
              'id, source_id, target_id, lag_days, relation_type:relation_types(name)',
            )
            .eq('source_type', 'task')
            .eq('target_type', 'task')
            .in('source_id', taskIds)
            .in('target_id', taskIds)
            .in('relation_type_id', relationTypeIds)
        : { data: [] };

    const ganttTasks = rows.map((r) => {
      const t = r.task;
      const itemType = r.item_type;
      let type: string;
      if (itemType === 'milestone') {
        type = 'milestone';
      } else if (itemType === 'phase' || itemType === 'work_package') {
        type = 'project';
      } else {
        type = 'task';
      }

      const assigneeName = t?.assignee
        ? `${t.assignee.first_name ?? ''} ${t.assignee.last_name ?? ''}`.trim()
        : null;

      const now = new Date().toISOString();
      const effectiveEnd = t?.due_date ?? t?.end_date ?? t?.start_date ?? now;
      const effectiveStart = t?.start_date ?? effectiveEnd;
      const spanMs =
        new Date(effectiveEnd).getTime() - new Date(effectiveStart).getTime();
      const duration =
        t?.duration ?? Math.max(0, Math.round(spanMs / 86_400_000));

      return {
        id: r.task_id,
        text: t?.summary ?? '',
        start: effectiveStart,
        end: effectiveEnd,
        duration,
        progress: (t?.progress ?? 0) / 100,
        parent:
          t?.parent_task_id && taskIdSet.has(t.parent_task_id)
            ? t.parent_task_id
            : null,
        type,
        task_type_id: t?.task_type_id ?? null,
        ...(r.color ? { color: r.color } : {}),
        wbs_number: r.wbs_number,
        key: t?.key ?? null,
        is_critical_path: r.is_critical_path,
        status: t?.status ?? null,
        priority: t?.priority ?? null,
        assignee_name: assigneeName,
        due_date: t?.due_date ?? null,
        task_type_name: t?.task_type_id
          ? (taskTypeNames[t.task_type_id] ?? null)
          : null,
        process_name: t?.process?.title ?? null,
      };
    });

    const ganttLinks = (
      (deps ?? []) as unknown as {
        id: string;
        source_id: string;
        target_id: string;
        lag_days: number | null;
        relation_type: { name: string } | null;
      }[]
    ).map((d) => {
      const relName = d.relation_type?.name ?? 'Finish to Start';
      return {
        id: d.id,
        source: d.source_id,
        target: d.target_id,
        type: RELATION_NAME_TO_TYPE[relName] ?? 'finish_to_start',
        lag: d.lag_days ?? 0,
      };
    });

    return { plan, tasks: ganttTasks, links: ganttLinks };
  }

  async getWbsView(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    await this.verifyPlanAccess(planId, organizationId, userId, 'view');

    // Fetch full plan object
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: planRow, error: planError } = await this.client
      .from('plans')
      .select('*')
      .eq('id', planId)
      .eq('organization_id', organizationId)
      .single();
    if (planError) throw new BadRequestException(planError.message);
    const plan = planRow as unknown as Record<string, unknown>;

    const { data: items, error } = await this.client
      .from('plan_tasks')
      .select(PLAN_ITEM_SELECT)
      .eq('plan_id', planId)
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    const rows = (items ?? []) as unknown as Record<string, unknown>[];
    const mapped = rows.map((r) => this.mapItemRow(r));

    const nodeMap = new Map<string, Record<string, unknown>>();
    const roots: Record<string, unknown>[] = [];

    for (const node of mapped) {
      nodeMap.set(node['id'] as string, node);
      nodeMap.set(node['plan_task_id'] as string, node);
    }

    for (const node of mapped) {
      const parentTaskId = node['parent_task_id'] as string | null;
      if (!parentTaskId) {
        roots.push(node);
      } else {
        const parentNode = nodeMap.get(parentTaskId);
        if (parentNode) {
          (parentNode['children'] as Record<string, unknown>[]).push(node);
          node['depth'] = (parentNode['depth'] as number) + 1;
        } else {
          node['parent_task_id'] = null;
          node['depth'] = 0;
          roots.push(node);
        }
      }
    }

    // Strip task_id and email from assignee to match risk-management-app shape
    const stripFields = (nodes: Record<string, unknown>[]) => {
      for (const node of nodes) {
        delete node['task_id'];
        const assignee = node['assignee'] as Record<string, unknown> | null;
        if (assignee) delete assignee['email'];
        stripFields(node['children'] as Record<string, unknown>[]);
      }
    };
    stripFields(roots);

    return { plan, root_items: roots };
  }

  // ---- Comments ---------------------------------------------------------

  private static readonly COMMENTS_TABLE = 'plan_comments';
  private static readonly COMMENT_SELECT =
    '*, user:users!plan_comments_created_by_fkey(first_name, last_name, avatar_url)';

  async getComments(
    planId: string,
    organizationId: string,
  ): Promise<unknown[]> {
    const { data, error } = await this.client
      .from(PlansService.COMMENTS_TABLE)
      .select(PlansService.COMMENT_SELECT)
      .eq('plan_id', planId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    return (data ?? []) as Record<string, unknown>[];
  }

  async createComment(
    planId: string,
    organizationId: string,
    userId: string,
    content: string,
  ): Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(PlansService.COMMENTS_TABLE)
      .insert({
        plan_id: planId,
        organization_id: organizationId,
        content,
        created_by: userId,
      })
      .select(PlansService.COMMENT_SELECT)
      .single();

    if (error) throw new BadRequestException(error.message);

    return data;
  }

  async updateComment(
    planId: string,
    commentId: string,
    organizationId: string,
    userId: string,
    content: string,
  ): Promise<unknown> {
    const { data: existing, error: findError } = await this.client
      .from(PlansService.COMMENTS_TABLE)
      .select('id, created_by, content')
      .eq('id', commentId)
      .eq('plan_id', planId)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Comment not found');
    if ((existing as { created_by: string }).created_by !== userId) {
      throw new ForbiddenException('Only the author can edit this comment');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(PlansService.COMMENTS_TABLE)
      .update({ content, updated_at: new Date().toISOString() })
      .eq('id', commentId)
      .select(PlansService.COMMENT_SELECT)
      .single();

    if (error) throw new BadRequestException(error.message);

    return data;
  }

  async deleteComment(
    planId: string,
    commentId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const { data: existing, error: findError } = await this.client
      .from(PlansService.COMMENTS_TABLE)
      .select('id, created_by')
      .eq('id', commentId)
      .eq('plan_id', planId)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Comment not found');
    if ((existing as { created_by: string }).created_by !== userId) {
      throw new ForbiddenException('Only the author can delete this comment');
    }

    const { error } = await this.client
      .from(PlansService.COMMENTS_TABLE)
      .delete()
      .eq('id', commentId)
      .eq('plan_id', planId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
  }
}
