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
import { DeleteTestCaseQueryDto } from '../dto/test-case.dto';
import {
  BulkArchiveTestExecutionsDto,
  BulkDeleteTestExecutionsDto,
  CreateTestExecutionDto,
  ExecutionTicketsQueryDto,
  ListTestExecutionsQueryDto,
  RunNowDto,
  UpdateTestExecutionDto,
} from '../dto/test-execution.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestExecutionsService } from './test-executions.service';

/** `:spaceId`, `:executionId` and `:caseId`, never `:id`: SpacePermissionsGuard falls back to `params.id` as the space id. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management')
export class TestExecutionsController {
  constructor(private readonly service: TestExecutionsService) {}

  // Declared before executions/:executionId so the literal path is not read as an id.
  @Get('executions/environments')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary: 'Environments already used in this space (suggestions)',
  })
  environments(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.environments(user.organizationId, spaceId);
  }

  @Get('executions/tickets-without-execution')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary: 'Test execution tickets of this space that have no execution yet',
  })
  ticketsWithoutExecution(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: ExecutionTicketsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.ticketsWithoutExecution(
      user.organizationId,
      spaceId,
      query,
    );
  }

  @Get('executions')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'List test executions (active or archived)' })
  list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: ListTestExecutionsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(user.organizationId, spaceId, query);
  }

  @Post('executions')
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({
    summary:
      'Create a test execution from a plan, a set or selected cases; a resend returns it (200)',
  })
  async create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateTestExecutionDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.create(user, spaceId, dto);

    if (result.replayed) res.status(HttpStatus.OK);

    return result;
  }

  @Get('executions/:executionId')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'A test execution with its run status counts' })
  get(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.get(user.organizationId, spaceId, executionId);
  }

  @Get('executions/:executionId/summary')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary: 'Progress, success rate, testers and minutes of an execution',
  })
  summary(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.summary(user.organizationId, spaceId, executionId);
  }

  @Patch('executions/:executionId')
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({
    summary:
      'Change the name, description, environment or folder of an execution',
  })
  update(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @Body() dto: UpdateTestExecutionDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.update(user, spaceId, executionId, dto);
  }

  @Post('executions/bulk')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({
    summary:
      'Archive or restore several test executions at once; executions already in that state or gone come back as skipped',
  })
  bulkArchive(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: BulkArchiveTestExecutionsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.bulkArchive(user, spaceId, dto);
  }

  @Post('executions/:executionId/archive')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({
    summary: 'Archive a test execution (read-only until restored)',
  })
  archive(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.setArchived(user, spaceId, executionId, true);
  }

  @Post('executions/:executionId/restore')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({ summary: 'Restore an archived test execution' })
  restore(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.setArchived(user, spaceId, executionId, false);
  }

  @Post('executions/bulk-delete')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('delete_tests')
  @ApiOperation({
    summary:
      'Delete up to 100 test executions at once; executions that have been run or are gone come back as skipped',
  })
  bulkRemove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: BulkDeleteTestExecutionsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.bulkRemove(user, spaceId, dto);
  }

  @Delete('executions/:executionId')
  @RequireSpacePermission('delete_tests')
  @ApiOperation({
    summary:
      'Delete a never-run test execution and its ticket; ?dryRun=true previews the counts',
  })
  remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @Query() query: DeleteTestCaseQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.remove(
      user,
      spaceId,
      executionId,
      query.dryRun === true,
    );
  }

  @Post('cases/:caseId/run-now')
  @RequireSpacePermission('execute_tests')
  @ApiOperation({
    summary:
      'Run one test case now, assigned to the caller; a resend returns it (200)',
  })
  async runNow(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: RunNowDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.runNow(user, spaceId, caseId, dto);

    if (result.replayed) res.status(HttpStatus.OK);

    return result;
  }
}
