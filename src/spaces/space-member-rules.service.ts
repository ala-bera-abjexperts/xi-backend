/**
 * @fileoverview Who may change whom in a space. One set of rules for the human member routes and for
 * Robert: nobody gives more than they have, and nobody touches someone above them. Called at the
 * route, not in SpacesService.addSpaceMember, because invitations and imports add members on
 * behalf of a decision made earlier and must keep working.
 * @module src/spaces/space-member-rules.service
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PermissionsService } from '../permissions/permissions.service';
import { SPACE_PERMISSION_COLUMN_KEYS } from '../permissions/models/space-permissions.model';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

/** Lowest first. Org owners and admins count as owners. */
export const SPACE_ROLES = ['viewer', 'member', 'admin', 'owner'] as const;
export type SpaceRoleName = (typeof SPACE_ROLES)[number];

export function roleRank(role: string | null | undefined): number {
  if (role === 'space_admin') return SPACE_ROLES.indexOf('admin');
  return SPACE_ROLES.indexOf((role ?? '') as SpaceRoleName);
}

const ORG_POWER = new Set(['owner', 'admin']);
const OWNER_RANK = roleRank('owner');
const ADMIN_RANK = roleRank('admin');
const MEMBER_RANK = roleRank('member');

export const flatPermissionKey = (key: string) => (key.startsWith('can_') ? key.slice(4) : key);

export interface SpaceActor {
  userId: string;
  organizationId: string;
}

export type SpaceMemberChangeKind =
  | 'space_member_add'
  | 'space_member_role'
  | 'space_member_permissions'
  | 'space_member_remove';

export interface SpaceMemberChange {
  kind: SpaceMemberChangeKind;
  spaceId: string;
  userId: string;
  role?: string | null;
  grant?: string[];
  revoke?: string[];
}

/** What the human routes answer for a refusal. */
function refuse(code: string): Error {
  switch (code) {
    case 'role_above_yours':
      return new ForbiddenException({ code, message: "You can't give a role above your own." });
    case 'target_above_you':
      return new ForbiddenException({ code, message: 'This person ranks above you in this space.' });
    case 'permission_not_yours':
      return new ForbiddenException({ code, message: "You can't give a permission you don't hold." });
    case 'last_owner':
      return new ConflictException({ code, message: 'A space must keep an owner. Make someone else the owner first.' });
    case 'unknown_role':
      return new BadRequestException({ code, message: 'That is not a space role.' });
    case 'inactive_user':
      return new BadRequestException({ code, message: 'This person is deactivated.' });
    default:
      return new NotFoundException('Member not found');
  }
}

@Injectable()
export class SpaceMemberRulesService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Org role and space role of one person; the higher one is their rank. */
  async standing(
    organizationId: string,
    spaceId: string,
    userId: string,
  ): Promise<{ rank: number; orgPower: boolean; active: boolean; role: string | null }> {
    const [org, member] = await Promise.all([
      this.client
        .from('organization_members')
        .select('role')
        .eq('organization_id', organizationId)
        .eq('user_id', userId)
        .maybeSingle(),
      // A group or a role grant shows up here too, as the derived row of the person.
      this.client
        .from('space_members')
        .select('space_role, is_active')
        .eq('space_id', spaceId)
        .eq('user_id', userId)
        .maybeSingle(),
    ]);
    if (org.error || member.error) throw new Error('Could not load the member');
    const orgPower = ORG_POWER.has((org.data as { role?: string } | null)?.role ?? '');
    const row = member.data as { space_role: string | null; is_active: boolean } | null;
    const active = !!row?.is_active;
    return {
      orgPower,
      active,
      role: row?.space_role ?? null,
      rank: orgPower ? OWNER_RANK : active ? roleRank(row?.space_role) : -1,
    };
  }

  /**
   * The rank a person acts with. Holding the permission through an org-level key is not owning the
   * space, so it counts as admin; holding it at all as at least member.
   */
  private async actingRank(actor: SpaceActor, spaceId: string, permission: string): Promise<number> {
    const me = await this.standing(actor.organizationId, spaceId, actor.userId);
    if (me.orgPower) return me.rank;
    const byOrg = await this.permissions.orgGrantsSpacePermission(actor.userId, actor.organizationId, permission);
    return Math.max(me.rank, byOrg ? ADMIN_RANK : MEMBER_RANK);
  }

  /**
   * Why this person may not make this change, or null. A person never gives more than they have:
   * no role above their own, no permission they do not hold, nothing on someone above them.
   */
  async problem(actor: SpaceActor, change: SpaceMemberChange): Promise<string | null> {
    const { organizationId } = actor;
    const { spaceId, userId, kind } = change;
    if (!(await this.permissions.hasSpacePermission(actor.userId, organizationId, spaceId, 'manage_members')))
      return 'no_manage_permission';

    const [rank, target] = await Promise.all([
      this.actingRank(actor, spaceId, 'manage_members'),
      this.standing(organizationId, spaceId, userId),
    ]);

    if (kind !== 'space_member_add' && target.rank > rank) return 'target_above_you';
    if (change.role && roleRank(change.role) > rank) return 'role_above_yours';
    if (kind === 'space_member_add') {
      if (target.active && change.role && target.role !== change.role) return 'already_member';
    } else if (!target.active && kind !== 'space_member_remove') {
      return 'not_member';
    }

    // Said on the card already; the locked write decides for good when two Confirms race.
    if (
      kind === 'space_member_remove' ||
      (kind === 'space_member_role' && roleRank(change.role) < roleRank(target.role))
    ) {
      if (target.active && (await this.isLastInCharge(organizationId, spaceId, userId, target.role)))
        return 'last_owner';
    }

    for (const key of [...(change.grant ?? []), ...(change.revoke ?? [])].map(flatPermissionKey)) {
      if (!SPACE_PERMISSION_COLUMN_KEYS.has(key)) return 'unknown_permission';
      if (!(await this.permissions.hasSpacePermission(actor.userId, organizationId, spaceId, key)))
        return 'permission_not_yours';
    }
    return null;
  }

  /** The same rule as agent_space_member_write: an owner needs another owner, an admin another of both. */
  async isLastInCharge(
    organizationId: string,
    spaceId: string,
    userId: string,
    role: string | null,
  ): Promise<boolean> {
    if (role !== 'owner' && role !== 'admin') return false;
    const { data, error } = await this.client
      .from('space_members')
      .select('user_id, space_role')
      .eq('space_id', spaceId)
      .not('user_id', 'is', null)
      .eq('is_active', true);
    if (error) throw new Error(error.message);
    const others = ((data ?? []) as { user_id: string; space_role: string }[]).filter((r) => r.user_id !== userId);
    if (!others.length) return true;
    const ids = others.map((r) => r.user_id);
    const [inOrg, gone] = await Promise.all([
      this.client.from('organization_members').select('user_id').eq('organization_id', organizationId).in('user_id', ids),
      this.client.from('users').select('id').eq('is_active', false).in('id', ids),
    ]);
    if (inOrg.error || gone.error) throw new Error('Could not load the members');
    const left = new Set(((gone.data ?? []) as { id: string }[]).map((r) => r.id));
    const stay = new Set(
      ((inOrg.data ?? []) as { user_id: string }[]).map((r) => r.user_id).filter((id) => !left.has(id)),
    );
    return !others.some(
      (r) => stay.has(r.user_id) && (r.space_role === 'owner' || (role === 'admin' && r.space_role === 'admin')),
    );
  }

  // ---------------------------------------------------------------------------
  // The human routes
  // ---------------------------------------------------------------------------

  /** The guard lets an org admin through before the space is read: the space must be theirs. */
  async assertSpaceInOrg(organizationId: string, spaceId: string): Promise<void> {
    const { data, error } = await this.client
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error || !data) throw new NotFoundException('Space not found');
  }

  private assertRole(role: string | null | undefined): void {
    if (role !== undefined && role !== null && roleRank(role) < 0) throw refuse('unknown_role');
  }

  /** Every permission switched on, held by the person giving it. */
  private async assertHolds(actor: SpaceActor, spaceId: string, keys: string[], rank: number): Promise<void> {
    if (rank >= OWNER_RANK) return;
    for (const key of keys.map(flatPermissionKey)) {
      if (!(await this.permissions.hasSpacePermission(actor.userId, actor.organizationId, spaceId, key)))
        throw refuse('permission_not_yours');
    }
  }

  private switchedOn(permissions: unknown): string[] {
    return Object.entries((permissions ?? {}) as Record<string, unknown>)
      .filter(([, value]) => value === true)
      .map(([key]) => key);
  }

  private async customRolePermissions(organizationId: string, roleId: string): Promise<string[]> {
    const { data } = await this.client
      .from('custom_roles')
      .select('permissions')
      .eq('id', roleId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Role not found');
    return this.switchedOn((data as { permissions?: unknown }).permissions);
  }

  private async assertTarget(
    organizationId: string,
    dto: { member_type?: string; user_id?: string | null; group_id?: string | null; role_id?: string | null },
  ): Promise<void> {
    if (dto.member_type === 'group') {
      const { data } = await this.client
        .from('user_groups')
        .select('id')
        .eq('id', dto.group_id ?? '')
        .eq('organization_id', organizationId)
        .maybeSingle();
      if (!data) throw new NotFoundException('Group not found');
      return;
    }
    if (dto.member_type === 'role') return; // Checked with its permissions.
    const [member, account] = await Promise.all([
      this.client
        .from('organization_members')
        .select('user_id')
        .eq('organization_id', organizationId)
        .eq('user_id', dto.user_id ?? '')
        .maybeSingle(),
      this.client.from('users').select('is_active').eq('id', dto.user_id ?? '').maybeSingle(),
    ]);
    if (!member.data) throw new NotFoundException('User not found');
    if ((account.data as { is_active?: boolean | null } | null)?.is_active === false) throw refuse('inactive_user');
  }

  async assertCanAdd(
    actor: SpaceActor,
    spaceId: string,
    dto: {
      member_type?: string;
      user_id?: string | null;
      group_id?: string | null;
      role_id?: string | null;
      space_role?: string | null;
      permissions?: unknown;
    },
  ): Promise<void> {
    await this.assertSpaceInOrg(actor.organizationId, spaceId);
    this.assertRole(dto.space_role);
    await this.assertTarget(actor.organizationId, dto);
    const rank = await this.actingRank(actor, spaceId, 'manage_members');
    if (roleRank(dto.space_role ?? 'member') > rank) throw refuse('role_above_yours');
    await this.assertHolds(actor, spaceId, this.switchedOn(dto.permissions), rank);
    if (dto.member_type === 'role')
      await this.assertHolds(actor, spaceId, await this.customRolePermissions(actor.organizationId, dto.role_id ?? ''), rank);
  }

  private async memberRow(spaceId: string, memberId: string) {
    const { data } = await this.client
      .from('space_members')
      .select('id, user_id, space_role')
      .eq('id', memberId)
      .eq('space_id', spaceId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Member not found');
    return data as { id: string; user_id: string | null; space_role: string | null };
  }

  /** Someone above the person acting stays out of reach. A group or role row has its stored role. */
  private async assertNotAbove(actor: SpaceActor, spaceId: string, row: { user_id: string | null; space_role: string | null }, rank: number) {
    const target = row.user_id
      ? (await this.standing(actor.organizationId, spaceId, row.user_id)).rank
      : roleRank(row.space_role);
    if (target > rank) throw refuse('target_above_you');
  }

  async assertCanChangeRole(actor: SpaceActor, spaceId: string, memberId: string, role: string | null | undefined): Promise<void> {
    await this.assertSpaceInOrg(actor.organizationId, spaceId);
    this.assertRole(role);
    const row = await this.memberRow(spaceId, memberId);
    const rank = await this.actingRank(actor, spaceId, 'manage_members');
    await this.assertNotAbove(actor, spaceId, row, rank);
    if (roleRank(role) > rank) throw refuse('role_above_yours');
  }

  async assertCanRemove(actor: SpaceActor, spaceId: string, memberId: string): Promise<void> {
    await this.assertSpaceInOrg(actor.organizationId, spaceId);
    const row = await this.memberRow(spaceId, memberId);
    await this.assertNotAbove(actor, spaceId, row, await this.actingRank(actor, spaceId, 'manage_members'));
  }

  async assertCanInvite(
    actor: SpaceActor,
    spaceId: string,
    users: { space_role?: string | null; custom_role_id?: string | null; permissions?: unknown }[],
  ): Promise<void> {
    await this.assertSpaceInOrg(actor.organizationId, spaceId);
    const rank = await this.actingRank(actor, spaceId, 'invite_members');
    for (const user of users) {
      this.assertRole(user.space_role);
      if (roleRank(user.space_role ?? 'member') > rank) throw refuse('role_above_yours');
      await this.assertHolds(actor, spaceId, this.switchedOn(user.permissions), rank);
      if (user.custom_role_id)
        await this.assertHolds(actor, spaceId, await this.customRolePermissions(actor.organizationId, user.custom_role_id), rank);
    }
  }
}

/**
 * The spaces where this person is the only owner, before they leave the organization. Automatic
 * removals are never blocked by this: org owners and admins still manage those spaces, and the
 * caller records it so someone can look. Best effort: an audit note must not stop a removal.
 */
export async function spacesOnlyOwnedBy(
  client: ReturnType<SupabaseAdminService['getClient']>,
  organizationId: string,
  userId: string,
): Promise<string[]> {
  try {
    const { data: mine } = await client
      .from('space_members')
      .select('space_id, spaces!inner(organization_id)')
      .eq('user_id', userId)
      .eq('space_role', 'owner')
      .eq('is_active', true)
      .eq('spaces.organization_id', organizationId);
    const ids = ((mine ?? []) as { space_id: string }[]).map((r) => r.space_id);
    if (!ids.length) return [];
    const { data: others } = await client
      .from('space_members')
      .select('space_id')
      .in('space_id', ids)
      .eq('space_role', 'owner')
      .eq('is_active', true)
      .neq('user_id', userId);
    const covered = new Set(((others ?? []) as { space_id: string }[]).map((r) => r.space_id));
    return ids.filter((id) => !covered.has(id));
  } catch {
    return [];
  }
}
