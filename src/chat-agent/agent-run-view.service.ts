/**
 * @fileoverview What one viewer sees of Robert's runs (plan 2h, contract section 4.2): the
 * per-viewer AgentRunView, built for many runs at once with a fixed number of queries (no
 * N+1), and the `agent.run.updated` signal after a run changed.
 *
 * The view carries codes, ISO dates and ids only, never a localized sentence; the client
 * renders the texts. Everything outside the caller's organization, every conversation they
 * cannot read now, and every run canViewRun hides from them is left out.
 * @module src/chat-agent/agent-run-view.service
 */

import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  ChatAccessService,
  type ChatConversationKind,
} from '../chat/chat-access.service';
import { ChatConversationsService } from '../chat/chat-conversations.service';
import { ChatRealtimeService } from '../chat/chat-realtime.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  isPlanLinkPlan,
  isSuggestionPlan,
  type AgentFieldView,
  type AgentResolved,
  isWikiPlan,
} from './agent-resolver.service';
import { isOpenAction, proposalPhase } from './agent-run-phase';
import { AgentUndoRulesService, UNDOABLE_KINDS } from './agent-undo-rules.service';
import { entityOf, isNewKind, isSuggestionKind } from './pipeline/agent-kinds';
import type { AgentActionKind, AgentUndoBlocker } from './agent-runs.repository';
import type {
  AgentActionRow,
  AgentActionStatus,
  AgentRunRow,
  AgentRunStatus,
} from './agent-runs.repository';
import { canViewRun } from './agent-visibility';

export type AgentPhase =
  | 'thinking'
  | 'needs_input'
  | 'proposed'
  | 'executing'
  | 'done'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'undone'
  | 'partly_undone'
  | 'refused';

/** One proposal card (contract 4.3); the frontend's `AgentActionView`. */
export interface AgentActionView {
  id: string;
  version: number;
  ordinal: number;
  kind: AgentActionKind;
  status: AgentActionStatus;
  title: string;
  description: string | null;
  confirmable: boolean;
  dependsOn: number | null;
  fields: AgentFieldView[];
  /** wiki_page: the document the page will be created with, for the read-only preview. */
  page?: { doc: Record<string, unknown>; publish: boolean };
  /** A follow-up change of an earlier proposal (1.17): how many in a row. */
  revision?: number;
  result?: {
    ref?: { type: 'task' | 'wiki_page' | 'space' | 'process' | 'plan'; id: string; key?: string };
    /** plan_link (1.22.1): the plan the existing task was added to. */
    plan?: { id: string };
    /** 1.23: a suggestion opens its plan on this tab. */
    tab?: 'timeline' | 'risks' | 'stakeholders' | 'baselines';
    reasonCode?: string;
    reasonParams?: Record<string, unknown>;
    /** Created, but something beside it did not work. */
    note?: 'process_link_failed' | 'dependency_failed';
    /** dependency_failed: why each dependency of the item was not set. */
    noteParams?: { reasons: string[] };
    /** Only for who may press Undo. The server's seconds, so a wrong browser clock changes nothing. */
    undoUntil?: string | null;
    undoSecondsLeft?: number;
    undoBlocked?: { code: string; params?: Record<string, string | number> };
    undoneBy?: { id: string | null; name: string | null };
    undoneAt?: string | null;
  };
}

/** Contract section 4.2; the frontend's `AgentRunView` (robert.model.ts) is the same shape. */
export interface AgentRunView {
  id: string;
  rev: number;
  conversationId: string;
  /** null = refused run (notice under the trigger message) */
  messageId: string | null;
  triggerMessageId: string;
  threadRootId: string | null;
  access: 'full' | 'stub';
  viewer: 'invoker' | 'member';
  visibility: 'pending' | 'invoker' | 'conversation';
  invoker: { id: string | null; name: string | null };
  phase: AgentPhase;
  serverNow: string;
  createdAt: string;
  /** stub only: the tasks and pages the run created */
  resultRefs?: { type: 'task' | 'wiki_page'; id: string }[];
  // access === 'full' only
  step?: string;
  reply?: string;
  replyLang?: 'de' | 'en';
  context?: {
    messageIds: string[];
    count: number;
    from: string | null;
    to: string | null;
    capped: boolean;
  };
  actions?: AgentActionView[];
  moreItems?: boolean;
  unsupported?: string | null;
  notice?: {
    code: string;
    params?: Record<string, string | number>;
    retryable: boolean;
    adminLink: boolean;
  };
  flags?: {
    requestEdited: boolean;
    requestDeleted: boolean;
    /** How many items the request asked for that Robert cannot create yet. */
    itemsDeferred: number;
    /** Their kinds, e.g. `['asset_object']` (1.15 creates tasks, subtasks and wiki pages). */
    unsupportedKinds: string[];
  };
  disclosure?: { provider: string };
  /** The earliest expiry of an open proposal. */
  expiresAt?: string | null;
  confirmedBy?: { id: string; name: string | null };
  confirmedAt?: string;
  undoUntil?: string | null;
  cancelledBy?: { id: string; name: string | null };
  feedback?: 'up' | 'down' | null;
}

const RUN_COLUMNS =
  'id, organization_id, conversation_id, trigger_message_id, agent_message_id, invoker_id, status, visibility, rev, error_code, step, budget_month, budget_day, cancelled_by, provider, timezone, trigger_seq, thread_root_id, trigger_edit_count, context_message_ids, context_min_seq, context_capped, reply_text, reply_lang, more_items, unsupported, is_first_for_invoker, created_at';

type RunRow = Pick<
  AgentRunRow,
  | 'id'
  | 'organization_id'
  | 'conversation_id'
  | 'trigger_message_id'
  | 'agent_message_id'
  | 'invoker_id'
  | 'status'
  | 'visibility'
  | 'rev'
  | 'error_code'
  | 'step'
  | 'budget_month'
  | 'budget_day'
  | 'cancelled_by'
  | 'provider'
  | 'timezone'
  | 'trigger_seq'
  | 'thread_root_id'
  | 'trigger_edit_count'
  | 'context_message_ids'
  | 'context_min_seq'
  | 'context_capped'
  | 'reply_text'
  | 'reply_lang'
  | 'more_items'
  | 'unsupported'
  | 'is_first_for_invoker'
  | 'created_at'
>;

const ACTION_COLUMNS =
  'id, run_id, ordinal, kind, status, resolved, version, depends_on, entity_id, entity_type, target_space_id, confirmed_by, exec_started_at, executed_at, undo_until, undone_by, undone_at, reason, reason_params, expires_at, revision_no:intent->revision_no';

type ActionRow = Pick<
  AgentActionRow,
  | 'id'
  | 'run_id'
  | 'ordinal'
  | 'kind'
  | 'status'
  | 'resolved'
  | 'version'
  | 'depends_on'
  | 'entity_id'
  | 'entity_type'
  | 'target_space_id'
  | 'confirmed_by'
  | 'exec_started_at'
  | 'executed_at'
  | 'undo_until'
  | 'undone_by'
  | 'undone_at'
  | 'reason'
  | 'reason_params'
  | 'expires_at'
> & {
  /** How many follow-up changes this proposal is the result of (1.17); absent before. */
  revision_no?: number | null;
};

interface UndoView {
  undoUntil: string | null;
  undoSecondsLeft?: number;
  blocked?: AgentUndoBlocker;
}

function undoResult(undo: UndoView | undefined, nameOf: (id: string | null) => string | null) {
  if (!undo) return {};
  const { blocked } = undo;
  return {
    undoUntil: undo.undoUntil,
    ...(undo.undoSecondsLeft !== undefined && { undoSecondsLeft: undo.undoSecondsLeft }),
    ...(blocked && {
      undoBlocked: {
        code: blocked.code,
        params: {
          ...(blocked.count && { count: blocked.count }),
          // A blank name reads badly: the card says "someone" without one.
          ...(blocked.by && { name: nameOf(blocked.by) ?? '' }),
        },
      },
    }),
  };
}

/** The card of one action; option lists are the invoker's only. */
function toActionView(
  row: ActionRow,
  isInvoker: boolean,
  processKeys: Map<string, string> = new Map(),
  linkFailed: Set<string> = new Set(),
  undoOf: Map<string, UndoView> = new Map(),
  nameOf: (id: string | null) => string | null = () => null,
  depFailed: Map<string, string[]> = new Map(),
): AgentActionView {
  const resolved = (row.resolved ?? {}) as Partial<AgentResolved>;
  const fields = (resolved.fields ?? []).map((field) => {
    if (isInvoker) return field;
    const shared = { ...field };
    delete shared.options;
    // A space or parent the invoker cannot use was never checked against the members (B6).
    if (field.state === 'blocked' || field.state === 'needs_input')
      delete shared.display;
    return shared;
  });
  const plan = resolved.create;
  const entity = entityOf(row.kind);
  const result =
    row.status === 'executed'
      ? // A member change has no object of its own to point at.
        entity === 'space_member'
        ? { ...undoResult(undoOf.get(row.id), nameOf) }
        : isSuggestionPlan(plan)
          ? // 1.23: the result is the plan, on the tab the suggestion went into.
            {
              ref: { type: 'plan' as const, id: plan.planId, ...(processKeys.has(plan.planId) && { key: processKeys.get(plan.planId) }) },
              tab: SUGGESTION_TAB[plan.kind],
              ...undoResult(undoOf.get(row.id), nameOf),
            }
        : isPlanLinkPlan(plan)
          ? // 1.22.1: the result is the existing task, now in the plan.
            {
              ref: { type: 'task' as const, id: plan.taskId, key: plan.taskKey },
              ...(plan.planId && { plan: { id: plan.planId } }),
              ...undoResult(undoOf.get(row.id), nameOf),
            }
          : {
            ref: {
              type: entity as 'task' | 'wiki_page' | 'space' | 'process' | 'plan',
              id: row.entity_id,
              ...(plan && 'key' in plan && { key: plan.key }),
              ...(processKeys.has(row.entity_id) && { key: processKeys.get(row.entity_id) }),
            },
            ...(linkFailed.has(row.id) && { note: 'process_link_failed' as const }),
            ...(depFailed.has(row.id) && {
              note: 'dependency_failed' as const,
              noteParams: { reasons: depFailed.get(row.id) as string[] },
            }),
            ...undoResult(undoOf.get(row.id), nameOf),
          }
      : row.status === 'undone'
        ? {
            undoneBy: { id: row.undone_by, name: nameOf(row.undone_by) },
            undoneAt: row.undone_at,
          }
      : row.reason
        ? {
            reasonCode: row.reason,
            ...(row.reason_params && { reasonParams: row.reason_params }),
          }
        : undefined;

  return {
    id: row.id,
    version: Number(row.version),
    ordinal: Number(row.ordinal),
    kind: (entity === 'task' || entity === 'plan_link'
      ? row.kind === 'subtask' || row.kind === 'plan_item' || row.kind === 'plan_link'
        ? row.kind
        : 'task'
      : row.kind) as AgentActionKind,
    status: row.status,
    title: resolved.title ?? '',
    description: resolved.description ?? null,
    confirmable:
      isOpenAction(row.status, row.expires_at) && resolved.confirmable === true,
    dependsOn: row.depends_on === null ? null : Number(row.depends_on),
    fields,
    ...(isWikiPlan(plan) && { page: { doc: plan.doc, publish: plan.publish } }),
    ...(result && { result }),
    ...(Number(row.revision_no) > 0 && { revision: Number(row.revision_no) }),
  };
}

const SUGGESTION_TAB = {
  plan_dependency: 'timeline',
  plan_dates: 'timeline',
  plan_risk: 'risks',
  plan_stakeholder: 'stakeholders',
  plan_baseline: 'baselines',
} as const;

const PHASE: Record<AgentRunStatus, AgentPhase> = {
  queued: 'thinking',
  running: 'thinking',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  refused: 'refused',
};

/** Contract section 5: the notices that offer Retry. */
const RETRYABLE = new Set([
  'rate_limited',
  'provider_down',
  'timeout',
  'too_large',
  'failed',
  'busy',
  'interrupted',
]);

/** Notices that send a Robert manager to the AI settings. */
const ADMIN_LINK = new Set(['not_configured', 'invalid_key']);

/** Ids per `in` filter: they ride in the query string. */
const IN_CHUNK = 100;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK)
    out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

/** The next UTC midnight after a `YYYY-MM-DD` period start, as an ISO timestamp. */
function resetsAt(periodStart: string, period: 'day' | 'month'): string {
  const [y, m, d] = periodStart.split('-').map(Number);
  return new Date(
    period === 'day' ? Date.UTC(y, m - 1, d + 1) : Date.UTC(y, m, 1),
  ).toISOString();
}

function noticeParams(
  run: RunRow,
): Record<string, string | number> | undefined {
  if (run.error_code === 'budget_org')
    return { period: 'month', resetsAt: resetsAt(run.budget_month, 'month') };
  if (run.error_code === 'budget_user')
    return { period: 'day', resetsAt: resetsAt(run.budget_day, 'day') };
  return undefined;
}

@Injectable()
export class AgentRunViewService {
  private readonly logger = new Logger(AgentRunViewService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: ChatAccessService,
    private readonly conversations: ChatConversationsService,
    private readonly realtime: ChatRealtimeService,
    @Optional() private readonly undoRules?: AgentUndoRulesService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * POST /chat/agent/runs/resolve: the caller's views of runs, by run id or by the message
   * that asked for them (every run of that request, oldest first).
   */
  async resolve(
    user: RequestUser,
    ids: { runIds?: string[]; triggerMessageIds?: string[] },
  ): Promise<AgentRunView[]> {
    const runIds = [...new Set(ids.runIds ?? [])];
    const triggerIds = [...new Set(ids.triggerMessageIds ?? [])];
    const rows: RunRow[] = [];

    for (const [column, list] of [
      ['id', runIds],
      ['trigger_message_id', triggerIds],
    ] as const) {
      for (const part of chunks(list)) {
        rows.push(
          ...(await this.select<RunRow>(
            this.client
              .from('agent_runs')
              .select(RUN_COLUMNS)
              .eq('organization_id', user.organizationId)
              .in(column, part),
          )),
        );
      }
    }

    const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
    unique.sort((a, b) => a.created_at.localeCompare(b.created_at));

    return this.toViews(user, unique);
  }

  /** One run as the caller sees it; 404 when they may not. */
  async viewOne(user: RequestUser, runId: string): Promise<AgentRunView> {
    const [view] = await this.resolve(user, { runIds: [runId] });
    if (!view) throw new NotFoundException('Run not found');
    return view;
  }

  /**
   * A run of the caller's own, in their organization. Everyone else, admins included,
   * gets 404 (contract section 4).
   */
  async getOwnRun(user: RequestUser, runId: string): Promise<RunRow> {
    const [row] = await this.select<RunRow>(
      this.client
        .from('agent_runs')
        .select(RUN_COLUMNS)
        .eq('id', runId)
        .eq('organization_id', user.organizationId)
        .eq('invoker_id', user.userId)
        .limit(1),
    );
    if (!row) throw new NotFoundException('Run not found');
    return row;
  }

  /**
   * Sends `agent.run.updated` with the run's current rev. `audienceDecided` = the moment
   * the run was finished, when the conversation still hears of a private run once.
   * Never throws: a lost signal is caught up by the client's poll.
   */
  async announce(runId: string, audienceDecided = false): Promise<void> {
    try {
      const [row] = await this.select<
        Pick<
          AgentRunRow,
          'id' | 'conversation_id' | 'invoker_id' | 'visibility' | 'rev'
        >
      >(
        this.client
          .from('agent_runs')
          .select('id, conversation_id, invoker_id, visibility, rev')
          .eq('id', runId)
          .limit(1),
      );
      if (row) await this.announceRow(row, audienceDecided);
    } catch (err) {
      this.logger.warn(
        `agent.run.updated for run ${runId} was not sent: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** The signal for a row already in hand (claimed or reaped runs). */
  announceRow(
    row: Pick<
      AgentRunRow,
      'id' | 'conversation_id' | 'invoker_id' | 'visibility' | 'rev'
    >,
    audienceDecided = false,
  ): Promise<void> {
    return this.realtime.agentRunUpdated(
      {
        conversationId: row.conversation_id,
        invokerId: row.invoker_id,
        visibility: row.visibility,
        runId: row.id,
        rev: row.rev,
      },
      audienceDecided,
    );
  }

  private async toViews(
    user: RequestUser,
    rows: RunRow[],
  ): Promise<AgentRunView[]> {
    if (rows.length === 0) return [];

    const conversationIds = [...new Set(rows.map((r) => r.conversation_id))];
    const [conversations, memberships] = await Promise.all([
      this.selectIn<{
        id: string;
        kind: ChatConversationKind;
        space_id: string | null;
      }>(conversationIds, (part) =>
        this.client
          .from('chat_conversations')
          .select('id, kind, space_id')
          .eq('organization_id', user.organizationId)
          .in('id', part),
      ),
      this.selectIn<{ conversation_id: string; history_from_seq: number }>(
        conversationIds,
        (part) =>
          this.client
            .from('chat_members')
            .select('conversation_id, history_from_seq')
            .eq('organization_id', user.organizationId)
            .eq('user_id', user.userId)
            .in('conversation_id', part),
      ),
    ]);
    const conversationById = new Map(conversations.map((c) => [c.id, c]));
    const historyFrom = new Map(
      memberships.map((m) => [m.conversation_id, Number(m.history_from_seq)]),
    );
    // One permission read for every space channel at once.
    const viewableSpaces = conversations.some((c) => c.kind === 'space')
      ? await this.access.getViewableSpaceIds(user)
      : [];

    const visible = rows.flatMap((run) => {
      const conversation = conversationById.get(run.conversation_id);
      const canRead =
        !!conversation &&
        (conversation.kind === 'space'
          ? !!conversation.space_id &&
            (viewableSpaces === null ||
              viewableSpaces.includes(conversation.space_id))
          : historyFrom.has(conversation.id));
      // Not even the invoker keeps a run of a conversation they can no longer read.
      if (!canRead) return [];

      const access = canViewRun({
        viewerId: user.userId,
        invokerId: run.invoker_id,
        visibility: run.visibility,
        status: run.status,
        viewerCanRead: true,
        viewerHistoryFromSeq: historyFrom.get(run.conversation_id) ?? 0,
        contextMinSeq:
          run.context_min_seq === null ? null : Number(run.context_min_seq),
      });
      return access === 'none' ? [] : [{ run, access }];
    });

    const full = visible.filter((v) => v.access === 'full').map((v) => v.run);
    const done = full.filter((run) => run.status === 'completed');
    const contextEnds = done.flatMap((run) =>
      run.context_message_ids.length > 0
        ? [run.context_message_ids[0], run.context_message_ids.at(-1) as string]
        : [],
    );

    const actionRows = await this.selectIn<ActionRow>(
      visible.map(({ run }) => run.id),
      (part) =>
        this.client
          .from('agent_actions')
          .select(ACTION_COLUMNS)
          .eq('organization_id', user.organizationId)
          .in('run_id', part)
          .order('ordinal', { ascending: true }),
    );
    const actionsOf = new Map<string, ActionRow[]>();
    for (const row of actionRows) {
      actionsOf.set(row.run_id, [...(actionsOf.get(row.run_id) ?? []), row]);
    }
    // A process opens by its key, which it only gets when it is created (1.20).
    const processIds = actionRows
      .filter((row) => row.kind === 'process' && row.status === 'executed')
      .map((row) => row.entity_id);
    const processKeys = new Map<string, string>();
    if (processIds.length) {
      const { data } = await this.client
        .from('business_processes')
        .select('id, key')
        .eq('organization_id', user.organizationId)
        .in('id', processIds);
      for (const p of (data ?? []) as { id: string; key: string }[]) processKeys.set(p.id, p.key);
    }
    // So does a plan (1.22): its key names its space, and a plan that is gone has none.
    // 1.23: a suggestion opens its plan, on the tab it went into.
    const planIds = [
      ...new Set([
        ...actionRows.filter((row) => row.kind === 'plan' && row.status === 'executed').map((row) => row.entity_id),
        ...actionRows
          .filter((row) => isSuggestionKind(row.kind) && row.status === 'executed')
          .map((row) => String((row.resolved as { create?: { planId?: string } } | null)?.create?.planId ?? ''))
          .filter(Boolean),
      ]),
    ];
    if (planIds.length) {
      const { data } = await this.client
        .from('plans')
        .select('id, plan_key')
        .eq('organization_id', user.organizationId)
        .in('id', planIds);
      for (const p of (data ?? []) as { id: string; plan_key: string | null }[]) if (p.plan_key) processKeys.set(p.id, p.plan_key);
    }
    // A page under a process whose link failed stands; only the audit knows, and the card should say.
    const underProcess = actionRows.filter(
      (row) =>
        row.kind === 'wiki_page' &&
        row.status === 'executed' &&
        actionRows.some((p) => p.run_id === row.run_id && p.kind === 'process' && p.ordinal === row.depends_on),
    );
    const linkFailed = new Set<string>();
    const depFailed = new Map<string, string[]>();
    // 1.22.1: an item whose dependencies were not all set says which and why.
    const noted = [
      ...underProcess,
      ...actionRows.filter((row) => row.kind === 'plan_item' && row.status === 'executed'),
    ];
    if (noted.length) {
      const { data } = await this.client
        .from('agent_audit_events')
        .select('action_id, data')
        .eq('organization_id', user.organizationId)
        // 1.22.1: the dependencies of an item are written after it, in an event of their own.
        .in('event', ['action.executed', 'action.dependencies'])
        .in('action_id', noted.map((row) => row.id));
      for (const e of (data ?? []) as {
        action_id: string;
        data: { process_link_failed?: boolean; dependency_failed?: string[] } | null;
      }[]) {
        if (e.data?.process_link_failed) linkFailed.add(e.action_id);
        if (e.data?.dependency_failed?.length) depFailed.set(e.action_id, e.data.dependency_failed);
      }
    }
    const undoOf = await this.undoViews(user, visible.map(({ run }) => run), actionRows);
    const ownDone = done.filter((run) => run.invoker_id === user.userId);

    const [triggers, siblings, ends, audits, feedbacks, users, canManage] =
      await Promise.all([
        this.selectIn<{
          id: string;
          edit_count: number;
          deleted_at: string | null;
        }>([...new Set(full.map((run) => run.trigger_message_id))], (part) =>
          this.client
            .from('chat_messages')
            .select('id, edit_count, deleted_at')
            .eq('organization_id', user.organizationId)
            .in('id', part),
        ),
        // Every run of those requests (refused ones too): only the newest offers Re-run.
        this.selectIn<{ trigger_message_id: string; created_at: string }>(
          [...new Set(full.map((run) => run.trigger_message_id))],
          (part) =>
            this.client
              .from('agent_runs')
              .select('trigger_message_id, created_at')
              .eq('organization_id', user.organizationId)
              .in('trigger_message_id', part),
        ),
        this.selectIn<{ id: string; created_at: string }>(
          [...new Set(contextEnds)],
          (part) =>
            this.client
              .from('chat_messages')
              .select('id, created_at')
              .eq('organization_id', user.organizationId)
              .in('id', part),
        ),
        // The items Robert could not propose are counted in the audit row.
        this.selectIn<{
          run_id: string;
          data: {
            intents?: unknown;
            deferred?: unknown;
            unsupported_kinds?: unknown;
          } | null;
        }>(
          done.map((run) => run.id),
          (part) =>
            this.client
              .from('agent_audit_events')
              .select('run_id, data')
              .eq('organization_id', user.organizationId)
              .eq('event', 'run.completed')
              .in('run_id', part),
        ),
        // The invoker's thumbs: the latest one wins.
        this.selectIn<{ run_id: string; data: { rating?: unknown } | null }>(
          ownDone.map((run) => run.id),
          (part) =>
            this.client
              .from('agent_audit_events')
              .select('run_id, data')
              .eq('organization_id', user.organizationId)
              .eq('event', 'run.feedback')
              .eq('actor_id', user.userId)
              .in('run_id', part)
              .order('seq', { ascending: true }),
        ),
        this.conversations.loadUsers([
          ...visible.flatMap(({ run }) =>
            [run.invoker_id, run.cancelled_by].filter(
              (id): id is string => !!id,
            ),
          ),
          ...actionRows.flatMap((a) =>
            [a.confirmed_by, a.undone_by].filter((id): id is string => !!id),
          ),
          ...[...undoOf.values()].flatMap((u) => (u.blocked?.by ? [u.blocked.by] : [])),
        ]),
        full.some((run) => ADMIN_LINK.has(run.error_code ?? ''))
          ? this.access.hasPermission(user, 'can_manage_robert')
          : Promise.resolve(false),
      ]);

    const triggerById = new Map(triggers.map((t) => [t.id, t]));
    const newestRun = new Map<string, number>();
    for (const r of siblings) {
      const at = Date.parse(r.created_at);
      if (at > (newestRun.get(r.trigger_message_id) ?? -Infinity)) {
        newestRun.set(r.trigger_message_id, at);
      }
    }
    const createdAt = new Map(ends.map((m) => [m.id, m.created_at]));
    const auditOf = new Map(audits.map((a) => [a.run_id, a.data ?? {}]));
    const feedbackOf = new Map<string, 'up' | 'down'>();
    for (const f of feedbacks) {
      if (f.data?.rating === 'up' || f.data?.rating === 'down')
        feedbackOf.set(f.run_id, f.data.rating);
    }
    const nameOf = (id: string | null) =>
      id ? (users.get(id)?.name ?? null) : null;
    const serverNow = new Date().toISOString();

    return visible.map(({ run, access }): AgentRunView => {
      const isInvoker = run.invoker_id === user.userId;
      const actions = actionsOf.get(run.id) ?? [];
      const phase =
        run.status === 'completed' && actions.length > 0
          ? proposalPhase(
              actions.map((a) => ({
                status: a.status,
                confirmable:
                  (a.resolved as Partial<AgentResolved>).confirmable === true,
                expiresAt: a.expires_at,
              })),
            )
          : PHASE[run.status];
      const base: AgentRunView = {
        id: run.id,
        rev: Number(run.rev),
        conversationId: run.conversation_id,
        messageId: run.agent_message_id,
        triggerMessageId: run.trigger_message_id,
        threadRootId: run.thread_root_id,
        access,
        viewer: isInvoker ? 'invoker' : 'member',
        visibility: run.visibility,
        invoker: { id: run.invoker_id, name: nameOf(run.invoker_id) },
        phase,
        serverNow,
        createdAt: run.created_at,
      };

      // A stub points at what the run created, and nothing else.
      if (access === 'stub')
        return {
          ...base,
          // A link points at the person's task it added (its own id is a plan_tasks row); a
          // suggestion of 1.23 is no task or page at all.
          resultRefs: actions
            .filter(
              (a) =>
                a.status === 'executed' &&
                (a.kind === 'wiki_page' || (!isNewKind(a.kind) && a.kind !== 'plan' && !isSuggestionKind(a.kind))),
            )
            .map((a) => ({
              type:
                a.kind === 'wiki_page' ? ('wiki_page' as const) : ('task' as const),
              id:
                a.kind === 'plan_link'
                  ? String((a.resolved as { create?: { taskId?: string } } | null)?.create?.taskId ?? a.entity_id)
                  : a.entity_id,
            }))
            .filter((r) => r.id),
        };

      const trigger = triggerById.get(run.trigger_message_id);
      const ids = run.context_message_ids ?? [];
      const code = run.error_code;
      const audit = auditOf.get(run.id) ?? {};
      const unsupportedKinds = Array.isArray(audit.unsupported_kinds)
        ? audit.unsupported_kinds.filter(
            (k): k is string => typeof k === 'string',
          )
        : [];
      const openExpiry = actions
        .filter((a) => isOpenAction(a.status, a.expires_at))
        .map((a) => a.expires_at)
        .sort()[0];
      const confirmed = actions
        .filter((a) => a.confirmed_by && a.exec_started_at)
        .sort((a, b) =>
          (b.exec_started_at as string).localeCompare(
            a.exec_started_at as string,
          ),
        )[0];

      return {
        ...base,
        ...(phase === 'thinking' && run.step && { step: run.step }),
        ...(run.reply_text !== null && { reply: run.reply_text }),
        ...((run.reply_lang === 'de' || run.reply_lang === 'en') && {
          replyLang: run.reply_lang,
        }),
        ...(run.status === 'completed' && {
          context: {
            messageIds: ids,
            count: ids.length,
            from: createdAt.get(ids[0]) ?? null,
            to: createdAt.get(ids.at(-1) as string) ?? null,
            capped: run.context_capped,
          },
        }),
        actions: actions.map((a) => toActionView(a, isInvoker, processKeys, linkFailed, undoOf, nameOf, depFailed)),
        moreItems: run.more_items,
        unsupported:
          run.unsupported && run.unsupported !== 'none'
            ? run.unsupported
            : null,
        ...((phase === 'failed' || phase === 'refused') &&
          code && {
            notice: {
              code,
              ...(noticeParams(run) && { params: noticeParams(run) }),
              retryable: RETRYABLE.has(code),
              adminLink: canManage && ADMIN_LINK.has(code),
            },
          }),
        flags: {
          // A deleted request keeps its edit count; "deleted" is the stronger state.
          requestEdited:
            !!trigger &&
            !trigger.deleted_at &&
            Number(trigger.edit_count) > Number(run.trigger_edit_count) &&
            Date.parse(run.created_at) >=
              (newestRun.get(run.trigger_message_id) ?? -Infinity),
          requestDeleted: !trigger || !!trigger.deleted_at,
          // A 1.13 run counted every intent as deferred.
          itemsDeferred: Number(audit.deferred ?? audit.intents) || 0,
          unsupportedKinds,
        },
        ...(isInvoker &&
          run.is_first_for_invoker &&
          run.provider && { disclosure: { provider: run.provider } }),
        expiresAt: openExpiry ?? null,
        ...(confirmed?.confirmed_by && {
          confirmedBy: {
            id: confirmed.confirmed_by,
            name: nameOf(confirmed.confirmed_by),
          },
          confirmedAt: confirmed.exec_started_at as string,
        }),
        undoUntil:
          actions
            .map((a) => undoOf.get(a.id))
            .filter((u) => u?.undoSecondsLeft !== undefined)
            .map((u) => u?.undoUntil as string)
            .sort()
            .pop() ?? null,
        ...(run.cancelled_by && {
          cancelledBy: {
            id: run.cancelled_by,
            name: nameOf(run.cancelled_by),
          },
        }),
        ...(isInvoker && { feedback: feedbackOf.get(run.id) ?? null }),
      };
    });
  }

  /**
   * What the Undo of each executed action looks like to this viewer: nothing unless they may press
   * it. Read in one call, only inside the window, so an old card costs no query.
   */
  private async undoViews(
    user: RequestUser,
    runs: RunRow[],
    actions: ActionRow[],
  ): Promise<Map<string, UndoView>> {
    const out = new Map<string, UndoView>();
    const executed = actions.filter((a) => a.status === 'executed');
    if (!this.undoRules || !executed.length) return out;

    const invokerOf = new Map(runs.map((run) => [run.id, run.invoker_id]));
    const others = executed.some((a) => invokerOf.get(a.run_id) !== user.userId);
    const isAdmin = others && (await this.undoRules.isTenantAdmin(user));
    const now = Date.now();
    const live: ActionRow[] = [];
    for (const a of executed) {
      if (invokerOf.get(a.run_id) !== user.userId && !isAdmin) continue;
      if (!UNDOABLE_KINDS.has(a.kind)) {
        out.set(a.id, { undoUntil: null, blocked: { code: 'not_undoable', count: 0, by: null } });
        continue;
      }
      const left = a.undo_until ? Date.parse(a.undo_until) - now : 0;
      if (left <= 0) {
        // Old actions from before this release have no window at all: the same, never an error.
        out.set(a.id, { undoUntil: a.undo_until, blocked: { code: 'expired', count: 0, by: null } });
        continue;
      }
      out.set(a.id, { undoUntil: a.undo_until, undoSecondsLeft: Math.ceil(left / 1000) });
      live.push(a);
    }
    if (!live.length) return out;

    try {
      const { data, error } = await this.client.rpc('agent_undo_state', {
        p_organization_id: user.organizationId,
        p_actor_id: user.userId,
        p_action_ids: live.map((a) => a.id),
      });
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as { action_id: string; blockers: AgentUndoBlocker[] }[]) {
        const view = out.get(row.action_id);
        if (view && row.blockers[0]) view.blocked = row.blockers[0];
      }
      await Promise.all(
        live.map(async (a) => {
          const view = out.get(a.id);
          if (view && !view.blocked && !(await this.undoRules?.mayDelete(user, a)))
            view.blocked = { code: 'no_permission', count: 0, by: null };
        }),
      );
    } catch (err) {
      // The card still opens. Pressing Undo asks the database again anyway.
      this.logger.warn(`Robert undo state not read: ${String(err)}`);
    }
    return out;
  }

  private async select<T>(
    query: PromiseLike<{ data: unknown; error: unknown }>,
  ): Promise<T[]> {
    const { data, error } = await query;
    if (error)
      throw new InternalServerErrorException('Could not load Robert runs');
    return (data ?? []) as T[];
  }

  private async selectIn<T>(
    ids: string[],
    query: (part: string[]) => PromiseLike<{ data: unknown; error: unknown }>,
  ): Promise<T[]> {
    const out: T[] = [];
    for (const part of chunks(ids))
      out.push(...(await this.select<T>(query(part))));
    return out;
  }
}
