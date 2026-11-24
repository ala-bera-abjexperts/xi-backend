/**
 * @fileoverview Decides what one user may do with one calendar.
 *
 * Single gate for every calendar endpoint. Sharing lives on the calendar itself (owner, visibility and
 * a share list), so no new space or organization permission key was introduced.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import type { ISpaceBaseGrant } from '../permissions/models/space-permissions.model';
import { spaceGrantAllows } from '../permissions/models/space-permissions.model';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { CalendarPrincipals } from './calendar-principals.service';
import { CalendarPrincipalsService } from './calendar-principals.service';
import type {
  CalendarPermissions,
  CalendarSharePermissions,
} from './calendar-permissions.model';
import {
  allPermissions,
  capPermissions,
  ceilingFromSpace,
  grantsAnyWrite,
  grantsNothing,
  mergePermissions,
  noPermissions,
  permissionsFromShare,
  readOnlyPermissions,
} from './calendar-permissions.model';

export type CalendarAccess = 'none' | 'view' | 'edit' | 'manage';

/** Visibility lets people read the calendar from its own tab; other tabs need a share or ownership. */
function visibilityGrant(): CalendarPermissions {
  const base = readOnlyPermissions();

  // Every tab the model knows, shut except Calendar, so this follows the tab list wherever it changes
  const tabs = Object.fromEntries(
    Object.keys(base.tabs).map((tab) => [tab, tab === 'calendar']),
  ) as CalendarPermissions['tabs'];

  return { ...base, tabs };
}

const LEVELS: CalendarAccess[] = ['none', 'view', 'edit', 'manage'];

/** Only the share list opens a calendar: no space role and no visibility setting lets anyone in. */
const SHARE_LIST_ONLY = true;

export interface CalendarShare {
  target_type?: string;
  target_id?: string;

  /** The old single level. Still honoured, and still what an older row carries. */
  level?: string;

  /** The per-content grant. Wins over `level` when present. */
  permissions?: CalendarSharePermissions;
  base_role?: string;

  /** Who last granted or changed this rule, and when; stamped by the server on save. */
  granted_by?: string;
  granted_at?: string;
}

export interface CalendarRow {
  id: string;
  organization_id: string;
  space_id: string | null;
  owner_id: string | null;
  visibility: string;
  shares: CalendarShare[];
  [key: string]: unknown;
}

interface SpaceState {
  id: string;
  organization_id: string;
  is_active: boolean | null;
  is_archived: boolean | null;
  deleting_at: string | null;
}

/** Everything the decision needs about one space, fetched once per request. */
interface SpaceFacts {
  space: SpaceState | null;
  grant: ISpaceBaseGrant | null;
}

/**
 * Why someone reaches a calendar. Kept beside the level so the sharing screen can say where access
 * comes from, and so an audit entry records the rule rather than just the outcome.
 */
export type CalendarAccessSource =
  | 'none'
  | 'org_admin'
  | 'space_admin'
  | 'owner'
  | 'user_share'
  | 'base_role_share'
  | 'space_share'
  | 'space_visibility'
  | 'organization_visibility';

/**
 * What the ladder alone cannot say.
 *
 * `edit` covers creating, changing and removing entries, but a space can grant those separately, so
 * each is answered on its own here. The screen hides what it may not do, and every write route asserts
 * the matching one, so both sides give the same answer.
 */
export interface CalendarRights {
  create_entries: boolean;
  edit_entries: boolean;
  delete_entries: boolean;
  manage: boolean;
}

export type CalendarRight = keyof CalendarRights;

/** The space permission behind each right; a calendar outside a space is governed by its level alone. */
const RIGHT_WORDING: Record<CalendarRight, string> = {
  create_entries: 'create entries',
  edit_entries: 'change entries',
  delete_entries: 'delete entries',
  manage: 'manage this calendar',
};

const RIGHT_PERMISSION: Record<CalendarRight, string> = {
  create_entries: 'create_calendar_entries',
  edit_entries: 'edit_calendar_entries',
  delete_entries: 'delete_calendar_entries',
  manage: 'manage_calendars',
};

export interface CalendarDecision {
  access: CalendarAccess;
  source: CalendarAccessSource;
  rights: CalendarRights;

  /** What may be done to each kind of content on this calendar. The routes assert against this. */
  permissions: CalendarPermissions;

  /** The row that granted it, when a share did. */
  share?: CalendarShare;

  /** Named on the share list, whichever rule decided the level; set by the list pass only. */
  sharedWithMe?: boolean;

  /** Named on the share list by a rule that lets them manage the calendar; set by the list pass only. */
  sharedWithManage?: boolean;
}

@Injectable()
export class CalendarAccessService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
    private readonly principals: CalendarPrincipalsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** How far a space's module permissions let anyone go on its calendars. */
  private static spaceCeiling(grant: ISpaceBaseGrant | null): CalendarAccess {
    if (!grant) return 'none';

    if (!spaceGrantAllows(grant, 'view_calendar')) return 'none';

    if (spaceGrantAllows(grant, 'manage_calendars')) return 'manage';

    const writes =
      spaceGrantAllows(grant, 'create_calendar_entries') ||
      spaceGrantAllows(grant, 'edit_calendar_entries') ||
      spaceGrantAllows(grant, 'delete_calendar_entries');

    return writes ? 'edit' : 'view';
  }

  /**
   * The separate rights behind a resolved level.
   *
   * Two conditions, both required: the level must reach the rung the action sits on, and — on a space
   * calendar — the space must grant that action. So a share can never hand out more than the space
   * allows, and the space alone never opens a calendar nobody shared.
   */
  private static rightsFor(
    access: CalendarAccess,
    grant: ISpaceBaseGrant | null,
    inSpace: boolean,
  ): CalendarRights {
    const allowed = (right: CalendarRight, needed: CalendarAccess) => {
      if (
        CalendarAccessService.rank(access) < CalendarAccessService.rank(needed)
      ) {
        return false;
      }

      if (!inSpace) return true;

      return grant ? spaceGrantAllows(grant, RIGHT_PERMISSION[right]) : false;
    };

    return {
      create_entries: allowed('create_entries', 'edit'),
      edit_entries: allowed('edit_entries', 'edit'),
      delete_entries: allowed('delete_entries', 'edit'),
      manage: allowed('manage', 'manage'),
    };
  }

  private static rank(level: CalendarAccess): number {
    return LEVELS.indexOf(level);
  }

  private static cap(
    level: CalendarAccess,
    ceiling: CalendarAccess,
  ): CalendarAccess {
    return CalendarAccessService.rank(level) <=
      CalendarAccessService.rank(ceiling)
      ? level
      : ceiling;
  }

  private async loadSpaces(
    spaceIds: string[],
  ): Promise<Map<string, SpaceState>> {
    const map = new Map<string, SpaceState>();

    if (spaceIds.length === 0) return map;

    const { data } = await this.client
      .from('spaces')
      .select('id, organization_id, is_active, is_archived, deleting_at')
      .in('id', spaceIds);

    for (const row of (data ?? []) as SpaceState[]) map.set(row.id, row);

    return map;
  }

  /** One space lookup and one grant lookup per space, however many calendars share it. */
  private async factsFor(
    userId: string,
    organizationId: string,
    spaceIds: string[],
  ): Promise<Map<string, SpaceFacts>> {
    const unique = [...new Set(spaceIds)];
    const spaces = await this.loadSpaces(unique);
    const facts = new Map<string, SpaceFacts>();

    for (const spaceId of unique) {
      const space = spaces.get(spaceId) ?? null;

      // A space in another tenant, or on its way out, never needs a grant lookup.
      if (
        !space ||
        space.organization_id !== organizationId ||
        space.deleting_at ||
        space.is_active === false
      ) {
        facts.set(spaceId, { space: null, grant: null });
        continue;
      }

      facts.set(spaceId, {
        space,
        grant: await this.permissions.resolveSpaceBaseGrant(
          userId,
          organizationId,
          spaceId,
        ),
      });
    }

    return facts;
  }

  /**
   * The decision itself, with every lookup already done.
   *
   * Space membership is checked BEFORE owner and share list, so leaving a space removes access even
   * from the person who created the calendar or was named on it.
   */
  private decide(
    userId: string,
    organizationId: string,
    calendar: CalendarRow,
    facts: SpaceFacts | null,
    principals: CalendarPrincipals | null,
  ): CalendarDecision {
    const grant = facts?.grant ?? null;
    const inSpace = Boolean(calendar.space_id);

    /** Puts the answer together: cap what was granted, then describe it the older ways too. */
    const settle = (
      granted: CalendarPermissions,
      source: CalendarAccessSource,
      ceiling: CalendarPermissions,
      detail?: CalendarShare,
    ): CalendarDecision => {
      const permissions = capPermissions(granted, ceiling);
      const access = CalendarAccessService.levelOf(permissions);

      return {
        access,
        source: access === 'none' ? 'none' : source,
        rights: CalendarAccessService.rightsFor(access, grant, inSpace),
        permissions,
        share: detail,
      };
    };

    const refused = (): CalendarDecision => ({
      access: 'none',
      source: 'none',
      rights: CalendarAccessService.rightsFor('none', grant, inSpace),
      permissions: noPermissions(),
    });

    if (calendar.organization_id !== organizationId) return refused();

    let ceiling = allPermissions();

    if (calendar.space_id) {
      if (!facts?.space || !facts.grant) return refused();

      // An archived space is readable history, not a place to write.
      if (facts.space.is_archived) {
        ceiling = capPermissions(ceiling, readOnlyPermissions());
      }

      // The space's own Calendar permissions cap what any sharing can grant, the way a wiki page
      // grant is capped by the space baseline. The calendar decides who; the space decides how far.
      // ceiling = capPermissions(
      //   ceiling,
      //   ceilingFromSpace((key) => spaceGrantAllows(facts.grant!, key)),
      // );
      // A member named in this calendar's own share is let in on that share; the space role still
      // decides for everyone the calendar does not name
      // The member who created the calendar keeps it the same way, without a rule of their own
      const namedHere =
        facts.grant.isMember &&
        ((SHARE_LIST_ONLY && calendar.owner_id === userId) ||
          !grantsNothing(
            this.fromShares(calendar, principals, facts.grant).permissions,
          ));

      if (!namedHere) {
        ceiling = capPermissions(
          ceiling,
          ceilingFromSpace((key) => spaceGrantAllows(facts.grant!, key)),
        );
      }

      if (grantsNothing(ceiling)) return refused();

      if (!facts.grant.isMember && !facts.grant.isAdmin) return refused();

      // The space owner runs the space, so they manage every calendar in it, private ones included.
      // That is why the sharing screen does not offer the owner role: a rule could only repeat what
      // they already hold, and a "view" rule would read as if it took something away.
      // if (facts.grant.spaceRole === 'owner') {
      if (!SHARE_LIST_ONLY && facts.grant.spaceRole === 'owner') {
        return settle(allPermissions(), 'space_admin', ceiling);
      }

      // An admin manages the calendars the space shares, but not someone's private one.
      if (
        !SHARE_LIST_ONLY &&
        calendar.visibility === 'space' &&
        facts.grant.spaceRole === 'admin'
      ) {
        return settle(allPermissions(), 'space_admin', ceiling);
      }
    }

    // An organization owner or admin administers the calendars of their own tenant, as they do
    // dashboards and wiki pages. Placed after the space checks so an archived space still caps them.
    if (principals?.isOrgOwner) {
      return settle(allPermissions(), 'org_admin', ceiling);
    }

    if (calendar.owner_id && calendar.owner_id === userId) {
      // return settle(allPermissions(), 'owner', ceiling);
      // A rule the org owner set for the owner on their own calendar decides its boxes; with none, full access
      const own = (calendar.shares ?? []).find(
        (share) => share.target_type === 'user' && share.target_id === userId,
      );

      return settle(
        own ? permissionsFromShare(own) : allPermissions(),
        'owner',
        ceiling,
        own,
      );
    }

    const shared = this.fromShares(calendar, principals, facts?.grant ?? null);

    if (!grantsNothing(shared.permissions)) {
      return settle(shared.permissions, shared.source, ceiling, shared.share);
    }

    // Nobody was named, so only the calendar's own visibility is left.
    // if (calendar.space_id && calendar.visibility === 'space') {
    if (
      !SHARE_LIST_ONLY &&
      calendar.space_id &&
      calendar.visibility === 'space'
    ) {
      return settle(visibilityGrant(), 'space_visibility', ceiling);
    }

    if (
      !SHARE_LIST_ONLY &&
      !calendar.space_id &&
      calendar.visibility === 'organization'
    ) {
      return settle(visibilityGrant(), 'organization_visibility', ceiling);
    }

    return refused();
  }

  /**
   * The old three-rung level that best describes a matrix.
   *
   * Kept so every route and screen written against `view | edit | manage` keeps working while the
   * precise questions are asked of the matrix itself.
   */
  private static levelOf(permissions: CalendarPermissions): CalendarAccess {
    if (permissions.manage) return 'manage';

    if (grantsAnyWrite(permissions)) return 'edit';

    return grantsNothing(permissions) ? 'none' : 'view';
  }

  /** Organization owner or admin — the standing the leaver-cleanup routes require. */
  async isOrgAdmin(userId: string, organizationId: string): Promise<boolean> {
    return (await this.principals.resolve(userId, organizationId)).isOrgAdmin;
  }

  /** Owners and admins always may; someone a share names needs "Create calendars" ticked; nobody named keeps it. */
  async canCreateCalendars(
    userId: string,
    organizationId: string,
  ): Promise<boolean> {
    if (await this.isOrgAdmin(userId, organizationId)) return true;

    const { data, error } = await this.client
      .from('calendars')
      .select('shares')
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    const mine = ((data ?? []) as { shares?: CalendarShare[] }[]).flatMap(
      (row) =>
        (row.shares ?? []).filter(
          (share) => share.target_type === 'user' && share.target_id === userId,
        ),
    );

    if (mine.length === 0) return true;

    return mine.some((share) => share.permissions?.calendar?.create === true);
  }

  async assertCanCreateCalendars(
    userId: string,
    organizationId: string,
  ): Promise<void> {
    if (!(await this.canCreateCalendars(userId, organizationId))) {
      throw new ForbiddenException(
        'Your calendar sharing does not allow creating calendars.',
      );
    }
  }

  /** Access to one calendar. */
  async resolve(
    userId: string,
    organizationId: string,
    calendar: CalendarRow,
  ): Promise<CalendarAccess> {
    return (await this.resolveDecision(userId, organizationId, calendar))
      .access;
  }

  /** The same answer, with the rule that produced it — for the sharing screen and for audit. */
  async resolveDecision(
    userId: string,
    organizationId: string,
    calendar: CalendarRow,
  ): Promise<CalendarDecision> {
    const [facts, principals] = await Promise.all([
      calendar.space_id
        ? this.factsFor(userId, organizationId, [calendar.space_id])
        : Promise.resolve(null),
      this.principals.resolve(userId, organizationId),
    ]);

    // return this.decide(
    //   userId,
    //   organizationId,
    //   calendar,
    //   calendar.space_id ? (facts?.get(calendar.space_id) ?? null) : null,
    //   principals,
    // );
    const decision = this.decide(
      userId,
      organizationId,
      calendar,
      calendar.space_id ? (facts?.get(calendar.space_id) ?? null) : null,
      principals,
    );
    const ceiling = await this.moduleCeilingFor(
      userId,
      organizationId,
      principals,
    );

    return ceiling
      ? {
          ...decision,
          permissions: capPermissions(decision.permissions, ceiling),
        }
      : decision;
  }

  /**
   * The common module boxes an admin set for this person, as a ceiling over every calendar they reach.
   * Owning a calendar no longer opens tabs or connections those boxes keep shut. Null, meaning no
   * cap, for org owners and admins and for anyone no share names, the same rule creating calendars uses.
   */
  private async moduleCeilingFor(
    userId: string,
    organizationId: string,
    principals: CalendarPrincipals | null,
  ): Promise<CalendarPermissions | null> {
    // Only the org owner is uncapped; an admin follows the common boxes the org owner set for them
    if (principals?.isOrgOwner) return null;

    const { data, error } = await this.client
      .from('calendars')
      .select('shares, updated_at')
      .eq('organization_id', organizationId)
      .order('updated_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    // Module answers are kept identical across a person's rules, so the latest one speaks for all.
    const rule = ((data ?? []) as { shares?: CalendarShare[] }[])
      .flatMap((row) => row.shares ?? [])
      .find(
        (share) => share.target_type === 'user' && share.target_id === userId,
      );

    // if (!rule) return null;
    // Never configured by the org owner: the common section holds only what the owner assigned, which is
    // nothing yet, so the Calendar tab alone; this calendar's own boxes are untouched by this ceiling
    if (!rule) {
      const all = allPermissions();

      return {
        ...all,
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
      };
    }

    const answer = permissionsFromShare(rule);

    return {
      ...allPermissions(),
      tabs: answer.tabs,
      integrations: answer.integrations,
      tickets: answer.tickets,
      // sharing: answer.sharing,
      // sharing: { ...allPermissions().sharing, view: answer.sharing.view },
      // The sharing boxes come from each calendar's own rule, so the common ceiling leaves them open
      sharing: allPermissions().sharing,
    };
  }

  /** Access to many calendars, without one round trip per calendar. */
  async resolveMany(
    userId: string,
    organizationId: string,
    calendars: CalendarRow[],
  ): Promise<Map<string, CalendarAccess>> {
    const decisions = await this.resolveManyDecisions(
      userId,
      organizationId,
      calendars,
    );

    return new Map(
      [...decisions].map(([id, decision]) => [id, decision.access]),
    );
  }

  /** The same pass, keeping each rule and its separate rights for the list endpoint. */
  async resolveManyDecisions(
    userId: string,
    organizationId: string,
    calendars: CalendarRow[],
  ): Promise<Map<string, CalendarDecision>> {
    const spaceIds = calendars
      .map((calendar) => calendar.space_id)
      .filter((id): id is string => Boolean(id));

    const [facts, principals] = await Promise.all([
      this.factsFor(userId, organizationId, spaceIds),
      this.principals.resolve(userId, organizationId),
    ]);

    const result = new Map<string, CalendarDecision>();

    // Common boxes set for this person cap every calendar, owned ones included
    const ceiling = await this.moduleCeilingFor(
      userId,
      organizationId,
      principals,
    );

    for (const calendar of calendars) {
      // result.set(
      //   calendar.id,
      //   this.decide(
      //     userId,
      //     organizationId,
      //     calendar,
      //     calendar.space_id ? (facts.get(calendar.space_id) ?? null) : null,
      //     principals,
      //   ),
      // );
      const decision = this.decide(
        userId,
        organizationId,
        calendar,
        calendar.space_id ? (facts.get(calendar.space_id) ?? null) : null,
        principals,
      );

      result.set(
        calendar.id,
        ceiling
          ? {
              ...decision,
              permissions: capPermissions(decision.permissions, ceiling),
            }
          : decision,
      );

      // An admin or owner is decided before shares are read, so ask the share list on its own.
      const settled = result.get(calendar.id);

      if (settled) {
        const shared = this.fromShares(
          calendar,
          principals,
          (calendar.space_id ? facts.get(calendar.space_id) : null)?.grant ??
            null,
        );

        result.set(calendar.id, {
          ...settled,
          sharedWithMe: shared.source !== 'none',

          // What the share itself hands over, so an admin's own reach is not mistaken for a share.
          sharedWithManage:
            shared.source !== 'none' && shared.permissions.manage === true,
        });
      }
    }

    return result;
  }

  /**
   * The highest level any share row grants this user, and which row granted it.
   *
   * Every principal is matched against live membership, never a copy: leaving a group or losing a
   * role changes the answer on the next request. Access is additive — one row is enough, and the
   * strongest matching row wins.
   */
  private fromShares(
    calendar: CalendarRow,
    principals: CalendarPrincipals | null,
    grant: ISpaceBaseGrant | null,
  ): {
    permissions: CalendarPermissions;
    source: CalendarAccessSource;
    share?: CalendarShare;
  } {
    if (!principals) return { permissions: noPermissions(), source: 'none' };

    // Someone who has left the organization keeps their row, so a share to them must stop granting.
    if (!principals.isOrgMember && !principals.isOrgAdmin) {
      return { permissions: noPermissions(), source: 'none' };
    }

    let granted = noPermissions();
    let source: CalendarAccessSource = 'none';
    let matched: CalendarShare | undefined;
    let strongest = -1;

    for (const share of calendar.shares ?? []) {
      const hit = CalendarAccessService.matches(
        share,
        calendar,
        principals,
        grant,
      );

      if (!hit) continue;

      const rule = permissionsFromShare(share);

      granted = mergePermissions(granted, rule);

      // Several rules can match; the one that grants most is the one worth naming as the reason.
      const weight = CalendarAccessService.rank(
        CalendarAccessService.levelOf(rule),
      );

      if (weight > strongest) {
        strongest = weight;
        source = hit;
        matched = share;
      }
    }

    return { permissions: granted, source, share: matched };
  }

  /** Which kind of principal a share row names, and whether this user is one of them. */
  private static matches(
    share: CalendarShare | null | undefined,
    calendar: CalendarRow,
    principals: CalendarPrincipals,
    grant: ISpaceBaseGrant | null,
  ): CalendarAccessSource | null {
    if (!share?.target_type) return null;

    switch (share.target_type) {
      case 'user':
        return share.target_id === principals.userId ? 'user_share' : null;

      // The space role the reader holds in this calendar's own space.
      case 'base_role': {
        const named = share.base_role ?? share.target_id;

        return named && grant?.spaceRole === named ? 'base_role_share' : null;
      }

      // The whole space the calendar belongs to; membership was already established above.
      case 'space':
        return calendar.space_id && share.target_id === calendar.space_id
          ? 'space_share'
          : null;

      default:
        return null;
    }
  }

  /**
   * Throws unless this calendar grants the one action the endpoint performs.
   *
   * Sits beside {@link CalendarAccessService.assert}: the level says the caller may write here at all,
   * this says the space lets them do this particular thing.
   */
  assertRight(rights: CalendarRights, right: CalendarRight): void {
    if (rights[right]) return;

    throw new ForbiddenException(
      `You do not have permission to ${RIGHT_WORDING[right]} on this calendar.`,
    );
  }

  /**
   * Throws unless the matrix allows this one action.
   *
   * `what` is what the person was trying to do, in plain words, so the refusal names the thing rather
   * than a flag. The route picks the flag, which is why no route ever has to interpret a level.
   */
  assertAllowed(allowed: boolean, what: string): void {
    if (allowed) return;

    throw new ForbiddenException(`You do not have permission to ${what}.`);
  }

  /** Throws unless the resolved access reaches the level the endpoint needs. */
  assert(access: CalendarAccess, needed: CalendarAccess): void {
    if (
      CalendarAccessService.rank(access) < CalendarAccessService.rank(needed)
    ) {
      throw new ForbiddenException(
        `This calendar requires ${needed} access; you have ${access}.`,
      );
    }
  }

  /**
   * Whether this user may see the tickets of a space at all.
   *
   * Used both when a ticket source is configured and when a calendar is read, so a source never shows
   * anyone a ticket they could not open themselves.
   */
  async canReadSpaceTickets(
    userId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<boolean> {
    const facts = (await this.factsFor(userId, organizationId, [spaceId])).get(
      spaceId,
    );

    if (!facts?.space || !facts.grant) return false;

    return spaceGrantAllows(facts.grant, 'view_tasks');
  }

  /**
   * The spaces tickets can be linked from: every open space of this organization with the Tasks
   * module on. The Link ticket tab offers them all, whoever is linking.
   */
  async linkableSpaces(
    organizationId: string,
    spaceIds?: string[],
  ): Promise<Array<{ id: string; key: string; name: string }>> {
    let query = this.client
      .from('space_modules')
      .select('space_id, spaces!inner(id, key, name)')
      .eq('module_type', 'tasks')
      .eq('is_enabled', true)
      .eq('spaces.organization_id', organizationId)
      .not('spaces.is_archived', 'is', true);

    if (spaceIds) query = query.in('space_id', spaceIds);

    const { data, error } = await query;

    if (error) throw new BadRequestException(error.message);

    const byId = new Map<string, { id: string; key: string; name: string }>();

    for (const row of (data ?? []) as unknown as Array<{
      spaces: { id: string; key: string; name: string } | null;
    }>) {
      if (row.spaces) byId.set(row.spaces.id, row.spaces);
    }

    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A ticket source may come from any linkable space, read access to it or not. */
  async assertLinkableSpace(
    organizationId: string,
    spaceId: string,
  ): Promise<void> {
    if ((await this.linkableSpaces(organizationId, [spaceId])).length === 0) {
      throw new ForbiddenException(
        'Tickets cannot be linked from that space: it is archived, outside this organization or has no Tasks module.',
      );
    }
  }

  /** The same check, as a guard for the endpoint that stores a ticket source. */
  async assertCanReadSpaceTickets(
    userId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<void> {
    if (!(await this.canReadSpaceTickets(userId, organizationId, spaceId))) {
      throw new ForbiddenException(
        'You cannot see the tickets of that space, so it cannot be added to a calendar.',
      );
    }
  }

  /**
   * Whether this user may put a new calendar in this space.
   *
   * The space's own Manage calendars permission decides it, so the matrix in Space Settings is what an
   * admin changes to hand the right out. A calendar outside a space never comes through here.
   */
  async assertCanCreateInSpace(
    userId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<void> {
    const facts = (await this.factsFor(userId, organizationId, [spaceId])).get(
      spaceId,
    );

    // resolveSpaceBaseGrant does not check the tenant, so the space is matched to the org first.
    if (!facts?.space || !facts.grant) {
      throw new ForbiddenException('Space not found in this organization.');
    }

    if (facts.space.is_archived) {
      throw new ForbiddenException(
        'This space no longer accepts new calendars.',
      );
    }

    if (!spaceGrantAllows(facts.grant, 'manage_calendars')) {
      throw new ForbiddenException(
        'You need the Manage calendars permission in this space to create a calendar here.',
      );
    }
  }
}
