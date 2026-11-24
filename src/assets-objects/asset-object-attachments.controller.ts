import { UPLOAD_LIMITS } from '../common/upload-limits';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AssetObjectAttachmentsService } from './asset-object-attachments.service';

@RequireFeature('module_assets')
@ApiTags('asset-object-attachments')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/assets')
export class AssetObjectAttachmentsController {
  constructor(private readonly service: AssetObjectAttachmentsService) {}

  @Get('objects/:id/attachments')
  @RequireSpacePermission('view_assets')
  @ApiOperation({ summary: 'List all file attachments for an asset object' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
  @ApiResponse({
    status: 200,
    description: 'Attachment list returned (includes uploader user details)',
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

  @Post('objects/:id/attachments')
  @RequireSpacePermission('edit_assets')
  @ApiOperation({
    summary: 'Upload a file attachment to an asset object',
    description:
      'Multipart upload. Maximum file size: 50 MB. Supported types: images, PDF, Word, Excel, plain text, CSV.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
  @ApiQuery({
    name: 'schemaId',
    required: true,
    description: 'Schema UUID (used for history logging)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'File to upload (max 50 MB)',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'File uploaded and attachment record created',
  })
  @ApiResponse({
    status: 400,
    description: 'Missing file, invalid mime type, or file too large',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing edit_assets permission or module disabled',
  })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: UPLOAD_LIMITS.ATTACHMENT } }),
  )
  async upload(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Query('schemaId') schemaId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.upload(
      id,
      schemaId,
      spaceId,
      user.organizationId,
      user.userId,
      file,
    );
  }

  @Get('objects/:id/attachments/:attachmentId')
  @RequireSpacePermission('view_assets')
  @ApiOperation({
    summary: 'Get a signed download URL for an attachment (valid for 1 hour)',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  @ApiResponse({
    status: 200,
    description: 'Signed download URL returned (1-hour expiry)',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Attachment not found' })
  async getSignedUrl(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.getSignedUrl(
      attachmentId,
      id,
      spaceId,
      user.organizationId,
    );
  }

  @Get('objects/:id/attachments/:attachmentId/download')
  @RequireSpacePermission('view_assets')
  @ApiOperation({
    summary: 'Permanent download redirect for an attachment (302 → signed URL)',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  @ApiResponse({ status: 302, description: 'Redirect to signed download URL' })
  @ApiResponse({ status: 404, description: 'Attachment not found' })
  async download(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: RequestUser,
    @Res() res: Response,
  ) {
    const { url } = await this.service.download(
      attachmentId,
      id,
      spaceId,
      user.organizationId,
    );

    res.redirect(302, url);
  }

  @Get('objects/:id/attachments/:attachmentId/versions')
  @RequireSpacePermission('view_assets')
  @ApiOperation({
    summary: 'List all versions of an attachment (same filename)',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
  @ApiParam({
    name: 'attachmentId',
    description: 'Attachment UUID (any version)',
  })
  @ApiResponse({
    status: 200,
    description: 'All versions returned, newest first',
  })
  @ApiResponse({ status: 404, description: 'Attachment not found' })
  async getVersions(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.getVersions(
      attachmentId,
      id,
      spaceId,
      user.organizationId,
    );
  }

  @Delete('objects/:id/attachments/:attachmentId')
  @RequireSpacePermission('edit_assets')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete an attachment and remove its file from storage',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  @ApiResponse({
    status: 200,
    description: 'Attachment and storage file deleted',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing edit_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Attachment not found' })
  async delete(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.delete(
      attachmentId,
      id,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }
}
