import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestManagementSettingsService } from './test-management-settings.service';

/**
 * No licence or space-permission gate, like reading the task hierarchy itself: the Task tab hides these
 * types while the module or the licence is off. Only ids of the caller's organization are returned.
 */
@ApiTags('test-management')
@ApiBearerAuth()
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management/task-type-ids')
export class TestManagementTaskTypesController {
  constructor(private readonly service: TestManagementSettingsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Task type ids Test Management uses in a space, also while the module is off',
  })
  @ApiOkResponse({ type: [String] })
  list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.mappedTaskTypeIds(user.organizationId, spaceId);
  }
}
