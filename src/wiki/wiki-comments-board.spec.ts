// wiki.service pulls in jsdom through the sanitizer; stub it (identity), as wiki-user-display.spec.ts does.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { WikiCommentsService } from './wiki-comments.service';

/**
 * Comments on a whiteboard link row: pins (canvas anchors) are validated, only boards take
 * them, the Whiteboards view right is required, and an archived board takes no writes.
 */
const SPACE = '22222222-2222-4222-8222-222222222222';
const PAGE = '11111111-1111-4111-8111-111111111111';
const THREAD = '33333333-3333-4333-8333-333333333333';
const USER = 'user-1';

const BOARD_PAGE = {
  id: PAGE,
  title: 'Board',
  organization_id: 'org-1',
  whiteboard_id: 'board-1',
};

function build({
  page = BOARD_PAGE as Record<string, unknown>,
  canView = true,
  archived = false,
  boardCreator = 'user-creator',
  existing = null as Record<string, unknown> | null,
}: {
  page?: Record<string, unknown>;
  canView?: boolean;
  archived?: boolean;
  boardCreator?: string;

  /** The comment row a delete/resolve reads (maybeSingle on the comments table). */
  existing?: Record<string, unknown> | null;
} = {}) {
  const inserted: Record<string, unknown>[] = [];
  const deleted: unknown[] = [];
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {};

    for (const m of ['select', 'eq', 'order', 'is', 'not', 'in'])
      c[m] = () => c;
    c.maybeSingle = () => Promise.resolve(result);
    c.single = () => Promise.resolve(result);
    c.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(result).then(resolve);
    c.insert = (row: Record<string, unknown>) => {
      inserted.push(row);

      return chain({ data: { id: 'c-new', ...row }, error: null });
    };
    c.delete = () => (deleted.push(true), chain({ data: null, error: null }));

    return c;
  };
  const from = (table: string) => {
    if (table === 'whiteboards') {
      return chain({
        data: { is_archived: archived, created_by: boardCreator },
        error: null,
      });
    }

    const rows = chain({ data: [], error: null });

    rows.maybeSingle = () => Promise.resolve({ data: existing, error: null });

    return rows;
  };
  const wikiPermissions = {
    isCreatorOrAdmin: jest.fn(() => Promise.resolve(false)),
  };
  const permissions = {
    hasSpacePermission: jest.fn(() => Promise.resolve(canView)),
  };
  const service = new WikiCommentsService(
    { getClient: () => ({ from }) } as never,
    {
      getPageById: () => Promise.resolve(page),
      notifyMentionedUsers: jest.fn(),
    } as never,
    wikiPermissions as never,
    undefined,
    permissions as never,
  );

  return { service, inserted, deleted, permissions };
}

const pin = (over: Record<string, unknown> = {}) => ({
  type: 'canvas',
  threadId: THREAD,
  x: 10,
  y: -20,
  ...over,
});

describe('WikiCommentsService — whiteboard comments', () => {
  it('stores a validated pin on a board', async () => {
    const { service, inserted } = build();

    await service.createComment(
      PAGE,
      SPACE,
      {
        content: 'Hi',
        anchor: pin({ elementId: 'el_1', dx: 4, dy: 5, extra: 'dropped' }),
      },
      USER,
    );

    expect(inserted[0]['anchor']).toEqual({
      type: 'canvas',
      threadId: THREAD,
      x: 10,
      y: -20,
      elementId: 'el_1',
      dx: 4,
      dy: 5,
    });
    expect(inserted[0]['anchor_status']).toBe('active');
  });

  it.each([
    ['a non-finite coordinate', pin({ x: Number.NaN })],
    ['a huge coordinate', pin({ y: 1e12 })],
    ['a missing coordinate', pin({ x: undefined })],
    ['a bad thread id', pin({ threadId: 'nope' })],
    ['an unsafe element id', pin({ elementId: '<script>', dx: 0, dy: 0 })],
    ['an element without its offset', pin({ elementId: 'el_1' })],
  ])('rejects %s', async (_label, anchor) => {
    const { service } = build();

    await expect(
      service.createComment(PAGE, SPACE, { content: 'x', anchor }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a text anchor on a board', async () => {
    const { service } = build();

    await expect(
      service.createComment(
        PAGE,
        SPACE,
        {
          content: 'x',
          anchor: { type: 'text-range', threadId: THREAD, quotedText: 'q' },
        },
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("lets the board's creator delete someone else's comment, nobody else", async () => {
    const other = { created_by: 'someone-else' };
    const creator = build({ boardCreator: USER, existing: other });

    await creator.service.deleteComment(PAGE, 'c1', SPACE, USER);
    expect(creator.deleted).toHaveLength(1);

    const stranger = build({ boardCreator: 'user-creator', existing: other });

    await expect(
      stranger.service.deleteComment(PAGE, 'c1', SPACE, USER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(stranger.deleted).toHaveLength(0);
  });

  it('rejects a pin on a normal page', async () => {
    const { service } = build({ page: { id: PAGE, organization_id: 'o' } });

    await expect(
      service.createComment(PAGE, SPACE, { content: 'x', anchor: pin() }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('needs the Whiteboards view right to read or write board comments', async () => {
    const { service, permissions } = build({ canView: false });

    await expect(
      service.getThreaded(PAGE, SPACE, {}, USER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.createComment(PAGE, SPACE, { content: 'x' }, USER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(permissions.hasSpacePermission).toHaveBeenCalledWith(
      USER,
      'org-1',
      SPACE,
      'view_whiteboards',
    );
  });

  it('blocks writes on an archived board but still reads', async () => {
    const { service } = build({ archived: true });

    await expect(
      service.createComment(PAGE, SPACE, { content: 'x' }, USER),
    ).rejects.toThrow('archived whiteboard');
    await expect(service.getThreaded(PAGE, SPACE, {}, USER)).resolves.toEqual(
      [],
    );
  });

  it('leaves normal pages alone', async () => {
    const { service, permissions } = build({
      page: { id: PAGE, organization_id: 'o' },
    });

    await service.createComment(PAGE, SPACE, { content: 'x' }, USER);
    expect(permissions.hasSpacePermission).not.toHaveBeenCalled();
  });

  it('never orphans pins when the document anchors are synced', async () => {
    const updates: unknown[] = [];
    const rows = [
      {
        id: 'c1',
        anchor: { type: 'canvas', threadId: THREAD },
        anchor_status: 'active',
      },
    ];
    const c: Record<string, unknown> = {};

    for (const m of ['select', 'eq', 'is', 'not', 'in']) c[m] = () => c;
    c.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve);
    c.update = (v: unknown) => (updates.push(v), c);
    const service = new WikiCommentsService(
      { getClient: () => ({ from: () => c }) } as never,
      {} as never,
      {} as never,
    );

    await service.syncAnchors(PAGE, []);
    expect(updates).toEqual([]);
  });
});
