/**
 * @fileoverview Caches a restore's archive in Supabase Storage so the backup target is read once.
 * @module src/backup/engine/restore-archive-cache
 *
 * An archive lives on a backup target — an SFTP server, usually somewhere else entirely. Reading it
 * back is the slowest part of a restore: for a 113 MB file that is minutes of transfer, and it used
 * to be spent on every run that touched the archive.
 *
 * A restore now reads from here FIRST and only falls back to the target on a miss, at which point it
 * uploads what it downloaded so the next restore does not pay again.
 *
 * ## Keyed by artifact, not by run
 *
 * The first version keyed the object by the PREVIEW RUN that produced it, which meant it could only
 * ever be read by the one apply descending from that preview. The first read of any archive — the
 * preview itself — always went to the target. Keying by the artifact is what lets any restore of that
 * backup file hit.
 *
 * `fetchLegacy` still reads the old run-keyed object, so a preview/apply pair already in flight when
 * this shipped is not forced to re-download.
 *
 * ## This holds decrypted tenant data
 *
 * `BackupArchivesService.openForDownload` verifies the passphrase and decrypts before the reader ever
 * sees the stream, so what is cached is a PLAINTEXT archive. The bucket is private with no RLS policy
 * at all — only the service-role key reaches it — and objects are evicted on a TTL. Anything that
 * lengthens that window is a security change, not a performance one.
 *
 * Two properties follow from that and are load-bearing:
 *
 *   - **The passphrase still has to be proven.** `openForDownload` is the only place it is ever
 *     verified, and a cache hit skips that path. So the archive's own header is stored alongside the
 *     object and `verifyPassphrase` re-derives the key from it. Without that, holding
 *     `can_restore_backups` would be enough to restore an encrypted archive without knowing its
 *     passphrase.
 *   - **A stale hit must not be served.** The recorded checksum and size are compared against
 *     `backup_artifacts` on every read, so a file replaced on the target is detected rather than
 *     silently restored from the previous copy.
 *
 * ## Every failure here is non-fatal
 *
 * A cache that cannot be written, read or deleted must never fail the restore it is accelerating.
 * The upload is best-effort, a miss falls back to downloading from the target exactly as before, and
 * a failed delete is logged and swept later. The restore is correct with this whole file removed.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  RESTORE_ARCHIVE_CACHE_LEASE_MS,
  RESTORE_ARCHIVE_CACHE_TTL_MS,
} from '../backup.constants';
import {
  ArchiveCipherError,
  type ArchiveHeader,
  openArchiveKey,
} from '../crypto/archive-cipher';

/** Created by `20260811150000_restore_archive_cache_bucket.sql`. Private, no RLS policy. */
const BUCKET = 'restore-archive-cache';

/** Created by `20260811160000_restore_archive_cache_index.sql`. Private, no RLS policy. */
const TABLE = 'restore_archive_cache';

/** Organizations examined per orphan pass. Bounded so one sweep cannot walk an entire bucket. */
const ORPHAN_PREFIX_LIMIT = 50;

/** Objects examined per organization per orphan pass. */
const ORPHAN_OBJECT_LIMIT = 100;

/**
 * How often the orphan pass runs.
 *
 * The reaper ticks every minute, and listing a bucket is far more expensive than the indexed delete
 * the expiry pass does. Orphans only appear when a row is removed without its object — an
 * organization deletion cascading the row, or an upload that half-failed — so hourly is ample.
 */
const ORPHAN_SWEEP_INTERVAL_MS = 3_600_000;

/** What the artifact record says the archive should be, checked against what was cached. */
export interface ArchiveIdentity {
  sha256: string | null;
  byteSize: number | null;
}

/** A usable cache entry: fresh, matching the artifact, and ready to be opened. */
export interface CachedArchiveEntry {
  objectPath: string;
  isEncrypted: boolean;
  header: ArchiveHeader | null;
}

export interface StoreArchiveInput {
  organizationId: string;
  artifactId: string;
  /** The spooled file the reader already staged. Streamed, never buffered. */
  localPath: string;
  isEncrypted: boolean;
  /** The archive's own preamble. Null for an unencrypted archive. Carries no secret. */
  header: ArchiveHeader | null;
  identity: ArchiveIdentity;
}

interface CacheRow {
  object_path: string;
  is_encrypted: boolean;
  archive_header: ArchiveHeader | null;
  source_sha256: string | null;
  source_byte_size: number | null;
  expires_at: string;
}

@Injectable()
export class RestoreArchiveCacheService {
  private readonly logger = new Logger(RestoreArchiveCacheService.name);

  /** Wall-clock of the last orphan pass. Process-local; a second replica sweeping too is harmless. */
  private lastOrphanSweepAt = 0;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly config: ConfigService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  private get storage() {
    return this.db.storage.from(BUCKET);
  }

  /**
   * Off means a restore neither reads nor writes the cache, and therefore behaves exactly as it did
   * before this existed. The rollback that does not need a deploy.
   */
  get enabled(): boolean {
    return this.config.get<boolean>('backup.restoreCacheEnabled') !== false;
  }

  /**
   * Keyed by the artifact, under the organization that owns it.
   *
   * The organization is in the path so a stray object is attributable and a sweep can be scoped to
   * one tenant. The artifact id is what makes the object reusable by every restore of that backup
   * file rather than by one apply.
   */
  private keyFor(organizationId: string, artifactId: string): string {
    return `${organizationId}/${artifactId}.zip`;
  }

  // ===========================================================================================
  // Reading
  // ===========================================================================================

  /**
   * Finds a cache entry that may actually be used for this artifact.
   *
   * Returns null — an ordinary outcome, never an error — when there is nothing to reuse, when what
   * is there has expired, or when it no longer matches the artifact. The caller downloads from the
   * target in every one of those cases, which is what always happened.
   *
   * Expiry is enforced HERE as well as in the reaper. The reaper is gated on
   * `backup.schedulerEnabled`, which is off by default, so a replica with scheduling disabled would
   * otherwise never expire a decrypted archive at all.
   */
  async lookup(
    organizationId: string,
    artifactId: string,
    identity: ArchiveIdentity,
  ): Promise<CachedArchiveEntry | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      const { data, error } = (await this.db
        .from(TABLE)
        .select(
          'object_path, is_encrypted, archive_header, source_sha256, source_byte_size, expires_at',
        )
        .eq('organization_id', organizationId)
        .eq('artifact_id', artifactId)
        .maybeSingle()) as unknown as {
        data: CacheRow | null;
        error: { message: string } | null;
      };

      if (error || !data) {
        return null;
      }

      if (new Date(data.expires_at).getTime() <= Date.now()) {
        this.logger.log(
          `The cached archive for artifact ${artifactId} has expired; it will be re-downloaded.`,
        );
        await this.discard(organizationId, artifactId);

        return null;
      }

      if (!this.matchesArtifact(data, identity)) {
        // The file on the target was replaced behind the product's back. Serving the previous bytes
        // would restore something the operator did not choose, which is worse than a slow restore.
        this.logger.warn(
          `The cached archive for artifact ${artifactId} no longer matches the recorded checksum ` +
            'or size, so it was discarded and will be re-downloaded.',
        );
        await this.discard(organizationId, artifactId);

        return null;
      }

      if (data.is_encrypted && !data.archive_header) {
        // Fail closed. Without the header the passphrase cannot be re-checked, and a hit that skips
        // that check is exactly the hole this cache must not open. Re-downloading verifies it
        // through the real path.
        this.logger.warn(
          `The cached archive for artifact ${artifactId} has no stored header, so its passphrase ` +
            'cannot be re-checked. It will be re-downloaded.',
        );
        await this.discard(organizationId, artifactId);

        return null;
      }

      // Held for the duration of the read so the reaper cannot delete the object out from under a
      // restore that is still streaming it.
      await this.lease(organizationId, artifactId);

      return {
        objectPath: data.object_path,
        isEncrypted: data.is_encrypted,
        header: data.archive_header,
      };
    } catch (err) {
      this.logger.warn(
        `Could not look up the cached archive for artifact ${artifactId}: ${(err as Error).message}`,
      );

      return null;
    }
  }

  /**
   * Re-checks the archive passphrase against a cache entry, transferring nothing.
   *
   * `BackupArchivesService.openForDownload` is the only place a passphrase is otherwise verified,
   * and reading from this cache skips it entirely. So the same check is repeated here against the
   * stored header: derive the key-encryption key from the supplied passphrase and try to unwrap the
   * data key. The key itself is discarded — the cached object is already plaintext. The THROW is the
   * point.
   *
   * An unencrypted archive needs no passphrase, matching `openForDownload`.
   *
   * @throws ArchiveCipherError when the passphrase is missing or does not open the archive.
   */
  async verifyPassphrase(
    entry: CachedArchiveEntry,
    passphrase?: string,
  ): Promise<void> {
    if (!entry.isEncrypted) {
      return;
    }

    if (!entry.header) {
      throw new ArchiveCipherError(
        'This archive is encrypted and its stored header is missing, so the passphrase could not ' +
          'be checked.',
      );
    }

    if (!passphrase) {
      throw new ArchiveCipherError(
        'This archive is encrypted. Enter its archive passphrase to restore it.',
      );
    }

    // Throws ArchiveCipherError on a wrong passphrase or an altered header. GCM cannot tell those
    // apart and neither should the message.
    await openArchiveKey(entry.header, passphrase);
  }

  /**
   * Opens a cache entry as a plaintext zip stream, or null when the object has gone.
   *
   * Null is ordinary: the object may have been swept between the row being read and this call.
   */
  async open(entry: CachedArchiveEntry): Promise<Readable | null> {
    try {
      const { data, error } = await this.storage.download(entry.objectPath);

      if (error || !data) {
        return null;
      }

      // The SDK hands back a web Blob. Converted rather than buffered so a large archive is not held
      // in memory twice on its way to the spool.
      return Readable.fromWeb(data.stream() as never);
    } catch {
      return null;
    }
  }

  /**
   * Reads an object cached under the OLD run-keyed scheme.
   *
   * Kept so a preview whose apply had not yet run when this change shipped does not have to
   * re-download the archive it already paid for. There is no index row for these, so nothing is
   * checked beyond the object existing — which matches exactly what the previous code did, and the
   * apply reading it descends from a preview that already verified the passphrase.
   */
  async fetchLegacy(
    organizationId: string,
    previewRunId: string,
  ): Promise<Readable | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      const { data, error } = await this.storage.download(
        this.keyFor(organizationId, previewRunId),
      );

      if (error || !data) {
        return null;
      }

      return Readable.fromWeb(data.stream() as never);
    } catch {
      return null;
    }
  }

  // ===========================================================================================
  // Writing
  // ===========================================================================================

  /**
   * Caches the archive a restore just downloaded from the target.
   *
   * Streamed from the file the reader already staged rather than buffered — a 113 MB archive read
   * into memory would be a 113 MB allocation on a server that is also holding the restore.
   *
   * The object is uploaded before the row is written, and either failing removes both: a row without
   * its object makes every future lookup a wasted round trip, and an object without its row is
   * invisible to the expiry sweep until the far slower orphan pass finds it.
   *
   * @returns true when the entry is there to be read back. False is not an error; it means the next
   *   restore downloads from the target as it always did.
   */
  async store(input: StoreArchiveInput): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    const { organizationId, artifactId } = input;
    const objectPath = this.keyFor(organizationId, artifactId);

    try {
      const info = await stat(input.localPath);
      const { error: uploadError } = await this.storage.upload(
        objectPath,
        Readable.toWeb(createReadStream(input.localPath)) as ReadableStream,
        {
          contentType: 'application/zip',
          duplex: 'half',
          // A retried restore of the same artifact is the same bytes. Overwriting keeps one object
          // per artifact rather than erroring and leaving the first copy to be swept.
          upsert: true,
        } as never,
      );

      if (uploadError) {
        throw new Error(uploadError.message);
      }

      const { error: rowError } = await this.db.from(TABLE).upsert(
        {
          organization_id: organizationId,
          artifact_id: artifactId,
          object_path: objectPath,
          is_encrypted: input.isEncrypted,
          archive_header: input.header,
          source_sha256: input.identity.sha256,
          source_byte_size: input.identity.byteSize,
          cached_at: new Date().toISOString(),
          expires_at: new Date(
            Date.now() + RESTORE_ARCHIVE_CACHE_TTL_MS,
          ).toISOString(),
        },
        { onConflict: 'organization_id,artifact_id' },
      );

      if (rowError) {
        throw new Error(rowError.message);
      }

      this.logger.log(
        `Cached the archive for artifact ${artifactId} (${info.size} bytes), so the next restore ` +
          'will not download it again.',
      );

      return true;
    } catch (err) {
      // Best effort by design. Leave nothing half-written behind.
      await this.removeObject(objectPath);
      await this.removeRow(organizationId, artifactId);

      this.logger.warn(
        `Could not cache the archive for artifact ${artifactId}: ${(err as Error).message}. ` +
          'The next restore will download it from the backup target again.',
      );

      return false;
    }
  }

  /**
   * A time-limited download link for a cached archive, or null when there is nothing cached.
   *
   * Signed rather than public: the bucket has no RLS policy and no public read, so this is the only
   * way the file is reachable, and the link stops working when it expires. It hands over a decrypted
   * archive, so the expiry is deliberately short — long enough to click, not long enough to sit in a
   * chat log or a browser history and still work tomorrow.
   */
  async signedUrl(
    organizationId: string,
    artifactId: string,
    expiresInSeconds = 300,
  ): Promise<string | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      const { data, error } = await this.storage.createSignedUrl(
        this.keyFor(organizationId, artifactId),
        expiresInSeconds,
      );

      if (error || !data?.signedUrl) {
        return null;
      }

      return data.signedUrl;
    } catch {
      return null;
    }
  }

  /**
   * Deletes a cached archive and its row. Safe when there is nothing there.
   *
   * Called on expiry, on a checksum mismatch, and by the sweep. Never called merely because a
   * restore finished: under artifact keying the next restore of the same backup file is exactly who
   * the copy is being kept for.
   */
  async discard(organizationId: string, artifactId: string): Promise<void> {
    await this.removeObject(this.keyFor(organizationId, artifactId));
    await this.removeRow(organizationId, artifactId);
  }

  /**
   * Deletes an object cached under the OLD run-keyed scheme. Safe when there is nothing there.
   *
   * Separate from `discard` because a run-keyed object belongs to exactly one preview and nothing
   * else can ever read it — so discarding that preview really is the moment it stops having a reason
   * to exist. An artifact-keyed object is the opposite: the next restore of that backup file is who
   * it is being kept for.
   */
  async discardLegacy(
    organizationId: string,
    previewRunId: string,
  ): Promise<void> {
    await this.removeObject(this.keyFor(organizationId, previewRunId));
  }

  // ===========================================================================================
  // Sweeping
  // ===========================================================================================

  /**
   * Deletes every entry past its expiry, and occasionally objects whose row has gone.
   *
   * A decrypted archive is a copy of an entire tenant, so this is a security control rather than
   * housekeeping. It is called from the reaper; `lookup` enforces the same expiry on the read path
   * so a replica whose scheduler is disabled still cannot serve one indefinitely.
   *
   * @returns how many entries were removed.
   */
  async evictExpired(limit = 50): Promise<number> {
    if (!this.enabled) {
      return 0;
    }

    let removed = 0;

    try {
      const { data, error } = (await this.db
        .from(TABLE)
        .select('organization_id, artifact_id')
        .lt('expires_at', new Date().toISOString())
        .limit(limit)) as unknown as {
        data: { organization_id: string; artifact_id: string }[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new Error(error.message);
      }

      for (const row of data ?? []) {
        await this.discard(row.organization_id, row.artifact_id);
        removed += 1;
      }
    } catch (err) {
      this.logger.warn(
        `Could not evict expired cached archives: ${(err as Error).message}`,
      );
    }

    return removed + (await this.sweepOrphans());
  }

  /**
   * Removes objects that no longer have a row.
   *
   * These appear when a row is deleted without its object — an organization deletion cascading the
   * row away, or an upload whose row write failed and whose compensating delete did not land. Until
   * now nothing collected them: the engine's comment claimed a sweep existed, but none did, so a
   * preview that was never applied leaked its copy permanently.
   *
   * Listing a bucket is far more expensive than the indexed delete above and the reaper ticks every
   * minute, so this runs on its own much slower clock.
   */
  private async sweepOrphans(): Promise<number> {
    if (Date.now() - this.lastOrphanSweepAt < ORPHAN_SWEEP_INTERVAL_MS) {
      return 0;
    }

    this.lastOrphanSweepAt = Date.now();

    let removed = 0;

    try {
      const { data: prefixes, error } = await this.storage.list('', {
        limit: ORPHAN_PREFIX_LIMIT,
      });

      if (error) {
        throw new Error(error.message);
      }

      for (const prefix of prefixes ?? []) {
        removed += await this.sweepOrphansUnder(prefix.name);
      }
    } catch (err) {
      this.logger.warn(
        `Could not sweep orphaned cached archives: ${(err as Error).message}`,
      );
    }

    return removed;
  }

  /** One organization's prefix. Objects younger than the TTL are left alone — see below. */
  private async sweepOrphansUnder(organizationId: string): Promise<number> {
    const { data: objects, error } = await this.storage.list(organizationId, {
      limit: ORPHAN_OBJECT_LIMIT,
    });

    if (error || !objects?.length) {
      return 0;
    }

    const { data: rows } = (await this.db
      .from(TABLE)
      .select('artifact_id')
      .eq('organization_id', organizationId)) as unknown as {
      data: { artifact_id: string }[] | null;
    };

    const known = new Set((rows ?? []).map((row) => row.artifact_id));
    const cutoff = Date.now() - RESTORE_ARCHIVE_CACHE_TTL_MS;
    let removed = 0;

    for (const object of objects) {
      const artifactId = object.name.replace(/\.zip$/, '');

      if (known.has(artifactId)) {
        continue;
      }

      // An object younger than the TTL with no row is almost certainly an upload in flight right
      // now: `store` writes the object before its row. Deleting it would race a restore that is
      // still caching. Anything older than the whole TTL cannot be mid-upload.
      const createdAt = Date.parse(
        (object.created_at as string | undefined) ?? '',
      );

      if (Number.isFinite(createdAt) && createdAt > cutoff) {
        continue;
      }

      await this.removeObject(`${organizationId}/${object.name}`);
      removed += 1;
    }

    if (removed) {
      this.logger.warn(
        `Removed ${removed} orphaned cached archive object(s) for organization ${organizationId}.`,
      );
    }

    return removed;
  }

  // ===========================================================================================
  // Internals
  // ===========================================================================================

  /** True when the cached copy still describes the artifact as it is recorded now. */
  private matchesArtifact(row: CacheRow, identity: ArchiveIdentity): boolean {
    // Both sides unknown is the pre-checksum case, which is trusted exactly as the download path
    // trusts a null byte_size. One side known and different is a replaced file.
    if (row.source_sha256 && identity.sha256) {
      return row.source_sha256 === identity.sha256;
    }

    if (row.source_byte_size !== null && identity.byteSize !== null) {
      return row.source_byte_size === identity.byteSize;
    }

    return true;
  }

  /** Pushes expiry out while a read is in progress. Best effort: a failure only risks a re-download. */
  private async lease(
    organizationId: string,
    artifactId: string,
  ): Promise<void> {
    const until = new Date(
      Date.now() + RESTORE_ARCHIVE_CACHE_LEASE_MS,
    ).toISOString();

    try {
      await this.db
        .from(TABLE)
        .update({ expires_at: until })
        .eq('organization_id', organizationId)
        .eq('artifact_id', artifactId)
        .lt('expires_at', until);
    } catch {
      // A restore that reads a cached archive must not fail because its lease could not be written.
    }
  }

  private async removeObject(objectPath: string): Promise<void> {
    try {
      const { error } = await this.storage.remove([objectPath]);

      if (error) {
        throw new Error(error.message);
      }
    } catch (err) {
      // Logged, never thrown: failing a completed restore because its cache would not delete would
      // turn a tidy-up problem into a data problem. The orphan pass picks it up.
      this.logger.warn(
        `Could not remove the cached archive object ${objectPath}: ${(err as Error).message}`,
      );
    }
  }

  private async removeRow(
    organizationId: string,
    artifactId: string,
  ): Promise<void> {
    try {
      const { error } = await this.db
        .from(TABLE)
        .delete()
        .eq('organization_id', organizationId)
        .eq('artifact_id', artifactId);

      if (error) {
        throw new Error(error.message);
      }
    } catch (err) {
      this.logger.warn(
        `Could not remove the cached archive row for artifact ${artifactId}: ${(err as Error).message}`,
      );
    }
  }
}
