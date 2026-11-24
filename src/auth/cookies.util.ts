/**
 * @fileoverview Cookie helpers for the auth flow. Centralizes the contract that
 * NestJS sets two HttpOnly cookies on signin/verify-otp/refresh and clears them
 * on signout. The Next.js middleware verifies the access_token cookie locally
 * (no per-navigation network call), so the format here is the wire contract
 * between the two apps.
 *
 * Cookie names:
 *   - access_token  — short-lived (default 1h), Path=/
 *   - refresh_token — long-lived (default 7d), Path=/api/v1/auth/refresh
 *   - mfa_pending   — short-lived MFA gate marker, Path=/
 *
 * Why two paths:
 *   - The browser only sends refresh_token on the refresh endpoint, narrowing
 *     CSRF surface.
 *
 * Why HttpOnly:
 *   - Prevents JavaScript on the page from reading the token (XSS mitigation).
 *
 * Why SameSite=Lax (default):
 *   - First-party / same-site (including different subdomains under the same
 *     parent domain via COOKIE_DOMAIN) requests carry the cookie. Cross-site
 *     POSTs from a third-party origin do not, killing the easy CSRF vector.
 *
 * @module src/auth/cookies.util
 * @author Prince Jadiya
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { Response } from 'express';
import type { ConfigService } from '@nestjs/config';

/** Cookie name for the short-lived Supabase access JWT. */
export const ACCESS_TOKEN_COOKIE = 'access_token';

/** Cookie name for the long-lived refresh token. */
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

/** Cookie name used while an aal1 session must complete MFA verification. */
export const MFA_PENDING_COOKIE = 'mfa_pending';

/**
 * Signed companion to {@link MFA_PENDING_COOKIE} naming the account the marker
 * belongs to (`${authUserId}.${hmac}`).
 *
 * Two accounts on the same parent domain share one `mfa_pending` slot, so a
 * marker left by account A used to gate account B as well. The binding lives in
 * a second cookie instead of inside `mfa_pending` because the Next.js
 * middleware compares that value to the literal `'true'` — changing its format
 * would silently disable the frontend redirect. Absent or unverifiable binding
 * means "cannot attribute", which stays fail-closed.
 */
export const MFA_PENDING_USER_COOKIE = 'mfa_pending_user';

/** Short-lived signed passkey assurance hint; database assurance remains authoritative. */
export const AUTH_ASSURANCE_COOKIE = 'auth_assurance';

/** Pending trusted-device state exists only until a high-risk TOTP step-up completes. */
export const PASSKEY_PENDING_DEVICE_COOKIE = 'auth_passkey_pending_device';

/** MFA pending cookie lifetime in seconds. */
export const MFA_PENDING_MAX_AGE = 10 * 60;

/** Path scope for the refresh token cookie — only sent to the refresh endpoint. */
export const REFRESH_TOKEN_PATH = '/api/v1/auth/refresh';

/**
 * Cookie name for the user's currently active organization (signed).
 *
 * Value format on the wire is `${orgId}.${hmac}` where the HMAC is computed
 * over `orgId` with the configured signing secret. The cookie is HttpOnly so
 * JS on the page cannot read or write it; the HMAC catches the case of a
 * client tampering with the value via DevTools / proxy.
 *
 * Default lifetime matches the refresh token (7d) so a returning user lands
 * back on their last-active tenant for the full session window.
 */
export const ACTIVE_ORG_COOKIE = 'active_org_id';

/** Default lifetime for the active-org cookie in seconds (7 days). */
export const ACTIVE_ORG_MAX_AGE = 7 * 24 * 60 * 60;

/** Cookie name for the SA impersonation session token (raw, sha256 hashed in DB). */
export const IMPERSONATION_TOKEN_COOKIE = 'impersonation_token';

/** Cookie name for the admin URL that started the current impersonation session. */
export const IMPERSONATION_RETURN_TO_COOKIE = 'impersonation_return_to';

/** Hard ceiling on impersonation cookie lifetime in seconds. */
export const IMPERSONATION_MAX_AGE = 30 * 60; // 30 min, mirrors DB CHECK constraint.

/**
 * Writes the HttpOnly impersonation session cookie.
 *
 * @param {Response} res - The Express response
 * @param {string} token - The raw session token (sha256 hashed server-side in DB)
 * @param {CookieConfig} cfg - Resolved cookie config
 * @param {number} maxAgeSeconds - Desired lifetime, clamped to [60, IMPERSONATION_MAX_AGE]
 */
export function setImpersonationCookie(
  res: Response,
  token: string,
  cfg: CookieConfig,
  maxAgeSeconds: number = IMPERSONATION_MAX_AGE,
): void {
  const baseOpts = {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: cfg.sameSite,
    ...(cfg.domain ? { domain: cfg.domain } : {}),
  };
  const sanitized = token.replace(/[\r\n]/g, '');
  const clamped = Math.max(60, Math.min(maxAgeSeconds, IMPERSONATION_MAX_AGE));

  res.cookie(IMPERSONATION_TOKEN_COOKIE, sanitized, {
    ...baseOpts,
    path: '/',
    maxAge: clamped * 1000,
  });
}

/**
 * Clears the impersonation session cookie.
 *
 * @param {Response} res - The Express response
 * @param {CookieConfig} cfg - Resolved cookie config
 */
export function clearImpersonationCookie(
  res: Response,
  cfg: CookieConfig,
): void {
  const baseOpts = {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: cfg.sameSite,
    ...(cfg.domain ? { domain: cfg.domain } : {}),
  };

  res.clearCookie(IMPERSONATION_TOKEN_COOKIE, { ...baseOpts, path: '/' });
}

/**
 * Writes the HttpOnly impersonation return URL cookie.
 *
 * The exit route treats this value as untrusted and allowlists it before any
 * redirect. HttpOnly still prevents client-side scripts from mutating it during
 * a support session.
 */
export function setImpersonationReturnToCookie(
  res: Response,
  returnTo: string,
  cfg: CookieConfig,
  maxAgeSeconds: number = IMPERSONATION_MAX_AGE,
): void {
  const sanitized = returnTo
    .trim()
    .replace(/[\r\n]/g, '')
    .slice(0, 2048);

  if (!sanitized) return;

  const baseOpts = {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: cfg.sameSite,
    ...(cfg.domain ? { domain: cfg.domain } : {}),
  };
  const clamped = Math.max(60, Math.min(maxAgeSeconds, IMPERSONATION_MAX_AGE));

  res.cookie(IMPERSONATION_RETURN_TO_COOKIE, sanitized, {
    ...baseOpts,
    path: '/',
    maxAge: clamped * 1000,
  });
}

/** Clears the impersonation return URL cookie. */
export function clearImpersonationReturnToCookie(
  res: Response,
  cfg: CookieConfig,
): void {
  const baseOpts = {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: cfg.sameSite,
    ...(cfg.domain ? { domain: cfg.domain } : {}),
  };

  res.clearCookie(IMPERSONATION_RETURN_TO_COOKIE, { ...baseOpts, path: '/' });
}

/**
 * Reads the impersonation_token cookie from a parsed Express request.
 *
 * @param {Record<string, string | undefined>} cookies - `req.cookies` from cookie-parser
 * @returns {string | undefined} The raw token if present
 */
export function readImpersonationCookie(
  cookies: Record<string, string | undefined> | undefined,
): string | undefined {
  return cookies?.[IMPERSONATION_TOKEN_COOKIE];
}

/**
 * Effective cookie config resolved from env via ConfigService.
 *
 * `domain` is intentionally allowed to be empty — when blank, browsers scope the
 * cookie to the host that set it (correct for `localhost` dev where Next.js@:3000
 * and NestJS@:3001 share the host).
 */
export interface CookieConfig {
  domain: string;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  accessMaxAge: number;
  refreshMaxAge: number;
  /** Active-organization cookie max-age in seconds. */
  activeOrgMaxAge: number;
  /**
   * Secret used to HMAC-sign the active-org cookie value. May be undefined in
   * misconfigured environments — set/read helpers fail closed in that case
   * (no cookie written; existing cookies treated as invalid) rather than
   * silently emitting unsigned values.
   */
  signingSecret: string | undefined;
}

/**
 * Resolves cookie config from {@link ConfigService} at the `cookies` key.
 *
 * @param {ConfigService} config - Nest config service injected by callers
 * @returns {CookieConfig} Resolved config with defaults applied
 */
export function readCookieConfig(config: ConfigService): CookieConfig {
  return {
    domain: config.get<string>('cookies.domain') || '',
    secure: config.get<boolean>('cookies.secure') ?? false,
    sameSite:
      config.get<'lax' | 'strict' | 'none'>('cookies.sameSite') ?? 'lax',
    accessMaxAge: config.get<number>('cookies.accessMaxAge') ?? 3600,
    refreshMaxAge: config.get<number>('cookies.refreshMaxAge') ?? 604800,
    activeOrgMaxAge:
      config.get<number>('cookies.activeOrgMaxAge') ?? ACTIVE_ORG_MAX_AGE,
    signingSecret: config.get<string>('cookies.signingSecret') || undefined,
  };
}

/**
 * Token bundle returned by Supabase on signin / verify-otp / refresh.
 */
export interface AuthTokenBundle {
  access_token: string;
  refresh_token: string;
  /** Seconds until access_token expires. Falls back to {@link CookieConfig.accessMaxAge}. */
  expires_in?: number;
}

/**
 * Writes the `access_token` and `refresh_token` HttpOnly cookies on the response.
 *
 * Call this from any controller that completes an auth handshake (signin,
 * verify-otp, refresh, mfa.verify, oauth.callback). The Express `res` must be
 * passthrough (`@Res({ passthrough: true })`) so Nest still forwards the body.
 *
 * @param {Response} res - The Express response to write Set-Cookie headers on
 * @param {AuthTokenBundle} tokens - The token bundle from Supabase
 * @param {CookieConfig} cfg - Resolved cookie config from {@link readCookieConfig}
 */
export function setAuthCookies(
  res: Response,
  tokens: AuthTokenBundle,
  cfg: CookieConfig,
): void {
  const baseOpts = {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: cfg.sameSite,
    // domain is omitted entirely when empty — Express writes a host-only cookie.
    ...(cfg.domain ? { domain: cfg.domain } : {}),
  };

  // Defense-in-depth: strip CR/LF that would break the Set-Cookie header. The
  // tokens come from Supabase, but a bad response (proxy mangling, future API
  // change) shouldn't be able to inject extra headers via cookie value.
  const sanitize = (s: string): string => s.replace(/[\r\n]/g, '');

  // Clamp `expires_in` to a sane window. Supabase returning 0 / negative would
  // produce an instantly-expired cookie (silent logout loop); a huge value
  // overflows browser parsers. Floor at 60s so a clock skew can't lock people out.
  const expiresIn = tokens.expires_in ?? cfg.accessMaxAge;
  const accessMaxAgeSec = Math.max(60, Math.min(expiresIn, cfg.accessMaxAge));

  res.cookie(ACCESS_TOKEN_COOKIE, sanitize(tokens.access_token), {
    ...baseOpts,
    path: '/',
    maxAge: accessMaxAgeSec * 1000,
  });

  res.cookie(REFRESH_TOKEN_COOKIE, sanitize(tokens.refresh_token), {
    ...baseOpts,
    path: REFRESH_TOKEN_PATH,
    maxAge: cfg.refreshMaxAge * 1000,
  });
}

/**
 * Writes the short-lived pending-MFA marker cookie.
 *
 * @param {Response} res - The Express response to write Set-Cookie headers on
 * @param {CookieConfig} cfg - Resolved cookie config
 */
export function setMfaPendingCookie(
  res: Response,
  cfg: CookieConfig,
  authUserId?: string,
): void {
  const baseOpts = {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: cfg.sameSite,
    ...(cfg.domain ? { domain: cfg.domain } : {}),
  };

  res.cookie(MFA_PENDING_COOKIE, 'true', {
    ...baseOpts,
    path: '/',
    maxAge: MFA_PENDING_MAX_AGE * 1000,
  });

  if (authUserId && cfg.signingSecret) {
    res.cookie(MFA_PENDING_USER_COOKIE, signCookieSubject(authUserId, cfg), {
      ...baseOpts,
      path: '/',
      maxAge: MFA_PENDING_MAX_AGE * 1000,
    });
  } else {
    // No attributable subject: drop any stale binding so the marker keeps its
    // fail-closed meaning instead of inheriting another account's identity.
    res.clearCookie(MFA_PENDING_USER_COOKIE, { ...baseOpts, path: '/' });
  }
}

/**
 * Clears the pending-MFA marker cookie.
 *
 * @param {Response} res - The Express response
 * @param {CookieConfig} cfg - Resolved cookie config
 */
export function clearMfaPendingCookie(res: Response, cfg: CookieConfig): void {
  const baseOpts = {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: cfg.sameSite,
    ...(cfg.domain ? { domain: cfg.domain } : {}),
  };

  res.clearCookie(MFA_PENDING_COOKIE, { ...baseOpts, path: '/' });
  res.clearCookie(MFA_PENDING_USER_COOKIE, { ...baseOpts, path: '/' });
  res.clearCookie(AUTH_ASSURANCE_COOKIE, { ...baseOpts, path: '/' });
  res.clearCookie(PASSKEY_PENDING_DEVICE_COOKIE, { ...baseOpts, path: '/' });
}

/**
 * Clears auth cookies. Path attributes must match exactly what
 * {@link setAuthCookies} wrote, otherwise the browser keeps the old cookie.
 *
 * Also clears the active_org_id cookie so a signed-out user does not land
 * back on a stale tenant when they sign in to a different account.
 *
 * @param {Response} res - The Express response
 * @param {CookieConfig} cfg - Resolved cookie config
 */
export function clearAuthCookies(res: Response, cfg: CookieConfig): void {
  const baseOpts = {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: cfg.sameSite,
    ...(cfg.domain ? { domain: cfg.domain } : {}),
  };

  res.clearCookie(ACCESS_TOKEN_COOKIE, { ...baseOpts, path: '/' });
  res.clearCookie(REFRESH_TOKEN_COOKIE, {
    ...baseOpts,
    path: REFRESH_TOKEN_PATH,
  });
  res.clearCookie(MFA_PENDING_COOKIE, { ...baseOpts, path: '/' });
  res.clearCookie(MFA_PENDING_USER_COOKIE, { ...baseOpts, path: '/' });
  res.clearCookie(ACTIVE_ORG_COOKIE, { ...baseOpts, path: '/' });

  // Also clear the impersonation cookies. Without this, an SA who signs out
  // would leave still-live impersonation state attached to their browser;
  // the next sign-in (or any session reuse via stolen cookie) would reactivate
  // the impersonation overlay or stale return URL.
  clearImpersonationCookie(res, cfg);
  clearImpersonationReturnToCookie(res, cfg);
}

/**
 * Reads the access_token cookie from a parsed Express request.
 *
 * @param {Record<string, string | undefined>} cookies - `req.cookies` from cookie-parser
 * @returns {string | undefined} The access token if present
 */
export function readAccessTokenCookie(
  cookies: Record<string, string | undefined> | undefined,
): string | undefined {
  return cookies?.[ACCESS_TOKEN_COOKIE];
}

/**
 * Reads the refresh_token cookie from a parsed Express request.
 *
 * @param {Record<string, string | undefined>} cookies - `req.cookies` from cookie-parser
 * @returns {string | undefined} The refresh token if present
 */
export function readRefreshTokenCookie(
  cookies: Record<string, string | undefined> | undefined,
): string | undefined {
  return cookies?.[REFRESH_TOKEN_COOKIE];
}

/**
 * Reports whether an MFA gate is pending *for the presented session*.
 *
 * Pass `cfg` + `authUserId` to honor the {@link MFA_PENDING_USER_COOKIE}
 * binding: a marker attributable to a different account is ignored, which is
 * what stops account A's half-finished step-up from gating account B on a
 * shared parent domain. Everything else — no binding, unverifiable binding, or
 * a caller that cannot name the subject — stays fail-closed and gates.
 *
 * @param {Record<string, string | undefined>} cookies - `req.cookies` from cookie-parser
 * @param {CookieConfig} [cfg] - Resolved cookie config (needed to verify the binding)
 * @param {string} [authUserId] - The auth user id of the presented token
 * @returns {boolean} `true` when the caller must complete MFA
 */
export function readMfaPendingCookie(
  cookies: Record<string, string | undefined> | undefined,
  cfg?: CookieConfig,
  authUserId?: string,
): boolean {
  if (cookies?.[MFA_PENDING_COOKIE] !== 'true') return false;
  if (!cfg || !authUserId) return true;

  const boundTo = verifyCookieSubject(cookies[MFA_PENDING_USER_COOKIE], cfg);

  return boundTo === null || boundTo === authUserId;
}

/**
 * Computes the HMAC tag for a subject-bearing cookie value (active org, MFA
 * pending binding).
 *
 * We truncate the 64-char hex digest to 16 chars to keep the cookie compact —
 * 64 bits of HMAC-SHA256 is still well above what an online attacker can
 * brute-force against a single-target session within the cookie's 7-day
 * lifetime. Constant-time comparison happens in {@link verifyCookieSubject}.
 *
 * @private
 */
function computeCookieHmac(subject: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(subject)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Signs `${subject}.${hmac}`. Throws when the secret is missing or the subject
 * contains the '.' separator.
 *
 * @private
 */
function signCookieSubject(subject: string, cfg: CookieConfig): string {
  if (!cfg.signingSecret) {
    throw new Error(
      'Cannot sign cookie: signing secret is not configured. Set COOKIE_SIGNING_SECRET (or fall back to SUPABASE_JWT_SECRET) and restart the process.',
    );
  }
  if (subject.includes('.')) {
    throw new Error(
      'Cannot sign cookie value: subject must not contain "." (it is the format separator).',
    );
  }

  return `${subject}.${computeCookieHmac(subject, cfg.signingSecret)}`;
}

/**
 * Returns the subject of a `${subject}.${hmac}` cookie value, or `null` when it
 * is absent, malformed, or the signature does not verify.
 *
 * @private
 */
function verifyCookieSubject(
  raw: string | undefined,
  cfg: CookieConfig,
): string | null {
  if (!raw || !cfg.signingSecret) return null;

  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;

  const subject = raw.slice(0, dot);
  const tag = raw.slice(dot + 1);
  const expected = computeCookieHmac(subject, cfg.signingSecret);

  // Length check first — timingSafeEqual throws on mismatched lengths and we
  // don't want that crash path to also be an oracle.
  if (tag.length !== expected.length) return null;

  try {
    return timingSafeEqual(
      Buffer.from(tag, 'hex'),
      Buffer.from(expected, 'hex'),
    )
      ? subject
      : null;
  } catch {
    return null;
  }
}

/**
 * Signs an org id for use as the active_org_id cookie value.
 *
 * Throws when the signing secret is missing or when the orgId contains the
 * format separator ('.') we use to split orgId from tag on verify. UUIDs
 * never contain dots, but the assertion guards against future non-UUID
 * callers slipping through (L4).
 *
 * @param {string} orgId - The organization UUID (or any value that doesn't contain a '.')
 * @param {CookieConfig} cfg - Resolved cookie config (must include a signing secret)
 * @returns {string} `${orgId}.${hmac}`
 * @throws {Error} When the signing secret is missing or orgId contains '.'
 */
export function signActiveOrgValue(orgId: string, cfg: CookieConfig): string {
  return signCookieSubject(orgId, cfg);
}

/**
 * Verifies a raw active_org_id cookie value, returning the org id only when
 * the signature checks out. Constant-time comparison via {@link timingSafeEqual}
 * prevents timing-based forgery probing.
 *
 * @param {string | undefined} raw - The cookie value as read from the request
 * @param {CookieConfig} cfg - Resolved cookie config (must include a signing secret)
 * @returns {{ orgId: string; valid: true } | { orgId: null; valid: false }}
 *   `{ orgId, valid: true }` on success;
 *   `{ orgId: null, valid: false }` when the cookie is absent, malformed, or
 *   the signature does not match. The boolean lets callers distinguish "no
 *   cookie was sent" from "cookie was tampered with" — both are treated the
 *   same way by the auth guard (fall through to first-membership) but the
 *   distinction matters for logging.
 */
export function verifyActiveOrgValue(
  raw: string | undefined,
  cfg: CookieConfig,
): { orgId: string; valid: true } | { orgId: null; valid: false } {
  const orgId = verifyCookieSubject(raw, cfg);

  return orgId ? { orgId, valid: true } : { orgId: null, valid: false };
}

/**
 * Writes the signed active_org_id cookie.
 *
 * Throws when the signing secret is missing — better to surface the
 * misconfiguration at the call site than to silently no-op, which used to
 * mean the user got a 200 from /tenants/switch but the cookie never landed
 * and the next request reverted to first-membership. The AuthModule logs a
 * fatal error at boot in that case, so production callers should never hit
 * this branch.
 *
 * @param {Response} res - The Express response
 * @param {string} orgId - The organization UUID to remember
 * @param {CookieConfig} cfg - Resolved cookie config
 * @throws {Error} From {@link signActiveOrgValue} when signing fails.
 */
export function setActiveOrgCookie(
  res: Response,
  orgId: string,
  cfg: CookieConfig,
): void {
  const signed = signActiveOrgValue(orgId, cfg);

  res.cookie(ACTIVE_ORG_COOKIE, signed, {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: cfg.sameSite,
    ...(cfg.domain ? { domain: cfg.domain } : {}),
    path: '/',
    maxAge: cfg.activeOrgMaxAge * 1000,
  });
}

/**
 * Clears the active_org_id cookie. Used by signout and by the guard when a
 * cookie that no longer corresponds to a real membership needs to be evicted.
 *
 * @param {Response} res - The Express response
 * @param {CookieConfig} cfg - Resolved cookie config
 */
export function clearActiveOrgCookie(res: Response, cfg: CookieConfig): void {
  res.clearCookie(ACTIVE_ORG_COOKIE, {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: cfg.sameSite,
    ...(cfg.domain ? { domain: cfg.domain } : {}),
    path: '/',
  });
}

/**
 * Reads and verifies the active_org_id cookie. Wraps {@link verifyActiveOrgValue}
 * for the common "extract from req.cookies" path.
 *
 * @param {Record<string, string | undefined>} cookies - `req.cookies` from cookie-parser
 * @param {CookieConfig} cfg - Resolved cookie config
 * @returns Same shape as {@link verifyActiveOrgValue}
 */
export function readActiveOrgCookie(
  cookies: Record<string, string | undefined> | undefined,
  cfg: CookieConfig,
): { orgId: string; valid: true } | { orgId: null; valid: false } {
  return verifyActiveOrgValue(cookies?.[ACTIVE_ORG_COOKIE], cfg);
}
