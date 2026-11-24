/**
 * @fileoverview Read-only list of entries brought in from connected calendars.
 *
 * Limited to calendars whose synced copies the caller may already read, so it reveals nothing the
 * calendar view would not.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { CalendarAccessService } from '../calendar-access.service';
import type { CalendarWithAccess } from '../calendars.service';
import { CalendarsService } from '../calendars.service';
import { importRecordPageSchema } from '../dto/calendar-import-records.schemas';
import type {
  ImportRecordProvider,
  ImportRecordSort,
  ListImportRecordsDto,
} from '../dto/list-import-records.dto';
import { IMPORT_RECORD_PROVIDERS } from '../dto/list-import-records.dto';

// Never the sync bookkeeping or meeting columns; typed string so the filter chain stays checkable.
const EVENT_COLUMNS: string =
  'id,calendar_id,summary,description,location,is_all_day,starts_at,ends_at,start_date,end_date,timezone,source,external_id,sync_read_only,deleted_at,created_at,updated_at';

const DESCRIPTION_MAX = 2000;

// Only what sorting needs; descriptions stay out so a full pass over the rows stays light.
const SORT_COLUMNS: string =
  'id,calendar_id,summary,is_all_day,starts_at,ends_at,start_date,end_date,source,deleted_at,updated_at';

// The database hands back at most this many rows per request.
const SORT_CHUNK = 1000;

// sorting reads every matching row's keys; a view with sort columns if an org passes this
const SORT_MAX_ROWS = 10000;

// Same names the screen shows, so the Source column sorts the way it reads.
const SOURCE_LABEL: Record<string, string> = {
  google: 'Google Calendar',
  microsoft: 'Microsoft Outlook',
  calendly: 'Calendly',
  ics: 'Calendar link',
  zoom: 'Zoom',
};

// Problems first when sorted ascending.
const STATUS_RANK: Record<string, number> = {
  reconnect: 0,
  error: 1,
  unlinked: 2,
  removed: 3,
  synced: 4,
};

const collator = new Intl.Collator('en', {
  sensitivity: 'base',
  numeric: true,
});

const DAY_MS = 86_400_000;

export type ImportRecordStatus =
  | 'synced'
  | 'removed'
  | 'unlinked'
  | 'reconnect'
  | 'error';

export interface ImportRecordView {
  id: string;
  calendar_id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  is_all_day: boolean;
  starts_at: string | null;
  ends_at: string | null;
  start_date: string | null;
  end_date: string | null;
  timezone: string | null;
  source: string;
  external_id: string | null;
  sync_read_only: boolean;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  calendar: {
    id: string;
    name: string;
    color: string | null;
    space_id: string | null;
  };
  account: {
    provider: string;
    display_name: string | null;
    status: string;
  } | null;
  last_synced_at: string | null;
  status: ImportRecordStatus;
}

export interface ImportRecordPage {
  items: ImportRecordView[];
  total: number;
  page: number;
  limit: number;
}

interface ImportAccountRow {
  id: string;
  user_id: string;
  provider: ImportRecordProvider;
  display_name: string | null;
  status: string;
  last_synced_at: string | null;
}

interface ImportEventRow {
  id: string;
  calendar_id: string;
  summary: unknown;
  description: unknown;
  location: unknown;
  is_all_day: boolean | null;
  starts_at: string | null;
  ends_at: string | null;
  start_date: string | null;
  end_date: string | null;
  timezone: unknown;
  source: string;
  external_id: string | null;
  sync_read_only: boolean | null;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Trimmed text, or null when blank or not text at all. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();

  return trimmed === '' ? null : trimmed;
}

/** A stored instant, or a `YYYY-MM-DD` day as UTC midnight, as a number; null when missing or invalid. */
function timeOf(value: string | null, shiftDays = 0): number | null {
  if (!value) return null;

  const ms = Date.parse(value);

  return Number.isNaN(ms) ? null : ms + shiftDays * DAY_MS;
}

/** The value one column is sorted on: text, a number, or null for "nothing to show". */
function sortKey(
  view: ImportRecordView,
  sort: ImportRecordSort,
): string | number | null {
  switch (sort) {
    case 'source':
      return SOURCE_LABEL[view.source] ?? view.source;
    case 'event':
      return view.summary;
    case 'calendar':
      return view.calendar.name || null;
    case 'starts':
      return view.is_all_day ? timeOf(view.start_date) : timeOf(view.starts_at);

    // All-day ends are stored as the day after; sort on the last day shown.
    case 'ends':
      return view.is_all_day ? timeOf(view.end_date, -1) : timeOf(view.ends_at);
    case 'status':
      return STATUS_RANK[view.status] ?? null;
    case 'last_synced':
      return timeOf(view.last_synced_at);
  }
}

/** Newest change first, then id, so rows with equal keys keep one stable order across pages. */
function byNewest(a: ImportRecordView, b: ImportRecordView): number {
  const updated = (timeOf(b.updated_at) ?? 0) - (timeOf(a.updated_at) ?? 0);

  return updated !== 0 ? updated : b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
}

function accountIdOf(calendar: CalendarWithAccess): string {
  return typeof calendar.sync_account_id === 'string'
    ? calendar.sync_account_id
    : '';
}

function isProvider(value: unknown): value is ImportRecordProvider {
  return (IMPORT_RECORD_PROVIDERS as readonly unknown[]).includes(value);
}

@Injectable()
export class CalendarImportRecordsService {
  private readonly logger = new Logger(CalendarImportRecordsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly calendars: CalendarsService,
    private readonly access: CalendarAccessService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async list(
    userId: string,
    organizationId: string,
    dto: ListImportRecordsDto,
  ): Promise<ImportRecordPage> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    const status = dto.status ?? 'synced';
    const q = dto.q ? dto.q.trim() : '';
    const empty: ImportRecordPage = { items: [], total: 0, page, limit };

    const visible = await this.calendars.listVisible(userId, organizationId);
    // Imported records follow their own box only, "See imported records"
    let readable = visible.filter(
      (calendar) =>
        calendar.permissions?.sync?.read === true &&
        calendar.permissions?.integrations?.records === true,
    );

    // An unreadable or unknown id gives an empty page, so existence is never revealed.
    if (dto.calendar_id) {
      readable = readable.filter((calendar) => calendar.id === dto.calendar_id);
    }

    if (readable.length === 0) return empty;

    const accounts = await this.loadAccounts(organizationId, readable);
    const calendarsById = new Map(readable.map((c) => [c.id, c]));
    const readableIds = readable.map((c) => c.id);

    const linkedByProvider = new Map<ImportRecordProvider, string[]>();
    const unlinkedIds: string[] = [];

    for (const calendar of readable) {
      const account = accounts.get(accountIdOf(calendar));

      if (!account) {
        unlinkedIds.push(calendar.id);
        continue;
      }

      const ids = linkedByProvider.get(account.provider) ?? [];

      ids.push(calendar.id);
      linkedByProvider.set(account.provider, ids);
    }

    let statusOr: string | null = null;

    if (status === 'synced') {
      const branches = [...linkedByProvider].map(
        ([provider, ids]) =>
          `and(calendar_id.in.(${ids.join(',')}),source.eq.${provider})`,
      );

      if (branches.length === 0) return empty;
      statusOr = branches.join(',');
    } else if (status === 'unlinked') {
      const branches = [...linkedByProvider].map(
        ([provider, ids]) =>
          `and(calendar_id.in.(${ids.join(',')}),source.neq.${provider})`,
      );

      if (unlinkedIds.length > 0) {
        branches.unshift(`calendar_id.in.(${unlinkedIds.join(',')})`);
      }

      if (branches.length === 0) return empty;
      statusOr = branches.join(',');
    }

    // Search covers the title and the calendar's name, matched here so the text never reaches a filter.
    const needle = q.toLocaleLowerCase();
    const matches = (view: ImportRecordView) =>
      (view.summary ?? '').toLocaleLowerCase().includes(needle) ||
      view.calendar.name.toLocaleLowerCase().includes(needle);

    // Built twice when a page is past the end: once for rows, once for the count alone.
    const filtered = (head: boolean, columns: string = EVENT_COLUMNS) => {
      let query = this.client
        .from('calendar_events')
        .select(columns, { count: 'exact', head })
        .eq('organization_id', organizationId)
        .not('external_id', 'is', null);

      // Always narrowed: listVisible omits hidden calendars, so skipping this would count their rows.
      // .in() of all readable ids, fine to a few hundred calendars; chunk or RPC beyond
      query = query.in('calendar_id', readableIds);
      if (dto.provider) query = query.eq('source', dto.provider);
      if (status === 'removed')
        query = query.filter('deleted_at', 'not.is', null);

      if (statusOr) {
        query = query.is('deleted_at', null).or(statusOr);
      }

      return query;
    };

    // A search, or a column the database cannot order on by itself (two date columns, a worked-out
    // status, the calendar's name): read every matching row's keys, filter and order them here, then
    // load one page.
    if (dto.sort || needle) {
      const sort = dto.sort;
      const direction = dto.dir === 'desc' ? -1 : 1;
      const keys: ImportEventRow[] = [];

      for (let from = 0; ; from += SORT_CHUNK) {
        const chunk = await filtered(false, SORT_COLUMNS)
          .order('id', { ascending: true })
          .range(from, from + SORT_CHUNK - 1);

        if (chunk.error) throw new BadRequestException(chunk.error.message);

        const rows = (chunk.data ?? []) as unknown as ImportEventRow[];

        keys.push(...rows);

        if (keys.length > SORT_MAX_ROWS) {
          throw new BadRequestException(
            'Too many imported records to sort or search; narrow the list with a filter first.',
          );
        }

        if (rows.length < SORT_CHUNK) break;
      }

      const isAdmin = await this.access.isOrgAdmin(userId, organizationId);
      const ordered = keys
        .flatMap((row) => {
          const calendar = calendarsById.get(row.calendar_id);

          return calendar
            ? [this.view(row, calendar, accounts, userId, isAdmin)]
            : [];
        })
        .filter((view) => !needle || matches(view))
        .sort((a, b) => {
          if (!sort) return byNewest(a, b);

          const left = sortKey(a, sort);
          const right = sortKey(b, sort);

          // Blanks go last whichever way the column is sorted.
          if (left === null || right === null) {
            return left === right ? byNewest(a, b) : left === null ? 1 : -1;
          }

          const compared =
            typeof left === 'number' && typeof right === 'number'
              ? left - right
              : collator.compare(String(left), String(right));

          return compared !== 0 ? compared * direction : byNewest(a, b);
        });

      const total = ordered.length;
      const pageIds = ordered
        .slice((page - 1) * limit, page * limit)
        .map((view) => view.id);

      if (pageIds.length === 0) return this.checked({ ...empty, total });

      const full = await this.client
        .from('calendar_events')
        .select(EVENT_COLUMNS)
        .eq('organization_id', organizationId)
        .in('id', pageIds);

      if (full.error) throw new BadRequestException(full.error.message);

      const byId = new Map(
        ((full.data ?? []) as unknown as ImportEventRow[]).map((row) => [
          row.id,
          row,
        ]),
      );

      const items = pageIds.flatMap((id) => {
        const row = byId.get(id);
        const calendar = row ? calendarsById.get(row.calendar_id) : undefined;

        return row && calendar
          ? [this.view(row, calendar, accounts, userId, isAdmin)]
          : [];
      });

      return this.checked({ items, total, page, limit });
    }

    const { data, error, count } = await filtered(false)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error) {
      // A page past the end fails with an unreliable code/body, so recount instead of trusting it.
      if (page > 1) {
        const head = await filtered(true);
        const total = head.count ?? 0;

        if (!head.error && (page - 1) * limit >= total) {
          return { ...empty, total };
        }
      }

      throw new BadRequestException(error.message);
    }

    const rows = (data ?? []) as unknown as ImportEventRow[];
    const isAdmin =
      rows.length > 0
        ? await this.access.isOrgAdmin(userId, organizationId)
        : false;

    const items = rows.flatMap((row) => {
      const calendar = calendarsById.get(row.calendar_id);

      return calendar
        ? [this.view(row, calendar, accounts, userId, isAdmin)]
        : [];
    });

    return this.checked({
      items,
      total: count ?? items.length,
      page,
      limit,
    });
  }

  /** Warn-only shape check, as the other calendar routes do through their interceptor. */
  private checked(result: ImportRecordPage): ImportRecordPage {
    const check = importRecordPageSchema.safeParse(result);

    if (!check.success) {
      this.logger.warn(
        `GET calendar/integrations/records returned a page that does not match its shape: ${check.error.message}`,
      );
    }

    return result;
  }

  /** The accounts behind the readable calendars, by id; never the secret columns. */
  private async loadAccounts(
    organizationId: string,
    readable: CalendarWithAccess[],
  ): Promise<Map<string, ImportAccountRow>> {
    const ids = [
      ...new Set(
        readable
          .map((calendar) => calendar.sync_account_id)
          .filter((id): id is string => typeof id === 'string' && id !== ''),
      ),
    ];
    const accounts = new Map<string, ImportAccountRow>();

    if (ids.length === 0) return accounts;

    const { data, error } = await this.client
      .from('calendar_accounts')
      .select('id,user_id,provider,display_name,status,last_synced_at')
      .eq('organization_id', organizationId)
      .in('id', ids);

    if (error) throw new BadRequestException(error.message);

    // Only known providers, since the provider goes into a filter string.
    for (const account of (data ?? []) as ImportAccountRow[]) {
      if (isProvider(account.provider)) accounts.set(account.id, account);
    }

    return accounts;
  }

  private view(
    row: ImportEventRow,
    calendar: CalendarWithAccess,
    accounts: Map<string, ImportAccountRow>,
    userId: string,
    isAdmin: boolean,
  ): ImportRecordView {
    const linked = accounts.get(accountIdOf(calendar));

    // Only the account that imported this row counts.
    const account = linked && linked.provider === row.source ? linked : null;
    const description = text(row.description);
    const color = typeof calendar.color === 'string' ? calendar.color : '';
    const calendarSynced =
      typeof calendar.sync_last_synced_at === 'string'
        ? calendar.sync_last_synced_at
        : null;

    let status: ImportRecordStatus = 'synced';

    if (row.deleted_at) status = 'removed';
    else if (!account) status = 'unlinked';
    else if (
      account.status === 'reauth_required' ||
      account.status === 'revoked'
    )
      status = 'reconnect';
    else if (calendar.sync_status === 'error') status = 'error';

    return {
      id: row.id,
      calendar_id: row.calendar_id,
      summary: text(row.summary),
      description: description ? description.slice(0, DESCRIPTION_MAX) : null,
      location: text(row.location),
      is_all_day: row.is_all_day === true,
      starts_at: row.starts_at ?? null,
      ends_at: row.ends_at ?? null,
      start_date: row.start_date ?? null,
      end_date: row.end_date ?? null,
      timezone: text(row.timezone),
      source: row.source,
      external_id: row.external_id ?? null,
      sync_read_only: row.sync_read_only === true,
      deleted_at: row.deleted_at ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
      calendar: {
        id: calendar.id,
        name: typeof calendar.name === 'string' ? calendar.name : '',
        color: /^#[0-9a-f]{3,8}$/i.test(color) ? color : null,
        space_id: calendar.space_id ?? null,
      },
      account: account
        ? {
            provider: account.provider,

            // Whose account it is stays private unless it is the caller's or they are an admin.
            display_name:
              account.user_id === userId || isAdmin
                ? account.display_name
                : null,
            status: account.status,
          }
        : null,
      last_synced_at: calendarSynced ?? account?.last_synced_at ?? null,
      status,
    };
  }
}
