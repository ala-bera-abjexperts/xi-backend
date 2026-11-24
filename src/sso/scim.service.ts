/**
 * @fileoverview SCIM 2.0 Users and Groups for Microsoft Entra ID (XE-T346).
 * The organization always comes from the verified SCIM token, and every
 * resource is resolved through that organization's `scim_links`.
 * @module src/sso/scim.service
 */

import { spacesOnlyOwnedBy } from '../spaces/space-member-rules.service';
import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { UserGroupsService } from '../user-groups/user-groups.service';
import type { IScimContext } from './scim-token.guard';
import {
  buildScimGroup,
  buildScimList,
  buildScimUser,
  isUuid,
  normalizeScimPatch,
  normalizeScimUserName,
  parseScimActive,
  parseScimFilter,
  parseScimPaging,
  SCIM_SERVICE_PROVIDER_CONFIG,
  scimError,
} from './scim.util';
import {
  SsoAccountsService,
  type ISsoAccountNames,
  type SsoOrgRole,
} from './sso-accounts.service';
import { getScimBaseUrl } from './sso-urls';

type Query = Record<string, unknown>;
type Body = Record<string, unknown>;

interface IUserLink {
  id: string;
  local_user_id: string;
  user_name: string;
  external_id: string | null;
  prior_role: SsoOrgRole | null;
  deactivated_space_member_ids: string[];
  is_active: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  user: {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    is_active: boolean | null;
  } | null;
}

interface IGroupLink {
  id: string;
  local_group_id: string;
  external_id: string | null;
  group: {
    id: string;
    name: string;
    created_at: string | null;
    updated_at: string | null;
  };
}

const USER_LINK_SELECT =
  'id, local_user_id, user_name, external_id, prior_role, deactivated_space_member_ids, is_active, deleted_at, created_at, updated_at, user:users(id, email, first_name, last_name, is_active)';
const GROUP_LINK_SELECT =
  'id, local_group_id, external_id, group:user_groups!inner(id, name, created_at, updated_at)';

const userExists = () =>
  scimError(HttpStatus.CONFLICT, 'User already exists', 'uniqueness');
const userNotFound = () => scimError(HttpStatus.NOT_FOUND, 'User not found');
const groupNotFound = () => scimError(HttpStatus.NOT_FOUND, 'Group not found');

/** UserGroupsService name clashes (case-insensitive) become SCIM 409 uniqueness. */
const groupConflict = (error: unknown): never => {
  if (
    error instanceof ConflictException ||
    error instanceof BadRequestException
  ) {
    throw scimError(HttpStatus.CONFLICT, 'Group already exists', 'uniqueness');
  }

  throw error;
};

/** Escapes LIKE metacharacters so `ilike` is a case-insensitive equality. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

const MEMBER_PAGE = 1000;

/**
 * Implements SCIM provisioning with per-workspace deprovisioning: SCIM never
 * writes `users.email` or `users.is_active`, and deactivation only removes the
 * token organization's membership (restorable via `scim_links.prior_role`).
 */
@Injectable()
export class ScimService {
  /** @private Logger instance scoped to this service */
  private readonly logger = new Logger(ScimService.name);

  /**
   * @param {SupabaseAdminService} supabaseAdmin - Service-role Supabase client
   * @param {ConfigService} config - Used to build absolute `meta.location` URLs
   * @param {SsoAccountsService} accounts - Shared account/membership rules
   * @param {UserGroupsService} userGroups - Group CRUD and membership writes
   * @param {PermissionsService} permissions - Effective-permission cache eviction
   * @param {AuditLogsService} auditLogs - Audit trail writer
   */
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly config: ConfigService,
    private readonly accounts: SsoAccountsService,
    private readonly userGroups: UserGroupsService,
    private readonly permissions: PermissionsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private get baseUrl() {
    return getScimBaseUrl(this.config);
  }

  /** Static capabilities document with an absolute location. */
  getServiceProviderConfig() {
    return {
      ...SCIM_SERVICE_PROVIDER_CONFIG,
      meta: {
        resourceType: 'ServiceProviderConfig',
        location: `${this.baseUrl}/ServiceProviderConfig`,
      },
    };
  }

  // ── Users ────────────────────────────────────────────────────────────────

  /**
   * Lists linked users (active and inactive, never tombstoned).
   * Filters: `userName eq` and `externalId eq`.
   */
  async listUsers(ctx: IScimContext, query: Query) {
    const filter = parseScimFilter(query.filter, ['userName', 'externalId']);
    const { startIndex, count } = parseScimPaging(
      query.startIndex,
      query.count,
    );
    const run = (head = false) => {
      let request = this.client
        .from('scim_links')
        .select(USER_LINK_SELECT, { count: 'exact', head })
        .eq('organization_id', ctx.orgId)
        .eq('resource_type', 'User')
        .is('deleted_at', null);

      if (filter?.attribute === 'userName') {
        request = request.eq('user_name', filter.value.toLowerCase());
      }

      if (filter?.attribute === 'externalId') {
        request = request.eq('external_id', filter.value);
      }

      return head
        ? request
        : request
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(startIndex - 1, startIndex + count - 2);
    };
    const { data, error, count: total } = await run();

    // PostgREST answers 416 when startIndex is past the end; report the total.
    if (error?.code === 'PGRST103') {
      const { count: all } = await run(true);

      return buildScimList([], all ?? 0, startIndex);
    }

    this.assertOk(error, 'list SCIM users');
    const links = (data ?? []) as unknown as IUserLink[];

    return buildScimList(
      links.filter((link) => link.user).map((link) => this.toUser(link)),
      total ?? links.length,
      startIndex,
    );
  }

  /** Returns one linked user; unknown or foreign ids are 404. */
  async getUser(ctx: IScimContext, id: string) {
    return this.toUser(await this.findUserLink(ctx.orgId, id));
  }

  /**
   * Provisions a user: revives a tombstoned link, attaches an existing account
   * on a domain verified by this org, or creates a new account.
   */
  async createUser(ctx: IScimContext, body: Body) {
    const userName = normalizeScimUserName(body.userName);
    const externalId =
      typeof body.externalId === 'string' ? body.externalId : null;
    const active =
      body.active === undefined ? true : parseScimActive(body.active);
    const name = (
      typeof body.name === 'object' && body.name !== null ? body.name : {}
    ) as Record<string, unknown>;
    const names: ISsoAccountNames = {
      firstName: typeof name.givenName === 'string' ? name.givenName : null,
      lastName: typeof name.familyName === 'string' ? name.familyName : null,
    };
    const byUserName = await this.selectUserLink(
      ctx.orgId,
      'user_name',
      userName,
    );

    if (byUserName && !byUserName.deleted_at) throw userExists();

    let userId: string;

    if (byUserName) {
      userId = byUserName.local_user_id;
      await this.revive(ctx, byUserName, userName, externalId, names);
    } else {
      const user = await this.resolveAccount(ctx.orgId, userName, names);
      const byUser = await this.selectUserLink(
        ctx.orgId,
        'local_user_id',
        user.id,
      );

      if (byUser && !byUser.deleted_at) throw userExists();

      userId = user.id;

      if (byUser) {
        await this.revive(ctx, byUser, userName, externalId, names);
      } else {
        await this.accounts.fillBlankNames(user.id, names);
        await this.accounts.attachMember(
          ctx.orgId,
          user.id,
          user.email,
          'member',
        );

        const { error } = await this.client.from('scim_links').insert({
          organization_id: ctx.orgId,
          resource_type: 'User',
          local_user_id: user.id,
          user_name: userName,
          external_id: externalId,
          is_active: true,
        });

        if (error?.code === '23505') throw userExists();

        this.assertOk(error, 'link SCIM user');
        await this.audit(ctx, 'organization_member', user.id, 'create', {
          active: true,
        });
      }
    }

    const link = await this.findUserLink(ctx.orgId, userId);

    if (!active) {
      await this.deactivate(ctx, link);

      return this.getUser(ctx, userId);
    }

    return this.toUser(link);
  }

  /**
   * Applies a PATCH: `active` (de)activates the membership, `userName` and
   * `externalId` update the link, and names only fill blanks.
   */
  async patchUser(ctx: IScimContext, id: string, body: Body) {
    const link = await this.findUserLink(ctx.orgId, id);
    const patch = normalizeScimPatch(body);
    const linkChanges: Record<string, unknown> = {};

    if (patch.userName !== undefined) {
      linkChanges.user_name = normalizeScimUserName(patch.userName);
    }

    if (patch.externalId !== undefined) {
      linkChanges.external_id = patch.externalId;
    }

    // SAML resolves accounts by link user_name, so re-pointing an owner's link
    // is an owner-membership change (Q13).
    if (
      linkChanges.user_name !== undefined &&
      linkChanges.user_name !== link.user_name &&
      (link.prior_role === 'owner' ||
        (await this.accounts.getMemberRole(ctx.orgId, id)) === 'owner')
    ) {
      await this.assertOwnerToken(ctx);
    }

    if (patch.active === false) await this.deactivate(ctx, link);
    if (patch.active === true) await this.reactivate(ctx, link);

    if (Object.keys(linkChanges).length > 0) {
      const { error } = await this.client
        .from('scim_links')
        .update(linkChanges)
        .eq('id', link.id)
        .eq('organization_id', ctx.orgId);

      if (error?.code === '23505') throw userExists();

      this.assertOk(error, 'update SCIM user link');
    }

    if (patch.givenName !== undefined || patch.familyName !== undefined) {
      await this.accounts.fillBlankNames(id, {
        firstName: patch.givenName,
        lastName: patch.familyName,
      });
    }

    return this.getUser(ctx, id);
  }

  /**
   * Deprovisions a user from this workspace: deactivates, removes the user
   * from this org's groups and tombstones the link (later lookups are 404).
   */
  async deleteUser(ctx: IScimContext, id: string): Promise<void> {
    const link = await this.findUserLink(ctx.orgId, id);

    await this.deactivate(ctx, link);

    const memberships = await this.userGroups.getMembershipsForUsers(
      ctx.orgId,
      [id],
    );
    // Org-scoped ids, so one statement cannot touch another org's groups.
    const groupIds = (memberships[id] ?? []).map((group) => group.id);

    if (groupIds.length > 0) {
      const { error: groupsError } = await this.client
        .from('user_group_members')
        .delete()
        .eq('user_id', id)
        .in('group_id', groupIds);

      this.assertOk(groupsError, 'remove user from groups');
      this.permissions.bustOrg(ctx.orgId);
    }

    const { error } = await this.client
      .from('scim_links')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', link.id)
      .eq('organization_id', ctx.orgId);

    this.assertOk(error, 'tombstone SCIM user link');
    await this.audit(ctx, 'organization_member', id, 'delete', {
      deprovisioned: true,
      removed_group_ids: groupIds,
    });
  }

  // ── Groups ───────────────────────────────────────────────────────────────

  /**
   * Lists linked groups. Filters: `displayName eq` (adopts an unlinked group
   * of that exact name), `externalId eq`, `id eq`, and the membership probe
   * `id eq "x" and members[value eq "y"]`.
   */
  async listGroups(ctx: IScimContext, query: Query) {
    const filter = parseScimFilter(query.filter, [
      'displayName',
      'externalId',
      'id',
    ]);
    const { startIndex, count } = parseScimPaging(
      query.startIndex,
      query.count,
    );
    const withMembers = this.includeMembers(query);

    if (filter?.attribute === 'id') {
      const link = isUuid(filter.value)
        ? await this.selectGroupLink(ctx.orgId, filter.value)
        : null;

      if (!link) return buildScimList([], 0, startIndex);

      if (filter.memberValue === undefined) {
        return buildScimList(
          [await this.renderGroup(link, withMembers)],
          1,
          startIndex,
        );
      }

      const members = isUuid(filter.memberValue)
        ? await this.groupMemberIds([link.local_group_id], filter.memberValue)
        : new Map<string, string[]>();

      if (!members.get(link.local_group_id)?.length) {
        return buildScimList([], 0, startIndex);
      }

      return buildScimList(
        [this.toGroup(link, withMembers ? [filter.memberValue] : undefined)],
        1,
        startIndex,
      );
    }

    const run = (head = false) => {
      let request = this.client
        .from('scim_links')
        .select(GROUP_LINK_SELECT, { count: 'exact', head })
        .eq('organization_id', ctx.orgId)
        .eq('resource_type', 'Group')
        .eq('group.organization_id', ctx.orgId)
        .eq('group.is_deleted', false);

      if (filter?.attribute === 'displayName') {
        request = request.ilike('group.name', escapeLike(filter.value));
      }

      if (filter?.attribute === 'externalId') {
        request = request.eq('external_id', filter.value);
      }

      return head
        ? request
        : request
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(startIndex - 1, startIndex + count - 2);
    };
    let result = await run();

    if (
      filter?.attribute === 'displayName' &&
      !result.error &&
      !result.data?.length &&
      (await this.adoptGroupByName(ctx.orgId, filter.value))
    ) {
      result = await run();
    }

    if (result.error?.code === 'PGRST103') {
      const { count: all } = await run(true);

      return buildScimList([], all ?? 0, startIndex);
    }

    this.assertOk(result.error, 'list SCIM groups');
    const links = (result.data ?? []) as unknown as IGroupLink[];
    const members = withMembers
      ? await this.groupMemberIds(links.map((link) => link.local_group_id))
      : undefined;

    return buildScimList(
      links.map((link) =>
        this.toGroup(
          link,
          members ? (members.get(link.local_group_id) ?? []) : undefined,
        ),
      ),
      result.count ?? links.length,
      startIndex,
    );
  }

  /** Returns one linked group; unknown or foreign ids are 404. */
  async getGroup(ctx: IScimContext, id: string, query: Query) {
    return this.renderGroup(
      await this.findGroupLink(ctx.orgId, id),
      this.includeMembers(query),
    );
  }

  /**
   * Creates a group, adopting an unlinked group of the same name (Q16) or
   * restoring a soft-deleted one, then links it.
   */
  async createGroup(ctx: IScimContext, body: Body) {
    const displayName = this.requireDisplayName(body.displayName);
    const externalId =
      typeof body.externalId === 'string' ? body.externalId : null;
    const { data: rows, error } = await this.client
      .from('user_groups')
      .select('id, is_deleted')
      .eq('organization_id', ctx.orgId)
      .ilike('name', escapeLike(displayName))
      .order('is_deleted', { ascending: true })
      .limit(1);

    this.assertOk(error, 'look up group');
    const existing = (rows ?? [])[0] as
      | { id: string; is_deleted: boolean | null }
      | undefined;
    let groupId: string;

    if (existing) {
      const { data: linked, error: linkError } = await this.client
        .from('scim_links')
        .select('id')
        .eq('organization_id', ctx.orgId)
        .eq('resource_type', 'Group')
        .eq('local_group_id', existing.id)
        .maybeSingle();

      this.assertOk(linkError, 'look up group link');

      if (linked && !existing.is_deleted) {
        throw scimError(
          HttpStatus.CONFLICT,
          'Group already exists',
          'uniqueness',
        );
      }

      if (existing.is_deleted) {
        await this.userGroups
          .restore(existing.id, ctx.orgId, ctx.actorUserId)
          .catch(groupConflict);
      }

      groupId = existing.id;
    } else {
      const created = await this.userGroups
        .create(ctx.orgId, { name: displayName }, ctx.actorUserId)
        .catch(groupConflict);

      groupId = created.data['id'] as string;
    }

    const { error: upsertError } = await this.client.from('scim_links').upsert(
      {
        organization_id: ctx.orgId,
        resource_type: 'Group',
        local_group_id: groupId,
        external_id: externalId,
      },
      { onConflict: 'organization_id,local_group_id' },
    );

    this.assertOk(upsertError, 'link SCIM group');

    const members = normalizeScimPatch({
      Operations: [{ op: 'add', path: 'members', value: body.members ?? [] }],
    }).addMembers;

    await this.addGroupMembers(ctx, groupId, members);
    await this.audit(ctx, 'user_group', groupId, 'create', {
      display_name: displayName,
      adopted: Boolean(existing),
    });

    return this.renderGroup(await this.findGroupLink(ctx.orgId, groupId), true);
  }

  /** Applies a PATCH: `displayName` renames; members add/remove. */
  async patchGroup(ctx: IScimContext, id: string, body: Body): Promise<void> {
    const link = await this.findGroupLink(ctx.orgId, id);
    const patch = normalizeScimPatch(body);
    const displayName =
      patch.displayName === undefined
        ? undefined
        : this.requireDisplayName(patch.displayName);

    if (displayName !== undefined && displayName !== link.group.name) {
      await this.userGroups.update(
        id,
        ctx.orgId,
        { name: displayName },
        ctx.actorUserId,
      );
    }

    const removeIds = patch.removeMembers.filter(isUuid);

    if (removeIds.length > 0) {
      await this.userGroups.removeMembers(
        id,
        ctx.orgId,
        removeIds,
        ctx.actorUserId,
      );
    }

    await this.addGroupMembers(ctx, id, patch.addMembers);
    await this.audit(ctx, 'user_group', id, 'update', {
      display_name: displayName,
      added_members: patch.addMembers,
      removed_members: removeIds,
    });
  }

  /** Removes all members, soft-deletes the group and drops its link. */
  async deleteGroup(ctx: IScimContext, id: string): Promise<void> {
    const link = await this.findGroupLink(ctx.orgId, id);
    // One statement, no id list: the link above already proved the org.
    const { error: membersError } = await this.client
      .from('user_group_members')
      .delete()
      .eq('group_id', id);

    this.assertOk(membersError, 'clear group members');
    await this.userGroups.delete(id, ctx.orgId, ctx.actorUserId);

    const { error } = await this.client
      .from('scim_links')
      .delete()
      .eq('id', link.id)
      .eq('organization_id', ctx.orgId);

    this.assertOk(error, 'unlink SCIM group');
    await this.audit(ctx, 'user_group', id, 'delete', {
      display_name: link.group.name,
    });
  }

  // ── Membership lifecycle ─────────────────────────────────────────────────

  /**
   * Removes this org's membership (idempotent), deactivates the user's direct
   * space memberships in this org and records what to restore on the link.
   *
   * @throws {HttpException} 400 `mutability` for owner protection or the sole owner
   */
  private async deactivate(ctx: IScimContext, link: IUserLink): Promise<void> {
    const userId = link.local_user_id;
    const role = await this.accounts.getMemberRole(ctx.orgId, userId);

    if (role === 'owner') await this.assertOwnerToken(ctx);

    if (role) {
      const { error } = await this.client
        .from('organization_members')
        .delete()
        .eq('organization_id', ctx.orgId)
        .eq('user_id', userId);

      // trg_prevent_orphan_organization: the sole owner cannot be removed.
      if (error?.code === '23514') {
        throw scimError(
          HttpStatus.BAD_REQUEST,
          'This workspace must keep at least one owner',
          'mutability',
        );
      }

      this.assertOk(error, 'remove organization member');
    }

    const { data: spaces, error: spacesError } = await this.client
      .from('spaces')
      .select('id')
      .eq('organization_id', ctx.orgId);

    this.assertOk(spacesError, 'list spaces');
    const spaceIds = ((spaces ?? []) as { id: string }[]).map(
      (space) => space.id,
    );
    let deactivatedIds: string[] = [];
    // Never stops the deprovisioning: org owners and admins still manage these spaces. Recorded below.
    const leftWithoutOwner = await spacesOnlyOwnedBy(this.client, ctx.orgId, userId);

    if (spaceIds.length > 0) {
      // ponytail: one IN list of the org's space ids; chunk it if an org ever
      // reaches thousands of spaces (URL length).
      const { data: rows, error } = await this.client
        .from('space_members')
        .update({ is_active: false })
        .in('space_id', spaceIds)
        .eq('user_id', userId)
        .eq('member_type', 'user')
        .eq('is_active', true)
        .select('id');

      this.assertOk(error, 'deactivate space memberships');
      deactivatedIds = ((rows ?? []) as { id: string }[]).map((row) => row.id);
    }

    await this.accounts.expirePendingInvitations(
      ctx.orgId,
      link.user?.email ?? link.user_name,
    );

    // Re-read so a concurrent deactivation's saved state is never overwritten
    // with this request's stale snapshot.
    // ponytail: a tiny window remains between this read and the update; use a
    // conditional update or an RPC if overlapping deprovisions ever collide.
    const fresh =
      (await this.selectUserLink(ctx.orgId, 'local_user_id', userId)) ?? link;
    const { error: linkError } = await this.client
      .from('scim_links')
      .update({
        is_active: false,
        // The role actually removed wins; with none, keep what an inactive
        // link already stored (an active link has nothing to restore).
        prior_role: role ?? (fresh.is_active ? null : fresh.prior_role),
        deactivated_space_member_ids: [
          ...new Set([
            ...fresh.deactivated_space_member_ids,
            ...deactivatedIds,
          ]),
        ],
      })
      .eq('id', link.id)
      .eq('organization_id', ctx.orgId);

    this.assertOk(linkError, 'deactivate SCIM user link');
    this.permissions.bustUser(userId, ctx.orgId);
    await this.audit(ctx, 'organization_member', userId, 'update', {
      active: false,
      ...(leftWithoutOwner.length && { spaces_left_without_owner: leftWithoutOwner }),
    });
  }

  /**
   * Restores the membership with its prior role and the space memberships
   * SCIM deactivated. A no-op for an already active link.
   *
   * @throws {HttpException} 400 `mutability` when restoring an owner without an owner token
   */
  private async reactivate(ctx: IScimContext, link: IUserLink): Promise<void> {
    if (link.is_active) return;

    const userId = link.local_user_id;

    if (link.prior_role === 'owner') await this.assertOwnerToken(ctx);

    await this.accounts.attachMember(
      ctx.orgId,
      userId,
      link.user?.email ?? link.user_name,
      link.prior_role ?? 'member',
    );

    if (link.deactivated_space_member_ids.length > 0) {
      const { error } = await this.client
        .from('space_members')
        .update({ is_active: true })
        .in('id', link.deactivated_space_member_ids)
        .eq('user_id', userId);

      this.assertOk(error, 'restore space memberships');
    }

    const { error: linkError } = await this.client
      .from('scim_links')
      .update({ is_active: true, deactivated_space_member_ids: [] })
      .eq('id', link.id)
      .eq('organization_id', ctx.orgId);

    this.assertOk(linkError, 'reactivate SCIM user link');
    this.permissions.bustUser(userId, ctx.orgId);
    await this.audit(ctx, 'organization_member', userId, 'update', {
      active: true,
    });
  }

  /** Brings a tombstoned link back (POST of a previously deleted userName). */
  private async revive(
    ctx: IScimContext,
    link: IUserLink,
    userName: string,
    externalId: string | null,
    names: ISsoAccountNames,
  ): Promise<void> {
    if (link.user?.is_active === false) {
      throw scimError(HttpStatus.BAD_REQUEST, 'The account is inactive');
    }

    const { error } = await this.client
      .from('scim_links')
      .update({
        deleted_at: null,
        user_name: userName,
        external_id: externalId,
      })
      .eq('id', link.id)
      .eq('organization_id', ctx.orgId);

    if (error?.code === '23505') throw userExists();

    this.assertOk(error, 'revive SCIM user link');
    await this.accounts.fillBlankNames(link.local_user_id, names);
    await this.reactivate(ctx, { ...link, user_name: userName });
  }

  /**
   * Finds or creates the account for a new SCIM user. An existing account is
   * only attachable when its email domain is verified by this org.
   */
  private async resolveAccount(
    orgId: string,
    email: string,
    names: ISsoAccountNames,
  ) {
    const user = await this.accounts.findUserByEmail(email);

    if (user) {
      // Domain first, so the 400 below never reveals accounts outside it.
      if (!(await this.accounts.isDomainVerifiedForOrg(orgId, user.email))) {
        throw userExists();
      }

      if (user.is_active === false) {
        throw scimError(HttpStatus.BAD_REQUEST, 'The account is inactive');
      }

      return user;
    }

    try {
      return await this.accounts.createAccount(email, names);
    } catch (error) {
      // An orphan auth user (no profile row) is refused.
      if (error instanceof ConflictException) throw userExists();

      throw error;
    }
  }

  private async assertOwnerToken(ctx: IScimContext): Promise<void> {
    if (!(await this.accounts.isCurrentOwner(ctx.orgId, ctx.creatorUserId))) {
      throw scimError(
        HttpStatus.BAD_REQUEST,
        'Owner memberships can only be changed with a SCIM token created by a current owner',
        'mutability',
      );
    }
  }

  // ── Group helpers ────────────────────────────────────────────────────────

  /**
   * Adds members limited to this org's members. A concurrent duplicate add
   * that already produced every row counts as success.
   */
  private async addGroupMembers(
    ctx: IScimContext,
    groupId: string,
    values: string[],
  ): Promise<void> {
    const ids = [...new Set(values.filter(isUuid))];

    if (ids.length === 0) return;

    const { data, error } = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', ctx.orgId)
      .in('user_id', ids);

    this.assertOk(error, 'validate group members');
    const memberIds = ((data ?? []) as { user_id: string }[]).map(
      (row) => row.user_id,
    );

    if (memberIds.length === 0) return;

    try {
      await this.userGroups.addMembers(
        groupId,
        ctx.orgId,
        memberIds,
        null,
        ctx.actorUserId,
      );
    } catch (addError) {
      const { data: rows } = await this.client
        .from('user_group_members')
        .select('user_id')
        .eq('group_id', groupId)
        .in('user_id', memberIds);

      if ((rows ?? []).length === memberIds.length) return;

      throw addError;
    }
  }

  /** Links an unlinked, active group with exactly this name (Q16). */
  private async adoptGroupByName(
    orgId: string,
    name: string,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from('user_groups')
      .select('id')
      .eq('organization_id', orgId)
      .ilike('name', escapeLike(name))
      .eq('is_deleted', false)
      .limit(1)
      .maybeSingle();

    this.assertOk(error, 'look up group by name');

    if (!data) return false;

    const { error: insertError } = await this.client.from('scim_links').insert({
      organization_id: orgId,
      resource_type: 'Group',
      local_group_id: (data as { id: string }).id,
    });

    // 23505: linked concurrently, which is the same outcome.
    if (insertError?.code !== '23505') {
      this.assertOk(insertError, 'adopt group');
    }

    return true;
  }

  /** Member user ids per group, optionally narrowed to one user. */
  private async groupMemberIds(
    groupIds: string[],
    userId?: string,
  ): Promise<Map<string, string[]>> {
    const members = new Map<string, string[]>();

    if (groupIds.length === 0) return members;

    // PostgREST caps a response at max_rows (1000), so page until a short page.
    for (let from = 0; ; from += MEMBER_PAGE) {
      let request = this.client
        .from('user_group_members')
        .select('group_id, user_id')
        .in('group_id', groupIds);

      if (userId) request = request.eq('user_id', userId);

      const { data, error } = await request
        .order('id', { ascending: true })
        .range(from, from + MEMBER_PAGE - 1);

      this.assertOk(error, 'list group members');
      const rows = (data ?? []) as { group_id: string; user_id: string }[];

      for (const row of rows) {
        members.set(row.group_id, [
          ...(members.get(row.group_id) ?? []),
          row.user_id,
        ]);
      }

      if (rows.length < MEMBER_PAGE) return members;
    }
  }

  private async renderGroup(link: IGroupLink, withMembers: boolean) {
    const members = withMembers
      ? ((await this.groupMemberIds([link.local_group_id])).get(
          link.local_group_id,
        ) ?? [])
      : undefined;

    return this.toGroup(link, members);
  }

  private includeMembers(query: Query): boolean {
    const excluded =
      typeof query.excludedAttributes === 'string'
        ? query.excludedAttributes
        : '';

    return !/(^|,)\s*members\s*(,|$)/i.test(excluded);
  }

  private requireDisplayName(value: unknown): string {
    const name = typeof value === 'string' ? value.trim() : '';

    if (!name || name.length > 100) {
      throw scimError(
        HttpStatus.BAD_REQUEST,
        'displayName must be 1-100 characters',
        'invalidValue',
      );
    }

    return name;
  }

  // ── Lookups ──────────────────────────────────────────────────────────────

  private async selectUserLink(
    orgId: string,
    column: 'user_name' | 'local_user_id',
    value: string,
  ): Promise<IUserLink | null> {
    const { data, error } = await this.client
      .from('scim_links')
      .select(USER_LINK_SELECT)
      .eq('organization_id', orgId)
      .eq('resource_type', 'User')
      .eq(column, value)
      .maybeSingle();

    this.assertOk(error, 'look up SCIM user link');

    return data as unknown as IUserLink | null;
  }

  private async findUserLink(orgId: string, id: string): Promise<IUserLink> {
    if (!isUuid(id)) throw userNotFound();

    const link = await this.selectUserLink(orgId, 'local_user_id', id);

    if (!link || link.deleted_at || !link.user) throw userNotFound();

    return link;
  }

  private async selectGroupLink(
    orgId: string,
    groupId: string,
  ): Promise<IGroupLink | null> {
    const { data, error } = await this.client
      .from('scim_links')
      .select(GROUP_LINK_SELECT)
      .eq('organization_id', orgId)
      .eq('resource_type', 'Group')
      .eq('local_group_id', groupId)
      .eq('group.organization_id', orgId)
      .eq('group.is_deleted', false)
      .maybeSingle();

    this.assertOk(error, 'look up SCIM group link');

    return data as unknown as IGroupLink | null;
  }

  private async findGroupLink(orgId: string, id: string): Promise<IGroupLink> {
    const link = isUuid(id) ? await this.selectGroupLink(orgId, id) : null;

    if (!link) throw groupNotFound();

    return link;
  }

  // ── Rendering, errors, audit ─────────────────────────────────────────────

  private toUser(link: IUserLink) {
    return buildScimUser(this.baseUrl, link.user!, link);
  }

  private toGroup(link: IGroupLink, memberIds?: string[]) {
    return buildScimGroup(
      this.baseUrl,
      link.group,
      link.external_id,
      memberIds,
    );
  }

  private assertOk(error: { message: string } | null, action: string): void {
    if (!error) return;

    this.logger.error(`Failed to ${action}: ${error.message}`);
    throw new InternalServerErrorException();
  }

  private async audit(
    ctx: IScimContext,
    entityType: 'organization_member' | 'user_group',
    entityId: string,
    action: 'create' | 'update' | 'delete',
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.auditLogs.logSystemAction(
      ctx.orgId,
      entityType,
      entityId,
      action,
      { source: 'scim', token_id: ctx.tokenId, ...changes },
    );
  }
}
