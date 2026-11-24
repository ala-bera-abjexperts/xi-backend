import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  SiteTemplatesService,
  type SiteTemplateConfig,
} from './site-templates.service';

type TerminalResult = { data?: unknown; error?: unknown };
type InsertedRow = Record<string, unknown>;

/** First argument of a mock's first call. */
const firstArg = (mock: jest.Mock): unknown =>
  (mock.mock.calls as unknown[][])[0][0];

function createQuery(result: TerminalResult) {
  const query: Record<string, jest.Mock> = {
    select: jest.fn(() => query),
    eq: jest.fn(() => query),
    order: jest.fn(() => query),
    insert: jest.fn(() => query),
    delete: jest.fn(() => query),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    single: jest.fn(() => Promise.resolve(result)),
    then: jest.fn((resolve: (value: TerminalResult) => unknown) =>
      Promise.resolve(result).then(resolve),
    ),
  };

  return query;
}

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

  return {
    service: new SiteTemplatesService(
      { getClient: () => client } as any,
      auditLogsService as any,
    ),
    tables,
    auditLogsService,
  };
}

const page = (name: string, path_name: string, sort_order: number) => ({
  name,
  path_name,
  sort_order,
  content: [{ id: '__body', type: '__body', content: [] }],
  seo_title: `${name} title`,
  seo_description: null,
  seo_image: null,
});

const formField = {
  element_id: 'form-1',
  field_name: 'email',
  field_type: 'email',
  label: 'Email',
  placeholder: null,
  required: true,
  options: null,
  validation_rules: null,
  sort_order: 0,
};

const config = (
  overrides: Partial<SiteTemplateConfig> = {},
): SiteTemplateConfig => ({
  version: 1,
  theme: { primary: '#000000' },
  favicon: 'https://cdn.example.test/favicon.png',
  seo_title: 'Site',
  seo_description: null,
  seo_image: null,
  pages: [page('Home', '', 0)],
  form_fields: [],
  ...overrides,
});

describe('SiteTemplatesService', () => {
  describe('createFromFunnel', () => {
    it('snapshots theme, SEO, pages and form fields of an own-org site, and nothing else', async () => {
      const funnelQuery = createQuery({
        data: {
          theme: { primary: '#123456' },
          favicon: null,
          seo_title: 'Landing',
          seo_description: 'Desc',
          seo_image: null,
        },
      });
      const pagesQuery = createQuery({
        data: [page('Home', '', 0), page('About', 'about', 1)],
      });
      const fieldsQuery = createQuery({ data: [formField] });
      const insertQuery = createQuery({
        data: {
          id: 'tpl-1',
          name: 'Landing kit',
          description: null,
          config: { pages: [page('Home', '', 0), page('About', 'about', 1)] },
          created_by: 'user-1',
          created_at: '2026-09-22T00:00:00Z',
        },
      });
      const { service, tables, auditLogsService } = createService([
        funnelQuery,
        pagesQuery,
        fieldsQuery,
        insertQuery,
      ]);

      const summary = await service.createFromFunnel(
        'funnel-1',
        'org-1',
        'user-1',
        {
          name: '  Landing kit  ',
          description: '   ',
        },
      );

      expect(tables).toEqual([
        'site_studio_funnels',
        'site_studio_pages',
        'site_studio_form_fields',
        'site_studio_templates',
      ]);
      // Every read is scoped to the caller's organization.
      for (const query of [funnelQuery, pagesQuery, fieldsQuery]) {
        expect(query.eq).toHaveBeenCalledWith('organization_id', 'org-1');
      }
      expect(firstArg(insertQuery.insert)).toEqual({
        organization_id: 'org-1',
        name: 'Landing kit',
        description: null,
        config: {
          version: 1,
          theme: { primary: '#123456' },
          favicon: null,
          seo_title: 'Landing',
          seo_description: 'Desc',
          seo_image: null,
          pages: [page('Home', '', 0), page('About', 'about', 1)],
          form_fields: [formField],
        },
        created_by: 'user-1',
      });
      expect(summary).toEqual({
        id: 'tpl-1',
        name: 'Landing kit',
        description: null,
        page_count: 2,
        page_names: ['Home', 'About'],
        created_by: 'user-1',
        created_at: '2026-09-22T00:00:00Z',
      });
      expect(auditLogsService.logAction).toHaveBeenCalledWith(
        'org-1',
        'user-1',
        'site_studio_template',
        'tpl-1',
        'create',
        { name: 'Landing kit', source_funnel_id: 'funnel-1', page_count: 2 },
      );
    });

    it('refuses a site of another organization before reading anything else', async () => {
      const { service, tables } = createService([createQuery({ data: null })]);

      await expect(
        service.createFromFunnel('funnel-x', 'org-1', 'user-1', {
          name: 'Kit',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tables).toEqual(['site_studio_funnels']);
    });

    it('reports a duplicate name as a conflict', async () => {
      const { service } = createService([
        createQuery({ data: { theme: null } }),
        createQuery({ data: [] }),
        createQuery({ data: [] }),
        createQuery({
          data: null,
          error: { code: '23505', message: 'duplicate key' },
        }),
      ]);

      await expect(
        service.createFromFunnel('funnel-1', 'org-1', 'user-1', {
          name: 'Kit',
        }),
      ).rejects.toEqual(
        new ConflictException('A template with this name already exists'),
      );
    });
  });

  it('lists summaries without page content', async () => {
    const listQuery = createQuery({
      data: [
        {
          id: 'tpl-1',
          name: 'Kit',
          description: 'd',
          config: config({
            pages: [page('Home', '', 0), page('Team', 'about/team', 2)],
          }),
          created_by: null,
          created_at: 'now',
        },
      ],
    });
    const { service } = createService([listQuery]);

    const templates = await service.listTemplates('org-1');

    expect(listQuery.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(templates).toEqual([
      {
        id: 'tpl-1',
        name: 'Kit',
        description: 'd',
        page_count: 2,
        page_names: ['Home', 'Team'],
        created_by: null,
        created_at: 'now',
      },
    ]);
    expect(JSON.stringify(templates)).not.toContain('__body');
  });

  describe('deleteTemplate', () => {
    it('deletes only within the organization', async () => {
      const deleteQuery = createQuery({ data: [{ id: 'tpl-1', name: 'Kit' }] });
      const { service, auditLogsService } = createService([deleteQuery]);

      await service.deleteTemplate('tpl-1', 'org-1', 'user-1');

      expect(deleteQuery.eq).toHaveBeenCalledWith('id', 'tpl-1');
      expect(deleteQuery.eq).toHaveBeenCalledWith('organization_id', 'org-1');
      expect(auditLogsService.logAction).toHaveBeenCalledWith(
        'org-1',
        'user-1',
        'site_studio_template',
        'tpl-1',
        'delete',
        { name: 'Kit' },
      );
    });

    it('is a 404 when nothing of this organization matched', async () => {
      const { service, auditLogsService } = createService([
        createQuery({ data: [] }),
      ]);

      await expect(
        service.deleteTemplate('tpl-x', 'org-1', 'user-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(auditLogsService.logAction).not.toHaveBeenCalled();
    });
  });

  describe('getConfig', () => {
    it('is a 404 for a missing or other-organization template', async () => {
      const query = createQuery({ data: null });
      const { service } = createService([query]);

      await expect(service.getConfig('tpl-x', 'org-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(query.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    });

    it('rejects a damaged snapshot instead of building a broken site', async () => {
      const { service } = createService([
        createQuery({ data: { config: { pages: [{ name: 1 }] } } }),
      ]);

      await expect(service.getConfig('tpl-1', 'org-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('applyToFunnel', () => {
    it('inserts parents before children, as unpublished drafts, then the form fields', async () => {
      const inserts: InsertedRow[][] = [];
      const queries = [
        createQuery({}),
        createQuery({}),
        createQuery({}),
        createQuery({}),
      ];
      for (const query of queries) {
        query.insert.mockImplementation((rows: InsertedRow[]) => {
          inserts.push(rows);
          return query;
        });
      }
      const { service, tables } = createService(queries);

      await service.applyToFunnel(
        config({
          pages: [
            page('Team', 'about/team', 3),
            page('About', 'about', 2),
            page('Home', '', 0),
            page('Pricing', 'pricing', 1),
          ],
          form_fields: [formField],
        }),
        'funnel-new',
        'org-1',
        'user-1',
      );

      expect(tables).toEqual([
        'site_studio_pages',
        'site_studio_pages',
        'site_studio_pages',
        'site_studio_form_fields',
      ]);
      const paths = inserts
        .slice(0, 3)
        .map((rows) => rows.map((row) => row.path_name));
      expect(paths).toEqual([[''], ['about', 'pricing'], ['about/team']]);
      for (const row of inserts.slice(0, 3).flat()) {
        expect(row).toMatchObject({
          funnel_id: 'funnel-new',
          organization_id: 'org-1',
          published: false,
          created_by: 'user-1',
        });
      }
      expect(inserts[1][0].sort_order).toBe(2);
      expect(inserts[3]).toEqual([
        { ...formField, organization_id: 'org-1', funnel_id: 'funnel-new' },
      ]);
    });

    it('adds a blank Home page when the snapshot has no landing page, and skips empty form fields', async () => {
      const inserts: InsertedRow[][] = [];
      const queries = [createQuery({}), createQuery({})];
      for (const query of queries) {
        query.insert.mockImplementation((rows: InsertedRow[]) => {
          inserts.push(rows);
          return query;
        });
      }
      const { service, tables } = createService(queries);

      await service.applyToFunnel(
        config({ pages: [page('About', 'about', 1)] }),
        'funnel-new',
        'org-1',
        'user-1',
      );

      expect(tables).toEqual(['site_studio_pages', 'site_studio_pages']);
      expect(inserts[0]).toEqual([
        expect.objectContaining({
          name: 'Home',
          path_name: '',
          content: null,
          sort_order: 0,
        }),
      ]);
    });

    it('throws on a failed insert so the caller can remove the site', async () => {
      const { service } = createService([
        createQuery({ error: { message: 'duplicate key value' } }),
      ]);

      await expect(
        service.applyToFunnel(config(), 'funnel-new', 'org-1', 'user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
