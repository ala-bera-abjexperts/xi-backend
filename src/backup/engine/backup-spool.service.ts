/**
 * @fileoverview Temporary files for the alternate-format export layer.
 * @module src/backup/engine/backup-spool.service
 *
 * ## Why a temp file exists at all
 *
 * Used by XLSX and nothing else.
 *
 * Every other format streams straight into the archive member. They were spooled too while an
 * archive carried TWO members per table — appending a second while the first was still open
 * deadlocked, because archiver's queue has concurrency 1 (`archiver/lib/core.js`) and the drain
 * never came. An archive now carries one member, so that constraint is gone and spooling them was
 * costing a write to disk and a read back, per table, for nothing.
 *
 * XLSX cannot stream at all: SheetJS builds the whole workbook in memory and emits one finished
 * Buffer, so it has to be staged somewhere before it can be added to the archive.
 *
 * ## Why this is probed
 *
 * Nothing else in this backend touches the filesystem. A read-only container or a full disk is
 * therefore a new failure mode, and one that would otherwise surface halfway through a long run.
 * `probe()` runs in preflight so it fails in the first second with a reason.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Everything one run spools, cleaned up together. */
export interface SpoolSession {
  /** Opens a sink for one table's export file. */
  open(name: string): { path: string; sink: Writable };

  /** Reads a spooled file back for appending to the archive. */
  read(path: string): Readable;

  /** Throws when the file grew past the configured ceiling. */
  assertWithinLimit(path: string, table: string): Promise<void>;

  /** Remembers which archive entry a spooled file belongs to, so it can be freed on time. */
  trackEntry(entryName: string, path: string): void;

  /**
   * Deletes the file behind a finished archive entry.
   *
   * Called from archiver's `entry` event. Because archiver reads one entry at a time, that event
   * means the file has been fully consumed — so peak disk stays around one table rather than the
   * whole export layer. Unknown names are ignored: every NDJSON member raises this too.
   */
  releaseEntry(entryName: string): Promise<void>;

  /** Removes the whole directory. Safe to call twice. */
  dispose(): Promise<void>;
}

@Injectable()
export class BackupSpoolService {
  private readonly logger = new Logger(BackupSpoolService.name);

  constructor(private readonly config: ConfigService) {}

  private get root(): string {
    return this.config.get<string>('backup.spoolDir') ?? '/tmp';
  }

  /** The per-file ceiling. Public because the restore reader enforces it while spooling too. */
  get maxBytes(): number {
    return this.config.get<number>('backup.spoolMaxBytes') ?? 2_147_483_648;
  }

  /**
   * Proves the spool directory is usable before a run exports anything.
   *
   * @throws Error naming the directory, so a read-only container is diagnosable from one log line.
   */
  async probe(): Promise<void> {
    const probePath = join(this.root, `.backup-probe-${process.pid}`);

    try {
      await mkdir(this.root, { recursive: true });
      await writeFile(probePath, 'ok');
      await unlink(probePath);
    } catch (err) {
      throw new Error(
        `The backup spool directory ${this.root} is not writable, so an export cannot be staged: ` +
          `${(err as Error).message}. Set BACKUP_SPOOL_DIR to a writable path.`,
      );
    }
  }

  /** Creates an isolated directory for one run. */
  async createSession(runId: string): Promise<SpoolSession> {
    // The run id is in the path so a worker killed mid-run leaves files that are traceable to the
    // run that made them, rather than anonymous rubbish in the temp directory.
    const dir = join(this.root, `xisuite-backup-${runId}`);

    await mkdir(dir, { recursive: true });

    return this.sessionFor(dir);
  }

  private sessionFor(dir: string): SpoolSession {
    const maxBytes = this.maxBytes;
    const logger = this.logger;
    const byEntry = new Map<string, string>();

    return {
      open(name: string) {
        const path = join(dir, name);

        return { path, sink: createWriteStream(path) };
      },

      read(path: string) {
        return createReadStream(path);
      },

      async assertWithinLimit(path: string, table: string) {
        const info = await stat(path);

        if (info.size > maxBytes) {
          throw new Error(
            `The ${table} export reached ${info.size} bytes, above the ${maxBytes}-byte spool ` +
              'limit. Raise BACKUP_SPOOL_MAX_BYTES or choose a more compact format.',
          );
        }
      },

      trackEntry(entryName: string, path: string) {
        byEntry.set(entryName, path);
      },

      async releaseEntry(entryName: string) {
        const path = byEntry.get(entryName);

        if (!path) {
          return;
        }

        byEntry.delete(entryName);

        // Best effort: a failure to delete one staged file must never fail an otherwise good run.
        // dispose() sweeps whatever is left.
        await unlink(path).catch(() => undefined);
      },

      async dispose() {
        await rm(dir, { recursive: true, force: true }).catch((err: Error) => {
          logger.warn(
            `Could not remove the spool directory ${dir}: ${err.message}`,
          );
        });
      },
    };
  }
}
