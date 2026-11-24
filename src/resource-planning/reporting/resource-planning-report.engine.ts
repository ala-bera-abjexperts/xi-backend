import { BadRequestException } from '@nestjs/common';
import type { WorkingCalendarContext } from '../calendar/working-calendar.engine';
import type { ResourcePlanningReportQueryDto } from './dto/resource-planning-report-query.dto';
import type {
  NormalizedResourcePlanningReportQuery,
  ResourcePlanningReport,
  ResourcePlanningReportCapacity,
  ResourcePlanningReportCapacityPeriod,
  ResourcePlanningReportDataset,
  ResourcePlanningReportGroup,
  ResourcePlanningReportRow,
  ResourcePlanningReportTotal,
} from './resource-planning-report.types';

/**
 * Converts a weekly figure (capacity or planned hours) into that single day's
 * contribution. With no calendar for this user (undefined/null — the opt-in
 * legacy signal), every day contributes weeklyValue/7 unconditionally, exactly
 * as before Resource Planning 2.0. With a calendar, a non-working day (weekend
 * per the scheme, or a holiday) contributes 0, and a working day contributes
 * weeklyValue/workingDaysPerWeek. workingDaysPerWeek === 0 (an all-zero scheme)
 * is guarded to 0, never a division by zero.
 */
export function perDayFromWeekly(
  weeklyValue: number,
  day: string,
  calendar: WorkingCalendarContext | undefined | null,
): number {
  if (!calendar) return weeklyValue / 7;
  const hoursThatDay = calendar.dayHours.get(day) ?? 0;
  if (hoursThatDay <= 0) return 0;
  if (calendar.workingDaysPerWeek <= 0) return 0;
  return weeklyValue / calendar.workingDaysPerWeek;
}

const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 731;
const UNKNOWN_CURRENCY = 'UNSPECIFIED';
const UNALLOCATED_UNIT = '__unallocated_unit__';
const UNALLOCATED_PORTFOLIO = '__unallocated_portfolio__';

type MutableRow = ResourcePlanningReportRow;

interface GroupDescriptor {
  id: string;
  name: string;
  type: ResourcePlanningReportGroup;
}

export function normalizeResourcePlanningReportQuery(
  query: Partial<ResourcePlanningReportQueryDto>,
  now = new Date(),
): NormalizedResourcePlanningReportQuery {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const defaultFrom = formatDate(new Date(Date.UTC(year, month, 1)));
  const defaultTo = formatDate(new Date(Date.UTC(year, month + 1, 0)));
  const from = dateOnly(query.from ?? defaultFrom);
  const to = dateOnly(query.to ?? defaultTo);
  const days = dayDifference(from, to) + 1;

  if (days <= 0) {
    throw new BadRequestException(
      'Report start date must not be after end date',
    );
  }
  if (days > MAX_RANGE_DAYS) {
    throw new BadRequestException('Report range cannot exceed 2 years');
  }

  return {
    from,
    to,
    bucket: query.bucket ?? 'week',
    group_by: query.group_by ?? 'user',
    group_id: query.group_id,
    portfolio_id: query.portfolio_id,
    space_id: query.space_id,
    include_archived: query.include_archived ?? false,
  };
}

export function buildResourcePlanningReport(
  dataset: ResourcePlanningReportDataset,
  query: NormalizedResourcePlanningReportQuery,
): ResourcePlanningReport {
  const rows = new Map<string, MutableRow>();
  const users = new Map(dataset.users.map((item) => [item.id, item]));
  const units = new Map(dataset.units.map((item) => [item.id, item]));
  const getCapacity = createCapacityResolver(
    dataset.capacities,
    dataset.capacityPeriods,
  );
  const membershipsByUser = indexEffectiveRows(dataset.unitMemberships);
  const plans = new Map(
    dataset.plans
      .filter((item) => query.include_archived || !item.is_archived)
      .map((item) => [item.id, item]),
  );
  const portfolios = new Map(
    dataset.portfolios
      .filter((item) => query.include_archived || !item.is_archived)
      .map((item) => [item.id, item]),
  );
  const planToPortfolios = mapMany(
    dataset.portfolioPlans.filter(
      (item) => plans.has(item.plan_id) && portfolios.has(item.portfolio_id),
    ),
    'plan_id',
    'portfolio_id',
  );
  const taskToPlans = mapMany(
    dataset.planTasks.filter((item) => plans.has(item.plan_id)),
    'task_id',
    'plan_id',
  );
  const exceptions: ResourcePlanningReport['exceptions'] = {
    ambiguous_time_entry_count: 0,
    unallocated_time_entry_count: 0,
    ambiguous_actual_hours: 0,
    unallocated_actual_hours: 0,
    missing_rate_hours: 0,
    undated_allocation_count: 0,
  };

  // Resource Planning 2.0: a user may hold several simultaneous unit
  // memberships (multi-team). Resolves ALL of them for a given day (not just
  // one), each carrying its own allocation_percent share (null = 100%,
  // matching every pre-multi-team membership), and dedupes by resolved id —
  // two of a user's leaf teams can both roll up to the same requested
  // ancestor and must land in that ancestor's row exactly once, with their
  // shares SUMMED, not counted once per contributing leaf team.
  const resolveUnitGroupShares = (
    userId: string,
    day: string,
  ): Array<{ descriptor: GroupDescriptor; sharePercent: number }> => {
    const memberships = effectiveRowsAt(membershipsByUser.get(userId), day);
    if (memberships.length === 0) {
      if (query.group_id) return [];
      return [
        {
          descriptor: {
            id: UNALLOCATED_UNIT,
            name: 'Unallocated',
            type: 'unit',
          },
          sharePercent: 100,
        },
      ];
    }
    const resolved = new Map<
      string,
      { descriptor: GroupDescriptor; sharePercent: number }
    >();
    for (const membership of memberships) {
      const leaf = units.get(membership.unit_id);
      if (!leaf) continue;
      const percent = membership.allocation_percent ?? 100;
      let descriptor: GroupDescriptor | null = null;
      if (query.group_id) {
        if (!isDescendantOrSelf(leaf.id, query.group_id, units)) continue;
        const selected = units.get(query.group_id);
        if (selected) {
          descriptor = { id: selected.id, name: selected.name, type: 'unit' };
        }
      } else {
        descriptor = { id: leaf.id, name: leaf.name, type: 'unit' };
      }
      if (!descriptor) continue;
      const existing = resolved.get(descriptor.id);
      resolved.set(descriptor.id, {
        descriptor,
        sharePercent: (existing?.sharePercent ?? 0) + percent,
      });
    }

    // Nothing constrains a user's simultaneous shares to total 100: the DB
    // exclusion constraint is scoped per unit, so 100% + 100% across two units
    // is legal and does occur in real data. Scale an over-committed set back to
    // 100% so capacity and work each attribute the person exactly once across
    // the report. Under-commitment is deliberately left alone -- it means
    // genuinely unassigned time, which capacity already reports that way.
    const shares = [...resolved.values()];
    const totalPercent = shares.reduce(
      (sum, item) => sum + item.sharePercent,
      0,
    );
    if (totalPercent <= 100) return shares;
    const scale = 100 / totalPercent;
    return shares.map((item) => ({
      descriptor: item.descriptor,
      sharePercent: item.sharePercent * scale,
    }));
  };

  // Returns each target group with the share of this user that belongs to it.
  // Only group_by=unit can split a user (multi-team); every other grouping is
  // whole-user, so it returns 100 -- and `x * (100 / 100)` is exactly `x`, which
  // keeps those modes bit-identical.
  const groupFor = (
    userId: string | null,
    planId: string | null,
    day: string,
  ): Array<{ descriptor: GroupDescriptor; sharePercent: number }> => {
    if (query.group_by === 'user') {
      if (!userId || (query.group_id && query.group_id !== userId)) return [];
      return [
        {
          descriptor: {
            id: userId,
            name: users.get(userId)?.name ?? 'Unknown user',
            type: 'user',
          },
          sharePercent: 100,
        },
      ];
    }
    if (query.group_by === 'unit') {
      if (!userId) return [];
      return resolveUnitGroupShares(userId, day);
    }
    if (!planId || !plans.has(planId)) return [];
    if (query.group_by === 'plan') {
      if (query.group_id && query.group_id !== planId) return [];
      const plan = plans.get(planId)!;
      return [
        {
          descriptor: { id: plan.id, name: plan.name, type: 'plan' },
          sharePercent: 100,
        },
      ];
    }

    // Security: a plan the requesting user cannot individually access must
    // never surface in a portfolio-grouped row, even when they can see the
    // portfolio itself. See ResourcePlanningReportDataset.accessiblePlanIds.
    if (dataset.accessiblePlanIds && !dataset.accessiblePlanIds.has(planId)) {
      return [];
    }

    // Fix 2b: a plan with no (known) portfolio link would otherwise vanish
    // from group_by=portfolio entirely, so an "all portfolios" total never
    // reconciles with an all-plans total. Mirrors resolveUnitGroupShares'
    // handling of the analogous unallocated-unit case above.
    const knownPortfolioIds = planToPortfolios.get(planId) ?? [];
    if (knownPortfolioIds.length === 0) {
      if (query.group_id) return [];
      return [
        {
          descriptor: {
            id: UNALLOCATED_PORTFOLIO,
            name: 'Unallocated',
            type: 'portfolio',
          },
          sharePercent: 100,
        },
      ];
    }

    return knownPortfolioIds
      .filter((id) => !query.group_id || query.group_id === id)
      .flatMap((id) => {
        const portfolio = portfolios.get(id);
        return portfolio
          ? [
              {
                descriptor: {
                  id: portfolio.id,
                  name: portfolio.name,
                  type: 'portfolio' as const,
                },
                sharePercent: 100,
              },
            ]
          : [];
      });
  };

  // Group-buckets (same key finalizeRows uses) where at least one contribution
  // had unknown capacity; those must never be flagged over-allocated.
  const unknownCapacityKeys = new Set<string>();
  const noteCapacity = (row: MutableRow, known: boolean): void => {
    if (!known) {
      unknownCapacityKeys.add(
        `${row.bucket_start}|${row.group_type}|${row.group_id}`,
      );
    }
  };

  const rowFor = (
    group: GroupDescriptor,
    day: string,
    currency: string | null,
  ): MutableRow => {
    const bucket = bucketBounds(day, query);
    const normalizedCurrency = normalizeCurrency(currency);
    const key = `${bucket.start}|${group.type}|${group.id}|${normalizedCurrency}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        bucket_start: bucket.start,
        bucket_end: bucket.end,
        group_id: group.id,
        group_name: group.name,
        group_type: group.type,
        currency: normalizedCurrency,
        capacity_hours: 0,
        planned_hours: 0,
        actual_hours: 0,
        utilization_percent: null,
        planned_labor_cost: 0,
        actual_labor_cost: 0,
        planned_non_labor_cost: 0,
        actual_non_labor_cost: 0,
        planned_total_cost: 0,
        actual_total_cost: 0,
        variance_hours: 0,
        variance_cost: 0,
        over_allocated: false,
      };
      rows.set(key, row);
    }
    return row;
  };

  // Capacity is intrinsically a user/unit value. Plan and portfolio capacity is
  // the full capacity of users contributing an allocation or actual entry.
  if (query.group_by === 'user') {
    for (const user of dataset.users) {
      const calendar = dataset.workingCalendars?.get(user.id);
      for (const day of dateRange(query.from, query.to)) {
        const capacity = getCapacity(user.id, day);
        for (const { descriptor: group } of groupFor(user.id, null, day)) {
          const row = rowFor(group, day, capacity.currency);
          row.capacity_hours += perDayFromWeekly(
            capacity.weekly_capacity_hours,
            day,
            calendar,
          );
          noteCapacity(row, capacity.known);
        }
      }
    }
  } else if (query.group_by === 'unit') {
    // Unlike every other grouping, a user's FULL capacity must not be counted
    // once per team they belong to (multi-team, Resource Planning 2.0) —
    // each simultaneous membership's allocation_percent share (null = 100%)
    // determines what portion of that day's capacity lands in that team's
    // row, so a person split 60/40 across two teams still sums to 100% of
    // their real capacity across the report, not 200%.
    for (const user of dataset.users) {
      const calendar = dataset.workingCalendars?.get(user.id);
      for (const day of dateRange(query.from, query.to)) {
        const capacity = getCapacity(user.id, day);
        const dayCapacity = perDayFromWeekly(
          capacity.weekly_capacity_hours,
          day,
          calendar,
        );
        for (const share of resolveUnitGroupShares(user.id, day)) {
          const row = rowFor(share.descriptor, day, capacity.currency);
          row.capacity_hours += dayCapacity * (share.sharePercent / 100);
          noteCapacity(row, capacity.known);
        }
      }
    }
  } else {
    const contributors = new Set<string>();
    const capacityContributions = new Set<string>();
    for (const allocation of dataset.allocations) {
      const plan = plans.get(allocation.plan_id);
      if (plan && allocationOverlapsQuery(allocation, plan, query)) {
        contributors.add(`${allocation.plan_id}|${allocation.user_id}`);
      }
    }
    for (const entry of dataset.timeEntries) {
      const linkedPlans = taskToPlans.get(entry.task_id) ?? [];
      if (linkedPlans.length === 1) {
        contributors.add(`${linkedPlans[0]}|${entry.user_id}`);
      }
    }
    for (const contributor of contributors) {
      const [planId, userId] = contributor.split('|');
      const calendar = dataset.workingCalendars?.get(userId);
      for (const day of dateRange(query.from, query.to)) {
        const capacity = getCapacity(userId, day);
        for (const { descriptor: group } of groupFor(userId, planId, day)) {
          const contributionKey = `${group.type}|${group.id}|${userId}|${day}`;
          if (capacityContributions.has(contributionKey)) continue;
          capacityContributions.add(contributionKey);
          const row = rowFor(group, day, capacity.currency);
          row.capacity_hours += perDayFromWeekly(
            capacity.weekly_capacity_hours,
            day,
            calendar,
          );
          noteCapacity(row, capacity.known);
        }
      }
    }
  }

  for (const allocation of dataset.allocations) {
    const plan = plans.get(allocation.plan_id);
    if (!plan) continue;
    const start = datePart(allocation.start_date ?? plan.start_date);
    const end = datePart(allocation.end_date ?? plan.end_date);
    if (!start || !end || dayDifference(start, end) < 0) {
      exceptions.undated_allocation_count += 1;
      continue;
    }
    const windowDays = dayDifference(start, end) + 1;
    const overlapStart = laterDate(start, query.from);
    const overlapEnd = earlierDate(end, query.to);
    if (dayDifference(overlapStart, overlapEnd) < 0) continue;

    const calendar = dataset.workingCalendars?.get(allocation.user_id);
    for (const day of dateRange(overlapStart, overlapEnd)) {
      const capacity = getCapacity(allocation.user_id, day);
      const plannedHours = plannedHoursForDay(
        allocation,
        capacity,
        windowDays,
        day,
        calendar,
      );
      const derivedCurrency = capacity.currency ?? plan.currency;
      const explicitBudget = allocation.planned_budget > 0;
      const currency = explicitBudget ? plan.currency : derivedCurrency;
      for (const { descriptor: group, sharePercent } of groupFor(
        allocation.user_id,
        plan.id,
        day,
      )) {
        const row = rowFor(group, day, currency);

        // Multi-team: only the person's share of this group's work belongs here.
        // Parenthesised so non-unit groupings multiply by exactly 1.0.
        const share = sharePercent / 100;
        row.planned_hours += plannedHours * share;
        row.planned_labor_cost +=
          (explicitBudget
            ? allocation.planned_budget / windowDays
            : plannedHours * (capacity.cost_rate ?? 0)) * share;
      }
    }
  }

  for (const entry of dataset.timeEntries) {
    const day = datePart(entry.logged_at);
    if (!day || day < query.from || day > query.to) continue;
    const hours = entry.duration_minutes / 60;
    const linkedPlans = taskToPlans.get(entry.task_id) ?? [];
    if (linkedPlans.length === 0) {
      exceptions.unallocated_time_entry_count += 1;
      exceptions.unallocated_actual_hours += hours;
    } else if (linkedPlans.length > 1) {
      exceptions.ambiguous_time_entry_count += 1;
      exceptions.ambiguous_actual_hours += hours;
    }

    const planId = linkedPlans.length === 1 ? linkedPlans[0] : null;
    if (
      (query.group_by === 'plan' || query.group_by === 'portfolio') &&
      !planId
    ) {
      continue;
    }
    const capacity = getCapacity(entry.user_id, day);
    if (capacity.cost_rate === null) exceptions.missing_rate_hours += hours;
    const fallbackCurrency = planId ? plans.get(planId)?.currency : null;
    for (const { descriptor: group, sharePercent } of groupFor(
      entry.user_id,
      planId,
      day,
    )) {
      const row = rowFor(
        group,
        day,
        capacity.currency ?? fallbackCurrency ?? null,
      );

      // Same multi-team share as planned hours above.
      const share = sharePercent / 100;
      row.actual_hours += hours * share;
      row.actual_labor_cost += hours * (capacity.cost_rate ?? 0) * share;
    }
  }

  if (query.group_by === 'plan' || query.group_by === 'portfolio') {
    // Only these two groupings read budget entries, so the counters below stay
    // undefined elsewhere rather than reporting a misleading zero.
    let unallocatedBudgetCount = 0;
    let ambiguousBudgetCount = 0;

    for (const entry of dataset.budgetEntries) {
      const day = datePart(entry.effective_date);
      if (!day || day < query.from || day > query.to) continue;
      const linkedPlans = entry.plan_id
        ? [entry.plan_id]
        : (taskToPlans.get(entry.task_id ?? '') ?? []);

      // Same two failure modes the time-entry loop above already reports. A
      // known plan that is merely filtered out (archived) is an intentional
      // exclusion, so it is deliberately not counted here.
      if (linkedPlans.length === 0) {
        unallocatedBudgetCount += 1;
      } else if (linkedPlans.length > 1) {
        ambiguousBudgetCount += 1;
      }

      if (linkedPlans.length !== 1 || !plans.has(linkedPlans[0])) continue;
      // Not share-scaled: a budget entry belongs to a plan, not to a person.
      for (const { descriptor: group } of groupFor(null, linkedPlans[0], day)) {
        const row = rowFor(group, day, entry.currency);
        if (entry.entry_type === 'planned') {
          row.planned_non_labor_cost += entry.amount;
        } else {
          row.actual_non_labor_cost += entry.amount;
        }
      }
    }

    exceptions.unallocated_budget_entry_count = unallocatedBudgetCount;
    exceptions.ambiguous_budget_entry_count = ambiguousBudgetCount;
  }

  const resultRows = [...rows.values()];
  finalizeRows(resultRows, unknownCapacityKeys);
  const totals =
    query.group_by === 'portfolio'
      ? buildPortfolioTotals(
          dataset,
          query,
          resultRows,
          plans,
          portfolios,
          taskToPlans,
          getCapacity,
        )
      : buildTotals(resultRows);

  return {
    range: {
      from: query.from,
      to: query.to,
      bucket: query.bucket,
      group_by: query.group_by,
    },
    rows: resultRows.sort(compareRows),
    totals_by_currency: totals,
    exceptions: roundObject(exceptions),
    // Fix 2c: undefined ("not applicable") for every other grouping mode.
    ...(query.group_by === 'portfolio'
      ? {
          restricted_plan_count: countRestrictedPortfolioPlans(
            dataset,
            query,
            plans,
            portfolios,
          ),
        }
      : {}),
  };
}

function buildPortfolioTotals(
  dataset: ResourcePlanningReportDataset,
  query: NormalizedResourcePlanningReportQuery,
  portfolioRows: ResourcePlanningReportRow[],
  plans: Map<string, ResourcePlanningReportDataset['plans'][number]>,
  portfolios: Map<string, ResourcePlanningReportDataset['portfolios'][number]>,
  taskToPlans: Map<string, string[]>,
  getCapacity: (userId: string, day: string) => ResourcePlanningReportCapacity,
): ResourcePlanningReportTotal[] {
  const relevantPlanIds = new Set(
    [...eligiblePortfolioPlanIds(dataset, query, plans, portfolios)].filter(
      // Security: same per-plan access restriction as groupFor's portfolio
      // branch above -- keeps totals consistent with rows.
      (id) => !dataset.accessiblePlanIds || dataset.accessiblePlanIds.has(id),
    ),
  );
  if (relevantPlanIds.size === 0) return [];

  // Plan grouping provides a canonical, non-fanned-out ledger for work/cost.
  const planReport = buildResourcePlanningReport(dataset, {
    ...query,
    group_by: 'plan',
    group_id: undefined,
  });
  const totals = buildTotals(
    planReport.rows.filter((row) => relevantPlanIds.has(row.group_id)),
  );
  const totalsByCurrency = new Map(
    totals.map((item) => [item.currency, { ...item, capacity_hours: 0 }]),
  );

  // Capacity is a resource property: count each contributing user once even
  // when that person works on multiple plans within the selected portfolios.
  const contributorIds = new Set<string>();
  for (const allocation of dataset.allocations) {
    const plan = plans.get(allocation.plan_id);
    if (
      plan &&
      relevantPlanIds.has(plan.id) &&
      allocationOverlapsQuery(allocation, plan, query)
    ) {
      contributorIds.add(allocation.user_id);
    }
  }
  for (const entry of dataset.timeEntries) {
    const linkedPlans = taskToPlans.get(entry.task_id) ?? [];
    if (linkedPlans.length === 1 && relevantPlanIds.has(linkedPlans[0])) {
      contributorIds.add(entry.user_id);
    }
  }
  for (const userId of contributorIds) {
    const calendar = dataset.workingCalendars?.get(userId);
    for (const day of dateRange(query.from, query.to)) {
      const capacity = getCapacity(userId, day);
      const currency = normalizeCurrency(capacity.currency);
      const total = totalsByCurrency.get(currency) ?? emptyTotal(currency);
      total.capacity_hours += perDayFromWeekly(
        capacity.weekly_capacity_hours,
        day,
        calendar,
      );
      totalsByCurrency.set(currency, total);
    }
  }

  const anyOverAllocated = portfolioRows.some((row) => row.over_allocated);
  for (const total of totalsByCurrency.values()) {
    total.utilization_percent =
      total.capacity_hours > 0
        ? (total.planned_hours / total.capacity_hours) * 100
        : null;
    total.over_allocated = anyOverAllocated;
    roundRow(total);
  }
  return [...totalsByCurrency.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );
}

/**
 * Plan ids eligible for group_by=portfolio's selected portfolio(s) (or every
 * portfolio, plus portfolio-less plans, when no group_id is given) -- before
 * any per-plan access restriction. Shared by buildPortfolioTotals (which
 * layers the accessiblePlanIds filter on top) and restricted_plan_count
 * (Fix 2c, which counts what that filter removes from this same set).
 */
function eligiblePortfolioPlanIds(
  dataset: ResourcePlanningReportDataset,
  query: NormalizedResourcePlanningReportQuery,
  plans: Map<string, ResourcePlanningReportDataset['plans'][number]>,
  portfolios: Map<string, ResourcePlanningReportDataset['portfolios'][number]>,
): Set<string> {
  const eligiblePortfolioIds = new Set(
    [...portfolios.keys()].filter(
      (id) => !query.group_id || id === query.group_id,
    ),
  );
  const relevantPlanIds = new Set(
    dataset.portfolioPlans
      .filter(
        (item) =>
          eligiblePortfolioIds.has(item.portfolio_id) &&
          plans.has(item.plan_id),
      )
      .map((item) => item.plan_id),
  );
  // Fix 2b: a plan with no portfolio link at all belongs in the Unallocated
  // bucket, but only for the "all portfolios" view -- a specific portfolio's
  // report must not gain plans that don't belong to it.
  if (!query.group_id) {
    const plansWithPortfolioLinks = new Set(
      dataset.portfolioPlans.map((item) => item.plan_id),
    );
    for (const planId of plans.keys()) {
      if (!plansWithPortfolioLinks.has(planId)) relevantPlanIds.add(planId);
    }
  }
  return relevantPlanIds;
}

/**
 * Fix 2c: how many portfolio-eligible plans were dropped from this report
 * purely because the requesting user can't access them (accessiblePlanIds),
 * as opposed to archived-plan exclusions, which are intentional and silent
 * by design and must not be counted here.
 */
function countRestrictedPortfolioPlans(
  dataset: ResourcePlanningReportDataset,
  query: NormalizedResourcePlanningReportQuery,
  plans: Map<string, ResourcePlanningReportDataset['plans'][number]>,
  portfolios: Map<string, ResourcePlanningReportDataset['portfolios'][number]>,
): number {
  if (!dataset.accessiblePlanIds) return 0;
  let restricted = 0;
  for (const planId of eligiblePortfolioPlanIds(
    dataset,
    query,
    plans,
    portfolios,
  )) {
    if (!dataset.accessiblePlanIds.has(planId)) restricted += 1;
  }
  return restricted;
}

function allocationOverlapsQuery(
  allocation: ResourcePlanningReportDataset['allocations'][number],
  plan: ResourcePlanningReportDataset['plans'][number],
  query: NormalizedResourcePlanningReportQuery,
): boolean {
  const start = datePart(allocation.start_date ?? plan.start_date);
  const end = datePart(allocation.end_date ?? plan.end_date);
  return Boolean(start && end && start <= query.to && end >= query.from);
}

function plannedHoursForDay(
  allocation: ResourcePlanningReportDataset['allocations'][number],
  capacity: ResourcePlanningReportCapacity,
  windowDays: number,
  day: string,
  calendar: WorkingCalendarContext | undefined | null,
): number {
  if (allocation.allocation_mode === 'hours_per_week') {
    return perDayFromWeekly(allocation.weekly_hours ?? 0, day, calendar);
  }
  if (allocation.allocation_mode === 'capacity_percent') {
    return (
      perDayFromWeekly(capacity.weekly_capacity_hours, day, calendar) *
      ((allocation.capacity_percent ?? 0) / 100)
    );
  }
  return allocation.planned_hours / windowDays;
}

function finalizeRows(
  rows: MutableRow[],
  unknownCapacityKeys: ReadonlySet<string> = new Set(),
): void {
  const groupBuckets = new Map<string, { capacity: number; planned: number }>();
  for (const row of rows) {
    const key = `${row.bucket_start}|${row.group_type}|${row.group_id}`;
    const value = groupBuckets.get(key) ?? { capacity: 0, planned: 0 };
    value.capacity += row.capacity_hours;
    value.planned += row.planned_hours;
    groupBuckets.set(key, value);
  }
  for (const row of rows) {
    const key = `${row.bucket_start}|${row.group_type}|${row.group_id}`;
    const groupBucket = groupBuckets.get(key)!;
    row.planned_total_cost =
      row.planned_labor_cost + row.planned_non_labor_cost;
    row.actual_total_cost = row.actual_labor_cost + row.actual_non_labor_cost;
    row.variance_hours = row.actual_hours - row.planned_hours;
    row.variance_cost = row.actual_total_cost - row.planned_total_cost;
    row.utilization_percent =
      groupBucket.capacity > 0
        ? (groupBucket.planned / groupBucket.capacity) * 100
        : null;
    // Unknown capacity never flags over-allocation; a configured 0 still does.
    row.over_allocated =
      !unknownCapacityKeys.has(key) &&
      groupBucket.planned > groupBucket.capacity;
    roundRow(row);
  }
}

function buildTotals(
  rows: ResourcePlanningReportRow[],
): ResourcePlanningReportTotal[] {
  const totals = new Map<string, ResourcePlanningReportTotal>();
  for (const row of rows) {
    const total = totals.get(row.currency) ?? emptyTotal(row.currency);
    for (const field of [
      'capacity_hours',
      'planned_hours',
      'actual_hours',
      'planned_labor_cost',
      'actual_labor_cost',
      'planned_non_labor_cost',
      'actual_non_labor_cost',
      'planned_total_cost',
      'actual_total_cost',
      'variance_hours',
      'variance_cost',
    ] as const) {
      total[field] += row[field];
    }
    total.over_allocated ||= row.over_allocated;
    totals.set(row.currency, total);
  }
  for (const total of totals.values()) {
    total.utilization_percent =
      total.capacity_hours > 0
        ? (total.planned_hours / total.capacity_hours) * 100
        : null;
    roundRow(total);
  }
  return [...totals.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency),
  );
}

function emptyTotal(currency: string): ResourcePlanningReportTotal {
  return {
    currency,
    capacity_hours: 0,
    planned_hours: 0,
    actual_hours: 0,
    utilization_percent: null,
    planned_labor_cost: 0,
    actual_labor_cost: 0,
    planned_non_labor_cost: 0,
    actual_non_labor_cost: 0,
    planned_total_cost: 0,
    actual_total_cost: 0,
    variance_hours: 0,
    variance_cost: 0,
    over_allocated: false,
  };
}

function roundRow(
  row: ResourcePlanningReportRow | ResourcePlanningReportTotal,
): void {
  for (const key of Object.keys(row)) {
    const field = key as keyof typeof row;
    const value = row[field];
    if (typeof value === 'number') {
      (row as unknown as Record<string, unknown>)[key] = round(value);
    }
  }
}

function roundObject<T extends Record<string, number>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, round(item)]),
  ) as T;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function mapMany<
  T extends Record<K | V, string>,
  K extends keyof T,
  V extends keyof T,
>(rows: T[], keyField: K, valueField: V): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const key = row[keyField];
    const values = result.get(key) ?? [];
    if (!values.includes(row[valueField])) values.push(row[valueField]);
    result.set(key, values);
  }
  return result;
}

function isDescendantOrSelf(
  unitId: string,
  ancestorId: string,
  units: Map<string, ResourcePlanningReportDataset['units'][number]>,
): boolean {
  const visited = new Set<string>();
  let current: string | null = unitId;
  while (current && !visited.has(current)) {
    if (current === ancestorId) return true;
    visited.add(current);
    current = units.get(current)?.parent_id ?? null;
  }
  return false;
}

function bucketBounds(
  day: string,
  query: NormalizedResourcePlanningReportQuery,
): { start: string; end: string } {
  const value = parseDate(day);
  let start: Date;
  let end: Date;
  if (query.bucket === 'day') {
    start = value;
    end = value;
  } else if (query.bucket === 'month') {
    start = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
    end = new Date(
      Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0),
    );
  } else {
    const mondayOffset = (value.getUTCDay() + 6) % 7;
    start = new Date(value.getTime() - mondayOffset * DAY_MS);
    end = new Date(start.getTime() + 6 * DAY_MS);
  }
  return {
    start: laterDate(formatDate(start), query.from),
    end: earlierDate(formatDate(end), query.to),
  };
}

export function dateRange(from: string, to: string): string[] {
  const result: string[] = [];
  for (
    let cursor = parseDate(from).getTime(), end = parseDate(to).getTime();
    cursor <= end;
    cursor += DAY_MS
  ) {
    result.push(formatDate(new Date(cursor)));
  }
  return result;
}

/**
 * A user's effective capacity on a day: each field from their active capacity
 * period covering that day, else from their active default capacity (the last
 * active one wins). `known` distinguishes a configured 0 from no capacity
 * record at all. Both report 0 hours, but only a configured 0 may flag
 * over-allocation -- see the invariant on buildWorkingDayHours in
 * calendar/working-calendar.engine.ts. Exported so budget usage costs time
 * exactly like this report (task-actual-cost.ts).
 */
export function createCapacityResolver(
  capacities: ResourcePlanningReportCapacity[],
  capacityPeriods: ResourcePlanningReportCapacityPeriod[],
): (
  userId: string,
  day: string,
) => ResourcePlanningReportCapacity & { known: boolean } {
  const capacitiesByUser = new Map<string, ResourcePlanningReportCapacity>();
  for (const capacity of capacities) {
    if (capacity.is_active) capacitiesByUser.set(capacity.user_id, capacity);
  }
  const capacityPeriodsByUser = indexEffectiveRows(
    capacityPeriods.filter((item) => item.is_active),
  );
  return (userId, day) => {
    const period = effectiveRowAt(capacityPeriodsByUser.get(userId), day);
    const fallback = capacitiesByUser.get(userId);
    return {
      user_id: userId,
      weekly_capacity_hours:
        period?.weekly_capacity_hours ?? fallback?.weekly_capacity_hours ?? 0,
      cost_rate: period?.cost_rate ?? fallback?.cost_rate ?? null,
      currency: period?.currency ?? fallback?.currency ?? null,
      is_active: period?.is_active ?? fallback?.is_active ?? false,
      known:
        period?.weekly_capacity_hours != null ||
        fallback?.weekly_capacity_hours != null,
    };
  };
}

/**
 * Groups effective-dated rows by user_id and sorts each user's rows by effective_from, so
 * effectiveRowAt/effectiveRowsAt can binary-search or linear-scan a small per-user slice instead of
 * the whole dataset. Exported for reuse by the schedule endpoint (Resource Planning 2.0, Sub Task 2)
 * -- pure, generic, no dataset coupling; behavior is unchanged for every existing caller here.
 */
export function indexEffectiveRows<
  T extends {
    user_id: string;
    effective_from: string;
    effective_to: string | null;
  },
>(rows: T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const values = result.get(row.user_id) ?? [];
    values.push(row);
    result.set(row.user_id, values);
  }
  for (const values of result.values()) {
    values.sort((left, right) =>
      left.effective_from.localeCompare(right.effective_from),
    );
  }
  return result;
}

/** Exported for reuse by the schedule endpoint -- see indexEffectiveRows. */
export function effectiveRowAt<
  T extends { effective_from: string; effective_to: string | null },
>(rows: T[] | undefined, day: string): T | undefined {
  if (!rows?.length) return undefined;
  let low = 0;
  let high = rows.length - 1;
  let candidate: T | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const row = rows[middle];
    if (dateOnly(row.effective_from) <= day) {
      candidate = row;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate &&
    (!candidate.effective_to || dateOnly(candidate.effective_to) >= day)
    ? candidate
    : undefined;
}

/**
 * Plural counterpart to effectiveRowAt, for tables where a user can have more
 * than one simultaneously-effective row on a given day — currently only unit
 * memberships (Resource Planning 2.0 multi-team). `rows` here is always the
 * small, already-indexed per-user array produced by indexEffectiveRows (at
 * most a handful of entries — how many teams one person can realistically be
 * in at once), never the raw dataset array, so a linear scan is correct and
 * cheap; it is not the per-day-over-the-whole-dataset scan the indexed lookups
 * exist to avoid.
 *
 * Exported for reuse by the schedule endpoint -- see indexEffectiveRows.
 */
export function effectiveRowsAt<
  T extends { effective_from: string; effective_to: string | null },
>(rows: T[] | undefined, day: string): T[] {
  if (!rows?.length) return [];
  return rows.filter(
    (row) =>
      dateOnly(row.effective_from) <= day &&
      (!row.effective_to || dateOnly(row.effective_to) >= day),
  );
}

/** Exported for task-actual-cost.ts, which must read days exactly like this report. */
export function datePart(value: string | null | undefined): string | null {
  return value ? dateOnly(value) : null;
}

function dateOnly(value: string): string {
  const result = value.slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    Number.isNaN(parseDate(result).getTime()) ||
    formatDate(parseDate(result)) !== result
  ) {
    throw new BadRequestException(`Invalid report date: ${value}`);
  }
  return result;
}

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dayDifference(from: string, to: string): number {
  return Math.floor(
    (parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS,
  );
}

function laterDate(left: string, right: string): string {
  return left > right ? left : right;
}

function earlierDate(left: string, right: string): string {
  return left < right ? left : right;
}

/**
 * Missing currency becomes UNSPECIFIED because it is part of a row/total key and
 * must be a groupable string. Deliberately unlike getPortfolioSummary, which
 * keeps null (its budget_by_currency entries are not keys, and the frontend
 * renders its own label off `currency === null`). Do not reconcile the two
 * endpoints by comparing currency strings -- null and UNSPECIFIED mean the same.
 */
export function normalizeCurrency(value: string | null): string {
  const normalized = value?.trim().toUpperCase();
  return normalized || UNKNOWN_CURRENCY;
}

function compareRows(
  left: ResourcePlanningReportRow,
  right: ResourcePlanningReportRow,
): number {
  return (
    left.bucket_start.localeCompare(right.bucket_start) ||
    left.group_name.localeCompare(right.group_name) ||
    left.currency.localeCompare(right.currency)
  );
}
