/**
 * @fileoverview The single access check for every chat endpoint.
 *
 * RLS is inert (service_role everywhere), so this service IS the tenant and
 * membership boundary for chat:
 *  - the organization always comes from the RequestUser, never from input;
 *  - DM/group: the caller needs a chat_members row;
 *  - space channel: the caller must be able to view the space (same rule as the
 *    space lists, `PermissionsService.getViewableSpaceIds`);
 *  - anything the caller may not read answers 404, so its existence never leaks.
 * @module src/chat/chat-access.service
 */

import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { ChatPermissionKey } from './chat-permission.guard';

export type ChatConversationKind = 'dm' | 'group' | 'space';

export interface ChatConversationRow {
  id: string;
  organization_id: string;
  kind: ChatConversationKind;
  space_id: string | null;
  title: string | null;
  description: string | null;
  dm_key: string | null;
  is_announcement: boolean;
  created_by: string | null;
  last_seq: number;
  last_message_at: string | null;
  archived_at: string | null;
  created_at: string;
}

export interface ChatMemberRow {
  conversation_id: string;
  user_id: string;
  role: 'owner' | 'member';
  notify_level: 'all' | 'mentions' | 'none';
  muted_until: string | null;
  /** Absent on a database without migration 20261012100000 (read as false). */
  mute_mentions?: boolean;
  last_read_seq: number;
  history_from_seq: number;
  pinned_at: string | null;
  joined_at: string;
}

export interface ChatMessageRow {
  id: string;
  organization_id: string;
  conversation_id: string;
  seq: number;
  /** `agent`: Robert's message (no author, no text, `metadata.run_id`). */
  kind: 'user' | 'system' | 'agent';
  author_id: string | null;
  body_html: string;
  body_text: string;
  thread_root_id: string | null;
  reply_count: number;
  last_reply_at: string | null;
  quoted_message_id: string | null;
  quote_snapshot: Record<string, unknown> | null;
  edit_count: number;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  pinned_at: string | null;
  pinned_by: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Columns of {@link ChatConversationRow}. */
export const CHAT_CONVERSATION_COLUMNS =
  'id, organization_id, kind, space_id, title, description, dm_key, is_announcement, created_by, last_seq, last_message_at, archived_at, created_at';

/** Columns of {@link ChatMessageRow}. */
export const CHAT_MESSAGE_COLUMNS =
  'id, organization_id, conversation_id, seq, kind, author_id, body_html, body_text, thread_root_id, reply_count, last_reply_at, quoted_message_id, quote_snapshot, edit_count, edited_at, deleted_at, deleted_by, pinned_at, pinned_by, metadata, created_at';

/** What a caller may read, resolved once per request. */
export interface ChatReadAccess {
  conversation: ChatConversationRow;
  /** The caller's own row; null for a space channel they never opened. */
  membership: ChatMemberRow | null;
  /** Messages with seq <= this are hidden from the caller ("from now on" members). */
  historyFromSeq: number;
}

@Injectable()
export class ChatAccessService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissionsService: PermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Loads a conversation the caller may read.
   *
   * @throws NotFoundException when it doesn't exist, belongs to another tenant or
   *   the caller may not read it
   */
  async getReadable(
    user: RequestUser,
    conversationId: string,
  ): Promise<ChatReadAccess> {
    const { data, error } = await this.client
      .from('chat_conversations')
      .select(CHAT_CONVERSATION_COLUMNS)
      .eq('id', conversationId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error)
      throw new InternalServerErrorException('Could not load conversation');
    if (!data) throw new NotFoundException('Conversation not found');

    const conversation = data as ChatConversationRow;
    const membership = await this.getMembership(conversationId, user);

    const allowed =
      conversation.kind === 'space'
        ? await this.canViewSpace(
            user.userId,
            user.organizationId,
            conversation.space_id,
          )
        : membership !== null;

    if (!allowed) throw new NotFoundException('Conversation not found');

    return {
      conversation,
      membership,
      historyFromSeq: membership?.history_from_seq ?? 0,
    };
  }

  /**
   * Loads a message the caller may read, together with its conversation access.
   *
   * @throws NotFoundException when the message is unknown, in another tenant, in a
   *   conversation the caller may not read, or before their history cut-off
   */
  async getReadableMessage(
    user: RequestUser,
    messageId: string,
  ): Promise<{ message: ChatMessageRow; access: ChatReadAccess }> {
    const { data, error } = await this.client
      .from('chat_messages')
      .select(CHAT_MESSAGE_COLUMNS)
      .eq('id', messageId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException('Could not load message');
    if (!data) throw new NotFoundException('Message not found');

    const message = data as ChatMessageRow;
    const access = await this.getReadable(user, message.conversation_id);

    if (message.seq <= access.historyFromSeq) {
      throw new NotFoundException('Message not found');
    }

    return { message, access };
  }

  /**
   * Access to the file attachments of a message (`file_attachments.entity_type =
   * 'chat_message'`), in the EntityContext shape the attachments service expects.
   *  - view: the message is readable and not deleted;
   *  - upload: the caller wrote it, it is a user message, not deleted, and the
   *    conversation is still writable;
   *  - delete: the author, or anyone holding `can_delete_any_chat_message`.
   * `spaceId` is the channel's space (null for DM/group), so space-channel files are
   * captured by space deletion.
   *
   * Chat files are served by the attachments controller, which carries neither the
   * chat permission guard nor `@ImpersonationBlocked()`, so both rules are enforced
   * here: `can_use_chat` for every action, and no upload or delete while impersonating.
   *
   * @throws NotFoundException when the message is not readable (or deleted, for view)
   * @throws ForbiddenException when the action is not allowed
   */
  async resolveAttachmentAccess(
    user: RequestUser,
    messageId: string,
    action: 'view' | 'upload' | 'delete',
  ): Promise<{
    organizationId: string;
    spaceId: string | null;
    ownerId: string | null;
    conversationId: string;
  }> {
    if (!(await this.hasPermission(user, 'can_use_chat'))) {
      throw new ForbiddenException('Insufficient permissions');
    }
    if (action !== 'view' && user.impersonation) {
      throw new ForbiddenException(
        'This action is not available during impersonation. Exit impersonation and try again as yourself.',
      );
    }

    const { message, access } = await this.getReadableMessage(user, messageId);
    const ctx = {
      organizationId: message.organization_id,
      spaceId: access.conversation.space_id,
      ownerId: message.author_id,
      conversationId: message.conversation_id,
    };
    const isAuthor = message.author_id === user.userId;

    if (action === 'view') {
      if (message.deleted_at) throw new NotFoundException('Message not found');
      return ctx;
    }

    if (action === 'upload') {
      if (!isAuthor || message.kind !== 'user' || message.deleted_at) {
        throw new ForbiddenException(
          'Only the author can attach files to this message',
        );
      }
      await this.assertWritable(access);
      return ctx;
    }

    if (
      isAuthor ||
      (await this.hasPermission(user, 'can_delete_any_chat_message'))
    ) {
      return ctx;
    }

    throw new ForbiddenException(
      'You do not have permission to delete this file',
    );
  }

  /**
   * Refuses writes (reactions, pins, settings) to an archived conversation or to
   * the channel of an archived or deleting space. The message RPCs enforce the
   * same rule themselves.
   *
   * @throws ForbiddenException when the conversation is read-only
   */
  async assertWritable(access: ChatReadAccess): Promise<void> {
    const { conversation } = access;

    if (conversation.archived_at) {
      throw new ForbiddenException('Conversation is archived');
    }

    if (conversation.kind !== 'space' || !conversation.space_id) return;

    const { data } = await this.client
      .from('spaces')
      .select('is_archived, deleting_at')
      .eq('id', conversation.space_id)
      .eq('organization_id', conversation.organization_id)
      .maybeSingle();

    const space = data as {
      is_archived: boolean | null;
      deleting_at: string | null;
    } | null;

    if (!space || space.is_archived || space.deleting_at) {
      throw new ForbiddenException('Space is archived or being deleted');
    }
  }

  /**
   * Whether another user may read a conversation. Used to decide who may be
   * notified about a message (someone outside the chat is never notified, and
   * neither is someone without `can_use_chat`: every chat route answers them 403).
   *
   * @returns the subset of `userIds` that may read the conversation
   */
  async filterReaders(
    conversation: ChatConversationRow,
    userIds: string[],
  ): Promise<string[]> {
    if (userIds.length === 0) return [];

    let readers: string[] = [];

    if (conversation.kind !== 'space') {
      const { data } = await this.client
        .from('chat_members')
        .select('user_id')
        .eq('conversation_id', conversation.id)
        .eq('organization_id', conversation.organization_id)
        .in('user_id', userIds);

      readers = ((data ?? []) as { user_id: string }[]).map(
        (row) => row.user_id,
      );
    } else {
      for (const userId of userIds) {
        if (
          await this.canViewSpace(
            userId,
            conversation.organization_id,
            conversation.space_id,
          )
        ) {
          readers.push(userId);
        }
      }
    }

    // Effective permissions are cached per user for a few seconds.
    const mayUseChat = await Promise.all(
      readers.map((userId) =>
        this.permissionsService.checkPermission(
          userId,
          conversation.organization_id,
          'can_use_chat',
        ),
      ),
    );

    return readers.filter((_, index) => mayUseChat[index]);
  }

  /**
   * Whether the caller holds an organization-level chat permission (ADM-08), for
   * the checks that cannot sit on a route (the routes use ChatPermissionGuard).
   */
  hasPermission(user: RequestUser, key: ChatPermissionKey): Promise<boolean> {
    return this.permissionsService.checkPermission(
      user.userId,
      user.organizationId,
      key,
    );
  }

  /**
   * Space ids the user may view, or null when they may view every space
   * (organization owner/admin).
   */
  getViewableSpaceIds(user: RequestUser): Promise<string[] | null> {
    return this.permissionsService.getViewableSpaceIds(
      user.userId,
      user.organizationId,
    );
  }

  /** Whether a user may view one space (the rule behind space channel access). */
  async canViewSpace(
    userId: string,
    organizationId: string,
    spaceId: string | null,
  ): Promise<boolean> {
    if (!spaceId) return false;

    const viewable = await this.permissionsService.getViewableSpaceIds(
      userId,
      organizationId,
      [spaceId],
    );

    return viewable === null || viewable.includes(spaceId);
  }

  private async getMembership(
    conversationId: string,
    user: RequestUser,
  ): Promise<ChatMemberRow | null> {
    const result = await this.client
      .from('chat_members')
      // '*' on purpose: the row gains mute_mentions with migration 20261012100000,
      // and every chat route must keep loading on a database without it.
      .select('*')
      .eq('conversation_id', conversationId)
      .eq('organization_id', user.organizationId)
      .eq('user_id', user.userId)
      .maybeSingle();

    if (result.error)
      throw new InternalServerErrorException('Could not load membership');

    return (result.data as ChatMemberRow | null) ?? null;
  }
}
