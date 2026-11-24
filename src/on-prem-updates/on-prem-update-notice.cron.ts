/**
 * @fileoverview Daily on-premise update check + owner notification.
 *
 * Nobody should have to remember to open Tenant Config and press "Check for Updates". Once a day
 * this asks the updater sidecar to run a check, and if a newer release is available it tells the
 * organization's owners — once per version, never once per day.
 *
 * ON-PREM ONLY BY CONSTRUCTION: this provider lives in OnPremUpdatesModule, which AppModule
 * imports only when IS_ON_PREMISE is truthy. In the SaaS build the class is never instantiated,
 * so the @Cron is never registered. The runtime `onPrem.enabled` check below is a second layer.
 *
 * @module src/on-prem-updates/on-prem-update-notice.cron
 * @author Prince Jadiya
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { NotificationEmailService } from '../notifications/notification-email.service';
import { OnPremiseTenantService } from '../on-premise/on-premise-tenant.service';
import { OnPremUpdatesService, TERMINAL } from './on-prem-updates.service';
import { claimCronSlot } from '../common/utils/cron-claim';
import type { UpdateState } from './interfaces/update-state.interface';

/** Notification type. `notifications.type` is plain text with no CHECK constraint, so this
 * needs no migration — but it IS registered in notification-email.service.ts, without which
 * the email leg is silently skipped. */
export const SYSTEM_UPDATE_NOTIFICATION_TYPE = 'system_update_available';

/** cron_run_state key for the check itself (a timestamp). */
const CHECK_JOB = 'onprem_update_check';
/** cron_run_state key prefix for "the owners were told about version X" (a claim). */
const NOTICE_JOB_PREFIX = 'onprem_update_notice:';

const CHECK_POLL_MS = 2_000;
const CHECK_TIMEOUT_MS = 90_000;
/** Re-check at most this often, so a restart loop cannot re-run the check on every boot. */
const MIN_CHECK_INTERVAL_MS = 23 * 60 * 60 * 1000;

interface OwnerRow {
  user_id: string;
  users: {
    email: string | null;
    first_name: string | null;
    language: string | null;
  } | null;
}

@Injectable()
export class OnPremUpdateNoticeCron {
  private readonly logger = new Logger(OnPremUpdateNoticeCron.name);

  constructor(
    private readonly config: ConfigService,
    private readonly updates: OnPremUpdatesService,
    private readonly tenant: OnPremiseTenantService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly broadcast: NotificationsBroadcastService,
    private readonly notificationEmail: NotificationEmailService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  private get isOnPremise(): boolean {
    return this.config.get<boolean>('onPrem.enabled') === true;
  }

  /** Daily at 04:15. Offset from the 03:30 file-explorer trash purge so the two do not overlap. */
  @Cron('0 15 4 * * *')
  async notifyIfUpdateAvailable(): Promise<void> {
    if (!this.isOnPremise) return;

    try {
      if (!(await this.claimDailyCheck())) return;

      const state = await this.runCheck();
      if (!state) return;

      if (state.updateAvailable?.any !== true) {
        this.logger.log('daily update check: already on the latest release');
        return;
      }

      const version = this.targetRelease(state);
      if (!version) {
        this.logger.warn(
          'an update is available but the target release is unknown — not notifying',
        );
        return;
      }

      // Claim BEFORE sending. The insert is atomic, so if two API instances wake together
      // exactly one wins and the other silently skips instead of double-mailing every owner.
      if (!(await this.claimVersionNotice(version))) {
        this.logger.debug(`owners already notified about ${version}`);
        return;
      }

      await this.notifyOwners(version, state);
    } catch (err) {
      // A cron must never take the process down. Every failure here is non-fatal by definition:
      // the worst outcome is that the owner finds the update themselves, as they do today.
      this.logger.error(
        `daily update check failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /** True if we have not already checked within the last 23 hours. */
  private async claimDailyCheck(): Promise<boolean> {
    // Atomic, so two replicas waking together cannot both run the check.
    return (
      (await claimCronSlot(this.db, CHECK_JOB, MIN_CHECK_INTERVAL_MS)) !== null
    );
  }

  /**
   * Ask the sidecar to check, then wait for it to finish.
   *
   * POST /check returns 202 immediately — it does not carry the result — so the state has to be
   * polled until it reaches a terminal value. Returns null when the sidecar is unreachable or
   * the check does not settle, so a firewalled or stopped box stays quiet rather than emitting a
   * daily error to the customer's owners.
   */
  private async runCheck(): Promise<UpdateState | null> {
    let state = await this.updates.getStatus();
    if (
      state.updaterReachable === false ||
      state.status === 'deploy_unreachable'
    ) {
      this.logger.warn(
        'daily update check skipped — the update sidecar is unreachable',
      );
      return null;
    }

    await this.updates.check();

    const deadline = Date.now() + CHECK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, CHECK_POLL_MS));
      state = await this.updates.getStatus();
      if (state.updaterReachable === false) {
        this.logger.warn('update sidecar became unreachable mid-check');
        return null;
      }
      if (TERMINAL.has(String(state.status))) return state;
    }
    this.logger.warn(
      `update check did not settle within ${CHECK_TIMEOUT_MS / 1000}s (status=${state.status})`,
    );
    return null;
  }

  /** The version being offered, from targetVersions.release. */
  private targetRelease(state: UpdateState): string | null {
    const target = state.targetVersions;
    const release = target?.release;
    return typeof release === 'string' && release.trim()
      ? release.trim()
      : null;
  }

  /**
   * Claim the right to notify about `version`.
   *
   * INSERT, not upsert: cron_run_state's primary key is job_name, so a duplicate-key error is
   * precisely the signal "someone already told them". It is also atomic, which is the only
   * multi-instance guard available — this codebase has no leader election for crons.
   */
  private async claimVersionNotice(version: string): Promise<boolean> {
    const { error } = await this.db.from('cron_run_state').insert({
      job_name: `${NOTICE_JOB_PREFIX}${version}`,
      last_run_at: new Date().toISOString(),
    });
    if (!error) return true;
    // 23505 = unique_violation. Anything else is a real failure, and we must not notify blindly
    // on an unknown error or a flaky DB turns into a nightly mailshot.
    if (error.code !== '23505') {
      this.logger.error(
        `could not claim the update notice for ${version}: ${error.message}`,
      );
    }
    return false;
  }

  private async notifyOwners(
    version: string,
    state: UpdateState,
  ): Promise<void> {
    const orgId = await this.tenant.resolveOrgId();
    if (!orgId) {
      this.logger.warn(
        'update available but the on-premise organization could not be resolved — set ON_PREMISE_ORG_SLUG in client.conf. No notification sent.',
      );
      return;
    }

    const { data, error } = await this.db
      .from('organization_members')
      .select('user_id,users!inner(email,first_name,language,is_active)')
      .eq('organization_id', orgId)
      .eq('role', 'owner')
      .eq('users.is_active', true);

    if (error) {
      this.logger.error(`could not load organization owners: ${error.message}`);
      return;
    }
    const owners = (data ?? []) as unknown as OwnerRow[];
    if (owners.length === 0) {
      this.logger.warn(
        `no active owners for organization ${orgId} — nobody to notify`,
      );
      return;
    }

    const current =
      (state.currentVersions?.backend?.ref ?? '').split(':').pop() ||
      'the current version';
    const title = `XiSuite ${version} is available`;
    const body = `You are running ${current}. Version ${version} can be installed from Tenant Configuration > System Updates. A database backup is taken automatically and the system rolls back on its own if anything fails.`;

    const rows = owners.map((o) => ({
      organization_id: orgId,
      user_id: o.user_id,
      type: SYSTEM_UPDATE_NOTIFICATION_TYPE,
      title,
      body,
      is_read: false,
      // reference_id is a uuid column, so the version travels in metadata. metadata.link wins
      // outright in notification-link.util.ts, which is how this deep-links without touching it.
      metadata: {
        link: '/tenant-config?tab=system-updates',
        version,
        current_version: current,
      },
    }));

    const { data: inserted, error: insertError } = await this.db
      .from('notifications')
      .insert(rows)
      .select();

    if (insertError) {
      this.logger.error(
        `could not create update notifications: ${insertError.message}`,
      );
      return;
    }

    for (const n of inserted ?? []) {
      void this.broadcast.broadcastNotification(n as Record<string, unknown>);
    }
    void this.notificationEmail.emailForNotifications(
      (inserted ?? []) as Record<string, unknown>[],
    );

    this.logger.log(
      `notified ${owners.length} owner(s) that ${version} is available`,
    );
  }
}
