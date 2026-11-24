/**
 * @fileoverview Service for resolving a user's effective permissions within an organization.
 * Combines base role permissions, custom role permissions, base role overrides, and group
 * memberships into a single effective permissions object. Also provides convenience methods
 * for checking specific permissions, admin/owner status, menu permissions, level permissions,
 * and space permission overrides.
 * @module src/permissions/permissions.service
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  IBaseRole,
  IPermissionsObject,
  IUserEffectivePermissions,
  ICustomRole,
  IUserGroup,
  DEFAULT_PERMISSIONS_BY_ROLE,
  SPACE_SETTINGS_TAB_KEYS,
  calculateEffectivePermissions,
  hasPermission,
} from './models/access-control.model';
import {
  normalizeSpacePermissions,
  ORG_GRANTED_SPACE_PERMISSIONS,
  SPACE_ROLE_BASE_PERMISSIONS,
  spaceGrantAllows,
  isTestManagementPermission,
  TEST_MANAGEMENT_PERMISSION_KEYS,
  type ISpaceBaseGrant,
  type TestManagementPermissionKey,
} from './models/space-permissions.model';

/** Test Management decision for one user in one space. */
export interface ITestManagementGrant {
  /** Org admin/owner, own member row, or a group or custom role of theirs in the space */
  isMember: boolean;
  /** Own `space_members` row; without one the space screens cannot be opened */
  hasOwnRow: boolean;
  permissions: Record<TestManagementPermissionKey, boolean>;
}

export interface IMenuPermission {
  id: string;
  organization_id: string;
  menu_key: string;
  target_type: string;
  user_id?: string | null;
  role_id?: string | null;
  group_id?: string | null;
  base_role?: string | null;
  can_view: boolean;
  created_at?: string;
}

export interface ILevelPermission {
  id: string;
  organization_id: string;
  hierarchy_level_id: string;
  entity_type: string;
  target_type: string;
  user_id?: string | null;
  role_id?: string | null;
  group_id?: string | null;
  base_role?: string | null;
  can_view: boolean;
  can_create: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_view_history: boolean;
  can_view_attachments: boolean;
  can_add_attachments: boolean;
  can_delete_attachments: boolean;
  can_view_comments: boolean;
  can_add_comments: boolean;
  can_delete_comments: boolean;
  created_at?: string;
}

const VALID_BASE_ROLES = ['owner', 'admin', 'member', 'viewer'];
const SPACE_ROLE_RANK: Record<string, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

function isAllowedPermissionOverrideKey(key: string): boolean {
  return /^can_[a-z0-9_]+$/.test(key);
}

function normalizeSpaceRole(
  role: string | null | undefined,
): keyof typeof SPACE_ROLE_BASE_PERMISSIONS {
  if (role === 'owner') return 'owner';
  if (role === 'admin' || role === 'space_admin') return 'admin';
  if (role === 'member') return 'member';
  return 'viewer';
}

function toSpacePermissionKey(key: string): string {
  return key.startsWith('can_') ? key.slice(4) : key;
}

/**
 * Applies a permission object on top of `target`. With `grantOnly`, only `true`
 * values are applied: used for org-wide custom roles and groups, which add to a
 * user's space role but never take rights away. Restrictions for one space are
 * set in that space's own settings (membership, space_permissions rows).
 */
function mergePermissionObject(
  target: Record<string, boolean>,
  source: Record<string, unknown> | null | undefined,
  grantOnly = false,
): void {
  if (!source) return;

  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'boolean' && (value || !grantOnly)) {
      target[toSpacePermissionKey(key)] = value;
    }
  }
}

interface EffectivePermissionsCacheEntry {
  promise: Promise<IUserEffectivePermissions>;
  expiresAt: number;
}

interface SpacePermissionsResult {
  isMember: boolean;
  spaceRole: string | null;
  globalRole: string | null;
  permissions: Record<string, boolean>;
}

interface SpacePermissionsCacheEntry {
  promise: Promise<SpacePermissionsResult>;
  expiresAt: number;
}

@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);

  /**
   * Short-TTL cache for `getUserEffectivePermissions`.
   *
   * WHY: this method runs inside PermissionsGuard on nearly every authenticated
   * request, and each call is 2 waves of PostgREST HTTP round trips. A single
   * page load performs many permission checks within milliseconds, so almost all
   * of that traffic is the same answer recomputed over and over.
   *
   * SAFETY — read this before changing the TTL. RLS is bypassed everywhere in
   * this codebase (all queries run as service_role), so these application-level
   * checks are the ONLY tenant boundary. That makes cache staleness an
   * authorization concern, not a UX one. Two properties keep it safe:
   *
   *   1. Every mutation that can change a user's permissions calls `bustUser` /
   *      `bustOrg` (wired in CustomRolesService and UserGroupsService, and in
   *      this service's own override writers).
   *   2. The TTL is the BACKSTOP, not the mechanism. If an invalidation call is
   *      ever missed — a new write path, a refactor — the worst case is a stale
   *      permission for at most CACHE_TTL_MS, never indefinitely. Invalidation
   *      is the optimization; the TTL is what makes a missed call survivable.
   *
   * Deliberately kept SHORTER than EntitlementsService's 30s: entitlements
   * describe billing, these describe authorization, and the win here comes from
   * collapsing a burst of checks within one page load rather than from caching
   * across minutes.
   *
   * Caches the PROMISE, so concurrent callers share one in-flight resolution
   * instead of stampeding the database.
   */
  private static readonly CACHE_TTL_MS = 10_000;

  private readonly effectivePermissionsCache = new Map<
    string,
    EffectivePermissionsCacheEntry
  >();

  /**
   * Same treatment for per-space resolution, which is even hotter: 41 call sites,
   * ~9 sequential round trips each.
   *
   * The pathological caller is `SavedFiltersService.getPermittedSpaceIdsByEntity`,
   * which resolves permissions for EVERY space in the org — 73 on the largest
   * tenant — and is itself invoked once per dashboard widget. A 12-widget
   * dashboard therefore repeated the same 73 resolutions twelve times. Caching by
   * (user, org, space) collapses that to one pass, and the shared in-flight
   * promise means widgets rendering concurrently wait on one resolve rather than
   * racing.
   *
   * Keyed `userId:organizationId:spaceId`. UUIDs contain no colons, so segment
   * matching in the bust helpers is exact.
   */
  private readonly spacePermissionsCache = new Map<
    string,
    SpacePermissionsCacheEntry
  >();

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private static cacheKey(userId: string, organizationId: string): string {
    return `${userId}:${organizationId}`;
  }

  private static spaceCacheKey(
    userId: string,
    organizationId: string,
    spaceId: string,
  ): string {
    return `${userId}:${organizationId}:${spaceId}`;
  }

  /**
   * Drop one user's cached permissions for one org. Call after any write that
   * changes THAT user's role, custom-role assignments or group membership.
   */
  bustUser(userId: string, organizationId: string): void {
    this.effectivePermissionsCache.delete(
      PermissionsService.cacheKey(userId, organizationId),
    );

    for (const key of this.spacePermissionsCache.keys()) {
      const [u, o] = key.split(':');
      if (u === userId && o === organizationId) {
        this.spacePermissionsCache.delete(key);
      }
    }
  }

  /**
   * Drop every cached entry for an org. Required when a change affects users
   * we cannot enumerate cheaply — editing a custom role's permission set, a
   * group's permissions, or the org's base-role overrides all change the
   * effective permissions of every member holding that role/group.
   */
  bustOrg(organizationId: string): void {
    const suffix = `:${organizationId}`;

    for (const key of this.effectivePermissionsCache.keys()) {
      if (key.endsWith(suffix)) this.effectivePermissionsCache.delete(key);
    }

    // Space-scoped entries are `user:org:space`, so match the org SEGMENT rather
    // than a suffix — a suffix test would never hit these.
    for (const key of this.spacePermissionsCache.keys()) {
      if (key.split(':')[1] === organizationId) {
        this.spacePermissionsCache.delete(key);
      }
    }
  }

  /** Clear everything. Used by tests. */
  bustAllPermissions(): void {
    this.effectivePermissionsCache.clear();
    this.spacePermissionsCache.clear();
  }

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ── Effective Permissions ──────────────────────────────────────────────────

  getUserEffectivePermissions(
    userId: string,
    organizationId: string,
  ): Promise<IUserEffectivePermissions> {
    const now = Date.now();
    const key = PermissionsService.cacheKey(userId, organizationId);
    const cached = this.effectivePermissionsCache.get(key);

    if (cached && cached.expiresAt > now) return cached.promise;

    const promise = this.resolveUserEffectivePermissions(
      userId,
      organizationId,
    );

    this.effectivePermissionsCache.set(key, {
      promise,
      expiresAt: now + PermissionsService.CACHE_TTL_MS,
    });

    // On failure, evict so the next caller retries instead of replaying the
    // rejection for the whole TTL. Only evict if this is still OUR entry — a
    // bust may have replaced it while the request was in flight.
    promise.catch(() => {
      const current = this.effectivePermissionsCache.get(key);
      if (current && current.promise === promise) {
        this.effectivePermissionsCache.delete(key);
      }
    });

    return promise;
  }

  private async resolveUserEffectivePermissions(
    userId: string,
    organizationId: string,
  ): Promise<IUserEffectivePermissions> {
    const { data: membership, error: membershipError } = await this.client
      .from('organization_members')
      .select('role')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .single();

    if (membershipError) {
      this.logger.warn(
        `No membership found for user ${userId} in org ${organizationId}`,
      );
      return {
        user_id: userId,
        base_role: 'viewer',
        custom_roles: [],
        groups: [],
        effective_permissions: DEFAULT_PERMISSIONS_BY_ROLE['viewer'],
        hidden_space_settings_tabs: [],
      };
    }

    const baseRole = (membership?.role || 'viewer') as IBaseRole;

    // These three were previously awaited one after another, so this method cost
    // four SEQUENTIAL PostgREST round trips. Every DB call here is an HTTP request
    // (supabase-js → PostgREST), and this runs inside PermissionsGuard on nearly
    // every authenticated request — so the latency is paid by the whole product.
    //
    // They are mutually independent: only `base_role_permission_overrides` needs
    // anything from above, and it needs just `baseRole`, which is already resolved.
    // Running them together takes the method from 4 sequential round trips to 2
    // (membership, then this batch).
    //
    // The membership query is deliberately NOT folded in: its error path returns
    // early with viewer defaults, and hoisting it would fire these three on a
    // request that is about to discard them.
    const [
      { data: roleAssignments },
      { data: groupMemberships },
      { data: baseRoleOverride },
    ] = await Promise.all([
      this.client
        .from('user_role_assignments')
        .select('*, role:custom_roles(*)')
        .eq('user_id', userId)
        .eq('organization_id', organizationId),
      this.client
        .from('user_group_members')
        .select('group:user_groups(*)')
        .eq('user_id', userId),
      this.client
        .from('base_role_permission_overrides')
        .select('permissions')
        .eq('organization_id', organizationId)
        .eq('base_role', baseRole)
        .maybeSingle(),
    ]);

    const customRoles: ICustomRole[] = (roleAssignments || [])
      .map((a: Record<string, unknown>) => a.role as ICustomRole)
      .filter(
        (r: ICustomRole | null | undefined): r is ICustomRole => r != null,
      );

    const groups: IUserGroup[] = (groupMemberships || [])
      .map((m: Record<string, unknown>) => m.group as IUserGroup)
      .filter((g: IUserGroup | null | undefined): g is IUserGroup => g != null);

    const effectivePermissions = calculateEffectivePermissions(
      baseRole,
      customRoles,
      baseRoleOverride?.permissions as IPermissionsObject | undefined,
    );

    // Hidden wins: any explicit false from base override, custom role or group hides the tab
    const hiddenSources: unknown[] =
      baseRole === 'owner'
        ? []
        : [
            baseRoleOverride?.permissions,
            ...(customRoles as unknown as Record<string, unknown>[])
              .filter(
                (r) => r['is_deleted'] !== true && r['is_active'] !== false,
              )
              .map((r) => r['permissions']),
            ...(groups as unknown as Record<string, unknown>[])
              .filter(
                (g) =>
                  g['organization_id'] === organizationId &&
                  g['is_deleted'] !== true,
              )
              .map((g) => g['permissions']),
          ];
    const hiddenSpaceSettingsTabs = SPACE_SETTINGS_TAB_KEYS.filter((key) =>
      hiddenSources.some(
        (perms) => (perms as Record<string, unknown> | null)?.[key] === false,
      ),
    );

    return {
      user_id: userId,
      base_role: baseRole,
      custom_roles: customRoles,
      groups,
      effective_permissions: effectivePermissions,
      hidden_space_settings_tabs: hiddenSpaceSettingsTabs,
    };
  }

  async checkPermission(
    userId: string,
    organizationId: string,
    permission: string,
  ): Promise<boolean> {
    const effective = await this.getUserEffectivePermissions(
      userId,
      organizationId,
    );
    return hasPermission(effective.effective_permissions, permission);
  }

  getUserSpacePermissions(
    userId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<SpacePermissionsResult> {
    const now = Date.now();
    const key = PermissionsService.spaceCacheKey(
      userId,
      organizationId,
      spaceId,
    );
    const cached = this.spacePermissionsCache.get(key);

    if (cached && cached.expiresAt > now) return cached.promise;

    const promise = this.resolveUserSpacePermissions(
      userId,
      organizationId,
      spaceId,
    );

    this.spacePermissionsCache.set(key, {
      promise,
      expiresAt: now + PermissionsService.CACHE_TTL_MS,
    });

    promise.catch(() => {
      const current = this.spacePermissionsCache.get(key);
      if (current && current.promise === promise) {
        this.spacePermissionsCache.delete(key);
      }
    });

    return promise;
  }

  private async resolveUserSpacePermissions(
    userId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<SpacePermissionsResult> {
    const { data: space, error: spaceError } = await this.client
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (spaceError) throw new BadRequestException(spaceError.message);
    if (!space) {
      return {
        isMember: false,
        spaceRole: null,
        globalRole: null,
        permissions: {},
      };
    }

    const { data: orgMember } = await this.client
      .from('organization_members')
      .select('role')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    const globalRole = (orgMember as { role?: string } | null)?.role ?? null;

    const { data: groupMemberships } = await this.client
      .from('user_group_members')
      .select(
        'group_id, role_id, group:user_groups(id, organization_id, permissions, is_deleted)',
      )
      .eq('user_id', userId);

    const userGroups = (
      (groupMemberships ?? []) as Record<string, unknown>[]
    ).filter((membership) => {
      const group = membership['group'] as Record<string, unknown> | null;
      return (
        group &&
        group['organization_id'] === organizationId &&
        group['is_deleted'] !== true
      );
    });
    const groupIds = userGroups
      .map((membership) => membership['group_id'] as string | null)
      .filter((id): id is string => Boolean(id));
    const groupRoleIds = userGroups
      .map((membership) => membership['role_id'] as string | null)
      .filter((id): id is string => Boolean(id));

    const { data: roleAssignments } = await this.client
      .from('user_role_assignments')
      .select('role_id')
      .eq('user_id', userId)
      .eq('organization_id', organizationId);
    const directRoleIds = ((roleAssignments ?? []) as Record<string, unknown>[])
      .map((assignment) => assignment['role_id'] as string | null)
      .filter((id): id is string => Boolean(id));
    const roleIds = [...new Set([...directRoleIds, ...groupRoleIds])];

    const { data: customRoles } =
      roleIds.length > 0
        ? await this.client
            .from('custom_roles')
            .select('id, permissions, is_active, is_deleted')
            .eq('organization_id', organizationId)
            .in('id', roleIds)
        : { data: [] };

    const membershipRows: Record<string, unknown>[] = [];

    const { data: directMembers } = await this.client
      .from('space_members')
      .select(
        'space_role, permissions, member_type, user_id, group_id, role_id',
      )
      .eq('space_id', spaceId)
      .eq('member_type', 'user')
      .eq('user_id', userId)
      .eq('is_active', true);
    membershipRows.push(
      ...((directMembers ?? []) as Record<string, unknown>[]),
    );

    if (groupIds.length > 0) {
      const { data: groupMembers } = await this.client
        .from('space_members')
        .select(
          'space_role, permissions, member_type, user_id, group_id, role_id',
        )
        .eq('space_id', spaceId)
        .eq('member_type', 'group')
        .in('group_id', groupIds)
        .eq('is_active', true);
      membershipRows.push(
        ...((groupMembers ?? []) as Record<string, unknown>[]),
      );
    }

    if (roleIds.length > 0) {
      const { data: roleMembers } = await this.client
        .from('space_members')
        .select(
          'space_role, permissions, member_type, user_id, group_id, role_id',
        )
        .eq('space_id', spaceId)
        .eq('member_type', 'role')
        .in('role_id', roleIds)
        .eq('is_active', true);
      membershipRows.push(
        ...((roleMembers ?? []) as Record<string, unknown>[]),
      );
    }

    const implicitAdminMember =
      (globalRole === 'owner' || globalRole === 'admin') &&
      membershipRows.length === 0;

    if (!implicitAdminMember && membershipRows.length === 0) {
      return { isMember: false, spaceRole: null, globalRole, permissions: {} };
    }

    let roleKey: keyof typeof SPACE_ROLE_BASE_PERMISSIONS = implicitAdminMember
      ? normalizeSpaceRole(globalRole)
      : 'viewer';

    for (const membership of membershipRows) {
      const candidate = normalizeSpaceRole(
        membership['space_role'] as string | null,
      );
      if (SPACE_ROLE_RANK[candidate] > SPACE_ROLE_RANK[roleKey]) {
        roleKey = candidate;
      }
    }

    const permissions: Record<string, boolean> = {
      ...SPACE_ROLE_BASE_PERMISSIONS[roleKey],
    };

    for (const role of (customRoles ?? []) as Record<string, unknown>[]) {
      if (role['is_active'] === false || role['is_deleted'] === true) continue;
      mergePermissionObject(
        permissions,
        role['permissions'] as Record<string, unknown>,
        true,
      );
    }

    for (const membership of userGroups) {
      const group = membership['group'] as Record<string, unknown> | null;
      mergePermissionObject(
        permissions,
        group?.['permissions'] as Record<string, unknown>,
        true,
      );
    }

    for (const membership of membershipRows) {
      mergePermissionObject(
        permissions,
        membership['permissions'] as Record<string, unknown>,
      );
    }

    const matchesTarget = (row: Record<string, unknown>): boolean => {
      const targetType = row['target_type'];
      const targetId = (row['target_id'] as string | null) ?? null;

      if (targetType === 'user') {
        return row['user_id'] === userId || targetId === userId;
      }
      if (targetType === 'base_role') {
        return row['base_role'] === roleKey || targetId === roleKey;
      }
      if (targetType === 'group') {
        return groupIds.includes(
          (row['group_id'] as string | null) ?? targetId ?? '',
        );
      }
      if (targetType === 'role') {
        return roleIds.includes(
          (row['role_id'] as string | null) ?? targetId ?? '',
        );
      }

      return false;
    };

    const { data: spacePermRows } = await this.client
      .from('space_permissions')
      .select('*')
      .eq('space_id', spaceId);

    for (const row of (
      (spacePermRows ?? []) as Record<string, unknown>[]
    ).filter(matchesTarget)) {
      mergePermissionObject(permissions, row);
    }

    const { data: moduleRows } = await this.client
      .from('space_module_permissions')
      .select('*')
      .eq('space_id', spaceId);

    for (const row of ((moduleRows ?? []) as Record<string, unknown>[]).filter(
      matchesTarget,
    )) {
      mergePermissionObject(
        permissions,
        row['permissions'] as Record<string, unknown>,
      );
    }

    return {
      isMember: true,
      spaceRole: roleKey,
      globalRole,
      permissions: normalizeSpacePermissions(permissions),
    };
  }

  /**
   * Resolves the `space` slice for `GET /permissions/effective?spaceId|spaceKey`.
   *
   * Looks up the space by UUID or key within the caller's org, then runs
   * getUserSpacePermissions. Returns null for a non-member, a nonexistent space,
   * or a cross-org space, all the same, so the endpoint doesn't leak which
   * spaces exist. Key resolution is inlined here (case-insensitive) to keep this
   * inside PermissionsModule and avoid a circular import on SpacesModule.
   * spaceId wins over spaceKey when both are passed.
   */
  async getEffectiveSpaceSlice(
    userId: string,
    organizationId: string,
    opts: { spaceId?: string; spaceKey?: string },
  ): Promise<{
    id: string;
    key: string;
    role: string | null;
    permissions: Record<string, boolean>;
  } | null> {
    if (!organizationId) return null;
    if (!opts.spaceId && !opts.spaceKey) return null;

    // Resolve to a single org-scoped row. spaceId takes precedence over spaceKey.
    let query = this.client
      .from('spaces')
      .select('id, key')
      .eq('organization_id', organizationId);

    if (opts.spaceId) {
      query = query.eq('id', opts.spaceId);
    } else {
      query = query.eq('key', (opts.spaceKey as string).toUpperCase());
    }

    const { data: space, error } = await query.maybeSingle();

    if (error) throw new BadRequestException(error.message);

    // Nonexistent or cross-org both return the same null, no existence leak.
    if (!space) return null;

    const spaceRow = space as { id: string; key: string };

    const resolved = await this.getUserSpacePermissions(
      userId,
      organizationId,
      spaceRow.id,
    );

    // Non-member returns the same null, indistinguishable from nonexistent.
    if (!resolved.isMember) return null;

    return {
      id: spaceRow.id,
      key: spaceRow.key,
      role: resolved.spaceRole,
      permissions: resolved.permissions,
    };
  }

  async hasAnyPermission(
    userId: string,
    organizationId: string,
    permissions: string[],
  ): Promise<boolean> {
    const effective = await this.getUserEffectivePermissions(
      userId,
      organizationId,
    );

    return permissions.some((p) =>
      hasPermission(effective.effective_permissions, p),
    );
  }

  async hasAllPermissions(
    userId: string,
    organizationId: string,
    permissions: string[],
  ): Promise<boolean> {
    const effective = await this.getUserEffectivePermissions(
      userId,
      organizationId,
    );

    return permissions.every((p) =>
      hasPermission(effective.effective_permissions, p),
    );
  }

  async isAdminOrOwner(
    userId: string,
    organizationId: string,
  ): Promise<boolean> {
    const { data: membership } = await this.client
      .from('organization_members')
      .select('role')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .single();

    return membership?.role === 'owner' || membership?.role === 'admin';
  }

  /**
   * Resolve the space-level authorisation facts for one user in one space.
   *
   * This is the single source of truth behind `SpacePermissionsGuard`, so that every
   * caller that needs "may this user use module X in space Y" reaches the same verdict
   * the guard already reached when it admitted the request. Pair it with
   * {@link spaceGrantAllows} to decide individual keys — resolve once, decide many.
   *
   * Deliberately does NOT apply `space_permissions` / `space_module_permissions`
   * overrides. Those tables carry `DEFAULT false` columns that were backfilled onto
   * pre-existing rows when new modules shipped, so a `false` there cannot be
   * distinguished from "never configured". {@link getUserSpacePermissions} still
   * applies them for display; authorisation must not, or a module would be denied to
   * the very users the guard just let in.
   *
   * @param {string} userId - `public.users.id` of the caller
   * @param {string} organizationId - The caller's active organization
   * @param {string} spaceId - The space being accessed
   * @returns {Promise<ISpaceBaseGrant>} Admin/membership facts plus explicit and base grants
   */
  async resolveSpaceBaseGrant(
    userId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<ISpaceBaseGrant> {
    const empty = { explicit: {}, basePermissions: {} };

    // Org admins and owners bypass space-level checks entirely.
    if (await this.isAdminOrOwner(userId, organizationId)) {
      return { isAdmin: true, isMember: true, spaceRole: null, ...empty };
    }

    // No member_type filter: production rows predating the column carry NULL, and
    // filtering them out would deny users the guard admits.
    const { data: spaceMember } = await this.client
      .from('space_members')
      .select('space_role, permissions')
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();

    if (!spaceMember) {
      return { isAdmin: false, isMember: false, spaceRole: null, ...empty };
    }

    const row = spaceMember as {
      space_role: string | null;
      permissions: Record<string, boolean> | null;
    };
    const spaceRole = row.space_role ?? null;

    return {
      isAdmin: false,
      isMember: true,
      spaceRole,
      explicit: row.permissions ?? {},
      // Verbatim lookup — an unrecognised role grants nothing rather than being
      // normalised down to `viewer`, which would silently widen access.
      basePermissions:
        (spaceRole ? SPACE_ROLE_BASE_PERMISSIONS[spaceRole] : undefined) ?? {},
    };
  }

  /**
   * Returns the ids of the spaces the user may open (`view_space`), deciding each
   * membership row exactly as {@link resolveSpaceBaseGrant} + {@link spaceGrantAllows} do.
   *
   * @param {string} userId - `public.users.id` of the caller
   * @param {string} organizationId - The caller's active organization
   * @param {string[]} [candidateIds] - Optional space ids to limit the check to
   * @returns {Promise<string[] | null>} Viewable space ids, or `null` when every space is viewable (org owner/admin)
   */
  async getViewableSpaceIds(
    userId: string,
    organizationId: string,
    candidateIds?: string[],
  ): Promise<string[] | null> {
    if (candidateIds && candidateIds.length === 0) return [];

    // "View space" unticked for the user's role hides every space from these lists.
    if (await this.isViewSpaceDenied(userId, organizationId)) return [];

    if (await this.isAdminOrOwner(userId, organizationId)) return null;

    let query = this.client
      .from('space_members')
      .select('space_id, space_role, permissions')
      .eq('user_id', userId)
      .eq('is_active', true);
    if (candidateIds) query = query.in('space_id', candidateIds);

    const { data, error } = await query;
    if (error) {
      // Fail closed, same as the guard when the membership row cannot be read.
      this.logger.warn(`Failed to load viewable spaces: ${error.message}`);
      return [];
    }

    const rows = (data ?? []) as Array<{
      space_id: string;
      space_role: string | null;
      permissions: Record<string, boolean> | null;
    }>;
    const ids = rows
      .filter((row) => {
        const spaceRole = row.space_role ?? null;

        // Grant built exactly like resolveSpaceBaseGrant.
        return spaceGrantAllows(
          {
            isAdmin: false,
            isMember: true,
            spaceRole,
            explicit: row.permissions ?? {},
            basePermissions:
              (spaceRole
                ? SPACE_ROLE_BASE_PERMISSIONS[spaceRole]
                : undefined) ?? {},
          },
          'view_space',
        );
      })
      .map((row) => row.space_id);

    return [...new Set(ids)];
  }

  /**
   * Whether an org-level Space Management permission (ORG_GRANTED_SPACE_PERMISSIONS) grants this space key.
   * Callers must already know the user is a member of the space.
   *
   * @param {string} userId - `public.users.id` of the caller
   * @param {string} organizationId - The caller's active organization
   * @param {string} spacePermission - Flat space key, e.g. `manage_members`
   * @returns {Promise<boolean>} `true` when the mapped org checkbox is ticked for the user's role
   */
  async orgGrantsSpacePermission(
    userId: string,
    organizationId: string,
    spacePermission: string,
  ): Promise<boolean> {
    const orgKey = ORG_GRANTED_SPACE_PERMISSIONS[spacePermission];

    return (
      Boolean(orgKey) && this.checkPermission(userId, organizationId, orgKey)
    );
  }

  /**
   * Org key, or the Space Permissions workflow key for a workflow of a space the user belongs to.
   *
   * @param {string} userId - `public.users.id` of the caller
   * @param {string} organizationId - The caller's active organization
   * @param {string} orgKey - Org-wide key, e.g. `can_edit_workflows`
   * @param {string} spaceKey - Space-scoped org key, e.g. `can_edit_risk_config`
   * @param {() => Promise<string | null> | string | null} resolveSpaceId - Space of the workflow; only read without the org key
   * @returns {Promise<boolean>} `true` when the org key is held, or the space key plus membership of that space
   */
  async hasSpaceWorkflowGrant(
    userId: string,
    organizationId: string,
    orgKey: string,
    spaceKey: string,
    resolveSpaceId: () => Promise<string | null> | string | null,
  ): Promise<boolean> {
    if (await this.checkPermission(userId, organizationId, orgKey)) return true;

    const spaceId = await resolveSpaceId();

    if (
      !spaceId ||
      !(await this.checkPermission(userId, organizationId, spaceKey))
    ) {
      return false;
    }

    const grant = await this.resolveSpaceBaseGrant(
      userId,
      organizationId,
      spaceId,
    );

    return grant.isAdmin || grant.isMember;
  }

  /**
   * Decides one space key exactly as SpacePermissionsGuard does: the space grant first, then the
   * org-level grant for members.
   *
   * @param {string} userId - `public.users.id` of the caller
   * @param {string} organizationId - The caller's active organization
   * @param {string} spaceId - The space being accessed
   * @param {string} spacePermission - Flat space key, e.g. `delete_space`
   * @returns {Promise<boolean>} `true` when the user holds the permission in that space
   */
  async hasSpacePermission(
    userId: string,
    organizationId: string,
    spaceId: string,
    spacePermission: string,
  ): Promise<boolean> {
    const flatPermission = toSpacePermissionKey(spacePermission);

    if (isTestManagementPermission(flatPermission)) {
      const testGrant = await this.resolveTestManagementPermissions(
        userId,
        organizationId,
        spaceId,
      );

      return testGrant.permissions[flatPermission];
    }

    const grant = await this.resolveSpaceBaseGrant(
      userId,
      organizationId,
      spaceId,
    );

    if (spaceGrantAllows(grant, spacePermission)) return true;

    return (
      grant.isMember &&
      this.orgGrantsSpacePermission(userId, organizationId, spacePermission)
    );
  }

  /**
   * Decides the six Test Management keys for one user in one space, with the per-space
   * overrides from Space settings → Permissions. Org admins and owners get every key.
   *
   * Overrides apply in the settings screen's order (base role, group, custom role, user);
   * within one level an explicit false wins. `space_permissions` columns are ignored for
   * these keys. Any read error throws instead of falling back to a grant.
   *
   * @param {string} userId - `public.users.id` of the caller
   * @param {string} organizationId - The caller's active organization
   * @param {string} spaceId - The space being accessed
   * @returns {Promise<ITestManagementGrant>} Membership facts and the six decided keys
   * @throws {InternalServerErrorException} When a permission row cannot be read
   */
  async resolveTestManagementPermissions(
    userId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<ITestManagementGrant> {
    const all = (value: boolean) =>
      Object.fromEntries(
        TEST_MANAGEMENT_PERMISSION_KEYS.map((key) => [key, value]),
      ) as Record<TestManagementPermissionKey, boolean>;
    const denied = {
      isMember: false,
      hasOwnRow: false,
      permissions: all(false),
    };
    const fail = (step: string, error: { message: string }): never => {
      this.logger.error(
        `Test Management permissions, ${step}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Test Management permissions could not be read',
      );
    };

    const { data: space, error: spaceError } = await this.client
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (spaceError) fail('space', spaceError);
    if (!space) return denied;

    if (await this.isAdminOrOwner(userId, organizationId)) {
      return { isMember: true, hasOwnRow: true, permissions: all(true) };
    }

    // No member_type filter, so rows predating the column count, as in the guard.
    const { data: ownRows, error: ownError } = await this.client
      .from('space_members')
      .select('space_role, permissions')
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .eq('is_active', true);

    if (ownError) fail('own membership', ownError);

    const { data: groupLinks, error: groupError } = await this.client
      .from('user_group_members')
      .select(
        'group_id, role_id, group:user_groups(organization_id, is_deleted)',
      )
      .eq('user_id', userId);

    if (groupError) fail('groups', groupError);

    const { data: roleLinks, error: roleError } = await this.client
      .from('user_role_assignments')
      .select('role_id')
      .eq('user_id', userId)
      .eq('organization_id', organizationId);

    if (roleError) fail('custom roles', roleError);

    const groups = (
      (groupLinks ?? []) as unknown as {
        group_id: string | null;
        role_id: string | null;
        group: { organization_id: string; is_deleted: boolean | null } | null;
      }[]
    ).filter(
      (link) =>
        link.group?.organization_id === organizationId &&
        link.group.is_deleted !== true,
    );
    const userGroupIds = new Set(groups.map((link) => link.group_id));
    const userRoleIds = new Set([
      ...groups.map((link) => link.role_id),
      ...((roleLinks ?? []) as { role_id: string | null }[]).map(
        (link) => link.role_id,
      ),
    ]);

    const { data: sharedRows, error: sharedError } = await this.client
      .from('space_members')
      .select('space_role, member_type, group_id, role_id')
      .eq('space_id', spaceId)
      .eq('is_active', true)
      .in('member_type', ['group', 'role']);

    if (sharedError) fail('group and role memberships', sharedError);

    // Only groups and roles that are members of this space count, so stale override rows do not.
    const viaGroup = (
      (sharedRows ?? []) as {
        space_role: string | null;
        member_type: string;
        group_id: string | null;
        role_id: string | null;
      }[]
    ).filter((row) =>
      row.member_type === 'group'
        ? !!row.group_id && userGroupIds.has(row.group_id)
        : !!row.role_id && userRoleIds.has(row.role_id),
    );
    const own = (ownRows ?? []) as {
      space_role: string | null;
      permissions: Record<string, unknown> | null;
    }[];
    const memberships = [...own, ...viaGroup];

    if (memberships.length === 0) return denied;

    const role = memberships.reduce<keyof typeof SPACE_ROLE_BASE_PERMISSIONS>(
      (best, row) => {
        const candidate = normalizeSpaceRole(row.space_role);

        return SPACE_ROLE_RANK[candidate] > SPACE_ROLE_RANK[best]
          ? candidate
          : best;
      },
      'viewer',
    );
    const base = SPACE_ROLE_BASE_PERMISSIONS[role];
    const permissions = all(false);

    for (const key of TEST_MANAGEMENT_PERMISSION_KEYS) {
      permissions[key] =
        base[key] === true ||
        own.some((row) => row.permissions?.[key] === true);
    }

    const { data: overrideRows, error: overrideError } = await this.client
      .from('space_module_permissions')
      .select('target_type, target_id, permissions')
      .eq('space_id', spaceId);

    if (overrideError) fail('overrides', overrideError);

    const groupIds = new Set(viaGroup.map((row) => row.group_id));
    const roleIds = new Set(viaGroup.map((row) => row.role_id));
    const targets: Record<string, (id: string | null) => boolean> = {
      // The owner row is locked on the settings screen, so a stored one never changes owners.
      base_role: (id) => id === role && role !== 'owner',
      group: (id) => !!id && groupIds.has(id),
      role: (id) => !!id && roleIds.has(id),
      user: (id) => id === userId,
    };
    const rows = (overrideRows ?? []) as {
      target_type: string;
      target_id: string | null;
      permissions: Record<string, unknown> | null;
    }[];

    for (const level of ['base_role', 'group', 'role', 'user']) {
      const levelRows = rows.filter(
        (row) => row.target_type === level && targets[level](row.target_id),
      );

      for (const key of TEST_MANAGEMENT_PERMISSION_KEYS) {
        const values = levelRows
          .map((row) => row.permissions?.[`can_${key}`])
          .filter((value): value is boolean => typeof value === 'boolean');

        if (values.length > 0) permissions[key] = !values.includes(false);
      }
    }

    // ponytail: about 7 small reads per decision and no cache; add one if Test Management pages measure slow.
    return {
      isMember: true,
      hasOwnRow: own.length > 0,
      permissions: normalizeSpacePermissions(permissions) as Record<
        TestManagementPermissionKey,
        boolean
      >,
    };
  }

  /**
   * Org key first, then the fully resolved space permissions (role defaults, custom roles, groups,
   * explicit grants and `space_module_permissions`) for a member of the space.
   *
   * @param {string} userId - `public.users.id` of the caller
   * @param {string} organizationId - The caller's active organization
   * @param {string} permission - Org key, e.g. `can_edit_others_comments_tasks`
   * @param {string | null} [spaceId] - Space of the resource; without one only the org key counts
   * @returns {Promise<boolean>} `true` when the org key is held, or the unprefixed key in that space
   */
  async hasOrgOrSpacePermission(
    userId: string,
    organizationId: string,
    permission: string,
    spaceId?: string | null,
  ): Promise<boolean> {
    if (await this.checkPermission(userId, organizationId, permission)) {
      return true;
    }
    if (!spaceId) return false;

    const space = await this.getUserSpacePermissions(
      userId,
      organizationId,
      spaceId,
    );
    const spaceKey = permission.startsWith('can_')
      ? permission.slice(4)
      : permission;

    return space.isMember && space.permissions[spaceKey] === true;
  }

  /**
   * Whether "View space" is explicitly unticked for the user's role in Settings → Access → Space
   * Permissions. Owners are never denied, and a key that was never set does not deny.
   *
   * @param {string} userId - `public.users.id` of the caller
   * @param {string} organizationId - The caller's active organization
   * @returns {Promise<boolean>} `true` when the user may not see spaces
   */
  async isViewSpaceDenied(
    userId: string,
    organizationId: string,
  ): Promise<boolean> {
    const effective = await this.getUserEffectivePermissions(
      userId,
      organizationId,
    );

    return (
      effective.base_role !== 'owner' &&
      effective.effective_permissions.can_view_space === false
    );
  }

  // ── Menu Permissions ───────────────────────────────────────────────────────

  async getMenuPermissions(
    userId: string,
    organizationId: string,
  ): Promise<IMenuPermission[]> {
    const { data: membership } = await this.client
      .from('organization_members')
      .select('role')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .single();
    const baseRole = (membership?.role as string | undefined) || 'viewer';

    const { data: roleAssignments } = await this.client
      .from('user_role_assignments')
      .select('role_id')
      .eq('user_id', userId)
      .eq('organization_id', organizationId);
    const roleIds = ((roleAssignments as Array<{ role_id: string }>) || []).map(
      (a) => a.role_id,
    );

    const { data: groupMemberships } = await this.client
      .from('user_group_members')
      .select('group_id, group:user_groups(organization_id, is_deleted)')
      .eq('user_id', userId);
    const groupIds = (
      (groupMemberships as Array<{ group_id: string }>) || []
    ).map((m) => m.group_id);

    // Same rule as getEffectivePermissions: a deleted or other-org group's rows must not apply
    const staleGroupIds = new Set(
      ((groupMemberships as Record<string, unknown>[]) || [])
        .filter((m) => {
          const group = m['group'] as
            | Record<string, unknown>
            | null
            | undefined;

          return (
            !!group &&
            (group['organization_id'] !== organizationId ||
              group['is_deleted'] === true)
          );
        })
        .map((m) => m['group_id'] as string),
    );
    const liveGroupIds = groupIds.filter((id) => !staleGroupIds.has(id));

    const { data, error } = await this.client
      .from('menu_permissions')
      .select('*')
      .eq('organization_id', organizationId);

    if (error) {
      this.logger.error('Failed to fetch menu permissions:', error);
      throw new BadRequestException('Failed to fetch menu permissions');
    }

    return ((data as IMenuPermission[]) || []).filter((p) => {
      if (p.user_id === userId) return true;
      if (p.base_role === baseRole) return true;
      if (p.role_id && roleIds.includes(p.role_id)) return true;
      if (p.group_id && liveGroupIds.includes(p.group_id)) return true;
      return false;
    });
  }

  async getAllMenuPermissions(
    organizationId: string,
  ): Promise<IMenuPermission[]> {
    const { data, error } = await this.client
      .from('menu_permissions')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error('Failed to fetch all menu permissions:', error);
      throw new BadRequestException('Failed to fetch menu permissions');
    }

    return (data as IMenuPermission[]) || [];
  }

  async saveMenuPermission(
    organizationId: string,
    menuKey: string,
    targetType: string,
    targetId: string | null,
    baseRole: string | null,
    canView: boolean,
    actorUserId?: string,
  ): Promise<IMenuPermission> {
    const record: Record<string, unknown> = {
      organization_id: organizationId,
      menu_key: menuKey,
      target_type: targetType,
      can_view: canView,
    };

    if (targetType === 'user' && targetId) record['user_id'] = targetId;
    else if (targetType === 'role' && targetId) record['role_id'] = targetId;
    else if (targetType === 'group' && targetId) record['group_id'] = targetId;
    else if (targetType === 'base_role' && baseRole)
      record['base_role'] = baseRole;

    // menu_permissions has no composite unique constraint, so we cannot use UPSERT.
    // Delete any existing row for this exact key+target combination first, then insert.
    // This prevents duplicate rows which would cause the admin UI to show stale values.
    let deleteQ = this.client
      .from('menu_permissions')
      .delete()
      .eq('organization_id', organizationId)
      .eq('menu_key', menuKey)
      .eq('target_type', targetType);

    if (targetType === 'user' && targetId)
      deleteQ = deleteQ.eq('user_id', targetId);
    else if (targetType === 'role' && targetId)
      deleteQ = deleteQ.eq('role_id', targetId);
    else if (targetType === 'group' && targetId)
      deleteQ = deleteQ.eq('group_id', targetId);
    else if (targetType === 'base_role' && baseRole)
      deleteQ = deleteQ.eq('base_role', baseRole);

    await deleteQ;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('menu_permissions')
      .insert(record)
      .select()
      .single();

    if (error || !data) {
      this.logger.error('Failed to save menu permission:', error);
      throw new BadRequestException('Failed to save menu permission');
    }

    const saved = data as IMenuPermission;
    void this.logAudit(organizationId, actorUserId, saved.id, 'update', {
      scope: 'menu_permission',
      menu_key: menuKey,
      target_type: targetType,
      target_id: targetId,
      base_role: baseRole,
      can_view: canView,
    });
    return saved;
  }

  async saveMenuPermissions(
    organizationId: string,
    permissions: Array<{
      menuKey: string;
      targetType: string;
      targetId?: string | null;
      baseRole?: string | null;
      canView?: boolean;
    }>,
    actorUserId?: string,
  ): Promise<void> {
    for (const perm of permissions) {
      await this.saveMenuPermission(
        organizationId,
        perm.menuKey,
        perm.targetType,
        perm.targetId ?? null,
        perm.baseRole ?? null,
        perm.canView ?? true,
        actorUserId,
      );
    }
    void this.logAudit(organizationId, actorUserId, organizationId, 'update', {
      scope: 'menu_permissions_bulk',
      count: permissions.length,
    });
  }

  async deleteMenuPermission(
    id: string,
    organizationId?: string,
    actorUserId?: string,
  ): Promise<void> {
    const { error } = await this.client
      .from('menu_permissions')
      .delete()
      .eq('id', id);

    if (error) {
      this.logger.error('Failed to delete menu permission:', error);
      throw new BadRequestException('Failed to delete menu permission');
    }
    if (organizationId) {
      void this.logAudit(organizationId, actorUserId, id, 'delete', {
        scope: 'menu_permission',
      });
    }
  }

  // ── Level Permissions ──────────────────────────────────────────────────────

  async getLevelPermissions(
    userId: string,
    organizationId: string,
    hierarchyLevelId: string | null | undefined,
    entityType: string,
  ): Promise<ILevelPermission[]> {
    const { data: membership } = await this.client
      .from('organization_members')
      .select('role')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .single();
    const baseRole = (membership?.role as string | undefined) || 'viewer';

    const { data: roleAssignments } = await this.client
      .from('user_role_assignments')
      .select('role_id')
      .eq('user_id', userId)
      .eq('organization_id', organizationId);
    const roleIds = ((roleAssignments as Array<{ role_id: string }>) || []).map(
      (a) => a.role_id,
    );

    const { data: groupMemberships } = await this.client
      .from('user_group_members')
      .select('group_id')
      .eq('user_id', userId);
    const groupIds = (
      (groupMemberships as Array<{ group_id: string }>) || []
    ).map((m) => m.group_id);

    const { data, error } = await this.client
      .from('level_permissions')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('hierarchy_level_id', hierarchyLevelId)
      .eq('entity_type', entityType);

    if (error) {
      this.logger.error('Failed to fetch level permissions:', error);
      throw new BadRequestException('Failed to fetch level permissions');
    }

    return ((data as ILevelPermission[]) || []).filter((p) => {
      if (p.user_id === userId) return true;
      if (p.base_role === baseRole) return true;
      if (p.role_id && roleIds.includes(p.role_id)) return true;
      if (p.group_id && groupIds.includes(p.group_id)) return true;
      return false;
    });
  }

  async getAllLevelPermissions(
    organizationId: string,
  ): Promise<ILevelPermission[]> {
    const { data, error } = await this.client
      .from('level_permissions')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error('Failed to fetch all level permissions:', error);
      throw new BadRequestException('Failed to fetch level permissions');
    }

    return (data as ILevelPermission[]) || [];
  }

  async saveLevelPermission(
    organizationId: string,
    hierarchyLevelId: string | null | undefined,
    entityType: string,
    targetType: string,
    targetId: string | null,
    baseRole: string | null,
    permissionFields: Record<string, boolean>,
    actorUserId?: string,
  ): Promise<ILevelPermission> {
    const normalizedLevelId = hierarchyLevelId || 'global';
    const record: Record<string, unknown> = {
      organization_id: organizationId,
      hierarchy_level_id: normalizedLevelId,
      entity_type: entityType,
      target_type: targetType,
      ...permissionFields,
    };

    if (targetType === 'user' && targetId) record['user_id'] = targetId;
    else if (targetType === 'role' && targetId) record['role_id'] = targetId;
    else if (targetType === 'group' && targetId) record['group_id'] = targetId;
    else if (targetType === 'base_role' && baseRole)
      record['base_role'] = baseRole;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('level_permissions')
      .insert(record)
      .select()
      .single();

    if (error || !data) {
      this.logger.error('Failed to save level permission:', error);
      throw new BadRequestException('Failed to save level permission');
    }

    const saved = data as ILevelPermission;
    void this.logAudit(organizationId, actorUserId, saved.id, 'update', {
      scope: 'level_permission',
      hierarchy_level_id: normalizedLevelId,
      entity_type: entityType,
      target_type: targetType,
      target_id: targetId,
      base_role: baseRole,
      permissions: permissionFields,
    });
    return saved;
  }

  async deleteLevelPermission(
    id: string,
    organizationId?: string,
    actorUserId?: string,
  ): Promise<void> {
    const { error } = await this.client
      .from('level_permissions')
      .delete()
      .eq('id', id);

    if (error) {
      this.logger.error('Failed to delete level permission:', error);
      throw new BadRequestException('Failed to delete level permission');
    }
    if (organizationId) {
      void this.logAudit(organizationId, actorUserId, id, 'delete', {
        scope: 'level_permission',
      });
    }
  }

  // ── Space Overrides ────────────────────────────────────────────────────────

  async getSpaceOverrides(organizationId: string): Promise<{
    overrides: Record<string, Record<string, boolean>>;
    groupOverrides: Record<string, Record<string, boolean>>;
  }> {
    const { data: baseRoleData, error: baseRoleError } = await this.client
      .from('base_role_permission_overrides')
      .select('base_role, permissions')
      .eq('organization_id', organizationId);

    if (baseRoleError) {
      this.logger.error('Failed to fetch space overrides:', baseRoleError);
      throw new BadRequestException('Failed to fetch space overrides');
    }

    const overrides: Record<string, Record<string, boolean>> = {};
    for (const row of (baseRoleData as Array<{
      base_role: string;
      permissions: Record<string, boolean>;
    }>) || []) {
      overrides[row.base_role] = row.permissions;
    }

    const { data: groups } = await this.client
      .from('user_groups')
      .select('id, permissions')
      .eq('organization_id', organizationId)
      .eq('is_deleted', false)
      .not('permissions', 'is', null);

    const groupOverrides: Record<string, Record<string, boolean>> = {};
    for (const group of (groups as Array<{
      id: string;
      permissions: Record<string, boolean> | null;
    }>) || []) {
      if (group.permissions) {
        groupOverrides[group.id] = group.permissions;
      }
    }

    return { overrides, groupOverrides };
  }

  async bulkSaveSpaceOverrides(
    organizationId: string,
    permissions: Array<{
      permKey: string;
      targetType: string;
      targetId?: string | null;
      baseRole?: string | null;
      value: boolean;
    }>,
    actorUserId?: string,
  ): Promise<{ roleCount: number; baseRoleCount: number; groupCount: number }> {
    const roleChanges = new Map<string, Record<string, boolean>>();
    const baseRoleChanges = new Map<string, Record<string, boolean>>();
    const groupChanges = new Map<string, Record<string, boolean>>();

    for (const perm of permissions) {
      if (!isAllowedPermissionOverrideKey(perm.permKey)) continue;

      if (perm.targetType === 'role' && perm.targetId) {
        const existing = roleChanges.get(perm.targetId) ?? {};
        existing[perm.permKey] = perm.value;
        roleChanges.set(perm.targetId, existing);
      } else if (
        perm.targetType === 'base_role' &&
        perm.baseRole &&
        VALID_BASE_ROLES.includes(perm.baseRole)
      ) {
        const existing = baseRoleChanges.get(perm.baseRole) ?? {};
        existing[perm.permKey] = perm.value;
        baseRoleChanges.set(perm.baseRole, existing);
      } else if (perm.targetType === 'group' && perm.targetId) {
        const existing = groupChanges.get(perm.targetId) ?? {};
        existing[perm.permKey] = perm.value;
        groupChanges.set(perm.targetId, existing);
      }
    }

    for (const [roleId, changes] of roleChanges) {
      const { data: role } = await this.client
        .from('custom_roles')
        .select('permissions')
        .eq('id', roleId)
        .eq('organization_id', organizationId)
        .single();

      if (!role) continue;

      const updatedPerms = {
        ...((role as { permissions: Record<string, boolean> }).permissions ??
          {}),
        ...changes,
      };
      const { error } = await this.client
        .from('custom_roles')
        .update({ permissions: updatedPerms })
        .eq('id', roleId);

      if (error) this.logger.error(`Failed to update role ${roleId}:`, error);
    }

    for (const [br, changes] of baseRoleChanges) {
      const { data: existing } = await this.client
        .from('base_role_permission_overrides')
        .select('permissions')
        .eq('organization_id', organizationId)
        .eq('base_role', br)
        .maybeSingle();

      const mergedPerms = {
        ...((existing as { permissions: Record<string, boolean> } | null)
          ?.permissions ?? {}),
        ...changes,
      };
      const { error } = await this.client
        .from('base_role_permission_overrides')
        .upsert(
          {
            organization_id: organizationId,
            base_role: br,
            permissions: mergedPerms,
          },
          { onConflict: 'organization_id,base_role' },
        );

      if (error) this.logger.error(`Failed to update base role ${br}:`, error);
    }

    for (const [groupId, changes] of groupChanges) {
      const { data: group } = await this.client
        .from('user_groups')
        .select('permissions')
        .eq('id', groupId)
        .eq('organization_id', organizationId)
        .single();

      if (!group) continue;

      const mergedPerms = {
        ...((group as { permissions: Record<string, boolean> | null })
          .permissions ?? {}),
        ...changes,
      };
      const { error } = await this.client
        .from('user_groups')
        .update({ permissions: mergedPerms })
        .eq('id', groupId);

      if (error) this.logger.error(`Failed to update group ${groupId}:`, error);
    }

    const counts = {
      roleCount: roleChanges.size,
      baseRoleCount: baseRoleChanges.size,
      groupCount: groupChanges.size,
    };

    // This rewrites custom-role, base-role and group permission sets, so it can
    // change the effective permissions of any member of this org — and we can't
    // cheaply enumerate which. Drop the whole org's cache rather than guess.
    // Without this, an admin revoking a permission here would watch it appear to
    // have no effect for up to CACHE_TTL_MS.
    this.bustOrg(organizationId);

    void this.logAudit(organizationId, actorUserId, organizationId, 'update', {
      scope: 'space_permission_overrides',
      requested_count: permissions.length,
      ...counts,
    });
    return counts;
  }

  async assertCanManageSpacePermissions(
    userId: string,
    organizationId: string,
  ): Promise<void> {
    const isAdmin = await this.isAdminOrOwner(userId, organizationId);
    if (!isAdmin) {
      const effective = await this.getUserEffectivePermissions(
        userId,
        organizationId,
      );
      if (!effective.effective_permissions.can_manage_space_permissions) {
        throw new ForbiddenException('Permission denied');
      }
    }
  }

  /**
   * Read side of the Space Permissions matrix: admin/owner, or "View space permissions"
   * (or "Manage", which implies it) for the user's role.
   *
   * @param {string} userId - `public.users.id` of the caller
   * @param {string} organizationId - The caller's active organization
   * @throws {ForbiddenException} When the user may not view the matrix
   */
  async assertCanViewSpacePermissions(
    userId: string,
    organizationId: string,
  ): Promise<void> {
    if (await this.isAdminOrOwner(userId, organizationId)) return;

    const effective = await this.getUserEffectivePermissions(
      userId,
      organizationId,
    );

    if (
      !effective.effective_permissions.can_view_space_permissions &&
      !effective.effective_permissions.can_manage_space_permissions
    ) {
      throw new ForbiddenException('Permission denied');
    }
  }

  private async logAudit(
    organizationId: string,
    actorUserId: string | undefined,
    entityId: string,
    action: 'update' | 'delete',
    changes: Record<string, unknown>,
  ): Promise<void> {
    if (!actorUserId) return;

    try {
      await this.client.from('audit_logs').insert({
        organization_id: organizationId,
        user_id: actorUserId,
        entity_type: 'permission',
        entity_id: entityId,
        action,
        changes,
      });
    } catch {
      // Audit is best-effort and must not break permission mutations.
    }
  }
}
