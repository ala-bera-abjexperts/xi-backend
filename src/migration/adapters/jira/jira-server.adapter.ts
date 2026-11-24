/**
 * @fileoverview Jira Server/DC adapter (REST v2). Wiki-markup bodies, `key`/`name` users.
 *
 * Phase 1 read surface: projects, issue types, createmeta fields (classic with Jira 9
 * fallback), statuses, workflows (names only — the public REST exposes no transition
 * graph), agile boards/sprints (degrade to [] on Jira Core), users+roles (best-effort
 * email enrichment), and offset-paginated resumable issue iteration.
 *
 * Everything here is read-only: zero Supabase calls, zero writes to the source.
 */

import type {
  NormalizedBoard,
  NormalizedComment,
  NormalizedField,
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
import { parseProjectConfigWorkflow } from '../../mappers/jira-workflow-graph.util';
import { buildIssueJql, stripOrderBy } from './issue-jql';
import {
  JiraAdapterBase,
  RequiredJiraIdentityError,
} from './jira-adapter.base';

const API = '/rest/api/2';
const AGILE = '/rest/agile/1.0';
/**
 * Jira Software's internal board-configuration API. Undocumented and SERVER/DC ONLY (Jira Cloud has
 * no equivalent), but it is the only endpoint that reports WIP limits, the Kanban backlog column,
 * per-status done-ness, quick filters and swimlanes. Every call through it is best-effort.
 */
const GREENHOPPER = '/rest/greenhopper/1.0';

/** Hard cap on agile pagination loops — defensive against servers that never report isLast. */
const MAX_AGILE_PAGES = 10;
const MAX_SPRINT_PAGES = 100;

/** Concurrency bound for per-role / per-user detail fetches. */
const DETAIL_CHUNK_SIZE = 3;

interface JiraRawAgileBoard {
  id?: string | number;
  name?: string;
  type?: string;
}

interface JiraRawAgilePage<T> {
  values?: T[];
  isLast?: boolean;
  startAt?: number;
  maxResults?: number;
}

interface JiraRawBoardConfig {
  columnConfig?: {
    columns?: { name?: string; statuses?: { id?: string | number }[] }[];
  };
  ranking?: { rankCustomFieldId?: string | number };
  filter?: { id?: string | number };
}

/**
 * The Greenhopper board-config response, typed defensively.
 *
 * Every field is optional and the WIP scalars are deliberately `unknown`: this endpoint is
 * undocumented and inconsistent across versions, reporting an unset limit as `""`, `null` or `-1`.
 * Narrowing happens in `board-column.builder.ts`, where it is unit-tested.
 */
interface JiraRawEditModel {
  rapidListConfig?: {
    mappedColumns?: {
      id?: number | string;
      name?: string;
      min?: unknown;
      max?: unknown;
      isKanPlanColumn?: boolean;
      mappedStatuses?: {
        id?: number | string;
        name?: string;
        statusCategory?: { id?: string; key?: string; colorName?: string };
        isResolutionDone?: boolean;
      }[];
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

interface JiraRawSprint {
  id?: string | number;
  name?: string;
  goal?: string;
  state?: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  originBoardId?: string | number;
}

interface JiraRawWorkflow {
  name?: string;
  description?: string;
  default?: boolean;
}

interface JiraRawWorkflowSchemeMapping {
  name?: string;
  issueTypes?: (string | number)[];
  default?: boolean;
  defaultMapping?: boolean;
}

interface JiraRawRoleActor {
  type?: string;
  name?: string;
  displayName?: string;
}

interface JiraRawRole {
  id?: string | number;
  name?: string;
  description?: string;
  actors?: JiraRawRoleActor[];
}

interface JiraRawSearchResult {
  startAt?: number;
  maxResults?: number;
  total?: number;
  issues?: JiraRawIssue[];
}

export class JiraServerAdapter
  extends JiraAdapterBase
  implements IJiraSourceAdapter
{
  constructor(http: AtlassianHttpClient) {
    super(http, '2', 'server');
  }

  async getIssueWatchers(issueIdOrKey: string) {
    const raw = await this.http.getJson<JiraRawWatcherList>(
      `${API}/issue/${encodeURIComponent(issueIdOrKey)}/watchers`,
    );

    return this.normalizeWatcherList(raw, (user) => {
      for (const candidate of [user.key, user.name, user.username]) {
        const id = candidate == null ? '' : String(candidate).trim();
        if (id) return id;
      }
      return undefined;
    });
  }

  async listProjects(): Promise<NormalizedProject[]> {
    const raw = await this.http.getJson<JiraRawProject[]>(`${API}/project`);

    return (Array.isArray(raw) ? raw : []).map((p) => this.normalizeProject(p));
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

  async getFieldsForIssueType(
    projectKey: string,
    issueTypeId: string,
  ): Promise<NormalizedField[]> {
    const key = encodeURIComponent(projectKey);
    const typeId = encodeURIComponent(issueTypeId);
    let fields: NormalizedField[];

    try {
      // Classic createmeta (Jira ≤ 8.x): fields arrive as an object keyed by field id.
      const res = await this.http.getJson<{
        projects?: {
          issuetypes?: { fields?: Record<string, JiraRawFieldMeta> }[];
        }[];
      }>(
        `${API}/issue/createmeta?projectKeys=${key}&issuetypeIds=${typeId}&expand=projects.issuetypes.fields`,
      );
      const fieldMap = res.projects?.[0]?.issuetypes?.[0]?.fields ?? {};

      fields = Object.entries(fieldMap).map(([fieldId, meta]) =>
        this.normalizeField(meta, fieldId),
      );
    } catch (err) {
      // Jira 9 removed classic createmeta (404) — use the per-issue-type endpoint.
      if (!(err instanceof AtlassianRequestError) || err.status !== 404) {
        throw err;
      }

      const res = await this.http.getJson<{ values?: JiraRawFieldMeta[] }>(
        `${API}/issue/createmeta/${key}/issuetypes/${typeId}?maxResults=200`,
      );

      fields = (res.values ?? []).map((meta) => this.normalizeField(meta));
    }

    return fields.map((f) => ({ ...f, issueTypeSourceIds: [issueTypeId] }));
  }

  async getStatuses(projectKey: string): Promise<NormalizedStatus[]> {
    const raw = await this.http.getJson<
      { id?: string | number; statuses?: JiraRawStatus[] }[]
    >(`${API}/project/${encodeURIComponent(projectKey)}/statuses`);

    // The endpoint repeats statuses per issue type — dedupe by status sourceId,
    // unioning issueTypeSourceIds across issue types.
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

  // GET /rest/api/2/priority — global, unpaginated, in server rank order.
  async getPriorities(): Promise<NormalizedPriority[]> {
    const raw = await this.http.getJson<JiraRawPriority[]>(`${API}/priority`);

    return (Array.isArray(raw) ? raw : []).map((p, idx) =>
      this.normalizePriority(p, idx),
    );
  }

  /**
   * Best-effort workflow discovery. `/rest/api/2/workflow` lists workflow names (admin-only
   * on some instances); `/rest/projectconfig/1/workflowscheme/{key}` is an INTERNAL endpoint
   * that maps workflows to issue types — any failure degrades to a single default entry.
   * `transitions` is always null on Server: the public REST exposes no transition graph.
   */
  async getWorkflows(projectKey: string): Promise<NormalizedWorkflow[]> {
    let workflows: JiraRawWorkflow[] = [];

    try {
      const all = await this.http.getJson<JiraRawWorkflow[]>(`${API}/workflow`);

      workflows = Array.isArray(all) ? all : [];
    } catch (err) {
      this.logger.warn(
        `GET ${API}/workflow failed (non-admin?): ${(err as Error).message}`,
      );
    }

    try {
      const scheme = await this.http.getJson<{
        mappings?: JiraRawWorkflowSchemeMapping[];
      }>(
        `/rest/projectconfig/1/workflowscheme/${encodeURIComponent(projectKey)}`,
      );
      const mappings = Array.isArray(scheme.mappings) ? scheme.mappings : [];

      if (mappings.length === 0) return this.defaultWorkflowEntry(workflows);

      const out: NormalizedWorkflow[] = [];

      for (const mapping of mappings) {
        const name = mapping.name ?? 'default';
        const known = workflows.find((w) => w.name === name);
        const graph = await this.getWorkflowGraph(name);

        out.push({
          sourceId: name,
          name,
          description: known?.description || undefined,
          // The graph's status set when readable (authoritative: every status the workflow
          // mentions, including disconnected ones); otherwise [] and callers resolve it from
          // getStatuses as before.
          statusSourceIds: graph?.statusSourceIds ?? [],
          transitions: graph?.transitions ?? null,
          issueTypeSourceIds: mapping.issueTypes?.map(String) ?? ['*'],
          isDefault:
            mapping.default === true || mapping.defaultMapping === true,
          ...(graph?.initialStatusSourceId
            ? { initialStatusSourceId: graph.initialStatusSourceId }
            : {}),
          ...(graph && Object.keys(graph.screensByTransition).length > 0
            ? { screensByTransition: graph.screensByTransition }
            : {}),
        });
      }

      return out;
    } catch {
      return this.defaultWorkflowEntry(workflows);
    }
  }

  private defaultWorkflowEntry(
    workflows: JiraRawWorkflow[],
  ): NormalizedWorkflow[] {
    const def = workflows.find((w) => w.default === true) ?? workflows[0];
    const name = def?.name ?? 'default';

    return [
      {
        sourceId: name,
        name,
        description: def?.description || undefined,
        statusSourceIds: [],
        transitions: null,
        issueTypeSourceIds: ['*'],
        isDefault: true,
      },
    ];
  }

  async getBoards(projectKey: string): Promise<NormalizedBoard[]> {
    const rawBoards: JiraRawAgileBoard[] = [];

    try {
      let startAt = 0;

      for (let page = 0; page < MAX_AGILE_PAGES; page++) {
        const res = await this.http.getJson<
          JiraRawAgilePage<JiraRawAgileBoard>
        >(
          `${AGILE}/board?projectKeyOrId=${encodeURIComponent(projectKey)}&startAt=${startAt}&maxResults=50`,
        );
        const values = res.values ?? [];

        rawBoards.push(...values);

        if (res.isLast !== false || values.length === 0) break;

        startAt += values.length;
      }
    } catch (err) {
      // Jira Core without Jira Software: the agile API is absent (404) — no boards, not an error.
      if (err instanceof AtlassianRequestError && err.status === 404) return [];

      throw err;
    }

    const boards: NormalizedBoard[] = [];

    for (const raw of rawBoards) {
      const board: NormalizedBoard = {
        sourceId: String(raw.id ?? ''),
        name: raw.name ?? '',
        type: raw.type === 'scrum' ? 'scrum' : 'kanban',
        columns: [],
      };

      try {
        const cfg = await this.http.getJson<JiraRawBoardConfig>(
          `${AGILE}/board/${encodeURIComponent(board.sourceId)}/configuration`,
        );

        board.columns = (cfg.columnConfig?.columns ?? []).map((column) => ({
          name: column.name ?? '',
          statusSourceIds: (column.statuses ?? []).map((s) =>
            String(s.id ?? ''),
          ),
        }));

        const rankFieldId = String(cfg.ranking?.rankCustomFieldId ?? '');

        if (rankFieldId) board.rankFieldId = rankFieldId;

        const filterId = String(cfg.filter?.id ?? '');

        if (filterId) board.filterId = filterId;
      } catch (err) {
        const message = `Board ${board.sourceId} configuration could not be read: ${(err as Error).message}`;
        if (
          !(err instanceof AtlassianRequestError) ||
          ![401, 403, 404, 410].includes(err.status)
        )
          throw err;
        boards.push({ ...board, configurationError: message });
        continue;
      }

      // Enrichment only, and strictly AFTER the agile call above. Never a replacement for it: see
      // `enrichBoard` for why column identity must keep coming from the agile response.
      await this.enrichBoard(board);

      boards.push(board);
    }

    return boards;
  }

  /**
   * Add WIP limits, the Kanban backlog flag, done-ness evidence, quick filters and swimlanes to a
   * board already built from the agile API.
   *
   * `/rest/agile/1.0/board/{id}/configuration` reports none of these. The Greenhopper board-config
   * endpoint reports all of them in one 110 KB response, which is why a single extra call closes
   * four gaps at once.
   *
   * ENRICHMENT ONLY. Column identity, ordering and status mappings keep coming from the agile
   * response, and the Greenhopper columns are matched to them BY INDEX. Re-keying the columns off
   * Greenhopper would risk changing which statuses land in which column, and a card silently
   * appearing in the wrong column is a far worse failure than a missing WIP limit. When the two
   * lists disagree in length the enrichment is abandoned wholesale rather than applied by guess.
   *
   * Never throws: this endpoint is undocumented, Server-only, and permission-gated. A failure leaves
   * `enriched: false`, which the stage reads as "we never asked" rather than "there was nothing".
   */
  private async enrichBoard(board: NormalizedBoard): Promise<void> {
    if (!board.sourceId) return;

    try {
      const model = await this.http.getJson<JiraRawEditModel>(
        `${GREENHOPPER}/rapidviewconfig/editmodel?rapidViewId=${encodeURIComponent(board.sourceId)}`,
      );
      const mapped = model.rapidListConfig?.mappedColumns ?? [];

      if (mapped.length === board.columns.length) {
        board.columns = board.columns.map((column, i) => {
          const extra = mapped[i];

          return {
            ...column,
            minWip: extra?.min as number | undefined,
            maxWip: extra?.max as number | undefined,
            isKanbanBacklog: extra?.isKanPlanColumn === true,
            statuses: (extra?.mappedStatuses ?? []).map((s) => ({
              sourceId: String(s.id ?? ''),
              name: s.name,
              categoryKey: s.statusCategory?.key,
              isResolutionDone: s.isResolutionDone,
            })),
          };
        });
      } else if (mapped.length > 0) {
        this.logger.warn(
          `Board ${board.sourceId}: board config reported ${mapped.length} columns but the agile ` +
            `API reported ${board.columns.length}; skipping enrichment rather than mismatching them`,
        );
      }

      board.quickFilters = (model.quickFilterConfig?.quickFilters ?? [])
        .map((f) => ({
          sourceId: String(f.id ?? ''),
          name: (f.name ?? '').trim(),
          query: (f.query ?? '').trim(),
          description: f.description?.trim() || undefined,
        }))
        .filter((f) => f.name.length > 0);

      board.swimlaneStrategy = model.swimlanesConfig?.swimlaneStrategy;
      board.swimlanes = (model.swimlanesConfig?.swimlanes ?? [])
        .map((s) => ({
          sourceId: String(s.id ?? ''),
          name: (s.name ?? '').trim(),
          query: (s.query ?? '').trim(),
          description: s.description?.trim() || undefined,
          isDefault: s.isDefault === true,
        }))
        .filter((s) => s.name.length > 0);

      board.enriched = true;
    } catch (err) {
      board.enriched = false;
      this.logger.warn(
        `Board ${board.sourceId} config enrichment unavailable (WIP limits, Kanban backlog, ` +
          `quick filters and swimlanes will not migrate): ${(err as Error).message}`,
      );
    }
  }

  async getSprints(boardId: string): Promise<NormalizedSprint[]> {
    const sprints: NormalizedSprint[] = [];

    try {
      let startAt = 0;

      for (let page = 0; page < MAX_SPRINT_PAGES; page++) {
        const res = await this.http.getJson<JiraRawAgilePage<JiraRawSprint>>(
          `${AGILE}/board/${encodeURIComponent(boardId)}/sprint?startAt=${startAt}&maxResults=50`,
        );
        const values = res.values ?? [];

        for (const raw of values) {
          sprints.push({
            sourceId: String(raw.id ?? ''),
            name: raw.name ?? '',
            goal: raw.goal || undefined,
            state:
              raw.state === 'future'
                ? 'future'
                : raw.state === 'active'
                  ? 'active'
                  : 'closed',
            startDate: raw.startDate,
            endDate: raw.endDate,
            completeDate: raw.completeDate,
            boardSourceId:
              raw.originBoardId != null ? String(raw.originBoardId) : boardId,
          });
        }

        if (res.isLast !== false || values.length === 0) break;

        startAt += values.length;
      }
    } catch (err) {
      // 404: agile API absent (Jira Core). 400: kanban boards reject sprint requests.
      if (
        err instanceof AtlassianRequestError &&
        (err.status === 404 || err.status === 400)
      ) {
        return [];
      }

      throw err;
    }

    return sprints;
  }

  /**
   * Issue ids on a board in RANK ORDER, paged. `/board/{id}/issue` returns the board's own ordering,
   * which is the backlog rank — the thing users actually arranged. Fields are stripped to `id`
   * because only membership + order matter here; the issues themselves were migrated by the issues
   * stage.
   */
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
      // No agile API (Jira Core) — the board does not exist, so it has no issues.
      if (err instanceof AtlassianRequestError && err.status === 404) {
        return { items: [], nextCursor: null, total: 0 };
      }

      throw err;
    }
  }

  async getUsersAndRoles(
    projectKey: string,
  ): Promise<{ users: NormalizedUser[]; roles: NormalizedRole[] }> {
    const roleMap = await this.requiredIdentityJson<Record<string, string>>(
      `${API}/project/${encodeURIComponent(projectKey)}/role`,
    );

    const roleUrls = Object.values(roleMap ?? {}).filter(
      (url): url is string => typeof url === 'string' && url.length > 0,
    );
    const roles: NormalizedRole[] = [];

    for (let i = 0; i < roleUrls.length; i += DETAIL_CHUNK_SIZE) {
      const chunk = roleUrls.slice(i, i + DETAIL_CHUNK_SIZE);
      const results = await Promise.all(
        chunk.map(async (url) => {
          try {
            return await this.requiredIdentityJson<JiraRawRole>(
              this.pathFromUrl(url),
            );
          } catch (err) {
            if (err instanceof RequiredJiraIdentityError) throw err;
            this.logger.warn(
              `Role fetch failed for ${url}: ${(err as Error).message}`,
            );

            return null;
          }
        }),
      );

      for (const raw of results) {
        if (!raw) continue;

        roles.push({
          sourceId: String(raw.id ?? ''),
          name: raw.name ?? '',
          description: raw.description || undefined,
          actors: (raw.actors ?? []).map((actor) => ({
            type: (actor.type ?? '').includes('group') ? 'group' : 'user',
            sourceId: actor.name ?? '',
            name: actor.displayName ?? actor.name ?? '',
          })),
        });
      }
    }

    // Distinct user stubs across all roles; group actors carry no user identity.
    const usersById = new Map<string, NormalizedUser>();

    for (const role of roles) {
      for (const actor of role.actors) {
        if (actor.type !== 'user' || !actor.sourceId) continue;
        if (usersById.has(actor.sourceId)) continue;

        usersById.set(actor.sourceId, {
          sourceType: 'jira',
          sourceId: actor.sourceId,
          displayName: actor.name || actor.sourceId,
          active: true,
        });
      }
    }

    // Best-effort email enrichment — user mapping (Phase 3) matches by email.
    const usernames = [...usersById.keys()];
    // Counted, not silent. Jira Server omits `emailAddress` unless the connection account holds
    // *Browse users* AND the instance's email visibility is not masked. When it does, EVERY user
    // falls to a placeholder and the run still reports success — which is exactly how a customer
    // ended up with 50 of 50 users unmapped, no project lead and no group members, with nothing in
    // the log to explain it.
    let detailDenied = 0;

    for (let i = 0; i < usernames.length; i += DETAIL_CHUNK_SIZE) {
      const chunk = usernames.slice(i, i + DETAIL_CHUNK_SIZE);

      await Promise.all(
        chunk.map(async (username) => {
          try {
            const raw = await this.requiredIdentityJson<JiraRawUser>(
              `${API}/user?username=${encodeURIComponent(username)}`,
            );

            // Keep the stub's sourceId — that's what role actors reference.
            usersById.set(username, {
              ...this.normalizeUser(raw),
              sourceId: username,
            });
          } catch (err) {
            if (err instanceof RequiredJiraIdentityError) throw err;
            // 404 (no browse-users permission / deleted user) — keep the stub.
            detailDenied++;
          }
        }),
      );
    }

    if (detailDenied > 0) {
      this.logger.warn(
        `users: ${detailDenied} of ${usernames.length} source users returned no detail (403/404). ` +
          'If this is the whole set, the connection account most likely lacks the "Browse users" ' +
          'global permission, so no email is available and every user becomes a placeholder.',
      );
    }

    // 🔴 Role actors are NOT the project's user list. On this instance the only role
    // (Administrators) holds a single GROUP actor (`jira-administrators`), and Jira Server does not
    // expand group membership through the role API — so role-derived users came back EMPTY while the
    // project demonstrably has a user (every issue is reported by christian.kienzl). The result was a
    // migration that mapped zero users: the space lost its lead and every task lost its reporter.
    //
    // The assignable-user search is the project's REAL roster, group memberships already resolved.
    // Merged in rather than replacing role actors: roles still drive space-role membership, and a
    // user can be a role actor without being assignable.
    await this.mergeAssignableUsers(projectKey, usersById);

    return { users: [...usersById.values()], roles };
  }

  /**
   * Project-assignable users, merged into `usersById` keyed by the same stable id role actors use
   * (`name` on Server). Authorization failures stop the required identity census.
   */
  private async mergeAssignableUsers(
    projectKey: string,
    usersById: Map<string, NormalizedUser>,
  ): Promise<void> {
    try {
      let startAt = 0;

      for (let page = 0; page < MAX_AGILE_PAGES; page++) {
        const raw = await this.requiredIdentityJson<JiraRawUser[]>(
          `${API}/user/assignable/search?project=${encodeURIComponent(projectKey)}` +
            `&startAt=${startAt}&maxResults=50`,
        );
        const batch = Array.isArray(raw) ? raw : [];

        for (const u of batch) {
          const id = this.userStableId(u);

          // Never overwrite a role-derived entry: it already carries the id role actors reference.
          if (!id || usersById.has(id)) continue;

          usersById.set(id, { ...this.normalizeUser(u), sourceId: id });
        }

        if (batch.length < 50) break;

        startAt += batch.length;
      }
    } catch (err) {
      if (err instanceof RequiredJiraIdentityError) throw err;
      this.logger.warn(
        `assignable-user search failed for ${projectKey} (no browse-users permission?): ${(err as Error).message}`,
      );
    }
  }

  async countIssues(projectKey: string, jql?: string): Promise<number | null> {
    // Same composition as iterateIssues — a filtered run must reconcile against the filtered set.
    const composed = encodeURIComponent(buildIssueJql(projectKey, jql));
    const res = await this.http.getJson<{ total?: unknown }>(
      `${API}/search?jql=${composed}&maxResults=0`,
    );

    return typeof res.total === 'number' ? res.total : null;
  }

  async *iterateIssues(
    projectKey: string,
    opts?: {
      cursor?: string | null;
      pageSize?: number;
      fields?: string[];
      jql?: string;
    },
  ): AsyncGenerator<Page<NormalizedIssue>> {
    // The admin's filter can only NARROW this project, and ordering is forced stable — offset paging
    // over an unordered result set silently duplicates and drops issues.
    const jql = encodeURIComponent(buildIssueJql(projectKey, opts?.jql));
    let pageSize = opts?.pageSize ?? 100;
    const fieldsParam = encodeURIComponent(
      (opts?.fields ?? ['*navigable']).join(','),
    );

    let startAt = Number(opts?.cursor);

    if (!Number.isFinite(startAt) || startAt < 0) startAt = 0;

    while (true) {
      let res: JiraRawSearchResult;

      try {
        res = await this.http.getJson<JiraRawSearchResult>(
          `${API}/search?jql=${jql}&startAt=${startAt}&maxResults=${pageSize}&fields=${fieldsParam}&expand=renderedFields`,
        );
      } catch (err) {
        // A large result page can overload Jira or an intervening proxy even when a smaller page
        // succeeds. Retry the same checkpoint only; falling through at one item keeps a bad source
        // record visible to the queue instead of silently skipping it.
        if (
          err instanceof AtlassianRequestError &&
          err.status >= 500 &&
          err.status < 600 &&
          pageSize > 1
        ) {
          pageSize = Math.max(1, Math.floor(pageSize / 2));
          this.logger.warn(
            `Issue search failed at cursor ${startAt}; retrying with maxResults=${pageSize}`,
          );
          continue;
        }

        throw err;
      }
      const issues = res.issues ?? [];
      const total = typeof res.total === 'number' ? res.total : null;

      // Advance by what the server actually returned — it may clamp maxResults
      // below the requested page size (jira.search.views.default.max).
      const reportedStart =
        typeof res.startAt === 'number' ? res.startAt : startAt;
      const next = reportedStart + issues.length;
      const nextCursor =
        total !== null && next < total && issues.length > 0
          ? String(next)
          : null;

      yield {
        items: issues.map((issue) => this.normalizeIssue(issue)),
        nextCursor,
        total,
      };

      if (nextCursor === null) break;

      startAt = next;
    }
  }

  /** Role URLs come back absolute — keep only the path (+query) so requests stay pinned to our origin. */
  private pathFromUrl(url: string): string {
    try {
      const parsed = new URL(url);

      return parsed.pathname + parsed.search;
    } catch {
      return url.startsWith('/') ? url : `/${url}`;
    }
  }

  /**
   * One issue's changelog, oldest first. Server 8.22 has no paged `/issue/{id}/changelog`
   * (404 verified), so the whole history comes from `expand=changelog` on the issue itself, which
   * returns the complete set rather than the capped slice a search response carries.
   */
  async getIssueHistory(
    issueSourceId: string,
  ): Promise<NormalizedHistoryEntry[]> {
    const raw = await this.http.getJson<{
      changelog?: {
        histories?: {
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
        }[];
      };
    }>(
      `${API}/issue/${encodeURIComponent(issueSourceId)}?expand=changelog&fields=summary`,
    );

    return (raw.changelog?.histories ?? []).map((h) => ({
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
   * The project's screens and their tabs, read from the real screen REST surface.
   *
   * Screens are not project-scoped in the API, so they are selected by Jira's own naming
   * convention for project-created screens ("SDP: Scrum Default Issue Screen"). A name match is a
   * heuristic, so callers intersect the returned fields with what the project actually migrates —
   * a tab contributing no migrated field is simply ignored downstream.
   *
   * Never throws: screens require admin rights that a migration user may not hold, and losing the
   * grouping must not fail a run that is otherwise fine.
   */
  async getScreens(projectKey: string): Promise<NormalizedScreen[]> {
    try {
      const res = await this.http.getJson<{
        screens?: { id?: number | string; name?: string }[];
      }>(`${API}/screens?startAt=0&maxResults=200`);
      const prefix = `${projectKey.toUpperCase()}:`;
      const mine = (res.screens ?? []).filter((s) =>
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
    } catch (err) {
      this.logger.warn(
        `getScreens("${projectKey}") failed, field groups fall back to a single group: ${(err as Error).message}`,
      );

      return [];
    }
  }

  /**
   * The instance's issue link types, both directional labels included.
   *
   * Global and unpaginated: `/rest/api/2/issueLinkType` returns every type in one response, so the
   * links stage can fetch this once and create any type it cannot match to an existing
   * `relation_types` row.
   *
   * Returns [] rather than throwing: the stage's match-then-fall-back ladder still works without
   * it, so an unreadable list must not cost the links.
   */

  /**
   * The instance's resolutions, in configured order.
   *
   * Global and unpaginated: `v2/resolution` returns every resolution in one array. Returns []
   * rather than throwing — an unreadable list means issues arrive without `resolution_id`, which is
   * the pre-existing behaviour, not a failure.
   */

  /**
   * Field sourceId → covered project ids, from the admin fields resource.
   *
   * `/rest/api/2/customFields` (paged) is the only Server endpoint that reports a field's CONTEXT
   * scope; createmeta never does. An empty `projectIds` on a returned row means the field's context
   * is GLOBAL. The whole map degrades to empty on any failure — the endpoint needs admin rights,
   * and a connection without them must keep today's space-scoped behaviour, not break.
   */
  async getCustomFieldContexts(): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();

    try {
      let startAt = 0;

      for (let page = 0; page < MAX_AGILE_PAGES; page++) {
        const res = await this.http.getJson<{
          values?: {
            id?: string | number;
            projectIds?: (string | number)[];
          }[];
          isLast?: boolean;
          total?: number;
        }>(`${API}/customFields?startAt=${startAt}&maxResults=50`);
        const values = res.values ?? [];

        for (const field of values) {
          const id = field.id != null ? String(field.id) : '';

          if (!id) continue;

          const key = id.startsWith('customfield_') ? id : `customfield_${id}`;

          out.set(key, (field.projectIds ?? []).map(String));
        }

        if (res.isLast !== false || values.length === 0) break;

        startAt += values.length;
      }

      return out;
    } catch (err) {
      this.logger.warn(
        `getCustomFieldContexts() unavailable — every field stays space-scoped: ${(err as Error).message}`,
      );

      return new Map();
    }
  }

  /**
   * The REAL transition graph for one workflow, or null when unreadable.
   *
   * `/rest/projectconfig/1/workflow?workflowName=` is the ONE endpoint on Jira Server that exposes
   * the graph (verified live against 8.22.4; the public REST reports names and step counts only,
   * the XML export is websudo-gated, and workflowDesigner 404s on XSRF). Null on any failure keeps
   * `transitions: null` and today's all-to-all fallback — zero regression risk.
   */
  private async getWorkflowGraph(workflowName: string) {
    try {
      const raw = await this.http.getJson<unknown>(
        `/rest/projectconfig/1/workflow?workflowName=${encodeURIComponent(workflowName)}`,
      );
      const parsed = parseProjectConfigWorkflow(raw);

      for (const warning of parsed.warnings) {
        this.logger.warn(`workflow graph "${workflowName}": ${warning}`);
      }

      // An empty graph is indistinguishable from a misread payload; the honest fallback is the
      // same as an unreachable endpoint.
      if (parsed.transitions.length === 0) return null;

      return parsed;
    } catch (err) {
      this.logger.warn(
        `workflow graph "${workflowName}" unavailable (all-to-all fallback): ${(err as Error).message}`,
      );

      return null;
    }
  }

  /**
   * The instance's groups from the groups PICKER.
   *
   * `/groups/picker` is a typeahead endpoint, not a listing endpoint — it caps what it returns and
   * reports the real count in `total`. Presenting a capped page as the whole instance would make a
   * "complete" migration silently partial, so a shortfall is logged loudly here.
   */
  async listGroups(): Promise<NormalizedGroup[]> {
    try {
      const res = await this.http.getJson<{
        total?: number;
        groups?: { name?: string }[];
      }>(`${API}/groups/picker?maxResults=1000`);
      const groups = (res.groups ?? [])
        .map((g) => ({
          sourceId: (g.name ?? '').trim(),
          name: (g.name ?? '').trim(),
        }))
        .filter((g) => g.sourceId.length > 0);

      if (typeof res.total === 'number' && res.total > groups.length) {
        this.logger.warn(
          `listGroups(): the groups picker returned ${groups.length} of ${res.total} groups — ` +
            `the remainder will NOT migrate; raise maxResults or migrate them by role membership`,
        );
      }

      return groups;
    } catch (err) {
      this.logger.warn(`listGroups() failed: ${(err as Error).message}`);

      return [];
    }
  }

  /** One page of a group's members; ids key identically to the `user` crosswalk. */
  async getGroupMembers(
    groupSourceId: string,
    opts?: { cursor?: string | null; pageSize?: number },
  ): Promise<Page<NormalizedUser>> {
    const startAt = Number(opts?.cursor ?? '0') || 0;
    const pageSize = opts?.pageSize ?? 50;

    try {
      const res = await this.http.getJson<{
        values?: JiraRawUser[];
        isLast?: boolean;
        total?: number;
      }>(
        `${API}/group/member?groupname=${encodeURIComponent(groupSourceId)}` +
          `&includeInactiveUsers=false&startAt=${startAt}&maxResults=${pageSize}`,
      );
      const items = (res.values ?? []).map((u) => this.normalizeUser(u));
      const isLast = res.isLast !== false || items.length === 0;

      return {
        items,
        nextCursor: isLast ? null : String(startAt + items.length),
        total: typeof res.total === 'number' ? res.total : null,
      };
    } catch (err) {
      this.logger.warn(
        `getGroupMembers("${groupSourceId}") failed: ${(err as Error).message}`,
      );

      return { items: [], nextCursor: null, total: null };
    }
  }

  async getResolutions(): Promise<NormalizedResolution[]> {
    try {
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
    } catch (err) {
      this.logger.warn(
        `getResolutions() failed, issues will migrate without resolutions: ${(err as Error).message}`,
      );

      return [];
    }
  }

  async getIssueLinkTypes(): Promise<NormalizedLinkType[]> {
    try {
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
    } catch (err) {
      this.logger.warn(
        `getIssueLinkTypes() failed, unmatched link types fall back to a generic relation: ${(err as Error).message}`,
      );

      return [];
    }
  }

  /**
   * One page of an issue's comments from the per-issue resource, which pages to the TRUE total —
   * unlike `fields.comment` in a search response, which Jira caps.
   *
   * `expand=renderedBody` is what makes this equivalent to the search path rather than a downgrade:
   * without it every body is raw wiki markup and the transformer can only degrade it to escaped
   * plain text, silently losing bold/lists/links/code on exactly the comments that were too numerous
   * to inline. `renderedBody` is a per-comment field here (not the parallel `renderedFields` array
   * the search returns), so it pairs by construction and needs no id matching.
   */
  async getIssueComments(
    issueSourceId: string,
    opts?: { cursor?: string | null; pageSize?: number },
  ): Promise<Page<NormalizedComment>> {
    const pageSize = opts?.pageSize ?? 50;
    let startAt = Number(opts?.cursor);

    if (!Number.isFinite(startAt) || startAt < 0) startAt = 0;

    const res = await this.http.getJson<{
      comments?: (JiraRawComment & { renderedBody?: string })[];
      total?: number;
      startAt?: number;
    }>(
      `${API}/issue/${encodeURIComponent(issueSourceId)}/comment` +
        `?startAt=${startAt}&maxResults=${pageSize}&expand=renderedBody`,
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
        body: this.toRawBody(c.body, c.renderedBody) ?? {
          format: 'wiki',
          value: '',
        },
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
