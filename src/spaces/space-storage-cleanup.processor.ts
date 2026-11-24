/**
 * @fileoverview Durable, retryable storage cleanup for deleted spaces.
 * @module src/spaces/space-storage-cleanup.processor
 * @author Prince Jadiya
 */

import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

const CLAIM_BATCH_SIZE = 100;
const STORAGE_BATCH_SIZE = 1000;
const ERROR_LIMIT = 2000;

const SPACE_BUCKETS = new Set([
  'file-explorer',
  'attachments',
  'task-attachments',
  'process-attachments',
  'list-attachments',
  'gdpr-attachments',
  'asset-object-attachments',
  'asset-object-images',
  'space-icons',
  'wiki-attachments',
  'form_builder_submission_attachments',
  'whiteboard-files',
]);

export interface SpaceDeletionScope {
  id: string;
  job_id: string;
  organization_id: string;
  space_id: string;
  bucket: string;
  path: string;
  kind: 'exact' | 'prefix';
  attempt_count: number;
  settle_after: string;
}

type StorageClient = ReturnType<
  ReturnType<SupabaseAdminService['getClient']>['storage']['from']
>;

/** Rows removed per delete_space_rows_batch() call. Small enough that one call stays far
 *  below any statement timeout, large enough that a big space drains in few round trips. */
const ROW_DRAIN_BATCH = 500;

/** Cron period of drain(); keep in step with the @Cron expression below. */
export const DRAIN_INTERVAL_MS = 10_000;

/** How long one tick may spend deleting rows, across ALL spaces, before yielding.
 *  Must stay below DRAIN_INTERVAL_MS so a tick finishes before the next one fires
 *  and leaves headroom for the storage drain that follows it. */
export const ROW_DRAIN_BUDGET_MS = 8_000;

/** Backoff after a failed batch/finalize RPC: doubles per consecutive failure. */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 300_000;

/** Spaces drained per tick. Deletions are rare; this only bounds a pathological backlog. */
const SPACES_PER_TICK = 5;

@Injectable()
export class SpaceStorageCleanupProcessor {
  private readonly logger = new Logger(SpaceStorageCleanupProcessor.name);
  private readonly workerId = `space-storage-cleanup:${process.pid}:${randomUUID()}`;
  private rpcMissingLogged = false;
  /** drain() is not re-entrant — a slow tick must not stack a second one on top. */
  private running = false;
  /** Spaces this process is draining right now (cron + the post-delete kick). */
  private readonly drainingSpaces = new Set<string>();
  /** Spaces whose last RPC failed, and when they may be retried. */
  private readonly retryAfter = new Map<
    string,
    { until: number; delayMs: number }
  >();

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // Every DRAIN_INTERVAL_MS (10 s) — @Cron needs a literal.
  @Cron('*/10 * * * * *')
  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      try {
        await this.drainDeletingSpaces();
      } catch (error) {
        this.logger.error(
          `Space row deletion drain failed: ${this.errorMessage(error)}`,
        );
      }

      try {
        await this.drainOnce();
      } catch (error) {
        this.logger.error(
          `Space storage cleanup drain failed: ${this.errorMessage(error)}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Removes the rows of every space queued for deletion, one bounded batch at a time.
   *
   * The batch is what keeps this safe: a space with a million tasks is a million rows of
   * work, but never a single statement long enough to hit a timeout. The whole tick spends
   * at most ROW_DRAIN_BUDGET_MS so it cannot monopolise the scheduler, and simply picks up
   * where it left off on the next one — the space stays marked until it is fully drained.
   * Spaces in failure backoff are skipped until their retry time.
   */
  async drainDeletingSpaces(): Promise<number> {
    const { data, error } = (await this.client
      .from('spaces')
      .select('id')
      .not('deleting_at', 'is', null)
      .order('deleting_at', { ascending: true })
      .limit(SPACES_PER_TICK)) as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new Error(
        `Could not list spaces queued for deletion: ${error.message}`,
      );
    }

    const deadline = Date.now() + ROW_DRAIN_BUDGET_MS;
    let drained = 0;
    for (const space of data ?? []) {
      if (Date.now() >= deadline) break;
      if (this.isBackingOff(space.id)) continue;
      drained += await this.drainSpaceRows(space.id, deadline);
    }

    return drained;
  }

  /**
   * Drains one space. Returns the number of rows removed on this pass; the space row itself
   * is removed only once no heavy children are left.
   *
   * No-op (0) when this process is already draining the space or it is in failure backoff.
   * `deadline` is the tick's shared budget; standalone calls get their own.
   */
  async drainSpaceRows(
    spaceId: string,
    deadline: number = Date.now() + ROW_DRAIN_BUDGET_MS,
  ): Promise<number> {
    if (this.drainingSpaces.has(spaceId) || this.isBackingOff(spaceId)) {
      return 0;
    }
    this.drainingSpaces.add(spaceId);

    try {
      return await this.drainSpaceRowsUnguarded(spaceId, deadline);
    } finally {
      this.drainingSpaces.delete(spaceId);
    }
  }

  private async drainSpaceRowsUnguarded(
    spaceId: string,
    deadline: number,
  ): Promise<number> {
    let removed = 0;

    for (;;) {
      const { data, error } = (await this.client.rpc(
        'delete_space_rows_batch',
        {
          p_space_id: spaceId,
          p_limit: ROW_DRAIN_BATCH,
        },
      )) as {
        data: number | null;
        error: { message: string; code?: string } | null;
      };

      if (error) {
        this.backOff(spaceId, 'row deletion batch failed', error);
        return removed;
      }
      this.retryAfter.delete(spaceId);

      const batch = data ?? 0;
      removed += batch;

      if (batch === 0) break;

      // Out of budget for this tick — the next one continues from here.
      if (Date.now() >= deadline) return removed;
    }

    const { data: finalized, error: finalizeError } = (await this.client.rpc(
      'finalize_space_deletion',
      { p_space_id: spaceId },
    )) as {
      data: boolean | null;
      error: { message: string; code?: string } | null;
    };

    if (finalizeError) {
      this.backOff(spaceId, 'could not be finalized', finalizeError);
      return removed;
    }
    this.retryAfter.delete(spaceId);

    if (finalized) {
      this.logger.log(
        `Space ${spaceId} fully deleted (${removed} row(s) removed on this pass)`,
      );
    }

    return removed;
  }

  private isBackingOff(spaceId: string): boolean {
    return (this.retryAfter.get(spaceId)?.until ?? 0) > Date.now();
  }

  private backOff(
    spaceId: string,
    what: string,
    error: { message: string; code?: string },
  ): void {
    const previous = this.retryAfter.get(spaceId);
    const delayMs = previous
      ? Math.min(previous.delayMs * 2, RETRY_MAX_MS)
      : RETRY_BASE_MS;
    this.retryAfter.set(spaceId, { until: Date.now() + delayMs, delayMs });
    this.logger.error(
      `Space ${spaceId} ${what}; retrying in ${delayMs / 1000}s: ${error.message}${error.code ? ` (code ${error.code})` : ''}`,
    );
  }

  async drainOnce(spaceId: string | null = null): Promise<number> {
    const scopes = await this.claimScopes(spaceId);
    if (scopes.length === 0) return 0;

    const exactByBucket = new Map<string, SpaceDeletionScope[]>();
    const prefixes: SpaceDeletionScope[] = [];

    for (const scope of scopes) {
      const validationError = this.validateScope(scope);
      if (validationError) {
        await this.release(scope, validationError);
        continue;
      }

      if (scope.kind === 'prefix') {
        prefixes.push(scope);
        continue;
      }

      const bucketScopes = exactByBucket.get(scope.bucket) ?? [];
      bucketScopes.push(scope);
      exactByBucket.set(scope.bucket, bucketScopes);
    }

    for (const [bucket, bucketScopes] of exactByBucket) {
      await this.removeExactScopes(bucket, bucketScopes);
    }

    for (const scope of prefixes) {
      await this.removePrefixScope(scope);
    }

    return scopes.length;
  }

  async drainSpace(spaceId: string): Promise<number> {
    return this.drainOnce(spaceId);
  }

  private async claimScopes(
    spaceId: string | null,
  ): Promise<SpaceDeletionScope[]> {
    const { data, error } = (await this.client.rpc(
      'claim_space_deletion_scopes',
      {
        p_worker_id: this.workerId,
        p_limit: CLAIM_BATCH_SIZE,
        p_space_id: spaceId,
      },
    )) as {
      data: SpaceDeletionScope[] | null;
      error: { message?: string; code?: string } | null;
    };

    if (!error) return data ?? [];

    const message = error.message ?? 'unknown database error';
    if (
      error.code === 'PGRST202' ||
      error.code === '42883' ||
      /does not exist|could not find the function/i.test(message)
    ) {
      if (!this.rpcMissingLogged) {
        this.logger.warn(
          'Space deletion cleanup RPCs are not installed; cleanup will retry after migrations are applied',
        );
        this.rpcMissingLogged = true;
      }
      return [];
    }

    throw new Error(`Could not claim space storage cleanup work: ${message}`);
  }

  private validateScope(scope: SpaceDeletionScope): string | null {
    if (!SPACE_BUCKETS.has(scope.bucket)) {
      return 'unsafe storage bucket';
    }
    if (scope.kind !== 'exact' && scope.kind !== 'prefix') {
      return 'unsafe storage scope kind';
    }
    if (
      !scope.path ||
      /^\s*$/.test(scope.path) ||
      scope.path.startsWith('/') ||
      /[\0\r\n\\]/.test(scope.path) ||
      /(^|\/)\.\.?(\/|$)/.test(scope.path) ||
      /^[a-z][a-z\d+.-]*:\/\//i.test(scope.path)
    ) {
      return 'unsafe storage path';
    }
    if (
      scope.bucket === 'wiki-attachments' &&
      /^editor-images(?:\/|$)/.test(scope.path)
    ) {
      return 'unsafe storage path: shared editor-images are not space-owned';
    }
    if (scope.kind === 'prefix' && !scope.path.replace(/\/+$/, '')) {
      return 'unsafe storage path: root prefix';
    }
    return null;
  }

  private async removeExactScopes(
    bucket: string,
    scopes: SpaceDeletionScope[],
  ): Promise<void> {
    const storage = this.client.storage.from(bucket);

    for (let index = 0; index < scopes.length; index += STORAGE_BATCH_SIZE) {
      const chunk = scopes.slice(index, index + STORAGE_BATCH_SIZE);
      const { error } = await storage.remove(chunk.map((scope) => scope.path));

      if (error) {
        const message = this.errorMessage(error);
        for (const scope of chunk) await this.release(scope, message);
        continue;
      }

      for (const scope of chunk) await this.complete(scope);
    }
  }

  private async removePrefixScope(scope: SpaceDeletionScope): Promise<void> {
    try {
      await this.removePrefix(
        this.client.storage.from(scope.bucket),
        scope.path.replace(/\/+$/, ''),
      );
      await this.complete(scope);
    } catch (error) {
      await this.release(scope, this.errorMessage(error));
    }
  }

  private async removePrefix(
    storage: StorageClient,
    rootPrefix: string,
  ): Promise<void> {
    const pending = [rootPrefix];

    while (pending.length > 0) {
      const prefix = pending.pop() as string;
      const { data, error } = await storage.list(prefix, {
        limit: STORAGE_BATCH_SIZE,
        offset: 0,
      });
      if (error) throw error;

      const entries = data ?? [];
      if (entries.length === 0) continue;

      const objects: string[] = [];
      const childPrefixes: string[] = [];
      for (const entry of entries) {
        const path = `${prefix}/${entry.name}`;
        if (entry.metadata) objects.push(path);
        else childPrefixes.push(path);
      }

      if (objects.length > 0) {
        const { error: removeError } = await storage.remove(objects);
        if (removeError) throw removeError;
      }

      // Always revisit the current prefix from offset zero after deleting.
      // Offsets would skip entries as the object list shrinks.
      pending.push(prefix, ...childPrefixes);
    }
  }

  private async complete(scope: SpaceDeletionScope): Promise<void> {
    const { error } = (await this.client.rpc('complete_space_deletion_scope', {
      p_scope_id: scope.id,
      p_worker_id: this.workerId,
    })) as { error: { message?: string } | null };

    if (error) await this.release(scope, error.message ?? 'completion failed');
  }

  private async release(
    scope: SpaceDeletionScope,
    message: string,
  ): Promise<void> {
    const { error } = (await this.client.rpc('release_space_deletion_scope', {
      p_scope_id: scope.id,
      p_worker_id: this.workerId,
      p_error: message.slice(0, ERROR_LIMIT),
    })) as { error: { message?: string } | null };

    if (error) {
      this.logger.error(
        `Could not release space cleanup scope ${scope.id}; its lease will expire for retry: ${error.message ?? 'unknown database error'}`,
      );
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : String(error);
  }
}
