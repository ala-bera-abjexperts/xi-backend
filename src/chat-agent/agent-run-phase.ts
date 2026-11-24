/**
 * @fileoverview The phase of a completed run with proposals (XE-T353 1.14, plan B6). Pure.
 * A run without actions keeps the 1.13 phase from its status (agent-run-view.service).
 * @module src/chat-agent/agent-run-phase
 */
import type { AgentActionStatus } from './agent-runs.repository';

export type AgentProposalPhase =
  | 'executing'
  | 'needs_input'
  | 'proposed'
  | 'done'
  | 'partial'
  | 'expired'
  | 'cancelled'
  | 'undone'
  | 'partly_undone';

/**
 * Open = the invoker can still confirm it (a failed one by Retry, until its proposal expires: the
 * sweep expires proposed actions only, and a claim refuses an expired one anyway).
 */
export const isOpenAction = (
  status: AgentActionStatus,
  expiresAt?: string | null,
  now: number = Date.now(),
): boolean =>
  status === 'proposed' ||
  (status === 'failed' && (!expiresAt || Date.parse(expiresAt) > now));

/**
 * In this order: executing (or undoing) > needs_input (an open action that is not confirmable) >
 * proposed (any open) > undone (all that stood is undone) > partly_undone (some stayed) > done (all
 * executed) > partial (executed beside failed, cancelled or expired) > expired (all expired) >
 * cancelled.
 */
export function proposalPhase(
  actions: {
    status: AgentActionStatus;
    confirmable: boolean;
    expiresAt?: string | null;
  }[],
  now: number = Date.now(),
): AgentProposalPhase {
  const has = (status: AgentActionStatus) =>
    actions.some((a) => a.status === status);

  if (has('executing') || has('undoing')) return 'executing';
  const open = actions.filter((a) => isOpenAction(a.status, a.expiresAt, now));
  if (open.some((a) => !a.confirmable)) return 'needs_input';
  if (open.length > 0) return 'proposed';
  if (has('undone')) return has('executed') ? 'partly_undone' : 'undone';
  if (actions.every((a) => a.status === 'executed')) return 'done';
  if (has('executed')) return 'partial';
  if (
    actions.every(
      (a) => a.status === 'expired' || (a.status === 'failed' && !!a.expiresAt),
    )
  )
    return 'expired';
  return 'cancelled';
}
