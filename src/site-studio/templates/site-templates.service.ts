import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { SaveSiteAsTemplateDto } from './dto/save-site-as-template.dto';

/**
 * A site template is a frozen, org-scoped snapshot of a site: its theme and SEO, its pages
 * (name, path, order, content, SEO) and its form-field definitions. Creating a site copies the
 * snapshot and nothing links the two afterwards, so editing or deleting either one never
 * changes the other. Names, addresses, publish state, domains, contacts, analytics and Stripe
 * products are never part of it.
 *
 * Images inside page content are kept as URLs, like page duplication does.
 * ponytail: shared image URLs break if the source site deletes that image; copy the media objects
 * on save/apply if that becomes a problem.
 */

export interface SiteTemplatePage {
  name: string;
  path_name: string;
  sort_order: number;
  content: unknown;
  seo_title: string | null;
  seo_description: string | null;
  seo_image: string | null;
}

export interface SiteTemplateFormField {
  element_id: string;
  field_name: string;
  field_type: string;
  label: string;
  placeholder: string | null;
  required: boolean;
  options: unknown;
  validation_rules: unknown;
  sort_order: number;
}

export interface SiteTemplateConfig {
  version: 1;
  theme: unknown;
  favicon: string | null;
  seo_title: string | null;
  seo_description: string | null;
  seo_image: string | null;
  pages: SiteTemplatePage[];
  form_fields: SiteTemplateFormField[];
}

export interface SiteTemplateSummary {
  id: string;
  name: string;
  description: string | null;
  page_count: number;
  page_names: string[];
  created_by: string | null;
  created_at: string;
}

interface SiteTemplateRow {
  id: string;
  name: string;
  description: string | null;
  config: SiteTemplateConfig;
  created_by: string | null;
  created_at: string;
}

const TEMPLATES_TABLE = 'site_studio_templates';
const FUNNELS_TABLE = 'site_studio_funnels';
const PAGES_TABLE = 'site_studio_pages';
const FORM_FIELDS_TABLE = 'site_studio_form_fields';

const ROW_COLUMNS = 'id, name, description, config, created_by, created_at';
const PAGE_COLUMNS =
  'name, path_name, sort_order, content, seo_title, seo_description, seo_image';
const FORM_FIELD_COLUMNS =
  'element_id, field_name, field_type, label, placeholder, required, options, validation_rules, sort_order';

function toSummary(row: SiteTemplateRow): SiteTemplateSummary {
  const pages = Array.isArray(row.config?.pages) ? row.config.pages : [];

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    page_count: pages.length,
    page_names: pages.map((page) => page.name),
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

/** Nesting level of a page path: '' (landing) is 0, 'a' is 1, 'a/b' is 2. */
function pathDepth(pathName: string): number {
  return pathName === '' ? 0 : pathName.split('/').length;
}

@Injectable()
export class SiteTemplatesService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Templates of the organization, as summaries (the page content stays on the server). */
  async listTemplates(organizationId: string): Promise<SiteTemplateSummary[]> {
    // ponytail: summaries are derived from each full config; add summary columns if an
    // organization keeps hundreds of templates.
    const { data, error } = await this.client
      .from(TEMPLATES_TABLE)
      .select(ROW_COLUMNS)
      .eq('organization_id', organizationId)
      .order('name', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    return ((data ?? []) as SiteTemplateRow[]).map(toSummary);
  }

  /** Snapshot a site of the caller's organization into a new template. */
  async createFromFunnel(
    funnelId: string,
    organizationId: string,
    userId: string,
    dto: SaveSiteAsTemplateDto,
  ): Promise<SiteTemplateSummary> {
    const config = await this.buildConfig(funnelId, organizationId);

    const { data, error } = (await this.client
      .from(TEMPLATES_TABLE)
      .insert({
        organization_id: organizationId,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        config,
        created_by: userId,
      })
      .select(ROW_COLUMNS)
      .single()) as {
      data: SiteTemplateRow | null;
      error: { message: string; code: string } | null;
    };

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException('A template with this name already exists');
      }
      throw new BadRequestException(error.message);
    }

    const template = data as SiteTemplateRow;

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'site_studio_template',
      template.id,
      'create',
      {
        name: template.name,
        source_funnel_id: funnelId,
        page_count: config.pages.length,
      },
    );

    return toSummary(template);
  }

  /** Delete a template. Sites created from it are independent copies and stay as they are. */
  async deleteTemplate(
    templateId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from(TEMPLATES_TABLE)
      .delete()
      .eq('id', templateId)
      .eq('organization_id', organizationId)
      .select('id, name');

    if (error) throw new BadRequestException(error.message);
    if (!data?.length) throw new NotFoundException('Template not found');

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'site_studio_template',
      templateId,
      'delete',
      { name: (data[0] as { name: string }).name },
    );
  }

  /** The snapshot to build a new site from. Missing and other organizations' templates are a 404. */
  async getConfig(
    templateId: string,
    organizationId: string,
  ): Promise<SiteTemplateConfig> {
    const { data, error } = await this.client
      .from(TEMPLATES_TABLE)
      .select('config')
      .eq('id', templateId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Template not found');

    const config = (data as { config: SiteTemplateConfig }).config;
    const pagesValid =
      Array.isArray(config?.pages) &&
      config.pages.every(
        (page) =>
          typeof page?.name === 'string' && typeof page?.path_name === 'string',
      );

    if (!pagesValid) {
      throw new BadRequestException(
        'This template is damaged and cannot be used',
      );
    }

    return { ...config, form_fields: config.form_fields ?? [] };
  }

  /**
   * Write a template's pages and form fields into a freshly created, still empty site.
   * Not transactional: the caller deletes the site if this throws (pages and fields cascade).
   */
  async applyToFunnel(
    config: SiteTemplateConfig,
    funnelId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const pages = config.pages.some((page) => page.path_name === '')
      ? config.pages
      : [
          {
            name: 'Home',
            path_name: '',
            sort_order: 0,
            content: null,
            seo_title: null,
            seo_description: null,
            seo_image: null,
          },
          ...config.pages,
        ];

    // Parents before children, one insert per nesting level: in production an insert trigger
    // derives each page's parent from its path, so the parent row must already exist.
    const depths = [
      ...new Set(pages.map((page) => pathDepth(page.path_name))),
    ].sort((left, right) => left - right);

    for (const depth of depths) {
      const { error } = await this.client.from(PAGES_TABLE).insert(
        pages
          .filter((page) => pathDepth(page.path_name) === depth)
          .map((page) => ({
            funnel_id: funnelId,
            organization_id: organizationId,
            name: page.name,
            path_name: page.path_name,
            sort_order: page.sort_order ?? 0,
            content: page.content ?? null,
            seo_title: page.seo_title ?? null,
            seo_description: page.seo_description ?? null,
            seo_image: page.seo_image ?? null,
            published: false,
            created_by: userId,
          })),
      );

      if (error) throw new BadRequestException(error.message);
    }

    if (config.form_fields.length === 0) return;

    const { error } = await this.client.from(FORM_FIELDS_TABLE).insert(
      config.form_fields.map((field) => ({
        ...field,
        organization_id: organizationId,
        funnel_id: funnelId,
      })),
    );

    if (error) throw new BadRequestException(error.message);
  }

  private async buildConfig(
    funnelId: string,
    organizationId: string,
  ): Promise<SiteTemplateConfig> {
    // The source site must belong to the caller's organization, or a user could snapshot
    // another tenant's site into their own template.
    const { data: funnel, error: funnelError } = await this.client
      .from(FUNNELS_TABLE)
      .select('theme, favicon, seo_title, seo_description, seo_image')
      .eq('id', funnelId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (funnelError) throw new BadRequestException(funnelError.message);
    if (!funnel) throw new NotFoundException('Funnel not found');

    const [pagesResult, fieldsResult] = await Promise.all([
      this.client
        .from(PAGES_TABLE)
        .select(PAGE_COLUMNS)
        .eq('funnel_id', funnelId)
        .eq('organization_id', organizationId)
        .order('sort_order', { ascending: true }),
      this.client
        .from(FORM_FIELDS_TABLE)
        .select(FORM_FIELD_COLUMNS)
        .eq('funnel_id', funnelId)
        .eq('organization_id', organizationId)
        .order('sort_order', { ascending: true }),
    ]);

    if (pagesResult.error)
      throw new BadRequestException(pagesResult.error.message);
    if (fieldsResult.error)
      throw new BadRequestException(fieldsResult.error.message);

    const source = funnel as Omit<
      SiteTemplateConfig,
      'version' | 'pages' | 'form_fields'
    >;

    return {
      version: 1,
      theme: source.theme ?? null,
      favicon: source.favicon ?? null,
      seo_title: source.seo_title ?? null,
      seo_description: source.seo_description ?? null,
      seo_image: source.seo_image ?? null,
      pages: (pagesResult.data ?? []) as SiteTemplatePage[],
      form_fields: (fieldsResult.data ?? []) as SiteTemplateFormField[],
    };
  }
}
