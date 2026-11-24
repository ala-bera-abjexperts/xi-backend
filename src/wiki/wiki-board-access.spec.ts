/**
 * @fileoverview WikiPermissionsService.resolveBoardAccess — a whiteboard's Share setting is the
 * page ACL on its wiki link row. Only restricted boards come back; everything else keeps the
 * space-level whiteboard rights (so boards nobody shared behave exactly as before).
 * @module src/wiki/wiki-board-access.spec
 */
import { BadRequestException } from '@nestjs/common';

import { WikiPermissionsService } from './wiki-permissions.service';

import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { WikiCollabBroadcastService } from './wiki-collab-broadcast.service';

const SPACE = 'space-1';
const ME = 'user-me';
const BOARD = 'board-1';
const LINK = 'page-link';
const FOLDER = 'page-folder';

type Row = Record<string, unknown>;

/** Thenable chain resolving to `result`. */
function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {};
  const self = () => c;

  for (const m of ['select', 'eq', 'in']) c[m] = jest.fn(self);
  // Single-row reads (resolveWithTrace's page lookup) get the first row
  c.maybeSingle = jest.fn(() =>
    Promise.resolve({
      data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data,
      error: result.error,
    }),
  );
  c.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);

  return c as Record<string, jest.Mock>;
}

describe('WikiPermissionsService.resolveBoardAccess', () => {
  let pages: Row[];
  let perms: Row[];
  let pagesError: unknown;
  let service: WikiPermissionsService;
  let ctx: jest.SpyInstance;
  let spacePerms: Record<string, boolean>;

  const grant = (
    pageId: string,
    entity_id: string,
    level: 'view' | 'edit' | 'delete',
    entity_type = 'user',
  ) => ({
    wiki_page_id: pageId,
    entity_type,
    entity_id,
    can_view: true,
    can_edit: level !== 'view',
    can_delete: level === 'delete',
  });

  const link = (over: Row = {}) => ({
    id: LINK,
    whiteboard_id: BOARD,
    created_by: 'user-owner',
    // The wiki_pages_path trigger ends `path` with the row's own id
    path: [LINK],
    ...over,
  });

  beforeEach(() => {
    pages = [link()];
    perms = [];
    pagesError = null;

    const supabase = {
      getClient: () => ({
        from: (table: string) =>
          table === 'wiki_pages'
            ? chain({ data: pages, error: pagesError })
            : chain({ data: perms, error: null }),
      }),
    } as unknown as SupabaseAdminService;

    spacePerms = {};
    service = new WikiPermissionsService(
      supabase,
      {
        getUserSpacePermissions: jest.fn(() =>
          Promise.resolve({ isMember: true, permissions: spacePerms }),
        ),
      } as unknown as PermissionsService,
      {} as WikiCollabBroadcastService,
    );
    ctx = jest
      .spyOn(service, 'resolveUserContext')
      .mockResolvedValue({ roleIds: [], groupIds: [], isSpaceAdmin: false });
  });

  const access = async () =>
    (await service.resolveBoardAccess(ME, SPACE, [BOARD])).get(BOARD);

  it('leaves a board without a wiki row unrestricted', async () => {
    pages = [];

    await expect(access()).resolves.toBeUndefined();
  });

  it('leaves a linked board with no share rows unrestricted, without membership lookups', async () => {
    await expect(access()).resolves.toBeUndefined();
    expect(ctx).not.toHaveBeenCalled();
  });

  it('gives a view-only invitee view, not edit or delete', async () => {
    perms = [grant(LINK, ME, 'view'), grant(LINK, 'user-owner', 'delete')];

    await expect(access()).resolves.toEqual({
      can_view: true,
      can_edit: false,
      can_delete: false,
    });
  });

  it('gives an edit invitee view + edit', async () => {
    perms = [grant(LINK, ME, 'edit')];

    await expect(access()).resolves.toEqual({
      can_view: true,
      can_edit: true,
      can_delete: false,
    });
  });

  it('denies everything to a user left out of a restricted board', async () => {
    perms = [grant(LINK, 'someone-else', 'edit')];

    await expect(access()).resolves.toEqual({
      can_view: false,
      can_edit: false,
      can_delete: false,
    });
  });

  it('matches group grants (most permissive wins)', async () => {
    ctx.mockResolvedValue({
      roleIds: [],
      groupIds: ['g-1'],
      isSpaceAdmin: false,
    });
    perms = [grant(LINK, ME, 'view'), grant(LINK, 'g-1', 'edit', 'group')];

    await expect(access()).resolves.toMatchObject({
      can_view: true,
      can_edit: true,
    });
  });

  it('inherits a restriction from a parent folder', async () => {
    pages = [link({ path: [FOLDER, LINK] })];
    perms = [grant(FOLDER, 'someone-else', 'view')];

    await expect(access()).resolves.toMatchObject({ can_view: false });
  });

  it("lets the board's own rows override its folder's", async () => {
    pages = [link({ path: [FOLDER, LINK] })];
    perms = [grant(FOLDER, 'someone-else', 'view'), grant(LINK, ME, 'edit')];

    await expect(access()).resolves.toMatchObject({
      can_view: true,
      can_edit: true,
    });
  });

  it('never restricts the owner (link-row creator)', async () => {
    pages = [link({ created_by: ME })];
    perms = [grant(LINK, 'someone-else', 'view')];

    await expect(access()).resolves.toBeUndefined();
  });

  it('never restricts a space/org admin', async () => {
    ctx.mockResolvedValue({ roleIds: [], groupIds: [], isSpaceAdmin: true });
    perms = [grant(LINK, 'someone-else', 'view')];

    await expect(access()).resolves.toBeUndefined();
  });

  it('fails closed when the link rows cannot be read', async () => {
    pagesError = { message: 'boom' };

    await expect(access()).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('access dialog baseline for a board row', () => {
    // A member who may edit boards but only read wiki pages
    beforeEach(() => {
      spacePerms = {
        view_wiki_pages: true,
        edit_wiki_pages: false,
        view_whiteboards: true,
        edit_whiteboards: true,
      };
    });

    it('reports the whiteboard rights, not the wiki ones, on an unshared board', async () => {
      pages = [{ ...link(), organization_id: 'org-1' }];

      const trace = await service.resolveWithTrace(ME, LINK, SPACE);

      expect(trace.source).toBe('space_default');
      expect(trace.decision).toMatchObject({ can_view: true, can_edit: true });
    });

    it('keeps the wiki rights for an ordinary page', async () => {
      pages = [
        {
          id: LINK,
          whiteboard_id: null,
          path: [LINK],
          organization_id: 'org-1',
        },
      ];

      const trace = await service.resolveWithTrace(ME, LINK, SPACE);

      expect(trace.decision).toMatchObject({ can_view: true, can_edit: false });
    });
  });
});
