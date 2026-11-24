/**
 * @fileoverview Run lifecycle — start (seed stage 0 + freeze config), pause/resume/cancel,
 * retry-failed, list/get/items/logs, and the SSE state stream. Execution itself happens in
 * the background engine (worker + tick); this service only performs state transitions with
 * CONDITIONAL updates so racing requests can't corrupt the run state machine.
 *
 * All queries hand-scope `organization_id` — the service-role client bypasses RLS.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Observable, from, interval, of } from 'rxjs';
import { concatMap, startWith, switchMap, takeWhile } from 'rxjs/operators';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { MigrationQueueService } from '../engine/migration-queue.service';
import { StageRegistry } from '../engine/stages/stage.registry';
import {
  TERMINAL_RUN_STATUSES,
  type MigrationItemStatus,
  type MigrationRunItemRow,
  type MigrationRunRow,
  type MigrationRunStatus,
} from '../engine/stages/stage.interface';
import { MigrationJobsService } from './migration-jobs.service';

const RUNS = 'migration_runs';
const ITEMS = 'migration_run_items';
const LOGS = 'migration_logs';

const ACTIVE_RUN_STATUSES: MigrationRunStatus[] = [
  'queued',
  'preflight',
  'running',
  'paused',
  'sleeping',
];

const STREAM_POLL_MS = 2_000;
const RETRY_FAILED_MAX_ATTEMPTS = 8;
const JIRA_CLOUD_ADAPTER_CONTRACT = 'jira-cloud-v1';

interface CloudAdmissionJob {
  id: string;
  connection_id: string;
  source_kind: string;
  source_ref: string;
  scope: Record<string, unknown>;
  options: Record<string, unknown>;
}

interface CloudAdmissionConnection {
  id: string;
  product: string;
  deployment: string | null;
  base_url: string;
  auth_type: string;
  auth_username: string | null;
  encrypted_secret: string;
  encryption_iv: string;
  encryption_tag: string;
  metadata: Record<string, unknown> | null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );

    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

export interface RunStateSnapshot {
  run: MigrationRunRow;
  counts: Partial<Record<MigrationItemStatus, number>>;
  /**
   * The XISUITE space this run created/adopted (once the space stage has mapped it),
   * so the monitor can link straight to `/spaces/<key>/wiki`. Null until the space
   * exists, and for dry-runs (which only `plan` the space, never create it).
   */
  target_space?: { id: string; key: string; name: string | null } | null;
}

export interface MigrationLogRow {
  id: number;
  organization_id: string;
  run_id: string;
  run_item_id: string | null;
  level: string;
  stage: string | null;
  entity_type: string | null;
  source_ref: string | null;
  message: string;
  context: Record<string, unknown>;
  created_at: string;
}

@Injectable()
export class MigrationRunsService {
  private readonly logger = new Logger(MigrationRunsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly queue: MigrationQueueService,
    private readonly registry: StageRegistry,
    private readonly jobsService: MigrationJobsService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /**
   * Start a run for a saved job. One active run per job at a time; mode defaults
   * to the job's saved option (dry_run unless explicitly set otherwise).
   */
  async start(
    orgId: string,
    userId: string,
    jobId: string,
    modeOverride?: 'dry_run' | 'live',
  ): Promise<MigrationRunRow> {
    const job = await this.jobsService.get(orgId, jobId);

    const { data: active, error: activeError } = (await this.db
      .from(RUNS)
      .select('id, status')
      .eq('organization_id', orgId)
      .eq('job_id', jobId)
      .in('status', ACTIVE_RUN_STATUSES)
      .limit(1)) as {
      data: { id: string; status: string }[] | null;
      error: { message: string } | null;
    };

    if (activeError)
      throw new BadRequestException(
        `Failed to check active runs: ${activeError.message}`,
      );

    if (active && active.length > 0) {
      throw new ConflictException(
        `This job already has an active run (${active[0].status}) — pause/cancel it first`,
      );
    }

    const options = (job.options ?? {}) as { mode?: 'dry_run' | 'live' };
    const mode = modeOverride ?? options.mode ?? 'dry_run';
    const cloudAdmission = await this.prepareCloudAdmission(orgId, job, mode);
    const stagePlan = this.registry.planFor(job.source_kind);

    if (stagePlan.length === 0) {
      throw new BadRequestException(
        'No migration stages are available for this source kind yet',
      );
    }

    // Canonical stages this build cannot run. `planFor` drops them silently so that a newly
    // registered stage auto-joins the plan — but a run must never then claim it `succeeded` while
    // whole entity classes (e.g. `issues`) were never attempted. Frozen into the snapshot so the
    // tick can finalize honestly and the UI can say what was skipped.
    const unimplementedStages = this.registry.missingFor(job.source_kind);

    const { data, error } = (await this.db
      .from(RUNS)
      .insert({
        organization_id: orgId,
        job_id: job.id,
        connection_id: job.connection_id,
        mode,
        status: 'running',
        current_stage: stagePlan[0],
        stage_index: 0,
        config_snapshot: {
          scope: job.scope,
          options: job.options,
          stage_plan: stagePlan,
          unimplemented_stages: unimplementedStages,
          source_kind: job.source_kind,
          source_ref: job.source_ref,
          ...cloudAdmission,
        },
        correlation_id: randomUUID(),
        started_at: new Date().toISOString(),
        created_by: userId,
      })
      .select('*')
      .single()) as {
      data: MigrationRunRow | null;
      error: { message: string } | null;
    };

    if (error || !data)
      throw new BadRequestException(
        `Failed to start run: ${error?.message ?? 'no row returned'}`,
      );

    try {
      await this.queue.seedCollectionItem(data, stagePlan[0], 0);
    } catch (err) {
      // Without its first work item the run would drain "successfully" empty —
      // fail it explicitly instead so the UI shows the real problem.
      await this.db
        .from(RUNS)
        .update({
          status: 'failed',
          error_message: `Failed to seed initial work item: ${(err as Error).message}`,
          finished_at: new Date().toISOString(),
        })
        .eq('organization_id', orgId)
        .eq('id', data.id);

      throw new BadRequestException(
        `Run could not be started: ${(err as Error).message}`,
      );
    }

    await this.queue.log(
      orgId,
      data.id,
      null,
      'info',
      stagePlan[0],
      null,
      null,
      `Run started (${mode}) — plan: ${stagePlan.join(' → ')}`,
    );

    // Say it out loud, at start, in the run's own log — not just at the end. An operator watching
    // the monitor should learn that `issues` will never run BEFORE they wait for the run to finish.
    if (unimplementedStages.length > 0) {
      await this.queue.log(
        orgId,
        data.id,
        null,
        'warn',
        stagePlan[0],
        null,
        null,
        `This build has no handler for ${unimplementedStages.length} canonical stage(s): ` +
          `${unimplementedStages.join(', ')}. They will be SKIPPED — the run cannot report ` +
          `"succeeded" and will finish as "partially_completed".`,
      );
    }

    return data;
  }

  /**
   * Start a child run that repairs an already-finished live import. It deliberately reuses the
   * original job and connection but records its parent in the frozen snapshot, so the worker can
   * safely distinguish a repair from an ordinary import.
   */
  async repair(
    orgId: string,
    userId: string,
    sourceRunId: string,
    scope?: 'profile_macros',
  ): Promise<MigrationRunRow> {
    const source = await this.get(orgId, sourceRunId);

    if (
      source.mode !== 'live' ||
      !TERMINAL_RUN_STATUSES.includes(source.status)
    ) {
      throw new ConflictException(
        'Only a completed live migration run can be repaired',
      );
    }

    const job = await this.jobsService.get(orgId, source.job_id);
    const { data: active, error: activeError } = (await this.db
      .from(RUNS)
      .select('id')
      .eq('organization_id', orgId)
      .eq('job_id', job.id)
      .in('status', ACTIVE_RUN_STATUSES)
      .limit(1)) as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (activeError)
      throw new BadRequestException(
        `Failed to check active runs: ${activeError.message}`,
      );
    if (active?.length)
      throw new ConflictException('This job already has an active run');

    const cloudAdmission = await this.prepareCloudAdmission(orgId, job, 'live');
    if (
      scope &&
      (scope !== 'profile_macros' || job.source_kind !== 'confluence_space')
    )
      throw new BadRequestException(
        'Profile macro repair requires a Confluence space',
      );
    const stagePlan =
      scope === 'profile_macros'
        ? ['confluence_page_repair', 'verify']
        : this.registry.repairPlanFor(job.source_kind);
    if (!stagePlan.length)
      throw new BadRequestException(
        'No repair stages are available for this source kind',
      );
    const unimplementedStages = this.registry.missingFor(job.source_kind);

    const { data, error } = (await this.db
      .from(RUNS)
      .insert({
        organization_id: orgId,
        job_id: job.id,
        connection_id: job.connection_id,
        mode: 'live',
        status: 'running',
        current_stage: stagePlan[0],
        stage_index: 0,
        config_snapshot: {
          scope: job.scope,
          options: job.options,
          stage_plan: stagePlan,
          unimplemented_stages: unimplementedStages,
          source_kind: job.source_kind,
          source_ref: job.source_ref,
          repair_of_run_id:
            scope === 'profile_macros' &&
            typeof source.config_snapshot.repair_of_run_id === 'string'
              ? source.config_snapshot.repair_of_run_id
              : source.id,
          ...(scope ? { repair_scope: scope } : {}),
          ...cloudAdmission,
        },
        correlation_id: randomUUID(),
        started_at: new Date().toISOString(),
        created_by: userId,
      })
      .select('*')
      .single()) as {
      data: MigrationRunRow | null;
      error: { message: string } | null;
    };

    if (error || !data)
      throw new BadRequestException(
        `Failed to start repair run: ${error?.message ?? 'no row returned'}`,
      );

    try {
      await this.queue.seedCollectionItem(data, stagePlan[0], 0);
    } catch (err) {
      await this.db
        .from(RUNS)
        .update({
          status: 'failed',
          error_message: `Failed to seed repair run: ${(err as Error).message}`,
          finished_at: new Date().toISOString(),
        })
        .eq('organization_id', orgId)
        .eq('id', data.id);
      throw new BadRequestException(
        `Repair run could not be started: ${(err as Error).message}`,
      );
    }

    await this.queue.log(
      orgId,
      data.id,
      null,
      'info',
      stagePlan[0],
      null,
      null,
      `Repair run started for ${sourceRunId} — plan: ${stagePlan.join(' → ')}`,
      { repairOfRunId: sourceRunId },
    );

    if (unimplementedStages.length > 0) {
      await this.queue.log(
        orgId,
        data.id,
        null,
        'warn',
        stagePlan[0],
        null,
        null,
        `This build has no handler for ${unimplementedStages.length} canonical stage(s): ` +
          `${unimplementedStages.join(', ')}. They will be skipped. The run cannot report ` +
          `"succeeded" and will finish as "partially_completed".`,
      );
    }

    return data;
  }

  /** Jira Cloud dry runs are open; live runs need an unchanged, exactly reconciled dry run. */
  private async prepareCloudAdmission(
    orgId: string,
    job: CloudAdmissionJob,
    mode: 'dry_run' | 'live',
  ): Promise<Record<string, unknown>> {
    if (job.source_kind !== 'jira_project') return {};

    const { data, error } = (await this.db
      .from('migration_connections')
      .select(
        'id, product, deployment, base_url, auth_type, auth_username, ' +
          'encrypted_secret, encryption_iv, encryption_tag, metadata',
      )
      .eq('organization_id', orgId)
      .eq('id', job.connection_id)
      .maybeSingle()) as {
      data: CloudAdmissionConnection | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(
        `Failed to read connection: ${error.message}`,
      );

    if (!data) throw new BadRequestException('Migration connection not found');

    const cloudHost = (() => {
      try {
        return /\.atlassian\.net$/i.test(new URL(data.base_url).hostname);
      } catch {
        return false;
      }
    })();
    const isCloud =
      data.product === 'jira' && (data.deployment === 'cloud' || cloudHost);

    if (!isCloud) return {};

    const fingerprint = createHash('sha256')
      .update(
        canonicalJson({
          contract: JIRA_CLOUD_ADAPTER_CONTRACT,
          job: {
            source_kind: job.source_kind,
            source_ref: job.source_ref,
            scope: job.scope,
            options: job.options,
          },
          connection: {
            id: data.id,
            product: data.product,
            deployment: cloudHost ? 'cloud' : data.deployment,
            base_url: data.base_url,
            auth_type: data.auth_type,
            auth_username: data.auth_username,
            metadata: data.metadata ?? {},
            credential: {
              encrypted_secret: data.encrypted_secret,
              encryption_iv: data.encryption_iv,
              encryption_tag: data.encryption_tag,
            },
          },
        }),
      )
      .digest('hex');
    const snapshot = {
      cloud_adapter_contract: JIRA_CLOUD_ADAPTER_CONTRACT,
      cloud_readiness_fingerprint: fingerprint,
    };

    if (mode === 'dry_run') return snapshot;

    const dryRun = await this.findVerifiedCloudDryRun(orgId, job, fingerprint);

    return {
      ...snapshot,
      cloud_verified_dry_run_id: dryRun.id,
    };
  }

  private async findVerifiedCloudDryRun(
    orgId: string,
    job: CloudAdmissionJob,
    fingerprint: string,
  ): Promise<MigrationRunRow> {
    const { data, error } = (await this.db
      .from(RUNS)
      .select('*')
      .eq('organization_id', orgId)
      .eq('job_id', job.id)
      .eq('connection_id', job.connection_id)
      .eq('mode', 'dry_run')
      .eq('status', 'succeeded')
      .filter(
        'config_snapshot->>cloud_readiness_fingerprint',
        'eq',
        fingerprint,
      )
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle()) as {
      data: MigrationRunRow | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Failed to verify Jira Cloud dry run: ${error.message}`,
      );
    }
    if (!data) this.rejectUnverifiedCloudLive();

    const plan = data.config_snapshot?.stage_plan;
    const unimplemented = data.config_snapshot?.unimplemented_stages;
    const reconciliations = (
      data.totals?.verification as
        | { reconciliations?: Record<string, unknown>[] }
        | undefined
    )?.reconciliations;
    const issues = reconciliations?.find(
      (entry) => entry.entityType === 'issue',
    );
    const exact =
      typeof issues?.sourceCount === 'number' &&
      typeof issues?.targetCount === 'number' &&
      issues.shortfall === 0 &&
      issues.sourceCount === issues.targetCount;

    if (
      !Array.isArray(plan) ||
      plan.length === 0 ||
      !Array.isArray(unimplemented) ||
      unimplemented.length > 0 ||
      !exact
    ) {
      this.rejectUnverifiedCloudLive();
    }

    const { count, error: itemError } = await this.db
      .from(ITEMS)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('run_id', data.id)
      .in('status', ['failed', 'dead', 'blocked']);

    if (itemError) {
      throw new BadRequestException(
        `Failed to verify Jira Cloud dry-run items: ${itemError.message}`,
      );
    }
    if ((count ?? 0) > 0) this.rejectUnverifiedCloudLive();

    const { data: collections, error: collectionError } = (await this.db
      .from(ITEMS)
      .select('stage, status')
      .eq('organization_id', orgId)
      .eq('run_id', data.id)
      .eq('item_kind', 'collection')
      .in('status', ['succeeded', 'skipped'])) as {
      data: { stage: string; status: string }[] | null;
      error: { message: string } | null;
    };

    if (collectionError) {
      throw new BadRequestException(
        `Failed to verify Jira Cloud stage coverage: ${collectionError.message}`,
      );
    }

    const covered = new Set((collections ?? []).map((row) => row.stage));

    if (!(plan as string[]).every((stage) => covered.has(stage))) {
      this.rejectUnverifiedCloudLive();
    }

    return data;
  }

  private rejectUnverifiedCloudLive(): never {
    throw new ConflictException(
      'Jira Cloud live migration requires a matching successful dry run with every stage complete ' +
        'and an exact zero-shortfall issue reconciliation. Run this saved migration in dry-run ' +
        'mode after its latest configuration or connection change, then try live mode again.',
    );
  }

  /**
   * P11 — the guarded undo: delete everything a job's runs created.
   *
   * Thin on purpose. All the ordering and safety logic lives in the `delete_migration_targets` RPC,
   * because reverse-dependency deletion has to be one transaction: a half-undo (tasks gone, statuses
   * left, crosswalk intact) is worse than no undo at all — it leaves the job unable to re-import and
   * the target in a state nobody designed.
   *
   * Refuses while a run is active. Undoing underneath a live writer would race the engine, and the
   * crosswalk rows it is still creating would survive the delete.
   */
  async deleteTargets(
    orgId: string,
    jobId: string,
    confirmJobName: string,
  ): Promise<Record<string, unknown>> {
    const job = await this.jobsService.get(orgId, jobId);

    // Retyping the job name is the whole guard. It is deliberately not a boolean: this deletes a
    // customer's migrated work and must be impossible to trigger by reflex.
    if (confirmJobName.trim() !== job.name.trim()) {
      throw new BadRequestException(
        `Confirmation does not match. To undo this migration, send the job's exact name: "${job.name}"`,
      );
    }

    const { data: active, error: activeError } = (await this.db
      .from(RUNS)
      .select('id, status')
      .eq('organization_id', orgId)
      .eq('job_id', jobId)
      .in('status', ACTIVE_RUN_STATUSES)
      .limit(1)) as {
      data: { id: string; status: string }[] | null;
      error: { message: string } | null;
    };

    if (activeError)
      throw new BadRequestException(
        `Failed to check active runs: ${activeError.message}`,
      );

    if (active && active.length > 0) {
      throw new ConflictException(
        `This job has an active run (${active[0].status}) — pause or cancel it before undoing.`,
      );
    }

    // `rpc()` is untyped here (no generated DB types), so the shape is asserted explicitly rather
    // than destructured out of `any`.
    const { data, error } = (await this.db.rpc('delete_migration_targets', {
      p_organization_id: orgId,
      p_job_id: jobId,
    })) as {
      data: unknown;
      error: { message: string; code?: string } | null;
    };

    if (error) {
      // 42883 = the function does not exist: the migration has not been applied yet. Say exactly
      // that rather than surfacing a raw Postgres error — it is an operator action, not a bug.
      if (error.code === '42883') {
        throw new BadRequestException(
          'The undo function is not installed on this database. Apply ' +
            'supabase/migrations/20260716230000_delete_migration_targets.sql first.',
        );
      }

      throw new BadRequestException(`Undo failed: ${error.message}`);
    }

    return (data ?? {}) as Record<string, unknown>;
  }

  /** running → paused. In-flight leased items finish; nothing new is leased. */
  async pause(orgId: string, runId: string): Promise<MigrationRunRow> {
    return this.transition(orgId, runId, ['running'], 'paused', 'pause');
  }

  /** paused → running. */
  async resume(orgId: string, runId: string): Promise<MigrationRunRow> {
    return this.transition(orgId, runId, ['paused'], 'running', 'resume');
  }

  /** Any active status → cancelled; open items become skipped (running ones finish and lose their write race). */
  async cancel(orgId: string, runId: string): Promise<MigrationRunRow> {
    const run = await this.transition(
      orgId,
      runId,
      ACTIVE_RUN_STATUSES,
      'cancelled',
      'cancel',
      { finished_at: new Date().toISOString() },
    );

    const { error } = await this.db
      .from(ITEMS)
      .update({
        status: 'skipped',
        error_message: 'Run cancelled',
        lease_until: null,
        worker_id: null,
      })
      .eq('organization_id', orgId)
      .eq('run_id', runId)
      .in('status', ['pending', 'running', 'sleeping', 'blocked', 'paused']);

    if (error)
      this.logger.warn(`Cancel: skipping open items failed: ${error.message}`);

    await this.queue.log(
      orgId,
      runId,
      null,
      'warn',
      null,
      null,
      null,
      'Run cancelled',
    );

    return run;
  }

  /**
   * Re-queue failed/dead items of a finished (or stuck) run and reopen it.
   * Attempt counters reset so the items get a full retry budget again.
   */
  async retryFailed(orgId: string, runId: string): Promise<MigrationRunRow> {
    const run = await this.get(orgId, runId);

    if (
      ![
        'partially_completed',
        'failed',
        'cancelled',
        'running',
        'paused',
      ].includes(run.status)
    ) {
      throw new ConflictException(
        `Cannot retry a run in status "${run.status}"`,
      );
    }

    const { count: retryable, error: countError } = await this.db
      .from(ITEMS)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('run_id', runId)
      .in('status', ['failed', 'dead']);
    if (countError)
      throw new BadRequestException(
        `Retry lookup failed: ${countError.message}`,
      );
    if (!retryable)
      throw new BadRequestException('This run has no failed items to retry');

    // Stop new leases while invalidating verification and resetting work. In-flight verifiers
    // retain their old generation, so the atomic totals write cannot publish a stale result.
    if (run.status === 'running') {
      const { data: paused, error: pauseError } = await this.db
        .from(RUNS)
        .update({ status: 'paused' })
        .eq('organization_id', orgId)
        .eq('id', runId)
        .eq('status', 'running')
        .select('id');
      if (pauseError || !paused?.length)
        throw new ConflictException('Run state changed — retry again');
    }
    const { error: staleError } = await this.db.rpc(
      'migration_merge_run_totals',
      {
        p_org_id: orgId,
        p_run_id: runId,
        p_patch: { verification: { stale: true, generation: randomUUID() } },
      },
    );
    if (staleError)
      throw new BadRequestException(
        `Retry verification reset failed: ${staleError.message}`,
      );

    const { data: reset, error } = (await this.db
      .from(ITEMS)
      .update({
        status: 'pending',
        retry_count: 0,
        max_attempts: RETRY_FAILED_MAX_ATTEMPTS,
        next_retry_at: null,
        wakeup_at: null,
        error_class: null,
        error_message: null,
        started_at: null,
        finished_at: null,
        duration_ms: null,
      })
      .eq('organization_id', orgId)
      .eq('run_id', runId)
      .neq('stage', 'verify')
      .in('status', ['failed', 'dead'])
      .select('id')) as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(
        `Retry-failed reset failed: ${error.message}`,
      );

    // Reopen a terminal run so the engine picks the reset items up again.
    if (
      TERMINAL_RUN_STATUSES.includes(run.status) ||
      run.status === 'running'
    ) {
      const { data: reopened, error: reopenError } = (await this.db
        .from(RUNS)
        .update({
          status: 'running',
          started_at: new Date().toISOString(),
          finished_at: null,
          duration_ms: null,
          error_message: null,
        })
        .eq('organization_id', orgId)
        .eq('id', runId)
        .eq('status', run.status === 'running' ? 'paused' : run.status)
        .select('*')) as {
        data: MigrationRunRow[] | null;
        error: { message: string } | null;
      };

      if (reopenError || !reopened || reopened.length === 0)
        throw new ConflictException('Run state changed — retry again');

      await this.queue.log(
        orgId,
        runId,
        null,
        'info',
        null,
        null,
        null,
        `Retrying ${reset?.length ?? 0} failed item(s) and refreshing verification`,
      );

      return reopened[0];
    }

    return this.get(orgId, runId);
  }

  private async transition(
    orgId: string,
    runId: string,
    fromStatuses: MigrationRunStatus[],
    toStatus: MigrationRunStatus,
    action: string,
    extra: Record<string, unknown> = {},
  ): Promise<MigrationRunRow> {
    // Existence check first so callers get 404 (not 409) for unknown runs.
    await this.get(orgId, runId);

    const { data, error } = (await this.db
      .from(RUNS)
      .update({ status: toStatus, ...extra })
      .eq('organization_id', orgId)
      .eq('id', runId)
      .in('status', fromStatuses)
      .select('*')) as {
      data: MigrationRunRow[] | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(
        `Failed to ${action} run: ${error.message}`,
      );

    if (!data || data.length === 0)
      throw new ConflictException(
        `Cannot ${action} — the run is not in a valid state for that action`,
      );

    return data[0];
  }

  // ───────────────────────────── reads ─────────────────────────────

  async list(orgId: string, jobId?: string): Promise<MigrationRunRow[]> {
    let query = this.db
      .from(RUNS)
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (jobId) query = query.eq('job_id', jobId);

    const { data, error } = (await query) as {
      data: MigrationRunRow[] | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(`Failed to list runs: ${error.message}`);

    return data ?? [];
  }

  async get(orgId: string, runId: string): Promise<MigrationRunRow> {
    const { data, error } = (await this.db
      .from(RUNS)
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', runId)
      .maybeSingle()) as {
      data: MigrationRunRow | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(`Failed to load run: ${error.message}`);
    if (!data) throw new NotFoundException('Migration run not found');

    return data;
  }

  async getState(orgId: string, runId: string): Promise<RunStateSnapshot> {
    const run = await this.get(orgId, runId);
    const counts: Partial<Record<MigrationItemStatus, number>> = {};

    const statuses: MigrationItemStatus[] = [
      'pending',
      'running',
      'sleeping',
      'blocked',
      'succeeded',
      'failed',
      'skipped',
      'dead',
    ];

    for (const status of statuses) {
      const { count } = await this.db
        .from(ITEMS)
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('run_id', runId)
        .eq('status', status);

      counts[status] = count ?? 0;
    }

    const targetSpace = await this.resolveTargetSpace(orgId, run);

    return { run, counts, target_space: targetSpace };
  }

  /**
   * Resolve the real XISUITE space a run created/adopted via the `space` crosswalk row,
   * reading the authoritative `key`/`name` from the `spaces` table (works for both the
   * derived-key create path and the adopt path). Returns null until the space is `mapped`.
   */
  private async resolveTargetSpace(
    orgId: string,
    run: MigrationRunRow,
  ): Promise<{ id: string; key: string; name: string | null } | null> {
    const snapshot = (run.config_snapshot ?? {}) as { source_ref?: string };
    const sourceRef = snapshot.source_ref;

    if (!sourceRef) return null;

    const { data: crosswalk } = (await this.db
      .from('migration_entity_map')
      .select('target_id')
      .eq('organization_id', orgId)
      .eq('source_connection_id', run.connection_id)
      .eq('entity_type', 'space')
      .eq('source_id', sourceRef)
      .eq('status', 'mapped')
      .maybeSingle()) as { data: { target_id: string } | null };

    if (!crosswalk?.target_id) return null;

    const { data: space } = (await this.db
      .from('spaces')
      .select('id, key, name')
      .eq('organization_id', orgId)
      .eq('id', crosswalk.target_id)
      .maybeSingle()) as {
      data: { id: string; key: string; name: string | null } | null;
    };

    return space ? { id: space.id, key: space.key, name: space.name } : null;
  }

  async items(
    orgId: string,
    runId: string,
    filters: {
      status?: string;
      stage?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<MigrationRunItemRow[]> {
    await this.get(orgId, runId);

    let query = this.db
      .from(ITEMS)
      .select('*')
      .eq('organization_id', orgId)
      .eq('run_id', runId)
      .order('stage_order', { ascending: true })
      .order('created_at', { ascending: true })
      .range(
        filters.offset ?? 0,
        (filters.offset ?? 0) + Math.min(filters.limit ?? 100, 500) - 1,
      );

    if (filters.status) query = query.eq('status', filters.status);
    if (filters.stage) query = query.eq('stage', filters.stage);

    const { data, error } = (await query) as {
      data: MigrationRunItemRow[] | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(`Failed to list items: ${error.message}`);

    return data ?? [];
  }

  async logs(
    orgId: string,
    runId: string,
    filters: { level?: string; limit?: number },
  ): Promise<MigrationLogRow[]> {
    await this.get(orgId, runId);

    let query = this.db
      .from(LOGS)
      .select('*')
      .eq('organization_id', orgId)
      .eq('run_id', runId)
      .order('created_at', { ascending: false })
      .limit(Math.min(filters.limit ?? 200, 1000));

    if (filters.level) query = query.eq('level', filters.level);

    const { data, error } = (await query) as {
      data: MigrationLogRow[] | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(`Failed to load logs: ${error.message}`);

    return data ?? [];
  }

  // ───────────────────────────── streaming ─────────────────────────────

  /**
   * SSE state stream — polls the run every 2s and completes one emission after the
   * run reaches a terminal state (mirrors the automation-runs stream pattern, but
   * org-scoped). The client consumes it with `EventSource(..., { withCredentials })`.
   */
  streamRun(
    orgId: string,
    runId: string,
  ): Observable<{ data: RunStateSnapshot }> {
    return interval(STREAM_POLL_MS).pipe(
      startWith(0),
      switchMap(() => from(this.getState(orgId, runId))),
      takeWhile(
        (state) => !TERMINAL_RUN_STATUSES.includes(state.run.status),
        true,
      ),
      concatMap((state) => of({ data: state })),
    );
  }
}
