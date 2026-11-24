/**
 * @fileoverview `attachments` stage — Jira issue attachments → Supabase Storage + `task_attachments`.
 *
 * This stage was IMPOSSIBLE until now: `IJiraSourceAdapter` carried no `getAttachmentBytes` (only the
 * Confluence surface did), so there was no way to fetch the bytes. That method now exists on
 * `JiraAdapterBase`, origin-pinned against SSRF.
 *
 * 🔴 FAILURES FAIL THE ITEM — they are never swallowed into `skipped`. `page-attachments.stage.ts:272`
 * wraps its whole download+upload in a blanket catch that returns `{kind:'skipped'}`, and a `skipped`
 * item NEVER fails a run: an attachment the target rejects (a `.pptx`, a 20 MB file) vanishes while
 * the run still reports success. That is a confirmed audit finding and this stage does not repeat it.
 * A rejection the operator can act on must be visible as a FAILED item.
 *
 * The target's size limit THROWS, so we pre-check it and name the real reason instead of surfacing
 * a bare 400. There is no longer a TYPE pre-check: task attachments accept every MIME type, so the
 * mirror list this stage used to import is gone. That list was the source of a confirmed data-loss
 * bug — it drifted from the service's copy and rejected live `.zip` and `.json` attachments before
 * the service ever saw them.
 *
 * Bytes are BUFFERED for small files and STREAMED via a temp file above `STREAM_THRESHOLD_BYTES`:
 * on-premise the cap is 5 GB, past Node's ~4 GiB Buffer limit, so large bodies must never touch
 * the heap. One file at a time either way.
 *
 * Attribution: the file is recorded against the ORIGINAL Jira uploader (via the user crosswalk)
 * carrying the ORIGINAL upload date, not the migration actor and not the import time.
 */

import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { Injectable } from '@nestjs/common';
import { normalizeContentType } from '../../../common/upload-mime';
import { storageSafeFileName } from '../../../common/upload-filename';
import { formatMaxUpload, UPLOAD_LIMITS } from '../../../common/upload-limits';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { AtlassianRequestError } from '../../adapters/http/atlassian-http-client';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import type { NormalizedAttachment } from '../../model/normalized';
import { isResolvedStatus } from './crosswalk-gate.util';
import { ISSUE_ENTITY } from './issues.stage';
import { requireActingUser, runScope, scopeIncludes } from './stage-helpers';
import { USER_ENTITY } from './users.stage';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type SeedItem,
  type StageContext,
} from './stage.interface';

export const ATTACHMENTS_STAGE = 'attachments';
export const ATTACHMENT_ENTITY = 'attachment';

/** Mirrors `TaskAttachmentsService.MAX_FILE_SIZE` — pre-checked so the error names the real reason. */
const MAX_FILE_BYTES = UPLOAD_LIMITS.ATTACHMENT;

/**
 * Above this declared size, bytes stream through a temp file instead of the heap — on-premise the
 * cap is 5 GB, past Node's ~4 GiB Buffer limit and far past what concurrent workers can buffer.
 * Files with no declared size fall back to buffered; the HTTP client's declared-length pre-check
 * and byte cap still guard those.
 */
const STREAM_THRESHOLD_BYTES = 64 * 1024 * 1024;

/**
 * The UNIFIED attachment bucket the current app reads from. The legacy `task-attachments` bucket +
 * `task_attachments` table are no longer read by the task UI, so an import into them was invisible.
 */
const ATTACHMENT_BUCKET = 'attachments';

interface AttachmentPayload {
  issueSourceId: string;
  issueKey: string;
  attachment: NormalizedAttachment;
}

/**
 * The origin the SOURCE advertised for this file (Jira `base.url`), which on-premise routinely
 * differs from the connection origin. Recorded so the relink stage can rewrite absolute hrefs on
 * that host too, not only on the connection origin. Empty for relative/malformed URLs.
 */
function sourceOriginMeta(downloadUrl: string): { source_origin?: string } {
  try {
    return { source_origin: new URL(downloadUrl).origin };
  } catch {
    return {};
  }
}

/**
 * `Bildschirmfoto.png` + `79838` → `Bildschirmfoto (79838).png`. Jira allows two different
 * attachments with the SAME filename on one issue; the second must not silently adopt (and lose
 * its bytes to) the first. The Jira attachment id makes the alternate name deterministic, so
 * re-runs converge on it. Extension split mirrors `upload-filename.ts`.
 */
function disambiguateFileName(fileName: string, sourceId: string): string {
  const lastDot = fileName.lastIndexOf('.');
  const hasExtension = lastDot > 0 && lastDot < fileName.length - 1;
  const base = hasExtension ? fileName.slice(0, lastDot) : fileName;
  const extension = hasExtension ? fileName.slice(lastDot) : '';

  return `${base} (${sourceId})${extension}`;
}

@Injectable()
export class AttachmentsStage implements IStageHandler {
  readonly stage = ATTACHMENTS_STAGE;

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** One page of issues per call; seeds one item per attachment. Cursor rides the checkpoint. */
  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'attachments stage: non-Jira source — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    // The admin explicitly excluded this slice — honour it, and say so. Validating a flag and then
    // ignoring it is how a migration quietly does more than the user asked for.
    //
    // `warn`, not `info`, and with a structured `reason`: an `info` log here let the run finalise
    // `succeeded` with no visible trace that attachments were deliberately left out, so an operator
    // saw a clean run and reported "attachments are missing". The monitor renders both channels —
    // the report's `lossy` section reads every `warn`/`error` log's `context.reason`
    // (`migration-report.service.ts` `loadLossy`) and the live log viewer chips `warn` in warning
    // colour (`RunLogViewer.tsx`). This does NOT fail the run: no item is failed, `produce` still
    // completes the collection item as `succeeded`, and the run status is unchanged. Mirrors the
    // non-fatal-but-visible precedent in `verify.stage.ts` `reportSkippedStages` and
    // `page-history.stage.ts` (warn + `{ reason }`).
    if (!scopeIncludes(ctx, 'include_attachments')) {
      await ctx.log(
        'warn',
        'attachments stage: excluded by job scope — seeding 0. ' +
          'Attachments were NOT migrated for this run; this was requested, not a failure.',
        { reason: 'attachments excluded by job scope' },
      );

      return { items: [], nextCheckpoint: null, done: true };
    }

    const checkpoint = collectionItem.checkpoint ?? {};
    const cursor =
      typeof checkpoint.cursor === 'string' ? checkpoint.cursor : null;

    // The issues stage's ISSUE_FIELDS excludes `attachment`; read it here on its own.
    const iterator = adapter.iterateIssues(ctx.job.source_ref, {
      cursor,
      pageSize: 50,
      fields: ['attachment'],
      ...(runScope(ctx).jql ? { jql: runScope(ctx).jql } : {}),
    });
    const first = await iterator.next();

    if (first.done || !first.value) {
      return { items: [], nextCheckpoint: null, done: true };
    }

    const page = first.value;
    const items: SeedItem[] = [];

    for (const issue of page.items) {
      for (const attachment of issue.attachments ?? []) {
        const payload: AttachmentPayload = {
          issueSourceId: issue.sourceId,
          issueKey: issue.key,
          attachment,
        };

        items.push({
          entityType: ATTACHMENT_ENTITY,
          sourceRef: attachment.sourceId,
          payload: payload as unknown as Record<string, unknown>,
        });
      }
    }

    return {
      items,
      nextCheckpoint: page.nextCursor ? { cursor: page.nextCursor } : null,
      done: page.nextCursor === null,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const payload = item.payload as unknown as AttachmentPayload | null;

    if (!payload?.attachment?.sourceId) {
      throw new MigrationItemError(
        'permanent',
        'Attachment item is missing its payload snapshot',
      );
    }

    const { attachment } = payload;
    const existing = await ctx.entityMap.getExistingTarget(
      ctx.orgId,
      ctx.job.connection_id,
      ATTACHMENT_ENTITY,
      attachment.sourceId,
      'file_attachments',
    );

    if (existing?.status === 'mapped') {
      return {
        kind: 'skipped',
        reason: 'attachment already mapped',
        targetId: existing.target_id,
      };
    }

    if (existing?.status === 'planned' && ctx.dryRun) {
      return { kind: 'skipped', reason: 'already planned' };
    }

    const taskRow = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      ISSUE_ENTITY,
      payload.issueSourceId,
    );

    if (!taskRow || !isResolvedStatus(taskRow.status, ctx.dryRun)) {
      return {
        kind: 'blocked',
        waitingFor: {
          entityType: ISSUE_ENTITY,
          sourceId: payload.issueSourceId,
        },
      };
    }

    const mimeType = normalizeContentType(attachment.mimeType);

    // Pre-flight the target's size limit so a rejection names its real reason. This FAILS the item
    // — an attachment the target cannot hold is a migration the operator must know about, not a
    // shrug. Type is no longer pre-checked: every MIME type is accepted.
    if (
      typeof attachment.sizeBytes === 'number' &&
      attachment.sizeBytes > MAX_FILE_BYTES
    ) {
      throw new MigrationItemError(
        'permanent',
        `Attachment "${attachment.filename}" on ${payload.issueKey} is ` +
          `${Math.round(attachment.sizeBytes / 1024 / 1024)} MB, over the ` +
          `${formatMaxUpload(MAX_FILE_BYTES)} task-attachment limit. The file was NOT migrated.`,
      );
    }

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: this.mappingRunId(ctx),
        entityType: ATTACHMENT_ENTITY,
        sourceId: attachment.sourceId,
        sourceKey: `${payload.issueKey}:${attachment.filename}`,
        targetTable: 'file_attachments',
        targetId: `planned:${attachment.filename}`,
        status: 'planned',
        metadata: {
          issue: payload.issueKey,
          filename: attachment.filename,
          mime_type: mimeType,
          size_bytes: attachment.sizeBytes,
        },
      });

      return { kind: 'planned' };
    }

    // A crosswalk can outlive its target (for example, an imported task was later deleted), and
    // the service-role client bypasses RLS. Verify both existence and tenant ownership before any
    // source download or attachment write so this item fails loudly instead of creating an orphan.
    const task = await this.resolveMappedTask(
      ctx,
      taskRow.target_id,
      payload.issueKey,
      attachment.filename,
    );

    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      throw new MigrationItemError(
        'permanent',
        'attachments stage reached processItem with a non-Jira adapter',
      );
    }

    // Download — a transport failure is TRANSIENT (the engine retries with backoff), while a rejected
    // URL is permanent. Never swallow either into `skipped`. Large files stream to a temp file so
    // the body never sits on the heap; small ones keep the buffered path.
    const tmpPath =
      typeof attachment.sizeBytes === 'number' &&
      attachment.sizeBytes > STREAM_THRESHOLD_BYTES
        ? join(tmpdir(), `xisuite-mig-${randomUUID()}`)
        : null;

    try {
      let body: Buffer | { filePath: string };
      let size: number;

      try {
        if (tmpPath) {
          const downloaded = await adapter.getAttachmentBytesToFile(
            attachment.downloadUrl,
            tmpPath,
            MAX_FILE_BYTES,
          );

          body = { filePath: tmpPath };
          size = downloaded.size;
        } else {
          const bytes = await adapter.getAttachmentBytes(
            attachment.downloadUrl,
            MAX_FILE_BYTES,
          );

          body = bytes.data;
          size = bytes.size;
        }
      } catch (err) {
        const message = (err as Error).message;
        // Permanent: a missing download URL, or a file over the byte cap (typed 413 from the HTTP
        // client — never matched by message, "rate limit exceeded" must stay transient). The adapters
        // no longer reject a differing host, they log it and fetch the path from the connection
        // origin (see `jira-adapter.base.ts`).
        const permanent =
          /no download URL/i.test(message) ||
          (err instanceof AtlassianRequestError && err.status === 413);

        throw new MigrationItemError(
          permanent ? 'permanent' : 'transient',
          `Downloading "${attachment.filename}" from ${payload.issueKey} failed: ${message}`,
        );
      }

      // Attribute the file to whoever attached it in Jira, not to whoever ran the import. Falls back
      // to the acting user only when the author cannot be resolved, since `uploaded_by` is NOT NULL.
      const authorId = await this.resolveAuthor(ctx, attachment.authorSourceId);

      if (attachment.authorSourceId && !authorId) {
        await ctx.log(
          'warn',
          `attachments: unmapped author for "${attachment.filename}" on ${payload.issueKey} — ` +
            `recorded against the migration actor`,
          { authorSourceId: attachment.authorSourceId },
        );
      }

      const uploader = authorId ?? requireActingUser(ctx);
      const written = await this.writeUnifiedAttachment(ctx, {
        taskId: taskRow.target_id,
        spaceId: task.space_id,
        fileName: attachment.filename,
        mimeType,
        sourceId: attachment.sourceId,
        body,
        size,
        uploader,
        created: attachment.created ?? null,
      });

      try {
        await ctx.entityMap.recordMapping({
          orgId: ctx.orgId,
          connectionId: ctx.job.connection_id,
          jobId: ctx.job.id,
          runId: this.mappingRunId(ctx),
          entityType: ATTACHMENT_ENTITY,
          sourceId: attachment.sourceId,
          sourceKey: `${payload.issueKey}:${attachment.filename}`,
          targetTable: 'file_attachments',
          targetId: written.id,
          status: 'mapped',
          metadata: {
            issue: payload.issueKey,
            filename: attachment.filename,
            mime_type: mimeType,
            size_bytes: size,
            ...sourceOriginMeta(attachment.downloadUrl),
          },
        });
      } catch (err) {
        // An adopted row belongs to an earlier successful write and may be a real user file. Only
        // compensate the storage/version/header this attempt created.
        if (written.created) {
          const cleanupFailures = await this.cleanupCreatedAttachment(
            written.id,
            written.storagePath,
          );

          if (cleanupFailures.length > 0) {
            throw new MigrationItemError(
              'transient',
              `Recording attachment mapping failed for "${attachment.filename}": ${
                err instanceof Error ? err.message : 'unknown error'
              }. Cleanup incomplete: ${cleanupFailures.join('; ')}`,
            );
          }
        }

        throw err;
      }

      return {
        kind: 'created',
        targetId: written.id,
        targetTable: 'file_attachments',
      };
    } finally {
      // The HTTP client deletes the temp file on ITS failures; this covers upload/insert failures
      // and success. A missing file is fine.
      if (tmpPath) await unlink(tmpPath).catch(() => undefined);
    }
  }

  /**
   * Write the attachment into the UNIFIED model the task UI actually reads: a `file_attachments`
   * row + its first `file_versions` row, with the bytes in the `attachments` bucket. The old path
   * wrote the legacy `task_attachments` table, which the current UI never queries, so imported files
   * were invisible. Preserves the Jira upload date and the original author, and is idempotent: a
   * re-run that hits the per-(entity,file_name) unique index ADOPTS the existing row rather than
   * duplicating it.
   */
  private async writeUnifiedAttachment(
    ctx: StageContext,
    a: {
      taskId: string;
      spaceId: string | null;
      fileName: string;
      mimeType: string;
      /** The Jira attachment id — tells "same file, re-run" apart from "different file, same name". */
      sourceId: string;
      /** In-memory bytes for small files; a temp-file handle for streamed large ones. */
      body: Buffer | { filePath: string };
      size: number;
      uploader: string;
      created: string | null;
    },
  ): Promise<{
    id: string;
    created: boolean;
    storagePath?: string;
  }> {
    const db = this.db;
    const when = a.created ?? new Date().toISOString();

    const row = await this.insertOrAdoptRow(ctx, a, a.spaceId, when);

    // Adopted = this exact source attachment was written by a prior run; bytes already stored.
    if (row.adopted) return { id: row.id, created: false };

    const attachmentId = row.id;
    // Sanitised: the same non-ASCII key rejection that broke manual task
    // uploads applies here, and an importer is MORE likely to hit it, since a
    // Confluence or Jira export from a German or French tenant is full of
    // accented filenames. Failing here loses an attachment during a migration,
    // where nobody is watching a progress bar for one file.
    const storagePath = `${ctx.orgId}/task/${a.taskId}/${attachmentId}/v1/${storageSafeFileName(row.fileName)}`;

    // A streamed body uses the same pattern as `restore-archive-cache.service.ts`: a web
    // ReadableStream over the temp file with `duplex: 'half'` (required by fetch for stream
    // bodies). Buffers upload as before.
    const { error: uploadError } = await db.storage
      .from(ATTACHMENT_BUCKET)
      .upload(
        storagePath,
        Buffer.isBuffer(a.body)
          ? a.body
          : (Readable.toWeb(
              createReadStream(a.body.filePath),
            ) as ReadableStream),
        {
          contentType: a.mimeType,
          upsert: false,
          ...(Buffer.isBuffer(a.body) ? {} : { duplex: 'half' }),
        } as never,
      )
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          /invalid content-type/i.test(error.message)
        )
          return { error };
        throw error;
      });

    if (uploadError) {
      const cleanupFailures = await this.cleanupCreatedAttachment(
        attachmentId,
        storagePath,
      );

      throw new MigrationItemError(
        /invalid content-type/i.test(uploadError.message)
          ? 'permanent'
          : 'transient',
        `Attachment upload to storage failed for "${a.fileName}": ${uploadError.message}${
          cleanupFailures.length > 0
            ? `. Cleanup incomplete: ${cleanupFailures.join('; ')}`
            : ''
        }`,
      );
    }

    const version = (await db
      .from('file_versions')
      .insert({
        attachment_id: attachmentId,
        version_number: 1,
        file_path: storagePath,
        file_size: a.size,
        mime_type: a.mimeType,
        uploaded_by: a.uploader,
        uploaded_at: when,
        comment: null,
      })
      .select('id')
      .single()) as {
      data: { id: string } | null;
      error: { message: string } | null;
    };

    if (version.error || !version.data) {
      const cleanupFailures = await this.cleanupCreatedAttachment(
        attachmentId,
        storagePath,
      );

      throw new MigrationItemError(
        'transient',
        `file_versions insert failed for "${a.fileName}": ${version.error?.message ?? 'no row returned'}${
          cleanupFailures.length > 0
            ? `. Cleanup incomplete: ${cleanupFailures.join('; ')}`
            : ''
        }`,
      );
    }

    const { error: linkError } = await db
      .from('file_attachments')
      .update({ current_version_id: version.data.id })
      .eq('id', attachmentId);

    if (linkError) {
      const cleanupFailures = await this.cleanupCreatedAttachment(
        attachmentId,
        storagePath,
      );

      throw new MigrationItemError(
        'transient',
        `Linking current version failed for "${a.fileName}": ${linkError.message}${
          cleanupFailures.length > 0
            ? `. Cleanup incomplete: ${cleanupFailures.join('; ')}`
            : ''
        }`,
      );
    }

    return { id: attachmentId, created: true, storagePath };
  }

  /** Best-effort compensation for an attachment header created by THIS attempt only. */
  private async cleanupCreatedAttachment(
    attachmentId: string,
    storagePath?: string,
  ): Promise<string[]> {
    const db = this.db;
    const failures: string[] = [];

    if (storagePath) {
      try {
        const { error } = await db.storage
          .from(ATTACHMENT_BUCKET)
          .remove([storagePath]);
        if (error) failures.push(`storage object: ${error.message}`);
      } catch {
        failures.push('storage object: request failed');
      }
    }

    // Delete explicitly before the header (whose FK also cascades versions) so this remains correct
    // if the schema changes its cascade rule. All cleanup is keyed to the freshly inserted header.
    try {
      const { error } = await db
        .from('file_versions')
        .delete()
        .eq('attachment_id', attachmentId);
      if (error) failures.push(`file version: ${error.message}`);
    } catch {
      failures.push('file version: request failed');
    }
    try {
      const { error } = await db
        .from('file_attachments')
        .delete()
        .eq('id', attachmentId);
      if (error) failures.push(`attachment row: ${error.message}`);
    } catch {
      failures.push('attachment row: request failed');
    }

    return failures;
  }

  /** Read a mapped task under the run organization; mappings alone are not proof it is still live. */
  private async resolveMappedTask(
    ctx: StageContext,
    taskId: string,
    issueKey: string,
    filename: string,
  ): Promise<{ id: string; space_id: string | null }> {
    const { data, error } = (await this.db
      .from('tasks')
      .select('id, space_id')
      .eq('id', taskId)
      .eq('organization_id', ctx.orgId)
      .maybeSingle()) as {
      data: { id: string; space_id: string | null } | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Looking up mapped task for attachment "${filename}" on ${issueKey} failed: ${error.message}`,
      );
    }

    if (!data) {
      throw new MigrationItemError(
        'permanent',
        `Attachment "${filename}" on ${issueKey} cannot be migrated because its mapped target task no longer exists in this organization.`,
      );
    }

    return data;
  }

  /**
   * Insert the `file_attachments` row, or ADOPT the existing one ONLY when the crosswalk proves it
   * is THIS source attachment (an idempotent re-run). A name collision with a DIFFERENT source
   * attachment — Jira allows two files with the same name on one issue — retries once under the
   * deterministic disambiguated name instead. The old unconditional adopt silently threw the
   * second file's bytes away while the run reported success (confirmed data loss). Ambiguity
   * (no crosswalk row) also disambiguates: a duplicate row is cosmetic, lost bytes are not.
   */
  private async insertOrAdoptRow(
    ctx: StageContext,
    a: { taskId: string; fileName: string; sourceId: string; uploader: string },
    spaceId: string | null,
    when: string,
  ): Promise<{ id: string; fileName: string; adopted: boolean }> {
    const db = this.db;
    const candidates = [
      a.fileName,
      disambiguateFileName(a.fileName, a.sourceId),
    ];

    for (const fileName of candidates) {
      const insert = (await db
        .from('file_attachments')
        .insert({
          organization_id: ctx.orgId,
          space_id: spaceId,
          entity_type: 'task',
          entity_id: a.taskId,
          file_name: fileName,
          created_by: a.uploader,
          created_at: when,
          updated_at: when,
        })
        .select('id')
        .single()) as {
        data: { id: string } | null;
        error: { message: string; code?: string } | null;
      };

      if (insert.data && !insert.error) {
        return { id: insert.data.id, fileName, adopted: false };
      }

      if (insert.error?.code !== '23505') {
        throw new MigrationItemError(
          'transient',
          `file_attachments insert failed for "${fileName}": ${insert.error?.message ?? 'no row returned'}`,
        );
      }

      const { data: existing } = (await db
        .from('file_attachments')
        .select('id')
        .eq('organization_id', ctx.orgId)
        .eq('entity_type', 'task')
        .eq('entity_id', a.taskId)
        .eq('file_name', fileName)
        .maybeSingle()) as { data: { id: string } | null };

      // The colliding row vanished between insert and lookup — let the engine retry the item.
      if (!existing) {
        throw new MigrationItemError(
          'transient',
          `file_attachments name collision for "${fileName}" but the owning row was not found`,
        );
      }

      if (await this.crosswalkOwnsTarget(ctx, existing.id, a.sourceId)) {
        return { id: existing.id, fileName, adopted: true };
      }
      // Owned by a different source attachment (or unprovable) — fall through to the next name.
    }

    throw new MigrationItemError(
      'transient',
      `Both "${a.fileName}" and its disambiguated name are taken by other attachments on this task`,
    );
  }

  /** True when the crosswalk says `targetId` was written FOR `sourceId` on this connection. */
  private async crosswalkOwnsTarget(
    ctx: StageContext,
    targetId: string,
    sourceId: string,
  ): Promise<boolean> {
    // Not maybeSingle(): the pre-fix data-loss bug could leave several source ids pointing at one
    // target, and a multi-row result must not throw here.
    const { data, error } = (await this.db
      .from('migration_entity_map')
      .select('source_id')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('entity_type', ATTACHMENT_ENTITY)
      .eq('target_table', 'file_attachments')
      .eq('target_id', targetId)
      .limit(50)) as {
      data: { source_id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Failed to read the attachment crosswalk for adoption: ${error.message}`,
      );
    }

    return (data ?? []).some((r) => r.source_id === sourceId);
  }

  /**
   * A repair run repairs the completed import's mappings, never an unrelated earlier run. Must
   * match `jira-attachment-relink.stage.ts` — relink reads the crosswalk by this run id, so an
   * attachment downloaded DURING a repair run must be recorded under the run being repaired or
   * relink cannot see it.
   */
  private mappingRunId(ctx: StageContext): string {
    const repairOf = ctx.run.config_snapshot?.repair_of_run_id;

    return typeof repairOf === 'string' && repairOf ? repairOf : ctx.run.id;
  }

  /**
   * The mapped/placeholder user id for the Jira uploader, or null (never blocks).
   *
   * Attribution is best-effort by design: losing a FILE because its uploader could not be resolved
   * would be far worse than losing the uploader's name. `placeholder` counts as resolved, which is
   * exactly what placeholders exist for.
   */
  private async resolveAuthor(
    ctx: StageContext,
    authorSourceId: string | undefined,
  ): Promise<string | null> {
    if (!authorSourceId) return null;

    const row = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      USER_ENTITY,
      authorSourceId,
    );

    if (!row || !isResolvedStatus(row.status, ctx.dryRun)) return null;

    // A dry-run `planned` row's target_id is a marker, not a real user id.
    if (row.status === 'planned') return null;

    return row.target_id;
  }
}
