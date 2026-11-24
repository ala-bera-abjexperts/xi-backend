import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import type { RunnerLauncher } from './runner-launcher';
import {
  isSuperAdmin,
  TestAutomationRunnerService,
  turnOrder,
} from './test-automation-runner.service';

interface Call {
  table: string;
  ops: [string, unknown[]][];
}

interface Answer {
  data?: unknown;
  error?: { message: string } | null;
  count?: number;
}

const NOW = Date.parse('2026-11-12T10:00:00.000Z');
const SPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_SPACE = '22222222-2222-4222-8222-222222222222';
const THIRD_SPACE = '33333333-3333-4333-8333-333333333333';
const ME = 'user-me';
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const opOf = (call: Call, name: string) =>
  call.ops.find(([op]) => op === name)?.[1];
const has = (call: Call, name: string) => Boolean(opOf(call, name));

function fakeDatabase(respond: (call: Call) => Answer) {
  const calls: Call[] = [];
  const from = jest.fn((table: string) => {
    const call: Call = { table, ops: [] };
    const chain: Record<string, unknown> = {};

    calls.push(call);

    for (const op of [
      'select',
      'upsert',
      'update',
      'like',
      'eq',
      'in',
      'gt',
      'lt',
      'not',
      'order',
      'limit',
    ]) {
      chain[op] = (...args: unknown[]) => {
        call.ops.push([op, args]);

        return chain;
      };
    }

    chain.then = (
      done: (value: Answer) => unknown,
      fail?: (e: unknown) => unknown,
    ) => Promise.resolve({ error: null, ...respond(call) }).then(done, fail);

    return chain;
  });

  return {
    calls,
    supabase: {
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService,
  };
}

interface World {
  stateRows?: { job_name: string; last_run_at: string }[];
  busy?: number;
  queue?: Record<string, unknown>[];
  finished?: { started_at: string; finished_at: string }[];
  claimRows?: unknown[];
  lastStarts?: { space_id: string; started_at: string }[];
}

function responder(world: World) {
  return (call: Call): Answer => {
    if (call.table === 'cron_run_state') {
      if (has(call, 'like')) return { data: world.stateRows ?? [] };
      if (has(call, 'update')) return { data: world.claimRows ?? [{}] };

      return { data: null };
    }

    if (has(call, 'gt')) return { count: world.busy ?? 0 };
    // The last start of each waiting space.
    if (has(call, 'not') && has(call, 'in')) {
      return { data: world.lastStarts ?? [] };
    }
    if (has(call, 'not')) return { data: world.finished ?? [] };

    return { data: world.queue ?? [] };
  };
}

const queued = (
  id: string,
  space: string,
  createdOffset: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  space_id: space,
  config_id: 'cfg',
  config_name: `Setting ${id}`,
  status: 'QUEUED',
  started_by: 'someone',
  cancel_requested_at: null,
  created_at: iso(createdOffset),
  started_at: null,
  ...extra,
});

describe('TestAutomationRunnerService', () => {
  const saved = { ...process.env };
  const user = { userId: ME, organizationId: 'org-1' } as RequestUser;
  let assertAvailable: jest.Mock;
  let hasSpacePermission: jest.Mock;
  let launch: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    process.env.TM_RUNNER_ENABLED = '1';
    process.env.TM_RUNNER_SLOTS = '2';
    process.env.TM_RUNNER_START_FROM_APP = '1';
    assertAvailable = jest.fn().mockResolvedValue(undefined);
    hasSpacePermission = jest.fn().mockResolvedValue(true);
    launch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...saved };
  });

  function build(world: World) {
    const database = fakeDatabase(responder(world));
    const service = new TestAutomationRunnerService(
      database.supabase,
      { assertAvailable } as unknown as TestManagementAccessService,
      { hasSpacePermission } as unknown as PermissionsService,
      { launch } as unknown as RunnerLauncher,
    );

    jest
      .spyOn(
        (
          service as unknown as {
            logger: { warn: () => void; log: () => void };
          }
        ).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    return { ...database, service };
  }

  const alive = (id: string, ageMs = 1_000) => [
    { job_name: `tm_runner.worker.${id}`, last_run_at: iso(-ageMs) },
    { job_name: `tm_runner.ready.${id}`, last_run_at: iso(-ageMs) },
  ];

  describe('status', () => {
    it('is off when the runner is switched off on the server', async () => {
      process.env.TM_RUNNER_ENABLED = '0';

      const { service } = build({ stateRows: alive('a') });

      await expect(service.status(user, SPACE)).resolves.toMatchObject({
        state: 'disabled',
      });
    });

    it('is offline when no runner wrote lately', async () => {
      const { service } = build({ stateRows: alive('a', 31_000) });

      await expect(service.status(user, SPACE)).resolves.toMatchObject({
        state: 'offline',
        runners: 0,
        slots: 0,
        last_seen_at: iso(-31_000),
      });
    });

    it('is starting while a start is under way', async () => {
      const { service } = build({
        stateRows: [{ job_name: 'tm_runner.start', last_run_at: iso(-60_000) }],
      });

      await expect(service.status(user, SPACE)).resolves.toMatchObject({
        state: 'starting',
      });
    });

    it('is online with free places, and busy when all are used', async () => {
      const free = build({ stateRows: alive('a'), busy: 1 });

      await expect(free.service.status(user, SPACE)).resolves.toMatchObject({
        state: 'online',
        slots: 2,
        busy_slots: 1,
      });

      const full = build({ stateRows: alive('a'), busy: 5 });

      await expect(full.service.status(user, SPACE)).resolves.toMatchObject({
        state: 'busy',
        busy_slots: 2,
      });
    });

    it('is not ready when no live runner has Docker and disk', async () => {
      const { service } = build({
        stateRows: [
          { job_name: 'tm_runner.worker.a', last_run_at: iso(-1_000) },
          { job_name: 'tm_runner.ready.a', last_run_at: iso(-60_000) },
        ],
      });

      await expect(service.status(user, SPACE)).resolves.toMatchObject({
        state: 'not_ready',
      });
    });

    it('is stopping when every live runner was asked to stop', async () => {
      const { service } = build({
        stateRows: [
          ...alive('a'),
          { job_name: 'tm_runner.draining.a', last_run_at: iso(-1_000) },
        ],
      });

      await expect(service.status(user, SPACE)).resolves.toMatchObject({
        state: 'draining',
      });
    });

    it('shows a recent failed start only while no runner came up since', async () => {
      const failed = build({
        stateRows: [
          { job_name: 'tm_runner.start_failed', last_run_at: iso(-5 * 60_000) },
        ],
      });

      await expect(failed.service.status(user, SPACE)).resolves.toMatchObject({
        state: 'offline',
        start_failed_at: iso(-5 * 60_000),
      });

      const recovered = build({
        stateRows: [
          { job_name: 'tm_runner.start_failed', last_run_at: iso(-5 * 60_000) },
          ...alive('a'),
        ],
      });

      await expect(
        recovered.service.status(user, SPACE),
      ).resolves.toMatchObject({ start_failed_at: null });
    });

    it('treats a start that never came up within its time as failed', async () => {
      const stillStarting = build({
        stateRows: [{ job_name: 'tm_runner.start', last_run_at: iso(-60_000) }],
      });

      await expect(
        stillStarting.service.status(user, SPACE),
      ).resolves.toMatchObject({ state: 'starting', start_failed_at: null });

      const neverCameUp = build({
        stateRows: [
          { job_name: 'tm_runner.start', last_run_at: iso(-3 * 60_000) },
        ],
      });

      await expect(
        neverCameUp.service.status(user, SPACE),
      ).resolves.toMatchObject({
        state: 'offline',
        start_failed_at: iso(-60_000),
      });
    });

    it('lists only this space, with positions across the organisation', async () => {
      const { service } = build({
        stateRows: alive('a'),
        queue: [
          queued('run-active', OTHER_SPACE, -9_000, {
            status: 'RUNNING',
            started_at: iso(-8_000),
          }),
          queued('run-1', SPACE, -7_000, { started_by: ME }),
          queued('run-2', OTHER_SPACE, -6_000),
          queued('run-cancelled', SPACE, -5_500, {
            cancel_requested_at: iso(-1),
          }),
          queued('run-3', SPACE, -5_000),
        ],
      });

      const status = await service.status(user, SPACE);

      expect(status.queue).toEqual([
        expect.objectContaining({
          run_id: 'run-1',
          phase: 'next',
          position: 1,
          ahead: 1,
          mine: true,
        }),
        expect.objectContaining({
          run_id: 'run-3',
          phase: 'waiting',
          position: 3,
          ahead: 3,
          mine: false,
        }),
      ]);
      expect(status.waiting_in_space).toBe(2);
      expect(status.waiting_in_other_spaces).toBe(1);
      expect(JSON.stringify(status)).not.toContain('run-2');
      expect(JSON.stringify(status)).not.toContain('run-active');
    });

    it('gives positions in turn order, spaces taking turns', async () => {
      const { service } = build({
        stateRows: alive('a'),
        queue: [
          queued('a1', SPACE, -9_000),
          queued('a2', SPACE, -8_000),
          queued('a3', SPACE, -7_000),
          queued('b1', OTHER_SPACE, -6_000),
          queued('c1', THIRD_SPACE, -5_000),
        ],
      });

      const status = await service.status(user, SPACE);

      expect(
        status.queue.map((item) => [item.run_id, item.position, item.ahead]),
      ).toEqual([
        ['a1', 1, 0],
        ['a2', 4, 3],
        ['a3', 5, 4],
      ]);
    });

    it('lets the space that started longest ago go first', async () => {
      const { service } = build({
        stateRows: alive('a'),
        queue: [queued('a1', SPACE, -9_000), queued('b1', OTHER_SPACE, -8_000)],
        lastStarts: [
          { space_id: SPACE, started_at: iso(-1_000) },
          { space_id: OTHER_SPACE, started_at: iso(-100_000) },
        ],
      });

      const status = await service.status(user, SPACE);

      expect(status.queue).toEqual([
        expect.objectContaining({
          run_id: 'a1',
          phase: 'waiting',
          position: 2,
          ahead: 1,
        }),
      ]);
    });

    it('keeps one space oldest first', async () => {
      const { service } = build({
        queue: [queued('a1', SPACE, -9_000), queued('a2', SPACE, -8_000)],
        lastStarts: [{ space_id: SPACE, started_at: iso(-50_000) }],
      });

      const status = await service.status(user, SPACE);

      expect(status.queue.map((item) => item.position)).toEqual([1, 2]);
    });

    it('reads last starts only when something waits, for the waiting spaces', async () => {
      const empty = build({});

      await empty.service.status(user, SPACE);

      expect(
        empty.calls.some((call) => has(call, 'in') && has(call, 'not')),
      ).toBe(false);

      const busy = build({
        queue: [queued('a1', SPACE, -9_000), queued('b1', OTHER_SPACE, -8_000)],
      });

      await busy.service.status(user, SPACE);

      const read = busy.calls.find(
        (call) => has(call, 'in') && has(call, 'not'),
      ) as Call;

      expect(read.ops).toContainEqual(['eq', ['organization_id', 'org-1']]);
      expect(read.ops).toContainEqual([
        'in',
        ['space_id', [SPACE, OTHER_SPACE]],
      ]);
    });

    it('lists a running run of this space first', async () => {
      const { service } = build({
        stateRows: alive('a'),
        queue: [
          queued('run-active', SPACE, -9_000, { status: 'UPLOADING' }),
          queued('run-1', SPACE, -7_000),
        ],
      });

      const status = await service.status(user, SPACE);

      expect(status.queue.map((item) => [item.run_id, item.phase])).toEqual([
        ['run-active', 'running'],
        ['run-1', 'next'],
      ]);
    });

    it('cuts long setting names', async () => {
      const { service } = build({
        queue: [
          queued('run-1', SPACE, -1_000, { config_name: 'x'.repeat(500) }),
        ],
      });

      const status = await service.status(user, SPACE);

      expect(status.queue[0].config_name).toHaveLength(200);
    });

    it('reads the queue of the caller organisation only', async () => {
      const { calls, service } = build({});

      await service.status(user, SPACE);

      const queueRead = calls.find(
        (call) => call.table === 'test_automation_runs' && has(call, 'order'),
      ) as Call;

      expect(queueRead.ops).toContainEqual([
        'eq',
        ['organization_id', 'org-1'],
      ]);
      expect(queueRead.ops).toContainEqual(['eq', ['kind', 'docker']]);
    });

    it('averages the recent finished runs', async () => {
      const { service } = build({
        finished: [
          { started_at: iso(-100_000), finished_at: iso(-40_000) },
          { started_at: iso(-200_000), finished_at: iso(-80_000) },
        ],
      });

      await expect(service.status(user, SPACE)).resolves.toMatchObject({
        avg_run_seconds: 90,
      });
    });

    it('checks the space first', async () => {
      assertAvailable.mockRejectedValue(new Error('module off'));

      const { service } = build({});

      await expect(service.status(user, SPACE)).rejects.toThrow('module off');
    });
  });

  describe('start', () => {
    it('needs the right to manage test runs', async () => {
      hasSpacePermission.mockResolvedValue(false);

      const { service } = build({});

      await expect(service.start(user, SPACE)).rejects.toMatchObject({
        response: { code: 'RUNNER_START_FORBIDDEN' },
      });
      expect(launch).not.toHaveBeenCalled();
    });

    it('refuses when the runner is off or started by the administrator', async () => {
      process.env.TM_RUNNER_ENABLED = '0';

      const off = build({});

      await expect(off.service.start(user, SPACE)).rejects.toMatchObject({
        response: { code: 'RUNNER_DISABLED' },
      });

      process.env.TM_RUNNER_ENABLED = '1';
      delete process.env.TM_RUNNER_START_FROM_APP;

      const manual = build({});

      await expect(manual.service.start(user, SPACE)).rejects.toMatchObject({
        response: { code: 'RUNNER_START_OFF' },
      });
      expect(launch).not.toHaveBeenCalled();
    });

    it('does nothing when a runner is alive', async () => {
      const { service } = build({ stateRows: alive('a') });

      await expect(service.start(user, SPACE)).resolves.toEqual({
        result: 'ALREADY_RUNNING',
      });
      expect(launch).not.toHaveBeenCalled();
    });

    it('does nothing when another start won the claim', async () => {
      const { service } = build({ claimRows: [] });

      await expect(service.start(user, SPACE)).resolves.toEqual({
        result: 'STARTING',
      });
      expect(launch).not.toHaveBeenCalled();
    });

    it('claims with one conditional update, then launches', async () => {
      const { calls, service } = build({});

      await expect(service.start(user, SPACE)).resolves.toEqual({
        result: 'STARTED',
      });

      const claim = calls.find((call) => has(call, 'update')) as Call;

      expect(opOf(claim, 'eq')).toEqual(['job_name', 'tm_runner.start']);
      expect(opOf(claim, 'lt')).toEqual(['last_run_at', iso(-2 * 60_000)]);
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it('records a failed start and frees the claim', async () => {
      launch.mockImplementation((onFailed: (detail: string) => void) =>
        onFailed('boom'),
      );

      const { calls, service } = build({});

      await service.start(user, SPACE);
      await Promise.resolve();

      const record = calls.filter((call) => has(call, 'upsert')).at(-1) as Call;

      expect(opOf(record, 'upsert')?.[0]).toEqual([
        { job_name: 'tm_runner.start_failed', last_run_at: iso(0) },
        { job_name: 'tm_runner.start', last_run_at: new Date(0).toISOString() },
      ]);
    });

    it('answers a clear error when the program cannot be launched', async () => {
      launch.mockImplementation(() => {
        throw new Error('no node');
      });

      const { service } = build({});

      await expect(service.start(user, SPACE)).rejects.toMatchObject({
        response: { code: 'RUNNER_START_FAILED' },
      });
    });

    it('needs a space that can be changed', async () => {
      assertAvailable.mockRejectedValue(new Error('read only'));

      const { service } = build({});

      await expect(service.start(user, SPACE)).rejects.toThrow('read only');
      expect(assertAvailable).toHaveBeenCalledWith('org-1', SPACE, {
        write: true,
      });
    });
  });

  describe('autoStart', () => {
    it('starts nothing while the app may not start the runner', async () => {
      delete process.env.TM_RUNNER_START_FROM_APP;

      const { service } = build({});

      await expect(service.autoStart(user, SPACE)).resolves.toBe('off');
      expect(launch).not.toHaveBeenCalled();
    });

    it('launches once when the runner is off and the app may start it', async () => {
      const { service } = build({});

      await expect(service.autoStart(user, SPACE)).resolves.toBe('started');
      expect(launch).toHaveBeenCalledTimes(1);
      expect(hasSpacePermission).toHaveBeenCalledWith(
        ME,
        'org-1',
        SPACE,
        'manage_test_runs',
      );
    });

    it('starts nothing for someone without the right to manage test runs', async () => {
      hasSpacePermission.mockResolvedValue(false);

      const { service } = build({});

      await expect(service.autoStart(user, SPACE)).resolves.toBe('forbidden');
      expect(launch).not.toHaveBeenCalled();
    });

    it('answers failed instead of throwing when the program cannot be launched', async () => {
      launch.mockImplementation(() => {
        throw new Error('no node');
      });

      const { service } = build({});

      await expect(service.autoStart(user, SPACE)).resolves.toBe('failed');
    });
  });

  describe('acceptsRuns', () => {
    it('reads the same state as the status card from the heartbeat rows', async () => {
      const cases: [World['stateRows'], string][] = [
        [alive('a', 31_000), 'offline'],
        [
          [{ job_name: 'tm_runner.start', last_run_at: iso(-60_000) }],
          'starting',
        ],
        [alive('a'), 'online'],
        [
          [
            { job_name: 'tm_runner.worker.a', last_run_at: iso(-1_000) },
            { job_name: 'tm_runner.ready.a', last_run_at: iso(-60_000) },
          ],
          'not_ready',
        ],
        [
          [
            ...alive('a'),
            { job_name: 'tm_runner.draining.a', last_run_at: iso(-1_000) },
          ],
          'draining',
        ],
      ];

      for (const [stateRows, state] of cases) {
        const { service } = build({ stateRows });

        await expect(service.acceptsRuns()).resolves.toBe(state);
      }
    });

    it('is disabled when the runner is switched off on the server', async () => {
      process.env.TM_RUNNER_ENABLED = '0';

      const { service } = build({ stateRows: alive('a') });

      await expect(service.acceptsRuns()).resolves.toBe('disabled');
    });

    it('reads only the heartbeat rows, with no space check', async () => {
      const { service, calls } = build({ stateRows: alive('a') });

      await service.acceptsRuns();

      expect(calls.map((call) => call.table)).toEqual(['cron_run_state']);
      expect(assertAvailable).not.toHaveBeenCalled();
    });
  });

  describe('isSuperAdmin', () => {
    it('needs both the sign-in claim and the active platform role', () => {
      expect(
        isSuperAdmin({
          role: 'SUPER_ADMIN',
          appMetadata: { role: 'SUPER_ADMIN' },
        } as unknown as RequestUser),
      ).toBe(true);
      expect(
        isSuperAdmin({
          role: 'SUPER_ADMIN',
          appMetadata: {},
        } as unknown as RequestUser),
      ).toBe(false);
      expect(
        isSuperAdmin({
          role: 'admin',
          appMetadata: { is_super_admin: true },
        } as unknown as RequestUser),
      ).toBe(false);
      expect(
        isSuperAdmin({
          role: 'SUPER_ADMIN',
          isActive: false,
          appMetadata: { role: 'SUPER_ADMIN' },
        } as unknown as RequestUser),
      ).toBe(false);
    });
  });
});

describe('turnOrder', () => {
  const run = (id: string, space: string, at: number) => ({
    id,
    space_id: space,
    created_at: iso(at),
  });

  it('lets spaces take turns, oldest first inside a space', () => {
    const order = turnOrder(
      [
        run('a1', 'A', -9),
        run('a2', 'A', -8),
        run('b1', 'B', -7),
        run('c1', 'C', -6),
        run('b2', 'B', -5),
      ],
      new Map(),
    );

    expect(order.map((row) => row.id)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2']);
  });

  it('puts a space that never ran before one that ran recently', () => {
    const order = turnOrder(
      [run('a1', 'A', -9), run('b1', 'B', -8)],
      new Map([['A', NOW]]),
    );

    expect(order.map((row) => row.id)).toEqual(['b1', 'a1']);
  });

  it('keeps every run once and handles an empty line', () => {
    expect(turnOrder([], new Map())).toEqual([]);

    const rows = [run('a1', 'A', -3), run('a2', 'A', -2), run('a3', 'A', -1)];

    expect(turnOrder(rows, new Map()).map((row) => row.id)).toEqual([
      'a1',
      'a2',
      'a3',
    ]);
  });
});
