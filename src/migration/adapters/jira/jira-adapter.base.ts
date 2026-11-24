/**
 * @fileoverview Shared Jira adapter logic (Cloud v3 + Server v2).
 *
 * Cloud/Server differ only in API version path (`/rest/api/3` vs `/rest/api/2`), body format
 * (ADF vs wiki-markup), and user identity model (accountId vs key/name) — all handled in the
 * subclasses. Phase 0 implemented `testConnection`; Phase 1 adds the shared normalizers that
 * turn Jira-shaped JSON into the source-agnostic normalized DTOs. Raw JSON never leaks past
 * these normalizers.
 */

import { Logger } from '@nestjs/common';
import { AtlassianRequestError } from '../http/atlassian-http-client';
import type { AtlassianHttpClient } from '../http/atlassian-http-client';
import type {
  ISourceAdapter,
  SourceDeployment,
  TestConnectionResult,
} from '../source-adapter.interface';
import type {
  NormalizedField,
  NormalizedFieldOption,
  NormalizedIssue,
  NormalizedIssueType,
  NormalizedLink,
  NormalizedRemoteLink,
  NormalizedPriority,
  NormalizedProject,
  NormalizedStatus,
  NormalizedStatusCategory,
  NormalizedUser,
  NormalizedWatcher,
  NormalizedWatcherList,
  RawBody,
} from '../../model/normalized';

interface JiraServerInfo {
  version?: string;
  deploymentType?: string;
}

interface JiraCurrentUser {
  name?: string;
  displayName?: string;
  emailAddress?: string;
  accountId?: string;
}

// ============================================================================
// Raw Jira wire shapes (partial + defensive) — internal to the adapters layer.
// ============================================================================

export interface JiraRawUser {
  /** Server login name (stable id on Server). */
  name?: string;
  /** Some Server/DC versions label the login name explicitly. */
  username?: string;
  /** Server user key (e.g. "JIRAUSER10000"). */
  key?: string;
  /** Cloud account id. */
  accountId?: string;
  emailAddress?: string;
  displayName?: string;
  active?: boolean;
  avatarUrl?: string;
  avatarUrls?: Record<string, string>;
}

export interface JiraRawWatcherList {
  watchCount?: number;
  watchers?: JiraRawUser[];
}

export interface JiraRawIssueType {
  id?: string | number;
  name?: string;
  description?: string;
  iconUrl?: string;
  subtask?: boolean;
}

export interface JiraRawProject {
  id?: string | number;
  key?: string;
  name?: string;
  description?: string;
  lead?: JiraRawUser;
  projectTypeKey?: string;
  avatarUrls?: Record<string, string>;
  archived?: boolean;
  issueTypes?: JiraRawIssueType[];
}

export interface JiraRawStatus {
  id?: string | number;
  name?: string;
  statusCategory?: {
    key?: string;
    colorName?: string;
  };
}

export interface JiraRawPriority {
  id?: string | number;
  name?: string;
  description?: string;
  statusColor?: string;
  iconUrl?: string;
}

export interface JiraRawAllowedValue {
  id?: string | number;
  value?: string | number;
  name?: string;
  children?: JiraRawAllowedValue[];
}

/** One field meta from createmeta — classic (object values) or Jira 9 (`values[]` entries). */
export interface JiraRawFieldMeta {
  fieldId?: string;
  name?: string;
  required?: boolean;
  schema?: { type?: string; custom?: string; items?: string };
  allowedValues?: unknown;
}

export interface JiraRawAttachment {
  id?: string | number;
  filename?: string;
  mimeType?: string;
  size?: number;
  content?: string;
  author?: JiraRawUser | null;
  created?: string;
}

export interface JiraRawComment {
  id?: string | number;
  author?: JiraRawUser | null;
  body?: unknown;
  created?: string;
  updated?: string;
}

export interface JiraRawIssueLink {
  id?: string | number;
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: { id?: string | number };
  outwardIssue?: { id?: string | number };
}

export interface JiraRawIssueFields {
  summary?: string;
  issuetype?: { id?: string | number } | null;
  status?: { id?: string | number } | null;
  priority?: { id?: string | number } | null;
  assignee?: JiraRawUser | null;
  reporter?: JiraRawUser | null;
  parent?: { id?: string | number } | null;
  description?: unknown;
  labels?: string[];
  attachment?: JiraRawAttachment[];
  /**
   * `total`/`maxResults` are load-bearing, not decoration: Jira caps the comments it inlines in a
   * search response, so `comments.length < total` means the rest are NOT here. Flattening to a bare
   * array would let a partial import look complete — the 598/600-pages failure mode.
   */
  comment?: {
    comments?: JiraRawComment[];
    total?: number;
    maxResults?: number;
  } | null;
  issuelinks?: JiraRawIssueLink[];
  created?: string;
  updated?: string;
  duedate?: string | null;
  resolutiondate?: string | null;
  resolution?: { id?: string | number; name?: string } | null;
  /** Custom fields (`customfield_*`) and any other navigable field. */
  [key: string]: unknown;
}

export interface JiraRawIssue {
  id?: string | number;
  key?: string;
  fields?: JiraRawIssueFields;
  /**
   * `expand=renderedFields` returns the SOURCE's own HTML rendering of its own wiki markup — for
   * comments as well as the description. Verified on the wire (Jira Server 8.22.4): with
   * `fields=comment&expand=renderedFields`, `renderedFields.comment` comes back shaped exactly like
   * `fields.comment` (`{comments, maxResults, total, startAt}`). It was previously typed
   * description-only and the comment rendering was silently discarded, which would have degraded
   * every migrated comment to escaped plain text.
   */
  renderedFields?: {
    description?: unknown;
    comment?: { comments?: { id?: string | number; body?: unknown }[] } | null;
  };
}

const GREENHOPPER_SPRINT_RE = /com\.atlassian\.greenhopper/;
const SPRINT_ID_RE = /id=(\d+)/;

export class InvalidJiraStatusError extends Error {}

export class RequiredJiraIdentityError extends AtlassianRequestError {}

export abstract class JiraAdapterBase implements ISourceAdapter {
  readonly product = 'jira' as const;
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly http: AtlassianHttpClient,
    /** '2' for Server/DC, '3' for Cloud. */
    protected readonly apiVersion: '2' | '3',
    readonly deployment: SourceDeployment,
  ) {}

  protected async requiredIdentityJson<T>(path: string): Promise<T> {
    try {
      return await this.http.getJson<T>(path);
    } catch (error) {
      if (
        error instanceof AtlassianRequestError &&
        [401, 403].includes(error.status)
      ) {
        throw new RequiredJiraIdentityError(
          `Required Jira identity endpoint ${path} returned HTTP ${error.status}. Check the connection credentials and source project-role/Browse users permissions, then retry the migration.`,
          error.status,
        );
      }
      throw error;
    }
  }

  async getStatus(sourceId: string): Promise<NormalizedStatus> {
    const raw = await this.http.getJson<JiraRawStatus>(
      `/rest/api/${this.apiVersion}/status/${encodeURIComponent(sourceId)}`,
    );
    if (
      String(raw.id ?? '') !== sourceId ||
      !raw.name ||
      !raw.statusCategory?.key
    ) {
      throw new InvalidJiraStatusError(
        `Jira status ${sourceId} returned incomplete status detail`,
      );
    }
    return this.normalizeStatus(raw);
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const info = await this.http.getJson<JiraServerInfo>(
        `/rest/api/${this.apiVersion}/serverInfo`,
      );
      const me = await this.http.getJson<JiraCurrentUser>(
        `/rest/api/${this.apiVersion}/myself`,
      );

      const detected: SourceDeployment =
        info.deploymentType === 'Cloud' ? 'cloud' : 'server';
      const user =
        me.name ??
        me.displayName ??
        me.emailAddress ??
        me.accountId ??
        'unknown';

      return {
        ok: true,
        deployment: detected,
        version: info.version ?? '',
        user,
      };
    } catch (err) {
      const message = (err as Error).message;

      this.logger.warn(`Jira testConnection failed: ${message}`);

      return {
        ok: false,
        deployment: this.deployment,
        version: '',
        user: '',
        error: message,
      };
    }
  }

  /**
   * A Jira issue's REMOTE links (Link → Web Link). Same endpoint on Server (v2) and Cloud (v3).
   * This is the only place a "linked document" (PDF, Confluence page, external system) attached
   * via a web link is visible — it never appears in `fields.issuelinks`, which is why such
   * documents used to vanish during migration.
   */
  async getIssueRemoteLinks(issueKey: string): Promise<NormalizedRemoteLink[]> {
    try {
      const res = await this.http.getJson<
        {
          id?: string | number;
          object?: { url?: string; title?: string; summary?: string };
        }[]
      >(
        `/rest/api/${this.apiVersion}/issue/${encodeURIComponent(issueKey)}/remotelink`,
      );

      return (res ?? [])
        .map((r) => ({
          sourceId: String(r.id ?? ''),
          url: (r.object?.url ?? '').trim(),
          title: (r.object?.title ?? '').trim(),
          ...(r.object?.summary?.trim()
            ? { summary: r.object.summary.trim() }
            : {}),
        }))
        .filter((l) => l.url.length > 0);
    } catch (err) {
      this.logger.warn(
        `getIssueRemoteLinks(${issueKey}) failed: ${(err as Error).message}`,
      );

      return [];
    }
  }

  /**
   * Download an attachment's bytes, origin-pinned. Identical on Server and Cloud, so it lives on the
   * base — but note it does NOT make `JiraCloudAdapter` a usable Jira source: `isJiraAdapter()`
   * probes `listProjects`, which the Cloud stub still lacks, so the capability guard is unaffected.
   */
  async getAttachmentBytes(
    downloadUrl: string,
    maxBytes?: number,
  ): Promise<{ data: Buffer; contentType: string | null; size: number }> {
    return this.http.getBytes(this.attachmentPath(downloadUrl), maxBytes);
  }

  /**
   * Streaming twin of `getAttachmentBytes` — bytes go straight to `destFilePath`, never the heap.
   * The large-attachment path (on-premise allows files past Node's ~4 GiB Buffer cap).
   */
  async getAttachmentBytesToFile(
    downloadUrl: string,
    destFilePath: string,
    maxBytes?: number,
  ): Promise<{ contentType: string | null; size: number }> {
    return this.http.getBytesToFile(
      this.attachmentPath(downloadUrl),
      destFilePath,
      maxBytes,
    );
  }

  /** The origin-pinned request path for an attachment URL, shared by both download variants. */
  private attachmentPath(downloadUrl: string): string {
    // An absent/blank URL must NOT normalize to '/' — that silently downloads the Jira site's HTML
    // homepage and stores it AS the attachment. (The Confluence twin has exactly that bug; it is a
    // confirmed audit finding. Do not mirror it.)
    if (!downloadUrl || !downloadUrl.trim()) {
      throw new Error('Attachment has no download URL');
    }

    const origin = this.http.requestOrigin;

    if (/^https?:/i.test(downloadUrl)) {
      const url = new URL(downloadUrl);

      // SSRF is prevented by CONSTRUCTION: only the path and query survive, and
      // `AtlassianHttpClient` rebuilds the request as `requestOrigin + path`, so
      // the source cannot point us at another host whatever it advertises.
      // This used to throw on a differing origin, which protected nothing (the
      // host is discarded on the next line) while failing every attachment on
      // any deployment whose Jira `base.url` differs from the URL the connection
      // was configured with — the normal case on-premise. Log, do not fail.
      if (url.origin !== origin) {
        this.logger.warn(
          `Attachment URL host (${url.origin}) differs from the connection origin (${origin}); fetching its path from the connection origin instead`,
        );
      }

      return url.pathname + url.search;
    }

    return downloadUrl.startsWith('/') ? downloadUrl : `/${downloadUrl}`;
  }

  // ==========================================================================
  // Shared normalizers (Server v2 + Cloud v3) — raw Jira JSON in, DTOs out.
  // ==========================================================================

  protected normalizeProject(raw: JiraRawProject): NormalizedProject {
    return {
      sourceId: String(raw.id ?? ''),
      key: raw.key ?? '',
      name: raw.name ?? '',
      description: raw.description || undefined,
      // MUST go through `userStableId` — the crosswalk is keyed by whatever IT returns, and the
      // space stage looks the lead up by this value. Hand-rolling the precedence here inverted it
      // (`key ?? name` vs `name ?? key`), and on Jira Server a user carries BOTH: the lead resolved
      // to `JIRAUSER10000` while the users stage had recorded `christian.kienzl`. The lookup could
      // never match, so EVERY Server migration silently created its space with no lead — verified
      // live ("Project lead \"JIRAUSER10000\" is not in the user crosswalk"). One function owns the
      // stable id so the two sides cannot drift apart again.
      leadUserSourceId: this.userStableId(raw.lead),
      projectTypeKey: raw.projectTypeKey,
      avatarUrl: raw.avatarUrls?.['48x48'],
      archived: raw.archived,
    };
  }

  protected normalizeIssueType(raw: JiraRawIssueType): NormalizedIssueType {
    const isSubtask = raw.subtask === true;
    const name = raw.name ?? '';

    // "Epos" is the German localization of "Epic" (localized names on Server).
    const hierarchyHint = isSubtask
      ? 'subtask'
      : /^epic$|^epos$/i.test(name)
        ? 'epic'
        : 'standard';

    return {
      sourceId: String(raw.id ?? ''),
      name,
      description: raw.description || undefined,
      iconUrl: raw.iconUrl,
      isSubtask,
      hierarchyHint,
    };
  }

  protected normalizeStatus(raw: JiraRawStatus): NormalizedStatus {
    const key = raw.statusCategory?.key;

    // Old Jira reports category key "undefined" (or none at all) — bucket to
    // 'indeterminate' rather than trusting localized names.
    const statusCategory: NormalizedStatusCategory =
      key === 'new' ? 'new' : key === 'done' ? 'done' : 'indeterminate';

    return {
      sourceId: String(raw.id ?? ''),
      name: raw.name ?? '',
      statusCategory,
      colorName: raw.statusCategory?.colorName,
    };
  }

  protected normalizePriority(
    raw: JiraRawPriority,
    index: number,
  ): NormalizedPriority {
    const color = (raw.statusColor ?? '').trim();

    return {
      sourceId: String(raw.id ?? ''),
      name: raw.name ?? '',
      description: raw.description || undefined,
      // Jira reports either a hex value or a named color — only keep real hex, and only the 6-digit
      // form `CreateTaskPriorityDto.color` accepts, so the priorities stage cannot 400 on it.
      colorHex: /^#[0-9a-fA-F]{6}$/.test(color) ? color : undefined,
      iconUrl: raw.iconUrl,
      rank: index,
    };
  }

  /**
   * Normalize one createmeta field meta. `fieldIdHint` covers the classic createmeta shape
   * where fields arrive as an object keyed by field id (the metas also carry `fieldId`,
   * but the key is authoritative).
   */
  protected normalizeField(
    raw: JiraRawFieldMeta,
    fieldIdHint?: string,
  ): NormalizedField {
    const fieldId = fieldIdHint ?? raw.fieldId ?? '';

    return {
      sourceId: fieldId,
      name: raw.name ?? fieldId,
      isCustom:
        fieldId.startsWith('customfield_') || raw.schema?.custom != null,
      schemaType: raw.schema?.type ?? 'string',
      schemaCustom: raw.schema?.custom,
      schemaItems: raw.schema?.items,
      required: raw.required === true,
      allowedValues: this.normalizeAllowedValues(raw.allowedValues),
    };
  }

  private normalizeAllowedValues(
    values: unknown,
  ): NormalizedFieldOption[] | undefined {
    if (!Array.isArray(values)) return undefined;

    return values.map((entry): NormalizedFieldOption => {
      const raw = entry as JiraRawAllowedValue;

      return {
        id: String(raw.id ?? raw.value ?? ''),
        value: String(raw.value ?? raw.name ?? ''),
        children: this.normalizeAllowedValues(raw.children),
      };
    });
  }

  protected normalizeUser(raw: JiraRawUser): NormalizedUser {
    const sourceId = this.userStableId(raw) ?? '';

    return {
      sourceType: 'jira',
      sourceId,
      username: raw.name,
      email: raw.emailAddress || undefined,
      displayName: raw.displayName ?? sourceId,
      active: raw.active !== false,
      avatarUrl: raw.avatarUrl ?? raw.avatarUrls?.['48x48'],
    };
  }

  /**
   * Normalize and prove completeness of Jira's unpaginated watcher response.
   * A missing identity or a count disagreement is a fidelity/permission failure: returning the
   * visible subset would make the migration report claim success while silently losing watchers.
   */
  protected normalizeWatcherList(
    raw: JiraRawWatcherList,
    identity: (user: JiraRawUser) => string | undefined,
  ): NormalizedWatcherList {
    const rows = Array.isArray(raw.watchers) ? raw.watchers : [];
    const total = raw.watchCount;

    if (!Number.isInteger(total) || (total as number) < 0) {
      throw new Error('Jira watcher response has an invalid watchCount');
    }

    const watchers = new Map<string, NormalizedWatcher>();

    for (const row of rows) {
      const sourceId = identity(row)?.trim();

      if (!sourceId) {
        throw new Error('Jira watcher identity is incomplete');
      }

      if (watchers.has(sourceId)) continue;

      const email = row.emailAddress?.trim().toLowerCase();
      watchers.set(sourceId, {
        sourceId,
        ...((row.name ?? row.username)?.trim()
          ? { username: (row.name ?? row.username)!.trim() }
          : {}),
        ...(email ? { email } : {}),
        displayName: row.displayName?.trim() || sourceId,
        active: row.active == null ? null : row.active === true,
      });
    }

    if (watchers.size !== total) {
      throw new Error(
        `Jira watcher watchCount ${total} does not match visible unique identity count ${watchers.size}`,
      );
    }

    return { watchers: [...watchers.values()], total };
  }

  /** Stable user reference: Server prefers login name (key is internal), Cloud uses accountId. */
  protected userStableId(
    user: JiraRawUser | null | undefined,
  ): string | undefined {
    if (!user) return undefined;

    const id = user.name ?? user.key ?? user.accountId;

    return id ? String(id) : undefined;
  }

  /**
   * Wrap a raw description/comment body untransformed. Format is decided BY VALUE:
   * object → ADF (Cloud), string → wiki markup (Server, with the pre-rendered HTML
   * from `expand=renderedFields` kept as the transformer fallback).
   */
  protected toRawBody(
    body: unknown,
    renderedHtml?: string,
  ): RawBody | undefined {
    if (body === null || body === undefined) return undefined;

    if (typeof body === 'object') return { format: 'adf', value: body };

    return { format: 'wiki', value: body, renderedHtml };
  }

  protected normalizeIssue(raw: JiraRawIssue): NormalizedIssue {
    const fields: JiraRawIssueFields = raw.fields ?? {};
    const renderedDescription = raw.renderedFields?.description;

    // Comment id → the source's own rendered HTML. Keyed by id rather than zipped by index: the
    // arrays are parallel in practice, but pairing bodies to the wrong comments is exactly the kind
    // of silent corruption that survives review.
    const renderedComments = new Map<string, string>();

    for (const rc of raw.renderedFields?.comment?.comments ?? []) {
      if (typeof rc.body === 'string' && rc.id != null) {
        renderedComments.set(String(rc.id), rc.body);
      }
    }

    const customFields: Record<string, unknown> = {};
    const sprintIds = new Set<string>();

    for (const [key, value] of Object.entries(fields)) {
      if (!key.startsWith('customfield_')) continue;
      if (value === null || value === undefined) continue;

      customFields[key] = value;

      // Server serializes the sprint field as an array of greenhopper toString()
      // strings ("com.atlassian.greenhopper.service.sprint.Sprint@…[id=1,…]").
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry !== 'string') continue;
          if (!GREENHOPPER_SPRINT_RE.test(entry)) continue;

          const match = SPRINT_ID_RE.exec(entry);

          if (match?.[1]) sprintIds.add(match[1]);
        }
      }
    }

    const links: NormalizedLink[] = [];

    for (const link of fields.issuelinks ?? []) {
      if (link.outwardIssue?.id != null) {
        links.push({
          sourceId: String(link.id ?? ''),
          type: link.type?.name ?? '',
          direction: 'outward',
          otherIssueSourceId: String(link.outwardIssue.id),
          relationName: link.type?.outward ?? '',
        });
      } else if (link.inwardIssue?.id != null) {
        links.push({
          sourceId: String(link.id ?? ''),
          type: link.type?.name ?? '',
          direction: 'inward',
          otherIssueSourceId: String(link.inwardIssue.id),
          relationName: link.type?.inward ?? '',
        });
      }
    }

    return {
      sourceId: String(raw.id ?? ''),
      key: raw.key ?? '',
      summary: fields.summary ?? '',
      issueTypeSourceId: String(fields.issuetype?.id ?? ''),
      statusSourceId: String(fields.status?.id ?? ''),
      prioritySourceId:
        fields.priority?.id != null ? String(fields.priority.id) : undefined,
      assigneeSourceId: this.userStableId(fields.assignee),
      reporterSourceId: this.userStableId(fields.reporter),
      parentSourceId:
        fields.parent?.id != null ? String(fields.parent.id) : undefined,
      description: this.toRawBody(
        fields.description,
        typeof renderedDescription === 'string'
          ? renderedDescription
          : undefined,
      ),
      labels: Array.isArray(fields.labels) ? fields.labels : [],
      customFields,
      attachments: (fields.attachment ?? []).map((a) => ({
        sourceId: String(a.id ?? ''),
        filename: a.filename ?? '',
        mimeType: a.mimeType,
        sizeBytes: typeof a.size === 'number' ? a.size : undefined,
        downloadUrl: a.content ?? '',
        authorSourceId: this.userStableId(a.author),
        created: a.created,
      })),
      comments: (fields.comment?.comments ?? []).map((c) => ({
        sourceId: String(c.id ?? ''),
        authorSourceId: this.userStableId(c.author),
        // Pair each comment with the source's OWN rendered HTML, matched by comment id (the arrays
        // are parallel but never assume order). Without this the body is raw wiki markup and the
        // transformer can only degrade it to escaped plain text — losing bold, lists, links, code.
        body: this.toRawBody(
          c.body,
          renderedComments.get(String(c.id ?? '')),
        ) ?? {
          format: 'wiki',
          value: '',
        },
        created: c.created,
        updated: c.updated,
      })),
      // Lets the comments stage assert `comments.length === commentsTotal` and FAIL loudly rather
      // than migrate a silently truncated subset.
      commentsTotal:
        typeof fields.comment?.total === 'number'
          ? fields.comment.total
          : undefined,
      links,
      created: fields.created,
      updated: fields.updated,
      dueDate: fields.duedate ?? undefined,
      resolutionDate: fields.resolutiondate ?? undefined,
      ...(fields.resolution?.id != null
        ? { resolutionSourceId: String(fields.resolution.id) }
        : {}),
      ...(fields.resolution?.name
        ? { resolutionName: fields.resolution.name }
        : {}),
      sprintSourceIds: sprintIds.size > 0 ? [...sprintIds] : undefined,
    };
  }
}
