/**
 * @fileoverview Sends calendar entry reminders by in-app notification and/or email, once a minute.
 *
 * Each reminder is claimed in the entry's `reminders_sent` before it is sent (compare-and-swap), so several
 * backends or a restart never send the same one twice. That write leaves the entry's updated_at alone.
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';

import { EntitlementsService } from '../licensing/entitlements.service';
import { MailService } from '../mail/mail.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { CalendarEventsService } from './calendar-events.service';
import type { DueReminder } from './calendar-reminders.util';
import {
  REMINDER_CATCH_UP_MS,
  dueReminders,
  effectiveReminders,
  reminderRecipients,
  reminderStart,
  reminderTitle,
} from './calendar-reminders.util';
import type { CalendarReminderChannel } from './dto/calendar-reminder.dto';

const TICK_MS = 60_000;
const PAGE_SIZE = 500;
const DAY_MS = 86_400_000;

/** The longest lead time is a week, so nothing starting later can be due. */
const LOOKAHEAD_MS = 7 * DAY_MS + REMINDER_CATCH_UP_MS;

/** Sent marks older than this are dropped, so the column stays small. */
const SENT_KEEP_MS = 2 * DAY_MS;

interface ReminderCalendar {
  id: string;
  organization_id: string;
  owner_id: string | null;
  name: string | null;
  default_reminders: unknown;
  default_timezone: string | null;
  sync_account_id: string | null;
  sync_external_calendar_id: string | null;
}

interface Recipient {
  id: string;
  email: string | null;
  first_name: string | null;
  is_active: boolean | null;
  language: string | null;
}

interface ReminderSwitches {
  in_app: boolean;
  email: boolean;
}

interface Claim {
  /** Every mark this send settles; reminders due at the same moment share one send. */
  keys: string[];
  recipient_id: string;
  channel: CalendarReminderChannel;
  minutes_before: number;
}

/** One sent reminder: when it fired and how long before the start. */
function sentKey(fireAt: Date, minutesBefore: number): string {
  return `${fireAt.toISOString()}|${minutesBefore}`;
}

@Injectable()
export class CalendarRemindersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CalendarRemindersService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /** Each organization's own address, looked up once per pass. */
  private readonly tenantBases = new Map<string, string>();

  /** Each organization's owners, looked up once per pass. */
  private readonly owners = new Map<string, string[]>();

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly events: CalendarEventsService,
    private readonly mail: MailService,
    private readonly entitlements: EntitlementsService,
    @Optional()
    private readonly notificationsBroadcast?: NotificationsBroadcastService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  onModuleInit(): void {
    if (process.env.CALENDAR_REMINDERS_DISABLED === 'true') return;

    this.timer = setInterval(() => void this.tick(), TICK_MS);

    // Never keeps the process alive on its own, e.g. in tests or on shutdown.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass; a pass still running makes the next one skip. Never throws. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.tenantBases.clear();
    this.owners.clear();

    try {
      for (const organizationId of await this.licensedOrganizations()) {
        for (const allDay of [false, true]) {
          await this.scan(organizationId, allDay, now);
        }
      }
    } catch (failure) {
      this.logger.warn(`Reminder pass failed: ${this.reason(failure)}`);
    } finally {
      this.running = false;
    }
  }

  /** Organizations with the calendar module switched on; the others are never reminded. */
  private async enabledOrganizations(): Promise<string[]> {
    const { data, error } = await this.client
      .from('organization_modules')
      .select('organization_id')
      .eq('module_type', 'calendar')
      .eq('is_enabled', true);

    if (error) throw new Error(error.message);

    return [
      ...new Set(
        ((data ?? []) as { organization_id: string }[]).map(
          (row) => row.organization_id,
        ),
      ),
    ];
  }

  /** Switched-on organizations whose licence still includes the calendar. */
  private async licensedOrganizations(): Promise<string[]> {
    const licensed: string[] = [];

    for (const organizationId of await this.enabledOrganizations()) {
      try {
        const entitlements =
          await this.entitlements.getEffectiveEntitlements(organizationId);

        if (entitlements.has('module_calendar')) licensed.push(organizationId);
      } catch (failure) {
        this.logger.warn(
          `Licence check failed for ${organizationId}: ${this.reason(failure)}`,
        );
      }
    }

    return licensed;
  }

  /** Live entries that start inside the reminder window, a page at a time. */
  private async scan(
    organizationId: string,
    allDay: boolean,
    now: Date,
  ): Promise<void> {
    const from = new Date(now.getTime() - REMINDER_CATCH_UP_MS);
    const to = new Date(now.getTime() + LOOKAHEAD_MS);

    // Reads every entry in the window; filter on reminders in SQL if this grows large.
    for (let offset = 0; ; offset += PAGE_SIZE) {
      let query = this.client
        .from('calendar_events')
        .select(
          '*, calendar:calendars!inner(id, organization_id, owner_id, name, default_reminders, default_timezone, sync_account_id, sync_external_calendar_id)',
        )
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .eq('is_all_day', allDay);

      // A day either side covers every zone's 09:00; the exact check comes after.
      query = allDay
        ? query
            .gte('start_date', this.day(from.getTime() - DAY_MS))
            .lte('start_date', this.day(to.getTime() + DAY_MS))
        : query
            .gte('starts_at', from.toISOString())
            .lte('starts_at', to.toISOString());

      const { data, error } = await query
        .order('id')
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) throw new Error(error.message);

      const rows = (data ?? []) as Record<string, unknown>[];

      for (const row of rows) {
        try {
          await this.remind(row, organizationId, now);
        } catch (failure) {
          this.logger.warn(
            `Reminder for entry ${String(row.id)} failed: ${this.reason(failure)}`,
          );
        }
      }

      if (rows.length < PAGE_SIZE) return;
    }
  }

  private async remind(
    row: Record<string, unknown>,
    organizationId: string,
    now: Date,
  ): Promise<void> {
    const { calendar: joined, ...entry } = row;
    const calendar = joined as ReminderCalendar | null;

    if (!calendar || calendar.organization_id !== organizationId) return;

    const reminders = effectiveReminders(
      entry.reminders,
      calendar.default_reminders,
    );

    if (reminders.length === 0) return;

    const start = reminderStart(entry, calendar.default_timezone);

    if (!start) return;

    const due = dueReminders(start, reminders, now);

    if (due.length === 0) return;

    const recipients = await this.visibleRecipients(
      entry,
      calendar,
      organizationId,
    );

    if (recipients.length === 0) return;

    const switches = await this.preferences(
      organizationId,
      recipients.map((person) => person.id),
    );
    const claims = await this.claim(
      entry,
      organizationId,
      due,
      recipients,
      switches,
    );

    if (claims.length === 0) return;

    const byId = new Map(recipients.map((person) => [person.id, person]));
    const delivered = new Set<string>();

    const notifications = claims.filter(
      (claim) => claim.channel === 'notification',
    );

    if (
      notifications.length > 0 &&
      (await this.notify(entry, calendar, organizationId, notifications))
    ) {
      notifications.forEach((claim) =>
        claim.keys.forEach((key) => delivered.add(key)),
      );
    }

    for (const claim of claims.filter((item) => item.channel === 'email')) {
      if (
        await this.email(entry, calendar, claim, byId.get(claim.recipient_id))
      ) {
        claim.keys.forEach((key) => delivered.add(key));
      }
    }

    // A reminder nobody received is released so the next pass retries it; a partly sent one is kept,
    // so those who already got it are not sent it again.
    const undelivered = [
      ...new Set(claims.flatMap((claim) => claim.keys)),
    ].filter((key) => !delivered.has(key));

    if (undelivered.length > 0) {
      await this.release(entry.id as string, organizationId, undelivered);
    }
  }

  /** Active members of the organization who may open this entry; private entries never leak. */
  private async visibleRecipients(
    entry: Record<string, unknown>,
    calendar: ReminderCalendar,
    organizationId: string,
  ): Promise<Recipient[]> {
    // The organization's owner is told about every entry they can open, like the calendar's own owner.
    const ids = [
      ...new Set([
        ...reminderRecipients(entry, calendar.owner_id),
        ...(await this.organizationOwners(organizationId)),
      ]),
    ];

    if (ids.length === 0) return [];

    const { data, error } = await this.client
      .from('users')
      .select('id, email, first_name, is_active, language')
      .in('id', ids);

    if (error) throw new Error(error.message);

    // People linked on the entry were named on it on purpose, so they are reminded even
    // when they cannot open the calendar, as long as they are still in the organization.
    const linked = new Set(reminderRecipients({ links: entry.links }, null));
    const members = await this.organizationMembers(organizationId, ids);
    const visible: Recipient[] = [];

    for (const person of (data ?? []) as Recipient[]) {
      if (person.is_active === false || !members.has(person.id)) continue;

      if (
        linked.has(person.id) ||
        (await this.events.canUserSeeEntry(entry, person.id, organizationId))
      ) {
        visible.push(person);
      }
    }

    return visible;
  }

  /** Each person's own switches for reminders; no stored row, or a failed read, means both are on. */
  private async preferences(
    organizationId: string,
    userIds: string[],
  ): Promise<Map<string, ReminderSwitches>> {
    const { data, error } = await this.client
      .from('notification_preferences')
      .select('user_id, in_app, email')
      .eq('organization_id', organizationId)
      .eq('notification_type', 'calendar_reminder')
      .in('user_id', userIds);

    if (error) {
      this.logger.warn(
        `Reminder preferences could not be read: ${error.message}`,
      );

      return new Map();
    }

    return new Map(
      ((data ?? []) as Array<ReminderSwitches & { user_id: string }>).map(
        (row) => [row.user_id, row],
      ),
    );
  }

  /** Who owns the organization; looked up once per pass. */
  private async organizationOwners(organizationId: string): Promise<string[]> {
    const known = this.owners.get(organizationId);

    if (known) return known;

    const { data, error } = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', organizationId)
      .eq('role', 'owner');

    if (error) throw new Error(error.message);

    const found = ((data ?? []) as Array<{ user_id: string }>).map(
      (member) => member.user_id,
    );

    this.owners.set(organizationId, found);

    return found;
  }

  /** Which of these people still belong to the organization. */
  private async organizationMembers(
    organizationId: string,
    userIds: string[],
  ): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();

    const { data, error } = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', organizationId)
      .in('user_id', userIds);

    if (error) throw new Error(error.message);

    return new Set(
      ((data ?? []) as Array<{ user_id: string }>).map(
        (member) => member.user_id,
      ),
    );
  }

  /**
   * Marks the due reminders as sent on the entry, only if nobody else did since it was read; the claims
   * that come back are the ones this pass owns and must send.
   */
  private async claim(
    entry: Record<string, unknown>,
    organizationId: string,
    due: DueReminder[],
    recipients: Recipient[],
    switches: Map<string, ReminderSwitches>,
  ): Promise<Claim[]> {
    const sent = this.sentOf(entry.reminders_sent);
    const fresh = due.filter(
      (reminder) =>
        !(sentKey(reminder.fireAt, reminder.minutes_before) in sent),
    );

    if (fresh.length === 0) return [];

    const next: Record<string, true> = this.pruned(sent);

    for (const reminder of fresh) {
      next[sentKey(reminder.fireAt, reminder.minutes_before)] = true;
    }

    const { data, error } = await this.client
      .from('calendar_events')
      .update({ reminders_sent: next })
      .eq('id', entry.id as string)
      .eq('organization_id', organizationId)
      .eq('reminders_sent', JSON.stringify(sent))
      .select('id');

    if (error) throw new Error(error.message);

    // Another pass claimed first; it sends them.
    if ((data ?? []).length === 0) return [];

    // Reminders due at the same moment (a repeat landing on another reminder) go out as one.
    const moments = new Map<string, DueReminder[]>();

    for (const reminder of fresh) {
      const moment = reminder.fireAt.toISOString();

      moments.set(moment, [...(moments.get(moment) ?? []), reminder]);
    }

    return [...moments.values()].flatMap((group) => {
      const keys = group.map((reminder) =>
        sentKey(reminder.fireAt, reminder.minutes_before),
      );
      const channels = [
        ...new Set(group.flatMap((reminder) => reminder.channels)),
      ];

      return recipients.flatMap((person) =>
        channels
          // Someone without an address gets the notification only.
          .filter((channel) => channel !== 'email' || Boolean(person.email))
          // A channel the person switched off for reminders is left out.
          .filter((channel) =>
            channel === 'email'
              ? switches.get(person.id)?.email !== false
              : switches.get(person.id)?.in_app !== false,
          )
          .map((channel) => ({
            keys,
            recipient_id: person.id,
            channel,
            minutes_before: group[0].remainingMinutes,
          })),
      );
    });
  }

  /** The stored marks, ignoring anything that is not a plain object of keys. */
  private sentOf(value: unknown): Record<string, true> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).map((key) => [key, true]),
    ) as Record<string, true>;
  }

  /** Drops marks for reminders that fired long ago. */
  private pruned(sent: Record<string, true>): Record<string, true> {
    const cutoff = Date.now() - SENT_KEEP_MS;

    return Object.fromEntries(
      Object.keys(sent)
        .filter((key) => {
          const fired = Date.parse(key.split('|')[0] ?? '');

          return Number.isNaN(fired) || fired >= cutoff;
        })
        .map((key) => [key, true]),
    ) as Record<string, true>;
  }

  /** Same shape as the follow notification, so the bell and its link treat it alike. */
  private async notify(
    entry: Record<string, unknown>,
    calendar: ReminderCalendar,
    organizationId: string,
    claims: Claim[],
  ): Promise<boolean> {
    const entryId = entry.id as string;

    try {
      const { data, error } = await this.client
        .from('notifications')
        .insert(
          claims.map((claim) => ({
            organization_id: organizationId,
            user_id: claim.recipient_id,
            type: 'calendar_reminder',
            title: reminderTitle(claim.minutes_before, entry.summary),
            body: CalendarEventsService.linkBody(
              entry,
              calendar.name || 'Calendar',
            ),
            is_read: false,
            reference_type: 'calendar_event',
            reference_id: entryId,
            metadata: {
              link: `/calendar?entry=${entryId}`,
              entry_id: entryId,
              entity_name: (entry.summary as string) || 'Untitled entry',
              calendar_id: calendar.id,
              minutes_before: claim.minutes_before,
            },
          })),
        )
        .select();

      if (error) throw new Error(error.message);

      for (const notification of (data ?? []) as Record<string, unknown>[]) {
        void this.notificationsBroadcast?.broadcastNotification(notification);
      }

      return true;
    } catch (failure) {
      this.logger.warn(
        `Reminder notification for entry ${entryId} failed: ${this.reason(failure)}`,
      );

      return false;
    }
  }

  private async email(
    entry: Record<string, unknown>,
    calendar: ReminderCalendar,
    claim: Claim,
    person: Recipient | undefined,
  ): Promise<boolean> {
    try {
      if (!person?.email) throw new Error('recipient has no email');

      // The tenant's own address: the general one drops the entry on its way to the tenant.
      const base = await this.tenantBase(calendar.organization_id);

      const title = reminderTitle(claim.minutes_before, entry.summary);
      const details = CalendarEventsService.linkBody(
        entry,
        calendar.name || 'Calendar',
      );
      const meeting =
        typeof entry.meeting_url === 'string' &&
        /^https?:\/\//i.test(entry.meeting_url)
          ? entry.meeting_url
          : null;

      // Someone reminded without access to the calendar (a linked person) lands on the calendar itself;
      // a link to an entry they cannot open would only show them an error.
      const opens = await this.events.canUserSeeEntry(
        entry,
        person.id,
        calendar.organization_id,
      );

      // When the entry happens is the middle line of the shared entry text, when it has one.
      const lines = details.split('\n');

      // The reminder's own template: tenant logo and colour, the recipient's language.
      await this.mail.sendCalendarReminder(
        person.email,
        {
          title,
          summary:
            (typeof entry.summary === 'string' && entry.summary.trim()) ||
            'Untitled entry',
          when: lines.length === 3 ? lines[1] : undefined,
          calendar: calendar.name || undefined,
          location:
            typeof entry.location === 'string' && entry.location.trim()
              ? entry.location.trim()
              : undefined,
          ctaUrl: opens
            ? `${base}/calendar?entry=${encodeURIComponent(entry.id as string)}`
            : `${base}/calendar`,
          meetingUrl: meeting ?? undefined,
          recipientName: person.first_name ?? undefined,
        },
        { organizationId: calendar.organization_id, locale: person.language },
      );

      return true;
    } catch (failure) {
      this.logger.warn(
        `Reminder email for entry ${String(entry.id)} failed: ${this.reason(failure)}`,
      );

      return false;
    }
  }

  /**
   * Where this organization's people open the app: the app address with its leading "app" label
   * swapped for the organization's own. An address without that label (one host for everyone) is kept.
   */
  private async tenantBase(organizationId: string): Promise<string> {
    const base = (
      process.env.APP_URL ||
      process.env.FRONTEND_URL ||
      'http://localhost:3000'
    ).replace(/\/+$/, '');

    const known = this.tenantBases.get(organizationId);

    if (known) return known;

    let resolved = base;

    try {
      const { data } = await this.client
        .from('organizations')
        .select('slug')
        .eq('id', organizationId)
        .maybeSingle();
      const slug = (data as { slug?: string | null } | null)?.slug;
      const url = new URL(base);

      if (slug && url.hostname.startsWith('app.')) {
        url.hostname = `${slug}.${url.hostname.slice('app.'.length)}`;
        resolved = url.toString().replace(/\/+$/, '');
      }
    } catch {
      // An unreadable address or a failed lookup keeps the general one; the link still opens the app.
    }

    this.tenantBases.set(organizationId, resolved);

    return resolved;
  }

  /** Removes marks for reminders nobody received, so the next pass retries them inside the window. */
  private async release(
    entryId: string,
    organizationId: string,
    keys: string[],
  ): Promise<void> {
    const { data, error } = await this.client
      .from('calendar_events')
      .select('reminders_sent')
      .eq('id', entryId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error || !data) {
      this.logger.warn(
        `Could not release reminder marks for entry ${entryId}: ${error?.message ?? 'entry gone'}`,
      );

      return;
    }

    const current = this.sentOf(
      (data as { reminders_sent: unknown }).reminders_sent,
    );
    const next = Object.fromEntries(
      Object.keys(current)
        .filter((key) => !keys.includes(key))
        .map((key) => [key, true]),
    );

    // Same guard as the claim: if someone wrote meanwhile, keep their marks rather than overwrite them.
    const written = await this.client
      .from('calendar_events')
      .update({ reminders_sent: next })
      .eq('id', entryId)
      .eq('organization_id', organizationId)
      .eq('reminders_sent', JSON.stringify(current));

    if (written.error) {
      this.logger.warn(
        `Could not release reminder marks for entry ${entryId}: ${written.error.message}`,
      );
    }
  }

  private day(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  private reason(failure: unknown): string {
    return failure instanceof Error ? failure.message : String(failure);
  }
}
