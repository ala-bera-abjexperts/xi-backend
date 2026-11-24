import { spacesOnlyOwnedBy } from '../spaces/space-member-rules.service';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { User as SupabaseAuthUser } from '@supabase/supabase-js';

import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { EntitlementsService } from '../licensing/entitlements.service';
import { LIVE_LICENSE_STATUSES } from '../licensing/licensing.constants';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  CreateAdminTenantDto,
  CreateAdminTenantUserDto,
  TenantRole,
  UpdateAdminTenantDto,
  UpdateAdminTenantUserDto,
} from './dto/admin-tenant.dto';

const SUPER_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

type ListFilters = {
  page: number;
  limit: number;
  search?: string;
  is_active?: boolean;
};

type PublicUser = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  mobile: string | null;
  avatar_url: string | null;
  role: string | null;
  // organization_id was removed from public.users by the multi-tenant migration
  // (20260519161942_multi_tenant_user_membership.sql). Tenancy is now exclusively
  // expressed via organization_members.
  auth_user_id: string | null;
  is_active: boolean | null;
  created_at: string | null;
  updated_at: string | null;
};

type TenantUserRecord = PublicUser & {
  membership_id: string;
  membership_role: string;
  membership_created_at: string | null;
};

@Injectable()
export class AdminTenantsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
    private readonly permissionsService: PermissionsService,
    // Optional so focused unit tests can construct the service without it.
    @Optional() private readonly entitlementsService?: EntitlementsService,
  ) {}

  private get client(): ReturnType<SupabaseAdminService['getClient']> {
    return this.supabaseAdmin.getClient();
  }

  async listTenants(filters: ListFilters) {
    const { page, limit, search, is_active } = filters;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = this.client
      .from('organizations')
      .select(
        'id,name,slug,size,is_active,created_at,updated_at,default_space_id',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .range(from, to);

    const normalizedSearch = search?.trim();
    if (normalizedSearch) {
      const escaped = this.escapeLike(normalizedSearch);
      query = query.or(`name.ilike.%${escaped}%,slug.ilike.%${escaped}%`);
    }

    if (typeof is_active === 'boolean') {
      query = query.eq('is_active', is_active);
    }

    const { data, error, count } = await query;
    if (error) this.throwDatabaseError(error.message);

    const rows = (data ?? []) as Array<{ id: string; created_at: string }>;

    return {
      data: await this.withLicenceSummary(rows),
      total: count ?? 0,
    };
  }

  /**
   * Adds a one-line licence summary to each tenant on the page (audit A8): the
   * nearest end date of its live licences, their plan and partner, so the list
   * shows who is licensed, by whom, and until when.
   */
  private async withLicenceSummary<T extends { id: string; created_at: string }>(
    rows: T[],
  ) {
    if (rows.length === 0) return rows;

    const { data: licences } = await this.client
      .from('organization_licenses')
      .select(
        'organization_id, status, ends_at, partner_id, license_plans(name)',
      )
      .in(
        'organization_id',
        rows.map((r) => r.id),
      )
      .in('status', LIVE_LICENSE_STATUSES as string[]);
    const { data: settings } = await this.client
      .from('licensing_settings')
      .select('grandfather_before')
      .eq('id', 1)
      .maybeSingle();

    const live = (licences ?? []) as Array<{
      organization_id: string;
      status: string;
      ends_at: string | null;
      partner_id: string | null;
      license_plans?: { name?: string } | null;
    }>;
    const partnerIds = [
      ...new Set(live.map((l) => l.partner_id).filter((v): v is string => !!v)),
    ];
    const partnerNames = new Map<string, string>();

    if (partnerIds.length > 0) {
      const { data: partners } = await this.client
        .from('organizations')
        .select('id, name')
        .in('id', partnerIds);
      for (const p of (partners ?? []) as { id: string; name: string }[]) {
        partnerNames.set(p.id, p.name);
      }
    }

    const cutoff = (settings as { grandfather_before?: string } | null)
      ?.grandfather_before;

    return rows.map((row) => {
      const own = live.filter((l) => l.organization_id === row.id);
      const ends = own
        .map((l) => l.ends_at)
        .filter((v): v is string => !!v)
        .sort()[0];

      return {
        ...row,
        licence_summary: {
          live_count: own.length,
          status: own[0]?.status ?? null,
          plan_name: own[0]?.license_plans?.name ?? null,
          partner_name: own.find((l) => l.partner_id)
            ? (partnerNames.get(own.find((l) => l.partner_id)!.partner_id!) ??
              null)
            : null,
          ends_at: ends ?? null,
          // No live licence: legacy (unlimited) or the Free default.
          posture:
            own.length > 0
              ? 'licensed'
              : cutoff && Date.parse(row.created_at) >= Date.parse(cutoff)
                ? 'free_default'
                : 'unlicensed',
        },
      };
    });
  }

  async getSuperAdminProfile(userId: string) {
    const { data, error } = await this.client
      .from('users')
      .select('id,email,first_name,last_name,avatar_url,role,is_active')
      .eq('id', userId)
      .maybeSingle();

    if (error) this.throwDatabaseError(error.message);
    if (!data) throw new NotFoundException('Super Admin profile not found');

    return { data };
  }

  async createTenant(input: CreateAdminTenantDto, actorUserId: string) {
    const slug = input.slug.trim().toLowerCase();
    await this.ensureSlugAvailable(slug);

    const insertPayload = {
      name: input.name.trim(),
      slug,
      size: input.size ?? 'medium',
      is_active: input.is_active ?? true,
    };

    const { data, error } = await this.client
      .from('organizations')
      .insert(insertPayload)
      .select(
        'id,name,slug,size,is_active,created_at,updated_at,default_space_id',
      )
      .single();

    if (error) this.throwDatabaseError(error.message);

    await this.audit(data.id, actorUserId, 'organization', data.id, 'create', {
      after: insertPayload,
    });

    return { data };
  }

  async getTenant(tenantId: string) {
    const tenant = await this.getTenantOrThrow(tenantId);
    return { data: tenant };
  }

  async updateTenant(
    tenantId: string,
    input: UpdateAdminTenantDto,
    actorUserId: string,
  ) {
    const existing = await this.getTenantOrThrow(tenantId);
    const updatePayload: Record<string, unknown> = {};

    if (input.name !== undefined) updatePayload.name = input.name.trim();

    if (input.slug !== undefined) {
      const slug = input.slug.trim().toLowerCase();
      await this.ensureSlugAvailable(slug, tenantId);
      updatePayload.slug = slug;
    }

    if (input.size !== undefined) updatePayload.size = input.size;

    if (input.default_space_id !== undefined) {
      if (input.default_space_id) {
        await this.ensureSpaceBelongsToTenant(tenantId, input.default_space_id);
        updatePayload.default_space_id = input.default_space_id;
      } else {
        updatePayload.default_space_id = null;
      }
    }

    if (input.is_active !== undefined) {
      this.assertCanChangeSuperTenantStatus(tenantId, input.is_active);
      updatePayload.is_active = input.is_active;
    }

    if (Object.keys(updatePayload).length === 0) {
      return { data: existing };
    }

    const { data, error } = await this.client
      .from('organizations')
      .update(updatePayload)
      .eq('id', tenantId)
      .select(
        'id,name,slug,size,is_active,created_at,updated_at,default_space_id',
      )
      .single();

    if (error) this.throwDatabaseError(error.message);

    await this.audit(
      tenantId,
      actorUserId,
      'organization',
      tenantId,
      'update',
      {
        before: existing,
        after: data,
        changes: updatePayload,
      },
    );

    return { data };
  }

  async updateTenantStatus(
    tenantId: string,
    isActive: boolean,
    actorUserId: string,
  ) {
    this.assertCanChangeSuperTenantStatus(tenantId, isActive);
    return this.updateTenant(tenantId, { is_active: isActive }, actorUserId);
  }

  async deleteTenant(tenantId: string, actorUserId: string) {
    this.assertCanChangeSuperTenantStatus(tenantId, false);
    return this.updateTenant(tenantId, { is_active: false }, actorUserId);
  }

  async listTenantSpaces(tenantId: string) {
    await this.getTenantOrThrow(tenantId);

    const { data, error } = await this.client
      .from('spaces')
      .select('id,name,key,is_active,is_archived')
      .eq('organization_id', tenantId)
      .order('name', { ascending: true });

    if (error) this.throwDatabaseError(error.message);

    return { data: data ?? [] };
  }

  async listTenantUsers(tenantId: string, filters: ListFilters) {
    await this.getTenantOrThrow(tenantId);
    const { page, limit, search, is_active } = filters;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = this.client
      .from('organization_members')
      .select(
        `id,role,created_at,users!inner(
          id,email,first_name,last_name,mobile,avatar_url,role,auth_user_id,is_active,created_at,updated_at
        )`,
        { count: 'exact' },
      )
      .eq('organization_id', tenantId)
      .order('created_at', { ascending: false })
      .range(from, to);

    const normalizedSearch = search?.trim();
    if (normalizedSearch) {
      const escaped = this.escapeLike(normalizedSearch);
      query = query.or(
        `email.ilike.%${escaped}%,first_name.ilike.%${escaped}%,last_name.ilike.%${escaped}%`,
        { foreignTable: 'users' },
      );
    }

    if (typeof is_active === 'boolean') {
      query = query.eq('users.is_active', is_active);
    }

    const { data, error, count } = await query;
    if (error) this.throwDatabaseError(error.message);

    return {
      data: (data ?? []).map((row) => this.mapTenantUser(row)),
      total: count ?? 0,
    };
  }

  async getTenantUser(tenantId: string, userId: string) {
    const user = await this.fetchTenantUser(tenantId, userId);
    return { data: user };
  }

  async createTenantUser(
    tenantId: string,
    input: CreateAdminTenantUserDto,
    actorUserId: string,
  ) {
    const sendInvite = input.send_invite ?? false;
    const role = input.role ?? 'member';
    if (!sendInvite && !input.password) {
      throw new BadRequestException(
        'Password is required when not sending an invite',
      );
    }

    await this.getTenantOrThrow(tenantId);

    const existingPublicUser = await this.findPublicUserByEmail(input.email);
    let authUserId = existingPublicUser?.auth_user_id ?? null;

    // Seat limit (licensing audit D1): adding a user who is not already an
    // active member of this tenant takes a seat. Checked before any write.
    if (
      !(await this.isActiveMember(tenantId, existingPublicUser?.id ?? null))
    ) {
      await this.entitlementsService?.assertSeatAvailable(tenantId);
    }

    if (!authUserId) {
      const createdAuthUser = await this.createAuthUser(input, sendInvite);
      authUserId = createdAuthUser.id;
    }

    const publicUser = await this.upsertPublicUser(
      tenantId,
      input,
      authUserId,
      existingPublicUser,
    );

    const { error: membershipError } = await this.client
      .from('organization_members')
      .upsert(
        {
          organization_id: tenantId,
          user_id: publicUser.id,
          role,
        },
        { onConflict: 'organization_id,user_id' },
      );

    if (membershipError) this.throwDatabaseError(membershipError.message);

    const data = await this.fetchTenantUser(tenantId, publicUser.id);

    await this.audit(
      tenantId,
      actorUserId,
      'organization_member',
      publicUser.id,
      'create',
      {
        after: data,
        role,
        sent_invite: sendInvite,
      },
    );

    return { data };
  }

  private async isActiveMember(
    tenantId: string,
    userId: string | null,
  ): Promise<boolean> {
    if (!userId) return false;

    const { data, error } = await this.client
      .from('organization_members')
      .select('id, users!inner(is_active)')
      .eq('organization_id', tenantId)
      .eq('user_id', userId)
      .eq('users.is_active', true)
      .maybeSingle();

    if (error) this.throwDatabaseError(error.message);

    return !!data;
  }

  async updateTenantUser(
    tenantId: string,
    userId: string,
    input: UpdateAdminTenantUserDto,
    actorUserId: string,
  ) {
    const before = await this.fetchTenantUser(tenantId, userId);
    const updatePayload: Record<string, unknown> = {};

    if (input.first_name !== undefined)
      updatePayload.first_name = input.first_name.trim();
    if (input.last_name !== undefined)
      updatePayload.last_name = input.last_name.trim();
    if (input.mobile !== undefined) updatePayload.mobile = input.mobile;

    if (Object.keys(updatePayload).length === 0) {
      return { data: before };
    }

    const { error } = await this.client
      .from('users')
      .update(updatePayload)
      .eq('id', userId);

    if (error) this.throwDatabaseError(error.message);

    const data = await this.fetchTenantUser(tenantId, userId);

    await this.audit(tenantId, actorUserId, 'user', userId, 'update', {
      before,
      after: data,
      changes: updatePayload,
    });

    return { data };
  }

  async updateTenantUserStatus(
    tenantId: string,
    userId: string,
    isActive: boolean,
    actorUserId: string,
  ) {
    const before = await this.fetchTenantUser(tenantId, userId);

    if (!isActive) {
      if (userId === actorUserId && before.role === SUPER_ADMIN_ROLE) {
        throw new BadRequestException(
          'You cannot deactivate your own super admin account',
        );
      }
      if (before.membership_role === 'owner') {
        await this.ensureTenantHasAnotherActiveOwner(tenantId, userId);
      }
    }

    const { error } = await this.client
      .from('users')
      .update({ is_active: isActive })
      .eq('id', userId);

    if (error) this.throwDatabaseError(error.message);

    const data = await this.fetchTenantUser(tenantId, userId);

    await this.audit(tenantId, actorUserId, 'user', userId, 'update', {
      before,
      after: data,
      event: 'update_status',
      is_active: isActive,
    });

    return { data };
  }

  async updateTenantUserRole(
    tenantId: string,
    userId: string,
    role: TenantRole,
    actorUserId: string,
  ) {
    const before = await this.fetchTenantUser(tenantId, userId);

    if (before.membership_role === 'owner' && role !== 'owner') {
      await this.ensureTenantHasAnotherActiveOwner(tenantId, userId);
    }

    const { error } = await this.client
      .from('organization_members')
      .update({ role })
      .eq('organization_id', tenantId)
      .eq('user_id', userId);

    if (error) this.throwDatabaseError(error.message);

    const data = await this.fetchTenantUser(tenantId, userId);

    await this.audit(
      tenantId,
      actorUserId,
      'organization_member',
      userId,
      'update',
      {
        before,
        after: data,
        event: 'update_role',
        role,
      },
    );

    return { data };
  }

  async deleteTenantUser(
    tenantId: string,
    userId: string,
    actorUserId: string,
  ) {
    const before = await this.fetchTenantUser(tenantId, userId);

    if (userId === actorUserId) {
      throw new BadRequestException('You cannot remove yourself from a tenant');
    }

    if (before.membership_role === 'owner') {
      await this.ensureTenantHasAnotherActiveOwner(tenantId, userId);
    }

    // Never stops the removal: org owners and admins still manage these spaces. Recorded below.
    const leftWithoutOwner = await spacesOnlyOwnedBy(
      this.client,
      tenantId,
      userId,
    );

    // Same cleanup as the tenant-side removal: membership plus the access it carries (spaces, groups, grants).
    const { data, error } = await this.client.rpc(
      'remove_organization_member',
      { p_org_id: tenantId, p_user_id: userId },
    );

    if (error) {
      if (/LAST_ACTIVE_OWNER/.test(error.message)) {
        throw new BadRequestException(
          'A tenant must have at least one active owner',
        );
      }
      this.throwDatabaseError(error.message);
    }

    // Membership, group and role rows feed the cached effective permissions.
    this.permissionsService.bustOrg(tenantId);

    await this.audit(
      tenantId,
      actorUserId,
      'organization_member',
      userId,
      'delete',
      {
        before,
        counts: (data as { counts?: Record<string, number> } | null)?.counts,
        ...(leftWithoutOwner.length && {
          spaces_left_without_owner: leftWithoutOwner,
        }),
      },
    );

    return { success: true };
  }

  private async getTenantOrThrow(tenantId: string) {
    const { data, error } = await this.client
      .from('organizations')
      .select(
        'id,name,slug,size,is_active,created_at,updated_at,default_space_id',
      )
      .eq('id', tenantId)
      .single();

    if (error || !data) {
      throw new NotFoundException('Tenant not found');
    }

    return data;
  }

  private async ensureSlugAvailable(slug: string, excludeTenantId?: string) {
    let query = this.client.from('organizations').select('id').eq('slug', slug);

    if (excludeTenantId) {
      query = query.neq('id', excludeTenantId);
    }

    const { data, error } = await query.maybeSingle();
    if (error) this.throwDatabaseError(error.message);
    if (data) throw new BadRequestException('Tenant slug already exists');
  }

  private async ensureSpaceBelongsToTenant(tenantId: string, spaceId: string) {
    const { data, error } = await this.client
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', tenantId)
      .maybeSingle();

    if (error) this.throwDatabaseError(error.message);
    if (!data)
      throw new BadRequestException('Default space must belong to the tenant');
  }

  private assertCanChangeSuperTenantStatus(
    tenantId: string,
    isActive: boolean,
  ) {
    if (tenantId === SUPER_TENANT_ID && !isActive) {
      throw new BadRequestException('The super tenant cannot be deactivated');
    }
  }

  private async findPublicUserByEmail(
    email: string,
  ): Promise<PublicUser | null> {
    const { data, error } = await this.client
      .from('users')
      .select(
        'id,email,first_name,last_name,mobile,avatar_url,role,auth_user_id,is_active,created_at,updated_at',
      )
      .eq('email', email)
      .maybeSingle();

    if (error) this.throwDatabaseError(error.message);
    return data ?? null;
  }

  private async createAuthUser(
    input: CreateAdminTenantUserDto,
    sendInvite: boolean,
  ): Promise<SupabaseAuthUser> {
    if (sendInvite) {
      const { data, error } = await this.client.auth.admin.inviteUserByEmail(
        input.email,
      );
      if (error || !data?.user) {
        throw new BadRequestException(
          error?.message ?? 'Failed to invite user',
        );
      }
      return data.user;
    }

    const { data, error } = await this.client.auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
    });

    if (error || !data?.user) {
      throw new BadRequestException(
        error?.message ?? 'Failed to create auth user',
      );
    }

    return data.user;
  }

  private async upsertPublicUser(
    tenantId: string,
    input: CreateAdminTenantUserDto,
    authUserId: string,
    existingPublicUser: PublicUser | null,
  ): Promise<PublicUser> {
    const payload: Record<string, unknown> = {
      email: input.email,
      first_name: input.first_name.trim(),
      last_name: input.last_name.trim(),
      mobile: input.mobile ?? existingPublicUser?.mobile ?? null,
      auth_user_id: authUserId,
      is_active: true,
    };

    if (existingPublicUser?.id) payload.id = existingPublicUser.id;
    // Multi-tenant: users.organization_id is gone. The membership
    // is created by the caller (createTenantUser → organization_members upsert)
    // immediately after this upsert returns, so no tenant write happens here.
    if (existingPublicUser?.role === SUPER_ADMIN_ROLE) {
      payload.role = SUPER_ADMIN_ROLE;
    }

    const { data, error } = await this.client
      .from('users')
      .upsert(payload, { onConflict: 'email' })
      .select(
        'id,email,first_name,last_name,mobile,avatar_url,role,auth_user_id,is_active,created_at,updated_at',
      )
      .single();

    if (error || !data)
      this.throwDatabaseError(error?.message ?? 'Failed to upsert user');
    return data;
  }

  private async fetchTenantUser(
    tenantId: string,
    userId: string,
  ): Promise<TenantUserRecord> {
    const { data, error } = await this.client
      .from('organization_members')
      .select(
        `id,role,created_at,users!inner(
          id,email,first_name,last_name,mobile,avatar_url,role,auth_user_id,is_active,created_at,updated_at
        )`,
      )
      .eq('organization_id', tenantId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) this.throwDatabaseError(error.message);
    if (!data) throw new NotFoundException('Tenant user not found');

    return this.mapTenantUser(data);
  }

  private async ensureTenantHasAnotherActiveOwner(
    tenantId: string,
    excludingUserId: string,
  ) {
    const { data, error } = await this.client
      .from('organization_members')
      .select('user_id,users!inner(is_active)')
      .eq('organization_id', tenantId)
      .eq('role', 'owner')
      .neq('user_id', excludingUserId)
      .eq('users.is_active', true)
      .limit(1);

    if (error) this.throwDatabaseError(error.message);
    if (!data || data.length === 0) {
      throw new BadRequestException(
        'A tenant must have at least one active owner',
      );
    }
  }

  private mapTenantUser(row: Record<string, unknown>): TenantUserRecord {
    const rawUser = row.users;
    const user = (Array.isArray(rawUser) ? rawUser[0] : rawUser) as
      | PublicUser
      | undefined;

    if (!user) {
      throw new InternalServerErrorException('Tenant user relation missing');
    }

    return {
      ...user,
      membership_id: String(row.id),
      membership_role: String(row.role),
      membership_created_at:
        typeof row.created_at === 'string' ? row.created_at : null,
    };
  }

  private escapeLike(value: string) {
    return value.replace(/[%_]/g, (match) => `\\${match}`);
  }

  private throwDatabaseError(message: string): never {
    throw new BadRequestException(message);
  }

  private async audit(
    organizationId: string,
    actorUserId: string,
    entityType: string,
    entityId: string,
    action: 'create' | 'update' | 'delete' | 'archive' | 'restore',
    changes: Record<string, unknown>,
  ) {
    try {
      await this.auditLogsService.logAction(
        organizationId,
        actorUserId,
        entityType,
        entityId,
        action,
        changes,
      );
    } catch (error) {
      console.warn('Failed to write admin tenant audit log', error);
    }
  }
}
