/**
 * @fileoverview Scope, permission and tenant-isolation rules for wiki templates
 * (template pages under a space's Templates root, plus legacy rows).
 * @module src/wiki/wiki-templates.service.spec
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  TEMPLATES_ROOT_SYSTEM,
  WikiTemplatesService,
} from './wiki-templates.service';

import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { WikiService } from './wiki.service';
import type { WikiPermissionsService } from './wiki-permissions.service';

type Result = { data: unknown; error: null };
type Chain = Record<string, jest.Mock> & {
  then: (r: (v: unknown) => unknown) => Promise<unknown>;
};

/** Thenable query chain that records calls; every terminal resolves to `result`. */
function chain(result: Result): Chain {
  const c = {} as Chain;
  for (const m of [
    'select',
    'insert',
    'update',
    'delete',
    'eq',
    'or',
    'in',
    'is',
    'order',
  ]) {
    c[m] = jest.fn(() => c);
  }
  c.maybeSingle = jest.fn(() => Promise.resolve(result));
  c.single = jest.fn(() => Promise.resolve(result));
  c.then = (resolve) => Promise.resolve(result).then(resolve);
  return c;
}

const ORG = 'org-1';
const SPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_SPACE = '22222222-2222-4222-8222-222222222222';
const ROOT = 'root-1';
const USER = { userId: 'user-1', organizationId: ORG } as never;

/**
 * `results[table]` is consumed one query at a time; a table with no queued result
 * answers `{ data: null }`. The `spaces` table defaults to "space is in the org".
 */
function setup(
  results: Record<string, unknown[]> = {},
  opts: { admin?: boolean; accessible?: (pages: unknown[]) => unknown[] } = {},
) {
  const queues: Record<string, unknown[]> = {
    spaces: [{ id: SPACE }],
    ...results,
  };
  const chains: Record<string, Chain[]> = {};
  const from = jest.fn((table: string) => {
    const data = queues[table]?.length ? queues[table].shift() : null;
    const c = chain({ data, error: null });
    (chains[table] ??= []).push(c);
    return c;
  });
  const wiki = {
    createPage: jest.fn((dto: { title: string }) =>
      Promise.resolve({ id: dto.title === 'Templates' ? ROOT : 'new-page' }),
    ),
    getPageById: jest.fn().mockResolvedValue({
      content: '{"type":"doc"}',
      content_format: 'tiptap',
    }),
  };
  const pagePerms = {
    assertPageAccess: jest.fn().mockResolvedValue(undefined),
    assertSpaceCanCreate: jest.fn().mockResolvedValue(undefined),
    filterAccessiblePages: jest.fn((pages: unknown[]) =>
      Promise.resolve(opts.accessible ? opts.accessible(pages) : pages),
    ),
  };
  const service = new WikiTemplatesService(
    { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
    {
      isAdminOrOwner: jest.fn().mockResolvedValue(opts.admin ?? false),
    } as unknown as PermissionsService,
    {
      logActionForRequest: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditLogsService,
    wiki as unknown as WikiService,
    pagePerms as unknown as WikiPermissionsService,
  );
  return { service, chains, wiki, pagePerms };
}

const templatePage = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  title: 'Meeting notes',
  space_id: SPACE,
  parent_id: ROOT,
  path: [ROOT],
  created_by: 'user-1',
  updated_at: '2026-11-10T00:00:00Z',
  content: '{"type":"doc"}',
  content_format: 'tiptap',
  is_archived: false,
  ...over,
});

describe('WikiTemplatesService', () => {
  describe('list', () => {
    it('offers visible space pages, tenant pages of any space and legacy rows', async () => {
      const { service, chains, pagePerms } = setup(
        {
          spaces: [
            { id: SPACE },
            [
              { id: SPACE, key: 'S' },
              { id: OTHER_SPACE, key: 'O' },
            ],
          ],
          wiki_templates: [
            [
              {
                id: 'r-t',
                page_id: 'p-tenant',
                space_id: null,
                page_title: 'T {{date}}',
              },
              { id: 'legacy', page_id: null, space_id: SPACE, name: 'Old' },
            ],
          ],
          wiki_pages: [
            [{ id: ROOT, space_id: SPACE }],
            [
              templatePage({ id: 'p-space', title: 'B space' }),
              templatePage({ id: 'p-hidden', title: 'Hidden' }),
              templatePage({
                id: 'p-tenant',
                title: 'A tenant',
                space_id: OTHER_SPACE,
              }),
              templatePage({ id: 'p-elsewhere', space_id: OTHER_SPACE }),
            ],
          ],
        },
        {
          accessible: (pages) =>
            (pages as { id: string }[]).filter((p) => p.id !== 'p-hidden'),
        },
      );

      const items = await service.list(SPACE, USER);

      expect(chains.wiki_templates[0].or).toHaveBeenCalledWith(
        `space_id.is.null,space_id.eq.${SPACE}`,
      );
      expect(chains.wiki_pages[0].eq).toHaveBeenCalledWith(
        'metadata->>system',
        TEMPLATES_ROOT_SYSTEM,
      );
      expect(chains.wiki_pages[1].in).toHaveBeenCalledWith('parent_id', [ROOT]);
      // Only this space's non-tenant pages go through the page ACL filter
      expect(
        (
          pagePerms.filterAccessiblePages.mock.calls[0][0] as { id: string }[]
        ).map((p) => p.id),
      ).toEqual(['p-space', 'p-hidden']);
      expect(
        items.map((i) => [i.id, i.scope, i.name, i.space_key, i.page_title]),
      ).toEqual([
        ['p-space', 'space', 'B space', 'S', null],
        ['legacy', 'space', 'Old', null, null],
        ['p-tenant', 'tenant', 'A tenant', 'O', 'T {{date}}'],
      ]);
    });

    it('rejects a space from another org', async () => {
      const { service } = setup({ spaces: [null] });
      await expect(service.list(SPACE, USER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('getContent', () => {
    it('space template: same space only, and needs can_view on the page', async () => {
      const ok = setup({
        wiki_templates: [
          null,
          { id: 'r', page_id: 'p1', space_id: SPACE, page_title: 'X' },
        ],
        wiki_pages: [templatePage(), [{ id: ROOT, space_id: SPACE }]],
      });
      await expect(ok.service.getContent('p1', SPACE, USER)).resolves.toEqual({
        title: 'X',
        content: '{"type":"doc"}',
        content_format: 'tiptap',
      });
      expect(ok.pagePerms.assertPageAccess).toHaveBeenCalledWith(
        'p1',
        'user-1',
        SPACE,
        'can_view',
      );

      const other = setup({
        wiki_templates: [null, null],
        wiki_pages: [
          templatePage({ space_id: OTHER_SPACE }),
          [{ id: ROOT, space_id: OTHER_SPACE }],
        ],
      });
      await expect(
        other.service.getContent('p1', SPACE, USER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('tenant template: readable from any space without page ACL', async () => {
      const { service, pagePerms } = setup({
        wiki_templates: [
          null,
          { id: 'r', page_id: 'p1', space_id: null, page_title: null },
        ],
        wiki_pages: [
          templatePage({ space_id: OTHER_SPACE }),
          [{ id: ROOT, space_id: OTHER_SPACE }],
        ],
      });
      const res = await service.getContent('p1', SPACE, USER);
      expect(res.title).toBe('');
      expect(pagePerms.assertPageAccess).not.toHaveBeenCalled();
    });

    it('a page that is not under a Templates root is not a template', async () => {
      const { service } = setup({
        wiki_templates: [null],
        wiki_pages: [templatePage({ parent_id: 'some-page' }), []],
      });
      await expect(
        service.getContent('p1', SPACE, USER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('legacy row: returns its stored content, other space is NotFound', async () => {
      const ok = setup({
        wiki_templates: [
          {
            id: 'l',
            page_id: null,
            space_id: null,
            content: 'C',
            page_title: 'T',
          },
        ],
      });
      await expect(ok.service.getContent('l', SPACE, USER)).resolves.toEqual({
        title: 'T',
        content: 'C',
        content_format: 'tiptap',
      });

      const other = setup({
        wiki_templates: [{ id: 'l', page_id: null, space_id: OTHER_SPACE }],
      });
      await expect(
        other.service.getContent('l', SPACE, USER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates the Templates root on first use, then the page under it', async () => {
      const { service, wiki, pagePerms } = setup({ wiki_pages: [[]] });

      await expect(
        service.create(SPACE, USER, { name: 'Weekly' }),
      ).resolves.toEqual({
        page_id: 'new-page',
        root_id: ROOT,
      });

      expect(pagePerms.assertSpaceCanCreate).toHaveBeenCalled();
      expect(wiki.createPage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          title: 'Templates',
          metadata: { system: TEMPLATES_ROOT_SYSTEM },
        }),
        ORG,
        'user-1',
      );
      expect(pagePerms.assertPageAccess).toHaveBeenCalledWith(
        ROOT,
        'user-1',
        SPACE,
        'can_create',
      );
      expect(wiki.createPage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          title: 'Weekly',
          parent_id: ROOT,
          space_id: SPACE,
        }),
        ORG,
        'user-1',
      );
      // createPage rejects '' for tiptap pages, so both start as a real empty doc
      for (const [dto] of wiki.createPage.mock.calls) {
        expect(
          (JSON.parse((dto as { content: string }).content) as { type: string })
            .type,
        ).toBe('doc');
      }
    });

    it('reuses an existing root and copies the source page', async () => {
      const { service, wiki, pagePerms } = setup({
        wiki_pages: [[{ id: ROOT, space_id: SPACE }]],
      });

      await service.create(SPACE, USER, {
        name: 'Copy',
        source_page_id: 'src',
      });

      expect(pagePerms.assertPageAccess).toHaveBeenCalledWith(
        'src',
        'user-1',
        SPACE,
        'can_view',
      );
      expect(wiki.createPage).toHaveBeenCalledTimes(1);
      expect(wiki.createPage).toHaveBeenCalledWith(
        expect.objectContaining({ parent_id: ROOT, content: '{"type":"doc"}' }),
        ORG,
        'user-1',
      );
    });

    it('a page the caller cannot create under the root is rejected', async () => {
      const { service, wiki, pagePerms } = setup({
        wiki_pages: [[{ id: ROOT, space_id: SPACE }]],
      });
      pagePerms.assertPageAccess.mockRejectedValueOnce(
        new ForbiddenException(),
      );
      await expect(
        service.create(SPACE, USER, { name: 'x' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(wiki.createPage).not.toHaveBeenCalled();
    });
  });

  describe('saveSettings', () => {
    const pageQueues = () => ({
      wiki_pages: [templatePage(), [{ id: ROOT, space_id: SPACE }]],
    });

    it('tenant level: member is Forbidden, admin inserts space_id NULL', async () => {
      const member = setup({ ...pageQueues(), wiki_templates: [null] });
      await expect(
        member.service.saveSettings('p1', SPACE, USER, { scope: 'tenant' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(member.chains.wiki_templates).toHaveLength(1); // lookup only, no write

      const admin = setup(
        {
          ...pageQueues(),
          wiki_templates: [null, { id: 'r', page_id: 'p1', space_id: null }],
        },
        { admin: true },
      );
      const row = await admin.service.saveSettings('p1', SPACE, USER, {
        scope: 'tenant',
        page_title: 'Notes {{date,YYYY-MM-DD}}',
      });
      expect(admin.chains.wiki_templates[1].insert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: ORG,
          page_id: 'p1',
          space_id: null,
          page_title: 'Notes {{date,YYYY-MM-DD}}',
          name: 'Meeting notes',
        }),
      );
      expect(admin.pagePerms.assertPageAccess).toHaveBeenCalledWith(
        'p1',
        'user-1',
        SPACE,
        'can_edit',
      );
      expect(row.scope).toBe('tenant');
    });

    it('moving a tenant template back to space level still needs an admin', async () => {
      const { service } = setup({
        ...pageQueues(),
        wiki_templates: [{ id: 'r', page_id: 'p1', space_id: null }],
      });
      await expect(
        service.saveSettings('p1', SPACE, USER, { scope: 'space' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('updates an existing space row', async () => {
      const { service, chains } = setup({
        ...pageQueues(),
        wiki_templates: [
          { id: 'r', page_id: 'p1', space_id: SPACE },
          { id: 'r', page_id: 'p1', space_id: SPACE },
        ],
      });
      await service.saveSettings('p1', SPACE, USER, {
        scope: 'space',
        description: 'd',
      });
      expect(chains.wiki_templates[1].update).toHaveBeenCalledWith(
        expect.objectContaining({ space_id: SPACE, description: 'd' }),
      );
    });

    it('a template page of another space is NotFound', async () => {
      const { service } = setup({
        wiki_pages: [
          templatePage({ space_id: OTHER_SPACE }),
          [{ id: ROOT, space_id: OTHER_SPACE }],
        ],
      });
      await expect(
        service.saveSettings('p1', SPACE, USER, { scope: 'space' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('legacy rows', () => {
    it('update of a space template from a different space is NotFound', async () => {
      const { service, chains } = setup({
        wiki_templates: [{ id: 's', page_id: null, space_id: OTHER_SPACE }],
      });
      await expect(
        service.update('s', SPACE, USER, { name: 'y' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(chains.wiki_templates).toHaveLength(1);
    });

    it('update/delete of a tenant template as member is Forbidden', async () => {
      const tenant = { id: 't', page_id: null, space_id: null };
      const { service, chains } = setup({
        spaces: [{ id: SPACE }, { id: SPACE }],
        wiki_templates: [tenant, tenant],
      });
      await expect(
        service.update('t', SPACE, USER, { name: 'y' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.remove('t', SPACE, USER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(chains.wiki_templates).toHaveLength(2); // two lookups, no writes
    });

    it('rejects invalid TipTap content', async () => {
      const { service } = setup({
        wiki_templates: [{ id: 's', page_id: null, space_id: SPACE }],
      });
      await expect(
        service.update('s', SPACE, USER, { content: '{"type":"script"}' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
