import { Controller, Get, Put, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OrgTimeSettingsService } from './org-time-settings.service';
import { UpsertOrgTimeSettingsDto } from './dto/upsert-org-time-settings.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireRoles } from '../auth/decorators/require-roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

@ApiTags('Org Time Settings')
@ApiBearerAuth()
@Controller('org-time-settings')
export class OrgTimeSettingsController {
  constructor(private readonly service: OrgTimeSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get org time reminder settings' })
  async getSettings(@CurrentUser() user: RequestUser) {
    const data = await this.service.getSettings(user.organizationId);
    return { data };
  }

  @Put()
  @UseGuards(RolesGuard)
  @RequireRoles('admin', 'owner')
  @ApiOperation({
    summary: 'Create or update org time reminder settings (admin/owner)',
  })
  async upsertSettings(
    @CurrentUser() user: RequestUser,
    @Body() body: UpsertOrgTimeSettingsDto,
  ) {
    const data = await this.service.upsertSettings(
      user.organizationId,
      user.userId,
      body,
    );
    return { data, success: true };
  }
}
