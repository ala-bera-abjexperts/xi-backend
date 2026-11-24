import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { EligibleTester } from '../dto/test-plan.dto';
import { tmDbError } from '../test-management-errors';

const TESTER_PERMISSION = 'execute_tests';

// Keeps each .in() URL well under the 8 KB the stack accepts.
const ID_CHUNK = 100;

export interface UserNameRow {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

/** Full name, or the email when no name is set. */
export function userDisplayName(user: UserNameRow): string {
  const name = [user.first_name, user.last_name]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' ')
    .trim();

  return name || user.email || '';
}

export function chunk<T>(items: T[], size = ID_CHUNK): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

interface UserRow extends UserNameRow {
  id: string;
  avatar_url: string | null;
  is_active: boolean | null;
}

interface SpaceMemberRow {
  user_id: string;
  space_role: string | null;
  permissions: Record<string, boolean> | null;
}

/**
 * Who may be named as a tester in a space: an active user, a member of the organization, holding
 * execute_tests there. Decided in batches the same way SpacePermissionsGuard decides one user.
 */
@Injectable()
export class TesterEligibilityService {
  private readonly logger = new Logger(TesterEligibilityService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async eligibleUserIds(
    organizationId: string,
    spaceId: string,
  ): Promise<Set<string>> {
    return new Set(
      (await this.eligibleUsers(organizationId, spaceId)).map((u) => u.id),
    );
  }

  async listEligible(
    organizationId: string,
    spaceId: string,
  ): Promise<EligibleTester[]> {
    return (await this.eligibleUsers(organizationId, spaceId))
      .map((user) => ({
        id: user.id,
        name: userDisplayName(user),
        email: user.email ?? '',
        avatar_url: user.avatar_url,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** One generic answer for every reason, so membership cannot be probed. */
  async assertEligible(
    organizationId: string,
    spaceId: string,
    userId: string,
  ): Promise<void> {
    if (!(await this.eligibleUserIds(organizationId, spaceId)).has(userId)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'The user cannot be assigned',
      });
    }
  }

  private async eligibleUsers(
    organizationId: string,
    spaceId: string,
  ): Promise<UserRow[]> {
    const [admins, members, implicitIds] = await Promise.all([
      this.orgAdminIds(organizationId),
      this.spaceMembers(spaceId),
      this.implicitMemberIds(spaceId),
    ]);

    // Org owners and admins pass every space check.
    const granted = new Set(admins);

    // Same per-space decision as the run routes.
    for (const row of members) {
      if (granted.has(row.user_id)) continue;

      const allowed = await this.permissions.hasSpacePermission(
        row.user_id,
        organizationId,
        spaceId,
        TESTER_PERMISSION,
      );

      if (allowed) granted.add(row.user_id);
    }

    // Group and role members without their own row are few; ask the guard's own check for each.
    const decided = new Set([...admins, ...members.map((m) => m.user_id)]);

    for (const userId of implicitIds) {
      if (decided.has(userId)) continue;

      const grant = await this.permissions.resolveTestManagementPermissions(
        userId,
        organizationId,
        spaceId,
      );

      // Without an own member row the run screen cannot be opened, so they are not offered.
      if (grant.hasOwnRow && grant.permissions[TESTER_PERMISSION]) {
        granted.add(userId);
      }
    }

    const adminSet = new Set(admins);
    const orgMembers = new Set(
      await this.orgMemberIds(
        organizationId,
        [...granted].filter((id) => !adminSet.has(id)),
      ),
    );

    const users = await this.users(
      [...granted].filter((id) => adminSet.has(id) || orgMembers.has(id)),
    );

    return users.filter((user) => user.is_active !== false);
  }

  private async orgAdminIds(organizationId: string): Promise<string[]> {
    const { data, error } = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', organizationId)
      .in('role', ['owner', 'admin']);

    if (error) throw tmDbError(this.logger, 'load organization admins', error);

    return ((data ?? []) as { user_id: string | null }[])
      .map((row) => row.user_id)
      .filter((id): id is string => Boolean(id));
  }

  /** No member_type filter, like the guard: rows predating the column carry NULL. */
  private async spaceMembers(spaceId: string): Promise<SpaceMemberRow[]> {
    const { data, error } = await this.client
      .from('space_members')
      .select('user_id, space_role, permissions')
      .eq('space_id', spaceId)
      .eq('is_active', true)
      .not('user_id', 'is', null);

    if (error) throw tmDbError(this.logger, 'load space members', error);

    return (data ?? []) as SpaceMemberRow[];
  }

  /** Users reaching the space through a group or role, as GET /spaces/:id/members/implicit lists them. */
  private async implicitMemberIds(spaceId: string): Promise<string[]> {
    const { data, error } = await this.client
      .from('space_members')
      .select('group_id, role_id')
      .eq('space_id', spaceId)
      .eq('is_active', true)
      .in('member_type', ['group', 'role']);

    if (error) throw tmDbError(this.logger, 'load implicit members', error);

    const rows = (data ?? []) as {
      group_id: string | null;
      role_id: string | null;
    }[];
    const groupIds = rows
      .map((row) => row.group_id)
      .filter((id): id is string => Boolean(id));
    const roleIds = rows
      .map((row) => row.role_id)
      .filter((id): id is string => Boolean(id));

    const lookups: { table: string; column: string; ids: string[] }[] = [
      { table: 'user_group_members', column: 'group_id', ids: groupIds },
      { table: 'user_role_assignments', column: 'role_id', ids: roleIds },
    ];
    const userIds = new Set<string>();

    for (const { table, column, ids } of lookups) {
      for (const part of chunk(ids)) {
        const result = await this.client
          .from(table)
          .select('user_id')
          .in(column, part);

        if (result.error) {
          throw tmDbError(this.logger, 'load implicit members', result.error);
        }

        for (const row of (result.data ?? []) as {
          user_id: string | null;
        }[]) {
          if (row.user_id) userIds.add(row.user_id);
        }
      }
    }

    return [...userIds];
  }

  private async orgMemberIds(
    organizationId: string,
    userIds: string[],
  ): Promise<string[]> {
    const ids: string[] = [];

    for (const part of chunk(userIds)) {
      const { data, error } = await this.client
        .from('organization_members')
        .select('user_id')
        .eq('organization_id', organizationId)
        .in('user_id', part);

      if (error) {
        throw tmDbError(this.logger, 'load organization members', error);
      }

      ids.push(
        ...((data ?? []) as { user_id: string }[]).map((r) => r.user_id),
      );
    }

    return ids;
  }

  private async users(userIds: string[]): Promise<UserRow[]> {
    const rows: UserRow[] = [];

    for (const part of chunk(userIds)) {
      const { data, error } = await this.client
        .from('users')
        .select('id, first_name, last_name, email, avatar_url, is_active')
        .in('id', part);

      if (error) throw tmDbError(this.logger, 'load users', error);

      rows.push(...((data ?? []) as UserRow[]));
    }

    return rows;
  }
}
