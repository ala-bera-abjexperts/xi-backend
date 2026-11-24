/**
 * @fileoverview Jira Cloud adapter (REST v3) — P8.
 *
 * Mirrors `JiraServerAdapter`, differing only where Cloud genuinely differs. Every divergence below
 * is a real API difference, not a preference:
 *
 *  - **Project listing is paginated.** `/rest/api/3/project` is deprecated on Cloud; the supported
 *    call is `/project/search`, which pages (`isLast`/`startAt`). Server's flat array does not exist.
 *  - **Classic createmeta is gone.** Cloud only offers
 *    `/issue/createmeta/{projectKey}/issuetypes/{typeId}` (the `values[]` shape). Server tries the
 *    classic form first and falls back; here the fallback IS the only form.
 *  - **Token pagination, and NO reported total.** `/search/jql` returns `nextPageToken` + `isLast`.
 *    The shared token walk is also used by `countIssues`, so verification derives an exact count
 *    from the same source surface instead of trusting the removed legacy search resource.
 *  - **Workflow schemes use Cloud's public v3 resources.** The Server-only `projectconfig` endpoint
 *    is not used; project associations + the scheme preserve issue-type mappings. Transition rules
 *    remain unavailable through this read and are reported as a lossy conversion by the stage.
 *  - **Users are `accountId`-keyed** and usually have no email. `userStableId` in the base already
 *    prefers accountId, and the user mapper falls back to a linked placeholder when there is no
 *    email to match on — which on Cloud is the common case, not the exception.
 *
 * ADF: descriptions/comments arrive as ADF objects. `toRawBody` in the base already tags those
 * `{format:'adf'}`, and `issue-body.mapper.ts` uses the source's `renderedHtml` when present
 * (`expand=renderedFields` is requested below) and otherwise reports the body as not-yet-convertible
 * rather than emitting `[object Object]`.
 *
 * Cloud live admission remains gated by a matching, exactly reconciled dry run. The adapter must
 * therefore fail loudly on incomplete pagination or permission failures; an empty array is reserved
 * for a source that genuinely reports no records.
 */

import type {
  NormalizedBoard,
  NormalizedComment,
  NormalizedIssue,
  NormalizedHistoryEntry,
  NormalizedIssueType,
  NormalizedPriority,
  NormalizedProject,
  NormalizedRole,
  NormalizedLinkType,
  NormalizedGroup,
  NormalizedResolution,
  NormalizedScreen,
  NormalizedScreenTab,
  NormalizedRoleActor,
  NormalizedSprint,
  NormalizedStatus,
  NormalizedUser,
  NormalizedWorkflow,
} from '../../model/normalized';
import type { IJiraSourceAdapter, Page } from '../source-adapter.interface';
import type { AtlassianHttpClient } from '../http/atlassian-http-client';
import { AtlassianRequestError } from '../http/atlassian-http-client';
import type {
  JiraRawComment,
  JiraRawFieldMeta,
  JiraRawIssue,
  JiraRawPriority,
  JiraRawProject,
  JiraRawStatus,
  JiraRawUser,
  JiraRawWatcherList,
} from './jira-adapter.base';
import { buildIssueJql, stripOrderBy } from './issue-jql';
import { JiraAdapterBase } from './jira-adapter.base';
import type { NormalizedField } from '../../model/normalized';

const API = '/rest/api/3';
const AGILE = '/rest/agile/1.0';
// Verified live against Jira Cloud: the classic Greenhopper board-config endpoint IS present on
// Cloud and returns the same shape as Server, so WIP limits, quick filters and swimlanes ARE
// readable here. The earlier assumption that Cloud lacks it was wrong.
const GREENHOPPER = '/rest/greenhopper/1.0';

/** The subset of the Greenhopper board edit model this adapter reads. Same shape on Server + Cloud. */
interface CloudEditModel {
  rapidListConfig?: {
    mappedColumns?: {
      min?: unknown;
      max?: unknown;
      isKanPlanColumn?: boolean;
    }[];
  };
  quickFilterConfig?: {
    quickFilters?: {
      id?: number | string;
      name?: string;
      query?: string;
      description?: string;
    }[];
  };
  swimlanesConfig?: {
    swimlaneStrategy?: string;
    swimlanes?: {
      id?: number | string;
      name?: string;
      query?: string;
      description?: string;
      isDefault?: boolean;
    }[];
  };
}

const PAGE_SIZE = 50;

interface CloudPage<T> {
  values?: T[];
  isLast?: boolean;
  startAt?: number;
  total?: number;
}

interface CloudSearchResult {
  issues?: JiraRawIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

interface CloudWorkflowScheme {
  id?: string | number;
  defaultWorkflow?: string;
  issueTypeMappings?: Record<string, string>;
}

function nextOffset<T>(
  label: string,
  current: number,
  response: CloudPage<T>,
  received: number,
): number | null {
  // No page-count ceiling: a project may be any size. The two progress checks below are what stop a
  // misbehaving site from looping forever.
  if (response.isLast !== false) return null;
  if (received === 0) {
    throw new Error(
      `${label} pagination made no progress at offset ${current}`,
    );
  }

  const reported =
    typeof response.startAt === 'number' ? response.startAt : current;
  const next = reported + received;

  if (next <= current) {
    throw new Error(`${label} pagination did not advance past ${current}`);
  }

  return next;
}

interface CloudRoleActor {
  actorUser?: { accountId?: string };
  displayName?: string;
  type?: string;
}

interface CloudRoleDetail {
  id?: string | number;
  name?: string;
  description?: string;
  actors?: CloudRoleActor[];
}

export class JiraCloudAdapter
  extends JiraAdapterBase
  implements IJiraSourceAdapter
{
  constructor(http: AtlassianHttpClient) {
    super(http, '3', 'cloud');
  }

  async getIssueWatchers(issueIdOrKey: string) {
    const raw = await this.http.getJson<JiraRawWatcherList>(
      `${API}/issue/${encodeURIComponent(issueIdOrKey)}/watchers`,
    );

    return this.normalizeWatcherList(raw, (user) =>
      user.accountId ? String(user.accountId) : undefined,
    );
  }

  /** `/project` is deprecated on Cloud — `/project/search` pages instead. */
  async listProjects(): Promise<NormalizedProject[]> {
    const out: NormalizedProject[] = [];
    let startAt = 0;

    for (;;) {
      const res = await this.http.getJson<CloudPage<JiraRawProject>>(
        `${API}/project/search?startAt=${startAt}&maxResults=${PAGE_SIZE}&expand=description,lead`,
      );
      const values = res.values ?? [];

      out.push(...values.map((p) => this.normalizeProject(p)));

      const next = nextOffset(
        'Jira Cloud projects',
        startAt,
        res,
        values.length,
      );

      if (next === null) return out;
      startAt = next;
    }
  }

  async getProjectDetails(projectKey: string): Promise<NormalizedProject> {
    const raw = await this.http.getJson<JiraRawProject>(
      `${API}/project/${encodeURIComponent(projectKey)}?expand=description,lead`,
    );

    return this.normalizeProject(raw);
  }

  async getIssueTypes(projectKey: string): Promise<NormalizedIssueType[]> {
    const raw = await this.http.getJson<JiraRawProject>(
      `${API}/project/${encodeURIComponent(projectKey)}?expand=issueTypes`,
    );

    return (raw.issueTypes ?? []).map((t) => this.normalizeIssueType(t));
  }

  /** Cloud removed classic createmeta — only the per-issue-type `values[]` form exists. */
  async getFieldsForIssueType(
    projectKey: string,
    issueTypeId: string,
  ): Promise<NormalizedField[]> {
    const key = encodeURIComponent(projectKey);
    const typeId = encodeURIComponent(issueTypeId);
    const res = await this.http.getJson<{ values?: JiraRawFieldMeta[] }>(
      `${API}/issue/createmeta/${key}/issuetypes/${typeId}?maxResults=200`,
    );
    const values = res.values ?? [];

    // Atlassian Cloud intermittently returns an EMPTY `values` array from the paginated createmeta
    // resource (observed live: the same project/type that legacy createmeta reports 17 fields for
    // returns 0 here). Discovering zero fields would silently drop EVERY custom field and its values,
    // so fall back to the legacy `expand=projects.issuetypes.fields` shape, which stays populated.
    if (values.length === 0) {
      return this.getFieldsForIssueTypeLegacy(projectKey, issueTypeId);
    }

    return values.map((meta) => ({
      ...this.normalizeField(meta),
      issueTypeSourceIds: [issueTypeId],
    }));
  }

  /**
   * Legacy createmeta fallback. Returns `projects[].issuetypes[].fields` as a MAP keyed by field id
   * (not an array), so the key is passed to `normalizeField` as the id hint. Deprecated by Atlassian
   * but still functional, and the only reliable field-discovery path when the paginated resource
   * returns empty. Never throws on a missing project/type — an empty result is a valid answer.
   */
  private async getFieldsForIssueTypeLegacy(
    projectKey: string,
    issueTypeId: string,
  ): Promise<NormalizedField[]> {
    const res = await this.http.getJson<{
      projects?: {
        issuetypes?: { fields?: Record<string, JiraRawFieldMeta> }[];
      }[];
    }>(
      `${API}/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}` +
        `&issuetypeIds=${encodeURIComponent(issueTypeId)}&expand=projects.issuetypes.fields`,
    );
    const fields = res.projects?.[0]?.issuetypes?.[0]?.fields ?? {};

    return Object.entries(fields).map(([fieldId, meta]) => ({
      ...this.normalizeField(meta, fieldId),
      issueTypeSourceIds: [issueTypeId],
    }));
  }

  /** Same shape as Server: statuses repeat per issue type, so dedupe and union the type ids. */
  async getStatuses(projectKey: string): Promise<NormalizedStatus[]> {
    const raw = await this.http.getJson<
      { id?: string | number; statuses?: JiraRawStatus[] }[]
    >(`${API}/project/${encodeURIComponent(projectKey)}/statuses`);
    const byId = new Map<string, NormalizedStatus>();

    for (const entry of Array.isArray(raw) ? raw : []) {
      const issueTypeId = entry.id != null ? String(entry.id) : '';

      for (const rawStatus of entry.statuses ?? []) {
        const normalized = this.normalizeStatus(rawStatus);
        const existing = byId.get(normalized.sourceId);

        if (existing) {
          if (
            issueTypeId &&
            !existing.issueTypeSourceIds?.includes(issueTypeId)
          ) {
            existing.issueTypeSourceIds = [
              ...(existing.issueTypeSourceIds ?? []),
              issueTypeId,
            ];
          }
        } else {
          byId.set(normalized.sourceId, {
            ...normalized,
            issueTypeSourceIds: issueTypeId ? [issueTypeId] : [],
          });
        }
      }
    }

    return [...byId.values()];
  }

  async getPriorities(): Promise<NormalizedPriority[]> {
    const raw = await this.http.getJson<JiraRawPriority[]>(`${API}/priority`);

    return (Array.isArray(raw) ? raw : []).map((p, i) =>
      this.normalizePriority(p, i),
    );
  }

  /** Project workflow scheme via Cloud's supported project association + scheme resources. */
  async getWorkflows(projectKey: string): Promise<NormalizedWorkflow[]> {
    const fallback = (warning: string): NormalizedWorkflow[] => {
      const name = `${projectKey} Workflow`;

      return [
        {
          sourceId: name,
          name,
          statusSourceIds: [],
          transitions: null,
          issueTypeSourceIds: ['*'],
          isDefault: true,
          migrationWarnings: [warning],
        },
      ];
    };

    try {
      const project = await this.getProjectDetails(projectKey);
      const association = await this.http.getJson<{
        values?: { workflowScheme?: CloudWorkflowScheme }[];
      }>(
        `${API}/workflowscheme/project?projectId=${encodeURIComponent(project.sourceId)}`,
      );
      const associated = association.values?.[0]?.workflowScheme;

      // Atlassian's default workflow scheme has no id. Its only faithful public representation is
      // the same unrestricted default used by the Server fallback, but the loss is carried into the
      // run log instead of disappearing inside the adapter logger.
      if (associated?.id == null) {
        return fallback(
          'Jira Cloud uses the default workflow scheme; per-issue-type workflow mappings were unavailable',
        );
      }

      const scheme = await this.http.getJson<CloudWorkflowScheme>(
        `${API}/workflowscheme/${encodeURIComponent(String(associated.id))}`,
      );
      const workflows = new Map<string, string[]>();

      if (scheme.defaultWorkflow) workflows.set(scheme.defaultWorkflow, ['*']);

      for (const [issueTypeId, workflowName] of Object.entries(
        scheme.issueTypeMappings ?? {},
      )) {
        if (!workflowName || workflowName === scheme.defaultWorkflow) continue;

        workflows.set(workflowName, [
          ...(workflows.get(workflowName) ?? []),
          issueTypeId,
        ]);
      }

      if (workflows.size === 0) {
        return fallback(
          'Jira Cloud workflow scheme contained no readable mappings',
        );
      }

      return [...workflows].map(([name, issueTypeSourceIds]) => ({
        sourceId: name,
        name,
        statusSourceIds: [],
        transitions: null,
        issueTypeSourceIds,
        isDefault: issueTypeSourceIds.includes('*'),
      }));
    } catch (err) {
      if (
        err instanceof AtlassianRequestError &&
        (err.status === 403 || err.status === 404)
      ) {
        return fallback(
          `Jira Cloud workflow scheme was unreadable (${err.status}); using one unrestricted workflow`,
        );
      }

      throw err;
    }
  }

  /** Agile API is identical to Server's. Returns [] when the site has no Jira Software. */
  async getBoards(projectKey: string): Promise<NormalizedBoard[]> {
    const raw: {
      id?: string | number;
      name?: string;
      type?: string;
      filter?: { id?: string | number };
    }[] = [];

    try {
      let startAt = 0;

      for (;;) {
        const res = await this.http.getJson<CloudPage<(typeof raw)[number]>>(
          `${AGILE}/board?projectKeyOrId=${encodeURIComponent(projectKey)}&startAt=${startAt}&maxResults=${PAGE_SIZE}`,
        );
        const values = res.values ?? [];

        raw.push(...values);

        const next = nextOffset(
          'Jira Cloud boards',
          startAt,
          res,
          values.length,
        );

        if (next === null) break;
        startAt = next;
      }
    } catch (err) {
      if (err instanceof AtlassianRequestError && err.status === 404) return [];

      throw err;
    }

    const boards: NormalizedBoard[] = [];

    for (const b of raw) {
      const boardId = String(b.id ?? '');
      let columns: NormalizedBoard['columns'];
      try {
        columns = await this.getBoardColumns(boardId);
      } catch (error) {
        if (
          !(error instanceof AtlassianRequestError) ||
          ![401, 403, 404, 410].includes(error.status)
        )
          throw error;
        boards.push({
          sourceId: boardId,
          name: b.name ?? '',
          type: b.type === 'scrum' ? 'scrum' : 'kanban',
          columns: [],
          configurationError: error.message,
        });
        continue;
      }
      const board = await this.enrichBoard({
        sourceId: boardId,
        name: b.name ?? '',
        type: b.type === 'scrum' ? 'scrum' : 'kanban',
        columns,
        ...(b.filter?.id != null ? { filterId: String(b.filter.id) } : {}),
      });

      // Cloud DOES expose the Greenhopper board-config endpoint, so WIP limits, quick filters and
      // swimlanes migrate here exactly as on Server. `enriched` distinguishes "asked and found none"
      // from "never asked".
      boards.push(board);
    }

    return boards;
  }

  /**
   * Add WIP limits, quick filters and swimlanes from the Greenhopper board edit model.
   *
   * Never throws: the endpoint is undocumented and permission-gated, so a failure leaves
   * `enriched: false` (the stage reads that as "we never asked", not "there was nothing").
   * Columns/statuses are already populated from the documented agile config in `getBoardColumns`;
   * this only layers the extras the agile API omits. Positional WIP mapping is guarded on a length
   * match so a config drift can never attach one column's limits to another.
   */
  private async enrichBoard(board: NormalizedBoard): Promise<NormalizedBoard> {
    if (!board.sourceId) return board;

    try {
      const model = await this.http.getJson<CloudEditModel>(
        `${GREENHOPPER}/rapidviewconfig/editmodel?rapidViewId=${encodeURIComponent(board.sourceId)}`,
      );
      const mapped = model.rapidListConfig?.mappedColumns ?? [];

      return {
        ...board,
        columns:
          mapped.length === board.columns.length
            ? board.columns.map((column, i) => ({
                ...column,
                minWip: mapped[i]?.min as number | undefined,
                maxWip: mapped[i]?.max as number | undefined,
                isKanbanBacklog: mapped[i]?.isKanPlanColumn === true,
              }))
            : board.columns,
        quickFilters: (model.quickFilterConfig?.quickFilters ?? [])
          .map((f) => ({
            sourceId: String(f.id ?? ''),
            name: (f.name ?? '').trim(),
            query: (f.query ?? '').trim(),
            description: f.description?.trim() || undefined,
          }))
          .filter((f) => f.name.length > 0),
        swimlaneStrategy: model.swimlanesConfig?.swimlaneStrategy,
        swimlanes: (model.swimlanesConfig?.swimlanes ?? [])
          .map((s) => ({
            sourceId: String(s.id ?? ''),
            name: (s.name ?? '').trim(),
            query: (s.query ?? '').trim(),
            description: s.description?.trim() || undefined,
            isDefault: s.isDefault === true,
          }))
          .filter((s) => s.name.length > 0),
        enriched: true,
      };
    } catch (error) {
      const reason =
        error instanceof AtlassianRequestError
          ? String(error.status)
          : 'unavailable';

      return {
        ...board,
        enriched: false,
        migrationWarnings: [
          `Jira Cloud board enrichment was unreadable (${reason}); WIP limits, quick filters, and swimlanes were not available`,
        ],
      };
    }
  }

  /** Board column config + the statuses in each column. Absent config → no columns, not an error. */
  private async getBoardColumns(
    boardId: string,
  ): Promise<NormalizedBoard['columns']> {
    try {
      const cfg = await this.http.getJson<{
        columnConfig?: {
          columns?: { name?: string; statuses?: { id?: string | number }[] }[];
        };
      }>(`${AGILE}/board/${encodeURIComponent(boardId)}/configuration`);

      return (cfg.columnConfig?.columns ?? []).map((c) => ({
        name: c.name ?? '',
        statusSourceIds: (c.statuses ?? [])
          .map((s) => (s.id != null ? String(s.id) : ''))
          .filter((s) => s.length > 0),
      }));
    } catch (err) {
      const message = `Board ${boardId} configuration could not be read: ${(err as Error).message}`;
      if (err instanceof AtlassianRequestError)
        throw new AtlassianRequestError(message, err.status);
      throw new Error(message);
    }
  }

  /** Returns [] for kanban boards (no sprints) and when the agile API is absent. */
  async getSprints(boardId: string): Promise<NormalizedSprint[]> {
    const out: NormalizedSprint[] = [];

    try {
      let startAt = 0;

      for (;;) {
        const res = await this.http.getJson<
          CloudPage<{
            id?: string | number;
            name?: string;
            goal?: string;
            state?: string;
            startDate?: string;
            endDate?: string;
            completeDate?: string;
            originBoardId?: string | number;
          }>
        >(
          `${AGILE}/board/${encodeURIComponent(boardId)}/sprint?startAt=${startAt}&maxResults=${PAGE_SIZE}`,
        );
        const values = res.values ?? [];

        for (const s of values) {
          out.push({
            sourceId: String(s.id ?? ''),
            name: s.name ?? '',
            goal: s.goal || undefined,
            state: this.sprintState(s.state),
            startDate: s.startDate,
            endDate: s.endDate,
            completeDate: s.completeDate,
            boardSourceId:
              s.originBoardId != null ? String(s.originBoardId) : boardId,
          });
        }

        const next = nextOffset(
          'Jira Cloud sprints',
          startAt,
          res,
          values.length,
        );

        if (next === null) return out;
        startAt = next;
      }
    } catch (err) {
      // 400 = kanban board (sprints unsupported); 404 = no agile API. Neither is an error.
      if (
        err instanceof AtlassianRequestError &&
        (err.status === 404 || err.status === 400)
      ) {
        return [];
      }

      throw err;
    }
  }

  private sprintState(state: string | undefined): NormalizedSprint['state'] {
    if (state === 'active') return 'active';
    if (state === 'closed') return 'closed';

    return 'future';
  }

  /** Same agile endpoint as Server; `/board/{id}/issue` returns the board's rank order. */
  async getBoardIssueIds(
    boardId: string,
    opts?: { cursor?: string | null; pageSize?: number; jql?: string | null },
  ): Promise<Page<string>> {
    const pageSize = opts?.pageSize ?? 50;
    // The job's scope filter, applied SERVER-side. Without it a scoped job pages the board's whole
    // membership to find its few in-scope issues — measured: 197 requests over ~8 minutes to card 25
    // issues out of 9,826. `stripOrderBy` because the board endpoint supplies its own rank order and
    // a second ORDER BY is invalid JQL. The board id already scopes the project, so no predicate is
    // AND-ed in here.
    const filter = opts?.jql ? stripOrderBy(opts.jql) : '';
    const jqlParam = filter ? `&jql=${encodeURIComponent(filter)}` : '';
    let startAt = Number(opts?.cursor);

    if (!Number.isFinite(startAt) || startAt < 0) startAt = 0;

    try {
      const res = await this.http.getJson<{
        issues?: { id?: string | number }[];
        total?: number;
        startAt?: number;
      }>(
        `${AGILE}/board/${encodeURIComponent(boardId)}/issue?startAt=${startAt}&maxResults=${pageSize}&fields=id${jqlParam}`,
      );
      const issues = res.issues ?? [];
      const total = typeof res.total === 'number' ? res.total : null;
      const reportedStart =
        typeof res.startAt === 'number' ? res.startAt : startAt;
      const next = reportedStart + issues.length;

      return {
        items: issues
          .map((i) => (i.id != null ? String(i.id) : ''))
          .filter((id) => id.length > 0),
        nextCursor:
          total !== null && next < total && issues.length > 0
            ? String(next)
            : null,
        total,
      };
    } catch (err) {
      if (err instanceof AtlassianRequestError && err.status === 404) {
        return { items: [], nextCursor: null, total: 0 };
      }

      throw err;
    }
  }

  /**
   * Cloud role actors carry `accountId` and usually NO email — the user mapper will place most of
   * these as linked placeholders, which is expected on Cloud rather than a failure.
   */
  async getUsersAndRoles(
    projectKey: string,
  ): Promise<{ users: NormalizedUser[]; roles: NormalizedRole[] }> {
    const roleMap = await this.requiredIdentityJson<Record<string, string>>(
      `${API}/project/${encodeURIComponent(projectKey)}/role`,
    );

    const roles: NormalizedRole[] = [];
    const usersById = new Map<string, NormalizedUser>();

    for (const url of Object.values(roleMap ?? {})) {
      if (typeof url !== 'string' || !url) continue;

      const detail = await this.requiredIdentityJson<CloudRoleDetail>(
        this.pathFromUrl(url),
      );

      const actors: NormalizedRoleActor[] = [];

      for (const actor of detail.actors ?? []) {
        const isGroup = (actor.type ?? '').includes('group');
        // A user actor is keyed by accountId on Cloud (Server uses the login name). A group actor
        // carries no accountId — key it by display name, as Server does.
        const sourceId = isGroup
          ? (actor.displayName ?? '')
          : (actor.actorUser?.accountId ?? '');

        if (!sourceId) continue;

        actors.push({
          type: isGroup ? 'group' : 'user',
          sourceId,
          name: actor.displayName ?? sourceId,
        });

        if (!isGroup && !usersById.has(sourceId)) {
          usersById.set(
            sourceId,
            this.normalizeUser({
              accountId: sourceId,
              displayName: actor.displayName,
            } as JiraRawUser),
          );
        }
      }

      roles.push({
        sourceId: String(detail.id ?? detail.name ?? ''),
        name: detail.name ?? '',
        description: detail.description || undefined,
        actors,
      });
    }

    // Cloud project roles usually list a GROUP actor (for example the "administrators" group), not
    // its individual members, so real project members are invisible to the role walk above. Merge
    // the project-assignable users so those people migrate. Verified live: BIT's members are in via
    // a group, and without this the users stage seeded ZERO users, dropping the lead and every
    // assignee/author attribution. Mirrors the Server adapter.
    await this.mergeAssignableUsers(projectKey, usersById);

    return { users: [...usersById.values()], roles };
  }

  /**
   * Project-assignable users, merged into `usersById` keyed by the same accountId role actors use.
   * Permission/read failures propagate so a dry run cannot certify an incomplete user census.
   * Never overwrites a role-derived entry.
   */
  private async mergeAssignableUsers(
    projectKey: string,
    usersById: Map<string, NormalizedUser>,
  ): Promise<void> {
    let startAt = 0;
    let previousFirstId: string | null | undefined;

    for (;;) {
      const raw = await this.requiredIdentityJson<JiraRawUser[]>(
        `${API}/user/assignable/search?project=${encodeURIComponent(projectKey)}` +
          `&startAt=${startAt}&maxResults=50`,
      );
      const batch = Array.isArray(raw) ? raw : [];

      for (const u of batch) {
        const id = this.userStableId(u);

        if (!id || usersById.has(id)) continue;

        usersById.set(id, { ...this.normalizeUser(u), sourceId: id });
      }

      if (batch.length < 50) return;

      // A site that ignores `startAt` would return the same page forever; stop instead of spinning.
      const firstId = this.userStableId(batch[0]);

      if (firstId && firstId === previousFirstId) {
        throw new Error(
          `Jira Cloud assignable-user pagination did not advance past ${startAt}`,
        );
      }

      previousFirstId = firstId;
      startAt += batch.length;
    }
  }

  /** Exact count from the same enhanced token walk used by the issue stage. */
  async countIssues(projectKey: string, jql?: string): Promise<number | null> {
    let count = 0;

    for await (const page of this.iterateIssuePages(projectKey, {
      pageSize: 100,
      fields: ['id'],
      jql,
    })) {
      count += page.issues.length;
    }

    return count;
  }

  /**
   * Token-paginated. `nextPageToken` is opaque — pass it straight back, never synthesize it. There
   * is no `total`, so `Page.total` is ALWAYS null on Cloud; the caller must not infer progress from it.
   */
  async *iterateIssues(
    projectKey: string,
    opts?: {
      cursor?: string | null;
      pageSize?: number;
      fields?: string[];
      jql?: string;
    },
  ): AsyncGenerator<Page<NormalizedIssue>> {
    for await (const page of this.iterateIssuePages(projectKey, opts)) {
      yield {
        items: page.issues.map((issue) => this.normalizeIssue(issue)),
        nextCursor: page.nextPageToken,
        // Cloud does not report a count on this endpoint — never fabricate one.
        total: null,
      };
    }
  }

  private async *iterateIssuePages(
    projectKey: string,
    opts?: {
      cursor?: string | null;
      pageSize?: number;
      fields?: string[];
      jql?: string;
    },
  ): AsyncGenerator<{ issues: JiraRawIssue[]; nextPageToken: string | null }> {
    const jql = encodeURIComponent(buildIssueJql(projectKey, opts?.jql));
    const pageSize = opts?.pageSize ?? 100;
    const fieldsParam = encodeURIComponent(
      (opts?.fields ?? ['*navigable']).join(','),
    );
    let token: string | null = opts?.cursor ?? null;
    const seen = new Set<string>();

    if (token) seen.add(token);

    for (;;) {
      const tokenParam = token
        ? `&nextPageToken=${encodeURIComponent(token)}`
        : '';
      const res = await this.http.getJson<CloudSearchResult>(
        `${API}/search/jql?jql=${jql}&maxResults=${pageSize}&fields=${fieldsParam}${tokenParam}&expand=renderedFields`,
      );
      const issues = res.issues ?? [];
      const next =
        res.isLast === false && res.nextPageToken ? res.nextPageToken : null;

      if (res.isLast === false && !next) {
        throw new Error(
          'Jira Cloud issue search reported another page without a next-page token',
        );
      }
      if (next && issues.length === 0) {
        throw new Error(
          `Jira Cloud issue search made no progress before token ${next}`,
        );
      }
      if (next && seen.has(next)) {
        throw new Error(
          `Jira Cloud issue search repeated next-page token ${next}`,
        );
      }

      yield { issues, nextPageToken: next };

      if (!next) return;

      seen.add(next);
      token = next;
    }
  }

  /** Role URLs come back absolute; reduce to a path so the client's origin pinning still applies. */
  private pathFromUrl(url: string): string {
    try {
      const parsed = new URL(url);

      return parsed.pathname + parsed.search;
    } catch {
      return url.startsWith('/') ? url : `/${url}`;
    }
  }

  /** One issue's complete, paginated Cloud changelog, oldest first. */
  async getIssueHistory(
    issueSourceId: string,
  ): Promise<NormalizedHistoryEntry[]> {
    type RawHistory = {
      id?: string | number;
      author?: JiraRawUser | null;
      created?: string;
      items?: {
        field?: string;
        fieldtype?: string;
        from?: string | null;
        to?: string | null;
        fromString?: string | null;
        toString?: string | null;
      }[];
    };
    const histories: RawHistory[] = [];
    let startAt = 0;

    for (;;) {
      const raw = await this.http.getJson<{
        startAt?: number;
        total?: number;
        isLast?: boolean;
        values?: RawHistory[];
        changelog?: { histories?: RawHistory[] };
      }>(
        `${API}/issue/${encodeURIComponent(issueSourceId)}/changelog` +
          `?startAt=${startAt}&maxResults=100`,
      );
      const values = raw.values ?? raw.changelog?.histories ?? [];

      histories.push(...values);

      const reported = typeof raw.startAt === 'number' ? raw.startAt : startAt;
      const next = reported + values.length;
      const done =
        raw.isLast !== false &&
        (typeof raw.total !== 'number' || next >= raw.total);

      if (done) break;
      if (values.length === 0) {
        throw new Error(
          `Jira Cloud changelog pagination made no progress at offset ${startAt}`,
        );
      }
      if (next <= startAt) {
        throw new Error(
          `Jira Cloud changelog pagination did not advance past ${startAt}`,
        );
      }

      startAt = next;
    }

    return histories.map((h) => ({
      sourceId: String(h.id ?? ''),
      authorSourceId: this.userStableId(h.author),
      created: h.created,
      items: (h.items ?? []).map((i) => ({
        field: i.field ?? '',
        fieldType: i.fieldtype,
        from: i.from ?? null,
        to: i.to ?? null,
        fromString: i.fromString ?? null,
        toString: i.toString ?? null,
      })),
    }));
  }

  /**
   * Cloud's screens API is paginated (`/screens` returns `values[]`, not `screens[]`) and its tab
   * fields live at the same sub-paths. Structure is otherwise identical to Server.
   *
   * Cloud may hide screen configuration from otherwise migration-capable users. That documented
   * metadata gap uses the stage's existing catch-all field group and records an audit warning;
   * every other failure still propagates.
   */
  async getScreens(projectKey: string): Promise<NormalizedScreen[]> {
    try {
      const screens: { id?: number | string; name?: string }[] = [];
      let startAt = 0;

      for (;;) {
        const res = await this.http.getJson<
          CloudPage<(typeof screens)[number]>
        >(`${API}/screens?startAt=${startAt}&maxResults=100`);
        const values = res.values ?? [];

        screens.push(...values);

        const next = nextOffset(
          'Jira Cloud screens',
          startAt,
          res,
          values.length,
        );

        if (next === null) break;
        startAt = next;
      }

      const prefix = `${projectKey.toUpperCase()}:`;
      const mine = screens.filter((s) =>
        (s.name ?? '').toUpperCase().startsWith(prefix),
      );
      const out: NormalizedScreen[] = [];

      for (const screen of mine) {
        const screenId = String(screen.id ?? '');

        if (!screenId) continue;

        const tabs = await this.http.getJson<
          { id?: number | string; name?: string }[]
        >(`${API}/screens/${encodeURIComponent(screenId)}/tabs`);
        const normalizedTabs: NormalizedScreenTab[] = [];

        for (const tab of tabs ?? []) {
          const tabId = String(tab.id ?? '');

          if (!tabId) continue;

          const fields = await this.http.getJson<{ id?: string }[]>(
            `${API}/screens/${encodeURIComponent(screenId)}/tabs/${encodeURIComponent(tabId)}/fields`,
          );

          normalizedTabs.push({
            sourceId: tabId,
            name: tab.name ?? 'Fields',
            fieldSourceIds: (fields ?? [])
              .map((f) => String(f.id ?? ''))
              .filter((id) => id.length > 0),
          });
        }

        out.push({
          sourceId: screenId,
          name: screen.name ?? screenId,
          tabs: normalizedTabs,
        });
      }

      return out;
    } catch (error) {
      if (
        error instanceof AtlassianRequestError &&
        (error.status === 403 || error.status === 404)
      ) {
        return [
          {
            sourceId: `cloud-screen-fallback:${projectKey}`,
            name: `${projectKey} screen layout fallback`,
            tabs: [],
            migrationWarnings: [
              `Jira Cloud screen layout was unreadable (${error.status}); custom fields use one fallback group`,
            ],
          },
        ];
      }

      throw error;
    }
  }

  /**
   * Cloud's field search (`/field/search?expand=projectsCount`) reports COUNTS, not project ids,
   * so global-ness cannot be proven here. Empty map = "never promote on ambiguity": every field
   * stays space-scoped, exactly the pre-existing behaviour.
   */
  getCustomFieldContexts(): Promise<Map<string, string[]>> {
    return Promise.resolve(new Map<string, string[]>());
  }

  async listGroups(): Promise<NormalizedGroup[]> {
    const groups: { name?: string; groupId?: string }[] = [];
    let startAt = 0;

    for (;;) {
      const res = await this.http.getJson<CloudPage<(typeof groups)[number]>>(
        `${API}/group/bulk?startAt=${startAt}&maxResults=100`,
      );
      const values = res.values ?? [];

      groups.push(...values);

      const next = nextOffset('Jira Cloud groups', startAt, res, values.length);

      if (next === null) break;
      startAt = next;
    }

    return groups
      .map((g) => ({
        sourceId: (g.groupId ?? g.name ?? '').trim(),
        name: (g.name ?? '').trim(),
      }))
      .filter((g) => g.sourceId.length > 0 && g.name.length > 0);
  }

  /** Cloud group members, keyed by the stable groupId returned by `group/bulk`. */
  async getGroupMembers(
    groupSourceId: string,
    opts?: { cursor?: string | null; pageSize?: number },
  ): Promise<Page<NormalizedUser>> {
    const startAt = Number(opts?.cursor ?? '0') || 0;
    const pageSize = opts?.pageSize ?? 50;

    const res = await this.http.getJson<{
      values?: JiraRawUser[];
      isLast?: boolean;
      total?: number;
    }>(
      `${API}/group/member?groupId=${encodeURIComponent(groupSourceId)}` +
        `&includeInactiveUsers=false&startAt=${startAt}&maxResults=${pageSize}`,
    );
    const items = (res.values ?? []).map((u) => this.normalizeUser(u));
    const isLast = res.isLast !== false;

    if (!isLast && items.length === 0) {
      throw new Error(
        `Jira Cloud group member pagination made no progress at offset ${startAt}`,
      );
    }

    return {
      items,
      nextCursor: isLast ? null : String(startAt + items.length),
      total: typeof res.total === 'number' ? res.total : null,
    };
  }

  /** Global, unpaginated resolutions. Permission/read failures remain visible. */
  async getResolutions(): Promise<NormalizedResolution[]> {
    const res = await this.http.getJson<
      { id?: string | number; name?: string; description?: string }[]
    >(`${API}/resolution`);

    return (res ?? [])
      .map((r, index) => ({
        sourceId: String(r.id ?? ''),
        name: (r.name ?? '').trim(),
        description: r.description?.trim() || undefined,
        sortOrder: index,
      }))
      .filter((r) => r.sourceId.length > 0 && r.name.length > 0);
  }

  /** Global issue-link types including both directional labels. */
  async getIssueLinkTypes(): Promise<NormalizedLinkType[]> {
    const res = await this.http.getJson<{
      issueLinkTypes?: {
        id?: string | number;
        name?: string;
        inward?: string;
        outward?: string;
      }[];
    }>(`${API}/issueLinkType`);

    return (res.issueLinkTypes ?? [])
      .map((t) => ({
        sourceId: String(t.id ?? ''),
        name: (t.name ?? '').trim(),
        outward: (t.outward ?? '').trim(),
        inward: (t.inward ?? '').trim(),
      }))
      .filter((t) => t.name.length > 0);
  }

  /**
   * One page of an issue's comments from the per-issue resource, which pages to the TRUE total —
   * unlike `fields.comment` in a search response, which Jira caps.
   *
   * No `expand=renderedBody` here, unlike Server: Cloud v3 bodies are ADF objects, which `toRawBody`
   * tags `format: 'adf'` and the transformer walks structurally. Asking for rendered HTML would add
   * a fallback the ADF path never consults.
   */
  async getIssueComments(
    issueSourceId: string,
    opts?: { cursor?: string | null; pageSize?: number },
  ): Promise<Page<NormalizedComment>> {
    const pageSize = opts?.pageSize ?? PAGE_SIZE;
    let startAt = Number(opts?.cursor);

    if (!Number.isFinite(startAt) || startAt < 0) startAt = 0;

    const res = await this.http.getJson<{
      comments?: JiraRawComment[];
      total?: number;
      startAt?: number;
    }>(
      `${API}/issue/${encodeURIComponent(issueSourceId)}/comment` +
        `?startAt=${startAt}&maxResults=${pageSize}`,
    );
    const comments = res.comments ?? [];
    const total = typeof res.total === 'number' ? res.total : null;
    const reportedStart =
      typeof res.startAt === 'number' ? res.startAt : startAt;
    const next = reportedStart + comments.length;

    return {
      items: comments.map((c) => ({
        sourceId: String(c.id ?? ''),
        authorSourceId: this.userStableId(c.author),
        body: this.toRawBody(c.body) ?? { format: 'wiki', value: '' },
        created: c.created,
        updated: c.updated,
      })),
      // A page that returns nothing must terminate even if `total` disagrees — trusting a total the
      // server never satisfies would page forever.
      nextCursor:
        comments.length > 0 && total !== null && next < total
          ? String(next)
          : null,
      total,
    };
  }
}
