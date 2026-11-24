import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireSuperAdmin } from '../auth/decorators/require-super-admin.decorator';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AdminTenantsService } from './admin-tenants.service';
import {
  CreateAdminTenantDto,
  CreateAdminTenantUserDto,
  UpdateAdminTenantDto,
  UpdateAdminTenantStatusDto,
  UpdateAdminTenantUserDto,
  UpdateAdminTenantUserRoleDto,
  UpdateAdminTenantUserStatusDto,
} from './dto/admin-tenant.dto';

type AdminListQuery = {
  page?: string;
  limit?: string;
  search?: string;
  is_active?: string;
};

@ApiTags('Admin Tenants')
@ApiBearerAuth()
@ImpersonationBlocked()
@Controller('admin/tenants')
@RequireSuperAdmin()
@UseGuards(SuperAdminGuard)
export class AdminTenantsController {
  constructor(private readonly adminTenantsService: AdminTenantsService) {}

  @Get()
  @ApiOperation({
    summary: 'List all tenants (organizations)',
    description:
      'Super-admin view of every organization on the platform with pagination, search by name/slug, and optional is_active filter. Use `page`, `limit` (≤100), `search`, `is_active` query params.',
  })
  listTenants(@Query() query: AdminListQuery) {
    return this.adminTenantsService.listTenants(this.parseListQuery(query));
  }

  @Post()
  @ApiOperation({
    summary: 'Create a new tenant',
    description:
      'Super-admin onboarding: creates a new organization row. Does NOT auto-add the calling super-admin as a member; use POST /admin/tenants/:tenantId/users afterwards if you need to seed members.',
  })
  createTenant(
    @Body() body: CreateAdminTenantDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.adminTenantsService.createTenant(body, user.userId);
  }

  @Get(':tenantId/spaces')
  @ApiOperation({
    summary: 'List all spaces inside a tenant',
    description:
      'Returns every space scoped to the given tenant. Used by the admin console to inspect a tenant without switching into it.',
  })
  listTenantSpaces(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.adminTenantsService.listTenantSpaces(tenantId);
  }

  @Get(':tenantId/users')
  @ApiOperation({
    summary: 'List members of a tenant',
    description:
      'Paginated list of organization_members for the given tenant, joined to the public.users profile. Supports `page`, `limit` (≤100), `search` (email/first_name/last_name), `is_active` filter.',
  })
  listTenantUsers(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() query: AdminListQuery,
  ) {
    return this.adminTenantsService.listTenantUsers(
      tenantId,
      this.parseListQuery(query),
    );
  }

  @Post(':tenantId/users')
  @ApiOperation({
    summary: 'Add a user to a tenant',
    description:
      'Creates the Supabase auth user (or links an existing one by email) and inserts an organization_members row for the given tenant. Supports `send_invite: true` to email an invitation instead of setting a password directly.',
  })
  createTenantUser(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: CreateAdminTenantUserDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.adminTenantsService.createTenantUser(
      tenantId,
      body,
      user.userId,
    );
  }

  @Get(':tenantId/users/:userId')
  @ApiOperation({
    summary: 'Get a single tenant member',
    description:
      'Returns the public.users profile of one member of the given tenant. 404 if the user is not a member.',
  })
  getTenantUser(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.adminTenantsService.getTenantUser(tenantId, userId);
  }

  @Patch(':tenantId/users/:userId')
  @ApiOperation({
    summary: 'Update a tenant member profile',
    description:
      "Updates the user's public profile fields (first_name, last_name, mobile, etc.). Use the dedicated /status and /role sub-routes to flip is_active or org role.",
  })
  updateTenantUser(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: UpdateAdminTenantUserDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.adminTenantsService.updateTenantUser(
      tenantId,
      userId,
      body,
      user.userId,
    );
  }

  @Patch(':tenantId/users/:userId/status')
  @ApiOperation({
    summary: 'Activate or deactivate a tenant member',
    description:
      'Toggles public.users.is_active for the given member. Deactivated users keep their organization_members row but cannot sign in.',
  })
  updateTenantUserStatus(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: UpdateAdminTenantUserStatusDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.adminTenantsService.updateTenantUserStatus(
      tenantId,
      userId,
      body.is_active,
      user.userId,
    );
  }

  @Patch(':tenantId/users/:userId/role')
  @ApiOperation({
    summary: 'Change a member organization role',
    description:
      "Updates organization_members.role for the given user inside this tenant. Allowed values: 'owner' / 'admin' / 'member' / 'viewer'. Demoting the sole owner is blocked by the prevent_demote_last_owner DB trigger.",
  })
  updateTenantUserRole(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: UpdateAdminTenantUserRoleDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.adminTenantsService.updateTenantUserRole(
      tenantId,
      userId,
      body.role,
      user.userId,
    );
  }

  @Delete(':tenantId/users/:userId')
  @ApiOperation({
    summary: 'Remove a member from a tenant',
    description:
      'Deletes the organization_members row. The public.users profile and any other tenants the user belongs to are untouched. Removing the sole owner of the tenant is blocked by the prevent_orphan_organization DB trigger.',
  })
  deleteTenantUser(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.adminTenantsService.deleteTenantUser(
      tenantId,
      userId,
      user.userId,
    );
  }

  @Patch(':tenantId/status')
  @ApiOperation({
    summary: 'Activate or deactivate a tenant',
    description:
      "Toggles organizations.is_active. Deactivating a tenant keeps the data intact but hides it from members' switchers and blocks new sign-ins.",
  })
  updateTenantStatus(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: UpdateAdminTenantStatusDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.adminTenantsService.updateTenantStatus(
      tenantId,
      body.is_active,
      user.userId,
    );
  }

  @Get(':tenantId')
  @ApiOperation({
    summary: 'Get a tenant by id',
    description: 'Returns the full organizations row for the given tenant id.',
  })
  getTenant(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.adminTenantsService.getTenant(tenantId);
  }

  @Patch(':tenantId')
  @ApiOperation({
    summary: 'Update tenant metadata',
    description:
      'Patches name / slug / size / default_space_id on the tenant. Slug uniqueness is enforced by the DB; 409 with `code: "SLUG_TAKEN"` on conflict.',
  })
  updateTenant(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: UpdateAdminTenantDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.adminTenantsService.updateTenant(tenantId, body, user.userId);
  }

  @Delete(':tenantId')
  @ApiOperation({
    summary: 'Delete a tenant',
    description:
      'Hard-deletes the organization and cascades through every FK dependent (memberships, spaces, branding, …) atomically via the public.delete_organization RPC. The cascade bypasses the sole-owner guard via a per-transaction GUC; there is no soft-delete fallback.',
  })
  deleteTenant(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.adminTenantsService.deleteTenant(tenantId, user.userId);
  }

  private parseListQuery(query: AdminListQuery) {
    const page = this.parsePositiveInteger(query.page, 1);
    const limit = Math.min(this.parsePositiveInteger(query.limit, 20), 100);

    return {
      page,
      limit,
      search:
        typeof query.search === 'string' ? query.search.trim() : undefined,
      is_active:
        query.is_active === 'true'
          ? true
          : query.is_active === 'false'
            ? false
            : undefined,
    };
  }

  private parsePositiveInteger(value: string | undefined, fallback: number) {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
