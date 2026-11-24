/**
 * @fileoverview Chat realtime (XE-T353 step 2): signals over Supabase Realtime private
 * channels, and the short-lived JWT that lets a client join them.
 *
 * Signals carry ids only; clients re-fetch through the API, which applies access.
 * Topics (authorized by the `chat_topics` JWT claim, migration
 * 20260928120200_chat_realtime_authorization.sql):
 *  - `chat:<conversationId>`: message.created / message.updated / message.deleted /
 *    reaction.changed / conversation.changed / agent.run.updated
 *  - `chat-user:<userId>`: agent.run.updated of a run only its invoker may see
 *  - `chat-user:<userId>`: inbox.changed (DM and group members, and the members of a
 *    space channel with at most 500 member rows; larger channels have no per-user
 *    fan-out and rely on the inbox poll)
 *
 * Broadcasting is best-effort: it logs and never throws, so a Realtime outage can
 * never fail a chat write.
 * @module src/chat/chat-realtime.service
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  ChatAccessService,
  type ChatConversationKind,
} from './chat-access.service';

/** Realtime token lifetime (seconds), same as the wiki collab token. */
const TOKEN_TTL_SECONDS = 600;
const BROADCAST_TIMEOUT_MS = 5000;
/** A group cannot be larger; a space channel above it gets no per-user signal. */
const INBOX_FANOUT_MAX = 500;

export interface ChatRealtimeMessage {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class ChatRealtimeService {
  private readonly logger = new Logger(ChatRealtimeService.name);
  private readonly supabaseUrl: string;
  private readonly serviceRoleKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: ChatAccessService,
    private readonly jwtService: JwtService,
  ) {
    this.supabaseUrl = this.configService
      .get<string>('SUPABASE_URL', '')
      .replace(/\/$/, '');
    this.serviceRoleKey = this.configService.get<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
      '',
    );
  }

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Sends every message in ONE request. Never throws. */
  async broadcast(messages: ChatRealtimeMessage[]): Promise<void> {
    if (messages.length === 0 || !this.supabaseUrl || !this.serviceRoleKey)
      return;

    try {
      const res = await fetch(`${this.supabaseUrl}/realtime/v1/api/broadcast`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.serviceRoleKey}`,
          apikey: this.serviceRoleKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: messages.map((m) => ({ ...m, private: true })),
        }),
        signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
      });

      if (!res.ok) {
        this.logger.warn(
          `[Broadcast] HTTP ${res.status} for ${messages.length} chat signal(s)`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[Broadcast] Failed for ${messages.length} chat signal(s): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async messageCreated(
    conversation: {
      id: string;
      kind: ChatConversationKind;
      organization_id: string;
    },
    message: { messageId: string; seq: number; threadRootId: string | null },
  ): Promise<void> {
    const signal = this.conversationSignal(conversation.id, 'message.created', {
      messageId: message.messageId,
      seq: message.seq,
      threadRootId: message.threadRootId,
    });
    // Space channels too, or their unread badges lag until the next inbox poll.
    const inbox = await this.inboxSignals(
      conversation.id,
      conversation.organization_id,
    );

    await this.broadcast([signal, ...inbox]);
  }

  messageUpdated(conversationId: string, messageId: string): Promise<void> {
    return this.broadcast([
      this.conversationSignal(conversationId, 'message.updated', { messageId }),
    ]);
  }

  messageDeleted(conversationId: string, messageId: string): Promise<void> {
    return this.broadcast([
      this.conversationSignal(conversationId, 'message.deleted', { messageId }),
    ]);
  }

  reactionChanged(conversationId: string, messageId: string): Promise<void> {
    return this.broadcast([
      this.conversationSignal(conversationId, 'reaction.changed', {
        messageId,
      }),
    ]);
  }

  /**
   * A Robert run changed (contract section 6). A run still thinking (`pending`), a
   * shared run and the moment the audience is decided go to the conversation; a run
   * private to its invoker otherwise goes only to them. Ids only: clients refetch it.
   */
  agentRunUpdated(
    run: {
      conversationId: string;
      invokerId: string | null;
      visibility: 'pending' | 'invoker' | 'conversation';
      runId: string;
      rev: number;
    },
    audienceDecided = false,
  ): Promise<void> {
    const payload = {
      conversationId: run.conversationId,
      runId: run.runId,
      rev: Number(run.rev),
    };
    const topic =
      run.visibility !== 'invoker' || audienceDecided
        ? `chat:${run.conversationId}`
        : run.invokerId && `chat-user:${run.invokerId}`;

    return this.broadcast(
      topic ? [{ topic, event: 'agent.run.updated', payload }] : [],
    );
  }

  /**
   * A DM/group changed (title, members, roles): `conversation.changed` on the
   * conversation plus `inbox.changed` to its members and to `alsoNotify` (people who
   * just left or were removed, so their inbox drops it).
   */
  async conversationChanged(
    conversationId: string,
    organizationId: string,
    alsoNotify: string[] = [],
  ): Promise<void> {
    await this.broadcast([
      this.conversationSignal(conversationId, 'conversation.changed', {}),
      ...(await this.inboxSignals(conversationId, organizationId, alsoNotify)),
    ]);
  }

  /** `inbox.changed` to every member (a DM was opened or a group created). */
  async inboxChanged(
    conversationId: string,
    organizationId: string,
  ): Promise<void> {
    await this.broadcast(
      await this.inboxSignals(conversationId, organizationId),
    );
  }

  /**
   * Mints the HS256 Realtime JWT: the caller's own inbox topic plus `chat:<id>` for
   * every requested conversation they may read (others are dropped silently).
   *
   * @throws ServiceUnavailableException when the JWT secret is not configured
   */
  async mintToken(
    user: RequestUser,
    conversationIds: string[] = [],
  ): Promise<{ token: string; expiresAt: string; topics: string[] }> {
    const secret = this.configService.get<string>('supabase.jwtSecret');

    if (!secret) {
      throw new ServiceUnavailableException('Realtime chat is not configured');
    }

    const readable = await Promise.all(
      [...new Set(conversationIds)].map(async (id) => {
        try {
          await this.access.getReadable(user, id);
          return id;
        } catch (err) {
          if (err instanceof NotFoundException) return null;
          throw err;
        }
      }),
    );
    const topics = [
      `chat-user:${user.userId}`,
      ...readable
        .filter((id): id is string => id !== null)
        .map((id) => `chat:${id}`),
    ];

    // sub MUST be the auth.users id (Realtime treats it as the auth uid).
    let authUserId = user.authUserId;

    if (!authUserId) {
      const { data } = await this.client
        .from('users')
        .select('auth_user_id')
        .eq('id', user.userId)
        .maybeSingle();

      authUserId =
        (data as { auth_user_id?: string } | null)?.auth_user_id ?? '';
    }

    if (!authUserId) {
      throw new BadRequestException('Could not resolve auth identity');
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = nowSec + TOKEN_TTL_SECONDS;

    const token = await this.jwtService.signAsync(
      {
        iss: 'xisuite-backend',
        sub: authUserId,
        role: 'authenticated',
        aud: 'authenticated',
        iat: nowSec,
        exp: expSec,
        chat_topics: topics,
        app_user_id: user.userId,
        org_id: user.organizationId,
      },
      { secret, algorithm: 'HS256' },
    );

    return { token, expiresAt: new Date(expSec * 1000).toISOString(), topics };
  }

  private conversationSignal(
    conversationId: string,
    event: string,
    payload: Record<string, unknown>,
  ): ChatRealtimeMessage {
    return {
      topic: `chat:${conversationId}`,
      event,
      payload: { conversationId, ...payload },
    };
  }

  /**
   * inbox.changed for every member of a conversation (and `extra`). Never throws.
   * Nobody is signalled when it has more than {@link INBOX_FANOUT_MAX} member rows.
   */
  private async inboxSignals(
    conversationId: string,
    organizationId: string,
    extra: string[] = [],
  ): Promise<ChatRealtimeMessage[]> {
    let memberIds: string[] = [];

    try {
      const { data, error } = await this.client
        .from('chat_members')
        .select('user_id')
        .eq('conversation_id', conversationId)
        .eq('organization_id', organizationId)
        .limit(INBOX_FANOUT_MAX + 1);

      if (error) throw new Error(error.message);
      if ((data ?? []).length > INBOX_FANOUT_MAX) return [];

      memberIds = ((data ?? []) as { user_id: string }[]).map(
        (row) => row.user_id,
      );
    } catch (err) {
      this.logger.error(
        `[Broadcast] Could not load members of ${conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return [...new Set([...memberIds, ...extra])].map((userId) => ({
      topic: `chat-user:${userId}`,
      event: 'inbox.changed',
      payload: { conversationId },
    }));
  }
}
