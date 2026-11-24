/**
 * @fileoverview Conversations: the inbox, DMs, groups, space channels and group
 * membership (XE-T353 CHAT-01…04, 14, 18). Multi-row writes go through the
 * chat_* RPCs; every entry point resolves access via {@link ChatAccessService}.
 * @module src/chat/chat-conversations.service
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
// Constants only: this module never imports ChatAgentModule.
import {
  isAgentDmKey,
  ROBERT_ID,
  ROBERT_NAME,
} from '../chat-agent/agent.constants';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  ChatAccessService,
  type ChatConversationKind,
} from './chat-access.service';
import { ChatRealtimeService } from './chat-realtime.service';
import { callChatRpc } from './chat-rpc-error';
import type {
  AddMembersDto,
  CreateGroupDto,
  UpdateConversationDto,
  UpdateMyConversationStateDto,
} from './dto/chat.dto';

export interface ChatUserSummary {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface ChatSpaceSummary {
  id: string;
  name: string;
  key: string;
  icon: string | null;
  color: string | null;
}

export interface ChatInboxItem {
  id: string;
  kind: ChatConversationKind;
  /** Group title, the space name, or the other person's name for a DM. */
  title: string | null;
  counterpart: ChatUserSummary | null;
  space: ChatSpaceSummary | null;
  /**
   * The caller's private conversation with Robert: a DM with ONE member, like the
   * self-DM, but never "notes to self" (no counterpart, titled "Robert").
   */
  isAgentDm: boolean;
  isAnnouncement: boolean;
  lastSeq: number;
  lastReadSeq: number;
  unreadCount: number;
  mentionCount: number;
  muted: boolean;
  notifyLevel: string;
  pinnedAt: string | null;
  lastMessageAt: string | null;
  lastMessage: {
    id: string;
    authorId: string | null;
    authorName: string | null;
    kind: string;
    deleted: boolean;
    preview: string | null;
    /** Robert messages only: the state of his run (never the reply). */
    agentStatus?: AgentMessageStatus;
  } | null;
}

/** `proposed`: a finished run with a proposal still waiting for its invoker (1.14). */
export type AgentMessageStatus =
  | 'thinking'
  | 'done'
  | 'proposed'
  | 'cancelled'
  | 'failed';

/** A conversation as it is named for one caller (search hits). */
export interface ChatConversationLabel {
  id: string;
  kind: ChatConversationKind;
  /** '' when it has no name of its own (an unnamed group, a DM with a removed user). */
  title: string;
}

interface UnreadSummaryRow {
  conversation_id: string;
  kind: ChatConversationKind;
  title: string | null;
  space_id: string | null;
  dm_key: string | null;
  is_announcement: boolean;
  last_seq: number;
  last_read_seq: number;
  unread_count: number;
  mention_count: number;
  last_message_at: string | null;
  muted: boolean;
  pinned_at: string | null;
  notify_level: string;
  last_message_id: string | null;
  last_message_author_id: string | null;
  last_message_kind: string | null;
  last_message_deleted: boolean | null;
  last_message_preview: string | null;
}

interface UserRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

/** Ids per query when reading Robert's statuses for the inbox. */
const AGENT_STATUS_BATCH = 100;

@Injectable()
export class ChatConversationsService {
  private readonly logger = new Logger(ChatConversationsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: ChatAccessService,
    private readonly realtime: ChatRealtimeService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * The inbox: every open conversation of the caller with unread counts, mention
   * badges and a last-message preview. Space channel state is first synced with the
   * spaces the caller can currently view, so a lost space drops out immediately.
   */
  async listInbox(user: RequestUser): Promise<ChatInboxItem[]> {
    const viewable = await this.access.getViewableSpaceIds(user);

    // null = org owner/admin, who may view every space: they join channels by
    // opening them instead of being added to all of them.
    if (viewable !== null) {
      await callChatRpc(this.client, 'chat_sync_space_channel_members', {
        p_organization_id: user.organizationId,
        p_user_id: user.userId,
        p_space_ids: viewable,
      });
    }

    const data = await callChatRpc(this.client, 'chat_unread_summary', {
      p_organization_id: user.organizationId,
      p_user_id: user.userId,
    });

    const rows = (data ?? []) as UnreadSummaryRow[];
    const counterpartIds = new Map<string, string>();

    for (const row of rows) {
      if (row.kind === 'dm' && row.dm_key) {
        counterpartIds.set(
          row.conversation_id,
          this.dmCounterpart(row.dm_key, user.userId),
        );
      }
    }

    const userIds = [
      ...counterpartIds.values(),
      ...rows
        .map((row) => row.last_message_author_id)
        .filter((id): id is string => !!id),
    ];
    const spaceIds = rows
      .map((row) => row.space_id)
      .filter((id): id is string => !!id);
    const [users, spaces, agentStatuses] = await Promise.all([
      this.loadUsers(userIds),
      this.loadSpaces(user.organizationId, spaceIds),
      this.loadAgentStatuses(
        user.organizationId,
        rows
          .filter((row) => row.last_message_kind === 'agent')
          .map((row) => row.last_message_id)
          .filter((id): id is string => !!id),
      ),
    ]);

    return rows
      .map((row): ChatInboxItem => {
        const counterpart =
          users.get(counterpartIds.get(row.conversation_id) ?? '') ?? null;
        const space = row.space_id ? (spaces.get(row.space_id) ?? null) : null;
        const lastAuthor = users.get(row.last_message_author_id ?? '');
        const isAgentDm = isAgentDmKey(row.dm_key);

        return {
          id: row.conversation_id,
          kind: row.kind,
          title: isAgentDm
            ? ROBERT_NAME
            : row.kind === 'dm'
              ? (counterpart?.name ?? null)
              : row.kind === 'space'
                ? (space?.name ?? null)
                : row.title,
          counterpart,
          space,
          isAgentDm,
          isAnnouncement: row.is_announcement,
          lastSeq: Number(row.last_seq),
          lastReadSeq: Number(row.last_read_seq),
          unreadCount: Number(row.unread_count),
          mentionCount: Number(row.mention_count),
          muted: row.muted,
          notifyLevel: row.notify_level,
          pinnedAt: row.pinned_at,
          lastMessageAt: row.last_message_at,
          lastMessage: row.last_message_id
            ? {
                id: row.last_message_id,
                authorId: row.last_message_author_id,
                authorName: lastAuthor?.name ?? null,
                kind: row.last_message_kind ?? 'user',
                deleted: row.last_message_deleted === true,
                preview: row.last_message_preview,
                ...(row.last_message_kind === 'agent' && {
                  agentStatus:
                    agentStatuses.get(row.last_message_id) ?? 'failed',
                }),
              }
            : null,
        };
      })
      .sort((a, b) => {
        if (!!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1;
        return (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '');
      });
  }

  /** Opens (or creates) the DM with another member of the caller's organization. */
  async openDm(user: RequestUser, otherUserId: string) {
    // Robert is not a person: his conversation has one member and its own route.
    if (otherUserId.toLowerCase() === ROBERT_ID) {
      throw new BadRequestException(
        'Use POST /chat/agent/dm to open the conversation with Robert',
      );
    }

    const data = await callChatRpc(this.client, 'chat_get_or_create_dm', {
      p_organization_id: user.organizationId,
      p_user_id: user.userId,
      p_other_user_id: otherUserId,
    });

    void this.realtime.inboxChanged(data as string, user.organizationId);

    return this.getConversation(user, data as string);
  }

  /** Creates a group; the caller becomes its owner. */
  async createGroup(user: RequestUser, dto: CreateGroupDto) {
    const data = await callChatRpc(this.client, 'chat_create_group', {
      p_organization_id: user.organizationId,
      p_creator_id: user.userId,
      p_title: dto.title ?? null,
      p_member_ids: dto.memberIds,
    });

    void this.realtime.inboxChanged(data as string, user.organizationId);

    return this.getConversation(user, data as string);
  }

  /** The channel of a space the caller can view, created on first use. */
  async getSpaceChannel(user: RequestUser, spaceId: string) {
    if (
      !(await this.access.canViewSpace(
        user.userId,
        user.organizationId,
        spaceId,
      ))
    ) {
      throw new NotFoundException('Space not found');
    }

    const data = await callChatRpc(
      this.client,
      'chat_get_or_create_space_channel',
      {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
      },
    );

    return this.getConversation(user, data as string);
  }

  /** Conversation details, the caller's own state and (DM/group) the member list. */
  async getConversation(user: RequestUser, conversationId: string) {
    const { conversation, membership } = await this.access.getReadable(
      user,
      conversationId,
    );

    let members: Array<ChatUserSummary & { role: string; joinedAt: string }> =
      [];

    if (conversation.kind !== 'space') {
      const { data, error } = await this.client
        .from('chat_members')
        .select('user_id, role, joined_at')
        .eq('conversation_id', conversation.id)
        .eq('organization_id', user.organizationId)
        .order('joined_at', { ascending: true });
      if (error)
        throw new InternalServerErrorException('Could not load members');

      const rows = (data ?? []) as {
        user_id: string;
        role: string;
        joined_at: string;
      }[];
      const users = await this.loadUsers(rows.map((row) => row.user_id));

      members = rows.map((row) => ({
        ...(users.get(row.user_id) ?? {
          id: row.user_id,
          name: 'Former member',
          email: null,
          avatarUrl: null,
        }),
        role: row.role,
        joinedAt: row.joined_at,
      }));
    }

    const space = conversation.space_id
      ? ((
          await this.loadSpaces(user.organizationId, [conversation.space_id])
        ).get(conversation.space_id) ?? null)
      : null;
    const counterpart =
      conversation.kind === 'dm' && conversation.dm_key
        ? (members.find(
            (m) =>
              m.id ===
              this.dmCounterpart(conversation.dm_key as string, user.userId),
          ) ?? null)
        : null;
    const isAgentDm = isAgentDmKey(conversation.dm_key);

    return {
      id: conversation.id,
      kind: conversation.kind,
      title: isAgentDm
        ? ROBERT_NAME
        : conversation.kind === 'dm'
          ? (counterpart?.name ?? null)
          : conversation.kind === 'space'
            ? (space?.name ?? null)
            : conversation.title,
      description: conversation.description,
      space,
      counterpart,
      isAgentDm,
      isAnnouncement: conversation.is_announcement,
      archivedAt: conversation.archived_at,
      lastSeq: Number(conversation.last_seq),
      createdAt: conversation.created_at,
      me: membership
        ? {
            role: membership.role,
            notifyLevel: membership.notify_level,
            mutedUntil: membership.muted_until,
            muteMentions: membership.mute_mentions === true,
            lastReadSeq: Number(membership.last_read_seq),
            historyFromSeq: Number(membership.history_from_seq),
            pinnedAt: membership.pinned_at,
          }
        : null,
      members,
    };
  }

  /** Renames a group or changes its description (group owners only). */
  async updateConversation(
    user: RequestUser,
    conversationId: string,
    dto: UpdateConversationDto,
  ) {
    const access = await this.access.getReadable(user, conversationId);

    if (access.conversation.kind !== 'group') {
      throw new BadRequestException('Only groups can be renamed');
    }
    if (access.membership?.role !== 'owner') {
      throw new ForbiddenException('Only group owners can change the group');
    }
    await this.access.assertWritable(access);

    const patch: Record<string, string | null> = {};
    if (dto.title !== undefined) patch.title = dto.title.trim() || null;
    if (dto.description !== undefined)
      patch.description = dto.description.trim() || null;

    if (Object.keys(patch).length > 0) {
      const { error } = await this.client
        .from('chat_conversations')
        .update(patch)
        .eq('id', conversationId)
        .eq('organization_id', user.organizationId);
      if (error)
        throw new InternalServerErrorException('Could not update conversation');

      void this.realtime.conversationChanged(
        conversationId,
        user.organizationId,
      );
    }

    return this.getConversation(user, conversationId);
  }

  /** The caller's own notification level, mute, mention break-through and inbox pin. */
  async updateMyState(
    user: RequestUser,
    conversationId: string,
    dto: UpdateMyConversationStateDto,
  ) {
    const access = await this.access.getReadable(user, conversationId);

    // A space channel the caller never opened has no state row yet: creating it via
    // the read-position RPC also starts them "caught up".
    if (!access.membership) {
      await callChatRpc(this.client, 'chat_set_read_position', {
        p_organization_id: user.organizationId,
        p_conversation_id: conversationId,
        p_user_id: user.userId,
        p_seq: access.conversation.last_seq,
        p_allow_backward: false,
      });
    }

    const patch: Record<string, string | boolean | null> = {};
    if (dto.notifyLevel !== undefined) patch.notify_level = dto.notifyLevel;
    if (dto.mutedUntil !== undefined) patch.muted_until = dto.mutedUntil;
    if (dto.muteMentions !== undefined) patch.mute_mentions = dto.muteMentions;
    if (dto.pinned !== undefined)
      patch.pinned_at = dto.pinned ? new Date().toISOString() : null;

    if (Object.keys(patch).length > 0) {
      const { error } = await this.client
        .from('chat_members')
        .update(patch)
        .eq('conversation_id', conversationId)
        .eq('user_id', user.userId)
        .eq('organization_id', user.organizationId);
      if (error)
        throw new InternalServerErrorException('Could not update settings');
    }

    return this.getConversation(user, conversationId);
  }

  /** Adds people to a group. Returns how many were actually added. */
  async addMembers(
    user: RequestUser,
    conversationId: string,
    dto: AddMembersDto,
  ) {
    await this.access.getReadable(user, conversationId);

    const data = await callChatRpc(this.client, 'chat_add_members', {
      p_organization_id: user.organizationId,
      p_conversation_id: conversationId,
      p_actor_id: user.userId,
      p_user_ids: dto.userIds,
      p_full_history: dto.fullHistory ?? true,
      // ADM-05 "members may add members" becomes a tenant setting; default yes.
      p_members_can_add: true,
    });

    void this.realtime.conversationChanged(conversationId, user.organizationId);

    return { added: Number(data ?? 0) };
  }

  /** An owner removes another member from a group. */
  async removeMember(
    user: RequestUser,
    conversationId: string,
    memberId: string,
  ) {
    await this.access.getReadable(user, conversationId);

    await callChatRpc(this.client, 'chat_remove_member', {
      p_organization_id: user.organizationId,
      p_conversation_id: conversationId,
      p_actor_id: user.userId,
      p_user_id: memberId,
    });

    void this.realtime.conversationChanged(
      conversationId,
      user.organizationId,
      [memberId],
    );
  }

  /** An owner promotes or demotes a member. */
  async setMemberRole(
    user: RequestUser,
    conversationId: string,
    memberId: string,
    role: 'owner' | 'member',
  ) {
    await this.access.getReadable(user, conversationId);

    await callChatRpc(this.client, 'chat_set_member_role', {
      p_organization_id: user.organizationId,
      p_conversation_id: conversationId,
      p_actor_id: user.userId,
      p_user_id: memberId,
      p_role: role,
    });

    void this.realtime.conversationChanged(conversationId, user.organizationId);
  }

  /** The caller leaves a group. */
  async leave(user: RequestUser, conversationId: string) {
    await this.access.getReadable(user, conversationId);

    await callChatRpc(this.client, 'chat_leave', {
      p_organization_id: user.organizationId,
      p_conversation_id: conversationId,
      p_user_id: user.userId,
    });

    void this.realtime.conversationChanged(
      conversationId,
      user.organizationId,
      [user.userId],
    );
  }

  /**
   * Kind and title of conversations as the caller sees them: a DM carries the other
   * person's name, a channel the name of its space. Access is the caller's job.
   */
  async labels(
    user: RequestUser,
    conversationIds: string[],
  ): Promise<Map<string, ChatConversationLabel>> {
    const ids = [...new Set(conversationIds)];
    if (ids.length === 0) return new Map();

    const { data, error } = await this.client
      .from('chat_conversations')
      .select('id, kind, title, space_id, dm_key')
      .eq('organization_id', user.organizationId)
      .in('id', ids);
    if (error)
      throw new InternalServerErrorException('Could not load conversations');

    const rows = (data ?? []) as {
      id: string;
      kind: ChatConversationKind;
      title: string | null;
      space_id: string | null;
      dm_key: string | null;
    }[];
    const counterpartOf = (row: (typeof rows)[number]) =>
      row.kind === 'dm' && row.dm_key
        ? this.dmCounterpart(row.dm_key, user.userId)
        : '';
    const [users, spaces] = await Promise.all([
      this.loadUsers(rows.map(counterpartOf).filter(Boolean)),
      this.loadSpaces(
        user.organizationId,
        rows.map((row) => row.space_id).filter((id): id is string => !!id),
      ),
    ]);

    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          kind: row.kind,
          title:
            (isAgentDmKey(row.dm_key)
              ? ROBERT_NAME
              : row.kind === 'dm'
                ? users.get(counterpartOf(row))?.name
                : row.kind === 'space'
                  ? spaces.get(row.space_id ?? '')?.name
                  : row.title) ?? '',
        },
      ]),
    );
  }

  /** Loads display data for users; missing (deleted) users are simply absent. */
  async loadUsers(userIds: string[]): Promise<Map<string, ChatUserSummary>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();

    const { data } = await this.client
      .from('users')
      .select('id, first_name, last_name, email, avatar_url')
      .in('id', ids);

    return new Map(
      ((data ?? []) as UserRow[]).map((row) => [
        row.id,
        {
          id: row.id,
          name:
            `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() ||
            row.email ||
            'Unknown user',
          email: row.email,
          avatarUrl: row.avatar_url,
        },
      ]),
    );
  }

  private async loadSpaces(
    organizationId: string,
    spaceIds: string[],
  ): Promise<Map<string, ChatSpaceSummary>> {
    const ids = [...new Set(spaceIds)];
    if (ids.length === 0) return new Map();

    const { data } = await this.client
      .from('spaces')
      .select('id, name, key, icon, color')
      .eq('organization_id', organizationId)
      .in('id', ids);

    return new Map(
      ((data ?? []) as ChatSpaceSummary[]).map((row) => [row.id, row]),
    );
  }

  /**
   * The run state behind Robert's inbox previews: one read of agent_runs (and one of
   * agent_actions when a run finished), not an import of the agent module (which imports this one).
   */
  private async loadAgentStatuses(
    organizationId: string,
    messageIds: string[],
  ): Promise<Map<string, AgentMessageStatus>> {
    const ids = [...new Set(messageIds)];
    if (ids.length === 0) return new Map();

    // In batches: a few hundred ids in one .in() make the URL too long, and the request fails.
    const rows: { id: string; agent_message_id: string; status: string }[] = [];
    for (let at = 0; at < ids.length; at += AGENT_STATUS_BATCH) {
      const { data, error } = await this.client
        .from('agent_runs')
        .select('id, agent_message_id, status')
        .eq('organization_id', organizationId)
        .in('agent_message_id', ids.slice(at, at + AGENT_STATUS_BATCH));
      // A label in the inbox is not worth failing the inbox for.
      if (error) this.logger.warn(`Robert statuses not read: ${error.message}`);
      rows.push(...((data ?? []) as typeof rows));
    }

    // One more read, only when a run finished: which of them still wait for a Confirm.
    const completed = rows.filter((row) => row.status === 'completed');
    const open = new Set<string>();
    for (let at = 0; at < completed.length; at += AGENT_STATUS_BATCH) {
      const { data: actions, error } = await this.client
        .from('agent_actions')
        .select('run_id')
        .eq('organization_id', organizationId)
        .in(
          'run_id',
          completed.slice(at, at + AGENT_STATUS_BATCH).map((row) => row.id),
        )
        .in('status', ['proposed', 'failed']);
      if (error) this.logger.warn(`Robert proposals not read: ${error.message}`);
      for (const row of (actions ?? []) as { run_id: string }[])
        open.add(row.run_id);
    }

    const state = (row: { id: string; status: string }): AgentMessageStatus =>
      row.status === 'queued' || row.status === 'running'
        ? 'thinking'
        : row.status === 'completed'
          ? open.has(row.id)
            ? 'proposed'
            : 'done'
          : row.status === 'cancelled'
            ? 'cancelled'
            : 'failed';

    return new Map(rows.map((row) => [row.agent_message_id, state(row)]));
  }

  /** The other participant of a DM key "a:b" (yourself for a self-DM). */
  private dmCounterpart(dmKey: string, userId: string): string {
    const [a, b] = dmKey.split(':');
    return a === userId ? b : a;
  }
}
