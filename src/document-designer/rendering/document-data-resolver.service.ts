/**
 * @fileoverview Builds the fully serializable {@link IDocumentDataContext}
 * consumed by {@link DocumentRenderService}. Item selection for every module
 * the saved-filters query engine has a table config for is routed through it
 * (`executeFilter` / `executeAdHoc`) because it enforces per-user space
 * permissions. Modules with no engine support are read directly by
 * {@link DocumentDataResolverService.selectDirect}, which therefore has to do
 * that scoping itself — org equality PLUS the module's view permission per
 * space. Auxiliary data (subtasks, linked
 * tasks, lookups, custom-field definitions) is batched: one query per concern
 * regardless of item count, always org-scoped (service-role client bypasses
 * RLS, so `.eq('organization_id', …)` in code is mandatory).
 * @module src/document-designer/rendering/document-data-resolver.service
 */

import {
  BadRequestException,
  Injectable,
  Optional,
  PayloadTooLargeException,
} from '@nestjs/common';
import { AgentOriginService } from '../../chat-agent/agent-origin.service';
import { ConfigService } from '@nestjs/config';
import { AssetObjectsService } from '../../assets-objects/asset-objects.service';
import { SYSTEM_FIELDS_BY_ENTITY } from '../bindable-fields.service';
import { SavedFiltersService } from '../../saved-filters/saved-filters.service';
import type {
  IFilterResultItem,
  IFilterRuleGroup,
} from '../../saved-filters/filter-query-engine';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  getSourceEntityConfig,
  type IDocumentSourceEntityConfig,
} from '../source-entities';
import { MAX_LOOP_REGION_DEPTH } from '../template-definition/template-definition.schema';
import type {
  DocumentSourceEntity,
  IDocElement,
  IDocLoopRegionElement,
  IDocumentTemplateDefinition,
} from '../template-definition/template-definition.types';
import { DocumentTaskListsService } from './document-task-lists.service';
import { ElementConditionEvaluator } from './element-condition-evaluator';
import { resolveFieldDef } from './field-formatter';
import {
  isTaskListSource,
  TASK_LIST_SOURCES,
  taskListSourceOfCountKey,
  type TaskListSource,
} from './task-list-sources';

export const DOCUMENT_EXPORT_MAX_ITEMS_DEFAULT = 500;

/**
 * Row cap for the direct read path (modules with no query-engine table config).
 * A `query` scope is evaluated IN MEMORY there, so the candidate set has to be
 * bounded before filtering — anything past this is not scanned, and the run
 * warns rather than silently reporting a short result as complete.
 */
export const DOCUMENT_DIRECT_SCAN_LIMIT = 2000;

/**
 * Max ids per `.in()` filter. PostgREST encodes `.in()` lists in the request
 * URL — beyond ~800 UUIDs the URL passes proxy limits (414/400) and the whole
 * export aborts. 100 ids keep every request URL under ~4 KB.
 */
export const IN_QUERY_CHUNK_SIZE = 100;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TOKEN_REGEX = /\{\{\s*([\w.]+)\s*\}\}/g;

const META_FIELD_KEYS = new Set([
  'exportDate',
  'exportedBy',
  'organizationName',
  'itemIndex',
  'itemCount',
]);

/**
 * System columns the renderer/evaluator resolves directly on the raw row —
 * derived from the same per-module catalog the Fields panel uses
 * (bindable-fields.service.ts), so a field added to any module's system
 * catalog is automatically known here too instead of needing a second,
 * hand-maintained copy of the list.
 */
const KNOWN_SYSTEM_FIELD_KEYS = new Set(
  Object.values(SYSTEM_FIELDS_BY_ENTITY).flatMap((fields) =>
    // Virtual keys (list counts) are not columns — a custom field with that key still resolves.
    fields.filter((field) => !field.virtual).map((field) => field.key),
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// Context shapes (fully serializable — no class instances, no functions)
// ─────────────────────────────────────────────────────────────────────────────

export interface IDocumentUserLookup {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

export interface IDocumentNamedLookup {
  id: string;
  name: string;
  key?: string | null;
  color?: string | null;
}

export interface IDocumentFieldDef {
  field_key: string;
  field_type: string;
  name: string;
  options: Array<{ value: string; label: string }>;

  /** Asset fields only: the space the config pins, which may differ from the row's. */
  asset_space_id?: string | null;
}

export interface IDocumentContextItem {
  id: string;
  /** Source module's item type — see `itemEntityType` in source-entities.ts. */
  entityType: string;
  raw: Record<string, unknown>;
}

export interface IDocumentLinkedEntry {
  relationTypeId: string;
  relationName: string;
  direction: 'outward' | 'inward';
  task: Record<string, unknown>;
}

export interface IDocumentDataContext {
  items: IDocumentContextItem[];
  /**
   * Flat, depth-independent: keyed by IMMEDIATE parent id at any nesting
   * level (pre-fetched up to MAX_LOOP_REGION_DEPTH by fetchSubtasksRecursive),
   * not scoped to a specific loop_region — any row's id that appears anywhere
   * in the resolved tree is a valid key, regardless of how deep it sits.
   */
  subtasksByItemId: Record<string, Array<Record<string, unknown>>>;
  /** Same flat shape as subtasksByItemId; see fetchLinkedTasksRecursive for the visited-id cycle guard. */
  linkedByItemId: Record<string, IDocumentLinkedEntry[]>;
  /**
   * dataSource: 'dynamic_query' results — REGION-scoped (unlike
   * subtasksByItemId/linkedByItemId) because the result depends on the
   * region's own targetEntity/filterField/comparisonField, not just the
   * parent id. Outer key: loop_region element id. Inner key: parent row id.
   */
  dynamicQueryByRegionId: Record<
    string,
    Record<string, Array<Record<string, unknown>>>
  >;
  lookups: {
    usersById: Record<string, IDocumentUserLookup>;
    statusesById: Record<string, IDocumentNamedLookup>;
    prioritiesById: Record<string, IDocumentNamedLookup>;
    spacesById: Record<string, IDocumentNamedLookup>;
    assetsById: Record<string, IDocumentNamedLookup>;
    tasksById: Record<string, IDocumentNamedLookup>;
    wikiPagesById: Record<string, IDocumentNamedLookup>;
    organizationName: string;
  };
  fieldDefsBySpace: Record<string, Record<string, IDocumentFieldDef>>;
  orgFieldDefs: Record<string, IDocumentFieldDef>;
  /** Task list rows (comments, history, …): exported task id → list source → rows. */
  taskListsByTaskId?: Record<
    string,
    Partial<Record<TaskListSource, Array<Record<string, unknown>>>>
  >;
  warnings: string[];
}

/** Which auxiliary fetches a given definition actually requires. */
export interface IDocumentDataNeeds {
  subtasks: boolean;
  linkedTasks: boolean;
  /** Any loop_region with dataSource 'dynamic_query' is present. */
  dynamicQuery: boolean;
  customFields: boolean;
  users: boolean;
  statuses: boolean;
  priorities: boolean;
  spaces: boolean;
  /** Task list sources whose rows or `<source>_count` the template uses (tasks only). */
  taskLists?: TaskListSource[];
  /** The `<source>_count` keys the template references (tasks only). */
  taskListCountKeys?: string[];
}

/** Item-selection scope for an export/preview run. */
export interface IDocumentExportScope {
  savedFilterId?: string | null;
  query?: IFilterRuleGroup | null;
  source_space_ids?: string[] | null;
  ids?: string[] | null;
}

export interface IDocumentResolveParams {
  organizationId: string;
  userId: string;
  sourceEntity: DocumentSourceEntity;
  scope: IDocumentExportScope;
  needs: IDocumentDataNeeds;
  /** Only required when needs.dynamicQuery is true — the tree walk needs the element structure. */
  definition?: IDocumentTemplateDefinition;
  itemLimit?: number;
  /**
   * Preview mode: silently slice to the limit instead of throwing
   * {@link PayloadTooLargeException} (which is the export behavior).
   */
  truncateOverLimit?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Needs computation
// ─────────────────────────────────────────────────────────────────────────────

function collectConditionFields(
  group: IFilterRuleGroup | null | undefined,
  acc: Set<string>,
): void {
  if (!group || !Array.isArray(group.rules)) return;
  for (const rule of group.rules) {
    if ('combinator' in rule) {
      collectConditionFields(rule, acc);
    } else if (typeof rule.field === 'string') {
      acc.add(rule.field);
    }
  }
}

function collectTokenKeys(text: string, acc: Set<string>): void {
  for (const match of text.matchAll(TOKEN_REGEX)) {
    acc.add(match[1]);
  }
}

/** Every field key an element references (bindings, tokens, conditions, loop options). */
function collectElementKeys(el: IDocElement, acc: Set<string>): void {
  collectConditionFields(el.condition ?? null, acc);

  if (el.type === 'field') {
    if (el.binding.source !== 'custom_field') acc.add(el.binding.fieldKey);
  } else if (el.type === 'text') collectTokenKeys(el.html, acc);
  else if (el.type === 'link') {
    collectTokenKeys(el.href, acc);
    collectTokenKeys(el.text, acc);
  } else if (el.type === 'variable_set') collectTokenKeys(el.value, acc);
  else if (el.type === 'loop_region') {
    collectConditionFields(el.filter ?? null, acc);
    if (el.sortBy) acc.add(el.sortBy);
    for (const key of el.passFailFieldKeys ?? []) acc.add(key);
  }
}

/**
 * Walk a validated definition and derive which auxiliary data the renderer
 * will actually touch, so the resolver only fetches what is needed.
 */
export function computeDocumentDataNeeds(
  definition: IDocumentTemplateDefinition,
): IDocumentDataNeeds {
  const needs: IDocumentDataNeeds = {
    subtasks: false,
    linkedTasks: false,
    dynamicQuery: false,
    customFields: false,
    users: false,
    statuses: false,
    priorities: false,
    spaces: false,
  };

  const fieldKeys = new Set<string>();
  const conditionFields = new Set<string>();
  const listRegionIds = new Set(
    definition.elements
      .filter(
        (el) => el.type === 'loop_region' && isTaskListSource(el.dataSource),
      )
      .map((el) => el.id),
  );
  const taskLists = new Set<TaskListSource>();

  for (const el of definition.elements) {
    // List rows use their own catalog — nothing inside a list is a task/custom field.
    if (el.parentId && listRegionIds.has(el.parentId)) {
      // Meta still resolves in list rows; exportedBy needs the user lookup.
      const tokens = new Set<string>();
      if (el.type === 'text') collectTokenKeys(el.html, tokens);
      if (el.type === 'link') {
        collectTokenKeys(el.href, tokens);
        collectTokenKeys(el.text, tokens);
      }
      if (
        tokens.has('exportedBy') ||
        (el.type === 'field' &&
          el.binding.source === 'meta' &&
          el.binding.fieldKey === 'exportedBy')
      )
        needs.users = true;
      continue;
    }

    collectConditionFields(el.condition ?? null, conditionFields);

    if (el.type === 'loop_region' && isTaskListSource(el.dataSource)) {
      taskLists.add(el.dataSource);
      continue;
    }

    if (el.type === 'loop_region') {
      if (el.dataSource === 'subtasks') needs.subtasks = true;
      if (el.dataSource === 'linked_tasks') needs.linkedTasks = true;
      if (el.dataSource === 'dynamic_query') needs.dynamicQuery = true;
      // Loop rows rendering tasks need their status available for pass/fail
      // row styling even when no visible Status field is on the template.
      // 'items' is included because it's the top-level export-scope loop —
      // the primary per-record list — not just nested subtask/linked loops.
      if (
        el.dataSource === 'subtasks' ||
        el.dataSource === 'linked_tasks' ||
        el.dataSource === 'items'
      )
        needs.statuses = true;
      if (el.dataSource === 'dynamic_query' && el.targetEntity === 'tasks')
        needs.statuses = true;
      collectConditionFields(el.filter ?? null, conditionFields);
      if (el.sortBy) conditionFields.add(el.sortBy);
      // Pass/fail styling fields. When explicitly configured, need the same
      // lookups a visible field binding to each of them would need —
      // status/priority have dedicated lookup tables; any other field key
      // flows through the cf_/KNOWN_SYSTEM_FIELD_KEYS classification below
      // via conditionFields. When UNCONFIGURED, the renderer scans every
      // bindable field (system + custom) looking for a Pass/Fail match, so
      // every lookup it could possibly need must be fetched unconditionally.
      if (el.passFailFieldKeys?.length) {
        for (const key of el.passFailFieldKeys) {
          if (key === 'status' || key === 'workflow_status')
            needs.statuses = true;
          if (key === 'priority') needs.priorities = true;
          conditionFields.add(key);
        }
      } else {
        needs.statuses = true;
        needs.priorities = true;
        needs.customFields = true;
      }
    } else if (el.type === 'field') {
      if (el.binding.source === 'custom_field') needs.customFields = true;
      else fieldKeys.add(el.binding.fieldKey);
      if (el.binding.source === 'meta' && el.binding.fieldKey === 'exportedBy')
        needs.users = true;
    } else if (el.type === 'text') {
      collectTokenKeys(el.html, fieldKeys);
    } else if (el.type === 'link') {
      collectTokenKeys(el.href, fieldKeys);
      collectTokenKeys(el.text, fieldKeys);
    }
  }

  // Condition / region-filter / sortBy fields: `cf_` prefixed keys AND bare
  // keys that are neither meta nor known system columns resolve as custom
  // fields at evaluation time (the designer stores custom fields under their
  // bare field_key) — fetch the definitions for both shapes.
  for (const field of conditionFields) {
    if (field.startsWith('cf_')) {
      needs.customFields = true;
      continue;
    }
    if (META_FIELD_KEYS.has(field)) continue;
    if (!KNOWN_SYSTEM_FIELD_KEYS.has(field)) needs.customFields = true;
  }

  const systemKeys = new Set<string>();
  for (const key of fieldKeys) {
    if (META_FIELD_KEYS.has(key)) {
      if (key === 'exportedBy') needs.users = true;
      continue;
    }
    systemKeys.add(key);
  }

  // Any user-typed system field needs the user lookup — derived from the
  // same per-module catalog as KNOWN_SYSTEM_FIELD_KEYS above, so
  // created_by/updated_by/owner_id (and any future user-typed field) are
  // covered the same way assigned_to/reporter always were.
  const userFieldKeys = new Set(
    (SYSTEM_FIELDS_BY_ENTITY[definition.sourceEntity] ?? [])
      .filter((field) => field.fieldType === 'user')
      .map((field) => field.key),
  );
  for (const key of systemKeys) {
    if (userFieldKeys.has(key)) needs.users = true;
  }
  if (systemKeys.has('status')) needs.statuses = true;
  if (systemKeys.has('priority')) needs.priorities = true;
  if (systemKeys.has('space_name')) needs.spaces = true;

  // Tokens that are neither meta nor known system columns resolve as custom
  // fields at render time; err on the side of fetching the definitions.
  for (const key of systemKeys) {
    if (!KNOWN_SYSTEM_FIELD_KEYS.has(key)) needs.customFields = true;
  }

  // Custom user_select/user_multi values need the user lookup to format.
  if (needs.customFields) needs.users = true;

  if (definition.sourceEntity === 'tasks') {
    const referencedKeys = new Set<string>();
    for (const el of definition.elements)
      collectElementKeys(el, referencedKeys);
    const countKeys: string[] = [];
    for (const key of referencedKeys) {
      const source = taskListSourceOfCountKey(key);
      if (!source) continue;
      taskLists.add(source);
      countKeys.push(key);
    }
    if (countKeys.length > 0) needs.taskListCountKeys = countKeys;
    if (taskLists.size > 0) {
      needs.taskLists = TASK_LIST_SOURCES.filter((source) =>
        taskLists.has(source),
      );
    }
  }

  return needs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class DocumentDataResolverService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly savedFilters: SavedFiltersService,
    private readonly configService: ConfigService,
    private readonly assetObjectsService: AssetObjectsService,
    @Optional() private readonly taskListsService?: DocumentTaskListsService,
    @Optional() private readonly origins?: AgentOriginService,
  ) {}

  /** "Drafted by Robert" for the items, in one lookup, only when the template asks for it. */
  private async fillAiLabels(params: IDocumentResolveParams, items: IDocumentContextItem[]): Promise<void> {
    if (!this.origins || !items.length || !JSON.stringify(params.definition ?? {}).includes('"ai_label"')) return;
    const labels = await this.origins.labels(params.organizationId, items.map((item) => item.id)).catch(() => null);
    for (const item of items) {
      const origin = labels?.get(item.id);
      item.raw['ai_label'] = origin
        ? `Drafted by Robert · reviewed by ${origin.confirmedBy ?? 'a former member'} · ${origin.createdAt.slice(0, 10)}`
        : '';
    }
  }

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Public so callers (e.g. document-exports.service.ts) can clamp a per-template override against it. */
  getDefaultMaxItems(): number {
    const raw = this.configService.get<string>('DOCUMENT_EXPORT_MAX_ITEMS');
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DOCUMENT_EXPORT_MAX_ITEMS_DEFAULT;
  }

  async resolve(params: IDocumentResolveParams): Promise<IDocumentDataContext> {
    const warnings: string[] = [];
    const maxItems = params.itemLimit ?? this.getDefaultMaxItems();
    const config = getSourceEntityConfig(params.sourceEntity);
    const entityType = config.itemEntityType;

    // Modules the saved-filters engine knows go through it (it enforces space
    // permissions); the rest are read directly and scoped here — see
    // selectDirect.
    const matching = config.filterSourceType
      ? await this.selectViaFilterEngine(params, config, maxItems, warnings)
      : await this.selectDirect(params, config, maxItems, warnings);

    if (matching.length > maxItems) {
      if (params.truncateOverLimit) {
        warnings.push(
          `Preview truncated to the first ${maxItems} of ${matching.length}+ matching items`,
        );
      } else {
        throw new PayloadTooLargeException(
          `Export matches more than the allowed maximum of ${maxItems} items`,
        );
      }
    }

    const items: IDocumentContextItem[] = matching
      .slice(0, maxItems)
      .map((row) => ({ id: row.id, entityType, raw: row.raw }));

    await this.fillAiLabels(params, items);

    const itemIds = items.map((item) => item.id);

    const context: IDocumentDataContext = {
      items,
      subtasksByItemId: {},
      linkedByItemId: {},
      dynamicQueryByRegionId: {},
      lookups: {
        usersById: {},
        statusesById: {},
        prioritiesById: {},
        spacesById: {},
        assetsById: {},
        tasksById: {},
        wikiPagesById: {},
        organizationName: '',
      },
      fieldDefsBySpace: {},
      orgFieldDefs: {},
      warnings,
    };

    if (
      itemIds.length > 0 &&
      (params.needs.subtasks || params.needs.linkedTasks)
    ) {
      if (params.sourceEntity === 'tasks') {
        // Sub-task and linked-task rows are fetched on the service-role client
        // (RLS bypassed), so they must be constrained to the SAME spaces the
        // permission-safe primary query is limited to — otherwise a task linked
        // into a space the user cannot access would leak into the export.
        const permittedSpaceIds =
          await this.savedFilters.getPermittedTaskSpaceIds(
            params.userId,
            params.organizationId,
          );

        if (params.needs.subtasks) {
          context.subtasksByItemId = await this.fetchSubtasksRecursive(
            params.organizationId,
            itemIds,
            permittedSpaceIds,
          );
        }

        if (params.needs.linkedTasks) {
          context.linkedByItemId = await this.fetchLinkedTasksRecursive(
            params.organizationId,
            itemIds,
            permittedSpaceIds,
            warnings,
          );
        }
      } else {
        if (params.needs.subtasks) {
          warnings.push(
            'Subtask loop regions are only supported for task exports',
          );
        }

        if (params.needs.linkedTasks) {
          warnings.push(
            'Linked-task loop regions are only supported for task exports',
          );
        }
      }
    }

    if (params.needs.dynamicQuery && items.length > 0 && params.definition) {
      await this.resolveDynamicQueries(
        params.definition,
        params.organizationId,
        params.userId,
        context,
        warnings,
      );
    }

    if (params.needs.customFields) {
      const { orgDefs, bySpace } = await this.fetchCustomFieldDefs(
        params.organizationId,
      );
      context.orgFieldDefs = orgDefs;
      context.fieldDefsBySpace = bySpace;
    }

    await this.fetchAssetLookups(params, context);
    await this.fetchReferenceFieldLookups(params, context);
    await this.fetchLookups(params, context);

    if (
      params.needs.taskLists?.length &&
      params.sourceEntity === 'tasks' &&
      items.length > 0
    ) {
      if (this.taskListsService) {
        await this.taskListsService.resolve({
          organizationId: params.organizationId,
          userId: params.userId,
          sources: params.needs.taskLists,
          countKeys: params.needs.taskListCountKeys ?? [],
          context,
        });
      } else {
        warnings.push('Task lists are unavailable here and render empty');
      }
    }

    return context;
  }

  /**
   * Engine-backed modules (tasks / processes / lists / wiki): the saved-filters
   * engine returns permission-scoped summary rows carrying the raw entity under
   * `_entity`.
   */
  private async selectViaFilterEngine(
    params: IDocumentResolveParams,
    config: IDocumentSourceEntityConfig,
    maxItems: number,
    warnings: string[],
  ): Promise<Array<{ id: string; raw: Record<string, unknown> }>> {
    const rows = await this.executeScope(params, maxItems, warnings);

    return rows
      .filter((row) => row.entity_type === config.itemEntityType)
      .map((row) => {
        const raw = row._entity ?? (row as unknown as Record<string, unknown>);
        if (!row._entity) {
          warnings.push(
            `Filter result for ${row.id} carried no raw entity row; using the summary row`,
          );
        }

        return { id: row.id, raw };
      });
  }

  /**
   * Modules with no query-engine table config. The service-role client bypasses
   * RLS, so isolation here is explicit: `organization_id` equality PLUS an
   * `in(space_id, …)` restricted to spaces where the caller actually holds the
   * module's view permission. An empty permitted set returns nothing — it never
   * degrades to an unscoped read.
   *
   * `savedFilterId` is rejected rather than ignored: saved filters cannot target
   * these modules, so honouring the scope silently would export the wrong rows.
   */
  private async selectDirect(
    params: IDocumentResolveParams,
    config: IDocumentSourceEntityConfig,
    maxItems: number,
    warnings: string[],
  ): Promise<Array<{ id: string; raw: Record<string, unknown> }>> {
    const { scope } = params;

    if (scope.savedFilterId) {
      throw new BadRequestException(
        `Saved filters are not available for '${config.key}' templates; use an id list or a query scope`,
      );
    }

    const permittedSpaceIds =
      await this.savedFilters.getPermittedSpaceIdsForPermission(
        params.userId,
        params.organizationId,
        config.viewPermission,
        scope.source_space_ids ?? [],
      );

    if (permittedSpaceIds.length === 0) return [];

    const requestedIds = scope.ids ?? [];
    const validIds = requestedIds.filter((id) => UUID_REGEX.test(id));

    if (validIds.length !== requestedIds.length) {
      warnings.push('Some requested item ids were not valid UUIDs (ignored)');
    }
    if (requestedIds.length > 0 && validIds.length === 0) return [];

    // A `query` scope is filtered in memory below, so the candidate set must be
    // over-fetched; without one the cap is the export limit itself.
    const scanLimit = scope.query ? DOCUMENT_DIRECT_SCAN_LIMIT : maxItems + 1;

    const runQuery = async (
      idChunk?: string[],
    ): Promise<Array<Record<string, unknown>>> => {
      let query = this.client
        .from(config.table)
        .select('*')
        .eq('organization_id', params.organizationId)
        .in('space_id', permittedSpaceIds)
        .order('created_at', { ascending: false })
        .limit(scanLimit);

      if (config.extraFilter) query = query.match(config.extraFilter);
      if (idChunk) query = query.in('id', idChunk);

      const { data, error } = (await query) as {
        data: Array<Record<string, unknown>> | null;
        error: { message: string } | null;
      };

      if (error) throw new BadRequestException(error.message);

      return data ?? [];
    };

    let rows =
      validIds.length > 0
        ? await this.fetchInChunks(validIds, (chunk) => runQuery(chunk))
        : await runQuery();

    if (scope.query) {
      if (rows.length >= scanLimit) {
        warnings.push(
          `Only the first ${DOCUMENT_DIRECT_SCAN_LIMIT} ${config.key} records were scanned for the query scope`,
        );
      }

      const evaluator = new ElementConditionEvaluator(config.itemEntityType);
      const queryWarnings = new Set<string>();

      rows = rows.filter((row) => {
        const result = evaluator.evaluate(scope.query, row);
        if (result.warning) queryWarnings.add(result.warning);

        return result.show;
      });
      warnings.push(...queryWarnings);
    }

    const ordered =
      validIds.length > 0
        ? // Preserve the caller's requested ordering.
          validIds
            .map((id) => rows.find((row) => row['id'] === id))
            .filter((row): row is Record<string, unknown> => Boolean(row))
        : rows;

    return ordered.map((row) => ({ id: row['id'] as string, raw: row }));
  }

  // ── Scope execution ───────────────────────────────────────────────────────

  private async executeScope(
    params: IDocumentResolveParams,
    maxItems: number,
    warnings: string[],
  ): Promise<IFilterResultItem[]> {
    const { scope } = params;
    // Fetch one row beyond the cap so over-limit detection does not depend on
    // the engine's `total` semantics.
    const pageSize = maxItems + 1;

    if (scope.savedFilterId) {
      const { data } = await this.savedFilters.executeFilter(
        scope.savedFilterId,
        params.organizationId,
        params.userId,
        { page: 1, pageSize },
        { audit: false },
      );
      return data.data;
    }

    if (scope.ids && scope.ids.length > 0) {
      return this.executeIdsScope(params, scope.ids, pageSize, warnings);
    }

    if (scope.query) {
      const { data } = await this.savedFilters.executeAdHoc(
        {
          query: scope.query as unknown as Record<string, unknown>,
          source_type: getSourceEntityConfig(params.sourceEntity)
            .filterSourceType!,
          source_space_ids: scope.source_space_ids ?? [],
          sort: { column: 'created_at', direction: 'desc' },
          page: 1,
          pageSize,
        },
        params.organizationId,
        params.userId,
      );
      return data.data;
    }

    throw new BadRequestException(
      'Export scope requires one of savedFilterId, query, or ids',
    );
  }

  /**
   * Explicit-ids scope. The query engine's field whitelist has no universal
   * `id` entry, so for key-bearing entities the ids are first translated to
   * entity keys with a minimal org-scoped lookup (exposes nothing but the org's
   * own row keys) and the engine then runs a `key in (…)` filter. Entities that
   * DO map `id` (wiki) skip the translation. Either way item ACCESS stays
   * permission-enforced by the engine. Results are filtered back to the
   * requested id set and kept in the caller's order.
   */
  private async executeIdsScope(
    params: IDocumentResolveParams,
    requestedIds: string[],
    pageSize: number,
    warnings: string[],
  ): Promise<IFilterResultItem[]> {
    const config = getSourceEntityConfig(params.sourceEntity);

    if (!config.engineIdRuleField) {
      // Rejected rather than returning [] — the engine cannot filter this
      // entity by identity, so an empty result would read as "nothing matched".
      throw new BadRequestException(
        `An explicit id export scope is not supported for '${config.key}'; use a query scope`,
      );
    }

    const validIds = requestedIds.filter((id) => UUID_REGEX.test(id));
    if (validIds.length !== requestedIds.length) {
      warnings.push('Some requested item ids were not valid UUIDs (ignored)');
    }
    if (validIds.length === 0) return [];

    let ruleValue: string[] = validIds;

    if (config.engineIdRuleField === 'key') {
      const idRows = await this.fetchInChunks(validIds, async (chunk) => {
        const { data, error } = (await this.client
          .from(config.table)
          .select(`id, ${config.keyColumn as string}`)
          .eq('organization_id', params.organizationId)
          .in('id', chunk)) as {
          data: Array<Record<string, unknown>> | null;
          error: { message: string } | null;
        };

        if (error) throw new BadRequestException(error.message);
        return data ?? [];
      });

      ruleValue = idRows
        .map((row) => row[config.keyColumn as string])
        .filter((key): key is string => typeof key === 'string' && key !== '');
      if (ruleValue.length === 0) return [];
    }

    const { data: result } = await this.savedFilters.executeAdHoc(
      {
        query: {
          combinator: 'and',
          rules: [
            {
              field: config.engineIdRuleField,
              operator: 'in',
              value: ruleValue,
            },
          ],
        },
        source_type: config.filterSourceType!,
        source_space_ids: [],
        page: 1,
        pageSize,
      },
      params.organizationId,
      params.userId,
    );

    const requestedSet = new Set(validIds);
    const byId = new Map(
      result.data
        .filter((row) => requestedSet.has(row.id))
        .map((row) => [row.id, row]),
    );

    // Preserve the caller's requested ordering.
    return validIds
      .map((id) => byId.get(id))
      .filter((row): row is IFilterResultItem => Boolean(row));
  }

  // ── Auxiliary batched fetches ─────────────────────────────────────────────

  /**
   * Run an `.in()`-style lookup in chunks of {@link IN_QUERY_CHUNK_SIZE} ids
   * and concatenate the results — large id lists must never travel in a
   * single request URL (proxy limits, see the constant's doc).
   */
  private async fetchInChunks<T>(
    ids: string[],
    fetch: (chunk: string[]) => Promise<T[]>,
  ): Promise<T[]> {
    const results: T[] = [];
    for (let i = 0; i < ids.length; i += IN_QUERY_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + IN_QUERY_CHUNK_SIZE);
      results.push(...(await fetch(chunk)));
    }
    return results;
  }

  private async fetchSubtasks(
    organizationId: string,
    itemIds: string[],
    permittedSpaceIds: string[],
  ): Promise<Record<string, Array<Record<string, unknown>>>> {
    // No accessible task space → no visible sub-tasks (mirrors the primary
    // query's space scoping; prevents a service-role cross-space read).
    if (permittedSpaceIds.length === 0) return {};

    const rows = await this.fetchInChunks(itemIds, async (chunk) => {
      const { data, error } = (await this.client
        .from('tasks')
        .select('*')
        .eq('organization_id', organizationId)
        .in('space_id', permittedSpaceIds)
        .in('parent_task_id', chunk)
        .order('sort_order', { ascending: true })) as {
        data: Array<Record<string, unknown>> | null;
        error: { message: string } | null;
      };

      if (error) throw new BadRequestException(error.message);
      return data ?? [];
    });

    // Chunking breaks the per-query ordering — re-sort the merged rows so
    // per-parent grouping below stays sort_order ascending.
    rows.sort(
      (a, b) => numberOrMax(a['sort_order']) - numberOrMax(b['sort_order']),
    );

    const grouped: Record<string, Array<Record<string, unknown>>> = {};
    for (const row of rows) {
      const parentId = row['parent_task_id'];
      if (typeof parentId !== 'string' || !parentId) continue;
      (grouped[parentId] ??= []).push(row);
    }
    return grouped;
  }

  private async fetchLinkedTasks(
    organizationId: string,
    itemIds: string[],
    permittedSpaceIds: string[],
    warnings: string[],
  ): Promise<Record<string, IDocumentLinkedEntry[]>> {
    // No accessible task space → no visible linked tasks (relationship rows are
    // still safe to skip; the counterpart task content is what must be scoped).
    if (permittedSpaceIds.length === 0) return {};

    interface RelationshipRow {
      id: string;
      source_id: string;
      target_id: string;
      source_type: string;
      target_type: string;
      relation_type_id: string;
      relation_type: {
        id: string;
        name: string;
        outward_description: string | null;
        inward_description: string | null;
      } | null;
    }

    const select =
      'id, source_id, target_id, source_type, target_type, relation_type_id, relation_type:relation_types!task_relationships_relation_type_id_fkey(id, name, outward_description, inward_description)';

    const fetchRelationships = (column: 'source_id' | 'target_id') =>
      this.fetchInChunks(itemIds, async (chunk) => {
        const { data, error } = await this.client
          .from('task_relationships')
          .select(select)
          .eq('organization_id', organizationId)
          .in(column, chunk);

        if (error) throw new BadRequestException(error.message);
        return (data ?? []) as unknown as RelationshipRow[];
      });

    const [outwardRows, inwardRows] = await Promise.all([
      fetchRelationships('source_id'),
      fetchRelationships('target_id'),
    ]);

    // Collect counterpart task ids, then fetch them in ONE org-scoped query.
    const counterpartIds = new Set<string>();
    for (const row of outwardRows) {
      if (row.target_type === 'task') counterpartIds.add(row.target_id);
    }
    for (const row of inwardRows) {
      if (row.source_type === 'task') counterpartIds.add(row.source_id);
    }

    const tasksById = new Map<string, Record<string, unknown>>();
    if (counterpartIds.size > 0) {
      const counterparts = await this.fetchInChunks(
        Array.from(counterpartIds),
        async (chunk) => {
          const { data, error } = (await this.client
            .from('tasks')
            .select('*')
            .eq('organization_id', organizationId)
            .in('space_id', permittedSpaceIds)
            .in('id', chunk)) as {
            data: Array<Record<string, unknown>> | null;
            error: { message: string } | null;
          };

          if (error) throw new BadRequestException(error.message);
          return data ?? [];
        },
      );
      for (const row of counterparts) {
        const rowId = row['id'];
        if (typeof rowId === 'string') tasksById.set(rowId, row);
      }
    }

    const itemIdSet = new Set(itemIds);
    const grouped: Record<string, IDocumentLinkedEntry[]> = {};

    const push = (
      itemId: string,
      row: RelationshipRow,
      direction: 'outward' | 'inward',
      counterpartId: string,
    ): void => {
      const task = tasksById.get(counterpartId);
      if (!task) return; // counterpart is not a task (process/plan_item) or not visible
      const relationName =
        (direction === 'outward'
          ? row.relation_type?.outward_description
          : row.relation_type?.inward_description) ??
        row.relation_type?.name ??
        '';
      (grouped[itemId] ??= []).push({
        relationTypeId: row.relation_type_id,
        relationName,
        direction,
        task,
      });
    };

    for (const row of outwardRows) {
      if (!itemIdSet.has(row.source_id)) continue;
      push(row.source_id, row, 'outward', row.target_id);
    }
    for (const row of inwardRows) {
      if (!itemIdSet.has(row.target_id)) continue;
      if (itemIdSet.has(row.source_id) && row.source_type === 'task') {
        // Relationship between two exported items — already listed outward.
      }
      push(row.target_id, row, 'inward', row.source_id);
    }

    if (outwardRows.length + inwardRows.length > 0 && tasksById.size === 0) {
      warnings.push(
        'Linked items exist but none are tasks; regions render empty',
      );
    }

    return grouped;
  }

  /**
   * Depth-bounded frontier fetch: level 0 = rootIds' direct children, level 1
   * = THEIR children, etc., merged into ONE flat parent-id-keyed map (see
   * IDocumentDataContext.subtasksByItemId doc). subtasks are DB-cycle-protected
   * (check_task_circular_dependency trigger walks parent_task_id, uncapped) —
   * no visited-id guard needed here, unlike linked_tasks below.
   */
  private async fetchSubtasksRecursive(
    organizationId: string,
    rootIds: string[],
    permittedSpaceIds: string[],
  ): Promise<Record<string, Array<Record<string, unknown>>>> {
    const merged: Record<string, Array<Record<string, unknown>>> = {};
    let frontier = rootIds;

    for (
      let depth = 0;
      depth < MAX_LOOP_REGION_DEPTH && frontier.length > 0;
      depth++
    ) {
      const level = await this.fetchSubtasks(
        organizationId,
        frontier,
        permittedSpaceIds,
      );
      Object.assign(merged, level);
      frontier = Object.values(level)
        .flat()
        .map((row) => row['id'])
        .filter((id): id is string => typeof id === 'string');
    }

    return merged;
  }

  /**
   * Depth-bounded frontier fetch mirroring fetchSubtasksRecursive, but WITH a
   * global visited-id guard: task_relationships has NO DB cycle protection
   * (an A↔B pair can exist today), so without this an A↔B cycle would
   * re-expand forever. A node's linked tasks are only ever expanded once
   * across the whole walk — correct semantics ("don't re-visit an
   * already-expanded node") that also terminates any cycle within 2 levels.
   */
  private async fetchLinkedTasksRecursive(
    organizationId: string,
    rootIds: string[],
    permittedSpaceIds: string[],
    warnings: string[],
  ): Promise<Record<string, IDocumentLinkedEntry[]>> {
    const merged: Record<string, IDocumentLinkedEntry[]> = {};
    const visited = new Set<string>(rootIds);
    let frontier = rootIds;

    for (
      let depth = 0;
      depth < MAX_LOOP_REGION_DEPTH && frontier.length > 0;
      depth++
    ) {
      const level = await this.fetchLinkedTasks(
        organizationId,
        frontier,
        permittedSpaceIds,
        warnings,
      );
      Object.assign(merged, level);

      const nextFrontier: string[] = [];
      for (const entries of Object.values(level)) {
        for (const entry of entries) {
          const id = entry.task['id'];
          if (typeof id === 'string' && !visited.has(id)) {
            visited.add(id);
            nextFrontier.push(id);
          }
        }
      }
      frontier = nextFrontier;
    }

    return merged;
  }

  /**
   * Walks the loop_region TREE (not the entity relationship graph) to
   * pre-fetch every dataSource:'dynamic_query' region's data. subtasks/
   * linked_tasks ancestors reuse the already-fetched flat maps above (zero
   * extra queries); only dynamic_query regions issue a batched query here.
   * Both render modes reduce to the same shape: the root frontier is always
   * `items` (repeat_per_item's implicit top-level "current item" context ==
   * fixed_document's top-level 'items' region frontier) — see
   * template-definition.schema.ts's mode rules for why nesting is only
   * possible at all in fixed_document mode.
   */
  private async resolveDynamicQueries(
    definition: IDocumentTemplateDefinition,
    organizationId: string,
    userId: string,
    context: IDocumentDataContext,
    warnings: string[],
  ): Promise<void> {
    const regions = definition.elements.filter(
      (el): el is IDocLoopRegionElement => el.type === 'loop_region',
    );
    const byParentId = new Map<string | null, IDocLoopRegionElement[]>();
    for (const region of regions) {
      const key = region.parentId ?? null;
      const list = byParentId.get(key) ?? [];
      list.push(region);
      byParentId.set(key, list);
    }

    const rootFrontier = context.items.map((item) => ({
      id: item.id,
      raw: item.raw,
    }));

    const walk = async (
      region: IDocLoopRegionElement,
      parentFrontier: Array<{ id: string; raw: Record<string, unknown> }>,
      depth: number,
    ): Promise<void> => {
      if (depth > MAX_LOOP_REGION_DEPTH) return;

      let ownFrontier: Array<{ id: string; raw: Record<string, unknown> }>;

      if (region.dataSource === 'dynamic_query') {
        ownFrontier = await this.fetchDynamicQueryForRegion(
          region,
          parentFrontier,
          organizationId,
          userId,
          context,
          warnings,
        );
      } else if (region.dataSource === 'subtasks') {
        ownFrontier = parentFrontier.flatMap((p) =>
          (context.subtasksByItemId[p.id] ?? []).map((raw) => ({
            id: typeof raw['id'] === 'string' ? raw['id'] : '',
            raw,
          })),
        );
      } else if (region.dataSource === 'linked_tasks') {
        ownFrontier = parentFrontier.flatMap((p) =>
          (context.linkedByItemId[p.id] ?? []).map((entry) => ({
            id: typeof entry.task['id'] === 'string' ? entry.task['id'] : '',
            raw: entry.task,
          })),
        );
      } else {
        // 'items' — only valid as a top-level region; its frontier IS the parent frontier.
        ownFrontier = parentFrontier;
      }

      const children = byParentId.get(region.id) ?? [];
      for (const child of children) {
        await walk(child, ownFrontier, depth + 1);
      }
    };

    const rootRegions = byParentId.get(null) ?? [];
    for (const root of rootRegions) {
      await walk(root, rootFrontier, 1);
    }
  }

  /**
   * Batched dynamic_query fetch for ONE region: collect distinct
   * comparisonField values across the current parent frontier, one (chunked)
   * `filterField IN (...)` query against the target table directly (mirrors
   * selectDirect's org+permitted-space scoping — a plain equality/IN filter
   * needs no query-engine AND/OR rule-tree support, so every one of the 11
   * DOCUMENT_SOURCE_ENTITIES is supported uniformly here, not just the 4 the
   * saved-filters engine has table configs for), then group results back onto
   * every parent row that shared the matched value.
   */
  private async fetchDynamicQueryForRegion(
    region: IDocLoopRegionElement,
    parentFrontier: Array<{ id: string; raw: Record<string, unknown> }>,
    organizationId: string,
    userId: string,
    context: IDocumentDataContext,
    warnings: string[],
  ): Promise<Array<{ id: string; raw: Record<string, unknown> }>> {
    const grouped: Record<string, Array<Record<string, unknown>>> = {};
    context.dynamicQueryByRegionId[region.id] = grouped;

    const { targetEntity, filterField, comparisonField } = region;
    if (
      !targetEntity ||
      !filterField ||
      !comparisonField ||
      parentFrontier.length === 0
    ) {
      return [];
    }

    const valueToParentIds = new Map<string, string[]>();
    for (const parent of parentFrontier) {
      const value = parent.raw[comparisonField];
      if (value === null || value === undefined || value === '') continue;
      const key = toComparableKey(value);
      const list = valueToParentIds.get(key) ?? [];
      list.push(parent.id);
      valueToParentIds.set(key, list);
    }

    const distinctValues = Array.from(valueToParentIds.keys());
    if (distinctValues.length === 0) return [];

    const config = getSourceEntityConfig(targetEntity);
    const permittedSpaceIds =
      await this.savedFilters.getPermittedSpaceIdsForPermission(
        userId,
        organizationId,
        config.viewPermission,
        [],
      );
    if (permittedSpaceIds.length === 0) return [];

    let truncated = false;
    const matchedRows = await this.fetchInChunks(
      distinctValues,
      async (chunk) => {
        let query = this.client
          .from(config.table)
          .select('*')
          .eq('organization_id', organizationId)
          .in('space_id', permittedSpaceIds)
          .in(filterField, chunk)
          .limit(DOCUMENT_DIRECT_SCAN_LIMIT);

        if (config.extraFilter) query = query.match(config.extraFilter);

        const { data, error } = (await query) as {
          data: Array<Record<string, unknown>> | null;
          error: { message: string } | null;
        };

        if (error) throw new BadRequestException(error.message);
        if ((data ?? []).length >= DOCUMENT_DIRECT_SCAN_LIMIT) truncated = true;

        return data ?? [];
      },
    );

    if (truncated) {
      warnings.push(
        `Loop region ${region.id}: dynamic query results were truncated to ${DOCUMENT_DIRECT_SCAN_LIMIT} rows per batch`,
      );
    }

    const ownFrontier: Array<{ id: string; raw: Record<string, unknown> }> = [];
    for (const row of matchedRows) {
      const matchedValue = row[filterField];
      if (matchedValue === null || matchedValue === undefined) continue;
      const parentIds = valueToParentIds.get(toComparableKey(matchedValue));
      if (!parentIds) continue;

      for (const parentId of parentIds) {
        (grouped[parentId] ??= []).push(row);
      }
      const rowId = row['id'];
      if (typeof rowId === 'string') {
        ownFrontier.push({ id: rowId, raw: row });
      }
    }

    return ownFrontier;
  }

  private async fetchCustomFieldDefs(organizationId: string): Promise<{
    orgDefs: Record<string, IDocumentFieldDef>;
    bySpace: Record<string, Record<string, IDocumentFieldDef>>;
  }> {
    const { data, error } = (await this.client
      .from('custom_fields')
      .select(
        'field_key, field_type, name, options, space_id, validation_rules',
      )
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .or('is_deleted.is.null,is_deleted.eq.false')) as {
      data: Array<{
        field_key: string;
        field_type: string;
        name: string;
        options: unknown;
        space_id: string | null;
        validation_rules: Record<string, unknown> | null;
      }> | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);

    const orgDefs: Record<string, IDocumentFieldDef> = {};
    const bySpace: Record<string, Record<string, IDocumentFieldDef>> = {};

    for (const row of data ?? []) {
      const assetConfig = row.validation_rules?.asset as
        | { space_id?: unknown }
        | undefined;

      const def: IDocumentFieldDef = {
        field_key: row.field_key,
        field_type: row.field_type,
        name: row.name,
        options: normalizeOptions(row.options),
        asset_space_id:
          typeof assetConfig?.space_id === 'string'
            ? assetConfig.space_id
            : null,
      };
      if (row.space_id) {
        (bySpace[row.space_id] ??= {})[row.field_key] = def;
      } else {
        orgDefs[row.field_key] = def;
      }
    }

    return { orgDefs, bySpace };
  }

  /**
   * Resolve `asset`/`asset_multi` custom field values to asset names. Each id
   * goes through {@link AssetObjectsService.getOne} — the same per-object-type
   * `can_view` check and space/org scoping the assets module enforces
   * everywhere else — never a batched admin query, which would bypass ACLs.
   */
  private async fetchAssetLookups(
    params: IDocumentResolveParams,
    context: IDocumentDataContext,
  ): Promise<void> {
    const hasAssetFieldDef = (defs: Record<string, IDocumentFieldDef>) =>
      Object.values(defs).some(
        (def) => def.field_type === 'asset' || def.field_type === 'asset_multi',
      );

    const anyAssetFields =
      hasAssetFieldDef(context.orgFieldDefs) ||
      Object.values(context.fieldDefsBySpace).some(hasAssetFieldDef);

    // No asset-type field defs exist for this org — nothing to resolve.
    if (!anyAssetFields) return;

    const rows: Array<Record<string, unknown>> = [
      ...context.items.map((item) => item.raw),
      ...Object.values(context.subtasksByItemId).flat(),
      ...Object.values(context.linkedByItemId)
        .flat()
        .map((entry) => entry.task),
    ];

    const candidates = new Map<
      string,
      { assetId: string; spaceId: string; pinned: boolean }
    >();

    for (const row of rows) {
      const customValues = row['custom_field_values'];
      if (!customValues || typeof customValues !== 'object') continue;

      const rowSpaceId = row['space_id'];

      for (const [key, value] of Object.entries(
        customValues as Record<string, unknown>,
      )) {
        const def = resolveFieldDef(key, row, context);
        if (
          !def ||
          (def.field_type !== 'asset' && def.field_type !== 'asset_multi')
        )
          continue;

        // The field's own config pins the source space; the row's space is only
        // a fallback, so an org-level field resolves against the right inventory.
        const pinned = typeof def.asset_space_id === 'string';
        const spaceId = pinned
          ? (def.asset_space_id as string)
          : typeof rowSpaceId === 'string'
            ? rowSpaceId
            : '';

        if (!spaceId) continue;

        const entries = Array.isArray(value) ? value : [value];
        for (const entry of entries) {
          if (typeof entry !== 'string' || !entry) continue;

          // A pinned space beats a row-derived one, whichever was seen first.
          const seen = candidates.get(entry);
          if (seen && (seen.pinned || !pinned)) continue;

          candidates.set(entry, { assetId: entry, spaceId, pinned });
        }
      }
    }

    const candidateList = Array.from(candidates.values());
    const CHUNK_SIZE = 5;

    for (let i = 0; i < candidateList.length; i += CHUNK_SIZE) {
      const chunk = candidateList.slice(i, i + CHUNK_SIZE);
      await Promise.all(
        chunk.map(async ({ assetId, spaceId }) => {
          try {
            const obj = await this.assetObjectsService.getOne(
              assetId,
              spaceId,
              params.organizationId,
              params.userId,
            );
            const record = obj;
            context.lookups.assetsById[assetId] = {
              id: assetId,
              name:
                (record['name'] as string) ??
                (record['object_key'] as string) ??
                assetId,
            };
          } catch {
            // NotFoundException, ForbiddenException, or anything else — never
            // abort the export; the formatter falls back to a generic label.
            context.lookups.assetsById[assetId] = {
              id: assetId,
              name: '-',
            };
          }
        }),
      );
    }
  }

  /**
   * Resolve `task` / `wiki_page` custom-field values (raw ids) to a
   * name/key for rendering. Mirrors fetchAssetLookups's "scan referenced
   * rows, resolve, never abort" shape, but batches the lookup query (like
   * fetchLinkedTasks) instead of one-at-a-time — tasks/wiki pages use plain
   * space-membership + module view-permission (no per-object ACL like
   * assets), so a single permitted-space-scoped query is already safe: a
   * referenced item outside the caller's permitted spaces simply never
   * matches the query and is left unresolved (rendered empty by the
   * formatter), never leaked.
   */
  private async fetchReferenceFieldLookups(
    params: IDocumentResolveParams,
    context: IDocumentDataContext,
  ): Promise<void> {
    const hasFieldOfType = (
      defs: Record<string, IDocumentFieldDef>,
      type: string,
    ) => Object.values(defs).some((def) => def.field_type === type);

    const anyOfType = (type: string) =>
      hasFieldOfType(context.orgFieldDefs, type) ||
      Object.values(context.fieldDefsBySpace).some((defs) =>
        hasFieldOfType(defs, type),
      );

    if (!anyOfType('task') && !anyOfType('wiki_page')) return;

    const rows: Array<Record<string, unknown>> = [
      ...context.items.map((item) => item.raw),
      ...Object.values(context.subtasksByItemId).flat(),
      ...Object.values(context.linkedByItemId)
        .flat()
        .map((entry) => entry.task),
    ];

    const taskIds = new Set<string>();
    const wikiPageIds = new Set<string>();

    for (const row of rows) {
      const customValues = row['custom_field_values'];
      if (!customValues || typeof customValues !== 'object') continue;

      for (const [key, value] of Object.entries(
        customValues as Record<string, unknown>,
      )) {
        const def = resolveFieldDef(key, row, context);
        if (!def) continue;

        const entries = Array.isArray(value) ? value : [value];
        const target =
          def.field_type === 'task'
            ? taskIds
            : def.field_type === 'wiki_page'
              ? wikiPageIds
              : null;
        if (!target) continue;

        for (const entry of entries) {
          if (typeof entry === 'string' && entry) target.add(entry);
        }
      }
    }

    const [permittedTaskSpaceIds, permittedWikiSpaceIds] = await Promise.all([
      taskIds.size > 0
        ? this.savedFilters.getPermittedTaskSpaceIds(
            params.userId,
            params.organizationId,
          )
        : Promise.resolve<string[]>([]),
      wikiPageIds.size > 0
        ? this.savedFilters.getPermittedSpaceIdsForPermission(
            params.userId,
            params.organizationId,
            'view_wiki_pages',
          )
        : Promise.resolve<string[]>([]),
    ]);

    await Promise.all([
      this.resolveTaskRefs(
        params.organizationId,
        taskIds,
        permittedTaskSpaceIds,
        context,
      ),
      this.resolveWikiPageRefs(
        params.organizationId,
        wikiPageIds,
        permittedWikiSpaceIds,
        context,
      ),
    ]);
  }

  private async resolveTaskRefs(
    organizationId: string,
    taskIds: Set<string>,
    permittedSpaceIds: string[],
    context: IDocumentDataContext,
  ): Promise<void> {
    if (taskIds.size === 0 || permittedSpaceIds.length === 0) return;

    const rows = await this.fetchInChunks(
      Array.from(taskIds),
      async (chunk) => {
        const { data, error } = (await this.client
          .from('tasks')
          .select('id, key, summary')
          .eq('organization_id', organizationId)
          .in('space_id', permittedSpaceIds)
          .in('id', chunk)) as {
          data: Array<{ id: string; key: string; summary: string }> | null;
          error: { message: string } | null;
        };

        if (error) throw new BadRequestException(error.message);
        return data ?? [];
      },
    );

    for (const row of rows) {
      context.lookups.tasksById[row.id] = {
        id: row.id,
        name: row.summary,
        key: row.key,
      };
    }
  }

  private async resolveWikiPageRefs(
    organizationId: string,
    wikiPageIds: Set<string>,
    permittedSpaceIds: string[],
    context: IDocumentDataContext,
  ): Promise<void> {
    if (wikiPageIds.size === 0 || permittedSpaceIds.length === 0) return;

    const rows = await this.fetchInChunks(
      Array.from(wikiPageIds),
      async (chunk) => {
        const { data, error } = (await this.client
          .from('wiki_pages')
          .select('id, title')
          .eq('organization_id', organizationId)
          .in('space_id', permittedSpaceIds)
          .in('id', chunk)) as {
          data: Array<{ id: string; title: string }> | null;
          error: { message: string } | null;
        };

        if (error) throw new BadRequestException(error.message);
        return data ?? [];
      },
    );

    for (const row of rows) {
      context.lookups.wikiPagesById[row.id] = {
        id: row.id,
        name: row.title,
      };
    }
  }

  private async fetchLookups(
    params: IDocumentResolveParams,
    context: IDocumentDataContext,
  ): Promise<void> {
    const { needs, organizationId } = params;

    // Organization name — always fetched (meta binding + export headers).
    const { data: org } = (await this.client
      .from('organizations')
      .select('name')
      .eq('id', organizationId)
      .maybeSingle()) as { data: { name: string } | null };
    context.lookups.organizationName = org?.name ?? '';

    const allRaws: Array<Record<string, unknown>> = [
      ...context.items.map((item) => item.raw),
      ...Object.values(context.subtasksByItemId).flat(),
      ...Object.values(context.linkedByItemId)
        .flat()
        .map((entry) => entry.task),
    ];

    if (needs.users) {
      const userIds = new Set<string>();
      if (params.userId) userIds.add(params.userId);
      for (const raw of allRaws) {
        for (const key of ['assigned_to', 'reporter', 'created_by']) {
          const value = raw[key];
          if (typeof value === 'string' && UUID_REGEX.test(value))
            userIds.add(value);
        }
        const customValues = raw['custom_field_values'];
        if (customValues && typeof customValues === 'object') {
          for (const value of Object.values(
            customValues as Record<string, unknown>,
          )) {
            if (typeof value === 'string' && UUID_REGEX.test(value))
              userIds.add(value);
            if (Array.isArray(value)) {
              for (const entry of value) {
                if (typeof entry === 'string' && UUID_REGEX.test(entry))
                  userIds.add(entry);
              }
            }
          }
        }
      }

      if (userIds.size > 0) {
        // Harvested UUIDs include user-writable custom_field_values — restrict
        // the lookup to MEMBERS of the exporting organization (`users` is a
        // global table; the service-role client bypasses RLS), so a planted
        // foreign UUID can never leak another tenant's name/email. Non-member
        // ids simply stay absent from the lookup (rendered empty + warning).
        const memberRows = await this.fetchInChunks(
          Array.from(userIds),
          async (chunk) => {
            const { data, error } = (await this.client
              .from('organization_members')
              .select('user_id')
              .eq('organization_id', organizationId)
              .in('user_id', chunk)) as {
              data: Array<{ user_id: string }> | null;
              error: { message: string } | null;
            };
            if (error) throw new BadRequestException(error.message);
            return data ?? [];
          },
        );
        const memberIds = Array.from(
          new Set(
            memberRows
              .map((row) => row.user_id)
              .filter((id): id is string => typeof id === 'string'),
          ),
        );

        const users = await this.fetchInChunks(memberIds, async (chunk) => {
          const { data, error } = (await this.client
            .from('users')
            .select('id, first_name, last_name, email')
            .in('id', chunk)) as {
            data: IDocumentUserLookup[] | null;
            error: { message: string } | null;
          };
          if (error) throw new BadRequestException(error.message);
          return data ?? [];
        });
        for (const user of users) {
          context.lookups.usersById[user.id] = user;
        }
      }
    }

    // Statuses / priorities are small per-org tables; fetching them org-wide
    // keeps a single query while covering both `status_id` uuid references
    // AND legacy `status` key references.
    if (needs.statuses && params.sourceEntity === 'tasks') {
      const { data, error } = (await this.client
        .from('task_statuses')
        .select('id, name, key, color')
        .eq('organization_id', organizationId)) as {
        data: IDocumentNamedLookup[] | null;
        error: { message: string } | null;
      };
      if (error) throw new BadRequestException(error.message);
      for (const row of data ?? []) {
        context.lookups.statusesById[row.id] = row;
        if (row.key) context.lookups.statusesById[row.key] ??= row;
      }
    }

    if (needs.priorities && params.sourceEntity === 'tasks') {
      const { data, error } = (await this.client
        .from('task_priorities')
        .select('id, name, key, color')
        .eq('organization_id', organizationId)) as {
        data: IDocumentNamedLookup[] | null;
        error: { message: string } | null;
      };
      if (error) throw new BadRequestException(error.message);
      for (const row of data ?? []) {
        context.lookups.prioritiesById[row.id] = row;
        if (row.key) context.lookups.prioritiesById[row.key] ??= row;
      }
    }

    if (needs.spaces) {
      const spaceIds = new Set<string>();
      for (const raw of allRaws) {
        const value = raw['space_id'];
        if (typeof value === 'string' && UUID_REGEX.test(value))
          spaceIds.add(value);
      }
      if (spaceIds.size > 0) {
        const spaces = await this.fetchInChunks(
          Array.from(spaceIds),
          async (chunk) => {
            const { data, error } = (await this.client
              .from('spaces')
              .select('id, name, key')
              .eq('organization_id', organizationId)
              .in('id', chunk)) as {
              data: IDocumentNamedLookup[] | null;
              error: { message: string } | null;
            };
            if (error) throw new BadRequestException(error.message);
            return data ?? [];
          },
        );
        for (const row of spaces) {
          context.lookups.spacesById[row.id] = row;
        }
      }
    }
  }
}

function numberOrMax(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : Number.MAX_SAFE_INTEGER;
}

/** Safe String() for an `unknown` row value — used as a dynamic_query join key, never as display text. */
function toComparableKey(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

function normalizeOptions(
  options: unknown,
): Array<{ value: string; label: string }> {
  if (!Array.isArray(options)) return [];
  const normalized: Array<{ value: string; label: string }> = [];
  for (const entry of options) {
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const value = record['value'];
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const label = record['label'];
      normalized.push({
        value: String(value),
        label: typeof label === 'string' ? label : String(value),
      });
    } else if (typeof entry === 'string') {
      normalized.push({ value: entry, label: entry });
    }
  }
  return normalized;
}
