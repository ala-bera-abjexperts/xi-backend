// wiki.service pulls in jsdom through the sanitizer; stub it (identity), as wiki-user-display.spec.ts does.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { WikiCommentsService } from './wiki-comments.service';

/** Read receipts: a thread's root is marked read per user, and threads come back with the caller's read_at. */
const SPACE = '22222222-2222-4222-8222-222222222222';
const PAGE = '11111111-1111-4111-8111-111111111111';
const ROOT = '33333333-3333-4333-8333-333333333333';
const USER = 'user-1';

function build({
  comment = { parent_id: null } as Record<string, unknown> | null,
  rows = [] as Record<string, unknown>[],
  reads = [] as Record<string, unknown>[],
  canView = true,
} = {}) {
  const upserts: { row: unknown; opts: unknown }[] = [];
  const live = { broadcast: jest.fn(() => Promise.resolve()) };
  const readFilters: [string, unknown][] = [];

  const chain = (
    result: unknown,
    log?: [string, unknown][],
  ): Record<string, unknown> => {
    const c: Record<string, unknown> = {};

    for (const m of ['select', 'order', 'is', 'not']) c[m] = () => c;
    c.eq = (col: string, v: unknown) => (log?.push([col, v]), c);
    c.in = (col: string, v: unknown) => (log?.push([col, v]), c);
    c.maybeSingle = () => Promise.resolve({ data: comment, error: null });
    c.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(result).then(resolve);
    c.upsert = (row: unknown, opts: unknown) => {
      upserts.push({ row, opts });

      return Promise.resolve({ error: null });
    };

    return c;
  };

  const from = (table: string) =>
    table === 'wiki_page_comment_reads'
      ? chain({ data: reads, error: null }, readFilters)
      : chain({ data: rows, error: null });

  const service = new WikiCommentsService(
    { getClient: () => ({ from }) } as never,
    {
      getPageById: () =>
        Promise.resolve({
          id: PAGE,
          organization_id: 'org-1',
          whiteboard_id: 'board-1',
        }),
    } as never,
    {} as never,
    undefined,
    { hasSpacePermission: () => Promise.resolve(canView) } as never,
    live as never,
  );

  return { service, upserts, readFilters, live };
}

describe('WikiCommentsService — read receipts', () => {
  it("upserts the caller's receipt on a root comment", async () => {
    const { service, upserts } = build();

    const res = await service.setReadState(PAGE, ROOT, SPACE, USER, false);

    expect(upserts).toHaveLength(1);
    expect(upserts[0].row).toEqual({
      comment_id: ROOT,
      user_id: USER,
      marked_unread: false,
      read_at: res.read_at,
    });
    expect(upserts[0].opts).toEqual({ onConflict: 'comment_id,user_id' });
  });

  it('rejects replies and unknown comments', async () => {
    await expect(
      build({ comment: { parent_id: ROOT } }).service.setReadState(
        PAGE,
        'reply',
        SPACE,
        USER,
        false,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      build({ comment: null }).service.setReadState(
        PAGE,
        ROOT,
        SPACE,
        USER,
        false,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('needs the Whiteboards view right on a board', async () => {
    const { service, upserts } = build({ canView: false });

    await expect(
      service.setReadState(PAGE, ROOT, SPACE, USER, false),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(upserts).toHaveLength(0);
  });

  it("returns each thread with the caller's read_at only", async () => {
    const { service, readFilters } = build({
      rows: [
        { id: ROOT, parent_id: null, resolved_at: null, anchor: null },
        { id: 'r1', parent_id: ROOT, resolved_at: null, anchor: null },
        { id: 'other', parent_id: null, resolved_at: null, anchor: null },
      ],
      reads: [
        {
          comment_id: ROOT,
          read_at: '2026-10-07T10:00:00Z',
          marked_unread: true,
        },
      ],
    });

    const threads = (await service.getThreaded(PAGE, SPACE, {}, USER)) as {
      id: string;
      read_at: string | null;
      marked_unread: boolean;
      replies: unknown[];
    }[];

    expect(threads.map((t) => [t.id, t.read_at, t.marked_unread])).toEqual([
      [ROOT, '2026-10-07T10:00:00Z', true],
      ['other', null, false],
    ]);
    expect(threads[0].replies).toHaveLength(1);
    expect(readFilters).toEqual([
      ['user_id', USER],
      ['comment_id', [ROOT, 'other']],
    ]);
  });

  it('marks unread for the caller only, keeping read_at, and pings the board', async () => {
    const { service, upserts, live } = build();

    expect(await service.setReadState(PAGE, ROOT, SPACE, USER, true)).toEqual({
      read_at: null,
      marked_unread: true,
    });
    expect(upserts[0].row).toEqual({
      comment_id: ROOT,
      user_id: USER,
      marked_unread: true,
    });
    expect(live.broadcast).toHaveBeenCalledWith('board-1', 'comments_changed');
  });

  it('marks every root on the page read in one upsert', async () => {
    const { service, upserts } = build({
      rows: [{ id: ROOT }, { id: 'other' }],
    });

    const res = await service.markAllRead(PAGE, SPACE, USER);

    expect(res.count).toBe(2);
    expect(upserts[0].row).toEqual([
      {
        comment_id: ROOT,
        user_id: USER,
        read_at: res.read_at,
        marked_unread: false,
      },
      {
        comment_id: 'other',
        user_id: USER,
        read_at: res.read_at,
        marked_unread: false,
      },
    ]);
  });
});
