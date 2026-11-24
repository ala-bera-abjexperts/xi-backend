/**
 * @fileoverview Thin wrapper over the Vercel REST API used to provision TLS for
 * Site Studio custom domains. Adding a domain to the Vercel project makes Vercel
 * serve it and issue a certificate on-demand.
 * @module src/site-studio/domains/vercel-domains.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type VercelDomainStatus = 'active' | 'pending' | 'error';

/** A DNS record the customer must add for Vercel to serve/verify the domain. */
export interface VercelDnsRecord {
  type: string;
  name: string;
  value: string;
}

/**
 * FEATURE-FLAGGED: when `VERCEL_TOKEN` / `VERCEL_PROJECT_ID` are unset (dev,
 * on-prem, local), {@link isConfigured} is false and every method no-ops, so
 * domain verification still succeeds — only automatic cert provisioning is
 * skipped. Every method is best-effort and NEVER throws: a Vercel outage must
 * not break the surrounding verify/list/delete flow.
 */
@Injectable()
export class VercelDomainsService {
  private readonly logger = new Logger(VercelDomainsService.name);
  private static readonly API = 'https://api.vercel.com';
  private static readonly TIMEOUT_MS = 8_000;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.token && this.projectId);
  }

  private get token(): string | undefined {
    return this.config.get<string>('vercel.token');
  }

  private get projectId(): string | undefined {
    return this.config.get<string>('vercel.projectId');
  }

  /** `?teamId=...` for team-scoped projects, or `''` for personal accounts. */
  private get teamQuery(): string {
    const teamId = this.config.get<string>('vercel.teamId');

    return teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data: any }> {
    const res = await fetch(`${VercelDomainsService.API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(VercelDomainsService.TIMEOUT_MS),
    });

    let data: any = null;

    try {
      data = await res.json();
    } catch {
      // Empty body (e.g. 204 No Content) — leave data null.
    }

    return { ok: res.ok, status: res.status, data };
  }

  /**
   * Map Vercel's `verification` array (`{ type, domain, value, reason }`) into
   * our `{ type, name, value }` DNS-record shape (Vercel's `domain` is the record
   * NAME, e.g. `_vercel.docs.acme.com`). Best-effort — bad entries are dropped.
   */
  private mapVerification(raw: unknown): VercelDnsRecord[] {
    if (!Array.isArray(raw)) return [];

    return raw
      .map((r) => {
        const rec = (r ?? {}) as Record<string, unknown>;

        return {
          type: String(rec.type ?? 'TXT'),
          name: String(rec.domain ?? ''),
          value: String(rec.value ?? ''),
        };
      })
      .filter((r) => r.name !== '' && r.value !== '');
  }

  /**
   * Register a domain with the Vercel project so Vercel serves it and issues a
   * TLS certificate. Idempotent: a domain already attached to THIS project is
   * treated as success. Returns `ok: false` only on a genuine failure, plus any
   * extra DNS records Vercel requires for ownership (`_vercel` TXT etc.).
   */
  async addDomain(
    name: string,
  ): Promise<{ ok: boolean; verification: VercelDnsRecord[] }> {
    if (!this.isConfigured()) {
      this.logger.log(
        `Vercel not configured — skipping TLS provisioning for "${name}"`,
      );

      return { ok: false, verification: [] };
    }

    try {
      const { ok, status, data } = await this.request(
        'POST',
        `/v10/projects/${this.projectId}/domains${this.teamQuery}`,
        { name },
      );

      // 409 / `domain_already_exists` = already on this project (idempotent).
      if (
        ok ||
        status === 409 ||
        data?.error?.code === 'domain_already_exists'
      ) {
        return {
          ok: true,
          verification: this.mapVerification(data?.verification),
        };
      }

      this.logger.error(
        `Vercel addDomain "${name}" failed (${status}): ${
          data?.error?.message ?? 'unknown error'
        }`,
      );

      return { ok: false, verification: [] };
    } catch (e: any) {
      this.logger.error(`Vercel addDomain "${name}" threw: ${e?.message}`);

      return { ok: false, verification: [] };
    }
  }

  /**
   * Resolve the current TLS/serving status of a custom domain on the Vercel
   * project. `verified && !misconfigured` ⇒ the domain serves and a cert is (or
   * will shortly be) issued ⇒ 'active'. A 404 (not yet added) or partial config
   * ⇒ 'pending'. Any hard failure ⇒ 'error'. Also returns whether the DNS is
   * misconfigured, any outstanding ownership records the customer must add, and
   * `attached` — false ONLY when the project doesn't hold the domain (404), so
   * callers can self-heal by re-registering it (e.g. a domain verified before
   * VERCEL_TOKEN was configured). Transient failures report `attached: true` to
   * avoid pointless re-add attempts during outages.
   */
  async getStatus(name: string): Promise<{
    status: VercelDomainStatus;
    misconfigured: boolean;
    verification: VercelDnsRecord[];
    attached: boolean;
  }> {
    if (!this.isConfigured()) {
      return {
        status: 'pending',
        misconfigured: false,
        verification: [],
        attached: false,
      };
    }

    try {
      const enc = encodeURIComponent(name);
      const base = `/v9/projects/${this.projectId}/domains/${enc}`;

      const domainRes = await this.request('GET', `${base}${this.teamQuery}`);

      if (!domainRes.ok) {
        // 404 = not attached to the project; anything else is a hard failure
        // (report attached so callers don't retry the add on a flaky API).
        return {
          status: domainRes.status === 404 ? 'pending' : 'error',
          misconfigured: false,
          verification: [],
          attached: domainRes.status !== 404,
        };
      }

      const verified = domainRes.data?.verified === true;
      const verification = this.mapVerification(domainRes.data?.verification);

      const configRes = await this.request(
        'GET',
        `${base}/config${this.teamQuery}`,
      );
      const misconfigured = configRes.data?.misconfigured === true;

      return {
        status: verified && !misconfigured ? 'active' : 'pending',
        misconfigured,
        verification,
        attached: true,
      };
    } catch (e: any) {
      this.logger.error(`Vercel getStatus "${name}" threw: ${e?.message}`);

      return {
        status: 'error',
        misconfigured: false,
        verification: [],
        attached: true,
      };
    }
  }

  /**
   * Release a domain from the Vercel project (best-effort) so a deleted custom
   * domain stops occupying the project's domain slot. Swallows all errors.
   */
  async removeDomain(name: string): Promise<void> {
    if (!this.isConfigured()) return;

    try {
      const enc = encodeURIComponent(name);
      const { ok, status } = await this.request(
        'DELETE',
        `/v9/projects/${this.projectId}/domains/${enc}${this.teamQuery}`,
      );

      if (!ok && status !== 404) {
        this.logger.warn(`Vercel removeDomain "${name}" returned ${status}`);
      }
    } catch (e: any) {
      this.logger.error(`Vercel removeDomain "${name}" threw: ${e?.message}`);
    }
  }
}
