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
  BulkArchiveTestPreconditionsDto,
  BulkDeleteTestPreconditionsDto,
  ChangePreconditionCasesDto,
  CreateTestPreconditionDto,
  ListTestPreconditionsQueryDto,
  PreconditionCasesQueryDto,
  SetCasePreconditionsDto,
  UnlinkTestsQueryDto,
  UpdateTestPreconditionDto,
} from '../dto/test-precondition.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestPreconditionsService } from './test-preconditions.service';

/** `:spaceId` and `:preconditionId`, never `:id`: SpacePermissionsGuard falls back to `params.id` as the space id. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management/preconditions')
export class TestPreconditionsController {
  constructor(private readonly service: TestPreconditionsService) {}

  @Get()
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'List preconditions (active or archived), by key' })
  list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: ListTestPreconditionsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(user.organizationId, spaceId, query);
  }

  @Post()
  @RequireSpacePermission('create_tests')
  @ApiOperation({ summary: 'Create a precondition' })
  create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateTestPreconditionDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.create(user, spaceId, dto);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({
    summary:
      'Archive or restore several preconditions at once; ones already in that state or gone come back as skipped',
  })
  bulkArchive(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: BulkArchiveTestPreconditionsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.bulkArchive(user, spaceId, dto);
  }

  @Post('bulk-delete')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('delete_tests')
  @ApiOperation({
    summary:
      'Delete up to 100 preconditions at once; ones used by test cases are skipped unless unlink_tests is true',
  })
  bulkRemove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: BulkDeleteTestPreconditionsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.bulkRemove(user, spaceId, dto);
  }

  @Put('cases/:caseId')
  @RequireSpacePermission('edit_tests')
  @ApiOperation({ summary: 'Set the preconditions a test case needs' })
  setCasePreconditions(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: SetCasePreconditionsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.setCasePreconditions(user, spaceId, caseId, dto);
  }

  @Get(':preconditionId')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'A precondition' })
  get(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('preconditionId', ParseUUIDPipe) preconditionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.get(user.organizationId, spaceId, preconditionId);
  }

  @Get(':preconditionId/cases')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'The test cases that use a precondition' })
  listCases(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('preconditionId', ParseUUIDPipe) preconditionId: string,
    @Query() query: PreconditionCasesQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listCases(
      user.organizationId,
      spaceId,
      preconditionId,
      query,
    );
  }

  @Get(':preconditionId/case-ids')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Ids of the test cases that use a precondition' })
  caseIds(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('preconditionId', ParseUUIDPipe) preconditionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.caseIds(user.organizationId, spaceId, preconditionId);
  }

  @Post(':preconditionId/cases')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({
    summary: 'Add a precondition to test cases and/or take it off them',
  })
  changeCases(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('preconditionId', ParseUUIDPipe) preconditionId: string,
    @Body() dto: ChangePreconditionCasesDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.changeCases(user, spaceId, preconditionId, dto);
  }

  @Patch(':preconditionId')
  @RequireSpacePermission('edit_tests')
  @ApiOperation({
    summary: 'Change the title, test type or definition of a precondition',
  })
  update(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('preconditionId', ParseUUIDPipe) preconditionId: string,
    @Body() dto: UpdateTestPreconditionDto,
    @Query() query: UnlinkTestsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.update(
      user,
      spaceId,
      preconditionId,
      dto,
      query.unlink_tests === true,
    );
  }

  @Post(':preconditionId/archive')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({ summary: 'Archive a precondition' })
  archive(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('preconditionId', ParseUUIDPipe) preconditionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.setArchived(user, spaceId, preconditionId, true);
  }

  @Post(':preconditionId/restore')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({ summary: 'Restore an archived precondition' })
  restore(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('preconditionId', ParseUUIDPipe) preconditionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.setArchived(user, spaceId, preconditionId, false);
  }

  @Delete(':preconditionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireSpacePermission('delete_tests')
  @ApiOperation({ summary: 'Delete a precondition' })
  remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('preconditionId', ParseUUIDPipe) preconditionId: string,
    @Query() query: UnlinkTestsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.remove(
      user,
      spaceId,
      preconditionId,
      query.unlink_tests === true,
    );
  }
}
