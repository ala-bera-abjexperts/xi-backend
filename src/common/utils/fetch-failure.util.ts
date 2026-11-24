/**
 * @fileoverview Turn undici's opaque `fetch failed` into something an operator can act on.
 *
 * Node's `fetch` reports every transport failure as the bare string "fetch failed" and hides the
 * real reason on `cause` — so a rejected TLS certificate, a refused connection, a DNS miss and a
 * timeout all surface identically. On a self-hosted deployment that is the difference between "add
 * your CA and re-run the deploy" and a support ticket with nothing to go on.
 *
 * Lives in `common/` because two independent callers need it: the migration HTTP client (Jira and
 * Confluence connections) and the form-builder integrations picker, which talks to the same Jira.
 *
 * @module src/common/utils/fetch-failure.util
 */

/**
 * Certificate VERIFICATION failures. Deliberately narrow: these are deterministic for a given host
 * and process trust store, because Node reads `NODE_EXTRA_CA_CERTS` once at startup — so they can
 * never resolve themselves mid-run, and retrying them only delays the message.
 *
 * Transport faults that genuinely are transient (`ECONNRESET`, `EPROTO`, `ECONNREFUSED`,
 * `ETIMEDOUT`) are deliberately NOT here and stay fully retryable.
 */
const TLS_CHAIN_CODES: ReadonlySet<string> = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** How far to follow `cause`. Node nests at most two levels in practice; the cap is a guard. */
const MAX_CAUSE_DEPTH = 4;

const REMEDY =
  " — the server's TLS certificate could not be verified. Put the issuing CA chain " +
  '(intermediate(s) + root, PEM) in ./certs/extra-ca.pem and re-run ./deploy.sh.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Walk the `cause` chain and return the first `code` found.
 *
 * Tolerates anything: strings, null, frozen objects, getters that throw, and cycles.
 */
export function fetchFailureCode(err: unknown): string | undefined {
  const seen = new WeakSet<object>();
  let current: unknown = err;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!isRecord(current) || seen.has(current)) return undefined;

    seen.add(current);

    try {
      const code = current.code;

      if (typeof code === 'string' && code.length > 0) return code;

      current = current.cause;
    } catch {
      // A throwing getter is not worth failing the caller's error path over.
      return undefined;
    }
  }

  return undefined;
}

/** True for a deterministic certificate-verification failure that retrying cannot fix. */
export function isTlsChainFailure(err: unknown): boolean {
  const code = fetchFailureCode(err);

  return code !== undefined && TLS_CHAIN_CODES.has(code);
}

/**
 * A human-readable description of a failed `fetch`, with the remedy when we know it.
 *
 * The remedy is attached ONLY for certificate codes. Suggesting a CA fix for `ECONNREFUSED` would
 * send an operator down the wrong path, which is worse than saying nothing.
 */
export function describeFetchFailure(err: unknown): string {
  const base =
    isRecord(err) && typeof err.message === 'string'
      ? err.message
      : 'request failed';

  const code = fetchFailureCode(err);
  const causeMsg =
    isRecord(err) &&
    isRecord(err.cause) &&
    typeof err.cause.message === 'string'
      ? err.cause.message
      : undefined;

  if (!code && !causeMsg) return base;

  const detail = `${base} (${[code, causeMsg].filter(Boolean).join(': ')})`;

  return code && TLS_CHAIN_CODES.has(code) ? `${detail}${REMEDY}` : detail;
}
