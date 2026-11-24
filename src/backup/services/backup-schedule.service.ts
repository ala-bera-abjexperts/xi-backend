/**
 * @fileoverview Cron arithmetic and `backup_schedule_state` lifecycle.
 * @module src/backup/services/backup-schedule.service
 *
 * The scheduler reads `backup_schedule_state`, never `backup_schemes` — the scheme row carries the
 * archive KEK and has a BEFORE UPDATE trigger on `updated_at`, so a per-tick lease write there
 * would both touch a secret-bearing row and destroy "when did an admin last edit this scheme?".
 *
 * Every occurrence is computed forward from the CURRENT time, never from the previous
 * `next_run_at`. That single rule is what stops a DST-shifted hour compounding across runs, and it
 * makes the autumn double-fire impossible by construction rather than by a special case.
 */

import { createHash } from 'crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CronExpressionParser } from 'cron-parser';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  MIN_SCHEDULE_INTERVAL_SECONDS,
  MISFIRE_GRACE_SECONDS,
} from '../backup.constants';

const STATE_TABLE = 'backup_schedule_state';

/** Guards the occurrence counter against a pathological expression over a long outage. */
const MAX_COUNTED_OCCURRENCES = 500;

/** Standard cron is five fields. A sixth is a seconds field — see assertScheduleValid. */
const MAX_CRON_FIELDS = 5;

export interface ScheduleDefinition {
  cronExpression: string;
  timezone: string;
}

export type MisfireAction = 'run' | 'skip';

export interface MisfireDecision {
  action: MisfireAction;
  nextRunAt: Date;
  /** Windows that elapsed while nothing was running. Recorded, never replayed. */
  missedOccurrences: number;
}

export interface ScheduleStateUpsert {
  schemeId: string;
  organizationId: string;
  scheduleEnabled: boolean;
  status: string;
  cronExpression: string | null;
  timezone: string;
}

/**
 * True when Node's ICU database recognises the zone.
 *
 * `CronExpressionParser.parse()` accepts ANY string as `tz` — it only fails when the iterator is
 * advanced. So `'Europe/Berlin '` (trailing space), `'GMT+2'` and `'Not/AZone'` all parse cleanly
 * and then throw at `.next()`, i.e. inside the scheduler at 02:00 rather than at save time. An
 * empty string is worse: it silently falls back to the server's local zone.
 */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone || timezone !== timezone.trim()) {
    return false;
  }

  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });

    return true;
  } catch {
    return false;
  }
}

/**
 * Validates an expression the way the scheduler will actually use it.
 *
 * @throws BadRequestException when the zone is unknown, the expression carries a seconds field, or
 *   two consecutive fires would be closer together than the supported floor.
 */
export function assertScheduleValid(schedule: ScheduleDefinition): void {
  const { cronExpression, timezone } = schedule;

  if (!isValidTimezone(timezone)) {
    throw new BadRequestException(
      `'${timezone}' is not a recognised IANA time zone. Use a name such as 'Europe/Berlin' or 'UTC'.`,
    );
  }

  const fields = cronExpression.trim().split(/\s+/);

  if (fields.length > MAX_CRON_FIELDS) {
    throw new BadRequestException(
      'A backup schedule uses five cron fields (minute hour day month weekday). ' +
        'Per-second schedules are not supported.',
    );
  }

  let first: Date;
  let second: Date;

  try {
    // .next() is what actually validates the zone — parse() alone does not.
    const interval = CronExpressionParser.parse(cronExpression, {
      tz: timezone,
    });

    first = interval.next().toDate();
    second = interval.next().toDate();
  } catch (err) {
    throw new BadRequestException(
      `Invalid cron expression or time zone: ${(err as Error).message}`,
    );
  }

  const gapSeconds = (second.getTime() - first.getTime()) / 1000;

  if (gapSeconds < MIN_SCHEDULE_INTERVAL_SECONDS) {
    throw new BadRequestException(
      `This schedule would run every ${Math.round(gapSeconds)} seconds. ` +
        `The minimum interval is ${MIN_SCHEDULE_INTERVAL_SECONDS / 60} minutes.`,
    );
  }
}

/**
 * The next occurrence strictly after `after`.
 *
 * `after` MUST be the database clock. `cron-parser` returns the first occurrence after
 * `currentDate`, so passing a process clock that lags Postgres can yield a time that is already
 * due — which re-claims the scheme on the very next tick. The loop is belt-and-braces for that.
 */
export function computeNextRunAt(
  schedule: ScheduleDefinition,
  after: Date,
): Date {
  const interval = CronExpressionParser.parse(schedule.cronExpression, {
    currentDate: after,
    tz: schedule.timezone,
  });

  let next = interval.next().toDate();
  let guard = 0;

  while (next.getTime() <= after.getTime() && guard < 8) {
    next = interval.next().toDate();
    guard += 1;
  }

  return next;
}

/**
 * Counts elapsed windows between a due time and now, so an outage is visible rather than merely
 * absent. Capped — a long outage on a frequent schedule must not spin.
 */
export function countMissedOccurrences(
  schedule: ScheduleDefinition,
  from: Date,
  until: Date,
): number {
  const interval = CronExpressionParser.parse(schedule.cronExpression, {
    currentDate: from,
    tz: schedule.timezone,
  });

  let count = 0;

  while (count < MAX_COUNTED_OCCURRENCES) {
    const occurrence = interval.next().toDate();

    if (occurrence.getTime() > until.getTime()) {
      break;
    }

    count += 1;
  }

  return count;
}

/**
 * Decides what to do with a window that has already passed.
 *
 * At most ONE catch-up, bounded by the grace window. Never N queued runs: seven runs after a week
 * of downtime is a thundering herd against the customer's server, and under keep-last-N retention
 * six of them would be pruned on arrival.
 */
export function resolveMisfire(params: {
  schedule: ScheduleDefinition;
  dueAt: Date;
  now: Date;
  graceSeconds?: number;
}): MisfireDecision {
  const { schedule, dueAt, now } = params;
  const graceSeconds = params.graceSeconds ?? MISFIRE_GRACE_SECONDS;
  const latenessSeconds = (now.getTime() - dueAt.getTime()) / 1000;
  const nextRunAt = computeNextRunAt(schedule, now);

  if (latenessSeconds <= graceSeconds) {
    return { action: 'run', nextRunAt, missedOccurrences: 0 };
  }

  return {
    action: 'skip',
    nextRunAt,
    // dueAt itself is the first missed window, and countMissedOccurrences starts AFTER `from`.
    missedOccurrences: 1 + countMissedOccurrences(schedule, dueAt, now),
  };
}

/** Changes here must force a recompute — see BackupScheduleService.upsertState. */
export function cronFingerprint(schedule: ScheduleDefinition): string {
  return createHash('sha256')
    .update(`${schedule.cronExpression}|${schedule.timezone}`)
    .digest('hex')
    .slice(0, 32);
}

@Injectable()
export class BackupScheduleService {
  private readonly logger = new Logger(BackupScheduleService.name);

  /** Latch, so a missing RPC does not write one warning per tick, forever. */
  private clockRpcMissingLogged = false;

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * The database clock, which is the only authority for due-ness and lease staleness.
   *
   * Nothing else in this codebase reads it — every other scheduler uses `new Date()`. That is
   * survivable for them; here a process clock behind Postgres produces a `next_run_at` that is
   * already due, and the scheme is re-claimed every tick.
   */
  async now(): Promise<Date> {
    const { data, error } = (await this.db
      .rpc('backup_now')
      .single()) as unknown as {
      data: string | null;
      error: { message: string } | null;
    };

    if (error || !data) {
      // Falling back to the process clock is strictly better than failing the tick; the guard loop
      // in computeNextRunAt bounds the damage from skew. Latched because this is called on every
      // tick and the RPC ships in a migration the user applies separately.
      if (!this.clockRpcMissingLogged) {
        this.clockRpcMissingLogged = true;
        this.logger.warn(
          `Could not read the database clock (${error?.message ?? 'no row'}); ` +
            'falling back to the process clock until the backup_now() migration is applied',
        );
      }

      return new Date();
    }

    return new Date(data);
  }

  /**
   * Creates or refreshes the row the scheduler actually reads.
   *
   * `is_active` mirrors "scheduled AND active" because those live on `backup_schemes` while the
   * claim reads this table; without the mirror, turning a schedule off in the UI would not stop it.
   * `next_run_at` is recomputed only when the fingerprint moves, so an ordinary rename does not
   * silently move tonight's backup.
   */
  async upsertState(input: ScheduleStateUpsert): Promise<void> {
    const scheduled = Boolean(
      input.scheduleEnabled &&
      input.cronExpression &&
      input.status === 'active',
    );

    const schedule: ScheduleDefinition | null = input.cronExpression
      ? { cronExpression: input.cronExpression, timezone: input.timezone }
      : null;

    const fingerprint = schedule ? cronFingerprint(schedule) : null;
    const existing = await this.readState(input.schemeId);
    const fingerprintMoved = existing?.cron_fingerprint !== fingerprint;

    let nextRunAt: string | null = existing?.next_run_at ?? null;

    if (!scheduled || !schedule) {
      nextRunAt = null;
    } else if (fingerprintMoved || !nextRunAt) {
      nextRunAt = computeNextRunAt(schedule, await this.now()).toISOString();
    }

    const { error } = await this.db.from(STATE_TABLE).upsert(
      {
        scheme_id: input.schemeId,
        organization_id: input.organizationId,
        is_active: scheduled,
        next_run_at: nextRunAt,
        cron_fingerprint: fingerprint,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'scheme_id' },
    );

    if (error) {
      // Not fatal: the scheme itself is already written, and the tick reconciles missing state on
      // its next pass. Throwing here would fail a create whose row exists.
      this.logger.error(
        `Failed to upsert schedule state for scheme ${input.schemeId}: ${error.message}`,
      );
    }
  }

  private async readState(schemeId: string): Promise<{
    next_run_at: string | null;
    cron_fingerprint: string | null;
  } | null> {
    const { data, error } = (await this.db
      .from(STATE_TABLE)
      .select('next_run_at, cron_fingerprint')
      .eq('scheme_id', schemeId)
      .maybeSingle()) as unknown as {
      data: {
        next_run_at: string | null;
        cron_fingerprint: string | null;
      } | null;
      error: { message: string; code?: string } | null;
    };

    if (error && error.code !== 'PGRST116') {
      this.logger.warn(
        `Failed to read schedule state for scheme ${schemeId}: ${error.message}`,
      );
    }

    return data;
  }

  /** Reads `next_run_at` for many schemes at once, for the list response. */
  async nextRunByScheme(
    organizationId: string,
    schemeIds: string[],
  ): Promise<Record<string, string | null>> {
    if (!schemeIds.length) {
      return {};
    }

    const { data, error } = (await this.db
      .from(STATE_TABLE)
      .select('scheme_id, next_run_at')
      .eq('organization_id', organizationId)
      .in('scheme_id', schemeIds)) as unknown as {
      data: { scheme_id: string; next_run_at: string | null }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      this.logger.warn(`Failed to read schedule state: ${error.message}`);

      return {};
    }

    return Object.fromEntries(
      (data ?? []).map((row) => [row.scheme_id, row.next_run_at]),
    );
  }
}
