/**
 * @fileoverview Storage operations for File Explorer — upload, signed download URLs,
 * copy, removal, and space-level cleanup. All access is via service-role client
 * (bucket has no RLS policies); Content-Disposition: attachment is enforced on every
 * signed URL to neutralise inline SVG/HTML execution.
 * @module src/file-explorer/file-explorer-storage.service
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { storageSafeFileName } from '../common/upload-filename';
import { formatMaxUpload, UPLOAD_LIMITS } from '../common/upload-limits';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { IFeNode } from './interfaces/fe-node.interface';

const BUCKET = 'file-explorer';
const SIGNED_URL_TTL_SECONDS = 60;
const SIGNED_VIEW_TTL_SECONDS = 3600; // 1 hour — required for Office Online viewer to fetch the file
/**
 * Ceiling for the PROXIED upload path — bytes that pass through this process's heap.
 *
 * Large files do not use this path at all; they go direct-to-storage via `createSignedUploadUrl`
 * (see `FILE_EXPLORER_MAX_BYTES`), which is why this stays at the ordinary attachment tier rather
 * than tracking the 5 GB File Explorer ceiling. Multer buffers the whole request in memory, so
 * raising this is paid for in RSS per concurrent upload.
 *
 * Previously hardcoded at 100 MB, which contradicted the controller's own interceptor limit: on an
 * on-premise deployment multer accepted up to 1 GiB and this check then rejected anything over
 * 100 MB with a 400, so uploads in that band failed with a confusing error.
 */
const MAX_PROXY_BYTES = UPLOAD_LIMITS.ATTACHMENT;

export type FileExplorerSpacePurgeResult = {
  status: 'removed' | 'no-op';
  removed: number;
};

/**
 * Signals that a destructive space cleanup could not complete safely.
 * Callers must leave the space data intact so the same cleanup can be retried.
 */
export class FileExplorerStorageCleanupError extends Error {
  constructor(
    public readonly operation: 'list' | 'remove',
    public readonly prefix: string,
    cause: string,
  ) {
    super(`File Explorer storage ${operation} failed for ${prefix}: ${cause}`);
    this.name = FileExplorerStorageCleanupError.name;
  }
}

/**
 * There is NO MIME allow-list. File Explorer is a file manager — restricting which types a user may
 * store in their own folders is not a threat model, it is a defect. Every signed URL this service
 * issues for download carries `Content-Disposition: attachment` (see `signedDownloadUrl`), and the
 * inline-preview path is separately gated by `INLINE_PREVIEW_MIME_RE` in the service layer, so the
 * stored content type never decides whether a browser executes something.
 *
 * NOTE: the `file-explorer` BUCKET carries its own `allowed_mime_types` in Supabase. Clearing this
 * list without also clearing the bucket's turns a clean 400 into an opaque storage error.
 */

@Injectable()
export class FileExplorerStorageService {
  private readonly logger = new Logger(FileExplorerStorageService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get storage() {
    return this.supabaseAdmin.getClient().storage.from(BUCKET);
  }

  /**
   * Pre-validate mime type and file size before any DB or storage write.
   * Throws 400 with a user-friendly message on failure.
   */
  assertAllowed(file: Express.Multer.File): void {
    if (!file) throw new BadRequestException('Missing file');
    if (file.size > MAX_PROXY_BYTES) {
      throw new BadRequestException(
        `File too large — files above ${formatMaxUpload(MAX_PROXY_BYTES)} must use the ` +
          `direct upload flow (POST files/upload-init)`,
      );
    }
    // 0-byte files are allowed (fe_versions.file_size >= 0). No type check — see ALLOWED_MIME note.
  }

  /**
   * Normalise a filename for use as a storage key segment.
   *
   * Delegates to the shared {@link storageSafeFileName}, which folds the name to ASCII.
   * This matters: Supabase Storage's `isValidKey` uses a non-unicode `\w` class, so a key
   * containing `ü`/`ö`/`ß` is rejected outright and the upload fails (XE-T373). The previous
   * local implementation stripped control characters and path separators but passed non-ASCII
   * straight through.
   *
   * Only the storage KEY is folded. The human-readable name kept in `fe_nodes.name` stays full
   * UTF-8, so the user still sees `Prüfbericht Größe.pdf`.
   */
  sanitize(name: string): string {
    return storageSafeFileName(name);
  }

  /**
   * Build the canonical storage key for a file version.
   * Format: {orgId}/file-explorer/{spaceId}/{nodeId}/{versionId}/{sanitizedFilename}
   * Including space_id allows listing + cleanup of an entire space's storage in one prefix.
   */
  buildKey(
    node: Pick<IFeNode, 'organization_id' | 'space_id' | 'id'>,
    versionId: string,
    originalFilename: string,
  ): string {
    return `${node.organization_id}/file-explorer/${node.space_id}/${node.id}/${versionId}/${this.sanitize(originalFilename)}`;
  }

  /**
   * Issue a signed URL the CLIENT uploads to directly, bypassing this process entirely.
   *
   * This is what makes multi-gigabyte uploads possible. The proxied `upload()` below buffers the
   * whole file in Node's memory via multer, so a 5 GB upload through it would allocate 5 GB of RSS
   * per concurrent request; here the bytes go browser → Supabase and never touch us.
   *
   * The returned URL is a single PUT valid for two hours. That TTL is fixed by Supabase and is not
   * configurable through this API, so a client that stalls past it must re-init.
   */
  async createSignedUploadUrl(
    path: string,
  ): Promise<{ signedUrl: string; token: string; path: string }> {
    const { data, error } = await this.storage.createSignedUploadUrl(path);

    if (error || !data) {
      throw new BadRequestException(
        `Could not start upload: ${error?.message ?? 'no signed URL returned'}`,
      );
    }

    return { signedUrl: data.signedUrl, token: data.token, path: data.path };
  }

  /**
   * Look up an object's real byte size, or `null` when it does not exist.
   *
   * Used to confirm what a client ACTUALLY uploaded through a signed URL. The size it declared at
   * init time is not trustworthy — nothing stops a caller from declaring 1 byte and then PUTting a
   * gigabyte — so quota is re-checked against this value before the version is activated.
   */
  async statObject(path: string): Promise<{ size: number } | null> {
    const lastSlash = path.lastIndexOf('/');
    const prefix = lastSlash === -1 ? '' : path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);

    const { data, error } = await this.storage.list(prefix, {
      limit: 1,
      search: name,
    });

    if (error) {
      throw new BadRequestException(
        `Could not verify uploaded file: ${error.message}`,
      );
    }

    const match = (data ?? []).find((entry) => entry.name === name);
    if (!match) return null;

    // `size` lives on the object metadata; a folder placeholder has no metadata at all.
    const size = (match.metadata as { size?: number } | null)?.size;

    return { size: typeof size === 'number' ? size : 0 };
  }

  /** Upload a Multer buffer to Supabase Storage. Throws 400 on failure. */
  async upload(path: string, file: Express.Multer.File): Promise<void> {
    const { error } = await this.storage.upload(path, file.buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      upsert: false,
    });

    if (error)
      throw new BadRequestException(`File upload failed: ${error.message}`);
  }

  /**
   * Generate a short-TTL signed URL with Content-Disposition: attachment.
   * The { download } option forces attachment disposition — this is the primary
   * mitigation against inline SVG/HTML execution in the browser.
   */
  async signedDownloadUrl(
    filePath: string,
    downloadName: string,
  ): Promise<string> {
    const { data, error } = await this.storage.createSignedUrl(
      filePath,
      SIGNED_URL_TTL_SECONDS,
      {
        download: downloadName,
      },
    );

    if (error || !data?.signedUrl) {
      throw new BadRequestException('Failed to generate download URL');
    }

    return data.signedUrl;
  }

  /**
   * Generate a short-TTL signed URL for inline browser rendering (no Content-Disposition: attachment).
   * ONLY call this for MIME types in the INLINE_SAFE set (images, video, audio, PDF, text/plain).
   * SVG and HTML are excluded by the service layer to prevent inline script execution.
   */
  async signedViewUrl(filePath: string): Promise<string> {
    const { data, error } = await this.storage.createSignedUrl(
      filePath,
      SIGNED_VIEW_TTL_SECONDS,
    );

    if (error || !data?.signedUrl) {
      throw new BadRequestException('Failed to generate preview URL');
    }

    return data.signedUrl;
  }

  /** Download a stored object into memory for controlled server-side ZIP streaming. */
  async downloadBuffer(filePath: string): Promise<Buffer> {
    const { data, error } = await this.storage.download(filePath);

    if (error || !data) {
      throw new BadRequestException('Failed to read file for download');
    }

    return Buffer.from(await data.arrayBuffer());
  }

  /** Copy a stored object to a new key (used for node copy — bytes are independent). */
  async copyObject(srcPath: string, destPath: string): Promise<void> {
    const { error } = await this.storage.copy(srcPath, destPath);

    if (error)
      throw new BadRequestException(`Storage copy failed: ${error.message}`);
  }

  /** Remove a list of storage paths in chunks of 1000. Best-effort (logs errors, never throws). */
  async removePaths(paths: string[]): Promise<void> {
    for (let i = 0; i < paths.length; i += 1000) {
      const chunk = paths.slice(i, i + 1000);
      const { error } = await this.storage.remove(chunk);

      if (error) {
        this.logger.error(
          `Storage remove failed for ${chunk.length} paths: ${error.message}`,
        );
      }
    }
  }

  /**
   * Recursively list all object paths under a storage prefix.
   * Used before bulk removals (space delete, permanent node delete).
   */
  async listPrefix(prefix: string): Promise<string[]> {
    const paths: string[] = [];
    let offset = 0;
    const limit = 1000;

    for (;;) {
      const { data, error } = await this.storage.list(prefix, {
        limit,
        offset,
      });

      if (error) {
        this.logger.error(
          `Storage list failed for prefix ${prefix}: ${error.message}`,
        );
        break;
      }

      if (!data || data.length === 0) break;

      for (const item of data) {
        const fullPath = prefix ? `${prefix}/${item.name}` : item.name;

        // Supabase returns folders with a trailing slash in some SDK versions;
        // recursively list them rather than treating them as objects.
        if (!item.metadata) {
          const subPaths = await this.listPrefix(fullPath);

          paths.push(...subPaths);
        } else {
          paths.push(fullPath);
        }
      }

      if (data.length < limit) break;
      offset += limit;
    }

    return paths;
  }

  /**
   * Recursively list storage paths, failing closed on any storage read error.
   *
   * This is deliberately separate from {@link listPrefix}: the latter remains
   * best-effort for node-level hygiene, whereas a permanent space deletion must
   * never continue after an incomplete inventory.
   */
  async listPrefixStrict(prefix: string): Promise<string[]> {
    const paths: string[] = [];
    let offset = 0;
    const limit = 1000;

    for (;;) {
      const { data, error } = await this.storage.list(prefix, {
        limit,
        offset,
      });

      if (error) {
        this.logger.error(
          `Strict storage list failed for prefix ${prefix}: ${error.message}`,
        );
        throw new FileExplorerStorageCleanupError(
          'list',
          prefix,
          error.message,
        );
      }

      const entries = data ?? [];
      if (entries.length === 0) break;

      for (const item of entries) {
        const fullPath = prefix ? `${prefix}/${item.name}` : item.name;

        if (!item.metadata) {
          paths.push(...(await this.listPrefixStrict(fullPath)));
        } else {
          paths.push(fullPath);
        }
      }

      if (entries.length < limit) break;
      offset += limit;
    }

    return paths;
  }

  /**
   * Remove an entire space's File Explorer prefix before its database row is
   * permanently deleted. Unlike node-level cleanup this fails closed: any list
   * or removal failure leaves the caller free to retry without losing metadata.
   */
  async purgeSpaceStorage(
    organizationId: string,
    spaceId: string,
  ): Promise<FileExplorerSpacePurgeResult> {
    const prefix = `${organizationId}/file-explorer/${spaceId}`;
    const paths = await this.listPrefixStrict(prefix);

    if (!paths.length) {
      this.logger.log(
        `No File Explorer objects found for space ${spaceId} during permanent deletion`,
      );
      return { status: 'no-op', removed: 0 };
    }

    const removed = await this.removePathsStrict(paths, prefix);

    this.logger.log(
      `Removed ${removed} File Explorer objects for space ${spaceId}`,
    );

    return { status: 'removed', removed };
  }

  /** Remove known paths and fail closed when any batch cannot be removed. */
  async removePathsStrict(paths: string[], prefix: string): Promise<number> {
    for (let i = 0; i < paths.length; i += 1000) {
      const chunk = paths.slice(i, i + 1000);
      const { error } = await this.storage.remove(chunk);

      if (error) {
        this.logger.error(
          `Strict storage remove failed for ${chunk.length} paths under ${prefix}: ${error.message}`,
        );
        throw new FileExplorerStorageCleanupError(
          'remove',
          prefix,
          error.message,
        );
      }
    }

    return paths.length;
  }

  /**
   * Remove all File Explorer storage objects belonging to a space.
   * Called by SpacesService.deleteSpace() before the spaces row is deleted.
   * Best-effort — logs on failure but never blocks space deletion.
   */
  async removeSpaceStorage(orgId: string, spaceId: string): Promise<void> {
    const prefix = `${orgId}/file-explorer/${spaceId}`;
    const paths = await this.listPrefix(prefix);

    if (paths.length > 0) {
      await this.removePaths(paths);
      this.logger.log(
        `Removed ${paths.length} File Explorer objects for space ${spaceId}`,
      );
    }
  }
}
