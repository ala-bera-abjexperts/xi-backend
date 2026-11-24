/**
 * `jira_attachment_relink` — second pass after Jira files arrive.
 *
 * Jira renders attachment links into issue descriptions/comments as source-server URLs.  The
 * attachments stage deliberately owns copying the bytes; this stage then reads its crosswalk and
 * replaces only those URLs with the stable XISUITE download route.  A link may reference a file
 * attached to a *different* issue, so candidates resolve against the connection's whole crosswalk,
 * not just the issue's own attachments.  Crosswalk rows are unique per connection and keep whichever
 * run first mapped them, so neither the issues nor the files are looked up by run: a retry, re-run or
 * repair still finds both.  Links with no migrated file stay visible untouched and are reported as
 * warnings.  Conditional updates prevent a concurrent user edit from being overwritten, and a second
 * run is a no-op.  `relinkTask` is also driven outside any run by the boot-time heal.
 */

import { Injectable } from '@nestjs/common';
import { sanitizeRichText } from '../../../common/utils/sanitize-rich-text';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import {
  collectJiraAttachmentLinks,
  relinkJiraAttachmentHtmlWithReport,
  type JiraAttachmentLink,
} from '../../transformers/jira-attachment-relink';
import { ATTACHMENT_ENTITY } from './attachments.stage';
import { ISSUE_ENTITY } from './issues.stage';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type SeedItem,
  type StageContext,
} from './stage.interface';

export const JIRA_ATTACHMENT_RELINK_STAGE = 'jira_attachment_relink';

const ISSUE_BATCH = 50;
const COMMENT_BATCH = 100;
/** Bounds the `.in()` crosswalk / target-existence queries for link-heavy content. */
const CANDIDATE_CHUNK = 200;
/** Unresolved-link listings are capped in the log message; the full list goes to the context. */
const MAX_UNRESOLVED_IN_MESSAGE = 10;
/** Upper bound for the once-per-run advertised-origin scan. */
const ORIGIN_SCAN_CAP = 5000;

interface RelinkPayload {
  issueSourceId: string;
  issueKey: string;
  taskId: string;
}

/** Where one relink pass reads its crosswalk and reports: a migration run, or the boot-time heal. */
export interface RelinkScope {
  orgId: string;
  connectionId: string;
  /** Advertised origins are cached for one pass (a run id, or the heal's pass id). */
  passId: string;
  log: StageContext['log'];
}

interface CandidateCrosswalk {
  /** Crosswalk status per candidate id — rows may legitimately be mapped, skipped or failed. */
  statuses: Map<string, string>;
  /** target_id per candidate id with crosswalk status `mapped`. */
  mappedTargetIds: Map<string, string>;
  /** Origins the source advertised for the candidate attachments. */
  sourceOrigins: Set<string>;
}

interface ContentColumn {
  table: 'tasks' | 'task_comments';
  id: string;
  taskId: string;
  original: string;
}

interface SourceConnection {
  base_url: string | null;
}

interface TaskContent {
  id: string;
  description: string | null;
}

interface CommentContent {
  id: string;
  content: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    pages.push(items.slice(index, index + size));
  }

  return pages;
}

@Injectable()
export class JiraAttachmentRelinkStage implements IStageHandler {
  readonly stage = JIRA_ATTACHMENT_RELINK_STAGE;

  /** Advertised origins are stable for a run; re-scanning them per task would be pure waste. */
  private originsCache: { key: string; origins: string[] } | null = null;

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** Seeds one imported task at a time, after all attachment rows have been mapped. */
  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    // Dry-runs have no real attachment ids and therefore no content route to write.
    if (ctx.dryRun) return { items: [], nextCheckpoint: null, done: true };

    // Every issue THIS run touched, from its own issue items. Repairs replay the issues stage, so
    // they enumerate their own. A pre-keyset `{ offset }` checkpoint restarts; seeding dedupes.
    const checkpoint = (collectionItem.checkpoint ?? {}) as {
      afterSourceRef?: unknown;
    };
    const after =
      typeof checkpoint.afterSourceRef === 'string'
        ? checkpoint.afterSourceRef
        : null;
    let issueItems = this.db
      .from('migration_run_items')
      .select('source_ref')
      .eq('organization_id', ctx.orgId)
      .eq('run_id', ctx.run.id)
      .eq('item_kind', 'entity')
      .eq('entity_type', ISSUE_ENTITY);

    if (after) issueItems = issueItems.gt('source_ref', after);

    const { data: items, error: itemsError } = (await issueItems
      .order('source_ref', { ascending: true })
      .limit(ISSUE_BATCH)) as {
      data: { source_ref: string }[] | null;
      error: { message: string } | null;
    };

    if (itemsError) {
      throw new MigrationItemError(
        'transient',
        `Failed to enumerate Jira tasks for attachment relinking: ${itemsError.message}`,
      );
    }

    const refs = (items ?? []).map((row) => row.source_ref);
    const done = refs.length < ISSUE_BATCH;
    let rows: {
      source_id: string;
      source_key: string | null;
      target_id: string;
    }[] = [];

    if (refs.length > 0) {
      const { data, error } = (await this.db
        .from('migration_entity_map')
        .select('source_id, source_key, target_id')
        .eq('organization_id', ctx.orgId)
        .eq('source_connection_id', ctx.job.connection_id)
        .eq('entity_type', ISSUE_ENTITY)
        .eq('status', 'mapped')
        .in('source_id', refs)) as {
        data: typeof rows | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new MigrationItemError(
          'transient',
          `Failed to enumerate Jira tasks for attachment relinking: ${error.message}`,
        );
      }

      rows = data ?? [];
    }

    return {
      items: rows
        .filter((row) => !!row.source_key)
        .map(
          (row): SeedItem => ({
            entityType: JIRA_ATTACHMENT_RELINK_STAGE,
            sourceRef: row.source_id,
            payload: {
              issueSourceId: row.source_id,
              issueKey: row.source_key!,
              taskId: row.target_id,
            },
          }),
        ),
      nextCheckpoint: done ? null : { afterSourceRef: refs[refs.length - 1] },
      done,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const payload = item.payload as unknown as RelinkPayload | null;

    if (!payload?.issueSourceId || !payload.issueKey || !payload.taskId) {
      throw new MigrationItemError(
        'permanent',
        'Jira attachment relink item is missing its snapshot',
      );
    }

    if (ctx.dryRun) return { kind: 'planned' };

    return this.relinkTask(
      {
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        passId: ctx.run.id,
        log: (level, message, context) => ctx.log(level, message, context),
      },
      payload.taskId,
      payload.issueKey,
    );
  }

  /** Relinks one imported task's description and every comment. Safe to repeat: a no-op once done. */
  async relinkTask(
    scope: RelinkScope,
    taskId: string,
    issueKey: string,
  ): Promise<ItemOutcome> {
    const task = await this.task(scope, taskId);

    if (!task) {
      throw new MigrationItemError(
        'conflict',
        `Mapped task ${taskId} no longer exists; attachment links were not changed`,
      );
    }

    const comments = await this.comments(scope, task.id);
    const contents: ContentColumn[] = [];

    if (task.description) {
      contents.push({
        table: 'tasks',
        id: task.id,
        taskId: task.id,
        original: task.description,
      });
    }

    for (const comment of comments) {
      contents.push({
        table: 'task_comments',
        id: comment.id,
        taskId: task.id,
        original: comment.content,
      });
    }

    // Shape-scan first: which Jira attachment ids does this task's content reference at all?
    const candidates = new Map<string, JiraAttachmentLink>();

    for (const content of contents) {
      for (const link of collectJiraAttachmentLinks(content.original)) {
        if (!candidates.has(link.sourceId)) candidates.set(link.sourceId, link);
      }
    }

    if (
      candidates.size === 0 &&
      !contents.some((content) => content.original.includes('rendericon'))
    ) {
      return {
        kind: 'skipped',
        reason: 'no Jira attachment URLs needed relinking',
      };
    }

    const crosswalk = await this.resolveCandidates(scope, [
      ...candidates.keys(),
    ]);
    const targets = await this.existingTargets(
      scope,
      crosswalk.mappedTargetIds,
    );
    const allowedOrigins = await this.allowedOrigins(
      scope,
      crosswalk.sourceOrigins,
    );
    const sourceBaseUrl = await this.connectionBaseUrl(scope);

    let updated = 0;
    const unresolved = new Map<string, JiraAttachmentLink>();

    for (const content of contents) {
      const report = relinkJiraAttachmentHtmlWithReport(
        content.original,
        targets,
        { sourceBaseUrl, allowedOrigins },
      );

      for (const link of report.unresolved) {
        if (!unresolved.has(link.sourceId)) unresolved.set(link.sourceId, link);
      }

      if (report.html !== content.original) {
        if (
          await this.writeColumn({
            scope,
            ...content,
            nextHtml: report.html,
          })
        ) {
          updated++;
        }
      }
    }

    if (unresolved.size > 0) {
      await this.reportUnresolved(scope, issueKey, unresolved, (id) =>
        this.unresolvedReason(id, crosswalk, targets),
      );
    }

    if (updated > 0) {
      return { kind: 'updated', targetId: task.id, targetTable: 'tasks' };
    }

    if (unresolved.size > 0) {
      const reason =
        unresolved.size === 1
          ? '1 linked document has no migrated file'
          : `${unresolved.size} linked documents have no migrated file`;

      return { kind: 'skipped', reason };
    }

    return {
      kind: 'skipped',
      reason: 'no Jira attachment URLs needed relinking',
    };
  }

  /**
   * Resolves the candidate ids against the connection's whole attachment crosswalk — a document
   * linked in one issue is frequently attached to another, and imported by another run.  The unique
   * (org, connection, entity_type, source_id) key makes this exact.  Any status is accepted so
   * unmapped links can be reported with a reason instead of silently staying broken.
   */
  private async resolveCandidates(
    scope: RelinkScope,
    sourceIds: string[],
  ): Promise<CandidateCrosswalk> {
    const crosswalk: CandidateCrosswalk = {
      statuses: new Map(),
      mappedTargetIds: new Map(),
      sourceOrigins: new Set(),
    };

    for (const page of chunk(sourceIds, CANDIDATE_CHUNK)) {
      const { data, error } = (await this.db
        .from('migration_entity_map')
        .select('source_id, target_id, status, metadata')
        .eq('organization_id', scope.orgId)
        .eq('source_connection_id', scope.connectionId)
        .eq('entity_type', ATTACHMENT_ENTITY)
        .in('source_id', page)) as {
        data:
          | {
              source_id: string;
              target_id: string;
              status: string;
              metadata: { source_origin?: unknown } | null;
            }[]
          | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new MigrationItemError(
          'transient',
          `Failed to resolve Jira attachment crosswalk: ${error.message}`,
        );
      }

      for (const row of data ?? []) {
        crosswalk.statuses.set(row.source_id, row.status);

        if (row.status === 'mapped') {
          crosswalk.mappedTargetIds.set(row.source_id, row.target_id);
        }

        const origin = row.metadata?.source_origin;

        if (typeof origin === 'string' && origin) {
          crosswalk.sourceOrigins.add(origin);
        }
      }
    }

    return crosswalk;
  }

  /**
   * A crosswalk row can outlive its target (undo, manual deletion).  Rewriting a link onto a
   * missing file would trade a broken Jira link for a broken XiSuite link, so only targets that
   * still exist count as resolved.
   */
  private async existingTargets(
    scope: RelinkScope,
    mappedTargetIds: Map<string, string>,
  ): Promise<Map<string, string>> {
    if (mappedTargetIds.size === 0) return new Map();

    const existing = new Set<string>();

    for (const page of chunk([...mappedTargetIds.values()], CANDIDATE_CHUNK)) {
      const { data, error } = (await this.db
        .from('file_attachments')
        .select('id')
        .eq('organization_id', scope.orgId)
        .in('id', page)) as {
        data: { id: string }[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new MigrationItemError(
          'transient',
          `Failed to verify migrated attachment targets: ${error.message}`,
        );
      }

      for (const row of data ?? []) existing.add(row.id);
    }

    return new Map(
      [...mappedTargetIds].filter(([, targetId]) => existing.has(targetId)),
    );
  }

  /**
   * Permitted origins for source links: what the candidate rows advertise, plus every origin the
   * connection's attachment mappings advertised — an unmapped link on a split-origin Jira (connection
   * via internal host, hrefs via the advertised hostname) must still be recognised as a source link.
   */
  private async allowedOrigins(
    scope: RelinkScope,
    candidateOrigins: Set<string>,
  ): Promise<string[]> {
    const origins = new Set(candidateOrigins);
    const cacheKey = `${scope.connectionId}:${scope.passId}`;

    if (this.originsCache?.key !== cacheKey) {
      const { data, error } = (await this.db
        .from('migration_entity_map')
        .select('metadata->>source_origin')
        .eq('organization_id', scope.orgId)
        .eq('source_connection_id', scope.connectionId)
        .eq('entity_type', ATTACHMENT_ENTITY)
        .not('metadata->>source_origin', 'is', null)
        .range(0, ORIGIN_SCAN_CAP - 1)) as {
        data: { source_origin?: unknown }[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new MigrationItemError(
          'transient',
          `Failed to read advertised Jira origins for attachment relinking: ${error.message}`,
        );
      }

      const scanned = new Set<string>();

      for (const row of data ?? []) {
        if (typeof row.source_origin === 'string' && row.source_origin) {
          scanned.add(row.source_origin);
        }
      }

      this.originsCache = { key: cacheKey, origins: [...scanned] };
    }

    for (const origin of this.originsCache.origins) origins.add(origin);

    return [...origins];
  }

  private unresolvedReason(
    sourceId: string,
    crosswalk: CandidateCrosswalk,
    targets: ReadonlyMap<string, string>,
  ): string {
    const status = crosswalk.statuses.get(sourceId);

    if (!status) return 'not migrated from this connection';
    // Mapped ids only end up unresolved when the existence check dropped their target.
    if (status === 'mapped' && !targets.has(sourceId)) {
      return 'migrated file no longer exists';
    }

    return `attachment was not migrated (${status})`;
  }

  private async reportUnresolved(
    scope: RelinkScope,
    issueKey: string,
    unresolved: Map<string, JiraAttachmentLink>,
    reasonOf: (sourceId: string) => string,
  ): Promise<void> {
    const entries = [...unresolved.values()].map((link) => ({
      ...link,
      reason: reasonOf(link.sourceId),
    }));
    const listed = entries
      .slice(0, MAX_UNRESOLVED_IN_MESSAGE)
      .map((entry) => `${entry.filename || entry.sourceId} (${entry.reason})`);
    const overflow = entries.length - listed.length;
    const summary = `${issueKey} — ${entries.length} linked ${
      entries.length === 1 ? 'document has' : 'documents have'
    } no migrated file: ${listed.join('; ')}${
      overflow > 0 ? `; …and ${overflow} more` : ''
    }`;

    await scope.log('warn', `jira_attachment_relink: ${summary}`, {
      issueKey,
      unresolvedLinks: entries,
    });
  }

  private async connectionBaseUrl(scope: RelinkScope): Promise<string | null> {
    const { data, error } = (await this.db
      .from('migration_connections')
      .select('base_url')
      .eq('id', scope.connectionId)
      .eq('organization_id', scope.orgId)
      .maybeSingle()) as {
      data: SourceConnection | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Failed to read Jira connection for attachment relinking: ${error.message}`,
      );
    }

    return data?.base_url ?? null;
  }

  private async task(
    scope: RelinkScope,
    taskId: string,
  ): Promise<TaskContent | null> {
    const { data, error } = (await this.db
      .from('tasks')
      .select('id, description')
      .eq('id', taskId)
      .eq('organization_id', scope.orgId)
      .maybeSingle()) as {
      data: TaskContent | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Failed to read mapped task for attachment relinking: ${error.message}`,
      );
    }

    return data;
  }

  private async comments(
    scope: RelinkScope,
    taskId: string,
  ): Promise<CommentContent[]> {
    const all: CommentContent[] = [];

    for (let offset = 0; ; offset += COMMENT_BATCH) {
      const { data, error } = (await this.db
        .from('task_comments')
        .select('id, content')
        .eq('organization_id', scope.orgId)
        .eq('task_id', taskId)
        .order('id', { ascending: true })
        .range(offset, offset + COMMENT_BATCH - 1)) as {
        data: CommentContent[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new MigrationItemError(
          'transient',
          `Failed to read comments for Jira attachment relinking: ${error.message}`,
        );
      }

      const rows = data ?? [];

      all.push(...rows);

      if (rows.length < COMMENT_BATCH) return all;
    }
  }

  private async writeColumn(args: {
    scope: RelinkScope;
    table: 'tasks' | 'task_comments';
    id: string;
    taskId: string;
    original: string;
    nextHtml: string;
  }): Promise<boolean> {
    // `allowTables` is mandatory here, not cosmetic. This rewrites rows TasksService already wrote
    // with tables permitted; sanitizing them again under a narrower policy would strip the grid out
    // of content that imported correctly. The exact-content guard below means that would
    // hit only the rows that happen to carry attachments — an intermittent, near-undebuggable loss.
    const sanitized =
      sanitizeRichText(args.nextHtml, { allowTables: true }) ?? '';

    // Do not turn a non-empty rich-text value into blank content because a malformed legacy value
    // made it through before migration. The attachment can still be opened from the task file list.
    if (!sanitized.trim()) {
      await args.scope.log(
        'warn',
        `jira_attachment_relink: ${args.table}.${args.id} was emptied by sanitization; left unchanged`,
      );

      return false;
    }

    // Keep potentially large HTML in the POST body; URL filters can exceed proxy limits.
    const { data, error } = (await this.db.rpc(
      'migration_compare_and_update_content',
      {
        p_organization_id: args.scope.orgId,
        p_task_id: args.taskId,
        p_comment_id: args.table === 'task_comments' ? args.id : null,
        p_expected: args.original,
        p_replacement: sanitized,
      },
    )) as {
      data: boolean | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Failed to relink ${args.table}.${args.id}: ${error.message}`,
      );
    }

    if (data !== true) {
      await args.scope.log(
        'warn',
        `jira_attachment_relink: ${args.table}.${args.id} changed concurrently; left unchanged`,
      );

      return false;
    }

    return true;
  }
}
