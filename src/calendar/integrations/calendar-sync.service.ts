/**
 * @fileoverview Links a calendar to an external one and brings changes in.
 *
 * Imports are idempotent: an entry is matched by the id the provider gave it, so running a sync twice
 * updates the same row instead of making a second one.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';

import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { CalendarAccessService } from '../calendar-access.service';
import { CalendarAuditService } from '../calendar-audit.service';
import { CalendarsService, withVisibleShares } from '../calendars.service';
import type { CalendarAccountRow } from './calendar-accounts.service';
import { CalendarAccountsService } from './calendar-accounts.service';
import type {
  CalendarProviderApi,
  ExternalEvent,
  OutgoingEvent,
} from './calendar-provider';
import { ProviderConflictError } from './calendar-provider';
import { CalendarProvidersService } from './calendar-providers.service';
import { ZoomTokensService } from './zoom-tokens.service';

const CALENDARS = 'calendars';

const EVENTS = 'calendar_events';

const ACCOUNTS = 'calendar_accounts';

/** How far around today a first import reaches. */
const IMPORT_PAST_DAYS = 90;

const IMPORT_FUTURE_DAYS = 400;

const DAY_MS = 86_400_000;

/** How many skipped titles a warning names; the count says how many there were in all. */
const SKIPPED_TITLES = 5;

/** Rows written per tombstone request, under the URL length an `.in()` list can reach. */
const TOMBSTONE_CHUNK = 100;

/** The meeting number in a Zoom join link, or null for any other link. */
export function zoomMeetingId(url: string | null | undefined): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // Zoom for Government serves its links from zoomgov.com.
    if (
      host !== 'zoom.us' &&
      !host.endsWith('.zoom.us') &&
      host !== 'zoomgov.com' &&
      !host.endsWith('.zoomgov.com')
    ) {
      return null;
    }

    return /\/(?:j|s|w)\/(\d+)/.exec(parsed.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** What one imported entry did to its row. */
type UpsertDecision = 'written' | 'kept' | 'deleted_here' | 'duplicate';

/** How many waiting local changes one run sends out; the rest go with the next. */
const PUSH_BATCH = 200;

@Injectable()
export class CalendarSyncService {
  private readonly logger = new Logger(CalendarSyncService.name);

  // queue per calendar; several backend instances would need a database claim instead
  private readonly pushing = new Map<string, Promise<unknown>>();

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly calendars: CalendarsService,
    private readonly access: CalendarAccessService,
    private readonly accounts: CalendarAccountsService,
    private readonly providers: CalendarProvidersService,
    private readonly audit: CalendarAuditService,
    @Optional() private readonly zoomTokens?: ZoomTokensService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** The external calendars an account can offer. */
  async listExternalCalendars(
    accountId: string,
    userId: string,
    organizationId: string,
  ) {
    const account = await this.accounts.getOwned(
      accountId,
      userId,
      organizationId,
    );
    const token = await this.usableToken(account);

    return this.providers.get(account.provider).listCalendars(token);
  }

  /**
   * What the sync remembers about the outside calendar. Empty when the provider couldn't be asked,
   * so the next sync tries again; a calendar the provider doesn't list is remembered without a name.
   */
  private async externalCalendarState(
    api: CalendarProviderApi | undefined,
    token: string,
    externalId: string,
    provider: string,
  ): Promise<Record<string, string>> {
    try {
      const found = (await api?.listCalendars(token))?.find(
        (entry) => entry.id === externalId,
      );
      const name = found?.name?.trim();

      return name
        ? {
            external_calendar_name: name.slice(0, 200),
            external_calendar_provider: provider,
          }
        : { external_calendar_provider: provider };
    } catch {
      return {};
    }
  }

  /** Points a calendar at an external one. Only someone who manages the calendar may do it. */
  async link(
    calendarId: string,
    input: {
      account_id: string;
      external_calendar_id: string;
      direction?: string;
    },
    userId: string,
    organizationId: string,
  ) {
    const calendar = await this.calendars.getForUser(
      calendarId,
      userId,
      organizationId,
      'view',
    );

    this.access.assertAllowed(
      // Only "Link an outside calendar"; the hidden "Manage the connection" box no longer counts
      calendar.permissions.integrations.create,
      'connect this calendar to an outside one',
    );
    const account = await this.accounts.getOwned(
      input.account_id,
      userId,
      organizationId,
    );

    // Zoom meetings can only be read, so a Zoom calendar is never two-way or export.
    const direction = account.provider === 'zoom' ? 'import' : input.direction;

    // Entries show where they came from; a failed lookup just leaves the name out.
    const linkedState = await this.usableToken(account)
      .then((token) =>
        this.externalCalendarState(
          this.providers.get(account.provider),
          token,
          input.external_calendar_id,
          account.provider,
        ),
      )
      .catch(() => ({}));

    const written = await this.client
      .from(CALENDARS)
      .update({
        sync_account_id: input.account_id,
        sync_external_calendar_id: input.external_calendar_id,
        sync_direction: direction ?? 'two_way',
        sync_state: linkedState,
        sync_status: 'idle',
        sync_last_error: null,
        sync_next_attempt_at: new Date().toISOString(),
        updated_by: userId,
      })
      .eq('id', calendarId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (written.error) {
      // The unique index refuses the same external calendar twice in one organization.
      if (written.error.code === '23505') {
        throw new BadRequestException(
          'That external calendar is already linked to another calendar here.',
        );
      }

      throw new BadRequestException(written.error.message);
    }

    // Existing entries go out on the first sync, not only ones saved after linking
    if (direction === 'export' || direction === 'two_way') {
      const queued = await this.client
        .from(EVENTS)
        .update({ sync_pending: true })
        .eq('calendar_id', calendarId)
        .is('external_id', null)
        .is('deleted_at', null);

      if (queued.error) throw new BadRequestException(queued.error.message);

      // Send them now rather than on the next sync
      this.pushSoon(calendarId);
    }

    this.audit.integration('link', organizationId, userId, calendarId, {
      provider: account.provider,
      external_calendar_id: input.external_calendar_id,
      values: CalendarAuditService.valueChanges(
        calendar as unknown as Record<string, unknown>,
        written.data as Record<string, unknown>,
        ['sync_external_calendar_id', 'sync_direction'],
      ),
    });

    return withVisibleShares(
      written.data as Record<string, unknown>,
      calendar.permissions,
    );
  }

  /** Stops syncing. Entries already imported stay, so nothing disappears from anyone's view. */
  async unlink(
    calendarId: string,
    userId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const calendar = await this.calendars.getForUser(
      calendarId,
      userId,
      organizationId,
      'view',
    );

    this.access.assertAllowed(
      calendar.permissions.integrations.stop_sync ||
        calendar.permissions.integrations.delete,
      'stop this calendar syncing',
    );

    const written = await this.client
      .from(CALENDARS)
      .update({
        sync_account_id: null,
        sync_external_calendar_id: null,
        sync_state: {},
        sync_status: 'idle',
        sync_last_error: null,
        updated_by: userId,
      })
      .eq('id', calendarId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (written.error) throw new BadRequestException(written.error.message);

    this.audit.integration('unlink', organizationId, userId, calendarId, {
      external_calendar_id:
        (calendar.sync_external_calendar_id as string | null) ?? null,
      values: CalendarAuditService.valueChanges(
        calendar as unknown as Record<string, unknown>,
        written.data as Record<string, unknown>,
        ['sync_external_calendar_id'],
      ),
    });

    return withVisibleShares(
      written.data as Record<string, unknown>,
      calendar.permissions,
    );
  }

  /**
   * Brings changes in now.
   *
   * A run spends the account owner's stored credential against the provider, so it asks for the same
   * standing linking does — manage on the calendar, and the account must be the caller's own.
   * Otherwise anyone holding edit on a shared calendar could drive someone else's token.
   */
  async runNow(calendarId: string, userId: string, organizationId: string) {
    const calendar = await this.calendars.getForUser(
      calendarId,
      userId,
      organizationId,
      'view',
    );

    this.access.assertAllowed(
      calendar.permissions.integrations.update,
      'run a sync on this calendar',
    );

    if (!calendar.sync_account_id || !calendar.sync_external_calendar_id) {
      throw new BadRequestException(
        'This calendar is not linked to an external one.',
      );
    }

    const account = await this.accounts.getOwned(
      calendar.sync_account_id as string,
      userId,
      organizationId,
    );

    try {
      const sendsOut =
        calendar.sync_direction === 'two_way' ||
        calendar.sync_direction === 'export';
      const pushed = sendsOut
        ? await this.pushPending(
            calendar as unknown as Record<string, unknown>,
            account,
          )
        : { exported: 0, conflicts: 0, duplicates: 0 };

      // Export only never brings anything in
      const outcome =
        calendar.sync_direction === 'export'
          ? { imported: 0, removed: 0, reset: false, skipped: 0 }
          : await this.importInto(
              calendar as unknown as Record<string, unknown>,
            );

      this.audit.integration('sync', organizationId, userId, calendarId, {
        provider: account.provider,
        imported: outcome.imported,
        removed: outcome.removed,
        skipped: outcome.skipped,
        exported: pushed.exported,
        conflicts: pushed.conflicts,
        duplicates: pushed.duplicates,
      });

      return { ...outcome, ...pushed };
    } catch (failure) {
      this.audit.integration(
        'sync_failed',
        organizationId,
        userId,
        calendarId,
        {
          provider: account.provider,
          error: failure instanceof Error ? failure.message : 'sync failed',
        },
      );

      throw failure;
    }
  }

  /**
   * Sends local changes out, right after a save, so a two-way calendar does not wait for the next run.
   * Fire-and-forget: a failure stays pending and goes out with the next run instead.
   */
  pushSoon(calendarId: string): void {
    void (async () => {
      const read = await this.client
        .from(CALENDARS)
        .select('*')
        .eq('id', calendarId)
        .maybeSingle();

      const calendar = read.data as Record<string, unknown> | null;

      if (
        !calendar ||
        (calendar.sync_direction !== 'two_way' &&
          calendar.sync_direction !== 'export') ||
        !calendar.sync_account_id
      )
        return;

      const account = await this.accounts.getById(
        calendar.sync_account_id as string,
      );

      if (account) await this.pushPending(calendar, account);
    })().catch((failure: unknown) =>
      this.logger.warn(
        `Calendar ${calendarId}: sending changes out failed — ${String(failure)}`,
      ),
    );
  }

  /**
   * Local creates, edits and deletes still waiting to reach the provider. One that changed there since
   * the last read is not overwritten: it is marked as a conflict and the next import brings their version.
   */
  async pushPending(
    calendar: Record<string, unknown>,
    account: CalendarAccountRow,
  ): Promise<{ exported: number; conflicts: number; duplicates: number }> {
    const id = calendar.id as string;

    // One push per calendar at a time: two at once would both create the same entry at the provider
    const run = (this.pushing.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.pushPendingNow(calendar, account));

    this.pushing.set(id, run);

    void run
      .finally(() => {
        if (this.pushing.get(id) === run) this.pushing.delete(id);
      })
      .catch(() => undefined);

    return run;
  }

  /** The push itself; always reached through `pushPending`, which keeps runs for a calendar apart. */
  private async pushPendingNow(
    calendar: Record<string, unknown>,
    account: CalendarAccountRow,
  ): Promise<{ exported: number; conflicts: number; duplicates: number }> {
    const api = this.providers.get(account.provider);

    // A published link or a booking page cannot be written to.
    if (!api.createEvent || !api.updateEvent || !api.deleteEvent) {
      return { exported: 0, conflicts: 0, duplicates: 0 };
    }

    const { data, error } = await this.client
      .from(EVENTS)
      .select('*')
      .eq('calendar_id', calendar.id as string)
      .eq('sync_pending', true)
      .limit(PUSH_BATCH);

    if (error) throw new BadRequestException(error.message);

    const token = await this.usableToken(account);
    const target = calendar.sync_external_calendar_id as string;
    let exported = 0;
    let conflicts = 0;
    let duplicates = 0;

    const rows = (data ?? []) as Array<Record<string, unknown>>;

    // What the outside calendar already holds for the entries about to be created, read once per run
    const existing = await this.existingOutside(
      api,
      token,
      target,
      calendar.id as string,
      rows,
    );

    for (const row of rows) {
      const externalId = (row.external_id as string | null) ?? null;

      try {
        if (row.deleted_at) {
          if (externalId) await api.deleteEvent(token, target, externalId);
          await this.settle(row.id as string, {});
        } else if (!(typeof row.summary === 'string' && row.summary.trim())) {
          // An entry without a title is never sent out, as it is never brought in
          await this.settle(row.id as string, {
            sync_conflict: {
              reason: 'Entry has no title',
              at: new Date().toISOString(),
            },
          });
          continue;
        } else if (!externalId) {
          // The outside calendar could not be checked: stay pending rather than risk a duplicate
          if (existing === null) continue;

          const key = CalendarSyncService.matchKey(row);
          const match = existing.get(key);

          // Already there: not sent again, tied to the outside event so neither side gets a copy
          if (match) {
            existing.delete(key);
            await this.settle(row.id as string, {
              external_id: match.external_id,
              external_etag: match.etag,
            });
            duplicates += 1;
            continue;
          }

          const made = await api.createEvent(
            token,
            target,
            CalendarSyncService.outgoing(row),
          );

          await this.settle(row.id as string, {
            external_id: made.external_id,
            external_etag: made.etag,
          });
        } else {
          const changed = await api.updateEvent(
            token,
            target,
            externalId,
            CalendarSyncService.outgoing(row),
            (row.external_etag as string | null) ?? null,
          );

          await this.settle(row.id as string, { external_etag: changed.etag });
        }

        exported += 1;
      } catch (failure) {
        if (failure instanceof ProviderConflictError) {
          conflicts += 1;
          await this.settle(row.id as string, {
            sync_conflict: {
              reason: failure.message,
              at: new Date().toISOString(),
            },
          });
        } else {
          // Left pending, so the next run tries again.
          this.logger.warn(
            `Calendar ${calendar.id as string}: entry ${row.id as string} not sent — ${String(failure)}`,
          );
        }
      }
    }

    return { exported, conflicts, duplicates };
  }

  /**
   * The outside events that match entries about to be created, by title and time. Events already tied to
   * an entry here are left out, so one outside event is never claimed twice. `null` when it could not be read.
   */
  private async existingOutside(
    api: { listEvents: CalendarProviderApi['listEvents'] },
    token: string,
    target: string,
    calendarId: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<Map<string, ExternalEvent> | null> {
    const creates = rows.filter(
      (row) =>
        !row.deleted_at &&
        !row.external_id &&
        typeof row.summary === 'string' &&
        row.summary.trim(),
    );

    const times = creates
      .flatMap((row) => [
        row.starts_at ?? row.start_date,
        row.ends_at ?? row.end_date,
      ])
      .filter((value): value is string => typeof value === 'string')
      .map((value) =>
        Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value),
      )
      .filter((value) => !Number.isNaN(value));

    if (times.length === 0) return new Map();

    try {
      // A day either side, so an all-day entry or a time zone shift is still inside the window
      const { events } = await api.listEvents(token, target, {
        from: new Date(Math.min(...times) - DAY_MS).toISOString(),
        to: new Date(Math.max(...times) + DAY_MS).toISOString(),
      });

      const ids = events.map((event) => event.external_id);
      const taken = new Set<string>();

      if (ids.length > 0) {
        const linked = await this.client
          .from(EVENTS)
          .select('external_id')
          .eq('calendar_id', calendarId)
          .in('external_id', ids);

        if (linked.error) throw new Error(linked.error.message);

        for (const row of (linked.data ?? []) as Array<{
          external_id: string;
        }>) {
          taken.add(row.external_id);
        }
      }

      const found = new Map<string, ExternalEvent>();

      for (const event of events) {
        if (
          event.cancelled ||
          taken.has(event.external_id) ||
          !event.summary.trim()
        )
          continue;

        const key = CalendarSyncService.matchKey(event);

        if (!found.has(key)) found.set(key, event);
      }

      return found;
    } catch (failure) {
      this.logger.warn(
        `Calendar ${calendarId}: could not check the outside calendar before sending — ${String(failure)}`,
      );

      return null;
    }
  }

  /**
   * Title and time, the way an entry and an outside event are judged the same. All-day ones compare the
   * start date only, because providers count the end date differently.
   */
  private static matchKey(event: {
    summary?: unknown;
    is_all_day?: unknown;
    starts_at?: unknown;
    ends_at?: unknown;
    start_date?: unknown;
  }): string {
    const title =
      typeof event.summary === 'string'
        ? event.summary.trim().toLowerCase()
        : '';
    const text = (value: unknown) => (typeof value === 'string' ? value : '');

    if (event.is_all_day === true) {
      return `${title}|day|${text(event.start_date)}`;
    }

    const at = (value: unknown) =>
      typeof value === 'string' ? Date.parse(value) : Number.NaN;

    return `${title}|${at(event.starts_at)}|${at(event.ends_at)}`;
  }

  /** Marks an entry as having reached the provider, with whatever the provider handed back. */
  private async settle(
    id: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.client
      .from(EVENTS)
      .update({ sync_pending: false, ...fields })
      .eq('id', id);

    if (error) throw new BadRequestException(error.message);
  }

  /** An entry as a provider receives it. */
  private static outgoing(row: Record<string, unknown>): OutgoingEvent {
    return {
      summary: row.summary as string,
      description: (row.description as string | null) ?? null,
      location: (row.location as string | null) ?? null,
      is_all_day: row.is_all_day === true,
      starts_at: (row.starts_at as string | null) ?? null,
      ends_at: (row.ends_at as string | null) ?? null,
      start_date: (row.start_date as string | null) ?? null,
      end_date: (row.end_date as string | null) ?? null,
      timezone: (row.timezone as string | null) ?? 'UTC',
    };
  }

  /**
   * Reads the changes the provider reports and writes them in.
   *
   * A stale position token means the provider forgot where we were; the window is simply read again,
   * and matching on the external id keeps that from duplicating anything.
   */
  async importInto(calendar: Record<string, unknown>): Promise<{
    imported: number;
    removed: number;
    reset: boolean;
    skipped: number;
    skippedDuplicates?: number;
    skippedDuplicateTitles?: string[];
    notRestored?: number;
    notRestoredTitles?: string[];
  }> {
    const accountId = calendar.sync_account_id as string;
    const account = await this.accounts.getById(accountId);

    if (!account)
      throw new BadRequestException('The connected account is gone.');

    const token = await this.usableToken(account);
    const externalId = calendar.sync_external_calendar_id as string;
    const state = (calendar.sync_state as Record<string, unknown>) ?? {};
    const now = Date.now();

    const api = this.providers.get(account.provider);

    // A Zoom failure is a 4xx with Zoom's own words, and a refused token marks the account "Reconnect".
    const list = async (options: {
      syncToken?: string | null;
      from?: string;
      to?: string;
    }) => {
      try {
        return await api.listEvents(token, externalId, options);
      } catch (error) {
        if (account.provider !== 'zoom') throw error;

        const message =
          error instanceof Error ? error.message : 'Zoom request failed';

        if (message.endsWith('(401)')) {
          await this.zoomTokens?.invalid(account.id, message);
        }

        throw error instanceof BadRequestException
          ? error
          : new BadRequestException(message);
      }
    };

    let result = await list({
      syncToken: (state.sync_token as string) ?? null,
      from: new Date(now - IMPORT_PAST_DAYS * DAY_MS).toISOString(),
      to: new Date(now + IMPORT_FUTURE_DAYS * DAY_MS).toISOString(),
    });

    let reset = false;

    if (result.expired) {
      reset = true;
      result = await list({
        from: new Date(now - IMPORT_PAST_DAYS * DAY_MS).toISOString(),
        to: new Date(now + IMPORT_FUTURE_DAYS * DAY_MS).toISOString(),
      });
    }

    let imported = 0;
    let removed = 0;
    let skipped = 0;
    const seen = new Set<string>();
    const duplicateTitles: string[] = [];
    const notRestoredTitles: string[] = [];

    for (const event of result.events) {
      seen.add(event.external_id);

      if (event.cancelled) {
        removed += await this.tombstone(calendar, event);
        continue;
      }

      // An entry without a title is never stored; a copy imported earlier is removed
      if (!event.summary.trim()) {
        removed += await this.dropUntitled(calendar, event);
        skipped += 1;
        continue;
      }

      // Only a Zoom meeting is checked for an entry it already has elsewhere.
      const decision = await this.upsert(
        calendar,
        event,
        account.provider,
        account.provider === 'zoom'
          ? () => this.alreadyHasEntry(calendar, event, account)
          : undefined,
      );

      if (decision === 'written') imported += 1;

      if (decision === 'duplicate') duplicateTitles.push(event.summary);

      if (decision === 'deleted_here') notRestoredTitles.push(event.summary);
    }

    // Only a provider that read its whole window can say what is gone; ended meetings drop off Zoom's
    // list, so only entries still to come are removed. After a relink to another account the first run
    // only imports, so the old account's entries are not taken for deleted.
    if (result.complete && state.imported_by === account.id) {
      removed += await this.removeUnlisted(
        calendar,
        account.provider,
        seen,
        new Date(now + IMPORT_FUTURE_DAYS * DAY_MS).toISOString(),
      );
    }

    const finishedAt = new Date().toISOString();

    await this.client
      .from(CALENDARS)
      .update({
        sync_state: {
          ...state,
          sync_token: result.nextSyncToken ?? null,
          imported_by: account.id,
          ...(state.external_calendar_provider === account.provider
            ? {}
            : await this.externalCalendarState(
                api,
                token,
                externalId,
                account.provider,
              )),
        },
        sync_status: 'idle',
        sync_last_error: null,
        sync_last_synced_at: finishedAt,
        sync_attempts: 0,
      })
      .eq('id', calendar.id as string);

    // The integrations screen reads the account, not the calendar, so it is stamped too.
    await this.client
      .from(ACCOUNTS)
      .update({ last_synced_at: finishedAt })
      .eq('id', account.id);

    this.logger.log(
      `Calendar ${calendar.id as string}: ${imported} entries in, ${removed} removed${reset ? ' (position reset)' : ''}`,
    );

    return {
      imported,
      removed,
      reset,
      skipped,
      ...(duplicateTitles.length > 0
        ? {
            skippedDuplicates: duplicateTitles.length,
            skippedDuplicateTitles: duplicateTitles.slice(0, SKIPPED_TITLES),
          }
        : {}),
      ...(notRestoredTitles.length > 0
        ? {
            notRestored: notRestoredTitles.length,
            notRestoredTitles: notRestoredTitles.slice(0, SKIPPED_TITLES),
          }
        : {}),
    };
  }

  /**
   * Whether this Zoom meeting, at this start, already has a live entry the person can see as theirs:
   * in a calendar they own, one they host, or one synced from this same account. Its own row in this
   * calendar is not a duplicate; that one is simply updated.
   */
  private async alreadyHasEntry(
    calendar: Record<string, unknown>,
    event: ExternalEvent,
    account: CalendarAccountRow,
  ): Promise<boolean> {
    const meetingId = zoomMeetingId(event.meeting_url);
    const start = event.starts_at ? Date.parse(event.starts_at) : NaN;

    if (!meetingId || Number.isNaN(start)) return false;

    const found = await this.client
      .from(EVENTS)
      .select(
        'calendar_id, external_id, starts_at, meeting_id, meeting_url, meeting_host_user_id, calendars!inner(owner_id, sync_account_id)',
      )
      .eq('organization_id', calendar.organization_id as string)
      .is('deleted_at', null)
      // A second either side covers stored formats; the exact instant is checked per row below.
      .gte('starts_at', new Date(start - 1000).toISOString())
      .lte('starts_at', new Date(start + 1000).toISOString())
      .or(
        `meeting_id.eq.${meetingId},meeting_url.ilike.%/j/${meetingId}%,meeting_url.ilike.%/s/${meetingId}%,meeting_url.ilike.%/w/${meetingId}%`,
      );

    if (found.error) throw new BadRequestException(found.error.message);

    return (
      (found.data ?? []) as unknown as {
        calendar_id: string;
        external_id: string | null;
        starts_at: string | null;
        meeting_id: string | null;
        meeting_url: string | null;
        meeting_host_user_id: string | null;
        calendars: { owner_id: string | null; sync_account_id: string | null };
      }[]
    ).some(
      (row) =>
        !(
          row.calendar_id === calendar.id &&
          row.external_id === event.external_id
        ) &&
        row.starts_at !== null &&
        Date.parse(row.starts_at) === start &&
        // The link filter matches by prefix (`/j/123` also finds `/j/1234`), so the id is checked exactly.
        (String(row.meeting_id ?? '') === meetingId ||
          zoomMeetingId(row.meeting_url) === meetingId) &&
        (row.calendars.owner_id === account.user_id ||
          row.meeting_host_user_id === account.user_id ||
          row.calendars.sync_account_id === account.id),
    );
  }

  /** Entries still to come that the provider no longer lists: deleted there, so tombstoned here. */
  private async removeUnlisted(
    calendar: Record<string, unknown>,
    source: string,
    seen: Set<string>,
    until: string,
  ): Promise<number> {
    const live = await this.client
      .from(EVENTS)
      .select('id, external_id')
      .eq('calendar_id', calendar.id as string)
      .eq('organization_id', calendar.organization_id as string)
      .eq('source', source)
      .is('deleted_at', null)
      .gte('starts_at', new Date().toISOString())
      .lte('starts_at', until);

    if (live.error) throw new BadRequestException(live.error.message);

    const gone = (
      (live.data ?? []) as { id: string; external_id: string | null }[]
    )
      .filter((row) => row.external_id && !seen.has(row.external_id))
      .map((row) => row.id);

    if (gone.length === 0) return 0;

    let removed = 0;

    for (let at = 0; at < gone.length; at += TOMBSTONE_CHUNK) {
      const written = await this.client
        .from(EVENTS)
        .update({ deleted_at: new Date().toISOString() })
        .in('id', gone.slice(at, at + TOMBSTONE_CHUNK))
        .eq('calendar_id', calendar.id as string)
        .eq('organization_id', calendar.organization_id as string)
        .is('deleted_at', null)
        .select('id');

      if (written.error) throw new BadRequestException(written.error.message);

      removed += (written.data ?? []).length;
    }

    return removed;
  }

  /**
   * One external entry, written in or updated in place. `isDuplicate` is asked only when this calendar
   * has no row for it yet, so an entry imported here earlier keeps updating.
   */
  private async upsert(
    calendar: Record<string, unknown>,
    event: ExternalEvent,
    source: string,
    isDuplicate?: () => Promise<boolean>,
  ): Promise<UpsertDecision> {
    const row = {
      organization_id: calendar.organization_id as string,
      calendar_id: calendar.id as string,
      summary: event.summary.slice(0, 500),
      description: event.description,
      location: event.location?.slice(0, 1024) ?? null,
      is_all_day: event.is_all_day,
      starts_at: event.starts_at,
      ends_at: event.ends_at,
      start_date: event.start_date,
      end_date: event.end_date,
      timezone:
        event.timezone ?? (calendar.default_timezone as string) ?? 'UTC',
      meeting_url: event.meeting_url,
      meeting_provider: this.meetingProvider(event.meeting_url),
      source,
      external_id: event.external_id,
      external_etag: event.etag,
      external_recurring_id: event.recurring_id,
      sync_read_only: event.read_only,
      sync_pending: false,
      deleted_at: null,
    };

    const existing = await this.client
      .from(EVENTS)
      .select('id, sync_pending, external_etag, deleted_at, meeting_status')
      .eq('calendar_id', calendar.id as string)
      .eq('external_id', event.external_id)
      .maybeSingle();

    if (existing.error) throw new BadRequestException(existing.error.message);

    // A local change still waiting to go out wins until it has; overwriting it would lose the edit.
    if (existing.data?.sync_pending === true) return 'kept';

    // A Zoom entry someone deleted here stays deleted; other providers keep restoring it.
    if (existing.data?.deleted_at && source === 'zoom') return 'deleted_here';

    // The same version we already hold is our own write coming back; there is nothing new in it.
    if (
      existing.data &&
      event.etag &&
      existing.data.external_etag === event.etag
    )
      return 'kept';

    if (!existing.data && isDuplicate && (await isDuplicate())) {
      return 'duplicate';
    }

    // A meeting made here keeps its link; an outside copy without it would leave the meeting orphaned.
    const ownMeeting =
      existing.data?.meeting_status === 'created' ||
      existing.data?.meeting_status === 'pending';
    const changes = ownMeeting
      ? Object.fromEntries(
          Object.entries(row).filter(
            ([key]) => key !== 'meeting_url' && key !== 'meeting_provider',
          ),
        )
      : row;

    const written = existing.data
      ? await this.client
          .from(EVENTS)
          .update(changes)
          .eq('id', existing.data.id as string)
      : await this.client.from(EVENTS).insert(row);

    if (written.error) {
      // A single unusable entry must not stop the rest of the import.
      this.logger.warn(
        `Calendar ${calendar.id as string}: skipped ${event.external_id} — ${written.error.message}`,
      );

      return 'kept';
    }

    return 'written';
  }

  /** The link's host names the meeting, so an imported one reads as Meet, Teams or Zoom, not just a link. */
  private meetingProvider(url: string | null): string | null {
    if (!url) return null;

    let host = '';

    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return 'custom';
    }

    if (host === 'meet.google.com') return 'google_meet';

    if (
      host.endsWith('teams.microsoft.com') ||
      host.endsWith('teams.live.com')
    ) {
      return 'teams';
    }

    if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom';

    return 'custom';
  }

  /** An entry cancelled at the provider becomes a tombstone here, never a hard delete. */
  private async tombstone(
    calendar: Record<string, unknown>,
    event: ExternalEvent,
  ): Promise<number> {
    const written = await this.client
      .from(EVENTS)
      .update({ deleted_at: new Date().toISOString() })
      .eq('calendar_id', calendar.id as string)
      .eq('external_id', event.external_id)
      .is('deleted_at', null);

    return written.error ? 0 : 1;
  }

  /** Soft-deletes a stored copy whose title was cleared at the provider; returns how many went. */
  private async dropUntitled(
    calendar: Record<string, unknown>,
    event: ExternalEvent,
  ): Promise<number> {
    const { data, error } = await this.client
      .from(EVENTS)
      .update({ deleted_at: new Date().toISOString() })
      .eq('calendar_id', calendar.id as string)
      .eq('external_id', event.external_id)
      .is('deleted_at', null)
      // A local edit still waiting to go out is never lost
      .eq('sync_pending', false)
      .select('id');

    return error ? 0 : (data?.length ?? 0);
  }

  /** A token that is good right now, refreshing it first when it is close to expiry. */
  private async usableToken(account: CalendarAccountRow): Promise<string> {
    // Zoom rotates its refresh token, so it goes through the one place that refreshes it under a lease.
    if (account.provider === 'zoom' && this.zoomTokens) {
      try {
        return (
          await this.zoomTokens.forPerson(
            account.user_id,
            account.organization_id,
          )
        ).token;
      } catch (error) {
        // Its errors are plain ones; the caller should get a 4xx with the same words, not a 500.
        throw error instanceof BadRequestException
          ? error
          : new BadRequestException(
              error instanceof Error ? error.message : 'Zoom sign-in failed',
            );
      }
    }

    const { accessToken, refreshToken, expiresAt } =
      this.accounts.tokens(account);

    // A published link never expires and has nothing to refresh; it is the credential itself.
    if (this.providers.isLinkBased(account.provider)) {
      return accessToken ?? (account.external_account_id as string) ?? '';
    }
    const expiringSoon = expiresAt
      ? Date.parse(expiresAt) - Date.now() < 60_000
      : false;

    if (accessToken && !expiringSoon) return accessToken;

    if (!refreshToken) {
      await this.accounts.markNeedsReconnect(
        account.id,
        'No refresh token stored — reconnect the account.',
      );

      throw new BadRequestException(
        'Reconnect this calendar account to continue syncing.',
      );
    }

    try {
      const refreshed = await this.providers
        .get(account.provider)
        .refresh(refreshToken);

      await this.accounts.storeRefreshed(
        account.id,
        refreshed.accessToken,
        refreshed.expiresAt,
        refreshed.refreshToken,
      );

      return refreshed.accessToken;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'refresh failed';

      await this.accounts.markNeedsReconnect(account.id, reason);

      throw new BadRequestException(
        `Reconnect this calendar account: ${reason}`,
      );
    }
  }
}
