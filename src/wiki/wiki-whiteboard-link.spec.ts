// wiki.service transitively imports sanitize-rich-text, which pulls in jsdom (ESM) that ts-jest
// cannot transform. Stub the sanitizer (identity), matching wiki-page-source-updated-at.spec.ts.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';

import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { WikiService } from './wiki.service';

/** Whiteboard link rows: wiki_pages rows whose whiteboard_id points at a board. */
type Result = {
  data: unknown;
  error: { message: string } | null;
  count?: number;
};

function chain(result: Result) {
  const value: Record<string, unknown> = {};
  const self = () => value;
  for (const method of [
    'select',
    'insert',
    'update',
    'delete',
    'eq',
    'neq',
    'in',
    'is',
    'order',
    'limit',
  ]) {
    value[method] = jest.fn(self);
  }
  value['single'] = jest.fn().mockResolvedValue(result);
  value['maybeSingle'] = jest.fn().mockResolvedValue(result);
  value['then'] = (fn: (resolved: Result) => unknown) =>
    Promise.resolve(result).then(fn);
  return value;
}

const ORG = 'org-1';
const SPACE = 'space-1';
const PAGE = 'page-1';
const WB = 'wb-1';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;
const linkRow = {
  id: PAGE,
  organization_id: ORG,
  space_id: SPACE,
  title: 'Retro',
  slug: 'retro',
  content: '',
  content_format: 'editorjs',
  metadata: {},
  is_published: true,
  is_archived: false,
  whiteboard_id: WB,
};

function makeService(responses: Record<string, Result[]>, allowed = true) {
  const from = jest.fn((table: string) => {
    const next = responses[table]?.shift();
    if (!next) throw new Error(`No response configured for ${table}`);
    return chain(next);
  });
  const permissions = {
    hasSpacePermission: jest.fn().mockResolvedValue(allowed),
  };
  const boards = {
    create: jest.fn().mockResolvedValue({ id: WB, name: 'Retro' }),
    removeFromWiki: jest.fn().mockResolvedValue({ success: true }),
  };
  const service = new WikiService(
    { getClient: () => ({ from }) } as never,
    {} as never,
    { assertKeysAllowed: jest.fn().mockResolvedValue(undefined) } as never,
    undefined,
    undefined,
    undefined,
    permissions as never,
    undefined,
    boards as never,
  );
  jest
    .spyOn(service as never, 'logAudit' as never)
    .mockResolvedValue(undefined as never);
  jest.spyOn(service, 'notifyMentionedUsers').mockResolvedValue(undefined);
  return { service, from, permissions, boards };
}

describe('WikiService whiteboard link rows', () => {
  it('creates the board, then a published tree row linked to it', async () => {
    const { service, from, boards, permissions } = makeService({
      wiki_pages: [
        { data: null, error: null }, // slug probe: free
        {
          data: {
            id: PAGE,
            title: 'Retro',
            is_published: true,
            whiteboard_id: WB,
          },
          error: null,
        },
      ],
    });

    const result = await service.createWhiteboardPage(SPACE, user, {
      name: 'Retro',
    });

    expect(permissions.hasSpacePermission).toHaveBeenCalledWith(
      'user-1',
      ORG,
      SPACE,
      'create_whiteboards',
    );
    expect(boards.create).toHaveBeenCalledWith(SPACE, user, 'Retro');
    const pageInsert = from.mock.results[1].value as { insert: jest.Mock };
    const insert = pageInsert.insert;
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Retro',
        whiteboard_id: WB,
        is_published: true,
        organization_id: ORG,
        space_id: SPACE,
      }),
    );
    expect(result.whiteboard).toEqual({ id: WB, name: 'Retro' });
    expect(result.page).toMatchObject({ whiteboard_id: WB });
  });

  it('deletes the board again when the tree row cannot be written', async () => {
    const { service, boards } = makeService({
      wiki_pages: [
        { data: null, error: null },
        { data: null, error: { message: 'a whiteboard cannot contain pages' } },
      ],
    });

    await expect(
      service.createWhiteboardPage(SPACE, user, { name: 'Retro' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(boards.removeFromWiki).toHaveBeenCalledWith(SPACE, user, WB);
  });

  it('403s without create_whiteboards, before creating anything', async () => {
    const { service, boards, from } = makeService({}, false);

    await expect(
      service.createWhiteboardPage(SPACE, user, { name: 'Retro' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(boards.create).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('deleting a link row deletes the board (the FK cascade removes the row)', async () => {
    const { service, boards, from, permissions } = makeService({
      wiki_pages: [{ data: null, error: null, count: 0 }], // child count
      task_relationships: [{ data: null, error: null }],
    });
    jest.spyOn(service, 'getPageById').mockResolvedValue(linkRow);

    await service.deletePage(PAGE, SPACE, user.userId, user);

    expect(permissions.hasSpacePermission).toHaveBeenCalledWith(
      'user-1',
      ORG,
      SPACE,
      'delete_whiteboards',
    );
    expect(boards.removeFromWiki).toHaveBeenCalledWith(SPACE, user, WB);
    // Only the child count touched wiki_pages; the row itself was not deleted directly.
    expect(from.mock.calls.filter(([t]) => t === 'wiki_pages')).toHaveLength(1);
    expect(from).toHaveBeenCalledWith('task_relationships');
  });

  it('refuses to delete a link row without delete_whiteboards', async () => {
    const { service, boards } = makeService(
      { wiki_pages: [{ data: null, error: null, count: 0 }] },
      false,
    );
    jest.spyOn(service, 'getPageById').mockResolvedValue(linkRow);

    await expect(
      service.deletePage(PAGE, SPACE, user.userId, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(boards.removeFromWiki).not.toHaveBeenCalled();
  });

  it('checks delete_whiteboards before deleting any page of a folder', async () => {
    const { service, from } = makeService({}, false);
    const deletePage = jest.spyOn(service, 'deletePage');

    await expect(
      service.deletePageTree('folder-1', SPACE, user, [
        { id: 'page-2', depth: 1 },
        { id: PAGE, depth: 1, isWhiteboard: true },
      ]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(deletePage).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('409s a rename of an archived board with the whiteboards error code', async () => {
    const { service, permissions } = makeService({
      wiki_page_collab_snapshots: [{ data: null, error: null }],
      whiteboards: [{ data: { is_archived: true }, error: null }],
    });
    jest.spyOn(service, 'getPageById').mockResolvedValue(linkRow);

    const err = await service
      .updatePage(PAGE, SPACE, { title: 'Renamed' }, user.userId)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'WHITEBOARD_ARCHIVED',
    });
    expect(permissions.hasSpacePermission).toHaveBeenCalledWith(
      'user-1',
      ORG,
      SPACE,
      'edit_whiteboards',
    );
  });

  it('400s archiving a link row (archive lives on the board)', async () => {
    const { service } = makeService({
      wiki_page_collab_snapshots: [{ data: null, error: null }],
    });
    jest.spyOn(service, 'getPageById').mockResolvedValue({
      ...linkRow,
      is_published: false,
    });

    await expect(
      service.updatePage(PAGE, SPACE, { is_archived: true }, user.userId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400s cloning a link row', async () => {
    const { service, boards } = makeService({});
    jest.spyOn(service, 'getPageById').mockResolvedValue(linkRow);
    const createPage = jest.spyOn(service, 'createPage');

    await expect(
      service.clonePage(PAGE, SPACE, user.userId, ORG),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createPage).not.toHaveBeenCalled();
    expect(boards.create).not.toHaveBeenCalled();
  });
});
