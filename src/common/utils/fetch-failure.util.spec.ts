/**
 * Unit tests for the fetch-failure describer (pure — no DI, no network).
 *
 * The regression these exist for: a customer's self-hosted Jira used an internal corporate CA, and
 * the connection wizard reported only `Network error calling GET /rest/api/2/serverInfo: fetch
 * failed`. The real cause sat on `err.cause.code` and was discarded, so a certificate problem, a
 * refused connection and a timeout were indistinguishable.
 */

import {
  describeFetchFailure,
  fetchFailureCode,
  isTlsChainFailure,
} from './fetch-failure.util';

/** The shape undici actually produces. */
const undiciError = (code: string, message = 'unable to verify') =>
  Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error(message), { code }),
  });

describe('fetchFailureCode', () => {
  it('reads err.cause.code — the shape undici produces', () => {
    expect(fetchFailureCode(undiciError('ECONNREFUSED'))).toBe('ECONNREFUSED');
  });

  it('reads a code nested one level deeper', () => {
    const err = Object.assign(new Error('fetch failed'), {
      cause: { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } },
    });

    expect(fetchFailureCode(err)).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  });

  it('returns undefined when no cause carries a code', () => {
    expect(fetchFailureCode(new Error('fetch failed'))).toBeUndefined();
    expect(fetchFailureCode({ cause: { message: 'nope' } })).toBeUndefined();
  });

  it('does not throw on primitives or nullish input', () => {
    for (const v of [null, undefined, 'boom', 42, true]) {
      expect(() => fetchFailureCode(v)).not.toThrow();
      expect(fetchFailureCode(v)).toBeUndefined();
    }
  });

  it('does not throw on a frozen object or a getter that throws', () => {
    expect(fetchFailureCode(Object.freeze({ cause: null }))).toBeUndefined();

    const nasty = {
      get code(): string {
        throw new Error('getter exploded');
      },
    };

    expect(() => fetchFailureCode(nasty)).not.toThrow();
    expect(fetchFailureCode(nasty)).toBeUndefined();
  });

  it('terminates on a circular cause chain', () => {
    const a: Record<string, unknown> = {};
    a.cause = a;

    expect(() => fetchFailureCode(a)).not.toThrow();
    expect(fetchFailureCode(a)).toBeUndefined();
  });

  it('stops at the depth cap rather than walking forever', () => {
    let deep: Record<string, unknown> = { code: 'DEEP' };
    for (let i = 0; i < 10; i++) deep = { cause: deep };

    expect(fetchFailureCode(deep)).toBeUndefined();
  });
});

describe('describeFetchFailure', () => {
  it('keeps the bare message when there is no cause — unchanged behaviour', () => {
    expect(describeFetchFailure(new Error('fetch failed'))).toBe(
      'fetch failed',
    );
  });

  it.each([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ])('%s names the CA remedy', (code) => {
    const msg = describeFetchFailure(undiciError(code));

    expect(msg).toContain(code);
    expect(msg).toContain('./certs/extra-ca.pem');
    expect(msg).toContain('./deploy.sh');
  });

  it('the exact customer case is now actionable', () => {
    // Previously this printed only "fetch failed".
    expect(
      describeFetchFailure(undiciError('UNABLE_TO_VERIFY_LEAF_SIGNATURE')),
    ).toMatch(/fetch failed .*UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  });

  it.each(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'])(
    '%s reports the code but suggests NO CA — a wrong remedy is worse than none',
    (code) => {
      const msg = describeFetchFailure(undiciError(code));

      expect(msg).toContain(code);
      expect(msg).not.toContain('extra-ca.pem');
    },
  );
});

describe('isTlsChainFailure', () => {
  it.each([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'CERT_HAS_EXPIRED',
  ])('true for %s', (code) => {
    expect(isTlsChainFailure(undiciError(code))).toBe(true);
  });

  it.each(['ECONNRESET', 'EPROTO', 'ECONNREFUSED', 'ETIMEDOUT'])(
    'false for %s — these stay retryable',
    (code) => {
      expect(isTlsChainFailure(undiciError(code))).toBe(false);
    },
  );

  it('false when there is no code at all', () => {
    expect(isTlsChainFailure(new Error('fetch failed'))).toBe(false);
  });
});
