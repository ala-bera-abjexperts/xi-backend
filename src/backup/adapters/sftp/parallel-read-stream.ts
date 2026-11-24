/**
 * @fileoverview Reads one remote file with many SFTP READ requests in flight at once.
 * @module src/backup/adapters/sftp/parallel-read-stream
 *
 * ## Why this exists
 *
 * This is the read-side sibling of `upload-chunker.ts`, and it exists for the same reason: ssh2
 * issues ONE request per round trip unless it is forced not to.
 *
 * `client.createReadStream()` is backed by ssh2's `ReadStream`, whose `_read` (SFTP.js:3724) calls
 * `sftp.read()` once and waits for the reply before calling it again. There is no `_readv` — the
 * write side's escape hatch, which is what makes the raised `writeStreamOptions.highWaterMark` work
 * for uploads — so on the read side a large `highWaterMark` buys nothing at all. Worse, `read_`
 * (SFTP.js:2101) clamps every request to `_maxReadLen` and then continues the remainder from INSIDE
 * the reply callback (SFTP.js:2153), which is serial by construction.
 *
 * The result is a hard ceiling of `_maxReadLen / RTT`:
 *
 *   * 260,096 bytes per round trip against an OpenSSH server;
 *   * 31,952 bytes per round trip against anything else.
 *
 * Against a target on another continent that ceiling IS the download time. A 113 MB archive came
 * back at ~146 KB/s — thirteen minutes — while the same file had gone out in a fraction of that,
 * because the upload path pipelines and the download path did not.
 *
 * ## What this does instead
 *
 * One `open`, then up to `DOWNLOAD_CONCURRENCY` reads outstanding at once, reassembled in offset
 * order. That is exactly the shape of ssh2's own `fastXfer` (SFTP.js:2186, 64 x 32 KB) — the
 * library's answer to this problem — but delivered as a `Readable` instead of a local file, so the
 * adapter's `get()` keeps its contract and every caller downstream is untouched.
 *
 * Transfers stop being bound by round-trip time and become bound by bandwidth.
 */

import { Readable } from 'node:stream';

/**
 * The size of one READ request.
 *
 * Deliberately identical to `UPLOAD_CHUNK_BYTES`, for the same reason spelled out there:
 * `_maxReadLen` is `(isOpenSSH ? 256 KiB : 34_000) - 2 KiB`, so this is the largest size that is
 * ONE request on BOTH kinds of server. Anything larger is split serially inside ssh2 against a
 * non-OpenSSH target, which is the very behaviour this file exists to avoid.
 *
 * Reading `sftp._maxReadLen` to pick the larger value where it is available was considered and
 * rejected: it is private, and it is only accurate after the `limits@openssh.com` extension has
 * been negotiated. Concurrency is the cheaper lever and it works everywhere.
 */
export const DOWNLOAD_CHUNK_BYTES = 31_952;

/**
 * How many READ requests may be outstanding at once.
 *
 * 64 is what ssh2's `fastXfer` uses, and 64 x 31,952 is ~2 MiB — which is what an SSH channel's
 * window holds (`MAX_WINDOW`). Past that point the replies queue inside ssh2 waiting for a
 * WINDOW_ADJUST: more memory, no more speed. It is the same ceiling the upload path's 2 MiB
 * watermark is set against, arrived at from the other direction.
 *
 * Peak memory is bounded by this times the chunk size, because a request is only issued while
 * in-flight plus already-completed-but-not-yet-emitted chunks are below it.
 */
export const DOWNLOAD_CONCURRENCY = 64;

/**
 * The slice of ssh2's `SFTPWrapper` this needs.
 *
 * Declared structurally rather than imported so the file is trivially testable with a fake, and so
 * a change in `@types/ssh2` cannot break the build over methods that are not used here.
 */
export interface SftpReadSource {
  open(
    path: string,
    flags: string,
    cb: (err: Error | null | undefined, handle: Buffer) => void,
  ): void;
  read(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (
      err: Error | null | undefined,
      bytesRead: number,
      buffer: Buffer,
      position: number,
    ) => void,
  ): void;
  close(handle: Buffer, cb: (err?: Error | null) => void): void;
}

export interface ParallelSftpReadStreamOptions {
  /** The already-connected SFTP session. The stream does NOT own it and never ends it. */
  sftp: SftpReadSource;
  /** Absolute remote path, already joined against `remote_dir`. */
  path: string;
  /**
   * How many bytes to read, and from where.
   *
   * The caller resolves this against the file's real size before constructing the stream, so a
   * range that runs past the end of the file is impossible here. That is what lets a short read be
   * treated as the fault it is rather than guessed at as an end-of-file.
   */
  start: number;
  length: number;
  /** Overridable so a server that limits outstanding requests can be accommodated. */
  concurrency?: number;
  chunkSize?: number;
}

/**
 * A `Readable` that pulls one remote file through many concurrent SFTP READs.
 *
 * Bytes and their order are exactly what a serial read would have produced — only the number of
 * requests in flight changes. That is what makes it safe to drop underneath an encrypted archive:
 * `ArchiveDecryptStream` reassembles frames from an accumulating buffer and has never depended on
 * where one chunk ends and the next begins.
 */
export class ParallelSftpReadStream extends Readable {
  private readonly sftp: SftpReadSource;
  private readonly path: string;
  private readonly start: number;
  private readonly length: number;
  private readonly concurrency: number;
  private readonly chunkSize: number;
  private readonly totalChunks: number;

  private handle: Buffer | null = null;
  private opening = false;

  /** Index of the chunk that must be pushed next. Emission is strictly in order. */
  private nextToEmit = 0;
  /** Index of the next chunk to request. */
  private nextToIssue = 0;
  private inFlight = 0;

  /** Completed chunks waiting for their turn, keyed by chunk index. */
  private readonly ready = new Map<number, Buffer>();

  /** Set when `push()` asked us to stop; cleared by `_read`. */
  private paused = false;
  private finished = false;
  private failed = false;

  constructor(options: ParallelSftpReadStreamOptions) {
    super();

    this.sftp = options.sftp;
    this.path = options.path;
    this.start = options.start;
    this.length = options.length;
    this.concurrency = Math.max(1, options.concurrency ?? DOWNLOAD_CONCURRENCY);
    this.chunkSize = Math.max(1, options.chunkSize ?? DOWNLOAD_CHUNK_BYTES);
    this.totalChunks = Math.ceil(this.length / this.chunkSize);
  }

  /**
   * Node's pull signal.
   *
   * Everything real happens in `pump()`. This only clears the backpressure flag and restarts it,
   * because the stream is push-driven once it is going: replies arrive on their own schedule and
   * each one tries to make progress.
   */
  _read(): void {
    this.paused = false;

    if (this.handle || this.opening) {
      this.pump();

      return;
    }

    // An empty range never opens the file. There is nothing to read, and an `open` would be a
    // round trip spent to learn that.
    if (this.length <= 0) {
      this.finished = true;
      this.push(null);

      return;
    }

    this.opening = true;

    this.sftp.open(this.path, 'r', (err, handle) => {
      this.opening = false;

      if (err) {
        this.destroy(err);

        return;
      }

      if (this.destroyed) {
        // Raced with a cancellation: the handle arrived after the consumer went away, and nothing
        // else will ever close it.
        this.sftp.close(handle, () => undefined);

        return;
      }

      this.handle = handle;
      this.pump();
    });
  }

  /**
   * Issues as many reads as the window allows, then emits whatever is now contiguous.
   *
   * The gate is `inFlight + ready.size`, not `inFlight` alone. Gating on in-flight only would let a
   * single slow chunk at the head of the queue accumulate an unbounded tail of completed chunks
   * behind it, which is the same memory blow-up buffering the whole file would have been.
   */
  private pump(): void {
    if (this.failed || this.destroyed || !this.handle) {
      return;
    }

    while (
      !this.paused &&
      this.nextToIssue < this.totalChunks &&
      this.inFlight + this.ready.size < this.concurrency
    ) {
      this.issue(this.nextToIssue++);
    }

    this.drain();
  }

  /** Requests one chunk. `index` is its position in the file, not its arrival order. */
  private issue(index: number): void {
    const handle = this.handle;

    if (!handle) {
      return;
    }

    const offset = index * this.chunkSize;
    const length = Math.min(this.chunkSize, this.length - offset);
    const buffer = Buffer.allocUnsafe(length);

    this.inFlight += 1;

    // `filled` tracks a short reply. SFTP is allowed to return fewer bytes than asked for without
    // it meaning end-of-file, and the remainder has to be asked for again rather than assumed.
    const readInto = (filled: number): void => {
      this.sftp.read(
        handle,
        buffer,
        filled,
        length - filled,
        this.start + offset + filled,
        (err, bytesRead) => {
          if (this.failed || this.destroyed) {
            return;
          }

          if (err) {
            this.inFlight -= 1;
            this.fail(err);

            return;
          }

          // The length was resolved against the file's real size before this stream was built, so
          // there are bytes here by construction. Zero means the file was truncated or replaced
          // underneath the transfer — for an archive whose index lives at its tail, continuing
          // would hand back a plausible-looking file that is missing its end.
          if (!bytesRead) {
            this.inFlight -= 1;
            this.fail(
              new Error(
                `The archive ended after ${this.start + offset + filled} bytes, before the ` +
                  `${this.length} the server reported. It was changed or removed while it was ` +
                  'being read.',
              ),
            );

            return;
          }

          const now = filled + bytesRead;

          if (now < length) {
            readInto(now);

            return;
          }

          this.inFlight -= 1;
          this.ready.set(index, buffer);
          this.pump();
        },
      );
    };

    readInto(0);
  }

  /**
   * Pushes every chunk that is now contiguous from `nextToEmit`, and ends the stream after the last.
   *
   * Stops at the first `push()` that returns false. The chunks behind it stay in `ready`, which is
   * also what stops `pump()` from issuing more — backpressure reaches the network by arithmetic
   * rather than by a separate flag.
   */
  private drain(): void {
    while (!this.paused && this.ready.has(this.nextToEmit)) {
      const chunk = this.ready.get(this.nextToEmit) as Buffer;

      this.ready.delete(this.nextToEmit);
      this.nextToEmit += 1;

      if (!this.push(chunk)) {
        this.paused = true;
      }
    }

    if (!this.finished && this.nextToEmit >= this.totalChunks) {
      this.finished = true;
      this.push(null);
    }
  }

  /**
   * Fails once.
   *
   * Several reads are in flight, so a dead connection produces several errors; without the latch the
   * first would destroy the stream and the rest would arrive on an already-destroyed one.
   */
  private fail(err: Error): void {
    if (this.failed) {
      return;
    }

    this.failed = true;
    this.destroy(err);
  }

  /**
   * Releases the remote file handle.
   *
   * The SFTP session itself is deliberately left alone: it belongs to whoever built this stream.
   * `get()` closes it on the stream's `close` event, and `openRead()`'s session outlives many reads.
   */
  _destroy(err: Error | null, cb: (err: Error | null) => void): void {
    this.ready.clear();

    const handle = this.handle;

    this.handle = null;

    if (!handle) {
      cb(err);

      return;
    }

    // A failure to close a handle is not worth failing a download that otherwise succeeded, and
    // it must never mask the error that got us here.
    this.sftp.close(handle, () => cb(err));
  }
}
