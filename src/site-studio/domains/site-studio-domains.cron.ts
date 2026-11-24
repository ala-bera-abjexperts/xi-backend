/**
 * @fileoverview Background sweeper that drives Site Studio custom domains to
 * "Live" WITHOUT anyone opening the Domains tab. Every few minutes it picks up
 * verified-but-not-yet-active domains and, on cloud, ensures each is attached
 * to the Vercel project (idempotent) and refreshes its certificate status; on
 * on-prem it PROBES this deployment's own edge and promotes only the domains it
 * genuinely serves (it used to promote them all unconditionally, which reported
 * unserved domains as "Live" — see SiteStudioServingService).
 *
 * This is what makes custom domains hands-off at platform scale: verify-time
 * attach + Domains-tab self-heal give instant feedback when a human is looking,
 * and this sweep converges everything else — domains verified before
 * VERCEL_TOKEN existed, transient attach failures, slow cert issuance — within
 * one sweep interval, for every tenant, with zero operator work per domain.
 *
 * SECURITY: only `verified = true` rows are ever swept/attached — a domain is
 * never registered with the hosting project before the `_sitestudio` TXT
 * ownership proof (prevents cross-tenant domain squatting).
 * @module src/site-studio/domains/site-studio-domains.cron
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { SiteStudioServingService } from './site-studio-serving.service';
import { VercelDomainsService } from './vercel-domains.service';
import { claimCronSlot } from '../../common/utils/cron-claim';

// Bounded batch per sweep: gentle on the Vercel API (max ~2 calls/domain) while
// still draining a large backlog quickly (50 domains / 5 min = 600/hour).
const SWEEP_BATCH_SIZE = 50;
/** cron_run_state key for the sweep claim. */
const SWEEP_JOB = 'site_studio_domains_sweep';

type SweepRow = {
  id: string;
  domain: string;
  ssl_status: 'pending' | 'active' | 'error';
};

@Injectable()
export class SiteStudioDomainsCron {
  private readonly logger = new Logger(SiteStudioDomainsCron.name);
  private static readonly TABLE = 'site_studio_domains';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly vercel: VercelDomainsService,
    private readonly config: ConfigService,
    private readonly serving: SiteStudioServingService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  private get isOnPremise(): boolean {
    return this.config.get<boolean>('onPrem.enabled') === true;
  }

  // Every 5 minutes at second 45 (offset from the file-explorer crons at :00).
  @Cron('45 */5 * * * *')
  async sweepPendingDomains(): Promise<void> {
    // Cloud without a Vercel token: nothing this sweep could do — the phase-6
    // "Awaiting TLS setup" UI state already explains it to tenant admins.
    if (!this.isOnPremise && !this.vercel.isConfigured()) return;

    // One sweep per 5-minute slot across replicas (4 min leaves slack for timer jitter).
    if (!(await claimCronSlot(this.db, SWEEP_JOB, 4 * 60_000))) return;

    const { data, error } = await this.db
      .from(SiteStudioDomainsCron.TABLE)
      .select('id, domain, ssl_status')
      .eq('verified', true)
      .neq('ssl_status', 'active')
      .order('updated_at', { ascending: true })
      .limit(SWEEP_BATCH_SIZE);

    if (error) {
      this.logger.error(`Domain sweep query failed: ${error.message}`);

      return;
    }

    const rows = (data ?? []) as SweepRow[];

    if (rows.length === 0) return;

    // On-prem: this used to blanket-UPDATE the whole batch to 'active' without
    // contacting anything, which is how a domain the edge had never been told about
    // ended up displaying a green "Live" chip while every visitor got
    // ERR_SSL_PROTOCOL_ERROR. Probe each one instead and promote only what is truly
    // served. Sequential: the batch is small, the probe is a cached 3s-max TLS
    // handshake, and a burst of parallel connections to our own edge buys nothing.
    if (this.isOnPremise) {
      const activatedIds: string[] = [];

      for (const row of rows) {
        try {
          const probe = await this.serving.probe(row.domain);

          if (probe.served) activatedIds.push(row.id);
        } catch (err) {
          // One unreachable domain must never abort the sweep.
          this.logger.debug(
            `On-prem serving probe failed for ${row.domain}: ${(err as Error).message}`,
          );
        }
      }

      if (activatedIds.length > 0) {
        const { error: healError } = await this.db
          .from(SiteStudioDomainsCron.TABLE)
          .update({ ssl_status: 'active' })
          .in('id', activatedIds);

        if (healError) {
          this.logger.error(`On-prem domain heal failed: ${healError.message}`);
        } else {
          this.logger.log(
            `On-prem: ${activatedIds.length} of ${rows.length} domain(s) confirmed served → active`,
          );
        }
      } else {
        this.logger.log(
          `On-prem: none of ${rows.length} pending domain(s) are served by this edge yet — see DEPLOY.md → SiteStudio published sites.`,
        );
      }

      return;
    }

    // Cloud: process SEQUENTIALLY (rate-limit friendly; max ~2 API calls per
    // domain). Per-row try/catch — one bad domain never blocks the rest.
    let activated = 0;

    for (const row of rows) {
      try {
        let st = await this.vercel.getStatus(row.domain);

        // Not on the project (verified before the token existed, or a transient
        // attach failure at verify time) → attach now. Idempotent (409-safe).
        if (!st.attached) {
          const added = await this.vercel.addDomain(row.domain);

          if (added.ok) st = await this.vercel.getStatus(row.domain);
        }

        if (st.status !== row.ssl_status) {
          await this.db
            .from(SiteStudioDomainsCron.TABLE)
            .update({ ssl_status: st.status })
            .eq('id', row.id);

          if (st.status === 'active') activated += 1;
        }
      } catch (e: any) {
        this.logger.error(
          `Domain sweep failed for "${row.domain}": ${e?.message}`,
        );
      }
    }

    if (activated > 0) {
      this.logger.log(`Domain sweep: ${activated} domain(s) went live`);
    }
  }
}
