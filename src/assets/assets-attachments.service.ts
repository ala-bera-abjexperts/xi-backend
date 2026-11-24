import { storageSafeFileName } from '../common/upload-filename';
import { formatMaxUpload, UPLOAD_LIMITS } from '../common/upload-limits';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AssetsHistoryService } from './assets-history.service';

const TABLE = 'asset_item_attachments';
const BUCKET = 'list-attachments';
/** Attachments carry NO type restriction; the size cap is the abuse control. */
const MAX_SIZE_BYTES = UPLOAD_LIMITS.ATTACHMENT;

@Injectable()
export class AssetsAttachmentsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly history: AssetsHistoryService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getAll(
    itemId: string,
    organizationId: string,
  ): Promise<{ data: Record<string, unknown>[]; count: number }> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(
        '*, uploaded_by_user:users!asset_item_attachments_uploaded_by_fkey(id,first_name,last_name,email,avatar_url)',
      )
      .eq('item_id', itemId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    return { data: rows, count: rows.length };
  }

  async upload(
    itemId: string,
    schemaId: string,
    organizationId: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    if (!file) throw new BadRequestException('File is required');
    if (file.size > MAX_SIZE_BYTES)
      throw new BadRequestException(
        `File exceeds the maximum allowed size of ${formatMaxUpload(MAX_SIZE_BYTES)}`,
      );

    const sanitizedName = storageSafeFileName(file.originalname);
    const filePath = `${organizationId}/${itemId}/${Date.now()}-${sanitizedName}`;

    const { error: uploadError } = await this.client.storage
      .from(BUCKET)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError)
      throw new BadRequestException(`Upload failed: ${uploadError.message}`);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        item_id: itemId,
        organization_id: organizationId,
        file_name: file.originalname,
        file_path: filePath,
        file_size: file.size,
        mime_type: file.mimetype,
        uploaded_by: userId,
      })
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to save attachment metadata',
      );

    await this.history
      .logChange(itemId, schemaId, organizationId, 'row_create', userId, {
        metadata: { action: 'attachment_added', file_name: file.originalname },
      })
      .catch(() => undefined);

    return { data: data as Record<string, unknown>, success: true };
  }

  async getSignedUrl(
    attachmentId: string,
    itemId: string,
    organizationId: string,
  ): Promise<{ data: { url: string } }> {
    const { data: row, error } = await this.client
      .from(TABLE)
      .select('file_path, file_name')
      .eq('id', attachmentId)
      .eq('item_id', itemId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!row) throw new NotFoundException('Attachment not found');

    const filePath = (row as Record<string, unknown>)['file_path'] as string;
    const fileName = (row as Record<string, unknown>)['file_name'] as string;
    const { data: signedData, error: signError } = await this.client.storage
      .from(BUCKET)
      // `download`: serve with the ORIGINAL (possibly non-ASCII) name, not the sanitized key.
      .createSignedUrl(filePath, 3600, { download: fileName });

    if (signError || !signedData)
      throw new BadRequestException('Failed to generate download URL');
    return { data: { url: signedData.signedUrl } };
  }

  async delete(
    attachmentId: string,
    itemId: string,
    schemaId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    const { data: row, error: fetchError } = await this.client
      .from(TABLE)
      .select('file_path, file_name')
      .eq('id', attachmentId)
      .eq('item_id', itemId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (fetchError) throw new BadRequestException(fetchError.message);
    if (!row) throw new NotFoundException('Attachment not found');

    const filePath = (row as Record<string, unknown>)['file_path'] as string;
    await this.client.storage.from(BUCKET).remove([filePath]);

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', attachmentId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    await this.history
      .logChange(itemId, schemaId, organizationId, 'row_delete', userId, {
        metadata: {
          action: 'attachment_deleted',
          file_name: (row as Record<string, unknown>)['file_name'],
        },
      })
      .catch(() => undefined);

    return { success: true, message: 'Attachment deleted' };
  }
}
