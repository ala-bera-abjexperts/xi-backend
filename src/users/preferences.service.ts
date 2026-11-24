/**
 * @fileoverview Service for managing user preferences including recent items,
 * sidebar configuration, and starred spaces. All data is stored in Supabase
 * tables: `user_recent_items`, `user_sidebar_preferences`, and `starred_spaces`.
 * @module src/users/preferences.service
 * @author Prince Jadiya
 */

import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PermissionsService } from '../permissions/permissions.service';
import { spaceGrantAllows } from '../permissions/models/space-permissions.model';
import type { TrackRecentItemDto } from './dto/track-recent-item.dto';
import type { UpdateSidebarPreferencesDto } from './dto/update-sidebar-preferences.dto';
import type { SaveColumnPreferencesDto } from './dto/save-column-preferences.dto';
import {
  TASK_COMMENT_SORTS,
  type SaveTaskCommentPreferencesDto,
  type TaskCommentSort,
  type TaskCommentTieSort,
} from './dto/save-task-comment-preferences.dto';
import { getDefaultColumns } from './column-preferences.constants';
import { normalizeTieSorts } from '../tasks/task-comment-sort';

/** Row key in user_column_preferences holding the task comment sort order */
const TASK_COMMENTS_VIEW_ID = 'task_comments';

/** Default sidebar configuration returned when no preferences exist for the user */
const DEFAULT_SIDEBAR_CONFIG = {
  sections: [
    { id: 'for_you', visible: true, order: 0 },
    { id: 'recent', visible: true, order: 1 },
    { id: 'starred', visible: true, order: 2 },
    { id: 'apps', visible: false, order: 3 },
    { id: 'plans', visible: false, order: 4 },
    { id: 'spaces', visible: true, order: 5 },
    { id: 'filters', visible: true, order: 6 },
    { id: 'dashboards', visible: true, order: 7 },
    { id: 'site_studio', visible: true, order: 8 },
    { id: 'portfolios', visible: true, order: 9 },
    { id: 'test_management', visible: true, order: 9 },
    { id: 'operations', visible: false, order: 10 },
    { id: 'external_links', visible: false, order: 11 },
    { id: 'settings', visible: true, order: 12 },
  ],
  externalLinks: [] as unknown[],
  spacesExpanded: true,
  recentItemsCount: 10,
};

const TIME_GROUP_LABELS: Record<string, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  older: 'More than a month ago',
};

/**
 * Service for user preferences management.
 *
 * Handles CRUD operations for:
 * - Recent items tracking (`user_recent_items` table)
 * - Sidebar layout preferences (`user_sidebar_preferences` table)
 * - Starred spaces (`starred_spaces` table)
 *
 * @example
 * constructor(private readonly preferencesService: PreferencesService) {}
 *
 * const items = await this.preferencesService.getRecentItems('user-id');
 */
@Injectable()
export class PreferencesService {
  /** @private Logger instance scoped to this service */
  private readonly logger = new Logger(PreferencesService.name);

  /**
   * @param {SupabaseAdminService} supabaseAdmin - Admin Supabase client for database queries
   */
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
    // Optional so the 2-arg test construction still works; access checks are skipped then.
    @Optional() private readonly permissionsService?: PermissionsService,
  ) {}

  // ── Recent Items ─────────────────────────────────────────────────────────

  /**
   * Retrieves recently accessed items for a user within a specific organization,
   * ordered by most recent first and grouped by time period.
   *
   * @param {string} userId - The application-level user ID (UUID)
   * @param {string} organizationId - The organization ID to scope results to (UUID)
   * @param {number} [limit=10] - Maximum number of items to return
   * @param {string} [itemType] - Optional filter by item type (e.g., 'space', 'page')
   * @returns {Promise<Array<{ group: string; label: string; items: Record<string, unknown>[] }>>} Items grouped by time
   * @throws {InternalServerErrorException} When the database query fails
   * @author Prince Jadiya
   */
  async getRecentItems(
    userId: string,
    organizationId: string,
    limit = 10,
    itemType?: string,
  ): Promise<
    Array<{ group: string; label: string; items: Record<string, unknown>[] }>
  > {
    const client = this.supabaseAdmin.getClient();

    let query = client
      .from('user_recent_items')
      .select('*')
      .eq('user_id', userId)
      .eq('organization_id', organizationId);

    if (itemType) {
      query = query.eq('item_type', itemType);
    }
    // Hide spaces the user can no longer open, in the query so `limit` stays exact.
    if (this.permissionsService) {
      const ids = await this.permissionsService.getViewableSpaceIds(
        userId,
        organizationId,
      );
      if (ids !== null) {
        if (itemType === 'space') {
          if (ids.length === 0) return [];
          query = query.in('item_id', ids);
        } else if (ids.length === 0) {
          query = query.neq('item_type', 'space');
        } else {
          query = query.or(`item_type.neq.space,item_id.in.(${ids.join(',')})`);
        }
      }
    }

    const result = await query
      .order('accessed_at', { ascending: false })
      .limit(limit);

    if (result.error) {
      this.logger.error(`Failed to get recent items: ${result.error.message}`);
      throw new InternalServerErrorException('Failed to get recent items');
    }

    const items = (result.data ?? []) as Record<string, unknown>[];

    return this.groupRecentItemsByTime(items);
  }

  /**
   * Tracks access to an item by upserting a record in `user_recent_items`.
   * If the user has already accessed this item (same item_type + item_id),
   * the `accessed_at` timestamp and other fields are updated. Otherwise a
   * new record is inserted.
   *
   * @param {string} userId - The application-level user ID (UUID)
   * @param {string} organizationId - The user's organization ID (UUID)
   * @param {TrackRecentItemDto} data - Item details to track
   * @returns {Promise<Record<string, unknown>>} The upserted recent item record
   * @throws {InternalServerErrorException} When the database operation fails
   * @author Prince Jadiya
   */
  async trackAccess(
    userId: string,
    organizationId: string,
    data: TrackRecentItemDto,
  ): Promise<Record<string, unknown> | null> {
    const client = this.supabaseAdmin.getClient();

    // A space the user cannot open is not remembered.
    if (
      data.item_type === 'space' &&
      !(await this.canViewSpace(userId, organizationId, data.item_id))
    ) {
      return null;
    }

    // Check if an entry already exists for this user + org + item_type + item_id
    const findResult = await client
      .from('user_recent_items')
      .select('id')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .eq('item_type', data.item_type)
      .eq('item_id', data.item_id)
      .maybeSingle();

    if (findResult.error) {
      this.logger.error(
        `Failed to check existing recent item: ${findResult.error.message}`,
      );
      throw new InternalServerErrorException('Failed to track item access');
    }

    if (findResult.data) {
      // Update the existing record
      const updateResult = await client
        .from('user_recent_items')
        .update({
          item_name: data.item_name,
          item_key: data.item_key ?? null,
          item_icon: data.item_icon ?? null,
          item_metadata: data.item_metadata ?? {},
          accessed_at: new Date().toISOString(),
        })
        .eq('id', (findResult.data as Record<string, unknown>).id)
        .eq('organization_id', organizationId)
        .select('*')
        .single();

      if (updateResult.error) {
        this.logger.error(
          `Failed to update recent item: ${updateResult.error.message}`,
        );
        throw new InternalServerErrorException('Failed to track item access');
      }

      void this.auditLogsService.logAction(
        organizationId,
        userId,
        'user_preference',
        userId,
        'update',
        {
          action: 'track_recent_item',
          item_type: data.item_type,
          item_id: data.item_id,
        },
      );

      return updateResult.data as Record<string, unknown>;
    }

    // Insert new record
    const insertResult = await client
      .from('user_recent_items')
      .insert({
        user_id: userId,
        organization_id: organizationId,
        item_type: data.item_type,
        item_id: data.item_id,
        item_name: data.item_name,
        item_key: data.item_key ?? null,
        item_icon: data.item_icon ?? null,
        item_metadata: data.item_metadata ?? {},
        accessed_at: new Date().toISOString(),
      })
      .select('*')
      .single();

    if (insertResult.error) {
      this.logger.error(
        `Failed to insert recent item: ${insertResult.error.message}`,
      );
      throw new InternalServerErrorException('Failed to track item access');
    }

    if (organizationId)
      void this.auditLogsService.logAction(
        organizationId,
        userId,
        'user_preference',
        userId,
        'create',
        {
          action: 'track_recent_item',
          item_type: data.item_type,
          item_id: data.item_id,
        },
      );

    return insertResult.data as Record<string, unknown>;
  }

  /**
   * Deletes all recent items for the given user.
   *
   * @param {string} userId - The application-level user ID (UUID)
   * @returns {Promise<{ deleted: boolean }>} Confirmation of the deletion
   * @throws {InternalServerErrorException} When the database operation fails
   * @author Prince Jadiya
   */
  async clearAllRecentItems(
    userId: string,
    organizationId?: string,
  ): Promise<{ success: boolean; message: string }> {
    const client = this.supabaseAdmin.getClient();

    let deleteQuery = client
      .from('user_recent_items')
      .delete()
      .eq('user_id', userId);

    if (organizationId) {
      deleteQuery = deleteQuery.eq('organization_id', organizationId);
    }

    const result = await deleteQuery;

    if (result.error) {
      this.logger.error(
        `Failed to clear recent items: ${result.error.message}`,
      );
      throw new InternalServerErrorException('Failed to clear recent items');
    }

    if (organizationId) {
      void this.auditLogsService.logAction(
        organizationId,
        userId,
        'user_preference',
        userId,
        'delete',
        { action: 'clear_recent_items' },
      );
    }

    return { success: true, message: 'Recent items cleared' };
  }

  /**
   * Deletes a specific recent item by item type and item ID.
   *
   * @param {string} userId - The application-level user ID (UUID)
   * @param {string} itemType - The item type (e.g., 'space', 'page')
   * @param {string} itemId - The UUID of the item
   * @returns {Promise<{ deleted: boolean }>} Confirmation of the deletion
   * @throws {InternalServerErrorException} When the database operation fails
   * @author Prince Jadiya
   */
  async deleteRecentItem(
    userId: string,
    organizationIdOrItemType: string,
    itemTypeOrItemId: string,
    itemIdMaybe?: string,
  ): Promise<{ success: true; message: string }> {
    const client = this.supabaseAdmin.getClient();
    const organizationId = itemIdMaybe ? organizationIdOrItemType : undefined;
    const itemType = itemIdMaybe ? itemTypeOrItemId : organizationIdOrItemType;
    const itemId = itemIdMaybe ?? itemTypeOrItemId;

    let deleteQuery = client
      .from('user_recent_items')
      .delete()
      .eq('user_id', userId);

    if (organizationId) {
      deleteQuery = deleteQuery.eq('organization_id', organizationId);
    }

    const result = await deleteQuery
      .eq('item_type', itemType)
      .eq('item_id', itemId);

    if (result.error) {
      this.logger.error(
        `Failed to delete recent item: ${result.error.message}`,
      );
      throw new InternalServerErrorException('Failed to delete recent item');
    }

    if (organizationId) {
      void this.auditLogsService.logAction(
        organizationId,
        userId,
        'user_preference',
        userId,
        'delete',
        { action: 'delete_recent_item', item_type: itemType, item_id: itemId },
      );
    }

    return { success: true, message: 'Recent item removed' };
  }

  // ── Sidebar Preferences ──────────────────────────────────────────────────

  /**
   * Retrieves the user's sidebar preferences. If no preferences exist,
   * returns sensible defaults.
   *
   * @param {string} userId - The application-level user ID (UUID)
   * @returns {Promise<Record<string, unknown>>} The sidebar config object
   * @throws {InternalServerErrorException} When the database query fails
   * @author Prince Jadiya
   */
  async getSidebarPreferences(
    userId: string,
    organizationId?: string,
  ): Promise<Record<string, unknown>> {
    const client = this.supabaseAdmin.getClient();

    let query = client
      .from('user_sidebar_preferences')
      .select('*')
      .eq('user_id', userId);

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const result = await query.maybeSingle();

    if (result.error) {
      this.logger.error(
        `Failed to get sidebar preferences: ${result.error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to get sidebar preferences',
      );
    }

    if (!result.data) {
      return organizationId
        ? this.upsertSidebarPreferences(
            userId,
            organizationId,
            DEFAULT_SIDEBAR_CONFIG,
          )
        : { config: DEFAULT_SIDEBAR_CONFIG };
    }

    // Merge any sections added to DEFAULT_SIDEBAR_CONFIG after the user's
    // preferences were saved (e.g. the 'portfolios' section). Missing sections
    // are inserted at their canonical default order so they slot between
    // existing neighbours rather than being appended at the end.
    const saved = result.data as Record<string, unknown>;
    const savedConfig = (saved.config ?? {}) as Record<string, unknown>;
    const savedSections = (savedConfig.sections ?? []) as Array<{
      id: string;
      visible: boolean;
      order: number;
    }>;
    const savedIds = new Set(savedSections.map((s) => s.id));
    const missingSections = DEFAULT_SIDEBAR_CONFIG.sections.filter(
      (s) => !savedIds.has(s.id),
    );

    if (missingSections.length > 0) {
      // Build a lookup of default order by section id.
      const defaultOrderMap = new Map(
        DEFAULT_SIDEBAR_CONFIG.sections.map((s) => [s.id, s.order]),
      );
      // Merge and re-sort by default order so position is canonical regardless
      // of when the section was first saved.
      const merged = [...savedSections, ...missingSections].sort((a, b) => {
        const oa = defaultOrderMap.get(a.id) ?? a.order;
        const ob = defaultOrderMap.get(b.id) ?? b.order;
        return oa - ob;
      });
      return { ...saved, config: { ...savedConfig, sections: merged } };
    }

    return saved;
  }

  /**
   * Updates or creates the user's sidebar preferences by merging the provided
   * fields into the existing JSONB config column.
   *
   * @param {string} userId - The application-level user ID (UUID)
   * @param {string} organizationId - The user's organization ID (UUID)
   * @param {UpdateSidebarPreferencesDto} data - Partial sidebar settings to merge
   * @returns {Promise<Record<string, unknown>>} The updated sidebar preferences record
   * @throws {InternalServerErrorException} When the database operation fails
   * @author Prince Jadiya
   */
  async updateSidebarPreferences(
    userId: string,
    organizationId: string,
    data: UpdateSidebarPreferencesDto,
  ): Promise<Record<string, unknown>> {
    const client = this.supabaseAdmin.getClient();

    // Check if preferences exist
    const findResult = await client
      .from('user_sidebar_preferences')
      .select('id, config')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (findResult.error) {
      this.logger.error(
        `Failed to find sidebar preferences: ${findResult.error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to update sidebar preferences',
      );
    }

    const existingConfig = findResult.data
      ? (findResult.data as Record<string, unknown>).config
      : DEFAULT_SIDEBAR_CONFIG;
    const mergedConfig = {
      ...(existingConfig as Record<string, unknown>),
      ...data,
    };

    if (findResult.data) {
      const updateResult = await client
        .from('user_sidebar_preferences')
        .update({
          config: mergedConfig,
          updated_at: new Date().toISOString(),
        })
        .eq('id', (findResult.data as Record<string, unknown>).id)
        .select('*')
        .single();

      if (updateResult.error) {
        this.logger.error(
          `Failed to update sidebar preferences: ${updateResult.error.message}`,
        );
        throw new InternalServerErrorException(
          'Failed to update sidebar preferences',
        );
      }

      void this.auditLogsService.logAction(
        organizationId,
        userId,
        'user_preference',
        userId,
        'update',
        { action: 'update_sidebar_preferences', keys: Object.keys(data) },
      );

      return updateResult.data as Record<string, unknown>;
    }

    // Insert new
    const insertResult = await client
      .from('user_sidebar_preferences')
      .insert({
        user_id: userId,
        organization_id: organizationId,
        config: mergedConfig,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('*')
      .single();

    if (insertResult.error) {
      this.logger.error(
        `Failed to insert sidebar preferences: ${insertResult.error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to update sidebar preferences',
      );
    }

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'user_preference',
      userId,
      'create',
      { action: 'update_sidebar_preferences', keys: Object.keys(data) },
    );

    return insertResult.data as Record<string, unknown>;
  }

  /**
   * Resets sidebar preferences to defaults by deleting the stored record.
   *
   * @param {string} userId - The user's application-level ID
   * @param {string} organizationId - The organization ID
   * @returns {Promise<Record<string, unknown>>} The default sidebar config
   * @author Prince Jadiya
   */
  async resetSidebarPreferences(
    userId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const reset = await this.upsertSidebarPreferences(
      userId,
      organizationId,
      DEFAULT_SIDEBAR_CONFIG,
    );

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'user_preference',
      userId,
      'update',
      { action: 'reset_sidebar_preferences' },
    );

    return reset;
  }

  // ── Starred Spaces ───────────────────────────────────────────────────────

  /**
   * Retrieves all starred spaces for a user with space details via a join.
   *
   * @param {string} userId - The application-level user ID (UUID)
   * @returns {Promise<Record<string, unknown>[]>} Array of starred space records
   * @throws {InternalServerErrorException} When the database query fails
   * @author Prince Jadiya
   */
  async getStarredSpaces(
    userId: string,
    organizationId?: string,
  ): Promise<Record<string, unknown>[]> {
    const client = this.supabaseAdmin.getClient();

    let query = client
      .from('starred_spaces')
      .select('*, space:spaces(id, name, key, color, icon, category)')
      .eq('user_id', userId);

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const result = await query.order('created_at', { ascending: false });

    if (result.error) {
      this.logger.error(
        `Failed to get starred spaces: ${result.error.message}`,
      );
      throw new InternalServerErrorException('Failed to get starred spaces');
    }
    // Drop stars on spaces the user can no longer open.
    if (this.permissionsService && organizationId) {
      const starred = (result.data ?? []) as Record<string, unknown>[];
      const ids = await this.permissionsService.getViewableSpaceIds(
        userId,
        organizationId,
        starred.map((row) => row.space_id as string),
      );
      if (ids !== null) {
        return starred.filter((row) => ids.includes(row.space_id as string));
      }
    }

    return (result.data ?? []) as Record<string, unknown>[];
  }

  /**
   * Toggles the starred state of a space for a user. If the space is currently
   * starred, it will be unstarred (deleted). If not starred, it will be starred
   * (inserted).
   *
   * @param {string} userId - The application-level user ID (UUID)
   * @param {string} organizationId - The user's organization ID (UUID)
   * @param {string} spaceId - The UUID of the space to toggle
   * @returns {Promise<{ starred: boolean }>} Whether the space is now starred
   * @throws {InternalServerErrorException} When the database operation fails
   * @author Prince Jadiya
   */
  async toggleStar(
    userId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<{ is_starred: boolean; space_id: string }> {
    const client = this.supabaseAdmin.getClient();

    await this.assertSpaceInOrganization(spaceId, organizationId);

    // Check if already starred
    const findResult = await client
      .from('starred_spaces')
      .select('id')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .maybeSingle();

    if (findResult.error) {
      this.logger.error(
        `Failed to check starred space: ${findResult.error.message}`,
      );
      throw new InternalServerErrorException('Failed to toggle star');
    }

    if (findResult.data) {
      // Unstar
      const deleteResult = await client
        .from('starred_spaces')
        .delete()
        .eq('id', (findResult.data as Record<string, unknown>).id);

      if (deleteResult.error) {
        this.logger.error(
          `Failed to unstar space: ${deleteResult.error.message}`,
        );
        throw new InternalServerErrorException('Failed to toggle star');
      }

      void this.auditLogsService.logAction(
        organizationId,
        userId,
        'space',
        spaceId,
        'delete',
        { action: 'unstarred' },
      );

      return { is_starred: false, space_id: spaceId };
    }

    // Only starring is refused, so old stars can still be removed.
    if (!(await this.canViewSpace(userId, organizationId, spaceId))) {
      throw new ForbiddenException('You do not have access to this space');
    }

    // Star
    const insertResult = await client.from('starred_spaces').insert({
      user_id: userId,
      organization_id: organizationId,
      space_id: spaceId,
    });

    if (insertResult.error) {
      this.logger.error(`Failed to star space: ${insertResult.error.message}`);
      throw new InternalServerErrorException('Failed to toggle star');
    }

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'space',
      spaceId,
      'create',
      { action: 'starred' },
    );

    return { is_starred: true, space_id: spaceId };
  }

  // ── Column Preferences ────────────────────────────────────────────────────

  async getColumnPreferences(
    userId: string,
    organizationId: string,
    viewId: string,
  ): Promise<{
    data: { view_id: string; column_config: unknown[]; is_default: boolean };
  }> {
    const client = this.supabaseAdmin.getClient();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await client
      .from('user_column_preferences')
      .select('*')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .eq('view_id', viewId)
      .single();

    if (error && error.code !== 'PGRST116') {
      this.logger.error('Failed to fetch column preferences:', error);
      throw new InternalServerErrorException('Failed to fetch preferences');
    }

    const columnConfig =
      (data as { column_config: unknown[] } | null)?.column_config ??
      getDefaultColumns(viewId);

    return {
      data: {
        view_id: viewId,
        column_config: columnConfig,
        is_default: !data,
      },
    };
  }

  async saveColumnPreferences(
    userId: string,
    organizationId: string,
    dto: SaveColumnPreferencesDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const client = this.supabaseAdmin.getClient();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await client
      .from('user_column_preferences')
      .upsert(
        {
          user_id: userId,
          organization_id: organizationId,
          view_id: dto.view_id,
          column_config: dto.column_config,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,organization_id,view_id' },
      )
      .select()
      .single();

    if (error || !data) {
      this.logger.error('Failed to save column preferences:', error);
      throw new BadRequestException('Failed to save preferences');
    }

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'user_preference',
      userId,
      'update',
      { action: 'save_column_preferences', view_id: dto.view_id },
    );

    return { data: data as Record<string, unknown>, success: true };
  }

  async resetColumnPreferences(
    userId: string,
    organizationId: string,
    viewId: string,
  ): Promise<{ success: true; message: string }> {
    const client = this.supabaseAdmin.getClient();
    const { error } = await client
      .from('user_column_preferences')
      .delete()
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .eq('view_id', viewId);

    if (error) {
      this.logger.error('Failed to reset column preferences:', error);
      throw new BadRequestException('Failed to reset preferences');
    }

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'user_preference',
      userId,
      'delete',
      { action: 'reset_column_preferences', view_id: viewId },
    );

    return { success: true, message: 'Preferences reset to defaults' };
  }

  async getTaskCommentPreferences(
    userId: string,
    organizationId: string,
  ): Promise<{ sort: TaskCommentSort; then: TaskCommentTieSort[] }> {
    // No org yet during onboarding, so there is nothing to scope a row to.
    if (!organizationId) return { sort: 'oldest', then: [] };

    const client = this.supabaseAdmin.getClient();
    const { data, error } = await client
      .from('user_column_preferences')
      .select('column_config')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .eq('view_id', TASK_COMMENTS_VIEW_ID)
      .maybeSingle();

    if (error) {
      this.logger.error('Failed to fetch task comment preferences:', error);
      throw new InternalServerErrorException('Failed to fetch preferences');
    }

    const stored = (data as { column_config?: { sort?: unknown } } | null)
      ?.column_config?.sort;
    const storedThen = (data as { column_config?: { then?: unknown } } | null)
      ?.column_config?.then;

    return {
      sort: TASK_COMMENT_SORTS.includes(stored as TaskCommentSort)
        ? (stored as TaskCommentSort)
        : 'oldest',
      then: normalizeTieSorts(storedThen),
    };
  }

  async saveTaskCommentPreferences(
    userId: string,
    organizationId: string,
    dto: SaveTaskCommentPreferencesDto,
  ): Promise<{ sort: TaskCommentSort; then: TaskCommentTieSort[] }> {
    const then = normalizeTieSorts(dto.then);

    if (!organizationId) {
      throw new BadRequestException('An active organization is required');
    }

    const client = this.supabaseAdmin.getClient();
    const { error } = await client.from('user_column_preferences').upsert(
      {
        user_id: userId,
        organization_id: organizationId,
        view_id: TASK_COMMENTS_VIEW_ID,
        column_config: { sort: dto.sort, then },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,organization_id,view_id' },
    );

    if (error) {
      this.logger.error('Failed to save task comment preferences:', error);
      throw new BadRequestException('Failed to save preferences');
    }

    return { sort: dto.sort, then };
  }

  private async upsertSidebarPreferences(
    userId: string,
    organizationId: string,
    config: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const client = this.supabaseAdmin.getClient();
    const now = new Date().toISOString();
    const spUpsert = (await client
      .from('user_sidebar_preferences')
      .upsert(
        {
          user_id: userId,
          organization_id: organizationId,
          config,
          updated_at: now,
        },
        { onConflict: 'user_id,organization_id' },
      )
      .select('*')
      .single()) as {
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    };
    const { data, error } = spUpsert;

    if (error || !data) {
      this.logger.error('Failed to upsert sidebar preferences:', error);
      throw new InternalServerErrorException(
        'Failed to update sidebar preferences',
      );
    }

    return data;
  }

  /** Same verdict as the space guard's `view_space` check; true when no PermissionsService. */
  private async canViewSpace(
    userId: string,
    organizationId: string,
    spaceId: string,
  ): Promise<boolean> {
    if (!this.permissionsService) return true;

    return spaceGrantAllows(
      await this.permissionsService.resolveSpaceBaseGrant(
        userId,
        organizationId,
        spaceId,
      ),
      'view_space',
    );
  }

  private async assertSpaceInOrganization(
    spaceId: string,
    organizationId: string,
  ): Promise<void> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) {
      this.logger.error('Failed to validate starred space scope:', error);
      throw new InternalServerErrorException('Failed to toggle star');
    }

    if (!data) {
      throw new NotFoundException('Space not found');
    }
  }

  private groupRecentItemsByTime(
    items: Record<string, unknown>[],
  ): Array<{ group: string; label: string; items: Record<string, unknown>[] }> {
    const now = new Date();
    const grouped = new Map<string, Record<string, unknown>[]>();

    for (const item of items) {
      const accessedAt = new Date(String(item.accessed_at));
      const group = this.getTimeGroup(accessedAt, now);
      grouped.set(group, [...(grouped.get(group) ?? []), item]);
    }

    return [
      'today',
      'yesterday',
      'this_week',
      'last_week',
      'this_month',
      'older',
    ]
      .filter((group) => grouped.has(group))
      .map((group) => ({
        group,
        label: TIME_GROUP_LABELS[group],
        items: grouped.get(group) ?? [],
      }));
  }

  private getTimeGroup(itemDate: Date, now: Date): string {
    const msPerDay = 1000 * 60 * 60 * 24;
    const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const itemDay = new Date(
      itemDate.getFullYear(),
      itemDate.getMonth(),
      itemDate.getDate(),
    );
    const diffDays = Math.floor(
      (nowDay.getTime() - itemDay.getTime()) / msPerDay,
    );

    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return 'this_week';
    if (diffDays < 14) return 'last_week';
    if (diffDays < 30) return 'this_month';
    return 'older';
  }
}
