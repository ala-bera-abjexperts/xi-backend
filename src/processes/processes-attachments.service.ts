/**
 * @fileoverview Service for process attachment file management.
 * Mirrors risk-management-app ProcessAttachmentService exactly:
 * - Uploads to Supabase Storage bucket "process-attachments" via admin client
 * - Queries process_attachments table with joined uploaded_by_user
 * - Returns identical response shapes to the frontend
 * @module src/processes/processes-attachments.service
 */

import { storageSafeFileName } from '../common/upload-filename';
import { formatMaxUpload, UPLOAD_LIMITS } from '../common/upload-limits';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

const BUCKET = 'process-attachments';
const TABLE = 'process_attachments';
/**
 * Attachments carry NO type restriction — the size cap is the abuse control. Files here are served
 * through signed URLs that force `Content-Disposition: attachment`, so the stored content type
 * never decides whether a browser executes anything.
 */
const MAX_FILE_SIZE = UPLOAD_LIMITS.ATTACHMENT;

/** Shape of a row from process_attachments joined with uploaded_by_user. */
export interface IProcessAttachment {
  id: string;
  process_id: string;
  organization_id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  uploaded_by: string | undefined;
  uploaded_by_user?: {
    id: string;
    first_name?: string;
    last_name?: string;
    email: string;
    avatar_url?: string;
  };
  created_at: string;
  updated_at: string;
}

const USER_JOIN = `
  *,
  uploaded_by_user:users!uploaded_by(
    id,
    first_name,
    last_name,
    email,
    avatar_url
  )
`;

@Injectable()
export class ProcessAttachmentsService {
  private readonly logger = new Logger(ProcessAttachmentsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * GET /processes/:id/attachments
   * Returns all attachments for a process, newest first.
   * Response shape: { data: IProcessAttachment[], count: number }
   */
  async getAttachments(
    processId: string,
    organizationId: string,
  ): Promise<{ data: IProcessAttachment[]; count: number }> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(USER_JOIN)
      .eq('process_id', processId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error('Failed to fetch process attachments:', error);
      throw new BadRequestException('Failed to fetch attachments');
    }

    const attachments = (data ?? []) as IProcessAttachment[];
    return { data: attachments, count: attachments.length };
  }

  /**
   * POST /processes/:id/attachments
   * Validates file, uploads to Supabase Storage, inserts DB record.
   * Response shape: { data: IProcessAttachment, success: true } (201)
   */
  async uploadAttachment(
    processId: string,
    organizationId: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<{ data: IProcessAttachment; success: true }> {
    // ── Validation ────────────────────────────────────────────────────────
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException(
        `File exceeds the maximum allowed size of ${formatMaxUpload(MAX_FILE_SIZE)}`,
      );
    }

    // ── Storage upload ────────────────────────────────────────────────────
    const timestamp = Date.now();
    const sanitizedFileName = storageSafeFileName(file.originalname);
    const filePath = `${organizationId}/${processId}/${timestamp}-${sanitizedFileName}`;

    const { error: uploadError } = await this.client.storage
      .from(BUCKET)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      this.logger.error('Storage upload failed:', uploadError);
      throw new BadRequestException(
        `File upload failed: ${uploadError.message}`,
      );
    }

    // ── DB insert ─────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error: insertError } = await this.client
      .from(TABLE)
      .insert({
        process_id: processId,
        organization_id: organizationId,
        file_name: file.originalname,
        file_path: filePath,
        file_size: file.size,
        mime_type: file.mimetype,
        uploaded_by: userId,
      })
      .select(USER_JOIN)
      .single();

    if (insertError || !data) {
      // Roll back storage upload on DB failure
      await this.client.storage.from(BUCKET).remove([filePath]);
      this.logger.error('DB insert failed after storage upload:', insertError);
      throw new BadRequestException('Failed to save attachment record');
    }

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'business_process',
      processId,
      'update',
      {
        action: 'attachment_added',
        attachment_id: (data as IProcessAttachment).id,
        file_name: file.originalname,
        file_size: file.size,
      },
    );
    return { data: data as IProcessAttachment, success: true };
  }

  /**
   * GET /processes/:id/attachments/:attachmentId
   * Returns a signed download URL (1-hour expiry).
   * Response shape: { data: { url: string } }
   */
  async getDownloadUrl(
    attachmentId: string,
    organizationId: string,
  ): Promise<{ data: { url: string } }> {
    const attachment = await this.findByIdOrThrow(attachmentId, organizationId);

    const { data: signed, error } = await this.client.storage
      .from(BUCKET)
      // `download`: serve with the ORIGINAL (possibly non-ASCII) name, not the sanitized key.
      .createSignedUrl(attachment.file_path, 3600, {
        download: attachment.file_name,
      });

    if (error || !signed?.signedUrl) {
      this.logger.error('Failed to generate signed URL:', error);
      throw new BadRequestException('Failed to generate download URL');
    }

    return { data: { url: signed.signedUrl } };
  }

  /**
   * DELETE /processes/:id/attachments/:attachmentId
   * Deletes from storage then from DB.
   * Response shape: { success: true, message: 'Attachment deleted' }
   */
  async deleteAttachment(
    attachmentId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    const attachment = await this.findByIdOrThrow(attachmentId, organizationId);

    const { error: storageError } = await this.client.storage
      .from(BUCKET)
      .remove([attachment.file_path]);

    if (storageError) {
      this.logger.error('Storage deletion failed:', storageError);
      throw new BadRequestException(
        `Failed to delete file: ${storageError.message}`,
      );
    }

    const { error: dbError } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', attachmentId)
      .eq('organization_id', organizationId);

    if (dbError) {
      this.logger.error('DB deletion failed:', dbError);
      throw new BadRequestException('Failed to delete attachment record');
    }

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'business_process',
      attachment.process_id,
      'update',
      {
        action: 'attachment_deleted',
        attachment_id: attachmentId,
        file_name: attachment.file_name,
      },
    );
    return { success: true, message: 'Attachment deleted' };
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private async findByIdOrThrow(
    attachmentId: string,
    organizationId: string,
  ): Promise<IProcessAttachment> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .select(USER_JOIN)
      .eq('id', attachmentId)
      .eq('organization_id', organizationId)
      .single();

    if (error?.code === 'PGRST116' || !data) {
      throw new NotFoundException('Attachment not found');
    }

    if (error) {
      this.logger.error('Failed to fetch attachment:', error);
      throw new BadRequestException('Failed to fetch attachment');
    }

    return data as IProcessAttachment;
  }
}
