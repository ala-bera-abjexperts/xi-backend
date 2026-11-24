import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { sanitizeRichText } from '../../common/utils/sanitize-rich-text';
import type { CreatePageDto } from './dto/create-page.dto';
import type { UpdatePageDto } from './dto/update-page.dto';
import type { ReorderPagesDto } from './dto/reorder-pages.dto';
import type { MovePageDto } from './dto/move-page.dto';
import type { SaveContentDto } from './dto/save-content.dto';

export interface SiteStudioPage {
  id: string;
  funnel_id: string;
  organization_id: string;
  name: string;
  path_name: string;
  content: unknown;
  sort_order: number;
  preview_image: string | null;
  visits: number;
  published: boolean;
  seo_title: string | null;
  seo_description: string | null;
  seo_image: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class PagesService {
  static readonly PAGES_TABLE = 'site_studio_pages';
  static readonly FUNNELS_TABLE = 'site_studio_funnels';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private async getNextSortOrder(funnelId: string): Promise<number> {
    const { data } = await this.client
      .from(PagesService.PAGES_TABLE)
      .select('sort_order')
      .eq('funnel_id', funnelId)
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data
      ? ((data as Record<string, unknown>)['sort_order'] as number) + 1
      : 0;
  }

  private async findPageById(
    pageId: string,
    organizationId: string,
    funnelId?: string,
  ): Promise<SiteStudioPage> {
    let query = this.client
      .from(PagesService.PAGES_TABLE)
      .select('*')
      .eq('id', pageId)
      .eq('organization_id', organizationId);

    if (funnelId) query = query.eq('funnel_id', funnelId);

    const { data, error } = (await query.single()) as {
      data: SiteStudioPage | null;
      error: { message: string; code: string } | null;
    };

    if (error) {
      if (error.code === 'PGRST116')
        throw new NotFoundException('Page not found');
      throw new BadRequestException(error.message);
    }
    return data as unknown as SiteStudioPage;
  }

  private logPageAction(
    organizationId: string,
    userId: string,
    entityId: string,
    action: 'create' | 'update' | 'delete',
    changes?: Record<string, unknown>,
  ): void {
    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'site_studio_page',
      entityId,
      action,
      changes,
    );
  }

  // ── Public methods ────────────────────────────────────────────────────────────

  async getPages(
    funnelId: string,
    organizationId: string,
  ): Promise<SiteStudioPage[]> {
    const { data, error } = await this.client
      .from(PagesService.PAGES_TABLE)
      .select('*')
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId)
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as unknown as SiteStudioPage[];
  }

  async getPageById(
    funnelId: string,
    pageId: string,
    organizationId: string,
  ): Promise<SiteStudioPage> {
    return this.findPageById(pageId, organizationId, funnelId);
  }

  async createPage(
    funnelId: string,
    organizationId: string,
    userId: string,
    dto: CreatePageDto,
  ): Promise<SiteStudioPage> {
    // Verify funnel exists
    const { data: funnel } = await this.client
      .from(PagesService.FUNNELS_TABLE)
      .select('id, published')
      .eq('id', funnelId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!funnel) throw new NotFoundException('Funnel not found');

    const sortOrder = await this.getNextSortOrder(funnelId);
    const pathName = dto.path_name ?? '';

    // Non-landing pages require a path
    if (sortOrder > 0 && !pathName) {
      throw new BadRequestException(
        'path_name is required for non-landing pages',
      );
    }

    const { data, error } = (await this.client
      .from(PagesService.PAGES_TABLE)
      .insert({
        funnel_id: funnelId,
        organization_id: organizationId,
        name: dto.name,
        path_name: pathName,
        sort_order: sortOrder,
        published: Boolean((funnel as Record<string, unknown>)['published']),
        created_by: userId,
      })
      .select()
      .single()) as {
      data: SiteStudioPage | null;
      error: { message: string; code: string } | null;
    };

    if (error) {
      if (error.code === '23505')
        throw new BadRequestException(
          'A page with this path already exists in this funnel',
        );
      throw new BadRequestException(error.message);
    }

    const page = data as unknown as SiteStudioPage;
    this.logPageAction(organizationId, userId, page.id, 'create', {
      funnel_id: funnelId,
      name: page.name,
      path_name: page.path_name,
    });
    return page;
  }

  /**
   * Identity fields (`name`, `slug`, `path_name`, `parent_page_id`, `is_landing`) cannot be written
   * with a plain UPDATE: the `site_studio_require_page_command` trigger raises
   * `SITE_STUDIO_PAGE_COMMAND_REQUIRED` unless the `app.site_studio_page_command` GUC is set, and
   * only `site_studio_apply_page_command_v2` sets it.
   *
   * The RPC owns the hard parts, so do not reimplement them here: it takes an advisory lock on the
   * funnel, checks the optimistic `version`, rewrites the whole descendant subtree, retires the old
   * canonical route to an `alias` (so published URLs keep resolving) and inserts the new one, writes
   * the audit log, and enqueues a platform event. It is idempotent per `request_id`.
   *
   * `slug` is a SINGLE segment; hierarchy comes from `parent_page_id`, and `path_name` is derived
   * (`parent.path_name || '/' || slug`). Callers holding a full path must resolve the parent first.
   */
  private async applyPageIdentityCommand(params: {
    organizationId: string;
    funnelId: string;
    page: SiteStudioPage & {
      version: number;
      slug: string | null;
      parent_page_id: string | null;
    };
    actorId: string;
    name?: string;
    slug?: string | null;
    parentPageId?: string | null;
  }): Promise<SiteStudioPage> {
    const { organizationId, funnelId, page, actorId } = params;

    const { error } = await this.client.rpc(
      'site_studio_apply_page_command_v2',
      {
        p_organization_id: organizationId,
        p_funnel_id: funnelId,
        p_page_id: page.id,
        p_command: 'rename_move',
        p_expected_version: page.version,
        // rename_move sets all three at once, so unchanged fields must be echoed back.
        p_name: params.name ?? page.name,
        p_slug: params.slug !== undefined ? params.slug : page.slug,
        p_parent_page_id:
          params.parentPageId !== undefined
            ? params.parentPageId
            : page.parent_page_id,
        p_actor_id: actorId,
        p_request_id: randomUUID(),
      },
    );

    if (error) throw this.mapPageCommandError(error.message);

    return this.findPageById(page.id, organizationId, funnelId);
  }

  /** Translate the RPC's sentinel messages into the HTTP errors the client already understands. */
  private mapPageCommandError(message: string): Error {
    if (message.includes('SITE_STUDIO_NOT_FOUND')) {
      return new NotFoundException('Page not found');
    }

    if (message.includes('SITE_STUDIO_VERSION_CONFLICT')) {
      return new ConflictException({
        code: 'SITE_STUDIO_VERSION_CONFLICT',
        message:
          'This page changed in another session. Reload the page and try again.',
      });
    }

    if (
      message.includes('SITE_STUDIO_ROUTE_COLLISION') ||
      message.includes('SITE_STUDIO_ALIAS_COLLISION')
    ) {
      return new BadRequestException('A page with this path already exists');
    }

    if (message.includes('SITE_STUDIO_LANDING_IMMUTABLE')) {
      return new BadRequestException(
        'Cannot change the path of the landing page',
      );
    }

    if (message.includes('SITE_STUDIO_INVALID_SLUG')) {
      return new BadRequestException(
        'Path must be lowercase letters, numbers and hyphens (max 80 characters)',
      );
    }

    if (message.includes('SITE_STUDIO_INVALID_NAME')) {
      return new BadRequestException('Page name must be 1 to 255 characters');
    }

    if (message.includes('SITE_STUDIO_MAX_DEPTH')) {
      return new BadRequestException(
        'Pages cannot be nested more than 8 levels deep',
      );
    }

    if (message.includes('SITE_STUDIO_PATH_TOO_LONG')) {
      return new BadRequestException(
        'The resulting path is longer than 255 characters',
      );
    }

    if (message.includes('SITE_STUDIO_CYCLE')) {
      return new BadRequestException(
        'A page cannot be moved inside its own sub-tree',
      );
    }

    if (message.includes('SITE_STUDIO_INVALID_PARENT')) {
      return new BadRequestException('Invalid parent page');
    }

    if (message.includes('SITE_STUDIO_LEGACY_HIERARCHY_CONFLICT')) {
      return new BadRequestException(
        'This sub-tree contains a legacy page whose hierarchy must be repaired before it can be renamed',
      );
    }

    return new BadRequestException(message);
  }

  /**
   * Split a full `path_name` ("parent/child/leaf") into the `{ slug, parentPageId }` pair the
   * command RPC expects. The parent is looked up by its own canonical path, so reparenting by
   * dragging (which sends a full path) keeps working.
   */
  private async resolveSlugAndParent(
    fullPath: string,
    funnelId: string,
    organizationId: string,
    pageId: string,
  ): Promise<{ slug: string; parentPageId: string | null }> {
    const segments = fullPath.split('/').filter(Boolean);
    const slug = segments[segments.length - 1] ?? '';
    const parentPath = segments.slice(0, -1).join('/');

    if (!parentPath) return { slug, parentPageId: null };

    const { data, error } = await this.client
      .from(PagesService.PAGES_TABLE)
      .select('id')
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId)
      .eq('path_name', parentPath)
      .neq('id', pageId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);

    if (!data) {
      throw new BadRequestException(
        `No page exists at "/${parentPath}" to nest this page under`,
      );
    }

    return { slug, parentPageId: (data as { id: string }).id };
  }

  /** Load the identity columns the command RPC needs, which are absent from `SiteStudioPage`. */
  private async findPageWithIdentity(
    pageId: string,
    organizationId: string,
    funnelId: string,
  ): Promise<
    SiteStudioPage & {
      version: number;
      slug: string | null;
      parent_page_id: string | null;
      is_landing: boolean;
    }
  > {
    const { data, error } = await this.client
      .from(PagesService.PAGES_TABLE)
      .select('*')
      .eq('id', pageId)
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId)
      .single();

    if (error || !data) throw new NotFoundException('Page not found');

    return data as unknown as SiteStudioPage & {
      version: number;
      slug: string | null;
      parent_page_id: string | null;
      is_landing: boolean;
    };
  }

  async updatePage(
    funnelId: string,
    pageId: string,
    organizationId: string,
    userId: string,
    dto: UpdatePageDto,
  ): Promise<SiteStudioPage> {
    const existing = await this.findPageById(pageId, organizationId, funnelId);

    // Cannot change the path of the landing page
    if (
      existing.path_name === '' &&
      dto.path_name !== undefined &&
      dto.path_name !== ''
    ) {
      throw new BadRequestException(
        'Cannot change the path of the landing page',
      );
    }

    // `name` and `path_name` are identity fields guarded by the page-command trigger, so they go
    // through the RPC first; only the remaining plain columns are patched below.
    if (dto.name !== undefined || dto.path_name !== undefined) {
      const identity = await this.findPageWithIdentity(
        pageId,
        organizationId,
        funnelId,
      );

      await this.applyPageIdentityCommand({
        organizationId,
        funnelId,
        page: identity,
        actorId: userId,
        name: dto.name,
        // path_name carries the FULL path; the RPC wants the last segment plus a parent id.
        ...(dto.path_name !== undefined
          ? await this.resolveSlugAndParent(
              dto.path_name,
              funnelId,
              organizationId,
              pageId,
            )
          : {}),
      });
    }

    const patch: Record<string, unknown> = { updated_by: userId };
    if (dto.published !== undefined) patch['published'] = dto.published;
    if (dto.seo_title !== undefined) patch['seo_title'] = dto.seo_title;
    if (dto.seo_description !== undefined)
      patch['seo_description'] = dto.seo_description;
    if (dto.seo_image !== undefined) patch['seo_image'] = dto.seo_image;

    const { data, error } = (await this.client
      .from(PagesService.PAGES_TABLE)
      .update(patch)
      .eq('id', pageId)
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId)
      .select()
      .single()) as {
      data: SiteStudioPage | null;
      error: { message: string; code: string } | null;
    };

    if (error) {
      if (error.code === '23505')
        throw new BadRequestException('A page with this path already exists');
      throw new BadRequestException(error.message);
    }

    this.logPageAction(organizationId, userId, pageId, 'update', {
      funnel_id: funnelId,
      ...patch,
    });
    return data as unknown as SiteStudioPage;
  }

  async deletePage(
    funnelId: string,
    pageId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const page = await this.findPageById(pageId, organizationId, funnelId);

    // Cannot delete the last page
    const { count } = await this.client
      .from(PagesService.PAGES_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('funnel_id', page.funnel_id)
      .eq('organization_id', organizationId);

    if ((count ?? 0) <= 1) {
      throw new BadRequestException('Cannot delete the last page of a funnel');
    }

    const { error } = await this.client
      .from(PagesService.PAGES_TABLE)
      .delete()
      .eq('id', pageId)
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    // Reorder remaining pages
    const { data: remaining } = await this.client
      .from(PagesService.PAGES_TABLE)
      .select('id')
      .eq('funnel_id', page.funnel_id)
      .eq('organization_id', organizationId)
      .order('sort_order', { ascending: true });

    if (remaining && remaining.length > 0) {
      for (let i = 0; i < remaining.length; i++) {
        await this.client
          .from(PagesService.PAGES_TABLE)
          .update({ sort_order: i })
          .eq('id', (remaining[i] as Record<string, unknown>)['id']);
      }
    }

    this.logPageAction(organizationId, userId, pageId, 'delete', {
      funnel_id: funnelId,
      name: page.name,
      path_name: page.path_name,
    });
  }

  async duplicatePage(
    funnelId: string,
    pageId: string,
    organizationId: string,
    userId: string,
  ): Promise<SiteStudioPage> {
    const page = await this.findPageById(pageId, organizationId, funnelId);
    const sortOrder = await this.getNextSortOrder(page.funnel_id);

    // Generate unique path for the copy
    const baseName =
      page.path_name ||
      page.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') ||
      'page';

    let newPath = `${baseName}-copy`;

    // Check collision and find unique path
    for (let i = 2; i <= 20; i++) {
      const { count } = await this.client
        .from(PagesService.PAGES_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('funnel_id', page.funnel_id)
        .eq('organization_id', organizationId)
        .eq('path_name', newPath);

      if ((count ?? 0) === 0) break;
      newPath = i === 2 ? `${baseName}-copy-2` : `${baseName}-copy-${i}`;
    }

    const { data, error } = (await this.client
      .from(PagesService.PAGES_TABLE)
      .insert({
        funnel_id: page.funnel_id,
        organization_id: organizationId,
        name: `${page.name} (Copy)`,
        path_name: newPath,
        content: page.content,
        sort_order: sortOrder,
        published: false,
        seo_title: page.seo_title,
        seo_description: page.seo_description,
        seo_image: page.seo_image,
        created_by: userId,
      })
      .select()
      .single()) as {
      data: SiteStudioPage | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);

    const duplicate = data as unknown as SiteStudioPage;
    this.logPageAction(organizationId, userId, duplicate.id, 'create', {
      funnel_id: funnelId,
      source_page_id: pageId,
      name: duplicate.name,
      path_name: duplicate.path_name,
    });
    return duplicate;
  }

  async movePage(
    funnelId: string,
    pageId: string,
    organizationId: string,
    userId: string,
    dto: MovePageDto,
  ): Promise<SiteStudioPage> {
    const page = await this.findPageWithIdentity(
      pageId,
      organizationId,
      funnelId,
    );

    if (page.is_landing || page.path_name === '') {
      throw new BadRequestException('Cannot move the landing page');
    }

    if (page.path_name === dto.newPath) return page;

    // The collision checks, descendant rewrite and route aliasing this method used to do by hand
    // are all inside site_studio_apply_page_command_v2, under an advisory lock and a version check.
    // Doing them here as separate statements could not work any more anyway: the identity trigger
    // rejects a plain UPDATE of path_name.
    const { slug, parentPageId } = await this.resolveSlugAndParent(
      dto.newPath,
      funnelId,
      organizationId,
      pageId,
    );

    const moved = await this.applyPageIdentityCommand({
      organizationId,
      funnelId,
      page,
      actorId: userId,
      slug,
      parentPageId,
    });

    this.logPageAction(organizationId, userId, pageId, 'update', {
      funnel_id: funnelId,
      from_path_name: page.path_name,
      to_path_name: moved.path_name,
    });

    return moved;
  }

  async reorderPages(
    funnelId: string,
    organizationId: string,
    userId: string,
    dto: ReorderPagesDto,
  ): Promise<void> {
    // Verify all pages belong to this funnel
    const { data: existing } = await this.client
      .from(PagesService.PAGES_TABLE)
      .select('id')
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId);

    const existingIds = new Set(
      ((existing ?? []) as Record<string, unknown>[]).map(
        (p) => p['id'] as string,
      ),
    );

    for (const item of dto.pages) {
      if (!existingIds.has(item.id)) {
        throw new BadRequestException(
          `Page ${item.id} does not belong to this funnel`,
        );
      }
    }

    for (const item of dto.pages) {
      await this.client
        .from(PagesService.PAGES_TABLE)
        .update({ sort_order: item.sort_order })
        .eq('id', item.id)
        .eq('organization_id', organizationId);
    }

    this.logPageAction(organizationId, userId, funnelId, 'update', {
      funnel_id: funnelId,
      reordered_pages: dto.pages,
    });
  }

  async saveContent(
    funnelId: string,
    pageId: string,
    organizationId: string,
    userId: string,
    dto: SaveContentDto,
  ): Promise<SiteStudioPage> {
    const content = this.validatePageContent(dto.content);

    await this.findPageById(pageId, organizationId, funnelId);

    const { data, error } = (await this.client
      .from(PagesService.PAGES_TABLE)
      .update({ content, updated_by: userId })
      .eq('id', pageId)
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId)
      .select()
      .single()) as {
      data: SiteStudioPage | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);

    this.logPageAction(organizationId, userId, pageId, 'update', {
      funnel_id: funnelId,
      content_updated: true,
    });
    return data as unknown as SiteStudioPage;
  }

  private validatePageContent(content: unknown): unknown[] {
    if (!Array.isArray(content)) {
      throw new BadRequestException('Invalid page content structure');
    }

    if (
      content.length !== 1 ||
      !this.isRecord(content[0]) ||
      content[0]['type'] !== '__body'
    ) {
      throw new BadRequestException(
        'Content must have a single __body root element',
      );
    }

    const validateElement = (element: unknown): void => {
      if (!this.isRecord(element)) {
        throw new BadRequestException('Invalid page content structure');
      }

      if (
        typeof element['id'] !== 'string' ||
        typeof element['type'] !== 'string' ||
        typeof element['name'] !== 'string' ||
        !this.isRecord(element['styles'])
      ) {
        throw new BadRequestException('Invalid page content structure');
      }

      // SECURITY (C6): the published-page renderer injects a `text` element's
      // `content.innerText` via dangerouslySetInnerHTML — and emits it RAW during
      // SSR to anonymous visitors. Sanitize it here on write (DOMPurify strips
      // scripts / event handlers / javascript: URIs) so stored + served content
      // can never carry XSS. Other element types render innerText as escaped
      // text (React), so they are intentionally left untouched.
      if (element['type'] === 'text' && this.isRecord(element['content'])) {
        const inner = element['content']['innerText'];

        if (typeof inner === 'string') {
          element['content']['innerText'] = sanitizeRichText(inner) ?? '';
        }
      }

      if (['__body', 'container', '2Col', '3Col'].includes(element['type'])) {
        if (!Array.isArray(element['content'])) {
          throw new BadRequestException('Invalid page content structure');
        }

        element['content'].forEach(validateElement);
      } else if (element['content'] === undefined) {
        throw new BadRequestException('Invalid page content structure');
      }
    };

    content.forEach(validateElement);

    return content;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
