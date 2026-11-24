import { Logger } from '@nestjs/common';

import { AutomationCronService } from '../automations/automation-cron.service';
import type { AutomationTickService } from '../automations/automation-tick.service';
import type { AutomationWorkerService } from '../automations/automation-worker.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { readRunningPerOrg, readSlots, RunnerLoop } from './runner.loop';

const WORKER = 'host-1';

describe('readSlots', () => {
  it.each([
    [undefined, 2],
    ['', 2],
    ['abc', 2],
    ['0', 2],
    ['-2', 2],
    ['1.5', 2],
    ['1', 1],
    ['2', 2],
    ['8', 8],
    ['50', 8],
  ])('reads %j as %i', (raw, slots) => {
    expect(readSlots(raw)).toBe(slots);
  });
});

describe('readRunningPerOrg', () => {
  it.each([
    [undefined, 1],
    ['', 1],
    ['abc', 1],
    ['0', 1],
    ['-2', 1],
    ['1.5', 1],
    ['1', 1],
    ['3', 3],
    ['8', 8],
    ['50', 8],
  ])('reads %j as %i', (raw, perOrg) => {
    expect(readRunningPerOrg(raw)).toBe(perOrg);
  });
});

describe('the workflow scheduler in this process', () => {
  const saved = process.env.TM_RUNNER_WORKER;

  let runTick: jest.Mock;
  let processWork: jest.Mock;
  let scheduler: AutomationCronService;

  beforeEach(() => {
    jest.useFakeTimers();
    runTick = jest.fn().mockResolvedValue({
      outboxRelayed: 0,
      schedulesFired: 0,
      sleepersWoken: 0,
      leasesRecovered: 0,
    });
    processWork = jest.fn().mockResolvedValue(0);
    scheduler = new AutomationCronService(
      { runTick } as unknown as AutomationTickService,
      new Proxy(
        {},
        { get: () => processWork },
      ) as unknown as AutomationWorkerService,
      // The tick lease (cron-claim.spec.ts): every chain resolves "one row moved" = claimed.
      {
        getClient: () => {
          const chain: Record<string, unknown> = {};
          for (const m of ['from', 'update', 'eq', 'lte', 'select']) {
            chain[m] = () => chain;
          }
          chain.then = (resolve: (v: unknown) => unknown) =>
            resolve({ data: [{ job_name: 'automation_tick_lease' }] });
          return chain;
        },
      } as unknown as SupabaseAdminService,
    );
  });

  afterEach(async () => {
    await scheduler.onModuleDestroy();
    jest.useRealTimers();

    if (saved === undefined) delete process.env.TM_RUNNER_WORKER;
    else process.env.TM_RUNNER_WORKER = saved;
  });

  it('stays off in the test runner', () => {
    process.env.TM_RUNNER_WORKER = '1';

    scheduler.onModuleInit();

    expect(runTick).not.toHaveBeenCalled();
    expect(processWork).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('runs as before anywhere else, such as in the API', async () => {
    delete process.env.TM_RUNNER_WORKER;

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(0); // let the tick lease claim settle

    expect(runTick).toHaveBeenCalledTimes(1);
    expect(processWork).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(2);
  });
});

describe('RunnerLoop', () => {
  let processNext: jest.Mock;

  /** Stops the loop once the runner was asked this many times, and hands back how it ended. */
  const runUntil = async (times: number, slots = 1, pollMs = 1) => {
    const loop = new RunnerLoop({ processNext }, WORKER, slots, pollMs);
    const asked = processNext.getMockImplementation();

    processNext.mockImplementation((id: string) => {
      if (processNext.mock.calls.length >= times) loop.stop();

      return asked ? (asked(id) as Promise<boolean>) : Promise.resolve(false);
    });

    await loop.run();
  };

  beforeEach(() => {
    processNext = jest.fn().mockResolvedValue(false);
    processNext.mockImplementation(() => Promise.resolve(false));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps asking for work and stops when told', async () => {
    await runUntil(3);

    expect(processNext).toHaveBeenCalledTimes(3);
  });

  it('gives each slot its own worker id', async () => {
    await runUntil(2, 2);

    const ids = (processNext.mock.calls as string[][]).map(([id]) => id);

    expect(new Set(ids)).toEqual(new Set([`${WORKER}-1`, `${WORKER}-2`]));
  });

  it('takes the next run at once after finishing one', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });

    const answers = [true, true, false];
    const loop = new RunnerLoop({ processNext }, WORKER, 1, 60_000);

    processNext.mockImplementation(() => {
      if (answers.length === 1) loop.stop();

      return Promise.resolve(answers.shift() ?? false);
    });

    await loop.run();

    expect(processNext).toHaveBeenCalledTimes(3);
  });

  it('waits before asking again when nothing is waiting', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });

    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const loop = new RunnerLoop({ processNext }, WORKER, 1, 5000);
    const running = loop.run();

    await settle();
    expect(processNext).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(4999);
    await settle();
    expect(processNext).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    await settle();
    expect(processNext).toHaveBeenCalledTimes(2);

    loop.stop();
    await running;
  });

  it('wakes up at once when told to stop while waiting', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });

    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const loop = new RunnerLoop({ processNext }, WORKER, 1, 60_000);
    const running = loop.run();

    await settle();
    loop.stop();

    await expect(running).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('finishes the run in progress before stopping', async () => {
    let finishRun: (took: boolean) => void = () => undefined;

    processNext.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishRun = resolve;
        }),
    );

    const loop = new RunnerLoop({ processNext }, WORKER, 1, 1);
    let ended = false;
    const running = loop.run().then(() => {
      ended = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    loop.stop();
    await new Promise((resolve) => setImmediate(resolve));

    expect(ended).toBe(false);

    finishRun(true);
    await running;

    expect(ended).toBe(true);
    expect(processNext).toHaveBeenCalledTimes(1);
  });

  it('survives a run that throws, and keeps going', async () => {
    const answers: (() => Promise<boolean>)[] = [
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve(false),
    ];

    processNext.mockImplementation(() => {
      const next = answers.shift();

      return next ? next() : Promise.resolve(false);
    });

    await expect(runUntil(2)).resolves.toBeUndefined();
    expect(processNext).toHaveBeenCalledTimes(2);
  });

  it('takes no run while it is not ready, and asks again', async () => {
    const ready = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const loop = new RunnerLoop(
      { processNext },
      WORKER,
      1,
      1,
      ready as () => Promise<boolean>,
    );

    processNext.mockImplementation(() => {
      loop.stop();

      return Promise.resolve(false);
    });

    await loop.run();

    expect(ready).toHaveBeenCalledTimes(2);
    expect(processNext).toHaveBeenCalledTimes(1);
  });

  describe('saying why it takes no runs', () => {
    let warn: jest.SpyInstance;

    /** Answers each ready check in turn and stops at the end of the list. */
    const runWith = async (answers: boolean[]) => {
      const queue = [...answers];
      const loop = new RunnerLoop({ processNext }, WORKER, 1, 1, () => {
        const answer = queue.shift() ?? false;

        if (queue.length === 0) loop.stop();

        return Promise.resolve(answer);
      });

      await loop.run();
    };

    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it('warns once across several refusals', async () => {
      await runWith([false, false, false]);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('free disk space'),
      );
    });

    it('warns again after recovering and failing again', async () => {
      await runWith([false, true, false]);

      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('stays quiet while ready', async () => {
      await runWith([true, true]);

      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('does not start when stopped first', async () => {
    const loop = new RunnerLoop({ processNext }, WORKER, 2, 1);

    loop.stop();
    await loop.run();

    expect(processNext).not.toHaveBeenCalled();
  });
});
