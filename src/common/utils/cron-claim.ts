/**
 * @fileoverview Cross-instance claim for scheduled jobs, on the shared `cron_run_state` table.
 *
 * Every API replica runs the same timers, so a job that must run once per window first claims the
 * window here. The claim is a single compare-and-swap UPDATE (only one replica can move
 * `last_run_at` past the cut-off), with an INSERT ... ON CONFLICT DO NOTHING for the very first run
 * when no row exists yet. Both are atomic in Postgres, so two replicas can never both win.
 *
 * Only simple filters are used on the mutations — see postgrest-or-projection.coverage.spec.ts for
 * why `.or()` on an update is unsafe.
 * @module src/common/utils/cron-claim
 * @author Prince Jadiya
 */

import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

const logger = new Logger('CronClaim');

/** Written on release so the next claim's `lte(cut-off)` matches immediately. */
const RELEASED_AT = '1970-01-01T00:00:00.000Z';

/**
 * Claim `job` if it last ran at least `minIntervalMs` ago.
 *
 * @returns the stamp written when this instance won (pass it to {@link releaseCronSlot}), or null
 *   when another instance holds the slot or the database could not be asked — fail closed.
 */
export async function claimCronSlot(
  db: SupabaseClient<any, any>,
  job: string,
  minIntervalMs: number,
): Promise<string | null> {
  const stamp = new Date().toISOString();
  const cutoff = new Date(Date.now() - minIntervalMs).toISOString();

  try {
    const cas = await db
      .from('cron_run_state')
      .update({ last_run_at: stamp })
      .eq('job_name', job)
      .lte('last_run_at', cutoff)
      .select('job_name');

    if (cas.error) throw new Error(cas.error.message);
    if (cas.data?.length) return stamp;

    // No row moved: either another instance holds the slot, or the row does not exist yet. The
    // insert settles which — a row comes back only if we created it.
    const ins = await db
      .from('cron_run_state')
      .upsert(
        { job_name: job, last_run_at: stamp },
        { onConflict: 'job_name', ignoreDuplicates: true },
      )
      .select('job_name');

    if (ins.error) throw new Error(ins.error.message);

    return ins.data?.length ? stamp : null;
  } catch (err) {
    logger.error(
      `claim ${job} failed, skipping this run: ${(err as Error).message}`,
    );

    return null;
  }
}

/**
 * Give the slot back early so the next run need not wait out the interval. Fenced on `stamp`: if
 * another instance has since re-claimed the slot, its claim is left alone.
 */
export async function releaseCronSlot(
  db: SupabaseClient<any, any>,
  job: string,
  stamp: string,
): Promise<void> {
  try {
    const { error } = await db
      .from('cron_run_state')
      .update({ last_run_at: RELEASED_AT })
      .eq('job_name', job)
      .eq('last_run_at', stamp);

    if (error) throw new Error(error.message);
  } catch (err) {
    logger.warn(`release ${job} failed: ${(err as Error).message}`);
  }
}
