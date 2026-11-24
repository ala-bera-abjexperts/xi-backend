/**
 * @fileoverview Thin loader around the pure working-calendar engine. Resolves the
 * applicable workload scheme and holiday days for an organization (and optionally a
 * specific user), then delegates the actual day-by-day math to
 * working-calendar.engine.ts.
 *
 * Resolution order (per organization, optionally scoped to a user):
 *   1. The user's own workload/holiday scheme, if assigned AND active.
 *   2. The organization's default scheme, if one is active.
 *   3. Neither exists -> resolveDayHoursMap returns null, the opt-in legacy signal.
 *
 * An inactive scheme is treated as not configured at every step (D5): the queries
 * below always filter is_active = true, so a user pinned to an archived scheme
 * falls straight through to the org default rather than resolving to a stale
 * calendar.
 * @module src/resource-planning/calendar/working-calendar.service
 */

import { Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  buildDayHoursMap,
  workingDaysPerWeekOf,
  type HolidayDay,
  type WorkingCalendarContext,
  type WorkloadSchemeHours,
} from './working-calendar.engine';

const WORKLOAD_SCHEME_COLUMNS =
  'monday_hours,tuesday_hours,wednesday_hours,thursday_hours,friday_hours,saturday_hours,sunday_hours';

@Injectable()
export class WorkingCalendarService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Cheap, org-wide fast path: true only if the org has EVER configured an
   * active workload scheme. Every caller should check this once per
   * organization before resolving per-user calendars — with no scheme
   * configured anywhere (today's universal case, since this is a brand-new
   * feature), it avoids several extra queries per user for a result that will
   * always come back null anyway.
   */
  async hasAnySchemeConfigured(organizationId: string): Promise<boolean> {
    const { data } = await this.client
      .from('workload_schemes')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .limit(1);
    return (data?.length ?? 0) > 0;
  }

  /**
   * Returns the full WorkingCalendarContext (day-hours map + working days per
   * week) for [from, to], or null if no workload scheme applies (legacy
   * signal — callers must fall back to existing /7 math). `userId` is
   * optional: pass null to resolve only the organization default (used for
   * calendar-level figures, e.g. a ticket's Werktage, that are not tied to
   * one specific person).
   */
  async resolveCalendarContext(
    organizationId: string,
    userId: string | null,
    from: string,
    to: string,
  ): Promise<WorkingCalendarContext | null> {
    const scheme = await this.resolveWorkloadScheme(organizationId, userId);
    if (!scheme) return null;
    const holidays = await this.resolveHolidayDays(organizationId, userId);
    const dayHours = buildDayHoursMap(scheme, holidays, from, to);
    if (!dayHours) return null;
    return { dayHours, workingDaysPerWeek: workingDaysPerWeekOf(scheme) };
  }

  private async resolveWorkloadScheme(
    organizationId: string,
    userId: string | null,
  ): Promise<WorkloadSchemeHours | null> {
    if (userId) {
      const personal = await this.loadMemberScheme(
        'workload_scheme_members',
        'workload_schemes',
        organizationId,
        userId,
      );
      if (personal) {
        const { data } = await this.client
          .from('workload_schemes')
          .select(WORKLOAD_SCHEME_COLUMNS)
          .eq('organization_id', organizationId)
          .eq('id', personal)
          .eq('is_active', true)
          .maybeSingle();
        if (data) return data as unknown as WorkloadSchemeHours;
      }
    }

    const { data: defaultScheme } = await this.client
      .from('workload_schemes')
      .select(WORKLOAD_SCHEME_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('is_default', true)
      .eq('is_active', true)
      .maybeSingle();
    return (defaultScheme as unknown as WorkloadSchemeHours) ?? null;
  }

  private async resolveHolidayDays(
    organizationId: string,
    userId: string | null,
  ): Promise<HolidayDay[]> {
    let schemeId: string | null = null;

    if (userId) {
      const personal = await this.loadMemberScheme(
        'holiday_scheme_members',
        'holiday_schemes',
        organizationId,
        userId,
      );
      if (personal) schemeId = personal;
    }

    if (!schemeId) {
      const { data: defaultScheme } = await this.client
        .from('holiday_schemes')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('is_default', true)
        .eq('is_active', true)
        .maybeSingle();
      schemeId = (defaultScheme?.id as string | undefined) ?? null;
    }

    if (!schemeId) return [];

    const { data } = await this.client
      .from('holiday_scheme_days')
      .select('recurrence,month,day,holiday_date,duration_days')
      .eq('organization_id', organizationId)
      .eq('scheme_id', schemeId);
    return (data as unknown as HolidayDay[]) ?? [];
  }

  /**
   * Returns the scheme_id a user is personally assigned to for a given membership
   * table, but ONLY if that scheme is currently active — an assignment pointing at
   * an archived scheme is treated as no assignment at all (D5), so the caller falls
   * through to the organization default.
   */
  private async loadMemberScheme(
    memberTable: 'workload_scheme_members' | 'holiday_scheme_members',
    schemeTable: 'workload_schemes' | 'holiday_schemes',
    organizationId: string,
    userId: string,
  ): Promise<string | null> {
    const { data: member } = await this.client
      .from(memberTable)
      .select('scheme_id')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .maybeSingle();
    const schemeId = member?.scheme_id as string | undefined;
    if (!schemeId) return null;

    const { data: scheme } = await this.client
      .from(schemeTable)
      .select('id')
      .eq('organization_id', organizationId)
      .eq('id', schemeId)
      .eq('is_active', true)
      .maybeSingle();
    return (scheme?.id as string | undefined) ?? null;
  }
}
