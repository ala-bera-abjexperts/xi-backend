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
  Put,
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
  BulkDeleteTestCasesDto,
  BulkTestCasesDto,
  CreateTestCaseDto,
  DeleteTestCaseQueryDto,
  ListTestCasesQueryDto,
  SaveTestStepsDto,
  SetCaseAssigneeDto,
  TestCaseHistoryQueryDto,
  UpdateTestCaseDto,
} from '../dto/test-case.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestCasesService } from './test-cases.service';

/** `:spaceId` and `:caseId`, never `:id`: SpacePermissionsGuard falls back to `params.id` as the space id. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management/cases')
export class TestCasesController {
  constructor(private readonly service: TestCasesService) {}

  @Get()
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'List test cases (active or archived), by key' })
  list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: ListTestCasesQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(user.organizationId, spaceId, query);
  }

  @Post()
  @RequireSpacePermission('create_tests')
  @ApiOperation({ summary: 'Create a test case' })
  create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateTestCaseDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.create(user, spaceId, dto);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({
    summary: 'Move, archive or restore up to 500 test cases at once',
  })
  bulk(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: BulkTestCasesDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.bulk(user, spaceId, dto);
  }

  @Post('bulk-delete')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('delete_tests')
  @ApiOperation({
    summary:
      'Delete up to 100 never-run test cases at once; cases with runs or already gone come back as skipped',
  })
  bulkRemove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: BulkDeleteTestCasesDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.bulkRemove(user, spaceId, dto);
  }

  @Get('eligible-testers')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Users who can be assigned to a test case' })
  eligibleTesters(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.eligibleTesters(user.organizationId, spaceId);
  }

  @Put(':caseId/assignee')
  @RequireSpacePermission('edit_tests')
  @ApiOperation({
    summary:
      'Set the assignee; also updates open plan tests and not-started runs',
  })
  setAssignee(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: SetCaseAssigneeDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.setAssignee(user, spaceId, caseId, dto.assignee_id);
  }

  @Get(':caseId')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'A test case with its steps' })
  get(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.get(user.organizationId, spaceId, caseId);
  }

  @Patch(':caseId')
  @RequireSpacePermission('edit_tests')
  @ApiOperation({ summary: 'Update a test case (needs expected_revision)' })
  update(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: UpdateTestCaseDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.update(user, spaceId, caseId, dto);
  }

  @Put(':caseId/steps')
  @RequireSpacePermission('edit_tests')
  @ApiOperation({ summary: 'Replace the steps (ids keep existing steps)' })
  saveSteps(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: SaveTestStepsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.saveSteps(user, spaceId, caseId, dto);
  }

  @Post(':caseId/archive')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({ summary: 'Archive a test case' })
  archive(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.setArchived(user, spaceId, caseId, true);
  }

  @Post(':caseId/restore')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({ summary: 'Restore an archived test case' })
  restore(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.setArchived(user, spaceId, caseId, false);
  }

  @Delete(':caseId')
  @RequireSpacePermission('delete_tests')
  @ApiOperation({
    summary: 'Delete a never-run test case; ?dryRun=true previews the counts',
  })
  remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Query() query: DeleteTestCaseQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.remove(user, spaceId, caseId, query.dryRun === true);
  }

  @Get(':caseId/history')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Change history of a test case, newest first' })
  history(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Query() query: TestCaseHistoryQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.history(
      user.organizationId,
      spaceId,
      caseId,
      query.before,
    );
  }
}
