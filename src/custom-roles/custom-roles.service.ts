/**
 * @fileoverview Service for custom roles and user role assignments.
 * Mirrors risk-management-app CustomRoleService + UserRoleAssignmentRepository exactly.
 * @module src/custom-roles/custom-roles.service
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { CreateCustomRoleDto } from './dto/create-custom-role.dto';
import type { UpdateCustomRoleDto } from './dto/update-custom-role.dto';

const ROLES_TABLE = 'custom_roles';
const ASSIGNMENTS_TABLE = 'user_role_assignments';

const ASSIGNMENT_JOIN = `
  *,
  user:users!user_role_assignments_user_id_fkey(
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
export class CustomRolesService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    // Every mutation below changes what some user is allowed to do, so each one
    // must evict PermissionsService's short-TTL effective-permissions cache.
    // Without this an admin's change would appear to do nothing until the TTL
    // expired. PermissionsModule is already imported by CustomRolesModule, so
    // this needs no module wiring and introduces no cycle.
    private readonly permissionsService: PermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ── Custom Roles ────────────────────────────────────────────────────────

  async getAll(
    organizationId: string,
    filter?: {
      base_role?: string;
      is_active?: boolean;
      is_deleted?: boolean;
      search?: string;
    },
  ): Promise<{ data: Record<string, unknown>[]; count: number }> {
    let query = this.client
      .from(ROLES_TABLE)
      .select('*', { count: 'exact' })
      .eq('organization_id', organizationId);

    const isDeleted = filter?.is_deleted ?? false;
    query = query.eq('is_deleted', isDeleted);

    if (filter?.base_role) {
      query = query.eq('base_role', filter.base_role);
    }
    if (filter?.is_active !== undefined) {
      query = query.eq('is_active', filter.is_active);
    }
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

    return {
      data: (data ?? []) as Record<string, unknown>[],
      count: count ?? 0,
    };
  }

  async getById(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(ROLES_TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Role not found');
    return data as Record<string, unknown>;
  }

  async create(
    organizationId: string,
    dto: CreateCustomRoleDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.assertNameAvailable(dto.name, organizationId);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(ROLES_TABLE)
      .insert({
        organization_id: organizationId,
        name: dto.name,
        description: dto.description ?? null,
        color: dto.color ?? '#6B7280',
        icon: dto.icon ?? null,
        base_role: dto.base_role ?? 'member',
        permissions: dto.permissions ?? {},
        is_active: dto.is_active ?? true,
      })
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(error?.message ?? 'Failed to create role');
    }

    return { data: data as Record<string, unknown>, success: true };
  }

  async update(
    id: string,
    organizationId: string,
    dto: UpdateCustomRoleDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const existing = await this.getById(id, organizationId);

    if (existing['is_system']) {
      throw new BadRequestException('Cannot modify system roles');
    }

    if (dto.name && dto.name !== existing['name']) {
      await this.assertNameAvailable(dto.name, organizationId, id);
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.description !== undefined) patch['description'] = dto.description;
    if (dto.color !== undefined) patch['color'] = dto.color;
    if (dto.icon !== undefined) patch['icon'] = dto.icon;
    if (dto.base_role !== undefined) patch['base_role'] = dto.base_role;
    if (dto.permissions !== undefined) patch['permissions'] = dto.permissions;
    if (dto.is_active !== undefined) patch['is_active'] = dto.is_active;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(ROLES_TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(error?.message ?? 'Failed to update role');
    }

    // Role/assignment changed — drop cached effective permissions for this org.
    this.permissionsService.bustOrg(organizationId);

    return { data: data as Record<string, unknown>, success: true };
  }

  async softDelete(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    const existing = await this.getById(id, organizationId);

    if (existing['is_system']) {
      throw new BadRequestException('Cannot delete system roles');
    }

    const usageCount = await this.countUsersWithRole(id);
    if (usageCount > 0) {
      throw new BadRequestException(
        `Cannot delete role. It is assigned to ${usageCount} user(s). Remove all assignments first.`,
      );
    }

    const { error } = await this.client
      .from(ROLES_TABLE)
      .update({
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        deleted_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
    // Role/assignment changed — drop cached effective permissions for this org.
    this.permissionsService.bustOrg(organizationId);

    return { success: true, message: 'Role deleted successfully' };
  }

  async toggleActive(
    id: string,
    organizationId: string,
    isActive: boolean,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const existing = await this.getById(id, organizationId);

    if (existing['is_system'] && !isActive) {
      throw new BadRequestException('Cannot deactivate system roles');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(ROLES_TABLE)
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(error?.message ?? 'Failed to toggle role');
    }

    // Role/assignment changed — drop cached effective permissions for this org.
    this.permissionsService.bustOrg(organizationId);

    return { data: data as Record<string, unknown>, success: true };
  }

  async restore(
    id: string,
    organizationId: string,
  ): Promise<{
    data: Record<string, unknown>;
    success: true;
    message: string;
  }> {
    const existing = await this.getById(id, organizationId);

    if (!existing['is_deleted']) {
      throw new BadRequestException('Role is not deleted');
    }

    // Check name still available
    await this.assertNameAvailable(
      existing['name'] as string,
      organizationId,
      id,
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(ROLES_TABLE)
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
      throw new BadRequestException(error?.message ?? 'Failed to restore role');
    }

    // Role/assignment changed — drop cached effective permissions for this org.
    this.permissionsService.bustOrg(organizationId);

    return {
      data: data as Record<string, unknown>,
      success: true,
      message: 'Role restored successfully',
    };
  }

  async permanentDelete(
    id: string,
    organizationId: string,
  ): Promise<{ success: true; message: string }> {
    const existing = await this.getById(id, organizationId);

    if (existing['is_system']) {
      throw new BadRequestException('Cannot delete system roles');
    }

    if (!existing['is_deleted']) {
      throw new BadRequestException(
        'Role must be soft-deleted first before permanent deletion',
      );
    }

    const { error } = await this.client
      .from(ROLES_TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
    // Role/assignment changed — drop cached effective permissions for this org.
    this.permissionsService.bustOrg(organizationId);

    return { success: true, message: 'Role permanently deleted' };
  }

  async duplicate(
    id: string,
    organizationId: string,
    newName: string,
  ): Promise<{
    data: Record<string, unknown>;
    success: true;
    message: string;
  }> {
    const source = await this.getById(id, organizationId);
    await this.assertNameAvailable(newName, organizationId);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(ROLES_TABLE)
      .insert({
        organization_id: organizationId,
        name: newName,
        description: source['description'] ?? null,
        color: source['color'] ?? '#6B7280',
        icon: source['icon'] ?? null,
        base_role: source['base_role'] ?? 'member',
        permissions: source['permissions'] ?? {},
        is_active: true,
      })
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to duplicate role',
      );
    }

    return {
      data: data as Record<string, unknown>,
      success: true,
      message: 'Role duplicated successfully',
    };
  }

  async checkUsage(
    id: string,
    organizationId: string,
  ): Promise<{ data: { inUse: boolean; usageCount: number }; success: true }> {
    await this.getById(id, organizationId);
    const usageCount = await this.countUsersWithRole(id);
    return { data: { inUse: usageCount > 0, usageCount }, success: true };
  }

  // ── User Role Assignments ───────────────────────────────────────────────

  async getAssignments(
    organizationId: string,
    filter: { user_id?: string; role_id?: string },
  ): Promise<{ data: Record<string, unknown>[]; count: number }> {
    let query = this.client
      .from(ASSIGNMENTS_TABLE)
      .select(ASSIGNMENT_JOIN, { count: 'exact' })
      .eq('organization_id', organizationId);

    if (filter.user_id) {
      query = query.eq('user_id', filter.user_id);
    }
    if (filter.role_id) {
      query = query.eq('role_id', filter.role_id);
    }

    const { data, error, count } = await query.order('created_at', {
      ascending: false,
    });
    if (error) throw new BadRequestException(error.message);

    return {
      data: (data ?? []) as Record<string, unknown>[],
      count: count ?? 0,
    };
  }

  async getAssignmentById(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(ASSIGNMENTS_TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Role assignment not found');
    return data as Record<string, unknown>;
  }

  async assignRole(
    organizationId: string,
    userId: string,
    roleId: string,
    actorUserId?: string,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    // Verify role exists, is active, and not deleted

    const { data: role, error: roleError } = await this.client
      .from(ROLES_TABLE)
      .select('id, is_active, is_deleted')
      .eq('id', roleId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (roleError) throw new BadRequestException(roleError.message);
    if (!role) throw new NotFoundException('Role not found');

    const r = role as { is_active: boolean; is_deleted: boolean };
    if (r.is_deleted || !r.is_active) {
      throw new BadRequestException('Cannot assign inactive or deleted role');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(ASSIGNMENTS_TABLE)
      .insert({
        organization_id: organizationId,
        user_id: userId,
        role_id: roleId,
      })
      .select()
      .single();

    if (error) {
      // Postgres unique violation code
      if (error.code === '23505') {
        throw new ConflictException('Role is already assigned to this user');
      }
      throw new BadRequestException(error.message);
    }

    const assignment = data as Record<string, unknown>;
    void this.logAudit(
      organizationId,
      actorUserId,
      assignment.id as string,
      'create',
      {
        scope: 'user_role_assignment',
        user_id: userId,
        role_id: roleId,
      },
    );
    // Role/assignment changed — drop cached effective permissions for this org.
    this.permissionsService.bustOrg(organizationId);

    return { data: assignment, success: true };
  }

  async unassignRole(
    organizationId: string,
    userId: string,
    roleId?: string,
    actorUserId?: string,
  ): Promise<{ success: true; message: string }> {
    let query = this.client
      .from(ASSIGNMENTS_TABLE)
      .delete()
      .eq('organization_id', organizationId)
      .eq('user_id', userId);

    if (roleId) {
      query = query.eq('role_id', roleId);
    }

    const { error } = await query;
    if (error) throw new BadRequestException(error.message);

    void this.logAudit(organizationId, actorUserId, userId, 'delete', {
      scope: 'user_role_assignment',
      user_id: userId,
      role_id: roleId ?? null,
      all_roles: !roleId,
    });

    // Role/assignment changed — drop cached effective permissions for this org.
    this.permissionsService.bustOrg(organizationId);

    return {
      success: true,
      message: roleId
        ? 'Role unassigned successfully'
        : 'All roles unassigned from user',
    };
  }

  async deleteAssignmentById(
    id: string,
    organizationId: string,
    actorUserId?: string,
  ): Promise<{ success: true; message: string }> {
    await this.getAssignmentById(id, organizationId);

    const { error } = await this.client
      .from(ASSIGNMENTS_TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
    void this.logAudit(organizationId, actorUserId, id, 'delete', {
      scope: 'user_role_assignment',
    });

    // Role/assignment changed — drop cached effective permissions for this org.
    this.permissionsService.bustOrg(organizationId);

    return { success: true, message: 'Role assignment removed' };
  }

  private async logAudit(
    organizationId: string,
    actorUserId: string | undefined,
    entityId: string,
    action: 'create' | 'delete',
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
      // Audit is best-effort and must not break role assignment mutations.
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async countUsersWithRole(roleId: string): Promise<number> {
    const { count, error } = await this.client
      .from(ASSIGNMENTS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('role_id', roleId);

    if (error) throw new BadRequestException(error.message);

    return count ?? 0;
  }

  private async assertNameAvailable(
    name: string,
    organizationId: string,
    excludeId?: string,
  ): Promise<void> {
    let query = this.client
      .from(ROLES_TABLE)
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
        `A role named "${name}" already exists in this organization`,
      );
    }
  }
}
