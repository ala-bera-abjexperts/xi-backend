/**
 * @fileoverview POST /chat/agent/runs/:id/undo (ROB-12): removes what Robert made, as the person
 * pressing it. The database decides under its locks; this decides the order and reports each item.
 * @module src/chat-agent/agent-undo.service
 */
import { ConflictException, Injectable, InternalServerErrorException, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ChatAccessService } from '../chat/chat-access.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { TasksService } from '../tasks/tasks.service';
import { AgentPlansService } from './agent-plans.service';
import { isSuggestionKind } from './pipeline/agent-kinds';
import { AgentUndoRulesService, UNDOABLE_KINDS } from './agent-undo-rules.service';
import { AgentRunViewService, type AgentRunView } from './agent-run-view.service';
import { AgentRunsRepository, type AgentActionRow, type AgentUndoBlocker } from './agent-runs.repository';

/** Refusals the database cannot see when it checks the parent. */
const KEPT_OUTSIDE_DB = new Set(['no_permission', 'undo_failed', 'child_kept']);

const isOpen = (a: AgentActionRow) => a.status === 'executed' && UNDOABLE_KINDS.has(a.kind);

/** The pressed actions and everything that depends on them, among what can still be undone. */
export function withDescendants(pressed: AgentActionRow[], all: AgentActionRow[]): AgentActionRow[] {
  const ordinals = new Set(pressed.map((a) => a.ordinal));
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of all) {
      if (isOpen(a) && !ordinals.has(a.ordinal) && a.depends_on !== null && ordinals.has(a.depends_on)) {
        ordinals.add(a.ordinal);
        grew = true;
      }
    }
  }
  return all.filter((a) => ordinals.has(a.ordinal) && isOpen(a));
}

/** Children before parents, whatever the order of the cards. */
export function deepestFirst(items: AgentActionRow[], all: AgentActionRow[]): AgentActionRow[] {
  const byOrdinal = new Map(all.map((a) => [a.ordinal, a]));
  const depth = (a: AgentActionRow, seen = new Set<number>()): number => {
    const parent = a.depends_on === null ? undefined : byOrdinal.get(a.depends_on);
    if (!parent || seen.has(parent.ordinal)) return 0;
    return 1 + depth(parent, seen.add(parent.ordinal));
  };
  return [...items].sort((x, y) => depth(y) - depth(x) || y.ordinal - x.ordinal);
}

@Injectable()
export class AgentUndoService {
  private readonly logger = new Logger(AgentUndoService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly runs: AgentRunsRepository,
    private readonly views: AgentRunViewService,
    private readonly access: ChatAccessService,
    private readonly rules: AgentUndoRulesService,
    @Optional() private readonly productPlans?: AgentPlansService,
    // What a person's task delete does after the delete (audit 2026-11-10).
    @Optional() private readonly tasks?: TasksService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Without `actionIds`, the whole batch: as far as it goes. With them, one card and its children. */
  async undo(user: RequestUser, runId: string, actionIds?: string[]): Promise<AgentRunView> {
    const { data: run, error } = await this.client
      .from('agent_runs')
      .select('id, organization_id, conversation_id, invoker_id')
      .eq('id', runId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();
    if (error) throw new InternalServerErrorException('Could not load the run');
    if (!run) throw new NotFoundException('Run not found');

    const isAdmin = await this.rules.isTenantAdmin(user);
    if (run.invoker_id !== user.userId && !isAdmin) throw new NotFoundException('Run not found');
    // Nobody undoes from a card they can't see. A private chat stays private to an admin too.
    await this.access.getReadable(user, run.conversation_id);

    const { data, error: actionsError } = await this.client
      .from('agent_actions')
      .select('*')
      .eq('run_id', run.id)
      .eq('organization_id', run.organization_id)
      .order('ordinal', { ascending: true });
    if (actionsError) throw new InternalServerErrorException('Could not load the proposals');
    const all = (data ?? []) as AgentActionRow[];

    const pressed = actionIds?.length
      ? all.filter((a) => actionIds.includes(a.id) && isOpen(a))
      : all.filter(isOpen);
    const targets = withDescendants(pressed, all);
    const claimed = targets.length
      ? await this.runs.claimUndo(run.organization_id, user.userId, isAdmin, targets.map((a) => a.id))
      : [];
    if (!claimed.length) {
      // Pressed twice, in a second tab, too late, or a Confirm of this run is still working.
      throw new ConflictException({
        code: 'undo_changed',
        message: 'This can no longer be undone as it was',
        data: { run: await this.views.viewOne(user, run.id) },
      });
    }

    const finished = new Set<string>();
    // Ordinals kept for a reason the database does not see (permission, an error). A parent of one
    // stays too, or its delete would take the child along. A child the database blocks is already
    // seen by the parent's own check (has_subtasks, has_items).
    const kept = new Set<number>();
    const undone = new Set<number>();
    const finish = async (action: AgentActionRow, outcome: 'undone' | 'blocked', blocker?: Partial<AgentUndoBlocker>) => {
      finished.add(action.id);
      if (outcome === 'blocked' && KEPT_OUTSIDE_DB.has(blocker?.code ?? '')) kept.add(action.ordinal);
      if (outcome === 'undone') undone.add(action.ordinal);
      await this.runs
        .completeUndo({
          actionId: action.id,
          execToken: action.exec_token as string,
          outcome,
          reason: blocker?.code ?? null,
          reasonParams: blocker?.count ? { count: blocker.count, ...(blocker.by && { by: blocker.by }) } : null,
          actorId: user.userId,
        })
        // The claim stays; the sweep looks at the object and sets it right.
        .catch((err: unknown) => this.logger.error(`Robert action ${action.id} undo not completed: ${String(err)}`));
    };

    // One card: its whole tree goes or none of it does.
    if (actionIds?.length) {
      for (const root of pressed) {
        const tree = withDescendants([root], all).map((a) => a.id);
        const inTree = claimed.filter((a) => tree.includes(a.id));
        const problem = inTree.length ? await this.firstProblem(user, root) : null;
        if (!problem) continue;
        for (const a of inTree) await finish(a, 'blocked', a.id === root.id ? problem : { code: 'parent_blocked' });
      }
    }

    // Plans whose items went: their WBS numbers are worked out again once, at the end (1.22).
    const renumber = new Set<string>();
    const queue = deepestFirst(claimed, all);
    for (const [n, action] of queue.entries()) {
      if (finished.has(action.id)) continue;
      // Still working: the claims left stay fresh, so the 3-minute sweep never takes them over.
      const left = queue.slice(n).filter((a) => !finished.has(a.id));
      await this.runs
        .touchUndo(
          action.organization_id,
          left.map((a) => a.id),
          left.map((a) => a.exec_token as string),
        )
        .catch((err: unknown) => this.logger.warn(`Robert undo heartbeat failed: ${String(err)}`));
      if (all.some((c) => c.depends_on === action.ordinal && kept.has(c.ordinal))) {
        await finish(action, 'blocked', { code: 'child_kept' });
        continue;
      }
      try {
        if (!(await this.rules.mayDelete(user, action))) {
          await finish(action, 'blocked', { code: 'no_permission' });
          continue;
        }
        const planId =
          action.kind === 'plan_item'
            ? await this.productPlans?.planOfTask(action.organization_id, action.entity_id)
            : null;
        const task = action.entity_type === 'task' ? await this.taskRow(action) : null;
        const out = await this.compensate(user, action);
        if (out.deleted && planId) renumber.add(planId);
        // A link's plan comes from the row the database removed, never a guess among the task's plans.
        const linkPlan = (out as { plan_id?: string }).plan_id;
        if (out.deleted && action.kind === 'plan_link' && linkPlan) renumber.add(linkPlan);
        if (out.deleted && task)
          await this.tasks
            ?.afterCascadeDelete(action.organization_id, task, user.userId, out)
            .catch((err: unknown) => this.logger.warn(`Robert action ${action.id}: after-delete steps failed: ${String(err)}`));
        if (out.deleted) await finish(action, 'undone');
        else await finish(action, 'blocked', out.blockers[0] ?? { code: 'undo_failed' });
      } catch (err) {
        // P0002 from the database: the object isn't there any more.
        const gone = err instanceof NotFoundException;
        if (!gone) this.logger.error(`Robert action ${action.id} not undone: ${String(err)}`);
        await finish(action, 'blocked', { code: gone ? 'gone' : 'undo_failed' });
      }
    }

    // A plan of this batch that went needs no numbers; recalculateWbs finds nothing then.
    if (renumber.size) await this.productPlans?.recalculate(renumber);
    await this.cancelOrphans(run.organization_id, all, undone);
    void this.views.announce(run.id);
    return this.views.viewOne(user, run.id);
  }

  /**
   * Cards still open under something that was just undone can never be confirmed ("Confirm the
   * parent first" forever): they are cancelled, the whole chain below (audit 2026-11-10).
   */
  private async cancelOrphans(organizationId: string, all: AgentActionRow[], undone: Set<number>): Promise<void> {
    if (!undone.size) return;
    const gone = new Set(undone);
    const ids: string[] = [];
    for (let grew = true; grew; ) {
      grew = false;
      for (const a of all)
        if (a.depends_on !== null && gone.has(a.depends_on) && !gone.has(a.ordinal) && (a.status === 'proposed' || a.status === 'failed')) {
          gone.add(a.ordinal);
          ids.push(a.id);
          grew = true;
        }
    }
    if (!ids.length) return;
    await this.runs
      .cancelActions(organizationId, 'parent_undone', { actionIds: ids })
      .catch((err: unknown) => this.logger.warn(`Robert: open children of undone cards not cancelled: ${String(err)}`));
  }

  private async firstProblem(user: RequestUser, action: AgentActionRow): Promise<Partial<AgentUndoBlocker> | null> {
    if (!(await this.rules.mayDelete(user, action))) return { code: 'no_permission' };
    const blockers = await this.runs.undoBlockers({
      organizationId: action.organization_id,
      entityType: action.entity_type as never,
      entityId: action.entity_id,
      actorId: user.userId,
      since: action.executed_at as string,
      runId: action.run_id,
    });
    return blockers[0] ?? null;
  }

  /** The task as it is before its delete: what the event and the audit row name. */
  private async taskRow(action: AgentActionRow): Promise<{ id: string; key: string; summary: string; space_id: string } | null> {
    const { data } = await this.client
      .from('tasks')
      .select('id, key, summary, space_id')
      .eq('id', action.entity_id)
      .eq('organization_id', action.organization_id)
      .maybeSingle();
    return (data as { id: string; key: string; summary: string; space_id: string } | null) ?? null;
  }

  private compensate(user: RequestUser, action: AgentActionRow) {
    const shared = {
      organizationId: action.organization_id,
      actorId: user.userId,
      since: action.executed_at as string,
      runId: action.run_id,
    };
    if (action.kind === 'wiki_page') return this.runs.undoPage({ ...shared, pageId: action.entity_id });
    if (action.kind === 'process') return this.runs.undoProcess({ ...shared, processId: action.entity_id });
    if (action.kind === 'plan') return this.runs.undoPlan({ ...shared, planId: action.entity_id });
    if (action.kind === 'plan_item') return this.runs.undoPlanItem({ ...shared, taskId: action.entity_id });
    // 1.22.1: only the link goes; the task is a person's and stays as it is.
    if (action.kind === 'plan_link') return this.runs.undoPlanLink({ ...shared, linkId: action.entity_id });
    // 1.23: only the suggestion's own row goes (dates: back to none); never a person's.
    if (isSuggestionKind(action.kind))
      return this.runs.undoPlanSuggestion({ ...shared, kind: action.kind, entityId: action.entity_id });
    return this.runs.undoTask({ ...shared, taskId: action.entity_id });
  }
}
