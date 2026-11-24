/**
 * @fileoverview Service for workflow assignments — links workflows to (space, task_type_level) pairs.
 * @module src/workflow-assignments/workflow-assignments.service
 * @author Rajbha Manek
 */
import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
  Optional,
} from '@nestjs/common';
import {
  databaseBadRequest,
  databaseRetryClass,
} from '../common/utils/database-error';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { CreateWorkflowAssignmentDto } from './dto/create-workflow-assignment.dto';
import type { UpdateWorkflowAssignmentDto } from './dto/update-workflow-assignment.dto';
import type { DeleteWorkflowAssignmentDto } from './dto/delete-workflow-assignment.dto';

export interface WorkflowAssignment {
  id: string;
  organization_id: string;
  space_id: string;
  task_type_level_id: string;
  workflow_id: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkflowConflict {
  affected_count: number;
  orphan_statuses: string[];
  suggested_mappings: Record<string, string | null>;
}

@Injectable()
export class WorkflowAssignmentsService {
  private static readonly TABLE = 'workflow_assignments';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getBySpace(
    organizationId: string,
    spaceId: string,
  ): Promise<WorkflowAssignment[]> {
    const r = await this.client
      .from(WorkflowAssignmentsService.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .order('task_type_level_id', { ascending: true });

    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as WorkflowAssignment[];
  }

  async getById(
    id: string,
    organizationId: string,
  ): Promise<WorkflowAssignment> {
    const r = await this.client
      .from(WorkflowAssignmentsService.TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Workflow assignment not found');
    return r.data as WorkflowAssignment;
  }

  /**
   * Resolve the active workflow assignment for a given task type within a
   * space, with org-default fallback.
   *
   * Lookup order (returns the first match):
   *   1. assignment WHERE task_type_level_id = :taskTypeLevelId
   *   2. assignment WHERE task_type_level_id = '*'  (org-default catch-all)
   *
   * Used by the workflow engine to decide whether a task transition should
   * route through the engine or through the legacy task_status_transitions
   * fallback. Returns null when neither row exists (caller invokes legacy).
   *
   * @param organizationId - calling org
   * @param spaceId - space owning the task
   * @param taskTypeLevelId - task type identifier (matches task_hierarchy_config.levels[].id)
   * @returns the matching WorkflowAssignment row, or null
   */
  async findActiveAssignmentForType(
    organizationId: string,
    spaceId: string,
    taskTypeLevelId: string,
  ): Promise<WorkflowAssignment | null> {
    // Fetch at most 2 candidate rows: the type-specific row and the org-default
    // wildcard. PostgREST cannot order by a CASE expression directly, so we
    // resolve precedence in JS — type-specific always wins over '*'.
    const r = await this.client
      .from(WorkflowAssignmentsService.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .in('task_type_level_id', [taskTypeLevelId, '*']);

    if (r.error) {
      const error = databaseBadRequest(r.error, r.status);
      if (databaseRetryClass(error)) throw error;
      // Table not yet migrated — treat as no assignment so task creation falls
      // back to legacy status routing rather than aborting with a 400.
      if (r.error.message?.includes('schema cache')) return null;
      throw error;
    }
    const rows = (r.data ?? []) as WorkflowAssignment[];

    if (rows.length === 0) return null;
    const specific = rows.find(
      (row) => row.task_type_level_id === taskTypeLevelId,
    );

    if (specific) return specific;
    const wildcard = rows.find((row) => row.task_type_level_id === '*');

    return wildcard ?? null;
  }

  /**
   * Guard: a workflow may only be assigned once it has an initial status.
   * Without one, tasks created under the assigned type have no valid start
   * node and the engine can never resolve transitions — the user is left
   * with a task that cannot move. Throws 422 so the admin finishes the
   * workflow before assigning it. (See audit gap: `test-layout`,
   * `Software Development Workflow` were assigned with no initial status.)
   *
   * @param wf - the workflow row fetched during create/update
   * @throws UnprocessableEntityException when initial_status_id is null
   */
  private assertWorkflowAssignable(wf: {
    id: string;
    initial_status_id: string | null;
  }): void {
    if (!wf.initial_status_id) {
      throw new UnprocessableEntityException(
        'Workflow has no initial status. Set an initial status (and at least one transition) before assigning it.',
      );
    }
  }

  /**
   * Guard: org-level workflows (`space_id IS NULL`) may be assigned to any
   * space in the organization, but a space-scoped workflow is only valid for
   * its owning space. Without this, tasks in one space can inherit statuses and
   * rules from another space's workflow, bypassing the intended scope boundary.
   *
   * @param wf - the workflow row fetched during create/update
   * @param assignmentSpaceId - space receiving the workflow assignment
   * @throws BadRequestException when a space-scoped workflow crosses spaces
   */
  private assertWorkflowScopeAssignable(
    wf: { id: string; space_id?: string | null },
    assignmentSpaceId: string,
  ): void {
    if (wf.space_id && wf.space_id !== assignmentSpaceId) {
      throw new BadRequestException(
        'Space-scoped workflows can only be assigned inside their owning space',
      );
    }
  }

  async create(
    organizationId: string,
    dto: CreateWorkflowAssignmentDto,
    actorUserId?: string | null,
  ): Promise<WorkflowAssignment & { tasks_migrated?: number }> {
    // H3: Validate space and workflow both belong to this org before inserting
    const spaceR = await this.client
      .from('spaces')
      .select('id')
      .eq('id', dto.space_id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (spaceR.error) throw new BadRequestException(spaceR.error.message);
    if (!spaceR.data) throw new NotFoundException('Space not found');

    const wfR = await this.client
      .from('workflows')
      .select('id, initial_status_id, space_id')
      .eq('id', dto.workflow_id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (wfR.error) throw new BadRequestException(wfR.error.message);
    if (!wfR.data) throw new NotFoundException('Workflow not found');
    this.assertWorkflowScopeAssignable(
      wfR.data as { id: string; space_id?: string | null },
      dto.space_id,
    );
    this.assertWorkflowAssignable(
      wfR.data as { id: string; initial_status_id: string | null },
    );

    const isDefault = dto.is_default ?? dto.task_type_level_id === '*';
    const row = {
      organization_id: organizationId,
      space_id: dto.space_id,
      task_type_level_id: dto.task_type_level_id,
      workflow_id: dto.workflow_id,
      is_default: isDefault,
    };
    const r = await this.client
      .from(WorkflowAssignmentsService.TABLE)
      .insert(row)
      .select()
      .single();

    if (r.error) {
      if (r.error.code === '23505')
        throw new ConflictException(
          'A workflow is already assigned to this space/level combination',
        );
      throw new BadRequestException(r.error.message);
    }
    const created = r.data as WorkflowAssignment;

    let tasks_migrated = 0;

    if (dto.apply_to_existing) {
      try {
        // wfR is already loaded above; assertWorkflowAssignable() guarantees initial_status_id is non-null here.
        const targetStatusId = (wfR.data as { initial_status_id: string })
          .initial_status_id;

        let countQ = this.client
          .from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .eq('space_id', dto.space_id);

        let updateQ = this.client
          .from('tasks')
          .update({
            status_id: targetStatusId,
            updated_at: new Date().toISOString(),
            ...(actorUserId ? { updated_by: actorUserId } : {}),
          })
          .eq('organization_id', organizationId)
          .eq('space_id', dto.space_id);

        if (dto.task_type_level_id !== '*') {
          countQ = countQ.eq('task_type_id', dto.task_type_level_id);
          updateQ = updateQ.eq('task_type_id', dto.task_type_level_id);
        }

        const { count } = await countQ;

        tasks_migrated = count ?? 0;

        if (tasks_migrated > 0) {
          const { error: updateError } = await updateQ;

          if (updateError) {
            console.error(
              '[WorkflowAssignments] apply_to_existing update failed:',
              updateError,
            );
            tasks_migrated = 0;
          }
        }
      } catch (applyErr) {
        console.error(
          '[WorkflowAssignments] apply_to_existing failed:',
          applyErr,
        );
        tasks_migrated = 0;
      }
    }

    this.logAudit(organizationId, actorUserId, created.id, 'create', {
      space_id: dto.space_id,
      task_type_level_id: dto.task_type_level_id,
      workflow_id: dto.workflow_id,
    });

    return { ...created, tasks_migrated } as WorkflowAssignment & {
      tasks_migrated?: number;
    };
  }

  async update(
    id: string,
    organizationId: string,
    dto: UpdateWorkflowAssignmentDto,
    actorUserId?: string | null,
  ): Promise<WorkflowAssignment> {
    const existing = await this.getById(id, organizationId);

    // Idempotency: no-op when client re-submits the same workflow_id.
    if (
      dto.workflow_id !== undefined &&
      dto.workflow_id === existing.workflow_id
    ) {
      return existing;
    }

    if (dto.workflow_id && dto.workflow_id !== existing.workflow_id) {
      // C1: Validate the new workflow belongs to this org before doing any conflict check
      const newWfR = await this.client
        .from('workflows')
        .select('id, initial_status_id, space_id')
        .eq('id', dto.workflow_id)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (newWfR.error) throw new BadRequestException(newWfR.error.message);
      if (!newWfR.data) throw new NotFoundException('Workflow not found');
      this.assertWorkflowScopeAssignable(
        newWfR.data as { id: string; space_id?: string | null },
        existing.space_id,
      );
      this.assertWorkflowAssignable(
        newWfR.data as { id: string; initial_status_id: string | null },
      );

      // Check for orphaned tasks — tasks in this space using statuses in the OLD workflow not in the NEW workflow
      const conflict = await this.detectOrphanConflict(
        existing,
        dto.workflow_id,
        organizationId,
      );

      if (conflict && !dto.migration_map) {
        throw new ConflictException({
          message: 'Tasks exist on this assignment',
          data: conflict,
        });
      }

      if (conflict && dto.migration_map) {
        // Pre-validate every orphan is covered so the RPC never has to raise 23514
        // in the normal flow. The RPC still re-checks inside the locked txn for
        // TOCTOU defense, but this catches the typical "user forgot a row" case
        // early with a 400 instead of a generic 500.
        const map = dto.migration_map;
        const missing = conflict.orphan_statuses.filter(
          (sid) => !(sid in map) || map[sid] === undefined || map[sid] === null,
        );

        if (missing.length > 0) {
          throw new BadRequestException({
            message: 'migration_map is missing entries for orphan statuses',
            missing,
          });
        }

        const rpcRes = await this.client.rpc(
          'migrate_tasks_for_assignment_change',
          {
            p_assignment_id: id,
            p_new_workflow_id: dto.workflow_id,
            p_migration_map: dto.migration_map,
            p_user_id: actorUserId ?? null,
            p_organization_id: organizationId,
          },
        );

        if (rpcRes.error) {
          // SVC-H2: a Postgres serialization failure during concurrent task
          // migration is retryable — surface 409, not a permanent 400.
          if ((rpcRes.error as { code?: string }).code === '40001') {
            throw new ConflictException({
              message: 'Concurrent modification during migration; please retry',
              data: { retryable: true },
            });
          }
          throw new BadRequestException(rpcRes.error.message);
        }

        const payload = (rpcRes.data ?? {}) as {
          tasks_migrated?: number;
          orphan_count?: number;
          migrated_task_ids?: string[];
          truncated?: boolean;
          assignment?: WorkflowAssignment;
        };
        const tasksMigrated = payload.tasks_migrated ?? 0;
        const orphanCount = payload.orphan_count ?? conflict.affected_count;
        const migratedIds = Array.isArray(payload.migrated_task_ids)
          ? payload.migrated_task_ids
          : [];
        const truncated = Boolean(payload.truncated);

        this.auditLogChanged(organizationId, actorUserId, id, {
          from_workflow_id: existing.workflow_id,
          to_workflow_id: dto.workflow_id,
          space_id: existing.space_id,
          task_type_level_id: existing.task_type_level_id,
          migration_map: dto.migration_map,
          tasks_migrated_count: tasksMigrated,
          orphan_count: orphanCount,
          migrated_tasks: migratedIds,
          migrated_tasks_truncated: truncated,
        });

        if (payload.assignment) return payload.assignment;
        // Defensive fallback: RPC should always echo the assignment row, but if
        // a malformed response slips through we re-fetch to keep callers honest.
        return await this.getById(id, organizationId);
      }
    }

    const patch: Record<string, unknown> = {};

    if (dto.workflow_id !== undefined) patch['workflow_id'] = dto.workflow_id;

    if (Object.keys(patch).length === 0)
      throw new BadRequestException(
        'At least one field must be provided for update',
      );

    const r = await this.client
      .from(WorkflowAssignmentsService.TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (r.error) throw new BadRequestException(r.error.message);
    this.logAudit(organizationId, actorUserId, id, 'update', patch);
    return r.data as WorkflowAssignment;
  }

  async delete(
    id: string,
    organizationId: string,
    dto: DeleteWorkflowAssignmentDto,
    actorUserId?: string | null,
  ): Promise<void> {
    const existing = await this.getById(id, organizationId);

    if (!dto.acknowledge_orphaned_tasks) {
      const conflict = await this.detectOrphanConflictForDelete(
        existing,
        organizationId,
      );

      if (conflict) {
        throw new ConflictException({
          message: 'Tasks exist on this assignment',
          data: conflict,
        });
      }
    }

    const r = await this.client
      .from(WorkflowAssignmentsService.TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (r.error) throw new BadRequestException(r.error.message);
    this.logAudit(organizationId, actorUserId, id, 'delete', {
      space_id: existing.space_id,
      workflow_id: existing.workflow_id,
    });
  }

  // BLOCKER fix: workflow_nodes has NO organization_id column. The previous
  // .eq('organization_id', …) silently errored on every call, and the swallowed
  // error meant the 409 path was dead code. Org isolation is provided by the
  // (workflow_id → workflows.organization_id) FK chain instead.
  private async detectOrphanConflict(
    assignment: WorkflowAssignment,
    newWorkflowId: string,
    organizationId: string,
  ): Promise<WorkflowConflict | null> {
    const [oldNodesR, newNodesR] = await Promise.all([
      this.client
        .from('workflow_nodes')
        .select('status_id')
        .eq('workflow_id', assignment.workflow_id)
        .eq('kind', 'status')
        .not('status_id', 'is', null),
      this.client
        .from('workflow_nodes')
        .select('status_id')
        .eq('workflow_id', newWorkflowId)
        .eq('kind', 'status')
        .not('status_id', 'is', null),
    ]);

    if (oldNodesR.error) throw new BadRequestException(oldNodesR.error.message);
    if (newNodesR.error) throw new BadRequestException(newNodesR.error.message);

    const newStatusIds = new Set(
      (newNodesR.data ?? []).map((n: { status_id: string }) => n.status_id),
    );
    const orphanStatusIds = (oldNodesR.data ?? [])
      .map((n: { status_id: string }) => n.status_id)
      .filter((sid) => !newStatusIds.has(sid));

    if (orphanStatusIds.length === 0) return null;

    // When the assignment is scoped to a specific task type (not '*'), narrow
    // the affected-tasks count to that task type so the wildcard assignment
    // doesn't count every task in the space.
    let tasksQ = this.client
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('space_id', assignment.space_id)
      .in('status_id', orphanStatusIds);

    if (assignment.task_type_level_id !== '*') {
      tasksQ = tasksQ.eq('task_type_id', assignment.task_type_level_id);
    }

    const tasksR = await tasksQ;

    if (tasksR.error) throw new BadRequestException(tasksR.error.message);
    if ((tasksR.count ?? 0) === 0) return null;

    const suggested = await this.suggestMapping(
      orphanStatusIds,
      newWorkflowId,
      organizationId,
    );

    return {
      affected_count: tasksR.count ?? 0,
      orphan_statuses: orphanStatusIds,
      suggested_mappings: suggested,
    };
  }

  private async detectOrphanConflictForDelete(
    assignment: WorkflowAssignment,
    organizationId: string,
  ): Promise<WorkflowConflict | null> {
    const nodesR = await this.client
      .from('workflow_nodes')
      .select('status_id')
      .eq('workflow_id', assignment.workflow_id)
      .eq('kind', 'status')
      .not('status_id', 'is', null);

    if (nodesR.error) throw new BadRequestException(nodesR.error.message);
    const statusIds = (nodesR.data ?? []).map(
      (n: { status_id: string }) => n.status_id,
    );

    if (statusIds.length === 0) return null;

    let tasksQ = this.client
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('space_id', assignment.space_id)
      .in('status_id', statusIds);

    if (assignment.task_type_level_id !== '*') {
      tasksQ = tasksQ.eq('task_type_id', assignment.task_type_level_id);
    }

    const tasksR = await tasksQ;

    if (tasksR.error) throw new BadRequestException(tasksR.error.message);
    if ((tasksR.count ?? 0) === 0) return null;

    return {
      affected_count: tasksR.count ?? 0,
      orphan_statuses: statusIds,
      // Delete has no target workflow, so no suggestions are possible.
      suggested_mappings: {},
    };
  }

  /**
   * Build a best-effort mapping from orphan status ids to candidate target
   * status ids within the new workflow's status set. Priority order per orphan:
   *
   *   1. Exact `task_statuses.key` match within (target_workflow_node_status_ids ∩ organization_id)
   *   2. Same `task_statuses.category_id` within the target set — lowest sort_order, then alphabetic name
   *   3. First available in the target set by sort_order, then name
   *   4. null if the target set is empty
   *
   * @param orphanIds - status ids present in the OLD workflow but not the NEW one
   * @param targetWorkflowId - the workflow being assigned
   * @param organizationId - calling org (defence-in-depth: target statuses must also belong to org)
   * @returns map of orphan_id → suggested_target_id | null
   */
  private async suggestMapping(
    orphanIds: string[],
    targetWorkflowId: string,
    organizationId: string,
  ): Promise<Record<string, string | null>> {
    if (orphanIds.length === 0) return {};

    // Step 1 — resolve the target workflow's status id set.
    const targetNodesR = await this.client
      .from('workflow_nodes')
      .select('status_id')
      .eq('workflow_id', targetWorkflowId)
      .eq('kind', 'status')
      .not('status_id', 'is', null);

    if (targetNodesR.error)
      throw new BadRequestException(targetNodesR.error.message);

    const targetStatusIds = (targetNodesR.data ?? [])
      .map((n: { status_id: string }) => n.status_id)
      .filter((s): s is string => Boolean(s));

    // Empty target → every orphan gets null per spec rule 4.
    if (targetStatusIds.length === 0) {
      return Object.fromEntries(orphanIds.map((id) => [id, null]));
    }

    // Step 2 — fetch the relevant task_statuses rows in a single round trip.
    // We scope by organization_id as defence-in-depth even though the FK chain
    // already guarantees alignment.
    const allStatusIds = Array.from(
      new Set([...orphanIds, ...targetStatusIds]),
    );
    const statusesR = await this.client
      .from('task_statuses')
      .select('id, key, name, category_id, sort_order')
      .in('id', allStatusIds)
      .eq('organization_id', organizationId);

    if (statusesR.error) throw new BadRequestException(statusesR.error.message);

    interface TaskStatusRow {
      id: string;
      key: string | null;
      name: string | null;
      category_id: string | null;
      sort_order: number | null;
    }
    const statuses = (statusesR.data ?? []) as TaskStatusRow[];
    const byId = new Map<string, TaskStatusRow>(statuses.map((s) => [s.id, s]));
    const targetSet = new Set(targetStatusIds);
    const targets = statuses.filter((s) => targetSet.has(s.id));

    // Pre-compute a single sorted list to use as the deterministic
    // "first available" fallback (rule 3) and as the category tiebreaker (rule 2).
    const orderedTargets = [...targets].sort((a, b) => {
      const aOrder = a.sort_order ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.sort_order ?? Number.MAX_SAFE_INTEGER;

      if (aOrder !== bOrder) return aOrder - bOrder;

      return (a.name ?? '').localeCompare(b.name ?? '');
    });

    const result: Record<string, string | null> = {};

    for (const orphanId of orphanIds) {
      const orphan = byId.get(orphanId);

      // If we can't resolve the orphan row (deleted? wrong org?), bail to null.
      if (!orphan) {
        result[orphanId] = null;
        continue;
      }

      // Rule 1 — exact key match (case-sensitive: keys are normalised lowercase).
      if (orphan.key) {
        const exact = orderedTargets.find((t) => t.key === orphan.key);

        if (exact) {
          result[orphanId] = exact.id;
          continue;
        }
      }

      // Rule 2 — same category_id, lowest sort_order, then alphabetic name.
      if (orphan.category_id) {
        const sameCategory = orderedTargets.find(
          (t) => t.category_id === orphan.category_id,
        );

        if (sameCategory) {
          result[orphanId] = sameCategory.id;
          continue;
        }
      }

      // Rule 3 — first available in the target set by sort_order, then name.
      result[orphanId] = orderedTargets[0]?.id ?? null;
    }

    return result;
  }

  /**
   * Emit a single audit row for a workflow assignment migration. Uses
   * AuditLogsService.createLog directly because this action is
   * organisation-scoped under a `workflow_assignment` entity rather than the
   * `workflow` entity that `logAction` is wrapped around. P8/D5 added
   * 'workflow.assignment.changed' to the typed `AUDIT_ACTIONS` tuple so the
   * literal is fully type-checked here without an `as never` cast.
   */
  private auditLogChanged(
    organizationId: string,
    actorUserId: string | null | undefined,
    entityId: string,
    changes: Record<string, unknown>,
  ): void {
    if (!actorUserId || !this.auditLogsService) return;
    void this.auditLogsService.createLog(organizationId, actorUserId, {
      entity_type: 'workflow_assignment',
      entity_id: entityId,
      // P8/D5: literal is now in the typed AUDIT_ACTIONS tuple — no cast needed.
      action: 'workflow.assignment.changed',
      changes,
    });
  }

  private logAudit(
    organizationId: string,
    actorUserId: string | null | undefined,
    entityId: string | null | undefined,
    action: 'create' | 'update' | 'delete',
    changes?: Record<string, unknown>,
  ): void {
    if (!actorUserId || !entityId || !this.auditLogsService) return;
    void this.auditLogsService.logAction(
      organizationId,
      actorUserId,
      'workflow_assignment',
      entityId,
      action,
      changes,
    );
  }
}
