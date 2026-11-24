import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  readIdleStopMs,
  RUNNER_DRAIN_KEY,
  RUNNER_NEVER,
  RUNNER_START_KEY,
  RunnerHeartbeat,
} from './runner.heartbeat';

interface Call {
  table: string;
  ops: [string, unknown[]][];
}

interface Answer {
  data?: unknown;
  error?: { message: string } | null;
  count?: number;
}

const START = Date.parse('2026-11-12T10:00:00.000Z');
const MINUTE = 60_000;

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
      'delete',
      'in',
      'eq',
      'is',
      'like',
      'lt',
    ]) {
      chain[op] = (...args: unknown[]) => {
        call.ops.push([op, args]);

        return chain;
      };
    }

    chain.maybeSingle = () => {
      call.ops.push(['maybeSingle', []]);

      return chain;
    };
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

const opOf = (call: Call, name: string) =>
  call.ops.find(([op]) => op === name)?.[1];

const isDrainRead = (call: Call) =>
  opOf(call, 'eq')?.[1] === RUNNER_DRAIN_KEY && Boolean(opOf(call, 'select'));

describe('readIdleStopMs', () => {
  it('never stops unless a whole number of minutes is set', () => {
    expect(readIdleStopMs(undefined)).toBe(0);
    expect(readIdleStopMs('0')).toBe(0);
    expect(readIdleStopMs('abc')).toBe(0);
    expect(readIdleStopMs('1.5')).toBe(0);
    expect(readIdleStopMs('-3')).toBe(0);
  });

  it('reads minutes and caps them at one day', () => {
    expect(readIdleStopMs('15')).toBe(15 * MINUTE);
    expect(readIdleStopMs('99999')).toBe(1440 * MINUTE);
  });
});

describe('RunnerHeartbeat', () => {
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = START;
  });

  function build(
    respond: (call: Call) => Answer,
    options: { ready?: boolean; idleStopMs?: number } = {},
  ) {
    const database = fakeDatabase(respond);
    const onStop = jest.fn();
    const heartbeat = new RunnerHeartbeat(
      database.supabase,
      'host-42',
      2,
      () => options.ready ?? true,
      options.idleStopMs ?? 0,
      onStop,
      now,
    );

    return { ...database, onStop, heartbeat };
  }

  it('writes the alive and ready rows with the current time', async () => {
    const { calls, heartbeat } = build(() => ({ data: null }));

    await heartbeat.beat();

    const upsert = calls.find((call) => opOf(call, 'upsert'));

    expect(upsert?.table).toBe('cron_run_state');
    expect(opOf(upsert as Call, 'upsert')?.[0]).toEqual([
      {
        job_name: 'tm_runner.worker.host-42',
        last_run_at: new Date(START).toISOString(),
      },
      {
        job_name: 'tm_runner.ready.host-42',
        last_run_at: new Date(START).toISOString(),
      },
    ]);
  });

  it('leaves out the ready row while Docker or the disk is not ready', async () => {
    const { calls, heartbeat } = build(() => ({ data: null }), {
      ready: false,
    });

    await heartbeat.beat();

    const upsert = calls.find((call) => opOf(call, 'upsert'));

    expect(opOf(upsert as Call, 'upsert')?.[0]).toEqual([
      {
        job_name: 'tm_runner.worker.host-42',
        last_run_at: new Date(START).toISOString(),
      },
    ]);
  });

  it('ends the start request on the first beat only', async () => {
    const { calls, heartbeat } = build(() => ({ data: null }));

    await heartbeat.beat();
    await heartbeat.beat();

    const ends = calls.filter((call) => opOf(call, 'update'));

    expect(ends).toHaveLength(1);
    expect(opOf(ends[0], 'update')?.[0]).toEqual({ last_run_at: RUNNER_NEVER });
    expect(opOf(ends[0], 'eq')).toEqual(['job_name', RUNNER_START_KEY]);
  });

  it('stops once when an admin asked after this runner started', async () => {
    const asked = new Date(START + 1_000).toISOString();
    const { onStop, heartbeat } = build((call) =>
      isDrainRead(call) ? { data: { last_run_at: asked } } : { data: null },
    );

    await heartbeat.beat();
    await heartbeat.beat();

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith('stop request');
  });

  it('marks itself as stopping once a stop was asked', async () => {
    const asked = new Date(START + 1_000).toISOString();
    const { calls, heartbeat } = build((call) =>
      isDrainRead(call) ? { data: { last_run_at: asked } } : { data: null },
    );

    await heartbeat.beat();

    const firstUpsert = calls.filter((call) => opOf(call, 'upsert'))[0];

    expect(opOf(firstUpsert, 'upsert')?.[0]).not.toContainEqual(
      expect.objectContaining({ job_name: 'tm_runner.draining.host-42' }),
    );

    await heartbeat.beat();

    const upserts = calls.filter((call) => opOf(call, 'upsert'));

    expect(opOf(upserts[1], 'upsert')?.[0]).toContainEqual({
      job_name: 'tm_runner.draining.host-42',
      last_run_at: new Date(START).toISOString(),
    });
    expect(calls.filter(isDrainRead)).toHaveLength(1);
  });

  it('ignores a stop request made before this runner started', async () => {
    const asked = new Date(START - 1_000).toISOString();
    const { onStop, heartbeat } = build((call) =>
      isDrainRead(call) ? { data: { last_run_at: asked } } : { data: null },
    );

    await heartbeat.beat();

    expect(onStop).not.toHaveBeenCalled();
  });

  it('stops after the idle time when nothing runs or waits', async () => {
    const { onStop, heartbeat } = build(() => ({ data: null, count: 0 }), {
      idleStopMs: 15 * MINUTE,
    });

    await heartbeat.beat();
    clock += 14 * MINUTE;
    await heartbeat.beat();

    expect(onStop).not.toHaveBeenCalled();

    clock += MINUTE;
    await heartbeat.beat();

    expect(onStop).toHaveBeenCalledWith('idle');
  });

  it('looks only at its own places for busy runs', async () => {
    const { calls, heartbeat } = build(() => ({ data: null, count: 0 }), {
      idleStopMs: MINUTE,
    });

    await heartbeat.beat();

    const busy = calls.find(
      (call) =>
        call.table === 'test_automation_runs' &&
        call.ops.some(([op, args]) => op === 'in' && args[0] === 'worker_id'),
    );

    expect(busy?.ops).toContainEqual([
      'in',
      ['worker_id', ['host-42-1', 'host-42-2']],
    ]);
  });

  it('starts the idle time again when a run is busy or waiting', async () => {
    let count = 0;
    const { onStop, heartbeat } = build(
      (call) =>
        call.table === 'test_automation_runs' ? { count } : { data: null },
      { idleStopMs: 15 * MINUTE },
    );

    await heartbeat.beat();
    clock += 10 * MINUTE;
    count = 1;
    await heartbeat.beat();
    count = 0;
    clock += 10 * MINUTE;
    await heartbeat.beat();

    expect(onStop).not.toHaveBeenCalled();

    clock += 15 * MINUTE;
    await heartbeat.beat();

    expect(onStop).toHaveBeenCalledWith('idle');
  });

  it('never stops for idleness when the idle stop is off', async () => {
    const { calls, onStop, heartbeat } = build(() => ({
      data: null,
      count: 0,
    }));

    await heartbeat.beat();
    clock += 1000 * MINUTE;
    await heartbeat.beat();

    expect(onStop).not.toHaveBeenCalled();
    expect(calls.some((call) => call.table === 'test_automation_runs')).toBe(
      false,
    );
  });

  it('warns once and keeps going when the database fails', async () => {
    const { heartbeat } = build(() => ({ error: { message: 'down' } }));
    const warn = jest
      .spyOn(
        (heartbeat as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await expect(heartbeat.beat()).resolves.toBeUndefined();
    await expect(heartbeat.beat()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('removes its own rows when it stops', async () => {
    const { calls, heartbeat } = build(() => ({ data: null }));

    await heartbeat.stop();

    const remove = calls.find((call) => opOf(call, 'delete'));

    expect(remove?.table).toBe('cron_run_state');
    expect(opOf(remove as Call, 'in')).toEqual([
      'job_name',
      [
        'tm_runner.worker.host-42',
        'tm_runner.ready.host-42',
        'tm_runner.draining.host-42',
      ],
    ]);
  });

  it('does not wait forever for a slow database when it stops', async () => {
    jest.useFakeTimers();

    try {
      const slow = {
        getClient: () => ({
          from: () => ({
            delete: () => ({ in: () => new Promise(() => undefined) }),
          }),
        }),
      } as unknown as SupabaseAdminService;
      const heartbeat = new RunnerHeartbeat(
        slow,
        'host-42',
        1,
        () => true,
        0,
        jest.fn(),
        now,
      );
      const stopped = heartbeat.stop();

      jest.advanceTimersByTime(3_000);

      await expect(stopped).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
