/**
 * @fileoverview The SFTP backup destination.
 * @module src/backup/adapters/sftp/sftp.adapter
 *
 * Every method is implemented: verify, openWrite, list, get and remove. All five share one
 * `connect()` so the SSRF resolution and host-key pinning below cannot be applied to some paths
 * and forgotten on others.
 *
 * Two controls decide whether a connection is allowed, and both must hold:
 *
 *  - the resolved address is not internal (`resolveSftpHost`), and we connect to the IP literal;
 *  - the presented host key matches the pinned fingerprint (`hostVerifier`).
 *
 * `hostVerifier` is the single most dangerous line here. `ssh2` accepts ANY host key when it is not
 * supplied — no warning, no log line — so it must never be absent. On `ssh2` 1.x it receives the raw
 * public-key blob as a Buffer, not the hex digest 0.8.x passed; a snippet written against 0.8 that
 * compares it to a string is always false (fails safe), but the same line written defensively with a
 * `|| !expected` fallback is always true (fails open). The synchronous arity is used deliberately:
 * verification is a hash and a comparison, it needs no I/O, and the callback form adds a way to hang
 * forever by never invoking the callback.
 *
 * It runs during key exchange, BEFORE authentication — so a mismatched host never receives the
 * password or a signature over the session id. That is why it cannot be deferred to after connect.
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PassThrough, type Readable } from 'node:stream';
import SftpClient from 'ssh2-sftp-client';
import type {
  BackupTargetAdapter,
  BackupTargetKind,
  RangeSession,
  TargetContext,
  TargetObject,
  TargetVerifyResult,
  UploadHandle,
} from '../backup-target-adapter.interface';
import { joinRemotePath } from '../remote-path.util';
import {
  DOWNLOAD_CHUNK_BYTES,
  DOWNLOAD_CONCURRENCY,
  ParallelSftpReadStream,
  type SftpReadSource,
} from './parallel-read-stream';
import { classifySftpError, type ClassifiedError } from './sftp-error-taxonomy';
import { checkHostKey, type HostKeyCheck } from './sftp-host-key.util';
import {
  resolveSftpHost,
  SftpHostError,
  type ResolvedSftpHost,
} from './sftp-host-resolver';

/**
 * Handshake budget. Never leave this unset — `ssh2` treats `readyTimeout: 0` as "no timeout", which
 * is the slow-loris case: a server that accepts the socket and never completes key exchange would
 * pin the request open indefinitely.
 */
const READY_TIMEOUT_MS = 15_000;

/**
 * Budget for a metadata call — `stat`, `rename`.
 *
 * These move no bytes, so a server that has not answered in half a minute is not busy, it is gone.
 */
const METADATA_TIMEOUT_MS = 30_000;

/**
 * Budget for abandoning a transfer that is already being torn down.
 *
 * Deliberately short. `abort()` runs on a path that has ALREADY failed, so nothing is gained by
 * waiting on a server that has stopped answering — the reason the run failed is known, and the only
 * thing still outstanding is cleanup. Before this existed the abort awaited `put` with no deadline
 * at all, which meant a dead socket held the worker for as long as the OS took to give up on the
 * TCP connection: measured at 15-17 minutes, during which the cron's in-flight guard blocked every
 * other backup in the process and each new run sat at "Waiting to start".
 */
const ABORT_TIMEOUT_MS = 10_000;

/**
 * Keepalive on the long-lived upload connection.
 *
 * `openWrite` connects BEFORE the export loop and holds that one connection for the whole run, so
 * it can sit near-idle for minutes while small tables are read. `readyTimeout` bounds the handshake
 * only, and ssh2 imposes no deadline afterwards — so a firewall or server idle-timeout that drops
 * the connection produces a socket that is gone but never errors. These make the library notice.
 */
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 4;

/**
 * Floor for a transfer, before size is taken into account.
 *
 * Generous on purpose: the failure being guarded against is a connection that stalls FOREVER, and
 * a budget tight enough to kill a slow-but-working upload trades a hang for lost backups.
 */
const TRANSFER_TIMEOUT_FLOOR_MS = 60_000;

/** Additional budget per megabyte, so a large archive on a slow link is not cut off. */
const TRANSFER_TIMEOUT_PER_MB_MS = 10_000;

/**
 * How many bytes may sit in the SFTP write stream at once — i.e. how many WRITE requests ssh2 puts
 * on the wire before it has to wait for a reply.
 *
 * ssh2's `WriteStream._write` sends ONE request and waits for the server's STATUS before the next.
 * `_writev` sends every buffered chunk in parallel, but Node only calls it when more than one chunk
 * is buffered — and Node's default 16 KB highWaterMark never allows that. So an upload ran at
 * exactly one request per round trip: a 113 MB archive took 13 minutes at ~148 KB/s, no matter how
 * much bandwidth was available.
 *
 * 2 MB is not a round number. It is what ssh2's own `fastXfer` pipelines (64 x 32 KB) and what an
 * SSH channel's window holds (`MAX_WINDOW`), so past this point the extra bytes queue in ssh2's
 * internal buffer waiting for a WINDOW_ADJUST — more memory, no more speed.
 *
 * Paired with `UPLOAD_CHUNK_BYTES` in upload-chunker.ts: that keeps every chunk small enough to be
 * one request, this decides how many of them are outstanding. Neither is any use without the other.
 */
const UPLOAD_HIGH_WATER_MARK_BYTES = 2 * 1024 * 1024;

/**
 * Read buffer for the `createReadStream` paths that remain — `openRead()`'s small ranged reads, and
 * the fallback in `openParallelRead` when the raw SFTP session is not reachable.
 *
 * ⚠ This does NOT pipeline, and it never did. It was originally set to 2 MiB to mirror
 * `UPLOAD_HIGH_WATER_MARK_BYTES`, on the assumption that the read side behaves like the write side.
 * It does not:
 *
 *   * uploads pipeline because a large watermark lets Node buffer several chunks and call ssh2's
 *     `_writev`, which fires all of them at once;
 *   * downloads have no `_readv`. ssh2's `ReadStream._read` (SFTP.js:3724) issues ONE `sftp.read()`
 *     and waits for the reply, and `read_` (SFTP.js:2101) clamps it to `_maxReadLen` and continues
 *     the remainder from inside the reply callback (SFTP.js:2153) — serial either way.
 *
 * So raising this changes the buffer, not the number of requests on the wire, and the transfer stays
 * pinned at `_maxReadLen / RTT`. Concurrency is the only lever that works on the read side, which is
 * what `parallel-read-stream.ts` provides. Left at 2 MiB because it is harmless and the small ranged
 * reads it now serves fit inside it whole.
 */
const DOWNLOAD_HIGH_WATER_MARK_BYTES = 2 * 1024 * 1024;

/**
 * How many SFTP READ requests a full-file download keeps in flight.
 *
 * Read from the environment on every call rather than cached, so a target whose server limits
 * outstanding requests can be turned down without a rebuild — the same shape as
 * `BACKUP_SFTP_ALLOW_PRIVATE_NETWORKS` in `sftp-host-resolver.ts`. Anything unparseable or
 * non-positive falls back to ssh2's own `fastXfer` default.
 */
function readConcurrency(): number {
  const raw = Number(process.env.BACKUP_SFTP_READ_CONCURRENCY);

  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DOWNLOAD_CONCURRENCY;
}

/**
 * Opening line of the error `get` raises when the file simply is not there.
 *
 * Exported because callers need to tell "this archive has been deleted from the server" apart from
 * "the transfer failed", and the two are otherwise indistinguishable strings. `get` deliberately
 * lets this one past `classifySftpError`, which would rewrite it into a message about the remote
 * DIRECTORY not existing — true for an upload, badly wrong for a single missing archive.
 */
export const ARCHIVE_MISSING_PREFIX = 'No such archive on the target';

/**
 * Fails a promise that never settles.
 *
 * `readyTimeout` bounds the HANDSHAKE only. Once the connection is up, ssh2 imposes no deadline on
 * anything — so a server that accepts the socket and then stops responding leaves `put`, `stat` and
 * `rename` pending for ever. A backup run then sits in `verifying` with no error, holding its lease,
 * until a human notices.
 *
 * The message carries ETIMEDOUT because `classifySftpError` already recognises it as a transient
 * network fault: a timed-out run is retried rather than declared permanently broken, and the
 * taxonomy needs no change to know that.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `ETIMEDOUT: the server stopped responding while ${what} (waited ${Math.round(timeoutMs / 1000)}s).`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    // Always cleared, including on success — a pending timer keeps the event loop alive and would
    // hold the process open for the length of the longest budget after the work is done.
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** How long a transfer of this size may take before the connection is called dead. */
export function transferBudgetMs(byteLength?: number): number {
  if (!byteLength || byteLength <= 0) {
    return TRANSFER_TIMEOUT_FLOOR_MS;
  }

  const megabytes = byteLength / (1024 * 1024);

  return (
    TRANSFER_TIMEOUT_FLOOR_MS +
    Math.ceil(megabytes) * TRANSFER_TIMEOUT_PER_MB_MS
  );
}

interface SftpTargetConfig {
  host: string;
  port: number;
  username: string;
  remote_dir: string;
  host_key_sha256?: string | null;
}

/** The value `ssh-keygen -lf - -E sha256` prints, computed from the wire-format key blob. */
function fingerprintHostKey(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

@Injectable()
export class SftpTargetAdapter implements BackupTargetAdapter {
  readonly kind: BackupTargetKind = 'sftp';

  private readonly logger = new Logger(SftpTargetAdapter.name);

  /**
   * Classifies a transport failure AND records it, which nothing used to do.
   *
   * Every call site here previously read `classifySftpError(error).message` and threw the rest
   * away — so for any failure the taxonomy did not recognise, the server's actual objection existed
   * for exactly as long as that expression took to evaluate. It reached no log, no database column
   * and no screen. The run said "the transfer failed, see the run details", and the run details
   * said "the transfer failed, see the run details".
   *
   * The log line carries the stable code and the operation, so the same failure can be grepped
   * across runs, and the stack, which never reaches the admin.
   */
  private classifyAndLog(
    operation: string,
    host: string,
    error: unknown,
  ): ClassifiedError {
    const classified = classifySftpError(error);
    const raw = (error ?? {}) as { code?: string | number };
    const code = raw.code === undefined ? '' : ` errno=${String(raw.code)}`;

    this.logger.error(
      `SFTP ${operation} failed on ${host} [${classified.code}]${code}: ` +
        `${classified.detail ?? 'the server gave no message'}`,
      (error as Error)?.stack,
    );

    return classified;
  }

  /**
   * Connect, authenticate, and prove the configured directory is writable.
   *
   * Never throws for an operational failure — a bad host or a wrong password is a result, not an
   * exception. Only a programming error escapes.
   */
  async verify(ctx: TargetContext): Promise<TargetVerifyResult> {
    const config = ctx.config as unknown as SftpTargetConfig;
    const startedAt = Date.now();

    if (
      ctx.secret.auth_method !== 'sftp_password' &&
      ctx.secret.auth_method !== 'sftp_private_key'
    ) {
      return {
        ok: false,
        error: 'This target is not an SFTP target.',
      };
    }

    let resolved: ResolvedSftpHost;

    try {
      resolved = await resolveSftpHost(config.host, Number(config.port));
    } catch (error) {
      if (error instanceof SftpHostError) {
        return { ok: false, error: error.message };
      }

      throw error;
    }

    // Captured by the verifier and read after connect() rejects: ssh2 surfaces a host-key refusal as
    // a generic handshake failure, so without this the admin gets "connection lost" for a mismatch.
    let hostKeyCheck: HostKeyCheck | null = null;

    const client = new SftpClient();
    const probeName = `xisuite-write-test-${randomUUID()}.tmp`;
    const probePath = joinRemotePath(config.remote_dir, probeName);
    let probeWritten = false;

    try {
      await client.connect({
        // The verified literal, never the name — the library must not resolve a second time.
        host: resolved.address,
        port: Number(config.port),
        username: config.username,
        readyTimeout: READY_TIMEOUT_MS,
        ...(ctx.secret.auth_method === 'sftp_password'
          ? { password: ctx.secret.password }
          : {
              privateKey: ctx.secret.private_key,
              ...(ctx.secret.passphrase
                ? { passphrase: ctx.secret.passphrase }
                : {}),
            }),
        // Synchronous arity. `key` is a Buffer on ssh2 1.x — never compare it to a string.
        hostVerifier: (key: Buffer): boolean => {
          hostKeyCheck = checkHostKey(fingerprintHostKey(key), [
            config.host_key_sha256,
          ]);

          return hostKeyCheck.verdict === 'match';
        },
      });

      const stat = await client.exists(config.remote_dir);

      if (stat !== 'd') {
        return {
          ok: false,
          error: `The directory ${config.remote_dir} does not exist on ${config.host}. Create it, or correct the remote directory.`,
          latencyMs: Date.now() - startedAt,
        };
      }

      // A readable directory is not a writable one, and a backup that discovers this at 02:00 is the
      // failure this whole endpoint exists to prevent.
      await client.put(Buffer.from('xisuite backup write test\n'), probePath);
      probeWritten = true;

      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      // A refused host key aborts the handshake, so it arrives here as a transport error.
      const check = hostKeyCheck as HostKeyCheck | null;

      if (check && check.verdict !== 'match') {
        return {
          ok: false,
          error:
            check.message ?? 'The server presented an unexpected host key.',
          presentedHostKey: check.presented,
          latencyMs: Date.now() - startedAt,
        };
      }

      // The taxonomy already distinguishes a refused connection from a permission failure on the
      // write, and its wording is the contract. Rewrapping it here would only make it vaguer.
      //
      // `probeWritten` says which half of this failed: false means the connection, the directory
      // check or the write probe itself; true means only the cleanup after a successful probe.
      return {
        ok: false,
        error: this.classifyAndLog(
          probeWritten ? 'write-probe cleanup' : 'verify',
          config.host,
          error,
        ).message,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      // Leaving a probe file on a customer's server is not acceptable in any outcome, including the
      // one where the delete itself is what failed.
      if (probeWritten) {
        try {
          await client.delete(probePath);
        } catch (error) {
          this.logger.warn(
            `Could not remove the write probe ${probePath} on ${config.host}: ${(error as Error).message}`,
          );
        }
      }

      try {
        await client.end();
      } catch {
        // A close failure after the result is decided tells the admin nothing.
      }
    }
  }

  /**
   * Opens a streamed upload.
   *
   * Bytes go to `<name>.part` and are renamed into place only by `commit()`, after the remote size
   * is confirmed. Nothing ever writes directly to the final name, so neither a reader nor a
   * retention sweep can observe a half-written archive and mistake it for a finished one.
   *
   * Connects through the same SSRF-resolved address and the same pinned host-key check as
   * `verify()`. It does not share that method's body because `verify()` also runs a write probe and
   * must never throw; here a failure is a real error the run has to see.
   */
  async openWrite(
    ctx: TargetContext,
    logicalPath: string,
    byteLength?: number,
  ): Promise<UploadHandle> {
    const config = ctx.config as unknown as SftpTargetConfig;

    // Narrows the secret union before the connect options are built, exactly as verify() does.
    if (
      ctx.secret.auth_method !== 'sftp_password' &&
      ctx.secret.auth_method !== 'sftp_private_key'
    ) {
      throw new Error('This target is not an SFTP target.');
    }

    const secret = ctx.secret;
    const resolved: ResolvedSftpHost = await resolveSftpHost(
      config.host,
      Number(config.port),
    );

    const client = new SftpClient();
    const finalPath = joinRemotePath(config.remote_dir, logicalPath);
    const partPath = `${finalPath}.part`;

    let hostKeyCheck: HostKeyCheck | null = null;

    try {
      await client.connect({
        host: resolved.address,
        port: Number(config.port),
        username: config.username,
        readyTimeout: READY_TIMEOUT_MS,
        // This connection is opened before the export loop and held for the whole run, so it sits
        // idle for long stretches. Without keepalive a dropped connection is indistinguishable from
        // a slow one, and the upload stalls silently instead of failing.
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        ...(secret.auth_method === 'sftp_password'
          ? { password: secret.password }
          : {
              privateKey: secret.private_key,
              ...(secret.passphrase ? { passphrase: secret.passphrase } : {}),
            }),
        hostVerifier: (key: Buffer): boolean => {
          hostKeyCheck = checkHostKey(fingerprintHostKey(key), [
            config.host_key_sha256,
          ]);

          return hostKeyCheck.verdict === 'match';
        },
      });
    } catch (error) {
      await client.end().catch(() => undefined);

      // A refused host key aborts the handshake, so it surfaces here as a transport error. Cast
      // for the same reason verify() does: TypeScript cannot see the hostVerifier callback run.
      const check = hostKeyCheck as HostKeyCheck | null;

      if (check && check.verdict !== 'match') {
        throw new Error(check.message ?? 'The server host key was rejected.');
      }

      throw new Error(
        this.classifyAndLog('opening the upload', config.host, error).message,
      );
    }

    // `put` consumes the stream and resolves when the transfer completes. Holding the promise lets
    // commit() await it rather than racing the rename against an unfinished write.
    const sink = new PassThrough();

    // An 'error' event with no listener is FATAL in Node — it takes the process down. `abort()`
    // destroys this sink with a reason (so ssh2 stops waiting on a stream that will never end),
    // and the pipeline watcher in the worker listens on the export STAGES, not on this sink. So
    // without this line, aborting an upload would crash the backend rather than fail the run.
    sink.on('error', () => undefined);

    // The third argument is the entire reason an upload can exceed one request per round trip.
    // `put` forwards it to `createWriteStream` untouched apart from `autoClose`.
    //
    // The cast is not laziness: @types/ssh2-sftp-client declares WriteStreamOptions as four optional
    // properties and `highWaterMark` is not among them, which makes it a weak type that rejects any
    // object sharing none of its keys. The option is real and supported by the library itself.
    const transfer = client.put(sink, partPath, {
      writeStreamOptions: { highWaterMark: UPLOAD_HIGH_WATER_MARK_BYTES },
    } as unknown as Parameters<SftpClient['put']>[2]);

    // Marks the promise handled at creation. Nothing awaits `transfer` until commit() or abort(),
    // so a transfer that rejects early — a dropped connection during the export — would otherwise
    // surface as an unhandled rejection long before anyone is ready to read it. Attaching a no-op
    // handler does not consume the rejection: commit()/abort() still await the original and still
    // see the error.
    void transfer.catch(() => undefined);

    return {
      stream: sink,

      /**
       * @param observedBytes Actual size of the archive, known only once it has been written.
       *   Named separately from `openWrite`'s `byteLength` so it cannot shadow it by accident.
       */
      commit: async (observedBytes?: number) => {
        // Each step gets its own deadline rather than one budget across all three: a transfer may
        // legitimately take hours, while a `stat` that takes thirty seconds is a dead connection.
        //
        // The size comes from the caller because an archive is compressed and encrypted as it
        // streams, so nobody knows how big it is until it is finished. Without it every upload fell
        // back to the 60-second floor no matter how large — fine for a 30 KB archive, and a
        // guaranteed failure for a real one.
        await withDeadline(
          transfer,
          transferBudgetMs(observedBytes ?? byteLength),
          'uploading the archive',
        );

        const stat = await withDeadline(
          client.stat(partPath),
          METADATA_TIMEOUT_MS,
          'checking the uploaded archive',
        );

        const byteSize = stat.size;

        if (!byteSize) {
          await client.delete(partPath).catch(() => undefined);
          await client.end().catch(() => undefined);

          throw new Error('The uploaded archive was empty; it was discarded.');
        }

        await withDeadline(
          client.rename(partPath, finalPath),
          METADATA_TIMEOUT_MS,
          'putting the archive in place',
        );

        await client.end().catch(() => undefined);

        return { remotePath: finalPath, byteSize };
      },

      abort: async () => {
        // Destroyed WITH a reason. A bare destroy() emits no 'end', so ssh2's `put` never settles
        // and the await below would ride its deadline out every single time; the reason makes the
        // transfer reject immediately. Safe only because of the 'error' listener attached above.
        sink.destroy(new Error('The backup upload was aborted.'));

        // Best effort on every step — abort runs on a path that is already failing, and a cleanup
        // error must not replace the real reason the run failed — but BOUNDED on every step too.
        // Unbounded cleanup is what turned a one-second export failure into a 17-minute outage for
        // every other backup in the process.
        await withDeadline(
          transfer,
          ABORT_TIMEOUT_MS,
          'abandoning the upload',
        ).catch(() => undefined);

        try {
          await withDeadline(
            client.delete(partPath),
            METADATA_TIMEOUT_MS,
            'removing the partial upload',
          );
        } catch (error) {
          // Warned rather than swallowed. `list()` filters `.part` files out, so a leftover is
          // invisible in the archives UI: nobody can see it, nobody knows it is consuming the
          // target's quota, and the next run's write probe fails for reasons that look unrelated.
          this.logger.warn(
            `Could not remove the partial upload ${partPath} on ${config.host}: ` +
              `${(error as Error).message}. It may need to be deleted by hand.`,
          );
        }

        await withDeadline(
          client.end(),
          METADATA_TIMEOUT_MS,
          'closing the connection',
        ).catch(() => undefined);
      },
    };
  }

  /**
   * Connects, with the same five steps every other method uses.
   *
   * Extracted so `list()` and `get()` cannot drift from `verify()`/`openWrite()`/`remove()`. The
   * order is load-bearing: the host is resolved to an IP first (SSRF), the library is given that
   * literal so it cannot re-resolve to somewhere else, and `hostVerifier` runs during key exchange
   * — before authentication — so a mismatched host never receives the password.
   */
  private async connect(
    ctx: TargetContext,
    config: SftpTargetConfig,
  ): Promise<SftpClient> {
    if (
      ctx.secret.auth_method !== 'sftp_password' &&
      ctx.secret.auth_method !== 'sftp_private_key'
    ) {
      throw new Error('This target is not an SFTP target.');
    }

    const secret = ctx.secret;
    const resolved: ResolvedSftpHost = await resolveSftpHost(
      config.host,
      Number(config.port),
    );

    const client = new SftpClient();
    let hostKeyCheck: HostKeyCheck | null = null;

    try {
      await client.connect({
        host: resolved.address,
        port: Number(config.port),
        username: config.username,
        readyTimeout: READY_TIMEOUT_MS,
        ...(secret.auth_method === 'sftp_password'
          ? { password: secret.password }
          : {
              privateKey: secret.private_key,
              ...(secret.passphrase ? { passphrase: secret.passphrase } : {}),
            }),
        hostVerifier: (key: Buffer): boolean => {
          hostKeyCheck = checkHostKey(fingerprintHostKey(key), [
            config.host_key_sha256,
          ]);

          return hostKeyCheck.verdict === 'match';
        },
      });
    } catch (error) {
      await client.end().catch(() => undefined);

      // Host key first: ssh2 surfaces a refusal as a generic handshake error, so the real reason
      // would otherwise be rewritten by the taxonomy into something misleading.
      const check = hostKeyCheck as HostKeyCheck | null;

      if (check && check.verdict !== 'match') {
        throw new Error(check.message ?? 'The server host key was rejected.');
      }

      throw new Error(
        this.classifyAndLog('connect', config.host, error).message,
      );
    }

    return client;
  }

  /**
   * Lists the archives in the target's configured directory.
   *
   * Returns LOGICAL names (no directory), matching what `openWrite`/`get`/`remove` take. Returning
   * joined paths would invite a caller to feed one straight back in, and `joinRemotePath` would
   * then double-join it.
   */
  async list(ctx: TargetContext, prefix = ''): Promise<TargetObject[]> {
    const config = ctx.config as unknown as SftpTargetConfig;
    const client = await this.connect(ctx, config);

    try {
      const dir = config.remote_dir.replace(/\/+$/, '') || '/';
      const entries = await client.list(dir);

      return (
        entries
          // `-` is a regular file. Directories and the `.part` files of an upload in flight are not
          // archives, and offering either for download would hand back something unopenable.
          .filter(
            (entry) => entry.type === '-' && !entry.name.endsWith('.part'),
          )
          .filter((entry) => (prefix ? entry.name.startsWith(prefix) : true))
          .map((entry) => ({
            logicalPath: entry.name,
            byteSize: entry.size,
            modifiedAt: entry.modifyTime
              ? new Date(entry.modifyTime)
              : undefined,
            remoteId: null,
          }))
      );
    } catch (error) {
      throw new Error(
        this.classifyAndLog('listing archives', config.host, error).message,
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /**
   * Opens one object for reading.
   *
   * Streamed, never buffered: `ssh2-sftp-client`'s own `get()` with no destination reads the WHOLE
   * file into memory, which for a multi-gigabyte archive is not a download but an outage. The bytes
   * come through `ParallelSftpReadStream` so the transfer is bounded by bandwidth instead of by
   * round-trip time; see `openParallelRead` below.
   *
   * The returned stream owns the connection — nothing else can close it, because the interface
   * hands back a bare `Readable` with no disposal hook. `close` fires on both a normal end and a
   * `destroy()`, so an aborted download releases its connection too. Without this every download
   * leaks an SSH session for the life of the process.
   *
   * @param range Optional byte range, used to read just the archive header so a passphrase can be
   *   checked before any of the file is streamed to a client.
   */
  async get(
    ctx: TargetContext,
    logicalPath: string,
    range?: { start: number; end: number },
  ): Promise<Readable> {
    const config = ctx.config as unknown as SftpTargetConfig;
    const client = await this.connect(ctx, config);
    const finalPath = joinRemotePath(config.remote_dir, logicalPath);

    try {
      // Checked before the stream is created, so a missing file is a clean error here rather than
      // an asynchronous failure after the caller has already committed to a response.
      if (!(await client.exists(finalPath))) {
        throw new Error(`${ARCHIVE_MISSING_PREFIX}: ${logicalPath}`);
      }

      // Many READs in flight rather than one at a time. `createReadStream` costs one round trip per
      // chunk no matter how it is configured — see `DOWNLOAD_HIGH_WATER_MARK_BYTES` above and
      // `parallel-read-stream.ts` for why the obvious watermark fix does nothing here — which is
      // what made a 113 MB archive take thirteen minutes to come back from another continent while
      // the same file went out in a fraction of that.
      const stream = await this.openParallelRead(client, finalPath, range);

      stream.once('close', () => void client.end().catch(() => undefined));

      return stream;
    } catch (error) {
      await client.end().catch(() => undefined);

      throw error instanceof Error && error.message.startsWith('No such')
        ? error
        : new Error(
            this.classifyAndLog('reading the archive', config.host, error)
              .message,
          );
    }
  }

  /**
   * Builds the concurrent reader for one object, or falls back to the serial one.
   *
   * Two things have to be true before the fast path is taken, and neither is guaranteed:
   *
   *  - the raw `SFTPWrapper` is reachable. `ssh2-sftp-client` exposes it as `.sftp` and uses it for
   *    every one of its own methods, but it is not part of the published types, so it is checked
   *    rather than assumed. A future version that renames or hides it degrades to the old behaviour
   *    — slower, never broken.
   *  - the size is knowable. Concurrent reads have to be laid out over a known length: without it,
   *    a short reply is indistinguishable from the end of the file, and guessing wrong on an archive
   *    whose index lives at its tail yields a plausible file with its end missing.
   *
   * `stat` is one extra round trip on top of the `exists` the caller already did. That is a few
   * hundred milliseconds against a transfer this turns from minutes into seconds, and it buys the
   * exact length — including for a `range` that runs past the end of the file, which is clamped here
   * so the reader never has to treat an empty reply as anything but a fault.
   */
  private async openParallelRead(
    client: SftpClient,
    finalPath: string,
    range?: { start: number; end: number },
  ): Promise<Readable> {
    const serial = (): Readable =>
      client.createReadStream(finalPath, {
        ...(range ? { start: range.start, end: range.end } : {}),
        highWaterMark: DOWNLOAD_HIGH_WATER_MARK_BYTES,
      }) as Readable;

    const sftp = (client as unknown as { sftp?: SftpReadSource }).sftp;

    if (
      !sftp ||
      typeof sftp.open !== 'function' ||
      typeof sftp.read !== 'function' ||
      typeof sftp.close !== 'function'
    ) {
      this.logger.warn(
        'This ssh2-sftp-client does not expose a raw SFTP session, so the archive will be read one ' +
          'request at a time. Downloads from a distant target will be slow.',
      );

      return serial();
    }

    let size: number;

    try {
      const stat = await withDeadline(
        client.stat(finalPath),
        METADATA_TIMEOUT_MS,
        'measuring the archive',
      );

      size = Number(stat.size);
    } catch {
      // A target that answers `exists` but not `stat` is odd, not fatal. The serial reader needs no
      // size, so there is still a working download to fall back to.
      return serial();
    }

    if (!Number.isFinite(size) || size < 0) {
      return serial();
    }

    const start = range ? range.start : 0;

    // `end` is inclusive in the interface, and may legitimately reach past the end of the file —
    // the header probe asks for a fixed 64 KB from archives that can be smaller than that.
    const endExclusive = range ? Math.min(range.end + 1, size) : size;

    return new ParallelSftpReadStream({
      sftp,
      path: finalPath,
      start,
      length: Math.max(0, endExclusive - start),
      concurrency: readConcurrency(),
      chunkSize: DOWNLOAD_CHUNK_BYTES,
    });
  }

  /**
   * Opens one object for many ranged reads over a SINGLE connection.
   *
   * `get()` connects, streams, and closes the connection when the stream ends — correct there,
   * because it hands back a bare `Readable` with nowhere to put a disposal hook. But reading a zip
   * without downloading it means several small reads (the directory at the tail, then the entries
   * wanted), and doing those through `get()` would be one full SSH handshake each. At a 15-second
   * ready timeout apiece, four handshakes cost more than the megabytes they save — ranged reading
   * would be SLOWER than the download it replaces. This exists so one handshake serves them all.
   *
   * The session owns the connection: the per-read streams deliberately do NOT close it, and only
   * `close()` does. Callers must call it in a `finally`, or a connection leaks per archive read and
   * a handful of previews exhausts the target's connection limit.
   */
  async openRead(
    ctx: TargetContext,
    logicalPath: string,
  ): Promise<RangeSession> {
    const config = ctx.config as unknown as SftpTargetConfig;
    const client = await this.connect(ctx, config);
    const finalPath = joinRemotePath(config.remote_dir, logicalPath);

    let closed = false;

    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }

      closed = true;
      await client.end().catch(() => undefined);
    };

    try {
      // Checked once for the session rather than per read: a missing archive is a clean error here,
      // instead of the same failure repeated on every range.
      if (!(await client.exists(finalPath))) {
        throw new Error(`${ARCHIVE_MISSING_PREFIX}: ${logicalPath}`);
      }
    } catch (error) {
      await close();

      throw error instanceof Error && error.message.startsWith('No such')
        ? error
        : new Error(
            this.classifyAndLog('reading the archive', config.host, error)
              .message,
          );
    }

    return {
      read: async (start: number, end: number): Promise<Buffer> => {
        if (closed) {
          throw new Error('This archive read session is already closed.');
        }

        if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
          throw new Error(
            `Invalid archive byte range ${start}-${end}: end must not precede start.`,
          );
        }

        const stream = client.createReadStream(finalPath, {
          start,
          end,
          highWaterMark: DOWNLOAD_HIGH_WATER_MARK_BYTES,
        }) as Readable;

        const collect = (async () => {
          const chunks: Buffer[] = [];

          for await (const chunk of stream) {
            chunks.push(chunk as Buffer);
          }

          return Buffer.concat(chunks);
        })();

        try {
          // Bounded like every other read against a target that may simply stop answering. The
          // budget scales with the range so a large entry is not cut off, with the metadata floor
          // for the small directory reads this mostly does.
          return await withDeadline(
            collect,
            Math.max(METADATA_TIMEOUT_MS, transferBudgetMs(end - start + 1)),
            'reading part of the archive',
          );
        } catch (error) {
          // `withDeadline` rejects the promise but cannot close a stream it does not own. Without
          // this the read fails while the stream stays open on a connection the session still holds.
          stream.destroy();

          throw error;
        }
      },
      close,
    };
  }

  /**
   * Deletes one archive from the target.
   *
   * Takes a LOGICAL path and joins `remote_dir` itself, exactly as `openWrite` does. That symmetry
   * is the contract, and it is the thing most likely to be got wrong: `openWrite` returns the
   * JOINED path, and that joined value is what lands in `backup_artifacts.remote_path`. Handing
   * that stored value back to this method would join `remote_dir` a second time — best case the
   * delete misses and retention silently never works, worst case it resolves to a real path and
   * removes the wrong file. A caller holding an absolute path must strip the prefix first, and must
   * skip rather than guess when the prefix does not match.
   *
   * Deleting something already gone is treated as SUCCESS. A retention sweep is inherently
   * at-least-once — a crash between the delete and the bookkeeping write replays it — so a
   * missing-file error is the expected shape of a retry, not a failure to surface.
   *
   * Nothing calls this yet. Retention selection and bookkeeping are still unbuilt; see
   * tasks/backup-and-restore/24-adapter-gaps-and-sharepoint-readiness.md (G-4).
   */
  async remove(ctx: TargetContext, logicalPath: string): Promise<void> {
    const config = ctx.config as unknown as SftpTargetConfig;

    // Narrows the secret union before the connect options are built, exactly as openWrite() does.
    if (
      ctx.secret.auth_method !== 'sftp_password' &&
      ctx.secret.auth_method !== 'sftp_private_key'
    ) {
      throw new Error('This target is not an SFTP target.');
    }

    const secret = ctx.secret;
    const resolved: ResolvedSftpHost = await resolveSftpHost(
      config.host,
      Number(config.port),
    );

    const client = new SftpClient();
    const finalPath = joinRemotePath(config.remote_dir, logicalPath);

    let hostKeyCheck: HostKeyCheck | null = null;

    try {
      await client.connect({
        host: resolved.address,
        port: Number(config.port),
        username: config.username,
        readyTimeout: READY_TIMEOUT_MS,
        ...(secret.auth_method === 'sftp_password'
          ? { password: secret.password }
          : {
              privateKey: secret.private_key,
              ...(secret.passphrase ? { passphrase: secret.passphrase } : {}),
            }),
        hostVerifier: (key: Buffer): boolean => {
          hostKeyCheck = checkHostKey(fingerprintHostKey(key), [
            config.host_key_sha256,
          ]);

          return hostKeyCheck.verdict === 'match';
        },
      });
    } catch (error) {
      await client.end().catch(() => undefined);

      // Cast for the same reason verify()/openWrite() do: TypeScript cannot see the callback run.
      const check = hostKeyCheck as HostKeyCheck | null;

      if (check && check.verdict !== 'match') {
        throw new Error(check.message ?? 'The server host key was rejected.');
      }

      throw new Error(
        this.classifyAndLog('connect', config.host, error).message,
      );
    }

    // Carried out of the try rather than thrown inside it. A refusal is OUR decision, not a
    // transport failure, and `classifySftpError` in the catch below would rewrite it into a generic
    // SFTP message — losing the one sentence that tells the admin their path is wrong.
    let refusal: string | null = null;

    try {
      // Checked rather than relying on the delete's own error: `exists` distinguishes "already
      // gone" from "gone AND unreadable", and only the first is safe to call success.
      const stat = await client.exists(finalPath);

      if (stat === false) {
        this.logger.log(
          `Archive ${finalPath} on ${config.host} was already absent; treating the delete as done.`,
        );

        return;
      }

      if (stat === 'd') {
        // A directory where an archive should be means the path is wrong. Deleting it recursively
        // on a customer's server is never the recoverable choice.
        refusal = `${finalPath} on ${config.host} is a directory, not an archive. Refusing to delete it.`;
      } else {
        await client.delete(finalPath);
      }
    } catch (error) {
      throw new Error(
        this.classifyAndLog('deleting the archive', config.host, error).message,
      );
    } finally {
      try {
        await client.end();
      } catch {
        // A close failure after the delete is decided tells the admin nothing.
      }
    }

    if (refusal) {
      throw new Error(refusal);
    }
  }
}
