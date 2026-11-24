/**
 * @fileoverview `history` stage — Jira issue changelog → `task_history`, so a migrated task keeps
 * its audit trail instead of appearing to have been created today with no past.
 *
 * WRITES THE TABLE DIRECTLY, and that is deliberate. The obvious alternative — replay each change
 * through `TasksService.update` — would be wrong twice over:
 *  - `comments.stage.ts:7` documents that pushing historical records through the service fires the
 *    automations/notification engine (email, Slack, Teams, SMS, webhook). Replaying years of Jira
 *    history would spam real people with notifications about changes made long ago.
 *  - It would also mutate the task, walking `status`/`assignee` backwards through every past value
 *    and leaving the task on whatever the OLDEST change said. The issues stage already imported the
 *    current state; history must describe the past, not re-enact it.
 *
 * The `tasks_history_trigger` on INSERT already writes one `create` row per migrated task, but with
 * `changed_at = now()`. This stage rewrites that row to the source's real creation instant and
 * author, so the timeline starts where Jira says it started rather than at import time.
 *
 * IDEMPOTENCE: `task_history` has no natural unique key, so a re-run would duplicate the timeline.
 * The crosswalk is the guard — one row per Jira changelog entry id, checked before writing.
 */

import { Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import type { NormalizedHistoryEntry } from '../../model/normalized';
import { isResolvedStatus } from './crosswalk-gate.util';
import { ISSUE_ENTITY } from './issues.stage';
import { runScope } from './stage-helpers';
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

export const HISTORY_STAGE = 'history';
export const HISTORY_ENTITY = 'history';

const TABLE = 'task_history';

/**
 * Jira field name → the `field_name` the History tab already knows how to label
 * (`TaskHistoryPanel.FIELD_KEYS`). Anything unmapped keeps its Jira name, which still renders.
 */
const FIELD_NAME_MAP: Readonly<Record<string, string>> = {
  status: 'status',
  assignee: 'assigned_to',
  reporter: 'reporter',
  priority: 'priority',
  summary: 'summary',
  description: 'description',
  duedate: 'due_date',
  issuetype: 'task_type_id',
  parent: 'parent_task_id',
  timeestimate: 'estimated_time',
  timespent: 'actual_time',
};

/** The action vocabulary `TaskHistoryPanel.ACTION_CONFIG` renders. */
function actionFor(field: string): string {
  const f = field.toLowerCase();

  if (f === 'status') return 'status_change';
  if (f === 'assignee') return f === 'assignee' ? 'assign' : 'update';

  return 'update';
}

interface HistoryPayload {
  issueSourceId: string;
  issueKey: string;
}

interface HistoryRow {
  task_id: string;
  organization_id: string;
  action: string;
  field_name: string | null;
  old_value: unknown;
  new_value: unknown;
  changed_by: string | null;
  changed_at: string | undefined;
}

@Injectable()
export class HistoryStage implements IStageHandler {
  readonly stage = HISTORY_STAGE;

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * One item per ISSUE, not per changelog entry: the changelog is only readable per issue, so a
   * per-entry item would need the whole history fetched during produce anyway. One item per issue
   * keeps the fetch where the work is and stays resumable.
   */
  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'history stage: non-Jira source — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    const checkpoint = collectionItem.checkpoint ?? {};
    const cursor =
      typeof checkpoint.cursor === 'string' ? checkpoint.cursor : null;

    const iterator = adapter.iterateIssues(ctx.job.source_ref, {
      cursor,
      pageSize: 50,
      // Only the key is needed; the changelog is fetched per issue in processItem.
      fields: ['summary'],
      ...(runScope(ctx).jql ? { jql: runScope(ctx).jql } : {}),
    });
    const first = await iterator.next();

    if (first.done || !first.value) {
      return { items: [], nextCheckpoint: null, done: true };
    }

    const page = first.value;
    const items: SeedItem[] = page.items.map((issue) => ({
      entityType: HISTORY_ENTITY,
      sourceRef: issue.sourceId,
      payload: {
        issueSourceId: issue.sourceId,
        issueKey: issue.key,
      } as unknown as Record<string, unknown>,
    }));

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
    const payload = item.payload as unknown as HistoryPayload | null;

    if (!payload?.issueSourceId) {
      throw new MigrationItemError(
        'permanent',
        'History item is missing its payload snapshot',
      );
    }

    const existing = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      HISTORY_ENTITY,
      payload.issueSourceId,
    );

    if (existing?.status === 'mapped') {
      return { kind: 'skipped', reason: 'history already migrated' };
    }

    // The task must exist — history with no task is nothing.
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

    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      return { kind: 'skipped', reason: 'non-Jira source' };
    }

    const entries = await adapter.getIssueHistory(payload.issueSourceId);

    if (ctx.dryRun) {
      await this.record(ctx, payload, `planned:${payload.issueSourceId}`, {
        entry_count: entries.length,
      });

      return { kind: 'planned' };
    }

    const rows = await this.toRows(ctx, taskRow.target_id, entries);

    if (rows.length > 0) {
      const { error } = await this.db.from(TABLE).insert(rows);

      if (error) {
        throw new MigrationItemError(
          'transient',
          `History insert failed for ${payload.issueKey}: ${error.message}`,
        );
      }
    }

    await this.alignCreationRow(ctx, taskRow.target_id);
    await this.record(ctx, payload, taskRow.target_id, {
      entry_count: entries.length,
      row_count: rows.length,
    });

    return {
      kind: rows.length > 0 ? 'created' : 'skipped',
      ...(rows.length === 0 ? { reason: 'issue has no changelog' } : {}),
      targetId: taskRow.target_id,
      targetTable: TABLE,
    };
  }

  /** Flatten changelog entries into one row per changed field, author and instant preserved. */
  private async toRows(
    ctx: StageContext,
    taskId: string,
    entries: NormalizedHistoryEntry[],
  ): Promise<HistoryRow[]> {
    const authorIds = await this.resolveAuthors(ctx, entries);
    const rows: HistoryRow[] = [];

    for (const entry of entries) {
      const changedBy = entry.authorSourceId
        ? (authorIds.get(entry.authorSourceId) ?? null)
        : null;

      for (const change of entry.items) {
        if (!change.field) continue;

        rows.push({
          task_id: taskId,
          organization_id: ctx.orgId,
          action: actionFor(change.field),
          field_name:
            FIELD_NAME_MAP[change.field.toLowerCase()] ?? change.field,
          // Store the DISPLAY text, not Jira's internal ids: the History tab renders these values
          // straight to the user, and "10000 -> 3" is meaningless to a reader.
          old_value: change.fromString ?? change.from ?? null,
          new_value: change.toString ?? change.to ?? null,
          changed_by: changedBy,
          changed_at: entry.created,
        });
      }
    }

    return rows;
  }

  /**
   * Point the trigger-generated `create` row at the source's real creation instant.
   *
   * `tasks_history_trigger` fires on INSERT and stamps `changed_at = now()`, so without this every
   * migrated task's timeline opens with "created" at import time — directly contradicting the
   * `created_at` the issues stage now preserves.
   */
  private async alignCreationRow(
    ctx: StageContext,
    taskId: string,
  ): Promise<void> {
    const { data, error } = (await this.db
      .from('tasks')
      .select('created_at, reporter')
      .eq('id', taskId)
      .eq('organization_id', ctx.orgId)
      .maybeSingle()) as {
      data: { created_at: string; reporter: string | null } | null;
      error: { message: string } | null;
    };

    if (error || !data?.created_at) return;

    // Best-effort: a missing or already-correct row is not a failure worth losing the import over.
    await this.db
      .from(TABLE)
      .update({ changed_at: data.created_at, changed_by: data.reporter })
      .eq('task_id', taskId)
      .eq('organization_id', ctx.orgId)
      .eq('action', 'create');
  }

  /** Jira author id → XISUITE user id, resolved once per issue. */
  private async resolveAuthors(
    ctx: StageContext,
    entries: NormalizedHistoryEntry[],
  ): Promise<Map<string, string>> {
    const sourceIds = [
      ...new Set(
        entries.map((e) => e.authorSourceId).filter((id): id is string => !!id),
      ),
    ];
    const out = new Map<string, string>();

    if (sourceIds.length === 0) return out;

    const rows = await ctx.entityMap.getTargets(
      ctx.orgId,
      ctx.job.connection_id,
      USER_ENTITY,
      sourceIds,
    );

    for (const [sourceId, row] of rows) {
      if (
        isResolvedStatus(row.status, ctx.dryRun) &&
        row.status !== 'planned'
      ) {
        out.set(sourceId, row.target_id);
      }
    }

    return out;
  }

  private async record(
    ctx: StageContext,
    payload: HistoryPayload,
    targetId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: HISTORY_ENTITY,
      sourceId: payload.issueSourceId,
      sourceKey: payload.issueKey,
      targetTable: TABLE,
      targetId,
      status: ctx.dryRun ? 'planned' : 'mapped',
      metadata: { issue: payload.issueKey, ...metadata },
    });
  }
}
