/**
 * @fileoverview `workflows` stage — one XISUITE workflow per Jira workflow in the project's scheme.
 *
 * Three source realities this has to survive, all verified by live probe against Jira Server 8.22.4:
 *
 * 1. **`getWorkflows()` returns `statusSourceIds: []` UNCONDITIONALLY on Server** — the projectconfig
 *    scheme endpoint simply doesn't report statuses. Left alone, every workflow would build with zero
 *    statuses and `buildWorkflowCanvas` would throw. So `produce` resolves the status set itself:
 *    `getStatuses()` reports each status's `issueTypeSourceIds`, and a workflow is bound to issue
 *    types by the scheme — intersect the two.
 * 2. **No transition graph** (`/rest/api/2/workflow` returns only name/description/steps/default).
 *    `transitions: null` → the builder models "we don't know the restrictions, so restrict nothing"
 *    as one GLOBAL transition per status: O(N), not the O(N²) pairwise expansion that blows
 *    `SaveCanvasDto`'s 1000-transition cap at ~32 statuses.
 * 3. **`createFromStatuses` is unusable here** — it lives on `WorkflowsImportExportService`, which is
 *    provided but NOT exported from `WorkflowsModule` (injecting it fails DI at bootstrap), and it
 *    takes no status filter (it reads EVERY org+space status, not this project's). Hence
 *    create() + buildWorkflowCanvas() + saveCanvas().
 *
 * Ordering is load-bearing: `workflows.is_active` is trigger-managed from `workflow_assignments`
 * (refresh_workflow_is_active = EXISTS assignments), and `saveCanvas` throws 409 on an active
 * non-draft workflow. So the canvas MUST be saved here, BEFORE the workflow_assignments stage runs.
 * That is precisely why `workflows` precedes `workflow_assignments` in JIRA_STAGE_ORDER.
 */

import { ConflictException, Injectable } from '@nestjs/common';
import { WorkflowsService } from '../../../workflows/workflows.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import {
  buildWorkflowCanvas,
  type CanvasStatusInput,
} from '../../mappers/workflow-canvas.builder';
import type { NormalizedWorkflow } from '../../model/normalized';
import {
  blockedOnSpace,
  requireActingUser,
  resolveTargetSpace,
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

export const WORKFLOWS_STAGE = 'workflows';
export const WORKFLOW_ENTITY = 'workflow';

/** Mirrors the sort_order the task_statuses stage derives from the category. */
const CATEGORY_SORT: Record<string, number> = {
  new: 0,
  indeterminate: 1,
  done: 2,
};

@Injectable()
export class WorkflowsStage implements IStageHandler {
  readonly stage = WORKFLOWS_STAGE;

  constructor(private readonly workflowsService: WorkflowsService) {}

  async produce(ctx: StageContext): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'workflows stage: non-Jira source — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    const [workflows, statuses] = await Promise.all([
      adapter.getWorkflows(ctx.job.source_ref),
      adapter.getStatuses(ctx.job.source_ref),
    ]);

    for (const workflow of workflows) {
      for (const warning of workflow.migrationWarnings ?? []) {
        await ctx.log('warn', `workflows: ${warning}`, {
          workflow: workflow.name,
        });
      }
    }

    const allStatusIds = statuses.map((s) => s.sourceId);

    const resolved = workflows.map((wf) => {
      // Server reports none — fill them in. '*' (the scheme's default mapping) means "every issue
      // type", so the workflow owns every status in the project.
      if (wf.statusSourceIds.length > 0) return wf;

      const boundToAll = wf.issueTypeSourceIds.includes('*');

      if (boundToAll) return { ...wf, statusSourceIds: allStatusIds };

      const wanted = new Set(wf.issueTypeSourceIds);
      const intersected = statuses
        .filter((s) => (s.issueTypeSourceIds ?? []).some((t) => wanted.has(t)))
        .map((s) => s.sourceId);

      // A status set we couldn't intersect (statuses carry no issue-type info) would build an empty
      // canvas and throw. Falling back to the full project set keeps the workflow usable and is the
      // same "we don't know, so don't restrict" reading the null transition graph gets.
      return {
        ...wf,
        statusSourceIds: intersected.length > 0 ? intersected : allStatusIds,
      };
    });

    return {
      items: resolved.map((wf) => ({
        entityType: WORKFLOW_ENTITY,
        sourceRef: wf.sourceId,
        payload: wf as unknown as Record<string, unknown>,
      })),
      nextCheckpoint: null,
      done: true,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const wf = item.payload as unknown as NormalizedWorkflow | null;

    if (!wf?.sourceId) {
      throw new MigrationItemError(
        'permanent',
        'Workflow item is missing its payload snapshot',
      );
    }

    const existing = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      WORKFLOW_ENTITY,
      wf.sourceId,
    );

    if (existing) {
      if (existing.status === 'mapped') {
        return {
          kind: 'skipped',
          reason: 'workflow already mapped',
          targetId: existing.target_id,
        };
      }

      if (existing.status === 'planned' && ctx.dryRun) {
        return {
          kind: 'skipped',
          reason: 'already planned',
          targetId: existing.target_id,
        };
      }
    }

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen) return blockedOnSpace(ctx);

    if (wf.statusSourceIds.length === 0) {
      return {
        kind: 'skipped',
        reason: `workflow "${wf.name}" has no statuses on the source`,
      };
    }

    // Every status must be crosswalked before the canvas can reference it — a miss blocks the item
    // rather than silently building a smaller workflow.
    const statusRows = await ctx.entityMap.getTargets(
      ctx.orgId,
      ctx.job.connection_id,
      TASK_STATUS_ENTITY,
      wf.statusSourceIds,
    );

    const resolvedStatusIds: string[] = [];
    const unresolvedStatusIds: string[] = [];

    for (const sourceId of wf.statusSourceIds) {
      const row = statusRows.get(sourceId);
      const open =
        !!row &&
        (row.status === 'mapped' || (ctx.dryRun && row.status === 'planned'));

      if (open) {
        resolvedStatusIds.push(sourceId);

        continue;
      }

      // With the FAITHFUL graph, the status set comes from the workflow itself and can mention
      // statuses no issue type carries (the live MIGTEST workflow holds a fully disconnected
      // "Escalated"). The task_statuses stage seeds from per-issue-type status lists, so such a
      // status may NEVER get a crosswalk row — blocking on it would deadlock the item on a
      // dependency that is not coming. Dropping it (and, via the builder's guard, its edges) with
      // a warn keeps the workflow importable and the loss visible.
      if (wf.transitions !== null) {
        unresolvedStatusIds.push(sourceId);

        continue;
      }

      // Without a graph the status set was derived FROM issue types, so every entry will be seeded
      // eventually — blocking is correct and converges.
      return {
        kind: 'blocked',
        waitingFor: { entityType: TASK_STATUS_ENTITY, sourceId },
      };
    }

    for (const sourceId of unresolvedStatusIds) {
      await ctx.log(
        'warn',
        `workflows: "${wf.name}" mentions status ${sourceId}, which this migration did not map — ` +
          `the status and its transitions are omitted from the imported workflow`,
        { workflow: wf.name },
      );
    }

    if (resolvedStatusIds.length === 0) {
      return {
        kind: 'skipped',
        reason: `workflow "${wf.name}": none of its statuses are mapped`,
      };
    }

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: WORKFLOW_ENTITY,
        sourceId: wf.sourceId,
        sourceKey: wf.name,
        targetTable: 'workflows',
        targetId: `planned:${wf.name}`,
        status: 'planned',
        metadata: {
          name: wf.name,
          status_count: wf.statusSourceIds.length,
          issue_type_source_ids: wf.issueTypeSourceIds,
          is_default: wf.isDefault,
          graph: wf.transitions === null ? 'global-per-status' : 'faithful',
          // Jira Server exposes no transition rules over REST (conditions/validators/
          // post-functions); every imported transition is unrestricted. Recorded so the loss is
          // auditable, not just mentioned in prose.
          rules_reported: false,
          ...(wf.transitions !== null
            ? { transition_count: wf.transitions.length }
            : {}),
          ...(wf.screensByTransition
            ? { screens_by_transition: wf.screensByTransition }
            : {}),
        },
      });

      return { kind: 'planned' };
    }

    const canvasStatuses: CanvasStatusInput[] = resolvedStatusIds.map(
      (sourceId, i) => {
        const row = statusRows.get(sourceId)!;
        const meta = row.metadata ?? {};
        const category = typeof meta.category === 'string' ? meta.category : '';

        return {
          statusId: row.target_id,
          name: typeof meta.name === 'string' ? meta.name : sourceId,
          isCompleted: category === 'done',
          // Category first (new → work → done), then source order for stable ties.
          sortOrder: (CATEGORY_SORT[category] ?? 1) * 1000 + i,
        };
      },
    );

    const actor = requireActingUser(ctx);
    const created = await this.createWorkflow(ctx, wf, spaceId!, actor);

    const dropped: string[] = [];
    const canvas = buildWorkflowCanvas(
      canvasStatuses,
      // Server: null → one global transition per status. Cloud (P8) passes a faithful graph, whose
      // from/to ids MUST already be resolved to TARGET status ids — the builder's map is keyed that way.
      wf.transitions === null
        ? null
        : wf.transitions.map((t) => ({
            fromStatusId:
              t.fromStatusSourceId === null
                ? null
                : (statusRows.get(t.fromStatusSourceId)?.target_id ??
                  t.fromStatusSourceId),
            toStatusId:
              statusRows.get(t.toStatusSourceId)?.target_id ??
              t.toStatusSourceId,
            name: t.name,
          })),
      1, // create() leaves version at 1 (its start-node insert doesn't bump it).
      (reason) => dropped.push(reason),
      // The graph-derived entry status (resolved to its TARGET id), when the source revealed one.
      wf.initialStatusSourceId
        ? (statusRows.get(wf.initialStatusSourceId)?.target_id ?? null)
        : null,
    );

    for (const reason of dropped) {
      await ctx.log('warn', `workflows: dropped ${reason}`, {
        workflow: wf.name,
      });
    }

    // saveCanvas is id-FIRST (workflows.service.ts:473) — unlike create(), which is org-first.
    // Both take bare strings, so a swap would compile and write garbage.
    await this.workflowsService.saveCanvas(
      created.id,
      ctx.orgId,
      {
        version: canvas.version,
        // MUST be sent: the RPC writes `p_initial_status_id := dto.initial_status_id ?? null`, so
        // omitting it NULLs the column and every later assignment 422s in assertWorkflowAssignable.
        initial_status_id: canvas.initial_status_id,
        layout: canvas.layout,
        nodes: canvas.nodes,
        transitions: canvas.transitions,
        transition_sources: canvas.transition_sources,
        decision_branches: canvas.decision_branches,
      },
      actor,
    );

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: WORKFLOW_ENTITY,
      sourceId: wf.sourceId,
      sourceKey: wf.name,
      targetTable: 'workflows',
      targetId: created.id,
      status: 'mapped',
      metadata: {
        name: wf.name,
        initial_status_id: canvas.initial_status_id,
        status_count: canvasStatuses.length,
        transition_count: canvas.transitions.length,
        dropped_transitions: dropped.length,
        issue_type_source_ids: wf.issueTypeSourceIds,
        is_default: wf.isDefault,
      },
    });

    return { kind: 'created', targetId: created.id, targetTable: 'workflows' };
  }

  /**
   * Adopt-or-create by name, in that order.
   *
   * ADOPT-FIRST IS NOT AN OPTIMIZATION, IT IS THE FIX FOR A LIVE FAILURE. A create-then-catch
   * ladder is not enough on its own: this stage creates the workflow, and if the item is retried
   * for any reason (lease expiry, a transient error after the insert landed, a resumed run) the
   * second attempt collides with
   * `workflows_org_scope_name_uniq (organization_id, COALESCE(space_id, ...), name)
   *  WHERE is_archived = false AND is_draft = false`.
   * The work has already succeeded, yet the item is reported failed and every stage that depends on
   * the workflow stalls behind it. Observed on a live KAN run: the workflow existed in the target
   * and the run still stopped.
   *
   * Looking first means a re-run converges on the row it already made instead of racing its own
   * past self. The `create` is still wrapped, because two workers can interleave between the lookup
   * and the insert; on conflict we look again rather than fail.
   */
  private async createWorkflow(
    ctx: StageContext,
    wf: NormalizedWorkflow,
    spaceId: string,
    actor: string,
  ): Promise<{ id: string }> {
    const adopted = await this.findWorkflowByName(ctx, wf.name, spaceId);

    if (adopted) {
      await ctx.log(
        'info',
        `workflows: adopted the existing "${wf.name}" in this scope instead of creating a duplicate`,
        { workflow: wf.name },
      );

      return adopted;
    }

    try {
      return (await this.workflowsService.create(
        ctx.orgId,
        { name: wf.name, description: wf.description, space_id: spaceId },
        actor,
      )) as { id: string };
    } catch (err) {
      if (!(err instanceof ConflictException)) throw err;

      // Lost a race between the lookup above and this insert: the winner's row is the right answer.
      const raced = await this.findWorkflowByName(ctx, wf.name, spaceId);

      if (raced) return raced;

      throw new MigrationItemError(
        'conflict',
        `Workflow "${wf.name}" already exists in the target: ${err.message}`,
      );
    }
  }

  /**
   * The live workflow this scope would collide with, or null.
   *
   * Matches the unique index exactly: same space (an org-level workflow has `space_id` null and is a
   * DIFFERENT row from a same-named space-level one), same name, and neither archived nor draft —
   * the index is partial on those two, so an archived namesake is not a collision and must not be
   * adopted.
   */
  private async findWorkflowByName(
    ctx: StageContext,
    name: string,
    spaceId: string | null,
  ): Promise<{ id: string } | null> {
    const rows = await this.workflowsService.getAll(ctx.orgId, {
      ...(spaceId ? { spaceId } : {}),
    });
    const wanted = name.trim().toLowerCase();
    const hit = rows.find(
      (r) =>
        (r.name ?? '').trim().toLowerCase() === wanted &&
        (r.space_id ?? null) === (spaceId ?? null) &&
        r.is_archived !== true &&
        r.is_draft !== true,
    );

    return hit ? { id: hit.id } : null;
  }
}
