import { lookup as dnsLookup, type LookupAddress } from 'dns';
import type { ClientRequest, IncomingHttpHeaders } from 'http';
import { request } from 'https';
import { isIP, type LookupFunction } from 'net';

import { isBlockedAddress } from '../../../../../common/security/ssrf-guard';

class BlockedHostError extends Error {}

/** Same check as publicOnlyLookup, with its own error so a refused host can be told apart. */
export const safeGetLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(
    hostname,
    { ...options, all: true },
    (error, addresses: LookupAddress[]) => {
      if (error) return callback(error, '', 0);

      const list = Array.isArray(addresses) ? addresses : [];

      if (
        list.length === 0 ||
        list.some((entry) => isBlockedAddress(entry.address))
      ) {
        return callback(
          new BlockedHostError(`${hostname} resolves to a blocked address`),
          '',
          0,
        );
      }

      if (options.all) return callback(null, list);

      return callback(null, list[0].address, list[0].family);
    },
  );
};

export type SafeGetFailure =
  | 'BLOCKED_HOST'
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'TOO_MANY_REDIRECTS';

export class SafeGetError extends Error {
  constructor(readonly failure: SafeGetFailure) {
    super(failure);
  }
}

export interface SafeGetResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface SafeGetOptions {
  maxBytes: number;
  deadlineMs: number;
  maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * A GET to public HTTPS hosts only. Redirects are followed, each checked when it connects; the Authorization header
 * is dropped when the host changes, because storage links refuse it.
 */
export async function safeHttpsGet(
  url: string,
  headers: Record<string, string>,
  options: SafeGetOptions,
  lookup: LookupFunction = safeGetLookup,
): Promise<SafeGetResult> {
  const deadline = Date.now() + options.deadlineMs;
  let target = new URL(url);
  let sent = { ...headers };

  for (let hop = 0; hop <= (options.maxRedirects ?? 3); hop++) {
    // An IP address skips the lookup that refuses private hosts, so only host names are allowed.
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      isIP(target.hostname.replace(/^\[|\]$/g, '')) !== 0
    ) {
      throw new SafeGetError('BLOCKED_HOST');
    }

    const result = await getOnce(
      target,
      sent,
      options.maxBytes,
      deadline - Date.now(),
      lookup,
    );
    const location = result.headers.location;

    if (!REDIRECT_STATUSES.has(result.status) || !location) return result;

    const next = URL.canParse(location, target)
      ? new URL(location, target)
      : null;

    // A broken redirect is treated like a host that cannot be reached.
    if (!next) throw new SafeGetError('UNREACHABLE');

    if (next.host !== target.host) {
      sent = Object.fromEntries(
        Object.entries(sent).filter(
          ([name]) => name.toLowerCase() !== 'authorization',
        ),
      );
    }

    target = next;
  }

  throw new SafeGetError('TOO_MANY_REDIRECTS');
}

function getOnce(
  target: URL,
  headers: Record<string, string>,
  maxBytes: number,
  remainingMs: number,
  lookup: LookupFunction,
): Promise<SafeGetResult> {
  return new Promise((resolve, reject) => {
    if (remainingMs <= 0) return reject(new SafeGetError('TIMEOUT'));

    let settled = false;
    let outgoing: ClientRequest | undefined;

    const finish = (error: SafeGetError | null, result?: SafeGetResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (error || !result) {
        outgoing?.destroy();
        reject(error ?? new SafeGetError('UNREACHABLE'));
      } else {
        resolve(result);
      }
    };

    const timer = setTimeout(
      () => finish(new SafeGetError('TIMEOUT')),
      remainingMs,
    );

    try {
      outgoing = request(
        target,
        { method: 'GET', headers, lookup },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;

          response.on('data', (chunk: Buffer) => {
            size += chunk.length;

            if (size > maxBytes) return finish(new SafeGetError('TOO_LARGE'));

            chunks.push(chunk);
          });
          response.on('end', () =>
            finish(null, {
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
          response.on('error', () => finish(new SafeGetError('UNREACHABLE')));
        },
      );
    } catch {
      return finish(new SafeGetError('UNREACHABLE'));
    }

    outgoing.on('error', (error) =>
      finish(
        new SafeGetError(
          error instanceof BlockedHostError ? 'BLOCKED_HOST' : 'UNREACHABLE',
        ),
      ),
    );
    outgoing.end();
  });
}
