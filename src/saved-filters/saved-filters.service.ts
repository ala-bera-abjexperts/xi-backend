import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
  UnprocessableEntityException,
  Optional,
} from '@nestjs/common';
import { AgentOriginService } from '../chat-agent/agent-origin.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { EntitlementsService } from '../licensing/entitlements.service';
import {
  DEV_FILTERS,
  type DevFilter,
} from '../git-integrations/git-dev-filter.util';
import {
  developmentTaskIds,
  spaceRepositoryIds,
} from '../git-integrations/git-integrations.util';
import type { CreateSavedFilterDto } from './dto/create-saved-filter.dto';
import type { UpdateSavedFilterDto } from './dto/update-saved-filter.dto';
import type { SetFilterPermissionsDto } from './dto/set-filter-permissions.dto';
import type { CreateFilterSubscriptionDto } from './dto/create-filter-subscription.dto';
import type { ExecuteFilterDto } from './dto/execute-filter.dto';
import {
  FilterQueryEngine,
  POSTGREST_MAX_ROWS,
  type IFilterExecutionResult,
  type IFilterResultItem,
  type IFilterRuleGroup,
} from './filter-query-engine';

const FILTERS_TABLE = 'saved_filters';
const EXPORT_MAX_ROWS = 10000;
const EXPORT_PAGE_SIZE = 1000;
const DEV_FILTER_LABELS: Record<DevFilter, string> = {
  has_pr: 'Has pull request',
  pr_open: 'Pull request open',
  pr_merged: 'Pull request merged',
  build_failing: 'Build failing',
  no_pr: 'No pull request',
};
const PERMS_TABLE = 'saved_filter_permissions';
const SUBS_TABLE = 'saved_filter_subscriptions';
const FILTER_SELECT =
  '*, owner:users!owner_id(id, first_name, last_name, email, avatar_url)';
// The cross-entity 'spaces' fan-out default. Wiki is intentionally NOT part of
// it — wiki pages are only queried via dedicated source_type='wiki' filters.
const FILTER_ENTITY_TYPES = ['processes', 'tasks', 'lists'] as const;
const WIKI_ENTITY_TYPE = 'wiki' as const;
type FilterEntityType =
  | (typeof FILTER_ENTITY_TYPES)[number]
  | typeof WIKI_ENTITY_TYPE;
type FilterPermission = 'can_view' | 'can_edit' | 'can_delete';
const ENTITY_VIEW_PERMISSIONS: Record<FilterEntityType, string> = {
  processes: 'view_processes',
  tasks: 'view_tasks',
  lists: 'view_lists',
  wiki: 'view_wiki_pages',
};

export interface ParentOptionRow {
  entity_type: 'tasks' | 'processes';
  id: string;
  key: string;
  title: string;
  space_id: string | null;
  space_key?: string | null;
}

export interface IFilterFieldDefinition {
  name: string;
  label: string;
  inputType: string;
  operators: { name: string; label: string }[];
  values?: { name: string; label: string }[];
  defaultOperator?: string;
  entityTypes: string[];
  isCustomField?: boolean;
  customFieldType?: string;
}

/** SEC-06: the same words as on the object. Export language is English, like the headers. */
function robertLabel(origin?: { confirmedBy: string | null; createdAt: string }): string {
  if (!origin) return '';
  return `Drafted by Robert · reviewed by ${origin.confirmedBy ?? 'a former member'} · ${origin.createdAt.slice(0, 10)}`;
}

@Injectable()
export class SavedFiltersService {
  private readonly logger = new Logger(SavedFiltersService.name);

  private queryEngine?: FilterQueryEngine;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissionsService: PermissionsService,
    private readonly entitlements: EntitlementsService,
    @Optional() private readonly origins?: AgentOriginService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Ticket 10: the organization has the Git integration licence (development field, columns, export). */
  private async hasGitIntegration(organizationId: string): Promise<boolean> {
    return (
      await this.entitlements.getEffectiveEntitlements(organizationId)
    ).has('feature_external_integrations');
  }

  private getQueryEngine() {
    if (!this.queryEngine) {
      // SupabaseAdminService initializes its client in onModuleInit, after
      // dependent service constructors run, so the filter engine must be lazy.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      this.queryEngine = new FilterQueryEngine(this.client);
    }

    return this.queryEngine;
  }

  private normalizeEntityTypes(
    sourceType: string,
    sourceEntityTypes?: string[] | null,
  ): FilterEntityType[] {
    const normalizeOne = (entityType: string): FilterEntityType | null => {
      const aliases: Record<string, FilterEntityType> = {
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
    };

    if (sourceType === 'spaces' || sourceType === 'filter') {
      const requested =
        sourceEntityTypes && sourceEntityTypes.length > 0
          ? sourceEntityTypes
          : [...FILTER_ENTITY_TYPES];

      return [
        ...new Set(
          requested
            .map((entityType) => normalizeOne(entityType))
            .filter((entityType): entityType is FilterEntityType =>
              Boolean(entityType),
            ),
        ),
      ];
    }

    const normalizedSource = normalizeOne(sourceType);
    if (normalizedSource) return [normalizedSource];

    return [];
  }

  private assertValidQuery(
    query: Record<string, unknown> | IFilterRuleGroup | undefined,
    fieldTypeMap?: Record<string, string>,
    sort?: { column?: string | null } | null,
  ): asserts query is IFilterRuleGroup {
    if (!this.isRuleGroup(query, 0)) {
      throw new BadRequestException(
        'Invalid query: expected a rule group with combinator and rules',
      );
    }

    if (fieldTypeMap) {
      this.assertAllowedCustomFilterFields(query, fieldTypeMap);
      if (sort?.column)
        this.assertAllowedCustomFilterField(sort.column, fieldTypeMap);
    }
  }

  private isRuleGroup(
    value: unknown,
    depth: number,
  ): value is IFilterRuleGroup {
    if (
      depth > 20 ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      return false;
    }

    const group = value as Record<string, unknown>;
    if (group['combinator'] !== 'and' && group['combinator'] !== 'or') {
      return false;
    }
    if (!Array.isArray(group['rules'])) {
      return false;
    }
    if (group['not'] !== undefined && typeof group['not'] !== 'boolean') {
      return false;
    }

    return group['rules'].every((rule) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        return false;
      }

      const ruleObject = rule as Record<string, unknown>;
      if ('combinator' in ruleObject || 'rules' in ruleObject) {
        return this.isRuleGroup(ruleObject, depth + 1);
      }

      return (
        typeof ruleObject['field'] === 'string' &&
        ruleObject['field'].trim().length > 0 &&
        typeof ruleObject['operator'] === 'string' &&
        ruleObject['operator'].trim().length > 0 &&
        Object.prototype.hasOwnProperty.call(ruleObject, 'value')
      );
    });
  }

  private assertAllowedCustomFilterFields(
    group: IFilterRuleGroup,
    fieldTypeMap: Record<string, string>,
  ): void {
    for (const rule of group.rules) {
      if ('combinator' in rule) {
        this.assertAllowedCustomFilterFields(rule, fieldTypeMap);
      } else {
        this.assertAllowedCustomFilterField(rule.field, fieldTypeMap);
      }
    }
  }

  private assertAllowedCustomFilterField(
    field: string,
    fieldTypeMap: Record<string, string>,
  ): void {
    if (!field.startsWith('cf_')) return;

    const fieldKey = field.slice(3);
    if (!/^[A-Za-z0-9_]+$/.test(fieldKey) || !fieldTypeMap[field]) {
      throw new BadRequestException(`Invalid custom filter field: ${field}`);
    }
  }

  private queryUsesCustomFields(
    group: IFilterRuleGroup,
    sort?: { column?: string | null } | null,
  ): boolean {
    if (sort?.column?.startsWith('cf_')) return true;

    return group.rules.some((rule) =>
      'combinator' in rule
        ? this.queryUsesCustomFields(rule)
        : rule.field.startsWith('cf_'),
    );
  }

  private async filterSpaceIdsByOrganization(
    spaceIds: string[],
    organizationId: string,
  ): Promise<string[]> {
    const unique = [...new Set(spaceIds.filter(Boolean))];
    if (unique.length === 0) return [];

    const { data, error } = await this.client
      .from('spaces')
      .select('id')
      .eq('organization_id', organizationId)
      .in('id', unique);

    if (error) throw new BadRequestException(error.message);

    return ((data ?? []) as { id: string }[]).map((space) => space.id);
  }

  private async getOrganizationSpaceIds(
    organizationId: string,
  ): Promise<string[]> {
    const { data, error } = await this.client
      .from('spaces')
      .select('id')
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    return ((data ?? []) as { id: string }[]).map((space) => space.id);
  }

  private async getPermittedSpaceIdsByEntity(
    userId: string,
    organizationId: string,
    entityTypes: FilterEntityType[],
    requestedSpaceIds: string[] = [],
  ): Promise<Record<string, string[]>> {
    const candidateSpaceIds =
      requestedSpaceIds.length > 0
        ? await this.filterSpaceIdsByOrganization(
            requestedSpaceIds,
            organizationId,
          )
        : await this.getOrganizationSpaceIds(organizationId);

    const result: Record<string, string[]> = Object.fromEntries(
      entityTypes.map((entityType) => [entityType, []]),
    );

    if (candidateSpaceIds.length === 0 || entityTypes.length === 0)
      return result;

    const permissionRows = await Promise.all(
      candidateSpaceIds.map(async (spaceId) => ({
        spaceId,
        resolved: await this.permissionsService.getUserSpacePermissions(
          userId,
          organizationId,
          spaceId,
        ),
      })),
    );

    for (const { spaceId, resolved } of permissionRows) {
      if (!resolved.isMember) continue;

      for (const entityType of entityTypes) {
        if (resolved.permissions[ENTITY_VIEW_PERMISSIONS[entityType]]) {
          result[entityType].push(spaceId);
        }
      }
    }

    return result;
  }

  /**
   * Space ids across the organization where `userId` may VIEW tasks. A thin public
   * wrapper over `getPermittedSpaceIdsByEntity` for the tasks entity, used by the
   * Document Designer data resolver to constrain its service-role subtask /
   * linked-task reads to spaces the caller is actually permitted to access.
   */
  async getPermittedTaskSpaceIds(
    userId: string,
    organizationId: string,
  ): Promise<string[]> {
    const entityTypes: FilterEntityType[] = ['tasks'];
    const byEntity = await this.getPermittedSpaceIdsByEntity(
      userId,
      organizationId,
      entityTypes,
    );

    return byEntity['tasks'] ?? [];
  }

  /**
   * Space ids across the organization where `userId` holds `viewPermission`
   * (a `space_permissions` key with the `can_` prefix stripped, e.g.
   * 'view_plans'). Additive sibling of {@link getPermittedTaskSpaceIds} for
   * modules the query engine has no table config for — the Document Designer
   * reads those tables on the service-role client (RLS bypassed) and needs the
   * same space scoping the engine would have applied.
   */
  async getPermittedSpaceIdsForPermission(
    userId: string,
    organizationId: string,
    viewPermission: string,
    requestedSpaceIds: string[] = [],
  ): Promise<string[]> {
    const candidateSpaceIds =
      requestedSpaceIds.length > 0
        ? await this.filterSpaceIdsByOrganization(
            requestedSpaceIds,
            organizationId,
          )
        : await this.getOrganizationSpaceIds(organizationId);

    if (candidateSpaceIds.length === 0) return [];

    const rows = await Promise.all(
      candidateSpaceIds.map(async (spaceId) => ({
        spaceId,
        resolved: await this.permissionsService.getUserSpacePermissions(
          userId,
          organizationId,
          spaceId,
        ),
      })),
    );

    return rows
      .filter(
        ({ resolved }) =>
          resolved.isMember && Boolean(resolved.permissions[viewPermission]),
      )
      .map(({ spaceId }) => spaceId);
  }

  private flattenPermittedSpaceIds(
    permittedSpaceIdsByEntity: Record<string, string[]>,
  ): string[] {
    return [
      ...new Set(
        Object.values(permittedSpaceIdsByEntity).flat().filter(Boolean),
      ),
    ];
  }

  /**
   * Org admin/owner status is only needed by the engine's wiki ACL
   * post-filter, so the lookup is skipped for non-wiki executions.
   */
  private async resolveIsOrgAdmin(
    userId: string,
    organizationId: string,
    entityTypes: FilterEntityType[],
  ): Promise<boolean> {
    if (!entityTypes.includes(WIKI_ENTITY_TYPE)) return false;

    return this.permissionsService.isAdminOrOwner(userId, organizationId);
  }

  private async getUserFilterShareTargets(
    userId: string,
    organizationId: string,
  ): Promise<{ spaceIds: string[]; groupIds: string[]; roleIds: string[] }> {
    const { data: groupMemberships } = await this.client
      .from('user_group_members')
      .select(
        'group_id, role_id, group:user_groups(id, organization_id, is_deleted)',
      )
      .eq('user_id', userId);

    const userGroups = (
      (groupMemberships ?? []) as Record<string, unknown>[]
    ).filter((membership) => {
      const group = membership['group'] as Record<string, unknown> | null;
      return (
        group &&
        group['organization_id'] === organizationId &&
        group['is_deleted'] !== true
      );
    });
    const groupIds = userGroups
      .map((membership) => membership['group_id'] as string | null)
      .filter((id): id is string => Boolean(id));
    const groupRoleIds = userGroups
      .map((membership) => membership['role_id'] as string | null)
      .filter((id): id is string => Boolean(id));

    const { data: roleAssignments } = await this.client
      .from('user_role_assignments')
      .select('role_id')
      .eq('user_id', userId)
      .eq('organization_id', organizationId);
    const directRoleIds = ((roleAssignments ?? []) as Record<string, unknown>[])
      .map((assignment) => assignment['role_id'] as string | null)
      .filter((id): id is string => Boolean(id));
    const roleIds = [...new Set([...directRoleIds, ...groupRoleIds])];

    const spaceIds = new Set<string>();

    const { data: directSpaces } = await this.client
      .from('space_members')
      .select('space_id')
      .eq('member_type', 'user')
      .eq('user_id', userId)
      .eq('is_active', true);
    for (const row of (directSpaces ?? []) as Record<string, unknown>[]) {
      if (row['space_id']) spaceIds.add(row['space_id'] as string);
    }

    if (groupIds.length > 0) {
      const { data: groupSpaces } = await this.client
        .from('space_members')
        .select('space_id')
        .eq('member_type', 'group')
        .in('group_id', groupIds)
        .eq('is_active', true);
      for (const row of (groupSpaces ?? []) as Record<string, unknown>[]) {
        if (row['space_id']) spaceIds.add(row['space_id'] as string);
      }
    }

    if (roleIds.length > 0) {
      const { data: roleSpaces } = await this.client
        .from('space_members')
        .select('space_id')
        .eq('member_type', 'role')
        .in('role_id', roleIds)
        .eq('is_active', true);
      for (const row of (roleSpaces ?? []) as Record<string, unknown>[]) {
        if (row['space_id']) spaceIds.add(row['space_id'] as string);
      }
    }

    return {
      spaceIds: await this.filterSpaceIdsByOrganization(
        [...spaceIds],
        organizationId,
      ),
      groupIds,
      roleIds,
    };
  }

  private async getPermissionFilterIds(
    userId: string,
    organizationId: string,
    permission: FilterPermission,
  ): Promise<string[]> {
    const { spaceIds, groupIds, roleIds } =
      await this.getUserFilterShareTargets(userId, organizationId);
    const clauses = [`and(target_type.eq.user,target_id.eq.${userId})`];
    if (spaceIds.length > 0) {
      clauses.push(
        `and(target_type.eq.space,target_id.in.(${spaceIds.join(',')}))`,
      );
    }
    if (groupIds.length > 0) {
      clauses.push(
        `and(target_type.eq.group,target_id.in.(${groupIds.join(',')}))`,
      );
    }
    if (roleIds.length > 0) {
      clauses.push(
        `and(target_type.eq.role,target_id.in.(${roleIds.join(',')}))`,
      );
    }

    const { data: permRows } = await this.client
      .from(PERMS_TABLE)
      .select('filter_id')
      .eq(permission, true)
      .or(clauses.join(','));

    return [
      ...new Set(
        ((permRows ?? []) as { filter_id: string }[]).map(
          (row) => row.filter_id,
        ),
      ),
    ];
  }

  private async getAccessibleFilterIds(
    userId: string,
    organizationId: string,
  ): Promise<string[]> {
    const permittedIds = await this.getPermissionFilterIds(
      userId,
      organizationId,
      'can_view',
    );

    let query = this.client
      .from(FILTERS_TABLE)
      .select('id')
      .eq('organization_id', organizationId);

    if (permittedIds.length > 0) {
      query = query.or(
        `owner_id.eq.${userId},visibility.eq.organization,id.in.(${permittedIds.join(',')})`,
      );
    } else {
      query = query.or(`owner_id.eq.${userId},visibility.eq.organization`);
    }

    const { data, error } = await query;
    if (error) throw new BadRequestException(error.message);

    return ((data ?? []) as { id: string }[]).map((row) => row.id);
  }

  private async checkPermission(
    filterId: string,
    userId: string,
    organizationId: string,
    permission: FilterPermission,
  ): Promise<boolean> {
    const ids = await this.getPermissionFilterIds(
      userId,
      organizationId,
      permission,
    );

    return ids.includes(filterId);
  }

  private async loadFilterById(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(FILTERS_TABLE)
      .select(FILTER_SELECT)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Filter not found');

    return data as Record<string, unknown>;
  }

  private async assertCanViewFilter(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const filter = await this.loadFilterById(id, organizationId);

    if (
      filter['owner_id'] === userId ||
      filter['visibility'] === 'organization' ||
      (await this.checkPermission(id, userId, organizationId, 'can_view'))
    ) {
      return filter;
    }

    throw new NotFoundException('Filter not found');
  }

  // ── List ─────────────────────────────────────────────────────────────────

  async getAll(
    organizationId: string,
    userId: string,
    filter?: { search?: string; visibility?: string; is_favorite?: boolean },
  ): Promise<{ data: Record<string, unknown>[]; count: number }> {
    const permittedIds = await this.getPermissionFilterIds(
      userId,
      organizationId,
      'can_view',
    );

    let query = this.client
      .from(FILTERS_TABLE)
      .select(FILTER_SELECT)
      .eq('organization_id', organizationId);

    if (permittedIds.length > 0) {
      query = query.or(
        `owner_id.eq.${userId},visibility.eq.organization,id.in.(${permittedIds.join(',')})`,
      );
    } else {
      query = query.or(`owner_id.eq.${userId},visibility.eq.organization`);
    }

    if (filter?.search) {
      const safe = filter.search.replace(/[,.()"'\\]/g, '');
      if (safe) query = query.ilike('name', `%${safe}%`);
    }
    if (filter?.visibility) {
      query = query.eq('visibility', filter.visibility);
    }
    if (filter?.is_favorite !== undefined) {
      query = query
        .eq('is_favorite', filter.is_favorite)
        .eq('owner_id', userId);
    }

    const { data, error } = await query.order('updated_at', {
      ascending: false,
    });
    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    return { data: rows, count: rows.length };
  }

  // ── Get by ID ─────────────────────────────────────────────────────────────

  async getById(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Record<string, unknown> }> {
    return { data: await this.assertCanViewFilter(id, organizationId, userId) };
  }

  // ── Defaults ──────────────────────────────────────────────────────────────

  async getDefaults(
    organizationId: string,
  ): Promise<{ data: Record<string, unknown>[]; count: number }> {
    const { data, error } = await this.client
      .from(FILTERS_TABLE)
      .select(FILTER_SELECT)
      .eq('organization_id', organizationId)
      .eq('is_default', true)
      .order('name', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    return { data: rows, count: rows.length };
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async create(
    organizationId: string,
    userId: string,
    dto: CreateSavedFilterDto,
  ): Promise<{ data: Record<string, unknown> }> {
    this.assertValidQuery(dto.query);
    if (this.queryUsesCustomFields(dto.query, dto.sort_config as never)) {
      const fieldTypeMap = await this.buildFieldTypeMap(organizationId);
      this.assertValidQuery(dto.query, fieldTypeMap, dto.sort_config as never);
    }

    if (dto.source_type === 'filter') {
      if (!dto.source_filter_id) {
        throw new BadRequestException(
          'source_filter_id is required when source_type is filter',
        );
      }

      await this.assertCanViewFilter(
        dto.source_filter_id,
        organizationId,
        userId,
      );
    }

    const createResult = (await this.client.rpc(
      'create_saved_filter_with_space_permissions',
      {
        p_organization_id: organizationId,
        p_owner_id: userId,
        p_name: dto.name,
        p_description: dto.description ?? null,
        p_query: dto.query,
        p_source_type: dto.source_type,
        p_source_space_ids: dto.source_space_ids ?? [],
        p_source_entity_types: dto.source_entity_types ?? [],
        p_source_filter_id: dto.source_filter_id ?? null,
        p_columns: dto.columns ?? [],
        p_sort_config: dto.sort_config ?? null,
        p_visibility: dto.visibility ?? 'private',
      },
    )) as { data: unknown; error: { message: string } | null };
    const { data, error } = createResult;

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to create filter',
      );
    }

    // The create RPC does not include view_type in its INSERT (legacy function).
    // Apply it via a direct UPDATE when a non-default value is requested.
    if (dto.view_type && dto.view_type !== 'list') {
      const newId = (data as Record<string, unknown>)['id'] as string;
      const { error: vtError } = await this.client
        .from('saved_filters')
        .update({ view_type: dto.view_type })
        .eq('id', newId)
        .eq('organization_id', organizationId);

      if (vtError) throw new BadRequestException(vtError.message);
      (data as Record<string, unknown>)['view_type'] = dto.view_type;
    }

    await this.logAudit(
      organizationId,
      userId,
      'saved_filter',
      (data as Record<string, unknown>)['id'] as string,
      'create',
      {
        name: dto.name,
        visibility: dto.visibility ?? 'private',
        source_type: dto.source_type,
        source_space_ids: dto.source_space_ids ?? [],
        source_entity_types: dto.source_entity_types ?? [],
      },
    );

    return { data: data as Record<string, unknown> };
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async update(
    id: string,
    organizationId: string,
    userId: string,
    dto: UpdateSavedFilterDto,
  ): Promise<{ data: Record<string, unknown> }> {
    const { data: existing } = await this.getById(id, organizationId, userId);

    if (dto.query !== undefined) {
      this.assertValidQuery(dto.query);
      if (
        this.queryUsesCustomFields(
          dto.query,
          (dto.sort_config ?? existing['sort_config']) as never,
        )
      ) {
        const fieldTypeMap = await this.buildFieldTypeMap(organizationId);
        this.assertValidQuery(
          dto.query,
          fieldTypeMap,
          (dto.sort_config ?? existing['sort_config']) as never,
        );
      }
    } else if (dto.sort_config !== undefined) {
      const sortColumn =
        (dto.sort_config as { column?: string } | null | undefined)?.column ??
        '';
      if (sortColumn.startsWith('cf_')) {
        const fieldTypeMap = await this.buildFieldTypeMap(organizationId);
        this.assertAllowedCustomFilterField(sortColumn, fieldTypeMap);
      }
    }

    const isOwner = existing['owner_id'] === userId;
    if (!isOwner) {
      const canEdit = await this.checkPermission(
        id,
        userId,
        organizationId,
        'can_edit',
      );
      if (!canEdit) {
        throw new ForbiddenException(
          'You do not have permission to edit this filter',
        );
      }
    }

    const nextSourceType =
      dto.source_type ?? (existing['source_type'] as string);
    const nextSourceFilterId =
      dto.source_filter_id !== undefined
        ? dto.source_filter_id
        : (existing['source_filter_id'] as string | null | undefined);

    if (nextSourceType === 'filter') {
      if (!nextSourceFilterId) {
        throw new BadRequestException(
          'source_filter_id is required when source_type is filter',
        );
      }

      if (nextSourceFilterId === id) {
        throw new BadRequestException('A filter cannot use itself as a source');
      }

      await this.assertCanViewFilter(
        nextSourceFilterId,
        organizationId,
        userId,
      );
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.description !== undefined) patch['description'] = dto.description;
    if (dto.query !== undefined) patch['query'] = dto.query;
    if (dto.source_type !== undefined) patch['source_type'] = dto.source_type;
    if (dto.source_space_ids !== undefined)
      patch['source_space_ids'] = dto.source_space_ids;
    if (dto.source_entity_types !== undefined)
      patch['source_entity_types'] = dto.source_entity_types;
    if (dto.source_filter_id !== undefined)
      patch['source_filter_id'] = dto.source_filter_id;
    if (dto.columns !== undefined) patch['columns'] = dto.columns;
    if (dto.sort_config !== undefined) patch['sort_config'] = dto.sort_config;
    if (dto.visibility !== undefined) patch['visibility'] = dto.visibility;
    if (dto.view_type !== undefined) patch['view_type'] = dto.view_type;

    const updatable = Object.keys(patch).filter((k) => k !== 'updated_at');
    if (updatable.length === 0) {
      throw new BadRequestException(
        'At least one field must be provided for update',
      );
    }

    const finalVisibility =
      dto.visibility ?? (existing['visibility'] as string);
    const finalSpaceIds =
      dto.source_space_ids ??
      (existing['source_space_ids'] as string[] | null | undefined) ??
      [];
    const spacePermissionMode =
      finalVisibility === 'space'
        ? 'replace'
        : existing['visibility'] === 'space'
          ? 'clear'
          : 'keep';

    const updateResult = (await this.client.rpc(
      'update_saved_filter_with_space_permissions',
      {
        p_filter_id: id,
        p_organization_id: organizationId,
        p_patch: patch,
        p_space_permission_mode: spacePermissionMode,
        p_space_ids: finalSpaceIds,
      },
    )) as { data: unknown; error: { message: string } | null };
    const { data, error } = updateResult;

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to update filter',
      );
    }

    // The update RPC patch handler does not handle view_type (legacy function).
    // Apply it via a direct UPDATE when explicitly provided.
    if (dto.view_type !== undefined) {
      const { error: vtError } = await this.client
        .from('saved_filters')
        .update({ view_type: dto.view_type })
        .eq('id', id)
        .eq('organization_id', organizationId);

      if (vtError) throw new BadRequestException(vtError.message);
      (data as Record<string, unknown>)['view_type'] = dto.view_type;
    }

    await this.logAudit(organizationId, userId, 'saved_filter', id, 'update', {
      fields: Object.keys(patch).filter((key) => key !== 'updated_at'),
      before: {
        name: existing['name'],
        visibility: existing['visibility'],
        source_type: existing['source_type'],
        source_space_ids: existing['source_space_ids'],
        source_entity_types: existing['source_entity_types'],
        source_filter_id: existing['source_filter_id'],
      },
      after: {
        name: (data as Record<string, unknown>)['name'],
        visibility: (data as Record<string, unknown>)['visibility'],
        source_type: (data as Record<string, unknown>)['source_type'],
        source_space_ids: (data as Record<string, unknown>)['source_space_ids'],
        source_entity_types: (data as Record<string, unknown>)[
          'source_entity_types'
        ],
        source_filter_id: (data as Record<string, unknown>)['source_filter_id'],
      },
    });

    return { data: data as Record<string, unknown> };
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async delete(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    const { data: existing } = await this.getById(id, organizationId, userId);

    if (existing['is_default']) {
      throw new BadRequestException('Cannot delete system default filters');
    }

    const isOwner = existing['owner_id'] === userId;
    if (!isOwner) {
      const canDelete = await this.checkPermission(
        id,
        userId,
        organizationId,
        'can_delete',
      );
      if (!canDelete) {
        throw new ForbiddenException(
          'You do not have permission to delete this filter',
        );
      }
    }

    const { error } = await this.client
      .from(FILTERS_TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
    await this.logAudit(organizationId, userId, 'saved_filter', id, 'delete', {
      name: existing['name'],
      visibility: existing['visibility'],
      source_type: existing['source_type'],
    });

    return { success: true, message: 'Filter deleted' };
  }

  // ── Toggle Favorite ───────────────────────────────────────────────────────

  async toggleFavorite(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Record<string, unknown> }> {
    const { data: existing } = await this.getById(id, organizationId, userId);

    if (existing['owner_id'] !== userId) {
      throw new ForbiddenException(
        'Only the filter owner can toggle favorites',
      );
    }

    const currentFav = existing['is_favorite'] as boolean;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(FILTERS_TABLE)
      .update({
        is_favorite: !currentFav,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .eq('owner_id', userId)
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to toggle favorite',
      );
    }

    await this.logAudit(
      organizationId,
      userId,
      'saved_filter',
      id,
      'favorite',
      {
        is_favorite: (data as Record<string, unknown>)['is_favorite'],
      },
    );

    return { data: data as Record<string, unknown> };
  }

  // ── Permissions ───────────────────────────────────────────────────────────

  async getPermissions(
    filterId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Record<string, unknown>[] }> {
    const { data: filter } = await this.getById(
      filterId,
      organizationId,
      userId,
    );

    if (filter['owner_id'] !== userId) {
      throw new ForbiddenException(
        'Only the filter owner can manage permissions',
      );
    }

    const { data, error } = await this.client
      .from(PERMS_TABLE)
      .select('*')
      .eq('filter_id', filterId)
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return { data: (data ?? []) as Record<string, unknown>[] };
  }

  async setPermissions(
    filterId: string,
    organizationId: string,
    userId: string,
    dto: SetFilterPermissionsDto,
  ): Promise<{ success: true }> {
    const { data: filter } = await this.getById(
      filterId,
      organizationId,
      userId,
    );

    if (filter['owner_id'] !== userId) {
      throw new ForbiddenException(
        'Only the filter owner can manage permissions',
      );
    }

    const uniquePermissions = new Map<string, Record<string, unknown>>();

    for (const p of dto.permissions) {
      uniquePermissions.set(`${p.target_type}:${p.target_id}`, {
        filter_id: filterId,
        target_type: p.target_type,
        target_id: p.target_id,
        can_view: p.can_view ?? true,
        can_edit: p.can_edit ?? false,
        can_delete: p.can_delete ?? false,
      });
    }

    const rows = [...uniquePermissions.values()];

    const { error } = await this.client.rpc(
      'replace_saved_filter_permissions',
      {
        p_filter_id: filterId,
        p_organization_id: organizationId,
        p_permissions: rows,
      },
    );

    if (error) {
      throw new BadRequestException(
        `Failed to set permissions: ${error.message}`,
      );
    }

    await this.logAudit(
      organizationId,
      userId,
      'saved_filter_permission',
      filterId,
      'update',
      {
        scope: 'filter_permission',
        count: rows.length,
      },
    );

    return { success: true };
  }

  private async logAudit(
    organizationId: string,
    userId: string,
    entityType: string,
    entityId: string,
    action: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.client.from('audit_logs').insert({
        organization_id: organizationId,
        user_id: userId,
        entity_type: entityType,
        entity_id: entityId,
        action,
        changes,
      });
    } catch {
      // Audit is best-effort and must not break filter mutations.
    }
  }

  private async requireAudit(
    organizationId: string,
    userId: string,
    entityType: string,
    entityId: string,
    action: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.client.from('audit_logs').insert({
      organization_id: organizationId,
      user_id: userId,
      entity_type: entityType,
      entity_id: entityId,
      action,
      changes,
    });

    if (error) {
      throw new BadRequestException(
        `Failed to write audit log: ${error.message}`,
      );
    }
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  async getSubscriptions(
    filterId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Record<string, unknown>[] }> {
    const { data: filter } = await this.getById(
      filterId,
      organizationId,
      userId,
    );
    const canViewAllSubscriptions =
      filter['owner_id'] === userId ||
      (await this.permissionsService.isAdminOrOwner(userId, organizationId));

    let query = this.client
      .from(SUBS_TABLE)
      .select('*')
      .eq('filter_id', filterId)
      .order('created_at', { ascending: true });

    if (!canViewAllSubscriptions) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query;

    if (error) throw new BadRequestException(error.message);
    return { data: (data ?? []) as Record<string, unknown>[] };
  }

  async createSubscription(
    filterId: string,
    organizationId: string,
    userId: string,
    dto: CreateFilterSubscriptionDto,
  ): Promise<{ data: Record<string, unknown> }> {
    await this.getById(filterId, organizationId, userId);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(SUBS_TABLE)
      .upsert(
        {
          filter_id: filterId,
          user_id: userId,
          schedule_cron: dto.schedule_cron,
          schedule_label: dto.schedule_label ?? null,
          schedule_frequency: dto.schedule_frequency ?? 'daily',
          schedule_time: dto.schedule_time ?? '09:00',
          schedule_days_of_week: dto.schedule_days_of_week ?? [],
          schedule_day_of_month: dto.schedule_day_of_month ?? 1,
          schedule_month_of_year: dto.schedule_month_of_year ?? 1,
          end_type: dto.end_type ?? 'never',
          end_date: dto.end_date ?? null,
          max_occurrences: dto.max_occurrences ?? null,
          is_active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'filter_id,user_id' },
      )
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to create subscription',
      );
    }

    await this.logAudit(
      organizationId,
      userId,
      'saved_filter_subscription',
      filterId,
      'create',
      {
        subscription_id: (data as Record<string, unknown>)['id'],
        schedule_cron: dto.schedule_cron,
        schedule_frequency: dto.schedule_frequency ?? 'daily',
      },
    );

    return { data: data as Record<string, unknown> };
  }

  async deleteSubscription(
    filterId: string,
    subscriptionId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    const { data: filter } = await this.getById(
      filterId,
      organizationId,
      userId,
    );
    const { data: existing, error: lookupError } = await this.client
      .from(SUBS_TABLE)
      .select('filter_id, user_id')
      .eq('id', subscriptionId)
      .eq('filter_id', filterId)
      .maybeSingle();

    if (lookupError) throw new BadRequestException(lookupError.message);
    if (!existing) throw new NotFoundException('Subscription not found');
    if ((existing as { user_id: string }).user_id !== userId) {
      const canDeleteOtherSubscriptions =
        filter['owner_id'] === userId ||
        (await this.permissionsService.isAdminOrOwner(userId, organizationId));

      if (!canDeleteOtherSubscriptions) {
        throw new ForbiddenException(
          'You do not have permission to delete this subscription',
        );
      }
    }

    const { error } = await this.client
      .from(SUBS_TABLE)
      .delete()
      .eq('id', subscriptionId)
      .eq('filter_id', filterId);

    if (error) throw new BadRequestException(error.message);
    await this.logAudit(
      organizationId,
      userId,
      'saved_filter_subscription',
      filterId,
      'delete',
      { subscription_id: subscriptionId },
    );

    return { success: true, message: 'Subscription deleted' };
  }

  // ── Filter Execution ──────────────────────────────────────────────────────

  async executeAdHoc(
    dto: ExecuteFilterDto,
    organizationId: string,
    userId: string,
  ): Promise<{ data: IFilterExecutionResult }> {
    const fieldTypeMap = await this.buildFieldTypeMap(organizationId);
    this.assertValidQuery(dto.query, fieldTypeMap, dto.sort);

    // A 'filter' source can resolve to ANY entity type (including wiki), so
    // the permission map must cover them all — a missing key would skip the
    // permitted-space intersection for that entity type.
    const entityTypes: FilterEntityType[] =
      dto.source_type === 'filter'
        ? [...FILTER_ENTITY_TYPES, WIKI_ENTITY_TYPE]
        : this.normalizeEntityTypes(dto.source_type, dto.source_entity_types);
    const requestedSpaceIds =
      dto.source_type === 'filter' ? [] : (dto.source_space_ids ?? []);
    const permittedSpaceIdsByEntity = await this.getPermittedSpaceIdsByEntity(
      userId,
      organizationId,
      entityTypes,
      requestedSpaceIds,
    );

    if (dto.source_type === 'filter' && dto.source_filter_id) {
      await this.assertCanViewFilter(
        dto.source_filter_id,
        organizationId,
        userId,
      );
    }

    const result = await this.getQueryEngine().execute({
      query: dto.query as unknown as IFilterRuleGroup,
      source_type: dto.source_type,
      source_space_ids: requestedSpaceIds,
      source_entity_types: dto.source_entity_types ?? [],
      source_filter_id: dto.source_filter_id ?? null,
      page: dto.page ?? 1,
      pageSize: dto.pageSize ?? 50,
      sort: dto.sort as { column: string; direction: string } | undefined,
      organizationId,
      userId,
      fieldTypeMap,
      permittedSpaceIdsByEntity,
      withDevelopment: await this.hasGitIntegration(organizationId),
      permittedFilterIds: await this.getAccessibleFilterIds(
        userId,
        organizationId,
      ),
      isOrgAdmin: await this.resolveIsOrgAdmin(
        userId,
        organizationId,
        entityTypes,
      ),
    });

    return { data: result };
  }

  async executeFilter(
    filterId: string,
    organizationId: string,
    userId: string,
    pagination: {
      page: number;
      pageSize: number;
      sort?: { column: string; direction: string };
    },
    options: { audit?: boolean } = {},
  ): Promise<{ data: IFilterExecutionResult }> {
    const filter = await this.assertCanViewFilter(
      filterId,
      organizationId,
      userId,
    );

    // Fire-and-forget: update execution stats
    void this.client
      .from(FILTERS_TABLE)
      .update({
        last_executed_at: new Date().toISOString(),
        execution_count: ((filter['execution_count'] as number) || 0) + 1,
      })
      .eq('id', filterId)
      .then(() => undefined);

    const fieldTypeMap = await this.buildFieldTypeMap(organizationId);
    this.assertValidQuery(
      filter['query'] as Record<string, unknown>,
      fieldTypeMap,
      pagination.sort ?? (filter['sort_config'] as { column?: string } | null),
    );
    const sourceType = filter['source_type'] as string;
    const sourceSpaceIds =
      sourceType === 'filter'
        ? []
        : ((filter['source_space_ids'] as string[]) ?? []);

    // A 'filter' source can resolve to ANY entity type (including wiki) — see
    // executeAdHoc for why the permission map must cover them all.
    const entityTypes: FilterEntityType[] =
      sourceType === 'filter'
        ? [...FILTER_ENTITY_TYPES, WIKI_ENTITY_TYPE]
        : this.normalizeEntityTypes(
            sourceType,
            (filter['source_entity_types'] as string[]) || [],
          );
    const permittedSpaceIdsByEntity = await this.getPermittedSpaceIdsByEntity(
      userId,
      organizationId,
      entityTypes,
      sourceSpaceIds,
    );

    const result = await this.getQueryEngine().execute({
      query: filter['query'] as IFilterRuleGroup,
      source_type: sourceType,
      source_space_ids: sourceSpaceIds,
      source_entity_types: (filter['source_entity_types'] as string[]) || [],
      source_filter_id: (filter['source_filter_id'] as string | null) ?? null,
      page: pagination.page,
      pageSize: pagination.pageSize,
      sort: pagination.sort,
      organizationId,
      userId,
      fieldTypeMap,
      permittedSpaceIdsByEntity,
      withDevelopment: await this.hasGitIntegration(organizationId),
      permittedFilterIds: await this.getAccessibleFilterIds(
        userId,
        organizationId,
      ),
      isOrgAdmin: await this.resolveIsOrgAdmin(
        userId,
        organizationId,
        entityTypes,
      ),
    });

    if (options.audit !== false) {
      await this.logAudit(
        organizationId,
        userId,
        'saved_filter',
        filterId,
        'execute',
        {
          page: pagination.page,
          page_size: pagination.pageSize,
          row_count: result.data.length,
          total: result.total,
        },
      );
    }

    return { data: result };
  }

  async exportToCSV(
    filterId: string,
    organizationId: string,
    userId: string,
  ): Promise<string> {
    // PostgREST returns at most 1000 rows per request, so page up to the 10000-row export limit.
    // Sorted (with the engine's `id` tie-breaker) so pages neither overlap nor skip rows.
    const items: IFilterResultItem[] = [];

    for (let page = 1; items.length < EXPORT_MAX_ROWS; page++) {
      const { data: result } = await this.executeFilter(
        filterId,
        organizationId,
        userId,
        {
          page,
          pageSize: EXPORT_PAGE_SIZE,
          sort: { column: 'created_at', direction: 'asc' },
        },
        { audit: false },
      );

      items.push(...result.data);
      if (!result.hasMore || result.data.length === 0) break;
    }
    items.length = Math.min(items.length, EXPORT_MAX_ROWS);

    const withGit = await this.hasGitIntegration(organizationId);
    const pullRequests = withGit
      ? await this.fetchExportPullRequests(
          organizationId,
          items.filter((i) => i.entity_type === 'task').map((i) => i.id),
        )
      : new Map<string, string[]>();

    // One batched lookup. An added last column, so existing readers of the file keep working.
    const labels =
      (await this.origins?.labels(organizationId, items.map((item) => item.id)).catch(() => null)) ?? new Map();

    const headers = [
      'Type',
      'Key',
      'Title',
      'Status',
      'Priority',
      'Assigned To',
      'Space',
      'Created',
      'Updated',
      ...(withGit ? ['Pull requests', 'Build status'] : []),
      'AI label',
    ];

    const rows = items.map((item) => {
      const assignee = item.assigned_to as {
        first_name?: string | null;
        last_name?: string | null;
        email?: string | null;
      } | null;
      const isTask = item.entity_type === 'task';

      return [
        item.entity_type,
        item.key || '',
        item.title,
        item.status || '',
        item.priority || '',
        assignee && typeof assignee === 'object'
          ? [assignee.first_name, assignee.last_name]
              .filter(Boolean)
              .join(' ') ||
            assignee.email ||
            ''
          : assignee || '',
        item.space_name || '',
        item.created_at || '',
        item.updated_at || '',
        ...(withGit
          ? [
              isTask ? (pullRequests.get(item.id) ?? []).join('\n') : '',
              isTask ? ((item._entity?.git_build_state as string) ?? '') : '',
            ]
          : []),
        robertLabel(labels.get(item.id)),
      ];
    });

    const csvRows = [headers, ...rows].map((row) =>
      row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','),
    );

    await this.requireAudit(
      organizationId,
      userId,
      'saved_filter',
      filterId,
      'export',
      {
        scope: 'csv',
        row_count: items.length,
      },
    );

    return csvRows.join('\n');
  }

  /**
   * Every row of the filter state the user had on screen when exporting, or a clear error when
   * there are more than `maxRows`: a short file that looks complete is worse than no file.
   */
  async collectFilterExportItems(
    filterId: string,
    dto: ExecuteFilterDto,
    organizationId: string,
    userId: string,
    maxRows: number,
    signal: AbortSignal,
  ): Promise<{
    items: IFilterResultItem[];
    withGit: boolean;
    pullRequests: Map<string, string[]>;
  }> {
    await this.assertCanViewFilter(filterId, organizationId, userId);

    const run = async (page: number, pageSize: number) =>
      (
        await this.executeAdHoc(
          {
            ...dto,
            page,
            pageSize,
            // Pages need a stable order; created_at is what CSV has always used.
            sort: dto.sort ?? { column: 'created_at', direction: 'asc' },
          },
          organizationId,
          userId,
        )
      ).data;

    const { total } = await run(1, 1);

    if (total > maxRows) {
      throw new UnprocessableEntityException({
        code: 'FILTER_EXPORT_TOO_MANY_ROWS',
        message: `This filter has ${total} results, above the export limit of ${maxRows}. Refine the filter and try again.`,
      });
    }

    const byId = new Map<string, IFilterResultItem>();

    if (total > 0) {
      // `total` is only an upper bound: the wiki ACL post-filter drops restricted pages after
      // counting, so it can never be reached. Read until the engine reports no more rows instead.
      //
      // The first call asks for everything: across several entity types the engine merges in
      // memory and returns it all at once. A single entity type is capped by PostgREST, so later
      // pages continue on that capped grid (the first window was exactly one such page).
      const pageSize = Math.min(total, POSTGREST_MAX_ROWS);
      const maxPages = Math.ceil((maxRows + 1) / pageSize) + 1;
      let hasMore = true;

      for (let page = 1; hasMore && page <= maxPages; page++) {
        signal.throwIfAborted();
        const result = await run(page, page === 1 ? total : pageSize);
        for (const item of result.data)
          byId.set(`${item.entity_type}:${item.id}`, item);
        hasMore = result.hasMore;
      }

      if (hasMore) {
        throw new ConflictException({
          code: 'FILTER_EXPORT_INCOMPLETE',
          message: `Export read only ${byId.size} of ${total} results because they changed meanwhile. Please try again.`,
        });
      }
    }

    const items = [...byId.values()].slice(0, maxRows);
    const withGit = await this.hasGitIntegration(organizationId);
    const pullRequests = withGit
      ? await this.fetchExportPullRequests(
          organizationId,
          items.filter((i) => i.entity_type === 'task').map((i) => i.id),
        )
      : new Map<string, string[]>();

    return { items, withGit, pullRequests };
  }

  async auditFilterExport(
    filterId: string,
    organizationId: string,
    userId: string,
    format: string,
    rowCount: number,
  ): Promise<void> {
    await this.requireAudit(
      organizationId,
      userId,
      'saved_filter',
      filterId,
      'export',
      { scope: format, row_count: rowCount },
    );
  }

  /**
   * Linked pull requests per task as `URL (state)` lines, oldest first; org-scoped, batched. Tasks of
   * spaces with the Development module off get none, and only repositories assigned to the task's space count.
   */
  private async fetchExportPullRequests(
    organizationId: string,
    allTaskIds: string[],
  ): Promise<Map<string, string[]>> {
    const byTask = new Map<string, string[]>();
    const taskIds = [
      ...(await developmentTaskIds(this.client, organizationId, allTaskIds)),
    ];

    for (let i = 0; i < taskIds.length; i += 200) {
      const { data, error } = await this.client
        .from('git_pull_request_tasks')
        .select(
          'task_id, task:tasks!git_pull_request_tasks_task_id_fkey!inner(space_id), ' +
            'pull_request:git_pull_requests!git_pull_request_tasks_pull_request_fkey!inner(repository_id, url, state, number, opened_at)',
        )
        .eq('organization_id', organizationId)
        .eq('state', 'linked')
        .in('task_id', taskIds.slice(i, i + 200));

      if (error) throw new BadRequestException(error.message);

      const rows = (data ?? []) as unknown as {
        task_id: string;
        task: { space_id: string | null };
        pull_request: {
          repository_id: string;
          url: string;
          state: string;
          opened_at: string | null;
        };
      }[];
      const assigned = await spaceRepositoryIds(
        this.client,
        rows.flatMap((row) => (row.task.space_id ? [row.task.space_id] : [])),
      );
      const links = rows.filter((row) =>
        assigned
          .get(row.task.space_id ?? '')
          ?.has(row.pull_request.repository_id),
      );
      links.sort((a, b) =>
        (a.pull_request.opened_at ?? '').localeCompare(
          b.pull_request.opened_at ?? '',
        ),
      );
      for (const { task_id, pull_request: pr } of links) {
        byTask.set(task_id, [
          ...(byTask.get(task_id) ?? []),
          `${pr.url} (${pr.state})`,
        ]);
      }
    }

    return byTask;
  }

  // ── Filterable Fields ─────────────────────────────────────────────────────

  async getFilterableFields(
    organizationId: string,
    userId: string,
    entityTypes: string[],
    spaceIds?: string[],
  ): Promise<{ data: IFilterFieldDefinition[] }> {
    const fields: IFilterFieldDefinition[] = [];
    const normalizedEntityTypes = this.normalizeEntityTypes(
      'spaces',
      entityTypes,
    );
    const permittedSpaceIdsByEntity = await this.getPermittedSpaceIdsByEntity(
      userId,
      organizationId,
      normalizedEntityTypes,
      spaceIds ?? [],
    );
    const scopedSpaceIds = this.flattenPermittedSpaceIds(
      permittedSpaceIdsByEntity,
    );

    const standardFields = await this.getStandardFields(
      organizationId,
      entityTypes,
      scopedSpaceIds,
    );
    fields.push(...standardFields);

    let customFieldQuery = this.client
      .from('custom_fields')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('is_active', true);

    if (scopedSpaceIds.length > 0) {
      customFieldQuery = customFieldQuery.or(
        `space_id.is.null,space_id.in.(${scopedSpaceIds.join(',')})`,
      );
    } else {
      customFieldQuery = customFieldQuery.is('space_id', null);
    }

    const { data: customFields, error } = await customFieldQuery;
    if (error) throw new BadRequestException(error.message);

    if (customFields) {
      for (const cf of customFields as Record<string, unknown>[]) {
        const fieldDef = this.mapCustomFieldToDefinition(cf, entityTypes);
        if (fieldDef) fields.push(fieldDef);
      }
    }

    return { data: fields };
  }

  private async getStandardFields(
    organizationId: string,
    entityTypes: string[],
    spaceIds?: string[],
  ): Promise<IFilterFieldDefinition[]> {
    const textOperators = [
      { name: 'eq', label: 'equals' },
      { name: 'neq', label: 'not equals' },
      { name: 'contains', label: 'contains' },
      { name: 'notContains', label: 'does not contain' },
      { name: 'beginsWith', label: 'starts with' },
      { name: 'endsWith', label: 'ends with' },
      { name: 'null', label: 'is empty' },
      { name: 'notNull', label: 'is not empty' },
    ];

    const selectOperators = [
      { name: 'eq', label: 'equals' },
      { name: 'neq', label: 'not equals' },
      { name: 'in', label: 'is one of' },
      { name: 'notIn', label: 'is not one of' },
      { name: 'null', label: 'is empty' },
      { name: 'notNull', label: 'is not empty' },
    ];

    const dateOperators = [
      { name: 'eq', label: 'equals' },
      { name: 'gt', label: 'after' },
      { name: 'lt', label: 'before' },
      { name: 'between', label: 'between' },
      { name: 'relative', label: 'relative' },
      { name: 'null', label: 'is empty' },
      { name: 'notNull', label: 'is not empty' },
    ];

    const userOperators = [
      { name: 'eq', label: 'is' },
      { name: 'neq', label: 'is not' },
      { name: 'in', label: 'is one of' },
      { name: 'notIn', label: 'is not one of' },
      { name: 'currentUser', label: 'is current user' },
      { name: 'null', label: 'is unassigned' },
      { name: 'notNull', label: 'is assigned' },
    ];

    const parentOperators = [
      { name: 'eq', label: 'equals' },
      { name: 'in', label: 'is one of' },
      { name: 'null', label: 'has no parent' },
      { name: 'notNull', label: 'has any parent' },
    ];

    const [
      statusValues,
      priorityValues,
      userValues,
      requestTypeValues,
      taskTypeValues,
    ] = await Promise.all([
      this.fetchStatusValues(organizationId, entityTypes, spaceIds),
      this.fetchPriorityValues(organizationId, entityTypes, spaceIds),
      this.fetchUserValues(organizationId, spaceIds),
      this.fetchRequestTypeValues(organizationId, entityTypes, spaceIds),
      this.fetchTaskTypeValues(organizationId, entityTypes),
    ]);

    const fields: IFilterFieldDefinition[] = [];

    fields.push({
      name: 'title',
      label: 'Title',
      inputType: 'text',
      operators: textOperators,
      entityTypes: ['processes', 'tasks', 'lists', 'wiki'],
    });

    fields.push({
      name: 'status',
      label: 'Status',
      inputType: 'select',
      operators: selectOperators,
      entityTypes: ['processes', 'tasks'],
      values: statusValues,
    });

    if (entityTypes.includes('wiki') || entityTypes.includes('wiki_page')) {
      fields.push({
        name: 'workflow_status',
        label: 'Workflow Status',
        inputType: 'select',
        operators: selectOperators,
        entityTypes: ['wiki'],

        // Fixed set enforced by the wiki_pages.workflow_status DB CHECK.
        values: [
          { name: 'draft', label: 'Draft' },
          { name: 'in_review', label: 'In Review' },
          { name: 'published', label: 'Published' },
        ],
      });
    }

    if (entityTypes.includes('tasks') || entityTypes.length === 0) {
      fields.push({
        name: 'priority',
        label: 'Priority',
        inputType: 'select',
        operators: selectOperators,
        entityTypes: ['tasks'],
        values: priorityValues,
      });
    }

    fields.push({
      name: 'key',
      label: 'Key',
      inputType: 'text',
      operators: textOperators,
      entityTypes: ['processes', 'tasks'],
    });

    if (entityTypes.includes('tasks') || entityTypes.length === 0) {
      fields.push({
        name: 'assigned_to',
        label: 'Assigned To',
        inputType: 'select',
        operators: userOperators,
        entityTypes: ['tasks'],
        values: userValues,
      });
    }

    if (entityTypes.includes('tasks') || entityTypes.length === 0) {
      fields.push({
        name: 'reporter',
        label: 'Reporter',
        inputType: 'select',
        operators: userOperators,
        entityTypes: ['tasks'],
        values: userValues,
      });
    }

    fields.push({
      name: 'created_by',
      label: 'Created By',
      inputType: 'select',
      operators: userOperators,
      entityTypes: ['processes', 'tasks', 'lists', 'wiki'],
      values: userValues,
    });

    if (entityTypes.includes('processes') || entityTypes.length === 0) {
      fields.push({
        name: 'request_type',
        label: 'Request Type',
        inputType: 'select',
        operators: selectOperators,
        entityTypes: ['processes'],
        values: requestTypeValues,
      });
    }

    if (entityTypes.includes('tasks') || entityTypes.length === 0) {
      fields.push({
        name: 'task_type_id',
        label: 'Task Type',
        inputType: 'select',
        operators: selectOperators,
        entityTypes: ['tasks'],
        values: taskTypeValues,
      });
    }

    if (
      entityTypes.includes('tasks') ||
      entityTypes.includes('processes') ||
      entityTypes.length === 0
    ) {
      fields.push({
        name: 'parent',
        label: 'Parent',
        inputType: 'entity-key',
        operators: parentOperators,
        entityTypes: ['tasks', 'processes'],
      });
    }

    if (entityTypes.includes('tasks') || entityTypes.length === 0) {
      fields.push({
        name: 'linked_to',
        label: 'Linked to',
        inputType: 'entity-key',
        operators: [
          { name: 'in', label: 'is linked to any of' },
          { name: 'notIn', label: 'is not linked to any of' },
        ],
        entityTypes: ['tasks'],
      });
    }

    // Ticket 10: virtual field over the git computed fields; values are DEV_FILTERS. Offered with the Git
    // integration licence only; a rule already saved keeps evaluating (it only reads data).
    if (
      (entityTypes.includes('tasks') || entityTypes.length === 0) &&
      (await this.hasGitIntegration(organizationId))
    ) {
      fields.push({
        name: 'development',
        label: 'Development',
        inputType: 'select',
        operators: selectOperators.filter(
          (op) => op.name !== 'null' && op.name !== 'notNull',
        ),
        entityTypes: ['tasks'],
        values: DEV_FILTERS.map((name) => ({
          name,
          label: DEV_FILTER_LABELS[name],
        })),
      });
    }

    if (entityTypes.includes('tasks') || entityTypes.length === 0) {
      fields.push({
        name: 'due_date',
        label: 'Due Date',
        inputType: 'date',
        operators: dateOperators,
        entityTypes: ['tasks'],
      });
    }

    if (entityTypes.includes('tasks') || entityTypes.length === 0) {
      fields.push({
        name: 'start_date',
        label: 'Start Date',
        inputType: 'date',
        operators: dateOperators,
        entityTypes: ['tasks'],
      });
    }

    fields.push({
      name: 'created_at',
      label: 'Created Date',
      inputType: 'date',
      operators: dateOperators,
      entityTypes: ['processes', 'tasks', 'lists', 'wiki'],
    });

    fields.push({
      name: 'updated_at',
      label: 'Updated Date',
      inputType: 'date',
      operators: dateOperators,
      entityTypes: ['processes', 'tasks', 'lists', 'wiki'],
    });

    return fields;
  }

  private async fetchStatusValues(
    organizationId: string,
    entityTypes: string[],
    spaceIds?: string[],
  ): Promise<{ name: string; label: string }[] | undefined> {
    try {
      const values: { name: string; label: string }[] = [];

      if (entityTypes.includes('processes') || entityTypes.length === 0) {
        values.push(
          { name: 'active', label: 'Active' },
          { name: 'inactive', label: 'Inactive' },
          { name: 'archived', label: 'Archived' },
          { name: 'draft', label: 'Draft' },
        );
      }

      if (entityTypes.includes('tasks') || entityTypes.length === 0) {
        let query = this.client
          .from('task_statuses')
          .select('key, name, sort_order')
          .eq('organization_id', organizationId)
          .eq('is_active', true);

        if (spaceIds?.length) {
          query = query.or(
            `space_id.is.null,space_id.in.(${spaceIds.join(',')})`,
          );
        } else {
          query = query.is('space_id', null);
        }

        const { data: statuses } = await query.order('sort_order');

        if (statuses?.length) {
          const seen = new Set(values.map((v) => v.name));
          for (const s of statuses as { key: string; name: string }[]) {
            if (!seen.has(s.key)) {
              seen.add(s.key);
              values.push({ name: s.key, label: s.name });
            }
          }
        }
      }

      return values.length > 0 ? values : undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchPriorityValues(
    organizationId: string,
    entityTypes: string[],
    spaceIds?: string[],
  ): Promise<{ name: string; label: string }[] | undefined> {
    try {
      if (!entityTypes.includes('tasks') && entityTypes.length > 0)
        return undefined;

      let query = this.client
        .from('task_priorities')
        .select('key, name, sort_order')
        .eq('organization_id', organizationId)
        .eq('is_active', true);

      if (spaceIds?.length) {
        query = query.or(
          `space_id.is.null,space_id.in.(${spaceIds.join(',')})`,
        );
      } else {
        query = query.is('space_id', null);
      }

      const { data: priorities } = await query.order('sort_order');

      if (priorities?.length) {
        const seen = new Set<string>();
        const values: { name: string; label: string }[] = [];
        for (const p of priorities as { key: string; name: string }[]) {
          if (!seen.has(p.key)) {
            seen.add(p.key);
            values.push({ name: p.key, label: p.name });
          }
        }
        return values.length > 0 ? values : undefined;
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchUserValues(
    organizationId: string,
    spaceIds?: string[],
  ): Promise<{ name: string; label: string }[] | undefined> {
    try {
      if (spaceIds !== undefined) {
        if (spaceIds.length === 0) return undefined;

        const { data: memberRows } = await this.client
          .from('space_members')
          .select('user_id')
          .in('space_id', spaceIds)
          .eq('is_active', true);

        if (memberRows?.length) {
          const userIds = [
            ...new Set(
              (memberRows as { user_id: string }[]).map((m) => m.user_id),
            ),
          ];
          const { data: users } = await this.client
            .from('users')
            .select('id, first_name, last_name, email')
            .in('id', userIds)
            .order('first_name');

          if (users?.length) {
            return (
              users as {
                id: string;
                first_name: string | null;
                last_name: string | null;
                email: string;
              }[]
            ).map((u) => ({
              name: u.id,
              label:
                [u.first_name, u.last_name].filter(Boolean).join(' ') ||
                u.email,
            }));
          }
        }
      } else {
        // users.organization_id is gone — join via organization_members.
        const { data: memberRows } = await this.client
          .from('organization_members')
          .select(
            'user_id, users:users!inner(id, first_name, last_name, email)',
          )
          .eq('organization_id', organizationId);

        const users = (
          (memberRows ?? []) as Array<{
            users:
              | {
                  id: string;
                  first_name: string | null;
                  last_name: string | null;
                  email: string;
                }
              | Array<{
                  id: string;
                  first_name: string | null;
                  last_name: string | null;
                  email: string;
                }>;
          }>
        )
          .flatMap((row) =>
            Array.isArray(row.users) ? row.users : row.users ? [row.users] : [],
          )
          .sort((a, b) =>
            (a.first_name ?? '').localeCompare(b.first_name ?? ''),
          );

        if (users?.length) {
          return (
            users as {
              id: string;
              first_name: string | null;
              last_name: string | null;
              email: string;
            }[]
          ).map((u) => ({
            name: u.id,
            label:
              [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
          }));
        }
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchRequestTypeValues(
    organizationId: string,
    entityTypes: string[],
    spaceIds?: string[],
  ): Promise<{ name: string; label: string }[] | undefined> {
    try {
      if (!entityTypes.includes('processes') && entityTypes.length > 0)
        return undefined;

      if (spaceIds !== undefined && spaceIds.length === 0) return undefined;

      let query = this.client
        .from('business_processes')
        .select('request_type')
        .eq('organization_id', organizationId)
        .not('request_type', 'is', null);

      if (spaceIds?.length) {
        query = query.in('space_id', spaceIds);
      }

      const { data: rows } = await query;

      if (rows?.length) {
        const seen = new Set<string>();
        const values: { name: string; label: string }[] = [];
        for (const row of rows as { request_type: string }[]) {
          if (row.request_type && !seen.has(row.request_type)) {
            seen.add(row.request_type);
            values.push({ name: row.request_type, label: row.request_type });
          }
        }
        values.sort((a, b) => a.label.localeCompare(b.label));
        return values.length > 0 ? values : undefined;
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchTaskTypeValues(
    organizationId: string,
    entityTypes: string[],
  ): Promise<{ name: string; label: string }[] | undefined> {
    try {
      if (!entityTypes.includes('tasks') && entityTypes.length > 0)
        return undefined;

      const { data: configs } = await this.client
        .from('task_hierarchy_configurations')
        .select('config')
        .eq('organization_id', organizationId);

      const seen = new Set<string>();
      const values: { name: string; label: string }[] = [];

      for (const row of (configs || []) as { config: unknown }[]) {
        const levels = (row.config as Record<string, unknown>)?.['levels'];
        if (!Array.isArray(levels)) continue;
        for (const level of levels as { id?: string; name?: string }[]) {
          if (level.id && !seen.has(level.id)) {
            seen.add(level.id);
            values.push({ name: level.id, label: level.name || level.id });
          }
        }
      }

      values.sort((a, b) => a.label.localeCompare(b.label));
      return values.length > 0 ? values : undefined;
    } catch {
      return undefined;
    }
  }

  private mapCustomFieldToDefinition(
    cf: Record<string, unknown>,
    entityTypes: string[],
  ): IFilterFieldDefinition | null {
    const textOperators = [
      { name: 'eq', label: 'equals' },
      { name: 'neq', label: 'not equals' },
      { name: 'contains', label: 'contains' },
      { name: 'null', label: 'is empty' },
      { name: 'notNull', label: 'is not empty' },
    ];
    const numberOperators = [
      { name: 'eq', label: 'equals' },
      { name: 'neq', label: 'not equals' },
      { name: 'gt', label: 'greater than' },
      { name: 'lt', label: 'less than' },
      { name: 'between', label: 'between' },
      { name: 'null', label: 'is empty' },
      { name: 'notNull', label: 'is not empty' },
    ];
    const selectOperators = [
      { name: 'eq', label: 'equals' },
      { name: 'neq', label: 'not equals' },
      { name: 'in', label: 'is one of' },
      { name: 'notIn', label: 'is not one of' },
      { name: 'null', label: 'is empty' },
      { name: 'notNull', label: 'is not empty' },
    ];
    const dateOperators = [
      { name: 'eq', label: 'equals' },
      { name: 'gt', label: 'after' },
      { name: 'lt', label: 'before' },
      { name: 'between', label: 'between' },
      { name: 'relative', label: 'relative' },
      { name: 'null', label: 'is empty' },
      { name: 'notNull', label: 'is not empty' },
    ];
    const boolOperators = [{ name: 'eq', label: 'equals' }];

    let operators: { name: string; label: string }[];
    let inputType: string;
    let values: { name: string; label: string }[] | undefined;

    switch (cf['field_type'] as string) {
      case 'string':
      case 'editor':
      case 'url':
        operators = textOperators;
        inputType = 'text';
        break;
      case 'number':
        operators = numberOperators;
        inputType = 'number';
        break;
      case 'select':
      case 'radio':
        operators = selectOperators;
        inputType = 'select';
        values = (
          cf['options'] as { value: string; label: string }[] | undefined
        )?.map((o) => ({ name: o.value, label: o.label }));
        break;
      case 'multiselect':
      case 'issue_group':
        operators = selectOperators;
        inputType = 'multiselect';
        values = (
          cf['options'] as { value: string; label: string }[] | undefined
        )?.map((o) => ({ name: o.value, label: o.label }));
        break;
      case 'user_select':
      case 'user_multi':
        operators = [
          { name: 'eq', label: 'is' },
          { name: 'neq', label: 'is not' },
          { name: 'currentUser', label: 'is current user' },
          { name: 'null', label: 'is empty' },
          { name: 'notNull', label: 'is not empty' },
        ];
        inputType = 'text';
        break;
      case 'checkbox':
        operators = boolOperators;
        inputType = 'checkbox';
        values = [
          { name: 'true', label: 'Yes' },
          { name: 'false', label: 'No' },
        ];
        break;
      case 'date':
      case 'datetime':
        operators = dateOperators;
        inputType = 'date';
        break;
      case 'time':
        operators = textOperators;
        inputType = 'text';
        break;
      default:
        operators = [
          { name: 'eq', label: 'equals' },
          { name: 'neq', label: 'not equals' },
          { name: 'null', label: 'is empty' },
          { name: 'notNull', label: 'is not empty' },
        ];
        inputType = 'text';
    }

    const contexts = (cf['contexts'] as string[] | undefined) || [
      'process',
      'task',
    ];
    const applicableEntityTypes: string[] = [];
    if (contexts.includes('process')) applicableEntityTypes.push('processes');
    if (contexts.includes('task')) applicableEntityTypes.push('tasks');
    if (contexts.includes('list') || contexts.includes('list_item'))
      applicableEntityTypes.push('lists');
    if (contexts.includes('wiki')) applicableEntityTypes.push('wiki');

    if (
      entityTypes.length > 0 &&
      !entityTypes.some((et) => applicableEntityTypes.includes(et))
    ) {
      return null;
    }

    return {
      name: `cf_${cf['field_key'] as string}`,
      label: cf['name'] as string,
      inputType,
      operators,
      values,
      entityTypes: applicableEntityTypes,
      isCustomField: true,
      customFieldType: cf['field_type'] as string,
    };
  }

  // ── Parent options typeahead ──────────────────────────────────────────────

  /**
   * Returns up to `limit` tasks + processes matching `search` within the org,
   * optionally scoped to `spaceIds`. Mirrors the Next.js /api/filters/parent-options
   * route logic using the admin client (RLS not required — org-scoped WHERE clause).
   */
  async getParentOptions(
    organizationId: string,
    userId: string,
    search: string,
    entityTypes: string[],
    spaceIds: string[],
    limit: number,
  ): Promise<{ data: ParentOptionRow[] }> {
    const escaped = search
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    const ilikeValue = `%${escaped}%`;
    const normalizedEntityTypes = this.normalizeEntityTypes(
      'spaces',
      entityTypes,
    );
    const permittedSpaceIdsByEntity = await this.getPermittedSpaceIdsByEntity(
      userId,
      organizationId,
      normalizedEntityTypes,
      spaceIds,
    );

    const queries: Promise<ParentOptionRow[]>[] = [];

    if (entityTypes.includes('tasks')) {
      const permittedTaskSpaceIds = permittedSpaceIdsByEntity.tasks ?? [];
      if (permittedTaskSpaceIds.length > 0) {
        for (const col of ['key', 'summary'] as const) {
          queries.push(
            (async (): Promise<ParentOptionRow[]> => {
              let q = this.client
                .from('tasks')
                .select('id, key, summary, space_id')
                .eq('organization_id', organizationId)
                .not('key', 'is', null)
                .ilike(col, ilikeValue)
                .order('key', { ascending: true })
                .limit(limit);

              q = q.in('space_id', permittedTaskSpaceIds);

              const { data, error } = await q;

              if (error) return [];

              return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
                entity_type: 'tasks' as const,
                id: String(row['id']),
                key: String(row['key']),
                title: (row['summary'] as string) ?? '',
                space_id: (row['space_id'] as string | null) ?? null,
              }));
            })(),
          );
        }
      }
    }

    if (entityTypes.includes('processes')) {
      const permittedProcessSpaceIds =
        permittedSpaceIdsByEntity.processes ?? [];
      if (permittedProcessSpaceIds.length > 0) {
        for (const col of ['key', 'title'] as const) {
          queries.push(
            (async (): Promise<ParentOptionRow[]> => {
              let q = this.client
                .from('business_processes')
                .select('id, key, title, space_id')
                .eq('organization_id', organizationId)
                .not('key', 'is', null)
                .ilike(col, ilikeValue)
                .order('key', { ascending: true })
                .limit(limit);

              q = q.in('space_id', permittedProcessSpaceIds);

              const { data, error } = await q;

              if (error) return [];

              return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
                entity_type: 'processes' as const,
                id: String(row['id']),
                key: String(row['key']),
                title: (row['title'] as string) ?? '',
                space_id: (row['space_id'] as string | null) ?? null,
              }));
            })(),
          );
        }
      }
    }

    const results = await Promise.all(queries);

    const seen = new Set<string>();
    const merged: ParentOptionRow[] = [];

    for (const batch of results) {
      for (const row of batch) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        merged.push(row);
      }
    }

    const needle = search.toLowerCase();

    merged.sort((a, b) => {
      const aPrefix = a.key.toLowerCase().startsWith(needle) ? 0 : 1;
      const bPrefix = b.key.toLowerCase().startsWith(needle) ? 0 : 1;

      if (aPrefix !== bPrefix) return aPrefix - bPrefix;

      return a.key.localeCompare(b.key);
    });

    const page = merged.slice(0, limit);

    // Space keys for the org-wide relationship picker's cross-space chip. A
    // failed lookup leaves the keys null; the options themselves still stand.
    const pageSpaceIds = [
      ...new Set(
        page.map((row) => row.space_id).filter((id): id is string => !!id),
      ),
    ];
    const keyById = new Map<string, string>();
    if (pageSpaceIds.length > 0) {
      const { data: spaces, error } = await this.client
        .from('spaces')
        .select('id, key')
        .in('id', pageSpaceIds)
        .eq('organization_id', organizationId);
      if (error) {
        this.logger.warn(
          `getParentOptions: space key lookup failed: ${error.message}`,
        );
      }
      for (const space of (spaces ?? []) as { id: string; key: string }[]) {
        keyById.set(space.id, space.key);
      }
    }

    return {
      data: page.map((row) => ({
        ...row,
        space_key: (row.space_id && keyById.get(row.space_id)) || null,
      })),
    };
  }

  private async buildFieldTypeMap(
    organizationId: string,
  ): Promise<Record<string, string>> {
    try {
      const { data: fields } = await this.client
        .from('custom_fields')
        .select('field_key, field_type')
        .eq('organization_id', organizationId)
        .eq('is_active', true);

      if (!fields) return {};

      const map: Record<string, string> = {};
      for (const f of fields as { field_key: string; field_type: string }[]) {
        map[`cf_${f.field_key}`] = f.field_type;
      }
      return map;
    } catch {
      return {};
    }
  }
}
