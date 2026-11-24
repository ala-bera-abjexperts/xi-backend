/**
 * @fileoverview `comments` stage — Jira issue comments → `task_comments`.
 *
 * DELIBERATELY BYPASSES `TasksService.createComment` and writes the row directly. Verified reasons:
 *  - `createComment` fires `outbox('app.task.comment_added')` per comment (tasks.service.ts:1918),
 *    which drives the automations engine — shipped templates trigger on exactly this event and their
 *    actions include email/Slack/Teams/SMS/webhook. Importing years of Jira history would fire one
 *    per comment.
 *  - It also calls `notifyMentionedUsers`, inserting `notifications` rows and broadcasting them per
 *    mention. Real users would be notified about years-old Jira mentions.
 *  Neither has a suppression flag, so reuse is not an option here.
 *  - The bypass is also HIGHER fidelity: `createComment` hardcodes `created_by` to the acting user
 *    (tasks.service.ts:1898), whereas the crosswalk gives us the ORIGINAL author.
 *
 * Because nothing else sanitizes on this path, the stage MUST do it — with `allowTables`, exactly
 * matching `createComment` (tasks.service.ts:1891). The two policies have to stay in lockstep: this
 * stage writes the row, but every later edit of that comment goes through `createComment`/
 * `updateComment`, so a narrower policy here would import a table the user cannot round-trip.
 *
 * TRUNCATION: Jira caps the comments it inlines in a search response, so `fields.comment` alone is
 * NOT a complete read. `commentsTotal` carries the source's own count; when the inlined list falls
 * short, the stage re-reads that issue from the per-issue comment resource (`getIssueComments`),
 * which pages to the true total. Importing a subset and reporting success — this project's signature
 * failure mode — remains impossible: if paging still cannot reach the total, the item FAILS.
 *
 * MEASURED: SDP has ZERO comments — verified 2026-07-17 by reading the comment field of all 9,826
 * issues (not sampled, and not via JQL, whose Lucene index is not trustworthy for this). So this
 * stage is built for real customers and CANNOT be exercised by the live test data: the truncation
 * fallback in particular has never executed against a real truncated response.
 */

import { Injectable } from '@nestjs/common';
import { sanitizeRichText } from '../../../common/utils/sanitize-rich-text';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type {
  IJiraSourceAdapter,
  Page,
} from '../../adapters/source-adapter.interface';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import {
  describeLoss,
  issueDescriptionToHtml,
} from '../../mappers/issue-body.mapper';
import type {
  NormalizedComment,
  NormalizedIssue,
} from '../../model/normalized';
import { isResolvedStatus } from './crosswalk-gate.util';
import { ISSUE_ENTITY } from './issues.stage';
import { runScope, scopeIncludes } from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type SeedItem,
  type StageContext,
} from './stage.interface';
import { USER_ENTITY } from './users.stage';

export const COMMENTS_STAGE = 'comments';
export const COMMENT_ENTITY = 'comment';

interface CommentPayload {
  issueSourceId: string;
  issueKey: string;
  comment: NormalizedComment;
}

@Injectable()
export class CommentsStage implements IStageHandler {
  readonly stage = COMMENTS_STAGE;

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** One page of issues per call; seeds one item per comment. Cursor rides the checkpoint. */
  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'comments stage: non-Jira source — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    // The admin explicitly excluded this slice — honour it, and say so. Validating a flag and then
    // ignoring it is how a migration quietly does more than the user asked for.
    if (!scopeIncludes(ctx, 'include_comments')) {
      await ctx.log(
        'info',
        'comments stage: excluded by job scope — seeding 0',
      );

      return { items: [], nextCheckpoint: null, done: true };
    }

    const checkpoint = collectionItem.checkpoint ?? {};
    const cursor =
      typeof checkpoint.cursor === 'string' ? checkpoint.cursor : null;

    // The issues stage's ISSUE_FIELDS excludes `comment` (it would drag comment bodies through
    // 9,826 rows for nothing), so the comment graph is read here, on its own.
    const iterator = adapter.iterateIssues(ctx.job.source_ref, {
      cursor,
      pageSize: 50,
      fields: ['comment'],
      ...(runScope(ctx).jql ? { jql: runScope(ctx).jql } : {}),
    });
    const first = await iterator.next();

    if (first.done || !first.value) {
      return { items: [], nextCheckpoint: null, done: true };
    }

    const page = first.value;
    const items: SeedItem[] = [];

    for (const issue of page.items) {
      let comments = issue.comments ?? [];

      // The source told us how many there are. If it inlined fewer, the rest are NOT here — seeding
      // only what arrived would silently import a subset, so re-read this issue's comments from the
      // per-issue resource, which pages to the true total.
      if (
        typeof issue.commentsTotal === 'number' &&
        comments.length < issue.commentsTotal
      ) {
        comments = await this.fetchAllComments(ctx, adapter, issue);
      }

      for (const comment of comments) {
        const payload: CommentPayload = {
          issueSourceId: issue.sourceId,
          issueKey: issue.key,
          comment,
        };

        items.push({
          entityType: COMMENT_ENTITY,
          sourceRef: comment.sourceId,
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
    const payload = item.payload as unknown as CommentPayload | null;

    if (!payload?.comment?.sourceId) {
      throw new MigrationItemError(
        'permanent',
        'Comment item is missing its payload snapshot',
      );
    }

    const { comment } = payload;
    const existing = await ctx.entityMap.getExistingTarget(
      ctx.orgId,
      ctx.job.connection_id,
      COMMENT_ENTITY,
      comment.sourceId,
      'task_comments',
    );

    if (existing?.status === 'mapped') {
      return {
        kind: 'skipped',
        reason: 'comment already mapped',
        targetId: existing.target_id,
      };
    }

    if (existing?.status === 'planned' && ctx.dryRun) {
      return { kind: 'skipped', reason: 'already planned' };
    }

    // The task must exist — a comment with no task is nothing.
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

    // Author is BEST-EFFORT and must never block: `created_by` is nullable, and losing a comment
    // over an unresolvable author would be far worse than losing its attribution. `placeholder`
    // counts as resolved — that is exactly what placeholders are for.
    const authorId = await this.resolveAuthor(ctx, comment.authorSourceId);

    if (comment.authorSourceId && !authorId) {
      await ctx.log(
        'warn',
        `comments: unmapped author for a comment on ${payload.issueKey} — imported unattributed`,
        { authorSourceId: comment.authorSourceId },
      );
    }

    const html = issueDescriptionToHtml(comment.body);
    const loss = describeLoss(comment.body);

    if (loss) {
      await ctx.log('warn', `comments: ${payload.issueKey} — ${loss}`, {
        sourceId: comment.sourceId,
      });
    }

    if (!html) {
      // An empty comment carries nothing; recording it would add a blank row to the task.
      return { kind: 'skipped', reason: 'comment body is empty' };
    }

    // Nothing else sanitizes on this path. Matches TasksService.createComment exactly, tables
    // included — the task comment editor registers table nodes, so the grid survives a later edit.
    const content = sanitizeRichText(html, { allowTables: true }) ?? '';

    if (!content.trim()) {
      await ctx.log(
        'warn',
        `comments: ${payload.issueKey} — body was emptied by sanitization, comment skipped`,
        { sourceId: comment.sourceId },
      );

      return { kind: 'skipped', reason: 'body emptied by sanitization' };
    }

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: COMMENT_ENTITY,
        sourceId: comment.sourceId,
        sourceKey: payload.issueKey,
        targetTable: 'task_comments',
        targetId: `planned:${comment.sourceId}`,
        status: 'planned',
        metadata: {
          issue: payload.issueKey,
          author_mapped: !!authorId,
          ...(loss ? { lossy: loss } : {}),
        },
      });

      return { kind: 'planned' };
    }

    const { data, error } = (await this.db
      .from('task_comments')
      .insert({
        task_id: taskRow.target_id,
        organization_id: ctx.orgId,
        content,
        // The ORIGINAL author, not whoever ran the migration. Nullable by design.
        created_by: authorId,
        // Only trigger on this table is BEFORE UPDATE, so an INSERT-time value survives — the
        // original Jira chronology is preserved rather than stamped with the migration's clock.
        ...(comment.created ? { created_at: comment.created } : {}),
      })
      .select('id')
      .single()) as {
      data: { id: string } | null;
      error: { message: string; code?: string } | null;
    };

    if (error || !data) {
      throw new MigrationItemError(
        'transient',
        `Comment insert failed for ${payload.issueKey}: ${error?.message ?? 'no row returned'}`,
      );
    }

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: COMMENT_ENTITY,
      sourceId: comment.sourceId,
      sourceKey: payload.issueKey,
      targetTable: 'task_comments',
      targetId: data.id,
      status: 'mapped',
      metadata: {
        issue: payload.issueKey,
        author_mapped: !!authorId,
        ...(loss ? { lossy: loss } : {}),
      },
    });

    return {
      kind: 'created',
      targetId: data.id,
      targetTable: 'task_comments',
    };
  }

  /**
   * Every comment on one issue, paged from the per-issue resource.
   *
   * Reached only when the search response inlined fewer comments than the source's own `total`.
   * The contract is unchanged from the hard failure this replaces — NEVER import a subset — so if
   * paging still cannot produce the full set, the item fails loudly. What changes is that a project
   * with busy issues now migrates instead of failing outright.
   */
  private async fetchAllComments(
    ctx: StageContext,
    adapter: IJiraSourceAdapter,
    issue: NormalizedIssue,
  ): Promise<NormalizedComment[]> {
    const collected: NormalizedComment[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;

    // A cursor that stops advancing would otherwise spin forever; bound by the work actually
    // outstanding rather than a magic number.
    const maxPages = Math.ceil((issue.commentsTotal ?? 0) / 50) + 2;

    for (let i = 0; i < maxPages; i++) {
      const page: Page<NormalizedComment> = await adapter.getIssueComments(
        issue.sourceId,
        { cursor, pageSize: 50 },
      );

      for (const c of page.items) {
        // Dedupe by id: a shifting cursor (a comment added mid-run) must not double-import.
        if (!c.sourceId || seen.has(c.sourceId)) continue;

        seen.add(c.sourceId);
        collected.push(c);
      }

      cursor = page.nextCursor;

      if (!cursor) break;
    }

    if (collected.length < (issue.commentsTotal ?? 0)) {
      throw new MigrationItemError(
        'permanent',
        `Issue ${issue.key}: source reports ${issue.commentsTotal} comments but paging the ` +
          `per-issue comment resource yielded only ${collected.length}. Importing would silently ` +
          `drop ${(issue.commentsTotal ?? 0) - collected.length} comment(s).`,
      );
    }

    await ctx.log(
      'info',
      `comments: ${issue.key} — search inlined a truncated list, paged ${collected.length} ` +
        `comment(s) from the per-issue resource`,
    );

    return collected;
  }

  /** The mapped/placeholder user id for a Jira author, or null (never blocks). */
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
