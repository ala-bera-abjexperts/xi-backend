/**
 * @fileoverview Lists the archives on a target and opens one for download.
 * @module src/backup/services/backup-archives.service
 *
 * Until this existed an archive was write-only: the engine could put one on an SFTP server and
 * nothing could ever get it back. The only reader was a developer CLI that needed a checkout and a
 * terminal, which is not a recovery story an administrator can use.
 *
 * ## The passphrase is checked before anything is streamed
 *
 * The archive header carries the wrapped data key and the KDF salt, so a supplied passphrase can be
 * tested by reading roughly a kilobyte — no download required. That ordering is the whole point: a
 * wrong passphrase discovered mid-stream would already have committed a 200 and part of a file,
 * leaving the caller holding something truncated that looks valid.
 *
 * ## What this deliberately does not need
 *
 * No scheme row, no stored passphrase, no AI_ENCRYPTION_SECRET. The key comes from the archive's own
 * header and the passphrase from the person asking. An archive therefore stays downloadable after
 * its scheme is deleted or the server key is rotated — neither of which it depends on.
 */

import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  ARCHIVE_MISSING_PREFIX,
  SftpTargetAdapter,
  withDeadline,
} from '../adapters/sftp/sftp.adapter';
import type { TargetContext } from '../adapters/backup-target-adapter.interface';
import {
  ArchiveCipherError,
  ArchiveDecryptStream,
  type ArchiveHeader,
  looksEncrypted,
  openArchiveKey,
  readArchiveHeader,
} from '../crypto/archive-cipher';
import { BackupSecretsService } from './backup-secrets.service';

const ARTIFACTS_TABLE = 'backup_artifacts';
const TARGETS_TABLE = 'backup_targets';
const RUNS_TABLE = 'backup_runs';

/** Long enough for any header (MAX_HEADER_BYTES) plus the 11-byte preamble. */
const HEADER_PROBE_BYTES = 64 * 1024 + 11;

/**
 * Budget for reading an archive's header.
 *
 * `readyTimeout` bounds the ssh2 HANDSHAKE only; once the connection is up nothing bounds a read, so
 * a server that accepts the socket and then stops answering leaves this pending forever. The
 * passphrase check is the visible casualty: its request never settles, the wizard's button sits
 * disabled on "Checking passphrase…", and the operator cannot even retry — it reads as though the
 * check started by itself, because the click that started it was minutes earlier.
 *
 * Sixty seconds for sixty kilobytes is not a throughput limit, it is a liveness one. A connection
 * that has not produced a header in a minute is gone, not slow.
 */
const HEADER_READ_TIMEOUT_MS = 60_000;

/** Ceiling on a single download. Deliberate: the browser buffers the whole blob. */
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** How long one download may hold its SFTP connection. */
const DOWNLOAD_DEADLINE_MS = 3_600_000;

export interface ArchiveListItem {
  id: string;
  file_name: string;
  byte_size: number | null;
  sha256: string | null;
  is_encrypted: boolean;
  created_at: string;
  run_id: string;
  run_status: string | null;
  /**
   * Scheme that produced this archive, and therefore whose passphrase opens it.
   *
   * Null once that scheme is deleted. Several schemes routinely write to one target, each sealing
   * with its own passphrase, so without this the operator has only a file name to go on.
   */
  scheme_name: string | null;
  /**
   * The first layer, kept so a client written before multi-layer archives still shows something.
   * Null for runs older than the format setting.
   */
  file_format: string | null;
  /** Every layer this archive holds. Empty for runs older than the format setting. */
  file_formats: string[];
  /** Only set when the caller asked for a live check against the target. */
  present_on_target?: boolean;
}

/**
 * Why a passphrase check answered the way it did, as a value rather than as English prose.
 *
 * The wizard needs to treat these differently — only two of them are about the passphrase at all —
 * and matching on `detail` would mean pattern-matching sentences that exist to be read by a human
 * and translated. `detail` stays the message; this is the decision.
 */
export type ArchiveVerifyReason =
  | 'ok'
  | 'not_encrypted'
  | 'archive_missing'
  | 'state_mismatch'
  | 'missing_passphrase'
  | 'unreadable_header'
  | 'wrong_passphrase';

export interface ArchiveVerifyResult {
  encrypted: boolean;
  valid: boolean;
  detail: string;
  reason: ArchiveVerifyReason;
}

export interface ArchiveListResult {
  archives: ArchiveListItem[];
  /** Files on the target that this database has no record of. Never downloadable. */
  orphans: string[];
  /** False when no live check was performed, so the UI does not imply one. */
  verified: boolean;
}

interface ArtifactRow {
  id: string;
  remote_path: string;
  byte_size: number | null;
  sha256: string | null;
  is_encrypted: boolean;
  created_at: string;
  run_id: string;
  target_id: string;
}

interface TargetRow {
  id: string;
  target_type: string;
  config: Record<string, unknown> | null;
  secret_encrypted: string | null;
  secret_iv: string | null;
  secret_tag: string | null;
  key_fingerprint: string | null;
}

/**
 * Whether a read failed because the file is not on the server, rather than because the transfer did.
 *
 * Matched on the adapter's own sentinel: `get` checks existence before opening a stream and throws
 * this one message past `classifySftpError`, which would otherwise rewrite it into a claim about
 * the remote directory.
 */
function isMissingArchive(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith(ARCHIVE_MISSING_PREFIX)
  );
}

@Injectable()
export class BackupArchivesService {
  private readonly logger = new Logger(BackupArchivesService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly secrets: BackupSecretsService,
    private readonly sftp: SftpTargetAdapter,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Archives recorded against one target.
   *
   * The database is the source of truth for what to OFFER, because only it knows which run produced
   * a file and whether that run succeeded. `verify` additionally asks the target what is really
   * there, which is the only way to notice a file deleted behind the product's back.
   */
  async list(
    organizationId: string,
    targetId: string,
    verify = false,
  ): Promise<ArchiveListResult> {
    const { data, error } = (await this.db
      .from(ARTIFACTS_TABLE)
      .select(
        'id, remote_path, byte_size, sha256, is_encrypted, created_at, run_id, target_id',
      )
      .eq('organization_id', organizationId)
      .eq('target_id', targetId)
      .is('deleted_at', null)
      .in('upload_state', ['uploaded', 'verified'])
      .order('created_at', { ascending: false })) as unknown as {
      data: ArtifactRow[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Failed to list archives: ${error.message}`,
      );
    }

    const rows = data ?? [];
    const runs = await this.runInfo(
      organizationId,
      rows.map((row) => row.run_id),
    );

    const archives: ArchiveListItem[] = rows.map((row) => ({
      id: row.id,
      file_name: basename(row.remote_path),
      byte_size: row.byte_size,
      sha256: row.sha256,
      is_encrypted: row.is_encrypted,
      created_at: row.created_at,
      run_id: row.run_id,
      run_status: runs.get(row.run_id)?.status ?? null,
      scheme_name: runs.get(row.run_id)?.schemeName ?? null,
      file_format: runs.get(row.run_id)?.formats[0] ?? null,
      file_formats: runs.get(row.run_id)?.formats ?? [],
    }));

    if (!verify) {
      return { archives, orphans: [], verified: false };
    }

    return this.withTargetPresence(organizationId, targetId, archives);
  }

  /**
   * Opens one archive, decrypted, ready to pipe at a response.
   *
   * `header` is the archive's own plaintext preamble, returned so a caller that caches these bytes
   * can also keep the means to re-check a passphrase later. It carries no secret — the data key
   * inside it is wrapped, and the salt and nonce prefix are public inputs (see `ArchiveHeader`).
   * Null for an unencrypted archive, which has no header and needs no passphrase.
   *
   * @throws BadRequestException when the passphrase is wrong — raised BEFORE any byte of the
   *   archive is read, so the caller can still send a normal error response.
   */
  async openForDownload(
    organizationId: string,
    targetId: string,
    artifactId: string,
    passphrase?: string,
  ): Promise<{
    stream: Readable;
    fileName: string;
    decrypted: boolean;
    header: ArchiveHeader | null;
  }> {
    const artifact = await this.getArtifact(
      organizationId,
      targetId,
      artifactId,
    );

    if (
      artifact.byte_size !== null &&
      artifact.byte_size > MAX_DOWNLOAD_BYTES
    ) {
      throw new BadRequestException(
        `This archive is ${artifact.byte_size} bytes, above the ${MAX_DOWNLOAD_BYTES}-byte download limit.`,
      );
    }

    const { ctx, logicalPath } = await this.resolve(
      organizationId,
      targetId,
      artifact,
    );

    // A kilobyte, not the file. Enough to tell an encrypted archive from a plain zip and to test
    // the passphrase, without committing to a transfer that might be refused a moment later.
    const head = await this.readHead(ctx, logicalPath);
    const encrypted = looksEncrypted(head);

    if (encrypted !== artifact.is_encrypted) {
      // The record and the file disagree. Serving it anyway would hand back either an unopenable
      // "zip" or an archive the caller was told needed no passphrase.
      throw new BadRequestException(
        'This archive does not match its recorded encryption state, so it was not served. ' +
          'The file on the target may have been replaced.',
      );
    }

    if (!encrypted) {
      return {
        stream: await this.sftp.get(ctx, logicalPath),
        fileName: artifact.file_name,
        decrypted: false,
        header: null,
      };
    }

    if (!passphrase) {
      throw new BadRequestException(
        'This archive is encrypted. Enter its archive passphrase to download it.',
      );
    }

    const parsed = readArchiveHeader(head);

    if (!parsed) {
      throw new BadRequestException(
        'The archive header could not be read, so this file cannot be opened.',
      );
    }

    // Only the passphrase the caller supplied opens this. An earlier version fell back to the
    // scheme's stored passphrase when the typed one failed, which made an empty or wrong entry
    // succeed — the operator was never actually asked to know the secret. Whether the server COULD
    // open it is beside the point: this endpoint exists to check that the person can.
    //
    // Throws ArchiveCipherError on a wrong passphrase — the check that keeps a failure on this side
    // of the response. The key is kept so the stream does not repeat the ~100 ms derivation.
    const dek = await openArchiveKey(parsed.header, passphrase);
    const body = await this.sftp.get(ctx, logicalPath);
    const plain = new ArchiveDecryptStream(() => Promise.resolve(dek));

    // Errors on either half must reach the caller's handler, which owns the socket. `pipe` alone
    // drops them, and a silent drop here is a truncated archive that looks complete.
    body.on('error', (err) => plain.destroy(err));
    body.pipe(plain);

    return {
      stream: plain,
      fileName: artifact.file_name,
      decrypted: true,
      header: parsed.header,
    };
  }

  /**
   * Answers whether a passphrase actually opens this archive, transferring nothing.
   *
   * The restore wizard asks for the passphrase three steps before it is used, so without this a
   * typo is discovered only when the preview fails — after an archive, a table selection and, for a
   * cross-organization restore, somebody else's approval. The same kilobyte-sized header read that
   * guards `openForDownload` answers it here for the same ~100 ms key derivation.
   *
   * A wrong passphrase is a NORMAL result, not an exception: it is reported as `valid: false` so the
   * wizard can render it against the field instead of as a failed request.
   *
   * This is a passphrase oracle by construction, so the route in front of it is throttled and the
   * scrypt derivation is itself the cost that makes guessing expensive.
   */

  async verifyPassphrase(
    organizationId: string,
    targetId: string,
    artifactId: string,
    passphrase?: string,
  ): Promise<ArchiveVerifyResult> {
    const artifact = await this.getArtifact(
      organizationId,
      targetId,
      artifactId,
    );

    const { ctx, logicalPath } = await this.resolve(
      organizationId,
      targetId,
      artifact,
    );

    let head: Buffer;

    try {
      head = await this.readHead(ctx, logicalPath);
    } catch (err) {
      // An archive deleted from the server behind the product's back is a NORMAL answer to "can
      // this be restored?", not a server fault — so it is reported like a failed check rather than
      // thrown, which would surface as a 500 and render as a broken request instead of against the
      // archive it is about. Age is never why this happens: nothing in this product deletes an
      // archive, so a file that has gone was removed on the target itself.
      if (isMissingArchive(err)) {
        return {
          encrypted: artifact.is_encrypted,
          valid: false,
          reason: 'archive_missing',
          detail:
            `This archive is no longer on the target. ${artifact.file_name} is still recorded ` +
            'here, but the server no longer holds the file.',
        };
      }

      throw err;
    }

    const encrypted = looksEncrypted(head);

    if (encrypted !== artifact.is_encrypted) {
      return {
        encrypted,
        valid: false,
        reason: 'state_mismatch',
        detail:
          'This archive does not match its recorded encryption state. The file on the target may ' +
          'have been replaced.',
      };
    }

    if (!encrypted) {
      return {
        encrypted: false,
        valid: true,
        reason: 'not_encrypted',
        detail: 'This archive is not encrypted, so no passphrase is needed.',
      };
    }

    // An empty box is refused before the archive is even parsed. It is not a wrong answer, it is no
    // answer, and saying so is what tells the operator the field is required rather than broken.
    if (!passphrase) {
      return {
        encrypted: true,
        valid: false,
        reason: 'missing_passphrase',
        detail: 'This archive is encrypted. Enter its archive passphrase.',
      };
    }

    // `readArchiveHeader` answers a TRUNCATED header with null and a MALFORMED one — wrong magic,
    // an unreadable version, an implausible length, unparseable JSON — by throwing. Both mean the
    // same thing to the person asking, and only the first was handled: a corrupted archive left
    // this method as an unhandled cipher error, so the wizard reported a server fault for a file
    // problem it could describe perfectly well.
    let parsed: ReturnType<typeof readArchiveHeader>;

    try {
      parsed = readArchiveHeader(head);
    } catch (err) {
      return {
        encrypted: true,
        valid: false,
        reason: 'unreadable_header',
        // The cipher's own wording is more specific than anything repeated here, and it describes
        // the FILE — it says nothing about the passphrase, so it gives a guesser nothing.
        detail:
          err instanceof ArchiveCipherError
            ? err.message
            : 'The archive header could not be read, so this file cannot be opened.',
      };
    }

    if (!parsed) {
      return {
        encrypted: true,
        valid: false,
        reason: 'unreadable_header',
        detail:
          'The archive header could not be read, so this file cannot be opened.',
      };
    }

    // ONLY the supplied passphrase. This briefly fell back to the scheme's stored passphrase when
    // the typed one failed, which meant an empty or wrong entry still answered `valid: true` and the
    // wizard walked on to the next step — the exact opposite of what this endpoint is for. That the
    // server holds a passphrase capable of opening the archive does not make the person typing one
    // correct, and `openForDownload` enforces the same single rule so the two cannot disagree.
    try {
      await openArchiveKey(parsed.header, passphrase);

      return {
        encrypted: true,
        valid: true,
        reason: 'ok',
        detail: 'That passphrase opens this archive.',
      };
    } catch (err) {
      // Deliberately no detail from the cipher error: "wrong passphrase" and "corrupt key material"
      // are the same answer to the person typing, and distinguishing them helps only a guesser.
      // The resolver's own message already says which of the two routes were tried.
      return {
        encrypted: true,
        valid: false,
        reason: 'wrong_passphrase',
        detail:
          err instanceof BadRequestException
            ? err.message
            : 'That passphrase does not open this archive.',
      };
    }
  }

  /** Reads the first bytes of an archive, for the magic and the header. */
  private async readHead(
    ctx: TargetContext,
    logicalPath: string,
  ): Promise<Buffer> {
    // Bounded separately from the read below: opening the stream connects and authenticates, and a
    // target that never completes that would otherwise hang here before a byte is asked for.
    const stream = await withDeadline(
      this.sftp.get(ctx, logicalPath, {
        start: 0,
        end: HEADER_PROBE_BYTES - 1,
      }),
      HEADER_READ_TIMEOUT_MS,
      'opening the archive',
    );

    const chunks: Buffer[] = [];

    const read = (async () => {
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }

      return Buffer.concat(chunks);
    })();

    try {
      return await withDeadline(
        read,
        HEADER_READ_TIMEOUT_MS,
        'reading the archive header',
      );
    } catch (err) {
      // `withDeadline` only rejects the promise — it cannot close a stream it does not own, and the
      // adapter ends the SSH connection on this stream's `close`. Without this the request fails
      // while the session stays open, so a handful of timed-out checks exhaust the target's
      // connection limit and every later operation fails for an unrelated-looking reason.
      stream.destroy();

      throw err;
    }
  }

  /**
   * Turns a stored path back into a logical name.
   *
   * `backup_artifacts.remote_path` holds the JOINED path, while the adapter joins internally — so
   * passing the stored value straight through would produce `/backups//backups/x.zip`. The stored
   * path is also checked against the target's CURRENT directory: if someone edited `remote_dir`
   * after this archive was written, the file the adapter would fetch is not this record's file, and
   * quietly serving a different archive is worse than refusing.
   */
  private async resolve(
    organizationId: string,
    targetId: string,
    artifact: ArchiveListItem & { remote_path: string },
  ): Promise<{ ctx: TargetContext; logicalPath: string }> {
    const target = await this.getTarget(organizationId, targetId);

    if (target.target_type !== 'sftp') {
      throw new BadRequestException(
        `Downloading from a "${target.target_type}" target is not supported yet.`,
      );
    }

    const config = (target.config ?? {}) as { remote_dir?: string };
    const dir = (config.remote_dir ?? '').replace(/\/+$/, '');
    const logicalPath = basename(artifact.remote_path);
    const expected = `${dir}/${logicalPath}`;

    if (artifact.remote_path !== expected) {
      throw new BadRequestException(
        `This archive was written to ${artifact.remote_path}, which is no longer inside the ` +
          "target's directory. Point the target back at that directory to download it.",
      );
    }

    return {
      ctx: {
        targetId: target.id,
        organizationId,
        config: target.config ?? {},
        secret: this.secrets.openTargetSecret(target),
        deadlineAt: new Date(Date.now() + DOWNLOAD_DEADLINE_MS),
      },
      logicalPath,
    };
  }

  /** Marks each row present or missing, and reports files the database does not know about. */
  /**
   * Writes down what the live check found.
   *
   * Until this existed `verified_at` had no writer anywhere in the module, so every archive read as
   * "never confirmed" forever and a file that had vanished from the target was indistinguishable
   * from one that was fine — right up to the moment a restore tried to open it.
   *
   * Only presence is recorded, never absence. Marking a missing archive `deleted_at` would be a
   * destructive write driven by a name comparison — and if the two sides of that comparison ever
   * disagree on shape, a single listing would soft-delete every archive at once. Absence is already
   * carried to the caller as `present_on_target: false`, which the picker refuses on and which
   * re-evaluates on the next listing instead of being burned into a row.
   */
  private async recordPresence(archives: ArchiveListItem[]): Promise<void> {
    const present = archives
      .filter((a) => a.present_on_target)
      .map((a) => a.id);

    if (!present.length) {
      return;
    }

    try {
      await this.db
        .from(ARTIFACTS_TABLE)
        .update({ verified_at: new Date().toISOString() })
        .in('id', present);
    } catch (err) {
      this.logger.warn(
        `Could not record archive presence: ${(err as Error).message}`,
      );
    }
  }

  private async withTargetPresence(
    organizationId: string,
    targetId: string,
    archives: ArchiveListItem[],
  ): Promise<ArchiveListResult> {
    const target = await this.getTarget(organizationId, targetId);

    if (target.target_type !== 'sftp') {
      return { archives, orphans: [], verified: false };
    }

    try {
      const objects = await this.sftp.list({
        targetId: target.id,
        organizationId,
        config: target.config ?? {},
        secret: this.secrets.openTargetSecret(target),
        deadlineAt: new Date(Date.now() + DOWNLOAD_DEADLINE_MS),
      });

      const onTarget = new Set(objects.map((object) => object.logicalPath));
      const known = new Set(archives.map((archive) => archive.file_name));

      const checked = archives.map((archive) => ({
        ...archive,
        present_on_target: onTarget.has(archive.file_name),
      }));

      await this.recordPresence(checked);

      return {
        archives: checked,
        orphans: [...onTarget].filter((name) => !known.has(name)),
        verified: true,
      };
    } catch (err) {
      // A target that cannot be reached must not blank the list — the records are still true, and
      // the caller is told the live check did not happen rather than being shown a false "missing".
      this.logger.warn(
        `Could not verify archives against target ${targetId}: ${(err as Error).message}`,
      );

      return { archives, orphans: [], verified: false };
    }
  }

  private async getArtifact(
    organizationId: string,
    targetId: string,
    artifactId: string,
  ): Promise<ArchiveListItem & { remote_path: string }> {
    const { data, error } = (await this.db
      .from(ARTIFACTS_TABLE)
      .select(
        'id, remote_path, byte_size, sha256, is_encrypted, created_at, run_id, target_id',
      )
      .eq('id', artifactId)
      .eq('organization_id', organizationId)
      // Scoped by target as well as organization: an artifact id from another target of the same
      // tenant must not resolve here, or the path check below would run against the wrong config.
      .eq('target_id', targetId)
      .is('deleted_at', null)
      .maybeSingle()) as unknown as {
      data: ArtifactRow | null;
      error: { message: string } | null;
    };

    if (error || !data) {
      throw new NotFoundException('Archive not found');
    }

    return {
      id: data.id,
      remote_path: data.remote_path,
      file_name: basename(data.remote_path),
      byte_size: data.byte_size,
      sha256: data.sha256,
      is_encrypted: data.is_encrypted,
      created_at: data.created_at,
      run_id: data.run_id,
      // This lookup fetches ONE artifact by id for an operation that already knows which archive it
      // means (verify, download, delete). The run-derived fields exist only to satisfy the shared
      // shape and are deliberately not queried — nothing downstream of here reads them.
      run_status: null,
      scheme_name: null,
      file_format: null,
      file_formats: [],
    };
  }

  private async getTarget(
    organizationId: string,
    targetId: string,
  ): Promise<TargetRow> {
    const { data, error } = (await this.db
      .from(TARGETS_TABLE)
      .select(
        'id, target_type, config, secret_encrypted, secret_iv, secret_tag, key_fingerprint',
      )
      .eq('id', targetId)
      .eq('organization_id', organizationId)
      .maybeSingle()) as unknown as {
      data: TargetRow | null;
      error: { message: string } | null;
    };

    if (error || !data) {
      throw new NotFoundException('Backup target not found');
    }

    return data;
  }

  /** Run status, format and scheme per archive, so the list can say what produced each file. */
  private async runInfo(
    organizationId: string,
    runIds: string[],
  ): Promise<
    Map<
      string,
      { status: string; formats: string[]; schemeName: string | null }
    >
  > {
    const byRun = new Map<
      string,
      { status: string; formats: string[]; schemeName: string | null }
    >();

    if (!runIds.length) {
      return byRun;
    }

    const { data } = (await this.db
      .from(RUNS_TABLE)
      // The scheme's NAME, because it decides which PASSPHRASE opens the archive. Several schemes
      // commonly write to one target — this organization has eight doing so — and each seals with
      // its own passphrase. A list showing only file names asks the operator to remember which
      // backup produced which file, and getting it wrong reads as "that passphrase does not open
      // this archive", which sounds like a broken archive rather than the wrong scheme.
      .select(
        'id, status, options_snapshot, scheme:backup_schemes!scheme_id(name)',
      )
      .eq('organization_id', organizationId)
      .in('id', [...new Set(runIds)])) as unknown as {
      data:
        | {
            id: string;
            status: string;
            options_snapshot: Record<string, unknown> | null;
            scheme: { name: string } | null;
          }[]
        | null;
    };

    for (const run of data ?? []) {
      const snapshot = run.options_snapshot;
      const scalar = snapshot?.file_format;

      // `file_formats` for anything written since an archive could hold several layers, the scalar
      // for everything before it. Runs older than the format setting have neither, and stay null —
      // the client offers those anyway, because the server derives the real format on open.
      const formats = Array.isArray(snapshot?.file_formats)
        ? (snapshot.file_formats as unknown[]).filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : typeof scalar === 'string'
          ? [scalar]
          : [];

      byRun.set(run.id, {
        status: run.status,
        formats,
        // Null once the scheme has been deleted. The archive still exists on the target, so the
        // list has to keep offering it — it just cannot say which passphrase it wants.
        schemeName: run.scheme?.name ?? null,
      });
    }

    return byRun;
  }
}

export { ArchiveCipherError };
