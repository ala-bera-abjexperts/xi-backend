import {
  BLOG_ROOT_POSITION,
  blogContainerIds,
  blogPostPosition,
  buildBlogContainerPages,
} from './page-containers.util';
import type { NormalizedPage } from '../../model/normalized';

const post = (createdAt?: string): NormalizedPage => ({
  contentKind: 'blogpost',
  sourceId: createdAt ?? 'undated',
  title: 'post',
  parentSourceId: null,
  ancestors: [],
  version: 1,
  bodyFormat: 'storage',
  createdAt,
});

describe('blogContainerIds', () => {
  it('buckets by UTC, not the server time zone', () => {
    expect(blogContainerIds('AS', '2025-12-31T23:30:00-05:00')).toEqual({
      root: 'blog:AS:root',
      year: 'blog:AS:2026',
      month: 'blog:AS:2026-01',
    });
  });

  it('files an undated or unparseable post directly under the root', () => {
    expect(blogContainerIds('AS')).toEqual({ root: 'blog:AS:root' });
    expect(blogContainerIds('AS', 'not a date')).toEqual({
      root: 'blog:AS:root',
    });
  });
});

describe('buildBlogContainerPages', () => {
  it('builds each container once, parents first, newest-first positions', () => {
    const out = buildBlogContainerPages('AS', [
      post('2025-11-03T10:00:00Z'),
      post('2025-11-20T10:00:00Z'),
      post('2024-02-01T00:00:00Z'),
      post(),
    ]);

    expect(
      out.map((c) => [c.sourceId, c.title, c.parentSourceId, c.position]),
    ).toEqual([
      ['blog:AS:root', 'Blog', null, BLOG_ROOT_POSITION],
      ['blog:AS:2025', '2025', 'blog:AS:root', -2025],
      ['blog:AS:2025-11', 'November', 'blog:AS:2025', -11],
      ['blog:AS:2024', '2024', 'blog:AS:root', -2024],
      ['blog:AS:2024-02', 'February', 'blog:AS:2024', -2],
    ]);
    expect(out.every((c) => c.contentKind === 'folder')).toBe(true);
    expect(out[2].ancestors).toEqual(['blog:AS:root', 'blog:AS:2025']);
  });

  it('builds nothing when the batch has no posts', () => {
    expect(buildBlogContainerPages('AS', [])).toEqual([]);
  });
});

describe('blogPostPosition', () => {
  it('sorts a newer post before an older one', () => {
    expect(blogPostPosition('2025-11-20T10:00:00Z')!).toBeLessThan(
      blogPostPosition('2025-11-03T10:00:00Z')!,
    );
  });

  it('is minus the creation minute, clamped to int32, and absent when undated', () => {
    expect(blogPostPosition('1970-01-01T01:00:00Z')).toBe(-60);
    expect(blogPostPosition('+275760-09-13T00:00:00Z')).toBe(-2147483648);
    expect(blogPostPosition(undefined)).toBeUndefined();
    expect(blogPostPosition('garbage')).toBeUndefined();
  });
});
