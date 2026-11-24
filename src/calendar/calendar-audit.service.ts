/**
 * @fileoverview Records who changed a calendar's sharing, and what changed.
 *
 * Writes the same shape the wiki module writes (`entity_type: '<x>_permission'`,
 * `action: 'permission_change'`, `changes: { granted, revoked, modified }`), because the existing
 * audit screen already renders it. Fire-and-forget: an audit failure is logged, never raised, so it
 * cannot turn a successful save into an error.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { CalendarShareDto } from './dto/calendar-share.dto';

const AUDIT_LOGS = 'audit_logs';

const ENTITY_TYPE = 'calendar_permission';

/** Housekeeping columns a save touches by itself; they are not something a person changed. */
const VALUE_CHANGE_SKIPPED = new Set([
  'sync_pending',
  'updated_by',
  'updated_at',
]);

/** The most of one text value the trail keeps. */
const VALUE_CHANGE_MAX = 2000;

/** PostgREST caps a response at max_rows (1000), so a by-name sort can never see more than that. */
const NAME_SORT_CEILING = 1000;

/**
 * Every kind this module can record. The writers below are typed against this, so a kind can never
 * be dropped from the trail by editing what a screen happens to read.
 */
export const CALENDAR_AUDIT_KINDS = [
  'calendar',
  'calendar_entry',
  'calendar_integration',
  'calendar_permission',
] as const;

export type CalendarAuditKind = (typeof CALENDAR_AUDIT_KINDS)[number];

/**
 * What a reader may ask for. Narrow this freely to limit a screen — it cannot affect what is
 * recorded, and a caller can always name the slice it wants with `entity_type`.
 */
export const CALENDAR_AUDIT_ENTITIES = CALENDAR_AUDIT_KINDS;

export type CalendarAuditEntity = (typeof CALENDAR_AUDIT_ENTITIES)[number];

/**
 * Columns a reader may order by.
 *
 * A whitelist rather than a pass-through: the value reaches PostgREST's `order`, so anything the
 * caller sends would otherwise be a column name this module never meant to expose.
 */
export const CALENDAR_AUDIT_SORTS = [
  'created_at',
  'action',
  'entity_type',
  'user',
] as const;

export type CalendarAuditSort = (typeof CALENDAR_AUDIT_SORTS)[number];

/** Ways to narrow the trail once it is too long to read end to end. */
export interface CalendarAuditFilters {
  actions?: readonly string[];
  userId?: string;
  from?: string;
  to?: string;
}

/** A page of the trail plus how many rows match, so a table can show "1-10 of 243". */
export interface CalendarAuditPage {
  items: CalendarAuditEntry[];
  total: number;

  // Display names for the calendars, people, spaces and roles the page refers to by id
  names: Record<string, string>;
}

/** Matches a uuid, so a stray value never reaches an `in` filter and fails the whole page. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a reader of the log gets: the actor by name, never a bare id. */
export interface CalendarAuditEntry {
  id: string;
  created_at: string;
  entity_type: string;
  entity_id: string | null;
  action: string;
  actor: { id: string; name: string } | null;
  changes: Record<string, unknown> | null;
}

interface AuditRow {
  id: string;
  created_at: string;
  entity_type: string;
  entity_id: string | null;
  action: string;
  changes: Record<string, unknown> | null;
  user_id: string | null;
  user: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  } | null;
}

@Injectable()
export class CalendarAuditService {
  private readonly logger = new Logger(CalendarAuditService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  /** One entry per sharing change, carrying the difference rather than the whole list. */
  sharesChanged(
    organizationId: string,
    userId: string,
    calendarId: string,
    before: CalendarShareDto[],
    after: CalendarShareDto[],
  ): void {
    const changes = CalendarAuditService.diff(before ?? [], after ?? []);

    if (
      changes.granted.length === 0 &&
      changes.revoked.length === 0 &&
      changes.modified.length === 0
    ) {
      return;
    }

    void this.supabaseAdmin
      .getClient()
      .from(AUDIT_LOGS)
      .insert({
        organization_id: organizationId,
        user_id: userId,
        entity_type: ENTITY_TYPE,
        entity_id: calendarId,
        action: 'permission_change',
        changes: { calendar_id: calendarId, ...changes },
      })
      .then(({ error }) => {
        if (error) {
          this.logger.error(
            `Calendar ${calendarId}: sharing change not recorded — ${error.message}`,
          );
        }
      });
  }

  /**
   * The fields whose value really changed, each with what it was and what it became. Long text is cut,
   * so one edit cannot bloat the trail.
   */
  static valueChanges(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    fields: readonly string[],
  ): Record<string, { from: unknown; to: unknown }> {
    const changed: Record<string, { from: unknown; to: unknown }> = {};

    for (const field of fields) {
      if (VALUE_CHANGE_SKIPPED.has(field)) continue;

      const from = before?.[field] ?? null;
      const to = after?.[field] ?? null;

      if (JSON.stringify(from) === JSON.stringify(to)) continue;

      changed[field] = {
        from: CalendarAuditService.shortened(from),
        to: CalendarAuditService.shortened(to),
      };
    }

    return changed;
  }

  private static shortened(value: unknown): unknown {
    return typeof value === 'string' && value.length > VALUE_CHANGE_MAX
      ? `${value.slice(0, VALUE_CHANGE_MAX)}…`
      : value;
  }

  /** A calendar itself was made, changed or removed. */
  calendar(
    action: 'create' | 'update' | 'delete',
    organizationId: string,
    userId: string,
    calendarId: string,
    changes: Record<string, unknown>,
  ): void {
    this.record(
      organizationId,
      userId,
      'calendar',
      calendarId,
      action,
      changes,
    );
  }

  /** Tickets put on or taken off one calendar, listed so a reader sees which ones. */
  ticketsChanged(
    action: 'ticket_link' | 'ticket_unlink',
    organizationId: string,
    userId: string,
    calendarId: string,
    changes: Record<string, unknown>,
  ): void {
    this.record(
      organizationId,
      userId,
      'calendar',
      calendarId,
      action,
      changes,
    );
  }

  /** One entry on a calendar. */
  entry(
    action:
      | 'create'
      | 'update'
      | 'delete'
      | 'zoom_meeting_create'
      | 'zoom_meeting_update'
      | 'zoom_meeting_settings'
      | 'zoom_meeting_cancel'
      | 'zoom_meeting_failed',
    organizationId: string,
    userId: string,
    entryId: string,
    changes: Record<string, unknown>,
  ): void {
    this.record(
      organizationId,
      userId,
      'calendar_entry',
      entryId,
      action,
      changes,
    );
  }

  /**
   * An outside calendar: the account itself, or a calendar linked to one.
   *
   * `entityId` is the account for connect, disconnect and reconnect_required, and the calendar for
   * link, unlink and the sync outcomes — in both cases the row a reader would go and open.
   */
  integration(
    action:
      | 'connect'
      | 'disconnect'
      | 'reconnect_required'
      | 'link'
      | 'unlink'
      | 'sync'
      | 'sync_failed',
    organizationId: string,
    userId: string,
    entityId: string,
    changes: Record<string, unknown>,
  ): void {
    this.record(
      organizationId,
      userId,
      'calendar_integration',
      entityId,
      action,
      changes,
    );
  }

  /**
   * Recent calendar activity, newest first.
   *
   * The actor's name comes back in the same query, disambiguated by constraint because `audit_logs`
   * has a second link to users for the impersonator.
   */
  async recent(
    organizationId: string,
    limit: number,
    before?: string,
    entityTypes?: readonly CalendarAuditEntity[],
    filters: CalendarAuditFilters = {},
    offset = 0,
    sort: CalendarAuditSort = 'created_at',
    ascending = false,
  ): Promise<CalendarAuditPage> {
    /**
     * The actor's name cannot be ordered by in the database: it lives on a joined row, and
     * PostgREST's `order` on an embedded resource sorts that row rather than this one — it answers
     * 200 and leaves the order untouched. So that one sort is resolved here instead.
     */
    const byName = sort === 'user';

    let query = this.supabaseAdmin
      .getClient()
      .from(AUDIT_LOGS)
      .select(
        'id, created_at, entity_type, entity_id, action, changes, user_id, ' +
          'user:users!audit_logs_user_id_fkey(first_name, last_name, email)',
        // Counted in the same round trip; a table cannot show a page number without a total.
        { count: 'exact' },
      )
      .eq('organization_id', organizationId)
      // Narrowed when the caller wants one slice, such as a screen about connected accounts only.
      .in('entity_type', [...(entityTypes ?? CALENDAR_AUDIT_ENTITIES)])
      // Newest first unless asked otherwise; a second key keeps a page stable when the first ties.
      .order(byName ? 'created_at' : sort, {
        ascending: byName ? false : ascending,
      })
      .order('created_at', { ascending: false });

    if (before) query = query.lt('created_at', before);

    // Narrowing happens in the query, so a long trail never travels just to be dropped in the browser.
    if (filters.actions?.length)
      query = query.in('action', [...filters.actions]);
    if (filters.userId) query = query.eq('user_id', filters.userId);
    if (filters.from) query = query.gte('created_at', filters.from);
    if (filters.to) query = query.lte('created_at', filters.to);

    // A by-name sort has to see the rows before it can order them, so it reads a bounded window
    // rather than one page; every other sort is paged by the database.
    const { data, error, count } = byName
      ? await query.range(0, NAME_SORT_CEILING - 1)
      : await query.range(offset, offset + limit - 1);

    if (error) throw new BadRequestException(error.message);

    const rows = ((data ?? []) as unknown as AuditRow[]).map((row) =>
      CalendarAuditService.toEntry(row),
    );

    if (!byName) {
      return {
        items: rows,
        total: count ?? rows.length,
        names: await this.namesFor(organizationId, rows),
      };
    }

    const direction = ascending ? 1 : -1;

    rows.sort((left, right) => {
      const names = (left.actor?.name ?? '').localeCompare(
        right.actor?.name ?? '',
      );

      // The same person's rows stay newest-first, so a page does not reshuffle between requests.
      return names !== 0
        ? names * direction
        : right.created_at.localeCompare(left.created_at);
    });

    const items = rows.slice(offset, offset + limit);

    return {
      items,

      // The window is all this sort can order, so do not offer pages beyond it.
      total: Math.min(count ?? rows.length, rows.length),
      names: await this.namesFor(organizationId, items),
    };
  }

  /**
   * Names for the ids a page mentions: its calendars and, for sharing rows, who was added or removed.
   * Every lookup stays inside this organization; a failed lookup only leaves that name out.
   */
  private async namesFor(
    organizationId: string,
    items: CalendarAuditEntry[],
  ): Promise<Record<string, string>> {
    const calendars = new Set<string>();
    const users = new Set<string>();
    const spaces = new Set<string>();
    const roles = new Set<string>();

    for (const item of items) {
      const changes = item.changes ?? {};

      if (item.entity_id) calendars.add(item.entity_id);
      if (typeof changes.calendar_id === 'string')
        calendars.add(changes.calendar_id);

      for (const list of ['granted', 'revoked', 'modified'] as const) {
        const shares = Array.isArray(changes[list])
          ? (changes[list] as unknown[])
          : [];

        for (const raw of shares) {
          const share = (
            list === 'modified' ? (raw as { share?: unknown })?.share : raw
          ) as { target_type?: unknown; target_id?: unknown } | undefined;
          const id = share?.target_id;

          if (typeof id !== 'string') continue;
          if (share?.target_type === 'user') users.add(id);
          if (share?.target_type === 'space') spaces.add(id);
          if (share?.target_type === 'role') roles.add(id);
        }
      }

      // People and spaces named inside an edit's old and new values are shown by name too.
      const values =
        changes.values && typeof changes.values === 'object'
          ? (changes.values as Record<string, { from?: unknown; to?: unknown }>)
          : {};

      for (const [field, pair] of Object.entries(values)) {
        for (const side of [pair?.from, pair?.to]) {
          if (field === 'space_id' && typeof side === 'string')
            spaces.add(side);

          if (field === 'watcher_ids' && Array.isArray(side)) {
            for (const id of side) if (typeof id === 'string') users.add(id);
          }

          if (field === 'links' && Array.isArray(side)) {
            for (const link of side as Array<{
              type?: unknown;
              id?: unknown;
            }>) {
              if (link?.type === 'user' && typeof link.id === 'string') {
                users.add(link.id);
              }
            }
          }
        }
      }
    }

    const names: Record<string, string> = {};
    const client = this.supabaseAdmin.getClient();
    const ids = (set: Set<string>) => [...set].filter((id) => UUID.test(id));

    const named = async (table: string, wanted: string[]) => {
      if (wanted.length === 0) return;

      const { data, error } = await client
        .from(table)
        .select('id, name')
        .eq('organization_id', organizationId)
        .in('id', wanted);

      if (error) {
        this.logger.warn(`Names from ${table} not read — ${error.message}`);

        return;
      }

      for (const row of (data ?? []) as Array<{ id: string; name: string }>) {
        if (row.name) names[row.id] = row.name;
      }
    };

    // Only members of this organization, so a stray id can never surface another tenant's user
    const people = async (wanted: string[]) => {
      if (wanted.length === 0) return;

      const members = await client
        .from('organization_members')
        .select('user_id')
        .eq('organization_id', organizationId)
        .in('user_id', wanted);

      const memberIds = (
        (members.data ?? []) as Array<{ user_id: string }>
      ).map((row) => row.user_id);

      if (members.error || memberIds.length === 0) return;

      const { data, error } = await client
        .from('users')
        .select('id, first_name, last_name, email')
        .in('id', memberIds);

      if (error) {
        this.logger.warn(`User names not read — ${error.message}`);

        return;
      }

      for (const row of (data ?? []) as Array<
        { id: string } & NonNullable<AuditRow['user']>
      >) {
        names[row.id] = CalendarAuditService.actorName(row);
      }
    };

    await Promise.all([
      named('calendars', ids(calendars)),
      named('spaces', ids(spaces)),
      named('custom_roles', ids(roles)),
      people(ids(users)),
    ]);

    return names;
  }

  /** One stored row as a reader sees it. */
  private static toEntry(row: AuditRow): CalendarAuditEntry {
    return {
      id: row.id,
      created_at: row.created_at,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      action: row.action,
      actor: row.user_id
        ? { id: row.user_id, name: CalendarAuditService.actorName(row.user) }
        : null,
      changes: row.changes,
    };
  }

  /** A deleted user leaves the row behind, so fall back rather than showing an id. */
  private static actorName(user: AuditRow['user']): string {
    const full = [user?.first_name, user?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();

    return full || user?.email || 'Unknown user';
  }

  /** The one write path: logged on failure, never raised, never awaited by the caller. */
  private record(
    organizationId: string,
    userId: string,
    entityType: CalendarAuditKind,
    entityId: string,
    action: string,
    changes: Record<string, unknown>,
  ): void {
    void this.supabaseAdmin
      .getClient()
      .from(AUDIT_LOGS)
      .insert({
        organization_id: organizationId,
        user_id: userId,
        entity_type: entityType,
        entity_id: entityId,
        action,
        changes,
      })
      .then(
        ({ error }) => {
          if (error) this.failed(entityType, entityId, action, error.message);
        },

        // Second handler, not a trailing .catch: a rejected insert would otherwise go unhandled.
        (cause: unknown) =>
          this.failed(entityType, entityId, action, String(cause)),
      );
  }

  /** One wording for both failure paths. */
  private failed(
    entityType: string,
    entityId: string,
    action: string,
    reason: string,
  ): void {
    this.logger.error(
      `${entityType} ${entityId}: ${action} not recorded — ${reason}`,
    );
  }

  /** What was added, removed, or left in place at a different level. */
  private static diff(
    before: CalendarShareDto[],
    after: CalendarShareDto[],
  ): {
    granted: CalendarShareDto[];
    revoked: CalendarShareDto[];
    modified: Array<{
      share: CalendarShareDto;
      from?: string;
      to?: string;
      boxes?: Array<{ path: string; from: boolean; to: boolean }>;
    }>;
  } {
    const key = (share: CalendarShareDto) =>
      `${share.target_type}:${share.target_id ?? share.base_role ?? ''}`;

    const previous = new Map(before.map((share) => [key(share), share]));
    const next = new Map(after.map((share) => [key(share), share]));

    const granted = after.filter((share) => !previous.has(key(share)));
    const revoked = before.filter((share) => !next.has(key(share)));

    const modified = after
      .filter((share) => {
        const was = previous.get(key(share));

        // return was && was.level !== share.level;
        // A ticked or unticked box is a change too, even when the level stays the same.
        return (
          was &&
          (was.level !== share.level ||
            CalendarAuditService.boxChanges(was, share).length > 0)
        );
      })
      .map((share) => {
        const boxes = CalendarAuditService.boxChanges(
          previous.get(key(share)),
          share,
        );

        return {
          share,
          from: previous.get(key(share))?.level,
          to: share.level,

          // Left out when no box flipped, so a level-only change reads as it always has.
          ...(boxes.length > 0 ? { boxes } : {}),
        };
      });

    return { granted, revoked, modified };
  }

  /** Every permission box of a share as "area.box" → ticked; a box left out counts as unticked. */
  private static boxes(value: unknown, prefix = ''): Map<string, boolean> {
    const found = new Map<string, boolean>();

    if (!value || typeof value !== 'object') return found;

    for (const [name, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const path = prefix ? `${prefix}.${name}` : name;

      if (typeof child === 'boolean') found.set(path, child);
      else {
        for (const [inner, on] of CalendarAuditService.boxes(child, path)) {
          found.set(inner, on);
        }
      }
    }

    return found;
  }

  /** The boxes that flipped between two versions of one share. */
  private static boxChanges(
    before: CalendarShareDto | undefined,
    after: CalendarShareDto,
  ): Array<{ path: string; from: boolean; to: boolean }> {
    const was = CalendarAuditService.boxes(
      (before as { permissions?: unknown } | undefined)?.permissions,
    );
    const now = CalendarAuditService.boxes(
      (after as { permissions?: unknown }).permissions,
    );

    return [...new Set([...was.keys(), ...now.keys()])]
      .filter((path) => (was.get(path) ?? false) !== (now.get(path) ?? false))
      .map((path) => ({
        path,
        from: was.get(path) ?? false,
        to: now.get(path) ?? false,
      }));
  }

  /** What changed on ticket sources kept by a save: label, colour or date field, per source. */
  static sourceChanges(
    before: Array<Record<string, unknown>>,
    after: Array<Record<string, unknown>>,
  ): Record<string, { from: unknown; to: unknown }> {
    const previous = new Map(before.map((source) => [source.id, source]));
    const changed: Record<string, { from: unknown; to: unknown }> = {};

    after.forEach((source, index) => {
      const was = previous.get(source.id);

      if (!was) return;

      for (const field of ['label', 'color', 'date_field']) {
        const from = was[field] ?? null;
        const to = source[field] ?? null;

        if (from !== to) changed[`feeds.${index + 1}.${field}`] = { from, to };
      }
    });

    return changed;
  }
}
