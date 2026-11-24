/**
 * @fileoverview Messages: timeline paging, send / edit / delete, edit history,
 * read position, reactions, pins and search (XE-T353 CHAT-05…17).
 *
 * Safety rules applied here:
 *  - html is sanitised on the server; `body_text` is derived from it (never trusted
 *    from the client);
 *  - a deleted message is returned as a tombstone without any content;
 *  - messages before the caller's "from now on" cut-off are never returned;
 *  - search goes through `chat_search_messages`, which works out what the caller may
 *    read; a hit that matched only by an object title needs that object to be visible.
 * @module src/chat/chat-messages.service
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { isRobertTrigger } from '../chat-agent/agent-trigger';
import { extractUserMentionIds } from '../common/utils/mention-extractor';
import { sanitizeRichText } from '../common/utils/sanitize-rich-text';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  CHAT_MESSAGE_COLUMNS,
  ChatAccessService,
  type ChatConversationRow,
  type ChatMessageRow,
} from './chat-access.service';
import {
  type ChatConversationLabel,
  ChatConversationsService,
} from './chat-conversations.service';
import { htmlToPlainText } from './chat-html';
import { ChatNotificationsService } from './chat-notifications.service';
import { ChatRealtimeService } from './chat-realtime.service';
import { ChatRefsService } from './chat-refs.service';
import { callChatRpc } from './chat-rpc-error';
import {
  type ChatSearchCursor,
  type ChatSnippetSegment,
  decodeSearchCursor,
  encodeSearchCursor,
  snippetSegments,
  splitSearchQuery,
} from './chat-search';
import type {
  ChatObjectRefDto,
  EditMessageDto,
  ListMessagesQueryDto,
  MarkReadDto,
  SearchMessagesQueryDto,
  SendMessageDto,
} from './dto/chat.dto';

const MAX_TEXT_LENGTH = 10000;
/** Rows read per extra search read, and how many such reads skip hidden hits. */
const SEARCH_READ_SIZE = 50;
const SEARCH_EXTRA_READS = 4;
/** Object refs whose visibility is checked in one go. */
const SEARCH_REF_CHECK_SIZE = 100;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The longest a send waits for Robert's run to start. */
const AFTER_SEND_LIMIT_MS = 2000;

/** The run a send started (contract 4.1); `messageId` null = refused. */
export interface AgentRunRef {
  id: string;
  messageId: string | null;
}

/** What the send path hands to Robert when a message asks for him. */
export interface ChatAfterSendContext {
  user: RequestUser;
  conversation: ChatConversationRow;
  messageId: string;
  /** The sender's IANA timezone (validated by the DTO). */
  timezone: string | null;
}

export interface ChatReactionSummary {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

export interface ChatAttachmentSummary {
  id: string;
  fileName: string;
  size: number | null;
  mimeType: string | null;
  createdAt: string;
}

export interface ChatMessageView {
  id: string;
  conversationId: string;
  seq: number;
  kind: 'user' | 'system' | 'agent';
  authorId: string | null;
  /** null for a deleted message: the content is retained but never returned. */
  bodyHtml: string | null;
  bodyText: string | null;
  threadRootId: string | null;
  replyCount: number;
  lastReplyAt: string | null;
  quote: {
    messageId: string;
    authorId: string | null;
    bodyText: string | null;
    createdAt: string | null;
    deleted: boolean;
  } | null;
  editCount: number;
  editedAt: string | null;
  deleted: boolean;
  deletedAt: string | null;
  /** true when someone other than the author (an administrator) deleted it. */
  deletedByModerator: boolean;
  pinnedAt: string | null;
  pinnedBy: string | null;
  /**
   * System-note event data (e.g. { event: 'member_left' }) or Robert's `{ run_id }`;
   * {} for user messages.
   */
  metadata: Record<string, unknown>;
  refs: { type: string; id: string }[];
  reactions: ChatReactionSummary[];
  /** Uploaded files (download via GET /attachments/:id/download). */
  attachments: ChatAttachmentSummary[];
  /** Files announced at send time (attachmentCount) that are not uploaded yet. */
  pendingAttachments: number;
  createdAt: string;
}

/** A timeline page; `hasNewer` and `anchor` only for a window around a message. */
export interface ChatMessagePage {
  messages: ChatMessageView[];
  hasMore: boolean;
  hasNewer?: boolean;
  /** The message that was asked for (not its thread root). */
  anchor?: { id: string; seq: number; threadRootId: string | null };
}

export interface ChatSearchHit {
  message: ChatMessageView;
  /** Named for the caller: a DM carries the other person's name. */
  conversation: ChatConversationLabel;
  authorName: string | null;
  matchedOn: 'text' | 'file' | 'object' | 'filter';
  /** Plain-text pieces of the match; [] unless matchedOn is 'text'. */
  snippet: ChatSnippetSegment[];
}

export interface ChatSearchResponse {
  hits: ChatSearchHit[];
  nextCursor: string | null;
  /** The messages of `hits`, kept for clients from before the hit list. */
  messages: ChatMessageView[];
}

/** A row of `chat_search_messages`. */
interface SearchRow {
  message_id: string;
  conversation_id: string;
  created_at: string;
  matched_on: ChatSearchHit['matchedOn'];
  snippet: string | null;
  /** The task / wiki page refs whose title or key matched (not permission-checked). */
  object_refs: { type: string; id: string }[] | null;
}

@Injectable()
export class ChatMessagesService {
  /** Starts Robert's run; filled by ChatAgentModule (it imports chat, never the reverse). */
  private afterSend:
    | ((ctx: ChatAfterSendContext) => Promise<AgentRunRef | null>)
    | null = null;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: ChatAccessService,
    private readonly notifications: ChatNotificationsService,
    private readonly realtime: ChatRealtimeService,
    private readonly refs: ChatRefsService,
    private readonly conversations: ChatConversationsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  setAfterSend(
    fn: (ctx: ChatAfterSendContext) => Promise<AgentRunRef | null>,
  ): void {
    this.afterSend = fn;
  }

  /**
   * One page of a conversation timeline (or of one thread).
   * - `aroundMessageId`: the window around one message;
   * - `afterSeq`: catch-up, messages newer than seq N, oldest first;
   * - otherwise the newest page, or the page before `beforeSeq`, returned oldest first.
   */
  async list(
    user: RequestUser,
    conversationId: string,
    query: ListMessagesQueryDto,
  ): Promise<ChatMessagePage> {
    if (query.aroundMessageId) {
      return this.listAround(
        user,
        conversationId,
        query.aroundMessageId,
        query,
      );
    }

    const { historyFromSeq } = await this.access.getReadable(
      user,
      conversationId,
    );
    const limit = query.limit ?? 50;

    let request = this.timeline(
      user,
      conversationId,
      historyFromSeq,
      query.threadRootId,
    );

    const ascending = query.afterSeq !== undefined;
    if (query.afterSeq !== undefined)
      request = request.gt('seq', query.afterSeq);
    if (query.beforeSeq !== undefined)
      request = request.lt('seq', query.beforeSeq);

    const { data, error } = await request
      .order('seq', { ascending })
      .limit(limit);
    if (error)
      throw new InternalServerErrorException('Could not load messages');

    const rows = (data ?? []) as ChatMessageRow[];
    if (!ascending) rows.reverse();

    return {
      messages: await this.toViews(user, rows),
      hasMore: rows.length === limit,
    };
  }

  /**
   * The window around one message: what a search hit, a mention link or a backlink
   * opens. The older half holds the centre, so `limit` 50 is 25 older, the centre and
   * 24 newer. A thread reply is centred on its thread root in the main timeline,
   * unless the thread itself is asked for (`threadRootId`).
   *
   * @throws BadRequestException together with `beforeSeq` or `afterSeq`
   * @throws NotFoundException when the caller may not read the message, or it is not
   *   in this conversation
   */
  private async listAround(
    user: RequestUser,
    conversationId: string,
    messageId: string,
    query: ListMessagesQueryDto,
  ): Promise<ChatMessagePage> {
    if (query.beforeSeq !== undefined || query.afterSeq !== undefined) {
      throw new BadRequestException(
        'aroundMessageId cannot be combined with beforeSeq or afterSeq',
      );
    }

    const { message, access } = await this.access.getReadableMessage(
      user,
      messageId,
    );
    if (message.conversation_id !== conversationId) {
      throw new NotFoundException('Message not found');
    }

    let centre = Number(message.seq);
    if (message.thread_root_id && !query.threadRootId) {
      // Only its position: a root from before the caller's cut-off stays hidden,
      // the window then starts at the first message they may read.
      const { data } = await this.client
        .from('chat_messages')
        .select('seq')
        .eq('id', message.thread_root_id)
        .eq('conversation_id', conversationId)
        .eq('organization_id', user.organizationId)
        .maybeSingle();
      centre = Number((data as { seq: number } | null)?.seq ?? centre);
    }

    const limit = query.limit ?? 50;
    const older = Math.floor(limit / 2);
    const newer = limit - 1 - older;
    const side = () =>
      this.timeline(
        user,
        conversationId,
        access.historyFromSeq,
        query.threadRootId,
      );
    // One row more than shown on each side tells whether that side goes on.
    const [before, after] = await Promise.all([
      side()
        .lte('seq', centre)
        .order('seq', { ascending: false })
        .limit(older + 2),
      side()
        .gt('seq', centre)
        .order('seq', { ascending: true })
        .limit(newer + 1),
    ]);
    if (before.error || after.error)
      throw new InternalServerErrorException('Could not load messages');

    const beforeRows = (before.data ?? []) as ChatMessageRow[];
    const afterRows = (after.data ?? []) as ChatMessageRow[];

    return {
      messages: await this.toViews(user, [
        ...beforeRows.slice(0, older + 1).reverse(),
        ...afterRows.slice(0, newer),
      ]),
      hasMore: beforeRows.length > older + 1,
      hasNewer: afterRows.length > newer,
      anchor: {
        id: message.id,
        seq: Number(message.seq),
        threadRootId: message.thread_root_id,
      },
    };
  }

  /**
   * The messages of one timeline the caller may read: the main one, or one thread.
   * `historyFromSeq` is their "from now on" cut-off.
   */
  private timeline(
    user: RequestUser,
    conversationId: string,
    historyFromSeq: number,
    threadRootId?: string,
  ) {
    const request = this.client
      .from('chat_messages')
      .select(CHAT_MESSAGE_COLUMNS)
      .eq('conversation_id', conversationId)
      .eq('organization_id', user.organizationId)
      .gt('seq', historyFromSeq);

    return threadRootId
      ? request.eq('thread_root_id', threadRootId)
      : request.is('thread_root_id', null);
  }

  /** Sends a message. Resending the same client id returns the stored message. */
  async send(
    user: RequestUser,
    conversationId: string,
    dto: SendMessageDto,
  ): Promise<ChatMessageView & { duplicate: boolean; agentRun?: AgentRunRef }> {
    const access = await this.access.getReadable(user, conversationId);
    const attachmentCount = dto.attachmentCount ?? 0;
    const body = this.prepareBody(
      dto.bodyHtml,
      dto.objectRefs,
      attachmentCount > 0,
    );

    // A quote stores a snapshot of the quoted text and a reply joins its thread:
    // neither may reach a message from before the caller's history cut-off.
    await Promise.all(
      [dto.quotedMessageId, dto.threadRootId]
        .filter((id): id is string => !!id)
        .map((id) => this.access.getReadableMessage(user, id)),
    );

    const args = {
      p_organization_id: user.organizationId,
      p_conversation_id: conversationId,
      p_message_id: dto.id,
      p_author_id: user.userId,
      p_body_html: body.html,
      p_body_text: body.text,
      p_thread_root_id: dto.threadRootId ?? null,
      p_quoted_message_id: dto.quotedMessageId ?? null,
      p_refs: body.refs,
      p_metadata: attachmentCount > 0 ? { attachmentCount } : {},
    };
    // Two sends of the same id can race: the loser fails on the primary key once
    // the winner has committed, so asking again returns the stored message as a
    // duplicate. A real conflict (id used elsewhere) simply fails a second time.
    const data = await callChatRpc(
      this.client,
      'chat_post_message',
      args,
    ).catch((err: unknown) => {
      if (!(err instanceof ConflictException)) throw err;
      return callChatRpc(this.client, 'chat_post_message', args);
    });

    const result = (
      (data ?? []) as {
        message_id: string;
        message_seq: number;
        duplicate: boolean;
      }[]
    )[0];
    if (!result)
      throw new InternalServerErrorException('Message was not stored');

    // A resend never signals or notifies twice.
    if (!result.duplicate) {
      const stored = {
        seq: Number(result.message_seq),
        threadRootId: dto.threadRootId ?? null,
      };

      void this.realtime.messageCreated(access.conversation, {
        messageId: result.message_id,
        ...stored,
      });
      // Also without mentions: a DM and a thread reply notify on their own.
      await this.notifications.onMessage(
        user,
        access.conversation,
        { id: result.message_id, ...stored },
        body.mentionIds,
      );
    }

    // Also for a resend: the start is idempotent, so a retry after a lost response
    // gets the same run back. Edits never start one (BR-7).
    const agentRun = isRobertTrigger({
      kind: 'user',
      authorIsHuman: true,
      mentionIds: body.mentionIds,
      dmKey: access.conversation.dm_key,
    })
      ? await this.startAgentRun({
          user,
          conversation: access.conversation,
          messageId: result.message_id,
          timezone: dto.timezone ?? null,
        })
      : null;

    return {
      ...(await this.getView(user, result.message_id)),
      duplicate: result.duplicate,
      ...(agentRun && { agentRun }),
    };
  }

  /**
   * Robert never fails a send and never delays it by more than two seconds: a slower
   * start goes on in the background and the client finds the run by its trigger.
   */
  private async startAgentRun(
    ctx: ChatAfterSendContext,
  ): Promise<AgentRunRef | null> {
    if (!this.afterSend) return null;

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.afterSend(ctx),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), AFTER_SEND_LIMIT_MS);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Edits the caller's own message; only newly added mentions are notified. */
  async edit(
    user: RequestUser,
    messageId: string,
    dto: EditMessageDto,
  ): Promise<ChatMessageView> {
    const { message, access } = await this.access.getReadableMessage(
      user,
      messageId,
    );
    const body = this.prepareBody(dto.bodyHtml, dto.objectRefs);

    const data = await callChatRpc(this.client, 'chat_edit_message', {
      p_organization_id: user.organizationId,
      p_message_id: messageId,
      p_editor_id: user.userId,
      p_body_html: body.html,
      p_body_text: body.text,
      p_refs: body.refs,
    });

    void this.realtime.messageUpdated(access.conversation.id, messageId);

    const newMentions = (data ?? []) as string[];
    if (newMentions.length > 0) {
      await this.notifications.onMessage(
        user,
        access.conversation,
        {
          id: messageId,
          seq: Number(message.seq),
          threadRootId: message.thread_root_id,
        },
        newMentions,
        true,
      );
    }

    return this.getView(user, messageId);
  }

  /**
   * Deletes a message (its author, or anyone holding `can_delete_any_chat_message`):
   * it becomes a tombstone.
   */
  async remove(
    user: RequestUser,
    messageId: string,
  ): Promise<{ deleted: boolean }> {
    const { message } = await this.access.getReadableMessage(user, messageId);

    const data = await callChatRpc(this.client, 'chat_delete_message', {
      p_organization_id: user.organizationId,
      p_message_id: messageId,
      p_actor_id: user.userId,
      p_can_delete_any: await this.access.hasPermission(
        user,
        'can_delete_any_chat_message',
      ),
    });

    if (data === true) {
      void this.realtime.messageDeleted(message.conversation_id, messageId);
    }

    return { deleted: data === true };
  }

  /** Every version of a message, oldest first; the last entry is the current text. */
  async versions(user: RequestUser, messageId: string) {
    const { message } = await this.access.getReadableMessage(user, messageId);

    // The edit history of a deleted message is retained for compliance only.
    if (message.deleted_at || message.kind !== 'user') {
      throw new NotFoundException('Message not found');
    }

    const { data, error } = await this.client
      .from('chat_message_versions')
      .select('version, body_html, body_text, edited_by, created_at')
      .eq('message_id', messageId)
      .eq('organization_id', user.organizationId)
      .order('version', { ascending: true });
    if (error)
      throw new InternalServerErrorException('Could not load versions');

    const previous = (data ?? []) as {
      version: number;
      body_html: string;
      body_text: string;
      edited_by: string | null;
      created_at: string;
    }[];

    // Row N was replaced at created_at by edited_by; version N's own timestamp is
    // the previous edit (or the message creation for version 1).
    const versions: {
      version: number;
      bodyHtml: string;
      bodyText: string;
      writtenAt: string;
      replacedAt: string | null;
      current: boolean;
    }[] = previous.map((row, index) => ({
      version: row.version,
      bodyHtml: row.body_html,
      bodyText: row.body_text,
      writtenAt:
        index === 0 ? message.created_at : previous[index - 1].created_at,
      replacedAt: row.created_at,
      current: false,
    }));

    versions.push({
      version: message.edit_count + 1,
      bodyHtml: message.body_html,
      bodyText: message.body_text,
      writtenAt: message.edited_at ?? message.created_at,
      replacedAt: null,
      current: true,
    });

    return { messageId, authorId: message.author_id, versions };
  }

  /** Moves the caller's read position (or back, for "mark as unread"). */
  async markRead(user: RequestUser, conversationId: string, dto: MarkReadDto) {
    await this.access.getReadable(user, conversationId);

    const data = await callChatRpc(this.client, 'chat_set_read_position', {
      p_organization_id: user.organizationId,
      p_conversation_id: conversationId,
      p_user_id: user.userId,
      p_seq: dto.seq,
      p_allow_backward: dto.markUnread === true,
    });

    const lastReadSeq = Number(data ?? 0);

    // What was read needs no bell entry, summary or email any more.
    await this.notifications.onRead(user, conversationId, lastReadSeq);

    return { lastReadSeq };
  }

  /** Adds the caller's reaction (idempotent). */
  async addReaction(user: RequestUser, messageId: string, emoji: string) {
    const reaction = this.validateEmoji(emoji);
    const { message, access } = await this.access.getReadableMessage(
      user,
      messageId,
    );
    this.assertInteractive(message);
    await this.access.assertWritable(access);

    const { error } = await this.client.from('chat_reactions').upsert(
      {
        message_id: messageId,
        organization_id: user.organizationId,
        user_id: user.userId,
        emoji: reaction,
      },
      { onConflict: 'message_id,user_id,emoji', ignoreDuplicates: true },
    );
    if (error) throw new InternalServerErrorException('Could not add reaction');

    void this.realtime.reactionChanged(message.conversation_id, messageId);

    return {
      reactions:
        (await this.loadReactions(user, [messageId])).get(messageId) ?? [],
    };
  }

  /** Removes the caller's reaction (idempotent). */
  async removeReaction(user: RequestUser, messageId: string, emoji: string) {
    const reaction = this.validateEmoji(emoji);
    const { message } = await this.access.getReadableMessage(user, messageId);

    const { error } = await this.client
      .from('chat_reactions')
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', user.userId)
      .eq('emoji', reaction)
      .eq('organization_id', user.organizationId);
    if (error)
      throw new InternalServerErrorException('Could not remove reaction');

    void this.realtime.reactionChanged(message.conversation_id, messageId);

    return {
      reactions:
        (await this.loadReactions(user, [messageId])).get(messageId) ?? [],
    };
  }

  /** Pins or unpins a message for everyone in the conversation. */
  async setPinned(user: RequestUser, messageId: string, pinned: boolean) {
    const { message, access } = await this.access.getReadableMessage(
      user,
      messageId,
    );
    this.assertInteractive(message);
    await this.access.assertWritable(access);

    const { error } = await this.client
      .from('chat_messages')
      .update(
        pinned
          ? { pinned_at: new Date().toISOString(), pinned_by: user.userId }
          : { pinned_at: null, pinned_by: null },
      )
      .eq('id', messageId)
      .eq('organization_id', user.organizationId);
    if (error) throw new InternalServerErrorException('Could not update pin');

    void this.realtime.messageUpdated(message.conversation_id, messageId);

    return this.getView(user, messageId);
  }

  /**
   * Search over everything the caller may read (CHAT-17): words, file names and the
   * titles of referenced tasks and wiki pages, narrowed by filters, newest first.
   * Deleted messages, system notes and messages before a member's history cut-off
   * never match; that and the tenant boundary are enforced by the database function.
   *
   * @throws BadRequestException without a search term and without a filter, or with
   *   a cursor this API did not hand out
   */
  async search(
    user: RequestUser,
    query: SearchMessagesQueryDto,
  ): Promise<ChatSearchResponse> {
    const limit = query.limit ?? 20;
    const { positive, negative } = splitSearchQuery(query.q ?? '');
    // A boolean filter narrows only when it is true.
    const filtered =
      !!(
        query.conversationId ||
        query.authorId ||
        query.from ||
        query.to ||
        query.objectType
      ) ||
      [
        query.hasAttachment,
        query.hasObject,
        query.pinned,
        query.mentionsMe,
      ].includes(true);

    if (!positive && !negative && !filtered) {
      throw new BadRequestException('Enter a search term or choose a filter');
    }

    let position = decodeSearchCursor(query.cursor);
    const args = {
      p_organization_id: user.organizationId,
      p_user_id: user.userId,
      // null = every space channel of the organization (its owners and admins).
      p_space_ids: await this.access.getViewableSpaceIds(user),
      p_q: positive || null,
      p_not: negative || null,
      p_conversation_id: query.conversationId ?? null,
      p_author_id: query.authorId ?? null,
      p_from: query.from ?? null,
      p_to: query.to ?? null,
      p_has_attachment: query.hasAttachment ?? null,
      p_has_object: query.hasObject ?? null,
      p_object_type: query.objectType ?? null,
      p_pinned: query.pinned ?? null,
      p_mentions_me: query.mentionsMe ?? null,
    };

    // chat_search_messages matches by object title only for objects in a space the
    // caller can view. What visibleHits() still drops are objects in such a space
    // that the caller may not open (module permission, wiki page access list).
    // A hidden hit must not show in the length of the page or in the cursor: either
    // would tell whether the title of an object the caller cannot open contains the
    // search term. So the search reads on until it holds one visible hit more than
    // the page, and the cursor points at the last hit that is returned.
    // ponytail: after SEARCH_EXTRA_READS extra reads (about 200 such hits in a row,
    // all in spaces the caller can view) the cursor is the read position instead,
    // which does show that hidden hits exist; check the module permission and the
    // page access list inside chat_search_messages to close that.
    const found: SearchRow[] = [];
    let more = true;

    for (
      let read = 0;
      more && found.length <= limit && read <= SEARCH_EXTRA_READS;
      read++
    ) {
      const size = read === 0 ? limit : SEARCH_READ_SIZE;
      const rows =
        (await callChatRpc<SearchRow[] | null>(
          this.client,
          'chat_search_messages',
          {
            ...args,
            p_before_created_at: position?.createdAt ?? null,
            p_before_id: position?.id ?? null,
            p_limit: size,
          },
        )) ?? [];
      const last = rows.at(-1);

      // The function returns one row more than asked for when there is more.
      more = rows.length > size;
      found.push(...(await this.visibleHits(user, rows)));
      if (last) position = { createdAt: last.created_at, id: last.message_id };
    }

    const page = found.slice(0, limit);
    const lastHit = page.at(-1);
    const next: ChatSearchCursor | null =
      found.length > limit && lastHit
        ? { createdAt: lastHit.created_at, id: lastHit.message_id }
        : more
          ? position
          : null;
    const hits = await this.toHits(user, page);

    return {
      hits,
      nextCursor: next ? encodeSearchCursor(next) : null,
      messages: hits.map((hit) => hit.message),
    };
  }

  /**
   * Drops the hits that matched only by the title of a referenced object, unless
   * the caller may open at least one of those objects (SEC-03): otherwise the hit
   * itself would give the title away.
   */
  private async visibleHits(
    user: RequestUser,
    rows: SearchRow[],
  ): Promise<SearchRow[]> {
    const byObject = rows.filter((row) => row.matched_on === 'object');
    if (byObject.length === 0) return rows;

    const refs = byObject.flatMap(
      (row) => row.object_refs ?? [],
    ) as ChatObjectRefDto[];
    const open = new Set<string>();

    // A message can carry 50 refs, and resolve() puts the ids into a query string.
    for (let i = 0; i < refs.length; i += SEARCH_REF_CHECK_SIZE) {
      const { results } = await this.refs.resolve(
        user,
        refs.slice(i, i + SEARCH_REF_CHECK_SIZE),
      );

      for (const result of results) {
        if (result.status === 'ok') open.add(`${result.type}:${result.id}`);
      }
    }

    return rows.filter(
      (row) =>
        row.matched_on !== 'object' ||
        (row.object_refs ?? []).some((ref) =>
          open.has(`${ref.type}:${ref.id}`),
        ),
    );
  }

  /** Search rows as hits: the message view, where it was said, by whom, and the match. */
  private async toHits(
    user: RequestUser,
    rows: SearchRow[],
  ): Promise<ChatSearchHit[]> {
    if (rows.length === 0) return [];

    const [messages, labels] = await Promise.all([
      this.client
        .from('chat_messages')
        .select(CHAT_MESSAGE_COLUMNS)
        .eq('organization_id', user.organizationId)
        .in(
          'id',
          rows.map((row) => row.message_id),
        )
        .is('deleted_at', null),
      this.conversations.labels(
        user,
        rows.map((row) => row.conversation_id),
      ),
    ]);
    if (messages.error) throw new InternalServerErrorException('Search failed');

    const stored = (messages.data ?? []) as ChatMessageRow[];
    const [views, authors] = await Promise.all([
      this.toViews(user, stored),
      this.conversations.loadUsers(
        stored.map((row) => row.author_id).filter((id): id is string => !!id),
      ),
    ]);
    const viewById = new Map(views.map((view) => [view.id, view]));

    // In the order of the search; a message deleted a moment ago is simply left out.
    return rows.flatMap((row): ChatSearchHit[] => {
      const message = viewById.get(row.message_id);
      const conversation = labels.get(row.conversation_id);
      if (!message || !conversation) return [];

      return [
        {
          message,
          conversation,
          authorName: authors.get(message.authorId ?? '')?.name ?? null,
          matchedOn: row.matched_on,
          snippet:
            row.matched_on === 'text' ? snippetSegments(row.snippet) : [],
        },
      ];
    });
  }

  /** Loads one message as a view (access already checked by the caller). */
  private async getView(
    user: RequestUser,
    messageId: string,
  ): Promise<ChatMessageView> {
    const { message } = await this.access.getReadableMessage(user, messageId);
    const [view] = await this.toViews(user, [message]);
    return view;
  }

  /**
   * Sanitises html, derives the text and collects mention + object refs. An empty
   * body is allowed only when files are announced (`hasAttachments`).
   */
  private prepareBody(
    bodyHtml: string,
    objectRefs: ChatObjectRefDto[] | undefined,
    hasAttachments = false,
  ) {
    const html = sanitizeRichText(bodyHtml, { allowTables: true }) ?? '';
    const text = htmlToPlainText(html);
    const objects = objectRefs ?? [];

    if (
      !text &&
      objects.length === 0 &&
      !hasAttachments &&
      !/<img\b/i.test(html)
    ) {
      throw new BadRequestException('Message is empty');
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new BadRequestException(
        `Message is too long (max ${MAX_TEXT_LENGTH} characters)`,
      );
    }

    // Malformed mention ids are ignored instead of failing the whole message.
    const mentionIds = extractUserMentionIds(html).filter((id) =>
      UUID_RE.test(id),
    );

    return {
      html,
      text,
      mentionIds,
      refs: [
        ...mentionIds.map((id) => ({ type: 'user', id })),
        ...objects.map((ref) => ({ type: ref.type, id: ref.id })),
      ],
    };
  }

  private assertInteractive(message: ChatMessageRow): void {
    if (message.deleted_at || message.kind !== 'user') {
      throw new BadRequestException('This message cannot be changed');
    }
  }

  private validateEmoji(emoji: string): string {
    const value = (emoji ?? '').trim();
    if (value.length === 0 || value.length > 64 || /\s/.test(value)) {
      throw new BadRequestException('Invalid reaction');
    }
    return value;
  }

  /** Maps rows to views: tombstones stripped, refs, reactions and quote state attached. */
  private async toViews(
    user: RequestUser,
    rows: ChatMessageRow[],
  ): Promise<ChatMessageView[]> {
    const live = rows.filter((row) => !row.deleted_at).map((row) => row.id);
    const quotedIds = rows
      .filter((row) => !row.deleted_at && row.quoted_message_id)
      .map((row) => row.quoted_message_id as string);

    const [refs, reactions, deletedQuotes, attachments] = await Promise.all([
      this.loadRefs(user, live),
      this.loadReactions(user, live),
      this.loadDeletedIds(user, quotedIds),
      this.loadAttachments(user, live),
    ]);

    return rows.map((row): ChatMessageView => {
      const deleted = !!row.deleted_at;
      const snapshot = row.quote_snapshot;
      const files = deleted ? [] : (attachments.get(row.id) ?? []);
      const announced = Number(row.metadata?.attachmentCount ?? 0) || 0;
      const quoteDeleted = row.quoted_message_id
        ? deletedQuotes.has(row.quoted_message_id)
        : false;

      return {
        id: row.id,
        conversationId: row.conversation_id,
        seq: Number(row.seq),
        kind: row.kind,
        authorId: row.author_id,
        bodyHtml: deleted ? null : row.body_html,
        bodyText: deleted ? null : row.body_text,
        threadRootId: row.thread_root_id,
        replyCount: row.reply_count,
        lastReplyAt: row.last_reply_at,
        quote:
          !deleted && row.quoted_message_id
            ? {
                messageId: row.quoted_message_id,
                authorId: quoteDeleted
                  ? null
                  : ((snapshot?.author_id as string | null) ?? null),
                // A quote of a message that was deleted later no longer shows its text.
                bodyText: quoteDeleted
                  ? null
                  : ((snapshot?.body_text as string | null) ?? null),
                createdAt: (snapshot?.created_at as string | null) ?? null,
                deleted: quoteDeleted,
              }
            : null,
        editCount: row.edit_count,
        editedAt: row.edited_at,
        deleted,
        deletedAt: row.deleted_at,
        deletedByModerator:
          deleted && !!row.deleted_by && row.deleted_by !== row.author_id,
        pinnedAt: deleted ? null : row.pinned_at,
        pinnedBy: deleted ? null : row.pinned_by,
        metadata: row.kind === 'user' ? {} : row.metadata,
        refs: deleted ? [] : (refs.get(row.id) ?? []),
        reactions: deleted ? [] : (reactions.get(row.id) ?? []),
        attachments: files,
        pendingAttachments:
          deleted || row.kind !== 'user'
            ? 0
            : Math.max(0, announced - files.length),
        createdAt: row.created_at,
      };
    });
  }

  private async loadRefs(
    user: RequestUser,
    messageIds: string[],
  ): Promise<Map<string, { type: string; id: string }[]>> {
    const result = new Map<string, { type: string; id: string }[]>();
    if (messageIds.length === 0) return result;

    const { data } = await this.client
      .from('chat_message_refs')
      .select('message_id, ref_type, ref_id')
      .eq('organization_id', user.organizationId)
      .in('message_id', messageIds);

    for (const row of (data ?? []) as {
      message_id: string;
      ref_type: string;
      ref_id: string;
    }[]) {
      const list = result.get(row.message_id) ?? [];
      list.push({ type: row.ref_type, id: row.ref_id });
      result.set(row.message_id, list);
    }

    return result;
  }

  /** Uploaded files of the given messages, oldest first (one query). */
  private async loadAttachments(
    user: RequestUser,
    messageIds: string[],
  ): Promise<Map<string, ChatAttachmentSummary[]>> {
    const result = new Map<string, ChatAttachmentSummary[]>();
    if (messageIds.length === 0) return result;

    const { data } = await this.client
      .from('file_attachments')
      .select(
        'id, entity_id, file_name, created_at, current_version:file_versions!file_attachments_current_version_fk(file_size, mime_type)',
      )
      .eq('entity_type', 'chat_message')
      .eq('organization_id', user.organizationId)
      .in('entity_id', messageIds)
      .not('current_version_id', 'is', null)
      .order('created_at', { ascending: true });

    for (const row of (data ?? []) as unknown as {
      id: string;
      entity_id: string;
      file_name: string;
      created_at: string;
      current_version: { file_size: number; mime_type: string } | null;
    }[]) {
      const list = result.get(row.entity_id) ?? [];
      list.push({
        id: row.id,
        fileName: row.file_name,
        size:
          row.current_version?.file_size != null
            ? Number(row.current_version.file_size)
            : null,
        mimeType: row.current_version?.mime_type ?? null,
        createdAt: row.created_at,
      });
      result.set(row.entity_id, list);
    }

    return result;
  }

  private async loadReactions(
    user: RequestUser,
    messageIds: string[],
  ): Promise<Map<string, ChatReactionSummary[]>> {
    const result = new Map<string, ChatReactionSummary[]>();
    if (messageIds.length === 0) return result;

    const { data } = await this.client
      .from('chat_reactions')
      .select('message_id, emoji, user_id')
      .eq('organization_id', user.organizationId)
      .in('message_id', messageIds)
      .order('created_at', { ascending: true });

    for (const row of (data ?? []) as {
      message_id: string;
      emoji: string;
      user_id: string;
    }[]) {
      const list = result.get(row.message_id) ?? [];
      let entry = list.find((item) => item.emoji === row.emoji);
      if (!entry) {
        entry = { emoji: row.emoji, count: 0, reactedByMe: false };
        list.push(entry);
      }
      entry.count += 1;
      entry.reactedByMe ||= row.user_id === user.userId;
      result.set(row.message_id, list);
    }

    return result;
  }

  private async loadDeletedIds(
    user: RequestUser,
    messageIds: string[],
  ): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set();

    const { data } = await this.client
      .from('chat_messages')
      .select('id')
      .eq('organization_id', user.organizationId)
      .in('id', [...new Set(messageIds)])
      .not('deleted_at', 'is', null);

    return new Set(((data ?? []) as { id: string }[]).map((row) => row.id));
  }
}
