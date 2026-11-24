/**
 * @fileoverview `issues` stage — Jira issues → XISUITE tasks. The demo core, and the only stage
 * that must survive real volume: SDP alone holds 9,826 issues (measured, not guessed).
 *
 * RESUMABILITY: `produce` takes exactly ONE page per invocation and persists the source cursor on
 * the collection item's `checkpoint`. The engine re-leases the collection item until `done`, so a
 * backend restart mid-project resumes from the last page rather than re-reading 9,826 issues. The
 * adapter's generator is deliberately abandoned after one `next()` — it would otherwise page the
 * whole project into memory, which is exactly what the scale constraint forbids.
 *
 * PARENT GATING: `parentSourceRef` uses the engine's generic same-entity-type gate, so a sub-task
 * cannot be written before its parent has a crosswalk row — the engine physically cannot produce a
 * dangling `parent_task_id`. (The live test data has ZERO sub-tasks and ZERO epics, so this path is
 * built for real customers and cannot be exercised by SDP/KAN.)
 *
 * NEVER sets `tasks.key`: a BEFORE-INSERT trigger (`generate_task_key`) owns it under a per-space
 * advisory lock. Setting it from here desyncs `task_key_sequences_space` and 23505s later rows.
 */

import {
  ConflictException,
  HttpException,
  Injectable,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import {
  databaseBadRequest,
  databaseRetryClass,
} from '../../../common/utils/database-error';
import { migrationTaskIdentity } from './migration-task-identity.util';
import { TasksService } from '../../../tasks/tasks.service';
import { TaskPrioritiesService } from '../../../task-priorities/task-priorities.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import {
  jiraUserStableId,
  toXisuiteFieldValue,
} from '../../mappers/custom-field-value.mapper';
import {
  describeLoss,
  issueDescriptionToHtml,
} from '../../mappers/issue-body.mapper';
import type { NormalizedIssue } from '../../model/normalized';
import { isResolvedStatus } from './crosswalk-gate.util';
import { CUSTOM_FIELD_ENTITY } from './custom-fields.stage';
import { sanitizeLabels } from './issue-labels.util';
import { ISSUE_TYPE_ENTITY } from './issue-type.stage';
import {
  loadVisiblePriorityLadder,
  PRIORITY_ENTITY,
  priorityVisible,
  visiblePriorityByKey,
} from './priority.stage';
import { RESOLUTION_ENTITY } from './resolutions.stage';
import {
  blockedOnSpace,
  requireActingUser,
  resolveTargetSpace,
  runOptions,
  runScope,
} from './stage-helpers';
import { TASK_STATUS_ENTITY } from './task-status.stage';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type StageContext,
} from './stage.interface';
import { USER_ENTITY } from './users.stage';

export const ISSUES_STAGE = 'issues';
export const ISSUE_ENTITY = 'issue';

const DEFAULT_PAGE_SIZE = 100;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The SYSTEM fields the mapper needs. Custom fields are appended per-run by
 * `customFieldSourceIds()` — see there for why this list is not simply `*navigable`.
 */
const ISSUE_SYSTEM_FIELDS = [
  'summary',
  'description',
  'issuetype',
  'status',
  'priority',
  'assignee',
  'reporter',
  'parent',
  'labels',
  'resolution',
  // `resolutiondate` is a SEPARATE navigable field from `resolution` — requesting one does not
  // return the other, and the adapter maps them independently (resolvedAt vs resolution_id).
  'resolutiondate',
  'created',
  'updated',
  'duedate',
];

@Injectable()
export class IssuesStage implements IStageHandler {
  readonly stage = ISSUES_STAGE;

  constructor(
    private readonly tasksService: TasksService,
    @Optional() private readonly supabaseAdmin?: SupabaseAdminService,
    @Optional() private readonly priorities?: TaskPrioritiesService,
  ) {}

  /** ONE page per call; the cursor rides on the collection item's checkpoint. */
  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'issues stage: non-Jira source — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    const checkpoint = collectionItem.checkpoint ?? {};
    const cursor =
      typeof checkpoint.cursor === 'string' ? checkpoint.cursor : null;
    const options = runOptions(ctx);
    const pageSize =
      typeof options.batch_size === 'number' && options.batch_size > 0
        ? Math.min(options.batch_size, 100)
        : DEFAULT_PAGE_SIZE;

    // The admin's optional JQL narrows the migration. The adapter always AND-s in the project
    // predicate and forces a stable ORDER BY, so this can only narrow — never widen or redirect.
    const iterator = adapter.iterateIssues(ctx.job.source_ref, {
      cursor,
      pageSize,
      fields: [
        ...ISSUE_SYSTEM_FIELDS,
        ...(await this.customFieldSourceIds(ctx)),
      ],
      ...(runScope(ctx).jql ? { jql: runScope(ctx).jql } : {}),
    });
    // Exactly one page — then abandon the generator. Draining it would buffer the whole project.
    const first = await iterator.next();

    if (first.done || !first.value) {
      return { items: [], nextCheckpoint: null, done: true };
    }

    const page = first.value;

    return {
      items: page.items.map((issue) => ({
        entityType: ISSUE_ENTITY,
        sourceRef: issue.sourceId,
        // Generic same-entity-type gate: the engine blocks this item until the parent issue maps.
        ...(issue.parentSourceId
          ? { parentSourceRef: issue.parentSourceId }
          : {}),
        payload: {
          ...issue,
          migrationIdentity: migrationTaskIdentity(
            ctx.orgId,
            ctx.job.connection_id,
            issue.sourceId,
          ),
        } as unknown as Record<string, unknown>,
      })),
      nextCheckpoint: page.nextCursor ? { cursor: page.nextCursor } : null,
      done: page.nextCursor === null,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const issue = item.payload as unknown as NormalizedIssue | null;

    if (!issue?.sourceId) {
      throw new MigrationItemError(
        'permanent',
        'Issue item is missing its payload snapshot',
      );
    }

    const existing = await ctx.entityMap.getExistingTarget(
      ctx.orgId,
      ctx.job.connection_id,
      ISSUE_ENTITY,
      issue.sourceId,
      'tasks',
    );

    if (existing) {
      if (existing.status === 'mapped') {
        return {
          kind: 'skipped',
          reason: 'issue already mapped',
          targetId: existing.target_id,
        };
      }

      if (existing.status === 'planned' && ctx.dryRun) {
        return { kind: 'skipped', reason: 'already planned' };
      }
    }

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen) return blockedOnSpace(ctx);

    // ── Cross-entity gates. A miss BLOCKS rather than writing a task with a dangling reference.
    const typeRow = await this.gate(
      ctx,
      ISSUE_TYPE_ENTITY,
      issue.issueTypeSourceId,
    );

    if (!typeRow) {
      return {
        kind: 'blocked',
        waitingFor: {
          entityType: ISSUE_TYPE_ENTITY,
          sourceId: issue.issueTypeSourceId,
        },
      };
    }

    const statusRow = await this.gate(
      ctx,
      TASK_STATUS_ENTITY,
      issue.statusSourceId,
    );

    if (!statusRow) {
      return {
        kind: 'blocked',
        waitingFor: {
          entityType: TASK_STATUS_ENTITY,
          sourceId: issue.statusSourceId,
        },
      };
    }

    let priorityId: string | undefined;

    if (issue.prioritySourceId) {
      const row = await this.gate(ctx, PRIORITY_ENTITY, issue.prioritySourceId);

      if (!row) {
        return {
          kind: 'blocked',
          waitingFor: {
            entityType: PRIORITY_ENTITY,
            sourceId: issue.prioritySourceId,
          },
        };
      }

      priorityId = row.target_id;

      // The crosswalk is UNIQUE on (org, connection, entity_type, source_id) — connection-scoped —
      // while `task_priorities` rows are SPACE-scoped. One Jira connection serves many projects and
      // Jira priority ids are global per instance, so a run for project KAN rewrites the shared
      // crosswalk rows onto KAN-space targets. A later XMQ issue carrying the same priority id then
      // reads a target outside its own ladder, and `TasksService.create` rejects it with
      // `Invalid priority_id` — every issue of the second project, permanently.
      //
      // `priorities.stage` already guards itself this way (priority.stage.ts:137-184) by re-reading
      // what its space can actually see. `issues` had no equivalent. Check visibility before handing
      // the id over, and NEVER pass a foreign `priority_id` to `TasksService`.
      if (!ctx.dryRun && this.priorities) {
        const ladder = await loadVisiblePriorityLadder(
          ctx,
          this.priorities,
          spaceId,
        );

        if (!priorityVisible(ladder, row.target_id)) {
          const key = typeof row.source_key === 'string' ? row.source_key : '';

          // Preferred: re-anchor onto the SAME-KEY row this space exposes (org-wide first), exactly
          // as `PriorityStage.findAdoptablePriority` adopts. The `priorities` stage already created
          // this space's ladder from the same source keys, so a repair is unnecessary in practice.
          const sameKey = key ? visiblePriorityByKey(ladder, key) : undefined;

          if (sameKey) {
            priorityId = sameKey.id;
            await ctx.log(
              'warn',
              `issues: ${issue.key} — priority "${key || issue.prioritySourceId}" is mapped to a ` +
                `row outside the target space; using this space's "${sameKey.key ?? key}" instead`,
              { sourceId: issue.sourceId, priorityId: sameKey.id },
            );
          } else {
            // No same-key row to adopt: block rather than write a foreign id. The engine re-runs the
            // item (and can repair the mapping) exactly as it does for a missing parent.
            await ctx.log(
              'warn',
              `issues: ${issue.key} — priority mapping "${key || issue.prioritySourceId}" points ` +
                `outside the target space and no matching priority exists there; ` +
                `blocking until the priorities stage repairs it`,
              {
                sourceId: issue.sourceId,
                prioritySourceId: issue.prioritySourceId,
                strandedTargetId: row.target_id,
              },
            );

            return {
              kind: 'blocked',
              waitingFor: {
                entityType: PRIORITY_ENTITY,
                sourceId: issue.prioritySourceId,
              },
            };
          }
        }
      }
    }

    // Resolution is BEST-EFFORT, unlike status/priority above: the resolutions stage adopts the
    // org's seeded rows, but an unmapped resolution must never cost the task — the pre-existing
    // behaviour was "no resolution at all", so degrading to that is strictly no worse. `resolved_at`
    // is carried independently of the id: "resolved on date X" is true regardless of whether the
    // resolution NAME mapped.
    let resolutionId: string | undefined;

    if (issue.resolutionSourceId) {
      const row = await this.gate(
        ctx,
        RESOLUTION_ENTITY,
        issue.resolutionSourceId,
      );

      if (row) {
        resolutionId = row.target_id;
      } else {
        await ctx.log(
          'warn',
          `issues: ${issue.key} — resolution "${issue.resolutionName ?? issue.resolutionSourceId}" ` +
            `is not mapped; the task keeps its resolved date but no resolution`,
          { sourceId: issue.sourceId },
        );
      }
    }

    let parentTaskId: string | undefined;

    if (issue.parentSourceId) {
      const row = await this.gate(ctx, ISSUE_ENTITY, issue.parentSourceId);

      if (!row) {
        return {
          kind: 'blocked',
          waitingFor: {
            entityType: ISSUE_ENTITY,
            sourceId: issue.parentSourceId,
          },
        };
      }

      parentTaskId = row.target_id;
    }

    // Assignee is BEST-EFFORT: the users stage maps by email → placeholder, but an issue can carry
    // an assignee who is not a project member (deactivated, deleted). An unmapped assignee must not
    // block a task — losing the task is far worse than losing its assignee.
    let assignedTo: string | undefined;

    if (issue.assigneeSourceId) {
      const row = await this.gate(ctx, USER_ENTITY, issue.assigneeSourceId);

      if (row) assignedTo = row.target_id;
      else
        await ctx.log('warn', `issues: unmapped assignee for ${issue.key}`, {
          assigneeSourceId: issue.assigneeSourceId,
        });
    }

    // Reporter, same best-effort rule. `reporter` was already being FETCHED (it is in ISSUE_FIELDS)
    // and then thrown away, so `TasksService.create` fell back to `reporter ?? userId` — attributing
    // every migrated issue to whoever happened to run the migration. On the live data that is 25/25
    // issues silently reassigned from christian.kienzl to the operator: attribution loss with no
    // error, on every task.
    let reporter: string | undefined;

    if (issue.reporterSourceId) {
      const row = await this.gate(ctx, USER_ENTITY, issue.reporterSourceId);

      if (row) reporter = row.target_id;
      else
        await ctx.log(
          'warn',
          `issues: unmapped reporter for ${issue.key} — task will be attributed to the migration runner`,
          { reporterSourceId: issue.reporterSourceId },
        );
    }

    const customFieldValues = await this.mapCustomFieldValues(ctx, issue);
    const descriptionHtml = issueDescriptionToHtml(issue.description);
    const loss = describeLoss(issue.description);

    if (loss) {
      await ctx.log('warn', `issues: ${issue.key} — ${loss}`, {
        sourceId: issue.sourceId,
      });
    }

    const labels = sanitizeLabels(issue.labels);

    // Judged in dry runs too, so a rehearsal predicts the conflict a live run would hit.
    const { adoptTargetId } = await this.resolveLegacyAttempts(
      ctx,
      issue.sourceId,
      spaceId,
    );

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: ISSUE_ENTITY,
        sourceId: issue.sourceId,
        sourceKey: issue.key,
        targetTable: 'tasks',
        targetId: `planned:${issue.key}`,
        status: 'planned',
        metadata: {
          key: issue.key,
          summary: issue.summary,
          task_type_id: typeRow.target_id,
          has_description: !!descriptionHtml,
          custom_field_count: Object.keys(customFieldValues).length,
          label_count: labels.length,
          ...(loss ? { lossy: loss } : {}),
        },
      });

      return { kind: 'planned' };
    }

    const identity = migrationTaskIdentity(
      ctx.orgId,
      ctx.job.connection_id,
      issue.sourceId,
    );
    const persistedIdentity = item.payload?.migrationIdentity as
      | typeof identity
      | undefined;
    if (
      persistedIdentity?.version !== identity.version ||
      persistedIdentity?.targetId !== identity.targetId
    ) {
      throw new MigrationItemError(
        'conflict',
        'Legacy issue has no durable target identity; explicitly reconcile its target mapping before retrying',
      );
    }
    if (adoptTargetId) {
      // The legacy attempt's task is still live here: map it instead of creating a duplicate.
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: ISSUE_ENTITY,
        sourceId: issue.sourceId,
        sourceKey: issue.key,
        targetTable: 'tasks',
        targetId: adoptTargetId,
        status: 'mapped',
        metadata: {
          key: issue.key,
          task_type_id: typeRow.target_id,
          adopted_legacy_target: true,
        },
      });
      await ctx.log(
        'warn',
        `issues: ${issue.key} adopted the task a pre-identity run created instead of creating a duplicate`,
        { sourceId: issue.sourceId, targetId: adoptTargetId },
      );

      return {
        kind: 'skipped',
        reason: 'adopted legacy target',
        targetId: adoptTargetId,
      };
    }
    let adopted = false;
    let created: { id: string };

    try {
      created = await this.tasksService.create(
        ctx.orgId,
        requireActingUser(ctx),
        {
          space_id: spaceId!,
          // `summary` — NOT `title`; CreateTaskDto has no title alias and the whitelist validator
          // would drop it, failing the required-field check.
          summary: issue.summary || issue.key,
          task_type_id: typeRow.target_id,
          // TasksService.create sanitizes this itself — do NOT pre-sanitize.
          ...(descriptionHtml ? { description: descriptionHtml } : {}),
          // Pass status_id ONLY: passing a `status` key too throws when it disagrees with the id, and
          // the legacy text column is derived (and bucketed) by the service.
          status_id: statusRow.target_id,
          ...(priorityId ? { priority_id: priorityId } : {}),
          ...(assignedTo ? { assigned_to: assignedTo } : {}),
          // Omitted when unmapped so the service's own `reporter ?? userId` fallback applies.
          ...(reporter ? { reporter } : {}),
          ...(parentTaskId ? { parent_task_id: parentTaskId } : {}),
          ...(Object.keys(customFieldValues).length > 0
            ? { custom_field_values: customFieldValues }
            : {}),
          // Sanitized, not passed through: `CreateTaskDto.labels` is `@IsArray()` and nothing else,
          // and `tasks.labels` is untyped jsonb, so nothing between here and the task UI would
          // reject a null, a 40 KB string, or ten thousand entries.
          ...(labels.length > 0 ? { labels } : {}),
          ...(issue.dueDate ? { due_date: issue.dueDate } : {}),
          // `key` is trigger-owned — never set it.
        },
        {
          // Replay the SOURCE's status instead of the workflow's start node. A migration reproduces
          // history: an issue that is "In Progress" in Jira must not arrive as "To Do" just because
          // a workflow was assigned moments earlier in this same run.
          migrationIdentity: {
            targetId: identity.targetId,
            onAdopt: () => {
              adopted = true;
            },
          },
          preserveProvidedStatus: true,
          awaitImportCompletion: true,
          // Likewise for dates: a migrated task must carry the date it was really created in Jira,
          // not the instant this run happened to write it.
          sourceTimestamps: {
            createdAt: issue.created,
            updatedAt: issue.updated,
          },
          ...(resolutionId || issue.resolutionDate
            ? {
                resolution: {
                  ...(resolutionId ? { resolutionId } : {}),
                  ...(issue.resolutionDate
                    ? { resolvedAt: issue.resolutionDate }
                    : {}),
                },
              }
            : {}),
        },
      );
    } catch (err) {
      const retryClass = databaseRetryClass(err);
      if (retryClass)
        throw new MigrationItemError(
          retryClass,
          `Issue ${issue.key}: target database temporarily unavailable`,
        );
      if (err instanceof ConflictException)
        throw new MigrationItemError('conflict', err.message);
      if (
        err instanceof HttpException &&
        err.getStatus() >= 400 &&
        err.getStatus() < 500
      ) {
        throw new MigrationItemError(
          'permanent',
          `Issue ${issue.key} rejected: ${err.message}`,
        );
      }

      throw err;
    }

    if (adopted) {
      await ctx.log(
        'warn',
        `issues: ${issue.key} adopted its durable target; creation side effects may be incomplete and were not replayed`,
        {
          sourceId: issue.sourceId,
          targetId: created.id,
          creationEffects: 'unknown',
        },
      );
    }
    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: ISSUE_ENTITY,
      sourceId: issue.sourceId,
      sourceKey: issue.key,
      targetTable: 'tasks',
      targetId: created.id,
      status: 'mapped',
      metadata: {
        key: issue.key,
        task_type_id: typeRow.target_id,
        has_description: !!descriptionHtml,
        assignee_mapped: !!assignedTo,
        label_count: labels.length,
        resolution_mapped: !!resolutionId,
        ...(adopted
          ? { creation_effects: 'unknown', adopted_target: true }
          : {}),
        ...(loss ? { lossy: loss } : {}),
      },
    });

    return { kind: 'created', targetId: created.id, targetTable: 'tasks' };
  }

  /**
   * Live attempts made before durable identities existed used random task ids, so a lost insert
   * response could have left a task no crosswalk points at. Each such attempt is judged on what it
   * provably did rather than refused wholesale — a blanket refusal deadlocked every later run once
   * the legacy targets were deleted (retry could never succeed):
   * - failed `permanent` / skipped → never wrote a task (TasksService.create throws no 4xx after
   *   its insert, and the orphan guard fails items that never ran);
   * - succeeded with a target that no longer exists → nothing left to duplicate;
   * - succeeded with a target still live in this space → returned for ADOPTION, not re-created.
   * Anything else (transient, dead, running, a live target in another space) stays a conflict.
   */
  private async resolveLegacyAttempts(
    ctx: StageContext,
    sourceId: string,
    spaceId: string | null | undefined,
  ): Promise<{ adoptTargetId: string | null }> {
    if (!this.supabaseAdmin)
      throw new MigrationItemError(
        'transient',
        'Migration identity history lookup unavailable',
      );
    const db = this.supabaseAdmin.getClient();
    const lookupFailed = (r: { error: unknown; status?: number }) => {
      const error = databaseBadRequest(
        r.error as { message: string },
        r.status,
      );
      return new MigrationItemError(
        databaseRetryClass(error) ?? 'transient',
        'Could not verify historical issue identity; retry after the lookup is available',
      );
    };
    // Search all live runs on this connection, including different jobs/repair runs. A legacy
    // response could have been lost after its random-ID insert; an empty crosswalk proves nothing.
    const r = (await db
      .from('migration_run_items')
      .select(
        'id, run_id, status, error_class, target_id, migration_runs!inner(connection_id, mode)',
      )
      .eq('organization_id', ctx.orgId)
      .eq('entity_type', ISSUE_ENTITY)
      .eq('source_ref', sourceId)
      .eq('item_kind', 'entity')
      .eq('migration_runs.connection_id', ctx.job.connection_id)
      .eq('migration_runs.mode', 'live')
      .is('payload->migrationIdentity', null)
      .limit(1000)) as {
      data:
        | {
            run_id: string;
            status: string;
            error_class: string | null;
            target_id: string | null;
          }[]
        | null;
      error: unknown;
      status?: number;
    };
    if (r.error) throw lookupFailed(r);

    const attempts = r.data ?? [];
    if (attempts.length === 0) return { adoptTargetId: null };

    const conflict = (runId: string | undefined, why: string) =>
      new MigrationItemError(
        'conflict',
        `A historical issue attempt (run ${runId?.slice(0, 8) ?? 'unknown'}) ${why}; explicitly reconcile its target mapping before retrying`,
      );

    const targetIds = new Set<string>();
    for (const a of attempts) {
      if (a.status === 'skipped') continue;
      if (a.status === 'failed' && a.error_class === 'permanent') continue;
      if (a.status === 'succeeded' && a.target_id) {
        targetIds.add(a.target_id);
        continue;
      }
      throw conflict(
        a.run_id,
        `ended "${a.status}"${a.error_class ? ` (${a.error_class})` : ''} and may have written a task without a durable target identity`,
      );
    }
    if (targetIds.size === 0) return { adoptTargetId: null };

    const ids = [...targetIds].filter((id) => UUID_RE.test(id));
    if (ids.length !== targetIds.size)
      throw conflict(attempts[0].run_id, 'recorded a non-task target');
    const live = (await db
      .from('tasks')
      .select('id, space_id')
      .eq('organization_id', ctx.orgId)
      .in('id', ids)
      .limit(ids.length)) as {
      data: { id: string; space_id: string | null }[] | null;
      error: unknown;
      status?: number;
    };
    if (live.error) throw lookupFailed(live);

    const rows = live.data ?? [];
    if (rows.length === 0) return { adoptTargetId: null };
    if (rows.length > 1 || !spaceId || rows[0].space_id !== spaceId)
      throw conflict(
        attempts[0].run_id,
        rows.length > 1
          ? `left ${rows.length} live tasks`
          : 'left a live task in a different space',
      );

    return { adoptTargetId: rows[0].id };
  }

  /**
   * A crosswalk row that is usable for writing, or null (caller decides block vs degrade).
   *
   * `placeholder` counts as resolved. The users stage records an unmatched Jira user as a linked
   * PLACEHOLDER with `status: 'placeholder'` (users.stage.ts:153), not `'mapped'` — and treats both
   * as resolved itself (users.stage.ts:98). Placeholders exist precisely to carry attribution for
   * users who have no XISUITE account, so rejecting them here would silently drop the assignee of
   * every issue whose owner did not email-match: a real target row exists and we would ignore it.
   */
  private async gate(
    ctx: StageContext,
    entityType: string,
    sourceId: string,
  ): Promise<{
    target_id: string;
    source_key: string | null;
  } | null> {
    if (!sourceId) return null;

    const row = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      entityType,
      sourceId,
    );

    if (!row) return null;

    return isResolvedStatus(row.status, ctx.dryRun) ? row : null;
  }

  /**
   * Jira custom field values keyed by SOURCE field id → `custom_field_values` keyed by the TEXT
   * `field_key` that read paths expect.
   *
   * Only fields the custom_fields stage actually migrated are carried: its crosswalk rows for
   * `native`/`skip` outcomes have no `field_key` in metadata, so plugin-internal noise (the
   * devstatus blob, LexoRank) filters out here by construction rather than by a second exclusion
   * list that could drift from the registry's.
   */
  /**
   * The custom-field ids to request alongside the system fields, resolved per run from the
   * crosswalk the `custom_fields` stage (which runs earlier in STAGE_ORDER) already populated.
   *
   * Asking for exactly the materialised set is what makes fetching values safe: `*navigable` would
   * pull the multi-KB devstatus blob on every issue, and the previous hardcoded system-only list
   * fetched nothing — so `mapCustomFieldValues` always received an empty `issue.customFields` and
   * every migrated task landed with `custom_field_values = {}` despite its definitions existing.
   */
  private async customFieldSourceIds(ctx: StageContext): Promise<string[]> {
    try {
      return await ctx.entityMap.listMappedCustomFieldSourceIds(
        ctx.orgId,
        ctx.job.connection_id,
      );
    } catch (err) {
      // Values are additive — never fail the whole issues stage over them. Say so and carry on
      // with system fields, rather than silently importing issues with no custom data.
      await ctx.log(
        'warn',
        `issues: could not resolve migrated custom fields — values will be omitted: ${(err as Error).message}`,
      );

      return [];
    }
  }

  private async mapCustomFieldValues(
    ctx: StageContext,
    issue: NormalizedIssue,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const sourceIds = Object.keys(issue.customFields ?? {});

    if (sourceIds.length === 0) return out;

    const rows = await ctx.entityMap.getTargets(
      ctx.orgId,
      ctx.job.connection_id,
      CUSTOM_FIELD_ENTITY,
      sourceIds,
    );
    const userIds = await this.resolveUserIdsForFields(ctx, issue);

    for (const sourceId of sourceIds) {
      const row = rows.get(sourceId);

      if (!row || row.status !== 'mapped') continue;

      const meta = row.metadata ?? {};

      if (meta.outcome !== 'custom_field') continue;

      const fieldKey =
        typeof meta.field_key === 'string' ? meta.field_key : null;

      if (!fieldKey) continue;

      const value = issue.customFields[sourceId];

      if (value === null || value === undefined) continue;

      // Jira's RAW shape is not storable: an option is `{id, self, value, disabled}` and the
      // renderer looks options up by scalar id. Writing the blob through put correct-looking data
      // in the DB and a BLANK task page (`Objects are not valid as a React child`).
      const fieldType =
        typeof meta.field_type === 'string' ? meta.field_type : 'string';
      const mapped = toXisuiteFieldValue(
        value,
        fieldType,
        (userSourceId) => userIds.get(userSourceId) ?? null,
      );

      if (mapped === undefined) continue;

      out[fieldKey] = mapped;
    }

    return out;
  }

  /**
   * Jira user stable id → XISUITE user id, for the user-picker custom fields on this issue.
   *
   * Resolved in ONE batch rather than per field: an issue can carry several user pickers, and the
   * crosswalk lookup is the same for all of them.
   */
  private async resolveUserIdsForFields(
    ctx: StageContext,
    issue: NormalizedIssue,
  ): Promise<Map<string, string>> {
    const sourceIds = new Set<string>();

    for (const value of Object.values(issue.customFields ?? {})) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        const id = jiraUserStableId(entry);

        if (id) sourceIds.add(id);
      }
    }

    const out = new Map<string, string>();

    if (sourceIds.size === 0) return out;

    const rows = await ctx.entityMap.getTargets(
      ctx.orgId,
      ctx.job.connection_id,
      USER_ENTITY,
      [...sourceIds],
    );

    for (const [sourceId, row] of rows) {
      // `placeholder` counts as resolved — that is what placeholders exist for.
      if (
        isResolvedStatus(row.status, ctx.dryRun) &&
        row.status !== 'planned'
      ) {
        out.set(sourceId, row.target_id);
      }
    }

    return out;
  }
}
