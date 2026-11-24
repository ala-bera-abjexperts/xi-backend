/**
 * @fileoverview WikiService link paths (XE-T532 #4). createLink validates a
 * task/process target (in the org and viewable, answering 404 exactly like a
 * missing one), getLinks drops targets the viewer cannot see, and getBacklinks
 * carries each page's space_key so the task panel opens the page's own space.
 *
 * @module src/wiki/wiki-links.spec
 * @author Prince Jadiya
 */

// wiki.service transitively imports sanitize-rich-text, which pulls in jsdom
// (ESM) that ts-jest cannot transform. Stub the sanitizer (identity).
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import { Logger, NotFoundException } from '@nestjs/common';
import { WikiService } from './wiki.service';
import type { CreateWikiLinkDto } from './dto/create-wiki-link.dto';

const ORG = 'org-1';
const USER = 'user-1';
const PAGE = 'page-1';

type Resolved = { data: unknown; error: unknown };

// Route by table; anything unlisted resolves to { data: null }.
function setup(queues: Record<string, Resolved[]>) {
  const chains: Record<string, Record<string, jest.Mock>[]> = {};
  const from = jest.fn((table: string) => {
    const resolved = queues[table]?.shift() ?? { data: null, error: null };
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'insert'])
      chain[m] = jest.fn(() => chain);
    chain.single = jest.fn(() => Promise.resolve(resolved));
    chain.maybeSingle = jest.fn(() => Promise.resolve(resolved));
    chain.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(ok);
    (chains[table] ??= []).push(chain as Record<string, jest.Mock>);
    return chain;
  });
  // Only space s-ops is visible; org-level rows are not.
  const spacePerms = {
    getUserSpacePermissions: jest.fn(
      (_user: string, _org: string, spaceId: string) =>
        Promise.resolve({
          isMember: spaceId === 's-ops',
          permissions: { view_tasks: true, view_processes: true },
        }),
    ),
    getUserEffectivePermissions: jest.fn(() =>
      Promise.resolve({ effective_permissions: { can_view_tasks: false } }),
    ),
  };
  const wikiPerms = {
    filterAccessiblePages: jest.fn((pages: { id: string }[]) =>
      Promise.resolve(pages.filter((p) => p.id !== 'page-hidden')),
    ),
  };
  const service = new WikiService(
    { getClient: () => ({ from }) } as never,
    wikiPerms as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    spacePerms as never,
  );
  return { service, chains, spacePerms };
}

const dto = (target_type: string, target_id: string) =>
  ({ target_type, target_id }) as CreateWikiLinkDto;

describe('WikiService.createLink target validation (XE-T532)', () => {
  it('links a task the viewer can see', async () => {
    const { service, chains, spacePerms } = setup({
      tasks: [{ data: [{ id: 't-1', space_id: 's-ops' }], error: null }],
      wiki_page_links: [{ data: { id: 'l-1' }, error: null }],
    });

    await expect(
      service.createLink(PAGE, dto('task', 't-1'), USER, ORG),
    ).resolves.toEqual({ id: 'l-1' });
    expect(chains.tasks[0].eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(spacePerms.getUserSpacePermissions).toHaveBeenCalledWith(
      USER,
      ORG,
      's-ops',
    );
  });

  it.each([
    ['a task in a space the viewer cannot see', 'task', 'tasks', 's-hidden'],
    ['an org-level task without org can_view_tasks', 'task', 'tasks', null],
    [
      'a process the viewer cannot see',
      'process',
      'business_processes',
      's-hidden',
    ],
  ])('404s %s, without inserting', async (_name, type, table, spaceId) => {
    const { service, chains } = setup({
      [table]: [{ data: [{ id: 'x-1', space_id: spaceId }], error: null }],
    });

    await expect(
      service.createLink(PAGE, dto(type, 'x-1'), USER, ORG),
    ).rejects.toThrow(new NotFoundException(`Target ${type} not found`));
    expect(chains.wiki_page_links).toBeUndefined();
  });

  it('404s a task outside the org, without inserting', async () => {
    const { service, chains } = setup({ tasks: [{ data: [], error: null }] });

    await expect(
      service.createLink(PAGE, dto('task', 't-foreign'), USER, ORG),
    ).rejects.toThrow(NotFoundException);
    expect(chains.wiki_page_links).toBeUndefined();
  });

  it('404s, without inserting, when the target lookup fails', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service, chains } = setup({
      tasks: [{ data: null, error: { message: 'boom' } }],
    });

    await expect(
      service.createLink(PAGE, dto('task', 't-1'), USER, ORG),
    ).rejects.toThrow(new NotFoundException('Target task not found'));
    expect(chains.wiki_page_links).toBeUndefined();
    warn.mockRestore();
  });
});

describe('WikiService.getLinks visibility (XE-T532)', () => {
  // A target that exists but is hidden is dropped; a missing one keeps its raw
  // row so the link can still be removed.
  it('drops hidden task, process and page targets, keeps missing ones', async () => {
    const link = (id: string, target_type: string, target_id: string) => ({
      id,
      source_page_id: PAGE,
      target_type,
      target_id,
    });
    const { service } = setup({
      wiki_page_links: [
        {
          data: [
            link('l-task', 'task', 't-1'),
            link('l-task-hidden', 'task', 't-2'),
            link('l-task-gone', 'task', 't-gone'),
            link('l-proc', 'process', 'p-1'),
            link('l-page', 'page', 'page-2'),
            link('l-page-hidden', 'page', 'page-hidden'),
            link('l-asset', 'asset', 'a-1'),
          ],
          error: null,
        },
      ],
      tasks: [
        {
          data: [
            { id: 't-1', space_id: 's-ops' },
            { id: 't-2', space_id: 's-hidden' },
          ],
          error: null,
        },
      ],
      business_processes: [
        { data: [{ id: 'p-1', space_id: 's-ops' }], error: null },
      ],
      wiki_pages: [
        {
          data: [
            { id: 'page-2', space_id: 'w-1' },
            { id: 'page-hidden', space_id: 'w-1' },
          ],
          error: null,
        },
      ],
    });

    const out = (await service.getLinks(PAGE, USER, ORG)) as { id: string }[];

    expect(out.map((l) => l.id)).toEqual([
      'l-task',
      'l-task-gone',
      'l-proc',
      'l-page',
      'l-asset',
    ]);
  });
});

describe('WikiService.getLinks target lookup failure (XE-T532)', () => {
  // A failed lookup must not fail the panel: that type's rows cannot be
  // verified, so they are dropped (fail closed), and the rest still return.
  it('drops only the unverifiable rows, and warns', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service } = setup({
      wiki_page_links: [
        {
          data: [
            { id: 'l-task', target_type: 'task', target_id: 't-1' },
            { id: 'l-proc', target_type: 'process', target_id: 'p-1' },
            { id: 'l-page', target_type: 'page', target_id: 'page-2' },
            { id: 'l-asset', target_type: 'asset', target_id: 'a-1' },
          ],
          error: null,
        },
      ],
      tasks: [{ data: null, error: { message: 'boom' } }],
      business_processes: [
        { data: [{ id: 'p-1', space_id: 's-ops' }], error: null },
      ],
      wiki_pages: [{ data: null, error: { message: 'boom' } }],
    });

    const out = (await service.getLinks(PAGE, USER, ORG)) as { id: string }[];

    expect(out.map((l) => l.id)).toEqual(['l-proc', 'l-asset']);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('WikiService.getBacklinks space_key (XE-T532)', () => {
  it("adds the page's space_key", async () => {
    const { service, chains } = setup({
      wiki_page_links: [
        {
          data: [
            {
              id: 'l-1',
              created_at: '2026-09-11T00:00:00Z',
              source_page: {
                id: PAGE,
                title: 'VPN known error',
                space_id: 'w-1',
                space: { key: 'KB' },
              },
            },
          ],
          error: null,
        },
      ],
    });

    const out = await service.getBacklinks('task', 't-1', {
      userId: USER,
      organizationId: ORG,
    } as never);

    expect(out).toEqual([
      {
        link_id: 'l-1',
        linked_at: '2026-09-11T00:00:00Z',
        page: {
          id: PAGE,
          title: 'VPN known error',
          space_id: 'w-1',
          space_key: 'KB',
        },
      },
    ]);
    expect(chains.wiki_page_links[0].select).toHaveBeenCalledWith(
      expect.stringContaining('space:spaces!wiki_pages_space_id_fkey(key)'),
    );
  });
});
