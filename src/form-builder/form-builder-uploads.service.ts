import { storageSafeFileName } from '../common/upload-filename';
import { formatMaxUpload, UPLOAD_LIMITS } from '../common/upload-limits';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';

const BUCKET = 'form_builder_submission_attachments';
const MAX_BYTES = UPLOAD_LIMITS.ATTACHMENT;

@Injectable()
export class FormBuilderUploadsService {
  private readonly logger = new Logger(FormBuilderUploadsService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private sanitizeFileName(name: string): string {
    return storageSafeFileName(name);
  }

  /**
   * Uploads a file to the form builder submission attachments bucket.
   * Returns the public URL and storage path so the client can reference it in the submission payload.
   */
  async upload(
    spaceId: string,
    formId: string,
    fieldKey: string,
    file: Express.Multer.File,
  ): Promise<{ publicUrl: string; path: string }> {
    if (file.size > MAX_BYTES) {
      throw new BadRequestException(
        `File exceeds the maximum allowed size of ${formatMaxUpload(MAX_BYTES)}`,
      );
    }

    const sanitized = this.sanitizeFileName(file.originalname);
    const storagePath = `${spaceId}/${formId}/${fieldKey}/${randomUUID()}-${sanitized}`;

    const { data: uploadData, error: uploadError } = await this.client.storage
      .from(BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype || 'application/octet-stream',
        upsert: false,
      });

    if (uploadError) {
      this.logger.error('Storage upload failed:', uploadError);
      throw new BadRequestException(`Upload failed: ${uploadError.message}`);
    }

    const { data: urlData } = this.client.storage
      .from(BUCKET)
      .getPublicUrl(uploadData.path);

    return { publicUrl: urlData.publicUrl, path: uploadData.path };
  }

  /**
   * Uploads a design image asset (page/form background, image field) for a form.
   * Uses the service-role client so RLS does not block builder users.
   */
  async uploadDesignAsset(
    spaceId: string,
    formId: string,
    file: Express.Multer.File,
  ): Promise<{ publicUrl: string; path: string }> {
    if (file.size > MAX_BYTES) {
      throw new BadRequestException(
        `File exceeds the maximum allowed size of ${formatMaxUpload(MAX_BYTES)}`,
      );
    }

    const sanitized = this.sanitizeFileName(file.originalname);
    const storagePath = `${spaceId}/${formId}/design/${randomUUID()}-${sanitized}`;

    const { data: uploadData, error: uploadError } = await this.client.storage
      .from(BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype || 'application/octet-stream',
        upsert: false,
      });

    if (uploadError) {
      this.logger.error('Design asset upload failed:', uploadError);
      throw new BadRequestException(`Upload failed: ${uploadError.message}`);
    }

    const { data: urlData } = this.client.storage
      .from(BUCKET)
      .getPublicUrl(uploadData.path);

    return { publicUrl: urlData.publicUrl, path: uploadData.path };
  }

  /**
   * Removes a previously uploaded file from storage.
   * Best-effort: logs errors but doesn't throw so UI can still remove the entry.
   */
  async remove(filePath: string): Promise<{ success: true }> {
    const { error } = await this.client.storage.from(BUCKET).remove([filePath]);

    if (error) {
      this.logger.error('Storage remove failed:', error);
      throw new BadRequestException(`Delete failed: ${error.message}`);
    }

    return { success: true };
  }
}
