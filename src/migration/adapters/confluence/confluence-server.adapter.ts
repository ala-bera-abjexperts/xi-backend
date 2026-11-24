/**
 * @fileoverview Confluence Server/DC adapter (REST v1, `/rest/api`) — Phase 9 read surface.
 *
 * Storage-format XHTML bodies; `username`/`userKey` users. Pages are streamed by paging the
 * `/content?spaceKey=` LIST endpoint in batches, following the envelope's own `_links.next` as
 * the cursor; `expand=ancestors,version` carries the whole tree, so no per-page or per-child
 * request is made. (This replaced a per-page pre-order DFS that could not finish a real space —
 * see `iteratePages` for the measurements.) Parent-before-child is the WORKER's invariant, not
 * this adapter's: it gates each item on `parent_source_ref`. Read-only: zero Supabase calls,
 * zero writes to the source. `getSpacePermissions` is omitted — Server has no REST surface.
 */

import type {
  NormalizedAttachment,
  NormalizedAttachmentVersion,
  NormalizedPage,
  NormalizedPageVersion,
  NormalizedSpace,
  NormalizedUser,
  NormalizedWatcher,
  RawBody,
} from '../../model/normalized';
import { collectStorageUserRefs } from '../../transformers/storage-format-to-html';
import type {
  IConfluenceSourceAdapter,
  Page,
} from '../source-adapter.interface';
import {
  AtlassianRequestError,
  type AtlassianHttpClient,
} from '../http/atlassian-http-client';
import type {
  ConfluenceListEnvelope,
  ConfluenceRawAttachment,
  ConfluenceRawPage,
  ConfluenceRawSpace,
  ConfluenceRawVersion,
} from './confluence-adapter.base';
import { ConfluenceAdapterBase } from './confluence-adapter.base';

export { collectStorageUserRefs } from '../../transformers/storage-format-to-html';

const USER_SCAN_PAGE_CAP = 2000;
const USER_LOOKUP_CAP = 500;

interface ConfluenceServerUser {
  username?: string;
  userKey?: string;
  displayName?: string;
  email?: string;
  emailAddress?: string;
  active?: boolean;
}

export class ConfluenceServerAdapter
  extends ConfluenceAdapterBase
  implements IConfluenceSourceAdapter
{
  constructor(http: AtlassianHttpClient) {
    super(http, '/rest/api', 'server');
  }

  async getPageWatchers(
    pageSourceId: string,
    opts?: { cursor?: string | null; pageSize?: number },
  ): Promise<Page<NormalizedWatcher>> {
    const limit = Math.min(Math.max(opts?.pageSize ?? 100, 1), 200);
    const path =
      opts?.cursor ??
      `${this.restPrefix}/content/${encodeURIComponent(pageSourceId)}/watchers?limit=${limit}`;

    return this.getWatcherPage(path, 'server');
  }

  async getSpaceWatchers(
    spaceKey: string,
    opts?: { cursor?: string | null; pageSize?: number },
  ): Promise<Page<NormalizedWatcher>> {
    const limit = Math.min(Math.max(opts?.pageSize ?? 100, 1), 200);
    const path =
      opts?.cursor ??
      `${this.restPrefix}/space/${encodeURIComponent(spaceKey)}/watchers?limit=${limit}`;

    return this.getWatcherPage(path, 'server');
  }

  async listSpaces(cursor?: string | null): Promise<Page<NormalizedSpace>> {
    const path =
      cursor ??
      `${this.restPrefix}/space?limit=50&expand=description.plain,homepage`;
    const { items, nextPath } =
      await this.getCursorPage<ConfluenceRawSpace>(path);

    return {
      // Server reports only per-page `size`, never a grand total — keep total null.
      items: items.map((s) => this.normalizeSpace(s)),
      nextCursor: nextPath,
      total: null,
    };
  }

  async getSpaceDetails(spaceKey: string): Promise<NormalizedSpace> {
    const raw = await this.http.getJson<ConfluenceRawSpace>(
      `${this.restPrefix}/space/${encodeURIComponent(spaceKey)}?expand=homepage,description.plain`,
    );

    return this.normalizeSpace(raw);
  }

  /**
   * Stream the space's pages by paging the LIST endpoint, one batch per yield.
   *
   * Replaces a per-page DFS (`/content/{id}` + `/content/{id}/child/page` for every page, one page
   * per yield). That walk could not finish a real space — measured against M0 (10,383 pages):
   *   - `/content/{id}?expand=ancestors,version` costs ~1374ms/page → 4.4 HOURS of HTTP;
   *     the list endpoint returns the SAME fields at ~7ms/page (200 per request) — 207x cheaper.
   *   - a second request per page for children (~167ms) → ~29 min, for a tree the `ancestors`
   *     chain already describes.
   *   - yielding ONE page per tick meant one `produce()` call (~2s) per page → ~5.8 HOURS to seed.
   *   - the cursor carried the whole `visited` set, JSON-serialised into the checkpoint on EVERY
   *     tick: ~80KB re-written 10,383 times, i.e. O(n²) writes.
   * A batch per yield turns seeding into ~52 calls, and the cursor into one short URL.
   *
   * ORDER: this emits the source's list order, NOT pre-order — a child may be seeded before its
   * parent. That is safe and deliberate: the worker gates every item on `parent_source_ref` via
   * `isGateOpen` and blocks it until the parent is mapped, so ordering is the ENGINE's invariant,
   * not the adapter's. `normalizePage` derives `parentSourceId` from the last ancestor, so the
   * whole tree comes from `expand=ancestors` with no child requests at all.
   *
   * The cursor is the envelope's own `_links.next` (a relative path). `total` stays null: this
   * endpoint reports only a per-batch `size`; the grand total belongs to `countPages`.
   */
  async *iteratePages(
    spaceKey: string,
    opts?: { cursor?: string | null; pageSize?: number },
  ): AsyncGenerator<Page<NormalizedPage>> {
    const pageSize = opts?.pageSize ?? 200;
    // A cursor from a previous (DFS) build is a JSON blob, not a path — restart rather than issue a
    // nonsense request. Any in-flight run at deploy time re-seeds; already-mapped pages skip.
    const resume =
      opts?.cursor && opts.cursor.startsWith('/') ? opts.cursor : null;
    let next: string | null =
      resume ??
      `${this.restPrefix}/content?spaceKey=${encodeURIComponent(spaceKey)}` +
        `&type=page&limit=${pageSize}&expand=ancestors,version,history.createdBy,extensions.position`;

    while (next) {
      const env: ConfluenceListEnvelope<ConfluenceRawPage> =
        await this.http.getJson<ConfluenceListEnvelope<ConfluenceRawPage>>(
          next,
        );
      const items = (env.results ?? []).map((raw) => this.normalizePage(raw));
      const isBlog = new URL(next, 'https://source.invalid').searchParams.get('type') === 'blogpost';
      const nextCursor = (items.length ? env._links?.next : null) ?? (isBlog ? null :
        `${this.restPrefix}/content?spaceKey=${encodeURIComponent(spaceKey)}&type=blogpost&limit=${pageSize}&expand=version,history.createdBy,extensions.position`);

      yield { items, nextCursor, total: null };

      // An empty batch must terminate even if the server keeps offering a `next` link.
      if (!nextCursor) return;

      next = nextCursor;
    }
  }

  /**
   * CHEAP, APPROXIMATE page count for the wizard preview — one request, and deliberately so:
   * `MigrationDiscoveryService.previewSpace` awaits this inline, so the admin's "Preview & Save"
   * step blocks on it. Paging `/content?spaceKey=` would be exact but costs ~52 requests (1-4 min
   * measured on M0) and would hang the wizard.
   *
   * It is APPROXIMATE because CQL reads a Lucene index that does not match the content: on M0 it
   * reports 10382 against a true 10383, omitting `393219 "Migration 01"` — the space HOMEPAGE, a
   * live `status=current` page carrying 6 attachments. The same index reports 6 attachments where
   * there are 12, and a different set at that. Treat every CQL number here as a hint.
   *
   * Do NOT reconcile against this — `verify` counts via `iteratePages` instead, so its denominator
   * is exactly what the migration would enumerate.
   */
  async countPages(spaceKey: string): Promise<number | null> {
    // Plain `/content?spaceKey=` reports only per-page `size`; the CQL search endpoint is
    // the only Server surface that carries a grand total (`totalSize`) in one request.
    const cql = encodeURIComponent(
      `space="${spaceKey.replace(/"/g, '')}" and type in (page,blogpost)`,
    );

    try {
      const res = await this.http.getJson<ConfluenceListEnvelope<unknown>>(
        `${this.restPrefix}/content/search?cql=${cql}&limit=0`,
      );

      return typeof res.totalSize === 'number' ? res.totalSize : null;
    } catch (err) {
      this.logger.warn(
        `countPages("${spaceKey}") failed: ${(err as Error).message}`,
      );

      return null;
    }
  }

  async getPageBody(
    pageSourceId: string,
    format: 'storage' | 'atlas_doc_format',
  ): Promise<RawBody> {
    // Confluence Server has no ADF surface — storage-format XHTML is always returned.
    if (format !== 'storage') {
      this.logger.debug(
        `Server getPageBody ignoring requested format "${format}"; returning storage`,
      );
    }

    const raw = await this.http.getJson<ConfluenceRawPage>(
      `${this.restPrefix}/content/${encodeURIComponent(pageSourceId)}?expand=body.storage`,
    );

    return { format: 'storage', value: raw.body?.storage?.value ?? '' };
  }

  async getPageAttachments(
    pageSourceId: string,
  ): Promise<NormalizedAttachment[]> {
    // `origin` (from the envelope's `_links.base`) prefixes the pre-encoded relative downloads.
    const { items, origin } = await this.collectList<ConfluenceRawAttachment>(
      `${this.restPrefix}/content/${encodeURIComponent(pageSourceId)}/child/attachment?expand=metadata,version&limit=50`,
    );

    return items.map((raw) =>
      this.normalizeAttachment(raw, pageSourceId, origin),
    );
  }

  // ==========================================================================
  // Revision history (Server / Data Center)
  // ==========================================================================

  /** The readable-content probe does not imply every page's history is accessible. */
  async supportsHistory(): Promise<boolean> {
    return this.probeHistoryOnce(
      `${this.restPrefix}/content?limit=1&expand=version`,
    );
  }

  async getPageVersions(
    pageSourceId: string,
  ): Promise<NormalizedPageVersion[]> {
    const { items } = await this.collectList<ConfluenceRawVersion>(
      `${this.restPrefix.replace(/\/api$/, '/experimental')}/content/${encodeURIComponent(pageSourceId)}/version?limit=50`,
    );

    // The listing does not flag which row is live, so the highest number is the current revision.
    const current = items.reduce(
      (max, raw) => Math.max(max, raw.number ?? 0),
      0,
    );

    return items
      .map((raw) =>
        this.normalizePageVersion(raw, pageSourceId, current || null),
      )
      .filter((v) => v.version > 0)
      .sort((a, b) => a.version - b.version);
  }

  async getPageBodyAtVersion(
    pageSourceId: string,
    version: number,
    format: 'storage' | 'atlas_doc_format',
  ): Promise<(RawBody & { title?: string }) | null> {
    if (format !== 'storage') {
      this.logger.debug(
        `Server getPageBodyAtVersion ignoring requested format "${format}"; returning storage`,
      );
    }

    // `status=historical` is required: without it Confluence ignores `version` and serves current.
    const raw = await this.http.getJson<ConfluenceRawPage>(
      `${this.restPrefix}/content/${encodeURIComponent(pageSourceId)}?status=historical&version=${version}&expand=body.storage`,
    );

    const value = raw.body?.storage?.value;

    // A listed revision whose body is withheld is a GAP, not a failure: returning null lets the
    // stage record the revision as unavailable instead of retrying a request that cannot succeed.
    if (typeof value !== 'string') return null;

    return {
      format: 'storage',
      value,
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    };
  }

  async getAttachmentVersions(
    attachmentSourceId: string,
  ): Promise<NormalizedAttachmentVersion[]> {
    // Server's version endpoint returns version metadata, not attachment content. Hydrate each
    // advertised revision to retain its own filename, MIME, size and versioned download URL.
    const { items, origin } = await this.collectList<ConfluenceRawVersion>(
      `${this.restPrefix.replace(/\/api$/, '/experimental')}/content/${encodeURIComponent(attachmentSourceId)}/version?limit=50`,
    );
    const numbers = [
      ...new Set(
        items
          .map((v) => v.number)
          .filter(
            (n): n is number =>
              typeof n === 'number' && Number.isSafeInteger(n) && n > 0,
          ),
      ),
    ].sort((a, b) => a - b);
    const current = numbers.at(-1);
    const versions: NormalizedAttachmentVersion[] = [];
    for (const number of numbers) {
      const historical =
        number === current ? '' : `status=historical&version=${number}&`;
      const raw = await this.http.getJson<ConfluenceRawAttachment>(
        `${this.restPrefix}/content/${encodeURIComponent(attachmentSourceId)}?${historical}expand=version,metadata,extensions`,
      );
      if (raw.version?.number !== number) {
        throw new AtlassianRequestError(
          `Attachment ${attachmentSourceId} version ${number} returned a different revision`,
          422,
        );
      }
      versions.push(
        this.normalizeAttachmentVersion(raw, attachmentSourceId, origin),
      );
    }
    return versions;
  }

  async getPageLabels(pageSourceId: string): Promise<string[]> {
    const { items } = await this.collectList<{ name?: string }>(
      `${this.restPrefix}/content/${encodeURIComponent(pageSourceId)}/label?limit=100`,
    );

    return items
      .map((raw) => (typeof raw.name === 'string' ? raw.name.trim() : ''))
      .filter((name) => name.length > 0);
  }

  async getSpaceUsers(
    spaceKey: string,
    notice?: (message: string, meta?: Record<string, unknown>) => void,
  ): Promise<NormalizedUser[]> {
    const users = new Map<string, NormalizedUser>();
    const mentions = new Map<
      string,
      { sourceId: string; lookup: 'key' | 'username' }
    >();
    let scanned = 0;
    let userLookupTruncated = false;
    let blogsPending = true;
    let next: string | null =
      `${this.restPrefix}/content?spaceKey=${encodeURIComponent(spaceKey)}` +
      '&type=page&limit=100&expand=body.storage,version.by,history.createdBy';

    while (next && scanned < USER_SCAN_PAGE_CAP) {
      const path: string = next;
      const env =
        await this.http.getJson<ConfluenceListEnvelope<ConfluenceRawPage>>(
          path,
        );
      const rows = env.results ?? [];

      for (const row of rows) {
        if (scanned >= USER_SCAN_PAGE_CAP) break;
        scanned++;

        for (const author of [row.history?.createdBy, row.version?.by]) {
        const authorId = author?.userKey ?? author?.username;

        if (authorId && !users.has(authorId)) {
          users.set(authorId, {
            sourceType: 'confluence',
            sourceId: authorId,
            username: author?.username,
            email: undefined,
            displayName: author?.displayName?.trim() || authorId,
            active: true,
          });
        }

        }

        for (const ref of collectStorageUserRefs(
          row.body?.storage?.value ?? '',
        )) {
          if (mentions.has(ref.sourceId) || users.has(ref.sourceId)) continue;
          if (mentions.size >= USER_LOOKUP_CAP) {
            userLookupTruncated = true;
            continue;
          }

          mentions.set(ref.sourceId, ref);
        }
      }

      next = rows.length ? env._links?.next ?? null : null;
      if (!next && blogsPending) {
        blogsPending = false;
        next = `${this.restPrefix}/content?spaceKey=${encodeURIComponent(spaceKey)}&type=blogpost&limit=100&expand=body.storage,version.by,history.createdBy`;
      }
    }

    if (next) {
      notice?.(
        `user discovery scanned only the first ${USER_SCAN_PAGE_CAP} page(s) of space ${spaceKey}`,
        { userScanTruncated: true, scanned },
      );
    }

    if (userLookupTruncated) {
      notice?.(
        `user discovery capped Confluence Server user API lookups at ${USER_LOOKUP_CAP}`,
        { userLookupTruncated: true, userLookupCap: USER_LOOKUP_CAP },
      );
    }

    let unresolved = 0;

    for (const ref of mentions.values()) {
      if (users.has(ref.sourceId)) continue;

      try {
        const raw = await this.http.getJson<ConfluenceServerUser>(
          `${this.restPrefix}/user?${ref.lookup}=${encodeURIComponent(ref.sourceId)}`,
        );
        const email = (raw.email ?? raw.emailAddress)?.trim() || undefined;

        users.set(ref.sourceId, {
          sourceType: 'confluence',
          sourceId: ref.sourceId,
          username: raw.username,
          email,
          displayName:
            raw.displayName?.trim() ||
            raw.username?.trim() ||
            `Confluence user ${ref.sourceId.slice(0, 20)}`,
          active: raw.active !== false,
        });
      } catch {
        unresolved++;
        users.set(ref.sourceId, {
          sourceType: 'confluence',
          sourceId: ref.sourceId,
          username: ref.lookup === 'username' ? ref.sourceId : undefined,
          email: undefined,
          displayName: `Confluence user ${ref.sourceId.slice(0, 20)}`,
          active: true,
        });
      }
    }

    if (unresolved > 0) {
      notice?.(
        `could not resolve ${unresolved} mentioned user${unresolved === 1 ? '' : 's'} through the Confluence Server user API`,
        { unresolvedUserCount: unresolved },
      );
    }

    return [...users.values()];
  }

  // getSpacePermissions is intentionally omitted: Confluence Server exposes no usable REST
  // surface (`/space/{key}/permission` returns 404). Leaving the optional method undefined
  // makes the space stage log `spacePermsSkipped` instead of failing the run.
}
