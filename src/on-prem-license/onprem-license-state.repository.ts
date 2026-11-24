/**
 * @fileoverview Single-row store for the on-premise licence artifact and the
 * clock high-water mark.
 * @module on-prem-license/onprem-license-state.repository
 *
 * Author: Prince Jadiya
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { LicenseArtifactEnvelope } from '../licensing/artifact/license-artifact.types';

export interface OnpremLicenseStateRow {
  id: number;
  artifact: LicenseArtifactEnvelope | null;
  status: string | null;
  issued_at: string | null;
  expires_at: string | null;
  verified_at: string | null;
  pending_nonce: string | null;
  max_observed_at: string | null;
  clock_violations: number;
  last_logged_state: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
  /** Cloud installation this box is bound to (set on first accepted licence). */
  installation_id: string | null;
  /** This box's identity keypair (Ed25519). Generated on first start. */
  instance_private_key: string | null;
  instance_public_key: string | null;
  /** When the box started running without a valid licence (persisted grace). */
  grace_started_at: string | null;
  /** When the grace ran out and the box went read-only. */
  read_only_since: string | null;
}

const TABLE = 'onprem_license_state';
const ROW_ID = 1;

@Injectable()
export class OnpremLicenseStateRepository {
  private readonly logger = new Logger(OnpremLicenseStateRepository.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Reads the single state row, or null when the box has never checked in.
   *
   * Never throws: enforcement calls this on every request via the entitlements
   * resolver, and a transient database blip must not 500 the whole application.
   * A read failure is reported as "no state", which the caller treats as locked
   * only after the first-boot grace window has passed.
   */
  async get(): Promise<OnpremLicenseStateRow | null> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('id', ROW_ID)
      .maybeSingle();

    if (error) {
      this.logger.warn(`could not read licence state: ${error.message}`);

      return null;
    }

    return (data as OnpremLicenseStateRow | null) ?? null;
  }

  /** Upsert of the fixed row. Partial patches are merged server-side. */
  async patch(patch: Partial<OnpremLicenseStateRow>): Promise<void> {
    const { error } = await this.client
      .from(TABLE)
      .upsert(
        { id: ROW_ID, ...patch, updated_at: new Date().toISOString() },
        { onConflict: 'id' },
      );

    if (error) {
      this.logger.warn(`could not write licence state: ${error.message}`);
    }
  }

  /**
   * Users on this box, for the usage report sent to the cloud. Active = the
   * user account is active (same rule as SaaS seat counting). Counts the
   * on-prem org when configured, else every membership on the box.
   */
  async countUsage(
    orgId: string | null,
  ): Promise<{ activeUsers: number; totalUsers: number }> {
    const base = () => {
      const q = this.client
        .from('organization_members')
        .select('id, users!inner(is_active)', { count: 'exact', head: true });

      return orgId ? q.eq('organization_id', orgId) : q;
    };
    const [active, total] = await Promise.all([
      base().eq('users.is_active', true),
      base(),
    ]);

    return { activeUsers: active.count ?? 0, totalUsers: total.count ?? 0 };
  }

  /**
   * Advances the clock high-water mark, and reports whether the current time
   * looks wound back.
   *
   * `toleranceMs` exists because there is no NTP on an on-prem box: a VM
   * resuming from a snapshot or a dead RTC produces honest backwards drift.
   * Locking on the first observation would punish that, so the caller pairs
   * this with a violation counter and only acts on a sustained pattern.
   */
  async observeClock(
    now: Date,
    toleranceMs: number,
  ): Promise<{ woundBack: boolean; violations: number }> {
    const state = await this.get();
    const high = state?.max_observed_at
      ? Date.parse(state.max_observed_at)
      : null;

    if (high !== null && now.getTime() < high - toleranceMs) {
      const violations = (state?.clock_violations ?? 0) + 1;

      // Deliberately does NOT advance the mark: a wound-back clock must not be
      // able to lower the bar it is being measured against.
      await this.patch({ clock_violations: violations });

      return { woundBack: true, violations };
    }

    if (high === null || now.getTime() > high) {
      await this.patch({
        max_observed_at: now.toISOString(),
        clock_violations: 0,
      });
    }

    return { woundBack: false, violations: 0 };
  }
}
