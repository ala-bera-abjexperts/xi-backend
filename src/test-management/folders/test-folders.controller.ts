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
  CreateTestFolderDto,
  UpdateTestFolderDto,
} from '../dto/test-folder.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestFoldersService } from './test-folders.service';

/** `:spaceId` and `:folderId`, never `:id`: SpacePermissionsGuard falls back to `params.id` as the space id. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management/folders')
export class TestFoldersController {
  constructor(private readonly service: TestFoldersService) {}

  @Get()
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'All folders of the space, flat, by name' })
  list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(user.organizationId, spaceId);
  }

  @Post()
  @RequireSpacePermission('create_tests')
  @ApiOperation({ summary: 'Create a folder' })
  create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateTestFolderDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.create(user, spaceId, dto);
  }

  @Patch(':folderId')
  @RequireSpacePermission('edit_tests')
  @ApiOperation({ summary: 'Rename and/or move a folder' })
  update(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('folderId', ParseUUIDPipe) folderId: string,
    @Body() dto: UpdateTestFolderDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.update(user, spaceId, folderId, dto);
  }

  @Delete(':folderId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireSpacePermission('delete_tests')
  @ApiOperation({ summary: 'Delete an empty folder' })
  remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('folderId', ParseUUIDPipe) folderId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.remove(user, spaceId, folderId);
  }
}
