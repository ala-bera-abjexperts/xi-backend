/**
 * @fileoverview Dashboards service — CRUD for dashboards, widgets, permissions,
 * widget data fetching (saved_filter / custom_query / simple modes), and
 * analytics (risk summary, heatmap).
 * @module src/dashboards/dashboards.service
 */

import { SlaReportService } from '../sla/sla-report.service';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  fetchAllRows,
  AGGREGATE_MAX_ROWS,
} from '../common/utils/fetch-all-rows';
import { SavedFiltersService } from '../saved-filters/saved-filters.service';
import { SprintsService } from '../sprints/sprints.service';
import {
  buildVelocityBars,
  orderStartedSprints,
  pickVelocitySprint,
  previousVelocityAverage,
  velocityWindow,
  type VelocitySprint,
} from './velocity-chart.util';
import { PermissionsService } from '../permissions/permissions.service';
import type { ExecuteFilterDto } from '../saved-filters/dto/execute-filter.dto';
import type { CreateDashboardDto } from './dto/create-dashboard.dto';
import type { UpdateDashboardDto } from './dto/update-dashboard.dto';
import type { CreateWidgetDto } from './dto/create-widget.dto';
import type { UpdateWidgetDto } from './dto/update-widget.dto';
import type { UpdateLayoutDto } from './dto/update-layout.dto';
import type { CreatePermissionDto } from './dto/create-permission.dto';
import type { UpdatePermissionDto } from './dto/update-permission.dto';
import {
  ResourcePlanningReportService,
  type ResourcePlanningReportQueryDto,
  type ResourcePlanningReport,
} from '../resource-planning/reporting';
import { normalizeResourcePlanningReportQuery } from '../resource-planning/reporting/resource-planning-report.engine';
import { enrichWithTaskTypes } from '../tasks/task-type-enrichment';
import { EntitlementsService } from '../licensing/entitlements.service';
import {
  developmentSpaceIds,
  spaceRepositoryIds,
} from '../git-integrations/git-integrations.util';

/** Ticket 10 (D4): the `metric` setting of a `git_development` widget. */
const GIT_DEV_METRICS = [
  'in_progress_without_pr',
  'failing_builds_by_space',
  'merged_this_week',
] as const;
type GitDevMetric = (typeof GIT_DEV_METRICS)[number];

const USER_FIELD_MAP: Record<string, string> = {
  assigned_to: 'assigned_to_user',
  reporter: 'reporter_user',
};

// Nobody assigned reads as "Unassigned"; the old label stays a key so saved colours still match.
const UNASSIGNED = 'Unassigned';
const UNASSIGNED_KEYS = ['Unknown'];

// List chart group-by values are `list:<columnId>`, read from asset_items.fields_data.
const LIST_FIELD_PREFIX = 'list:';

// Labels of the fixed list status / priority options (frontend DEFAULT_*_OPTIONS).
const LIST_STATUS_LABELS: Record<string, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
};
const LIST_PRIORITY_LABELS: Record<string, string> = {
  highest: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  lowest: 'Lowest',
};

// A list field's type (column cellType, custom field_type or legacy type) and its option labels.
type ListFieldInfo = { type?: string; options?: Map<string, string> };

const LIST_USER_TYPES = new Set(['user', 'user_select']);

function listCellLabel(
  field: ListFieldInfo | undefined,
  value: unknown,
  userNames: Map<string, string>,
): string {
  const type = field?.type;

  if (type && LIST_USER_TYPES.has(type)) {
    return typeof value === 'string' && value
      ? (userNames.get(value) ?? value)
      : UNASSIGNED;
  }
  if (type === 'checkbox' || type === 'boolean') {
    return value === true || value === 'true' ? 'Yes' : 'No';
  }
  if (value === null || value === undefined || value === '') return 'Unknown';

  const text = typeof value === 'string' ? value : JSON.stringify(value);

  if (type === 'status') return LIST_STATUS_LABELS[text] ?? text;
  if (type === 'priority') return LIST_PRIORITY_LABELS[text] ?? text;

  return field?.options?.get(text) ?? text;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : []) as Record<string, unknown>[];
}

// Custom-field values win over the legacy fields_data copy.
function listCell(item: Record<string, unknown>, key: string): unknown {
  return (
    (item['custom_field_values'] as Record<string, unknown> | null)?.[key] ??
    (item['fields_data'] as Record<string, unknown> | null)?.[key]
  );
}

function resolveFieldValue(
  record: Record<string, unknown>,
  field: string,
): string {
  const userKey = USER_FIELD_MAP[field];

  if (userKey && record[userKey]) {
    const user = record[userKey] as Record<string, unknown>;
    const name = [user['first_name'], user['last_name']]
      .filter(Boolean)
      .join(' ')
      .trim();

    return name || (user['email'] as string) || 'Unknown';
  }

  const value = record[field];
  if (value === null || value === undefined)
    return field === 'assigned_to' ? UNASSIGNED : 'Unknown';

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj['first_name'] || obj['last_name']) {
      return (
        [obj['first_name'], obj['last_name']]
          .filter(Boolean)
          .join(' ')
          .trim() || 'Unknown'
      );
    }
    if (obj['name'])
      return typeof obj['name'] === 'string'
        ? obj['name']
        : (JSON.stringify(obj['name']) ?? 'Unknown');
    if (obj['title'])
      return typeof obj['title'] === 'string'
        ? obj['title']
        : (JSON.stringify(obj['title']) ?? 'Unknown');
    if (obj['label'])
      return typeof obj['label'] === 'string'
        ? obj['label']
        : (JSON.stringify(obj['label']) ?? 'Unknown');
    return 'Unknown';
  }

  const str = (
    typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  ).trim();
  return str || 'Unknown';
}

function aggregateFilterResults(
  rows: Record<string, unknown>[],
  groupByField: string,
): Array<{ name: string; value: number; keys?: string[] }> {
  const groups: Record<string, number> = {};

  for (const row of rows) {
    const key = resolveFieldValue(row, groupByField);
    groups[key] = (groups[key] ?? 0) + 1;
  }

  return Object.entries(groups)
    .map(([name, value]) =>
      groupByField === 'assigned_to' && name === UNASSIGNED
        ? { name, value, keys: UNASSIGNED_KEYS }
        : { name, value },
    )
    .sort((a, b) => b.value - a.value);
}

function aggregateMultiSeries(
  rows: Record<string, unknown>[],
  xField: string,
  segmentField: string,
): {
  data: Record<string, unknown>[];
  segments: string[];
  segmentKeys?: Record<string, string[]>;
} {
  const xValues = [
    ...new Set(rows.map((row) => resolveFieldValue(row, xField))),
  ];
  const segmentValues = [
    ...new Set(rows.map((row) => resolveFieldValue(row, segmentField))),
  ];

  const data = xValues.map((xValue) => {
    const result: Record<string, unknown> = { name: xValue };
    for (const segmentValue of segmentValues) {
      result[segmentValue] = rows.filter(
        (row) =>
          resolveFieldValue(row, xField) === xValue &&
          resolveFieldValue(row, segmentField) === segmentValue,
      ).length;
    }
    return result;
  });

  return segmentField === 'assigned_to' && segmentValues.includes(UNASSIGNED)
    ? {
        data,
        segments: segmentValues,
        segmentKeys: { [UNASSIGNED]: UNASSIGNED_KEYS },
      }
    : { data, segments: segmentValues };
}

// Group-by fields whose chart labels are resolved names rather than raw keys.
const LABELLED_CHART_FIELDS = new Set(['task_type', 'status', 'priority']);

// Non-task rows grouped by task type are labelled by item kind, not 'Unknown'.
const ITEM_KIND_LABELS: Record<string, string> = {
  process: 'Process',
  list_item: 'List item',
  wiki_page: 'Wiki page',
};

// Per-row raw values the labels replaced, keyed by field.
const RAW_CHART_KEYS = '_rawChartKeys';

function needsChartLabels(xField: string, segmentField?: string): boolean {
  return (
    LABELLED_CHART_FIELDS.has(xField) ||
    (!!segmentField && LABELLED_CHART_FIELDS.has(segmentField))
  );
}

// Raw values merged into each label, so colours saved against old raw labels still match.
function rawKeysByLabel(
  rows: Record<string, unknown>[],
  field: string,
): Map<string, string[]> {
  const byLabel = new Map<string, Set<string>>();

  for (const row of rows) {
    const raw = (row[RAW_CHART_KEYS] as Record<string, string> | undefined)?.[
      field
    ];
    const label = resolveFieldValue(row, field);
    if (!raw || raw === label) continue;

    const keys = byLabel.get(label) ?? new Set<string>();
    keys.add(raw);
    byLabel.set(label, keys);
  }

  return new Map([...byLabel].map(([label, keys]) => [label, [...keys]]));
}

function aggregateLabelledResults(
  rows: Record<string, unknown>[],
  groupByField: string,
): Array<{ name: string; value: number; keys?: string[] }> {
  const keys = rawKeysByLabel(rows, groupByField);

  return aggregateFilterResults(rows, groupByField).map((item) =>
    keys.has(item.name) ? { ...item, keys: keys.get(item.name) } : item,
  );
}

function aggregateLabelledMultiSeries(
  rows: Record<string, unknown>[],
  xField: string,
  segmentField: string,
): {
  data: Record<string, unknown>[];
  segments: string[];
  segmentKeys?: Record<string, string[]>;
} {
  const multi = aggregateMultiSeries(rows, xField, segmentField);
  const segmentKeys = rawKeysByLabel(rows, segmentField);

  return segmentKeys.size > 0
    ? { ...multi, segmentKeys: Object.fromEntries(segmentKeys) }
    : multi;
}

function getFilterResultSpaceId(row: Record<string, unknown>): string | null {
  const directSpaceId = row['space_id'] ?? row['spaceId'];
  if (typeof directSpaceId === 'string') return directSpaceId;

  const space = row['space'];
  if (space && typeof space === 'object') {
    const nestedSpaceId = (space as Record<string, unknown>)['id'];
    if (typeof nestedSpaceId === 'string') return nestedSpaceId;
  }

  const entity = row['_entity'];
  if (entity && typeof entity === 'object') {
    return getFilterResultSpaceId(entity as Record<string, unknown>);
  }

  return null;
}

function filterRowsToSpace(
  rows: Record<string, unknown>[],
  spaceId?: string,
): Record<string, unknown>[] {
  if (!spaceId) return rows;

  return rows.filter((row) => getFilterResultSpaceId(row) === spaceId);
}

type DashboardAccessLevel = 'view' | 'edit' | 'manage' | 'delete';

const DASHBOARD_PERMISSION_RANK: Record<string, number> = {
  view: 1,
  edit: 2,
  manage: 3,
};

const REQUIRED_DASHBOARD_PERMISSION_RANK: Record<DashboardAccessLevel, number> =
  {
    view: 1,
    edit: 2,
    manage: 3,
    delete: 3,
  };

interface DashboardAccessContext {
  isAdmin: boolean;
  baseRole: string | null;
  roleIds: Set<string>;
  groupIds: Set<string>;
  orgPermissionCache: Map<string, boolean>;
  spacePermissionCache: Map<string, Record<string, boolean> | null>;
}

@Injectable()
export class DashboardsService {
  private static readonly TABLE = 'dashboards';
  private static readonly WIDGETS_TABLE = 'dashboard_widgets';
  private static readonly PERMISSIONS_TABLE = 'dashboard_permissions';
  private static readonly FILTER_TARGETS_TABLE =
    'dashboard_filter_widget_targets';
  private static readonly ACTIVITY_TABLE = 'dashboard_activity_log';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly savedFiltersService: SavedFiltersService,
    private readonly permissionsService: PermissionsService,
    private readonly resourcePlanningReportService: ResourcePlanningReportService,
    private readonly slaReportService: SlaReportService,
    private readonly entitlementsService: EntitlementsService,
    private readonly sprintsService: SprintsService,
  ) {}

  private resourcePlanningWidgetQuery(
    config: Record<string, unknown>,
  ): Partial<ResourcePlanningReportQueryDto> {
    const groupBy = config['groupBy'];
    const bucket = config['bucket'];
    const groupId = config['groupId'];
    const includeArchived = config['includeArchived'];
    const allowedGroups = new Set(['user', 'unit', 'plan', 'portfolio']);
    const allowedBuckets = new Set(['week', 'month']);
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (groupBy !== undefined) {
      if (typeof groupBy !== 'string' || !allowedGroups.has(groupBy)) {
        throw new BadRequestException('Invalid resource planning group');
      }
    }
    if (bucket !== undefined) {
      if (typeof bucket !== 'string' || !allowedBuckets.has(bucket)) {
        throw new BadRequestException('Invalid resource planning bucket');
      }
    }
    if (
      groupId !== undefined &&
      groupId !== null &&
      (typeof groupId !== 'string' || !uuidPattern.test(groupId))
    ) {
      throw new BadRequestException('Invalid resource planning group ID');
    }
    if (includeArchived !== undefined && typeof includeArchived !== 'boolean') {
      throw new BadRequestException('Invalid resource planning archive filter');
    }

    const optionalDate = (key: 'dateFrom' | 'dateTo') => {
      const value = config[key];
      if (value === undefined || value === null || value === '')
        return undefined;
      if (typeof value !== 'string') {
        throw new BadRequestException('Invalid resource planning date');
      }
      return value;
    };

    return {
      from: optionalDate('dateFrom'),
      to: optionalDate('dateTo'),
      bucket: (bucket as ResourcePlanningReportQueryDto['bucket']) ?? 'week',
      group_by:
        (groupBy as ResourcePlanningReportQueryDto['group_by']) ?? 'user',
      ...(typeof groupId === 'string' && groupId ? { group_id: groupId } : {}),
      include_archived: includeArchived === true,
    };
  }

  /**
   * Page a saved-filter / ad-hoc execution until exhausted, for CHART widgets.
   *
   * Charts aggregate the returned rows in JavaScript, so a single capped page
   * silently charts a SUBSET: "tasks by status" over 16,970 tasks was computed
   * from 500 rows. Tables are different — they legitimately display one page —
   * so this is used only on the chart path.
   *
   * Bounded twice on purpose. `AGGREGATE_MAX_ROWS` stops a pathological filter
   * from pulling unbounded data into memory, and `MAX_PAGES` stops the loop
   * itself: multi-entity filters still over-fetch `page * pageSize` server-side
   * in order to sort across entities, so deep paging there is quadratic. Single
   * entity filters page properly server-side (see FilterQueryEngine.execute), so
   * the common case is linear.
   */
  private async fetchAllFilterRowsForChart(
    executePage: (
      page: number,
      pageSize: number,
    ) => Promise<{ data: { data?: unknown[]; hasMore?: boolean } }>,
  ): Promise<Record<string, unknown>[]> {
    const PAGE_SIZE = 1000;
    const MAX_PAGES = 20;

    const collected: Record<string, unknown>[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await executePage(page, PAGE_SIZE);
      const batch = (result.data.data ?? []) as Record<string, unknown>[];

      collected.push(...batch);

      const exhausted = result.data.hasMore !== true || batch.length === 0;

      if (exhausted || collected.length >= AGGREGATE_MAX_ROWS) break;
    }

    return collected;
  }

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Shallow copies of list items with each grouped `list:<columnId>` field set to its display label. */
  /** Type and option labels per list field key: columns, then linked custom fields, then legacy definitions. */
  private async loadListFieldInfo(
    list: Record<string, unknown>,
    organizationId: string,
  ): Promise<Map<string, ListFieldInfo>> {
    const info = new Map<string, ListFieldInfo>();
    const add = (key: unknown, entry: ListFieldInfo) => {
      if (typeof key === 'string' && key && !info.has(key))
        info.set(key, entry);
    };

    for (const column of asRecords(list['column_config'])) {
      add(column['columnId'], { type: column['cellType'] as string });
    }

    // Labels are cosmetic; without the links values still group by their raw option value.
    const { data: links } = await this.client
      .from('asset_schema_custom_fields')
      .select(
        'custom_field:custom_fields(field_key, field_type, options, is_active)',
      )
      .eq('schema_id', list['id'] as string)
      .eq('organization_id', organizationId);
    for (const link of asRecords(links)) {
      const field = link['custom_field'] as Record<string, unknown> | null;
      if (!field || field['is_active'] === false) continue;

      const options = new Map<string, string>();
      for (const option of asRecords(field['options'])) {
        if (typeof option['value'] !== 'string') continue;
        options.set(
          option['value'],
          typeof option['label'] === 'string'
            ? option['label']
            : option['value'],
        );
      }
      add(field['field_key'], { type: field['field_type'] as string, options });
    }

    for (const definition of asRecords(list['fields_definition'])) {
      add(definition['key'], { type: definition['type'] as string });
    }

    return info;
  }

  private async labelListItemsForChart(
    items: Record<string, unknown>[],
    fieldInfo: Map<string, ListFieldInfo>,
    fields: string[],
  ): Promise<Record<string, unknown>[]> {
    const columnIds = fields
      .filter((field) => field.startsWith(LIST_FIELD_PREFIX))
      .map((field) => field.slice(LIST_FIELD_PREFIX.length));
    if (columnIds.length === 0) return items;

    const cell = listCell;

    // User cells hold user ids; load the names once.
    const userIds = new Set<string>();
    for (const columnId of columnIds) {
      const type = fieldInfo.get(columnId)?.type;
      if (!type || !LIST_USER_TYPES.has(type)) continue;
      for (const item of items) {
        const value = cell(item, columnId);
        if (typeof value === 'string' && value) userIds.add(value);
      }
    }

    const userNames = new Map<string, string>();
    if (userIds.size > 0) {
      const { data } = await this.client
        .from('users')
        .select('id, first_name, last_name, email')
        .in('id', [...userIds]);
      for (const user of (data ?? []) as Record<string, unknown>[]) {
        const name = [user['first_name'], user['last_name']]
          .filter(Boolean)
          .join(' ')
          .trim();
        userNames.set(
          user['id'] as string,
          name || (user['email'] as string) || 'Unknown',
        );
      }
    }

    return items.map((item) => {
      const copy: Record<string, unknown> = { ...item };
      for (const columnId of columnIds) {
        copy[`${LIST_FIELD_PREFIX}${columnId}`] = listCellLabel(
          fieldInfo.get(columnId),
          cell(item, columnId),
          userNames,
        );
      }
      return copy;
    });
  }

  /** Chart data grouped by resolved task type / status / priority names. */
  private async labelledChartData(
    rows: Record<string, unknown>[],
    organizationId: string,
    groupByField: string,
    segmentBy: string | undefined,
    mode: 'task' | 'filter',
  ): Promise<{
    data: unknown[];
    segments?: string[];
    segmentKeys?: Record<string, string[]>;
  }> {
    const labelled = await this.labelRowsForChart(
      rows,
      organizationId,
      segmentBy ? [groupByField, segmentBy] : [groupByField],
      mode,
    );

    return segmentBy
      ? aggregateLabelledMultiSeries(labelled, groupByField, segmentBy)
      : { data: aggregateLabelledResults(labelled, groupByField) };
  }

  /**
   * Shallow copies of `rows` with task type / status / priority names written
   * into the grouped fields. Non-task rows keep their raw status/priority.
   */
  private async labelRowsForChart(
    rows: Record<string, unknown>[],
    organizationId: string,
    fields: string[],
    mode: 'task' | 'filter',
  ): Promise<Record<string, unknown>[]> {
    const wanted = fields.filter((field) => LABELLED_CHART_FIELDS.has(field));
    if (wanted.length === 0 || rows.length === 0) return rows;

    try {
      // Filter rows carry the raw (already type-enriched) task under `_entity`.
      const sources: Record<string, unknown>[] =
        mode === 'filter'
          ? rows.map(
              (row) => (row['_entity'] ?? row) as Record<string, unknown>,
            )
          : wanted.includes('task_type')
            ? await enrichWithTaskTypes(this.client, rows, organizationId)
            : rows;
      const [statusName, priorityName] = await Promise.all([
        wanted.includes('status')
          ? this.loadNameLookup('task_statuses', organizationId)
          : null,
        wanted.includes('priority')
          ? this.loadNameLookup('task_priorities', organizationId)
          : null,
      ]);

      return rows.map((row, i) => {
        const source = sources[i];
        const isTask = mode === 'task' || row['entity_type'] === 'task';
        const copy: Record<string, unknown> = { ...row };
        const raw: Record<string, string> = {};

        for (const field of wanted) {
          if (field === 'task_type') {
            const kind = row['entity_type'] as string;
            const typeId = source['task_type_id'] as string | null | undefined;
            const typeName = (
              source['task_type'] as { name?: string } | null | undefined
            )?.name;

            if (!isTask) {
              copy[field] = ITEM_KIND_LABELS[kind] ?? kind;
              raw[field] = kind;
              continue;
            }

            // Capitalized id mirrors enrichWithTaskTypes when it had no config to read.
            copy[field] =
              typeName ??
              (typeId
                ? typeId.charAt(0).toUpperCase() + typeId.slice(1)
                : null);
            if (typeId) raw[field] = typeId;
            continue;
          }

          if (!isTask) continue;

          const key = (row[field] as string | null | undefined) ?? null;
          const lookup = field === 'status' ? statusName : priorityName;
          const resolved = lookup?.(
            source[`${field}_id`],
            key,
            source['space_id'] ?? row['space_id'],
          );
          copy[field] = resolved?.name ?? key;
          // The key actually used, so a stale text key can't borrow another slice's saved colour.
          const usedKey = resolved?.key ?? key;
          if (usedKey) raw[field] = usedKey;
        }

        copy[RAW_CHART_KEYS] = raw;

        return copy;
      });
    } catch (err) {
      // Labels are cosmetic; never fail the chart over a lookup.
      console.warn('[DashboardsService.labelRowsForChart] raw labels:', err);

      if (!wanted.includes('task_type')) return rows;

      // Raw rows have no `task_type` field — without this every task would fall into "Unknown".
      return rows.map((row) => {
        const kind = row['entity_type'] as string;
        const source = (
          mode === 'filter' ? (row['_entity'] ?? row) : row
        ) as Record<string, unknown>;
        const typeId = source['task_type_id'] as string | null | undefined;
        const typeName = (
          source['task_type'] as { name?: string } | null | undefined
        )?.name;

        if (mode === 'filter' && kind !== 'task') {
          return { ...row, task_type: ITEM_KIND_LABELS[kind] ?? kind };
        }

        return {
          ...row,
          task_type:
            typeName ??
            (typeId ? typeId.charAt(0).toUpperCase() + typeId.slice(1) : null),
        };
      });
    }
  }

  /** Name for a status/priority: by id, else key in the task's space, else org-level key. */
  private async loadNameLookup(
    table: 'task_statuses' | 'task_priorities',
    organizationId: string,
  ): Promise<
    (
      id: unknown,
      key: string | null,
      spaceId: unknown,
    ) => { name: string; key: string } | null
  > {
    const { rows } = await fetchAllRows<{
      id: string;
      key: string;
      name: string;
      space_id: string | null;
    }>(
      (from, to) =>
        this.client
          .from(table)
          .select('id, key, name, space_id')
          .eq('organization_id', organizationId)
          .order('id', { ascending: true })
          .range(from, to) as never,
    );
    // Keep the matched row's key: the task's own text key can be stale when an id is set.
    const byId = new Map(
      rows.map((row) => [row.id, { name: row.name, key: row.key }]),
    );
    // Org-level rows (space_id null) sit under an empty space prefix.
    const byKey = new Map(
      rows.map((row) => [
        `${row.space_id ?? ''}:${row.key}`,
        { name: row.name, key: row.key },
      ]),
    );

    return (id, key, spaceId) =>
      (typeof id === 'string' ? byId.get(id) : undefined) ??
      (key
        ? (byKey.get(`${typeof spaceId === 'string' ? spaceId : ''}:${key}`) ??
          byKey.get(`:${key}`))
        : undefined) ??
      null;
  }

  private dashboardPermissionAllows(
    permissionLevel: string | null | undefined,
    level: DashboardAccessLevel,
  ): boolean {
    if (!permissionLevel) return false;
    return (
      (DASHBOARD_PERMISSION_RANK[permissionLevel] ?? 0) >=
      REQUIRED_DASHBOARD_PERMISSION_RANK[level]
    );
  }

  private async getAccessContext(
    userId: string,
    organizationId: string,
  ): Promise<DashboardAccessContext> {
    const [{ data: membership }, { data: roleAssignments }, { data: groups }] =
      await Promise.all([
        this.client
          .from('organization_members')
          .select('role')
          .eq('user_id', userId)
          .eq('organization_id', organizationId)
          .maybeSingle(),
        this.client
          .from('user_role_assignments')
          .select('role_id')
          .eq('user_id', userId)
          .eq('organization_id', organizationId),
        this.client
          .from('user_group_members')
          .select(
            'group_id, role_id, group:user_groups(id, organization_id, is_deleted)',
          )
          .eq('user_id', userId),
      ]);

    const groupRows = ((groups ?? []) as Record<string, unknown>[]).filter(
      (row) => {
        const group = row['group'] as Record<string, unknown> | null;
        return (
          group &&
          group['organization_id'] === organizationId &&
          group['is_deleted'] !== true
        );
      },
    );

    const directRoleIds = ((roleAssignments ?? []) as Record<string, unknown>[])
      .map((row) => row['role_id'] as string | null)
      .filter((id): id is string => Boolean(id));
    const groupRoleIds = groupRows
      .map((row) => row['role_id'] as string | null)
      .filter((id): id is string => Boolean(id));

    const baseRole =
      ((membership as Record<string, unknown> | null)?.['role'] as string) ??
      null;

    return {
      isAdmin: baseRole === 'owner' || baseRole === 'admin',
      baseRole,
      roleIds: new Set([...directRoleIds, ...groupRoleIds]),
      groupIds: new Set(
        groupRows
          .map((row) => row['group_id'] as string | null)
          .filter((id): id is string => Boolean(id)),
      ),
      orgPermissionCache: new Map(),
      spacePermissionCache: new Map(),
    };
  }

  private async orgPermissionAllows(
    userId: string,
    organizationId: string,
    context: DashboardAccessContext,
    permissionKey: string,
  ): Promise<boolean> {
    if (context.orgPermissionCache.has(permissionKey)) {
      return context.orgPermissionCache.get(permissionKey) === true;
    }

    const allowed = await this.permissionsService.checkPermission(
      userId,
      organizationId,
      `can_${permissionKey}`,
    );
    context.orgPermissionCache.set(permissionKey, allowed);
    return allowed;
  }

  private async spacePermissionAllows(
    userId: string,
    organizationId: string,
    context: DashboardAccessContext,
    spaceId: string,
    permissionKey: string,
  ): Promise<boolean> {
    if (!context.spacePermissionCache.has(spaceId)) {
      const access = await this.permissionsService.getUserSpacePermissions(
        userId,
        organizationId,
        spaceId,
      );
      context.spacePermissionCache.set(
        spaceId,
        access.isMember ? access.permissions : null,
      );
    }

    const permissions = context.spacePermissionCache.get(spaceId);
    return permissions?.[permissionKey] === true;
  }

  private async modulePermissionAllows(
    userId: string,
    organizationId: string,
    context: DashboardAccessContext,
    dashboard: Record<string, unknown>,
    level: DashboardAccessLevel,
  ): Promise<boolean> {
    const permissionKey =
      level === 'delete' || level === 'manage'
        ? 'delete_dashboards'
        : level === 'edit'
          ? 'edit_dashboards'
          : 'view_dashboards';
    const spaceId = dashboard['space_id'] as string | null | undefined;

    if (spaceId) {
      return this.spacePermissionAllows(
        userId,
        organizationId,
        context,
        spaceId,
        permissionKey,
      );
    }

    return this.orgPermissionAllows(
      userId,
      organizationId,
      context,
      permissionKey,
    );
  }

  private permissionMatchesContext(
    row: Record<string, unknown>,
    userId: string,
    context: DashboardAccessContext,
  ): boolean {
    if (row['is_active'] === false) return false;

    const targetType = row['target_type'];
    const targetId = row['target_id'] as string | null;

    if (targetType === 'user') return targetId === userId;
    if (targetType === 'base_role')
      return row['base_role'] === context.baseRole;
    if (targetType === 'group')
      return Boolean(targetId && context.groupIds.has(targetId));
    if (targetType === 'role')
      return Boolean(targetId && context.roleIds.has(targetId));

    return false;
  }

  private async explicitDashboardPermissionAllows(
    dashboardId: string,
    userId: string,
    context: DashboardAccessContext,
    level: DashboardAccessLevel,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from(DashboardsService.PERMISSIONS_TABLE)
      .select('target_type, target_id, base_role, permission_level, is_active')
      .eq('dashboard_id', dashboardId)
      .eq('is_active', true);

    if (error) throw new BadRequestException(error.message);

    return ((data ?? []) as Record<string, unknown>[])
      .filter((row) => this.permissionMatchesContext(row, userId, context))
      .some((row) =>
        this.dashboardPermissionAllows(
          row['permission_level'] as string | undefined,
          level,
        ),
      );
  }

  private async canAccessDashboardRecord(
    dashboard: Record<string, unknown>,
    userId: string,
    organizationId: string,
    level: DashboardAccessLevel,
    context?: DashboardAccessContext,
  ): Promise<boolean> {
    if (
      !context &&
      (await this.permissionsService.isAdminOrOwner(userId, organizationId))
    ) {
      return true;
    }

    const accessContext =
      context ?? (await this.getAccessContext(userId, organizationId));

    if (accessContext.isAdmin || dashboard['created_by'] === userId) {
      return true;
    }

    const dashboardId = dashboard['id'] as string;
    if (
      await this.explicitDashboardPermissionAllows(
        dashboardId,
        userId,
        accessContext,
        level,
      )
    ) {
      return true;
    }

    const visibility = (dashboard['visibility'] as string | null) ?? 'private';
    if (visibility === 'private') return false;

    return this.modulePermissionAllows(
      userId,
      organizationId,
      accessContext,
      dashboard,
      level,
    );
  }

  private async assertDashboardAccess(
    dashboard: Record<string, unknown>,
    organizationId: string,
    userId: string,
    level: DashboardAccessLevel,
  ): Promise<void> {
    if (
      !(await this.canAccessDashboardRecord(
        dashboard,
        userId,
        organizationId,
        level,
      ))
    ) {
      throw new ForbiddenException('Insufficient dashboard permissions');
    }
  }

  private async appendUserDashboardPermissions(
    dashboard: Record<string, unknown>,
    organizationId: string,
    userId: string,
    context?: DashboardAccessContext,
  ): Promise<Record<string, unknown>> {
    const accessContext =
      context ?? (await this.getAccessContext(userId, organizationId));

    return {
      ...dashboard,
      user_permissions: {
        can_view: await this.canAccessDashboardRecord(
          dashboard,
          userId,
          organizationId,
          'view',
          accessContext,
        ),
        can_edit: await this.canAccessDashboardRecord(
          dashboard,
          userId,
          organizationId,
          'edit',
          accessContext,
        ),
        can_manage: await this.canAccessDashboardRecord(
          dashboard,
          userId,
          organizationId,
          'manage',
          accessContext,
        ),
        can_delete: await this.canAccessDashboardRecord(
          dashboard,
          userId,
          organizationId,
          'delete',
          accessContext,
        ),
      },
    };
  }

  private async assertCanCreateDashboard(
    organizationId: string,
    userId: string,
    spaceId?: string | null,
  ): Promise<void> {
    if (await this.permissionsService.isAdminOrOwner(userId, organizationId)) {
      return;
    }

    if (spaceId) {
      const access = await this.permissionsService.getUserSpacePermissions(
        userId,
        organizationId,
        spaceId,
      );
      if (access.isMember && access.permissions['create_dashboards'] === true) {
        return;
      }
    } else if (
      await this.permissionsService.checkPermission(
        userId,
        organizationId,
        'can_create_dashboards',
      )
    ) {
      return;
    }

    throw new ForbiddenException('Insufficient dashboard permissions');
  }

  private async assertCanViewDashboardAnalytics(
    organizationId: string,
    userId: string | undefined,
    spaceId?: string,
  ): Promise<void> {
    if (!userId) return;

    if (await this.permissionsService.isAdminOrOwner(userId, organizationId)) {
      return;
    }

    if (spaceId) {
      const access = await this.permissionsService.getUserSpacePermissions(
        userId,
        organizationId,
        spaceId,
      );
      if (access.isMember && access.permissions['view_dashboards'] === true) {
        return;
      }
      throw new ForbiddenException('Insufficient dashboard permissions');
    }

    if (
      await this.permissionsService.checkPermission(
        userId,
        organizationId,
        'can_view_dashboards',
      )
    ) {
      return;
    }

    throw new ForbiddenException('Insufficient dashboard permissions');
  }

  // ------------------------------------------------------------------ //
  // Dashboard CRUD                                                       //
  // ------------------------------------------------------------------ //

  async getAll(
    organizationId: string,
    filters: {
      spaceId?: string;
      includeOrgLevel?: boolean;
      default?: boolean;
      is_default?: boolean;
      status?: string;
      visibility?: string;
      search?: string;
      page?: number;
      pageSize?: number;
    },
    userId?: string,
  ): Promise<{
    data: unknown[];
    count: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
    page: number;
    pageSize: number;
  }> {
    const page = filters.page ?? 1;
    const pageSize = filters.pageSize ?? 500;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    if (filters.default) {
      let defaultQuery = this.client
        .from(DashboardsService.TABLE)
        .select('*')
        .eq('organization_id', organizationId)
        .eq('is_default', true)
        .is('deleted_at', null);

      defaultQuery = filters.spaceId
        ? defaultQuery.eq('space_id', filters.spaceId)
        : defaultQuery.is('space_id', null);

      const { data, error } = (await defaultQuery.maybeSingle()) as {
        data: Record<string, unknown> | null;
        error: { message: string } | null;
      };
      if (error) throw new BadRequestException(error.message);

      let rows: Record<string, unknown>[] = data ? [data] : [];
      if (userId && rows.length > 0) {
        const context = await this.getAccessContext(userId, organizationId);
        const accessibleRows = (
          await Promise.all(
            rows.map(async (dashboard) =>
              (await this.canAccessDashboardRecord(
                dashboard,
                userId,
                organizationId,
                'view',
                context,
              ))
                ? dashboard
                : null,
            ),
          )
        ).filter(Boolean);
        rows = await Promise.all(
          accessibleRows.map((dashboard) =>
            this.appendUserDashboardPermissions(
              dashboard as Record<string, unknown>,
              organizationId,
              userId,
              context,
            ),
          ),
        );
      }
      return {
        data: rows,
        count: rows.length,
        total: rows.length,
        totalPages: Math.ceil(rows.length / pageSize),
        hasMore: page * pageSize < rows.length,
        page,
        pageSize,
      };
    }

    let query = this.client
      .from(DashboardsService.TABLE)
      .select('*', { count: 'exact' })
      .eq('organization_id', organizationId)
      .is('deleted_at', null);

    if (filters.spaceId && filters.includeOrgLevel) {
      query = query.or(`space_id.eq.${filters.spaceId},space_id.is.null`);
    } else if (filters.spaceId) {
      query = query.eq('space_id', filters.spaceId);
    }

    if (filters.is_default !== undefined) {
      query = query.eq('is_default', filters.is_default);
    }
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.visibility) query = query.eq('visibility', filters.visibility);
    if (filters.search) {
      const safe = filters.search.replace(/[,.()"'\\]/g, '');
      if (safe.length > 0) {
        query = query.or(`name.ilike.%${safe}%,description.ilike.%${safe}%`);
      }
    }

    let orderedQuery = query
      .order('is_default', { ascending: false })
      .order('name', { ascending: true });

    if (!userId) {
      orderedQuery = orderedQuery.range(from, to);
    }

    const r = await orderedQuery;

    if (r.error) throw new BadRequestException(r.error.message);
    let rows = (r.data ?? []) as unknown[];
    let total = r.count ?? 0;

    if (userId) {
      const context = await this.getAccessContext(userId, organizationId);
      const accessibleRows = (
        await Promise.all(
          rows.map(async (dashboard) =>
            (await this.canAccessDashboardRecord(
              dashboard as Record<string, unknown>,
              userId,
              organizationId,
              'view',
              context,
            ))
              ? dashboard
              : null,
          ),
        )
      ).filter(Boolean);
      total = accessibleRows.length;
      rows = await Promise.all(
        accessibleRows
          .slice(from, to + 1)
          .map((dashboard) =>
            this.appendUserDashboardPermissions(
              dashboard as Record<string, unknown>,
              organizationId,
              userId,
              context,
            ),
          ),
      );
    }

    return {
      data: rows,
      // count mirrors total — kept for frontend hook compatibility (reads .count)
      count: total,
      total,
      totalPages: Math.ceil(total / pageSize),
      hasMore: page * pageSize < total,
      page,
      pageSize,
    };
  }

  async getById(
    id: string,
    organizationId: string,
    userId?: string,
    level: DashboardAccessLevel = 'view',
  ): Promise<unknown> {
    const r = await this.client
      .from(DashboardsService.TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Dashboard not found');
    if (userId) {
      await this.assertDashboardAccess(
        r.data as Record<string, unknown>,
        organizationId,
        userId,
        level,
      );
    }
    return r.data;
  }

  async getByIdWithUserPermissions(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<unknown> {
    const dashboard = (await this.getById(
      id,
      organizationId,
      userId,
      'view',
    )) as Record<string, unknown>;

    return this.appendUserDashboardPermissions(
      dashboard,
      organizationId,
      userId,
    );
  }

  async create(
    organizationId: string,
    userId: string,
    dto: CreateDashboardDto,
  ): Promise<unknown> {
    const input = { ...(dto as unknown as Record<string, unknown>) };
    delete input['organizationId'];
    await this.assertCanCreateDashboard(
      organizationId,
      userId,
      (input as { space_id?: string }).space_id,
    );

    const r = await this.client
      .from(DashboardsService.TABLE)
      .insert({
        organization_id: organizationId,
        created_by: userId,
        updated_by: userId,
        ...input,
      })
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const created = r.data as Record<string, unknown>;
    await this.logActivity(
      created['id'] as string,
      organizationId,
      userId,
      'create',
    );
    await this.logAudit({
      organizationId,
      userId,
      entityType: 'dashboard',
      entityId: created['id'] as string,
      action: 'create',
      changes: { after: created },
    });
    return created;
  }

  async update(
    id: string,
    organizationId: string,
    userId: string,
    dto: UpdateDashboardDto,
    activityAction = 'update',
    auditAction = 'update',
  ): Promise<unknown> {
    const previous = (await this.getById(
      id,
      organizationId,
      userId,
      'edit',
    )) as Record<string, unknown>;
    const input = { ...(dto as Record<string, unknown>) };
    delete input['organizationId'];
    delete input['space_id'];

    if (Object.keys(input).length === 0) {
      throw new BadRequestException('No valid dashboard fields provided');
    }

    const r = await this.client
      .from(DashboardsService.TABLE)
      .update({
        ...input,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    await this.logActivity(id, organizationId, userId, activityAction);
    await this.logAudit({
      organizationId,
      userId,
      entityType: 'dashboard',
      entityId: id,
      action: auditAction,
      changes: {
        before: previous,
        after: r.data,
        fields: input,
      },
    });
    return r.data;
  }

  async setAsDefault(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<unknown> {
    const dashboard = (await this.getById(
      id,
      organizationId,
      userId,
      'edit',
    )) as Record<string, unknown>;
    const spaceId = dashboard['space_id'] as string | null;

    // Unset other defaults in same scope
    let unsetQuery = this.client
      .from(DashboardsService.TABLE)
      .update({ is_default: false })
      .eq('organization_id', organizationId)
      .neq('id', id)
      .eq('is_default', true)
      .is('deleted_at', null);

    if (spaceId) {
      unsetQuery = unsetQuery.eq('space_id', spaceId);
    } else {
      unsetQuery = unsetQuery.is('space_id', null);
    }
    const unsetResult = await unsetQuery;
    if (unsetResult.error) {
      throw new BadRequestException(unsetResult.error.message);
    }

    return this.update(
      id,
      organizationId,
      userId,
      { is_default: true },
      'set_default',
      'set_default',
    );
  }

  async archive(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<unknown> {
    const dashboard = (await this.getById(
      id,
      organizationId,
      userId,
      'edit',
    )) as Record<string, unknown>;
    if (dashboard['status'] === 'archived') {
      throw new BadRequestException('Dashboard is already archived');
    }
    return this.update(
      id,
      organizationId,
      userId,
      { status: 'archived' },
      'archive',
      'archive',
    );
  }

  async delete(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const dashboard = (await this.getById(
      id,
      organizationId,
      userId,
      'delete',
    )) as Record<string, unknown>;
    if (dashboard['is_default']) {
      throw new BadRequestException('Cannot delete the default dashboard');
    }

    const r = await this.client
      .from(DashboardsService.TABLE)
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: userId,
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .is('deleted_at', null);
    if (r.error) throw new BadRequestException(r.error.message);
    await this.logActivity(id, organizationId, userId, 'delete');
    await this.logAudit({
      organizationId,
      userId,
      entityType: 'dashboard',
      entityId: id,
      action: 'delete',
      changes: { before: dashboard },
    });
  }

  // ------------------------------------------------------------------ //
  // Widgets                                                              //
  // ------------------------------------------------------------------ //

  async getWidgets(
    dashboardId: string,
    organizationId: string,
    userId?: string,
  ): Promise<unknown[]> {
    await this.getById(dashboardId, organizationId, userId, 'view');

    const r = await this.client
      .from(DashboardsService.WIDGETS_TABLE)
      .select('*')
      .eq('dashboard_id', dashboardId)
      .is('deleted_at', null)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as unknown[];
  }

  async getWidgetById(
    dashboardId: string,
    widgetId: string,
    organizationId: string,
    userId?: string,
    level: DashboardAccessLevel = 'view',
  ): Promise<unknown> {
    await this.getById(dashboardId, organizationId, userId, level);

    const r = await this.client
      .from(DashboardsService.WIDGETS_TABLE)
      .select('*')
      .eq('id', widgetId)
      .eq('dashboard_id', dashboardId)
      .is('deleted_at', null)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Widget not found');
    return r.data;
  }

  async createWidget(
    dashboardId: string,
    organizationId: string,
    userId: string,
    dto: CreateWidgetDto,
  ): Promise<unknown> {
    await this.getById(dashboardId, organizationId, userId, 'edit');
    const input = { ...(dto as unknown as Record<string, unknown>) };
    delete input['organizationId'];

    const r = await this.client
      .from(DashboardsService.WIDGETS_TABLE)
      .insert({
        dashboard_id: dashboardId,
        created_by: userId,
        updated_by: userId,
        ...input,
      })
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    await this.logActivity(dashboardId, organizationId, userId, 'widget_add');
    await this.logAudit({
      organizationId,
      userId,
      entityType: 'dashboard_widget',
      entityId: (r.data as Record<string, unknown>)['id'] as string,
      action: 'create',
      changes: { dashboard_id: dashboardId, after: r.data },
    });
    return r.data;
  }

  async updateWidget(
    dashboardId: string,
    widgetId: string,
    organizationId: string,
    userId: string,
    dto: UpdateWidgetDto,
  ): Promise<unknown> {
    const previous = (await this.getWidgetById(
      dashboardId,
      widgetId,
      organizationId,
      userId,
      'edit',
    )) as Record<string, unknown>;
    const input = { ...(dto as Record<string, unknown>) };
    delete input['organizationId'];

    if (Object.keys(input).length === 0) {
      throw new BadRequestException('No valid widget fields provided');
    }

    const r = await this.client
      .from(DashboardsService.WIDGETS_TABLE)
      .update({
        ...input,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', widgetId)
      .eq('dashboard_id', dashboardId)
      .is('deleted_at', null)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    await this.logActivity(
      dashboardId,
      organizationId,
      userId,
      'widget_update',
    );
    await this.logAudit({
      organizationId,
      userId,
      entityType: 'dashboard_widget',
      entityId: widgetId,
      action: 'update',
      changes: {
        dashboard_id: dashboardId,
        before: previous,
        after: r.data,
        fields: input,
      },
    });
    return r.data;
  }

  async deleteWidget(
    dashboardId: string,
    widgetId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const previous = (await this.getWidgetById(
      dashboardId,
      widgetId,
      organizationId,
      userId,
      'edit',
    )) as Record<string, unknown>;

    const r = await this.client
      .from(DashboardsService.WIDGETS_TABLE)
      .update({ deleted_at: new Date().toISOString(), deleted_by: userId })
      .eq('id', widgetId)
      .eq('dashboard_id', dashboardId)
      .is('deleted_at', null);
    if (r.error) throw new BadRequestException(r.error.message);
    await this.logActivity(
      dashboardId,
      organizationId,
      userId,
      'widget_delete',
    );
    await this.logAudit({
      organizationId,
      userId,
      entityType: 'dashboard_widget',
      entityId: widgetId,
      action: 'delete',
      changes: { dashboard_id: dashboardId, before: previous },
    });
  }

  async getLayout(
    dashboardId: string,
    organizationId: string,
    userId?: string,
  ): Promise<unknown[]> {
    const widgets = await this.getWidgets(dashboardId, organizationId, userId);
    return (widgets as Record<string, unknown>[]).map((w) => ({
      id: w['id'],
      ...(w['position'] as object),
    }));
  }

  async updateLayout(
    dashboardId: string,
    organizationId: string,
    userId: string,
    dto: UpdateLayoutDto,
  ): Promise<void> {
    await this.getById(dashboardId, organizationId, userId, 'edit');

    const items = dto.items ?? dto.positions;
    if (!Array.isArray(items)) {
      throw new BadRequestException('items or positions must be an array');
    }

    const ids = items.map((item) => item.id);
    const existing = await this.client
      .from(DashboardsService.WIDGETS_TABLE)
      .select('id')
      .eq('dashboard_id', dashboardId)
      .is('deleted_at', null)
      .in('id', ids);
    if (existing.error) throw new BadRequestException(existing.error.message);

    const existingIds = new Set(
      ((existing.data ?? []) as Record<string, unknown>[]).map((row) =>
        String(row['id']),
      ),
    );
    const missingIds = ids.filter((id) => !existingIds.has(id));
    if (missingIds.length > 0) {
      throw new NotFoundException('One or more widgets were not found');
    }

    const results = await Promise.all(
      items.map((item) => {
        const { id, ...position } = item;
        return this.client
          .from(DashboardsService.WIDGETS_TABLE)
          .update({
            position,
            updated_by: userId,
            updated_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('dashboard_id', dashboardId)
          .is('deleted_at', null);
      }),
    );

    const failed = results.find((result) => result.error);
    if (failed?.error) throw new BadRequestException(failed.error.message);

    await this.logActivity(
      dashboardId,
      organizationId,
      userId,
      'widget_layout_update',
    );
    await this.logAudit({
      organizationId,
      userId,
      entityType: 'dashboard_widget',
      entityId: dashboardId,
      action: 'layout_update',
      changes: { dashboard_id: dashboardId, positions: items },
    });
  }

  // ------------------------------------------------------------------ //
  // Widget Data                                                          //
  // ------------------------------------------------------------------ //

  async getWidgetData(
    dashboardId: string,
    widgetId: string,
    organizationId: string,
    userId: string,
    spaceId?: string,
    offset = 0,
    sprintId?: string,
  ): Promise<unknown> {
    const widget = (await this.getWidgetById(
      dashboardId,
      widgetId,
      organizationId,
      userId,
      'view',
    )) as Record<string, unknown>;
    const config = (widget['config'] as Record<string, unknown>) ?? {};
    const widgetType =
      typeof widget['widget_type'] === 'string'
        ? widget['widget_type']
        : 'unknown';

    const dashboard = (await this.getById(
      dashboardId,
      organizationId,
      userId,
      'view',
    )) as Record<string, unknown>;
    const resolvedSpaceId = await this.resolveWidgetDataSpaceId(
      dashboard,
      spaceId,
      organizationId,
      userId,
    );

    if (config.slaPreset !== undefined) {
      return {
        data: await this.slaReportService.report(
          organizationId,
          userId,
          config,
          offset,
        ),
        widget_type: widgetType,
      };
    }

    const dataSourceMode = config['dataSourceMode'] as string | undefined;
    const dataSourceType =
      (widget['data_source_type'] as string | null | undefined) ??
      (config['dataSource'] as string | null | undefined);
    const dataSourceId =
      (widget['data_source_id'] as string | null | undefined) ??
      (config['dataSourceId'] as string | null | undefined);

    if (widgetType === 'resource_planning') {
      const canView = await this.permissionsService.checkPermission(
        userId,
        organizationId,
        'can_view_resource_planning',
      );
      if (!canView) {
        throw new ForbiddenException(
          'You do not have access to resource planning data',
        );
      }

      const widgetQuery = this.resourcePlanningWidgetQuery(config);
      let report: ResourcePlanningReport;
      try {
        report = await this.resourcePlanningReportService.getReport(
          organizationId,
          widgetQuery,
          userId,
        );
      } catch (err) {
        // A saved widget can point at a portfolio that's since been deleted
        // or is otherwise inaccessible. Show an empty state instead of
        // breaking the widget, matching the pre-404 behavior of this call.
        if (!(err instanceof NotFoundException)) throw err;
        const normalized = normalizeResourcePlanningReportQuery(widgetQuery);
        report = {
          range: {
            from: normalized.from,
            to: normalized.to,
            bucket: normalized.bucket,
            group_by: normalized.group_by,
          },
          rows: [],
          totals_by_currency: [],
          exceptions: {
            ambiguous_time_entry_count: 0,
            unallocated_time_entry_count: 0,
            ambiguous_actual_hours: 0,
            unallocated_actual_hours: 0,
            missing_rate_hours: 0,
            undated_allocation_count: 0,
          },
        };
      }
      return { data: report, widget_type: widgetType };
    }

    if (widgetType === 'git_development') {
      return {
        data: await this.getGitDevelopmentData(
          config,
          organizationId,
          userId,
          resolvedSpaceId,
        ),
        widget_type: widgetType,
      };
    }

    if (widgetType === 'velocity_chart') {
      return {
        data: await this.getVelocityData(
          config,
          organizationId,
          userId,
          sprintId,
        ),
        widget_type: widgetType,
      };
    }

    // ---- Mode 1: saved_filter -----------------------------------------
    if (dataSourceMode === 'saved_filter') {
      const savedFilterId = config['savedFilterId'] as string;
      if (!savedFilterId) return { data: [], widget_type: widgetType };

      try {
        // Charts aggregate in JS, so they need the whole result set — a single
        // 500-row page charted a subset and silently under-reported every bucket.
        // Tables legitimately show one page, so they keep the single request.
        const rawRows =
          widgetType === 'chart'
            ? await this.fetchAllFilterRowsForChart((page, pageSize) =>
                this.savedFiltersService.executeFilter(
                  savedFilterId,
                  organizationId,
                  userId,
                  { page, pageSize },
                ),
              )
            : ((
                await this.savedFiltersService.executeFilter(
                  savedFilterId,
                  organizationId,
                  userId,
                  { page: 1, pageSize: 100 },
                )
              ).data.data ?? []);

        const rows = filterRowsToSpace(
          rawRows as unknown as Record<string, unknown>[],
          resolvedSpaceId,
        );

        if (widgetType === 'chart') {
          const groupByField = (config['xAxis'] as string) ?? 'status';
          const segmentBy = config['segmentBy'] as string | undefined;

          if (needsChartLabels(groupByField, segmentBy)) {
            return {
              ...(await this.labelledChartData(
                rows,
                organizationId,
                groupByField,
                segmentBy,
                'filter',
              )),
              widget_type: widgetType,
            };
          }

          if (segmentBy) {
            const multi = aggregateMultiSeries(rows, groupByField, segmentBy);
            return { ...multi, widget_type: widgetType };
          }

          return {
            data: aggregateFilterResults(rows, groupByField),
            widget_type: widgetType,
          };
        }

        return { data: rows, widget_type: widgetType };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to load widget data';
        const isAccess = /not found|permission|forbidden|unauthorized/i.test(
          message,
        );

        return {
          data: [],
          widget_type: widgetType,
          error: isAccess
            ? 'You do not have access to the saved filter backing this widget'
            : 'Failed to load widget data',
        };
      }
    }

    // ---- Mode 2: custom_query ------------------------------------------
    if (dataSourceMode === 'custom_query') {
      const queryRules = config['queryRules'] as
        | Record<string, unknown>
        | undefined;
      if (!queryRules) return { data: [], widget_type: widgetType };

      try {
        const buildAdHocParams = (page: number, pageSize: number) => ({
          query: queryRules,
          source_type:
            (config['querySourceType'] as ExecuteFilterDto['source_type']) ??
            'spaces',
          source_space_ids: resolvedSpaceId
            ? [resolvedSpaceId]
            : ((config['querySpaceIds'] as string[] | undefined) ?? []),
          source_entity_types: (config['queryEntityTypes'] as
            | string[]
            | undefined) ?? ['processes', 'tasks', 'lists'],
          page,
          pageSize,
        });

        // Same reason as Mode 1 — charts aggregate in JS and so need every row;
        // tables display one page and keep the single request.
        const rawRows =
          widgetType === 'chart'
            ? await this.fetchAllFilterRowsForChart((page, pageSize) =>
                this.savedFiltersService.executeAdHoc(
                  buildAdHocParams(page, pageSize),
                  organizationId,
                  userId,
                ),
              )
            : ((
                await this.savedFiltersService.executeAdHoc(
                  buildAdHocParams(1, 100),
                  organizationId,
                  userId,
                )
              ).data.data ?? []);

        const rows = filterRowsToSpace(
          rawRows as unknown as Record<string, unknown>[],
          resolvedSpaceId,
        );

        if (widgetType === 'chart') {
          const groupByField = (config['xAxis'] as string) ?? 'status';
          const segmentBy = config['segmentBy'] as string | undefined;

          if (needsChartLabels(groupByField, segmentBy)) {
            return {
              ...(await this.labelledChartData(
                rows,
                organizationId,
                groupByField,
                segmentBy,
                'filter',
              )),
              widget_type: widgetType,
            };
          }

          if (segmentBy) {
            const multi = aggregateMultiSeries(rows, groupByField, segmentBy);
            return { ...multi, widget_type: widgetType };
          }

          return {
            data: aggregateFilterResults(rows, groupByField),
            widget_type: widgetType,
          };
        }

        const tableData = rows.map((row) => {
          const result = { ...row };
          // Keep a task's status row: the widget draws the same chip as the task detail view. XE-T637.
          const statusConfig = (
            row['_entity'] as Record<string, unknown> | undefined
          )?.['status_config'];
          if (statusConfig) result['status_config'] = statusConfig;
          delete result['_entity'];
          return result;
        });
        return { data: tableData, widget_type: widgetType };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to load widget data';
        const isAccess = /not found|permission|forbidden|unauthorized/i.test(
          message,
        );

        return {
          data: [],
          widget_type: widgetType,
          error: isAccess
            ? 'You do not have access to run this widget query'
            : 'Failed to load widget data',
        };
      }
    }

    if (
      widgetType === 'time_tracking_personal' ||
      widgetType === 'time_tracking_team'
    ) {
      if (widgetType === 'time_tracking_team') {
        const { data: orgMember, error: orgMemberError } = await this.client
          .from('organization_members')
          .select('role')
          .eq('user_id', userId)
          .eq('organization_id', organizationId)
          .maybeSingle();

        if (orgMemberError)
          throw new BadRequestException(orgMemberError.message);
        const role = (orgMember as { role?: string } | null)?.role;
        if (!role || !['owner', 'admin'].includes(role)) {
          throw new HttpException(
            {
              message: 'You do not have access to team time tracking data',
              data: {
                data: [],
                groups: [],
                totalMinutes: 0,
                widget_type: widgetType,
                error: 'You do not have access to team time tracking data',
              },
            },
            HttpStatus.FORBIDDEN,
          );
        }
      }

      const groupBy = (config['groupBy'] as string) || 'space';
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      const dateFrom =
        typeof config['dateFrom'] === 'string' &&
        dateRegex.test(config['dateFrom'])
          ? config['dateFrom']
          : undefined;
      const dateTo =
        typeof config['dateTo'] === 'string' && dateRegex.test(config['dateTo'])
          ? config['dateTo']
          : undefined;

      const taskJoin = resolvedSpaceId
        ? 'task:tasks!time_entries_task_id_fkey!inner('
        : 'task:tasks!time_entries_task_id_fkey(';

      const buildTimeEntriesPage = (pageFrom: number, pageTo: number) => {
        let query = this.client
          .from('time_entries')
          .select(
            'id,task_id,user_id,duration_minutes,logged_at,note,started_at,organization_id,' +
              'user:users!time_entries_user_id_fkey(id,first_name,last_name,email,avatar_url),' +
              taskJoin +
              'id,key,summary,status,priority,status_id,priority_id,assigned_to,space_id,' +
              'status_config:task_statuses!tasks_status_id_fkey(id,name,key,color,icon,is_completed,sort_order),' +
              'priority_config:task_priorities!tasks_priority_id_fkey(id,name,key,color,icon,sort_order),' +
              'assignee:users!tasks_assigned_to_fkey(id,first_name,last_name,email,avatar_url),' +
              'space:spaces!tasks_space_id_fkey(id,key,name)' +
              ')',
          )
          .eq('organization_id', organizationId)
          .order('logged_at', { ascending: false })
          .order('id', { ascending: true })
          .range(pageFrom, pageTo);

        if (widgetType === 'time_tracking_personal') {
          query = query.eq('user_id', userId);
        }
        if (resolvedSpaceId) query = query.eq('task.space_id', resolvedSpaceId);
        if (dateFrom)
          query = query.gte('logged_at', `${dateFrom}T00:00:00.000Z`);
        if (dateTo) query = query.lte('logged_at', `${dateTo}T23:59:59.999Z`);

        return query as never;
      };

      // `totalMinutes` and `groups` below are JS reductions over these rows, and
      // the read was hard-capped at .limit(1000) — so for any active tenant the
      // reported total was simply wrong, with no error and no indication that
      // entries had been dropped. Paging makes the aggregates correct.
      const { rows: entries } = await fetchAllRows<Record<string, unknown>>(
        (from, to) => buildTimeEntriesPage(from, to),
      );

      const rawEntries = (
        (entries ?? []) as unknown as Array<Record<string, unknown>>
      )
        .map((entry) => {
          const task = (entry['task'] as Record<string, unknown> | null) ?? {};
          const space = (task['space'] as Record<string, unknown> | null) ?? {};
          const entryUser =
            (entry['user'] as Record<string, unknown> | null) ?? {};
          const taskAssignee =
            (task['assignee'] as Record<string, unknown> | null) ?? null;

          return {
            id: entry['id'],
            task_id: entry['task_id'],
            task_key: task['key'] || '',
            task_summary: task['summary'] || '',
            task_status: task['status'] || '',
            task_priority: task['priority'] || '',
            task_status_config: task['status_config'] || null,
            task_priority_config: task['priority_config'] || null,
            task_assigned_to: task['assigned_to'] || null,
            task_assignee: taskAssignee
              ? {
                  id: taskAssignee['id'],
                  first_name: taskAssignee['first_name'] || null,
                  last_name: taskAssignee['last_name'] || null,
                  email: taskAssignee['email'] || null,
                  avatar_url: taskAssignee['avatar_url'] || null,
                }
              : null,
            space_id: task['space_id'] || null,
            space_key: space['key'] || '',
            space_name: space['name'] || '',
            user_id: entry['user_id'] || '',
            user_name:
              [entryUser['first_name'], entryUser['last_name']]
                .filter(Boolean)
                .join(' ') ||
              entryUser['email'] ||
              '',
            user_avatar: entryUser['avatar_url'] || null,
            duration_minutes: entry['duration_minutes'] ?? 0,
            logged_at: entry['logged_at'],
            note: entry['note'],
            started_at: entry['started_at'],
          };
        })
        .filter(
          (entry) => !resolvedSpaceId || entry.space_id === resolvedSpaceId,
        );

      const groupMap: Record<
        string,
        { label: string; totalMinutes: number; entries: number }
      > = {};

      for (const entry of rawEntries) {
        let groupKey = '';
        let groupLabel = '';

        switch (groupBy) {
          case 'user':
            groupKey =
              typeof entry.user_id === 'string' && entry.user_id
                ? entry.user_id
                : 'unknown_user';
            groupLabel =
              typeof entry.user_name === 'string' && entry.user_name
                ? entry.user_name
                : 'Unknown';
            break;
          case 'task':
            groupKey =
              typeof entry.task_id === 'string' && entry.task_id
                ? entry.task_id
                : 'unknown_task';
            groupLabel =
              `${typeof entry.task_key === 'string' ? entry.task_key : ''} ${typeof entry.task_summary === 'string' ? entry.task_summary : ''}`.trim() ||
              'Unknown Task';
            break;
          case 'date':
            groupKey =
              typeof entry.logged_at === 'string' && entry.logged_at
                ? entry.logged_at.substring(0, 10)
                : 'unknown';
            groupLabel = groupKey;
            break;
          case 'space':
          default:
            groupKey =
              typeof entry.space_id === 'string' && entry.space_id
                ? entry.space_id
                : 'no_space';
            groupLabel =
              typeof entry.space_name === 'string' && entry.space_name
                ? entry.space_name
                : 'No Project';
            break;
        }

        if (!groupMap[groupKey]) {
          groupMap[groupKey] = {
            label: groupLabel,
            totalMinutes: 0,
            entries: 0,
          };
        }

        groupMap[groupKey].totalMinutes += Number(entry.duration_minutes ?? 0);
        groupMap[groupKey].entries += 1;
      }

      const groups = Object.entries(groupMap)
        .map(([key, value]) => ({
          key,
          label: value.label,
          totalMinutes: value.totalMinutes,
          entryCount: value.entries,
        }))
        .sort((a, b) => b.totalMinutes - a.totalMinutes);

      const totalMinutes = rawEntries.reduce(
        (sum, entry) => sum + Number(entry.duration_minutes ?? 0),
        0,
      );

      return {
        data: rawEntries,
        groups,
        totalMinutes,
        widget_type: widgetType,
      };
    }

    // ---- Mode 3: simple (default) -------------------------------------
    if (!dataSourceType) {
      return { data: null, widget_type: widgetType };
    }

    switch (dataSourceType) {
      case 'process': {
        if (widgetType === 'chart' || widgetType === 'table') {
          // Paged for the same reason as the task widget below — this tenant
          // has 346 processes today so it sits under the 1000-row cap, but the
          // aggregation is wrong by construction the moment it doesn't.
          const { rows } = await fetchAllRows<Record<string, unknown>>(
            (from, to) => {
              let q = this.client
                .from('business_processes')
                .select(
                  '*,assigned_to_user:users!business_processes_assigned_to_fkey(id,first_name,last_name,avatar_url)',
                )
                .eq('organization_id', organizationId);

              if (resolvedSpaceId) q = q.eq('space_id', resolvedSpaceId);
              if (dataSourceId) q = q.eq('parent_id', dataSourceId);

              return q
                .order('id', { ascending: true })
                .range(from, to) as never;
            },
          );

          if (widgetType === 'chart') {
            const groupByField = (config['xAxis'] as string) || 'status';
            const segmentBy = config['segmentBy'] as string | undefined;

            if (segmentBy) {
              const multi = aggregateMultiSeries(rows, groupByField, segmentBy);
              return { ...multi, widget_type: widgetType };
            }

            return {
              data: aggregateFilterResults(rows, groupByField),
              widget_type: widgetType,
            };
          }

          const tableRows = rows.map((row) => {
            const next = { ...row };
            if (next['assigned_to_user'])
              next['assigned_to'] = next['assigned_to_user'];
            delete next['assigned_to_user'];
            return next;
          });

          return { data: tableRows, widget_type: widgetType };
        }

        if (!dataSourceId) return { data: null, widget_type: widgetType };
        let q = this.client
          .from('business_processes')
          .select('*, children:business_processes(count)')
          .eq('id', dataSourceId)
          .eq('organization_id', organizationId);
        if (resolvedSpaceId) q = q.eq('space_id', resolvedSpaceId);

        const { data, error } = (await q.maybeSingle()) as {
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        };
        if (error) throw new BadRequestException(error.message);

        const processData = data
          ? {
              ...data,
              children_count:
                (data['children'] as Array<{ count?: number }> | undefined)?.[0]
                  ?.count ?? 0,
              name: data['title'],
            }
          : null;

        return { data: processData, widget_type: widgetType };
      }

      case 'task': {
        if (widgetType === 'chart' || widgetType === 'table') {
          const selectFields =
            widgetType === 'table'
              ? '*,assigned_to_user:users!tasks_assigned_to_fkey(id,first_name,last_name,avatar_url),reporter_user:users!tasks_reporter_fkey(id,first_name,last_name,avatar_url),process:business_processes!tasks_process_id_fkey(id,key,title),parent_task:tasks!tasks_parent_task_id_fkey(id,key,summary),status_config:task_statuses!tasks_status_id_fkey(id,name,key,color,icon,is_completed,sort_order)'
              : '*,assigned_to_user:users!tasks_assigned_to_fkey(id,first_name,last_name,avatar_url),reporter_user:users!tasks_reporter_fkey(id,first_name,last_name,avatar_url)';

          // Paged, not a single unbounded SELECT: PostgREST would cap this at
          // 1000 rows and the JS aggregation below would then report a number
          // that is simply wrong for any tenant past that (measured: 771 vs a
          // true 16,741). See fetchAllRows.
          const { rows: fetchedRows } = await fetchAllRows<
            Record<string, unknown>
          >((from, to) => {
            let q = this.client
              .from('tasks')
              .select(selectFields)
              .eq('organization_id', organizationId);

            if (resolvedSpaceId) q = q.eq('space_id', resolvedSpaceId);
            if (dataSourceId) q = q.eq('process_id', dataSourceId);

            // Stable order is required for correct paging — without it Postgres
            // may return overlapping/missing rows across pages.
            return q.order('id', { ascending: true }).range(from, to) as never;
          });

          const rows = fetchedRows;

          if (widgetType === 'chart') {
            const groupByField = (config['xAxis'] as string) || 'status';
            const segmentBy = config['segmentBy'] as string | undefined;
            // Tasks have no entity_type column; the legacy "Type" group-by meant task type.
            const labelX =
              groupByField === 'entity_type' ? 'task_type' : groupByField;
            const labelSegment =
              segmentBy === 'entity_type' ? 'task_type' : segmentBy;

            if (needsChartLabels(labelX, labelSegment)) {
              return {
                ...(await this.labelledChartData(
                  rows,
                  organizationId,
                  labelX,
                  labelSegment,
                  'task',
                )),
                widget_type: widgetType,
              };
            }

            if (segmentBy) {
              const multi = aggregateMultiSeries(rows, groupByField, segmentBy);
              return { ...multi, widget_type: widgetType };
            }

            return {
              data: aggregateFilterResults(rows, groupByField),
              widget_type: widgetType,
            };
          }

          const tableRows = rows.map((row) => {
            const next = { ...row };
            if (next['assigned_to_user'])
              next['assigned_to'] = next['assigned_to_user'];
            if (next['reporter_user']) next['reporter'] = next['reporter_user'];
            if (next['process'] && typeof next['process'] === 'object') {
              next['process_id'] = next['process'];
            }
            if (
              next['parent_task'] &&
              typeof next['parent_task'] === 'object'
            ) {
              const parentTask = {
                ...(next['parent_task'] as Record<string, unknown>),
              };
              if (!parentTask['title'] && parentTask['summary']) {
                parentTask['title'] = parentTask['summary'];
              }
              next['parent_task_id'] = parentTask;
            }
            delete next['assigned_to_user'];
            delete next['reporter_user'];
            delete next['process'];
            delete next['parent_task'];
            return next;
          });

          return { data: tableRows, widget_type: widgetType };
        }

        if (!dataSourceId) return { data: null, widget_type: widgetType };
        let q = this.client
          .from('tasks')
          .select('*')
          .eq('id', dataSourceId)
          .eq('organization_id', organizationId);
        if (resolvedSpaceId) q = q.eq('space_id', resolvedSpaceId);

        const { data, error } = (await q.maybeSingle()) as {
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        };
        if (error) throw new BadRequestException(error.message);

        return { data: data ?? null, widget_type: widgetType };
      }

      case 'list': {
        if (!dataSourceId) return { data: [], widget_type: widgetType };
        // Lists live in asset_schemas / asset_items; space_lists is the legacy table.
        const { data: list, error: listError } = (await this.client
          .from('asset_schemas')
          .select('id, space_id, column_config, fields_definition')
          .eq('id', dataSourceId)
          .eq('organization_id', organizationId)
          .maybeSingle()) as {
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        };
        if (listError) throw new BadRequestException(listError.message);
        if (!list) return { data: [], widget_type: widgetType };
        if (resolvedSpaceId && list['space_id'] !== resolvedSpaceId) {
          throw new ForbiddenException(
            'Cannot query dashboard widget data outside its dashboard space',
          );
        }

        const { rows: items } = await fetchAllRows<Record<string, unknown>>(
          (from, to) =>
            this.client
              .from('asset_items')
              .select(
                'id, title, description, fields_data, custom_field_values, created_at, updated_at, row_order',
              )
              .eq('schema_id', dataSourceId)
              .eq('organization_id', organizationId)
              .or('is_archived.is.null,is_archived.eq.false')
              .order('row_order', { ascending: true })
              .order('id', { ascending: true })
              .range(from, to) as never,
        );

        if (widgetType !== 'chart') {
          return { data: items, widget_type: widgetType };
        }

        const groupByField = (config['xAxis'] as string) || 'created_at';
        const segmentBy = config['segmentBy'] as string | undefined;
        const rows = await this.labelListItemsForChart(
          items,
          await this.loadListFieldInfo(list, organizationId),
          segmentBy ? [groupByField, segmentBy] : [groupByField],
        );

        if (segmentBy) {
          const multi = aggregateMultiSeries(rows, groupByField, segmentBy);
          return { ...multi, widget_type: widgetType };
        }

        return {
          data: aggregateFilterResults(rows, groupByField),
          widget_type: widgetType,
        };
      }

      case 'filter': {
        const { data, error } = await this.client
          .from(DashboardsService.FILTER_TARGETS_TABLE)
          .select('target_widget_id')
          .eq('filter_widget_id', widgetId);
        if (error) throw new BadRequestException(error.message);
        const targets = ((data ?? []) as { target_widget_id: string }[]).map(
          (row) => row.target_widget_id,
        );
        return { data: { targets }, widget_type: widgetType };
      }

      default:
        return { data: null, widget_type: widgetType };
    }
  }

  /**
   * The `velocity_chart` widget: completed story points per sprint on one board. Story points are
   * a number custom field chosen in the widget config, because tasks have no built-in estimate.
   * Completed means "in a done column": completing a sprint moves everything else out of it.
   * Calculated live, so editing an estimate or reopening a task later changes that sprint's number.
   * ponytail: no snapshot at completion; add one to sprint_completion_log if history must be frozen.
   */
  private async getVelocityData(
    config: Record<string, unknown>,
    organizationId: string,
    userId: string,
    requestedSprintId?: string,
  ): Promise<Record<string, unknown>> {
    const boardId = config['boardId'];
    const fieldKey = config['storyPointsField'];
    if (typeof boardId !== 'string' || !boardId) {
      return { status: 'not_configured' };
    }
    if (typeof fieldKey !== 'string' || !fieldKey) {
      return { status: 'not_configured' };
    }

    // getSprints enforces board access and the organization, so the ids below are safe to query by.
    let boardSprints: Record<string, unknown>[];
    try {
      ({ data: boardSprints } = await this.sprintsService.getSprints(
        boardId,
        organizationId,
        userId,
        true,
      ));
    } catch (err) {
      if (err instanceof ForbiddenException) return { status: 'no_access' };
      if (err instanceof NotFoundException) {
        return { status: 'board_unavailable' };
      }
      throw err;
    }

    const { data: field, error: fieldError } = await this.client
      .from('custom_fields')
      .select('name')
      .eq('organization_id', organizationId)
      .eq('field_key', fieldKey)
      .eq('field_type', 'number')
      .not('is_deleted', 'is', true)
      .limit(1)
      .maybeSingle();
    if (fieldError) throw new BadRequestException(fieldError.message);
    if (!field) return { status: 'field_unavailable' };

    const ordered = orderStartedSprints(
      boardSprints as unknown as VelocitySprint[],
    );
    const selected = pickVelocitySprint(ordered, requestedSprintId);
    if (!selected) return { status: 'no_sprints' };

    const charted = velocityWindow(ordered, selected);

    const { data: doneColumns, error: columnError } = await this.client
      .from('board_columns')
      .select('id')
      .eq('board_id', boardId)
      .eq('is_done', true);
    if (columnError) throw new BadRequestException(columnError.message);
    const doneColumnIds = ((doneColumns ?? []) as { id: string }[]).map(
      (column) => column.id,
    );

    const { rows } = doneColumnIds.length
      ? await fetchAllRows<{
          sprint_id: string;
          task: { custom_field_values: Record<string, unknown> | null } | null;
        }>(
          (from, to) =>
            this.client
              .from('board_issue_ranking')
              .select(
                'sprint_id, task:tasks!board_issue_ranking_task_id_fkey(custom_field_values)',
              )
              .eq('board_id', boardId)
              .in(
                'sprint_id',
                charted.map((sprint) => sprint.id),
              )
              .in('column_id', doneColumnIds)
              .order('id', { ascending: true })
              .range(from, to) as never,
        )
      : { rows: [] };

    const estimatesBySprint = new Map<string, unknown[]>();
    for (const row of rows) {
      const estimates = estimatesBySprint.get(row.sprint_id) ?? [];
      estimates.push(row.task?.custom_field_values?.[fieldKey]);
      estimatesBySprint.set(row.sprint_id, estimates);
    }

    const bars = buildVelocityBars(charted, estimatesBySprint);

    return {
      status: 'ok',
      fieldName: (field as { name: string }).name,
      selectedSprintId: selected.id,
      // Newest first for the dropdown.
      sprints: [...ordered]
        .reverse()
        .map(({ id, name, status }) => ({ id, name, status })),
      bars,
      previousAverage: previousVelocityAverage(bars),
    };
  }

  /**
   * Ticket 10: the `git_development` widget. Counts only tasks in spaces where the viewer may view
   * tasks (D6) and the Development module is on, narrowed to the dashboard's / chosen space. Uses
   * the `tasks` computed fields `git_pr_count` and `git_build_state` (migration
   * 20261025120000_git_dev_reporting.sql).
   */
  private async getGitDevelopmentData(
    config: Record<string, unknown>,
    organizationId: string,
    userId: string,
    resolvedSpaceId: string | undefined,
  ): Promise<Record<string, unknown>> {
    const entitlements =
      await this.entitlementsService.getEffectiveEntitlements(organizationId);
    if (!entitlements.has('feature_external_integrations')) {
      throw new ForbiddenException(
        'External integrations are not included in your licence',
      );
    }

    const metric = (config['metric'] ?? 'in_progress_without_pr') as string;
    if (!(GIT_DEV_METRICS as readonly string[]).includes(metric)) {
      throw new BadRequestException(`Unknown development metric: ${metric}`);
    }

    const permitted = await this.savedFiltersService.getPermittedTaskSpaceIds(
      userId,
      organizationId,
    );
    const spaceIds = await developmentSpaceIds(
      this.client,
      resolvedSpaceId
        ? permitted.filter((id) => id === resolvedSpaceId)
        : permitted,
    );

    switch (metric as GitDevMetric) {
      case 'in_progress_without_pr': {
        if (spaceIds.length === 0) return { metric, total: 0, tasks: [] };

        // "In progress" (D2): the In Progress category, or the seeded `in_progress` status. The
        // task_statuses_auto_category trigger files every open status under To Do, the seeded
        // "In Progress" one included, so the category alone misses most started tasks.
        const { data: statuses, error: statusError } = await this.client
          .from('task_statuses')
          .select('id, key, category:status_categories(key)')
          .eq('organization_id', organizationId);
        if (statusError) throw new BadRequestException(statusError.message);

        const inProgressIds = (
          (statuses ?? []) as unknown as Array<{
            id: string;
            key: string;
            category: { key: string } | null;
          }>
        )
          .filter(
            (s) => s.key === 'in_progress' || s.category?.key === 'in_progress',
          )
          .map((s) => s.id);
        // Legacy rows without status_id carry the key in `tasks.status`.
        const legacy = 'and(status_id.is.null,status.eq.in_progress)';

        const { data, error, count } = await this.client
          .from('tasks')
          .select(
            'id, key, summary, space:spaces!tasks_space_id_fkey(id, key, name), ' +
              'status_config:task_statuses!tasks_status_id_fkey(name, color)',
            { count: 'exact' },
          )
          .eq('organization_id', organizationId)
          .in('space_id', spaceIds)
          .or(
            inProgressIds.length
              ? `status_id.in.(${inProgressIds.join(',')}),${legacy}`
              : legacy,
          )
          .eq('git_pr_count', 0)
          .order('updated_at', { ascending: false })
          .order('id', { ascending: true })
          .limit(50);
        if (error) throw new BadRequestException(error.message);

        const rows = (data ?? []) as unknown as Array<{
          id: string;
          key: string;
          summary: string;
          space: { id: string; key: string; name: string } | null;
          status_config: { name: string; color: string | null } | null;
        }>;
        return {
          metric,
          total: count ?? rows.length,
          tasks: rows.map((t) => ({
            id: t.id,
            key: t.key,
            summary: t.summary,
            space: t.space,
            status: {
              name: t.status_config?.name ?? 'In Progress',
              color: t.status_config?.color ?? null,
            },
          })),
        };
      }

      case 'failing_builds_by_space': {
        if (spaceIds.length === 0) return { metric, total: 0, groups: [] };

        const { rows } = await fetchAllRows<{
          space: { id: string; key: string; name: string } | null;
        }>(
          (from, to) =>
            this.client
              .from('tasks')
              .select('id, space:spaces!tasks_space_id_fkey(id, key, name)')
              .eq('organization_id', organizationId)
              .in('space_id', spaceIds)
              .eq('git_build_state', 'failed')
              .order('id', { ascending: true })
              .range(from, to) as never,
        );

        const groups = new Map<
          string,
          { key: string; label: string; spaceKey: string; count: number }
        >();
        for (const { space } of rows) {
          if (!space) continue;
          const group = groups.get(space.id) ?? {
            key: space.id,
            label: space.name,
            spaceKey: space.key,
            count: 0,
          };
          group.count += 1;
          groups.set(space.id, group);
        }

        return {
          metric,
          total: rows.length,
          groups: [...groups.values()].sort((a, b) => b.count - a.count),
        };
      }

      case 'merged_this_week': {
        // D3: rolling last 7 days (UTC).
        const since = new Date(
          Date.now() - 7 * 24 * 60 * 60 * 1000,
        ).toISOString();
        if (spaceIds.length === 0)
          return { metric, total: 0, since, items: [] };

        const { rows: linked } = await fetchAllRows<{
          pull_request: {
            id: string;
            repository_id: string;
            number: number;
            title: string;
            url: string;
            merged_at: string;
            repository: { full_name: string } | null;
          };
          task: { id: string; key: string; summary: string; space_id: string };
        }>(
          (from, to) =>
            this.client
              .from('git_pull_request_tasks')
              .select(
                'pull_request:git_pull_requests!git_pull_request_tasks_pull_request_fkey!inner(' +
                  'id, repository_id, number, title, url, merged_at, repository:git_repositories!git_pull_requests_repository_fkey(full_name)), ' +
                  'task:tasks!git_pull_request_tasks_task_id_fkey!inner(id, key, summary, space_id)',
              )
              .eq('organization_id', organizationId)
              .eq('state', 'linked')
              .gte('pull_request.merged_at', since)
              .eq('task.organization_id', organizationId)
              .in('task.space_id', spaceIds)
              .order('pull_request_id', { ascending: true })
              .order('task_id', { ascending: true })
              .range(from, to) as never,
        );
        // Only repositories assigned to the task's space.
        const assigned = await spaceRepositoryIds(this.client, spaceIds);
        const rows = linked.filter((row) =>
          assigned.get(row.task.space_id)?.has(row.pull_request.repository_id),
        );

        const items = rows
          .sort(
            (a, b) =>
              b.pull_request.merged_at.localeCompare(
                a.pull_request.merged_at,
              ) || a.task.key.localeCompare(b.task.key),
          )
          .slice(0, 50)
          .map(({ pull_request: pr, task }) => ({
            task: { id: task.id, key: task.key, summary: task.summary },
            pullRequest: {
              number: pr.number,
              title: pr.title,
              url: pr.url,
              mergedAt: pr.merged_at,
              repository: pr.repository?.full_name ?? null,
            },
          }));

        return {
          metric,
          total: new Set(rows.map((r) => r.pull_request.id)).size,
          since,
          items,
        };
      }
    }
  }

  private async resolveWidgetDataSpaceId(
    dashboard: Record<string, unknown>,
    requestedSpaceId: string | undefined,
    organizationId: string,
    userId: string,
  ): Promise<string | undefined> {
    const dashboardSpaceId = dashboard['space_id'] as string | null | undefined;

    if (dashboardSpaceId) {
      if (requestedSpaceId && requestedSpaceId !== dashboardSpaceId) {
        throw new ForbiddenException(
          'Cannot query dashboard widget data outside its dashboard space',
        );
      }

      return dashboardSpaceId;
    }

    if (!requestedSpaceId) return undefined;
    if (await this.permissionsService.isAdminOrOwner(userId, organizationId)) {
      return requestedSpaceId;
    }

    const access = await this.permissionsService.getUserSpacePermissions(
      userId,
      organizationId,
      requestedSpaceId,
    );
    if (access.isMember && access.permissions['view_dashboards'] === true) {
      return requestedSpaceId;
    }

    throw new ForbiddenException('Insufficient space permissions');
  }

  // ------------------------------------------------------------------ //
  // Filter Targets                                                       //
  // ------------------------------------------------------------------ //

  async setFilterTargets(
    dashboardId: string,
    widgetId: string,
    organizationId: string,
    userId: string,
    targetIds: string[],
  ): Promise<void> {
    await this.getWidgetById(
      dashboardId,
      widgetId,
      organizationId,
      userId,
      'edit',
    );

    if (targetIds.length > 0) {
      const uniqueTargetIds = [...new Set(targetIds)];
      const { data: targets, error: targetError } = await this.client
        .from(DashboardsService.WIDGETS_TABLE)
        .select('id')
        .eq('dashboard_id', dashboardId)
        .is('deleted_at', null)
        .in('id', uniqueTargetIds);

      if (targetError) throw new BadRequestException(targetError.message);
      const existing = new Set(
        ((targets ?? []) as Record<string, unknown>[]).map((row) =>
          String(row['id']),
        ),
      );
      const missing = uniqueTargetIds.filter((id) => !existing.has(id));
      if (missing.length > 0) {
        throw new NotFoundException(
          'One or more target widgets were not found',
        );
      }
    }

    // Delete existing targets then bulk insert
    await this.client
      .from(DashboardsService.FILTER_TARGETS_TABLE)
      .delete()
      .eq('filter_widget_id', widgetId);
    if (targetIds.length > 0) {
      const rows = [...new Set(targetIds)].map((tid) => ({
        filter_widget_id: widgetId,
        target_widget_id: tid,
      }));
      const r = await this.client
        .from(DashboardsService.FILTER_TARGETS_TABLE)
        .insert(rows);
      if (r.error) throw new BadRequestException(r.error.message);
    }

    await this.logActivity(
      dashboardId,
      organizationId,
      userId,
      'filter_targets_update',
    );
    await this.logAudit({
      organizationId,
      userId,
      entityType: 'dashboard_widget',
      entityId: widgetId,
      action: 'filter_targets_update',
      changes: { dashboard_id: dashboardId, target_ids: targetIds },
    });
  }

  // ------------------------------------------------------------------ //
  // Permissions                                                          //
  // ------------------------------------------------------------------ //

  async getPermissions(
    dashboardId: string,
    organizationId: string,
    userId?: string,
  ): Promise<unknown[]> {
    await this.getById(dashboardId, organizationId, userId, 'manage');

    const r = await this.client
      .from(DashboardsService.PERMISSIONS_TABLE)
      .select('*')
      .eq('dashboard_id', dashboardId)
      .eq('organization_id', organizationId)
      .eq('is_active', true);
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as unknown[];
  }

  async grantPermission(
    dashboardId: string,
    organizationId: string,
    userId: string,
    dto: CreatePermissionDto,
  ): Promise<unknown> {
    await this.getById(dashboardId, organizationId, userId, 'manage');
    const inputRecord = { ...(dto as unknown as Record<string, unknown>) };
    delete inputRecord['organizationId'];
    const input = inputRecord as unknown as Omit<
      CreatePermissionDto,
      'organizationId'
    >;

    // XOR validation
    if (input.target_type === 'base_role') {
      if (!input.base_role || input.target_id) {
        throw new BadRequestException(
          'base_role type requires base_role field and no target_id',
        );
      }
    } else {
      if (!input.target_id || input.base_role) {
        throw new BadRequestException(
          'user/group/role types require target_id and no base_role',
        );
      }
    }

    let existingQuery = this.client
      .from(DashboardsService.PERMISSIONS_TABLE)
      .select('id')
      .eq('dashboard_id', dashboardId)
      .eq('organization_id', organizationId)
      .eq('target_type', input.target_type);

    existingQuery =
      input.target_type === 'base_role'
        ? existingQuery.eq('base_role', input.base_role)
        : existingQuery.eq('target_id', input.target_id);

    const existing = await existingQuery.maybeSingle();
    if (existing.error) throw new BadRequestException(existing.error.message);

    const r = existing.data
      ? await this.client
          .from(DashboardsService.PERMISSIONS_TABLE)
          .update({
            permission_level: input.permission_level,
            is_active: true,
            granted_by: userId,
            updated_at: new Date().toISOString(),
          })
          .eq('id', (existing.data as Record<string, unknown>)['id'])
          .select()
          .single()
      : await this.client
          .from(DashboardsService.PERMISSIONS_TABLE)
          .insert({
            dashboard_id: dashboardId,
            organization_id: organizationId,
            granted_by: userId,
            ...input,
          })
          .select()
          .single();
    if (r.error) throw new BadRequestException(r.error.message);
    await this.logActivity(
      dashboardId,
      organizationId,
      userId,
      'permission_grant',
    );
    await this.logAudit({
      organizationId,
      userId,
      entityType: 'permission',
      entityId: dashboardId,
      action: 'create',
      changes: {
        scope: 'dashboard_permission',
        permission: input,
      },
    });
    return r.data;
  }

  async updatePermission(
    dashboardId: string,
    permissionId: string,
    organizationId: string,
    userId: string,
    dto: UpdatePermissionDto,
  ): Promise<unknown> {
    await this.getById(dashboardId, organizationId, userId, 'manage');

    const r = await this.client
      .from(DashboardsService.PERMISSIONS_TABLE)
      .update({
        permission_level: dto.permission_level,
        ...(dto.is_active !== undefined ? { is_active: dto.is_active } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', permissionId)
      .eq('dashboard_id', dashboardId)
      .eq('organization_id', organizationId)
      .select()
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Permission not found');
    await this.logActivity(
      dashboardId,
      organizationId,
      userId,
      'permission_update',
    );
    await this.logAudit({
      organizationId,
      userId,
      entityType: 'permission',
      entityId: permissionId,
      action: 'update',
      changes: {
        scope: 'dashboard_permission',
        dashboard_id: dashboardId,
        permission_level: dto.permission_level,
      },
    });
    return r.data;
  }

  async revokePermission(
    dashboardId: string,
    permissionId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.getById(dashboardId, organizationId, userId, 'manage');

    const r = await this.client
      .from(DashboardsService.PERMISSIONS_TABLE)
      .delete()
      .eq('id', permissionId)
      .eq('dashboard_id', dashboardId)
      .eq('organization_id', organizationId)
      .select('id')
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Permission not found');
    await this.logActivity(
      dashboardId,
      organizationId,
      userId,
      'permission_revoke',
    );
    await this.logAudit({
      organizationId,
      userId,
      entityType: 'permission',
      entityId: permissionId,
      action: 'delete',
      changes: {
        scope: 'dashboard_permission',
        dashboard_id: dashboardId,
      },
    });
  }

  // ------------------------------------------------------------------ //
  // Analytics                                                            //
  // ------------------------------------------------------------------ //

  async getRiskSummary(
    organizationId: string,
    userId?: string,
    spaceId?: string,
  ): Promise<unknown> {
    await this.assertCanViewDashboardAnalytics(organizationId, userId, spaceId);

    let q = this.client
      .from('business_processes')
      .select('id, status, level_c_i, level_i_i, level_a_i, request_type')
      .eq('organization_id', organizationId)
      .eq('request_type', 'Risiko');

    if (spaceId) q = q.eq('space_id', spaceId);

    const { data: processes, error } = await q;
    if (error) throw new BadRequestException(error.message);

    const rows = (processes ?? []) as Record<string, unknown>[];

    const getRiskScore = (r: Record<string, unknown>) =>
      ((r['level_c_i'] as number) ?? 0) +
      ((r['level_i_i'] as number) ?? 0) +
      ((r['level_a_i'] as number) ?? 0);

    const total = rows.length;
    const open = rows.filter(
      (r) => !['done', 'closed'].includes(r['status'] as string),
    ).length;
    const highRisk = rows.filter((r) => getRiskScore(r) > 12).length;
    const mediumRisk = rows.filter(
      (r) => getRiskScore(r) >= 5 && getRiskScore(r) <= 12,
    ).length;
    const lowRisk = rows.filter((r) => getRiskScore(r) < 5).length;
    const avgScore =
      total > 0
        ? Math.round(
            (rows.reduce((sum, r) => sum + getRiskScore(r), 0) / total) * 100,
          ) / 100
        : 0;

    // Count active Maßnahme (actions)
    let actionQuery = this.client
      .from('business_processes')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('request_type', 'Maßnahme')
      .not('status', 'eq', 'closed');
    if (spaceId) actionQuery = actionQuery.eq('space_id', spaceId);
    const { count: totalActions } = await actionQuery;

    return {
      total_processes: total,
      open_processes: open,
      high_risk: highRisk,
      medium_risk: mediumRisk,
      low_risk: lowRisk,
      avg_risk_score: avgScore,
      total_actions: totalActions ?? 0,
      calculated_at: new Date().toISOString(),
    };
  }

  async getHeatmapData(
    organizationId: string,
    userId?: string,
    spaceId?: string,
  ): Promise<unknown> {
    await this.assertCanViewDashboardAnalytics(organizationId, userId, spaceId);

    let q = this.client
      .from('business_processes')
      .select(
        'id, vuln_c_p, vuln_i_p, vuln_a_p, vuln_c_i, vuln_i_i, vuln_a_i, status',
      )
      .eq('organization_id', organizationId)
      .eq('request_type', 'Risiko')
      .not('status', 'eq', 'closed');

    if (spaceId) q = q.eq('space_id', spaceId);

    const { data: processes, error } = await q;
    if (error) throw new BadRequestException(error.message);

    const rows = (processes ?? []) as Record<string, unknown>[];

    // Build 5×5 matrix
    const matrix: Record<string, { count: number; process_ids: string[] }> = {};
    for (const row of rows) {
      const pAvg =
        (((row['vuln_c_p'] as number) ?? 0) +
          ((row['vuln_i_p'] as number) ?? 0) +
          ((row['vuln_a_p'] as number) ?? 0)) /
        3;
      const iAvg =
        (((row['vuln_c_i'] as number) ?? 0) +
          ((row['vuln_i_i'] as number) ?? 0) +
          ((row['vuln_a_i'] as number) ?? 0)) /
        3;
      const prob = Math.min(5, Math.max(1, Math.ceil(pAvg)));
      const impact = Math.min(5, Math.max(1, Math.ceil(iAvg)));
      const key = `${prob}_${impact}`;
      if (!matrix[key]) matrix[key] = { count: 0, process_ids: [] };
      matrix[key].count++;
      matrix[key].process_ids.push(row['id'] as string);
    }

    const cells = Object.entries(matrix).map(([key, val]) => {
      const [prob, impact] = key.split('_').map(Number);
      return { probability: prob, impact, ...val };
    });

    return { cells };
  }

  // ------------------------------------------------------------------ //
  // Helpers                                                              //
  // ------------------------------------------------------------------ //

  private async logActivity(
    dashboardId: string,
    organizationId: string,
    userId: string,
    action: string,
  ): Promise<void> {
    try {
      await this.client.from(DashboardsService.ACTIVITY_TABLE).insert({
        dashboard_id: dashboardId,
        organization_id: organizationId,
        user_id: userId,
        action,
      });
    } catch {
      // Activity logging is best-effort and must not break mutations.
    }
  }

  private async logAudit(params: {
    organizationId: string;
    userId: string;
    entityType: string;
    entityId: string;
    action: string;
    changes: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.client.from('audit_logs').insert({
        organization_id: params.organizationId,
        user_id: params.userId,
        entity_type: params.entityType,
        entity_id: params.entityId,
        action: params.action,
        changes: params.changes,
      });
    } catch {
      // Audit is best-effort and must not break dashboard mutations.
    }
  }
}
