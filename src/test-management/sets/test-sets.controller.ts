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
  BulkArchiveTestSetsDto,
  BulkDeleteTestSetsDto,
  ChangeTestSetMembersDto,
  CreateTestSetDto,
  ListTestSetsQueryDto,
  TestSetMembersQueryDto,
  UpdateTestSetDto,
} from '../dto/test-set.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestSetsService } from './test-sets.service';

/** `:spaceId` and `:setId`, never `:id`: SpacePermissionsGuard falls back to `params.id` as the space id. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management/sets')
export class TestSetsController {
  constructor(private readonly service: TestSetsService) {}

  @Get()
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'List test sets (active or archived), by key' })
  list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: ListTestSetsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(user.organizationId, spaceId, query);
  }

  @Post()
  @RequireSpacePermission('create_tests')
  @ApiOperation({ summary: 'Create a test set' })
  create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateTestSetDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.create(user, spaceId, dto);
  }

  @Get(':setId')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'A test set with its member count' })
  get(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('setId', ParseUUIDPipe) setId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.get(user.organizationId, spaceId, setId);
  }

  @Patch(':setId')
  @RequireSpacePermission('edit_tests')
  @ApiOperation({ summary: 'Rename a test set or change its description' })
  update(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('setId', ParseUUIDPipe) setId: string,
    @Body() dto: UpdateTestSetDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.update(user, spaceId, setId, dto);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({
    summary:
      'Archive or restore several test sets at once; sets already in that state or gone come back as skipped',
  })
  bulkArchive(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: BulkArchiveTestSetsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.bulkArchive(user, spaceId, dto);
  }

  @Post(':setId/archive')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({ summary: 'Archive a test set' })
  archive(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('setId', ParseUUIDPipe) setId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.setArchived(user, spaceId, setId, true);
  }

  @Post(':setId/restore')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({ summary: 'Restore an archived test set' })
  restore(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('setId', ParseUUIDPipe) setId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.setArchived(user, spaceId, setId, false);
  }

  @Post('bulk-delete')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('delete_tests')
  @ApiOperation({
    summary:
      'Delete up to 100 test sets at once; sets already gone come back as skipped',
  })
  bulkRemove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: BulkDeleteTestSetsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.bulkRemove(user, spaceId, dto);
  }

  @Delete(':setId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireSpacePermission('delete_tests')
  @ApiOperation({ summary: 'Delete a test set and its memberships' })
  remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('setId', ParseUUIDPipe) setId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.remove(user, spaceId, setId);
  }

  @Get(':setId/test-ids')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Ids of all test cases in a set' })
  memberIds(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('setId', ParseUUIDPipe) setId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.memberIds(user.organizationId, spaceId, setId);
  }

  @Get(':setId/tests')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Test cases in a set, by key' })
  members(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('setId', ParseUUIDPipe) setId: string,
    @Query() query: TestSetMembersQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    // "me" becomes the caller, as the automation runs list does it.
    const assignee = query.assignee === 'me' ? user.userId : query.assignee;

    return this.service.members(user.organizationId, spaceId, setId, {
      ...query,
      assignee,
    });
  }

  @Post(':setId/tests')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({ summary: 'Add test cases to a set' })
  addMembers(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('setId', ParseUUIDPipe) setId: string,
    @Body() dto: ChangeTestSetMembersDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.changeMembers(
      user,
      spaceId,
      setId,
      dto.case_ids,
      'add',
    );
  }

  @Post(':setId/tests/remove')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({ summary: 'Remove test cases from a set' })
  removeMembers(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('setId', ParseUUIDPipe) setId: string,
    @Body() dto: ChangeTestSetMembersDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.changeMembers(
      user,
      spaceId,
      setId,
      dto.case_ids,
      'remove',
    );
  }
}
