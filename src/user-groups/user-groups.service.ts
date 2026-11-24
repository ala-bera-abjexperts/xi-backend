/**
 * @fileoverview Service for user groups and group members CRUD.
 * Mirrors risk-management-app UserGroupService exactly.
 * @module src/user-groups/user-groups.service
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { CreateUserGroupDto } from './dto/create-user-group.dto';
import type { UpdateUserGroupDto } from './dto/update-user-group.dto';

const GROUPS_TABLE = 'user_groups';
const MEMBERS_TABLE = 'user_group_members';

const MEMBER_JOIN = `
  *,
  user:users!user_group_members_user_id_fkey(
    id,
    email,
    first_name,
    last_name,
    avatar_url
  ),
  role:custom_roles(
    id,
    organization_id,
    name,
    description,
    color,
    icon,
    base_role,
    permissions,
    is_system,
    is_active,
    is_deleted,
    deleted_at,
    deleted_by,
    created_at,
    updated_at
  )
`;

@Injectable()
export class UserGroupsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    // Group membership and group permissions both feed effective permissions,
    // so every mutation here must evict PermissionsService's cache — otherwise
    // an admin's change silently no-ops until the TTL expires.
    // UserGroupsModule already imports PermissionsModule; no cycle.
    private readonly permissionsService: PermissionsService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ── List ────────────────────────────────────────────────────────────────

  async getAll(
    organizationId: string,
    filter?: { is_deleted?: boolean; search?: string },
  ): Promise<{ data: Record<string, unknown>[]; count: number }> {
    let query = this.client
      .from(GROUPS_TABLE)
      .select(`*, member_count:user_group_members(count)`, { count: 'exact' })
      .eq('organization_id', organizationId);

    const isDeleted = filter?.is_deleted ?? false;
    query = query.eq('is_deleted', isDeleted);

    if (filter?.search) {
      const safe = filter.search.replace(/[,.()"'\\]/g, '');
      if (safe.length > 0) {
        query = query.or(`name.ilike.%${safe}%,description.ilike.%${safe}%`);
      }
    }

    const { data, error, count } = await query.order('name', {
      ascending: true,
    });

    if (error) throw new BadRequestException(error.message);

    // Flatten member_count from [{count: N}] to number
    const rows = (data ?? []).map((g: Record<string, unknown>) => ({
      ...g,
      member_count: Array.isArray(g['member_count'])
        ? ((g['member_count'] as { count: number }[])[0]?.count ?? 0)
        : 0,
    }));

    return { data: rows, count: count ?? rows.length };
  }

  // ── Get by ID ────────────────────────────────────────────────────────────

  async getById(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(GROUPS_TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Group not found');
    return data as Record<string, unknown>;
  }

  async getByIdWithMembers(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(GROUPS_TABLE)
      .select(
        `*, default_role:custom_roles(*), members:user_group_members(${MEMBER_JOIN})`,
      )
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Group not found');

    const row = data as Record<string, unknown>;
    const members = Array.isArray(row['members']) ? row['members'] : [];
    return { ...row, member_count: (members as unknown[]).length };
  }

  // ── Create ───────────────────────────────────────────────────────────────

  async create(
    organizationId: string,
    dto: CreateUserGroupDto,
    actorUserId?: string | null,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.assertNameAvailable(dto.name, organizationId);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(GROUPS_TABLE)
      .insert({
        organization_id: organizationId,
        name: dto.name,
        description: dto.description ?? null,
        color: dto.color ?? '#6B7280',
        default_role_id: dto.default_role_id ?? null,
      })
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(error?.message ?? 'Failed to create group');
    }

    const group = data as Record<string, unknown>;
    this.logAudit(
      organizationId,
      actorUserId,
      group['id'] as string,
      'create',
      {
        name: group['name'],
      },
    );
    return { data: group, success: true };
  }

  // ── Update ───────────────────────────────────────────────────────────────

  async update(
    id: string,
    organizationId: string,
    dto: UpdateUserGroupDto,
    actorUserId?: string | null,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    if (
      dto.name === undefined &&
      dto.description === undefined &&
      dto.color === undefined &&
      dto.default_role_id === undefined
    ) {
      throw new BadRequestException(
        'At least one field must be provided for update',
      );
    }

    const existing = await this.getById(id, organizationId);

    if (dto.name && dto.name !== existing['name']) {
      await this.assertNameAvailable(dto.name, organizationId, id);
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.description !== undefined) patch['description'] = dto.description;
    if (dto.color !== undefined) patch['color'] = dto.color;
    if (dto.default_role_id !== undefined)
      patch['default_role_id'] = dto.default_role_id;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(GROUPS_TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(error?.message ?? 'Failed to update group');
    }

    const group = data as Record<string, unknown>;
    this.logAudit(organizationId, actorUserId, id, 'update', patch);
    // Group or membership changed — drop cached effective permissions for the org.
    this.permissionsService.bustOrg(organizationId);

    return { data: group, success: true };
  }

  // ── Soft Delete ──────────────────────────────────────────────────────────

  async delete(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    await this.getById(id, organizationId);

    const { error } = await this.client
      .from(GROUPS_TABLE)
      .update({
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        deleted_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
    // Group or membership changed — drop cached effective permissions for the org.
    this.permissionsService.bustOrg(organizationId);

    return { success: true, message: 'Group deleted successfully' };
  }

  // ── Restore ──────────────────────────────────────────────────────────────

  async restore(
    id: string,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<{
    data: Record<string, unknown>;
    success: true;
    message: string;
  }> {
    const existing = await this.getById(id, organizationId);

    if (!existing['is_deleted']) {
      throw new BadRequestException('Group is not deleted');
    }

    await this.assertNameAvailable(
      existing['name'] as string,
      organizationId,
      id,
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(GROUPS_TABLE)
      .update({
        is_deleted: false,
        deleted_at: null,
        deleted_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to restore group',
      );
    }

    this.logAudit(organizationId, actorUserId, id, 'restore', {
      name: (data as Record<string, unknown>)['name'],
    });

    // Group or membership changed — drop cached effective permissions for the org.
    this.permissionsService.bustOrg(organizationId);

    return {
      data: data as Record<string, unknown>,
      success: true,
      message: 'Group restored successfully',
    };
  }

  // ── Permanent Delete ─────────────────────────────────────────────────────

  async permanentDelete(
    id: string,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<{ success: true; message: string }> {
    const existing = await this.getById(id, organizationId);

    if (!existing['is_deleted']) {
      throw new BadRequestException(
        'Group must be soft-deleted before permanent deletion',
      );
    }

    // Delete members first (in case no FK cascade)
    await this.client.from(MEMBERS_TABLE).delete().eq('group_id', id);

    const { error } = await this.client
      .from(GROUPS_TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
    this.logAudit(organizationId, actorUserId, id, 'delete', {
      permanent: true,
      name: existing['name'],
    });
    // Group or membership changed — drop cached effective permissions for the org.
    this.permissionsService.bustOrg(organizationId);

    return { success: true, message: 'Group permanently deleted' };
  }

  // ── Duplicate ────────────────────────────────────────────────────────────

  async duplicate(
    id: string,
    organizationId: string,
    newName: string,
    copyMembers: boolean,
    actorUserId?: string | null,
  ): Promise<{
    data: Record<string, unknown>;
    success: true;
    message: string;
  }> {
    const source = await this.getById(id, organizationId);
    await this.assertNameAvailable(newName, organizationId);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: created, error } = await this.client
      .from(GROUPS_TABLE)
      .insert({
        organization_id: organizationId,
        name: newName,
        description: source['description'] ?? null,
        color: source['color'] ?? '#6B7280',
        default_role_id: source['default_role_id'] ?? null,
      })
      .select()
      .single();

    if (error || !created) {
      throw new BadRequestException(
        error?.message ?? 'Failed to duplicate group',
      );
    }

    if (copyMembers) {
      const { data: members } = await this.client
        .from(MEMBERS_TABLE)
        .select('user_id, role_id')
        .eq('group_id', id);

      if (members && members.length > 0) {
        const rows = (
          members as { user_id: string; role_id: string | null }[]
        ).map((m) => ({
          group_id: (created as Record<string, unknown>)['id'] as string,
          user_id: m.user_id,
          role_id: m.role_id ?? null,
        }));
        await this.client.from(MEMBERS_TABLE).insert(rows);
      }
    }

    this.logAudit(
      organizationId,
      actorUserId,
      (created as Record<string, unknown>)['id'] as string,
      'create',
      {
        duplicated_from: id,
        copy_members: copyMembers,
      },
    );

    return {
      data: created as Record<string, unknown>,
      success: true,
      message: 'Group duplicated successfully',
    };
  }

  // ── Members ──────────────────────────────────────────────────────────────

  async getMembers(
    groupId: string,
    organizationId: string,
  ): Promise<{
    data: Record<string, unknown>[];
    count: number;
    success: true;
  }> {
    await this.getById(groupId, organizationId);

    const { data, error } = await this.client
      .from(MEMBERS_TABLE)
      .select(MEMBER_JOIN)
      .eq('group_id', groupId)
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    return { data: rows, count: rows.length, success: true };
  }

  async addMember(
    groupId: string,
    organizationId: string,
    userId: string,
    roleId?: string | null,
    actorUserId?: string | null,
  ): Promise<{
    data: Record<string, unknown>;
    success: true;
    message: string;
  }> {
    const group = await this.getById(groupId, organizationId);
    if (group['is_deleted']) {
      throw new BadRequestException('Cannot add members to a deleted group');
    }

    const already = await this.isMember(groupId, userId);
    if (already) {
      throw new ConflictException('User is already a member of this group');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(MEMBERS_TABLE)
      .insert({ group_id: groupId, user_id: userId, role_id: roleId ?? null })
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(error?.message ?? 'Failed to add member');
    }

    this.logAudit(organizationId, actorUserId, groupId, 'update', {
      action: 'add_member',
      user_id: userId,
      role_id: roleId ?? null,
    });

    // Group or membership changed — drop cached effective permissions for the org.
    this.permissionsService.bustOrg(organizationId);

    return {
      data: data as Record<string, unknown>,
      success: true,
      message: 'Member added successfully',
    };
  }

  async addMembers(
    groupId: string,
    organizationId: string,
    userIds: string[],
    roleId?: string | null,
    actorUserId?: string | null,
  ): Promise<{
    data: Record<string, unknown>[];
    count: number;
    success: true;
    message: string;
  }> {
    const group = await this.getById(groupId, organizationId);
    if (group['is_deleted']) {
      throw new BadRequestException('Cannot add members to a deleted group');
    }

    // Filter out already-members

    const { data: existing } = await this.client
      .from(MEMBERS_TABLE)
      .select('user_id')
      .eq('group_id', groupId)
      .in('user_id', userIds);

    const existingIds = new Set(
      ((existing ?? []) as { user_id: string }[]).map((m) => m.user_id),
    );
    const toAdd = userIds.filter((uid) => !existingIds.has(uid));

    if (toAdd.length === 0) {
      return {
        data: [],
        count: 0,
        success: true,
        message: '0 member(s) added successfully',
      };
    }

    const rows = toAdd.map((uid) => ({
      group_id: groupId,
      user_id: uid,
      role_id: roleId ?? null,
    }));

    const { data, error } = await this.client
      .from(MEMBERS_TABLE)
      .insert(rows)
      .select();

    if (error) throw new BadRequestException(error.message);

    const inserted = (data ?? []) as Record<string, unknown>[];
    this.logAudit(organizationId, actorUserId, groupId, 'update', {
      action: 'add_members',
      user_ids: toAdd,
      role_id: roleId ?? null,
    });
    // Group or membership changed — drop cached effective permissions for the org.
    this.permissionsService.bustOrg(organizationId);

    return {
      data: inserted,
      count: inserted.length,
      success: true,
      message: `${inserted.length} member(s) added successfully`,
    };
  }

  async removeMember(
    groupId: string,
    organizationId: string,
    userId: string,
    actorUserId?: string | null,
  ): Promise<{ success: true; message: string }> {
    await this.getById(groupId, organizationId);
    const already = await this.isMember(groupId, userId);
    if (!already) {
      throw new BadRequestException('User is not a member of this group');
    }

    const { error } = await this.client
      .from(MEMBERS_TABLE)
      .delete()
      .eq('group_id', groupId)
      .eq('user_id', userId);

    if (error) throw new BadRequestException(error.message);
    this.logAudit(organizationId, actorUserId, groupId, 'update', {
      action: 'remove_member',
      user_id: userId,
    });
    // Group or membership changed — drop cached effective permissions for the org.
    this.permissionsService.bustOrg(organizationId);

    return { success: true, message: 'Member removed successfully' };
  }

  async removeMembers(
    groupId: string,
    organizationId: string,
    userIds: string[],
    actorUserId?: string | null,
  ): Promise<{ success: true; message: string }> {
    await this.getById(groupId, organizationId);

    const { error } = await this.client
      .from(MEMBERS_TABLE)
      .delete()
      .eq('group_id', groupId)
      .in('user_id', userIds);

    if (error) throw new BadRequestException(error.message);
    this.logAudit(organizationId, actorUserId, groupId, 'update', {
      action: 'remove_members',
      user_ids: userIds,
    });
    // Group or membership changed — drop cached effective permissions for the org.
    this.permissionsService.bustOrg(organizationId);

    return {
      success: true,
      message: `${userIds.length} member(s) removed successfully`,
    };
  }

  async updateMemberRole(
    groupId: string,
    organizationId: string,
    userId: string,
    roleId: string | null | undefined,
    actorUserId?: string | null,
  ): Promise<{
    data: Record<string, unknown>;
    success: true;
    message: string;
  }> {
    await this.getById(groupId, organizationId);

    const already = await this.isMember(groupId, userId);
    if (!already) {
      throw new BadRequestException('User is not a member of this group');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(MEMBERS_TABLE)
      .update({ role_id: roleId ?? null })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to update member role',
      );
    }

    this.logAudit(organizationId, actorUserId, groupId, 'update', {
      action: 'update_member_role',
      user_id: userId,
      role_id: roleId ?? null,
    });

    // Group or membership changed — drop cached effective permissions for the org.
    this.permissionsService.bustOrg(organizationId);

    return {
      data: data as Record<string, unknown>,
      success: true,
      message: 'Member role updated successfully',
    };
  }

  /**
   * Reverse lookup: which groups does each of these users belong to?
   *
   * Answers for every requested id in one round-trip, so a member list can be
   * decorated without one request per row. Ids with no groups are still present
   * in the result with an empty array, letting callers index the map blindly.
   *
   * @param {string} organizationId - Tenant whose groups may be returned
   * @param {string[]} userIds - `public.users.id` values to look up
   * @returns {Promise<Record<string, Array<{ id: string; name: string }>>>} Map of
   *   user id to the groups they belong to, one key per requested id
   * @throws {BadRequestException} When the underlying query fails
   */
  async getMembershipsForUsers(
    organizationId: string,
    userIds: string[],
  ): Promise<Record<string, Array<{ id: string; name: string }>>> {
    const uniqueIds = [...new Set(userIds)];

    // Seeded up front so users with no groups come back as [] rather than
    // missing keys, which callers would otherwise have to special-case.
    const result: Record<string, Array<{ id: string; name: string }>> = {};
    for (const userId of uniqueIds) {
      result[userId] = [];
    }

    if (uniqueIds.length === 0) {
      return result;
    }

    // `!inner` makes the org predicate a join filter rather than a post-filter,
    // so rows from other tenants are never returned. This is the only tenant
    // boundary: the admin client is service-role and bypasses RLS.
    const { data, error } = await this.client
      .from(MEMBERS_TABLE)
      .select('user_id, group:user_groups!inner(id, name)')
      .in('user_id', uniqueIds)
      .eq('group.organization_id', organizationId)
      .eq('group.is_deleted', false)
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    type MembershipRow = {
      user_id: string;
      group:
        | { id: string; name: string }
        | { id: string; name: string }[]
        | null;
    };

    for (const row of (data ?? []) as unknown as MembershipRow[]) {
      const group = Array.isArray(row.group) ? row.group[0] : row.group;
      if (!group || !result[row.user_id]) continue;
      result[row.user_id].push({ id: group.id, name: group.name });
    }

    return result;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async isMember(groupId: string, userId: string): Promise<boolean> {
    const { data } = await this.client
      .from(MEMBERS_TABLE)
      .select('id')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .maybeSingle();

    return !!data;
  }

  private async assertNameAvailable(
    name: string,
    organizationId: string,
    excludeId?: string,
  ): Promise<void> {
    let query = this.client
      .from(GROUPS_TABLE)
      .select('id')
      .eq('organization_id', organizationId)
      .ilike('name', name)
      .eq('is_deleted', false);

    if (excludeId) {
      query = query.neq('id', excludeId);
    }

    const { data } = await query.maybeSingle();
    if (data) {
      throw new ConflictException(
        `A group named "${name}" already exists in this organization`,
      );
    }
  }

  private logAudit(
    organizationId: string,
    actorUserId: string | null | undefined,
    groupId: string,
    action: 'create' | 'update' | 'delete' | 'restore',
    changes?: Record<string, unknown>,
  ): void {
    if (!actorUserId || !this.auditLogsService) return;
    void this.auditLogsService.logAction(
      organizationId,
      actorUserId,
      'user_group',
      groupId,
      action,
      changes,
    );
  }
}
