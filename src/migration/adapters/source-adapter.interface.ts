/**
 * @fileoverview Source-adapter contract for the Atlassian → XISUITE migration tool.
 *
 * One interface, four implementations (Jira Cloud/Server, Confluence Cloud/Server) built behind
 * `SourceAdapterFactory`. Phase 0 only requires `testConnection`; later phases extend the
 * interface with read methods (listProjects, iterateIssues, listSpaces, iteratePages, …).
 */

import type {
  NormalizedAttachment,
  NormalizedBoard,
  NormalizedComment,
  NormalizedField,
  NormalizedGroup,
  NormalizedIssue,
  NormalizedHistoryEntry,
  NormalizedIssueType,
  NormalizedLinkType,
  NormalizedRemoteLink,
  NormalizedAttachmentVersion,
  NormalizedPage,
  NormalizedPageVersion,
  NormalizedPriority,
  NormalizedProject,
  NormalizedResolution,
  NormalizedRole,
  NormalizedScreen,
  NormalizedSpace,
  NormalizedSprint,
  NormalizedStatus,
  NormalizedUser,
  NormalizedWatcher,
  NormalizedWatcherList,
  NormalizedWorkflow,
  RawBody,
} from '../model/normalized';

export type SourceProduct = 'jira' | 'confluence';
export type SourceDeployment = 'cloud' | 'server';
export type SourceAuthType = 'basic' | 'pat' | 'oauth';

/**
 * Result of a connectivity probe. `deployment`/`version`/`user` are best-effort and only
 * meaningful when `ok === true`.
 */
export interface TestConnectionResult {
  ok: boolean;
  deployment: SourceDeployment;
  version: string;
  user: string;
  error?: string;
}

/**
 * Applies authentication to an outbound request's headers. Implementations: Basic, Bearer PAT,
 * OAuth (with lazy refresh — Phase 8).
 */
export interface IAuthStrategy {
  apply(headers: Record<string, string>): Promise<void>;
}

/**
 * Common surface every source adapter implements. Product-specific read surfaces live on
 * sub-interfaces (`IJiraSourceAdapter` below; the Confluence read surface arrives in Phase 9)
 * so adapters never carry stub-throw methods for the other product.
 */
export interface ISourceAdapter {
  readonly product: SourceProduct;
  readonly deployment: SourceDeployment;

  /** Probe connectivity + auth; returns detected deployment/version/current user. Never throws. */
  testConnection(): Promise<TestConnectionResult>;
}

/** A page of results carrying the cursor to resume from (offset, token, or Confluence cursor). */
export interface Page<T> {
  items: T[];
  /** null when this is the last page. */
  nextCursor: string | null;
  /** Total when the source reports it (Server offset search); null when unknown (Cloud token search). */
  total: number | null;
}

/**
 * Jira read surface (Phase 1: Server; Phase 8: Cloud). All methods return NORMALIZED DTOs —
 * callers never see Jira-shaped JSON. Read-only: adapters make zero Supabase calls and zero
 * writes to the source. Pagination hides behind `iterateIssues` (resumable async generator).
 */
export interface IJiraSourceAdapter extends ISourceAdapter {
  readonly product: 'jira';

  listProjects(): Promise<NormalizedProject[]>;
  getProjectDetails(projectKey: string): Promise<NormalizedProject>;
  getIssueTypes(projectKey: string): Promise<NormalizedIssueType[]>;
  /** Fields visible on create/edit for an issue type (createmeta/editmeta on Server). */
  getFieldsForIssueType(
    projectKey: string,
    issueTypeId: string,
  ): Promise<NormalizedField[]>;
  getStatuses(projectKey: string): Promise<NormalizedStatus[]>;
  getStatus(sourceId: string): Promise<NormalizedStatus>;
  /** Global (instance-wide) priorities in rank order — not project-scoped. */
  getPriorities(): Promise<NormalizedPriority[]>;
  /**
   * Global (instance-wide) resolutions in configured order — not project-scoped.
   * Returns [] rather than throwing: without it issues simply migrate with no `resolution_id`,
   * which is exactly the pre-existing behaviour and must not fail a run.
   */
  getResolutions(): Promise<NormalizedResolution[]>;

  /**
   * The instance's groups. Server: `/groups/picker`, which is a PICKER and caps its list — the
   * `total` in its response is load-bearing, so implementations must warn when they return fewer
   * groups than the instance holds rather than presenting a subset as complete.
   * Returns [] rather than throwing (group browsing is permission-gated).
   */
  listGroups(): Promise<NormalizedGroup[]>;

  /**
   * One page of a group's members. Reuses the user normalization so member ids key identically to
   * the `user` crosswalk. Returns an empty page rather than throwing.
   */
  getGroupMembers(
    groupSourceId: string,
    opts?: { cursor?: string | null; pageSize?: number },
  ): Promise<Page<NormalizedUser>>;
  getWorkflows(projectKey: string): Promise<NormalizedWorkflow[]>;
  /** Returns [] (never throws) when the agile API is absent (Jira Core without Software). */
  getBoards(projectKey: string): Promise<NormalizedBoard[]>;
  /** Returns [] for kanban boards (no sprints) and when the agile API is absent. */
  getSprints(boardId: string): Promise<NormalizedSprint[]>;

  /**
   * Issue sourceIds ON a board, in the board's own rank order, paged.
   *
   * A board's membership is NOT "every issue in the project" — it is whatever the board's filter
   * selects, and its ORDER is the backlog rank users arranged by hand. Both have to come from the
   * source; inferring membership from the project would put issues on boards they were never on,
   * and inventing an order would throw away the ranking entirely.
   */
  getBoardIssueIds(
    boardId: string,
    opts?: { cursor?: string | null; pageSize?: number; jql?: string | null },
  ): Promise<Page<string>>;
  getUsersAndRoles(
    projectKey: string,
  ): Promise<{ users: NormalizedUser[]; roles: NormalizedRole[] }>;

  /**
   * The project's screens and their tabs, which are Jira's field GROUPINGS.
   *
   * A Jira tab is the closest analogue to an XISUITE field group, so this is what lets the
   * `field_groups` stage reproduce the customer's real layout ("Planning", "Delivery", ...) rather
   * than dumping every migrated field into one catch-all group.
   *
   * Returns [] rather than throwing when screens are unreadable (permissions, or a deployment that
   * does not expose them) so the stage can fall back to its single-group behaviour.
   */
  getScreens(projectKey: string): Promise<NormalizedScreen[]>;

  /**
   * Field sourceId → the project ids its contexts cover. An EMPTY array means the field is GLOBAL
   * (all-projects context) — the signal the custom_fields stage uses to migrate it org-level.
   *
   * Returns an EMPTY MAP when unreadable (`/rest/api/2/customFields` is admin-gated on Server, and
   * Cloud's field search reports counts, not ids). The stage's rule is "never promote on
   * ambiguity": a field absent from this map stays space-scoped, which is today's behaviour.
   */
  getCustomFieldContexts(): Promise<Map<string, string[]>>;

  /**
   * The instance's issue link types, with BOTH directional labels.
   *
   * The links stage needs these to create a relation type it cannot match. Without them the only
   * option is to synthesize the inward label from the outward one ("blocks" → "is blocks by"), and
   * that wrong-looking text would be visible on every link of that type.
   *
   * Global, not project-scoped: Jira link types are instance-wide. Returns [] rather than throwing,
   * so an unreadable list degrades to the existing match-or-fall-back behaviour.
   */
  getIssueLinkTypes(): Promise<NormalizedLinkType[]>;

  /**
   * One issue's REMOTE links (Link → Web Link): external URLs with a title, the typical way a
   * document is attached to a Jira issue as a link. Returns [] rather than throwing so an
   * unreadable list degrades to "no remote links" without failing the run.
   */
  getIssueRemoteLinks(issueKey: string): Promise<NormalizedRemoteLink[]>;

  /**
   * One issue's edit history (Jira changelog), oldest first.
   *
   * Read per issue rather than via the search `expand`, because Jira caps how much changelog it
   * inlines in a search response and a truncated history is worse than none: the timeline would
   * look complete while silently missing the earliest transitions.
   *
   * Returns [] rather than throwing when history is unavailable — losing the audit trail must not
   * fail an otherwise good run.
   */
  getIssueHistory(issueSourceId: string): Promise<NormalizedHistoryEntry[]>;

  /**
   * One page of an issue's comments, straight from the per-issue comment resource.
   *
   * `iterateIssues(fields:['comment'])` is NOT sufficient: `fields.comment` is a PAGED sub-resource
   * (`{comments, startAt, maxResults, total}`) and Jira caps what it inlines in a search response.
   * Any issue whose comment count exceeds that cap arrives truncated, and a truncated import is the
   * one outcome this project refuses — so the comments stage falls back to this resource, which pages
   * to the true total, instead of failing the whole stage on a project that merely has busy issues.
   */
  getIssueComments(
    issueSourceId: string,
    opts?: { cursor?: string | null; pageSize?: number },
  ): Promise<Page<NormalizedComment>>;

  /** Complete, unpaginated watcher roster for one issue. Permission failures are never hidden. */
  getIssueWatchers(issueIdOrKey: string): Promise<NormalizedWatcherList>;

  /**
   * Download an attachment's bytes (authed, size-capped) for streaming into Storage.
   * `downloadUrl` is the attachment's `content` URL; it is pinned to the connection's origin
   * (SSRF guard) — a URL on a different host is fetched by its path from the connection origin,
   * never contacted directly.
   *
   * This mirrors the Confluence read surface, which had it from the start; the Jira side did not,
   * which made the `attachments` stage impossible rather than merely unwritten.
   */
  getAttachmentBytes(
    downloadUrl: string,
    maxBytes?: number,
  ): Promise<{ data: Buffer; contentType: string | null; size: number }>;

  /**
   * Streaming twin of `getAttachmentBytes`: bytes land in `destFilePath`, never the heap. The
   * large-attachment path — on-premise allows files past Node's ~4 GiB Buffer cap.
   */
  getAttachmentBytesToFile(
    downloadUrl: string,
    destFilePath: string,
    maxBytes?: number,
  ): Promise<{ contentType: string | null; size: number }>;

  /**
   * Cheap count for preview + progress denominator; null when the source can't report totals.
   *
   * Takes the SAME `jql` as `iterateIssues` — otherwise a filtered migration would reconcile against
   * the whole project and the verify stage would report a phantom shortfall on every run.
   */
  countIssues(projectKey: string, jql?: string): Promise<number | null>;
  /** Resumable stream; cursor is startAt (Server) or nextPageToken (Cloud). */
  iterateIssues(
    projectKey: string,
    opts?: {
      cursor?: string | null;
      pageSize?: number;
      fields?: string[];
      /**
       * The admin's `scope.jql`, narrowing which issues migrate. The adapter ALWAYS AND-s in the
       * project predicate and forces a stable `ORDER BY key ASC` (see `buildIssueJql`), so this can
       * only narrow the job's own project — never widen or redirect it, and never destabilise the
       * offset paging.
       */
      jql?: string;
    },
  ): AsyncGenerator<Page<NormalizedIssue>>;
}

/**
 * Type guard: adapters carrying the Jira read surface.
 *
 * This checks CAPABILITY, not product. `product === 'jira'` alone is unsound: `JiraAdapterBase`
 * hardcodes `product = 'jira'` and only implements `ISourceAdapter` (testConnection), while the read
 * surface lives on `IJiraSourceAdapter`. `JiraCloudAdapter` extends the base and implements NONE of
 * it (P8) — so a product-only guard narrows it to `IJiraSourceAdapter` and the very next
 * `adapter.getStatuses(...)` is a TypeError. TypeScript cannot catch that: a type predicate is an
 * unchecked assertion, and the Cloud connection's testConnection succeeds, so the connection looks
 * healthy right up until a run crashes.
 *
 * Probing one representative method keeps the guard honest and makes Cloud degrade to the same
 * "non-Jira source — seeding 0" path stages already handle, instead of throwing.
 */
export function isJiraAdapter(
  adapter: ISourceAdapter,
): adapter is IJiraSourceAdapter {
  return (
    adapter.product === 'jira' &&
    typeof (adapter as Partial<IJiraSourceAdapter>).listProjects === 'function'
  );
}

/** One source space permission principal (Cloud only; Server has no REST surface). */
/** One restriction group on a page: who may `read` it, or who may `update` it. */
export interface NormalizedPageRestriction {
  operation: 'read' | 'update';
  /** Confluence accountIds. */
  userSourceIds: string[];
  /** Confluence group ids — carried for reporting; the target has no group ACL for wiki pages. */
  groupSourceIds: string[];
}

export interface NormalizedSpacePermission {
  principalSourceId: string;
  principalType: 'user' | 'group';
  operation: string;
}

/**
 * Confluence read surface (Server v1 + Cloud v2). Returns NORMALIZED DTOs only. Read-only:
 * zero Supabase calls, zero writes to the source. `iteratePages` emits PARENTS BEFORE CHILDREN
 * and is resumable via the persisted cursor.
 */
export interface IConfluenceSourceAdapter extends ISourceAdapter {
  readonly product: 'confluence';

  /** List spaces (cursor pagination; follow the returned cursor until null). */
  listSpaces(cursor?: string | null): Promise<Page<NormalizedSpace>>;
  getSpaceDetails(spaceKey: string): Promise<NormalizedSpace>;

  /**
   * Iterate pages emitting parents before children (pre-order). Server recurses
   * `/content/{id}/child/page` from the homepage (`/descendant/page` is 501); Cloud pages
   * `/wiki/api/v2` and orders by ancestor depth. Resumable via `opts.cursor`.
   */
  iteratePages(
    spaceKey: string,
    opts?: { cursor?: string | null; pageSize?: number },
  ): AsyncGenerator<Page<NormalizedPage>>;

  /** Cheap page count for preview; null when the source can't report totals. */
  countPages(spaceKey: string): Promise<number | null>;

  /** Page body in the requested format. Server → 'storage' only. */
  getPageBody(
    pageSourceId: string,
    format: 'storage' | 'atlas_doc_format',
  ): Promise<RawBody>;

  getPageAttachments(pageSourceId: string): Promise<NormalizedAttachment[]>;

  /** One source page of page watchers; callers follow nextCursor until null. */
  getPageWatchers(
    pageSourceId: string,
    opts?: { cursor?: string | null; pageSize?: number },
  ): Promise<Page<NormalizedWatcher>>;

  /** One source page of space watchers; callers follow nextCursor until null. */
  getSpaceWatchers(
    spaceKey: string,
    opts?: { cursor?: string | null; pageSize?: number },
  ): Promise<Page<NormalizedWatcher>>;

  /**
   * A page's labels. Confluence labels are INSTANCE-global (a label is a bare name shared across
   * every space), while `wiki_labels` is space-scoped — so the stage dedupes by name within the
   * target space rather than trusting the source's own label ids.
   */
  getPageLabels(pageSourceId: string): Promise<string[]>;

  /**
   * A page's footer AND inline comments in one list; inline ones carry `inline.selection`.
   * Optional: the v2 comment endpoints are Cloud-only (Server exposes comments as child content).
   */
  getPageComments?(pageSourceId: string): Promise<NormalizedComment[]>;

  /**
   * A page's restrictions. Confluence keeps `read` and `update` as SEPARATE groups, which is exactly
   * the `can_view` / `can_edit` split the target needs, so the operation is preserved rather than
   * collapsed. Optional for the same reason as `getSpacePermissions`.
   */
  getPageRestrictions?(
    pageSourceId: string,
  ): Promise<NormalizedPageRestriction[]>;

  /**
   * Download an attachment's bytes (authed, size-capped) for streaming into Storage.
   * `downloadUrl` is the attachment's `downloadUrl`; it is pinned to the connection's origin
   * (SSRF guard) — a URL on a different host is rejected.
   */
  getAttachmentBytes(
    downloadUrl: string,
    maxBytes?: number,
  ): Promise<{ data: Buffer; contentType: string | null; size: number }>;

  /**
   * Best-effort space permissions. Cloud → principals; Server → throws (no REST surface).
   * The space stage catches and logs `spacePermsSkipped` — it never blocks a run.
   */
  getSpacePermissions?(spaceKey: string): Promise<NormalizedSpacePermission[]>;

  /**
   * Everyone the space refers to (page authors/owners, @mentions, permission principals).
   *
   * Optional because Cloud has no user directory a space-admin token may read — names have to be
   * recovered from page metadata and rendered bodies, and emails are never exposed at all, so every
   * user takes the placeholder path. Server resolves storage refs through its user API.
   * `notice` reports a bounded/truncated scan; it must never be used for control flow.
   */
  getSpaceUsers?(
    spaceKey: string,
    notice?: (message: string, meta?: Record<string, unknown>) => void,
  ): Promise<NormalizedUser[]>;

  /**
   * Does this connection actually expose revision history?
   *
   * Optional, and the answer is a live probe rather than an edition guess: whether history is
   * readable depends on the Confluence build AND on what the migration account is allowed to see,
   * and a space-admin token on a locked-down instance can list pages while being refused their
   * versions. Implementations cache the result per adapter instance.
   *
   * `false` is a legitimate answer, not an error. The history stage turns it into an audited
   * partial result; it must never be swallowed into a green run.
   */
  supportsHistory?(): Promise<boolean>;

  /**
   * Every revision of a page, oldest first, INCLUDING the current one (flagged `current`).
   * The current revision is already the live wiki page, so the stage imports the rest and never
   * duplicates it.
   */
  getPageVersions?(pageSourceId: string): Promise<NormalizedPageVersion[]>;

  /**
   * The body of one historical revision. Returns `null` when the source has the revision listed but
   * will not serve its body (deleted content, restricted revision) — a null is reported as a
   * per-revision gap, never retried as a transient failure.
   */
  getPageBodyAtVersion?(
    pageSourceId: string,
    version: number,
    format: 'storage' | 'atlas_doc_format',
  ): Promise<(RawBody & { title?: string }) | null>;

  /**
   * Every version of one attachment, oldest first, including the current one. Each carries its own
   * `downloadUrl` for that exact revision's bytes.
   */
  getAttachmentVersions?(
    attachmentSourceId: string,
  ): Promise<NormalizedAttachmentVersion[]>;
}

/** Type guard: adapters carrying the Confluence read surface. */
export function isConfluenceAdapter(
  adapter: ISourceAdapter,
): adapter is IConfluenceSourceAdapter {
  return adapter.product === 'confluence';
}
