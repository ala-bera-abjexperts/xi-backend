/**
 * @fileoverview Confluence revision history: every page revision and every attachment version the
 * source will actually give us.
 *
 * WHY THIS IS A SEPARATE STAGE. `pages` imports the current body and `page_attachments` the current
 * binary; both are one request per entity. History is O(revisions) requests per entity and is the
 * part most likely to be refused by the source, so it is isolated: a denied history degrades this
 * stage alone and never costs the run its pages.
 *
 * THE CURRENT REVISION IS NOT RE-IMPORTED. Creating the wiki page already fired
 * `handle_wiki_page_versioning`, which wrote version 1 holding the CURRENT body. Mirroring
 * Confluence's numbering therefore means renumbering that row to the source's latest number and
 * inserting only 1..N-1 beneath it — never inserting the current body a second time.
 *
 * WHY THE ROWS ARE WRITTEN DIRECTLY. `wiki_page_versions` has no service API, and going through
 * `WikiService.updatePage` N times would rewrite the live page N times and let the trigger coalesce
 * edits inside its 10-minute window. Writing the rows directly is the only way to land a specific
 * version number with the original author and timestamp.
 *
 * `changes.event` is set to `origin_backfill`, which is not decorative: the versioning trigger's
 * coalescing guard excludes that event, so a later user edit cannot silently absorb an imported
 * revision into itself.
 *
 * AUDITED PARTIAL RESULTS. A source that cannot or will not serve history produces a warn log plus
 * a `skipped` outcome with a reason. It never produces a green "history imported".
 *
 * @module src/migration/engine/stages/page-history.stage
 * @author Prince Jadiya
 */

import { confluenceSourcePageUrl } from '../../mappers/page.mapper';
import { BadRequestException, Injectable } from '@nestjs/common';

import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { AttachmentsService } from '../../../attachments/attachments.service';
import { UPLOAD_LIMITS } from '../../../common/upload-limits';
import { ContentTransformService } from '../../transformers/content-transform.service';
import { isConfluenceAdapter } from '../../adapters/source-adapter.interface';
import { AtlassianRequestError } from '../../adapters/http/atlassian-http-client';
import type { IConfluenceSourceAdapter } from '../../adapters/source-adapter.interface';
import type {
  NormalizedAttachmentVersion,
  NormalizedPageVersion,
} from '../../model/normalized';
import { PAGE_ENTITY } from '../../mappers/page.mapper';
import { PAGE_ATTACHMENT_ENTITY } from './page-attachments.stage';
import { USER_ENTITY } from './users.stage';
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

export const PAGE_HISTORY_STAGE = 'page_history';
export const PAGE_VERSION_ENTITY = 'page_version';
export const PAGE_ATTACHMENT_VERSION_ENTITY = 'page_attachment_version';

const PAGE_BATCH = 25;

/** Same ceiling `page_attachments` uses: this path buffers the body into memory before upload. */
const MAX_FILE_BYTES = Math.min(
  UPLOAD_LIMITS.ATTACHMENT,
  2 * 1024 * 1024 * 1024,
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface HistoryPayload {
  pageSourceId: string;
}

interface PageVersionRow {
  id: string;
  version: number;
}

@Injectable()
export class PageHistoryStage implements IStageHandler {
  readonly stage = PAGE_HISTORY_STAGE;

  constructor(
    private readonly content: ContentTransformService,
    private readonly attachments: AttachmentsService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * A repair run records against the run it is repairing, so repair stages can see what it wrote.
   * Identical rule to `page-attachments.stage.ts`; they must not diverge.
   */
  private mappingRunId(ctx: StageContext): string {
    const repairOf = ctx.run.config_snapshot?.repair_of_run_id;

    return typeof repairOf === 'string' && repairOf ? repairOf : ctx.run.id;
  }

  // ==========================================================================
  // produce
  // ==========================================================================

  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isConfluenceAdapter(adapter)) {
      throw new MigrationItemError(
        'permanent',
        'The page-history stage requires a Confluence connection',
      );
    }

    const checkpoint = (collectionItem.checkpoint ?? {}) as { offset?: number };
    const offset =
      typeof checkpoint.offset === 'number' ? checkpoint.offset : 0;

    // Dry runs record pages as `planned`, so enumerating only `mapped` would plan zero revisions.
    const pageStatuses = ctx.dryRun ? ['mapped', 'planned'] : ['mapped'];

    const { data: pages, error } = (await this.db
      .from('migration_entity_map')
      .select('source_id')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('entity_type', PAGE_ENTITY)
      // Scoped to THIS space: never enumerate another space migrated on the same connection.
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
        `Failed to enumerate migrated pages for history: ${error.message}`,
      );
    }

    const rows = pages ?? [];
    const seeds: SeedItem[] = rows.map((page) => ({
      entityType: PAGE_VERSION_ENTITY,
      sourceRef: page.source_id,
      payload: { pageSourceId: page.source_id } as unknown as Record<
        string,
        unknown
      >,
    }));

    const done = rows.length < PAGE_BATCH;

    await ctx.log(
      'info',
      `page_history: seeded ${seeds.length} page(s) for revision import`,
      { count: seeds.length },
    );

    return {
      items: seeds,
      nextCheckpoint: done ? null : { offset: offset + rows.length },
      done,
    };
  }

  // ==========================================================================
  // processItem
  // ==========================================================================

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const payload = (item.payload ?? {}) as unknown as Partial<HistoryPayload>;
    const pageSourceId = payload.pageSourceId || item.source_ref;

    if (!pageSourceId) {
      throw new MigrationItemError(
        'permanent',
        'History item carries no page source id',
      );
    }

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen || (!ctx.dryRun && !spaceId)) {
      return {
        kind: 'blocked',
        waitingFor: { entityType: 'space', sourceId: ctx.job.source_ref },
      };
    }

    const adapter = (await ctx.getAdapter()) as IConfluenceSourceAdapter;

    // ---- capability gate -------------------------------------------------
    // Absent methods and a negative probe mean the same thing to the operator: this run cannot
    // claim a complete history, so both take the audited-partial path rather than failing.
    const capable =
      typeof adapter.getPageVersions === 'function' &&
      typeof adapter.getPageBodyAtVersion === 'function' &&
      (typeof adapter.supportsHistory !== 'function' ||
        (await adapter.supportsHistory()));

    if (!capable) {
      await ctx.log(
        'warn',
        `page_history: source does not expose revision history for page ${pageSourceId}; history was NOT imported`,
        {
          sourceRef: pageSourceId,
          partial: true,
          reason: 'source does not expose revision history',
        },
      );

      return {
        kind: 'skipped',
        reason: 'source does not expose revision history',
      };
    }

    const pageRow = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      PAGE_ENTITY,
      pageSourceId,
    );

    if (ctx.dryRun && (pageRow?.status === 'planned' || pageRow?.target_id))
      return this.planDryRun(ctx, adapter, pageSourceId);

    if (!pageRow?.target_id) {
      return {
        kind: 'blocked',
        waitingFor: { entityType: PAGE_ENTITY, sourceId: pageSourceId },
      };
    }

    const wikiPageId = pageRow.target_id;

    // Page-body history and attachment-version history are attempted INDEPENDENTLY. Confluence can
    // (and on the test instance that shipped this feature, does) gate them on different permission
    // surfaces, so a denial on one must not suppress an attempt at the other for the same page.
    let versions: NormalizedPageVersion[] = [];
    let pageHistoryReason: string | null = null;

    try {
      versions = await adapter.getPageVersions!(pageSourceId);

      if (versions.length === 0) {
        pageHistoryReason = 'source returned no revisions';

        await ctx.log(
          'warn',
          `page_history: source returned no revisions for page ${pageSourceId}`,
          { sourceRef: pageSourceId, partial: true, reason: pageHistoryReason },
        );
      }
    } catch (err) {
      const denial = this.sourceDenialReason(err);

      if (!denial)
        throw this.classify(err, `list revisions of page ${pageSourceId}`);

      // The source has and can serve this page's CURRENT body (it was imported earlier), but
      // refuses the version sub-resource for it specifically — permission scoped narrower than
      // the account's general read access, or a build that omits history per-content-type. That
      // is a page-level gap, reported and moved on, not a run-wide failure to retry into the
      // ground.
      pageHistoryReason = 'source denied revision history for this page';

      await ctx.log(
        'warn',
        `page_history: source denied revision history for page ${pageSourceId} (${denial}); history was NOT imported for this page`,
        { sourceRef: pageSourceId, partial: true, reason: pageHistoryReason },
      );
    }

    let imported = 0;
    let adopted = 0;

    if (versions.length > 0) {
      const latest = versions[versions.length - 1].version;

      const numberingIsOurs = await this.alignCurrentVersionNumber(
        ctx,
        wikiPageId,
        latest,
        pageSourceId,
      );

      if (!numberingIsOurs)
        pageHistoryReason = 'target-authored revisions preserved';
      else if (versions.every((version) => version.version >= latest))
        pageHistoryReason = 'source contains only the current revision';

      // Only 1..N-1: the current revision IS the live page and must not be duplicated.
      for (const version of versions) {
        if (!numberingIsOurs) break;
        if (version.version >= latest) continue;

        const result = await this.importPageVersion(
          ctx,
          adapter,
          wikiPageId,
          pageSourceId,
          version,
        );

        if (result === 'imported') imported += 1;
        if (result === 'adopted') adopted += 1;
        if (result === 'skipped')
          pageHistoryReason = 'source withheld revision bodies';
      }
    }

    const attachmentStats = await this.importAttachmentVersions(
      ctx,
      adapter,
      spaceId!,
      wikiPageId,
      pageSourceId,
    );

    const reason =
      pageHistoryReason ??
      attachmentStats.reason ??
      'every revision was already imported';

    await ctx.log(
      'info',
      `page_history: page ${pageSourceId} — ${imported} revision(s) imported, ${adopted} adopted, ${attachmentStats.imported} attachment version(s) imported, ${attachmentStats.adopted} adopted`,
      {
        sourceRef: pageSourceId,
        ...(imported + attachmentStats.imported === 0 ? { reason } : {}),
      },
    );

    if (imported + attachmentStats.imported > 0) {
      return {
        kind: 'updated',
        targetId: wikiPageId,
        targetTable: 'wiki_page_versions',
      };
    }

    return {
      kind: 'skipped',
      targetId: wikiPageId,
      // Prefer the page-history reason when both domains were denied — it is the one an operator
      // reads first. `every revision was already imported` covers the pure re-run/adoption case.
      reason,
    };
  }

  // ==========================================================================
  // page revisions
  // ==========================================================================

  /**
   * Make the trigger-created row carry the SOURCE's latest version number.
   *
   * On import the trigger wrote version 1 holding the current body. Mirroring Confluence numbering
   * means that row is really revision N, so it is renumbered once, before anything is inserted
   * beneath it — otherwise inserting source revision 1 collides on `UNIQUE(wiki_page_id, version)`.
   *
   * Idempotent and non-destructive: it does nothing when a row already sits at N (a re-run, or a
   * page a user has since edited), and it never touches a page that has more than the single
   * import-created revision.
   */
  private async alignCurrentVersionNumber(
    ctx: StageContext,
    wikiPageId: string,
    latest: number,
    pageSourceId: string,
  ): Promise<boolean> {
    if (latest <= 1) return true;

    const { data, error } = (await this.db
      .from('wiki_page_versions')
      .select('id, version')
      .eq('wiki_page_id', wikiPageId)
      .order('version', { ascending: true })) as {
      data: PageVersionRow[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Failed to read existing versions of page ${pageSourceId}: ${error.message}`,
      );
    }

    const rows = data ?? [];

    // "Already aligned" must be PROVEN, not inferred from a version-number coincidence. Checking
    // only `rows.some(v === latest)` was a real gap: a page with N-1 real user edits happens to
    // reach version N by coincidence, and the source's `latest` also being N would have made this
    // fast path trust user-authored rows as "our" numbering — importing straight past the guard
    // below that exists specifically to protect them. Proof instead: a crosswalk row recording
    // that THIS page's revision N-1 was actually imported by this stage before. That can only
    // exist if a prior page_history run legitimately reached this exact `latest`.
    if (latest > 1) {
      const priorImport = await ctx.entityMap.getTarget(
        ctx.orgId,
        ctx.job.connection_id,
        PAGE_VERSION_ENTITY,
        `${pageSourceId}:v${latest - 1}`,
      );

      if (priorImport?.status === 'mapped') return true;
    }

    // Only the single trigger-created revision may be renumbered. More than one row means real
    // edit history exists on the target, and renumbering would rewrite a user's own timeline.
    if (rows.length !== 1 || rows[0].version !== 1) {
      await ctx.log(
        'warn',
        `page_history: page ${pageSourceId} already has target-authored revisions; source revision history was NOT imported`,
        {
          sourceRef: pageSourceId,
          partial: true,
          reason: 'target-authored revisions preserved',
        },
      );

      // The target owns the numbering space from here on. Inserting source revisions into it would
      // collide with the user's own versions on UNIQUE(wiki_page_id, version) — and a collision is
      // NOT the same as "already imported", so it must not be silently adopted. Refuse instead.
      return false;
    }

    const { error: updateError } = await this.db
      .from('wiki_page_versions')
      .update({ version: latest })
      .eq('id', rows[0].id)
      // Compare-and-swap: refuse the write if anything moved the row since the read above.
      .eq('version', 1);

    if (updateError) {
      throw new MigrationItemError(
        'transient',
        `Failed to align current revision number for page ${pageSourceId}: ${updateError.message}`,
      );
    }

    return true;
  }

  private async importPageVersion(
    ctx: StageContext,
    adapter: IConfluenceSourceAdapter,
    wikiPageId: string,
    pageSourceId: string,
    version: NormalizedPageVersion,
  ): Promise<'imported' | 'adopted' | 'skipped'> {
    const naturalKey = `${pageSourceId}:v${version.version}`;

    const existing = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      PAGE_VERSION_ENTITY,
      naturalKey,
    );

    // The crosswalk IS the idempotency mechanism here: an insert-only row has no `updated_at` to
    // compare-and-swap against, so an already-mapped revision is adopted and never rewritten.
    if (existing?.status === 'mapped') return 'adopted';

    // Both editions serve HISTORICAL bodies as storage XHTML: Server has no ADF at all, and
    // Cloud's v2 API has no body-at-version surface, so it falls back to the v1 historical route.
    const bodyFormat = 'storage' as const;

    let body: Awaited<
      ReturnType<NonNullable<IConfluenceSourceAdapter['getPageBodyAtVersion']>>
    >;

    try {
      body = await adapter.getPageBodyAtVersion!(
        pageSourceId,
        version.version,
        bodyFormat,
      );
    } catch (err) {
      throw this.classify(
        err,
        `fetch body of page ${pageSourceId} v${version.version}`,
      );
    }

    // A listed revision whose body the source withholds is a GAP, reported and skipped. Retrying
    // cannot help, and inventing a body would be fabricating source content.
    if (!body) {
      await ctx.log(
        'warn',
        `page_history: source withheld the body of page ${pageSourceId} v${version.version}; revision skipped`,
        {
          sourceRef: naturalKey,
          partial: true,
          reason: 'source withheld revision body',
        },
      );

      return 'skipped';
    }

    const sourceBaseUrl = await ctx.getSourceBaseUrl?.();
    const rendered = await this.content.renderBodyAsTipTap(body, {
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      pageSourceId,
      currentPageId: wikiPageId,
      macroStrategy: runOptions(ctx).macro_strategy,
      sourceBaseUrl: sourceBaseUrl ?? undefined,
      sourcePageUrl: confluenceSourcePageUrl(
        sourceBaseUrl,
        pageSourceId,
        adapter.deployment === 'cloud',
      ),
    });

    const author = await this.resolveAuthor(ctx, version.authorSourceId);

    const { data: inserted, error } = (await this.db
      .from('wiki_page_versions')
      .insert({
        wiki_page_id: wikiPageId,
        version: version.version,
        title: body.title ?? version.title ?? '',
        content: rendered.content,
        content_format: 'tiptap',
        changed_by: author,
        ...(version.created ? { created_at: version.created } : {}),
        changes: {
          // Excluded from the versioning trigger's coalescing guard, so a later user edit cannot
          // absorb this imported revision into itself.
          event: 'origin_backfill',
          source: 'confluence',
          source_page_id: pageSourceId,
          source_version: version.version,
          ...(version.message ? { message: version.message } : {}),
          ...(typeof version.minorEdit === 'boolean'
            ? { minor_edit: version.minorEdit }
            : {}),
        },
      })
      .select('id')
      .maybeSingle()) as {
      data: { id: string } | null;
      error: { message: string; code?: string } | null;
    };

    if (error) {
      // A concurrent writer already placed this exact revision — adopt it rather than fail.
      // Reaching here at all means `alignCurrentVersionNumber` confirmed the source owns the
      // numbering, so this cannot be a collision with a user-authored version.
      if (error.code === '23505') return 'adopted';

      throw new MigrationItemError(
        'transient',
        `Failed to store revision ${version.version} of page ${pageSourceId}: ${error.message}`,
      );
    }

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: this.mappingRunId(ctx),
      entityType: PAGE_VERSION_ENTITY,
      sourceId: naturalKey,
      sourceKey: String(version.version),
      targetTable: 'wiki_page_versions',
      targetId: inserted?.id ?? wikiPageId,
      status: 'mapped',
      metadata: {
        page_source_id: pageSourceId,
        source_version: version.version,
        ...(version.created ? { source_created_date: version.created } : {}),
      },
    });

    return 'imported';
  }

  // ==========================================================================
  // attachment versions
  // ==========================================================================

  private async importAttachmentVersions(
    ctx: StageContext,
    adapter: IConfluenceSourceAdapter,
    spaceId: string,
    wikiPageId: string,
    pageSourceId: string,
  ): Promise<{ imported: number; adopted: number; reason?: string }> {
    const stats: { imported: number; adopted: number; reason?: string } = {
      imported: 0,
      adopted: 0,
    };

    if (!scopeIncludes(ctx, 'include_attachments')) return stats;

    if (typeof adapter.getAttachmentVersions !== 'function') {
      stats.reason = 'source does not expose attachment version history';
      await ctx.log(
        'warn',
        `page_history: source does not expose attachment version history (page ${pageSourceId})`,
        {
          sourceRef: pageSourceId,
          partial: true,
          reason: 'source does not expose attachment version history',
        },
      );

      return stats;
    }

    const { data: attachments, error } = (await this.db
      .from('migration_entity_map')
      .select('source_id, metadata')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('entity_type', PAGE_ATTACHMENT_ENTITY)
      .filter('metadata->>page_source_id', 'eq', pageSourceId)
      .eq('status', 'mapped')) as {
      data: { source_id: string; metadata: Record<string, unknown> }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Failed to enumerate attachments of page ${pageSourceId}: ${error.message}`,
      );
    }

    for (const row of attachments ?? []) {
      const sourceAttachmentId =
        typeof row.metadata?.['source_attachment_id'] === 'string'
          ? row.metadata['source_attachment_id']
          : null;

      // The page_attachment crosswalk is keyed `${pageSourceId}:${filename}`, which is not the
      // source attachment id the version endpoints need. Without it there is nothing to ask for.
      if (!sourceAttachmentId) {
        stats.reason = 'attachment has no recorded source id';
        await ctx.log(
          'warn',
          `page_history: attachment ${row.source_id} has no recorded source id; its version history was not imported`,
          {
            sourceRef: row.source_id,
            partial: true,
            reason: 'attachment has no recorded source id',
          },
        );

        continue;
      }

      let versions: NormalizedAttachmentVersion[];

      try {
        versions = await adapter.getAttachmentVersions(sourceAttachmentId);
        if (versions.length === 0)
          stats.reason = 'source returned no attachment revisions';
      } catch (err) {
        const denial = this.sourceDenialReason(err);

        if (denial) {
          stats.reason = 'source denied attachment history';
          await ctx.log(
            'warn',
            `page_history: source denied version history for attachment ${sourceAttachmentId} (${denial}); its earlier versions were NOT imported`,
            {
              sourceRef: sourceAttachmentId,
              partial: true,
              reason: 'source denied attachment history',
            },
          );

          continue;
        }

        throw this.classify(
          err,
          `list versions of attachment ${sourceAttachmentId}`,
        );
      }

      for (const version of versions) {
        const outcome = await this.importAttachmentVersion(
          ctx,
          adapter,
          spaceId,
          wikiPageId,
          sourceAttachmentId,
          typeof row.metadata?.['filename'] === 'string'
            ? row.metadata['filename']
            : row.source_id,
          version,
        );

        if (outcome === 'imported') stats.imported += 1;
        if (outcome === 'adopted') stats.adopted += 1;
        if (outcome === 'skipped')
          stats.reason = 'attachment revision binaries unavailable';
      }
    }

    return stats;
  }

  private async importAttachmentVersion(
    ctx: StageContext,
    adapter: IConfluenceSourceAdapter,
    spaceId: string,
    wikiPageId: string,
    sourceAttachmentId: string,
    fallbackFilename: string,
    version: NormalizedAttachmentVersion,
  ): Promise<'imported' | 'adopted' | 'skipped'> {
    const naturalKey = `${sourceAttachmentId}:v${version.version}`;

    const existing = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      PAGE_ATTACHMENT_VERSION_ENTITY,
      naturalKey,
    );

    if (existing?.status === 'mapped') return 'adopted';

    if (!version.downloadUrl) {
      await ctx.log(
        'warn',
        `page_history: attachment ${sourceAttachmentId} v${version.version} has no download URL; binary not imported`,
        {
          sourceRef: naturalKey,
          partial: true,
          reason: 'attachment revision has no download URL',
        },
      );

      return 'skipped';
    }

    // Pre-flight on the reported size so an oversize revision is refused before it is downloaded.
    if (
      typeof version.sizeBytes === 'number' &&
      version.sizeBytes > MAX_FILE_BYTES
    ) {
      await ctx.log(
        'warn',
        `page_history: attachment ${sourceAttachmentId} v${version.version} exceeds the size limit; binary not imported`,
        {
          sourceRef: naturalKey,
          partial: true,
          reason: 'attachment revision exceeds size limit',
        },
      );

      return 'skipped';
    }

    let bytes: { data: Buffer; contentType: string | null; size: number };

    try {
      // Reuses the origin-pinned, size-capped download the current-version path already uses.
      bytes = await adapter.getAttachmentBytes(
        version.downloadUrl,
        MAX_FILE_BYTES,
      );
    } catch (err) {
      const denial = this.sourceDenialReason(err);

      if (denial) {
        await ctx.log(
          'warn',
          `page_history: source denied download of attachment ${sourceAttachmentId} v${version.version} (${denial}); this version's binary was NOT imported`,
          {
            sourceRef: naturalKey,
            partial: true,
            reason: 'source denied attachment download',
          },
        );

        return 'skipped';
      }

      throw this.classify(
        err,
        `download attachment ${sourceAttachmentId} v${version.version}`,
      );
    }

    const author = await this.resolveAuthor(ctx, version.authorSourceId);
    const fileName = version.filename || fallbackFilename;

    let result: Awaited<ReturnType<AttachmentsService['importVersion']>>;

    try {
      result = await this.attachments.importVersion({
        organizationId: ctx.orgId,
        spaceId,
        entityType: 'wiki_page',
        entityId: wikiPageId,
        fileName,
        versionNumber: version.version,
        data: bytes.data,
        mimeType: version.mimeType ?? bytes.contentType,
        uploadedBy: author,
        uploadedAt: version.created ?? null,
        comment: version.message ?? null,
        createdBy: requireActingUser(ctx),
      });
    } catch (err) {
      // `importVersion` throws BadRequestException for exactly the failures the task calls out —
      // validation (size, SVG-block) and storage (upload failed). Neither is transient: retrying
      // an oversize or blocked file cannot succeed, and a storage error here is already the SAME
      // reason a normal upload of this file would fail. Skip this ONE version, keep the page and
      // its other versions moving — a bad historical revision must not sink the whole page.
      if (err instanceof BadRequestException) {
        await ctx.log(
          'warn',
          `page_history: attachment ${sourceAttachmentId} v${version.version} failed validation or storage (${err.message}); this version's binary was NOT imported`,
          {
            sourceRef: naturalKey,
            partial: true,
            reason: 'attachment revision failed validation or storage',
          },
        );

        return 'skipped';
      }

      throw this.classify(
        err,
        `store attachment ${sourceAttachmentId} v${version.version}`,
      );
    }

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: this.mappingRunId(ctx),
      entityType: PAGE_ATTACHMENT_VERSION_ENTITY,
      sourceId: naturalKey,
      sourceKey: fileName,
      targetTable: 'file_versions',
      targetId: result.version.id,
      status: 'mapped',
      metadata: {
        source_attachment_id: sourceAttachmentId,
        source_version: version.version,
        wiki_page_id: wikiPageId,
        file_path: result.version.file_path,
        ...(version.created ? { source_created_date: version.created } : {}),
      },
    });

    return result.adopted ? 'adopted' : 'imported';
  }

  // ==========================================================================
  // helpers
  // ==========================================================================

  /**
   * Dry run: report how much history WOULD be imported without fetching a single body or byte.
   * Recorded as `planned` so the crosswalk gate opens for downstream planning.
   */
  private async planDryRun(
    ctx: StageContext,
    adapter: IConfluenceSourceAdapter,
    pageSourceId: string,
  ): Promise<ItemOutcome> {
    let count = 0;

    try {
      const versions = await adapter.getPageVersions!(pageSourceId);

      count = Math.max(versions.length - 1, 0);
    } catch {
      count = 0;
    }

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: this.mappingRunId(ctx),
      entityType: PAGE_VERSION_ENTITY,
      sourceId: pageSourceId,
      targetTable: 'wiki_page_versions',
      targetId: `planned:${pageSourceId}`,
      status: 'planned',
      metadata: { planned_revisions: count },
    });

    await ctx.log(
      'info',
      `page_history: would import ${count} revision(s) for page ${pageSourceId}`,
      { sourceRef: pageSourceId },
    );

    return { kind: 'planned' };
  }

  private async resolveAuthor(
    ctx: StageContext,
    authorSourceId: string | undefined,
  ): Promise<string> {
    const acting = requireActingUser(ctx);

    if (!authorSourceId) return acting;

    const row = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      USER_ENTITY,
      authorSourceId,
    );

    return row?.target_id && UUID_RE.test(row.target_id)
      ? row.target_id
      : acting;
  }

  /**
   * A genuine denial — the source can be reached but refuses this specific request — reported as
   * a targeted string (e.g. `403`), or `null` when the error is something else (network fault,
   * 5xx, malformed payload) that a retry might actually resolve.
   *
   * This distinction is the whole point of the requirement: without it, a page whose history the
   * source permanently refuses (a real "no" ) is indistinguishable from a transient network blip,
   * and the item retries to exhaustion instead of degrading into an audited partial result.
   */
  private sourceDenialReason(err: unknown): string | null {
    if (
      err instanceof AtlassianRequestError &&
      [401, 403, 404, 410].includes(err.status)
    ) {
      return String(err.status);
    }

    return null;
  }

  /**
   * Anything that reaches here is NOT a source denial (see `sourceDenialReason` above) and stays
   * `transient` so a flaky instance retries rather than dead-letters on the first hiccup.
   */
  private classify(err: unknown, what: string): MigrationItemError {
    if (err instanceof MigrationItemError) return err;

    const message = err instanceof Error ? err.message : String(err);

    return new MigrationItemError(
      /invalid content-type/i.test(message) ? 'permanent' : 'transient',
      `Failed to ${what}: ${message}`,
    );
  }
}
