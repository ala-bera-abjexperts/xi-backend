import { storageSafeFileName } from '../common/upload-filename';
import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { formatMaxUpload, UPLOAD_LIMITS } from '../common/upload-limits';
import { assertImageMime } from '../common/upload-mime';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

const BUCKET = 'wiki-attachments';
const MAX_SIZE = UPLOAD_LIMITS.CONTENT_IMAGE;

/** TipTap inline images accept any `image/*` type, SVG included — as this endpoint always has. */
const IMAGE_MIME_OPTS = { allowSvg: true } as const;

/**
 * Generic image upload endpoint for TipTap editors (task comments, descriptions, etc.).
 * Stores images in the wiki-attachments bucket under editor-images/{userId}/.
 */
@ApiTags('Uploads')
@ApiBearerAuth()
@Controller('uploads')
export class UploadsController {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  /** POST /uploads/images — upload an inline image for any TipTap editor */
  @Post('images')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SIZE } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload an inline image for TipTap editors' })
  @ApiResponse({ status: 201, description: 'Image URL returned' })
  async uploadImage(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<Record<string, unknown>> {
    if (!file) throw new BadRequestException('No file provided');
    if (file.size > MAX_SIZE)
      throw new BadRequestException(
        `Image exceeds maximum size of ${formatMaxUpload(MAX_SIZE)}`,
      );
    assertImageMime(file.mimetype, IMAGE_MIME_OPTS);

    const sanitized = storageSafeFileName(file.originalname);
    const path = `editor-images/${user.userId}/${Date.now()}-${sanitized}`;
    const client = this.supabaseAdmin.getClient();

    const { error } = await client.storage
      .from(BUCKET)
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
    if (error)
      throw new BadRequestException(`Storage upload failed: ${error.message}`);

    const { data } = client.storage.from(BUCKET).getPublicUrl(path);
    if (!data?.publicUrl) {
      throw new BadRequestException('Failed to generate image URL');
    }

    return {
      url: data.publicUrl,
      fileName: file.originalname,
      fileSize: file.size,
      fileType: file.mimetype,
    };
  }
}
