/** @fileoverview Cron-driven drainer that claims pending workflow_outbox rows and routes them to per-type dispatchers. @module src/workflow-outbox/workflow-outbox.processor @author Rajbha Manek */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { FireEventDispatcher } from './dispatchers/fire-event.dispatcher';
import { FireWebhookDispatcher } from './dispatchers/fire-webhook.dispatcher';
import { SendNotificationDispatcher } from './dispatchers/send-notification.dispatcher';
import { isOnPremReadOnly } from '../on-prem-license/read-only-flag';

/** Soft cap on rows claimed per tick — must stay aligned with the RPC default. */
const DRAIN_BATCH_SIZE = 50;

/** Maximum retry attempts before a row is moved to status='dead'. */
const MAX_ATTEMPTS = 5;

// `FOR UPDATE SKIP LOCKED` in the `drain_workflow_outbox` RPC only makes the
// claim itself atomic — two callers at the same instant get disjoint rows. It
// does NOT stop a row being handed out twice over time: the RPC re-hands any
// row left `in_progress` past its stale window, and a slow batch (50 rows x
// 15 s HTTP timeouts) can outlast that window. Double dispatch is prevented by
// three layers together:
//   1. the in-process guard on {@link WorkflowOutboxProcessor.drain}, so a tick
//      never stacks on one still running on this process;
//   2. claim_token fencing — every result write is filtered on the token the
//      claim handed us, so a worker whose row was reclaimed records nothing;
//   3. the RPC's 15-minute stale reclaim, well past any realistic batch.

/** Shape of a row returned by the drain_workflow_outbox RPC. */
export interface OutboxRow {
  id: string;
  organization_id: string;
  task_id: string;
  transition_id: string | null;
  rule_type: 'send_notification' | 'trigger_webhook' | 'fire_event';
  payload: Record<string, unknown>;
  status: 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'dead';
  attempt_count: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  /** Set by each claim; absent on rows claimed by an older RPC version. */
  claim_token?: string | null;
}

/**
 * Background drainer that runs once every 5 seconds. Each tick:
 *   1. Skips if another tick is already in flight on this Node process.
 *   2. Calls the server-side `drain_workflow_outbox` RPC, which reaps stale
 *      rows and atomically claims up to {@link DRAIN_BATCH_SIZE} pending rows.
 *   3. Routes each row to the matching dispatcher.
 *   4. Marks each row as `succeeded`, schedules a backoff retry, or moves it
 *      to the dead-letter state once attempts hit {@link MAX_ATTEMPTS}.
 *
 * If the RPC is not present at runtime (e.g. the helper migration has not
 * been applied yet) the tick logs a warning and exits cleanly — the processor
 * never crashes the host process at startup.
 */
@Injectable()
export class WorkflowOutboxProcessor {
  private static readonly TABLE = 'workflow_outbox';

  private readonly logger = new Logger(WorkflowOutboxProcessor.name);

  /** Cached after the first "RPC missing" log so we don't spam the console. */
  private rpcMissingLogged = false;

  /** In-process overlap guard — see header comment near `DRAIN_BATCH_SIZE`. */
  private working = false;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly sendNotification: SendNotificationDispatcher,
    private readonly fireWebhook: FireWebhookDispatcher,
    private readonly fireEvent: FireEventDispatcher,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Top of the 5-second cron. Skips when a previous tick is still in flight on
   * this process; errors are swallowed at the tick boundary so a crashing
   * dispatcher cannot stop the cron from firing the next tick. See the header
   * comment near `DRAIN_BATCH_SIZE` for how double dispatch is prevented.
   */
  @Cron('*/5 * * * * *')
  async drain(): Promise<void> {
    if (this.working) return;
    // On-prem past its licence grace: read-only, so no background writes.
    if (isOnPremReadOnly()) return;

    this.working = true;

    try {
      await this.drainOnce();
    } catch (err) {
      this.logger.error(
        `Unhandled error in workflow_outbox drain: ${(err as Error).message}`,
      );
    } finally {
      this.working = false;
    }
  }

  /**
   * Single-shot drain — separated from {@link drain} so tests can call it
   * directly without waiting on the cron decorator.
   */
  async drainOnce(): Promise<void> {
    const rows = await this.claimBatch();

    if (rows.length === 0) return;

    for (const row of rows) {
      try {
        await this.dispatch(row);
        await this.markSucceeded(row);
      } catch (err) {
        await this.handleFailure(row, err as Error);
      }
    }
  }

  /**
   * Calls the server-side claim helper. Returns an empty array when the RPC
   * is missing so the processor degrades gracefully before the migration is
   * applied.
   */
  private async claimBatch(): Promise<OutboxRow[]> {
    const { data, error } = (await this.client.rpc('drain_workflow_outbox', {
      batch_size: DRAIN_BATCH_SIZE,
    })) as {
      data: OutboxRow[] | null;
      error: { message: string; code?: string } | null;
    };

    if (error) {
      // PGRST202 / 42883 / "function … does not exist" — RPC not yet applied.
      const message = error.message ?? '';
      const code = (error as { code?: string }).code ?? '';

      if (
        code === 'PGRST202' ||
        code === '42883' ||
        /does not exist/i.test(message) ||
        /could not find the function/i.test(message)
      ) {
        if (!this.rpcMissingLogged) {
          this.logger.warn(
            'drain_workflow_outbox RPC is not present yet — skipping ticks until the migration is applied',
          );
          this.rpcMissingLogged = true;
        }

        return [];
      }
      this.logger.error(`drain_workflow_outbox RPC failed: ${message}`);

      return [];
    }

    return data ?? [];
  }

  /**
   * Route a claimed row to its dispatcher. The dispatcher payload contract is
   * unique per rule_type and is validated by the dispatcher itself.
   */
  private async dispatch(row: OutboxRow): Promise<void> {
    switch (row.rule_type) {
      case 'send_notification':
        await this.sendNotification.dispatch(
          row as unknown as Parameters<
            SendNotificationDispatcher['dispatch']
          >[0],
        );
        break;
      case 'trigger_webhook':
        await this.fireWebhook.dispatch(
          row as unknown as Parameters<FireWebhookDispatcher['dispatch']>[0],
        );
        break;
      case 'fire_event':
        await this.fireEvent.dispatch(
          row as unknown as Parameters<FireEventDispatcher['dispatch']>[0],
        );
        break;
      default:
        throw new Error(
          `Unknown rule_type "${String(row.rule_type)}" for outbox row ${row.id}`,
        );
    }
  }

  /**
   * Persist a successful dispatch. We deliberately keep the row around so
   * audit-log readers can correlate workflow events with their outbox row.
   */
  private async markSucceeded(row: OutboxRow): Promise<void> {
    const { error } = await this.updateClaimed(row, {
      status: 'succeeded',
      updated_at: new Date().toISOString(),
    });

    if (error) {
      this.logger.error(
        `Failed to mark outbox row ${row.id} as succeeded: ${error.message}`,
      );
    }
  }

  /**
   * Handle a dispatch failure. Increments attempt_count, schedules a
   * 2^attempt-second backoff, or moves the row to dead-letter once
   * {@link MAX_ATTEMPTS} is reached. `last_error` is always recorded.
   */
  private async handleFailure(row: OutboxRow, err: Error): Promise<void> {
    const nextAttemptCount = row.attempt_count + 1;
    const isDead = nextAttemptCount >= MAX_ATTEMPTS;
    const backoffSeconds = Math.pow(2, nextAttemptCount);
    const nextAttemptAt = new Date(
      Date.now() + backoffSeconds * 1000,
    ).toISOString();

    this.logger.warn(
      `Outbox row ${row.id} dispatch failed (attempt ${nextAttemptCount}/${MAX_ATTEMPTS}): ${err.message}`,
    );

    const patch: Record<string, unknown> = {
      attempt_count: nextAttemptCount,
      last_error: err.message,
      status: isDead ? 'dead' : 'pending',
      updated_at: new Date().toISOString(),
    };

    if (!isDead) {
      patch.next_attempt_at = nextAttemptAt;
    }

    const { error } = await this.updateClaimed(row, patch);

    if (error) {
      this.logger.error(
        `Failed to persist failure metadata for outbox row ${row.id}: ${error.message}`,
      );
    }
  }

  /**
   * Write a result onto a claimed row. When the claim carried a token the
   * write is fenced on it, so a row reclaimed by another worker is left alone;
   * 0 rows updated is logged and otherwise ignored (no retry, no dead-letter).
   */
  private async updateClaimed(
    row: OutboxRow,
    patch: Record<string, unknown>,
  ): Promise<{ error: { message: string } | null }> {
    let query = this.client
      .from(WorkflowOutboxProcessor.TABLE)
      .update(patch)
      .eq('id', row.id)
      .eq('organization_id', row.organization_id);

    if (row.claim_token)
      query = query
        .eq('status', 'in_progress')
        .eq('claim_token', row.claim_token);

    const { data, error } = await query.select('id');

    if (!error && !data?.length)
      this.logger.warn(
        `claim lost for ${WorkflowOutboxProcessor.TABLE} row ${row.id} (reclaimed by another worker) — not recording result`,
      );

    return { error };
  }
}
