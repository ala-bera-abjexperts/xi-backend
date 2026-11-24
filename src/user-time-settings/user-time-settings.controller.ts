import { Controller, Get, Put, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserTimeSettingsService } from './user-time-settings.service';
import { UpsertUserTimeSettingsDto } from './dto/upsert-user-time-settings.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

@ApiTags('User Time Settings')
@ApiBearerAuth()
@Controller('user-time-settings')
export class UserTimeSettingsController {
  constructor(private readonly service: UserTimeSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get current user time reminder settings' })
  async getSettings(@CurrentUser() user: RequestUser) {
    const data = await this.service.getSettings(user.userId);
    return { data };
  }

  @Put()
  @ApiOperation({
    summary: 'Create or update current user time reminder settings',
  })
  async upsertSettings(
    @CurrentUser() user: RequestUser,
    @Body() body: UpsertUserTimeSettingsDto,
  ) {
    const data = await this.service.upsertSettings(
      user.userId,
      user.organizationId,
      body,
    );
    return { data };
  }
}
