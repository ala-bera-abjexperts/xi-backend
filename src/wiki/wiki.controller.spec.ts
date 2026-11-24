// wiki.controller now transitively imports sanitize-rich-text (via
// wiki-content.util / wiki.service), which pulls in jsdom (ESM) that ts-jest
// can't transform. Stub the sanitizer (identity) so plain text passes through.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import { runControllerContractSuite } from '../test/controller-contract.helper';
import { WikiController } from './wiki.controller';

runControllerContractSuite({
  controller: WikiController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('WikiController legacy wiki compatibility', () => {
  const user = {
    authUserId: 'auth-1',
    userId: 'user-1',
    email: 'user@example.com',
    organizationId: 'org-1',
    memberships: [],
  };

  const spaceId = '11111111-1111-4111-8111-111111111111';
  const pageId = '22222222-2222-4222-8222-222222222222';
  const attachmentId = '33333333-3333-4333-8333-333333333333';

  const fullDecision = {
    can_view: true,
    can_edit: true,
    can_delete: true,
    can_create: true,
  };

  function createController() {
    const wikiService = {
      getPages: jest
        .fn()
        .mockResolvedValue({ data: [], total: 0, hasMore: false }),
      searchPages: jest
        .fn()
        .mockResolvedValue([{ id: pageId, title: 'Runbook', slug: 'runbook' }]),
      getPageBySlugOrId: jest
        .fn()
        .mockResolvedValue({ id: pageId, slug: 'runbook' }),
      getPageById: jest.fn().mockResolvedValue({ id: pageId }),
      getPageWithRelations: jest.fn().mockResolvedValue({ id: pageId }),
      updatePage: jest.fn().mockResolvedValue({ id: pageId }),
      deletePage: jest.fn().mockResolvedValue(undefined),
      createWhiteboardPage: jest.fn().mockResolvedValue({ page: {} }),
      publishPage: jest.fn().mockResolvedValue({ id: pageId }),
      restoreVersion: jest.fn().mockResolvedValue({ id: pageId }),
      reorderPages: jest.fn().mockResolvedValue({ updated: 2 }),
      getAttachments: jest.fn().mockResolvedValue([]),
      createAttachment: jest.fn().mockResolvedValue({ id: attachmentId }),
      deleteAttachment: jest.fn().mockResolvedValue(undefined),
    };
    const labelsService = {
      getPageLabels: jest.fn().mockResolvedValue([]),
      setPageLabels: jest.fn().mockResolvedValue([]),
    };
    const permissionsService = {
      filterAccessiblePages: jest.fn((pages: unknown[]) =>
        Promise.resolve(pages),
      ),
      assertPageAccess: jest.fn().mockResolvedValue(undefined),
      assertSpaceCanCreate: jest.fn().mockResolvedValue(undefined),
      assertPageAccessWithTrace: jest.fn().mockResolvedValue({
        decision: fullDecision,
        source: 'admin',
        spaceBaseline: fullDecision,
      }),
      resolveWithTrace: jest.fn().mockResolvedValue({
        decision: fullDecision,
        source: 'admin',
        spaceBaseline: fullDecision,
      }),
      isCreatorOrAdmin: jest.fn().mockResolvedValue(true),
      getPagePermissions: jest.fn().mockResolvedValue([]),
      getSpaceBaseline: jest.fn().mockResolvedValue({ can_view: true }),
      setPagePermissions: jest.fn().mockResolvedValue([]),
      clearPagePermissions: jest.fn().mockResolvedValue(undefined),
    };
    const commentsService = {
      getComments: jest.fn().mockResolvedValue([]),
      getThreaded: jest.fn().mockResolvedValue([]),
      createComment: jest.fn().mockResolvedValue({}),
      updateComment: jest.fn().mockResolvedValue({}),
      deleteComment: jest.fn().mockResolvedValue(undefined),
      setResolved: jest.fn().mockResolvedValue({}),
      syncAnchors: jest.fn().mockResolvedValue(undefined),
    };
    const searchService = {
      advancedSpaceSearch: jest
        .fn()
        .mockResolvedValue({ results: [], total: 0, hasMore: false }),
      globalSearch: jest.fn().mockResolvedValue({ results: [] }),
    };
    const workflowService = {
      getSettings: jest.fn().mockResolvedValue({
        space_id: spaceId,
        require_approval: false,
        default_approver_ids: [],
      }),
      computeCapabilities: jest.fn().mockReturnValue({
        can_submit: true,
        can_approve: false,
        can_publish_direct: true,
      }),
      legacyPublish: jest.fn().mockResolvedValue({ id: pageId }),
      transition: jest.fn().mockResolvedValue({ page: { id: pageId } }),
    };
    const watchers = {
      getWikiWatchState: jest.fn().mockResolvedValue({ watching: false }),
      setWikiWatch: jest.fn(
        (
          _: string,
          __: string,
          ___: string,
          ____: string | undefined,
          _____: 'page' | 'space',
          watching: boolean,
        ) => Promise.resolve({ watching }),
      ),
    };

    return {
      controller: new WikiController(
        wikiService as never,
        labelsService as never,
        permissionsService as never,
        commentsService as never,
        searchService as never,
        workflowService as never,
        watchers as never,
      ),
      wikiService,
      labelsService,
      permissionsService,
      commentsService,
      searchService,
      workflowService,
      watchers,
    };
  }

  it('exposes self-only page and space watch toggles with view access', async () => {
    const { controller, permissionsService, watchers } = createController();

    await controller.getPageWatchState(user, spaceId, pageId);
    await controller.watchPage(user, spaceId, pageId);
    await controller.unwatchPage(user, spaceId, pageId);
    await controller.getSpaceWatchState(user, spaceId);
    await controller.watchSpace(user, spaceId);
    await controller.unwatchSpace(user, spaceId);

    expect(permissionsService.assertPageAccess).toHaveBeenCalledTimes(3);
    expect(watchers.setWikiWatch).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      spaceId,
      pageId,
      'page',
      true,
    );
    expect(watchers.setWikiWatch).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      spaceId,
      undefined,
      'space',
      false,
    );
  });

  it('does not call the watcher service when wiki-space view access is denied', async () => {
    const { controller, permissionsService, watchers } = createController();
    permissionsService.getSpaceBaseline.mockResolvedValueOnce({
      can_view: false,
    });

    await expect(controller.watchSpace(user, spaceId)).rejects.toThrow(
      'You do not have permission to view this wiki space',
    );
    expect(watchers.setWikiWatch).not.toHaveBeenCalled();
  });

  it('accepts legacy snake_case list filters', async () => {
    const { controller, wikiService } = createController();

    await controller.list(user, spaceId, {
      parent_id: 'null',
      is_published: 'true',
      is_archived: 'false',
      search: 'run',
      category_id: 'cat-1',
    });

    expect(wikiService.getPages).toHaveBeenCalledWith(
      spaceId,
      {
        parent_id: null,
        is_published: true,
        is_archived: false,
        search: 'run',
        category_id: 'cat-1',
        limit: 200,
        offset: 0,

        // Paging additions. A legacy caller sends neither, so the cursor stays undefined and the
        // ordering falls back to `default` — the pre-existing `sort_order, created_at, id`.
        cursor: undefined,
        order: 'default',
      },
      user.userId,
    );
  });

  it('passes a keyset cursor and tree ordering through when the caller asks for them', async () => {
    const { controller, wikiService } = createController();

    // The sidebar needs `order=tree` so a parent is always returned before its children; without it
    // the client tree-builder renders a child at the root until its parent arrives in a later batch.
    await controller.list(user, spaceId, {}, '50', undefined, 'CURSOR', 'tree');

    expect(wikiService.getPages).toHaveBeenCalledWith(
      spaceId,
      expect.objectContaining({ cursor: 'CURSOR', order: 'tree', limit: 50 }),
      user.userId,
    );
  });

  it('ignores an unrecognised order rather than passing it to the query builder', async () => {
    const { controller, wikiService } = createController();

    await controller.list(
      user,
      spaceId,
      {},
      undefined,
      undefined,
      undefined,
      'sideways',
    );

    expect(wikiService.getPages).toHaveBeenCalledWith(
      spaceId,
      expect.objectContaining({ order: 'default' }),
      user.userId,
    );
  });

  it('resolves slug page params before permission and relation lookups', async () => {
    const { controller, wikiService, permissionsService } = createController();

    await controller.getById(user, spaceId, 'runbook', {
      with_relations: 'true',
    });

    expect(wikiService.getPageBySlugOrId).toHaveBeenCalledWith(
      'runbook',
      spaceId,
    );
    expect(permissionsService.assertPageAccessWithTrace).toHaveBeenCalledWith(
      pageId,
      user.userId,
      spaceId,
      'can_view',
    );
    expect(wikiService.getPageWithRelations).toHaveBeenCalledWith(
      pageId,
      spaceId,
    );
  });

  it('returns legacy link-search item shape and accepts q alias', async () => {
    const { controller } = createController();

    await expect(
      controller.linkSearch(user, spaceId, { q: 'run' }),
    ).resolves.toEqual({
      success: true,
      items: [
        {
          href: `/spaces/${spaceId}/wiki/runbook`,
          name: 'Runbook',
          description: 'runbook',
        },
      ],
    });
  });

  it('restores versions from legacy POST /versions body shape', async () => {
    const { controller, wikiService } = createController();

    await controller.restoreVersion(user, spaceId, pageId, { version: 3 });

    expect(wikiService.restoreVersion).toHaveBeenCalledWith(
      pageId,
      spaceId,
      3,
      user.userId,
    );
  });

  it('deletes attachments using legacy attachmentId/id query aliases', async () => {
    const { controller, wikiService } = createController();

    await expect(
      controller.deleteAttachmentByQuery(
        user,
        spaceId,
        pageId,
        undefined,
        attachmentId,
      ),
    ).resolves.toEqual({ success: true });

    expect(wikiService.deleteAttachment).toHaveBeenCalledWith(
      attachmentId,
      pageId,
      spaceId,
      user.userId,
    );
  });

  it('passes the user id for page delete audit logging', async () => {
    const { controller, wikiService } = createController();

    await controller.remove(user, spaceId, pageId);

    expect(wikiService.deletePage).toHaveBeenCalledWith(
      pageId,
      spaceId,
      user.userId,
      user,
    );
  });

  it('gates a wiki whiteboard like a page create: parent can_create, else the space matrix', async () => {
    const { controller, wikiService, permissionsService } = createController();

    await controller.createWhiteboard(user, spaceId, {
      name: 'Retro',
      parent_id: pageId,
    });
    await controller.createWhiteboard(user, spaceId, { name: 'Root' });

    expect(permissionsService.assertPageAccess).toHaveBeenCalledWith(
      pageId,
      user.userId,
      spaceId,
      'can_create',
    );
    expect(permissionsService.assertSpaceCanCreate).toHaveBeenCalledTimes(1);
    expect(wikiService.createWhiteboardPage).toHaveBeenCalledWith(
      spaceId,
      user,
      { name: 'Retro', parent_id: pageId },
    );
  });

  it('returns legacy reorder updated count', async () => {
    const { controller } = createController();

    await expect(
      controller.reorder(spaceId, {
        updates: [
          { id: pageId, sort_order: 0 },
          { id: attachmentId, sort_order: 1 },
        ],
      }),
    ).resolves.toEqual({ success: true, updated: 2 });
  });
});
