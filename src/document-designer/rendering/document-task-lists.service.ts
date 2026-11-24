/**
 * @fileoverview Resolves the Document Designer task lists — comments, history,
 * attachments, SLA history, relations, linked wiki pages and linked assets —
 * for the exported tasks, and stamps the `<source>_count` fields on them.
 *
 * Strict visibility: every row passes the check the task screen applies for
 * the exporting user (space permission, wiki page ACL, asset type ACL, File
 * Explorer ACL, module + licence); anything else is omitted. Permission
 * lookups are cached per space / type / node, never repeated per task.
 * Each source runs on its own: a failure leaves only that list empty and adds
 * one warning. Queries are chunked by task id and paged past PostgREST's
 * `max_rows`, so no list is capped.
 * @module src/document-designer/rendering/document-task-lists.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { format as formatDateFns } from 'date-fns';
import { AssetObjectTypesService } from '../../assets-objects/asset-object-types.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { fetchAllRows } from '../../common/utils/fetch-all-rows';
import { FileExplorerAccessService } from '../../file-explorer/file-explorer-access.service';
import type { IFeNode } from '../../file-explorer/interfaces/fe-node.interface';
import { EntitlementsService } from '../../licensing/entitlements.service';
import { PermissionsService } from '../../permissions/permissions.service';
import { SavedFiltersService } from '../../saved-filters/saved-filters.service';
import type { SlaCycle } from '../../sla/sla-engine';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { DEFAULT_TASK_HIERARCHY_CONFIG } from '../../task-hierarchy-config/models/task-hierarchy-config.model';
import { TaskHierarchyConfigService } from '../../task-hierarchy-config/task-hierarchy-config.service';
import { createLinkViewCheck } from '../../tasks/task-links.util';
import { WikiPermissionsService } from '../../wiki/wiki-permissions.service';
import { SYSTEM_FIELDS_BY_ENTITY } from '../bindable-fields.service';
import type {
  IDocumentDataContext,
  IDocumentUserLookup,
} from './document-data-resolver.service';
import { stripHtmlToText } from './html-sanitizer';
import {
  countKeyOf,
  historyActionLabel,
  historyValueText,
  humanizeValue,
  LIST_CHUNK_SIZE,
  relationLabel,
  TASK_LIST_LABELS,
  TASK_LIST_ROW_FIELDS,
  TASK_LIST_ROW_SOURCE_KEY,
  type IRelationTypeLabelSource,
  type TaskListSource,
} from './task-list-sources';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/;
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const HISTORY_DATE_FORMAT = 'dd.MM.yyyy';
const HISTORY_USER_FIELDS = new Set(['assigned_to', 'reporter']);

const TASK_FIELD_LABELS = new Map(
  SYSTEM_FIELDS_BY_ENTITY.tasks.map((field) => [field.key, field.label.en]),
);

type ListRow = Record<string, unknown>;
type RowsByTask = Map<string, ListRow[]>;
type QueryResult = PromiseLike<{
  data: unknown[] | null;
  error: { message: string } | null;
}>;

interface IExportedTask {
  id: string;
  spaceId: string | null;
}

/** Per-export state: the tasks, per-run caches and the org-member user lookup. */
interface IListRun {
  organizationId: string;
  userId: string;
  tasks: IExportedTask[];
  spaceIds: string[];
  users: Map<string, IDocumentUserLookup | null>;
  memo: Map<string, Promise<unknown>>;
  warnings: string[];
}

interface INamedRow {
  id: string;
  name: string;
  key?: string | null;
  space_id?: string | null;
}

interface IStatusLookups {
  byId: Map<string, INamedRow>;
  byKey: Map<string, INamedRow[]>;
}

export interface IResolveTaskListsParams {
  organizationId: string;
  userId: string;
  sources: TaskListSource[];
  /** Count keys the template references — only these warn on a custom-field clash. */
  countKeys?: string[];
  context: IDocumentDataContext;
}

@Injectable()
export class DocumentTaskListsService {
  private readonly logger = new Logger(DocumentTaskListsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
    private readonly savedFilters: SavedFiltersService,
    private readonly wikiPermissions: WikiPermissionsService,
    private readonly assetObjectTypes: AssetObjectTypesService,
    private readonly fileExplorerAccess: FileExplorerAccessService,
    private readonly entitlements: EntitlementsService,
    private readonly taskHierarchyConfig: TaskHierarchyConfigService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Fill `context.taskListsByTaskId` for `sources`, merge the rows' users
   * into `context.lookups.usersById` and stamp `<source>_count` on every
   * exported task row.
   */
  async resolve(params: IResolveTaskListsParams): Promise<void> {
    const { context } = params;
    const tasks: IExportedTask[] = context.items.map((item) => {
      const spaceId = item.raw['space_id'];

      return {
        id: item.id,
        spaceId: typeof spaceId === 'string' && spaceId ? spaceId : null,
      };
    });
    if (tasks.length === 0 || params.sources.length === 0) return;

    const run: IListRun = {
      organizationId: params.organizationId,
      userId: params.userId,
      tasks,
      spaceIds: [
        ...new Set(
          tasks
            .map((task) => task.spaceId)
            .filter((id): id is string => Boolean(id)),
        ),
      ],
      users: new Map(),
      memo: new Map(),
      warnings: context.warnings,
    };

    const byTask: NonNullable<IDocumentDataContext['taskListsByTaskId']> =
      (context.taskListsByTaskId ??= {});
    const resolved = new Set<TaskListSource>();

    await Promise.all(
      params.sources.map(async (source) => {
        try {
          const grouped = await this.loadSource(source, run);
          for (const task of tasks) {
            (byTask[task.id] ??= {})[source] = grouped.get(task.id) ?? [];
          }
          resolved.add(source);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'error';
          this.logger.warn(`Task list ${source} failed: ${message}`);
          for (const task of tasks) (byTask[task.id] ??= {})[source] = [];
          run.warnings.push(
            `${TASK_LIST_LABELS[source].en} could not be loaded and render empty (${message})`,
          );
        }
      }),
    );

    await this.mergeUsers(run, resolved, byTask, context);
    await this.stampCounts(
      run,
      params.sources,
      new Set(params.countKeys ?? []),
      resolved,
      byTask,
      context,
    );
  }

  private loadSource(
    source: TaskListSource,
    run: IListRun,
  ): Promise<RowsByTask> {
    switch (source) {
      case 'comments':
        return this.loadComments(run);
      case 'history':
        return this.loadHistory(run);
      case 'attachments':
        return this.loadAttachments(run);
      case 'sla_history':
        return this.loadSlaHistory(run);
      case 'relations':
        return this.loadRelations(run);
      case 'linked_wiki_pages':
        return this.loadLinkedWikiPages(run);
      case 'linked_assets':
        return this.loadLinkedAssets(run);
    }
  }

  // Sources

  /** Internal comments only (support-request replies excluded), oldest first. */
  private async loadComments(run: IListRun): Promise<RowsByTask> {
    const rows = await this.pageInChunks<{
      id: string;
      task_id: string;
      content: string | null;
      created_by: string | null;
      created_at: string | null;
      updated_at: string | null;
    }>(
      run.tasks.map((task) => task.id),
      (chunk, from, to) =>
        this.client
          .from('task_comments')
          .select('id, task_id, content, created_by, created_at, updated_at')
          .eq('organization_id', run.organizationId)
          .is('support_request_id', null)
          .in('task_id', chunk)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
    );

    const byTask: RowsByTask = new Map();
    for (const row of rows) {
      pushRow(
        byTask,
        row.task_id,
        listRow('comments', row.id, {
          author: row.created_by,
          created_at: row.created_at,
          updated_at: row.updated_at,
          is_edited: Boolean(
            row.created_at &&
            row.updated_at &&
            row.updated_at !== row.created_at,
          ),
          content: row.content,
        }),
      );
    }

    return byTask;
  }

  /** Task history, newest first, values turned into readable text. */
  private async loadHistory(run: IListRun): Promise<RowsByTask> {
    const rows = await this.pageInChunks<{
      id: string;
      task_id: string;
      action: string | null;
      field_name: string | null;
      old_value: unknown;
      new_value: unknown;
      changed_by: string | null;
      changed_at: string | null;
    }>(
      run.tasks.map((task) => task.id),
      (chunk, from, to) =>
        this.client
          .from('task_history_with_users')
          .select(
            'id, task_id, action, field_name, old_value, new_value, changed_by, changed_at',
          )
          .eq('organization_id', run.organizationId)
          .in('task_id', chunk)
          .order('changed_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to),
    );

    const spaceOfTask = new Map(
      run.tasks.map((task) => [task.id, task.spaceId]),
    );
    const userIds = new Set<string>();
    const processIds = new Set<string>();
    const resolutionIds = new Set<string>();
    const typeSpaces = new Set<string | null>();
    let needsStatuses = false;
    let needsPriorities = false;

    for (const row of rows) {
      const values = [row.old_value, row.new_value].flat();
      const ids = values.filter(
        (value): value is string =>
          typeof value === 'string' && UUID_REGEX.test(value),
      );

      if (row.field_name && HISTORY_USER_FIELDS.has(row.field_name)) {
        ids.forEach((id) => userIds.add(id));
      } else if (row.field_name === 'process_id') {
        ids.forEach((id) => processIds.add(id));
      } else if (row.field_name === 'resolution_id') {
        ids.forEach((id) => resolutionIds.add(id));
      } else if (row.field_name === 'task_type_id') {
        typeSpaces.add(spaceOfTask.get(row.task_id) ?? null);
      } else if (row.field_name === 'status') {
        needsStatuses = true;
      } else if (row.field_name === 'priority') {
        needsPriorities = true;
      }
    }

    const [, processes, resolutions, statuses, priorities, taskTypes] =
      await Promise.all([
        this.fetchUsers(run, userIds),
        this.namesById(run, 'business_processes', 'title', processIds),
        this.namesById(run, 'resolutions', 'name', resolutionIds),
        // A failed lookup degrades to humanized keys, not a failed list.
        needsStatuses ? this.statuses(run).catch(() => null) : null,
        needsPriorities ? this.priorities(run).catch(() => null) : null,
        this.taskTypeNames(run, typeSpaces),
      ]);

    const scalarText =
      (field: string | null, spaceId: string | null) =>
      (value: string | number | boolean): string => {
        if (typeof value === 'boolean') return value ? 'Yes' : 'No';
        if (typeof value === 'number') return String(value);

        switch (field) {
          case 'assigned_to':
          case 'reporter':
            return userDisplayName(run.users.get(value)) || 'Unknown';
          case 'status':
            return statusName(statuses, value, spaceId) ?? humanizeValue(value);
          case 'priority':
            return (
              priorities?.byKey.get(value)?.[0]?.name ??
              priorities?.byId.get(value)?.name ??
              humanizeValue(value)
            );
          case 'task_type_id':
            return taskTypes.get(spaceId)?.get(value) ?? 'Unknown';
          case 'process_id':
            return processes.get(value) ?? 'Unknown';
          case 'resolution_id':
            return resolutions.get(value) ?? 'Unknown';
          case 'description':
            return htmlToPlainText(value);
          default:
            return ISO_DATE_REGEX.test(value)
              ? formatHistoryDate(value)
              : value;
        }
      };

    const byTask: RowsByTask = new Map();
    for (const row of rows) {
      const spaceId = spaceOfTask.get(row.task_id) ?? null;
      const text = (value: unknown) =>
        historyValueText(
          value,
          scalarText(row.field_name, spaceId),
          htmlToPlainText,
        ) || null;

      pushRow(
        byTask,
        row.task_id,
        listRow('history', row.id, {
          changed_at: row.changed_at,
          changed_by: row.changed_by,
          action: historyActionLabel(row.action) || null,
          field: historyFieldLabel(row.field_name) || null,
          old_value: text(row.old_value),
          new_value: text(row.new_value),
        }),
      );
    }

    return byTask;
  }

  /**
   * Uploaded files (current version) plus linked File Explorer items the
   * exporter may open. Tasks without a space have none (the app requires one).
   */
  private async loadAttachments(run: IListRun): Promise<RowsByTask> {
    const taskIds = run.tasks
      .filter((task) => task.spaceId)
      .map((task) => task.id);
    const byTask: RowsByTask = new Map();
    if (taskIds.length === 0) return byTask;

    interface IVersion {
      version_number: number | null;
      file_size: number | null;
      mime_type: string | null;
      uploaded_by: string | null;
      uploaded_at: string | null;
    }

    const [files, links] = await Promise.all([
      this.pageInChunks<{
        id: string;
        entity_id: string;
        file_name: string | null;
        created_at: string | null;
        created_by: string | null;
        current_version: IVersion | IVersion[] | null;
      }>(taskIds, (chunk, from, to) =>
        this.client
          .from('file_attachments')
          .select(
            'id, entity_id, file_name, created_at, created_by, current_version:file_versions!file_attachments_current_version_fk(version_number, file_size, mime_type, uploaded_by, uploaded_at)',
          )
          .eq('organization_id', run.organizationId)
          .eq('entity_type', 'task')
          .in('entity_id', chunk)
          .not('current_version_id', 'is', null)
          .order('created_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      this.pageInChunks<{
        id: string;
        entity_id: string;
        created_at: string | null;
        created_by: string | null;
        node: IFeNode | IFeNode[] | null;
      }>(taskIds, (chunk, from, to) =>
        this.client
          .from('entity_file_links')
          .select(
            'id, entity_id, node_id, created_at, created_by, node:fe_nodes(*)',
          )
          .eq('organization_id', run.organizationId)
          .eq('entity_type', 'task')
          .in('entity_id', chunk)
          .order('created_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ]);

    for (const file of files) {
      const version = one(file.current_version);
      pushRow(
        byTask,
        file.entity_id,
        listRow('attachments', file.id, {
          file_name: file.file_name,
          kind: 'File',
          file_type: version?.mime_type,
          file_size: version?.file_size,
          version: version?.version_number,
          uploaded_by: version?.uploaded_by ?? file.created_by,
          uploaded_at: version?.uploaded_at ?? file.created_at,
        }),
      );
    }

    // Same filter + ACL as the Attachments tab (EntityFileLinksService.listForEntity).
    const syntheticUser: RequestUser = {
      authUserId: '',
      userId: run.userId,
      email: '',
      organizationId: run.organizationId,
      memberships: [],
    };
    const candidates = links.flatMap((link) => {
      const node = one(link.node);

      return node &&
        !node.is_deleted &&
        node.organization_id === run.organizationId
        ? [{ link, node }]
        : [];
    });
    // One check per distinct node (once() shares it), all in parallel.
    const allowed = await Promise.all(
      candidates.map(({ node }) =>
        this.once(run, `fe-node:${node.id}`, () =>
          this.fileExplorerAccess
            .resolveEffectivePermission(syntheticUser, node)
            .then((permission) => permission.canView),
        ),
      ),
    );
    const visibleLinks = candidates.filter((_, index) => allowed[index]);

    const versionIds = visibleLinks
      .map(({ node }) =>
        node.node_type === 'file' ? node.current_version_id : null,
      )
      .filter((id): id is string => Boolean(id));
    const versions = new Map(
      (
        await this.selectInChunks<IVersion & { id: string }>(
          [...new Set(versionIds)],
          (chunk) =>
            this.client
              .from('fe_versions')
              .select(
                'id, version_number, file_size, mime_type, uploaded_at, uploaded_by',
              )
              .in('id', chunk),
        )
      ).map((version) => [version.id, version]),
    );

    for (const { link, node } of visibleLinks) {
      if (node.node_type === 'folder') {
        pushRow(
          byTask,
          link.entity_id,
          listRow('attachments', link.id, {
            file_name: node.name,
            kind: 'Linked folder',
            uploaded_by: link.created_by,
            uploaded_at: link.created_at,
          }),
        );
        continue;
      }

      const version = node.current_version_id
        ? versions.get(node.current_version_id)
        : undefined;
      pushRow(
        byTask,
        link.entity_id,
        listRow('attachments', link.id, {
          file_name: node.name,
          kind: 'Linked file',
          file_type: node.mime_type ?? version?.mime_type,
          file_size: node.file_size ?? version?.file_size,
          version: version?.version_number,
          uploaded_by: version?.uploaded_by ?? node.created_by,
          uploaded_at: version?.uploaded_at ?? node.created_at,
        }),
      );
    }

    sortRows(byTask, (a, b) => compareByTime(a, b, 'uploaded_at', -1));

    return byTask;
  }

  /**
   * SLA cycles exactly as the task's SLA history tab presents them: only
   * spaces where the exporter holds view_tasks + view_sla, active and not
   * archived, and only cycles of the task's current space.
   */
  private async loadSlaHistory(run: IListRun): Promise<RowsByTask> {
    const byTask: RowsByTask = new Map();
    if (run.spaceIds.length === 0) return byTask;

    const [viewSla, viewTasks, activeSpaces] = await Promise.all([
      this.permittedSpaceIds(run, 'view_sla'),
      this.permittedSpaceIds(run, 'view_tasks'),
      this.activeSpaceIds(run),
    ]);
    const allowed = run.spaceIds.filter(
      (id) => viewSla.has(id) && viewTasks.has(id) && activeSpaces.has(id),
    );
    const allowedSet = new Set(allowed);
    const eligible = run.tasks.filter(
      (task) => task.spaceId && allowedSet.has(task.spaceId),
    );
    if (eligible.length === 0) return byTask;

    type CycleRow = Pick<
      SlaCycle,
      | 'id'
      | 'task_id'
      | 'space_id'
      | 'metric_id'
      | 'cycle_number'
      | 'lifecycle'
      | 'outcome'
      | 'state'
      | 'started_at'
      | 'completed_at'
      | 'elapsed_ms'
      | 'target_ms'
      | 'deadline_at'
    >;

    const [metrics, cycles] = await Promise.all([
      this.pageInChunks<{
        id: string;
        space_id: string;
        custom_fields: { name: string } | Array<{ name: string }> | null;
      }>(allowed, (chunk, from, to) =>
        this.client
          .from('sla_metrics')
          .select('id, field_id, space_id, custom_fields(name)')
          .eq('organization_id', run.organizationId)
          .in('space_id', chunk)
          .order('id', { ascending: true })
          .range(from, to),
      ),
      this.pageInChunks<CycleRow>(
        eligible.map((task) => task.id),
        (chunk, from, to) =>
          this.client
            .from('sla_cycles')
            .select(
              'id, task_id, space_id, metric_id, cycle_number, lifecycle, outcome, state, started_at, completed_at, elapsed_ms, target_ms, deadline_at',
            )
            .eq('organization_id', run.organizationId)
            .in('task_id', chunk)
            .order('metric_id', { ascending: true })
            .order('cycle_number', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
      ),
    ]);

    const metricNames = new Map(
      metrics.map((metric) => [
        metric.id,
        one(metric.custom_fields)?.name ?? 'SLA',
      ]),
    );
    const spaceOfTask = new Map(
      eligible.map((task) => [task.id, task.spaceId]),
    );
    const kept = cycles.filter(
      (cycle) =>
        spaceOfTask.get(cycle.task_id) === cycle.space_id &&
        metricNames.has(cycle.metric_id),
    );

    const revisionIds = [
      ...new Set(
        kept
          .map((cycle) => calendarRevisionOf(cycle))
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const calendars = new Map(
      (
        await this.selectInChunks<{
          id: string;
          sla_calendars: { name: string } | Array<{ name: string }> | null;
        }>(revisionIds, (chunk) =>
          this.client
            .from('sla_calendar_revisions')
            .select(
              'id, sla_calendars!sla_calendar_revisions_calendar_id_organization_id_space_i_fkey(name)',
            )
            .eq('organization_id', run.organizationId)
            .in('id', chunk),
        )
      ).map((row) => [row.id, one(row.sla_calendars)?.name ?? null]),
    );

    for (const cycle of kept) {
      pushRow(
        byTask,
        cycle.task_id,
        listRow('sla_history', cycle.id, {
          metric: metricNames.get(cycle.metric_id),
          cycle: cycle.cycle_number,
          state: slaStateLabel(cycle),
          outcome: slaOutcomeLabel(cycle.outcome),
          target: cycle.target_ms == null ? null : Number(cycle.target_ms),
          elapsed: Number(cycle.elapsed_ms ?? 0),
          deadline_at: cycle.deadline_at,
          started_at: cycle.started_at,
          completed_at: cycle.completed_at,
          calendar: calendars.get(calendarRevisionOf(cycle) ?? ''),
        }),
      );
    }

    sortRows(
      byTask,
      (a, b) =>
        textOf(a['metric']).localeCompare(textOf(b['metric'])) ||
        Number(a['cycle'] ?? 0) - Number(b['cycle'] ?? 0) ||
        textOf(a['id']).localeCompare(textOf(b['id'])),
    );

    return byTask;
  }

  /**
   * Task / process / wiki page relations in both directions, as the Relations
   * tab shows them — minus sides the exporter cannot open, archived wiki
   * pages and plan items (the tab cannot show those either).
   */
  private async loadRelations(run: IListRun): Promise<RowsByTask> {
    interface IRelationshipRow {
      id: string;
      source_type: string;
      source_id: string;
      target_type: string;
      target_id: string;
      created_at: string | null;
      relation_type:
        | IRelationTypeLabelSource
        | IRelationTypeLabelSource[]
        | null;
    }

    const taskIds = run.tasks.map((task) => task.id);
    const select =
      'id, source_type, source_id, target_type, target_id, relation_type_id, created_at, relation_type:relation_types!task_relationships_relation_type_id_fkey(id, name, outward_description, inward_description, is_directional)';
    const page = (side: 'source' | 'target') =>
      this.pageInChunks<IRelationshipRow>(taskIds, (chunk, from, to) =>
        this.client
          .from('task_relationships')
          .select(select)
          .eq('organization_id', run.organizationId)
          .eq(`${side}_type`, 'task')
          .in(`${side}_id`, chunk)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to),
      );
    const [outward, inward] = await Promise.all([
      page('source'),
      page('target'),
    ]);

    const entries = [
      ...outward.map((rel) => ({
        rel,
        taskId: rel.source_id,
        direction: 'outward' as const,
        sideType: rel.target_type,
        sideId: rel.target_id,
      })),
      ...inward.map((rel) => ({
        rel,
        taskId: rel.target_id,
        direction: 'inward' as const,
        sideType: rel.source_type,
        sideId: rel.source_id,
      })),
    ];
    const idsOf = (type: string) => [
      ...new Set(
        entries.filter((e) => e.sideType === type).map((e) => e.sideId),
      ),
    ];

    const canView = createLinkViewCheck(
      this.permissions,
      run.organizationId,
      run.userId,
    );

    interface ISide {
      type: string;
      key: string | null;
      title: string | null;
      status: string | null;
    }

    const taskSides = async (): Promise<Map<string, ISide>> => {
      const ids = idsOf('task');
      const sides = new Map<string, ISide>();
      if (ids.length === 0) return sides;
      const [rows, statuses] = await Promise.all([
        this.selectInChunks<{
          id: string;
          key: string | null;
          summary: string | null;
          status: string | null;
          status_id: string | null;
          space_id: string | null;
        }>(ids, (chunk) =>
          this.client
            .from('tasks')
            .select('id, key, summary, status, status_id, space_id')
            .eq('organization_id', run.organizationId)
            .in('id', chunk),
        ),
        this.statuses(run).catch(() => null),
      ]);
      for (const row of rows) {
        if (!(await canView(row.space_id ?? null, 'view_tasks'))) continue;
        sides.set(row.id, {
          type: 'Task',
          key: row.key,
          title: row.summary,
          status:
            (row.status_id ? statuses?.byId.get(row.status_id)?.name : null) ??
            (row.status ? humanizeValue(row.status) : null),
        });
      }

      return sides;
    };

    const processSides = async (): Promise<Map<string, ISide>> => {
      const ids = idsOf('process');
      const sides = new Map<string, ISide>();
      if (ids.length === 0) return sides;
      const rows = await this.selectInChunks<{
        id: string;
        key: string | null;
        title: string | null;
        status: string | null;
        space_id: string | null;
      }>(ids, (chunk) =>
        this.client
          .from('business_processes')
          .select('id, key, title, status, space_id')
          .eq('organization_id', run.organizationId)
          .in('id', chunk),
      );
      for (const row of rows) {
        if (!(await canView(row.space_id ?? null, 'view_processes'))) continue;
        sides.set(row.id, {
          type: 'Process',
          key: row.key,
          title: row.title,
          status: row.status ? humanizeValue(row.status) : null,
        });
      }

      return sides;
    };

    const wikiSides = async (): Promise<Map<string, ISide>> => {
      const ids = idsOf('wiki_page');
      const sides = new Map<string, ISide>();
      if (ids.length === 0) return sides;
      const rows = await this.selectInChunks<{
        id: string;
        title: string | null;
        space_id: string;
        is_archived: boolean | null;
        created_by: string | null;
        path: string[] | null;
      }>(ids, (chunk) =>
        this.client
          .from('wiki_pages')
          .select('id, title, slug, space_id, is_archived, created_by, path')
          .eq('organization_id', run.organizationId)
          .in('id', chunk),
      );
      const accessible = await this.accessibleWikiPageIds(
        run,
        rows.filter((row) => !row.is_archived),
      );
      for (const row of rows) {
        if (!accessible.has(row.id)) continue;
        sides.set(row.id, {
          type: 'Wiki page',
          key: null,
          title: row.title,
          status: null,
        });
      }

      return sides;
    };

    const [tasks, processes, wikiPages] = await Promise.all([
      taskSides(),
      processSides(),
      wikiSides(),
    ]);
    const sidesByType: Record<string, Map<string, ISide>> = {
      task: tasks,
      process: processes,
      wiki_page: wikiPages,
    };

    const byTask: RowsByTask = new Map();
    for (const entry of entries) {
      const side = sidesByType[entry.sideType]?.get(entry.sideId);
      if (!side) continue;
      pushRow(
        byTask,
        entry.taskId,
        listRow('relations', entry.rel.id, {
          relation:
            relationLabel(one(entry.rel.relation_type), entry.direction) ||
            null,
          item_type: side.type,
          item_key: side.key,
          item_title: side.title,
          item_status: side.status,
          linked_at: entry.rel.created_at,
        }),
      );
    }

    sortRows(byTask, (a, b) => compareByTime(a, b, 'linked_at', -1));

    return byTask;
  }

  /** Wiki pages linking to the task (backlinks), wiki module on + licensed, page ACL applied. */
  private async loadLinkedWikiPages(run: IListRun): Promise<RowsByTask> {
    const byTask: RowsByTask = new Map();
    const enabled = await this.moduleSpaceIds(run, 'wiki');
    const taskIds = run.tasks
      .filter((task) => task.spaceId && enabled.has(task.spaceId))
      .map((task) => task.id);
    if (taskIds.length === 0) return byTask;

    interface ISourcePage {
      id: string;
      title: string | null;
      space_id: string;
      organization_id: string;
      created_by: string | null;
      path: string[] | null;
      is_published: boolean | null;
      is_archived: boolean | null;
      space: { name: string } | Array<{ name: string }> | null;
    }

    const links = await this.pageInChunks<{
      id: string;
      target_id: string;
      created_at: string | null;
      source_page: ISourcePage | ISourcePage[] | null;
    }>(taskIds, (chunk, from, to) =>
      this.client
        .from('wiki_page_links')
        .select(
          'id, target_id, created_at, source_page:wiki_pages!source_page_id!inner(id, title, space_id, organization_id, created_by, path, is_published, is_archived, space:spaces!wiki_pages_space_id_fkey(name))',
        )
        .eq('target_type', 'task')
        .in('target_id', chunk)
        .eq('source_page.organization_id', run.organizationId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    );

    const visible = links
      .map((link) => ({ link, page: one(link.source_page) }))
      .filter(
        (entry): entry is { link: (typeof links)[number]; page: ISourcePage } =>
          Boolean(entry.page) &&
          !entry.page!.is_archived &&
          entry.page!.organization_id === run.organizationId,
      );
    const uniquePages = new Map(visible.map(({ page }) => [page.id, page]));
    const accessible = await this.accessibleWikiPageIds(run, [
      ...uniquePages.values(),
    ]);

    for (const { link, page } of visible) {
      if (!accessible.has(page.id)) continue;
      pushRow(
        byTask,
        link.target_id,
        listRow('linked_wiki_pages', link.id, {
          page_title: page.title,
          space: one(page.space)?.name,
          is_published: page.is_published,
          linked_at: link.created_at,
        }),
      );
    }

    sortRows(
      byTask,
      (a, b) =>
        textOf(a['page_title']).localeCompare(textOf(b['page_title'])) ||
        textOf(a['id']).localeCompare(textOf(b['id'])),
    );

    return byTask;
  }

  /**
   * Asset objects linked to the task in its own space (as the Assets panel
   * lists them): view_assets + assets module on + licensed, asset type ACL,
   * archived objects dropped.
   */
  private async loadLinkedAssets(run: IListRun): Promise<RowsByTask> {
    const byTask: RowsByTask = new Map();
    const [enabled, viewAssets] = await Promise.all([
      this.moduleSpaceIds(run, 'assets'),
      this.permittedSpaceIds(run, 'view_assets'),
    ]);
    const eligible = run.tasks.filter(
      (task) =>
        task.spaceId &&
        enabled.has(task.spaceId) &&
        viewAssets.has(task.spaceId),
    );
    if (eligible.length === 0) return byTask;

    interface INamed {
      name: string | null;
    }
    interface IAssetObject {
      id: string;
      name: string | null;
      object_key: string | null;
      object_type_id: string;
      space_id: string;
      is_archived: boolean | null;
      object_type: INamed | INamed[] | null;
      schema: INamed | INamed[] | null;
    }

    const links = await this.pageInChunks<{
      id: string;
      task_id: string;
      space_id: string;
      created_at: string | null;
      object: IAssetObject | IAssetObject[] | null;
      relation_type: INamed | INamed[] | null;
    }>(
      eligible.map((task) => task.id),
      (chunk, from, to) =>
        this.client
          .from('asset_object_task_links')
          .select(
            'id, task_id, object_id, space_id, created_at, object:asset_objects!asset_object_task_links_object_id_fkey(id, name, object_key, object_type_id, space_id, is_archived, object_type:asset_object_types!asset_objects_object_type_id_fkey(id, name), schema:asset_object_schemas!asset_objects_schema_id_fkey(id, name)), relation_type:relation_types!asset_object_task_links_relation_type_id_fkey(id, name)',
          )
          .eq('organization_id', run.organizationId)
          .in('task_id', chunk)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
    );

    const spaceOfTask = new Map(
      eligible.map((task) => [task.id, task.spaceId]),
    );
    for (const link of links) {
      const object = one(link.object);
      if (
        !object ||
        object.is_archived ||
        spaceOfTask.get(link.task_id) !== link.space_id
      ) {
        continue;
      }
      if (!(await this.canViewAssetType(run, object))) continue;

      pushRow(
        byTask,
        link.task_id,
        listRow('linked_assets', link.id, {
          asset_key: object.object_key,
          name: object.name,
          asset_type: one(object.object_type)?.name,
          schema: one(object.schema)?.name,
          relation: one(link.relation_type)?.name,
          linked_at: link.created_at,
        }),
      );
    }

    sortRows(byTask, (a, b) => compareByTime(a, b, 'linked_at', 1));

    return byTask;
  }

  // Permission helpers (cached per run)

  /** Task spaces where the exporter holds `permission` — never asks with [] (that means "all spaces"). */
  private permittedSpaceIds(
    run: IListRun,
    permission: string,
  ): Promise<Set<string>> {
    return this.once(run, `permitted:${permission}`, async () =>
      run.spaceIds.length === 0
        ? new Set<string>()
        : new Set(
            await this.savedFilters.getPermittedSpaceIdsForPermission(
              run.userId,
              run.organizationId,
              permission,
              run.spaceIds,
            ),
          ),
    );
  }

  /** Task spaces that are active and not archived (the SLA tab's own space rule). */
  private activeSpaceIds(run: IListRun): Promise<Set<string>> {
    return this.once(run, 'active-spaces', async () => {
      const rows = await this.selectInChunks<{
        id: string;
        is_archived: boolean | null;
        is_active: boolean | null;
      }>(run.spaceIds, (chunk) =>
        this.client
          .from('spaces')
          .select('id, is_archived, is_active')
          .eq('organization_id', run.organizationId)
          .in('id', chunk),
      );

      return new Set(
        rows
          .filter((row) => row.is_archived !== true && row.is_active !== false)
          .map((row) => row.id),
      );
    });
  }

  /** Task spaces with `moduleType` enabled (OrganizationModuleRepository.listEnabledSpaceIds), empty when unlicensed. */
  private moduleSpaceIds(
    run: IListRun,
    moduleType: 'wiki' | 'assets',
  ): Promise<Set<string>> {
    return this.once(run, `module:${moduleType}`, async () => {
      const entitled = await this.once(run, 'entitled-modules', () =>
        this.entitlements.filterEntitledModuleTypes(run.organizationId, [
          'wiki',
          'assets',
        ]),
      );
      if (!entitled.includes(moduleType) || run.spaceIds.length === 0) {
        return new Set<string>();
      }

      const rows = await this.selectInChunks<{ space_id: string }>(
        run.spaceIds,
        (chunk) =>
          this.client
            .from('space_modules')
            .select('space_id, spaces!inner(id)')
            .eq('module_type', moduleType)
            .eq('is_enabled', true)
            .eq('spaces.organization_id', run.organizationId)
            .not('spaces.is_archived', 'is', true)
            .in('space_id', chunk),
      );

      return new Set(rows.map((row) => row.space_id));
    });
  }

  /** Wiki page ACL, grouped per page space (WikiService.getBacklinks does the same). */
  private async accessibleWikiPageIds(
    run: IListRun,
    pages: Array<{
      id: string;
      space_id: string;
      created_by: string | null;
      path: string[] | null;
    }>,
  ): Promise<Set<string>> {
    const bySpace = new Map<string, typeof pages>();
    for (const page of pages) {
      const list = bySpace.get(page.space_id) ?? [];
      list.push(page);
      bySpace.set(page.space_id, list);
    }

    const accessible = new Set<string>();
    for (const [spaceId, list] of bySpace) {
      const ok = (await this.wikiPermissions.filterAccessiblePages(
        list,
        run.userId,
        spaceId,
      )) as Array<{ id: string }>;
      for (const page of ok) accessible.add(page.id);
    }

    return accessible;
  }

  /** Asset type `can_view`, cached per type + space; a failed check denies that type only. */
  private canViewAssetType(
    run: IListRun,
    object: { object_type_id: string; space_id: string },
  ): Promise<boolean> {
    return this.once(
      run,
      `asset-type:${object.object_type_id}:${object.space_id}`,
      () =>
        this.assetObjectTypes
          .getMyPermission(
            object.object_type_id,
            object.space_id,
            run.organizationId,
            run.userId,
          )
          .then((permission) => permission.can_view)
          .catch((error: unknown) => {
            this.logger.warn(
              `Asset type ${object.object_type_id} permission check failed: ${error instanceof Error ? error.message : 'error'}`,
            );
            pushOnce(
              run.warnings,
              'Linked assets: some asset types could not be permission-checked and were omitted',
            );

            return false;
          }),
    );
  }

  // Lookups

  /** Org members only (same restriction as the resolver's user lookup); others stay unresolved. */
  private async fetchUsers(
    run: IListRun,
    ids: Iterable<string>,
  ): Promise<void> {
    const missing = [...new Set(ids)].filter(
      (id) => UUID_REGEX.test(id) && !run.users.has(id),
    );
    if (missing.length === 0) return;

    const members = await this.selectInChunks<{ user_id: string }>(
      missing,
      (chunk) =>
        this.client
          .from('organization_members')
          .select('user_id')
          .eq('organization_id', run.organizationId)
          .in('user_id', chunk),
    );
    const users = await this.selectInChunks<IDocumentUserLookup>(
      [...new Set(members.map((member) => member.user_id))],
      (chunk) =>
        this.client
          .from('users')
          .select('id, first_name, last_name, email')
          .in('id', chunk),
    );

    for (const id of missing) if (!run.users.has(id)) run.users.set(id, null);
    for (const user of users) run.users.set(user.id, user);
  }

  private async namesById(
    run: IListRun,
    table: 'business_processes' | 'resolutions',
    column: 'title' | 'name',
    ids: Set<string>,
  ): Promise<Map<string, string>> {
    const rows = await this.selectInChunks<Record<string, unknown>>(
      [...ids],
      (chunk) =>
        this.client
          .from(table)
          .select(`id, ${column}`)
          .eq('organization_id', run.organizationId)
          .in('id', chunk),
    );

    return new Map(
      rows
        .filter((row) => typeof row[column] === 'string')
        .map((row) => [String(row['id']), String(row[column])]),
    );
  }

  private statuses(run: IListRun): Promise<IStatusLookups> {
    return this.once(run, 'statuses', () =>
      this.namedLookups(run, 'task_statuses', 'id, name, key, space_id'),
    );
  }

  private priorities(run: IListRun): Promise<IStatusLookups> {
    return this.once(run, 'priorities', () =>
      this.namedLookups(run, 'task_priorities', 'id, name, key'),
    );
  }

  private async namedLookups(
    run: IListRun,
    table: 'task_statuses' | 'task_priorities',
    select: string,
  ): Promise<IStatusLookups> {
    const { rows: raw } = await fetchAllRows<unknown>(
      (from, to) =>
        this.client
          .from(table)
          .select(select)
          .eq('organization_id', run.organizationId)
          .order('id', { ascending: true })
          .range(from, to),
      Infinity,
    );
    const rows = raw as INamedRow[];

    const byId = new Map(rows.map((row) => [row.id, row]));
    const byKey = new Map<string, INamedRow[]>();
    for (const row of rows) {
      if (!row.key) continue;
      const list = byKey.get(row.key) ?? [];
      list.push(row);
      byKey.set(row.key, list);
    }

    return { byId, byKey };
  }

  /** Task-type level names per space (a spaceless task uses the default hierarchy). */
  private async taskTypeNames(
    run: IListRun,
    spaces: Set<string | null>,
  ): Promise<Map<string | null, Map<string, string>>> {
    const result = new Map<string | null, Map<string, string>>();

    await Promise.all(
      [...spaces].map(async (spaceId) => {
        const names = await this.once(run, `task-types:${spaceId}`, () =>
          (spaceId
            ? this.taskHierarchyConfig
                .getConfig(run.organizationId, spaceId)
                .then(({ config }) => config)
            : Promise.resolve(DEFAULT_TASK_HIERARCHY_CONFIG)
          )
            .then(
              (config) =>
                new Map(config.levels.map((level) => [level.id, level.name])),
            )
            .catch(() => new Map<string, string>()),
        );
        result.set(spaceId, names);
      }),
    );

    return result;
  }

  // Users + counts

  /** Resolve every user the rows reference and merge them into the shared lookup. */
  private async mergeUsers(
    run: IListRun,
    resolved: Set<TaskListSource>,
    byTask: NonNullable<IDocumentDataContext['taskListsByTaskId']>,
    context: IDocumentDataContext,
  ): Promise<void> {
    const userIds = new Set<string>();
    for (const source of resolved) {
      const keys = TASK_LIST_ROW_FIELDS[source]
        .filter((field) => field.fieldType === 'user')
        .map((field) => field.key);
      for (const lists of Object.values(byTask)) {
        for (const row of lists[source] ?? []) {
          for (const key of keys) {
            const value = row[key];
            if (typeof value === 'string') userIds.add(value);
          }
        }
      }
    }

    try {
      await this.fetchUsers(run, userIds);
    } catch (error) {
      this.logger.warn(
        `Task list users failed: ${error instanceof Error ? error.message : 'error'}`,
      );
      run.warnings.push(
        'Task list users could not be loaded (names render empty)',
      );
    }

    for (const [id, user] of run.users) {
      if (user) context.lookups.usersById[id] ??= user;
    }
  }

  /**
   * `<source>_count` on every exported task row = the rows the exporter may
   * see; null when the source failed. Skipped when an active task custom
   * field already uses the key, so that field's value keeps rendering; only a
   * referenced key warns about it.
   */
  private async stampCounts(
    run: IListRun,
    sources: TaskListSource[],
    referencedCountKeys: Set<string>,
    resolved: Set<TaskListSource>,
    byTask: NonNullable<IDocumentDataContext['taskListsByTaskId']>,
    context: IDocumentDataContext,
  ): Promise<void> {
    const countKeys = sources.map((source) => countKeyOf(source));
    let taken: Set<string>;

    try {
      const rows = await this.selectInChunks<{
        field_key: string;
        contexts: unknown;
      }>(countKeys, (chunk) =>
        this.client
          .from('custom_fields')
          .select('field_key, contexts')
          .eq('organization_id', run.organizationId)
          .eq('is_active', true)
          .or('is_deleted.is.null,is_deleted.eq.false')
          .in('field_key', chunk),
      );
      taken = new Set(
        rows
          .filter((row) => contextsInclude(row.contexts, 'task'))
          .map((row) => row.field_key),
      );
    } catch (error) {
      this.logger.warn(
        `Task list count check failed: ${error instanceof Error ? error.message : 'error'}`,
      );
      run.warnings.push(
        'Task list counts could not be checked and render empty',
      );

      return;
    }

    for (const source of sources) {
      const key = countKeyOf(source);
      if (taken.has(key)) {
        if (referencedCountKeys.has(key)) {
          run.warnings.push(
            `${key} is not filled: a custom field with that key exists, its value is shown instead`,
          );
        }
        continue;
      }
      for (const item of context.items) {
        item.raw[key] = resolved.has(source)
          ? (byTask[item.id]?.[source]?.length ?? 0)
          : null;
      }
    }
  }

  // Query helpers

  /** Memoize one lookup per run (permissions, modules, statuses, ACLs). */
  private once<T>(
    run: IListRun,
    key: string,
    load: () => Promise<T>,
  ): Promise<T> {
    let pending = run.memo.get(key) as Promise<T> | undefined;
    if (!pending) {
      const loading = load();
      pending = loading;
      run.memo.set(key, loading);
      // Forget a failure so the next caller retries instead of replaying it.
      loading.catch(() => {
        if (run.memo.get(key) === loading) run.memo.delete(key);
      });
    }

    return pending;
  }

  /** `.in()` chunks of LIST_CHUNK_SIZE ids, each paged past max_rows (build MUST order stably). */
  private async pageInChunks<T>(
    ids: string[],
    build: (chunk: string[], from: number, to: number) => QueryResult,
  ): Promise<T[]> {
    const out: T[] = [];
    for (const chunk of chunked(ids)) {
      const { rows } = await fetchAllRows<unknown>(
        (from, to) => build(chunk, from, to),
        Infinity,
      );
      for (const row of rows) out.push(row as T);
    }

    return out;
  }

  /** `.in()` chunks by id — at most one row per id, so a chunk never reaches max_rows. */
  private async selectInChunks<T>(
    ids: string[],
    build: (chunk: string[]) => QueryResult,
  ): Promise<T[]> {
    const out: T[] = [];
    for (const chunk of chunked(ids)) {
      const { data, error } = await build(chunk);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) out.push(row as T);
    }

    return out;
  }
}

function chunked(ids: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += LIST_CHUNK_SIZE) {
    chunks.push(ids.slice(i, i + LIST_CHUNK_SIZE));
  }

  return chunks;
}

/** A row with every catalog key of `source` (null when missing). */
function listRow(
  source: TaskListSource,
  id: string,
  values: Record<string, unknown>,
): ListRow {
  const row: ListRow = { id, [TASK_LIST_ROW_SOURCE_KEY]: source };
  for (const field of TASK_LIST_ROW_FIELDS[source]) {
    row[field.key] = values[field.key] ?? null;
  }

  return row;
}

function pushRow(byTask: RowsByTask, taskId: string, row: ListRow): void {
  const rows = byTask.get(taskId);
  if (rows) rows.push(row);
  else byTask.set(taskId, [row]);
}

function sortRows(
  byTask: RowsByTask,
  compare: (a: ListRow, b: ListRow) => number,
): void {
  for (const rows of byTask.values()) rows.sort(compare);
}

/** Time order on `key` (missing times last), ties by id in the same direction. */
function compareByTime(
  a: ListRow,
  b: ListRow,
  key: string,
  direction: 1 | -1,
): number {
  const ta = timeOf(a[key]);
  const tb = timeOf(b[key]);
  if (Number.isNaN(ta) !== Number.isNaN(tb)) return Number.isNaN(ta) ? 1 : -1;
  if (!Number.isNaN(ta) && ta !== tb) return (ta - tb) * direction;

  return textOf(a['id']).localeCompare(textOf(b['id'])) * direction;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function timeOf(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

/** PostgREST returns a to-one embed as an object, occasionally as a one-element array. */
function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;

  return value ?? null;
}

function pushOnce(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}

function userDisplayName(user: IDocumentUserLookup | null | undefined): string {
  if (!user) return '';
  const name = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();

  return name || user.email || '';
}

/** Legacy status key → the status name (task's space first, then org-level, then any). */
/** Same rule as bindable-fields.service.ts: `contexts` is a JSON array or its string form. */
function contextsInclude(contexts: unknown, context: string): boolean {
  if (Array.isArray(contexts)) return (contexts as string[]).includes(context);
  if (typeof contexts === 'string') {
    try {
      const parsed = JSON.parse(contexts) as unknown;

      return Array.isArray(parsed) && (parsed as string[]).includes(context);
    } catch {
      return false;
    }
  }

  return false;
}

function statusName(
  statuses: IStatusLookups | null,
  key: string,
  spaceId: string | null,
): string | null {
  const candidates = statuses?.byKey.get(key);
  if (!candidates?.length) return statuses?.byId.get(key)?.name ?? null;

  return (
    candidates.find((row) => spaceId && row.space_id === spaceId)?.name ??
    candidates.find((row) => !row.space_id)?.name ??
    candidates[0].name
  );
}

function historyFieldLabel(field: string | null): string {
  if (!field) return '';

  return (
    TASK_FIELD_LABELS.get(field) ?? humanizeValue(field.replace(/_id$/, ''))
  );
}

function formatHistoryDate(value: string): string {
  const date = DATE_ONLY_REGEX.test(value)
    ? (() => {
        const [year, month, day] = value.split('-').map(Number);

        return new Date(year, month - 1, day);
      })()
    : new Date(value);

  return Number.isNaN(date.getTime())
    ? value
    : formatDateFns(date, HISTORY_DATE_FORMAT);
}

/** Plain text of an HTML fragment (stripHtmlToText keeps entities encoded — decode them). */
function htmlToPlainText(html: string): string {
  return stripHtmlToText(html)
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function calendarRevisionOf(
  cycle: Pick<SlaCycle, 'state'>,
): string | undefined {
  const state = cycle.state as Partial<SlaCycle['state']> | null;

  return state?.terms?.config?.goals?.find((goal) => goal.id === state.goal_id)
    ?.calendar_revision_id;
}

/** Same precedence as SlaResultsService.present(): error → invalid, unlinked → n/a, active → paused/running. */
function slaStateLabel(
  cycle: Pick<SlaCycle, 'state' | 'lifecycle'>,
): string | null {
  const state = cycle.state as Partial<SlaCycle['state']> | null;
  if (state?.error) return 'Invalid';
  if (state?.not_applicable_reason === 'request_unlinked') {
    return 'Not applicable';
  }
  if (cycle.lifecycle === 'active') return state?.paused ? 'Paused' : 'Running';

  return cycle.lifecycle ? humanizeValue(cycle.lifecycle) : null;
}

const SLA_OUTCOME_LABELS: Record<string, string> = {
  met: 'Met',
  breached: 'Breached',
  pending: 'Pending',
};

function slaOutcomeLabel(outcome: string | null): string {
  const value = outcome ?? 'pending';

  return SLA_OUTCOME_LABELS[value] ?? humanizeValue(value);
}
