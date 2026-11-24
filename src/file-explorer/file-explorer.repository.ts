/**
 * @fileoverview Data access layer for File Explorer — raw Supabase queries.
 * All methods use the service-role admin client (RLS is defence-in-depth;
 * authorisation is enforced in FileExplorerService / FileExplorerAccessService).
 * @module src/file-explorer/file-explorer.repository
 */

import { DEFAULT_STORAGE_QUOTA_BYTES } from '../common/upload-limits';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type {
  FeNodeType,
  IFeNode,
  IFeVersionSlim,
  IFeLabelSlim,
  IFeUserStub,
} from './interfaces/fe-node.interface';
import type { IFeVersion } from './interfaces/fe-version.interface';
import type { ListNodesQueryDto } from './dto/list-nodes-query.dto';
import type {
  IFeOrganizationStorageUsage,
  IFeStorageLargestFile,
  IFeStorageSpaceUsage,
  IFeStorageUserUsage,
} from './interfaces/fe-storage-usage.interface';

interface StorageSpaceRow {
  id: string;
  name: string;
  key: string;
  is_archived: boolean | null;
}

interface StorageNodeRow {
  id: string;
  space_id: string;
  node_type: FeNodeType;
  name: string;
  mime_type: string | null;
  file_size: number | null;
  created_by: string | null;
  is_deleted: boolean;
  updated_at: string;
}

interface StorageVersionRow {
  id: string;
  node_id: string;
  file_size: number;
  uploaded_by: string | null;
  uploaded_at: string;
}

interface StorageUserRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

@Injectable()
export class FileExplorerRepository {
  private static readonly NODES = 'fe_nodes';
  private static readonly VERSIONS = 'fe_versions';
  private static readonly STARS = 'fe_stars';
  private static readonly NODE_LABELS = 'fe_node_labels';
  private static readonly LABELS = 'fe_labels';
  private static readonly SHARES = 'fe_shares';
  private static readonly STORAGE_PAGE_SIZE = 1000;

  /**
   * How many ids may go into a single `.in(...)` filter.
   *
   * Separate from STORAGE_PAGE_SIZE on purpose: that one is a ROW page size for `.range()`, where
   * 1000 is fine. PostgREST puts `.in()` values in the QUERY STRING, so 1000 uuids became a ~37 KB
   * URL and the request died with "URI too long" before reaching the database. 100 uuids is roughly
   * 3.7 KB, comfortably inside the usual 8 KB header budget.
   */
  private static readonly STORAGE_ID_CHUNK_SIZE = 100;
  private static readonly DEFAULT_QUOTA_BYTES = DEFAULT_STORAGE_QUOTA_BYTES;
  // Generous safety cap so a pathological folder can't load unbounded rows into memory. A visible
  // warning is logged when hit (no silent truncation); true pagination/infinite-scroll is a follow-up.
  private static readonly LIST_CAP = 1000;

  private readonly logger = new Logger(FileExplorerRepository.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  // ── NODE QUERIES ──────────────────────────────────────────────────────────

  async findNode(id: string): Promise<IFeNode> {
    const { data, error } = await this.db
      .from(FileExplorerRepository.NODES)
      .select('*')
      .eq('id', id)
      .eq('is_deleted', false)
      .maybeSingle();

    if (error || !data) throw new NotFoundException('Node not found');

    return data as IFeNode;
  }

  async findFileNode(id: string): Promise<IFeNode> {
    const node = await this.findNode(id);

    if (node.node_type !== 'file') throw new NotFoundException('Not a file');

    return node;
  }

  /**
   * Find a node by ID without filtering `is_deleted`.
   * Use this in restore/permanentDelete paths where the node may be soft-deleted.
   * Normal access paths MUST use `findNode` (is_deleted=false enforced).
   */
  async findNodeAny(id: string): Promise<IFeNode> {
    const { data, error } = await this.db
      .from(FileExplorerRepository.NODES)
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !data) throw new NotFoundException('Node not found');

    return data as IFeNode;
  }

  /**
   * List nodes for a space/view.
   *
   * `query.parent_id` is direct-children-only; `query.folder_id` is the whole
   * subtree; `query.label_ids` matches nodes carrying ANY of the labels (OR).
   * All present filters AND together.
   *
   * @param meta Optional out-param — `meta.truncated` is set to `true` when the
   *   result hit {@link LIST_CAP}, so callers can surface "not everything is
   *   shown" instead of silently rendering a partial list.
   */
  async listNodes(
    spaceId: string,
    orgId: string,
    view: string,
    query: ListNodesQueryDto,
    meta?: { truncated: boolean },
  ): Promise<IFeNode[]> {
    let q = this.db
      .from(FileExplorerRepository.NODES)
      .select('*')
      .eq('space_id', spaceId)
      .eq('organization_id', orgId);

    if (view === 'trash') {
      q = q.eq('is_deleted', true);

      // Execute and filter in JS: show only top-level trashed items.
      // A trashed node is "top-level" when its parent is NOT also soft-deleted.
      // This ensures deleting a folder with 50 files shows 1 row (the folder), not 51.
      const { data, error } = await q
        .order('deleted_at', { ascending: false })
        .limit(FileExplorerRepository.LIST_CAP);

      if (error) throw new Error(`listNodes (trash) failed: ${error.message}`);

      const all = (data ?? []) as IFeNode[];
      const trashedIds = new Set(all.map((n) => n.id));

      if (meta && all.length === FileExplorerRepository.LIST_CAP) {
        meta.truncated = true;
      }

      return all.filter((n) => !n.parent_id || !trashedIds.has(n.parent_id));
    } else {
      q = q.eq('is_deleted', false);

      if (query.parent_id) {
        q = q.eq('parent_id', query.parent_id);
      } else if (
        view === 'all' &&
        !query.search &&
        !query.folder_id &&
        !query.label_ids?.length
      ) {
        // Root listing — nodes with no parent. Skipped whenever a cross-tree
        // filter is active (search / subtree / labels); those must span the
        // whole space, exactly as `search` already did.
        q = q.is('parent_id', null);
      }
    }

    // Subtree filter — a node D is inside folder F iff F appears in
    // D.ancestor_ids. Same GIN-indexed containment operator as listDescendants().
    if (query.folder_id) {
      q = q.filter('ancestor_ids', 'cs', `{${query.folder_id}}`);
    }

    // Label filter — pre-resolve the junction table into an `id IN (…)`
    // constraint instead of a PostgREST embed, mirroring
    // rewriteWikiLabelRules() in saved-filters/filter-query-engine.ts.
    //
    // SEMANTICS: OR / ANY-of — a node matches when it carries AT LEAST ONE of
    // the given labels (union of node ids). It does NOT require all of them.
    // When folder_id is also set the two constraints AND together.
    if (query.label_ids?.length) {
      const { data: labelRows, error: labelError } = await this.db
        .from(FileExplorerRepository.NODE_LABELS)
        .select('node_id')
        // Capped for the same reason as the outer query, plus a hard one: these ids
        // become an `id=in.(…)` query string, and an uncapped list overflows the URL.
        .limit(FileExplorerRepository.LIST_CAP)
        .in('label_id', query.label_ids);

      if (labelError) {
        throw new Error(`listNodes label lookup failed: ${labelError.message}`);
      }

      const junctionRows = (labelRows ?? []) as Array<{ node_id: string }>;

      if (meta && junctionRows.length === FileExplorerRepository.LIST_CAP) {
        meta.truncated = true;
      }

      // Node rows are still scoped by space_id + organization_id above, so an id
      // from another tenant could never survive even if one landed in this list.
      const labelledIds = [...new Set(junctionRows.map((row) => row.node_id))];

      // Nothing carries any of these labels — an empty result, never "no filter".
      if (labelledIds.length === 0) return [];

      q = q.in('id', labelledIds);
    }

    if (query.type) q = q.eq('node_type', query.type);
    if (query.search) q = q.ilike('name', `%${query.search}%`);

    q = q
      .order('node_type', { ascending: false })
      .order('name')
      .limit(FileExplorerRepository.LIST_CAP);

    const { data, error } = await q;

    if (error) throw new Error(`listNodes failed: ${error.message}`);

    const rows = (data ?? []) as IFeNode[];

    if (rows.length === FileExplorerRepository.LIST_CAP) {
      if (meta) meta.truncated = true;

      this.logger.warn(
        `listNodes hit the ${FileExplorerRepository.LIST_CAP}-row cap (space ${spaceId}); some items are not shown — pagination needed.`,
      );
    }

    return rows;
  }

  async getOrganizationStorageUsage(
    orgId: string,
  ): Promise<IFeOrganizationStorageUsage> {
    const [spaces, nodes] = await Promise.all([
      this.listStorageSpaces(orgId),
      this.listStorageNodes(orgId),
    ]);
    const fileNodes = nodes.filter((node) => node.node_type === 'file');
    const versions = await this.listStorageVersions(
      fileNodes.map((node) => node.id),
    );
    const userIds = new Set<string>();

    for (const node of fileNodes) {
      if (node.created_by) userIds.add(node.created_by);
    }

    for (const version of versions) {
      if (version.uploaded_by) userIds.add(version.uploaded_by);
    }

    const [quotaBySpace, users] = await Promise.all([
      this.listSpaceStorageQuotas(spaces.map((space) => space.id)),
      this.listStorageUsers([...userIds]),
    ]);

    const spaceById = new Map(spaces.map((space) => [space.id, space]));
    const userById = new Map(users.map((user) => [user.id, user]));
    const nodeById = new Map(fileNodes.map((node) => [node.id, node]));
    const fileIdsWithVersions = new Set<string>();
    const spaceFiles = new Map<string, Set<string>>();
    const userFiles = new Map<string, Set<string>>();
    const nodeBytes = new Map<string, number>();
    const nodeVersionCounts = new Map<string, number>();
    const spaceUsage = new Map<string, IFeStorageSpaceUsage>();
    const userUsage = new Map<string, IFeStorageUserUsage>();

    for (const space of spaces) {
      spaceUsage.set(space.id, {
        space_id: space.id,
        space_key: space.key,
        space_name: space.name,
        is_archived: Boolean(space.is_archived),
        used_bytes: 0,
        quota_bytes:
          quotaBySpace.get(space.id) ??
          FileExplorerRepository.DEFAULT_QUOTA_BYTES,
        file_count: 0,
        version_count: 0,
        trash_bytes: 0,
      });
      spaceFiles.set(space.id, new Set());
    }

    let usedBytes = 0;
    let trashBytes = 0;
    let todayUploadCount = 0;
    const todayStart = new Date();

    todayStart.setUTCHours(0, 0, 0, 0);

    for (const version of versions) {
      const node = nodeById.get(version.node_id);

      if (!node) continue;

      const bytes = Number(version.file_size ?? 0);
      const space = spaceUsage.get(node.space_id);

      usedBytes += bytes;
      if (version.uploaded_at && new Date(version.uploaded_at) >= todayStart)
        todayUploadCount += 1;
      fileIdsWithVersions.add(node.id);
      nodeBytes.set(node.id, (nodeBytes.get(node.id) ?? 0) + bytes);
      nodeVersionCounts.set(node.id, (nodeVersionCounts.get(node.id) ?? 0) + 1);

      if (node.is_deleted) trashBytes += bytes;

      if (space) {
        space.used_bytes += bytes;
        space.version_count += 1;
        if (node.is_deleted) space.trash_bytes += bytes;
        spaceFiles.get(node.space_id)?.add(node.id);
      }

      const userKey = version.uploaded_by ?? 'unknown';
      const uploader = version.uploaded_by
        ? (userById.get(version.uploaded_by) ?? null)
        : null;
      const usage =
        userUsage.get(userKey) ??
        this.createStorageUserUsage(version.uploaded_by, uploader);

      usage.used_bytes += bytes;
      usage.version_count += 1;
      usage.last_uploaded_at = this.maxIso(
        usage.last_uploaded_at,
        version.uploaded_at,
      );
      userFiles.set(userKey, userFiles.get(userKey) ?? new Set());
      userFiles.get(userKey)?.add(node.id);
      userUsage.set(userKey, usage);
    }

    for (const [spaceId, fileIds] of spaceFiles.entries()) {
      const space = spaceUsage.get(spaceId);

      if (space) space.file_count = fileIds.size;
    }

    for (const [userKey, fileIds] of userFiles.entries()) {
      const usage = userUsage.get(userKey);

      if (usage) usage.file_count = fileIds.size;
    }

    return {
      organization_id: orgId,
      bucket: 'file-explorer',
      used_bytes: usedBytes,
      storage_limit_bytes: null,
      file_count: fileIdsWithVersions.size,
      folder_count: nodes.filter(
        (node) => node.node_type === 'folder' && !node.is_deleted,
      ).length,
      version_count: versions.length,
      trash_bytes: trashBytes,
      today_upload_count: todayUploadCount,
      generated_at: new Date().toISOString(),
      spaces: [...spaceUsage.values()].sort(
        (a, b) =>
          b.used_bytes - a.used_bytes ||
          a.space_name.localeCompare(b.space_name),
      ),
      users: [...userUsage.values()].sort(
        (a, b) => b.used_bytes - a.used_bytes || a.name.localeCompare(b.name),
      ),
      largest_files: this.buildLargestFiles(
        fileNodes,
        nodeBytes,
        nodeVersionCounts,
        spaceById,
        userById,
      ),
    };
  }

  private async listStorageSpaces(orgId: string): Promise<StorageSpaceRow[]> {
    const rows: StorageSpaceRow[] = [];
    let offset = 0;

    for (;;) {
      const { data, error } = await this.db
        .from('spaces')
        .select('id, name, key, is_archived')
        .eq('organization_id', orgId)
        .order('name', { ascending: true })
        .range(offset, offset + FileExplorerRepository.STORAGE_PAGE_SIZE - 1);

      if (error) throw new Error(`listStorageSpaces failed: ${error.message}`);

      rows.push(...((data ?? []) as StorageSpaceRow[]));

      if (!data || data.length < FileExplorerRepository.STORAGE_PAGE_SIZE) {
        break;
      }

      offset += FileExplorerRepository.STORAGE_PAGE_SIZE;
    }

    return rows;
  }

  private async listStorageNodes(orgId: string): Promise<StorageNodeRow[]> {
    const rows: StorageNodeRow[] = [];
    let offset = 0;

    for (;;) {
      const { data, error } = await this.db
        .from(FileExplorerRepository.NODES)
        .select(
          'id, space_id, node_type, name, mime_type, file_size, created_by, is_deleted, updated_at',
        )
        .eq('organization_id', orgId)
        .order('created_at', { ascending: true })
        .range(offset, offset + FileExplorerRepository.STORAGE_PAGE_SIZE - 1);

      if (error) throw new Error(`listStorageNodes failed: ${error.message}`);

      rows.push(...((data ?? []) as StorageNodeRow[]));

      if (!data || data.length < FileExplorerRepository.STORAGE_PAGE_SIZE) {
        break;
      }

      offset += FileExplorerRepository.STORAGE_PAGE_SIZE;
    }

    return rows;
  }

  private async listStorageVersions(
    nodeIds: string[],
  ): Promise<StorageVersionRow[]> {
    if (nodeIds.length === 0) return [];

    const rows: StorageVersionRow[] = [];

    for (
      let i = 0;
      i < nodeIds.length;
      i += FileExplorerRepository.STORAGE_ID_CHUNK_SIZE
    ) {
      const chunk = nodeIds.slice(
        i,
        i + FileExplorerRepository.STORAGE_ID_CHUNK_SIZE,
      );
      let offset = 0;

      for (;;) {
        const { data, error } = await this.db
          .from(FileExplorerRepository.VERSIONS)
          .select('id, node_id, file_size, uploaded_by, uploaded_at')
          .eq('upload_status', 'active')
          .in('node_id', chunk)
          .order('uploaded_at', { ascending: false })
          .range(offset, offset + FileExplorerRepository.STORAGE_PAGE_SIZE - 1);

        if (error)
          throw new Error(`listStorageVersions failed: ${error.message}`);

        rows.push(...((data ?? []) as StorageVersionRow[]));

        if (!data || data.length < FileExplorerRepository.STORAGE_PAGE_SIZE) {
          break;
        }

        offset += FileExplorerRepository.STORAGE_PAGE_SIZE;
      }
    }

    return rows;
  }

  private async listSpaceStorageQuotas(
    spaceIds: string[],
  ): Promise<Map<string, number>> {
    const quotaBySpace = new Map<string, number>();

    if (spaceIds.length === 0) return quotaBySpace;

    for (
      let i = 0;
      i < spaceIds.length;
      i += FileExplorerRepository.STORAGE_ID_CHUNK_SIZE
    ) {
      const chunk = spaceIds.slice(
        i,
        i + FileExplorerRepository.STORAGE_ID_CHUNK_SIZE,
      );
      const { data, error } = await this.db
        .from('space_modules')
        .select('space_id, settings')
        .eq('module_type', 'file_explorer')
        .in('space_id', chunk);

      if (error)
        throw new Error(`listSpaceStorageQuotas failed: ${error.message}`);

      for (const row of (data ?? []) as {
        space_id: string;
        settings: Record<string, unknown> | null;
      }[]) {
        const quota = Number(row.settings?.['fe_storage_quota_bytes']);

        if (Number.isFinite(quota) && quota > 0) {
          quotaBySpace.set(row.space_id, quota);
        }
      }
    }

    return quotaBySpace;
  }

  private async listStorageUsers(userIds: string[]): Promise<StorageUserRow[]> {
    if (userIds.length === 0) return [];

    const rows: StorageUserRow[] = [];

    for (
      let i = 0;
      i < userIds.length;
      i += FileExplorerRepository.STORAGE_ID_CHUNK_SIZE
    ) {
      const chunk = userIds.slice(
        i,
        i + FileExplorerRepository.STORAGE_ID_CHUNK_SIZE,
      );
      const { data, error } = await this.db
        .from('users')
        .select('id, first_name, last_name, email, avatar_url')
        .in('id', chunk);

      if (error) throw new Error(`listStorageUsers failed: ${error.message}`);

      rows.push(...((data ?? []) as StorageUserRow[]));
    }

    return rows;
  }

  private createStorageUserUsage(
    userId: string | null,
    user: StorageUserRow | null,
  ): IFeStorageUserUsage {
    return {
      user_id: userId,
      name: user ? this.formatUserName(user) : 'Unknown user',
      email: user?.email ?? null,
      avatar_url: user?.avatar_url ?? null,
      used_bytes: 0,
      file_count: 0,
      version_count: 0,
      last_uploaded_at: null,
    };
  }

  private buildLargestFiles(
    nodes: StorageNodeRow[],
    nodeBytes: Map<string, number>,
    nodeVersionCounts: Map<string, number>,
    spaceById: Map<string, StorageSpaceRow>,
    userById: Map<string, StorageUserRow>,
  ): IFeStorageLargestFile[] {
    return nodes
      .map((node): IFeStorageLargestFile | null => {
        const usedBytes = nodeBytes.get(node.id) ?? 0;
        const space = spaceById.get(node.space_id);

        if (!space || usedBytes <= 0) return null;

        const creator = node.created_by
          ? (userById.get(node.created_by) ?? null)
          : null;

        return {
          node_id: node.id,
          name: node.name,
          mime_type: node.mime_type,
          space_id: space.id,
          space_key: space.key,
          space_name: space.name,
          created_by: node.created_by,
          created_by_name: creator
            ? this.formatUserName(creator)
            : 'Unknown user',
          used_bytes: usedBytes,
          current_size_bytes: Number(node.file_size ?? 0),
          version_count: nodeVersionCounts.get(node.id) ?? 0,
          is_deleted: node.is_deleted,
          updated_at: node.updated_at,
        };
      })
      .filter((file): file is IFeStorageLargestFile => file !== null)
      .sort(
        (a, b) => b.used_bytes - a.used_bytes || a.name.localeCompare(b.name),
      )
      .slice(0, 20);
  }

  private maxIso(current: string | null, next: string): string {
    if (!current) return next;

    return next > current ? next : current;
  }

  private formatUserName(user: StorageUserRow): string {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');

    return name || user.email || 'Unknown user';
  }

  /** Walk ancestor_ids (already on the node) to fetch all ancestor nodes in one IN query. */
  async getBreadcrumbs(node: IFeNode): Promise<IFeNode[]> {
    if (!node.ancestor_ids || node.ancestor_ids.length === 0) return [];

    const { data, error } = await this.db
      .from(FileExplorerRepository.NODES)
      .select(
        'id, name, node_type, parent_id, ancestor_ids, space_id, organization_id, is_deleted, created_at, updated_at, created_by, updated_by, deleted_at, deleted_by, delete_op_id, mime_type, file_size, current_version_id, description',
      )
      .in('id', node.ancestor_ids)
      .eq('is_deleted', false);

    if (error) return [];

    // Sort by position in ancestor_ids array (root first)
    const map = new Map((data ?? []).map((n) => [n.id, n as IFeNode]));

    return node.ancestor_ids
      .map((id) => map.get(id))
      .filter(Boolean) as IFeNode[];
  }

  // ── VERSION QUERIES ──────────────────────────────────────────────────────

  async listVersions(nodeId: string): Promise<IFeVersion[]> {
    const { data, error } = await this.db
      .from(FileExplorerRepository.VERSIONS)
      .select('*')
      .eq('node_id', nodeId)
      .eq('upload_status', 'active')
      .order('version_number', { ascending: false });

    if (error) throw new Error(`listVersions failed: ${error.message}`);

    return (data ?? []) as IFeVersion[];
  }

  async resolveVersion(
    node: IFeNode,
    versionNumber?: number,
  ): Promise<IFeVersion> {
    if (!node.current_version_id && !versionNumber) {
      throw new NotFoundException('File has no active version');
    }

    let q = this.db
      .from(FileExplorerRepository.VERSIONS)
      .select('*')
      .eq('node_id', node.id);

    if (versionNumber) {
      q = q.eq('version_number', versionNumber);
    } else {
      q = q.eq('id', node.current_version_id!);
    }

    const { data, error } = await q.eq('upload_status', 'active').maybeSingle();

    if (error || !data) throw new NotFoundException('Version not found');

    return data as IFeVersion;
  }

  async listActiveVersionsByIds(
    versionIds: string[],
  ): Promise<Map<string, IFeVersion>> {
    if (versionIds.length === 0) return new Map();

    const { data, error } = await this.db
      .from(FileExplorerRepository.VERSIONS)
      .select('*')
      .eq('upload_status', 'active')
      .in('id', versionIds);

    if (error)
      throw new Error(`listActiveVersionsByIds failed: ${error.message}`);

    return new Map(
      ((data ?? []) as IFeVersion[]).map((version) => [version.id, version]),
    );
  }

  // ── ENRICHMENT ───────────────────────────────────────────────────────────

  /** Attach is_starred, labels, and current_version_slim to a list of nodes. */
  async enrichNodes(nodes: IFeNode[], userId: string): Promise<IFeNode[]> {
    if (nodes.length === 0) return nodes;

    const nodeIds = nodes.map((n) => n.id);

    // Stars for this user
    const { data: stars } = await this.db
      .from(FileExplorerRepository.STARS)
      .select('node_id')
      .eq('user_id', userId)
      .in('node_id', nodeIds);

    const starredSet = new Set((stars ?? []).map((s) => s.node_id));

    const labelMap = new Map<string, IFeLabelSlim[]>();

    // Fetch node→label mappings and label details in two queries
    const { data: nodeLabelsWithNodeId } = await this.db
      .from(FileExplorerRepository.NODE_LABELS)
      .select('node_id, label_id')
      .in('node_id', nodeIds);

    const { data: labelsData } = await this.db
      .from(FileExplorerRepository.LABELS)
      .select('id, name, color')
      .in(
        'id',
        (nodeLabelsWithNodeId ?? []).map((nl) => nl.label_id),
      );

    const labelsById = new Map(
      (labelsData ?? []).map((l) => [l.id, l as IFeLabelSlim]),
    );

    for (const nl of nodeLabelsWithNodeId ?? []) {
      const label = labelsById.get(nl.label_id);

      if (label) {
        if (!labelMap.has(nl.node_id)) labelMap.set(nl.node_id, []);
        labelMap.get(nl.node_id)!.push(label);
      }
    }

    // Active share count per node (for UI 'shared' badge)
    const { data: shareRows } = await this.db
      .from(FileExplorerRepository.SHARES)
      .select('node_id')
      .in('node_id', nodeIds)
      .eq('is_active', true);

    const shareCountMap = new Map<string, number>();

    for (const s of shareRows ?? []) {
      shareCountMap.set(s.node_id, (shareCountMap.get(s.node_id) ?? 0) + 1);
    }

    // Current version slim info for file nodes
    const fileNodes = nodes.filter(
      (n) => n.node_type === 'file' && n.current_version_id,
    );
    const versionIds = fileNodes.map((n) => n.current_version_id!);
    const { data: versions } = versionIds.length
      ? await this.db
          .from(FileExplorerRepository.VERSIONS)
          .select(
            'id, version_number, file_path, file_size, mime_type, uploaded_at, uploaded_by, comment',
          )
          .in('id', versionIds)
      : { data: [] };

    const versionMap = new Map(
      (versions ?? []).map((v) => [v.id, v as IFeVersionSlim]),
    );

    // Creator (owner) details for each node (for UI owner avatar + name)
    const creatorIds = [
      ...new Set(nodes.map((n) => n.created_by).filter(Boolean)),
    ];
    const { data: creators } = creatorIds.length
      ? await this.db
          .from('users')
          .select('id, first_name, last_name, email, avatar_url')
          .in('id', creatorIds)
      : { data: [] };

    const creatorMap = new Map(
      (creators ?? []).map((u) => [u.id, u as IFeUserStub]),
    );

    return nodes.map((node) => ({
      ...node,
      is_starred: starredSet.has(node.id),
      labels: labelMap.get(node.id) ?? [],
      shares_count: shareCountMap.get(node.id) ?? 0,
      current_version:
        node.node_type === 'file' && node.current_version_id
          ? (versionMap.get(node.current_version_id) ?? null)
          : undefined,
      created_by_user: node.created_by
        ? (creatorMap.get(node.created_by) ?? null)
        : null,
    }));
  }

  // ── MUTATIONS ─────────────────────────────────────────────────────────────

  async insertFolderNode(
    spaceId: string,
    orgId: string,
    userId: string,
    dto: { name: string; parent_id?: string; description?: string },
  ): Promise<IFeNode> {
    const { data, error } = await this.db
      .from(FileExplorerRepository.NODES)
      .insert({
        organization_id: orgId,
        space_id: spaceId,
        parent_id: dto.parent_id ?? null,
        node_type: 'folder',
        name: dto.name.trim(),
        description: dto.description ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select('*')
      .single();

    if (error) throw error;

    return data as IFeNode;
  }

  async insertFileNode(
    spaceId: string,
    orgId: string,
    userId: string,
    opts: {
      name: string;
      parent_id?: string;
      mime_type: string;
      file_size: number;
    },
  ): Promise<IFeNode> {
    const { data, error } = await this.db
      .from(FileExplorerRepository.NODES)
      .insert({
        organization_id: orgId,
        space_id: spaceId,
        parent_id: opts.parent_id ?? null,
        node_type: 'file',
        name: opts.name.trim(),
        mime_type: opts.mime_type,
        file_size: opts.file_size,
        created_by: userId,
        updated_by: userId,
      })
      .select('*')
      .single();

    if (error) throw error;

    return data as IFeNode;
  }

  async updateNode(
    id: string,
    userId: string,
    patch: Partial<{
      name: string;
      description: string;
      current_version_id: string;
      file_size: number;
      mime_type: string;
    }>,
  ): Promise<IFeNode> {
    const { data, error } = await this.db
      .from(FileExplorerRepository.NODES)
      .update({
        ...patch,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    return data as IFeNode;
  }

  // ── VIEWS ─────────────────────────────────────────────────────────────────

  /**
   * Starred nodes for the current user — two-query approach for reliable search.
   * 1. Fetch starred node IDs ordered by starred_at.
   * 2. Fetch nodes with space/org/deleted filters + optional name search.
   * Preserves starred_at ordering in the final result.
   */
  async listStarred(
    userId: string,
    orgId: string,
    spaceId: string,
    search?: string,
  ): Promise<IFeNode[]> {
    // Step 1: get ordered starred node IDs for this user
    const starsResult = await this.db
      .from(FileExplorerRepository.STARS)
      .select('node_id, starred_at')
      .eq('user_id', userId)
      .order('starred_at', { ascending: false });

    if (starsResult.error || !starsResult.data?.length) return [];

    const nodeIds = (starsResult.data as any[]).map(
      (s: any) => s.node_id as string,
    );

    // Step 2: fetch matching nodes with space/org/deleted + optional search
    let q = this.db
      .from(FileExplorerRepository.NODES)
      .select('*')
      .in('id', nodeIds)
      .eq('organization_id', orgId)
      .eq('space_id', spaceId)
      .eq('is_deleted', false);

    if (search) q = q.ilike('name', `%${search}%`);

    const nodesResult = await q;

    if (nodesResult.error) return [];

    // Restore starred_at order from step 1
    const nodeMap = new Map(
      ((nodesResult.data ?? []) as IFeNode[]).map((n) => [n.id, n]),
    );

    return nodeIds.map((id) => nodeMap.get(id)).filter(Boolean) as IFeNode[];
  }

  /**
   * Recently modified nodes in the space — non-deleted, ordered by updated_at DESC.
   * Supports optional name search to filter results.
   * NOTE: user_recent_items.item_type check constraint does not include 'file_explorer_node'
   * (only space/task/wiki/etc. are allowed), so updated_at is used as a per-space approximation.
   */
  async listRecent(
    orgId: string,
    spaceId: string,
    search?: string,
  ): Promise<IFeNode[]> {
    let q = this.db
      .from(FileExplorerRepository.NODES)
      .select('*')
      .eq('organization_id', orgId)
      .eq('space_id', spaceId)
      .eq('is_deleted', false);

    if (search) q = q.ilike('name', `%${search}%`);

    q = q.order('updated_at', { ascending: false }).limit(50);

    const r = await q;

    if (r.error) return [];

    return (r.data ?? []) as IFeNode[];
  }

  // ── SPACE MEMBER CHECK ────────────────────────────────────────────────────

  /** Space-membership check used for access gating when a share grant is not present. */
  async isSpaceMember(
    userId: string,
    spaceId: string,
    orgId: string,
  ): Promise<boolean> {
    // Org admin/owner bypass — scoped to the same org
    const { data: orgMember } = await this.db
      .from('organization_members')
      .select('role')
      .eq('user_id', userId)
      .eq('organization_id', orgId)
      .maybeSingle();

    if (orgMember?.role === 'owner' || orgMember?.role === 'admin') return true;

    const { data } = await this.db
      .from('space_members')
      .select('id')
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();

    return !!data;
  }

  /**
   * Return ALL descendants of a node (any depth, any is_deleted state).
   * Uses the GIN-indexed ancestor_ids array: a node D is a descendant of N
   * iff N appears in D.ancestor_ids.
   * Used by permanentDelete to collect file storage paths before removing DB rows.
   */
  async listDescendants(nodeId: string): Promise<IFeNode[]> {
    const r = await this.db
      .from(FileExplorerRepository.NODES)
      .select('*')
      .filter('ancestor_ids', 'cs', `{${nodeId}}`);

    return (r.data ?? []) as IFeNode[];
  }

  /**
   * Return active descendants in the same org/space for public folder ZIP downloads.
   * This intentionally differs from listDescendants(), which includes deleted rows
   * for permanent-delete storage cleanup.
   */
  async listActiveDescendantsForPublicFolder(
    folderId: string,
    orgId: string,
    spaceId: string,
  ): Promise<IFeNode[]> {
    const { data, error } = await this.db
      .from(FileExplorerRepository.NODES)
      .select('*')
      .eq('organization_id', orgId)
      .eq('space_id', spaceId)
      .eq('is_deleted', false)
      .filter('ancestor_ids', 'cs', `{${folderId}}`);

    if (error)
      throw new Error(
        `listActiveDescendantsForPublicFolder failed: ${error.message}`,
      );

    return (data ?? []) as IFeNode[];
  }
}
