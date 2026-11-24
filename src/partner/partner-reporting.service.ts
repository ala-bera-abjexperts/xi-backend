/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- dynamically-typed Supabase rows via the generic partner repository */
/**
 * @fileoverview Sub-ticket 5 - partner reporting. Monthly kickback (actual +
 * projected) from the ledger, a forward prognosis over the strictly-future ledger
 * months, plus an overview: customer counts, an amortized MRR over active licenses,
 * and long-term licenses expiring within three months. All read-only and
 * code-scoped to the caller's partner org / partner_id.
 * @module src/partner/partner-reporting.service
 */

import { Injectable } from '@nestjs/common';
import { PartnerRepository } from './partner.repository';

/**
 * Licences that are RENEWING: the live statuses minus `suspended` (a suspended
 * licence is not up for renewal). Deliberately a subset of the shared
 * LIVE_LICENSE_STATUSES; mirrors RENEWING_STATUSES in the frontend renewal list.
 */
const LIVE_LICENSE_STATUSES = ['active', 'trialing', 'past_due'];

/**
 * Renewal horizon in calendar days (XE-T733). Matches the partner's renewal list
 * (90 / 60 / 30-day windows), so the Home tile, Reporting and the list agree.
 */
const RENEWAL_HORIZON_DAYS = 90;
const FORECAST_HORIZON_MONTHS = 12;

/** First day of `date`'s month, in UTC - the ledger's period_month grain. */
function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** `YYYY-MM-01`, matching how Postgres renders the period_month date column. */
function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Add calendar months, clamping the day to the target month's length so that
 * e.g. Jan 31 + 1 month is Feb 28 rather than JS's default Mar 3 overflow.
 */
function addMonths(date: Date, months: number): Date {
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();

  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));

  return target;
}

/**
 * Inclusive count of calendar months a term spans - 2026-08-01..2027-07-31 is 12.
 * Calendar months (not an average-days divisor) so this matches the per-month
 * ledger rows partner_kickback_monthly_split() writes.
 */
function monthsInclusive(start: Date, end: Date): number {
  const months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth()) +
    1;

  return Math.max(1, months);
}

@Injectable()
export class PartnerReportingService {
  constructor(private readonly repo: PartnerRepository) {}

  /**
   * Kickback grouped by month and split by status, plus a real forward prognosis.
   *
   * `forecast_*` is deliberately NOT "everything still marked projected": the cron
   * flips each month to 'accrued' as it begins, but a month that has started is
   * earned, not forecast. The forecast is therefore the strictly-future projected
   * months only, so it never double-counts against earned_total_cents.
   */
  async kickback(organizationId: string) {
    const entries = await this.repo.findMany('partner_kickback_entries', {
      organization_id: organizationId,
    });

    const byMonth = new Map<
      string,
      {
        period_month: string;
        projected: number;
        accrued: number;
        paid: number;
        total: number;
      }
    >();

    const currentMonth = monthStart(new Date());
    const currentMonthKey = monthKey(currentMonth);

    const forecastByMonth = new Map<string, number>();

    let projectedTotal = 0;
    let earnedTotal = 0;
    let forecastTotal = 0;

    for (const entry of entries) {
      // Commission of a licence cancelled early is voided, not deleted: it was
      // never earned and must not count anywhere.
      if (entry.status === 'void') continue;

      const month = String(entry.period_month);
      const bucket = byMonth.get(month) ?? {
        period_month: month,
        projected: 0,
        accrued: 0,
        paid: 0,
        total: 0,
      };
      const amount = Number(entry.amount_cents ?? 0);

      bucket[entry.status as 'projected' | 'accrued' | 'paid'] += amount;
      bucket.total += amount;
      byMonth.set(month, bucket);

      if (entry.status === 'projected') {
        projectedTotal += amount;

        // Lexicographic compare is safe: both sides are zero-padded YYYY-MM-01.
        if (month > currentMonthKey) {
          forecastTotal += amount;
          forecastByMonth.set(
            month,
            (forecastByMonth.get(month) ?? 0) + amount,
          );
        }
      } else {
        earnedTotal += amount;
      }
    }

    // Dense series: every one of the next 12 months is present (zero-filled) so the
    // chart draws a continuous timeline instead of collapsing empty months.
    const forecastNext12 = Array.from(
      { length: FORECAST_HORIZON_MONTHS },
      (_, i) => {
        const key = monthKey(addMonths(currentMonth, i + 1));

        return {
          period_month: key,
          amount_cents: forecastByMonth.get(key) ?? 0,
        };
      },
    );

    return {
      currency: entries[0]?.currency ?? 'EUR',
      months: [...byMonth.values()].sort((a, b) =>
        a.period_month.localeCompare(b.period_month),
      ),
      projected_total_cents: projectedTotal,
      earned_total_cents: earnedTotal,
      forecast_total_cents: forecastTotal,
      forecast_next_12: forecastNext12,
    };
  }

  /** Customer counts, amortized MRR, and long-term licenses expiring within 3 months. */
  /**
   * Sales figures a partner needs to answer "what needs me today?".
   *
   * Kept in the overview rather than derived on the client because the lists are
   * paginated — summing one page of quotes would silently under-report the
   * pipeline the moment a partner has more than a page of them.
   */
  private async salesAttention(organizationId: string) {
    const [quotes, invoices] = await Promise.all([
      this.repo.client
        .from('partner_quotes')
        .select('status,total_cents')
        .eq('organization_id', organizationId)
        .eq('is_deleted', false),
      this.repo.client
        .from('partner_invoices')
        .select('status,total_cents,due_date')
        .eq('organization_id', organizationId)
        .eq('is_deleted', false),
    ]);

    const quoteRows = (quotes.data ?? []) as any[];
    const invoiceRows = (invoices.data ?? []) as any[];
    const sum = (rows: any[]) =>
      rows.reduce((total, r) => total + Number(r.total_cents ?? 0), 0);

    // Open pipeline: everything still in play. `converted` is already revenue and
    // `rejected`/`expired` are dead, so neither belongs in a forecast.
    const open = quoteRows.filter((q) =>
      ['draft', 'sent', 'accepted'].includes(String(q.status)),
    );
    const awaiting = quoteRows.filter((q) => q.status === 'sent');

    // Overdue = flagged overdue, OR issued with a due date already past. The status
    // column only turns over when something writes it, so a date check is what makes
    // this honest on the day it lapses.
    const today = new Date().toISOString().slice(0, 10);
    const overdue = invoiceRows.filter(
      (i) =>
        i.status === 'overdue' ||
        (i.status === 'issued' && i.due_date && String(i.due_date) < today),
    );

    return {
      pipeline_open_count: open.length,
      pipeline_open_cents: sum(open),
      quotes_awaiting_response: awaiting.length,
      invoices_overdue_count: overdue.length,
      invoices_overdue_cents: sum(overdue),
    };
  }

  async overview(organizationId: string) {
    const customers = await this.repo.findMany(
      'partner_customers',
      { organization_id: organizationId, is_deleted: false },
      'id,status',
    );

    const { data: licenses } = await this.repo.client
      .from('organization_licenses')
      .select(
        // label: the Reporting renewal table names each licence (it showed "-").
        'id,label,status,starts_at,ends_at,current_period_start,current_period_end,source_invoice_id,renewal_declined_at,metadata',
      )
      .eq('partner_id', organizationId);

    const now = new Date();
    const nowMs = now.getTime();

    const notExpired = (l: any) =>
      !l.ends_at || new Date(l.ends_at).getTime() >= nowMs;

    const activeLicenses = (licenses ?? []).filter(
      (l: any) => l.status === 'active' && notExpired(l),
    );

    // Renewal warnings cover trialing/past_due too - those expire just as hard as
    // active ones, and silently dropping them is how a renewal gets missed.
    const liveLicenses = (licenses ?? []).filter(
      (l: any) => LIVE_LICENSE_STATUSES.includes(l.status) && notExpired(l),
    );

    // Every renewing licence that ends from now through the end of day +90 (UTC),
    // whatever its term length - the same rule as the renewal list (XE-T733). The
    // earlier ">12 months only" rule hid short contracts that also need renewing.
    const horizonMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + RENEWAL_HORIZON_DAYS + 1,
    );

    // Already renewed (a renewal licence points back at it) or marked "will
    // not renew" by the partner: no longer a renewal to chase.
    const renewedIds = new Set(
      (licenses ?? [])
        .map((l: any) => l.metadata?.renews_license_id as string | undefined)
        .filter(Boolean),
    );

    const expiringSoon = liveLicenses.filter((l: any) => {
      if (!l.ends_at || l.renewal_declined_at || renewedIds.has(l.id)) {
        return false;
      }

      const endMs = new Date(l.ends_at).getTime();

      return endMs >= nowMs && endMs < horizonMs;
    });

    // MRR: amortize each active license's source invoice total over its duration.
    const invoiceIds = activeLicenses
      .map((l: any) => l.source_invoice_id)
      .filter(Boolean);
    let mrrCents = 0;

    if (invoiceIds.length) {
      const { data: invoices } = await this.repo.client
        .from('partner_invoices')
        .select('id,total_cents')
        .in('id', invoiceIds);
      const totalById = new Map(
        (invoices ?? []).map((i: any) => [i.id, Number(i.total_cents ?? 0)]),
      );

      for (const lic of activeLicenses) {
        const total = totalById.get(lic.source_invoice_id) ?? 0;

        // An open-ended license (ends_at IS NULL) has no term to amortize over.
        // Falling back to end=start yielded months=1 and booked the WHOLE invoice
        // as a single month's MRR - so book it over its billing period instead,
        // and exclude it entirely when it has no billing period either.
        const periodStart = new Date(
          lic.ends_at
            ? lic.starts_at
            : (lic.current_period_start ?? lic.starts_at),
        );
        const periodEndRaw = lic.ends_at ?? lic.current_period_end;

        if (!periodEndRaw) continue;

        mrrCents +=
          total / monthsInclusive(periodStart, new Date(periodEndRaw));
      }
    }

    return {
      customers_total: customers.length,
      customers_active: customers.filter((c: any) => c.status === 'active')
        .length,
      licenses_active: activeLicenses.length,
      mrr_cents: Math.round(mrrCents),
      expiring_within_3_months: expiringSoon.length,
      expiring_licenses: expiringSoon,

      // Issued last so the licence/customer queries above keep the call order the
      // existing tests assert against.
      ...(await this.salesAttention(organizationId)),
    };
  }
}
