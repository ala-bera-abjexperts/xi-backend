import {
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  RUNNER_DRAINING_PREFIX,
  RUNNER_NEVER,
  RUNNER_READY_PREFIX,
  RUNNER_START_FAILED_KEY,
  RUNNER_START_KEY,
  RUNNER_WORKER_PREFIX,
} from '../../test-automation-runner/runner.heartbeat';
import {
  readRunningPerOrg,
  readSlots,
} from '../../test-automation-runner/runner.loop';
import { TestManagementAccessService } from '../access/test-management-access.service';
import { readQueuePerOrg, runnerEnabled } from './automation-inputs';
import { RunnerLauncher } from './runner-launcher';

// A runner writes every 5 s; three missed writes and a little clock room count as gone.
const ALIVE_MS = 30_000;
// How long one start may take before another can be tried.
const START_CLAIM_MS = 2 * 60_000;
// A failed start is shown for this long, unless a runner came up since.
const START_FAILED_SHOWN_MS = 15 * 60_000;
const AVERAGE_OF_RUNS = 20;
const NAME_MAX = 200;
const ACTIVE_STATUSES = ['RUNNING', 'UPLOADING'];
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';
// Recent starts read to find each waiting space's turn.
const LAST_START_ROWS = 500;

export const RUNNER_STATES = [
  'disabled',
  'offline',
  'starting',
  'online',
  'busy',
  'draining',
  'not_ready',
] as const;
export type RunnerState = (typeof RUNNER_STATES)[number];

export type RunnerStartResult = 'STARTED' | 'STARTING' | 'ALREADY_RUNNING';
export type RunnerAutoStart = 'started' | 'off' | 'forbidden' | 'failed';

/** Asked to start the runner without the right to manage test runs. */
export function startForbidden(): ForbiddenException {
  return new ForbiddenException({
    code: 'RUNNER_START_FORBIDDEN',
    message:
      "The test runner is off and you can't start it. Ask someone who can manage test plans and executions to start it.",
  });
}

export interface RunnerQueueItem {
  run_id: string;
  config_id: string | null;
  config_name: string | null;
  phase: 'running' | 'next' | 'waiting';
  position: number | null;
  ahead: number;
  started_by: string | null;
  mine: boolean;
  created_at: string;
  started_at: string | null;
}

export interface RunnerStatus {
  state: RunnerState;
  runners: number;
  slots: number;
  busy_slots: number;
  last_seen_at: string | null;
  start_failed_at: string | null;
  start_from_app: boolean;
  can_stop: boolean;
  queue: RunnerQueueItem[];
  waiting_in_space: number;
  waiting_in_other_spaces: number;
  avg_run_seconds: number | null;
}

interface StateRow {
  job_name: string;
  last_run_at: string;
}

interface QueueRow {
  id: string;
  space_id: string;
  config_id: string | null;
  config_name: string | null;
  status: string;
  started_by: string | null;
  cancel_requested_at: string | null;
  created_at: string;
  started_at: string | null;
}

interface FinishedRow {
  started_at: string | null;
  finished_at: string | null;
}

/** Start from the app only when the server owner switched it on; production starts the runner itself. */
export function startFromAppEnabled(): boolean {
  return process.env.TM_RUNNER_START_FROM_APP === '1';
}

/** Same rule as SuperAdminGuard, so only a platform admin sees Stop. */
export function isSuperAdmin(user: RequestUser): boolean {
  const metadata = user.appMetadata ?? {};
  const claim =
    metadata.role === SUPER_ADMIN_ROLE || metadata.is_super_admin === true;

  return (
    claim && String(user.role) === SUPER_ADMIN_ROLE && user.isActive !== false
  );
}

const timeOf = (value: string | null | undefined): number => {
  const time = Date.parse(value ?? '');

  return Number.isFinite(time) ? time : 0;
};

const shortName = (name: string | null): string | null =>
  typeof name === 'string' ? name.slice(0, NAME_MAX) : null;

/** The waiting runs in the order the runner takes them: spaces take turns, the one that started longest ago first. */
export function turnOrder<
  T extends { id: string; space_id: string; created_at: string },
>(waiting: T[], lastStart: Map<string, number>): T[] {
  // Each space's line keeps the order it came in (oldest first).
  const lines = new Map<string, T[]>();

  for (const row of waiting) {
    lines.set(row.space_id, [...(lines.get(row.space_id) ?? []), row]);
  }

  const turn = new Map(lastStart);
  const order: T[] = [];
  let taken = Number.MAX_SAFE_INTEGER - waiting.length;

  while (order.length < waiting.length) {
    let pick: T[] | undefined;
    let pickSpace = '';

    for (const [space, line] of lines) {
      if (line.length === 0) continue;

      const at = turn.get(space) ?? -Infinity;
      const best = pick ? (turn.get(pickSpace) ?? -Infinity) : Infinity;

      if (
        !pick ||
        at < best ||
        (at === best && line[0].created_at < pick[0].created_at)
      ) {
        pick = line;
        pickSpace = space;
      }
    }

    const next = pick?.shift();

    if (!next) break;

    order.push(next);
    turn.set(pickSpace, taken++);
  }

  return order;
}

/** The shared test runner: whether it is on, how busy it is, the queue, and starting it. */
@Injectable()
export class TestAutomationRunnerService {
  private readonly logger = new Logger(TestAutomationRunnerService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly permissions: PermissionsService,
    private readonly launcher: RunnerLauncher,
    @Optional() private readonly auditLogs?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async status(user: RequestUser, spaceId: string): Promise<RunnerStatus> {
    await this.access.assertAvailable(user.organizationId, spaceId);

    const now = Date.now();
    const [rows, busySlots, queueRows, avgRunSeconds] = await Promise.all([
      this.stateRows(),
      this.busySlots(now),
      this.queueRows(user.organizationId),
      this.averageRunSeconds(user.organizationId),
    ]);
    const lastStart = await this.lastStartBySpace(user.organizationId, [
      ...new Set(
        queueRows
          .filter((row) => row.status === 'QUEUED' && !row.cancel_requested_at)
          .map((row) => row.space_id),
      ),
    ]);
    const alive = (prefix: string) =>
      new Set(
        rows
          .filter(
            (row) =>
              row.job_name.startsWith(prefix) &&
              now - timeOf(row.last_run_at) <= ALIVE_MS,
          )
          .map((row) => row.job_name.slice(prefix.length)),
      );
    const workers = alive(RUNNER_WORKER_PREFIX);
    const ready = [...alive(RUNNER_READY_PREFIX)].filter((id) =>
      workers.has(id),
    );
    const draining = [...alive(RUNNER_DRAINING_PREFIX)].filter((id) =>
      workers.has(id),
    );
    const rowTime = (key: string) =>
      timeOf(rows.find((row) => row.job_name === key)?.last_run_at);
    const startClaimedAt = rowTime(RUNNER_START_KEY);
    const startFailedAt = rowTime(RUNNER_START_FAILED_KEY);
    const lastSeen = Math.max(
      0,
      ...rows
        .filter((row) => row.job_name.startsWith(RUNNER_WORKER_PREFIX))
        .map((row) => timeOf(row.last_run_at)),
    );
    const slots = workers.size * readSlots();

    // A runner clears the start request when it comes up, so one still standing after the start time never came up.
    const startNeverCameUpAt =
      startClaimedAt > 0 && now - startClaimedAt >= START_CLAIM_MS
        ? startClaimedAt + START_CLAIM_MS
        : 0;
    const failedAt = Math.max(startFailedAt, startNeverCameUpAt);
    const failedRecently =
      workers.size === 0 &&
      failedAt > lastSeen &&
      now - failedAt <= START_FAILED_SHOWN_MS;

    return {
      state: this.stateOf({
        workers: workers.size,
        ready: ready.length,
        draining: draining.length,
        starting: now - startClaimedAt < START_CLAIM_MS,
        busy: busySlots >= slots,
      }),
      runners: workers.size,
      slots,
      busy_slots: Math.min(busySlots, slots),
      last_seen_at: lastSeen ? new Date(lastSeen).toISOString() : null,
      start_failed_at: failedRecently ? new Date(failedAt).toISOString() : null,
      start_from_app: startFromAppEnabled(),
      can_stop: isSuperAdmin(user),
      avg_run_seconds: avgRunSeconds,
      ...this.queueOf(queueRows, spaceId, user.userId, lastStart),
    };
  }

  async start(
    user: RequestUser,
    spaceId: string,
  ): Promise<{ result: RunnerStartResult }> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    if (!(await this.mayStart(user, spaceId))) throw startForbidden();

    if (!runnerEnabled()) {
      throw new ServiceUnavailableException({
        code: 'RUNNER_DISABLED',
        message: 'The test runner is not switched on for this server',
      });
    }

    if (!startFromAppEnabled()) {
      throw new ServiceUnavailableException({
        code: 'RUNNER_START_OFF',
        message: 'The test runner is started by your administrator',
      });
    }

    const started = await this.startIfOff(user.userId);

    if (started.result === 'STARTED') {
      void this.auditLogs?.logActionForRequest(
        user,
        'test_automation_runner',
        spaceId,
        'update',
        { action: 'start', space_id: spaceId },
      );
    }

    return started;
  }

  /** Starts the runner after work was queued, the way Start does, for someone who may press Start. Never throws. */
  async autoStart(
    user: RequestUser,
    spaceId: string,
  ): Promise<RunnerAutoStart> {
    if (!runnerEnabled() || !startFromAppEnabled()) return 'off';

    try {
      if (!(await this.mayStart(user, spaceId))) return 'forbidden';

      await this.startIfOff(`${user.userId} (automatic)`);

      return 'started';
    } catch (error) {
      this.logger.warn(
        `Automatic runner start failed: ${(error as Error).message}`,
      );

      return 'failed';
    }
  }

  // The same right that starting a run needs.
  private mayStart(user: RequestUser, spaceId: string): Promise<boolean> {
    return this.permissions.hasSpacePermission(
      user.userId,
      user.organizationId,
      spaceId,
      'manage_test_runs',
    );
  }

  private async startIfOff(by: string): Promise<{ result: RunnerStartResult }> {
    const now = Date.now();
    const rows = await this.stateRows();
    const running = rows.some(
      (row) =>
        row.job_name.startsWith(RUNNER_WORKER_PREFIX) &&
        now - timeOf(row.last_run_at) <= ALIVE_MS,
    );

    if (running) return { result: 'ALREADY_RUNNING' };

    if (!(await this.claimStart(now))) return { result: 'STARTING' };

    try {
      this.launcher.launch((detail) => void this.startFailed(detail));
    } catch (error) {
      await this.startFailed((error as Error).message);

      throw new ServiceUnavailableException({
        code: 'RUNNER_START_FAILED',
        message: 'The test runner could not be started',
      });
    }

    this.logger.log(`Test runner start asked by user ${by}`);

    return { result: 'STARTED' };
  }

  /** A new run may wait in line only while a runner is on or starting; off, stopping or not ready is refused. */
  async acceptsRuns(): Promise<RunnerState> {
    const now = Date.now();
    const rows = await this.stateRows();
    const alive = (prefix: string) =>
      new Set(
        rows
          .filter(
            (row) =>
              row.job_name.startsWith(prefix) &&
              now - timeOf(row.last_run_at) <= ALIVE_MS,
          )
          .map((row) => row.job_name.slice(prefix.length)),
      );
    const workers = alive(RUNNER_WORKER_PREFIX);
    const startClaimedAt = timeOf(
      rows.find((row) => row.job_name === RUNNER_START_KEY)?.last_run_at,
    );

    return this.stateOf({
      workers: workers.size,
      ready: [...alive(RUNNER_READY_PREFIX)].filter((id) => workers.has(id))
        .length,
      draining: [...alive(RUNNER_DRAINING_PREFIX)].filter((id) =>
        workers.has(id),
      ).length,
      starting: now - startClaimedAt < START_CLAIM_MS,
      busy: false,
    });
  }

  private stateOf(found: {
    workers: number;
    ready: number;
    draining: number;
    starting: boolean;
    busy: boolean;
  }): RunnerState {
    if (!runnerEnabled()) return 'disabled';
    if (found.workers === 0) return found.starting ? 'starting' : 'offline';
    if (found.draining === found.workers) return 'draining';
    if (found.ready === 0) return 'not_ready';

    return found.busy ? 'busy' : 'online';
  }

  /** Only one request wins: one update that applies only while no other start is under way. */
  private async claimStart(now: number): Promise<boolean> {
    const { error: seedError } = await this.client
      .from('cron_run_state')
      .upsert(
        { job_name: RUNNER_START_KEY, last_run_at: RUNNER_NEVER },
        { onConflict: 'job_name', ignoreDuplicates: true },
      );

    if (seedError) throw new Error(seedError.message);

    const { data, error } = await this.client
      .from('cron_run_state')
      .update({ last_run_at: new Date(now).toISOString() })
      .eq('job_name', RUNNER_START_KEY)
      .lt('last_run_at', new Date(now - START_CLAIM_MS).toISOString())
      .select('job_name');

    if (error) throw new Error(error.message);

    return ((data ?? []) as unknown[]).length === 1;
  }

  /** Records the failure and frees the start, so Start can be pressed again. */
  private async startFailed(detail: string): Promise<void> {
    this.logger.warn(`The test runner did not start: ${detail}`);

    const { error } = await this.client.from('cron_run_state').upsert([
      {
        job_name: RUNNER_START_FAILED_KEY,
        last_run_at: new Date().toISOString(),
      },
      { job_name: RUNNER_START_KEY, last_run_at: RUNNER_NEVER },
    ]);

    if (error)
      this.logger.warn(`Could not record the failed start: ${error.message}`);
  }

  private async stateRows(): Promise<StateRow[]> {
    const { data, error } = await this.client
      .from('cron_run_state')
      .select('job_name, last_run_at')
      .like('job_name', 'tm_runner.%');

    if (error) throw new Error(error.message);

    return (data ?? []) as StateRow[];
  }

  /** Places in use on all runners; a run whose lease ran out no longer counts. */
  private async busySlots(now: number): Promise<number> {
    const { count, error } = await this.client
      .from('test_automation_runs')
      .select('id', { count: 'exact', head: true })
      .eq('kind', 'docker')
      .in('status', ACTIVE_STATUSES)
      .gt('lease_until', new Date(now).toISOString());

    if (error) throw new Error(error.message);

    return count ?? 0;
  }

  /** The organisation's whole line, oldest first; its waiting limit plus the runs going. */
  private async queueRows(organizationId: string): Promise<QueueRow[]> {
    const { data, error } = await this.client
      .from('test_automation_runs')
      .select(
        'id, space_id, config_id, status, started_by, cancel_requested_at, created_at, started_at, ' +
          'config_name:config_snapshot->>name',
      )
      .eq('organization_id', organizationId)
      .eq('kind', 'docker')
      .in('status', ['QUEUED', ...ACTIVE_STATUSES])
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(readQueuePerOrg() + readRunningPerOrg());

    if (error) throw new Error(error.message);

    return (data ?? []) as unknown as QueueRow[];
  }

  /** When each space with waiting runs last started one; the runner gives the turn to the one that started longest ago. */
  private async lastStartBySpace(
    organizationId: string,
    spaceIds: string[],
  ): Promise<Map<string, number>> {
    const last = new Map<string, number>();

    if (spaceIds.length === 0) return last;

    // ponytail: only recent starts are read; a space whose last start is older counts as never started.
    const { data, error } = await this.client
      .from('test_automation_runs')
      .select('space_id, started_at')
      .eq('organization_id', organizationId)
      .eq('kind', 'docker')
      .in('space_id', spaceIds)
      .not('started_at', 'is', null)
      .order('started_at', { ascending: false })
      .limit(LAST_START_ROWS);

    if (error) throw new Error(error.message);

    for (const row of (data ?? []) as {
      space_id?: string;
      started_at: string | null;
    }[]) {
      if (row.space_id && !last.has(row.space_id)) {
        last.set(row.space_id, timeOf(row.started_at));
      }
    }

    return last;
  }

  private async averageRunSeconds(
    organizationId: string,
  ): Promise<number | null> {
    const { data, error } = await this.client
      .from('test_automation_runs')
      .select('started_at, finished_at')
      .eq('organization_id', organizationId)
      .eq('kind', 'docker')
      .eq('status', 'DONE')
      .not('started_at', 'is', null)
      .order('finished_at', { ascending: false })
      .limit(AVERAGE_OF_RUNS);

    if (error) throw new Error(error.message);

    const seconds = ((data ?? []) as FinishedRow[])
      .map((row) => (timeOf(row.finished_at) - timeOf(row.started_at)) / 1000)
      .filter((value) => value > 0);

    if (seconds.length === 0) return null;

    return Math.round(
      seconds.reduce((sum, value) => sum + value, 0) / seconds.length,
    );
  }

  /** Positions count the whole organisation in turn order; only this space's runs are listed, other spaces only as a number. */
  private queueOf(
    rows: QueueRow[],
    spaceId: string,
    userId: string,
    lastStart: Map<string, number>,
  ): Pick<
    RunnerStatus,
    'queue' | 'waiting_in_space' | 'waiting_in_other_spaces'
  > {
    const active = rows.filter((row) => ACTIVE_STATUSES.includes(row.status));
    const waiting = rows.filter(
      (row) => row.status === 'QUEUED' && !row.cancel_requested_at,
    );
    const item = (
      row: QueueRow,
      phase: RunnerQueueItem['phase'],
      position: number | null,
      ahead: number,
    ): RunnerQueueItem => ({
      run_id: row.id,
      config_id: row.config_id,
      config_name: shortName(row.config_name),
      phase,
      position,
      ahead,
      started_by: row.started_by,
      mine: row.started_by === userId,
      created_at: row.created_at,
      started_at: row.started_at,
    });
    // A run going right now is its space's latest start.
    const turns = new Map(lastStart);

    for (const row of active) {
      turns.set(
        row.space_id,
        Math.max(turns.get(row.space_id) ?? 0, timeOf(row.started_at)),
      );
    }

    const queue = [
      ...active
        .filter((row) => row.space_id === spaceId)
        .map((row) => item(row, 'running', null, 0)),
      ...turnOrder(waiting, turns).flatMap((row, index) =>
        row.space_id === spaceId
          ? [
              item(
                row,
                index === 0 ? 'next' : 'waiting',
                index + 1,
                index + active.length,
              ),
            ]
          : [],
      ),
    ];
    const inSpace = waiting.filter((row) => row.space_id === spaceId).length;

    return {
      queue,
      waiting_in_space: inSpace,
      waiting_in_other_spaces: waiting.length - inSpace,
    };
  }
}
