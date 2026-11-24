/**
 * @fileoverview Resolve an admin-supplied SFTP host and prove it is safe to connect to.
 * @module src/backup/adapters/sftp/sftp-host-resolver
 *
 * A backup target is a hostname an org admin types in, so the connect path is an outbound-connection
 * primitive. Without this it can be pointed at `169.254.169.254` or an RFC1918 address and its
 * success/failure used as an internal port scanner.
 *
 * Three properties, in order:
 *
 *  1. `isBlockedAddress` — NOT `assertPublicHttpUrl`. That one throws unless the protocol is
 *     `https:`, and an SFTP target is a host and a port, not a URL. Faking a URL to satisfy it would
 *     be a lie a later reader would try to "fix".
 *  2. EVERY resolved address is checked, not just the first — a rebinding record commonly returns
 *     one public and one private address.
 *  3. The caller connects to the returned IP **literal**, so the SSH library performs no second
 *     resolution. That closes the check-to-connect window entirely rather than narrowing it.
 *
 * (3) is only safe because the host key is pinned: SSH has no certificate, no SNI and no virtual-host
 * routing, so server identity comes from the host key alone and connecting by IP loses nothing.
 * Without pinning it would be reckless. The two controls are complementary and neither is optional.
 */

import { lookup } from 'dns';
import { isIP } from 'net';
import { promisify } from 'util';
import { isBlockedAddress } from '../../../common/security/ssrf-guard';

const dnsLookup = promisify(lookup);

export type SftpHostErrorCode =
  | 'dns_not_found'
  | 'host_blocked_private'
  | 'invalid_port';

/** Carries a stable code so the caller maps to a message rather than matching on prose. */
export class SftpHostError extends Error {
  constructor(
    readonly code: SftpHostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SftpHostError';
  }
}

export interface ResolvedSftpHost {
  /** The verified IP literal to hand to connect(). Never the hostname. */
  address: string;

  /** Everything the name resolved to. For the audit row and the run log, not for connecting. */
  allAddresses: string[];
}

/**
 * On-prem installs are SFTP-only and their server is very likely on an RFC1918 address, which the
 * shared guard blocks unconditionally.
 *
 * Read at call time rather than at module load so a test can flip it. Server-side only — a
 * tenant-settable version of this switch would be a one-click internal port scanner with a
 * credential prompt.
 */
export function allowsPrivateNetworks(): boolean {
  return process.env.BACKUP_SFTP_ALLOW_PRIVATE_NETWORKS === 'true';
}

/**
 * The narrow widening the on-prem flag buys: RFC1918 and IPv6 unique-local, and nothing else.
 *
 * Loopback, link-local (including the cloud metadata endpoint), `0/8`, CGNAT and multicast stay
 * blocked even with the flag on — those are never a customer's SFTP server, and they are exactly
 * what an internal probe would aim at.
 */
function isPrivateButAllowable(address: string): boolean {
  const family = isIP(address);

  if (family === 4) {
    const parts = address.split('.').map((part) => Number(part));

    if (
      parts.length !== 4 ||
      parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)
    ) {
      return false;
    }

    const [a, b] = parts;

    return (
      a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    );
  }

  if (family === 6) {
    const addr = address.toLowerCase().split('%')[0];
    const mapped = addr.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);

    if (mapped) {
      return isPrivateButAllowable(mapped[1]);
    }

    const first = parseInt(addr.split(':')[0] || '0', 16);

    // fc00::/7 unique-local only. fe80::/10 link-local is deliberately excluded.
    return (first & 0xfe00) === 0xfc00;
  }

  return false;
}

/** True when this exact IP literal may be connected to. */
export function isPermittedAddress(
  address: string,
  allowPrivate: boolean,
): boolean {
  if (!isBlockedAddress(address)) {
    return true;
  }

  return allowPrivate && isPrivateButAllowable(address);
}

/** SFTP on 2222 is routine, so only the protocol bounds are enforced. */
export function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SftpHostError(
      'invalid_port',
      `Port ${String(port)} is not valid. Use a port between 1 and 65535.`,
    );
  }
}

/**
 * Resolve `host` and return the IP literal to connect to.
 *
 * @throws {SftpHostError} `invalid_port`, `dns_not_found`, or `host_blocked_private`.
 */
export async function resolveSftpHost(
  host: string,
  port: number,
): Promise<ResolvedSftpHost> {
  assertValidPort(port);

  const allowPrivate = allowsPrivateNetworks();
  const trimmed = host.trim().replace(/^\[|\]$/g, '');

  // A literal needs no DNS, and resolving one would only add a failure mode.
  if (isIP(trimmed)) {
    if (!isPermittedAddress(trimmed, allowPrivate)) {
      throw new SftpHostError(
        'host_blocked_private',
        `${trimmed} is a private or internal address. XISUITE will not connect to internal networks.`,
      );
    }

    return { address: trimmed, allAddresses: [trimmed] };
  }

  let records: { address: string }[];

  try {
    records = await dnsLookup(trimmed, { all: true });
  } catch {
    throw new SftpHostError(
      'dns_not_found',
      `The host name ${trimmed} does not resolve. Check the spelling and that the record is published in public DNS.`,
    );
  }

  if (records.length === 0) {
    throw new SftpHostError(
      'dns_not_found',
      `The host name ${trimmed} does not resolve. Check the spelling and that the record is published in public DNS.`,
    );
  }

  // Every address, not just the one we would connect to — a rebinding record returns both.
  for (const record of records) {
    if (!isPermittedAddress(record.address, allowPrivate)) {
      throw new SftpHostError(
        'host_blocked_private',
        `${trimmed} resolves to a private or internal address (${record.address}). XISUITE will not connect to internal networks.`,
      );
    }
  }

  return {
    address: records[0].address,
    allAddresses: records.map((record) => record.address),
  };
}
