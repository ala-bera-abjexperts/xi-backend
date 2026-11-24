/**
 * @fileoverview Zod schemas, TypeScript types, pure validation helpers,
 * and the default config for the task hierarchy (Epic/Story/Task/Subtask/Bug).
 * Mirrors the old `risk-management-app/src/models/task-hierarchy-config.model.ts`.
 * @module src/task-hierarchy-config/models/task-hierarchy-config.model
 * @author Prince Jadiya
 */

import { z } from 'zod';

// ============================================================================
// Status / priority enums (copied from the old `task.model.ts` so this
// module doesn't need to depend on a yet-to-be-migrated tasks module).
// ============================================================================

export const TaskStatusEnum = z.enum([
  'open',
  'in_progress',
  'review',
  'done',
  'closed',
  'blocked',
]);
export type TaskStatus = z.infer<typeof TaskStatusEnum>;

export const TaskPriorityEnum = z.enum([
  'lowest',
  'low',
  'medium',
  'high',
  'highest',
  'critical',
]);
export type TaskPriority = z.infer<typeof TaskPriorityEnum>;

// ============================================================================
// Sub-schemas
// ============================================================================

export const i18nStringSchema = z.record(z.string(), z.string()).default({});

export const taskTypeLevelSchema = z.object({
  id: z.string().min(1, 'Task type ID is required'),
  name: z.string().min(1, 'Task type name is required').max(100),
  name_i18n: i18nStringSchema,
  description: z.string().max(500).optional().nullable(),
  description_i18n: i18nStringSchema,
  icon: z.string().max(50).optional().nullable(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid color format')
    .default('#6B7280'),
  text_color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid text color format')
    .default('#FFFFFF'),

  parent_level_id: z.string().nullable(),
  allowed_parent_types: z.array(z.string()).default([]),
  allowed_child_types: z.array(z.string()).default([]),
  max_depth: z.number().int().min(1).max(10).default(10),

  // Stored as keys. Admins can create custom statuses/priorities per space,
  // so the backend must accept the same dynamic values as the frontend.
  default_status: z.string().min(1).default('open'),
  default_priority: z.string().min(1).default('medium'),

  field_group_ids: z.array(z.string().uuid()).default([]),

  allowed_statuses: z
    .array(z.string().min(1))
    .default(['open', 'in_progress', 'review', 'done', 'closed', 'blocked']),

  sort_order: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
});
export type ITaskTypeLevel = z.infer<typeof taskTypeLevelSchema>;

export const taskHierarchyConfigSchema = z.object({
  version: z.string().default('1.0'),
  levels: z
    .array(taskTypeLevelSchema)
    .min(1, 'At least one task type is required'),
});
export type ITaskHierarchyConfigInput = z.input<
  typeof taskHierarchyConfigSchema
>;
export type ITaskHierarchyConfig = z.output<typeof taskHierarchyConfigSchema>;

export const taskHierarchyConfigRecordSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  space_id: z.string().uuid().nullable().optional(),
  config: taskHierarchyConfigSchema,
  version: z.string().default('1.0'),
  created_by: z.string().uuid().nullable().optional(),
  updated_by: z.string().uuid().nullable().optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});
export type ITaskHierarchyConfigRecord = z.infer<
  typeof taskHierarchyConfigRecordSchema
>;

// ============================================================================
// I/O schemas
// ============================================================================

export const saveTaskHierarchyConfigSchema = z.object({
  spaceId: z.string().uuid(),
  config: taskHierarchyConfigSchema,
});
export type SaveTaskHierarchyConfigInput = z.infer<
  typeof saveTaskHierarchyConfigSchema
>;

export const validateTaskHierarchyConfigInputSchema = z.object({
  config: taskHierarchyConfigSchema,
});
export type ValidateTaskHierarchyConfigInput = z.infer<
  typeof validateTaskHierarchyConfigInputSchema
>;

export const resetTaskHierarchyConfigSchema = z.object({
  spaceId: z.string().uuid(),
});
export type ResetTaskHierarchyConfigInput = z.infer<
  typeof resetTaskHierarchyConfigSchema
>;

export const addTaskTypeSchema = z.object({
  spaceId: z.string().uuid(),
  taskType: taskTypeLevelSchema,
});
export type AddTaskTypeInput = z.infer<typeof addTaskTypeSchema>;

export const updateTaskTypeSchema = z.object({
  spaceId: z.string().uuid(),
  taskTypeId: z.string().min(1),
  // Caller may change any field EXCEPT `id` — the id of a task type is
  // its stable identity and changing it would orphan all referencing
  // parent_level_id / allowed_*_types entries across the config.
  updates: taskTypeLevelSchema.omit({ id: true }).partial(),
});
export type UpdateTaskTypeInput = z.infer<typeof updateTaskTypeSchema>;

export const removeTaskTypeSchema = z.object({
  spaceId: z.string().uuid(),
  taskTypeId: z.string().min(1),
});
export type RemoveTaskTypeInput = z.infer<typeof removeTaskTypeSchema>;

export const reorderTaskTypesSchema = z.object({
  spaceId: z.string().uuid(),
  orderedIds: z.array(z.string().min(1)).min(1),
});
export type ReorderTaskTypesInput = z.infer<typeof reorderTaskTypesSchema>;

// ============================================================================
// Validation result types
// ============================================================================

export interface ITaskHierarchyValidationError {
  field: string;
  message: string;
}
export interface ITaskHierarchyValidationResult {
  isValid: boolean;
  errors: ITaskHierarchyValidationError[];
}

// ============================================================================
// Pure validation
// ============================================================================

export function validateTaskHierarchyConfig(
  config: ITaskHierarchyConfig | ITaskHierarchyConfigInput,
): ITaskHierarchyValidationResult {
  const errors: ITaskHierarchyValidationError[] = [];

  if (!config || !config.levels) {
    errors.push({
      field: 'config',
      message: 'Configuration is missing levels array',
    });
    return { isValid: false, errors };
  }

  // Normalize to output type for typed access.
  const typedLevels = config.levels as ITaskTypeLevel[];

  // Duplicate IDs.
  const ids = typedLevels.map((l) => l.id);
  const dups = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dups.length > 0) {
    errors.push({
      field: 'levels',
      message: `Duplicate task type IDs found: ${dups.join(', ')}`,
    });
  }

  typedLevels.forEach((level, index) => {
    if (!level.id) {
      errors.push({
        field: `levels[${index}].id`,
        message: 'Task type ID is required',
      });
    }
    if (!level.name) {
      errors.push({
        field: `levels[${index}].name`,
        message: 'Task type name is required',
      });
    }

    if (level.parent_level_id) {
      const exists = typedLevels.some((l) => l.id === level.parent_level_id);
      if (!exists) {
        errors.push({
          field: `levels[${index}].parent_level_id`,
          message: `Invalid parent ID: ${level.parent_level_id}`,
        });
      }
    }

    // Circular detection.
    const visited = new Set<string>();
    let currentId: string | null = level.id;
    while (currentId) {
      if (visited.has(currentId)) {
        errors.push({
          field: `levels[${index}]`,
          message: `Circular dependency detected involving task type "${level.name}"`,
        });
        break;
      }
      visited.add(currentId);
      const cur = typedLevels.find((l) => l.id === currentId);
      currentId = cur?.parent_level_id ?? null;
    }

    (level.allowed_parent_types ?? []).forEach((pid) => {
      if (!typedLevels.some((l) => l.id === pid)) {
        errors.push({
          field: `levels[${index}].allowed_parent_types`,
          message: `Invalid parent type reference: ${pid}`,
        });
      }
    });
    (level.allowed_child_types ?? []).forEach((cid) => {
      if (!typedLevels.some((l) => l.id === cid)) {
        errors.push({
          field: `levels[${index}].allowed_child_types`,
          message: `Invalid child type reference: ${cid}`,
        });
      }
    });

    if (level.color && !/^#[0-9A-Fa-f]{6}$/.test(level.color)) {
      errors.push({
        field: `levels[${index}].color`,
        message: 'Color must be a valid hex color (e.g., #FF5722)',
      });
    }
    if (level.text_color && !/^#[0-9A-Fa-f]{6}$/.test(level.text_color)) {
      errors.push({
        field: `levels[${index}].text_color`,
        message: 'Text color must be a valid hex color (e.g., #FFFFFF)',
      });
    }
  });

  const roots = typedLevels.filter((l) => !l.parent_level_id);
  if (roots.length === 0) {
    errors.push({
      field: 'levels',
      message: 'At least one root task type (with no parent) is required',
    });
  }

  return { isValid: errors.length === 0, errors };
}

// ============================================================================
// Pure lookup helpers
// ============================================================================

export function getTaskTypeById(
  config: ITaskHierarchyConfig,
  typeId: string,
): ITaskTypeLevel | undefined {
  return config.levels.find((l) => l.id === typeId);
}

export function getActiveTaskTypes(
  config: ITaskHierarchyConfig,
): ITaskTypeLevel[] {
  return config.levels.filter((l) => l.is_active !== false);
}

export function getRootTaskTypes(
  config: ITaskHierarchyConfig,
): ITaskTypeLevel[] {
  return config.levels.filter((l) => !l.parent_level_id);
}

/**
 * Bidirectional check: a type P is a valid parent for a type C iff
 *   - C.allowed_parent_types is empty OR includes P.id
 *   - AND P.allowed_child_types is empty OR includes C.id
 *   - AND P is active
 */
export function getValidParentTypes(
  config: ITaskHierarchyConfig,
  typeId: string,
): ITaskTypeLevel[] {
  const child = config.levels.find((l) => l.id === typeId);
  if (!child) return [];
  return config.levels.filter((parent) => {
    if (parent.id === typeId) return false;
    if (parent.is_active === false) return false;
    const childAllowsParent =
      child.allowed_parent_types.length === 0 ||
      child.allowed_parent_types.includes(parent.id);
    const parentAllowsChild =
      parent.allowed_child_types.length === 0 ||
      parent.allowed_child_types.includes(typeId);
    return childAllowsParent && parentAllowsChild;
  });
}

export function getValidChildTypes(
  config: ITaskHierarchyConfig,
  typeId: string,
): ITaskTypeLevel[] {
  const parent = config.levels.find((l) => l.id === typeId);
  if (!parent) return [];
  return config.levels.filter((child) => {
    if (child.id === typeId) return false;
    if (child.is_active === false) return false;
    const parentAllowsChild =
      parent.allowed_child_types.length === 0 ||
      parent.allowed_child_types.includes(child.id);
    const childAllowsParent =
      child.allowed_parent_types.length === 0 ||
      child.allowed_parent_types.includes(typeId);
    return parentAllowsChild && childAllowsParent;
  });
}

// ============================================================================
// Default config (unchanged from the old app)
// ============================================================================

export const DEFAULT_TASK_HIERARCHY_CONFIG: ITaskHierarchyConfig = {
  version: '1.0',
  levels: [
    {
      id: 'epic',
      name: 'Epic',
      name_i18n: { de: 'Epic' },
      description:
        'Large body of work that can be broken down into smaller tasks',
      description_i18n: {
        de: 'Große Arbeitspakete, die in kleinere Aufgaben unterteilt werden können',
      },
      icon: 'lucide:flag',
      color: '#9333EA',
      text_color: '#FFFFFF',
      parent_level_id: null,
      allowed_parent_types: [],
      allowed_child_types: ['story', 'task'],
      max_depth: 10,
      default_status: 'open',
      default_priority: 'medium',
      field_group_ids: [],
      allowed_statuses: [
        'open',
        'in_progress',
        'review',
        'done',
        'closed',
        'blocked',
      ],
      sort_order: 0,
      is_active: true,
    },
    {
      id: 'story',
      name: 'Story',
      name_i18n: { de: 'Story' },
      description: 'User story or feature that delivers value',
      description_i18n: { de: 'User Story oder Feature, das Mehrwert liefert' },
      icon: 'lucide:bookmark',
      color: '#2563EB',
      text_color: '#FFFFFF',
      parent_level_id: 'epic',
      allowed_parent_types: ['epic'],
      allowed_child_types: ['task', 'subtask'],
      max_depth: 10,
      default_status: 'open',
      default_priority: 'medium',
      field_group_ids: [],
      allowed_statuses: [
        'open',
        'in_progress',
        'review',
        'done',
        'closed',
        'blocked',
      ],
      sort_order: 1,
      is_active: true,
    },
    {
      id: 'task',
      name: 'Task',
      name_i18n: { de: 'Aufgabe' },
      description: 'A single unit of work',
      description_i18n: { de: 'Eine einzelne Arbeitseinheit' },
      icon: 'lucide:check-square',
      color: '#16A34A',
      text_color: '#FFFFFF',
      parent_level_id: null,
      allowed_parent_types: ['epic', 'story'],
      allowed_child_types: ['subtask'],
      max_depth: 10,
      default_status: 'open',
      default_priority: 'medium',
      field_group_ids: [],
      allowed_statuses: [
        'open',
        'in_progress',
        'review',
        'done',
        'closed',
        'blocked',
      ],
      sort_order: 2,
      is_active: true,
    },
    {
      id: 'subtask',
      name: 'Subtask',
      name_i18n: { de: 'Unteraufgabe' },
      description: 'A smaller piece of work within a task',
      description_i18n: {
        de: 'Ein kleineres Arbeitselement innerhalb einer Aufgabe',
      },
      icon: 'lucide:list-checks',
      color: '#6B7280',
      text_color: '#FFFFFF',
      parent_level_id: 'task',
      allowed_parent_types: ['story', 'task'],
      allowed_child_types: [],
      max_depth: 10,
      default_status: 'open',
      default_priority: 'medium',
      field_group_ids: [],
      allowed_statuses: ['open', 'in_progress', 'done', 'blocked'],
      sort_order: 3,
      is_active: true,
    },
    {
      id: 'bug',
      name: 'Bug',
      name_i18n: { de: 'Fehler' },
      description: 'A defect or issue that needs to be fixed',
      description_i18n: {
        de: 'Ein Defekt oder Problem, das behoben werden muss',
      },
      icon: 'lucide:bug',
      color: '#DC2626',
      text_color: '#FFFFFF',
      parent_level_id: null,
      allowed_parent_types: ['epic', 'story'],
      allowed_child_types: ['subtask'],
      max_depth: 10,
      default_status: 'open',
      default_priority: 'high',
      field_group_ids: [],
      allowed_statuses: [
        'open',
        'in_progress',
        'review',
        'done',
        'closed',
        'blocked',
      ],
      sort_order: 4,
      is_active: true,
    },
  ],
};
