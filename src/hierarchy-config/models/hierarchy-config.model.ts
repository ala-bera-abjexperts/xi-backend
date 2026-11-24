/**
 * @fileoverview Zod schemas, TypeScript types, and pure validation helpers
 * for the process/risk hierarchy configuration (ISMS hierarchy).
 *
 * Mirrors the old `risk-management-app/src/models/hierarchy-config.model.ts`
 * so existing frontend consumers see no shape changes.
 * @module src/hierarchy-config/models/hierarchy-config.model
 * @author Prince Jadiya
 */

import { z } from 'zod';

// ============================================
// Enums
// ============================================

export const FormulaTypeEnum = z.enum([
  'sum',
  'subtract',
  'average',
  'maximum',
  'mitigation',
  'none',
]);
export type FormulaType = z.infer<typeof FormulaTypeEnum>;

export const ColumnDataTypeEnum = z.enum(['number', 'financial', 'text']);
export type ColumnDataType = z.infer<typeof ColumnDataTypeEnum>;

// ============================================
// Sub-schemas
// ============================================

export const validationRulesSchema = z.object({
  min: z.number().optional().default(0),
  max: z.number().optional().default(4),
  required: z.boolean().optional().default(false),
});
export type IValidationRules = z.infer<typeof validationRulesSchema>;

export const columnConfigSchema = z.object({
  id: z.string().min(1, 'Column ID is required'),
  label: z.string().min(1, 'Column label is required'),
  fieldKey: z.string().min(1, 'Field key is required'),
  dataType: ColumnDataTypeEnum.default('number'),
  formulaTemplate: FormulaTypeEnum.default('sum'),
  isEditable: z.boolean().default(false),
  validationRules: validationRulesSchema.default({
    min: 0,
    max: 4,
    required: false,
  }),
});
export type IColumnConfig = z.infer<typeof columnConfigSchema>;

export const columnGroupConfigSchema = z.object({
  id: z.string().min(1, 'Column group ID is required'),
  fieldGroupId: z.string().optional().default(''),
  label: z.string().min(1, 'Column group label is required'),
  columns: z.array(columnConfigSchema).default([]),
});
export type IColumnGroupConfig = z.infer<typeof columnGroupConfigSchema>;

export const formulaConfigSchema = z.object({
  type: FormulaTypeEnum,
  params: z.record(z.string(), z.number()).default({}),
});
export type IFormulaConfig = z.infer<typeof formulaConfigSchema>;

export const hierarchyLevelSchema = z.object({
  id: z.string().min(1, 'Level ID is required'),
  name: z.string().min(1, 'Level name is required'),
  requestType: z.string().min(1, 'Request type is required'),
  parentLevelId: z.string().nullable(),
  allowedChildren: z.array(z.string()).default([]),
  columns: z.array(columnConfigSchema).default([]),
  calculationFormula: formulaConfigSchema.default({ type: 'sum', params: {} }),
  chipColor: z.string().optional(),
  cellBackgroundColor: z.string().optional(),
  cellTextColor: z.string().optional(),
});
export type IHierarchyLevel = z.infer<typeof hierarchyLevelSchema>;

export const hierarchyConfigSchema = z.object({
  version: z.string().default('1.0'),
  levels: z
    .array(hierarchyLevelSchema)
    .min(1, 'At least one level is required'),
  columnGroups: z.array(columnGroupConfigSchema).default([]),
});
export type IHierarchyConfigInput = z.input<typeof hierarchyConfigSchema>;
export type IHierarchyConfig = z.output<typeof hierarchyConfigSchema>;

// ============================================
// Record & I/O schemas
// ============================================

export const hierarchyConfigRecordSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  space_id: z.string().uuid().nullable().optional(),
  config: hierarchyConfigSchema,
  version: z.string().default('1.0'),
  created_by: z.string().uuid().nullable().optional(),
  updated_by: z.string().uuid().nullable().optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});
export type IHierarchyConfigRecord = z.infer<
  typeof hierarchyConfigRecordSchema
>;

export const updateHierarchyConfigSchema = z.object({
  spaceId: z.string().uuid(),
  config: hierarchyConfigSchema,
});
export type UpdateHierarchyConfigInput = z.infer<
  typeof updateHierarchyConfigSchema
>;

export const importHierarchyConfigSchema = z.object({
  spaceId: z.string().uuid(),
  config: hierarchyConfigSchema,
});
export type ImportHierarchyConfigInput = z.infer<
  typeof importHierarchyConfigSchema
>;

export const validateHierarchyConfigInputSchema = z.object({
  config: hierarchyConfigSchema,
});
export type ValidateHierarchyConfigInput = z.infer<
  typeof validateHierarchyConfigInputSchema
>;

// ============================================
// Validation result types
// ============================================

export interface HierarchyValidationError {
  field: string;
  message: string;
}

export interface HierarchyValidationResult {
  isValid: boolean;
  errors: HierarchyValidationError[];
}

// ============================================
// Pure validation helpers
// ============================================

/**
 * Comprehensive structural validation beyond Zod schema-level checks:
 * duplicate IDs, duplicate (requestType, parent) combos, orphaned
 * parent references, circular dependencies, allowed-children integrity,
 * column validation, formula-type validation, root-level presence.
 */
export function validateHierarchyConfig(
  config: IHierarchyConfig | IHierarchyConfigInput,
): HierarchyValidationResult {
  const errors: HierarchyValidationError[] = [];

  if (!config || !config.levels) {
    errors.push({
      field: 'config',
      message: 'Configuration is missing levels array',
    });
    return { isValid: false, errors };
  }

  // Normalize to the output type (defaults applied) for typed access.
  const typedLevels = config.levels as IHierarchyLevel[];

  // Duplicate level IDs.
  const levelIds = typedLevels.map((l) => l.id);
  const duplicateIds = levelIds.filter(
    (id, idx) => levelIds.indexOf(id) !== idx,
  );
  if (duplicateIds.length > 0) {
    errors.push({
      field: 'levels',
      message: `Duplicate level IDs found: ${duplicateIds.join(', ')}`,
    });
  }

  // Duplicate (requestType, parent) combos.
  const combos = typedLevels.map(
    (l) => `${l.requestType}|${l.parentLevelId ?? 'root'}`,
  );
  const duplicateCombos = combos.filter((c, idx) => combos.indexOf(c) !== idx);
  if (duplicateCombos.length > 0) {
    const dupTypes = duplicateCombos.map((c) => c.split('|')[0]);
    errors.push({
      field: 'levels',
      message: `Duplicate request type + parent level combinations found: ${dupTypes.join(', ')}`,
    });
  }

  // Per-level checks.
  typedLevels.forEach((level, index) => {
    if (!level.id) {
      errors.push({
        field: `levels[${index}].id`,
        message: 'Level ID is required',
      });
    }
    if (!level.name) {
      errors.push({
        field: `levels[${index}].name`,
        message: 'Level name is required',
      });
    }
    if (!level.requestType) {
      errors.push({
        field: `levels[${index}].requestType`,
        message: 'Request type is required',
      });
    }

    if (level.parentLevelId) {
      const parentExists = typedLevels.some(
        (l) => l.id === level.parentLevelId,
      );
      if (!parentExists) {
        errors.push({
          field: `levels[${index}].parentLevelId`,
          message: `Invalid parent ID: ${level.parentLevelId}`,
        });
      }
    }

    // Circular dependency detection via parent walk.
    const visited = new Set<string>();
    let currentId: string | null = level.id;
    while (currentId) {
      if (visited.has(currentId)) {
        errors.push({
          field: `levels[${index}]`,
          message: `Circular dependency detected involving level "${level.name}"`,
        });
        break;
      }
      visited.add(currentId);
      const currentLevel = typedLevels.find((l) => l.id === currentId);
      currentId = currentLevel?.parentLevelId ?? null;
    }

    // allowedChildren integrity.
    if (level.allowedChildren && level.allowedChildren.length > 0) {
      level.allowedChildren.forEach((childId) => {
        const exists = typedLevels.some((l) => l.id === childId);
        if (!exists) {
          errors.push({
            field: `levels[${index}].allowedChildren`,
            message: `Invalid child reference: ${childId}`,
          });
        }
      });
    }

    // Columns.
    if (level.columns && level.columns.length > 0) {
      const colIds = level.columns.map((c) => c.id);
      const dupColIds = colIds.filter((id, i) => colIds.indexOf(id) !== i);
      if (dupColIds.length > 0) {
        errors.push({
          field: `levels[${index}].columns`,
          message: `Duplicate column IDs: ${dupColIds.join(', ')}`,
        });
      }
      level.columns.forEach((col, colIdx) => {
        if (!col.id) {
          errors.push({
            field: `levels[${index}].columns[${colIdx}].id`,
            message: 'Column ID is required',
          });
        }
        if (!col.label) {
          errors.push({
            field: `levels[${index}].columns[${colIdx}].label`,
            message: 'Column label is required',
          });
        }
        if (!col.fieldKey) {
          errors.push({
            field: `levels[${index}].columns[${colIdx}].fieldKey`,
            message: 'Column field key is required',
          });
        }
      });
    }

    // Formula.
    if (level.calculationFormula) {
      const validTypes: FormulaType[] = [
        'sum',
        'subtract',
        'average',
        'maximum',
        'mitigation',
        'none',
      ];
      if (!validTypes.includes(level.calculationFormula.type)) {
        errors.push({
          field: `levels[${index}].calculationFormula.type`,
          message: `Invalid formula type: ${level.calculationFormula.type}`,
        });
      }
      if (level.calculationFormula.type === 'mitigation') {
        const m = level.calculationFormula.params?.multiplier;
        if (m !== undefined && (m < 0 || m > 1)) {
          errors.push({
            field: `levels[${index}].calculationFormula.params.multiplier`,
            message: 'Mitigation multiplier must be between 0 and 1',
          });
        }
      }
    }
  });

  // Must have at least one root level.
  const roots = typedLevels.filter((l) => !l.parentLevelId);
  if (roots.length === 0) {
    errors.push({
      field: 'levels',
      message: 'At least one root level (with no parent) is required',
    });
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Resolve the `requestType` of the valid children for a given parent
 * request type, from a config object.
 */
export function getValidChildTypesFromConfig(
  config: IHierarchyConfig,
  requestType: string,
): string[] {
  const level = config.levels.find((l) => l.requestType === requestType);
  if (!level) return [];
  return level.allowedChildren
    .map((childId) => config.levels.find((l) => l.id === childId)?.requestType)
    .filter((t): t is string => typeof t === 'string');
}

/**
 * XSS sanitization for imported config (strip script tags, javascript:
 * URLs, and event handlers). Applied recursively to all string values.
 */
export function sanitizeHierarchyConfig(
  config: IHierarchyConfig,
): IHierarchyConfig {
  const sanitizeString = (s: string): string =>
    s
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+=/gi, '')
      .trim();

  const scrubColumn = (c: IColumnConfig): IColumnConfig => ({
    ...c,
    id: sanitizeString(c.id),
    label: sanitizeString(c.label),
    fieldKey: sanitizeString(c.fieldKey),
  });

  const clone = JSON.parse(JSON.stringify(config)) as IHierarchyConfig;
  clone.levels = clone.levels.map((lvl) => ({
    ...lvl,
    id: sanitizeString(lvl.id),
    name: sanitizeString(lvl.name),
    requestType: sanitizeString(lvl.requestType),
    allowedChildren: (lvl.allowedChildren ?? []).map(sanitizeString),
    columns: (lvl.columns ?? []).map(scrubColumn),
  }));
  clone.columnGroups = (clone.columnGroups ?? []).map((cg) => ({
    ...cg,
    id: sanitizeString(cg.id),
    fieldGroupId: sanitizeString(cg.fieldGroupId),
    label: sanitizeString(cg.label),
    columns: (cg.columns ?? []).map(scrubColumn),
  }));
  return clone;
}

/**
 * Hard-coded fallback default config (3 root-less levels with the most
 * common ISMS request types). Used only when the Supabase RPC
 * `get_default_hierarchy_config_json` is not reachable; normally we
 * fetch the authoritative one from the database.
 */
export const FALLBACK_DEFAULT_HIERARCHY_CONFIG: IHierarchyConfig = {
  version: '1.0',
  levels: [
    {
      id: 'level_geschaeftsprozess',
      name: 'Geschäftsprozess',
      requestType: 'Geschäftsprozessbewertung',
      parentLevelId: null,
      allowedChildren: ['level_prozess'],
      columns: [],
      calculationFormula: { type: 'sum', params: {} },
    },
    {
      id: 'level_prozess',
      name: 'Prozess',
      requestType: 'Prozessbewertung',
      parentLevelId: 'level_geschaeftsprozess',
      allowedChildren: [],
      columns: [],
      calculationFormula: { type: 'sum', params: {} },
    },
  ],
  columnGroups: [],
};
