/**
 * @fileoverview Builds the space overview: the modules a user can open and the
 * latest records across them. The client is service-role, so every query is
 * scoped by space and organization here and every record rule is re-applied.
 * @module src/spaces/overview/space-overview.service
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { SpacesService } from '../spaces.service';
import { ACTIVE_SPACE_MODULE_TYPES_SET } from '../space-module-types';
import { PermissionsService } from '../../permissions/permissions.service';
import { EntitlementsService } from '../../licensing/entitlements.service';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import {
  ALLOWED_ORGANIZATION_MODULES,
  type OrganizationModuleType,
} from '../../organization-modules/module-feature-map';
import { WikiPermissionsService } from '../../wiki/wiki-permissions.service';
import { AssetObjectTypesService } from '../../assets-objects/asset-object-types.service';
import { DashboardsService } from '../../dashboards/dashboards.service';
import { FileExplorerAccessService } from '../../file-explorer/file-explorer-access.service';
import { FileExplorerService } from '../../file-explorer/file-explorer.service';
import type { IFeNode } from '../../file-explorer/interfaces/fe-node.interface';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type {
  OverviewModule,
  OverviewSpaceInfo,
  OverviewStorage,
  OverviewStorageModule,
  OverviewStoragePathItem,
  OverviewStorageRecord,
  OverviewUpdate,
  OverviewUser,
  OverviewUpdateType,
  SpaceOverview,
} from './space-overview.types';

// Mirrors MODULE_VIEW_PERMISSION in the frontend SpaceSubMenuItem.tsx exactly.
const VIEW_KEY: Record<string, string> = {
  processes: 'view_processes',
  tasks: 'view_tasks',
  boards: 'view_boards',
  wiki: 'view_wiki_pages',
  lists: 'view_lists',
  dashboards: 'view_dashboards',
  robot: 'view_robot',
  gdpr: 'view_gdpr',
  risk: 'view_risk',
  plans: 'view_plans',
  automations: 'view_automations',
  assets: 'view_assets',
  file_explorer: 'view_file_explorer',
  form_builder: 'view_forms',
  resource_planning: 'can_view_resource_planning',
};

//  restricted users can see fewer than 10 when most of a type's newest rows are hidden; raise k or add a per-type cursor if that matters.
const LIMIT_PLAIN = 10;
const LIMIT_RULED = 25;
const TOTAL = 10;
const MEMBER_PREVIEW = 5;
const STORAGE_PAGE = 1000;
const STORAGE_RECORD_LIMIT = 50;
const ID_CHUNK = 200;

// Modules whose records can be listed by attachment size, with the shared-attachment entity type.
const STORAGE_RECORD_MODULES: Record<
  string,
  { type: OverviewUpdateType; entity: string | null; orgKey?: string }
> = {
  tasks: { type: 'task', entity: 'task', orgKey: 'can_view_tasks' },
  processes: {
    type: 'process',
    entity: 'process',
    orgKey: 'can_view_processes',
  },
  wiki: { type: 'wiki', entity: 'wiki_page' },
  lists: { type: 'list_item', entity: 'asset_item', orgKey: 'can_view_lists' },
  assets: { type: 'asset', entity: 'asset_object' },
  file_explorer: { type: 'file', entity: null },
};

// Older per-module attachment tables, keyed by module, with the column naming the record.
const STORAGE_LEGACY: Record<
  string,
  { table: string; parent: string; fk: string; idColumn: string }[]
> = {
  tasks: [
    {
      table: 'task_attachments',
      parent: 'tasks',
      fk: 'task_attachments_task_id_fkey',
      idColumn: 'task_id',
    },
  ],
  processes: [
    {
      table: 'process_attachments',
      parent: 'business_processes',
      fk: 'process_attachments_process_id_fkey',
      idColumn: 'process_id',
    },
  ],
  wiki: [
    {
      table: 'wiki_attachments',
      parent: 'wiki_pages',
      fk: 'wiki_attachments_wiki_page_id_fkey',
      idColumn: 'wiki_page_id',
    },
    {
      table: 'wiki_page_attachments',
      parent: 'wiki_pages',
      fk: 'wiki_page_attachments_wiki_page_id_fkey',
      idColumn: 'wiki_page_id',
    },
  ],
  lists: [
    {
      table: 'asset_item_attachments',
      parent: 'asset_items',
      fk: 'asset_item_attachments_item_id_fkey',
      idColumn: 'item_id',
    },
  ],
  assets: [],
};

interface StorageTotal {
  bytes: number;
  files: Set<string>;
}

// parent: the record's parent row; ancestors: File Explorer folder ids, top first; path: already resolved.
type StorageDetail = Pick<OverviewStorageRecord, 'title' | 'key' | 'ref'> & {
  parent?: string | null;
  ancestors?: string[];
  path?: OverviewStoragePathItem[];
};

// Parent tables walked upward for the storage tree, with the column naming each row's parent.
const STORAGE_PARENTS: Record<
  string,
  { table: string; columns: string; parent: string }
> = {
  tasks: {
    table: 'tasks',
    columns: 'id, key, summary, parent_task_id',
    parent: 'parent_task_id',
  },
  processes: {
    table: 'business_processes',
    columns: 'id, key, title, parent_id',
    parent: 'parent_id',
  },
  wiki: {
    table: 'wiki_pages',
    columns: 'id, title, created_by, path, parent_id',
    parent: 'parent_id',
  },
};
const STORAGE_PATH_DEPTH = 6;

// Typed as string so the joined select stays checkable. The FK is named because
// file_attachments.current_version_id links the two tables a second way.
const STORAGE_SHARED_COLUMNS: string =
  'attachment_id, file_size, file_attachments!file_versions_attachment_id_fkey!inner(entity_type, space_id, organization_id)';

interface UserRow {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
}
const NEW_WINDOW_MS = 2000;

interface Ctx {
  user: RequestUser;
  spaceId: string;
  orgId: string;
}

interface BaseRow {
  id: string;
  created_at: string | null;
  updated_at: string;
  updated_by?: string | null;
}

type RawUpdate = Omit<OverviewUpdate, 'updated_by' | 'is_new'> & {
  updated_by_id: string | null;
};

interface UpdateOpts {
  key?: unknown;
  status?: unknown;
  color?: string | null;
  context?: string | null;
  ref?: Partial<OverviewUpdate['ref']>;
}

type QueryResult = PromiseLike<{
  data: unknown;
  error: { message: string } | null;
}>;

const clean = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

const isOrgModuleType = (t: string): t is OrganizationModuleType =>
  (ALLOWED_ORGANIZATION_MODULES as readonly string[]).includes(t);

@Injectable()
export class SpaceOverviewService {
  private readonly logger = new Logger(SpaceOverviewService.name);

  private readonly fetchers: Record<string, (c: Ctx) => Promise<RawUpdate[]>> =
    {
      tasks: (c) => this.tasks(c),
      wiki: (c) => this.wiki(c),
      assets: (c) => this.assets(c),
      lists: (c) => this.listItems(c),
      automations: (c) => this.automations(c),
      processes: (c) => this.processes(c),
      plans: (c) => this.plans(c),
      boards: (c) => this.boards(c),
      form_builder: (c) => this.forms(c),
      dashboards: (c) => this.dashboards(c),
      file_explorer: (c) => this.files(c),
    };

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly spacesService: SpacesService,
    private readonly permissionsService: PermissionsService,
    private readonly entitlementsService: EntitlementsService,
    private readonly organizationModulesService: OrganizationModulesService,
    private readonly wikiPermissionsService: WikiPermissionsService,
    private readonly assetObjectTypesService: AssetObjectTypesService,
    private readonly dashboardsService: DashboardsService,
    private readonly fileExplorerAccessService: FileExplorerAccessService,
    private readonly fileExplorerService: FileExplorerService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Returns the caller's visible modules and the latest updates across them.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} spaceId - Space UUID
   * @returns {Promise<SpaceOverview>} Visible modules and latest updates
   * @throws {NotFoundException} When the space is not in the caller's organization
   */
  async getOverview(
    user: RequestUser,
    spaceId: string,
  ): Promise<SpaceOverview> {
    const orgId = user.organizationId;
    const empty: SpaceOverview = {
      space_id: spaceId,
      modules: [],
      latest_updates: [],
    };

    if (await this.permissionsService.isViewSpaceDenied(user.userId, orgId)) {
      return empty;
    }

    const { data: space, error } = await this.db
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', orgId)
      .maybeSingle();

    if (error || !space) throw new NotFoundException('Space not found');

    const ctx: Ctx = { user, spaceId, orgId };
    const modules = await this.visibleModules(ctx);

    // Task counts follow the same gate as task updates: module visible plus the org permission
    const tasksVisible =
      modules.some((m) => m.module_type === 'tasks') &&
      (await this.hasOrgPermission(ctx, 'can_view_tasks'));
    const infoPromise = this.spaceInfo(ctx, tasksVisible);

    // Owners and admins see every record, so restricted modules can be counted for them too
    const seesAll = await this.permissionsService.isAdminOrOwner(
      user.userId,
      orgId,
    );
    const storagePromise = this.spaceStorage(ctx, modules, seesAll);
    const countsPromise = Promise.all(
      modules.map((m) =>
        this.moduleCount(ctx, m.module_type, seesAll).catch((err: Error) => {
          this.logger.warn(
            `Overview ${m.module_type} count skipped: ${err.message}`,
          );

          return null;
        }),
      ),
    );
    const settled = await Promise.all(
      modules.map(async (m) => {
        const fetcher = this.fetchers[m.module_type];
        if (!fetcher) return [];

        try {
          return await fetcher(ctx);
        } catch (err) {
          this.logger.warn(
            `Overview ${m.module_type} skipped for space ${spaceId}: ${(err as Error).message}`,
          );

          return [];
        }
      }),
    );

    const latest = settled
      .flat()
      .sort(
        (a, b) =>
          Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
          (b.id > a.id ? 1 : b.id < a.id ? -1 : 0),
      )
      .slice(0, TOTAL);

    // Each module's rows are already permission-filtered and newest first, so their max is its last change.
    const withLastUpdated = modules.map((m, index) => ({
      ...m,
      last_updated_at: settled[index].reduce<string | null>(
        (newest, row) =>
          !newest || Date.parse(row.updated_at) > Date.parse(newest)
            ? row.updated_at
            : newest,
        null,
      ),
    }));

    const counts = await countsPromise;
    const subCounts = await Promise.all(
      modules.map((m) =>
        this.subRecordCount(ctx, m.module_type, seesAll).catch((err: Error) => {
          this.logger.warn(
            `Overview ${m.module_type} sub-record count skipped: ${err.message}`,
          );

          return null;
        }),
      ),
    );

    return {
      space_id: spaceId,
      modules: withLastUpdated.map((m, index) => ({
        ...m,
        record_count: counts[index],
        sub_record_count: subCounts[index],
      })),
      latest_updates: await this.withUsers(latest),
      space_info: await infoPromise.then(async (info) =>
        info ? { ...info, storage: await storagePromise } : info,
      ),
    };
  }

  /**
   * How many records a module holds, with the same filters and org gates as its update feed.
   * Modules with per-record restrictions return null, so items hidden from the caller are never counted.
   */
  private async moduleCount(
    c: Ctx,
    type: string,
    seesAll: boolean,
  ): Promise<number | null> {
    const base = (table: string) =>
      this.db
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('space_id', c.spaceId)
        .eq('organization_id', c.orgId);
    const total = async (
      query: PromiseLike<{
        count: number | null;
        error: { message: string } | null;
      }>,
    ) => {
      const { count, error } = await query;

      if (error) throw new Error(error.message);

      return count ?? 0;
    };

    switch (type) {
      case 'tasks':
        return (await this.hasOrgPermission(c, 'can_view_tasks'))
          ? total(base('tasks'))
          : null;
      case 'processes':
        return (await this.hasOrgPermission(c, 'can_view_processes'))
          ? total(base('business_processes'))
          : null;
      case 'lists':
        return (await this.hasOrgPermission(c, 'can_view_lists'))
          ? total(base('asset_items').eq('is_archived', false))
          : null;
      case 'automations':
        return total(base('automations').eq('is_archived', false));
      case 'form_builder':
        return total(
          base('form_builder')
            .eq('is_deleted', false)
            .eq('is_template', false)
            .neq('status', 'archived'),
        );
      default:
        break;
    }

    // Modules with per-record restrictions: counted only for people who see every record
    if (!seesAll) return null;

    switch (type) {
      case 'wiki':
        return total(
          base('wiki_pages')
            .eq('is_archived', false)
            .or('metadata->>is_folder.is.null,metadata->>is_folder.neq.true'),
        );
      case 'assets':
        return total(base('asset_objects').eq('is_archived', false));
      case 'plans':
        return total(base('plans').eq('is_archived', false));
      case 'boards':
        return total(base('boards').eq('is_archived', false));
      case 'dashboards':
        return total(base('dashboards').is('deleted_at', null));
      case 'file_explorer':
        return total(
          base('fe_nodes').eq('is_deleted', false).eq('node_type', 'file'),
        );
      default:
        return null;
    }
  }

  /**
   * Bytes this space holds, per module: File Explorer (its own meter, quota included), the shared
   * attachments table (every version) and the older per-module attachment tables. Only modules the
   * caller can see are included; any failure leaves storage out instead of failing the overview.
   */
  private async spaceStorage(
    c: Ctx,
    modules: OverviewModule[],
    seesAll: boolean,
  ): Promise<OverviewStorage | null> {
    try {
      const visible = new Set(modules.map((m) => m.module_type));
      const orgGate: Record<string, string> = {
        tasks: 'can_view_tasks',
        processes: 'can_view_processes',
        lists: 'can_view_lists',
      };
      const readable = new Set<string>();

      for (const type of visible) {
        if (!orgGate[type] || (await this.hasOrgPermission(c, orgGate[type]))) {
          readable.add(type);
        }
      }

      const totals = new Map<string, { bytes: number; files: Set<string> }>();
      const add = (type: string, id: string, bytes: unknown) => {
        if (!readable.has(type)) return;

        const entry = totals.get(type) ?? {
          bytes: 0,
          files: new Set<string>(),
        };

        entry.bytes += Number(bytes) || 0;
        entry.files.add(id);
        totals.set(type, entry);
      };

      let quota: number | null = null;
      let explorerFiles = 0;
      let explorerBytes = 0;

      if (readable.has('file_explorer')) {
        const usage = await this.fileExplorerService.getStorageUsage(
          c.user,
          c.spaceId,
        );

        explorerBytes = usage.used_bytes;
        explorerFiles = usage.file_count;
        quota = await this.configuredExplorerQuota(c);
      }

      // Shared attachments: every stored version counts, attributed to the record's module.
      const attachmentModule: Record<string, string> = {
        task: 'tasks',
        process: 'processes',
        wiki_page: 'wiki',
        asset_item: 'lists',
        asset_object: 'assets',
        space_gdpr_record: 'gdpr',
      };

      for (const row of await this.allRows<{
        attachment_id: string;
        file_size: number | null;
        file_attachments: { entity_type: string } | null;
      }>((from, to) =>
        this.db
          .from('file_versions')
          .select(STORAGE_SHARED_COLUMNS)
          .eq('file_attachments.space_id', c.spaceId)
          .eq('file_attachments.organization_id', c.orgId)
          .order('id', { ascending: true })
          .range(from, to),
      )) {
        const type = attachmentModule[row.file_attachments?.entity_type ?? ''];

        if (type) add(type, row.attachment_id, row.file_size);
      }

      // Older per-module attachment tables, scoped through their parent record.
      const legacy: {
        type: string;
        table: string;
        parent: string;
        fk: string;
      }[] = [
        {
          type: 'tasks',
          table: 'task_attachments',
          parent: 'tasks',
          fk: 'task_attachments_task_id_fkey',
        },
        {
          type: 'processes',
          table: 'process_attachments',
          parent: 'business_processes',
          fk: 'process_attachments_process_id_fkey',
        },
        {
          type: 'wiki',
          table: 'wiki_attachments',
          parent: 'wiki_pages',
          fk: 'wiki_attachments_wiki_page_id_fkey',
        },
        {
          type: 'wiki',
          table: 'wiki_page_attachments',
          parent: 'wiki_pages',
          fk: 'wiki_page_attachments_wiki_page_id_fkey',
        },
        {
          type: 'lists',
          table: 'asset_item_attachments',
          parent: 'asset_items',
          fk: 'asset_item_attachments_item_id_fkey',
        },
      ];

      await Promise.all(
        legacy
          .filter((l) => readable.has(l.type))
          .map(async (l) => {
            const columns: string = `id, file_size, ${l.parent}!${l.fk}!inner(space_id, organization_id)`;

            for (const row of await this.allRows<{
              id: string;
              file_size: number | null;
            }>((from, to) =>
              this.db
                .from(l.table)
                .select(columns)
                .eq(`${l.parent}.space_id`, c.spaceId)
                .eq(`${l.parent}.organization_id`, c.orgId)
                .order('id', { ascending: true })
                .range(from, to),
            )) {
              add(l.type, `${l.table}:${row.id}`, row.file_size);
            }
          }),
      );

      if (readable.has('assets')) {
        for (const row of await this.allRows<{
          id: string;
          file_size: number | null;
        }>((from, to) =>
          this.db
            .from('asset_object_attachments')
            .select('id, file_size')
            .eq('space_id', c.spaceId)
            .eq('organization_id', c.orgId)
            .order('id', { ascending: true })
            .range(from, to),
        )) {
          add('assets', `asset_object_attachments:${row.id}`, row.file_size);
        }
      }

      // Record sizes from the database function; absent until its migration is applied
      const recordSizes = await this.recordStorage(c);
      const restricted = new Set([
        'wiki',
        'assets',
        'plans',
        'boards',
        'dashboards',
        'file_explorer',
      ]);
      const recordOf = (type: string) => {
        if (!recordSizes || !readable.has(type)) return null;
        if (restricted.has(type) && !seesAll) return null;

        return recordSizes.get(type) ?? null;
      };

      const types = new Set<string>([...totals.keys()]);

      if (readable.has('file_explorer')) types.add('file_explorer');
      for (const type of readable) if (recordOf(type)) types.add(type);

      const breakdown: OverviewStorageModule[] = [...types].map(
        (module_type) => {
          const files = totals.get(module_type);
          const isExplorer = module_type === 'file_explorer';
          const record = recordOf(module_type);

          return {
            module_type,
            bytes: isExplorer ? explorerBytes : (files?.bytes ?? 0),
            files: isExplorer ? explorerFiles : (files?.files.size ?? 0),
            record_bytes: record?.bytes ?? null,
            records: record?.count ?? null,
          };
        },
      );
      const sizeOf = (m: OverviewStorageModule) =>
        m.bytes + (m.record_bytes ?? 0);

      breakdown.sort((a, b) => sizeOf(b) - sizeOf(a));

      const attachmentsBytes = breakdown.reduce((sum, m) => sum + m.bytes, 0);
      const recordsBytes = breakdown.some((m) => m.record_bytes !== null)
        ? breakdown.reduce((sum, m) => sum + (m.record_bytes ?? 0), 0)
        : null;

      return {
        total_bytes: attachmentsBytes + (recordsBytes ?? 0),
        file_count: breakdown.reduce((sum, m) => sum + m.files, 0),
        attachments_bytes: attachmentsBytes,
        records_bytes: recordsBytes,
        modules: breakdown,
        file_explorer_quota_bytes: quota,
      };
    } catch (err) {
      this.logger.warn(
        `Overview storage skipped for space ${c.spaceId}: ${(err as Error).message}`,
      );

      return null;
    }
  }

  // Only a limit set on this space's File Explorer module; the built-in default is not a real limit.
  private async configuredExplorerQuota(c: Ctx): Promise<number | null> {
    const result: {
      data: { settings: { fe_storage_quota_bytes?: unknown } | null } | null;
      error: { message: string } | null;
    } = await this.db
      .from('space_modules')
      .select('settings')
      .eq('space_id', c.spaceId)
      .eq('module_type', 'file_explorer')
      .maybeSingle();

    if (result.error) return null;

    const quota = Number(result.data?.settings?.fe_storage_quota_bytes);

    return Number.isFinite(quota) && quota > 0 ? quota : null;
  }

  // Per-module record size and count; null when the database function is not installed yet.
  private async recordStorage(
    c: Ctx,
  ): Promise<Map<string, { bytes: number; count: number }> | null> {
    const result: { data: unknown; error: { message: string } | null } =
      await this.db.rpc('space_record_storage', {
        p_space_id: c.spaceId,
        p_org_id: c.orgId,
      });
    const { data, error } = result;

    if (error) {
      this.logger.warn(`Overview record storage unavailable: ${error.message}`);

      return null;
    }

    const sizes = new Map<string, { bytes: number; count: number }>();

    for (const row of (data ?? []) as {
      module_type: string;
      record_count: number | string;
      record_bytes: number | string;
    }[]) {
      sizes.set(row.module_type, {
        bytes: Number(row.record_bytes) || 0,
        count: Number(row.record_count) || 0,
      });
    }

    return sizes;
  }

  // Reads every page of a query (the API caps a request at 1000 rows).
  private async allRows<T>(
    page: (from: number, to: number) => QueryResult,
  ): Promise<T[]> {
    const out: T[] = [];

    for (let from = 0; ; from += STORAGE_PAGE) {
      const rows = await this.rows<T>(page(from, from + STORAGE_PAGE - 1));

      out.push(...rows);

      if (rows.length < STORAGE_PAGE) return out;
    }
  }

  /** Whether a module type has records that can appear in Latest updates. */
  isUpdateModule(module: string): boolean {
    return Object.keys(this.fetchers).includes(module);
  }

  /**
   * The newest records of one module, with the same gates as the overview: view-space denial,
   * the space's organization, module visibility and the module's own record rules.
   */
  async getModuleUpdates(
    user: RequestUser,
    spaceId: string,
    module: string,
  ): Promise<OverviewUpdate[]> {
    const orgId = user.organizationId;

    if (await this.permissionsService.isViewSpaceDenied(user.userId, orgId)) {
      return [];
    }

    const { data: space, error } = await this.db
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', orgId)
      .maybeSingle();

    if (error || !space) throw new NotFoundException('Space not found');

    const ctx: Ctx = { user, spaceId, orgId };
    const visible = await this.visibleModules(ctx);

    if (!visible.some((m) => m.module_type === module)) return [];

    const rows = await this.fetchers[module](ctx);

    return this.withUsers(
      rows
        .sort(
          (a, b) =>
            Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
            (b.id > a.id ? 1 : b.id < a.id ? -1 : 0),
        )
        .slice(0, TOTAL),
    );
  }

  /** Whether a module type can list its records by attachment size. */
  isStorageModule(module: string): boolean {
    return Object.keys(STORAGE_RECORD_MODULES).includes(module);
  }

  /**
   * The records of one module that hold the most attachment bytes, with the same gates as the
   * module's updates: view-space denial, the space's organization, module visibility, the org
   * permission and each record's own rule. Records the caller cannot see are dropped.
   */
  async getStorageRecords(
    user: RequestUser,
    spaceId: string,
    module: string,
  ): Promise<OverviewStorageRecord[]> {
    const orgId = user.organizationId;
    const config = STORAGE_RECORD_MODULES[module];

    if (!config) return [];
    if (await this.permissionsService.isViewSpaceDenied(user.userId, orgId)) {
      return [];
    }

    const { data: space, error } = await this.db
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', orgId)
      .maybeSingle();

    if (error || !space) throw new NotFoundException('Space not found');

    const ctx: Ctx = { user, spaceId, orgId };
    const visible = await this.visibleModules(ctx);

    if (!visible.some((m) => m.module_type === module)) return [];
    if (config.orgKey && !(await this.hasOrgPermission(ctx, config.orgKey))) {
      return [];
    }

    const totals =
      module === 'file_explorer'
        ? await this.explorerTotals(ctx)
        : await this.attachmentTotals(ctx, module, config.entity);

    if (totals.size === 0) return [];

    // details load for every record with files so hidden ones never shrink the list; page by bytes if a space holds thousands.
    const details = await this.storageDetails(ctx, module, [...totals.keys()]);

    const top = [...details]
      .map(([id, d]) => {
        const total = totals.get(id);

        return {
          id,
          type: config.type,
          module_type: module,
          title: d.title,
          key: d.key,
          files: total?.files.size ?? 0,
          bytes: total?.bytes ?? 0,
          ref: d.ref,
          path: [] as OverviewStoragePathItem[],
        };
      })
      .sort(
        (a, b) =>
          b.bytes - a.bytes || (a.title ?? '').localeCompare(b.title ?? ''),
      )
      .slice(0, STORAGE_RECORD_LIMIT);
    const paths = await this.storagePaths(
      ctx,
      module,
      top.map((r) => r.id),
      details,
    );

    return top.map((r) => ({ ...r, path: paths.get(r.id) ?? [] }));
  }

  // Ancestor chain of each record, top first; a failed lookup leaves every path empty.
  private async storagePaths(
    c: Ctx,
    module: string,
    ids: string[],
    details: Map<string, StorageDetail>,
  ): Promise<Map<string, OverviewStoragePathItem[]>> {
    const out = new Map<string, OverviewStoragePathItem[]>();

    try {
      if (module === 'file_explorer') {
        const folderIds = [
          ...new Set(ids.flatMap((id) => details.get(id)?.ancestors ?? [])),
        ];
        const folders = (
          await this.rowsByIds<{
            id: string;
            organization_id: string;
            space_id: string;
            ancestor_ids: string[] | null;
            node_type: string;
            name: string | null;
            is_deleted: boolean | null;
          }>(
            c,
            'fe_nodes',
            'id, organization_id, space_id, ancestor_ids, node_type, name, is_deleted',
            folderIds,
          )
        ).filter((f) => f.node_type === 'folder' && f.is_deleted !== true);
        const viewable = await Promise.all(
          folders.map((f) =>
            this.fileExplorerAccessService
              // Only id, organization_id, space_id and ancestor_ids are read.
              .resolveEffectivePermission(c.user, f as unknown as IFeNode)
              .then(
                (p) => p.canView,
                () => false,
              ),
          ),
        );
        const items = new Map(
          folders.map((f, i) => [
            f.id,
            viewable[i]
              ? { id: f.id, label: clean(f.name), restricted: false }
              : { id: f.id, label: null, restricted: true },
          ]),
        );

        for (const id of ids) {
          out.set(
            id,
            (details.get(id)?.ancestors ?? []).map(
              (a) => items.get(a) ?? { id: a, label: null, restricted: true },
            ),
          );
        }

        return out;
      }

      const walk = STORAGE_PARENTS[module];

      if (!walk) {
        for (const id of ids) out.set(id, details.get(id)?.path ?? []);

        return out;
      }

      const nodes = new Map<
        string,
        OverviewStoragePathItem & { parent: string | null }
      >();
      let pending = [
        ...new Set(
          ids
            .map((id) => details.get(id)?.parent)
            .filter((p): p is string => Boolean(p)),
        ),
      ];

      for (
        let depth = 0;
        depth < STORAGE_PATH_DEPTH && pending.length;
        depth++
      ) {
        const rows = await this.rowsByIds<Record<string, unknown>>(
          c,
          walk.table,
          walk.columns,
          pending,
        );
        const visible =
          module === 'wiki'
            ? new Set(
                (
                  (await this.wikiPermissionsService.filterAccessiblePages(
                    rows,
                    c.user.userId,
                    c.spaceId,
                  )) as { id: string }[]
                ).map((r) => r.id),
              )
            : null;

        for (const r of rows) {
          const id = String(r.id);
          const key = clean(r.key);
          const name = clean(module === 'tasks' ? r.summary : r.title);
          const parent =
            typeof r[walk.parent] === 'string' ? String(r[walk.parent]) : null;

          nodes.set(
            id,
            visible && !visible.has(id)
              ? { id, label: null, restricted: true, parent }
              : {
                  id,
                  label: key && name ? `${key} · ${name}` : (name ?? key),
                  restricted: false,
                  parent,
                },
          );
        }
        pending = [
          ...new Set(
            rows
              .map((r) => r[walk.parent])
              .filter(
                (p): p is string => typeof p === 'string' && !nodes.has(p),
              ),
          ),
        ];
      }

      for (const id of ids) {
        const chain: OverviewStoragePathItem[] = [];
        let at = details.get(id)?.parent ?? null;

        while (at && chain.length < STORAGE_PATH_DEPTH) {
          const n = nodes.get(at);

          if (!n || n.id === id || chain.some((x) => x.id === n.id)) break;
          chain.unshift({ id: n.id, label: n.label, restricted: n.restricted });
          at = n.parent;
        }
        out.set(id, chain);
      }
    } catch (err) {
      this.logger.warn(
        `Overview storage records ${module} paths skipped for space ${c.spaceId}: ${(err as Error).message}`,
      );
      out.clear();
    }

    return out;
  }

  // Attachment bytes per record from the shared table and the module's older tables.
  private async attachmentTotals(
    c: Ctx,
    module: string,
    entity: string | null,
  ): Promise<Map<string, StorageTotal>> {
    const totals = new Map<string, StorageTotal>();
    const add = (recordId: unknown, fileId: string, bytes: unknown) => {
      if (typeof recordId !== 'string') return;

      const entry = totals.get(recordId) ?? { bytes: 0, files: new Set() };

      entry.bytes += Number(bytes) || 0;
      entry.files.add(fileId);
      totals.set(recordId, entry);
    };
    const source = async (name: string, load: () => Promise<void>) => {
      try {
        await load();
      } catch (err) {
        this.logger.warn(
          `Overview storage records ${name} skipped for space ${c.spaceId}: ${(err as Error).message}`,
        );
      }
    };
    const sharedColumns: string =
      'attachment_id, file_size, file_attachments!file_versions_attachment_id_fkey!inner(entity_type, entity_id, space_id, organization_id)';

    await Promise.all([
      entity
        ? source('file_versions', async () => {
            for (const row of await this.allRows<{
              attachment_id: string;
              file_size: number | null;
              file_attachments: { entity_id: string | null } | null;
            }>((from, to) =>
              this.db
                .from('file_versions')
                .select(sharedColumns)
                .eq('file_attachments.entity_type', entity)
                .eq('file_attachments.space_id', c.spaceId)
                .eq('file_attachments.organization_id', c.orgId)
                .order('id', { ascending: true })
                .range(from, to),
            )) {
              add(
                row.file_attachments?.entity_id,
                row.attachment_id,
                row.file_size,
              );
            }
          })
        : Promise.resolve(),
      ...(STORAGE_LEGACY[module] ?? []).map((l) =>
        source(l.table, async () => {
          const columns: string = `id, ${l.idColumn}, file_size, ${l.parent}!${l.fk}!inner(space_id, organization_id)`;

          for (const row of await this.allRows<Record<string, unknown>>(
            (from, to) =>
              this.db
                .from(l.table)
                .select(columns)
                .eq(`${l.parent}.space_id`, c.spaceId)
                .eq(`${l.parent}.organization_id`, c.orgId)
                .order('id', { ascending: true })
                .range(from, to),
          )) {
            add(row[l.idColumn], `${l.table}:${String(row.id)}`, row.file_size);
          }
        }),
      ),
      module === 'assets'
        ? source('asset_object_attachments', async () => {
            for (const row of await this.allRows<{
              id: string;
              object_id: string | null;
              file_size: number | null;
            }>((from, to) =>
              this.db
                .from('asset_object_attachments')
                .select('id, object_id, file_size')
                .eq('space_id', c.spaceId)
                .eq('organization_id', c.orgId)
                .order('id', { ascending: true })
                .range(from, to),
            )) {
              add(
                row.object_id,
                `asset_object_attachments:${row.id}`,
                row.file_size,
              );
            }
          })
        : Promise.resolve(),
    ]);

    return totals;
  }

  // Each File Explorer file is a record; bytes and files count its active versions, as the meter does.
  private async explorerTotals(c: Ctx): Promise<Map<string, StorageTotal>> {
    const totals = new Map<string, StorageTotal>();
    const columns: string =
      'id, node_id, file_size, fe_nodes!fe_versions_node_id_fkey!inner(space_id, organization_id)';

    try {
      for (const row of await this.allRows<{
        id: string;
        node_id: string;
        file_size: number | null;
      }>((from, to) =>
        this.db
          .from('fe_versions')
          .select(columns)
          .eq('upload_status', 'active')
          .eq('fe_nodes.space_id', c.spaceId)
          .eq('fe_nodes.organization_id', c.orgId)
          .order('id', { ascending: true })
          .range(from, to),
      )) {
        const entry = totals.get(row.node_id) ?? {
          bytes: 0,
          files: new Set<string>(),
        };

        entry.bytes += Number(row.file_size) || 0;
        entry.files.add(row.id);
        totals.set(row.node_id, entry);
      }
    } catch (err) {
      this.logger.warn(
        `Overview storage records fe_versions skipped for space ${c.spaceId}: ${(err as Error).message}`,
      );
    }

    return totals;
  }

  // Rows of a table for the given ids, scoped to the space and organization, read in chunks.
  private async rowsByIds<T>(
    c: Ctx,
    table: string,
    columns: string,
    ids: string[],
  ): Promise<T[]> {
    const out: T[] = [];

    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      out.push(
        ...(await this.rows<T>(
          this.db
            .from(table)
            .select(columns)
            .in('id', ids.slice(i, i + ID_CHUNK))
            .eq('space_id', c.spaceId)
            .eq('organization_id', c.orgId),
        )),
      );
    }

    return out;
  }

  // Title, key and link target for each id the caller may see; records it may not see are left out.
  private async storageDetails(
    c: Ctx,
    module: string,
    ids: string[],
  ): Promise<Map<string, StorageDetail>> {
    const out = new Map<string, StorageDetail>();
    const set = (
      id: string,
      title: unknown,
      key: unknown,
      ref: Partial<OverviewStorageRecord['ref']> = {},
      up: Pick<StorageDetail, 'parent' | 'ancestors' | 'path'> = {},
    ) => {
      const k = clean(key);

      out.set(id, {
        title: clean(title),
        key: k,
        ref: { id, key: k, ...ref },
        ...up,
      });
    };

    try {
      switch (module) {
        case 'tasks':
          for (const r of await this.rowsByIds<{
            id: string;
            key: string | null;
            summary: string | null;
            parent_task_id: string | null;
          }>(c, 'tasks', 'id, key, summary, parent_task_id', ids)) {
            set(r.id, r.summary, r.key, {}, { parent: r.parent_task_id });
          }
          break;
        case 'processes':
          for (const r of await this.rowsByIds<{
            id: string;
            key: string | null;
            title: string | null;
            parent_id: string | null;
          }>(c, 'business_processes', 'id, key, title, parent_id', ids)) {
            set(r.id, r.title, r.key, {}, { parent: r.parent_id });
          }
          break;
        case 'wiki': {
          const rows = await this.rowsByIds<{
            id: string;
            title: string | null;
            created_by: string | null;
            path: string[] | null;
            parent_id: string | null;
          }>(c, 'wiki_pages', 'id, title, created_by, path, parent_id', ids);
          const allowed =
            (await this.wikiPermissionsService.filterAccessiblePages(
              rows,
              c.user.userId,
              c.spaceId,
            )) as typeof rows;

          for (const r of allowed) {
            set(r.id, r.title, null, {}, { parent: r.parent_id });
          }
          break;
        }
        case 'lists': {
          const rows = await this.rowsByIds<{
            id: string;
            title: string | null;
            schema_id: string;
          }>(c, 'asset_items', 'id, title, schema_id', ids);
          const schemas = await this.rowsByIds<{
            id: string;
            key: string | null;
            name: string | null;
          }>(c, 'asset_schemas', 'id, key, name', [
            ...new Set(rows.map((r) => r.schema_id)),
          ]);
          const schemaKey = new Map(schemas.map((s) => [s.id, clean(s.key)]));
          const schemaName = new Map(schemas.map((s) => [s.id, clean(s.name)]));

          for (const r of rows) {
            if (!schemaKey.has(r.schema_id)) continue;

            set(
              r.id,
              r.title,
              null,
              { schema_key: schemaKey.get(r.schema_id) },
              {
                path: [
                  {
                    id: r.schema_id,
                    label: schemaName.get(r.schema_id) ?? null,
                    restricted: false,
                  },
                ],
              },
            );
          }
          break;
        }
        case 'assets': {
          const rows = await this.rowsByIds<{
            id: string;
            name: string | null;
            object_key: string | null;
            schema_id: string;
            object_type_id: string | null;
          }>(
            c,
            'asset_objects',
            'id, name, object_key, schema_id, object_type_id',
            ids,
          );
          const typeIds = [
            ...new Set(
              rows
                .map((r) => r.object_type_id)
                .filter((t): t is string => Boolean(t)),
            ),
          ];
          const [viewable, schemas] = await Promise.all([
            Promise.all(
              typeIds.map((typeId) =>
                this.assetObjectTypesService
                  .getMyPermission(typeId, c.spaceId, c.orgId, c.user.userId)
                  .then(
                    (perm) => (perm.can_view ? typeId : null),
                    () => null,
                  ),
              ),
            ),
            this.rowsByIds<{
              id: string;
              object_key: string | null;
              name: string | null;
            }>(c, 'asset_object_schemas', 'id, object_key, name', [
              ...new Set(rows.map((r) => r.schema_id)),
            ]),
          ]);
          const allowedTypes = new Set(viewable.filter(Boolean));
          const schemaName = new Map(schemas.map((s) => [s.id, clean(s.name)]));
          const schemaKey = new Map(
            schemas.map((s) => [
              s.id,
              clean(s.object_key)?.toLowerCase() ?? null,
            ]),
          );

          for (const r of rows) {
            if (!r.object_type_id || !allowedTypes.has(r.object_type_id)) {
              continue;
            }
            if (!schemaKey.has(r.schema_id)) continue;

            set(
              r.id,
              r.name,
              r.object_key,
              { schema_key: schemaKey.get(r.schema_id) },
              {
                path: [
                  {
                    id: r.schema_id,
                    label: schemaName.get(r.schema_id) ?? null,
                    restricted: false,
                  },
                ],
              },
            );
          }
          break;
        }
        case 'file_explorer': {
          const rows = (
            await this.rowsByIds<{
              id: string;
              organization_id: string;
              space_id: string;
              parent_id: string | null;
              ancestor_ids: string[] | null;
              node_type: string;
              name: string | null;
              is_deleted: boolean | null;
            }>(
              c,
              'fe_nodes',
              'id, organization_id, space_id, parent_id, ancestor_ids, node_type, name, is_deleted',
              ids,
            )
          ).filter((r) => r.node_type === 'file' && r.is_deleted !== true);
          const allowed = await Promise.all(
            rows.map((r) =>
              this.fileExplorerAccessService
                // Only id, organization_id, space_id and ancestor_ids are read.
                .resolveEffectivePermission(c.user, r as unknown as IFeNode)
                .then(
                  (p) => p.canView,
                  () => false,
                ),
            ),
          );

          rows.forEach((r, i) => {
            if (allowed[i]) {
              set(
                r.id,
                r.name,
                null,
                { parent_id: r.parent_id, node_type: r.node_type },
                { ancestors: r.ancestor_ids ?? [] },
              );
            }
          });
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.logger.warn(
        `Overview storage records ${module} details skipped for space ${c.spaceId}: ${(err as Error).message}`,
      );
    }

    return out;
  }

  /** Records nested under another record of the same module, with the same gates as moduleCount. */
  private async subRecordCount(
    c: Ctx,
    type: string,
    seesAll: boolean,
  ): Promise<number | null> {
    const base = (table: string) =>
      this.db
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('space_id', c.spaceId)
        .eq('organization_id', c.orgId);
    const total = async (
      query: PromiseLike<{
        count: number | null;
        error: { message: string } | null;
      }>,
    ) => {
      const { count, error } = await query;

      if (error) throw new Error(error.message);

      return count ?? 0;
    };

    if (type === 'tasks') {
      return (await this.hasOrgPermission(c, 'can_view_tasks'))
        ? total(base('tasks').not('parent_task_id', 'is', null))
        : null;
    }

    if (type === 'processes') {
      return (await this.hasOrgPermission(c, 'can_view_processes'))
        ? total(base('business_processes').not('parent_id', 'is', null))
        : null;
    }

    // Wiki has per-page restrictions, so only people who see every page get the number
    if (type === 'wiki' && seesAll) {
      return total(
        base('wiki_pages')
          .eq('is_archived', false)
          .or('metadata->>is_folder.is.null,metadata->>is_folder.neq.true')
          .not('parent_id', 'is', null),
      );
    }

    return null;
  }

  /** Key facts about the space; any failure degrades to null instead of failing the overview. */
  private async spaceInfo(
    c: Ctx,
    tasksVisible: boolean,
  ): Promise<OverviewSpaceInfo | null> {
    try {
      const [spaceRow, members, taskCounts] = await Promise.all([
        this.db
          .from('spaces')
          .select(
            'key, category, space_type_id, created_at, created_by, lead_id, is_archived',
          )
          .eq('id', c.spaceId)
          .eq('organization_id', c.orgId)
          .maybeSingle(),
        this.db
          .from('space_members')
          .select('user_id', { count: 'exact' })
          .eq('space_id', c.spaceId)
          .eq('member_type', 'user')
          .eq('is_active', true)
          .not('user_id', 'is', null)
          .order('created_at', { ascending: false })
          .limit(MEMBER_PREVIEW),
        tasksVisible ? this.taskCounts(c) : Promise.resolve(null),
      ]);

      if (spaceRow.error || !spaceRow.data) return null;
      if (members.error) throw new Error(members.error.message);

      const space = spaceRow.data as {
        key: string;
        category: string | null;
        space_type_id: string | null;
        created_at: string | null;
        created_by: string | null;
        lead_id: string | null;
        is_archived: boolean | null;
      };
      const memberIds = ((members.data ?? []) as { user_id: string }[]).map(
        (m) => m.user_id,
      );
      const [typeName, users] = await Promise.all([
        space.space_type_id
          ? this.spaceTypeName(c, space.space_type_id)
          : Promise.resolve(null),
        this.usersById(
          [space.created_by, space.lead_id, ...memberIds].filter(
            (id): id is string => Boolean(id),
          ),
        ),
      ]);
      const toUser = (id: string | null): OverviewUser | null =>
        id ? (users.get(id) ?? { id, name: null, avatar_url: null }) : null;

      return {
        key: space.key,
        is_archived: space.is_archived === true,
        category: clean(space.category),
        space_type_name: typeName,
        created_at: space.created_at,
        created_by: toUser(space.created_by),
        lead: toUser(space.lead_id),
        member_count: members.count ?? memberIds.length,
        members_preview: memberIds
          .map((id) => toUser(id))
          .filter((u): u is OverviewUser => u !== null),
        open_tasks: taskCounts?.open ?? null,
        overdue_tasks: taskCounts?.overdue ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `Overview space info skipped for space ${c.spaceId}: ${(err as Error).message}`,
      );

      return null;
    }
  }

  private async spaceTypeName(c: Ctx, typeId: string): Promise<string | null> {
    const { data } = await this.db
      .from('space_types')
      .select('name')
      .eq('id', typeId)
      .eq('organization_id', c.orgId)
      .maybeSingle();

    return clean((data as { name?: string } | null)?.name);
  }

  // Open = status not marked completed (or no status); overdue = open and past its due date.
  private async taskCounts(
    c: Ctx,
  ): Promise<{ open: number; overdue: number } | null> {
    const { data: done, error } = await this.db
      .from('task_statuses')
      .select('id')
      .eq('organization_id', c.orgId)
      .eq('is_completed', true);

    if (error) throw new Error(error.message);

    const doneIds = ((done ?? []) as { id: string }[]).map((s) => s.id);
    const openFilter = doneIds.length
      ? `status_id.is.null,status_id.not.in.(${doneIds.join(',')})`
      : null;
    const count = async (overdueOnly: boolean): Promise<number> => {
      const base = this.db
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('space_id', c.spaceId)
        .eq('organization_id', c.orgId);
      const scoped = openFilter ? base.or(openFilter) : base;
      const query = overdueOnly
        ? scoped.lt('due_date', new Date().toISOString())
        : scoped;
      const { count: total, error: countError } = await query;

      if (countError) throw new Error(countError.message);

      return total ?? 0;
    };
    const [open, overdue] = await Promise.all([count(false), count(true)]);

    return { open, overdue };
  }

  // Names and avatars for a handful of users; a failed lookup returns an empty map.
  private async usersById(ids: string[]): Promise<Map<string, OverviewUser>> {
    const unique = [...new Set(ids)];

    if (unique.length === 0) return new Map();

    const rows: UserRow[] = await this.rows<UserRow>(
      this.db
        .from('users')
        .select('id, email, first_name, last_name, avatar_url')
        .in('id', unique),
    ).catch((err: Error): UserRow[] => {
      this.logger.warn(`Overview user lookup failed: ${err.message}`);

      return [];
    });
    const users = new Map<string, OverviewUser>();

    for (const u of rows) {
      users.set(u.id, {
        id: u.id,
        name:
          clean(`${u.first_name ?? ''} ${u.last_name ?? ''}`) ?? clean(u.email),
        avatar_url: u.avatar_url ?? null,
      });
    }

    return users;
  }

  // Same gates the sidebar applies: space toggle, org toggle, licence, view permission.
  private async visibleModules(c: Ctx): Promise<OverviewModule[]> {
    const [rows, spacePerms] = await Promise.all([
      this.spacesService.getSpaceModules(c.spaceId, c.orgId, true),
      this.spacesService.getUserSpacePermissions(
        c.user.userId,
        c.spaceId,
        c.orgId,
      ),
    ]);

    const candidates = rows.filter(
      (r) =>
        r.module_type !== 'calendar' &&
        ACTIVE_SPACE_MODULE_TYPES_SET.has(r.module_type),
    );
    const entitled = new Set(
      await this.entitlementsService.filterEntitledModuleTypes(
        c.orgId,
        candidates.map((r) => r.module_type),
      ),
    );

    const checks = await Promise.all(
      candidates.map(async (r) => {
        const type = r.module_type;
        if (!entitled.has(type)) return false;
        if (
          isOrgModuleType(type) &&
          !(await this.organizationModulesService.isEnabled(c.orgId, type))
        ) {
          return false;
        }
        if (type === 'resource_planning') {
          return this.hasOrgPermission(c, 'can_view_resource_planning');
        }

        return spacePerms.permissions[VIEW_KEY[type]] === true;
      }),
    );

    return candidates
      .filter((_, i) => checks[i])
      .map((r) => ({ module_type: r.module_type, sort_order: r.sort_order }));
  }

  private hasOrgPermission(c: Ctx, key: string): Promise<boolean> {
    return this.permissionsService.hasAllPermissions(c.user.userId, c.orgId, [
      key,
    ]);
  }

  // Newest rows of one table, scoped to the space and organization.
  private latest(table: string, columns: string, c: Ctx, limit: number) {
    return this.db
      .from(table)
      .select(columns)
      .eq('space_id', c.spaceId)
      .eq('organization_id', c.orgId)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);
  }

  private async rows<T>(query: QueryResult): Promise<T[]> {
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return (data ?? []) as T[];
  }

  private make(
    type: OverviewUpdateType,
    moduleType: string,
    row: BaseRow,
    title: unknown,
    opts: UpdateOpts = {},
  ): RawUpdate {
    const key = clean(opts.key);
    const label = clean(opts.status);

    return {
      id: row.id,
      type,
      module_type: moduleType,
      title: clean(title),
      key,
      status: label ? { label, color: opts.color ?? null } : null,
      context: opts.context ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      updated_by_id: row.updated_by ?? null,
      ref: { id: row.id, key, ...opts.ref },
    };
  }

  private async tasks(c: Ctx): Promise<RawUpdate[]> {
    if (!(await this.hasOrgPermission(c, 'can_view_tasks'))) return [];

    const rows = await this.rows<
      BaseRow & {
        key: string | null;
        summary: string | null;
        status_config: { name: string | null; color: string | null } | null;
      }
    >(
      this.latest(
        'tasks',
        'id, key, summary, created_at, updated_at, updated_by, status_config:task_statuses!tasks_status_id_fkey(name,color)',
        c,
        LIMIT_PLAIN,
      ),
    );

    return rows.map((r) =>
      this.make('task', 'tasks', r, r.summary, {
        key: r.key,
        status: r.status_config?.name,
        color: r.status_config?.color ?? null,
      }),
    );
  }

  private async wiki(c: Ctx): Promise<RawUpdate[]> {
    const rows = await this.rows<
      BaseRow & {
        title: string | null;
        workflow_status: string | null;
        created_by: string | null;
        path: string[] | null;
      }
    >(
      this.latest(
        'wiki_pages',
        'id, title, workflow_status, created_by, path, created_at, updated_at, updated_by',
        c,
        LIMIT_RULED,
      )
        .eq('is_archived', false)
        .or('metadata->>is_folder.is.null,metadata->>is_folder.neq.true'),
    );
    const visible = (await this.wikiPermissionsService.filterAccessiblePages(
      rows,
      c.user.userId,
      c.spaceId,
    )) as typeof rows;

    return visible.map((r) =>
      this.make('wiki', 'wiki', r, r.title, { status: r.workflow_status }),
    );
  }

  private async assets(c: Ctx): Promise<RawUpdate[]> {
    const rows = await this.rows<
      BaseRow & {
        object_key: string | null;
        name: string | null;
        schema_id: string;
        object_type_id: string | null;
      }
    >(
      this.latest(
        'asset_objects',
        'id, object_key, name, schema_id, object_type_id, created_at, updated_at, updated_by',
        c,
        LIMIT_RULED,
      ).eq('is_archived', false),
    );
    if (rows.length === 0) return [];

    const typeIds = [
      ...new Set(rows.map((r) => r.object_type_id).filter(Boolean)),
    ] as string[];
    const schemaIds = [...new Set(rows.map((r) => r.schema_id))];

    const [viewable, schemas] = await Promise.all([
      Promise.all(
        typeIds.map(async (typeId) => {
          try {
            const perm = await this.assetObjectTypesService.getMyPermission(
              typeId,
              c.spaceId,
              c.orgId,
              c.user.userId,
            );

            return perm.can_view ? typeId : null;
          } catch {
            return null;
          }
        }),
      ),
      this.rows<{
        id: string;
        name: string | null;
        object_key: string | null;
        is_archived: boolean;
      }>(
        this.db
          .from('asset_object_schemas')
          .select('id, name, object_key, is_archived')
          .in('id', schemaIds)
          .eq('space_id', c.spaceId)
          .eq('organization_id', c.orgId),
      ),
    ]);
    const allowedTypes = new Set(viewable.filter(Boolean));
    const schemaById = new Map(
      schemas.filter((s) => !s.is_archived).map((s) => [s.id, s]),
    );

    return rows.flatMap((r) => {
      const schema = schemaById.get(r.schema_id);
      if (!schema || !r.object_type_id || !allowedTypes.has(r.object_type_id))
        return [];

      return [
        this.make('asset', 'assets', r, r.name, {
          key: r.object_key,
          context: clean(schema.name),
          ref: { schema_key: clean(schema.object_key)?.toLowerCase() ?? null },
        }),
      ];
    });
  }

  private async listItems(c: Ctx): Promise<RawUpdate[]> {
    if (!(await this.hasOrgPermission(c, 'can_view_lists'))) return [];

    const rows = await this.rows<
      BaseRow & { title: string | null; schema_id: string }
    >(
      this.latest(
        'asset_items',
        'id, title, schema_id, created_at, updated_at, updated_by',
        c,
        LIMIT_PLAIN,
      ).eq('is_archived', false),
    );
    if (rows.length === 0) return [];

    const schemas = await this.rows<{
      id: string;
      name: string | null;
      key: string | null;
    }>(
      this.db
        .from('asset_schemas')
        .select('id, name, key')
        .in('id', [...new Set(rows.map((r) => r.schema_id))])
        .eq('space_id', c.spaceId)
        .eq('organization_id', c.orgId),
    );
    const schemaById = new Map(schemas.map((s) => [s.id, s]));

    return rows.flatMap((r) => {
      const schema = schemaById.get(r.schema_id);
      if (!schema) return [];

      return [
        this.make('list_item', 'lists', r, r.title, {
          context: clean(schema.name),
          ref: { schema_key: clean(schema.key) },
        }),
      ];
    });
  }

  private async automations(c: Ctx): Promise<RawUpdate[]> {
    const rows = await this.rows<
      BaseRow & { name: string | null; status: string | null }
    >(
      this.latest(
        'automations',
        'id, name, status, created_at, updated_at, updated_by',
        c,
        LIMIT_PLAIN,
      ).eq('is_archived', false),
    );

    return rows.map((r) =>
      this.make('automation', 'automations', r, r.name, { status: r.status }),
    );
  }

  private async processes(c: Ctx): Promise<RawUpdate[]> {
    if (!(await this.hasOrgPermission(c, 'can_view_processes'))) return [];

    const rows = await this.rows<
      BaseRow & {
        key: string | null;
        title: string | null;
        status: string | null;
      }
    >(
      this.latest(
        'business_processes',
        'id, key, title, status, created_at, updated_at, updated_by',
        c,
        LIMIT_PLAIN,
      ),
    );

    return rows.map((r) =>
      this.make('process', 'processes', r, r.title, {
        key: r.key,
        status: r.status,
      }),
    );
  }

  // Mirrors PlansService.listPlans for a space: admin/owner, or a member with view_plans.
  private async plans(c: Ctx): Promise<RawUpdate[]> {
    const [isAdmin, access] = await Promise.all([
      this.permissionsService.isAdminOrOwner(c.user.userId, c.orgId),
      this.permissionsService.getUserSpacePermissions(
        c.user.userId,
        c.orgId,
        c.spaceId,
      ),
    ]);
    if (
      !isAdmin &&
      !(access.isMember && access.permissions.view_plans === true)
    )
      return [];

    const rows = await this.rows<
      BaseRow & {
        plan_key: string | null;
        name: string | null;
        status: string | null;
      }
    >(
      this.latest(
        'plans',
        'id, plan_key, name, status, created_at, updated_at',
        c,
        LIMIT_RULED,
      ).eq('is_archived', false),
    );

    return rows.map((r) =>
      this.make('plan', 'plans', r, r.name, {
        key: r.plan_key,
        status: r.status,
      }),
    );
  }

  // Mirrors BoardsService.getAll for a space: the space view_boards grant.
  private async boards(c: Ctx): Promise<RawUpdate[]> {
    const access = await this.permissionsService.getUserSpacePermissions(
      c.user.userId,
      c.orgId,
      c.spaceId,
    );
    if (access.permissions.view_boards !== true) return [];

    const rows = await this.rows<
      BaseRow & { board_key: string | null; name: string | null }
    >(
      this.latest(
        'boards',
        'id, board_key, name, created_at, updated_at',
        c,
        LIMIT_RULED,
      ).eq('is_archived', false),
    );

    return rows.map((r) =>
      this.make('board', 'boards', r, r.name, { key: r.board_key }),
    );
  }

  private async forms(c: Ctx): Promise<RawUpdate[]> {
    const rows = await this.rows<
      BaseRow & {
        form_key: string | null;
        name: string | null;
        status: string | null;
      }
    >(
      this.latest(
        'form_builder',
        'id, form_key, name, status, created_at, updated_at, updated_by',
        c,
        LIMIT_PLAIN,
      )
        .eq('is_deleted', false)
        .eq('is_template', false)
        .neq('status', 'archived'),
    );

    return rows.map((r) =>
      this.make('form', 'form_builder', r, r.name, {
        key: r.form_key,
        status: r.status,
      }),
    );
  }

  // getById applies canAccessDashboardRecord and throws when it denies.
  private async dashboards(c: Ctx): Promise<RawUpdate[]> {
    const rows = await this.rows<
      BaseRow & { name: string | null; status: string | null }
    >(
      this.latest(
        'dashboards',
        'id, name, status, created_at, updated_at, updated_by',
        c,
        LIMIT_RULED,
      ).is('deleted_at', null),
    );
    const allowed = await Promise.all(
      rows.map((r) =>
        this.dashboardsService
          .getById(r.id, c.orgId, c.user.userId, 'view')
          .then(
            () => true,
            () => false,
          ),
      ),
    );

    return rows
      .filter((_, i) => allowed[i])
      .map((r) =>
        this.make('dashboard', 'dashboards', r, r.name, { status: r.status }),
      );
  }

  private async files(c: Ctx): Promise<RawUpdate[]> {
    const rows = await this.rows<
      BaseRow & {
        organization_id: string;
        space_id: string;
        parent_id: string | null;
        ancestor_ids: string[] | null;
        node_type: string;
        name: string | null;
      }
    >(
      this.latest(
        'fe_nodes',
        'id, organization_id, space_id, parent_id, ancestor_ids, node_type, name, created_at, updated_at, updated_by',
        c,
        LIMIT_RULED,
      ).eq('is_deleted', false),
    );
    const allowed = await Promise.all(
      rows.map((r) =>
        this.fileExplorerAccessService
          // Only id, organization_id, space_id and ancestor_ids are read.
          .resolveEffectivePermission(c.user, r as unknown as IFeNode)
          .then((p) => p.canView),
      ),
    );

    return rows
      .filter((_, i) => allowed[i])
      .map((r) =>
        this.make('file', 'file_explorer', r, r.name, {
          ref: { parent_id: r.parent_id, node_type: r.node_type },
        }),
      );
  }

  private async withUsers(updates: RawUpdate[]): Promise<OverviewUpdate[]> {
    const ids = [
      ...new Set(updates.map((u) => u.updated_by_id).filter(Boolean)),
    ] as string[];
    // A failed name lookup degrades to bare ids rather than failing the overview.
    const users =
      ids.length === 0
        ? []
        : await this.rows<{
            id: string;
            email: string | null;
            first_name: string | null;
            last_name: string | null;
            avatar_url: string | null;
          }>(
            this.db
              .from('users')
              .select('id, email, first_name, last_name, avatar_url')
              .in('id', ids),
          ).catch((err: Error) => {
            this.logger.warn(`Overview user lookup failed: ${err.message}`);

            return [];
          });
    const byId = new Map(users.map((u) => [u.id, u]));

    return updates.map(({ updated_by_id, ...u }) => {
      const user = updated_by_id ? byId.get(updated_by_id) : undefined;
      const name = user
        ? (clean(`${user.first_name ?? ''} ${user.last_name ?? ''}`) ??
          clean(user.email))
        : null;
      const created = u.created_at ? Date.parse(u.created_at) : NaN;

      return {
        ...u,
        is_new:
          !Number.isNaN(created) &&
          Math.abs(Date.parse(u.updated_at) - created) < NEW_WINDOW_MS,
        updated_by: updated_by_id
          ? {
              id: updated_by_id,
              name,
              avatar_url: user?.avatar_url ?? null,
            }
          : null,
      };
    });
  }
}
