// Automation runs — query and manage automation execution history and step logs.

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  findFirstActionableNodes,
  type DagDefinition,
} from './utils/dag-engine';
import type {
  IAutomationRun,
  IAutomationRunStep,
} from './interfaces/automation.interface';

@Injectable()
export class AutomationRunsService {
  private readonly logger = new Logger(AutomationRunsService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async listForAutomation(
    automationId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<IAutomationRun[]> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;

    let query = this.db
      .from('automation_runs')
      .select('*, automation_run_steps(count)')
      .eq('automation_id', automationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (offset > 0) {
      query = query.range(offset, offset + limit - 1);
    }

    const { data, error } = await query;

    if (error) {
      this.logger.error(`listForAutomation failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to list automation runs');
    }

    const runs = (data ?? []).map((r: any) => ({
      ...r,
      steps_count:
        (r.automation_run_steps as { count: number }[] | undefined)?.[0]
          ?.count ?? 0,
      automation_run_steps: undefined,
    }));

    return runs as IAutomationRun[];
  }

  async getById(runId: string, automationId?: string): Promise<IAutomationRun> {
    let query = this.db.from('automation_runs').select('*').eq('id', runId);

    if (automationId) {
      query = query.eq('automation_id', automationId);
    }

    const result = await query.single();

    if (result.error || !result.data) {
      throw new NotFoundException('Automation run not found');
    }

    return result.data as IAutomationRun;
  }

  async getSteps(runId: string): Promise<IAutomationRunStep[]> {
    const { data, error } = await this.db
      .from('automation_run_steps')
      .select('*')
      .eq('run_id', runId)
      .order('step_index', { ascending: true });

    if (error) {
      this.logger.error(`getSteps failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to get run steps');
    }

    return (data ?? []) as IAutomationRunStep[];
  }

  async getUserDisplayName(userId: string): Promise<string> {
    const { data } = await this.db
      .from('users')
      .select('first_name, last_name, email')
      .eq('id', userId)
      .maybeSingle();

    if (!data) return 'user';

    const name =
      `${(data.first_name as string) ?? ''} ${(data.last_name as string) ?? ''}`.trim();

    return name || (data.email as string) || 'user';
  }

  async cancelRun(
    automationId: string,
    runId: string,
    userId: string,
  ): Promise<{ runId: string }> {
    const cancelledBy = await this.getUserDisplayName(userId);
    const { data: run, error: runError } = await this.db
      .from('automation_runs')
      .select('id, status, started_at')
      .eq('id', runId)
      .eq('automation_id', automationId)
      .maybeSingle();

    if (runError || !run)
      throw new NotFoundException('Automation run not found');

    const runStatus = run.status as string;

    if (runStatus !== 'running' && runStatus !== 'queued') {
      throw new ConflictException(
        `Run cannot be cancelled: already ${runStatus}`,
      );
    }

    // Cancel every non-terminal step (pending/running/sleeping/paused) so none resume after cancel,
    // and clear any lease so a worker can't re-pick a step of this cancelled run.
    await this.db
      .from('automation_run_steps')
      .update({
        status: 'cancelled',
        error_message: `Cancelled by ${cancelledBy}`,
        lease_until: null,
        worker_id: null,
      })
      .eq('run_id', runId)
      .in('status', ['pending', 'running', 'sleeping', 'paused']);

    const startedAt = run.started_at as string | null;
    const durationMs = startedAt
      ? Date.now() - new Date(startedAt).getTime()
      : null;

    await this.db
      .from('automation_runs')
      .update({
        status: 'cancelled',
        error_message: `Cancelled by ${cancelledBy}`,
        finished_at: new Date().toISOString(),
        duration_ms: durationMs,
      })
      .eq('id', runId);

    return { runId };
  }

  async retryRun(
    automationId: string,
    runId: string,
  ): Promise<{ runId: string }> {
    const { data: originalRun, error: origError } = await this.db
      .from('automation_runs')
      .select(
        'automation_id, automation_version_id, space_id, organization_id, trigger_kind, trigger_payload',
      )
      .eq('id', runId)
      .eq('automation_id', automationId)
      .maybeSingle();

    if (origError || !originalRun)
      throw new NotFoundException('Automation run not found');

    const run = originalRun as {
      automation_id: string;
      automation_version_id: string;
      space_id: string;
      organization_id: string;
      trigger_kind: string;
      trigger_payload: Record<string, unknown> | null;
    };

    // Create a new run with same payload

    const { data: newRun, error: newRunError } = await this.db
      .from('automation_runs')
      .insert({
        automation_id: run.automation_id,
        automation_version_id: run.automation_version_id,
        space_id: run.space_id,
        organization_id: run.organization_id,
        trigger_kind: run.trigger_kind,
        trigger_payload: run.trigger_payload,
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (newRunError || !newRun) {
      this.logger.error(
        `retryRun new run creation failed: ${newRunError?.message}`,
      );
      throw new InternalServerErrorException('Failed to create retry run');
    }

    // Get the version definition to seed first actionable steps
    const { data: version } = await this.db
      .from('automation_versions')
      .select('definition')
      .eq('id', run.automation_version_id)
      .single();

    if (version?.definition) {
      let firstNodes: ReturnType<typeof findFirstActionableNodes> = [];

      try {
        firstNodes = findFirstActionableNodes(
          version.definition as DagDefinition,
        );
      } catch (err) {
        this.logger.error(
          `retryRun: findFirstActionableNodes failed: ${String(err)}`,
        );
      }

      const newRunId = (newRun as { id: string }).id;

      for (const node of firstNodes) {
        await this.db.from('automation_run_steps').insert({
          run_id: newRunId,
          space_id: run.space_id,
          node_id: node.id,
          node_kind: node.data?.kind ?? '',
          step_index: 1,
          status: 'pending',
          input: run.trigger_payload,
          retry_count: 0,
        });
      }
    }

    return { runId: newRun.id as string };
  }

  streamRun(runId: string): Observable<{ data: unknown }> {
    return new Observable((subscriber) => {
      let active = true;
      let lastHash = '';

      const poll = async () => {
        while (active) {
          const [{ data: run }, { data: steps }] = await Promise.all([
            this.db
              .from('automation_runs')
              .select('id, status, error_message, finished_at, duration_ms')
              .eq('id', runId)
              .maybeSingle(),
            this.db
              .from('automation_run_steps')
              .select(
                'id, node_id, node_kind, step_index, status, duration_ms, error_message, output, retry_count, input',
              )
              .eq('run_id', runId)
              .order('step_index', { ascending: true }),
          ]);

          const hash = JSON.stringify({ run, steps });
          if (hash !== lastHash) {
            lastHash = hash;
            subscriber.next({
              data: { type: 'update', run, steps: steps ?? [] },
            });
          }

          if (
            !run ||
            ['succeeded', 'failed', 'cancelled'].includes(
              (run as { status: string }).status,
            )
          ) {
            subscriber.next({ data: { type: 'done' } });
            subscriber.complete();
            active = false;
            return;
          }

          await new Promise((r) => setTimeout(r, 1500));
        }
      };

      poll().catch((err: unknown) => subscriber.error(err));

      return () => {
        active = false;
      };
    });
  }
}
