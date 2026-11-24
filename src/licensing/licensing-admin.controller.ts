import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireSuperAdmin } from '../auth/decorators/require-super-admin.decorator';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  BulkSyncPlanFeaturesDto,
  CreateLicenseFeatureDto,
  CreateLicensePlanDto,
  ListChangeRequestsQueryDto,
  ListLicenseAuditEventsQueryDto,
  ListLicensePlansQueryDto,
  ListUsageCountersQueryDto,
  ReviewLicenseChangeRequestDto,
  UpdateLicenseFeatureDto,
  UpdateLicensePlanDto,
  UpdateOrganizationLicenseDto,
  UpsertLicenseFeatureOverrideDto,
  UpsertOrganizationLicenseDto,
  UpsertUsageCounterDto,
} from './dto/licensing.dto';
import { LicensingService } from './licensing.service';

@ApiTags('Admin Licensing')
@ApiBearerAuth()
@ImpersonationBlocked()
@RequireSuperAdmin()
@UseGuards(SuperAdminGuard)
@Controller('admin/licensing')
export class LicensingAdminController {
  constructor(private readonly service: LicensingService) {}

  @Get('plans')
  @ApiOperation({ summary: 'List all license plans for Super Admins' })
  listPlans(@Query() query: ListLicensePlansQueryDto) {
    return this.service.listPlans(query, false);
  }

  @Post('plans')
  @ApiOperation({ summary: 'Create a license plan' })
  createPlan(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateLicensePlanDto,
  ) {
    return this.service.createPlan(dto, user);
  }

  @Get('plans/:planId')
  @ApiOperation({ summary: 'Get license plan details' })
  @ApiParam({ name: 'planId' })
  getPlan(@Param('planId', ParseUUIDPipe) planId: string) {
    return this.service.getPlan(planId);
  }

  @Patch('plans/:planId')
  @ApiOperation({ summary: 'Update a license plan' })
  updatePlan(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: UpdateLicensePlanDto,
  ) {
    return this.service.updatePlan(planId, dto, user);
  }

  @Delete('plans/:planId')
  @ApiOperation({ summary: 'Archive a license plan' })
  archivePlan(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service.archivePlan(planId, user);
  }

  @Get('plans/:planId/features')
  @ApiOperation({ summary: 'List license plan features' })
  listPlanFeatures(@Param('planId', ParseUUIDPipe) planId: string) {
    return this.service.listPlanFeatures(planId);
  }

  @Post('plans/:planId/features')
  @ApiOperation({ summary: 'Create a license plan feature' })
  createPlanFeature(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: CreateLicenseFeatureDto,
  ) {
    return this.service.createPlanFeature(planId, dto, user);
  }

  @Patch('plans/:planId/features/:featureId')
  @ApiOperation({ summary: 'Update a license plan feature' })
  updatePlanFeature(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('featureId', ParseUUIDPipe) featureId: string,
    @Body() dto: UpdateLicenseFeatureDto,
  ) {
    return this.service.updatePlanFeature(planId, featureId, dto, user);
  }

  @Delete('plans/:planId/features/:featureId')
  @ApiOperation({ summary: 'Delete a license plan feature' })
  deletePlanFeature(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('featureId', ParseUUIDPipe) featureId: string,
  ) {
    return this.service.deletePlanFeature(planId, featureId, user);
  }

  /**
   * Transactional bulk-sync of plan features. Used by the SA catalog picker.
   *
   * Route note: we use `features-sync` (hyphen) rather than `features:bulk-sync`
   * (colon) — Express's path-to-regexp parses `:bulk-sync` as a route parameter
   * name after the `features` literal, shadowing real params. Hyphen is
   * unambiguous and idiomatic.
   */
  @Put('plans/:planId/features-sync')
  @ApiOperation({
    summary:
      'Bulk-sync plan features (transactional, single audit event). Calls bulk_sync_plan_features_atomic RPC.',
  })
  @ApiParam({ name: 'planId' })
  bulkSyncPlanFeatures(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: BulkSyncPlanFeaturesDto,
  ) {
    return this.service.bulkSyncPlanFeatures(planId, dto, user);
  }

  @Get('tenants/:organizationId/license')
  @ApiOperation({ summary: 'Get current tenant license' })
  getTenantLicense(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.service.getCurrentLicense(organizationId);
  }

  /**
   * Phase 5 — Super Admin visibility. Lists tenants (organizations) that have
   * NO live license. Includes grandfathered tenants (no `organization_licenses`
   * row at all) AND tenants whose only license is `cancelled`/`expired`.
   * Read-only; SuperAdmin-guarded via class-level decorators.
   */
  @Get('tenants-without-license')
  @ApiOperation({
    summary:
      'List tenants with no live license (grandfathered or cancelled/expired)',
  })
  listTenantsWithoutLicense() {
    return this.service.listTenantsWithoutLicense();
  }

  /**
   * Phase 6 — SA debug endpoint. Resolve a tenant's effective entitlements,
   * optionally busting the cache first to force a fresh DB read. Returns the
   * JSON-friendly snapshot plus current cache stats.
   *
   * Usage:
   *   GET /admin/licensing/debug/entitlements?organization_id=<uuid>
   *   GET /admin/licensing/debug/entitlements?organization_id=<uuid>&busted=true
   */
  @Get('debug/entitlements')
  @ApiOperation({
    summary: 'Resolve a tenant entitlement snapshot (debug, SA-only)',
  })
  debugEntitlements(
    @Query('organization_id', ParseUUIDPipe) organizationId: string,
    @Query('busted') busted?: string,
  ) {
    return this.service.debugEntitlements(organizationId, {
      busted: busted === 'true',
    });
  }

  /**
   * Phase 6 — SA debug endpoint. Returns resolver cache stats:
   * `{ size, hits, misses, hit_ratio }`. Useful for verifying cache behavior
   * in production without scraping logs.
   */
  @Get('debug/cache-stats')
  @ApiOperation({ summary: 'Resolver cache stats (debug, SA-only)' })
  getCacheStats() {
    return this.service.getCacheStats();
  }

  @Put('tenants/:organizationId/license')
  @ApiOperation({ summary: 'Create or replace the current tenant license' })
  upsertTenantLicense(
    @CurrentUser() user: RequestUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: UpsertOrganizationLicenseDto,
  ) {
    return this.service.upsertOrganizationLicense(organizationId, dto, user);
  }

  @Patch('tenants/:organizationId/license')
  @ApiOperation({ summary: 'Update the current tenant license' })
  updateTenantLicense(
    @CurrentUser() user: RequestUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: UpdateOrganizationLicenseDto,
  ) {
    return this.service.updateOrganizationLicense(organizationId, dto, user);
  }

  @Get('tenants/:organizationId/licenses')
  @ApiOperation({
    summary: 'All licences of a tenant (live and ended) and how it resolves',
  })
  listTenantLicenses(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.service.listTenantLicenses(organizationId);
  }

  @Patch('tenants/:organizationId/licenses/:licenseId')
  @ApiOperation({
    summary: 'Update one specific tenant licence (e.g. reactivate, set end)',
  })
  updateTenantLicenseById(
    @CurrentUser() user: RequestUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('licenseId', ParseUUIDPipe) licenseId: string,
    @Body() dto: UpdateOrganizationLicenseDto,
  ) {
    return this.service.updateOrganizationLicenseById(
      organizationId,
      licenseId,
      dto,
      user,
    );
  }

  @Get('tenants/:organizationId/overrides')
  @ApiOperation({ summary: 'List tenant license feature overrides' })
  listOverrides(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.service.listOverrides(organizationId);
  }

  @Post('tenants/:organizationId/overrides')
  @ApiOperation({
    summary: 'Create or update a tenant license feature override',
  })
  upsertOverride(
    @CurrentUser() user: RequestUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: UpsertLicenseFeatureOverrideDto,
  ) {
    return this.service.upsertOverride(organizationId, dto, user);
  }

  @Delete('tenants/:organizationId/overrides/:featureKey')
  @ApiOperation({ summary: 'Delete a tenant license feature override' })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'featureKey' })
  deleteOverride(
    @CurrentUser() user: RequestUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('featureKey') featureKey: string,
  ) {
    return this.service.deleteOverride(organizationId, featureKey, user);
  }

  @Get('tenants/:organizationId/entitlements')
  @ApiOperation({
    summary: 'Get effective entitlements for a tenant (Super Admin only)',
  })
  @ApiParam({ name: 'organizationId' })
  getTenantEntitlements(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.service.getTenantEntitlements(organizationId);
  }

  @Get('tenants/:organizationId/usage')
  @ApiOperation({ summary: 'List tenant license usage counters' })
  listUsage(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: ListUsageCountersQueryDto,
  ) {
    return this.service.listUsage(organizationId, query);
  }

  @Post('tenants/:organizationId/usage')
  @ApiOperation({ summary: 'Create or update a tenant license usage counter' })
  upsertUsage(
    @CurrentUser() user: RequestUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: UpsertUsageCounterDto,
  ) {
    return this.service.upsertUsage(organizationId, dto, user);
  }

  @Get('change-requests')
  @ApiOperation({ summary: 'List tenant license change requests' })
  listChangeRequests(@Query() query: ListChangeRequestsQueryDto) {
    return this.service.listChangeRequests(query);
  }

  /** One request by id (the review page used to search the first 100). */
  @Get('change-requests/:requestId')
  @ApiOperation({ summary: 'Get one tenant license change request' })
  getChangeRequest(@Param('requestId', ParseUUIDPipe) requestId: string) {
    return this.service.getChangeRequestById(requestId);
  }

  @Patch('change-requests/:requestId/review')
  @ApiOperation({ summary: 'Approve or reject a license change request' })
  reviewChangeRequest(
    @CurrentUser() user: RequestUser,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: ReviewLicenseChangeRequestDto,
  ) {
    return this.service.reviewChangeRequest(requestId, dto, user);
  }

  @Get('audit-events')
  @ApiOperation({ summary: 'List license audit events' })
  listAuditEvents(@Query() query: ListLicenseAuditEventsQueryDto) {
    return this.service.listAuditEvents(query);
  }
}
