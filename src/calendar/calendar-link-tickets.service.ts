/**
 * @fileoverview Ticket reads for the calendar's Link ticket tab.
 *
 * The tab offers every open space with Tasks on and every ticket in them, whoever is linking, so it
 * cannot use the membership-checked task picker. Rows come back in the picker's own shape so the
 * screen reads them the same way.
 * @module src/calendar/calendar-link-tickets.service
 */
import { BadRequestException, Injectable } from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { CalendarAccessService } from './calendar-access.service';

export const LINK_TICKETS_MAX_PAGE_SIZE = 50;
export const LINK_TICKETS_LOOKUP_MAX_IDS = 200;

export interface LinkSpace {
  id: string;
  key: string;
  name: string;
}

/** The task picker's row shape. */
export interface LinkTicketItem {
  id: string;
  key: string;
  summary: string;
  spaceId: string;
  spaceKey: string;
  status: { name: string; color: string | null; isCompleted: boolean } | null;
  priority: { name: string; color: string | null; icon: string | null } | null;
  assignee: { id: string; name: string; avatarUrl: string | null } | null;
  updatedAt: string;
}

interface TicketRow {
  id: string;
  key: string | null;
  summary: string | null;
  space_id: string | null;
  status: string | null;
  priority: string | null;
  priority_id: string | null;
  updated_at: string;
  status_config: {
    name: string;
    color: string | null;
    is_completed: boolean | null;
  } | null;
  space: { key: string } | null;
  assignee: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    avatar_url: string | null;
  } | null;
}

/** One linked ticket of a page, with its ticket's details (null when it can no longer be read). */
export interface LinkedTicket {
  task_id: string;
  calendar_id: string;
  feed_id: string;
  all_tickets: boolean;
  date_field: string;
  linked_at: string | null;
  ticket: LinkTicketItem | null;
}

interface LinkedRow {
  task_id: string;
  calendar_id: string;
  feed_id: string;
  all_tickets: boolean;
  date_field: string;
  linked_at: string | null;
  total: number;
}

interface PriorityRow {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
}

const TICKET_SELECT =
  'id, key, summary, space_id, status, priority, priority_id, updated_at, status_config:task_statuses!tasks_status_id_fkey(name, color, is_completed), space:spaces!tasks_space_id_fkey(key), assignee:users!tasks_assigned_to_fkey(id, first_name, last_name, email, avatar_url)';

@Injectable()
export class CalendarLinkTicketsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: CalendarAccessService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async spaces(
    organizationId: string,
  ): Promise<{ spaces: LinkSpace[]; truncated: boolean }> {
    return {
      spaces: await this.access.linkableSpaces(organizationId),
      truncated: false,
    };
  }

  async lookup(
    organizationId: string,
    ids: string[],
  ): Promise<{ items: LinkTicketItem[]; missing: string[] }> {
    const unique = [...new Set(ids)];

    if (unique.length === 0 || unique.length > LINK_TICKETS_LOOKUP_MAX_IDS) {
      throw new BadRequestException(
        `Between 1 and ${LINK_TICKETS_LOOKUP_MAX_IDS} ids are required`,
      );
    }

    const spaces = await this.spaceMap(organizationId);
    let rows: TicketRow[] = [];

    if (spaces.size > 0) {
      const { data, error } = await this.client
        .from('tasks')
        .select(TICKET_SELECT)
        .eq('organization_id', organizationId)
        .in('id', unique);

      if (error) throw new BadRequestException(error.message);

      // Only tickets of a linkable space; the rest read as missing, like the picker
      rows = ((data ?? []) as unknown as TicketRow[]).filter(
        (row) => typeof row.space_id === 'string' && spaces.has(row.space_id),
      );
    }

    const items = await this.toItems(organizationId, rows, spaces);
    const found = new Set(items.map((item) => item.id));

    return { items, missing: unique.filter((id) => !found.has(id)) };
  }

  async search(
    organizationId: string,
    q: { spaceId: string; search?: string; page: number; pageSize: number },
  ): Promise<{
    items: LinkTicketItem[];
    page: number;
    hasMore: boolean;
    total: number;
  }> {
    await this.access.assertLinkableSpace(organizationId, q.spaceId);

    const spaces = await this.spaceMap(organizationId);
    const pageSize = Math.min(
      Math.max(1, q.pageSize),
      LINK_TICKETS_MAX_PAGE_SIZE,
    );
    const from = (q.page - 1) * pageSize;

    let query = this.client
      .from('tasks')
      .select(TICKET_SELECT, { count: 'exact' })
      .eq('organization_id', organizationId)
      .eq('space_id', q.spaceId);

    // The task list's own search: key or summary, with PostgREST .or() characters removed
    const safe = (q.search ?? '').trim().replace(/[,.()"'\\]/g, '');

    if (safe.length > 0) {
      query = query.or(`summary.ilike.%${safe}%,key.ilike.%${safe}%`);
    }

    const { data, error, count } = await query
      .order('updated_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) throw new BadRequestException(error.message);

    const total = count ?? 0;

    return {
      items: await this.toItems(
        organizationId,
        (data ?? []) as unknown as TicketRow[],
        spaces,
      ),
      page: q.page,
      hasMore: from + pageSize < total,
      total,
    };
  }

  /**
   * One page of the tickets linked to these calendars, searched and filtered by the database, newest
   * link first. Single links to tickets that no longer exist are listed apart so they can be removed.
   */
  async linked(
    organizationId: string,
    calendars: Array<{ id: string; feeds: unknown }>,
    q: {
      space?: string;
      status?: string;
      priority?: string;
      type?: string;
      dateField?: string;
      search?: string;
      page: number;
      pageSize: number;
    },
  ): Promise<{
    items: LinkedTicket[];
    unavailable: Array<{
      calendar_id: string;
      feed_id: string;
      task_id: string;
    }>;
    page: number;
    hasMore: boolean;
    total: number;
  }> {
    const empty = {
      items: [],
      unavailable: [],
      page: q.page,
      hasMore: false,
      total: 0,
    };

    if (calendars.length === 0) return empty;

    const spaces = await this.spaceMap(organizationId);

    if (spaces.size === 0) return empty;

    const pageSize = Math.min(
      Math.max(1, q.pageSize),
      LINK_TICKETS_MAX_PAGE_SIZE,
    );
    const list = (value?: string) => (value ? value.split(',') : null);

    const result = await this.client.rpc('calendar_linked_tickets_page', {
      p_org: organizationId,
      p_calendars: calendars.map((calendar) => calendar.id),
      p_space_ids: [...spaces.keys()],
      p_search: q.search?.trim() || null,
      p_status_names: list(q.status),
      p_priority_names: list(q.priority),
      p_type_ids: list(q.type),
      p_space: q.space ?? null,
      p_date_field: q.dateField ?? null,
      p_offset: (q.page - 1) * pageSize,
      p_limit: pageSize,
    });

    if (result.error) throw new BadRequestException(result.error.message);

    const rows = ((result.data as unknown) ?? []) as LinkedRow[];
    const total = Number(rows[0]?.total ?? 0);
    const tickets = new Map(
      rows.length > 0
        ? (
            await this.lookup(
              organizationId,
              rows.map((row) => row.task_id),
            )
          ).items.map((item) => [item.id, item])
        : [],
    );

    return {
      items: rows.map((row) => ({
        task_id: row.task_id,
        calendar_id: row.calendar_id,
        feed_id: row.feed_id,
        all_tickets: row.all_tickets,
        date_field: row.date_field,
        linked_at: row.linked_at,
        ticket: tickets.get(row.task_id) ?? null,
      })),
      unavailable: await this.unavailableLinks(
        organizationId,
        calendars,
        spaces,
      ),
      page: q.page,
      hasMore: (q.page - 1) * pageSize + rows.length < total,
      total,
    };
  }

  /**
   * Links the list can no longer show, so it can still offer to remove them: a single link whose ticket
   * is gone or sits in a space that can no longer be linked, and a whole-space link of such a space.
   */
  private async unavailableLinks(
    organizationId: string,
    calendars: Array<{ id: string; feeds: unknown }>,
    spaces: Map<string, LinkSpace>,
  ): Promise<Array<{ calendar_id: string; feed_id: string; task_id: string }>> {
    const feeds = calendars.flatMap((calendar) =>
      (
        (calendar.feeds as Array<{
          id?: string;
          space_id?: string;
          task_id?: string | null;
        }> | null) ?? []
      ).map((feed) => ({ calendar_id: calendar.id, feed })),
    );

    const wholes = feeds
      .filter(
        ({ feed }) =>
          !feed.task_id &&
          typeof feed.space_id === 'string' &&
          !spaces.has(feed.space_id),
      )
      .map(({ calendar_id, feed }) => ({
        calendar_id,
        feed_id: feed.id ?? '',
        task_id: '',
      }));

    const singles = feeds
      .filter(({ feed }) => typeof feed.task_id === 'string')
      .map(({ calendar_id, feed }) => ({
        calendar_id,
        feed_id: feed.id ?? '',
        task_id: feed.task_id as string,
      }));

    // Read in batches, so a calendar with many single links never makes one oversized request
    const ids = [...new Set(singles.map((single) => single.task_id))];
    const linkable = new Set<string>();

    for (let at = 0; at < ids.length; at += LINK_TICKETS_LOOKUP_MAX_IDS) {
      const { data, error } = await this.client
        .from('tasks')
        .select('id, space_id')
        .eq('organization_id', organizationId)
        .in('id', ids.slice(at, at + LINK_TICKETS_LOOKUP_MAX_IDS));

      if (error) throw new BadRequestException(error.message);

      for (const row of (data ?? []) as Array<{
        id: string;
        space_id: string | null;
      }>) {
        if (row.space_id && spaces.has(row.space_id)) linkable.add(row.id);
      }
    }

    return [
      ...wholes,
      ...singles.filter((single) => !linkable.has(single.task_id)),
    ];
  }

  private async spaceMap(
    organizationId: string,
  ): Promise<Map<string, LinkSpace>> {
    return new Map(
      (await this.access.linkableSpaces(organizationId)).map((space) => [
        space.id,
        space,
      ]),
    );
  }

  /** The picker's row building, so the screen shows the same status, priority and assignee. */
  private async toItems(
    organizationId: string,
    rows: TicketRow[],
    spaces: Map<string, LinkSpace>,
  ): Promise<LinkTicketItem[]> {
    const priorityIds = [
      ...new Set(
        rows
          .map((row) => row.priority_id)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    const priorities = new Map<string, PriorityRow>();

    if (priorityIds.length > 0) {
      const { data, error } = await this.client
        .from('task_priorities')
        .select('id, name, color, icon')
        .eq('organization_id', organizationId)
        .in('id', priorityIds);

      if (error) throw new BadRequestException(error.message);

      for (const p of (data ?? []) as PriorityRow[]) priorities.set(p.id, p);
    }

    return rows.map((row) => {
      const status = row.status_config;
      const p = row.priority_id ? priorities.get(row.priority_id) : undefined;
      const a = row.assignee;
      const spaceId = row.space_id ?? '';

      return {
        id: row.id,
        key: row.key ?? '',
        summary: row.summary ?? '',
        spaceId,
        spaceKey: spaces.get(spaceId)?.key ?? row.space?.key ?? '',
        status: status
          ? {
              name: status.name,
              color: status.color ?? null,
              isCompleted: status.is_completed === true,
            }
          : row.status
            ? { name: row.status, color: null, isCompleted: false }
            : null,
        priority: p
          ? { name: p.name, color: p.color ?? null, icon: p.icon ?? null }
          : row.priority
            ? { name: row.priority, color: null, icon: null }
            : null,
        assignee: a
          ? {
              id: a.id,
              name:
                [a.first_name, a.last_name].filter(Boolean).join(' ') ||
                a.email ||
                '',
              avatarUrl: a.avatar_url ?? null,
            }
          : null,
        updatedAt: row.updated_at,
      };
    });
  }
}
