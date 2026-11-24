/**
 * @fileoverview REST + SSE API for the in-product On-Prem Update system. Only
 * reachable on a self-hosted stack (the whole module is omitted in SaaS) and only
 * by org owners/admins. Every route is double-gated (OnPremGuard + RolesGuard) and
 * impersonation is blocked. Actions are a fixed allow-list — no arbitrary input
 * reaches the deploy scripts; the controller merely proxies to the sidecar.
 * @module src/on-prem-updates/on-prem-updates.controller
 */
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { type Observable } from 'rxjs';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireRoles } from '../auth/decorators/require-roles.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { OnPremGuard } from './guards/on-prem.guard';
import { OnPremUpdatesService } from './on-prem-updates.service';

@ApiTags('On-Prem Updates')
@ApiBearerAuth()
@UseGuards(OnPremGuard, RolesGuard)
@RequireRoles('owner', 'admin')
@ImpersonationBlocked()
@Controller('system-updates')
export class OnPremUpdatesController {
  constructor(
    private readonly service: OnPremUpdatesService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  @Get('status')
  @ApiOperation({
    summary: 'Current update status, versions, backup + rollback state',
  })
  getStatus() {
    return this.service.getStatus();
  }

  @Get('logs')
  @ApiOperation({
    summary: 'Fetch job log from a byte offset (for refresh-safe resume)',
  })
  @ApiQuery({ name: 'since', required: false, type: Number })
  getLogs(@Query('since') since?: string) {
    return this.service.getLogs(Math.max(0, parseInt(since ?? '0', 10) || 0));
  }

  @Post('check')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Check whether a newer release is available' })
  check() {
    // Read-only probe — not audit-logged (apply/revert are).
    return this.service.check();
  }

  @Post('apply')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Apply the available update (transactional, auto-rollback on failure)',
  })
  async apply(@CurrentUser() user: RequestUser) {
    const result = await this.service.apply();
    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'system_update',
      'apply',
      'update',
      { accepted: result.accepted },
    );
    return result;
  }

  @Post('reinstall')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Reinstall the currently running release (transactional, auto-rollback on failure)',
  })
  async reinstall(@CurrentUser() user: RequestUser) {
    const result = await this.service.reinstall();
    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'system_update',
      'reinstall',
      'update',
      { accepted: result.accepted },
    );
    return result;
  }

  @Post('revert')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Revert the last update to the previous version' })
  async revert(@CurrentUser() user: RequestUser) {
    const result = await this.service.revert();
    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'system_update',
      'revert',
      'update',
      { accepted: result.accepted },
    );
    return result;
  }

  @Post('restore-db')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Restore the pre-update database backup (only after a failed update left the schema ahead of the code)',
  })
  @ApiQuery({
    name: 'confirm',
    required: true,
    type: String,
    description:
      'The exact filename of the backup shown in the status payload. Acts as a confirmation, not a selector.',
  })
  async restoreDb(
    @CurrentUser() user: RequestUser,
    @Query('confirm') confirm?: string,
  ) {
    const result = await this.service.restoreDb(confirm ?? '');
    // Audit-logged like apply/revert — this destroys data written since the backup, so it must
    // always be attributable to a named person.
    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'system_update',
      'restore_db',
      'update',
      { accepted: result.accepted, backup: confirm ?? '' },
    );
    return result;
  }

  @Sse('stream')
  @ApiOperation({
    summary: 'Live status + log stream (SSE) for the running job',
  })
  @ApiQuery({ name: 'since', required: false, type: Number })
  stream(@Query('since') since?: string): Observable<{ data: unknown }> {
    return this.service.stream(Math.max(0, parseInt(since ?? '0', 10) || 0));
  }
}
