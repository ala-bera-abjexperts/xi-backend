/**
 * @fileoverview Who sees a Robert run (plan 2h). Pure. In 1.13 nothing from the workspace is
 * touched, so the audience depends on the conversation only; 1.14 narrows it by touched spaces
 * and objects (contract section 7).
 * @module src/chat-agent/agent-visibility
 */
import type { ChatConversationKind } from '../chat/chat-access.service';
import type {
  AgentRunStatus,
  AgentRunVisibility,
} from './agent-runs.repository';

/** A group larger than this keeps every run private to its invoker. */
export const MAX_SHARED_RUN_MEMBERS = 50;

/** The audience stored at finalize. A refused run is always the invoker's. */
export function runVisibility(input: {
  conversationKind: ChatConversationKind;
  isAgentDm: boolean;
  memberCount: number;
  refused: boolean;
}): 'invoker' | 'conversation' {
  if (input.refused) return 'invoker';
  if (input.conversationKind !== 'group' || input.isAgentDm) {
    return 'conversation';
  }
  return input.memberCount <= MAX_SHARED_RUN_MEMBERS
    ? 'conversation'
    : 'invoker';
}

/**
 * What one viewer gets of a run: the invoker always the full view; others the full view only
 * when the run is shared, they can read the conversation now and no context message lies at or
 * below their history cut-off ("from now on" members); otherwise the stub. A refused run is a
 * notice for its invoker only, and a viewer who cannot read the conversation gets nothing.
 */
export function canViewRun(input: {
  viewerId: string;
  invokerId: string | null;
  visibility: AgentRunVisibility;
  status: AgentRunStatus;
  viewerCanRead: boolean;
  viewerHistoryFromSeq: number;
  /** Lowest seq that entered the prompt; null when no message did. */
  contextMinSeq: number | null;
}): 'full' | 'stub' | 'none' {
  const isInvoker =
    input.invokerId !== null && input.viewerId === input.invokerId;
  if (isInvoker) return 'full';
  if (input.status === 'refused' || !input.viewerCanRead) return 'none';
  const seesContext =
    input.contextMinSeq === null ||
    input.viewerHistoryFromSeq < input.contextMinSeq;
  return input.visibility === 'conversation' && seesContext ? 'full' : 'stub';
}
