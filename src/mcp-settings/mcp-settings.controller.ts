import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireRoles } from '../auth/decorators/require-roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { RevokeGrantDto } from './dto/revoke-grant.dto';
import { UpdateMcpSettingsDto } from './dto/update-mcp-settings.dto';
import { UpdateMcpToolDto } from './dto/update-mcp-tool.dto';
import { McpSettingsService } from './mcp-settings.service';

/**
 * Tenant MCP governance API. Owner/admin only (RolesGuard at the class level);
 * the org is always the caller's active org (`RequestUser.organizationId`),
 * never a request parameter — cross-tenant-safe by construction.
 */
@ApiTags('MCP Settings')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@RequireRoles('owner', 'admin')
@Controller('mcp-settings')
export class McpSettingsController {
  constructor(private readonly service: McpSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get MCP settings + the tool catalog for the org' })
  @ApiResponse({ status: 200, description: 'Settings and tool catalog.' })
  getSettings(@CurrentUser() user: RequestUser) {
    return this.service.getSettings(user.organizationId);
  }

  @Patch()
  @ApiOperation({ summary: 'Update MCP master toggles (enable / write tools)' })
  @ApiResponse({ status: 200, description: 'Updated settings.' })
  @ApiResponse({ status: 403, description: 'Owner/admin only.' })
  updateSettings(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateMcpSettingsDto,
  ) {
    return this.service.updateSettings(user.organizationId, user.userId, {
      is_enabled: dto.is_enabled,
      allow_write_tools: dto.allow_write_tools,
    });
  }

  @Patch('tools/:toolName')
  @ApiOperation({
    summary: 'Enable/disable a single tool (per-tool allow-list)',
  })
  @ApiParam({ name: 'toolName', example: 'task.search' })
  @ApiResponse({ status: 200, description: 'Updated settings.' })
  @ApiResponse({ status: 400, description: 'Unknown tool name.' })
  setToolEnabled(
    @CurrentUser() user: RequestUser,
    @Param('toolName') toolName: string,
    @Body() dto: UpdateMcpToolDto,
  ) {
    return this.service.setToolEnabled(
      user.organizationId,
      user.userId,
      toolName,
      dto.enabled,
    );
  }

  @Get('grants')
  @ApiOperation({
    summary: 'List active connected clients (grants) for the org',
  })
  @ApiResponse({ status: 200, description: 'Active grants.' })
  listGrants(@CurrentUser() user: RequestUser) {
    return this.service.listGrants(user.userId, user.organizationId);
  }

  @Post('grants/:grantId/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a connected client grant' })
  @ApiParam({ name: 'grantId' })
  @ApiResponse({ status: 200, description: 'Grant revoked.' })
  @ApiResponse({ status: 404, description: 'Grant not found in this org.' })
  revokeGrant(
    @CurrentUser() user: RequestUser,
    @Param('grantId') grantId: string,
    @Body() dto: RevokeGrantDto,
  ) {
    return this.service.revokeGrant(
      user.organizationId,
      user.userId,
      grantId,
      dto.reason ?? null,
    );
  }

  @Get('audit')
  @ApiOperation({ summary: 'Recent MCP tool-usage audit slice for the org' })
  @ApiResponse({ status: 200, description: 'Recent tool invocations.' })
  listAudit(@CurrentUser() user: RequestUser, @Query('limit') limit?: string) {
    const parsed = limit ? parseInt(limit, 10) : undefined;
    return this.service.listAudit(
      user.userId,
      user.organizationId,
      Number.isNaN(parsed) ? undefined : parsed,
    );
  }
}
