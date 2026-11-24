/**
 * @fileoverview SSRF guard for outbound HTTP(S) requests driven by user/admin
 * configuration (e.g. workflow webhook post-functions). Rejects non-HTTPS URLs,
 * embedded credentials, and any host that resolves to a private, loopback,
 * link-local (incl. cloud metadata 169.254.169.254), or unique-local address.
 *
 * Resolve-then-validate closes the obvious DNS path; callers should still treat
 * the network egress as untrusted (a determined attacker can attempt DNS
 * rebinding between this check and the actual fetch). For v1 this guard plus
 * `redirect: 'manual'` on the fetch is the accepted mitigation.
 * @module src/common/security/ssrf-guard
 * @author Rajbha Manek
 */

import { lookup } from 'dns';
import { isIP } from 'net';
import { promisify } from 'util';

const dnsLookup = promisify(lookup);

/** Parsed IPv4 octets → true when the address is private/loopback/link-local/reserved. */
function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map((p) => Number(p));

  if (
    parts.length !== 4 ||
    parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)
  ) {
    return true; // malformed → fail closed
  }

  const [a, b] = parts;

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this" network
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast + reserved (224.0.0.0/3)

  return false;
}

/** true when an IPv6 address is loopback, ULA (fc00::/7), or link-local (fe80::/10). */
function isBlockedIpv6(address: string): boolean {
  const addr = address.toLowerCase().split('%')[0]; // strip zone id

  if (addr === '::1' || addr === '::') return true;

  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4.
  const mapped = addr.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);

  if (mapped) return isBlockedIpv4(mapped[1]);

  const head = addr.split(':')[0] ?? '';
  const first = parseInt(head || '0', 16);

  // fc00::/7 (unique-local): high byte 0xfc or 0xfd.
  if ((first & 0xfe00) === 0xfc00) return true;

  // fe80::/10 link-local.
  if ((first & 0xffc0) === 0xfe80) return true;

  return false;
}

/** true when a resolved IP literal must be blocked. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);

  return true; // not a recognizable IP → fail closed
}

/**
 * Assert that `rawUrl` is a safe public HTTPS target.
 *
 * @throws Error when the URL is malformed, not HTTPS, carries credentials, or
 *   resolves to a private/loopback/link-local/reserved address.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid webhook URL: ${rawUrl}`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`Webhook URL must use HTTPS — received ${url.protocol}`);
  }

  if (url.username || url.password) {
    throw new Error('Webhook URL must not contain credentials');
  }

  const host = url.hostname.replace(/^\[|\]$/g, ''); // unwrap [ipv6]

  // Literal IP host — validate directly, no DNS.
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new Error(
        `Webhook host ${host} resolves to a blocked (private/internal) address`,
      );
    }

    return;
  }

  // Hostname — resolve every record and block if ANY is internal.
  let records: { address: string }[];

  try {
    records = await dnsLookup(host, { all: true });
  } catch {
    throw new Error(`Webhook host ${host} could not be resolved`);
  }

  if (records.length === 0) {
    throw new Error(`Webhook host ${host} could not be resolved`);
  }

  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new Error(
        `Webhook host ${host} resolves to a blocked (private/internal) address`,
      );
    }
  }
}
