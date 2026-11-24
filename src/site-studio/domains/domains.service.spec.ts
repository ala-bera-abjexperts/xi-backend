import type { ConfigService } from '@nestjs/config';
import * as dns from 'dns/promises';

import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { DomainsService } from './domains.service';
import type { SiteStudioServingService } from './site-studio-serving.service';
import type { VercelDomainsService } from './vercel-domains.service';

jest.mock('dns/promises');

const resolveTxt = dns.resolveTxt as unknown as jest.Mock;
const ResolverMock = dns.Resolver as unknown as jest.Mock;

const DOMAIN_ROW = {
  id: 'dom-1',
  funnel_id: 'fun-1',
  organization_id: 'org-1',
  domain: 'docs.acme.com',
  verified: false,
  verification_token: 'xi-verify-tok',
  ssl_status: 'pending' as const,
  created_at: 't',
  updated_at: 't',
};

/**
 * Minimal Supabase query-builder stub. Every builder method returns `this`;
 * terminal `maybeSingle`/`single` resolve to the configured row; the builder is
 * also thenable (for the head/count duplicate-check await in addDomain and the
 * awaited list/update chains).
 */
function makeClient(cfg: {
  maybeSingle?: unknown;
  single?: unknown;
  direct?: Record<string, unknown>;
}) {
  const updateArgs: unknown[] = [];
  const insertArgs: unknown[] = [];
  const c: Record<string, unknown> = {};
  const self = () => c;

  c.select = jest.fn(self);
  c.eq = jest.fn(self);
  c.order = jest.fn(self);
  c.insert = jest.fn((v: unknown) => {
    insertArgs.push(v);

    return c;
  });
  c.update = jest.fn((v: unknown) => {
    updateArgs.push(v);

    return c;
  });
  c.delete = jest.fn(self);
  // Clone the configured rows: the service attaches TRANSIENT fields to (and
  // mutates ssl_status on) the returned objects — without cloning, a shared
  // fixture like DOMAIN_ROW would leak state between tests.
  c.maybeSingle = jest.fn().mockResolvedValue({
    error: null,
    data: cfg.maybeSingle ? structuredClone(cfg.maybeSingle) : null,
  });
  c.single = jest.fn().mockResolvedValue({
    error: null,
    data: cfg.single ? structuredClone(cfg.single) : null,
  });
  (c as { then?: unknown }).then = (onF: (v: unknown) => unknown) =>
    Promise.resolve({
      error: null,
      ...(cfg.direct ? structuredClone(cfg.direct) : {}),
    }).then(onF);

  const from = jest.fn(() => c);

  return { client: { from }, from, updateArgs, insertArgs };
}

const DEFAULT_STATUS = {
  status: 'pending' as const,
  misconfigured: false,
  verification: [],
  attached: true,
};

function makeService(opts: {
  client: unknown;
  onPrem?: boolean;
  appUrl?: string;
  vercelConfigured?: boolean;
  servingTarget?: string;
  servingApexIp?: string;
  addDomainResult?: unknown;
  getStatusResult?: unknown;
  getStatusResults?: unknown[];
  /** On-prem serving-probe verdict (default: this edge does serve the domain). */
  served?: boolean;
}) {
  const supa = {
    getClient: () => opts.client,
  } as unknown as SupabaseAdminService;
  const audit = { logAction: jest.fn() } as unknown as AuditLogsService;
  const getStatus = jest.fn();

  if (opts.getStatusResults) {
    for (const r of opts.getStatusResults) getStatus.mockResolvedValueOnce(r);
  }
  getStatus.mockResolvedValue(opts.getStatusResult ?? DEFAULT_STATUS);

  const vercel = {
    isConfigured: jest.fn().mockReturnValue(opts.vercelConfigured ?? false),
    addDomain: jest
      .fn()
      .mockResolvedValue(
        opts.addDomainResult ?? { ok: true, verification: [] },
      ),
    getStatus,
    removeDomain: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'onPrem.enabled') return opts.onPrem ?? false;
      if (key === 'appUrl') return opts.appUrl;
      if (key === 'siteStudio.servingTarget') return opts.servingTarget;
      if (key === 'siteStudio.servingApexIp') return opts.servingApexIp;

      return undefined;
    }),
  } as unknown as ConfigService;

  // On-prem status is now evidence-based: DomainsService asks the serving probe whether
  // this deployment's edge really answers for the domain, instead of assuming it does.
  // `opts.served` lets a test choose the verdict; default true keeps the existing
  // on-prem expectations (a wired-up domain reaches 'active') meaningful.
  const serving = {
    probe: jest.fn().mockImplementation(() =>
      Promise.resolve(
        (opts.served ?? true)
          ? { served: true, reason: 'served', hint: '' }
          : {
              served: false,
              reason: 'handshake-failed',
              hint: 'not served by this edge',
            },
      ),
    ),
    invalidate: jest.fn(),
  };

  return {
    svc: new DomainsService(
      supa,
      audit,
      vercel as unknown as VercelDomainsService,
      config,
      serving as unknown as SiteStudioServingService,
    ),
    vercel,
    serving,
  };
}

describe('DomainsService.verifyDomain', () => {
  afterEach(() => {
    jest.clearAllMocks();
    ResolverMock.mockReset();
  });

  it('CLOUD + DNS miss → stays unverified (no update) and reports record NOT found', async () => {
    resolveTxt.mockRejectedValue(new Error('ENOTFOUND'));
    const { client, updateArgs } = makeClient({ maybeSingle: DOMAIN_ROW });
    const { svc } = makeService({ client, onPrem: false });

    const result = await svc.verifyDomain('fun-1', 'dom-1', 'org-1', 'user-1');

    expect(result.verified).toBe(false);
    expect(updateArgs).toHaveLength(0);
    expect(result.verification_check).toEqual({
      found: false,
      found_values: [],
    });
  });

  it('record exists with the WRONG value → reports found:true with the found values', async () => {
    // e.g. the record NAME pasted into the VALUE field at the DNS provider.
    resolveTxt.mockResolvedValue([['_sitestudio.docs.acme.com']]);
    const { client, updateArgs } = makeClient({ maybeSingle: DOMAIN_ROW });
    const { svc } = makeService({ client, onPrem: false });

    const result = await svc.verifyDomain('fun-1', 'dom-1', 'org-1', 'user-1');

    expect(result.verified).toBe(false);
    expect(updateArgs).toHaveLength(0);
    expect(result.verification_check?.found).toBe(true);
    expect(result.verification_check?.found_values).toContain(
      '_sitestudio.docs.acme.com',
    );
  });

  it('successful verify does NOT attach a verification_check', async () => {
    resolveTxt.mockResolvedValue([['xi-verify-tok']]);
    const { client } = makeClient({
      maybeSingle: DOMAIN_ROW,
      single: { ...DOMAIN_ROW, verified: true },
    });
    const { svc } = makeService({ client });

    const result = await svc.verifyDomain('fun-1', 'dom-1', 'org-1', 'user-1');

    expect(result.verified).toBe(true);
    expect(result.verification_check).toBeUndefined();
  });

  it('matches a TXT value stored with literal surrounding quotes', async () => {
    resolveTxt.mockResolvedValue([['"xi-verify-tok"']]);
    const { client, updateArgs } = makeClient({
      maybeSingle: DOMAIN_ROW,
      single: { ...DOMAIN_ROW, verified: true },
    });
    const { svc } = makeService({ client });

    const result = await svc.verifyDomain('fun-1', 'dom-1', 'org-1', 'user-1');

    expect(result.verified).toBe(true);
    expect(updateArgs[0]).toMatchObject({ verified: true });
  });

  it('joins multi-chunk TXT records before comparing', async () => {
    resolveTxt.mockResolvedValue([['xi-veri', 'fy-tok']]);
    const { client } = makeClient({
      maybeSingle: DOMAIN_ROW,
      single: { ...DOMAIN_ROW, verified: true },
    });
    const { svc } = makeService({ client });

    const result = await svc.verifyDomain('fun-1', 'dom-1', 'org-1', 'user-1');

    expect(result.verified).toBe(true);
  });

  it('falls back to public resolvers when the system resolver misses', async () => {
    // System resolver negative-cached / split-horizon → throws.
    resolveTxt.mockRejectedValue(new Error('ENOTFOUND'));
    // Public resolver sees the record.
    ResolverMock.mockImplementationOnce(() => ({
      setServers: jest.fn(),
      resolveTxt: jest.fn().mockResolvedValue([['xi-verify-tok']]),
    }));
    const { client } = makeClient({
      maybeSingle: DOMAIN_ROW,
      single: { ...DOMAIN_ROW, verified: true },
    });
    const { svc } = makeService({ client, onPrem: false });

    const result = await svc.verifyDomain('fun-1', 'dom-1', 'org-1', 'user-1');

    expect(result.verified).toBe(true);
  });

  it('ON-PREM + DNS miss → trusts operator and marks TLS active (proxy-managed)', async () => {
    resolveTxt.mockRejectedValue(new Error('ENOTFOUND'));
    const { client, updateArgs } = makeClient({
      maybeSingle: DOMAIN_ROW,
      single: { ...DOMAIN_ROW, verified: true, ssl_status: 'active' },
    });
    const { svc } = makeService({ client, onPrem: true });

    const result = await svc.verifyDomain('fun-1', 'dom-1', 'org-1', 'user-1');

    expect(result.verified).toBe(true);
    expect(updateArgs[0]).toMatchObject({
      verified: true,
      ssl_status: 'active',
    });
  });

  it('ON-PREM + DNS hit → verified via DNS (still true)', async () => {
    resolveTxt.mockResolvedValue([['xi-verify-tok']]);
    const { client } = makeClient({
      maybeSingle: DOMAIN_ROW,
      single: { ...DOMAIN_ROW, verified: true },
    });
    const { svc } = makeService({ client, onPrem: true });

    const result = await svc.verifyDomain('fun-1', 'dom-1', 'org-1', 'user-1');

    expect(result.verified).toBe(true);
  });

  it('CLOUD + Vercel needs a challenge → attaches provisioning records + ssl_status', async () => {
    resolveTxt.mockResolvedValue([['xi-verify-tok']]); // our TXT passes
    const { client } = makeClient({
      maybeSingle: DOMAIN_ROW,
      single: { ...DOMAIN_ROW, verified: true, ssl_status: 'pending' },
    });
    const { svc } = makeService({
      client,
      onPrem: false,
      vercelConfigured: true,
      addDomainResult: { ok: true, verification: [] },
      getStatusResult: {
        status: 'pending',
        misconfigured: true,
        verification: [
          { type: 'TXT', name: '_vercel.docs.acme.com', value: 'vc=1' },
        ],
        attached: true,
      },
    });

    const result = await svc.verifyDomain('fun-1', 'dom-1', 'org-1', 'user-1');

    expect(result.verified).toBe(true);
    expect(result.provisioning?.misconfigured).toBe(true);
    expect(result.provisioning?.records).toHaveLength(1);
    expect(result.provisioning?.records[0].name).toBe('_vercel.docs.acme.com');
  });
});

describe('DomainsService.getDomains refresh', () => {
  afterEach(() => jest.clearAllMocks());

  it('SELF-HEALS an unattached verified domain (re-adds to Vercel, re-reads status)', async () => {
    const row = { ...DOMAIN_ROW, verified: true, ssl_status: 'pending' };
    const { client, updateArgs } = makeClient({
      maybeSingle: { id: 'fun-1' }, // assertFunnelBelongsToOrg
      direct: { data: [row] }, // the awaited list select
    });
    const { svc, vercel } = makeService({
      client,
      vercelConfigured: true,
      getStatusResults: [
        // First read: domain was never registered with the project (verified
        // before VERCEL_* existed).
        { ...DEFAULT_STATUS, status: 'pending', attached: false },
        // After the self-heal addDomain: attached and live.
        { ...DEFAULT_STATUS, status: 'active', attached: true },
      ],
    });

    const domains = await svc.getDomains('fun-1', 'org-1');

    expect(vercel.addDomain).toHaveBeenCalledWith('docs.acme.com');
    expect(vercel.getStatus).toHaveBeenCalledTimes(2);
    expect(updateArgs[0]).toMatchObject({ ssl_status: 'active' });
    expect(domains[0].ssl_status).toBe('active');
  });

  it('does not re-add a domain that is already attached', async () => {
    const row = { ...DOMAIN_ROW, verified: true, ssl_status: 'pending' };
    const { client } = makeClient({
      maybeSingle: { id: 'fun-1' },
      direct: { data: [row] },
    });
    const { svc, vercel } = makeService({
      client,
      vercelConfigured: true,
      getStatusResult: { ...DEFAULT_STATUS, status: 'pending', attached: true },
    });

    await svc.getDomains('fun-1', 'org-1');

    expect(vercel.addDomain).not.toHaveBeenCalled();
  });

  it('ON-PREM: heals a verified-but-pending row to active without calling Vercel', async () => {
    const row = { ...DOMAIN_ROW, verified: true, ssl_status: 'pending' };
    const { client, updateArgs } = makeClient({
      maybeSingle: { id: 'fun-1' },
      direct: { data: [row] },
    });
    const { svc, vercel } = makeService({ client, onPrem: true });

    const domains = await svc.getDomains('fun-1', 'org-1');

    expect(updateArgs[0]).toMatchObject({ ssl_status: 'active' });
    expect(domains[0].ssl_status).toBe('active');
    expect(vercel.getStatus).not.toHaveBeenCalled();
    expect(domains[0].tls_automation).toBeUndefined();
  });

  it('CLOUD without a Vercel token → flags verified pending rows tls_automation:none', async () => {
    const row = { ...DOMAIN_ROW, verified: true, ssl_status: 'pending' };
    const { client } = makeClient({
      maybeSingle: { id: 'fun-1' },
      direct: { data: [row, { ...DOMAIN_ROW, id: 'dom-2', verified: false }] },
    });
    const { svc, vercel } = makeService({ client, vercelConfigured: false });

    const domains = await svc.getDomains('fun-1', 'org-1');

    // Verified-but-pending row is flagged; unverified row is not.
    expect(domains[0].tls_automation).toBe('none');
    expect(domains[1].tls_automation).toBeUndefined();
    expect(vercel.getStatus).not.toHaveBeenCalled();
  });

  it('CLOUD with a Vercel token → flags refreshed rows tls_automation:vercel', async () => {
    const row = { ...DOMAIN_ROW, verified: true, ssl_status: 'pending' };
    const { client } = makeClient({
      maybeSingle: { id: 'fun-1' },
      direct: { data: [row] },
    });
    const { svc } = makeService({
      client,
      vercelConfigured: true,
      getStatusResult: { ...DEFAULT_STATUS, status: 'pending', attached: true },
    });

    const domains = await svc.getDomains('fun-1', 'org-1');

    expect(domains[0].tls_automation).toBe('vercel');
  });
});

describe('DomainsService.addDomain serving record', () => {
  afterEach(() => jest.clearAllMocks());

  it('uses the configured serving target when set', async () => {
    const { client } = makeClient({
      maybeSingle: { id: 'fun-1' }, // assertFunnelBelongsToOrg
      single: DOMAIN_ROW, // insert().select().single()
      direct: { count: 0 }, // duplicate head/count check
    });
    const { svc } = makeService({
      client,
      servingTarget: 'edge.customer-cdn.example',
      servingApexIp: '203.0.113.10',
    });

    const { instructions } = await svc.addDomain('fun-1', 'org-1', 'user-1', {
      domain: 'docs.acme.com',
    } as never);

    expect(instructions.serving.value).toBe('edge.customer-cdn.example');
    expect(instructions.message).toContain('edge.customer-cdn.example');
    expect(instructions.message).toContain('203.0.113.10');
  });

  it('ON-PREM without config → derives the target from the deployment appUrl', async () => {
    const { client } = makeClient({
      maybeSingle: { id: 'fun-1' },
      single: DOMAIN_ROW,
      direct: { count: 0 },
    });
    const { svc } = makeService({
      client,
      onPrem: true,
      appUrl: 'https://app.company.internal',
    });

    const { instructions } = await svc.addDomain('fun-1', 'org-1', 'user-1', {
      domain: 'docs.acme.com',
    } as never);

    expect(instructions.serving.value).toBe('app.company.internal');
    expect(instructions.message).toContain('app.company.internal');
    expect(instructions.message).not.toContain('cname.vercel-dns.com');
  });

  it('defaults to the Vercel target when no config is set (cloud)', async () => {
    const { client } = makeClient({
      maybeSingle: { id: 'fun-1' },
      single: DOMAIN_ROW,
      direct: { count: 0 },
    });
    const { svc } = makeService({ client });

    const { instructions } = await svc.addDomain('fun-1', 'org-1', 'user-1', {
      domain: 'docs.acme.com',
    } as never);

    expect(instructions.serving.value).toBe('cname.vercel-dns.com');
  });
});
