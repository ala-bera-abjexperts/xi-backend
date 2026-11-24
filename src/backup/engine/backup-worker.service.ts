/**
 * @fileoverview Executes a queued run: export → package → upload → verify.
 * @module src/backup/engine/backup-worker.service
 *
 * This is the component whose absence made every run sit at "0 of 172 steps forever" — the state
 * machine had no transition out of `queued`.
 *
 * A run is claimed with a conditional UPDATE (`status='queued'` → `preflight`), so two replicas
 * cannot both take it: the second matches zero rows and moves on. Every later write is scoped to
 * the same worker id, so a run reclaimed by the reaper mid-flight is not written to by its old
 * owner.
 *
 * Items are marked as they finish rather than in one batch at the end, because that is what makes
 * the progress bar move while the run is happening.
 */

import { createHash } from 'crypto';
import { PassThrough, Readable, type Writable } from 'node:stream';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { SftpTargetAdapter } from '../adapters/sftp/sftp.adapter';
import type { TargetContext } from '../adapters/backup-target-adapter.interface';
import { renderRemoteName } from '../adapters/remote-path.util';
import {
  HEARTBEAT_INTERVAL_MS,
  RUN_DEADLINE_MS,
  WORKER_ID,
} from '../backup.constants';
import { ArchiveCipherError } from '../crypto/archive-cipher';
import { tableEntry } from '../registry/component-registry';
import { BackupSpoolService, type SpoolSession } from './backup-spool.service';
import { BackupStorageService } from './backup-storage.service';
import {
  buildManifest,
  buildReadme,
  type ManifestInput,
  type ManifestTable,
} from './archive-manifest';
import { FORMAT_REGISTRY } from './writers/format-registry';
import {
  DEFAULT_FILE_FORMAT,
  isBackupFileFormat,
  type BackupFileFormat,
  type TableWriter,
} from './writers/table-writer';
import {
  BackupArchiveCipherService,
  type ArchiveEncryptionRow,
  type ArchiveEncryptor,
} from '../services/backup-archive-cipher.service';
import { IN_FLIGHT_STATUSES } from '../services/backup-runs.service';
import { BackupSecretsService } from '../services/backup-secrets.service';
import {
  TableExporterService,
  type ParentScopeFilter,
} from './table-exporter.service';
import { UploadChunker } from './upload-chunker';

const RUNS_TABLE = 'backup_runs';
const ITEMS_TABLE = 'backup_run_items';
const TARGETS_TABLE = 'backup_targets';
const ARTIFACTS_TABLE = 'backup_artifacts';
const SCHEMES_TABLE = 'backup_schemes';

interface ClaimedRun {
  id: string;
  organization_id: string;
  scheme_id: string;
  target_id: string;
  target_config_snapshot: Record<string, unknown>;
  options_snapshot: Record<string, unknown> | null;

  /**
   * When the claim stamped the run as started.
   *
   * Selected back rather than recomputed, so `duration_ms` measures the run the database recorded
   * and not this process's clock. `claimRun` has always written it; it simply was not read, which
   * is why `duration_ms` was null on every run ever taken.
   */
  started_at: string | null;
}

interface RunItem {
  id: string;
  component_key: string;
  table_name: string | null;
  item_kind: string;
  sequence: number;
}

export interface WorkerStats {
  ran: number;
  succeeded: number;
  failed: number;
}

/**
 * A table slower than this gets a log line naming it.
 *
 * Set above any healthy table on a local database and well below the reaper's five-minute window,
 * so the log points at the culprit before the run is ever at risk.
 */
const SLOW_TABLE_LOG_MS = 2_000;

/**
 * How long a run took, for the `duration_ms` column.
 *
 * Returns null rather than a guess when `started_at` is absent or unparseable — the column is
 * nullable and "we do not know" is truthful, whereas a 0 would read as an instant backup. Clamped
 * at zero and rounded because the column is an integer and the only way to a negative is a clock
 * that moved.
 */
function durationMsSince(
  startedAt: string | null,
  finishedAt: Date,
): number | null {
  if (!startedAt) {
    return null;
  }

  const started = Date.parse(startedAt);

  if (Number.isNaN(started)) {
    return null;
  }

  return Math.max(0, Math.round(finishedAt.getTime() - started));
}

/**
 * Largest single stored object copied into an archive.
 *
 * `download()` materialises the object before it can be streamed, so this is the real memory
 * ceiling of a run, not a policy choice. Exceeding it fails loudly rather than letting one large
 * file take the process down mid-backup.
 */
const MAX_STORED_OBJECT_BYTES = 512 * 1024 * 1024;

/** Anything that can report a stream failure. Structural, so every stage satisfies it. */
interface ErrorSource {
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** The slice of archiver the export loop uses. Narrow, so the tests need no real zip. */
interface ArchiveAppender {
  append(source: Readable, options: { name: string }): unknown;
}

/** One member an export produced, and the digest of exactly that member's bytes. */
export interface ExportedMember {
  name: string;
  format: BackupFileFormat;
  sha256: string;
}

/** One format's live destination while a table is being written. */
interface ExportLayer {
  format: BackupFileFormat;
  memberName: string;
  hash: ReturnType<typeof createHash>;
  /** Resolves once every byte has passed the hash — see the note in openLayer. */
  hashed: Promise<void>;
  writer: TableWriter;
  /** Null for the one layer that streams straight into the archive. */
  staged: { path: string; sink: Writable } | null;
}

@Injectable()
export class BackupWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(BackupWorkerService.name);

  /**
   * Hands back any run this process was working on, before it exits.
   *
   * Without this, a restart strands the run: the heartbeat stops, but `updated_at` keeps the value
   * it had at the moment the process died, and the reaper will not touch it until
   * RUN_STALE_AFTER_MS has passed. That is five minutes during which the run shows as `verifying`
   * with no worker behind it, the scheme is blocked by `backup_runs_one_active_per_scheme`, and the
   * UI spins with nothing to say. Every deploy, every crash and — during development — every file
   * save pays that five minutes.
   *
   * Scoped to `worker_id = WORKER_ID`, so a process only ever releases its OWN runs: two workers
   * share this table, and releasing another's live run would drag a working backup backwards.
   *
   * `attempt_count` is deliberately NOT incremented. This is a clean handover, not a failure, and
   * counting it would spend one of the run's three attempts on a restart nobody chose.
   *
   * The reaper stays exactly as it is. This covers the orderly case; a hard kill, an OOM or a power
   * cut never reaches this code, and the staleness sweep is what catches those.
   */
  async onModuleDestroy(): Promise<void> {
    const { data, error } = (await this.supabaseAdmin
      .getClient()
      .from(RUNS_TABLE)
      .update({
        status: 'queued',
        lease_until: null,
        phase_detail: 'released_on_shutdown',
        // `worker_id` is deliberately LEFT SET. Every terminal write in this file is scoped
        // `.eq('worker_id', WORKER_ID)`, so clearing it here made a `finishRun` still in flight
        // match zero rows — the worker logged "succeeded" over a row it never changed, the run
        // stayed `verifying`, and the reaper requeued a backup that had actually completed.
        //
        // Safe to leave, because `claimRun` selects on `status = 'queued'` alone and overwrites
        // `worker_id` when it claims. The reaper still clears it, which is right: by the time it
        // acts, the worker really is gone.
      })
      .eq('worker_id', WORKER_ID)
      .in('status', IN_FLIGHT_STATUSES as unknown as string[])
      .select('id')) as unknown as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      // Never block shutdown on this. The reaper is the backstop, so the worst case is the five
      // minutes this exists to avoid — not a process that will not exit.
      this.logger.warn(`Could not release runs on shutdown: ${error.message}`);

      return;
    }

    if (!data?.length) {
      return;
    }

    // The items MUST go back with the run. The export loop claims `pending` items, so a run whose
    // items are all `succeeded` from the previous attempt finds nothing to do and dies with "This
    // run has no items to export" — a requeue that guarantees a failure. `BackupReaperService`
    // resets them for exactly this reason (`resetItems`, called from `requeueRun`), and a second
    // requeue path that forgets to is worse than no second path at all.
    const runIds = data.map((row) => row.id);

    const { error: itemsError } = (await this.supabaseAdmin
      .getClient()
      .from(ITEMS_TABLE)
      .update({
        status: 'pending',
        worker_id: null,
        lease_until: null,
        started_at: null,
        finished_at: null,
      })
      .in('run_id', runIds)) as unknown as {
      error: { message: string } | null;
    };

    if (itemsError) {
      this.logger.warn(
        `Released ${runIds.length} run(s) but could not reset their items: ${itemsError.message}`,
      );

      return;
    }

    this.logger.log(
      `Released ${runIds.length} in-flight run(s) on shutdown; they are queued again.`,
    );
  }

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly exporter: TableExporterService,
    private readonly secrets: BackupSecretsService,
    private readonly sftp: SftpTargetAdapter,
    private readonly cipher: BackupArchiveCipherService,
    private readonly spool: BackupSpoolService,
    private readonly storage: BackupStorageService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** One run per pass. Split from the @Cron so tests can drive it without a timer. */
  async drainOnce(): Promise<WorkerStats> {
    const stats: WorkerStats = { ran: 0, succeeded: 0, failed: 0 };
    const run = await this.claimRun();

    if (!run) {
      return stats;
    }

    stats.ran = 1;

    // Started before any work and stopped whatever happens. Without it the reaper cannot tell a
    // worker that is busy from one that has died, and kills every export over five minutes.
    const stopHeartbeat = this.startHeartbeat(run);

    try {
      await this.execute(run);
      stats.succeeded = 1;
    } catch (err) {
      stats.failed = 1;
      await this.failRun(run, err as Error);
    } finally {
      stopHeartbeat();
    }

    return stats;
  }

  /**
   * Tells the reaper this run is alive, every HEARTBEAT_INTERVAL_MS.
   *
   * The reaper reclaims an in-flight run whose `backup_runs.updated_at` is older than
   * RUN_STALE_AFTER_MS. The export loop writes only to `backup_run_items` — a table the reaper does
   * not read — so before this existed, any export lasting over five minutes was reclaimed as
   * abandoned, requeued, and after three attempts failed. Small runs finished inside the window and
   * looked healthy, which is why the bug survived: it only ever hit the full backup.
   *
   * @returns A stop function. Idempotent — clearInterval on a cleared timer is a no-op.
   */
  private startHeartbeat(run: ClaimedRun): () => void {
    const timer = setInterval(() => {
      void this.beat(run);
    }, HEARTBEAT_INTERVAL_MS);

    // A pending heartbeat must never hold the process open at shutdown.
    timer.unref();

    return () => clearInterval(timer);
  }

  private async beat(run: ClaimedRun): Promise<void> {
    const { error } = await this.db
      .from(RUNS_TABLE)
      .update({
        updated_at: new Date().toISOString(),
        lease_until: new Date(Date.now() + RUN_DEADLINE_MS).toISOString(),
      })
      .eq('id', run.id)
      // Fenced on both owner and status. A run the reaper has already taken, or one that has just
      // finished, matches nothing — so a heartbeat in flight can never revive a terminal run or
      // extend a lease this worker no longer holds.
      .eq('worker_id', WORKER_ID)
      .in('status', IN_FLIGHT_STATUSES as unknown as string[]);

    if (error) {
      // Survivable on its own: four more will fire before the run looks stale.
      this.logger.warn(`Heartbeat for run ${run.id} failed: ${error.message}`);
    }
  }

  /**
   * Takes ownership of one queued run.
   *
   * The `.eq('status','queued')` is the claim: two workers racing both issue this UPDATE, and only
   * one matches a row.
   */
  private async claimRun(): Promise<ClaimedRun | null> {
    const { data, error } = (await this.db
      .from(RUNS_TABLE)
      .update({
        status: 'preflight',
        worker_id: WORKER_ID,
        started_at: new Date().toISOString(),
        lease_until: new Date(Date.now() + RUN_DEADLINE_MS).toISOString(),
        phase_detail: 'claimed',
      })
      .eq('status', 'queued')
      .select(
        'id, organization_id, scheme_id, target_id, target_config_snapshot, options_snapshot, started_at',
      )
      .limit(1)
      .maybeSingle()) as unknown as {
      data: ClaimedRun | null;
      error: { message: string } | null;
    };

    if (error) {
      this.logger.error(`Could not claim a backup run: ${error.message}`);

      return null;
    }

    return data;
  }

  private async execute(run: ClaimedRun): Promise<void> {
    const ctx = await this.buildTargetContext(run);
    const items = await this.pendingItems(run);

    if (!items.length) {
      // A run with no work is a bug upstream, never a success.
      throw new Error('This run has no items to export.');
    }

    // Preflight: prove the server's row cap is above our page size BEFORE exporting anything.
    // The exporter treats a short first page as "that is the whole table", which is only sound
    // while the cap is higher than a page.
    await this.exporter.assertPageSizeIsSafe();

    const formats = this.formatsFor(run);

    // Staging the export layer needs a writable directory, and nothing else in this backend uses
    // one. Probed here so a read-only container fails in the first second, not an hour in.
    //
    // Needed when the run writes more than one layer, or when its single layer cannot stream
    // (XLSX). Archiver reads one member at a time, so only ONE of several layers can go straight
    // into the archive; the rest have to be staged and appended afterwards.
    //
    // A single streaming format still probes nothing and creates nothing — that is the common
    // path, and making a SQL backup fail on a read-only container it never touches would be a
    // regression.
    let session: SpoolSession | null = null;

    if (this.needsSpool(formats)) {
      await this.spool.probe();
      session = await this.spool.createSession(run.id);
    }

    // Built before the target is contacted. A scheme that asks for encryption but cannot produce
    // its passphrase has to fail the run here — not once the tenant's data is already on the wire.
    const encryptor = await this.loadEncryptor(run);

    if (encryptor) {
      // Written before a single byte is uploaded. The wrapped key also travels inside the archive
      // header, so this row is not the only copy — but recording it first keeps the two in step
      // even if the upload dies halfway.
      await this.recordRunKey(run, encryptor);
    }

    const verify = await this.sftp.verify(ctx);

    if (!verify.ok) {
      throw new Error(
        verify.error ?? 'The backup target could not be reached.',
      );
    }

    await this.setRunStatus(run, 'exporting', 'exporting');

    // archiver@8 exports named classes — verified: { Archiver, JsonArchive, TarArchive, ZipArchive }.
    // There is no default export and no callable `archiver('zip')` form as in v5.
    const { ZipArchive } = await import('archiver');
    // Honours the scheme's `compression` option, which was previously declared and ignored — every
    // archive was deflated at level 6 whatever the scheme said.
    //
    // The choice is not cosmetic. NDJSON and SQL compress 5-10x, so deflate is right for them. But
    // an archive carrying already-compressed content (this tenant's two 39 MB MP4s, any zip or
    // PDF) spends real CPU on it for no gain — and because the exporter's writes block on the
    // upload draining, that CPU sits directly in the critical path of the whole run.
    const level = this.compressionFor(run);
    const archive = new ZipArchive({ zlib: { level } });

    // archiver reads one entry at a time, so this event means the staged file behind it has been
    // fully consumed. Freeing it here keeps peak disk at roughly one table rather than the whole
    // export layer; dispose() in the finally is the backstop for anything still outstanding.
    archive.on('entry', (entry: { name?: string }) => {
      if (entry?.name) {
        void session?.releaseEntry(entry.name);
      }
    });

    // A single UTC timestamp, most-significant first, so the directory sorts chronologically:
    //   backup-20260804101425123.zip
    //
    // Milliseconds carry the uniqueness that the run id used to. That is sufficient here because
    // only one run per organization may be in flight at a time, so two archives cannot be named in
    // the same millisecond. Rendered through the shared util rather than a template literal so the
    // separator/'..'/control-character rejection still applies.
    //
    // Always `.zip`, encrypted or not. An encrypted archive is not a file a zip reader can open,
    // but the extension stays uniform so every archive in the directory looks and sorts the same.
    // `backup_artifacts.is_encrypted` and the run's "Encrypted" chip are where that is recorded.
    const name = renderRemoteName('backup-{yyyy}{mm}{dd}{hhmmss}{ms}.zip', {
      scheme_slug: '',
      run_id: '',
      at: new Date(),
    });

    const upload = await this.sftp.openWrite(ctx, name);

    // Sits last in the chain, so it measures and hashes exactly the bytes that reach the server —
    // after compression and after encryption. That makes archive_sha256 a checksum of the stored
    // object, which is the only form that can be checked against the file later.
    const meter = new PassThrough();
    const digest = createHash('sha256');
    let archiveBytes = 0;

    meter.on('data', (chunk: Buffer) => {
      archiveBytes += chunk.length;
      digest.update(chunk);
    });

    if (encryptor) {
      archive.pipe(encryptor.stream).pipe(meter);
    } else {
      archive.pipe(meter);
    }

    // Re-cut to a size the SFTP layer can put several of on the wire at once. See upload-chunker.ts:
    // this is inseparable from the raised highWaterMark in sftp.adapter.ts, and alone it would be a
    // regression. It sits AFTER the meter so the byte count and archive_sha256 above are measured on
    // exactly the bytes they were before, and BEFORE the sink so abort() still destroys the stream
    // the adapter owns.
    const chunker = new UploadChunker();

    meter.pipe(chunker).pipe(upload.stream);

    // pipe() does not forward errors. Without this a cipher or archiver failure would leave the
    // upload stream open, commit() would wait on a transfer that never settles, and the run would
    // hang until its deadline instead of failing with the reason.
    //
    // The chunker MUST be in this list. As the destination of `meter.pipe(chunker)` it is where Node
    // re-emits an unhandled 'error', which with no listener is a process-level crash rather than a
    // failed run.
    const firstError = this.watchPipeline(
      [archive, encryptor?.stream, meter, chunker],
      upload.stream,
    );

    let rowTotal = 0;
    let tableCount = 0;

    /** Paths a row referenced but storage no longer held. Recorded on the run, never fatal. */
    const missingObjects: string[] = [];

    /** Per-table result, so the manifest reports what the run produced rather than intended. */
    const manifestTables: ManifestTable[] = [];
    let filesCopied = 0;

    try {
      for (const item of items) {
        // Always last in the plan, so every count and checksum below is final by the time it runs.
        if (item.item_kind === 'manifest') {
          this.appendManifest(archive, {
            runId: run.id,
            organizationId: run.organization_id,
            schemeVersion: null,
            formats,
            encrypted: Boolean(encryptor),
            createdAt: new Date(),
            tables: manifestTables,
            filesCopied,
            missingObjects,
          });

          await this.markItem(item, 'succeeded', 0);
          continue;
        }

        if (item.item_kind === 'storage_prefix') {
          await this.markItemRunning(item);

          const copied = await this.copyStoredObjects(
            archive,
            item.component_key,
            run.organization_id,
          );

          missingObjects.push(...copied.missing);
          filesCopied += copied.copied;
          await this.markItem(item, 'succeeded', copied.copied);
          continue;
        }

        if (item.item_kind !== 'table' || !item.table_name) {
          await this.markItem(item, 'skipped', 0);
          continue;
        }

        await this.markItemRunning(item);

        const startedAt = Date.now();

        const result = await this.exportOne(
          archive,
          item.table_name,
          run.organization_id,
          formats,
          session,
        );

        const elapsed = Date.now() - startedAt;

        // A table that takes seconds is worth a line. Every run before the heartbeat existed died
        // at roughly 22 tables in five minutes — about 13 seconds each — and nothing recorded
        // where that time went. Logging only the slow ones keeps 170 tables from becoming 170
        // lines while still naming whatever is actually costing the run.
        if (elapsed >= SLOW_TABLE_LOG_MS) {
          this.logger.warn(
            `${item.table_name} took ${elapsed} ms for ${result.rows} rows`,
          );
        }

        rowTotal += result.rows;

        // Counted once per TABLE, never per member. A run writing three layers still backed up one
        // table, and inflating this would make the manifest and the run row disagree with reality.
        tableCount += 1;
        manifestTables.push({
          table: item.table_name,
          rows: result.rows,
          members: result.members,
          status: 'succeeded',
        });

        // `backup_run_items.sha256` is one column, so it holds the primary member's digest — the
        // streamed layer, or the first when everything is staged. Every layer's digest is in the
        // manifest, which is what a restore verifies against.
        await this.markItem(
          item,
          'succeeded',
          result.rows,
          result.members[0]?.sha256,
        );
      }

      await this.setRunStatus(run, 'packaging', 'packaging');
      await this.setRunStatus(run, 'uploading', 'uploading');

      // finalize() ends the archive, which flushes the pipe chain and lets the adapter's transfer
      // settle. There is deliberately no wait on a 'finish' event here: by the time finalize()
      // resolves the stream has usually already finished, so a listener attached afterwards would
      // never fire and the upload would hang forever as a .part file. commit() awaits the transfer
      // itself, which is the reliable signal.
      // Timed because this single call was 99.5% of a 13-minute run and nothing said so. The item
      // timings in backup_run_items cover the export loop only, which finished in under four
      // seconds — so the numbers that existed actively pointed away from the problem.
      const drainStartedAt = Date.now();

      await archive.finalize();

      const drainMs = Date.now() - drainStartedAt;

      const pipelineError = firstError();

      if (pipelineError) {
        throw pipelineError;
      }

      await this.setRunStatus(run, 'verifying', 'verifying');
      // The meter has seen every byte by now, so this is the true on-the-wire size. Passing it is
      // what gives the upload a deadline proportional to the archive instead of the flat 60-second
      // floor every transfer used to get.
      const committed = await upload.commit(archiveBytes);

      // What we sent against what the server says it holds. A transfer that drops bytes and still
      // completes is otherwise indistinguishable from a good one, and would be recorded as a
      // healthy backup that cannot be restored.
      if (archiveBytes !== committed.byteSize) {
        throw new Error(
          `The server stored ${committed.byteSize} bytes of an archive that was ${archiveBytes} bytes long. ` +
            `The upload was incomplete; delete ${committed.remotePath} and run the backup again.`,
        );
      }

      // Throughput, in the one place that can compute it. "142 KB/s" is the whole diagnosis of a
      // slow upload, and deriving it from run timestamps afterwards is impossible because those
      // include the export, the handshakes and the bookkeeping.
      const drainSeconds = Math.max(drainMs, 1) / 1000;

      this.logger.log(
        `Archive drained in ${drainSeconds.toFixed(1)}s: ${archiveBytes} bytes ` +
          `(${(archiveBytes / 1024 / drainSeconds).toFixed(0)} KB/s)`,
      );

      // digest() finalises the hash, so it is read once and shared by both writers.
      const archiveSha256 = digest.digest('hex');

      await this.recordArtifact(run, committed, {
        sha256: archiveSha256,
        encryptor,
      });
      await this.finishRun(run, {
        missingObjects,
        rowCount: rowTotal,
        tableCount,
        archiveBytes: committed.byteSize,
        archiveSha256,
        encrypted: Boolean(encryptor),
      });
    } catch (err) {
      // Never leave a partial file where a reader or a retention sweep could mistake it for a
      // finished archive.
      await upload.abort().catch(() => undefined);

      // A stream failure reaches the caller as "the transfer was destroyed"; the captured error is
      // the reason it was destroyed, which is what an admin actually needs to read.
      throw firstError() ?? err;
    } finally {
      // Runs on every path, including the ones that threw before the archive was finalised. A
      // worker that dies outright still leaves a directory named after its run, which is what
      // makes the leftovers identifiable rather than anonymous.
      await session?.dispose();
    }
  }

  /**
   * Records the first error from any stage and tears the upload down so nothing waits forever.
   *
   * @returns A getter for that error — null while the pipeline is healthy.
   */
  private watchPipeline(
    stages: (ErrorSource | undefined)[],
    sink: Writable,
  ): () => Error | null {
    let first: Error | null = null;

    const capture = (err: Error): void => {
      if (first) {
        return;
      }

      first = err;
      this.logger.error(`Backup stream failed: ${err.message}`);

      // Destroying the sink makes the adapter's in-flight transfer reject, so commit() and abort()
      // settle rather than hanging on a stream that will never end.
      sink.destroy(err);
    };

    for (const stage of stages) {
      stage?.on('error', capture);
    }

    return () => first;
  }

  /** Loads the scheme's encryption settings and builds the cipher. Null means encryption is off. */
  private async loadEncryptor(
    run: ClaimedRun,
  ): Promise<ArchiveEncryptor | null> {
    const { data, error } = (await this.db
      .from(SCHEMES_TABLE)
      .select(
        'encrypt_archive, archive_passphrase_encrypted, archive_passphrase_iv, archive_passphrase_tag, key_fingerprint',
      )
      .eq('id', run.scheme_id)
      .eq('organization_id', run.organization_id)
      .maybeSingle()) as unknown as {
      data: ArchiveEncryptionRow | null;
      error: { message: string } | null;
    };

    if (error || !data) {
      throw new Error(
        'The backup scheme for this run could not be loaded, so its encryption settings are unknown.',
      );
    }

    return this.cipher.createEncryptor(data);
  }

  /**
   * Stores the wrapped per-run key.
   *
   * Scoped to this worker like every other write here, so a run the reaper has handed on is never
   * overwritten by its old owner. Note that a no-op update is not an error in PostgREST: this
   * prevents a stale write, it does not report one. The archive stays readable regardless, because
   * the same wrapped key is written into the archive header.
   */
  private async recordRunKey(
    run: ClaimedRun,
    encryptor: ArchiveEncryptor,
  ): Promise<void> {
    const { error } = await this.db
      .from(RUNS_TABLE)
      .update(encryptor.runKey)
      .eq('id', run.id)
      .eq('worker_id', WORKER_ID);

    if (error) {
      throw new Error(
        `The archive key could not be recorded, so the run was stopped before writing anything: ${error.message}`,
      );
    }
  }

  /**
   * Streams one table into the archive as exactly ONE member, in the selected format.
   *
   * `data/<table>.ndjson` for NDJSON, `data/<NN>-<table>.sql` for SQL, `data/<table>.<ext>` for the
   * rest. There is no second layer: an archive contains the format that was chosen and nothing
   * else.
   *
   * NDJSON streams straight into the archive member. Every other format is written to a spool file
   * first and appended once complete, for two reasons: archiver's queue has concurrency 1, so a
   * member appended alongside an open one is never read and the `drain` this loop waits on never
   * fires — a deadlock that hangs the run until its six-hour deadline — and SheetJS cannot stream
   * at all.
   *
   * The checksum covers the bytes that actually reach the archive, whatever the format.
   */
  private async exportOne(
    archive: ArchiveAppender,
    table: string,
    organizationId: string,
    formats: BackupFileFormat[],
    session: SpoolSession | null,
  ): Promise<{ rows: number; members: ExportedMember[] }> {
    const entry = tableEntry(table);

    // Checked before a single member is appended. Opening some layers and then discovering the
    // spool is missing would leave an open member archiver can never finish reading, which hangs
    // the run instead of failing it.
    if (this.needsSpool(formats) && !session) {
      throw new Error(
        `Cannot write ${table} as ${formats.join(' + ')}: no spool is available for this run.`,
      );
    }

    // At most ONE layer may stream. Archiver reads one member at a time, so two open members
    // deadlock: the write to the first blocks, so it never ends, so the second is never reached.
    // The rest are staged to disk and appended once the row loop is done.
    const streamedIndex = formats.findIndex(
      (format) => FORMAT_REGISTRY[format].streams,
    );

    const layers = formats.map((format, index) =>
      this.openLayer(
        archive,
        table,
        entry?.insertLevel,
        format,
        index === streamedIndex,
        session,
      ),
    );

    let rows = 0;

    // The tenant column is a property of the table, not a constant: seven tables
    // (space_gdpr_*, space_lists, space_robots) are scoped by `organizationid`. Letting the
    // exporter default to `organization_id` made every one of them fail with PostgREST 42703 —
    // dormant only because no run had ever reached them.
    const scope = this.scopeFor(table);
    const pages = this.exporter.exportTable(
      table,
      organizationId,
      scope.tenantColumn,
      scope.parentScope,
      scope.orderBy,
    );

    // The next page is requested BEFORE the current one is written, so the database round-trip
    // overlaps the compression and upload of the page already in hand. Without this the two take
    // strict turns — fetch, write, fetch, write — and because `member.write` blocks until the
    // upload drains, the database sits idle for the whole of every upload and vice versa.
    let pending = pages.next();

    for (;;) {
      const next = await pending;

      if (next.done) {
        break;
      }

      pending = pages.next();

      // An in-flight fetch whose result is never awaited (because the write below threw) would
      // surface as an unhandled rejection and take the process down. The real error still
      // propagates; this only stops the abandoned page from becoming a second, fatal one.
      pending.catch(() => undefined);

      for (const row of next.value) {
        rows += 1;

        // Every layer sees the row from the SAME page. The database is read once no matter how
        // many formats were chosen — the cost of a second format is CPU and bytes, never another
        // query. writeChunk inside each writer respects backpressure, so a large table never
        // buffers in memory.
        for (const layer of layers) {
          await layer.writer.writeRow(row);
        }
      }
    }

    // Ends each hashing stream, which ends whatever it feeds — the archive member, or the file.
    for (const layer of layers) {
      await layer.writer.finish();
    }

    for (const layer of layers) {
      if (!layer.staged || !session) {
        continue;
      }

      // `endSink` only ends the stream it was handed. The WriteStream underneath may still be
      // flushing, and appending at that moment would zip a partially written file that still looks
      // like a valid member. So wait for the file itself to close.
      await this.awaitClosed(layer.staged.sink);
      await session.assertWithinLimit(layer.staged.path, table);

      // Tracked before the append, so the 'entry' listener cannot fire on a name it has not seen.
      session.trackEntry(layer.memberName, layer.staged.path);
      archive.append(session.read(layer.staged.path), {
        name: layer.memberName,
      });
    }

    // Every byte has now reached each hash, so the digests describe whole members rather than
    // however much of each happened to have flowed by.
    for (const layer of layers) {
      await layer.hashed;
    }

    // Streamed layer first, matching the order the members appear in the zip and making
    // `members[0]` the one whose digest goes on the run item.
    const ordered = [
      ...layers.filter((layer) => !layer.staged),
      ...layers.filter((layer) => layer.staged),
    ];

    return {
      rows,
      members: ordered.map((layer) => ({
        name: layer.memberName,
        format: layer.format,
        sha256: layer.hash.digest('hex'),
      })),
    };
  }

  /**
   * Opens one format's destination for one table.
   *
   * `stream` is true for at most one layer per table — see the deadlock note in exportOne. The
   * hashing stage sits in front of both destinations so the checksum always covers the bytes that
   * actually reach the archive.
   */
  private openLayer(
    archive: ArchiveAppender,
    table: string,
    insertLevel: number | undefined,
    format: BackupFileFormat,
    stream: boolean,
    session: SpoolSession | null,
  ): ExportLayer {
    const definition = FORMAT_REGISTRY[format];
    const memberName = `data/${this.exportMemberName(table, insertLevel, definition.extension)}`;
    const hash = createHash('sha256');

    // The listener sits on OUR stream, never on the archive member — attaching one there would
    // flip the member into flowing mode alongside archiver's own read of it.
    const hashing = new PassThrough();

    hashing.on('data', (chunk: Buffer) => hash.update(chunk));

    // The digest can only be taken once the LAST byte has passed the hash, and `writer.finish()`
    // does not mean that: it ends the WRITABLE side, while the readable side is still draining into
    // the archive member. Digesting there throws ERR_CRYPTO_HASH_FINALIZED on the next `data`
    // event — inside a stream listener, so it takes the process down rather than failing the run.
    //
    // Subscribed here, before a single row is written, because an `end` that fires before the
    // listener is attached is an event that never arrives.
    const hashed = this.awaitDrained(hashing);

    // A rejection surfacing before exportOne awaits it would be an unhandled one. The real error
    // still propagates; this only stops the abandoned stream from becoming a second, fatal error.
    hashed.catch(() => undefined);

    let staged: { path: string; sink: Writable } | null = null;

    if (stream) {
      // Straight into the archive. This member is ended before the next is appended, so archiver
      // always drains the one in hand — a full buffer stalls, it cannot deadlock.
      const member = new PassThrough();

      archive.append(member, { name: memberName });
      hashing.pipe(member);
    } else {
      if (!session) {
        // Refused rather than skipped. Without a destination this loop would read every row, count
        // them, and append NOTHING — a table silently absent from a run reported as successful.
        throw new Error(
          `Cannot write ${table} as ${format}: no spool is available for this run.`,
        );
      }

      staged = session.open(`${table}.${definition.extension}`);
      hashing.pipe(staged.sink);
    }

    return {
      format,
      memberName,
      hash,
      hashed,
      staged,
      writer: definition.create(hashing, {
        table,
        insertLevel: insertLevel ?? 0,
      }),
    };
  }

  /**
   * True when the run cannot write every layer straight into the archive.
   *
   * One streaming format needs nothing staged, which is the common path and the one that must stay
   * exactly as it was. More than one layer, or a single layer that cannot stream, needs the spool.
   */
  private needsSpool(formats: BackupFileFormat[]): boolean {
    return (
      formats.length > 1 || !formats.every((f) => FORMAT_REGISTRY[f].streams)
    );
  }

  /**
   * Resolves once a stream has finished writing, or immediately if it already has.
   *
   * `endSink` ends the stream it is given; with a hashing stage in front of the file, that is not
   * the file. Without this wait the archive can contain a truncated member.
   */
  /**
   * Resolves once every byte a stream will produce has been read out of it.
   *
   * The counterpart to awaitClosed: that one waits for a stream to finish being WRITTEN, this one
   * waits for it to finish being READ. A hash fed by a `data` listener is only complete at `end`.
   */
  private awaitDrained(source: Readable): Promise<void> {
    if (source.readableEnded) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      source.once('end', resolve);
      source.once('error', reject);
    });
  }

  private awaitClosed(sink: Writable): Promise<void> {
    if (sink.writableFinished) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      sink.once('finish', resolve);
      sink.once('close', resolve);
      sink.once('error', reject);
    });
  }

  /**
   * Writes README.txt and manifest.json at the archive root.
   *
   * Both are small and already in memory, so they are appended as buffers rather than streamed.
   * Written from the collected per-item results, so the manifest describes what the run actually
   * produced — a manifest that overstated a partial archive would turn a visibly incomplete backup
   * into an invisibly incomplete one.
   */
  private appendManifest(archive: ArchiveAppender, input: ManifestInput): void {
    const files: [string, string][] = [
      ['README.txt', buildReadme(input)],
      ['manifest.json', buildManifest(input)],
    ];

    for (const [name, contents] of files) {
      archive.append(Readable.from([Buffer.from(contents, 'utf8')]), { name });
    }
  }

  /**
   * Copies one component's stored objects into the archive under `files/<bucket>/<path>`.
   *
   * The path list comes from the component's version table, never from listing the bucket: a
   * bucket is shared by every tenant, so listing one would make isolation depend on a path
   * convention rather than on a row this organization owns.
   *
   * Each object is appended as its own archive entry and awaited in turn, because archiver reads
   * one entry at a time — the same constraint that made the two-layer table export deadlock.
   */
  private async copyStoredObjects(
    archive: ArchiveAppender,
    component: string,
    organizationId: string,
  ): Promise<{ copied: number; missing: string[] }> {
    const sources = this.storage.sourcesFor(component);

    if (!sources.length) {
      return { copied: 0, missing: [] };
    }

    const missing: string[] = [];
    // Two tables can reference the same object — a task attachment and the file_versions row for
    // the same upload both live in `attachments`. Appending it twice would put a duplicate entry
    // in the zip and copy the bytes twice.
    const appended = new Set<string>();
    let copied = 0;

    for (const source of sources) {
      const paths = await this.storage.collectPaths(organizationId, source);

      for (const path of paths) {
        const opened = await this.storage.open(source, path);

        if (!opened) {
          // A row pointing at an object storage no longer holds is a pre-existing inconsistency in
          // the tenant's data. Failing here would let one stale reference block every future
          // backup, so it is counted and surfaced on the run instead.
          missing.push(path);
          continue;
        }

        if (opened.object.bytes > MAX_STORED_OBJECT_BYTES) {
          throw new Error(
            `${path} is ${opened.object.bytes} bytes, above the ${MAX_STORED_OBJECT_BYTES}-byte ` +
              'per-file limit. Raise BACKUP_MAX_OBJECT_BYTES or exclude this component.',
          );
        }

        const name = `files/${opened.object.bucket}/${path}`;

        if (appended.has(name)) {
          // Already in the archive from an earlier source. Drain the body so the download does
          // not sit open holding its socket.
          opened.body.resume();
          continue;
        }

        appended.add(name);
        archive.append(opened.body, { name });

        copied += 1;
      }
    }

    if (missing.length) {
      this.logger.warn(
        `${component}: ${missing.length} referenced file(s) were not in storage`,
      );
    }

    return { copied, missing };
  }

  /**
   * The archive path for the human-readable copy of a table.
   *
   * SQL is prefixed with its dependency level, zero-padded, so alphabetical order is insert order
   * and `for f in data/*.sql; do psql -f "$f"; done` applies cleanly. The other formats are never
   * executed, so ordering them would be noise in a file listing.
   */
  private exportMemberName(
    table: string,
    insertLevel: number | undefined,
    extension: string,
  ): string {
    if (extension !== 'sql') {
      return `${table}.${extension}`;
    }

    return `${String(insertLevel ?? 0).padStart(2, '0')}-${table}.${extension}`;
  }

  /**
   * zlib level for the archive, from the scheme's frozen `compression` option.
   *
   * `none` maps to level 0 — the zip still carries every entry, stored rather than deflated. An
   * unknown value falls back to deflate: a slower archive is always better than a failed run.
   */
  private compressionFor(run: ClaimedRun): number {
    return run.options_snapshot?.compression === 'none' ? 0 : 6;
  }

  /**
   * The export format frozen onto this run.
   *
   * Read from `options_snapshot`, never from the scheme: the scheme can be edited while a run is
   * queued, and an archive must be described by the settings it was created with.
   *
   * A snapshot with no `file_format` falls back to the product default, exactly like a snapshot
   * carrying an unrecognised one. It used to fall back to NDJSON, on the reasoning that archives
   * predating the setting contained NDJSON — but that made a missing field silently produce a
   * format nobody chose, which is the one thing this whole setting exists to stop. Every run in the
   * database without the field is already terminal, so nothing in flight depends on the old
   * behaviour.
   */
  private formatsFor(run: ClaimedRun): BackupFileFormat[] {
    const snapshot = run.options_snapshot;
    const requested = Array.isArray(snapshot?.file_formats)
      ? (snapshot.file_formats as unknown[])
      : snapshot?.file_format === undefined || snapshot?.file_format === null
        ? []
        : [snapshot.file_format];

    const known: BackupFileFormat[] = [];

    for (const entry of requested) {
      if (!isBackupFileFormat(entry)) {
        // Bad snapshot data must not take the run down — the backup is still worth having.
        this.logger.warn(
          `Run ${run.id} requests the unknown format ${JSON.stringify(entry)}; ` +
            'that layer was skipped.',
        );

        continue;
      }

      // A snapshot listing the same format twice would write the same member twice and give
      // archiver two entries of one name.
      if (!known.includes(entry)) {
        known.push(entry);
      }
    }

    if (!known.length) {
      // Nothing usable was named. Falling back to the product default is the same choice a
      // snapshot with no format at all gets, rather than writing nothing.
      return [DEFAULT_FILE_FORMAT];
    }

    return known;
  }

  /**
   * How a table is narrowed to one organization.
   *
   * Most tables carry their own tenant column — seven spell it `organizationid`, which is why this
   * is read from the registry rather than assumed. A few carry none at all and are scoped through
   * their parent instead.
   *
   * Throws rather than guessing when a table is not in the registry. Exporting with the wrong
   * tenant filter is the one mistake a backup must never make quietly: it would either fail
   * outright or, far worse, read another tenant's rows into this organization's archive.
   */
  private scopeFor(table: string): {
    tenantColumn: string | null;
    parentScope?: ParentScopeFilter;
    orderBy: string[];
  } {
    const entry = tableEntry(table);

    if (!entry) {
      throw new Error(
        `${table} is not in the backup component registry, so its tenant column is unknown.`,
      );
    }

    return {
      tenantColumn: entry.tenantColumn,
      parentScope: entry.parentScope
        ? {
            parentTable: entry.parentScope.parentTable,
            parentTenantColumn: entry.parentScope.parentTenantColumn,
            // Carried through rather than dropped. The registry has always known which FK links a
            // child to its parent; losing it here is what made the exporter emit an ambiguous
            // embed and kill every run that reached automation_versions.
            parentColumn: entry.parentScope.column,
          }
        : undefined,
      // Six tables have no `id`; they declare their own key. Everything else pages on `id`, which
      // the catalog confirms is the sole primary key wherever it exists.
      orderBy: entry.orderBy ?? ['id'],
    };
  }

  private async buildTargetContext(run: ClaimedRun): Promise<TargetContext> {
    const { data, error } = (await this.db
      .from(TARGETS_TABLE)
      .select(
        'id, target_type, config, secret_encrypted, secret_iv, secret_tag, key_fingerprint',
      )
      .eq('id', run.target_id)
      .eq('organization_id', run.organization_id)
      .maybeSingle()) as unknown as {
      data: {
        id: string;
        target_type: string;
        config: Record<string, unknown> | null;
        secret_encrypted: string | null;
        secret_iv: string | null;
        secret_tag: string | null;
        key_fingerprint: string | null;
      } | null;
      error: { message: string } | null;
    };

    if (error || !data) {
      throw new Error('The backup target for this run could not be loaded.');
    }

    // Only SFTP has an adapter today. This guard sits BEFORE openTargetSecret deliberately: a
    // SharePoint target's secret is a Graph client-credentials bundle, and without this check the
    // run would decrypt it and hand it — along with a config that has no host, port or username —
    // to the SSH adapter injected below. It would fail either way; the point is to fail *here*,
    // with a message an admin can act on, and without a Graph credential ever being unsealed.
    //
    // BackupTargetsService.runVerify already refuses the same shape on the test path. This is the
    // matching refusal on the run path. Remove both once an adapter factory resolves by target_type
    // — see tasks/backup-and-restore/24-adapter-gaps-and-sharepoint-readiness.md (G-1, G-3).
    if (data.target_type !== 'sftp') {
      throw new Error(
        `Backups to a "${data.target_type}" target are not supported yet. ` +
          'The target can be saved, but no archive can be uploaded to it. ' +
          'Point this scheme at an SFTP target.',
      );
    }

    // Opened here and never persisted onto the run — the snapshot deliberately holds no secret.
    // key_fingerprint is required: it is how openTargetSecret detects a rotated server key rather
    // than failing with an opaque decrypt error at 02:00.
    const secret = this.secrets.openTargetSecret({
      secret_encrypted: data.secret_encrypted,
      secret_iv: data.secret_iv,
      secret_tag: data.secret_tag,
      key_fingerprint: data.key_fingerprint,
    });

    return {
      targetId: data.id,
      organizationId: run.organization_id,
      config: data.config ?? {},
      secret,
      deadlineAt: new Date(Date.now() + RUN_DEADLINE_MS),
    };
  }

  private async pendingItems(run: ClaimedRun): Promise<RunItem[]> {
    const { data, error } = (await this.db
      .from(ITEMS_TABLE)
      .select('id, component_key, table_name, item_kind, sequence')
      .eq('run_id', run.id)
      .eq('organization_id', run.organization_id)
      .eq('status', 'pending')
      .order('sequence', { ascending: true })) as unknown as {
      data: RunItem[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new Error(`Could not read the run's items: ${error.message}`);
    }

    return data ?? [];
  }

  private async markItemRunning(item: RunItem): Promise<void> {
    const { error } = (await this.db
      .from(ITEMS_TABLE)
      .update({
        status: 'running',
        worker_id: WORKER_ID,
        started_at: new Date().toISOString(),
      })
      .eq('id', item.id)) as unknown as {
      error: { message: string } | null;
    };

    // Logged, not thrown: an item that cannot be marked running is a bookkeeping problem, and
    // abandoning a backup over it would trade a wrong progress bar for a lost archive. But it is
    // not discarded either — a swallowed error on the equivalent run-level write is exactly what
    // once left completed runs looking in-flight until the reaper requeued them.
    if (error) {
      this.logger.warn(
        `Could not mark item ${item.id} running: ${error.message}`,
      );
    }
  }

  private async markItem(
    item: RunItem,
    status: string,
    rows: number,
    sha256?: string,
  ): Promise<void> {
    const { error } = (await this.db
      .from(ITEMS_TABLE)
      .update({
        status,
        row_count: rows,
        sha256: sha256 ?? null,
        finished_at: new Date().toISOString(),
      })
      .eq('id', item.id)) as unknown as {
      error: { message: string } | null;
    };

    // Same reasoning as markItemRunning: reported, never fatal. An item stuck at `running` after a
    // successful export is a report that lies about a good backup, and silence is what made the
    // equivalent bug take a production incident to find.
    if (error) {
      this.logger.warn(
        `Could not mark item ${item.id} ${status}: ${error.message}`,
      );
    }
  }

  private async setRunStatus(
    run: ClaimedRun,
    status: string,
    detail: string,
  ): Promise<void> {
    await this.db
      .from(RUNS_TABLE)
      .update({ status, phase_detail: detail })
      .eq('id', run.id)
      // Scoped to us: a run the reaper handed to someone else must not be written by its old owner.
      .eq('worker_id', WORKER_ID);
  }

  /**
   * When this run's archive becomes eligible for deletion, or null if the scheme keeps forever.
   *
   * Read at upload time rather than at sweep time on purpose: the answer must reflect the policy
   * that was in force when the archive was written. An admin who shortens retention from 90 days to
   * 7 should not retroactively make last quarter's archives instantly deletable — that is a data
   * loss decision disguised as a settings change.
   *
   * A missing or unreadable scheme yields null (keep forever). Failing safe here means "do not
   * schedule a deletion", which is always the recoverable direction.
   */
  private async retentionExpiryFor(run: ClaimedRun): Promise<string | null> {
    const { data, error } = (await this.db
      .from(SCHEMES_TABLE)
      .select('retention_days')
      .eq('id', run.scheme_id)
      .eq('organization_id', run.organization_id)
      .maybeSingle()) as unknown as {
      data: { retention_days: number | null } | null;
      error: { message: string } | null;
    };

    if (error || !data?.retention_days || data.retention_days <= 0) {
      if (error) {
        // Not fatal: the archive is already on the server, and an un-stamped artifact is simply
        // never auto-deleted. Losing the stamp must never fail a successful backup.
        this.logger.warn(
          `Could not read retention for scheme ${run.scheme_id}: ${error.message}`,
        );
      }

      return null;
    }

    return new Date(
      Date.now() + data.retention_days * 24 * 60 * 60 * 1000,
    ).toISOString();
  }

  private async recordArtifact(
    run: ClaimedRun,
    committed: { remotePath: string; byteSize: number },
    archive: { sha256: string; encryptor: ArchiveEncryptor | null },
  ): Promise<void> {
    const { encryptor } = archive;

    // Starts the retention clock at upload time. Until this existed, retention_expires_at was never
    // written by anything, so a scheme could declare `retention_days = 90` and no artifact ever
    // carried an expiry — leaving a future sweep with nothing to select on.
    //
    // Only retention_days is expressible here. `retention_count` ("keep the newest N") cannot be a
    // per-row timestamp: whether the 31st archive evicts the 1st depends on how many exist at the
    // moment of evaluation, so it has to be resolved by the sweep, not stamped here.
    //
    // NOTE: stamping is not deletion. Nothing removes the remote file yet — SftpTargetAdapter.remove()
    // is still a NotImplementedException. See tasks/backup-and-restore/24-adapter-gaps-and-sharepoint-readiness.md (G-4a).
    const retentionExpiresAt = await this.retentionExpiryFor(run);

    // Upsert, not insert. `backup_artifacts_unique_volume` is UNIQUE (run_id, volume_index), and a
    // retried run reaches here a second time with the same pair — so the second attempt died on a
    // 23505 with "The archive uploaded but could not be recorded", having already uploaded a
    // complete archive. A run that failed once could therefore never succeed, and the target filled
    // with good archives whose runs were all marked failed.
    //
    // The superseded row is replaced rather than kept: a run has one current archive. The file the
    // earlier attempt left behind is still on the target and shows up in the archives list as an
    // orphan, which is where an unreferenced file belongs.
    const { error } = await this.db.from(ARTIFACTS_TABLE).upsert(
      {
        organization_id: run.organization_id,
        run_id: run.id,
        // Stated rather than defaulted, because it is half of the conflict target above.
        volume_index: 0,
        target_id: run.target_id,
        remote_path: committed.remotePath,
        byte_size: committed.byteSize,
        sha256: archive.sha256,
        upload_state: 'uploaded',
        retention_expires_at: retentionExpiresAt,
        content_type: encryptor
          ? 'application/octet-stream'
          : 'application/zip',
        is_encrypted: Boolean(encryptor),
        encryption_algo: encryptor ? 'aes-256-gcm' : 'none',
        // The nonce PREFIX, not a nonce: each frame's IV is this prefix plus its counter. Stored
        // because backup_artifacts_encryption_check requires it, and it makes the archive's framing
        // legible from the database without opening the file.
        nonce: encryptor?.noncePrefix ?? null,
        // Deliberately null. There is no single authentication tag — every frame carries its own,
        // inside the archive. A column holding one tag out of thousands would be worse than empty.
        auth_tag: null,
        key_fingerprint: encryptor?.runKey.key_fingerprint ?? null,
      },
      { onConflict: 'run_id,volume_index' },
    );

    if (error) {
      throw new Error(
        `The archive uploaded but could not be recorded: ${error.message}`,
      );
    }
  }

  private async finishRun(
    run: ClaimedRun,
    outcome: {
      rowCount: number;
      tableCount: number;
      archiveBytes: number;
      archiveSha256: string;
      encrypted: boolean;
      missingObjects: string[];
    },
  ): Promise<void> {
    const finishedAt = new Date();

    const { data, error } = (await this.db
      .from(RUNS_TABLE)
      .update({
        status: 'succeeded',
        phase_detail: null,
        row_count: outcome.rowCount,
        table_count: outcome.tableCount,
        archive_bytes: outcome.archiveBytes,
        archive_sha256: outcome.archiveSha256,
        // Dangling file references land on the run rather than only in a log line. The archive is
        // complete for everything that still exists, and this says exactly what did not.
        // `[]`, never null: the column is NOT NULL with default '[]'::jsonb, so writing null made
        // EVERY clean run fail its terminal update — the run stayed in flight, went quiet, and the
        // reaper requeued a backup that had already finished. It was invisible because the update's
        // error was discarded; only a run WITH missing objects could ever be marked succeeded.
        warnings: outcome.missingObjects.length
          ? {
              missing_objects: outcome.missingObjects.slice(0, 100),
              missing_object_count: outcome.missingObjects.length,
            }
          : [],
        finished_at: finishedAt.toISOString(),
        // `started_at` is now selected back by claimRun, so this is finally fillable. It had been
        // null on every run ever taken — the column exists, the list endpoint returns it and the UI
        // already renders it, so "how long do backups take" was unanswerable for want of one field.
        duration_ms: durationMsSince(run.started_at, finishedAt),
        lease_until: null,
      })
      .eq('id', run.id)
      .eq('worker_id', WORKER_ID)
      .select('id')) as unknown as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new Error(
        `The archive completed but the run could not be marked finished: ${error.message}`,
      );
    }

    // Zero rows means the ownership guard above matched nothing — the run was taken away while this
    // worker was finishing it. Reporting success here is what let a COMPLETED backup sit at
    // `verifying` until the reaper requeued it, and then run again, and again. The work really did
    // finish; what failed is recording it, and that has to be loud rather than assumed.
    if (!data?.length) {
      throw new Error(
        `Run ${run.id} finished but no longer belonged to this worker, so the result was not ` +
          'recorded. The archive was uploaded; the run will be retried and will produce a second one.',
      );
    }

    this.logger.log(
      `Run ${run.id} succeeded: ${outcome.tableCount} tables, ${outcome.rowCount} rows, ` +
        `${outcome.archiveBytes} bytes, ${outcome.encrypted ? 'encrypted' : 'unencrypted'}`,
    );
  }

  private async failRun(run: ClaimedRun, err: Error): Promise<void> {
    this.logger.error(`Run ${run.id} failed: ${err.message}`);

    const finishedAt = new Date();

    const { data, error } = (await this.db
      .from(RUNS_TABLE)
      .update({
        status: 'failed',
        error_class: this.classify(err),
        error_message: err.message,
        finished_at: finishedAt.toISOString(),
        // Timed on failure too. How long a run took before it gave up is the difference between a
        // target that refused instantly and one that hung until a deadline.
        duration_ms: durationMsSince(run.started_at, finishedAt),
        lease_until: null,
      })
      .eq('id', run.id)
      .eq('worker_id', WORKER_ID)
      .select('id')) as unknown as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    // The same silent no-op as `finishRun`, and quieter still: a lost failure write leaves the run
    // in flight with its reason discarded, so the reaper eventually reclaims it and the actual
    // error is never seen by anyone. Never thrown from here — this is already the failure path, and
    // replacing the real error with a bookkeeping one loses the thing worth reading.
    if (error || !data?.length) {
      this.logger.error(
        `Run ${run.id} could not be marked failed (${error?.message ?? 'it no longer belongs to this worker'}). ` +
          'The reaper will reclaim it; the error above is the real cause.',
      );
    }
  }

  /**
   * Maps a failure onto backup_runs.error_class.
   *
   * A crypto failure is called out separately because retrying it is pointless — a wrong passphrase
   * or a rotated server key will fail identically every time, and the fix is an admin action.
   */
  private classify(err: Error): string {
    if (
      err instanceof ArchiveCipherError ||
      err.name === 'ArchiveCipherError'
    ) {
      return 'crypto';
    }

    return err.name === 'BackupTruncationError' ? 'permanent' : 'transient';
  }
}
