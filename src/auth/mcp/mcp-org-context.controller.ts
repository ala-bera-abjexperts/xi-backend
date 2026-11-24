// Minimal controller exposing the backend reads the MCP org.current/org.list
// tools need. Authenticated by the global S2S-aware SupabaseAuthGuard only;
// membership is sufficient, so there's no @RequirePermissions / @RequireFeature
// on these routes. The organization is resolved from the authenticated user's
// request context (set by the S2S guard from the grant claim), never from a
// request argument.

import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../decorators/current-user.decorator';
import type { RequestUser } from '../interfaces/request-user.interface';
import {
  McpOrgContextService,
  type McpOrgContext,
} from './mcp-org-context.service';
import {
  McpOrgMembershipsService,
  type McpOrgMembership,
} from './mcp-org-memberships.service';

@ApiTags('auth')
@Controller('auth/mcp')
export class McpOrgContextController {
  constructor(
    private readonly orgContextService: McpOrgContextService,
    private readonly orgMembershipsService: McpOrgMembershipsService,
  ) {}

  // Returns the caller's minimal org context for the MCP org.current tool:
  // { organization: { id, slug, name }, role, modules[] }. The org comes from
  // the authenticated user, never a param.
  @Get('org-context')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Minimal org context for the MCP org.current tool',
    description:
      'Returns only { organization: { id, slug, name }, role, modules[] } for ' +
      "the caller's active organization. No billing, license, or member-list " +
      'fields. Organization is resolved from the authenticated request context.',
  })
  @ApiResponse({ status: 200, description: 'Minimal org context' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getOrgContext(
    @CurrentUser() user: RequestUser,
  ): Promise<McpOrgContext> {
    return this.orgContextService.getOrgContext(user);
  }

  // Returns the caller's whitelisted org-membership list for the MCP org.list
  // tool: { data: [{ id, slug, name, role }] }. The membership set comes from the
  // authenticated request context (never a param); deactivated orgs are dropped.
  // The global response interceptor adds the outer envelope.
  @Get('org-memberships')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Whitelisted org-membership list for the MCP org.list tool',
    description:
      'Returns { data: [{ id, slug, name, role }] } for every active ' +
      'organization the caller belongs to. Deactivated orgs are dropped. No ' +
      'billing/license/member fields. Memberships come from the authenticated ' +
      'request context, never a param.',
  })
  @ApiResponse({ status: 200, description: 'Whitelisted org-membership list' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getOrgMemberships(
    @CurrentUser() user: RequestUser,
  ): Promise<{ data: McpOrgMembership[] }> {
    const data = await this.orgMembershipsService.listOrgMemberships(user);

    return { data };
  }
}
