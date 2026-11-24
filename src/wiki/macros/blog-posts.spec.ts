import {
  matchesBlogExpression,
  selectBlogPosts,
  validateBlogMetadata,
  cloneBlogMetadata,
} from './blog-posts';

describe('Blog Posts source behavior', () => {
  const posts = [
    {
      id: 'a',
      title: 'Recovery',
      created_at: '2026-09-07T10:00:00Z',
      updated_at: '2026-09-07T11:00:00Z',
      labels: ['review', 'approved'],
    },
    {
      id: 'b',
      title: 'Contacts',
      created_at: '2026-09-06T10:00:00Z',
      updated_at: '2026-09-07T12:00:00Z',
      labels: ['review'],
    },
  ];
  it('validates blog metadata without changing normal page metadata', () => {
    expect(() => validateBlogMetadata({ narrowWidth: true })).not.toThrow();
    expect(() =>
      validateBlogMetadata({ content_kind: 'blogpost' }),
    ).not.toThrow();
    for (const value of [
      { content_kind: 'other' },
      { blog_created_at: 'not a date' },
      { blog_author_name: {} },
    ])
      expect(() => validateBlogMetadata(value)).toThrow();
  });
  it('applies required, optional and excluded labels', () => {
    expect(
      matchesBlogExpression('+review,+approved', ['review', 'approved']),
    ).toBe(true);
    expect(
      matchesBlogExpression('review,-approved', ['review', 'approved']),
    ).toBe(false);
    expect(matchesBlogExpression('review records', ['records'])).toBe(true);
  });
  it('sorts before limiting and reverses title versus date appropriately', () => {
    expect(selectBlogPosts(posts, { sort: 'title', max: '1' })[0].id).toBe('b');
    expect(
      selectBlogPosts(posts, { sort: 'title', reverse: 'true' })[0].id,
    ).toBe('a');
    expect(selectBlogPosts(posts, {})[0].id).toBe('a');
    expect(selectBlogPosts(posts, { reverse: 'true' })[0].id).toBe('a');
    expect(selectBlogPosts(posts, { sort: 'modified' })[0].id).toBe('b');
  });
  it('matches imported usernames without treating the migration operator as the author', () => {
    const imported = [
      {
        ...posts[0],
        created_by: 'operator',
        metadata: {
          blog_author_source_id: 'source-key',
          blog_author_username: 'service.owner',
        },
      },
    ];
    expect(selectBlogPosts(imported, { author: 'service.owner' })).toHaveLength(
      1,
    );
    expect(selectBlogPosts(imported, { author: 'operator' })).toHaveLength(0);
  });
  it('keeps source modification order and removes imported identity from copies', () => {
    const metadata = {
      content_kind: 'blogpost',
      blog_created_at: '2020-01-01T00:00:00Z',
      blog_modified_at: '2020-01-02T00:00:00Z',
      blog_author_source_id: 'source',
      narrowWidth: true,
    };
    expect(
      selectBlogPosts([{ ...posts[1], metadata }, posts[0]], {
        sort: 'modified',
      })[0].id,
    ).toBe('a');
    expect(cloneBlogMetadata(metadata)).toEqual({
      content_kind: 'blogpost',
      narrowWidth: true,
    });
    expect(metadata.blog_author_source_id).toBe('source');
  });
  it('filters time and rejects malformed options', () => {
    expect(
      selectBlogPosts(
        posts,
        { time: '12h' },
        Date.parse('2026-09-07T12:00:00Z'),
      ),
    ).toHaveLength(1);
    for (const params of [
      { max: '0' },
      { time: 'yesterday' },
      { sort: 'garbage' },
      { max: '1x' },
    ])
      expect(() => selectBlogPosts(posts, params)).toThrow();
  });
});

it('orders timestamps by instant rather than timezone text', () => {
  const posts = [
    {
      id: 'later',
      title: 'Later',
      labels: [],
      created_at: '2026-09-07T10:00:00Z',
    },
    {
      id: 'earlier',
      title: 'Earlier',
      labels: [],
      created_at: '2026-09-07T12:00:00+05:30',
    },
  ];
  expect(selectBlogPosts(posts, {}).map((post) => post.id)).toEqual([
    'later',
    'earlier',
  ]);
});

it('copies absent metadata and preserves unrelated blog display settings', () => {
  expect(cloneBlogMetadata(null)).toEqual({});
  expect(
    cloneBlogMetadata({ blog_layout: 'compact', blog_author_name: 'Source' }),
  ).toEqual({ blog_layout: 'compact' });
});
