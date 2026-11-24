/**
 * @fileoverview Whiteboards: many Excalidraw canvases per space.
 *
 * The scene lives in `whiteboards.elements` / `app_state` (JSONB) behind an optimistic lock
 * (`revision`); embedded images live in the private `whiteboard-files` bucket, one object per
 * Excalidraw fileId, and are streamed through this service (never signed URLs).
 *
 * Tenant isolation: the service-role client bypasses RLS, and SpacePermissionsGuard's org-admin
 * grant does not check that the space belongs to the caller's org. So every query filters
 * id + space_id + organization_id, and assertAvailable() (which only matches spaces of the
 * caller's active org) runs first on every call.
 * @module src/whiteboards/whiteboards.service
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  forwardRef,
} from '@nestjs/common';

import { randomInt } from 'crypto';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { OrganizationModulesService } from '../organization-modules/organization-modules.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { normalizeContentType } from '../common/upload-mime';
import { WIKI_USER_COLUMNS, withFullName } from '../wiki/wiki-user.util';
import { WikiPermissionsService } from '../wiki/wiki-permissions.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { SaveWhiteboardSceneDto } from './dto/save-whiteboard-scene.dto';
import {
  WHITEBOARD_FILES_BUCKET,
  WHITEBOARD_FILE_ID_RE,
  WHITEBOARD_IMAGE_MIMES,
  WHITEBOARD_LIST_LIMIT,
  WHITEBOARD_MAX_SCENE_BYTES,
  WHITEBOARD_TOMBSTONE_TTL_MS,
} from './whiteboards.constants';

const TABLE = 'whiteboards';
const FILES_TABLE = 'whiteboard_files';
const VERSIONS_TABLE = 'whiteboard_versions';
const VERSION_SUMMARY_COLUMNS = `id, version, name, revision, changes, changed_by, created_at, updated_at, changed_by_user:users!changed_by(${WIKI_USER_COLUMNS})`;
const WHITEBOARD_VERSION_LIST_LIMIT = 1000;

/** A restore re-reads and retries when an autosave moves the revision underneath it. */
const RESTORE_ATTEMPTS = 3;

const SUMMARY_COLUMNS =
  'id, space_id, name, is_archived, archived_at, revision, created_by, updated_by, created_at, updated_at';

/** The app_state keys that survive a save (the four serializeAsJSON keeps) and their types. */
const APP_STATE_KEYS: Record<string, 'number' | 'boolean' | 'string'> = {
  gridSize: 'number',
  gridStep: 'number',
  gridModeEnabled: 'boolean',
  viewBackgroundColor: 'string',
};

export interface WhiteboardSummary {
  id: string;
  space_id: string;
  name: string;
  is_archived: boolean;
  archived_at: string | null;
  revision: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface WhiteboardDetail extends WhiteboardSummary {
  elements: Record<string, unknown>[];
  app_state: Record<string, unknown>;
  files: { file_id: string; mime_type: string }[];
  /** The last editor, for the header's "Edited" label. */
  updated_by_user: Record<string, unknown> | null;
  /** The board's wiki link row: its page ACL is the board's Share setting. Null when unlinked. */
  wiki_page_id: string | null;
}

export type WhiteboardAccessLevel = 'can_view' | 'can_edit' | 'can_delete';

/** The caller's view of a board's Share setting (editor header). */
export interface WhiteboardShareState {
  /** The link row whose page ACL is the Share setting; null until first shared. */
  wiki_page_id: string | null;
  /** The link row or a folder above it has permission rows (not open to the whole space). */
  restricted: boolean;
  /** Share-level caps for the caller; the space keys still apply on top. */
  can_edit: boolean;
  can_delete: boolean;
}

export interface WhiteboardVersionSummary {
  id: string;
  version: number;
  name: string;
  revision: number;
  changes: Record<string, unknown>;
  changed_by: string | null;
  changed_by_user: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface WhiteboardVersionDetail extends WhiteboardVersionSummary {
  elements: Record<string, unknown>[];
  app_state: Record<string, unknown>;
  files: { file_id: string; mime_type: string }[];
}

export interface WhiteboardUpload {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

@Injectable()
export class WhiteboardsService {
  private readonly logger = new Logger(WhiteboardsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly orgModules: OrganizationModulesService,
    private readonly auditLogs: AuditLogsService,
    // WikiModule imports this module for link rows; the board ACL lives on those rows.
    @Inject(forwardRef(() => WikiPermissionsService))
    private readonly wikiPermissions: WikiPermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async list(
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<WhiteboardSummary[]> {
    await this.assertAvailable(organizationId, spaceId);

    // ponytail: capped unpaged list (tabs/search run client-side); page server-side if a space nears the cap.
    const { data, error } = await this.client
      .from(TABLE)
      .select(SUMMARY_COLUMNS)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('updated_at', { ascending: false })
      .limit(WHITEBOARD_LIST_LIMIT);

    if (error) throw this.dbError('list whiteboards', error);

    const boards = (data ?? []) as WhiteboardSummary[];
    const restricted = await this.wikiPermissions.resolveBoardAccess(
      userId,
      spaceId,
      boards.map((b) => b.id),
    );

    // Boards shared away from the caller are hidden, as in the wiki tree
    return boards.filter((b) => restricted.get(b.id)?.can_view !== false);
  }

  async getShareState(
    spaceId: string,
    organizationId: string,
    userId: string,
    whiteboardId: string,
  ): Promise<WhiteboardShareState> {
    await this.assertAvailable(organizationId, spaceId);

    const [board, link] = await Promise.all([
      this.client
        .from(TABLE)
        .select('id')
        .eq('id', whiteboardId)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .maybeSingle(),
      this.client
        .from('wiki_pages')
        .select('id, path')
        .eq('whiteboard_id', whiteboardId)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .maybeSingle(),
    ]);

    if (board.error) throw this.dbError('load whiteboard', board.error);
    if (!board.data) throw new NotFoundException('Whiteboard not found');
    if (link.error) throw this.dbError('load whiteboard wiki row', link.error);

    const row = link.data as { id: string; path: string[] | null } | null;
    let restricted = false;

    if (row) {
      const rules = await this.client
        .from('wiki_page_permissions')
        .select('wiki_page_id')
        .in('wiki_page_id', [row.id, ...(row.path ?? [])])
        .limit(1);

      if (rules.error) {
        throw this.dbError('load whiteboard share rules', rules.error);
      }
      restricted = (rules.data ?? []).length > 0;
    }

    const access = await this.assertBoardAccess(
      spaceId,
      userId,
      whiteboardId,
      'can_view',
    );

    return {
      wiki_page_id: row?.id ?? null,
      restricted,
      can_edit: access?.can_edit ?? true,
      can_delete: access?.can_delete ?? true,
    };
  }

  /**
   * 403 when the board's Share setting (its wiki link row's page ACL) denies `level`. An
   * unrestricted board passes: the space keys SpacePermissionsGuard checked still apply alone.
   */
  async assertBoardAccess(
    spaceId: string,
    userId: string,
    whiteboardId: string,
    level: WhiteboardAccessLevel,
  ): Promise<
    Omit<WhiteboardShareState, 'wiki_page_id' | 'restricted'> | undefined
  > {
    const access = (
      await this.wikiPermissions.resolveBoardAccess(userId, spaceId, [
        whiteboardId,
      ])
    ).get(whiteboardId);

    if (access && !access[level]) {
      throw new ForbiddenException('You do not have access to this whiteboard');
    }

    return access;
  }

  async create(
    spaceId: string,
    user: RequestUser,
    name: string,
  ): Promise<WhiteboardSummary> {
    await this.assertAvailable(user.organizationId, spaceId);

    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        organization_id: user.organizationId,
        space_id: spaceId,
        name,
        created_by: user.userId,
        updated_by: user.userId,
      })
      .select(SUMMARY_COLUMNS)
      .single();

    if (error) throw this.dbError('create whiteboard', error);

    const created = data as WhiteboardSummary;

    void this.auditLogs.logActionForRequest(
      user,
      'whiteboard',
      created.id,
      'create',
      { name, space_id: spaceId },
    );

    return created;
  }

  async getOne(
    spaceId: string,
    organizationId: string,
    whiteboardId: string,
  ): Promise<WhiteboardDetail> {
    await this.assertAvailable(organizationId, spaceId);

    const { data, error } = await this.client
      .from(TABLE)
      .select(
        `${SUMMARY_COLUMNS}, elements, app_state, updated_by_user:users!updated_by(${WIKI_USER_COLUMNS})`,
      )
      .eq('id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw this.dbError('load whiteboard', error);
    if (!data) throw new NotFoundException('Whiteboard not found');

    const [files, link] = await Promise.all([
      this.client
        .from(FILES_TABLE)
        .select('file_id, mime_type')
        .eq('whiteboard_id', whiteboardId)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId),
      this.client
        .from('wiki_pages')
        .select('id')
        .eq('whiteboard_id', whiteboardId)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .maybeSingle(),
    ]);

    if (files.error) throw this.dbError('load whiteboard files', files.error);
    if (link.error) throw this.dbError('load whiteboard wiki row', link.error);

    const row = data as Record<string, unknown>;

    return {
      ...(row as Omit<
        WhiteboardDetail,
        'files' | 'updated_by_user' | 'wiki_page_id'
      >),
      updated_by_user: withFullName(
        row['updated_by_user'] as Record<string, unknown> | null,
      ),
      wiki_page_id: (link.data as { id: string } | null)?.id ?? null,
      files: (files.data ?? []) as WhiteboardDetail['files'],
    };
  }

  async rename(
    spaceId: string,
    user: RequestUser,
    whiteboardId: string,
    name: string,
  ): Promise<WhiteboardSummary> {
    await this.assertAvailable(user.organizationId, spaceId);

    const { data, error } = await this.client
      .from(TABLE)
      .update({ name, updated_by: user.userId })
      .eq('id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('is_archived', false)
      .select(SUMMARY_COLUMNS)
      .maybeSingle();

    if (error) throw this.dbError('rename whiteboard', error);
    if (!data) {
      throw await this.writeMissError(
        spaceId,
        user.organizationId,
        whiteboardId,
        false,
      );
    }

    void this.auditLogs.logActionForRequest(
      user,
      'whiteboard',
      whiteboardId,
      'update',
      { name },
    );

    return data as WhiteboardSummary;
  }

  /**
   * Compare-and-set on `revision`: a save based on an older revision is refused with
   * 409 WHITEBOARD_REVISION_CONFLICT, and the client merges (reconcileElements) and retries.
   * Not audited: it runs every few seconds while someone draws.
   */
  async saveScene(
    spaceId: string,
    user: RequestUser,
    whiteboardId: string,
    dto: SaveWhiteboardSceneDto,
  ): Promise<{ revision: number; updated_at: string }> {
    await this.assertAvailable(user.organizationId, spaceId);

    const elements = sanitizeElements(dto.elements, Date.now());
    const appState = pickAppState(dto.app_state);

    if (
      Buffer.byteLength(JSON.stringify(elements)) +
        Buffer.byteLength(JSON.stringify(appState)) >
      WHITEBOARD_MAX_SCENE_BYTES
    ) {
      throw new PayloadTooLargeException({
        code: 'WHITEBOARD_TOO_LARGE',
        message: 'Whiteboard is too large to save (limit 5 MB)',
      });
    }

    const { data, error } = await this.client
      .from(TABLE)
      .update({
        elements,
        app_state: appState,
        revision: dto.base_revision + 1,
        updated_by: user.userId,
      })
      .eq('id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('is_archived', false)
      .eq('revision', dto.base_revision)
      .select('revision, updated_at')
      .maybeSingle();

    if (error) throw this.dbError('save whiteboard', error);
    if (!data) {
      throw await this.writeMissError(
        spaceId,
        user.organizationId,
        whiteboardId,
        true,
      );
    }

    return data as { revision: number; updated_at: string };
  }

  // ── Version history ─────────────────────────────────────────────────────────
  // Rows are written by the track_whiteboard_versions trigger on every scene/name change
  // (same 10-minute same-user merge rule as wiki notes). Every board has at least version 1,
  // so an empty list means the board is not in this space/org.

  async listVersions(
    spaceId: string,
    organizationId: string,
    whiteboardId: string,
  ): Promise<WhiteboardVersionSummary[]> {
    await this.assertAvailable(organizationId, spaceId);

    // ponytail: unpaged (metadata only, no scenes); page it if a board nears the cap.
    const { data, error } = await this.client
      .from(VERSIONS_TABLE)
      .select(VERSION_SUMMARY_COLUMNS)
      .eq('whiteboard_id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('version', { ascending: false })
      .limit(WHITEBOARD_VERSION_LIST_LIMIT);

    if (error) throw this.dbError('list whiteboard versions', error);
    if (!data?.length) throw new NotFoundException('Whiteboard not found');

    return (data as Record<string, unknown>[]).map(withVersionAuthor);
  }

  async getVersion(
    spaceId: string,
    organizationId: string,
    whiteboardId: string,
    version: number,
  ): Promise<WhiteboardVersionDetail> {
    await this.assertAvailable(organizationId, spaceId);

    const { data, error } = await this.client
      .from(VERSIONS_TABLE)
      .select(`${VERSION_SUMMARY_COLUMNS}, elements, app_state`)
      .eq('whiteboard_id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('version', version)
      .maybeSingle();

    if (error) throw this.dbError('load whiteboard version', error);
    if (!data) throw new NotFoundException('Version not found');

    const snapshot = withVersionAuthor(data as Record<string, unknown>) as Omit<
      WhiteboardVersionDetail,
      'files'
    >;

    // Images are content-addressed and never deleted while the board exists, so an old
    // version's images are still among the board's files.
    const files = await this.client
      .from(FILES_TABLE)
      .select('file_id, mime_type')
      .eq('whiteboard_id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (files.error) throw this.dbError('load whiteboard files', files.error);

    const used = new Set(
      snapshot.elements
        .map((el) => el.fileId)
        .filter((id): id is string => typeof id === 'string'),
    );

    return {
      ...snapshot,
      files: ((files.data ?? []) as WhiteboardDetail['files']).filter((f) =>
        used.has(f.file_id),
      ),
    };
  }

  /**
   * Writes a version's scene and name back as a new revision, recorded as its own "restore"
   * version. Element versions are bumped above the current scene (and current-only elements
   * tombstoned), so an editor that is still open merges to the restore on its next save
   * instead of silently undoing it. Retries when an autosave lands in between.
   */
  async restoreVersion(
    spaceId: string,
    user: RequestUser,
    whiteboardId: string,
    version: number,
  ): Promise<WhiteboardDetail> {
    await this.assertAvailable(user.organizationId, spaceId);

    const snap = await this.client
      .from(VERSIONS_TABLE)
      .select('name, elements, app_state')
      .eq('whiteboard_id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('version', version)
      .maybeSingle();

    if (snap.error) throw this.dbError('load whiteboard version', snap.error);
    if (!snap.data) throw new NotFoundException('Version not found');

    const snapshot = snap.data as {
      name: string;
      elements: Record<string, unknown>[];
      app_state: Record<string, unknown>;
    };
    const appState = pickAppState(snapshot.app_state ?? {});

    for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt++) {
      const cur = await this.client
        .from(TABLE)
        .select('elements, revision, is_archived')
        .eq('id', whiteboardId)
        .eq('space_id', spaceId)
        .eq('organization_id', user.organizationId)
        .maybeSingle();

      if (cur.error) throw this.dbError('load whiteboard', cur.error);
      if (!cur.data) throw new NotFoundException('Whiteboard not found');

      const current = cur.data as {
        elements: Record<string, unknown>[];
        revision: number;
        is_archived: boolean;
      };

      if (current.is_archived) throw archivedError();

      const now = Date.now();
      const elements = sanitizeElements(
        buildRestoredScene(
          current.elements ?? [],
          snapshot.elements ?? [],
          now,
        ),
        now,
      );

      if (
        Buffer.byteLength(JSON.stringify(elements)) +
          Buffer.byteLength(JSON.stringify(appState)) >
        WHITEBOARD_MAX_SCENE_BYTES
      ) {
        throw new PayloadTooLargeException({
          code: 'WHITEBOARD_TOO_LARGE',
          message: 'Whiteboard is too large to restore (limit 5 MB)',
        });
      }

      const { data, error } = (await this.client.rpc(
        'restore_whiteboard_scene',
        {
          p_whiteboard_id: whiteboardId,
          p_space_id: spaceId,
          p_organization_id: user.organizationId,
          p_base_revision: current.revision,
          p_elements: elements,
          p_app_state: appState,
          p_name: snapshot.name,
          p_user_id: user.userId,
          p_restored_from: version,
        },
      )) as { data: unknown[] | null; error: { message: string } | null };

      if (error) throw this.dbError('restore whiteboard version', error);

      if (Array.isArray(data) && data.length > 0) {
        void this.auditLogs.logActionForRequest(
          user,
          'whiteboard',
          whiteboardId,
          'restore',
          { restored_version: version },
        );

        return this.getOne(spaceId, user.organizationId, whiteboardId);
      }
    }

    // Still racing autosaves (or archived/deleted meanwhile): report why.
    throw await this.writeMissError(
      spaceId,
      user.organizationId,
      whiteboardId,
      true,
    );
  }

  async setArchived(
    spaceId: string,
    user: RequestUser,
    whiteboardId: string,
    archived: boolean,
  ): Promise<WhiteboardSummary> {
    await this.assertAvailable(user.organizationId, spaceId);

    const { data, error } = await this.client
      .from(TABLE)
      .update({
        is_archived: archived,
        archived_at: archived ? new Date().toISOString() : null,
        archived_by: archived ? user.userId : null,
      })
      .eq('id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .select(SUMMARY_COLUMNS)
      .maybeSingle();

    if (error) throw this.dbError('archive whiteboard', error);
    if (!data) throw new NotFoundException('Whiteboard not found');

    void this.auditLogs.logActionForRequest(
      user,
      'whiteboard',
      whiteboardId,
      archived ? 'archive' : 'restore',
    );

    return data as WhiteboardSummary;
  }

  /** Hard delete (archive is the reversible path). File rows cascade; bucket objects follow. */
  async remove(
    spaceId: string,
    user: RequestUser,
    whiteboardId: string,
  ): Promise<{ success: true }> {
    await this.assertAvailable(user.organizationId, spaceId);

    return this.removeFromWiki(spaceId, user, whiteboardId);
  }

  /**
   * `remove` without the module check, for the wiki tree: deleting a folder must still work after
   * Whiteboards is switched off. The caller owns the permission check; the tenant filters stay.
   */
  async removeFromWiki(
    spaceId: string,
    user: RequestUser,
    whiteboardId: string,
  ): Promise<{ success: true }> {
    // Read before the cascade removes them: a restored whiteboard's images keep the path
    // they were written under, which need not be this space/whiteboard prefix.
    const files = await this.client
      .from(FILES_TABLE)
      .select('storage_path')
      .eq('whiteboard_id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId);

    if (files.error) throw this.dbError('load whiteboard files', files.error);

    const { data, error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .select('id, name')
      .maybeSingle();

    if (error) throw this.dbError('delete whiteboard', error);
    if (!data) throw new NotFoundException('Whiteboard not found');

    // Rows first, bytes second: a failed storage call leaves orphans, never a scene
    // pointing at images that are gone.
    await this.removeStoredFiles(
      spaceId,
      whiteboardId,
      ((files.data ?? []) as { storage_path: string }[]).map(
        (f) => f.storage_path,
      ),
    );

    void this.auditLogs.logActionForRequest(
      user,
      'whiteboard',
      whiteboardId,
      'delete',
      { name: (data as { name: string }).name },
    );

    return { success: true };
  }

  /**
   * Stores one embedded image. Idempotent per fileId: Excalidraw ids are content hashes, so an
   * id that is already stored is the same image and the upload is skipped (first write wins).
   */
  async uploadFile(
    spaceId: string,
    user: RequestUser,
    whiteboardId: string,
    fileId: string,
    file: WhiteboardUpload,
  ): Promise<{ file_id: string }> {
    await this.assertAvailable(user.organizationId, spaceId);

    if (!WHITEBOARD_FILE_ID_RE.test(fileId ?? '')) {
      throw new BadRequestException('Invalid file id');
    }

    const mimeType = normalizeContentType(file.mimetype);

    if (!WHITEBOARD_IMAGE_MIMES.has(mimeType)) {
      throw new BadRequestException(
        `File type "${mimeType}" is not allowed on a whiteboard`,
      );
    }
    assertImageContent(file.buffer, mimeType);

    const board = await this.client
      .from(TABLE)
      .select('is_archived')
      .eq('id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (board.error) throw this.dbError('load whiteboard', board.error);
    if (!board.data) throw new NotFoundException('Whiteboard not found');
    if ((board.data as { is_archived: boolean }).is_archived) {
      throw archivedError();
    }

    const existing = await this.client
      .from(FILES_TABLE)
      .select('file_id')
      .eq('whiteboard_id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('file_id', fileId)
      .maybeSingle();

    if (existing.error) {
      throw this.dbError('load whiteboard file', existing.error);
    }
    if (existing.data) return { file_id: fileId };

    const storagePath = `${spaceId}/${whiteboardId}/${fileId}`;
    const upload = await this.client.storage
      .from(WHITEBOARD_FILES_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (upload.error) throw this.dbError('store whiteboard file', upload.error);

    const { error } = await this.client.from(FILES_TABLE).upsert(
      {
        whiteboard_id: whiteboardId,
        space_id: spaceId,
        organization_id: user.organizationId,
        file_id: fileId,
        storage_path: storagePath,
        mime_type: mimeType,
        size_bytes: file.size,
        created_by: user.userId,
      },
      { onConflict: 'whiteboard_id,file_id', ignoreDuplicates: true },
    );

    if (error) throw this.dbError('record whiteboard file', error);

    return { file_id: fileId };
  }

  async getFile(
    spaceId: string,
    organizationId: string,
    whiteboardId: string,
    fileId: string,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    await this.assertAvailable(organizationId, spaceId);

    if (!WHITEBOARD_FILE_ID_RE.test(fileId ?? '')) {
      throw new NotFoundException('Whiteboard file not found');
    }

    const { data, error } = await this.client
      .from(FILES_TABLE)
      .select('storage_path, mime_type')
      .eq('whiteboard_id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('file_id', fileId)
      .maybeSingle();

    if (error) throw this.dbError('load whiteboard file', error);
    if (!data) throw new NotFoundException('Whiteboard file not found');

    const row = data as { storage_path: string; mime_type: string };
    const download = await this.client.storage
      .from(WHITEBOARD_FILES_BUCKET)
      .download(row.storage_path);

    if (download.error || !download.data) {
      this.logger.warn(
        `Whiteboard ${whiteboardId}: file ${fileId} has a row but no object (${download.error?.message ?? 'empty'})`,
      );
      throw new NotFoundException('Whiteboard file not found');
    }

    return {
      buffer: Buffer.from(await download.data.arrayBuffer()),
      mimeType: row.mime_type,
    };
  }

  /**
   * 403 unless Whiteboards is on for the tenant (licence + tenant toggle) AND for this space.
   * The space check only matches non-archived spaces of `organizationId`, so it also proves
   * the space belongs to the caller's org. Binds org admins too.
   */
  async assertAvailable(
    organizationId: string,
    spaceId: string,
  ): Promise<void> {
    const [tenantOn, spaceOn] = await Promise.all([
      this.orgModules.isEnabled(organizationId, 'whiteboards'),
      this.orgModules.isSpaceModuleEnabled(
        organizationId,
        spaceId,
        'whiteboards',
      ),
    ]);

    if (!tenantOn || !spaceOn) {
      throw new ForbiddenException('Whiteboards are not enabled in this space');
    }
  }

  /** A guarded update matched nothing: say why (gone, archived, or a stale revision). */
  private async writeMissError(
    spaceId: string,
    organizationId: string,
    whiteboardId: string,
    checkedRevision: boolean,
  ): Promise<Error> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('is_archived')
      .eq('id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    // A failed read must stay retryable (500), not look like a deleted board (404).
    if (error) return this.dbError('check whiteboard state', error);
    if (!data) return new NotFoundException('Whiteboard not found');
    if ((data as { is_archived: boolean }).is_archived || !checkedRevision) {
      return archivedError();
    }

    return new ConflictException({
      code: 'WHITEBOARD_REVISION_CONFLICT',
      message: 'Whiteboard changed since it was loaded',
    });
  }

  /** Exact recorded paths first, then a sweep of the prefix for objects whose row write failed. */
  private async removeStoredFiles(
    spaceId: string,
    whiteboardId: string,
    recordedPaths: string[],
  ): Promise<void> {
    const bucket = this.client.storage.from(WHITEBOARD_FILES_BUCKET);
    const prefix = `${spaceId}/${whiteboardId}`;

    try {
      for (let i = 0; i < recordedPaths.length; i += 1000) {
        const removed = await bucket.remove(recordedPaths.slice(i, i + 1000));

        if (removed.error) throw removed.error;
      }

      // Bounded: 20 × 1000 objects; anything left is caught by the space-deletion prefix scope.
      for (let round = 0; round < 20; round++) {
        const listed = await bucket.list(prefix, { limit: 1000 });

        if (listed.error) throw listed.error;
        if (!listed.data?.length) return;

        const removed = await bucket.remove(
          listed.data.map((o) => `${prefix}/${o.name}`),
        );

        if (removed.error) throw removed.error;
        if (listed.data.length < 1000) return;
      }
    } catch (err) {
      this.logger.warn(
        `Whiteboard ${whiteboardId} deleted but its images were not: ${(err as Error).message}. They stay under ${prefix}/ until the space is deleted.`,
      );
    }
  }

  private dbError(
    action: string,
    error: { message: string },
  ): InternalServerErrorException {
    this.logger.error(`Failed to ${action}: ${error.message}`);

    return new InternalServerErrorException(`Failed to ${action}`);
  }
}

export function archivedError(): ConflictException {
  return new ConflictException({
    code: 'WHITEBOARD_ARCHIVED',
    message: 'Whiteboard is archived. Restore it to edit.',
  });
}

/**
 * Validates the element shape the client relies on and drops tombstones older than
 * WHITEBOARD_TOMBSTONE_TTL_MS. Recent tombstones stay so a stale save cannot resurrect them.
 */
export function sanitizeElements(
  elements: Record<string, unknown>[],
  now: number,
): Record<string, unknown>[] {
  const cutoff = now - WHITEBOARD_TOMBSTONE_TTL_MS;
  const kept: Record<string, unknown>[] = [];

  elements.forEach((el, i) => {
    if (
      typeof el.id !== 'string' ||
      el.id.length === 0 ||
      el.id.length > 200 ||
      typeof el.type !== 'string' ||
      !Number.isInteger(el.version)
    ) {
      throw new BadRequestException(`Invalid whiteboard element at index ${i}`);
    }

    const expiredTombstone =
      el.isDeleted === true &&
      typeof el.updated === 'number' &&
      el.updated < cutoff;

    if (expiredTombstone) return;
    kept.push(
      typeof el.link === 'string' && isScriptableLink(el.link)
        ? { ...el, link: null }
        : el,
    );
  });

  return kept;
}

/** Schemes that run script or render attacker HTML when an element link is opened. */
function isScriptableLink(link: string): boolean {
  // Browsers ignore C0 controls and whitespace inside a scheme ("java\tscript:").
  // eslint-disable-next-line no-control-regex
  const compact = link.replace(/[\x00-\x20\x7f]/g, '').toLowerCase();

  return /^(?:javascript|vbscript|data):/.test(compact);
}

const startsWith = (buf: Buffer, bytes: number[], offset = 0) =>
  buf.length >= offset + bytes.length &&
  bytes.every((b, i) => buf[offset + i] === b);

const ascii = (buf: Buffer, start: number, end: number) =>
  buf.subarray(start, end).toString('latin1');

/** Magic-byte sniff for the raster types in WHITEBOARD_IMAGE_MIMES. */
function sniffRasterMime(buf: Buffer): string | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(ascii(buf, 0, 6))) return 'image/gif';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (ascii(buf, 0, 2) === 'BM') return 'image/bmp';
  if (startsWith(buf, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  if (
    ascii(buf, 4, 8) === 'ftyp' &&
    ['avif', 'avis'].includes(ascii(buf, 8, 12))
  ) {
    return 'image/avif';
  }

  return null;
}

/**
 * Valid UTF-8 whose first tag (after BOM, XML declaration, comments, DOCTYPE) is <svg.
 * A DOCTYPE with an internal subset is refused: its entities can expand into markup the
 * content checks below never see.
 */
function decodeSvg(buf: Buffer): string | null {
  let text: string;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }

  const prolog =
    /^\uFEFF?(?:\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*>)*<svg[\s/>]/i;

  return prolog.test(text) ? text : null;
}

/** Strips base64 payloads so encoded bytes cannot false-positive the attribute checks. */
const BASE64_RUN = /base64,[a-z0-9+/=]*/g;

/**
 * Executable content: script, event-handler attributes, foreignObject, javascript: / non-image data:
 * references, @import. Reject-only, never rewritten. http(s) references are allowed: whiteboard SVGs
 * are only ever shown as images (<img>/canvas), where browsers neither run nor fetch them, and
 * Excalidraw's own SVG export wraps linked shapes in <a href="https://…">.
 */
function svgIsUnsafe(text: string): boolean {
  const t = text.toLowerCase().replace(BASE64_RUN, 'base64,');

  if (
    t.includes('<script') ||
    t.includes('<foreignobject') ||
    t.includes('javascript:') ||
    t.includes('@import') ||
    /<[^>]*[\s"'/]on[a-z]+\s*=/.test(t) // inside a tag only: text like "one = 1" is fine
  ) {
    return true;
  }

  for (const m of t.matchAll(
    /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/g,
  )) {
    const value = (m[1] ?? m[2] ?? m[3]).trim();

    if (!/^(#|data:image\/|https?:\/\/)/.test(value)) return true;
  }

  for (const m of t.matchAll(/url\(([^)]*)\)/g)) {
    const value = m[1].trim().replace(/^["']\s*/, '');

    if (!/^(#|data:|https?:\/\/)/.test(value)) return true;
  }

  return false;
}

/**
 * The multipart Content-Type is client-chosen; the bytes must agree with it, and an SVG must
 * be inert. Same 400 as an unsupported type so clients keep treating it as "rejected".
 */
export function assertImageContent(buf: Buffer, mimeType: string): void {
  let ok: boolean;

  if (mimeType === 'image/svg+xml') {
    const svg = decodeSvg(buf);

    ok = svg !== null && !svgIsUnsafe(svg);
  } else {
    ok = sniffRasterMime(buf) === mimeType;
  }

  if (!ok) {
    throw new BadRequestException(
      `File content is not a valid "${mimeType}" image`,
    );
  }
}

/** Keeps only the whitelisted app_state keys, and only with the expected type. */
export function pickAppState(
  appState: Record<string, unknown>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};

  for (const [key, type] of Object.entries(APP_STATE_KEYS)) {
    const value = appState[key];

    if (typeof value !== type) continue;
    if (type === 'string' && (value as string).length > 64) continue;
    if (type === 'number' && !Number.isFinite(value)) continue;

    picked[key] = value;
  }

  return picked;
}

/** The history list shows the author's name like the wiki does (users has no full_name). */
function withVersionAuthor(
  row: Record<string, unknown>,
): WhiteboardVersionSummary {
  return {
    ...row,
    changed_by_user: withFullName(
      row['changed_by_user'] as Record<string, unknown> | null,
    ),
  } as WhiteboardVersionSummary;
}

/**
 * The scene a restore writes. Excalidraw merges concurrent scenes per element by `version`
 * (higher wins, versionNonce breaks ties), so every element the restore touches must outrank
 * what editors already hold:
 *  - each snapshot element comes back with version = max(current, snapshot) + 1;
 *  - an element that exists now but not in the snapshot becomes a tombstone, one version up;
 *  - an existing tombstone the snapshot does not know stays as it is.
 * Pure; `nonce` is injectable for tests.
 */
export function buildRestoredScene(
  current: Record<string, unknown>[],
  snapshot: Record<string, unknown>[],
  now: number,
  nonce: () => number = () => randomInt(2 ** 31),
): Record<string, unknown>[] {
  const versionOf = (el: Record<string, unknown> | undefined) =>
    Number.isInteger(el?.version) ? (el!.version as number) : 0;
  const currentById = new Map(current.map((el) => [el.id, el]));
  const snapshotIds = new Set(snapshot.map((el) => el.id));

  const restored = snapshot.map((el) => ({
    ...el,
    version: Math.max(versionOf(el), versionOf(currentById.get(el.id))) + 1,
    versionNonce: nonce(),
    updated: now,
  }));

  const removed = current
    .filter((el) => !snapshotIds.has(el.id))
    .map((el) =>
      el.isDeleted === true
        ? el
        : {
            ...el,
            isDeleted: true,
            version: versionOf(el) + 1,
            versionNonce: nonce(),
            updated: now,
          },
    );

  return [...restored, ...removed];
}
