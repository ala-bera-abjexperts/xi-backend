// Unit tests for WikiMineService, the MCP-facing member-space + page-ACL
// constrained wiki reads. Exercises the security logic with the Supabase
// client, PermissionsService, and WikiPermissionsService mocked:
//   - search: member-space + per-page ACL filtering, draft exclusion, archived
//     exclusion, anti-probing empty result for a non-accessible space filter,
//   - get: cross-org / non-member / ACL-denied / draft / malformed-id all throw
//     the identical NotFoundException; happy path returns the whitelisted detail;
//     admin bypass; includeChildren filters + caps children.

// wiki-content.util imports sanitize-rich-text, which pulls in jsdom (ESM) that
// ts-jest can't transform. Stub the sanitizer (identity) so plain text passes through.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import { NotFoundException } from '@nestjs/common';
import { WikiMineService } from './wiki-mine.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { WikiPermissionsService } from './wiki-permissions.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

const USER_ID = 'user-1';
const ORG_ID = 'org-1';
const SPACE_ID = 'space-1';
const PAGE_UUID = '11111111-1111-1111-1111-111111111111';

const user = { userId: USER_ID, organizationId: ORG_ID } as RequestUser;

interface QueryResult {
  data: unknown;
  error: unknown;
}

/** A chainable + awaitable Supabase query-builder mock resolving to `result`. */
function chainable(result: QueryResult): Record<string, unknown> {
  const builder: Record<string, unknown> = {};

  for (const m of ['select', 'eq', 'in', 'ilike', 'order', 'limit']) {
    builder[m] = jest.fn(() => builder);
  }
  builder.maybeSingle = jest.fn(() => Promise.resolve(result));
  // Awaitable: `await builder` resolves to `result` (for non-single queries).
  builder.then = (
    resolve: (v: QueryResult) => unknown,
    reject: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);

  return builder;
}

function buildService(opts: {
  /** Ordered builders returned by successive client.from(...) calls. */
  fromBuilders: Record<string, unknown>[];
  isAdminOrOwner?: boolean;
  spacePerms?: Record<
    string,
    { isMember: boolean; permissions: Record<string, boolean> }
  >;
  filterAccessiblePages?: (pages: unknown[]) => unknown[];
  assertThrows?: boolean;
}): {
  service: WikiMineService;
  from: jest.Mock;
} {
  const from = jest.fn();

  for (const b of opts.fromBuilders) {
    from.mockReturnValueOnce(b);
  }

  const supabaseAdmin = {
    getClient: () => ({ from }),
  } as unknown as SupabaseAdminService;

  const permissionsService = {
    isAdminOrOwner: jest.fn().mockResolvedValue(opts.isAdminOrOwner ?? false),
    getUserSpacePermissions: jest.fn(
      (_u: string, _o: string, spaceId: string) =>
        Promise.resolve(
          opts.spacePerms?.[spaceId] ?? {
            isMember: false,
            spaceRole: null,
            globalRole: null,
            permissions: {},
          },
        ),
    ),
  } as unknown as PermissionsService;

  const wikiPermissions = {
    filterAccessiblePages: jest.fn((pages: unknown[]) =>
      Promise.resolve(
        opts.filterAccessiblePages ? opts.filterAccessiblePages(pages) : pages,
      ),
    ),
    assertPageAccess: jest.fn(() =>
      opts.assertThrows
        ? Promise.reject(new Error('forbidden'))
        : Promise.resolve(undefined),
    ),
  } as unknown as WikiPermissionsService;

  return {
    service: new WikiMineService(
      supabaseAdmin,
      permissionsService,
      wikiPermissions,
    ),
    from,
  };
}

function pageRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'w-1',
    space_id: SPACE_ID,
    title: 'Runbook',
    slug: 'runbook',
    is_published: true,
    is_archived: false,
    updated_at: '2026-06-10T00:00:00Z',
    created_by: 'someone',
    path: [],
    content: 'incident steps',
    content_format: 'editorjs',
    ...overrides,
  };
}

describe('WikiMineService.searchMyWikiPages', () => {
  it('returns ACL-permitted, published pages and excludes drafts', async () => {
    const published = pageRow({ id: 'w-pub', title: 'Published' });
    const draft = pageRow({
      id: 'w-draft',
      title: 'Draft',
      is_published: false,
      is_archived: false,
    });
    const { service } = buildService({
      fromBuilders: [
        // resolveAccessibleWikiSpaceIds: spaces scan
        chainable({
          data: [{ id: SPACE_ID, key: 'OPS', name: 'Ops' }],
          error: null,
        }),
        // wiki_pages search
        chainable({ data: [published, draft], error: null }),
      ],
      spacePerms: {
        [SPACE_ID]: { isMember: true, permissions: { view_wiki_pages: true } },
      },
      // ACL allows both; the service's exposure filter drops the pure draft.
      filterAccessiblePages: (pages) => pages,
    });

    const res = await service.searchMyWikiPages(user, { query: 'run' });

    expect(res.pages.map((p) => p.id)).toEqual(['w-pub']);
    expect(res.pages[0]).toMatchObject({
      id: 'w-pub',
      title: 'Published',
      space: { id: SPACE_ID, key: 'OPS', name: 'Ops' },
      isArchived: false,
    });
  });

  it('drops pages the page-ACL denies', async () => {
    const { service } = buildService({
      fromBuilders: [
        chainable({
          data: [{ id: SPACE_ID, key: 'OPS', name: 'Ops' }],
          error: null,
        }),
        chainable({ data: [pageRow()], error: null }),
      ],
      spacePerms: {
        [SPACE_ID]: { isMember: true, permissions: { view_wiki_pages: true } },
      },
      // ACL denies everything.
      filterAccessiblePages: () => [],
    });

    const res = await service.searchMyWikiPages(user, { query: 'run' });

    expect(res.pages).toEqual([]);
  });

  it('returns empty (no client query) for a blank query', async () => {
    const { service, from } = buildService({ fromBuilders: [] });

    const res = await service.searchMyWikiPages(user, { query: '   ' });

    expect(res).toEqual({ pages: [] });
    expect(from).not.toHaveBeenCalled();
  });

  it('returns empty for a non-accessible space filter (anti-probing)', async () => {
    const { service } = buildService({
      fromBuilders: [
        // spaces scan: caller is a member of SPACE_ID only
        chainable({
          data: [{ id: SPACE_ID, key: 'OPS', name: 'Ops' }],
          error: null,
        }),
        // resolveSpaceIdOrKey for the other space resolves to a real id...
        chainable({ data: { id: 'space-other' }, error: null }),
      ],
      spacePerms: {
        [SPACE_ID]: { isMember: true, permissions: { view_wiki_pages: true } },
      },
    });

    // ...but space-other is not in the accessible set, so empty, never an error.
    const res = await service.searchMyWikiPages(user, {
      query: 'run',
      spaceIdOrKey: 'OTHER',
    });

    expect(res).toEqual({ pages: [] });
  });

  it('admin/owner sees all non-archived org spaces without per-space checks', async () => {
    const { service } = buildService({
      fromBuilders: [
        chainable({
          data: [
            { id: SPACE_ID, key: 'OPS', name: 'Ops' },
            { id: 'space-2', key: 'HR', name: 'HR' },
          ],
          error: null,
        }),
        chainable({ data: [pageRow()], error: null }),
      ],
      isAdminOrOwner: true,
      filterAccessiblePages: (pages) => pages,
    });

    const res = await service.searchMyWikiPages(user, { query: 'run' });

    expect(res.pages).toHaveLength(1);
  });
});

describe('WikiMineService.getMyWikiPage', () => {
  it('returns the whitelisted detail for an accessible, published page', async () => {
    const { service } = buildService({
      fromBuilders: [
        // page lookup
        chainable({
          data: pageRow({ organization_id: ORG_ID, parent_id: null }),
          error: null,
        }),
        // space ref lookup
        chainable({
          data: { id: SPACE_ID, key: 'OPS', name: 'Ops' },
          error: null,
        }),
      ],
      spacePerms: {
        [SPACE_ID]: { isMember: true, permissions: { view_wiki_pages: true } },
      },
    });

    const res = await service.getMyWikiPage(user, PAGE_UUID);

    expect(res.page).toMatchObject({
      id: 'w-1',
      title: 'Runbook',
      space: { id: SPACE_ID, key: 'OPS', name: 'Ops' },
      isPublished: true,
      isArchived: false,
      contentText: 'incident steps',
      contentFormat: 'editorjs',
    });
    expect(res.children).toBeUndefined();
  });

  it('throws NotFound for a non-UUID pageId (no client call)', async () => {
    const { service, from } = buildService({ fromBuilders: [] });

    await expect(service.getMyWikiPage(user, 'not-a-uuid')).rejects.toThrow(
      NotFoundException,
    );
    expect(from).not.toHaveBeenCalled();
  });

  it('throws NotFound for a cross-org page', async () => {
    const { service } = buildService({
      fromBuilders: [
        chainable({
          data: pageRow({ organization_id: 'other-org' }),
          error: null,
        }),
      ],
      isAdminOrOwner: true, // even an admin must not see another org's page
    });

    await expect(service.getMyWikiPage(user, PAGE_UUID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFound for a non-member space', async () => {
    const { service } = buildService({
      fromBuilders: [
        chainable({ data: pageRow({ organization_id: ORG_ID }), error: null }),
      ],
      spacePerms: {
        [SPACE_ID]: { isMember: false, permissions: {} },
      },
    });

    await expect(service.getMyWikiPage(user, PAGE_UUID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFound when the page-ACL denies access', async () => {
    const { service } = buildService({
      fromBuilders: [
        chainable({ data: pageRow({ organization_id: ORG_ID }), error: null }),
      ],
      spacePerms: {
        [SPACE_ID]: { isMember: true, permissions: { view_wiki_pages: true } },
      },
      assertThrows: true,
    });

    await expect(service.getMyWikiPage(user, PAGE_UUID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFound for a pure draft (unpublished, not archived)', async () => {
    const { service } = buildService({
      fromBuilders: [
        chainable({
          data: pageRow({
            organization_id: ORG_ID,
            is_published: false,
            is_archived: false,
          }),
          error: null,
        }),
      ],
      isAdminOrOwner: true,
    });

    await expect(service.getMyWikiPage(user, PAGE_UUID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFound when the page does not exist', async () => {
    const { service } = buildService({
      fromBuilders: [chainable({ data: null, error: null })],
    });

    await expect(service.getMyWikiPage(user, PAGE_UUID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('includeChildren returns only accessible, non-draft children (capped, {id,title})', async () => {
    const childPub = {
      id: 'c-1',
      title: 'Child Pub',
      created_by: 'x',
      path: [],
      is_published: true,
      is_archived: false,
    };
    const childDraft = {
      id: 'c-2',
      title: 'Child Draft',
      created_by: 'x',
      path: [],
      is_published: false,
      is_archived: false,
    };
    const { service } = buildService({
      fromBuilders: [
        // page lookup
        chainable({ data: pageRow({ organization_id: ORG_ID }), error: null }),
        // space ref
        chainable({
          data: { id: SPACE_ID, key: 'OPS', name: 'Ops' },
          error: null,
        }),
        // children query
        chainable({ data: [childPub, childDraft], error: null }),
      ],
      isAdminOrOwner: true,
      // ACL allows both; the draft is then dropped by the exposure filter.
      filterAccessiblePages: (pages) => pages,
    });

    const res = await service.getMyWikiPage(user, PAGE_UUID, {
      includeChildren: true,
    });

    expect(res.children).toEqual([{ id: 'c-1', title: 'Child Pub' }]);
  });
});
