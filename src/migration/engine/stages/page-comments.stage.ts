/**
 * @fileoverview `page_comments` stage — Confluence footer + inline comments → `wiki_page_comments`.
 *
 * Runs after `page_labels`, so every page exists and both the page and user crosswalks are complete.
 *
 * INLINE ANCHORING. Confluence anchors an inline comment with `inlineMarkerRef` plus character
 * offsets into the SOURCE document. Neither survives the import: the marker points at Confluence's own
 * content, and offsets shift because the ADF to TipTap transform wraps inline runs in paragraphs,
 * promotes block nodes out of paragraphs and drops `placeholder` nodes. What does survive is the
 * SELECTED TEXT, so that is what the anchor carries; the target can re-find it. A selection we cannot
 * locate is never dropped — the comment still lands, just unanchored, because losing a reviewer's
 * remark is worse than losing its position.
 *
 * AUTHORSHIP. Confluence Cloud never exposes comment authors' emails, so `users` mapped them to
 * placeholders. The comment is attributed to the mapped user when the crosswalk resolves it, and to
 * the run's acting user otherwise — never silently to nobody, since `created_by` is NOT NULL.
 */

import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { WikiCommentsService } from '../../../wiki/wiki-comments.service';
import { isConfluenceAdapter } from '../../adapters/source-adapter.interface';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { NormalizedComment } from '../../model/normalized';
import { PAGE_ENTITY } from '../../mappers/page.mapper';
import { resolveEmojiText } from '../../util/emoji-text.util';
import { USER_ENTITY } from './users.stage';
import {
  blockedOnSpace,
  requireActingUser,
  resolveTargetSpace,
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

export const PAGE_COMMENTS_STAGE = 'page_comments';
export const PAGE_COMMENT_ENTITY = 'page_comment';

/** Pages enumerated per produce() pass — mirrors `page_attachments`/`page_labels`. */
const PAGE_BATCH = 50;

/** `CreateWikiCommentDto.content` caps at 10 000 chars. */
const MAX_COMMENT_CHARS = 10_000;

interface CommentPayload {
  comment: NormalizedComment;
  pageSourceId: string;
}

@Injectable()
export class PageCommentsStage implements IStageHandler {
  readonly stage = PAGE_COMMENTS_STAGE;

  constructor(
    private readonly comments: WikiCommentsService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isConfluenceAdapter(adapter)) {
      throw new MigrationItemError(
        'permanent',
        'The page-comments stage requires a Confluence connection',
      );
    }

    if (!scopeIncludes(ctx, 'include_comments')) {
      await ctx.log('info', 'page_comments: excluded by job scope — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    // Server exposes comments as child content, not via the v2 endpoints — skip rather than guess.
    if (!adapter.getPageComments) {
      await ctx.log(
        'warn',
        'page_comments: this Confluence deployment has no comment read surface — seeding 0',
      );

      return { items: [], nextCheckpoint: null, done: true };
    }

    const checkpoint = (collectionItem.checkpoint ?? {}) as { offset?: number };
    const offset =
      typeof checkpoint.offset === 'number' ? checkpoint.offset : 0;
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
      let found: NormalizedComment[] = [];

      try {
        found = await adapter.getPageComments(page.source_id);
      } catch (err) {
        // The page already migrated; a comment read must never take it down with it.
        await ctx.log(
          'warn',
          `Could not list comments for page ${page.source_id}`,
          { error: (err as Error).message },
        );
        continue;
      }

      for (const comment of found) {
        seeds.push({
          entityType: PAGE_COMMENT_ENTITY,
          sourceRef: comment.sourceId,
          payload: {
            comment,
            pageSourceId: page.source_id,
          } as unknown as Record<string, unknown>,
        });
      }
    }

    const done = pages.length < PAGE_BATCH;

    await ctx.log(
      'info',
      `page_comments: seeded ${seeds.length} comment(s) from ${pages.length} page(s)`,
      { count: seeds.length },
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
    const payload = item.payload as unknown as CommentPayload | null;

    if (!payload?.comment?.sourceId || !payload.pageSourceId) {
      throw new MigrationItemError(
        'permanent',
        'Comment item is missing its snapshot',
      );
    }

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen) return blockedOnSpace(ctx);

    const pageRow = ctx.dryRun
      ? await ctx.entityMap.getTarget(
          ctx.orgId,
          ctx.job.connection_id,
          PAGE_ENTITY,
          payload.pageSourceId,
        )
      : await ctx.entityMap.getExistingWikiPageTarget(
          ctx.orgId,
          ctx.job.connection_id,
          payload.pageSourceId,
          spaceId!,
        );

    if (!pageRow?.target_id) {
      return {
        kind: 'blocked',
        waitingFor: {
          entityType: PAGE_ENTITY,
          sourceId: payload.pageSourceId,
        },
      };
    }

    const mappedComment = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      PAGE_COMMENT_ENTITY,
      payload.comment.sourceId,
    );
    const existing = ctx.dryRun
      ? mappedComment
      : await ctx.entityMap.getExistingWikiChildTarget(
          ctx.orgId,
          ctx.job.connection_id,
          PAGE_COMMENT_ENTITY,
          payload.comment.sourceId,
          'wiki_page_comments',
          pageRow.target_id,
        );

    if (
      mappedComment?.status === 'mapped' &&
      !ctx.dryRun &&
      !existing &&
      mappedComment.target_id
    ) {
      await ctx.entityMap.deleteExactStaleMapping(
        ctx.orgId,
        ctx.job.connection_id,
        PAGE_COMMENT_ENTITY,
        payload.comment.sourceId,
        mappedComment.target_id,
      );
    }

    if (existing?.status === 'mapped') {
      return {
        kind: 'skipped',
        reason: 'comment already migrated',
        targetId: existing.target_id,
      };
    }

    if (existing?.status === 'planned' && ctx.dryRun) {
      return {
        kind: 'skipped',
        reason: 'already planned',
        targetId: existing.target_id,
      };
    }

    if (ctx.dryRun) return { kind: 'planned' };
    if (!spaceId) return blockedOnSpace(ctx);

    const content = adfToPlainText(payload.comment.body?.value).slice(
      0,
      MAX_COMMENT_CHARS,
    );

    if (!content.trim()) {
      return { kind: 'skipped', reason: 'comment body is empty' };
    }

    const author = await this.resolveAuthor(
      ctx,
      payload.comment.authorSourceId,
    );

    const created = (await this.comments.createComment(
      pageRow.target_id,
      spaceId,
      {
        content,
        ...(payload.comment.inline
          ? { anchor: buildAnchor(payload.comment.inline) }
          : {}),
      },
      author,
    )) as { id?: string };

    // Without an id the crosswalk cannot record this comment, and the next retry would create a
    // SECOND copy of it. Surfacing that as a failure is better than silently duplicating on retry.
    if (!created?.id) {
      throw new MigrationItemError(
        'permanent',
        `Comment ${payload.comment.sourceId} was created but returned no id, so it cannot be ` +
          `recorded in the crosswalk (a retry would duplicate it)`,
      );
    }

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: PAGE_COMMENT_ENTITY,
      sourceId: payload.comment.sourceId,
      sourceKey: payload.pageSourceId,
      targetTable: 'wiki_page_comments',
      targetId: created.id,
      status: 'mapped',
      metadata: {
        page_source_id: payload.pageSourceId,
        inline: Boolean(payload.comment.inline),
        resolved: Boolean(payload.comment.resolved),
        // Kept so a resolved thread can be reconciled later; the target has no resolved flag yet.
        ...(payload.comment.inline
          ? { anchor_selection: payload.comment.inline.selection }
          : {}),
      },
    });

    return {
      kind: 'created',
      targetId: created.id,
      targetTable: 'wiki_page_comments',
    };
  }

  /**
   * The target user to attribute the comment to.
   *
   * Falls back to the acting user rather than failing: `created_by` is NOT NULL, and an unattributed
   * comment is still worth far more than no comment. Confluence Cloud hides emails, so the mapped
   * user is a placeholder either way.
   */
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
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `quotedText` is capped at 500 chars by `validateAnchor`. */
const MAX_QUOTED_CHARS = 500;

/**
 * Build the anchor in the shape `WikiCommentsService.validateAnchor` demands:
 * `{ type: 'text-range', threadId: <uuid>, quotedText: <=500 chars }`.
 *
 * `threadId` reuses Confluence's own `inlineMarkerRef`, which is already a UUID — so the thread keeps
 * its source identity and a re-run maps to the same thread instead of creating a second one. A marker
 * that is missing or not a UUID gets a fresh one, because the validator rejects anything else and
 * would fail the whole comment.
 */
export function buildAnchor(inline: {
  selection: string;
  markerRef?: string;
}): Record<string, unknown> {
  const threadId =
    inline.markerRef && UUID_RE.test(inline.markerRef)
      ? inline.markerRef
      : randomUUID();

  return {
    type: 'text-range',
    threadId,
    // The selected TEXT is the anchor: Confluence's character offsets do not survive the ADF to
    // TipTap transform, so the target re-finds the text instead.
    quotedText: inline.selection.slice(0, MAX_QUOTED_CHARS),
  };
}

/**
 * Flatten an ADF comment body to text.
 *
 * `wiki_page_comments.content` is plain text (the DTO caps it at 10 000 chars), so a comment is not
 * rich content in the target. Block boundaries become newlines so a multi paragraph comment does not
 * run together into one sentence.
 */
export function adfToPlainText(value: unknown): string {
  const parts: string[] = [];

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const child of node) walk(child);

      return;
    }

    const n = node as {
      type?: string;
      text?: string;
      content?: unknown;
      attrs?: {
        text?: string;
        shortName?: string;
        timestamp?: string;
        id?: string;
      };
    };

    if (n.type === 'text' && n.text) parts.push(n.text);
    // Emoji and status carry their label in attrs, not as a text child. Emoji goes through the
    // resolver because Atlassian pre-escapes `attrs.text` for most non-BMP characters — reading it
    // raw put the literal `🗓` into migrated comments.
    else if (n.type === 'emoji') parts.push(resolveEmojiText(n.attrs));
    else if (n.type === 'status') parts.push(n.attrs?.text ?? '');
    else if (n.type === 'hardBreak') parts.push('\n');

    walk(n.content);

    if (n.type === 'paragraph' || n.type === 'heading') parts.push('\n');
  };

  walk(typeof value === 'string' ? safeJson(value) : value);

  return parts
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
