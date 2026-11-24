// MCP-facing, member-space + page-ACL constrained wiki reads backing the MCP
// `wiki.search` / `wiki.get` tools.
//
// Mirrors the tasks.service MCP pattern, but for wiki, with the critical
// difference that wiki has both a space-level gate (`view_wiki_pages` space
// permission, the same one SpacePermissionsGuard enforces) and a real
// closed-by-default per-page ACL (WikiPermissionsService). This service reuses
// the same app gates so MCP returns precisely what the app shows and never
// leaks a page the app hides:
//   - space gate:    PermissionsService.isAdminOrOwner / getUserSpacePermissions
//   - page-ACL gate: WikiPermissionsService.assertPageAccess / filterAccessiblePages
//
// Anti-probing: cross-org, non-member-space, ACL-denied, draft, and nonexistent
// all collapse to the identical NotFoundException (get) or an empty result
// (search), never a 403, never distinguishable. The org is taken from the
// authenticated RequestUser (never a parameter), so the caller cannot cross orgs.
//
// Exposure rules: unpublished drafts are never returned; archived pages are
// excluded from search by default (opt-in via includeArchived) and returned by
// get with an `isArchived` flag; content is sanitized plain text only; no raw
// content/metadata/internal fields/PII/attachments are exposed.

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { WikiPermissionsService } from './wiki-permissions.service';
import { extractWikiPlainText } from './wiki-content.util';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

/** The space-permission key that gates viewing wiki pages (mirrors the guard). */
const VIEW_WIKI_PERMISSION = 'view_wiki_pages';

// Hard upper bound on org spaces scanned per non-admin request for the
// accessible-wiki-space set (N per-space membership checks). Mirrors
// TASK_SPACE_SCAN_CAP; set-based SQL is a noted follow-up.
const WIKI_SPACE_SCAN_CAP = 200;

/** Max wiki-search page size (clamped). */
const MAX_WIKI_SEARCH_LIMIT = 50;

/** Default wiki-search page size when none supplied. */
const DEFAULT_WIKI_SEARCH_LIMIT = 25;

// Hard cap on raw title-match rows fetched before ACL filtering. Bounds the
// per-request work; if hit, the result is flagged `truncated` (coverage gap).
const WIKI_SEARCH_RAW_FETCH_CAP = 500;

/** Max child pages returned by `getMyWikiPage` when includeChildren=true. */
const MAX_WIKI_CHILDREN = 100;

/** Snippet length (chars) of sanitized plain text in search results. */
const WIKI_SNIPPET_CHARS = 200;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A whitelisted space reference embedded in a wiki result. */
export interface WikiSpaceRef {
  id: string;
  key: string;
  name: string;
}

/** One whitelisted wiki page from `searchMyWikiPages` (list shape, no content). */
export interface MyWikiSearchItem {
  id: string;
  title: string;
  snippet: string;
  slug: string | null;
  space: WikiSpaceRef | null;
  isArchived: boolean;
  updatedAt: string;
}

/** The `searchMyWikiPages` payload. Never null; `pages:[]` when empty. */
export interface MyWikiSearchResult {
  pages: MyWikiSearchItem[];
  nextCursor?: string;
  /** Set when the space-scan or raw-fetch cap was hit (coverage may be partial). */
  truncated?: boolean;
}

/** A minimal accessible child page from `getMyWikiPage`. */
export interface MyWikiPageChild {
  id: string;
  title: string;
}

/** The whitelisted, MCP-safe wiki page detail returned by `getMyWikiPage`. */
export interface MyWikiPageDetail {
  id: string;
  title: string;
  slug: string | null;
  parentId: string | null;
  space: WikiSpaceRef | null;
  tags: unknown;
  isPublished: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  /** Sanitized plain text (the MCP layer truncates/delimits/scrubs). */
  contentText: string;
  contentFormat: string;
}

/** The `getMyWikiPage` payload. */
export interface MyWikiPageResult {
  page: MyWikiPageDetail;
  children?: MyWikiPageChild[];
}

/** Raw wiki row shape used internally (whitelisted column select). */
interface WikiRow {
  id: string;
  space_id: string;
  title: string;
  slug: string | null;
  is_published: boolean | null;
  is_archived: boolean | null;
  updated_at: string | null;
  created_by: string | null;
  path: string[] | null;
  content: string | null;
  content_format: string | null;
}

@Injectable()
export class WikiMineService {
  private static readonly PAGES = 'wiki_pages';
  private static readonly SPACES = 'spaces';
  private readonly logger = new Logger(WikiMineService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissionsService: PermissionsService,
    private readonly wikiPermissions: WikiPermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // Resolve the spaces in the caller's org whose wiki the caller may read: org
  // admins/owners see every non-archived space; everyone else keeps only spaces
  // where they are an active member and hold the `view_wiki_pages` space
  // permission. Bounded by WIKI_SPACE_SCAN_CAP (truncation flagged).
  // Public: also reused by WikiSearchService.globalSearch so the app search
  // surface and the MCP surface share the exact same space-visibility rules.
  async resolveAccessibleWikiSpaceIds(user: RequestUser): Promise<{
    spaceIds: string[];
    spacesById: Map<string, WikiSpaceRef>;
    truncated: boolean;
  }> {
    const spacesById = new Map<string, WikiSpaceRef>();

    if (!user.organizationId) {
      return { spaceIds: [], spacesById, truncated: false };
    }

    const candidatesResult = await this.client
      .from(WikiMineService.SPACES)
      .select('id, key, name')
      .eq('organization_id', user.organizationId)
      .eq('is_archived', false)
      .order('id', { ascending: true })
      .limit(WIKI_SPACE_SCAN_CAP);

    if (candidatesResult.error) {
      this.logger.warn(
        `resolveAccessibleWikiSpaceIds: candidate scan failed: ${candidatesResult.error.message}`,
      );

      return { spaceIds: [], spacesById, truncated: false };
    }

    const candidates = (candidatesResult.data ?? []) as WikiSpaceRef[];
    const truncated = candidates.length === WIKI_SPACE_SCAN_CAP;

    if (truncated) {
      this.logger.warn(
        `resolveAccessibleWikiSpaceIds: org ${user.organizationId} has at ` +
          `least ${WIKI_SPACE_SCAN_CAP} non-archived spaces; scan capped — ` +
          'wiki search coverage constrained to the scanned prefix.',
      );
    }

    const isAdminOrOwner = await this.permissionsService.isAdminOrOwner(
      user.userId,
      user.organizationId,
    );

    if (isAdminOrOwner) {
      for (const row of candidates) {
        spacesById.set(row.id, { id: row.id, key: row.key, name: row.name });
      }

      return {
        spaceIds: candidates.map((row) => row.id),
        spacesById,
        truncated,
      };
    }

    const checks = await Promise.all(
      candidates.map(async (row) => ({
        row,
        resolved: await this.permissionsService.getUserSpacePermissions(
          user.userId,
          user.organizationId,
          row.id,
        ),
      })),
    );

    const spaceIds: string[] = [];

    for (const { row, resolved } of checks) {
      if (
        resolved.isMember &&
        resolved.permissions[VIEW_WIKI_PERMISSION] === true
      ) {
        spaceIds.push(row.id);
        spacesById.set(row.id, { id: row.id, key: row.key, name: row.name });
      }
    }

    return { spaceIds, spacesById, truncated };
  }

  /** Resolve a space UUID or key to a space id, scoped to the org (or null). */
  private async resolveSpaceIdOrKey(
    spaceIdOrKey: string,
    organizationId: string,
  ): Promise<string | null> {
    const isUuid = UUID_RE.test(spaceIdOrKey);

    const result = await this.client
      .from(WikiMineService.SPACES)
      .select('id')
      .eq(
        isUuid ? 'id' : 'key',
        isUuid ? spaceIdOrKey : spaceIdOrKey.toUpperCase(),
      )
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (result.error) return null;

    return (result.data as { id?: string } | null)?.id ?? null;
  }

  /** Encode a stable (updatedAt, id) keyset cursor. */
  private encodeCursor(updatedAt: string, id: string): string {
    return Buffer.from(`${updatedAt}|${id}`, 'utf8').toString('base64url');
  }

  /** Decode a keyset cursor, or null when malformed. */
  private decodeCursor(
    cursor: string,
  ): { updatedAt: string; id: string } | null {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const idx = decoded.lastIndexOf('|');

      if (idx < 0) return null;

      return { updatedAt: decoded.slice(0, idx), id: decoded.slice(idx + 1) };
    } catch {
      return null;
    }
  }

  // Member-space + page-ACL constrained wiki search backing MCP `wiki.search`.
  //
  // Title-only `ilike` (mirrors WikiService.searchPages/getPages search), then
  // the same app page-ACL filter (`filterAccessiblePages`) per space, then
  // draft/archived exposure rules, sorted (updatedAt desc, id desc) with a
  // stable keyset cursor. A non-accessible/nonexistent `spaceIdOrKey` yields an
  // empty result (anti-probing), never an error. The result is never null. The
  // caller (org + ids) comes from the authenticated user; no org parameter is
  // ever accepted.
  async searchMyWikiPages(
    user: RequestUser,
    opts: {
      query?: string;
      spaceIdOrKey?: string;
      includeArchived?: boolean;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<MyWikiSearchResult> {
    if (!user.organizationId) {
      return { pages: [] };
    }

    // Sanitize exactly like WikiService.getPages to prevent PostgREST injection.
    const safe = (opts.query ?? '').replace(/[,.()"'\\]/g, '').trim();

    if (!safe) {
      return { pages: [] };
    }

    const { spaceIds, spacesById, truncated } =
      await this.resolveAccessibleWikiSpaceIds(user);

    let targetSpaceIds = spaceIds;

    if (opts.spaceIdOrKey) {
      const resolvedId = await this.resolveSpaceIdOrKey(
        opts.spaceIdOrKey,
        user.organizationId,
      );

      // Non-accessible (or nonexistent) space yields empty (cannot probe existence).
      if (!resolvedId || !spacesById.has(resolvedId)) {
        return { pages: [] };
      }

      targetSpaceIds = [resolvedId];
    }

    if (targetSpaceIds.length === 0) {
      return { pages: [] };
    }

    let q = this.client
      .from(WikiMineService.PAGES)
      .select(
        'id, space_id, title, slug, is_published, is_archived, updated_at, created_by, path, content, content_format',
      )
      .in('space_id', targetSpaceIds)
      .ilike('title', `%${safe}%`)
      .order('updated_at', { ascending: false })
      .limit(WIKI_SEARCH_RAW_FETCH_CAP);

    if (!opts.includeArchived) {
      q = q.eq('is_archived', false);
    }

    const { data, error } = await q;

    if (error) {
      this.logger.warn(`searchMyWikiPages: query failed: ${error.message}`);

      return { pages: [] };
    }

    const rows = (data ?? []) as WikiRow[];
    const rawTruncated = rows.length === WIKI_SEARCH_RAW_FETCH_CAP;

    // Page-ACL filter per space (filterAccessiblePages resolves a per-space user
    // context). Group by space, run the same app ACL gate, collect survivors.
    const rowsBySpace = new Map<string, WikiRow[]>();

    for (const row of rows) {
      const list = rowsBySpace.get(row.space_id) ?? [];

      list.push(row);
      rowsBySpace.set(row.space_id, list);
    }

    const accessible: WikiRow[] = [];

    for (const [sid, group] of rowsBySpace) {
      const ok = (await this.wikiPermissions.filterAccessiblePages(
        group,
        user.userId,
        sid,
      )) as WikiRow[];

      accessible.push(...ok);
    }

    // Exposure rules: never expose pure drafts (!published && !archived). When
    // includeArchived is false the query already excluded archived rows.
    const exposed = accessible.filter(
      (row) => row.is_published === true || row.is_archived === true,
    );

    // Stable sort: updatedAt DESC, id DESC.
    exposed.sort((a, b) => {
      const au = a.updated_at ?? '';
      const bu = b.updated_at ?? '';

      if (au !== bu) return au < bu ? 1 : -1;

      return a.id < b.id ? 1 : -1;
    });

    // Keyset cursor: keep rows strictly after the cursor in (updatedAt, id) DESC.
    let windowed = exposed;
    const decoded = opts.cursor ? this.decodeCursor(opts.cursor) : null;

    if (decoded) {
      windowed = exposed.filter((row) => {
        const u = row.updated_at ?? '';

        if (u !== decoded.updatedAt) return u < decoded.updatedAt;

        return row.id < decoded.id;
      });
    }

    const requestedLimit = Number.isFinite(opts.limit)
      ? (opts.limit as number)
      : DEFAULT_WIKI_SEARCH_LIMIT;
    const limit = Math.min(Math.max(1, requestedLimit), MAX_WIKI_SEARCH_LIMIT);

    const hasMore = windowed.length > limit;
    const pageRows = hasMore ? windowed.slice(0, limit) : windowed;

    const pages: MyWikiSearchItem[] = pageRows.map((row) => ({
      id: row.id,
      title: row.title,
      snippet: extractWikiPlainText(row.content, row.content_format).slice(
        0,
        WIKI_SNIPPET_CHARS,
      ),
      slug: row.slug ?? null,
      space: spacesById.get(row.space_id) ?? null,
      isArchived: row.is_archived === true,
      updatedAt: row.updated_at ?? '',
    }));

    const result: MyWikiSearchResult = { pages };

    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];

      result.nextCursor = this.encodeCursor(last.updated_at ?? '', last.id);
    }

    if (truncated || rawTruncated) {
      result.truncated = true;
    }

    return result;
  }

  // Member-space + page-ACL constrained single-page read backing MCP `wiki.get`.
  //
  // Resolves the page by UUID, confirms it belongs to the caller's org, applies
  // the same two gates the app applies (space membership + `view_wiki_pages`,
  // then page-ACL `assertPageAccess('can_view')`), and rejects pure drafts.
  // Every denial (cross-org, non-member, ACL-denied, draft, nonexistent,
  // malformed id) throws the identical NotFoundException (anti-probing). The
  // caller (org + ids) comes from the authenticated user; pageId is a wiki page
  // UUID as returned by wiki.search.
  async getMyWikiPage(
    user: RequestUser,
    pageId: string,
    opts: { includeChildren?: boolean } = {},
  ): Promise<MyWikiPageResult> {
    const notFound = () => new NotFoundException('Wiki page not found');

    if (!user.organizationId) {
      throw notFound();
    }

    // wiki.get resolves by page UUID only (slugs are not globally unique).
    if (!UUID_RE.test(pageId)) {
      throw notFound();
    }

    const pageResult = await this.client
      .from(WikiMineService.PAGES)
      .select(
        'id, space_id, organization_id, parent_id, title, slug, tags, is_published, is_archived, created_at, updated_at, content, content_format',
      )
      .eq('id', pageId)
      .maybeSingle();

    if (pageResult.error || !pageResult.data) {
      throw notFound();
    }

    const page = pageResult.data as {
      id: string;
      space_id: string;
      organization_id: string;
      parent_id: string | null;
      title: string;
      slug: string | null;
      tags: unknown;
      is_published: boolean | null;
      is_archived: boolean | null;
      created_at: string | null;
      updated_at: string | null;
      content: string | null;
      content_format: string | null;
    };

    // Cross-org guard (defense-in-depth: never return another org's page).
    if (page.organization_id !== user.organizationId) {
      throw notFound();
    }

    const spaceId = page.space_id;

    // Gate 1: space membership + view_wiki_pages (mirrors SpacePermissionsGuard,
    // org admin/owner bypass). A ForbiddenException becomes the same notFound.
    const isAdminOrOwner = await this.permissionsService.isAdminOrOwner(
      user.userId,
      user.organizationId,
    );

    if (!isAdminOrOwner) {
      const resolved = await this.permissionsService.getUserSpacePermissions(
        user.userId,
        user.organizationId,
        spaceId,
      );

      if (
        !resolved.isMember ||
        resolved.permissions[VIEW_WIKI_PERMISSION] !== true
      ) {
        throw notFound();
      }
    }

    // Gate 2: page-level ACL (mirrors the controller's assertPageAccess).
    try {
      await this.wikiPermissions.assertPageAccess(
        pageId,
        user.userId,
        spaceId,
        'can_view',
      );
    } catch {
      throw notFound();
    }

    // Never expose pure drafts (!published && !archived).
    if (page.is_published !== true && page.is_archived !== true) {
      throw notFound();
    }

    const space = await this.lookupSpaceRef(spaceId, user.organizationId);

    const detail: MyWikiPageDetail = {
      id: page.id,
      title: page.title,
      slug: page.slug ?? null,
      parentId: page.parent_id ?? null,
      space,
      tags: page.tags ?? null,
      isPublished: page.is_published === true,
      isArchived: page.is_archived === true,
      createdAt: page.created_at ?? '',
      updatedAt: page.updated_at ?? '',
      contentText: extractWikiPlainText(page.content, page.content_format),
      contentFormat: page.content_format ?? 'html',
    };

    const result: MyWikiPageResult = { page: detail };

    if (opts.includeChildren) {
      result.children = await this.loadAccessibleChildren(
        pageId,
        spaceId,
        user.userId,
      );
    }

    return result;
  }

  /** Whitelisted `{id,key,name}` space ref, org-scoped (or null). */
  private async lookupSpaceRef(
    spaceId: string,
    organizationId: string,
  ): Promise<WikiSpaceRef | null> {
    const result = await this.client
      .from(WikiMineService.SPACES)
      .select('id, key, name')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (result.error || !result.data) return null;
    const s = result.data as WikiSpaceRef;

    return { id: s.id, key: s.key, name: s.name };
  }

  // Direct child pages the caller can view: the same page-ACL filter, drafts
  // excluded, capped at MAX_WIKI_CHILDREN, projected to `{id,title}` only.
  private async loadAccessibleChildren(
    pageId: string,
    spaceId: string,
    userId: string,
  ): Promise<MyWikiPageChild[]> {
    const childResult = await this.client
      .from(WikiMineService.PAGES)
      .select('id, title, created_by, path, is_published, is_archived')
      .eq('parent_id', pageId)
      .eq('space_id', spaceId);

    if (childResult.error || !childResult.data) return [];

    const childRows = childResult.data as Array<{
      id: string;
      title: string;
      created_by: string | null;
      path: string[] | null;
      is_published: boolean | null;
      is_archived: boolean | null;
    }>;

    const accessible = (await this.wikiPermissions.filterAccessiblePages(
      childRows,
      userId,
      spaceId,
    )) as typeof childRows;

    return accessible
      .filter((c) => c.is_published === true || c.is_archived === true)
      .slice(0, MAX_WIKI_CHILDREN)
      .map((c) => ({ id: c.id, title: c.title }));
  }
}
