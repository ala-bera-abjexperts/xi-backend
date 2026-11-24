import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AgentOriginService } from '../../chat-agent/agent-origin.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { TasksService } from '../../tasks/tasks.service';
import { ProcessesService } from '../../processes/processes.service';
import { WikiService } from '../../wiki/wiki.service';
import { FileExplorerRepository } from '../../file-explorer/file-explorer.repository';
import { FileExplorerStorageService } from '../../file-explorer/file-explorer-storage.service';
import type { IFeNode } from '../../file-explorer/interfaces/fe-node.interface';
import { PermissionsService } from '../../permissions/permissions.service';
import {
  SPACE_ROLE_BASE_PERMISSIONS,
  normalizeSpacePermissions,
} from '../../permissions/models/space-permissions.model';
import type { CreatePublicTicketDto } from './dto/public-site-studio.dto';

type SpaceContext = {
  space: {
    id: string;
    key?: string | null;
    name?: string | null;
    description?: string | null;
    icon_url?: string | null;
    icon?: string | null;
    organization_id: string;
    is_active?: boolean | null;
    is_archived?: boolean | null;
  };
  organizationRole: string | null;
  spaceRole: string | null;
  permissions: Record<string, boolean>;
};

type EditorElement = {
  id?: string;
  type?: string;
  content?: unknown;
};

type TicketFormContent = {
  allowedSpaces?: Array<{ id: string }>;
};

/**
 * The File Explorer widget content as the Site Studio editor stores it.
 * `spaceId` / `labelIds` are read from HERE and never from the request — the
 * page→element binding is the only authorisation for the public file list.
 */
type FileWidgetContent = {
  sourceMode?: string;
  spaceId?: string;
  labelIds?: unknown;
};

/**
 * One row of a public label-backed file list.
 *
 * `nodeId` is what `GET /public/site-studio/files/download` needs, and it is safe
 * to expose because that route re-resolves the element's label set and refuses any
 * id outside it. `token` is present only for nodes that happen to already have a
 * link share (folders need one; files no longer do).
 */
type PublicFileItem = {
  nodeId: string;
  name: string;
  nodeType: string;
  mimeType: string | null;
  fileSize: number | null;
  token?: string;
};

/** The label-matched node set of one published file widget, plus its scoping org. */
type ResolvedLabelElement = {
  nodes: IFeNode[];
  organizationId: string;
  truncated: boolean;
};

type WikiPage = Record<string, unknown> & {
  id: string;
  title?: string;
  slug?: string;
  level?: number | null;
  parent_id?: string | null;
  updated_at?: string | null;
  is_published?: boolean | null;
  is_archived?: boolean | null;
  has_custom_permissions?: boolean | null;
  content?: unknown;
  content_format?: string | null;
};

type TipTapNode = {
  type?: unknown;
  attrs?: unknown;
  content?: unknown;
};

type PublicIncludeDiagnostic = {
  code:
    | 'cycle'
    | 'max_depth'
    | 'inaccessible'
    | 'malformed'
    | 'missing_excerpt';
  message: string;
};

export type PublicIncludeResolution = {
  kind: 'includePage' | 'excerptInclude';
  attrs: {
    pageId: string;
    title: string;
    targetSpaceId?: string;
    targetSpaceKey?: string;
    excerptName?: string;
    nopanel?: boolean;
  };
  data?: {
    pageId: string;
    title: string;
    targetSpaceId?: string;
    targetSpaceKey?: string;
    content: TipTapNode;
    resolutions: Record<string, PublicIncludeResolution>;
  };
  diagnostic?: PublicIncludeDiagnostic;
};

export type PublicWikiMacro =
  | {
      kind: 'pageTree';
      ordinal: number;
      attrs: { rootPageId: string; depth: number };
      data: Array<{
        id: string;
        title: string | undefined;
        slug: string | undefined;
        parentId: string | null;
        children: unknown[];
      }>;
    }
  | {
      kind: 'attachmentsList';
      ordinal: number;
      attrs: { pageId: string };
      data: Array<{
        id: string;
        name: string;
        url: string;
        size: number | null;
        mimeType: string | null;
        createdAt: string | null;
      }>;
    }
  | {
      kind: 'gallery';
      ordinal: number;
      attrs: {
        pageId: string;
        columns: number;
        captions: boolean;
        title?: string | null;
      };
      data: Array<{
        id: string;
        name: string;
        url: string;
        mimeType: string | null;
        size: number | null;
        createdAt: string | null;
      }>;
    }
  | {
      kind: 'recentlyUpdated';
      ordinal: number;
      attrs: { limit: number; hideHeading: boolean; types: string[] };
      data: Array<{
        id: string;
        title: string | undefined;
        slug: string | undefined;
        updatedAt: string | null;
      }>;
    }
  | {
      kind:
        | 'recentlyUsedLabels'
        | 'relatedLabels'
        | 'recentlyUpdatedDashboard'
        | 'contentReportTable'
        | 'navigationMap'
        | 'contentByLabel'
        | 'contentPropertiesReport'
        | 'popularLabels'
        | 'changeHistory';
      ordinal: number;
      attrs: Record<string, unknown>;
      data: Array<Record<string, unknown>>;
    }
  | {
      kind: 'spaceDetails';
      ordinal: number;
      attrs: Record<string, unknown>;
      data: {
        id: string;
        key: string;
        name: string;
        description: string | null;
        icon: string | null;
      };
    }
  | (PublicIncludeResolution & { ordinal: number });

type PublishedFunnel = {
  id: string;
  organization_id: string;
  name: string;
  favicon: string | null;
  published: boolean;
  seo_title: string | null;
  seo_description: string | null;
  seo_image: string | null;
  theme: unknown;
};

type PublishedSitePage = Record<string, unknown> & {
  id: string;
  funnel_id: string;
  organization_id: string;
  name: string;
  path_name: string;
  content: unknown;
  sort_order: number;
  published: boolean;
  seo_title: string | null;
  seo_description: string | null;
  seo_image: string | null;
};

type PublishedPageResult = {
  funnel: PublishedFunnel;
  page: PublishedSitePage;
  formFields: Record<string, unknown>[];
  nextPagePath: string | null;
  allPages: Array<{ id: string; name: string; path_name: string }>;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Element types the public label-backed file list may resolve. Nothing else. */
const FILE_WIDGET_TYPES = new Set(['fileLink', 'fileList', 'folderLink']);

/** Hard ceiling on a public file list — matches parseMaxItems()'s own maximum. */
const PUBLIC_FILE_LIST_CAP = 50;

const PUBLIC_WIKI_MACRO_KINDS = new Set([
  'pageTree',
  'attachmentsList',
  'gallery',
  'recentlyUpdated',
  'includePage',
  'excerptInclude',
  'recentlyUsedLabels',
  'relatedLabels',
  'recentlyUpdatedDashboard',
  'contentReportTable',
  'navigationMap',
  'contentByLabel',
  'contentPropertiesReport',
  'popularLabels',
  'changeHistory',
  'spaceDetails',
]);

@Injectable()
export class PublicSiteStudioService {
  private readonly logger = new Logger(PublicSiteStudioService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly tasksService: TasksService,
    private readonly processesService: ProcessesService,
    private readonly wikiService: WikiService,
    private readonly fileExplorerRepo: FileExplorerRepository,
    private readonly fileExplorerStorage: FileExplorerStorageService,
    private readonly permissionsService: PermissionsService,
    @Optional() private readonly origins?: AgentOriginService,
  ) {}

  /**
   * Whether the caller may edit this funnel, for the "edit this page" affordance on the
   * published view (XE-T453).
   *
   * Deliberately fail-closed and non-revealing: every negative case returns plain `false`
   * rather than 401/403/404. The published page is a customer-facing surface, so the
   * response must not let an anonymous visitor distinguish "this funnel exists but you
   * cannot edit it" from "no such funnel".
   *
   * Anonymous is the normal case here — a custom-domain visitor sends no cookies at all
   * (different registrable domain), so `user` is undefined for most callers.
   */
  async canEditFunnel(
    user: RequestUser | undefined,
    funnelId: string,
  ): Promise<{ canEdit: boolean }> {
    if (!user?.userId || !funnelId) {
      return { canEdit: false };
    }

    const funnelRes = await this.client
      .from('site_studio_funnels')
      .select('id, organization_id')
      .eq('id', funnelId)
      .maybeSingle();

    const orgId = (funnelRes.data as { organization_id?: string } | null)
      ?.organization_id;

    if (!orgId) return { canEdit: false };

    // The FUNNEL's org is authoritative, not `user.organizationId`. Two reasons:
    //
    // 1. On a @Public() route the guard's optional-user path attaches the identity with
    //    `organizationId: ''` (see tryAttachOptionalUser) — comparing against it would
    //    make this always false for every caller.
    // 2. A visitor arriving from a published site may legitimately have a different
    //    active org selected, yet still be a member of the funnel's org.
    //
    // Membership is asserted explicitly rather than inferred from the permission lookup:
    // tenant isolation in this codebase is app-layer only, so the boundary is stated here
    // instead of relying on a downstream call to return empty for a non-member.
    const membershipRes = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('user_id', user.userId)
      .eq('organization_id', orgId)
      .maybeSingle();

    if (!membershipRes.data) return { canEdit: false };

    const canEdit = await this.permissionsService.checkPermission(
      user.userId,
      orgId,
      'can_edit_site_studio',
    );

    return { canEdit };
  }

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async resolvePublishedPage(
    domain: string,
    rawPath = '',
  ): Promise<PublishedPageResult> {
    const normalizedDomain = domain.trim().toLowerCase();
    const path = rawPath.trim().toLowerCase();

    if (!normalizedDomain) throw new BadRequestException('domain is required');

    const funnelId = await this.resolvePublishedFunnelId(normalizedDomain);

    if (!funnelId) throw new NotFoundException('Page not found');

    const { data: funnel, error: funnelError } = await this.client
      .from('site_studio_funnels')
      .select(
        'id, organization_id, name, favicon, published, seo_title, seo_description, seo_image, theme',
      )
      .eq('id', funnelId)
      .maybeSingle();

    if (funnelError) throw new BadRequestException(funnelError.message);
    if (!funnel || !(funnel as PublishedFunnel).published) {
      throw new NotFoundException('Page not found');
    }

    const publishedFunnel = funnel as PublishedFunnel;
    const page = await this.resolvePublishedSitePage(funnelId, path);

    if (!page.published) throw new NotFoundException('Page not found');

    const { data: formFields, error: formFieldsError } = await this.client
      .from('site_studio_form_fields')
      .select('*')
      .eq('funnel_id', funnelId)
      .eq('organization_id', publishedFunnel.organization_id)
      .order('sort_order', { ascending: true });

    if (formFieldsError) {
      throw new BadRequestException(formFieldsError.message);
    }

    const { data: pages, error: pagesError } = await this.client
      .from('site_studio_pages')
      .select('id, name, path_name, sort_order, published')
      .eq('funnel_id', funnelId)
      .eq('organization_id', publishedFunnel.organization_id)
      .eq('published', true)
      .order('sort_order', { ascending: true });

    if (pagesError) throw new BadRequestException(pagesError.message);

    const sortedPages = (pages ?? []) as Array<{
      id: string;
      name: string;
      path_name: string;
      sort_order: number;
      published: boolean;
    }>;
    const currentIndex = sortedPages.findIndex((p) => p.id === page.id);
    const nextPagePath =
      currentIndex >= 0 && currentIndex < sortedPages.length - 1
        ? (sortedPages[currentIndex + 1]?.path_name ?? null)
        : null;

    void (async () => {
      try {
        await this.client.rpc('increment_site_studio_page_visits', {
          p_page_id: page.id,
        });
      } catch {
        // Analytics failure must never break public page rendering.
      }
    })();

    return {
      funnel: publishedFunnel,
      page,
      formFields: (formFields ?? []) as Record<string, unknown>[],
      nextPagePath,
      allPages: sortedPages.map((p) => ({
        id: p.id,
        name: p.name,
        path_name: p.path_name,
      })),
    };
  }

  async listTasks(
    user: RequestUser | null | undefined,
    spaceId: string,
    rawMaxItems?: string,
    assignedToMe?: string,
    status?: string,
    rawPage?: string,
  ) {
    const maxItems = this.parseMaxItems(rawMaxItems);
    const page = rawPage ? Math.max(1, parseInt(rawPage, 10)) : 1;
    const ctx = await this.getPublicSpaceContext(spaceId);

    const filters: Record<string, unknown> = {
      space_id: spaceId,
      page,
      pageSize: maxItems,
    };

    // When the caller requests "my tasks" and a valid user token is present,
    // filter to tasks assigned to that user only.
    if (assignedToMe === 'true' && user?.userId) {
      filters.assigned_to = user.userId;
    }

    if (status) {
      filters.status = status;
    }

    const result = await this.tasksService.getAll(
      ctx.space.organization_id,
      filters as any,
    );

    const tasks = result.data.slice(0, maxItems);

    // Batch-fetch assignee display names — single query, no N+1
    const assigneeIds = [
      ...new Set(
        tasks.map((t) => (t as any).assigned_to).filter(Boolean) as string[],
      ),
    ];
    const assigneeMap: Record<string, string> = {};

    if (assigneeIds.length > 0) {
      const { data: users } = await this.client
        .from('users')
        .select('id, first_name, last_name, email')
        .in('id', assigneeIds);

      for (const u of users ?? []) {
        const row = u as {
          id: string;
          first_name: string | null;
          last_name: string | null;
          email: string;
        };

        assigneeMap[row.id] =
          [row.first_name, row.last_name].filter(Boolean).join(' ') ||
          row.email;
      }
    }

    return {
      data: tasks.map((t) => ({
        ...t,
        assignee_name: (t as any).assigned_to
          ? (assigneeMap[(t as any).assigned_to] ?? null)
          : null,
      })),
      count: result.total,
    };
  }

  /**
   * Classify a request host for the Next.js edge middleware: is it a published
   * Site Studio site (a verified custom domain OR a funnel sub_domain_name /
   * preview_subdomain), or something else (an org tenant subdomain)?
   *
   * Reuses the EXACT same resolver the published-page renderer uses
   * ({@link resolvePublishedFunnelId}) so the edge and the RSC render can never
   * disagree about whether a host is a site. Public + unauthenticated — it only
   * ever leaks "this host maps to a published funnel", never any content.
   */
  async resolveHost(
    rawHost: string,
  ): Promise<{ isSite: boolean; funnelId: string | null }> {
    const host = rawHost.trim().toLowerCase();

    if (!host) return { isSite: false, funnelId: null };

    const funnelId = await this.resolvePublishedFunnelId(host);

    return { isSite: funnelId !== null, funnelId };
  }

  private async resolvePublishedFunnelId(
    domain: string,
  ): Promise<string | null> {
    const { data: domainRow, error: domainError } = await this.client
      .from('site_studio_domains')
      .select('funnel_id')
      .eq('domain', domain)
      .eq('verified', true)
      .maybeSingle();

    if (domainError) throw new BadRequestException(domainError.message);

    if (domainRow) {
      return (domainRow as { funnel_id: string }).funnel_id;
    }

    const rawSubdomain = domain.split('.')[0]?.toLowerCase() ?? '';

    if (
      !/^[a-z0-9]$/.test(rawSubdomain) &&
      !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(rawSubdomain)
    ) {
      return null;
    }

    // `.maybeSingle()` THROWS when more than one row matches, and two rows legitimately
    // can: one funnel's `sub_domain_name` may equal another's generated
    // `preview_subdomain`. That turned a resolvable host into a 500. Take a
    // deterministic first row instead — ordering by `created_at` makes the winner
    // stable across replicas and restarts rather than whatever Postgres returns first.
    //
    // This path carries the on-prem path-based URL (https://<app-host>/<funnel-key>),
    // so it is now on the hot path for every published on-prem site, not just a
    // subdomain fallback.
    const { data: funnelRows, error: funnelError } = await this.client
      .from('site_studio_funnels')
      .select('id')
      .or(
        `sub_domain_name.eq.${rawSubdomain},preview_subdomain.eq.${rawSubdomain}`,
      )
      .order('created_at', { ascending: true })
      .limit(1);

    if (funnelError) throw new BadRequestException(funnelError.message);

    const funnelRow = (funnelRows ?? [])[0] as { id: string } | undefined;

    return funnelRow ? funnelRow.id : null;
  }

  /**
   * On-demand TLS gate for the on-prem edge (Caddy's `on_demand_tls { ask … }`).
   *
   * Caddy calls this before issuing a certificate for a hostname it has never seen and
   * proceeds only on a 2xx. Without such a gate, anyone who pointed a DNS record at the
   * server could make it request certificates on their behalf and exhaust the
   * deployment's Let's Encrypt rate limit — so this answers `true` ONLY for a hostname
   * that is a verified custom domain of a funnel that is actually published.
   *
   * Note this is deliberately stricter than {@link resolveHost}: that one also accepts
   * the `<funnel-key>.<app-domain>` shape, which is covered by the deployment's own
   * certificate and must never trigger an issuance of its own.
   */
  async isTlsIssuanceAllowed(rawHost: string): Promise<boolean> {
    const host = rawHost.trim().toLowerCase();

    if (!host || host.length > 253) return false;

    const { data, error } = await this.client
      .from('site_studio_domains')
      .select('funnel_id, site_studio_funnels!inner(published)')
      .eq('domain', host)
      .eq('verified', true)
      .eq('site_studio_funnels.published', true)
      .limit(1);

    if (error) {
      // Fail CLOSED. A database blip must not become a certificate-issuance loophole;
      // Caddy simply retries on the next request.
      this.logger.warn(
        `tls-ask lookup failed for "${host}": ${error.message} — denying issuance`,
      );

      return false;
    }

    return (data ?? []).length > 0;
  }

  private async resolvePublishedSitePage(
    funnelId: string,
    path: string,
  ): Promise<PublishedSitePage> {
    if (path) {
      const { data: page, error } = (await this.client
        .from('site_studio_pages')
        .select('*')
        .eq('funnel_id', funnelId)
        .eq('path_name', path)
        .maybeSingle()) as {
        data: PublishedSitePage | null;
        error: { message: string } | null;
      };

      if (error) throw new BadRequestException(error.message);
      if (!page) throw new NotFoundException('Page not found');

      return page;
    }

    const { data: landing, error: landingError } = (await this.client
      .from('site_studio_pages')
      .select('*')
      .eq('funnel_id', funnelId)
      .eq('path_name', '')
      .maybeSingle()) as {
      data: PublishedSitePage | null;
      error: { message: string } | null;
    };

    if (landingError) throw new BadRequestException(landingError.message);

    if (landing) return landing;

    const { data: fallback, error: fallbackError } = (await this.client
      .from('site_studio_pages')
      .select('*')
      .eq('funnel_id', funnelId)
      .order('sort_order', { ascending: true })
      .limit(1)
      .maybeSingle()) as {
      data: PublishedSitePage | null;
      error: { message: string } | null;
    };

    if (fallbackError) throw new BadRequestException(fallbackError.message);
    if (!fallback) throw new NotFoundException('Page not found');

    return fallback;
  }

  async listProcesses(
    user: RequestUser | null | undefined,
    spaceId: string,
    rawMaxItems?: string,
  ) {
    const maxItems = this.parseMaxItems(rawMaxItems);
    // Published elements are intentionally public; skip membership check regardless of auth state.
    const ctx = await this.getPublicSpaceContext(spaceId);
    const result = await this.processesService.getAll(
      ctx.space.organization_id,
      spaceId,
      { page: 1, pageSize: maxItems },
    );

    return { data: result.data.slice(0, maxItems), count: result.total };
  }

  async listWikiPages(
    user: RequestUser | null | undefined,
    spaceId: string,
    rawMaxItems?: string,
    rootOnly?: string,
    rootPageId?: string,
    rawLabelIds?: string,
    rawSearch?: string,
  ) {
    const maxItems = this.parseMaxItems(rawMaxItems);
    // Published elements are intentionally public; skip membership check regardless of auth state.
    const ctx = await this.getPublicSpaceContext(spaceId);
    const hasRoot = !!(rootPageId && UUID_RE.test(rootPageId));
    const search = (rawSearch ?? '').trim();
    const pagesResult = await this.wikiService.getPages(spaceId, {
      is_published: true,
      is_archived: false,
      ...(search ? { search } : {}),
      ...(!hasRoot && rootOnly === 'true' ? { parent_id: null } : {}),
      ...(hasRoot && rootOnly === 'true' ? { parent_id: rootPageId } : {}),
    });
    const pages = pagesResult.data as WikiPage[];
    let accessible = await this.filterAccessibleWikiPages(user, ctx, pages);

    // Descendants post-filter: rootPageId set + showRootOnly=false → keep only descendants via path array
    if (hasRoot && rootOnly !== 'true') {
      const { data: descRows } = await this.client
        .from('wiki_pages')
        .select('id')
        .eq('space_id', spaceId)
        .contains('path', [rootPageId]);

      const descendantIds = new Set(
        ((descRows ?? []) as Array<{ id: string }>).map((r) => r.id),
      );

      accessible = accessible.filter((p) => descendantIds.has(p.id));
    }

    // Label filter: any-match against wiki_page_labels junction table
    const labelIds = (rawLabelIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => UUID_RE.test(s));

    if (labelIds.length > 0) {
      const { data: labelRows } = await this.client
        .from('wiki_page_labels')
        .select('page_id')
        .in('label_id', labelIds);

      const allowedIds = new Set(
        ((labelRows ?? []) as Array<{ page_id: string }>).map((r) => r.page_id),
      );

      accessible = accessible.filter((p) => allowedIds.has(p.id));
    }

    const sliced = accessible.slice(0, maxItems);

    return {
      data: sliced.map((page) => ({
        id: page.id,
        title: page.title,
        slug: page.slug,
        level: page.level ?? 0,
        parent_id: page.parent_id ?? null,
        updated_at: page.updated_at ?? null,
      })),
      count: accessible.length,
    };
  }

  async getWikiPage(
    user: RequestUser | null | undefined,
    spaceId: string,
    pageId: string,
  ) {
    this.assertUuid(pageId, 'Valid pageId required');
    // Published elements are intentionally public; skip membership check regardless of auth state.
    const ctx = await this.getPublicSpaceContext(spaceId);
    const page = (await this.wikiService.getPageById(
      pageId,
      spaceId,
    )) as WikiPage;

    if (!page.is_published || page.is_archived) {
      throw new ForbiddenException('Access denied');
    }

    const [accessible] = await this.filterAccessibleWikiPages(user, ctx, [
      page,
    ]);

    if (!accessible) {
      throw new ForbiddenException('Access denied');
    }

    return {
      id: page.id,
      title: page.title,
      slug: page.slug,
      content: page.content ?? '',
      content_format: page.content_format ?? 'html',
      updated_at: page.updated_at ?? null,
      // Public: says Robert drafted it and nothing else. No staff names, no way to the conversation.
      ...((await this.origins?.isDraftedByRobert(page.organization_id as string, 'wiki_page', pageId)) && {
        drafted_by_robert: true,
      }),
    };
  }

  /**
   * Resolves a live macro from a stored, publicly accessible TipTap page.
   *
   * The ordinal is an index into the document's supported macro nodes, not a
   * query language: all macro attributes and every returned target originate
   * from the stored page and pass the same public wiki access checks as the
   * page itself. This keeps the public endpoint from becoming an arbitrary
   * wiki search or attachment browser.
   */
  async resolvePublicWikiMacro(
    user: RequestUser | null | undefined,
    spaceId: string,
    pageId: string,
    rawOrdinal: string | number,
  ): Promise<PublicWikiMacro> {
    const ordinal = this.parseMacroOrdinal(rawOrdinal);
    const source = await this.getWikiPage(user, spaceId, pageId);

    if (
      source.content_format !== 'tiptap' ||
      typeof source.content !== 'string'
    ) {
      throw new BadRequestException(
        'Published page does not contain TipTap content',
      );
    }

    let document: TipTapNode;
    try {
      document = JSON.parse(source.content) as TipTapNode;
    } catch {
      throw new BadRequestException(
        'Published page contains invalid TipTap content',
      );
    }

    if (document.type !== 'doc' || !Array.isArray(document.content)) {
      throw new BadRequestException(
        'Published page contains invalid TipTap content',
      );
    }

    const macro = this.collectPublicWikiMacros(document)[ordinal];
    if (!macro) throw new NotFoundException('Published macro not found');

    if (macro.type === 'pageTree') {
      return this.resolvePublicPageTree(
        user,
        spaceId,
        source.id,
        macro.attrs,
        ordinal,
      );
    }

    if (macro.type === 'attachmentsList') {
      return this.resolvePublicAttachments(source.id, ordinal);
    }

    if (macro.type === 'gallery') {
      return this.resolvePublicGallery(source.id, macro.attrs, ordinal);
    }

    if (macro.type === 'includePage' || macro.type === 'excerptInclude') {
      return {
        ...(await this.resolvePublicInclude(
          user,
          spaceId,
          macro,
          new Set([source.id]),
          1,
        )),
        ordinal,
      };
    }

    if (macro.type === 'spaceDetails') {
      return this.resolvePublicSpaceDetails(spaceId, macro.attrs, ordinal);
    }

    if (macro.type === 'changeHistory') {
      return this.resolvePublicChangeHistory(source.id, macro.attrs, ordinal);
    }

    if (macro.type === 'contentPropertiesReport') {
      return this.resolvePublicContentPropertiesReport(
        user,
        spaceId,
        macro,
        ordinal,
      );
    }

    if (
      macro.type === 'recentlyUsedLabels' ||
      macro.type === 'relatedLabels' ||
      macro.type === 'recentlyUpdatedDashboard' ||
      macro.type === 'contentReportTable' ||
      macro.type === 'navigationMap' ||
      macro.type === 'contentByLabel' ||
      macro.type === 'popularLabels'
    ) {
      return this.resolvePublicTaxonomyReport(
        user,
        spaceId,
        source.id,
        macro,
        ordinal,
      );
    }

    return this.resolvePublicRecentlyUpdated(
      user,
      spaceId,
      macro.attrs,
      ordinal,
    );
  }

  private parseMacroOrdinal(rawOrdinal: string | number): number {
    const ordinal =
      typeof rawOrdinal === 'number'
        ? rawOrdinal
        : /^\d+$/.test(rawOrdinal)
          ? Number(rawOrdinal)
          : NaN;

    if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new BadRequestException('Valid macro ordinal required');
    }

    return ordinal;
  }

  private collectPublicWikiMacros(node: TipTapNode): TipTapNode[] {
    const macros: TipTapNode[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const current = value as TipTapNode;
      if (
        typeof current.type === 'string' &&
        PUBLIC_WIKI_MACRO_KINDS.has(current.type)
      ) {
        macros.push(current);
      }
      if (Array.isArray(current.content)) current.content.forEach(visit);
    };

    visit(node);
    return macros;
  }

  private includeDiagnostic(
    macro: TipTapNode,
    code: PublicIncludeDiagnostic['code'],
    message: string,
  ): PublicIncludeResolution {
    const attrs = this.objectAttrs(macro.attrs);

    return {
      kind: macro.type === 'excerptInclude' ? 'excerptInclude' : 'includePage',
      attrs: {
        pageId: typeof attrs.pageId === 'string' ? attrs.pageId : '',
        title: typeof attrs.title === 'string' ? attrs.title : 'Included page',
        ...(typeof attrs.targetSpaceId === 'string'
          ? { targetSpaceId: attrs.targetSpaceId }
          : {}),
        ...(typeof attrs.targetSpaceKey === 'string'
          ? { targetSpaceKey: attrs.targetSpaceKey }
          : {}),
        ...(typeof attrs.excerptName === 'string' && attrs.excerptName
          ? { excerptName: attrs.excerptName }
          : {}),
        ...(macro.type === 'excerptInclude'
          ? { nopanel: attrs.nopanel === true }
          : {}),
      },
      diagnostic: { code, message },
    };
  }

  private async resolvePublicInclude(
    user: RequestUser | null | undefined,
    spaceId: string,
    macro: TipTapNode,
    ancestors: Set<string>,
    depth: number,
  ): Promise<PublicIncludeResolution> {
    const attrs = this.objectAttrs(macro.attrs);
    const pageId = typeof attrs.pageId === 'string' ? attrs.pageId : '';
    const title =
      typeof attrs.title === 'string' ? attrs.title : 'Included page';

    if (!UUID_RE.test(pageId)) {
      return this.includeDiagnostic(
        macro,
        'malformed',
        'The stored include target is invalid.',
      );
    }
    if (ancestors.has(pageId)) {
      return this.includeDiagnostic(
        macro,
        'cycle',
        'This include was stopped because it creates a cycle.',
      );
    }
    if (depth > 5) {
      return this.includeDiagnostic(
        macro,
        'max_depth',
        'Nested includes stop after five levels.',
      );
    }

    let targetSpaceId =
      typeof attrs.targetSpaceId === 'string' &&
      UUID_RE.test(attrs.targetSpaceId)
        ? attrs.targetSpaceId
        : spaceId;
    let target: Awaited<ReturnType<PublicSiteStudioService['getWikiPage']>>;
    try {
      target = await this.getWikiPage(user, targetSpaceId, pageId);
    } catch {
      try {
        const ctx = await this.getPublicSpaceContext(spaceId);
        const { data } = await this.client
          .from('wiki_pages')
          .select('space_id')
          .eq('id', pageId)
          .eq('organization_id', ctx.space.organization_id)
          .maybeSingle();
        const derivedSpaceId = (data as { space_id?: unknown } | null)
          ?.space_id;
        if (
          typeof derivedSpaceId !== 'string' ||
          derivedSpaceId === targetSpaceId
        ) {
          throw new Error('target unavailable');
        }
        targetSpaceId = derivedSpaceId;
        target = await this.getWikiPage(user, targetSpaceId, pageId);
      } catch {
        return this.includeDiagnostic(
          macro,
          'inaccessible',
          'The included content is unavailable or not public.',
        );
      }
    }

    let targetSpaceKey =
      typeof attrs.targetSpaceKey === 'string' ? attrs.targetSpaceKey : '';
    try {
      const targetSpace = await this.getPublicSpaceContext(targetSpaceId);
      if (typeof targetSpace.space.key === 'string' && targetSpace.space.key) {
        targetSpaceKey = targetSpace.space.key;
      }
    } catch {
      // getWikiPage already enforced target access; a missing display key must not broaden access.
    }

    const document =
      target.content_format === 'tiptap'
        ? this.parseStoredTipTap(target.content)
        : null;
    if (!document) {
      return this.includeDiagnostic(
        macro,
        'malformed',
        'The included content cannot be rendered.',
      );
    }

    let content = document;
    if (macro.type === 'excerptInclude') {
      const excerptName =
        typeof attrs.excerptName === 'string' ? attrs.excerptName : '';
      const excerpt = this.findPublicExcerpt(document, excerptName);
      if (!excerpt) {
        return this.includeDiagnostic(
          macro,
          'missing_excerpt',
          'The selected excerpt no longer exists.',
        );
      }
      content = {
        type: 'doc',
        content: Array.isArray(excerpt.content) ? excerpt.content : [],
      };
    }

    const nextAncestors = new Set([...ancestors, pageId]);
    const resolutions: Record<string, PublicIncludeResolution> = {};
    const nested = this.collectPublicWikiMacros(content);
    await Promise.all(
      nested.map(async (candidate, ordinal) => {
        if (
          candidate.type !== 'includePage' &&
          candidate.type !== 'excerptInclude'
        ) {
          return;
        }
        resolutions[String(ordinal)] = await this.resolvePublicInclude(
          user,
          targetSpaceId,
          candidate,
          nextAncestors,
          depth + 1,
        );
      }),
    );

    return {
      kind: macro.type === 'excerptInclude' ? 'excerptInclude' : 'includePage',
      attrs: {
        pageId,
        title,
        targetSpaceId,
        ...(targetSpaceKey ? { targetSpaceKey } : {}),
        ...(typeof attrs.excerptName === 'string' && attrs.excerptName
          ? { excerptName: attrs.excerptName }
          : {}),
        ...(macro.type === 'excerptInclude'
          ? { nopanel: attrs.nopanel === true }
          : {}),
      },
      data: {
        pageId,
        title: target.title ?? title,
        targetSpaceId,
        ...(targetSpaceKey ? { targetSpaceKey } : {}),
        content,
        resolutions,
      },
    };
  }

  private parseStoredTipTap(raw: unknown): TipTapNode | null {
    if (typeof raw !== 'string') return null;
    try {
      const parsed = JSON.parse(raw) as TipTapNode;
      return parsed.type === 'doc' && Array.isArray(parsed.content)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  private findPublicExcerpt(
    document: TipTapNode,
    name: string,
  ): TipTapNode | null {
    let first: TipTapNode | null = null;
    let named: TipTapNode | null = null;
    const visit = (value: unknown): void => {
      if (
        named ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value)
      ) {
        return;
      }
      const node = value as TipTapNode;
      if (node.type === 'excerpt') {
        first ??= node;
        const attrs = this.objectAttrs(node.attrs);
        if (name && attrs.name === name) named = node;
      }
      if (Array.isArray(node.content)) node.content.forEach(visit);
    };
    visit(document);

    return name ? named : first;
  }

  private async resolvePublicPageTree(
    user: RequestUser | null | undefined,
    spaceId: string,
    sourcePageId: string,
    rawAttrs: unknown,
    ordinal: number,
  ): Promise<Extract<PublicWikiMacro, { kind: 'pageTree' }>> {
    const attrs = this.objectAttrs(rawAttrs);
    const rootPageId =
      typeof attrs.rootPageId === 'string' && UUID_RE.test(attrs.rootPageId)
        ? attrs.rootPageId
        : sourcePageId;
    const depth = this.boundedStoredNumber(attrs.depth, 1, 10, 2);

    // A stored root outside the source page is a separate target and must pass
    // public publication and ACL checks before its descendants are disclosed.
    if (rootPageId !== sourcePageId) {
      await this.getWikiPage(user, spaceId, rootPageId);
    }

    const ctx = await this.getPublicSpaceContext(spaceId);
    const result = await this.wikiService.getPages(spaceId, {
      is_published: true,
      is_archived: false,
    });
    const pages = await this.filterAccessibleWikiPages(
      user,
      ctx,
      this.publishedWikiPages(result.data as WikiPage[]),
    );
    const byParent = new Map<string, WikiPage[]>();
    for (const page of pages) {
      if (!page.parent_id) continue;
      const children = byParent.get(page.parent_id) ?? [];
      children.push(page);
      byParent.set(page.parent_id, children);
    }

    const build = (
      parentId: string,
      remaining: number,
    ): Array<{
      id: string;
      title: string | undefined;
      slug: string | undefined;
      parentId: string | null;
      children: unknown[];
    }> =>
      (byParent.get(parentId) ?? []).map((page) => ({
        id: page.id,
        title: page.title,
        slug: page.slug,
        parentId: page.parent_id ?? null,
        children: remaining > 1 ? build(page.id, remaining - 1) : [],
      }));

    return {
      kind: 'pageTree',
      ordinal,
      attrs: { rootPageId, depth },
      data: build(rootPageId, depth),
    };
  }

  private async resolvePublicAttachments(
    sourcePageId: string,
    ordinal: number,
  ): Promise<Extract<PublicWikiMacro, { kind: 'attachmentsList' }>> {
    const { data, error } = await this.client
      .from('wiki_page_attachments')
      .select('id, file_name, file_path, file_size, file_type, created_at')
      .eq('wiki_page_id', sourcePageId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    const attachments = ((data ?? []) as Array<Record<string, unknown>>)
      .filter((attachment) =>
        this.isPublicWikiAttachmentUrl(attachment.file_path),
      )
      .map((attachment) => ({
        id: String(attachment.id),
        name:
          typeof attachment.file_name === 'string'
            ? attachment.file_name
            : 'file',
        url: String(attachment.file_path),
        size:
          typeof attachment.file_size === 'number'
            ? attachment.file_size
            : null,
        mimeType:
          typeof attachment.file_type === 'string'
            ? attachment.file_type
            : null,
        createdAt:
          typeof attachment.created_at === 'string'
            ? attachment.created_at
            : null,
      }));

    return {
      kind: 'attachmentsList',
      ordinal,
      attrs: { pageId: sourcePageId },
      data: attachments,
    };
  }

  private async resolvePublicGallery(
    sourcePageId: string,
    rawAttrs: unknown,
    ordinal: number,
  ): Promise<Extract<PublicWikiMacro, { kind: 'gallery' }>> {
    const attrs = this.objectAttrs(rawAttrs);
    const columns = this.boundedStoredNumber(attrs.columns, 1, 8, 4);
    const captions = attrs.captions !== false;
    const title =
      typeof attrs.title === 'string' && attrs.title.trim()
        ? attrs.title.trim()
        : null;

    const attachments = await this.resolvePublicAttachments(
      sourcePageId,
      ordinal,
    );

    return {
      kind: 'gallery',
      ordinal,
      attrs: {
        pageId: sourcePageId,
        columns,
        captions,
        ...(title ? { title } : {}),
      },
      data: attachments.data,
    };
  }

  private async resolvePublicRecentlyUpdated(
    user: RequestUser | null | undefined,
    spaceId: string,
    rawAttrs: unknown,
    ordinal: number,
  ): Promise<Extract<PublicWikiMacro, { kind: 'recentlyUpdated' }>> {
    const attrs = this.objectAttrs(rawAttrs);
    const limit = this.boundedStoredNumber(attrs.limit, 1, 50, 10);
    const types = Array.isArray(attrs.types)
      ? attrs.types.filter((type): type is string => typeof type === 'string')
      : [];
    const hideHeading = attrs.hideHeading === true;
    // XISUITE has no blog or comment content model. A stored filter that does
    // not ask for pages must stay empty instead of broadening to every page.
    if (types.some((type) => type !== 'page')) {
      return {
        kind: 'recentlyUpdated',
        ordinal,
        attrs: { limit, hideHeading, types },
        data: [],
      };
    }
    const ctx = await this.getPublicSpaceContext(spaceId);
    const result = await this.wikiService.getPages(spaceId, {
      is_published: true,
      is_archived: false,
    });
    const pages = await this.filterAccessibleWikiPages(
      user,
      ctx,
      this.publishedWikiPages(result.data as WikiPage[]),
    );

    return {
      kind: 'recentlyUpdated',
      ordinal,
      attrs: { limit, hideHeading, types },
      data: [...pages]
        .sort(
          (left, right) =>
            Date.parse(right.updated_at ?? '') -
            Date.parse(left.updated_at ?? ''),
        )
        .slice(0, limit)
        .map((page) => ({
          id: page.id,
          title: page.title,
          slug: page.slug,
          updatedAt: page.updated_at ?? null,
        })),
    };
  }

  private async resolvePublicSpaceDetails(
    spaceId: string,
    rawAttrs: unknown,
    ordinal: number,
  ): Promise<Extract<PublicWikiMacro, { kind: 'spaceDetails' }>> {
    const attrs = this.objectAttrs(rawAttrs);
    const ctx = await this.getPublicSpaceContext(spaceId);
    const space = ctx.space;

    return {
      kind: 'spaceDetails',
      ordinal,
      attrs: {
        ...(typeof attrs.width === 'string'
          ? { width: attrs.width.slice(0, 50) }
          : {}),
      },
      data: {
        id: space.id,
        key: typeof space.key === 'string' ? space.key : '',
        name: typeof space.name === 'string' ? space.name : 'Space',
        description:
          typeof space.description === 'string' ? space.description : null,
        icon:
          typeof space.icon_url === 'string'
            ? space.icon_url
            : typeof space.icon === 'string'
              ? space.icon
              : null,
      },
    };
  }

  private async resolvePublicChangeHistory(
    sourcePageId: string,
    rawAttrs: unknown,
    ordinal: number,
  ): Promise<PublicWikiMacro> {
    const attrs = this.objectAttrs(rawAttrs);
    const limit = this.boundedStoredNumber(attrs.limit, 1, 100, 20);
    const { data, error } = await this.client
      .from('wiki_page_versions')
      .select('version,created_at,changes')
      .eq('wiki_page_id', sourcePageId)
      .order('version', { ascending: false })
      .limit(limit);

    if (error) throw new BadRequestException(error.message);

    return {
      kind: 'changeHistory',
      ordinal,
      attrs: { limit },
      data: ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
        return {
          version:
            typeof row.version === 'number' || typeof row.version === 'string'
              ? row.version
              : '',
          author: null,
          createdAt: typeof row.created_at === 'string' ? row.created_at : null,
          comment: null,
        };
      }),
    };
  }

  private async resolvePublicContentPropertiesReport(
    user: RequestUser | null | undefined,
    spaceId: string,
    macro: TipTapNode,
    ordinal: number,
  ): Promise<PublicWikiMacro> {
    const attrs = this.objectAttrs(macro.attrs);
    const labels = this.storedPublicLabels([attrs.label], 1);
    const columns = this.storedPublicLabels(attrs.columns, 100);
    const limit = this.boundedStoredNumber(attrs.limit, 1, 30, 30);
    const propertyId =
      typeof attrs.propertyId === 'string'
        ? attrs.propertyId.trim().slice(0, 255)
        : '';
    const titleColumn =
      typeof attrs.titleColumn === 'string'
        ? attrs.titleColumn.slice(0, 100)
        : 'Title';
    const sortBy = attrs.sortBy === 'modified' ? 'modified' : null;
    const resultAttrs = {
      label: labels?.[0] ?? '',
      propertyId,
      columns: columns ?? [],
      titleColumn,
      ...(sortBy ? { sortBy } : {}),
      limit,
    };

    if (!labels?.length || columns === null) {
      return {
        kind: 'contentPropertiesReport',
        ordinal,
        attrs: resultAttrs,
        data: [],
      };
    }

    const ctx = await this.getPublicSpaceContext(spaceId);
    const pageResult = await this.wikiService.getPages(spaceId, {
      is_published: true,
      is_archived: false,
      limit: 500,
    });
    const pages = await this.filterAccessibleWikiPages(
      user,
      ctx,
      this.publishedWikiPages(pageResult.data as WikiPage[]),
    );
    const assignments = await this.publicPageLabels(
      pages.map((page) => page.id),
    );
    const selected = new Set(labels.map((label) => label.toLowerCase()));
    const matching = pages.filter((page) =>
      this.publicPageHasLabel(assignments[page.id] ?? [], selected),
    );
    matching.sort((left, right) =>
      sortBy === 'modified'
        ? Date.parse(right.updated_at ?? '') - Date.parse(left.updated_at ?? '')
        : String(left.title ?? '').localeCompare(String(right.title ?? '')),
    );

    return {
      kind: 'contentPropertiesReport',
      ordinal,
      attrs: resultAttrs,
      data: matching.slice(0, limit).flatMap((page) => {
        const properties = this.publicContentProperties(
          page.content,
          propertyId,
        );
        return Object.keys(properties).length
          ? [
              {
                id: page.id,
                title: page.title,
                properties,
              },
            ]
          : [];
      }),
    };
  }

  private publicContentProperties(
    rawContent: unknown,
    propertyId: string,
  ): Record<string, string | null> {
    const document = this.parseStoredTipTap(rawContent);
    if (!document) return {};
    const values: Record<string, string | null> = {};
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const node = value as TipTapNode;
      if (node.type === 'contentProperties') {
        const attrs = this.objectAttrs(node.attrs);
        if (
          attrs.hidden !== true &&
          (!propertyId || attrs.propertyId === propertyId)
        ) {
          for (const row of Array.isArray(attrs.rows) ? attrs.rows : []) {
            const record = this.objectAttrs(row);
            const key =
              typeof record.key === 'string'
                ? record.key.trim().slice(0, 500)
                : '';
            if (!key) continue;
            values[key] =
              typeof record.value === 'string'
                ? record.value.slice(0, 5000)
                : null;
          }
        }
      }
      if (Array.isArray(node.content)) node.content.forEach(visit);
    };
    visit(document);
    return values;
  }

  private async resolvePublicTaxonomyReport(
    user: RequestUser | null | undefined,
    spaceId: string,
    sourcePageId: string,
    macro: TipTapNode,
    ordinal: number,
  ): Promise<PublicWikiMacro> {
    const kind = macro.type as
      | 'recentlyUsedLabels'
      | 'relatedLabels'
      | 'recentlyUpdatedDashboard'
      | 'contentReportTable'
      | 'navigationMap'
      | 'contentByLabel'
      | 'popularLabels';
    const attrs = this.objectAttrs(macro.attrs);
    const limit = this.boundedStoredNumber(
      kind === 'recentlyUsedLabels' || kind === 'popularLabels'
        ? attrs.count
        : attrs.limit,
      1,
      kind === 'navigationMap'
        ? 60
        : kind === 'recentlyUpdatedDashboard'
          ? 50
          : 100,
      kind === 'recentlyUsedLabels' ? 10 : kind === 'navigationMap' ? 60 : 20,
    );
    const labels = this.storedPublicLabels(attrs.labels, 20);
    const spaceKeys = this.storedPublicLabels(attrs.spaceKeys, 20);
    const types = this.storedPublicLabels(attrs.types, 10);
    const users = this.storedPublicLabels(attrs.users, 20);
    const singleLabel =
      kind === 'navigationMap'
        ? this.storedPublicLabels([attrs.label], 1)
        : labels;
    const resultAttrs: Record<string, unknown> = { limit };

    if (
      labels === null ||
      spaceKeys === null ||
      types === null ||
      users === null ||
      singleLabel === null
    ) {
      return { kind, ordinal, attrs: resultAttrs, data: [] };
    }
    if (kind === 'recentlyUsedLabels') {
      const scope = typeof attrs.scope === 'string' ? attrs.scope : 'global';
      const style = attrs.style === 'table' ? 'table' : 'list';
      Object.assign(resultAttrs, { scope, style, count: limit });
      if (scope !== 'space')
        return { kind, ordinal, attrs: resultAttrs, data: [] };
    }
    if (kind === 'recentlyUpdatedDashboard') {
      Object.assign(resultAttrs, {
        labels,
        spaceKeys,
        types,
        showProfilePic: false,
      });
      if (types.some((type) => type !== 'page') || users.length > 0) {
        return { kind, ordinal, attrs: resultAttrs, data: [] };
      }
    }
    if (kind === 'contentReportTable') {
      Object.assign(resultAttrs, { labels, spaceKeys });
      if (!labels.length)
        return { kind, ordinal, attrs: resultAttrs, data: [] };
    }
    if (kind === 'contentByLabel') {
      Object.assign(resultAttrs, { labels, spaceKeys, types });
      if (!labels.length || types.some((type) => type !== 'page')) {
        return { kind, ordinal, attrs: resultAttrs, data: [] };
      }
    }
    if (kind === 'popularLabels') {
      Object.assign(resultAttrs, {
        count: limit,
        style: attrs.style === 'heatmap' ? 'heatmap' : 'list',
      });
    }
    if (kind === 'navigationMap') {
      const label = singleLabel[0] ?? '';
      Object.assign(resultAttrs, {
        label,
        title: typeof attrs.title === 'string' ? attrs.title.slice(0, 200) : '',
        wrapAfter: this.boundedStoredNumber(attrs.wrapAfter, 1, 8, 5),
        cellWidth:
          typeof attrs.cellWidth === 'string' &&
          /^(?:[1-9]\d?|100)%$|^(?:1[2-9]\d|[2-4]\d{2})px$/.test(
            attrs.cellWidth,
          )
            ? attrs.cellWidth
            : '90%',
      });
      if (!label) return { kind, ordinal, attrs: resultAttrs, data: [] };
    }

    const ctx = await this.getPublicSpaceContext(spaceId);
    if (
      spaceKeys.length > 0 &&
      spaceKeys.some(
        (key) =>
          !['@self', 'current'].includes(key.toLowerCase()) &&
          key.toLowerCase() !== String(ctx.space.key ?? '').toLowerCase(),
      )
    ) {
      return { kind, ordinal, attrs: resultAttrs, data: [] };
    }
    const pageResult = await this.wikiService.getPages(spaceId, {
      is_published: true,
      is_archived: false,
      limit: 500,
    });
    const pages = await this.filterAccessibleWikiPages(
      user,
      ctx,
      this.publishedWikiPages(pageResult.data as WikiPage[]),
    );
    const assignments = await this.publicPageLabels(
      pages.map((page) => page.id),
    );

    let effectiveLabels = singleLabel;
    if (kind === 'relatedLabels' && effectiveLabels.length === 0) {
      effectiveLabels = this.publicAssignmentNames(
        assignments[sourcePageId] ?? [],
      );
      Object.assign(resultAttrs, { labels: effectiveLabels });
    }
    if (kind === 'relatedLabels') {
      if (!effectiveLabels.length)
        return { kind, ordinal, attrs: resultAttrs, data: [] };
      const seeds = new Set(
        effectiveLabels.map((label) => label.toLowerCase()),
      );
      const counts = new Map<
        string,
        { name: string; color: string | null; count: number }
      >();
      for (const page of pages) {
        const pageLabels = assignments[page.id] ?? [];
        if (!this.publicPageHasLabel(pageLabels, seeds)) continue;
        for (const assignment of pageLabels) {
          const name = assignment.label?.name?.trim();
          const key = name?.toLowerCase();
          if (!name || !key || seeds.has(key)) continue;
          const current = counts.get(key);
          counts.set(key, {
            name,
            color: assignment.label?.color ?? current?.color ?? null,
            count: (current?.count ?? 0) + 1,
          });
        }
      }
      return {
        kind,
        ordinal,
        attrs: resultAttrs,
        data: [...counts.values()]
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
          .slice(0, limit),
      };
    }
    if (kind === 'recentlyUsedLabels') {
      const stats = new Map<
        string,
        {
          name: string;
          color: string | null;
          count: number;
          lastUsedAt: number;
        }
      >();
      for (const page of pages) {
        for (const assignment of assignments[page.id] ?? []) {
          const name = assignment.label?.name?.trim();
          const key = name?.toLowerCase();
          if (!name || !key) continue;
          const current = stats.get(key);
          const assignedAt = Date.parse(assignment.assigned_at ?? '');
          const updatedAt = Date.parse(page.updated_at ?? '');
          stats.set(key, {
            name,
            color: assignment.label?.color ?? current?.color ?? null,
            count: (current?.count ?? 0) + 1,
            lastUsedAt: Math.max(
              current?.lastUsedAt ?? 0,
              Number.isFinite(assignedAt) ? assignedAt : 0,
              Number.isFinite(updatedAt) ? updatedAt : 0,
            ),
          });
        }
      }
      return {
        kind,
        ordinal,
        attrs: resultAttrs,
        data: [...stats.values()]
          .sort(
            (a, b) =>
              b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name),
          )
          .slice(0, limit),
      };
    }
    if (kind === 'popularLabels') {
      const counts = new Map<
        string,
        { name: string; color: string | null; count: number }
      >();
      for (const page of pages) {
        for (const assignment of assignments[page.id] ?? []) {
          const name = assignment.label?.name?.trim();
          const key = name?.toLowerCase();
          if (!name || !key) continue;
          const current = counts.get(key);
          counts.set(key, {
            name,
            color: assignment.label?.color ?? current?.color ?? null,
            count: (current?.count ?? 0) + 1,
          });
        }
      }
      return {
        kind,
        ordinal,
        attrs: resultAttrs,
        data: [...counts.values()]
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
          .slice(0, limit),
      };
    }

    const selected = new Set(singleLabel.map((label) => label.toLowerCase()));
    const rows = pages
      .filter(
        (page) =>
          selected.size === 0 ||
          this.publicPageHasLabel(assignments[page.id] ?? [], selected),
      )
      .sort(
        (a, b) =>
          Date.parse(b.updated_at ?? '') - Date.parse(a.updated_at ?? ''),
      )
      .slice(0, limit)
      .map((page) => ({
        id: page.id,
        title: page.title,
        slug: page.slug,
        updatedAt: page.updated_at ?? null,
        ...(kind === 'contentByLabel'
          ? {
              labels: this.publicAssignmentNames(assignments[page.id] ?? []),
              sourceScope: 'current space',
            }
          : {}),
      }));
    return { kind, ordinal, attrs: resultAttrs, data: rows };
  }

  private storedPublicLabels(value: unknown, maximum: number): string[] | null {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > maximum) return null;
    const labels = value.map((item) =>
      typeof item === 'string' ? item.trim() : '',
    );
    if (
      labels.some(
        (label) =>
          !label ||
          label.length > 100 ||
          [...label].some((char) => char.charCodeAt(0) < 32),
      )
    ) {
      return null;
    }
    return [
      ...new Map(labels.map((label) => [label.toLowerCase(), label])).values(),
    ];
  }

  private async publicPageLabels(pageIds: string[]): Promise<
    Record<
      string,
      Array<{
        assigned_at: string | null;
        label?: { name?: string; color?: string | null } | null;
      }>
    >
  > {
    if (!pageIds.length) return {};
    const { data, error } = await this.client
      .from('wiki_page_labels')
      .select('page_id,assigned_at,label:wiki_labels(id,name,color)')
      .in('page_id', pageIds.slice(0, 500));
    if (error) throw new BadRequestException(error.message);
    const result: Record<
      string,
      Array<{
        assigned_at: string | null;
        label?: { name?: string; color?: string | null } | null;
      }>
    > = {};
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const pageId = typeof row.page_id === 'string' ? row.page_id : '';
      if (!pageId || !pageIds.includes(pageId)) continue;
      result[pageId] = [
        ...(result[pageId] ?? []),
        {
          assigned_at:
            typeof row.assigned_at === 'string' ? row.assigned_at : null,
          label:
            row.label &&
            typeof row.label === 'object' &&
            !Array.isArray(row.label)
              ? (row.label as { name?: string; color?: string | null })
              : null,
        },
      ];
    }
    return result;
  }

  private publicAssignmentNames(
    assignments: Array<{ label?: { name?: string } | null }>,
  ): string[] {
    return assignments.flatMap((assignment) => {
      const name = assignment.label?.name?.trim();
      return name ? [name] : [];
    });
  }

  private publicPageHasLabel(
    assignments: Array<{ label?: { name?: string } | null }>,
    labels: Set<string>,
  ): boolean {
    return assignments.some((assignment) => {
      const name = assignment.label?.name?.trim().toLowerCase();
      return !!name && labels.has(name);
    });
  }

  private objectAttrs(rawAttrs: unknown): Record<string, unknown> {
    return rawAttrs && typeof rawAttrs === 'object' && !Array.isArray(rawAttrs)
      ? (rawAttrs as Record<string, unknown>)
      : {};
  }

  private publishedWikiPages(pages: WikiPage[]): WikiPage[] {
    return pages.filter(
      (page) => page.is_published === true && page.is_archived !== true,
    );
  }

  private boundedStoredNumber(
    value: unknown,
    minimum: number,
    maximum: number,
    fallback: number,
  ): number {
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= minimum &&
      value <= maximum
      ? value
      : fallback;
  }

  private isPublicWikiAttachmentUrl(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const publicPath = '/storage/v1/object/public/wiki-attachments/';
    if (value.startsWith(publicPath)) return true;

    try {
      const url = new URL(value);
      const storageOrigin = new URL(process.env.SUPABASE_URL ?? '').origin;
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.origin === storageOrigin &&
        url.pathname.startsWith(publicPath)
      );
    } catch {
      return false;
    }
  }

  /**
   * Resolve a label-backed File Explorer widget on a published page.
   *
   * AUTHORISATION comes from the page→element binding and nothing else:
   * the published page is loaded for `domain`+`path`, the element is located by
   * `elementId` inside its stored `content`, and the space + label ids are read
   * from THAT STORED ELEMENT. A space id or label id supplied by the caller is
   * never accepted, and {@link getPublicSpaceContext} is deliberately not used —
   * it would grant `viewer` on any space whose UUID a caller happens to know.
   *
   * Only `fileLink` / `fileList` / `folderLink` elements whose stored
   * `sourceMode` is `'label'` resolve; anything else yields an empty list.
   * This endpoint mints nothing: files are downloaded through
   * `GET /public/site-studio/files/download`, which re-resolves this same label
   * set, so a file no longer needs a pre-existing share to be listed.
   *
   * @param domain Host the published page is served on.
   * @param rawPath Page path (empty for the landing page).
   * @param elementId Element id inside the page's stored content tree.
   * @returns `{ data, count, truncated }` — metadata per row.
   */
  async listFilesForElement(
    domain: string,
    rawPath: string,
    elementId: string,
  ): Promise<{ data: PublicFileItem[]; count: number; truncated: boolean }> {
    const { nodes, organizationId, truncated } =
      await this.resolveLabelElementNodes(domain, rawPath, elementId);

    if (nodes.length === 0) {
      return { data: [], count: 0, truncated };
    }

    const tokenByNodeId = await this.activeLinkShareTokens(
      nodes.map((node) => node.id),
      organizationId,
    );
    const items: PublicFileItem[] = [];

    for (const node of nodes) {
      const token = tokenByNodeId.get(node.id);

      // A FOLDER is only openable through its own share (…/:token/contents), so
      // without one there is nothing to link to and it stays hidden. A FILE is
      // always listed — the page-bound download route serves it without a token.
      if (!token && node.node_type !== 'file') continue;

      items.push({
        nodeId: node.id,
        name: node.name,
        nodeType: node.node_type,
        mimeType: node.mime_type ?? null,
        fileSize: node.file_size ?? null,
        ...(token ? { token } : {}),
      });
    }

    return {
      data: items.slice(0, PUBLIC_FILE_LIST_CAP),
      count: items.length,
      truncated: truncated || items.length > PUBLIC_FILE_LIST_CAP,
    };
  }

  /**
   * Signed download URL for ONE file of a label-backed widget.
   *
   * Authorisation is identical to {@link listFilesForElement} — the element is
   * re-resolved from the page→element binding on every call and `nodeId` is
   * honoured ONLY when it is present in that freshly resolved label set. A node
   * id on its own proves nothing, so an id from another space, another label, or
   * a since-unlabelled file is a 404. Untrashing/relabelling therefore takes
   * effect immediately, exactly as it does for the list.
   *
   * @param nodeId File to download; must be in the element's own label set.
   * @returns Short-TTL signed URL carrying `Content-Disposition: attachment`.
   */
  async getElementFileDownloadUrl(
    domain: string,
    rawPath: string,
    elementId: string,
    nodeId: string,
  ): Promise<string> {
    const { nodes } = await this.resolveLabelElementNodes(
      domain,
      rawPath,
      elementId,
    );
    const node = nodes.find((candidate) => candidate.id === nodeId);

    // Folders are excluded on purpose: zipping a subtree is the token flow's job
    // (`GET /public/file-explorer/:token/download`), not this route's.
    if (!node || node.node_type !== 'file') {
      throw new NotFoundException('File not found for this element');
    }

    const version = await this.fileExplorerRepo.resolveVersion(node);

    return this.fileExplorerStorage.signedDownloadUrl(
      version.file_path,
      node.name,
    );
  }

  /**
   * Resolve a published page's label-backed file widget to its node set.
   *
   * The single source of truth for BOTH `listFilesForElement` and
   * `getElementFileDownloadUrl`, so the list and the download can never disagree
   * about which nodes an anonymous visitor may see.
   */
  private async resolveLabelElementNodes(
    domain: string,
    rawPath: string,
    elementId: string,
  ): Promise<ResolvedLabelElement> {
    const normalizedDomain = domain.trim().toLowerCase();

    if (!normalizedDomain) throw new BadRequestException('domain is required');

    this.assertUuid(elementId, 'Valid elementId required');

    const funnelId = await this.resolvePublishedFunnelId(normalizedDomain);

    if (!funnelId) throw new NotFoundException('Page not found');

    const funnel = await this.getPublishedFunnel(funnelId);
    const page = await this.resolvePublishedSitePage(
      funnelId,
      rawPath.trim().toLowerCase(),
    );

    if (!page.published) throw new NotFoundException('Page not found');

    const element = this.findElementById(
      Array.isArray(page.content) ? (page.content as EditorElement[]) : [],
      elementId,
    );

    if (!element || !FILE_WIDGET_TYPES.has(element.type ?? '')) {
      throw new NotFoundException('File element not found on this page');
    }

    const content = (element.content ?? {}) as FileWidgetContent;

    // Anything other than an explicit label binding is NOT resolvable here —
    // no permissive fallback to "list the whole space".
    if (content.sourceMode !== 'label') {
      throw new NotFoundException('Element is not a label-backed file list');
    }

    const labelIds = (Array.isArray(content.labelIds) ? content.labelIds : [])
      .map((id) => String(id))
      .filter((id) => UUID_RE.test(id));

    if (
      !content.spaceId ||
      !UUID_RE.test(content.spaceId) ||
      !labelIds.length
    ) {
      return {
        nodes: [],
        organizationId: funnel.organization_id,
        truncated: false,
      };
    }

    // Cross-tenant isolation: the bound space must live in the funnel's own org
    // and still be usable. Scoped lookup, not a permission grant.
    const { data: space, error: spaceError } = await this.client
      .from('spaces')
      .select('id, is_active, is_archived')
      .eq('id', content.spaceId)
      .eq('organization_id', funnel.organization_id)
      .maybeSingle();

    if (spaceError) throw new BadRequestException(spaceError.message);

    const spaceRow = space as {
      is_active?: boolean | null;
      is_archived?: boolean | null;
    } | null;

    if (!spaceRow || spaceRow.is_active === false || spaceRow.is_archived) {
      return {
        nodes: [],
        organizationId: funnel.organization_id,
        truncated: false,
      };
    }

    const meta = { truncated: false };
    const nodes = await this.fileExplorerRepo.listNodes(
      content.spaceId,
      funnel.organization_id,
      'all',
      { label_ids: labelIds },
      meta,
    );

    return {
      nodes,
      organizationId: funnel.organization_id,
      truncated: meta.truncated,
    };
  }

  async listTicketSpaces(
    user: RequestUser | null | undefined,
    rawSpaceIds: string,
  ) {
    const requestedIds = rawSpaceIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    if (requestedIds.length === 0) return [];

    if (requestedIds.some((id) => !UUID_RE.test(id))) {
      throw new BadRequestException('Valid spaceIds required');
    }

    const uniqueIds = [...new Set(requestedIds)].slice(0, 50);
    const allowed: Array<{
      id: string;
      name: string;
      key: string | null;
      color: string | null;
    }> = [];

    for (const spaceId of uniqueIds) {
      try {
        const ctx = user
          ? await this.getSpaceContext(user, spaceId, 'view_space')
          : await this.getPublicSpaceContext(spaceId);

        if (!ctx.space.is_active || ctx.space.is_archived) continue;

        const { data: space, error } = await this.client
          .from('spaces')
          .select('id, name, key, color')
          .eq('id', spaceId)
          .eq('organization_id', ctx.space.organization_id)
          .maybeSingle();

        if (error) throw new BadRequestException(error.message);
        if (space) {
          const row = space as {
            id: string;
            name: string;
            key: string | null;
            color: string | null;
          };

          allowed.push({
            id: row.id,
            name: row.name,
            key: row.key ?? '',
            color: row.color ?? '#6366f1',
          });
        }
      } catch (error) {
        if (error instanceof ForbiddenException) continue;
        throw error;
      }
    }

    return allowed;
  }

  async createTicket(user: RequestUser, dto: CreatePublicTicketDto) {
    const { spaceId, summary, description, priority, funnelId, pageId } = dto;

    const page = await this.getPublishedPage(pageId, funnelId);
    const funnel = await this.getPublishedFunnel(funnelId);
    const ticketForm = this.findTicketFormElement(
      Array.isArray(page.content) ? (page.content as EditorElement[]) : [],
    );

    if (!ticketForm) {
      throw new BadRequestException('Ticket form not found on this page');
    }

    const formContent = ticketForm.content as TicketFormContent;
    const allowedSpaceIds = new Set(
      (formContent.allowedSpaces ?? []).map((space) => space.id),
    );

    if (!allowedSpaceIds.has(spaceId)) {
      throw new ForbiddenException('Space not allowed for this form');
    }

    const ctx = await this.getSpaceContext(user, spaceId, 'view_space');

    if (ctx.space.organization_id !== funnel.organization_id) {
      throw new ForbiddenException('Space not allowed for this form');
    }

    if (!ctx.space.is_active || ctx.space.is_archived) {
      throw new BadRequestException('Space is not accepting submissions');
    }

    await this.assertTicketRateLimit(user.userId, spaceId);

    const task = await this.tasksService.create(
      ctx.space.organization_id,
      user.userId,
      {
        space_id: spaceId,
        summary,
        description: description ?? undefined,
        status: 'open',
        priority,
        task_type_id: 'task',
        reporter: user.userId,
      },
    );

    return { data: { taskId: task.id, taskKey: task.key } };
  }

  private parseMaxItems(raw: string | undefined): number {
    const parsed = parseInt(raw ?? '10', 10);

    if (Number.isNaN(parsed)) return 10;

    return Math.min(50, Math.max(1, parsed));
  }

  private assertUuid(
    value: string | undefined,
    message: string,
  ): asserts value is string {
    if (!value || !UUID_RE.test(value)) {
      throw new BadRequestException(message);
    }
  }

  private async getSpaceContext(
    user: RequestUser,
    spaceId: string,
    requiredPermission: string,
  ): Promise<SpaceContext> {
    this.assertUuid(spaceId, 'Valid spaceId required');

    const { data: space, error: spaceError } = await this.client
      .from('spaces')
      .select(
        'id,key,name,description,icon_url,icon,organization_id,is_active,is_archived',
      )
      .eq('id', spaceId)
      .maybeSingle();

    if (spaceError) throw new BadRequestException(spaceError.message);
    if (!space) throw new ForbiddenException('Access denied');

    const spaceRow = space as SpaceContext['space'];

    if (spaceRow.is_active === false || spaceRow.is_archived === true) {
      throw new ForbiddenException('Access denied');
    }
    const { data: orgMember } = await this.client
      .from('organization_members')
      .select('role')
      .eq('user_id', user.userId)
      .eq('organization_id', spaceRow.organization_id)
      .maybeSingle();
    const organizationRole =
      (orgMember as { role?: string } | null)?.role ?? null;

    const { data: membership, error: memberError } = await this.client
      .from('space_members')
      .select('space_role, permissions')
      .eq('space_id', spaceId)
      .eq('user_id', user.userId)
      .eq('is_active', true)
      .maybeSingle();

    if (memberError) throw new BadRequestException(memberError.message);

    const hasImplicitAdminAccess =
      !membership &&
      (organizationRole === 'owner' || organizationRole === 'admin');

    if (!membership && !hasImplicitAdminAccess) {
      throw new ForbiddenException('Access denied');
    }

    const roleKey = hasImplicitAdminAccess
      ? organizationRole === 'owner'
        ? 'owner'
        : 'admin'
      : this.resolveRoleKey(
          (membership as { space_role?: string | null } | null)?.space_role,
        );

    const permissions = await this.resolveSpacePermissions(
      spaceId,
      user.userId,
      roleKey,
      (membership as { permissions?: Record<string, boolean> | null } | null)
        ?.permissions ?? null,
    );
    const flatPermission = requiredPermission.startsWith('can_')
      ? requiredPermission.slice(4)
      : requiredPermission;

    if (permissions[flatPermission] !== true) {
      throw new ForbiddenException('Access denied');
    }

    return {
      space: spaceRow,
      organizationRole,
      spaceRole: roleKey,
      permissions,
    };
  }

  private async resolveSpacePermissions(
    spaceId: string,
    userId: string,
    roleKey: string,
    memberPermissions: Record<string, boolean> | null,
  ): Promise<Record<string, boolean>> {
    const base = { ...(SPACE_ROLE_BASE_PERMISSIONS[roleKey] ?? {}) };
    const { data: rows, error } = await this.client
      .from('space_permissions')
      .select('*')
      .eq('space_id', spaceId);

    if (error) throw new BadRequestException(error.message);

    for (const row of (rows ?? []) as Record<string, unknown>[]) {
      const targetType = row['target_type'];
      const targetId = row['target_id'];
      const baseRole = row['base_role'];
      const userIdColumn = row['user_id'];
      const appliesToUser =
        (targetType === 'user' &&
          (targetId === userId || userIdColumn === userId)) ||
        (targetType === 'base_role' &&
          (targetId === roleKey || baseRole === roleKey));

      if (!appliesToUser) continue;

      for (const [key, value] of Object.entries(row)) {
        if (key.startsWith('can_') && typeof value === 'boolean') {
          base[key.slice(4)] = value;
        }
      }
    }

    if (memberPermissions) {
      for (const [key, value] of Object.entries(memberPermissions)) {
        if (typeof value === 'boolean') {
          base[key.startsWith('can_') ? key.slice(4) : key] = value;
        }
      }
    }

    return normalizeSpacePermissions(base);
  }

  private async filterAccessibleWikiPages(
    user: RequestUser | null | undefined,
    ctx: SpaceContext,
    pages: WikiPage[],
  ): Promise<WikiPage[]> {
    const isPrivileged =
      ctx.spaceRole === 'owner' ||
      ctx.spaceRole === 'admin' ||
      ctx.organizationRole === 'owner' ||
      ctx.organizationRole === 'admin';

    if (isPrivileged) return pages;

    const restricted = pages.filter((page) => page.has_custom_permissions);

    if (restricted.length === 0) return pages;

    // Anonymous visitors cannot satisfy user-level page permissions —
    // hide any pages that have custom permissions rather than leaking them.
    if (!user) {
      return pages.filter((page) => !page.has_custom_permissions);
    }

    const { data: grants, error } = await this.client
      .from('wiki_page_permissions')
      .select('wiki_page_id')
      .in(
        'wiki_page_id',
        restricted.map((page) => page.id),
      )
      .eq('entity_type', 'user')
      .eq('entity_id', user.userId)
      .eq('can_view', true);

    if (error) throw new BadRequestException(error.message);

    const grantedIds = new Set(
      ((grants ?? []) as Array<{ wiki_page_id: string }>).map(
        (grant) => grant.wiki_page_id,
      ),
    );

    return pages.filter(
      (page) => !page.has_custom_permissions || grantedIds.has(page.id),
    );
  }

  private async getPublicSpaceContext(spaceId: string): Promise<SpaceContext> {
    this.assertUuid(spaceId, 'Valid spaceId required');

    const { data: space, error: spaceError } = await this.client
      .from('spaces')
      .select('id, key, organization_id, is_active, is_archived')
      .eq('id', spaceId)
      .maybeSingle();

    if (spaceError) throw new BadRequestException(spaceError.message);
    if (!space) throw new ForbiddenException('Access denied');

    const spaceRow = space as SpaceContext['space'];

    if (spaceRow.is_active === false || spaceRow.is_archived === true) {
      throw new ForbiddenException('Access denied');
    }

    return {
      space: spaceRow,
      organizationRole: null,
      spaceRole: 'viewer',
      permissions: {
        view_tasks: true,
        view_processes: true,
        view_wiki_pages: true,
        view_space: true,
      },
    };
  }

  private async getPublishedPage(
    pageId: string,
    funnelId: string,
  ): Promise<{
    id: string;
    published: boolean;
    funnel_id: string;
    content: unknown;
  }> {
    const { data: page, error } = await this.client
      .from('site_studio_pages')
      .select('id, published, funnel_id, content')
      .eq('id', pageId)
      .eq('funnel_id', funnelId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!page) throw new BadRequestException('Page not found');
    if (!(page as { published?: boolean }).published) {
      throw new BadRequestException('Page is not published');
    }

    return page as {
      id: string;
      published: boolean;
      funnel_id: string;
      content: unknown;
    };
  }

  private async getPublishedFunnel(funnelId: string): Promise<{
    id: string;
    published: boolean;
    organization_id: string;
  }> {
    const { data: funnel, error } = await this.client
      .from('site_studio_funnels')
      .select('id, published, organization_id')
      .eq('id', funnelId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!funnel) throw new BadRequestException('Funnel not found');
    if (!(funnel as { published?: boolean }).published) {
      throw new BadRequestException('Funnel is not published');
    }

    return funnel as {
      id: string;
      published: boolean;
      organization_id: string;
    };
  }

  /** Depth-first lookup of one element by id inside a stored page content tree. */
  private findElementById(
    elements: EditorElement[],
    elementId: string,
  ): EditorElement | null {
    for (const element of elements) {
      if (element.id === elementId) return element;

      if (Array.isArray(element.content)) {
        const found = this.findElementById(
          element.content as EditorElement[],
          elementId,
        );

        if (found) return found;
      }
    }

    return null;
  }

  /**
   * Map node id → share token for nodes that already have an ACTIVE, unexpired
   * `link` share in this organisation. Read-only: this endpoint never mints a
   * share, so a node without one is simply not publicly listed.
   */
  private async activeLinkShareTokens(
    nodeIds: string[],
    organizationId: string,
  ): Promise<Map<string, string>> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.client
      .from('fe_shares')
      .select('node_id, token')
      .in('node_id', nodeIds)
      .eq('organization_id', organizationId)
      .eq('share_type', 'link')
      .eq('is_active', true)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`);

    if (error) throw new BadRequestException(error.message);

    const tokens = new Map<string, string>();

    for (const row of (data ?? []) as Array<{
      node_id: string;
      token: string | null;
    }>) {
      if (row.token) tokens.set(row.node_id, row.token);
    }

    return tokens;
  }

  private findTicketFormElement(
    elements: EditorElement[],
  ): EditorElement | null {
    for (const element of elements) {
      if (element.type === 'ticketForm') return element;

      if (Array.isArray(element.content)) {
        const found = this.findTicketFormElement(
          element.content as EditorElement[],
        );

        if (found) return found;
      }
    }

    return null;
  }

  private async assertTicketRateLimit(
    userId: string,
    spaceId: string,
  ): Promise<void> {
    const sixtySecondsAgo = new Date(Date.now() - 60_000).toISOString();
    const { count, error } = await this.client
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('space_id', spaceId)
      .eq('created_by', userId)
      .gte('created_at', sixtySecondsAgo);

    if (error)
      throw new InternalServerErrorException('Failed to create ticket');

    if ((count ?? 0) >= 5) {
      throw new HttpException(
        'Too many submissions. Please wait before submitting again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private resolveRoleKey(spaceRole: string | null | undefined): string {
    if (!spaceRole) return 'viewer';
    if (spaceRole === 'owner') return 'owner';
    if (spaceRole === 'admin' || spaceRole === 'space_admin') return 'admin';
    if (spaceRole === 'member') return 'member';
    return 'viewer';
  }
}
