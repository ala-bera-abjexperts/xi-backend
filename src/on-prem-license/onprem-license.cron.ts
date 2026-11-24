/**
 * @fileoverview Scheduled licence check for on-premise deployments.
 * @module on-prem-license/onprem-license.cron
 *
 * Author: Prince Jadiya
 *
 * Cadence, per requirement:
 *   - normal: once per day
 *   - on the expiry date: every 6 hours
 *   - while locked: every 6 hours
 *
 * Implemented as a 6-hourly tick that decides whether this particular tick is
 * due, rather than as two competing schedules. One timer, one claim, and the
 * cadence becomes a property of stored state that survives a restart.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { OnpremLicensePollService } from './onprem-license-poll.service';
import { OnpremLicenseStateService } from './onprem-license.service';
import { claimCronSlot } from '../common/utils/cron-claim';

const CHECK_JOB = 'onprem_license_check';

/** Daily cadence, minus a slack minute so a slightly early tick still fires. */
const DAILY_MS = 24 * 60 * 60 * 1000 - 60_000;

/** Accelerated cadence, same slack. */
const FAST_MS = 6 * 60 * 60 * 1000 - 60_000;

@Injectable()
export class OnpremLicenseCron {
  private readonly logger = new Logger(OnpremLicenseCron.name);

  constructor(
    private readonly poll: OnpremLicensePollService,
    private readonly state: OnpremLicenseStateService,
    private readonly config: ConfigService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get isOnPremise(): boolean {
    return this.config.get<boolean>('onPrem.enabled') === true;
  }

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * 04:45 and every 6 hours after. Offset from the 04:15 update-notice cron and
   * the 03:30 file-explorer purge so the three never overlap.
   */
  @Cron('0 45 4,10,16,22 * * *')
  async tick(): Promise<void> {
    if (!this.isOnPremise) return;

    try {
      const fast = await this.state.needsFastCadence();
      const interval = fast ? FAST_MS : DAILY_MS;

      if (!(await this.claim(interval))) return;

      const result = await this.poll.poll();

      // Only genuinely surprising outcomes are logged. A steady-state `updated`
      // is silent; state CHANGES are logged by the poll service itself.
      if (result.outcome === 'unreachable') {
        this.logger.warn(
          `licence check could not reach the vendor: ${result.detail ?? 'unknown'}`,
        );
      }
    } catch (err) {
      // A cron must never take the process down.
      this.logger.error(
        `licence check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Claims this tick for the whole deployment: an atomic compare-and-swap on
   * cron_run_state (claimCronSlot), so with several replicas exactly one polls
   * per window. It also damps a restart loop, as the read-then-write did before.
   */
  private async claim(intervalMs: number): Promise<boolean> {
    return (await claimCronSlot(this.db, CHECK_JOB, intervalMs)) !== null;
  }
}
