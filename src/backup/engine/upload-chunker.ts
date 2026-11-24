/**
 * @fileoverview Re-cuts the archive stream into uniform chunks the SFTP layer can pipeline.
 * @module src/backup/engine/upload-chunker
 *
 * ## Why this exists
 *
 * ssh2 has no write concurrency of its own — its author says so at `SFTP.js:3833` ("TODO: add
 * `concurrency` setting to allow more than one in-flight WRITE request"). The only way to get more
 * than one request onto the wire is to have more than one chunk BUFFERED in the write stream, so
 * that Node calls `_writev`, which fires every buffered chunk at once.
 *
 * Two things stopped that happening, and this file fixes the first:
 *
 *   * Chunks were far too BIG. An encrypted archive arrives as one ~1 MiB cipher frame per chunk
 *     (`archive-cipher.ts` FRAME_PLAINTEXT_BYTES), and `SFTP.prototype.write` splits anything over
 *     `_maxWriteLen` by recursing INSIDE the reply callback — one round trip per slice, strictly
 *     serial. A 113 MB archive went out at ~148 KB/s that way.
 *   * Chunks can also be far too SMALL. With `compression: 'none'` archiver stores rather than
 *     deflates, so per-row writes reach the socket unchanged and a large buffer would mean
 *     thousands of tiny concurrent requests.
 *
 * Emitting one uniform size solves both: every chunk becomes exactly one SFTP WRITE, and the number
 * in flight is the write stream's highWaterMark divided by this size.
 *
 * ## This is HALF of a fix
 *
 * On its own this class makes throughput WORSE, and shipping it alone would be a regression. `pipe()`
 * only hands over a second chunk while `dest.write()` keeps returning true, and against the default
 * 16 KB highWaterMark a 32 KB chunk returns false immediately — one write in flight, now in smaller
 * pieces than before. It is only useful together with the raised `writeStreamOptions.highWaterMark`
 * in `sftp.adapter.ts`. The two belong to one change and must be reverted together.
 */

import { Transform, type TransformCallback } from 'stream';

/**
 * The size every chunk is cut to.
 *
 * `_maxWriteLen` in ssh2 is `(isOpenSSH ? 256 KiB : 34_000) - 2 KiB` — 260,096 against an OpenSSH
 * server and 31,952 against anything else. The smaller value is used because it is correct on BOTH,
 * and because the alternative is reading `sftp._maxWriteLen`, which is private and only accurate
 * after the `limits@openssh.com` extension has been negotiated.
 *
 * Staying at or below that number is the whole point: one chunk must equal one WRITE, never a
 * request the library then has to split serially.
 */
export const UPLOAD_CHUNK_BYTES = 31_952;

/**
 * Buffers the stream and re-emits it in `UPLOAD_CHUNK_BYTES` pieces, remainder last.
 *
 * Bytes and their order are untouched — only the boundaries move. That is what makes this safe to
 * drop into the middle of an encrypted archive: the reader on the other side reassembles frames by
 * parsing a length header out of an accumulating buffer, so it has never depended on where one
 * chunk ends and the next begins.
 *
 * The watermarks are deliberately left at their defaults. The exporter's row writes are supposed to
 * block on the upload draining — that backpressure is what keeps peak memory flat on a multi-GB
 * archive — and buffering here would break the chain rather than speed it up.
 */
export class UploadChunker extends Transform {
  /** Whole buffers as received, never concatenated until a chunk is actually cut. */
  private pending: Buffer[] = [];

  private pendingBytes = 0;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;

    while (this.pendingBytes >= UPLOAD_CHUNK_BYTES) {
      this.push(this.takeBytes(UPLOAD_CHUNK_BYTES));
    }

    callback();
  }

  /**
   * The tail.
   *
   * Without this the last partial chunk is dropped and the archive is short by up to
   * `UPLOAD_CHUNK_BYTES - 1`. It would not pass silently — the worker compares its own byte count
   * against the size the server reports and fails the run — but every backup would fail.
   */
  override _flush(callback: TransformCallback): void {
    if (this.pendingBytes > 0) {
      this.push(this.takeBytes(this.pendingBytes));
    }

    callback();
  }

  /**
   * Cuts exactly `n` bytes off the front of the backlog.
   *
   * Copies once into a right-sized buffer rather than concatenating the whole backlog and slicing
   * it, so a chunk costs its own size and not the size of everything waiting behind it. Same
   * approach as `takeBytes` in `archive-cipher.ts`, for the same reason.
   */
  private takeBytes(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let offset = 0;

    while (offset < n) {
      const head = this.pending[0];
      const needed = n - offset;

      if (head.length <= needed) {
        head.copy(out, offset);
        offset += head.length;
        this.pending.shift();

        continue;
      }

      head.copy(out, offset, 0, needed);
      this.pending[0] = head.subarray(needed);
      offset += needed;
    }

    this.pendingBytes -= n;

    return out;
  }
}
