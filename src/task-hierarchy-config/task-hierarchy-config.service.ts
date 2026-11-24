/**
 * @fileoverview Service for the task hierarchy configuration
 * (`task_hierarchy_configurations` table). Org-scoped, per-space.
 * Exposes sub-actions: saveConfig, resetToDefault, addTaskType,
 * updateTaskType, removeTaskType, reorder, plus query helpers.
 * Matches the old `TaskHierarchyConfigService` behavior 1:1.
 * @module src/task-hierarchy-config/task-hierarchy-config.service
 * @author Prince Jadiya
 */

import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { databaseBadRequest } from '../common/utils/database-error';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { OrganizationModulesService } from '../organization-modules/organization-modules.service';
import { readTestTaskTypes } from '../test-management/common/test-task-types';
import {
  taskHierarchyConfigSchema,
  taskTypeLevelSchema,
  validateTaskHierarchyConfig,
  getActiveTaskTypes,
  getRootTaskTypes,
  getTaskTypeById,
  getValidParentTypes,
  getValidChildTypes,
  DEFAULT_TASK_HIERARCHY_CONFIG,
  type ITaskHierarchyConfig,
  type ITaskHierarchyConfigRecord,
  type ITaskTypeLevel,
  type ITaskHierarchyValidationResult,
} from './models/task-hierarchy-config.model';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new BadRequestException(`${field} must be a valid UUID`);
  }
}

export interface GetTaskConfigResult {
  config: ITaskHierarchyConfig;
  record: ITaskHierarchyConfigRecord | null;
  isDefault: boolean;
}

export interface IEnsureTaskTypeInput {
  /** Caller's name for the type; the result is keyed by it. */
  key: string;
  /** Type id already linked to this key, if any. */
  currentId: string | null;
  level: Partial<ITaskTypeLevel> & Pick<ITaskTypeLevel, 'id' | 'name'>;
  /** Old default names: a type still named like this takes the new name. */
  renameFrom?: string[];
}

@Injectable()
export class TaskHierarchyConfigService {
  private static readonly TABLE = 'task_hierarchy_configurations';
  private static readonly TASKS_TABLE = 'tasks';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly orgModules?: OrganizationModulesService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ------------------------------------------------------------------
  // Lookup
  // ------------------------------------------------------------------

  private async findBySpace(
    organizationId: string,
    spaceId: string,
  ): Promise<ITaskHierarchyConfigRecord | null> {
    const r = await this.client
      .from(TaskHierarchyConfigService.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .maybeSingle();
    if (r.error) throw databaseBadRequest(r.error, r.status);
    return (r.data as ITaskHierarchyConfigRecord | null) ?? null;
  }

  async getConfig(
    organizationId: string,
    spaceId: string,
  ): Promise<GetTaskConfigResult> {
    assertUuid(organizationId, 'organizationId');
    assertUuid(spaceId, 'spaceId');
    const record = await this.findBySpace(organizationId, spaceId);
    if (record) {
      return { config: record.config, record, isDefault: false };
    }
    return {
      config: DEFAULT_TASK_HIERARCHY_CONFIG,
      record: null,
      isDefault: true,
    };
  }

  // ------------------------------------------------------------------
  // Validate
  // ------------------------------------------------------------------

  validateConfig(config: ITaskHierarchyConfig): ITaskHierarchyValidationResult {
    const parsed = taskHierarchyConfigSchema.safeParse(config);
    if (!parsed.success) {
      return {
        isValid: false,
        errors: parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      };
    }
    return validateTaskHierarchyConfig(parsed.data);
  }

  // ------------------------------------------------------------------
  // Save
  // ------------------------------------------------------------------

  async saveConfig(
    organizationId: string,
    spaceId: string,
    config: ITaskHierarchyConfig,
    userId: string | null,
    auditOperation: string = 'save',
    options: { allowTestTypeChanges?: boolean } = {},
  ): Promise<ITaskHierarchyConfigRecord> {
    assertUuid(organizationId, 'organizationId');
    assertUuid(spaceId, 'spaceId');

    const parsed = taskHierarchyConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid task hierarchy configuration',
        errors: parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const business = validateTaskHierarchyConfig(parsed.data);
    if (!business.isValid) {
      throw new BadRequestException({
        message: 'Invalid task hierarchy configuration',
        errors: business.errors,
      });
    }

    const existing = await this.findBySpace(organizationId, spaceId);
    if (!options.allowTestTypeChanges) {
      await this.assertTestTypesKept(
        organizationId,
        spaceId,
        parsed.data,
        existing,
      );
    }
    if (existing) {
      const existingTypeIds = existing.config.levels.map((level) => level.id);
      const newTypeIds = parsed.data.levels.map((level) => level.id);
      const removedTypeIds = existingTypeIds.filter(
        (id) => !newTypeIds.includes(id),
      );

      if (removedTypeIds.length > 0) {
        const { data: tasksUsingRemovedTypes, error } = await this.client
          .from(TaskHierarchyConfigService.TASKS_TABLE)
          .select('id, task_type_id')
          .eq('organization_id', organizationId)
          .eq('space_id', spaceId)
          .in('task_type_id', removedTypeIds);

        if (error) throw new BadRequestException(error.message);
        if ((tasksUsingRemovedTypes ?? []).length > 0) {
          throw new BadRequestException(
            `Cannot remove task types that are in use. The following types have existing tasks: ${removedTypeIds.join(', ')}`,
          );
        }
      }
    }

    if (existing) {
      const r = await this.client
        .from(TaskHierarchyConfigService.TABLE)
        .update({
          config: parsed.data,
          version: parsed.data.version || '1.0',
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq('organization_id', organizationId)
        .eq('space_id', spaceId)
        .select()
        .single();
      if (r.error) throw new BadRequestException(r.error.message);
      const record = r.data as ITaskHierarchyConfigRecord;
      void this.logAudit(organizationId, userId, record.id, 'update', {
        operation: auditOperation,
        space_id: spaceId,
        version: parsed.data.version || '1.0',
        level_count: parsed.data.levels.length,
      });
      return record;
    }

    const r = await this.client
      .from(TaskHierarchyConfigService.TABLE)
      .insert({
        organization_id: organizationId,
        space_id: spaceId,
        config: parsed.data,
        version: parsed.data.version || '1.0',
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const record = r.data as ITaskHierarchyConfigRecord;
    void this.logAudit(organizationId, userId, record.id, 'create', {
      operation: auditOperation,
      space_id: spaceId,
      version: parsed.data.version || '1.0',
      level_count: parsed.data.levels.length,
    });
    return record;
  }

  /** While Test Management is on its task types stay active, top-level and childless; while off they stay inactive. */
  private async assertTestTypesKept(
    organizationId: string,
    spaceId: string,
    next: ITaskHierarchyConfig,
    existing: ITaskHierarchyConfigRecord | null,
  ): Promise<void> {
    const { types, error } = await readTestTaskTypes(
      this.client,
      organizationId,
      spaceId,
    );
    if (error) throw databaseBadRequest(error);
    if (types.size === 0) return;

    const moduleOn =
      (await this.orgModules?.isSpaceModuleEnabled(
        organizationId,
        spaceId,
        'test_management',
      )) ?? false;
    const byId = new Map(next.levels.map((l) => [l.id, l]));
    const wasActive = new Set(
      (existing?.config.levels ?? [])
        .filter((l) => l.is_active)
        .map((l) => l.id),
    );
    const broken = [...types.keys()].filter((id) => {
      const level = byId.get(id);
      if (!moduleOn) return Boolean(level?.is_active) && !wasActive.has(id);
      return (
        !level ||
        !level.is_active ||
        level.parent_level_id !== null ||
        level.allowed_parent_types.length > 0 ||
        level.allowed_child_types.length > 0
      );
    });
    const referencing = moduleOn
      ? next.levels
          .filter(
            (l) =>
              !types.has(l.id) &&
              (types.has(l.parent_level_id ?? '') ||
                l.allowed_parent_types.some((id) => types.has(id)) ||
                l.allowed_child_types.some((id) => types.has(id))),
          )
          .map((l) => l.id)
      : [];

    if (broken.length > 0 || referencing.length > 0) {
      throw new BadRequestException({
        code: 'TEST_TYPE_MANAGED',
        message:
          'Test Management task types are managed by the module: they stay active and have no parent or child types',
        data: { task_type_ids: [...broken, ...referencing] },
      });
    }
  }

  // ------------------------------------------------------------------
  // Reset — blocked when the space has existing tasks
  // ------------------------------------------------------------------

  private async countTasksInSpace(
    organizationId: string,
    spaceId: string,
  ): Promise<number> {
    const r = await this.client
      .from(TaskHierarchyConfigService.TASKS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId);
    if (r.error) throw new BadRequestException(r.error.message);
    return r.count ?? 0;
  }

  private async countTasksOfType(
    organizationId: string,
    spaceId: string,
    taskTypeId: string,
  ): Promise<number> {
    const r = await this.client
      .from(TaskHierarchyConfigService.TASKS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('task_type_id', taskTypeId);
    if (r.error) throw new BadRequestException(r.error.message);
    return r.count ?? 0;
  }

  async resetToDefault(
    organizationId: string,
    spaceId: string,
    userId: string | null,
  ): Promise<ITaskHierarchyConfigRecord> {
    const count = await this.countTasksInSpace(organizationId, spaceId);
    if (count > 0) {
      throw new BadRequestException(
        'Cannot reset configuration while tasks exist in this space. Delete all tasks first or update the configuration instead.',
      );
    }

    return this.saveConfig(
      organizationId,
      spaceId,
      DEFAULT_TASK_HIERARCHY_CONFIG,
      userId,
      'reset',
    );
  }

  // ------------------------------------------------------------------
  // Sub-action: addTaskType
  // ------------------------------------------------------------------

  async addTaskType(
    organizationId: string,
    spaceId: string,
    taskType: ITaskTypeLevel,
    userId: string | null,
  ): Promise<ITaskHierarchyConfigRecord> {
    const parsed = taskTypeLevelSchema.safeParse(taskType);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid task type',
        errors: parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const { config } = await this.getConfig(organizationId, spaceId);
    if (config.levels.some((l) => l.id === parsed.data.id)) {
      throw new ConflictException(
        `Task type "${parsed.data.id}" already exists`,
      );
    }
    assertNoReservedTypeName([parsed.data], config.levels);
    const next: ITaskHierarchyConfig = {
      ...config,
      levels: [...config.levels, parsed.data],
    };
    return this.saveConfig(
      organizationId,
      spaceId,
      next,
      userId,
      'add_task_type',
    );
  }

  /**
   * Adds the given task types to the space when missing and switches them on or off.
   * A type without a mapping reuses the level that has its default id instead of adding a copy.
   * @returns The task type id used for each key.
   */
  async ensureTaskTypes(
    organizationId: string,
    spaceId: string,
    types: IEnsureTaskTypeInput[],
    active: boolean,
    userId: string | null,
  ): Promise<Record<string, string>> {
    assertUuid(organizationId, 'organizationId');
    assertUuid(spaceId, 'spaceId');
    const record = await this.findBySpace(organizationId, spaceId);
    const config = record?.config ?? (await this.orgSeedConfig(organizationId));
    const levels = [...config.levels];
    const ids: Record<string, string> = {};
    let changed = false;

    for (const type of types) {
      let index = type.currentId
        ? levels.findIndex((l) => l.id === type.currentId)
        : -1;
      // A lost mapping finds its own type again by the default id instead of adding a copy.
      if (index === -1 && active) {
        index = levels.findIndex((l) => l.id === type.level.id);
      }
      if (index !== -1) {
        ids[type.key] = levels[index].id;
        if (type.renameFrom?.includes(levels[index].name)) {
          levels[index] = {
            ...levels[index],
            name: type.level.name,
            name_i18n: type.level.name_i18n ?? levels[index].name_i18n,
          };
          changed = true;
        }
        if (levels[index].is_active !== active) {
          levels[index] = { ...levels[index], is_active: active };
          changed = true;
        }
        continue;
      }
      if (!active) continue;

      const parsed = taskTypeLevelSchema.safeParse({
        ...type.level,
        id: freeTypeId(levels, type.level.id),
        parent_level_id: null,
        is_active: true,
      });
      if (!parsed.success) {
        throw new BadRequestException({
          message: 'Invalid task type',
          errors: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        });
      }
      levels.push(parsed.data);
      ids[type.key] = parsed.data.id;
      changed = true;
    }

    if (changed) {
      await this.saveConfig(
        organizationId,
        spaceId,
        { ...config, levels },
        userId,
        'ensure_task_types',
        { allowTestTypeChanges: true },
      );
    }
    return ids;
  }

  /** Same start point readers use for a space without its own row: the org row, plus missing built-in types. */
  private async orgSeedConfig(
    organizationId: string,
  ): Promise<ITaskHierarchyConfig> {
    const r = await this.client
      .from(TaskHierarchyConfigService.TABLE)
      .select('config')
      .eq('organization_id', organizationId)
      .is('space_id', null)
      .limit(1)
      .maybeSingle();
    if (r.error) throw databaseBadRequest(r.error, r.status);
    const parsed = taskHierarchyConfigSchema.safeParse(r.data?.config);
    if (!parsed.success) return DEFAULT_TASK_HIERARCHY_CONFIG;
    const missing = DEFAULT_TASK_HIERARCHY_CONFIG.levels.filter(
      (level) => !parsed.data.levels.some((own) => own.id === level.id),
    );
    return { ...parsed.data, levels: [...parsed.data.levels, ...missing] };
  }

  // ------------------------------------------------------------------
  // Sub-action: updateTaskType
  // ------------------------------------------------------------------

  async updateTaskType(
    organizationId: string,
    spaceId: string,
    taskTypeId: string,
    updates: Partial<ITaskTypeLevel>,
    userId: string | null,
  ): Promise<ITaskHierarchyConfigRecord> {
    if (updates.id !== undefined && updates.id !== taskTypeId) {
      throw new BadRequestException('Cannot change task type id');
    }
    const { config } = await this.getConfig(organizationId, spaceId);
    const idx = config.levels.findIndex((l) => l.id === taskTypeId);
    if (idx === -1) {
      throw new NotFoundException(`Task type "${taskTypeId}" not found`);
    }
    const merged: ITaskTypeLevel = { ...config.levels[idx], ...updates };
    const parsed = taskTypeLevelSchema.safeParse(merged);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid task type update',
        errors: parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    assertNoReservedTypeName([parsed.data], config.levels);
    const next: ITaskHierarchyConfig = {
      ...config,
      levels: config.levels.map((l, i) => (i === idx ? parsed.data : l)),
    };
    return this.saveConfig(
      organizationId,
      spaceId,
      next,
      userId,
      'update_task_type',
    );
  }

  /** Refuses a full config save that adds a type named "Test" or renames one to it. */
  async assertNoReservedTypeNames(
    organizationId: string,
    spaceId: string,
    next: ITaskHierarchyConfig,
  ): Promise<void> {
    const { config } = await this.getConfig(organizationId, spaceId);
    assertNoReservedTypeName(next.levels, config.levels);
  }

  // ------------------------------------------------------------------
  // Sub-action: removeTaskType
  // ------------------------------------------------------------------

  async removeTaskType(
    organizationId: string,
    spaceId: string,
    taskTypeId: string,
    userId: string | null,
  ): Promise<ITaskHierarchyConfigRecord> {
    const { config } = await this.getConfig(organizationId, spaceId);
    if (!config.levels.some((l) => l.id === taskTypeId)) {
      throw new NotFoundException(`Task type "${taskTypeId}" not found`);
    }

    const inUse = await this.countTasksOfType(
      organizationId,
      spaceId,
      taskTypeId,
    );
    if (inUse > 0) {
      throw new ConflictException(
        `Cannot remove: ${inUse} task(s) use type "${taskTypeId}"`,
      );
    }

    // Drop the type AND scrub references in other types' parent/child
    // allowlists and `parent_level_id` fields.
    const next: ITaskHierarchyConfig = {
      ...config,
      levels: config.levels
        .filter((l) => l.id !== taskTypeId)
        .map((l) => ({
          ...l,
          parent_level_id:
            l.parent_level_id === taskTypeId ? null : l.parent_level_id,
          allowed_parent_types: l.allowed_parent_types.filter(
            (p) => p !== taskTypeId,
          ),
          allowed_child_types: l.allowed_child_types.filter(
            (c) => c !== taskTypeId,
          ),
        })),
    };

    if (next.levels.length === 0) {
      throw new ConflictException('Cannot remove the last task type');
    }

    return this.saveConfig(
      organizationId,
      spaceId,
      next,
      userId,
      'remove_task_type',
    );
  }

  // ------------------------------------------------------------------
  // Sub-action: reorder
  // ------------------------------------------------------------------

  async reorder(
    organizationId: string,
    spaceId: string,
    orderedIds: string[],
    userId: string | null,
  ): Promise<ITaskHierarchyConfigRecord> {
    const { config } = await this.getConfig(organizationId, spaceId);
    const knownIds = new Set(config.levels.map((l) => l.id));
    const orderedSet = new Set(orderedIds);
    if (
      orderedIds.length !== knownIds.size ||
      [...knownIds].some((id) => !orderedSet.has(id))
    ) {
      throw new BadRequestException(
        'orderedIds must contain exactly the known task type IDs',
      );
    }
    const position = new Map(orderedIds.map((id, i) => [id, i]));
    const next: ITaskHierarchyConfig = {
      ...config,
      levels: [...config.levels]
        .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0))
        .map((l, i) => ({ ...l, sort_order: i })),
    };
    return this.saveConfig(organizationId, spaceId, next, userId, 'reorder');
  }

  // ------------------------------------------------------------------
  // Query helpers used by the GET endpoint variants
  // ------------------------------------------------------------------

  async getActiveTypes(
    organizationId: string,
    spaceId: string,
  ): Promise<ITaskTypeLevel[]> {
    const { config } = await this.getConfig(organizationId, spaceId);
    return getActiveTaskTypes(config);
  }

  async getRootTypes(
    organizationId: string,
    spaceId: string,
  ): Promise<ITaskTypeLevel[]> {
    const { config } = await this.getConfig(organizationId, spaceId);
    return getRootTaskTypes(config);
  }

  async getTypeById(
    organizationId: string,
    spaceId: string,
    taskTypeId: string,
  ): Promise<ITaskTypeLevel | null> {
    const { config } = await this.getConfig(organizationId, spaceId);
    return getTaskTypeById(config, taskTypeId) ?? null;
  }

  async getValidParentTypesFor(
    organizationId: string,
    spaceId: string,
    taskTypeId: string,
  ): Promise<ITaskTypeLevel[]> {
    const { config } = await this.getConfig(organizationId, spaceId);
    return getValidParentTypes(config, taskTypeId);
  }

  async getValidChildTypesFor(
    organizationId: string,
    spaceId: string,
    taskTypeId: string,
  ): Promise<ITaskTypeLevel[]> {
    const { config } = await this.getConfig(organizationId, spaceId);
    return getValidChildTypes(config, taskTypeId);
  }

  private async logAudit(
    organizationId: string,
    userId: string | null,
    entityId: string,
    action: 'create' | 'update',
    changes: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.client.from('audit_logs').insert({
        organization_id: organizationId,
        user_id: userId,
        entity_type: 'task_hierarchy_config',
        entity_id: entityId,
        action,
        changes,
      });
    } catch {
      // Audit is best-effort and must not break the primary mutation.
    }
  }
}

/** "Test" belongs to Test Management's case type; users may not add or rename a type to it. */
function assertNoReservedTypeName(
  next: ITaskTypeLevel[],
  previous: ITaskTypeLevel[],
): void {
  const before = new Map(
    previous.map((l) => [l.id, l.name.trim().toLowerCase()]),
  );
  const taken = next.filter((l) => {
    const reserved = l.name.trim().toLowerCase() === 'test' || l.id === 'test';
    return reserved && (!before.has(l.id) || before.get(l.id) !== 'test');
  });
  if (taken.length > 0) {
    throw new BadRequestException({
      code: 'TASK_TYPE_NAME_RESERVED',
      message: 'The name "Test" is reserved for the Test Management task type',
      data: { task_type_ids: taken.map((l) => l.id) },
    });
  }
}

function freeTypeId(levels: ITaskTypeLevel[], base: string): string {
  let id = base;
  for (let n = 2; levels.some((l) => l.id === id); n++) id = `${base}_${n}`;
  return id;
}
