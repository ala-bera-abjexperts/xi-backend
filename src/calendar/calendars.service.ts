/**
 * @fileoverview Calendars: create, read, update, delete, sharing and which custom fields they show.
 *
 * Every query filters by organization, and every read and write goes through CalendarAccessService.
 */
import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { cleanDescription } from './calendar-description';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type {
  CalendarAccess,
  CalendarAccessSource,
  CalendarRights,
  CalendarRow,
  CalendarShare,
} from './calendar-access.service';
import type {
  CalendarPermissions,
  CalendarSharePermissions,
} from './calendar-permissions.model';
import {
  noPermissions,
  permissionsFromShare,
} from './calendar-permissions.model';
import { CalendarAccessService } from './calendar-access.service';
import { CalendarAuditService } from './calendar-audit.service';
import type { CalendarFeedDto } from './dto/calendar-feeds.dto';
import type {
  ListLinkableTicketsDto,
  ListTicketLinksDto,
} from './dto/calendar-ticket-links.dto';
import type { CalendarFieldSettingDto } from './dto/calendar-field-settings.dto';
import type { CalendarShareDto } from './dto/calendar-share.dto';
import type { CreateCalendarDto } from './dto/create-calendar.dto';
import type { UpdateCalendarDto } from './dto/update-calendar.dto';
import type { CalendarListSort } from './dto/list-calendars.dto';

const TABLE = 'calendars';

/**
 * The access list is itself a permission: strip it for anyone not allowed to read it.
 *
 * Emptied rather than omitted — the field is a required array to every reader, and dropping the key
 * breaks them instead of telling them there is nothing to see.
 */
export function withVisibleShares<T extends { shares?: unknown }>(
  row: T,
  permissions: CalendarPermissions,
): T {
  // return permissions.manage || permissions.sharing.view
  // A save replaces the whole list, so whoever may add or change rules must see it too;
  // owning or managing the calendar alone no longer reveals it
  return permissions.sharing.view ||
    permissions.sharing.add ||
    permissions.sharing.manage
    ? row
    : { ...row, shares: [] };
}

/** Stands in when a calendar resolved to nothing, so the shape never varies. */
const NO_RIGHTS: CalendarRights = {
  create_entries: false,
  edit_entries: false,
  delete_entries: false,
  manage: false,
};

/** Share groups that answer the calendar module for a person, not one calendar. */
// const MODULE_KEYS = ['tabs', 'integrations', 'sharing'] as const;
// "Add people" is answered per calendar now, so of the sharing group only "See who else has access" is common
const MODULE_KEYS = ['tabs', 'integrations', 'tickets'] as const;

/** Single flags set once per person, inside groups whose other flags stay with each calendar. */
const MODULE_FLAGS: Record<'task_events' | 'calendar', readonly string[]> = {
  task_events: ['update', 'delete'],
  // sharing: ['view'],   (both sharing boxes are answered per calendar now)
  // calendar: ['create', 'delete'],
  calendar: ['create'], // delete is answered per calendar
};

type FlagGroup = keyof typeof MODULE_FLAGS;

const FLAG_GROUPS = Object.keys(MODULE_FLAGS) as FlagGroup[];

/** One group's flags as a plain record, so a flag can be read by name. */
function flagsOf(
  permissions: CalendarSharePermissions | undefined,
  group: FlagGroup,
): Record<string, boolean | undefined> | undefined {
  return permissions?.[group] as
    | Record<string, boolean | undefined>
    | undefined;
}

type ModuleShare = CalendarShare & {
  target_id: string;
  permissions: CalendarSharePermissions;
};

/** A share for one person that carries module answers; any other share leaves them alone. */
function isModuleShare(share: CalendarShare): share is ModuleShare {
  const permissions = share.permissions;

  return (
    share.target_type === 'user' &&
    Boolean(share.target_id) &&
    Boolean(permissions) &&
    (MODULE_KEYS.some((key) => permissions?.[key] !== undefined) ||
      FLAG_GROUPS.some((group) =>
        MODULE_FLAGS[group].some(
          (flag) => flagsOf(permissions, group)?.[flag] !== undefined,
        ),
      ))
  );
}

/** Compared resolved, because jsonb reorders keys and an absent tab still means shown. */
function moduleAnswer(share: CalendarShare): string {
  const resolved = permissionsFromShare(share);

  return JSON.stringify([
    resolved.tabs,
    resolved.integrations,
    resolved.tickets,
    // resolved.sharing,
    // resolved.sharing.view,   (per calendar now)
    resolved.task_events.update,
    resolved.task_events.delete,
    // resolved.calendar.delete,  (answered per calendar now)

    // Not part of the resolved matrix; only an explicit tick grants it, like the rule that reads it.
    share.permissions?.calendar?.create === true,
  ]);
}

/** Copies only the module groups from `source`; an absent group stays absent. */
function withModuleFrom(
  target: CalendarSharePermissions,
  source: CalendarSharePermissions,
): CalendarSharePermissions {
  const next: CalendarSharePermissions = { ...target };

  for (const key of MODULE_KEYS) {
    const value = source[key];

    // Copied, never shared by reference with the source rule.
    if (value === undefined) delete next[key];
    else
      next[key] = (typeof value === 'object' ? { ...value } : value) as never;
  }

  for (const group of FLAG_GROUPS) {
    const merged: Record<string, boolean | undefined> = {
      ...flagsOf(target, group),
    };

    for (const flag of MODULE_FLAGS[group]) {
      const value = flagsOf(source, group)?.[flag];

      if (value === undefined) delete merged[flag];
      else merged[flag] = value;
    }

    // Leave the group absent rather than empty when neither side ever held one.
    if (target[group] || Object.keys(merged).length > 0) {
      next[group] = merged as never;
    }
  }

  return next;
}

/** Writes a level-only rule out in full, so it keeps its per-calendar answers once it gains module flags. */
function shapeOf(share: CalendarShare): CalendarSharePermissions {
  if (share.permissions) return share.permissions;

  const p = permissionsFromShare(share);

  return {
    events: {
      create: p.events.create,
      own: {
        read: p.events.own_read,
        update: p.events.own_update,
        delete: p.events.own_delete,
      },
      others: {
        read: p.events.others_read,
        update: p.events.others_update,
        delete: p.events.others_delete,
      },
    },
    task_events: { ...p.task_events },
    sync: { ...p.sync },
    calendar: { ...p.calendar },
    tabs: { ...p.tabs },
    integrations: { ...p.integrations },
    tickets: { ...p.tickets },
    sharing: { ...p.sharing },
    manage: p.manage,
  };
}

export type CalendarWithAccess = CalendarRow & {
  access: CalendarAccess;

  /** The separate actions behind that level, so a screen hides exactly what a write route refuses. */
  rights: CalendarRights;

  /** What may be done to each kind of content: own entries, others', ticket dates, synced copies. */
  permissions: CalendarPermissions;

  /** Why the caller reaches this calendar, and who granted the rule that lets them in, for the sharing screen. */
  access_source?: CalendarAccessSource;
  access_granted_by?: string | null;
};

/** One ticket source as stored on a calendar: a single ticket, or a whole space minus some tickets. */
type StoredFeed = {
  id?: string;
  space_id?: string;
  task_id?: string | null;
  excluded_task_ids?: string[] | null;
};

/** Column and direction for each order the calendar list can be read in. */
const CALENDAR_LIST_ORDER: Record<
  CalendarListSort,
  readonly ['name' | 'created_at' | 'updated_at', boolean]
> = {
  name_asc: ['name', true],
  name_desc: ['name', false],
  created_desc: ['created_at', false],
  created_asc: ['created_at', true],
  updated_desc: ['updated_at', false],
  updated_asc: ['updated_at', true],
};

@Injectable()
export class CalendarsService {
  private readonly logger = new Logger(CalendarsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: CalendarAccessService,
    private readonly audit: CalendarAuditService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * The module is opt-in per organization, checked on every request so switching it off takes effect
   * at once. Mirrors how the Portfolio module gates itself.
   */
  /** Whether this person may create calendars at all, for the module's New button. */
  canCreateCalendars(userId: string, organizationId: string): Promise<boolean> {
    return this.access.canCreateCalendars(userId, organizationId);
  }

  async assertModuleEnabled(organizationId: string): Promise<void> {
    const { data, error } = await this.client
      .from('organization_modules')
      .select('is_enabled')
      .eq('organization_id', organizationId)
      .eq('module_type', 'calendar')
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);

    if (!data || data.is_enabled !== true) {
      throw new ForbiddenException(
        'Calendar module is not enabled for this organization',
      );
    }
  }

  /** Every calendar this user may see, each with the level they hold. */
  async listVisible(
    userId: string,
    organizationId: string,
    sort?: CalendarListSort,
  ): Promise<CalendarWithAccess[]> {
    const query = this.client
      .from(TABLE)
      .select('*')
      .eq('organization_id', organizationId);

    // Left out, the list keeps its order by name; a chosen order falls back to the name on ties.
    const [column, ascending] = sort
      ? CALENDAR_LIST_ORDER[sort]
      : (['name', true] as const);

    const ordered = query.order(column, { ascending, nullsFirst: false });
    const { data, error } =
      column === 'name'
        ? await ordered
        : await ordered.order('name', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    const calendars = (data ?? []) as CalendarRow[];
    const decisions = await this.access.resolveManyDecisions(
      userId,
      organizationId,
      calendars,
    );

    return calendars
      .map((calendar) => {
        const decision = decisions.get(calendar.id);
        const permissions = decision?.permissions ?? noPermissions();

        return withVisibleShares(
          {
            ...calendar,
            access: decision?.access ?? ('none' as CalendarAccess),
            rights: decision?.rights ?? NO_RIGHTS,
            permissions,
            access_source: decision?.source ?? 'none',
            access_granted_by: decision?.share?.granted_by ?? null,
            is_mine:
              calendar.owner_id === userId ||
              (calendar as CalendarRow & { created_by?: string | null })
                .created_by === userId ||
              // Somebody else's calendar is this person's only once it is shared for them to manage.
              decision?.sharedWithManage === true,
          },
          permissions,
        );
      })
      .filter((calendar) => calendar.access !== 'none');
  }

  /** One calendar, or 404/403. `needed` is the level the caller's endpoint requires. */
  async getForUser(
    id: string,
    userId: string,
    organizationId: string,
    needed: CalendarAccess = 'view',
  ): Promise<CalendarWithAccess> {
    const result = await this.client
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (result.error) throw new BadRequestException(result.error.message);
    if (!result.data) throw new NotFoundException('Calendar not found');

    const calendar = result.data as CalendarRow;

    const decision = await this.access.resolveDecision(
      userId,
      organizationId,
      calendar,
    );

    // "Not found" rather than "forbidden" for someone with no access at all: a private calendar
    // should not confirm its own existence.
    if (decision.access === 'none')
      throw new NotFoundException('Calendar not found');

    this.access.assert(decision.access, needed);

    return withVisibleShares(
      {
        ...calendar,
        access: decision.access,
        rights: decision.rights,
        permissions: decision.permissions,
        access_source: decision.source,
        access_granted_by: decision.share?.granted_by ?? null,
      },
      decision.permissions,
    );
  }

  async create(
    dto: CreateCalendarDto,
    userId: string,
    organizationId: string,
  ): Promise<CalendarRow> {
    await this.access.assertCanCreateCalendars(userId, organizationId);

    if (dto.space_id) {
      await this.access.assertCanCreateInSpace(
        userId,
        organizationId,
        dto.space_id,
      );
    }

    const row = {
      organization_id: organizationId,
      space_id: dto.space_id ?? null,
      owner_id: userId,
      name: dto.name,
      description: cleanDescription(dto.description),
      color: dto.color ?? null,
      visibility: dto.visibility ?? (dto.space_id ? 'space' : 'private'),
      default_timezone: dto.default_timezone ?? 'UTC',
      shares: dto.shares ?? [],
      field_settings: dto.field_settings ?? [],
      ...(dto.default_reminders
        ? { default_reminders: dto.default_reminders }
        : {}),
      created_by: userId,
      updated_by: userId,
    };

    // Held to the same rules as editing the share list, so a calendar cannot be born naming someone
    // the share screen would refuse.
    if (dto.shares?.length) {
      await this.assertSharesUsable(
        dto.shares,
        organizationId,
        row as unknown as CalendarRow,
      );
    }

    const result = await this.client.from(TABLE).insert(row).select().single();

    if (result.error) throw this.friendlyWriteError(result.error.message);

    const created = result.data as CalendarRow;

    this.audit.calendar('create', organizationId, userId, created.id, {
      name: created.name as string,
    });

    return created;
  }

  async update(
    id: string,
    dto: UpdateCalendarDto,
    userId: string,
    organizationId: string,
  ): Promise<CalendarRow> {
    const current = await this.getForUser(id, userId, organizationId, 'edit');

    // Writing entries is not the same as changing the calendar, so the calendar has its own grant.
    this.access.assertAllowed(
      current.permissions.calendar.edit,
      'change this calendar',
    );

    // Visibility decides who sees the calendar, so it is a manage-level change.
    if (dto.visibility !== undefined && dto.visibility !== current.visibility) {
      this.access.assert(current.access, 'manage');
    }

    const patch: Record<string, unknown> = { ...dto, updated_by: userId };

    if (dto.description !== undefined) {
      patch.description = cleanDescription(dto.description);
    }
    const moving =
      dto.space_id !== undefined &&
      (dto.space_id ?? null) !== (current.space_id ?? null);

    if (moving) {
      const landing = dto.space_id ?? null;

      // Moving decides who sees the calendar, like visibility does.
      this.access.assert(current.access, 'manage');

      if (landing) {
        await this.access.assertCanCreateInSpace(
          userId,
          organizationId,
          landing,
        );
      }

      // A field belongs to one space, so the ones already chosen must still be usable where it lands.
      await this.assertFieldsUsable(
        ((current.field_settings ?? []) as CalendarFieldSettingDto[]).map(
          (field) => field.field_id,
        ),
        organizationId,
        landing,
      );

      // 'space' needs a space and 'organization' needs none; a pair that no longer fits falls back to
      // private rather than showing the calendar to people the move never meant to include.
      const visibility = dto.visibility ?? current.visibility;

      if (
        (visibility === 'space' && !landing) ||
        (visibility === 'organization' && landing)
      ) {
        patch.visibility = 'private';
      }
    }

    const written = await this.write(
      id,
      organizationId,
      patch,
      current.permissions,
    );

    this.audit.calendar('update', organizationId, userId, id, {
      name: (written.name as string | undefined) ?? (current.name as string),
      fields: Object.entries(dto)
        .filter(([, value]) => value !== undefined)
        .map(([field]) => field),
      values: CalendarAuditService.valueChanges(
        current as unknown as Record<string, unknown>,
        written as unknown as Record<string, unknown>,
        Object.keys(patch),
      ),
    });

    return written;
  }

  async remove(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<{ success: true }> {
    const current = await this.getForUser(id, userId, organizationId, 'edit');

    // Removing the calendar is its own grant; managing it still carries it.
    this.access.assertAllowed(
      current.permissions.calendar.delete,
      'delete this calendar',
    );

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    this.audit.calendar('delete', organizationId, userId, id, {
      name: current.name as string,
    });

    return { success: true };
  }

  /**
   * Replaces who a calendar is shared with.
   *
   * Every principal is checked before it is stored, so a rule that could never grant anything is
   * refused instead of sitting in the list looking live. Who each principal turns out to be is
   * resolved when the calendar is read, never copied here.
   */
  async setShares(
    id: string,
    shares: CalendarShareDto[],
    userId: string,
    organizationId: string,
  ): Promise<CalendarRow> {
    // const current = await this.getForUser(id, userId, organizationId, 'manage');
    // The sharing boxes decide, not the Manage level
    const current = await this.getForUser(id, userId, organizationId, 'view');

    // The Sharing tab is a common box; managing a calendar does not open it on its own
    this.access.assertAllowed(
      current.permissions.tabs?.sharing !== false,
      'change who this calendar is shared with',
    );

    // Changing or removing other people's access is the org owner's (or an admin's) alone
    const isAdmin = await this.access.isOrgAdmin(userId, organizationId);

    // Saving at all needs "Add people" or the org owner, which is also what reveals the real list
    this.access.assertAllowed(
      current.permissions.sharing.add || isAdmin,
      'change who this calendar is shared with',
    );

    // Adding someone needs "Add people"; changing or removing a rule needs "Manage permissions"
    const change = this.shareChanges(current.shares ?? [], shares);

    this.access.assertAllowed(
      !change.added || current.permissions.sharing.add,
      'add people to this calendar',
    );
    this.access.assertAllowed(
      // !change.altered || current.permissions.sharing.manage,
      !change.altered || isAdmin,
      "change other people's access to this calendar",
    );

    await this.assertSharesUsable(shares, organizationId, current);

    // Module answers belong to the person: a newly added rule takes theirs, a changed one is copied out.
    const before: CalendarShare[] = current.shares ?? [];

    // Only the org owner or an admin sets the common boxes; from anyone else they are kept as they were
    const accepted = isAdmin
      ? shares
      : await this.keepCommonAnswers(shares, before, organizationId);
    // const others = await this.managedOtherCalendars(id, shares, userId, organizationId);
    const others = await this.managedOtherCalendars(
      id,
      accepted,
      userId,
      organizationId,
    );
    // const stored = this.stampGrants(this.adoptModuleAnswers(shares, before, others), before, userId);
    const stored = this.stampGrants(
      this.adoptModuleAnswers(accepted, before, others, current.owner_id),
      before,
      userId,
    );

    const written = await this.write(
      id,
      organizationId,
      {
        shares: stored,
        updated_by: userId,
      },
      current.permissions,
    );

    this.audit.sharesChanged(
      organizationId,
      userId,
      id,
      (current.shares ?? []) as CalendarShareDto[],
      stored,
    );

    await this.spreadModuleAnswers(
      stored,
      before,
      others,
      userId,
      organizationId,
    );

    return written;
  }

  /**
   * Refuses a ticket linked twice on one calendar: the same ticket or the same whole space twice,
   * or a single ticket inside a space that All tickets already covers (unless it is left out there).
   */
  private assertNoDuplicateFeeds(feeds: CalendarFeedDto[]): void {
    const seen = new Set<string>();
    const wholeSpaces = new Map(
      feeds
        .filter((feed) => !feed.task_id)
        .map((feed) => [feed.space_id, new Set(feed.excluded_task_ids ?? [])]),
    );

    for (const feed of feeds) {
      const key = `${feed.space_id}:${feed.task_id ?? '*'}`;
      const whole = feed.task_id ? wholeSpaces.get(feed.space_id) : undefined;

      if (seen.has(key) || (whole && !whole.has(feed.task_id!))) {
        throw new BadRequestException(
          'This ticket is already linked to this calendar',
        );
      }

      seen.add(key);
    }
  }

  /**
   * A member's save, with every common box put back: a rule already there keeps its own, a new person
   * takes what the org owner gave them elsewhere, or the Calendar tab and nothing else.
   */
  private async keepCommonAnswers<T extends CalendarShare>(
    shares: T[],
    before: CalendarShare[],
    organizationId: string,
  ): Promise<T[]> {
    const key = (share: CalendarShare) =>
      `${share.target_type}:${share.target_id ?? share.base_role ?? ''}`;
    const previous = new Map(before.map((share) => [key(share), share]));

    const { data, error } = await this.client
      .from(TABLE)
      .select('shares, updated_at')
      .eq('organization_id', organizationId)
      .order('updated_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    const elsewhere = ((data ?? []) as { shares?: CalendarShare[] }[]).flatMap(
      (row) => row.shares ?? [],
    );

    const nothingCommon: CalendarSharePermissions = {
      tabs: {
        calendar: true,
        integrations: false,
        sharing: false,
        tickets: false,
      },
      tickets: {
        form: false,
        link: false,
        list: false,
        delete: false,
        delete_many: false,
      },
      integrations: {
        view: false,
        create: false,
        update: false,
        delete: false,
        manage: false,
        records: false,
        sync_section: false,
        active_list: false,
        stop_sync: false,
      },
      sharing: { view: false, add: false, manage: false },
      calendar: { create: false },
      task_events: { update: false, delete: false },
    };

    return shares.map((share) => {
      const was = previous.get(key(share));
      const theirs = elsewhere.find(
        (other) =>
          other.target_type === 'user' &&
          share.target_type === 'user' &&
          other.target_id === share.target_id,
      );
      const source = was
        ? (was.permissions ?? {})
        : (theirs?.permissions ?? nothingCommon);

      // return { ...share, permissions: withModuleFrom(share.permissions ?? {}, source) };
      const kept = withModuleFrom(share.permissions ?? {}, source);

      // "Manage permissions" is the org owner's alone and never something a member can hand out
      return {
        ...share,
        permissions: { ...kept, sharing: { ...kept.sharing, manage: false } },
      };
    });
  }

  /** Whether a new list adds anyone, and whether it changes or drops a rule already there. */
  private shareChanges(
    before: CalendarShare[],
    after: CalendarShare[],
  ): { added: boolean; altered: boolean } {
    const key = (share: CalendarShare) =>
      `${share.target_type}:${share.target_id ?? share.base_role ?? ''}`;
    const grant = (share: CalendarShare) =>
      JSON.stringify([permissionsFromShare(share), share.level ?? null]);
    const previous = new Map(before.map((share) => [key(share), share]));
    const next = new Set(after.map(key));

    const added = after.some((share) => !previous.has(key(share)));
    const altered =
      before.some((share) => !next.has(key(share))) ||
      after.some((share) => {
        const was = previous.get(key(share));

        return was !== undefined && grant(was) !== grant(share);
      });

    return { added, altered };
  }

  /**
   * Records who granted each rule: a new or changed rule gets the caller and now, an unchanged one
   * keeps its earlier stamp. Whatever the client sent for these fields is ignored.
   */
  private stampGrants<T extends CalendarShare>(
    shares: T[],
    before: CalendarShare[],
    userId: string,
  ): T[] {
    const key = (share: CalendarShare) =>
      `${share.target_type}:${share.target_id ?? share.base_role ?? ''}`;
    const grant = (share: CalendarShare) =>
      JSON.stringify([permissionsFromShare(share), share.level ?? null]);
    const previous = new Map(before.map((share) => [key(share), share]));
    const now = new Date().toISOString();

    return shares.map((share) => {
      const rest = { ...share };

      delete rest.granted_by;
      delete rest.granted_at;

      const was = previous.get(key(share));

      if (was && grant(was) === grant(share)) {
        return {
          ...rest,
          ...(was.granted_by ? { granted_by: was.granted_by } : {}),
          ...(was.granted_at ? { granted_at: was.granted_at } : {}),
        } as T;
      }

      return { ...rest, granted_by: userId, granted_at: now } as T;
    });
  }

  /** The caller's other manageable calendars, fetched only when a rule carries module answers. */
  private async managedOtherCalendars(
    id: string,
    shares: CalendarShare[],
    userId: string,
    organizationId: string,
  ): Promise<CalendarRow[]> {
    if (!shares.some(isModuleShare)) return [];

    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .order('updated_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    const calendars = ((data ?? []) as CalendarRow[]).filter(
      (calendar) => calendar.id !== id,
    );
    const decisions = await this.access.resolveManyDecisions(
      userId,
      organizationId,
      calendars,
    );

    // Never touch a calendar the caller could not change by hand.
    return calendars.filter(
      (calendar) => decisions.get(calendar.id)?.access === 'manage',
    );
  }

  /** A person newly added here keeps the module answers they already hold, newest calendar first. */
  private adoptModuleAnswers<T extends CalendarShare>(
    shares: T[],
    before: CalendarShare[],
    others: CalendarRow[],
    ownerId?: string | null,
  ): T[] {
    let adopted = false;

    const next = shares.map((share) => {
      if (!isModuleShare(share)) return share;
      if (before.some((old) => old.target_id === share.target_id)) return share;

      // The owner's rule is set from the owner row, which already starts from their answers
      if (ownerId && share.target_id === ownerId) return share;

      const source = others
        .flatMap((calendar) => calendar.shares ?? [])
        .find(
          (other) =>
            other.target_type === 'user' && other.target_id === share.target_id,
        );

      if (!source) return share;

      adopted = true;

      return {
        ...share,
        permissions: withModuleFrom(share.permissions, shapeOf(source)),
      };
    });

    return adopted ? next : shares;
  }

  /** Copies changed module answers onto the same person's rule on every other calendar. */
  private async spreadModuleAnswers(
    stored: CalendarShare[],
    before: CalendarShare[],
    others: CalendarRow[],
    userId: string,
    organizationId: string,
  ): Promise<void> {
    const changed = new Map<string, CalendarSharePermissions>();

    for (const share of stored) {
      if (!isModuleShare(share)) continue;

      const old = before.find(
        (item) =>
          item.target_type === 'user' && item.target_id === share.target_id,
      );

      if (old && moduleAnswer(old) !== moduleAnswer(share)) {
        changed.set(share.target_id, share.permissions);
      }
    }

    if (changed.size === 0) return;

    // one write per calendar, not one transaction; a failure part-way leaves the rest as they were.
    for (const calendar of others) {
      const previous = calendar.shares ?? [];
      let touched = false;

      const next = previous.map((share) => {
        const source =
          share.target_type === 'user' && share.target_id
            ? changed.get(share.target_id)
            : undefined;

        if (!source) return share;

        const updated = {
          ...share,
          permissions: withModuleFrom(shapeOf(share), source),
        };

        if (moduleAnswer(updated) === moduleAnswer(share)) return share;

        touched = true;

        return updated;
      });

      if (!touched) continue;

      await this.write(
        calendar.id,
        organizationId,
        { shares: next, updated_by: userId },
        noPermissions(),
      );

      this.audit.sharesChanged(
        organizationId,
        userId,
        calendar.id,
        previous as CalendarShareDto[],
        next as CalendarShareDto[],
      );
    }
  }

  async setFieldSettings(
    id: string,
    fields: CalendarFieldSettingDto[],
    userId: string,
    organizationId: string,
  ): Promise<CalendarRow> {
    const current = await this.getForUser(id, userId, organizationId, 'manage');

    await this.assertFieldsUsable(
      fields.map((field) => field.field_id),
      organizationId,
      current.space_id,
    );

    const written = await this.write(
      id,
      organizationId,
      { field_settings: fields, updated_by: userId },
      current.permissions,
    );

    this.audit.calendar('update', organizationId, userId, id, {
      name: current.name as string,
      custom_fields: fields.length,
    });

    return written;
  }

  /**
   * Replaces the ticket sources shown on a calendar.
   *
   * Only the space is stored. Which tickets each viewer actually sees is decided when the calendar is
   * read, against that viewer's own access, so a source can never widen what somebody may see.
   */
  async setFeeds(
    id: string,
    feeds: CalendarFeedDto[],
    userId: string,
    organizationId: string,
  ): Promise<CalendarRow> {
    const calendar = await this.getForUser(id, userId, organizationId, 'view');

    // Adding a source puts ticket dates on the calendar; removing one takes them away. Both are the
    // ticket-dates permission, not managing the calendar itself.
    const existing = ((calendar.feeds as unknown[]) ?? []).length;
    // Leaving a ticket out of a whole-space source also takes its date away
    const leftOutBefore = new Map(
      (
        (calendar.feeds as Array<{
          id?: string;
          excluded_task_ids?: string[] | null;
        }>) ?? []
      ).map((old) => [old.id, (old.excluded_task_ids ?? []).length]),
    );
    const removing =
      feeds.length < existing ||
      // only an existing whole-space source losing tickets is a removal; a new one may start with some left out
      feeds.some(
        (feed) =>
          !feed.task_id &&
          !!feed.id &&
          leftOutBefore.has(feed.id) &&
          (feed.excluded_task_ids ?? []).length >
            (leftOutBefore.get(feed.id) ?? 0),
      );

    // The Link ticket tab's own boxes, set per calendar and by the org owner
    this.access.assertAllowed(
      removing
        ? calendar.permissions.tickets.delete
        : calendar.permissions.task_events.form,
      removing
        ? 'remove ticket dates from this calendar'
        : 'put ticket dates on this calendar',
    );

    // Adding a link is also the Link ticket tab's own box
    if (!removing) {
      this.access.assertAllowed(
        calendar.permissions.tickets.link,
        'link tickets to this calendar',
      );
    }

    // So is removing one
    if (removing) {
      this.access.assertAllowed(
        calendar.permissions.tickets.delete,
        'remove linked tickets from this calendar',
      );
    }

    // One link per ticket per calendar
    this.assertNoDuplicateFeeds(feeds);

    const stored: Array<{
      id: string;
      space_id: string;
      task_id: string | null;
      date_field: string;
      label: string | null;
      color: string | null;
      linked_at: string;
      excluded_task_ids: string[];
    }> = [];

    // An existing source keeps when it was linked; client values are ignored
    const linkedAt = new Map(
      (
        (calendar.feeds as Array<{ id?: string; linked_at?: string }>) ?? []
      ).map((old) => [old.id, old.linked_at]),
    );
    const now = new Date().toISOString();

    for (const feed of feeds) {
      // Any open space with Tasks on may be linked, whether or not this person can read it
      await this.access.assertLinkableSpace(organizationId, feed.space_id);

      stored.push({
        id: feed.id ?? randomUUID(),
        space_id: feed.space_id,
        task_id: feed.task_id ?? null,
        date_field: feed.date_field,
        label: feed.label ?? null,
        color: feed.color ?? null,
        linked_at: (feed.id && linkedAt.get(feed.id)) || now,

        // Only a whole-space source can leave tickets out
        excluded_task_ids: feed.task_id
          ? []
          : [...new Set(feed.excluded_task_ids ?? [])],
      });
    }

    const written = await this.write(
      id,
      organizationId,
      { feeds: stored, updated_by: userId },
      calendar.permissions,
    );

    const recorded = this.auditTicketLinks(
      organizationId,
      userId,
      id,
      calendar.name as string,
      (calendar.feeds as StoredFeed[] | null) ?? [],
      stored,
    );

    // A save that only changed a source's label, colour or date field still leaves a trace
    if (!recorded) {
      this.audit.calendar('update', organizationId, userId, id, {
        name: calendar.name as string,
        ticket_sources: stored.length,
        values: CalendarAuditService.sourceChanges(
          ((calendar.feeds as StoredFeed[] | null) ?? []) as Array<
            Record<string, unknown>
          >,
          stored as Array<Record<string, unknown>>,
        ),
      });
    }

    return written;
  }

  /**
   * Records which tickets a save put on or took off this calendar, one row each way, with each ticket's
   * key and summary so the trail can link to it. Returns whether anything changed; the names are read and
   * written in the background, so a failed lookup never turns a saved link into an error.
   */
  private auditTicketLinks(
    organizationId: string,
    userId: string,
    calendarId: string,
    calendarName: string,
    before: StoredFeed[],
    after: StoredFeed[],
  ): boolean {
    const singles = (feeds: StoredFeed[]) =>
      new Set(
        feeds
          .map((feed) => feed.task_id)
          .filter((taskId): taskId is string => !!taskId),
      );
    const wholeSpaces = (feeds: StoredFeed[]) =>
      new Map(
        feeds
          .filter((feed) => !feed.task_id && feed.id)
          .map((feed) => [feed.id as string, feed]),
      );

    const singlesBefore = singles(before);
    const singlesAfter = singles(after);
    const spacesBefore = wholeSpaces(before);
    const spacesAfter = wholeSpaces(after);

    const linkedTasks = [...singlesAfter].filter(
      (id) => !singlesBefore.has(id),
    );
    const unlinkedTasks = [...singlesBefore].filter(
      (id) => !singlesAfter.has(id),
    );
    const linkedSpaces: string[] = [];
    const unlinkedSpaces: string[] = [];

    for (const [feedId, feed] of spacesAfter) {
      const old = spacesBefore.get(feedId);

      if (!old) {
        if (feed.space_id) linkedSpaces.push(feed.space_id);
        continue;
      }

      // A ticket left out of a whole-space source is taken off; one let back in is put on again
      const leftOutBefore = new Set(old.excluded_task_ids ?? []);
      const leftOutAfter = new Set(feed.excluded_task_ids ?? []);

      for (const taskId of leftOutAfter) {
        if (!leftOutBefore.has(taskId)) unlinkedTasks.push(taskId);
      }

      for (const taskId of leftOutBefore) {
        if (!leftOutAfter.has(taskId)) linkedTasks.push(taskId);
      }
    }

    for (const [feedId, feed] of spacesBefore) {
      if (!spacesAfter.has(feedId) && feed.space_id) {
        unlinkedSpaces.push(feed.space_id);
      }
    }

    const linked = linkedTasks.length + linkedSpaces.length > 0;
    const unlinked = unlinkedTasks.length + unlinkedSpaces.length > 0;

    if (!linked && !unlinked) return false;

    void (async () => {
      const taskIds = [...new Set([...linkedTasks, ...unlinkedTasks])];
      const tasks = new Map<
        string,
        {
          id: string;
          key: string | null;
          summary: string | null;
          space_id: string;
        }
      >();

      if (taskIds.length > 0) {
        const { data } = await this.client
          .from('tasks')
          .select('id, key, summary, space_id')
          .eq('organization_id', organizationId)
          .in('id', taskIds);

        for (const row of (data ?? []) as Array<{
          id: string;
          key: string | null;
          summary: string | null;
          space_id: string;
        }>) {
          tasks.set(row.id, row);
        }
      }

      const spaceIds = [
        ...new Set([
          ...linkedSpaces,
          ...unlinkedSpaces,
          ...[...tasks.values()].map((task) => task.space_id),
        ]),
      ].filter(Boolean);
      const spaces = new Map<
        string,
        { id: string; key: string; name: string }
      >();

      if (spaceIds.length > 0) {
        const { data } = await this.client
          .from('spaces')
          .select('id, key, name')
          .eq('organization_id', organizationId)
          .in('id', spaceIds);

        for (const row of (data ?? []) as Array<{
          id: string;
          key: string;
          name: string;
        }>) {
          spaces.set(row.id, row);
        }
      }

      // A ticket or space that is already gone keeps its id, so the row still says something happened
      const ticketList = (ids: string[]) =>
        [...new Set(ids)].map((taskId) => {
          const task = tasks.get(taskId);

          return {
            id: taskId,
            key: task?.key ?? null,
            summary: task?.summary ?? null,
            space_key: task ? (spaces.get(task.space_id)?.key ?? null) : null,
          };
        });
      const spaceList = (ids: string[]) =>
        [...new Set(ids)].map((spaceId) => ({
          id: spaceId,
          key: spaces.get(spaceId)?.key ?? null,
          name: spaces.get(spaceId)?.name ?? null,
        }));

      if (linked) {
        this.audit.ticketsChanged(
          'ticket_link',
          organizationId,
          userId,
          calendarId,
          {
            name: calendarName,
            calendar_id: calendarId,
            tickets: ticketList(linkedTasks),
            spaces: spaceList(linkedSpaces),
          },
        );
      }

      if (unlinked) {
        this.audit.ticketsChanged(
          'ticket_unlink',
          organizationId,
          userId,
          calendarId,
          {
            name: calendarName,
            calendar_id: calendarId,
            tickets: ticketList(unlinkedTasks),
            spaces: spaceList(unlinkedSpaces),
          },
        );
      }
    })().catch((failure: unknown) =>
      this.logger.warn(
        `Calendar ${calendarId}: ticket link change not recorded — ${String(failure)}`,
      ),
    );

    return true;
  }

  /**
   * One page of the given spaces' tickets that are not linked to this calendar yet, worked out by the
   * database so the answer is exact however big a space is.
   */
  async listLinkableTickets(
    id: string,
    userId: string,
    organizationId: string,
    query: ListLinkableTicketsDto,
  ): Promise<{
    items: Array<{ task_id: string; space_id: string }>;
    page: number;
    hasMore: boolean;
    total: number;
  }> {
    const calendar = await this.getForUser(id, userId, organizationId, 'view');

    // Only someone who may put ticket dates on the calendar is offered tickets to link
    this.access.assertAllowed(
      calendar.permissions.task_events.form,
      'put ticket dates on this calendar',
    );

    // Searching tickets for the form is the Link ticket tab's own box
    this.access.assertAllowed(
      calendar.permissions.tickets.form,
      'search tickets to link',
    );

    const spaceIds = [...new Set(query.space_ids.split(','))];

    for (const spaceId of spaceIds) {
      // Any open space with Tasks on may be searched for linking, whether or not this person can read it
      await this.access.assertLinkableSpace(organizationId, spaceId);
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;

    const result = await this.client.rpc('calendar_linkable_ticket_ids', {
      p_org: organizationId,
      p_calendar: id,
      p_space_ids: spaceIds,
      p_search: query.search?.trim() || null,
      p_offset: (page - 1) * pageSize,
      p_limit: pageSize,
    });

    if (result.error) throw new BadRequestException(result.error.message);

    const rows = ((result.data as unknown) ?? []) as Array<{
      task_id: string;
      space_id: string;
      total: number;
    }>;
    const total = Number(rows[0]?.total ?? 0);

    return {
      items: rows.map((row) => ({
        task_id: row.task_id,
        space_id: row.space_id,
      })),
      page,
      hasMore: (page - 1) * pageSize + rows.length < total,
      total,
    };
  }

  /**
   * One page of the tickets linked to this calendar, limited to the spaces this person may read.
   * Single links to tickets that no longer exist are listed apart, so they can still be removed.
   */
  async listTicketLinks(
    id: string,
    userId: string,
    organizationId: string,
    query: ListTicketLinksDto,
  ): Promise<{
    data: Array<{
      task_id: string;
      feed_id: string;
      all_tickets: boolean;
      date_field: string;
      linked_at: string | null;
    }>;
    unavailable: Array<{ feed_id: string; task_id: string }>;
    page: number;
    hasMore: boolean;
    total: number;
  }> {
    const calendar = await this.getForUser(id, userId, organizationId, 'view');
    const feeds = ((calendar.feeds as unknown[]) ?? []).filter(
      (
        feed,
      ): feed is { id?: string; space_id: string; task_id?: string | null } =>
        typeof feed === 'object' && feed !== null && 'space_id' in feed,
    );

    // The single-linked tickets' current spaces (a ticket may have moved since it was linked)
    const singleIds = feeds
      .map((feed) => feed.task_id)
      .filter((taskId): taskId is string => Boolean(taskId));
    let singles: Array<{ id: string; space_id: string | null }> = [];

    if (singleIds.length > 0) {
      const { data, error } = await this.client
        .from('tasks')
        .select('id, space_id')
        .eq('organization_id', organizationId)
        .in('id', singleIds);

      if (error) throw new BadRequestException(error.message);
      singles = (data ?? []) as typeof singles;
    }

    const found = new Set(singles.map((task) => task.id));
    const unavailable = feeds
      .filter((feed) => feed.task_id && !found.has(feed.task_id))
      .map((feed) => ({
        feed_id: feed.id ?? '',
        task_id: feed.task_id as string,
      }));

    const candidates = new Set<string>([
      ...feeds.filter((feed) => !feed.task_id).map((feed) => feed.space_id),
      ...singles
        .map((task) => task.space_id)
        .filter((spaceId): spaceId is string => Boolean(spaceId)),
    ]);
    const readable: string[] = [];

    for (const spaceId of candidates) {
      if (
        await this.access.canReadSpaceTickets(userId, organizationId, spaceId)
      ) {
        readable.push(spaceId);
      }
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const list = (value?: string) => (value ? value.split(',') : null);
    let rows: Array<{
      task_id: string;
      feed_id: string;
      all_tickets: boolean;
      date_field: string;
      linked_at: string | null;
      total: number;
    }> = [];

    if (readable.length > 0) {
      const result = await this.client.rpc('calendar_linked_ticket_ids', {
        p_org: organizationId,
        p_calendar: id,
        p_space_ids: readable,
        p_search: query.search?.trim() || null,
        p_status_names: list(query.status),
        p_priority_names: list(query.priority),
        p_type_ids: list(query.type),
        p_space: query.space ?? null,
        p_offset: (page - 1) * pageSize,
        p_limit: pageSize,
      });

      if (result.error) throw new BadRequestException(result.error.message);
      rows = ((result.data as unknown) ?? []) as typeof rows;
    }

    const total = Number(rows[0]?.total ?? 0);

    return {
      data: rows.map((row) => ({
        task_id: row.task_id,
        feed_id: row.feed_id,
        all_tickets: row.all_tickets,
        date_field: row.date_field,
        linked_at: row.linked_at,
      })),
      unavailable,
      page,
      hasMore: (page - 1) * pageSize + rows.length < total,
      total,
    };
  }

  /**
   * Cleaning up after a leaver is an administrator's job.
   *
   * Without this, any member of the organization could list — and delete — calendars they were never
   * allowed to open, including private personal ones.
   */
  private async assertOrgAdmin(
    userId: string,
    organizationId: string,
  ): Promise<void> {
    if (!(await this.access.isOrgAdmin(userId, organizationId))) {
      throw new ForbiddenException(
        'Only an organization owner or admin can clean up calendars left behind.',
      );
    }
  }

  /**
   * Calendars whose owner is no longer an active member of the organization.
   *
   * Deliberately returns the name and owner only, never the entries: an administrator cleans up what
   * a leaver left behind without reading anyone's private calendar.
   */
  async listOwnerless(
    organizationId: string,
    userId?: string,
  ): Promise<Array<{ id: string; name: string; owner_id: string | null }>> {
    // Optional so the internal re-check in removeOwnerless does not ask twice.
    if (userId) await this.assertOrgAdmin(userId, organizationId);

    const { data, error } = await this.client
      .from(TABLE)
      .select('id, name, owner_id, space_id')
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    const calendars = (data ?? []) as Array<{
      id: string;
      name: string;
      owner_id: string | null;
      space_id: string | null;
    }>;
    const ownerIds = [
      ...new Set(
        calendars
          .map((calendar) => calendar.owner_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const { data: members } = ownerIds.length
      ? await this.client
          .from('organization_members')
          .select('user_id')
          .eq('organization_id', organizationId)
          .in('user_id', ownerIds)
      : { data: [] as Array<{ user_id: string }> };

    const active = new Set(
      ((members ?? []) as Array<{ user_id: string }>).map(
        (member) => member.user_id,
      ),
    );

    return calendars
      .filter(
        (calendar) => !calendar.owner_id || !active.has(calendar.owner_id),
      )
      .map(({ id, name, owner_id }) => ({ id, name, owner_id }));
  }

  /** Deletes a calendar left behind by someone who is no longer in the organization. */
  async removeOwnerless(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true }> {
    await this.assertOrgAdmin(userId, organizationId);

    const ownerless = await this.listOwnerless(organizationId);

    if (!ownerless.some((calendar) => calendar.id === id)) {
      throw new NotFoundException('Calendar not found');
    }

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    return { success: true };
  }

  /**
   * A calendar may only show fields of its own organization that are still usable, and a space-scoped
   * field only on a calendar of that same space. A personal calendar gets organization fields only.
   */
  /**
   * Refuses a share that could never grant anything.
   *
   * The principals are the application's own: a user in this organization, a group, a custom role, a
   * space role, or the calendar's own space. A stranger, a deleted group, a role from another tenant
   * or a second rule for the same principal is rejected by name rather than stored silently.
   */
  private async assertSharesUsable(
    shares: CalendarShareDto[],
    organizationId: string,
    calendar: CalendarRow,
  ): Promise<void> {
    const seen = new Set<string>();

    for (const share of shares) {
      const identity = `${share.target_type}:${share.target_id ?? share.base_role ?? ''}`;

      if (seen.has(identity)) {
        throw new BadRequestException(
          'That principal is already on the sharing list.',
        );
      }

      seen.add(identity);

      if (share.target_type === 'base_role' && !calendar.space_id) {
        throw new BadRequestException(
          'A space role can only be shared with on a calendar that belongs to a space.',
        );
      }

      if (
        share.target_type === 'space' &&
        share.target_id !== calendar.space_id
      ) {
        throw new BadRequestException(
          'A calendar can only be shared with its own space.',
        );
      }
    }

    await this.assertUsersShareable(
      shares
        .filter((share) => share.target_type === 'user')
        .map((share) => share.target_id),
      organizationId,
    );
  }

  /** A share to somebody outside the organization can never grant anything. */
  private async assertUsersShareable(
    userIds: string[],
    organizationId: string,
  ): Promise<void> {
    if (userIds.length === 0) return;

    const { data } = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', organizationId)
      .in('user_id', [...new Set(userIds)]);

    const found = new Set(
      ((data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id),
    );

    for (const id of userIds) {
      if (!found.has(id)) {
        throw new BadRequestException(
          'That person is not a member of this organization.',
        );
      }
    }
  }

  private async assertFieldsUsable(
    fieldIds: string[],
    organizationId: string,
    calendarSpaceId: string | null,
  ): Promise<void> {
    if (fieldIds.length === 0) return;

    const { data, error } = await this.client
      .from('custom_fields')
      .select('id, is_active, is_deleted, scope, space_id')
      .eq('organization_id', organizationId)
      .in('id', [...new Set(fieldIds)]);

    if (error) throw new BadRequestException(error.message);

    const usable = new Set(
      (
        (data ?? []) as Array<{
          id: string;
          is_active: boolean | null;
          is_deleted: boolean | null;
          scope: string | null;
          space_id: string | null;
        }>
      )
        .filter((field) => field.is_active !== false && !field.is_deleted)
        .filter(
          (field) =>
            field.scope !== 'space' ||
            (calendarSpaceId !== null && field.space_id === calendarSpaceId),
        )
        .map((field) => field.id),
    );

    const missing = fieldIds.filter((id) => !usable.has(id));

    if (missing.length > 0) {
      throw new BadRequestException(
        `These custom fields are not available in this organization: ${missing.join(', ')}`,
      );
    }
  }

  private async write(
    id: string,
    organizationId: string,
    patch: Record<string, unknown>,
    permissions: CalendarPermissions,
  ): Promise<CalendarRow> {
    const result = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (result.error) throw this.friendlyWriteError(result.error.message);

    return withVisibleShares(result.data as CalendarRow, permissions);
  }

  /** Turns the database's own rejections into something a person can act on. */
  private friendlyWriteError(message: string): BadRequestException {
    if (message.includes('calendars_visibility_check')) {
      return new BadRequestException(
        'A personal calendar can be private or organization-wide; a space calendar can be private or ' +
          'visible to its space.',
      );
    }

    if (message.includes('calendars_name_check')) {
      return new BadRequestException('A calendar name is 1 to 200 characters.');
    }

    if (message.includes('calendars_color_check')) {
      return new BadRequestException('Use a colour such as #4f8cff.');
    }

    return new BadRequestException(message);
  }
}
