/**
 * @fileoverview In-process @Cron dispatcher that delivers the runtime for
 * `cron` workflow triggers. Every minute it enumerates cron transitions on
 * published + active workflows, decides which are due inside a jitter-safe
 * lookback window, resolves the governed tasks (via source statuses +
 * workflow assignments), and fires each one through
 * {@link WorkflowEngineService.executeTransition}.
 *
 * The approach is stateless: no schedule table is persisted. Exactly-once
 * behaviour is delegated to the engine's idempotency cache via a
 * DETERMINISTIC `executionId` keyed on the scheduled occurrence
 * (`cron:<transitionId>:<taskId>:<scheduledISO>`), plus the engine's row
 * lock, version check, and source-validity guards. Overlapping ticks,
 * retries, and a repeated fire within the same scheduled minute therefore
 * collapse to a single effect.
 *
 * The corresponding {@link CronTrigger} handler keeps its v1
 * subscribe()/unsubscribe() stubs — runtime delivery is owned here, mirroring
 * how {@link WorkflowTriggerRegistryService} owns `parent_transitioned`.
 *
 * @module src/workflow-cron/workflow-cron.service
 * @author Rajbha Manek
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CronExpressionParser } from 'cron-parser';

import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { normalizeRuleConfig } from '../workflow-engine/handlers/rule-config';
import { WorkflowEngineService } from '../workflow-engine/workflow-engine.service';

/**
 * Safety cap on the number of tasks fired per assignment scope in one tick.
 * A broad cron (e.g. a `global` transition over a large space) is bounded so a
 * single tick cannot fan out unboundedly. When a full page is returned we log
 * that the cap was hit.
 */
const MAX_TASKS_PER_FIRE = 500;

/**
 * Lookback window for the due check. 61s on a 60s tick gives a 1s overlap so
 * no scheduled occurrence is missed under scheduler jitter; the deterministic
 * `executionId` (keyed on the scheduled occurrence, not the tick time) makes
 * any resulting overlap-double idempotent.
 */
const WINDOW_LOOKBACK_MS = 61_000;

/**
 * Registered name for the workflow-cron `@Cron` job. The standalone worker
 * (`pnpm dev:workflow-cron`) keeps this job and stops every other scheduled job
 * that rides along transitively, so the worker process runs ONLY this tick.
 */
export const WORKFLOW_CRON_JOB_NAME = 'workflow-cron-tick';

/** A single `cron` entry from a transition's `triggers` JSONB array. */
interface ICronTriggerCfg {
  type: string;
  expression?: string;
  timezone?: string;
  [key: string]: unknown;
}

/** Joined `workflows` shape returned by the enumeration query. */
interface IWorkflowJoin {
  id: string;
  organization_id: string;
  space_id: string | null;
  created_by: string | null;
  is_active: boolean | null;
  is_draft: boolean | null;
}

/** Raw row returned by the cron-transition enumeration query. */
interface ICronTransitionRow {
  id: string;
  workflow_id: string;
  kind: string;
  to_node_id: string;
  triggers: ICronTriggerCfg[] | null;
  workflows: IWorkflowJoin | IWorkflowJoin[] | null;
}

/** Minimal `workflow_assignments` row used to resolve the target scope. */
interface IAssignmentRow {
  space_id: string;
  task_type_level_id: string;
}

/** Minimal `users` row used to synthesize the acting {@link RequestUser}. */
interface IUserRow {
  id: string;
  email: string | null;
  role: string | null;
  is_active: boolean | null;
}

/** Summary of a single tick, logged as a one-line health signal. */
interface ITickStats {
  due: number;
  fired: number;
  failed: number;
}

@Injectable()
export class WorkflowCronService {
  private readonly logger = new Logger(WorkflowCronService.name);

  /**
   * Process-local re-entrancy guard. We hold no DB lock (unlike the outbox
   * processor's SKIP-LOCKED claim), so a long-running tick must not overlap
   * itself — the guard drops a new tick while the prior one is still working.
   */
  private running = false;

  /**
   * Two-generation rotating window of executionIds already logged as `fired`.
   * The 61s lookback over a 60s tick lets one scheduled occurrence be "due" on
   * two ADJACENT ticks; the engine dedups the effect but still returns success
   * on the replay, so we suppress the duplicate `fired` trigger-event here. The
   * duplicate is provably confined to adjacent ticks, so two generations
   * suffice and the window self-prunes on each rotation (no unbounded growth).
   */
  private firedThisTick = new Set<string>();
  private firedPrevTick = new Set<string>();

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly engine: WorkflowEngineService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Top of every minute. Skips if a prior tick is still running, wraps the
   * whole body so it can never throw out of the scheduler, and logs a
   * one-line `{ due, fired, failed }` summary.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: WORKFLOW_CRON_JOB_NAME })
  async tick(): Promise<void> {
    // Runtime lives in the dedicated worker (`pnpm dev:workflow-cron`, which
    // sets WORKFLOW_CRON_WORKER=1). In the main API the flag is unset, so the
    // tick is a silent no-op — no log spam, no in-process cron work.
    if (process.env.WORKFLOW_CRON_WORKER !== '1') {
      return;
    }

    if (this.running) {
      this.logger.debug(
        'workflow cron tick skipped — previous tick still running',
      );

      return;
    }

    this.running = true;

    try {
      const stats = await this.runTick();

      this.logger.log(
        `workflow cron tick: due=${stats.due} fired=${stats.fired} failed=${stats.failed}`,
      );
    } catch (err) {
      this.logger.error(
        `Unhandled error in workflow cron tick: ${(err as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Single-shot dispatch — separated from {@link tick} so tests can drive it
   * without the re-entrancy guard or scheduler. Enumerates due cron
   * transitions and fires each governed task, swallowing per-task failures so
   * one bad target never blocks its siblings.
   */
  async runTick(): Promise<ITickStats> {
    // Rotate the fired-executionId window once per tick (before any fire) so a
    // scheduled occurrence caught by this tick and the next is logged once.
    this.firedPrevTick = this.firedThisTick;
    this.firedThisTick = new Set<string>();

    const now = Date.now();
    const stats: ITickStats = { due: 0, fired: 0, failed: 0 };

    // Enumerate every transition whose `triggers` JSONB contains a cron entry
    // on a published + active workflow. Mirrors the registry rebuild query:
    // supabase-js `.contains()` serializes a JS array to a Postgres array
    // literal, which the jsonb `cs` operator rejects — so send a JSON string
    // via `.filter(..,'cs',..)` instead.
    const res = await this.client
      .from('workflow_transitions')
      .select(
        'id, workflow_id, kind, to_node_id, triggers, workflows!inner(id, organization_id, space_id, created_by, is_active, is_draft)',
      )
      .filter('triggers', 'cs', '[{"type":"cron"}]')
      .eq('workflows.is_active', true)
      .eq('workflows.is_draft', false);

    if (res.error) {
      this.logger.error(
        `Failed to enumerate cron transitions: ${res.error.message}`,
      );

      return stats;
    }

    const rows = (res.data ?? []) as unknown as ICronTransitionRow[];

    for (const row of rows) {
      const workflow = this.unwrapWorkflow(row);

      if (!workflow) continue;
      if (!Array.isArray(row.triggers)) continue;

      // `initial` transitions only fire from runInitialPostFunctions; they can
      // never be cron-fired regardless of their triggers array.
      if (row.kind === 'initial') continue;

      for (const trig of row.triggers) {
        const cfg = normalizeRuleConfig(trig) as ICronTriggerCfg;

        if (!cfg || cfg.type !== 'cron') continue;

        const occ = this.computeDueOccurrence(cfg, now);

        // Not due this tick (or a malformed expression — logged + skipped).
        if (!occ) continue;

        stats.due++;

        const scheduledISO = occ.toISOString();

        // Actor: fire as the workflow's creator, mirroring the inbound-webhook
        // fallback. Without an identity there is nothing to authorize against.
        if (!workflow.created_by) {
          this.logger.warn(
            `cron: workflow ${workflow.id} has no created_by — skipping its cron trigger on transition ${row.id}`,
          );

          continue;
        }

        const user = await this.resolveRequestUser(
          workflow.created_by,
          workflow.organization_id,
        );

        // Source statuses gate which tasks a source-scoped transition targets.
        // global / global_loop have no status filter (all tasks in scope).
        const explicitSource =
          row.kind === 'regular' ||
          row.kind === 'common' ||
          row.kind === 'self_loop';
        const sourceStatusIds = explicitSource
          ? await this.resolveSourceStatusIds(row.id)
          : [];

        // A source-scoped transition with no resolvable source statuses has
        // nothing to target — skip rather than firing against everything.
        if (explicitSource && sourceStatusIds.length === 0) continue;

        const assignments = await this.loadAssignments(
          row.workflow_id,
          workflow.organization_id,
        );

        // No assignment → no governed tasks → no-op.
        if (assignments.length === 0) continue;

        for (const assignment of assignments) {
          const taskIds = await this.loadTargetTaskIds(
            workflow.organization_id,
            assignment,
            explicitSource ? sourceStatusIds : null,
          );

          for (const taskId of taskIds) {
            // Deterministic id keyed on the SCHEDULED occurrence (not the tick
            // time) → engine idempotency dedups overlaps/retries, and it doubles
            // as this tick's dedup key for the `fired` trigger-event.
            const executionId = `cron:${row.id}:${taskId}:${scheduledISO}`;

            // Shared identity for the fired / error trigger-event rows so the
            // outcome is the only field that differs between the two branches.
            const eventBase = {
              organizationId: workflow.organization_id,
              spaceId: assignment.space_id,
              workflowId: row.workflow_id,
              transitionId: row.id,
              subjectTaskId: taskId,
              context: {
                expression: cfg.expression ?? null,
                timezone: cfg.timezone ?? 'UTC',
                scheduledOccurrence: scheduledISO,
              },
            };

            try {
              await this.engine.executeTransition({
                taskId,
                transitionId: row.id,
                screenInput: {},
                user,
                executionId,
                // Top-level fire; the engine bounds any cascade (depth>1 → 400).
                transitionDepth: 0,
              });
              stats.fired++;

              // Log the fire once per scheduled occurrence: an occurrence caught
              // by two adjacent ticks returns success on the idempotent replay,
              // so the two-tick window suppresses the duplicate feed row.
              if (
                !this.firedThisTick.has(executionId) &&
                !this.firedPrevTick.has(executionId)
              ) {
                this.firedThisTick.add(executionId);
                this.logTriggerEvent({ ...eventBase, outcome: 'fired' });
              }
            } catch (err) {
              // Source-validity / version / condition / validator rejections are
              // expected here — log and continue so siblings still fire.
              stats.failed++;

              // Only genuine engine/config/DB errors reach the feed; the routine
              // "not firable this tick" rejections stay in the warn log so a
              // per-minute cron never floods the trigger-event feed.
              if (!this.isBenignRejection(err)) {
                this.logTriggerEvent({
                  ...eventBase,
                  outcome: 'error',
                  message: (err as Error).message,
                });
              }

              this.logger.warn(
                `cron: executeTransition failed for task ${taskId} via transition ${row.id}: ${(err as Error).message}`,
              );
            }
          }
        }
      }
    }

    return stats;
  }

  /**
   * Resolve the scheduled occurrence that makes this cron entry due, or `null`
   * when it is not due this tick (or the expression is malformed).
   *
   * `.next()` from `windowStart = now - 61s` is the first occurrence strictly
   * after the lookback point; it is due iff it already elapsed (`<= now`). A
   * bad expression is logged and skipped — it never crashes the tick.
   */
  private computeDueOccurrence(cfg: ICronTriggerCfg, now: number): Date | null {
    const expression = typeof cfg.expression === 'string' ? cfg.expression : '';

    if (!expression) {
      this.logger.warn('cron: trigger has no expression — skipping');

      return null;
    }

    const timezone =
      typeof cfg.timezone === 'string' && cfg.timezone.length > 0
        ? cfg.timezone
        : 'UTC';

    try {
      const windowStart = new Date(now - WINDOW_LOOKBACK_MS);
      const occ = CronExpressionParser.parse(expression, {
        currentDate: windowStart,
        tz: timezone,
      })
        .next()
        .toDate();

      return occ.getTime() <= now ? occ : null;
    } catch (err) {
      this.logger.warn(
        `cron: invalid expression "${expression}" (tz=${timezone}): ${(err as Error).message}`,
      );

      return null;
    }
  }

  /**
   * Resolve the source status ids for an explicit-source transition:
   * `workflow_transition_sources` → `from_node_id[]`, then `workflow_nodes`
   * (kind='status') → `status_id[]`. Returns an empty array on any error or
   * when no status source resolves.
   */
  private async resolveSourceStatusIds(
    transitionId: string,
  ): Promise<string[]> {
    const sourcesRes = await this.client
      .from('workflow_transition_sources')
      .select('from_node_id')
      .eq('transition_id', transitionId);

    if (sourcesRes.error) {
      this.logger.warn(
        `cron: failed to load sources for transition ${transitionId}: ${sourcesRes.error.message}`,
      );

      return [];
    }

    const fromNodeIds = (
      (sourcesRes.data ?? []) as Array<{
        from_node_id: string | null;
      }>
    )
      .map((r) => r.from_node_id)
      .filter((id): id is string => !!id);

    if (fromNodeIds.length === 0) return [];

    const nodesRes = await this.client
      .from('workflow_nodes')
      .select('status_id')
      .in('id', fromNodeIds)
      .eq('kind', 'status');

    if (nodesRes.error) {
      this.logger.warn(
        `cron: failed to load source nodes for transition ${transitionId}: ${nodesRes.error.message}`,
      );

      return [];
    }

    return ((nodesRes.data ?? []) as Array<{ status_id: string | null }>)
      .map((n) => n.status_id)
      .filter((id): id is string => !!id);
  }

  /**
   * Load the space + task-type scope this workflow governs. Returns an empty
   * array on error or when the workflow has no assignment.
   */
  private async loadAssignments(
    workflowId: string,
    organizationId: string,
  ): Promise<IAssignmentRow[]> {
    const res = await this.client
      .from('workflow_assignments')
      .select('space_id, task_type_level_id')
      .eq('workflow_id', workflowId)
      .eq('organization_id', organizationId);

    if (res.error) {
      this.logger.warn(
        `cron: failed to load assignments for workflow ${workflowId}: ${res.error.message}`,
      );

      return [];
    }

    return (res.data ?? []) as IAssignmentRow[];
  }

  /**
   * Enumerate the target task ids for one assignment scope. Filters by
   * `status_id` for source-scoped transitions (null for global scope) and by
   * `task_type_id` unless the assignment is the org-default catch-all (`'*'`).
   * Capped at {@link MAX_TASKS_PER_FIRE}; a full page logs a cap-hit warning.
   */
  private async loadTargetTaskIds(
    organizationId: string,
    assignment: IAssignmentRow,
    sourceStatusIds: string[] | null,
  ): Promise<string[]> {
    let query = this.client
      .from('tasks')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('space_id', assignment.space_id);

    if (sourceStatusIds) {
      query = query.in('status_id', sourceStatusIds);
    }

    if (assignment.task_type_level_id !== '*') {
      query = query.eq('task_type_id', assignment.task_type_level_id);
    }

    const res = await query.limit(MAX_TASKS_PER_FIRE);

    if (res.error) {
      this.logger.warn(
        `cron: failed to load target tasks for space ${assignment.space_id}: ${res.error.message}`,
      );

      return [];
    }

    const ids = ((res.data ?? []) as Array<{ id: string }>).map((r) => r.id);

    if (ids.length >= MAX_TASKS_PER_FIRE) {
      this.logger.warn(
        `cron: MAX_TASKS_PER_FIRE (${MAX_TASKS_PER_FIRE}) cap hit for space ${assignment.space_id} — remaining tasks fire on a later tick`,
      );
    }

    return ids;
  }

  /**
   * Supabase types infer a joined row as either an object or an array
   * depending on FK cardinality; the runtime returns the embedded object.
   * Collapse to a single {@link IWorkflowJoin}.
   */
  private unwrapWorkflow(row: ICronTransitionRow): IWorkflowJoin | null {
    if (!row.workflows) return null;

    return Array.isArray(row.workflows)
      ? (row.workflows[0] ?? null)
      : row.workflows;
  }

  /**
   * Build the {@link RequestUser} shape the engine expects from the resolved
   * `public.users.id`. Falls back to a minimal system identity when the row
   * cannot be loaded so the transition still fires with the workflow's
   * organization scope. Copied from the inbound-webhook resolver, tagged with
   * `fired_by: 'workflow_trigger_cron'`.
   */
  private async resolveRequestUser(
    userId: string,
    organizationId: string,
  ): Promise<RequestUser> {
    const r = await this.client
      .from('users')
      .select('id, email, role, is_active')
      .eq('id', userId)
      .maybeSingle();

    const data = r.data as IUserRow | null;
    const email = data?.email ?? 'workflow-trigger@system.local';
    const role = data?.role ?? null;
    const isActive = data?.is_active ?? true;

    return {
      authUserId: userId,
      userId,
      email,
      organizationId,
      memberships: [],
      role,
      isActive,
      appMetadata: { fired_by: 'workflow_trigger_cron' },
    };
  }

  /**
   * Persist a cron trigger outcome to `workflow_trigger_events` so fires appear
   * in the workflow editor's "Trigger events" feed alongside parent_transitioned.
   * Fire-and-forget, mirroring {@link WorkflowTriggerRegistryService}'s logger: a
   * logging failure must never block or slow the tick, so the insert is detached
   * and its rejection only warned about. The outer try/catch additionally guards
   * a synchronous throw from the client (e.g. a stubbed client without `insert`)
   * so logging can never break a fire.
   */
  private logTriggerEvent(row: {
    organizationId: string;
    spaceId: string | null;
    workflowId: string | null;
    transitionId: string | null;
    subjectTaskId: string | null;
    outcome: 'fired' | 'error';
    message?: string;
    context?: Record<string, unknown>;
  }): void {
    try {
      void Promise.resolve(
        this.client.from('workflow_trigger_events').insert({
          organization_id: row.organizationId,
          space_id: row.spaceId,
          workflow_id: row.workflowId,
          transition_id: row.transitionId,
          trigger_type: 'cron',
          outcome: row.outcome,
          subject_task_id: row.subjectTaskId,
          message: row.message ?? null,
          context: row.context ?? null,
        }),
      ).catch((e: unknown) =>
        this.logger.warn(`trigger-event log failed: ${(e as Error).message}`),
      );
    } catch (e) {
      this.logger.warn(`trigger-event log failed: ${(e as Error).message}`);
    }
  }

  /**
   * Classify an executeTransition rejection as an expected "not firable this
   * tick" outcome (kept out of the feed to avoid per-minute flooding) vs. a
   * genuine error worth surfacing. Benign = source no longer matches (BadRequest
   * "not available"), a condition guard returned false (Forbidden "Condition
   * failed"), a validator rejected (Unprocessable), or a version conflict
   * (Conflict — defensive: cron passes no expectedVersion, so the engine's
   * version check is skipped today). Everything else (missing assignment/
   * workflow, unknown rule type, DB/unexpected) is a real error.
   */
  private isBenignRejection(err: unknown): boolean {
    const message = (
      (err as { message?: string })?.message ?? ''
    ).toLowerCase();

    if (err instanceof BadRequestException) {
      return message.includes('not available');
    }

    if (err instanceof ForbiddenException) {
      return message.startsWith('condition failed');
    }

    return (
      err instanceof UnprocessableEntityException ||
      err instanceof ConflictException
    );
  }
}
