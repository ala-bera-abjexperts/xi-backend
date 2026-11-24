import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as dns from 'dns/promises';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { AddDomainDto } from './dto/add-domain.dto';
import {
  SiteStudioServingService,
  type ServingProbeResult,
} from './site-studio-serving.service';
import {
  VercelDomainsService,
  type VercelDnsRecord,
} from './vercel-domains.service';

export interface SiteStudioDomain {
  id: string;
  funnel_id: string;
  organization_id: string;
  domain: string;
  verified: boolean;
  verification_token: string;
  ssl_status: 'pending' | 'active' | 'error';
  created_at: string;
  updated_at: string;
  /**
   * TRANSIENT (not a DB column) — live TLS/serving provisioning state from the
   * hosting provider (Vercel), computed on verify/list. `records` are extra DNS
   * records the customer still needs to add (e.g. Vercel's `_vercel` ownership
   * TXT) before the domain goes live.
   */
  provisioning?: { misconfigured: boolean; records: VercelDnsRecord[] };
  /**
   * TRANSIENT (not a DB column) — attached to the row returned by a FAILED
   * verify so the UI can say precisely what's wrong: `found: true` means TXT
   * record(s) exist at `_sitestudio.<domain>` but none matches the expected
   * token (e.g. the record NAME pasted into the VALUE field at the DNS
   * provider); `found: false` means no record resolved at all (missing or
   * still propagating). Values are public DNS data — nothing sensitive.
   */
  verification_check?: { found: boolean; found_values: string[] };
  /**
   * TRANSIENT (not a DB column) — how TLS is provisioned for this domain.
   * `'vercel'`   = automatic via the Vercel API.
   * `'none'`     = nothing will ever issue a certificate (cloud without a
   *                VERCEL_TOKEN). The UI must say so instead of showing
   *                "Setting up…" forever — a verified domain once sat stuck for
   *                hours with no explanation.
   * `'external'` = an upstream load balancer we don't control terminates TLS
   *                (on-prem behind-proxy, or SITE_STUDIO_ASSUME_EXTERNAL_TLS=1).
   * `'manual'`   = on-prem, and this deployment's own edge is NOT serving the
   *                domain yet. This is the state that used to be reported as
   *                'active' with no evidence, producing a green "Live" chip for a
   *                domain every visitor saw fail with ERR_SSL_PROTOCOL_ERROR.
   */
  tls_automation?: 'vercel' | 'none' | 'external' | 'manual';
  /**
   * TRANSIENT (not a DB column) — operator-facing next step when the on-prem edge
   * is not serving the domain (e.g. "add it to SITE_STUDIO_CUSTOM_DOMAINS"). Empty
   * when the domain is served. Never contains anything sensitive.
   */
  serving_hint?: string;
}

export interface DomainDnsRecord {
  type: 'TXT' | 'CNAME';
  name: string;
  value: string;
}

/**
 * Two DNS records a custom domain needs: (1) a TXT to prove ownership (checked
 * by Verify), and (2) a CNAME pointing the domain at Vercel so it serves and
 * gets a certificate. `message` is a human-readable one-liner for the toast.
 */
export interface DomainInstructions {
  verification: DomainDnsRecord;
  serving: DomainDnsRecord;
  message: string;
}

// Cloud defaults for the serving DNS record that points a custom domain at the
// Vercel-hosted frontend. Resolution order per deployment: explicit
// `siteStudio.servingTarget`/`servingApexIp` config → (on-prem) the deployment's
// own app host derived from `appUrl` → these Vercel defaults. Kept in sync with
// the frontend logic in src/utils/site-studio-url.ts.
const DEFAULT_SERVING_CNAME_TARGET = 'cname.vercel-dns.com';
const DEFAULT_SERVING_APEX_IP = '76.76.21.21';

@Injectable()
export class DomainsService {
  private readonly logger = new Logger(DomainsService.name);
  static readonly TABLE = 'site_studio_domains';
  static readonly FUNNELS_TABLE = 'site_studio_funnels';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
    private readonly vercel: VercelDomainsService,
    private readonly config: ConfigService,
    private readonly serving: SiteStudioServingService,
  ) {}

  /**
   * Host of this deployment (from the `appUrl` config) — the natural serving
   * target on-prem, where the reverse proxy that serves the app is the same one
   * that will serve custom domains.
   */
  private get appHost(): string | null {
    const appUrl = this.config.get<string>('appUrl');

    if (!appUrl) return null;

    try {
      return new URL(appUrl).host;
    } catch {
      return null;
    }
  }

  /**
   * CNAME target a custom domain points at. Explicit env config wins; on-prem
   * (no config) defaults to the deployment's own host — NEVER Vercel, which
   * would send the customer's traffic to the wrong place.
   */
  private get servingTarget(): string {
    const configured = this.config.get<string>('siteStudio.servingTarget');

    if (configured) return configured;
    if (this.isOnPremise) return this.appHost ?? DEFAULT_SERVING_CNAME_TARGET;

    return DEFAULT_SERVING_CNAME_TARGET;
  }

  /** A-record target for apex custom domains (same resolution order as above). */
  private get servingApexIp(): string {
    const configured = this.config.get<string>('siteStudio.servingApexIp');

    if (configured) return configured;
    if (this.isOnPremise) return this.appHost ?? DEFAULT_SERVING_APEX_IP;

    return DEFAULT_SERVING_APEX_IP;
  }

  /** True only on a self-hosted on-prem stack (single-customer install). */
  private get isOnPremise(): boolean {
    return this.config.get<boolean>('onPrem.enabled') === true;
  }

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async assertFunnelBelongsToOrg(
    funnelId: string,
    organizationId: string,
  ): Promise<void> {
    const { data } = await this.client
      .from(DomainsService.FUNNELS_TABLE)
      .select('id')
      .eq('id', funnelId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!data) throw new NotFoundException('Funnel not found');
  }

  private generateVerificationToken(): string {
    return `xi-verify-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }

  /**
   * Normalize raw `resolveTxt` output for comparison: join the 255-byte chunks
   * of each record, trim, and strip one pair of surrounding double-quotes (some
   * DNS providers store the value verbatim when pasted with quotes).
   */
  private static normalizeTxtValues(records: string[][]): string[] {
    return records.map((chunks) =>
      chunks
        .join('')
        .trim()
        .replace(/^"(.*)"$/s, '$1')
        .trim(),
    );
  }

  /**
   * Look up the TXT records at `name` and compare against `expected`. Tries the
   * system resolver first; on a miss (throw OR no matching value) retries once
   * via well-known public resolvers — this bypasses negative caching on the
   * host's resolver (a Verify clicked before the record propagated poisons the
   * cache for the negative-TTL window) and split-horizon setups that can't see
   * the public zone. Fails fast (2s) and silently on fully closed networks,
   * where the on-prem trust fallback in verifyDomain still applies.
   *
   * Returns the values actually found (merged from both resolvers, deduped) so
   * the caller can distinguish "record exists with the wrong value" from "no
   * record at all" and tell the customer exactly what to fix.
   */
  private async lookupTxtVerification(
    name: string,
    expected: string,
  ): Promise<{ matched: boolean; foundValues: string[] }> {
    const found = new Set<string>();

    try {
      for (const v of DomainsService.normalizeTxtValues(
        await dns.resolveTxt(name),
      )) {
        found.add(v);
      }

      if (found.has(expected)) {
        return { matched: true, foundValues: [...found] };
      }
    } catch {
      // System resolver failed — fall through to the public-resolver retry.
    }

    try {
      const resolver = new dns.Resolver({ timeout: 2000, tries: 1 });

      resolver.setServers(['1.1.1.1', '8.8.8.8']);

      for (const v of DomainsService.normalizeTxtValues(
        await resolver.resolveTxt(name),
      )) {
        found.add(v);
      }
    } catch {
      // Public resolvers unreachable (e.g. air-gapped) — nothing more found.
    }

    return { matched: found.has(expected), foundValues: [...found] };
  }

  private logDomainAction(
    organizationId: string,
    userId: string,
    domainId: string,
    action: 'create' | 'update' | 'delete',
    changes?: Record<string, unknown>,
  ): void {
    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'site_studio_domain',
      domainId,
      action,
      changes,
    );
  }

  async getDomains(
    funnelId: string,
    organizationId: string,
  ): Promise<SiteStudioDomain[]> {
    await this.assertFunnelBelongsToOrg(funnelId, organizationId);

    const { data, error } = await this.client
      .from(DomainsService.TABLE)
      .select('*')
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    const domains = (data ?? []) as unknown as SiteStudioDomain[];

    // On-prem: reconcile each verified domain's status against whether this edge
    // ACTUALLY serves it. The previous behaviour unconditionally forced 'active'
    // here, which is what let a domain nothing served display a green "Live" chip
    // while every visitor got ERR_SSL_PROTOCOL_ERROR. The probe is cached, so a
    // tab refresh does not mean a TLS connection per domain.
    if (this.isOnPremise) {
      await Promise.all(
        domains
          .filter((dm) => dm.verified)
          .map(async (dm) => {
            try {
              await this.applyServingStatus(dm);
            } catch {
              // Best-effort — a probe failure must never fail the domain list.
            }
          }),
      );
    } else if (this.vercel.isConfigured()) {
      // Cloud: opportunistically refresh the SSL status of any verified-but-not-
      // yet-active domain from Vercel, so the UI reflects live cert state without
      // a dedicated polling endpoint. Only touches rows still provisioning;
      // best-effort — a Vercel outage never fails the list.
      await Promise.all(
        domains
          .filter((dm) => dm.verified && dm.ssl_status !== 'active')
          .map(async (dm) => {
            dm.tls_automation = 'vercel';

            try {
              let st = await this.vercel.getStatus(dm.domain);

              // SELF-HEAL: a domain verified before VERCEL_* was configured was
              // never registered with the Vercel project (the only attach point
              // was the Verify click). Re-attach it now — idempotent (409-safe)
              // — then re-read the live status so the cert can start issuing.
              if (!st.attached) {
                const added = await this.vercel.addDomain(dm.domain);

                if (added.ok) st = await this.vercel.getStatus(dm.domain);
              }

              if (st.status !== dm.ssl_status) {
                await this.client
                  .from(DomainsService.TABLE)
                  .update({ ssl_status: st.status })
                  .eq('id', dm.id);
                dm.ssl_status = st.status; // reflect in the returned payload
              }

              // Surface any outstanding provider records / misconfiguration so
              // the UI can tell the customer exactly what to finish (transient).
              if (st.verification.length > 0 || st.misconfigured) {
                dm.provisioning = {
                  misconfigured: st.misconfigured,
                  records: st.verification,
                };
              }
            } catch {
              // Best-effort refresh — never let it fail the domain list.
            }
          }),
      );
    } else {
      // Cloud WITHOUT a configured Vercel token: nothing will ever provision a
      // certificate. Flag the rows so the UI can say "Awaiting TLS setup"
      // instead of an unexplained, eternal "Setting up…".
      for (const dm of domains) {
        if (dm.verified && dm.ssl_status !== 'active') {
          dm.tls_automation = 'none';
        }
      }
    }

    return domains;
  }

  async addDomain(
    funnelId: string,
    organizationId: string,
    userId: string,
    dto: AddDomainDto,
  ): Promise<{
    domain: SiteStudioDomain;
    instructions: DomainInstructions;
  }> {
    await this.assertFunnelBelongsToOrg(funnelId, organizationId);

    // Check domain is not already in use
    const { count } = await this.client
      .from(DomainsService.TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('domain', dto.domain);

    if ((count ?? 0) > 0) {
      throw new BadRequestException(`Domain "${dto.domain}" is already in use`);
    }

    const verificationToken = this.generateVerificationToken();

    const { data, error } = (await this.client
      .from(DomainsService.TABLE)
      .insert({
        funnel_id: funnelId,
        organization_id: organizationId,
        domain: dto.domain,
        verification_token: verificationToken,
      })
      .select()
      .single()) as {
      data: SiteStudioDomain | null;
      error: { message: string; code: string } | null;
    };

    if (error) {
      if (error.code === '23505')
        throw new BadRequestException('Domain already registered');
      throw new BadRequestException(error.message);
    }

    const domain = data as SiteStudioDomain;
    this.logDomainAction(organizationId, userId, domain.id, 'create', {
      funnel_id: funnelId,
      domain: domain.domain,
    });

    return {
      domain,
      instructions: {
        // Record #1 — proves ownership (checked by Verify).
        verification: {
          type: 'TXT',
          name: `_sitestudio.${dto.domain}`,
          value: verificationToken,
        },
        // Record #2 — points the domain at the frontend (Vercel on cloud, the
        // on-prem reverse proxy on-prem) so it serves + gets TLS.
        serving: {
          type: 'CNAME',
          name: dto.domain,
          value: this.servingTarget,
        },
        message:
          `Add two DNS records for "${dto.domain}": ` +
          `(1) TXT "_sitestudio.${dto.domain}" = "${verificationToken}" to verify ownership, then ` +
          `(2) CNAME "${dto.domain}" → ${this.servingTarget} (apex domains: A → ${this.servingApexIp}) so it serves over HTTPS.`,
      },
    };
  }

  async removeDomain(
    funnelId: string,
    domainId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const { data } = await this.client
      .from(DomainsService.TABLE)
      .select('id, domain')
      .eq('id', domainId)
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!data) throw new NotFoundException('Domain not found');

    const { error } = await this.client
      .from(DomainsService.TABLE)
      .delete()
      .eq('id', domainId)
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    const removedDomain = (data as Record<string, unknown>)['domain'] as string;

    this.logDomainAction(organizationId, userId, domainId, 'delete', {
      funnel_id: funnelId,
      domain: removedDomain,
    });

    // Release the domain from the Vercel project so it stops occupying a slot /
    // holding a cert. Best-effort — removeDomain never throws.
    await this.vercel.removeDomain(removedDomain);
  }

  async verifyDomain(
    funnelId: string,
    domainId: string,
    organizationId: string,
    userId: string,
  ): Promise<SiteStudioDomain> {
    const { data: domain } = (await this.client
      .from(DomainsService.TABLE)
      .select('*')
      .eq('id', domainId)
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId)
      .maybeSingle()) as {
      data: SiteStudioDomain | null;
      error: { message: string } | null;
    };

    if (!domain) throw new NotFoundException('Domain not found');

    const d = domain;

    if (d.verified) return d; // already verified

    // DNS lookup for the ownership TXT record (system resolver, then public
    // resolvers — see lookupTxtVerification for why both).
    const txt = await this.lookupTxtVerification(
      `_sitestudio.${d.domain}`,
      d.verification_token,
    );
    let verified = txt.matched;

    // On-premise fallback: a self-hosted install is single-customer and whoever
    // adds the domain owns the whole server, so the public-DNS ownership proof is
    // unnecessary — and often impossible (air-gapped / split-horizon DNS). We try
    // real DNS first (above), and only trust the operator when it can't confirm,
    // so an on-prem box WITH egress still gets a genuine DNS verification. The
    // cloud path never reaches this branch.
    if (!verified && this.isOnPremise) {
      this.logger.log(
        `On-prem: trusting operator for domain "${d.domain}" (DNS TXT not confirmed)`,
      );
      verified = true;
    }

    if (!verified) {
      // Tell the UI precisely WHY: a record with the wrong value ("found") is a
      // very different fix than a missing/unpropagated record. Transient field.
      d.verification_check = {
        found: txt.foundValues.length > 0,
        found_values: txt.foundValues,
      };

      return d;
    }

    // Ownership proven. Provision TLS by registering the domain with the Vercel
    // project (Vercel serves it + issues a certificate on-demand). Best-effort:
    // a Vercel outage must NOT fail verification — ssl_status stays 'pending'
    // and the next getDomains() refresh will pick up the cert once it lands.
    //
    // ON-PREM: there is no Vercel; this deployment's own reverse proxy serves the
    // domain. Whether it is CONFIGURED to is exactly what we must not assume — see
    // SiteStudioServingService. Start pending and let the probe below decide, so a
    // domain the edge has never heard of is never reported Live.
    let sslStatus: SiteStudioDomain['ssl_status'] = 'pending';
    let provisioning: SiteStudioDomain['provisioning'];
    let servingProbe: ServingProbeResult | null = null;

    if (this.isOnPremise) {
      // A freshly-added domain may have just been wired up; don't answer from a
      // verdict cached before the operator's last ./deploy.sh.
      this.serving.invalidate(d.domain);
      servingProbe = await this.serving.probe(d.domain);
      sslStatus = servingProbe.served ? 'active' : 'pending';
    }

    if (this.vercel.isConfigured()) {
      const added = await this.vercel.addDomain(d.domain);

      if (added.ok) {
        const st = await this.vercel.getStatus(d.domain);

        sslStatus = st.status;
        // Prefer the live getStatus records; fall back to the add-time challenge.
        const records =
          st.verification.length > 0 ? st.verification : added.verification;

        if (records.length > 0 || st.misconfigured) {
          provisioning = { misconfigured: st.misconfigured, records };
        }
      } else {
        sslStatus = 'error';

        if (added.verification.length > 0) {
          provisioning = { misconfigured: false, records: added.verification };
        }
      }
    }

    const { data: updated, error } = (await this.client
      .from(DomainsService.TABLE)
      .update({ verified: true, ssl_status: sslStatus })
      .eq('id', domainId)
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId)
      .select()
      .single()) as {
      data: SiteStudioDomain | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);

    this.logDomainAction(organizationId, userId, domainId, 'update', {
      funnel_id: funnelId,
      domain: d.domain,
      verified: true,
    });

    const result = updated as SiteStudioDomain;

    // Attach the transient provisioning state so the UI can immediately show the
    // next DNS step (e.g. Vercel's `_vercel` ownership TXT) without a refresh.
    if (provisioning) result.provisioning = provisioning;

    // Cloud without a Vercel token: TLS will never provision automatically —
    // tell the UI right away (same flag getDomains attaches on refresh).
    if (!this.isOnPremise && !this.vercel.isConfigured()) {
      result.tls_automation = 'none';
    }

    // On-prem: carry the probe verdict (and its remedy) straight back, so the
    // operator sees "Awaiting TLS setup — add it to SITE_STUDIO_CUSTOM_DOMAINS"
    // the moment they click Verify rather than a green chip and a broken site.
    if (servingProbe) this.decorateWithServingProbe(result, servingProbe);

    return result;
  }

  /**
   * Reconcile one on-prem domain's persisted `ssl_status` with reality, and attach the
   * transient fields the UI needs to explain it.
   *
   * Writes only on an actual transition, so the common steady state costs nothing.
   */
  private async applyServingStatus(dm: SiteStudioDomain): Promise<void> {
    const probe = await this.serving.probe(dm.domain);
    const desired: SiteStudioDomain['ssl_status'] = probe.served
      ? 'active'
      : 'pending';

    if (dm.ssl_status !== desired) {
      await this.client
        .from(DomainsService.TABLE)
        .update({ ssl_status: desired })
        .eq('id', dm.id);
      dm.ssl_status = desired; // reflect in the returned payload
    }

    this.decorateWithServingProbe(dm, probe);
  }

  /** Attach the transient `tls_automation` / `serving_hint` pair from a probe result. */
  private decorateWithServingProbe(
    dm: SiteStudioDomain,
    probe: ServingProbeResult,
  ): void {
    if (probe.reason === 'external-tls-assumed') {
      dm.tls_automation = 'external';

      return;
    }

    if (!probe.served) {
      dm.tls_automation = 'manual';
      dm.serving_hint = probe.hint;
    }
  }
}
