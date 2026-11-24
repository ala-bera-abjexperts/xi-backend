import {
  BadRequestException,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import { FormBuilderUploadsService } from './form-builder-uploads.service';

@RequireFeature('module_form_builder')
@ApiTags('form-builder-uploads')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/forms/:formId/upload')
export class FormBuilderUploadsController {
  constructor(private readonly service: FormBuilderUploadsService) {}

  /**
   * POST /spaces/:spaceId/forms/:formId/upload/design
   * Uploads a design image asset (image field, page/form backgrounds) via the service-role
   * client to bypass RLS. Requires edit_forms permission (builder context).
   */
  @Post('design')
  @HttpCode(HttpStatus.CREATED)
  @RequireSpacePermission('edit_forms')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a design image asset for a form field or background',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'formId', description: 'Form UUID' })
  async uploadDesign(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    return this.service.uploadDesignAsset(spaceId, formId, file);
  }

  /**
   * POST /spaces/:spaceId/forms/:formId/upload?fieldKey=<key>
   * Accepts multipart/form-data with a single `file` field.
   * Returns { data: { publicUrl, path } }.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireSpacePermission('submit_forms')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a file attachment for a form field' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'formId', description: 'Form UUID' })
  @ApiQuery({
    name: 'fieldKey',
    description: 'The field_key of the file_upload field',
  })
  async upload(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Query('fieldKey') fieldKey: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    if (!fieldKey?.trim()) {
      throw new BadRequestException('fieldKey query param is required');
    }

    return this.service.upload(spaceId, formId, fieldKey.trim(), file);
  }

  /**
   * DELETE /spaces/:spaceId/forms/:formId/upload?path=<storage-path>
   * Removes a previously uploaded file from storage.
   */
  @Delete()
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('submit_forms')
  @ApiOperation({ summary: 'Delete an uploaded form field attachment' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'formId', description: 'Form UUID' })
  @ApiQuery({
    name: 'path',
    description: 'Storage path returned by the upload endpoint',
  })
  async remove(@Query('path') filePath: string) {
    if (!filePath?.trim()) {
      throw new BadRequestException('path query param is required');
    }

    return this.service.remove(filePath.trim());
  }
}
