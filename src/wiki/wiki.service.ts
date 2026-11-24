import { validateBlogMetadata, cloneBlogMetadata } from './macros/blog-posts';
/**
 * @fileoverview Wiki service — page CRUD, hierarchy, versioning,
 * attachments, links, search, contributors, and storage uploads.
 * (Comment logic lives in wiki-comments.service; collab in wiki-collab.service;
 * workflow in wiki-workflow.service.)
 * @module src/wiki/wiki.service
 */

import { browserSafeStorageUrl } from '../common/utils/browser-storage-url';
import { randomUUID } from 'crypto';
import { storageSafeFileName } from '../common/upload-filename';
import { formatMaxUpload, UPLOAD_LIMITS } from '../common/upload-limits';
import {
  assertImageMime,
  reconcileMimeWithExtension,
  storageContentType,
} from '../common/upload-mime';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { NotificationEmailService } from '../notifications/notification-email.service';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import type { CreateWikiPageDto } from './dto/create-wiki-page.dto';
import type { UpdateWikiPageDto } from './dto/update-wiki-page.dto';
import type { CreateWikiLinkDto } from './dto/create-wiki-link.dto';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { extractUserMentionIds } from '../common/utils/mention-extractor';
import { sanitizeRichText } from '../common/utils/sanitize-rich-text';
import { sanitizeWikiContentForStorage } from '../common/utils/sanitize-wiki-content';
import { validateTipTapDoc } from '../common/utils/tiptap-sanitizer';
import { assertSchemaCompatible } from './wiki-schema-guard';
import { fetchAllRows } from '../common/utils/fetch-all-rows';
import { databaseBadRequest } from '../common/utils/database-error';
import {
  extractTipTapUserMentionIds,
  extractWikiPlainText,
  tiptapToPlainText,
} from './wiki-content.util';
import { createLinkViewCheck } from '../tasks/task-links.util';
import { PermissionsService } from '../permissions/permissions.service';
import { WikiPermissionsService } from './wiki-permissions.service';
import { WikiFieldKeysService } from './wiki-field-keys.service';
import { buildWikiSearchFilter } from './wiki-search-filter.util';
import { WIKI_USER_COLUMNS, withFullName } from './wiki-user.util';
import { WatchersService } from '../watchers/watchers.service';
import {
  archivedError,
  WhiteboardsService,
  type WhiteboardSummary,
} from '../whiteboards/whiteboards.service';
import {
  buildWikiKeysetFilter,
  decodeWikiCursor,
  encodeWikiCursor,
  WIKI_ORDER_COLUMNS,
  wikiCursorValues,
  type WikiListOrder,
} from './wiki-keyset-cursor.util';

const WIKI_IMAGES_BUCKET = 'wiki-attachments';

export { browserSafeStorageUrl } from '../common/utils/browser-storage-url';

/** Wiki inline images accept any `image/*` type, SVG included — as this endpoint always has. */
const IMAGE_MIME_OPTS = { allowSvg: true } as const;

/**
 * Wiki ATTACHMENTS have no type restriction at all. The previous allow-list had to be extended
 * twice already (once for presentations, once for OpenDocument) because Confluence pages attach
 * arbitrary file types, and each gap silently dropped an attachment while the page itself imported
 * — a loss that was easy to miss. Type is not the control here; size is.
 *
 * These land in a PUBLIC bucket served via `getPublicUrl`, so `storageContentType` downgrades
 * script-executing types to `application/octet-stream` on write. Nothing is rejected.
 */
const MAX_ATTACHMENT_SIZE = UPLOAD_LIMITS.ATTACHMENT;
const MAX_IMAGE_SIZE = UPLOAD_LIMITS.CONTENT_IMAGE;

/** Internal derivative used only by the migration path for legacy Word previews. */
export interface WikiAttachmentPreview {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

/** A collab session is considered live when its heartbeat is younger than this. */
const COLLAB_SESSION_TTL_MS = 120_000;

/** Hard cap on rows fetched by the ACL-aware (in-memory) list pagination path. */
const ACL_LIST_FETCH_CAP = 5000;

/**
 * PostgREST clamps every response to `max_rows` (1000 — see
 * risk-management-app/supabase/config.toml). A `.limit()` above that is silently
 * reduced to it.
 *
 * That made the `truncated` flag on the single-fetch ACL path dead code: we asked
 * for 5000, the server returned at most 1000, and `1000 >= 5000` is never true —
 * so a truncated page reported itself as complete, which is precisely what the
 * comment at that call site says must never happen.
 *
 * Only the SINGLE-FETCH path is clamped this way. The keyset path accumulates
 * `scanned` across several bounded passes and can legitimately reach
 * ACL_LIST_FETCH_CAP, so it deliberately keeps using the larger constant.
 */
const POSTGREST_MAX_ROWS = 1000;
const ACL_LIST_SINGLE_FETCH_CAP = Math.min(
  ACL_LIST_FETCH_CAP,
  POSTGREST_MAX_ROWS,
);

/**
 * Keyset over-fetch factor on the ACL path. Permission filtering runs after the read, so asking for
 * exactly `limit` rows yields a short page; asking for a multiple and stopping once `limit` survive
 * keeps pages full without unbounded scanning.
 */
const ACL_KEYSET_OVERFETCH = 3;

/** Bound on over-fetch passes, so a densely restricted space cannot spin. */
const ACL_KEYSET_MAX_PASSES = 8;

/** wiki_pages display columns fetched by the ACL-aware list path (no content). */
const PAGE_LIST_COLUMNS =
  'id, space_id, organization_id, title, slug, parent_id, path, level, ' +
  'is_published, is_archived, published_at, tags, metadata, category_id, ' +
  'sort_order, has_custom_permissions, workflow_status, created_by, ' +
  'updated_by, created_at, updated_at, whiteboard_id';

export interface WikiTaskReportItem {
  checked: boolean;
  description: string;
  due_at: string | null;
  assignee: string | null;
  page: { id: string; title: string; slug: string };
}

type TipTapValue = {
  type?: unknown;
  text?: unknown;
  attrs?: Record<string, unknown>;
  content?: TipTapValue[];
};

function taskText(node: TipTapValue): string {
  if (node.type === 'date') return '';
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'userMention') {
    const label = node.attrs?.label ?? node.attrs?.displayName;
    return typeof label === 'string' ? `@${label.replace(/^@/, '')}` : '@user';
  }
  return (node.content ?? []).map(taskText).join('');
}

function collectTaskItems(
  node: TipTapValue,
  page: WikiTaskReportItem['page'],
  out: WikiTaskReportItem[],
): void {
  if (node.type === 'taskItem') {
    const children = node.content ?? [];
    const dateNode = children
      .flatMap((child) => child.content ?? [])
      .find((child) => child.type === 'date');
    const timestamp = Number(dateNode?.attrs?.timestamp);
    const mention = children
      .flatMap((child) => child.content ?? [])
      .find((child) => child.type === 'userMention');
    const assignee = mention?.attrs?.label ?? mention?.attrs?.displayName;

    out.push({
      checked: node.attrs?.checked === true,
      description: taskText(node).replace(/\s+/g, ' ').trim(),
      due_at: Number.isFinite(timestamp)
        ? new Date(timestamp).toISOString()
        : null,
      assignee: typeof assignee === 'string' && assignee ? assignee : null,
      page,
    });
  }

  for (const child of node.content ?? []) collectTaskItems(child, page, out);
}

@Injectable()
export class WikiService {
  private static readonly PAGES = 'wiki_pages';
  private static readonly VERSIONS = 'wiki_page_versions';
  private static readonly COMMENTS = 'wiki_page_comments';
  private static readonly ATTACHMENTS = 'wiki_page_attachments';

  private readonly logger = new Logger(WikiService.name);
  private static readonly LINKS = 'wiki_page_links';
  private static readonly AUDIT_LOGS = 'audit_logs';
  private static readonly COLLAB_SNAPSHOTS = 'wiki_page_collab_snapshots';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly wikiPermissions: WikiPermissionsService,
    private readonly wikiFieldKeys: WikiFieldKeysService,
    private readonly outboxService?: AutomationEventOutboxService,
    @Optional()
    private readonly notificationsBroadcast?: NotificationsBroadcastService,
    @Optional()
    private readonly notificationEmail?: NotificationEmailService,
    // Gates task/process link targets (XE-T532 #4). Absent → they fail closed.
    @Optional()
    private readonly permissionsService?: PermissionsService,
    @Optional()
    @Inject(forwardRef(() => WatchersService))
    private readonly watchersService?: WatchersService,
    // Boards behind whiteboard link rows. Absent → those writes fail closed.
    @Optional()
    private readonly whiteboardsService?: WhiteboardsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private get boards(): WhiteboardsService {
    if (!this.whiteboardsService) {
      throw new ForbiddenException('Whiteboards are not enabled in this space');
    }

    return this.whiteboardsService;
  }

  /** A whiteboard link row acts on the board, so it also needs the Whiteboards space key. */
  private async assertWhiteboardPermission(
    userId: string,
    organizationId: string,
    spaceId: string,
    permission:
      | 'create_whiteboards'
      | 'edit_whiteboards'
      | 'delete_whiteboards',
  ): Promise<void> {
    const allowed = await this.permissionsService?.hasSpacePermission(
      userId,
      organizationId,
      spaceId,
      permission,
    );

    if (!allowed)
      throw new ForbiddenException('Insufficient space permissions');
  }

  /**
   * Best-effort audit write. Callers fire-and-forget with `void`, but the
   * insert itself MUST be awaited: a PostgREST builder is a thenable that only
   * issues its request from `then()`, so `void builder` sends nothing at all.
   */
  private async logAudit(
    organizationId: unknown,
    userId: string,
    entityId: string,
    action:
      | 'create'
      | 'update'
      | 'delete'
      | 'archive'
      | 'restore'
      | 'permission_change'
      | 'workflow_transition'
      | 'restore_version'
      | 'convert_format',
    changes?: Record<string, unknown>,
  ): Promise<void> {
    if (!organizationId || typeof organizationId !== 'string') return;

    try {
      await this.client.from(WikiService.AUDIT_LOGS).insert({
        organization_id: organizationId,
        user_id: userId,
        entity_type: 'wiki_page',
        entity_id: entityId,
        action,
        changes: changes ?? null,
      });
    } catch {
      // Audit logging is best-effort and must not fail wiki mutations.
    }
  }

  // ------------------------------------------------------------------ //
  // Content sanitization (write path)                                    //
  // ------------------------------------------------------------------ //

  /**
   * Sanitizes page content on write according to its format and computes the
   * plain-text projection stored in `content_text` (which feeds the generated
   * `search_vector` — never written directly).
   *
   * - 'tiptap'  → strict whitelist validation (canonical JSON string)
   * - 'html'    → DOMPurify sanitization
   * - 'editorjs'→ stored as-is (legacy path; the MCP layer sanitizes its own)
   */
  private sanitizeContentForWrite(
    content: string,
    format: string,
  ): { content: string; contentText: string } {
    if (format === 'tiptap') {
      const validated = validateTipTapDoc(content);

      return {
        content: validated.json,
        contentText: tiptapToPlainText(validated.doc),
      };
    }

    if (format === 'html') {
      // Wiki is a table-capable surface, so opt in — matching `wiki-content.util.ts` and
      // `wiki-mine-write.service.ts`. Without `allowTables` the sanitizer keeps a table's cell
      // TEXT but strips its grid, which silently flattened every table on migrated Confluence
      // pages (the Atlassian importer writes them as `content_format: 'html'`).
      const sanitized = sanitizeRichText(content, { allowTables: true }) ?? '';

      return {
        content: sanitized,
        contentText: extractWikiPlainText(sanitized, 'html'),
      };
    }

    // SECURITY (H9): Editor.js is the DEFAULT format and its content is injected
    // by the renderers via dangerouslySetInnerHTML, so it must be sanitized on
    // write like the other two formats. This is format-aware — it preserves the
    // block structure and only cleans the HTML-bearing fields, leaving URL and
    // layout fields byte-identical.
    const sanitizedEditorjs = sanitizeWikiContentForStorage(
      content,
      'editorjs',
    );

    return {
      content: sanitizedEditorjs,
      contentText: extractWikiPlainText(sanitizedEditorjs, 'editorjs'),
    };
  }

  /**
   * Validates that every key in `custom_field_values` refers to a custom field
   * assigned to this space's wiki (`wiki_field_assignments`), or is a key
   * already stored on the page. Value shapes stay app-side loose
   * (primitives/arrays/objects), mirroring tasks.
   *
   * @see WikiFieldKeysService for why assignments — not `contexts` — are the gate.
   */
  private async validateCustomFieldValues(
    organizationId: string,
    spaceId: string,
    values: Record<string, unknown>,
    stored?: Record<string, unknown> | null,
  ): Promise<void> {
    await this.wikiFieldKeys.assertKeysAllowed(
      organizationId,
      spaceId,
      Object.keys(values),
      Object.keys(stored ?? {}),
    );
  }

  // ------------------------------------------------------------------ //
  // Pages — CRUD                                                         //
  // ------------------------------------------------------------------ //

  /**
   * Lists wiki pages in a space with ACL-aware pagination.
   *
   * When `userId` is provided:
   *  (a) space/org admins get plain SQL pagination;
   *  (b) if the space has NO restricted pages (has_custom_permissions probe)
   *      AND the user's space baseline grants view, SQL pagination is safe;
   *  (c) otherwise slim rows (no content) are fetched (capped at 5000),
   *      filtered through the page ACL, and paginated in memory so
   *      total/hasMore are correct after filtering.
   *
   * Without `userId` (site-studio public path) the legacy SQL pagination is
   * used unchanged — callers apply their own exposure rules.
   */
  async getPages(
    spaceId: string,
    filters: {
      parent_id?: string | null;
      is_published?: boolean;
      is_archived?: boolean;
      search?: string;
      category_id?: string;
      limit?: number;
      offset?: number;
      /** Keyset cursor; preferred over `offset` when both are supplied. */
      cursor?: string;
      /** `tree` orders by depth first, so a parent always precedes its children. */
      order?: WikiListOrder;
    },
    userId?: string,
  ): Promise<{
    data: unknown[];
    total: number;
    hasMore: boolean;
    nextCursor?: string;
    truncated?: boolean;
  }> {
    const limit = Math.min(filters.limit ?? 200, 500);
    const offset = filters.offset ?? 0;
    const order: WikiListOrder = filters.order === 'tree' ? 'tree' : 'default';
    const cursorValues = filters.cursor
      ? decodeWikiCursor(filters.cursor, order)
      : null;

    // A cursor that fails to decode is a client bug, not an empty result — say so rather than
    // silently restarting from the top, which would loop the caller over page 1 forever.
    if (filters.cursor && !cursorValues) {
      throw new BadRequestException('Invalid or mismatched pagination cursor');
    }

    interface FilterableQuery {
      eq(column: string, value: unknown): FilterableQuery;
      is(column: string, value: unknown): FilterableQuery;
      or(filter: string): FilterableQuery;
    }

    /**
     * Minimal shape of the ordering/paging surface. Kept deliberately narrow and applied through a
     * cast: chaining `.order()` per tuple column on the real PostgREST builder makes its generics
     * recurse until tsc gives up with "type instantiation is excessively deep".
     */
    interface OrderableQuery {
      order(column: string, opts: { ascending: boolean }): OrderableQuery;
      or(filter: string): OrderableQuery;
      limit(count: number): OrderableQuery;
      range(from: number, to: number): OrderableQuery;
    }

    /** Apply the ordering tuple for `order`, plus the keyset predicate when paging by cursor. */
    const applyOrdering = (query: unknown): OrderableQuery => {
      let q = query as OrderableQuery;

      for (const column of WIKI_ORDER_COLUMNS[order]) {
        q = q.order(column, { ascending: true });
      }

      if (cursorValues) {
        q = q.or(buildWikiKeysetFilter(order, cursorValues));
      }

      return q;
    };

    const applyFilters = <T extends FilterableQuery>(query: T): T => {
      let q: FilterableQuery = query;

      if (filters.parent_id !== undefined) {
        if (filters.parent_id === null || filters.parent_id === 'null') {
          q = q.is('parent_id', null);
        } else {
          q = q.eq('parent_id', filters.parent_id);
        }
      }
      if (filters.is_published !== undefined)
        q = q.eq('is_published', filters.is_published);
      if (filters.is_archived !== undefined)
        q = q.eq('is_archived', filters.is_archived);
      if (filters.category_id) q = q.eq('category_id', filters.category_id);
      if (filters.search) {
        const searchFilter = buildWikiSearchFilter(filters.search);

        if (searchFilter) q = q.or(searchFilter);
      }

      return q as T;
    };

    const sqlPaginated = async (): Promise<{
      data: unknown[];
      total: number;
      hasMore: boolean;
    }> => {
      // PAGE_LIST_COLUMNS, not `*`: `*` drags `content` (up to 5 MB per the DTO) and `content_text`
      // into every row of a 200-row listing. It also made this branch return a DIFFERENT column set
      // from the ACL branch below for the very same endpoint, purely depending on whether the space
      // happened to contain one restricted page.
      let q = this.client
        .from(WikiService.PAGES)
        .select(PAGE_LIST_COLUMNS, { count: 'exact' })
        .eq('space_id', spaceId);

      q = applyFilters(q);

      let ordered = applyOrdering(q);

      // With a cursor the keyset predicate already positions us; `range` would offset AGAIN.
      ordered = cursorValues
        ? ordered.limit(limit)
        : ordered.range(offset, offset + limit - 1);

      const { data, error, count } = (await ordered) as unknown as {
        data: Record<string, unknown>[] | null;
        error: { message: string } | null;
        count: number | null;
      };

      if (error) throw new BadRequestException(error.message);

      const rows = data ?? [];
      const last = rows[rows.length - 1];
      const hasMore = cursorValues
        ? rows.length === limit
        : offset + rows.length < (count ?? 0);

      return {
        data: rows,
        total: count ?? 0,
        hasMore,
        ...(hasMore && last
          ? {
              nextCursor: encodeWikiCursor(
                order,
                wikiCursorValues(last, order),
              ),
            }
          : {}),
      };
    };

    if (!userId) return sqlPaginated();

    const ctx = await this.wikiPermissions.resolveUserContext(userId, spaceId);

    if (ctx.isSpaceAdmin) return sqlPaginated();

    const [hasRestricted, baseline] = await Promise.all([
      this.wikiPermissions.spaceHasRestrictedPages(spaceId),
      this.wikiPermissions.getSpaceBaseline(userId, spaceId),
    ]);

    if (!hasRestricted && baseline.can_view) return sqlPaginated();

    // ── ACL-aware path ──────────────────────────────────────────────────────
    //
    // Permission filtering happens AFTER the read, so a plain `LIMIT n` returns fewer than `n`
    // visible rows. With a cursor we therefore over-fetch in a bounded loop until `limit` rows
    // survive, and emit the cursor from the last SURVIVING row — emitting it from the last FETCHED
    // row would silently skip every row the filter removed at the tail of the batch.
    if (cursorValues) {
      const kept: Record<string, unknown>[] = [];
      let key = cursorValues;
      let exhausted = false;
      let scanned = 0;

      for (let pass = 0; pass < ACL_KEYSET_MAX_PASSES; pass++) {
        if (kept.length >= limit || exhausted) break;

        const batchSize = Math.min(limit * ACL_KEYSET_OVERFETCH, 500);

        let bq = this.client
          .from(WikiService.PAGES)
          .select(PAGE_LIST_COLUMNS)
          .eq('space_id', spaceId);

        bq = applyFilters(bq);

        let bordered = bq as unknown as OrderableQuery;

        for (const column of WIKI_ORDER_COLUMNS[order]) {
          bordered = bordered.order(column, { ascending: true });
        }

        bordered = bordered
          .or(buildWikiKeysetFilter(order, key))
          .limit(batchSize);

        const { data: batch, error: batchError } =
          (await bordered) as unknown as {
            data: Record<string, unknown>[] | null;
            error: { message: string } | null;
          };

        if (batchError) throw new BadRequestException(batchError.message);

        const rows = batch ?? [];

        scanned += rows.length;
        if (rows.length < batchSize) exhausted = true;
        if (rows.length === 0) break;

        // Advance the key even when nothing survives, so the next pass makes progress.
        key = wikiCursorValues(rows[rows.length - 1], order);

        const visible = (await this.wikiPermissions.filterAccessiblePages(
          rows,
          userId,
          spaceId,
        )) as Record<string, unknown>[];

        kept.push(...visible);
      }

      const page = kept.slice(0, limit);
      const lastKept = page[page.length - 1];
      const hasMore = !exhausted || kept.length > limit;

      return {
        data: page,
        // `total` is unknowable without scanning the whole space; the cursor contract is
        // hasMore/nextCursor, and reporting a partial count as a total would be a lie.
        total: page.length,
        hasMore,
        ...(hasMore && lastKept
          ? {
              nextCursor: encodeWikiCursor(
                order,
                wikiCursorValues(lastKept, order),
              ),
            }
          : {}),
        ...(scanned >= ACL_LIST_FETCH_CAP ? { truncated: true } : {}),
      };
    }

    // Offset path (kept for existing callers): fetch slim rows, filter, slice.
    let q = this.client
      .from(WikiService.PAGES)
      .select(PAGE_LIST_COLUMNS)
      .eq('space_id', spaceId);

    q = applyFilters(q);

    const ordered = applyOrdering(q).limit(ACL_LIST_SINGLE_FETCH_CAP);

    const { data, error } = (await ordered) as unknown as {
      data: unknown[] | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);

    const fetched = data ?? [];

    const accessible = await this.wikiPermissions.filterAccessiblePages(
      fetched,
      userId,
      spaceId,
    );
    const total = accessible.length;

    return {
      data: accessible.slice(offset, offset + limit),
      total,
      hasMore: offset + limit < total,
      // The cap silently discarded rows: `total` under-reports and anything past it is unreachable.
      // Say so — "couldn't read it all" must never look like "that's all there is".
      ...(fetched.length >= ACL_LIST_SINGLE_FETCH_CAP
        ? { truncated: true }
        : {}),
    };
  }

  async getPageById(pageId: string, spaceId: string): Promise<unknown> {
    const r = await this.client
      .from(WikiService.PAGES)
      .select('*')
      .eq('id', pageId)
      .eq('space_id', spaceId)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Wiki page not found');
    return r.data as unknown;
  }

  async getPageBySlugOrId(idOrSlug: string, spaceId: string): Promise<unknown> {
    // Try UUID first
    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRe.test(idOrSlug)) {
      return this.getPageById(idOrSlug, spaceId);
    }
    // Fall back to slug
    const r = await this.client
      .from(WikiService.PAGES)
      .select('*')
      .eq('slug', idOrSlug)
      .eq('space_id', spaceId)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Wiki page not found');
    return r.data as unknown;
  }

  async getPageWithRelations(
    pageId: string,
    spaceId: string,
  ): Promise<unknown> {
    const page = await this.getPageById(pageId, spaceId);
    const p = page as Record<string, unknown>;

    // Creator/updater ids come from the page row already scoped to this space.
    const userIds = [
      ...new Set(
        [p['created_by'], p['updated_by']].filter(
          (id): id is string => typeof id === 'string',
        ),
      ),
    ];

    const [children, attachmentCount, commentCount, users, latestVersion] =
      await Promise.all([
        this.client
          .from(WikiService.PAGES)
          .select('id', { count: 'exact', head: true })
          .eq('parent_id', pageId),
        this.client
          .from(WikiService.ATTACHMENTS)
          .select('id', { count: 'exact', head: true })
          .eq('wiki_page_id', pageId)
          // Count files, not versions of files (XE-T542).
          .eq('is_current', true),
        this.client
          .from(WikiService.COMMENTS)
          .select('id', { count: 'exact', head: true })
          .eq('wiki_page_id', pageId),
        userIds.length
          ? this.client
              .from('users')
              .select(WIKI_USER_COLUMNS)
              .in('id', userIds)
          : Promise.resolve({ data: [] as Record<string, unknown>[] }),
        // wiki_pages has no version column; the history table's latest row is the version.
        this.client
          .from(WikiService.VERSIONS)
          .select('version')
          .eq('wiki_page_id', pageId)
          .order('version', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

    const userById = new Map(
      ((users.data ?? []) as Record<string, unknown>[]).map((u) => [
        u['id'],
        u,
      ]),
    );

    return {
      ...p,
      child_count: children.count ?? 0,
      attachment_count: attachmentCount.count ?? 0,
      comment_count: commentCount.count ?? 0,
      created_by_user: withFullName(userById.get(p['created_by'])),
      updated_by_user: withFullName(userById.get(p['updated_by'])),
      version:
        (latestVersion.data as { version?: number } | null)?.version ?? 1,
    };
  }

  async createPage(
    dto: CreateWikiPageDto,
    organizationId: string,
    userId: string,
    options?: {
      tolerateFieldKeys?: string[];
      sourceUpdatedAt?: string;
      sortOrder?: number;
      /** createWhiteboardPage only; never a DTO field, so an API client cannot link a board. */
      whiteboardId?: string;
      /** Robert's reserved page id, so a retried Confirm finds the page it already made. Never a DTO field. */
      id?: string;
    },
  ): Promise<unknown> {
    validateBlogMetadata(dto.metadata);

    // Migration-only. Deliberately a service option rather than a DTO field, so an API
    // client cannot fake a source date through the public create endpoint — same reason
    // `createAttachment` takes `sourceCreatedAt` as a parameter. XE-T552.
    if (options?.sourceUpdatedAt) {
      this.assertIsoInstant(options.sourceUpdatedAt);
    }

    // Migration-only, same reasoning: the source's sibling order. `sort_order` is int4.
    if (
      options?.sortOrder !== undefined &&
      !(
        Number.isInteger(options.sortOrder) &&
        Math.abs(options.sortOrder) <= 2147483647
      )
    ) {
      throw new BadRequestException('Sort order must be a 32-bit integer');
    }
    // Generate slug if not provided
    let slug = dto.slug ?? this.slugify(dto.title);

    // Ensure slug uniqueness in space
    slug = await this.ensureUniqueSlug(dto.space_id, slug);

    const contentFormat = dto.content_format ?? 'editorjs';
    const { content, contentText } = this.sanitizeContentForWrite(
      dto.content ?? '',
      contentFormat,
    );

    if (dto.custom_field_values !== undefined) {
      // `tolerateFieldKeys` lets clonePage carry over values whose fields are no
      // longer assigned, instead of failing the whole clone.
      await this.wikiFieldKeys.assertKeysAllowed(
        organizationId,
        dto.space_id,
        Object.keys(dto.custom_field_values),
        options?.tolerateFieldKeys,
      );
    }

    // Compute path and level from parent
    let path: string[] = [];
    let level = 0;

    if (dto.parent_id) {
      const { data: parent, error } = await this.client
        .from(WikiService.PAGES)
        .select('path, level, space_id, is_archived')
        .eq('id', dto.parent_id)
        .maybeSingle();
      if (error || !parent) {
        throw new BadRequestException('Parent page not found');
      }
      const p = parent as Record<string, unknown>;
      if (p['space_id'] !== dto.space_id) {
        throw new BadRequestException('Parent must be in the same space');
      }
      if (p['is_archived']) {
        throw new BadRequestException(
          'Cannot create page under an archived parent',
        );
      }
      path = [...((p['path'] as string[]) ?? []), dto.parent_id];
      level = ((p['level'] as number) ?? 0) + 1;
      if (level > 10) {
        throw new BadRequestException(
          'Maximum wiki page nesting depth (10) exceeded',
        );
      }
    }

    const ins = (await this.client
      .from(WikiService.PAGES)
      .insert({
        ...(options?.id ? { id: options.id } : {}),
        space_id: dto.space_id,
        organization_id: organizationId,
        title: dto.title,
        slug,
        content,
        content_format: contentFormat,
        content_text: contentText,
        custom_field_values: dto.custom_field_values ?? {},
        workflow_status: dto.is_published ? 'published' : 'draft',
        parent_id: dto.parent_id ?? null,
        path,
        level,
        is_published: dto.is_published ?? false,
        is_archived: false,
        tags: dto.tags ?? [],
        metadata: dto.metadata ?? {},
        has_custom_permissions: false,
        created_by: userId,
        updated_by: userId,

        // The source system's last-modified date for an imported page. `updated_at` cannot
        // carry it: the shared BEFORE-UPDATE trigger resets it on every later stage write.
        // XE-T552.
        ...(options?.sourceUpdatedAt
          ? { source_updated_at: options.sourceUpdatedAt }
          : {}),
        ...(options?.sortOrder !== undefined
          ? { sort_order: options.sortOrder }
          : {}),
        ...(options?.whiteboardId
          ? { whiteboard_id: options.whiteboardId }
          : {}),
      })
      .select()
      .single()) as {
      data: { id: string; title: string; is_published: boolean } | null;
      error: { message: string } | null;
    };

    // The cause keeps the database code (23505 on a slug or id race) for callers that retry.
    if (ins.error) throw databaseBadRequest(ins.error);

    const insData = ins.data as {
      id: string;
      title: string;
      is_published: boolean;
    };

    void this.logAudit(organizationId, userId, insData.id, 'create', {
      title: dto.title,
      space_id: dto.space_id,
      parent_id: dto.parent_id ?? null,
    });

    void this.outboxService?.write(
      organizationId,
      dto.space_id,
      'app.wiki.page_created',
      {
        page: {
          id: insData.id,
          title: insData.title,
          space_id: dto.space_id,
          status: insData.is_published ? 'published' : 'draft',
        },
        page_id: insData.id,
        space_id: dto.space_id,
        created_by: userId,
      },
    );

    if (content) {
      void this.notifyMentionedUsers(
        content,
        'wiki_page',
        insData.id,
        insData.id,
        dto.title,
        organizationId,
        userId,
        dto.space_id,
        null,
        contentFormat,
      );
    }

    return insData as unknown;
  }

  /**
   * A whiteboard plus its link row in the tree. The board goes first (its module check runs
   * there); if the row cannot be written the board is deleted again, so a failure leaves neither.
   * Parent ACL is the caller's job, as for createPage.
   */
  async createWhiteboardPage(
    spaceId: string,
    user: RequestUser,
    dto: { name: string; parent_id?: string },
  ): Promise<{ page: unknown; whiteboard: WhiteboardSummary }> {
    await this.assertWhiteboardPermission(
      user.userId,
      user.organizationId,
      spaceId,
      'create_whiteboards',
    );

    const whiteboard = await this.boards.create(spaceId, user, dto.name);

    try {
      const page = await this.createPage(
        {
          space_id: spaceId,
          title: whiteboard.name,
          parent_id: dto.parent_id,
          is_published: true,
        },
        user.organizationId,
        user.userId,
        { whiteboardId: whiteboard.id },
      );

      return { page, whiteboard };
    } catch (error) {
      await this.boards
        .removeFromWiki(spaceId, user, whiteboard.id)
        .catch((cleanup: Error) =>
          this.logger.warn(
            `createWhiteboardPage: whiteboard ${whiteboard.id} left without a tree row: ${cleanup.message}`,
          ),
        );
      throw error;
    }
  }

  /**
   * The board's link row, created at the wiki root when it has none (a board made from the
   * Whiteboards list): a board's Share setting is that row's page ACL. Idempotent; a concurrent
   * first share loses on the unique index and gets the winner's row.
   */
  async ensureWhiteboardPage(
    spaceId: string,
    user: RequestUser,
    whiteboardId: string,
  ): Promise<{ id: string }> {
    await this.assertWhiteboardPermission(
      user.userId,
      user.organizationId,
      spaceId,
      'edit_whiteboards',
    );

    // Org + space scoped, and refuses when Whiteboards is off
    const board = await this.boards.getOne(
      spaceId,
      user.organizationId,
      whiteboardId,
    );

    if (board.wiki_page_id) return { id: board.wiki_page_id };

    try {
      const page = (await this.createPage(
        { space_id: spaceId, title: board.name, is_published: true },
        user.organizationId,
        user.userId,
        { whiteboardId },
      )) as { id: string };

      return { id: page.id };
    } catch (error) {
      const again = await this.boards.getOne(
        spaceId,
        user.organizationId,
        whiteboardId,
      );

      if (again.wiki_page_id) return { id: again.wiki_page_id };
      throw error;
    }
  }

  /**
   * Recompute `path`/`level` for every descendant of `pageId`, top-down. Migration-only.
   *
   * Both columns are owned by the `wiki_pages_path` trigger, which fires only on a write to
   * `parent_id` and reads the PARENT's stored path — so re-parenting one page leaves its whole
   * subtree with stale paths. Re-setting each descendant's `parent_id` to its current value, in
   * level order, makes the trigger rebuild them parent-first.
   *
   * @returns how many descendants were refreshed.
   */
  async refreshSubtreePaths(
    organizationId: string,
    pageId: string,
  ): Promise<number> {
    const { rows } = await fetchAllRows<{
      id: string;
      parent_id: string | null;
    }>(
      (from, to) =>
        this.client
          .from(WikiService.PAGES)
          .select('id, parent_id')
          .eq('organization_id', organizationId)
          .contains('path', [pageId])
          .neq('id', pageId)
          .order('level', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      Infinity,
    );

    for (const row of rows) {
      const { error } = await this.client
        .from(WikiService.PAGES)
        .update({ parent_id: row.parent_id })
        .eq('organization_id', organizationId)
        .eq('id', row.id);

      if (error) throw new BadRequestException(error.message);
    }

    return rows.length;
  }

  async clonePage(
    sourcePageId: string,
    spaceId: string,
    userId: string,
    organizationId: string,
  ): Promise<unknown> {
    const source = (await this.getPageById(sourcePageId, spaceId)) as Record<
      string,
      unknown
    >;

    if (source['whiteboard_id']) {
      throw new BadRequestException('A whiteboard cannot be cloned');
    }

    const cloneDto: CreateWikiPageDto = {
      space_id: spaceId,
      title: `${String(source['title'])} (Copy)`,
      content: (source['content'] as string) ?? '',
      content_format: (source['content_format'] as string) ?? 'editorjs',
      parent_id: (source['parent_id'] as string) ?? undefined,
      category_id: (source['category_id'] as string) ?? undefined,
      tags: Array.isArray(source['tags'])
        ? [...(source['tags'] as string[])]
        : [],
      metadata: cloneBlogMetadata(
        source['metadata'] as Record<string, unknown> | undefined,
      ),
      custom_field_values: source['custom_field_values']
        ? { ...(source['custom_field_values'] as Record<string, unknown>) }
        : undefined,
      is_published: false,
    };

    // Tolerate the source's stored keys: a field that was un-assigned after the
    // value was written must not make the whole clone fail.
    return this.createPage(cloneDto, organizationId, userId, {
      tolerateFieldKeys: Object.keys(
        (source['custom_field_values'] as Record<string, unknown>) ?? {},
      ),
    });
  }

  /**
   * Updates a wiki page.
   *
   * Wiki 2.0 additions:
   *  - Collab-active gate: while a live collab session owns the page, writes
   *    from other sessions 409 with code `COLLAB_ACTIVE`.
   *  - Optimistic lock: when `expectedUpdatedAt` is supplied a guarded
   *    updated_at claim is performed; a stale value 409s with `STALE_WRITE`.
   *  - Lazy conversion: when `convertedFrom` is supplied the claim also pins
   *    the current content_format so exactly one client wins the conversion;
   *    losers 409 with `ALREADY_CONVERTED`. A successful conversion bumps
   *    `metadata._version_hint` so the versioning trigger cuts a boundary.
   *  - Content is sanitized per content_format and `content_text` recomputed.
   */
  async updatePage(
    pageId: string,
    spaceId: string,
    dto: UpdateWikiPageDto,
    userId: string,
    watcherChangeKind = 'page_updated',
    schemaGuard?: { header?: string },
  ): Promise<unknown> {
    validateBlogMetadata(dto.metadata);
    const existing = (await this.getPageById(pageId, spaceId)) as Record<
      string,
      unknown
    >;

    // Only REST callers pass schemaGuard; internal writes stay unguarded.
    if (schemaGuard) {
      assertSchemaCompatible(
        existing['content'],
        dto.content,
        schemaGuard.header,
      );
    }

    // Collab-active gate: a fresh session owns the page; only writes carrying
    // that session id may proceed.
    //
    // Scoped to writes that actually touch the collaborative document. The gate exists to
    // protect the ydoc from a blind overwrite, and a property-only write (metadata, tags,
    // title, publish/archive, sort_order) cannot clobber it. Gating those too meant the
    // page-width toggle — which PUTs `{ metadata }` and has no way to supply a
    // collabSessionId — 409'd for the whole 120s session TTL and surfaced as "save failed"
    // (XE-T458). Same reasoning already produced the custom-fields PATCH carve-out; this
    // fixes the whole class instead of adding another one-off route.
    const touchesCollabDocument = dto.content !== undefined;

    const snapRes = await this.client
      .from(WikiService.COLLAB_SNAPSHOTS)
      .select('active_session_id, session_heartbeat_at')
      .eq('wiki_page_id', pageId)
      .eq('space_id', spaceId)
      .maybeSingle();
    const snap = snapRes.data as {
      active_session_id?: string | null;
      session_heartbeat_at?: string | null;
    } | null;

    if (touchesCollabDocument && snap?.active_session_id) {
      const heartbeat = snap.session_heartbeat_at
        ? Date.parse(snap.session_heartbeat_at)
        : 0;
      const isLive = heartbeat > Date.now() - COLLAB_SESSION_TTL_MS;

      if (isLive && dto.collabSessionId !== snap.active_session_id) {
        throw new ConflictException({
          message: 'A live collaborative editing session owns this page',
          code: 'COLLAB_ACTIVE',
          data: { sessionId: snap.active_session_id },
        });
      }
    }

    // Validate: cannot be both published and archived
    const willPublish =
      dto.is_published ?? (existing['is_published'] as boolean);
    const willArchive = dto.is_archived ?? (existing['is_archived'] as boolean);
    if (willPublish && willArchive) {
      throw new BadRequestException(
        'Page cannot be both published and archived',
      );
    }

    // Whiteboard link row: its title is the board's name (triggers sync the two), and archiving
    // lives on the board.
    const whiteboardId = existing['whiteboard_id'] as string | null;

    if (whiteboardId) {
      if (dto.is_archived === true) {
        throw new BadRequestException(
          'Archive the whiteboard itself, not its wiki entry',
        );
      }

      const title = dto.title?.trim();

      if (title !== undefined && title !== existing['title']) {
        const organizationId = existing['organization_id'] as string;

        await this.assertWhiteboardPermission(
          userId,
          organizationId,
          spaceId,
          'edit_whiteboards',
        );

        if (title.length < 1 || title.length > 200) {
          throw new BadRequestException(
            'Whiteboard name must be 1 to 200 characters',
          );
        }

        const board = await this.client
          .from('whiteboards')
          .select('is_archived')
          .eq('id', whiteboardId)
          .eq('space_id', spaceId)
          .eq('organization_id', organizationId)
          .maybeSingle();

        if (board.error) throw new BadRequestException(board.error.message);
        if ((board.data as { is_archived?: boolean } | null)?.is_archived) {
          throw archivedError();
        }
      }

      if (title !== undefined) dto = { ...dto, title };
    }

    if (dto.custom_field_values !== undefined) {
      await this.validateCustomFieldValues(
        (existing['organization_id'] as string) ?? '',
        spaceId,
        dto.custom_field_values,
        existing['custom_field_values'] as Record<string, unknown> | null,
      );
    }

    // Slug uniqueness check (skip if unchanged)
    let slug = dto.slug;
    if (slug && slug !== existing['slug']) {
      slug = await this.ensureUniqueSlug(spaceId, slug, pageId);
    }

    // Parent change: re-compute path + level
    let path: string[] | undefined;
    let level: number | undefined;
    let movedDescendants:
      | Awaited<ReturnType<WikiService['getDescendants']>>
      | undefined;
    if (dto.parent_id !== undefined) {
      if (dto.parent_id === pageId) {
        throw new BadRequestException('Page cannot be its own parent');
      }
      if (dto.parent_id) {
        const { data: parent } = await this.client
          .from(WikiService.PAGES)
          .select('path, level, space_id, is_archived')
          .eq('id', dto.parent_id)
          .maybeSingle();
        if (!parent) throw new BadRequestException('Parent page not found');
        const p = parent as Record<string, unknown>;
        if (p['space_id'] !== spaceId)
          throw new BadRequestException('Parent must be in the same space');
        if (p['is_archived'])
          throw new BadRequestException(
            'Cannot move page under an archived parent',
          );
        path = [...((p['path'] as string[]) ?? []), dto.parent_id];
        level = ((p['level'] as number) ?? 0) + 1;
        movedDescendants = await this.getDescendants(pageId, spaceId);
        if (movedDescendants.some((d) => d.id === dto.parent_id))
          throw new BadRequestException(
            'Cannot move a page into its own sub-page',
          );
        const deepest = Math.max(0, ...movedDescendants.map((d) => d.depth));
        if (level + deepest > 10)
          throw new BadRequestException(
            'Maximum wiki page nesting depth (10) exceeded',
          );
      } else {
        path = [];
        level = 0;
      }
    }

    // Sanitize content per its (target) format and recompute content_text.
    let sanitizedContent: string | undefined;
    let contentText: string | undefined;
    const targetFormat =
      dto.content_format ??
      ((existing['content_format'] as string) || 'editorjs');

    if (dto.content !== undefined) {
      const sanitized = this.sanitizeContentForWrite(dto.content, targetFormat);

      sanitizedContent = sanitized.content;
      contentText = sanitized.contentText;
    }

    // Optimistic-lock / conversion claim (guarded UPDATE; see
    // wiki-mine-write.service for the original pattern). Exactly one writer
    // whose expected values still match wins the claim.
    const isConversion = dto.convertedFrom !== undefined;
    let bumpVersionHint = false;

    if (dto.expectedUpdatedAt !== undefined || isConversion) {
      let claim = this.client
        .from(WikiService.PAGES)
        .update({ updated_at: new Date().toISOString() })
        .eq('id', pageId)
        .eq('space_id', spaceId);

      if (dto.expectedUpdatedAt !== undefined) {
        claim = claim.eq('updated_at', dto.expectedUpdatedAt);
      }
      if (isConversion) {
        claim = claim.eq('content_format', dto.convertedFrom);
      }

      const claimRes = await claim.select('id').maybeSingle();

      if (claimRes.error || !claimRes.data) {
        const currentRes = await this.client
          .from(WikiService.PAGES)
          .select('updated_at, content_format')
          .eq('id', pageId)
          .eq('space_id', spaceId)
          .maybeSingle();
        const current = currentRes.data as {
          updated_at?: string;
          content_format?: string;
        } | null;

        if (isConversion && current?.content_format !== dto.convertedFrom) {
          throw new ConflictException({
            message: 'Page content was already converted by another client',
            code: 'ALREADY_CONVERTED',
            data: { contentFormat: current?.content_format ?? null },
          });
        }

        throw new ConflictException({
          message: 'Conflict',
          code: 'STALE_WRITE',
          data: { currentUpdatedAt: current?.updated_at ?? null },
        });
      }

      if (isConversion) bumpVersionHint = true;
    }

    const updatePayload: Record<string, unknown> = {
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };
    if (dto.title !== undefined) updatePayload['title'] = dto.title;
    if (slug !== undefined) updatePayload['slug'] = slug;
    if (sanitizedContent !== undefined) {
      updatePayload['content'] = sanitizedContent;
      updatePayload['content_text'] = contentText ?? '';
    }
    if (dto.content_format !== undefined)
      updatePayload['content_format'] = dto.content_format;
    if (dto.custom_field_values !== undefined)
      updatePayload['custom_field_values'] = dto.custom_field_values;
    if (dto.parent_id !== undefined)
      updatePayload['parent_id'] = dto.parent_id ?? null;
    if (path !== undefined) updatePayload['path'] = path;
    if (level !== undefined) updatePayload['level'] = level;
    if (dto.is_published !== undefined) {
      updatePayload['is_published'] = dto.is_published;
      // Keep the Wiki 2.0 workflow status coherent with the legacy flag.
      updatePayload['workflow_status'] = dto.is_published
        ? 'published'
        : 'draft';
      if (dto.is_published)
        updatePayload['published_at'] = new Date().toISOString();
    }
    if (dto.is_archived !== undefined)
      updatePayload['is_archived'] = dto.is_archived;
    if (dto.tags !== undefined) updatePayload['tags'] = dto.tags;
    if (dto.metadata !== undefined) updatePayload['metadata'] = dto.metadata;

    if (bumpVersionHint) {
      // Force an uncoalesced version boundary at the conversion point.
      const baseMetadata =
        dto.metadata ?? (existing['metadata'] as Record<string, unknown>) ?? {};

      updatePayload['metadata'] = {
        ...baseMetadata,
        _version_hint: randomUUID(),
      };
    }

    const blogMetadata = (updatePayload['metadata'] ?? existing['metadata']) as
      | Record<string, unknown>
      | undefined;
    if (
      (dto.content !== undefined || dto.title !== undefined) &&
      blogMetadata?.blog_modified_at
    ) {
      const { blog_modified_at: _sourceModified, ...metadata } = blogMetadata;
      updatePayload['metadata'] = metadata;
    }

    const upd = await this.client
      .from(WikiService.PAGES)
      .update(updatePayload)
      .eq('id', pageId)
      .eq('space_id', spaceId)
      .select()
      .single();

    if (upd.error) throw new BadRequestException(upd.error.message);

    // The path trigger only fixes the moved row, so re-touch descendants top-down
    if (dto.parent_id !== undefined) {
      const toReparent =
        movedDescendants ?? (await this.getDescendants(pageId, spaceId));
      toReparent.sort((a, b) => a.depth - b.depth);
      // ponytail: one UPDATE per descendant, batch via an RPC if subtrees reach thousands
      for (const d of toReparent) {
        const { error } = await this.client
          .from(WikiService.PAGES)
          .update({ parent_id: d.parentId })
          .eq('id', d.id)
          .eq('space_id', spaceId);
        if (error) throw new BadRequestException(error.message);
      }
    }

    if (isConversion) {
      void this.logAudit(
        existing['organization_id'],
        userId,
        pageId,
        'convert_format',
        {
          from: dto.convertedFrom,
          to: targetFormat,
        },
      );
    }
    const changedFields = Object.keys(updatePayload).filter(
      (field) => !['updated_by', 'updated_at'].includes(field),
    );

    void this.logAudit(existing['organization_id'], userId, pageId, 'update', {
      fields: changedFields,
    });

    if (typeof existing['organization_id'] === 'string') {
      void this.outboxService?.write(
        existing['organization_id'],
        spaceId,
        'app.wiki.page_updated',
        {
          page: {
            id: pageId,
            title:
              (upd.data as Record<string, unknown>)?.title ?? existing['title'],
            space_id: spaceId,
            status:
              (upd.data as Record<string, unknown>)?.status ??
              existing['status'],
          },
          page_id: pageId,
          space_id: spaceId,
          changedFields,
        },
      );
    }

    if (
      sanitizedContent !== undefined &&
      typeof existing['organization_id'] === 'string'
    ) {
      const pageTitle =
        ((upd.data as Record<string, unknown>)?.['title'] as string) ??
        ((existing['title'] as string) || '');

      void this.notifyMentionedUsers(
        sanitizedContent,
        'wiki_page',
        pageId,
        pageId,
        pageTitle,
        existing['organization_id'],
        userId,
        spaceId,
        (existing['content'] as string | null | undefined) ?? null,
        targetFormat,
        (existing['content_format'] as string | null | undefined) ?? null,
      );
    }
    if (typeof existing['organization_id'] === 'string') {
      void this.notifyWikiWatchers(
        existing,
        pageId,
        spaceId,
        userId,
        watcherChangeKind,
        upd.data as Record<string, unknown>,
      );
    }

    return upd.data as unknown;
  }

  /**
   * Partially updates a page's custom-field values.
   *
   * Merge semantics: only the supplied keys are touched, and an explicit `null`
   * deletes a key. This is deliberately NOT `updatePage`:
   *
   * 1. Two surfaces edit these values (the right-rail panel and the in-body
   *    properties block). Full-map writes would let a surface holding a stale
   *    baseline clobber the other's fields; sending only what changed cannot.
   * 2. It never touches page content, so it is intentionally exempt from the
   *    collab-active gate in `updatePage` — a live co-editing session must not
   *    block someone from setting a property.
   *
   * It does not bump the versioning trigger (that keys off title/content).
   */
  async patchCustomFieldValues(
    pageId: string,
    spaceId: string,
    values: Record<string, unknown>,
    userId: string,
  ): Promise<unknown> {
    const existing = (await this.getPageById(pageId, spaceId)) as Record<
      string,
      unknown
    >;
    const organizationId = (existing['organization_id'] as string) ?? '';
    const stored =
      (existing['custom_field_values'] as Record<string, unknown> | null) ?? {};

    await this.wikiFieldKeys.assertKeysAllowed(
      organizationId,
      spaceId,
      Object.keys(values),
      Object.keys(stored),
    );

    const merged: Record<string, unknown> = { ...stored };

    for (const [key, value] of Object.entries(values)) {
      // Explicit null is the delete sentinel — the client cannot express
      // "remove this key" by omission, since omission means "leave untouched".
      if (value === null) delete merged[key];
      else merged[key] = value;
    }

    const upd = await this.client
      .from(WikiService.PAGES)
      .update({
        custom_field_values: merged,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', pageId)
      .eq('space_id', spaceId)
      .select()
      .single();

    if (upd.error) throw new BadRequestException(upd.error.message);

    void this.logAudit(organizationId, userId, pageId, 'update', {
      fields: ['custom_field_values'],
      keys: Object.keys(values),
    });

    if (organizationId) {
      void this.outboxService?.write(
        organizationId,
        spaceId,
        'app.wiki.page_updated',
        {
          page: {
            id: pageId,
            title: (upd.data as Record<string, unknown>)?.title,
            space_id: spaceId,
          },
          page_id: pageId,
          space_id: spaceId,
          changedFields: ['custom_field_values'],
        },
      );
      void this.notifyWikiWatchers(
        existing,
        pageId,
        spaceId,
        userId,
        'custom_fields_updated',
        upd.data as Record<string, unknown>,
      );
    }

    return upd.data as unknown;
  }

  async deletePage(
    pageId: string,
    spaceId: string,
    userId?: string,
    // Needed for whiteboard link rows (permission + board delete); they fail closed without it.
    user?: RequestUser,
  ): Promise<void> {
    const existing = (await this.getPageById(pageId, spaceId)) as Record<
      string,
      unknown
    >;

    // Check no children
    const { count } = await this.client
      .from(WikiService.PAGES)
      .select('id', { count: 'exact', head: true })
      .eq('parent_id', pageId);
    if (count && count > 0) {
      throw new BadRequestException(
        'Cannot delete a page that has child pages',
      );
    }

    const whiteboardId = existing['whiteboard_id'] as string | null;

    if (whiteboardId) {
      // A link row goes with its board: delete the board, the FK cascade removes the row.
      if (!user) throw new ForbiddenException('Insufficient space permissions');

      await this.assertWhiteboardPermission(
        user.userId,
        user.organizationId,
        spaceId,
        'delete_whiteboards',
      );
      await this.boards.removeFromWiki(spaceId, user, whiteboardId);
    } else {
      const { error } = await this.client
        .from(WikiService.PAGES)
        .delete()
        .eq('id', pageId)
        .eq('space_id', spaceId);
      if (error) throw new BadRequestException(error.message);
    }

    // task_relationships has no FK on target_id, so typed ticket links to this
    // page would dangle. Best effort: the page is already gone, and the task
    // read path tolerates a missing page (target_wiki_page: null).
    const rels = await this.client
      .from('task_relationships')
      .delete()
      .eq('organization_id', existing['organization_id'] as string)
      .eq('target_type', 'wiki_page')
      .eq('target_id', pageId);
    if (rels.error) {
      this.logger.warn(
        `deletePage: could not remove task links to page ${pageId}: ${rels.error.message}`,
      );
    }

    if (userId) {
      void this.logAudit(
        existing['organization_id'],
        userId,
        pageId,
        'delete',
        {
          title: existing['title'],
          space_id: spaceId,
        },
      );
    }
  }

  /**
   * Every page below `pageId`, with its depth under it. Walks `parent_id` — the column `deletePage`'s child check reads.
   */
  async getDescendants(
    pageId: string,
    spaceId: string,
  ): Promise<
    {
      id: string;
      title: string;
      parentId: string;
      depth: number;
      isFolder: boolean;
      isWhiteboard: boolean;
    }[]
  > {
    const found: {
      id: string;
      title: string;
      parentId: string;
      depth: number;
      isFolder: boolean;
      isWhiteboard: boolean;
    }[] = [];
    const seen = new Set<string>([pageId]);
    let frontier = [pageId];

    for (let depth = 1; frontier.length > 0; depth++) {
      const next: string[] = [];

      // Chunked so the `in.(…)` list stays well inside the URL limit
      for (let i = 0; i < frontier.length; i += 100) {
        const chunk = frontier.slice(i, i + 100);
        const { rows, truncated } = await fetchAllRows<{
          id: string;
          title: string;
          parent_id: string;
          metadata: Record<string, unknown> | null;
          whiteboard_id: string | null;
        }>((from, to) =>
          this.client
            .from(WikiService.PAGES)
            .select('id, title, parent_id, metadata, whiteboard_id')
            .eq('space_id', spaceId)
            .in('parent_id', chunk)
            .order('id', { ascending: true })
            .range(from, to),
        );

        if (truncated) {
          throw new BadRequestException(
            'This folder is too large to delete in one step',
          );
        }

        for (const row of rows) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          found.push({
            id: row.id,
            title: row.title,
            parentId: row.parent_id,
            depth,
            isFolder: row.metadata?.['is_folder'] === true,
            isWhiteboard: row.whiteboard_id != null,
          });
          next.push(row.id);
        }
      }

      frontier = next;
    }

    return found;
  }

  /**
   * Deletes a page and everything below it, deepest first, through `deletePage` so each page keeps its
   * task-link cleanup and audit entry. Permissions are the caller's job (checked before anything is deleted).
   */
  async deletePageTree(
    pageId: string,
    spaceId: string,
    user: RequestUser,
    descendants: { id: string; depth: number; isWhiteboard?: boolean }[],
  ): Promise<{ deleted: number }> {
    const ordered = [...descendants].sort((a, b) => b.depth - a.depth);
    const total = ordered.length + 1;
    let deleted = 0;

    // Up front, so a missing Whiteboards permission deletes nothing rather than half a folder.
    // (A link row itself has no children, so the root is covered by deletePage's own check.)
    if (descendants.some((d) => d.isWhiteboard)) {
      await this.assertWhiteboardPermission(
        user.userId,
        user.organizationId,
        spaceId,
        'delete_whiteboards',
      );
    }

    try {
      for (const page of ordered) {
        await this.deletePage(page.id, spaceId, user.userId, user);
        deleted++;
      }

      await this.deletePage(pageId, spaceId, user.userId, user);
      deleted++;
    } catch (error) {
      // Only a concurrent edit (e.g. a page added inside meanwhile) can stop it part-way
      if (deleted === 0) throw error;

      const reason = error instanceof Error ? error.message : String(error);

      this.logger.warn(
        `deletePageTree: stopped after ${deleted} of ${total} pages under ${pageId}: ${reason}`,
      );
      throw new BadRequestException(
        `Deleted ${deleted} of ${total} items, then stopped: ${reason}`,
      );
    }

    return { deleted };
  }

  async publishPage(
    pageId: string,
    spaceId: string,
    publish: boolean,
    userId: string,
  ): Promise<unknown> {
    const existing = (await this.getPageById(pageId, spaceId)) as Record<
      string,
      unknown
    >;
    if (publish && existing['is_archived']) {
      throw new BadRequestException('Cannot publish an archived page');
    }
    const update: Record<string, unknown> = {
      is_published: publish,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };
    if (publish) update['published_at'] = new Date().toISOString();
    const pub = await this.client
      .from(WikiService.PAGES)
      .update(update)
      .eq('id', pageId)
      .eq('space_id', spaceId)
      .select()
      .single();
    if (pub.error) throw new BadRequestException(pub.error.message);
    void this.logAudit(existing['organization_id'], userId, pageId, 'update', {
      is_published: publish,
    });

    if (publish && typeof existing['organization_id'] === 'string') {
      void this.outboxService?.write(
        existing['organization_id'],
        spaceId,
        'app.wiki.page_published',
        {
          page: {
            id: pageId,
            title: existing['title'],
            space_id: spaceId,
            status: 'published',
          },
          page_id: pageId,
          space_id: spaceId,
          published_by: userId,
        },
      );
    }
    if (typeof existing['organization_id'] === 'string') {
      void this.notifyWikiWatchers(
        existing,
        pageId,
        spaceId,
        userId,
        publish ? 'page_published' : 'page_unpublished',
        pub.data as Record<string, unknown>,
      );
    }

    return pub.data as unknown;
  }

  async searchPages(
    spaceId: string,
    query: string,
    limit = 50,
  ): Promise<unknown[]> {
    // Strip characters with syntactic meaning in PostgREST filter strings
    const safe = query.replace(/[%_,.()"'\\:]/g, '').trim();
    if (!safe || safe.length < 2) return [];

    const { data, error } = await this.client
      .from(WikiService.PAGES)
      .select(
        'id, title, slug, parent_id, level, is_published, is_archived, created_at, whiteboard_id',
      )
      .eq('space_id', spaceId)
      .eq('is_archived', false)
      .ilike('title', `%${safe}%`)
      .limit(limit);

    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as unknown[];
  }

  async reorderPages(
    updates: { id: string; sort_order: number }[],
    spaceId: string,
  ): Promise<{ updated: number }> {
    const results = await Promise.all(
      updates.map(({ id, sort_order }) =>
        this.client
          .from(WikiService.PAGES)
          .update({ sort_order })
          .eq('id', id)
          .eq('space_id', spaceId),
      ),
    );
    const errors = results.filter((r) => r.error);
    if (errors.length > 0) {
      throw new BadRequestException('Some pages failed to reorder');
    }
    return { updated: updates.length };
  }

  // ------------------------------------------------------------------ //
  // Versions                                                             //
  // ------------------------------------------------------------------ //

  async getVersions(pageId: string, spaceId: string): Promise<unknown[]> {
    await this.getPageById(pageId, spaceId); // verify page belongs to this space
    const { data, error } = await this.client
      .from(WikiService.VERSIONS)
      .select(
        '*, changed_by_user:users!changed_by(id,first_name,last_name,email)',
      )
      .eq('wiki_page_id', pageId)
      .order('version', { ascending: false });
    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as unknown[];
  }

  /**
   * Restores a page to a prior version: re-applies the version's title,
   * content AND content_format (re-sanitized by format; content_text is
   * recomputed by updatePage) and bumps `metadata._version_hint` so the
   * versioning trigger records the restore as a distinct, uncoalesced version.
   */
  async restoreVersion(
    pageId: string,
    spaceId: string,
    version: number,
    userId: string,
  ): Promise<unknown> {
    const existing = (await this.getPageById(pageId, spaceId)) as Record<
      string,
      unknown
    >;

    const { data: ver, error } = await this.client
      .from(WikiService.VERSIONS)
      .select('title, content, content_format')
      .eq('wiki_page_id', pageId)
      .eq('version', version)
      .maybeSingle();
    if (error || !ver) throw new NotFoundException('Version not found');
    const v = ver as Record<string, unknown>;

    const restored = await this.updatePage(
      pageId,
      spaceId,
      {
        title: v['title'] as string,
        content: (v['content'] as string) ?? '',
        content_format: (v['content_format'] as string) ?? undefined,
        metadata: {
          ...((existing['metadata'] as Record<string, unknown>) ?? {}),
          _version_hint: randomUUID(),
        },
      },
      userId,
      'page_restored',
    );

    void this.logAudit(
      existing['organization_id'],
      userId,
      pageId,
      'restore_version',
      { version },
    );

    return restored;
  }

  // ------------------------------------------------------------------ //
  // Attachments                                                          //
  // ------------------------------------------------------------------ //

  async getAttachments(pageId: string): Promise<unknown[]> {
    const { data, error } = await this.client
      .from(WikiService.ATTACHMENTS)
      .select(
        '*, uploaded_by_user:users!uploaded_by(id,first_name,last_name,email)',
      )
      .eq('wiki_page_id', pageId)
      // Superseded versions belong in history, not the panel. Every pre-XE-T542 row defaults
      // to is_current = true, so nothing that was visible before disappears.
      .eq('is_current', true)
      .order('created_at', { ascending: false });
    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as unknown[];
  }

  /**
   * Every version of one filename on a page, newest first (XE-T542).
   *
   * Wiki attachments keep their chain in this same table rather than `file_versions`: the
   * Confluence `page_attachments` stage and the wiki macros both read `wiki_page_attachments`
   * directly, so re-pointing the store would have been a far larger, riskier change.
   */
  async getAttachmentVersions(
    pageId: string,
    spaceId: string,
    fileName: string,
  ): Promise<unknown[]> {
    await this.getPageById(pageId, spaceId); // verify page exists and is in this space

    const { data, error } = await this.client
      .from(WikiService.ATTACHMENTS)
      .select(
        '*, uploaded_by_user:users!uploaded_by(id,first_name,last_name,email)',
      )
      .eq('wiki_page_id', pageId)
      .eq('file_name', fileName)
      .order('version_number', { ascending: false });
    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as unknown[];
  }

  async getSpaceAttachments(spaceId: string, limit = 100): Promise<unknown[]> {
    const capped = Math.min(Math.max(Math.trunc(limit) || 100, 1), 200);
    const { data: pages, error: pagesError } = await this.client
      .from(WikiService.PAGES)
      .select('id,title,slug')
      .eq('space_id', spaceId)
      .eq('is_archived', false)
      .limit(POSTGREST_MAX_ROWS);
    if (pagesError) throw new BadRequestException(pagesError.message);
    if (!pages?.length) return [];

    const pageById = new Map(pages.map((page) => [page.id, page]));
    const { data, error } = await this.client
      .from(WikiService.ATTACHMENTS)
      .select(
        '*, uploaded_by_user:users!uploaded_by(id,first_name,last_name,email)',
      )
      .in('wiki_page_id', [...pageById.keys()])
      // Current versions only — superseded rows live in the per-file history (XE-T542).
      .eq('is_current', true)
      .order('created_at', { ascending: false })
      .limit(capped);
    if (error) throw new BadRequestException(error.message);
    return (data ?? []).map((attachment) => ({
      ...attachment,
      wiki_page: pageById.get(attachment.wiki_page_id) ?? null,
    })) as unknown[];
  }

  /** Extract native TipTap task-list items for Confluence's live task report macro. */
  async getTaskReport(
    spaceId: string,
    limit = 100,
  ): Promise<WikiTaskReportItem[]> {
    const capped = Math.min(Math.max(Math.trunc(limit) || 100, 1), 200);
    const { data, error } = await this.client
      .from(WikiService.PAGES)
      .select('id,title,slug,content,content_format')
      .eq('space_id', spaceId)
      .eq('is_archived', false)
      .eq('content_format', 'tiptap')
      .order('updated_at', { ascending: false })
      .limit(POSTGREST_MAX_ROWS);
    if (error) throw new BadRequestException(error.message);

    const tasks: WikiTaskReportItem[] = [];
    for (const row of data ?? []) {
      if (tasks.length >= capped) break;
      try {
        const document = JSON.parse(String(row.content ?? '')) as TipTapValue;
        collectTaskItems(
          document,
          { id: row.id, title: row.title, slug: row.slug },
          tasks,
        );
      } catch {
        // A malformed legacy page is excluded from this derived view; it remains readable as-is.
      }
    }
    return tasks.slice(0, capped);
  }

  async createAttachment(
    pageId: string,
    spaceId: string,
    file: Express.Multer.File,
    userId: string,
    sourceCreatedAt?: string,
    preview?: WikiAttachmentPreview,
  ): Promise<unknown> {
    const page = (await this.getPageById(pageId, spaceId)) as Record<
      string,
      unknown
    >;

    if (sourceCreatedAt) this.assertCanonicalAttachmentDate(sourceCreatedAt);

    if (file.size > MAX_ATTACHMENT_SIZE) {
      throw new BadRequestException(
        `File exceeds maximum size of ${formatMaxUpload(MAX_ATTACHMENT_SIZE)}`,
      );
    }

    const stamp = Date.now();
    const path = `wiki/${pageId}/${stamp}-${storageSafeFileName(file.originalname)}`;
    const previewPath = preview
      ? `wiki/${pageId}/${stamp}-preview-${storageSafeFileName(preview.filename)}`
      : null;
    const uploadedPaths: string[] = [];

    // Source-reported content types are unreliable (Confluence Server served
    // every .docx as the .dotx template type); the extension is ground truth.
    const mimetype = reconcileMimeWithExtension(
      file.originalname,
      file.mimetype,
    );

    try {
      const { error: uploadError } = await this.client.storage
        .from(WIKI_IMAGES_BUCKET)
        .upload(path, file.buffer, {
          contentType: storageContentType(mimetype),
          upsert: false,
        });
      if (uploadError) {
        throw new BadRequestException(
          `Storage upload failed: ${uploadError.message}`,
        );
      }
      uploadedPaths.push(path);

      // Inline first: this URL is what page previews and attachments lists render, so it
      // must not carry a download disposition. Explicit downloads add it at click time.
      const urlRes = this.client.storage
        .from(WIKI_IMAGES_BUCKET)
        .getPublicUrl(path);
      if (!urlRes.data?.publicUrl) {
        throw new BadRequestException('Failed to generate public URL');
      }

      let previewUrl: string | null = null;
      if (preview && previewPath) {
        const { error: previewUploadError } = await this.client.storage
          .from(WIKI_IMAGES_BUCKET)
          .upload(previewPath, preview.buffer, {
            contentType: storageContentType(preview.mimeType),
            upsert: false,
          });
        if (previewUploadError) {
          throw new BadRequestException(
            `Preview storage upload failed: ${previewUploadError.message}`,
          );
        }
        uploadedPaths.push(previewPath);
        const previewUrlRes = this.client.storage
          .from(WIKI_IMAGES_BUCKET)
          .getPublicUrl(previewPath);
        if (!previewUrlRes.data?.publicUrl) {
          throw new BadRequestException(
            'Failed to generate preview public URL',
          );
        }
        previewUrl = browserSafeStorageUrl(previewUrlRes.data.publicUrl);
      }

      // Re-uploading the same filename onto a page is a NEW VERSION, not a second file.
      // Before XE-T542 the Date.now() storage stamp guaranteed a distinct key, so this
      // silently produced a duplicate row and a duplicate object with no way back to the
      // previous copy. The bytes are never overwritten — each version keeps its own object.
      const prior = await this.client
        .from(WikiService.ATTACHMENTS)
        .select('id, version_number')
        .eq('wiki_page_id', pageId)
        .eq('file_name', file.originalname)
        .order('version_number', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (prior.error) throw new BadRequestException(prior.error.message);

      const priorRow = prior.data as {
        id: string;
        version_number: number | null;
      } | null;

      const versionNumber = (priorRow?.version_number ?? 0) + 1;

      const at = await this.client
        .from(WikiService.ATTACHMENTS)
        .insert({
          wiki_page_id: pageId,
          file_name: file.originalname,
          file_path: browserSafeStorageUrl(urlRes.data.publicUrl),
          file_size: file.size,
          file_type: mimetype,
          uploaded_by: userId,
          version_number: versionNumber,
          is_current: true,
          ...(previewUrl ? { preview_file_path: previewUrl } : {}),
          ...(sourceCreatedAt ? { created_at: sourceCreatedAt } : {}),
        })
        .select()
        .single();
      if (at.error) throw new BadRequestException(at.error.message);

      // Demote the previous versions only after the new row exists. If this write fails the
      // page briefly lists two rows for the filename — exactly the pre-XE-T542 behaviour, and
      // never a lost file.
      if (versionNumber > 1) {
        const demoted = await this.client
          .from(WikiService.ATTACHMENTS)
          .update({ is_current: false })
          .eq('wiki_page_id', pageId)
          .eq('file_name', file.originalname)
          .neq('id', (at.data as { id: string }).id);

        if (demoted.error) {
          this.logger.warn(
            `wiki attachment version demote failed for "${file.originalname}" on page ${pageId}: ${demoted.error.message}`,
          );
        }
      }
      void this.notifyWikiWatchers(
        page,
        pageId,
        spaceId,
        userId,
        'attachment_added',
      );
      return at.data as unknown;
    } catch (error) {
      if (uploadedPaths.length > 0) {
        await this.client.storage
          .from(WIKI_IMAGES_BUCKET)
          .remove(uploadedPaths);
      }
      throw error;
    }
  }

  /** Migration-only read for repair runs. Normal attachment APIs never expose this mutation. */
  async getAttachmentCreatedAt(
    pageId: string,
    spaceId: string,
    attachmentId: string,
  ): Promise<string> {
    await this.getPageById(pageId, spaceId);

    const { data, error } = await this.client
      .from(WikiService.ATTACHMENTS)
      .select('created_at')
      .eq('id', attachmentId)
      .eq('wiki_page_id', pageId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data?.created_at) throw new NotFoundException('Attachment not found');
    return data.created_at as string;
  }

  /** Migration-only repair path. It stays page-scoped so another page's attachment cannot change. */
  async updateAttachmentCreatedAt(
    pageId: string,
    spaceId: string,
    attachmentId: string,
    sourceCreatedAt: string,
  ): Promise<void> {
    this.assertCanonicalAttachmentDate(sourceCreatedAt);
    await this.getPageById(pageId, spaceId);

    const { data, error } = await this.client
      .from(WikiService.ATTACHMENTS)
      .update({ created_at: sourceCreatedAt })
      .eq('id', attachmentId)
      .eq('wiki_page_id', pageId)
      .select('id')
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Attachment not found');
  }

  /**
   * Migration-only repair: reclassify a stored attachment whose file_type does
   * not match its filename. A real-world Confluence Server reported every
   * .docx as the .dotx template type, and those rows predate the ingestion
   * guard. Wiki attachments are served from a PUBLIC bucket, so the storage
   * object's content type — not the DB row — decides how the browser treats
   * the download: both are corrected here. The bytes are downloaded and
   * re-put unchanged; only the metadata moves. Returns true when a repair was
   * applied, false when the stored type already matched the extension.
   */
  async repairAttachmentContentType(
    pageId: string,
    spaceId: string,
    attachmentId: string,
    filename: string,
  ): Promise<boolean> {
    await this.getPageById(pageId, spaceId);

    const { data, error } = await this.client
      .from(WikiService.ATTACHMENTS)
      .select('file_type, file_path')
      .eq('id', attachmentId)
      .eq('wiki_page_id', pageId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Attachment not found');

    const currentType = (data.file_type as string) ?? '';
    const expectedType = reconcileMimeWithExtension(filename, currentType);
    if (expectedType === currentType) return false;

    // file_path stores the public URL; recover the storage path from it.
    const marker = `/object/public/${WIKI_IMAGES_BUCKET}/`;
    const markerIndex = (data.file_path as string).indexOf(marker);
    if (markerIndex < 0) {
      throw new BadRequestException(
        'Stored attachment URL is not a wiki bucket URL',
      );
    }
    const storagePath = (data.file_path as string).slice(
      markerIndex + marker.length,
    );

    const { data: blob, error: downloadError } = await this.client.storage
      .from(WIKI_IMAGES_BUCKET)
      .download(storagePath);
    if (downloadError || !blob) {
      throw new BadRequestException(
        `Storage download failed: ${downloadError?.message ?? 'empty body'}`,
      );
    }

    const { error: updateError } = await this.client.storage
      .from(WIKI_IMAGES_BUCKET)
      .update(storagePath, blob, { contentType: expectedType, upsert: false });
    if (updateError) {
      throw new BadRequestException(
        `Storage content type update failed: ${updateError.message}`,
      );
    }

    const { error: dbError } = await this.client
      .from(WikiService.ATTACHMENTS)
      .update({ file_type: expectedType })
      .eq('id', attachmentId)
      .eq('wiki_page_id', pageId);
    if (dbError) throw new BadRequestException(dbError.message);

    return true;
  }

  /**
   * Guard for a source-reported page timestamp (XE-T552).
   *
   * Unlike `assertCanonicalAttachmentDate` this keeps the full instant rather than truncating
   * to a UTC calendar day: the wiki meta line renders with `toLocaleString()`, so a truncated
   * value would display every migrated page as modified at 00:00.
   */
  private assertIsoInstant(value: string): void {
    const parsed = new Date(value);

    if (!Number.isFinite(parsed.getTime())) {
      throw new BadRequestException(
        'Source updated date must be a valid ISO-8601 instant',
      );
    }
  }

  private assertCanonicalAttachmentDate(value: string): void {
    const parsed = new Date(value);
    if (
      !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(value) ||
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString() !== value
    ) {
      throw new BadRequestException(
        'Attachment date must be a canonical UTC calendar date',
      );
    }
  }

  async deleteAttachment(
    attachmentId: string,
    pageId: string,
    spaceId?: string,
    userId?: string,
  ): Promise<void> {
    const page =
      spaceId && userId
        ? ((await this.getPageById(pageId, spaceId)) as Record<string, unknown>)
        : null;
    const da = await this.client
      .from(WikiService.ATTACHMENTS)
      .select('id, file_path, preview_file_path')
      .eq('id', attachmentId)
      .eq('wiki_page_id', pageId)
      .maybeSingle();
    if (!da.data) throw new NotFoundException('Attachment not found');

    // Delete the file from storage before removing the DB row
    const row = da.data as Record<string, unknown>;
    const marker = `/object/public/${WIKI_IMAGES_BUCKET}/`;
    const storagePaths = [row['file_path'], row['preview_file_path']].flatMap(
      (value) => {
        if (typeof value !== 'string') return [];
        const idx = value.indexOf(marker);
        return idx === -1 ? [] : [value.slice(idx + marker.length)];
      },
    );
    if (storagePaths.length > 0) {
      await this.client.storage.from(WIKI_IMAGES_BUCKET).remove(storagePaths);
    }

    const { error } = await this.client
      .from(WikiService.ATTACHMENTS)
      .delete()
      .eq('id', attachmentId)
      .eq('wiki_page_id', pageId);
    if (error) throw new BadRequestException(error.message);
    if (page && spaceId && userId) {
      void this.notifyWikiWatchers(
        page,
        pageId,
        spaceId,
        userId,
        'attachment_removed',
      );
    }
  }

  private notifyWikiWatchers(
    page: Record<string, unknown>,
    pageId: string,
    spaceId: string,
    actorUserId: string,
    changeKind: string,
    updated?: Record<string, unknown>,
  ): Promise<void> | undefined {
    const organizationId = page['organization_id'];
    if (typeof organizationId !== 'string') return undefined;
    return this.watchersService?.notifyWikiWatchers({
      organizationId,
      spaceId,
      pageId,
      actorUserId,
      title:
        (updated?.['title'] as string | undefined) ??
        (page['title'] as string | undefined) ??
        '',
      changeKind,
    });
  }

  // ------------------------------------------------------------------ //
  // Images & Files (inline editor uploads)                              //
  // ------------------------------------------------------------------ //

  async uploadImage(
    spaceId: string,
    file: Express.Multer.File,
  ): Promise<Record<string, unknown>> {
    if (file.size > MAX_IMAGE_SIZE) {
      throw new BadRequestException(
        `Image exceeds maximum size of ${formatMaxUpload(MAX_IMAGE_SIZE)}`,
      );
    }
    assertImageMime(file.mimetype, IMAGE_MIME_OPTS);
    // No `download` disposition on the public URL here — images must render INLINE in pages.
    const path = `wiki-images/${spaceId}/${Date.now()}-${storageSafeFileName(file.originalname)}`;

    const { error } = await this.client.storage
      .from(WIKI_IMAGES_BUCKET)
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
    if (error)
      throw new BadRequestException(`Storage upload failed: ${error.message}`);

    const imgUrl = this.client.storage
      .from(WIKI_IMAGES_BUCKET)
      .getPublicUrl(path);
    if (!imgUrl.data?.publicUrl) {
      throw new BadRequestException('Failed to generate public URL');
    }

    return {
      url: browserSafeStorageUrl(imgUrl.data.publicUrl),
      fileName: file.originalname,
      fileSize: file.size,
      fileType: file.mimetype,
    };
  }

  async uploadFile(
    spaceId: string,
    file: Express.Multer.File,
  ): Promise<Record<string, unknown>> {
    if (file.size > MAX_ATTACHMENT_SIZE) {
      throw new BadRequestException(
        `File exceeds maximum size of ${formatMaxUpload(MAX_ATTACHMENT_SIZE)}`,
      );
    }
    const path = `wiki-files/${spaceId}/${Date.now()}-${storageSafeFileName(file.originalname)}`;

    const { error } = await this.client.storage
      .from(WIKI_IMAGES_BUCKET)
      .upload(path, file.buffer, {
        contentType: storageContentType(file.mimetype),
        upsert: false,
      });
    if (error)
      throw new BadRequestException(`Storage upload failed: ${error.message}`);

    const fileUrl = this.client.storage
      .from(WIKI_IMAGES_BUCKET)
      .getPublicUrl(path);
    if (!fileUrl.data?.publicUrl) {
      throw new BadRequestException('Failed to generate public URL');
    }

    return {
      url: browserSafeStorageUrl(fileUrl.data.publicUrl),
      fileName: file.originalname,
      fileSize: file.size,
      fileType: file.mimetype,
    };
  }

  // ------------------------------------------------------------------ //
  // Links                                                                //
  // ------------------------------------------------------------------ //

  async getLinks(
    pageId: string,
    userId: string,
    organizationId: string,
  ): Promise<unknown[]> {
    const { data, error } = await this.client
      .from(WikiService.LINKS)
      .select('*')
      .eq('source_page_id', pageId)
      .order('created_at', { ascending: false });
    if (error) throw new BadRequestException(error.message);
    // A link's metadata carries its target's title, so a target that exists
    // but the viewer cannot see is dropped (XE-T532 #4). A missing target keeps
    // its raw row, as before, so the link can still be removed. Asset and list
    // targets pass through.
    const rows = (data ?? []) as { target_type: string; target_id: string }[];
    const { visible, found } = await this.visibleLinkTargetIds(
      rows,
      userId,
      organizationId,
    );
    return rows.filter(
      (row) =>
        !['task', 'process', 'page'].includes(row.target_type) ||
        visible.has(row.target_id) ||
        !found.has(row.target_id),
    );
  }

  /**
   * Ids of the task, process and page link targets that exist in the org
   * (`found`) and that the viewer may see (`visible`): org-scoped reads, then
   * the task-relationship space rule for tasks and processes, and the page ACL
   * for pages. A failed lookup is logged and fails closed for that target type:
   * its ids count as found but not visible, so getLinks drops those rows (the
   * rest still return) and createLink answers 404.
   */
  private async visibleLinkTargetIds(
    links: { target_type: string; target_id: string }[],
    userId: string,
    organizationId: string,
  ): Promise<{ visible: Set<string>; found: Set<string> }> {
    const visible = new Set<string>();
    const found = new Set<string>();
    const idsOf = (type: string) => [
      ...new Set(
        links.filter((l) => l.target_type === type).map((l) => l.target_id),
      ),
    ];
    const canView = createLinkViewCheck(
      this.permissionsService,
      organizationId,
      userId,
    );

    for (const [type, table, permission] of [
      ['task', 'tasks', 'view_tasks'],
      ['process', 'business_processes', 'view_processes'],
    ] as const) {
      const ids = idsOf(type);
      if (ids.length === 0) continue;
      const { data, error } = await this.client
        .from(table)
        .select('id, space_id')
        .in('id', ids)
        .eq('organization_id', organizationId);
      if (error) {
        this.logger.warn(
          `Link target lookup failed (${type}): ${error.message}`,
        );
        for (const id of ids) found.add(id);
        continue;
      }
      for (const row of (data ?? []) as {
        id: string;
        space_id: string | null;
      }[]) {
        found.add(row.id);
        if (await canView(row.space_id, permission)) visible.add(row.id);
      }
    }

    const pageIds = idsOf('page');
    if (pageIds.length > 0) {
      const { data, error } = await this.client
        .from(WikiService.PAGES)
        .select('id, space_id, created_by, path')
        .in('id', pageIds)
        .eq('organization_id', organizationId);
      if (error) {
        this.logger.warn(`Link target lookup failed (page): ${error.message}`);
        for (const id of pageIds) found.add(id);
      }
      const bySpace = new Map<string, { id: string; space_id: string }[]>();
      for (const page of (data ?? []) as { id: string; space_id: string }[]) {
        found.add(page.id);
        bySpace.set(page.space_id, [
          ...(bySpace.get(page.space_id) ?? []),
          page,
        ]);
      }
      for (const [spaceId, pages] of bySpace) {
        const ok = (await this.wikiPermissions.filterAccessiblePages(
          pages,
          userId,
          spaceId,
        )) as { id: string }[];
        for (const page of ok) visible.add(page.id);
      }
    }

    return { visible, found };
  }

  async createLink(
    pageId: string,
    dto: CreateWikiLinkDto,
    userId: string,
    organizationId: string,
  ): Promise<unknown> {
    // A task/process target must be in the org and viewable (XE-T532 #4). A
    // hidden one answers like a missing one, so linking cannot probe for it.
    if (
      (dto.target_type === 'task' || dto.target_type === 'process') &&
      !(
        await this.visibleLinkTargetIds([dto], userId, organizationId)
      ).visible.has(dto.target_id)
    ) {
      throw new NotFoundException(`Target ${dto.target_type} not found`);
    }

    const lnk = await this.client
      .from(WikiService.LINKS)
      .insert({
        source_page_id: pageId,
        target_type: dto.target_type,
        target_id: dto.target_id,
        target_metadata: dto.target_metadata ?? {},
        created_by: userId,
      })
      .select()
      .single();
    if (lnk.error) throw new BadRequestException(lnk.error.message);

    // Log to task_history when a wiki page is linked to a task
    if (dto.target_type === 'task') {
      void (async () => {
        const [pageRes, taskRes] = await Promise.all([
          this.client
            .from(WikiService.PAGES)
            .select('title')
            .eq('id', pageId)
            .maybeSingle(),
          this.client
            .from('tasks')
            .select('organization_id')
            .eq('id', dto.target_id)
            .maybeSingle(),
        ]);
        const pageTitle =
          (pageRes.data as { title?: string } | null)?.title ?? null;
        const orgId = (taskRes.data as { organization_id?: string } | null)
          ?.organization_id;
        if (orgId) {
          await this.client.from('task_history').insert({
            task_id: dto.target_id,
            organization_id: orgId,
            action: 'relationship_added',
            field_name: null,
            old_value: null,
            new_value: {
              target_id: pageId,
              target_type: 'wiki_page',
              target_title: pageTitle,
            },
            changed_by: userId,
          });
        }
      })();
    }

    // Emit automation event for wiki relation added
    void (async () => {
      const pageRes = await this.client
        .from(WikiService.PAGES)
        .select('title, space_id, organization_id')
        .eq('id', pageId)
        .maybeSingle();
      const page = pageRes.data as {
        title?: string;
        space_id?: string;
        organization_id?: string;
      } | null;
      if (page?.organization_id) {
        void this.outboxService?.write(
          page.organization_id,
          page.space_id ?? null,
          'app.wiki.relation_added',
          {
            pageId,
            page: {
              id: pageId,
              title: page.title ?? '',
              space_id: page.space_id ?? '',
            },
            relatedPageId: dto.target_id,
            relationType: dto.target_type,
            space_id: page.space_id ?? null,
          },
        );
      }
    })();

    return lnk.data as unknown;
  }

  async deleteLink(
    linkId: string,
    pageId: string,
    userId?: string,
  ): Promise<void> {
    const check = await this.client
      .from(WikiService.LINKS)
      .select('id, target_type, target_id')
      .eq('id', linkId)
      .eq('source_page_id', pageId)
      .maybeSingle();
    if (!check.data) throw new NotFoundException('Link not found');

    const { error } = await this.client
      .from(WikiService.LINKS)
      .delete()
      .eq('id', linkId)
      .eq('source_page_id', pageId);
    if (error) throw new BadRequestException(error.message);

    // Log to task_history when a wiki page is unlinked from a task
    const link = check.data as { target_type?: string; target_id?: string };
    if (userId && link.target_type === 'task' && link.target_id) {
      void (async () => {
        const [pageRes, taskRes] = await Promise.all([
          this.client
            .from(WikiService.PAGES)
            .select('title')
            .eq('id', pageId)
            .maybeSingle(),
          this.client
            .from('tasks')
            .select('organization_id')
            .eq('id', link.target_id!)
            .maybeSingle(),
        ]);
        const pageTitle =
          (pageRes.data as { title?: string } | null)?.title ?? null;
        const orgId = (taskRes.data as { organization_id?: string } | null)
          ?.organization_id;
        if (orgId) {
          await this.client.from('task_history').insert({
            task_id: link.target_id,
            organization_id: orgId,
            action: 'relationship_deleted',
            field_name: null,
            old_value: {
              target_id: pageId,
              target_type: 'wiki_page',
              target_title: pageTitle,
            },
            new_value: null,
            changed_by: userId,
          });
        }
      })();
    }
  }

  /**
   * Backlinks to an entity, scoped to the caller's org (inner-join embed on
   * the source page) and filtered through the page ACL per space so a link
   * never leaks a page the caller cannot view.
   */
  async getBacklinks(
    targetType: string,
    targetId: string,
    user: RequestUser,
  ): Promise<unknown[]> {
    if (!user.organizationId) return [];

    const { data, error } = await this.client
      .from(WikiService.LINKS)
      .select(
        '*, source_page:wiki_pages!source_page_id!inner(id,title,slug,space_id,organization_id,created_by,path,is_published,is_archived,space:spaces!wiki_pages_space_id_fkey(key))',
      )
      .eq('target_type', targetType)
      .eq('target_id', targetId)
      .eq('source_page.organization_id', user.organizationId);
    if (error) throw new BadRequestException(error.message);

    type BacklinkRow = Record<string, unknown> & {
      source_page?: {
        id: string;
        space_id: string;
        created_by?: string | null;
        path?: string[] | null;
        space?: { key?: string } | null;
      } | null;
    };
    const rows = ((data ?? []) as BacklinkRow[]).filter((r) => r.source_page);

    // Group source pages by space and run the app ACL filter per space.
    const pagesBySpace = new Map<string, BacklinkRow[]>();

    for (const row of rows) {
      const sid = row.source_page!.space_id;
      const list = pagesBySpace.get(sid) ?? [];

      list.push(row);
      pagesBySpace.set(sid, list);
    }

    const accessibleIds = new Set<string>();

    for (const [sid, group] of pagesBySpace) {
      const ok = (await this.wikiPermissions.filterAccessiblePages(
        group.map((r) => r.source_page!),
        user.userId,
        sid,
      )) as { id: string }[];

      for (const p of ok) accessibleIds.add(p.id);
    }

    return rows
      .filter((row) => accessibleIds.has(row.source_page!.id))
      .map((row) => {
        // The page's own space key, so a task panel opens it in its space.
        const { space, ...page } = row.source_page!;
        return {
          link_id: row['id'],
          linked_at: row['created_at'],
          page: { ...page, space_key: space?.key ?? null },
        };
      });
  }

  // ------------------------------------------------------------------ //
  // Contributors                                                         //
  // ------------------------------------------------------------------ //

  async getContributors(
    spaceId: string,
    period: 'week' | 'month' | 'all',
    limit: number,
  ): Promise<unknown[]> {
    let q = this.client
      .from(WikiService.PAGES)
      .select('created_by, updated_by')
      .eq('space_id', spaceId);

    if (period === 'week') {
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      q = q.gte('updated_at', since);
    } else if (period === 'month') {
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      q = q.gte('updated_at', since);
    }

    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);

    const counts: Record<string, number> = {};
    for (const row of (data ?? []) as Record<string, string>[]) {
      if (row['created_by'])
        counts[row['created_by']] = (counts[row['created_by']] ?? 0) + 1;
      if (row['updated_by'] && row['updated_by'] !== row['created_by']) {
        counts[row['updated_by']] = (counts[row['updated_by']] ?? 0) + 1;
      }
    }

    const topIds = Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([id]) => id);

    if (topIds.length === 0) return [];

    const { data: users } = await this.client
      .from('users')
      .select('id, first_name, last_name, email, avatar_url')
      .in('id', topIds);

    return (users ?? []).map((u: Record<string, unknown>) => ({
      ...u,
      contribution_count: counts[u['id'] as string] ?? 0,
    }));
  }

  // ------------------------------------------------------------------ //
  // Helpers                                                              //
  // ------------------------------------------------------------------ //

  /**
   * Notifies newly mentioned org members (in-app + broadcast + email,
   * fire-and-forget). Public/internal: also reused by WikiCommentsService.
   * `contentFormat` selects the extraction strategy ('tiptap' walks mention
   * nodes; anything else uses the HTML data-user-id regex).
   */
  async notifyMentionedUsers(
    html: string,
    referenceType: string,
    referenceId: string,
    entityId: string,
    entityName: string,
    orgId: string,
    mentionedByUserId: string,
    spaceId?: string | null,
    oldHtml?: string | null,
    contentFormat?: string | null,
    oldContentFormat?: string | null,
  ): Promise<void> {
    const extract = (value: string, format: string | null | undefined) =>
      format === 'tiptap'
        ? extractTipTapUserMentionIds(value)
        : extractUserMentionIds(value);

    const newIds = extract(html, contentFormat);

    if (!newIds.length) return;

    // On UPDATE, only notify users who are newly mentioned (not in the old content).
    const oldIds = new Set(
      oldHtml ? extract(oldHtml, oldContentFormat ?? contentFormat) : [],
    );
    const diffIds = newIds.filter((id) => !oldIds.has(id));
    const toFilter = diffIds.filter((id) => id !== mentionedByUserId);

    if (!toFilter.length) return;

    const { data: members } = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', orgId)
      .in('user_id', toFilter);

    const toNotify = ((members ?? []) as { user_id: string }[]).map(
      (m) => m.user_id,
    );

    if (!toNotify.length) return;

    let spaceKey: string | null = null;

    if (spaceId) {
      const spaceRes = await this.client
        .from('spaces')
        .select('key')
        .eq('id', spaceId)
        .maybeSingle();

      spaceKey = (spaceRes.data as { key?: string } | null)?.key ?? null;
    }

    // Fetch the mentioner's display name.
    const { data: mentioner } = await this.client
      .from('users')
      .select('first_name, last_name')
      .eq('id', mentionedByUserId)
      .maybeSingle();

    const mentionerName = mentioner
      ? `${(mentioner as { first_name?: string | null }).first_name ?? ''} ${(mentioner as { last_name?: string | null }).last_name ?? ''}`.trim() ||
        'Someone'
      : 'Someone';

    const rawText =
      contentFormat === 'tiptap'
        ? extractWikiPlainText(html, 'tiptap').slice(0, 200)
        : html.replace(/<[^>]+>/g, '').slice(0, 200);
    const body = rawText.replace(/@/g, '').replace(/\s+/g, ' ').trim() || null;

    const { data: insertedNotifs, error: insertError } = await this.client
      .from('notifications')
      .insert(
        toNotify.map((userId) => ({
          organization_id: orgId,
          user_id: userId,
          type: 'comment_mention',
          title: `${mentionerName} mentioned you in "${entityName || 'a wiki page'}"`,
          body,
          is_read: false,
          reference_type: referenceType,
          reference_id: referenceId,
          metadata: {
            mentioned_by_user_id: mentionedByUserId,
            mentioner_name: mentionerName,
            entity_id: entityId,
            entity_name: entityName,
            ...(spaceKey && { space_key: spaceKey }),
          },
        })),
      )
      .select();

    if (insertError) {
      console.error(
        '[WikiService.notifyMentionedUsers] INSERT failed:',
        insertError.message,
        insertError,
      );
    } else if (insertedNotifs) {
      for (const notif of insertedNotifs) {
        void this.notificationsBroadcast?.broadcastNotification(
          notif as Record<string, unknown>,
        );
      }
      void this.notificationEmail?.emailForNotifications(
        insertedNotifs as Record<string, unknown>[],
      );
    }
  }

  private slugify(title: string): string {
    return (
      title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 490) || 'page'
    );
  }

  private async ensureUniqueSlug(
    spaceId: string,
    base: string,
    excludePageId?: string,
  ): Promise<string> {
    let candidate = base;
    let suffix = 0;
    for (;;) {
      let q = this.client
        .from(WikiService.PAGES)
        .select('id')
        .eq('space_id', spaceId)
        .eq('slug', candidate);
      if (excludePageId) q = q.neq('id', excludePageId);
      const { data } = await q.maybeSingle();
      if (!data) return candidate;
      suffix++;
      candidate = `${base}-${suffix}`;
    }
  }
}
