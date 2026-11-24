import { Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';

export const WORKER_BATCH_SIZE = 10;
export const WORKER_LEASE_DURATION_MS = 5 * 60 * 1000;
export const WORKER_BUDGET_MS = 50 * 1000;

export interface LeasedStep {
  id: string;
  run_id: string;
  node_id: string;
  node_kind: string;
  step_index: number;
  input: Record<string, unknown>;
  space_id: string;
  retry_count: number;
}

@Injectable()
export class AutomationQueueService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async leaseSteps(
    workerId: string,
    limit = WORKER_BATCH_SIZE,
  ): Promise<LeasedStep[]> {
    const now = new Date().toISOString();
    const leaseUntil = new Date(
      Date.now() + WORKER_LEASE_DURATION_MS,
    ).toISOString();

    // Step 0: find runs already advancing a node (a node executing, sleeping on a wait, or
    // paused). We never lease a second step for such a run — each automation run advances
    // strictly ONE node at a time, in wired order (never two nodes of the same run at once).
    const { data: activeRows, error: activeError } = await this.db
      .from('automation_run_steps')
      .select('run_id')
      .in('status', ['running', 'sleeping', 'paused']);

    if (activeError) throw activeError;

    const busyRunIds = Array.from(
      new Set((activeRows ?? []).map((r) => (r as { run_id: string }).run_id)),
    );

    // Step 1: candidate pending steps that are ready to run, in wired order. created_at
    // strictly increases in edge-insertion order; step_index/id are deterministic tiebreaks.
    // Busy runs are excluded so the bounded pool isn't spent on runs that can't be leased.
    let query = this.db
      .from('automation_run_steps')
      .select(
        'id, run_id, node_id, node_kind, step_index, input, space_id, retry_count',
      )
      .eq('status', 'pending')
      .or(`next_step_at.is.null,next_step_at.lte.${now}`);

    if (busyRunIds.length > 0) {
      query = query.not('run_id', 'in', `(${busyRunIds.join(',')})`);
    }

    const { data: candidates, error: selectError } = await query
      .order('created_at', { ascending: true })
      .order('step_index', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit * 20);

    if (selectError) throw selectError;
    if (!candidates || candidates.length === 0) return [];

    // Step 2: pick at most ONE step per run (its earliest-wired pending step), up to `limit`
    // distinct runs. Different runs still advance concurrently — only within-run parallelism
    // is removed.
    const pickedRunIds = new Set<string>();
    const ids: string[] = [];

    for (const c of candidates as { id: string; run_id: string }[]) {
      if (pickedRunIds.has(c.run_id)) continue;
      pickedRunIds.add(c.run_id);
      ids.push(c.id);
      if (ids.length >= limit) break;
    }

    if (ids.length === 0) return [];

    // Step 3: claim — the .eq('status', 'pending') guard prevents double-claiming.
    const { data: claimed, error: claimError } = await this.db
      .from('automation_run_steps')
      .update({
        status: 'running',
        lease_until: leaseUntil,
        worker_id: workerId,
      })
      .in('id', ids)
      .eq('status', 'pending')
      .select(
        'id, run_id, node_id, node_kind, step_index, input, space_id, retry_count',
      );

    if (claimError) throw claimError;

    return (claimed ?? []) as LeasedStep[];
  }

  async markStepSucceeded(
    stepId: string,
    output: unknown,
    durationMs?: number,
  ): Promise<void> {
    const { error } = await this.db
      .from('automation_run_steps')
      .update({
        status: 'succeeded',
        output,
        finished_at: new Date().toISOString(),
        duration_ms: durationMs ?? null,
        lease_until: null,
        worker_id: null,
        error_message: null,
      })
      .eq('id', stepId);
    if (error) throw error;
  }

  async markStepFailed(
    stepId: string,
    errorMessage: string,
    currentRetryCount: number,
    maxRetries = 3,
    retryDelayMs?: number,
  ): Promise<void> {
    if (currentRetryCount + 1 < maxRetries) {
      const backoffSec =
        retryDelayMs !== undefined
          ? retryDelayMs / 1000
          : Math.min(60, Math.pow(2, currentRetryCount + 1));
      const { error } = await this.db
        .from('automation_run_steps')
        .update({
          status: 'pending',
          retry_count: currentRetryCount + 1,
          next_step_at: new Date(Date.now() + backoffSec * 1000).toISOString(),
          error_message: errorMessage.slice(0, 1000),
          lease_until: null,
          worker_id: null,
        })
        .eq('id', stepId);
      if (error) throw error;
    } else {
      const { error } = await this.db
        .from('automation_run_steps')
        .update({
          status: 'failed',
          retry_count: currentRetryCount + 1,
          error_message: errorMessage.slice(0, 1000),
          finished_at: new Date().toISOString(),
          lease_until: null,
          worker_id: null,
        })
        .eq('id', stepId);
      if (error) throw error;
    }
  }

  async markStepSleeping(stepId: string, wakeupAt: Date): Promise<void> {
    const { error } = await this.db
      .from('automation_run_steps')
      .update({
        status: 'sleeping',
        wakeup_at: wakeupAt.toISOString(),
        lease_until: null,
        worker_id: null,
      })
      .eq('id', stepId);
    if (error) throw error;
  }

  async recoverStaleLeases(): Promise<number> {
    const now = new Date().toISOString();
    const { count } = await this.db
      .from('automation_run_steps')
      .select('id', { count: 'exact', head: true })
      .lt('lease_until', now)
      .eq('status', 'running');
    const toRecover = (count as number) ?? 0;
    if (toRecover === 0) return 0;
    const { error } = await this.db
      .from('automation_run_steps')
      .update({ status: 'pending', lease_until: null, worker_id: null })
      .lt('lease_until', now)
      .eq('status', 'running');
    if (error) throw error;
    return toRecover;
  }

  async wakeSleepingSteps(): Promise<number> {
    const now = new Date().toISOString();
    const { count } = await this.db
      .from('automation_run_steps')
      .select('id', { count: 'exact', head: true })
      .lt('wakeup_at', now)
      .eq('status', 'sleeping');
    const toWake = (count as number) ?? 0;
    if (toWake === 0) return 0;
    const { error } = await this.db
      .from('automation_run_steps')
      .update({ status: 'pending', wakeup_at: null })
      .lt('wakeup_at', now)
      .eq('status', 'sleeping');
    if (error) throw error;
    return toWake;
  }
}
