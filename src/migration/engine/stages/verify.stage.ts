/**
 * @fileoverview `verify` stage — the terminal node of BOTH stage orders. Reconciles what the source
 * holds against what the crosswalk says we wrote, and records the result on the run.
 *
 * This exists because every other guarantee in the engine is local: a stage reports `created`, an
 * item reports `succeeded`, and a run with no failures reports success — none of which proves the
 * TARGET actually holds what the SOURCE did. This project has already shipped a "10/10 PASS" that
 * passed by luck while ~598/600 pages were silently truncated; counting at the end is the cheap,
 * global check that catches that class of lie.
 *
 * It never fails a run on a shortfall by throwing: the shortfall IS the finding, and it is recorded
 * as a `warn` log plus `run.totals.verification` so the operator sees a number, not an exception.
 * (`migration_run_items` counts already drive status; this reconciles against the SOURCE.)
 */

import { Injectable } from '@nestjs/common';
import {
  isConfluenceAdapter,
  isJiraAdapter,
} from '../../adapters/source-adapter.interface';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { ISSUE_ENTITY } from './issues.stage';
import { PAGE_ENTITY } from './pages.stage';
import { CONFLUENCE_PAGE_REPAIR_STAGE } from './confluence-page-repair.stage';
import { resolveTargetSpace, runScope } from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type StageContext,
} from './stage.interface';

export const VERIFY_STAGE = 'verify';
export const VERIFY_ENTITY = 'verification';

const RUNS = 'migration_runs';

export interface EntityReconciliation {
  entityType: string;
  /** What the source reports it holds; null when the source cannot count (Cloud token search). */
  sourceCount: number | null;
  /** Crosswalk rows we actually wrote (`mapped`), or planned in a dry run. */
  targetCount: number;
  /** sourceCount - targetCount when both are known; null when the source count is unknown. */
  shortfall: number | null;
}

@Injectable()
export class VerifyStage implements IStageHandler {
  readonly stage = VERIFY_STAGE;

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Report any planned stage that produced no collection item — i.e. never ran at all.
   *
   * Counts alone cannot see this. Reconciliation covers the entity types it knows about (pages), so a
   * stage that silently vanished reconciles perfectly: nothing was expected of it. Observed live — a
   * transient error while seeding a stage's collection item let the engine advance straight past
   * `page_attachments`, and the run finished `succeeded` with 0 of 281 attachments, no failed item and
   * nothing in the run's logs. The engine ordering that allowed it is fixed, but this is the net that
   * should have caught it, and it costs one local query and no source requests.
   */
  private async reportSkippedStages(ctx: StageContext): Promise<void> {
    const plan = (ctx.run.config_snapshot?.stage_plan ?? []) as string[];

    if (plan.length === 0) return;

    const { data: rows, error } = (await this.db
      .from('migration_run_items')
      .select('stage, status')
      .eq('organization_id', ctx.orgId)
      .eq('run_id', ctx.run.id)
      .eq('item_kind', 'collection')) as {
      data: { stage: string; status: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      await ctx.log(
        'warn',
        `verify: could not check stage coverage: ${error.message}`,
      );

      return;
    }

    const ran = new Set((rows ?? []).map((r) => r.stage));
    // `verify` is running right now, so its own item may not be visible as terminal yet.
    const missing = plan.filter(
      (stage) => stage !== VERIFY_STAGE && !ran.has(stage),
    );

    if (missing.length === 0) return;

    await ctx.log(
      'warn',
      `verify: ${missing.length} planned stage(s) never ran — ${missing.join(', ')}. ` +
        `Anything they were responsible for is MISSING from this migration.`,
      { skippedStages: missing },
    );
  }

  /** ONE aggregate item — reconciliation is a single whole-run question. */
  produce(ctx: StageContext): Promise<ProduceResult> {
    return Promise.resolve({
      items: [
        {
          entityType: VERIFY_ENTITY,
          sourceRef: `verify:${ctx.job.source_ref}`,
        },
      ],
      nextCheckpoint: null,
      done: true,
    });
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const adapter = await ctx.getAdapter();
    const reconciliations: EntityReconciliation[] = [];

    // The primary entity is the one a user counts: issues for Jira, pages for Confluence. Both
    // adapters expose a cheap count for exactly this.
    if (isJiraAdapter(adapter)) {
      reconciliations.push(
        await this.reconcile(
          ctx,
          ISSUE_ENTITY,
          // MUST pass the job's JQL. Counting the whole project while the run migrated a filtered
          // slice reports a phantom shortfall on every filtered run — verified live: a bounded
          // `key <= SDP-25` run (25 issues, 0 failures) was reported as "source reports 9826,
          // 25 migrated (9801 missing)". A reconciliation that cries wolf is worse than none: it
          // trains operators to ignore the one signal that catches real loss.
          await this.safeCount(ctx, () =>
            adapter.countIssues(ctx.job.source_ref, runScope(ctx).jql),
          ),
        ),
      );
    } else if (
      isConfluenceAdapter(adapter) &&
      ctx.run.config_snapshot?.repair_of_run_id
    ) {
      // Repairs enumerate the original import's eligible page snapshots, not the whole source
      // space. Include skipped user-edited pages in that inventory without changing their content.
      const { count, error } = await this.db
        .from('migration_run_items')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.orgId)
        .eq('run_id', ctx.run.id)
        .eq('entity_type', CONFLUENCE_PAGE_REPAIR_STAGE)
        .eq('item_kind', 'entity');
      if (error)
        throw new MigrationItemError(
          'transient',
          `Repair inventory count failed: ${error.message}`,
        );
      reconciliations.push(await this.reconcile(ctx, PAGE_ENTITY, count ?? 0));
    } else if (isConfluenceAdapter(adapter)) {
      // Deliberately NOT `countPages`: that is the wizard's one-request CQL estimate, and CQL reads
      // an index that disagrees with the content — on M0 it omits the space homepage (10382 vs a
      // true 10383). Reconciling against it is the worst possible error: migrate 10382 of 10383 and
      // the counts "match", so a genuinely lost page reports as reconciled. Counting through
      // `iteratePages` makes the denominator exactly what the migration itself would enumerate, and
      // costs ~52 requests once, at the end of a run.
      const spaceCount = await this.safeCount(ctx, async () => {
        let n = 0;

        for await (const batch of adapter.iteratePages(ctx.job.source_ref, {
          pageSize: 200,
        })) {
          n += batch.items.length;
        }

        return n;
      });

      // Every import migrates the whole space, so the whole space is the expectation.
      reconciliations.push(await this.reconcile(ctx, PAGE_ENTITY, spaceCount));
    }

    // Structural check, before any count: did every planned stage actually RUN?
    await this.reportSkippedStages(ctx);

    const shortfalls = reconciliations.filter(
      (r) => r.shortfall !== null && r.shortfall > 0,
    );

    for (const r of shortfalls) {
      await ctx.log(
        'warn',
        `verify: ${r.entityType} — source reports ${r.sourceCount}, ${r.targetCount} migrated ` +
          `(${r.shortfall} missing)`,
        { entityType: r.entityType },
      );
    }

    const unknown = reconciliations.filter((r) => r.sourceCount === null);

    for (const r of unknown) {
      // Never let "couldn't count" masquerade as "counts match".
      await ctx.log(
        'warn',
        `verify: ${r.entityType} — source could not report a total; ` +
          `${r.targetCount} migrated, reconciliation INCONCLUSIVE`,
        { entityType: r.entityType },
      );
    }

    if (shortfalls.length === 0 && unknown.length === 0) {
      await ctx.log(
        'info',
        `verify: reconciled — ${reconciliations
          .map((r) => `${r.entityType} ${r.targetCount}/${r.sourceCount}`)
          .join(', ')}`,
      );
    }

    await this.recordOnRun(ctx, reconciliations);

    if (!ctx.dryRun && isJiraAdapter(adapter)) {
      const ready = await this.db.rpc('sla_mark_import_run_ready', {
        p_organization_id: ctx.orgId,
        p_run_id: ctx.run.id,
      });
      if (ready.error) {
        throw new MigrationItemError(
          'transient',
          `SLA import readiness failed: ${ready.error.message}`,
        );
      }
    }

    // Recorded, not thrown: the shortfall is the finding. Failing the item here would mark the run
    // `partially_completed` for a reason the item counts already express, and would bury the number.
    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: VERIFY_ENTITY,
      sourceId: item.source_ref ?? `verify:${ctx.job.source_ref}`,
      sourceKey: ctx.job.source_ref,
      targetTable: null,
      targetId: `verify:${ctx.run.id}`,
      status: ctx.dryRun ? 'planned' : 'mapped',
      metadata: {
        reconciliations: reconciliations as unknown as Record<
          string,
          unknown
        >[],
        shortfall_count: shortfalls.length,
        inconclusive_count: unknown.length,
      },
    });

    if (ctx.dryRun) return { kind: 'planned' };

    return {
      kind: 'skipped',
      reason:
        shortfalls.length > 0
          ? `reconciliation found ${shortfalls.length} shortfall(s)`
          : 'reconciled',
    };
  }

  /** A source count, or null when the source cannot report one — never a fabricated 0. */
  private async safeCount(
    ctx: StageContext,
    fn: () => Promise<number | null>,
  ): Promise<number | null> {
    try {
      return await fn();
    } catch (err) {
      await ctx.log(
        'warn',
        `verify: source count failed — reconciliation inconclusive: ${(err as Error).message}`,
      );

      return null;
    }
  }

  private async reconcile(
    ctx: StageContext,
    entityType: string,
    sourceCount: number | null,
  ): Promise<EntityReconciliation> {
    const targetCount = await this.countCrosswalk(ctx, entityType);

    return {
      entityType,
      sourceCount,
      targetCount,
      shortfall: sourceCount === null ? null : sourceCount - targetCount,
    };
  }

  /** Crosswalk rows for this run's connection — hand-scoped (service-role bypasses RLS). */
  private async countCrosswalk(
    ctx: StageContext,
    entityType: string,
  ): Promise<number> {
    if (entityType === ISSUE_ENTITY) {
      // The crosswalk is connection-wide and shared across projects/reruns. Count this run's actual
      // issue outcomes first, then verify those task ids still exist; otherwise a small KAN run can
      // appear reconciled against thousands of unrelated tasks from the same Jira connection.
      const items = await this.loadRunTargets(ctx, entityType);

      const targetIds = [
        ...new Set((items ?? []).map((row) => row.target_id).filter(Boolean)),
      ];

      // A dry-run deliberately writes no target ids. Its exact reconciliation unit is therefore
      // the current run's successfully planned/skipped issue items, never connection-wide plans.
      if (ctx.dryRun) return (items ?? []).length;

      const existing = new Set<string>();

      for (let offset = 0; offset < targetIds.length; offset += 200) {
        const { data: tasks, error: taskError } = (await this.db
          .from('tasks')
          .select('id')
          .eq('organization_id', ctx.orgId)
          .in('id', targetIds.slice(offset, offset + 200))) as {
          data: { id: string }[] | null;
          error: { message: string } | null;
        };

        if (taskError) {
          throw new MigrationItemError(
            'transient',
            `Mapped task count failed: ${taskError.message}`,
          );
        }

        for (const task of tasks ?? []) existing.add(task.id);
      }

      return (items ?? []).filter(
        (row) => row.target_id && existing.has(row.target_id),
      ).length;
    }

    if (entityType === PAGE_ENTITY) {
      const repair = Boolean(ctx.run.config_snapshot?.repair_of_run_id);
      const rows = await this.loadRunTargets(
        ctx,
        repair ? CONFLUENCE_PAGE_REPAIR_STAGE : entityType,
      );
      const items = rows.map((row) => ({
        target_id:
          row.target_id ||
          (repair && typeof row.repair_target_id === 'string'
            ? row.repair_target_id
            : ''),
      }));

      const targetIds = [
        ...new Set((items ?? []).map((row) => row.target_id).filter(Boolean)),
      ];

      if (ctx.dryRun) return (items ?? []).length;

      const { spaceId } = await resolveTargetSpace(ctx);
      const existing = new Set<string>();

      for (let offset = 0; offset < targetIds.length; offset += 200) {
        let query = this.db
          .from('wiki_pages')
          .select('id')
          .eq('organization_id', ctx.orgId)
          .eq('is_archived', false)
          .in('id', targetIds.slice(offset, offset + 200));

        if (spaceId) query = query.eq('space_id', spaceId);

        const { data: pages, error: pageError } = (await query) as {
          data: { id: string }[] | null;
          error: { message: string } | null;
        };

        if (pageError) {
          throw new MigrationItemError(
            'transient',
            `Mapped wiki page count failed: ${pageError.message}`,
          );
        }

        for (const page of pages ?? []) existing.add(page.id);
      }

      return (items ?? []).filter(
        (row) => row.target_id && existing.has(row.target_id),
      ).length;
    }

    const { count, error } = await this.db
      .from('migration_entity_map')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('entity_type', entityType)
      .eq('status', ctx.dryRun ? 'planned' : 'mapped');

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Crosswalk count failed for "${entityType}": ${error.message}`,
      );
    }

    return count ?? 0;
  }

  private async loadRunTargets(
    ctx: StageContext,
    entityType: string,
  ): Promise<{ target_id: string; repair_target_id?: string }[]> {
    const rows: { target_id: string; repair_target_id?: string }[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await this.db
        .from('migration_run_items')
        .select(
          'target_id, repair_target_id:payload->>targetId, content_kind:payload->>contentKind',
        )
        .eq('organization_id', ctx.orgId)
        .eq('run_id', ctx.run.id)
        .eq('entity_type', entityType)
        .eq('item_kind', 'entity')
        .in('status', ['succeeded', 'skipped'])
        .order('id', { ascending: true })
        .range(offset, offset + 999);
      if (error)
        throw new MigrationItemError(
          'transient',
          `Run item count failed for "${entityType}": ${error.message}`,
        );
      const page = data ?? [];
      // Folder containers are synthesized, never counted by the source — keep them out of the target.
      rows.push(
        ...page.filter(
          (r) =>
            (r as { content_kind?: string | null }).content_kind !== 'folder',
        ),
      );
      if (page.length < 1000) return rows;
    }
  }

  /** Merge the reconciliation into `run.totals` so the monitor/report can read it. */
  private async recordOnRun(
    ctx: StageContext,
    reconciliations: EntityReconciliation[],
  ): Promise<void> {
    const generation =
      (ctx.run.totals?.verification as { generation?: string } | undefined)
        ?.generation ?? '';
    const { error } = await this.db.rpc('migration_merge_run_totals', {
      p_org_id: ctx.orgId,
      p_run_id: ctx.run.id,
      p_patch: {
        verification: {
          reconciliations,
          checked_at: new Date().toISOString(),
          stale: false,
          generation,
        },
      },
      p_expected_verification_generation: generation,
    });
    if (error)
      throw new MigrationItemError(
        'transient',
        `verify: could not persist totals: ${error.message}`,
      );
  }
}
