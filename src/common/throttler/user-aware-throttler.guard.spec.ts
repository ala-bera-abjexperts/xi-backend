// `jose` ships ESM-only and Jest's ts-jest transform cannot parse it (see the
// same mock in src/auth/oauth/*.spec.ts). Provide a faithful `decodeJwt` that
// base64url-decodes the payload segment, which is exactly what the real jose
// does and all the guard depends on, so the bucketing assertions stay meaningful.
jest.mock('jose', () => ({
  decodeJwt: (token: string) => {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');

    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  },
}));

import type { Request } from 'express';
import { UserAwareThrottlerGuard } from './user-aware-throttler.guard';

// Subclass to expose the protected getTracker for direct assertion. The guard's
// bucketing logic (not the @nestjs/throttler plumbing) is what we verify here.
class TestableThrottlerGuard extends UserAwareThrottlerGuard {
  public getTrackerPublic(req: Record<string, any>): Promise<string> {
    return this.getTracker(req);
  }
}

// Mints an unsigned, decodable HS256-shaped JWT carrying the given sub. getTracker
// only decodes (never verifies), so a fake signature is sufficient for tracking.
const makeJwt = (sub: string): string => {
  const b64 = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub })}.fakesignature`;
};

describe('UserAwareThrottlerGuard.getTracker', () => {
  let guard: TestableThrottlerGuard;

  beforeEach(() => {
    // ThrottlerGuard's constructor args are irrelevant to getTracker; cast past them.
    guard = new TestableThrottlerGuard(
      undefined as never,
      undefined as never,
      undefined as never,
    );
  });

  const req = (
    headers: Record<string, unknown>,
    ip = '203.0.113.7',
  ): Record<string, any> => ({ headers, ip }) as unknown as Request;

  it('buckets a request with ONLY x-mcp-s2s-authorization by user:<sub>', async () => {
    const tracker = await guard.getTrackerPublic(
      req({ 'x-mcp-s2s-authorization': `Bearer ${makeJwt('USER_A')}` }),
    );

    expect(tracker).toBe('user:USER_A');
  });

  it('buckets two distinct S2S subs into distinct buckets', async () => {
    const a = await guard.getTrackerPublic(
      req({ 'x-mcp-s2s-authorization': `Bearer ${makeJwt('USER_A')}` }),
    );
    const b = await guard.getTrackerPublic(
      req({ 'x-mcp-s2s-authorization': `Bearer ${makeJwt('USER_B')}` }),
    );

    expect(a).toBe('user:USER_A');
    expect(b).toBe('user:USER_B');
    expect(a).not.toBe(b);
  });

  it('keeps normal Authorization-bearer bucketing unchanged (user:<sub>)', async () => {
    const tracker = await guard.getTrackerPublic(
      req({ authorization: `Bearer ${makeJwt('USER_C')}` }),
    );

    expect(tracker).toBe('user:USER_C');
  });

  it('prefers the Authorization header over the S2S header when both are present', async () => {
    const tracker = await guard.getTrackerPublic(
      req({
        authorization: `Bearer ${makeJwt('AUTH_USER')}`,
        'x-mcp-s2s-authorization': `Bearer ${makeJwt('S2S_USER')}`,
      }),
    );

    expect(tracker).toBe('user:AUTH_USER');
  });

  it('falls back to ip:<addr> when neither token source is present', async () => {
    const tracker = await guard.getTrackerPublic(req({}, '198.51.100.42'));

    expect(tracker).toBe('ip:198.51.100.42');
  });

  it('falls back to ip when the S2S header is not a Bearer value', async () => {
    const tracker = await guard.getTrackerPublic(
      req({ 'x-mcp-s2s-authorization': 'not-a-bearer' }, '198.51.100.9'),
    );

    expect(tracker).toBe('ip:198.51.100.9');
  });

  // A @Public() route is never signature-checked downstream (SupabaseAuthGuard
  // short-circuits on it), so honouring a token's `sub` there would let a caller
  // pick their own bucket. handleRequest stamps this marker; getTracker must
  // ignore every token source once it is present.
  describe('public routes (PUBLIC_ROUTE marker set by handleRequest)', () => {
    const PUBLIC_ROUTE = Symbol.for('throttler.publicRoute');

    const publicReq = (
      headers: Record<string, unknown>,
      ip = '203.0.113.7',
    ): Record<string, any> =>
      ({ headers, ip, [PUBLIC_ROUTE]: true }) as unknown as Request;

    it('ignores a Bearer token and buckets by ip', async () => {
      const tracker = await guard.getTrackerPublic(
        publicReq(
          { authorization: `Bearer ${makeJwt('FORGED')}` },
          '198.51.100.5',
        ),
      );

      expect(tracker).toBe('ip:198.51.100.5');
    });

    it('gives a rotating forged sub the SAME bucket (the bypass this closes)', async () => {
      const a = await guard.getTrackerPublic(
        publicReq(
          { authorization: `Bearer ${makeJwt('RANDOM_1')}` },
          '198.51.100.5',
        ),
      );
      const b = await guard.getTrackerPublic(
        publicReq(
          { authorization: `Bearer ${makeJwt('RANDOM_2')}` },
          '198.51.100.5',
        ),
      );

      expect(a).toBe(b);
      expect(a).toBe('ip:198.51.100.5');
    });

    it('ignores the access_token cookie and the S2S header too', async () => {
      const tracker = await guard.getTrackerPublic(
        publicReq(
          {
            cookie: `access_token=${makeJwt('COOKIE_USER')}`,
            'x-mcp-s2s-authorization': `Bearer ${makeJwt('S2S_USER')}`,
          },
          '198.51.100.6',
        ),
      );

      expect(tracker).toBe('ip:198.51.100.6');
    });
  });
});
