import { lookup as dnsLookup, type LookupAddress } from 'dns';
import type { ClientRequest } from 'http';
import { request } from 'https';
import type { LookupFunction } from 'net';

import { isBlockedAddress } from '../../common/security/ssrf-guard';

export const CI_REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2048;

export type CiRequestFailure =
  | 'CI_BLOCKED_HOST'
  | 'CI_UNREACHABLE'
  | 'CI_TIMEOUT';

export interface CiRequestResult {
  status?: number;
  body: string;
  failure?: CiRequestFailure;
  location?: string;
}

class BlockedHostError extends Error {}

/**
 * Resolves the host when the socket connects and refuses it if any address is private, so a DNS answer that
 * changed after the save-time check cannot reach an internal service.
 */
export const publicOnlyLookup: LookupFunction = (
  hostname,
  options,
  callback,
) => {
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

/** One HTTPS call to a CI tool: no redirects, a short timeout and only the start of the reply is kept. */
export function safeHttpsRequest(
  url: string,
  method: 'POST' | 'PUT',
  headers: Record<string, string>,
  body: string | null,
  lookup: LookupFunction = publicOnlyLookup,
): Promise<CiRequestResult> {
  return new Promise((resolve) => {
    const target = new URL(url);

    if (target.protocol !== 'https:')
      return resolve({ body: '', failure: 'CI_BLOCKED_HOST' });

    let settled = false;
    let location: string | undefined;

    const finish = (result: CiRequestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(location ? { ...result, location } : result);
    };

    // A limit on the whole call: a socket timeout only sees silence, not a server sending a byte at a time.
    const deadline = setTimeout(() => {
      finish({ body: '', failure: 'CI_TIMEOUT' });
      outgoing.destroy();
    }, CI_REQUEST_TIMEOUT_MS);

    let outgoing: ClientRequest;

    try {
      outgoing = request(
        target,
        {
          method,
          headers:
            body === null
              ? headers
              : { ...headers, 'content-length': Buffer.byteLength(body) },
          lookup,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;

          // Jenkins names the queued build only here.
          location = response.headers?.location;

          response.on('data', (chunk: Buffer) => {
            chunks.push(chunk.subarray(0, MAX_BODY_BYTES - size));
            size += chunk.length;

            // Only the start of the reply is kept, so a long one is not read to its end.
            if (size >= MAX_BODY_BYTES) {
              finish({
                status: response.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
              });
              outgoing.destroy();
            }
          });
          response.on('end', () =>
            finish({
              status: response.statusCode,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          response.on('error', () =>
            finish({ status: response.statusCode, body: '' }),
          );
        },
      );
    } catch {
      // Node refuses some header values at once; an uncaught throw here would end the process when the timer fires.
      return finish({ body: '', failure: 'CI_UNREACHABLE' });
    }

    outgoing.on('error', (error) =>
      finish({
        body: '',
        failure:
          error instanceof BlockedHostError
            ? 'CI_BLOCKED_HOST'
            : 'CI_UNREACHABLE',
      }),
    );

    if (body !== null) outgoing.write(body);
    outgoing.end();
  });
}
