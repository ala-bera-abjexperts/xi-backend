/**
 * @fileoverview Daily licence status sweep (licensing audit L5 / D2).
 * @module licensing/license-status.cron
 *
 * Nothing used to change a licence's `status` when its paid window ended or a
 * trial ran out: entitlements ignored a lapsed `ends_at` but the row still read
 * `active`, and trials never ended at all. Once a day this marks such licences
 * `expired` (tenant drops to the Free tier) and writes an audit event for each.
 *
 * SaaS only: an on-prem box takes its licence from the signed artifact.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { claimCronSlot } from '../common/utils/cron-claim';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { LicensingService } from './licensing.service';

const JOB = 'license_status_sweep';

/** Daily, minus a slack minute so a slightly early tick still fires. */
const DAILY_MS = 24 * 60 * 60 * 1000 - 60_000;

@Injectable()
export class LicenseStatusCron {
  private readonly logger = new Logger(LicenseStatusCron.name);

  constructor(
    private readonly licensing: LicensingService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly config: ConfigService,
  ) {}

  @Cron('0 15 0 * * *')
  async sweep(): Promise<void> {
    if (this.config.get<boolean>('onPrem.enabled')) return;

    try {
      // Several API replicas: only the one that wins the slot runs the sweep.
      const stamp = await claimCronSlot(
        this.supabaseAdmin.getClient(),
        JOB,
        DAILY_MS,
      );
      if (stamp === null) return;

      const expired = await this.licensing.expireLapsedLicenses();
      if (expired > 0) {
        this.logger.log(`license status sweep: ${expired} licence(s) expired`);
      }
    } catch (err) {
      // A cron must never throw into the scheduler.
      this.logger.error(
        `license status sweep failed: ${(err as Error).message}`,
      );
    }
  }
}
