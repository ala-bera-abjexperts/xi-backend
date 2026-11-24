/**
 * @fileoverview Chat notifications (XE-T353 CHAT-16): who gets a bell entry for a
 * message, what waits while they are paused, the email fallback, and the user's own
 * chat notification settings. Replaces the mention-only service.
 *
 * The rules live in chat-notify-policy.ts (pure). This service loads the facts,
 * applies the decision and owns `chat_notification_queue`:
 *  - stage `held`: the recipient was paused (do not disturb or outside working
 *    hours); everything held is released as ONE summary bell entry;
 *  - stage `email`: an unread mention or DM waiting for the email fallback.
 *
 * Privacy: nothing here reads or writes message text. Bell rows have no body (their
 * metadata names the sender and the conversation, like their title), the copy
 * broadcast on the public `user-notifications:<id>` channel has a generic title and
 * no names, and the email names senders and conversations only.
 *
 * Delivery from the queue is at-most-once: rows are moved or deleted BEFORE the
 * summary or the email goes out, and only rows the statement RETURNED are delivered,
 * so two instances sweeping at the same time cannot both deliver.
 * @module src/chat/chat-notifications.service
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { MailService } from '../mail/mail.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  CHAT_CONVERSATION_COLUMNS,
  ChatAccessService,
  type ChatConversationRow,
} from './chat-access.service';
import {
  type ChatNotifyReason,
  type ChatPauseSettings,
  type ChatPreferenceKey,
  type ChatPreferences,
  type WorkingHours,
  chatPreferenceKey,
  decideChatNotification,
  isOutsideWorkingHours,
  isPaused,
  localTime,
  nextAvailableAt,
} from './chat-notify-policy';
import { ChatRealtimeService } from './chat-realtime.service';
import type { UpdateChatSettingsDto } from './dto/chat.dto';

type QueueReason = Exclude<ChatNotifyReason, 'plain'>;

interface QueueRow {
  id: string;
  organization_id: string;
  user_id: string;
  conversation_id: string;
  message_id: string;
  seq: number;
  reason: QueueReason;
  actor_id: string | null;
  stage: 'held' | 'email';
  due_at: string;
  attempts: number;
  created_at: string;
}

interface SettingsRow {
  user_id: string;
  dnd_until: string | null;
  working_hours: WorkingHours | null;
  timezone: string | null;
  email_fallback: boolean;
  email_fallback_minutes: number | null;
}

interface MemberRow {
  conversation_id: string;
  user_id: string;
  notify_level: 'all' | 'mentions' | 'none';
  muted_until: string | null;
  mute_mentions: boolean;
  last_read_seq: number;
  history_from_seq: number;
}

interface BellRow {
  id: string;
  user_id: string;
  type: string;
  created_at: string;
  metadata: { link: string };
}

/** One sweep's hold on the rows of one tenant. */
interface SweepContext {
  org: string;
  now: Date;
  /** Written into `claimed_at`; every later statement is fenced by it. */
  claimedAt: string;
}

export interface ChatSettingsView {
  dndUntil: string | null;
  workingHours: WorkingHours | null;
  timezone: string | null;
  /** 0 = never. */
  emailFallbackMinutes: number;
  /** Computed for "now"; clients never re-implement the rules. */
  paused: 'dnd' | 'working_hours' | null;
  /** false when this server only logs emails (SMTP disabled). */
  emailDeliveryEnabled: boolean;
}

export interface ChatAvailabilityView {
  userId: string;
  outsideWorkingHours: boolean;
  /** 'HH:mm' in that person's timezone; null when they set none. */
  localTime: string | null;
}

const QUEUE = 'chat_notification_queue';
const QUEUE_COLUMNS =
  'id, organization_id, user_id, conversation_id, message_id, seq, reason, actor_id, stage, due_at, attempts, created_at';
const SETTINGS_COLUMNS =
  'user_id, dnd_until, working_hours, timezone, email_fallback, email_fallback_minutes';

const MINUTE_MS = 60_000;
const DEFAULT_FALLBACK_MINUTES = 30;
/** A DM or thread adds no second bell entry while an unread one is this fresh. */
const COALESCE_MS = 5 * MINUTE_MS;
/** A claim this old belongs to a sweep that died; another one may take the rows. */
const CLAIM_STALE_MS = 5 * MINUTE_MS;
const EMAIL_RETRY_MS = 5 * MINUTE_MS;
const MAX_EMAIL_ATTEMPTS = 3;
/** People handled per tenant and sweep: their ids ride in a query string. */
const SWEEP_USERS = 50;
const THREAD_SCAN = 200;

/** What every chat bell row has in common: never any message text. */
const BELL_ROW = {
  body: null,
  is_read: false,
  action_status: 'none',
  reference_type: 'chat_message',
} as const;

/** What conversationNames() calls a conversation that has no name of its own. */
const UNNAMED = new Set([
  'a direct message',
  'a group chat',
  'a space channel',
]);

/** Titles for the public broadcast copy: they say what happened, never who or where. */
const GENERIC_TITLE: Record<QueueReason | 'summary', string> = {
  mention: 'You were mentioned in chat',
  dm: 'New direct message',
  thread_reply: 'New reply in a thread',
  summary: 'New chat notifications',
};

/** Rows of a query result; a database error becomes an exception. */
function unwrap<T>(result: {
  data: unknown;
  error: { message: string } | null;
}): T[] {
  if (result.error) throw new Error(result.error.message);

  return (result.data ?? []) as T[];
}

/** `.in()` lists ride in the query string, so long ones are split. */
function chunks<T>(items: T[], size = 100): T[][] {
  const result: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }

  return result;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();

  for (const item of items) {
    result.set(key(item), [...(result.get(key(item)) ?? []), item]);
  }

  return result;
}

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const pauseSettings = (row?: SettingsRow): ChatPauseSettings | null =>
  row
    ? {
        dndUntil: row.dnd_until,
        workingHours: row.working_hours,
        timezone: row.timezone,
      }
    : null;

/** Minutes before the email fallback; 0 = never (`email_fallback = false`). */
const fallbackMinutes = (row?: SettingsRow): number =>
  !row
    ? DEFAULT_FALLBACK_MINUTES
    : row.email_fallback
      ? (row.email_fallback_minutes ?? DEFAULT_FALLBACK_MINUTES)
      : 0;

@Injectable()
export class ChatNotificationsService {
  private readonly logger = new Logger(ChatNotificationsService.name);
  /** In-process overlap guard. Across instances the claim is what protects. */
  private ticking = false;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: ChatAccessService,
    private readonly realtime: ChatRealtimeService,
    private readonly mail: MailService,
    private readonly configService: ConfigService,
    @Optional()
    private readonly notificationsBroadcast?: NotificationsBroadcastService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ---------------------------------------------------------------------------
  // A message was sent or edited
  // ---------------------------------------------------------------------------

  /**
   * Notifies the people a message concerns: mentioned users, the other person of a
   * DM and the followers of its thread. Never throws: a failed notification must not
   * fail the message that was already stored.
   *
   * @param user - the author
   * @param conversation - the conversation the message belongs to
   * @param message - the stored message (ids only; its text is never read here)
   * @param mentionedUserIds - mentions to notify (on an edit: only the NEW ones)
   * @param edited - true for an edit: only the given mentions are notified
   */
  async onMessage(
    user: RequestUser,
    conversation: ChatConversationRow,
    message: { id: string; seq: number; threadRootId: string | null },
    mentionedUserIds: string[],
    edited = false,
  ): Promise<void> {
    try {
      const reasons = await this.recipients(
        user,
        conversation,
        message,
        mentionedUserIds,
        edited,
      );
      if (reasons.size === 0) return;

      const now = new Date();
      const org = user.organizationId;
      const readers = [...reasons.keys()];
      const [members, settings, preferences] = await Promise.all([
        this.loadMembers(org, [conversation.id], readers),
        this.loadSettings(org, readers),
        this.loadPreferences(org, readers),
      ]);
      const memberOf = new Map(members.map((row) => [row.user_id, row]));
      // Someone added "from now on" cannot read an older message, so an edit of it
      // must not tell them about it either.
      const userIds = readers.filter(
        (id) => Number(memberOf.get(id)?.history_from_seq ?? 0) < message.seq,
      );

      // Someone mentioned in a space channel they never opened has no state row, so
      // the inbox would show no badge. Start them just before this message.
      const newcomers =
        conversation.kind === 'space'
          ? userIds.filter(
              (id) => reasons.get(id) === 'mention' && !memberOf.has(id),
            )
          : [];
      if (newcomers.length > 0) {
        await this.addChannelMembers(conversation, newcomers, message.seq);
      }

      const decisions = userIds.map((userId) => {
        const member = memberOf.get(userId);
        const pause = pauseSettings(settings.get(userId));
        const paused = isPaused(pause, now) !== null;
        const reason = reasons.get(userId) as QueueReason;

        return {
          userId,
          reason,
          pause,
          paused,
          ...decideChatNotification({
            reason,
            // Without a state row it is a space channel: those default to mentions.
            level: member?.notify_level ?? 'mentions',
            muted:
              !!member?.muted_until &&
              Date.parse(member.muted_until) > now.getTime(),
            muteMentions: member?.mute_mentions === true,
            paused,
            preferences: preferences.get(userId) ?? {},
            emailFallbackMinutes: fallbackMinutes(settings.get(userId)),
          }),
        };
      });

      // The bell and the queue are independent: one failing must not stop the other.
      await this.insertBellRows(
        user,
        conversation,
        message,
        decisions.filter((decision) => decision.bell === 'now'),
        now,
        edited,
      ).catch((err: unknown) =>
        this.logger.warn(`Chat bell rows failed: ${errorText(err)}`),
      );

      const queued = decisions
        .filter((d) => d.bell === 'held' || d.emailAfterMinutes !== null)
        .map((d) => ({
          organization_id: org,
          user_id: d.userId,
          conversation_id: conversation.id,
          message_id: message.id,
          seq: message.seq,
          reason: d.reason,
          actor_id: user.userId,
          // While paused nothing counts down: the email delay starts on release.
          stage: d.paused ? 'held' : 'email',
          due_at: (d.paused
            ? nextAvailableAt(d.pause, now)
            : new Date(now.getTime() + (d.emailAfterMinutes ?? 0) * MINUTE_MS)
          ).toISOString(),
        }));

      if (queued.length > 0) {
        unwrap(
          await this.client.from(QUEUE).upsert(queued, {
            onConflict: 'user_id,message_id',
            ignoreDuplicates: true,
          }),
        );
      }
    } catch (err) {
      this.logger.warn(`Chat notification failed: ${errorText(err)}`);
    }
  }

  /**
   * The caller read a conversation up to `lastReadSeq`: what is still pending for
   * those messages is dropped and their unread bell entries are marked read.
   * Best-effort, never throws.
   */
  async onRead(
    user: RequestUser,
    conversationId: string,
    lastReadSeq: number,
  ): Promise<void> {
    try {
      const org = user.organizationId;
      const [pending, unread] = await Promise.all([
        this.client
          .from(QUEUE)
          .delete()
          .eq('organization_id', org)
          .eq('user_id', user.userId)
          .eq('conversation_id', conversationId)
          .lte('seq', lastReadSeq),
        this.client
          .from('notifications')
          .select('id, metadata')
          .eq('organization_id', org)
          .eq('user_id', user.userId)
          .eq('is_read', false)
          .eq('reference_type', BELL_ROW.reference_type)
          .eq('metadata->>conversation_id', conversationId),
      ]);
      unwrap(pending);

      const ids = unwrap<{ id: string; metadata: { seq?: number } | null }>(
        unread,
      )
        .filter((row) => Number(row.metadata?.seq) <= lastReadSeq)
        .map((row) => row.id);

      for (const batch of chunks(ids)) {
        unwrap(
          await this.client
            .from('notifications')
            .update({ is_read: true, updated_at: new Date().toISOString() })
            .eq('organization_id', org)
            .eq('user_id', user.userId)
            .in('id', batch),
        );
      }
    } catch (err) {
      this.logger.warn(`Chat read sync failed: ${errorText(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Settings and availability
  // ---------------------------------------------------------------------------

  /** The caller's chat notification settings, with the pause state for "now". */
  async getSettings(user: RequestUser): Promise<ChatSettingsView> {
    const settings = await this.loadSettings(user.organizationId, [
      user.userId,
    ]);

    return this.toSettingsView(settings.get(user.userId));
  }

  /**
   * Changes the caller's settings. A missing key is left alone; null clears it.
   *
   * @throws BadRequestException when working hours would be stored without a timezone
   */
  async updateSettings(
    user: RequestUser,
    dto: UpdateChatSettingsDto,
  ): Promise<ChatSettingsView> {
    const org = user.organizationId;
    const current = (await this.loadSettings(org, [user.userId])).get(
      user.userId,
    );

    // An empty schedule (every day off) would pause someone for ever: it means "none".
    const workingHours =
      dto.workingHours === undefined
        ? (current?.working_hours ?? null)
        : dto.workingHours && Object.keys(dto.workingHours).length > 0
          ? dto.workingHours
          : null;
    const timezone =
      dto.timezone === undefined ? (current?.timezone ?? null) : dto.timezone;

    if (workingHours && !timezone) {
      throw new BadRequestException(
        'A timezone is required when working hours are set',
      );
    }

    // @IsISO8601 lets through what Postgres does not read ("2026", a week date, 31
    // February), so the end is stored as the instant JavaScript reads, up to year 9999.
    const dndUntil = dto.dndUntil ? new Date(dto.dndUntil) : null;

    if (dndUntil && !(dndUntil.getTime() < Date.UTC(10000, 0, 1))) {
      throw new BadRequestException('dndUntil is not a usable date');
    }

    const pauseChanged =
      dto.dndUntil !== undefined ||
      dto.workingHours !== undefined ||
      dto.timezone !== undefined;
    const [saved] = unwrap<SettingsRow>(
      await this.client
        .from('chat_user_settings')
        .upsert(
          {
            organization_id: org,
            user_id: user.userId,
            ...(dto.dndUntil !== undefined && {
              dnd_until: dndUntil?.toISOString() ?? null,
            }),
            ...(dto.workingHours !== undefined && {
              working_hours: workingHours,
            }),
            ...(dto.timezone !== undefined && { timezone }),
            // "Never" is the boolean; the minutes column only ever holds a real delay.
            ...(dto.emailFallbackMinutes !== undefined &&
              (dto.emailFallbackMinutes === 0
                ? { email_fallback: false }
                : {
                    email_fallback: true,
                    email_fallback_minutes: dto.emailFallbackMinutes,
                  })),
          },
          { onConflict: 'organization_id,user_id' },
        )
        .select(SETTINGS_COLUMNS),
    );

    if (pauseChanged) {
      // Ending a pause should release what was held within a minute, not at the old
      // end. The sweep still checks the pause itself, so this can never release early.
      // ponytail: a sweep that is handling these rows right now can write the old
      // end back; they are then released at that old end. Fence on due_at if it matters.
      const { error } = await this.client
        .from(QUEUE)
        .update({ due_at: new Date().toISOString() })
        .eq('organization_id', org)
        .eq('user_id', user.userId)
        .eq('stage', 'held');

      if (error) {
        this.logger.warn(`Could not wake held chat rows: ${error.message}`);
      }
    }

    return this.toSettingsView(saved);
  }

  /**
   * Whether colleagues are outside their working hours right now, for the hint a
   * sender sees before writing. Do not disturb is private and never part of this.
   * Someone unknown, in another organization or without settings gets the same
   * neutral answer, so the call reveals nothing about membership.
   */
  async availability(
    user: RequestUser,
    userIds: string[],
  ): Promise<ChatAvailabilityView[]> {
    const ids = [...new Set(userIds)];
    const settings = await this.loadSettings(user.organizationId, ids);
    const now = new Date();

    return ids.map((userId) => {
      const row = settings.get(userId);

      return {
        userId,
        outsideWorkingHours: isOutsideWorkingHours(
          {
            workingHours: row?.working_hours ?? null,
            timezone: row?.timezone ?? null,
          },
          now,
        ),
        localTime: localTime(row?.timezone ?? null, now),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // The minute sweep
  // ---------------------------------------------------------------------------

  /** Releases held notifications and sends the email fallback. Runs in every instance. */
  @Cron('20 * * * * *') // :20, away from the jobs that cluster on :00
  async sweep(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;

    try {
      await this.sweepOnce(new Date());
    } catch (err) {
      this.logger.warn(`Chat notification sweep failed: ${errorText(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** One pass over everything that is due at `now`. */
  async sweepOnce(now: Date): Promise<void> {
    const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();

    // The one chat query without an organization filter: it finds WHICH tenants have
    // work. Everything after it is scoped to one organization.
    const due = unwrap<{ organization_id: string; user_id: string }>(
      await this.client
        .from(QUEUE)
        .select('organization_id, user_id')
        .lte('due_at', now.toISOString())
        .or(`claimed_at.is.null,claimed_at.lt.${staleBefore}`)
        .order('due_at', { ascending: true })
        .limit(1000),
    );

    for (const [org, rows] of groupBy(due, (row) => row.organization_id)) {
      const userIds = [...new Set(rows.map((row) => row.user_id))].slice(
        0,
        SWEEP_USERS,
      );

      // One tenant's failure must not stop the others.
      await this.sweepOrganization(org, userIds, now, staleBefore).catch(
        (err: unknown) =>
          this.logger.warn(
            `Chat notification sweep failed for ${org}: ${errorText(err)}`,
          ),
      );
    }
  }

  /**
   * Claims every pending row of these people (not only the due ones, so one summary
   * or one email covers all of it) and delivers. Only RETURNED rows are owned: a
   * second instance running the same statement gets none of them.
   */
  private async sweepOrganization(
    org: string,
    userIds: string[],
    now: Date,
    staleBefore: string,
  ): Promise<void> {
    const ctx: SweepContext = { org, now, claimedAt: now.toISOString() };
    const claim = () =>
      this.client
        .from(QUEUE)
        .update({ claimed_at: ctx.claimedAt })
        .eq('organization_id', org)
        .in('user_id', userIds);

    // Two statements, never one .or(): on a mutation PostgREST applies .or() to the
    // RETURNING rows, where claimed_at is already the new value (see
    // inbound-email/mailbox-poll.service.ts). The two conditions cannot both hold.
    // ponytail: every pending row of these people comes back in one response. Claim
    // through a function with a LIMIT if someone ever queues tens of thousands.
    const owned = [
      ...unwrap<QueueRow>(
        await claim().is('claimed_at', null).select(QUEUE_COLUMNS),
      ),
      ...unwrap<QueueRow>(
        await claim().lt('claimed_at', staleBefore).select(QUEUE_COLUMNS),
      ),
    ];
    if (owned.length === 0) return;

    try {
      await this.deliver(ctx, owned);
    } finally {
      // Whatever was neither delivered nor dropped goes back for the next sweep.
      const { error } = await this.client
        .from(QUEUE)
        .update({ claimed_at: null })
        .eq('organization_id', org)
        .eq('claimed_at', ctx.claimedAt)
        .in('user_id', userIds);

      if (error) {
        this.logger.warn(`Could not release chat claims: ${error.message}`);
      }
    }
  }

  private async deliver(ctx: SweepContext, owned: QueueRow[]): Promise<void> {
    const { org, now } = ctx;
    const byUser = groupBy(owned, (row) => row.user_id);
    const userIds = [...byUser.keys()];
    const [settings, preferences] = await Promise.all([
      this.loadSettings(org, userIds),
      this.loadPreferences(org, userIds),
    ]);

    // Paused people first: their due rows only move to the end of the pause. The
    // pause is judged now, in their timezone; due_at is merely "look again at".
    const active: QueueRow[] = [];

    for (const [userId, rows] of byUser) {
      const pause = pauseSettings(settings.get(userId));

      if (isPaused(pause, now) === null) {
        active.push(...rows);
        continue;
      }

      unwrap(
        await this.client
          .from(QUEUE)
          .update({ due_at: nextAvailableAt(pause, now).toISOString() })
          .eq('organization_id', org)
          .eq('user_id', userId)
          .eq('claimed_at', ctx.claimedAt)
          .lte('due_at', now.toISOString()),
      );
    }

    if (active.length === 0) return;

    const { valid, conversations } = await this.dropInvalid(ctx, active);

    for (const [userId, rows] of groupBy(valid, (row) => row.user_id)) {
      // One person's failure must not stop the others.
      await this.deliverTo(
        ctx,
        userId,
        rows,
        fallbackMinutes(settings.get(userId)),
        preferences.get(userId) ?? {},
        conversations,
      ).catch((err: unknown) =>
        this.logger.warn(
          `Chat notification delivery failed for ${userId}: ${errorText(err)}`,
        ),
      );
    }
  }

  /**
   * Deletes the rows that no longer deserve a notification and returns the rest:
   * the message was deleted, was read, the person can no longer read the
   * conversation, or the mention was edited out.
   */
  private async dropInvalid(
    ctx: SweepContext,
    rows: QueueRow[],
  ): Promise<{
    valid: QueueRow[];
    conversations: Map<string, ChatConversationRow>;
  }> {
    const { org } = ctx;
    const userIds = [...new Set(rows.map((row) => row.user_id))];
    const conversationIds = [
      ...new Set(rows.map((row) => row.conversation_id)),
    ];
    const mentionIds = rows
      .filter((row) => row.reason === 'mention')
      .map((row) => row.message_id);

    const live = new Set<string>();
    for (const ids of chunks([...new Set(rows.map((row) => row.message_id))])) {
      for (const message of unwrap<{ id: string }>(
        await this.client
          .from('chat_messages')
          .select('id')
          .eq('organization_id', org)
          .in('id', ids)
          .is('deleted_at', null),
      )) {
        live.add(message.id);
      }
    }

    const mentioned = new Set<string>();
    for (const ids of chunks([...new Set(mentionIds)])) {
      for (const ref of unwrap<{ message_id: string; ref_id: string }>(
        await this.client
          .from('chat_message_refs')
          .select('message_id, ref_id')
          .eq('organization_id', org)
          .eq('ref_type', 'user')
          .in('message_id', ids)
          .in('ref_id', userIds),
      )) {
        mentioned.add(`${ref.message_id}:${ref.ref_id}`);
      }
    }

    const conversations = new Map<string, ChatConversationRow>();
    const readSeq = new Map<string, number>();
    for (const ids of chunks(conversationIds)) {
      for (const conversation of unwrap<ChatConversationRow>(
        await this.client
          .from('chat_conversations')
          .select(CHAT_CONVERSATION_COLUMNS)
          .eq('organization_id', org)
          .in('id', ids),
      )) {
        conversations.set(conversation.id, conversation);
      }
      for (const member of await this.loadMembers(org, ids, userIds)) {
        readSeq.set(
          `${member.conversation_id}:${member.user_id}`,
          Number(member.last_read_seq),
        );
      }
    }

    const readers = new Set<string>();
    for (const [conversationId, items] of groupBy(
      rows,
      (row) => row.conversation_id,
    )) {
      const conversation = conversations.get(conversationId);
      if (!conversation) continue;

      for (const userId of await this.access.filterReaders(conversation, [
        ...new Set(items.map((row) => row.user_id)),
      ])) {
        readers.add(`${conversationId}:${userId}`);
      }
    }

    const valid: QueueRow[] = [];
    const invalid: QueueRow[] = [];

    for (const row of rows) {
      const key = `${row.conversation_id}:${row.user_id}`;
      const kind = conversations.get(row.conversation_id)?.kind;
      const mentionGone =
        row.reason === 'mention' &&
        !mentioned.has(`${row.message_id}:${row.user_id}`);

      if (
        !live.has(row.message_id) ||
        !readers.has(key) ||
        (readSeq.get(key) ?? 0) >= Number(row.seq) ||
        (mentionGone && kind !== 'dm')
      ) {
        invalid.push(row);
      } else {
        // Without its mention a DM message still notifies, as a DM.
        valid.push(mentionGone ? { ...row, reason: 'dm' } : row);
      }
    }

    await this.take(ctx, invalid, null);

    return { valid, conversations };
  }

  /** Releases one person's held rows as a summary and sends their email when due. */
  private async deliverTo(
    ctx: SweepContext,
    userId: string,
    rows: QueueRow[],
    emailAfterMinutes: number,
    preferences: ChatPreferences,
    conversations: Map<string, ChatConversationRow>,
  ): Promise<void> {
    const { now } = ctx;
    const wants = (row: QueueRow) =>
      preferences[chatPreferenceKey(row.reason)] ?? {
        inApp: true,
        email: true,
      };
    // A server that sends no email queues none either (as in onMessage).
    const emailable = (row: QueueRow) =>
      this.mail.deliveryEnabled &&
      row.reason !== 'thread_reply' &&
      emailAfterMinutes > 0 &&
      wants(row).email;

    const held = rows.filter((row) => row.stage === 'held');

    if (held.length > 0) {
      // Moved or deleted first, announced second: a crash in between loses the
      // summary, it never repeats it.
      const released = new Set([
        ...(await this.take(ctx, held.filter(emailable), {
          stage: 'email',
          due_at: new Date(
            now.getTime() + emailAfterMinutes * MINUTE_MS,
          ).toISOString(),
        })),
        ...(await this.take(
          ctx,
          held.filter((row) => !emailable(row)),
          null,
        )),
      ]);

      await this.insertSummary(
        ctx,
        userId,
        held.filter((row) => released.has(row.id) && wants(row).inApp),
      );
    }

    const pending = rows.filter((row) => row.stage === 'email');

    if (!pending.some((row) => Date.parse(row.due_at) <= now.getTime())) {
      return;
    }

    // One email covers everything pending, also what is not due yet.
    const taken = await this.take(ctx, pending, null);
    const mailable = pending.filter(
      (row) => taken.has(row.id) && emailable(row),
    );
    if (mailable.length === 0) return;

    try {
      await this.sendDigest(ctx, userId, mailable, conversations);
    } catch (err) {
      const retry = mailable.filter(
        (row) => row.attempts + 1 < MAX_EMAIL_ATTEMPTS,
      );
      this.logger.warn(
        `Chat email to ${userId} failed (${errorText(err)}): ${retry.length} of ${mailable.length} row(s) queued again`,
      );

      if (retry.length > 0) {
        unwrap(
          await this.client.from(QUEUE).upsert(
            retry.map((row) => ({
              organization_id: row.organization_id,
              user_id: row.user_id,
              conversation_id: row.conversation_id,
              message_id: row.message_id,
              seq: row.seq,
              reason: row.reason,
              actor_id: row.actor_id,
              stage: 'email',
              due_at: new Date(now.getTime() + EMAIL_RETRY_MS).toISOString(),
              attempts: row.attempts + 1,
            })),
            { onConflict: 'user_id,message_id', ignoreDuplicates: true },
          ),
        );
      }
    }
  }

  /**
   * Moves (`patch`) or deletes (`null`) queue rows this sweep owns. Returns the ids
   * the database really changed: only those may be delivered.
   */
  private async take(
    ctx: SweepContext,
    rows: QueueRow[],
    patch: Record<string, unknown> | null,
  ): Promise<Set<string>> {
    const taken = new Set<string>();

    for (const ids of chunks(rows.map((row) => row.id))) {
      const table = this.client.from(QUEUE);
      const changed = unwrap<{ id: string }>(
        await (patch ? table.update(patch) : table.delete())
          .eq('organization_id', ctx.org)
          .eq('claimed_at', ctx.claimedAt)
          .in('id', ids)
          .select('id'),
      );

      for (const row of changed) taken.add(row.id);
    }

    return taken;
  }

  /** ONE bell entry for everything that was held, pointing at the newest message. */
  private async insertSummary(
    ctx: SweepContext,
    userId: string,
    rows: QueueRow[],
  ): Promise<void> {
    if (rows.length === 0) return;

    const newest = rows.reduce((a, b) =>
      Date.parse(b.created_at) > Date.parse(a.created_at) ? b : a,
    );
    const link = `/chat/${newest.conversation_id}?m=${newest.message_id}`;
    const [row] = unwrap<BellRow>(
      await this.client
        .from('notifications')
        .insert({
          ...BELL_ROW,
          organization_id: ctx.org,
          user_id: userId,
          type: 'chat_summary',
          title:
            rows.length === 1
              ? '1 new chat notification while you were away'
              : `${rows.length} new chat notifications while you were away`,
          reference_id: newest.message_id,
          metadata: {
            link,
            conversation_id: newest.conversation_id,
            seq: Number(newest.seq),
            count: rows.length,
          },
        })
        .select('id, user_id, type, created_at, metadata'),
    );

    if (row) this.broadcast(row, GENERIC_TITLE.summary);
  }

  /**
   * The email fallback: who wrote, where, how many, and a link. Never any message
   * text. Throws when the mail server refuses, so the caller can queue again.
   */
  private async sendDigest(
    ctx: SweepContext,
    userId: string,
    rows: QueueRow[],
    conversations: Map<string, ChatConversationRow>,
  ): Promise<void> {
    const people = await this.loadPeople([
      userId,
      ...rows.map((row) => row.actor_id ?? ''),
    ]);
    const recipient = people.get(userId);
    if (!recipient?.email) return;

    const byConversation = groupBy(rows, (row) => row.conversation_id);
    const names = await this.conversationNames(
      ctx.org,
      [...byConversation.keys()]
        .map((id) => conversations.get(id))
        .filter((row): row is ChatConversationRow => !!row),
    );
    const oldest = rows.reduce((a, b) =>
      Date.parse(b.created_at) < Date.parse(a.created_at) ? b : a,
    );
    const appUrl = (
      this.configService.get<string>('appUrl') || 'http://localhost:3000'
    ).replace(/\/+$/, '');
    // ponytail: English only, like every bell title this backend writes; move both
    // to mail/i18n when notification titles are localised.
    const title =
      rows.length === 1
        ? 'You have 1 unread chat message'
        : `You have ${rows.length} unread chat messages`;

    await this.mail.sendNotification(
      recipient.email,
      {
        title,
        subject: title,
        eyebrow: 'Chat',
        body: [...byConversation]
          .map(([conversationId, items]) => {
            const senders = [
              ...new Set(
                items.map(
                  (row) => people.get(row.actor_id ?? '')?.name ?? 'Someone',
                ),
              ),
            ].join(', ');

            return `${senders} in ${names.get(conversationId) ?? 'a conversation'} (${items.length})`;
          })
          .join('\n'),
        ctaUrl:
          byConversation.size === 1
            ? `${appUrl}/chat/${oldest.conversation_id}?m=${oldest.message_id}`
            : `${appUrl}/chat`,
        ctaLabel: 'Open chat',
        recipientName: recipient.firstName ?? undefined,
      },
      { organizationId: ctx.org, locale: recipient.language },
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Who a message concerns and why, strongest reason first: a mention, the other
   * person of a DM, a follower of the thread (its author and everyone who replied).
   * Never the author, only members of the organization, only people who can read
   * the conversation.
   */
  private async recipients(
    user: RequestUser,
    conversation: ChatConversationRow,
    message: { threadRootId: string | null },
    mentionedUserIds: string[],
    edited: boolean,
  ): Promise<Map<string, QueueReason>> {
    const mentions = new Set(mentionedUserIds);
    const dm =
      !edited && conversation.kind === 'dm'
        ? (conversation.dm_key ?? '').split(':')
        : [];
    const followers =
      !edited && message.threadRootId
        ? await this.threadFollowers(conversation, message.threadRootId)
        : [];

    const candidates = [...new Set([...mentions, ...dm, ...followers])].filter(
      (id) => id && id !== user.userId,
    );
    if (candidates.length === 0) return new Map();

    const members = unwrap<{ user_id: string }>(
      await this.client
        .from('organization_members')
        .select('user_id')
        .eq('organization_id', user.organizationId)
        .in('user_id', candidates),
    );
    const readers = await this.access.filterReaders(
      conversation,
      members.map((row) => row.user_id),
    );

    return new Map(
      readers.map((id) => [
        id,
        mentions.has(id) ? 'mention' : dm.includes(id) ? 'dm' : 'thread_reply',
      ]),
    );
  }

  /** The author of a thread's first message and everyone who replied in it. */
  private async threadFollowers(
    conversation: ChatConversationRow,
    rootId: string,
  ): Promise<string[]> {
    // ponytail: the first 200 messages of a thread decide who follows it; a
    // followers table is the upgrade (it is also what "unfollow" needs).
    const messages = unwrap<{ author_id: string | null }>(
      await this.client
        .from('chat_messages')
        .select('author_id')
        .eq('organization_id', conversation.organization_id)
        .eq('conversation_id', conversation.id)
        .eq('kind', 'user')
        .or(`id.eq.${rootId},thread_root_id.eq.${rootId}`)
        .order('seq', { ascending: true })
        .limit(THREAD_SCAN),
    );

    return messages
      .map((row) => row.author_id)
      .filter((id): id is string => !!id);
  }

  /** Creates the channel state row of people who never opened the channel. */
  private async addChannelMembers(
    conversation: ChatConversationRow,
    userIds: string[],
    seq: number,
  ): Promise<void> {
    const { error } = await this.client.from('chat_members').upsert(
      userIds.map((userId) => ({
        conversation_id: conversation.id,
        organization_id: conversation.organization_id,
        user_id: userId,
        notify_level: 'mentions',
        // One before the message, so it counts as unread and as a mention.
        last_read_seq: Math.max(0, seq - 1),
      })),
      { onConflict: 'conversation_id,user_id', ignoreDuplicates: true },
    );

    if (error) {
      this.logger.warn(`Could not add channel members: ${error.message}`);
      return;
    }

    // Their row did not exist when the message's own inbox signal was built.
    void this.realtime.broadcast(
      userIds.map((userId) => ({
        topic: `chat-user:${userId}`,
        event: 'inbox.changed',
        payload: { conversationId: conversation.id },
      })),
    );
  }

  /** Bell entries for the people who are notified at once. */
  private async insertBellRows(
    user: RequestUser,
    conversation: ChatConversationRow,
    message: { id: string; seq: number; threadRootId: string | null },
    recipients: { userId: string; reason: QueueReason }[],
    now: Date,
    edited: boolean,
  ): Promise<void> {
    if (recipients.length === 0) return;

    const org = user.organizationId;
    // An edit adds no second entry while the person has an unread one for the same
    // message (the DM or thread reply it was, or a mention that was edited back in).
    const told = !edited
      ? []
      : unwrap<{ user_id: string }>(
          await this.client
            .from('notifications')
            .select('user_id')
            .eq('organization_id', org)
            .in(
              'user_id',
              recipients.map(({ userId }) => userId),
            )
            .eq('is_read', false)
            .eq('reference_type', BELL_ROW.reference_type)
            .eq('reference_id', message.id),
        ).map((row) => row.user_id);
    const repeatable = recipients
      .filter(({ reason }) => reason !== 'mention')
      .map(({ userId }) => userId);
    const recent =
      repeatable.length === 0
        ? []
        : unwrap<{
            user_id: string;
            type: string;
            metadata: { thread_root_id?: string } | null;
          }>(
            await this.client
              .from('notifications')
              .select('user_id, type, metadata')
              .eq('organization_id', org)
              .in('user_id', repeatable)
              .eq('is_read', false)
              .eq('reference_type', BELL_ROW.reference_type)
              .eq('metadata->>conversation_id', conversation.id)
              .gte(
                'created_at',
                new Date(now.getTime() - COALESCE_MS).toISOString(),
              ),
          );
    // A mention always gets its own entry; a DM or a thread only while the person
    // has no fresh unread entry for the same DM or thread.
    const fresh = recipients.filter(
      ({ userId, reason }) =>
        !told.includes(userId) &&
        (reason === 'mention' ||
          !recent.some(
            (row) =>
              row.user_id === userId &&
              (reason === 'dm'
                ? row.type === 'chat_dm'
                : row.metadata?.thread_root_id === message.threadRootId),
          )),
    );
    if (fresh.length === 0) return;

    const [people, names] = await Promise.all([
      this.loadPeople([user.userId]),
      this.conversationNames(org, [conversation]),
    ]);
    const actor = people.get(user.userId)?.name ?? 'Someone';
    const where = names.get(conversation.id);
    const reasonOf = new Map(fresh.map((r) => [r.userId, r.reason]));

    const inserted = unwrap<BellRow>(
      await this.client
        .from('notifications')
        .insert(
          fresh.map(({ userId, reason }) => ({
            ...BELL_ROW,
            organization_id: org,
            user_id: userId,
            // The type is the preference key, so the client can gate its toast on it.
            type: chatPreferenceKey(reason),
            title:
              reason === 'mention'
                ? `${actor} mentioned you in ${where}`
                : reason === 'dm'
                  ? `${actor} sent you a direct message`
                  : `${actor} replied in a thread in ${where}`,
            reference_id: message.id,
            metadata: {
              // An explicit link wins in buildNotificationPath and the frontend helper.
              link: `/chat/${conversation.id}?m=${message.id}`,
              conversation_id: conversation.id,
              seq: message.seq,
              // What the client needs to phrase the entry in the reader's language.
              // Stored on the row only: broadcast() never copies them.
              // A conversation without a name of its own (a DM, an untitled group)
              // stores no `where`: the client then phrases the entry without one.
              reason,
              actor_name: actor,
              ...(reason !== 'dm' && where && !UNNAMED.has(where) && { where }),
              ...(reason === 'thread_reply' && {
                thread_root_id: message.threadRootId,
              }),
            },
          })),
        )
        .select('id, user_id, type, created_at, metadata'),
    );

    for (const row of inserted) {
      this.broadcast(
        row,
        GENERIC_TITLE[reasonOf.get(row.user_id) ?? 'mention'],
      );
    }
  }

  /**
   * Tells the recipient's open tabs. `user-notifications:<id>` is a PUBLIC channel,
   * so the copy holds ids, a generic title and the link only: no names, no text.
   */
  private broadcast(row: BellRow, title: string): void {
    void this.notificationsBroadcast?.broadcastNotification({
      id: row.id,
      user_id: row.user_id,
      type: row.type,
      title,
      created_at: row.created_at,
      metadata: { link: row.metadata.link },
    });
  }

  private toSettingsView(row?: SettingsRow): ChatSettingsView {
    const now = new Date();

    return {
      // An end in the past is the same as "off".
      dndUntil:
        row?.dnd_until && Date.parse(row.dnd_until) > now.getTime()
          ? row.dnd_until
          : null,
      workingHours: row?.working_hours ?? null,
      timezone: row?.timezone ?? null,
      emailFallbackMinutes: fallbackMinutes(row),
      paused: isPaused(pauseSettings(row), now),
      emailDeliveryEnabled: this.mail.deliveryEnabled,
    };
  }

  private async loadSettings(
    org: string,
    userIds: string[],
  ): Promise<Map<string, SettingsRow>> {
    const rows = unwrap<SettingsRow>(
      await this.client
        .from('chat_user_settings')
        .select(SETTINGS_COLUMNS)
        .eq('organization_id', org)
        .in('user_id', userIds),
    );

    return new Map(rows.map((row) => [row.user_id, row]));
  }

  private async loadPreferences(
    org: string,
    userIds: string[],
  ): Promise<Map<string, ChatPreferences>> {
    const rows = unwrap<{
      user_id: string;
      notification_type: ChatPreferenceKey;
      in_app: boolean;
      email: boolean;
    }>(
      await this.client
        .from('notification_preferences')
        .select('user_id, notification_type, in_app, email')
        .eq('organization_id', org)
        .in('user_id', userIds)
        .in('notification_type', ['chat_mention', 'chat_dm']),
    );
    const result = new Map<string, ChatPreferences>();

    for (const row of rows) {
      result.set(row.user_id, {
        ...result.get(row.user_id),
        [row.notification_type]: { inApp: row.in_app, email: row.email },
      });
    }

    return result;
  }

  private async loadMembers(
    org: string,
    conversationIds: string[],
    userIds: string[],
  ): Promise<MemberRow[]> {
    return unwrap<MemberRow>(
      await this.client
        .from('chat_members')
        .select(
          'conversation_id, user_id, notify_level, muted_until, mute_mentions, last_read_seq, history_from_seq',
        )
        .eq('organization_id', org)
        .in('conversation_id', conversationIds)
        .in('user_id', userIds),
    );
  }

  /** Names and mail data of users; unknown (deleted) users are simply absent. */
  private async loadPeople(userIds: string[]): Promise<
    Map<
      string,
      {
        name: string;
        email: string | null;
        firstName: string | null;
        language: string | null;
      }
    >
  > {
    const rows = unwrap<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      language: string | null;
    }>(
      await this.client
        .from('users')
        .select('id, first_name, last_name, email, language')
        .in('id', [...new Set(userIds.filter(Boolean))]),
    );

    return new Map(
      rows.map((row) => [
        row.id,
        {
          name:
            `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() ||
            row.email ||
            'Someone',
          email: row.email,
          firstName: row.first_name,
          language: row.language,
        },
      ]),
    );
  }

  /** How a conversation is called in a title: a DM, a "group" or a #space. */
  // The wordings without a name are listed in UNNAMED: keep the two in step.
  private async conversationNames(
    org: string,
    conversations: ChatConversationRow[],
  ): Promise<Map<string, string>> {
    const spaceIds = [
      ...new Set(
        conversations
          .filter((row) => row.kind === 'space' && row.space_id)
          .map((row) => row.space_id as string),
      ),
    ];
    const spaces =
      spaceIds.length === 0
        ? []
        : unwrap<{ id: string; name: string | null }>(
            await this.client
              .from('spaces')
              .select('id, name')
              .eq('organization_id', org)
              .in('id', spaceIds),
          );
    const spaceName = new Map(spaces.map((row) => [row.id, row.name]));

    return new Map(
      conversations.map((row) => {
        if (row.kind === 'dm') return [row.id, 'a direct message'];
        if (row.kind === 'group') {
          return [row.id, row.title ? `"${row.title}"` : 'a group chat'];
        }

        const name = spaceName.get(row.space_id ?? '');

        return [row.id, name ? `#${name}` : 'a space channel'];
      }),
    );
  }
}
