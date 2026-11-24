import { BadRequestException } from '@nestjs/common';

export function matchesBlogExpression(
  expression: string,
  values: string[],
): boolean {
  const terms = expression.split(/[,\s]+/).filter(Boolean);
  const required = terms
    .filter((t) => t.startsWith('+'))
    .map((t) => t.slice(1));
  const excluded = terms
    .filter((t) => t.startsWith('-'))
    .map((t) => t.slice(1));
  const optional = terms.filter((t) => !/^[+-]/.test(t));
  return (
    required.every((t) => values.includes(t)) &&
    !excluded.some((t) => values.includes(t)) &&
    (required.length > 0 ||
      optional.length === 0 ||
      optional.some((t) => values.includes(t)))
  );
}

export interface BlogPost {
  id: string;
  title: string;
  created_at?: string;
  updated_at?: string;
  labels: string[];
  author?: string;
  created_by?: string;
  metadata?: Record<string, unknown>;
}

export function selectBlogPosts<T extends BlogPost>(
  posts: T[],
  params: Record<string, string>,
  now = Date.now(),
): T[] {
  const max = Number(params.max || 100);
  if (!Number.isInteger(max) || max < 1 || max > 1000)
    throw new BadRequestException(
      'Maximum blog posts must be between 1 and 1000',
    );
  if (params.sort && !['title', 'creation', 'modified'].includes(params.sort))
    throw new BadRequestException('Invalid blog sort');
  if (
    params.content &&
    !['titles', 'excerpts', 'entire'].includes(params.content)
  )
    throw new BadRequestException('Invalid blog content view');
  if (params.reverse && !['true', 'false'].includes(params.reverse))
    throw new BadRequestException('Invalid reverse sort');
  let since = -Infinity;
  if (params.time) {
    const match = /^(\d+)([mhdw])$/.exec(params.time);
    if (!match)
      throw new BadRequestException(
        'Use a time frame such as 30m, 12h, 7d or 4w',
      );
    since =
      now -
      Number(match[1]) *
        ({ m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]] ??
          0);
  }
  const created = (post: T) =>
    String(post.metadata?.blog_created_at || post.created_at || '');
  const modified = (post: T) =>
    String(post.metadata?.blog_modified_at || post.updated_at || created(post));
  const authors = (params.author || '').split(/[,\s]+/).filter(Boolean);
  return posts
    .filter(
      (post) =>
        (!params.time || Date.parse(created(post)) >= since) &&
        matchesBlogExpression(params.label || '', post.labels) &&
        (!authors.length ||
          authors.some((author) =>
            (post.metadata?.blog_author_source_id
              ? [
                  post.metadata.blog_author_source_id,
                  post.metadata.blog_author_username,
                ]
              : [post.created_by, post.author]
            ).includes(author),
          )),
    )
    .sort((a, b) => {
      const compared =
        params.sort === 'title'
          ? a.title.localeCompare(b.title)
          : params.sort === 'modified'
            ? (Date.parse(modified(b)) || 0) - (Date.parse(modified(a)) || 0)
            : (Date.parse(created(b)) || 0) - (Date.parse(created(a)) || 0);
      return (
        (compared || a.id.localeCompare(b.id)) *
        (params.sort && params.reverse === 'true' ? -1 : 1)
      );
    })
    .slice(0, max);
}

export function validateBlogMetadata(
  metadata: Record<string, unknown> | undefined,
): void {
  if (!metadata) return;
  if (
    metadata.content_kind !== undefined &&
    !['page', 'blogpost'].includes(String(metadata.content_kind))
  )
    throw new BadRequestException('Content kind must be page or blogpost');
  for (const key of ['blog_created_at', 'blog_modified_at']) {
    if (
      metadata[key] !== undefined &&
      (typeof metadata[key] !== 'string' ||
        !/^\d{4}-\d\d-\d\dT/.test(metadata[key] as string) ||
        !Number.isFinite(Date.parse(metadata[key] as string)))
    )
      throw new BadRequestException('Invalid blog date');
  }
  for (const key of [
    'blog_author_name',
    'blog_author_source_id',
    'blog_author_username',
  ]) {
    if (
      metadata[key] !== undefined &&
      (typeof metadata[key] !== 'string' || metadata[key].length > 200)
    )
      throw new BadRequestException(`Invalid ${key}`);
  }
}

/** A copy is a new publication, not the imported author's original post. */
export function cloneBlogMetadata(
  metadata: Record<string, unknown> | null = {},
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      ([key]) =>
        ![
          'blog_created_at',
          'blog_modified_at',
          'blog_author_source_id',
          'blog_author_name',
          'blog_author_username',
        ].includes(key),
    ),
  );
}
