/**
 * @fileoverview Polls the vendor for this deployment's licence and stores the
 * signed artifact.
 * @module on-prem-license/onprem-license-poll.service
 *
 * Author: Prince Jadiya
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { verifyLicenseArtifact } from '../licensing/artifact/license-artifact.crypto';
import { EntitlementsService } from '../licensing/entitlements.service';
import { OnpremLicenseStateRepository } from './onprem-license-state.repository';
import { OnpremLicenseStateService } from './onprem-license.service';

/** Matches the sidecar client next door; a licence check is not worth longer. */
const TIMEOUT_MS = 15_000;

export type PollOutcome =
  | 'updated'
  | 'unreachable'
  | 'rejected'
  | 'not_configured';

export interface PollResult {
  outcome: PollOutcome;
  /** Present when the artifact verified. */
  status?: string;
  detail?: string;
}

@Injectable()
export class OnpremLicensePollService {
  private readonly logger = new Logger(OnpremLicensePollService.name);

  constructor(
    private readonly repo: OnpremLicenseStateRepository,
    private readonly config: ConfigService,
    private readonly entitlements: EntitlementsService,
    private readonly stateService: OnpremLicenseStateService,
  ) {}

  /**
   * One poll cycle. Never throws: it runs from a cron and from a user-facing
   * button, and neither may take the process down or surface a stack trace.
   *
   * A failed poll deliberately leaves the previously stored artifact intact.
   * The box keeps running on it until its signed expiry, which is what makes a
   * network outage a non-event and an extended one an eventual lock.
   */
  async poll(): Promise<PollResult> {
    const url = this.config.get<string>('onPrem.licenseApiUrl');
    const activationCode = this.config.get<string>(
      'onPrem.licenseActivationCode',
    );

    if (!url || !activationCode) {
      // Correct and expected for a fully air-gapped install, which activates
      // from an imported file instead of polling.
      return { outcome: 'not_configured' };
    }

    // Freshness proof. Generated here, echoed inside the signature, and checked
    // on receipt: without it a captured valid response could be re-served
    // forever by a customer who controls DNS.
    const nonce = randomBytes(24).toString('base64url');
    const state = await this.repo.get();
    const id = await this.stateService.identity(state);
    const release = this.config.get<string>('onPrem.release') || null;
    const usage = await this.repo.countUsage(
      this.config.get<string>('onPrem.orgId') || null,
    );

    // The poll's nonce stays in memory: it is verified a few lines below. It
    // must NOT go into pending_nonce, which belongs to an exported offline
    // request; overwriting it made that request's licence file fail
    // `nonce_mismatch` and showed "a licence request was exported" after any
    // failed check-in.
    await this.repo.patch({ last_attempt_at: new Date().toISOString() });

    let body: unknown;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          activationCode,
          nonce,
          release,
          hostInfo: { hostname: hostname() },
          // Identity + usage (cloud-linked licensing): the cloud binds the
          // licence to this fingerprint and records usage for billing.
          installationId: state?.installation_id ?? null,
          fingerprint: id.fingerprint,
          publicKey: id.publicKey,
          usage: { ...usage, version: release },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        await this.repo.patch({ last_error: `HTTP ${res.status}` });

        return { outcome: 'unreachable', detail: `HTTP ${res.status}` };
      }

      body = await res.json();
    } catch (err) {
      // undici reports every network failure as "fetch failed"; the cause code
      // (ENOTFOUND, ECONNREFUSED, CERT_HAS_EXPIRED...) is what an admin needs.
      const cause = (err as { cause?: { code?: string } })?.cause?.code;
      const message = err instanceof Error ? err.message : String(err);
      const detail = cause ? `${message} (${cause})` : message;
      await this.repo.patch({ last_error: detail });

      return { outcome: 'unreachable', detail };
    }

    // The backend wraps every response in {statusCode, hasError, data, message}.
    // Accept both shapes, exactly as update-agent.sh had to.
    const envelope =
      (body as { data?: unknown })?.data !== undefined
        ? (body as { data: unknown }).data
        : body;

    if (envelope == null) {
      // The vendor answered but issued nothing: its signing key is missing or
      // broken. Not the box's fault, so say so instead of "malformed".
      await this.repo.patch({ last_error: 'vendor_not_configured' });

      return { outcome: 'rejected', detail: 'vendor_not_configured' };
    }

    return this.acceptArtifact(envelope, nonce);
  }

  /**
   * Verifies and stores an artifact. Shared by the poll path and the manual
   * file-import path, which is why the nonce is a parameter rather than read
   * from state: an imported file has none to echo.
   */
  async acceptArtifact(
    envelope: unknown,
    expectedNonce: string | null,
    source: 'poll' | 'import' = 'poll',
  ): Promise<PollResult> {
    const now = new Date();
    // last_error describes the last CHECK-IN (shown next to last_attempt_at).
    // A refused file import answers its own request and must not pose as one.
    const recordRefusal = (reason: string) =>
      source === 'poll'
        ? this.repo.patch({ last_error: `rejected: ${reason}` })
        : Promise.resolve();
    const result = verifyLicenseArtifact(envelope, {
      now,
      expectedNonce,
    });

    if (!result.ok) {
      await recordRefusal(result.reason);
      this.logger.warn(`licence artifact rejected: ${result.reason}`);

      return { outcome: 'rejected', detail: result.reason };
    }

    const { payload } = result;

    // A licence issued for another box, installation or org is refused even
    // though its signature is genuine: licence files must not be portable.
    const state = await this.repo.get();
    const id = await this.stateService.identity(state);
    const mismatch = this.stateService.identityMismatch(
      payload,
      state,
      id.fingerprint,
    );

    if (mismatch) {
      await recordRefusal(mismatch);
      this.logger.warn(`licence artifact rejected: ${mismatch}`);

      return { outcome: 'rejected', detail: mismatch };
    }

    // No downgrades: a licence issued BEFORE the one already stored is refused.
    // Otherwise an old, still-unexpired offline file could be re-imported to
    // undo a newer answer, e.g. after the vendor deactivated this server.
    // Equal timestamps (re-importing the same file) stay harmless no-ops.
    if (
      state?.artifact &&
      state.issued_at &&
      Date.parse(payload.issuedAt) < Date.parse(state.issued_at)
    ) {
      await recordRefusal('superseded');
      this.logger.warn('licence artifact rejected: superseded');

      return { outcome: 'rejected', detail: 'superseded' };
    }

    await this.repo.patch({
      artifact: envelope as never,
      // Bind to the installation on the first accepted licence.
      ...(payload.installationId && !state?.installation_id
        ? { installation_id: payload.installationId }
        : {}),
      status: payload.status,
      issued_at: payload.issuedAt,
      expires_at: payload.expiresAt,
      verified_at: now.toISOString(),
      pending_nonce: null,
      last_error: null,
    });

    // The tenant's entitlements are cached for 30s in-process; bust so a lock or
    // an unlock takes effect on the next request rather than up to half a minute
    // later.
    this.stateService.invalidate();
    this.entitlements.bustAll();

    await this.logStateChange(payload.status);

    return { outcome: 'updated', status: payload.status };
  }

  /**
   * Requirement: log on the first check and on state CHANGES only, never on
   * every poll. A daily heartbeat that logged unconditionally would bury the
   * one transition an operator actually needs to see.
   */
  private async logStateChange(status: string): Promise<void> {
    const state = await this.repo.get();

    if (state?.last_logged_state === status) return;

    const first = !state?.last_logged_state;

    this.logger.log(
      first
        ? `on-prem licence: initial state ${status}`
        : `on-prem licence: state changed ${state?.last_logged_state} to ${status}`,
    );

    await this.repo.patch({ last_logged_state: status });
  }
}
