/**
 * @fileoverview Unit tests for WikiMineWriteService — the MCP-facing,
 * space-membership + space-permission + page-ACL constrained wiki write path.
 * Covers the space gate (admin/owner bypass, member-with-permission allow,
 * non-member deny), the page-level ACL (can_create on a parent, can_edit on the
 * page), write-time content sanitization, the guarded updated_at optimistic
 * claim + 409 conflict shape, the archived-page deny, and the uniform 404
 * anti-probing behaviour.
 * @module src/wiki/wiki-mine-write.service.spec
 * @author Prince Jadiya
 */

import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

// sanitize-rich-text pulls jsdom (ESM) which Jest cannot transform. Stub it with
// a deterministic transform that strips <script> blocks so tests can assert that
// the wrapper sanitizes content BEFORE delegating to WikiService.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (v: string | null | undefined) =>
    v == null ? null : String(v).replace(/<script[\s\S]*?<\/script>/gi, ''),
}));

import { WikiMineWriteService } from './wiki-mine-write.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { WikiService } from './wiki.service';
import { WikiPermissionsService } from './wiki-permissions.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

const ORG = '11111111-1111-1111-1111-111111111111';
const SPACE = '22222222-2222-2222-2222-222222222222';
const PAGE = '33333333-3333-3333-3333-333333333333';
const PARENT = '66666666-6666-6666-6666-666666666666';
const USER = '44444444-4444-4444-4444-444444444444';

const user: RequestUser = {
  authUserId: 'auth-1',
  userId: USER,
  email: 'caller@example.com',
  organizationId: ORG,
  memberships: [],
};

// A minimal PostgREST query-chain double: every builder method returns `this`,
// and the terminal `maybeSingle`/`single`/thenable resolve to `resolved`.
function buildChain(resolved: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = jest.fn().mockImplementation(self);
  chain.eq = jest.fn().mockImplementation(self);
  chain.in = jest.fn().mockImplementation(self);
  chain.update = jest.fn().mockImplementation(self);
  chain.insert = jest.fn().mockImplementation(self);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  chain.single = jest.fn().mockResolvedValue(resolved);
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(resolved).then(onFulfilled);
  return chain;
}

const spaceRow = { id: SPACE, key: 'SP', name: 'Space' };

const loadedPageRow = {
  id: PAGE,
  title: 'Onboarding',
  space_id: SPACE,
  parent_id: null,
  is_published: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const updatedPageRow = {
  id: PAGE,
  title: 'New title',
  space_id: SPACE,
  parent_id: null,
  is_published: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

describe('WikiMineWriteService', () => {
  let service: WikiMineWriteService;
  let mockFrom: jest.Mock;
  let permissions: {
    isAdminOrOwner: jest.Mock;
    getUserSpacePermissions: jest.Mock;
  };
  let wiki: { createPage: jest.Mock; updatePage: jest.Mock };
  let wikiPermissions: { assertPageAccess: jest.Mock };

  beforeEach(() => {
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    permissions = {
      isAdminOrOwner: jest.fn().mockResolvedValue(false),
      getUserSpacePermissions: jest.fn(),
    };

    wiki = {
      createPage: jest.fn().mockResolvedValue({ id: PAGE }),
      updatePage: jest.fn().mockResolvedValue(updatedPageRow),
    };

    wikiPermissions = {
      assertPageAccess: jest.fn().mockResolvedValue(undefined),
    };

    service = new WikiMineWriteService(
      supa,
      permissions as unknown as PermissionsService,
      wiki as unknown as WikiService,
      wikiPermissions as unknown as WikiPermissionsService,
    );
  });

  function grantSpacePermission(key: string) {
    permissions.getUserSpacePermissions.mockResolvedValue({
      isMember: true,
      spaceRole: 'member',
      globalRole: 'member',
      permissions: { [key]: true },
    });
  }

  // ---- create ------------------------------------------------------------

  describe('createWikiPage', () => {
    it('creates a draft (html) page in an accessible (member + create_wiki_pages) space', async () => {
      grantSpacePermission('create_wiki_pages');
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null })) // resolveSpaceIdOrKey
        .mockReturnValueOnce(buildChain({ data: loadedPageRow, error: null })) // loadSafePage row
        .mockReturnValueOnce(buildChain({ data: spaceRow, error: null })); // toSafePage space

      const result = await service.createWikiPage(user, {
        spaceIdOrKey: 'SP',
        title: 'Onboarding',
        content: 'Hello world',
      });

      expect(wiki.createPage).toHaveBeenCalledWith(
        expect.objectContaining({
          space_id: SPACE,
          title: 'Onboarding',
          content: 'Hello world',
          content_format: 'html',
          is_published: false,
        }),
        ORG,
        USER,
      );
      expect(result.page.id).toBe(PAGE);
      expect(result.page.status).toBe('draft');
      expect(result.page.space).toEqual({
        id: SPACE,
        key: 'SP',
        name: 'Space',
      });
    });

    it('sanitizes the content BEFORE delegating (script stripped)', async () => {
      grantSpacePermission('create_wiki_pages');
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
        .mockReturnValueOnce(buildChain({ data: loadedPageRow, error: null }))
        .mockReturnValueOnce(buildChain({ data: spaceRow, error: null }));

      await service.createWikiPage(user, {
        spaceIdOrKey: 'SP',
        title: 'x',
        content: '<script>alert(1)</script>Safe body',
      });

      const dto = (wiki.createPage.mock.calls[0] as unknown[])[0] as {
        content: string;
        content_format: string;
      };
      expect(dto.content).toBe('Safe body');
      expect(dto.content_format).toBe('html');
    });

    it('publishes when status=published', async () => {
      grantSpacePermission('create_wiki_pages');
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: { ...loadedPageRow, is_published: true },
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: spaceRow, error: null }));

      const result = await service.createWikiPage(user, {
        spaceIdOrKey: 'SP',
        title: 'x',
        content: 'y',
        status: 'published',
      });

      expect(wiki.createPage).toHaveBeenCalledWith(
        expect.objectContaining({ is_published: true }),
        ORG,
        USER,
      );
      expect(result.page.status).toBe('published');
    });

    it('lets an org admin/owner create without space membership', async () => {
      permissions.isAdminOrOwner.mockResolvedValue(true);
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
        .mockReturnValueOnce(buildChain({ data: loadedPageRow, error: null }))
        .mockReturnValueOnce(buildChain({ data: spaceRow, error: null }));

      await service.createWikiPage(user, {
        spaceIdOrKey: 'SP',
        title: 'x',
        content: 'y',
      });

      expect(permissions.getUserSpacePermissions).not.toHaveBeenCalled();
      expect(wiki.createPage).toHaveBeenCalled();
    });

    it('returns 404 for a non-member space (anti-probing)', async () => {
      permissions.getUserSpacePermissions.mockResolvedValue({
        isMember: false,
        permissions: {},
      });
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: SPACE }, error: null }),
      );

      await expect(
        service.createWikiPage(user, {
          spaceIdOrKey: 'SP',
          title: 'x',
          content: 'y',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(wiki.createPage).not.toHaveBeenCalled();
    });

    it('returns 404 for a cross-org / nonexistent space', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));

      await expect(
        service.createWikiPage(user, {
          spaceIdOrKey: 'SP',
          title: 'x',
          content: 'y',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(wiki.createPage).not.toHaveBeenCalled();
    });

    it('returns 404 when the parent page is in a different space', async () => {
      grantSpacePermission('create_wiki_pages');
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null })) // space
        .mockReturnValueOnce(
          buildChain({
            data: { id: PARENT, space_id: 'other-space', is_archived: false },
            error: null,
          }),
        ); // parent in a DIFFERENT space

      await expect(
        service.createWikiPage(user, {
          spaceIdOrKey: 'SP',
          title: 'x',
          content: 'y',
          parentPageId: PARENT,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(wiki.createPage).not.toHaveBeenCalled();
    });

    it('returns 404 when the parent ACL denies can_create (ForbiddenException → 404)', async () => {
      grantSpacePermission('create_wiki_pages');
      wikiPermissions.assertPageAccess.mockRejectedValue(
        new ForbiddenException('nope'),
      );
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null })) // space
        .mockReturnValueOnce(
          buildChain({
            data: { id: PARENT, space_id: SPACE, is_archived: false },
            error: null,
          }),
        ); // parent exists in same space

      await expect(
        service.createWikiPage(user, {
          spaceIdOrKey: 'SP',
          title: 'x',
          content: 'y',
          parentPageId: PARENT,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(wiki.createPage).not.toHaveBeenCalled();
    });

    it('creates under an accessible parent (can_create) with parent_id forwarded', async () => {
      grantSpacePermission('create_wiki_pages');
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null })) // space
        .mockReturnValueOnce(
          buildChain({
            data: { id: PARENT, space_id: SPACE, is_archived: false },
            error: null,
          }),
        ) // parent
        .mockReturnValueOnce(buildChain({ data: loadedPageRow, error: null })) // loadSafePage
        .mockReturnValueOnce(buildChain({ data: spaceRow, error: null })); // toSafePage space

      await service.createWikiPage(user, {
        spaceIdOrKey: 'SP',
        title: 'x',
        content: 'y',
        parentPageId: PARENT,
      });

      expect(wikiPermissions.assertPageAccess).toHaveBeenCalledWith(
        PARENT,
        USER,
        SPACE,
        'can_create',
      );
      expect(wiki.createPage).toHaveBeenCalledWith(
        expect.objectContaining({ parent_id: PARENT }),
        ORG,
        USER,
      );
    });
  });

  // ---- update ------------------------------------------------------------

  describe('updateWikiPage', () => {
    it('updates with a matching expectedUpdatedAt and returns the final updatedAt', async () => {
      grantSpacePermission('edit_wiki_pages');
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: PAGE,
              space_id: SPACE,
              updated_at: '2026-01-01T00:00:00Z',
              is_archived: false,
            },
            error: null,
          }),
        ) // resolveWikiPageRef
        .mockReturnValueOnce(buildChain({ data: { id: PAGE }, error: null })) // guarded claim succeeds
        .mockReturnValueOnce(buildChain({ data: spaceRow, error: null })); // toSafePage space

      const result = await service.updateWikiPage(user, PAGE, {
        expectedUpdatedAt: '2026-01-01T00:00:00Z',
        title: 'New title',
        content: '<script>x</script>Body',
        status: 'published',
      });

      // Content sanitized + stored as html; status mapped to is_published.
      expect(wiki.updatePage).toHaveBeenCalledWith(
        PAGE,
        SPACE,
        expect.objectContaining({
          title: 'New title',
          content: 'Body',
          content_format: 'html',
          is_published: true,
        }),
        USER,
      );
      // Never moves space/parent.
      const dto = (wiki.updatePage.mock.calls[0] as unknown[])[2] as Record<
        string,
        unknown
      >;
      expect(dto).not.toHaveProperty('parent_id');
      expect(dto).not.toHaveProperty('space_id');
      expect(result.updatedAt).toBe('2026-01-02T00:00:00Z');
    });

    it('returns 409 with only the current updatedAt on a stale expectedUpdatedAt', async () => {
      grantSpacePermission('edit_wiki_pages');
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: PAGE,
              space_id: SPACE,
              updated_at: '2026-01-05T00:00:00Z',
              is_archived: false,
            },
            error: null,
          }),
        ) // resolveWikiPageRef
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // guarded claim loses (no row)
        .mockReturnValueOnce(
          buildChain({
            data: { updated_at: '2026-01-05T00:00:00Z' },
            error: null,
          }),
        ); // readCurrentUpdatedAt

      let caught: unknown;
      try {
        await service.updateWikiPage(user, PAGE, {
          expectedUpdatedAt: '2026-01-01T00:00:00Z',
          title: 'stale',
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      const body = (caught as ConflictException).getResponse() as {
        data: { currentUpdatedAt: string };
      };
      expect(body.data.currentUpdatedAt).toBe('2026-01-05T00:00:00Z');
      expect(wiki.updatePage).not.toHaveBeenCalled();
    });

    it('returns 404 when the caller lacks edit_wiki_pages in the page space', async () => {
      permissions.getUserSpacePermissions.mockResolvedValue({
        isMember: true,
        permissions: { view_wiki_pages: true },
      });
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: {
            id: PAGE,
            space_id: SPACE,
            updated_at: '2026-01-01T00:00:00Z',
            is_archived: false,
          },
          error: null,
        }),
      );

      await expect(
        service.updateWikiPage(user, PAGE, {
          expectedUpdatedAt: '2026-01-01T00:00:00Z',
          title: 'x',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(wiki.updatePage).not.toHaveBeenCalled();
    });

    it('returns 404 when the page-level can_edit ACL denies (ForbiddenException → 404)', async () => {
      grantSpacePermission('edit_wiki_pages');
      wikiPermissions.assertPageAccess.mockRejectedValue(
        new ForbiddenException('nope'),
      );
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: {
            id: PAGE,
            space_id: SPACE,
            updated_at: '2026-01-01T00:00:00Z',
            is_archived: false,
          },
          error: null,
        }),
      );

      await expect(
        service.updateWikiPage(user, PAGE, {
          expectedUpdatedAt: '2026-01-01T00:00:00Z',
          title: 'x',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(wiki.updatePage).not.toHaveBeenCalled();
    });

    it('returns 404 for an archived page (uniform — not distinguishable)', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: {
            id: PAGE,
            space_id: SPACE,
            updated_at: '2026-01-01T00:00:00Z',
            is_archived: true,
          },
          error: null,
        }),
      );

      await expect(
        service.updateWikiPage(user, PAGE, {
          expectedUpdatedAt: '2026-01-01T00:00:00Z',
          title: 'x',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(permissions.getUserSpacePermissions).not.toHaveBeenCalled();
      expect(wiki.updatePage).not.toHaveBeenCalled();
    });

    it('returns 404 for a nonexistent / cross-org page', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));

      await expect(
        service.updateWikiPage(user, PAGE, {
          expectedUpdatedAt: '2026-01-01T00:00:00Z',
          title: 'x',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(wiki.updatePage).not.toHaveBeenCalled();
    });
  });
});

describe('WikiMineWriteService (Robert create)', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph' }] };

  function build(requireApproval: boolean, isSpaceAdmin: boolean) {
    const from = jest
      .fn()
      .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
      .mockReturnValueOnce(buildChain({ data: loadedPageRow, error: null }))
      .mockReturnValueOnce(buildChain({ data: spaceRow, error: null }));
    const wiki = { createPage: jest.fn().mockResolvedValue({ id: PAGE }) };
    const workflow = {
      getSettings: jest
        .fn()
        .mockResolvedValue({ require_approval: requireApproval }),
    };
    const service = new WikiMineWriteService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {
        isAdminOrOwner: jest.fn().mockResolvedValue(false),
        getUserSpacePermissions: jest.fn().mockResolvedValue({
          isMember: true,
          permissions: { create_wiki_pages: true },
        }),
      } as unknown as PermissionsService,
      wiki as unknown as WikiService,
      {
        assertPageAccess: jest.fn(),
        resolveUserContext: jest.fn().mockResolvedValue({ isSpaceAdmin }),
      } as unknown as WikiPermissionsService,
      workflow as never,
    );
    return { service, wiki, from };
  }

  it('saves the TipTap document under the reserved id', async () => {
    const { service, wiki } = build(false, false);
    await service.createWikiPage(
      user,
      { spaceIdOrKey: 'SP', title: 'Notes', content: '' },
      { pageId: PAGE, doc },
    );
    expect(wiki.createPage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: JSON.stringify(doc),
        content_format: 'tiptap',
        is_published: false,
      }),
      ORG,
      USER,
      { id: PAGE },
    );
  });

  it('creates a draft instead of publishing when the space requires review', async () => {
    const { service, wiki } = build(true, false);
    await service.createWikiPage(user, {
      spaceIdOrKey: 'SP',
      title: 'x',
      content: 'y',
      status: 'published',
    });
    expect(wiki.createPage.mock.calls[0][0].is_published).toBe(false);
  });

  it('lets a space admin publish in a review space', async () => {
    const { service, wiki } = build(true, true);
    await service.createWikiPage(user, {
      spaceIdOrKey: 'SP',
      title: 'x',
      content: 'y',
      status: 'published',
    });
    expect(wiki.createPage.mock.calls[0][0].is_published).toBe(true);
  });

  it('never resolves an archived space', async () => {
    const { service, from } = build(false, false);
    await service.createWikiPage(user, {
      spaceIdOrKey: 'SP',
      title: 'x',
      content: 'y',
    });
    const spaceChain = from.mock.results[0].value as { eq: jest.Mock };
    expect(spaceChain.eq).toHaveBeenCalledWith('is_archived', false);
  });
});
