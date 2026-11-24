// MCP-facing, space-membership + space-permission constrained task WRITES
// backing the MCP `task.create` / `task.update` / `task.comment` tools.
//
// Mirrors the READ pattern in tasks.service `getMyTask` / wiki-mine.service:
// every "you cannot write here" case (non-member space, missing space
// permission, cross-org, nonexistent space/task) collapses to the identical
// NotFoundException('Task not found') — anti-probing, never a 403, never
// distinguishable. The org is ALWAYS taken from the authenticated RequestUser
// (`user.organizationId`), never from a parameter, so the caller cannot cross
// orgs.
//
// Space gate (per operation): allow iff the caller is an org admin/owner, or
// is an active member of the target space AND holds the space-level permission
// for that operation (`create_tasks` / `edit_tasks` / `add_comments_tasks`).
// These are the short `space_module_permissions` keys (the `can_` prefix
// stripped) that SpacePermissionsGuard and getUserSpacePermissions use.
//
// All domain logic (key generation, status/priority resolution, rich-text
// sanitization, audit_logs, the tasks_history_trigger, optimistic version on
// updates) is delegated to TasksService so this wrapper only adds the space
// gate, the safe input/output whitelist, and the create-default task-type
// resolution. An explicit parent and task type ARE accepted at create (the
// parent is resolved org-scoped + same-space, and TasksService.create's
// validateCreateTaskInput enforces type/hierarchy rules). NEVER allowed from
// the client: status, attachments/files, custom fields, process override,
// space/org move.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { TasksService, type MyTaskDetail } from './tasks.service';
import {
  getValidChildTypes,
  type ITaskHierarchyConfig,
} from '../task-hierarchy-config/models/task-hierarchy-config.model';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { MineCreateTaskDto } from './dto/mine-create-task.dto';
import type { MineUpdateTaskDto } from './dto/mine-update-task.dto';
import type { CreateTaskDto } from './dto/create-task.dto';
import { validateFieldValue } from '../custom-fields/utils/custom-field-validation';
import type { CustomField } from '../custom-fields/models/custom-field.model';

/**
 * What a server-side caller (Robert's Confirm, XE-T353 1.14) has already resolved and may pass
 * beside the DTO. Never reachable from a client: the MCP controller has no third argument.
 */
export interface TrustedTaskCreate {
  /** The reserved id: a repeated create collides on the primary key instead of duplicating. */
  taskId?: string;
  /** A status id of the space; a workflow on the type still decides the first status. */
  status?: string;
  /** Keyed by `custom_fields.field_key`; each value is checked with validateFieldValue. */
  customFieldValues?: Record<string, unknown>;
  /** Parent id or key when the DTO names none; the same org and same-space checks apply. */
  parentTaskId?: string;
  /** The process this task belongs to; TasksService checks it is in the same space. */
  processId?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Short space-permission key gating task creation in a space. */
const CREATE_TASKS_PERMISSION = 'create_tasks';

/** Short space-permission key gating task edits in a space. */
const EDIT_TASKS_PERMISSION = 'edit_tasks';

/** Short space-permission key gating task comments in a space. */
const ADD_COMMENTS_TASKS_PERMISSION = 'add_comments_tasks';

/** A whitelisted space reference embedded in a safe task result. */
interface SafeSpaceRef {
  id: string;
  key: string;
  name: string;
}

/** The whitelisted, MCP-safe comment shape returned by `addComment`. */
export interface MineCommentResult {
  id: string;
  taskId: string;
  author: { id: string; name: string } | null;
  createdAt: string;
}

@Injectable()
export class TasksMineWriteService {
  private static readonly TASKS_TABLE = 'tasks';
  private static readonly SPACES_TABLE = 'spaces';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissionsService: PermissionsService,
    private readonly tasksService: TasksService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Uniform 404 for every denial — anti-probing, never disambiguate. */
  private notFound(): NotFoundException {
    return new NotFoundException('Task not found');
  }

  // The single space gate shared by all three operations. Allow iff the caller
  // is an org admin/owner, or is an active member of `spaceId` AND holds the
  // short space permission `permissionKey`. Every other case (non-member,
  // missing permission, nonexistent/cross-org space) returns false; the caller
  // converts that to the uniform notFound(). spaceId may be null for org-level
  // tasks — those are denied here (the MCP write surface is space-scoped).
  private async hasSpacePermission(
    user: RequestUser,
    spaceId: string | null,
    permissionKey: string,
  ): Promise<boolean> {
    if (!user.organizationId || !spaceId) {
      return false;
    }

    const isAdminOrOwner = await this.permissionsService.isAdminOrOwner(
      user.userId,
      user.organizationId,
    );

    if (isAdminOrOwner) {
      return true;
    }

    const resolved = await this.permissionsService.getUserSpacePermissions(
      user.userId,
      user.organizationId,
      spaceId,
    );

    return resolved.isMember && resolved.permissions[permissionKey] === true;
  }

  /** Resolve a space UUID or key to a space id, scoped to the org (or null). */
  private async resolveSpaceIdOrKey(
    spaceIdOrKey: string,
    organizationId: string,
  ): Promise<string | null> {
    const isUuid = UUID_RE.test(spaceIdOrKey);

    const result = await this.client
      .from(TasksMineWriteService.SPACES_TABLE)
      .select('id')
      .eq(
        isUuid ? 'id' : 'key',
        isUuid ? spaceIdOrKey : spaceIdOrKey.toUpperCase(),
      )
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (result.error) return null;

    return (result.data as { id?: string } | null)?.id ?? null;
  }

  // Resolve the org-scoped task by UUID or key to its identity + lock columns.
  // Returns null when missing / cross-org (caller maps to uniform notFound()).
  private async resolveTaskRef(
    taskIdOrKey: string,
    organizationId: string,
  ): Promise<{ id: string; space_id: string | null; version: number; task_type_id?: string | null } | null> {
    const isUuid = UUID_RE.test(taskIdOrKey);

    const result = await this.client
      .from(TasksMineWriteService.TASKS_TABLE)
      .select('id, space_id, version, task_type_id')
      .eq(
        isUuid ? 'id' : 'key',
        isUuid ? taskIdOrKey : taskIdOrKey.toUpperCase(),
      )
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (result.error || !result.data) return null;

    const row = result.data as {
      id: string;
      space_id: string | null;
      version: number | null;
      task_type_id?: string | null;
    };

    return {
      task_type_id: row.task_type_id,
      id: row.id,
      space_id: row.space_id ?? null,
      version: typeof row.version === 'number' ? row.version : 0,
    };
  }

  // Resolve a task-level default `task_type_id` for the space from the task
  // hierarchy configuration (per-space config, falling back to the org default).
  // Preference order: the canonical task-level type id `task` when present and
  // active; else the first active root type (no parent_level_id); else the first
  // active type. Throws the uniform notFound() when no active type exists (a
  // misconfigured space must not leak an internal error to the MCP surface).
  private async resolveDefaultTaskTypeId(
    organizationId: string,
    spaceId: string,
  ): Promise<string> {
    const activeTypes = await this.tasksService.getActiveTaskTypesForSpace(
      organizationId,
      spaceId,
    );

    if (activeTypes.length === 0) {
      throw this.notFound();
    }

    const taskLevel = activeTypes.find((t) => t.id === 'task');

    if (taskLevel) {
      return taskLevel.id;
    }

    const root = activeTypes.find((t) => !t.parent_level_id);

    return (root ?? activeTypes[0]).id;
  }

  /** The type a child of that type gets: `subtask` when allowed, else the first allowed. */
  private async childTypeOf(
    organizationId: string,
    spaceId: string,
    parentTypeId: string,
  ): Promise<string | undefined> {
    const levels = await this.tasksService.getActiveTaskTypesForSpace(
      organizationId,
      spaceId,
    );
    const allowed = getValidChildTypes(
      { levels } as ITaskHierarchyConfig,
      parentTypeId,
    );
    return (allowed.find((t) => t.id === 'subtask') ?? allowed[0])?.id;
  }

  // Resolve assignee/reporter display names + the space ref for the SAFE shape,
  // mapping a freshly created/updated task row to MyTaskDetail. Reuses the same
  // projection getMyTask produces so the MCP write path returns precisely the
  // read shape, without re-applying the read view gate (the caller already
  // passed the write gate). Names are resolved from a single users lookup.
  private async toSafeTask(
    raw: Record<string, unknown>,
    organizationId: string,
  ): Promise<MyTaskDetail> {
    const spaceId = (raw.space_id as string | null) ?? null;
    let space: SafeSpaceRef | null = null;

    if (spaceId) {
      const spaceRow = await this.client
        .from(TasksMineWriteService.SPACES_TABLE)
        .select('id, key, name')
        .eq('id', spaceId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      const s = spaceRow.data as SafeSpaceRef | null;

      if (s) {
        space = { id: s.id, key: s.key, name: s.name };
      }
    }

    const assignedTo = (raw.assigned_to as string | null) ?? null;
    const reporterId = (raw.reporter as string | null) ?? null;
    const actorIds = new Set<string>();

    if (assignedTo) actorIds.add(assignedTo);
    if (reporterId) actorIds.add(reporterId);

    const actorsById = new Map<string, { id: string; name: string }>();

    if (actorIds.size > 0) {
      const usersResult = await this.client
        .from('users')
        .select('id, first_name, last_name, email')
        .in('id', [...actorIds]);

      for (const u of (usersResult.data ?? []) as Array<{
        id?: string;
        first_name?: string | null;
        last_name?: string | null;
        email?: string | null;
      }>) {
        if (!u.id) continue;
        const name =
          `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() ||
          (u.email ?? '');

        actorsById.set(u.id, { id: u.id, name });
      }
    }

    const versionRaw = raw.version;

    return {
      id: raw.id as string,
      key: (raw.key as string | null) ?? null,
      summary: (raw.summary as string) ?? '',
      description: (raw.description as string | null) ?? null,
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
  }

  // Create a task in a space the caller may write to. Resolves the space
  // org-scoped, gates on the `create_tasks` space permission, validates the
  // assignee (if any) is in the org, resolves a default task-level task_type_id
  // for the space, then delegates to TasksService.create so key generation,
  // sanitization, audit, and history all run. Returns the SAFE shape.
  // `trusted` (server callers only) adds the reserved id, the status and custom field
  // values; without it the call is exactly the MCP path.
  async createTask(
    user: RequestUser,
    dto: MineCreateTaskDto,
    trusted?: TrustedTaskCreate,
  ): Promise<{ task: MyTaskDetail }> {
    if (!user.organizationId) {
      throw this.notFound();
    }

    const spaceId = await this.resolveSpaceIdOrKey(
      dto.spaceIdOrKey,
      user.organizationId,
    );

    if (!spaceId) {
      throw this.notFound();
    }

    if (
      !(await this.hasSpacePermission(user, spaceId, CREATE_TASKS_PERMISSION))
    ) {
      throw this.notFound();
    }

    if (dto.assigneeId) {
      await this.assertUserInOrg(dto.assigneeId, user.organizationId);
    }

    await this.assertKnownPriority(dto.priority, user.organizationId, spaceId);

    // Optional explicit parent: resolve org-scoped (UUID or key). A missing /
    // cross-org parent yields the uniform notFound() — the caller must not
    // learn whether a task id exists (same pattern as assertUserInOrg). A
    // parent in a DIFFERENT space is a definite input error → 400. Type-vs-
    // parent hierarchy compatibility is enforced downstream by
    // TasksService.create's validateCreateTaskInput (clear 400s).
    let parentId: string | undefined;
    let parentTypeId: string | null | undefined;
    const parentRef = dto.parentTaskId ?? trusted?.parentTaskId;
    if (parentRef) {
      const parent = await this.resolveTaskRef(parentRef, user.organizationId);

      if (!parent) {
        throw this.notFound();
      }

      if (parent.space_id !== spaceId) {
        throw new BadRequestException('parent task must be in the same space');
      }

      parentId = parent.id;
      parentTypeId = parent.task_type_id;
    }

    // Explicit task type (a hierarchy level id) wins; otherwise resolve the
    // space's task-level default. Existence/active + parent-child rules are
    // validated by TasksService.create's validateCreateTaskInput.
    // A trusted caller's parent may not have existed when the type was chosen (Robert, a subtask in
    // a space of the same request): it gets a type that may sit under that parent.
    const taskTypeId =
      dto.taskTypeId ??
      (trusted && parentTypeId
        ? await this.childTypeOf(user.organizationId, spaceId, parentTypeId)
        : undefined) ??
      (await this.resolveDefaultTaskTypeId(user.organizationId, spaceId));

    const input: CreateTaskDto = {
      space_id: spaceId,
      summary: dto.summary,
      description: dto.description,
      task_type_id: taskTypeId,
      parent_task_id: parentId,
      priority: dto.priority,
      assigned_to: dto.assigneeId,
      due_date: dto.dueDate,
      labels: dto.labels,
    };

    const created = trusted
      ? await this.tasksService.create(
          user.organizationId,
          user.userId,
          {
            ...input,
            ...(trusted.processId && { process_id: trusted.processId }),
            ...(trusted.status && { status_id: trusted.status }),
            ...(trusted.customFieldValues && {
              custom_field_values: await this.checkCustomFieldValues(
                trusted.customFieldValues,
                user.organizationId,
              ),
            }),
          },
          { ...(trusted.taskId && { taskId: trusted.taskId }) },
        )
      : await this.tasksService.create(user.organizationId, user.userId, input);

    const task = await this.toSafeTask(
      created as unknown as Record<string, unknown>,
      user.organizationId,
    );

    return { task };
  }

  // Update whitelisted fields of a task the caller may edit, under optimistic
  // locking. Resolves the task org-scoped, gates on the `edit_tasks` space
  // permission, validates the assignee (if any), then performs a guarded
  // version claim: an atomic UPDATE that bumps `version` only when the row's
  // current version still equals `expectedVersion`. A lost claim throws a
  // ConflictException carrying ONLY the current version. After the claim, the
  // field updates are delegated to TasksService.update (which does not re-bump
  // version on the non-engine path) for validation, audit, and history. Returns
  // the SAFE shape. Space/org are never moved (the DTO omits those fields).
  async updateTask(
    user: RequestUser,
    taskIdOrKey: string,
    dto: MineUpdateTaskDto,
  ): Promise<{ task: MyTaskDetail }> {
    if (!user.organizationId) {
      throw this.notFound();
    }

    const ref = await this.resolveTaskRef(taskIdOrKey, user.organizationId);

    if (!ref) {
      throw this.notFound();
    }

    if (
      !(await this.hasSpacePermission(
        user,
        ref.space_id,
        EDIT_TASKS_PERMISSION,
      ))
    ) {
      throw this.notFound();
    }

    if (dto.assigneeId) {
      await this.assertUserInOrg(dto.assigneeId, user.organizationId);
    }

    // Reject an unknown priority BEFORE the version claim, so a bad priority
    // never bumps the version. The space is non-null here (the gate passed).
    if (ref.space_id) {
      await this.assertKnownPriority(
        dto.priority,
        user.organizationId,
        ref.space_id,
      );
    }

    // Guarded version claim: atomically bump version iff it still equals the
    // expected value. A no-row result means a concurrent writer moved on; we
    // read back the current version and surface it (and nothing else).
    const claim = await this.client
      .from(TasksMineWriteService.TASKS_TABLE)
      .update({
        version: dto.expectedVersion + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', ref.id)
      .eq('organization_id', user.organizationId)
      .eq('version', dto.expectedVersion)
      .select('id')
      .maybeSingle();

    if (claim.error || !claim.data) {
      const currentVersion = await this.readCurrentVersion(
        ref.id,
        user.organizationId,
      );

      // Nest the version under `data` so the global exception filter preserves
      // it (the filter only copies an exception's `data` key); the MCP client
      // reads `data.currentVersion`. Nothing else about the task is leaked.
      throw new ConflictException({
        message: 'Task was modified concurrently',
        data: { currentVersion },
      });
    }

    // Field updates delegated to the core service (validation + audit +
    // history). The plain non-engine UPDATE path does not touch `version`, so
    // the guarded claim above remains the authoritative single bump.
    const updated = await this.tasksService.update(
      ref.id,
      user.organizationId,
      user.userId,
      {
        summary: dto.summary,
        description: dto.description,
        priority: dto.priority,
        assigned_to: dto.assigneeId,
        due_date: dto.dueDate,
        labels: dto.labels,
      },
    );

    const task = await this.toSafeTask(
      updated as unknown as Record<string, unknown>,
      user.organizationId,
    );

    return { task };
  }

  // Add a comment to a task the caller may comment on. Resolves the task
  // org-scoped, gates on the `add_comments_tasks` space permission, then
  // delegates to TasksService.createComment (which sanitizes the content and
  // writes history/audit). Returns the SAFE comment shape.
  async addComment(
    user: RequestUser,
    taskIdOrKey: string,
    content: string,
  ): Promise<{ comment: MineCommentResult }> {
    if (!user.organizationId) {
      throw this.notFound();
    }

    const ref = await this.resolveTaskRef(taskIdOrKey, user.organizationId);

    if (!ref) {
      throw this.notFound();
    }

    if (
      !(await this.hasSpacePermission(
        user,
        ref.space_id,
        ADD_COMMENTS_TASKS_PERMISSION,
      ))
    ) {
      throw this.notFound();
    }

    const created = (await this.tasksService.createComment(
      ref.id,
      user.organizationId,
      user.userId,
      content,
    )) as Record<string, unknown> | null;

    const authorId = (created?.created_by as string | null) ?? user.userId;
    const author = await this.lookupActor(authorId);

    return {
      comment: {
        id: (created?.id as string) ?? '',
        taskId: ref.id,
        author,
        createdAt: (created?.created_at as string) ?? '',
      },
    };
  }

  // Reject a supplied priority that does not resolve to a configured priority
  // for the org/space. Otherwise the core service would silently store the raw
  // string in the legacy `priority` varchar with a null `priority_id` — a
  // data-integrity hole on the MCP write surface. Unknown → safe 400.
  private async assertKnownPriority(
    priority: string | undefined,
    organizationId: string,
    spaceId: string,
  ): Promise<void> {
    if (priority === undefined) {
      return;
    }

    const result = await this.client
      .from('task_priorities')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('key', priority)
      .or(`space_id.eq.${spaceId},space_id.is.null`)
      .limit(1)
      .maybeSingle();

    if (result.error || !result.data) {
      throw new BadRequestException('unknown priority');
    }
  }

  // Validate trusted custom field values against their definitions in the org.
  // An unknown key or a value that does not fit its field is a 400, never stored.
  private async checkCustomFieldValues(
    values: Record<string, unknown>,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const keys = Object.keys(values);
    if (keys.length === 0) return {};

    const result = await this.client
      .from('custom_fields')
      .select('field_key, field_type, name, validation_rules, options')
      .eq('organization_id', organizationId)
      .in('field_key', keys);

    if (result.error) {
      throw new BadRequestException('custom fields could not be checked');
    }

    const defs = new Map(
      ((result.data ?? []) as CustomField[]).map((f) => [f.field_key, f]),
    );

    for (const key of keys) {
      const def = defs.get(key);
      if (!def) throw new BadRequestException(`unknown custom field ${key}`);
      try {
        validateFieldValue(def, values[key]);
      } catch (err) {
        throw new BadRequestException(
          err instanceof Error ? err.message : 'invalid custom field value',
        );
      }
    }

    return values;
  }

  /** Read the current task version, org-scoped (0 when unreadable). */
  private async readCurrentVersion(
    taskId: string,
    organizationId: string,
  ): Promise<number> {
    const result = await this.client
      .from(TasksMineWriteService.TASKS_TABLE)
      .select('version')
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    const v = (result.data as { version?: number | null } | null)?.version;

    return typeof v === 'number' ? v : 0;
  }

  // Validate the user is a member of the org. A non-member yields the uniform
  // notFound() — an MCP caller must not learn whether a given user id exists.
  private async assertUserInOrg(
    userId: string,
    organizationId: string,
  ): Promise<void> {
    const result = await this.client
      .from('organization_members')
      .select('id')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (result.error || !result.data) {
      throw this.notFound();
    }
  }

  /** Resolve a `{id,name}` actor ref from public.users (or null). */
  private async lookupActor(
    userId: string | null,
  ): Promise<{ id: string; name: string } | null> {
    if (!userId) return null;

    const result = await this.client
      .from('users')
      .select('id, first_name, last_name, email')
      .eq('id', userId)
      .maybeSingle();

    const u = result.data as {
      id?: string;
      first_name?: string | null;
      last_name?: string | null;
      email?: string | null;
    } | null;

    if (!u?.id) return null;

    const name =
      `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || (u.email ?? '');

    return { id: u.id, name };
  }
}
