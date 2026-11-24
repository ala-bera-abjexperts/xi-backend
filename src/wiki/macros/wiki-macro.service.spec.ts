import {
  BadRequestException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { ResolveWikiMacroDto } from './wiki-macro.contract';
import { WikiMacroRepository } from './wiki-macro.repository';
import { WikiMacroService } from './wiki-macro.service';

const USER = {
  userId: '10000000-0000-4000-8000-000000000001',
  authUserId: '10000000-0000-4000-8000-000000000002',
  organizationId: '10000000-0000-4000-8000-000000000003',
  email: 'reader@example.com',
  memberships: [],
};
const SPACE_ID = '20000000-0000-4000-8000-000000000001';
const PAGE_ID = '30000000-0000-4000-8000-000000000001';

describe('WikiMacroService', () => {
  const wikiService = {
    getPages: jest.fn(),
    getPageById: jest.fn(),
    searchPages: jest.fn(),
    getAttachments: jest.fn(),
    getVersions: jest.fn(),
  };
  const labelsService = {
    getLabels: jest.fn(),
    getBulkPageLabels: jest.fn(),
  };
  const permissionsService = {
    assertPageAccess: jest.fn(),
    filterAccessiblePages: jest.fn(),
  };
  const repository = {
    getSpace: jest.fn(),
    getBlogSpaces: jest.fn(),
    getBlogAuthorNames: jest.fn(),
    getSpaceMembers: jest.fn(),
    getSpaceMemberByUserId: jest.fn(),
    getDecisionPages: jest.fn(),
  };
  const basePermissionsService = {
    resolveSpaceBaseGrant: jest.fn(),
  };

  const service = new WikiMacroService(
    wikiService as never,
    labelsService as never,
    permissionsService as never,
    repository as never,
    basePermissionsService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    repository.getBlogAuthorNames.mockResolvedValue({});
    repository.getSpace.mockResolvedValue({
      id: SPACE_ID,
      organization_id: USER.organizationId,
      name: 'Engineering',
      key: 'ENG',
      description: 'Builds things',
    });
    permissionsService.assertPageAccess.mockResolvedValue(undefined);
    permissionsService.filterAccessiblePages.mockImplementation(
      (pages: Array<Record<string, unknown>>) => Promise.resolve(pages),
    );
    basePermissionsService.resolveSpaceBaseGrant.mockResolvedValue({
      isAdmin: false,
      isMember: true,
      spaceRole: 'member',
      explicit: {},
      basePermissions: { view_wiki_pages: true },
    });
  });

  it('paginates published blogs and rechecks access before returning bodies', async () => {
    repository.getBlogSpaces.mockResolvedValue([{ id: SPACE_ID, key: 'ENG', name: 'Engineering', starred: true }]);
    const post = { id: PAGE_ID, title: 'Recovery', created_at: '2026-09-07T00:00:00Z', metadata: { content_kind: 'blogpost' } };
    wikiService.getPages.mockResolvedValueOnce({ data: [], hasMore: true, nextCursor: 'next' }).mockResolvedValueOnce({ data: [post], hasMore: false });
    labelsService.getBulkPageLabels.mockResolvedValue({ [PAGE_ID]: [{ label: { name: 'approved' } }] });
    wikiService.getPageById.mockResolvedValue({ content: '<p>Approved</p>', content_format: 'html', is_published: true });
    const result = await service.resolve(USER, SPACE_ID, { kind: 'blogPosts', params: { label: '+approved', spaces: '@favorite' } });
    expect(result.data).toHaveLength(1);
    expect(wikiService.getPages).toHaveBeenLastCalledWith(SPACE_ID, expect.objectContaining({ cursor: 'next', is_published: true }), USER.userId);
    expect(permissionsService.assertPageAccess).toHaveBeenCalledWith(PAGE_ID, USER.userId, SPACE_ID, 'can_view');
  });

  it('does not query blog contents in spaces denied to the reader', async () => {
    repository.getBlogSpaces.mockResolvedValue([{ id: 'denied', key: 'PRIVATE', name: 'Private' }]);
    basePermissionsService.resolveSpaceBaseGrant.mockResolvedValueOnce({ isAdmin: true }).mockResolvedValueOnce({ isAdmin: false, isMember: false, basePermissions: {} });
    const result = await service.resolve(USER, SPACE_ID, { kind: 'blogPosts', params: { spaces: '@all' } });
    expect(result.data).toEqual([]);
    expect(wikiService.getPages).not.toHaveBeenCalled();
  });

  it('rejects unknown kinds and unknown parameters before querying data', async () => {
    await expect(
      service.resolve(USER, SPACE_ID, {
        kind: 'unknown',
        params: {},
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.resolve(USER, SPACE_ID, {
        kind: 'recentlyUpdated',
        params: { arbitraryTarget: PAGE_ID },
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(wikiService.getPages).not.toHaveBeenCalled();
    expect(repository.getSpace).not.toHaveBeenCalled();
  });

  it('checks the active tenant before resolving any macro', async () => {
    repository.getSpace.mockRejectedValueOnce(
      new NotFoundException('Space not found'),
    );

    await expect(
      service.resolve(USER, SPACE_ID, {
        kind: 'spaceDetails',
        params: {},
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.getSpace).toHaveBeenCalledWith(
      SPACE_ID,
      USER.organizationId,
    );
  });

  it('rejects callers without the shared space wiki grant', async () => {
    basePermissionsService.resolveSpaceBaseGrant.mockResolvedValueOnce({
      isAdmin: false,
      isMember: false,
      spaceRole: null,
      explicit: {},
      basePermissions: {},
    });

    await expect(
      service.resolve(USER, SPACE_ID, {
        kind: 'spaceDetails',
        params: {},
      }),
    ).rejects.toThrow('Insufficient space permissions');

    expect(repository.getSpace).not.toHaveBeenCalled();
  });

  it('resolves a capped ACL-filtered page tree', async () => {
    wikiService.getPages.mockResolvedValue({
      data: [
        { id: PAGE_ID, title: 'Root', parent_id: null, level: 0 },
        {
          id: '30000000-0000-4000-8000-000000000002',
          title: 'Child',
          parent_id: PAGE_ID,
          level: 1,
        },
        {
          id: '30000000-0000-4000-8000-000000000003',
          title: 'Grandchild',
          parent_id: '30000000-0000-4000-8000-000000000002',
          level: 2,
        },
      ],
      total: 3,
      hasMore: false,
    });

    const result = await service.resolve(USER, SPACE_ID, {
      kind: 'pageTree',
      params: { rootPageId: PAGE_ID, depth: 1, limit: 100 },
    });

    expect(permissionsService.assertPageAccess).toHaveBeenCalledWith(
      PAGE_ID,
      USER.userId,
      SPACE_ID,
      'can_view',
    );
    expect(wikiService.getPages).toHaveBeenCalledWith(
      SPACE_ID,
      expect.objectContaining({ limit: 500, is_archived: false }),
      USER.userId,
    );
    expect(result).toMatchObject({
      kind: 'pageTree',
      data: [
        expect.objectContaining({ id: PAGE_ID }),
        expect.objectContaining({ title: 'Child' }),
      ],
      pagination: { limit: 100, offset: 0, total: 2, hasMore: false },
    });
  });

  it('does not broaden an unresolved page-tree root to the whole space', async () => {
    const result = await service.resolve(USER, SPACE_ID, {
      kind: 'pageTree',
      params: {},
    });

    expect(result).toMatchObject({
      kind: 'pageTree',
      data: [],
      meta: { unresolvedRoot: true },
    });
    expect(wikiService.getPages).not.toHaveBeenCalled();
  });

  it('binds attachments and history to an ACL-checked page and paginates', async () => {
    wikiService.getAttachments.mockResolvedValue([
      { id: 'a1', file_name: 'new.pdf' },
      { id: 'a2', file_name: 'old.pdf' },
    ]);
    wikiService.getVersions.mockResolvedValue([
      { id: 'v2', version: 2 },
      { id: 'v1', version: 1 },
    ]);

    const attachments = await service.resolve(USER, SPACE_ID, {
      kind: 'attachmentsList',
      params: { pageId: PAGE_ID, limit: 1, offset: 1 },
    });
    const history = await service.resolve(USER, SPACE_ID, {
      kind: 'changeHistory',
      params: { pageId: PAGE_ID, limit: 1 },
    });

    expect(permissionsService.assertPageAccess).toHaveBeenCalledTimes(2);
    expect(attachments).toMatchObject({
      kind: 'attachmentsList',
      data: [{ id: 'a2' }],
      pagination: { total: 2, hasMore: false },
    });
    expect(history).toMatchObject({
      kind: 'changeHistory',
      data: [{ id: 'v2' }],
      pagination: { total: 2, hasMore: true },
    });
  });

  it('never broadens unsupported recent content types or malformed search', async () => {
    const recent = await service.resolve(USER, SPACE_ID, {
      kind: 'recentlyUpdated',
      params: { types: ['blogpost'] },
    });
    const search = await service.resolve(USER, SPACE_ID, {
      kind: 'pageTreeSearch',
      params: { mode: 'search', query: 'x' },
    });

    expect(recent).toMatchObject({ kind: 'recentlyUpdated', data: [] });
    expect(search).toMatchObject({ kind: 'pageTreeSearch', data: [] });
    expect(wikiService.getPages).not.toHaveBeenCalled();
    expect(wikiService.searchPages).not.toHaveBeenCalled();
  });

  it('does not broaden a valid search without its current-page root', async () => {
    const result = await service.resolve(USER, SPACE_ID, {
      kind: 'pageTreeSearch',
      params: { mode: 'search', query: 'architecture' },
    });

    expect(result).toMatchObject({
      kind: 'pageTreeSearch',
      data: [],
      meta: { unresolvedRoot: true },
    });
    expect(wikiService.getPages).not.toHaveBeenCalled();
    expect(wikiService.searchPages).not.toHaveBeenCalled();
  });

  it('accepts 1000-character stored search text and rejects anything longer', async () => {
    const query = 'a'.repeat(1000);
    wikiService.getPages.mockResolvedValue({
      data: [{ id: PAGE_ID, parent_id: null }],
      total: 1,
      hasMore: false,
    });
    wikiService.searchPages.mockResolvedValue([]);

    await expect(
      service.resolve(USER, SPACE_ID, {
        kind: 'pageTreeSearch',
        params: { rootPageId: PAGE_ID, query },
      }),
    ).resolves.toMatchObject({ kind: 'pageTreeSearch', data: [] });
    await expect(
      service.resolve(USER, SPACE_ID, {
        kind: 'pageTreeSearch',
        params: { rootPageId: PAGE_ID, query: `${query}a` },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(['320', '320px', '75%', '40em', '40rem'])(
    'accepts a safe imported space-details width: %s',
    async (width) => {
      await expect(
        service.resolve(USER, SPACE_ID, {
          kind: 'spaceDetails',
          params: { width },
        }),
      ).resolves.toMatchObject({ meta: { width } });
    },
  );

  it.each(['0', '101%', '4097px', '-10px', 'calc(100% - 1px)', '1vw'])(
    'rejects an unsafe or unbounded space-details width: %s',
    async (width) => {
      await expect(
        service.resolve(USER, SPACE_ID, {
          kind: 'spaceDetails',
          params: { width },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('filters tree search results through the page ACL and root descendants', async () => {
    const childId = '30000000-0000-4000-8000-000000000002';
    const outsideId = '30000000-0000-4000-8000-000000000003';
    wikiService.getPages.mockResolvedValue({
      data: [
        { id: PAGE_ID, parent_id: null },
        { id: childId, parent_id: PAGE_ID },
        { id: outsideId, parent_id: null },
      ],
      total: 3,
      hasMore: false,
    });
    wikiService.searchPages.mockResolvedValue([
      { id: childId, title: 'Inside' },
      { id: outsideId, title: 'Outside' },
    ]);
    permissionsService.filterAccessiblePages.mockResolvedValue([
      { id: childId, title: 'Inside' },
    ]);

    const result = await service.resolve(USER, SPACE_ID, {
      kind: 'pageTreeSearch',
      params: { rootPageId: PAGE_ID, mode: 'searchResults', query: 'in' },
    });

    expect(result).toMatchObject({
      kind: 'pageTreeSearch',
      data: [{ id: childId, title: 'Inside' }],
    });
    expect(permissionsService.filterAccessiblePages).toHaveBeenCalledWith(
      expect.any(Array),
      USER.userId,
      SPACE_ID,
    );
  });

  it('does not widen unmapped user groups and returns only safe direct members', async () => {
    repository.getSpaceMembers.mockResolvedValue({
      data: [
        {
          id: 'm1',
          member_type: 'user',
          user_id: USER.userId,
          user: {
            id: USER.userId,
            first_name: 'Reader',
            last_name: 'One',
            avatar_url: '/avatar.png',
          },
          space_role: 'member',
        },
      ],
      total: 125,
      hasMore: true,
    });

    const unresolved = await service.resolve(USER, SPACE_ID, {
      kind: 'userList',
      params: { groups: ['engineering'] },
    });
    const resolved = await service.resolve(USER, SPACE_ID, {
      kind: 'userList',
      params: {},
    });

    expect(unresolved).toMatchObject({
      kind: 'userList',
      data: [],
      meta: { unresolvedGroups: ['engineering'] },
    });
    expect(resolved).toMatchObject({
      kind: 'userList',
      data: [
        {
          id: USER.userId,
          name: 'Reader One',
          avatarUrl: '/avatar.png',
          role: 'member',
        },
      ],
      pagination: { limit: 100, offset: 0, total: 125, hasMore: true },
    });
    expect(repository.getSpaceMembers).toHaveBeenCalledWith(SPACE_ID, 100, 0);
    expect(JSON.stringify(resolved)).not.toContain(USER.email);
  });

  it('never substitutes the viewer for a source username', async () => {
    const result = await service.resolve(USER, SPACE_ID, {
      kind: 'profilePicture', params: { userName: 'Source Person' },
    });
    expect(result).toMatchObject({ data: { id: null, name: 'Source Person' }, meta: { unresolved: true } });
    expect(repository.getSpaceMemberByUserId).not.toHaveBeenCalled();
  });

  it('keeps unresolved profile-picture identity aliases explicit', async () => {
    const result = await service.resolve(USER, SPACE_ID, {
      kind: 'profilePicture',
      params: {
        userId: 'confluence-account-id',
        userKey: 'legacy-user-key',
        userName: 'Ada Lovelace',
      },
    });

    expect(result).toMatchObject({
      kind: 'profilePicture',
      data: { id: null, name: 'Ada Lovelace', avatarUrl: null },
      meta: {
        unresolved: true,
        userId: 'confluence-account-id',
        userKey: 'legacy-user-key',
        userName: 'Ada Lovelace',
      },
    });
    expect(repository.getSpaceMemberByUserId).not.toHaveBeenCalled();
  });

  it('does not infer local identity from a UUID-shaped source userKey', async () => {
    repository.getSpaceMemberByUserId.mockResolvedValue({
      id: 'm1',
      member_type: 'user',
      user_id: USER.userId,
      user: {
        id: USER.userId,
        first_name: 'Reader',
        last_name: 'One',
        avatar_url: '/avatar.png',
      },
      space_role: 'member',
    });

    await expect(
      service.resolve(USER, SPACE_ID, {
        kind: 'profilePicture',
        params: { userKey: USER.userId, userName: 'Imported name' },
      }),
    ).resolves.toMatchObject({
      kind: 'profilePicture',
      data: { id: null, name: 'Imported name' },
      meta: { unresolved: true },
    });
    expect(repository.getSpaceMemberByUserId).not.toHaveBeenCalled();
  });

  it('resolves a visible user profile without leaking non-member data', async () => {
    repository.getSpaceMemberByUserId.mockResolvedValue({
      id: 'm1',
      member_type: 'user',
      user_id: USER.userId,
      user: {
        id: USER.userId,
        first_name: 'Reader',
        last_name: 'One',
        avatar_url: '/avatar.png',
      },
      space_role: 'member',
    });

    const result = await service.resolve(USER, SPACE_ID, {
      kind: 'userProfile',
      params: { userId: USER.userId },
    } as never);

    expect(result).toMatchObject({
      kind: 'userProfile',
      data: {
        id: USER.userId,
        name: 'Reader One',
        avatarUrl: '/avatar.png',
        role: 'member',
      },
    });
    expect(JSON.stringify(result)).not.toContain('email');
  });

  it('returns an explicit unresolved user profile without directory widening', async () => {
    const result = await service.resolve(USER, SPACE_ID, {
      kind: 'userProfile',
      params: { userKey: 'legacy-key', userName: 'Former teammate' },
    });

    expect(result).toMatchObject({
      kind: 'userProfile',
      data: {
        id: null,
        name: 'Former teammate',
        avatarUrl: null,
        role: null,
      },
      meta: { unresolved: true, userKey: 'legacy-key' },
    });
    expect(repository.getSpaceMemberByUserId).not.toHaveBeenCalled();
  });

  it('counts popular labels only across ACL-visible pages', async () => {
    wikiService.getPages.mockResolvedValue({
      data: [{ id: PAGE_ID }],
      total: 1,
      hasMore: false,
    });
    labelsService.getLabels.mockResolvedValue([
      { id: 'l1', name: 'security', color: '#123456' },
      { id: 'l2', name: 'hidden', color: '#654321' },
    ]);
    labelsService.getBulkPageLabels.mockResolvedValue({
      [PAGE_ID]: [{ label_id: 'l1', label: { id: 'l1' } }],
    });

    const result = await service.resolve(USER, SPACE_ID, {
      kind: 'popularLabels',
      params: { count: 10, style: 'heatmap' },
    });

    expect(labelsService.getBulkPageLabels).toHaveBeenCalledWith([PAGE_ID]);
    expect(result).toMatchObject({
      kind: 'popularLabels',
      data: [{ id: 'l1', name: 'security', count: 1 }],
      meta: { style: 'heatmap' },
    });
  });

  it('resolves label reports from ACL-visible page assignments without broadening empty filters', async () => {
    const secondPageId = '30000000-0000-4000-8000-000000000002';
    wikiService.getPages.mockResolvedValue({
      data: [
        {
          id: PAGE_ID,
          title: 'Security guide',
          created_by: USER.userId,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-03-01T00:00:00Z',
        },
        {
          id: secondPageId,
          title: 'Operations guide',
          created_by: '10000000-0000-4000-8000-000000000099',
          created_at: '2026-02-01T00:00:00Z',
          updated_at: '2026-02-01T00:00:00Z',
        },
      ],
      total: 2,
      hasMore: false,
    });
    labelsService.getBulkPageLabels.mockResolvedValue({
      [PAGE_ID]: [
        {
          label_id: 'l1',
          assigned_at: '2026-04-01T00:00:00Z',
          label: { id: 'l1', name: 'security', color: '#123456' },
        },
        {
          label_id: 'l2',
          assigned_at: '2026-03-01T00:00:00Z',
          label: { id: 'l2', name: 'review', color: '#654321' },
        },
      ],
      [secondPageId]: [
        {
          label_id: 'l2',
          assigned_at: '2026-02-01T00:00:00Z',
          label: { id: 'l2', name: 'review', color: '#654321' },
        },
      ],
    });

    const recent = await service.resolve(USER, SPACE_ID, {
      kind: 'recentlyUsedLabels',
      params: { scope: 'space', count: 1, style: 'table' },
    });
    const related = await service.resolve(USER, SPACE_ID, {
      kind: 'relatedLabels',
      params: { labels: ['security'] },
    });
    const report = await service.resolve(USER, SPACE_ID, {
      kind: 'contentReportTable',
      params: { labels: ['security', 'missing'], limit: 20 },
    });
    const nav = await service.resolve(USER, SPACE_ID, {
      kind: 'navigationMap',
      params: { label: 'security', wrapAfter: 3 },
    });
    const empty = await service.resolve(USER, SPACE_ID, {
      kind: 'contentReportTable',
      params: { labels: [] },
    });

    expect(recent).toMatchObject({
      kind: 'recentlyUsedLabels',
      data: [{ name: 'security', count: 1 }],
      meta: { scope: 'space', style: 'table' },
    });
    expect(related).toMatchObject({
      kind: 'relatedLabels',
      data: [{ name: 'review', count: 1 }],
    });
    expect(report).toMatchObject({
      kind: 'contentReportTable',
      data: [expect.objectContaining({ id: PAGE_ID })],
    });
    expect(nav).toMatchObject({
      kind: 'navigationMap',
      data: [expect.objectContaining({ id: PAGE_ID })],
      meta: { label: 'security', wrapAfter: 3 },
    });
    expect(empty).toMatchObject({
      kind: 'contentReportTable',
      data: [],
      meta: { missingLabels: true },
    });
  });

  it('fails closed for unsupported label scope and unresolved legacy users', async () => {
    const global = await service.resolve(USER, SPACE_ID, {
      kind: 'recentlyUsedLabels',
      params: { scope: 'global' },
    });
    const legacyUser = await service.resolve(USER, SPACE_ID, {
      kind: 'contentByUser',
      params: { userName: 'legacy-user' },
    });

    expect(global).toMatchObject({
      kind: 'recentlyUsedLabels',
      data: [],
      meta: { unsupportedScope: 'global' },
    });
    expect(legacyUser).toMatchObject({
      kind: 'contentByUser',
      data: [],
      meta: { unresolvedUser: true, userName: 'legacy-user' },
    });
    expect(wikiService.getPages).not.toHaveBeenCalled();
  });

  it('filters content-by-user and dashboard pages by exact stored filters', async () => {
    const otherUser = '10000000-0000-4000-8000-000000000099';
    wikiService.getPages.mockResolvedValue({
      data: [
        {
          id: PAGE_ID,
          title: 'Owned',
          created_by: USER.userId,
          updated_at: '2026-03-01T00:00:00Z',
        },
        {
          id: '30000000-0000-4000-8000-000000000002',
          title: 'Other',
          created_by: otherUser,
          updated_at: '2026-04-01T00:00:00Z',
        },
      ],
      total: 2,
      hasMore: false,
    });
    labelsService.getBulkPageLabels.mockResolvedValue({
      [PAGE_ID]: [{ label: { name: 'security' } }],
    });
    repository.getSpaceMemberByUserId.mockResolvedValue({
      user_id: USER.userId,
      user: { id: USER.userId, first_name: 'Reader', last_name: 'One' },
    });

    const byUser = await service.resolve(USER, SPACE_ID, {
      kind: 'contentByUser',
      params: { userId: USER.userId },
    });
    const dashboard = await service.resolve(USER, SPACE_ID, {
      kind: 'recentlyUpdatedDashboard',
      params: { labels: ['security'], users: [USER.userId], types: ['page'] },
    });

    expect(byUser).toMatchObject({
      kind: 'contentByUser',
      data: [expect.objectContaining({ title: 'Owned' })],
    });
    expect(dashboard).toMatchObject({
      kind: 'recentlyUpdatedDashboard',
      data: [expect.objectContaining({ title: 'Owned' })],
    });
  });

  it('extracts decisions only from ACL-filtered candidate pages and rejects unsupported CQL by returning no data', async () => {
    wikiService.getPages.mockResolvedValue({
      data: [{ id: PAGE_ID, title: 'Architecture decision' }],
      total: 1,
      hasMore: false,
    });
    labelsService.getBulkPageLabels.mockResolvedValue({
      [PAGE_ID]: [{ label: { name: 'architecture' } }],
    });
    repository.getDecisionPages.mockResolvedValue([
      {
        id: PAGE_ID,
        title: 'Architecture decision',
        content: JSON.stringify({
          type: 'doc',
          content: [
            {
              type: 'decisionList',
              content: [
                {
                  type: 'decisionItem',
                  attrs: { state: 'DECIDED' },
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Use Postgres' }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      },
    ]);

    const result = await service.resolve(USER, SPACE_ID, {
      kind: 'decisionReport',
      params: { labels: ['architecture'], limit: 10 },
    });
    const unsupported = await service.resolve(USER, SPACE_ID, {
      kind: 'decisionReport',
      params: { cql: 'creator = currentUser()' },
    });

    expect(repository.getDecisionPages).toHaveBeenCalledWith([PAGE_ID], 100);
    expect(result).toMatchObject({
      kind: 'decisionReport',
      data: [
        {
          pageId: PAGE_ID,
          pageTitle: 'Architecture decision',
          decision: 'Use Postgres',
          state: 'DECIDED',
        },
      ],
    });
    expect(unsupported).toMatchObject({
      kind: 'decisionReport',
      data: [],
      meta: { unsupportedCql: 'creator = currentUser()' },
    });
  });
});

describe('ResolveWikiMacroDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const metadata = {
    type: 'body' as const,
    metatype: ResolveWikiMacroDto,
    data: undefined,
  };

  it('matches the global validation pipe and rejects unknown top-level input', async () => {
    await expect(
      pipe.transform(
        { kind: 'pageTree', params: {}, targetId: PAGE_ID },
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unknown macro discriminants', async () => {
    await expect(
      pipe.transform({ kind: 'anything', params: {} }, metadata),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('WikiMacroRepository bounded member reads', () => {
  it('caps and paginates the direct-user list in the database query', async () => {
    const range = jest.fn().mockResolvedValue({
      data: [{ id: 'm1', user_id: USER.userId }],
      count: 125,
      error: null,
    });
    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      not: jest.fn(),
      order: jest.fn(),
      range,
    };
    Object.values(query)
      .filter((fn) => fn !== range)
      .forEach((fn) => fn.mockReturnValue(query));
    const repository = new WikiMacroRepository({
      getClient: () => ({ from: jest.fn().mockReturnValue(query) }),
    } as never);

    const result = await repository.getSpaceMembers(SPACE_ID, 1_000, -10);

    expect(range).toHaveBeenCalledWith(0, 99);
    expect(result).toEqual({
      data: [{ id: 'm1', user_id: USER.userId }],
      total: 125,
      hasMore: true,
    });
  });

  it('looks up one exact active space member without selecting email', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'm1', user_id: USER.userId },
      error: null,
    });
    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      maybeSingle,
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    const from = jest.fn().mockReturnValue(query);
    const repository = new WikiMacroRepository({
      getClient: () => ({ from }),
    } as never);

    await expect(
      repository.getSpaceMemberByUserId(SPACE_ID, USER.userId, USER.organizationId),
    ).resolves.toEqual({ id: 'm1', user_id: USER.userId });
    expect(query.select).toHaveBeenCalledWith(
      expect.not.stringContaining('email'),
    );
    expect(query.eq).toHaveBeenCalledWith('space_id', SPACE_ID);
    expect(query.eq).toHaveBeenCalledWith('user_id', USER.userId);
    expect(query.eq).toHaveBeenCalledWith('is_active', true);
    expect(query.eq).toHaveBeenCalledWith('user.is_active', true);
    expect(query.eq).toHaveBeenCalledWith('user.organization_members.organization_id', USER.organizationId);
  });
});
