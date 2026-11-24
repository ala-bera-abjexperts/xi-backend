// =============================================================================
// DOCUMENT DESIGNER — TEMPLATE DEFINITION VALIDATION (zod)
//
// Enforced on every write (create/update) AND re-validated before rendering
// (preview/export), so definitions written before a schema change fail loudly
// with a clear message instead of rendering garbage.
//
// Caps: ≤500 elements, loop nesting ≤2 (items → subtasks/linked), ≤1 MiB
// serialized (mirrors the DB CHECK constraint), unknown keys stripped.
// =============================================================================

import { z } from 'zod';
import { SYSTEM_FIELDS_BY_ENTITY } from '../bindable-fields.service';
import {
  isTaskListSource,
  TASK_LIST_SOURCES,
} from '../rendering/task-list-sources';
import { DOCUMENT_SOURCE_ENTITIES } from '../source-entities';
import type {
  DocumentSourceEntity,
  IDocumentTemplateDefinition,
} from './template-definition.types';

export const DOCUMENT_DEFINITION_MAX_BYTES = 1048576; // 1 MiB — mirrors DB CHECK
export const DOCUMENT_DEFINITION_MAX_ELEMENTS = 500;
// Must stay well under DOCUMENT_DEFINITION_MAX_BYTES — this is one field inside that total, not
// a separate budget. 300 KB leaves room for several images plus the rest of the definition.
export const DOCUMENT_IMAGE_DATA_URI_MAX_BYTES = 300 * 1024;
// Generous-but-finite: no real document hierarchy needs this many levels, and it stays
// comfortably inside both the 500-element cap and Node's safe recursive-call stack depth for
// this renderer's per-frame weight. linked_tasks recursion additionally needs a visited-id
// guard at render time — this schema cap alone does not protect against graph cycles (only
// the DB-enforced parent_task_id/subtasks chain is guaranteed acyclic).
export const MAX_LOOP_REGION_DEPTH = 20;

// react-querybuilder rule-group shape (matches saved-filters/filter-query-engine).
const filterRuleSchema = z.object({
  field: z.string().min(1),
  operator: z.string().min(1),
  value: z.unknown().optional(),
  valueSource: z.string().optional(),
});

type FilterRuleGroupInput = {
  combinator: 'and' | 'or';
  rules: Array<z.infer<typeof filterRuleSchema> | FilterRuleGroupInput>;
  not?: boolean;
};

const filterRuleGroupSchema: z.ZodType<FilterRuleGroupInput> = z.lazy(() =>
  z.object({
    combinator: z.enum(['and', 'or']),
    rules: z.array(z.union([filterRuleSchema, filterRuleGroupSchema])),
    not: z.boolean().optional(),
  }),
) as z.ZodType<FilterRuleGroupInput>;

const styleSchema = z
  .object({
    fontFamily: z.string().max(80),
    fontSize: z.number().min(4).max(200),
    fontWeight: z.union([
      z.literal(400),
      z.literal(500),
      z.literal(600),
      z.literal(700),
    ]),
    lineHeight: z.number().min(0.5).max(5),
    textAlign: z.enum(['left', 'center', 'right', 'justify']),
    color: z.string().max(32),
    backgroundColor: z.string().max(32),
    borderColor: z.string().max(32),
    borderWidth: z.number().min(0).max(50),
    borderRadius: z.number().min(0).max(500),
    opacity: z.number().min(0).max(1),
    padding: z.number().min(0).max(200),
  })
  .partial();

const fieldFormatSchema = z
  .object({
    dateFormat: z.string().max(40),
    userDisplay: z.enum(['name', 'email']),
    renderHtml: z.boolean(),
    numberFormat: z.enum(['plain', 'percent', 'currency']),
    currency: z.string().max(8),
  })
  .partial();

const fieldBindingSchema = z.object({
  source: z.enum(['system', 'custom_field', 'meta']),
  fieldKey: z.string().min(1).max(120),
  label: z.string().max(200).optional(),
  format: fieldFormatSchema.optional(),
});

const imageSrcSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('storage'),
    bucket: z.string().min(1).max(100),
    path: z.string().min(1).max(1024),
  }),
  z.object({
    kind: z.literal('data'),
    dataUri: z
      .string()
      .max(DOCUMENT_IMAGE_DATA_URI_MAX_BYTES)
      .regex(
        /^data:image\/(png|jpeg|gif|webp|svg\+xml|bmp|avif);base64,/,
        'dataUri must be a base64 image data URI',
      ),
  }),
  z.object({
    kind: z.literal('url'),
    url: z.url({ protocol: /^https$/ }).max(2048),
  }),
]);

const elementBase = {
  id: z.string().min(1).max(64),
  x: z.number().min(-10000).max(10000),
  y: z.number().min(-10000).max(100000),
  width: z.number().min(0).max(10000),
  height: z.number().min(0).max(100000),
  rotation: z.number().min(-360).max(360),
  positionMode: z.enum(['absolute', 'relative', 'anchored']),
  zIndex: z.number().int().min(0).max(10000),
  parentId: z.string().max(64).nullable().optional(),
  condition: filterRuleGroupSchema.nullable().optional(),
  style: styleSchema,
};

const docElementSchema = z.discriminatedUnion('type', [
  z.object({ ...elementBase, type: z.literal('line') }),
  z.object({ ...elementBase, type: z.literal('rectangle') }),
  z.object({ ...elementBase, type: z.literal('ellipse') }),
  z.object({
    ...elementBase,
    type: z.literal('text'),
    html: z.string().max(100000),
  }),
  z.object({
    ...elementBase,
    type: z.literal('link'),
    text: z.string().max(2000),
    href: z.string().max(2048),
  }),
  z.object({
    ...elementBase,
    type: z.literal('image'),
    src: imageSrcSchema,
    objectFit: z.enum(['contain', 'cover', 'fill']),
  }),
  z.object({
    ...elementBase,
    type: z.literal('field'),
    binding: fieldBindingSchema,
  }),
  z.object({
    ...elementBase,
    type: z.literal('loop_region'),
    dataSource: z.enum([
      'items',
      'subtasks',
      'linked_tasks',
      'dynamic_query',
      ...TASK_LIST_SOURCES,
    ]),
    relationTypeId: z.uuid().nullable().optional(),
    filter: filterRuleGroupSchema.nullable().optional(),
    sortBy: z.string().max(120).optional(),
    passFailFieldKeys: z.array(z.string().max(120)).max(20).optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
    maxItems: z.number().int().min(1).max(500).nullable().optional(),
    itemSpacing: z.number().min(0).max(500),
    itemHeight: z.number().min(8).max(10000),
    // dataSource: 'dynamic_query' only — queries `targetEntity` where
    // `filterField` equals the enclosing parent row's `comparisonField` value
    // (e.g. targetEntity: 'tasks', filterField: 'parent_key', comparisonField:
    // 'key' → "tasks where parent_key = {{parent.key}}"). Both field names are
    // whitelist-checked against SYSTEM_FIELDS_BY_ENTITY in the superRefine
    // below (never a free-text column name) — shape/presence only here.
    targetEntity: z
      .enum(DOCUMENT_SOURCE_ENTITIES as [string, ...string[]])
      .optional(),
    filterField: z.string().min(1).max(120).optional(),
    comparisonField: z.string().min(1).max(120).optional(),
  }),
  z.object({
    ...elementBase,
    type: z.literal('variable_set'),
    // `condition` (inherited from elementBase) gates EXECUTION here instead
    // of visibility — reuses the exact same evaluator call site every other
    // element already uses, no new evaluator code. `value` is a plain string
    // resolved through the existing {{token}} interpolation pass (a literal
    // like "1", or a token like "{{issue.summary}}") — not a second
    // value-reference schema.
    op: z.enum(['assign', 'increment', 'decrement', 'concat']),
    varName: z.string().min(1).max(120),
    value: z.string().max(2000),
  }),
]);

const pageSettingsSchema = z.object({
  size: z.enum(['A4', 'Letter', 'Legal', 'A3', 'A5']),
  orientation: z.enum(['portrait', 'landscape']),
  margins: z.object({
    top: z.number().min(0).max(300),
    right: z.number().min(0).max(300),
    bottom: z.number().min(0).max(300),
    left: z.number().min(0).max(300),
  }),
  pageBreakMargin: z.number().min(0).max(300),
});

const documentPageSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(120).optional(),
});

export const DOCUMENT_DEFINITION_MAX_PAGES = 50;

export const documentTemplateDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(['repeat_per_item', 'fixed_document']),
    sourceEntity: z.enum(
      DOCUMENT_SOURCE_ENTITIES as [string, ...string[]],
    ) as unknown as z.ZodType<DocumentSourceEntity>,
    page: pageSettingsSchema,
    pages: z
      .array(documentPageSchema)
      .min(1)
      .max(DOCUMENT_DEFINITION_MAX_PAGES)
      .optional(),
    showPageNumbers: z.boolean().optional(),
    elements: z.array(docElementSchema).max(DOCUMENT_DEFINITION_MAX_ELEMENTS),
    maxExportItems: z.number().int().min(1).max(500).nullable().optional(),
  })
  .superRefine((def, ctx) => {
    if (def.pages) {
      const pageIds = new Set<string>();

      for (const pg of def.pages) {
        if (pageIds.has(pg.id)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate page id: ${pg.id}`,
          });
        }

        pageIds.add(pg.id);
      }
    }

    const byId = new Map<string, (typeof def.elements)[number]>();

    for (const el of def.elements) {
      if (byId.has(el.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate element id: ${el.id}`,
        });
      }

      byId.set(el.id, el);
    }

    for (const el of def.elements) {
      // parentId must point at an existing loop_region.
      if (el.parentId) {
        const parent = byId.get(el.parentId);

        if (!parent) {
          ctx.addIssue({
            code: 'custom',
            message: `Element ${el.id} references missing parent ${el.parentId}`,
          });
          continue;
        }

        if (parent.type !== 'loop_region') {
          ctx.addIssue({
            code: 'custom',
            message: `Element ${el.id} parent ${el.parentId} is not a loop_region`,
          });
          continue;
        }
      }

      // anchored elements only exist in fixed_document mode, at page level.
      if (
        el.positionMode === 'anchored' &&
        (def.mode !== 'fixed_document' || el.parentId)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `Element ${el.id}: anchored position requires fixed_document mode at page level`,
        });
      }

      if (el.type === 'loop_region') {
        if (def.mode === 'repeat_per_item') {
          // Item context is implicit — regions loop subtasks/linked and sit at page level.
          if (el.dataSource === 'items') {
            ctx.addIssue({
              code: 'custom',
              message: `Loop region ${el.id}: dataSource 'items' is not allowed in repeat_per_item mode`,
            });
          }

          if (el.parentId) {
            ctx.addIssue({
              code: 'custom',
              message: `Loop region ${el.id}: nested loop regions are not allowed in repeat_per_item mode`,
            });
          }
        } else {
          // fixed_document: top-level regions iterate the items; nested regions
          // (inside an items region, or inside another nested region) iterate
          // subtasks/linked/dynamic_query. Depth is walked and capped at
          // MAX_LOOP_REGION_DEPTH, not fixed at 2.
          if (!el.parentId && el.dataSource !== 'items') {
            ctx.addIssue({
              code: 'custom',
              message: `Loop region ${el.id}: top-level regions in fixed_document mode must use dataSource 'items'`,
            });
          }

          if (el.parentId) {
            const parent = byId.get(el.parentId);

            if (parent && parent.type === 'loop_region') {
              // Walk the parentId chain counting loop_region ancestors —
              // a level-agnostic check, not a single "does my parent have a
              // parent" test, so it correctly bounds depth 3, 4, ... N.
              let depth = 1;
              let ancestor: (typeof def.elements)[number] | undefined = parent;

              while (ancestor?.parentId) {
                const next = byId.get(ancestor.parentId);

                if (!next || next.type !== 'loop_region') break;
                depth += 1;
                ancestor = next;
              }

              if (depth >= MAX_LOOP_REGION_DEPTH) {
                ctx.addIssue({
                  code: 'custom',
                  message: `Loop region ${el.id}: loop nesting deeper than ${MAX_LOOP_REGION_DEPTH} levels is not supported`,
                });
              }

              if (el.dataSource === 'items') {
                ctx.addIssue({
                  code: 'custom',
                  message: `Loop region ${el.id}: nested regions must use 'subtasks', 'linked_tasks', or 'dynamic_query'`,
                });
              }
            }
          }
        }

        if (el.dataSource === 'dynamic_query') {
          if (!el.targetEntity || !el.filterField || !el.comparisonField) {
            ctx.addIssue({
              code: 'custom',
              message: `Loop region ${el.id}: dataSource 'dynamic_query' requires targetEntity, filterField and comparisonField`,
            });
          } else {
            const targetFieldKeys = new Set(
              (
                SYSTEM_FIELDS_BY_ENTITY[
                  el.targetEntity as DocumentSourceEntity
                ] ?? []
              )
                .filter((field) => !field.virtual)
                .map((field) => field.key),
            );
            if (!targetFieldKeys.has(el.filterField)) {
              ctx.addIssue({
                code: 'custom',
                message: `Loop region ${el.id}: filterField '${el.filterField}' is not a known system field on '${el.targetEntity}'`,
              });
            }

            // comparisonField is read off the PARENT row, whose entity is
            // 'items' → the definition's sourceEntity, 'subtasks'/'linked_tasks'
            // → always tasks, or another dynamic_query region → its own
            // targetEntity. Skipped (not an error here) when the parent link
            // itself is broken — the parent/missing-parent checks above
            // already flag that.
            const parent = el.parentId ? byId.get(el.parentId) : undefined;
            const parentEntity: string | null = !parent
              ? def.sourceEntity
              : parent.type !== 'loop_region'
                ? null
                : parent.dataSource === 'dynamic_query'
                  ? (parent.targetEntity ?? null)
                  : parent.dataSource === 'subtasks' ||
                      parent.dataSource === 'linked_tasks'
                    ? 'tasks'
                    : def.sourceEntity;

            if (parentEntity) {
              const comparisonFieldKeys = new Set(
                (
                  SYSTEM_FIELDS_BY_ENTITY[
                    parentEntity as DocumentSourceEntity
                  ] ?? []
                )
                  .filter((field) => !field.virtual)
                  .map((field) => field.key),
              );
              if (!comparisonFieldKeys.has(el.comparisonField)) {
                ctx.addIssue({
                  code: 'custom',
                  message: `Loop region ${el.id}: comparisonField '${el.comparisonField}' is not a known system field on '${parentEntity}'`,
                });
              }
            }
          }
        }

        // Task lists: tasks templates only, directly under the exported task.
        if (isTaskListSource(el.dataSource)) {
          if (def.sourceEntity !== 'tasks') {
            ctx.addIssue({
              code: 'custom',
              message: `Loop region ${el.id}: dataSource '${el.dataSource}' is only available in task templates`,
            });
          }

          const listParent = el.parentId ? byId.get(el.parentId) : undefined;

          if (
            def.mode === 'fixed_document' &&
            listParent &&
            (listParent.type !== 'loop_region' ||
              listParent.dataSource !== 'items' ||
              listParent.parentId)
          ) {
            ctx.addIssue({
              code: 'custom',
              message: `Loop region ${el.id}: dataSource '${el.dataSource}' must sit directly inside a top-level 'items' region`,
            });
          }
        }

        const regionParent = el.parentId ? byId.get(el.parentId) : undefined;

        if (
          regionParent?.type === 'loop_region' &&
          isTaskListSource(regionParent.dataSource)
        ) {
          ctx.addIssue({
            code: 'custom',
            message: `Loop region ${el.id}: loop regions cannot be nested inside a '${regionParent.dataSource}' list`,
          });
        }
      }

      // In fixed_document mode, page-level field elements have no item context —
      // they may only bind meta fields (export date, org name, item count, …).
      if (
        def.mode === 'fixed_document' &&
        el.type === 'field' &&
        !el.parentId &&
        el.binding.source !== 'meta'
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `Field element ${el.id}: page-level fields in fixed_document mode must bind meta fields`,
        });
      }
    }
  });

/**
 * Parse + validate a definition, enforcing the serialized-size cap first
 * (mirrors the DB CHECK so users get a friendly error instead of a 23514).
 */
export function parseDocumentTemplateDefinition(
  input: unknown,
): IDocumentTemplateDefinition {
  const size = Buffer.byteLength(JSON.stringify(input ?? {}), 'utf8');

  if (size > DOCUMENT_DEFINITION_MAX_BYTES) {
    throw new Error(
      `Template definition exceeds the 1 MiB limit (${size} bytes)`,
    );
  }

  return documentTemplateDefinitionSchema.parse(
    input,
  ) as IDocumentTemplateDefinition;
}
