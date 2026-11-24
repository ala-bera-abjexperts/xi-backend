/**
 * @fileoverview Unit tests for PartnerReportingService: monthly kickback
 * aggregation (projected vs earned split), the forward prognosis over
 * strictly-future projected months, and the portfolio overview (customers,
 * active licenses, amortized MRR, >12-month licenses expiring within 3 months) -
 * all scoped to the calling partner.
 * @module src/partner/partner-reporting.service.spec
 */

import { PartnerReportingService } from './partner-reporting.service';
import { PartnerRepository } from './partner.repository';

const ORG = 'org-1';

/** Fixed "now" so month arithmetic in the assertions is deterministic. */
const NOW = new Date('2026-07-15T12:00:00.000Z');

function monthKey(offset: number): string {
  const d = new Date(
    Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + offset, 1),
  );

  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function buildChain(results: Array<{ data: unknown; error: unknown }>) {
  const queue = [...results];
  const chain: Record<string, jest.Mock> & {
    then: (r: (v: unknown) => unknown) => Promise<unknown>;
  } = {} as never;
  const self = () => chain;

  chain.select = jest.fn(self);
  chain.eq = jest.fn(self);
  chain.in = jest.fn(self);
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(queue.shift() ?? { data: null, error: null }).then(resolve);

  return chain;
}

function setup(...clientResults: Array<{ data: unknown; error: unknown }>) {
  const chain = buildChain(clientResults);
  const repo = {
    findMany: jest.fn().mockResolvedValue([]),
    client: { from: jest.fn(() => chain) },
  } as unknown as PartnerRepository;
  const service = new PartnerReportingService(repo);

  return { service, repo, chain };
}

describe('PartnerReportingService', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(NOW.getTime());
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe('kickback', () => {
    it('groups entries by month and splits projected vs earned totals', async () => {
      const { service, repo } = setup({ data: null, error: null });
      (repo.findMany as jest.Mock).mockResolvedValue([
        {
          period_month: '2026-07-01',
          status: 'projected',
          amount_cents: 12078,
          currency: 'EUR',
        },
        {
          period_month: '2026-07-01',
          status: 'paid',
          amount_cents: 5000,
          currency: 'EUR',
        },
        {
          period_month: '2026-08-01',
          status: 'accrued',
          amount_cents: 3000,
          currency: 'EUR',
        },
      ]);

      const result = await service.kickback(ORG);

      expect(result.currency).toBe('EUR');
      expect(result.projected_total_cents).toBe(12078);
      expect(result.earned_total_cents).toBe(8000);
      expect(result.months).toHaveLength(2);

      const july = result.months.find((m) => m.period_month === '2026-07-01');

      expect(july).toMatchObject({
        projected: 12078,
        paid: 5000,
        total: 17078,
      });
    });

    it('defaults the currency to EUR when there are no entries', async () => {
      const { service } = setup({ data: null, error: null });

      const result = await service.kickback(ORG);

      expect(result.currency).toBe('EUR');
      expect(result.months).toEqual([]);
      expect(result.projected_total_cents).toBe(0);
      expect(result.forecast_total_cents).toBe(0);
    });

    it('forecasts only STRICTLY FUTURE projected months, not the whole projected ledger', async () => {
      const { service, repo } = setup({ data: null, error: null });
      (repo.findMany as jest.Mock).mockResolvedValue([
        // current month - projected but already begun, so earned-side, not forecast
        {
          period_month: monthKey(0),
          status: 'projected',
          amount_cents: 1000,
          currency: 'EUR',
        },
        // past month still awaiting the accrual cron - must never count as forecast
        {
          period_month: monthKey(-1),
          status: 'projected',
          amount_cents: 500,
          currency: 'EUR',
        },
        {
          period_month: monthKey(1),
          status: 'projected',
          amount_cents: 2000,
          currency: 'EUR',
        },
        {
          period_month: monthKey(3),
          status: 'projected',
          amount_cents: 3000,
          currency: 'EUR',
        },
        // a future month that is already accrued is not a forecast either
        {
          period_month: monthKey(2),
          status: 'accrued',
          amount_cents: 9999,
          currency: 'EUR',
        },
      ]);

      const result = await service.kickback(ORG);

      expect(result.forecast_total_cents).toBe(5000);
      // the old behaviour - SUM(projected) - would have been 6500
      expect(result.projected_total_cents).toBe(6500);
    });

    it('returns a dense, zero-filled 12-month forward series', async () => {
      const { service, repo } = setup({ data: null, error: null });
      (repo.findMany as jest.Mock).mockResolvedValue([
        {
          period_month: monthKey(1),
          status: 'projected',
          amount_cents: 2000,
          currency: 'EUR',
        },
        {
          period_month: monthKey(12),
          status: 'projected',
          amount_cents: 4000,
          currency: 'EUR',
        },
        // month 13 is beyond the horizon and must not appear
        {
          period_month: monthKey(13),
          status: 'projected',
          amount_cents: 7000,
          currency: 'EUR',
        },
      ]);

      const result = await service.kickback(ORG);

      expect(result.forecast_next_12).toHaveLength(12);
      expect(result.forecast_next_12[0]).toEqual({
        period_month: monthKey(1),
        amount_cents: 2000,
      });
      expect(result.forecast_next_12[1]).toEqual({
        period_month: monthKey(2),
        amount_cents: 0,
      });
      expect(result.forecast_next_12[11]).toEqual({
        period_month: monthKey(12),
        amount_cents: 4000,
      });
      expect(result.forecast_next_12.map((m) => m.period_month)).not.toContain(
        monthKey(13),
      );
    });
  });

  describe('overview', () => {
    it('counts customers and active licenses for the partner', async () => {
      const { service, repo } = setup({
        data: [
          {
            id: 'lic-1',
            status: 'active',
            starts_at: '2026-07-01',
            ends_at: null,
            current_period_start: null,
            current_period_end: null,
            source_invoice_id: null,
          },
        ],
        error: null,
      });
      (repo.findMany as jest.Mock).mockResolvedValue([
        { id: 'cust-1', status: 'active' },
        { id: 'cust-2', status: 'prospect' },
      ]);

      const result = await service.overview(ORG);

      expect(result.customers_total).toBe(2);
      expect(result.customers_active).toBe(1);
      expect(result.licenses_active).toBe(1);
      expect(result.mrr_cents).toBe(0);
      expect(result.expiring_within_3_months).toBe(0);
    });

    it('amortizes a fixed-term license over its calendar months', async () => {
      const { service } = setup(
        {
          data: [
            {
              id: 'lic-1',
              status: 'active',
              starts_at: '2026-07-01T00:00:00Z',
              ends_at: '2027-06-30T23:59:59Z',
              current_period_start: null,
              current_period_end: null,
              source_invoice_id: 'inv-1',
            },
          ],
          error: null,
        },
        { data: [{ id: 'inv-1', total_cents: 120000 }], error: null },
      );

      const result = await service.overview(ORG);

      // 12 calendar months, not a 30.437-day divisor
      expect(result.mrr_cents).toBe(10000);
    });

    it('books an open-ended license at its billing period instead of as one month of MRR', async () => {
      const { service } = setup(
        {
          data: [
            {
              id: 'lic-1',
              status: 'active',
              starts_at: '2026-07-01T00:00:00Z',
              ends_at: null,
              current_period_start: '2026-07-01T00:00:00Z',
              current_period_end: '2027-06-30T23:59:59Z',
              source_invoice_id: 'inv-1',
            },
          ],
          error: null,
        },
        { data: [{ id: 'inv-1', total_cents: 120000 }], error: null },
      );

      const result = await service.overview(ORG);

      // the null-ends_at bug booked the ENTIRE 120000 as one month's MRR
      expect(result.mrr_cents).toBe(10000);
    });

    it('excludes an open-ended license with no billing period from MRR', async () => {
      const { service } = setup(
        {
          data: [
            {
              id: 'lic-1',
              status: 'active',
              starts_at: '2026-07-01T00:00:00Z',
              ends_at: null,
              current_period_start: null,
              current_period_end: null,
              source_invoice_id: 'inv-1',
            },
          ],
          error: null,
        },
        { data: [{ id: 'inv-1', total_cents: 120000 }], error: null },
      );

      const result = await service.overview(ORG);

      expect(result.mrr_cents).toBe(0);
    });

    // XE-T733: the same rule as the renewal list - any term length, 90 days.
    it('flags every renewing licence due within 90 days, any term length, incl. trialing/past_due', async () => {
      const { service } = setup({
        data: [
          {
            // 12-month term ending in ~6 weeks -> qualifies (excluded by the old >12-month rule)
            id: 'lic-annual',
            status: 'active',
            starts_at: '2025-09-01T00:00:00Z',
            ends_at: '2026-08-31T23:59:59Z',
            source_invoice_id: null,
          },
          {
            // short trial ending in a month -> qualifies
            id: 'lic-trial',
            status: 'trialing',
            starts_at: '2026-06-15T00:00:00Z',
            ends_at: '2026-08-15T23:59:59Z',
            source_invoice_id: null,
          },
          {
            // ends on day 90 (2026-10-13) -> qualifies
            id: 'lic-day-90',
            status: 'past_due',
            starts_at: '2024-10-14T00:00:00Z',
            ends_at: '2026-10-13T23:59:59Z',
            source_invoice_id: null,
          },
          {
            // ends on day 91 -> outside the horizon
            id: 'lic-day-91',
            status: 'active',
            starts_at: '2025-10-15T00:00:00Z',
            ends_at: '2026-10-14T00:00:01Z',
            source_invoice_id: null,
          },
          {
            // already ended yesterday -> not renewing any more
            id: 'lic-ended',
            status: 'active',
            starts_at: '2025-07-15T00:00:00Z',
            ends_at: '2026-07-14T23:59:59Z',
            source_invoice_id: null,
          },
          {
            // cancelled is not live
            id: 'lic-cancelled',
            status: 'cancelled',
            starts_at: '2024-10-01T00:00:00Z',
            ends_at: '2026-09-30T23:59:59Z',
            source_invoice_id: null,
          },
        ],
        error: null,
      });

      const result = await service.overview(ORG);

      expect(result.expiring_within_3_months).toBe(3);
      expect(
        result.expiring_licenses.map((l: { id: string }) => l.id).sort(),
      ).toEqual(['lic-annual', 'lic-day-90', 'lic-trial']);
      // licenses_active stays strictly status='active' and not yet ended
      expect(result.licenses_active).toBe(2);
    });
  });
});
