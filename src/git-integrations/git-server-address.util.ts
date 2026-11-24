/**
 * @fileoverview The address of a self-hosted Git server (ticket 11): normalising what the admin typed and
 * deciding whether XISUITE may connect to it.
 *
 * An admin-typed server address is an outbound-connection primitive. In SaaS it must resolve to public
 * addresses only (else it could be pointed at the metadata service or the internal network and used as a
 * port scanner). On-premise the Git server normally IS on the internal network, so private addresses are
 * allowed there; link-local (incl. 169.254.169.254) stays blocked everywhere.
 * @module src/git-integrations/git-server-address.util
 */

import { lookup } from 'dns';
import { isIP } from 'net';
import { promisify } from 'util';

import { isBlockedAddress } from '../common/security/ssrf-guard';

const dnsLookup = promisify(lookup);

export type GitServerAddressErrorCode =
  | 'invalid_url'
  | 'http_insecure'
  | 'dns_not_found'
  | 'private_address_blocked';

/** Carries a stable code, so callers map it to a message (or a test check) instead of matching prose. */
export class GitServerAddressError extends Error {
  constructor(
    readonly code: GitServerAddressErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GitServerAddressError';
  }
}

/** Same pattern as the `host` CHECK of every git_* table (names and IPv4, optional port). */
const HOST_KEY = /^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$/;
const MAX_BASE_URL = 500;

/**
 * `https://GitLab.Company.local/gitlab/?x#y` → base `https://gitlab.company.local/gitlab`, host
 * `gitlab.company.local`. No trailing slash, query or fragment; the path is kept (GitLab relative root).
 * @throws {GitServerAddressError} invalid_url | http_insecure
 */
export function normalizeServerUrl(
  raw: string,
  allowHttp: boolean,
): { baseUrl: string; host: string } {
  let url: URL;

  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new GitServerAddressError('invalid_url', 'Not a valid address');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new GitServerAddressError(
      'invalid_url',
      'The address must start with https://',
    );
  if (url.protocol === 'http:' && !allowHttp)
    throw new GitServerAddressError(
      'http_insecure',
      'The address must use https://',
    );
  if (url.username || url.password)
    throw new GitServerAddressError(
      'invalid_url',
      'The address must not contain a user name or password',
    );

  const host = url.host.toLowerCase();

  if (!HOST_KEY.test(host))
    throw new GitServerAddressError(
      'invalid_url',
      'Use a host name or an IPv4 address',
    );

  const path = url.pathname.replace(/\/+$/, '');
  const baseUrl = `${url.protocol}//${host}${path}`;

  if (baseUrl.length > MAX_BASE_URL)
    throw new GitServerAddressError('invalid_url', 'The address is too long');

  return { baseUrl, host };
}

/** Link-local (169.254.0.0/16 incl. cloud metadata, fe80::/10) and the unspecified address: never. */
function isLinkLocalOrUnspecified(address: string): boolean {
  if (isIP(address) === 4)
    return address.startsWith('169.254.') || address.startsWith('0.');

  const lower = address.toLowerCase();

  return lower === '::' || /^fe[89ab][0-9a-f]:/.test(lower);
}

/** Whether one resolved IP may be connected to. */
export function isAllowedServerAddress(
  address: string,
  onPremise: boolean,
): boolean {
  if (!isIP(address)) return false;
  if (isLinkLocalOrUnspecified(address)) return false;

  return onPremise || !isBlockedAddress(address);
}

const CHECKED_TTL_MS = 5 * 60 * 1000;
const checked = new Map<string, number>();

/**
 * Resolves the server's host and checks EVERY address (a rebinding record often returns one public and
 * one private address). Successes are remembered for 5 minutes per host and mode.
 *
 * ponytail: resolve-then-validate, like common/security/ssrf-guard.ts. A DNS rebind between this check and
 * the fetch is the accepted ceiling; pin the IP in a custom dispatcher if that ever matters.
 * @throws {GitServerAddressError} invalid_url | dns_not_found | private_address_blocked
 */
export async function assertServerAddress(
  baseUrl: string,
  onPremise: boolean,
): Promise<void> {
  let hostname: string;

  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    throw new GitServerAddressError('invalid_url', 'Not a valid address');
  }

  const key = `${onPremise ? 'p' : 's'}:${hostname}`;
  const until = checked.get(key);

  if (until && until > Date.now()) return;

  let addresses: string[];

  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = (await dnsLookup(hostname, { all: true })).map(
        (entry) => entry.address,
      );
    } catch {
      throw new GitServerAddressError(
        'dns_not_found',
        `${hostname} could not be resolved`,
      );
    }
  }

  const blocked = addresses.find(
    (address) => !isAllowedServerAddress(address, onPremise),
  );

  if (!addresses.length || blocked)
    throw new GitServerAddressError(
      'private_address_blocked',
      `${hostname} resolves to ${blocked ?? 'no address'}, which XISUITE may not connect to`,
    );

  checked.set(key, Date.now() + CHECKED_TTL_MS);
}

/** Test seam: forget remembered checks. */
export function resetServerAddressChecks(): void {
  checked.clear();
}
