import type { ConfigService } from '@nestjs/config';

import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { SiteStudioDomainsCron } from './site-studio-domains.cron';
import type { SiteStudioServingService } from './site-studio-serving.service';
import type { VercelDomainsService } from './vercel-domains.service';
import { claimCronSlot } from '../../common/utils/cron-claim';

// The cross-replica claim has its own spec; here it is granted unless a test says otherwise.
jest.mock('../../common/utils/cron-claim', () => ({
  claimCronSlot: jest.fn(),
}));
beforeEach(() => jest.mocked(claimCronSlot).mockResolvedValue('stamp'));

const ROW = (over: Record<string, unknown> = {}) => ({
  id: 'dom-1',
  domain: 'docs.acme.com',
  ssl_status: 'pending',
  ...over,
});

/**
 * Supabase stub: `from()` returns a fresh thenable chain per call. A chain that
 * saw `.update(...)` resolves as a write (recorded in `updates`); otherwise it
 * resolves the configured select rows.
 */
function makeDb(rows: unknown[]) {
  const updates: Array<{ values: unknown; filters: unknown[][] }> = [];
  const from = jest.fn(() => {
    const c: Record<string, unknown> = {};
    const self = () => c;
    let isUpdate = false;
    let updateValues: unknown;
    const filters: unknown[][] = [];

    c.select = jest.fn(self);
    c.neq = jest.fn(self);
    c.order = jest.fn(self);
    c.limit = jest.fn(self);
    c.eq = jest.fn((col: string, v: unknown) => {
      filters.push([col, v]);

      return c;
    });
    c.in = jest.fn((col: string, v: unknown) => {
      filters.push([col, v]);

      return c;
    });
    c.update = jest.fn((v: unknown) => {
      isUpdate = true;
      updateValues = v;

      return c;
    });
    (c as { then?: unknown }).then = (onF: (v: unknown) => unknown) => {
      if (isUpdate) {
        updates.push({ values: updateValues, filters });

        return Promise.resolve({ error: null }).then(onF);
      }

      return Promise.resolve({ error: null, data: rows }).then(onF);
    };

    return c;
  });

  return { client: { from }, from, updates };
}

function makeCron(opts: {
  rows: unknown[];
  onPrem?: boolean;
  vercelConfigured?: boolean;
  getStatusResults?: unknown[];
  addDomainResult?: unknown;
  /** On-prem serving-probe verdict (default: this edge does serve the domain). */
  served?: boolean;
}) {
  const { client, from, updates } = makeDb(opts.rows);
  const supa = {
    getClient: () => client,
  } as unknown as SupabaseAdminService;

  const getStatus = jest.fn();

  for (const r of opts.getStatusResults ?? []) {
    if (r instanceof Error) getStatus.mockRejectedValueOnce(r);
    else getStatus.mockResolvedValueOnce(r);
  }
  getStatus.mockResolvedValue({
    status: 'pending',
    misconfigured: false,
    verification: [],
    attached: true,
  });

  const vercel = {
    isConfigured: jest.fn().mockReturnValue(opts.vercelConfigured ?? false),
    addDomain: jest
      .fn()
      .mockResolvedValue(
        opts.addDomainResult ?? { ok: true, verification: [] },
      ),
    getStatus,
    removeDomain: jest.fn(),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'onPrem.enabled' ? (opts.onPrem ?? false) : undefined,
    ),
  } as unknown as ConfigService;

  // The on-prem sweep now promotes a domain only when the edge genuinely serves it,
  // instead of blanket-marking every verified row active. `opts.served` picks the verdict.
  const serving = {
    probe: jest.fn().mockImplementation(() =>
      Promise.resolve({
        served: opts.served ?? true,
        reason: (opts.served ?? true) ? 'served' : 'handshake-failed',
        hint: '',
      }),
    ),
    invalidate: jest.fn(),
  };

  return {
    cron: new SiteStudioDomainsCron(
      supa,
      vercel as unknown as VercelDomainsService,
      config,
      serving as unknown as SiteStudioServingService,
    ),
    serving,
    vercel,
    from,
    updates,
  };
}

const STATUS = (over: Record<string, unknown> = {}) => ({
  status: 'pending',
  misconfigured: false,
  verification: [],
  attached: true,
  ...over,
});

describe('SiteStudioDomainsCron.sweepPendingDomains', () => {
  afterEach(() => jest.clearAllMocks());

  it('attaches an unattached verified domain and writes the refreshed status', async () => {
    const { cron, vercel, updates } = makeCron({
      rows: [ROW()],
      vercelConfigured: true,
      getStatusResults: [
        STATUS({ attached: false }), // first read: not on the project
        STATUS({ status: 'active', attached: true }), // after self-heal attach
      ],
    });

    await cron.sweepPendingDomains();

    expect(vercel.addDomain).toHaveBeenCalledWith('docs.acme.com');
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toEqual({ ssl_status: 'active' });
  });

  it('refreshes an attached domain to active without re-adding it', async () => {
    const { cron, vercel, updates } = makeCron({
      rows: [ROW()],
      vercelConfigured: true,
      getStatusResults: [STATUS({ status: 'active', attached: true })],
    });

    await cron.sweepPendingDomains();

    expect(vercel.addDomain).not.toHaveBeenCalled();
    expect(updates[0].values).toEqual({ ssl_status: 'active' });
  });

  it('does nothing on cloud when Vercel is not configured (no queries, no calls)', async () => {
    const { cron, vercel, from } = makeCron({
      rows: [ROW()],
      vercelConfigured: false,
    });

    await cron.sweepPendingDomains();

    expect(from).not.toHaveBeenCalled();
    expect(vercel.getStatus).not.toHaveBeenCalled();
  });

  it('skips the sweep when another replica holds this slot', async () => {
    jest.mocked(claimCronSlot).mockResolvedValue(null);
    const { cron, vercel, from } = makeCron({
      rows: [ROW()],
      vercelConfigured: true,
    });

    await cron.sweepPendingDomains();

    expect(from).not.toHaveBeenCalled();
    expect(vercel.getStatus).not.toHaveBeenCalled();
  });

  it('ON-PREM: bulk-heals the batch to active without any Vercel call', async () => {
    const { cron, vercel, updates } = makeCron({
      rows: [ROW(), ROW({ id: 'dom-2', domain: 'wiki.acme.com' })],
      onPrem: true,
    });

    await cron.sweepPendingDomains();

    expect(updates).toHaveLength(1);
    expect(updates[0].values).toEqual({ ssl_status: 'active' });
    expect(updates[0].filters).toEqual([['id', ['dom-1', 'dom-2']]]);
    expect(vercel.getStatus).not.toHaveBeenCalled();
  });

  it('one failing domain never blocks the rest of the batch', async () => {
    const { cron, vercel, updates } = makeCron({
      rows: [ROW(), ROW({ id: 'dom-2', domain: 'wiki.acme.com' })],
      vercelConfigured: true,
      getStatusResults: [
        new Error('vercel down'), // first row throws
        STATUS({ status: 'active', attached: true }), // second row succeeds
      ],
    });

    await expect(cron.sweepPendingDomains()).resolves.toBeUndefined();

    // Second row still processed and written.
    expect(vercel.getStatus).toHaveBeenCalledTimes(2);
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toEqual({ ssl_status: 'active' });
  });
});
