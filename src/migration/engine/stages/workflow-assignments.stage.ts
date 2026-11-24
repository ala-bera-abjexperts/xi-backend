/**
 * @fileoverview `workflow_assignments` stage — binds each migrated workflow to the task-type levels
 * its Jira workflow scheme covered. This is what actually ACTIVATES a workflow:
 * `workflows.is_active` is trigger-managed (`refresh_workflow_is_active` = EXISTS assignments), so a
 * workflow goes live purely as a side effect of the row this stage writes.
 *
 * Consequences, both load-bearing:
 *  - It MUST run after `workflows` — once an assignment exists the workflow is active, and
 *    `saveCanvas` then throws 409 on an active non-draft workflow. The canvas must already be saved.
 *  - `WorkflowAssignmentsService.create` calls the private `assertWorkflowAssignable`, which throws
 *    422 if `workflow.initial_status_id` is null. The workflows stage always sends
 *    `initial_status_id` on saveCanvas precisely so this cannot happen.
 *
 * One item per (workflow, issue type) pair: a Jira scheme maps each issue type to exactly one
 * workflow, so pairs never collide, and per-pair items give clean per-assignment retries.
 */

import {
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { WorkflowAssignmentsService } from '../../../workflow-assignments/workflow-assignments.service';
import type { MigrationEntityMapRow } from '../../services/migration-entity-map.service';
import { ISSUE_TYPE_ENTITY } from './issue-type.stage';
import {
  blockedOnSpace,
  requireActingUser,
  resolveTargetSpace,
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
import { WORKFLOW_ENTITY } from './workflows.stage';

export const WORKFLOW_ASSIGNMENTS_STAGE = 'workflow_assignments';
export const WORKFLOW_ASSIGNMENT_ENTITY = 'workflow_assignment';

/** `workflow_assignments.task_type_level_id` is varchar(50) — a longer level id would 22001. */
const MAX_LEVEL_ID = 50;

interface AssignmentPayload {
  workflowSourceId: string;
  workflowName: string;
  /** Jira issue type sourceId, or '*' for the scheme's default mapping. */
  issueTypeSourceId: string;
}

@Injectable()
export class WorkflowAssignmentsStage implements IStageHandler {
  readonly stage = WORKFLOW_ASSIGNMENTS_STAGE;

  constructor(
    private readonly assignmentsService: WorkflowAssignmentsService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  /**
   * Seeded from the CROSSWALK, not the source: the workflows stage already resolved each workflow's
   * issue-type bindings and recorded them, so this needs no source round-trip.
   */
  async produce(ctx: StageContext): Promise<ProduceResult> {
    const workflows = await this.listMappedWorkflows(ctx);
    const items: SeedItem[] = [];

    for (const row of workflows) {
      const meta = row.metadata ?? {};
      const issueTypes = Array.isArray(meta.issue_type_source_ids)
        ? (meta.issue_type_source_ids as unknown[]).filter(
            (t): t is string => typeof t === 'string',
          )
        : [];
      const name = typeof meta.name === 'string' ? meta.name : row.source_id;

      for (const issueTypeSourceId of issueTypes) {
        items.push({
          entityType: WORKFLOW_ASSIGNMENT_ENTITY,
          sourceRef: `${row.source_id}:${issueTypeSourceId}`,
          payload: {
            workflowSourceId: row.source_id,
            workflowName: name,
            issueTypeSourceId,
          } as unknown as Record<string, unknown>,
        });
      }
    }

    return { items, nextCheckpoint: null, done: true };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const payload = item.payload as unknown as AssignmentPayload | null;

    if (!payload?.workflowSourceId || !payload.issueTypeSourceId) {
      throw new MigrationItemError(
        'permanent',
        'Workflow-assignment item is missing its payload snapshot',
      );
    }

    const sourceRef =
      item.source_ref ??
      `${payload.workflowSourceId}:${payload.issueTypeSourceId}`;

    const existing = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      WORKFLOW_ASSIGNMENT_ENTITY,
      sourceRef,
    );

    if (existing) {
      if (existing.status === 'mapped') {
        return {
          kind: 'skipped',
          reason: 'assignment already mapped',
          targetId: existing.target_id,
        };
      }

      if (existing.status === 'planned' && ctx.dryRun) {
        return { kind: 'skipped', reason: 'already planned' };
      }
    }

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen) return blockedOnSpace(ctx);

    const workflowRow = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      WORKFLOW_ENTITY,
      payload.workflowSourceId,
    );
    const workflowOpen =
      !!workflowRow &&
      (workflowRow.status === 'mapped' ||
        (ctx.dryRun && workflowRow.status === 'planned'));

    if (!workflowOpen) {
      return {
        kind: 'blocked',
        waitingFor: {
          entityType: WORKFLOW_ENTITY,
          sourceId: payload.workflowSourceId,
        },
      };
    }

    // '*' is the scheme's default mapping — it maps to the space-wide default assignment, not to a
    // hierarchy level, so it never goes through the issue_type crosswalk.
    const isDefault = payload.issueTypeSourceId === '*';
    let levelId = '*';

    if (!isDefault) {
      const typeRow = await ctx.entityMap.getTarget(
        ctx.orgId,
        ctx.job.connection_id,
        ISSUE_TYPE_ENTITY,
        payload.issueTypeSourceId,
      );
      const typeOpen =
        !!typeRow &&
        (typeRow.status === 'mapped' ||
          (ctx.dryRun && typeRow.status === 'planned'));

      if (!typeOpen) {
        return {
          kind: 'blocked',
          waitingFor: {
            entityType: ISSUE_TYPE_ENTITY,
            sourceId: payload.issueTypeSourceId,
          },
        };
      }

      levelId = typeRow.target_id;

      if (levelId.length > MAX_LEVEL_ID) {
        throw new MigrationItemError(
          'permanent',
          `Level id "${levelId}" exceeds the ${MAX_LEVEL_ID}-char task_type_level_id column`,
        );
      }
    }

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: WORKFLOW_ASSIGNMENT_ENTITY,
        sourceId: sourceRef,
        sourceKey: payload.workflowName,
        targetTable: 'workflow_assignments',
        targetId: `planned:${sourceRef}`,
        status: 'planned',
        metadata: {
          workflow: payload.workflowName,
          task_type_level_id: levelId,
          is_default: isDefault,
        },
      });

      return { kind: 'planned' };
    }

    let created: { id: string };

    try {
      created = await this.assignmentsService.create(
        ctx.orgId,
        {
          space_id: spaceId!,
          task_type_level_id: levelId,
          workflow_id: workflowRow.target_id,
          // `is_default` auto-derives from '*' (service :208), but state it explicitly rather than
          // lean on a nullish-coalescing default.
          is_default: isDefault,
          // NEVER true. It rewrites every EXISTING task of this type to the workflow's initial
          // status — in an adopted space that is destructive to data the migration doesn't own.
          apply_to_existing: false,
        },
        requireActingUser(ctx),
      );
    } catch (err) {
      // 409 = this level already has an assignment (resumed run, or a pre-existing one). Converge.
      if (err instanceof ConflictException) {
        await ctx.log(
          'warn',
          `workflow_assignments: level "${levelId}" already assigned — leaving it as-is`,
          { workflow: payload.workflowName },
        );

        return { kind: 'skipped', reason: 'level already assigned' };
      }

      // 422 = the workflow has no initial status. The workflows stage always sends one, so this
      // means the canvas save was skipped or overwritten — permanent, and worth surfacing loudly.
      if (err instanceof UnprocessableEntityException) {
        throw new MigrationItemError(
          'permanent',
          `Workflow "${payload.workflowName}" is not assignable (no initial status): ${err.message}`,
        );
      }

      throw err;
    }

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: WORKFLOW_ASSIGNMENT_ENTITY,
      sourceId: sourceRef,
      sourceKey: payload.workflowName,
      targetTable: 'workflow_assignments',
      targetId: created.id,
      status: 'mapped',
      metadata: {
        workflow: payload.workflowName,
        task_type_level_id: levelId,
        is_default: isDefault,
      },
    });

    return {
      kind: 'created',
      targetId: created.id,
      targetTable: 'workflow_assignments',
    };
  }

  /**
   * Mapped workflow rows for this connection.
   *
   * NOT `entityMap.getTargets(..., [])` — that short-circuits to an empty Map on an empty id list
   * (migration-entity-map.service.ts:105), which would silently seed zero assignments and leave
   * every migrated workflow inactive while the run still reported success. The service exposes no
   * "list all of a type" call, so query directly — hand-scoped by organization_id, because the
   * service-role client bypasses RLS.
   */
  private async listMappedWorkflows(
    ctx: StageContext,
  ): Promise<MigrationEntityMapRow[]> {
    const { data, error } = (await this.supabaseAdmin
      .getClient()
      .from('migration_entity_map')
      .select('*')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('entity_type', WORKFLOW_ENTITY)
      .in('status', ctx.dryRun ? ['mapped', 'planned'] : ['mapped'])) as {
      data: MigrationEntityMapRow[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Workflow crosswalk list failed: ${error.message}`,
      );
    }

    return data ?? [];
  }
}
