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
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import {
  AddableCasesQueryDto,
  AddRunsDto,
  AssignRunsDto,
  ListTestRunsQueryDto,
  RemoveRunsDto,
  RunEvidenceQueryDto,
} from '../dto/test-execution.dto';
import { TestSetPageQueryDto } from '../dto/test-set.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestRunEvidenceService } from './test-run-evidence.service';
import { TestRunsService } from './test-runs.service';

/** `:spaceId`, `:executionId` and `:runId`, never `:id`: SpacePermissionsGuard falls back to `params.id` as the space id. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management')
export class TestRunsController {
  constructor(
    private readonly service: TestRunsService,
    private readonly evidence: TestRunEvidenceService,
  ) {}

  @Get('executions/:executionId/evidence')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Evidence files of every attempt in an execution' })
  executionEvidence(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @Query() query: RunEvidenceQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.evidence.forExecution(user, spaceId, executionId, query);
  }

  @Get('cases/:caseId/evidence')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary:
      'Evidence files of every attempt of a test case, archived executions included',
  })
  caseEvidence(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Query() query: RunEvidenceQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.evidence.forCase(user, spaceId, caseId, query);
  }

  @Get('executions/:executionId/runs')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Runs of an execution with their current status' })
  list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @Query() query: ListTestRunsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(user, spaceId, executionId, query);
  }

  @Post('executions/:executionId/runs/assign')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({ summary: 'Assign (or unassign) up to 500 runs' })
  assign(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @Body() dto: AssignRunsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.assign(
      user,
      spaceId,
      executionId,
      dto.run_ids,
      dto.assignee_id,
    );
  }

  @Post('executions/:executionId/runs/add')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({
    summary:
      'Add test cases as new runs; already added, archived or deprecated ones are skipped',
  })
  addRuns(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @Body() dto: AddRunsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.addRuns(user, spaceId, executionId, dto.case_ids);
  }

  @Get('executions/:executionId/addable-cases')
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({
    summary: 'Active test cases that are not in this execution yet',
  })
  addableCases(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @Query() query: AddableCasesQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.addableCases(user, spaceId, executionId, query);
  }

  @Post('executions/:executionId/runs/remove')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({
    summary: 'Remove up to 500 runs; runs with results are skipped',
  })
  removeMany(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @Body() dto: RemoveRunsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.removeMany(user, spaceId, executionId, dto.run_ids);
  }

  @Post('runs/:runId/claim')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('execute_tests')
  @ApiOperation({ summary: 'Take an unassigned run' })
  claim(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.claim(user, spaceId, runId);
  }

  @Delete('runs/:runId')
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({ summary: 'Remove a run that has no results yet' })
  remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.remove(user, spaceId, runId);
  }

  @Get('cases/:caseId/runs')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Runs of a test case in active executions' })
  caseRuns(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Query() query: TestSetPageQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.caseRuns(user, spaceId, caseId, query);
  }

  @Get('runs/:runId')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary: 'A run with its current attempt, snapshot and step results',
  })
  get(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.get(user, spaceId, runId);
  }
}
