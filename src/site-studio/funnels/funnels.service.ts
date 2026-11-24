import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { RESERVED_SLUGS } from '../../common/constants/reserved-slugs';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  SiteTemplatesService,
  type SiteTemplateConfig,
} from '../templates/site-templates.service';
import type { ListFunnelsDto } from './dto/list-funnels.dto';
import type { CreateFunnelDto } from './dto/create-funnel.dto';
import type { UpdateFunnelDto } from './dto/update-funnel.dto';
import type { PublishFunnelDto } from './dto/publish-funnel.dto';

/**
 * Slugs a funnel must never claim.
 *
 * On-prem, a published funnel is served at `https://<app-host>/<slug>` (there are no
 * wildcard subdomains), so a funnel slug and a top-level application route share one
 * namespace. A funnel called `settings` would sit underneath — or shadow — the real
 * dashboard route, depending on which layer matched first.
 *
 * Kept deliberately as top-level segments only. Mirrors
 * `SITE_STUDIO_INTERNAL_PREFIXES` in risk-management-app/src/middleware.ts, which is
 * the authority on which paths stay behind the auth gate — update both together.
 * `RESERVED_SLUGS` is folded in as well, so a funnel cannot impersonate `www`, `api`,
 * `auth` … in the cloud's `{slug}.{root}` shape either.
 */
const RESERVED_FUNNEL_SLUGS: ReadonlySet<string> = new Set<string>([
  ...RESERVED_SLUGS,
  'admin',
  'api',
  'auth',
  'site-studio',
  'portfolios',
  'home',
  'tasks',
  'spaces',
  'settings',
  'filters',
  'processes',
  'onboarding',
  'user-profile',
  'dashboards',
  'gdpr',
  'plans',
  'checkout',
  'invitations',
  'help-center',
  'about',
  'apps',
  'dashboard',
  'filter-demo',
  'heatmap-config',
  'risk-configurations',
  'tenant-config',
  'select-tenant',
  'account-deactivated',
  'partner',
  'partners',
  'wiki',
  'files',
]);

/**
 * Reject a funnel subdomain/slug that would collide with an application route or a
 * reserved name. `null` (no slug) is always fine — the generated `preview_subdomain`
 * carries a random 6-char suffix and cannot collide.
 */
function assertUsableFunnelSlug(slug: string | null): void {
  if (!slug) return;

  const normalized = slug.trim().toLowerCase();

  if (!normalized) return;

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(normalized)) {
    throw new BadRequestException(
      'Subdomain may contain only lowercase letters, numbers and hyphens, and must start and end with a letter or number.',
    );
  }

  if (RESERVED_FUNNEL_SLUGS.has(normalized)) {
    throw new BadRequestException(
      `"${normalized}" is a reserved name and cannot be used as a site address. Choose another.`,
    );
  }
}

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Slugify a funnel name into a DNS-safe subdomain segment.
 * Mirrors `slugify()` in `src/utils/site-studio-url.ts` — the two must agree, since the frontend
 * builds the public URL from whatever this stores.
 */
function slugifyForSubdomain(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
}

/**
 * Generate a preview subdomain: `{name-slug}-{6-char-hash}` (e.g. `my-site-k3x9qz`).
 *
 * Lowercase-only alphabet: `preview_subdomain` is matched against a lowercased host label by
 * `resolvePublishedFunnelId()`, so an uppercase character would make the funnel unreachable.
 * The column is UNIQUE — callers must re-roll on a 23505.
 */
function generatePreviewSubdomain(name: string): string {
  const slug = slugifyForSubdomain(name) || 'site';
  let hash = '';

  for (let i = 0; i < 6; i++) {
    hash += BASE62[Math.floor(Math.random() * BASE62.length)];
  }

  return `${slug}-${hash}`;
}

export interface SiteStudioFunnel {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  sub_domain_name: string | null;

  // Generated at create time. The fallback address a funnel is served on when the author has not
  // set `sub_domain_name`; without it a published funnel has no public URL at all.
  preview_subdomain: string | null;
  favicon: string | null;
  published: boolean;
  live_products: Record<string, unknown>[];
  key: string | null;
  seo_title: string | null;
  seo_description: string | null;
  seo_image: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SiteStudioFunnelWithPages extends SiteStudioFunnel {
  pages: Record<string, unknown>[];
  _count: { pages: number; contacts: number };
}

export interface FunnelListResult {
  data: SiteStudioFunnelWithPages[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNextPage: boolean;
}

@Injectable()
export class FunnelsService {
  private static readonly FUNNELS_TABLE = 'site_studio_funnels';
  private static readonly PAGES_TABLE = 'site_studio_pages';
  private readonly logger = new Logger(FunnelsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
    private readonly siteTemplates: SiteTemplatesService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private logFunnelAction(
    organizationId: string,
    userId: string,
    funnelId: string,
    action: 'create' | 'update' | 'delete',
    changes?: Record<string, unknown>,
  ): void {
    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'site_studio_funnel',
      funnelId,
      action,
      changes,
    );
  }

  async getFunnels(
    organizationId: string,
    dto: ListFunnelsDto,
  ): Promise<FunnelListResult> {
    const page = dto.page ?? 1;
    const pageSize = dto.pageSize ?? 20;
    const { search, published } = dto;

    // 1. Count query for pagination
    let countQuery = this.client
      .from(FunnelsService.FUNNELS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId);

    if (search) {
      countQuery = countQuery.or(
        `name.ilike.%${search}%,description.ilike.%${search}%`,
      );
    }
    if (published !== undefined) {
      countQuery = countQuery.eq('published', published);
    }

    const { count: totalCount, error: countError } = await countQuery;
    if (countError) throw new BadRequestException(countError.message);

    // 2. Data query with page counts via embedded selects
    let dataQuery = this.client
      .from(FunnelsService.FUNNELS_TABLE)
      .select(
        '*, pages:site_studio_pages(count), contacts:site_studio_contacts(count)',
      )
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (search) {
      dataQuery = dataQuery.or(
        `name.ilike.%${search}%,description.ilike.%${search}%`,
      );
    }
    if (published !== undefined) {
      dataQuery = dataQuery.eq('published', published);
    }

    const { data: rows, error: dataError } = await dataQuery;
    if (dataError) throw new BadRequestException(dataError.message);

    const safeTotal = totalCount ?? 0;
    const totalPages = Math.ceil(safeTotal / pageSize);

    const data = ((rows ?? []) as Record<string, unknown>[]).map((row) => ({
      ...(row as unknown as SiteStudioFunnel),
      pages: [],
      _count: {
        pages:
          ((row['pages'] as Array<Record<string, unknown>> | null)?.[0] ?? {})[
            'count'
          ] ?? 0,
        contacts:
          ((row['contacts'] as Array<Record<string, unknown>> | null)?.[0] ??
            {})['count'] ?? 0,
      },
    })) as unknown as SiteStudioFunnelWithPages[];

    return {
      data,
      totalCount: safeTotal,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
    };
  }

  async createFunnel(
    organizationId: string,
    userId: string,
    dto: CreateFunnelDto,
  ): Promise<SiteStudioFunnel> {
    // Normalise: treat empty string as null — never insert "" for subdomain
    const subDomain = dto.sub_domain_name || null;

    assertUsableFunnelSlug(subDomain);

    // Load the template first, so a missing or another organization's template fails before
    // anything is created.
    const template = dto.template_id
      ? await this.siteTemplates.getConfig(dto.template_id, organizationId)
      : null;

    // Pre-check subdomain uniqueness before hitting the DB constraint
    if (subDomain) {
      const { count } = await this.client
        .from(FunnelsService.FUNNELS_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('sub_domain_name', subDomain);
      if ((count ?? 0) > 0) {
        throw new BadRequestException('Subdomain is already in use');
      }
    }

    const insertPayload: Record<string, unknown> = {
      organization_id: organizationId,
      created_by: userId,
      name: dto.name,
    };
    if (template) {
      insertPayload['theme'] = template.theme ?? null;
      insertPayload['favicon'] = template.favicon ?? null;
      insertPayload['seo_title'] = template.seo_title ?? null;
      insertPayload['seo_description'] = template.seo_description ?? null;
      insertPayload['seo_image'] = template.seo_image ?? null;
    }
    if (dto.description != null) insertPayload['description'] = dto.description;
    if (subDomain != null) insertPayload['sub_domain_name'] = subDomain;
    if (dto.favicon != null) insertPayload['favicon'] = dto.favicon;

    // Every funnel gets a generated preview subdomain so a published site is reachable immediately.
    // `sub_domain_name` is an optional field the author may leave blank, and without this the funnel
    // would have NO address at all: getProductionUrl() returns '' when both are null, and the editor
    // then silently hides its "visit site" link. (This generation used to live in the pre-NestJS
    // service layer and was lost in the migration — see src/utils/site-studio-url.ts.)
    insertPayload['preview_subdomain'] = generatePreviewSubdomain(dto.name);

    // Retry loop: each attempt lets the DB trigger increment the key sequence.
    // This self-heals a stale counter without any SQL migration needed.
    const MAX_ATTEMPTS = 10;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { data: funnel, error: funnelError } = (await this.client
        .from(FunnelsService.FUNNELS_TABLE)
        .insert(insertPayload)
        .select()
        .single()) as {
        data: Record<string, unknown> | null;
        error: { message: string; code: string } | null;
      };

      if (!funnelError) {
        return this.afterCreateFunnel(
          funnel as Record<string, unknown>,
          organizationId,
          userId,
          template,
          dto.template_id,
        );
      }

      if (funnelError.code === '23505') {
        // Only the author-supplied subdomain is worth surfacing — the other two unique columns
        // (funnel key, preview subdomain) are generated, so a clash there is ours to resolve.
        if (subDomain && funnelError.message.includes('sub_domain_name')) {
          throw new BadRequestException('Subdomain is already in use');
        }

        // Key sequence out of sync — retry so the trigger advances the counter.
        // Re-roll the preview subdomain too, so a hash collision self-heals on the next attempt.
        if (attempt === MAX_ATTEMPTS) {
          throw new BadRequestException(funnelError.message);
        }

        insertPayload['preview_subdomain'] = generatePreviewSubdomain(dto.name);
        continue;
      }

      throw new BadRequestException(funnelError.message);
    }
    // Unreachable — MAX_ATTEMPTS path throws inside the loop
    throw new BadRequestException('Failed to create funnel');
  }

  private async afterCreateFunnel(
    funnel: Record<string, unknown>,
    organizationId: string,
    userId: string,
    template: SiteTemplateConfig | null,
    templateId: string | undefined,
  ): Promise<SiteStudioFunnel> {
    const funnelId = funnel['id'] as string;

    try {
      if (template) {
        await this.siteTemplates.applyToFunnel(
          template,
          funnelId,
          organizationId,
          userId,
        );
      } else {
        const { error: pageError } = await this.client
          .from(FunnelsService.PAGES_TABLE)
          .insert({
            funnel_id: funnelId,
            organization_id: organizationId,
            name: 'Home',
            path_name: '',
            sort_order: 0,
            created_by: userId,
          });

        if (pageError) throw new BadRequestException(pageError.message);
      }
    } catch (error) {
      // These inserts share no transaction: remove the half-built site (its pages and form
      // fields cascade) so a failure never leaves a site without pages behind.
      const { error: cleanupError } = await this.client
        .from(FunnelsService.FUNNELS_TABLE)
        .delete()
        .eq('id', funnelId)
        .eq('organization_id', organizationId);

      if (cleanupError) {
        this.logger.error(
          `createFunnel: could not remove half-built funnel ${funnelId}: ${cleanupError.message}`,
        );
      }

      throw error;
    }

    this.logFunnelAction(organizationId, userId, funnelId, 'create', {
      name: funnel['name'],
      sub_domain_name: funnel['sub_domain_name'] ?? null,
      ...(templateId ? { template_id: templateId } : {}),
    });

    return funnel as unknown as SiteStudioFunnel;
  }

  async getFunnelById(
    funnelId: string,
    organizationId: string,
  ): Promise<SiteStudioFunnelWithPages> {
    // 1. Fetch funnel row
    const { data: funnel, error: funnelError } = (await this.client
      .from(FunnelsService.FUNNELS_TABLE)
      .select('*')
      .eq('id', funnelId)
      .eq('organization_id', organizationId)
      .single()) as {
      data: SiteStudioFunnel | null;
      error: { message: string; code: string } | null;
    };

    if (funnelError) {
      if (funnelError.code === 'PGRST116') {
        throw new NotFoundException('Funnel not found');
      }
      throw new BadRequestException(funnelError.message);
    }

    // 2. Fetch pages ordered by sort_order
    const { data: pages, error: pagesError } = await this.client
      .from(FunnelsService.PAGES_TABLE)
      .select('*')
      .eq('funnel_id', funnelId)
      .order('sort_order', { ascending: true });

    if (pagesError) throw new BadRequestException(pagesError.message);

    return {
      ...(funnel as unknown as SiteStudioFunnel),
      pages: (pages ?? []) as Record<string, unknown>[],
      _count: { pages: (pages ?? []).length, contacts: 0 },
    } as unknown as SiteStudioFunnelWithPages;
  }

  async updateFunnel(
    funnelId: string,
    organizationId: string,
    userId: string,
    dto: UpdateFunnelDto,
  ): Promise<SiteStudioFunnel> {
    assertUsableFunnelSlug(dto.sub_domain_name ?? null);

    // 1. If subdomain is being set, verify it is not taken by another funnel in this org
    if (dto.sub_domain_name) {
      const { count, error: countError } = await this.client
        .from(FunnelsService.FUNNELS_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('sub_domain_name', dto.sub_domain_name)
        .neq('id', funnelId);

      if (countError) throw new BadRequestException(countError.message);
      if ((count ?? 0) > 0) {
        throw new BadRequestException('Subdomain is already in use');
      }
    }

    // 2. Build patch — only include fields explicitly provided in dto
    const patch: Record<string, unknown> = { updated_by: userId };
    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.description !== undefined) patch['description'] = dto.description;
    if (dto.sub_domain_name !== undefined)
      patch['sub_domain_name'] = dto.sub_domain_name;
    if (dto.favicon !== undefined) patch['favicon'] = dto.favicon;
    if (dto.published !== undefined) patch['published'] = dto.published;
    if (dto.live_products !== undefined)
      patch['live_products'] = dto.live_products;
    if (dto.seo_title !== undefined) patch['seo_title'] = dto.seo_title;
    if (dto.seo_description !== undefined)
      patch['seo_description'] = dto.seo_description;
    if (dto.seo_image !== undefined) patch['seo_image'] = dto.seo_image;
    if (dto.theme !== undefined) patch['theme'] = dto.theme;

    // 3. Update
    const { data: funnel, error } = (await this.client
      .from(FunnelsService.FUNNELS_TABLE)
      .update(patch)
      .eq('id', funnelId)
      .eq('organization_id', organizationId)
      .select()
      .single()) as {
      data: SiteStudioFunnel | null;
      error: { message: string; code: string } | null;
    };

    if (error) {
      if (error.code === 'PGRST116')
        throw new NotFoundException('Funnel not found');
      if (error.code === '23505')
        throw new BadRequestException('Subdomain is already in use');
      throw new BadRequestException(error.message);
    }

    this.logFunnelAction(organizationId, userId, funnelId, 'update', patch);
    return funnel as unknown as SiteStudioFunnel;
  }

  async deleteFunnel(
    funnelId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    // Verify funnel belongs to this org before deleting
    const { data: existing, error: checkError } = await this.client
      .from(FunnelsService.FUNNELS_TABLE)
      .select('id, name, sub_domain_name')
      .eq('id', funnelId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (checkError) throw new BadRequestException(checkError.message);
    if (!existing) throw new NotFoundException('Funnel not found');

    const { error } = await this.client
      .from(FunnelsService.FUNNELS_TABLE)
      .delete()
      .eq('id', funnelId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    this.logFunnelAction(organizationId, userId, funnelId, 'delete', {
      name: (existing as Record<string, unknown>)['name'],
      sub_domain_name:
        (existing as Record<string, unknown>)['sub_domain_name'] ?? null,
    });
  }

  async publishFunnel(
    funnelId: string,
    organizationId: string,
    userId: string,
    dto: PublishFunnelDto,
  ): Promise<SiteStudioFunnel> {
    // 1. Fetch current funnel
    const { data: current, error: fetchError } = await this.client
      .from(FunnelsService.FUNNELS_TABLE)
      .select('id, published')
      .eq('id', funnelId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (fetchError) throw new BadRequestException(fetchError.message);
    if (!current) throw new NotFoundException('Funnel not found');

    // 2. Determine target state: explicit value or toggle
    const newPublished =
      dto.published !== undefined
        ? dto.published
        : !(current as Record<string, unknown>)['published'];

    // 3. Guard: cannot publish a funnel with no pages
    if (newPublished && !(current as Record<string, unknown>)['published']) {
      const { count, error: countError } = await this.client
        .from(FunnelsService.PAGES_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('funnel_id', funnelId)
        .eq('organization_id', organizationId);

      if (countError) throw new BadRequestException(countError.message);
      if ((count ?? 0) === 0) {
        throw new BadRequestException('Cannot publish a funnel with no pages');
      }
    }

    // 4. Cascade publish/unpublish to all pages
    const { error: pageError } = await this.client
      .from(FunnelsService.PAGES_TABLE)
      .update({ published: newPublished })
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId);

    if (pageError) throw new BadRequestException(pageError.message);

    // 5. Update funnel published state
    const { data: funnel, error } = (await this.client
      .from(FunnelsService.FUNNELS_TABLE)
      .update({ published: newPublished, updated_by: userId })
      .eq('id', funnelId)
      .eq('organization_id', organizationId)
      .select()
      .single()) as {
      data: SiteStudioFunnel | null;
      error: { message: string; code: string } | null;
    };

    if (error) {
      if (error.code === 'PGRST116')
        throw new NotFoundException('Funnel not found');
      throw new BadRequestException(error.message);
    }

    this.logFunnelAction(organizationId, userId, funnelId, 'update', {
      published: newPublished,
    });
    return funnel as unknown as SiteStudioFunnel;
  }
}
