/**
 * @fileoverview What the invoker does with Robert's proposals (XE-T353 1.14, plan B4 and B5):
 * edit a field, Confirm, Retry, Cancel, thumbs up or down, and the sweep's reconciliation of a
 * Confirm that hung.
 *
 * Confirm, in this order:
 *  1. Pre-check without a write: every requested action is resolved again with fresh data, as
 *     the invoker (SEC-02). One that is no longer confirmable, or whose content changed, is
 *     saved (version + 1) and the whole Confirm answers 409 with the fresh view.
 *  2. agent_claim_actions: one conditional UPDATE, so five quick clicks still claim once; a
 *     click that claims nothing gets the current view.
 *  3. The claimed actions run in card order (a parent always has the lower ordinal), each
 *     through TasksMineWriteService.createTask with the action's reserved id: a task that
 *     already exists under that id (a crashed earlier attempt) is adopted, never created twice.
 *  4. The assignee gets a bell when it is not the invoker. A lost bell is only logged.
 * Wiki pages (1.15) take the same steps through WikiMineWriteService.createWikiPage, after the
 * tasks of the same Confirm, so a page can show a task created with it.
 * Every route here answers 404 to anyone but the invoker, other tenants included.
 * @module src/chat-agent/agent-action-executor.service
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  ChatAccessService,
  type ChatConversationRow,
} from '../chat/chat-access.service';
import { ChatConversationsService } from '../chat/chat-conversations.service';
import { TipTapValidationError } from '../common/utils/tiptap-sanitizer';
import { validateFieldValue } from '../custom-fields/utils/custom-field-validation';
import type { CustomField } from '../custom-fields/models/custom-field.model';
import { buildNotificationPath } from '../notifications/notification-link.util';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { TasksMineWriteService } from '../tasks/tasks-mine-write.service';
import type { MyTaskDetail } from '../tasks/tasks.service';
import { WikiLabelsService } from '../wiki/wiki-labels.service';
import { WikiMineWriteService } from '../wiki/wiki-mine-write.service';
import { WikiService } from '../wiki/wiki.service';
import {
  type AgentPlanLinkPlan,
  DEPENDENCY_TYPE_NAMES,
  isPlanLinkPlan,
  isSuggestionPlan,
  AGENT_SUGGESTION_FIELD_KEYS,
  type AgentSuggestionPlan,
  AGENT_FIELD_KEYS,
  AGENT_MEMBER_FIELD_KEYS,
  AGENT_PLAN_FIELD_KEYS,
  AGENT_PLAN_ITEM_FIELD_KEYS,
  AGENT_PROCESS_FIELD_KEYS,
  AGENT_SPACE_FIELD_KEYS,
  AGENT_WIKI_FIELD_KEYS,
  type AgentActionKind,
  type AgentMemberPlan,
  type AgentNewPlan,
  type AgentPlanItemPlan,
  type AgentPlanOf,
  type AgentProductPlan,
  type AgentResolveBatch,
  type AgentResolved,
  AgentResolverService,
  type AgentStoredIntent,
  type AgentWikiPlan,
  isNewPlan,
  isPlanItemPlan,
  isProductPlan,
  isTaskPlan,
  isWikiPlan,
  MAX_LABELS,
  siblingOf,
  strictDay,
} from './agent-resolver.service';
import { AgentGovernanceError, AgentGovernanceService } from './agent-governance.service';
import {
  AgentPlansService,
  PLAN_ITEM_MAX_COST,
  PLAN_ITEM_MAX_HOURS,
  PLAN_ITEM_PRIORITIES,
  PLAN_ITEM_TYPES,
  PLAN_TYPES,
} from './agent-plans.service';
import {
  isGovernanceKind,
  isMemberKind,
  isNewKind,
  isPlanKind,
  isSuggestionKind,
  permOf,
  type AgentSuggestionKind,
  PROCESS_REQUEST_TYPES,
  PROCESS_SCORE_KEYS,
  rankOf,
  SPACE_ROLES,
  tableOf,
} from './pipeline/agent-kinds';
import { fillItemCards, SPACE_PLACEHOLDER, type TipTapNode } from './pipeline/agent-wiki-render';
import { isOpenAction } from './agent-run-phase';
import {
  type AgentRunView,
  AgentRunViewService,
} from './agent-run-view.service';
import {
  type AgentActionRow,
  type AgentRunRow,
  type AgentRunScope,
  AgentRunsRepository,
} from './agent-runs.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOM_KEY =
  /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Fields that only name an id (or a key, for the parent). */
const ID_KEYS = new Set([
  'space',
  'type',
  'status',
  'priority',
  'assignee',
  'parent',
]);
const MAX_ID = 100;
const MAX_TEXT = 60_000;
/** The tree root agent-resolver renders before the page id is known; set at Confirm. */
const PAGE_PLACEHOLDER = '00000000-0000-4000-8000-000000000000';

/** The kind of an action row, as the resolver takes it. */
export const kindOf = (
  action: Pick<AgentActionRow, 'kind'>,
): AgentActionKind =>
  action.kind === 'wiki_page'
    ? 'wiki_page'
    : isNewKind(action.kind) || isPlanKind(action.kind)
      ? (action.kind as AgentActionKind)
      : action.kind === 'subtask'
        ? 'subtask'
        : 'task';

/** Tasks before pages (a page may show a task of the same Confirm), then card order. */
const executionOrder = (a: AgentActionRow, b: AgentActionRow) =>
  rankOf(a.kind) - rankOf(b.kind) || a.ordinal - b.ordinal;

/** One edit of one action (PATCH /chat/agent/runs/:id/actions). */
export interface AgentActionChange {
  actionId: string;
  version: number;
  fields: Record<string, unknown>;
}

type RunRow = Pick<
  AgentRunRow,
  | 'id'
  | 'organization_id'
  | 'conversation_id'
  | 'invoker_id'
  | 'status'
  | 'visibility'
  | 'scope'
  | 'timezone'
>;

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** JSON with sorted keys: a stored (jsonb) and a fresh result compare equal when they are. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** What the invoker confirms: what would be created and each field's state, not the pickers. */
export function materialOf(resolved: Partial<AgentResolved>): string {
  return stable({
    create: resolved.create ?? null,
    confirmable: resolved.confirmable === true,
    fields: (resolved.fields ?? []).map((f) => [
      f.key,
      f.state,
      f.code ?? null,
      f.value ?? null,
    ]),
  });
}

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Plain text as escaped paragraphs: the task editor's HTML, with no markup of the model's. */
export function plainToHtml(text: string | null): string | undefined {
  if (!text) return undefined;
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Stable reason codes below; this one is the connection to the database, not the request. */
const TRANSIENT_DB_ERROR = /upstream server|fetch failed|socket hang up|ECONNRESET/i;

/** A stable reason code for a failed create (the card renders it). */
export function failureReason(err: unknown): string {
  if (err instanceof AgentGovernanceError) return err.code;
  if (err instanceof NotFoundException || err instanceof ForbiddenException)
    return 'no_create_permission';
  if (err instanceof BadRequestException) {
    // The services pass database errors on as bad requests; a gateway hiccup is nothing the input did.
    if (TRANSIENT_DB_ERROR.test(err.message)) return 'internal';
    // The wiki's TipTap whitelist refused the document: its messages start at the path "$".
    if (err instanceof TipTapValidationError || err.message.startsWith('$'))
      return 'invalid_content';
    if (/assignee/i.test(err.message)) return 'invalid_assignee';
    if (/type|hierarch/i.test(err.message)) return 'invalid_type';
    if (/parent/i.test(err.message)) return 'parent_not_found';
    return 'invalid_input';
  }
  return 'internal';
}

/** The space a plan goes in: its own, or the reserved id of the new space of this run. */
function spaceOfPlan(
  plan: AgentPlanOf | undefined,
  byOrdinal: Map<number, AgentActionRow>,
): string | null {
  if (!plan) return null;
  if (plan.spaceId) return plan.spaceId;
  const ordinal = 'pendingSpace' in plan ? plan.pendingSpace : null;
  const home = ordinal ? byOrdinal.get(ordinal) : undefined;
  return home?.kind === 'space' && home.status === 'executed' ? home.entity_id : null;
}

/** The nearest action of a kind up the action's parent chain. */
function ancestorOfKind(
  action: AgentActionRow,
  byOrdinal: Map<number, AgentActionRow>,
  kind: string,
): AgentActionRow | undefined {
  let at = action.depends_on !== null ? byOrdinal.get(action.depends_on) : undefined;
  while (at && at.kind !== kind)
    at = at.depends_on !== null ? byOrdinal.get(at.depends_on) : undefined;
  return at;
}

const isUniqueViolation = (err: unknown) =>
  ((err as { cause?: { code?: string } })?.cause?.code ??
    (err as { code?: string })?.code) === '23505';

/** Cards a running Confirm created itself: their status is known, every other parent is read fresh. */
const madeHere = new WeakSet<AgentActionRow>();

@Injectable()
export class AgentActionExecutorService {
  private readonly logger = new Logger(AgentActionExecutorService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly runs: AgentRunsRepository,
    private readonly views: AgentRunViewService,
    private readonly resolver: AgentResolverService,
    private readonly access: ChatAccessService,
    private readonly conversations: ChatConversationsService,
    private readonly tasks: TasksMineWriteService,
    private readonly broadcast: NotificationsBroadcastService,
    // Wiki pages (1.15); optional so the task-only specs build the executor as before.
    @Optional() private readonly wiki?: WikiMineWriteService,
    @Optional() private readonly wikiLabels?: WikiLabelsService,
    // Spaces, members and processes (1.20).
    @Optional() private readonly governance?: AgentGovernanceService,
    @Optional() private readonly wikiService?: WikiService,
    // Plans and plan items (1.22).
    @Optional() private readonly productPlans?: AgentPlansService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  /** PATCH /chat/agent/runs/:id/actions. A stale version answers 409 with the fresh view. */
  async patch(
    user: RequestUser,
    runId: string,
    changes: AgentActionChange[],
  ): Promise<AgentRunView> {
    const { run, conversation } = await this.ownRun(user, runId);
    const actions = await this.loadActions(run);
    const batch = this.batchFor(user, run, conversation, actions);
    let stale = false;

    for (const change of changes) {
      const action = actions.find((a) => a.id === change.actionId);
      if (!action) throw new NotFoundException('Action not found');

      const overrides = this.merge(
        action,
        this.checkFields(action, change.fields),
      );
      const resolved = await this.resolver.resolve(batch, {
        kind: kindOf(action),
        intent: action.intent as AgentStoredIntent,
        overrides,
        dependsOn: action.depends_on,
      });
      const saved = await this.save(
        run,
        batch,
        actions,
        action,
        change.version,
        {
          overrides,
          resolved,
          audit: { fields: Object.keys(change.fields) },
        },
      );
      if (!saved) {
        stale = true;
        break;
      }
    }

    void this.views.announce(run.id);
    const view = await this.views.viewOne(user, run.id);
    if (stale)
      throw this.conflict('stale', 'The proposal was changed meanwhile', view);
    return view;
  }

  /** POST /chat/agent/runs/:id/confirm */
  async confirm(
    user: RequestUser,
    runId: string,
    requested: { id: string; version: number }[],
  ): Promise<AgentRunView> {
    const { run, conversation } = await this.ownRun(user, runId);
    const actions = await this.loadActions(run);
    const wanted = new Map(requested.map((r) => [r.id, Number(r.version)]));
    // Only what exists or comes with this Confirm stands beside a card: a member card that was
    // cancelled or left unconfirmed must not vouch for an assignee (audit 2026-11-10).
    const batch = this.batchFor(
      user,
      run,
      conversation,
      actions.filter((a) => a.status === 'executed' || wanted.has(a.id)),
    );
    const byOrdinal = new Map(actions.map((a) => [a.ordinal, a]));
    const plans = new Map<string, AgentPlanOf>();
    let changed = false;
    let stale = false;
    let parentFirst = false;

    // 1. Pre-check, in card order so a subtask sees its parent's fresh space and type.
    for (const action of actions) {
      if (
        !wanted.has(action.id) ||
        !isOpenAction(action.status, action.expires_at)
      )
        continue;
      if (action.version !== wanted.get(action.id)) {
        stale = true;
        continue;
      }
      // A child goes with its parent or after it, never alone before it (it would fail).
      const parent =
        action.depends_on !== null
          ? byOrdinal.get(action.depends_on)
          : undefined;
      if (parent && parent.status !== 'executed' && !wanted.has(parent.id)) {
        parentFirst = true;
        continue;
      }
      const stored = action.resolved as Partial<AgentResolved>;
      const fresh = await this.resolver.resolve(batch, {
        kind: kindOf(action),
        intent: action.intent as AgentStoredIntent,
        overrides: action.overrides,
        dependsOn: action.depends_on,
      });
      batch.siblings.set(action.ordinal, siblingOf(action.ordinal, action.kind, fresh));

      if (
        !fresh.confirmable ||
        !fresh.create ||
        materialOf(stored) !== materialOf(fresh)
      ) {
        // ROB-04 AC-5: what the invoker saw is not what would be created; show it first.
        const saved = await this.save(
          run,
          batch,
          actions,
          action,
          action.version,
          {
            overrides: action.overrides,
            resolved: fresh,
            audit: { revalidated: true },
          },
        );
        if (saved) changed = true;
        else stale = true;
        continue;
      }
      plans.set(action.id, fresh.create);
    }

    if (changed || stale || parentFirst) {
      void this.views.announce(run.id);
      throw this.conflict(
        changed ? 'changed' : stale ? 'stale' : 'parent_first',
        parentFirst && !changed && !stale
          ? 'Confirm the parent first'
          : 'Something changed, please check the proposal',
        await this.views.viewOne(user, run.id),
      );
    }

    // 2. Each action is claimed right before it runs (one conditional UPDATE each), so a long
    //    Confirm never outlives its claim; a second click or a parallel request claims nothing.
    //    By rankOf (spaces, members, processes, tasks, pages, leavers), each in card order.
    let claimedAny = false;
    const order = actions.filter((a) => plans.has(a.id)).sort(executionOrder);
    // While this creates, no Undo of the run starts: a parent's delete would take a child being
    // written under it (audit 2026-11-10). The mark ends by itself after 5 minutes.
    if (order.length) await this.runs.markConfirming(run.organization_id, run.id, true);
    try {
      for (const pending of order) {
        const [action] = await this.runs.claimActions(
          run.organization_id,
          run.id,
          user.userId,
          { [pending.id]: pending.version },
        );
        if (!action) continue;
        if (!claimedAny) void this.views.announce(run.id);
        claimedAny = true;
        const status = await this.execute(
          user,
          run,
          { ...action, ordinal: Number(action.ordinal) },
          plans.get(action.id),
          byOrdinal,
        );
        pending.status = status;
        if (status === 'executed') madeHere.add(pending);
      }
      // 1.22.1: dependencies once both ends exist, still under the Confirm mark.
      await this.writeDependencies(user, run, order, plans, byOrdinal);
    } finally {
      if (order.length)
        await this.runs
          .markConfirming(run.organization_id, run.id, false)
          .catch((err: unknown) => this.logger.warn(`Robert run ${run.id}: confirm mark not cleared: ${errorText(err)}`));
    }

    // A plan's WBS numbers once per Confirm, after all of its items (1.22).
    const touched = order
      .filter((a) => (a.kind === 'plan_item' || a.kind === 'plan_link') && a.status === 'executed')
      .map((a) => this.planIdOf(plans.get(a.id) as AgentPlanItemPlan | undefined, byOrdinal))
      .filter((id): id is string => !!id);
    if (touched.length) await this.productPlans?.recalculate(touched);

    if (plans.size && !claimedAny) {
      // Nothing claimed: expired meanwhile, or another tab or request got there first.
      throw this.conflict(
        'stale',
        'The proposal was changed meanwhile',
        await this.views.viewOne(user, run.id),
      );
    }
    if (claimedAny) void this.views.announce(run.id);
    return this.views.viewOne(user, run.id);
  }

  /** POST /chat/agent/actions/:id/retry: a failed action, checked again and confirmed. */
  async retry(
    user: RequestUser,
    actionId: string,
    version: number,
  ): Promise<AgentRunView> {
    const action = await this.findAction(user, actionId);
    return this.confirm(user, action.run_id, [{ id: actionId, version }]);
  }

  /**
   * GET /chat/agent/actions/:id/options: parents the invoker may pick for an open proposal,
   * searched on the server (a parent the resolver could not find stays fixable, B2).
   */
  async options(
    user: RequestUser,
    actionId: string,
    field: 'parent' | 'parentPage',
    query: string,
  ): Promise<{ value: string; label: string; hint?: string }[]> {
    const found = await this.findAction(user, actionId);
    const { run, conversation } = await this.ownRun(user, found.run_id);
    const actions = await this.loadActions(run);
    const action = actions.find((a) => a.id === actionId);
    const spaceId = (action?.resolved as Partial<AgentResolved> | undefined)
      ?.create?.spaceId;
    if (!action || !spaceId || !isOpenAction(action.status, action.expires_at))
      return [];
    const batch = this.batchFor(user, run, conversation, actions);
    if (field === 'parentPage') {
      if (action.kind !== 'wiki_page') return [];
      return (await this.resolver.recentPages(batch, spaceId, query)).map(
        (p) => ({
          value: p.id,
          label: p.title,
        }),
      );
    }
    if (action.kind === 'wiki_page' || isNewKind(action.kind) || isPlanKind(action.kind)) return [];
    return this.resolver.searchParentTasks(batch, spaceId, query);
  }

  /** POST /chat/agent/actions/:id/cancel */
  async cancel(user: RequestUser, actionId: string): Promise<AgentRunView> {
    const action = await this.findAction(user, actionId);
    const { run } = await this.ownRun(user, action.run_id);
    // A subtask of a cancelled proposal would have no parent: it goes too (each one audited).
    const all = await this.loadActions(run);
    const target = all.find((a) => a.id === actionId);
    const gone = new Set(target ? [target.ordinal] : []);
    // Only an open proposal takes its children along; a created parent keeps them.
    for (const other of target && isOpenAction(target.status, target.expires_at)
      ? all
      : []) {
      if (other.depends_on !== null && gone.has(other.depends_on))
        gone.add(other.ordinal);
    }
    await this.runs.cancelActions(run.organization_id, 'user', {
      actionIds: all.filter((a) => gone.has(a.ordinal)).map((a) => a.id),
      actorId: user.userId,
    });
    void this.views.announce(run.id);
    return this.views.viewOne(user, run.id);
  }

  /** POST /chat/agent/runs/:id/feedback: the latest rating wins (audit `run.feedback`). */
  async feedback(
    user: RequestUser,
    runId: string,
    rating: 'up' | 'down',
  ): Promise<void> {
    const { run } = await this.ownRun(user, runId);
    if (run.status === 'queued' || run.status === 'running')
      throw new ConflictException('The run is not finished yet');

    await this.runs.recordAudit({
      organizationId: run.organization_id,
      event: 'run.feedback',
      actorId: user.userId,
      runId: run.id,
      conversationId: run.conversation_id,
      data: { rating },
    });
    void this.views.announce(run.id);
  }

  /**
   * The sweep handed over a Confirm that hung (agent_reclaim_stuck_actions): the task exists
   * under the reserved id → executed, otherwise back to the card. Never throws.
   */
  async reconcile(row: AgentActionRow): Promise<void> {
    if (row.status === 'undoing') return this.reconcileUndo(row);
    if (row.status !== 'executing' || !row.exec_token) return;
    try {
      const exists = await this.applied(row);
      // Audit 2026-11-10: a crash between steps leaves nothing half made.
      if (exists) await this.repairAfterCrash(row);
      else await this.dropUnlinkedItem(row);
      await this.runs.completeAction({
        actionId: row.id,
        execToken: row.exec_token,
        outcome: exists ? 'executed' : 'released',
        audit: { reconciled: true },
      });
      void this.views.announce(row.run_id);
    } catch (err) {
      this.logger.warn(
        `Robert action ${row.id} not reconciled: ${errorText(err)}`,
      );
    }
  }

  /** What a Confirm writes after the row itself: a space's owner and modules, a plan's creator admin row. */
  private async repairAfterCrash(row: AgentActionRow): Promise<void> {
    if (!row.confirmed_by) return;
    const actor = { userId: row.confirmed_by, organizationId: row.organization_id };
    try {
      if (row.kind === 'space' && this.governance) {
        const plan = (row.resolved as Partial<AgentResolved>).create as
          | { enableWiki: boolean; enablePlans?: boolean }
          | undefined;
        if (plan) await this.governance.finishSpace(actor, row.entity_id, plan, true);
      } else if (row.kind === 'plan') {
        await this.productPlans?.keepCreatorAdmin(row.entity_id, row.confirmed_by);
      }
    } catch (err) {
      this.logger.warn(`Robert action ${row.id} not repaired: ${errorText(err)}`);
    }
  }

  /**
   * A plan item task without its link: the card comes back, so the task would be left over if the
   * card is then cancelled or expires. It goes now if nobody touched it (the Undo checks); its
   * Confirm makes it anew.
   */
  private async dropUnlinkedItem(row: AgentActionRow): Promise<void> {
    if (row.kind !== 'plan_item' || !row.confirmed_by) return;
    try {
      if (!(await this.exists(row.organization_id, row.kind, row.entity_id))) return;
      await this.runs.undoTask({
        organizationId: row.organization_id,
        taskId: row.entity_id,
        actorId: row.confirmed_by,
        since: row.created_at,
        runId: row.run_id,
      });
    } catch (err) {
      this.logger.warn(`Robert action ${row.id}: unlinked item not removed: ${errorText(err)}`);
    }
  }

  /**
   * The sweep handed over an Undo that hung: the object went (a page: archived) → undone, otherwise
   * it stays as it was and says so. Nothing is half done, because each object is one transaction.
   */
  private async reconcileUndo(row: AgentActionRow): Promise<void> {
    if (!row.exec_token) return;
    try {
      const stillThere =
        row.kind === 'wiki_page'
          ? await this.client
              .from('wiki_pages')
              .select('id')
              .eq('id', row.entity_id)
              .eq('organization_id', row.organization_id)
              .eq('is_archived', false)
              .maybeSingle()
              .then(({ data, error }) => {
                if (error) throw new Error(error.message);
                return !!data;
              })
          : await this.exists(row.organization_id, row.kind, row.entity_id);
      await this.runs.completeUndo({
        actionId: row.id,
        execToken: row.exec_token,
        outcome: stillThere ? 'blocked' : 'undone',
        reason: stillThere ? 'undo_interrupted' : null,
        actorId: row.undone_by as string,
      });
      void this.views.announce(row.run_id);
    } catch (err) {
      this.logger.warn(`Robert action ${row.id} undo not reconciled: ${errorText(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  /** Creates (or adopts) one claimed task or page and reports the outcome. Never throws. */
  private async execute(
    user: RequestUser,
    run: RunRow,
    action: AgentActionRow,
    planOf: AgentPlanOf | undefined,
    byOrdinal: Map<number, AgentActionRow>,
  ): Promise<AgentActionRow['status']> {
    const finish = async (
      outcome: 'executed' | 'failed',
      reason?: string,
      audit?: Record<string, unknown>,
    ) => {
      try {
        await this.runs.completeAction({
          actionId: action.id,
          execToken: action.exec_token as string,
          outcome,
          reason: reason ?? null,
          audit,
        });
      } catch (err) {
        // The claim stays; the sweep reconciles it by whether the task exists.
        this.logger.error(
          `Robert action ${action.id} not completed: ${errorText(err)}`,
        );
      }
      return outcome;
    };

    const parent =
      action.depends_on !== null ? byOrdinal.get(action.depends_on) : undefined;
    // The parent as it is now: another tab may have confirmed it, or an Undo taken it, since this
    // Confirm read the cards (audit 2026-11-10).
    if (parent && !madeHere.has(parent))
      parent.status = ((await this.statusOf(parent)) ?? parent.status) as typeof parent.status;
    if (action.depends_on !== null && parent?.status !== 'executed')
      return finish('failed', 'parent_failed');
    if (isProductPlan(planOf)) return this.executePlan(user, action, planOf, byOrdinal, finish);
    if (isPlanLinkPlan(planOf)) return this.executePlanLink(user, action, planOf, byOrdinal, finish);
    if (isSuggestionPlan(planOf)) return this.executeSuggestion(user, action, planOf, finish);
    if (isPlanItemPlan(planOf)) return this.executePlanItem(user, run, action, planOf, parent, byOrdinal, finish);
    if (isNewPlan(planOf)) return this.executeNew(user, action, planOf, byOrdinal, finish);
    const home = spaceOfPlan(planOf, byOrdinal);
    if (!home) return finish('failed', 'internal');
    if (isWikiPlan(planOf))
      return this.executePage(
        user,
        run,
        action,
        { ...planOf, spaceId: home },
        parent,
        byOrdinal,
        finish,
      );
    if (!isTaskPlan(planOf)) return finish('failed', 'internal');
    const plan = { ...planOf, spaceId: home };
    const process = ancestorOfKind(action, byOrdinal, 'process');

    try {
      if (await this.exists(run.organization_id, 'task', action.entity_id))
        return finish('executed', undefined, { adopted: true });

      const { task } = await this.tasks.createTask(
        user,
        {
          spaceIdOrKey: plan.spaceId as string,
          summary: plan.summary,
          description: plainToHtml(plan.description),
          ...(plan.priorityKey && { priority: plan.priorityKey }),
          ...(plan.assigneeId && { assigneeId: plan.assigneeId }),
          ...(plan.dueDate && { dueDate: plan.dueDate }),
          ...(plan.labels.length && { labels: plan.labels }),
          ...(plan.parentTaskId && { parentTaskId: plan.parentTaskId }),
          ...(plan.taskTypeId && { taskTypeId: plan.taskTypeId }),
        },
        {
          taskId: action.entity_id,
          ...(plan.statusId && { status: plan.statusId }),
          ...(Object.keys(plan.customFieldValues).length && {
            customFieldValues: plan.customFieldValues,
          }),
          ...(parent && !isNewKind(parent.kind) && { parentTaskId: parent.entity_id }),
          ...(process && { processId: process.entity_id }),
        },
      );
      const done = await finish('executed');
      void this.ring(user, run.id, task);
      return done;
    } catch (err) {
      if (
        isUniqueViolation(err) &&
        (await this.exists(run.organization_id, 'task', action.entity_id).catch(
          () => false,
        ))
      )
        return finish('executed', undefined, { adopted: true });
      this.logger.warn(`Robert action ${action.id} failed: ${errorText(err)}`);
      return finish('failed', failureReason(err));
    }
  }

  /** A new product plan (1.22), as a person's createPlan makes it, under the reserved id. */
  private async executePlan(
    user: RequestUser,
    action: AgentActionRow,
    plan: AgentProductPlan,
    byOrdinal: Map<number, AgentActionRow>,
    finish: (outcome: 'executed' | 'failed', reason?: string, audit?: Record<string, unknown>) => Promise<'executed' | 'failed'>,
  ): Promise<AgentActionRow['status']> {
    const spaceId = spaceOfPlan(plan, byOrdinal);
    if (!this.productPlans || !spaceId) return finish('failed', 'internal');
    try {
      const { adopted } = await this.productPlans.createPlan(user, action.entity_id, { ...plan, spaceId });
      return finish('executed', undefined, adopted ? { adopted: true } : undefined);
    } catch (err) {
      this.logger.warn(`Robert action ${action.id} failed: ${errorText(err)}`);
      return finish('failed', failureReason(err));
    }
  }

  /** One plan item (1.22): its task and its plan link, both adopted on a retry. */
  private async executePlanItem(
    user: RequestUser,
    run: RunRow,
    action: AgentActionRow,
    plan: AgentPlanItemPlan,
    parent: AgentActionRow | undefined,
    byOrdinal: Map<number, AgentActionRow>,
    finish: (outcome: 'executed' | 'failed', reason?: string, audit?: Record<string, unknown>) => Promise<'executed' | 'failed'>,
  ): Promise<AgentActionRow['status']> {
    const planId = this.planIdOf(plan, byOrdinal);
    if (!this.productPlans || !planId) return finish('failed', 'internal');
    const parentTaskId = parent?.kind === 'plan_item' ? parent.entity_id : plan.parentTaskId;
    try {
      const { adopted } = await this.productPlans.addItem(user, action.entity_id, planId, parentTaskId, {
        name: plan.name,
        description: plan.description,
        itemType: plan.itemType,
        startDate: plan.startDate,
        endDate: plan.endDate,
        ownerId: plan.ownerId,
        priority: plan.priority,
        estimatedHours: plan.estimatedHours,
        estimatedCost: plan.estimatedCost,
        progress: plan.progress,
      });
      const done = await finish('executed', undefined, adopted ? { adopted: true } : undefined);
      if (!adopted && plan.ownerId) void this.ringPlanItem(user, run.id, action.entity_id, plan.name, plan.ownerId);
      return done;
    } catch (err) {
      this.logger.warn(`Robert action ${action.id} failed: ${errorText(err)}`);
      return finish('failed', failureReason(err));
    }
  }

  /**
   * 1.22.1: an existing task into a plan, under the plan lock. Only the plan_tasks row is made,
   * with the reserved id (its origin hangs on it); the task, its dates and its owner stay as they are.
   */
  private async executePlanLink(
    user: RequestUser,
    action: AgentActionRow,
    plan: AgentPlanLinkPlan,
    byOrdinal: Map<number, AgentActionRow>,
    finish: (outcome: 'executed' | 'failed', reason?: string, audit?: Record<string, unknown>) => Promise<'executed' | 'failed'>,
  ): Promise<AgentActionRow['status']> {
    const planId = this.planIdOf(plan, byOrdinal);
    // A plan of this run that failed already failed this card (parent_failed) before it got here.
    if (!planId) return finish('failed', 'internal');
    try {
      const out = await this.runs.linkPlanTask({
        organizationId: action.organization_id,
        planId,
        taskId: plan.taskId,
        linkId: action.entity_id,
        itemType: plan.itemType,
      });
      if (!out.linked) return finish('failed', out.reason ?? 'already_in_plan');
      if (!out.adopted) void this.productPlans?.auditLinked(user, planId, plan.taskId, plan.itemType);
      return finish('executed', undefined, out.adopted ? { adopted: true } : undefined);
    } catch (err) {
      this.logger.warn(`Robert action ${action.id} failed: ${errorText(err)}`);
      return finish('failed', failureReason(err));
    }
  }

  /**
   * 1.23: a suggestion the person confirmed: exactly what the card shows, one row Robert adds, each
   * checked again under the plan lock. A risk, stakeholder or dependency under the reserved id; dates
   * only on Robert's own item that has none; a baseline through the human baseline code.
   */
  private async executeSuggestion(
    user: RequestUser,
    action: AgentActionRow,
    plan: AgentSuggestionPlan,
    finish: (outcome: 'executed' | 'failed', reason?: string, audit?: Record<string, unknown>) => Promise<'executed' | 'failed'>,
  ): Promise<AgentActionRow['status']> {
    const org = action.organization_id;
    try {
      if (plan.kind === 'plan_risk') {
        const out = await this.runs.addPlanRisk({
          organizationId: org,
          planId: plan.planId,
          riskId: action.entity_id,
          actorId: user.userId,
          fields: {
            name: plan.name,
            description: plan.description,
            risk_type: plan.riskType,
            category: plan.category,
            probability: plan.probability,
            impact: plan.impact,
            mitigation_strategy: plan.mitigation,
            contingency_plan: plan.contingency,
            owner_id: plan.ownerId,
          },
        });
        if (!out.created) return finish('failed', out.reason ?? 'same_name_in_plan');
        if (!out.adopted)
          void this.productPlans?.auditChange(user, 'plan_risk', action.entity_id, 'create', { plan_id: plan.planId, name: plan.name, risk_type: plan.riskType });
        return finish('executed', undefined, out.adopted ? { adopted: true } : undefined);
      }
      if (plan.kind === 'plan_stakeholder') {
        const out = await this.runs.addPlanStakeholder({
          organizationId: org,
          planId: plan.planId,
          stakeholderId: action.entity_id,
          fields: {
            name: plan.name,
            role: plan.role,
            organization_name: plan.organization,
            email: plan.email,
            power_level: plan.power,
            interest_level: plan.interest,
            attitude: plan.attitude,
            engagement_strategy: plan.engagement,
            user_id: plan.linkedUserId,
          },
        });
        if (!out.created) return finish('failed', out.reason ?? 'same_name_in_plan');
        if (!out.adopted)
          void this.productPlans?.auditChange(user, 'plan_stakeholder', action.entity_id, 'create', { plan_id: plan.planId, name: plan.name });
        return finish('executed', undefined, out.adopted ? { adopted: true } : undefined);
      }
      if (plan.kind === 'plan_dependency') {
        const out = await this.runs.addPlanDependency({
          organizationId: org,
          planId: plan.planId,
          actionId: action.id,
          sourceTaskId: plan.sourceTaskId,
          targetTaskId: plan.targetTaskId,
          typeName: DEPENDENCY_TYPE_NAMES[plan.type],
          id: action.entity_id,
        });
        if (!out.created) return finish('failed', out.reason ?? 'dependency_failed');
        if (!out.adopted)
          void this.productPlans?.auditDependency(user, plan.planId, action.entity_id, plan.sourceTaskId, plan.targetTaskId, plan.type);
        return finish('executed', undefined, out.adopted ? { adopted: true } : undefined);
      }
      if (plan.kind === 'plan_dates') {
        const out = await this.runs.setPlanDates({
          organizationId: org,
          planId: plan.planId,
          actionId: action.id,
          taskId: plan.taskId,
          start: plan.start,
          end: plan.end,
          duration: plan.duration,
        });
        if (!out.set) return finish('failed', out.reason ?? 'has_dates');
        if (!out.adopted)
          void this.productPlans?.auditChange(user, 'plan_item', plan.taskId, 'update', { plan_id: plan.planId, start_date: plan.start, end_date: plan.end, duration: plan.duration });
        return finish('executed', undefined, out.adopted ? { adopted: true } : undefined);
      }
      // A baseline: the one active before is kept on the card first, so its Undo can bring it back.
      if (!this.productPlans) return finish('failed', 'internal');
      const previous = await this.productPlans.activeBaseline(plan.planId);
      if (previous !== action.entity_id)
        await this.runs.setBeforeValues(org, action.id, { previous_active_id: previous });
      const { adopted } = await this.productPlans.takeBaseline(user, action.entity_id, plan.planId, plan.name);
      return finish('executed', undefined, adopted ? { adopted: true } : undefined);
    } catch (err) {
      this.logger.warn(`Robert action ${action.id} failed: ${errorText(err)}`);
      return finish('failed', failureReason(err));
    }
  }

  /**
   * 1.22.1: the dependencies of the items this Confirm made, once every card of it ran, so both
   * ends exist. Each is checked and written under the plan lock (agent_plan_dependency_add); one
   * that fails leaves its item, and the card says which and why.
   */
  private async writeDependencies(
    user: RequestUser,
    run: RunRow,
    order: AgentActionRow[],
    plans: Map<string, AgentPlanOf>,
    byOrdinal: Map<number, AgentActionRow>,
  ): Promise<void> {
    for (const action of order) {
      const plan = plans.get(action.id);
      if (action.status !== 'executed' || !isPlanItemPlan(plan) || !plan.dependencies?.length) continue;
      const planId = this.planIdOf(plan, byOrdinal);
      const failed: string[] = [];
      for (const dep of plan.dependencies) {
        const card = dep.otherOrdinal !== null ? byOrdinal.get(dep.otherOrdinal) : undefined;
        const cardPlan = card ? plans.get(card.id) : undefined;
        const other =
          dep.otherTaskId ??
          (card?.status === 'executed'
            ? card.kind === 'plan_link' && isPlanLinkPlan(cardPlan)
              ? cardPlan.taskId
              : card.kind === 'plan_item'
                ? card.entity_id
                : null
            : null);
        if (!planId || !other) {
          failed.push('dependency_end_gone');
          continue;
        }
        const [source, target] = dep.thisIs === 'successor' ? [other, action.entity_id] : [action.entity_id, other];
        try {
          const out = await this.runs.addPlanDependency({
            organizationId: action.organization_id,
            planId,
            actionId: action.id,
            sourceTaskId: source,
            targetTaskId: target,
            typeName: DEPENDENCY_TYPE_NAMES[dep.type],
          });
          if (!out.created) failed.push(out.reason ?? 'dependency_failed');
          else if (!out.adopted && out.id)
            void this.productPlans?.auditDependency(user, planId, out.id, source, target, dep.type);
        } catch (err) {
          this.logger.warn(`Robert action ${action.id}: dependency not set: ${errorText(err)}`);
          failed.push('dependency_failed');
        }
      }
      if (failed.length)
        await this.runs
          .recordAudit({
            organizationId: action.organization_id,
            event: 'action.dependencies',
            actorId: user.userId,
            runId: run.id,
            actionId: action.id,
            conversationId: run.conversation_id,
            data: { dependency_failed: failed },
          })
          .catch((err: unknown) => this.logger.warn(`Robert action ${action.id}: dependency note not kept: ${errorText(err)}`));
    }
  }

  /** The plan an item goes in: its own, or the reserved id of the plan of this run above it. */
  private planIdOf(
    plan: Pick<AgentPlanItemPlan, 'planId' | 'pendingPlan'> | undefined,
    byOrdinal: Map<number, AgentActionRow>,
  ): string | null {
    if (!plan) return null;
    if (plan.planId) return plan.planId;
    const home = plan.pendingPlan ? byOrdinal.get(plan.pendingPlan) : undefined;
    return home?.kind === 'plan' && home.status === 'executed' ? home.entity_id : null;
  }

  /** The owner's bell for a plan item (not the invoker's), never an email. Never throws. */
  private async ringPlanItem(user: RequestUser, runId: string, taskId: string, name: string, ownerId: string): Promise<void> {
    try {
      if (ownerId === user.userId) return;
      const { data: task } = await this.client
        .from('tasks')
        .select('id, key, spaces(key)')
        .eq('id', taskId)
        .eq('organization_id', user.organizationId)
        .maybeSingle();
      const row = task as { id: string; key: string | null; spaces: { key: string } | null } | null;
      if (!row) return;
      const who = (await this.conversations.loadUsers([user.userId])).get(user.userId)?.name ?? 'Someone';
      const metadata = { taskId, taskKey: row.key, runId, task_key: row.key, space_key: row.spaces?.key ?? null };
      const link = buildNotificationPath('task', taskId, metadata);
      const inserted = await this.client
        .from('notifications')
        .insert({
          organization_id: user.organizationId,
          user_id: ownerId,
          type: 'robert_task_assigned',
          title: `${who} added a plan item for you with Robert: ${Array.from(name).slice(0, 200).join('')}`,
          body: null,
          is_read: false,
          action_status: 'none',
          reference_type: 'task',
          reference_id: taskId,
          metadata: { ...(link && { link }), ...metadata },
        })
        .select('id, user_id, type, title, created_at, metadata, reference_type, reference_id');
      if (inserted.error) throw new Error(inserted.error.message);
      for (const r of (inserted.data ?? []) as Record<string, unknown>[]) void this.broadcast.broadcastNotification(r);
    } catch (err) {
      this.logger.warn(`Robert bell for plan item ${taskId} not sent: ${errorText(err)}`);
    }
  }

  /** A space, a process or a member change, through the one service that checks them. */
  private async executeNew(
    user: RequestUser,
    action: AgentActionRow,
    plan: AgentNewPlan,
    byOrdinal: Map<number, AgentActionRow>,
    finish: (
      outcome: 'executed' | 'failed',
      reason?: string,
      audit?: Record<string, unknown>,
    ) => Promise<'executed' | 'failed'>,
  ): Promise<AgentActionRow['status']> {
    if (!this.governance) return finish('failed', 'internal');
    try {
      let adopted = false;
      if (plan.kind === 'space') {
        ({ adopted } = await this.governance.createSpace(user, action.entity_id, plan));
      } else {
        const spaceId = spaceOfPlan(plan, byOrdinal);
        if (!spaceId) return finish('failed', 'internal');
        const main = plan.kind === 'process' ? ancestorOfKind(action, byOrdinal, 'process') : undefined;
        ({ adopted } =
          plan.kind === 'process'
            ? await this.governance.createProcess(user, action.entity_id, spaceId, main ? { ...plan, parentId: main.entity_id } : plan)
            : await this.governance.changeMember(user, {
                kind: plan.kind,
                spaceId,
                userId: plan.userId,
                role: plan.role,
                grant: plan.grant,
                revoke: plan.revoke,
              }));
      }
      return finish('executed', undefined, adopted ? { adopted: true } : undefined);
    } catch (err) {
      this.logger.warn(`Robert action ${action.id} failed: ${errorText(err)}`);
      return finish('failed', failureReason(err));
    }
  }

  /** One wiki page, as the invoker, under the action's reserved id (adopted if it exists). */
  private async executePage(
    user: RequestUser,
    run: RunRow,
    action: AgentActionRow,
    plan: AgentWikiPlan,
    parent: AgentActionRow | undefined,
    byOrdinal: Map<number, AgentActionRow>,
    finish: (
      outcome: 'executed' | 'failed',
      reason?: string,
      audit?: Record<string, unknown>,
    ) => Promise<'executed' | 'failed'>,
  ): Promise<AgentActionRow['status']> {
    try {
      if (await this.exists(run.organization_id, 'wiki_page', action.entity_id))
        return finish('executed', undefined, { adopted: true });

      if (!this.wiki) return finish('failed', 'internal');
      const doc = await this.finalDoc(run, action, plan, byOrdinal);
      const pageParent = parent?.kind === 'wiki_page' ? parent : undefined;
      await this.wiki.createWikiPage(
        user,
        {
          spaceIdOrKey: plan.spaceId as string,
          title: plan.title,
          content: '',
          ...((pageParent?.entity_id ?? plan.parentPageId) && {
            parentPageId: pageParent?.entity_id ?? (plan.parentPageId as string),
          }),
          status: plan.publish ? 'published' : 'draft',
        },
        { pageId: action.entity_id, doc },
      );
      if (plan.labelIds.length && this.wikiLabels) {
        await this.wikiLabels
          .setPageLabels(action.entity_id, plan.spaceId as string, {
            label_ids: plan.labelIds,
          })
          .catch((err: unknown) =>
            this.logger.warn(
              `Robert page ${action.entity_id} labels not set: ${errorText(err)}`,
            ),
          );
      }
      // The page stands even if its link does not; the result says so.
      const linkProblem = await this.linkToProcess(user, run, action, parent);
      return finish('executed', undefined, linkProblem ? { process_link_failed: true } : undefined);
    } catch (err) {
      // The wiki hides most database codes: look again before calling it failed.
      if (
        await this.exists(
          run.organization_id,
          'wiki_page',
          action.entity_id,
        ).catch(() => false)
      )
        return finish('executed', undefined, { adopted: true });
      this.logger.warn(`Robert action ${action.id} failed: ${errorText(err)}`);
      return finish('failed', failureReason(err));
    }
  }

  /** A page documenting a process of this run links to it. True when that failed. */
  private async linkToProcess(
    user: RequestUser,
    run: RunRow,
    action: AgentActionRow,
    parent: AgentActionRow | undefined,
  ): Promise<boolean> {
    if (parent?.kind !== 'process' || !this.wikiService) return false;
    try {
      await this.wikiService.createLink(
        action.entity_id,
        { target_type: 'process', target_id: parent.entity_id },
        user.userId,
        run.organization_id,
      );
      return false;
    } catch (err) {
      this.logger.warn(`Robert page ${action.entity_id} not linked: ${errorText(err)}`);
      return true;
    }
  }

  /** The stored document with this page's id and the keys of the tasks created with it. */
  private async finalDoc(
    run: RunRow,
    action: AgentActionRow,
    plan: AgentWikiPlan,
    byOrdinal: Map<number, AgentActionRow>,
  ): Promise<Record<string, unknown>> {
    const ids = plan.items
      .map((item) => byOrdinal.get(item))
      .filter((a): a is AgentActionRow => a?.status === 'executed')
      .map((a) => a.entity_id);
    const created = new Map<string, { key: string; spaceId: string }>();
    if (ids.length) {
      const { data } = await this.client
        .from('tasks')
        .select('id, key, space_id')
        .eq('organization_id', run.organization_id)
        .in('id', ids);
      for (const t of (data ?? []) as {
        id: string;
        key: string | null;
        space_id: string;
      }[])
        if (t.key) created.set(t.id, { key: t.key, spaceId: t.space_id });
    }
    const language = (action.intent as { object_language?: string })
      .object_language;
    const filled = fillItemCards(
      plan.doc as { type: 'doc'; content: TipTapNode[] },
      (item) => {
        const a = byOrdinal.get(item);
        return a ? (created.get(a.entity_id) ?? null) : null;
      },
      language === 'de' ? '(Aufgabe nicht erstellt)' : '(task not created)',
    );
    // A page that gets child pages in this run lists them, live, if the model left that out.
    const hasChildren = [...byOrdinal.values()].some(
      (a) => a.kind === 'wiki_page' && a.depends_on === action.ordinal,
    );
    if (hasChildren && !filled.content.some((n) => n.type === 'pageTree'))
      filled.content.push({
        type: 'pageTree',
        attrs: { rootPageId: PAGE_PLACEHOLDER, depth: 2 },
      });
    return JSON.parse(
      JSON.stringify(filled)
        .split(PAGE_PLACEHOLDER)
        .join(action.entity_id)
        .split(SPACE_PLACEHOLDER)
        .join(plan.spaceId as string),
    ) as Record<string, unknown>;
  }

  /** The assignee's bell (not the invoker's). Never throws. */
  private async ring(
    user: RequestUser,
    runId: string,
    task: MyTaskDetail,
  ): Promise<void> {
    try {
      const assigneeId = task.assignee?.id;
      if (!assigneeId || assigneeId === user.userId) return;

      const name =
        (await this.conversations.loadUsers([user.userId])).get(user.userId)
          ?.name ?? 'Someone';
      const metadata = {
        taskId: task.id,
        taskKey: task.key,
        runId,
        task_key: task.key,
        space_key: task.space?.key ?? null,
      };
      const link = buildNotificationPath('task', task.id, metadata);
      const inserted = await this.client
        .from('notifications')
        .insert({
          organization_id: user.organizationId,
          user_id: assigneeId,
          type: 'robert_task_assigned',
          title: `${name} created a task for you with Robert: ${Array.from(task.summary).slice(0, 200).join('')}`,
          body: null,
          is_read: false,
          action_status: 'none',
          reference_type: 'task',
          reference_id: task.id,
          metadata: { ...(link && { link }), ...metadata },
        })
        .select(
          'id, user_id, type, title, created_at, metadata, reference_type, reference_id',
        );
      if (inserted.error) throw new Error(inserted.error.message);

      for (const row of (inserted.data ?? []) as Record<string, unknown>[]) {
        void this.broadcast.broadcastNotification(row);
      }
    } catch (err) {
      this.logger.warn(
        `Robert bell for task ${task.id} not sent: ${errorText(err)}`,
      );
    }
  }

  /** patchAction with the run's new scope and, when needed, a narrowed audience. */
  private async save(
    run: RunRow,
    batch: AgentResolveBatch,
    actions: AgentActionRow[],
    action: AgentActionRow,
    version: number,
    next: {
      overrides: Record<string, unknown>;
      resolved: AgentResolved;
      audit: Record<string, unknown>;
    },
  ): Promise<boolean> {
    const spaceId = next.resolved.create?.spaceId ?? null;
    const planOf = (a: AgentActionRow) =>
      a.id === action.id
        ? next.resolved.create
        : (a.resolved as Partial<AgentResolved>).create;
    const scope: AgentRunScope = {
      spaces: [
        ...new Map(
          actions
            .map((a) => ({ plan: planOf(a), kind: a.kind }))
            .filter((c) => !!c.plan?.spaceId)
            .map((c) => [
              c.plan?.spaceId as string,
              { id: c.plan?.spaceId as string, perm: permOf(c.kind) },
            ]),
        ).values(),
      ],
      refs: run.scope?.refs ?? [],
    };
    const page = isWikiPlan(next.resolved.create) ? next.resolved.create : null;
    const narrow =
      run.visibility === 'conversation' &&
      (!!page?.restricted ||
        actions.some((a) => isGovernanceKind(a.kind)) ||
        (await this.resolver.hidesFromAudience(batch, [
          spaceId,
          ...(page?.readSpaces ?? []),
          ...this.blockedSpaces(next.resolved),
        ])));

    const result = await this.runs.patchAction({
      organizationId: run.organization_id,
      actionId: action.id,
      actorId: batch.invoker.userId,
      version,
      overrides: next.overrides,
      resolved: next.resolved as unknown as Record<string, unknown>,
      targetSpaceId: spaceId,
      scope,
      narrow,
      audit: next.audit,
    });
    if (!result.updated) return false;

    Object.assign(action, {
      version: result.version,
      overrides: next.overrides,
      resolved: next.resolved,
      target_space_id: spaceId,
    });
    // A child resolved after this edit sees its parent's new space and type at once.
    batch.siblings.set(action.ordinal, siblingOf(action.ordinal, action.kind, next.resolved));
    if (narrow) {
      run.visibility = 'invoker';
      // Members' clients hear of it too, so they drop the full card for the stub (B7).
      void this.views.announce(run.id, true);
    }
    run.scope = scope;
    return true;
  }

  /**
   * Overrides after an edit. A new space drops the type, status, priority and custom values
   * picked for the old one; a new type drops the status and custom values.
   */
  private merge(
    action: AgentActionRow,
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    const before = (action.resolved as Partial<AgentResolved>).create;
    const next: Record<string, unknown> = { ...action.overrides };
    const drop = (keys: string[]) => {
      for (const key of Object.keys(next)) {
        if (
          (keys.includes(key) || key.startsWith('custom:')) &&
          !(key in fields)
        )
          delete next[key];
      }
    };
    if ('space' in fields && fields.space !== (before?.spaceId ?? null))
      drop(['type', 'status', 'priority', 'parentPage']);
    else if ('type' in fields && fields.type !== (isTaskPlan(before) ? before.taskTypeId : null))
      drop(['status']);
    return { ...next, ...fields };
  }

  /** Allowed keys with values of the right type; custom values against their field. */
  private checkFields(
    action: AgentActionRow,
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    const bad = (key: string) =>
      new BadRequestException(`Invalid value for ${key}`);
    const current = (action.resolved as Partial<AgentResolved>).fields ?? [];

    for (const [key, value] of Object.entries(fields)) {
      if (CUSTOM_KEY.test(key)) {
        const def = current.find((f) => f.key === key)?.fieldDef;
        if (!def) throw bad(key);
        try {
          validateFieldValue(def as unknown as CustomField, value);
        } catch {
          throw bad(key);
        }
        continue;
      }
      if (isNewKind(action.kind)) {
        this.checkNewField(action.kind, key, value);
        continue;
      }
      if (isPlanKind(action.kind)) {
        this.checkPlanField(action.kind, key, value);
        continue;
      }
      if (action.kind === 'wiki_page') {
        if (!(AGENT_WIKI_FIELD_KEYS as readonly string[]).includes(key))
          throw new BadRequestException(`Unknown field ${key}`);
        const fine =
          key === 'title'
            ? typeof value === 'string' && value.length <= MAX_TEXT
            : key === 'publish'
              ? typeof value === 'boolean'
              : key === 'labels'
                ? Array.isArray(value) &&
                  value.length <= MAX_LABELS &&
                  value.every(
                    (l) => typeof l === 'string' && l.length <= MAX_ID,
                  )
                : value === null ||
                  (typeof value === 'string' && UUID.test(value));
        if (!fine) throw bad(key);
        continue;
      }
      if (!(AGENT_FIELD_KEYS as readonly string[]).includes(key))
        throw new BadRequestException(`Unknown field ${key}`);

      const ok =
        key === 'title'
          ? typeof value === 'string' && value.length <= MAX_TEXT
          : key === 'description'
            ? value === null ||
              (typeof value === 'string' && value.length <= MAX_TEXT)
            : key === 'due'
              ? value === null || strictDay(value) !== null
              : key === 'labels'
                ? Array.isArray(value) &&
                  value.length <= MAX_LABELS &&
                  value.every(
                    (l) => typeof l === 'string' && l.length <= MAX_ID,
                  )
                : ID_KEYS.has(key) &&
                  (value === null ||
                    (typeof value === 'string' &&
                      value.length > 0 &&
                      value.length <= MAX_ID &&
                      (!['space', 'assignee', 'status', 'priority'].includes(
                        key,
                      ) ||
                        UUID.test(value))));
      if (!ok) throw bad(key);
    }
    return fields;
  }

  /** What a card of a plan or a plan item may set (1.22). Everything else is refused. */
  private checkPlanField(kind: string, key: string, value: unknown): void {
    // 1.22.1: a dependency row of an item takes one of the four types; a link only its plan and type.
    if (kind === 'plan_item' && /^dependency:\d$/.test(key)) {
      if (typeof value !== 'string' || !(value in DEPENDENCY_TYPE_NAMES)) throw new BadRequestException(`Invalid ${key}`);
      return;
    }
    // 1.23: each suggestion card has its own few fields.
    if (isSuggestionKind(kind)) return this.checkSuggestionField(kind, key, value);
    const keys: readonly string[] =
      kind === 'plan' ? AGENT_PLAN_FIELD_KEYS : kind === 'plan_link' ? ['plan', 'itemType'] : AGENT_PLAN_ITEM_FIELD_KEYS;
    if (!keys.includes(key)) throw new BadRequestException(`Unknown field ${key}`);
    const isId = typeof value === 'string' && UUID.test(value);
    const number = (max?: number, integer = false) =>
      value === null ||
      (typeof value === 'number' && Number.isFinite(value) && value >= 0 && (max === undefined || value <= max) && (!integer || Number.isInteger(value)));
    const fine =
      key === 'title' || key === 'description'
        ? (key === 'description' && value === null) || (typeof value === 'string' && value.length <= MAX_TEXT)
        : key === 'start' || key === 'end'
          ? value === null || strictDay(value) !== null
          : key === 'planType'
            ? (PLAN_TYPES as readonly unknown[]).includes(value)
            : key === 'itemType'
              ? (PLAN_ITEM_TYPES as readonly unknown[]).includes(value)
              : key === 'priority'
                ? value === null || (PLAN_ITEM_PRIORITIES as readonly unknown[]).includes(value)
                : key === 'estimatedHours'
                  ? number(PLAN_ITEM_MAX_HOURS)
                : key === 'estimatedCost'
                  ? number(PLAN_ITEM_MAX_COST)
                  : key === 'progress'
                    ? number(100, true)
                    : key === 'assignee' || key === 'parent'
                      ? value === null || isId
                      : isId;
    if (!fine) throw new BadRequestException(`Invalid value for ${key}`);
  }

  /** 1.23: what a person may set on a suggestion card, with the human forms' rules. */
  private checkSuggestionField(kind: AgentSuggestionKind, key: string, value: unknown): void {
    if (!AGENT_SUGGESTION_FIELD_KEYS[kind].includes(key)) throw new BadRequestException(`Unknown field ${key}`);
    const isId = typeof value === 'string' && UUID.test(value);
    const text = (max: number, nullable = true) => (nullable && value === null) || (typeof value === 'string' && value.length <= max);
    const scale = (max: number) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
    const fine =
      key === 'title'
        ? text(500, false)
        : key === 'description'
          ? text(10_000)
          : key === 'start' || key === 'end'
            ? strictDay(value) !== null
            : key === 'dependencyType'
              ? typeof value === 'string' && value in DEPENDENCY_TYPE_NAMES
              : key === 'riskType'
                ? value === 'risk' || value === 'opportunity'
                : key === 'probability' || key === 'impact'
                  ? scale(5)
                  : key === 'power' || key === 'interest'
                    ? scale(10)
                    : key === 'attitude'
                      ? value === null || value === 'supportive' || value === 'neutral' || value === 'resistant'
                      : key === 'category'
                        ? text(100)
                        : key === 'mitigation' || key === 'contingency'
                          ? text(2000)
                          : key === 'role' || key === 'organization' || key === 'email'
                            ? text(255)
                            : key === 'engagement'
                              ? text(1000)
                              : key === 'assignee'
                                ? value === null || isId
                                : isId;
    if (!fine) throw new BadRequestException(`Invalid value for ${key}`);
  }

  /** What a card of a space, a process or a member change may set. Everything else is refused. */
  private checkNewField(kind: string, key: string, value: unknown): void {
    const keys: readonly string[] =
      kind === 'space'
        ? AGENT_SPACE_FIELD_KEYS
        : kind === 'process'
          ? AGENT_PROCESS_FIELD_KEYS
          : AGENT_MEMBER_FIELD_KEYS;
    if (!keys.includes(key)) throw new BadRequestException(`Unknown field ${key}`);
    const isId = typeof value === 'string' && UUID.test(value);
    const fine =
      key === 'title' || key === 'description' || key === 'key'
        ? typeof value === 'string' && value.length <= MAX_TEXT
        : key === 'requestType'
          ? (PROCESS_REQUEST_TYPES as readonly unknown[]).includes(value)
          : key === 'scores'
            ? !!value &&
              typeof value === 'object' &&
              !Array.isArray(value) &&
              Object.entries(value).every(
                ([score, n]) =>
                  (PROCESS_SCORE_KEYS as readonly string[]).includes(score) && Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 4,
              )
            : key === 'role'
            ? (SPACE_ROLES as readonly unknown[]).includes(value)
            : key === 'assignee'
              ? value === null || isId
              : isId;
    if (!fine) throw new BadRequestException(`Invalid value for ${key}`);
  }

  private batchFor(
    user: RequestUser,
    run: RunRow,
    conversation: ChatConversationRow,
    actions: AgentActionRow[],
  ): AgentResolveBatch {
    const batch = this.resolver.batch({
      invoker: user,
      conversation,
      timezone: run.timezone ?? 'UTC',
    });
    for (const a of actions)
      batch.siblings.set(a.ordinal, siblingOf(a.ordinal, a.kind, a.resolved as Partial<AgentResolved>));
    return batch;
  }

  /**
   * A run of the caller's own in their organization whose conversation they can still read;
   * 404 for everyone and everything else.
   */
  private async ownRun(
    user: RequestUser,
    runId: string,
  ): Promise<{ run: RunRow; conversation: ChatConversationRow }> {
    const { data, error } = await this.client
      .from('agent_runs')
      .select(
        'id, organization_id, conversation_id, invoker_id, status, visibility, scope, timezone',
      )
      .eq('id', runId)
      .eq('organization_id', user.organizationId)
      .eq('invoker_id', user.userId)
      .maybeSingle();
    if (error) throw new InternalServerErrorException('Could not load the run');
    if (!data) throw new NotFoundException('Run not found');

    const run = data as RunRow;
    const { conversation } = await this.access.getReadable(
      user,
      run.conversation_id,
    );
    return { run, conversation };
  }

  private async loadActions(run: RunRow): Promise<AgentActionRow[]> {
    const { data, error } = await this.client
      .from('agent_actions')
      .select('*')
      .eq('run_id', run.id)
      .eq('organization_id', run.organization_id)
      .order('ordinal', { ascending: true });
    if (error)
      throw new InternalServerErrorException('Could not load the proposals');
    return ((data ?? []) as AgentActionRow[]).map((a) => ({
      ...a,
      ordinal: Number(a.ordinal),
      version: Number(a.version),
      depends_on: a.depends_on === null ? null : Number(a.depends_on),
    }));
  }

  /** An action in the caller's organization; whose it is, ownRun decides. */
  private async findAction(
    user: RequestUser,
    actionId: string,
  ): Promise<Pick<AgentActionRow, 'id' | 'run_id'>> {
    const { data, error } = await this.client
      .from('agent_actions')
      .select('id, run_id')
      .eq('id', actionId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();
    if (error)
      throw new InternalServerErrorException('Could not load the action');
    if (!data) throw new NotFoundException('Action not found');
    return data as Pick<AgentActionRow, 'id' | 'run_id'>;
  }

  /** Whether a hung Confirm reached the database; a member change has no row of its own to look at. */
  private async applied(row: AgentActionRow): Promise<boolean> {
    // 1.23: dates are done when the card's write is kept (before_values) and the item has them;
    // a stakeholder or baseline row has no organization of its own: through its plan.
    if (row.kind === 'plan_dates') {
      const { data } = await this.client
        .from('agent_actions')
        .select('before_values')
        .eq('id', row.id)
        .eq('organization_id', row.organization_id)
        .maybeSingle();
      return !!(data as { before_values: unknown } | null)?.before_values;
    }
    if (row.kind === 'plan_stakeholder' || row.kind === 'plan_baseline') {
      const { data, error } = await this.client
        .from(row.kind === 'plan_stakeholder' ? 'plan_stakeholders' : 'plan_baselines')
        .select('id, plan:plans!inner(organization_id)')
        .eq('id', row.entity_id)
        .eq('plan.organization_id', row.organization_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return !!data;
    }
    // 1.22.1: a link is done when its row is there (plan_tasks keeps no organization of its own).
    if (row.kind === 'plan_link') {
      const { data, error } = await this.client
        .from('plan_tasks')
        .select('id, plan:plans!inner(organization_id)')
        .eq('id', row.entity_id)
        .eq('plan.organization_id', row.organization_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return !!data;
    }
    // A plan item is done only with its link: without it the card comes back, and its Confirm adopts the task.
    if (row.kind === 'plan_item')
      return (
        (await this.exists(row.organization_id, row.kind, row.entity_id)) &&
        !!(await this.productPlans?.planOfTask(row.organization_id, row.entity_id))
      );
    if (!isMemberKind(row.kind)) return this.exists(row.organization_id, row.kind, row.entity_id);
    const plan = (row.resolved as Partial<AgentResolved>).create as AgentMemberPlan | undefined;
    if (!plan?.spaceId || !this.governance) return false;
    return this.governance.memberChangeApplied(row.organization_id, {
      kind: plan.kind,
      spaceId: plan.spaceId,
      userId: plan.userId,
      role: plan.role,
    });
  }

  /** An action's status as stored now. */
  private async statusOf(action: AgentActionRow): Promise<string | null> {
    const { data } = await this.client
      .from('agent_actions')
      .select('status')
      .eq('id', action.id)
      .eq('organization_id', action.organization_id)
      .maybeSingle();
    return (data as { status: string } | null)?.status ?? null;
  }

  /** Whether the object an action reserved exists in the organization. */
  private async exists(
    organizationId: string,
    kind: string,
    id: string,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from(tableOf(kind) ?? 'tasks')
      .select('id')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  }

  /**
   * 409 whose envelope carries the fresh view: the exception filter copies `code` and `data`,
   * so the client reads `code` and `data.run`.
   */
  /** Spaces a blocked or unanswered row names: members who cannot see them must not see the card. */
  private blockedSpaces(resolved: AgentResolved): string[] {
    return resolved.fields
      .filter(
        (f) =>
          f.key === 'space' &&
          (f.state === 'blocked' || f.state === 'needs_input') &&
          typeof f.value === 'string',
      )
      .map((f) => f.value as string);
  }

  private conflict(
    code: 'stale' | 'changed' | 'parent_first',
    message: string,
    run: AgentRunView,
  ) {
    return new ConflictException({ message, code, data: { run } });
  }
}
