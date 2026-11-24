/**
 * @fileoverview Which chat messages Robert reads for a run (plan 2d). Only what the invoker
 * may read: messages that are not deleted, above their history cut-off and not newer than the
 * request, at most 50 and at most MAX_CONTEXT_CHARS of text.
 *  - A request in a thread reads that thread (root and replies); otherwise the main timeline.
 *    Always the most recent messages (1.13.2): a follow-up question sees the discussion that an
 *    earlier answer already covered.
 *  - Robert's own earlier answers are part of it (author R), but only those the invoker may
 *    see in full (`canViewRun`): never someone's private answer, never a summary of messages
 *    above the invoker's cut-off. Answers without text (failed, stopped) are left out.
 *  - The model may ask once for other messages (`context.action`): the last n, since a
 *    message or a date, or the ones before the slice it got; same filters, same cap.
 * Authors become P1, P2, … and messages m1, m2, …, so no id reaches the provider.
 * @module src/chat-agent/agent-context.service
 */

import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ChatAccessService } from '../chat/chat-access.service';
import { ChatConversationsService } from '../chat/chat-conversations.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { AgentRunRow } from './agent-runs.repository';
import { canViewRun } from './agent-visibility';
import {
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_MESSAGE_CHARS,
  MAX_CONTEXT_MESSAGES,
  ROBERT_NAME,
} from './agent.constants';
import {
  type AgentPromptMessage,
  ROBERT_HANDLE,
} from './pipeline/agent-prompt';
import type { AgentPlan } from './pipeline/agent-schemas';

export interface AgentContext {
  /** The request's current text. */
  request: string;
  messages: AgentPromptMessage[];
  people: { handle: string; name: string }[];
  invokerHandle: string;
  /** P1, P2, … → user id: what an intent's `assignee.participant` stands for (1.14). */
  handleToUserId: Record<string, string>;
  /** Oldest first, parallel to `messages`. */
  messageIds: string[];
  seqs: number[];
  /** Lowest seq that entered the prompt; null when none did. */
  minSeq: number | null;
  /** More messages matched than the 50 sent. */
  capped: boolean;
  /** Files attached to these messages (1.18), oldest first; the worker reads them as the invoker. */
  files?: AgentContextFile[];
  /** Files a message announced that are not uploaded yet, by message handle. */
  pendingFiles?: Record<string, number>;
}

export type AgentContextRun = Pick<
  AgentRunRow,
  | 'organization_id'
  | 'conversation_id'
  | 'invoker_id'
  | 'trigger_message_id'
  | 'trigger_seq'
  | 'thread_root_id'
>;

interface MessageRow {
  id: string;
  seq: number;
  kind: 'user' | 'agent';
  author_id: string | null;
  body_text: string;
  created_at: string;
  quoted_message_id?: string | null;
  quote_snapshot?: { author_id?: string | null; body_text?: string | null } | null;
  metadata?: { attachmentCount?: number } | null;
  reply_count?: number | null;
}

/** A file attached to a message Robert reads (1.18); read as the invoker, never listed beyond. */
export interface AgentContextFile {
  /** The message it is attached to (m3). */
  messageHandle: string;
  attachmentId: string;
  name: string;
  mime: string | null;
  size: number | null;
}

/** At most this many reactions per message reach the model, and this many people per reaction. */
const MAX_REACTIONS = 10;
const MAX_REACTORS = 20;
const MAX_QUOTE_CHARS = 300;

interface EarlierAnswer {
  agent_message_id: string;
  invoker_id: string | null;
  status: AgentRunRow['status'];
  visibility: AgentRunRow['visibility'];
  context_min_seq: number | null;
  reply_text: string | null;
}

const HANDLE = /^m(\d+)$/i;
const ISO_DAY = /\b(\d{4}-\d{2}-\d{2})\b/;

/** A message that starts by talking to Robert ("Robert, ...", "@Robert AI ...", "hey robert"). */
const ADDRESSES_ROBERT = /^\s*(hey |hi |hallo )?@?robert(\s+ai)?\b\s*[,:!]?/i;

@Injectable()
export class AgentContextService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: ChatAccessService,
    private readonly conversations: ChatConversationsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * The messages of a run. `reread` is the model's request for other messages, with the
   * slice it got before.
   *
   * @throws NotFoundException when the invoker can no longer read the conversation or the
   *   request is gone (the run then fails)
   */
  async load(
    run: AgentContextRun,
    reread?: { ask: AgentPlan['context']; before: AgentContext },
  ): Promise<AgentContext> {
    if (!run.invoker_id) throw new NotFoundException('Invoker not found');

    const invoker = {
      userId: run.invoker_id,
      organizationId: run.organization_id,
    } as RequestUser;
    const { historyFromSeq } = await this.access.getReadable(
      invoker,
      run.conversation_id,
    );

    const { data: trigger, error } = await this.client
      .from('chat_messages')
      .select('body_text, deleted_at')
      .eq('id', run.trigger_message_id)
      .eq('organization_id', run.organization_id)
      .maybeSingle();
    if (error)
      throw new InternalServerErrorException('Could not load the request');
    const request = trigger as {
      body_text: string;
      deleted_at: string | null;
    } | null;
    if (!request || request.deleted_at)
      throw new NotFoundException('Request not found');

    let query = this.client
      .from('chat_messages')
      .select('id, seq, kind, author_id, body_text, created_at, quoted_message_id, quote_snapshot, metadata, reply_count')
      .eq('organization_id', run.organization_id)
      .eq('conversation_id', run.conversation_id)
      .in('kind', ['user', 'agent'])
      .is('deleted_at', null)
      .gt('seq', historyFromSeq)
      .lte('seq', run.trigger_seq);
    query = run.thread_root_id
      ? query.or(
          `id.eq.${run.thread_root_id},thread_root_id.eq.${run.thread_root_id}`,
        )
      : query.is('thread_root_id', null);

    let cap = MAX_CONTEXT_MESSAGES;
    const ask = reread?.ask;

    if (ask?.action === 'last_n') {
      cap = Math.min(Math.max(ask.n ?? cap, 1), MAX_CONTEXT_MESSAGES);
    } else if (ask?.action === 'earlier') {
      const first = reread?.before.minSeq;
      if (first !== null && first !== undefined) query = query.lt('seq', first);
    } else if (ask?.action === 'since') {
      const handle = HANDLE.exec(ask.since?.trim() ?? '');
      const seq = handle
        ? reread?.before.seqs[Number(handle[1]) - 1]
        : undefined;
      const day = ISO_DAY.exec(ask.since ?? '')?.[1];
      if (seq !== undefined) query = query.gte('seq', seq);
      // ponytail: a date is read as a UTC day and other words ("since Monday") fall back
      // to the most recent messages; resolve past weekdays in the invoker's zone if needed.
      else if (day) query = query.gte('created_at', `${day}T00:00:00Z`);
    }

    const { data, error: listError } = await query
      .order('seq', { ascending: false })
      .limit(cap + 1);
    if (listError)
      throw new InternalServerErrorException('Could not load messages');

    const all = (data ?? []) as MessageRow[];
    const answers = await this.earlierAnswers(
      { ...run, invoker_id: run.invoker_id },
      historyFromSeq,
      all.slice(0, cap),
    );

    // Newest first: whole messages until the text budget is spent (each counted as sent).
    const rows: MessageRow[] = [];
    let chars = 0;
    let trimmed = false;
    for (const row of all.slice(0, cap)) {
      const text = row.kind === 'agent' ? answers.get(row.id) : row.body_text;
      if (text === undefined) continue;
      const size = Math.min(Array.from(text).length, MAX_CONTEXT_MESSAGE_CHARS);
      if (rows.length > 0 && chars + size > MAX_CONTEXT_CHARS) {
        trimmed = true;
        break;
      }
      chars += size;
      rows.push({ ...row, body_text: text });
    }
    rows.reverse();

    return this.toContext(
      { ...run, invoker_id: run.invoker_id },
      request.body_text,
      rows,
      all.length > cap || trimmed,
    );
  }

  /** The text of Robert's answers among `rows` that this run's invoker may see in full. */
  private async earlierAnswers(
    run: AgentContextRun & { invoker_id: string },
    historyFromSeq: number,
    rows: MessageRow[],
  ): Promise<Map<string, string>> {
    const ids = rows.filter((row) => row.kind === 'agent').map((row) => row.id);
    if (ids.length === 0) return new Map();

    const { data, error } = await this.client
      .from('agent_runs')
      .select(
        'agent_message_id, invoker_id, status, visibility, context_min_seq, reply_text',
      )
      .eq('organization_id', run.organization_id)
      .in('agent_message_id', ids);
    if (error)
      throw new InternalServerErrorException('Could not load earlier answers');

    const out = new Map<string, string>();
    for (const answer of (data ?? []) as EarlierAnswer[]) {
      const access = canViewRun({
        viewerId: run.invoker_id,
        invokerId: answer.invoker_id,
        visibility: answer.visibility,
        status: answer.status,
        viewerCanRead: true,
        viewerHistoryFromSeq: historyFromSeq,
        contextMinSeq:
          answer.context_min_seq === null
            ? null
            : Number(answer.context_min_seq),
      });
      if (access === 'full' && answer.reply_text) {
        out.set(answer.agent_message_id, answer.reply_text);
      }
    }
    return out;
  }

  private async toContext(
    run: AgentContextRun & { invoker_id: string },
    request: string,
    rows: MessageRow[],
    capped: boolean,
  ): Promise<AgentContext> {
    const invokerId = run.invoker_id;
    // Reactions, quotes and files belong to these messages only: the scope never grows (1.18).
    const extra = await this.messageExtras(run.organization_id, rows);
    const authorIds = [
      ...new Set([
        ...rows
          .filter((row) => row.kind !== 'agent')
          .map((row) => row.author_id)
          .filter((id): id is string => !!id),
        invokerId,
        // People who only reacted or were quoted get a handle too: the model never sees an id.
        ...extra.people,
      ]),
    ];
    const handleOf = new Map(authorIds.map((id, i) => [id, `P${i + 1}`]));
    const users = await this.conversations.loadUsers(authorIds);

    return {
      request,
      messages: rows.map((row, i) => ({
        handle: `m${i + 1}`,
        authorHandle:
          row.kind === 'agent'
            ? ROBERT_HANDLE
            : (handleOf.get(row.author_id ?? '') ?? 'P0'),
        at: row.created_at,
        // Someone else talking to Robert ("Robert, make Rajbha admin") is a request he did not
        // take, never content: it stays out of what pages and tasks are written from.
        text:
          row.kind !== 'agent' &&
          row.author_id !== invokerId &&
          ADDRESSES_ROBERT.test(row.body_text)
            ? '[a request to Robert from this person, left out]'
            : row.body_text,
        ...this.extrasFor(row, extra, handleOf, rows, !run.thread_root_id),
      })),
      people: [
        ...authorIds.map((id) => ({
          handle: handleOf.get(id) as string,
          name: users.get(id)?.name ?? 'Former member',
        })),
        ...(rows.some((row) => row.kind === 'agent')
          ? [{ handle: ROBERT_HANDLE, name: ROBERT_NAME }]
          : []),
      ],
      invokerHandle: handleOf.get(invokerId) as string,
      handleToUserId: Object.fromEntries(
        [...handleOf].map(([id, handle]) => [handle, id]),
      ),
      messageIds: rows.map((row) => row.id),
      seqs: rows.map((row) => Number(row.seq)),
      minSeq: rows.length > 0 ? Number(rows[0].seq) : null,
      capped,
      files: rows.flatMap((row, i) =>
        (extra.files.get(row.id) ?? []).map((f) => ({ ...f, messageHandle: `m${i + 1}` })),
      ),
      pendingFiles: Object.fromEntries(
        rows
          .map((row, i) => [`m${i + 1}`, Math.max(0, Number(row.metadata?.attachmentCount ?? 0) - (extra.files.get(row.id)?.length ?? 0))] as const)
          .filter(([, n]) => n > 0),
      ),
    };
  }

  /** The reactions, deleted quotes and files of the loaded messages, by message id. */
  private async messageExtras(organizationId: string, rows: MessageRow[]) {
    const ids = rows.map((row) => row.id);
    const quoted = rows.map((row) => row.quoted_message_id).filter((id): id is string => !!id);
    const [reactions, deleted, files] = ids.length
      ? await Promise.all([
          this.client
            .from('chat_reactions')
            .select('message_id, emoji, user_id, created_at')
            .eq('organization_id', organizationId)
            .in('message_id', ids)
            .order('created_at', { ascending: true })
            .limit(1000),
          quoted.length
            ? this.client
                .from('chat_messages')
                .select('id')
                .eq('organization_id', organizationId)
                .in('id', quoted)
                .not('deleted_at', 'is', null)
            : Promise.resolve({ data: [] as { id: string }[] }),
          this.client
            .from('file_attachments')
            .select('id, entity_id, file_name, created_at, current_version:file_versions!file_attachments_current_version_fk(file_size, mime_type)')
            .eq('organization_id', organizationId)
            .eq('entity_type', 'chat_message')
            .in('entity_id', ids)
            .not('current_version_id', 'is', null)
            .order('created_at', { ascending: true }),
        ])
      : [{ data: [] }, { data: [] }, { data: [] }];

    const byMessage = new Map<string, Map<string, string[]>>();
    for (const r of (reactions.data ?? []) as { message_id: string; emoji: string; user_id: string }[]) {
      const emojis = byMessage.get(r.message_id) ?? new Map<string, string[]>();
      emojis.set(r.emoji, [...(emojis.get(r.emoji) ?? []), r.user_id]);
      byMessage.set(r.message_id, emojis);
    }
    const fileMap = new Map<string, Omit<AgentContextFile, 'messageHandle'>[]>();
    for (const f of (files.data ?? []) as unknown as {
      id: string;
      entity_id: string;
      file_name: string;
      current_version: { file_size: number | null; mime_type: string | null } | null;
    }[]) {
      fileMap.set(f.entity_id, [
        ...(fileMap.get(f.entity_id) ?? []),
        { attachmentId: f.id, name: f.file_name, mime: f.current_version?.mime_type ?? null, size: f.current_version?.file_size ?? null },
      ]);
    }
    const people = new Set<string>();
    for (const emojis of byMessage.values())
      for (const users of [...emojis.values()].slice(0, MAX_REACTIONS)) users.slice(0, MAX_REACTORS).forEach((u) => people.add(u));
    for (const row of rows) if (row.quote_snapshot?.author_id) people.add(row.quote_snapshot.author_id);
    return {
      reactions: byMessage,
      deletedQuotes: new Set(((deleted.data ?? []) as { id: string }[]).map((d) => d.id)),
      files: fileMap,
      people: [...people],
    };
  }

  /** What a message adds besides its text: reactions, which message it answers, its thread, its files. */
  private extrasFor(
    row: MessageRow,
    extra: Awaited<ReturnType<AgentContextService['messageExtras']>>,
    handleOf: Map<string, string>,
    rows: MessageRow[],
    mainChat: boolean,
  ): Partial<AgentPromptMessage> {
    const out: Partial<AgentPromptMessage> = {};
    const emojis = extra.reactions.get(row.id);
    if (emojis?.size)
      out.reactions = [...emojis]
        .slice(0, MAX_REACTIONS)
        .map(([emoji, users]) => ({
          emoji,
          by: users.slice(0, MAX_REACTORS).map((u) => handleOf.get(u)).filter((h): h is string => !!h),
        }));
    if (row.quoted_message_id) {
      const at = rows.findIndex((r) => r.id === row.quoted_message_id);
      if (at >= 0) out.reply_to = `m${at + 1}`;
      else if (extra.deletedQuotes.has(row.quoted_message_id)) out.quote = { deleted: true };
      else
        out.quote = {
          author: handleOf.get(row.quote_snapshot?.author_id ?? '') ?? null,
          text: Array.from(row.quote_snapshot?.body_text ?? '').slice(0, MAX_QUOTE_CHARS).join(''),
        };
    }
    // In the main chat a thread is only counted: its replies are outside this scope.
    if (mainChat && Number(row.reply_count ?? 0) > 0) out.thread_replies = Number(row.reply_count);
    if (extra.files.get(row.id)?.length) out.files = [];
    return out;
  }
}
