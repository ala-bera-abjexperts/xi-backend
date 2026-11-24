import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import {
  ResourcePlanningReportExportQueryDto,
  ResourcePlanningReportQueryDto,
} from './dto/resource-planning-report-query.dto';
import { ResourcePlanningReportExportService } from './resource-planning-report-export.service';
import { ResourcePlanningReportService } from './resource-planning-report.service';

@RequireFeature('module_resource_planning')
@UseGuards(PermissionsGuard)
@RequirePermissions('can_view_resource_planning')
@ApiTags('Resource Planning')
@ApiBearerAuth()
@Controller('resource-planning/reports')
export class ResourcePlanningReportController {
  constructor(
    private readonly reportService: ResourcePlanningReportService,
    private readonly exportService: ResourcePlanningReportExportService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get planned-versus-actual resource reporting' })
  async getReport(
    @CurrentUser() user: RequestUser,
    @Query() query: ResourcePlanningReportQueryDto,
  ) {
    const data = await this.reportService.getReport(
      user.organizationId,
      query,
      user.userId,
    );
    return { data };
  }

  @Get('export')
  @ApiOperation({
    summary: 'Export the resource planning report as CSV or PDF',
  })
  async exportReport(
    @CurrentUser() user: RequestUser,
    @Query() query: ResourcePlanningReportExportQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const { format = 'csv', ...reportQuery } = query;
    const report = await this.reportService.getReport(
      user.organizationId,
      reportQuery,
      user.userId,
    );
    const payload =
      format === 'pdf'
        ? await this.exportService.toPdf(report)
        : this.exportService.toCsv(report);
    const extension = format === 'pdf' ? 'pdf' : 'csv';

    response.set({
      'Content-Type':
        format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="resource-planning-${report.range.from}-to-${report.range.to}.${extension}"`,
    });
    response.send(payload);
  }
}
