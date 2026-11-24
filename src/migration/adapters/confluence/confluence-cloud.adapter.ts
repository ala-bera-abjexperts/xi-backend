/**
 * @fileoverview Confluence Cloud adapter (`/wiki/api/v2`) — Phase 9 read surface.
 *
 * Storage/ADF bodies; `accountId` users. Read methods use the v2 API; pages page via
 * `_links.next` cursors and are ordered roots-before-children within each batch (the stage's
 * parent gate handles cross-batch ordering). Read-only: zero Supabase calls, zero writes to
 * the source.
 *
 * NOTE ON restPrefix: the base `testConnection` probes `${restPrefix}/user/current`, which is
 * a v1-only path (v2 has no equivalent). To keep the probe working WITHOUT overriding it, the
 * base is constructed with the legacy v1 prefix and every read method below targets `this.v2`
 * explicitly — the least-disruptive split.
 */

import type {
  NormalizedAttachment,
  NormalizedAttachmentVersion,
  NormalizedComment,
  NormalizedPage,
  NormalizedPageVersion,
  NormalizedSpace,
  NormalizedUser,
  NormalizedWatcher,
  RawBody,
} from '../../model/normalized';
import type {
  IConfluenceSourceAdapter,
  NormalizedPageRestriction,
  NormalizedSpacePermission,
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
  ConfluenceRawV2Permission,
} from './confluence-adapter.base';
import { ConfluenceAdapterBase } from './confluence-adapter.base';

/** Bound on the user-discovery scan so a very large space cannot turn the DAG root into a crawl. */
const USER_SCAN_PAGE_CAP = 2000;

/** v1 content row, expanded with the user objects Cloud will actually hand over. */
interface ConfluenceRawContentWithUsers {
  version?: { by?: ConfluenceRawUser };
  history?: { createdBy?: ConfluenceRawUser };
}

/** v2 comment row (footer or inline). */
interface ConfluenceRawComment {
  id?: string | number;
  resolutionStatus?: string;
  version?: { authorId?: string; createdAt?: string };
  body?: { atlas_doc_format?: { value?: string } };
  properties?: Record<string, string | undefined>;
}

/** v1 restriction group. */
interface ConfluenceRawRestriction {
  operation?: string;
  restrictions?: {
    user?: { results?: { accountId?: string }[] };
    group?: { results?: { id?: string; name?: string }[] };
  };
}

interface ConfluenceRawUser {
  accountId?: string;
  /** Cloud's non-PII label. `displayName` appears on some responses; either is fine. */
  publicName?: string;
  displayName?: string;
}

/** Every `mention` account id in an ADF body. Cheaper and safer than parsing the whole document. */
export function collectMentionIds(adf: string | undefined): string[] {
  if (!adf) return [];

  const out: string[] = [];
  let doc: unknown;

  try {
    doc = JSON.parse(adf);
  } catch {
    return out;
  }

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const child of node) walk(child);

      return;
    }

    const n = node as {
      type?: string;
      attrs?: { id?: unknown };
      content?: unknown;
    };

    if (n.type === 'mention' && typeof n.attrs?.id === 'string') {
      out.push(n.attrs.id);
    }

    walk(n.content);
  };

  walk(doc);

  return out;
}

/**
 * `accountId → label` pairs out of a RENDERED Confluence body, which writes a mention as
 * `<a class="confluence-userlink user-mention" data-account-id="…">Display Name</a>`. This is the only
 * channel that names a user who has never authored anything.
 */
export function renderedMentionLabels(
  html: string | undefined,
): [string, string][] {
  if (!html) return [];

  const out: [string, string][] = [];
  const re = /data-account-id="([^"]+)"[^>]*>([^<]{1,120})</g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(html)) !== null) {
    const label = match[2].trim();

    if (label) out.push([match[1], label]);
  }

  return out;
}

export class ConfluenceCloudAdapter
  extends ConfluenceAdapterBase
  implements IConfluenceSourceAdapter
{
  /** v2 read prefix. The base keeps the v1 prefix purely for `testConnection` (see file note). */
  private readonly v2 = '/wiki/api/v2';

  constructor(http: AtlassianHttpClient) {
    super(http, '/wiki/rest/api', 'cloud');
  }

  async getPageWatchers(
    pageSourceId: string,
    opts?: { cursor?: string | null; pageSize?: number },
  ): Promise<Page<NormalizedWatcher>> {
    const limit = Math.min(Math.max(opts?.pageSize ?? 100, 1), 200);
    const path =
      opts?.cursor ??
      `${this.restPrefix}/content/${encodeURIComponent(pageSourceId)}/notification/child-created?limit=${limit}`;

    return this.getWatcherPage(path, 'cloud');
  }

  async getSpaceWatchers(
    spaceKey: string,
    opts?: { cursor?: string | null; pageSize?: number },
  ): Promise<Page<NormalizedWatcher>> {
    const limit = Math.min(Math.max(opts?.pageSize ?? 100, 1), 200);
    const path =
      opts?.cursor ??
      `${this.restPrefix}/space/${encodeURIComponent(spaceKey)}/watch?limit=${limit}`;

    return this.getWatcherPage(path, 'cloud');
  }

  private readonly blogIds = new Set<string>();

  protected override async readContentJson<T>(path: string): Promise<T> {
    const match = /^\/wiki\/api\/v2\/pages\/([^/?]+)([/?].*)?$/.exec(path);
    const blogPath = match ? path.replace('/pages/', '/blogposts/') : path;
    if (match && this.blogIds.has(match[1])) return this.http.getJson<T>(blogPath);
    try { return await this.http.getJson<T>(path); }
    catch (error) {
      if (!match || !(error instanceof AtlassianRequestError) || error.status !== 404) throw error;
      const result = await this.http.getJson<T>(blogPath);
      this.blogIds.add(match[1]);
      return result;
    }
  }

  async listSpaces(cursor?: string | null): Promise<Page<NormalizedSpace>> {
    const path =
      cursor ?? `${this.v2}/spaces?limit=50&description-format=plain`;
    const { items, nextPath } =
      await this.getCursorPage<ConfluenceRawSpace>(path);

    return {
      // v2 token pagination reports no grand total.
      items: items.map((s) => this.normalizeSpace(s)),
      nextCursor: nextPath,
      total: null,
    };
  }

  async getSpaceDetails(spaceKey: string): Promise<NormalizedSpace> {
    // v2 spaces are addressed by id; resolve the caller-supplied key via the `keys` filter.
    const env = await this.readContentJson<
      ConfluenceListEnvelope<ConfluenceRawSpace>
    >(
      `${this.v2}/spaces?keys=${encodeURIComponent(spaceKey)}&description-format=plain`,
    );
    const raw = env.results?.[0];

    if (!raw) {
      throw new Error(
        `Confluence Cloud space with key "${spaceKey}" not found`,
      );
    }

    return this.normalizeSpace(raw);
  }

  async *iteratePages(
    spaceKey: string,
    opts?: { cursor?: string | null; pageSize?: number },
  ): AsyncGenerator<Page<NormalizedPage>> {
    let path: string | null;

    if (opts?.cursor) {
      path = opts.cursor;
    } else {
      const space = await this.getSpaceDetails(spaceKey);

      // `body-format=storage` was dead weight: Cloud bodies are ADF and are fetched separately by
      // `getPageBody`, so the list response's body was never read — it just made every list page far
      // larger. `pageSize` is the caller's batch size (200 = the endpoint's max), and it is what sets
      // the seeding rate, so ignoring it capped seeding at half speed.
      const limit = Math.min(Math.max(opts?.pageSize ?? 100, 1), 250);

      path = `${this.v2}/spaces/${encodeURIComponent(space.sourceId)}/pages?limit=${limit}`;
    }

    while (path) {
      // Pin the narrowed value: a reused `string | null` loop variable is de-narrowed at the
      // call site, collapsing the generic return to `any`.
      const currentPath: string = path;
      const { items, nextPath } =
        await this.getCursorPage<ConfluenceRawPage>(currentPath);
      // Roots (no parent) precede children within the batch; the stage's parent gate
      // handles pages whose parent lands in an earlier or later batch.
      const ordered = [...items].sort(
        (a, b) => this.pageDepthHint(a) - this.pageDepthHint(b),
      );

      const isBlog = currentPath.includes('/blogposts');
      let nextCursor = items.length ? nextPath : null;
      if (!nextCursor && !isBlog) {
        const space = await this.getSpaceDetails(spaceKey);
        nextCursor = `${this.v2}/spaces/${encodeURIComponent(space.sourceId)}/blogposts?limit=${Math.min(Math.max(opts?.pageSize ?? 100, 1), 250)}`;
      }
      yield {
        items: ordered.map((p) => {
          if (isBlog) this.blogIds.add(String(p.id));
          return this.normalizePage(isBlog ? { ...p, type: 'blogpost' } : p);
        }),
        nextCursor,
        total: null,
      };
      path = nextCursor;
    }
  }

  /**
   * One v2 folder as a `folder` container (`{id,title,parentId,parentType,position}`). Folders nest
   * in folders and under pages, and `iteratePages` never lists them, so the pages stage fetches each
   * one a page points at. A 404 (folder deleted) returns null: the page is then detached to the
   * space root exactly like a page whose parent page was deleted.
   */
  async getFolder(folderId: string): Promise<NormalizedPage | null> {
    try {
      const raw = await this.http.getJson<ConfluenceRawPage>(
        `${this.v2}/folders/${encodeURIComponent(folderId)}`,
      );

      return { ...this.normalizePage(raw), contentKind: 'folder' };
    } catch (error) {
      if (error instanceof AtlassianRequestError && error.status === 404) {
        return null;
      }

      throw error;
    }
  }

  countPages(): Promise<number | null> {
    // v2 offers no cheap page total for a space.
    return Promise.resolve(null);
  }

  async getPageBody(
    pageSourceId: string,
    format: 'storage' | 'atlas_doc_format',
  ): Promise<RawBody> {
    const raw = await this.readContentJson<ConfluenceRawPage>(
      `${this.v2}/pages/${encodeURIComponent(pageSourceId)}?body-format=${encodeURIComponent(format)}`,
    );

    if (format === 'atlas_doc_format') {
      // v2 delivers ADF as a JSON string — parse it into the ADF document object.
      const rawValue = raw.body?.atlas_doc_format?.value ?? '';
      let value: unknown = {};

      if (rawValue) {
        try {
          value = JSON.parse(rawValue) as unknown;
        } catch {
          value = {};
        }
      }

      return { format: 'adf', value };
    }

    return { format: 'storage', value: raw.body?.storage?.value ?? '' };
  }

  // ==========================================================================
  // Revision history (Cloud)
  // ==========================================================================

  /** Cloud exposes `/api/v2/pages/{id}/versions`; the probe also catches a token that may not read them. */
  async supportsHistory(): Promise<boolean> {
    return this.probeHistoryOnce(`${this.v2}/pages?limit=1`);
  }

  async getPageVersions(
    pageSourceId: string,
  ): Promise<NormalizedPageVersion[]> {
    const { items } = await this.collectList<ConfluenceRawVersion>(
      `${this.v2}/pages/${encodeURIComponent(pageSourceId)}/versions?limit=50`,
    );

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
    // v2 has no "body at version" surface, so this drops to the v1 historical form, which is the
    // only Cloud route that serves an older body. It returns storage XHTML even for ADF pages, so
    // the caller gets `storage` here while the CURRENT body still comes back as ADF from v2.
    const raw = await this.readContentJson<ConfluenceRawPage>(
      `${this.restPrefix}/content/${encodeURIComponent(pageSourceId)}?status=historical&version=${version}&expand=body.storage`,
    );

    const value = raw.body?.storage?.value;

    if (typeof value !== 'string') return null;

    if (format === 'atlas_doc_format') {
      this.logger.debug(
        `Cloud getPageBodyAtVersion returned storage for page ${pageSourceId} v${version}; ADF is not available for historical bodies`,
      );
    }

    return {
      format: 'storage',
      value,
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    };
  }

  async getAttachmentVersions(
    attachmentSourceId: string,
  ): Promise<NormalizedAttachmentVersion[]> {
    const { items, origin } = await this.collectList<ConfluenceRawVersion>(
      `${this.v2}/attachments/${encodeURIComponent(attachmentSourceId)}/versions?limit=50`,
    );
    // The Cloud version list has revision metadata only; GET attachment accepts a version.
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
    const versions: NormalizedAttachmentVersion[] = [];
    for (const number of numbers) {
      const raw = await this.readContentJson<ConfluenceRawAttachment>(
        `${this.v2}/attachments/${encodeURIComponent(attachmentSourceId)}?version=${number}`,
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

  async getPageAttachments(
    pageSourceId: string,
  ): Promise<NormalizedAttachment[]> {
    const { items, origin } = await this.collectList<ConfluenceRawAttachment>(
      `${this.v2}/pages/${encodeURIComponent(pageSourceId)}/attachments?limit=50`,
    );

    return items.map((raw) =>
      this.normalizeAttachment(raw, pageSourceId, origin),
    );
  }

  /**
   * Every person referenced by the space, with a real display name.
   *
   * Confluence Cloud gives us no user directory to ask: measured against the customer's instance with
   * a space-admin token, `/wiki/rest/api/user?accountId=`, `/wiki/rest/api/user/bulk` and the whole
   * Jira `/rest/api/3/user*` family all return 403/401, `/wiki/api/v2/users/{id}` returns 400, and a
   * `user.accountid` CQL search returns an empty result set. `/user/current` is the ONLY user endpoint
   * that answers — for the caller themselves. Emails are never exposed (`email: ""`), so every user
   * here takes the placeholder path in `UserMapper`.
   *
   * So names are recovered from the two channels that DO work, cheapest first:
   *   1. `expand=version.by,history.createdBy` on the v1 content LIST — one request per 100 pages,
   *      returning full user objects for whoever created or last modified each page.
   *   2. the RENDERED body (`expand=body.view`), where Confluence writes the mention's label next to
   *      its `data-account-id`. Fetched only for pages that mention a still-unnamed account, because
   *      server-side rendering a page is expensive.
   *
   * Both are needed: on the customer's space step 1 named 1 of the 3 referenced people (the other two
   * never authored anything) and step 2 named the remaining two from 5 targeted fetches.
   */
  async getSpaceUsers(
    spaceKey: string,
    notice?: (message: string, meta?: Record<string, unknown>) => void,
  ): Promise<NormalizedUser[]> {
    const space = await this.getSpaceDetails(spaceKey);
    /** accountId → display name (empty until resolved). */
    const names = new Map<string, string>();
    /** accountId → a page that mentions them, for the targeted `body.view` fallback. */
    const mentionedOn = new Map<string, string>();
    let scanned = 0;
    let truncated = false;

    // ── pass 1: collect account ids from page bodies (mentions) and page metadata (author/owner) ──
    let blogsPending = true;
    let next: string | null =
      `${this.v2}/spaces/${encodeURIComponent(space.sourceId)}/pages` +
      `?limit=100&body-format=atlas_doc_format`;

    while (next) {
      const path: string = next;
      const env =
        await this.readContentJson<ConfluenceListEnvelope<ConfluenceRawPage>>(
          path,
        );

      for (const raw of env.results ?? []) {
        scanned++;

        for (const id of [
          (raw as { authorId?: string }).authorId,
          (raw as { ownerId?: string }).ownerId,
          (raw as { version?: { authorId?: string } }).version?.authorId,
        ]) {
          if (id) names.set(String(id), names.get(String(id)) ?? '');
        }

        const body = (
          raw as { body?: { atlas_doc_format?: { value?: string } } }
        ).body?.atlas_doc_format?.value;

        for (const accountId of collectMentionIds(body)) {
          names.set(accountId, names.get(accountId) ?? '');
          if (!mentionedOn.has(accountId)) {
            mentionedOn.set(accountId, String(raw.id ?? ''));
          }
        }
      }

      // A directory scan must not become unbounded on a huge space. If the cap bites, say so — a
      // silently truncated scan reads as "these are all the users" when it is not.
      if (scanned >= USER_SCAN_PAGE_CAP) {
        truncated = true;
        break;
      }

      next = env._links?.next ?? null;
      if (!next && blogsPending) {
        blogsPending = false;
        next = `${this.v2}/spaces/${encodeURIComponent(space.sourceId)}/blogposts?limit=100&body-format=atlas_doc_format`;
      }
    }

    // ── pass 2: bulk names for authors/modifiers (1 request per 100 pages) ──
    for (const contentType of ['page', 'blogpost']) {
    for (let start = 0; start < scanned; start += 100) {
      const env = await this.readContentJson<{
        results?: ConfluenceRawContentWithUsers[];
      }>(
        `${this.restPrefix}/content?spaceKey=${encodeURIComponent(space.key)}` +
          `&type=${contentType}&limit=100&start=${start}` +
          `&expand=version.by,history.createdBy`,
      );
      const rows = env.results ?? [];

      for (const row of rows) {
        for (const user of [row.version?.by, row.history?.createdBy]) {
          const accountId = user?.accountId;
          const label = user?.publicName || user?.displayName || '';

          if (accountId && label) names.set(accountId, label);
        }
      }

      if (rows.length < 100) break;
    }

    }

    // ── pass 3: the rendered body names anyone left over (mention-only users) ──
    for (const [accountId, pageId] of mentionedOn) {
      if (names.get(accountId) || !pageId) continue;

      try {
        const rendered = await this.readContentJson<{
          body?: { view?: { value?: string } };
        }>(
          `${this.restPrefix}/content/${encodeURIComponent(pageId)}?expand=body.view`,
        );

        for (const [id, label] of renderedMentionLabels(
          rendered.body?.view?.value,
        )) {
          if (!names.get(id)) names.set(id, label);
        }
      } catch {
        // A name is a nicety; the account id is what the crosswalk needs. Keep going.
      }
    }

    // ── space permission principals: no names, but they must exist for permissions to be applied ──
    try {
      for (const perm of await this.getSpacePermissions(spaceKey)) {
        if (perm.principalType === 'user' && perm.principalSourceId) {
          names.set(
            perm.principalSourceId,
            names.get(perm.principalSourceId) ?? '',
          );
        }
      }
    } catch {
      // Permissions are best-effort (see `getSpacePermissions`); never fail user discovery on them.
    }

    if (truncated) {
      notice?.(
        `user discovery scanned only the first ${USER_SCAN_PAGE_CAP} page(s) of space ${space.key} — ` +
          `anyone mentioned only on a later page will migrate as an unresolved mention`,
        { userScanTruncated: true, scanned },
      );
    }

    return [...names].map(([accountId, displayName]) => ({
      sourceType: 'confluence' as const,
      sourceId: accountId,
      // Never invent an email: a wrong one would MATCH an unrelated person in the target org and hand
      // them another tenant's content. No email → UserMapper takes the placeholder path.
      email: undefined,
      displayName: displayName || `Confluence user ${accountId.slice(0, 12)}`,
      active: true,
    }));
  }

  async getPageLabels(pageSourceId: string): Promise<string[]> {
    const { items } = await this.collectList<{ name?: string }>(
      `${this.v2}/pages/${encodeURIComponent(pageSourceId)}/labels?limit=100`,
    );

    return items
      .map((raw) => (typeof raw.name === 'string' ? raw.name.trim() : ''))
      .filter((name) => name.length > 0);
  }

  /**
   * Footer + inline comments for one page.
   *
   * Two endpoints, one list: `/footer-comments` and `/inline-comments`. Only the inline ones carry
   * `properties.inlineOriginalSelection`, which is the text the comment was attached to and the ONLY
   * durable way to re-anchor it in the target: Confluence's own `inlineMarkerRef` points into the
   * source document, and character offsets do not survive an ADF to TipTap transform.
   */
  /** ADF arrives as a JSON string on every v2 body; an unparseable one degrades to an empty doc. */
  private parseAdf(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return { type: 'doc', version: 1, content: [] };
    }
  }

  async getPageComments(pageSourceId: string): Promise<NormalizedComment[]> {
    const out: NormalizedComment[] = [];

    for (const kind of ['footer-comments', 'inline-comments'] as const) {
      const { items } = await this.collectList<ConfluenceRawComment>(
        `${this.v2}/pages/${encodeURIComponent(pageSourceId)}/${kind}` +
          `?limit=100&body-format=atlas_doc_format`,
      );

      for (const raw of items) {
        if (raw.id == null) continue;

        const value = raw.body?.atlas_doc_format?.value;

        // A comment with no body is not worth a row; Confluence allows empty drafts.
        if (!value) continue;

        const selection =
          raw.properties?.inlineOriginalSelection ??
          raw.properties?.['inline-original-selection'];

        out.push({
          sourceId: String(raw.id),
          pageSourceId,
          authorSourceId: raw.version?.authorId,
          body: { format: 'adf', value: this.parseAdf(value) },
          created: raw.version?.createdAt,
          resolved: raw.resolutionStatus === 'resolved',
          ...(kind === 'inline-comments' && selection
            ? {
                inline: {
                  selection,
                  markerRef:
                    raw.properties?.inlineMarkerRef ??
                    raw.properties?.['inline-marker-ref'],
                },
              }
            : {}),
        });
      }
    }

    return out;
  }

  /**
   * A page's restrictions, keeping Confluence's `read` / `update` split intact.
   *
   * v1 only: there is no v2 restrictions endpoint. Note that an EMPTY group is meaningful in
   * Confluence ("no restriction"), so a page with no entries must not be reported as restricted.
   */
  async getPageRestrictions(
    pageSourceId: string,
  ): Promise<NormalizedPageRestriction[]> {
    const { items } = await this.collectList<ConfluenceRawRestriction>(
      `${this.restPrefix}/content/${encodeURIComponent(pageSourceId)}/restriction?limit=50`,
    );
    const out: NormalizedPageRestriction[] = [];

    for (const raw of items) {
      const operation = raw.operation === 'read' ? 'read' : 'update';
      const userSourceIds = (raw.restrictions?.user?.results ?? [])
        .map((u) => u.accountId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const groupSourceIds = (raw.restrictions?.group?.results ?? [])
        .map((g) => g.id ?? g.name)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      if (userSourceIds.length === 0 && groupSourceIds.length === 0) continue;

      out.push({ operation, userSourceIds, groupSourceIds });
    }

    return out;
  }

  async getSpacePermissions(
    spaceKey: string,
  ): Promise<NormalizedSpacePermission[]> {
    const space = await this.getSpaceDetails(spaceKey);
    const { items } = await this.collectList<ConfluenceRawV2Permission>(
      `${this.v2}/spaces/${encodeURIComponent(space.sourceId)}/permissions?limit=100`,
    );
    const perms: NormalizedSpacePermission[] = [];

    for (const raw of items) {
      const principalId = raw.principal?.id;

      if (principalId == null || String(principalId).length === 0) continue;

      perms.push({
        principalSourceId: String(principalId),
        principalType: raw.principal?.type === 'group' ? 'group' : 'user',
        operation: raw.operation?.key ?? raw.operation?.operation ?? '',
      });
    }

    return perms;
  }

  /** Ordering hint: ancestor depth when present, else 0 (root) / 1 (has parent) via `parentId`. */
  private pageDepthHint(p: ConfluenceRawPage): number {
    if (p.ancestors && p.ancestors.length > 0) return p.ancestors.length;

    return p.parentId != null && String(p.parentId).length > 0 ? 1 : 0;
  }
}
