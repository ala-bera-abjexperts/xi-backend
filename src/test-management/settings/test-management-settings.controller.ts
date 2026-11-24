import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import {
  TestManagementSettingsResponseDto,
  UpdateTestManagementSettingsDto,
} from '../dto/test-management-settings.dto';
import { TestStatusResponseDto } from '../dto/test-status.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestManagementSettingsService } from './test-management-settings.service';

/**
 * The space param is `:spaceId`, never `:id`: SpacePermissionsGuard falls back to `params.id` as
 * the space id. Every handler needs @RequireSpacePermission (the guard allows a handler without it).
 */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management')
export class TestManagementSettingsController {
  constructor(private readonly service: TestManagementSettingsService) {}

  @Get('settings')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Test Management settings of a space' })
  @ApiOkResponse({ type: TestManagementSettingsResponseDto })
  getSettings(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.getSettings(user.organizationId, spaceId);
  }

  @Put('settings')
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({ summary: 'Update Test Management settings of a space' })
  @ApiOkResponse({ type: TestManagementSettingsResponseDto })
  updateSettings(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: UpdateTestManagementSettingsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.updateSettings(user, spaceId, dto);
  }

  @Get('statuses')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Run and step statuses' })
  @ApiOkResponse({ type: [TestStatusResponseDto] })
  listStatuses(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listStatuses(user.organizationId, spaceId);
  }
}
