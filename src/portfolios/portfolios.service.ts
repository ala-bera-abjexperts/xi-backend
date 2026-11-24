import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { NotificationEmailService } from '../notifications/notification-email.service';
import {
  normalizeSpacePermissions,
  SPACE_ROLE_BASE_PERMISSIONS,
} from '../permissions/models/space-permissions.model';
import { PermissionsService } from '../permissions/permissions.service';
import { PlansService } from '../plans/plans.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { TasksService } from '../tasks/tasks.service';
import type { AddPortfolioPlanDto } from './dto/add-portfolio-plan.dto';
import type { CreateLetterDto } from './dto/create-letter.dto';
import type { CreatePortfolioDto } from './dto/create-portfolio.dto';
import type { RejectLetterDto } from './dto/reject-letter.dto';
import type { UpdateLetterDto } from './dto/update-letter.dto';
import type { UpdateLetterScheduleDto } from './dto/update-letter-schedule.dto';
import type { UpdatePortfolioDto } from './dto/update-portfolio.dto';
import {
  PortfolioManagementLetterRepository,
  type LetterStatus,
  type PortfolioManagementLetterRow,
} from './portfolio-management-letter.repository';
import {
  PortfolioPlanRepository,
  type PlanRow,
  type PortfolioPlanWithPlanAndSpace,
} from './portfolio-plan.repository';
import {
  PortfolioRepository,
  type PortfolioRow,
  type PortfolioStatus,
} from './portfolio.repository';

type RagValue = 'green' | 'amber' | 'red' | 'unknown';
type LetterStatusValue = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface PortfolioGanttBar {
  plan_id: string;
  plan_key: string | null;
  space_key: string;
  name: string;
  start: string | null;
  end: string | null;
  progress: number;
  rag: RagValue;
  is_archived: boolean;
  is_tbd: boolean;
  link: string;
}

export interface PortfolioGanttOwner {
  id: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
}

export interface PortfolioGanttPlanRow {
  plan_id: string;
  plan_key: string | null;
  name: string;
  description: string | null;
  start: string | null;
  end: string | null;
  progress: number;
  rag: RagValue;
  rag_set_manually: boolean;
  plan_status: string | null;
  owner: PortfolioGanttOwner | null;
  budget: number | null;
  currency: string | null;
  cpi: number | null;
  spi: number | null;
  last_letter_status: LetterStatusValue | null;
  last_letter_date: string | null;
  custom_field_values: Record<string, unknown>;
  link: string;
  is_archived: boolean;
  is_tbd: boolean;
}

export interface PortfolioGanttSpaceGroup {
  space: { id: string; key: string | null; name: string | null } | null;
  plans: PortfolioGanttPlanRow[];
}

export interface PortfolioGanttTreeResponse {
  portfolio: {
    id: string;
    portfolio_key: string | null;
    name: string;
  };
  spaces: PortfolioGanttSpaceGroup[];
}

export interface PortfolioKpis {
  totalPlans: number;
  green: number;
  amber: number;
  red: number;
  unknown: number;
  overbudget: number;
  overtime: number;
  totalsByCurrency: Record<string, number>;
  weightedProgress: number | null;
  plansWithoutBaseline: number;
  plansAtRisk: Array<{
    plan_id: string;
    plan_key: string | null;
    name: string;
    reason: string;
  }>;
  overbudgetPlans: Array<{
    plan_id: string;
    plan_key: string | null;
    name: string;
    cpi: number;
  }>;
  overtimePlans: Array<{
    plan_id: string;
    plan_key: string | null;
    name: string;
    spi: number;
  }>;
}

@Injectable()
export class PortfoliosService {
  private readonly logger = new Logger(PortfoliosService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly portfolioRepo: PortfolioRepository,
    private readonly portfolioPlanRepo: PortfolioPlanRepository,
    private readonly letterRepo: PortfolioManagementLetterRepository,
    private readonly auditLogs: AuditLogsService,
    private readonly plansService: PlansService,
    private readonly tasksService: TasksService,
    private readonly permissionsService: PermissionsService,
    private readonly configService: ConfigService,
    @Optional()
    private readonly notificationEmail?: NotificationEmailService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async assertPortfolioModuleEnabled(organizationId: string): Promise<void> {
    const { data, error } = await this.client
      .from('organization_modules')
      .select('is_enabled')
      .eq('organization_id', organizationId)
      .eq('module_type', 'portfolio')
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data || data.is_enabled !== true) {
      throw new ForbiddenException(
        'Portfolio module is not enabled for this organization',
      );
    }
  }

  async list(
    organizationId: string,
    filters: {
      status?: PortfolioStatus;
      search?: string;
      include_archived?: boolean;
      page?: number;
      pageSize?: number;
    },
  ) {
    await this.assertPortfolioModuleEnabled(organizationId);
    return this.portfolioRepo.findByOrganization(organizationId, filters);
  }

  async create(
    organizationId: string,
    userId: string,
    dto: CreatePortfolioDto,
  ): Promise<PortfolioRow> {
    await this.assertPortfolioModuleEnabled(organizationId);
    const row = await this.portfolioRepo.create({
      organization_id: organizationId,
      created_by: userId,
      updated_by: userId,
      name: dto.name,
      description: dto.description ?? null,
      status: dto.status ?? 'draft',
      color: dto.color ?? null,
      owner_id: dto.owner_id ?? null,
    });

    await this.auditLogs.logAction(
      organizationId,
      userId,
      'portfolio',
      row.id,
      'create',
      {
        name: row.name,
        portfolio_key: row.portfolio_key,
      },
    );

    return row;
  }

  async getById(
    organizationId: string,
    portfolioId: string,
  ): Promise<PortfolioRow> {
    await this.assertPortfolioModuleEnabled(organizationId);
    const row = await this.portfolioRepo.findById(portfolioId);
    if (!row || row.organization_id !== organizationId) {
      throw new NotFoundException('Portfolio not found');
    }
    return row;
  }

  async getByKey(organizationId: string, key: string): Promise<PortfolioRow> {
    await this.assertPortfolioModuleEnabled(organizationId);
    const row = await this.portfolioRepo.findByKey(organizationId, key);
    if (!row) throw new NotFoundException('Portfolio not found');
    return row;
  }

  async update(
    organizationId: string,
    userId: string,
    portfolioId: string,
    dto: UpdatePortfolioDto,
  ): Promise<PortfolioRow> {
    await this.getById(organizationId, portfolioId);
    const row = await this.portfolioRepo.update(portfolioId, {
      ...dto,
      updated_by: userId,
    });
    await this.auditLogs.logAction(
      organizationId,
      userId,
      'portfolio',
      portfolioId,
      'update',
      dto as Record<string, unknown>,
    );
    return row;
  }

  async delete(
    organizationId: string,
    userId: string,
    portfolioId: string,
    hard = false,
  ): Promise<{ success: true }> {
    const existing = await this.getById(organizationId, portfolioId);
    if (hard) {
      await this.portfolioRepo.delete(portfolioId);
      await this.auditLogs.logAction(
        organizationId,
        userId,
        'portfolio',
        portfolioId,
        'delete',
        {
          portfolio_key: existing.portfolio_key,
        },
      );
    } else {
      await this.portfolioRepo.update(portfolioId, {
        is_archived: true,
        updated_by: userId,
      });
      await this.auditLogs.logAction(
        organizationId,
        userId,
        'portfolio',
        portfolioId,
        'archive',
        {
          portfolio_key: existing.portfolio_key,
        },
      );
    }
    return { success: true };
  }

  async listPlans(
    organizationId: string,
    userId: string,
    portfolioId: string,
  ): Promise<PortfolioPlanWithPlanAndSpace[]> {
    await this.getById(organizationId, portfolioId);
    const rows =
      await this.portfolioPlanRepo.findByPortfolioWithSpaces(portfolioId);
    const allowed: PortfolioPlanWithPlanAndSpace[] = [];
    for (const row of rows) {
      if (this.canExposePlan(row.plan, organizationId, userId)) {
        allowed.push(row);
      }
    }
    if (allowed.length > 0) {
      await this.plansService.hydratePlanProgress(
        allowed.map((r) => r.plan as unknown as Record<string, unknown>),
      );
    }
    return allowed;
  }

  async addPlan(
    organizationId: string,
    userId: string,
    portfolioId: string,
    dto: AddPortfolioPlanDto,
  ) {
    await this.getById(organizationId, portfolioId);
    const plan = await this.getPlanInOrg(dto.plan_id, organizationId);
    await this.assertUserCanAccessSpace(userId, organizationId, plan.space_id);
    const row = await this.portfolioPlanRepo.addPlan(
      portfolioId,
      dto.plan_id,
      userId,
    );
    await this.auditLogs.logAction(
      organizationId,
      userId,
      'portfolio_plan',
      row.id,
      'create',
      {
        portfolio_id: portfolioId,
        plan_id: dto.plan_id,
      },
    );
    return row;
  }

  async removePlan(
    organizationId: string,
    userId: string,
    portfolioId: string,
    planId: string,
  ): Promise<{ success: true }> {
    await this.getById(organizationId, portfolioId);
    const plan = await this.getPlanInOrg(planId, organizationId);
    await this.assertUserCanAccessSpace(userId, organizationId, plan.space_id);
    const removed = await this.portfolioPlanRepo.removePlan(
      portfolioId,
      planId,
    );
    await this.auditLogs.logAction(
      organizationId,
      userId,
      'portfolio_plan',
      removed.id,
      'delete',
      { portfolio_id: portfolioId, plan_id: planId },
    );
    return { success: true };
  }

  async getGanttView(
    organizationId: string,
    userId: string,
    portfolioId: string,
  ): Promise<PortfolioGanttTreeResponse> {
    const portfolio = await this.getById(organizationId, portfolioId);
    const items =
      await this.portfolioPlanRepo.findByPortfolioWithSpaces(portfolioId);

    type ResolvedPlan = {
      row: PortfolioGanttPlanRow;
      space: { id: string; key: string | null; name: string | null } | null;
    };

    // Pre-resolve a single user lookup for all distinct owners on this portfolio.
    const ownerIds = Array.from(
      new Set(
        items
          .map((item) => item.plan.owner_id ?? null)
          .filter((id): id is string => !!id),
      ),
    );
    this.logger.debug(
      `[getGanttView] portfolioId=${portfolioId} planCount=${items.length} ownerIds=${JSON.stringify(ownerIds)}`,
    );
    const ownersById = new Map<string, PortfolioGanttOwner>();
    if (ownerIds.length > 0) {
      const { data: ownerRows, error: ownerError } = await this.client
        .from('users')
        .select('id, first_name, last_name, avatar_url')
        .in('id', ownerIds);
      if (ownerError) {
        this.logger.error(
          `[getGanttView] users lookup failed: ${ownerError.message}`,
        );
      }
      this.logger.debug(
        `[getGanttView] ownerRows returned=${ownerRows?.length ?? 0}`,
      );
      for (const row of (ownerRows ?? []) as Array<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        avatar_url: string | null;
      }>) {
        ownersById.set(row.id, {
          id: row.id,
          first_name: row.first_name ?? null,
          last_name: row.last_name ?? null,
          avatar_url: row.avatar_url ?? null,
        });
      }
    }

    // Hydrate progress from task averages so Gantt bars reflect real completion.
    if (items.length > 0) {
      await this.plansService.hydratePlanProgress(
        items.map((item) => item.plan as unknown as Record<string, unknown>),
      );
    }

    // Pre-resolve latest management letter per plan in this portfolio.
    const planIds = items
      .map((item) => item.plan.id)
      .filter((id): id is string => !!id);
    const latestLetterByPlanId = new Map<
      string,
      { status: LetterStatusValue; reporting_period_end: string }
    >();
    if (planIds.length > 0) {
      const { data: letterRows } = await this.client
        .from('portfolio_management_letters')
        .select('plan_id, status, reporting_period_end')
        .eq('portfolio_id', portfolioId)
        .in('plan_id', planIds)
        .order('reporting_period_end', { ascending: false });
      for (const row of (letterRows ?? []) as Array<{
        plan_id: string;
        status: LetterStatusValue;
        reporting_period_end: string;
      }>) {
        if (!latestLetterByPlanId.has(row.plan_id)) {
          latestLetterByPlanId.set(row.plan_id, {
            status: row.status,
            reporting_period_end: row.reporting_period_end,
          });
        }
      }
    }

    const resolvedPlans: ResolvedPlan[] = [];
    for (let i = 0; i < items.length; i += 5) {
      const chunk = items.slice(i, i + 5);
      const resolved = await Promise.all(
        chunk.map(async ({ plan, space }) => {
          if (!this.canExposePlan(plan, organizationId, userId)) return null;
          const evm = await this.plansService
            .getEvmMetrics(plan.id, organizationId)
            .catch(() => null);
          const rag = this.computePlanRag(plan, evm);
          const start = plan.start_date ?? null;
          const end = plan.end_date ?? null;
          const planKey = plan.plan_key ?? null;
          const spaceKey = space?.key ?? '';
          const ownerId = plan.owner_id ?? null;
          const latestLetter = latestLetterByPlanId.get(plan.id) ?? null;
          const cpi =
            evm && evm['cost_performance_index'] != null
              ? Number(evm['cost_performance_index'])
              : null;
          const spi =
            evm && evm['schedule_performance_index'] != null
              ? Number(evm['schedule_performance_index'])
              : null;
          const row: PortfolioGanttPlanRow = {
            plan_id: plan.id,
            plan_key: planKey,
            name: plan.name,
            description:
              (plan as { description?: string | null }).description ?? null,
            start,
            end,
            progress: Number(plan.progress ?? 0),
            rag,
            rag_set_manually: plan.rag_set_manually === true,
            plan_status: (plan as { status?: string | null }).status ?? null,
            owner: ownerId ? (ownersById.get(ownerId) ?? null) : null,
            budget: plan.budget != null ? Number(plan.budget) : null,
            currency: plan.currency ?? null,
            cpi,
            spi,
            last_letter_status: latestLetter?.status ?? null,
            last_letter_date: latestLetter?.reporting_period_end ?? null,
            custom_field_values:
              (plan as { custom_field_values?: Record<string, unknown> })
                .custom_field_values ?? {},
            link:
              spaceKey && plan.id
                ? `/spaces/${spaceKey}/plans/${plan.id}`
                : '#',
            is_archived: plan.is_archived === true,
            is_tbd: !start || !end,
          };
          return { row, space: space ?? null } as ResolvedPlan;
        }),
      );
      for (const item of resolved) {
        if (item) resolvedPlans.push(item);
      }
    }

    // Group by space (null bucket for orphan plans).
    const groupsByKey = new Map<string, PortfolioGanttSpaceGroup>();
    for (const { row, space } of resolvedPlans) {
      const key = space?.id ?? '__orphan__';
      let group = groupsByKey.get(key);
      if (!group) {
        group = { space, plans: [] };
        groupsByKey.set(key, group);
      }
      group.plans.push(row);
    }

    const spaces = Array.from(groupsByKey.values()).sort((a, b) => {
      const an = a.space?.name ?? '';
      const bn = b.space?.name ?? '';
      // Orphan bucket (space === null) sorts last.
      if (!a.space && b.space) return 1;
      if (a.space && !b.space) return -1;
      return an.localeCompare(bn);
    });

    return {
      portfolio: {
        id: portfolio.id,
        portfolio_key: portfolio.portfolio_key,
        name: portfolio.name,
      },
      spaces,
    };
  }

  async getKpis(
    organizationId: string,
    userId: string,
    portfolioId: string,
  ): Promise<PortfolioKpis> {
    await this.getById(organizationId, portfolioId);
    const rows = await this.portfolioPlanRepo.findByPortfolio(portfolioId);
    const active: PlanRow[] = [];
    for (const { plan } of rows) {
      if (
        plan.is_archived !== true &&
        this.canExposePlan(plan, organizationId, userId)
      ) {
        active.push(plan);
      }
    }

    const metrics: Array<{
      plan: PlanRow;
      evm: Record<string, unknown> | null;
    }> = [];
    for (let i = 0; i < active.length; i += 5) {
      const chunk = active.slice(i, i + 5);
      metrics.push(
        ...(await Promise.all(
          chunk.map(async (plan) => ({
            plan,
            evm: await this.plansService
              .getEvmMetrics(plan.id, organizationId)
              .catch(() => null),
          })),
        )),
      );
    }

    return this.buildKpis(metrics);
  }

  async getSchedule(
    organizationId: string,
    portfolioId: string,
  ): Promise<UpdateLetterScheduleDto | null> {
    this.assertScheduleFeatureEnabled();
    const portfolio = await this.getById(organizationId, portfolioId);
    const schedule = portfolio.settings?.['letter_schedule'];
    return schedule
      ? this.validateSchedule(schedule as UpdateLetterScheduleDto)
      : null;
  }

  async setSchedule(
    organizationId: string,
    userId: string,
    portfolioId: string,
    dto: UpdateLetterScheduleDto,
  ): Promise<UpdateLetterScheduleDto> {
    this.assertScheduleFeatureEnabled();
    const validated = this.validateSchedule(dto);
    const portfolio = await this.getById(organizationId, portfolioId);
    const settings = {
      ...(portfolio.settings ?? {}),
      letter_schedule: validated,
    };
    await this.portfolioRepo.update(portfolioId, {
      settings,
      updated_by: userId,
    });
    await this.auditLogs.logAction(
      organizationId,
      userId,
      'portfolio',
      portfolioId,
      'update',
      {
        letter_schedule: validated,
      },
    );
    return validated;
  }

  async listLetters(
    organizationId: string,
    userId: string,
    portfolioId: string,
    status?: LetterStatus,
  ) {
    await this.getById(organizationId, portfolioId);
    const rows = await this.letterRepo.findByPortfolio(portfolioId, status);
    const allowed: Array<
      PortfolioManagementLetterRow & {
        plan?: { id: string; name: string; plan_key: string | null } | null;
      }
    > = [];
    for (const row of rows) {
      const plan = await this.getPlanInOrg(row.plan_id, organizationId).catch(
        () => null,
      );
      if (
        plan &&
        (await this.userCanAccessSpace(userId, organizationId, plan.space_id))
      ) {
        allowed.push({
          ...row,
          plan: {
            id: plan.id,
            name: plan.name,
            plan_key: plan.plan_key ?? null,
          },
        });
      }
    }
    return allowed;
  }

  async createLetter(
    organizationId: string,
    userId: string,
    portfolioId: string,
    dto: CreateLetterDto,
  ): Promise<PortfolioManagementLetterRow> {
    const portfolio = await this.getById(organizationId, portfolioId);
    if (
      new Date(dto.reporting_period_end) < new Date(dto.reporting_period_start)
    ) {
      throw new BadRequestException(
        'reporting_period_end must be on or after reporting_period_start',
      );
    }
    const plan = await this.getPlanInOrg(dto.plan_id, organizationId);
    await this.assertUserCanAccessSpace(userId, organizationId, plan.space_id);
    if (!(await this.portfolioPlanRepo.exists(portfolioId, plan.id))) {
      throw new BadRequestException('Plan is not part of this portfolio');
    }
    if (
      dto.assigned_to_user_id &&
      !(await this.userCanAccessSpace(
        dto.assigned_to_user_id,
        organizationId,
        plan.space_id,
      ))
    ) {
      throw new BadRequestException(
        'The selected user cannot access this plan.',
      );
    }
    const assigneeId =
      dto.assigned_to_user_id ??
      plan.owner_id ??
      (plan.created_by as string | null | undefined);
    if (!assigneeId)
      throw new BadRequestException(
        'No assignee resolved — provide assigned_to_user_id or set a plan owner',
      );
    await this.assertTasksModuleEnabled(plan.space_id);
    const taskTypeId = await this.resolveTaskTypeId(
      organizationId,
      plan.space_id,
    );
    const existing = await this.letterRepo.findByPlanAndPeriod(
      portfolioId,
      plan.id,
      dto.reporting_period_start,
      dto.reporting_period_end,
    );
    if (existing)
      throw new BadRequestException(
        `A letter for this period already exists (id=${existing.id})`,
      );

    const dueDate = dto.due_date ?? this.addDays(dto.reporting_period_end, 7);
    const baseRag = await this.deriveBaselineRag(plan, organizationId);
    const milestones = await this.derivePlanMilestones(
      plan,
      organizationId,
      userId,
      dto.reporting_period_start,
      dto.reporting_period_end,
    );
    const letter = await this.letterRepo.create({
      organization_id: organizationId,
      portfolio_id: portfolioId,
      plan_id: plan.id,
      reporting_period_start: dto.reporting_period_start,
      reporting_period_end: dto.reporting_period_end,
      status: 'draft',
      rag_schedule: dto.rag_schedule ?? baseRag?.rag_schedule ?? null,
      rag_budget: dto.rag_budget ?? baseRag?.rag_budget ?? null,
      rag_quality: dto.rag_quality ?? baseRag?.rag_quality ?? null,
      key_message: dto.key_message ?? null,
      milestones_achieved: milestones,
      due_date: dueDate,
      assigned_to_user_id: assigneeId,
      created_by: userId,
      updated_by: userId,
    });

    let taskId: string | null = null;
    try {
      const task = await this.tasksService.create(organizationId, userId, {
        space_id: plan.space_id,
        task_type_id: taskTypeId,
        summary: `Management Letter: ${plan.name} - ${dto.reporting_period_start} -> ${dto.reporting_period_end}`,
        description: this.buildLetterTaskDescription(
          plan.name,
          portfolio.portfolio_key ?? '',
          letter.id,
          dueDate,
        ),
        assigned_to: assigneeId,
        due_date: `${dueDate}T00:00:00.000Z`,
        priority: 'high',
        status: 'open',
      });
      taskId = task.id;
    } catch (error) {
      await this.letterRepo.delete(letter.id).catch(() => undefined);
      throw error;
    }

    const updated = await this.letterRepo.update(letter.id, {
      linked_task_id: taskId,
    });
    await this.createNotification({
      organization_id: organizationId,
      user_id: assigneeId,
      type: 'management_letter_assigned',
      title: 'New Management Letter assigned',
      body: `You have a Management Letter to complete for plan "${plan.name}".`,
      reference_type: 'portfolio_management_letter',
      reference_id: letter.id,
      metadata: {
        portfolio_key: portfolio.portfolio_key ?? '',
        plan_name: plan.name,
        linked_task_id: taskId,
      },
    });
    await this.auditLogs.logAction(
      organizationId,
      userId,
      'portfolio_management_letter',
      letter.id,
      'create',
      { plan_id: plan.id, linked_task_id: taskId },
    );
    return updated;
  }

  async getLetter(
    organizationId: string,
    userId: string,
    portfolioId: string,
    letterId: string,
  ): Promise<PortfolioManagementLetterRow> {
    const letter = await this.assertLetterInPortfolio(
      organizationId,
      portfolioId,
      letterId,
    );
    const plan = await this.getPlanInOrg(letter.plan_id, organizationId);
    await this.assertUserCanAccessSpace(userId, organizationId, plan.space_id);
    return letter;
  }

  async updateLetter(
    organizationId: string,
    userId: string,
    portfolioId: string,
    letterId: string,
    dto: UpdateLetterDto,
  ): Promise<PortfolioManagementLetterRow> {
    const letter = await this.getLetter(
      organizationId,
      userId,
      portfolioId,
      letterId,
    );
    if (letter.status === 'approved')
      throw new BadRequestException(
        'This letter is approved and cannot be modified',
      );
    const canManage = await this.permissionsService.checkPermission(
      userId,
      organizationId,
      'can_manage_portfolio_letters',
    );
    if (letter.assigned_to_user_id !== userId && !canManage) {
      throw new ForbiddenException(
        'Only the assignee or a portfolio manager can edit this letter',
      );
    }

    const isReassignment =
      dto.assigned_to_user_id !== undefined &&
      dto.assigned_to_user_id !== letter.assigned_to_user_id;
    if (isReassignment) {
      if (dto.assigned_to_user_id === null) {
        throw new BadRequestException(
          'A management letter must always have a responsible person.',
        );
      }
      if (!canManage) {
        throw new ForbiddenException(
          'Only a portfolio manager can reassign this letter.',
        );
      }
      const plan = await this.getPlanInOrg(letter.plan_id, organizationId);
      if (
        !(await this.userCanAccessSpace(
          dto.assigned_to_user_id ?? '',
          organizationId,
          plan.space_id,
        ))
      ) {
        throw new BadRequestException(
          'The selected user cannot access this plan.',
        );
      }
      if (letter.linked_task_id) {
        await this.tasksService
          .update(letter.linked_task_id, organizationId, userId, {
            assigned_to: dto.assigned_to_user_id,
          })
          .catch(() => undefined);
      }
      const portfolioForReassign =
        await this.portfolioRepo.findById(portfolioId);
      await this.createNotification({
        organization_id: organizationId,
        user_id: dto.assigned_to_user_id,
        type: 'management_letter_assigned',
        title: 'Management Letter reassigned to you',
        body: `A Management Letter for plan "${plan.name}" has been reassigned to you.`,
        reference_type: 'portfolio_management_letter',
        reference_id: letterId,
        metadata: {
          portfolio_key: portfolioForReassign?.portfolio_key ?? '',
          plan_name: plan.name,
          linked_task_id: letter.linked_task_id,
        },
      });
      await this.auditLogs.logAction(
        organizationId,
        userId,
        'portfolio_management_letter',
        letterId,
        'update',
        {
          reassigned_from: letter.assigned_to_user_id,
          reassigned_to: dto.assigned_to_user_id,
        },
      );
    }

    const updated = await this.letterRepo.update(letterId, {
      ...dto,
      updated_by: userId,
    });
    await this.auditLogs.logAction(
      organizationId,
      userId,
      'portfolio_management_letter',
      letterId,
      'update',
      dto as Record<string, unknown>,
    );
    return updated;
  }

  async submitLetter(
    organizationId: string,
    userId: string,
    portfolioId: string,
    letterId: string,
  ): Promise<PortfolioManagementLetterRow> {
    const letter = await this.getLetter(
      organizationId,
      userId,
      portfolioId,
      letterId,
    );
    if (letter.assigned_to_user_id !== userId) {
      throw new ForbiddenException('Only the assignee can submit this letter');
    }
    // Freeze the linked plan's current risks/blockers into risks_snapshot so the
    // approved letter is a point-in-time report. derivePlanRisks swallows errors
    // (returns []) — a missing plan or risk-read failure must not block submit.
    const plan = await this.getPlanInOrg(letter.plan_id, organizationId).catch(
      () => null,
    );
    const risksSnapshot = plan
      ? await this.derivePlanRisks(
          plan,
          organizationId,
          userId,
          letter.reporting_period_start,
          letter.reporting_period_end,
        )
      : [];
    const updated = await this.transitionLetter(letterId, 'draft', {
      status: 'submitted',
      submitted_at: new Date().toISOString(),
      submitted_by: userId,
      risks_snapshot: risksSnapshot,
      updated_by: userId,
    });
    if (letter.linked_task_id) {
      await this.tasksService
        .update(letter.linked_task_id, organizationId, userId, {
          status: 'done',
        })
        .catch(() => undefined);
    }
    await this.auditLogs.logAction(
      organizationId,
      userId,
      'portfolio_management_letter',
      letterId,
      'update',
      {
        from: 'draft',
        to: 'submitted',
      },
    );
    return updated;
  }

  async approveLetter(
    organizationId: string,
    userId: string,
    portfolioId: string,
    letterId: string,
  ): Promise<PortfolioManagementLetterRow> {
    const letter = await this.assertLetterInPortfolio(
      organizationId,
      portfolioId,
      letterId,
    );
    // Re-capture the snapshot on approval in case plan risks changed between
    // submit and approve. Same defensive fallback as submitLetter.
    const plan = await this.getPlanInOrg(letter.plan_id, organizationId).catch(
      () => null,
    );
    const risksSnapshot = plan
      ? await this.derivePlanRisks(
          plan,
          organizationId,
          userId,
          letter.reporting_period_start,
          letter.reporting_period_end,
        )
      : ((letter.risks_snapshot as Array<Record<string, unknown>> | null) ??
        []);
    const updated = await this.transitionLetter(letterId, 'submitted', {
      status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by: userId,
      risks_snapshot: risksSnapshot,
      updated_by: userId,
    });
    await this.auditLogs.logAction(
      organizationId,
      userId,
      'portfolio_management_letter',
      letterId,
      'update',
      {
        from: 'submitted',
        to: 'approved',
      },
    );
    return updated;
  }

  async rejectLetter(
    organizationId: string,
    userId: string,
    portfolioId: string,
    letterId: string,
    dto: RejectLetterDto,
  ): Promise<PortfolioManagementLetterRow> {
    const letter = await this.assertLetterInPortfolio(
      organizationId,
      portfolioId,
      letterId,
    );
    const updated = await this.transitionLetter(letterId, 'submitted', {
      status: 'draft',
      rejection_reason: dto.reason,
      rejected_at: new Date().toISOString(),
      rejected_by: userId,
      updated_by: userId,
    });
    if (letter.assigned_to_user_id) {
      const portfolioForReject = await this.portfolioRepo.findById(portfolioId);
      await this.createNotification({
        organization_id: organizationId,
        user_id: letter.assigned_to_user_id,
        type: 'management_letter_rejected',
        title: 'Management Letter rejected',
        body: dto.reason,
        reference_type: 'portfolio_management_letter',
        reference_id: letterId,
        metadata: {
          portfolio_key: portfolioForReject?.portfolio_key ?? '',
        },
      });
    }
    await this.auditLogs.logAction(
      organizationId,
      userId,
      'portfolio_management_letter',
      letterId,
      'update',
      {
        from: 'submitted',
        to: 'draft',
        reason: dto.reason,
      },
    );
    return updated;
  }

  async deleteLetter(
    organizationId: string,
    userId: string,
    portfolioId: string,
    letterId: string,
  ): Promise<{ success: true }> {
    const letter = await this.getLetter(
      organizationId,
      userId,
      portfolioId,
      letterId,
    );
    if (letter.status === 'approved')
      throw new BadRequestException('Approved letters cannot be deleted');
    const canManage = await this.permissionsService.checkPermission(
      userId,
      organizationId,
      'can_manage_portfolio_letters',
    );
    if (letter.assigned_to_user_id !== userId && !canManage) {
      throw new ForbiddenException(
        'Only the assignee or a portfolio manager can delete this letter',
      );
    }
    if (letter.linked_task_id) {
      await this.tasksService
        .delete(letter.linked_task_id, organizationId)
        .catch(() => undefined);
    }
    await this.letterRepo.delete(letterId);
    await this.auditLogs.logAction(
      organizationId,
      userId,
      'portfolio_management_letter',
      letterId,
      'delete',
      {
        plan_id: letter.plan_id,
      },
    );
    return { success: true };
  }

  private async getPlanInOrg(
    planId: string,
    organizationId: string,
  ): Promise<PlanRow> {
    const { data, error } = (await this.client
      .from('plans')
      .select('*')
      .eq('id', planId)
      .eq('organization_id', organizationId)
      .maybeSingle()) as {
      data: PlanRow | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Plan not found');
    return data;
  }

  private async userCanAccessSpace(
    userId: string,
    organizationId: string,
    spaceId: string,
    permission: 'view_plans' | 'edit_plans' = 'view_plans',
  ): Promise<boolean> {
    const { data: membership } = await this.client
      .from('organization_members')
      .select('role')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (membership?.role === 'owner' || membership?.role === 'admin')
      return true;

    const { data } = await this.client
      .from('space_members')
      .select('space_role, permissions')
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();

    if (!data) return false;
    const spaceRole =
      (data as { space_role?: string | null }).space_role ?? 'viewer';
    const basePermissions = SPACE_ROLE_BASE_PERMISSIONS[spaceRole] ?? {};
    const memberPermissions =
      (data as { permissions?: Record<string, boolean> | null }).permissions ??
      {};
    const permissions = normalizeSpacePermissions({
      ...basePermissions,
      ...memberPermissions,
    });
    return permissions[permission] === true;
  }

  private async assertUserCanAccessSpace(
    userId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<void> {
    if (
      !(await this.userCanAccessSpace(
        userId,
        organizationId,
        spaceId,
        'edit_plans',
      ))
    ) {
      throw new ForbiddenException('You do not have access to this plan space');
    }
  }

  private canExposePlan(
    plan: PlanRow,
    organizationId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _userId: string,
  ): boolean {
    // Portfolio access is already gated at the org level by the portfolio guard.
    // Space membership is not required for portfolio plan visibility — all plans
    // added to the portfolio belong to the same org and should be visible to any
    // portfolio viewer, regardless of their individual space memberships.
    return plan.organization_id === organizationId;
  }

  async recomputeRag(
    organizationId: string,
    userId: string,
    portfolioId: string,
    letterId: string,
  ): Promise<PortfolioManagementLetterRow> {
    const letter = await this.assertLetterInPortfolio(
      organizationId,
      portfolioId,
      letterId,
    );
    const plan = await this.getPlanInOrg(letter.plan_id, organizationId);
    await this.assertUserCanAccessSpace(userId, organizationId, plan.space_id);
    if (letter.status === 'approved')
      throw new ForbiddenException(
        'This letter is approved and cannot be modified',
      );
    const canManage = await this.permissionsService.checkPermission(
      userId,
      organizationId,
      'can_manage_portfolio_letters',
    );
    if (letter.assigned_to_user_id !== userId && !canManage) {
      throw new ForbiddenException(
        'Only the assignee or a portfolio manager can edit this letter',
      );
    }
    const baseRag = await this.deriveBaselineRag(plan, organizationId);
    if (!baseRag)
      throw new BadRequestException(
        'No active baseline for this plan — cannot derive RAG.',
      );
    const updated = await this.letterRepo.update(letterId, {
      rag_schedule: baseRag.rag_schedule,
      rag_budget: baseRag.rag_budget,
      rag_quality: baseRag.rag_quality,
      updated_by: userId,
    });
    await this.auditLogs.logAction(
      organizationId,
      userId,
      'portfolio_management_letter',
      letterId,
      'update',
      {
        rag_schedule: baseRag.rag_schedule,
        rag_budget: baseRag.rag_budget,
        rag_quality: baseRag.rag_quality,
        source: 'recompute_rag',
      },
    );
    return updated;
  }

  async recomputeMilestones(
    organizationId: string,
    userId: string,
    portfolioId: string,
    letterId: string,
  ): Promise<PortfolioManagementLetterRow> {
    const letter = await this.assertLetterInPortfolio(
      organizationId,
      portfolioId,
      letterId,
    );
    const plan = await this.getPlanInOrg(letter.plan_id, organizationId);
    await this.assertUserCanAccessSpace(userId, organizationId, plan.space_id);
    if (letter.status === 'approved')
      throw new ForbiddenException(
        'This letter is approved and cannot be modified',
      );
    const canManage = await this.permissionsService.checkPermission(
      userId,
      organizationId,
      'can_manage_portfolio_letters',
    );
    if (letter.assigned_to_user_id !== userId && !canManage) {
      throw new ForbiddenException(
        'Only the assignee or a portfolio manager can edit this letter',
      );
    }
    const milestones = await this.derivePlanMilestones(
      plan,
      organizationId,
      userId,
      letter.reporting_period_start,
      letter.reporting_period_end,
    );
    const updated = await this.letterRepo.update(letterId, {
      milestones_achieved: milestones,
      updated_by: userId,
    });
    await this.auditLogs.logAction(
      organizationId,
      userId,
      'portfolio_management_letter',
      letterId,
      'update',
      { milestones_count: milestones.length, source: 'recompute_milestones' },
    );
    return updated;
  }

  private evmIndexToRag(index: number): 'green' | 'amber' | 'red' {
    return index < 0.85 ? 'red' : index < 0.95 ? 'amber' : 'green';
  }

  private async deriveBaselineRag(
    plan: PlanRow,
    organizationId: string,
  ): Promise<{
    rag_schedule: 'green' | 'amber' | 'red' | null;
    rag_budget: 'green' | 'amber' | 'red' | null;
    rag_quality: 'green' | 'amber' | 'red' | null;
  } | null> {
    const evm = await this.plansService
      .getEvmMetrics(plan.id, organizationId)
      .catch(() => null);
    if (!evm) return null;
    const rag_schedule =
      Number(evm['planned_value']) > 0
        ? this.evmIndexToRag(Number(evm['schedule_performance_index']))
        : null;
    const rag_budget =
      Number(evm['actual_cost']) > 0
        ? this.evmIndexToRag(Number(evm['cost_performance_index']))
        : null;
    const quality = this.computePlanRag(plan, evm);
    const rag_quality = quality === 'unknown' ? null : quality;
    return { rag_schedule, rag_budget, rag_quality };
  }

  private async derivePlanMilestones(
    plan: PlanRow,
    organizationId: string,
    userId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<
    Array<{ title: string; description?: string; achieved_on?: string }>
  > {
    const { data: items } = await this.plansService
      .listItems(plan.id, organizationId, userId)
      .catch(() => ({ data: [] as Record<string, unknown>[] }));
    const milestones: Array<{
      title: string;
      description?: string;
      achieved_on?: string;
    }> = [];
    for (const item of items) {
      if (item['item_type'] !== 'milestone') continue;
      const rawCompleted = item['completed_at'];
      const rawEnd = item['end_date'];
      const completedDay =
        typeof rawCompleted === 'string' && rawCompleted
          ? rawCompleted.slice(0, 10)
          : null;
      const endDay =
        typeof rawEnd === 'string' && rawEnd ? rawEnd.slice(0, 10) : null;
      const refDay = completedDay ?? endDay;
      if (!refDay) continue;
      if (refDay < periodStart || refDay > periodEnd) continue;
      const rawName = item['name'];
      const title = (typeof rawName === 'string' ? rawName : '').slice(0, 500);
      if (!title.trim()) continue;
      const rawDescription = item['description'];
      const description =
        typeof rawDescription === 'string' && rawDescription
          ? rawDescription.slice(0, 2000)
          : undefined;
      milestones.push({ title, description, achieved_on: refDay });
    }
    return milestones;
  }

  /**
   * Snapshot the linked plan's current risk register (risks + blockers) into a
   * JSON-serialisable array. Used by recomputeRisks (manual refresh from the
   * letter form) and by submitLetter / approveLetter (frozen-on-status-transition
   * audit trail). Returns an empty array on any failure so the caller can still
   * transition the letter — a missing snapshot is preferable to a blocked submit.
   *
   * When periodStart and periodEnd are provided, results are filtered to risks
   * that were "active during the period" — i.e. created on or before periodEnd
   * AND not resolved before periodStart. This mirrors how derivePlanMilestones
   * scopes milestones to the reporting period.
   */
  private async derivePlanRisks(
    plan: PlanRow,
    organizationId: string,
    userId: string,
    periodStart?: string,
    periodEnd?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const items = await this.plansService
      .listRisks(plan.id, organizationId, userId)
      .catch(() => [] as Array<Record<string, unknown>>);

    // YYYY-MM-DD slices for safe ISO comparison without TZ pitfalls.
    const periodStartDay = periodStart ? periodStart.slice(0, 10) : null;
    const periodEndDay = periodEnd ? periodEnd.slice(0, 10) : null;

    const filtered = items.filter((item) => {
      if (!periodStartDay && !periodEndDay) return true;

      const createdRaw = item['created_at'];
      const updatedRaw = item['updated_at'];
      const status = (item['status'] as string | null | undefined) ?? '';
      const createdDay =
        typeof createdRaw === 'string' && createdRaw
          ? createdRaw.slice(0, 10)
          : null;
      const updatedDay =
        typeof updatedRaw === 'string' && updatedRaw
          ? updatedRaw.slice(0, 10)
          : null;

      // Future risks (logged after this report's window) — not relevant yet.
      if (periodEndDay && createdDay && createdDay > periodEndDay) return false;

      // Risks resolved before this period began — already in a prior letter,
      // not relevant for this reporting window.
      if (
        periodStartDay &&
        status === 'resolved' &&
        updatedDay &&
        updatedDay < periodStartDay
      ) {
        return false;
      }

      return true;
    });

    return filtered.map((item) => ({
      id: item['id'],
      plan_id: item['plan_id'],
      organization_id: item['organization_id'],
      name: item['name'],
      description: item['description'],
      risk_type: item['risk_type'],
      category: item['category'],
      probability: item['probability'],
      impact: item['impact'],
      expected_value: item['expected_value'],
      status: item['status'],
      owner_id: item['owner_id'],
      owner: item['owner'],
      mitigation_strategy: item['mitigation_strategy'],
      contingency_plan: item['contingency_plan'],
      response_date: item['response_date'],
      task_id: item['task_id'],
      is_blocker: item['is_blocker'] === true,
      created_at: item['created_at'],
      updated_at: item['updated_at'],
    }));
  }

  /**
   * Compute the budget consumption % for a letter from the linked plan's
   * task-level cost data, scoped to the letter's reporting period.
   *
   *   percent = SUM(actual_cost of tasks active during period)
   *             / COALESCE(plans.budget, SUM(estimated_cost of those tasks))
   *             × 100
   *
   * A task is "active during the period" if its [start_date, end_date]
   * overlaps [periodStart, periodEnd]. We deliberately do NOT filter on
   * completed_at — most tasks in this codebase never set it.
   *
   * Returns { percent: null, ... } when there is no usable denominator
   * (plan.budget unset/0 AND no overlapping estimates). Percent is clamped
   * to [0, 999.99] to match the DB column and Zod schema.
   */
  private async derivePlanBudgetConsumption(
    plan: PlanRow,
    periodStart: string,
    periodEnd: string,
  ): Promise<{
    percent: number | null;
    period_actual_cost: number;
    denominator: number;
    denominator_source: 'plan_budget' | 'estimated_cost' | 'none';
  }> {
    const periodStartDay = (periodStart ?? '').slice(0, 10);
    const periodEndDay = (periodEnd ?? '').slice(0, 10);

    const { data, error } = await this.client
      .from('plan_tasks')
      .select('task:tasks(actual_cost, estimated_cost, start_date, end_date)')
      .eq('plan_id', plan.id);

    if (error) {
      this.logger.warn(
        `derivePlanBudgetConsumption: plan_tasks query failed for plan ${plan.id}: ${error.message}`,
      );
      return {
        percent: null,
        period_actual_cost: 0,
        denominator: 0,
        denominator_source: 'none',
      };
    }

    // Supabase types the nested select as an array (1:N possibility) even though
    // task_id is a single FK; cast via unknown and normalise to a single task or null.
    const rawRows = (data ?? []) as unknown as Array<{
      task: Record<string, unknown> | Array<Record<string, unknown>> | null;
    }>;
    const rows: Array<Record<string, unknown> | null> = rawRows.map((r) => {
      if (!r.task) return null;
      return Array.isArray(r.task) ? (r.task[0] ?? null) : r.task;
    });

    let periodActualCost = 0;
    let periodEstimatedCost = 0;

    for (const t of rows) {
      if (!t) continue;
      const startRaw = t['start_date'];
      const endRaw = t['end_date'];
      const startDay =
        typeof startRaw === 'string' && startRaw ? startRaw.slice(0, 10) : null;
      const endDay =
        typeof endRaw === 'string' && endRaw ? endRaw.slice(0, 10) : null;

      // Period overlap: task starts on/before period end AND
      //                 (task has no end OR ends on/after period start).
      if (periodEndDay && startDay && startDay > periodEndDay) continue;
      if (periodStartDay && endDay && endDay < periodStartDay) continue;

      const actual = Number(t['actual_cost'] ?? 0);
      const estimated = Number(t['estimated_cost'] ?? 0);
      if (Number.isFinite(actual)) periodActualCost += actual;
      if (Number.isFinite(estimated)) periodEstimatedCost += estimated;
    }

    const planBudget = Number(plan['budget'] ?? 0);
    let denominator: number;
    let denominator_source: 'plan_budget' | 'estimated_cost' | 'none';

    if (planBudget > 0) {
      denominator = planBudget;
      denominator_source = 'plan_budget';
    } else if (periodEstimatedCost > 0) {
      denominator = periodEstimatedCost;
      denominator_source = 'estimated_cost';
    } else {
      denominator = 0;
      denominator_source = 'none';
    }

    if (denominator === 0) {
      return {
        percent: null,
        period_actual_cost: periodActualCost,
        denominator: 0,
        denominator_source,
      };
    }

    const raw = (periodActualCost / denominator) * 100;
    const clamped = Math.max(0, Math.min(999.99, raw));
    const percent = Math.round(clamped * 100) / 100;

    return {
      percent,
      period_actual_cost: periodActualCost,
      denominator,
      denominator_source,
    };
  }

  async recomputeRisks(
    organizationId: string,
    userId: string,
    portfolioId: string,
    letterId: string,
  ): Promise<PortfolioManagementLetterRow> {
    const letter = await this.assertLetterInPortfolio(
      organizationId,
      portfolioId,
      letterId,
    );
    const plan = await this.getPlanInOrg(letter.plan_id, organizationId);
    await this.assertUserCanAccessSpace(userId, organizationId, plan.space_id);
    if (letter.status === 'approved')
      throw new ForbiddenException(
        'This letter is approved and cannot be modified',
      );
    const canManage = await this.permissionsService.checkPermission(
      userId,
      organizationId,
      'can_manage_portfolio_letters',
    );
    if (letter.assigned_to_user_id !== userId && !canManage) {
      throw new ForbiddenException(
        'Only the assignee or a portfolio manager can edit this letter',
      );
    }
    const risks = await this.derivePlanRisks(
      plan,
      organizationId,
      userId,
      letter.reporting_period_start,
      letter.reporting_period_end,
    );
    const updated = await this.letterRepo.update(letterId, {
      risks_snapshot: risks,
      updated_by: userId,
    });
    await this.auditLogs.logAction(
      organizationId,
      userId,
      'portfolio_management_letter',
      letterId,
      'update',
      { risks_count: risks.length, source: 'recompute_risks' },
    );
    return updated;
  }

  async recomputeBudgetConsumption(
    organizationId: string,
    userId: string,
    portfolioId: string,
    letterId: string,
  ): Promise<PortfolioManagementLetterRow> {
    const letter = await this.assertLetterInPortfolio(
      organizationId,
      portfolioId,
      letterId,
    );
    const plan = await this.getPlanInOrg(letter.plan_id, organizationId);
    await this.assertUserCanAccessSpace(userId, organizationId, plan.space_id);
    if (letter.status === 'approved')
      throw new ForbiddenException(
        'This letter is approved and cannot be modified',
      );
    const canManage = await this.permissionsService.checkPermission(
      userId,
      organizationId,
      'can_manage_portfolio_letters',
    );
    if (letter.assigned_to_user_id !== userId && !canManage) {
      throw new ForbiddenException(
        'Only the assignee or a portfolio manager can edit this letter',
      );
    }

    const result = await this.derivePlanBudgetConsumption(
      plan,
      letter.reporting_period_start,
      letter.reporting_period_end,
    );

    const updated = await this.letterRepo.update(letterId, {
      budget_consumption_percent: result.percent,
      updated_by: userId,
    });

    await this.auditLogs.logAction(
      organizationId,
      userId,
      'portfolio_management_letter',
      letterId,
      'update',
      {
        percent: result.percent,
        period_actual_cost: result.period_actual_cost,
        denominator: result.denominator,
        denominator_source: result.denominator_source,
        source: 'recompute_budget_consumption',
      },
    );

    return updated;
  }

  private computePlanRag(
    plan: PlanRow,
    evm: Record<string, unknown> | null,
  ): RagValue {
    if (plan.rag_set_manually)
      return (plan.rag_status as RagValue) ?? 'unknown';
    if (!evm) return 'unknown';
    const spi = Number(evm['schedule_performance_index'] ?? 0);
    const cpi = Number(evm['cost_performance_index'] ?? 0);
    const overdue =
      plan.end_date &&
      new Date(plan.end_date).getTime() < Date.now() &&
      Number(plan.progress ?? 0) < 100;
    if (overdue || spi < 0.85 || cpi < 0.85) return 'red';
    if (spi < 0.95 || cpi < 0.95) return 'amber';
    return 'green';
  }

  private buildKpis(
    metrics: Array<{ plan: PlanRow; evm: Record<string, unknown> | null }>,
  ): PortfolioKpis {
    const result: PortfolioKpis = {
      totalPlans: metrics.length,
      green: 0,
      amber: 0,
      red: 0,
      unknown: 0,
      overbudget: 0,
      overtime: 0,
      totalsByCurrency: {},
      weightedProgress: null,
      plansWithoutBaseline: 0,
      plansAtRisk: [],
      overbudgetPlans: [],
      overtimePlans: [],
    };
    let weightedNumerator = 0;
    let weightedDenominator = 0;
    const now = Date.now();

    for (const { plan, evm } of metrics) {
      const rag = this.computePlanRag(plan, evm);
      result[rag] += 1;
      if (rag === 'red') {
        result.plansAtRisk.push({
          plan_id: plan.id,
          plan_key: plan.plan_key,
          name: plan.name,
          reason: 'RAG=red',
        });
      }
      if (!evm) {
        result.plansWithoutBaseline += 1;
      } else {
        const cpi = Number(evm['cost_performance_index'] ?? 0);
        const spi = Number(evm['schedule_performance_index'] ?? 0);
        if (cpi < 1) {
          result.overbudget += 1;
          result.overbudgetPlans.push({
            plan_id: plan.id,
            plan_key: plan.plan_key,
            name: plan.name,
            cpi,
          });
        }
        const overdue =
          plan.end_date &&
          new Date(plan.end_date).getTime() < now &&
          Number(plan.progress ?? 0) < 100;
        if (spi < 1 || overdue) {
          result.overtime += 1;
          result.overtimePlans.push({
            plan_id: plan.id,
            plan_key: plan.plan_key,
            name: plan.name,
            spi,
          });
        }
      }
      const currency = plan.currency ?? 'EUR';
      const budget = Number(plan.budget ?? 0);
      result.totalsByCurrency[currency] =
        (result.totalsByCurrency[currency] ?? 0) + budget;
      if (budget > 0) {
        weightedNumerator += budget * Number(plan.progress ?? 0);
        weightedDenominator += budget;
      }
    }
    result.weightedProgress =
      weightedDenominator > 0
        ? Math.round((weightedNumerator / weightedDenominator) * 10) / 10
        : null;
    return result;
  }

  private assertScheduleFeatureEnabled(): void {
    const enabled =
      this.configService.get<string>('features.portfolioLetterSchedule') ??
      process.env.PORTFOLIO_LETTER_SCHEDULE_ENABLED ??
      process.env.NEXT_PUBLIC_FEATURE_PORTFOLIO_LETTER_SCHEDULE;
    if (enabled !== 'true') throw new NotFoundException('Not Found');
  }

  private validateSchedule(
    dto: UpdateLetterScheduleDto,
  ): UpdateLetterScheduleDto {
    if (
      (dto.cadence === 'weekly' || dto.cadence === 'biweekly') &&
      dto.day_of_period > 7
    ) {
      throw new BadRequestException('day_of_period out of range for cadence');
    }
    if (dto.cadence === 'quarterly' && dto.day_of_period > 28) {
      throw new BadRequestException('day_of_period out of range for cadence');
    }
    return dto;
  }

  private async assertTasksModuleEnabled(spaceId: string): Promise<void> {
    const { data, error } = await this.client
      .from('space_modules')
      .select('is_enabled')
      .eq('space_id', spaceId)
      .eq('module_type', 'tasks')
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data || data.is_enabled === false) {
      throw new BadRequestException(
        "The Tasks module is disabled in this plan's space",
      );
    }
  }

  private async resolveTaskTypeId(
    organizationId: string,
    spaceId: string,
  ): Promise<string> {
    const spaceConfigResult = await this.client
      .from('task_hierarchy_configurations')
      .select('config')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .maybeSingle();
    const { error } = spaceConfigResult;
    let data = spaceConfigResult.data;

    if (error) throw new BadRequestException(error.message);

    // Fall back to org-wide config (space_id IS NULL) when no space-specific row exists.
    // Mirrors the pattern in plans.service.ts — orgs typically have one default row
    // with space_id IS NULL plus optional per-space overrides.
    if (!data) {
      const fallbackResult = await this.client
        .from('task_hierarchy_configurations')
        .select('config')
        .eq('organization_id', organizationId)
        .is('space_id', null)
        .maybeSingle();

      if (fallbackResult.error)
        throw new BadRequestException(fallbackResult.error.message);
      data = fallbackResult.data;
    }

    const levels = (
      (data?.config as { levels?: Array<Record<string, unknown>> } | null)
        ?.levels ?? []
    ).filter((level) => level && level['is_active'] !== false);
    const preferred = levels.find((level) => level['id'] === 'task');
    const fallback = levels
      .slice()
      .sort(
        (a, b) => Number(b['sort_order'] ?? 0) - Number(a['sort_order'] ?? 0),
      )[0];
    const taskTypeId = (preferred?.['id'] ?? fallback?.['id']) as
      | string
      | undefined;

    if (!taskTypeId)
      throw new BadRequestException(
        'Plan space has no active task type configured',
      );
    return taskTypeId;
  }

  private addDays(input: string, days: number): string {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) return input;
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  private buildLetterTaskDescription(
    planName: string,
    portfolioKey: string,
    letterId: string,
    dueDate: string,
  ): string {
    const url = portfolioKey
      ? `/portfolios/${portfolioKey}/letters/${letterId}`
      : `/portfolios/letters/${letterId}`;
    return [
      `Please complete the Management Letter for plan **${planName}**.`,
      '',
      `Due by **${dueDate}**.`,
      '',
      'Sections to fill in:',
      '1. Project Basics & Management Summary (RAG schedule / budget / quality)',
      '2. Milestones Achieved',
      '3. Current Progress & Outlook',
      '4. Resources & Budget',
      '5. Risks & Issues',
      '',
      `Open the letter: ${url}`,
    ].join('\n');
  }

  private async createNotification(
    input: Record<string, unknown>,
  ): Promise<void> {
    try {
      const { data: inserted } = await this.client
        .from('notifications')
        .insert({ action_status: 'none', metadata: {}, ...input })
        .select()
        .maybeSingle();

      if (inserted) {
        void this.notificationEmail?.emailForNotifications([
          inserted as Record<string, unknown>,
        ]);
      }
    } catch {
      // Notification + email are intentionally best-effort.
    }
  }

  private async assertLetterInPortfolio(
    organizationId: string,
    portfolioId: string,
    letterId: string,
  ): Promise<PortfolioManagementLetterRow> {
    await this.getById(organizationId, portfolioId);
    const letter = await this.letterRepo.findById(letterId);
    if (
      !letter ||
      letter.organization_id !== organizationId ||
      letter.portfolio_id !== portfolioId
    ) {
      throw new NotFoundException('Letter not found');
    }
    return letter;
  }

  private async transitionLetter(
    letterId: string,
    expectedStatus: LetterStatus,
    patch: Record<string, unknown>,
  ): Promise<PortfolioManagementLetterRow> {
    const updated = await this.letterRepo.transitionStatus(
      letterId,
      expectedStatus,
      patch,
    );
    if (!updated) {
      throw new BadRequestException(
        `Letter is not in ${expectedStatus} state - refresh and try again`,
      );
    }
    return updated;
  }
}
