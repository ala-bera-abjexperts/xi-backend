/**
 * @fileoverview `page_attachments` stage — streams Confluence page attachments into Supabase
 * Storage and re-renders the owning page so inline `[Image: filename]` placeholders become
 * resolved `<img>` tags (the two-pass that keeps the no-dangling-reference invariant).
 *
 * Producer: enumerates migrated pages (crosswalk `page` rows), fetches each page's attachments,
 * and seeds one item per attachment (natural key `${pageSourceId}:${filename}`). A page whose
 * attachment list cannot be fetched seeds an explicit FAILED marker item, so the loss is visible
 * in the run monitor instead of silently omitting every file.
 *
 * Failures are LOUD, mirroring `attachments.stage.ts`: an oversize or rejected file fails its
 * item permanently and a transport error fails it transiently (engine retry). Nothing here
 * degrades to `skipped` — a run that ends green must mean every attachment was migrated or the
 * operator already saw why not.
 */

import { confluenceSourcePageUrl } from '../../mappers/page.mapper';
import { Injectable } from '@nestjs/common';
import { WikiService } from '../../../wiki/wiki.service';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { UPLOAD_LIMITS } from '../../../common/upload-limits';
import { hasOfficeDocumentExtension } from '../../../common/upload-mime';
import {
  isConfluenceAdapter,
  type IConfluenceSourceAdapter,
} from '../../adapters/source-adapter.interface';
import type { NormalizedAttachment } from '../../model/normalized';
import { ContentTransformService } from '../../transformers/content-transform.service';
import { diagramFetcher } from '../../transformers/diagram-source';
import {
  isLegacyWordDocument,
  LegacyWordPreviewService,
} from '../../services/legacy-word-preview.service';
import { PAGE_ENTITY } from '../../mappers/page.mapper';
import {
  requireActingUser,
  resolveTargetSpace,
  runOptions,
  scopeIncludes,
} from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type SeedItem,
  type StageContext,
} from './stage.interface';

export const PAGE_ATTACHMENTS_STAGE = 'page_attachments';
export const PAGE_ATTACHMENT_ENTITY = 'page_attachment';

const PAGE_BATCH = 25;

/** sourceRef suffix for the marker item seeded when a page's attachment list fails. */
const LISTING_FAILED_MARKER = ':listing-failed';
const SOURCE_CREATED_DATE_METADATA = 'source_created_date';
const SOURCE_ATTACHMENT_ID_METADATA = 'source_attachment_id';
const MIME_RECONCILED_METADATA = 'mime_reconciled';

/**
 * Same cap `WikiService.createAttachment` enforces; pre-flight so rejections name the real reason.
 * ponytail: capped at 2 GB — this path buffers (`createAttachment` takes a Multer `.buffer`), so it
 * cannot serve the full 5 GB on-prem allowance; stream WikiService uploads to lift the ceiling.
 */
const MAX_FILE_BYTES = Math.min(
  UPLOAD_LIMITS.ATTACHMENT,
  2 * 1024 * 1024 * 1024,
);

interface AttachmentPayload {
  attachment: NormalizedAttachment;
  pageSourceId: string;
}

/**
 * Confluence supplies an ISO timestamp. The attachment list only has a date column, so retain the
 * source calendar day rather than letting a viewer's timezone turn it into the previous/next day.
 */
export function canonicalSourceAttachmentDate(
  value: string | undefined,
): string | null {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}(?:T|\s|$)/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return null;
  }

  const date = value.slice(0, 10);
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return `${date}T00:00:00.000Z`;
}

@Injectable()
export class PageAttachmentsStage implements IStageHandler {
  readonly stage = PAGE_ATTACHMENTS_STAGE;

  constructor(
    private readonly wiki: WikiService,
    private readonly content: ContentTransformService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly legacyWordPreview: LegacyWordPreviewService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * A repair run repairs the completed import's mappings, never an unrelated earlier run. Must
   * match `confluence-page-repair.stage.ts`'s reads — an attachment stored DURING a repair run
   * has to be recorded under the run being repaired or the repair stages cannot see it.
   */
  private mappingRunId(ctx: StageContext): string {
    const repairOf = ctx.run.config_snapshot?.repair_of_run_id;

    return typeof repairOf === 'string' && repairOf ? repairOf : ctx.run.id;
  }

  private isRepairRun(ctx: StageContext): boolean {
    return this.mappingRunId(ctx) !== ctx.run.id;
  }

  private async recordAttachmentMapping(
    ctx: StageContext,
    attachment: NormalizedAttachment,
    pageSourceId: string,
    naturalKey: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: this.mappingRunId(ctx),
      entityType: PAGE_ATTACHMENT_ENTITY,
      sourceId: naturalKey,
      sourceKey: attachment.filename,
      targetTable: 'wiki_page_attachments',
      targetId,
      status: 'mapped',
      metadata: {
        ...metadata,
        filename: attachment.filename,
        page_source_id: pageSourceId,
        // The crosswalk key is `${pageSourceId}:${filename}`, which the version endpoints cannot
        // be queried with. Recording the real source attachment id is what lets the history stage
        // ask for this attachment's earlier versions at all.
        [SOURCE_ATTACHMENT_ID_METADATA]: attachment.sourceId,
      },
    });
  }

  /** Page through migrated pages (offset cursor), seeding attachment items per page. */
  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isConfluenceAdapter(adapter)) {
      throw new MigrationItemError(
        'permanent',
        'The page-attachments stage requires a Confluence connection',
      );
    }

    // Every other attachment-bearing stage gates on this; without it, unticking "attachments" in the
    // job scope still downloaded and stored all 281 files.
    if (!scopeIncludes(ctx, 'include_attachments')) {
      await ctx.log(
        'info',
        'page-attachments stage: excluded by job scope — seeding 0',
      );

      return { items: [], nextCheckpoint: null, done: true };
    }

    const checkpoint = (collectionItem.checkpoint ?? {}) as { offset?: number };
    const offset =
      typeof checkpoint.offset === 'number' ? checkpoint.offset : 0;

    // Scope to THIS space (RISK A: never enumerate another space's pages migrated on
    // the same connection) and, in a dry-run, also enumerate `planned` pages — a dry-run
    // records pages as `planned`, not `mapped`, so without this the plan would silently
    // omit every attachment (RISK B).
    const pageStatuses = ctx.dryRun ? ['mapped', 'planned'] : ['mapped'];

    const { data: pages, error } = (await this.db
      .from('migration_entity_map')
      .select('source_id')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('entity_type', PAGE_ENTITY)
      .filter('metadata->>space_ref', 'eq', ctx.job.source_ref)
      // Folder containers have no content. `neq` alone would also drop rows WITHOUT the key.
      .or('metadata->>is_folder.is.null,metadata->>is_folder.neq.true')
      .in('status', pageStatuses)
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE_BATCH - 1)) as {
      data: { source_id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Failed to enumerate migrated pages: ${error.message}`,
      );
    }

    if (!pages || pages.length === 0) {
      return { items: [], nextCheckpoint: null, done: true };
    }

    const seeds: SeedItem[] = [];

    for (const page of pages) {
      let attachments: NormalizedAttachment[] = [];

      try {
        attachments = await adapter.getPageAttachments(page.source_id);
      } catch (err) {
        // Seed an explicit marker item so the failed listing shows up as a
        // FAILED row in the run monitor. Silently `continue`-ing here once
        // dropped a whole page's attachments while the run stayed green.
        await ctx.log(
          'warn',
          `Could not list attachments for page ${page.source_id} — seeding a failure marker`,
          {
            error: (err as Error).message,
          },
        );

        seeds.push({
          entityType: PAGE_ATTACHMENT_ENTITY,
          sourceRef: `${page.source_id}:${LISTING_FAILED_MARKER}`,
          payload: {
            listError: (err as Error).message,
            pageSourceId: page.source_id,
          } as unknown as Record<string, unknown>,
        });

        continue;
      }

      for (const attachment of attachments) {
        seeds.push({
          entityType: PAGE_ATTACHMENT_ENTITY,
          sourceRef: `${page.source_id}:${attachment.filename}`,
          payload: {
            attachment,
            pageSourceId: page.source_id,
          } as unknown as Record<string, unknown>,
        });
      }
    }

    const done = pages.length < PAGE_BATCH;

    await ctx.log(
      'info',
      `page_attachments: seeded ${seeds.length} from ${pages.length} page(s)`,
      {
        count: seeds.length,
      },
    );

    return {
      items: seeds,
      nextCheckpoint: done ? null : { offset: offset + pages.length },
      done,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const payload = item.payload as unknown as
      | (AttachmentPayload & { listError?: string })
      | null;

    if (!payload?.pageSourceId) {
      throw new MigrationItemError(
        'permanent',
        'Attachment item is missing its snapshot',
      );
    }

    // A listing-failure marker: the page's attachments could not be enumerated.
    // Fail loudly so the operator sees exactly which page lost its files.
    if (payload.listError) {
      throw new MigrationItemError(
        'permanent',
        `Attachments of page ${payload.pageSourceId} could not be listed: ${payload.listError}`,
      );
    }

    if (!payload.attachment) {
      throw new MigrationItemError(
        'permanent',
        'Attachment item is missing its snapshot',
      );
    }

    const { attachment, pageSourceId } = payload;
    const naturalKey = `${pageSourceId}:${attachment.filename}`;
    const sourceCreatedAt = canonicalSourceAttachmentDate(attachment.created);

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen) {
      return {
        kind: 'blocked',
        waitingFor: { entityType: 'space', sourceId: ctx.job.source_ref },
      };
    }

    // Cross-entity gate: the owning page must be migrated first (stage ordering guarantees it,
    // but a re-lease before pages finish would land here → block, never a dangling attachment).
    const pageRow = ctx.dryRun
      ? await ctx.entityMap.getTarget(
          ctx.orgId,
          ctx.job.connection_id,
          PAGE_ENTITY,
          pageSourceId,
        )
      : await ctx.entityMap.getExistingWikiPageTarget(
          ctx.orgId,
          ctx.job.connection_id,
          pageSourceId,
          spaceId!,
        );

    if (!pageRow || pageRow.status !== 'mapped') {
      if (ctx.dryRun && pageRow?.status === 'planned') {
        // dry-run: record the plan, no upload.
      } else {
        return {
          kind: 'blocked',
          waitingFor: { entityType: PAGE_ENTITY, sourceId: pageSourceId },
        };
      }
    }

    const existing =
      ctx.dryRun || !pageRow?.target_id
        ? await ctx.entityMap.getTarget(
            ctx.orgId,
            ctx.job.connection_id,
            PAGE_ATTACHMENT_ENTITY,
            naturalKey,
          )
        : await ctx.entityMap.getExistingWikiChildTarget(
            ctx.orgId,
            ctx.job.connection_id,
            PAGE_ATTACHMENT_ENTITY,
            naturalKey,
            'wiki_page_attachments',
            pageRow.target_id,
          );

    if (!ctx.dryRun && existing === null && pageRow?.target_id) {
      const mapped = await ctx.entityMap.getTarget(
        ctx.orgId,
        ctx.job.connection_id,
        PAGE_ATTACHMENT_ENTITY,
        naturalKey,
      );

      if (mapped?.status === 'mapped' && mapped.target_id) {
        await ctx.entityMap.deleteExactStaleMapping(
          ctx.orgId,
          ctx.job.connection_id,
          PAGE_ATTACHMENT_ENTITY,
          naturalKey,
          mapped.target_id,
        );
      }
    }

    // Pre-flight the size limit so a rejection names its real reason. This FAILS the item — an
    // attachment the target cannot hold is a migration the operator must know about.
    if (
      typeof attachment.sizeBytes === 'number' &&
      attachment.sizeBytes > MAX_FILE_BYTES
    ) {
      throw new MigrationItemError(
        'permanent',
        `Attachment "${attachment.filename}" on page ${pageSourceId} is ` +
          `${Math.round(attachment.sizeBytes / 1024 / 1024)} MB, over the ` +
          `${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB wiki-attachment limit. The file was NOT migrated.`,
      );
    }

    if (existing?.status === 'mapped') {
      if (!this.isRepairRun(ctx)) {
        const adapter = await ctx.getAdapter();
        if (!isConfluenceAdapter(adapter)) {
          throw new MigrationItemError(
            'permanent',
            'Adapter has no Confluence read surface',
          );
        }
        await this.rerenderPage(
          ctx,
          adapter,
          pageSourceId,
          pageRow.target_id,
          spaceId!,
          pageRow,
          requireActingUser(ctx),
          attachment.filename,
        );
        return {
          kind: 'skipped',
          reason: 'attachment already migrated and page relinked',
          targetId: existing.target_id,
        };
      }

      // Attachments imported before the history stage existed carry no source attachment id, so
      // their version history is unreachable. Backfilling it here is metadata-only: it never
      // re-downloads a binary and never touches the stored file.
      const needsSourceId =
        !existing.metadata?.[SOURCE_ATTACHMENT_ID_METADATA] &&
        Boolean(attachment.sourceId);

      // Attachments migrated before the extension-based MIME guard existed can carry a wrong
      // member of the Office family (real-world Confluence served every .docx as the .dotx
      // template type). Reclassifying rewrites the DB row and the storage object metadata.
      const mimeRepairCandidate =
        hasOfficeDocumentExtension(attachment.filename) &&
        !existing.metadata?.[MIME_RECONCILED_METADATA];

      if (
        ctx.dryRun ||
        (!sourceCreatedAt && !needsSourceId && !mimeRepairCandidate)
      ) {
        return {
          kind: 'skipped',
          reason: sourceCreatedAt
            ? 'attachment already migrated'
            : 'attachment has no usable source date',
          targetId: existing.target_id,
        };
      }

      if (
        !needsSourceId &&
        !mimeRepairCandidate &&
        existing.metadata?.[SOURCE_CREATED_DATE_METADATA] === sourceCreatedAt
      ) {
        return {
          kind: 'skipped',
          reason: 'attachment source date already repaired',
          targetId: existing.target_id,
        };
      }

      const wikiPageId = pageRow.target_id;
      const currentCreatedAt = sourceCreatedAt
        ? await this.wiki.getAttachmentCreatedAt(
            wikiPageId,
            spaceId!,
            existing.target_id,
          )
        : undefined;

      if (
        sourceCreatedAt &&
        canonicalSourceAttachmentDate(currentCreatedAt) !== sourceCreatedAt
      ) {
        await this.wiki.updateAttachmentCreatedAt(
          wikiPageId,
          spaceId!,
          existing.target_id,
          sourceCreatedAt,
        );
      }

      if (mimeRepairCandidate) {
        await this.wiki.repairAttachmentContentType(
          wikiPageId,
          spaceId!,
          existing.target_id,
          attachment.filename,
        );
      }

      await this.recordAttachmentMapping(
        ctx,
        attachment,
        pageSourceId,
        naturalKey,
        existing.target_id,
        {
          ...existing.metadata,
          ...(sourceCreatedAt
            ? { [SOURCE_CREATED_DATE_METADATA]: sourceCreatedAt }
            : {}),
          ...(mimeRepairCandidate ? { [MIME_RECONCILED_METADATA]: true } : {}),
        },
      );

      return {
        kind: 'updated',
        targetId: existing.target_id,
        targetTable: 'wiki_page_attachments',
      };
    }

    if (existing?.status === 'planned' && ctx.dryRun) {
      return {
        kind: 'skipped',
        reason: 'already planned',
        targetId: existing.target_id,
      };
    }

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: this.mappingRunId(ctx),
        entityType: PAGE_ATTACHMENT_ENTITY,
        sourceId: naturalKey,
        sourceKey: attachment.filename,
        targetTable: 'wiki_page_attachments',
        targetId: `planned:${naturalKey}`,
        status: 'planned',
        metadata: {
          filename: attachment.filename,
          page_source_id: pageSourceId,
          ...(sourceCreatedAt
            ? { [SOURCE_CREATED_DATE_METADATA]: sourceCreatedAt }
            : {}),
        },
      });

      return { kind: 'planned' };
    }

    const wikiPageId = pageRow.target_id;
    const actingUser = requireActingUser(ctx);
    const adapter = await ctx.getAdapter();

    if (!isConfluenceAdapter(adapter)) {
      throw new MigrationItemError(
        'permanent',
        'Adapter has no Confluence read surface',
      );
    }

    // Download (size-capped) → upload via WikiService (MIME-validated). Failures are LOUD:
    // permanent for a file the target refuses, transient for transport errors so the engine
    // retries. Never swallowed into `skipped`.
    let uploaded: {
      id: string;
      file_path: string;
      preview_file_path?: string | null;
    };

    try {
      const bytes = await adapter.getAttachmentBytes(
        attachment.downloadUrl,
        MAX_FILE_BYTES,
      );
      const file = {
        buffer: bytes.data,
        originalname: attachment.filename,
        mimetype:
          attachment.mimeType ??
          bytes.contentType ??
          'application/octet-stream',
        size: bytes.size,
        fieldname: 'file',
        encoding: '7bit',
      } as unknown as Parameters<WikiService['createAttachment']>[2];
      const preview = isLegacyWordDocument(attachment.filename)
        ? {
            buffer: await this.legacyWordPreview.convert(bytes.data),
            mimeType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            filename: `${attachment.filename.slice(0, -4)}.docx`,
          }
        : undefined;

      uploaded = (await (preview
        ? this.wiki.createAttachment(
            wikiPageId,
            spaceId!,
            file,
            actingUser,
            sourceCreatedAt ?? undefined,
            preview,
          )
        : this.wiki.createAttachment(
            wikiPageId,
            spaceId!,
            file,
            actingUser,
            sourceCreatedAt ?? undefined,
          ))) as { id: string; file_path: string };
    } catch (err) {
      const message = (err as Error).message;
      // A file the target refuses (oversize that slipped past the pre-flight, blocked MIME) or a
      // blank download URL (`confluence-adapter.base.ts` throws before any request) will fail
      // again on every retry → permanent. Anything else is worth a retry.
      const permanent =
        /\b413\b|too large|exceeds|limit|invalid content-type|mime|blocked|not allowed|unsupported|no download URL|legacy word.*(?:invalid|unavailable|produced)/i.test(
          message,
        );

      throw new MigrationItemError(
        permanent ? 'permanent' : 'transient',
        `Attachment "${attachment.filename}" on page ${pageSourceId} failed: ${message}`,
      );
    }

    try {
      await this.recordAttachmentMapping(
        ctx,
        attachment,
        pageSourceId,
        naturalKey,
        uploaded.id,
        {
          // The Media Services id an ADF `media` node references as `attrs.id`. Stored so the content
          // transformer can resolve UUID-keyed images, which is how EVERY Cloud page embeds a file.
          ...(attachment.fileId ? { file_id: attachment.fileId } : {}),
          url: uploaded.file_path,
          ...(uploaded.preview_file_path
            ? { preview_url: uploaded.preview_file_path }
            : {}),
          ...(sourceCreatedAt
            ? { [SOURCE_CREATED_DATE_METADATA]: sourceCreatedAt }
            : {}),
        },
      );
    } catch (error) {
      try {
        await this.wiki.deleteAttachment(uploaded.id, wikiPageId);
      } catch (cleanupError) {
        await ctx.log(
          'error',
          'Could not compensate attachment after crosswalk failure',
          {
            attachmentId: uploaded.id,
            error: (cleanupError as Error).message,
          },
        );
      }
      throw error;
    }

    // Re-render the owning page so its inline image resolves to the migrated URL.
    await this.rerenderPage(
      ctx,
      adapter,
      pageSourceId,
      wikiPageId,
      spaceId!,
      pageRow,
      actingUser,
      attachment.filename,
    );

    return {
      kind: 'created',
      targetId: uploaded.id,
      targetTable: 'wiki_page_attachments',
    };
  }

  /** Re-fetch + re-transform the page body (attachment crosswalk now resolves) and update it. */
  private async rerenderPage(
    ctx: StageContext,
    adapter: IConfluenceSourceAdapter,
    pageSourceId: string,
    wikiPageId: string,
    spaceId: string,
    pageRow: { metadata: Record<string, unknown> },
    actingUser: string,
    expectedFilename: string,
  ): Promise<void> {
    try {
      const format =
        pageRow.metadata?.body_format === 'atlas_doc_format'
          ? 'atlas_doc_format'
          : 'storage';
      const body = await adapter.getPageBody(pageSourceId, format);
      const sourceBaseUrl = await ctx.getSourceBaseUrl?.();
      // Must match what `page.mapper` wrote (tiptap). Re-rendering as HTML here would silently
      // downgrade the page on its first attachment and undo the native-editing guarantee.
      const rendered = await this.content.renderBodyAsTipTap(body, {
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        pageSourceId,
        targetSpaceId: spaceId,
        macroStrategy: runOptions(ctx).macro_strategy,
        sourceBaseUrl: sourceBaseUrl ?? undefined,
        sourcePageUrl: confluenceSourcePageUrl(
          sourceBaseUrl,
          pageSourceId,
          adapter.deployment === 'cloud',
        ),
        fetchDiagram: diagramFetcher(adapter, pageSourceId),
        log: (message, meta) => void ctx.log('warn', message, meta),
      });
      const excerptContent = await this.content.renderExcerptAsTipTap(body, {
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        pageSourceId,
        targetSpaceId: spaceId,
        macroStrategy: runOptions(ctx).macro_strategy,
        sourceBaseUrl: sourceBaseUrl ?? undefined,
        sourcePageUrl: confluenceSourcePageUrl(
          sourceBaseUrl,
          pageSourceId,
          adapter.deployment === 'cloud',
        ),
        fetchDiagram: diagramFetcher(adapter, pageSourceId),
        log: (message, meta) => void ctx.log('warn', message, meta),
      });

      // The re-render runs once per ATTACHMENT, so a page with N files re-renders N times. Most of
      // those writes change nothing (only an attachment the body actually embeds moves the needle),
      // and each one otherwise costs a full `updatePage`: re-sanitize, recompute `content_text`, and
      // the collab-session gate. Measured on the customer's space, 175 of 268 re-renders were no-ops.
      //
      // This does NOT save version rows — `handle_wiki_page_versioning` already guards on
      // `OLD.content IS DISTINCT FROM NEW.content`, so an unchanged write was never versioned. And
      // the remaining writes are NOT waste: attachment k's URL only exists once k is stored, so each
      // embedded attachment genuinely changes the body. Collapsing those would need all of a page's
      // attachments stored before a single re-render.
      //
      // `content` is a `text` column, so comparing the serialized string is exact.
      const { data: current } = (await this.db
        .from('wiki_pages')
        .select('content')
        .eq('organization_id', ctx.orgId)
        .eq('id', wikiPageId)
        .maybeSingle()) as { data: { content: string | null } | null };

      if (rendered.unresolvedAttachmentRefs.includes(expectedFilename)) {
        throw new MigrationItemError(
          'transient',
          `Attachment "${expectedFilename}" was stored but remains unresolved in page ${pageSourceId}`,
        );
      }

      if (current?.content === rendered.content) return;

      await this.wiki.updatePage(
        wikiPageId,
        spaceId,
        { content: rendered.content, content_format: 'tiptap' },
        actingUser,
      );

      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: this.mappingRunId(ctx),
        entityType: PAGE_ENTITY,
        sourceId: pageSourceId,
        sourceKey:
          typeof pageRow.metadata?.title === 'string'
            ? pageRow.metadata.title
            : null,
        targetTable: 'wiki_pages',
        targetId: wikiPageId,
        status: 'mapped',
        metadata: {
          ...pageRow.metadata,
          ...(excerptContent ? { excerpt_content: excerptContent } : {}),
        },
      });
    } catch (err) {
      await ctx.log(
        'warn',
        `Re-render after attachment failed for page ${pageSourceId}`,
        {
          error: (err as Error).message,
        },
      );
      if (err instanceof MigrationItemError) throw err;
      throw new MigrationItemError(
        'transient',
        `Attachment "${expectedFilename}" could not relink in page ${pageSourceId}: ${(err as Error).message}`,
      );
    }
  }
}
