/**
 * @fileoverview Business logic for File Explorer — CRUD, versioning, and access checks.
 * All methods use the service-role admin client via FileExplorerRepository /
 * FileExplorerStorageService. Access is resolved via FileExplorerAccessService.
 * @module src/file-explorer/file-explorer.service
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { FileExplorerRepository } from './file-explorer.repository';
import { FileExplorerStorageService } from './file-explorer-storage.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { IFeNode } from './interfaces/fe-node.interface';
import type { IFeVersion } from './interfaces/fe-version.interface';
import type { CreateFolderDto } from './dto/create-folder.dto';
import type { UploadFileDto } from './dto/upload-file.dto';
import type {
  InitUploadDto,
  InitVersionUploadDto,
} from './dto/init-upload.dto';
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  FILE_EXPLORER_MAX_BYTES,
  formatMaxUpload,
} from '../common/upload-limits';
import type { UpdateNodeDto } from './dto/update-node.dto';
import type { ListNodesQueryDto } from './dto/list-nodes-query.dto';
import type { CreateLabelDto } from './dto/create-label.dto';
import type { CreateReminderDto } from './dto/create-reminder.dto';
import type { CreateShareDto } from './dto/create-share.dto';
import type { UpdateShareDto } from './dto/update-share.dto';
import type { IFeLabel } from './interfaces/fe-label.interface';
import type { IFeReminder } from './interfaces/fe-label.interface';
import type { IFeShare } from './interfaces/fe-share.interface';
import type { IFeOrganizationStorageUsage } from './interfaces/fe-storage-usage.interface';
import { FileExplorerAccessService } from './file-explorer-access.service';
import { StorageConfigService } from '../storage-config/storage-config.service';
import type {
  IPublicFolderContents,
  IPublicFolderEntry,
  IPublicFolderNodeSummary,
  IFeZipEntry,
  IPublicShareAccessCookie,
  PublicDownloadInfo,
} from './interfaces/public-download.interface';

const MAX_VERSION_RETRIES = 5;

/**
 * Lifetime of a signed upload URL. Fixed at two hours by Supabase — `createSignedUploadUrl` takes
 * no TTL argument — so this is a mirror for the client's benefit, not a setting.
 */
const SIGNED_UPLOAD_TTL_SECONDS = 7200;
const PUBLIC_SHARE_ACCESS_TTL_SECONDS = 30 * 60;
const PUBLIC_FOLDER_ZIP_MAX_FILES = 500;
const PUBLIC_FOLDER_ZIP_MAX_BYTES = 250 * 1024 * 1024;

// In-memory brute-force lockout for public-link password verification (defense-in-depth on top of the
// per-IP @Throttle on the verify route). Per-instance only; the map is pruned to stay bounded.
const PW_MAX_FAILS = 10;
const PW_LOCK_MS = 15 * 60 * 1000; // 15 minutes
const pwLockouts = new Map<string, { fails: number; until: number }>();

/** What `upload-init` hands back: everything a client needs to PUT the bytes and then confirm. */
export interface IFeDirectUpload {
  nodeId: string;
  versionId: string;
  path: string;
  signedUrl: string;
  token: string;
  expiresInSeconds: number;
}

type PublicSharePasswordRow = Pick<IFeShare, 'id'> & {
  password_hash: string | null;
  is_active: boolean;
  expires_at: string | null;
};

type PublicSharePasswordSource = Pick<IFeShare, 'id'> & {
  password_hash?: string | null;
};

const INLINE_PREVIEW_MIME_RE =
  /^(image\/(png|jpeg|jpg|gif|webp|bmp|tiff|avif)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp3|ogg|wav|aac)|application\/pdf|text\/plain|application\/(vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document))$/i;

function normalizePreviewMime(mime: string | null | undefined): string {
  return (mime ?? '').split(';', 1)[0].trim().toLowerCase();
}

function hasFileExtension(name: string, extension: string): boolean {
  return name.toLowerCase().endsWith(extension);
}

function isInlinePreviewSupported(node: IFeNode): boolean {
  const mime = normalizePreviewMime(node.mime_type);

  if (mime) return INLINE_PREVIEW_MIME_RE.test(mime);

  return hasFileExtension(node.name, '.pdf');
}

@Injectable()
export class FileExplorerService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly repo: FileExplorerRepository,
    private readonly storage: FileExplorerStorageService,
    private readonly auditLogs: AuditLogsService,
    private readonly access: FileExplorerAccessService,
    private readonly storageConfig: StorageConfigService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  // ── SPACE BROWSE ─────────────────────────────────────────────────────────

  async listForSpace(
    user: RequestUser,
    spaceId: string,
    view: string,
    query: ListNodesQueryDto,
  ): Promise<IFeNode[]> {
    if (view === 'starred') {
      const nodes = await this.repo.listStarred(
        user.userId,
        user.organizationId,
        spaceId,
        query.search,
      );
      const enriched = await this.repo.enrichNodes(nodes, user.userId);

      return this.attachThumbnailUrls(enriched);
    }

    if (view === 'recent') {
      const nodes = await this.repo.listRecent(
        user.organizationId,
        spaceId,
        query.search,
      );
      const enriched = await this.repo.enrichNodes(nodes, user.userId);

      return this.attachThumbnailUrls(enriched);
    }

    if (view === 'shared-with-me') return this.sharedWithMe(user, spaceId);
    if (view === 'shared-from-me') return this.sharedFromMe(user, spaceId);

    const nodes = await this.repo.listNodes(
      spaceId,
      user.organizationId,
      view,
      query,
    );
    const enriched = await this.repo.enrichNodes(nodes, user.userId);

    return this.attachThumbnailUrls(enriched);
  }

  async breadcrumbs(
    user: RequestUser,
    nodeId: string,
    spaceId: string,
  ): Promise<IFeNode[]> {
    const node = await this.repo.findNode(nodeId);

    this.assertSameSpace(node, spaceId, user.organizationId);

    return this.repo.getBreadcrumbs(node);
  }

  async createFolder(
    user: RequestUser,
    spaceId: string,
    dto: CreateFolderDto,
  ): Promise<IFeNode> {
    if (dto.parent_id) {
      const parent = await this.repo.findNode(dto.parent_id);

      this.assertSameSpace(parent, spaceId, user.organizationId);

      if (parent.node_type !== 'folder') {
        throw new ConflictException('Parent must be a folder');
      }
    }

    try {
      const node = await this.repo.insertFolderNode(
        spaceId,
        user.organizationId,
        user.userId,
        {
          name: dto.name,
          parent_id: dto.parent_id,
          description: dto.description,
        },
      );

      void this.auditLogs.logAction(
        user.organizationId,
        user.userId,
        'file_explorer_node',
        node.id,
        'create',
        {
          node_type: 'folder',
          name: dto.name,
        },
      );

      return node;
    } catch (err: unknown) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? (err as { code?: unknown }).code
          : undefined;

      if (code === '23505') {
        throw new ConflictException(
          'A file or folder with this name already exists here',
        );
      }

      throw err;
    }
  }

  async uploadNewFile(
    user: RequestUser,
    spaceId: string,
    dto: UploadFileDto,
    file: Express.Multer.File,
  ): Promise<IFeNode> {
    if (file.size > 0) {
      const check = await this.storageConfig.checkUploadAllowed(
        user.organizationId,
        user.userId,
        file.size,
      );

      if (!check.allowed) {
        throw this.quotaExceeded(check);
      }
    }

    this.storage.assertAllowed(file);

    if (dto.parent_id) {
      const parent = await this.repo.findNode(dto.parent_id);

      this.assertSameSpace(parent, spaceId, user.organizationId);

      if (parent.node_type !== 'folder') {
        throw new ConflictException('Parent must be a folder');
      }
    }

    let node: IFeNode;

    try {
      node = await this.repo.insertFileNode(
        spaceId,
        user.organizationId,
        user.userId,
        {
          name: file.originalname,
          parent_id: dto.parent_id,
          mime_type: file.mimetype,
          file_size: file.size,
        },
      );
    } catch (err: any) {
      if (err?.code === '23505') {
        throw new ConflictException(
          'A file with this name already exists here. Upload as a new version instead.',
        );
      }

      throw err;
    }

    try {
      await this.addVersion(node, file, dto.comment ?? null, user);
    } catch (err) {
      // `addVersion` rolls back only its own fe_versions row, so without this the node survives
      // with current_version_id = null. listNodes does not filter those out, so the user sees a
      // file that was never actually stored and cannot re-upload under the same name (the unique
      // constraint now hits the husk). Mirrors the cleanup initDirectUpload already does.
      try {
        await this.db.from('fe_nodes').delete().eq('id', node.id);
      } catch {
        // ignore cleanup errors — the caller's original failure is the one that matters
      }

      throw err;
    }

    const enriched = await this.repo.enrichNodes(
      [await this.repo.findNode(node.id)],
      user.userId,
    );

    return enriched[0];
  }

  // ── DIRECT-TO-STORAGE UPLOAD ─────────────────────────────────────────────

  /**
   * Begin a direct upload: reserve the node and version rows, hand back a signed URL.
   *
   * Exists because `uploadNewFile` proxies every byte through this process — multer buffers the
   * whole request in memory — so it cannot carry the multi-gigabyte files File Explorer is meant
   * to hold. Here the client PUTs straight to Supabase and we only bookkeep.
   *
   * The version row is created `pending` and is NOT yet referenced by the node. That is the same
   * state machine `addVersion` uses, which means an abandoned upload is already handled: the
   * sweeper reaps pending rows older than 24 h, and refuses to touch any row a node points at.
   */
  async initDirectUpload(
    user: RequestUser,
    spaceId: string,
    dto: InitUploadDto,
  ): Promise<IFeDirectUpload> {
    await this.assertQuota(user, dto.size);

    if (dto.parent_id) {
      const parent = await this.repo.findNode(dto.parent_id);

      this.assertSameSpace(parent, spaceId, user.organizationId);

      if (parent.node_type !== 'folder') {
        throw new ConflictException('Parent must be a folder');
      }
    }

    const mimeType = dto.mime_type || 'application/octet-stream';

    let node: IFeNode;

    try {
      node = await this.repo.insertFileNode(
        spaceId,
        user.organizationId,
        user.userId,
        {
          name: dto.name,
          parent_id: dto.parent_id,
          mime_type: mimeType,
          file_size: dto.size,
        },
      );
    } catch (err) {
      if ((err as { code?: string } | null)?.code === '23505') {
        throw new ConflictException(
          'A file with this name already exists here. Upload as a new version instead.',
        );
      }

      throw err;
    }

    try {
      return await this.reservePendingVersion(
        node,
        user,
        dto.name,
        dto.size,
        mimeType,
        dto.comment ?? null,
      );
    } catch (err) {
      // The node was created moments ago and has no version, so it is not yet visible as a real
      // file. Drop it rather than leaving an empty husk in the tree that the user must clean up.
      try {
        await this.db.from('fe_nodes').delete().eq('id', node.id);
      } catch {
        // ignore cleanup errors — the caller's original failure is the one that matters
      }

      throw err;
    }
  }

  /** Begin a direct upload of a NEW VERSION of an existing file. */
  async initDirectVersionUpload(
    user: RequestUser,
    nodeId: string,
    dto: InitVersionUploadDto,
  ): Promise<IFeDirectUpload> {
    const node = await this.repo.findNode(nodeId);

    await this.assertAccess(user, node);
    await this.assertQuota(user, dto.size);

    if (node.node_type !== 'file') {
      throw new ConflictException('Only files can have versions');
    }

    return this.reservePendingVersion(
      node,
      user,
      dto.name || node.name,
      dto.size,
      dto.mime_type || node.mime_type || 'application/octet-stream',
      dto.comment ?? null,
    );
  }

  /**
   * Finish a direct upload: verify the bytes really landed, then activate the version.
   *
   * Quota is re-checked here against the object's ACTUAL size rather than the size declared at
   * init. Nothing stops a client from declaring one byte and PUTting a gigabyte, and
   * `get_user_storage_used_bytes` only counts `active` rows, so a pending upload is invisible to
   * the up-front check — without this second pass, concurrent inits could overshoot quota freely.
   */
  async completeDirectUpload(
    user: RequestUser,
    nodeId: string,
    versionId: string,
  ): Promise<IFeNode> {
    const node = await this.repo.findNode(nodeId);

    await this.assertAccess(user, node);

    const { data: version, error: versionErr } = await this.db
      .from('fe_versions')
      .select(
        'id, node_id, file_path, mime_type, version_number, upload_status',
      )
      .eq('id', versionId)
      .eq('node_id', nodeId)
      .maybeSingle();

    if (versionErr) throw versionErr;
    if (!version) throw new NotFoundException('Upload not found');

    const pending = version as {
      file_path: string;
      mime_type: string;
      version_number: number;
      upload_status: string;
    };

    // Idempotent: a client that retries a completion it already made gets the node, not an error.
    if (pending.upload_status === 'active') {
      const [enriched] = await this.repo.enrichNodes(
        [await this.repo.findNode(nodeId)],
        user.userId,
      );

      return enriched;
    }

    const stat = await this.storage.statObject(pending.file_path);

    if (!stat) {
      throw new BadRequestException(
        'No uploaded file found for this upload — PUT the file to the signed URL first',
      );
    }

    // Both checks below run against what was ACTUALLY uploaded, not the size declared at init —
    // nothing stops a client from declaring one byte and then PUTting a gigabyte. A rejection here
    // discards the object immediately rather than leaving it for the 24 h sweeper, because it is
    // already on disk and would otherwise sit there uncounted against anyone's quota.
    try {
      this.assertFileSize(stat.size);

      const quota = await this.storageConfig.checkUploadAllowed(
        user.organizationId,
        user.userId,
        stat.size,
      );

      if (!quota.allowed) {
        throw this.quotaExceeded(quota);
      }
    } catch (err) {
      await this.discardPendingUpload(versionId, pending.file_path);

      throw err;
    }

    // Activate BEFORE pointing the node at it, matching `addVersion`: if activation fails we throw
    // and the row stays 'pending' and UNREFERENCED, which is the state the sweeper can safely reap.
    const { error: activateErr } = await this.db
      .from('fe_versions')
      .update({ upload_status: 'active', file_size: stat.size })
      .eq('id', versionId);

    if (activateErr) {
      throw new Error(`Failed to activate version: ${activateErr.message}`);
    }

    const { error: nodeErr } = await this.db
      .from('fe_nodes')
      .update({
        current_version_id: versionId,
        file_size: stat.size,
        mime_type: pending.mime_type,
        updated_by: user.userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', nodeId);

    if (nodeErr) {
      throw new Error(
        `Failed to update node after version upload: ${nodeErr.message}`,
      );
    }

    void this.auditLogs.logAction(
      node.organization_id,
      user.userId,
      'file_explorer_node',
      nodeId,
      'update',
      { action: 'version', version_number: pending.version_number },
    );

    const [enriched] = await this.repo.enrichNodes(
      [await this.repo.findNode(nodeId)],
      user.userId,
    );

    return enriched;
  }

  /**
   * Reserve a `pending` version row and issue its signed upload URL.
   *
   * Mirrors the retry loop in `addVersion` — `next_fe_version_number` is a plain
   * `MAX(version_number) + 1` with no advisory lock, so concurrent uploads to the same node race
   * on the `(node_id, version_number)` unique constraint and must retry with a fresh number.
   */
  private async reservePendingVersion(
    node: IFeNode,
    user: RequestUser,
    fileName: string,
    declaredSize: number,
    mimeType: string,
    comment: string | null,
  ): Promise<IFeDirectUpload> {
    for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
      // The supabase client is untyped here, so name the RPC's return shape at the boundary
      // rather than letting `any` leak into the insert below.
      const { data: vNum } = (await this.db.rpc('next_fe_version_number', {
        p_node_id: node.id,
      })) as { data: number };
      const versionId = randomUUID();
      const path = this.storage.buildKey(node, versionId, fileName);

      const { error: insertErr } = await this.db.from('fe_versions').insert({
        id: versionId,
        node_id: node.id,
        version_number: vNum,
        file_path: path,
        file_size: declaredSize,
        mime_type: mimeType,
        comment,
        uploaded_by: user.userId,
        upload_status: 'pending',
      });

      if (insertErr?.code === '23505') continue; // race — retry with a new number
      if (insertErr) throw insertErr;

      try {
        const signed = await this.storage.createSignedUploadUrl(path);

        return {
          nodeId: node.id,
          versionId,
          path,
          signedUrl: signed.signedUrl,
          token: signed.token,
          expiresInSeconds: SIGNED_UPLOAD_TTL_SECONDS,
        };
      } catch (err) {
        try {
          await this.db.from('fe_versions').delete().eq('id', versionId);
        } catch {
          // ignore cleanup errors
        }

        throw err;
      }
    }

    throw new ConflictException('Version number conflict — please retry');
  }

  /**
   * Drop a rejected upload's bytes and its pending row.
   *
   * Best-effort on both halves: if either fails the sweeper still reaps the row and its object
   * after the 24 h grace, so a cleanup failure costs storage temporarily but never correctness.
   */
  private async discardPendingUpload(
    versionId: string,
    filePath: string,
  ): Promise<void> {
    try {
      await this.storage.removePaths([filePath]);
    } catch {
      // ignore — sweeper reaps it
    }

    try {
      await this.db.from('fe_versions').delete().eq('id', versionId);
    } catch {
      // ignore — sweeper reaps it
    }
  }

  /**
   * Per-file ceiling for the direct-upload path.
   *
   * `FILE_EXPLORER_MAX_BYTES` is `null` on on-premise deployments — the storage is the customer's
   * own, so we impose no application-level ceiling and the real bound is whatever `file_size_limit`
   * they set on their bucket.
   */
  private assertFileSize(bytes: number): void {
    if (FILE_EXPLORER_MAX_BYTES === null) return;

    if (bytes > FILE_EXPLORER_MAX_BYTES) {
      throw new PayloadTooLargeException(
        `File exceeds the maximum size of ${formatMaxUpload(FILE_EXPLORER_MAX_BYTES)}`,
      );
    }
  }

  /** Shared up-front storage-quota gate. 0-byte files skip it, matching `uploadNewFile`. */
  private async assertQuota(user: RequestUser, bytes: number): Promise<void> {
    this.assertFileSize(bytes);

    if (bytes <= 0) return;

    const check = await this.storageConfig.checkUploadAllowed(
      user.organizationId,
      user.userId,
      bytes,
    );

    if (!check.allowed) {
      throw this.quotaExceeded(check);
    }
  }

  /**
   * Build the 413 thrown when an upload would exceed the space's storage quota.
   *
   * `PayloadTooLargeException({ error, quota, ... })` alone produces a response with no `message`
   * and no `data` key, so `AllExceptionsFilter` falls back to Nest's de-camelised class name and
   * the client receives `"Payload Too Large Exception"` with the numbers stripped. The filter
   * forwards `message`, `code` and `data`, so all three are supplied explicitly here and the UI
   * can tell the user how much room is actually left (XE-T435).
   */
  private quotaExceeded(check: {
    quota: number;
    used: number;
    remaining: number;
  }): PayloadTooLargeException {
    return new PayloadTooLargeException({
      code: 'storageQuotaExceeded',
      message:
        `Storage quota exceeded. ${formatMaxUpload(check.used)} of ` +
        `${formatMaxUpload(check.quota)} used, ${formatMaxUpload(check.remaining)} free.`,
      data: {
        error: 'storageQuotaExceeded',
        quota: check.quota,
        used: check.used,
        remaining: check.remaining,
      },
    });
  }

  // ── NODE-CENTRIC ─────────────────────────────────────────────────────────

  async getNode(user: RequestUser, id: string): Promise<IFeNode> {
    const node = await this.repo.findNode(id);

    await this.assertAccess(user, node);

    const enriched = await this.repo.enrichNodes([node], user.userId);

    return enriched[0];
  }

  async getDownloadInfo(
    user: RequestUser,
    id: string,
    versionNumber?: number,
  ): Promise<PublicDownloadInfo> {
    const node = await this.repo.findNode(id);

    await this.assertAccess(user, node);

    if (node.node_type === 'folder') {
      if (versionNumber) {
        throw new BadRequestException(
          'Folder downloads do not support versions',
        );
      }

      return this.getFolderDownloadInfo(node);
    }

    const version = await this.repo.resolveVersion(node, versionNumber);
    const signedUrl = await this.storage.signedDownloadUrl(
      version.file_path,
      node.name,
    );

    return { type: 'file', signedUrl };
  }

  async getPreviewInfo(
    user: RequestUser,
    id: string,
    expectedSpaceId?: string,
  ): Promise<{ url: string | null }> {
    const node = await this.repo.findFileNode(id);

    if (expectedSpaceId) {
      this.assertSameSpace(node, expectedSpaceId, user.organizationId);
    }

    await this.assertAccess(user, node);

    if (!isInlinePreviewSupported(node)) {
      return { url: null };
    }

    // resolveVersion throws NotFoundException when current_version_id is null or
    // the version row is missing/inactive — catch it and return null gracefully so
    // the UI shows "no preview" instead of propagating a 404.
    let version: IFeVersion | null = null;

    try {
      version = await this.repo.resolveVersion(node);
    } catch {
      return { url: null };
    }

    if (!version.file_path) {
      return { url: null };
    }

    const url = await this.storage.signedViewUrl(version.file_path);

    return { url };
  }

  async getVersions(user: RequestUser, id: string): Promise<IFeVersion[]> {
    const node = await this.repo.findFileNode(id);

    await this.assertAccess(user, node);

    return this.repo.listVersions(id);
  }

  async uploadVersion(
    user: RequestUser,
    id: string,
    file: Express.Multer.File,
    comment?: string,
  ): Promise<IFeNode> {
    if (file.size > 0) {
      const check = await this.storageConfig.checkUploadAllowed(
        user.organizationId,
        user.userId,
        file.size,
      );

      if (!check.allowed) {
        throw this.quotaExceeded(check);
      }
    }

    this.storage.assertAllowed(file);

    const node = await this.repo.findFileNode(id);

    await this.assertAccess(user, node);

    await this.addVersion(node, file, comment ?? null, user);
    const enriched = await this.repo.enrichNodes(
      [await this.repo.findNode(id)],
      user.userId,
    );

    return enriched[0];
  }

  async rename(
    user: RequestUser,
    id: string,
    dto: UpdateNodeDto,
    expectedSpaceId?: string,
  ): Promise<IFeNode> {
    const node = await this.repo.findNode(id);

    if (expectedSpaceId) {
      this.assertSameSpace(node, expectedSpaceId, user.organizationId);
    }

    await this.assertAccess(user, node, 'create');

    const name = dto.name === undefined ? undefined : dto.name.trim();

    if (name !== undefined && name.length === 0) {
      throw new BadRequestException('Name is required');
    }

    try {
      const updated = await this.repo.updateNode(id, user.userId, {
        name,
        description: dto.description,
      });

      void this.auditLogs.logAction(
        user.organizationId,
        user.userId,
        'file_explorer_node',
        id,
        'update',
        { action: 'rename', name },
      );

      return updated;
    } catch (err: any) {
      if (err?.code === '23505') {
        throw new ConflictException(
          'A file or folder with this name already exists here',
        );
      }

      throw err;
    }
  }

  // ── LABELS ───────────────────────────────────────────────────────────────

  async listLabels(spaceId: string, orgId: string): Promise<IFeLabel[]> {
    const r = await this.db
      .from('fe_labels')
      .select('*')
      .eq('space_id', spaceId)
      .eq('organization_id', orgId)
      .order('name');

    return (r.data ?? []) as IFeLabel[];
  }

  /**
   * Real Supabase storage usage for a space: the total active-version byte footprint (true bucket usage),
   * plus the per-space quota (display-only soft cap from the module settings; default 5 GB).
   */
  async getStorageUsage(
    user: RequestUser,
    spaceId: string,
  ): Promise<{ used_bytes: number; total_bytes: number; file_count: number }> {
    const DEFAULT_QUOTA_BYTES = DEFAULT_STORAGE_QUOTA_BYTES;

    const { data, error } = await this.db.rpc('fe_space_storage', {
      p_space_id: spaceId,
      p_org_id: user.organizationId,
    });

    if (error) throw error;

    const row: any = Array.isArray(data) ? data[0] : data;
    const usedBytes = Number(row?.used_bytes ?? 0);
    const fileCount = Number(row?.file_count ?? 0);

    // Optional per-space quota override stored on the file_explorer module's settings.
    const { data: moduleRow } = await this.db
      .from('space_modules')
      .select('settings')
      .eq('space_id', spaceId)
      .eq('module_type', 'file_explorer')
      .maybeSingle();

    const quota = Number(moduleRow?.settings?.fe_storage_quota_bytes);

    return {
      used_bytes: usedBytes,
      total_bytes:
        Number.isFinite(quota) && quota > 0 ? quota : DEFAULT_QUOTA_BYTES,
      file_count: fileCount,
    };
  }

  async getOrganizationStorageUsage(
    user: RequestUser,
  ): Promise<IFeOrganizationStorageUsage> {
    if (!user.organizationId) {
      throw new UnauthorizedException('No active organization');
    }

    return this.repo.getOrganizationStorageUsage(user.organizationId);
  }

  async createLabel(
    user: RequestUser,
    spaceId: string,
    dto: CreateLabelDto,
  ): Promise<IFeLabel> {
    if (dto.space_id !== spaceId) {
      throw new BadRequestException(
        'space_id in body must match route parameter',
      );
    }

    try {
      const r = await this.db
        .from('fe_labels')
        .insert({
          space_id: spaceId,
          organization_id: user.organizationId,
          name: dto.name.trim(),
          color: dto.color ?? '#6366f1',
          created_by: user.userId,
        })
        .select('*')
        .single();

      if (r.error) throw r.error;

      return r.data as IFeLabel;
    } catch (err: any) {
      if (err?.code === '23505') {
        throw new ConflictException(
          'A label with this name already exists in this space',
        );
      }

      throw err;
    }
  }

  async assignLabel(
    user: RequestUser,
    nodeId: string,
    labelId: string,
  ): Promise<void> {
    const node = await this.repo.findNode(nodeId);

    if (node.organization_id !== user.organizationId) {
      throw new NotFoundException('Not found');
    }

    // Validate the label belongs to the same space+org
    const lr = await this.db
      .from('fe_labels')
      .select('id')
      .eq('id', labelId)
      .eq('space_id', node.space_id)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (!lr.data) throw new NotFoundException('Label not found');

    await this.db.from('fe_node_labels').upsert(
      {
        node_id: nodeId,
        label_id: labelId,
        assigned_by: user.userId,
        assigned_at: new Date().toISOString(),
      },
      { onConflict: 'node_id,label_id', ignoreDuplicates: true },
    );
  }

  async unassignLabel(
    user: RequestUser,
    nodeId: string,
    labelId: string,
  ): Promise<void> {
    const node = await this.repo.findNode(nodeId);

    if (node.organization_id !== user.organizationId) {
      throw new NotFoundException('Not found');
    }

    await this.db
      .from('fe_node_labels')
      .delete()
      .eq('node_id', nodeId)
      .eq('label_id', labelId);
  }

  // ── STARS ─────────────────────────────────────────────────────────────────

  async starNode(user: RequestUser, nodeId: string): Promise<void> {
    // Org gate only — a user can star any node they can see (even via a share)
    const node = await this.repo.findNode(nodeId);

    if (node.organization_id !== user.organizationId)
      throw new NotFoundException('Not found');

    await this.db.from('fe_stars').upsert(
      {
        node_id: nodeId,
        user_id: user.userId,
        starred_at: new Date().toISOString(),
      },
      { onConflict: 'node_id,user_id', ignoreDuplicates: true },
    );
  }

  async unstarNode(user: RequestUser, nodeId: string): Promise<void> {
    await this.db
      .from('fe_stars')
      .delete()
      .eq('node_id', nodeId)
      .eq('user_id', user.userId);
  }

  // ── REMINDERS ─────────────────────────────────────────────────────────────

  async listReminders(
    userId: string,
    orgId: string,
    spaceId: string,
  ): Promise<IFeReminder[]> {
    // Two-query approach: PostgREST !inner join filters may silently fail on nullable FK joins.
    // Fetch node IDs for the space first, then scope reminders to those IDs.
    const nodesResult = await this.db
      .from('fe_nodes')
      .select('id')
      .eq('space_id', spaceId)
      .eq('organization_id', orgId)
      .eq('is_deleted', false);

    const nodeIds = (nodesResult.data ?? []).map((n: any) => n.id as string);

    if (nodeIds.length === 0) return [];

    const r = await this.db
      .from('fe_reminders')
      .select('*')
      .eq('user_id', userId)
      .eq('organization_id', orgId)
      .eq('is_sent', false)
      .in('node_id', nodeIds)
      .order('remind_at');

    return (r.data ?? []) as IFeReminder[];
  }

  async createReminder(
    user: RequestUser,
    nodeId: string,
    dto: CreateReminderDto,
  ): Promise<IFeReminder> {
    if (new Date(dto.remind_at) <= new Date()) {
      throw new BadRequestException('remind_at must be in the future');
    }

    const node = await this.repo.findNode(nodeId);

    if (node.organization_id !== user.organizationId)
      throw new NotFoundException('Not found');

    const r = await this.db
      .from('fe_reminders')
      .insert({
        node_id: nodeId,
        user_id: user.userId,
        organization_id: user.organizationId,
        remind_at: dto.remind_at,
        message: dto.message ?? null,
        reminder_type: dto.reminder_type ?? 'in_app',
      })
      .select('*')
      .single();

    if (r.error) throw r.error;

    return r.data as IFeReminder;
  }

  async deleteReminder(user: RequestUser, reminderId: string): Promise<void> {
    const r = await this.db
      .from('fe_reminders')
      .select('id')
      .eq('id', reminderId)
      .eq('user_id', user.userId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (!r.data) throw new NotFoundException('Reminder not found');

    await this.db.from('fe_reminders').delete().eq('id', reminderId);
  }

  /** List the current user's pending reminders for a specific node. */
  async listNodeReminders(
    user: RequestUser,
    nodeId: string,
  ): Promise<IFeReminder[]> {
    const r = await this.db
      .from('fe_reminders')
      .select('*')
      .eq('node_id', nodeId)
      .eq('user_id', user.userId)
      .eq('organization_id', user.organizationId)
      .eq('is_sent', false)
      .order('remind_at');

    return (r.data ?? []) as IFeReminder[];
  }

  // ── INTERNAL ─────────────────────────────────────────────────────────────

  /**
   * Race-safe version upload: retry on unique constraint violation (23505) on
   * fe_versions_node_id_version_number_key. Storage key uses version UUID so
   * concurrent uploads always write to disjoint paths regardless.
   */
  private async addVersion(
    node: IFeNode,
    file: Express.Multer.File,
    comment: string | null,
    user: RequestUser,
  ): Promise<string> {
    for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
      const { data: vNum } = await this.db.rpc('next_fe_version_number', {
        p_node_id: node.id,
      });
      const versionId = randomUUID();
      const path = this.storage.buildKey(node, versionId, file.originalname);

      // 1. Insert version row as pending
      const { error: insertErr } = await this.db.from('fe_versions').insert({
        id: versionId,
        node_id: node.id,
        version_number: vNum,
        file_path: path,
        file_size: file.size,
        mime_type: file.mimetype,
        comment,
        uploaded_by: user.userId,
        upload_status: 'pending',
      });

      if (insertErr?.code === '23505') continue; // race — retry with new number
      if (insertErr) throw insertErr;

      // 2. Upload bytes; clean up pending row on failure
      try {
        await this.storage.upload(path, file);
      } catch (uploadErr) {
        // Best-effort cleanup: remove the pending version row
        try {
          await this.db.from('fe_versions').delete().eq('id', versionId);
        } catch {
          // ignore cleanup errors
        }

        throw uploadErr;
      }

      // 3. Activate version + sync denorm on the node.
      // Error-checked + ordered (activate BEFORE the node points at it): if activation fails we throw,
      // leaving the row 'pending' and UNREFERENCED → safely reaped later. This prevents a version being
      // left 'pending' while current_version_id already references it (which the sweeper must never delete).
      const { error: activateErr } = await this.db
        .from('fe_versions')
        .update({ upload_status: 'active' })
        .eq('id', versionId);

      if (activateErr) {
        throw new Error(`Failed to activate version: ${activateErr.message}`);
      }

      const { error: nodeErr } = await this.db
        .from('fe_nodes')
        .update({
          current_version_id: versionId,
          file_size: file.size,
          mime_type: file.mimetype,
          updated_by: user.userId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', node.id);

      if (nodeErr) {
        throw new Error(
          `Failed to update node after version upload: ${nodeErr.message}`,
        );
      }

      void this.auditLogs.logAction(
        node.organization_id,
        user.userId,
        'file_explorer_node',
        node.id,
        'update',
        {
          action: 'version',
          version_number: vNum,
        },
      );

      return versionId;
    }

    throw new ConflictException('Version number conflict — please retry');
  }

  // ── SHARES ───────────────────────────────────────────────────────────────

  async listShares(user: RequestUser, nodeId: string): Promise<IFeShare[]> {
    const node = await this.repo.findNode(nodeId);

    if (node.organization_id !== user.organizationId)
      throw new NotFoundException('Not found');

    // Only space members can view/manage shares — recipients cannot re-share.
    const isMember = await this.repo.isSpaceMember(
      user.userId,
      node.space_id,
      user.organizationId,
    );

    if (!isMember)
      throw new ForbiddenException('Only space members can manage shares');

    const r = await this.db
      .from('fe_shares')
      .select(
        'id, node_id, organization_id, share_type, shared_with_id, ' +
          'can_view, can_create, can_delete, token, expires_at, is_active, ' +
          'shared_by, created_at, updated_at, password_hash, ' +
          'shared_with_user:users!fe_shares_shared_with_id_fkey(id, first_name, last_name, email, avatar_url)',
      )
      .eq('node_id', nodeId)
      .eq('organization_id', user.organizationId)
      .order('created_at');

    // Derive has_password from password_hash; strip the hash before returning.
    return (r.data ?? []).map((share) => {
      const { password_hash, ...rest } = share as any;
      return { ...rest, has_password: !!password_hash };
    }) as unknown as IFeShare[];
  }

  async createShare(
    user: RequestUser,
    nodeId: string,
    dto: CreateShareDto,
  ): Promise<IFeShare> {
    const node = await this.repo.findNode(nodeId);

    if (node.organization_id !== user.organizationId)
      throw new NotFoundException('Not found');

    // Only space members can create shares — recipients cannot re-share (v1).
    const isMember = await this.repo.isSpaceMember(
      user.userId,
      node.space_id,
      user.organizationId,
    );

    if (!isMember)
      throw new ForbiddenException('Only space members can manage shares');

    // Reject share-to-self.
    if (dto.share_type === 'user' && dto.shared_with_id === user.userId) {
      throw new BadRequestException('Cannot share a node with yourself');
    }

    // Permission ceiling — sharer cannot grant more than they own.
    // Resolve the sharer's effective permissions on this node and cap the granted values.
    const sharerPerm = await this.access.resolveEffectivePermission(user, node);
    const grantCanCreate = (dto.can_create ?? false) && sharerPerm.canCreate;
    const grantCanDelete = (dto.can_delete ?? false) && sharerPerm.canDelete;
    // can_view is always granted — a share without view access is meaningless.

    // For user shares, verify target is in the same org.
    if (dto.share_type === 'user' && dto.shared_with_id) {
      const targetCheck = await this.db
        .from('organization_members')
        .select('id')
        .eq('user_id', dto.shared_with_id)
        .eq('organization_id', user.organizationId)
        .maybeSingle();

      if (!targetCheck.data)
        throw new BadRequestException(
          'Target user is not in your organisation',
        );
    }

    // For link shares: check if one already exists for this node (DB allows only one via
    // NULLS NOT DISTINCT unique constraint on (node_id, share_type, shared_with_id)).
    // If it exists, UPDATE it — preserving the token so the link URL doesn't change.
    if (dto.share_type === 'link') {
      const existing = await this.db
        .from('fe_shares')
        .select('id, token, password_hash')
        .eq('node_id', nodeId)
        .eq('share_type', 'link')
        .maybeSingle();

      const passwordHash = dto.password
        ? await bcrypt.hash(dto.password, 10)
        : (existing.data?.password_hash ?? null);

      const upsertData: Record<string, unknown> = {
        node_id: nodeId,
        organization_id: user.organizationId,
        share_type: 'link',
        shared_with_id: null,
        can_view: true,
        can_create: grantCanCreate,
        can_delete: grantCanDelete,
        expires_at: dto.expires_at ?? null,
        is_active: true,
        shared_by: user.userId,
        password_hash: passwordHash,
      };

      if (existing.data) {
        // Preserve existing token — the link URL must not change on update.
        const r = await this.db
          .from('fe_shares')
          .update({ ...upsertData, updated_at: new Date().toISOString() })
          .eq('id', existing.data.id)
          .select(
            'id, node_id, organization_id, share_type, shared_with_id, can_view, can_create, can_delete, token, expires_at, is_active, shared_by, created_at, updated_at',
          )
          .single();

        if (r.error) throw r.error;

        void this.auditLogs.logAction(
          user.organizationId,
          user.userId,
          'file_explorer_node',
          nodeId,
          'update',
          { action: 'share_create', share_type: 'link' },
        );

        return r.data as IFeShare;
      } else {
        const { randomBytes } = await import('crypto');

        upsertData['token'] = randomBytes(32).toString('base64url');

        const r = await this.db
          .from('fe_shares')
          .insert(upsertData)
          .select(
            'id, node_id, organization_id, share_type, shared_with_id, can_view, can_create, can_delete, token, expires_at, is_active, shared_by, created_at, updated_at',
          )
          .single();

        if (r.error) throw r.error;

        void this.auditLogs.logAction(
          user.organizationId,
          user.userId,
          'file_explorer_node',
          nodeId,
          'update',
          { action: 'share_create', share_type: 'link' },
        );

        return r.data as IFeShare;
      }
    }

    // User share — standard upsert (update perms if already shared with this user).
    const passwordHash = dto.password
      ? await bcrypt.hash(dto.password, 10)
      : null;

    const insertData: Record<string, unknown> = {
      node_id: nodeId,
      organization_id: user.organizationId,
      share_type: dto.share_type,
      shared_with_id: dto.shared_with_id ?? null,
      can_view: true, // always granted; minimum for any useful share
      can_create: grantCanCreate,
      can_delete: grantCanDelete,
      expires_at: dto.expires_at ?? null,
      is_active: true,
      shared_by: user.userId,
      ...(passwordHash ? { password_hash: passwordHash } : {}),
    };

    const r = await this.db
      .from('fe_shares')
      .upsert(insertData, {
        onConflict: 'node_id,share_type,shared_with_id',
        ignoreDuplicates: false,
      })
      .select(
        'id, node_id, organization_id, share_type, shared_with_id, can_view, can_create, can_delete, token, expires_at, is_active, shared_by, created_at, updated_at',
      )
      .single();

    if (r.error) throw r.error;

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'file_explorer_node',
      nodeId,
      'update',
      { action: 'share_create', share_type: dto.share_type },
    );

    return r.data as IFeShare;
  }

  async updateShare(
    user: RequestUser,
    shareId: string,
    dto: UpdateShareDto,
  ): Promise<IFeShare> {
    const existing = await this.db
      .from('fe_shares')
      .select('*')
      .eq('id', shareId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (!existing.data) throw new NotFoundException('Share not found');

    // Only space members can update shares.
    const shareNode = await this.repo.findNode(existing.data.node_id);
    const isMember = await this.repo.isSpaceMember(
      user.userId,
      shareNode.space_id,
      user.organizationId,
    );

    if (!isMember)
      throw new ForbiddenException('Only space members can manage shares');

    // Strip plaintext password from the update; hash if provided, clear if null.
    const { password: rawPassword, ...safeDto } = dto as typeof dto & {
      password?: string | null;
    };
    const updateData: Record<string, unknown> = {
      ...safeDto,
      updated_at: new Date().toISOString(),
    };

    if (rawPassword === null) {
      updateData['password_hash'] = null;
    } else if (rawPassword) {
      updateData['password_hash'] = await bcrypt.hash(rawPassword, 10);
    }

    const r = await this.db
      .from('fe_shares')
      .update(updateData)
      .eq('id', shareId)
      .select(
        'id, node_id, organization_id, share_type, shared_with_id, can_view, can_create, can_delete, token, expires_at, is_active, shared_by, created_at, updated_at',
      )
      .single();

    if (r.error) throw r.error;

    return r.data as IFeShare;
  }

  async revokeShare(user: RequestUser, shareId: string): Promise<void> {
    const existing = await this.db
      .from('fe_shares')
      .select('node_id')
      .eq('id', shareId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (!existing.data) throw new NotFoundException('Share not found');

    // Only space members can revoke shares.
    const revokeNode = await this.repo.findNode(existing.data.node_id);
    const canRevoke = await this.repo.isSpaceMember(
      user.userId,
      revokeNode.space_id,
      user.organizationId,
    );

    if (!canRevoke)
      throw new ForbiddenException('Only space members can manage shares');

    await this.db
      .from('fe_shares')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', shareId);

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'file_explorer_node',
      existing.data.node_id,
      'update',
      { action: 'share_revoke', share_id: shareId },
    );
  }

  // ── LISTING (shared views) ─────────────────────────────────────────────────

  /** Nodes shared directly with the current user (cross-space; filtered to one space if provided). */
  async sharedWithMe(user: RequestUser, spaceId?: string): Promise<IFeNode[]> {
    const now = new Date().toISOString();

    const sharesResult = await this.db
      .from('fe_shares')
      .select('node_id')
      .eq('shared_with_id', user.userId)
      .eq('share_type', 'user')
      .eq('is_active', true)
      .or(`expires_at.is.null,expires_at.gt.${now}`);

    if (!sharesResult.data?.length) return [];

    const nodeIds = sharesResult.data.map((r: any) => r.node_id);

    let nodesQuery = this.db
      .from('fe_nodes')
      .select('*')
      .in('id', nodeIds)
      .eq('organization_id', user.organizationId)
      .eq('is_deleted', false);

    if (spaceId) nodesQuery = nodesQuery.eq('space_id', spaceId);

    const nodesResult = await nodesQuery;
    const nodes = nodesResult.data ?? [];

    return this.repo.enrichNodes(nodes, user.userId);
  }

  /** Nodes the current user has shared (active, unexpired shares, cross-space; deduplicated by node). */
  async sharedFromMe(user: RequestUser, spaceId?: string): Promise<IFeNode[]> {
    const now = new Date().toISOString();

    const sharesResult = await this.db
      .from('fe_shares')
      .select('node_id')
      .eq('shared_by', user.userId)
      .eq('is_active', true)
      .or(`expires_at.is.null,expires_at.gt.${now}`);

    if (!sharesResult.data?.length) return [];

    // Deduplicate — one node can have multiple active shares (user + link types)
    const nodeIds = [
      ...new Set(sharesResult.data.map((r: any) => r.node_id as string)),
    ];

    let nodesQuery = this.db
      .from('fe_nodes')
      .select('*')
      .in('id', nodeIds)
      .eq('organization_id', user.organizationId)
      .eq('is_deleted', false);

    if (spaceId) nodesQuery = nodesQuery.eq('space_id', spaceId);

    const nodesResult = await nodesQuery;
    const nodes = nodesResult.data ?? [];

    return this.repo.enrichNodes(nodes, user.userId);
  }

  /** List direct children of a shared folder (accessible to non-members via access service). */
  async listChildren(
    user: RequestUser,
    folderId: string,
    query: ListNodesQueryDto,
  ): Promise<IFeNode[]> {
    const folder = await this.repo.findNode(folderId);
    const perm = await this.access.resolveEffectivePermission(user, folder);

    if (!perm.canView) throw new NotFoundException('Not found');

    const children = await this.repo.listNodes(
      folder.space_id,
      user.organizationId,
      'all',
      { ...query, parent_id: folderId },
    );

    return this.repo.enrichNodes(children, user.userId);
  }

  // ── DELETE / RESTORE / PERMANENT DELETE ───────────────────────────────────

  /**
   * Soft-delete a node and its entire subtree atomically.
   * All affected rows share the same delete_op_id so they can be restored together.
   */
  async softDelete(
    user: RequestUser,
    nodeId: string,
    expectedSpaceId?: string,
  ): Promise<void> {
    const node = await this.repo.findNodeAny(nodeId);

    if (expectedSpaceId) {
      this.assertSameSpace(node, expectedSpaceId, user.organizationId);
    }

    await this.assertAccess(user, node, 'delete');

    if (node.is_deleted) return;

    const opId = randomUUID();

    // Collect all descendant IDs (any depth) and the root node itself.
    const descendants = await this.repo.listDescendants(nodeId);
    const allIds = [nodeId, ...descendants.map((d) => d.id)];

    await this.db
      .from('fe_nodes')
      .update({
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        deleted_by: user.userId,
        delete_op_id: opId,
      })
      .in('id', allIds)
      .eq('is_deleted', false); // skip any already-deleted nodes

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'file_explorer_node',
      nodeId,
      'delete',
      { delete_op_id: opId, subtree_count: allIds.length },
    );
  }

  /**
   * Restore a batch of soft-deleted nodes identified by the same delete_op_id.
   * If the batch root's parent is still soft-deleted, re-parents the root to null (space root).
   */
  async restoreNode(user: RequestUser, nodeId: string): Promise<void> {
    // Must use findNodeAny because the node is soft-deleted.
    const node = await this.repo.findNodeAny(nodeId);

    if (node.organization_id !== user.organizationId) {
      throw new NotFoundException('Not found');
    }

    if (!node.delete_op_id) {
      // Individually deleted node with no batch — still restore just this node.
      await this.db
        .from('fe_nodes')
        .update({
          is_deleted: false,
          deleted_at: null,
          deleted_by: null,
          delete_op_id: null,
        })
        .eq('id', nodeId);

      return;
    }

    const opId = node.delete_op_id;

    // Find the batch root: the node in the batch whose parent_id is NOT in the same batch.
    const batchResult = await this.db
      .from('fe_nodes')
      .select('id, parent_id')
      .eq('delete_op_id', opId);

    const batchIds = new Set(
      (batchResult.data ?? []).map((r: any) => r.id as string),
    );
    const batchRoot = (batchResult.data ?? []).find(
      (r: any) => !r.parent_id || !batchIds.has(r.parent_id),
    );

    // If the batch root's parent is also soft-deleted (outside the batch), re-parent to space root.
    if (batchRoot?.parent_id) {
      const parentCheck = await this.db
        .from('fe_nodes')
        .select('is_deleted')
        .eq('id', batchRoot.parent_id)
        .maybeSingle();

      if (parentCheck.data?.is_deleted) {
        // Re-parent to root — trigger fe_set_ancestor_ids fires and clears the root's ancestor_ids.
        await this.db
          .from('fe_nodes')
          .update({ parent_id: null })
          .eq('id', batchRoot.id);

        // The BEFORE-UPDATE trigger only fixes the batch root's own ancestor_ids; its descendants
        // keep stale chains (still referencing the removed parents), which would break breadcrumbs
        // and ancestor-share inheritance. Recompute the whole subtree.
        await this.recomputeSubtreeAncestors(batchRoot.id);
      }
    }

    // Restore the whole batch.
    await this.db
      .from('fe_nodes')
      .update({
        is_deleted: false,
        deleted_at: null,
        deleted_by: null,
        delete_op_id: null,
      })
      .eq('delete_op_id', opId);

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'file_explorer_node',
      nodeId,
      'restore',
      { delete_op_id: opId },
    );
  }

  /**
   * Permanently delete a node, its subtree, and all associated storage bytes.
   * For files: removes the file's storage prefix.
   * For folders: removes storage for every descendant file node first, then hard-deletes the
   *   root (CASCADE removes all descendants, versions, shares, stars, labels, reminders).
   */
  async permanentDelete(user: RequestUser, nodeId: string): Promise<void> {
    const node = await this.repo.findNodeAny(nodeId);

    if (node.organization_id !== user.organizationId) {
      throw new NotFoundException('Not found');
    }

    if (node.node_type === 'file') {
      const prefix = `${node.organization_id}/file-explorer/${node.space_id}/${node.id}`;
      const paths = await this.storage.listPrefix(prefix);

      await this.storage.removePaths(paths);
    } else {
      // Folder: collect ALL descendant file nodes and remove their storage.
      const descendants = await this.repo.listDescendants(nodeId);
      const fileDescendants = descendants.filter((d) => d.node_type === 'file');

      for (const fn of fileDescendants) {
        const prefix = `${fn.organization_id}/file-explorer/${fn.space_id}/${fn.id}`;
        const paths = await this.storage.listPrefix(prefix);

        await this.storage.removePaths(paths);
      }
    }

    // Hard-delete the root node; ON DELETE CASCADE removes all descendants + related rows.
    await this.db.from('fe_nodes').delete().eq('id', nodeId);

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'file_explorer_node',
      nodeId,
      'delete',
      { node_type: node.node_type },
    );
  }

  // ── PUBLIC LINK (anonymous access via token) ──────────────────────────────

  getPublicShareAccessCookieName(token: string): string {
    const digest = createHash('sha256')
      .update(token)
      .digest('hex')
      .slice(0, 32);

    return `fe_share_${digest}`;
  }

  /**
   * Return metadata for a public link share. Used by the public landing page
   * to show the file name and whether a password is required before download.
   * Returns 404 for invalid, revoked, or expired tokens.
   */
  async getPublicShareMeta(
    token: string,
  ): Promise<{ node: IFeNode; passwordRequired: boolean }> {
    const result = await this.access.resolvePublicShare(token);

    if (!result) throw new NotFoundException('Share not found or expired');

    const enriched = await this.repo.enrichNodes([result.node], '');

    return {
      node: enriched[0],
      passwordRequired: !!this.getSharePasswordHash(result.share),
    };
  }

  /**
   * Verify the password for a password-protected link share.
   * Returns { valid: true } on success; throws 401 on wrong password.
   * Expiry and revocation are re-checked at verify time.
   */
  async verifyPublicPassword(
    token: string,
    password: string,
  ): Promise<{
    valid: boolean;
    accessCookie?: IPublicShareAccessCookie;
  }> {
    const r = await this.db
      .from('fe_shares')
      .select('id, password_hash, is_active, expires_at')
      .eq('token', token)
      .eq('share_type', 'link')
      .maybeSingle();
    const shareRow = r.data as PublicSharePasswordRow | null;

    if (!shareRow || !shareRow.is_active)
      throw new NotFoundException('Share not found');

    if (shareRow.expires_at && new Date(shareRow.expires_at) <= new Date()) {
      throw new NotFoundException('Share expired');
    }

    // No password set → always valid.
    if (!shareRow.password_hash) return { valid: true };

    // Brute-force lockout (per-token, in-memory; defense-in-depth on top of the per-IP throttle).
    const now = Date.now();
    const lock = pwLockouts.get(token);

    if (lock && lock.until > now) {
      throw new UnauthorizedException(
        'Too many incorrect attempts — please try again later',
      );
    }

    // An expired lock resets the counter so the user gets a fresh window of attempts.
    if (lock && lock.until > 0 && lock.until <= now) {
      pwLockouts.delete(token);
    }

    const valid = await bcrypt.compare(password, shareRow.password_hash);

    if (!valid) {
      const fails = (pwLockouts.get(token)?.fails ?? 0) + 1;

      pwLockouts.set(token, {
        fails,
        until: fails >= PW_MAX_FAILS ? now + PW_LOCK_MS : 0,
      });
      this.prunePwLockouts(now);

      throw new UnauthorizedException('Incorrect password');
    }

    // Success clears any failure state for this token.
    pwLockouts.delete(token);

    return {
      valid: true,
      accessCookie: this.createPublicShareAccessCookie(token, shareRow),
    };
  }

  /** Evict expired lockout entries so the in-memory map stays bounded. */
  private prunePwLockouts(now: number): void {
    if (pwLockouts.size < 1000) return;

    for (const [key, value] of pwLockouts) {
      if (value.until <= now) pwLockouts.delete(key);
    }
  }

  private async resolveVerifiedPublicShare(
    token: string,
    accessCookieValue?: string,
  ): Promise<{ share: IFeShare; node: IFeNode }> {
    const result = await this.access.resolvePublicShare(token);

    if (!result || !result.share.can_view) {
      throw new NotFoundException('Share not found or expired');
    }

    this.assertPublicSharePasswordAccess(
      token,
      result.share,
      accessCookieValue,
    );

    return result;
  }

  private getSharePasswordHash(
    share: PublicSharePasswordSource,
  ): string | null {
    return share.password_hash ?? null;
  }

  private createPublicShareAccessCookie(
    token: string,
    share: PublicSharePasswordSource,
  ): IPublicShareAccessCookie {
    const expiresAt =
      Math.floor(Date.now() / 1000) + PUBLIC_SHARE_ACCESS_TTL_SECONDS;
    const payload = `${share.id}.${expiresAt}`;
    const passwordHash = this.getSharePasswordHash(share);
    const signature = createHmac('sha256', passwordHash ?? '')
      .update(payload)
      .digest('base64url');

    return {
      name: this.getPublicShareAccessCookieName(token),
      value: `${payload}.${signature}`,
      maxAgeSeconds: PUBLIC_SHARE_ACCESS_TTL_SECONDS,
    };
  }

  private assertPublicSharePasswordAccess(
    token: string,
    share: IFeShare,
    accessCookieValue?: string,
  ): void {
    const passwordHash = this.getSharePasswordHash(share);

    if (!passwordHash) return;

    if (
      !accessCookieValue ||
      !this.isValidPublicShareAccessCookie(
        accessCookieValue,
        share,
        passwordHash,
      )
    ) {
      throw new UnauthorizedException('Password required');
    }
  }

  private isValidPublicShareAccessCookie(
    value: string,
    share: IFeShare,
    passwordHash: string,
  ): boolean {
    const [shareId, expiresAtRaw, signature] = value.split('.');
    const expiresAt = Number(expiresAtRaw);

    if (
      !shareId ||
      !expiresAtRaw ||
      !signature ||
      shareId !== share.id ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      return false;
    }

    const expected = createHmac('sha256', passwordHash)
      .update(`${shareId}.${expiresAtRaw}`)
      .digest('base64url');

    return this.timingSafeStringEqual(signature, expected);
  }

  private timingSafeStringEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);

    if (leftBuffer.length !== rightBuffer.length) return false;

    return timingSafeEqual(leftBuffer, rightBuffer);
  }

  /**
   * Generate public download information for a public link share.
   * Node is derived from the token only — never trusted from client.
   * For folder shares, nodeId may specify a descendant; validated via ancestor_ids.
   */
  async getPublicDownloadInfo(
    token: string,
    nodeId?: string,
    accessCookieValue?: string,
  ): Promise<PublicDownloadInfo> {
    const { share, node: shareNode } = await this.resolveVerifiedPublicShare(
      token,
      accessCookieValue,
    );

    let targetNode = shareNode;

    if (nodeId && nodeId !== shareNode.id) {
      // Folder share: allow a descendant only when it's genuinely within the shared subtree.
      const child = await this.repo.findNode(nodeId);

      if (!child.ancestor_ids.includes(shareNode.id)) {
        throw new NotFoundException('Node not accessible via this share');
      }

      if (
        child.organization_id !== share.organization_id ||
        child.space_id !== shareNode.space_id
      ) {
        throw new NotFoundException('Not found');
      }

      targetNode = child;
    }

    if (targetNode.node_type === 'folder') {
      return this.getFolderDownloadInfo(targetNode);
    }

    const version = await this.repo.resolveVersion(targetNode);
    const signedUrl = await this.storage.signedDownloadUrl(
      version.file_path,
      targetNode.name,
    );

    return { type: 'file', signedUrl };
  }

  /**
   * Return public-safe recursive folder contents for a link-shared folder.
   * Uses the same verified public-share flow as preview/download so password,
   * expiry, revocation, and can_view are enforced before descendants are exposed.
   */
  async getPublicFolderContents(
    token: string,
    accessCookieValue?: string,
  ): Promise<IPublicFolderContents> {
    const { node: folder } = await this.resolveVerifiedPublicShare(
      token,
      accessCookieValue,
    );

    if (folder.node_type !== 'folder') {
      throw new BadRequestException('Shared item is not a folder');
    }

    const descendants = await this.repo.listActiveDescendantsForPublicFolder(
      folder.id,
      folder.organization_id,
      folder.space_id,
    );
    const nodeMap = new Map<string, IFeNode>([
      [folder.id, folder],
      ...descendants.map((node) => [node.id, node] as [string, IFeNode]),
    ]);
    const items = descendants
      .map((node) => this.toPublicFolderEntry(folder, node, nodeMap))
      .sort((a, b) =>
        a.relativePath.localeCompare(b.relativePath, undefined, {
          numeric: true,
          sensitivity: 'base',
        }),
      );
    const totalFiles = items.filter((item) => item.nodeType === 'file').length;
    const totalFolders = items.filter(
      (item) => item.nodeType === 'folder',
    ).length;
    const totalBytes = items.reduce(
      (sum, item) =>
        sum + (item.nodeType === 'file' ? (item.fileSize ?? 0) : 0),
      0,
    );

    return {
      root: this.toPublicFolderNodeSummary(folder),
      items,
      totalItems: items.length,
      totalFiles,
      totalFolders,
      totalBytes,
    };
  }

  private toPublicFolderNodeSummary(node: IFeNode): IPublicFolderNodeSummary {
    return {
      id: node.id,
      name: node.name,
      nodeType: node.node_type,
      mimeType: node.mime_type,
      fileSize: node.file_size,
      updatedAt: node.updated_at,
    };
  }

  private toPublicFolderEntry(
    root: IFeNode,
    node: IFeNode,
    nodeMap: Map<string, IFeNode>,
  ): IPublicFolderEntry {
    const rootIndex = node.ancestor_ids.indexOf(root.id);
    const relativeAncestorIds =
      rootIndex >= 0 ? node.ancestor_ids.slice(rootIndex + 1) : [];
    const visibleAncestorIds = relativeAncestorIds.filter((id) =>
      nodeMap.has(id),
    );
    const ancestorNames = visibleAncestorIds
      .map((id) => nodeMap.get(id)?.name)
      .filter((name): name is string => !!name);
    const relativePath = [...ancestorNames, node.name].join('/');

    return {
      ...this.toPublicFolderNodeSummary(node),
      parentId: node.parent_id,
      depth: visibleAncestorIds.length,
      relativePath,
    };
  }

  private async getFolderDownloadInfo(
    folder: IFeNode,
  ): Promise<PublicDownloadInfo> {
    const descendants = await this.repo.listActiveDescendantsForPublicFolder(
      folder.id,
      folder.organization_id,
      folder.space_id,
    );
    const nodeMap = new Map<string, IFeNode>([
      [folder.id, folder],
      ...descendants.map((node) => [node.id, node] as [string, IFeNode]),
    ]);
    const fileNodes = descendants
      .filter((node) => node.node_type === 'file')
      .sort((a, b) =>
        this.buildArchivePath(folder, a, nodeMap).localeCompare(
          this.buildArchivePath(folder, b, nodeMap),
        ),
      );

    if (fileNodes.length === 0) {
      throw new BadRequestException('Folder has no downloadable files');
    }

    if (fileNodes.length > PUBLIC_FOLDER_ZIP_MAX_FILES) {
      throw new PayloadTooLargeException(
        `Folder contains too many files to download at once (maximum ${PUBLIC_FOLDER_ZIP_MAX_FILES})`,
      );
    }

    if (fileNodes.some((node) => !node.current_version_id)) {
      throw new NotFoundException('One or more files have no active version');
    }

    const versionMap = await this.repo.listActiveVersionsByIds(
      fileNodes.map((node) => node.current_version_id!),
    );
    const usedPaths = new Map<string, number>();
    const entries: IFeZipEntry[] = [];
    let totalBytes = 0;

    for (const fileNode of fileNodes) {
      const version = versionMap.get(fileNode.current_version_id!);

      if (!version?.file_path) {
        throw new NotFoundException('One or more files have no active version');
      }

      const size = Number(version.file_size ?? fileNode.file_size ?? 0);

      totalBytes += size;

      if (totalBytes > PUBLIC_FOLDER_ZIP_MAX_BYTES) {
        throw new PayloadTooLargeException(
          `Folder is too large to download at once (maximum ${Math.floor(
            PUBLIC_FOLDER_ZIP_MAX_BYTES / 1024 / 1024,
          )} MB)`,
        );
      }

      entries.push({
        archivePath: this.uniqueArchivePath(
          this.buildArchivePath(folder, fileNode, nodeMap),
          usedPaths,
        ),
        storagePath: version.file_path,
        size,
      });
    }

    return {
      type: 'zip',
      fileName: `${this.sanitizeArchiveSegment(folder.name)}.zip`,
      entries,
      totalBytes,
    };
  }

  private buildArchivePath(
    folder: IFeNode,
    fileNode: IFeNode,
    nodeMap: Map<string, IFeNode>,
  ): string {
    const folderIndex = fileNode.ancestor_ids.indexOf(folder.id);
    const relativeAncestorIds =
      folderIndex >= 0 ? fileNode.ancestor_ids.slice(folderIndex + 1) : [];
    const segments = relativeAncestorIds
      .map((id) => nodeMap.get(id)?.name)
      .filter((name): name is string => !!name)
      .map((name) => this.sanitizeArchiveSegment(name));

    segments.push(this.sanitizeArchiveSegment(fileNode.name));

    return segments.join('/');
  }

  private uniqueArchivePath(
    path: string,
    usedPaths: Map<string, number>,
  ): string {
    const usedCount = usedPaths.get(path) ?? 0;

    usedPaths.set(path, usedCount + 1);

    if (usedCount === 0) return path;

    const lastSlash = path.lastIndexOf('/');
    const directory = lastSlash >= 0 ? `${path.slice(0, lastSlash + 1)}` : '';
    const fileName = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
    const extensionIndex = fileName.lastIndexOf('.');
    const hasExtension = extensionIndex > 0;
    const baseName = hasExtension
      ? fileName.slice(0, extensionIndex)
      : fileName;
    const extension = hasExtension ? fileName.slice(extensionIndex) : '';

    return `${directory}${baseName} (${usedCount + 1})${extension}`;
  }

  private sanitizeArchiveSegment(name: string): string {
    const segment = name
      .normalize('NFC')
      .replace(/[/\\]/g, '_')
      .replace(/[<>:"|?*]/g, '_')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim();

    return (segment || 'item').slice(0, 180);
  }

  /**
   * Return a short-TTL signed view URL for a public link share.
   * Returns { url: null } for folders, unsupported MIME types, or missing versions.
   */
  async getPublicPreviewUrl(
    token: string,
    accessCookieValue?: string,
  ): Promise<{ url: string | null }> {
    const { node } = await this.resolveVerifiedPublicShare(
      token,
      accessCookieValue,
    );

    if (node.node_type !== 'file') return { url: null };

    if (!isInlinePreviewSupported(node)) return { url: null };

    const version = await this.repo.resolveVersion(node);

    if (!version?.file_path) return { url: null };

    const url = await this.storage.signedViewUrl(version.file_path);

    return { url };
  }

  // ── MOVE / COPY / RESTORE VERSION ─────────────────────────────────────────

  async moveNode(
    user: RequestUser,
    nodeId: string,
    dto: { target_parent_id?: string; space_id: string },
  ): Promise<IFeNode> {
    const node = await this.repo.findNode(nodeId);

    await this.assertAccess(user, node, 'delete');

    let destFolder: IFeNode | null = null;

    if (dto.target_parent_id) {
      destFolder = await this.repo.findNode(dto.target_parent_id);

      if (
        dto.target_parent_id === nodeId ||
        destFolder.ancestor_ids.includes(nodeId)
      ) {
        throw new BadRequestException(
          'Cannot move a node into itself or a descendant',
        );
      }

      if (destFolder.space_id !== node.space_id) {
        throw new BadRequestException('Cannot move across spaces');
      }

      if (destFolder.node_type !== 'folder') {
        throw new BadRequestException('Destination must be a folder');
      }
    }

    // Destination create-permission applies to BOTH a target folder and the space root —
    // moving to root must still require create permission on the node's space.
    const destPerm = await this.access.resolveEffectivePermission(
      user,
      destFolder ?? node,
    );

    if (!destPerm.canCreate) {
      throw new NotFoundException('No create access on destination');
    }

    // Supabase resolves (does not throw) on a constraint violation, so we MUST inspect `.error`.
    // A name collision at the destination surfaces as 23505 → map to 409 instead of failing silently.
    const { error: moveError } = await this.db
      .from('fe_nodes')
      .update({
        parent_id: dto.target_parent_id ?? null,
        updated_by: user.userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', nodeId);

    if (moveError) {
      if (moveError.code === '23505') {
        throw new ConflictException(
          'A file or folder with this name already exists in the destination',
        );
      }

      throw moveError;
    }

    await this.recomputeSubtreeAncestors(nodeId);

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'file_explorer_node',
      nodeId,
      'update',
      { action: 'move', target_parent_id: dto.target_parent_id },
    );

    return this.repo.findNode(nodeId);
  }

  async copyNode(
    user: RequestUser,
    nodeId: string,
    dto: { target_parent_id?: string; space_id: string },
  ): Promise<IFeNode> {
    const node = await this.repo.findNode(nodeId);

    await this.assertAccess(user, node, 'view');

    let destFolder: IFeNode | null = null;

    if (dto.target_parent_id) {
      destFolder = await this.repo.findNode(dto.target_parent_id);

      if (destFolder.space_id !== node.space_id)
        throw new BadRequestException('Cannot copy across spaces');
    }

    // Destination create-permission applies to BOTH a target folder and the space root.
    const destPerm = await this.access.resolveEffectivePermission(
      user,
      destFolder ?? node,
    );

    if (!destPerm.canCreate)
      throw new NotFoundException('No create access on destination');

    const newNodeId = await this.cloneSubtree(
      node,
      dto.target_parent_id ?? null,
      user,
      0,
    );

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'file_explorer_node',
      newNodeId,
      'create',
      { action: 'copy', source_id: nodeId },
    );

    return this.repo.findNode(newNodeId);
  }

  async restoreVersion(
    user: RequestUser,
    nodeId: string,
    versionId: string,
  ): Promise<IFeNode> {
    const node = await this.repo.findFileNode(nodeId);

    await this.assertAccess(user, node, 'create');

    const vr = await this.db
      .from('fe_versions')
      .select('*')
      .eq('id', versionId)
      .eq('node_id', nodeId)
      .eq('upload_status', 'active')
      .maybeSingle();

    if (!vr.data) throw new NotFoundException('Version not found');

    const v = vr.data;

    await this.db
      .from('fe_nodes')
      .update({
        current_version_id: versionId,
        file_size: v.file_size,
        mime_type: v.mime_type,
        updated_by: user.userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', nodeId);

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'file_explorer_node',
      nodeId,
      'update',
      { action: 'restore_version', version_id: versionId },
    );

    return this.repo.findNode(nodeId);
  }

  // ── INTERNAL ─────────────────────────────────────────────────────────────

  /**
   * Access gate — resolves effective permission via FileExplorerAccessService.
   * Returns 404 on any failure to avoid leaking node existence.
   */
  private async assertAccess(
    user: RequestUser,
    node: IFeNode,
    require: 'view' | 'create' | 'delete' = 'view',
  ): Promise<void> {
    const perm = await this.access.resolveEffectivePermission(user, node);

    const granted =
      require === 'view'
        ? perm.canView
        : require === 'create'
          ? perm.canCreate
          : perm.canDelete;

    if (!granted) throw new NotFoundException('Not found');
  }

  /** Validate that a node belongs to the expected space and organisation. */
  private assertSameSpace(node: IFeNode, spaceId: string, orgId: string): void {
    if (node.space_id !== spaceId || node.organization_id !== orgId) {
      throw new NotFoundException('Node not found in this space');
    }
  }

  /**
   * Recompute ancestor_ids for all descendants of a moved node.
   * The BEFORE-UPDATE trigger already updated the moved node's own ancestor_ids.
   * This method propagates those changes down the subtree level by level.
   */
  private async recomputeSubtreeAncestors(movedNodeId: string): Promise<void> {
    const movedNode = await this.repo.findNode(movedNodeId);
    const descendants = await this.repo.listDescendants(movedNodeId);

    if (descendants.length === 0) return;

    // Build a map so each descendant can derive its ancestors from its parent.
    const ancestorMap = new Map<string, string[]>([
      [movedNodeId, movedNode.ancestor_ids],
    ]);

    // Sort by ancestor_ids length (shorter = closer to root = process first).
    const sorted = descendants
      .slice()
      .sort((a, b) => a.ancestor_ids.length - b.ancestor_ids.length);

    for (const d of sorted) {
      const parentAncs = d.parent_id
        ? (ancestorMap.get(d.parent_id) ?? [])
        : [];
      const newAncs: string[] = [
        ...parentAncs,
        ...(d.parent_id ? [d.parent_id] : []),
      ];

      await this.db
        .from('fe_nodes')
        .update({ ancestor_ids: newAncs })
        .eq('id', d.id);

      ancestorMap.set(d.id, newAncs);
    }
  }

  /**
   * Recursively clone a node and its subtree to a new location.
   * For files: duplicates the current version bytes via storage.copyObject (independent bytes).
   * Auto-suffixes name with (2), (3)... on name collision.
   * Depth-capped at 50 levels.
   */
  private async cloneSubtree(
    node: IFeNode,
    targetParentId: string | null,
    user: RequestUser,
    depth: number,
    counter: { count: number } = { count: 0 },
  ): Promise<string> {
    const MAX_COPY_NODES = 500;

    if (depth > 50) {
      throw new BadRequestException(
        'Folder nesting too deep to copy (max 50 levels)',
      );
    }

    // Bound total subtree size to avoid an unbounded synchronous clone (timeout / DoS).
    counter.count += 1;

    if (counter.count > MAX_COPY_NODES) {
      throw new BadRequestException(
        `Copy is too large (max ${MAX_COPY_NODES} items); please copy smaller folders`,
      );
    }

    const newId = randomUUID();
    let name = node.name;

    for (let attempt = 0; attempt <= 9; attempt++) {
      if (attempt > 0) name = `${node.name} (${attempt + 1})`;

      const { error } = await this.db.from('fe_nodes').insert({
        id: newId,
        organization_id: node.organization_id,
        space_id: node.space_id,
        parent_id: targetParentId,
        node_type: node.node_type,
        name,
        description: node.description,
        mime_type: node.mime_type,
        file_size: node.file_size,
        created_by: user.userId,
        updated_by: user.userId,
      });

      if (!error) break;

      if (error.code === '23505') {
        if (attempt < 9) continue;

        throw new ConflictException(
          'Could not find an available name for the copied item',
        );
      }

      throw error;
    }

    // For files: copy current version bytes as v1 on the new node.
    if (node.node_type === 'file' && node.current_version_id) {
      const srcVersion = await this.repo.resolveVersion(node);
      const newVersionId = randomUUID();
      const newPath = this.storage.buildKey(
        {
          organization_id: node.organization_id,
          space_id: node.space_id,
          id: newId,
        },
        newVersionId,
        node.name,
      );

      await this.storage.copyObject(srcVersion.file_path, newPath);

      await this.db.from('fe_versions').insert({
        id: newVersionId,
        node_id: newId,
        version_number: 1,
        file_path: newPath,
        file_size: srcVersion.file_size,
        mime_type: srcVersion.mime_type,
        uploaded_by: user.userId,
        upload_status: 'active',
      });

      await this.db
        .from('fe_nodes')
        .update({ current_version_id: newVersionId })
        .eq('id', newId);
    }

    // For folders: recursively clone all direct children.
    if (node.node_type === 'folder') {
      const childrenResult = await this.db
        .from('fe_nodes')
        .select('*')
        .eq('parent_id', node.id)
        .eq('is_deleted', false);

      for (const child of (childrenResult.data ?? []) as IFeNode[]) {
        await this.cloneSubtree(child, newId, user, depth + 1, counter);
      }
    }

    return newId;
  }

  // ── THUMBNAIL ENRICHMENT ──────────────────────────────────────────────────────

  private isImageMime(mime: string | null): boolean {
    return !!(mime && /^image\/(jpeg|jpg|png|gif|webp|bmp|tiff)/.test(mime));
  }

  private isVideoMime(mime: string | null): boolean {
    return !!(
      mime && /^video\/(mp4|webm|ogg|quicktime|x-msvideo|x-matroska)/.test(mime)
    );
  }

  /**
   * For image and video file nodes that have a current version with a file_path,
   * generate a short-TTL inline signed URL and attach it as `thumbnail_url`.
   * Other node types are returned unchanged. Errors are silently ignored.
   */
  private async attachThumbnailUrls(nodes: IFeNode[]): Promise<IFeNode[]> {
    return Promise.all(
      nodes.map(async (node) => {
        if (node.node_type !== 'file' || !node.current_version?.file_path)
          return node;
        if (
          !this.isImageMime(node.mime_type) &&
          !this.isVideoMime(node.mime_type)
        )
          return node;

        try {
          const url = await this.storage.signedViewUrl(
            node.current_version.file_path,
          );

          return { ...node, thumbnail_url: url };
        } catch {
          return node;
        }
      }),
    );
  }
}
