import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SlaConfigurationService } from './sla-configuration.service';
export class SetSlaEnabledDto {
  @IsUUID() expected_revision!: string;
}
export class SaveSlaMetricDto {
  @IsObject() config!: Record<string, unknown>;
  @IsOptional() @IsUUID() expected_revision?: string | null;
}
export class SaveSlaCalendarDto extends SaveSlaMetricDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
}
@Controller('sla')
export class SlaConfigurationController {
  constructor(private readonly configuration: SlaConfigurationService) {}
  @Get('spaces/:spaceId/calendars') calendars(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) id: string,
  ) {
    return this.configuration.calendars(user, id);
  }
  @Post('spaces/:spaceId/calendars') createCalendar(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) id: string,
    @Body() dto: SaveSlaCalendarDto,
  ) {
    return this.configuration.saveCalendar(user, id, null, dto);
  }
  @Put('calendars/:id') updateCalendar(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveSlaCalendarDto,
  ) {
    return this.configuration.saveCalendar(user, null, id, dto);
  }
  @Get('spaces/:spaceId/rule-fields') fields(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) id: string,
  ) {
    return this.configuration.ruleFields(user, id);
  }
  @Get('spaces/:spaceId/rule-options') options(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) id: string,
    @Query('field') field: string,
    @Query('search') search?: string,
    @Query('selected') selected?: string,
  ) {
    return this.configuration.ruleOptions(user, id, field, search, selected);
  }
  @Get('fields/:id') metric(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.configuration.getMetric(user, id);
  }
  @Put('fields/:id') saveMetric(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveSlaMetricDto,
  ) {
    return this.configuration.saveMetric(user, id, dto);
  }
  @Post('fields/:id/activate') activate(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetSlaEnabledDto,
  ) {
    return this.configuration.setEnabled(user, id, true, dto.expected_revision);
  }
  @Post('fields/:id/disable') disable(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetSlaEnabledDto,
  ) {
    return this.configuration.setEnabled(
      user,
      id,
      false,
      dto.expected_revision,
    );
  }
}
