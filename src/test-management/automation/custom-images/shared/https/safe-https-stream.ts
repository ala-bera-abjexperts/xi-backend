import type { ClientRequest, IncomingHttpHeaders } from 'http';
import { request } from 'https';
import { isIP, type LookupFunction } from 'net';

import { SafeGetError, safeGetLookup } from './safe-https-get';

export interface SafeStreamOptions {
  method: 'GET' | 'HEAD';
  maxBytes: number;
  deadlineMs: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  // Gets each piece of a 200 answer in order; the download waits while it runs.
  onData?: (chunk: Buffer) => void | Promise<void>;
}

export interface SafeStreamResult {
  status: number;
  headers: IncomingHttpHeaders;
  bytes: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * safeHttpsGet for large bodies: the same host rules and redirects, but the body is handed over piece by piece
 * instead of being kept in memory.
 */
export async function safeHttpsStream(
  url: string,
  headers: Record<string, string>,
  options: SafeStreamOptions,
  lookup: LookupFunction = safeGetLookup,
): Promise<SafeStreamResult> {
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

    const result = await streamOnce(
      target,
      sent,
      options,
      deadline - Date.now(),
      lookup,
    );
    const location = result.headers.location;

    if (!REDIRECT_STATUSES.has(result.status) || !location) return result;

    const next = URL.canParse(location, target)
      ? new URL(location, target)
      : null;

    if (!next) throw new SafeGetError('UNREACHABLE');

    // Storage links refuse the registry's sign-in.
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

function streamOnce(
  target: URL,
  headers: Record<string, string>,
  options: SafeStreamOptions,
  remainingMs: number,
  lookup: LookupFunction,
): Promise<SafeStreamResult> {
  return new Promise((resolve, reject) => {
    if (remainingMs <= 0 || options.signal?.aborted) {
      return reject(new SafeGetError('TIMEOUT'));
    }

    let settled = false;
    let blocked = false;
    let outgoing: ClientRequest | undefined;

    const finish = (error: Error | null, result?: SafeStreamResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);

      if (error || !result) {
        outgoing?.destroy();
        reject(error ?? new SafeGetError('UNREACHABLE'));
      } else {
        resolve(result);
      }
    };
    const stop = () => finish(new SafeGetError('TIMEOUT'));
    const timer = setTimeout(stop, remainingMs);

    options.signal?.addEventListener('abort', stop, { once: true });

    // A host the lookup refuses fails without a system error code.
    const watched: LookupFunction = (hostname, lookupOptions, callback) =>
      lookup(hostname, lookupOptions, (error, address, family) => {
        if (error && !error.code) blocked = true;

        callback(error, address, family);
      });

    try {
      outgoing = request(
        target,
        { method: options.method, headers, lookup: watched },
        (response) => {
          const status = response.statusCode ?? 0;
          const deliver =
            options.method === 'GET' && status === 200
              ? options.onData
              : undefined;
          let bytes = 0;
          let delivered: Promise<void> = Promise.resolve();

          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;

            if (bytes > options.maxBytes) {
              return finish(new SafeGetError('TOO_LARGE'));
            }

            if (!deliver || settled) return;

            let pending: void | Promise<void>;

            try {
              pending = deliver(chunk);
            } catch (error) {
              return finish(
                error instanceof Error
                  ? error
                  : new SafeGetError('UNREACHABLE'),
              );
            }

            if (pending) {
              response.pause();
              delivered = delivered
                .then(() => pending)
                .then(
                  () => {
                    response.resume();
                  },
                  (error: unknown) =>
                    finish(
                      error instanceof Error
                        ? error
                        : new SafeGetError('UNREACHABLE'),
                    ),
                );
            }
          });
          response.on('end', () => {
            const expected = Number(response.headers['content-length']);

            void delivered.then(() =>
              // A body cut short counts as a failed download.
              options.method === 'GET' &&
              status === 200 &&
              Number.isFinite(expected) &&
              response.headers['content-length'] !== undefined &&
              bytes !== expected
                ? finish(new SafeGetError('UNREACHABLE'))
                : finish(null, { status, headers: response.headers, bytes }),
            );
          });
          response.on('error', () => finish(new SafeGetError('UNREACHABLE')));
        },
      );
    } catch {
      return finish(new SafeGetError('UNREACHABLE'));
    }

    outgoing.on('error', () =>
      finish(new SafeGetError(blocked ? 'BLOCKED_HOST' : 'UNREACHABLE')),
    );
    outgoing.end();
  });
}
