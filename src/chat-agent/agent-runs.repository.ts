/**
 * @fileoverview Typed wrappers over the agent_* Postgres functions (migrations
 * 20261014130100_chat_agent_functions.sql and 20261014130200_chat_agent_object_rpcs.sql,
 * contract sections 2.3 and 2.4), plus the row types of agent_runs and agent_actions.
 * One method per function, nothing else: every rule (lease, budget, audit, idempotency)
 * lives in the function. Errors follow the chat SQLSTATE contract (chat-rpc-error.ts).
 * The one exception is recordAudit: two events have no function behind them.
 * @module src/chat-agent/agent-runs.repository
 */

import { Injectable } from '@nestjs/common';
import { callChatRpc } from '../chat/chat-rpc-error';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  isRobertWorkerEnabled,
  MAX_RUNNING_RUNS_PER_TENANT,
  MAX_RUNS_PER_USER_PER_MINUTE,
  ROBERT_ID,
  RUN_RESERVE_TOKENS,
} from './agent.constants';

// ---------------------------------------------------------------------------
// Codes (contract section 5)
// ---------------------------------------------------------------------------

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'refused';
export type AgentRunVisibility = 'pending' | 'invoker' | 'conversation';

/** `error_code` of a refused run. */
export type AgentRefusalCode =
  | 'impersonating'
  | 'not_licensed'
  | 'no_permission'
  | 'disabled'
  | 'dm_disabled'
  | 'not_configured'
  | 'read_only'
  | 'not_rerunnable'
  | 'rate_limited'
  | 'budget_org'
  | 'budget_user';

/** `error_code` of a failed run. */
export type AgentFailureCode =
  | 'invalid_key'
  | 'rate_limited'
  | 'provider_down'
  | 'timeout'
  | 'too_large'
  | 'failed'
  | 'busy'
  | 'interrupted';

/** Thinking step shown on the card (`agent_runs.step`). */
export type AgentStep =
  | 'reading'
  | 'understanding'
  | 'rereading'
  | 'checking'
  | 'filling';

export type AgentActionKind =
  | 'task'
  | 'subtask'
  | 'asset_object'
  | 'wiki_page'
  | 'plan_item'
  | 'plan'
  | 'plan_link'
  | 'plan_dependency'
  | 'plan_dates'
  | 'plan_risk'
  | 'plan_stakeholder'
  | 'plan_baseline'
  | 'space'
  | 'process'
  | 'space_member_add'
  | 'space_member_role'
  | 'space_member_permissions'
  | 'space_member_remove';
export type AgentActionStatus =
  | 'proposed'
  | 'executing'
  | 'executed'
  | 'linked'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'undoing'
  | 'undone';
/** A plan item and a subtask are stored as `task`. */
export type AgentEntityType =
  | 'task'
  | 'wiki_page'
  | 'asset_object'
  | 'space'
  | 'process'
  | 'plan'
  | 'space_member'
  | 'plan_link'
  | 'plan_dependency'
  | 'plan_dates'
  | 'plan_risk'
  | 'plan_stakeholder'
  | 'plan_baseline';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** What a run touches; the audience rule reads it. */
export interface AgentRunScope {
  spaces: { id: string; perm: string }[];
  refs: { type: string; id: string }[];
}

export interface AgentRunRow {
  id: string;
  organization_id: string;
  conversation_id: string;
  trigger_message_id: string;
  /** null only for a refused run. */
  agent_message_id: string | null;
  run_no: number;
  invoker_id: string | null;
  status: AgentRunStatus;
  visibility: AgentRunVisibility;
  /** +1 on every change of the run or of one of its actions. */
  rev: number;
  error_code: AgentRefusalCode | AgentFailureCode | null;
  step: AgentStep | null;
  attempts: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  deadline_at: string;
  cancel_requested_at: string | null;
  cancelled_by: string | null;
  budget_month: string;
  budget_day: string;
  reserved_tokens: number;
  tokens_in: number;
  tokens_out: number;
  model_calls: number;
  provider: string | null;
  model: string | null;
  timezone: string | null;
  trigger_seq: number;
  thread_root_id: string | null;
  trigger_edit_count: number;
  context_message_ids: string[];
  context_min_seq: number | null;
  context_capped: boolean;
  scope: AgentRunScope;
  reply_text: string | null;
  reply_lang: string | null;
  object_lang: string | null;
  more_items: boolean;
  unsupported: string | null;
  prompt_version: string | null;
  prompt_hash: string | null;
  prompt_text: string | null;
  is_first_for_invoker: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AgentActionRow {
  id: string;
  organization_id: string;
  run_id: string;
  ordinal: number;
  kind: AgentActionKind;
  status: AgentActionStatus;
  /** The model's output for this item; never changed. */
  intent: Record<string, unknown>;
  /** What the invoker edited or picked. */
  overrides: Record<string, unknown>;
  /** `{ title, description, fields, duplicates, confirmable }` (contract 4.3). */
  resolved: Record<string, unknown>;
  version: number;
  /** Ordinal of the parent action in the same run. */
  depends_on: number | null;
  target_space_id: string | null;
  entity_type: AgentEntityType;
  /** The id the object WILL get. */
  entity_id: string;
  linked_entity_type: string | null;
  linked_entity_id: string | null;
  exec_token: string | null;
  exec_started_at: string | null;
  attempts: number;
  confirmed_by: string | null;
  executed_at: string | null;
  undo_until: string | null;
  undone_by: string | null;
  undone_at: string | null;
  reason: string | null;
  reason_params: Record<string, unknown> | null;
  expires_at: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Function results
// ---------------------------------------------------------------------------

export interface AgentStartResult {
  run_id: string;
  /** null for a refused run. */
  agent_message_id: string | null;
  seq: number | null;
  thread_root_id: string | null;
  status: AgentRunStatus;
  /** Only for the call that created a running run. */
  lease_token: string | null;
  /** false = the run was already there (resend or double click). */
  created: boolean;
  refusal: AgentRefusalCode | null;
  /** true exactly once per month: deliver the 100% budget alert. */
  alert100: boolean;
  /** The invoker's first run that was not refused. */
  first: boolean;
}

export interface AgentModelCallResult {
  /** false = the lease is lost; nothing was booked. */
  recorded: boolean;
  /** The run's reservation minus everything it has spent; stop calling at zero. */
  remaining: number;
  /** true exactly once per month: deliver the 80% budget alert. */
  alert80: boolean;
}

/** One proposed object, as stored by agent_finalize_run (ordinal = array position). */
export interface AgentProposedAction {
  kind: AgentActionKind;
  intent: Record<string, unknown>;
  resolved: Record<string, unknown>;
  depends_on?: number | null;
  target_space_id?: string | null;
  entity_type?: AgentEntityType;
  /** The person's card edits carried over from the proposal this one revises (1.17). */
  overrides?: Record<string, unknown>;
}

/** `p_result` of agent_finalize_run. */
export interface AgentRunResult {
  reply_text?: string | null;
  reply_lang?: string | null;
  object_lang?: string | null;
  more_items?: boolean;
  unsupported?: string | null;
  context_message_ids?: string[];
  context_min_seq?: number | null;
  context_capped?: boolean;
  scope?: AgentRunScope;
  provider?: string | null;
  model?: string | null;
  prompt_version?: string | null;
  prompt_hash?: string | null;
  /** Stored only when the tenant opted in (agent_settings.store_prompts). */
  prompt_text?: string | null;
  /** The reply when a revision finds its proposal no longer open (1.17); never stored as such. */
  stale_reply_text?: string | null;
}

export interface AgentMemberMatch {
  user_id: string;
  full_name: string;
  email: string | null;
  avatar_url: string | null;
  /** Exact full name or first name. */
  exact: boolean;
}

export interface AgentSimilarMatch {
  entity_id: string;
  space_id: string | null;
  score: number;
  /** A unique asset identifier matched by equality. */
  exact: boolean;
}

export interface AgentUndoBlocker {
  code: string;
  count: number;
  by: string | null;
}

/** ids, enum values, dates, numbers and hashes only: never free text. */
type AuditData = Record<string, unknown> | null;

@Injectable()
export class AgentRunsRepository {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /**
   * Starts a run or stores its refusal; a resend returns the run that is there.
   * `refusal` is a gate the backend already failed (AgentGatesService.refusal).
   * With the worker switched off this instance asks for no slot, so the run is
   * queued for another instance and no lease is handed out here.
   */
  startRun(args: {
    organizationId: string;
    triggerMessageId: string;
    invokerId: string;
    timezone?: string | null;
    rerunOf?: string | null;
    refusal?: AgentRefusalCode | null;
  }): Promise<AgentStartResult> {
    return callChatRpc<AgentStartResult>(this.client, 'agent_start_run', {
      p_organization_id: args.organizationId,
      p_trigger_message_id: args.triggerMessageId,
      p_invoker_id: args.invokerId,
      p_reserve: RUN_RESERVE_TOKENS,
      p_timezone: args.timezone ?? null,
      p_rerun_of: args.rerunOf ?? null,
      p_refusal: args.refusal ?? null,
      p_rate: MAX_RUNS_PER_USER_PER_MINUTE,
      p_max_running: isRobertWorkerEnabled() ? MAX_RUNNING_RUNS_PER_TENANT : 0,
    });
  }

  /**
   * Claims queued runs and runs whose worker died, each with a new lease token.
   * An instance with the worker switched off never asks.
   */
  async claimRuns(limit: number): Promise<AgentRunRow[]> {
    if (!isRobertWorkerEnabled()) return [];

    return (
      (await callChatRpc<AgentRunRow[] | null>(
        this.client,
        'agent_claim_runs',
        { p_limit: limit, p_max_running: MAX_RUNNING_RUNS_PER_TENANT },
      )) ?? []
    );
  }

  /** Renews leases. A run missing from the answer is no longer ours. */
  async heartbeat(
    leaseTokens: string[],
  ): Promise<{ run_id: string; cancel_requested: boolean }[]> {
    return (
      (await callChatRpc<
        { run_id: string; cancel_requested: boolean }[] | null
      >(this.client, 'agent_heartbeat', { p_lease_tokens: leaseTokens })) ?? []
    );
  }

  /** @returns false when the lease is lost */
  setStep(
    runId: string,
    leaseToken: string,
    step: AgentStep,
  ): Promise<boolean> {
    return callChatRpc<boolean>(this.client, 'agent_set_step', {
      p_run_id: runId,
      p_lease_token: leaseToken,
      p_step: step,
    });
  }

  /** Books the tokens of one model call, also of a failed one. */
  recordModelCall(args: {
    runId: string;
    leaseToken: string;
    tokensIn: number;
    tokensOut: number;
    promptHash: string | null;
    ok: boolean;
    errorKind: string | null;
    durationMs: number;
  }): Promise<AgentModelCallResult> {
    return callChatRpc<AgentModelCallResult>(
      this.client,
      'agent_record_model_call',
      {
        p_run_id: args.runId,
        p_lease_token: args.leaseToken,
        p_tokens_in: args.tokensIn,
        p_tokens_out: args.tokensOut,
        p_prompt_hash: args.promptHash,
        p_ok: args.ok,
        p_error_kind: args.errorKind,
        p_duration_ms: args.durationMs,
      },
    );
  }

  /** Stores the result of a run. `finalized: false` = the lease is lost, nothing changed. */
  finalizeRun(args: {
    runId: string;
    leaseToken: string;
    status: 'completed' | 'failed' | 'cancelled';
    errorCode: AgentFailureCode | null;
    visibility: 'invoker' | 'conversation' | null;
    result: AgentRunResult;
    actions: AgentProposedAction[];
    audit?: AuditData;
    /** Open proposals of the invoker this run revises; replaced atomically, or nothing is proposed. */
    supersede?: string[];
  }): Promise<{
    finalized: boolean;
    status: AgentRunStatus | null;
    stale?: boolean;
  }> {
    return callChatRpc(this.client, 'agent_finalize_run', {
      p_run_id: args.runId,
      p_lease_token: args.leaseToken,
      p_status: args.status,
      p_error_code: args.errorCode,
      p_visibility: args.visibility,
      p_result: args.result,
      p_actions: args.actions,
      p_audit: args.audit ?? null,
      ...(args.supersede?.length && { p_supersede: args.supersede }),
    });
  }

  /** Ends runs that can no longer finish on their own; returns them. */
  async reapRuns(): Promise<AgentRunRow[]> {
    return (
      (await callChatRpc<AgentRunRow[] | null>(
        this.client,
        'agent_reap_runs',
        {},
      )) ?? []
    );
  }

  /** Invoker only; anyone else gets 404. */
  cancelRun(
    organizationId: string,
    runId: string,
    actorId: string,
  ): Promise<{ status: AgentRunStatus }> {
    return callChatRpc(this.client, 'agent_cancel_run', {
      p_organization_id: organizationId,
      p_run_id: runId,
      p_actor_id: actorId,
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Compare-and-set edit of a proposed action. `updated: false` = stale version. */
  patchAction(args: {
    organizationId: string;
    actionId: string;
    actorId: string;
    version: number;
    overrides: Record<string, unknown>;
    resolved: Record<string, unknown>;
    targetSpaceId: string | null;
    scope: AgentRunScope;
    /** true narrows the run to the invoker; visibility never widens. */
    narrow: boolean;
    audit?: AuditData;
  }): Promise<{ updated: boolean; version: number }> {
    return callChatRpc(this.client, 'agent_patch_action', {
      p_organization_id: args.organizationId,
      p_action_id: args.actionId,
      p_actor_id: args.actorId,
      p_version: args.version,
      p_overrides: args.overrides,
      p_resolved: args.resolved,
      p_target_space_id: args.targetSpaceId,
      p_scope: args.scope,
      p_narrow: args.narrow,
      p_audit: args.audit ?? null,
    });
  }

  /**
   * Confirm: claims the actions whose version the invoker saw. An action that is
   * missing from the answer was not claimed (stale, expired, taken, not theirs).
   *
   * @param versions `{ [actionId]: version }`
   */
  async claimActions(
    organizationId: string,
    runId: string,
    actorId: string,
    versions: Record<string, number>,
  ): Promise<AgentActionRow[]> {
    return (
      (await callChatRpc<AgentActionRow[] | null>(
        this.client,
        'agent_claim_actions',
        {
          p_organization_id: organizationId,
          p_run_id: runId,
          p_actor_id: actorId,
          p_versions: versions,
        },
      )) ?? []
    );
  }

  /** Token-fenced end of a confirm. `released` puts the action back to proposed. */
  completeAction(args: {
    actionId: string;
    execToken: string;
    outcome: 'executed' | 'failed' | 'released';
    reason?: string | null;
    reasonParams?: Record<string, unknown> | null;
    audit?: AuditData;
  }): Promise<{ completed: boolean; status: AgentActionStatus | null }> {
    return callChatRpc(this.client, 'agent_complete_action', {
      p_action_id: args.actionId,
      p_exec_token: args.execToken,
      p_outcome: args.outcome,
      p_reason: args.reason ?? null,
      p_reason_params: args.reasonParams ?? null,
      p_audit: args.audit ?? null,
    });
  }

  /** "Link instead": the proposed action points at an existing object. */
  linkAction(args: {
    organizationId: string;
    actionId: string;
    actorId: string;
    version: number;
    linkedEntityType: string;
    linkedEntityId: string;
    scope: AgentRunScope;
    narrow: boolean;
  }): Promise<{ linked: boolean }> {
    return callChatRpc(this.client, 'agent_link_action', {
      p_organization_id: args.organizationId,
      p_action_id: args.actionId,
      p_actor_id: args.actorId,
      p_version: args.version,
      p_linked_entity_type: args.linkedEntityType,
      p_linked_entity_id: args.linkedEntityId,
      p_scope: args.scope,
      p_narrow: args.narrow,
    });
  }

  /** A Confirm of the run is creating (on) or done (off); Undo waits meanwhile (audit 2026-11-10). */
  async markConfirming(organizationId: string, runId: string, on: boolean): Promise<void> {
    await callChatRpc(this.client, 'agent_mark_confirming', {
      p_organization_id: organizationId,
      p_run_id: runId,
      p_on: on,
    });
  }

  /** An Undo still working: its claims stay fresh, so the sweep does not take them over. */
  async touchUndo(organizationId: string, actionIds: string[], tokens: string[]): Promise<number> {
    return Number(
      (await callChatRpc<number | null>(this.client, 'agent_touch_undo', {
        p_organization_id: organizationId,
        p_action_ids: actionIds,
        p_tokens: tokens,
      })) ?? 0,
    );
  }

  /** Undo: claims executed or linked actions inside their undo window. */
  async claimUndo(
    organizationId: string,
    actorId: string,
    isAdmin: boolean,
    actionIds: string[],
  ): Promise<AgentActionRow[]> {
    return (
      (await callChatRpc<AgentActionRow[] | null>(
        this.client,
        'agent_claim_undo',
        {
          p_organization_id: organizationId,
          p_actor_id: actorId,
          p_is_admin: isAdmin,
          p_action_ids: actionIds,
        },
      )) ?? []
    );
  }

  /** Token-fenced end of an undo. `blocked` puts the action back with the reason. */
  completeUndo(args: {
    actionId: string;
    execToken: string;
    outcome: 'undone' | 'blocked';
    reason?: string | null;
    reasonParams?: Record<string, unknown> | null;
    actorId: string;
  }): Promise<{ status: AgentActionStatus | null }> {
    return callChatRpc(this.client, 'agent_complete_undo', {
      p_action_id: args.actionId,
      p_exec_token: args.execToken,
      p_outcome: args.outcome,
      p_reason: args.reason ?? null,
      p_reason_params: args.reasonParams ?? null,
      p_actor_id: args.actorId,
    });
  }

  /**
   * Cancels proposed (and failed) actions. The filters combine with AND and at
   * least one is required: `actionIds` + `actorId` for a user cancel (`user`),
   * `triggerMessageId` when the request was deleted (`request_deleted`),
   * `conversationId` + `userId`, or `userId` alone, when access was lost
   * (`requester_no_access`).
   *
   * @returns how many actions were cancelled
   */
  /** Closes the open proposals of people who lost access, by any path; the runs to announce. */
  async cancelRemovedRequesters(limit: number): Promise<string[]> {
    const rows = await callChatRpc<{ run_id: string }[] | null>(this.client, 'agent_cancel_removed_requesters', {
      p_limit: limit,
    });
    return [...new Set((rows ?? []).map((r) => r.run_id))];
  }

  async cancelActions(
    organizationId: string,
    reason: string,
    filter: {
      actionIds?: string[];
      triggerMessageId?: string;
      conversationId?: string;
      userId?: string;
      actorId?: string;
    },
  ): Promise<number> {
    return Number(
      (await callChatRpc<number | null>(this.client, 'agent_cancel_actions', {
        p_organization_id: organizationId,
        p_reason: reason,
        p_action_ids: filter.actionIds ?? null,
        p_trigger_message_id: filter.triggerMessageId ?? null,
        p_conversation_id: filter.conversationId ?? null,
        p_user_id: filter.userId ?? null,
        p_actor_id: filter.actorId ?? null,
      })) ?? 0,
    );
  }

  /** Expires 24-hour-old proposals and cancels those of people who left. */
  async expireActions(limit: number): Promise<number> {
    return Number(
      (await callChatRpc<number | null>(this.client, 'agent_expire_actions', {
        p_limit: limit,
      })) ?? 0,
    );
  }

  /**
   * Confirms and undos that hang for more than 3 minutes, each with a NEW token,
   * to be reconciled by whether `entity_id` exists.
   */
  async reclaimStuckActions(limit: number): Promise<AgentActionRow[]> {
    return (
      (await callChatRpc<AgentActionRow[] | null>(
        this.client,
        'agent_reclaim_stuck_actions',
        { p_limit: limit },
      )) ?? []
    );
  }

  /**
   * An audit row only the backend knows about (`run.feedback`, `audit.exported`). Every other
   * event is written by the function that makes the change. The table is append-only.
   */
  async recordAudit(row: {
    organizationId: string;
    event: string;
    actorId: string;
    impersonatedBy?: string | null;
    runId?: string | null;
    actionId?: string | null;
    conversationId?: string | null;
    data: Record<string, unknown>;
  }): Promise<void> {
    const { error } = await this.client.from('agent_audit_events').insert({
      organization_id: row.organizationId,
      event: row.event,
      actor_id: row.actorId,
      impersonated_by: row.impersonatedBy ?? null,
      run_id: row.runId ?? null,
      ...(row.actionId && { action_id: row.actionId }),
      conversation_id: row.conversationId ?? null,
      data: row.data,
    });
    if (error)
      throw new Error(`Could not write the audit row: ${error.message}`);
  }

  /** The caller's private conversation with Robert, created on first use. */
  getOrCreateAgentDm(organizationId: string, userId: string): Promise<string> {
    return callChatRpc<string>(this.client, 'chat_get_or_create_agent_dm', {
      p_organization_id: organizationId,
      p_user_id: userId,
      p_agent_id: ROBERT_ID,
    });
  }

  // -------------------------------------------------------------------------
  // Object helpers
  // -------------------------------------------------------------------------

  /** Active organization members by name: exact matches first, then prefixes. */
  async findMembers(
    organizationId: string,
    name: string,
    limit?: number,
  ): Promise<AgentMemberMatch[]> {
    return (
      (await callChatRpc<AgentMemberMatch[] | null>(
        this.client,
        'agent_find_members',
        { p_organization_id: organizationId, p_name: name, p_limit: limit },
      )) ?? []
    );
  }

  /** Distinct labels used on tasks of a space. */
  async spaceLabels(
    organizationId: string,
    spaceId: string,
    limit?: number,
  ): Promise<string[]> {
    const rows = await callChatRpc<{ label: string }[] | null>(
      this.client,
      'agent_space_labels',
      {
        p_organization_id: organizationId,
        p_space_id: spaceId,
        p_limit: limit,
      },
    );

    return (rows ?? []).map((row) => row.label);
  }

  /**
   * Open objects with a similar title (duplicates). `scopeId` is the wiki parent,
   * the asset type or the plan; `identifiers` are unique asset attribute values.
   */
  async findSimilar(args: {
    organizationId: string;
    entityType: AgentEntityType | 'plan_item';
    spaceIds: string[];
    title: string;
    scopeId?: string | null;
    identifiers?: Record<string, unknown> | null;
    min?: number;
    limit?: number;
  }): Promise<AgentSimilarMatch[]> {
    return (
      (await callChatRpc<AgentSimilarMatch[] | null>(
        this.client,
        'agent_find_similar',
        {
          p_organization_id: args.organizationId,
          p_entity_type: args.entityType,
          p_space_ids: args.spaceIds,
          p_title: args.title,
          p_scope_id: args.scopeId ?? null,
          p_identifiers: args.identifiers ?? null,
          p_min: args.min,
          p_limit: args.limit,
        },
      )) ?? []
    );
  }

  /** What stops an undo; objects created by actions of `runId` do not count. */
  async undoBlockers(args: {
    organizationId: string;
    entityType: AgentEntityType;
    entityId: string;
    actorId: string;
    since: string;
    runId: string;
  }): Promise<AgentUndoBlocker[]> {
    return (
      (await callChatRpc<AgentUndoBlocker[] | null>(
        this.client,
        'agent_undo_blockers',
        {
          p_organization_id: args.organizationId,
          p_entity_type: args.entityType,
          p_entity_id: args.entityId,
          p_actor_id: args.actorId,
          p_since: args.since,
          p_run_id: args.runId,
        },
      )) ?? []
    );
  }

  /** Locks the page, re-reads the blockers and archives it only when there are none. */
  undoPage(args: {
    organizationId: string;
    pageId: string;
    actorId: string;
    since: string;
    runId: string;
  }): Promise<{ deleted: boolean; blockers: AgentUndoBlocker[] }> {
    return callChatRpc(this.client, 'agent_undo_wiki_page', {
      p_organization_id: args.organizationId,
      p_page_id: args.pageId,
      p_actor_id: args.actorId,
      p_since: args.since,
      p_run_id: args.runId,
    });
  }

  /** Locks the process, re-reads the blockers and removes it only when nothing is left under it. */
  undoProcess(args: {
    organizationId: string;
    processId: string;
    actorId: string;
    since: string;
    runId: string;
  }): Promise<{ deleted: boolean; blockers: AgentUndoBlocker[] }> {
    return callChatRpc(this.client, 'agent_undo_process', {
      p_organization_id: args.organizationId,
      p_process_id: args.processId,
      p_actor_id: args.actorId,
      p_since: args.since,
      p_run_id: args.runId,
    });
  }

  /** 1.22: locks the plan and the item's link, then the 1.21 task Undo (the link goes with the task). */
  undoPlanItem(args: {
    organizationId: string;
    taskId: string;
    actorId: string;
    since: string;
    runId: string;
  }): Promise<{ deleted: boolean; blockers: AgentUndoBlocker[] }> {
    return callChatRpc(this.client, 'agent_undo_plan_item', {
      p_organization_id: args.organizationId,
      p_task_id: args.taskId,
      p_actor_id: args.actorId,
      p_since: args.since,
      p_run_id: args.runId,
    });
  }

  /** 1.22: locks the plan, re-reads the blockers and removes it only when no item is left in it. */
  undoPlan(args: {
    organizationId: string;
    planId: string;
    actorId: string;
    since: string;
    runId: string;
  }): Promise<{ deleted: boolean; blockers: AgentUndoBlocker[] }> {
    return callChatRpc(this.client, 'agent_undo_plan', {
      p_organization_id: args.organizationId,
      p_plan_id: args.planId,
      p_actor_id: args.actorId,
      p_since: args.since,
      p_run_id: args.runId,
    });
  }

  /** What stops the Undo of these actions now, for the card. Only executed actions come back. */
  async undoState(
    organizationId: string,
    actorId: string,
    actionIds: string[],
  ): Promise<{ action_id: string; blockers: AgentUndoBlocker[] }[]> {
    return (
      (await callChatRpc<{ action_id: string; blockers: AgentUndoBlocker[] }[] | null>(
        this.client,
        'agent_undo_state',
        { p_organization_id: organizationId, p_actor_id: actorId, p_action_ids: actionIds },
      )) ?? []
    );
  }

  /** Locks the task, re-reads the blockers and deletes it only when there are none. */
  /** 1.22.1: an existing task into a plan; only the plan_tasks row, with the card's reserved id. */
  linkPlanTask(args: {
    organizationId: string;
    planId: string;
    taskId: string;
    linkId: string;
    itemType: string;
  }): Promise<{ linked: boolean; adopted?: boolean; reason?: string }> {
    return callChatRpc(this.client, 'agent_plan_link_add', {
      p_organization_id: args.organizationId,
      p_plan_id: args.planId,
      p_task_id: args.taskId,
      p_link_id: args.linkId,
      p_item_type: args.itemType,
    });
  }

  /** 1.22.1: one dependency of a card's item, checked and written under the plan lock. */
  addPlanDependency(args: {
    organizationId: string;
    planId: string;
    actionId: string;
    sourceTaskId: string;
    targetTaskId: string;
    typeName: string;
    /** 1.23: a plan_dependency card's own row, under the id the card reserved. */
    id?: string;
  }): Promise<{ created: boolean; adopted?: boolean; reason?: string; id?: string }> {
    return callChatRpc(this.client, 'agent_plan_dependency_add', {
      p_organization_id: args.organizationId,
      p_plan_id: args.planId,
      p_action_id: args.actionId,
      p_source_task: args.sourceTaskId,
      p_target_task: args.targetTaskId,
      p_type_name: args.typeName,
      ...(args.id && { p_id: args.id }),
    });
  }

  /** 1.23: a suggested risk, under the plan lock (archived, same name and owner checked again). */
  addPlanRisk(args: {
    organizationId: string;
    planId: string;
    riskId: string;
    actorId: string;
    fields: Record<string, unknown>;
  }): Promise<{ created: boolean; adopted?: boolean; reason?: string }> {
    return callChatRpc(this.client, 'agent_plan_risk_add', {
      p_organization_id: args.organizationId,
      p_plan_id: args.planId,
      p_risk_id: args.riskId,
      p_actor_id: args.actorId,
      p_fields: args.fields,
    });
  }

  /** 1.23: a suggested stakeholder, the same way. */
  addPlanStakeholder(args: {
    organizationId: string;
    planId: string;
    stakeholderId: string;
    fields: Record<string, unknown>;
  }): Promise<{ created: boolean; adopted?: boolean; reason?: string }> {
    return callChatRpc(this.client, 'agent_plan_stakeholder_add', {
      p_organization_id: args.organizationId,
      p_plan_id: args.planId,
      p_stakeholder_id: args.stakeholderId,
      p_fields: args.fields,
    });
  }

  /** 1.23: suggested dates on an item Robert made that has none (checked again under the plan lock). */
  setPlanDates(args: {
    organizationId: string;
    planId: string;
    actionId: string;
    taskId: string;
    start: string;
    end: string;
    duration: number;
  }): Promise<{ set: boolean; adopted?: boolean; reason?: string }> {
    return callChatRpc(this.client, 'agent_plan_dates_set', {
      p_organization_id: args.organizationId,
      p_plan_id: args.planId,
      p_action_id: args.actionId,
      p_task_id: args.taskId,
      p_start: args.start,
      p_end: args.end,
      p_duration: args.duration,
    });
  }

  /** 1.23: what a card found before it wrote (the baseline that was active), for its Undo. */
  async setBeforeValues(organizationId: string, actionId: string, values: Record<string, unknown>): Promise<void> {
    const { error } = await this.client
      .from('agent_actions')
      .update({ before_values: values })
      .eq('id', actionId)
      .eq('organization_id', organizationId);
    if (error) throw new Error(error.message);
  }

  /** 1.23: the Undo of a suggestion: under the plan lock, the rules again, then only its own row. */
  undoPlanSuggestion(args: {
    organizationId: string;
    kind: string;
    entityId: string;
    actorId: string;
    since: string;
    runId: string;
  }): Promise<{ deleted: boolean; blockers: AgentUndoBlocker[]; plan_id?: string }> {
    return callChatRpc(this.client, 'agent_undo_plan_suggestion', {
      p_organization_id: args.organizationId,
      p_kind: args.kind,
      p_entity_id: args.entityId,
      p_actor_id: args.actorId,
      p_since: args.since,
      p_run_id: args.runId,
    });
  }

  /** 1.22.1: Undo of a link: only its plan_tasks row goes, never the task. */
  undoPlanLink(args: {
    organizationId: string;
    linkId: string;
    actorId: string;
    since: string;
    runId: string;
  }): Promise<{ deleted: boolean; blockers: AgentUndoBlocker[]; plan_id?: string; task_id?: string }> {
    return callChatRpc(this.client, 'agent_undo_plan_link', {
      p_organization_id: args.organizationId,
      p_link_id: args.linkId,
      p_actor_id: args.actorId,
      p_since: args.since,
      p_run_id: args.runId,
    });
  }

  undoTask(args: {
    organizationId: string;
    taskId: string;
    actorId: string;
    since: string;
    runId: string;
  }): Promise<{ deleted: boolean; blockers: AgentUndoBlocker[] }> {
    return callChatRpc(this.client, 'agent_undo_task', {
      p_organization_id: args.organizationId,
      p_task_id: args.taskId,
      p_actor_id: args.actorId,
      p_since: args.since,
      p_run_id: args.runId,
    });
  }
}
