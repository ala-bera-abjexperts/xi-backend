import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AssetObjectCommentsService } from './asset-object-comments.service';
import { CreateAssetObjectCommentDto } from './dto/create-asset-object-comment.dto';
import { UpdateAssetObjectCommentDto } from './dto/update-asset-object-comment.dto';

@RequireFeature('module_assets')
@ApiTags('asset-object-comments')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/assets')
export class AssetObjectCommentsController {
  constructor(private readonly service: AssetObjectCommentsService) {}

  @Get('objects/:id/comments')
  @RequireSpacePermission('view_assets')
  @ApiOperation({ summary: 'List comments for an asset object' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
  @ApiResponse({
    status: 200,
    description:
      'Comment list returned (ordered oldest-first, includes author user details)',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  async getAll(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.getAll(id, spaceId, user.organizationId);
  }

  @Post('objects/:id/comments')
  @RequireSpacePermission('edit_assets')
  @ApiOperation({ summary: 'Post a comment on an asset object' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
  @ApiResponse({ status: 201, description: 'Comment created' })
  @ApiResponse({
    status: 400,
    description: 'Validation error (content 1–5000 chars required)',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  async create(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Body() dto: CreateAssetObjectCommentDto,
    @CurrentUser() user: RequestUser,
  ) {
    const comment = await this.service.create(
      id,
      spaceId,
      user.organizationId,
      user.userId,
      dto,
    );

    return comment;
  }

  @Patch('objects/:id/comments/:commentId')
  @RequireSpacePermission('edit_assets')
  @ApiOperation({ summary: 'Edit a comment (author only)' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
  @ApiParam({ name: 'commentId', description: 'Comment UUID' })
  @ApiResponse({ status: 200, description: 'Comment updated' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Not the comment author or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async update(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Body() dto: UpdateAssetObjectCommentDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.update(
      commentId,
      id,
      spaceId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete('objects/:id/comments/:commentId')
  @RequireSpacePermission('edit_assets')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a comment (author only)' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
  @ApiParam({ name: 'commentId', description: 'Comment UUID' })
  @ApiResponse({ status: 200, description: 'Comment deleted' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Not the comment author or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  async delete(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.delete(
      commentId,
      id,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }
}
