/**
 * @fileoverview Cron job that matures the partner kickback ledger. Quote conversion
 * writes one 'projected' row per month of a licence term; this flips each month to
 * 'accrued' once that month has begun, which is what keeps the reporting forecast
 * (strictly-future 'projected' rows) separate from earned kickback.
 * @module src/partner/partner-kickback.cron
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

@Injectable()
export class PartnerKickbackCron {
  private readonly logger = new Logger(PartnerKickbackCron.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  @Cron('0 5 0 1 * *') // 00:05 on the 1st of each month
  async accrueElapsedMonths(): Promise<void> {
    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;

    // Set-based and idempotent: the `.eq('status', 'projected')` guard means a
    // second run (or an extra tick) matches nothing, so this is safe to run more
    // often than monthly - and a missed window self-heals on the next run because
    // the predicate is `<=` the current month, not "the previous month".
    const { data, error } = await this.db
      .from('partner_kickback_entries')
      .update({ status: 'accrued' })
      .eq('status', 'projected')
      .lte('period_month', currentMonth)
      .select('id');

    if (error) {
      this.logger.error(
        `Failed to accrue kickback entries up to ${currentMonth}: ${error.message}`,
      );

      return;
    }

    if (data?.length) {
      this.logger.log(
        `Accrued ${data.length} kickback entr${data.length === 1 ? 'y' : 'ies'} up to ${currentMonth}`,
      );
    }
  }
}
