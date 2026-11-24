/**
 * @fileoverview The contract every backup destination implements.
 * @module src/backup/adapters/backup-target-adapter.interface
 *
 * The adapter knows nothing about encryption, NDJSON, or the component registry. It is handed a
 * logical path and a writable sink, and that is the whole of its world. That separation is what keeps
 * a second destination (SharePoint) a single new file rather than a second path through the engine.
 *
 * `openWrite` carries an optional byteLength because chunked-upload APIs need the total size up
 * front, while SFTP does not.
 */

import type { Readable, Writable } from 'node:stream';
import type {
  BackupTargetSecret,
  BackupTargetType,
} from '../types/backup-target-secret.type';

/**
 * Deliberately an alias of {@link BackupTargetType}, not a second literal union.
 *
 * These were two spellings of one concept: the database CHECK, BACKUP_TARGET_TYPES and every DTO
 * say `'sharepoint'`, while this file used to say `'sharepoint_online'`. Nothing mapped between
 * them, so nothing broke — but the moment an adapter factory is keyed on the stored value
 * (`adapters[target.target_type]`), the mismatch resolves to `undefined` and surfaces as a
 * TypeError deep inside a run rather than a clean "unsupported target" error.
 *
 * Aliasing the single source of truth makes that class of drift unrepresentable.
 * See tasks/backup-and-restore/24-adapter-gaps-and-sharepoint-readiness.md (G-2, G-3).
 */
export type BackupTargetKind = BackupTargetType;

export interface TargetContext {
  targetId: string;
  organizationId: string;

  /** The non-secret config snapshot frozen into the run. Never the secret trio. */
  config: Record<string, unknown>;

  /** Opened per operation and never held across runs. */
  secret: BackupTargetSecret;

  /** Hard stop for the whole run: a server that stalls must not pin the run open forever. */
  deadlineAt: Date;
}

export interface TargetVerifyResult {
  ok: boolean;

  /** Actionable text for an admin — never carries key material. */
  error?: string;

  /** Set when the failure is a host-key problem, so the UI can offer the rotation flow. */
  presentedHostKey?: string;
  latencyMs?: number;
}

export interface TargetObject {
  logicalPath: string;
  byteSize: number;
  modifiedAt?: Date;

  /** Provider object id where one exists (Graph driveItem); null for SFTP. */
  remoteId?: string | null;
}

/**
 * A write in progress. The archive is streamed into `stream`, which the adapter points at a
 * `.part` file; `commit()` verifies the byte length and renames it into place. Nothing ever writes
 * directly to the final name, so a reader — or a retention sweep — can never observe a partial file.
 */
export interface UploadHandle {
  stream: Writable;

  /**
   * @param observedBytes How many bytes were actually written, for sizing the transfer deadline.
   *   An archive is compressed and encrypted as it streams, so its size cannot be known when
   *   `openWrite` is called — only here. Omitting it falls back to the flat floor budget, which is
   *   right for a small archive and far too short for a large one.
   *
   *   The returned `byteSize` is what the SERVER reports, never this value. Deriving it from the
   *   caller's count would make the worker's post-upload comparison compare a number to itself and
   *   silently stop detecting truncated transfers.
   */
  commit(
    observedBytes?: number,
  ): Promise<{ remotePath: string; byteSize: number }>;
  abort(): Promise<void>;
}

/**
 * A connection held open for several ranged reads of one object.
 *
 * The session owns the connection, not the individual read. That is the whole point and it is the
 * one thing an implementation must get right: if a per-read stream closes the connection — which is
 * what `get()` deliberately does, because there nothing else can — the second read reconnects and
 * the session has bought nothing.
 */
export interface RangeSession {
  /**
   * Reads bytes `start` to `end` INCLUSIVE, Node's stream convention.
   *
   * Returns fewer bytes than asked only at end-of-file. A caller that needs to know it got what it
   * asked for must check the length: some servers answer a range request with the whole object, and
   * treating that as the requested window silently reads the wrong bytes.
   */
  read(start: number, end: number): Promise<Buffer>;

  /** Releases the connection. Safe to call twice; must be called in a `finally`. */
  close(): Promise<void>;
}

export interface BackupTargetAdapter {
  readonly kind: BackupTargetKind;

  /** Connect, authenticate, and prove the configured directory is writable. */
  verify(ctx: TargetContext): Promise<TargetVerifyResult>;

  openWrite(
    ctx: TargetContext,
    logicalPath: string,
    byteLength?: number,
  ): Promise<UploadHandle>;

  list(ctx: TargetContext, prefix: string): Promise<TargetObject[]>;

  /**
   * @param range Optional inclusive byte range, so a caller can read part of an object without
   *   transferring all of it.
   *
   * Declared here rather than only on the concrete adapter. It was already implemented and used in
   * production — the passphrase probe reads a 64 KB head — but the contract did not mention it, so
   * it worked only because every consumer injects `SftpTargetAdapter` directly. The moment a second
   * adapter appeared behind this interface, ranged reads would have silently become whole-file
   * reads: the same call, the same types, quietly moving gigabytes.
   */
  get(
    ctx: TargetContext,
    logicalPath: string,
    range?: { start: number; end: number },
  ): Promise<Readable>;

  /**
   * Opens one object for MANY ranged reads over a single connection.
   *
   * Optional because not every transport can do it, and an adapter without it is not broken — the
   * caller falls back to reading the whole object.
   *
   * The reason this exists rather than callers looping over `get(..., range)`: `get` connects and
   * authenticates per call and closes the connection when the stream ends. Reading a zip's directory
   * and then an entry is four such reads, and four SSH handshakes cost more than the bytes they
   * save. A session amortises one handshake over every read.
   */
  openRead?(ctx: TargetContext, logicalPath: string): Promise<RangeSession>;

  remove(ctx: TargetContext, logicalPath: string): Promise<void>;
}
