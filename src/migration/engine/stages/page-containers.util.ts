/**
 * @fileoverview Synthesized wiki containers for the Confluence `pages` stage.
 *
 * Confluence has structure that is not a page: Cloud v2 folders, and blog posts, which live beside
 * the page tree rather than in it. Both become `contentKind: 'folder'` items that the stage creates
 * as empty `metadata.is_folder` wiki pages. A folder keeps its real Confluence id as `sourceId`
 * (content ids are global, so it cannot collide with a page). Blog containers have no source id at
 * all, so they get deterministic `blog:<spaceKey>:…` ids — the same post always files under the
 * same container, across batches and re-runs.
 * @module src/migration/engine/stages/page-containers.util
 * @author Prince Jadiya
 */

import type { NormalizedPage } from '../../model/normalized';

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** The Blog root sorts after every real page (v2 positions are int32, so this is past them). */
export const BLOG_ROOT_POSITION = 2147483000;

/** UTC year/month of an ISO instant, or null when it is missing or unparseable. */
function utcYearMonth(
  iso: string | null | undefined,
): { year: number; month: number } | null {
  const ms = iso ? Date.parse(iso) : NaN;

  if (!Number.isFinite(ms)) return null;

  const at = new Date(ms);

  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1 };
}

/**
 * Container ids a blog post files under. UTC, so the month never depends on the server's zone. An
 * undated post has no year/month and goes directly under the root.
 */
export function blogContainerIds(
  spaceKey: string,
  createdAtIso?: string | null,
): { root: string; year?: string; month?: string } {
  const root = `blog:${spaceKey}:root`;
  const ym = utcYearMonth(createdAtIso);

  if (!ym) return { root };

  const year = String(ym.year);

  return {
    root,
    year: `blog:${spaceKey}:${year}`,
    month: `blog:${spaceKey}:${year}-${String(ym.month).padStart(2, '0')}`,
  };
}

/**
 * The Blog → year → month containers `posts` need, each parent before its children. Newest first:
 * a year sorts at `-YYYY`, a month at `-MM`.
 */
export function buildBlogContainerPages(
  spaceKey: string,
  posts: NormalizedPage[],
): NormalizedPage[] {
  if (posts.length === 0) return [];

  const containers = new Map<string, NormalizedPage>();
  const add = (
    sourceId: string,
    title: string,
    ancestors: string[],
    position: number,
  ) => {
    if (containers.has(sourceId)) return;

    containers.set(sourceId, {
      contentKind: 'folder',
      sourceId,
      title,
      parentSourceId: ancestors.at(-1) ?? null,
      ancestors,
      position,
      version: 1,
      bodyFormat: 'storage',
    });
  };
  const { root } = blogContainerIds(spaceKey);

  add(root, 'Blog', [], BLOG_ROOT_POSITION);

  for (const post of posts) {
    const ym = utcYearMonth(post.createdAt);
    const ids = blogContainerIds(spaceKey, post.createdAt);

    if (!ym || !ids.year || !ids.month) continue;

    add(ids.year, String(ym.year), [root], -ym.year);
    add(
      ids.month,
      new Date(Date.UTC(2000, ym.month - 1, 1)).toLocaleString('en-US', {
        month: 'long',
        timeZone: 'UTC',
      }),
      [root, ids.year],
      -ym.month,
    );
  }

  return [...containers.values()];
}

/** A blog post's sibling order inside its month: minus its creation minute, so newest sorts first. */
export function blogPostPosition(
  createdAtIso?: string | null,
): number | undefined {
  const ms = createdAtIso ? Date.parse(createdAtIso) : NaN;

  if (!Number.isFinite(ms)) return undefined;

  return Math.min(INT32_MAX, Math.max(INT32_MIN, -Math.floor(ms / 60000)));
}
