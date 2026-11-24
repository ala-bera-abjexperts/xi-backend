/**
 * @fileoverview Shared Confluence adapter logic (Cloud v2 + Server/DC v1).
 *
 * Server uses `/rest/api/...`; Cloud lives under `/wiki` with `/wiki/api/v2` (+ legacy
 * `/wiki/rest/api` for the connectivity probe). Body is storage-format XHTML (Server) or
 * storage/ADF (Cloud). Phase 0 implemented `testConnection`; Phase 9 adds the shared cursor
 * paginator + normalizers that turn Confluence-shaped JSON into the source-agnostic DTOs.
 * Raw JSON never leaks past these normalizers. Everything here is read-only: zero Supabase
 * calls, zero writes to the source. Confluence has no clean JSON version endpoint, so
 * `version` on `TestConnectionResult` stays best-effort (empty).
 */

import { Logger } from '@nestjs/common';
import type { AtlassianHttpClient } from '../http/atlassian-http-client';
import type {
  ISourceAdapter,
  SourceDeployment,
  TestConnectionResult,
} from '../source-adapter.interface';
import type {
  NormalizedAttachment,
  NormalizedAttachmentVersion,
  NormalizedPage,
  NormalizedPageVersion,
  NormalizedSpace,
  NormalizedWatcher,
} from '../../model/normalized';

interface ConfluenceCurrentUser {
  username?: string;
  displayName?: string;
  accountId?: string;
  userKey?: string;
}

// ============================================================================
// Raw Confluence wire shapes (partial + defensive) — internal to the adapters
// layer. v1 (Server) and v2 (Cloud) fields coexist on the same interfaces so a
// single set of normalizers serves both deployments.
// ============================================================================

/** Envelope `_links` — `base` prefixes relative download/webui paths; `next` drives pagination. */
export interface ConfluenceRawLinks {
  next?: string;
  base?: string;
  self?: string;
  download?: string;
  webui?: string;
}

/** Author block on a version. Server: `type`/`username`/`userKey`; Cloud: `accountId`. */
export interface ConfluenceRawVersionBy {
  type?: string;
  username?: string;
  userKey?: string;
  accountId?: string;
  displayName?: string;
}

export interface ConfluenceRawVersion {
  number?: number;
  /** v1 timestamp. */
  when?: string;
  /** v2 timestamp. */
  createdAt?: string;
  /** v2 last-author accountId. */
  authorId?: string;
  /** v1 expanded author. */
  by?: ConfluenceRawVersionBy;
  /** v1 version comment (the editor's change message). */
  message?: string;
  /** v2 spells the same field `message` too, but Cloud v2 nests the author as `authorId`. */
  minorEdit?: boolean;
  /** Present on a `/content/{id}/version` listing row; absent on an expanded page's `version`. */
  friendlyWhen?: string;
}

export interface ConfluenceRawAncestor {
  id?: string | number;
  title?: string;
}

export interface ConfluenceRawSpaceHomepage {
  id?: string | number;
  title?: string;
}

export interface ConfluenceRawDescription {
  plain?: { value?: string; representation?: string };
  view?: { value?: string; representation?: string };
}

export interface ConfluenceRawSpace {
  /** Number on Server, string on Cloud — always `String()`-ed into `sourceId`. */
  id?: string | number;
  key?: string;
  name?: string;
  type?: string;
  description?: ConfluenceRawDescription;
  /** v1 expanded homepage object (id is a STRING). */
  homepage?: ConfluenceRawSpaceHomepage;
  /** v2 homepage reference. */
  homepageId?: string | number;
  /** v1 unexpanded homepage link, e.g. `/rest/api/content/393219`. */
  _expandable?: { homepage?: string };
  _links?: ConfluenceRawLinks;
}

export interface ConfluenceRawBody {
  storage?: { value?: string; representation?: string };
  /** v2 ADF body — `value` is a JSON STRING that must be parsed. */
  atlas_doc_format?: { value?: string; representation?: string };
}

export interface ConfluenceRawPage {
  history?: { createdDate?: string; createdBy?: ConfluenceRawVersionBy };
  id?: string | number;
  type?: string;
  status?: string;
  title?: string;
  /** v1 root→parent chain. */
  ancestors?: ConfluenceRawAncestor[];
  /** v2 direct parent id. */
  parentId?: string | number;
  /** v2 kind of `parentId` — `folder` parents are not pages and are fetched separately. */
  parentType?: string;
  /** v2 sibling order. */
  position?: number;
  /** v1 sibling order (`expand=extensions.position`); null means alphabetical. */
  extensions?: { position?: number | null };
  /** v2 page-level author accountId. */
  authorId?: string;
  /** v2 page creation timestamp. */
  createdAt?: string;
  version?: ConfluenceRawVersion;
  body?: ConfluenceRawBody;
  _links?: ConfluenceRawLinks;
}

export interface ConfluenceRawAttachment {
  id?: string | number;
  /** = filename. */
  title?: string;
  /** v1 mime type. */
  metadata?: { mediaType?: string };
  /** v1 size + mime type + the Media Services file id ADF references. */
  extensions?: { mediaType?: string; fileSize?: number; fileId?: string };
  /** v2 mime type. */
  mediaType?: string;
  /** v2 size. */
  fileSize?: number;
  /** v2 Media Services file id — equals an ADF `media` node's `attrs.id`. */
  fileId?: string;
  /** v2 attachment detail responses expose the binary URL at top level. */
  downloadLink?: string;
  version?: ConfluenceRawVersion;
  _links?: ConfluenceRawLinks;
}

/** Generic Confluence list envelope (v1 `size`/`totalSize`, v2 cursor via `_links.next`). */
export interface ConfluenceListEnvelope<T> {
  results?: T[];
  start?: number;
  limit?: number;
  size?: number;
  /** Grand total — reported by v1 CQL search (`/content/search`), absent elsewhere. */
  totalSize?: number;
  _links?: ConfluenceRawLinks;
}

/** User shapes returned by the legacy watcher endpoints vary by edition and endpoint. */
export interface ConfluenceRawWatcher {
  watcher?: ConfluenceRawWatcher;
  accountId?: string;
  userKey?: string;
  username?: string;
  name?: string;
  displayName?: string;
  publicName?: string;
  email?: string;
  emailAddress?: string;
  active?: boolean;
  [key: string]: unknown;
}

/** One v2 space-permission entry. */
export interface ConfluenceRawV2Permission {
  id?: string | number;
  principal?: { type?: string; id?: string | number };
  operation?: { key?: string; operation?: string; targetType?: string };
}

export abstract class ConfluenceAdapterBase implements ISourceAdapter {
  readonly product = 'confluence' as const;
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly http: AtlassianHttpClient,
    /** REST prefix used by the connectivity probe: `/rest/api` (Server) or `/wiki/rest/api` (Cloud). */
    protected readonly restPrefix: string,
    readonly deployment: SourceDeployment,
  ) {}

  /**
   * Download an attachment's bytes (authed, size-capped). Relative
   * `_links.download` paths and absolute URLs both work.
   *
   * SSRF is prevented by CONSTRUCTION, not by comparing hosts: only the path and
   * query survive, and `AtlassianHttpClient` rebuilds every request as
   * `requestOrigin + path`. The request cannot leave the configured connection
   * origin no matter what host the source advertises, and redirects are
   * revalidated and auth-stripped separately.
   *
   * There used to be an equality check on `url.origin` here that threw. It
   * protected nothing — the host it guarded was discarded on the very next line
   * — while breaking every attachment on any deployment whose Confluence
   * `base.url` differs from the URL the connection was configured with. That is
   * the normal case on-premise (internal DNS name vs public alias, IP vs
   * hostname, a non-443 port), and it cost a customer every attachment in the
   * space. A differing host is now logged, not fatal.
   *
   * Residual risk: an attachment genuinely hosted elsewhere (a CDN) is fetched
   * as that path against the connection origin and 404s — a clean, logged
   * failure instead of a guaranteed one.
   */
  async getAttachmentBytes(
    downloadUrl: string,
    maxBytes?: number,
  ): Promise<{ data: Buffer; contentType: string | null; size: number }> {
    // An absent/blank URL must NOT normalize to '/' — that silently downloads
    // the Confluence site's HTML homepage and stores it AS the attachment.
    // The Jira twin has guarded this for a while and its comment names this
    // function as the outstanding audit finding; closing it here.
    if (!downloadUrl || !downloadUrl.trim()) {
      throw new Error('Attachment has no download URL');
    }

    const origin = this.http.requestOrigin;
    let path: string;

    if (/^https?:/i.test(downloadUrl)) {
      const url = new URL(downloadUrl);

      if (url.origin !== origin) {
        this.logger.warn(
          `Attachment URL host (${url.origin}) differs from the connection origin (${origin}); fetching its path from the connection origin instead`,
        );
      }

      path = url.pathname + url.search;
    } else {
      path = downloadUrl.startsWith('/') ? downloadUrl : `/${downloadUrl}`;
    }

    return this.http.getBytes(path, maxBytes);
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const me = await this.http.getJson<ConfluenceCurrentUser>(
        `${this.restPrefix}/user/current`,
      );
      const user =
        me.username ??
        me.displayName ??
        me.accountId ??
        me.userKey ??
        'unknown';

      return { ok: true, deployment: this.deployment, version: '', user };
    } catch (err) {
      const message = (err as Error).message;

      this.logger.warn(`Confluence testConnection failed: ${message}`);

      return {
        ok: false,
        deployment: this.deployment,
        version: '',
        user: '',
        error: message,
      };
    }
  }

  // ==========================================================================
  // Shared pagination + normalizers (Server v1 + Cloud v2) — raw JSON in, DTOs out.
  // ==========================================================================

  /**
   * GET one Confluence list page and return its `results` plus the relative `_links.next`
   * (or null when this is the last page). The caller follows `nextPath` verbatim.
   */
  protected readContentJson<T>(path: string): Promise<T> {
    return this.http.getJson<T>(path);
  }

  protected async getCursorPage<T>(
    path: string,
  ): Promise<{ items: T[]; nextPath: string | null }> {
    const env = await this.readContentJson<ConfluenceListEnvelope<T>>(path);

    return { items: env.results ?? [], nextPath: env._links?.next ?? null };
  }

  /**
   * Read one authoritative watcher page. Watcher endpoints are legacy v1 on both editions and
   * inconsistently return either a user row or `{ watcher: user }`, so normalization stays here.
   */
  protected async getWatcherPage(
    path: string,
    identity: 'cloud' | 'server',
  ): Promise<{
    items: NormalizedWatcher[];
    nextCursor: string | null;
    total: number | null;
  }> {
    const env =
      await this.readContentJson<ConfluenceListEnvelope<ConfluenceRawWatcher>>(
        path,
      );
    const nextCursor = env._links?.next ?? null;

    if (nextCursor === path) {
      throw new Error(
        `Confluence watcher pagination made no progress: repeated cursor ${path}`,
      );
    }

    const seen = new Set<string>();
    const rows = env.results ?? [];
    const items: NormalizedWatcher[] = [];

    for (const entry of rows) {
      const raw = entry.watcher ?? entry;
      const sourceId =
        identity === 'cloud'
          ? raw.accountId?.trim()
          : raw.userKey?.trim() || raw.username?.trim() || raw.name?.trim();

      if (!sourceId) {
        throw new Error(
          'Confluence watcher identity fidelity failure: source returned a watcher without a stable identity',
        );
      }
      if (seen.has(sourceId)) continue;

      seen.add(sourceId);
      const email = (raw.email ?? raw.emailAddress)?.trim();
      const username =
        identity === 'server'
          ? raw.username?.trim() || raw.name?.trim()
          : undefined;
      items.push({
        sourceId,
        ...(username ? { username } : {}),
        displayName:
          raw.displayName?.trim() || raw.publicName?.trim() || sourceId,
        ...(email ? { email } : {}),
        active: typeof raw.active === 'boolean' ? raw.active : null,
      });
    }

    const start = typeof env.start === 'number' ? env.start : 0;
    if (
      nextCursor === null &&
      typeof env.totalSize === 'number' &&
      start + rows.length < env.totalSize
    ) {
      throw new Error(
        `Confluence watcher identity fidelity failure: source reported ${env.totalSize} watcher rows but exposed only ${start + rows.length}`,
      );
    }

    return {
      items,
      nextCursor,
      total: typeof env.totalSize === 'number' ? env.totalSize : null,
    };
  }

  /**
   * Follow `_links.next` from `firstPath` to the end, accumulating every `results` row. Also
   * returns the site `origin` (from the first envelope's `_links.base`/`_links.self`) so callers
   * can prefix relative download links. Used by the "collect everything" reads (attachments,
   * permissions, child/root page ids).
   */
  protected async collectList<T>(
    firstPath: string,
  ): Promise<{ items: T[]; origin: string }> {
    const items: T[] = [];
    let origin = '';
    let next: string | null = firstPath;

    while (next) {
      // Pin the narrowed value into a `string` const: a reused `string | null` loop variable
      // is de-narrowed at the call site, which collapses `getJson`'s generic return to `any`.
      const path: string = next;
      const env = await this.readContentJson<ConfluenceListEnvelope<T>>(path);

      if (!origin) origin = this.originFromLinks(env._links);

      for (const item of env.results ?? []) items.push(item);

      next = env._links?.next ?? null;
    }

    return { items, origin };
  }

  /** Site origin for prefixing relative download/webui links — from `_links.base`, else `_links.self`. */
  protected originFromLinks(links?: ConfluenceRawLinks): string {
    if (links?.base) return links.base.replace(/\/+$/, '');

    if (links?.self) {
      try {
        return new URL(links.self).origin;
      } catch {
        // Non-absolute self — fall through to empty origin.
      }
    }

    return '';
  }

  protected normalizeSpace(raw: ConfluenceRawSpace): NormalizedSpace {
    return {
      sourceId: String(raw.id ?? ''),
      key: raw.key ?? '',
      name: raw.name ?? '',
      // Empty description strings collapse to undefined.
      description: raw.description?.plain?.value || undefined,
      homepageSourceId: this.resolveHomepageId(raw),
    };
  }

  protected normalizePage(raw: ConfluenceRawPage): NormalizedPage {
    const ancestorChain = (raw.ancestors ?? [])
      .map((a) => String(a.id ?? ''))
      .filter((id) => id.length > 0);
    // v2 pages carry only a direct `parentId` (no ancestor chain).
    const ancestors =
      ancestorChain.length === 0 &&
      raw.parentId != null &&
      String(raw.parentId).length > 0
        ? [String(raw.parentId)]
        : ancestorChain;
    const parentSourceId =
      ancestors.length > 0 ? ancestors[ancestors.length - 1] : null;
    const when = raw.version?.when ?? raw.version?.createdAt;
    // Anything that would not fit `wiki_pages.sort_order` (int4) is dropped, never clamped: a clamped
    // value reorders siblings silently, a dropped one just falls back to alphabetical.
    const position = raw.position ?? raw.extensions?.position;

    return {
      ...(typeof position === 'number' &&
      Number.isInteger(position) &&
      Math.abs(position) <= 2147483647
        ? { position }
        : {}),
      ...(raw.parentType === 'page' || raw.parentType === 'folder'
        ? { parentType: raw.parentType }
        : {}),
      ...(raw.type === 'blogpost'
        ? {
            contentKind: 'blogpost' as const,
            authorName: raw.history?.createdBy?.displayName,
            authorUsername: raw.history?.createdBy?.username,
          }
        : {}),
      sourceId: String(raw.id ?? ''),
      title: raw.title ?? '',
      parentSourceId,
      ancestors,
      version: raw.version?.number ?? 1,
      // Server has no ADF; Cloud's richest body is ADF — this is the format the mapper requests.
      bodyFormat: this.deployment === 'cloud' ? 'atlas_doc_format' : 'storage',
      authorSourceId: this.resolveAuthorId(
        raw.type === 'blogpost' && raw.history?.createdBy
          ? { by: raw.history.createdBy }
          : raw.version,
        raw.authorId,
      ),
      // Best-effort: Server exposes only the last-version timestamp; v2 adds page `createdAt`.
      createdAt: raw.createdAt ?? raw.history?.createdDate ?? when,
      updatedAt: when,
    };
  }

  protected normalizeAttachment(
    raw: ConfluenceRawAttachment,
    pageSourceId: string,
    origin: string,
  ): NormalizedAttachment {
    // `_links.download` is already URL-encoded — prefix the origin verbatim, never re-encode.
    const download = raw._links?.download ?? raw.downloadLink ?? '';
    const downloadUrl = download
      ? /^https?:\/\//i.test(download) || !origin
        ? download
        : origin + download
      : '';
    const mimeType =
      raw.metadata?.mediaType ?? raw.extensions?.mediaType ?? raw.mediaType;
    const size = raw.extensions?.fileSize ?? raw.fileSize;

    return {
      sourceId: String(raw.id ?? ''),
      filename: raw.title ?? '',
      // v2 exposes it top-level, v1 under `extensions`. Carried so ADF `media.attrs.id` resolves.
      fileId: raw.fileId ?? raw.extensions?.fileId ?? undefined,
      mimeType: mimeType || undefined,
      sizeBytes: typeof size === 'number' ? size : undefined,
      downloadUrl,
      authorSourceId: this.resolveAuthorId(raw.version, undefined),
      pageSourceId,
      created: raw.version?.when ?? raw.version?.createdAt,
    };
  }

  /** Homepage id is always a STRING: prefer v1 expanded object, then v2 `homepageId`, then the link path. */
  private resolveHomepageId(raw: ConfluenceRawSpace): string | undefined {
    if (raw.homepage?.id != null) return String(raw.homepage.id);

    if (raw.homepageId != null) return String(raw.homepageId);

    const path = raw._expandable?.homepage;

    if (path) {
      const match = /\/(\d+)(?:$|[/?])/.exec(path);

      if (match?.[1]) return match[1];
    }

    return undefined;
  }

  /**
   * Resolve an author reference from a version block. Anonymous edits (`by.type === 'anonymous'`,
   * no username/userKey) yield undefined. Server prefers `userKey`/`username`; Cloud uses
   * `accountId` (expanded `by.accountId` or the flat `version.authorId` / page-level `authorId`).
   */
  private resolveAuthorId(
    version: ConfluenceRawVersion | undefined,
    pageAuthorId: string | undefined,
  ): string | undefined {
    const by = version?.by;

    if (by) {
      if (by.type === 'anonymous') return undefined;

      return by.userKey ?? by.username ?? by.accountId ?? undefined;
    }

    return version?.authorId ?? pageAuthorId ?? undefined;
  }

  // ==========================================================================
  // Revision history (shared normalization; the editions differ only in the URLs)
  // ==========================================================================

  /**
   * Memoized answer to "can this connection read revision history at all".
   *
   * Cached per adapter instance because the history stage asks once per page and the answer cannot
   * change mid-run. `undefined` = not yet probed; the probe itself is edition-specific.
   */
  private historySupport: boolean | undefined;

  /**
   * Probe once, remember. `probe()` never throws and reports the status, so a 401/403 (account not
   * allowed to read versions) is as much a legitimate `false` as a 404 (build has no such endpoint).
   * Both mean the same thing to the caller: this run cannot claim a complete history import.
   */
  protected async probeHistoryOnce(path: string): Promise<boolean> {
    if (this.historySupport !== undefined) return this.historySupport;

    const res = await this.http.probe(path);

    this.historySupport = res.ok;

    if (!res.ok) {
      this.logger.warn(
        `Confluence ${this.deployment} did not expose revision history at ${path} (status ${res.status}); history import will be reported as partial`,
      );
    }

    return this.historySupport;
  }

  protected normalizePageVersion(
    raw: ConfluenceRawVersion,
    pageSourceId: string,
    currentVersion: number | null,
  ): NormalizedPageVersion {
    const version = raw.number ?? 0;

    return {
      pageSourceId,
      version,
      authorSourceId: this.resolveAuthorId(raw, undefined),
      created: raw.when ?? raw.createdAt,
      // Confluence sends '' for "no comment"; collapse to undefined so the target stores NULL.
      message: raw.message?.trim() ? raw.message.trim() : undefined,
      minorEdit: typeof raw.minorEdit === 'boolean' ? raw.minorEdit : undefined,
      current: currentVersion != null ? version === currentVersion : undefined,
    };
  }

  protected normalizeAttachmentVersion(
    raw: ConfluenceRawAttachment,
    attachmentSourceId: string,
    origin: string,
  ): NormalizedAttachmentVersion {
    // Same rule as the current-version download: `_links.download` is already percent-encoded,
    // so the origin is prefixed verbatim and never re-encoded.
    const download = raw._links?.download ?? raw.downloadLink ?? '';
    const size = raw.extensions?.fileSize ?? raw.fileSize;
    const mimeType =
      raw.metadata?.mediaType ?? raw.extensions?.mediaType ?? raw.mediaType;

    return {
      attachmentSourceId,
      version: raw.version?.number ?? 0,
      filename: raw.title || undefined,
      mimeType: mimeType || undefined,
      sizeBytes: typeof size === 'number' ? size : undefined,
      authorSourceId: this.resolveAuthorId(raw.version, undefined),
      created: raw.version?.when ?? raw.version?.createdAt,
      message: raw.version?.message?.trim()
        ? raw.version.message.trim()
        : undefined,
      downloadUrl: download
        ? /^https?:\/\//i.test(download) || !origin
          ? download
          : origin + download
        : '',
    };
  }
}
