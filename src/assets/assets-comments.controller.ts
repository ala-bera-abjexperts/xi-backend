import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
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
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AssetsCommentsService } from './assets-comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';

@RequireFeature('module_lists')
@ApiTags('Asset Comments')
@ApiBearerAuth()
// SECURITY (H2): require space membership + list view (services scope org-only).
@UseGuards(SpacePermissionsGuard)
@RequireSpacePermission('can_view_lists')
@Controller('spaces/:spaceId/lists/items/:itemId/comments')
export class AssetsCommentsController {
  constructor(private readonly service: AssetsCommentsService) {}

  @Get()
  @ApiOperation({ summary: 'List comments for an item' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  async getAll(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.getAll(itemId, user.organizationId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a comment' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  async create(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.service.create(itemId, user.organizationId, user.userId, dto);
  }

  @Put(':commentId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a comment' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  @ApiParam({ name: 'commentId' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.service.update(
      commentId,
      itemId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete(':commentId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a comment' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  @ApiParam({ name: 'commentId' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    return this.service.delete(
      commentId,
      itemId,
      user.organizationId,
      user.userId,
    );
  }
}
