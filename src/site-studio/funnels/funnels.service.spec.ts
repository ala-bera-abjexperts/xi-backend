import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FunnelsService } from './funnels.service';
import type { SiteTemplateConfig } from '../templates/site-templates.service';

/** First argument of a mock's first call. */
const firstArg = (mock: jest.Mock): unknown =>
  (mock.mock.calls as unknown[][])[0][0];

type TerminalResult = {
  data?: unknown;
  error?: unknown;
  count?: number | null;
};

function createQuery(result: TerminalResult) {
  const query: Record<string, jest.Mock> = {
    select: jest.fn(() => query),
    eq: jest.fn(() => query),
    insert: jest.fn(() => query),
    delete: jest.fn(() => query),
    single: jest.fn(() => Promise.resolve(result)),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: jest.fn((resolve: (value: TerminalResult) => unknown) =>
      Promise.resolve(result).then(resolve),
    ),
  };

  return query;
}

const template: SiteTemplateConfig = {
  version: 1,
  theme: { primary: '#ff0000' },
  favicon: 'https://cdn.example.test/template.png',
  seo_title: 'Template SEO',
  seo_description: 'Template description',
  seo_image: null,
  pages: [],
  form_fields: [],
};

function createService(queries: Record<string, jest.Mock>[]) {
  const tables: string[] = [];
  const client = {
    from: jest.fn((table: string) => {
      tables.push(table);
      const query = queries.shift();

      if (!query) throw new Error(`Unexpected Supabase query on ${table}`);

      return query;
    }),
  };
  const auditLogsService = {
    logAction: jest.fn().mockResolvedValue(undefined),
  };
  const siteTemplates = {
    getConfig: jest.fn().mockResolvedValue(template),
    applyToFunnel: jest.fn().mockResolvedValue(undefined),
  };

  return {
    service: new FunnelsService(
      { getClient: () => client } as any,
      auditLogsService as any,
      siteTemplates as any,
    ),
    tables,
    siteTemplates,
    auditLogsService,
  };
}

const createdFunnel = { id: 'funnel-1', name: 'Site', sub_domain_name: null };

describe('FunnelsService.createFunnel', () => {
  it('without a template creates only the blank Home page, as before', async () => {
    const funnelInsert = createQuery({ data: createdFunnel, error: null });
    const homeInsert = createQuery({ error: null });
    const { service, tables, siteTemplates } = createService([
      funnelInsert,
      homeInsert,
    ]);

    await service.createFunnel('org-1', 'user-1', { name: 'Site' });

    expect(siteTemplates.getConfig).not.toHaveBeenCalled();
    expect(siteTemplates.applyToFunnel).not.toHaveBeenCalled();
    expect(tables).toEqual(['site_studio_funnels', 'site_studio_pages']);
    expect(firstArg(funnelInsert.insert)).not.toHaveProperty('theme');
    expect(homeInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Home',
        path_name: '',
        funnel_id: 'funnel-1',
      }),
    );
  });

  it('with a template copies its theme and SEO, lets an explicit favicon win, and applies its pages', async () => {
    const funnelInsert = createQuery({ data: createdFunnel, error: null });
    const { service, tables, siteTemplates, auditLogsService } = createService([
      funnelInsert,
    ]);

    await service.createFunnel('org-1', 'user-1', {
      name: 'Site',
      favicon: 'https://cdn.example.test/mine.png',
      template_id: 'tpl-1',
    });

    expect(siteTemplates.getConfig).toHaveBeenCalledWith('tpl-1', 'org-1');
    expect(firstArg(funnelInsert.insert)).toMatchObject({
      organization_id: 'org-1',
      name: 'Site',
      theme: { primary: '#ff0000' },
      favicon: 'https://cdn.example.test/mine.png',
      seo_title: 'Template SEO',
      seo_description: 'Template description',
    });
    expect(siteTemplates.applyToFunnel).toHaveBeenCalledWith(
      template,
      'funnel-1',
      'org-1',
      'user-1',
    );
    // The template writes the pages; no blank Home page on top.
    expect(tables).toEqual(['site_studio_funnels']);
    expect(auditLogsService.logAction).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'site_studio_funnel',
      'funnel-1',
      'create',
      expect.objectContaining({ template_id: 'tpl-1' }),
    );
  });

  it('refuses a missing or other-organization template before creating anything', async () => {
    const { service, tables, siteTemplates } = createService([]);
    siteTemplates.getConfig.mockRejectedValueOnce(
      new NotFoundException('Template not found'),
    );

    await expect(
      service.createFunnel('org-1', 'user-1', {
        name: 'Site',
        template_id: 'tpl-x',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tables).toEqual([]);
  });

  it('removes the new site when applying the template fails', async () => {
    const cleanup = createQuery({ error: null });
    const { service, tables, siteTemplates } = createService([
      createQuery({ data: createdFunnel, error: null }),
      cleanup,
    ]);
    siteTemplates.applyToFunnel.mockRejectedValueOnce(
      new BadRequestException('insert failed'),
    );

    await expect(
      service.createFunnel('org-1', 'user-1', {
        name: 'Site',
        template_id: 'tpl-1',
      }),
    ).rejects.toThrow('insert failed');
    expect(tables).toEqual(['site_studio_funnels', 'site_studio_funnels']);
    expect(cleanup.delete).toHaveBeenCalled();
    expect(cleanup.eq).toHaveBeenCalledWith('id', 'funnel-1');
    expect(cleanup.eq).toHaveBeenCalledWith('organization_id', 'org-1');
  });

  it('removes the new site when the blank Home page cannot be created', async () => {
    const cleanup = createQuery({ error: null });
    const { service, tables } = createService([
      createQuery({ data: createdFunnel, error: null }),
      createQuery({ error: { message: 'page insert failed' } }),
      cleanup,
    ]);

    await expect(
      service.createFunnel('org-1', 'user-1', { name: 'Site' }),
    ).rejects.toThrow('page insert failed');
    expect(tables).toEqual([
      'site_studio_funnels',
      'site_studio_pages',
      'site_studio_funnels',
    ]);
    expect(cleanup.delete).toHaveBeenCalled();
  });
});
