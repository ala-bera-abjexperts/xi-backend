import { storageSafeFileName } from '../common/upload-filename';
import { UPLOAD_LIMITS } from '../common/upload-limits';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AssetObjectHistoryService } from './asset-object-history.service';

const TABLE = 'asset_object_attachments';
const BUCKET = 'asset-object-attachments';
/** Attachments carry NO type restriction; the size cap is the abuse control. */
const MAX_SIZE_BYTES = UPLOAD_LIMITS.ATTACHMENT;

@Injectable()
export class AssetObjectAttachmentsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly history: AssetObjectHistoryService,
    private readonly outboxService: AutomationEventOutboxService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getAll(
    objectId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<{ data: Record<string, unknown>[]; count: number }> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(
        '*, uploaded_by_user:users!asset_object_attachments_uploaded_by_fkey(id,first_name,last_name,email,avatar_url)',
      )
      .eq('object_id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('file_name', { ascending: true })
      .order('version_number', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    const rows = (data ?? []) as Record<string, unknown>[];

    // Return only the head version (highest version_number) per file_name
    const seen = new Set<string>();
    const head: Record<string, unknown>[] = [];

    for (const row of rows) {
      const key = row['file_name'] as string;

      if (!seen.has(key)) {
        seen.add(key);
        head.push(row);
      }
    }

    return { data: head, count: head.length };
  }

  async upload(
    objectId: string,
    schemaId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    if (!file) throw new BadRequestException('File is required');

    if (file.size > MAX_SIZE_BYTES) {
      throw new BadRequestException('File exceeds maximum size of 50 MB');
    }

    // Determine the next version number for this filename
    const { data: existingRows, error: versionErr } = await this.client
      .from(TABLE)
      .select('version_number')
      .eq('object_id', objectId)
      .eq('organization_id', organizationId)
      .eq('file_name', file.originalname)
      .order('version_number', { ascending: false })
      .limit(1);

    if (versionErr) {
      throw new BadRequestException(
        `Failed to determine file version: ${versionErr.message}`,
      );
    }

    const existing = (existingRows ?? []) as Record<string, unknown>[];

    const nextVersion =
      existing.length > 0
        ? ((existing[0]['version_number'] as number) ?? 0) + 1
        : 1;

    const sanitizedName = storageSafeFileName(file.originalname);
    const filePath = `${organizationId}/${objectId}/${Date.now()}-v${nextVersion}-${sanitizedName}`;

    const { error: uploadError } = await this.client.storage
      .from(BUCKET)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      throw new BadRequestException(`Upload failed: ${uploadError.message}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        object_id: objectId,
        schema_id: schemaId,
        space_id: spaceId,
        organization_id: organizationId,
        file_name: file.originalname,
        file_path: filePath,
        file_size: file.size,
        mime_type: file.mimetype,
        uploaded_by: userId,
        version_number: nextVersion,
      })
      .select()
      .single();

    if (error || !data) {
      // Remove the uploaded blob if metadata insert fails
      await this.client.storage.from(BUCKET).remove([filePath]);
      throw new BadRequestException(
        error?.message ?? 'Failed to save attachment metadata',
      );
    }

    const { data: assetRow } = await this.client
      .from('asset_objects')
      .select('name, object_type_id')
      .eq('id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    const assetName = assetRow
      ? ((assetRow as Record<string, unknown>)['name'] as string)
      : '';

    const assetObjectTypeId = assetRow
      ? ((assetRow as Record<string, unknown>)['object_type_id'] as
          | string
          | null)
      : null;

    void this.outboxService.write(
      organizationId,
      spaceId,
      'app.asset_object.attachment_added',
      {
        asset: {
          id: objectId,
          name: assetName,
          schema_id: schemaId,
          object_type_id: assetObjectTypeId,
          space_id: spaceId,
          organization_id: organizationId,
        },
        asset_id: objectId,
        schema_id: schemaId,
        object_type_id: assetObjectTypeId,
        space_id: spaceId,
        organization_id: organizationId,
        attachment: {
          id: (data as Record<string, unknown>)['id'] as string,
          file_name: file.originalname,
          file_size: file.size,
          mime_type: file.mimetype,
          version_number: nextVersion,
        },
        created_by: userId,
        author_user_id: userId,
      },
    );

    await this.history
      .logChange(
        objectId,
        schemaId,
        organizationId,
        spaceId,
        nextVersion === 1 ? 'attachment_added' : 'attachment_added',
        userId,
        {
          metadata: {
            file_name: file.originalname,
            file_size: file.size,
            version_number: nextVersion,
          },
        },
      )
      .catch(() => undefined);

    return { data: data as Record<string, unknown>, success: true };
  }

  async getSignedUrl(
    attachmentId: string,
    objectId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<{ data: { url: string } }> {
    const { data: row, error } = await this.client
      .from(TABLE)
      .select('file_path, file_name')
      .eq('id', attachmentId)
      .eq('object_id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!row) throw new NotFoundException('Attachment not found');

    const r = row as Record<string, unknown>;
    const filePath = r['file_path'] as string;
    const fileName = r['file_name'] as string;

    const { data: signedData, error: signError } = await this.client.storage
      .from(BUCKET)
      .createSignedUrl(filePath, 3600, { download: fileName });

    if (signError || !signedData) {
      throw new BadRequestException('Failed to generate download URL');
    }

    return { data: { url: signedData.signedUrl } };
  }

  /** Generates a signed URL and streams a redirect — used by the permanent download endpoint. */
  async download(
    attachmentId: string,
    objectId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<{ url: string; fileName: string }> {
    const result = await this.getSignedUrl(
      attachmentId,
      objectId,
      spaceId,
      organizationId,
    );

    const { data: row } = await this.client
      .from(TABLE)
      .select('file_name')
      .eq('id', attachmentId)
      .maybeSingle();

    const fileName = row
      ? ((row as Record<string, unknown>)['file_name'] as string)
      : 'download';

    return { url: result.data.url, fileName };
  }

  /** Returns all version rows for the same filename as the given attachment, newest first. */
  async getVersions(
    attachmentId: string,
    objectId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<{ data: Record<string, unknown>[] }> {
    // Resolve the file_name for this attachment
    const { data: anchor, error: anchorErr } = await this.client
      .from(TABLE)
      .select('file_name')
      .eq('id', attachmentId)
      .eq('object_id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (anchorErr) throw new BadRequestException(anchorErr.message);
    if (!anchor) throw new NotFoundException('Attachment not found');

    const fileName = (anchor as Record<string, unknown>)['file_name'] as string;

    const { data, error } = await this.client
      .from(TABLE)
      .select(
        '*, uploaded_by_user:users!asset_object_attachments_uploaded_by_fkey(id,first_name,last_name,email,avatar_url)',
      )
      .eq('object_id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('file_name', fileName)
      .order('version_number', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    return { data: (data ?? []) as Record<string, unknown>[] };
  }

  async delete(
    attachmentId: string,
    objectId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    const { data: row, error: fetchError } = await this.client
      .from(TABLE)
      .select('file_path,file_name,schema_id')
      .eq('id', attachmentId)
      .eq('object_id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (fetchError) throw new BadRequestException(fetchError.message);
    if (!row) throw new NotFoundException('Attachment not found');

    const r = row as Record<string, unknown>;
    const filePath = r['file_path'] as string;
    const fileName = r['file_name'] as string;
    const schemaId = r['schema_id'] as string;

    // Remove storage blob first, then metadata row
    await this.client.storage.from(BUCKET).remove([filePath]);

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', attachmentId)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId);

    if (error) throw new BadRequestException(error.message);

    const { data: assetRow } = await this.client
      .from('asset_objects')
      .select('name, object_type_id')
      .eq('id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    const assetName = assetRow
      ? ((assetRow as Record<string, unknown>)['name'] as string)
      : '';

    const assetObjectTypeId = assetRow
      ? ((assetRow as Record<string, unknown>)['object_type_id'] as
          | string
          | null)
      : null;

    void this.outboxService.write(
      organizationId,
      spaceId,
      'app.asset_object.attachment_deleted',
      {
        asset: {
          id: objectId,
          name: assetName,
          schema_id: schemaId,
          object_type_id: assetObjectTypeId,
          space_id: spaceId,
          organization_id: organizationId,
        },
        asset_id: objectId,
        schema_id: schemaId,
        object_type_id: assetObjectTypeId,
        space_id: spaceId,
        organization_id: organizationId,
        attachment: {
          id: attachmentId,
          file_name: fileName,
        },
        deleted_by: userId,
      },
    );

    await this.history
      .logChange(
        objectId,
        schemaId,
        organizationId,
        spaceId,
        'attachment_deleted',
        userId,
        {
          metadata: { file_name: fileName },
        },
      )
      .catch(() => undefined);

    return { success: true, message: 'Attachment deleted' };
  }
}
