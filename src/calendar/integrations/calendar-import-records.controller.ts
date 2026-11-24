import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { CalendarsService } from '../calendars.service';
import { ListImportRecordsDto } from '../dto/list-import-records.dto';
import { CalendarImportRecordsService } from './calendar-import-records.service';

// No CalendarResponseInterceptor: the service checks this page shape itself.
@RequireFeature('module_calendar')
@ApiTags('calendar-integrations')
@ApiBearerAuth()
@Controller('calendar/integrations')
export class CalendarImportRecordsController {
  constructor(
    private readonly records: CalendarImportRecordsService,
    private readonly calendars: CalendarsService,
  ) {}

  @Get('records')
  @ApiOperation({
    summary: 'Entries brought in from connected calendars the caller may read',
  })
  @ApiResponse({
    status: 200,
    description: 'One page of imported entries, newest change first',
  })
  async list(
    @CurrentUser() user: RequestUser,
    @Query() query: ListImportRecordsDto,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.records.list(user.userId, user.organizationId, query);
  }
}
