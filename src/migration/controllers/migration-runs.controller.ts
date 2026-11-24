/**
 * @fileoverview REST + SSE controller for migration runs.
 *
 * Access control (defence in depth, mirroring the connections/jobs controllers):
 *   1. `@RequirePermissions('can_manage_migrations')` + `PermissionsGuard` — org-level permission.
 *   2. Per-request org-module toggle check (`assertModuleEnabled`) — revocation is immediate.
 * The SSE stream authenticates via cookies (`EventSource` with `withCredentials`),
 * exactly like the automation-runs stream — but unlike it, `streamRun` is org-scoped.
 */

import {
  Res,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { from, switchMap, type Observable } from 'rxjs';
import { contentDispositionAttachment } from '../../common/content-disposition';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import {
  MigrationRunsService,
  type RunStateSnapshot,
} from '../services/migration-runs.service';
import { DeleteTargetsDto } from '../dto/delete-targets.dto';
import { ReportItemsQueryDto, ReportQueryDto } from '../dto/report-query.dto';
import { StartRunDto, RepairRunDto } from '../dto/start-run.dto';
import { MigrationReportService } from '../services/migration-report.service';
import {
  ListRunsQueryDto,
  RunItemsQueryDto,
  RunLogsQueryDto,
} from '../dto/run-query.dto';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';

@RequireFeature('module_migration')
@ApiTags('Migration')
@ApiBearerAuth()
@Controller('migration')
@UseGuards(PermissionsGuard)
export class MigrationRunsController {
  constructor(
    private readonly runsService: MigrationRunsService,
    private readonly organizationModulesService: OrganizationModulesService,
    private readonly reportService: MigrationReportService,
  ) {}

  /** Throws 403 unless the Migration module is toggled on (checked per request). */
  private async assertModuleEnabled(organizationId: string): Promise<void> {
    const enabled = await this.organizationModulesService.isEnabled(
      organizationId,
      'migration',
    );

    if (!enabled) {
      throw new ForbiddenException(
        'The Migration module is disabled for this organization',
      );
    }
  }

  @Post('jobs/:jobId/runs')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({
    summary: 'Start a run for a saved job (defaults to dry-run)',
  })
  async start(
    @CurrentUser() user: RequestUser,
    @Param('jobId') jobId: string,
    @Body() dto: StartRunDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.runsService.start(
      user.organizationId,
      user.userId,
      jobId,
      dto.mode,
    );
  }

  @Post('jobs/:jobId/undo')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({
    summary:
      'Undo a migration: delete everything this job created (requires the job name as confirmation)',
  })
  async undo(
    @CurrentUser() user: RequestUser,
    @Param('jobId') jobId: string,
    @Body() dto: DeleteTargetsDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.runsService.deleteTargets(
      user.organizationId,
      jobId,
      dto.confirm_job_name,
    );
  }

  @Get('runs/:id/report')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({
    summary: 'Migration audit report for a run (json | csv | pdf)',
  })
  async report(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query() query: ReportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.assertModuleEnabled(user.organizationId);

    if (!query.format || query.format === 'json') {
      const report = await this.reportService.getReport(
        user.organizationId,
        id,
      );
      // @Res() is required for raw downloads, so mirror the global interceptor exactly here.
      res.status(HttpStatus.OK).json({
        statusCode: HttpStatus.OK,
        hasError: false,
        data: report,
        message: 'success',
      });

      return;
    }

    // Build the complete artifact before committing headers; render failures return a normal error,
    // never a truncated file that looks valid.
    const bundle = await this.reportService.getExport(user.organizationId, id);
    const body =
      query.format === 'pdf'
        ? await this.reportService.toPdf(bundle)
        : Buffer.from(this.reportService.toCsv(bundle), 'utf8');
    const extension = query.format;

    res.status(HttpStatus.OK);
    res.set({
      'Content-Type':
        extension === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8',
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': contentDispositionAttachment(
        `migration-run-${id}.${extension}`,
      ),
      'Content-Length': String(body.length),
    });
    res.send(body);
  }

  @Get('runs/:id/report/items')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'List sanitized audit rows for a migration report' })
  async reportItems(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query() query: ReportItemsQueryDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.reportService.listItems(user.organizationId, id, query);
  }

  @Get('runs')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'List runs (optionally for one job)' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query() query: ListRunsQueryDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.runsService.list(user.organizationId, query.job_id);
  }

  @Get('runs/:id')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'Get one run with live item counts' })
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.runsService.getState(user.organizationId, id);
  }

  @Get('runs/:id/items')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({
    summary: 'List a run’s work items (filterable by status/stage)',
  })
  async items(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query() query: RunItemsQueryDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.runsService.items(user.organizationId, id, query);
  }

  @Get('runs/:id/logs')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'List a run’s structured logs (newest first)' })
  async logs(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query() query: RunLogsQueryDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.runsService.logs(user.organizationId, id, query);
  }

  @Post('runs/:id/pause')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'Pause a running run (in-flight items finish)' })
  async pause(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.runsService.pause(user.organizationId, id);
  }

  @Post('runs/:id/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'Resume a paused run' })
  async resume(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.runsService.resume(user.organizationId, id);
  }

  @Post('runs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'Cancel a run; open items are skipped' })
  async cancel(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.runsService.cancel(user.organizationId, id);
  }

  @Post('runs/:id/retry-failed')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'Re-queue failed/dead items and reopen the run' })
  async retryFailed(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.runsService.retryFailed(user.organizationId, id);
  }

  @Post('runs/:id/repair')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({
    summary: 'Create a non-destructive repair run for a completed live import',
  })
  async repair(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: RepairRunDto) {
    await this.assertModuleEnabled(user.organizationId);

    return this.runsService.repair(user.organizationId, user.userId, id, dto?.scope);
  }

  @Sse('runs/:id/stream')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'Stream live run state via Server-Sent Events' })
  stream(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Observable<{ data: RunStateSnapshot }> {
    // @Sse handlers must return an Observable synchronously — the per-request
    // module check folds into the stream (a disabled module errors the stream).
    return from(this.assertModuleEnabled(user.organizationId)).pipe(
      switchMap(() => this.runsService.streamRun(user.organizationId, id)),
    );
  }
}
