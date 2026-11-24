import { UPLOAD_LIMITS } from '../common/upload-limits';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AssetsAttachmentsService } from './assets-attachments.service';

@RequireFeature('module_lists')
@ApiTags('Asset Attachments')
@ApiBearerAuth()
// SECURITY (H2): require space membership + list view (services scope org-only).
@UseGuards(SpacePermissionsGuard)
@RequireSpacePermission('can_view_lists')
@Controller('spaces/:spaceId/lists/items/:itemId/attachments')
export class AssetsAttachmentsController {
  constructor(private readonly service: AssetsAttachmentsService) {}

  @Get()
  @ApiOperation({ summary: 'List attachments for an item' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  async getAll(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.getAll(itemId, user.organizationId);
  }

  @Post()
  @ApiOperation({ summary: 'Upload an attachment' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: UPLOAD_LIMITS.ATTACHMENT } }),
  )
  async upload(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Query('schemaId') schemaId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.service.upload(
      itemId,
      schemaId,
      user.organizationId,
      user.userId,
      file,
    );
  }

  @Get(':attachmentId')
  @ApiOperation({ summary: 'Get signed download URL for an attachment' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  @ApiParam({ name: 'attachmentId' })
  async getSignedUrl(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    return this.service.getSignedUrl(attachmentId, itemId, user.organizationId);
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an attachment' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  @ApiParam({ name: 'attachmentId' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Query('schemaId') schemaId: string,
  ) {
    return this.service.delete(
      attachmentId,
      itemId,
      schemaId,
      user.organizationId,
      user.userId,
    );
  }
}
