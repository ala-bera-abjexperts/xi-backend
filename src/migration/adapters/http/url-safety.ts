/**
 * @fileoverview SSRF protection for user-supplied Atlassian base URLs.
 *
 * A migration connection's `base_url` is attacker-controllable, and the backend fetches it with
 * a privileged network position. This validates the URL scheme + resolves the host and blocks
 * cloud metadata / link-local / loopback targets. Private (RFC1918 / unique-local) targets are
 * blocked unless explicitly allowed (on-prem installs reaching an internal Jira/Confluence).
 *
 * The resolved IP is returned so callers can pin it (anti DNS-rebinding) when they make requests.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface UrlSafetyOptions {
  /** Allow RFC1918 / unique-local targets (on-prem deployments reaching an internal server). */
  allowPrivateNetworks?: boolean;
  /** Allow plain HTTP (on-prem boxes without TLS). HTTPS is always allowed. */
  allowInsecureHttp?: boolean;
}

export interface UrlSafetyResult {
  ok: boolean;
  reason?: string;
  /** The origin (scheme://host[:port]) to use as an API base. */
  origin?: string;
  /** Resolved IP literal (for pinning). */
  resolvedIp?: string;
  /** True when the target is HTTP (caller should surface a warning). */
  insecure?: boolean;
  /** Context path of the base URL (`/jira`, `/statistik.at/jira`), no trailing slash; empty for a bare origin. */
  basePath?: string;
}

/** Parse an IPv4 dotted-quad into a 32-bit unsigned int, or null if not IPv4. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');

  if (parts.length !== 4) return null;

  let value = 0;

  for (const part of parts) {
    const n = Number(part);

    if (!Number.isInteger(n) || n < 0 || n > 255) return null;

    value = value * 256 + n;
  }

  return value >>> 0;
}

/** True if the IP literal points at a loopback / link-local / private / metadata target. */
export function isBlockedIp(ip: string, allowPrivate: boolean): boolean {
  const family = isIP(ip);

  if (family === 4) {
    const v = ipv4ToInt(ip);

    if (v === null) return true;

    const inRange = (base: string, bits: number) => {
      const b = ipv4ToInt(base)!;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;

      return (v & mask) === (b & mask);
    };

    // Always-blocked ranges (loopback, link-local incl. 169.254.169.254 metadata, this-host, CGNAT)
    if (inRange('127.0.0.0', 8)) return true;
    if (inRange('169.254.0.0', 16)) return true;
    if (inRange('0.0.0.0', 8)) return true;
    if (inRange('100.64.0.0', 10)) return true;

    // Private ranges — blocked unless explicitly allowed
    if (
      !allowPrivate &&
      (inRange('10.0.0.0', 8) ||
        inRange('172.16.0.0', 12) ||
        inRange('192.168.0.0', 16))
    ) {
      return true;
    }

    return false;
  }

  if (family === 6) {
    const lower = ip.toLowerCase();

    // Loopback (::1), unspecified (::), link-local (fe80::/10)
    if (lower === '::1' || lower === '::') return true;
    if (
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    ) {
      return true;
    }

    // Unique-local fc00::/7 (fc.. / fd..) — treat as private
    if (!allowPrivate && (lower.startsWith('fc') || lower.startsWith('fd')))
      return true;

    // IPv4-mapped ::ffff:a.b.c.d — re-check the embedded v4
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);

    if (mapped) return isBlockedIp(mapped[1], allowPrivate);

    return false;
  }

  // Not a recognizable IP literal
  return true;
}

/**
 * Validate + resolve a base URL for outbound migration requests.
 * Returns `{ ok:false, reason }` for anything unsafe.
 */
/**
 * The context path of a configured base URL, normalised to no trailing slash; empty for a bare
 * origin. Jira/Confluence Server and Data Center are routinely installed under one (`/jira`,
 * `/confluence`, a customer's `/statistik.at/jira`), and every API path must be prefixed with it.
 * Dropping it, which this module did until 1.2.16, turned every request into a 404 on the bare
 * origin while a curl of the very same base URL succeeded.
 */
export function normalizeBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');

  return trimmed === '' || trimmed === '/' ? '' : trimmed;
}

export async function validateBaseUrl(
  rawUrl: string,
  options: UrlSafetyOptions = {},
): Promise<UrlSafetyResult> {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Base URL is not a valid URL' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      reason: `Unsupported scheme "${parsed.protocol}" — use http(s)`,
    };
  }

  const insecure = parsed.protocol === 'http:';

  if (insecure && !options.allowInsecureHttp) {
    return {
      ok: false,
      reason:
        'Plain HTTP is not allowed unless the host is configured as on-prem',
    };
  }

  const host = parsed.hostname;
  const allowPrivate = options.allowPrivateNetworks === true;

  // Resolve the host to an IP (or use the literal) and classify it.
  let resolvedIp: string;

  if (isIP(host)) {
    resolvedIp = host;
  } else {
    try {
      const result = await lookup(host);

      resolvedIp = result.address;
    } catch {
      return { ok: false, reason: `Host "${host}" could not be resolved` };
    }
  }

  if (isBlockedIp(resolvedIp, allowPrivate)) {
    return {
      ok: false,
      reason: allowPrivate
        ? `Host resolves to a blocked address (${resolvedIp})`
        : `Host resolves to a private/internal address (${resolvedIp}); enable on-prem mode to allow it`,
    };
  }

  return {
    ok: true,
    origin: parsed.origin,
    basePath: normalizeBasePath(parsed.pathname),
    resolvedIp,
    insecure,
  };
}
