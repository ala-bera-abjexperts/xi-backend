/**
 * @fileoverview Wiki full-text search (Wiki 2.0) backed by the
 * `wiki_search_pages` RPC (tsvector over title + content_text, ts_headline
 * snippets with <mark> tags, EXECUTE granted to service_role only).
 *
 * Space-scoped advanced search supports pushdown filters (author, workflow
 * status, updated window, archived) plus in-memory intersections for labels,
 * custom-field equality, and attachment presence; results always pass the
 * page ACL BEFORE pagination so total/hasMore are accurate.
 * @module src/wiki/wiki-search.service
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { WikiPermissionsService } from './wiki-permissions.service';
import { WikiLabelsService } from './wiki-labels.service';
import { WikiMineService } from './wiki-mine.service';
import { WikiFieldKeysService } from './wiki-field-keys.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

/** Max candidate rows pulled from the RPC before ACL filtering. */
const RPC_FETCH_CAP = 500;

/** Max page size for space advanced search. */
const MAX_ADVANCED_LIMIT = 50;

/** Default page size for space advanced search. */
const DEFAULT_ADVANCED_LIMIT = 25;

/** Max hits for the global cross-space search. */
const MAX_GLOBAL_LIMIT = 20;

const IN_CHUNK = 100;

/** One row returned by the wiki_search_pages RPC. */
interface SearchRpcRow {
  id: string;
  space_id: string;
  title: string;
  slug: string | null;
  path: string[] | null;
  parent_id: string | null;
  created_by: string | null;
  has_custom_permissions: boolean | null;
  workflow_status: string | null;
  is_published: boolean | null;
  is_archived: boolean | null;
  created_at: string | null;
  updated_at: string | null;
  rank: number | null;
  snippet: string | null;
}

export interface AdvancedSearchOptions {
  q?: string;
  authorId?: string;
  labelIds?: string[];
  status?: 'draft' | 'in_review' | 'published';
  updatedAfter?: string;
  updatedBefore?: string;
  includeArchived?: boolean;
  hasAttachments?: boolean;
  cf?: Record<string, unknown>;
  sort?: 'relevance' | 'updated_at' | 'created_at' | 'title';
  /** Wiki custom-field key to sort by (mutually exclusive with `sort`). */
  sortCustomField?: string;
  sortDirection?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

@Injectable()
export class WikiSearchService {
  private static readonly PAGES = 'wiki_pages';
  private static readonly PAGE_LABELS = 'wiki_page_labels';
  private static readonly PAGE_ATTACHMENTS = 'wiki_page_attachments';
  private static readonly FILE_ATTACHMENTS = 'file_attachments';
  private static readonly RPC = 'wiki_search_pages';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly wikiPermissions: WikiPermissionsService,
    private readonly labelsService: WikiLabelsService,
    private readonly wikiMine: WikiMineService,
    private readonly wikiFieldKeys: WikiFieldKeysService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ── Space-scoped advanced search ──────────────────────────────────────────

  /**
   * Advanced search within one space. Flow: RPC (or plain scoped query when
   * no q) → label/cf/attachment intersections → page ACL filter → sort →
   * paginate (total reflects the POST-filter count).
   */
  async advancedSpaceSearch(
    user: RequestUser,
    spaceId: string,
    opts: AdvancedSearchOptions,
  ): Promise<{ results: unknown[]; total: number; hasMore: boolean }> {
    const limit = Math.min(
      Math.max(1, opts.limit ?? DEFAULT_ADVANCED_LIMIT),
      MAX_ADVANCED_LIMIT,
    );
    const offset = Math.max(0, opts.offset ?? 0);
    const q = (opts.q ?? '').trim();

    let candidates: SearchRpcRow[];

    if (q.length >= 2) {
      candidates = await this.runSearchRpc(
        user.organizationId,
        [spaceId],
        q,
        opts,
        RPC_FETCH_CAP,
      );
    } else {
      candidates = await this.runPlainQuery(user.organizationId, spaceId, opts);
    }

    // Label filter (OR across labelIds).
    if (opts.labelIds && opts.labelIds.length > 0) {
      const labeledIds = await this.pageIdsWithLabels(
        opts.labelIds,
        candidates.map((c) => c.id),
      );

      candidates = candidates.filter((c) => labeledIds.has(c.id));
    }

    // Custom-field equality filter (AND across keys via jsonb containment).
    if (opts.cf && Object.keys(opts.cf).length > 0) {
      const cfIds = await this.pageIdsWithCustomFields(
        spaceId,
        opts.cf,
        candidates.map((c) => c.id),
      );

      candidates = candidates.filter((c) => cfIds.has(c.id));
    }

    // Attachment-presence filter.
    if (opts.hasAttachments) {
      const withAttachments = await this.pageIdsWithAttachments(
        candidates.map((c) => c.id),
      );

      candidates = candidates.filter((c) => withAttachments.has(c.id));
    }

    // Page ACL — BEFORE pagination so total/hasMore are correct.
    const accessible = (await this.wikiPermissions.filterAccessiblePages(
      candidates,
      user.userId,
      spaceId,
    )) as SearchRpcRow[];

    if (opts.sortCustomField) {
      // Reject an unknown / injected field_key before touching any data.
      await this.assertWikiCustomFieldKey(
        user.organizationId,
        spaceId,
        opts.sortCustomField,
      );

      const valuesById = await this.fetchCustomFieldValues(
        accessible.map((r) => r.id),
      );

      this.sortByCustomFieldValues(
        accessible,
        opts.sortCustomField,
        opts.sortDirection ?? 'asc',
        valuesById,
      );
    } else {
      this.sortRows(
        accessible,
        opts.sort ?? (q ? 'relevance' : 'updated_at'),
        opts.sortDirection,
      );
    }

    const total = accessible.length;
    const pageRows = accessible.slice(offset, offset + limit);

    // Enrich the returned slice with labels.
    const labelsByPage = await this.labelsService.getBulkPageLabels(
      pageRows.map((r) => r.id),
    );

    return {
      results: pageRows.map((r) => ({
        id: r.id,
        title: r.title,
        slug: r.slug,
        snippet: r.snippet ?? null,
        rank: r.rank ?? null,
        space_id: r.space_id,
        parent_id: r.parent_id,
        path: r.path ?? [],
        workflow_status: r.workflow_status,
        is_published: r.is_published,
        is_archived: r.is_archived,
        created_by: r.created_by,
        created_at: r.created_at,
        updated_at: r.updated_at,
        labels: labelsByPage[r.id] ?? [],
      })),
      total,
      hasMore: offset + limit < total,
    };
  }

  // ── Global cross-space search ─────────────────────────────────────────────

  /**
   * Org-wide search across every space where the caller holds
   * view_wiki_pages (space set resolved via WikiMineService — the same
   * accessible-space mechanism the MCP surface uses), ACL-filtered per space.
   * Returns top hits with space_key for URL building.
   */
  async globalSearch(
    user: RequestUser,
    q: string,
    limit?: number,
  ): Promise<{ results: unknown[]; truncated?: boolean }> {
    const capped = Math.min(
      Math.max(1, limit ?? MAX_GLOBAL_LIMIT),
      MAX_GLOBAL_LIMIT,
    );
    const query = (q ?? '').trim();

    if (query.length < 2 || !user.organizationId) {
      return { results: [] };
    }

    const { spaceIds, spacesById, truncated } =
      await this.wikiMine.resolveAccessibleWikiSpaceIds(user);

    if (spaceIds.length === 0) {
      return { results: [], ...(truncated && { truncated }) };
    }

    const rows = await this.runSearchRpc(
      user.organizationId,
      spaceIds,
      query,
      {},
      RPC_FETCH_CAP,
    );

    // ACL filter per space.
    const rowsBySpace = new Map<string, SearchRpcRow[]>();

    for (const row of rows) {
      const list = rowsBySpace.get(row.space_id) ?? [];

      list.push(row);
      rowsBySpace.set(row.space_id, list);
    }

    const accessible: SearchRpcRow[] = [];

    for (const [sid, group] of rowsBySpace) {
      const ok = (await this.wikiPermissions.filterAccessiblePages(
        group,
        user.userId,
        sid,
      )) as SearchRpcRow[];

      accessible.push(...ok);
    }

    this.sortRows(accessible, 'relevance');

    const results = accessible.slice(0, capped).map((r) => {
      const space = spacesById.get(r.space_id);

      return {
        id: r.id,
        title: r.title,
        slug: r.slug,
        snippet: r.snippet ?? null,
        rank: r.rank ?? null,
        space_id: r.space_id,
        space_key: space?.key ?? null,
        space_name: space?.name ?? null,
        workflow_status: r.workflow_status,
        is_published: r.is_published,
        is_archived: r.is_archived,
        updated_at: r.updated_at,
      };
    });

    return { results, ...(truncated && { truncated }) };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async runSearchRpc(
    organizationId: string,
    spaceIds: string[],
    q: string,
    opts: Pick<
      AdvancedSearchOptions,
      | 'authorId'
      | 'status'
      | 'updatedAfter'
      | 'updatedBefore'
      | 'includeArchived'
    >,
    cap: number,
  ): Promise<SearchRpcRow[]> {
    const { data, error } = (await this.client.rpc(WikiSearchService.RPC, {
      p_organization_id: organizationId,
      p_space_ids: spaceIds,
      p_query: q,
      p_author: opts.authorId ?? null,
      p_workflow_status: opts.status ?? null,
      p_updated_after: opts.updatedAfter ?? null,
      p_updated_before: opts.updatedBefore ?? null,
      p_include_archived: opts.includeArchived === true,
      p_limit: cap,
      p_offset: 0,
    })) as {
      data: SearchRpcRow[] | null;
      error: { message: string } | null;
    };
    if (error) throw new BadRequestException(error.message);

    return data ?? [];
  }

  // No-q path: plain scoped query on wiki_pages with the pushdown filters.
  private async runPlainQuery(
    organizationId: string,
    spaceId: string,
    opts: AdvancedSearchOptions,
  ): Promise<SearchRpcRow[]> {
    let q = this.client
      .from(WikiSearchService.PAGES)
      .select(
        'id, space_id, title, slug, path, parent_id, created_by, has_custom_permissions, workflow_status, is_published, is_archived, created_at, updated_at',
      )
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('updated_at', { ascending: false })
      .limit(RPC_FETCH_CAP);

    if (!opts.includeArchived) q = q.eq('is_archived', false);
    if (opts.authorId) q = q.eq('created_by', opts.authorId);
    if (opts.status) q = q.eq('workflow_status', opts.status);
    if (opts.updatedAfter) q = q.gte('updated_at', opts.updatedAfter);
    if (opts.updatedBefore) q = q.lte('updated_at', opts.updatedBefore);

    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);

    return ((data ?? []) as Omit<SearchRpcRow, 'rank' | 'snippet'>[]).map(
      (row) => ({ ...row, rank: null, snippet: null }),
    );
  }

  /** Page ids (within candidates) carrying ANY of the given labels. */
  private async pageIdsWithLabels(
    labelIds: string[],
    candidateIds: string[],
  ): Promise<Set<string>> {
    const out = new Set<string>();

    for (let i = 0; i < candidateIds.length; i += IN_CHUNK) {
      const { data, error } = await this.client
        .from(WikiSearchService.PAGE_LABELS)
        .select('page_id')
        .in('label_id', labelIds)
        .in('page_id', candidateIds.slice(i, i + IN_CHUNK));
      if (error) throw new BadRequestException(error.message);

      for (const row of (data ?? []) as { page_id: string }[]) {
        out.add(row.page_id);
      }
    }

    return out;
  }

  /** Page ids (within candidates) whose custom_field_values contain `cf`. */
  private async pageIdsWithCustomFields(
    spaceId: string,
    cf: Record<string, unknown>,
    candidateIds: string[],
  ): Promise<Set<string>> {
    const out = new Set<string>();

    for (let i = 0; i < candidateIds.length; i += IN_CHUNK) {
      const { data, error } = await this.client
        .from(WikiSearchService.PAGES)
        .select('id')
        .eq('space_id', spaceId)
        .contains('custom_field_values', cf)
        .in('id', candidateIds.slice(i, i + IN_CHUNK));
      if (error) throw new BadRequestException(error.message);

      for (const row of (data ?? []) as { id: string }[]) {
        out.add(row.id);
      }
    }

    return out;
  }

  /** Page ids (within candidates) that have at least one attachment. */
  private async pageIdsWithAttachments(
    candidateIds: string[],
  ): Promise<Set<string>> {
    const out = new Set<string>();

    for (let i = 0; i < candidateIds.length; i += IN_CHUNK) {
      const chunk = candidateIds.slice(i, i + IN_CHUNK);
      const [wikiAtt, fileAtt] = await Promise.all([
        this.client
          .from(WikiSearchService.PAGE_ATTACHMENTS)
          .select('wiki_page_id')
          .in('wiki_page_id', chunk),
        this.client
          .from(WikiSearchService.FILE_ATTACHMENTS)
          .select('entity_id')
          .eq('entity_type', 'wiki_page')
          .in('entity_id', chunk),
      ]);

      if (wikiAtt.error) throw new BadRequestException(wikiAtt.error.message);
      if (fileAtt.error) throw new BadRequestException(fileAtt.error.message);

      for (const row of (wikiAtt.data ?? []) as { wiki_page_id: string }[]) {
        out.add(row.wiki_page_id);
      }
      for (const row of (fileAtt.data ?? []) as { entity_id: string }[]) {
        out.add(row.entity_id);
      }
    }

    return out;
  }

  private sortRows(
    rows: SearchRpcRow[],
    sort: 'relevance' | 'updated_at' | 'created_at' | 'title',
    direction?: 'asc' | 'desc',
  ): void {
    // Each built-in sort has a natural default direction (title asc, everything
    // else desc); an explicit `direction` overrides it. Defaults are unchanged
    // when `direction` is omitted, so existing callers keep their behavior.
    const defaultDir: 'asc' | 'desc' = sort === 'title' ? 'asc' : 'desc';
    const dir = (direction ?? defaultDir) === 'asc' ? 1 : -1;

    rows.sort((a, b) => {
      if (sort === 'relevance') {
        const ra = a.rank ?? 0;
        const rb = b.rank ?? 0;

        if (ra !== rb) return (ra - rb) * dir;

        return (b.updated_at ?? '') < (a.updated_at ?? '') ? -1 : 1;
      }
      if (sort === 'title') {
        return a.title.localeCompare(b.title) * dir;
      }

      const key = sort === 'created_at' ? 'created_at' : 'updated_at';
      const va = a[key] ?? '';
      const vb = b[key] ?? '';

      if (va === vb) return a.id < b.id ? 1 : -1;

      return (va < vb ? -1 : 1) * dir;
    });
  }

  // ── Custom-field sorting ──────────────────────────────────────────────────

  /**
   * Rejects a sort field_key that is not assigned to this space's wiki. The key
   * is never interpolated into SQL (sorting is in-memory over the jsonb value),
   * but validating existence keeps the contract tight and blocks garbage keys.
   *
   * Strict — no tolerance set, unlike the page write path: there is no single
   * row to tolerate against, and the filter rail only offers assigned fields.
   */
  private async assertWikiCustomFieldKey(
    organizationId: string,
    spaceId: string,
    fieldKey: string,
  ): Promise<void> {
    await this.wikiFieldKeys.assertKeysAllowed(
      organizationId,
      spaceId,
      [fieldKey],
      undefined,
      'sort key',
    );
  }

  /** Load custom_field_values for the given page ids (batched, keyed by id). */
  private async fetchCustomFieldValues(
    pageIds: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const map = new Map<string, Record<string, unknown>>();

    for (let i = 0; i < pageIds.length; i += IN_CHUNK) {
      const { data, error } = await this.client
        .from(WikiSearchService.PAGES)
        .select('id, custom_field_values')
        .in('id', pageIds.slice(i, i + IN_CHUNK));
      if (error) throw new BadRequestException(error.message);

      for (const row of (data ?? []) as {
        id: string;
        custom_field_values: Record<string, unknown> | null;
      }[]) {
        map.set(row.id, row.custom_field_values ?? {});
      }
    }

    return map;
  }

  /**
   * In-memory sort by a custom-field value: numeric compare when both sides
   * parse as finite numbers, else locale string compare. Empty/null values
   * always sort last, regardless of direction; ties break by id for stability.
   */
  private sortByCustomFieldValues(
    rows: SearchRpcRow[],
    key: string,
    direction: 'asc' | 'desc',
    valuesById: Map<string, Record<string, unknown>>,
  ): void {
    const dir = direction === 'asc' ? 1 : -1;
    const isEmpty = (v: unknown): boolean =>
      v === undefined || v === null || v === '';

    rows.sort((a, b) => {
      const va = valuesById.get(a.id)?.[key];
      const vb = valuesById.get(b.id)?.[key];
      const aEmpty = isEmpty(va);
      const bEmpty = isEmpty(vb);

      if (aEmpty && bEmpty) return a.id < b.id ? -1 : 1;
      if (aEmpty) return 1;
      if (bEmpty) return -1;

      const na = Number(va);
      const nb = Number(vb);
      const bothNumeric =
        typeof va !== 'boolean' &&
        typeof vb !== 'boolean' &&
        Number.isFinite(na) &&
        Number.isFinite(nb);

      if (bothNumeric) {
        if (na !== nb) return (na < nb ? -1 : 1) * dir;

        return a.id < b.id ? -1 : 1;
      }

      const cmp = String(va).localeCompare(String(vb));

      if (cmp !== 0) return cmp * dir;

      return a.id < b.id ? -1 : 1;
    });
  }
}
