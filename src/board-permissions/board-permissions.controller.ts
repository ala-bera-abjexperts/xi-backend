import { RequireFeature } from '../auth/decorators/require-feature.decorator';
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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { BoardPermissionsService } from './board-permissions.service';
import { GrantBoardPermissionDto } from './dto/grant-board-permission.dto';
import { UpdateBoardPermissionDto } from './dto/update-board-permission.dto';

@RequireFeature('module_boards')
@ApiTags('Board Permissions')
@ApiBearerAuth()
@Controller('boards/:boardId/permissions')
export class BoardPermissionsController {
  constructor(private readonly service: BoardPermissionsService) {}

  @Get()
  @ApiOperation({
    summary: 'List all permissions for a board with user details',
  })
  @ApiParam({ name: 'boardId' })
  getAll(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
  ) {
    return this.service.getAll(boardId, user.organizationId, user.userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Grant a permission to a user on a board' })
  @ApiParam({ name: 'boardId' })
  grant(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Body() dto: GrantBoardPermissionDto,
  ) {
    return this.service.grant(boardId, user.organizationId, dto, user.userId);
  }

  @Patch(':permissionId')
  @ApiOperation({
    summary: 'Update the permission level for a board permission',
  })
  @ApiParam({ name: 'boardId' })
  @ApiParam({ name: 'permissionId' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Param('permissionId', ParseUUIDPipe) permissionId: string,
    @Body() dto: UpdateBoardPermissionDto,
  ) {
    return this.service.update(
      permissionId,
      boardId,
      user.organizationId,
      dto,
      user.userId,
    );
  }

  @Delete(':permissionId')
  @ApiOperation({ summary: 'Revoke a board permission' })
  @ApiParam({ name: 'boardId' })
  @ApiParam({ name: 'permissionId' })
  revoke(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Param('permissionId', ParseUUIDPipe) permissionId: string,
  ) {
    return this.service.revoke(
      permissionId,
      boardId,
      user.organizationId,
      user.userId,
    );
  }
}
