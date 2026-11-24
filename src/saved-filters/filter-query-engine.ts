/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  isRelativeCutoff,
  resolveCutoff,
  resolveRelativeWindow,
} from '../common/utils/relative-date.util';
import {
  devFilterCondition,
  GIT_DEV_SELECT,
  isDevFilter,
} from '../git-integrations/git-dev-filter.util';
import { fetchLinkedTaskIds } from '../tasks/task-links.util';
import { enrichWithTaskTypes } from '../tasks/task-type-enrichment';

// ============================================================================
// Types
// ============================================================================

export interface IFilterRule {
  id?: string;
  field: string;
  operator: string;

  value: any;
  valueSource?: string;
}

export interface IFilterRuleGroup {
  id?: string;
  combinator: 'and' | 'or';
  rules: (IFilterRule | IFilterRuleGroup)[];
  not?: boolean;
}

export interface IFilterResultItem {
  id: string;
  entity_type: 'process' | 'task' | 'list_item' | 'wiki_page';
  key: string | null;
  title: string;
  status: string | null;
  priority: string | null;

  assigned_to: any;

  reporter: any;
  description: string | null;
  start_date: string | null;
  request_type: string | null;
  space_id: string | null;
  space_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  due_date: string | null;

  custom_field_values: Record<string, any>;

  _entity: Record<string, any>;
}

export interface IFilterExecutionResult {
  data: IFilterResultItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  executedAt: string;
}

interface ExecuteParams {
  query: IFilterRuleGroup;
  source_type: string;
  source_space_ids: string[];
  source_entity_types: string[];
  source_filter_id?: string | null;
  organizationId: string;
  userId: string;
  page: number;
  pageSize: number;
  sort?: { column: string; direction: string };
  fieldTypeMap?: Record<string, string>;
  permittedSpaceIdsByEntity?: Record<string, string[]>;
  permittedFilterIds?: string[];
  isOrgAdmin?: boolean;
  /** Adds the git computed fields to task rows (organizations with the Git integration licence only). */
  withDevelopment?: boolean;
}

interface TableConfig {
  tableName: string;
  selectColumns: string;
  spaceColumn: string;
  fieldMapping: Record<string, string>;
  /** Sort-only overrides of `fieldMapping` (filters keep using the plain column). */
  sortMapping?: Record<string, string>;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * In-memory sort for results merged across entity types. Natural order (`numeric`), so keys
 * sort by their number — DEFAULT-T2 before DEFAULT-T10 — as the database does via `key_number`.
 */
function sortResultsInMemory(
  results: IFilterResultItem[],
  sort: { column: string; direction: string },
): void {
  results.sort((a, b) => {
    const aVal = (a as Record<string, any>)[sort.column] ?? '';
    const bVal = (b as Record<string, any>)[sort.column] ?? '';
    const cmp = String(aVal).localeCompare(String(bVal), undefined, {
      numeric: true,
    });
    return sort.direction === 'desc' ? -cmp : cmp;
  });
}

const IMPOSSIBLE_UUID = '00000000-0000-0000-0000-000000000000';
/** PostgREST `max_rows` (supabase/config.toml): larger responses are silently cut. */
export const POSTGREST_MAX_ROWS = 1000;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOM_FIELD_KEY_REGEX = /^[A-Za-z0-9_]+$/;

function translateParentValue(
  value: any,
  resolvedParents?: Map<string, string | null>,
): string | string[] | null {
  if (!resolvedParents || value === null || value === undefined) return null;

  const lookup = (keyValue: any): string | null => {
    const key = String(keyValue).trim();
    if (!key) return null;
    if (UUID_REGEX.test(key)) return key;
    return resolvedParents.get(key) ?? null;
  };

  if (Array.isArray(value)) {
    const uuids = value.map(lookup).filter((id): id is string => Boolean(id));
    if (uuids.length === 0) return null;
    return uuids.length === 1 ? uuids[0] : uuids;
  }

  if (typeof value === 'string' && value.includes(',')) {
    const uuids = value
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean)
      .map(lookup)
      .filter((id): id is string => Boolean(id));

    if (uuids.length === 0) return null;
    return uuids.length === 1 ? uuids[0] : uuids;
  }

  return lookup(value);
}

interface ParentValueShape {
  keys: string[];
  recursive: boolean;
}

function parseParentValue(value: unknown): ParentValueShape | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'object' && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const recursive = objectValue.recursive === true;
    const rawKeys = objectValue.keys;
    const keys: string[] = [];

    if (Array.isArray(rawKeys)) {
      for (const key of rawKeys) {
        if (key == null) continue;
        const trimmed = String(key).trim();
        if (trimmed) keys.push(trimmed);
      }
    } else if (typeof rawKeys === 'string') {
      for (const key of rawKeys.split(',')) {
        const trimmed = key.trim();
        if (trimmed) keys.push(trimmed);
      }
    }

    if (keys.length === 0) return null;
    return { keys, recursive };
  }

  if (Array.isArray(value)) {
    const keys = value
      .map((key) => (key == null ? '' : String(key).trim()))
      .filter(Boolean);
    return keys.length > 0 ? { keys, recursive: false } : null;
  }

  if (typeof value === 'string') {
    const keys = value
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
    return keys.length > 0 ? { keys, recursive: false } : null;
  }

  return null;
}

function collectParentKeys(group: IFilterRuleGroup, acc: Set<string>): void {
  for (const rule of group.rules) {
    if ('combinator' in rule) {
      collectParentKeys(rule, acc);
      continue;
    }

    if (rule.field !== 'parent') continue;
    if (
      rule.operator === 'null' ||
      rule.operator === 'notNull' ||
      rule.operator === 'isEmpty' ||
      rule.operator === 'isNotEmpty'
    ) {
      continue;
    }

    const parsed = parseParentValue(rule.value);
    if (!parsed) continue;
    for (const key of parsed.keys) acc.add(key);
  }
}

/** Canonical form of an entity key: UUIDs lowercase (DB ids), issue keys uppercase. */
function normEntityKey(key: string): string {
  return UUID_REGEX.test(key) ? key.toLowerCase() : key.toUpperCase();
}

/** Keys named by any "Linked to" rule (same value shape as Parent; `recursive` ignored). */
function collectLinkedToKeys(group: IFilterRuleGroup, acc: Set<string>): void {
  for (const rule of group.rules) {
    if ('combinator' in rule) {
      collectLinkedToKeys(rule, acc);
      continue;
    }

    if (rule.field !== 'linked_to') continue;
    for (const key of parseParentValue(rule.value)?.keys ?? []) {
      acc.add(normEntityKey(key));
    }
  }
}

/** Ids of the tasks linked to any key of a "Linked to" rule value (deduped). */
function linkedIdsForRule(
  value: unknown,
  linkedTasks?: Map<string, Set<string>>,
): string[] {
  const ids = new Set<string>();
  for (const key of parseParentValue(value)?.keys ?? []) {
    for (const id of linkedTasks?.get(normEntityKey(key)) ?? []) ids.add(id);
  }
  return Array.from(ids);
}

/**
 * Ticket 10: the virtual tasks field `development` (`eq` / `in` / `neq` / `notIn` over DEV_FILTERS),
 * as `.or()`-syntax conditions on the git computed fields. Positive operators OR the conditions,
 * negating ones AND the negated conditions. Unknown values are dropped; any other operator
 * (null, contains, …) gets no conditions and so fails closed like an invalid value.
 */
function devRuleConditions(
  operator: string,
  value: unknown,
): { conditions: string[]; negate: boolean } {
  const negate = operator === 'neq' || operator === 'notIn';
  if (!negate && operator !== 'eq' && operator !== 'in') {
    return { conditions: [], negate };
  }
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',').map((v) => v.trim())
      : [];
  const values = [...new Set(raw.filter(isDevFilter))];

  return {
    conditions: values.map((v) => devFilterCondition(v, negate)),
    negate,
  };
}

function collectRecursiveParentKeys(
  group: IFilterRuleGroup,
  acc: Set<string>,
): void {
  for (const rule of group.rules) {
    if ('combinator' in rule) {
      collectRecursiveParentKeys(rule, acc);
      continue;
    }

    if (rule.field !== 'parent') continue;
    if (
      rule.operator === 'null' ||
      rule.operator === 'notNull' ||
      rule.operator === 'isEmpty' ||
      rule.operator === 'isNotEmpty'
    ) {
      continue;
    }

    const parsed = parseParentValue(rule.value);
    if (!parsed?.recursive) continue;
    for (const key of parsed.keys) acc.add(key);
  }
}

function normalizeToArray(value: any): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string')
    return value
      .split(',')
      .filter(Boolean)
      .map((v) => v.trim());
  return [];
}

function normalizeBetweenValue(value: any): [string, string] | null {
  if (Array.isArray(value) && value.length === 2)
    return [String(value[0]), String(value[1])];
  if (typeof value === 'string' && value.includes(',')) {
    const parts = value.split(',').map((v) => v.trim());
    if (parts.length === 2 && parts[0] !== '' && parts[1] !== '')
      return [parts[0], parts[1]];
  }
  return null;
}

function escapeIlikeValue(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function escapeFilterValue(val: string): string {
  if (typeof val !== 'string') return String(val);
  if (/[,.()"\\]/.test(val))
    return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return val;
}

function escapeOrIlikePattern(
  value: string,
  mode: 'contains' | 'beginsWith' | 'endsWith',
): string {
  const escapedValue = escapeIlikeValue(value);
  const pattern =
    mode === 'contains'
      ? `%${escapedValue}%`
      : mode === 'beginsWith'
        ? `${escapedValue}%`
        : `%${escapedValue}`;
  return escapeFilterValue(pattern);
}

function intersectIds(requested: string[], permitted: string[]): string[] {
  if (requested.length === 0) return [...new Set(permitted)];
  const allowed = new Set(permitted);
  return [...new Set(requested.filter((id) => allowed.has(id)))];
}

function normalizeEntityType(entityType: string): string | null {
  const aliases: Record<string, string> = {
    process: 'processes',
    processes: 'processes',
    task: 'tasks',
    tasks: 'tasks',
    list: 'lists',
    lists: 'lists',
    list_item: 'lists',
    asset_item: 'lists',
    wiki: 'wiki',
    wiki_page: 'wiki',
  };

  return aliases[entityType] ?? null;
}

function isAllowedCustomField(
  field: string,
  fieldTypeMap?: Record<string, string>,
): boolean {
  if (!field.startsWith('cf_')) return true;
  const fieldKey = field.slice(3);
  return (
    CUSTOM_FIELD_KEY_REGEX.test(fieldKey) && Boolean(fieldTypeMap?.[field])
  );
}

function normalizeEntityTypes(entityTypes: string[]): string[] {
  return [
    ...new Set(
      entityTypes
        .map((entityType) => normalizeEntityType(entityType))
        .filter((entityType): entityType is string => Boolean(entityType)),
    ),
  ];
}

// ============================================================================
// FilterQueryEngine
// ============================================================================

/**
 * Converts react-querybuilder JSON into Supabase PostgREST queries.
 * Handles AND/OR combinators, all operators, custom field JSONB queries,
 * relative dates, cross-entity execution, and result mapping.
 */
export class FilterQueryEngine {
  private supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  async execute(params: ExecuteParams): Promise<IFilterExecutionResult> {
    const { source_type, source_entity_types } = params;

    let entityTypes: string[] = [];

    if (source_type === 'spaces') {
      // Wiki pages are never mixed into the cross-entity 'spaces' fan-out —
      // they are only queried for dedicated source_type='wiki' filters.
      entityTypes = (
        source_entity_types.length > 0
          ? normalizeEntityTypes(source_entity_types)
          : ['processes', 'tasks', 'lists']
      ).filter((entityType) => entityType !== 'wiki');
    } else if (source_type === 'filter') {
      if (!params.source_filter_id) {
        return {
          data: [],
          total: 0,
          page: params.page,
          pageSize: params.pageSize,
          hasMore: false,
          executedAt: new Date().toISOString(),
        };
      }
      return this.executeSourceFilter(params, new Set<string>());
    } else {
      entityTypes = normalizeEntityTypes([source_type]);
    }

    // With exactly one entity type there is nothing to merge across, so the
    // database can do the paging and the JS slice below is skipped. With several,
    // each must be over-fetched in order to sort across them.
    const singleEntity = entityTypes.length === 1;

    const entityResults = await Promise.all(
      entityTypes.map(async (entityType) => {
        try {
          return await this.executeForEntityType(
            entityType,
            params,
            singleEntity,
          );
        } catch (error) {
          console.warn(
            `Filter execution failed for entity type "${entityType}":`,
            error,
          );

          return { data: [] as IFilterResultItem[], count: 0 };
        }
      }),
    );

    const results: IFilterResultItem[] = [];
    let totalCount = 0;

    for (const result of entityResults) {
      results.push(...result.data);
      totalCount += result.count;
    }

    // Merge sort across entity types. A single entity type was already ordered — and paged — by
    // the database (with its id tie-breaker and NULLs last); re-sorting that page here would
    // only scramble it (text order put DEFAULT-T10 before DEFAULT-T2). XE-T519.
    if (params.sort && !singleEntity) {
      sortResultsInMemory(results, params.sort);
    }

    const start = (params.page - 1) * params.pageSize;

    // In single-entity mode the server already returned exactly this page, so
    // slicing again would index past the end and hand back an EMPTY page for
    // every page after the first.
    const paginatedData = singleEntity
      ? results
      : results.slice(start, start + params.pageSize);

    return {
      data: paginatedData,
      total: totalCount,
      page: params.page,
      pageSize: params.pageSize,

      // Derived from what was actually returned, not from an assumed full page.
      // The old form reported `hasMore: true` even when the slice yielded nothing.
      hasMore: start + paginatedData.length < totalCount,
      executedAt: new Date().toISOString(),
    };
  }

  // ============================================================================
  // Sub-Filter Resolution
  // ============================================================================

  private async executeSourceFilter(
    params: ExecuteParams,
    visited: Set<string>,
  ): Promise<IFilterExecutionResult> {
    const sourceFilterId = params.source_filter_id!;

    if (visited.has(sourceFilterId)) {
      throw new Error('Circular filter reference detected');
    }
    if (visited.size >= 3) {
      throw new Error('Maximum filter nesting depth (3) exceeded');
    }

    visited.add(sourceFilterId);

    const { data: sourceFilter, error } = await this.supabase
      .from('saved_filters')
      .select('*')
      .eq('id', sourceFilterId)
      .eq('organization_id', params.organizationId)
      .single();

    if (error || !sourceFilter) {
      throw new Error('Source filter not found');
    }

    const canUseSource =
      sourceFilter.owner_id === params.userId ||
      sourceFilter.visibility === 'organization' ||
      (params.permittedFilterIds ?? []).includes(sourceFilterId);

    if (!canUseSource) {
      throw new Error('Source filter not found');
    }

    if (
      sourceFilter.source_type === 'filter' &&
      sourceFilter.source_filter_id
    ) {
      const combinedQuery: IFilterRuleGroup = {
        combinator: 'and',
        rules: [
          sourceFilter.query as IFilterRuleGroup,
          ...(params.query.rules.length > 0 ? [params.query] : []),
        ],
      };
      return this.executeSourceFilter(
        {
          ...params,
          query: combinedQuery,

          source_filter_id: sourceFilter.source_filter_id,
        },
        visited,
      );
    }

    let resolvedEntityTypes =
      sourceFilter.source_entity_types?.length > 0
        ? normalizeEntityTypes(sourceFilter.source_entity_types as string[])
        : sourceFilter.source_type === 'spaces'
          ? ['processes', 'tasks', 'lists']
          : normalizeEntityTypes([sourceFilter.source_type as string]);

    // Wiki never participates in the 'spaces' fan-out (see execute()).
    if (sourceFilter.source_type === 'spaces') {
      resolvedEntityTypes = resolvedEntityTypes.filter(
        (entityType) => entityType !== 'wiki',
      );
    }

    const combinedQuery: IFilterRuleGroup = {
      combinator: 'and',
      rules: [
        sourceFilter.query as IFilterRuleGroup,
        ...(params.query.rules.length > 0 ? [params.query] : []),
      ],
    };

    const resolvedParams: ExecuteParams = {
      ...params,
      query: combinedQuery,

      source_type:
        sourceFilter.source_type === 'spaces'
          ? 'spaces'
          : (sourceFilter.source_type as string),

      source_space_ids: sourceFilter.source_space_ids || [],
      source_entity_types: resolvedEntityTypes,
      source_filter_id: null,
    };

    const entityResults = await Promise.all(
      resolvedEntityTypes.map(async (entityType: string) => {
        try {
          return await this.executeForEntityType(entityType, resolvedParams);
        } catch (error) {
          console.warn(
            `Filter execution failed for entity type "${entityType}":`,
            error,
          );

          return { data: [] as IFilterResultItem[], count: 0 };
        }
      }),
    );

    const results: IFilterResultItem[] = [];
    let totalCount = 0;

    for (const result of entityResults) {
      results.push(...result.data);
      totalCount += result.count;
    }

    if (params.sort) {
      sortResultsInMemory(results, params.sort);
    }

    const start = (params.page - 1) * params.pageSize;
    const paginatedData = results.slice(start, start + params.pageSize);

    return {
      data: paginatedData,
      total: totalCount,
      page: params.page,
      pageSize: params.pageSize,
      hasMore: start + params.pageSize < totalCount,
      executedAt: new Date().toISOString(),
    };
  }

  // ============================================================================
  // Entity-Specific Query Execution
  // ============================================================================

  /**
   * @param exactPage When true, ask the server for EXACTLY the requested page via
   *   `.range()` instead of over-fetching `page * pageSize` rows and slicing in
   *   JS. Only valid when a single entity type is being queried — with several,
   *   the caller must over-fetch each in order to sort across them.
   */
  private async executeForEntityType(
    entityType: string,
    params: ExecuteParams,
    exactPage = false,
  ): Promise<{ data: IFilterResultItem[]; count: number }> {
    const { source_space_ids, organizationId } = params;
    let { query } = params;
    const tableConfig = this.getTableConfig(
      entityType,
      params.withDevelopment === true,
    );

    // Wiki labels live in a join table, not a column — pre-resolve label rules
    // to page-id rules before the main query is built (parent-key precedent).
    if (entityType === 'wiki') {
      query = await this.rewriteWikiLabelRules(query, organizationId);
    }
    const resolvedParents = await this.resolveParentKeysForEntity(
      query,
      entityType,
      organizationId,
    );
    const recursiveDescendants = await this.resolveDescendantIdsForEntity(
      query,
      entityType,
      organizationId,
      resolvedParents,
    );
    const linkedTasks = await this.resolveLinkedTasksForEntity(
      query,
      entityType,
      organizationId,
    );

    let scopedSpaceIds = source_space_ids;
    const permittedSpaceIds = params.permittedSpaceIdsByEntity?.[entityType];

    if (permittedSpaceIds) {
      scopedSpaceIds = intersectIds(source_space_ids, permittedSpaceIds);

      if (scopedSpaceIds.length === 0) {
        return { data: [], count: 0 };
      }
    }

    // A builder runs once when awaited, so deep over-fetches below need a fresh one per chunk.
    const buildQuery = () => {
      let supabaseQuery = this.supabase
        .from(tableConfig.tableName)
        .select(tableConfig.selectColumns, { count: 'exact' })
        .eq('organization_id', organizationId);

      if (scopedSpaceIds.length > 0) {
        supabaseQuery = supabaseQuery.in(
          tableConfig.spaceColumn,
          scopedSpaceIds,
        );
      }

      supabaseQuery = this.applyRuleGroup(
        supabaseQuery,
        query,
        tableConfig,
        params.userId,
        params.fieldTypeMap,
        resolvedParents,
        recursiveDescendants,
        linkedTasks,
      );

      if (params.sort) {
        const sortField = params.sort.column;
        const isUnmappedSort =
          !sortField.startsWith('cf_') && !tableConfig.fieldMapping[sortField];

        if (
          !isUnmappedSort &&
          isAllowedCustomField(sortField, params.fieldTypeMap)
        ) {
          let sortColumn =
            tableConfig.sortMapping?.[sortField] ||
            tableConfig.fieldMapping[sortField] ||
            sortField;
          if (sortField.startsWith('cf_')) {
            const cfKey = sortField.replace('cf_', '');
            sortColumn = `custom_field_values->>${cfKey}`;
          }

          // `id` breaks ties: without a unique last key, rows sharing the sorted value (every
          // "open" task) have no stable order, so pages overlap and some rows never appear. XE-T519.
          supabaseQuery = supabaseQuery
            .order(sortColumn, {
              ascending: params.sort.direction === 'asc',
            })
            .order('id', { ascending: true });
        }
      }

      return supabaseQuery;
    };

    // Pagination.
    //
    // The over-fetch-then-slice path below is only correct while
    // `page * pageSize` stays under PostgREST's row cap (1000). Past that the
    // server silently returns 1000, the caller slices beyond it, and the endpoint
    // returns an EMPTY page while still reporting `hasMore: true` — for 16,970
    // tasks that is every page past ~20. Nothing errors; the list just stops.
    //
    // With one entity type there is nothing to merge, so ask for the exact page
    // and let the database do the offsetting. Deep pages then work correctly and
    // we transfer one page instead of `page * pageSize` rows.
    //
    // Over-fetches past the cap (several entity types, deep pages, or an export) are read in
    // cap-sized ranges, ordered by `id` last so the chunks neither overlap nor skip rows.
    const overFetch = params.page * params.pageSize;
    let rows: Record<string, any>[] = [];
    let effectiveCount = 0;

    if (exactPage || overFetch <= POSTGREST_MAX_ROWS) {
      const from = (params.page - 1) * params.pageSize;
      const { data, error, count } = exactPage
        ? await buildQuery().range(from, from + params.pageSize - 1)
        : await buildQuery().limit(overFetch);

      if (error) throw error;
      rows = (data || []) as Record<string, any>[];
      effectiveCount = count || 0;
    } else {
      for (let from = 0; from < overFetch; from += POSTGREST_MAX_ROWS) {
        const to = Math.min(from + POSTGREST_MAX_ROWS, overFetch) - 1;
        const { data, error, count } = await buildQuery()
          .order('id', { ascending: true })
          .range(from, to);

        if (error) throw error;
        rows.push(...((data || []) as Record<string, any>[]));
        effectiveCount = count || 0;
        if (rows.length <= to) break;
      }
    }

    if (entityType === 'wiki') {
      const visible = await this.filterWikiRestrictedRows(
        rows,
        organizationId,
        params.userId,
        params.isOrgAdmin === true,
      );

      // The DB count includes restricted rows; subtract the ones hidden on
      // this page so pagination does not overshoot (best-effort).
      effectiveCount = Math.max(
        0,
        effectiveCount - (rows.length - visible.length),
      );
      rows = visible;
    }

    // `task_type` is not a column — it is synthesized from
    // `task_hierarchy_configurations`. Normal task reads enrich it; this engine did not, so
    // every surface fed by a saved view (the custom task list and its tree, and the dashboard
    // table widget) rendered a dash in the Type column. XE-T587.
    if (entityType === 'tasks' && rows.length > 0) {
      rows = await this.enrichWithTaskTypes(rows, organizationId);
    }

    const mapped = rows.map((row) => this.mapToResultItem(row, entityType));

    return { data: mapped, count: effectiveCount };
  }

  /** Attach a resolved `task_type` object to each task row (XE-T587); shared with dashboards. */
  private async enrichWithTaskTypes(
    rows: Record<string, any>[],
    organizationId: string,
  ): Promise<Record<string, any>[]> {
    return enrichWithTaskTypes(this.supabase, rows, organizationId);
  }

  private async resolveParentKeysForEntity(
    group: IFilterRuleGroup,
    entityType: string,
    organizationId: string,
  ): Promise<Map<string, string | null>> {
    const keys = new Set<string>();
    collectParentKeys(group, keys);

    return this.resolveEntityKeysToIds(keys, entityType, organizationId);
  }

  /** Issue keys → ids (UUID inputs map to themselves); unknown keys are absent. */
  private async resolveEntityKeysToIds(
    keys: Set<string>,
    entityType: string,
    organizationId: string,
  ): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    if (keys.size === 0) return map;

    const uuidInputs: string[] = [];
    const keyInputs: string[] = [];

    for (const key of keys) {
      if (UUID_REGEX.test(key)) uuidInputs.push(key);
      else keyInputs.push(key);
    }

    for (const id of uuidInputs) map.set(id, id);
    if (keyInputs.length === 0) return map;

    const table =
      entityType === 'tasks'
        ? 'tasks'
        : entityType === 'processes'
          ? 'business_processes'
          : null;
    if (!table) return map;

    const { data, error } = await this.supabase
      .from(table)
      .select('id, key')
      .eq('organization_id', organizationId)
      .in('key', keyInputs);

    if (error) {
      console.warn(
        'Entity key resolution failed for entity type',
        entityType,
        error,
      );
      return map;
    }

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      if (row['key'] && row['id'])
        map.set(String(row['key'] as string), String(row['id'] as string));
    }

    return map;
  }

  /**
   * "Linked to" pre-resolution (XE-T532, tasks only): each rule key → the ids of
   * the tasks linked to it in either direction. Keys are normalized (see
   * `normEntityKey`); unknown keys are absent, so their rules match nothing.
   */
  private async resolveLinkedTasksForEntity(
    group: IFilterRuleGroup,
    entityType: string,
    organizationId: string,
  ): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    if (entityType !== 'tasks') return result;

    const keys = new Set<string>();
    collectLinkedToKeys(group, keys);
    if (keys.size === 0) return result;

    const idByKey = await this.resolveEntityKeysToIds(
      keys,
      entityType,
      organizationId,
    );
    const ids = [...new Set(idByKey.values())].filter((id): id is string =>
      Boolean(id),
    );
    const linkedById = await fetchLinkedTaskIds(
      this.supabase,
      organizationId,
      ids,
    );

    for (const [key, id] of idByKey) {
      const linked = id ? linkedById.get(id) : undefined;
      if (linked) result.set(key, linked);
    }

    return result;
  }

  private async resolveDescendantIdsForEntity(
    group: IFilterRuleGroup,
    entityType: string,
    organizationId: string,
    resolvedParents: Map<string, string | null>,
  ): Promise<{ descendantIds: Set<string>; hasRecursiveRule: boolean }> {
    const empty = { descendantIds: new Set<string>(), hasRecursiveRule: false };
    const rpcName =
      entityType === 'tasks'
        ? 'get_task_descendant_ids'
        : entityType === 'processes'
          ? 'get_process_descendant_ids'
          : null;

    if (!rpcName) return empty;

    const recursiveKeys = new Set<string>();
    collectRecursiveParentKeys(group, recursiveKeys);
    if (recursiveKeys.size === 0) return empty;

    const rootUuids = new Set<string>();
    for (const key of recursiveKeys) {
      if (UUID_REGEX.test(key)) {
        rootUuids.add(key);
        continue;
      }

      const mapped = resolvedParents.get(key);
      if (mapped) rootUuids.add(mapped);
    }

    if (rootUuids.size === 0) {
      return { descendantIds: new Set<string>(), hasRecursiveRule: true };
    }

    try {
      const { data, error } = await this.supabase.rpc(rpcName, {
        p_root_ids: Array.from(rootUuids),
        p_organization_id: organizationId,
      });

      if (error) {
        console.warn(
          `[FilterQueryEngine] Descendant RPC '${rpcName}' failed; falling back to direct-parent filtering`,
          error,
        );
        return empty;
      }

      const ids = new Set<string>();
      if (Array.isArray(data)) {
        for (const id of data) {
          if (id) ids.add(String(id));
        }
      }

      return { descendantIds: ids, hasRecursiveRule: true };
    } catch (error) {
      console.warn(
        `[FilterQueryEngine] Descendant RPC '${rpcName}' threw; falling back to direct-parent filtering`,
        error,
      );
      return empty;
    }
  }

  // ============================================================================
  // Wiki Label Pre-Resolution
  // ============================================================================

  /**
   * Wiki labels are relational (`wiki_page_labels.page_id` + `label_id` →
   * `wiki_labels`), so `labels` rules cannot be translated to a column filter.
   * Mirroring the descendant pre-resolution precedent, this resolves each
   * `labels` rule to the set of matching page ids up-front and rewrites the
   * rule to `id in (...)` / `id not in (...)`. The returned group is a new
   * object — the caller's query tree is never mutated (it is shared across
   * entity types).
   */
  private async rewriteWikiLabelRules(
    group: IFilterRuleGroup,
    organizationId: string,
  ): Promise<IFilterRuleGroup> {
    const labelIds = new Set<string>();
    let needsAnyLabeled = false;

    const collect = (g: IFilterRuleGroup): void => {
      for (const rule of g.rules) {
        if ('combinator' in rule) {
          collect(rule);
          continue;
        }

        if (rule.field !== 'labels') continue;
        if (
          rule.operator === 'null' ||
          rule.operator === 'notNull' ||
          rule.operator === 'isEmpty' ||
          rule.operator === 'isNotEmpty'
        ) {
          needsAnyLabeled = true;
          continue;
        }

        for (const labelId of normalizeToArray(rule.value)) {
          labelIds.add(labelId);
        }
      }
    };

    collect(group);
    if (labelIds.size === 0 && !needsAnyLabeled) return group;

    // wiki_page_labels has no organization_id column — scope explicitly
    // through the wiki_pages join (single FK, unambiguous embed).
    const pageIdsByLabel = new Map<string, Set<string>>();

    if (labelIds.size > 0) {
      const { data, error } = await this.supabase
        .from('wiki_page_labels')
        .select('page_id, label_id, page:wiki_pages!inner(organization_id)')
        .in('label_id', Array.from(labelIds))
        .eq('page.organization_id', organizationId);

      if (error) throw error;

      for (const row of (data ?? []) as Record<string, any>[]) {
        const labelId = String(row.label_id);
        if (!pageIdsByLabel.has(labelId)) {
          pageIdsByLabel.set(labelId, new Set<string>());
        }
        pageIdsByLabel.get(labelId)!.add(String(row.page_id));
      }
    }

    let anyLabeledPageIds = new Set<string>();

    if (needsAnyLabeled) {
      const { data, error } = await this.supabase
        .from('wiki_page_labels')
        .select('page_id, page:wiki_pages!inner(organization_id)')
        .eq('page.organization_id', organizationId);

      if (error) throw error;
      anyLabeledPageIds = new Set(
        ((data ?? []) as Record<string, any>[]).map((row) =>
          String(row.page_id),
        ),
      );
    }

    const rewriteGroup = (g: IFilterRuleGroup): IFilterRuleGroup => ({
      ...g,
      rules: g.rules.map((rule) => {
        if ('combinator' in rule) return rewriteGroup(rule);
        if (rule.field !== 'labels') return rule;

        const { operator } = rule;

        // "has no labels" → NOT IN all labeled pages; empty set = no-op (all
        // pages pass), which is the correct semantics.
        if (operator === 'null' || operator === 'isEmpty') {
          return {
            ...rule,
            field: 'id',
            operator: 'notIn',
            value: Array.from(anyLabeledPageIds),
          };
        }

        // "has any label" → IN all labeled pages; empty set short-circuits to
        // the impossible-uuid filter via the `in` operator.
        if (operator === 'notNull' || operator === 'isNotEmpty') {
          return {
            ...rule,
            field: 'id',
            operator: 'in',
            value: Array.from(anyLabeledPageIds),
          };
        }

        const pageIds = new Set<string>();
        for (const labelId of normalizeToArray(rule.value)) {
          for (const pageId of pageIdsByLabel.get(labelId) ?? []) {
            pageIds.add(pageId);
          }
        }

        const isNegating =
          operator === 'neq' ||
          operator === 'notIn' ||
          operator === 'notContains';

        return {
          ...rule,
          field: 'id',
          operator: isNegating ? 'notIn' : 'in',
          value: Array.from(pageIds),
        };
      }),
    });

    return rewriteGroup(group);
  }

  // ============================================================================
  // Wiki ACL Post-Filter
  // ============================================================================

  /**
   * Conservative visibility filter for wiki rows: pages carrying custom
   * permissions (own `has_custom_permissions` flag, own `wiki_page_permissions`
   * rows, or ANY ancestor in `path` with such rows — inherited restrictions do
   * not flag descendants) are hidden unless the requester created the page or
   * is an org admin/owner. This deliberately errs on the side of NOT leaking:
   * a user holding an explicit grant still won't see the page here.
   *
   * TODO(wiki2): route through WikiPermissionsService for exact ACL once
   * module boundaries allow.
   */
  private async filterWikiRestrictedRows(
    rows: Record<string, any>[],
    organizationId: string,
    userId: string,
    isOrgAdmin: boolean,
  ): Promise<Record<string, any>[]> {
    if (rows.length === 0 || isOrgAdmin) return rows;

    // Candidate ids = every page id + every ancestor id from `path`.
    const candidateIds = new Set<string>();

    for (const row of rows) {
      if (row.id) candidateIds.add(String(row.id));
      for (const ancestorId of (row.path as string[] | null | undefined) ??
        []) {
        if (ancestorId) candidateIds.add(String(ancestorId));
      }
    }

    let restrictedIds = new Set<string>();

    if (candidateIds.size > 0) {
      // wiki_page_permissions has no organization_id column — scope through
      // the wiki_pages join (disambiguated: the table has two FKs to
      // wiki_pages). The candidate ids themselves already come from the
      // org-scoped main query.
      const { data, error } = await this.supabase
        .from('wiki_page_permissions')
        .select(
          'wiki_page_id, page:wiki_pages!wiki_page_permissions_wiki_page_id_fkey!inner(organization_id)',
        )
        .in('wiki_page_id', Array.from(candidateIds))
        .eq('page.organization_id', organizationId);

      if (error) throw error;
      restrictedIds = new Set(
        ((data ?? []) as Record<string, any>[]).map((row) =>
          String(row.wiki_page_id),
        ),
      );
    }

    return rows.filter((row) => {
      // Creators keep visibility of their own restricted pages.
      if (row.created_by && String(row.created_by) === userId) return true;

      if (row.has_custom_permissions === true) return false;
      if (restrictedIds.has(String(row.id))) return false;

      for (const ancestorId of (row.path as string[] | null | undefined) ??
        []) {
        if (restrictedIds.has(String(ancestorId))) return false;
      }

      return true;
    });
  }

  // ============================================================================
  // Table Configuration
  // ============================================================================

  private getTableConfig(
    entityType: string,
    withDevelopment = false,
  ): TableConfig {
    switch (entityType) {
      case 'processes':
        return {
          tableName: 'business_processes',
          selectColumns:
            '*, space:spaces!space_id(id, name, key), assigned_to_user:users!business_processes_assigned_to_fkey(id, first_name, last_name, email, avatar_url)',
          spaceColumn: 'space_id',
          fieldMapping: {
            title: 'title',
            status: 'status',
            key: 'key',
            created_at: 'created_at',
            updated_at: 'updated_at',
            created_by: 'created_by',
            request_type: 'request_type',
            hierarchy_level_id: 'hierarchy_level_id',
            parent: 'parent_id',
            custom_field_values: 'custom_field_values',
          },
        };
      case 'tasks':
        return {
          tableName: 'tasks',
          // GIT_DEV_SELECT: computed fields (never part of `*`) for the Development columns (ticket 10); a
          // lookup per row, so only with the Git integration licence.
          selectColumns:
            // status_config: the real status row, so list chips match the task detail view (XE-T637).
            // email on the assignee: the CSV export prints name or email.
            '*, space:spaces!space_id(id, name, key), assigned_to_user:users!tasks_assigned_to_fkey(id, first_name, last_name, email, avatar_url), reporter_user:users!tasks_reporter_fkey(id, first_name, last_name, avatar_url), status_config:task_statuses!tasks_status_id_fkey(id,name,key,color,icon,is_completed,sort_order)' +
            (withDevelopment ? `, ${GIT_DEV_SELECT}` : ''),
          spaceColumn: 'space_id',
          fieldMapping: {
            title: 'summary',
            status: 'status',
            priority: 'priority',
            key: 'key',
            assigned_to: 'assigned_to',
            reporter: 'reporter',
            due_date: 'due_date',
            start_date: 'start_date',
            created_at: 'created_at',
            updated_at: 'updated_at',
            created_by: 'created_by',
            task_type_id: 'task_type_id',
            status_id: 'status_id',
            priority_id: 'priority_id',
            labels: 'labels',
            parent: 'parent_task_id',
            linked_to: 'id',
            custom_field_values: 'custom_field_values',
          },
          // "DEFAULT-T12" sorts as text (T10 before T2); sort by its number — the `key_number`
          // PostgREST computed field (migration 20260922120000_task_key_number). XE-T519.
          sortMapping: { key: 'key_number' },
        };
      case 'lists':
        return {
          tableName: 'asset_items',
          selectColumns:
            '*, schema:asset_schemas!schema_id(id, name, key, space_id, space:spaces!space_id(id, name, key))',
          spaceColumn: 'space_id',
          fieldMapping: {
            title: 'title',
            created_at: 'created_at',
            updated_at: 'updated_at',
            created_by: 'created_by',
            fields_data: 'fields_data',
            custom_field_values: 'custom_field_values',
          },
        };
      case 'wiki':
        // NOTE: `*` must keep exposing `path` and `has_custom_permissions` —
        // the ACL post-filter (filterWikiRestrictedRows) reads both. `labels`
        // is deliberately NOT mapped: label rules are pre-resolved into `id`
        // rules by rewriteWikiLabelRules, and any leftover label rule fails
        // closed through the field allowlist. `id` is mapped for the rewrites.
        return {
          tableName: 'wiki_pages',
          selectColumns:
            '*, space:spaces!space_id(id, name, key), created_by_user:users!wiki_pages_created_by_fkey(id, first_name, last_name, avatar_url)',
          spaceColumn: 'space_id',
          fieldMapping: {
            id: 'id',
            title: 'title',
            status: 'workflow_status',
            workflow_status: 'workflow_status',
            slug: 'slug',
            created_at: 'created_at',
            updated_at: 'updated_at',
            published_at: 'published_at',
            created_by: 'created_by',
            updated_by: 'updated_by',
            is_published: 'is_published',
            is_archived: 'is_archived',
            parent: 'parent_id',
            content_format: 'content_format',
            custom_field_values: 'custom_field_values',
          },
        };
      default:
        throw new Error(`Unknown entity type: ${entityType}`);
    }
  }

  // ============================================================================
  // Applying Rule Groups (AND/OR)
  // ============================================================================

  private applyRuleGroup(
    query: any,
    group: IFilterRuleGroup,
    tableConfig: TableConfig,
    userId: string,
    fieldTypeMap?: Record<string, string>,
    resolvedParents?: Map<string, string | null>,
    recursiveDescendants?: {
      descendantIds: Set<string>;
      hasRecursiveRule: boolean;
    },
    linkedTasks?: Map<string, Set<string>>,
  ): any {
    if (group.rules.length === 0) return query;

    if (group.combinator === 'and') {
      if (group.not) {
        const filterStr = this.buildFilterString(
          group,
          tableConfig,
          userId,
          fieldTypeMap,
          resolvedParents,
          recursiveDescendants,
          linkedTasks,
        );
        if (filterStr) {
          query = query.or(`not.and(${filterStr})`);
        }
        return query;
      }

      for (const rule of group.rules) {
        if ('combinator' in rule) {
          const nestedGroup = rule;
          if (nestedGroup.combinator === 'or') {
            const filterStr = this.buildFilterString(
              nestedGroup,
              tableConfig,
              userId,
              fieldTypeMap,
              resolvedParents,
              recursiveDescendants,
              linkedTasks,
            );
            if (filterStr) {
              const prefix = nestedGroup.not ? 'not.' : '';

              query = query.or(`${prefix}or(${filterStr})`);
            }
          } else {
            if (nestedGroup.not) {
              const filterStr = this.buildFilterString(
                nestedGroup,
                tableConfig,
                userId,
                fieldTypeMap,
                resolvedParents,
                recursiveDescendants,
                linkedTasks,
              );
              if (filterStr) {
                query = query.or(`not.and(${filterStr})`);
              }
            } else {
              query = this.applyRuleGroup(
                query,
                nestedGroup,
                tableConfig,
                userId,
                fieldTypeMap,
                resolvedParents,
                recursiveDescendants,
                linkedTasks,
              );
            }
          }
        } else {
          query = this.applyRule(
            query,
            rule,
            tableConfig,
            userId,
            fieldTypeMap,
            resolvedParents,
            recursiveDescendants,
            linkedTasks,
          );
        }
      }
    } else {
      const filterStr = this.buildFilterString(
        group,
        tableConfig,
        userId,
        fieldTypeMap,
        resolvedParents,
        recursiveDescendants,
        linkedTasks,
      );
      if (filterStr) {
        query = group.not
          ? query.or(`not.or(${filterStr})`)
          : query.or(filterStr);
      }
    }

    return query;
  }

  // ============================================================================
  // Direct Rule Application (for AND chains)
  // ============================================================================

  private applyRule(
    query: any,
    rule: IFilterRule,
    tableConfig: TableConfig,
    userId: string,
    fieldTypeMap?: Record<string, string>,
    resolvedParents?: Map<string, string | null>,
    recursiveDescendants?: {
      descendantIds: Set<string>;
      hasRecursiveRule: boolean;
    },
    linkedTasks?: Map<string, Set<string>>,
  ): any {
    const { field, operator } = rule;
    let { value } = rule;

    // Virtual field, not a column: rewritten onto the git computed fields (ticket 10).
    if (field === 'development' && tableConfig.tableName === 'tasks') {
      const { conditions, negate } = devRuleConditions(operator, value);

      if (conditions.length === 0) {
        return negate ? query : query.eq('id', IMPOSSIBLE_UUID);
      }

      if (!negate) return query.or(conditions.join(','));
      for (const condition of conditions) query = query.or(condition);
      return query;
    }

    if (
      (!field.startsWith('cf_') && !tableConfig.fieldMapping[field]) ||
      !isAllowedCustomField(field, fieldTypeMap)
    ) {
      return query.eq('id', IMPOSSIBLE_UUID);
    }

    if (
      field === 'parent' &&
      operator !== 'null' &&
      operator !== 'notNull' &&
      operator !== 'isEmpty' &&
      operator !== 'isNotEmpty'
    ) {
      const isNegating = operator === 'neq' || operator === 'notIn';
      const parsedParent = parseParentValue(value);

      if (!parsedParent) {
        return isNegating ? query : query.eq('id', IMPOSSIBLE_UUID);
      }

      if (parsedParent.recursive) {
        const ids = recursiveDescendants?.descendantIds;
        if (!ids || ids.size === 0) {
          return isNegating ? query : query.eq('id', IMPOSSIBLE_UUID);
        }

        return isNegating
          ? query.not('id', 'in', `(${Array.from(ids).join(',')})`)
          : query.in('id', Array.from(ids));
      }

      const translated = translateParentValue(
        parsedParent.keys,
        resolvedParents,
      );
      if (translated === null) {
        return isNegating ? query : query.eq('id', IMPOSSIBLE_UUID);
      }

      value = translated;
    }

    // "Linked to" (XE-T532): links were pre-resolved to ids in executeForEntityType.
    if (
      field === 'linked_to' &&
      operator !== 'null' &&
      operator !== 'notNull' &&
      operator !== 'isEmpty' &&
      operator !== 'isNotEmpty'
    ) {
      const isNegating = operator === 'neq' || operator === 'notIn';
      const ids = linkedIdsForRule(value, linkedTasks);

      if (ids.length === 0) {
        return isNegating ? query : query.eq('id', IMPOSSIBLE_UUID);
      }

      return isNegating
        ? query.not('id', 'in', `(${ids.join(',')})`)
        : query.in('id', ids);
    }

    // --- JSONB label-bag handling ------------------------------------------------------------
    // `labels` is a jsonb ARRAY: the scalar dispatch below compares the whole document
    // (`labels.eq.regression`), which can never match a bag like ["regression","billing"].
    // Membership needs PostgREST `cs` (jsonb containment); ANY-of needs an or() of single-value
    // containments because `ov` (overlaps) only exists for native array columns.
    if (field === 'labels' && tableConfig.fieldMapping[field] === 'labels') {
      const applied = this.applyJsonbArrayRule(
        query,
        'labels',
        operator,
        value,
      );

      if (applied !== null) return applied;
    }

    // Issue group values are jsonb arrays of option ids, the same shape as `labels` above.
    if (fieldTypeMap?.[field] === 'issue_group') {
      const applied = this.applyJsonbArrayRule(
        query,
        `custom_field_values->${field.slice(3)}`,
        operator,
        value,
      );

      if (applied !== null) return applied;
    }

    const column = this.resolveColumn(field, tableConfig, operator);

    if (value === null || value === undefined) {
      if (operator === 'null' || operator === 'isEmpty')
        return query.is(column, null);

      if (operator === 'notNull' || operator === 'isNotEmpty')
        return query.not(column, 'is', null);

      if (operator === 'currentUser') return query.eq(column, userId);
      if (operator === 'relative') return query;

      if (operator === 'eq') return query.is(column, null);

      if (operator === 'neq') return query.not(column, 'is', null);
      return query;
    }

    switch (operator) {
      case 'eq': {
        if (Array.isArray(value)) {
          const arr = value.filter(Boolean);
          if (arr.length === 0) return query;

          if (arr.length === 1) return query.eq(column, arr[0]);

          return query.in(column, arr);
        }
        if (typeof value === 'string' && value.includes(',')) {
          const arr = normalizeToArray(value);

          if (arr.length > 1) return query.in(column, arr);
        }

        return query.eq(column, value);
      }
      case 'neq': {
        if (Array.isArray(value)) {
          const arr = value.filter(Boolean);
          if (arr.length === 0) return query;

          if (arr.length === 1) return query.neq(column, arr[0]);

          return query.not(
            column,
            'in',
            `(${arr.map(escapeFilterValue).join(',')})`,
          );
        }
        if (typeof value === 'string' && value.includes(',')) {
          const arr = normalizeToArray(value);

          if (arr.length > 1)
            return query.not(
              column,
              'in',
              `(${arr.map(escapeFilterValue).join(',')})`,
            );
        }

        return query.neq(column, value);
      }
      case 'contains':
        return query.ilike(column, `%${escapeIlikeValue(String(value))}%`);
      case 'notContains':
        return query.not(
          column,
          'ilike',
          `%${escapeIlikeValue(String(value))}%`,
        );
      case 'beginsWith':
        return query.ilike(column, `${escapeIlikeValue(String(value))}%`);
      case 'endsWith':
        return query.ilike(column, `%${escapeIlikeValue(String(value))}`);
      case 'gt':
        return query.gt(column, value);
      case 'gte':
        return query.gte(column, value);
      case 'lt':
        return query.lt(column, value);
      case 'lte':
        return query.lte(column, value);
      case 'between': {
        const range = normalizeBetweenValue(value);

        if (range) return query.gte(column, range[0]).lte(column, range[1]);
        return query;
      }
      case 'notBetween': {
        const range = normalizeBetweenValue(value);
        if (range)
          return query.or(
            `${column}.lt.${escapeFilterValue(range[0])},${column}.gt.${escapeFilterValue(range[1])}`,
          );
        return query;
      }
      case 'in': {
        const arr = normalizeToArray(value);

        if (arr.length === 0) return query.eq('id', IMPOSSIBLE_UUID);

        return query.in(column, arr);
      }
      case 'notIn': {
        const arr = normalizeToArray(value);
        if (arr.length === 0) return query;

        return query.not(
          column,
          'in',
          `(${arr.map(escapeFilterValue).join(',')})`,
        );
      }
      case 'null':
        return query.is(column, null);
      case 'notNull':
        return query.not(column, 'is', null);
      case 'isEmpty':
        return query.or(`${column}.is.null,${column}.eq.`);
      case 'isNotEmpty':
        return query.not(column, 'is', null).neq(column, '');
      case 'currentUser':
        return query.eq(column, userId);
      case 'relative':
        return this.applyRelativeDateDirect(query, column, value);
      default:
        return query;
    }
  }

  // ============================================================================
  // Building Filter Strings for .or()
  // ============================================================================

  private buildFilterString(
    group: IFilterRuleGroup,
    tableConfig: TableConfig,
    userId: string,
    fieldTypeMap?: Record<string, string>,
    resolvedParents?: Map<string, string | null>,
    recursiveDescendants?: {
      descendantIds: Set<string>;
      hasRecursiveRule: boolean;
    },
    linkedTasks?: Map<string, Set<string>>,
  ): string {
    const conditions: string[] = [];

    for (const rule of group.rules) {
      if ('combinator' in rule) {
        const nested = this.buildFilterString(
          rule,
          tableConfig,
          userId,
          fieldTypeMap,
          resolvedParents,
          recursiveDescendants,
          linkedTasks,
        );
        if (nested && nested.length > 0) {
          const nestedGroup = rule;
          const prefix = nestedGroup.not ? 'not.' : '';
          conditions.push(`${prefix}${nestedGroup.combinator}(${nested})`);
        }
      } else {
        const condition = this.ruleToFilterString(
          rule,
          tableConfig,
          userId,
          fieldTypeMap,
          resolvedParents,
          recursiveDescendants,
          linkedTasks,
        );
        if (condition) conditions.push(condition);
      }
    }

    return conditions.join(',');
  }

  private ruleToFilterString(
    rule: IFilterRule,
    tableConfig: TableConfig,
    userId: string,
    fieldTypeMap?: Record<string, string>,
    resolvedParents?: Map<string, string | null>,
    recursiveDescendants?: {
      descendantIds: Set<string>;
      hasRecursiveRule: boolean;
    },
    linkedTasks?: Map<string, Set<string>>,
  ): string | null {
    const { field, operator } = rule;
    let { value } = rule;

    // "Development" — as in applyRule; "match everything" is a real tautology here (see linked_to).
    if (field === 'development' && tableConfig.tableName === 'tasks') {
      const { conditions, negate } = devRuleConditions(operator, value);

      if (conditions.length === 0) {
        return negate ? 'id.not.is.null' : `id.eq.${IMPOSSIBLE_UUID}`;
      }
      if (conditions.length === 1) return conditions[0];

      return `${negate ? 'and' : 'or'}(${conditions.join(',')})`;
    }

    if (
      (!field.startsWith('cf_') && !tableConfig.fieldMapping[field]) ||
      !isAllowedCustomField(field, fieldTypeMap)
    ) {
      return `id.eq.${IMPOSSIBLE_UUID}`;
    }

    if (
      field === 'parent' &&
      operator !== 'null' &&
      operator !== 'notNull' &&
      operator !== 'isEmpty' &&
      operator !== 'isNotEmpty'
    ) {
      const isNegating = operator === 'neq' || operator === 'notIn';
      const parsedParent = parseParentValue(value);

      if (!parsedParent) {
        return isNegating ? null : `id.eq.${IMPOSSIBLE_UUID}`;
      }

      if (parsedParent.recursive) {
        const ids = recursiveDescendants?.descendantIds;
        if (!ids || ids.size === 0) {
          return isNegating ? null : `id.eq.${IMPOSSIBLE_UUID}`;
        }

        const inList = Array.from(ids).join(',');
        return isNegating ? `not.id.in.(${inList})` : `id.in.(${inList})`;
      }

      const translated = translateParentValue(
        parsedParent.keys,
        resolvedParents,
      );
      if (translated === null) {
        return isNegating ? null : `id.eq.${IMPOSSIBLE_UUID}`;
      }

      value = translated;
    }

    // "Linked to" — as in applyRule, but "match everything" must be a real
    // tautology: a null fragment is dropped, which is wrong inside OR / NOT groups.
    // Negations use `col.not.op` — PostgREST allows a leading `not.` only before
    // and/or inside a logic tree (`not.id.in.(…)` there is a 400 PGRST100).
    if (
      field === 'linked_to' &&
      operator !== 'null' &&
      operator !== 'notNull' &&
      operator !== 'isEmpty' &&
      operator !== 'isNotEmpty'
    ) {
      const isNegating = operator === 'neq' || operator === 'notIn';
      const ids = linkedIdsForRule(value, linkedTasks);

      if (ids.length === 0) {
        return isNegating ? 'id.not.is.null' : `id.eq.${IMPOSSIBLE_UUID}`;
      }

      const inList = ids.join(',');
      return isNegating ? `id.not.in.(${inList})` : `id.in.(${inList})`;
    }

    // JSONB label-bag handling — see `applyJsonbArrayRule` for why scalar dispatch cannot work.
    if (field === 'labels' && tableConfig.fieldMapping[field] === 'labels') {
      const fragment = this.jsonbArrayFragment('labels', operator, value);

      if (fragment !== null) return fragment;
    }

    if (fieldTypeMap?.[field] === 'issue_group') {
      const fragment = this.jsonbArrayFragment(
        `custom_field_values->${field.slice(3)}`,
        operator,
        value,
      );

      if (fragment !== null) return fragment;
    }

    const column = this.resolveColumn(field, tableConfig, operator);

    if (value === null || value === undefined) {
      if (operator === 'null' || operator === 'isEmpty')
        return `${column}.is.null`;
      if (operator === 'notNull' || operator === 'isNotEmpty')
        return `not.${column}.is.null`;
      if (operator === 'currentUser') return `${column}.eq.${userId}`;
      if (operator === 'eq') return `${column}.is.null`;
      if (operator === 'neq') return `not.${column}.is.null`;
      return null;
    }

    switch (operator) {
      case 'eq': {
        if (Array.isArray(value)) {
          const arr = value.filter(Boolean);
          if (arr.length === 0) return null;
          if (arr.length === 1)
            return `${column}.eq.${escapeFilterValue(String(arr[0]))}`;
          return `${column}.in.(${arr.map((v) => escapeFilterValue(String(v))).join(',')})`;
        }
        if (typeof value === 'string' && value.includes(',')) {
          const arr = normalizeToArray(value);
          if (arr.length > 1)
            return `${column}.in.(${arr.map(escapeFilterValue).join(',')})`;
        }
        return `${column}.eq.${escapeFilterValue(String(value))}`;
      }
      case 'neq': {
        if (typeof value === 'string' && value.includes(',')) {
          const arr = normalizeToArray(value);
          if (arr.length > 1)
            return `not.${column}.in.(${arr.map(escapeFilterValue).join(',')})`;
        }
        return `${column}.neq.${escapeFilterValue(String(value))}`;
      }
      case 'contains':
        return `${column}.ilike.${escapeOrIlikePattern(String(value), 'contains')}`;
      case 'notContains':
        return `not.${column}.ilike.${escapeOrIlikePattern(String(value), 'contains')}`;
      case 'beginsWith':
        return `${column}.ilike.${escapeOrIlikePattern(String(value), 'beginsWith')}`;
      case 'endsWith':
        return `${column}.ilike.${escapeOrIlikePattern(String(value), 'endsWith')}`;
      case 'gt':
        return `${column}.gt.${escapeFilterValue(String(value))}`;
      case 'gte':
        return `${column}.gte.${escapeFilterValue(String(value))}`;
      case 'lt':
        return `${column}.lt.${escapeFilterValue(String(value))}`;
      case 'lte':
        return `${column}.lte.${escapeFilterValue(String(value))}`;
      case 'between': {
        const range = normalizeBetweenValue(value);
        if (range)
          return `and(${column}.gte.${escapeFilterValue(range[0])},${column}.lte.${escapeFilterValue(range[1])})`;
        return null;
      }
      case 'notBetween': {
        const range = normalizeBetweenValue(value);
        if (range)
          return `or(${column}.lt.${escapeFilterValue(range[0])},${column}.gt.${escapeFilterValue(range[1])})`;
        return null;
      }
      case 'in': {
        const arr = normalizeToArray(value);
        if (arr.length === 0) return `id.eq.${IMPOSSIBLE_UUID}`;
        return `${column}.in.(${arr.map(escapeFilterValue).join(',')})`;
      }
      case 'notIn': {
        const arr = normalizeToArray(value);
        if (arr.length === 0) return null;
        return `not.${column}.in.(${arr.map(escapeFilterValue).join(',')})`;
      }
      case 'null':
        return `${column}.is.null`;
      case 'notNull':
        return `not.${column}.is.null`;
      case 'isEmpty':
        return `or(${column}.is.null,${column}.eq.)`;
      case 'isNotEmpty':
        return `and(not.${column}.is.null,${column}.neq.)`;
      case 'currentUser':
        return `${column}.eq.${userId}`;
      case 'relative':
        return this.resolveRelativeDate(column, value);
      default:
        return null;
    }
  }

  // ============================================================================
  // Column Resolution
  // ============================================================================

  private resolveColumn(
    field: string,
    tableConfig: TableConfig,
    operator?: string,
  ): string {
    const isCustomField = field.startsWith('cf_');
    if (isCustomField) {
      const fieldKey = field.replace('cf_', '');
      void operator;
      return `custom_field_values->>${fieldKey}`;
    }
    return tableConfig.fieldMapping[field] || field;
  }

  // ============================================================================
  // Relative Date Handling
  // ============================================================================

  /** One label value → the jsonb containment literal `["value"]` used with PostgREST `cs`. */
  private jsonbSingleton(v: unknown): string {
    return JSON.stringify([String(v)]);
  }

  /** Rule values normalized to the list of label strings they name. */
  private jsonbArrayValues(value: unknown): string[] {
    const arr = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',')
        : [value];

    return arr.map((v) => String(v ?? '').trim()).filter(Boolean);
  }

  /**
   * Membership dispatch for jsonb array columns (AND chains). Returns null to fall through to the
   * legacy scalar path — unknown operators and labels containing a comma (which would corrupt the
   * or() fragment syntax) keep their historic behaviour rather than guessing.
   */
  private applyJsonbArrayRule(
    query: any,
    column: string,
    operator: string,
    value: unknown,
    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- `any` is the query-builder type; null is the fall-through sentinel
  ): any | null {
    if (operator === 'null' || operator === 'isEmpty') {
      return query.or(`${column}.is.null,${column}.eq.[]`);
    }

    if (operator === 'notNull' || operator === 'isNotEmpty') {
      return query.not(column, 'is', null).neq(column, '[]');
    }

    const values = this.jsonbArrayValues(value);

    if (values.length === 0 || values.some((v) => v.includes(','))) return null;

    switch (operator) {
      case 'eq':
      case 'in':
      case 'contains': {
        if (values.length === 1)
          return query.contains(column, this.jsonbSingleton(values[0]));

        // ANY-of: `ov` only exists for native arrays, so OR the single-value containments.
        return query.or(
          values.map((v) => `${column}.cs.${this.jsonbSingleton(v)}`).join(','),
        );
      }

      case 'neq':
      case 'notIn':
      case 'notContains': {
        for (const v of values) {
          query = query.not(column, 'cs', this.jsonbSingleton(v));
        }

        return query;
      }

      default:
        return null;
    }
  }

  /** The or()-context twin of `applyJsonbArrayRule`; null falls through to the scalar path. */
  private jsonbArrayFragment(
    column: string,
    operator: string,
    value: unknown,
  ): string | null {
    if (operator === 'null' || operator === 'isEmpty') {
      return `or(${column}.is.null,${column}.eq.[])`;
    }

    if (operator === 'notNull' || operator === 'isNotEmpty') {
      return `and(not.${column}.is.null,${column}.neq.[])`;
    }

    const values = this.jsonbArrayValues(value);

    if (values.length === 0 || values.some((v) => v.includes(','))) return null;

    switch (operator) {
      case 'eq':
      case 'in':
      case 'contains': {
        if (values.length === 1)
          return `${column}.cs.${this.jsonbSingleton(values[0])}`;

        return `or(${values.map((v) => `${column}.cs.${this.jsonbSingleton(v)}`).join(',')})`;
      }

      case 'neq':
      case 'notIn':
      case 'notContains':
        return `and(${values.map((v) => `not.${column}.cs.${this.jsonbSingleton(v)}`).join(',')})`;

      default:
        return null;
    }
  }

  private resolveRelativeDate(column: string, value: unknown): string | null {
    if (isRelativeCutoff(value)) {
      const at = resolveCutoff(value).toISOString();

      switch (value.op) {
        case 'gt':
          return `${column}.gt.${at}`;
        case 'gte':
          return `${column}.gte.${at}`;
        case 'lt':
          return `${column}.lt.${at}`;
        case 'lte':
          return `${column}.lte.${at}`;
        default:
          return null;
      }
    }

    if (typeof value !== 'string') return null;

    const olderThanNDays = /^older_than_(\d+)_days$/.exec(value);

    if (olderThanNDays) {
      const cutoff = new Date(
        Date.now() - Number(olderThanNDays[1]) * 86400000,
      );

      return `${column}.lt.${cutoff.toISOString()}`;
    }

    const window = resolveRelativeWindow(value);

    if (!window) return null;

    const gte = window.start
      ? `${column}.gte.${window.start.toISOString()}`
      : null;
    const lt = window.end ? `${column}.lt.${window.end.toISOString()}` : null;

    if (gte && lt) return `and(${gte},${lt})`;

    return gte ?? lt;
  }

  private applyRelativeDateDirect(
    query: any,
    column: string,
    value: unknown,
  ): any {
    if (isRelativeCutoff(value)) {
      const at = resolveCutoff(value).toISOString();

      switch (value.op) {
        case 'gt':
          return query.gt(column, at);
        case 'gte':
          return query.gte(column, at);
        case 'lt':
          return query.lt(column, at);
        case 'lte':
          return query.lte(column, at);
        default:
          return query;
      }
    }

    if (typeof value !== 'string') return query;

    const olderThanNDays = /^older_than_(\d+)_days$/.exec(value);

    if (olderThanNDays) {
      const cutoff = new Date(
        Date.now() - Number(olderThanNDays[1]) * 86400000,
      );

      return query.lt(column, cutoff.toISOString());
    }

    const window = resolveRelativeWindow(value);

    if (!window) return query;

    if (window.start) query = query.gte(column, window.start.toISOString());
    if (window.end) query = query.lt(column, window.end.toISOString());

    return query;
  }

  // ============================================================================
  // Result Mapping
  // ============================================================================

  private mapToResultItem(
    row: Record<string, any>,
    entityType: string,
  ): IFilterResultItem {
    let resultEntityType: 'process' | 'task' | 'list_item' | 'wiki_page';

    switch (entityType) {
      case 'processes':
        resultEntityType = 'process';
        break;
      case 'tasks':
        resultEntityType = 'task';
        break;
      case 'lists':
        resultEntityType = 'list_item';
        break;
      case 'wiki':
        resultEntityType = 'wiki_page';
        break;
      default:
        resultEntityType = 'process';
    }

    let spaceId: string | null = null;
    let spaceName: string | null = null;

    if (entityType === 'lists') {
      spaceId = row.space_id || row.schema?.space_id || null;

      spaceName = row.schema?.space?.name || null;
    } else {
      spaceId = row.space?.id || row.space_id || null;

      spaceName = row.space?.name || null;
    }

    // Wiki pages have no `key` column — the slug is the human-readable
    // identifier; their status is the review workflow status.
    const key =
      entityType === 'lists'
        ? null
        : entityType === 'wiki'
          ? (row.slug as string | null) || null
          : (row.key as string | null) || null;
    const status =
      entityType === 'wiki'
        ? (row.workflow_status as string | null) || null
        : (row.status as string | null) || null;

    return {
      id: row.id as string,
      entity_type: resultEntityType,
      key,

      title:
        entityType === 'tasks'
          ? (row.summary as string)
          : (row.title as string),
      status,
      priority: (row.priority as string | null) || null,

      assigned_to: row.assigned_to_user || row.assigned_to || null,

      reporter: row.reporter_user || row.reporter || null,
      description: (row.description as string | null) || null,
      start_date: (row.start_date as string | null) || null,

      // Processes carry a real `request_type` column. Tasks do not — fall back to the resolved
      // task type, preferring its display name over the raw id. XE-T587.
      request_type:
        (row.request_type as string | null) ||
        ((row.task_type as { name?: string } | null)?.name ?? null) ||
        (row.task_type_id as string | null) ||
        null,
      space_id: spaceId,
      space_name: spaceName,
      created_at: (row.created_at as string | null) || null,
      updated_at: (row.updated_at as string | null) || null,
      due_date: (row.due_date as string | null) || null,

      custom_field_values:
        (row.custom_field_values as Record<string, unknown>) || {},
      _entity: row,
    };
  }
}
