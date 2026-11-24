/**
 * @fileoverview HTTP surface for tenant management — the routes the Next.js
 * tenant switcher and the middleware slug-validation flow consume.
 *
 * All three routes inherit authentication from the global
 * {@link SupabaseAuthGuard}; no per-route guard decorators are required.
 *
 * @module src/tenants/tenants.controller
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AllowWithoutSso } from '../auth/decorators/allow-without-sso.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SwitchTenantDto } from './dto/switch-tenant.dto';
import { TenantSummaryDto } from './dto/tenant-summary.dto';
import { TenantsService } from './tenants.service';

@ApiTags('Tenants')
@ApiBearerAuth()
@Controller('tenants')
export class TenantsController {
  constructor(private readonly service: TenantsService) {}

  @Get('me')
  @AllowWithoutSso()
  @ApiOperation({
    summary: 'List all organizations the current user is a member of',
    description:
      'Returns one row per organization_members entry for the caller, oldest first. Includes denormalised name, slug, role, and switcher-chip branding (logo_light_url + primary_color). Member counts are not included in this response.',
  })
  @ApiResponse({ status: 200, type: TenantSummaryDto, isArray: true })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async listMine(
    @CurrentUser() user: RequestUser,
  ): Promise<TenantSummaryDto[]> {
    return this.service.listForUser(user.userId);
  }

  @Get('by-slug/:slug')
  @ApiOperation({
    summary: 'Resolve a slug to an org and verify membership',
    description:
      'Used by Next.js middleware when validating /spaces/<slug>/... URLs. Returns 404 when the slug does not match any organization, 403 with `{ code: "NOT_A_MEMBER", organizationId, organizationName }` when the org exists but the caller has no membership row.',
  })
  @ApiResponse({ status: 200, type: TenantSummaryDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description:
      'Caller is not a member of this organization. Response body carries `code: "NOT_A_MEMBER"` plus `organizationId` and `organizationName` so the frontend can offer a "Request access" CTA.',
  })
  @ApiResponse({
    status: 404,
    description: 'Slug does not match any organization',
  })
  async getBySlug(
    @CurrentUser() user: RequestUser,
    @Param('slug') slug: string,
  ): Promise<TenantSummaryDto> {
    return this.service.resolveSlugForUser(slug, user.userId);
  }

  @Post('switch')
  @AllowWithoutSso()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Switch the active tenant for the current session',
    description:
      'Body must carry exactly one of `organizationId` or `slug`. On success, writes a signed `active_org_id` HttpOnly cookie and records the switch in `tenant_switch_audit`. No-op when the target equals the currently active tenant. 403 NOT_A_MEMBER when the caller is not a member of the target.',
  })
  @ApiResponse({ status: 200, type: TenantSummaryDto })
  @ApiResponse({
    status: 400,
    description:
      'Body provided neither or both of `organizationId` / `slug`, or a slug failed the regex.',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Not a member of target tenant' })
  @ApiResponse({ status: 404, description: 'Target tenant not found' })
  async switch(
    @CurrentUser() user: RequestUser,
    @Body() body: SwitchTenantDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TenantSummaryDto> {
    return this.service.switchActive(user, body, req, res);
  }
}
