/**
 * @fileoverview Wire format for the signed licence artifact that carries a
 * tenant's entitlements from SaaS to an on-premise deployment.
 * @module licensing/artifact/license-artifact.types
 *
 * Author: Prince Jadiya
 *
 * ONE FORMAT, TWO TRANSPORTS
 * The same bytes are produced by the SaaS endpoint and consumed by the on-prem
 * verifier, whether they arrived over HTTPS (the daily poll) or on a USB stick
 * (a fully air-gapped install). There is deliberately no second code path: a
 * manual import is the identical artifact, so it cannot rot separately.
 *
 * WHY A SIGNED ARTIFACT RATHER THAN A LIVE API ANSWER
 * The on-prem customer owns the host, the database, the clock and the network.
 * Enforcement therefore cannot ask "did today's poll succeed?" - a firewall blip
 * would be an outage and pulling the network cable would be the bypass. Instead
 * the poll REFRESHES this artifact and the artifact's own `expiresAt` ENFORCES.
 * The system fails closed on time, not on connectivity.
 */

/** Statuses the SaaS side can assert about a deployment's licence. */
export type LicenseArtifactStatus =
  /** Entitled. Apply `features` / `limits` as given. */
  | 'active'
  /** Known deployment, but the licence is cancelled, expired or lapsed. */
  | 'locked'
  /** The activation code is not recognised at all. */
  | 'unknown';

/**
 * The signed payload. Every field here is covered by the signature, so none of
 * it can be edited on the customer's box without invalidating the artifact.
 */
export interface LicenseArtifactPayload {
  /** Format version, so a future change can be detected rather than guessed. */
  v: 1;

  /** `partner_onprem_installations.id`. */
  installationId: string;

  /** The SaaS organization this deployment is licensed to. */
  organizationId: string;

  /** `license_plans.plan_key` in force, or null when locked/unknown. */
  planKey: string | null;

  status: LicenseArtifactStatus;

  /** feature_key -> enabled. Mirrors EntitlementsSnapshot.features. */
  features: Record<string, boolean>;

  /** feature_key -> ceiling, null meaning unlimited. */
  limits: Record<string, number | null>;

  /** ISO-8601. Verification asserts issuedAt <= now <= expiresAt. */
  issuedAt: string;

  /**
   * ISO-8601. This is the grace period: how long the box may run offline before
   * it locks. Server-controlled and inside the signature, so it is tunable per
   * installation without shipping a release.
   */
  expiresAt: string;

  /**
   * Echoed back from the client's request. Without this a signature alone does
   * not prove freshness: the customer owns DNS, so a captured valid response
   * could be re-served forever. Absent for manually imported artifacts, which
   * have no request to echo.
   */
  nonce: string | null;

  /** The release the box reported, for vendor-side diagnostics. */
  release: string | null;

  /**
   * sha256 (hex) of the box's own public key, bound in by the issuer. A box
   * refuses an artifact carrying a different fingerprint, so a licence file
   * cannot be copied onto a second installation. Absent only on artifacts
   * issued before instance binding existed.
   */
  fingerprint?: string | null;
}

/**
 * The envelope. `sig` covers the string `"license/" + enc`, NOT `enc` alone.
 *
 * The `license/` domain prefix is load-bearing: without it a signature produced
 * for one artifact type could be transplanted onto another payload that happens
 * to encode identically. Prefixing binds the signature to its purpose.
 */
export interface LicenseArtifactEnvelope {
  /** base64url of the JSON payload. */
  enc: string;

  /** base64url Ed25519 signature over `"license/" + enc`. */
  sig: string;

  /** Always `base64+ed25519` for v1. Present so a future scheme is explicit. */
  alg: 'base64+ed25519';

  /** Which trusted public key signed this. Enables rotation without a flag day. */
  kid: string;
}

/** Why verification refused an artifact. Never surfaced to end users verbatim. */
export type LicenseArtifactRejection =
  | 'malformed'
  | 'unknown_algorithm'
  | 'unknown_key'
  | 'bad_signature'
  | 'not_yet_valid'
  | 'expired'
  | 'nonce_mismatch';

export type LicenseArtifactVerification =
  | { ok: true; payload: LicenseArtifactPayload }
  | { ok: false; reason: LicenseArtifactRejection };
