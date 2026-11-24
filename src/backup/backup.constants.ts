/**
 * @fileoverview Tunable limits for the backup scheduler and worker.
 * @module src/backup/backup.constants
 *
 * Every value here is a deliberate trade-off rather than a round number, so the reasoning lives
 * next to the constant. Changing one without reading its note is how a scheduler starts dropping
 * occurrences or hammering a customer's server.
 */

import { hostname } from 'os';

/**
 * Identifies this process as a lease owner. Two replicas must never share it, or each will treat
 * the other's leases as its own and the ownership-conditional writes stop protecting anything.
 */
export const WORKER_ID =
  process.env.BACKUP_WORKER_ID ?? `${hostname()}-${process.pid}`;

/**
 * How long a claimed scheme stays leased.
 *
 * Deliberately short. This lease only covers "insert a run row and advance the schedule", which is
 * two statements — NOT the backup itself, which is covered by the run's own lease. A long lease
 * here silently drops occurrences: with a 15-minute lease, an every-five-minutes schedule fires
 * once and then skips the next two windows because the row is still leased.
 */
export const SCHEME_LEASE_MS = 60_000;

/** How long a leased run item stays owned before the reaper may reclaim it. */
export const ITEM_LEASE_MS = 600_000;

/** Schemes claimed per scheduler tick. */
export const SCHEME_CLAIM_LIMIT = 5;

/** Items leased per worker tick. */
export const ITEM_CLAIM_LIMIT = 4;

/**
 * Ceiling on a single run. A target that accepts the TCP connection and then stalls would otherwise
 * hold the run in flight forever — and because a non-terminal run sits inside
 * `backup_runs_one_active_per_scheme`, that also blocks every future run of the scheme.
 */
export const RUN_DEADLINE_MS = 21_600_000;

/**
 * How stale a non-terminal run must be before the reaper reclaims it.
 *
 * Must exceed the heartbeat interval, or the reaper races a worker that is alive and merely
 * between renewals.
 */
export const RUN_STALE_AFTER_MS = 300_000;

/**
 * How often a working worker touches its run so the reaper can tell "busy" from "dead".
 *
 * This is the ONLY thing that distinguishes the two: the reaper reads `backup_runs.updated_at`, and
 * the export loop writes to `backup_run_items`, which it does not read. Without a heartbeat, every
 * export lasting longer than RUN_STALE_AFTER_MS is reclaimed as abandoned and eventually failed —
 * which is exactly why no full-database backup had ever completed.
 *
 * A fifth of the staleness window, so four consecutive heartbeats can fail before a live run is
 * mistaken for a dead one. A third would leave room for only one missed write.
 */
export const HEARTBEAT_INTERVAL_MS = Math.floor(RUN_STALE_AFTER_MS / 5);

/** Attempts before a run is abandoned. Mirrors `backup_runs.max_attempts`. */
export const RUN_MAX_ATTEMPTS = 3;

/** Attempts before an item is marked `dead`. Mirrors `backup_run_items.max_attempts`. */
export const ITEM_MAX_ATTEMPTS = 5;

/**
 * How late a missed occurrence may still run. Past this the window is recorded as missed and the
 * schedule moves forward — one decision at recovery, never one run per missed window. Seven queued
 * runs after a week of downtime is a thundering herd, and with `keep_last_n` retention six of them
 * would be pruned immediately anyway.
 */
export const MISFIRE_GRACE_SECONDS = 3600;

/**
 * Floor on the interval between two fires of one scheme.
 *
 * `cron-parser` accepts six-field expressions, so an "every ten seconds" expression parses cleanly.
 * Such a scheme is always due, always collides with its own in-flight run, and becomes a
 * self-inflicted hot loop. Rejecting it at save time is the only place a human sees the error.
 *
 * Five minutes, not fifteen: an every-five-minutes backup is unusual but legitimate, and it merely
 * collides with itself (recorded as an overlap, harmless). Anything faster than the scheduler's own
 * tick is meaningless, so the floor sits just above it.
 */
export const MIN_SCHEDULE_INTERVAL_SECONDS = 300;

/** Consecutive failed runs before the scheme is paused and its owners told once. */
export const AUTO_PAUSE_AFTER_FAILURES = 10;

/** In-flight runs allowed per organization. */
export const ORG_CONCURRENT_RUN_LIMIT = 1;

/**
 * How long a cached restore archive may live before it is evicted.
 *
 * This is a security limit wearing a performance hat. The cached object is the DECRYPTED archive — a
 * plaintext copy of an entire tenant — so the question is not "how long is it still useful?" but "how
 * long are we willing to hold this?". A day covers the realistic pattern (preview, think, apply, and
 * the retry when the first apply hits a conflict) without leaving a tenant's data sitting in a bucket
 * over a weekend.
 *
 * Must stay well under `restore_approval_requests.expires_at` (7 days), which the bucket migration
 * already anchors to: an archive that outlived the approval it belongs to would be readable after the
 * authority to read it had lapsed.
 */
export const RESTORE_ARCHIVE_CACHE_TTL_MS = 86_400_000;

/**
 * How far `expires_at` is pushed forward while a restore is streaming a cached archive.
 *
 * Without this the reaper can delete an object mid-read: the sweep only looks at `expires_at`, and a
 * large archive can spend minutes being spooled. Comfortably longer than a read of the largest
 * cacheable archive (2 GiB, the bucket's own limit), and short enough that a crashed reader does not
 * pin the object for long past its real expiry.
 */
export const RESTORE_ARCHIVE_CACHE_LEASE_MS = 1_800_000;
