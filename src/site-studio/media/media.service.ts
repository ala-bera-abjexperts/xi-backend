import { storageSafeFileName } from '../../common/upload-filename';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { formatMaxUpload, UPLOAD_LIMITS } from '../../common/upload-limits';
import { assertImageOrVideoMime, isVideoMime } from '../../common/upload-mime';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';

const BUCKET = 'site-studio-assets';

const MAX_IMAGE_SIZE = UPLOAD_LIMITS.CONTENT_IMAGE;
const MAX_VIDEO_SIZE = UPLOAD_LIMITS.VIDEO;

/**
 * Site Studio media accepts any `image/*` or `video/*` type, SVG included — as it always has.
 * The previous list named seven video codecs by hand and rejected everything else, so an ordinary
 * `.mov` variant or a modern `image/avif` was refused for no reason beyond not being enumerated.
 */
const MEDIA_MIME_OPTS = { allowSvg: true } as const;

export interface MediaFile {
  name: string;
  url: string;
  size: number;
  updatedAt: string;
}

export interface UploadResult {
  name: string;
  url: string;
  fileName: string;
  size: number;
  fileSize: number;
  filePath: string;
  updatedAt: string;
}

@Injectable()
export class MediaService {
  static readonly FUNNELS_TABLE = 'site_studio_funnels';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async assertFunnelBelongsToOrg(
    funnelId: string,
    organizationId: string,
  ): Promise<void> {
    const { data } = await this.client
      .from(MediaService.FUNNELS_TABLE)
      .select('id')
      .eq('id', funnelId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!data) throw new NotFoundException('Funnel not found');
  }

  private logMediaAction(
    organizationId: string,
    userId: string,
    funnelId: string,
    fileName: string,
    action: 'create' | 'delete',
    changes?: Record<string, unknown>,
  ): void {
    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'site_studio_media',
      funnelId,
      action,
      {
        ...changes,
        file_name: fileName,
      },
    );
  }

  async listFiles(
    funnelId: string,
    organizationId: string,
  ): Promise<MediaFile[]> {
    await this.assertFunnelBelongsToOrg(funnelId, organizationId);

    const prefix = `${organizationId}/${funnelId}`;

    const { data: files, error } = await this.client.storage
      .from(BUCKET)
      .list(prefix, {
        limit: 200,
        sortBy: { column: 'updated_at', order: 'desc' },
      });

    if (error) throw new BadRequestException('Failed to list media files');

    return (files ?? [])
      .filter((f) => f.name !== '.emptyFolderPlaceholder')
      .map((f) => {
        const filePath = `${prefix}/${f.name}`;
        const {
          data: { publicUrl },
        } = this.client.storage.from(BUCKET).getPublicUrl(filePath);

        return {
          name: f.name,
          url: publicUrl,
          size:
            ((f.metadata as Record<string, unknown>)?.['size'] as number) ?? 0,
          updatedAt: f.updated_at ?? '',
        };
      });
  }

  async uploadFile(
    funnelId: string,
    organizationId: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<UploadResult> {
    await this.assertFunnelBelongsToOrg(funnelId, organizationId);

    assertImageOrVideoMime(file.mimetype, MEDIA_MIME_OPTS);

    const isVideo = isVideoMime(file.mimetype);
    const maxSize = isVideo ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;

    if (file.size > maxSize) {
      throw new BadRequestException(
        `File size exceeds the ${formatMaxUpload(maxSize)} limit`,
      );
    }

    const sanitizedName = storageSafeFileName(file.originalname);
    const fileName = `${Date.now()}-${sanitizedName}`;
    const filePath = `${organizationId}/${funnelId}/${fileName}`;

    const { error } = await this.client.storage
      .from(BUCKET)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (error)
      throw new BadRequestException('Failed to upload file to storage');

    const {
      data: { publicUrl },
    } = this.client.storage.from(BUCKET).getPublicUrl(filePath);

    const result = {
      name: fileName,
      url: publicUrl,
      fileName,
      size: file.size,
      fileSize: file.size,
      filePath,
      updatedAt: new Date().toISOString(),
    };

    this.logMediaAction(organizationId, userId, funnelId, fileName, 'create', {
      funnel_id: funnelId,
      file_path: filePath,
      file_size: file.size,
      mime_type: file.mimetype,
    });
    return result;
  }

  async deleteFile(
    funnelId: string,
    organizationId: string,
    userId: string,
    fileName: string,
  ): Promise<void> {
    await this.assertFunnelBelongsToOrg(funnelId, organizationId);

    const filePath = `${organizationId}/${funnelId}/${fileName}`;

    const { error } = await this.client.storage.from(BUCKET).remove([filePath]);

    if (error) throw new BadRequestException('Failed to delete file');

    this.logMediaAction(organizationId, userId, funnelId, fileName, 'delete', {
      funnel_id: funnelId,
      file_path: filePath,
    });
  }
}
