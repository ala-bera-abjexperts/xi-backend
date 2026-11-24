/**
 * @fileoverview REST controller for `/audit-logs` — organization-scoped audit trail.
 * @module src/audit-logs/audit-logs.controller
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AuditLogsService } from './audit-logs.service';
import { CreateAuditLogDto } from './dto/create-audit-log.dto';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';

@ApiTags('Audit Logs')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly service: AuditLogsService) {}

  /**
   * GET /audit-logs/recent
   * Returns the most recent activity entries (flat array, no pagination wrapper).
   * Must be declared BEFORE GET /audit-logs to avoid route conflicts.
   */
  @Get('recent')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_history')
  @ApiOperation({ summary: 'Get recent organization activity (flat array)' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max records (1–100, default 20)',
  })
  async recent(
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    const parsedLimit = Math.min(
      Math.max(parseInt(limit ?? '20', 10) || 20, 1),
      100,
    );
    return this.service.getRecentActivity(user.organizationId, parsedLimit);
  }

  /**
   * GET /audit-logs/statistics
   * Returns aggregate counts grouped by action, entity type, and user.
   */
  @Get('statistics')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_history')
  @ApiOperation({ summary: 'Get audit log statistics for the organization' })
  @ApiQuery({ name: 'start_date', required: false })
  @ApiQuery({ name: 'end_date', required: false })
  async statistics(
    @CurrentUser() user: RequestUser,
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
  ): Promise<unknown> {
    return this.service.getAuditStatistics(
      user.organizationId,
      startDate,
      endDate,
    );
  }

  /**
   * GET /audit-logs
   * Paginated list of audit log entries with optional filters.
   * Response shape: { data[], total, page, pageSize, hasMore }
   */
  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_history')
  @ApiOperation({ summary: 'List audit logs with filters and pagination' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query() query: ListAuditLogsQueryDto,
  ): Promise<unknown> {
    return this.service.getLogs(user.organizationId, query);
  }

  /**
   * POST /audit-logs
   * Create an audit log entry. organization_id and user_id are taken from JWT.
   */
  @Post()
  @HttpCode(201)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_history')
  @ApiOperation({ summary: 'Create an audit log entry' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateAuditLogDto,
  ): Promise<{ message: string }> {
    await this.service.createLog(user.organizationId, user.userId, dto);
    return { message: 'Audit log created' };
  }
}
