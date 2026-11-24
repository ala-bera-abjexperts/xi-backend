import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { AttemptHistoryQueryDto } from '../dto/test-history.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestHistoryService } from './test-history.service';

/** `:spaceId`, `:runId` and `:attemptId`, never `:id`: SpacePermissionsGuard falls back to `params.id` as the space id. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management')
export class TestHistoryController {
  constructor(private readonly service: TestHistoryService) {}

  @Get('runs/:runId/attempts')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary: 'Attempts of a run, newest first, with step counts',
  })
  listAttempts(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Query() query: AttemptHistoryQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listAttempts(
      user.organizationId,
      spaceId,
      runId,
      query,
    );
  }

  @Get('attempts/:attemptId')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary: 'One attempt (current or earlier) with its snapshot and results',
  })
  getAttempt(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.getAttempt(user.organizationId, spaceId, attemptId);
  }
}
