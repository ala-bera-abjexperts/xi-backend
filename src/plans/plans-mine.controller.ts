// MCP-facing plan read endpoint (`/plans/mine/search`) backing the MCP
// `plan.search` tool. Mirrors the `wiki/mine/*` placement.
//
// The global auth chain applies (so normal app-auth and the MCP S2S guard
// behave identically), plus the class-level `@RequireFeature('module_plans')`
// (the raw /plans controller predates feature-gating; this MCP surface is
// gated like the rest of the mine/* family). There's deliberately no
// PermissionsGuard requirement here: the route is cross-space (no `:spaceId`
// path param) and PlansMineService delegates enforcement to
// PlansService.listPlans (org admin/owner bypass → space membership +
// `view_plans` → per-plan `plan_permissions` ACL), collapsing every denial to
// an empty result (anti-probing). The org is always the caller's, never a
// parameter.

import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PlansMineService } from './plans-mine.service';

@RequireFeature('module_plans')
@ApiTags('Plans')
@ApiBearerAuth()
@Controller('plans/mine')
export class PlansMineController {
  constructor(private readonly plansMineService: PlansMineService) {}

  // Parses a query-string integer, returning `undefined` for absent or
  // non-numeric values so the service applies its own default/clamp (no `NaN`
  // reaches the query layer). Mirrors the wiki mine controller.
  private parseFiniteInt(value?: string): number | undefined {
    if (value === undefined) return undefined;
    const parsed = parseInt(value, 10);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  @Get('search')
  @ApiOperation({
    summary: 'Search plans the current user can access',
    description:
      'Name search over plans the authenticated caller can read in their ' +
      'active organization — member spaces with view_plans (or org ' +
      'admin/owner) plus per-plan permission grants. Never cross-org, never ' +
      'a non-member space plan without an explicit grant. Archived plans are ' +
      'excluded unless includeArchived=true. An absent query lists all ' +
      'accessible plans. Backs the MCP plan.search tool.',
  })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'spaceIdOrKey', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'ownerId', required: false })
  @ApiQuery({ name: 'includeArchived', required: false, type: Boolean })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiResponse({ status: 200, description: 'Accessible plans returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async searchMyPlans(
    @CurrentUser() user: RequestUser,
    @Query('q') q?: string,
    @Query('spaceIdOrKey') spaceIdOrKey?: string,
    @Query('status') status?: string,
    @Query('ownerId') ownerId?: string,
    @Query('includeArchived') includeArchived?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.plansMineService.searchMyPlans(user, {
      query: q || undefined,
      spaceIdOrKey: spaceIdOrKey || undefined,
      status: status || undefined,
      ownerId: ownerId || undefined,
      includeArchived: includeArchived === 'true',
      limit: this.parseFiniteInt(limit),
      cursor: cursor || undefined,
    });
  }

  // Declared AFTER `search` so the literal route wins within this controller.
  @Get(':planIdOrKey')
  @ApiOperation({
    summary: 'Get one accessible plan by UUID or plan key',
    description:
      'Resolves a plan by UUID or org-scoped plan key and returns a ' +
      'whitelisted detail (metadata + item/risk/stakeholder counts — no ' +
      'items, no baseline, no financials) only when the caller can view it ' +
      '(org admin/owner, member space with view_plans, or a per-plan ' +
      'permission grant). Cross-org, non-member, permission-denied, ' +
      'ambiguous-key, and nonexistent all return an IDENTICAL 404 ' +
      '(anti-probing). Archived plans are returned flagged. Backs the MCP ' +
      'plan.get tool.',
  })
  @ApiParam({ name: 'planIdOrKey', description: 'Plan UUID or plan key' })
  @ApiResponse({ status: 200, description: 'Accessible plan returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Plan not found or not accessible' })
  async getMyPlan(
    @CurrentUser() user: RequestUser,
    @Param('planIdOrKey') planIdOrKey: string,
  ) {
    return this.plansMineService.getMyPlan(user, planIdOrKey);
  }
}
