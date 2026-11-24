import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { AUTOMATION_BUCKET } from './test-automation-configs.service';

const NO_RUNNER_AFTER_MS = 60 * 60 * 1000;

// Far beyond the longest time limit of a run, so only a step that never ended gets here while its heartbeat goes on.
const STUCK_AFTER_MS = 24 * 60 * 60 * 1000;
const BATCH = 100;

interface StuckRun {
  id: string;
  run_zip_path: string | null;
  started_at?: string | null;
  organization_id?: string;
  status?: string;
}

/**
 * Closes runs nothing is working on any more: a runner that stopped answering, or no runner at all. It only reads and
 * writes the database, never Docker, and every write is conditional, so several API instances can run it safely.
 */
@Injectable()
export class TestAutomationReaperService {
  private readonly logger = new Logger(TestAutomationReaperService.name);
  private busy = false;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogs?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'tm-automation-reaper' })
  async reap(): Promise<void> {
    if (this.busy) return;

    this.busy = true;

    try {
      await this.closeInterrupted();
      await this.closeUnclaimed();
    } catch (error) {
      this.logger.error('Failed to close stuck automation runs', error);
    } finally {
      this.busy = false;
    }
  }

  private async closeInterrupted(): Promise<void> {
    const now = new Date().toISOString();
    const stuckBefore = new Date(Date.now() - STUCK_AFTER_MS).toISOString();
    const active = ['RUNNING', 'UPLOADING'];
    const { data, error } = await this.client
      .from('test_automation_runs')
      .select('id, run_zip_path, started_at, status, organization_id')
      .in('status', active)
      .or(`lease_until.lt."${now}",started_at.lt."${stuckBefore}"`)
      .limit(BATCH);

    if (error) throw new Error(error.message);

    for (const run of (data ?? []) as StuckRun[]) {
      if (
        run.started_at &&
        Date.parse(run.started_at) < Date.parse(stuckBefore)
      ) {
        await this.close(
          run,
          'INTERRUPTED',
          'The run stopped making progress',
          active,
        );
        continue;
      }

      await this.close(
        run,
        'INTERRUPTED',
        'The runner stopped answering during this run',
        active,
        now,
      );
    }
  }

  private async closeUnclaimed(): Promise<void> {
    const cutoff = new Date(Date.now() - NO_RUNNER_AFTER_MS).toISOString();
    const { data, error } = await this.client
      .from('test_automation_runs')
      .select('id, run_zip_path, organization_id, status')
      .eq('status', 'QUEUED')
      .lt('created_at', cutoff)
      .limit(BATCH);

    if (error) throw new Error(error.message);

    const runs = (data ?? []) as StuckRun[];

    // A run behind any active run is waiting its turn, and a runner is clearly there.
    if (runs.length === 0 || (await this.runnerIsWorking())) return;

    for (const run of runs) {
      await this.close(
        run,
        'NO_RUNNER',
        'No test runner picked up this run within an hour',
        ['QUEUED'],
      );
    }
  }

  private async runnerIsWorking(): Promise<boolean> {
    const { data, error } = await this.client
      .from('test_automation_runs')
      .select('id')
      .in('status', ['RUNNING', 'UPLOADING'])
      .gt('lease_until', new Date().toISOString())
      .limit(1);

    if (error) throw new Error(error.message);

    return ((data ?? []) as unknown[]).length > 0;
  }

  private async close(
    run: StuckRun,
    code: string,
    message: string,
    statuses: string[],
    leaseBefore?: string,
  ): Promise<void> {
    let write = this.client
      .from('test_automation_runs')
      .update({
        status: 'ERROR',
        error_code: code,
        error_message: message,
        finished_at: new Date().toISOString(),
        lease_until: null,
        run_zip_path: null,
      })
      .eq('id', run.id)
      .in('status', statuses);

    // A heartbeat that arrived since the read keeps the run alive.
    if (leaseBefore) write = write.lt('lease_until', leaseBefore);

    const closed = await write.select('id').maybeSingle();

    if (closed.error) throw new Error(closed.error.message);

    if (closed.data && run.organization_id) {
      void this.auditLogs?.logSystemAction(
        run.organization_id,
        'test_automation_run',
        run.id,
        'update',
        {
          action: 'timed_out',
          from_status: run.status ?? null,
          to_status: 'ERROR',
          error_code: code,
        },
      );
    }

    // Someone else got there first, and that one removes the copy.
    if (!closed.data || !run.run_zip_path) return;

    const { error } = await this.client.storage
      .from(AUTOMATION_BUCKET)
      .remove([run.run_zip_path]);

    if (error) this.logger.warn(`Failed to remove the zip of run ${run.id}`);
  }
}
