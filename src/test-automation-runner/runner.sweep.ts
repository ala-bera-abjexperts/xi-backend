import { constants } from 'fs';
import { access, chmod, lstat, mkdir, readdir, rm, statfs } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { Logger } from '@nestjs/common';

import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { DockerDriver } from './docker-driver';

const RUN_FOLDER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_MIN_FREE_GB = 5;
const DEFAULT_MAX_DISK_MB = 2048;

export function runnerWorkDir(): string {
  return process.env.TM_RUNNER_WORK_DIR ?? join(tmpdir(), 'xis-tm-runner');
}

export function readMinFreeGb(raw = process.env.TM_RUNNER_MIN_FREE_GB): number {
  const value = Number(raw);

  return raw && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_MIN_FREE_GB;
}

/** Whether there is room for another run. A check that fails says no: running out of disk mid-run is worse. */
export async function hasEnoughDisk(
  minFreeGb = readMinFreeGb(),
): Promise<boolean> {
  try {
    const folder = runnerWorkDir();

    await mkdir(folder, { recursive: true });

    const { bavail, bsize } = await statfs(folder);

    return bavail * bsize >= minFreeGb * 1024 ** 3;
  } catch {
    return false;
  }
}

/** How much one run's folder may hold. */
export function readMaxDiskMb(raw = process.env.TM_RUNNER_MAX_DISK_MB): number {
  const value = Number(raw);

  return raw && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_MAX_DISK_MB;
}

/** A test can hide a folder with chmod, so it is opened to be counted. False when it stays closed. */
async function openFolder(folder: string): Promise<boolean> {
  try {
    await access(folder, constants.R_OK | constants.X_OK);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;

    return chmod(folder, 0o755).then(
      () => true,
      (failure: NodeJS.ErrnoException) => failure.code === 'ENOENT',
    );
  }
}

/** The size of a folder, stopping early once it passes the limit. Links are not followed; a folder that stays closed counts as over any limit. */
export async function folderBytes(
  folder: string,
  stopAbove = Infinity,
): Promise<number> {
  const pending = [folder];
  let total = 0;

  while (pending.length > 0 && total <= stopAbove) {
    const current = pending.pop() as string;

    if (!(await openFolder(current))) return Infinity;

    const entries = await readdir(current, { withFileTypes: true }).catch(
      () => [],
    );

    for (const entry of entries) {
      const path = join(current, entry.name);

      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        total += (await lstat(path).catch(() => null))?.size ?? 0;
      }
    }
  }

  return total;
}

/** rm can't enter a closed folder, so when it fails the folders are opened first. */
export async function removeFolder(folder: string): Promise<void> {
  const options = { recursive: true, force: true };

  await rm(folder, options).catch(async () => {
    const pending = [folder];

    while (pending.length > 0) {
      const current = pending.pop() as string;

      await chmod(current, 0o700).catch(() => undefined);

      const entries = await readdir(current, { withFileTypes: true }).catch(
        () => [],
      );

      for (const entry of entries) {
        if (entry.isDirectory()) pending.push(join(current, entry.name));
      }
    }

    await rm(folder, options);
  });
}

/**
 * Removes what crashed runs left behind. The database decides: anything still marked active is kept, so another
 * worker's run is safe, and when the database cannot be read nothing is removed.
 */
export class RunnerSweep {
  private readonly logger = new Logger(RunnerSweep.name);
  private busy = false;

  constructor(
    private readonly docker: Pick<DockerDriver, 'labelledRunIds' | 'remove'>,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  async run(): Promise<void> {
    if (this.busy) return;

    this.busy = true;

    try {
      const folders = await this.runFolders();
      const found = [
        ...new Set([...(await this.docker.labelledRunIds()), ...folders]),
      ];

      if (found.length === 0) return;

      const active = await this.activeRuns(found);

      for (const runId of found) {
        if (active.has(runId)) continue;

        // One run that can't be removed must not skip the others; the next sweep tries it again.
        try {
          this.logger.log(`Removing what run ${runId} left behind`);
          await this.docker.remove(runId);
          await removeFolder(join(runnerWorkDir(), runId));
        } catch (error) {
          this.logger.warn(
            `Could not remove what run ${runId} left behind: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Sweep skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.busy = false;
    }
  }

  private async runFolders(): Promise<string[]> {
    const names = await readdir(runnerWorkDir()).catch(() => [] as string[]);

    return names.filter((name) => RUN_FOLDER_PATTERN.test(name));
  }

  private async activeRuns(runIds: string[]): Promise<Set<string>> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('test_automation_runs')
      .select('id')
      .in('id', runIds)
      .in('status', ['RUNNING', 'UPLOADING']);

    if (error) throw new Error(error.message);

    return new Set(((data ?? []) as { id: string }[]).map(({ id }) => id));
  }
}
