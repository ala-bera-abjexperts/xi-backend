/**
 * @fileoverview Source-agnostic Confluence page. Maps (CF-A) to a `wiki_pages` row via
 * `WikiService.createPage`. `parentSourceId`/`ancestors` drive parent-before-child ordering;
 * `body` is fetched lazily in the mapper (keeps the discovery/seed pass cheap).
 */

import type { RawBody } from './raw-body';

export interface NormalizedPage {
  /** `folder` = a structural container (Cloud folder, or a Blog/year/month node) with no body. */
  contentKind?: 'page' | 'blogpost' | 'folder';
  /** Sibling order: v2 `position` or v1 `extensions.position` (int32 only; absent = alphabetical). */
  position?: number;
  /** v2 only — what `parentSourceId` points at. A `folder` parent must be seeded by the stage. */
  parentType?: 'page' | 'folder';
  authorName?: string;
  authorUsername?: string;
  /** Stable Confluence page id (string) — crosswalk source_id + natural_key. */
  sourceId: string;
  /** → wiki_pages.title (localized display name preserved). */
  title: string;
  /** ancestors[last] — null for the homepage / top-level pages (→ wiki root). */
  parentSourceId: string | null;
  /** Root→parent chain of page ids (drives depth + top-down ordering). */
  ancestors: string[];
  version: number;
  /** Which body format `getPageBody` should request. Server = storage only. */
  bodyFormat: 'storage' | 'atlas_doc_format';
  /** Resolved via the user crosswalk (wiki_pages.created_by, best-effort). May be absent (anonymous). */
  authorSourceId?: string;
  /** Lazily fetched by the mapper; absent during the seed pass. */
  body?: RawBody;
  /** ISO-8601. */
  createdAt?: string;
  updatedAt?: string;
}
