// wiki.service transitively imports sanitize-rich-text, which pulls in jsdom (ESM) that ts-jest
// cannot transform. Stub the sanitizer (identity), matching wiki-page-source-updated-at.spec.ts.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import { WikiCommentsService } from './wiki-comments.service';
import { WikiService } from './wiki.service';
import { withFullName } from './wiki-user.util';

/**
 * The wiki right rail rendered every comment author and the page creator/updater
 * as an email with no avatar: `users` has no `full_name`, the joins selected no
 * `avatar_url`, and the page detail never returned the users at all. It also
 * showed "Version 1" for every page because `wiki_pages` has no version column.
 */
const SPACE_ID = '22222222-2222-4222-8222-222222222222';
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const ADA = {
  id: 'u-ada',
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'ada@example.com',
  avatar_url: 'https://cdn/ada.png',
};
const JORG = {
  id: 'u-jorg',
  first_name: 'Jörg',
  last_name: null,
  email: 'jorg@example.com',
  avatar_url: null,
};

type Person = { full_name: string | null; [key: string]: unknown } | null;
interface Shown {
  created_by_user: Person;
  updated_by_user: Person;
  replies: Shown[];
  version?: number;
}

interface Call {
  table: string;
  select?: string;
  filters: [string, string, unknown][];
}

/** Chainable PostgREST stand-in: every builder method records itself; awaiting resolves per table. */
function fakeClient(results: Record<string, unknown>, calls: Call[]) {
  return {
    from(table: string) {
      const call: Call = { table, filters: [] };
      calls.push(call);
      const result = { data: results[table] ?? null, error: null, count: 0 };
      const builder: Record<string, unknown> = {
        select: (cols: string) => ((call.select = cols), builder),
        eq: (col: string, v: unknown) => (
          call.filters.push(['eq', col, v]),
          builder
        ),
        in: (col: string, v: unknown) => (
          call.filters.push(['in', col, v]),
          builder
        ),
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve(result),
        then: (resolve: (r: unknown) => unknown) => resolve(result),
      };

      return builder;
    },
  };
}

describe('withFullName', () => {
  it('joins first and last name, trimming blanks', () => {
    expect(withFullName(ADA)?.full_name).toBe('Ada Lovelace');
    expect(withFullName(JORG)?.full_name).toBe('Jörg');
    expect(
      withFullName({ first_name: '  ', last_name: null })?.full_name,
    ).toBeNull();
  });

  it('passes null through and keeps the other fields', () => {
    expect(withFullName(null)).toBeNull();
    expect(withFullName(undefined)).toBeNull();
    expect(withFullName(ADA)).toMatchObject({
      email: ADA.email,
      avatar_url: ADA.avatar_url,
    });
  });
});

describe('WikiCommentsService — author display', () => {
  it('selects avatar_url and returns full_name on roots and replies', async () => {
    const calls: Call[] = [];
    const rows = [
      {
        id: 'c1',
        parent_id: null,
        resolved_at: null,
        anchor: null,
        created_by_user: ADA,
        updated_by_user: ADA,
      },
      {
        id: 'c2',
        parent_id: 'c1',
        resolved_at: null,
        anchor: null,
        created_by_user: JORG,
        updated_by_user: null,
      },
    ];
    const client = fakeClient({ wiki_page_comments: rows }, calls);
    const service = new WikiCommentsService(
      { getClient: () => client } as never,
      { getPageById: () => Promise.resolve({ id: PAGE_ID }) } as never,
      {} as never,
    );

    const [root] = (await service.getThreaded(
      PAGE_ID,
      SPACE_ID,
      {},
      'u-ada',
    )) as Shown[];

    expect(calls[0].select).toContain(
      'created_by_user:users!created_by(id,first_name,last_name,email,avatar_url)',
    );
    expect(root.created_by_user).toMatchObject({
      full_name: 'Ada Lovelace',
      avatar_url: ADA.avatar_url,
    });
    expect(root.replies[0].created_by_user?.full_name).toBe('Jörg');
    expect(root.replies[0].updated_by_user).toBeNull();
  });

  it('maps the flat list too', async () => {
    const client = fakeClient(
      {
        wiki_page_comments: [
          { id: 'c1', created_by_user: ADA, updated_by_user: null },
        ],
      },
      [],
    );
    const service = new WikiCommentsService(
      { getClient: () => client } as never,
      { getPageById: () => Promise.resolve({ id: PAGE_ID }) } as never,
      {} as never,
    );

    const [row] = (await service.getComments(
      PAGE_ID,
      SPACE_ID,
      'u-ada',
    )) as Shown[];

    expect(row.created_by_user?.full_name).toBe('Ada Lovelace');
  });
});

describe('WikiService.getPageWithRelations — people and version', () => {
  function build(
    page: Record<string, unknown>,
    extra: Record<string, unknown>,
    calls: Call[],
  ) {
    const client = fakeClient({ wiki_pages: page, ...extra }, calls);

    return new WikiService(
      { getClient: () => client } as never,
      {} as never,
      {} as never,
    );
  }

  it('returns creator/updater with full_name and the latest version', async () => {
    const calls: Call[] = [];
    const service = build(
      {
        id: PAGE_ID,
        space_id: SPACE_ID,
        created_by: ADA.id,
        updated_by: JORG.id,
      },
      { users: [ADA, JORG], wiki_page_versions: { version: 7 } },
      calls,
    );

    const page = (await service.getPageWithRelations(
      PAGE_ID,
      SPACE_ID,
    )) as Shown;

    expect(page.created_by_user).toMatchObject({
      id: ADA.id,
      full_name: 'Ada Lovelace',
      avatar_url: ADA.avatar_url,
    });
    expect(page.updated_by_user).toMatchObject({
      id: JORG.id,
      full_name: 'Jörg',
    });
    expect(page.version).toBe(7);

    // Page lookup stays tenant-scoped; users are fetched once for both ids.
    const pageCall = calls.find((c) => c.table === 'wiki_pages')!;
    expect(pageCall.filters).toContainEqual(['eq', 'space_id', SPACE_ID]);
    const userCall = calls.find((c) => c.table === 'users')!;
    expect(userCall.filters).toEqual([['in', 'id', [ADA.id, JORG.id]]]);
    const versionCall = calls.find((c) => c.table === 'wiki_page_versions')!;
    expect(versionCall.filters).toContainEqual(['eq', 'wiki_page_id', PAGE_ID]);
  });

  it('falls back to version 1 and null users, without querying users', async () => {
    const calls: Call[] = [];
    const service = build(
      { id: PAGE_ID, space_id: SPACE_ID, created_by: null, updated_by: null },
      {},
      calls,
    );

    const page = (await service.getPageWithRelations(
      PAGE_ID,
      SPACE_ID,
    )) as Shown;

    expect(page.version).toBe(1);
    expect(page.created_by_user).toBeNull();
    expect(page.updated_by_user).toBeNull();
    expect(calls.some((c) => c.table === 'users')).toBe(false);
  });

  it('dedupes the user lookup when creator and updater are the same person', async () => {
    const calls: Call[] = [];
    const service = build(
      {
        id: PAGE_ID,
        space_id: SPACE_ID,
        created_by: ADA.id,
        updated_by: ADA.id,
      },
      { users: [ADA] },
      calls,
    );

    const page = (await service.getPageWithRelations(
      PAGE_ID,
      SPACE_ID,
    )) as Shown;

    expect(calls.find((c) => c.table === 'users')!.filters).toEqual([
      ['in', 'id', [ADA.id]],
    ]);
    expect(page.updated_by_user?.full_name).toBe('Ada Lovelace');
  });
});
