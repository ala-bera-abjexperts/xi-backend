/**
 * @fileoverview Ticket 8: moves task status from development events. A live webhook's state change
 * (git-pull-requests.service) becomes an {@link IGitDevEvent}; for each task it belongs to, the transitions of
 * the task's workflow that carry a `git_development_event` trigger for that event are tried through the
 * workflow engine, so the workflow's rules always apply: a transition that is not available from the current
 * status, or whose conditions / validators fail, is never forced.
 *
 * - Never backwards: a target in an earlier status category is skipped unless the trigger allows it.
 * - Already in the target status: nothing to do.
 * - `pr_merged` with "all linked pull requests merged" (default): waits while another linked one is open.
 * - Space switch `spaces.settings.gitStatusAutomation === false`, an archived space or an inactive workflow:
 *   nothing happens.
 * - The transition runs as the developer (their linked XISUITE account, when a member) or else as the
 *   workflow's creator, like the legacy git triggers. The History row the status change writes is annotated
 *   with the source; a refused move is explained by a `git_automation_skipped` row.
 *
 * Never throws: a failure is logged and never fails the webhook delivery.
 *
 * The admin client bypasses RLS, so every query filters on `organization_id` (or a row already verified in it).
 * @module src/git-integrations/git-status-automation.service
 */

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { WorkflowAssignmentsService } from '../workflow-assignments/workflow-assignments.service';
import { normalizeRuleConfig } from '../workflow-engine/handlers/rule-config';
import type { GitDevelopmentEventConfig } from '../workflow-engine/handlers/triggers/git-development-event.trigger';
import type { IWorkflowEngineRuntime } from '../workflow-triggers/workflow-engine.contract';
import { WORKFLOW_ENGINE_SERVICE } from '../workflow-triggers/workflow-engine.contract';
import { GitIdentitiesService } from './git-identities.service';
import type { IGitDevEvent } from './git-integrations.types';
import { developmentTaskIds } from './git-integrations.util';

/** Why a move did not happen, as History explains it. Most specific first. */
export type GitAutomationSkipReason =
  | 'condition_failed'
  | 'validator_failed'
  | 'waiting_other_prs'
  | 'target_missing'
  | 'not_allowed_from_current';

const REASON_ORDER: GitAutomationSkipReason[] = [
  'condition_failed',
  'validator_failed',
  'waiting_other_prs',
  'target_missing',
  'not_allowed_from_current',
];

const TRIGGER_TYPE = 'git_development_event';

const CLOCK_SKEW_MS = 60_000;

interface ITaskRow {
  id: string;
  space_id: string | null;
  task_type_id: string | null;
  status_id: string | null;
}

interface ICandidate {
  id: string;
  workflowId: string;
  createdBy: string | null;
  targetStatusId: string | null;
  allowBackward: boolean;
  requireAllMerged: boolean;
}

interface IStatus {
  id: string;
  name: string;
  isActive: boolean;
  categoryOrder: number | null;
}

interface IDeveloper {
  userId: string;
  name: string;
}

interface ISkip {
  reason: GitAutomationSkipReason;
  targetStatusId: string | null;
  waitingFor?: number[];
}

interface IWorkflowJoin {
  id: string;
  organization_id: string;
  is_archived: boolean | null;
  is_active: boolean | null;
  is_draft: boolean | null;
  created_by: string | null;
}

@Injectable()
export class GitStatusAutomationService {
  private readonly logger = new Logger(GitStatusAutomationService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly identities: GitIdentitiesService,
    private readonly assignments: WorkflowAssignmentsService,
    @Optional()
    @Inject(WORKFLOW_ENGINE_SERVICE)
    private readonly engine?: IWorkflowEngineRuntime,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** Applies one development event to each of its tasks independently, skipping spaces with Development off. Never throws. */
  async handle(event: IGitDevEvent): Promise<void> {
    if (!event.taskIds.length || !this.engine) return;

    try {
      const taskIds = await developmentTaskIds(
        this.db,
        event.organizationId,
        event.taskIds,
        event.repositoryId,
      );

      if (!taskIds.size) return;

      const candidates = await this.candidates(event);

      if (!candidates.size) return;

      const developer = await this.developer(event);

      for (const taskId of taskIds) {
        try {
          await this.applyToTask(event, taskId, candidates, developer);
        } catch (error) {
          this.logger.warn(
            `status automation ${event.event} task ${taskId}: ${message(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `status automation ${event.event} org ${event.organizationId}: ${message(error)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Per task
  // ---------------------------------------------------------------------------

  private async applyToTask(
    event: IGitDevEvent,
    taskId: string,
    candidatesByWorkflow: Map<string, ICandidate[]>,
    developer: IDeveloper | null,
  ): Promise<void> {
    const org = event.organizationId;
    const task = await this.task(org, taskId);

    if (!task?.space_id) return;
    if (!(await this.spaceAllows(org, task.space_id))) return;

    const assignment = await this.assignments.findActiveAssignmentForType(
      org,
      task.space_id,
      task.task_type_id ?? '*',
    );
    const candidates = assignment
      ? (candidatesByWorkflow.get(assignment.workflow_id) ?? [])
      : [];

    if (!candidates.length) return;

    const statuses = await this.statuses(
      org,
      task.space_id,
      [task.status_id, ...candidates.map((c) => c.targetStatusId)].filter(
        (id): id is string => !!id,
      ),
    );
    const current = task.status_id ? statuses.get(task.status_id) : undefined;
    const skips: ISkip[] = [];

    for (const candidate of candidates) {
      const target = candidate.targetStatusId
        ? statuses.get(candidate.targetStatusId)
        : undefined;

      if (!target?.isActive) {
        skips.push({
          reason: 'target_missing',
          targetStatusId: candidate.targetStatusId,
        });
        continue;
      }

      // Already there (also: a second event for a move that already happened).
      if (target.id === task.status_id) return;

      if (
        !candidate.allowBackward &&
        current?.categoryOrder != null &&
        target.categoryOrder != null &&
        target.categoryOrder < current.categoryOrder
      )
        continue;

      if (event.event === 'pr_merged' && candidate.requireAllMerged) {
        const waitingFor = await this.openPullRequests(
          org,
          taskId,
          event.subject.pullRequestId,
        );

        // The other pull requests block every pr_merged move of this task, so later candidates wait too.
        if (waitingFor.length) {
          skips.push({
            reason: 'waiting_other_prs',
            targetStatusId: target.id,
            waitingFor,
          });
          break;
        }
      }

      const user =
        (developer && (await this.requestUser(org, developer.userId))) ||
        (await this.requestUser(org, candidate.createdBy));

      if (!user) continue;

      // Margin for clock skew between this server and the database (changed_at is the database's now()).
      const startedAt = new Date(Date.now() - CLOCK_SKEW_MS).toISOString();

      try {
        await this.engine!.executeTransition({
          taskId,
          transitionId: candidate.id,
          screenInput: {},
          user,
          executionId: randomUUID(),
        });
      } catch (error) {
        const reason = skipReasonOf(error);

        if (!reason) throw error;

        skips.push({ reason, targetStatusId: target.id });
        continue;
      }

      await this.annotate(
        event,
        task,
        user.userId,
        startedAt,
        developer,
        current ?? null,
        target,
      );

      return;
    }

    const skip = REASON_ORDER.map((reason) =>
      skips.find((s) => s.reason === reason),
    ).find(Boolean);

    if (skip) await this.logSkip(event, task, skip, statuses, developer);
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  /**
   * The organization's live transitions with a matching trigger, per workflow, in the workflow's own order.
   * ponytail: one containment query per event; cache per workflow version if webhook volume ever needs it.
   */
  private async candidates(
    event: IGitDevEvent,
  ): Promise<Map<string, ICandidate[]>> {
    const { data, error } = await this.db
      .from('workflow_transitions')
      .select(
        'id, workflow_id, sort_order, to_node_id, triggers, workflows!inner(id, organization_id, is_archived, is_active, is_draft, created_by)',
      )
      .eq('workflows.organization_id', event.organizationId)
      .filter('triggers', 'cs', JSON.stringify([{ type: TRIGGER_TYPE }]))
      .order('sort_order', { ascending: true });

    if (error) throw new Error(error.message);

    const rows = (data ?? []) as unknown as {
      id: string;
      workflow_id: string;
      to_node_id: string | null;
      triggers: unknown[] | null;
      workflows: IWorkflowJoin | IWorkflowJoin[] | null;
    }[];
    const matching = rows.flatMap((row) => {
      const workflow = Array.isArray(row.workflows)
        ? row.workflows[0]
        : row.workflows;

      if (
        !workflow ||
        workflow.organization_id !== event.organizationId ||
        workflow.is_archived ||
        workflow.is_active === false ||
        workflow.is_draft === true
      )
        return [];

      const config = (row.triggers ?? [])
        .map(
          (t) => normalizeRuleConfig(t) as Partial<GitDevelopmentEventConfig>,
        )
        .find(
          (c) =>
            c?.type === TRIGGER_TYPE &&
            c.event === event.event &&
            (!c.provider ||
              c.provider === 'any' ||
              c.provider === event.provider),
        );

      return config ? [{ row, workflow, config }] : [];
    });

    if (!matching.length) return new Map();

    const nodeIds = [
      ...new Set(
        matching
          .map((m) => m.row.to_node_id)
          .filter((id): id is string => !!id),
      ),
    ];
    const nodes = new Map<string, string | null>();

    if (nodeIds.length) {
      const res = await this.db
        .from('workflow_nodes')
        .select('id, status_id')
        .in('id', nodeIds)
        .in('workflow_id', [
          ...new Set(matching.map((m) => m.row.workflow_id)),
        ]);

      if (res.error) throw new Error(res.error.message);

      for (const node of (res.data ?? []) as {
        id: string;
        status_id: string | null;
      }[])
        nodes.set(node.id, node.status_id);
    }

    const byWorkflow = new Map<string, ICandidate[]>();

    for (const { row, workflow, config } of matching) {
      const list = byWorkflow.get(row.workflow_id) ?? [];

      list.push({
        id: row.id,
        workflowId: row.workflow_id,
        createdBy: workflow.created_by,
        targetStatusId: row.to_node_id
          ? (nodes.get(row.to_node_id) ?? null)
          : null,
        allowBackward: config.allow_backward === true,
        requireAllMerged: config.require_all_merged !== false,
      });
      byWorkflow.set(row.workflow_id, list);
    }

    return byWorkflow;
  }

  /** The developer's XISUITE account: by provider user id, else by username (members only, no bots). */
  private async developer(event: IGitDevEvent): Promise<IDeveloper | null> {
    const { externalId, login } = event.actor;

    if (externalId) {
      const byId = await this.identities.resolveAuthors(
        event.organizationId,
        event.provider,
        [{ externalId, login: login ?? '' }],
        event.host,
      );
      const hit = byId.get(externalId);

      if (hit) return { userId: hit.userId, name: hit.name };
    }

    if (login) {
      const byLogin = await this.identities.resolveLogins(
        event.organizationId,
        event.provider,
        [login],
        event.host,
      );
      const hit = byLogin.get(login);

      if (hit) return { userId: hit.userId, name: hit.name };
    }

    return null;
  }

  private async task(org: string, taskId: string): Promise<ITaskRow | null> {
    const { data, error } = await this.db
      .from('tasks')
      .select('id, space_id, task_type_id, status_id')
      .eq('id', taskId)
      .eq('organization_id', org)
      .maybeSingle();

    if (error) throw new Error(error.message);

    return (data as ITaskRow | null) ?? null;
  }

  /** Off for an archived space and when a space admin switched the automation off. */
  private async spaceAllows(org: string, spaceId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('spaces')
      .select('is_archived, settings')
      .eq('id', spaceId)
      .eq('organization_id', org)
      .maybeSingle();

    if (error) throw new Error(error.message);

    const space = data as {
      is_archived: boolean | null;
      settings: Record<string, unknown> | null;
    } | null;

    return (
      !!space &&
      !space.is_archived &&
      space.settings?.gitStatusAutomation !== false
    );
  }

  /** Statuses with their category order; a status switched off in the space counts as inactive. */
  private async statuses(
    org: string,
    spaceId: string,
    ids: string[],
  ): Promise<Map<string, IStatus>> {
    const unique = [...new Set(ids)];
    const result = new Map<string, IStatus>();

    if (!unique.length) return result;

    const { data, error } = await this.db
      .from('task_statuses')
      .select('id, name, is_active, category_id')
      .eq('organization_id', org)
      .in('id', unique);

    if (error) throw new Error(error.message);

    const rows = (data ?? []) as {
      id: string;
      name: string;
      is_active: boolean | null;
      category_id: string | null;
    }[];
    const categoryIds = [
      ...new Set(
        rows.map((r) => r.category_id).filter((id): id is string => !!id),
      ),
    ];
    const order = new Map<string, number>();

    if (categoryIds.length) {
      const res = await this.db
        .from('status_categories')
        .select('id, sort_order')
        .eq('organization_id', org)
        .in('id', categoryIds);

      if (res.error) throw new Error(res.error.message);

      for (const c of (res.data ?? []) as { id: string; sort_order: number }[])
        order.set(c.id, c.sort_order);
    }

    const overrides = await this.db
      .from('space_status_overrides')
      .select('status_id, is_enabled')
      .eq('space_id', spaceId)
      .in('status_id', unique);

    if (overrides.error) throw new Error(overrides.error.message);

    const disabled = new Set(
      ((overrides.data ?? []) as { status_id: string; is_enabled: boolean }[])
        .filter((o) => o.is_enabled === false)
        .map((o) => o.status_id),
    );

    for (const row of rows)
      result.set(row.id, {
        id: row.id,
        name: row.name,
        isActive: row.is_active !== false && !disabled.has(row.id),
        categoryOrder: row.category_id
          ? (order.get(row.category_id) ?? null)
          : null,
      });

    return result;
  }

  /** Numbers of the task's other linked pull requests that are still open (drafts included). */
  private async openPullRequests(
    org: string,
    taskId: string,
    exceptPullRequestId: string | undefined,
  ): Promise<number[]> {
    const { data, error } = await this.db
      .from('git_pull_request_tasks')
      .select(
        'pull_request:git_pull_requests!git_pull_request_tasks_pull_request_fkey!inner(id, number, state)',
      )
      .eq('organization_id', org)
      .eq('task_id', taskId)
      .eq('state', 'linked');

    if (error) throw new Error(error.message);

    return (
      (data ?? []) as unknown as {
        pull_request: { id: string; number: number; state: string } | null;
      }[]
    )
      .map((row) => row.pull_request)
      .filter(
        (pr): pr is { id: string; number: number; state: string } =>
          !!pr && pr.state === 'open' && pr.id !== exceptPullRequestId,
      )
      .map((pr) => pr.number)
      .sort((a, b) => a - b);
  }

  /**
   * The engine's caller identity for a `public.users` row (built as the legacy git triggers build it), or null
   * when there is nobody to run as: no id, no such user, or not (any longer) a member of the organization.
   */
  private async requestUser(
    org: string,
    userId: string | null,
  ): Promise<RequestUser | null> {
    if (!userId) return null;

    const member = await this.db
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', org)
      .eq('user_id', userId)
      .maybeSingle();

    if (member.error) throw new Error(member.error.message);
    if (!member.data) return null;

    const { data, error } = await this.db
      .from('users')
      .select('id, auth_user_id, email, role, is_active')
      .eq('id', userId)
      .maybeSingle();

    if (error) throw new Error(error.message);

    const row = data as {
      id: string;
      auth_user_id: string | null;
      email: string | null;
      role: string | null;
      is_active: boolean | null;
    } | null;

    if (!row) return null;

    return {
      authUserId: row.auth_user_id ?? row.id,
      userId: row.id,
      email: row.email ?? 'git-automation@system.local',
      organizationId: org,
      memberships: [],
      role: row.role,
      isActive: row.is_active ?? true,
      appMetadata: { fired_by: 'git_development_event' },
    } as RequestUser;
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  private metadata(
    event: IGitDevEvent,
    developer: IDeveloper | null,
  ): Record<string, unknown> {
    return {
      source: 'git',
      provider: event.provider,
      event: event.event,
      subject: event.subject,
      actor: {
        login: event.actor.login,
        userId: developer?.userId ?? null,
        name: developer?.name ?? null,
      },
    };
  }

  /**
   * Marks the status change log_task_history just wrote for this move with its source. That trigger logs only a
   * change of the legacy `status` text, so a move within one legacy status (In Progress -> In Review) has no row:
   * then the row is written here, with the status names.
   * ponytail: matched as the newest unmarked status change by the same user since the move started; a manual
   * change by that same user in the same instant could take the label instead (cosmetic only).
   */
  private async annotate(
    event: IGitDevEvent,
    task: ITaskRow,
    userId: string,
    since: string,
    developer: IDeveloper | null,
    from: IStatus | null,
    to: IStatus,
  ): Promise<void> {
    const taskId = task.id;
    const { data, error } = await this.db
      .from('task_history')
      .select('id')
      .eq('organization_id', event.organizationId)
      .eq('task_id', taskId)
      .eq('action', 'status_change')
      .eq('changed_by', userId)
      .gte('changed_at', since)
      .is('metadata', null)
      .order('changed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      this.logger.warn(`status automation history ${taskId}: ${error.message}`);

      return;
    }

    if (!data) {
      const res = await this.db.from('task_history').insert({
        task_id: taskId,
        organization_id: event.organizationId,
        action: 'status_change',
        field_name: 'status',
        old_value: from?.name ?? null,
        new_value: to.name,
        changed_by: userId,
        metadata: this.metadata(event, developer),
      });

      if (res.error)
        this.logger.warn(
          `status automation history ${taskId}: ${res.error.message}`,
        );

      return;
    }

    const res = await this.db
      .from('task_history')
      // log_task_history stores the legacy status text (In Review is `in_progress`): name the real statuses.
      .update({
        old_value: from?.name ?? null,
        new_value: to.name,
        metadata: this.metadata(event, developer),
      })
      .eq('id', (data as { id: string }).id)
      .eq('organization_id', event.organizationId);

    if (res.error)
      this.logger.warn(
        `status automation history ${taskId}: ${res.error.message}`,
      );
  }

  private async logSkip(
    event: IGitDevEvent,
    task: ITaskRow,
    skip: ISkip,
    statuses: Map<string, IStatus>,
    developer: IDeveloper | null,
  ): Promise<void> {
    const status = (id: string | null) => {
      const s = id ? statuses.get(id) : undefined;

      return s ? { id: s.id, name: s.name } : null;
    };

    const { error } = await this.db.from('task_history').insert({
      task_id: task.id,
      organization_id: event.organizationId,
      action: 'git_automation_skipped',
      field_name: 'status',
      old_value: status(task.status_id),
      new_value: status(skip.targetStatusId),
      changed_by: developer?.userId ?? null,
      metadata: {
        ...this.metadata(event, developer),
        reason: skip.reason,
        ...(skip.waitingFor ? { waitingFor: skip.waitingFor } : {}),
      },
    });

    if (error)
      this.logger.warn(`status automation skip ${task.id}: ${error.message}`);
  }
}

/** The engine's refusal, as History explains it; null for anything unexpected (logged by the caller). */
export function skipReasonOf(error: unknown): GitAutomationSkipReason | null {
  if (error instanceof ForbiddenException) return 'condition_failed';
  if (error instanceof UnprocessableEntityException) return 'validator_failed';
  if (error instanceof BadRequestException)
    return /current status/i.test(error.message)
      ? 'not_allowed_from_current'
      : 'validator_failed';

  return null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
