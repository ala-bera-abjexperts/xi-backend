import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  folderBytes,
  hasEnoughDisk,
  readMaxDiskMb,
  readMinFreeGb,
  removeFolder,
  RunnerSweep,
  runnerWorkDir,
} from './runner.sweep';

const LEFT = '11111111-1111-4111-8111-111111111111';
const ACTIVE = '22222222-2222-4222-8222-222222222222';

describe('runner sweep', () => {
  const savedWorkDir = process.env.TM_RUNNER_WORK_DIR;

  let base: string;
  let labelledRunIds: jest.Mock;
  let remove: jest.Mock;
  let answer: { data: unknown; error: { message: string } | null };
  let from: jest.Mock;
  let sweep: RunnerSweep;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'runner-sweep-'));
    process.env.TM_RUNNER_WORK_DIR = base;
    labelledRunIds = jest.fn().mockResolvedValue([]);
    remove = jest.fn().mockResolvedValue(undefined);
    answer = { data: [], error: null };

    const chain: {
      select: () => unknown;
      in: () => unknown;
      then: (done: (value: typeof answer) => unknown) => Promise<unknown>;
    } = {
      select: () => chain,
      in: () => chain,
      then: (done) => Promise.resolve(answer).then(done),
    };

    from = jest.fn(() => chain);
    sweep = new RunnerSweep({ labelledRunIds, remove }, {
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService);
  });

  afterEach(() => {
    if (savedWorkDir === undefined) delete process.env.TM_RUNNER_WORK_DIR;
    else process.env.TM_RUNNER_WORK_DIR = savedWorkDir;

    rmSync(base, { recursive: true, force: true });
  });

  it('does not ask the database when nothing is left', async () => {
    await sweep.run();

    expect(from).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes containers and the folder of a run that is over', async () => {
    labelledRunIds.mockResolvedValue([LEFT]);
    mkdirSync(join(base, LEFT));

    await sweep.run();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(LEFT);
    expect(existsSync(join(base, LEFT))).toBe(false);
  });

  it('finds a run that only left a folder', async () => {
    mkdirSync(join(base, LEFT));

    await sweep.run();

    expect(remove).toHaveBeenCalledWith(LEFT);
  });

  it('keeps a run the database says is still active', async () => {
    labelledRunIds.mockResolvedValue([ACTIVE, LEFT]);
    mkdirSync(join(base, ACTIVE));
    answer = { data: [{ id: ACTIVE }], error: null };

    await sweep.run();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(LEFT);
    expect(existsSync(join(base, ACTIVE))).toBe(true);
  });

  it('removes nothing when the database cannot be read', async () => {
    labelledRunIds.mockResolvedValue([LEFT]);
    mkdirSync(join(base, LEFT));
    answer = { data: null, error: { message: 'down' } };

    await expect(sweep.run()).resolves.toBeUndefined();

    expect(remove).not.toHaveBeenCalled();
    expect(existsSync(join(base, LEFT))).toBe(true);
  });

  it('ignores folders that are not runs', async () => {
    mkdirSync(join(base, 'something-else'));

    await sweep.run();

    expect(remove).not.toHaveBeenCalled();
    expect(existsSync(join(base, 'something-else'))).toBe(true);
  });

  it('goes on with the next run when one cannot be removed', async () => {
    labelledRunIds.mockResolvedValue([LEFT, ACTIVE]);
    mkdirSync(join(base, ACTIVE));
    remove.mockRejectedValueOnce(new Error('rm failed'));

    await expect(sweep.run()).resolves.toBeUndefined();

    expect(remove).toHaveBeenCalledTimes(2);
    expect(existsSync(join(base, ACTIVE))).toBe(false);
  });

  it('does not start again while one sweep is going', async () => {
    let release: (ids: string[]) => void = () => undefined;

    labelledRunIds.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        release = resolve;
      }),
    );

    const first = sweep.run();

    await sweep.run();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(labelledRunIds).toHaveBeenCalledTimes(1);

    release([]);
    await first;
    await sweep.run();

    expect(labelledRunIds).toHaveBeenCalledTimes(2);
  });

  it('survives Docker being down', async () => {
    labelledRunIds.mockRejectedValue(new Error('daemon down'));

    await expect(sweep.run()).resolves.toBeUndefined();
  });

  describe('readMaxDiskMb', () => {
    it.each([
      [undefined, 2048],
      ['', 2048],
      ['abc', 2048],
      ['0', 2048],
      ['-1', 2048],
      ['100', 100],
    ])('reads %j as %d', (raw, expected) => {
      expect(readMaxDiskMb(raw)).toBe(expected);
    });
  });

  describe('folderBytes', () => {
    beforeEach(() => {
      mkdirSync(join(base, 'a', 'b'), { recursive: true });
      writeFileSync(join(base, 'a', 'one'), 'x'.repeat(10));
      writeFileSync(join(base, 'a', 'b', 'two'), 'x'.repeat(5));
    });

    it('adds up every file below the folder', async () => {
      await expect(folderBytes(base)).resolves.toBe(15);
    });

    it('does not follow links', async () => {
      symlinkSync(join(base, 'a'), join(base, 'link'));

      await expect(folderBytes(base)).resolves.toBe(15);
    });

    it('counts a missing folder as empty', async () => {
      await expect(folderBytes(join(base, 'none'))).resolves.toBe(0);
    });

    it('stops early once past the limit', async () => {
      await expect(folderBytes(join(base, 'a'), 5)).resolves.toBe(10);
    });

    it.each([
      ['no rights at all', 0o000],
      ['read but no entry', 0o644],
    ])('counts a folder hidden with %s', async (_name, mode) => {
      chmodSync(join(base, 'a', 'b'), mode);

      await expect(folderBytes(base)).resolves.toBe(15);
    });
  });

  describe('removeFolder', () => {
    it('removes a folder with a closed folder inside', async () => {
      const closed = join(base, 'run', 'closed');

      mkdirSync(closed, { recursive: true });
      writeFileSync(join(closed, 'file'), 'x');
      chmodSync(closed, 0o000);

      await removeFolder(join(base, 'run'));

      expect(existsSync(join(base, 'run'))).toBe(false);
    });

    it('accepts a folder that is already gone', async () => {
      await expect(removeFolder(join(base, 'none'))).resolves.toBeUndefined();
    });
  });

  it('removes a left-behind run with a closed folder inside', async () => {
    const closed = join(base, LEFT, 'closed');

    mkdirSync(closed, { recursive: true });
    writeFileSync(join(closed, 'file'), 'x');
    chmodSync(closed, 0o000);

    await sweep.run();

    expect(existsSync(join(base, LEFT))).toBe(false);
  });

  describe('readMinFreeGb', () => {
    it.each([
      [undefined, 5],
      ['', 5],
      ['abc', 5],
      ['-1', 5],
      ['0', 0],
      ['2.5', 2.5],
    ])('reads %j as %d', (raw, expected) => {
      expect(readMinFreeGb(raw)).toBe(expected);
    });
  });

  describe('hasEnoughDisk', () => {
    it('says yes when there is room, and creates the folder', async () => {
      process.env.TM_RUNNER_WORK_DIR = join(base, 'new');

      await expect(hasEnoughDisk(0)).resolves.toBe(true);
      expect(existsSync(runnerWorkDir())).toBe(true);
    });

    it('says no below the limit', async () => {
      await expect(hasEnoughDisk(10 ** 9)).resolves.toBe(false);
    });

    it('says no when the check itself fails', async () => {
      process.env.TM_RUNNER_WORK_DIR = '/dev/null/not-a-folder';

      await expect(hasEnoughDisk(0)).resolves.toBe(false);
    });
  });
});
