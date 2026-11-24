import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import {
  NewAttemptDto,
  SetAttemptStatusDto,
  SetPreconditionResultDto,
  SetStepResultDto,
  UpdateAttemptDto,
} from '../dto/test-execution.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestResultsService } from './test-results.service';

/** Testers record steps in quick bursts, well above the global 100/min. */
const BURST_THROTTLE = { default: { limit: 300, ttl: 60_000 } };

/** `:spaceId`, `:attemptId`, `:snapshotStepId` and `:runId`, never `:id`: SpacePermissionsGuard falls back to `params.id` as the space id. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management')
export class TestResultsController {
  constructor(private readonly service: TestResultsService) {}

  @Get('attempts/:attemptId/preconditions/results')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Results of the preconditions of one attempt' })
  preconditionResults(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.preconditionResults(
      user.organizationId,
      spaceId,
      attemptId,
    );
  }

  @Put('attempts/:attemptId/preconditions/:preconditionId/result')
  @Throttle(BURST_THROTTLE)
  @RequireSpacePermission('execute_tests')
  @ApiOperation({
    summary:
      'Record the result of one precondition (expected_status guards against overwriting someone else)',
  })
  submitPreconditionResult(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @Param('preconditionId', ParseUUIDPipe) preconditionId: string,
    @Body() dto: SetPreconditionResultDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.submitPreconditionResult(
      user,
      spaceId,
      attemptId,
      preconditionId,
      dto,
    );
  }

  @Put('attempts/:attemptId/steps/:snapshotStepId/result')
  @Throttle(BURST_THROTTLE)
  @RequireSpacePermission('execute_tests')
  @ApiOperation({
    summary:
      'Record the result of one step (expected_status guards against overwriting someone else)',
  })
  submitStepResult(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @Param('snapshotStepId', ParseUUIDPipe) snapshotStepId: string,
    @Body() dto: SetStepResultDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.submitStepResult(
      user,
      spaceId,
      attemptId,
      snapshotStepId,
      dto,
    );
  }

  @Patch('attempts/:attemptId')
  @RequireSpacePermission('execute_tests')
  @ApiOperation({ summary: 'Change the comment or actual time of an attempt' })
  updateAttempt(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @Body() dto: UpdateAttemptDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.updateAttempt(user, spaceId, attemptId, dto);
  }

  // Override and abort need manage_test_runs, a manual status execute_tests; both checked in the service.
  @Post('attempts/:attemptId/status')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary: 'Override, abort, or set the status of a case without steps',
  })
  setStatus(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @Body() dto: SetAttemptStatusDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.setStatus(user, spaceId, attemptId, dto);
  }

  @Post('runs/:runId/attempts')
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({
    summary:
      'Start a new attempt: reset (all TODO) or merge (keep unchanged steps)',
  })
  startAttempt(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() dto: NewAttemptDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.startAttempt(user, spaceId, runId, dto);
  }
}
