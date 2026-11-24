/**
 * @fileoverview Core tasks service — CRUD, key generation, status
 * transitions, parent-child hierarchy, comments, relationships,
 * hierarchy navigation, history.
 * @module src/tasks/tasks.service
 * @author Prince Jadiya
 */

import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  databaseBadRequest,
  databaseRetryClass,
} from '../common/utils/database-error';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { sanitizeRichText } from '../common/utils/sanitize-rich-text';
import { extractUserMentionIds } from '../common/utils/mention-extractor';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import type { TaskStatusChangedSnapshot } from '../automations/automation-event-outbox.service';
import { TaskHierarchyConfigService } from '../task-hierarchy-config/task-hierarchy-config.service';
import type { ITaskTypeLevel } from '../task-hierarchy-config/models/task-hierarchy-config.model';
import { DEFAULT_TASK_HIERARCHY_CONFIG } from '../task-hierarchy-config/models/task-hierarchy-config.model';
import { WorkflowAssignmentsService } from '../workflow-assignments/workflow-assignments.service';
import { WorkflowEngineService } from '../workflow-engine/workflow-engine.service';
import { PermissionsService } from '../permissions/permissions.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { NotificationEmailService } from '../notifications/notification-email.service';
import { WikiPermissionsService } from '../wiki/wiki-permissions.service';
import { WatchersService } from '../watchers/watchers.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { CreateTaskDto } from './dto/create-task.dto';
import type { UpdateTaskDto } from './dto/update-task.dto';
import type { CreateRelationshipDto } from './dto/create-relationship.dto';

import { toLegacyPriorityText } from './legacy-priority.util';
import type { CustomField } from '../custom-fields/models/custom-field.model';
import { issueGroupValueError } from '../custom-fields/utils/issue-group.util';
import { toLegacyStatusText } from './legacy-status.util';
import { createLinkViewCheck } from './task-links.util';
import { applyTaskListOrder } from './task-list-sort.util';
import {
  applyDevFilter,
  GIT_DEV_SELECT,
  type DevFilter,
} from '../git-integrations/git-dev-filter.util';
import { sortTaskComments } from './task-comment-sort';
import type { TaskCommentSort } from '../users/dto/save-task-comment-preferences.dto';
import {
  KIND_CREATE_PERMISSION,
  KIND_EDIT_PERMISSION,
  readTestTaskTypes,
  type KindTypeColumn,
} from '../test-management/common/test-task-types';
import { TestManagementAccessService } from '../test-management/access/test-management-access.service';
import {
  checkPlanTicketDates,
  checkTestTicketFields,
  TEST_RECORD_DELETED_EVENT,
  TEST_RECORD_UPDATED_EVENT,
  TEST_TICKET_CREATED_EVENT,
  TEST_TICKET_DELETING_EVENT,
  TEST_TICKET_UPDATED_EVENT,
  type TestTicketCreatedEvent,
  type TestTicketDeletingEvent,
  type TestTicketFieldChanges,
  type TestTicketUpdatedEvent,
} from './test-ticket-events';
// Payloads in @OnEvent signatures must be type-only imports under isolatedModules.
import type {
  TestRecordDeletedEvent,
  TestRecordUpdatedEvent,
} from './test-ticket-events';

export interface Task {
  id: string;
  organization_id: string;
  space_id: string;
  process_id: string | null;
  parent_task_id: string | null;
  task_type_id: string | null;
  key: string;
  summary: string;
  description: string | null;
  status: string;
  status_id: string | null;
  priority: string;
  priority_id: string | null;
  resolution_id: string | null;
  resolved_at: string | null;
  due_date: string | null;
  start_date: string | null;
  end_date: string | null;
  completed_at: string | null;
  assigned_to: string | null;
  reporter: string | null;
  estimated_time: number | null;
  actual_time: number | null;
  duration: number | null;
  progress: number;
  estimated_cost: number | null;
  actual_cost: number | null;
  custom_field_values: Record<string, unknown>;
  labels: string[];
  sort_order: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

const TASK_WITH_RELATIONS_SELECT: string =
  '*, status_config:task_statuses!tasks_status_id_fkey(id,name,key,color,icon,is_completed,sort_order), space:spaces!tasks_space_id_fkey(id, key, name), process:business_processes!tasks_process_id_fkey(id, key, title, request_type), assignee:users!tasks_assigned_to_fkey(id, first_name, last_name, email, avatar_url), reporter_user:users!tasks_reporter_fkey(id, first_name, last_name, email, avatar_url)';

/** The task's real status row, as the detail view gets it, for lists that show a status chip. XE-T637. */
const STATUS_CONFIG_EMBED =
  'status_config:task_statuses!tasks_status_id_fkey(id,name,key,color,icon,is_completed,sort_order)';

export interface TaskStatusConfig {
  id: string;
  name: string;
  key: string;
  color: string;
  icon: string | null;
  is_completed: boolean;
  sort_order: number;
}

const RELATIONSHIP_WITH_DETAILS_SELECT: string =
  '*, relation_type:relation_types!task_relationships_relation_type_id_fkey(id, name, name_i18n, outward_description, inward_description, outward_description_i18n, inward_description_i18n, color, icon, is_directional), created_by_user:users!task_relationships_created_by_fkey(id, first_name, last_name, email, avatar_url)';

const ATTACHMENT_BUCKET = 'attachments';

const LEGACY_TASK_STATUS_TRANSITIONS: Record<string, string[]> = {
  open: ['in_progress', 'blocked', 'closed'],
  in_progress: ['review', 'done', 'blocked', 'open'],
  review: ['done', 'in_progress', 'blocked'],
  done: ['closed', 'open'],
  closed: ['open', 'in_progress'],
  blocked: ['open', 'in_progress'],
};

// Hard upper bound on the number of org spaces scanned per non-admin
// resolveAccessibleTaskSpaceIds request, i.e. the maximum number of per-space
// getUserSpacePermissions membership checks a single MCP-facing task read may
// run. This caps the per-request fan-out for the member-space wrapper. When an
// org has more non-archived spaces than this bound, we log a warning and
// constrain to the scanned prefix rather than silently truncate or run
// unbounded work. Mirrors the SCAN_BATCH bound in SpacesService.
const TASK_SPACE_SCAN_CAP = 200;

/** Maximum task-comment rows returned by the MCP `task.get` wrapper. */
const MAX_TASK_COMMENT_LIMIT = 25;

/** Maximum task-search page size for the MCP `task.search` wrapper. */
const MAX_TASK_SEARCH_LIMIT = 50;

/** Default task-search page size when none is supplied. */
const DEFAULT_TASK_SEARCH_LIMIT = 25;

/** Maximum comment-content length returned by the MCP `task.get` wrapper. */
const MAX_TASK_COMMENT_CONTENT_CHARS = 10 * 1024;

// Whitelisted, MCP-safe shape of a task in a `searchMyTasks` list payload.
// Description and custom fields are intentionally excluded from the list.
export interface MyTaskListItem {
  id: string;
  key: string | null;
  summary: string;
  status: string;
  priority: string;
  assignee: { id: string; name: string } | null;
  dueDate: string | null;
  space: { id: string; key: string; name: string } | null;
  updatedAt: string;
  // Only with `withDetails` (the web My Work list); the MCP/chat payload never carries these.
  statusConfig?: Record<string, unknown> | null;
  priorityConfig?: Record<string, unknown> | null;
  taskType?: {
    id: string;
    name: string;
    color: string;
    text_color?: string | null;
    icon?: string | null;
  } | null;
  process?: { id: string; title: string } | null;
  version?: number;
}

/** Page size cap for `searchMyTasks` page mode (the web My Work list). */
const MAX_TASK_SEARCH_PAGE_SIZE = 100;

/** Whitelisted, MCP-safe detail shape returned by `getMyTask`. */
export interface MyTaskDetail {
  id: string;
  key: string | null;
  summary: string;
  description: string | null;
  status: string;
  priority: string;
  assignee: { id: string; name: string } | null;
  reporter: { id: string; name: string } | null;
  dueDate: string | null;
  space: { id: string; key: string; name: string } | null;
  labels: unknown;
  version: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Whitelisted, MCP-safe comment shape returned by `getMyTask`. */
export interface MyTaskComment {
  id: string;
  author: { id: string; name: string } | null;
  content: string;
  createdAt: string;
}

@Injectable()
export class TasksService {
  private static readonly TABLE = 'tasks';
  private static readonly COMMENTS_TABLE = 'task_comments';
  private static readonly ATTACHMENTS_TABLE = 'task_attachments';
  private static readonly RELATIONSHIPS_TABLE = 'task_relationships';
  private static readonly HISTORY_TABLE = 'task_history';
  private static readonly SPACES_TABLE = 'spaces';
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly taskHierarchyConfig?: TaskHierarchyConfigService,
    private readonly engine?: WorkflowEngineService,
    private readonly assignments?: WorkflowAssignmentsService,
    private readonly outboxService?: AutomationEventOutboxService,
    // Optional so the existing positional unit-test constructions keep
    // compiling. DI always provides it in production (TasksModule imports
    // PermissionsModule); the MCP-facing member-space reads assert its
    // presence before use.
    @Optional() private readonly permissionsService?: PermissionsService,
    @Optional()
    private readonly notificationsBroadcast?: NotificationsBroadcastService,
    @Optional()
    private readonly notificationEmail?: NotificationEmailService,
    // Gates wiki-page relationship targets. Absent → wiki targets fail closed.
    @Optional()
    private readonly wikiPermissions?: WikiPermissionsService,
    @Optional() private readonly watchersService?: WatchersService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    private readonly testManagementAccess?: TestManagementAccessService,
  ) {}

  /**
   * Build a minimal RequestUser shim for engine calls. The TasksService API
   * receives only `userId` + `organizationId`, while the engine expects a
   * full RequestUser (`authUserId`, `email`, etc.). H1 fix — load the real
   * email from `users` so the `task.transitioned` event payload (which the
   * engine emits at Step 14) propagates the actor's real email to any
   * subscriber (parent-transitioned relay, send-notification fallback,
   * audit consumers). When the lookup fails (e.g. orphan user id), fall
   * back to an empty string so the engine call doesn't crash.
   *
   * @param userId - public.users.id
   * @param organizationId - active organization id
   * @returns RequestUser-shaped object castable to RequestUser
   */
  private async buildEngineUser(
    userId: string,
    organizationId: string,
  ): Promise<RequestUser> {
    let email = '';
    let authUserId = userId;

    try {
      const r = await this.client
        .from('users')
        .select('email, auth_user_id')
        .eq('id', userId)
        .maybeSingle();

      if (!r.error && r.data) {
        const row = r.data as {
          email?: string | null;
          auth_user_id?: string | null;
        };

        email = row.email ?? '';
        authUserId = row.auth_user_id ?? userId;
      }
    } catch {
      // best-effort — never block a transition because we couldn't fetch
      // a display field. Engine + downstream subscribers tolerate empty
      // email; they don't tolerate a thrown exception here.
    }

    return {
      userId,
      organizationId,
      authUserId,
      email,
    } as RequestUser;
  }

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  async getById(id: string, organizationId: string): Promise<Task>;
  async getById(
    id: string,
    organizationId: string,
    options: { withRelations: true },
  ): Promise<Record<string, unknown>>;
  async getById(
    id: string,
    organizationId: string,
    options: { withRelations?: boolean } = {},
  ): Promise<Task | Record<string, unknown>> {
    const r = await this.client
      .from(TasksService.TABLE)
      .select(options.withRelations ? TASK_WITH_RELATIONS_SELECT : '*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (r.error) throw databaseBadRequest(r.error, r.status);
    if (!r.data) throw new NotFoundException('Task not found');
    if (options.withRelations) {
      return this.enrichTaskWithRelations(
        r.data as unknown as Record<string, unknown>,
        organizationId,
        true,
      );
    }
    return r.data as unknown as Task;
  }

  async getByKey(key: string, organizationId: string): Promise<Task>;
  async getByKey(
    key: string,
    organizationId: string,
    options: { withRelations: true },
  ): Promise<Record<string, unknown>>;
  async getByKey(
    key: string,
    organizationId: string,
    options: { withRelations?: boolean } = {},
  ): Promise<Task | Record<string, unknown>> {
    const r = await this.client
      .from(TasksService.TABLE)
      .select(options.withRelations ? TASK_WITH_RELATIONS_SELECT : '*')
      .eq('key', key)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Task not found');
    if (options.withRelations) {
      return this.enrichTaskWithRelations(
        r.data as unknown as Record<string, unknown>,
        organizationId,
        true,
      );
    }
    return r.data as unknown as Task;
  }

  // GET /tasks/by-key also serves the task cards in wiki pages and whiteboards. Its guard checks only
  // the org-level can_view_tasks, so the task's own space is checked here. Same 404 as a missing task.
  async getByKeyForViewer(
    user: RequestUser,
    key: string,
  ): Promise<Record<string, unknown>> {
    const task = await this.getByKey(key, user.organizationId, {
      withRelations: true,
    });
    const spaceId = (task.space_id as string | null) ?? null;
    if (spaceId) {
      const resolved =
        await this.requirePermissionsService().getUserSpacePermissions(
          user.userId,
          user.organizationId,
          spaceId,
        );
      if (!(resolved.isMember && resolved.permissions['view_tasks'] === true))
        throw new NotFoundException('Task not found');
    }
    return task;
  }

  async getAll(
    organizationId: string,
    filters: {
      space_id?: string;
      process_id?: string;
      parent_task_id?: string | null;
      task_type_id?: string;
      status?: string;
      statuses?: string;
      status_id?: string;
      status_ids?: string;
      priority?: string;
      priorities?: string;
      priority_id?: string;
      priority_ids?: string;
      ids?: string;
      assigned_to?: string | null;
      reporter?: string;
      search?: string;
      is_overdue?: string;
      due_before?: string;
      due_after?: string;
      created_after?: string;
      created_before?: string;
      page?: number;
      pageSize?: number;
      withRelations?: boolean;
      sortBy?: string;
      sortDir?: string;
      development?: DevFilter;
      /** Adds the git_* computed fields to each row (GET /tasks only; costs a probe per row). */
      withDevelopment?: boolean;
      /** Extra query constraints for callers with filters of their own (issue groups). */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the PostgREST builder type
      refine?: (query: any) => any;
    },
  ): Promise<{
    data: Array<Task | Record<string, unknown>>;
    count: number;
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
  }> {
    const page = filters.page ?? 1;
    // SECURITY (H14): clamp page size to a sane maximum so a caller cannot force
    // an unbounded scan (e.g. ?pageSize=1000000 over a large task table = DoS).
    const pageSize = Math.min(Math.max(1, filters.pageSize ?? 50), 100);
    const isPaginated =
      filters.page !== undefined || filters.pageSize !== undefined;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const baseSelect = filters.withRelations ? TASK_WITH_RELATIONS_SELECT : '*';

    let query = this.client
      .from(TasksService.TABLE)
      .select(
        filters.withDevelopment
          ? `${baseSelect}, ${GIT_DEV_SELECT}`
          : baseSelect,
        { count: 'exact' },
      )
      .eq('organization_id', organizationId);

    if (filters.space_id) query = query.eq('space_id', filters.space_id);
    if (filters.process_id) query = query.eq('process_id', filters.process_id);
    if (filters.parent_task_id !== undefined) {
      if (
        filters.parent_task_id === null ||
        filters.parent_task_id === 'null'
      ) {
        query = query.is('parent_task_id', null);
      } else {
        query = query.eq('parent_task_id', filters.parent_task_id);
      }
    }
    if (filters.task_type_id)
      query = query.eq('task_type_id', filters.task_type_id);
    if (filters.statuses) {
      const vals = filters.statuses.split(',').map((s) => s.trim());
      query = query.in('status', vals);
    } else if (filters.status) {
      query = query.eq('status', filters.status);
    }
    if (filters.status_ids) {
      const vals = filters.status_ids.split(',').map((s) => s.trim());
      query = query.in('status_id', vals);
    } else if (filters.status_id) {
      query = query.eq('status_id', filters.status_id);
    }
    if (filters.priorities) {
      const vals = filters.priorities.split(',').map((s) => s.trim());
      query = query.in('priority', vals);
    } else if (filters.priority) {
      query = query.eq('priority', filters.priority);
    }
    if (filters.priority_ids) {
      const vals = filters.priority_ids.split(',').map((s) => s.trim());
      query = query.in('priority_id', vals);
    } else if (filters.priority_id) {
      query = query.eq('priority_id', filters.priority_id);
    }
    if (filters.ids) {
      const vals = filters.ids
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (vals.length > 0) query = query.in('id', vals);
    }
    if (filters.assigned_to !== undefined) {
      if (filters.assigned_to === null || filters.assigned_to === 'null') {
        query = query.is('assigned_to', null);
      } else {
        query = query.eq('assigned_to', filters.assigned_to);
      }
    }
    if (filters.reporter) {
      query = query.eq('reporter', filters.reporter);
    }
    if (filters.search) {
      // Sanitize search to prevent PostgREST .or() injection
      const safe = filters.search.trim().replace(/[,.()"'\\]/g, '');
      if (safe.length > 0) {
        // `key` is matched too so pasting a task key (SPACE-T123) finds the task.
        // Unqualified columns here resolve against `tasks`, not the space/process embeds.
        const parts = [
          `summary.ilike.%${safe}%`,
          `description.ilike.%${safe}%`,
          `key.ilike.%${safe}%`,
        ];

        // Keys are stored as SPACE-T123, but people type the number part as "T-123".
        // Match the separator-stripped form so that still resolves.
        const compact = safe.replace(/[\s-]/g, '');

        if (compact.length > 0 && compact !== safe) {
          parts.push(`key.ilike.%${compact}%`);
        }

        query = query.or(parts.join(','));
      }
    }
    if (filters.is_overdue === 'true') {
      query = query
        .lt('due_date', new Date().toISOString())
        .not('status', 'in', '("done","closed")');
    }
    if (filters.due_before) query = query.lte('due_date', filters.due_before);
    if (filters.due_after) query = query.gte('due_date', filters.due_after);
    if (filters.created_after)
      query = query.gte('created_at', filters.created_after);
    if (filters.created_before)
      query = query.lte('created_at', filters.created_before);
    if (filters.development) query = applyDevFilter(query, filters.development);
    if (filters.refine) query = filters.refine(query);

    query = applyTaskListOrder(query, filters.sortBy, filters.sortDir);

    if (isPaginated) query = query.range(from, to);

    const r = await query;

    if (r.error) throw new BadRequestException(r.error.message);
    const rows = filters.withRelations
      ? await this.enrichTasksWithRelations(
          (r.data ?? []) as unknown as Record<string, unknown>[],
          organizationId,
          false,
        )
      : ((r.data ?? []) as unknown as Task[]);
    const total = r.count ?? rows.length;

    return {
      data: rows,
      count: isPaginated ? total : rows.length,
      total,
      page,
      pageSize,
      hasMore: total > page * pageSize,
    };
  }

  // MCP-facing member-space reads.
  //
  // The base tasks read paths (getAll/getById/getByKey) scope by organization
  // only; space_id is just an optional filter and there is no space-membership
  // check. A naive MCP tool over those would leak tasks from spaces the caller
  // is not a member of. The methods below add a server-side member-space
  // wrapper: they resolve the caller's accessible task-space-id set (admin/owner
  // gets all non-archived org spaces; otherwise spaces where
  // getUserSpacePermissions(...).isMember && permissions['view_tasks']),
  // constrain every query to that set, and (for the single-task read) throw a
  // uniform NotFound for cross-org / non-member / nonexistent. Caller ids come
  // only from the authenticated RequestUser, never from arguments.

  // Asserts the optionally-injected PermissionsService is present before the
  // MCP-facing reads use it. DI always supplies it in production (TasksModule
  // imports PermissionsModule); this guard only fires in the legacy positional
  // unit-test construction path.
  private requirePermissionsService(): PermissionsService {
    if (!this.permissionsService) {
      throw new BadRequestException('PermissionsService is not available');
    }

    return this.permissionsService;
  }

  // Resolves the complete set of task-space ids the caller may read, plus
  // whether org-level (space_id IS NULL) tasks are visible, plus a map of the
  // resolved spaces for space_id to {id,key,name} enrichment.
  //
  // Visibility rule (per space): the caller is an org admin/owner (fast-path to
  // all non-archived org spaces), or
  // getUserSpacePermissions(...).isMember && permissions['view_tasks'] is true.
  // Org-level tasks are included only when the caller's effective org permission
  // can_view_tasks is true. Archived spaces are excluded.
  //
  // For non-admins the org-space scan is bounded by TASK_SPACE_SCAN_CAP: if the
  // org has more non-archived spaces than that, we log a warning and constrain
  // to the scanned prefix rather than silently truncating or running unbounded
  // per-space checks (set-based SQL is deferred as a follow-up).
  /** Public entry to the member-space rule below (used by TaskPickerService). */
  getAccessibleTaskSpaces(user: RequestUser) {
    return this.resolveAccessibleTaskSpaceIds(user);
  }

  private async resolveAccessibleTaskSpaceIds(user: RequestUser): Promise<{
    spaceIds: string[];
    orgCanViewTasks: boolean;
    spacesById: Map<string, { id: string; key: string; name: string }>;
    truncated: boolean;
  }> {
    const spacesById = new Map<
      string,
      { id: string; key: string; name: string }
    >();

    if (!user.organizationId) {
      return {
        spaceIds: [],
        orgCanViewTasks: false,
        spacesById,
        truncated: false,
      };
    }

    const permissionsService = this.requirePermissionsService();

    // Org-level (space_id IS NULL) tasks are visible only when the caller's
    // effective org permission grants can_view_tasks.
    const effective = await permissionsService.getUserEffectivePermissions(
      user.userId,
      user.organizationId,
    );
    const orgCanViewTasks =
      effective.effective_permissions?.can_view_tasks === true;

    // Candidate non-archived org spaces, with an explicit safe column select.
    const candidatesResult = await this.client
      .from(TasksService.SPACES_TABLE)
      .select('id, key, name')
      .eq('organization_id', user.organizationId)
      .eq('is_archived', false)
      .order('id', { ascending: true })
      .limit(TASK_SPACE_SCAN_CAP);

    if (candidatesResult.error) {
      throw new BadRequestException(candidatesResult.error.message);
    }

    const candidates = (candidatesResult.data ?? []) as Array<{
      id: string;
      key: string;
      name: string;
    }>;

    // Surface cap truncation to callers (searchMyTasks adds a `truncated: true`
    // field) so the accessible space set being capped is not silently
    // invisible. The warning log is kept.
    const truncated = candidates.length === TASK_SPACE_SCAN_CAP;

    if (truncated) {
      this.logger.warn(
        `resolveAccessibleTaskSpaceIds: org ${user.organizationId} has at ` +
          `least ${TASK_SPACE_SCAN_CAP} non-archived spaces; scan capped — ` +
          'results constrained to the scanned prefix (set-based SQL deferred ' +
          'to Phase 1F).',
      );
    }

    const isAdminOrOwner = await permissionsService.isAdminOrOwner(
      user.userId,
      user.organizationId,
    );

    // Admin/owner fast-path: every non-archived org space is accessible.
    if (isAdminOrOwner) {
      for (const row of candidates) {
        spacesById.set(row.id, { id: row.id, key: row.key, name: row.name });
      }

      return {
        spaceIds: candidates.map((row) => row.id),
        orgCanViewTasks,
        spacesById,
        truncated,
      };
    }

    // Non-admin path: keep spaces where the caller is a member and holds the
    // space-level view_tasks permission. N membership checks, bounded above by
    // TASK_SPACE_SCAN_CAP.
    const checks = await Promise.all(
      candidates.map(async (row) => ({
        row,
        resolved: await permissionsService.getUserSpacePermissions(
          user.userId,
          user.organizationId,
          row.id,
        ),
      })),
    );

    const spaceIds: string[] = [];

    for (const { row, resolved } of checks) {
      if (resolved.isMember && resolved.permissions['view_tasks'] === true) {
        spaceIds.push(row.id);
        spacesById.set(row.id, { id: row.id, key: row.key, name: row.name });
      }
    }

    return { spaceIds, orgCanViewTasks, spacesById, truncated };
  }

  // Maps a resolved-space entry (or null) to the whitelisted space shape.
  // Maps `searchMyTasks` rows to the whitelisted list item. With `withDetails` (web My Work list only) it
  // adds the status/priority config, process, version and the task type, which lives in the hierarchy
  // config JSON and is resolved for the whole page in one query.
  private async toMyTaskListItems(
    rows: Array<Record<string, unknown>>,
    spacesById: Map<string, { id: string; key: string; name: string }>,
    organizationId: string,
    withDetails: boolean,
  ): Promise<MyTaskListItem[]> {
    const typeMap = withDetails
      ? await this.fetchTaskTypeMap(
          organizationId,
          rows.map((row) => ({
            space_id: (row.space_id as string | null) ?? null,
            task_type_id: (row.task_type_id as string | null) ?? null,
          })),
        )
      : null;

    return rows.map((row) => {
      const item: MyTaskListItem = {
        id: row.id as string,
        key: (row.key as string | null) ?? null,
        summary: (row.summary as string) ?? '',
        status: (row.status as string) ?? '',
        priority: (row.priority as string) ?? '',
        assignee: this.mapTaskActor(row.assignee),
        dueDate: (row.due_date as string | null) ?? null,
        space: this.mapTaskSpace(row.space_id as string | null, spacesById),
        updatedAt: (row.updated_at as string) ?? '',
      };

      if (!typeMap) return item;

      const process = row.process as { id?: string; title?: string } | null;

      return {
        ...item,
        statusConfig:
          (row.status_config as Record<string, unknown> | null) ?? null,
        priorityConfig:
          (row.priority_config as Record<string, unknown> | null) ?? null,
        taskType:
          typeMap.get(
            `${row.space_id as string}|${row.task_type_id as string}`,
          ) ?? null,
        process:
          process?.id && process.title
            ? { id: process.id, title: process.title }
            : null,
        version: typeof row.version === 'number' ? row.version : 0,
      };
    });
  }

  private mapTaskSpace(
    spaceId: string | null | undefined,
    spacesById: Map<string, { id: string; key: string; name: string }>,
  ): { id: string; key: string; name: string } | null {
    if (!spaceId) return null;
    const space = spacesById.get(spaceId);

    return space ?? null;
  }

  // Builds the whitelisted `{ id, name }` actor shape from an enriched user
  // relation row (first_name/last_name/email). Returns null when absent.
  private mapTaskActor(actor: unknown): { id: string; name: string } | null {
    if (!actor || typeof actor !== 'object') return null;
    const row = actor as {
      id?: string;
      first_name?: string | null;
      last_name?: string | null;
      email?: string | null;
    };

    if (!row.id) return null;
    const name =
      `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() ||
      (row.email ?? '');

    return { id: row.id, name };
  }

  // Member-space-constrained task search backing the MCP `task.search` tool.
  //
  // Every query is constrained to organization_id = caller-org and
  // space_id IN accessibleIds (plus space_id IS NULL when the caller has org
  // can_view_tasks). When spaceIdOrKey is supplied it is resolved and verified
  // to be in the accessible set first; a non-accessible space yields an empty
  // result (no existence leak), never a 403. Reuses the getAll
  // search-sanitization and status/priority/due filters. The list payload uses
  // an explicit safe column select and excludes description and custom fields.
  //
  // The result is never null; an empty match yields `{ tasks: [] }`.
  async searchMyTasks(
    user: RequestUser,
    opts: {
      query?: string;
      spaceIdOrKey?: string;
      statuses?: string[];
      priorities?: string[];
      assignedTo?: string;
      dueBefore?: string;
      dueAfter?: string;
      sortBy?: string;
      limit?: number;
      cursor?: string;
      // Page mode (offset pages with an exact total), used by the web My Work list. Without `page` the
      // cursor mode below is unchanged, so the MCP task.search tool and the chat picker see no difference.
      page?: number;
      pageSize?: number;
      // Adds status/priority config, task type, process and version to each item (web list only).
      withDetails?: boolean;
      // Due before today and not done/closed (same rule as the space task list's overdue filter).
      overdue?: boolean;
    } = {},
  ): Promise<{
    tasks: MyTaskListItem[];
    nextCursor?: string;
    total?: number;
    page?: number;
    pageSize?: number;
    hasMore?: boolean;
    // Set when the accessible-space candidate scan hit TASK_SPACE_SCAN_CAP, so
    // callers know the space set was capped (the IN filter may be missing
    // spaces beyond the scanned prefix). Full set-based SQL is deferred as a
    // follow-up.
    truncated?: boolean;
  }> {
    if (!user.organizationId) {
      return { tasks: [] };
    }

    const { spaceIds, orgCanViewTasks, spacesById, truncated } =
      await this.resolveAccessibleTaskSpaceIds(user);

    // If a specific space was requested, resolve it and confirm it is in the
    // accessible set before constraining; a non-accessible (or nonexistent)
    // space returns empty so the tool cannot probe space existence.
    let constrainedSpaceId: string | null = null;

    if (opts.spaceIdOrKey) {
      const resolvedId = await this.resolveSpaceIdOrKey(
        opts.spaceIdOrKey,
        user.organizationId,
      );

      if (!resolvedId || !spacesById.has(resolvedId)) {
        return { tasks: [] };
      }

      constrainedSpaceId = resolvedId;
    }

    // No accessible spaces and no org-level visibility means nothing to return.
    if (spaceIds.length === 0 && !orgCanViewTasks) {
      return { tasks: [] };
    }

    // Number.isFinite guards against NaN (parseInt of a non-numeric query param
    // yields NaN, which `?? DEFAULT` does not catch and would otherwise
    // propagate a `limit=NaN` to PostgREST).
    const requestedLimit = Number.isFinite(opts.limit)
      ? (opts.limit as number)
      : DEFAULT_TASK_SEARCH_LIMIT;
    const limit = Math.min(Math.max(1, requestedLimit), MAX_TASK_SEARCH_LIMIT);

    // Explicit safe column select, never select('*'); description and
    // custom_field_values are deliberately omitted from the list payload.
    const BASE_LIST_SELECT =
      'id, key, summary, status, priority, due_date, space_id, updated_at, ' +
      'assigned_to, assignee:users!tasks_assigned_to_fkey(id, first_name, last_name, email)';
    const LIST_SELECT = opts.withDetails
      ? `${BASE_LIST_SELECT}, task_type_id, version, ${STATUS_CONFIG_EMBED}, ` +
        'priority_config:task_priorities!tasks_priority_id_fkey(id,name,key,color,icon), ' +
        'process:business_processes!tasks_process_id_fkey(id,title)'
      : BASE_LIST_SELECT;

    let query = this.client
      .from(TasksService.TABLE)
      .select(LIST_SELECT, { count: 'exact' })
      .eq('organization_id', user.organizationId);

    if (constrainedSpaceId) {
      query = query.eq('space_id', constrainedSpaceId);
    } else {
      // Constrain to the accessible space set and, when permitted, org-level
      // (NULL) tasks. PostgREST `.or()` with `space_id.in.(...)` + `is.null`.
      const orClauses: string[] = [];

      if (spaceIds.length > 0) {
        orClauses.push(`space_id.in.(${spaceIds.join(',')})`);
      }

      if (orgCanViewTasks) {
        orClauses.push('space_id.is.null');
      }

      // orClauses is guaranteed non-empty by the early return above.
      query = query.or(orClauses.join(','));
    }

    if (opts.statuses && opts.statuses.length > 0) {
      query = query.in('status', opts.statuses);
    }

    if (opts.priorities && opts.priorities.length > 0) {
      query = query.in('priority', opts.priorities);
    }

    if (opts.assignedTo) {
      // "me" resolves to the authenticated caller's public user id.
      const assignedTo =
        opts.assignedTo === 'me' ? user.userId : opts.assignedTo;

      query = query.eq('assigned_to', assignedTo);
    }

    if (opts.query) {
      // Reuse the getAll sanitization to prevent PostgREST .or() injection.
      const safe = opts.query.replace(/[,.()"'\\]/g, '');

      if (safe.length > 0) {
        query = query.or(
          `key.ilike.%${safe}%,summary.ilike.%${safe}%,description.ilike.%${safe}%`,
        );
      }
    }

    if (opts.dueBefore) query = query.lte('due_date', opts.dueBefore);
    if (opts.dueAfter) query = query.gte('due_date', opts.dueAfter);
    if (opts.overdue) {
      query = query
        .lt('due_date', new Date().toISOString())
        .not('status', 'in', '("done","closed")');
    }

    // Page mode (web My Work list): offset pages with the exact count, ordered by the requested column and
    // then `id`, so rows that share a value keep one stable position and no row repeats or vanishes between
    // pages. The cursor mode below stays as it is for the MCP tool and the chat picker.
    if (opts.page !== undefined) {
      const page = Number.isFinite(opts.page)
        ? Math.max(1, Math.floor(opts.page))
        : 1;
      const requestedSize = Number.isFinite(opts.pageSize)
        ? Math.floor(opts.pageSize as number)
        : DEFAULT_TASK_SEARCH_LIMIT;
      const pageSize = Math.min(
        Math.max(1, requestedSize),
        MAX_TASK_SEARCH_PAGE_SIZE,
      );
      const from = (page - 1) * pageSize;

      // Same ordering helper as the space task list: keys sort by number (T2 before T10), empty due
      // dates last, `id` as the tie-breaker.
      const [sortColumn, sortDir] =
        opts.sortBy === 'dueDate'
          ? ['due_date', 'asc']
          : opts.sortBy === 'key'
            ? ['key', 'asc']
            : ['updated_at', 'desc'];

      const pr = await applyTaskListOrder(query, sortColumn, sortDir).range(
        from,
        from + pageSize - 1,
      );

      if (pr.error) throw new BadRequestException(pr.error.message);

      const pageRows = (pr.data ?? []) as unknown as Array<
        Record<string, unknown>
      >;
      const total = pr.count ?? from + pageRows.length;
      const tasks = await this.toMyTaskListItems(
        pageRows,
        spacesById,
        user.organizationId,
        opts.withDetails === true,
      );

      return {
        tasks,
        total,
        page,
        pageSize,
        hasMore: from + pageRows.length < total,
        ...(truncated && { truncated: true }),
      };
    }

    // Keyset pagination over id (stable cursor), with the requested sort as a
    // secondary order. Default sort mirrors the app: updated_at DESC.
    const sortDescending = opts.sortBy !== 'dueDate' && opts.sortBy !== 'key';

    if (opts.sortBy === 'dueDate') {
      query = query.order('due_date', { ascending: true });
    } else if (opts.sortBy === 'key') {
      query = query.order('key', { ascending: true });
    } else {
      query = query.order('updated_at', { ascending: false });
    }

    if (opts.cursor) {
      query = sortDescending
        ? query.lt('id', opts.cursor)
        : query.gt('id', opts.cursor);
    }

    query = query.order('id', { ascending: !sortDescending }).limit(limit + 1);

    const r = await query;

    if (r.error) throw new BadRequestException(r.error.message);

    const rows = (r.data ?? []) as unknown as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const tasks = await this.toMyTaskListItems(
      pageRows,
      spacesById,
      user.organizationId,
      opts.withDetails === true,
    );

    const result: {
      tasks: MyTaskListItem[];
      nextCursor?: string;
      total?: number;
      truncated?: boolean;
    } = { tasks, total: r.count ?? tasks.length };

    if (hasMore && pageRows.length > 0) {
      result.nextCursor = pageRows[pageRows.length - 1].id as string;
    }

    // Flag a capped accessible-space scan so callers know the IN filter may be
    // missing spaces beyond TASK_SPACE_SCAN_CAP.
    if (truncated) {
      result.truncated = true;
    }

    return result;
  }

  // Member-space-constrained single-task read backing the MCP `task.get` tool.
  //
  // Resolves the task by UUID or key (org-scoped). If the task has a space_id,
  // that space must be in the caller's accessible set; if the task is org-level
  // (space_id IS NULL), the caller must hold org can_view_tasks. Every failure
  // case (cross-org, non-member space, org-level without permission, and
  // nonexistent) throws the identical NotFoundException (anti-probing; never
  // 403, never distinguishable).
  //
  // Returns a whitelisted detail shape (description in full, never
  // truncated). When
  // includeComments is true, comments are fetched only after the membership
  // gate, capped at MAX_TASK_COMMENT_LIMIT, and whitelisted. Throws a uniform
  // NotFoundException for non-member / nonexistent / cross-org.
  async getMyTask(
    user: RequestUser,
    taskIdOrKey: string,
    opts: { includeComments?: boolean; commentLimit?: number } = {},
  ): Promise<{ task: MyTaskDetail; comments?: MyTaskComment[] }> {
    // Uniform 404 for every "you cannot see this" case; never disambiguate.
    const notFound = () => new NotFoundException('Task not found');

    if (!user.organizationId) {
      throw notFound();
    }

    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        taskIdOrKey,
      );

    // Resolve org-scoped (the base finders throw NotFound when missing/cross-
    // org, which we normalize to our uniform notFound below).
    let raw: Record<string, unknown>;

    try {
      raw = isUuid
        ? ((await this.getById(
            taskIdOrKey,
            user.organizationId,
          )) as unknown as Record<string, unknown>)
        : ((await this.getByKey(
            taskIdOrKey,
            user.organizationId,
          )) as unknown as Record<string, unknown>);
    } catch {
      // Any resolution failure (NotFound, malformed, cross-org) collapses to
      // the same uniform not-found; never leak which case occurred.
      throw notFound();
    }

    const taskSpaceId = (raw.space_id as string | null) ?? null;

    // Membership gate checks the task's specific space directly, with no
    // accessible-set scan and no cap dependency. resolveAccessibleTaskSpaceIds
    // capped its scan at TASK_SPACE_SCAN_CAP, so a member whose space sorted
    // beyond the cap previously got a wrong 404 for their own task. A single
    // targeted space lookup plus one getUserSpacePermissions check fixes that
    // and is strictly more efficient. Every denial returns the same uniform
    // notFound().
    const permissionsService = this.requirePermissionsService();
    let space: { id: string; key: string; name: string } | null = null;

    if (taskSpaceId) {
      // (a) The space must exist in the same org and not be archived. This
      // org-scoped, archived-excluded lookup is the single source for both the
      // access decision and the enrichment shape (no redundant unscoped
      // fallback that could surface an archived/cross-org space).
      const spaceRow = await this.client
        .from(TasksService.SPACES_TABLE)
        .select('id, key, name')
        .eq('id', taskSpaceId)
        .eq('organization_id', user.organizationId)
        .eq('is_archived', false)
        .maybeSingle();

      if (spaceRow.error) throw notFound();
      const s = spaceRow.data as {
        id: string;
        key: string;
        name: string;
      } | null;

      if (!s) {
        // Nonexistent / archived / cross-org space yields a uniform 404.
        throw notFound();
      }

      // (b) The caller must be a member of that space and hold space-level
      // view_tasks (admin/owner still pass because isAdminOrOwner grants
      // isMember + view_tasks via getUserSpacePermissions).
      const resolved = await permissionsService.getUserSpacePermissions(
        user.userId,
        user.organizationId,
        taskSpaceId,
      );

      if (!(resolved.isMember && resolved.permissions['view_tasks'] === true)) {
        throw notFound();
      }

      space = { id: s.id, key: s.key, name: s.name };
    } else {
      // Org-level (space_id IS NULL) task, visible only with org
      // can_view_tasks. Same uniform 404 on denial.
      const effective = await permissionsService.getUserEffectivePermissions(
        user.userId,
        user.organizationId,
      );
      const orgCanViewTasks =
        effective.effective_permissions?.can_view_tasks === true;

      if (!orgCanViewTasks) {
        throw notFound();
      }
    }

    const description = (raw.description as string | null) ?? null;

    // Resolve assignee/reporter display names from a single users lookup.
    const actorIds = new Set<string>();
    const assignedTo = (raw.assigned_to as string | null) ?? null;
    const reporterId = (raw.reporter as string | null) ?? null;

    if (assignedTo) actorIds.add(assignedTo);
    if (reporterId) actorIds.add(reporterId);

    const actorsById = new Map<string, { id: string; name: string }>();

    if (actorIds.size > 0) {
      const usersResult = await this.client
        .from('users')
        .select('id, first_name, last_name, email')
        .in('id', [...actorIds]);

      for (const u of (usersResult.data ?? []) as Array<unknown>) {
        const mapped = this.mapTaskActor(u);

        if (mapped) actorsById.set(mapped.id, mapped);
      }
    }

    const versionRaw = raw.version;

    const task: MyTaskDetail = {
      id: raw.id as string,
      key: (raw.key as string | null) ?? null,
      summary: (raw.summary as string) ?? '',
      description,
      status: (raw.status as string) ?? '',
      priority: (raw.priority as string) ?? '',
      assignee: assignedTo ? (actorsById.get(assignedTo) ?? null) : null,
      reporter: reporterId ? (actorsById.get(reporterId) ?? null) : null,
      dueDate: (raw.due_date as string | null) ?? null,
      space,
      labels: raw.labels ?? null,
      version: typeof versionRaw === 'number' ? versionRaw : null,
      createdAt: (raw.created_at as string) ?? '',
      updatedAt: (raw.updated_at as string) ?? '',
    };

    if (!opts.includeComments) {
      return { task };
    }

    // Comments are fetched only after the membership gate above.
    // Number.isFinite guards against a NaN commentLimit (which `?? DEFAULT` does
    // not catch) reaching the PostgREST `.limit(...)`.
    const requestedCommentLimit = Number.isFinite(opts.commentLimit)
      ? (opts.commentLimit as number)
      : MAX_TASK_COMMENT_LIMIT;
    const commentLimit = Math.min(
      Math.max(1, requestedCommentLimit),
      MAX_TASK_COMMENT_LIMIT,
    );

    const commentsResult = await this.client
      .from(TasksService.COMMENTS_TABLE)
      .select(
        'id, content, created_at, author:users!created_by(id, first_name, last_name, email)',
      )
      .eq('task_id', task.id)
      .eq('organization_id', user.organizationId)
      .order('created_at', { ascending: false })
      .limit(commentLimit);

    // A comments-fetch failure must not fail an otherwise-accessible task read.
    // Log and degrade to an empty comments list.
    if (commentsResult.error) {
      this.logger.warn(
        `getMyTask: comments fetch failed for task ${task.id}: ${commentsResult.error.message}`,
      );

      return { task, comments: [] };
    }

    const comments: MyTaskComment[] = (
      (commentsResult.data ?? []) as unknown as Array<Record<string, unknown>>
    ).map((row) => {
      const content = (row.content as string | null) ?? '';

      return {
        id: row.id as string,
        author: this.mapTaskActor(row.author),
        content:
          content.length > MAX_TASK_COMMENT_CONTENT_CHARS
            ? content.slice(0, MAX_TASK_COMMENT_CONTENT_CHARS)
            : content,
        createdAt: (row.created_at as string) ?? '',
      };
    });

    return { task, comments };
  }

  // Resolves a space id from a UUID or a space key, scoped to the org. Returns
  // null when nothing matches (callers decide whether that is a not-found or an
  // empty result). Explicit safe column select.
  private async resolveSpaceIdOrKey(
    spaceIdOrKey: string,
    organizationId: string,
  ): Promise<string | null> {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        spaceIdOrKey,
      );

    const result = await this.client
      .from(TasksService.SPACES_TABLE)
      .select('id')
      .eq(
        isUuid ? 'id' : 'key',
        isUuid ? spaceIdOrKey : spaceIdOrKey.toUpperCase(),
      )
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (result.error) throw new BadRequestException(result.error.message);

    return (result.data as { id?: string } | null)?.id ?? null;
  }

  // ------------------------------------------------------------------
  // Create
  // ------------------------------------------------------------------

  /**
   * @param opts.preserveProvidedStatus - Keep `dto.status_id` instead of forcing the assigned
   *   workflow's `initial_status_id`. OFF by default: a human creating a task must land on the
   *   workflow's start node. A MIGRATION is the opposite — it replays history, so an issue that is
   *   "In Progress" in the source must arrive "In Progress" here. Without this, every migrated issue
   *   silently collapses to the initial status (verified live: Jira SDP had In Progress×1/To Do×24
   *   and all 25 arrived "To Do"). The workflow assignment is still recorded either way, so routing
   *   and post-functions are unaffected — only the starting status differs.
   *
   * @param opts.sourceTimestamps - Replay the SOURCE's `created_at`/`updated_at` instead of letting
   *   the columns default to now(). Deliberately NOT on `CreateTaskDto`: these must not be settable
   *   through the public API, where a client could forge an audit trail. A migration is the one
   *   legitimate caller, because a task imported from Jira has to keep the date it was really
   *   created (verified live: 25 migrated tasks all landed inside a 1.3s window while the source
   *   spanned weeks). Safe on INSERT because `tasks_updated_at` is a BEFORE **UPDATE** trigger, so
   *   an insert-time `updated_at` survives — the same reasoning `comments.stage.ts` relies on.
   */
  async create(
    organizationId: string,
    userId: string,
    dto: CreateTaskDto,
    opts: {
      migrationIdentity?: { targetId: string; onAdopt?: () => void };
      /** Trusted support-request retry identity; never accepted by the public DTO. */
      supportRequestId?: string;
      taskId?: string;
      /** Only newly inserted imported tasks wait for their final current state. */
      awaitImportCompletion?: boolean;
      preserveProvidedStatus?: boolean;
      /** Form-created tickets keep the chosen parent even when the task hierarchy forbids the pair. */
      skipHierarchyCheck?: boolean;
      sourceTimestamps?: { createdAt?: string; updatedAt?: string };
      /**
       * Migration-only, like `sourceTimestamps` above and deliberately NOT on `CreateTaskDto`:
       * `tasks.resolution_id`'s FK does not enforce same-organization. `UpdateTaskDto` now
       * exposes `resolution_id` with a same-org + `is_active` guard added in `update()` — that
       * is the runtime check this field was held back for. `create()` has no equivalent check
       * because it doesn't need one: via `opts` the id always comes from a crosswalk row written
       * under the caller's own org, never from client input. Verified trigger-safe: no trigger
       * on `tasks` touches either column.
       */
      resolution?: { resolutionId?: string; resolvedAt?: string };
      /** Test Management already checked the right on its own route (record tickets, "Run now"). */
      testRightChecked?: boolean;
    } = {},
  ): Promise<Task> {
    if (opts.migrationIdentity) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          opts.migrationIdentity.targetId,
        )
      ) {
        throw new BadRequestException('Invalid migration task identity');
      }
      const existing = await this.findMigrationTask(
        organizationId,
        dto,
        opts.migrationIdentity.targetId,
      );
      if (existing) {
        opts.migrationIdentity.onAdopt?.();
        return existing;
      }
    }
    const spaceId = await this.resolveCreateSpaceId(organizationId, dto);

    await this.assertIssueGroupValues(
      organizationId,
      spaceId,
      dto.custom_field_values,
    );
    const taskType = await this.validateCreateTaskInput(
      organizationId,
      spaceId,
      dto,
      opts.skipHierarchyCheck,
    );

    // Key is generated by the public.generate_task_key BEFORE-INSERT trigger,
    // which uses an advisory lock per space and computes max from the live
    // table. Setting it from the app race-conditions: a prior implementation
    // ordered by created_at DESC LIMIT 1 which returns an arbitrary tied row
    // when multiple tasks share a bulk-insert timestamp, yielding duplicate
    // keys. Leave NEW.key NULL and let the trigger populate it.

    const status = await this.resolveTaskStatusForWrite(
      organizationId,
      spaceId,
      dto.status,
      dto.status_id ?? null,
      taskType,
    );
    const priority = await this.resolveTaskPriorityForWrite(
      organizationId,
      spaceId,
      dto.priority,
      dto.priority_id ?? null,
      taskType,
    );

    // ------------------------------------------------------------------
    // Engine routing (Prompt 6 — Phase I)
    // ------------------------------------------------------------------
    // When the task type has an active workflow assignment, the workflow's
    // `initial_status_id` overrides the default status resolved above so
    // tasks land in the workflow's start node. We capture the assignment
    // here so the post-insert path can run the initial transition's
    // post-functions.
    let workflowStatusKey: string | null = null;
    let workflowStatusId: string | null = null;
    let workflowAssignmentId: string | null = null;
    let workflowId: string | null = null;
    const taskTypeLevelId: string = dto.task_type_id ?? taskType.id;

    if (this.assignments && this.engine) {
      const assignment = await this.assignments.findActiveAssignmentForType(
        organizationId,
        spaceId,
        taskTypeLevelId,
      );

      if (assignment) {
        const wf = await this.client
          .from('workflows')
          .select('id, initial_status_id')
          .eq('id', assignment.workflow_id)
          .eq('organization_id', organizationId)
          .maybeSingle();

        if (wf.error) throw databaseBadRequest(wf.error, wf.status);
        const wfRow = wf.data as {
          id: string;
          initial_status_id: string | null;
        } | null;

        if (wfRow?.initial_status_id) {
          // Always capture the assignment — the post-insert path needs it for the initial
          // transition's post-functions regardless of which status the row lands on.
          workflowAssignmentId = assignment.id;
          workflowId = wfRow.id;
        }

        if (
          wfRow?.initial_status_id &&
          !(opts.preserveProvidedStatus && dto.status_id)
        ) {
          workflowStatusId = wfRow.initial_status_id;
          // Resolve the status key for the workflow's initial status so the
          // legacy `tasks.status` text column stays in sync with status_id.
          // A workflow's initial status can be a CUSTOM status (its key is unconstrained), so it
          // goes through the same legacy bucket as any other — otherwise assigning a workflow
          // whose initial status is custom would 23514 every task created under it.
          const wfStatus = await this.resolveStatusRowById(
            organizationId,
            spaceId,
            workflowStatusId,
          );

          workflowStatusKey = toLegacyStatusText(
            wfStatus.key,
            wfStatus.isCompleted,
            wfStatus.categoryKey,
          );
        }
      }
    }

    // Imports keep their data as it is; everything else must fit the test record it creates.
    if (!opts.migrationIdentity) {
      await this.assertTestTicketLimits(
        organizationId,
        spaceId,
        dto.task_type_id,
        {
          summary: dto.summary,
          description: sanitizeRichText(dto.description, {
            allowTables: true,
          }),
          estimatedTime: dto.estimated_time ?? null,
          startDate: dto.start_date ?? null,
          dueDate: dto.due_date ?? null,
        },
      );

      const testKind = await this.testTicketKindForRight(
        organizationId,
        spaceId,
        dto.task_type_id,
      );

      if (spaceId && testKind) {
        await this.assertTestTicketRight(
          organizationId,
          userId,
          spaceId,
          testKind,
          'create',
          opts.testRightChecked,
        );
      }
    }

    const row: Record<string, unknown> = {
      // Disjoint identity sources: migration import, support-request retry, inbound email.
      ...(opts.migrationIdentity
        ? { id: opts.migrationIdentity.targetId }
        : {}),
      // Caller-supplied id makes create idempotent: a retry collides on the PK instead of duplicating.
      ...(opts.taskId ? { id: opts.taskId } : {}),
      ...(opts.supportRequestId
        ? { support_request_origin_id: opts.supportRequestId }
        : {}),
      ...(opts.awaitImportCompletion ? { sla_ready: false } : {}),
      organization_id: organizationId,
      space_id: spaceId,
      summary: dto.summary,
      description: sanitizeRichText(dto.description, { allowTables: true }),
      task_type_id: dto.task_type_id,
      parent_task_id: dto.parent_task_id ?? null,
      process_id: dto.process_id ?? null,
      // The legacy bucket, never the raw key — `tasks.status` is CHECK-constrained to six values
      // while `task_statuses.key` is not. `status_id` below carries the real status.
      status: workflowStatusKey ?? status.legacyKey,
      status_id: workflowStatusId ?? status.id,
      // The legacy bucket, never the raw key — `tasks.priority` is CHECK-constrained to six values
      // while `task_priorities.key` is not. `priority_id` below carries the real priority.
      priority: priority.legacyKey,
      priority_id: priority.id,
      assigned_to: dto.assigned_to ?? null,
      reporter: dto.reporter ?? userId,
      due_date: dto.due_date ?? null,
      start_date: dto.start_date ?? null,
      end_date: dto.end_date ?? null,
      estimated_time: dto.estimated_time ?? null,
      duration: dto.duration ?? null,
      progress: dto.progress ?? 0,
      estimated_cost: dto.estimated_cost ?? null,
      custom_field_values: dto.custom_field_values ?? {},
      labels: dto.labels ?? [],
      sort_order: dto.sort_order ?? 0,
      created_by: userId,
      updated_by: userId,
      // Omitted entirely unless a caller replays source timestamps, so the columns keep their
      // defaults for every normal create. See `opts.sourceTimestamps`.
      ...(opts.sourceTimestamps?.createdAt
        ? { created_at: opts.sourceTimestamps.createdAt }
        : {}),
      ...(opts.sourceTimestamps?.updatedAt
        ? { updated_at: opts.sourceTimestamps.updatedAt }
        : {}),
      // Independent spreads on purpose: "resolved on date X" is true even when the resolution
      // NAME could not be mapped, so a missing id must not cost the date.
      ...(opts.resolution?.resolutionId
        ? { resolution_id: opts.resolution.resolutionId }
        : {}),
      ...(opts.resolution?.resolvedAt
        ? { resolved_at: opts.resolution.resolvedAt }
        : {}),
    };

    let created: Task;
    try {
      const r = await this.client
        .from(TasksService.TABLE)
        .insert(row)
        .select()
        .single();
      if (r.error) throw databaseBadRequest(r.error, r.status);
      if (!r.data)
        throw databaseBadRequest(
          { message: 'Task insert returned no row' },
          503,
        );
      created = r.data as Task;
    } catch (error) {
      const code =
        (error as { cause?: { code?: string }; code?: string })?.cause?.code ??
        (error as { code?: string })?.code;
      if (
        opts.migrationIdentity &&
        (databaseRetryClass(error) || code === '23505')
      ) {
        const existing = await this.findMigrationTask(
          organizationId,
          dto,
          opts.migrationIdentity.targetId,
        );
        if (existing) {
          opts.migrationIdentity.onAdopt?.();
          return existing;
        }
      }
      throw error;
    }

    // Log subtask creation on the parent so the parent's history shows it
    if (dto.parent_task_id) {
      void this.logTaskHistory(
        dto.parent_task_id,
        organizationId,
        userId,
        'subtask_created',
        null,
        null,
        { id: created.id, key: created.key, summary: created.summary },
      );
    }

    void this.logAudit(organizationId, userId, 'task', created.id, 'create', {
      summary: created.summary,
      task_type_id: created.task_type_id,
      process_id: created.process_id,
      parent_task_id: created.parent_task_id,
    });

    void this.outboxService?.write(
      organizationId,
      spaceId,
      'app.task.created',
      {
        task: {
          id: created.id,
          key: created.key,
          summary: created.summary,
          status: created.status,
          priority: created.priority,
          assigned_to: created.assigned_to,
          reporter: created.reporter,
          task_type_id: created.task_type_id,
          space_id: spaceId,
          organization_id: organizationId,
          due_date: created.due_date,
          start_date: created.start_date,
          created_at: created.created_at,
          updated_at: created.updated_at,
          created_by: userId,

          // Carried so an automation can read a value the ticket form wrote, e.g.
          // {{ trigger.task.custom_field_values.asset_name }} — the columns above cannot express it.
          custom_field_values: created.custom_field_values ?? {},
        },
        task_id: created.id,
        task_key: created.key,
        space_id: spaceId,
        created_by: userId,
      },
    );

    // Run the workflow's initial-transition post-functions. The task already
    // exists at this point; if a post-function fails, the task survives —
    // we surface the failure as a warning and continue (design decision).
    if (workflowAssignmentId && workflowId && this.engine) {
      try {
        const initialTx = await this.client
          .from('workflow_transitions')
          .select('id')
          .eq('workflow_id', workflowId)
          .eq('kind', 'initial')
          .limit(1)
          .maybeSingle();

        const initialTxId = (initialTx.data as { id?: string } | null)?.id;

        if (initialTxId) {
          await this.engine.runInitialPostFunctions(
            created.id,
            initialTxId,
            await this.buildEngineUser(userId, organizationId),
          );
        }
      } catch (err) {
        this.logger.warn(
          `initial post-function failed for task ${created.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (created.description) {
      void this.notifyMentionedUsers(
        created.description,
        'task',
        created.id,
        created.id,
        created.summary,
        organizationId,
        userId,
        spaceId,
        created.key ?? null,
        'task_mention',
      );
    }

    const testKind = await this.testTicketKind(
      organizationId,
      spaceId,
      dto.task_type_id,
    );

    if (testKind) {
      const event: TestTicketCreatedEvent = {
        organizationId,
        spaceId,
        taskId: created.id,
        kind: testKind,
        summary: created.summary,
        description: created.description ?? null,
        estimatedTime: created.estimated_time ?? null,
        startDate: created.start_date ?? null,
        dueDate: created.due_date ?? null,
        assignedTo: created.assigned_to ?? null,
        userId,
      };

      // Waits so the test record exists when the ticket is returned; the listener logs its own failures.
      await this.eventEmitter?.emitAsync(TEST_TICKET_CREATED_EVENT, event);
    }

    return created;
  }

  // The ticket is already saved, so a failed settings read is only logged.
  private async testTicketKind(
    organizationId: string,
    spaceId: string,
    taskTypeId: string,
  ): Promise<KindTypeColumn | null> {
    if (!this.eventEmitter) return null;

    try {
      const { types, error } = await readTestTaskTypes(
        this.client,
        organizationId,
        spaceId,
      );

      if (error) throw error;

      return types.get(taskTypeId) ?? null;
    } catch (error) {
      const message = (error as { message?: string }).message ?? String(error);

      this.logger.warn(
        `Test task types of space ${spaceId} not read: ${message}`,
      );

      return null;
    }
  }

  /** Refuses ticket text a test case or set cannot hold, so both sides always stay equal. */
  private async assertTestTicketLimits(
    organizationId: string,
    spaceId: string | null,
    taskTypeId: string | null | undefined,
    fields: TestTicketFieldChanges,
  ): Promise<void> {
    if (!spaceId || !taskTypeId) return;

    const kind = await this.testTicketKind(organizationId, spaceId, taskTypeId);

    if (
      kind === 'case_task_type_id' ||
      kind === 'set_task_type_id' ||
      kind === 'plan_task_type_id'
    ) {
      checkTestTicketFields(kind, fields);
    }

    if (kind === 'plan_task_type_id') {
      checkPlanTicketDates(fields.startDate, fields.dueDate);
    }
  }

  /** Test kind of a ticket type; unlike testTicketKind a failed settings read stops the write instead of letting it through. */
  private async testTicketKindForRight(
    organizationId: string,
    spaceId: string | null,
    taskTypeId: string | null | undefined,
  ): Promise<KindTypeColumn | null> {
    // Same seam as testTicketKind: without the event bus Test Management is not wired in.
    if (!spaceId || !taskTypeId || !this.eventEmitter) return null;

    const { types, error } = await readTestTaskTypes(
      this.client,
      organizationId,
      spaceId,
    );

    if (error) {
      this.logger.warn(
        `Test task types of space ${spaceId} not read: ${error.message}`,
      );
      throw new BadRequestException(
        'The Test Management settings of this space could not be read. Please try again.',
      );
    }

    return types.get(taskTypeId) ?? null;
  }

  /** Refuses a create, edit or delete of a test ticket the user has no Test Management right for. */
  private async assertTestTicketRight(
    organizationId: string,
    userId: string | undefined,
    spaceId: string,
    kind: KindTypeColumn,
    action: 'create' | 'edit' | 'delete',
    rightChecked = false,
  ): Promise<void> {
    // Delete stays possible while the module is off, so old test tickets can still be removed.
    if (action !== 'delete') {
      if (!this.testManagementAccess) {
        throw new ForbiddenException('Test Management is not available');
      }

      await this.testManagementAccess.assertAvailable(organizationId, spaceId, {
        write: true,
      });
    }

    if (rightChecked) return;

    const permission =
      action === 'create'
        ? KIND_CREATE_PERMISSION[kind]
        : action === 'edit'
          ? KIND_EDIT_PERMISSION[kind]
          : 'delete_tests';
    const allowed =
      !!userId &&
      (await this.requirePermissionsService().hasSpacePermission(
        userId,
        organizationId,
        spaceId,
        permission,
      ));

    if (!allowed) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: `You do not have permission to ${action} this test item.`,
      });
    }
  }

  /** Ids among `ids` whose type is a Test Management type in their space. */
  private async testTicketIds(
    organizationId: string,
    ids: string[],
  ): Promise<Set<string>> {
    const found = new Set<string>();

    if (!ids.length || !this.eventEmitter) return found;

    const { data, error } = await this.client
      .from(TasksService.TABLE)
      .select('id, space_id, task_type_id')
      .in('id', ids)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    const rows = (data ?? []) as {
      id: string;
      space_id: string | null;
      task_type_id: string | null;
    }[];
    const kindsBySpace = new Map<string, Map<string, KindTypeColumn>>();

    for (const row of rows) {
      if (!row.space_id || !row.task_type_id) continue;

      let types = kindsBySpace.get(row.space_id);

      if (!types) {
        const read = await readTestTaskTypes(
          this.client,
          organizationId,
          row.space_id,
        );

        if (read.error) {
          throw new BadRequestException(
            'The Test Management settings of this space could not be read. Please try again.',
          );
        }

        types = read.types;
        kindsBySpace.set(row.space_id, types);
      }

      if (types.has(row.task_type_id)) found.add(row.id);
    }

    return found;
  }

  /**
   * Checks an update of a test ticket before anything is written: its type and space stay fixed, and changed
   * shared fields must fit its test case or set. Returns the change to send on, or null when nothing syncs.
   */
  private async prepareTestTicketSync(
    organizationId: string,
    userId: string,
    before: Task,
    patch: Record<string, unknown>,
    testRightChecked = false,
  ): Promise<TestTicketUpdatedEvent | null> {
    if (!this.eventEmitter || !before.space_id) return null;

    const typeChange =
      patch.task_type_id !== undefined &&
      patch.task_type_id !== before.task_type_id;
    const spaceChange =
      patch.space_id !== undefined && patch.space_id !== before.space_id;
    const changes: TestTicketFieldChanges = {};

    if (patch.summary !== undefined && patch.summary !== before.summary) {
      changes.summary = patch.summary as string;
      changes.previousSummary = before.summary;
    }

    if (
      patch.description !== undefined &&
      patch.description !== before.description
    ) {
      changes.description = (patch.description as string | null) ?? null;
    }

    if (
      patch.estimated_time !== undefined &&
      patch.estimated_time !== before.estimated_time
    ) {
      changes.estimatedTime = (patch.estimated_time as number | null) ?? null;
    }

    if (
      patch.start_date !== undefined &&
      patch.start_date !== before.start_date
    ) {
      changes.startDate = (patch.start_date as string | null) ?? null;
    }

    if (patch.due_date !== undefined && patch.due_date !== before.due_date) {
      changes.dueDate = (patch.due_date as string | null) ?? null;
    }

    if (
      patch.assigned_to !== undefined &&
      (patch.assigned_to ?? null) !== (before.assigned_to ?? null)
    ) {
      changes.assignedTo = (patch.assigned_to as string | null) ?? null;
    }

    // Most edits touch none of this, so the settings are read only when needed.
    if (!typeChange && !spaceChange && Object.keys(changes).length === 0) {
      return null;
    }

    const { types, error } = await readTestTaskTypes(
      this.client,
      organizationId,
      before.space_id,
    );

    if (error) {
      this.logger.warn(
        `Test task types of space ${before.space_id} not read: ${error.message}`,
      );

      return null;
    }

    const kind = before.task_type_id
      ? (types.get(before.task_type_id) ?? null)
      : null;

    if (typeChange && (kind || types.has(patch.task_type_id as string))) {
      throw new ConflictException({
        code: 'TEST_TYPE_LOCKED',
        message:
          'The type of a Test Management ticket cannot be changed, and a task cannot be changed into a Test Management type.',
      });
    }

    if (spaceChange && kind) {
      throw new ConflictException({
        code: 'TEST_SPACE_LOCKED',
        message: 'A Test Management ticket cannot be moved to another space.',
      });
    }

    if (spaceChange) {
      const { count, error: linkError } = await this.client
        .from('test_ticket_links')
        .select('id', { count: 'exact', head: true })
        .eq('task_id', before.id)
        .eq('organization_id', organizationId);

      if (linkError) {
        this.logger.warn(
          `Test links of ticket ${before.id} not read: ${linkError.message}`,
        );
        throw new BadRequestException(
          'The test links of this ticket could not be checked. Please try again.',
        );
      }

      if (count) {
        throw new ConflictException({
          code: 'TEST_LINKS_SPACE_LOCKED',
          message:
            'This ticket is linked to test items. Unlink them before moving it to another space.',
        });
      }
    }

    if (
      kind !== 'case_task_type_id' &&
      kind !== 'set_task_type_id' &&
      kind !== 'plan_task_type_id' &&
      kind !== 'execution_task_type_id' &&
      kind !== 'precondition_task_type_id'
    ) {
      return null;
    }

    // A precondition shares only its title with its ticket.
    if (kind === 'precondition_task_type_id') delete changes.description;

    // Sets and plans have no estimate, and only test cases share the assignee.
    if (kind !== 'case_task_type_id') {
      delete changes.estimatedTime;
      delete changes.assignedTo;
    }

    // Only plans have dates.
    if (kind !== 'plan_task_type_id') {
      delete changes.startDate;
      delete changes.dueDate;
    }

    if (Object.keys(changes).length === 0) return null;

    // Only real changes of shared test fields need the Test Management right.
    await this.assertTestTicketRight(
      organizationId,
      userId,
      before.space_id,
      kind,
      'edit',
      testRightChecked,
    );

    const linked = await this.client
      .from(
        kind === 'case_task_type_id'
          ? 'test_cases'
          : kind === 'set_task_type_id'
            ? 'test_sets'
            : kind === 'plan_task_type_id'
              ? 'test_plans'
              : kind === 'precondition_task_type_id'
                ? 'test_preconditions'
                : 'test_executions',
      )
      .select('id')
      .eq('task_id', before.id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (linked.error) throw new BadRequestException(linked.error.message);

    // Older tickets without a test record have nothing to keep in step.
    if (!linked.data) return null;

    checkTestTicketFields(kind, changes);

    if (kind === 'plan_task_type_id') {
      checkPlanTicketDates(
        'startDate' in changes ? changes.startDate : before.start_date,
        'dueDate' in changes ? changes.dueDate : before.due_date,
      );
    }

    return {
      organizationId,
      spaceId: before.space_id,
      taskId: before.id,
      kind,
      userId,
      changes,
    };
  }

  /** Sends the ticket's change to its test record; when that fails the ticket's shared fields are put back. */
  private async syncTestTicket(
    sync: TestTicketUpdatedEvent | null,
    id: string,
    organizationId: string,
    before: Task,
  ): Promise<void> {
    if (!sync || !this.eventEmitter) return;

    try {
      await this.eventEmitter.emitAsync(TEST_TICKET_UPDATED_EVENT, sync);
    } catch (error) {
      const restore: Record<string, unknown> = {};

      if ('summary' in sync.changes) restore.summary = before.summary;
      if ('description' in sync.changes) {
        restore.description = before.description;
      }
      if ('estimatedTime' in sync.changes) {
        restore.estimated_time = before.estimated_time;
      }
      if ('startDate' in sync.changes) restore.start_date = before.start_date;
      if ('dueDate' in sync.changes) restore.due_date = before.due_date;
      if ('assignedTo' in sync.changes) {
        restore.assigned_to = before.assigned_to;
      }

      const undo = await this.client
        .from(TasksService.TABLE)
        .update(restore)
        .eq('id', id)
        .eq('organization_id', organizationId);

      if (undo.error) {
        this.logger.error(
          `Ticket ${id} could not be put back after its test record failed to update: ${undo.error.message}`,
        );
      }

      throw error;
    }
  }

  /** Exact identity only: never overwrite migrated content or replay creation effects. */
  private async findMigrationTask(
    organizationId: string,
    dto: CreateTaskDto,
    targetId: string,
  ): Promise<Task | null> {
    const r = await this.client
      .from(TasksService.TABLE)
      .select('*')
      .eq('id', targetId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (r.error) throw databaseBadRequest(r.error, r.status);
    if (!r.data) return null;
    const task = r.data as Task;
    if (
      task.organization_id !== organizationId ||
      task.space_id !== (dto.space_id ?? dto.spaceId) ||
      task.task_type_id !== dto.task_type_id ||
      task.parent_task_id !== (dto.parent_task_id ?? null)
    ) {
      throw new ConflictException(
        'Migration task identity does not match organization, space, type or parent; reconcile the target explicitly',
      );
    }
    return task;
  }

  // ------------------------------------------------------------------
  // Update
  // ------------------------------------------------------------------

  async update(
    id: string,
    organizationId: string,
    userId: string,
    dto: UpdateTaskDto,
    opts: { testRightChecked?: boolean } = {},
  ): Promise<Task> {
    const { title: legacyTitle, ...updateDto } = dto;
    delete (updateDto as Record<string, unknown>)['organizationId'];
    const before = await this.getById(id, organizationId);
    const patch: Record<string, unknown> = { updated_by: userId };
    for (const key of [
      'summary',
      'description',
      'task_type_id',
      'parent_task_id',
      'process_id',
      'space_id',
      'status',
      'status_id',
      'priority',
      'priority_id',
      'resolution_id',
      'assigned_to',
      'reporter',
      'due_date',
      'start_date',
      'end_date',
      'estimated_time',
      'actual_time',
      'duration',
      'progress',
      'estimated_cost',
      'actual_cost',
      'planned_budget',
      'custom_field_values',
      'labels',
      'sort_order',
    ] as const) {
      if (updateDto[key] !== undefined) patch[key] = updateDto[key];
    }

    if (legacyTitle !== undefined && patch.summary === undefined) {
      patch.summary = legacyTitle;
    }

    if (updateDto.description !== undefined) {
      patch.description = sanitizeRichText(updateDto.description, {
        allowTables: true,
      });
    }

    const issueGroupFields = await this.assertIssueGroupValues(
      organizationId,
      (patch.space_id as string | undefined) ?? before.space_id,
      patch.custom_field_values as Record<string, unknown> | undefined,
      before.custom_field_values,
    );

    const writeContext = await this.validateUpdateTaskPatch(
      id,
      organizationId,
      before,
      patch,
    );
    const testSync = await this.prepareTestTicketSync(
      organizationId,
      userId,
      before,
      patch,
      opts.testRightChecked,
    );

    if (typeof patch.status === 'string' && !patch.status_id) {
      const statusId = await this.resolveStatusId(
        organizationId,
        writeContext.effectiveSpaceId,
        patch.status,
      );
      if (statusId) patch.status_id = statusId;
    }

    if (typeof patch.priority === 'string' && !patch.priority_id) {
      const row = await this.resolvePriorityRowByKey(
        organizationId,
        writeContext.effectiveSpaceId,
        patch.priority,
      );
      if (row.id) patch.priority_id = row.id;
      // Bucket the caller's raw key: `tasks.priority` is CHECK-constrained, `task_priorities.key`
      // is not, so a custom or localized key would otherwise raise 23514.
      patch.priority = row.legacyKey;
    }

    if (typeof patch.status === 'string' && patch.status !== before.status) {
      patch.completed_at =
        patch.status === 'done' || patch.status === 'closed'
          ? new Date().toISOString()
          : null;
    }

    // ------------------------------------------------------------------
    // Engine routing (Prompt 6 — Phase I)
    // ------------------------------------------------------------------
    // When a workflow assignment exists for the task's effective type, the
    // engine owns status transitions: it runs validators, post-functions,
    // bumps task.version, and writes the workflow audit row. We split the
    // patch so status fields flow through the engine and any remaining
    // fields are persisted by a second targeted UPDATE.
    const isStatusChange =
      typeof patch.status_id === 'string' &&
      patch.status_id !== before.status_id;

    // Manual resolution_id edits are rejected alongside ANY status change —
    // with or without a workflow assignment. The engine (when present) writes
    // resolution_id/resolved_at itself via set_resolution/clear_resolution
    // AFTER this point, so a manual value here would either read a
    // not-yet-transitioned status or be clobbered by the post-function. The
    // sidebar never sends both in one request.
    if (patch.resolution_id !== undefined && isStatusChange) {
      throw new BadRequestException(
        'resolution_id cannot be changed in the same request as a status change',
      );
    }

    if (
      patch.resolution_id !== undefined &&
      patch.resolution_id !== before.resolution_id
    ) {
      if (patch.resolution_id !== null) {
        // Same-org guard held back from this field until now — see the
        // note on `create()`'s `opts.resolution` above. `resolution_id`'s
        // FK does not enforce same-organization, so a client-facing DTO
        // must check it explicitly.
        const resRow = await this.client
          .from('resolutions')
          .select('id, is_active')
          .eq('id', patch.resolution_id as string)
          .eq('organization_id', organizationId)
          .maybeSingle();

        if (resRow.error) throw new BadRequestException(resRow.error.message);
        if (!resRow.data) {
          throw new BadRequestException(
            'Resolution not found in this organization',
          );
        }
        if (!(resRow.data as { is_active: boolean }).is_active) {
          throw new BadRequestException('Resolution is not active');
        }
      }
      patch.resolved_at =
        patch.resolution_id === null ? null : new Date().toISOString();
    }

    if (isStatusChange && this.engine && this.assignments) {
      // SVC-H1: reuse the assignment looked up in validateUpdateTaskPatch
      // (single query — avoids a duplicate findActiveAssignmentForType call).
      const assignment = writeContext.workflowAssignment;

      if (assignment) {
        const engineUser = await this.buildEngineUser(userId, organizationId);
        // 1. Resolve which transition drives the requested status change.
        const resolution = await this.engine.resolveTransitionByStatusChange(
          id,
          patch.status_id as string,
          engineUser,
        );

        if ('error' in resolution) {
          if (resolution.error === 'condition_failed') {
            // A transition connects current→target but a workflow condition
            // blocked it. Mirror the engine's Step-6 403 so the status change
            // is refused rather than force-written.
            throw new ForbiddenException(
              'Status change blocked by a workflow condition on this transition',
            );
          }
          if (resolution.error === 'no_path') {
            const targetLabel =
              typeof patch.status === 'string'
                ? patch.status
                : (patch.status_id as string);

            throw new UnprocessableEntityException(
              `No valid transition from current status to "${targetLabel}"`,
            );
          }
          throw new ConflictException({
            message:
              'Ambiguous status change; use POST /tasks/:id/transitions/:transitionId',
            data: { candidates: resolution.candidates },
          });
        }

        // 2. Split the patch:
        //    - status fields (`status`, `status_id`, `completed_at`) → engine
        //      handles the transition + version bump.
        //    - `custom_field_values` → engine.screenInput so validators see
        //      the fresh field state before deciding pass/fail. The engine
        //      then writes them as part of its status update (Step 9 filter
        //      applies if the transition has a screen_field_group_id).
        //      B5 fix — previously routed via otherPatch, causing validators
        //      to read stale values.
        //    - everything else (summary, description, priority_id, parent,
        //      assigned_to, etc.) → otherPatch, applied via a second UPDATE
        //      after the engine returns.
        const STATUS_KEYS = new Set([
          'status',
          'status_id',
          'completed_at',
          'custom_field_values',
        ]);
        const otherPatch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) {
          if (STATUS_KEYS.has(k)) continue;
          otherPatch[k] = v;
        }

        const screenInput: Record<string, unknown> =
          (patch.custom_field_values as Record<string, unknown> | undefined) ??
          {};

        // 3. Execute the engine transition. Engine handles version bump,
        // workflow audit row, and post-functions on its own.
        await this.engine.executeTransition({
          taskId: id,
          transitionId: resolution.transition.id,
          screenInput,
          user: engineUser,
          notifyWatchers: false,
        });

        // 4. Persist remaining non-status fields, if any. We never log a
        // duplicate audit row for the status change — engine owned that.
        if (Object.keys(otherPatch).length > 1) {
          // `updated_by` is always present; we only run the UPDATE when
          // there are real field changes beyond the bookkeeping column.
          const r2 = await this.client
            .from(TasksService.TABLE)
            .update(otherPatch)
            .eq('id', id)
            .eq('organization_id', organizationId)
            .select()
            .single();

          if (r2.error) throw new BadRequestException(r2.error.message);
        }

        await this.syncTestTicket(testSync, id, organizationId, before);

        // The workflow engine emits the committed status-change event. Keep
        // the remaining non-status notifications owned by this update path.
        const fresh = await this.getById(id, organizationId);

        if (fresh.assigned_to !== before.assigned_to) {
          this.emitTaskAssigned(organizationId, before, fresh, userId);
        }

        this.emitTaskUpdated(organizationId, fresh, Object.keys(patch), userId);
        void this.notifyTaskWatchers(
          fresh,
          organizationId,
          userId,
          'task_updated',
        );

        if (updateDto.description !== undefined) {
          void this.notifyMentionedUsers(
            (patch.description as string | null) ?? '',
            'task',
            id,
            id,
            before.summary,
            organizationId,
            userId,
            before.space_id,
            before.key,
            'task_mention',
            before.description,
          );
        }

        return fresh;
      }
    }

    const r = await this.client
      .from(TasksService.TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const updated = r.data as Task;

    await this.syncTestTicket(testSync, id, organizationId, before);

    // DB trigger handles: status, priority, assigned_to, due_date.
    // Only log fields the trigger does NOT cover.
    const appTracked: Array<keyof Task> = [
      'summary',
      'description',
      'task_type_id',
      'process_id',
      'reporter',
      'resolution_id',
      'start_date',
      'end_date',
      'estimated_time',
      'actual_time',
      'duration',
      'progress',
      'parent_task_id',
      'labels',
    ];
    this.logIssueGroupChanges(
      id,
      organizationId,
      userId,
      issueGroupFields,
      before.custom_field_values,
      updated.custom_field_values,
    );
    for (const field of appTracked) {
      if (field in patch && before[field] !== updated[field]) {
        if (field === 'parent_task_id') {
          const [oldMeta, newMeta] = await Promise.all([
            this.getTaskHistoryRef(before[field]),
            this.getTaskHistoryRef(updated[field]),
          ]);
          void this.logTaskHistory(
            id,
            organizationId,
            userId,
            'update',
            field,
            oldMeta,
            newMeta,
          );
        } else {
          void this.logTaskHistory(
            id,
            organizationId,
            userId,
            'update',
            field,
            before[field],
            updated[field],
          );
        }
      }
    }

    void this.logAudit(organizationId, userId, 'task', id, 'update', {
      changes: patch,
    });

    if (updated.status_id !== before.status_id) {
      this.emitTaskStatusChanged(organizationId, before, updated, userId);
    }

    if (updated.assigned_to !== before.assigned_to) {
      this.emitTaskAssigned(organizationId, before, updated, userId);
    }

    this.emitTaskUpdated(organizationId, updated, Object.keys(patch), userId);
    void this.notifyTaskWatchers(
      updated,
      organizationId,
      userId,
      'task_updated',
    );

    if (updateDto.description !== undefined) {
      void this.notifyMentionedUsers(
        (patch.description as string | null) ?? '',
        'task',
        id,
        id,
        before.summary,
        organizationId,
        userId,
        before.space_id,
        before.key,
        'task_mention',
        before.description,
      );
    }

    return updated;
  }

  // ------------------------------------------------------------------
  // Outbox event emitters for non-workflow updates.
  // ------------------------------------------------------------------

  private emitTaskStatusChanged(
    organizationId: string,
    before: Task,
    after: Task,
    userId: string,
  ): void {
    this.outboxService?.emitTaskStatusChanged(
      organizationId,
      before,
      after,
      userId,
    );
  }

  private emitTaskAssigned(
    organizationId: string,
    before: Task,
    after: Task,
    userId: string,
  ): void {
    void this.outboxService?.write(
      organizationId,
      after.space_id,
      'app.task.assigned',
      {
        task: {
          id: after.id,
          key: after.key,
          summary: after.summary,
          status: after.status,
          priority: after.priority,
          assigned_to: after.assigned_to,
          space_id: after.space_id,
          organization_id: organizationId,
        },
        assignedUserId: after.assigned_to,
        task_id: after.id,
        task_key: after.key,
        space_id: after.space_id,
        old_assigned_to: before.assigned_to,
        new_assigned_to: after.assigned_to,
        updated_by: userId,
      },
    );
  }

  private emitTaskUpdated(
    organizationId: string,
    after: Task,
    changedFields: string[],
    userId: string,
  ): void {
    void this.outboxService?.write(
      organizationId,
      after.space_id,
      'app.task.updated',
      {
        task: {
          id: after.id,
          key: after.key,
          summary: after.summary,
          status: after.status,
          priority: after.priority,
          assigned_to: after.assigned_to,
          reporter: after.reporter,
          task_type_id: after.task_type_id,
          space_id: after.space_id,
          organization_id: organizationId,
          due_date: after.due_date,
          start_date: after.start_date,
          created_at: after.created_at,
          updated_at: after.updated_at,
          created_by: after.created_by,

          // Same as app.task.created — lets an automation read a ticket's custom field value.
          custom_field_values: after.custom_field_values ?? {},
        },
        task_id: after.id,
        changedFields,
        updated_by: userId,
      },
    );
  }

  // ------------------------------------------------------------------
  // Delete (cascade)
  // ------------------------------------------------------------------

  async delete(
    id: string,
    organizationId: string,
    userId?: string,
    opts: { testRecordDeleted?: boolean } = {},
  ): Promise<void> {
    const task = await this.getById(id, organizationId);

    // The database does not delete a plan with its ticket, so Test Management checks and deletes it first.
    if (!opts.testRecordDeleted) {
      const testKind = await this.testTicketKindForRight(
        organizationId,
        task.space_id,
        task.task_type_id,
      );

      if (task.space_id && testKind) {
        await this.assertTestTicketRight(
          organizationId,
          userId,
          task.space_id,
          testKind,
          'delete',
        );
      }

      await this.eventEmitter?.emitAsync(TEST_TICKET_DELETING_EVENT, {
        organizationId,
        taskId: id,
        userId: userId ?? null,
      } satisfies TestTicketDeletingEvent);
    }

    const deleted = await this.client.rpc('delete_task_cascade', {
      p_task_id: id,
      p_organization_id: organizationId,
    });

    // A linked test case with execution results blocks its ticket's delete.
    if (
      deleted.error?.code === '23503' &&
      deleted.error.message.includes('test_runs')
    ) {
      throw new ConflictException(
        "This ticket's test case has execution results, so the ticket cannot be deleted.",
      );
    }

    if (deleted.error) throw new BadRequestException(deleted.error.message);

    await this.afterCascadeDelete(organizationId, task, userId, deleted.data);
  }

  /**
   * What follows delete_task_cascade: its stored files go, subscribers hear `app.task.deleted`,
   * the delete is in the audit log. Also called by Robert's Undo, which deletes through the same
   * function under its own locks.
   */
  async afterCascadeDelete(
    organizationId: string,
    task: { id: string; key: string; summary: string; space_id: string },
    userId: string | undefined,
    deleteResult: unknown,
  ): Promise<void> {
    const id = task.id;
    await this.removeTaskAttachmentStorageObjects(
      this.extractStoragePathsFromDeleteResult(deleteResult),
    );

    void this.outboxService?.write(
      organizationId,
      task.space_id,
      'app.task.deleted',
      {
        task: {
          id,
          key: task.key,
          summary: task.summary,
          space_id: task.space_id,
          organization_id: organizationId,
        },
        taskId: id,
        task_id: id,
        task_key: task.key,
        space_id: task.space_id,
        deleted_by: userId ?? null,
      },
    );

    if (userId) {
      void this.logAudit(organizationId, userId, 'task', id, 'delete', {
        summary: task.summary,
      });
    }
  }

  // Errors reach Test Management, so the test record is only deleted together with its ticket.
  @OnEvent(TEST_RECORD_DELETED_EVENT, { suppressErrors: false })
  async onTestRecordDeleted(event: TestRecordDeletedEvent): Promise<void> {
    // Deleting the test record deletes its ticket, so the user needs the task delete right too.
    const allowed = await this.requirePermissionsService().checkPermission(
      event.userId,
      event.organizationId,
      'can_delete_tasks',
    );

    if (!allowed) {
      throw new ForbiddenException({
        code: 'TICKET_DELETE_FORBIDDEN',
        message:
          'You need permission to delete tasks to delete a test record that has a ticket.',
      });
    }

    // The database removes the test record with the ticket.
    await this.delete(event.taskId, event.organizationId, event.userId, {
      testRecordDeleted: true,
    });
  }

  // Test Management changed a shared field; the ticket takes it through the normal update, so its history,
  // audit log, watchers and automations run as for any edit.
  @OnEvent(TEST_RECORD_UPDATED_EVENT, { suppressErrors: false })
  async onTestRecordUpdated(event: TestRecordUpdatedEvent): Promise<void> {
    const dto: UpdateTaskDto = {};

    if (event.changes.summary !== undefined) {
      dto.summary = event.changes.summary;
    }
    if (event.changes.description !== undefined) {
      dto.description = event.changes.description ?? '';
    }
    if (event.changes.estimatedTime !== undefined) {
      (dto as Record<string, unknown>).estimated_time =
        event.changes.estimatedTime;
    }
    if (event.changes.startDate !== undefined) {
      dto.start_date = event.changes.startDate;
    }
    if (event.changes.dueDate !== undefined) {
      dto.due_date = event.changes.dueDate;
    }
    if (event.changes.assignedTo !== undefined) {
      dto.assigned_to = event.changes.assignedTo;
    }

    if (Object.keys(dto).length === 0) return;

    await this.update(event.taskId, event.organizationId, event.userId, dto, {
      testRightChecked: true,
    });

    // The "my tasks" editor detects concurrent edits by version.
    const current = await this.client
      .from(TasksService.TABLE)
      .select('version')
      .eq('id', event.taskId)
      .eq('organization_id', event.organizationId)
      .maybeSingle<{ version: number | null }>();

    if (current.error) throw new BadRequestException(current.error.message);

    const bumped = await this.client
      .from(TasksService.TABLE)
      .update({ version: (current.data?.version ?? 0) + 1 })
      .eq('id', event.taskId)
      .eq('organization_id', event.organizationId);

    if (bumped.error) throw new BadRequestException(bumped.error.message);
  }

  // ------------------------------------------------------------------
  // Comments
  // ------------------------------------------------------------------

  async getComments(
    taskId: string,
    organizationId: string,
    sort?: TaskCommentSort,
  ): Promise<unknown[]> {
    await this.getById(taskId, organizationId);
    const r = await this.client
      .from(TasksService.COMMENTS_TABLE)
      .select(
        '*, author:users!created_by(id, first_name, last_name, email, avatar_url), editor:users!edited_by(id, first_name, last_name)',
      )
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      .is('support_request_id', null)
      .order('created_at', { ascending: true });
    if (r.error) throw new BadRequestException(r.error.message);
    // Name and text orders need the joined author and plain text, so the sort runs here
    if (sort && sort !== 'oldest') {
      return sortTaskComments((r.data ?? []) as Record<string, never>[], sort);
    }
    return (r.data ?? []) as Record<string, unknown>[];
  }

  /**
   * What the caller may do with comments on a task, resolved by the same checks as
   * {@link updateComment} and {@link deleteComment}, so the UI never offers an action the API refuses.
   *
   * @param {string} taskId - Task whose comments are listed
   * @param {string} organizationId - The caller's active organization
   * @param {string} userId - `public.users.id` of the caller
   * @returns {Promise<{ can_edit_own: boolean; can_delete_own: boolean; can_edit_others: boolean; can_delete_others: boolean }>} Own- and others-comment rights
   */
  async getCommentPermissions(
    taskId: string,
    organizationId: string,
    userId: string,
  ): Promise<{
    can_edit_own: boolean;
    can_delete_own: boolean;
    can_edit_others: boolean;
    can_delete_others: boolean;
  }> {
    const task = await this.getById(taskId, organizationId);
    const permissions = this.requirePermissionsService();
    const has = (key: string): Promise<boolean> =>
      permissions.hasOrgOrSpacePermission(
        userId,
        organizationId,
        key,
        task.space_id,
      );
    const [can_edit_own, can_delete_own, can_edit_others, can_delete_others] =
      await Promise.all([
        has('can_add_comments_tasks'),
        has('can_delete_comments_tasks'),
        has('can_edit_others_comments_tasks'),
        has('can_delete_others_comments_tasks'),
      ]);

    return { can_edit_own, can_delete_own, can_edit_others, can_delete_others };
  }

  private async notifyMentionedUsers(
    html: string,
    referenceType: string,
    referenceId: string,
    entityId: string,
    entityName: string,
    orgId: string,
    mentionedByUserId: string,
    spaceId?: string | null,
    entityKey?: string | null,
    notifType = 'comment_mention',
    oldHtml?: string | null,
  ): Promise<void> {
    const newIds = extractUserMentionIds(html);

    if (!newIds.length) return;

    // On UPDATE, only notify users who are newly mentioned (not in the old content).
    const oldIds = new Set(oldHtml ? extractUserMentionIds(oldHtml) : []);
    const userIds = newIds.filter((id) => !oldIds.has(id));

    if (!userIds.length) return;

    const { data: members } = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', orgId)
      .in('user_id', userIds);

    const validIds = ((members ?? []) as { user_id: string }[]).map(
      (m) => m.user_id,
    );
    const toNotify = validIds.filter((id) => id !== mentionedByUserId);

    if (!toNotify.length) return;

    let spaceKey: string | null = null;

    if (spaceId) {
      const spaceRes = await this.client
        .from('spaces')
        .select('key')
        .eq('id', spaceId)
        .maybeSingle();

      spaceKey = (spaceRes.data as { key?: string } | null)?.key ?? null;
    }

    // Fetch the mentioner's display name for the notification title.
    const { data: mentioner } = await this.client
      .from('users')
      .select('first_name, last_name')
      .eq('id', mentionedByUserId)
      .maybeSingle();

    const mentionerName = mentioner
      ? `${(mentioner as { first_name?: string | null }).first_name ?? ''} ${(mentioner as { last_name?: string | null }).last_name ?? ''}`.trim() ||
        'Someone'
      : 'Someone';

    const rawText = html.replace(/<[^>]+>/g, '').slice(0, 200);
    const body = rawText.replace(/@/g, '').replace(/\s+/g, ' ').trim() || null;

    const { data: insertedNotifs, error: insertError } = await this.client
      .from('notifications')
      .insert(
        toNotify.map((userId) => ({
          organization_id: orgId,
          user_id: userId,
          type: notifType,
          title:
            notifType === 'task_mention'
              ? `${mentionerName} mentioned you in "${entityName || 'a task'}"`
              : `${mentionerName} mentioned you in a comment`,
          body,
          is_read: false,
          reference_type: referenceType,
          reference_id: referenceId,
          metadata: {
            mentioned_by_user_id: mentionedByUserId,
            mentioner_name: mentionerName,
            entity_id: entityId,
            entity_name: entityName,
            ...(spaceKey && { space_key: spaceKey }),
            ...(entityKey && { entity_key: entityKey }),
          },
        })),
      )
      .select();

    if (insertError) {
      console.error(
        '[notifyMentionedUsers] INSERT failed:',
        insertError.message,
        insertError,
      );
    } else if (insertedNotifs) {
      for (const notif of insertedNotifs) {
        void this.notificationsBroadcast?.broadcastNotification(
          notif as Record<string, unknown>,
        );
      }
      void this.notificationEmail?.emailForNotifications(
        insertedNotifs as Record<string, unknown>[],
      );
    }
  }

  async createComment(
    taskId: string,
    organizationId: string,
    userId: string,
    content: string,
    extra?: { support_request_id?: string; author_id?: string },
  ): Promise<unknown> {
    const task = await this.getById(taskId, organizationId);
    const sanitizedContent =
      sanitizeRichText(content, { allowTables: true }) ?? '';
    const r = await this.client
      .from(TasksService.COMMENTS_TABLE)
      .insert({
        task_id: taskId,
        organization_id: organizationId,
        content: sanitizedContent,
        created_by: userId,
        ...(extra?.support_request_id
          ? { support_request_id: extra.support_request_id }
          : {}),
        ...(extra?.author_id ? { created_by: extra.author_id } : {}),
      })
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    void this.logTaskHistory(
      taskId,
      organizationId,
      userId,
      'comment_added',
      null,
      null,
      {
        content: (r.data as { content?: string })?.content?.substring(0, 100),
      },
    );
    void this.logAudit(organizationId, userId, 'task', taskId, 'update', {
      action_type: 'comment_add',
      comment_id: (r.data as { id?: string })?.id,
      ...(extra?.author_id ? { on_behalf_of: extra.author_id } : {}),
    });
    void this.outboxService?.write(
      organizationId,
      task.space_id,
      'app.task.comment_added',
      {
        task: {
          id: task.id,
          key: task.key,
          summary: task.summary,
          status: task.status,
          priority: task.priority,
          assigned_to: task.assigned_to,
          space_id: task.space_id,
          organization_id: organizationId,
        },
        comment: {
          id: (r.data as { id?: string })?.id ?? null,
          body: (r.data as { content?: string })?.content ?? '',
          author_id: userId,
          ...(extra?.author_id ? { author_id: extra.author_id } : {}),
        },
        task_id: taskId,
        task_key: task.key,
        space_id: task.space_id,
        comment_id: (r.data as { id?: string })?.id ?? null,
        created_by: userId,
      },
    );
    const commentId = (r.data as { id?: string })?.id;

    if (commentId) {
      void this.notifyMentionedUsers(
        sanitizedContent,
        'task_comment',
        commentId,
        task.id,
        task.summary,
        organizationId,
        userId,
        task.space_id,
        task.key,
      );
    }
    void this.notifyTaskWatchers(task, organizationId, userId, 'comment_added');

    return r.data;
  }

  private notifyTaskWatchers(
    task: Task,
    organizationId: string,
    actorUserId: string,
    changeKind: string,
  ): Promise<void> | undefined {
    return this.watchersService?.notifyTaskWatchers({
      organizationId,
      spaceId: task.space_id,
      taskId: task.id,
      actorUserId,
      taskKey: task.key,
      title: task.summary,
      changeKind,
    });
  }

  async updateComment(
    taskId: string,
    commentId: string,
    organizationId: string,
    userId: string,
    content: string,
  ): Promise<unknown> {
    const task = await this.getById(taskId, organizationId);
    const existing = await this.client
      .from(TasksService.COMMENTS_TABLE)
      .select('*')
      .eq('id', commentId)
      .eq('task_id', taskId)
      .maybeSingle();
    if (!existing.data) throw new NotFoundException('Comment not found');
    const comment = existing.data as { created_by: string; content?: string };
    const isAuthor = comment.created_by === userId;
    const allowed =
      await this.requirePermissionsService().hasOrgOrSpacePermission(
        userId,
        organizationId,
        isAuthor ? 'can_add_comments_tasks' : 'can_edit_others_comments_tasks',
        task.space_id,
      );
    if (!allowed) {
      throw new ForbiddenException(
        isAuthor
          ? 'You do not have permission to edit comments'
          : 'You do not have permission to edit comments of other users',
      );
    }
    const oldPreview =
      comment.content?.replace(/<[^>]+>/g, '').substring(0, 100) ?? '';
    const sanitizedContent =
      sanitizeRichText(content, { allowTables: true }) ?? '';
    const r = await this.client
      .from(TasksService.COMMENTS_TABLE)
      .update({
        content: sanitizedContent,
        edited_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', commentId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const newPreview = sanitizedContent
      .replace(/<[^>]+>/g, '')
      .substring(0, 100);
    void this.logTaskHistory(
      taskId,
      organizationId,
      userId,
      'comment_updated',
      null,
      { comment_id: commentId, content_preview: oldPreview },
      { comment_id: commentId, content_preview: newPreview },
    );
    void this.logAudit(organizationId, userId, 'task', taskId, 'update', {
      action_type: 'comment_update',
      comment_id: commentId,
      comment_author_id: comment.created_by,
    });
    void this.notifyMentionedUsers(
      sanitizedContent,
      'task_comment',
      commentId,
      task.id,
      task.summary,
      organizationId,
      userId,
      task.space_id,
      task.key,
      'comment_mention',
      comment.content ?? null,
    );

    return r.data;
  }

  async deleteComment(
    taskId: string,
    commentId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const task = await this.getById(taskId, organizationId);
    const existing = await this.client
      .from(TasksService.COMMENTS_TABLE)
      .select('*')
      .eq('id', commentId)
      .eq('task_id', taskId)
      .maybeSingle();
    if (!existing.data) throw new NotFoundException('Comment not found');
    const comment = existing.data as { created_by: string; content?: string };
    const isAuthor = comment.created_by === userId;
    const allowed =
      await this.requirePermissionsService().hasOrgOrSpacePermission(
        userId,
        organizationId,
        isAuthor
          ? 'can_delete_comments_tasks'
          : 'can_delete_others_comments_tasks',
        task.space_id,
      );
    if (!allowed) {
      throw new ForbiddenException(
        isAuthor
          ? 'You do not have permission to delete comments'
          : 'You do not have permission to delete comments of other users',
      );
    }
    const deletedPreview =
      comment.content?.replace(/<[^>]+>/g, '').substring(0, 100) ?? '';
    const r = await this.client
      .from(TasksService.COMMENTS_TABLE)
      .delete()
      .eq('id', commentId)
      .eq('task_id', taskId)
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);
    void this.logTaskHistory(
      taskId,
      organizationId,
      userId,
      'comment_deleted',
      null,
      { comment_id: commentId, content_preview: deletedPreview },
      null,
    );
    void this.logAudit(organizationId, userId, 'task', taskId, 'update', {
      action_type: 'comment_delete',
      comment_id: commentId,
      comment_author_id: comment.created_by,
    });
  }

  // ------------------------------------------------------------------
  // Relationships
  // ------------------------------------------------------------------

  async getRelationships(
    taskId: string,
    organizationId: string,
    userId?: string,
  ): Promise<unknown[]> {
    await this.getById(taskId, organizationId);
    const r = await this.client
      .from(TasksService.RELATIONSHIPS_TABLE)
      .select(RELATIONSHIP_WITH_DETAILS_SELECT)
      .or(`source_id.eq.${taskId},target_id.eq.${taskId}`)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });
    if (r.error) throw new BadRequestException(r.error.message);
    return this.enrichRelationships(
      (r.data ?? []) as unknown as Record<string, unknown>[],
      organizationId,
      userId,
    );
  }

  async createRelationship(
    taskId: string,
    organizationId: string,
    userId: string,
    dto: CreateRelationshipDto,
  ): Promise<unknown> {
    const task = await this.getById(taskId, organizationId);

    const sourceType = dto.source_type ?? 'task';
    const sourceId = dto.source_id ?? taskId;
    const targetType = dto.target_type ?? 'task';

    if (sourceType !== 'task' || sourceId !== taskId) {
      throw new BadRequestException(
        'source_id must match the task in the route',
      );
    }

    if (targetType === sourceType && dto.target_id === sourceId) {
      throw new BadRequestException('A task cannot reference itself');
    }

    // The type must belong to this org and not be in the trash; otherwise a
    // cross-tenant type is accepted and its name renders on the task.
    const rt = await this.client
      .from('relation_types')
      .select('id, name')
      .eq('id', dto.relation_type_id)
      .eq('organization_id', organizationId)
      .eq('is_deleted', false)
      .maybeSingle();
    if (rt.error) throw new BadRequestException(rt.error.message);
    if (!rt.data) throw new BadRequestException('Unknown relation type');
    const relationTypeName = (rt.data as { name?: string }).name ?? null;

    await this.assertRelationshipTargetExists(
      targetType,
      dto.target_id,
      organizationId,
      userId,
    );

    // Duplicate check
    const dup = await this.client
      .from(TasksService.RELATIONSHIPS_TABLE)
      .select('id')
      .eq('source_type', sourceType)
      .eq('source_id', sourceId)
      .eq('target_type', targetType)
      .eq('target_id', dto.target_id)
      .eq('relation_type_id', dto.relation_type_id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (dup.data) {
      throw new ConflictException('This relationship already exists');
    }

    const r = await this.client
      .from(TasksService.RELATIONSHIPS_TABLE)
      .insert({
        organization_id: organizationId,
        source_type: sourceType,
        source_id: sourceId,
        target_type: targetType,
        target_id: dto.target_id,
        relation_type_id: dto.relation_type_id,
        created_by: userId,
      })
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);

    let targetKey: string | null = null;
    let targetSummary: string | null = null;
    let targetTitle: string | null = null;

    if (targetType === 'task') {
      const targetTask = await this.client
        .from(TasksService.TABLE)
        .select('key, summary')
        .eq('id', dto.target_id)
        .maybeSingle();
      targetKey = (targetTask.data as { key?: string } | null)?.key ?? null;
      targetSummary =
        (targetTask.data as { summary?: string } | null)?.summary ?? null;
    } else if (targetType === 'wiki_page') {
      const wikiPage = await this.client
        .from('wiki_pages')
        .select('title')
        .eq('id', dto.target_id)
        .maybeSingle();
      targetTitle = (wikiPage.data as { title?: string } | null)?.title ?? null;
    } else if (targetType === 'list') {
      const list = await this.client
        .from('lists')
        .select('name')
        .eq('id', dto.target_id)
        .maybeSingle();
      targetTitle = (list.data as { name?: string } | null)?.name ?? null;
    }

    void this.logTaskHistory(
      sourceId,
      organizationId,
      userId,
      'relationship_added',
      null,
      null,
      {
        target_id: dto.target_id,
        target_type: targetType,
        target_key: targetKey,
        target_summary: targetSummary,
        target_title: targetTitle,
        relation_type_id: dto.relation_type_id,
        relation_type: relationTypeName,
      },
    );
    void this.logAudit(organizationId, userId, 'task', sourceId, 'update', {
      action_type: 'relationship_add',
      relationship_id: (r.data as { id?: string })?.id,
      target_id: dto.target_id,
      target_type: targetType,
    });

    void this.outboxService?.write(
      organizationId,
      task.space_id,
      'app.task.relation_added',
      {
        task: {
          id: task.id,
          key: task.key,
          summary: task.summary,
          status: task.status,
          priority: task.priority,
          assigned_to: task.assigned_to,
          space_id: task.space_id,
          organization_id: organizationId,
        },
        task_id: taskId,
        targetType,
        // Only a task target has a related task; a wiki page id here would
        // be mistaken for a task id by any consumer.
        relatedTaskId: targetType === 'task' ? dto.target_id : null,
        relatedWikiPageId: targetType === 'wiki_page' ? dto.target_id : null,
        relationType: relationTypeName,
        space_id: task.space_id,
      },
    );

    const enriched = await this.enrichRelationships(
      [r.data as Record<string, unknown>],
      organizationId,
      userId,
    );
    return enriched[0] ?? r.data;
  }

  async deleteRelationship(
    taskId: string,
    relationshipId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.getById(taskId, organizationId);
    // Fetch relationship before deletion to capture target info for history
    const existing = (await this.client
      .from(TasksService.RELATIONSHIPS_TABLE)
      .select('source_id, target_id, target_type')
      .eq('id', relationshipId)
      .eq('organization_id', organizationId)
      .maybeSingle()) as {
      data: {
        source_id: string;
        target_id: string;
        target_type: string;
      } | null;
      error: { message: string } | null;
    };
    if (!existing.data) throw new NotFoundException('Relationship not found');
    if (
      existing.data.source_id !== taskId &&
      existing.data.target_id !== taskId
    ) {
      throw new NotFoundException('Relationship not found for this task');
    }
    const r = await this.client
      .from(TasksService.RELATIONSHIPS_TABLE)
      .delete()
      .eq('id', relationshipId)
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);
    let targetKey: string | null = null;
    let targetTitle: string | null = null;
    const existingTargetType = existing.data?.target_type ?? null;
    const existingTargetId = existing.data?.target_id ?? null;
    if (existingTargetType === 'task' && existingTargetId) {
      const t = (await this.client
        .from(TasksService.TABLE)
        .select('key')
        .eq('id', existingTargetId)
        .maybeSingle()) as { data: { key?: string } | null; error: unknown };
      targetKey = t.data?.key ?? null;
    } else if (existingTargetType === 'wiki_page' && existingTargetId) {
      const wp = (await this.client
        .from('wiki_pages')
        .select('title')
        .eq('id', existingTargetId)
        .maybeSingle()) as { data: { title?: string } | null; error: unknown };
      targetTitle = wp.data?.title ?? null;
    } else if (existingTargetType === 'list' && existingTargetId) {
      const l = (await this.client
        .from('lists')
        .select('name')
        .eq('id', existingTargetId)
        .maybeSingle()) as { data: { name?: string } | null; error: unknown };
      targetTitle = l.data?.name ?? null;
    }
    void this.logTaskHistory(
      taskId,
      organizationId,
      userId,
      'relationship_deleted',
      null,
      {
        relationship_id: relationshipId,
        target_id: existingTargetId,
        target_type: existingTargetType,
        target_key: targetKey,
        target_title: targetTitle,
      },
      null,
    );
    void this.logAudit(organizationId, userId, 'task', taskId, 'update', {
      action_type: 'relationship_remove',
      relationship_id: relationshipId,
    });
  }

  // ------------------------------------------------------------------
  // Hierarchy
  // ------------------------------------------------------------------

  /**
   * Get direct subtasks with enriched details (task_type, assignee_name, children_count).
   * Uses the get_task_subtasks RPC so the response shape matches ITaskSubtask.
   * Falls back to a plain select if the RPC is unavailable.
   */
  async getSubtasks(
    taskId: string,
    organizationId: string,
  ): Promise<
    Array<{
      id: string;
      key: string | null;
      summary: string;
      status: string;
      priority: string;
      task_type_id: string | null;
      assigned_to: string | null;
      assignee_name?: string | null;
      children_count: number;
      created_at?: string | null;
      status_config: TaskStatusConfig | null;
      task_type?: {
        id: string;
        name: string;
        color: string;
        text_color?: string | null;
        icon?: string | null;
      } | null;
    }>
  > {
    // Subtasks inherit the parent's space, so we look up the parent's
    // space_id once and reuse it as each subtask's space_id when resolving
    // task_type via fetchTaskTypeMap (composite-key by `space_id|type_id`).
    const parent = await this.getById(taskId, organizationId);
    const parentSpaceId =
      typeof (parent as { space_id?: unknown }).space_id === 'string'
        ? (parent as { space_id: string }).space_id
        : null;

    // Try RPC first — it returns enriched subtask data with assignee_name, children_count, task_type
    const rpc = await this.client.rpc('get_task_subtasks', {
      p_task_id: taskId,
    });

    if (!rpc.error && rpc.data) {
      const rows = rpc.data as Record<string, unknown>[];

      // Enrich with task_type details from task_hierarchy_configurations.
      // All subtasks share the parent's space_id.
      const typeMap = await this.fetchTaskTypeMap(
        organizationId,
        rows.map((r) => ({
          space_id: parentSpaceId,
          task_type_id:
            typeof r.task_type_id === 'string' ? r.task_type_id : null,
        })),
      );

      // The RPC selects neither created_at (the created-date sort compares it) nor the status row
      // (without it the status chip falls back to the legacy bucket text), so fetch both.
      const ids = rows.map((r) => r.id as string);
      const extraById = new Map<
        string,
        { created_at: string | null; status_config: TaskStatusConfig | null }
      >();

      if (ids.length > 0) {
        const { data: extraRows } = await this.client
          .from(TasksService.TABLE)
          .select(`id, created_at, ${STATUS_CONFIG_EMBED}`)
          .in('id', ids)
          .eq('organization_id', organizationId);

        for (const row of (extraRows ?? []) as unknown as Array<{
          id: string;
          created_at: string | null;
          status_config: TaskStatusConfig | null;
        }>) {
          extraById.set(row.id, row);
        }
      }

      return rows.map((r) => ({
        id: r.id as string,
        key: (r.key as string | null) ?? null,
        summary: r.summary as string,
        status: r.status as string,
        priority: r.priority as string,
        task_type_id: (r.task_type_id as string | null) ?? null,
        assigned_to: (r.assigned_to as string | null) ?? null,
        assignee_name: (r.assigned_to_name as string | null) ?? null,
        children_count: Number(r.children_count) || 0,
        created_at: extraById.get(r.id as string)?.created_at ?? null,
        status_config: extraById.get(r.id as string)?.status_config ?? null,
        task_type:
          parentSpaceId && typeof r.task_type_id === 'string'
            ? (typeMap.get(`${parentSpaceId}|${r.task_type_id}`) ?? null)
            : null,
      }));
    }

    // Fallback: plain select with children_count sub-query
    const r = await this.client
      .from(TasksService.TABLE)
      .select(`*, ${STATUS_CONFIG_EMBED}`)
      .eq('parent_task_id', taskId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });
    if (r.error) throw new BadRequestException(r.error.message);

    const rows = (r.data ?? []) as unknown as Array<
      Task & { status_config?: TaskStatusConfig | null }
    >;

    const countRows = await this.client
      .from(TasksService.TABLE)
      .select('parent_task_id')
      .in(
        'parent_task_id',
        rows.map((t) => t.id),
      )
      .eq('organization_id', organizationId);

    const childCounts = new Map<string, number>();

    for (const cr of (countRows.data ?? []) as Array<{
      parent_task_id: string;
    }>) {
      childCounts.set(
        cr.parent_task_id,
        (childCounts.get(cr.parent_task_id) ?? 0) + 1,
      );
    }

    return rows.map((t) => ({
      id: t.id,
      key: t.key,
      summary: t.summary,
      status: t.status,
      priority: t.priority,
      task_type_id: t.task_type_id,
      assigned_to: t.assigned_to,
      assignee_name: null,
      children_count: childCounts.get(t.id) ?? 0,
      created_at: t.created_at ?? null,
      status_config: t.status_config ?? null,
      task_type: null,
    }));
  }

  /**
   * Get parent chain (breadcrumb) for a task.
   * Returns ancestors from immediate parent to root, each with a `level` field
   * (0 = immediate parent, incrementing toward root) matching ITaskParentChainItem.
   * Uses the get_task_parent_chain RPC when available; falls back to iterative select.
   */
  async getParentChain(
    taskId: string,
    organizationId: string,
  ): Promise<
    Array<{
      id: string;
      key: string | null;
      summary: string;
      task_type_id: string | null;
      level: number;
    }>
  > {
    // Try RPC first — it returns level as a DB-computed value
    const rpc = await this.client.rpc('get_task_parent_chain', {
      p_task_id: taskId,
    });

    if (!rpc.error && rpc.data) {
      return (rpc.data as Record<string, unknown>[]).map((item, index) => ({
        id: item.id as string,
        key: (item.key as string | null) ?? null,
        summary: item.summary as string,
        task_type_id: (item.task_type_id as string | null) ?? null,
        level:
          item.level !== undefined && item.level !== null
            ? Number(item.level)
            : index,
      }));
    }

    // Fallback: iterative walk
    const chain: Array<{
      id: string;
      key: string | null;
      summary: string;
      task_type_id: string | null;
      level: number;
    }> = [];

    const visited = new Set<string>();
    const MAX_DEPTH = 50;
    let current = await this.getById(taskId, organizationId);

    while (current.parent_task_id && chain.length < MAX_DEPTH) {
      if (visited.has(current.parent_task_id)) break; // circular ref guard
      visited.add(current.parent_task_id);
      const parent = await this.client
        .from(TasksService.TABLE)
        .select('id, key, summary, task_type_id, parent_task_id')
        .eq('id', current.parent_task_id)
        .eq('organization_id', organizationId)
        .maybeSingle();
      if (!parent.data) break;
      const p = parent.data as Task;
      chain.push({
        id: p.id,
        key: p.key,
        summary: p.summary,
        task_type_id: p.task_type_id,
        level: chain.length,
      });
      current = p;
    }

    return chain;
  }

  /**
   * Get task tree for a process via the get_task_tree RPC.
   * Returns ITaskTreeNode[] (nested, with children[]) matching the frontend model.
   * Falls back to building a tree in-memory from a flat select when the RPC is unavailable.
   */
  async getTree(
    organizationId: string,
    processId: string,
    spaceId?: string,
    rootTaskId?: string,
  ): Promise<
    Array<{
      id: string;
      key: string | null;
      summary: string;
      status: string;
      priority: string;
      task_type_id: string;
      assigned_to: string | null;
      assignee_name?: string | null;
      due_date: string | null;
      children: unknown[];
      depth: number;
      children_count?: number;
    }>
  > {
    // Try the space-aware RPC first. Local Supabase has both 3- and 4-arg
    // overloads; the 4-arg version preserves the legacy space filter.
    const rpc = await this.client.rpc('get_task_tree', {
      p_organization_id: organizationId,
      p_process_id: processId,
      p_root_task_id: rootTaskId ?? null,
      p_space_id: spaceId ?? null,
    });

    if (!rpc.error && rpc.data) {
      return this.normalizeTaskTreeRows(rpc.data as Record<string, unknown>[]);
    }

    // Fallback: build tree in-memory from a flat query
    const filters: Parameters<TasksService['getAll']>[1] = {
      process_id: processId,
      pageSize: 1000,
    };

    if (spaceId) filters.space_id = spaceId;
    if (rootTaskId) filters.parent_task_id = rootTaskId;

    const result = await this.getAll(organizationId, filters);
    const flat = result.data as Task[];

    const nodeMap = new Map<
      string,
      {
        id: string;
        key: string | null;
        summary: string;
        status: string;
        priority: string;
        task_type_id: string;
        assigned_to: string | null;
        due_date: string | null;
        children: unknown[];
        depth: number;
        children_count?: number;
        parent_task_id: string | null;
      }
    >();

    for (const t of flat) {
      nodeMap.set(t.id, {
        id: t.id,
        key: t.key,
        summary: t.summary,
        status: t.status,
        priority: t.priority,
        task_type_id: t.task_type_id ?? '',
        assigned_to: t.assigned_to,
        due_date: t.due_date,
        children: [],
        depth: 0,
        parent_task_id: t.parent_task_id,
      });
    }

    const roots: unknown[] = [];

    for (const node of nodeMap.values()) {
      if (node.parent_task_id && nodeMap.has(node.parent_task_id)) {
        const parent = nodeMap.get(node.parent_task_id)!;
        parent.children.push(node);
        node.depth = (parent.depth ?? 0) + 1;
      } else {
        roots.push(node);
      }
    }

    // Update children_count after building tree
    for (const node of nodeMap.values()) {
      node.children_count = node.children.length;
    }

    return roots as Array<{
      id: string;
      key: string | null;
      summary: string;
      status: string;
      priority: string;
      task_type_id: string;
      assigned_to: string | null;
      assignee_name?: string | null;
      due_date: string | null;
      children: unknown[];
      depth: number;
      children_count?: number;
    }>;
  }

  // ------------------------------------------------------------------
  // History
  // ------------------------------------------------------------------

  async getHistory(taskId: string, organizationId: string): Promise<unknown[]> {
    await this.getById(taskId, organizationId);
    const r = await this.client
      .from('task_history_with_users')
      .select('*')
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      .order('changed_at', { ascending: false });
    if (r.error) throw new BadRequestException(r.error.message);

    const USER_FIELDS = new Set(['assigned_to', 'reporter']);
    const rows = (r.data ?? []) as Record<string, unknown>[];

    const userIds = new Set<string>();
    for (const row of rows) {
      if (USER_FIELDS.has(row.field_name as string)) {
        if (typeof row.old_value === 'string' && row.old_value)
          userIds.add(row.old_value);
        if (typeof row.new_value === 'string' && row.new_value)
          userIds.add(row.new_value);
      }
    }

    const usersMap: Record<string, unknown> = {};
    if (userIds.size > 0) {
      const { data: users } = await this.client
        .from('users')
        .select('id, first_name, last_name, email, avatar_url')
        .in('id', [...userIds]);
      for (const u of (users ?? []) as Array<{
        id: string;
        first_name: string;
        last_name: string;
        email: string;
        [key: string]: unknown;
      }>) {
        usersMap[u.id] = {
          ...u,
          full_name:
            `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
        };
      }
    }

    return rows.map((row) => {
      if (!USER_FIELDS.has(row.field_name as string)) return row;
      return {
        ...row,
        old_value_user: usersMap[row.old_value as string] ?? null,
        new_value_user: usersMap[row.new_value as string] ?? null,
      };
    });
  }

  private async validateCreateTaskInput(
    organizationId: string,
    spaceId: string,
    dto: CreateTaskDto,
    skipHierarchyCheck = false,
  ): Promise<ITaskTypeLevel> {
    if (!dto.task_type_id) {
      throw new BadRequestException('Task type is required');
    }

    const taskType = await this.getConfiguredTaskType(
      organizationId,
      spaceId,
      dto.task_type_id,
    );

    if (!taskType) {
      throw new BadRequestException(`Invalid task type: ${dto.task_type_id}`);
    }

    if (taskType.is_active === false) {
      throw new BadRequestException(
        `Task type "${dto.task_type_id}" is not active and cannot be used`,
      );
    }

    if (dto.parent_task_id) {
      const parentTask = await this.getById(dto.parent_task_id, organizationId);
      const parentType = parentTask.task_type_id
        ? await this.getConfiguredTaskType(
            organizationId,
            spaceId,
            parentTask.task_type_id,
          )
        : null;

      if (
        !skipHierarchyCheck &&
        parentType &&
        !this.isValidParentChild(parentType, taskType)
      ) {
        throw new BadRequestException(
          `Task type "${dto.task_type_id}" cannot be a child of task type "${parentTask.task_type_id}". Please check the allowed child types in the task hierarchy configuration.`,
        );
      }
    }

    if (dto.assigned_to) {
      await this.assertUserInOrganization(
        dto.assigned_to,
        organizationId,
        'Invalid assignee: user not found in organization',
      );
    }

    if (dto.reporter) {
      await this.assertUserInOrganization(
        dto.reporter,
        organizationId,
        'Invalid reporter: user not found in organization',
      );
    }

    return taskType;
  }

  private async validateUpdateTaskPatch(
    taskId: string,
    organizationId: string,
    before: Task,
    patch: Record<string, unknown>,
  ): Promise<{ effectiveSpaceId: string; workflowAssignment: unknown }> {
    if (!before.space_id) {
      throw new BadRequestException('Task must belong to a space');
    }

    const effectiveSpaceId =
      typeof patch.space_id === 'string' ? patch.space_id : before.space_id;

    // SVC-H1: set when a status change is governed by a workflow assignment.
    // Returned so update() reuses this single lookup for engine routing.
    let workflowAssignment: unknown = null;
    const effectiveProcessId =
      patch.process_id !== undefined
        ? (patch.process_id as string | null)
        : before.process_id;
    const effectiveTaskTypeId =
      typeof patch.task_type_id === 'string'
        ? patch.task_type_id
        : before.task_type_id;
    const parentChanged =
      patch.parent_task_id !== undefined &&
      patch.parent_task_id !== before.parent_task_id;
    const needsTaskTypeValidation =
      (patch.space_id !== undefined && patch.space_id !== before.space_id) ||
      (patch.task_type_id !== undefined &&
        patch.task_type_id !== before.task_type_id) ||
      patch.status !== undefined ||
      patch.status_id !== undefined ||
      parentChanged;

    if (patch.space_id && patch.space_id !== before.space_id) {
      await this.assertSpaceExists(organizationId, patch.space_id as string);
    }

    if (effectiveProcessId) {
      await this.assertProcessBelongsToSpace(
        organizationId,
        effectiveProcessId,
        effectiveSpaceId,
        patch.process_id !== undefined
          ? 'Process must belong to the same space as the task'
          : 'Process must belong to the target space',
      );
    }

    let taskType: ITaskTypeLevel | null = null;
    if (needsTaskTypeValidation) {
      taskType = effectiveTaskTypeId
        ? await this.getConfiguredTaskType(
            organizationId,
            effectiveSpaceId,
            effectiveTaskTypeId,
          )
        : null;

      if (!taskType) {
        throw new BadRequestException(
          `Task type "${effectiveTaskTypeId ?? ''}" is not available in the space`,
        );
      }
    }

    if (patch.status_id) {
      const row = await this.resolveStatusRowById(
        organizationId,
        effectiveSpaceId,
        patch.status_id as string,
      );
      if (patch.status !== undefined && patch.status !== row.key) {
        throw new BadRequestException(
          'status_id does not match the provided status key',
        );
      }
      // The legacy bucket on BOTH branches — `tasks.status` is CHECK-constrained to six values
      // while `task_statuses.key` is not, so a custom or migrated key would raise 23514.
      patch.status = toLegacyStatusText(
        row.key,
        row.isCompleted,
        row.categoryKey,
      );
    }

    if (patch.priority_id) {
      const row = await this.resolvePriorityRowById(
        organizationId,
        effectiveSpaceId,
        patch.priority_id as string,
      );
      if (patch.priority !== undefined && patch.priority !== row.key) {
        throw new BadRequestException(
          'priority_id does not match the provided priority key',
        );
      }
      // Written on BOTH branches — the caller may have passed the real key, but the constrained
      // column only ever takes the bucket.
      patch.priority = row.legacyKey;
    }

    const statusTextChanged =
      typeof patch.status === 'string' && patch.status !== before.status;
    // `patch.status` is the legacy bucket, so two statuses in the same bucket
    // (abgelehnt → geschlossen, both "done") look unchanged by text. Compare
    // status_id too, or the workflow gate in update() is silently skipped.
    const statusIdChanged =
      typeof patch.status_id === 'string' &&
      patch.status_id !== before.status_id;

    if (statusTextChanged || statusIdChanged) {
      // SVC-H1: when an active workflow assignment governs this task's type,
      // the workflow engine is the SOLE authority for status changes — it runs
      // later in update() and enforces source-validity + conditions/validators.
      // Running the legacy task_status_transitions / allowed_statuses checks
      // here too would wrongly reject workflow-valid transitions. Only apply
      // the legacy guards when there is NO workflow assignment.
      //
      // The lookup is done ONCE here and returned on the write context so
      // update() reuses it for engine routing — never queried twice.
      const taskTypeLevelId = (before.task_type_id ??
        patch.task_type_id ??
        '*') as string;

      workflowAssignment = this.assignments
        ? await this.assignments.findActiveAssignmentForType(
            organizationId,
            effectiveSpaceId,
            taskTypeLevelId,
          )
        : null;

      if (
        !workflowAssignment &&
        statusTextChanged &&
        typeof patch.status === 'string'
      ) {
        if (!this.isValidStatusTransition(before.status, patch.status)) {
          throw new BadRequestException(
            `Invalid status transition from "${before.status}" to "${patch.status}"`,
          );
        }
        this.assertStatusAllowedForTaskType(patch.status, taskType!);
      }
    }

    if (parentChanged) {
      const parentTaskId = patch.parent_task_id as string | null;

      if (parentTaskId) {
        if (parentTaskId === taskId) {
          throw new BadRequestException('A task cannot be its own parent');
        }

        const parentTask = await this.getById(parentTaskId, organizationId);

        if (parentTask.space_id !== effectiveSpaceId) {
          throw new BadRequestException(
            'Parent task must be in the same space',
          );
        }

        const descendants = await this.getTaskDescendants(
          taskId,
          organizationId,
        );
        if (descendants.some((task) => task.id === parentTaskId)) {
          throw new BadRequestException(
            'Cannot set a descendant task as parent (circular dependency)',
          );
        }

        const parentType = parentTask.task_type_id
          ? await this.getConfiguredTaskType(
              organizationId,
              effectiveSpaceId,
              parentTask.task_type_id,
            )
          : null;

        if (parentType && !this.isValidParentChild(parentType, taskType!)) {
          throw new BadRequestException(
            `Task type "${effectiveTaskTypeId}" cannot be a child of task type "${parentTask.task_type_id}"`,
          );
        }
      }
    }

    if (patch.assigned_to) {
      await this.assertUserInOrganization(
        patch.assigned_to as string,
        organizationId,
        'Invalid assignee: user not found in organization',
      );
    }

    if (patch.reporter) {
      await this.assertUserInOrganization(
        patch.reporter as string,
        organizationId,
        'Invalid reporter: user not found in organization',
      );
    }

    return { effectiveSpaceId, workflowAssignment };
  }

  private async resolveCreateSpaceId(
    organizationId: string,
    dto: CreateTaskDto,
  ): Promise<string> {
    let spaceId = dto.space_id ?? dto.spaceId;

    if (dto.process_id) {
      const {
        data,
        error,
        status: responseStatus,
      } = await this.client
        .from('business_processes')
        .select('space_id')
        .eq('id', dto.process_id)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (error) throw databaseBadRequest(error, responseStatus);
      if (!data) throw new NotFoundException('Process not found');

      const processSpaceId = (data as { space_id?: string | null }).space_id;
      if (!spaceId) spaceId = processSpaceId ?? undefined;
      if (spaceId && processSpaceId && spaceId !== processSpaceId) {
        throw new BadRequestException(
          'Task space_id must match the process space_id',
        );
      }
    }

    if (!spaceId) {
      throw new BadRequestException(
        'space_id is required (either from process or explicitly provided)',
      );
    }

    if (dto.parent_task_id) {
      const parentTask = await this.getById(dto.parent_task_id, organizationId);
      if (parentTask.space_id !== spaceId) {
        throw new BadRequestException('Parent task must be in the same space');
      }
    }

    return spaceId;
  }

  /**
   * Builds a Map<task_type_id, type-summary> for the given org by reading the
   * JSONB `config.levels[]` out of `task_hierarchy_configurations`.
   *
   * Why this helper exists: there is NO `task_types` table in this schema.
   * Task type metadata (name, color, icon, etc.) lives inside the org-scoped
   * `task_hierarchy_configurations.config.levels[]` JSONB array — each level
   * has `id, name, color, text_color, icon, sort_order, ...`. Earlier versions
   * of this file queried `.from('task_types')` which silently returned an
   * error (relation does not exist), leaving typeMap empty so every task got
   * `task_type: null` and the UI rendered '-' in the Type column.
   *
   * A single query hydrates every type referenced by the current batch.
   */
  /**
   * Builds a composite-keyed Map of task-type metadata for the given (org, batch
   * of tasks). Key format is `"<space_id>|<task_type_id>"`.
   *
   * Why this shape: `task_hierarchy_configurations` is per-`(organization_id,
   * space_id)` — a single org typically has one row with `space_id IS NULL`
   * (the org default) plus zero or more space-specific rows. Tasks across
   * different spaces in the same response need to be resolved against their
   * own space's config (with org-default as fallback). An earlier version of
   * this helper used `.maybeSingle()` and threw on multi-row orgs, leaving
   * every task with `task_type: null`. Now we load all configs for the org
   * in one query and build per-space level maps, with org-default fallback.
   *
   * @returns Map keyed by `"<space_id>|<task_type_id>"`. Tasks with no
   *          `space_id` or `task_type_id` are skipped. Empty map on error or
   *          when nothing is requested.
   */
  private async fetchTaskTypeMap(
    organizationId: string,
    tasks: Array<{ space_id: string | null; task_type_id: string | null }>,
  ): Promise<
    Map<
      string,
      {
        id: string;
        name: string;
        color: string;
        text_color?: string | null;
        icon?: string | null;
      }
    >
  > {
    type TaskTypeShape = {
      id: string;
      name: string;
      color: string;
      text_color?: string | null;
      icon?: string | null;
    };
    const composite = new Map<string, TaskTypeShape>();

    // Collect every unique (space_id, task_type_id) the batch needs.
    const wanted = new Set<string>();
    for (const t of tasks) {
      if (
        typeof t.task_type_id === 'string' &&
        typeof t.space_id === 'string'
      ) {
        wanted.add(`${t.space_id}|${t.task_type_id}`);
      }
    }
    if (wanted.size === 0) return composite;

    // ONE round-trip pulls every config the org owns. `space_id IS NULL`
    // rows are the org-default fallback used when a task's own space has
    // no config of its own.
    const { data: rows, error } = await this.client
      .from('task_hierarchy_configurations')
      .select('space_id, config')
      .eq('organization_id', organizationId);

    if (error) {
      this.logger.warn(
        `Failed to load task_hierarchy_configurations for org ${organizationId}: ${error.message}`,
      );
      return composite;
    }

    // Build per-space level maps. Key `null` = org-default row.
    const perSpace = new Map<string | null, Map<string, TaskTypeShape>>();
    for (const row of (rows ?? []) as Array<{
      space_id: string | null;
      config: { levels?: unknown[] } | null;
    }>) {
      const levelMap = new Map<string, TaskTypeShape>();
      const levels = (row.config?.levels ?? []) as Array<{
        id: string;
        name?: string;
        color?: string;
        text_color?: string | null;
        icon?: string | null;
      }>;
      for (const level of levels) {
        if (typeof level?.id === 'string') {
          levelMap.set(level.id, {
            id: level.id,
            name: level.name ?? level.id,
            color: level.color ?? '#6B7280',
            text_color: level.text_color ?? null,
            icon: level.icon ?? null,
          });
        }
      }
      perSpace.set(row.space_id ?? null, levelMap);
    }
    const orgDefault = perSpace.get(null) ?? new Map<string, TaskTypeShape>();

    // Third tier: the built-in types. `task_hierarchy_configurations` is
    // written lazily — a space that has never had its hierarchy customised has
    // no row, and an org that has never customised any space has no
    // `space_id IS NULL` row either, so the two tiers above can BOTH miss. The
    // write path does not have this gap: the create dialog lists the built-in
    // levels via getActiveTaskTypes(), so a task is happily saved with
    // `task_type_id: 'task'` that the read path then cannot resolve, and the
    // UI renders '-' in the Type column for a type the user explicitly picked.
    // Resolving against the same defaults the writer offered closes that
    // asymmetry. Only the built-in ids resolve here, so a genuinely unknown
    // custom type still falls through to null.
    const builtinDefault = new Map<string, TaskTypeShape>(
      DEFAULT_TASK_HIERARCHY_CONFIG.levels.map((level) => [
        level.id,
        {
          id: level.id,
          name: level.name,
          color: level.color ?? '#6B7280',
          text_color: level.text_color ?? null,
          icon: level.icon ?? null,
        },
      ]),
    );

    // Resolve every (space, type) pair: space-specific first, then org-default.
    for (const key of wanted) {
      const sep = key.indexOf('|');
      const spaceId = key.slice(0, sep);
      const typeId = key.slice(sep + 1);
      const found =
        perSpace.get(spaceId)?.get(typeId) ??
        orgDefault.get(typeId) ??
        builtinDefault.get(typeId) ??
        null;
      if (found) composite.set(key, found);
    }

    return composite;
  }

  private async enrichTasksWithRelations(
    rows: Record<string, unknown>[],
    organizationId: string,
    includeCounts: boolean,
  ): Promise<Record<string, unknown>[]> {
    const typeMap = await this.fetchTaskTypeMap(
      organizationId,
      rows.map((row) => ({
        space_id: typeof row['space_id'] === 'string' ? row['space_id'] : null,
        task_type_id:
          typeof row['task_type_id'] === 'string' ? row['task_type_id'] : null,
      })),
    );

    return Promise.all(
      rows.map(async (row) => {
        const spaceId =
          typeof row['space_id'] === 'string' ? row['space_id'] : null;
        const typeId =
          typeof row['task_type_id'] === 'string' ? row['task_type_id'] : null;
        const task = {
          ...row,
          task_type:
            spaceId && typeId
              ? (typeMap.get(`${spaceId}|${typeId}`) ?? null)
              : null,
          subtask_count: 0,
          comment_count: 0,
          attachment_count: 0,
        };

        if (includeCounts && typeof row['id'] === 'string') {
          const counts = await this.getTaskCounts(row['id'], organizationId);
          task.subtask_count = counts.subtaskCount;
          task.comment_count = counts.commentCount;
          task.attachment_count = counts.attachmentCount;
        }

        return task;
      }),
    );
  }

  private async enrichTaskWithRelations(
    row: Record<string, unknown>,
    organizationId: string,
    includeCounts: boolean,
  ): Promise<Record<string, unknown>> {
    const [task] = await this.enrichTasksWithRelations(
      [row],
      organizationId,
      includeCounts,
    );
    return task;
  }

  private async getTaskCounts(
    taskId: string,
    organizationId: string,
  ): Promise<{
    subtaskCount: number;
    commentCount: number;
    attachmentCount: number;
  }> {
    const [subtasks, comments, legacyAttachments, centralAttachments] =
      await Promise.all([
        this.client
          .from(TasksService.TABLE)
          .select('id', { count: 'exact', head: true })
          .eq('parent_task_id', taskId)
          .eq('organization_id', organizationId),
        this.client
          .from(TasksService.COMMENTS_TABLE)
          .select('id', { count: 'exact', head: true })
          .eq('task_id', taskId)
          .eq('organization_id', organizationId),
        this.client
          .from(TasksService.ATTACHMENTS_TABLE)
          .select('id', { count: 'exact', head: true })
          .eq('task_id', taskId)
          .eq('organization_id', organizationId),
        this.client
          .from('file_attachments')
          .select('id', { count: 'exact', head: true })
          .eq('entity_type', 'task')
          .eq('entity_id', taskId)
          .eq('organization_id', organizationId)
          // Must match listForEntity, or the badge counts files the list does
          // not show. A row with no current version has no bytes behind it.
          .not('current_version_id', 'is', null),
      ]);

    return {
      subtaskCount: subtasks.count ?? 0,
      commentCount: comments.count ?? 0,
      attachmentCount:
        (legacyAttachments.count ?? 0) + (centralAttachments.count ?? 0),
    };
  }

  private extractStoragePathsFromDeleteResult(data: unknown): string[] {
    if (!data || typeof data !== 'object') return [];
    const storagePaths = (data as { storage_paths?: unknown }).storage_paths;
    if (!Array.isArray(storagePaths)) return [];
    return storagePaths.filter(
      (path): path is string => typeof path === 'string' && path.length > 0,
    );
  }

  private async removeTaskAttachmentStorageObjects(
    storagePaths: string[],
  ): Promise<void> {
    if (storagePaths.length === 0) return;

    await this.client.storage
      .from(ATTACHMENT_BUCKET)
      .remove(storagePaths)
      .then(({ error }) => {
        if (error) {
          this.logger.error('Task attachment storage cleanup failed:', error);
        }
      })
      .catch((error: unknown) => {
        this.logger.error('Task attachment storage cleanup failed:', error);
      });
  }

  private normalizeTaskTreeRows(rows: Record<string, unknown>[]): Array<{
    id: string;
    key: string | null;
    summary: string;
    status: string;
    priority: string;
    task_type_id: string;
    assigned_to: string | null;
    assignee_name?: string | null;
    due_date: string | null;
    children: unknown[];
    depth: number;
    children_count?: number;
  }> {
    if (rows.some((row) => Array.isArray(row['children']))) {
      return rows as ReturnType<TasksService['normalizeTaskTreeRows']>;
    }

    const nodes = new Map<
      string,
      ReturnType<TasksService['normalizeTaskTreeRows']>[number] & {
        parent_task_id?: string | null;
      }
    >();

    for (const row of rows) {
      const id = row['id'] as string;
      nodes.set(id, {
        id,
        key: (row['key'] as string | null) ?? null,
        summary: (row['summary'] as string) ?? '',
        status: (row['status'] as string) ?? 'open',
        priority: (row['priority'] as string) ?? 'medium',
        task_type_id: (row['task_type_id'] as string) ?? '',
        assigned_to: (row['assigned_to'] as string | null) ?? null,
        assignee_name: (row['assigned_to_name'] as string | null) ?? null,
        due_date: (row['due_date'] as string | null) ?? null,
        children: [],
        depth: Number(row['level'] ?? 0),
        children_count: Number(row['children_count'] ?? 0),
        parent_task_id: (row['parent_task_id'] as string | null) ?? null,
      });
    }

    const roots: ReturnType<TasksService['normalizeTaskTreeRows']> = [];
    for (const node of nodes.values()) {
      if (node.parent_task_id && nodes.has(node.parent_task_id)) {
        nodes.get(node.parent_task_id)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  private async assertRelationshipTargetExists(
    targetType: string,
    targetId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    // Linking needs view access to the target's space (XE-T532 #4). A hidden
    // target answers like a missing one, so linking cannot probe for it.
    const canView = createLinkViewCheck(
      this.permissionsService,
      organizationId,
      userId,
    );

    if (targetType === 'task') {
      const task = await this.getById(targetId, organizationId);
      if (!(await canView(task.space_id ?? null, 'view_tasks'))) {
        throw new NotFoundException('Task not found');
      }
      return;
    }

    if (targetType === 'process') {
      const { data, error } = await this.client
        .from('business_processes')
        .select('id, space_id')
        .eq('id', targetId)
        .eq('organization_id', organizationId)
        .maybeSingle();
      if (error) throw new BadRequestException(error.message);
      const process = data as { space_id: string | null } | null;
      if (!process || !(await canView(process.space_id, 'view_processes'))) {
        throw new NotFoundException('Target process not found');
      }
      return;
    }

    if (targetType === 'wiki_page') {
      const { data, error } = await this.client
        .from('wiki_pages')
        .select('id, space_id, is_archived')
        .eq('id', targetId)
        .eq('organization_id', organizationId)
        .maybeSingle();
      if (error) throw new BadRequestException(error.message);
      const page = data as {
        space_id: string;
        is_archived: boolean | null;
      } | null;
      // Fail closed: without the permission service we cannot tell whether
      // the viewer may see the page.
      if (!page || !this.wikiPermissions) {
        throw new NotFoundException('Target wiki page not found');
      }
      try {
        await this.wikiPermissions.assertPageAccess(
          targetId,
          userId,
          page.space_id,
          'can_view',
        );
      } catch (err) {
        // Same answer as a missing page, so linking cannot probe hidden pages.
        if (err instanceof ForbiddenException) {
          throw new NotFoundException('Target wiki page not found');
        }
        throw err;
      }
      if (page.is_archived) {
        throw new BadRequestException('Cannot link an archived wiki page');
      }
      return;
    }

    throw new BadRequestException(
      `Unsupported relationship target: ${targetType}`,
    );
  }

  private async enrichRelationships(
    relationships: Record<string, unknown>[],
    organizationId: string,
    userId?: string,
  ): Promise<Record<string, unknown>[]> {
    if (relationships.length === 0) return [];

    const taskIds = new Set<string>();
    const processIds = new Set<string>();
    const wikiPageIds = new Set<string>();
    for (const rel of relationships) {
      if (rel['source_type'] === 'task')
        taskIds.add(rel['source_id'] as string);
      if (rel['target_type'] === 'task')
        taskIds.add(rel['target_id'] as string);
      if (rel['source_type'] === 'process')
        processIds.add(rel['source_id'] as string);
      if (rel['target_type'] === 'process')
        processIds.add(rel['target_id'] as string);
      if (rel['target_type'] === 'wiki_page')
        wikiPageIds.add(rel['target_id'] as string);
    }

    // Task and process sides (XE-T532 #4): one org-scoped read each, then the
    // viewer's view permission on the side's space. A side the viewer cannot
    // see, or a failed read, becomes a stub: the row stays deletable without
    // leaking its key or summary. A side that no longer exists is null.
    const canView = createLinkViewCheck(
      this.permissionsService,
      organizationId,
      userId,
    );
    const hydrateSides = async (
      ids: Set<string>,
      table: string,
      columns: string,
      permission: 'view_tasks' | 'view_processes',
    ): Promise<Map<string, Record<string, unknown>>> => {
      const map = new Map<string, Record<string, unknown>>();
      if (ids.size === 0) return map;
      const { data, error } = await this.client
        .from(table)
        .select(
          `${columns}, space_id, space:spaces!${table}_space_id_fkey(key)`,
        )
        .in('id', [...ids])
        .eq('organization_id', organizationId);
      if (error) {
        this.logger.warn(
          `enrichRelationships: ${table} read failed: ${error.message}`,
        );
        for (const id of ids) map.set(id, { id, restricted: true });
        return map;
      }
      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      await Promise.all(
        rows.map(async ({ space, ...row }) => {
          const id = row['id'] as string;
          const visible = await canView(
            (row['space_id'] as string | null) ?? null,
            permission,
          );
          const spaceKey = (space as { key?: string } | null)?.key ?? null;
          map.set(
            id,
            visible
              ? { ...row, space_key: spaceKey }
              : { id, restricted: true },
          );
        }),
      );
      return map;
    };
    const [taskMap, processMap] = await Promise.all([
      hydrateSides(
        taskIds,
        TasksService.TABLE,
        `id, key, summary, status, priority, ${STATUS_CONFIG_EMBED}`,
        'view_tasks',
      ),
      hydrateSides(
        processIds,
        'business_processes',
        'id, key, title',
        'view_processes',
      ),
    ]);

    // Wiki targets: one read, then the wiki's own view check per space. A page
    // the viewer cannot see becomes a stub (the row stays deletable); a page
    // that no longer exists becomes null.
    const wikiMap = new Map<string, Record<string, unknown>>();
    if (wikiPageIds.size > 0) {
      const { data, error } = await this.client
        .from('wiki_pages')
        .select(
          'id, title, slug, space_id, is_archived, created_by, path, space:spaces!wiki_pages_space_id_fkey(key)',
        )
        .in('id', [...wikiPageIds])
        .eq('organization_id', organizationId);
      // On a failed read, stub every target as restricted: null would read as
      // "deleted" and invite unlinking a valid link.
      if (error) {
        this.logger.warn(
          `enrichRelationships: wiki_pages read failed: ${error.message}`,
        );
        for (const id of wikiPageIds) wikiMap.set(id, { id, restricted: true });
      }
      const pages = (data ?? []) as unknown as {
        id: string;
        title: string;
        slug: string;
        space_id: string;
        is_archived: boolean | null;
        space?: { key?: string } | null;
      }[];

      const pagesBySpace = new Map<string, typeof pages>();
      for (const page of pages) {
        const list = pagesBySpace.get(page.space_id) ?? [];
        list.push(page);
        pagesBySpace.set(page.space_id, list);
      }

      const visible = new Set<string>();
      if (this.wikiPermissions && userId) {
        for (const [spaceId, list] of pagesBySpace) {
          const ok = (await this.wikiPermissions.filterAccessiblePages(
            list,
            userId,
            spaceId,
          )) as { id: string }[];
          for (const page of ok) visible.add(page.id);
        }
      }

      for (const page of pages) {
        wikiMap.set(
          page.id,
          visible.has(page.id)
            ? {
                id: page.id,
                title: page.title,
                slug: page.slug,
                space_id: page.space_id,
                space_key: page.space?.key ?? null,
                is_archived: page.is_archived ?? false,
              }
            : { id: page.id, restricted: true },
        );
      }
    }

    return relationships.map((rel) => ({
      ...rel,
      source_task:
        rel['source_type'] === 'task'
          ? (taskMap.get(rel['source_id'] as string) ?? null)
          : null,
      target_task:
        rel['target_type'] === 'task'
          ? (taskMap.get(rel['target_id'] as string) ?? null)
          : null,
      ...(rel['source_type'] === 'process' && {
        source_process: processMap.get(rel['source_id'] as string) ?? null,
      }),
      ...(rel['target_type'] === 'process' && {
        target_process: processMap.get(rel['target_id'] as string) ?? null,
      }),
      ...(rel['target_type'] === 'wiki_page' && {
        target_wiki_page: wikiMap.get(rel['target_id'] as string) ?? null,
      }),
    }));
  }

  private async getConfiguredTaskType(
    organizationId: string,
    spaceId: string,
    taskTypeId: string,
  ): Promise<ITaskTypeLevel | null> {
    if (!this.taskHierarchyConfig) {
      throw new BadRequestException(
        'Task hierarchy configuration service is unavailable',
      );
    }

    return this.taskHierarchyConfig.getTypeById(
      organizationId,
      spaceId,
      taskTypeId,
    );
  }

  /**
   * Returns the active task types configured for a space (per-space config,
   * falling back to the org/default hierarchy). Exposed for the MCP-facing
   * space-safe write path, which derives a default task-level `task_type_id`
   * for a space rather than accepting one from the client.
   *
   * @param organizationId - active organization id
   * @param spaceId - target space id
   * @returns the space's active task-type levels (never null)
   */
  async getActiveTaskTypesForSpace(
    organizationId: string,
    spaceId: string,
  ): Promise<ITaskTypeLevel[]> {
    if (!this.taskHierarchyConfig) {
      throw new BadRequestException(
        'Task hierarchy configuration service is unavailable',
      );
    }

    return this.taskHierarchyConfig.getActiveTypes(organizationId, spaceId);
  }

  private async resolveTaskStatusForWrite(
    organizationId: string,
    spaceId: string,
    status: string | undefined,
    statusId: string | null,
    taskType: ITaskTypeLevel,
  ): Promise<{ key: string; id: string | null; legacyKey: string }> {
    let resolved = status ?? taskType.default_status ?? 'open';
    let resolvedId = statusId;
    let legacyKey = resolved;

    if (statusId) {
      const row = await this.resolveStatusRowById(
        organizationId,
        spaceId,
        statusId,
      );

      if (status && status !== row.key) {
        throw new BadRequestException(
          'status_id does not match the provided status key',
        );
      }
      resolved = row.key;
      legacyKey = toLegacyStatusText(row.key, row.isCompleted, row.categoryKey);
    } else {
      resolvedId = await this.resolveStatusIdByKey(
        organizationId,
        spaceId,
        resolved,
      );
      // Keyed writes come from the app's own six built-in keys, so `resolved` is already legal
      // here; run it through the same funnel anyway so there is exactly ONE place that decides
      // what lands in the constrained column.
      legacyKey = toLegacyStatusText(resolved, undefined, null);
    }

    this.assertStatusAllowedForTaskType(resolved, taskType);

    return { key: resolved, id: resolvedId, legacyKey };
  }

  private async resolveTaskPriorityForWrite(
    organizationId: string,
    spaceId: string,
    priority: string | undefined,
    priorityId: string | null,
    taskType: ITaskTypeLevel,
  ): Promise<{ key: string; id: string | null; legacyKey: string }> {
    let resolved = priority ?? taskType.default_priority ?? 'medium';
    let resolvedId = priorityId;
    let legacyKey = resolved;

    if (priorityId) {
      const row = await this.resolvePriorityRowById(
        organizationId,
        spaceId,
        priorityId,
      );
      if (priority && priority !== row.key) {
        throw new BadRequestException(
          'priority_id does not match the provided priority key',
        );
      }
      resolved = row.key;
      legacyKey = row.legacyKey;
    } else {
      const row = await this.resolvePriorityRowByKey(
        organizationId,
        spaceId,
        resolved,
      );
      resolvedId = row.id;
      legacyKey = row.legacyKey;
    }

    return { key: resolved, id: resolvedId, legacyKey };
  }

  private assertStatusAllowedForTaskType(
    status: string,
    taskType: ITaskTypeLevel,
  ): void {
    const allowed = taskType.allowed_statuses ?? [];
    if (allowed.length > 0 && !allowed.includes(status)) {
      throw new BadRequestException(
        `Status "${status}" is not allowed for task type "${taskType.id}"`,
      );
    }
  }

  private isValidParentChild(
    parentType: ITaskTypeLevel,
    childType: ITaskTypeLevel,
  ): boolean {
    const parentAllowsChild =
      parentType.allowed_child_types.length === 0 ||
      parentType.allowed_child_types.includes(childType.id);
    const childAllowsParent =
      childType.allowed_parent_types.length === 0 ||
      childType.allowed_parent_types.includes(parentType.id);

    return parentAllowsChild && childAllowsParent;
  }

  private isValidStatusTransition(
    currentStatus: string,
    newStatus: string,
  ): boolean {
    if (currentStatus === newStatus) return true;

    const currentTransitions = LEGACY_TASK_STATUS_TRANSITIONS[currentStatus];
    const newStatusIsLegacy = newStatus in LEGACY_TASK_STATUS_TRANSITIONS;

    if (!currentTransitions || !newStatusIsLegacy) return true;

    return currentTransitions.includes(newStatus);
  }

  private async resolveStatusKeyById(
    organizationId: string,
    spaceId: string,
    statusId: string,
  ): Promise<string> {
    return (await this.resolveStatusRowById(organizationId, spaceId, statusId))
      .key;
  }

  /**
   * A status row's own `key` plus everything needed to derive the legacy `tasks.status` bucket.
   *
   * `task_statuses.key` is unconstrained (custom statuses exist: `todo`, `won`, `in_review`, …),
   * but the legacy `tasks.status` column is NOT NULL with
   * CHECK (open|in_progress|review|done|closed|blocked). Writing a custom key straight through
   * therefore 23514s — which is why no task in this database has ever used a custom status.
   * See `toLegacyStatusText`.
   */
  private async resolveStatusRowById(
    organizationId: string,
    spaceId: string,
    statusId: string,
  ): Promise<{
    key: string;
    isCompleted: boolean;
    categoryKey: string | null;
  }> {
    const query = this.client
      .from('task_statuses')
      .select('key, is_completed, status_categories(key)')
      .eq('id', statusId)
      .eq('organization_id', organizationId)
      .or(`space_id.is.null,space_id.eq.${spaceId}`);

    const { data, error, status: responseStatus } = await query.maybeSingle();
    if (error) throw databaseBadRequest(error, responseStatus);

    const row = data as {
      key?: string;
      is_completed?: boolean;
      status_categories?: { key?: string } | { key?: string }[] | null;
    } | null;
    const key = row?.key;

    if (!key) throw new BadRequestException('Invalid status_id');

    const cat = Array.isArray(row?.status_categories)
      ? row?.status_categories[0]
      : row?.status_categories;

    return {
      key,
      isCompleted: row?.is_completed === true,
      categoryKey: cat?.key ?? null,
    };
  }

  private async resolveStatusIdByKey(
    organizationId: string,
    spaceId: string,
    key: string,
  ): Promise<string | null> {
    const query = this.client
      .from('task_statuses')
      .select('id, space_id')
      .eq('key', key)
      .eq('organization_id', organizationId)
      .or(`space_id.eq.${spaceId},space_id.is.null`)
      .order('space_id', { ascending: false, nullsFirst: false })
      .limit(1);

    const { data, error, status: responseStatus } = await query.maybeSingle();
    if (error) throw databaseBadRequest(error, responseStatus);
    return (data as { id?: string } | null)?.id ?? null;
  }

  /**
   * Every priority visible from a space, ordered exactly as the UI lists them
   * (`TaskPrioritiesService.getAll`: `sort_order` ascending). One query, deliberately not one row:
   * `task_priorities.key` is unconstrained while `tasks.priority` is CHECK-constrained, and the only
   * language-independent signal for bucketing a custom key is WHERE IT SITS in its ladder. Same
   * round trip as the single-row lookups it replaces — a handful of small rows instead of one — so
   * no per-request memo (and a memo on this singleton service would be cross-request and stale).
   *
   * `spaceId` omitted → org-wide, matching the bulk path's existing scoping.
   */
  private async loadPriorityLadder(
    organizationId: string,
    spaceId?: string,
  ): Promise<{ id: string; key: string; space_id: string | null }[]> {
    let query = this.client
      .from('task_priorities')
      .select('id, key, space_id, sort_order')
      .eq('organization_id', organizationId);

    if (spaceId) query = query.or(`space_id.is.null,space_id.eq.${spaceId}`);

    // `key` breaks ties deterministically: priorities created through the UI all default to
    // sort_order 0, so ties are common and the bucket must be stable across calls.
    const {
      data,
      error,
      status: responseStatus,
    } = await query
      .order('sort_order', { ascending: true })
      .order('key', { ascending: true });

    if (error) throw databaseBadRequest(error, responseStatus);

    return (data ?? []) as {
      id: string;
      key: string;
      space_id: string | null;
    }[];
  }

  /**
   * A priority's bucket comes from its OWN ladder — the rows sharing its `space_id`, not the merged
   * list. A migrated space carries its source priorities alongside the org's seeded six, and
   * interleaving the two by sort_order would make "position" meaningless.
   */
  private legacyPriorityOf(
    ladder: { key: string; space_id: string | null }[],
    row: { key: string; space_id: string | null },
  ): string {
    const peers = ladder.filter((r) => r.space_id === row.space_id);

    return toLegacyPriorityText(row.key, peers.indexOf(row), peers.length);
  }

  private async resolvePriorityRowById(
    organizationId: string,
    spaceId: string | undefined,
    priorityId: string,
  ): Promise<{ key: string; legacyKey: string }> {
    const ladder = await this.loadPriorityLadder(organizationId, spaceId);
    const row = ladder.find((r) => r.id === priorityId);

    if (!row) throw new BadRequestException('Invalid priority_id');

    return { key: row.key, legacyKey: this.legacyPriorityOf(ladder, row) };
  }

  private async resolvePriorityRowByKey(
    organizationId: string,
    spaceId: string,
    key: string,
  ): Promise<{ id: string | null; legacyKey: string }> {
    const ladder = await this.loadPriorityLadder(organizationId, spaceId);
    // Space-scoped wins over org-level — the same precedence as the
    // `.order('space_id', { ascending: false, nullsFirst: false }).limit(1)` this replaces.
    const row =
      ladder.find((r) => r.key === key && r.space_id) ??
      ladder.find((r) => r.key === key);

    return {
      id: row?.id ?? null,
      legacyKey: row
        ? this.legacyPriorityOf(ladder, row)
        : toLegacyPriorityText(key, null, null),
    };
  }

  private async assertSpaceExists(
    organizationId: string,
    spaceId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from(TasksService.SPACES_TABLE)
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Space not found');
  }

  private async assertProcessBelongsToSpace(
    organizationId: string,
    processId: string,
    spaceId: string,
    message: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('business_processes')
      .select('id, space_id')
      .eq('id', processId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Process not found');
    if ((data as { space_id?: string | null }).space_id !== spaceId) {
      throw new BadRequestException(message);
    }
  }

  private async assertUserInOrganization(
    userId: string,
    organizationId: string,
    message: string,
  ): Promise<void> {
    const {
      data,
      error,
      status: responseStatus,
    } = await this.client
      .from('organization_members')
      .select('id')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw databaseBadRequest(error, responseStatus);
    if (!data) throw new BadRequestException(message);
  }

  // Lets the controller validate an on-behalf-of comment author.
  async assertCommentAuthorInOrganization(
    authorId: string,
    organizationId: string,
  ): Promise<void> {
    await this.assertUserInOrganization(
      authorId,
      organizationId,
      'The selected author must be a member of this organization',
    );
  }

  // Active user members of the space who are still in the organization
  async listActiveSpaceMemberUserIds(
    spaceId: string,
    organizationId: string,
  ): Promise<string[]> {
    const { data, error } = await this.client
      .from('space_members')
      .select('user_id')
      .eq('space_id', spaceId)
      .eq('member_type', 'user')
      .eq('is_active', true)
      .not('user_id', 'is', null);

    if (error) throw new BadRequestException(error.message);

    const ids = [
      ...new Set(
        ((data ?? []) as { user_id: string | null }[])
          .map((row) => row.user_id)
          .filter((id): id is string => !!id),
      ),
    ];

    if (ids.length === 0) return [];

    // Removing someone from the org can leave their space row behind
    const members = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', organizationId)
      .in('user_id', ids);

    if (members.error) throw new BadRequestException(members.error.message);

    const inOrg = new Set(
      ((members.data ?? []) as { user_id: string }[]).map((row) => row.user_id),
    );

    return ids.filter((id) => inOrg.has(id));
  }

  private async getTaskDescendants(
    taskId: string,
    organizationId: string,
  ): Promise<Task[]> {
    const descendants: Task[] = [];
    const queue = [taskId];
    const visited = new Set<string>();
    const maxDepth = 50;

    while (queue.length > 0 && visited.size < maxDepth) {
      const currentId = queue.shift()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const { data, error } = await this.client
        .from(TasksService.TABLE)
        .select('*')
        .eq('parent_task_id', currentId)
        .eq('organization_id', organizationId);

      if (error) throw new BadRequestException(error.message);

      const children = (data ?? []) as Task[];
      descendants.push(...children);
      queue.push(...children.map((task) => task.id));
    }

    return descendants;
  }

  private async resolveStatusId(
    organizationId: string,
    spaceId: string,
    status: string,
  ): Promise<string | null> {
    const { data } = await this.client
      .from('task_statuses')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('key', status)
      .or(`space_id.eq.${spaceId},space_id.is.null`)
      .order('space_id', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    return (data as { id?: string } | null)?.id ?? null;
  }

  private async logAudit(
    organizationId: string,
    userId: string,
    entityType: string,
    entityId: string,
    action: string,
    changes?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.client.from('audit_logs').insert({
        organization_id: organizationId,
        user_id: userId,
        entity_type: entityType,
        entity_id: entityId,
        action,
        changes: changes ?? {},
      });
    } catch {
      // Audit logging is best-effort and must not fail task mutations.
    }
  }

  /**
   * Issue group values are the one custom field type checked on the general task write path: they
   * reference option ids, so an unknown id could never be shown. An archived option stays allowed
   * only on a ticket that already holds it. Returns the fields of the space for the history entries.
   */
  private async assertIssueGroupValues(
    organizationId: string,
    spaceId: string | null | undefined,
    values: Record<string, unknown> | null | undefined,
    previous: Record<string, unknown> = {},
  ): Promise<CustomField[]> {
    if (!spaceId || !values || Object.keys(values).length === 0) return [];

    const { data, error } = await this.client
      .from('custom_fields')
      .select('field_key, name, options, validation_rules')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('field_type', 'issue_group')
      .or('is_deleted.is.null,is_deleted.eq.false');

    if (error) throw databaseBadRequest(error, 400);

    const fields = (data ?? []) as CustomField[];

    for (const field of fields) {
      const value = values[field.field_key];

      if (value === undefined || value === null) continue;

      const problem = issueGroupValueError(field, value);

      if (problem) throw new BadRequestException(problem);

      const held = previous[field.field_key];
      const archived = (field.options ?? []).filter(
        (o) =>
          o.status === 'archived' &&
          (value as string[]).includes(o.value) &&
          !(Array.isArray(held) && held.includes(o.value)),
      );

      if (archived[0]) {
        throw new BadRequestException(
          `Option "${archived[0].label}" of ${field.name} is archived`,
        );
      }
    }

    return fields;
  }

  private logIssueGroupChanges(
    taskId: string,
    organizationId: string,
    userId: string,
    fields: CustomField[],
    before: Record<string, unknown> | null | undefined,
    after: Record<string, unknown> | null | undefined,
  ): void {
    for (const field of fields) {
      const oldIds = (before?.[field.field_key] as string[] | null) ?? [];
      const newIds = (after?.[field.field_key] as string[] | null) ?? [];

      if (JSON.stringify(oldIds) === JSON.stringify(newIds)) continue;

      // Labels, not ids: the history must stay readable after an option is renamed or deleted.
      const labels = (ids: string[]) =>
        Array.isArray(ids) && ids.length > 0
          ? ids
              .map(
                (id) =>
                  field.options?.find((o) => o.value === id)?.label ?? id,
              )
              .join(', ')
          : null;

      void this.logTaskHistory(
        taskId,
        organizationId,
        userId,
        'update',
        field.name,
        labels(oldIds),
        labels(newIds),
      );
    }
  }

  private async logTaskHistory(
    taskId: string,
    organizationId: string,
    userId: string,
    action: string,
    fieldName?: string | null,
    oldValue?: unknown,
    newValue?: unknown,
  ): Promise<void> {
    try {
      await this.client.from(TasksService.HISTORY_TABLE).insert({
        task_id: taskId,
        organization_id: organizationId,
        action,
        field_name: fieldName ?? null,
        old_value: oldValue !== undefined ? oldValue : null,
        new_value: newValue !== undefined ? newValue : null,
        changed_by: userId,
      });
    } catch {
      // History logging must not fail the main operation
    }
  }

  private async getTaskHistoryRef(taskId: string | null): Promise<unknown> {
    if (!taskId) return null;

    const res = await this.client
      .from(TasksService.TABLE)
      .select('key, summary')
      .eq('id', taskId)
      .maybeSingle();
    const row = res.data as { key?: string; summary?: string } | null;

    return row
      ? {
          id: taskId,
          key: row.key ?? null,
          summary: row.summary ?? null,
        }
      : { id: taskId };
  }

  // ------------------------------------------------------------------
  // Key generation
  // ------------------------------------------------------------------

  private async generateKey(
    organizationId: string,
    spaceId: string,
  ): Promise<string> {
    // Get space key prefix
    const spaceResult = await this.client
      .from(TasksService.SPACES_TABLE)
      .select('key')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    const spaceKey = (spaceResult.data as { key?: string } | null)?.key ?? 'S';

    // Get max task number in this space
    const maxResult = await this.client
      .from(TasksService.TABLE)
      .select('key')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let nextNum = 1;
    if (maxResult.data) {
      const existing = (maxResult.data as { key: string }).key;
      const match = existing.match(/-T(\d+)$/);
      if (match) nextNum = parseInt(match[1], 10) + 1;
    }

    return `${spaceKey}-T${nextNum}`;
  }

  async reorderTasks(
    spaceId: string,
    organizationId: string,
    userId: string | null,
    updates: Array<{
      id: string;
      sort_order: number;
      parent_task_id?: string | null;
    }>,
  ): Promise<{ updated: number }> {
    if (updates.length === 0) {
      return { updated: 0 };
    }

    const { data: space, error: spaceError } = await this.client
      .from(TasksService.SPACES_TABLE)
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (spaceError) throw new BadRequestException(spaceError.message);
    if (!space) throw new NotFoundException('Space not found');

    const beforeById = new Map<string, Task>();

    for (const update of updates) {
      const reorderLookup = (await this.client
        .from(TasksService.TABLE)
        .select('*')
        .eq('id', update.id)
        .eq('organization_id', organizationId)
        .eq('space_id', spaceId)
        .maybeSingle()) as {
        data: Task | null;
        error: { message: string } | null;
      };

      if (reorderLookup.error)
        throw new BadRequestException(reorderLookup.error.message);
      if (!reorderLookup.data) throw new NotFoundException('Task not found');

      const before = reorderLookup.data;
      beforeById.set(update.id, before);
      const patch: Record<string, unknown> = {
        sort_order: update.sort_order,
        updated_at: new Date().toISOString(),
      };
      if ('parent_task_id' in update)
        patch.parent_task_id = update.parent_task_id;

      await this.validateUpdateTaskPatch(
        update.id,
        organizationId,
        before,
        patch,
      );
    }

    const reorderRpc = (await this.client.rpc('reorder_space_tasks', {
      p_space_id: spaceId,
      p_organization_id: organizationId,
      p_items: updates,
    })) as { data: unknown; error: { message: string } | null };
    const { data: updatedCount, error } = reorderRpc;

    if (error) {
      if (/not found/i.test(error.message)) {
        throw new NotFoundException(error.message);
      }
      throw new BadRequestException(error.message);
    }

    if (userId) {
      for (const update of updates) {
        const before = beforeById.get(update.id);
        if (!before) continue;
        const updatedParentTaskId =
          'parent_task_id' in update
            ? (update.parent_task_id ?? null)
            : before.parent_task_id;

        if (before.sort_order !== update.sort_order) {
          void this.logTaskHistory(
            update.id,
            organizationId,
            userId,
            'update',
            'sort_order',
            before.sort_order,
            update.sort_order,
          );
        }

        if (
          'parent_task_id' in update &&
          before.parent_task_id !== updatedParentTaskId
        ) {
          const [oldMeta, newMeta] = await Promise.all([
            this.getTaskHistoryRef(before.parent_task_id),
            this.getTaskHistoryRef(updatedParentTaskId),
          ]);
          void this.logTaskHistory(
            update.id,
            organizationId,
            userId,
            'update',
            'parent_task_id',
            oldMeta,
            newMeta,
          );
        }

        void this.logAudit(
          organizationId,
          userId,
          'task',
          update.id,
          'reorder',
          {
            space_id: spaceId,
            sort_order: {
              from: before.sort_order,
              to: update.sort_order,
            },
            parent_task_id: {
              from: before.parent_task_id,
              to: updatedParentTaskId,
            },
          },
        );
      }
    }

    return { updated: Number(updatedCount ?? updates.length) };
  }

  // ---- Bulk operations --------------------------------------------------

  /**
   * Bulk update tasks (status, priority, assignee, due date).
   *
   * Status changes run through the workflow engine per task so automation
   * post-functions (send_notification, trigger_webhook, etc.) fire exactly as
   * they do for single-task PATCH /tasks/:id requests. Only tasks with no
   * active workflow assignment fall back to a direct DB write. A task under a
   * workflow is never direct-written: a condition refusal counts as `blocked`;
   * no/ambiguous transition, validator, conflict or engine failure counts as
   * `skipped` with a reason in `skipped_reasons`.
   *
   * Priority, assignee, and due-date changes are applied via a single batch
   * UPDATE — the engine has no hooks for those fields.
   */
  async bulkUpdateTasks(
    organizationId: string,
    userId: string,
    ids: string[],
    updates: {
      status_id?: string;
      priority_id?: string;
      assigned_to?: string | null;
      due_date?: string | null;
    },
  ): Promise<{
    success: boolean;
    updated: number;
    blocked: number;
    skipped: number;
    skipped_reasons: Array<{ task_id: string; reason: string }>;
  }> {
    if (!ids.length)
      return {
        success: true,
        updated: 0,
        blocked: 0,
        skipped: 0,
        skipped_reasons: [],
      };

    // ------------------------------------------------------------------
    // Phase 1: status changes via the workflow engine (per-task)
    // ------------------------------------------------------------------
    const directStatusIds: string[] = [];
    const watcherTaskIds = new Set<string>();
    // Tasks whose status change was refused by a workflow condition. These are
    // NOT direct-written — that is exactly the bypass this guards against.
    let blockedCount = 0;
    // Workflow-assigned tasks with no valid/unambiguous transition, or whose
    // transition failed (validator, conflict, infra). Also never direct-written.
    const skippedReasons: Array<{ task_id: string; reason: string }> = [];

    if (updates.status_id !== undefined && this.engine && this.assignments) {
      const engineUser = await this.buildEngineUser(userId, organizationId);

      // Only tasks WITHOUT a workflow assignment keep the legacy direct write.
      // One scope read + one assignment lookup per space/type pair (same
      // arguments as the engine) — no per-task query.
      const { data: scopeRows, error: scopeErr } = await this.client
        .from(TasksService.TABLE)
        .select('id, space_id, task_type_id')
        .in('id', ids)
        .eq('organization_id', organizationId);

      if (scopeErr) throw scopeErr;

      const assignmentByScope = new Map<string, Promise<unknown>>();
      const workflowTaskIds = new Set<string>();

      for (const row of (scopeRows ?? []) as Array<{
        id: string;
        space_id: string | null;
        task_type_id: string | null;
      }>) {
        const scopeKey = `${row.space_id ?? ''}|${row.task_type_id ?? '*'}`;

        if (!assignmentByScope.has(scopeKey)) {
          assignmentByScope.set(
            scopeKey,
            this.assignments.findActiveAssignmentForType(
              organizationId,
              row.space_id ?? '',
              row.task_type_id ?? '*',
            ),
          );
        }
        if (await assignmentByScope.get(scopeKey)) workflowTaskIds.add(row.id);
      }

      const skipOrDirectWrite = (taskId: string, reason: string) => {
        if (workflowTaskIds.has(taskId)) {
          skippedReasons.push({ task_id: taskId, reason });
          this.logger.warn(
            `Bulk status change: skipped task ${taskId} under its workflow (${reason})`,
          );
        } else {
          directStatusIds.push(taskId);
        }
      };

      for (const taskId of ids) {
        // Resolve scope: a NotFound/infra throw here means we could not even
        // evaluate the workflow — skipped under a workflow, else direct write.
        let resolution: Awaited<
          ReturnType<WorkflowEngineService['resolveTransitionByStatusChange']>
        >;

        try {
          resolution = await this.engine.resolveTransitionByStatusChange(
            taskId,
            updates.status_id,
            engineUser,
          );
        } catch (err) {
          this.logger.warn(
            `Bulk status change: engine resolution failed for task ${taskId}: ${(err as Error).message}`,
          );
          skipOrDirectWrite(taskId, 'error');
          continue;
        }

        if ('error' in resolution) {
          if (resolution.error === 'condition_failed') {
            // A transition connects current→target but a workflow condition
            // blocked it. Do NOT direct-write — the child keeps its status.
            blockedCount++;
            this.logger.warn(
              `Bulk status change: blocked by workflow condition for task ${taskId} (transition ${resolution.blockedTransition.id})`,
            );
            continue;
          }

          // no_path / multiple_paths — no valid or unambiguous transition.
          skipOrDirectWrite(taskId, resolution.error);
          continue;
        }

        // Execute scope: the transition resolved (its conditions passed). A
        // ForbiddenException here means a condition re-check failed (e.g. the
        // parent changed status between resolve and execute) — block it too.
        // Validator (422) / concurrency (409) / infra are skipped with a reason.
        try {
          await this.engine.executeTransition({
            taskId,
            transitionId: resolution.transition.id,
            screenInput: {},
            user: engineUser,
            notifyWatchers: false,
          });
          watcherTaskIds.add(taskId);
        } catch (err) {
          if (err instanceof ForbiddenException) {
            blockedCount++;
            this.logger.warn(
              `Bulk status change: transition blocked by condition on execute for task ${taskId}: ${err.message}`,
            );
            continue;
          }
          this.logger.warn(
            `Bulk status change: engine skipped for task ${taskId}: ${(err as Error).message}`,
          );
          skipOrDirectWrite(
            taskId,
            err instanceof UnprocessableEntityException
              ? 'validation_failed'
              : err instanceof ConflictException
                ? 'conflict'
                : 'error',
          );
        }
      }
    } else if (updates.status_id !== undefined) {
      // Engine not injected — all tasks fall back to direct write
      directStatusIds.push(...ids);
    }

    // ------------------------------------------------------------------
    // Phase 2: direct DB write for status fallbacks + non-status fields
    // ------------------------------------------------------------------

    // Resolve status key once for direct-write tasks
    let statusKey: string | undefined;

    if (directStatusIds.length > 0 && updates.status_id !== undefined) {
      // A bulk change spans spaces, so this stays org-scoped rather than reusing
      // `resolveStatusRowById`. It selects the same extra columns that funnel needs, because
      // `tasks.status` is CHECK-constrained to six values and `task_statuses.key` is not.
      const { data: statusRow, error: statusErr } = await this.client
        .from('task_statuses')
        .select('key, is_completed, status_categories(key)')
        .eq('id', updates.status_id)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (statusErr) throw new BadRequestException(statusErr.message);

      const row = statusRow as {
        key?: string;
        is_completed?: boolean;
        status_categories?: { key?: string } | { key?: string }[] | null;
      } | null;

      statusKey = row?.key;

      if (!statusKey) throw new BadRequestException('Invalid status_id');

      const cat = Array.isArray(row?.status_categories)
        ? row?.status_categories[0]
        : row?.status_categories;

      const legacyStatus = toLegacyStatusText(
        statusKey,
        row?.is_completed === true,
        cat?.key ?? null,
      );

      // Snapshot before the write so the automation event can carry the real previous status.
      // Only this fallback branch needs it: the Phase 1 tasks above went through
      // `executeTransition`, which already emits `app.task.status_changed` itself — emitting
      // again here would double-fire for every one of them.
      const { data: beforeRows, error: beforeErr } = await this.client
        .from(TasksService.TABLE)
        .select(
          'id, key, summary, status, status_id, priority, assigned_to, space_id',
        )
        .in('id', directStatusIds)
        .eq('organization_id', organizationId);

      if (beforeErr) throw beforeErr;

      const { error: statusUpdateErr } = await this.client
        .from(TasksService.TABLE)
        .update({
          status_id: updates.status_id,
          status: legacyStatus,
          updated_at: new Date().toISOString(),
        })
        .in('id', directStatusIds)
        .eq('organization_id', organizationId);

      if (statusUpdateErr) throw statusUpdateErr;

      // Emitted only after the write succeeded, one event per task, and only for tasks whose
      // status actually moved — re-applying the status a task already has is not "reaching" it.
      // Each event carries that task's own space_id: a bulk selection can span spaces and the
      // outbox column is NOT NULL.
      for (const row of (beforeRows ?? []) as TaskStatusChangedSnapshot[]) {
        if (row.status_id === updates.status_id) continue;
        watcherTaskIds.add(row.id);

        this.outboxService?.emitTaskStatusChanged(
          organizationId,
          { status: row.status, status_id: row.status_id },
          { ...row, status: legacyStatus, status_id: updates.status_id },
          userId,
        );
      }
    }

    // Resolve priority key + build the non-status patch
    const nonStatusPatch: Record<string, unknown> = {};

    if (updates.priority_id !== undefined) {
      nonStatusPatch.priority_id = updates.priority_id;
      // A bulk change spans spaces, so the ladder is org-wide — identical scoping to the inline
      // lookup this replaces, but routed through the one funnel that buckets the key.
      const row = await this.resolvePriorityRowById(
        organizationId,
        undefined,
        updates.priority_id,
      );

      nonStatusPatch.priority = row.legacyKey;
    }

    if (updates.assigned_to !== undefined)
      nonStatusPatch.assigned_to = updates.assigned_to;
    if (updates.due_date !== undefined)
      nonStatusPatch.due_date = updates.due_date;

    // Assignee and due date of test tickets sync to their test record, so they change in Test Management only.
    const testTicketIds =
      updates.assigned_to !== undefined || updates.due_date !== undefined
        ? await this.testTicketIds(organizationId, ids)
        : new Set<string>();

    for (const taskId of testTicketIds) {
      skippedReasons.push({
        task_id: taskId,
        reason:
          'Assignee and due date of a Test Management item are changed in Test Management.',
      });
    }

    const plainIds = ids.filter((taskId) => !testTicketIds.has(taskId));

    if (testTicketIds.size > 0 && nonStatusPatch.priority_id !== undefined) {
      const { error: priorityErr } = await this.client
        .from(TasksService.TABLE)
        .update({
          priority_id: nonStatusPatch.priority_id,
          priority: nonStatusPatch.priority,
          updated_at: new Date().toISOString(),
        })
        .in('id', [...testTicketIds])
        .eq('organization_id', organizationId);

      if (priorityErr) throw priorityErr;
      for (const taskId of testTicketIds) watcherTaskIds.add(taskId);
    }

    if (Object.keys(nonStatusPatch).length > 0 && plainIds.length > 0) {
      const { error: nonStatusErr } = await this.client
        .from(TasksService.TABLE)
        .update({ ...nonStatusPatch, updated_at: new Date().toISOString() })
        .in('id', plainIds)
        .eq('organization_id', organizationId);

      if (nonStatusErr) throw nonStatusErr;
      for (const taskId of plainIds) watcherTaskIds.add(taskId);
    }

    if (this.watchersService && watcherTaskIds.size > 0) {
      const { data: watcherTasks, error: watcherTasksError } = await this.client
        .from(TasksService.TABLE)
        .select('id, key, summary, space_id')
        .eq('organization_id', organizationId)
        .in('id', [...watcherTaskIds]);
      if (watcherTasksError) {
        this.logger.warn(
          `Bulk watcher task lookup failed: ${watcherTasksError.message}`,
        );
      } else {
        for (const task of (watcherTasks ?? []) as Array<{
          id: string;
          key: string;
          summary: string;
          space_id: string | null;
        }>) {
          void this.watchersService.notifyTaskWatchers({
            organizationId,
            spaceId: task.space_id,
            taskId: task.id,
            actorUserId: userId,
            taskKey: task.key,
            title: task.summary,
            changeKind: 'bulk_updated',
          });
        }
      }
    }

    return {
      success: true,
      updated: ids.length - blockedCount - skippedReasons.length,
      blocked: blockedCount,
      skipped: skippedReasons.length,
      skipped_reasons: skippedReasons,
    };
  }

  /**
   * Bulk delete tasks scoped to the caller's organization.
   *
   * Calls the single-task delete() per task so that cascade cleanup, storage
   * object removal, automation events (app.task.deleted), and audit logs all
   * fire — the same as a single-task DELETE /tasks/:id request.
   */
  async bulkDeleteTasks(
    organizationId: string,
    userId: string,
    ids: string[],
  ): Promise<{ deleted: number; blocked: string[]; forbidden: string[] }> {
    // Tickets whose test case has execution results; delete() refuses them with 409.
    const blocked: string[] = [];
    // Test tickets the user may not delete in their space; delete() refuses them with 403.
    const forbidden: string[] = [];
    let deleted = 0;

    if (!ids.length) return { deleted, blocked, forbidden };

    for (const taskId of ids) {
      try {
        await this.delete(taskId, organizationId, userId);
        deleted++;
      } catch (err) {
        if (err instanceof ConflictException) blocked.push(taskId);
        if (err instanceof ForbiddenException) forbidden.push(taskId);

        this.logger.warn(
          `Bulk delete: failed to delete task ${taskId}: ${(err as Error).message}`,
        );
      }
    }

    return { deleted, blocked, forbidden };
  }
}
