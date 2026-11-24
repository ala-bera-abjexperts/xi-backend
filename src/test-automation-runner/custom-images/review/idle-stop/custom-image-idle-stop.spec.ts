import type { SupabaseAdminService } from '../../../../supabase/supabase-admin.service';
import { RunnerHeartbeat } from '../../../runner.heartbeat';

const START = Date.parse('2026-11-18T10:00:00.000Z');
const MINUTE = 60_000;

describe('RunnerHeartbeat idle stop with custom image checks', () => {
  const savedRegistries = process.env.TM_RUNNER_USER_REGISTRIES;
  let checking: number;
  let tables: string[];

  const supabase = {
    getClient: () => ({
      from: (table: string) => {
        const chain: Record<string, unknown> = {};

        tables.push(table);

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
          'maybeSingle',
        ]) {
          chain[op] = () => chain;
        }

        chain.then = (done: (value: unknown) => unknown) =>
          Promise.resolve({
            data: null,
            error: null,
            count: table === 'test_automation_user_images' ? checking : 0,
          }).then(done);

        return chain;
      },
    }),
  } as unknown as SupabaseAdminService;

  const stopsAfterIdleTime = async (): Promise<boolean> => {
    let now = START;
    const onStop = jest.fn();
    const heartbeat = new RunnerHeartbeat(
      supabase,
      'host-1',
      2,
      () => true,
      MINUTE,
      onStop,
      () => now,
    );

    await heartbeat.beat();
    now += 2 * MINUTE;
    await heartbeat.beat();

    return onStop.mock.calls.length > 0;
  };

  beforeEach(() => {
    tables = [];
    checking = 0;
  });

  afterEach(() => {
    if (savedRegistries === undefined) {
      delete process.env.TM_RUNNER_USER_REGISTRIES;
    } else {
      process.env.TM_RUNNER_USER_REGISTRIES = savedRegistries;
    }
  });

  it('keeps a runner that checks images while one is waiting or being checked', async () => {
    process.env.TM_RUNNER_USER_REGISTRIES = 'ghcr.io';
    checking = 1;

    await expect(stopsAfterIdleTime()).resolves.toBe(false);
    expect(tables).toContain('test_automation_user_images');
  });

  it('stops it once no image waits', async () => {
    process.env.TM_RUNNER_USER_REGISTRIES = 'ghcr.io';

    await expect(stopsAfterIdleTime()).resolves.toBe(true);
  });

  it('does not ask about images when this runner checks none', async () => {
    delete process.env.TM_RUNNER_USER_REGISTRIES;
    checking = 1;

    await expect(stopsAfterIdleTime()).resolves.toBe(true);
    expect(tables).not.toContain('test_automation_user_images');
  });
});
