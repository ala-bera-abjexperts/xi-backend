import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  ResourcePlanningService,
  type SpaceScope,
} from '../resource-planning.service';
import { assertSpaceInScope, rowSpaceFilter } from '../space-scope.util';
import { WorkingCalendarService } from '../calendar/working-calendar.service';
import type { WorkingCalendarContext } from '../calendar/working-calendar.engine';
import type { ResourcePlanningReportQueryDto } from './dto/resource-planning-report-query.dto';
import {
  buildResourcePlanningReport,
  normalizeResourcePlanningReportQuery,
} from './resource-planning-report.engine';
import type {
  NormalizedResourcePlanningReportQuery,
  ResourcePlanningReport,
  ResourcePlanningReportDataset,
} from './resource-planning-report.types';

const PAGE_SIZE = 1_000;
const MAX_SOURCE_ROWS = 10_000;
const ID_BATCH_SIZE = 200;

interface QueryError {
  message: string;
}

interface QueryResult<T> {
  data: T[] | null;
  error: QueryError | null;
}

interface UserJoinRow {
  user_id: string;
  user:
    | {
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string;
      }
    | Array<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string;
      }>
    | null;
}

@Injectable()
export class ResourcePlanningReportService {
  private readonly logger = new Logger(ResourcePlanningReportService.name);

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly orgModulesService: OrganizationModulesService,
    private readonly workingCalendarService: WorkingCalendarService,
    private readonly resourcePlanningService: ResourcePlanningService,
    private readonly permissionsService: PermissionsService,
  ) {}

  /**
   * Shared by the REST controller and dashboard widget data source.
   * `userId` is only used for the group_by=portfolio per-plan access check
   * (see loadDataset / computeAccessiblePlanIds) -- every other grouping mode
   * ignores it entirely.
   */
  async getReport(
    organizationId: string,
    query: Partial<ResourcePlanningReportQueryDto>,
    userId: string,
  ): Promise<ResourcePlanningReport> {
    const enabled = await this.orgModulesService.isEnabled(
      organizationId,
      'resource_planning',
    );
    if (!enabled) {
      throw new ForbiddenException('Resource Planning module is not enabled');
    }

    const normalized = normalizeResourcePlanningReportQuery(query);

    // Portfolio grouping exposes portfolio names and rolled-up plan data, so it needs
    // the portfolio entitlement too. Cannot be a @RequireFeature decorator -- that is
    // class-level and would gate every other grouping as well.
    if (normalized.group_by === 'portfolio') {
      const portfolioEnabled = await this.orgModulesService.isEnabled(
        organizationId,
        'portfolio',
      );
      if (!portfolioEnabled) {
        throw new ForbiddenException('Portfolio module is not enabled');
      }

      const canViewPortfolios = await this.permissionsService.hasAllPermissions(
        userId,
        organizationId,
        ['can_view_portfolios'],
      );
      if (!canViewPortfolios) {
        throw new ForbiddenException('Missing permission: can_view_portfolios');
      }

      if (normalized.group_id) {
        await this.assertPortfolioInOrganization(
          normalized.group_id,
          organizationId,
        );
      }
    }
    if (normalized.portfolio_id) {
      await this.assertPortfolioInOrganization(
        normalized.portfolio_id,
        organizationId,
      );
    }
    const dataset = await this.loadDataset(organizationId, normalized, userId);
    return buildResourcePlanningReport(dataset, normalized);
  }

  /** Mirrors ResourcePlanningService.assertPortfolioInOrganization. */
  private async assertPortfolioInOrganization(
    portfolioId: string,
    organizationId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('portfolios')
      .select('id')
      .eq('id', portfolioId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        `Unable to verify portfolio: ${error.message}`,
      );
    }
    if (!data) throw new NotFoundException('Portfolio not found');
  }

  private async loadDataset(
    organizationId: string,
    query: NormalizedResourcePlanningReportQuery,
    userId: string,
  ): Promise<ResourcePlanningReportDataset> {
    // Fixed-space view: a space outside the caller's scope is refused before
    // any table is read. Without space_id the scope is resolved after the
    // load, exactly as before.
    let requestedScope: SpaceScope | undefined;
    if (query.space_id) {
      requestedScope = await this.resourcePlanningService.resolveSpaceScope(
        organizationId,
        userId,
      );
      assertSpaceInScope(requestedScope, query.space_id);
    }

    const [
      rawMemberRows,
      units,
      unitMemberships,
      capacities,
      capacityPeriods,
      rawPlans,
      rawAllocations,
      portfolios,
      rawTimeEntries,
      rawBudgetEntries,
      hasAnyScheme,
    ] = await Promise.all([
      this.fetchPaged<UserJoinRow>('organization members', (from, to) =>
        this.client
          .from('organization_members')
          .select(
            'user_id, user:users!organization_members_user_id_fkey(id, first_name, last_name, email)',
          )
          .eq('organization_id', organizationId)
          .range(from, to),
      ),
      this.fetchPaged<ResourcePlanningReportDataset['units'][number]>(
        'organization units',
        (from, to) =>
          this.client
            .from('organization_units')
            .select('id, parent_id, name, is_active')
            .eq('organization_id', organizationId)
            .range(from, to),
      ),
      this.fetchPaged<ResourcePlanningReportDataset['unitMemberships'][number]>(
        'unit memberships',
        (from, to) =>
          this.client
            .from('organization_unit_memberships')
            .select(
              'unit_id, user_id, effective_from, effective_to, allocation_percent',
            )
            .eq('organization_id', organizationId)
            .lte('effective_from', query.to)
            .or(`effective_to.is.null,effective_to.gte.${query.from}`)
            .range(from, to),
      ),
      this.fetchPaged<ResourcePlanningReportDataset['capacities'][number]>(
        'employee capacities',
        (from, to) =>
          this.client
            .from('employee_capacity')
            .select(
              'user_id, weekly_capacity_hours, cost_rate, currency, is_active',
            )
            .eq('organization_id', organizationId)
            .range(from, to),
      ),
      this.fetchPaged<ResourcePlanningReportDataset['capacityPeriods'][number]>(
        'employee capacity periods',
        (from, to) =>
          this.client
            .from('employee_capacity_periods')
            .select(
              'user_id, effective_from, effective_to, weekly_capacity_hours, cost_rate, currency, is_active',
            )
            .eq('organization_id', organizationId)
            .lte('effective_from', query.to)
            .or(`effective_to.is.null,effective_to.gte.${query.from}`)
            .range(from, to),
      ),
      this.fetchPaged<ResourcePlanningReportDataset['plans'][number]>(
        'plans',
        (from, to) =>
          this.client
            .from('plans')
            .select(
              // space_id is only used below for the group_by=portfolio
              // per-plan access check -- it never reaches the engine's
              // row/total output.
              'id, name, currency, start_date, end_date, is_archived, space_id',
            )
            .eq('organization_id', organizationId)
            .range(from, to),
      ),
      this.fetchPaged<ResourcePlanningReportDataset['allocations'][number]>(
        'plan allocations',
        (from, to) =>
          this.client
            .from('plan_resource_allocations')
            .select(
              'id, plan_id, user_id, allocation_mode, planned_hours, planned_budget, weekly_hours, capacity_percent, start_date, end_date',
            )
            .eq('organization_id', organizationId)
            .range(from, to),
      ),
      this.fetchPaged<ResourcePlanningReportDataset['portfolios'][number]>(
        'portfolios',
        (from, to) =>
          this.client
            .from('portfolios')
            .select('id, name, is_archived')
            .eq('organization_id', organizationId)
            .range(from, to),
      ),
      this.fetchPaged<ResourcePlanningReportDataset['timeEntries'][number]>(
        'time entries',
        (from, to) =>
          this.client
            .from('time_entries')
            .select('id, task_id, user_id, duration_minutes, logged_at')
            .eq('organization_id', organizationId)
            .gte('logged_at', `${query.from}T00:00:00.000Z`)
            .lte('logged_at', `${query.to}T23:59:59.999Z`)
            .range(from, to),
      ),
      this.fetchPaged<ResourcePlanningReportDataset['budgetEntries'][number]>(
        'resource budget entries',
        (from, to) =>
          this.client
            .from('resource_budget_entries')
            .select(
              'id, plan_id, task_id, entry_type, amount, currency, effective_date',
            )
            .eq('organization_id', organizationId)
            // D9: a rollup-flagged row's amount is a placeholder, not a cost
            // fact -- its real value is computed live by the budget-tree API.
            // Summing it here (or a null-aggregation legacy row, which is
            // impossible since the column is NOT NULL DEFAULT 'manual', but
            // the explicit filter documents the invariant either way) would
            // double-count against the tree's own rollup computation.
            .eq('aggregation', 'manual')
            .gte('effective_date', query.from)
            .lte('effective_date', query.to)
            .range(from, to),
      ),
      this.workingCalendarService.hasAnySchemeConfigured(organizationId),
    ]);

    // Plan/task-bound facts only from spaces with the RP space module on that
    // this user may see, plus null-space rows -- or, with space_id, only that
    // space's rows. People, units and capacity stay org-wide (space_id narrows
    // people below). Everything below (planTasks, portfolio scoping) reads the
    // filtered arrays, so the dashboard widget and exports inherit this too.
    const spaceScope =
      requestedScope ??
      (await this.resourcePlanningService.resolveSpaceScope(
        organizationId,
        userId,
      ));
    const inScope = rowSpaceFilter(spaceScope, query.space_id);
    const plans = rawPlans.filter((plan) => inScope(plan.space_id ?? null));
    const visiblePlanIds = new Set(plans.map((plan) => plan.id));
    const allocations = rawAllocations.filter((item) =>
      visiblePlanIds.has(item.plan_id),
    );
    // Ids come from the org-filtered rows above, so this lookup stays in-tenant.
    const taskSpaces = new Map(
      (
        await this.fetchByIds<{ id: string; space_id: string | null }>(
          'tasks',
          'tasks',
          'id, space_id',
          'id',
          [
            ...new Set([
              ...rawTimeEntries.map((item) => item.task_id),
              ...rawBudgetEntries.flatMap((item) =>
                item.task_id ? [item.task_id] : [],
              ),
            ]),
          ],
        )
      ).map((task) => [task.id, task.space_id]),
    );
    const timeEntries = rawTimeEntries.filter((item) =>
      inScope(taskSpaces.get(item.task_id)),
    );
    const budgetEntries = rawBudgetEntries.filter((item) =>
      item.plan_id
        ? visiblePlanIds.has(item.plan_id)
        : inScope(item.task_id ? taskSpaces.get(item.task_id) : null),
    );
    // space_id: only people with a kept allocation or time entry in that space.
    // Units, memberships and capacity rows stay as loaded -- the engine only
    // reports people present, and every calendar it reads belongs to one of
    // them, so the calendar resolution below narrows with this list.
    const spaceUserIds = query.space_id
      ? new Set([...allocations, ...timeEntries].map((item) => item.user_id))
      : undefined;
    const memberRows = spaceUserIds
      ? rawMemberRows.filter((row) => spaceUserIds.has(row.user_id))
      : rawMemberRows;

    // Resource Planning 2.0, opt-in (D6/R1, gate 2). Only resolved when the org
    // has ever configured a scheme — every existing org gets `undefined` here,
    // which the engine treats as the legacy /7 signal for every user.
    let workingCalendars: Map<string, WorkingCalendarContext> | undefined;
    if (hasAnyScheme) {
      workingCalendars = new Map();
      await Promise.all(
        memberRows.map(async (row) => {
          const calendar =
            await this.workingCalendarService.resolveCalendarContext(
              organizationId,
              row.user_id,
              query.from,
              query.to,
            );
          if (calendar) workingCalendars!.set(row.user_id, calendar);
        }),
      );
    }

    const planIds = plans.map((item) => item.id);
    const portfolioIds = portfolios.map((item) => item.id);
    const [planTasks, portfolioPlans] = await Promise.all([
      this.fetchByIds<ResourcePlanningReportDataset['planTasks'][number]>(
        'plan tasks',
        'plan_tasks',
        'plan_id, task_id',
        'plan_id',
        planIds,
      ),
      this.fetchByIds<ResourcePlanningReportDataset['portfolioPlans'][number]>(
        'portfolio plans',
        'portfolio_plans',
        'portfolio_id, plan_id',
        'portfolio_id',
        portfolioIds,
      ),
    ]);

    // Security: group_by=portfolio must not surface a plan the requesting
    // user cannot individually access. group_by=user/unit/plan are
    // untouched -- this only runs, and accessiblePlanIds is only set, in
    // portfolio mode.
    const accessiblePlanIds =
      query.group_by === 'portfolio'
        ? await this.computeAccessiblePlanIds(
            organizationId,
            userId,
            plans,
            portfolioPlans,
            query.group_id,
          )
        : undefined;

    // Optional portfolio_id filter (any group_by): restrict the report to the
    // plans linked to this portfolio that pass the same per-plan access check
    // (computeAccessiblePlanIds with groupId set candidates exactly those
    // linked plans). Everything plan-scoped funnels through the five arrays
    // below -- actuals join to plans via planTasks, so filtering them here
    // scopes hours, costs and actuals at once.
    if (query.portfolio_id) {
      const scopedPlanIds = await this.computeAccessiblePlanIds(
        organizationId,
        userId,
        plans,
        portfolioPlans,
        query.portfolio_id,
      );
      const scopedPlans = plans.filter((plan) => scopedPlanIds.has(plan.id));
      if (scopedPlans.length === 0) return this.emptyDataset();

      const scopedPlanIdSet = new Set(scopedPlans.map((plan) => plan.id));
      const scopedTaskIds = new Set(
        planTasks
          .filter((item) => scopedPlanIdSet.has(item.plan_id))
          .map((item) => item.task_id),
      );

      return {
        users: memberRows.flatMap((row) => {
          const user = Array.isArray(row.user) ? row.user[0] : row.user;
          if (!user) return [];
          const fullName = [user.first_name, user.last_name]
            .filter(Boolean)
            .join(' ')
            .trim();
          return [{ id: row.user_id, name: fullName || user.email }];
        }),
        units,
        unitMemberships,
        capacities: capacities.map(normalizeCapacity),
        capacityPeriods: capacityPeriods.map(normalizeCapacityPeriod),
        plans: scopedPlans,
        allocations: allocations
          .filter((item) => scopedPlanIdSet.has(item.plan_id))
          .map((item) => ({
            ...item,
            planned_hours: numeric(item.planned_hours),
            planned_budget: numeric(item.planned_budget),
            weekly_hours: nullableNumeric(item.weekly_hours),
            capacity_percent: nullableNumeric(item.capacity_percent),
          })),
        planTasks: planTasks.filter((item) =>
          scopedPlanIdSet.has(item.plan_id),
        ),
        portfolioPlans,
        portfolios,
        timeEntries: timeEntries
          .filter((item) => scopedTaskIds.has(item.task_id))
          .map((item) => ({
            ...item,
            duration_minutes: numeric(item.duration_minutes),
          })),
        budgetEntries: budgetEntries
          .filter((item) => item.plan_id && scopedPlanIdSet.has(item.plan_id))
          .map((item) => ({
            ...item,
            amount: numeric(item.amount),
            currency: (item.currency ?? '').toUpperCase(),
          })),
        workingCalendars,
      };
    }

    return {
      users: memberRows.flatMap((row) => {
        const user = Array.isArray(row.user) ? row.user[0] : row.user;
        if (!user) return [];
        const fullName = [user.first_name, user.last_name]
          .filter(Boolean)
          .join(' ')
          .trim();
        return [{ id: row.user_id, name: fullName || user.email }];
      }),
      units,
      unitMemberships,
      capacities: capacities.map(normalizeCapacity),
      capacityPeriods: capacityPeriods.map(normalizeCapacityPeriod),
      plans,
      allocations: allocations.map((item) => ({
        ...item,
        planned_hours: numeric(item.planned_hours),
        planned_budget: numeric(item.planned_budget),
        weekly_hours: nullableNumeric(item.weekly_hours),
        capacity_percent: nullableNumeric(item.capacity_percent),
      })),
      planTasks,
      portfolioPlans,
      portfolios,
      timeEntries: timeEntries.map((item) => ({
        ...item,
        duration_minutes: numeric(item.duration_minutes),
      })),
      budgetEntries: budgetEntries.map((item) => ({
        ...item,
        amount: numeric(item.amount),
        // Legacy/imported rows can bypass DTO validation and land with a
        // null currency; fall back to '' so the engine's own
        // normalizeCurrency() handles it downstream instead of throwing.
        currency: (item.currency ?? '').toUpperCase(),
      })),
      workingCalendars,
      accessiblePlanIds,
    };
  }

  /** The shape the engine returns for no data: empty rows, zeroed exceptions. */
  private emptyDataset(): ResourcePlanningReportDataset {
    return {
      users: [],
      units: [],
      unitMemberships: [],
      capacities: [],
      capacityPeriods: [],
      plans: [],
      allocations: [],
      planTasks: [],
      portfolioPlans: [],
      portfolios: [],
      timeEntries: [],
      budgetEntries: [],
    };
  }

  /**
   * group_by=portfolio only. Restricts the check to plans actually linked to
   * the requested portfolio(s), plus (Fix 2b, only when groupId is unset)
   * every portfolio-less plan -- the engine's Unallocated bucket now surfaces
   * those in the "all portfolios" view, so they must be access-checked too,
   * or that bucket would leak a plan the user can't see. When groupId IS
   * set, a portfolio-less plan still can never surface in that portfolio's
   * rows, so the candidate set is unchanged. Reuses
   * ResourcePlanningService.canExposePlan -- the exact same per-plan check
   * getPortfolioSummary already applies -- in 5-wide concurrent chunks
   * (mirrors getPortfolioSummary's chunking). An error checking one plan
   * excludes that plan rather than failing the whole report -- the same
   * exclusion getPortfolioSummary applies, but note the report response has
   * no skipped-plan counter, so the exclusion is only visible in the log.
   */
  private async computeAccessiblePlanIds(
    organizationId: string,
    userId: string,
    plans: Array<{ id: string; space_id?: string }>,
    portfolioPlans: Array<{ portfolio_id: string; plan_id: string }>,
    groupId: string | undefined,
  ): Promise<Set<string>> {
    const spaceByPlanId = new Map(
      plans.map((plan) => [plan.id, plan.space_id]),
    );
    const linkedPlanIds = new Set(portfolioPlans.map((item) => item.plan_id));
    const portfolioLessPlanIds = groupId
      ? []
      : plans
          .map((plan) => plan.id)
          .filter((id) => !linkedPlanIds.has(id) && spaceByPlanId.has(id));
    const candidateIds = [
      ...new Set([
        ...portfolioPlans
          .filter((item) => !groupId || item.portfolio_id === groupId)
          .map((item) => item.plan_id)
          .filter((id) => spaceByPlanId.has(id)),
        ...portfolioLessPlanIds,
      ]),
    ];

    const accessible = new Set<string>();
    for (let index = 0; index < candidateIds.length; index += 5) {
      const chunk = candidateIds.slice(index, index + 5);
      const results = await Promise.all(
        chunk.map(async (planId) => {
          const spaceId = spaceByPlanId.get(planId);
          if (!spaceId) return null;
          try {
            const canAccess = await this.resourcePlanningService.canExposePlan(
              planId,
              organizationId,
              userId,
              spaceId,
            );
            return canAccess ? planId : null;
          } catch (error) {
            // Excluded like a denial, but a real failure here is invisible in
            // the response -- log it so a transient outage isn't read as "no data".
            this.logger.warn(
              `computeAccessiblePlanIds: excluding plan ${planId} in organization ${organizationId} after access-check error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return null;
          }
        }),
      );
      for (const id of results) {
        if (id) accessible.add(id);
      }
    }
    return accessible;
  }

  private async fetchByIds<T>(
    label: string,
    table: string,
    select: string,
    idColumn: string,
    ids: string[],
  ): Promise<T[]> {
    if (ids.length === 0) return [];
    const result: T[] = [];
    for (let index = 0; index < ids.length; index += ID_BATCH_SIZE) {
      const batch = ids.slice(index, index + ID_BATCH_SIZE);
      const rows = await this.fetchPaged<T>(
        label,
        async (from, to) =>
          await (this.client
            .from(table)
            .select(select)
            .in(idColumn, batch)
            .range(from, to) as unknown as PromiseLike<QueryResult<T>>),
      );
      result.push(...rows);
      if (result.length > MAX_SOURCE_ROWS) {
        throw new BadRequestException(
          `${label} exceed the ${MAX_SOURCE_ROWS.toLocaleString()} row reporting limit`,
        );
      }
    }
    return result;
  }

  private async fetchPaged<T>(
    label: string,
    load: (from: number, to: number) => PromiseLike<QueryResult<T>>,
  ): Promise<T[]> {
    const result: T[] = [];
    for (let from = 0; from < MAX_SOURCE_ROWS; from += PAGE_SIZE) {
      const response = await load(from, from + PAGE_SIZE - 1);
      this.assertQuerySucceeded(label, response.error);
      const page = response.data ?? [];
      result.push(...page);
      if (page.length < PAGE_SIZE) return result;
    }
    const overflow = await load(MAX_SOURCE_ROWS, MAX_SOURCE_ROWS);
    this.assertQuerySucceeded(label, overflow.error);
    if ((overflow.data?.length ?? 0) === 0) return result;
    throw new BadRequestException(
      `${label} exceed the ${MAX_SOURCE_ROWS.toLocaleString()} row reporting limit`,
    );
  }

  private assertQuerySucceeded(label: string, error: QueryError | null): void {
    if (error) {
      throw new InternalServerErrorException(
        `Unable to load ${label}: ${error.message}`,
      );
    }
  }
}

function normalizeCapacity(
  item: ResourcePlanningReportDataset['capacities'][number],
): ResourcePlanningReportDataset['capacities'][number] {
  return {
    ...item,
    weekly_capacity_hours: numeric(item.weekly_capacity_hours),
    cost_rate: nullableNumeric(item.cost_rate),
  };
}

function normalizeCapacityPeriod(
  item: ResourcePlanningReportDataset['capacityPeriods'][number],
): ResourcePlanningReportDataset['capacityPeriods'][number] {
  return {
    ...item,
    weekly_capacity_hours: numeric(item.weekly_capacity_hours),
    cost_rate: nullableNumeric(item.cost_rate),
  };
}

function numeric(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function nullableNumeric(value: unknown): number | null {
  return value === null || value === undefined ? null : numeric(value);
}
