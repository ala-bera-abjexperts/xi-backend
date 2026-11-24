/**
 * @fileoverview Wiki page templates.
 *
 * A template is a wiki page directly under its space's "Templates" root page
 * (`metadata.system = 'wiki_templates'`), so it is written in the full page editor and
 * guarded by normal page permissions. An optional `wiki_templates` row (page_id set)
 * holds its settings: page title preset, description and level — space_id NULL makes it
 * a tenant template offered in every space of the organization.
 *
 * Legacy rows (page_id NULL) are the original dialog-made templates; they stay usable.
 *
 * The admin client bypasses RLS, so every statement filters on the caller's organization_id.
 * @module src/wiki/wiki-templates.service
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { validateTipTapDoc } from '../common/utils/tiptap-sanitizer';
import { WikiService } from './wiki.service';
import { WikiPermissionsService } from './wiki-permissions.service';
import type {
  CreateWikiTemplateDto,
  UpdateWikiTemplateDto,
  WikiTemplateSettingsDto,
} from './dto/wiki-template.dto';

/** `metadata.system` of a space's Templates root page. */
export const TEMPLATES_ROOT_SYSTEM = 'wiki_templates';

/** An empty TipTap page; createPage rejects '' for content_format 'tiptap'. */
const EMPTY_DOC = JSON.stringify({
  type: 'doc',
  content: [{ type: 'paragraph' }],
});

type TemplateRow = Record<string, unknown> & {
  id: string;
  space_id: string | null;
  page_id: string | null;
};

type TemplatePage = {
  id: string;
  title: string;
  space_id: string;
  parent_id: string;
  path: string[] | null;
  created_by: string | null;
  updated_at: string;
};

export type TemplateScope = 'space' | 'tenant';

/** One entry of the picker / manager list. `id` is the page id, or the row id for legacy. */
export interface TemplateListItem {
  id: string;
  page_id: string | null;
  space_id: string | null;
  space_key: string | null;
  scope: TemplateScope;
  name: string;
  description: string | null;
  page_title: string | null;
  updated_at: string | null;
}

@Injectable()
export class WikiTemplatesService {
  private static readonly TABLE = 'wiki_templates';
  private static readonly PAGES = 'wiki_pages';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
    private readonly auditLogs: AuditLogsService,
    private readonly wiki: WikiService,
    private readonly pagePermissions: WikiPermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private scopeOf(row: { space_id: string | null } | undefined): TemplateScope {
    return row && row.space_id === null ? 'tenant' : 'space';
  }

  /** SpacePermissionsGuard does not compare the space's org to the caller's. */
  private async assertSpaceInOrg(spaceId: string, user: RequestUser) {
    const { data, error } = await this.client
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Space not found');
  }

  private async assertTenantAdmin(user: RequestUser) {
    if (
      !(await this.permissions.isAdminOrOwner(user.userId, user.organizationId))
    ) {
      throw new ForbiddenException(
        'Only tenant admins can manage tenant templates',
      );
    }
  }

  // ── Templates root ───────────────────────────────────────────────────────

  /** Live Templates root pages of the organization, optionally of one space. */
  private async findRoots(
    organizationId: string,
    spaceId?: string,
  ): Promise<{ id: string; space_id: string }[]> {
    let q = this.client
      .from(WikiTemplatesService.PAGES)
      .select('id, space_id')
      .eq('organization_id', organizationId)
      .eq('metadata->>system', TEMPLATES_ROOT_SYSTEM)
      .eq('is_archived', false);
    if (spaceId) q = q.eq('space_id', spaceId);
    const { data, error } = await q.order('created_at', { ascending: true });
    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as { id: string; space_id: string }[];
  }

  /** The space's Templates root, created on first use. */
  private async ensureRoot(
    spaceId: string,
    user: RequestUser,
  ): Promise<string> {
    // ponytail: two first-ever creates racing can make two roots; both count as roots.
    const [existing] = await this.findRoots(user.organizationId, spaceId);
    if (existing) return existing.id;

    await this.pagePermissions.assertSpaceCanCreate(
      user.userId,
      spaceId,
      user.organizationId,
    );
    const root = (await this.wiki.createPage(
      {
        space_id: spaceId,
        title: 'Templates',
        content: EMPTY_DOC,
        content_format: 'tiptap',
        is_published: false,
        tags: [],
        metadata: { system: TEMPLATES_ROOT_SYSTEM },
      },
      user.organizationId,
      user.userId,
    )) as { id: string };
    return root.id;
  }

  /** A live template page (direct child of a Templates root) of the caller's org. */
  private async loadTemplatePage(
    pageId: string,
    organizationId: string,
  ): Promise<TemplatePage & { content: string; content_format: string }> {
    const { data, error } = await this.client
      .from(WikiTemplatesService.PAGES)
      .select(
        'id, title, space_id, parent_id, path, created_by, updated_at, content, content_format, is_archived',
      )
      .eq('id', pageId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    const page = data as
      | (TemplatePage & {
          content: string;
          content_format: string;
          is_archived: boolean;
        })
      | null;
    const roots = page?.parent_id
      ? await this.findRoots(organizationId, page.space_id)
      : [];
    if (
      !page ||
      page.is_archived ||
      !roots.some((r) => r.id === page.parent_id)
    ) {
      throw new NotFoundException(`Template ${pageId} not found`);
    }
    return page;
  }

  private async rowForPage(
    pageId: string,
    organizationId: string,
  ): Promise<TemplateRow | null> {
    const r = await this.client
      .from(WikiTemplatesService.TABLE)
      .select('*')
      .eq('page_id', pageId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    return r.data as TemplateRow | null;
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  /**
   * Templates offered in `spaceId`: this space's template pages the caller may view,
   * tenant template pages of any space, and legacy rows. Space first, then by name.
   */
  async list(spaceId: string, user: RequestUser): Promise<TemplateListItem[]> {
    await this.assertSpaceInOrg(spaceId, user);
    const org = user.organizationId;

    const rowsRes = await this.client
      .from(WikiTemplatesService.TABLE)
      .select('*')
      .eq('organization_id', org)
      .or(`space_id.is.null,space_id.eq.${spaceId}`);
    if (rowsRes.error) throw new BadRequestException(rowsRes.error.message);
    const rows = (rowsRes.data ?? []) as TemplateRow[];
    const rowByPage = new Map(
      rows.filter((r) => r.page_id).map((r) => [r.page_id as string, r]),
    );

    const roots = await this.findRoots(org);
    let pages: TemplatePage[] = [];
    if (roots.length > 0) {
      const pagesRes = await this.client
        .from(WikiTemplatesService.PAGES)
        .select('id, title, space_id, parent_id, path, created_by, updated_at')
        .eq('organization_id', org)
        .eq('is_archived', false)
        .in(
          'parent_id',
          roots.map((r) => r.id),
        );
      if (pagesRes.error) throw new BadRequestException(pagesRes.error.message);
      pages = (pagesRes.data ?? []) as TemplatePage[];
    }

    // Tenant templates are offered everywhere; space templates follow page view rights.
    const isTenant = (p: TemplatePage) =>
      rowByPage.get(p.id)?.space_id === null;
    const tenantPages = pages.filter(isTenant);
    const spacePages = (await this.pagePermissions.filterAccessiblePages(
      pages.filter((p) => p.space_id === spaceId && !isTenant(p)),
      user.userId,
      spaceId,
    )) as TemplatePage[];

    const spaceIds = [
      ...new Set([...spacePages, ...tenantPages].map((p) => p.space_id)),
    ];
    const keyById = new Map<string, string>();
    if (spaceIds.length > 0) {
      const sp = await this.client
        .from('spaces')
        .select('id, key')
        .eq('organization_id', org)
        .in('id', spaceIds);
      if (sp.error) throw new BadRequestException(sp.error.message);
      for (const s of (sp.data ?? []) as { id: string; key: string }[]) {
        keyById.set(s.id, s.key);
      }
    }

    const fromPage = (p: TemplatePage): TemplateListItem => {
      const row = rowByPage.get(p.id);
      return {
        id: p.id,
        page_id: p.id,
        space_id: p.space_id,
        space_key: keyById.get(p.space_id) ?? null,
        scope: this.scopeOf(row),
        name: p.title,
        description: (row?.['description'] as string | null) ?? null,
        page_title: (row?.['page_title'] as string | null) ?? null,
        updated_at: p.updated_at,
      };
    };
    const legacy = rows
      .filter((r) => !r.page_id)
      .map(
        (r): TemplateListItem => ({
          id: r.id,
          page_id: null,
          space_id: r.space_id,
          space_key: null,
          scope: this.scopeOf(r),
          name: String(r['name']),
          description: (r['description'] as string | null) ?? null,
          page_title: (r['page_title'] as string | null) ?? null,
          updated_at: (r['updated_at'] as string | null) ?? null,
        }),
      );

    return [
      ...spacePages.map(fromPage),
      ...tenantPages.map(fromPage),
      ...legacy,
    ].sort(
      (a, b) =>
        Number(a.scope === 'tenant') - Number(b.scope === 'tenant') ||
        a.name.localeCompare(b.name),
    );
  }

  /**
   * What a new page copies from template `id` (page id, or legacy row id).
   * Variables like {{date,YYYY-MM-DD}} are returned raw; the client fills them in.
   */
  async getContent(
    id: string,
    spaceId: string,
    user: RequestUser,
  ): Promise<{ title: string; content: string; content_format: string }> {
    await this.assertSpaceInOrg(spaceId, user);
    const org = user.organizationId;

    const legacyRes = await this.client
      .from(WikiTemplatesService.TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', org)
      .is('page_id', null)
      .maybeSingle();
    if (legacyRes.error) throw new BadRequestException(legacyRes.error.message);
    const legacy = legacyRes.data as TemplateRow | null;
    if (legacy) {
      if (legacy.space_id !== null && legacy.space_id !== spaceId) {
        throw new NotFoundException(`Template ${id} not found`);
      }
      return {
        title: (legacy['page_title'] as string | null) ?? '',
        content: (legacy['content'] as string | null) ?? '',
        content_format: 'tiptap',
      };
    }

    const page = await this.loadTemplatePage(id, org);
    const row = await this.rowForPage(id, org);
    if (row?.space_id !== null) {
      if (page.space_id !== spaceId) {
        throw new NotFoundException(`Template ${id} not found`);
      }
      await this.pagePermissions.assertPageAccess(
        id,
        user.userId,
        spaceId,
        'can_view',
      );
    }
    return {
      title: (row?.['page_title'] as string | null) ?? '',
      content: page.content ?? '',
      content_format: page.content_format ?? 'tiptap',
    };
  }

  // ── Write ────────────────────────────────────────────────────────────────

  /** Creates a template page under the space's Templates root (copying a page if given). */
  async create(
    spaceId: string,
    user: RequestUser,
    dto: CreateWikiTemplateDto,
  ): Promise<{ page_id: string; root_id: string }> {
    await this.assertSpaceInOrg(spaceId, user);

    let content = EMPTY_DOC;
    let contentFormat = 'tiptap';
    if (dto.source_page_id) {
      await this.pagePermissions.assertPageAccess(
        dto.source_page_id,
        user.userId,
        spaceId,
        'can_view',
      );
      const src = (await this.wiki.getPageById(
        dto.source_page_id,
        spaceId,
      )) as Record<string, unknown>;
      if (src['whiteboard_id']) {
        throw new BadRequestException('A whiteboard cannot be a template');
      }
      contentFormat = (src['content_format'] as string) ?? 'tiptap';
      content =
        (src['content'] as string) ||
        (contentFormat === 'tiptap' ? EMPTY_DOC : '');
    }

    const rootId = await this.ensureRoot(spaceId, user);
    await this.pagePermissions.assertPageAccess(
      rootId,
      user.userId,
      spaceId,
      'can_create',
    );

    const page = (await this.wiki.createPage(
      {
        space_id: spaceId,
        title: dto.name,
        parent_id: rootId,
        content,
        content_format: contentFormat,
        is_published: false,
        tags: [],
        metadata: {},
      },
      user.organizationId,
      user.userId,
    )) as { id: string };

    return { page_id: page.id, root_id: rootId };
  }

  /** Upserts the settings row of template page `pageId` (managed from the page's own space). */
  async saveSettings(
    pageId: string,
    spaceId: string,
    user: RequestUser,
    dto: WikiTemplateSettingsDto,
  ) {
    await this.assertSpaceInOrg(spaceId, user);
    const page = await this.loadTemplatePage(pageId, user.organizationId);
    if (page.space_id !== spaceId) {
      throw new NotFoundException(`Template ${pageId} not found`);
    }
    await this.pagePermissions.assertPageAccess(
      pageId,
      user.userId,
      spaceId,
      'can_edit',
    );

    const existing = await this.rowForPage(pageId, user.organizationId);
    // Making a template tenant-wide, or changing one that is, is for tenant admins.
    if (dto.scope === 'tenant' || (existing && existing.space_id === null)) {
      await this.assertTenantAdmin(user);
    }

    const fields = {
      space_id: dto.scope === 'space' ? spaceId : null,
      page_title: dto.page_title ?? null,
      description: dto.description ?? null,
      updated_by: user.userId,
    };
    const q = existing
      ? this.client
          .from(WikiTemplatesService.TABLE)
          .update(fields)
          .eq('id', existing.id)
          .eq('organization_id', user.organizationId)
      : this.client.from(WikiTemplatesService.TABLE).insert({
          ...fields,
          organization_id: user.organizationId,
          page_id: pageId,
          // Display name is the page title; the column only needs a valid value.
          name: page.title.trim().slice(0, 200) || 'Template',
          content: '',
          created_by: user.userId,
        });
    const r = await q.select('*').single();
    if (r.error) throw new BadRequestException(r.error.message);
    const row = r.data as TemplateRow;
    void this.auditLogs.logActionForRequest(
      user,
      'wiki_template',
      row.id,
      existing ? 'update' : 'create',
      { page_id: pageId, scope: this.scopeOf(row) },
    );
    return { ...row, scope: this.scopeOf(row) };
  }

  // ── Legacy rows (page_id NULL) ───────────────────────────────────────────

  /** Loads a legacy template the caller may manage from this space. */
  private async loadManageable(
    id: string,
    spaceId: string,
    user: RequestUser,
  ): Promise<TemplateRow> {
    await this.assertSpaceInOrg(spaceId, user);
    const r = await this.client
      .from(WikiTemplatesService.TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', user.organizationId)
      .is('page_id', null)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    const row = r.data as TemplateRow | null;
    if (!row || (row.space_id !== null && row.space_id !== spaceId)) {
      throw new NotFoundException(`Template ${id} not found`);
    }
    if (row.space_id === null) await this.assertTenantAdmin(user);
    return row;
  }

  async update(
    id: string,
    spaceId: string,
    user: RequestUser,
    dto: UpdateWikiTemplateDto,
  ) {
    await this.loadManageable(id, spaceId, user);
    const patch: Record<string, unknown> = { updated_by: user.userId };
    if (dto.name !== undefined) patch['name'] = dto.name.trim();
    if (dto.description !== undefined) patch['description'] = dto.description;
    if (dto.page_title !== undefined) patch['page_title'] = dto.page_title;
    if (dto.content !== undefined) {
      patch['content'] = validateTipTapDoc(dto.content).json;
    }
    const r = await this.client
      .from(WikiTemplatesService.TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', user.organizationId)
      .select('*')
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const row = r.data as TemplateRow;
    void this.auditLogs.logActionForRequest(
      user,
      'wiki_template',
      id,
      'update',
      { name: row['name'], scope: this.scopeOf(row) },
    );
    return { ...row, scope: this.scopeOf(row) };
  }

  async remove(id: string, spaceId: string, user: RequestUser): Promise<void> {
    const row = await this.loadManageable(id, spaceId, user);
    const { error } = await this.client
      .from(WikiTemplatesService.TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', user.organizationId);
    if (error) throw new BadRequestException(error.message);
    void this.auditLogs.logActionForRequest(
      user,
      'wiki_template',
      id,
      'delete',
      { name: row['name'], scope: this.scopeOf(row) },
    );
  }
}
