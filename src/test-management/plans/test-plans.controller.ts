import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
  AddPlanTestsDto,
  BulkArchiveTestPlansDto,
  BulkDeleteTestPlansDto,
  CreateTestPlanDto,
  ListTestPlansQueryDto,
  RemovePlanTestsDto,
  RunHistoryQueryDto,
  SetPlannedTesterDto,
  TestPlanTestsQueryDto,
  UpdateTestPlanDto,
} from '../dto/test-plan.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestPlanTestsService } from './test-plan-tests.service';
import { TestPlansService } from './test-plans.service';

/** `:spaceId` and `:planId`, never `:id`: SpacePermissionsGuard falls back to `params.id` as the space id. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management/plans')
export class TestPlansController {
  constructor(
    private readonly service: TestPlansService,
    private readonly tests: TestPlanTestsService,
  ) {}

  @Get()
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'List test plans (active or archived)' })
  list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: ListTestPlansQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(user.organizationId, spaceId, query);
  }

  @Post()
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({ summary: 'Create a test plan' })
  create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateTestPlanDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.create(user, spaceId, dto);
  }

  @Get(':planId')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'A test plan with its test and execution counts' })
  get(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.get(user.organizationId, spaceId, planId);
  }

  @Patch(':planId')
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({ summary: 'Change the name, description or dates of a plan' })
  update(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: UpdateTestPlanDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.update(user, spaceId, planId, dto);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({
    summary:
      'Archive or restore several test plans at once; plans already in that state or gone come back as skipped',
  })
  bulkArchive(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: BulkArchiveTestPlansDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.bulkArchive(user, spaceId, dto);
  }

  @Post(':planId/archive')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({ summary: 'Archive a test plan' })
  archive(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.setArchived(user, spaceId, planId, true);
  }

  @Post(':planId/restore')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({ summary: 'Restore an archived test plan' })
  restore(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.setArchived(user, spaceId, planId, false);
  }

  @Post('bulk-delete')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('delete_tests')
  @ApiOperation({
    summary:
      'Delete up to 100 test plans at once; plans that have been run or are gone come back as skipped',
  })
  bulkRemove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: BulkDeleteTestPlansDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.bulkRemove(user, spaceId, dto);
  }

  @Delete(':planId')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('delete_tests')
  @ApiOperation({
    summary: 'Delete a test plan; its executions stay as ad hoc ones',
  })
  remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.remove(user, spaceId, planId);
  }

  @Get(':planId/tests')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Tests in a plan with their planned testers' })
  listTests(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Query() query: TestPlanTestsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    // "me" becomes the caller, as the automation runs list does it.
    const tester = query.tester === 'me' ? user.userId : query.tester;

    return this.tests.tests(user.organizationId, spaceId, planId, {
      ...query,
      tester,
    });
  }

  @Get(':planId/test-ids')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Ids of all test cases in a plan' })
  testIds(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.tests.testIds(user.organizationId, spaceId, planId);
  }

  @Get(':planId/eligible-testers')
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({ summary: 'Users who can be named as planned testers' })
  eligibleTesters(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.tests.eligibleTesters(user.organizationId, spaceId, planId);
  }

  @Post(':planId/tests')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({ summary: 'Add tests from cases, a set or a folder' })
  addTests(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: AddPlanTestsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.tests.add(user, spaceId, planId, dto);
  }

  @Post(':planId/tests/remove')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({ summary: 'Remove tests from a plan' })
  removeTests(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: RemovePlanTestsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.tests.remove(user, spaceId, planId, dto.case_ids);
  }

  @Patch(':planId/tests/:caseId')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({ summary: 'Set or clear the planned tester of a test' })
  setPlannedTester(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: SetPlannedTesterDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.tests.setPlannedTester(
      user,
      spaceId,
      planId,
      caseId,
      dto.planned_tester_id,
    );
  }

  @Get(':planId/progress')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Latest results of the tests in a plan' })
  progress(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.tests.progress(user.organizationId, spaceId, planId);
  }

  @Get(':planId/run-history')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Finished test runs of a plan by date' })
  runHistory(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Query() query: RunHistoryQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.tests.runHistory(
      user.organizationId,
      spaceId,
      planId,
      query.days ?? 30,
    );
  }
}
