/**
 * @fileoverview Integration tests for RedisThrottlerStorage against a real Redis.
 *
 * A rate limiter is a security control, and the two ways it fails are opposite
 * and both bad: counting too little (bypass) or counting forever (lockout). Both
 * come from the increment/expire pair not being atomic, which is exactly what the
 * Lua script exists to prevent — so these run against a real server rather than a
 * mock. Mocking Redis here would test the mock, not the atomicity.
 *
 * Skipped automatically when no Redis is reachable, so CI and on-prem checkouts
 * without Redis stay green.
 * @module src/common/throttler/redis-throttler.storage.spec
 */

import { createConnection } from 'net';
import { RedisThrottlerStorage } from './redis-throttler.storage';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

async function redisReachable(): Promise<boolean> {
  const { hostname, port } = new URL(REDIS_URL);

  return new Promise((resolve) => {
    const socket = createConnection(
      { host: hostname, port: Number(port || 6379) },
      () => {
        socket.destroy();
        resolve(true);
      },
    );

    socket.on('error', () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

describe('RedisThrottlerStorage', () => {
  let storage: RedisThrottlerStorage;
  let available = false;

  // Unique per run so repeated local runs never collide on leftover keys.
  const suffix = `${process.pid}-${Math.floor(Math.random() * 1e9)}`;

  beforeAll(async () => {
    available = await redisReachable();

    if (available) {
      storage = new RedisThrottlerStorage(REDIS_URL);

      // Commands issued before the socket is up reject instantly by design
      // (enableOfflineQueue: false), so wait for readiness or these tests would
      // measure the fail-open path rather than the Lua script.
      available = await storage.waitForReady();
    }
  });

  afterAll(() => {
    // Synchronous: onModuleDestroy uses disconnect(), which returns immediately.
    if (available && storage) storage.onModuleDestroy();
  });

  /**
   * Guard INSIDE the test body, not via `it.skip` at registration time.
   * `describe` callbacks run before `beforeAll`, so a registration-time check
   * would always see `available === false` and skip everything — including on a
   * machine where Redis is running.
   */
  function requireRedis(): boolean {
    if (!available) {
      console.warn(`[skipped] no Redis at ${REDIS_URL}`);
      return false;
    }

    return true;
  }

  it('counts hits within the window', async () => {
    if (!requireRedis()) return;

    const key = `count-${suffix}`;

    const first = await storage.increment(key, 10_000, 5, 0, 'default');
    const second = await storage.increment(key, 10_000, 5, 0, 'default');

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(second.isBlocked).toBe(false);
  });

  it('always sets a TTL on the counter — the lockout guard', async () => {
    if (!requireRedis()) return;

    const key = `ttl-${suffix}`;

    const record = await storage.increment(key, 10_000, 5, 0, 'default');

    // If INCR ever ran without a matching expire, timeToExpire would be <= 0 and
    // the key would live forever — permanently throttling that user.
    expect(record.timeToExpire).toBeGreaterThan(0);
    expect(record.timeToExpire).toBeLessThanOrEqual(10);
  });

  it('blocks once the limit is exceeded', async () => {
    if (!requireRedis()) return;

    const key = `block-${suffix}`;
    const limit = 3;

    for (let i = 0; i < limit; i++) {
      const r = await storage.increment(key, 10_000, limit, 5_000, 'default');
      expect(r.isBlocked).toBe(false);
    }

    const exceeded = await storage.increment(
      key,
      10_000,
      limit,
      5_000,
      'default',
    );

    expect(exceeded.isBlocked).toBe(true);
    expect(exceeded.timeToBlockExpire).toBeGreaterThan(0);
  });

  it('keeps a blocked caller blocked on subsequent calls', async () => {
    if (!requireRedis()) return;

    const key = `stay-blocked-${suffix}`;

    for (let i = 0; i < 3; i++) {
      await storage.increment(key, 10_000, 2, 5_000, 'default');
    }

    const again = await storage.increment(key, 10_000, 2, 5_000, 'default');

    expect(again.isBlocked).toBe(true);
  });

  it('isolates keys from each other', async () => {
    if (!requireRedis()) return;

    const a = await storage.increment(
      `iso-a-${suffix}`,
      10_000,
      5,
      0,
      'default',
    );
    const b = await storage.increment(
      `iso-b-${suffix}`,
      10_000,
      5,
      0,
      'default',
    );

    expect(a.totalHits).toBe(1);
    expect(b.totalHits).toBe(1);
  });

  it('counts concurrent increments exactly once each', async () => {
    if (!requireRedis()) return;

    const key = `concurrent-${suffix}`;

    // The whole reason for the Lua script: 20 simultaneous requests must produce
    // exactly 20 hits. A client-side read-modify-write would lose updates here,
    // silently letting callers exceed the limit.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        storage.increment(key, 10_000, 100, 0, 'default'),
      ),
    );

    const hits = results.map((r) => r.totalHits).sort((x, y) => x - y);

    expect(hits).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('fails OPEN when Redis is unreachable', async () => {
    if (!requireRedis()) return;

    // Availability, not throttling, is the priority: a dead limiter must not take
    // the API down with it.
    const broken = new RedisThrottlerStorage('redis://127.0.0.1:6390');

    const record = await broken.increment(
      `down-${suffix}`,
      10_000,
      5,
      0,
      'default',
    );

    expect(record.isBlocked).toBe(false);
    expect(record.totalHits).toBe(0);

    broken.onModuleDestroy();
  });
});
