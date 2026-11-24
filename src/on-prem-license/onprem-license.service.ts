/**
 * @fileoverview On-premise licence state: verifies the stored artifact and
 * answers "is this box entitled right now".
 * @module on-prem-license/onprem-license.service
 *
 * Author: Prince Jadiya
 *
 * THE POLL REFRESHES; THE ARTIFACT ENFORCES.
 * Nothing here asks "did today's poll succeed". If it did, a firewall blip
 * would be an outage and pulling the network cable would be the bypass.
 * Instead the poller renews a signed artifact, and this service enforces that
 * artifact's own signed expiry. The system fails closed on TIME, not on
 * connectivity, which is what makes an offline box eventually lock while a
 * transient outage changes nothing.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { verifyLicenseArtifact } from '../licensing/artifact/license-artifact.crypto';
import type { LicenseArtifactPayload } from '../licensing/artifact/license-artifact.types';
import {
  fingerprintOf,
  generateInstanceKeypair,
  signLicenseRequest,
  type LicenseRequestEnvelope,
} from '../licensing/artifact/license-request';
import type { OnPremEntitlementSnapshot } from '../licensing/entitlements.service';
import {
  OnpremLicenseStateRepository,
  type OnpremLicenseStateRow,
} from './onprem-license-state.repository';
import { setOnPremReadOnly } from './read-only-flag';

/**
 * How far back the clock may honestly drift before it counts as a violation.
 * Generous on purpose: there is no NTP on-prem.
 */
const CLOCK_TOLERANCE_MS = 6 * 60 * 60 * 1000;

/** Consecutive wound-back observations before the box is treated as tampered. */
const CLOCK_VIOLATION_LIMIT = 3;

/**
 * Grace without a valid licence (decision D4): a new box, or one whose licence
 * expired or was refused, keeps full access this long, then goes read-only.
 * PERSISTED (grace_started_at) so a restart cannot reset it; the old grace was
 * measured from process uptime and every restart started it over.
 */
export const GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/** evaluate() runs on every request through the read-only guard; cache it. */
const STATE_CACHE_MS = 30_000;

export type OnpremLockReason =
  | 'never_checked_in'
  | 'artifact_expired'
  | 'artifact_invalid'
  | 'clock_tampered'
  | 'vendor_locked'
  | 'unknown_installation'
  | 'fingerprint_mismatch'
  | 'installation_mismatch';

export interface OnpremLicenseState {
  /** False once the grace is over (or the vendor locked the box). */
  entitled: boolean;
  /** True: writes are refused; only the licence page and sign-in work. */
  readOnly: boolean;
  /** Why the box is not on a valid licence right now (null when it is). */
  reason: OnpremLockReason | null;
  /** The newest artifact whose signature verified for THIS box (may be expired). */
  payload: LicenseArtifactPayload | null;
  expiresAt: string | null;
  /** True while running on grace (no valid licence yet / any more). */
  provisional: boolean;
  /** When the grace ends (null when on a valid licence). */
  graceEndsAt: string | null;
}

export interface OnpremIdentity {
  privatePem: string;
  publicKey: string;
  fingerprint: string;
}

@Injectable()
export class OnpremLicenseStateService {
  private readonly logger = new Logger(OnpremLicenseStateService.name);
  private cached: { at: number; state: OnpremLicenseState } | null = null;

  constructor(
    private readonly repo: OnpremLicenseStateRepository,
    private readonly config: ConfigService,
  ) {}

  /** Drop the cached evaluation (after a licence is accepted). */
  invalidate(): void {
    this.cached = null;
  }

  /** evaluate(), memoised for STATE_CACHE_MS. Used on the request path. */
  async current(): Promise<OnpremLicenseState> {
    if (this.cached && Date.now() - this.cached.at < STATE_CACHE_MS) {
      return this.cached.state;
    }

    const state = await this.evaluate();
    this.cached = { at: Date.now(), state };

    return state;
  }

  /** What the entitlements resolver needs from the signed licence. */
  static snapshotOf(
    payload: LicenseArtifactPayload | null,
  ): OnPremEntitlementSnapshot | null {
    if (!payload || payload.status !== 'active') return null;

    return { features: payload.features ?? {}, limits: payload.limits ?? {} };
  }

  /**
   * This box's identity keypair, generated and stored on first use. Its
   * fingerprint is what the cloud binds every licence to.
   */
  async identity(
    state?: OnpremLicenseStateRow | null,
  ): Promise<OnpremIdentity> {
    const row = state === undefined ? await this.repo.get() : state;

    if (row?.instance_private_key && row.instance_public_key) {
      return {
        privatePem: row.instance_private_key,
        publicKey: row.instance_public_key,
        fingerprint: fingerprintOf(row.instance_public_key),
      };
    }

    const created = generateInstanceKeypair();
    await this.repo.patch({
      instance_private_key: created.privatePem,
      instance_public_key: created.publicKey,
    });
    this.logger.log(
      `on-prem instance identity created (${created.fingerprint.slice(0, 12)}…)`,
    );

    return created;
  }

  /**
   * The authoritative answer for enforcement.
   *
   * Re-verifies the signature on every call rather than trusting the `status`
   * column beside it. The customer owns this database, so a derived column is
   * only a cache; the signature is the fact. There is NO "unconfigured means
   * unlimited" path any more: a box without a valid licence runs on the 14-day
   * grace and then goes read-only.
   */
  async evaluate(now = new Date()): Promise<OnpremLicenseState> {
    const state = await this.repo.get();
    const id = await this.identity(state);

    if (state?.max_observed_at || state?.artifact) {
      const clock = await this.repo.observeClock(now, CLOCK_TOLERANCE_MS);

      if (clock.woundBack && clock.violations >= CLOCK_VIOLATION_LIMIT) {
        return this.publish({
          entitled: false,
          readOnly: true,
          reason: 'clock_tampered',
          payload: null,
          expiresAt: state?.expires_at ?? null,
          provisional: false,
          graceEndsAt: null,
        });
      }
    }

    const checked = this.checkArtifact(state, id.fingerprint, now);

    // A valid, current, vendor-signed licence for THIS box.
    if (checked.payload && !checked.expired) {
      if (checked.payload.status === 'active') {
        if (state?.grace_started_at || state?.read_only_since) {
          await this.repo.patch({
            grace_started_at: null,
            read_only_since: null,
          });
        }

        return this.publish({
          entitled: true,
          readOnly: false,
          reason: null,
          payload: checked.payload,
          expiresAt: checked.payload.expiresAt,
          provisional: false,
          graceEndsAt: null,
        });
      }

      // A signed "locked" is the vendor's decision (licence cancelled or the
      // installation deactivated): no grace, read-only at once.
      if (checked.payload.status === 'locked') {
        return this.publish({
          entitled: false,
          readOnly: true,
          reason: 'vendor_locked',
          payload: checked.payload,
          expiresAt: checked.payload.expiresAt,
          provisional: false,
          graceEndsAt: null,
        });
      }
    }

    // No valid licence: grace, then read-only. The grace clock starts when the
    // licence expired (if we had one), otherwise now, and is persisted.
    const graceStart = state?.grace_started_at
      ? Date.parse(state.grace_started_at)
      : checked.expired && checked.payload
        ? Math.min(Date.parse(checked.payload.expiresAt), now.getTime())
        : now.getTime();

    if (!state?.grace_started_at) {
      await this.repo.patch({
        grace_started_at: new Date(graceStart).toISOString(),
      });
    }

    const graceEnds = graceStart + GRACE_MS;
    const inGrace = now.getTime() < graceEnds;

    if (!inGrace && !state?.read_only_since) {
      await this.repo.patch({ read_only_since: now.toISOString() });
      this.logger.warn(
        'on-prem licence grace is over: the box is now read-only',
      );
    }

    return this.publish({
      entitled: inGrace,
      readOnly: !inGrace,
      reason: checked.reason,
      // Keep what the last good licence granted (features stay visible).
      payload: checked.payload,
      expiresAt: checked.payload?.expiresAt ?? state?.expires_at ?? null,
      provisional: inGrace,
      graceEndsAt: new Date(graceEnds).toISOString(),
    });
  }

  /**
   * Builds the signed licence-request file an air-gapped box exports, and
   * remembers its nonce so only the matching licence file can be imported.
   */
  async buildRequest(now = new Date()): Promise<LicenseRequestEnvelope> {
    const state = await this.repo.get();
    const id = await this.identity(state);
    const orgId = this.config.get<string>('onPrem.orgId') || null;
    const usage = await this.repo.countUsage(orgId);
    const nonce = randomBytes(24).toString('base64url');
    const release = this.config.get<string>('onPrem.release') || null;

    await this.repo.patch({ pending_nonce: nonce });

    return signLicenseRequest(
      {
        v: 1,
        kind: 'license-request',
        installationId: state?.installation_id ?? null,
        fingerprint: id.fingerprint,
        publicKey: id.publicKey,
        usage: { ...usage, version: release },
        nonce,
        createdAt: now.toISOString(),
        release,
      },
      id.privatePem,
    );
  }

  /**
   * True when this deployment should poll at the accelerated 6-hourly cadence:
   * on the expiry date, or while not on a valid licence. Otherwise daily.
   */
  async needsFastCadence(now = new Date()): Promise<boolean> {
    const state = await this.evaluate(now);

    if (state.provisional || state.readOnly) return true;
    if (!state.expiresAt) return false;

    return Date.parse(state.expiresAt) - now.getTime() <= 24 * 60 * 60 * 1000;
  }

  /**
   * Verifies the stored artifact and that it belongs to this box. An expired
   * artifact is re-verified at its own expiry instant, so a genuine-but-expired
   * licence still yields its (signature-checked) payload for the grace period.
   */
  checkArtifact(
    state: OnpremLicenseStateRow | null,
    fingerprint: string,
    now: Date,
  ): {
    payload: LicenseArtifactPayload | null;
    expired: boolean;
    reason: OnpremLockReason | null;
  } {
    if (!state?.artifact) {
      return { payload: null, expired: false, reason: 'never_checked_in' };
    }

    let result = verifyLicenseArtifact(state.artifact, { now });
    let expired = false;

    if (!result.ok && result.reason === 'expired' && state.expires_at) {
      result = verifyLicenseArtifact(state.artifact, {
        now: new Date(Date.parse(state.expires_at) - 1000),
      });
      expired = result.ok;
    }

    if (!result.ok) {
      return { payload: null, expired: false, reason: 'artifact_invalid' };
    }

    const mismatch = this.identityMismatch(result.payload, state, fingerprint);

    if (mismatch) return { payload: null, expired: false, reason: mismatch };

    if (result.payload.status === 'unknown') {
      return { payload: null, expired: false, reason: 'unknown_installation' };
    }

    return {
      payload: result.payload,
      expired,
      reason: expired ? 'artifact_expired' : null,
    };
  }

  /** A licence for another box / installation / org is not a licence here. */
  identityMismatch(
    payload: LicenseArtifactPayload,
    state: Pick<OnpremLicenseStateRow, 'installation_id'> | null,
    fingerprint: string,
  ): OnpremLockReason | null {
    if (payload.status === 'unknown') return null;
    if (payload.fingerprint !== fingerprint) return 'fingerprint_mismatch';
    if (
      state?.installation_id &&
      payload.installationId !== state.installation_id
    ) {
      return 'installation_mismatch';
    }

    // Deliberately NOT compared with ON_PREMISE_ORG_ID: payload.organizationId
    // is the customer's CLOUD tenant, while ON_PREMISE_ORG_ID is the box's own
    // local org, created independently, so the two never match on an existing
    // install. The licence is bound to this box by the secret activation code,
    // the fingerprint (pinned on first check-in) and the installation id above.
    return null;
  }

  private publish(state: OnpremLicenseState): OnpremLicenseState {
    setOnPremReadOnly(state.readOnly);

    return state;
  }
}
