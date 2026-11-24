import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { MediaService } from './media.service';

@RequireFeature('module_site_studio')
@ApiTags('Site Studio — Media')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('funnels/:funnelId/media')
export class MediaController {
  constructor(private readonly service: MediaService) {}

  // ── List files — must be before :fileName ─────────────────────────────────────

  @Get('files')
  @RequirePermissions('can_view_site_studio')
  @ApiOperation({ summary: 'List all media files for a funnel' })
  @ApiParam({ name: 'funnelId' })
  async listFiles(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
  ) {
    const files = await this.service.listFiles(funnelId, user.organizationId);
    return { data: files };
  }

  // ── Upload — must be before :fileName ─────────────────────────────────────────

  @Post('upload')
  @RequirePermissions('can_edit_site_studio')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a media file (image or video) for a funnel',
  })
  @ApiParam({ name: 'funnelId' })
  async uploadFile(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const result = await this.service.uploadFile(
      funnelId,
      user.organizationId,
      user.userId,
      file,
    );
    return { data: result };
  }

  // ── Delete by filename ────────────────────────────────────────────────────────

  @Delete(':fileName')
  @RequirePermissions('can_delete_site_studio')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a media file by its stored filename' })
  @ApiParam({ name: 'funnelId' })
  @ApiParam({ name: 'fileName' })
  async deleteFile(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Param('fileName') fileName: string,
  ) {
    await this.service.deleteFile(
      funnelId,
      user.organizationId,
      user.userId,
      fileName,
    );
  }
}
