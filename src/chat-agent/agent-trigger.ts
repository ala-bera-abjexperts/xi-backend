/**
 * @fileoverview Whether a sent chat message starts a Robert run (plan 2a). Pure, so the chat
 * send path can ask it without importing ChatAgentModule.
 *
 * The caller passes the mention ids of the SANITIZED body (`extractUserMentionIds`): a quote is
 * its own row, so a mention inside a quote snapshot never counts. Edits never call this (BR-7).
 * @module src/chat-agent/agent-trigger
 */
import { isAgentDmKey, ROBERT_ID } from './agent.constants';

export interface RobertTriggerInput {
  /** `chat_messages.kind`; only `user` messages can trigger. */
  kind: string;
  /** False for Robert himself and for any other non-human author. */
  authorIsHuman: boolean;
  mentionIds: readonly string[];
  /** `chat_conversations.dm_key`; a Robert chat triggers on every message. */
  dmKey: string | null | undefined;
}

export function isRobertTrigger(input: RobertTriggerInput): boolean {
  if (input.kind !== 'user' || !input.authorIsHuman) return false;
  return (
    isAgentDmKey(input.dmKey?.toLowerCase()) ||
    input.mentionIds.some((id) => id.toLowerCase() === ROBERT_ID)
  );
}
