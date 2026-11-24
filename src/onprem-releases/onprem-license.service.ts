/**
 * @fileoverview SaaS side of on-premise licensing: turns an activation code into
 * a signed licence artifact.
 * @module onprem-releases/onprem-license.service
 *
 * Author: Prince Jadiya
 *
 * This runs on the SaaS deployment only, in the sense that it is the endpoint an
 * on-prem box calls out to. It is registered unconditionally (like the release
 * manifest beside it) because a box must be able to reach it, and a SaaS install
 * is where the licence actually lives.
 *
 * It deliberately reuses `EntitlementsService` rather than reading licence rows
 * itself, so an on-prem box is entitled to exactly what the same tenant would
 * get on SaaS. One resolver, one answer, no drift.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { EntitlementsService } from '../licensing/entitlements.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  signLicenseArtifact,
  TRUSTED_PUBLIC_KEYS,
} from '../licensing/artifact/license-artifact.crypto';
import {
  fingerprintOf,
  verifyLicenseRequest,
  type OnpremUsage,
} from '../licensing/artifact/license-request';
import type {
  LicenseArtifactEnvelope,
  LicenseArtifactPayload,
  LicenseArtifactStatus,
} from '../licensing/artifact/license-artifact.types';

/** Connected boxes: the signed expiry IS the offline grace (renewed daily). */
const CONNECTED_TTL_DAYS = 30;

/** Air-gapped licence files (decision D3): 90 days per request/response. */
export const OFFLINE_TTL_DAYS = 90;

/** Installation row shape, narrowed to what issuing needs. */
interface InstallationRow {
  id: string;
  /** The PARTNER org that sold the install (null = direct XISUITE customer). */
  organization_id: string | null;
  organization_license_id: string;
  status: string;
  mode: string;
  instance_fingerprint: string | null;
  metadata: Record<string, unknown> | null;
  /** The licence the box runs on; its organization_id is the CUSTOMER org. */
  organization_licenses: {
    organization_id: string;
    deployment_type: string | null;
  } | null;
}

const INSTALL_COLUMNS =
  'id, organization_id, organization_license_id, status, mode, instance_fingerprint, metadata, organization_licenses(organization_id, deployment_type)';

export interface IssueRequest {
  activationCode: string;
  nonce: string | null;
  release: string | null;
  hostInfo: Record<string, unknown> | null;
  installationId?: string | null;
  fingerprint?: string | null;
  publicKey?: string | null;
  usage?: OnpremUsage | null;
}

/** sha256 hex of an activation code: the only form new codes are stored in. */
export function hashActivationCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Accepts the signing key the way secret stores and .env files actually deliver
 * it: a PKCS#8 PEM, the same with literal "\n" escapes or wrapping quotes, or
 * just the base64 body on one line. Returns a PEM only for an Ed25519 key.
 */
export function normalizeSigningKeyPem(raw: string): string | null {
  let pem = raw
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, '$2')
    .replace(/\\n/g, '\n')
    .trim();

  if (!pem.includes('-----BEGIN')) {
    pem = `-----BEGIN PRIVATE KEY-----\n${pem.replace(/\s+/g, '')}\n-----END PRIVATE KEY-----\n`;
  }

  try {
    const key = createPrivateKey(pem);

    return key.asymmetricKeyType === 'ed25519'
      ? key.export({ type: 'pkcs8', format: 'pem' }).toString()
      : null;
  } catch {
    return null;
  }
}

@Injectable()
export class OnpremLicenseService {
  private readonly logger = new Logger(OnpremLicenseService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly entitlements: EntitlementsService,
    private readonly config: ConfigService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private signingKeyCache:
    | { raw: string; kid: string; key: { pem: string; kid: string } | null }
    | undefined;

  private signingKey(): { pem: string; kid: string } | null {
    const raw = this.config.get<string>('onPremLicense.signingKeyPem') || '';
    const kid = this.config.get<string>('onPremLicense.signingKeyId') || '';
    const cached = this.signingKeyCache;

    if (cached && cached.raw === raw && cached.kid === kid) return cached.key;

    const pem = raw && kid ? normalizeSigningKeyPem(raw) : null;

    if (raw && kid && !pem) {
      // Logged once per value, not per check-in. A broken key must not throw
      // inside issue(): that would surface as a 500 the box treats as an outage.
      this.logger.error(
        'ONPREM_LICENSE_SIGNING_KEY is set but is not a valid Ed25519 private key; refusing to issue',
      );
    }

    const key = pem ? { pem, kid } : null;

    this.signingKeyCache = { raw, kid, key };

    return key;
  }

  /**
   * For the super admin page: can this deployment issue licences, and will
   * the current on-prem build accept them? `trusted` is false when the key's
   * public half is not the compiled-in key for its kid, i.e. every box would
   * reject the artifact as `unknown_key` / `bad_signature`.
   */
  signingStatus(): {
    configured: boolean;
    keyId: string | null;
    trusted: boolean;
  } {
    const key = this.signingKey();

    if (!key) return { configured: false, keyId: null, trusted: false };

    const publicDer = createPublicKey(createPrivateKey(key.pem))
      .export({ type: 'spki', format: 'der' })
      .toString('base64');

    return {
      configured: true,
      keyId: key.kid,
      trusted: TRUSTED_PUBLIC_KEYS[key.kid] === publicDer,
    };
  }

  /**
   * Connected check-in: turns an activation code into a signed artifact.
   *
   * An unrecognised code still gets a SIGNED artifact, with status `unknown`.
   * That matters: if we returned a bare 404, an attacker could suppress a
   * "locked" answer simply by blocking the response, and the box would be unable
   * to tell "vendor says you are not licensed" from "the network is down". A
   * signed negative is an assertion the box can act on immediately.
   */
  async issue(req: IssueRequest): Promise<LicenseArtifactEnvelope | null> {
    const key = this.signingKey();

    if (!key) {
      // Fail loudly in logs but do NOT fabricate an unsigned artifact: an
      // unsigned answer is worthless to the verifier and would look like a
      // transport failure, which is the correct thing for the box to see.
      this.logger.error(
        'on-prem licence signing key is not configured; refusing to issue',
      );

      return null;
    }

    const install = await this.findByCode(req.activationCode);

    if (!install) {
      return signLicenseArtifact(
        this.buildUnknownPayload(req),
        key.pem,
        key.kid,
      );
    }

    const fingerprint = await this.bindFingerprint(
      install,
      req.fingerprint ?? null,
      req.publicKey ?? null,
    );
    const payload = await this.buildPayloadForInstall(install, {
      nonce: req.nonce,
      release: req.release,
      fingerprint,
      ttlDays: this.connectedTtl(install),
    });

    // Only the server this installation is bound to may update its check-in,
    // version and usage. A second box replaying the code still gets an answer
    // (bound to the first box, so it refuses it) but must not overwrite the
    // real server's row and billing usage.
    if (fingerprint && req.fingerprint !== fingerprint) {
      return signLicenseArtifact(payload, key.pem, key.kid);
    }

    // Best-effort telemetry. A failure here must never block issuing, or a
    // transient write error would lock a paying customer out.
    void this.recordCheckIn(install.id, {
      release: req.release,
      hostInfo: req.hostInfo,
      usage: req.usage ?? null,
      source: 'poll',
      expiresAt: payload.expiresAt,
    }).catch((err: Error) =>
      this.logger.warn(`check-in write failed: ${err.message}`),
    );

    return signLicenseArtifact(payload, key.pem, key.kid);
  }

  /**
   * Air-gapped activation: answers a box's signed licence-request file with a
   * 90-day licence file bound to that box (fingerprint) and that request
   * (nonce). The caller must already have checked that the installation is in
   * scope (its partner, or a super admin).
   */
  async issueOffline(
    install: { id: string },
    requestEnvelope: unknown,
  ): Promise<LicenseArtifactEnvelope> {
    const key = this.signingKey();

    if (!key) {
      throw new BadRequestException(
        'Licence signing is not configured on this server',
      );
    }

    const verified = verifyLicenseRequest(requestEnvelope, new Date());

    if (!verified.ok) {
      throw new BadRequestException(
        `Invalid licence request file (${verified.reason})`,
      );
    }

    const row = await this.findById(install.id);

    if (!row) throw new NotFoundException('Installation not found');

    const request = verified.body;

    if (request.installationId && request.installationId !== row.id) {
      throw new BadRequestException(
        'This request file was created by a box bound to a different installation',
      );
    }

    const fingerprint = await this.bindFingerprint(
      row,
      request.fingerprint,
      request.publicKey,
    );

    if (fingerprint !== request.fingerprint) {
      throw new BadRequestException(
        'This installation is bound to a different box. Reset its fingerprint first if the server was replaced.',
      );
    }

    const payload = await this.buildPayloadForInstall(row, {
      nonce: request.nonce,
      release: request.release,
      fingerprint,
      ttlDays: OFFLINE_TTL_DAYS,
    });

    await this.recordCheckIn(row.id, {
      release: request.release,
      hostInfo: null,
      usage: request.usage,
      source: 'offline',
      expiresAt: payload.expiresAt,
    });

    return signLicenseArtifact(payload, key.pem, key.kid);
  }

  /**
   * Release gating: may this activation code download updates? Unknown and
   * deactivated installations may not.
   */
  async isActivationCodeLive(code: string): Promise<boolean> {
    const install = await this.findByCode(code);

    return (
      !!install && (install.status === 'active' || install.status === 'pending')
    );
  }

  private async findByCode(code: string): Promise<InstallationRow | null> {
    // New installs store only sha256(code); older rows still carry the code.
    const { data, error } = await this.client
      .from('partner_onprem_installations')
      .select(INSTALL_COLUMNS)
      .or(
        `activation_code_hash.eq.${hashActivationCode(code)},activation_code.eq.${code.replace(/[^A-Za-z0-9-]/g, '')}`,
      )
      .limit(1)
      .maybeSingle();

    if (error) {
      this.logger.warn(`installation lookup failed: ${error.message}`);

      return null;
    }

    return (data as InstallationRow | null) ?? null;
  }

  private async findById(id: string): Promise<InstallationRow | null> {
    const { data, error } = await this.client
      .from('partner_onprem_installations')
      .select(INSTALL_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error) {
      this.logger.warn(`installation lookup failed: ${error.message}`);

      return null;
    }

    return (data as InstallationRow | null) ?? null;
  }

  /**
   * Trust on first use. The first box to present a (self-consistent) key is
   * recorded; a different box later presenting the same activation code gets
   * the RECORDED fingerprint back, so its own copy of the licence is refused.
   * Returns the fingerprint the licence must be bound to (null: legacy box
   * that sent no identity).
   */
  private async bindFingerprint(
    install: InstallationRow,
    fingerprint: string | null,
    publicKey: string | null,
  ): Promise<string | null> {
    const consistent =
      !!fingerprint && !!publicKey && fingerprintOf(publicKey) === fingerprint;

    if (!consistent) return install.instance_fingerprint;

    if (!install.instance_fingerprint) {
      const { error } = await this.client
        .from('partner_onprem_installations')
        .update({ instance_fingerprint: fingerprint })
        .eq('id', install.id)
        .is('instance_fingerprint', null);

      if (error) {
        this.logger.warn(`fingerprint bind failed: ${error.message}`);
      }
      install.instance_fingerprint = fingerprint;

      return fingerprint;
    }

    if (install.instance_fingerprint !== fingerprint) {
      this.logger.warn(
        `install ${install.id}: check-in from a different box (fingerprint mismatch)`,
      );
    }

    return install.instance_fingerprint;
  }

  private async buildPayloadForInstall(
    install: InstallationRow,
    opts: {
      nonce: string | null;
      release: string | null;
      fingerprint: string | null;
      ttlDays: number;
    },
  ): Promise<LicenseArtifactPayload> {
    // The box is licensed as the CUSTOMER org that owns the licence row, not as
    // the partner that sold it (install.organization_id). Signing the partner's
    // entitlements would hand the customer the partner's plan.
    const customerOrgId =
      install.organization_licenses?.organization_id ?? null;
    const window = this.window(opts.ttlDays);
    const base = {
      v: 1 as const,
      installationId: install.id,
      nonce: opts.nonce,
      release: opts.release,
      fingerprint: opts.fingerprint,
      ...window,
    };

    if (!customerOrgId) {
      this.logger.warn(
        `install ${install.id} has no licence row; issuing a locked artifact`,
      );

      return {
        ...base,
        organizationId: '',
        planKey: null,
        status: 'locked',
        features: {},
        limits: {},
      };
    }

    if (install.organization_licenses?.deployment_type !== 'onprem') {
      this.logger.warn(
        `install ${install.id} runs on a non-onprem licence (${install.organization_licenses?.deployment_type ?? 'null'})`,
      );
    }

    const ent = await this.entitlements.getEffectiveEntitlements(customerOrgId);
    const snapshot = EntitlementsService.toSnapshot(ent);

    // An installation an operator has deactivated is locked regardless of what
    // the licence says, so a revoked box can be shut off without touching the
    // tenant's SaaS subscription.
    const installInactive =
      install.status === 'inactive' || install.status === 'expired';

    // `grandfathered` means "never had a licence" and is the SaaS rollout
    // posture, not an on-prem one. A box must never inherit unlimited access
    // from it, so it is treated as locked here.
    const locked =
      installInactive ||
      ent.grandfathered ||
      ent.licenseStatus === 'cancelled' ||
      ent.licenseStatus === 'expired';

    const status: LicenseArtifactStatus = locked ? 'locked' : 'active';

    // A `pending` install becomes `active` on its first successful check-in.
    // Locking `pending` would make it impossible for a new box to ever activate.
    if (install.status === 'pending' && status === 'active') {
      await this.activateInstall(install.id);
    }

    return {
      ...base,
      organizationId: customerOrgId,
      planKey: locked
        ? null
        : await this.planKeyFor(install.organization_license_id),
      status,
      features: locked ? {} : (snapshot?.features ?? {}),
      limits: locked ? {} : (snapshot?.limits ?? {}),
    };
  }

  /**
   * The plan key in force, for display on the box. Informational only: nothing
   * is enforced from it, so a lookup failure degrades to null rather than
   * failing the issue.
   */
  private async planKeyFor(licenseId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('organization_licenses')
      .select('license_plans(plan_key)')
      .eq('id', licenseId)
      .maybeSingle();

    if (error) return null;

    const plans = (data as { license_plans?: { plan_key?: string } } | null)
      ?.license_plans;

    return plans?.plan_key ?? null;
  }

  private buildUnknownPayload(req: IssueRequest): LicenseArtifactPayload {
    return {
      v: 1,
      installationId: '',
      organizationId: '',
      planKey: null,
      status: 'unknown',
      features: {},
      limits: {},
      ...this.window(CONNECTED_TTL_DAYS),
      nonce: req.nonce,
      release: req.release,
      fingerprint: req.fingerprint ?? null,
    };
  }

  /** Connected TTL, tunable per install via metadata.ttlDays (1..90). */
  private connectedTtl(install: InstallationRow): number {
    const raw = install.metadata?.['ttlDays'];

    return typeof raw === 'number' && raw >= 1 && raw <= 90
      ? raw
      : CONNECTED_TTL_DAYS;
  }

  /**
   * The signed validity window. `expiresAt` IS the grace period: how long the
   * box may run offline before it starts its own 14-day grace and then goes
   * read-only. Kept inside the signature and chosen server-side.
   */
  private window(ttlDays: number): { issuedAt: string; expiresAt: string } {
    const now = Date.now();

    return {
      // Backdated by a minute so honest clock skew on the customer's box does
      // not make a freshly issued artifact look `not_yet_valid`. There is no
      // NTP on-prem, so small drift is normal rather than suspicious.
      issuedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + ttlDays * 86_400_000).toISOString(),
    };
  }

  private async activateInstall(installationId: string): Promise<void> {
    const { error } = await this.client
      .from('partner_onprem_installations')
      .update({ status: 'active', activated_at: new Date().toISOString() })
      .eq('id', installationId)
      .eq('status', 'pending');

    if (error) {
      // Not fatal: the artifact is still issued; the next check-in retries.
      this.logger.warn(`install activation failed: ${error.message}`);
    }
  }

  /** Heartbeat + usage report (connected poll or offline request file). */
  private async recordCheckIn(
    installationId: string,
    info: {
      release: string | null;
      hostInfo: Record<string, unknown> | null;
      usage: OnpremUsage | null;
      source: 'poll' | 'offline';
      expiresAt: string;
    },
  ): Promise<void> {
    await this.client
      .from('partner_onprem_installations')
      .update({
        last_heartbeat_at: new Date().toISOString(),
        last_seen_version: info.release,
        ...(info.hostInfo ? { host_info: info.hostInfo } : {}),
        ...(info.usage ? { last_usage: info.usage } : {}),
        license_expires_at: info.expiresAt,
      })
      .eq('id', installationId);

    if (info.usage) {
      await this.client.from('onprem_usage_reports').insert({
        installation_id: installationId,
        active_users: info.usage.activeUsers,
        total_users: info.usage.totalUsers,
        version: info.usage.version ?? info.release,
        source: info.source,
        raw: info.usage,
      });
    }
  }
}
