import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { contentDispositionAttachment } from '../../common/content-disposition';
import {
  TEST_REPORT_ROUTES,
  TestReportExportQueryDto,
  TestReportQueryDto,
  type TestReportRoute,
} from '../dto/test-report.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestReportsService } from './test-reports.service';

const reportPipe = new ParseEnumPipe(
  Object.fromEntries(TEST_REPORT_ROUTES.map((route) => [route, route])),
);

// PDF exports share one browser pool across the deployment.
const EXPORT_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

/** `:spaceId` and `:report`, never `:id`: SpacePermissionsGuard falls back to `params.id` as the space id. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management')
export class TestReportsController {
  constructor(private readonly reports: TestReportsService) {}

  @Get('reports/:report')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'One report of the space' })
  getReport(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('report', reportPipe) report: TestReportRoute,
    @Query() query: TestReportQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.reports.report(user, spaceId, report, query);
  }

  @Get('reports/:report/export')
  @RequireSpacePermission('view_tests')
  @Throttle(EXPORT_THROTTLE)
  @ApiOperation({
    summary: 'Report as CSV or PDF (at most 10,000 rows)',
  })
  async exportReport(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('report', reportPipe) report: TestReportRoute,
    @Query() query: TestReportExportQueryDto,
    @CurrentUser() user: RequestUser,
    @Res() res: Response,
  ): Promise<void> {
    // The whole file is built before any header is sent, so a failure is a normal error response.
    const file = await this.reports.exportReport(user, spaceId, report, query);

    res.status(HttpStatus.OK);
    res.set({
      'Content-Type': file.contentType,
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': contentDispositionAttachment(file.fileName),
      'Content-Length': String(file.body.length),
    });
    res.send(file.body);
  }
}
