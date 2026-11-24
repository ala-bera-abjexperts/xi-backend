/**
 * @fileoverview Source discovery for the migration wizard: list migratable
 * sources on a connection and build a partial-tolerant preview of a Jira
 * project (counts + warnings) before a job is created.
 *
 * The preview is deliberately forgiving: only a bad project key fails the whole
 * call (404). Every other sub-extraction (issue types, statuses, workflows,
 * boards, users/roles, counts, fields) is try/caught individually and degrades
 * to an empty result plus a `{ code, message }` warning, so a locked-down
 * source account still yields a usable preview.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AtlassianRequestError } from '../adapters/http/atlassian-http-client';
import {
  isConfluenceAdapter,
  isJiraAdapter,
  type IJiraSourceAdapter,
} from '../adapters/source-adapter.interface';
import type {
  NormalizedBoard,
  NormalizedField,
  NormalizedIssueType,
  NormalizedProject,
  NormalizedRole,
  NormalizedSpace,
  NormalizedStatus,
  NormalizedUser,
  NormalizedWorkflow,
} from '../model/normalized';
import { UserMapper } from '../mappers/user.mapper';
import { findJiraAdminIds, inviteDecision } from '../engine/stages/users.stage';
import { MigrationConnectionsService } from './migration-connections.service';

/** Non-fatal problem encountered while assembling a preview. */
export interface DiscoveryPreviewWarning {
  code: string;
  message: string;
}

/** One source user in the read-only mapping preview (nothing is created). */
export interface UserMappingPreviewRow {
  sourceId: string;
  displayName: string;
  email: string | null;
  active: boolean;
  matchMethod: 'email' | 'created' | 'placeholder';
  isPlaceholder: boolean;
  /** public.users.id when matched by email within THIS org; null otherwise. */
  matchedUserId: string | null;
  /** Org role an invite-enabled run would invite this user with; null when they would not be invited. */
  inviteRole: 'admin' | 'member' | null;
}

export interface UserMappingPreviewResponse {
  rows: UserMappingPreviewRow[];
  summary: {
    total: number;
    matchedByEmail: number;
    /** How many accounts a provisioning-enabled run would create. */
    wouldCreate: number;
    placeholders: number;
    withoutEmail: number;
    /** How many people an invite-enabled run would invite (only when the preview models invites). */
    wouldInvite: number;
  };
  /** Project roles for context (membership mapping happens in a later phase). */
  roles: { name: string; actorCount: number }[];
  warnings: DiscoveryPreviewWarning[];
}

export interface DiscoverySourcesResponse {
  kind: 'jira_project' | 'confluence_space';
  items: NormalizedProject[];
}

export interface ProjectPreviewResponse {
  project: NormalizedProject;
  counts: {
    issueTypes: number;
    /** Deduped across issue types by field sourceId. */
    fields: number;
    statuses: number;
    workflows: number;
    boards: number;
    users: number;
    roles: number;
    /** null when the source cannot report totals. */
    issues: number | null;
  };
  warnings: DiscoveryPreviewWarning[];
}

export interface SpacePreviewResponse {
  space: NormalizedProject;
  counts: {
    /** Total pages in the space; null when the source cannot report a count. */
    pages: number | null;
  };
  warnings: DiscoveryPreviewWarning[];
}

/** Max concurrent source calls per preview (kind to on-prem boxes). */
const PREVIEW_CONCURRENCY = 3;

@Injectable()
export class MigrationDiscoveryService {
  private readonly logger = new Logger(MigrationDiscoveryService.name);

  constructor(
    private readonly connectionsService: MigrationConnectionsService,
    private readonly userMapper: UserMapper,
  ) {}

  /**
   * Read-only user-mapping preview: which source users would match an existing
   * org member by email vs become linked placeholders. Creates NOTHING and
   * sends NOTHING — pure would-match reporting for the review UI.
   */
  async previewUsers(
    orgId: string,
    connectionId: string,
    projectKey: string,
    provision = false,
    invite = false,
  ): Promise<UserMappingPreviewResponse> {
    const adapter = await this.connectionsService.buildAdapter(
      orgId,
      connectionId,
    );

    if (!isJiraAdapter(adapter)) {
      throw new BadRequestException(
        'User mapping preview is currently supported for Jira connections only',
      );
    }

    let users: NormalizedUser[] = [];
    let roles: NormalizedRole[] = [];
    const warnings: DiscoveryPreviewWarning[] = [];

    try {
      ({ users, roles } = await adapter.getUsersAndRoles(projectKey));
    } catch (err) {
      if (err instanceof AtlassianRequestError && err.status === 404) {
        throw new NotFoundException('Project not found on the source system');
      }

      warnings.push({
        code: 'users_unavailable',
        message: `Could not read project users: ${(err as Error).message}`,
      });
    }

    const adminIds = invite
      ? await findJiraAdminIds(adapter, (message) =>
          warnings.push({ code: 'admin_groups_unavailable', message }),
        )
      : new Set<string>();
    const rows: UserMappingPreviewRow[] = [];

    for (const user of users) {
      const resolved = await this.userMapper.resolveUser(
        orgId,
        connectionId,
        user,
        { previewOnly: true, provision },
      );

      const decision = inviteDecision(user, adminIds.has(user.sourceId));

      rows.push({
        sourceId: user.sourceId,
        displayName: user.displayName,
        email: user.email ?? null,
        active: user.active !== false,
        matchMethod: resolved.matchMethod,
        isPlaceholder: resolved.isPlaceholder,
        matchedUserId: resolved.isPlaceholder ? null : resolved.userId,
        inviteRole:
          invite && resolved.isPlaceholder && 'role' in decision
            ? decision.role
            : null,
      });
    }

    return {
      rows,
      summary: {
        total: rows.length,
        matchedByEmail: rows.filter((r) => r.matchMethod === 'email').length,
        // Only populated when the preview is asked to model provisioning; 0 otherwise.
        wouldCreate: rows.filter((r) => r.matchMethod === 'created').length,
        placeholders: rows.filter((r) => r.isPlaceholder).length,
        withoutEmail: rows.filter((r) => !r.email).length,
        wouldInvite: rows.filter((r) => r.inviteRole).length,
      },
      roles: roles.map((r) => ({ name: r.name, actorCount: r.actors.length })),
      warnings,
    };
  }

  /** List migratable sources for a connection (Jira projects or Confluence spaces). */
  async listSources(
    orgId: string,
    connectionId: string,
  ): Promise<DiscoverySourcesResponse> {
    const adapter = await this.connectionsService.buildAdapter(
      orgId,
      connectionId,
    );

    if (isJiraAdapter(adapter)) {
      return {
        kind: 'jira_project' as const,
        items: await adapter.listProjects(),
      };
    }

    if (isConfluenceAdapter(adapter)) {
      // Drain the cursor (spaces are a bounded list; cap defensively).
      const items: NormalizedProject[] = [];
      let cursor: string | null = null;
      let guard = 0;

      do {
        const page = await adapter.listSpaces(cursor);

        for (const space of page.items) {
          items.push({
            sourceId: space.sourceId,
            key: space.key,
            name: space.name,
            description: space.description,
          });
        }

        cursor = page.nextCursor;
      } while (cursor && ++guard < 50);

      return { kind: 'confluence_space' as const, items };
    }

    return { kind: 'confluence_space' as const, items: [] };
  }

  /**
   * Partial-tolerant preview of a Jira project. Only an invalid project key
   * fails the call (404); every other sub-extraction degrades to a warning.
   */
  async previewProject(
    orgId: string,
    connectionId: string,
    projectKey: string,
  ): Promise<ProjectPreviewResponse> {
    const adapter = await this.connectionsService.buildAdapter(
      orgId,
      connectionId,
    );

    if (!isJiraAdapter(adapter)) {
      throw new BadRequestException(
        'Preview is currently supported for Jira connections only',
      );
    }

    // A bad key should 404 the whole preview — this call is NOT tolerated.
    let project: NormalizedProject;

    try {
      project = await adapter.getProjectDetails(projectKey);
    } catch (err) {
      if (err instanceof AtlassianRequestError && err.status === 404) {
        throw new NotFoundException('Project not found');
      }

      throw err;
    }

    const warnings: DiscoveryPreviewWarning[] = [];
    let issueTypes: NormalizedIssueType[] = [];
    let statuses: NormalizedStatus[] = [];
    let workflows: NormalizedWorkflow[] = [];
    let boards: NormalizedBoard[] = [];
    let usersAndRoles: { users: NormalizedUser[]; roles: NormalizedRole[] } = {
      users: [],
      roles: [],
    };
    let issueCount: number | null = null;

    const warn = (code: string, message: string, err: unknown): void => {
      this.logger.warn(
        `Preview ${projectKey}: ${code} — ${(err as Error).message}`,
      );
      warnings.push({ code, message });
    };

    await this.runPool(
      [
        async () => {
          try {
            issueTypes = await adapter.getIssueTypes(projectKey);
          } catch (err) {
            warn('issue_types_failed', 'Could not load issue types', err);
          }
        },
        async () => {
          try {
            statuses = await adapter.getStatuses(projectKey);
          } catch (err) {
            warn('statuses_failed', 'Could not load statuses', err);
          }
        },
        async () => {
          try {
            workflows = await adapter.getWorkflows(projectKey);
          } catch (err) {
            warn('workflows_failed', 'Could not load workflows', err);
          }
        },
        async () => {
          try {
            boards = await adapter.getBoards(projectKey);
          } catch (err) {
            warn(
              'boards_unavailable',
              'Boards are unavailable on this instance',
              err,
            );
          }
        },
        async () => {
          try {
            usersAndRoles = await adapter.getUsersAndRoles(projectKey);
          } catch (err) {
            warn(
              'users_forbidden',
              'Could not load project users and roles',
              err,
            );
          }
        },
        async () => {
          try {
            issueCount = await adapter.countIssues(projectKey);
          } catch (err) {
            warn('count_failed', 'Could not count issues', err);
          }
        },
      ],
      PREVIEW_CONCURRENCY,
    );

    const fields = await this.collectFields(
      adapter,
      projectKey,
      issueTypes,
      warnings,
    );

    if (project.key.length > 8) {
      warnings.push({
        code: 'project_key_too_long',
        message: `Project key "${project.key}" is longer than 8 characters — the created space key will be truncated`,
      });
    }

    return {
      project,
      counts: {
        issueTypes: issueTypes.length,
        fields: fields.size,
        statuses: statuses.length,
        workflows: workflows.length,
        boards: boards.length,
        users: usersAndRoles.users.length,
        roles: usersAndRoles.roles.length,
        issues: issueCount,
      },
      warnings,
    };
  }

  /**
   * Lightweight preview of a Confluence space: space details + a cheap page
   * count (one CQL call). Attachment totals are deliberately NOT counted —
   * that would walk every page (M0 alone has ~10k pages). A bad key 404s;
   * a failed count degrades to `pages: null` + a warning.
   */
  async previewSpace(
    orgId: string,
    connectionId: string,
    spaceKey: string,
  ): Promise<SpacePreviewResponse> {
    const adapter = await this.connectionsService.buildAdapter(
      orgId,
      connectionId,
    );

    if (!isConfluenceAdapter(adapter)) {
      throw new BadRequestException(
        'Space preview is supported for Confluence connections only',
      );
    }

    let space: NormalizedSpace;

    try {
      space = await adapter.getSpaceDetails(spaceKey);
    } catch (err) {
      if (err instanceof AtlassianRequestError && err.status === 404) {
        throw new NotFoundException('Space not found on the source system');
      }

      throw err;
    }

    const warnings: DiscoveryPreviewWarning[] = [];
    let pages: number | null = null;

    try {
      pages = await adapter.countPages(spaceKey);
    } catch (err) {
      this.logger.warn(
        `Space preview ${spaceKey}: page count failed — ${(err as Error).message}`,
      );
      warnings.push({
        code: 'page_count_failed',
        message: 'Could not count pages on the source system',
      });
    }

    return {
      space: {
        sourceId: space.sourceId,
        key: space.key,
        name: space.name,
        description: space.description,
      },
      counts: { pages },
      warnings,
    };
  }

  /**
   * Fetch fields per issue type (bounded concurrency) and dedupe by field
   * sourceId, unioning `issueTypeSourceIds`. Individual failures produce a
   * single `fields_partial` warning instead of failing the preview.
   */
  private async collectFields(
    adapter: IJiraSourceAdapter,
    projectKey: string,
    issueTypes: NormalizedIssueType[],
    warnings: DiscoveryPreviewWarning[],
  ): Promise<Map<string, NormalizedField>> {
    const deduped = new Map<string, NormalizedField>();
    let warned = false;

    await this.runPool(
      issueTypes.map((issueType) => async () => {
        try {
          const fields = await adapter.getFieldsForIssueType(
            projectKey,
            issueType.sourceId,
          );

          for (const field of fields) {
            const existing = deduped.get(field.sourceId);

            if (existing) {
              existing.issueTypeSourceIds = [
                ...new Set([
                  ...(existing.issueTypeSourceIds ?? []),
                  ...(field.issueTypeSourceIds ?? []),
                ]),
              ];
            } else {
              deduped.set(field.sourceId, {
                ...field,
                issueTypeSourceIds: [...(field.issueTypeSourceIds ?? [])],
              });
            }
          }
        } catch (err) {
          this.logger.warn(
            `Preview ${projectKey}: fields failed for issue type ${issueType.sourceId} — ${(err as Error).message}`,
          );

          if (!warned) {
            warned = true;
            warnings.push({
              code: 'fields_partial',
              message:
                'Some field definitions could not be loaded — the field list may be incomplete',
            });
          }
        }
      }),
      PREVIEW_CONCURRENCY,
    );

    return deduped;
  }

  /** Tiny async pool: runs `tasks` with at most `size` in flight. Tasks must not throw. */
  private async runPool(
    tasks: Array<() => Promise<void>>,
    size: number,
  ): Promise<void> {
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < tasks.length) {
        const task = tasks[next];

        next++;
        await task();
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(size, tasks.length) }, () => worker()),
    );
  }
}
