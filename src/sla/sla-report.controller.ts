import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SlaReportService } from './sla-report.service';
@Controller('sla/reports')
export class SlaReportController {
  constructor(private readonly reports: SlaReportService) {}
  @Get('options/:spaceId')
  options(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.reports.options(user, spaceId);
  }
}
