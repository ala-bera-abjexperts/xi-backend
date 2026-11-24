import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import {
  CreateDefectDto,
  LinkDefectDto,
  TaskDefectsQueryDto,
} from '../dto/test-defect.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestDefectsService } from './test-defects.service';

/** `:spaceId`, `:runId` and `:taskId`, never `:id`: SpacePermissionsGuard falls back to `params.id` as the space id. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management')
export class TestDefectsController {
  constructor(private readonly service: TestDefectsService) {}

  @Get('tasks/:taskId/defects')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary:
      'Test runs of this space that list the ticket as a defect (max 500)',
  })
  listForTask(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @CurrentUser() user: RequestUser,
    @Query() query: TaskDefectsQueryDto,
  ) {
    return this.service.listForTask(user, spaceId, taskId, query);
  }

  @Post('runs/:runId/defects')
  @RequireSpacePermission('execute_tests')
  @ApiOperation({
    summary:
      'Link an existing ticket to a run; an existing link returns it (200)',
  })
  async link(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() dto: LinkDefectDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.link(user, spaceId, runId, dto);

    if (result.replayed) res.status(HttpStatus.OK);

    return result.body;
  }

  @Post('runs/:runId/defects/create')
  @RequireSpacePermission('execute_tests')
  @ApiOperation({
    summary:
      "Create a ticket in the run's space and link it; a resend returns it (200)",
  })
  async create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() dto: CreateDefectDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.create(user, spaceId, runId, dto);

    if (result.replayed) res.status(HttpStatus.OK);

    return result.body;
  }

  @Delete('runs/:runId/defects/:taskId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireSpacePermission('execute_tests')
  @ApiOperation({ summary: 'Unlink a ticket from a run' })
  unlink(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.unlink(user, spaceId, runId, taskId);
  }
}
