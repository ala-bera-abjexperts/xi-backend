/**
 * @fileoverview Redis-backed ThrottlerStorage, so rate limits are shared across
 * processes instead of counted per-process.
 * @module src/common/throttler/redis-throttler.storage
 */

import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { ThrottlerStorage } from '@nestjs/throttler';
// Not re-exported from the package index in v6 — import from its own module.
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';

/**
 * Increment-and-report, atomically, in one round trip.
 *
 * This MUST be a script rather than INCR-then-EXPIRE from the client: between
 * those two commands a second worker can observe a key with no TTL, and a
 * rate-limit counter that never expires locks a user out permanently. Doing it
 * server-side also means the whole read-modify-write is atomic across workers,
 * which is the entire point of moving off in-memory storage.
 *
 * Blocking is modelled with a second key so a blocked caller stays blocked for
 * `blockDuration` even once the hit window itself rolls over.
 *
 * Returns: [totalHits, ttlMs, isBlocked(0|1), blockTtlMs]
 */
const INCREMENT_SCRIPT = `
local hitsKey = KEYS[1]
local blockKey = KEYS[2]
local ttlMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockMs = tonumber(ARGV[3])

local blockTtl = redis.call('PTTL', blockKey)
if blockTtl > 0 then
  return { tonumber(redis.call('GET', hitsKey)) or limit, redis.call('PTTL', hitsKey), 1, blockTtl }
end

local hits = redis.call('INCR', hitsKey)
if hits == 1 then
  redis.call('PEXPIRE', hitsKey, ttlMs)
end

local hitsTtl = redis.call('PTTL', hitsKey)

if hits > limit and blockMs > 0 then
  redis.call('SET', blockKey, '1', 'PX', blockMs)
  return { hits, hitsTtl, 1, blockMs }
end

return { hits, hitsTtl, 0, 0 }
`;

@Injectable()
export class RedisThrottlerStorage
  implements ThrottlerStorage, OnModuleDestroy
{
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly redis: Redis;

  /**
   * Fail-open counters. If Redis is unreachable we must NOT reject traffic:
   * a rate limiter is a protection, and taking the whole API down because the
   * protection is unavailable turns a degraded dependency into an outage. We log
   * loudly instead, and the request proceeds unthrottled.
   */
  private degraded = false;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      // Keep reconnecting in the background rather than throwing on boot — the
      // app must start even if Redis is briefly down.
      lazyConnect: false,

      // Fail the individual command fast instead of queueing it; `increment`
      // already fails open, so a request should never wait on a sick Redis.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,

      // Back off, but cap it — an unbounded exponential delay means a recovered
      // Redis can stay unused for minutes.
      retryStrategy: (times: number) => Math.min(times * 200, 5_000),
    });

    this.redis.on('error', (err: Error) => {
      if (!this.degraded) {
        this.degraded = true;
        this.logger.error(
          `[throttler] Redis unavailable — failing OPEN (requests will not be throttled): ${err.message}`,
        );
      }
    });

    this.redis.on('ready', () => {
      if (this.degraded) {
        this.degraded = false;
        this.logger.log('[throttler] Redis recovered — throttling re-enabled');
      }
    });
  }

  /**
   * Resolves once the connection is usable, or false on timeout.
   *
   * `enableOfflineQueue: false` is the right PRODUCTION setting — a command
   * issued while the socket is down rejects instantly and `increment` fails open,
   * so a sick Redis costs zero request latency instead of queueing. The tradeoff
   * is a brief window at boot where commands reject before the socket is up.
   * Callers that need determinism (health checks, integration tests) await this
   * first; normal request traffic does not, and simply fails open for those few
   * milliseconds.
   */
  waitForReady(timeoutMs = 2_000): Promise<boolean> {
    if (this.redis.status === 'ready') return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.redis.off('ready', onReady);
        resolve(false);
      }, timeoutMs);

      const onReady = () => {
        clearTimeout(timer);
        resolve(true);
      };

      this.redis.once('ready', onReady);
    });
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `throttle:${throttlerName}:${key}:blocked`;

    try {
      const result = (await this.redis.eval(
        INCREMENT_SCRIPT,
        2,
        hitsKey,
        blockKey,
        String(ttl),
        String(limit),
        String(blockDuration),
      )) as [number, number, number, number];

      const [totalHits, ttlMs, isBlocked, blockTtlMs] = result;

      return {
        totalHits,
        timeToExpire: Math.max(0, Math.ceil(ttlMs / 1000)),
        isBlocked: isBlocked === 1,
        timeToBlockExpire: Math.max(0, Math.ceil(blockTtlMs / 1000)),
      };
    } catch (err) {
      this.logger.error(
        `[throttler] increment failed, allowing request: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );

      // Fail open — see `degraded` above.
      return {
        totalHits: 0,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  onModuleDestroy(): void {
    // `disconnect()`, not `quit()`. `quit()` waits for a reply, which never
    // arrives if the connection was never established — that hangs shutdown (and
    // hangs the test runner, since the retry timer keeps the event loop alive).
    // Nothing here needs a graceful drain: these are counters, not writes we
    // must not lose.
    this.redis.disconnect();
  }
}
