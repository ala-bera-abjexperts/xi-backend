/**
 * @fileoverview Service for space management, membership operations, and icon storage.
 * Handles CRUD for spaces, member management (user/group/role), icon upload/delete,
 * and implicit member resolution.
 * @module src/spaces/spaces.service
 * @author Prince Jadiya
 */

import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { storageSafeFileName } from '../common/upload-filename';
import { formatMaxUpload, UPLOAD_LIMITS } from '../common/upload-limits';
import { assertImageMime } from '../common/upload-mime';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import { SpaceTemplatesService } from '../space-templates/space-templates.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { MailService } from '../mail/mail.service';
import { PermissionsService } from '../permissions/permissions.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { NotificationEmailService } from '../notifications/notification-email.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { EntitlementsService } from '../licensing/entitlements.service';
import { TestManagementSettingsService } from '../test-management/settings/test-management-settings.service';
import { SpaceStorageCleanupProcessor } from './space-storage-cleanup.processor';
import type { CreateSpaceDto } from './dto/create-space.dto';
import type { UpdateSpaceDto } from './dto/update-space.dto';
import type { CreateSpaceMemberDto } from './dto/create-space-member.dto';
import type { UpdateSpaceMemberDto } from './dto/update-space-member.dto';
import type { SpaceModuleItemDto } from './dto/update-space-modules.dto';
import type { SpaceInvitationUserDto } from './dto/create-space-invitations.dto';
import {
  FILE_EXPLORER_PERMISSION_KEYS,
  ORG_GRANTED_SPACE_PERMISSIONS,
  SPACE_PERMISSION_COLUMN_KEYS,
  SPACE_ROLE_BASE_PERMISSIONS,
  TEST_MANAGEMENT_PERMISSION_KEYS,
  normalizeSpacePermissions,
} from '../permissions/models/space-permissions.model';
import {
  MODULE_PERMISSION_KEYS_SET,
  ALLOWED_TARGET_TYPES_SET,
} from '../permissions/models/module-permission-keys';

/**
 * Icon uploads accept any `image/*` type EXCEPT SVG. SVG is INTENTIONALLY excluded — even a
 * static-looking SVG can carry `<script>` or `onload="..."` payloads that fire when the icon is
 * rendered inline, and space icons are served from a public bucket via `getPublicUrl`. Re-enable
 * only after server-side DOMPurify sanitization is in place.
 */
const ICON_MIME_OPTS = { allowSvg: false } as const;

/** Maximum icon file size */
const MAX_ICON_SIZE = UPLOAD_LIMITS.SMALL_IMAGE;

/** Supabase Storage bucket for space icons */
const STORAGE_BUCKET = 'wiki-attachments';

/** Space ids are UUIDs; anything else (e.g. a key) can never match `spaces.id`. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Maps a `spaces` unique-constraint violation (Postgres 23505) to a 409 naming the clashing
 * field, or returns null for any other error. The unique indexes are the source of truth, so
 * this also covers two requests racing past the key pre-check in `createSpace`.
 */
function spaceUniqueConflict(
  error: { code?: string; message?: string } | null,
  name: unknown,
  key?: string,
): ConflictException | null {
  if (error?.code !== '23505') return null;
  return error.message?.includes('_name_')
    ? new ConflictException(
        `A space named "${String(name)}" already exists in this organization`,
      )
    : new ConflictException(
        `Space key "${key}" is already used in this organization`,
      );
}

/**
 * Cap on how many candidate org spaces a non-admin `listMyAccessibleSpaces`
 * request scans. This bounds the per-space `getUserSpacePermissions` membership
 * checks one request can run, instead of the old "load every org space, then
 * check each one" approach that let a single request amplify into a lot of work.
 * If an org has more candidates than fit in one scan, paging continues via the
 * candidate-id cursor (see `listMyAccessibleSpaces`).
 */
const SCAN_BATCH = 200;

/**
 * Represents a row from the `spaces` table.
 */
export interface Space {
  id: string;
  organization_id: string;
  name: string;
  key: string;
  description: string | null;
  description_i18n: Record<string, string> | null;
  name_i18n: Record<string, string> | null;
  icon: string | null;
  icon_url: string | null;
  icon_path: string | null;
  color: string | null;
  background_color: string | null;
  category: string | null;
  space_type_id: string | null;
  lead_id: string | null;
  is_active: boolean;
  is_archived: boolean;
  archived_at: string | null;
  archived_by: string | null;
  settings: Record<string, unknown> | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Represents a row from the `space_members` table.
 */
export interface SpaceMember {
  id: string;
  space_id: string;
  member_type: string;
  user_id: string | null;
  group_id: string | null;
  role_id: string | null;
  space_role: string | null;
  permissions: Record<string, boolean> | null;
  notification_preferences: Record<string, unknown> | null;
  is_active: boolean;
  added_by: string | null;
  added_via_group_id: string | null;
  added_via_role_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Represents a row from the `space_modules` table.
 */
export interface SpaceModule {
  id: string;
  space_id: string;
  module_type: string;
  is_enabled: boolean;
  sort_order: number;
  settings: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/**
 * Represents a row from the `invitations` table (space-level subset).
 */
export interface SpaceInvitation {
  id: string;
  organization_id: string;
  invited_by: string;
  email: string;
  role: string;
  first_name: string;
  last_name: string;
  token: string;
  status: string;
  space_id: string | null;
  space_role: string;
  space_permissions: Record<string, boolean> | null;
  custom_role_id: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

/**
 * Service for space and space membership management.
 *
 * @example
 * constructor(private readonly spacesService: SpacesService) {}
 * const spaces = await this.spacesService.getSpaces(orgId, {}, 1, 20);
 */
@Injectable()
export class SpacesService {
  /** @private Logger instance scoped to this service */
  private readonly logger = new Logger(SpacesService.name);

  /**
   * @param {SupabaseAdminService} supabaseAdmin - Admin Supabase client for database and storage
   */
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
    private readonly mailService: MailService,
    private readonly spaceStorageCleanup: SpaceStorageCleanupProcessor,
    @Optional() private readonly outboxService?: AutomationEventOutboxService,
    // Optional so focused unit-test construction can omit this collaboration dependency.
    // DI always provides it in production (SpacesModule imports PermissionsModule);
    // the MCP-facing reads below assert its presence before use.
    @Optional() private readonly permissionsService?: PermissionsService,
    @Optional() private readonly spaceTemplatesService?: SpaceTemplatesService,
    @Optional()
    private readonly notificationsBroadcast?: NotificationsBroadcastService,
    @Optional()
    private readonly notificationEmail?: NotificationEmailService,
    // Optional for the same reason as permissionsService above. When absent
    // (unit tests), getEnabledModuleTypes returns the unfiltered list, which is
    // the pre-existing behaviour.
    @Optional() private readonly entitlementsService?: EntitlementsService,
    @Optional()
    private readonly testManagementSettings?: TestManagementSettingsService,
  ) {}

  /**
   * Sends a space invitation email, gated by the invitee's per-type Email
   * preference. Fire-and-forget and fully swallow-safe so it never affects the
   * invite flow. Fails OPEN: if the invitee's user id is unknown or the
   * preference service isn't wired, the email is still sent (preserves prior
   * behaviour).
   */
  private async maybeSendSpaceInvitationEmail(
    email: string,
    inviteeUserId: string | null,
    organizationId: string,
    data: {
      invitationLink: string;
      organizationName: string;
      spaceName: string;
      firstName: string;
      spaceRole: string;
      inviterName: string;
      expiresAt: string;
    },
  ): Promise<void> {
    try {
      if (inviteeUserId && this.notificationEmail) {
        const enabled = await this.notificationEmail.isEmailEnabled(
          inviteeUserId,
          organizationId,
          'space_invitation',
        );
        if (!enabled) return;
      }
      await this.mailService.sendSpaceInvitation(email, data);
    } catch (err) {
      this.logger.error(
        `Failed to send space invitation email to ${email}: ${(err as Error).message}`,
      );
    }
  }

  // ── Spaces CRUD ─────────────────────────────────────────────────────────

  /**
   * Returns a paginated list of spaces for an organization with optional filters.
   *
   * @param {string} orgId - Organization UUID
   * @param {Record<string, unknown>} filters - Optional filters (is_active, is_archived, category, lead_id, search)
   * @param {number} page - Page number (1-based)
   * @param {number} pageSize - Items per page (max 50)
   * @returns {Promise<{ data: Space[]; total: number; page: number; pageSize: number }>}
   */
  async getSpaces(
    orgId: string,
    filters: Record<string, unknown>,
    page: number,
    pageSize: number,
  ): Promise<{ data: Space[]; total: number; page: number; pageSize: number }> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, pageSize), 50);
    const offset = (safePage - 1) * safeLimit;

    const client = this.supabaseAdmin.getClient();
    let query = client
      .from('spaces')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
      // A space queued for permanent deletion is gone as far as anyone asking is concerned;
      // its rows are still draining in the background.
      .is('deleting_at', null);

    if (filters.is_active !== undefined) {
      query = query.eq('is_active', filters.is_active);
    }
    if (filters.is_archived !== undefined) {
      query = query.eq('is_archived', filters.is_archived);
    }
    if (filters.category) {
      query = query.eq('category', filters.category);
    }
    if (filters.lead_id) {
      query = query.eq('lead_id', filters.lead_id);
    }
    if (typeof filters.search === 'string' && filters.search) {
      query = query.ilike('name', `%${filters.search}%`);
    }
    // Opt-in: only spaces the user may open; null means every space (org owner/admin).
    if (typeof filters.accessible_to_user_id === 'string') {
      const ids = await this.requirePermissionsService().getViewableSpaceIds(
        filters.accessible_to_user_id,
        orgId,
      );
      if (ids !== null) {
        if (ids.length === 0) {
          return { data: [], total: 0, page: safePage, pageSize: safeLimit };
        }
        query = query.in('id', ids);
      }
    }

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + safeLimit - 1);

    const result = await query;

    if (result.error) {
      this.logger.error(`Failed to get spaces: ${result.error.message}`);
      throw new InternalServerErrorException('Failed to get spaces');
    }

    return {
      data: (result.data ?? []) as Space[],
      total: result.count ?? 0,
      page: safePage,
      pageSize: safeLimit,
    };
  }

  /**
   * Creates a new space, auto-generates a key if not provided, and adds the
   * creator as an owner member.
   *
   * @param {string} orgId - Organization UUID
   * @param {string} userId - Creator user UUID
   * @param {CreateSpaceDto} data - Space creation payload
   * @returns {Promise<Space>} The newly created space
   * @throws {InternalServerErrorException} When a database operation fails
   */
  async createSpace(
    orgId: string,
    userId: string,
    data: CreateSpaceDto,
    // Server-side callers only (Robert's Confirm): a repeated create collides on the primary key.
    trusted?: { id?: string },
  ): Promise<Space> {
    const client = this.supabaseAdmin.getClient();
    const key = (data.key ?? this.generateKey(data.name)).toUpperCase();

    // Key-uniqueness guard within the org. Mirrors updateSpace's collision
    // check (P1.3). Without this, a duplicate-key insert produces a 23505
    // unique-violation that bubbles up as a generic 500.
    const existing = await client
      .from('spaces')
      .select('id')
      .eq('organization_id', orgId)
      .eq('key', key)
      .maybeSingle();

    if (existing.data) {
      throw new ConflictException(
        `Space key "${key}" is already used in this organization`,
      );
    }

    // Warn-only plan-limit check: logs a breach, never refuses. See
    // EntitlementsService.checkLimit for why this is not a block yet. To
    // enforce, throw a ForbiddenException when `verdict.exceeded`.
    await this.entitlementsService?.checkLimit(
      orgId,
      'limit_spaces',
      async () => {
        const { count } = await client
          .from('spaces')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId)
          .eq('is_archived', false);

        return count ?? 0;
      },
    );

    const spaceResult = await client
      .from('spaces')
      .insert({
        ...(trusted?.id && { id: trusted.id }),
        organization_id: orgId,
        name: data.name,
        key, // already uppercased + uniqueness-checked above
        description: data.description ?? null,
        icon: data.icon ?? null,
        color: data.color ?? null,
        background_color: data.background_color ?? null,
        category: data.category ?? null,
        lead_id: data.lead_id ?? null,
        settings: data.settings ?? {
          allowPublicAccess: false,
          autoAssignReporter: true,
          defaultDashboardId: null,
          requireApprovalForTasks: false,
        },
        space_type_id: data.space_type_id ?? null,
        created_by: userId,
        updated_by: userId,
      })
      .select('*')
      .single();

    const conflict = spaceUniqueConflict(spaceResult.error, data.name, key);
    if (conflict) throw conflict;

    if (spaceResult.error || !spaceResult.data) {
      this.logger.error(
        `Failed to create space: ${spaceResult.error?.message ?? 'No data returned'}`,
      );
      throw new InternalServerErrorException('Failed to create space');
    }

    const space = spaceResult.data as Space;

    // Add creator as owner member
    const memberResult = await client.from('space_members').insert({
      space_id: space.id,
      member_type: 'user',
      user_id: userId,
      space_role: 'owner',
      added_by: userId,
      is_active: true,
    });

    if (memberResult.error) {
      this.logger.warn(
        `Failed to add creator as space owner: ${memberResult.error.message}`,
      );
    }

    // Space modules are seeded by the DB trigger `on_space_created_modules`
    // (function `create_default_space_modules`), which inserts 11 rows with
    // dashboards/processes/tasks enabled and the rest disabled.
    //
    // There used to be a second seeding INSERT here listing 9 modules. It could
    // never do anything: the trigger fires AFTER INSERT on `spaces`, so by the
    // time this ran all but one of those rows already existed, and
    // `space_modules_space_id_module_type_key` (UNIQUE on space_id,module_type)
    // aborted the whole statement. A multi-row INSERT is atomic, so even the one
    // new row ('risk') was rolled back, and because the promise was `void`ed the
    // unique_violation was never logged. Verified against Postgres: 0 rows
    // inserted, 11 rows surviving.
    //
    // It is removed rather than repaired: making it work would silently change
    // what a new space starts with (9 modules enabled instead of 3), which is a
    // product decision, not a bug fix. If a new space should enable more modules
    // by default, change `create_default_space_modules` so there is exactly one
    // seeder.

    // Audit (fire-and-forget — never block the mutation)
    void this.auditLogsService.logAction(
      orgId,
      userId,
      'space',
      space.id,
      'create',
      { name: space.name, key: space.key },
    );

    // Apply space template if provided (non-fatal — space is returned regardless)
    if (data.template_id && this.spaceTemplatesService) {
      this.spaceTemplatesService
        .applyTemplateToSpace(data.template_id, space.id, orgId, userId)
        .catch((err) => {
          this.logger.warn(
            `createSpace: template apply failed for template ${data.template_id}: ${err}`,
          );
        });
    }

    return space;
  }

  /**
   * Returns all spaces accessible to a user (direct membership).
   *
   * Tenant scoping: `space_members` carries no organization_id, so membership
   * alone spans every org the user belongs to. Without the organizationId filter
   * below a multi-org user saw spaces from ALL their orgs in one list — a
   * cross-tenant leak visible in the sidebar space switcher and in the
   * /auth/bootstrap payload. Callers pass the guard-resolved org.
   *
   * The parameter is optional (not required) so the empty-org onboarding state
   * still works: filtering on '' would hit a uuid parse error rather than simply
   * returning nothing. Both production call sites pass it.
   *
   * @param {string} userId - User UUID
   * @param {string} [organizationId] - Restrict to this org; unscoped when omitted/empty
   * @returns {Promise<Space[]>} Array of accessible spaces
   */
  async getUserSpaces(
    userId: string,
    organizationId?: string,
  ): Promise<Space[]> {
    const client = this.supabaseAdmin.getClient();

    // "View space" unticked for the user's role: no spaces in the switcher or bootstrap.
    if (
      organizationId &&
      (await this.permissionsService?.isViewSpaceDenied(userId, organizationId))
    ) {
      return [];
    }

    // Org owners/admins may open every space without a membership row (XE-T701: a new space
    // no longer copies them into space_members), so list the whole org for them.
    if (
      organizationId &&
      (await this.permissionsService?.isAdminOrOwner(userId, organizationId))
    ) {
      const allResult = await client
        .from('spaces')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('is_active', true)
        .eq('is_archived', false)
        .order('name', { ascending: true });

      if (allResult.error) {
        this.logger.error(
          `Failed to get user spaces: ${allResult.error.message}`,
        );
        throw new InternalServerErrorException('Failed to get user spaces');
      }

      return (allResult.data ?? []) as Space[];
    }

    const memberResult = await client
      .from('space_members')
      .select('space_id')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (memberResult.error) {
      this.logger.error(
        `Failed to get user memberships: ${memberResult.error.message}`,
      );
      throw new InternalServerErrorException('Failed to get user spaces');
    }

    const memberships = memberResult.data as { space_id: string }[] | null;

    if (!memberships || memberships.length === 0) {
      return [];
    }

    const spaceIds = memberships.map((m) => m.space_id);

    let spacesQuery = client
      .from('spaces')
      .select('*')
      .in('id', spaceIds)
      .eq('is_active', true)
      .eq('is_archived', false);

    if (organizationId) {
      spacesQuery = spacesQuery.eq('organization_id', organizationId);
    }

    const spacesResult = await spacesQuery.order('name', { ascending: true });

    if (spacesResult.error) {
      this.logger.error(
        `Failed to get user spaces: ${spacesResult.error.message}`,
      );
      throw new InternalServerErrorException('Failed to get user spaces');
    }

    return (spacesResult.data ?? []) as Space[];
  }

  /**
   * Mirrors the legacy ticket-form visibility check that allowed users with no
   * direct memberships, but honored base-role overrides that explicitly deny
   * `can_view_space` for every direct space role.
   */
  async canViewSpaces(
    userId: string,
    organizationId: string,
  ): Promise<{ canViewSpaces: boolean }> {
    const client = this.supabaseAdmin.getClient();

    const membershipsResult = await client
      .from('space_members')
      .select('space_role')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (membershipsResult.error) {
      this.logger.error(
        `Failed to check user space memberships: ${membershipsResult.error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to check space visibility',
      );
    }

    const roles = [
      ...new Set(
        (
          (membershipsResult.data ?? []) as Array<{
            space_role?: string | null;
          }>
        )
          .map((membership) => membership.space_role)
          .filter((role): role is string => Boolean(role)),
      ),
    ];

    if (roles.length === 0) {
      return { canViewSpaces: true };
    }

    const overridesResult = await client
      .from('base_role_permission_overrides')
      .select('base_role, permissions')
      .eq('organization_id', organizationId)
      .in('base_role', roles);

    if (overridesResult.error) {
      this.logger.error(
        `Failed to check can_view_space overrides: ${overridesResult.error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to check space visibility',
      );
    }

    const overrideMap = new Map(
      (
        (overridesResult.data ?? []) as Array<{
          base_role: string;
          permissions?: Record<string, boolean> | null;
        }>
      ).map((row) => [row.base_role, row.permissions?.can_view_space]),
    );

    return {
      canViewSpaces: !roles.every((role) => overrideMap.get(role) === false),
    };
  }

  async getRecentSpaces(
    userId: string,
    organizationId: string,
  ): Promise<Space[]> {
    const client = this.supabaseAdmin.getClient();
    const recentResult = await client
      .from('user_recent_items')
      .select('item_id, accessed_at')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .eq('item_type', 'space')
      .order('accessed_at', { ascending: false })
      .limit(20);

    if (recentResult.error) {
      this.logger.warn(
        `Failed to load recent spaces: ${recentResult.error.message}`,
      );
    }

    const spaceIds = (recentResult.data ?? [])
      .map((item) => item.item_id as string | null)
      .filter((id): id is string => Boolean(id));
    // Read 20, keep only viewable ones, show at most 5.
    const viewable = this.permissionsService
      ? await this.permissionsService.getViewableSpaceIds(
          userId,
          organizationId,
          spaceIds,
        )
      : null;
    const allowedIds =
      viewable === null
        ? spaceIds
        : spaceIds.filter((id) => viewable.includes(id));

    if (allowedIds.length > 0) {
      const spacesResult = await client
        .from('spaces')
        .select('*')
        .eq('organization_id', organizationId)
        .in('id', allowedIds)
        .eq('is_archived', false);

      if (spacesResult.error) {
        this.logger.error(
          `Failed to load recent space details: ${spacesResult.error.message}`,
        );
        throw new InternalServerErrorException('Failed to get recent spaces');
      }

      const byId = new Map(
        (spacesResult.data ?? []).map((space) => [
          (space as Space).id,
          space as Space,
        ]),
      );

      const recent = allowedIds
        .map((id) => byId.get(id))
        .filter((space): space is Space => Boolean(space))
        .slice(0, 5);

      // None left (archived or no access) falls through to the fallback.
      if (recent.length > 0) return recent;
    }

    const fallbackIds = this.permissionsService
      ? await this.permissionsService.getViewableSpaceIds(
          userId,
          organizationId,
        )
      : null;
    if (fallbackIds !== null && fallbackIds.length === 0) return [];

    let fallbackQuery = client
      .from('spaces')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('is_archived', false)
      .order('updated_at', { ascending: false })
      .limit(5);
    if (fallbackIds !== null) {
      fallbackQuery = fallbackQuery.in('id', fallbackIds);
    }
    const fallbackResult = await fallbackQuery;

    if (fallbackResult.error) {
      this.logger.error(
        `Failed to load fallback recent spaces: ${fallbackResult.error.message}`,
      );
      throw new InternalServerErrorException('Failed to get recent spaces');
    }

    return (fallbackResult.data ?? []) as Space[];
  }

  /**
   * Checks if a space key is already in use within an organization.
   *
   * @param {string} key - Space key to check
   * @param {string} orgId - Organization UUID
   * @returns {Promise<{ available: boolean; space?: Space }>}
   */
  async getSpaceByKey(
    key: string,
    orgId: string,
  ): Promise<{ available: boolean; space?: Space }> {
    const client = this.supabaseAdmin.getClient();

    const result = await client
      .from('spaces')
      .select('*')
      .eq('key', key.toUpperCase())
      .eq('organization_id', orgId)
      .maybeSingle();

    if (result.error) {
      this.logger.error(`Failed to check space key: ${result.error.message}`);
      throw new InternalServerErrorException('Failed to check space key');
    }

    if (result.data) {
      return { available: false, space: result.data as Space };
    }

    return { available: true };
  }

  /**
   * Retrieves a space by its ID.
   *
   * @param {string} spaceId - Space UUID
   * @returns {Promise<Space>} The space record
   * @throws {NotFoundException} When the space is not found
   */
  async getSpaceById(spaceId: string, orgId?: string): Promise<Space> {
    // A non-UUID (e.g. `GET /spaces/by-key` with no key falling through to `:id`) cannot match
    // any space. Answer like a missing space instead of letting Postgres reject the uuid cast (500).
    if (!UUID_PATTERN.test(spaceId)) {
      throw new NotFoundException('Space not found');
    }

    const client = this.supabaseAdmin.getClient();

    let query = client
      .from('spaces')
      .select('*')
      .eq('id', spaceId)
      // Queued for deletion: refuse every operation on it rather than let callers act on a
      // space whose rows are disappearing underneath them.
      .is('deleting_at', null);

    if (orgId) {
      query = query.eq('organization_id', orgId);
    }

    const result = await query.maybeSingle();

    if (result.error) {
      this.logger.error(`Failed to get space: ${result.error.message}`);
      throw new InternalServerErrorException('Failed to get space');
    }

    if (!result.data) {
      throw new NotFoundException('Space not found');
    }

    return result.data as Space;
  }

  async getSpaceWithRelations(
    spaceId: string,
    orgId: string,
  ): Promise<Record<string, unknown>> {
    const space = await this.getSpaceById(spaceId, orgId);
    const client = this.supabaseAdmin.getClient();

    const [{ count: membersCount }, { count: modulesCount }, { data: lead }] =
      await Promise.all([
        client
          .from('space_members')
          .select('id', { count: 'exact', head: true })
          .eq('space_id', spaceId)
          .eq('is_active', true),
        client
          .from('space_modules')
          .select('id', { count: 'exact', head: true })
          .eq('space_id', spaceId)
          .eq('is_enabled', true),
        space.lead_id
          ? client
              .from('users')
              .select('id, first_name, last_name, email, avatar_url')
              .eq('id', space.lead_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

    return {
      ...space,
      lead: lead ?? null,
      members_count: membersCount ?? 0,
      modules_count: modulesCount ?? 0,
    };
  }

  // MCP-facing accessible-space reads

  /**
   * Returns the enabled modules for a space as a flat list of `module_type`
   * keys (from the `space_modules` table). Used to enrich the accessible-space
   * payloads without exposing module settings. Empty list on a miss.
   *
   * Entitlement-filtered: these payloads feed the MCP `space.list` /
   * `space.get` tools, and advertising a module there that `@RequireFeature`
   * will then 403 gives an agent a tool call that cannot succeed. Enforcement
   * still lives on the controllers; this only keeps the listing honest.
   */
  private async getEnabledModuleTypes(
    spaceId: string,
    organizationId?: string,
  ): Promise<string[]> {
    const client = this.supabaseAdmin.getClient();

    const result = await client
      .from('space_modules')
      .select('module_type')
      .eq('space_id', spaceId)
      .eq('is_enabled', true)
      .order('sort_order', { ascending: true });

    if (result.error) {
      this.logger.error(`Failed to get space modules: ${result.error.message}`);

      return [];
    }

    const moduleTypes = ((result.data ?? []) as { module_type: string }[]).map(
      (m) => m.module_type,
    );

    if (!organizationId || !this.entitlementsService) {
      return moduleTypes;
    }

    return this.entitlementsService.filterEntitledModuleTypes(
      organizationId,
      moduleTypes,
    );
  }

  /**
   * Lists the spaces the caller can actually access in their active org, for
   * the MCP `space.list` tool.
   *
   * Visibility rule (same source of truth as SpacePermissionsGuard): keep a
   * candidate org space iff getUserSpacePermissions(...).isMember is true, which
   * already covers direct membership, org owner/admin, and group/role grants.
   * Org owners/admins short-circuit to all org spaces via isAdminOrOwner.
   *
   * Never returns cross-org or non-member spaces. Caller ids come only from the
   * authenticated RequestUser, never from request arguments. Result is never
   * null; an empty org yields `{ spaces: [] }`.
   *
   * Pagination is bounded keyset pagination over the `spaces.id` ordering, and
   * differs by path:
   *  - admin/owner: one keyset query for `limit + 1` org spaces (no per-space
   *    checks, admins see all). The extra row just tells us whether to emit a
   *    `nextCursor`.
   *  - non-admin: scan one bounded candidate batch (SCAN_BATCH ids) and run the
   *    membership check over just that batch, so per-request work is capped at
   *    SCAN_BATCH checks no matter how big the org is.
   *
   * Short pages are normal: a non-admin page can return fewer than `limit`
   * visible spaces and still emit a `nextCursor`, because a scanned batch may
   * hold few (or zero) spaces the caller is a member of. Clients should keep
   * paging with the returned cursor until `nextCursor` is absent, not stop
   * early just because a page was short.
   */
  async listMyAccessibleSpaces(
    user: RequestUser,
    opts: {
      includeArchived?: boolean;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<{
    spaces: Array<{
      id: string;
      key: string;
      name: string;
      description: string | null;
      icon: string | null;
      color: string | null;
      isArchived: boolean;
      modules: string[];
    }>;
    nextCursor?: string;
  }> {
    if (!user.organizationId) {
      return { spaces: [] };
    }

    const permissionsService = this.requirePermissionsService();
    const includeArchived = opts.includeArchived === true;
    const limit = Math.min(Math.max(1, opts.limit ?? 25), 50);
    const client = this.supabaseAdmin.getClient();

    type CandidateRow = {
      id: string;
      key: string;
      name: string;
      description: string | null;
      icon: string | null;
      color: string | null;
      is_archived: boolean;
    };

    // Builds the bounded keyset query for the org's candidate spaces. We list
    // explicit safe columns rather than select('*') so settings, icon_path,
    // actor ids, and member lists stay out of the MCP surface. Ordered by id
    // ascending so the keyset cursor is stable; the limit bounds the rows
    // pulled per request, which is the whole point of this rework.
    const buildCandidateQuery = (fetch: number) => {
      let query = client
        .from('spaces')
        .select('id, key, name, description, icon, color, is_archived')
        .eq('organization_id', user.organizationId)
        // Queued for deletion — not accessible, even in the includeArchived listing.
        .is('deleting_at', null);

      if (!includeArchived) {
        query = query.eq('is_archived', false);
      }

      if (opts.cursor) {
        query = query.gt('id', opts.cursor);
      }

      return query.order('id', { ascending: true }).limit(fetch);
    };

    const enrich = (rows: CandidateRow[]) =>
      Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          key: row.key,
          name: row.name,
          description: row.description,
          icon: row.icon,
          color: row.color,
          isArchived: row.is_archived,
          modules: await this.getEnabledModuleTypes(
            row.id,
            user.organizationId,
          ),
        })),
      );

    // Determine the path up-front: it dictates how many rows we fetch (admins
    // need only `limit + 1`; non-admins scan a full SCAN_BATCH of candidates).
    const isAdminOrOwner = await permissionsService.isAdminOrOwner(
      user.userId,
      user.organizationId,
    );

    // Admin/owner path: plain keyset query, no per-space checks.
    if (isAdminOrOwner) {
      const result = await buildCandidateQuery(limit + 1);

      if (result.error) {
        this.logger.error(
          `Failed to list accessible spaces: ${result.error.message}`,
        );
        throw new InternalServerErrorException('Failed to list spaces');
      }

      const rows = (result.data ?? []) as CandidateRow[];
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const spaces = await enrich(pageRows);

      // nextCursor = the limit-th row id when an extra row proves more remain.
      return hasMore
        ? { spaces, nextCursor: pageRows[pageRows.length - 1].id }
        : { spaces };
    }

    // Non-admin path: bounded scan of SCAN_BATCH candidate ids. The visibility
    // rule is unchanged, keep exactly the spaces whose
    // getUserSpacePermissions(...).isMember is true (covers direct membership
    // plus group/role grants). Only the iteration is now bounded.
    const result = await buildCandidateQuery(SCAN_BATCH);

    if (result.error) {
      this.logger.error(
        `Failed to list accessible spaces: ${result.error.message}`,
      );
      throw new InternalServerErrorException('Failed to list spaces');
    }

    const candidates = (result.data ?? []) as CandidateRow[];
    const batchWasFull = candidates.length === SCAN_BATCH;

    const checks = await Promise.all(
      candidates.map(async (row) => ({
        row,
        resolved: await permissionsService.getUserSpacePermissions(
          user.userId,
          user.organizationId,
          row.id,
        ),
      })),
    );

    const visibleRows: CandidateRow[] = [];

    for (const { row, resolved } of checks) {
      if (resolved.isMember) visibleRows.push(row);
    }

    // Cursor logic. We paginate on the candidate id, not the visible id, so a
    // short page can still resume into the next unscanned candidates:
    //  1. More visible than the limit: return the first `limit`; the cursor is
    //     the limit-th visible id (resume just after the spaces we returned).
    //  2. Otherwise, if the scanned batch was full, more candidates may remain,
    //     so the cursor is the last scanned candidate id (we return what was
    //     visible, which may be fewer than limit, and clients keep paging).
    //  3. Otherwise the candidates are exhausted, so no cursor.
    if (visibleRows.length > limit) {
      const pageRows = visibleRows.slice(0, limit);
      const spaces = await enrich(pageRows);

      return { spaces, nextCursor: pageRows[pageRows.length - 1].id };
    }

    const spaces = await enrich(visibleRows);

    if (batchWasFull) {
      return {
        spaces,
        nextCursor: candidates[candidates.length - 1].id,
      };
    }

    return { spaces };
  }

  /**
   * Resolves one accessible space (by UUID or key) for the MCP `space.get` tool,
   * with the caller's role and the keys of their effective space permissions.
   *
   * Anti-probing: a non-member, a nonexistent space, and a cross-org space all
   * throw the same NotFoundException, so the tool can't be used to discover
   * which spaces exist. Caller ids come only from the authenticated RequestUser.
   */
  async getMyAccessibleSpace(
    user: RequestUser,
    spaceIdOrKey: string,
  ): Promise<{
    space: {
      id: string;
      key: string;
      name: string;
      description: string | null;
      isArchived: boolean;
      modules: string[];
    };
    myRole: string | null;
    myPermissions: string[];
  }> {
    // Same 404 for every "you can't see this" case, so we never disambiguate
    // between non-member, nonexistent, and cross-org.
    const notFound = () => new NotFoundException('Space not found');

    if (!user.organizationId) {
      throw notFound();
    }

    const permissionsService = this.requirePermissionsService();
    const client = this.supabaseAdmin.getClient();

    // UUID-vs-key resolution: a v4 UUID is looked up by id, otherwise by key
    // (case-insensitive via getSpaceByKey, which upper-cases the key).
    const isUuid = UUID_PATTERN.test(spaceIdOrKey);

    let row: {
      id: string;
      key: string;
      name: string;
      description: string | null;
      is_archived: boolean;
    } | null = null;

    if (isUuid) {
      const result = await client
        .from('spaces')
        .select('id, key, name, description, is_archived')
        .eq('id', spaceIdOrKey)
        .eq('organization_id', user.organizationId)
        .maybeSingle();

      if (result.error) {
        this.logger.error(`Failed to get space: ${result.error.message}`);
        throw new InternalServerErrorException('Failed to get space');
      }

      row = (result.data as typeof row) ?? null;
    } else {
      const byKey = await this.getSpaceByKey(spaceIdOrKey, user.organizationId);

      if (byKey.space) {
        row = {
          id: byKey.space.id,
          key: byKey.space.key,
          name: byKey.space.name,
          description: byKey.space.description,
          is_archived: byKey.space.is_archived,
        };
      }
    }

    if (!row) {
      throw notFound();
    }

    const resolved = await permissionsService.getUserSpacePermissions(
      user.userId,
      user.organizationId,
      row.id,
    );

    if (!resolved.isMember) {
      throw notFound();
    }

    // myPermissions = the keys whose value is strictly true.
    const myPermissions = Object.keys(resolved.permissions).filter(
      (key) => resolved.permissions[key] === true,
    );

    return {
      space: {
        id: row.id,
        key: row.key,
        name: row.name,
        description: row.description,
        isArchived: row.is_archived,
        modules: await this.getEnabledModuleTypes(row.id, user.organizationId),
      },
      myRole: resolved.spaceRole,
      myPermissions,
    };
  }

  /**
   * Asserts the optionally-injected PermissionsService is present before the
   * MCP-facing reads use it. DI always supplies it in production; this guard
   * only fires in the older 3-arg unit-test construction path.
   */
  private requirePermissionsService(): PermissionsService {
    if (!this.permissionsService) {
      throw new InternalServerErrorException(
        'PermissionsService is not available',
      );
    }

    return this.permissionsService;
  }

  /**
   * Updates a space's fields.
   *
   * @param {string} spaceId - Space UUID
   * @param {string} userId - User performing the update
   * @param {UpdateSpaceDto} data - Fields to update
   * @returns {Promise<Space>} The updated space
   * @throws {InternalServerErrorException} When the database operation fails
   */
  async updateSpace(
    spaceId: string,
    userId: string,
    data: UpdateSpaceDto,
    orgId?: string,
  ): Promise<Space> {
    const client = this.supabaseAdmin.getClient();
    await this.assertSpaceInOrganization(spaceId, orgId);

    const rest = { ...(data as Record<string, unknown>) };
    delete rest['id'];
    delete rest['updated_by'];
    delete rest['key'];
    delete rest['organization_id'];
    const updatePayload: Record<string, unknown> = {
      ...rest,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };

    let query = client.from('spaces').update(updatePayload).eq('id', spaceId);

    if (orgId) {
      query = query.eq('organization_id', orgId);
    }

    const result = await query.select('*').single();

    const conflict = spaceUniqueConflict(result.error, rest['name']);
    if (conflict) throw conflict;

    if (result.error || !result.data) {
      this.logger.error(
        `Failed to update space: ${result.error?.message ?? 'No data returned'}`,
      );
      throw new InternalServerErrorException('Failed to update space');
    }

    const updated = result.data as Space;

    void this.auditLogsService.logAction(
      updated.organization_id,
      userId,
      'space',
      updated.id,
      'update',
      {
        // Only log the keys the caller actually set — keeps audit_logs small.
        keys: Object.keys(rest),
      },
    );

    return updated;
  }

  /**
   * Soft-deletes a space by setting is_archived to true.
   *
   * @param {string} spaceId - Space UUID
   * @param {string} userId - User performing the archive
   * @returns {Promise<Space>} The archived space
   */
  async archiveSpace(
    spaceId: string,
    userId: string,
    orgId?: string,
  ): Promise<Space> {
    const client = this.supabaseAdmin.getClient();
    await this.assertSpaceInOrganization(spaceId, orgId);

    let query = client
      .from('spaces')
      .update({
        is_archived: true,
        archived_at: new Date().toISOString(),
        archived_by: userId,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', spaceId);

    if (orgId) {
      query = query.eq('organization_id', orgId);
    }

    const result = await query.select('*').single();

    if (result.error || !result.data) {
      this.logger.error(
        `Failed to archive space: ${result.error?.message ?? 'No data returned'}`,
      );
      throw new InternalServerErrorException('Failed to archive space');
    }

    const archived = result.data as Space;

    void this.auditLogsService.logAction(
      archived.organization_id,
      userId,
      'space',
      archived.id,
      'archive',
    );

    return archived;
  }

  /**
   * Hard-deletes a space. The space must be archived first for safety.
   *
   * @param {string} spaceId - Space UUID
   * @returns {Promise<void>}
   * @throws {BadRequestException} When the space is not archived
   */
  async deleteSpace(
    spaceId: string,
    userId?: string,
    orgId?: string,
  ): Promise<void> {
    const client = this.supabaseAdmin.getClient();

    // Permanent delete needs "delete space" on top of the route's archive permission
    if (
      userId &&
      orgId &&
      this.permissionsService &&
      !(await this.permissionsService.hasSpacePermission(
        userId,
        orgId,
        spaceId,
        'delete_space',
      ))
    ) {
      throw new ForbiddenException('Insufficient space permissions');
    }

    // Safety check: require archived first
    const space = await this.getSpaceById(spaceId, orgId);
    if (!space.is_archived) {
      throw new BadRequestException(
        'Space must be archived before permanent deletion',
      );
    }

    const { data: cleanupJobId, error: deleteError } = (await client.rpc(
      'delete_space_cascade',
      {
        p_organization_id: space.organization_id,
        p_space_id: space.id,
        p_requested_by: userId ?? null,
      },
    )) as { data: string | null; error: { message: string } | null };

    if (deleteError || !cleanupJobId) {
      const reason = deleteError?.message ?? 'cleanup job was not created';

      this.logger.error(`Failed to delete space: ${reason}`);

      // A refusal the caller can act on is a bad request, not a server fault: re-reporting it
      // as a 500 is what made this failure so hard to read from the outside.
      if (/must be archived|waits for workflow|does not belong/i.test(reason)) {
        throw new BadRequestException(reason);
      }

      throw new InternalServerErrorException('Failed to delete space');
    }

    // The space is now marked and its storage scopes recorded; the rows come out in batches.
    // Draining here makes an ordinary space disappear within this request, while a very large
    // one keeps draining on the cron after we have already answered the caller.
    void this.spaceStorageCleanup
      .drainSpaceRows(space.id)
      .then(() => this.spaceStorageCleanup.drainSpace(space.id))
      .catch((error: unknown) => {
        // The deletion is queued and durable: spaces.deleting_at is set and every cleanup
        // scope is persisted. The scheduled processor reclaims the work, so reporting a
        // failure here would only invite a misleading retry.
        this.logger.error(
          `Space ${space.id} is queued for deletion but draining is pending: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    // Audit AFTER successful delete — userId is optional because some legacy
    // callers don't pass it; audit is best-effort.
    if (userId) {
      void this.auditLogsService.logAction(
        space.organization_id,
        userId,
        'space',
        spaceId,
        'delete',
        { name: space.name, key: space.key },
      );
    }
  }

  /**
   * Restores an archived space.
   *
   * @param {string} spaceId - Space UUID
   * @param {string} userId - User performing the unarchive
   * @returns {Promise<Space>} The restored space
   */
  async unarchiveSpace(spaceId: string, userId: string): Promise<Space> {
    const client = this.supabaseAdmin.getClient();

    const result = await client
      .from('spaces')
      .update({
        is_archived: false,
        archived_at: null,
        archived_by: null,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', spaceId)
      .select('*')
      .single();

    if (result.error || !result.data) {
      this.logger.error(
        `Failed to unarchive space: ${result.error?.message ?? 'No data returned'}`,
      );
      throw new InternalServerErrorException('Failed to unarchive space');
    }

    const restored = result.data as Space;

    void this.auditLogsService.logAction(
      restored.organization_id,
      userId,
      'space',
      restored.id,
      'restore',
    );

    return restored;
  }

  // ── Icon management ─────────────────────────────────────────────────────

  /**
   * Uploads an icon image to Supabase Storage and updates the space record.
   *
   * @param {string} spaceId - Space UUID
   * @param {string} userId - User performing the upload
   * @param {Buffer} fileBuffer - Raw file bytes
   * @param {string} fileName - Original filename
   * @param {string} mimeType - MIME type of the file
   * @returns {Promise<Space>} The updated space
   * @throws {BadRequestException} When the file type or size is invalid
   */
  async uploadIcon(
    spaceId: string,
    userId: string,
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string,
  ): Promise<Space> {
    assertImageMime(mimeType, ICON_MIME_OPTS);

    if (fileBuffer.length > MAX_ICON_SIZE) {
      throw new BadRequestException(
        `File size exceeds the ${formatMaxUpload(MAX_ICON_SIZE)} limit`,
      );
    }

    const client = this.supabaseAdmin.getClient();

    // Delete old icon if exists
    const space = await this.getSpaceById(spaceId);
    if (space.icon_path) {
      await client.storage.from(STORAGE_BUCKET).remove([space.icon_path]);
    }

    // Upload new file
    // Sanitised for the same reason as attachments: a storage key must be
    // ASCII, and a space icon is often named in the tenant's own language.
    const storagePath = `space-icons/${spaceId}/${Date.now()}-${storageSafeFileName(fileName)}`;
    const uploadResult = await client.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, fileBuffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (uploadResult.error) {
      this.logger.error(`Failed to upload icon: ${uploadResult.error.message}`);
      throw new InternalServerErrorException('Failed to upload icon');
    }

    // Get public URL for the uploaded icon
    const publicUrlResult = client.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);

    // Update space record with icon path and URL
    return this.updateSpace(spaceId, userId, {
      icon_path: storagePath,
      icon_url: publicUrlResult.data.publicUrl,
    } as UpdateSpaceDto);
  }

  /**
   * Deletes the icon from storage and clears the space icon fields.
   *
   * @param {string} spaceId - Space UUID
   * @param {string} userId - User performing the deletion
   * @returns {Promise<Space>} The updated space with cleared icon fields
   */
  async deleteIcon(spaceId: string, userId: string): Promise<Space> {
    const client = this.supabaseAdmin.getClient();
    const space = await this.getSpaceById(spaceId);

    if (space.icon_path) {
      await client.storage.from(STORAGE_BUCKET).remove([space.icon_path]);
    }

    const result = await client
      .from('spaces')
      .update({
        icon: null,
        icon_url: null,
        icon_path: null,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', spaceId)
      .select('*')
      .single();

    if (result.error || !result.data) {
      this.logger.error(
        `Failed to clear icon: ${result.error?.message ?? 'No data returned'}`,
      );
      throw new InternalServerErrorException('Failed to clear icon');
    }

    return result.data as Space;
  }

  // ── Members ─────────────────────────────────────────────────────────────

  /**
   * Returns all active members of a space.
   *
   * @param {string} spaceId - Space UUID
   * @returns {Promise<SpaceMember[]>} Array of space members
   */
  async getSpaceMembers(spaceId: string): Promise<SpaceMember[]> {
    const client = this.supabaseAdmin.getClient();

    const result = await client
      .from('space_members')
      .select('*')
      .eq('space_id', spaceId)
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (result.error) {
      this.logger.error(`Failed to get space members: ${result.error.message}`);
      throw new InternalServerErrorException('Failed to get space members');
    }

    return (result.data ?? []) as SpaceMember[];
  }

  /**
   * Returns space members with joined user/group/role details.
   *
   * @param {string} spaceId - Space UUID
   * @param {string} orgId - Caller's organization; the space must belong to it
   * @returns {Promise<SpaceMember[]>} Members with related details
   * @throws {NotFoundException} When the space does not exist in the caller's organization
   */
  async getSpaceMembersWithDetails(
    spaceId: string,
    orgId: string,
  ): Promise<SpaceMember[]> {
    // SpacePermissionsGuard admits org owners/admins without checking which org the space is in,
    // so without this an admin of one tenant could list another tenant's members (names, emails).
    // An empty orgId must not fall through to getSpaceById's unscoped lookup.
    if (!orgId) {
      throw new NotFoundException('Space not found');
    }
    await this.getSpaceById(spaceId, orgId);

    const client = this.supabaseAdmin.getClient();

    const result = await client
      .from('space_members')
      .select(
        '*, user:user_id(id, first_name, last_name, email, avatar_url), role:role_id(id, name), group:group_id(id, name)',
      )
      .eq('space_id', spaceId)
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (result.error) {
      this.logger.error(
        `Failed to get space members with details: ${result.error.message}`,
      );
      throw new InternalServerErrorException('Failed to get space members');
    }

    return (result.data ?? []) as SpaceMember[];
  }

  /**
   * Adds a member to a space. If the member already exists but is inactive,
   * reactivates them. Throws ConflictException for active duplicates.
   *
   * @param {string} spaceId - Space UUID
   * @param {string} _orgId - Organization UUID (reserved for future use)
   * @param {string} userId - User performing the action (added_by)
   * @param {CreateSpaceMemberDto} data - Member payload
   * @returns {Promise<SpaceMember>} The created or reactivated member
   * @throws {ConflictException} When the member already exists and is active
   */
  async addSpaceMember(
    spaceId: string,
    orgId: string,
    userId: string,
    data: CreateSpaceMemberDto,
  ): Promise<SpaceMember> {
    const client = this.supabaseAdmin.getClient();

    // Build duplicate check query based on member type
    let existingQuery = client
      .from('space_members')
      .select('*')
      .eq('space_id', spaceId)
      .eq('member_type', data.member_type);

    if (data.member_type === 'user' && data.user_id) {
      existingQuery = existingQuery.eq('user_id', data.user_id);
    } else if (data.member_type === 'group' && data.group_id) {
      existingQuery = existingQuery.eq('group_id', data.group_id);
    } else if (data.member_type === 'role' && data.role_id) {
      existingQuery = existingQuery.eq('role_id', data.role_id);
    }

    const existingResult = await existingQuery.maybeSingle();
    const existing = existingResult.data as SpaceMember | null;

    if (existing) {
      if (existing.is_active) {
        throw new ConflictException('Member already exists in this space');
      }

      // Reactivate inactive member
      const reactivateResult = await client
        .from('space_members')
        .update({
          is_active: true,
          space_role: data.space_role ?? existing.space_role,
          permissions: data.permissions ?? existing.permissions,
          notification_preferences:
            data.notification_preferences ?? existing.notification_preferences,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('*')
        .single();

      if (reactivateResult.error || !reactivateResult.data) {
        this.logger.error(
          `Failed to reactivate member: ${reactivateResult.error?.message ?? 'No data'}`,
        );
        throw new InternalServerErrorException('Failed to reactivate member');
      }

      const reactivated = reactivateResult.data as SpaceMember;

      // Fire outbox event for reactivation — mirrors the fresh-insert path so
      // automations triggered by app.space.member_added also fire when a previously-
      // removed member is re-added.
      void this.writeSpaceMemberOutbox(client, orgId, spaceId, reactivated);

      // Space membership changed — evict cached per-space permission results.
      this.permissionsService?.bustOrg(orgId);

      return reactivated;
    }

    // Insert new member
    const insertResult = await client
      .from('space_members')
      .insert({
        space_id: spaceId,
        member_type: data.member_type,
        user_id: data.user_id ?? null,
        group_id: data.group_id ?? null,
        role_id: data.role_id ?? null,
        space_role: data.space_role ?? 'member',
        permissions: data.permissions ?? null,
        notification_preferences: data.notification_preferences ?? null,
        added_by: userId,
        is_active: true,
      })
      .select('*')
      .single();

    if (insertResult.error || !insertResult.data) {
      this.logger.error(
        `Failed to add space member: ${insertResult.error?.message ?? 'No data returned'}`,
      );
      throw new InternalServerErrorException('Failed to add space member');
    }

    const created = insertResult.data as SpaceMember;

    // Audit log for member-add. Look up org from the space row.
    void this.auditOnMember(spaceId, userId, created.id, 'create', {
      member_type: created.member_type,
      space_role: created.space_role,
    });

    void this.writeSpaceMemberOutbox(client, orgId, spaceId, created);

    // Space membership changed — evict cached per-space permission results.
    this.permissionsService?.bustOrg(orgId);

    return created;
  }

  /**
   * Writes an `app.space.member_added` outbox event for automation triggers.
   * Shared by both the fresh-insert and reactivation paths in `addSpaceMember`
   * so neither path silently misses the event.
   *
   * User email / name are fetched best-effort so action nodes that reference
   * `{{ trigger.user.email }}` receive real data instead of empty strings.
   */
  private async writeSpaceMemberOutbox(
    client: ReturnType<SupabaseAdminService['getClient']>,
    orgId: string,
    spaceId: string,
    member: SpaceMember,
  ): Promise<void> {
    // Fetch details for payload enrichment (best-effort — do not block on failure)
    let userEmail = '';
    let userName = '';

    if (member.user_id) {
      const { data: userRow } = await client
        .from('users')
        .select('email, first_name, last_name')
        .eq('id', member.user_id)
        .maybeSingle();
      const row = userRow as { email?: string; first_name?: string | null; last_name?: string | null } | null;

      userEmail = row?.email ?? '';
      userName = `${row?.first_name ?? ''} ${row?.last_name ?? ''}`.trim();
    }
    const { data: spaceRow } = await client.from('spaces').select('name').eq('id', spaceId).maybeSingle();
    const spaceName = (spaceRow as { name?: string } | null)?.name ?? '';
    const person = { id: member.user_id, email: userEmail, name: userName };

    void this.outboxService?.write(orgId, spaceId, 'app.space.member_added', {
      user: person,
      // The onboarding template reads these two names.
      member: person,
      space: { id: spaceId, name: spaceName },
      space_id: spaceId,
      user_id: member.user_id,
      space_role: member.space_role,
      member_type: member.member_type,
    });
  }

  /**
   * Updates a space member's role. Includes a last-admin guard — refuses to
   * demote the only remaining admin/owner of a space.
   *
   * @param {string} memberId - Space member record UUID
   * @param {UpdateSpaceMemberDto} data - Fields to update
   * @param {string} [actorUserId] - Optional user performing the change (for audit)
   * @param {string} [spaceId] - Optional space the member must belong to
   * @returns {Promise<SpaceMember>} The updated member
   * @throws {BadRequestException} When the change would demote the last admin/owner
   */
  async updateSpaceMember(
    memberId: string,
    data: UpdateSpaceMemberDto,
    actorUserId?: string,
    spaceId?: string,
  ): Promise<SpaceMember> {
    const client = this.supabaseAdmin.getClient();

    // Scope the row to the space in the URL so manage_members in one space
    // cannot reach a member of another. Mirrors removeSpaceMember.
    if (spaceId) {
      const { data: scoped } = await client
        .from('space_members')
        .select('id')
        .eq('id', memberId)
        .eq('space_id', spaceId)
        .maybeSingle();

      if (!scoped) {
        throw new NotFoundException('Member not found');
      }
    }

    // Last-admin guard. Mirrors the logic in removeSpaceMember.
    if (data.space_role !== undefined) {
      const { data: existing, error: fetchError } = await client
        .from('space_members')
        .select('id, space_id, space_role, is_active, user_id')
        .eq('id', memberId)
        .maybeSingle();

      if (fetchError) {
        this.logger.error(
          `Failed to fetch space member: ${fetchError.message}`,
        );
        throw new InternalServerErrorException('Failed to fetch space member');
      }
      if (!existing) {
        throw new NotFoundException('Member not found');
      }

      // A person: the same locked rule as Robert, so two changes at once cannot both pass it.
      if (existing.user_id && existing.is_active) {
        await this.lockedMemberWrite(existing.space_id, existing.user_id, 'role', data.space_role);
        const { data: fresh } = await client.from('space_members').select('*').eq('id', memberId).single();
        const changed = fresh as SpaceMember;

        if (actorUserId) {
          void this.auditOnMember(changed.space_id, actorUserId, changed.id, 'update', {
            space_role: changed.space_role,
          });
        }

        return changed;
      }

      const wasAdmin =
        existing.space_role === 'admin' ||
        existing.space_role === 'space_admin' ||
        existing.space_role === 'owner';
      const willBeAdmin =
        data.space_role === 'admin' ||
        data.space_role === 'space_admin' ||
        data.space_role === 'owner';

      // Only check when an admin/owner is being demoted away from admin/owner.
      if (wasAdmin && !willBeAdmin && existing.is_active) {
        const { count } = await client
          .from('space_members')
          .select('*', { count: 'exact', head: true })
          .eq('space_id', existing.space_id)
          .eq('is_active', true)
          .in('space_role', ['admin', 'space_admin', 'owner']);

        if ((count ?? 0) <= 1) {
          throw new BadRequestException(
            'Cannot demote the last space admin/owner',
          );
        }
      }
    }

    const updatePayload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (data.space_role !== undefined) {
      updatePayload.space_role = data.space_role;
    }

    const result = await client
      .from('space_members')
      .update(updatePayload)
      .eq('id', memberId)
      .select('*')
      .single();

    if (result.error || !result.data) {
      this.logger.error(
        `Failed to update space member: ${result.error?.message ?? 'No data returned'}`,
      );
      throw new InternalServerErrorException('Failed to update space member');
    }

    const updated = result.data as SpaceMember;

    if (actorUserId) {
      void this.auditOnMember(
        updated.space_id,
        actorUserId,
        updated.id,
        'update',
        {
          space_role: updated.space_role,
        },
      );
    }

    return updated;
  }

  /**
   * Internal helper — fires an audit-log entry for a member-scoped action
   * after looking up the space's org. Best-effort; never throws.
   */
  private async auditOnMember(
    spaceId: string,
    actorUserId: string,
    memberId: string,
    action: 'create' | 'update' | 'delete',
    changes?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const { data: space } = await this.supabaseAdmin
        .getClient()
        .from('spaces')
        .select('organization_id')
        .eq('id', spaceId)
        .maybeSingle();

      if (!space?.organization_id) return;

      void this.auditLogsService.logAction(
        space.organization_id,
        actorUserId,
        'space_member',
        memberId,
        action,
        { space_id: spaceId, ...(changes ?? {}) },
      );
    } catch {
      /* audit best-effort */
    }
  }

  /**
   * Removes (deactivates) a space member.
   *
   * @param {string} memberId - Space member record UUID
   * @returns {Promise<SpaceMember>} The deactivated member
   */
  async removeSpaceMember(
    memberId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true }> {
    const client = this.supabaseAdmin.getClient();

    // 1. Fetch member — 404 if not found
    const memberResult = (await client
      .from('space_members')
      .select('*')
      .eq('id', memberId)
      .eq('space_id', spaceId)
      .maybeSingle()) as {
      data: SpaceMember | null;
      error: { message: string } | null;
    };

    if (memberResult.error) {
      this.logger.error(
        `Failed to fetch space member: ${memberResult.error.message}`,
      );
      throw new InternalServerErrorException('Failed to fetch space member');
    }
    if (!memberResult.data) {
      throw new NotFoundException('Member not found');
    }
    const existing = memberResult.data;

    // 2. Who stays in charge. A person: the same locked rule as Robert, which also deletes the row and
    // its permissions. A group or role row keeps its own guard and the derived cleanup below.
    if (existing.user_id && existing.is_active) {
      await this.lockedMemberWrite(spaceId, existing.user_id, 'remove', null);
      void this.auditLogsService.logAction(organizationId, userId, 'space', spaceId, 'update', {
        action: 'remove_member',
        member_id: memberId,
        member_type: existing.member_type,
      });
      this.permissionsService?.bustOrg(organizationId);
      return { success: true };
    }

    const isAdmin =
      existing.space_role === 'admin' || existing.space_role === 'space_admin';
    if (isAdmin) {
      const { count } = await client
        .from('space_members')
        .select('*', { count: 'exact', head: true })
        .eq('space_id', spaceId)
        .eq('is_active', true)
        .in('space_role', ['admin', 'space_admin']);
      if ((count ?? 0) <= 1) {
        throw new BadRequestException(
          'Cannot remove or demote the last space admin',
        );
      }
    }

    // 3. Audit log (fire-and-forget — must not block the deletion)
    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'space',
      spaceId,
      'update',
      {
        action: 'remove_member',
        member_id: memberId,
        member_type: existing.member_type,
      },
    );

    // 4. Hard delete from space_members
    const { error: deleteError } = await client
      .from('space_members')
      .delete()
      .eq('id', memberId);

    if (deleteError) {
      this.logger.error(
        `Failed to remove space member: ${deleteError.message}`,
      );
      throw new InternalServerErrorException('Failed to remove space member');
    }

    // 5. Clean up space_permissions row
    const targetId = existing.user_id || existing.group_id || existing.role_id;
    if (targetId) {
      await client
        .from('space_permissions')
        .delete()
        .eq('space_id', spaceId)
        .eq('target_type', existing.member_type)
        .eq('target_id', targetId);
    }

    // 6. Derived member cleanup for group/role types
    if (existing.member_type === 'group' && existing.group_id) {
      await this.removeDerivedUserMembers(spaceId, 'group', existing.group_id);
    }
    if (existing.member_type === 'role' && existing.role_id) {
      await this.removeDerivedUserMembers(spaceId, 'role', existing.role_id);
    }

    // Space membership changed — evict cached per-space permission results.
    this.permissionsService?.bustOrg(organizationId);

    return { success: true };
  }

  /** agent_space_member_write: locks the space's members, checks the last owner, writes. */
  private async lockedMemberWrite(
    spaceId: string,
    userId: string,
    op: 'role' | 'remove',
    role: string | null | undefined,
  ): Promise<void> {
    const client = this.supabaseAdmin.getClient();
    const { data: space } = await client.from('spaces').select('organization_id').eq('id', spaceId).maybeSingle();
    const { data, error } = await client.rpc('agent_space_member_write', {
      p_organization_id: (space as { organization_id?: string } | null)?.organization_id,
      p_space_id: spaceId,
      p_user_id: userId,
      p_op: op,
      p_role: role === 'space_admin' ? 'admin' : (role ?? null),
      p_grant: [],
      p_revoke: [],
    });
    if (error) {
      this.logger.error(`Failed to change space member: ${error.message}`);
      throw new InternalServerErrorException('Failed to change space member');
    }
    const out = data as { ok: boolean; code?: string };
    if (out.ok) return;
    if (out.code === 'last_owner') {
      throw new ConflictException({
        code: 'last_owner',
        message: 'A space must keep an owner. Make someone else the owner first.',
      });
    }
    throw new NotFoundException('Member not found');
  }

  private async removeDerivedUserMembers(
    spaceId: string,
    sourceType: 'group' | 'role',
    sourceId: string,
  ): Promise<void> {
    const client = this.supabaseAdmin.getClient();
    const trackCol =
      sourceType === 'group' ? 'added_via_group_id' : 'added_via_role_id';

    const { data: derived } = await client
      .from('space_members')
      .select('id, user_id')
      .eq('space_id', spaceId)
      .eq(trackCol, sourceId);

    if (!derived?.length) return;

    for (const member of derived) {
      await client.from('space_members').delete().eq('id', member.id);

      if (member.user_id) {
        // Only clean up permissions if the user has no remaining active membership
        const { count } = await client
          .from('space_members')
          .select('*', { count: 'exact', head: true })
          .eq('space_id', spaceId)
          .eq('user_id', member.user_id)
          .eq('is_active', true);

        if ((count ?? 0) === 0) {
          await client
            .from('space_permissions')
            .delete()
            .eq('space_id', spaceId)
            .eq('target_type', 'user')
            .eq('target_id', member.user_id);
        }
      }
    }
  }

  /**
   * Returns users who have implicit access to a space via group or role memberships.
   *
   * @param {string} spaceId - Space UUID
   * @returns {Promise<Record<string, unknown>[]>} Array of implicit access records
   */
  async getImplicitSpaceMembers(spaceId: string): Promise<string[]> {
    const client = this.supabaseAdmin.getClient();

    const result = await client
      .from('space_members')
      .select('*')
      .eq('space_id', spaceId)
      .eq('is_active', true)
      .in('member_type', ['group', 'role']);

    if (result.error) {
      this.logger.error(
        `Failed to get implicit members: ${result.error.message}`,
      );
      throw new InternalServerErrorException('Failed to get implicit members');
    }

    const members = (result.data ?? []) as Array<{
      group_id?: string | null;
      role_id?: string | null;
    }>;
    const groupIds = members
      .map((member) => member.group_id)
      .filter((id): id is string => Boolean(id));
    const roleIds = members
      .map((member) => member.role_id)
      .filter((id): id is string => Boolean(id));
    const userIds = new Set<string>();

    if (groupIds.length > 0) {
      const groupResult = await client
        .from('user_group_members')
        .select('user_id')
        .in('group_id', groupIds);

      if (groupResult.error) {
        this.logger.error(
          `Failed to get implicit group members: ${groupResult.error.message}`,
        );
        throw new InternalServerErrorException(
          'Failed to get implicit members',
        );
      }

      for (const row of (groupResult.data ?? []) as Array<{
        user_id?: string | null;
      }>) {
        if (row.user_id) userIds.add(row.user_id);
      }
    }

    if (roleIds.length > 0) {
      const roleResult = await client
        .from('user_role_assignments')
        .select('user_id')
        .in('role_id', roleIds);

      if (roleResult.error) {
        this.logger.error(
          `Failed to get implicit role members: ${roleResult.error.message}`,
        );
        throw new InternalServerErrorException(
          'Failed to get implicit members',
        );
      }

      for (const row of (roleResult.data ?? []) as Array<{
        user_id?: string | null;
      }>) {
        if (row.user_id) userIds.add(row.user_id);
      }
    }

    return Array.from(userIds);
  }

  // ── Modules ─────────────────────────────────────────────────────────────

  /**
   * Returns modules configured for a space, optionally filtering by enabled status.
   *
   * @param {string} spaceId - Space UUID
   * @param {boolean} [enabledOnly] - If true, return only enabled modules
   * @returns {Promise<SpaceModule[]>} Array of space modules sorted by sort_order
   * @author Prince Jadiya
   */
  async getSpaceModules(
    spaceId: string,
    orgIdOrEnabledOnly?: string | boolean,
    enabledOnlyArg?: boolean,
  ): Promise<SpaceModule[]> {
    const client = this.supabaseAdmin.getClient();
    const orgId =
      typeof orgIdOrEnabledOnly === 'string' ? orgIdOrEnabledOnly : undefined;
    const enabledOnly =
      typeof orgIdOrEnabledOnly === 'boolean'
        ? orgIdOrEnabledOnly
        : enabledOnlyArg;

    await this.assertSpaceInOrganization(spaceId, orgId);

    let query = client
      .from('space_modules')
      .select('*')
      .eq('space_id', spaceId);

    if (enabledOnly) {
      query = query.eq('is_enabled', true);
    }

    query = query.order('sort_order', { ascending: true });

    const result = await query;

    if (result.error) {
      this.logger.error(`Failed to get space modules: ${result.error.message}`);
      throw new InternalServerErrorException('Failed to get space modules');
    }

    return (result.data ?? []) as SpaceModule[];
  }

  /**
   * Upserts space module records (enable/disable, reorder, update settings).
   *
   * @param {string} spaceId - Space UUID
   * @param {string} _userId - User performing the update (reserved for audit)
   * @param {SpaceModuleItemDto[]} modules - Module entries to upsert
   * @returns {Promise<SpaceModule[]>} The updated modules array
   * @author Prince Jadiya
   */
  async updateSpaceModules(
    spaceId: string,
    userId: string,
    orgIdOrModules: string | SpaceModuleItemDto[],
    modulesMaybe?: SpaceModuleItemDto[],
  ): Promise<SpaceModule[]> {
    const client = this.supabaseAdmin.getClient();
    const now = new Date().toISOString();
    const orgId = Array.isArray(orgIdOrModules) ? undefined : orgIdOrModules;
    const modules = Array.isArray(orgIdOrModules)
      ? orgIdOrModules
      : modulesMaybe;

    if (!modules) {
      throw new BadRequestException('modules are required');
    }

    const space = await this.assertSpaceInOrganization(spaceId, orgId);

    // Previous rows: the licence gate below only fires on an off→on switch,
    // and the audit trail records only rows whose state actually changed.
    const previous = await client
      .from('space_modules')
      .select('module_type, is_enabled')
      .eq('space_id', spaceId);

    if (previous.error) {
      this.logger.error(
        `Failed to read space modules: ${previous.error.message}`,
      );
      throw new InternalServerErrorException('Failed to update space modules');
    }

    const wasEnabled = new Map(
      (
        (previous.data ?? []) as { module_type: string; is_enabled: boolean }[]
      ).map((row) => [row.module_type, row.is_enabled]),
    );

    // Resource Planning is licence-gated per tenant; turning it off is always
    // allowed. Fails closed when entitlements are unavailable.
    const enablesResourcePlanning = modules.some(
      (m) =>
        m.module_type === 'resource_planning' &&
        (m.is_enabled ?? true) &&
        wasEnabled.get('resource_planning') !== true,
    );
    if (enablesResourcePlanning) {
      const entitlements =
        space.organization_id && this.entitlementsService
          ? await this.entitlementsService.getEffectiveEntitlements(
              space.organization_id,
            )
          : null;

      if (!entitlements?.has('module_resource_planning')) {
        throw new ForbiddenException({
          code: 'FEATURE_NOT_ENTITLED',
          feature_key: 'module_resource_planning',
          message:
            "Cannot enable 'resource_planning': feature is not included in your license.",
        });
      }
    }

    // Calendar is licence-gated the same way; turning it off stays allowed.
    const enablesCalendar = modules.some(
      (m) =>
        m.module_type === 'calendar' &&
        (m.is_enabled ?? true) &&
        wasEnabled.get('calendar') !== true,
    );
    if (enablesCalendar) {
      const entitlements =
        space.organization_id && this.entitlementsService
          ? await this.entitlementsService.getEffectiveEntitlements(
              space.organization_id,
            )
          : null;

      if (!entitlements?.has('module_calendar')) {
        throw new ForbiddenException({
          code: 'FEATURE_NOT_ENTITLED',
          feature_key: 'module_calendar',
          message:
            "Cannot enable 'calendar': feature is not included in your license.",
        });
      }
    }

    // Test Management is licence-gated the same way; turning it off stays allowed.
    const enablesTestManagement = modules.some(
      (m) =>
        m.module_type === 'test_management' &&
        (m.is_enabled ?? true) &&
        wasEnabled.get('test_management') !== true,
    );
    if (enablesTestManagement) {
      const entitlements =
        space.organization_id && this.entitlementsService
          ? await this.entitlementsService.getEffectiveEntitlements(
              space.organization_id,
            )
          : null;

      if (!entitlements?.has('module_test_management')) {
        throw new ForbiddenException({
          code: 'FEATURE_NOT_ENTITLED',
          feature_key: 'module_test_management',
          message:
            "Cannot enable 'test_management': feature is not included in your license.",
        });
      }
    }

    const upsertPayloads = modules.map((m, index) => ({
      space_id: spaceId,
      module_type: m.module_type,
      is_enabled: m.is_enabled ?? true,
      sort_order: m.sort_order ?? index,
      settings: m.settings,
      updated_at: now,
    }));
    // An item without `settings` must keep the stored ones (the Modules tab sends none). One upsert writes
    // the same columns for every row, so rows with and without settings go in separate upserts.
    const batches = [
      upsertPayloads.filter((row) => row.settings !== undefined),
      upsertPayloads
        .filter((row) => row.settings === undefined)
        .map(({ settings: _settings, ...row }) => row),
    ].filter((batch) => batch.length);
    const savedRows: SpaceModule[] = [];

    for (const batch of batches) {
      const result = await client
        .from('space_modules')
        .upsert(batch, {
          onConflict: 'space_id,module_type',
        })
        .select('*');

      if (result.error) {
        this.logger.error(
          `Failed to update space modules: ${result.error.message}`,
        );
        throw new InternalServerErrorException(
          'Failed to update space modules',
        );
      }

      savedRows.push(...((result.data ?? []) as SpaceModule[]));
    }

    if (space.organization_id) {
      // One row per toggled module, mirroring organization_module audits.
      const changedRows = savedRows.filter(
        (row) => wasEnabled.get(row.module_type) !== row.is_enabled,
      );

      await Promise.all(
        changedRows.map((row) =>
          this.auditLogsService.createLog(space.organization_id, userId, {
            entity_type: 'space_module',
            entity_id: row.id,
            action: 'update',
            changes: {
              space_id: spaceId,
              module_type: row.module_type,
              is_enabled: row.is_enabled,
            },
          }),
        ),
      );
    }

    // Test Management brings its own task types; keep them in step with the switch.
    // Runs on every save that includes the module, so a failed earlier attempt is repaired.
    const testManagement = modules.find(
      (m) => m.module_type === 'test_management',
    );
    if (
      testManagement &&
      space.organization_id &&
      this.testManagementSettings
    ) {
      await this.testManagementSettings.syncTaskTypes(
        space.organization_id,
        spaceId,
        testManagement.is_enabled ?? true,
        userId,
      );
    }

    // Return all modules for this space sorted by sort_order
    return this.getSpaceModules(spaceId, orgId);
  }

  // ── Permissions ────────────────────────────────────────────────────────

  /**
   * Returns the effective permissions for the current user in a space.
   * Org admins/owners get full access; otherwise checks space_members role + permissions.
   *
   * @param {string} userId - User UUID
   * @param {string} spaceId - Space UUID
   * @param {string} organizationId - Organization UUID
   * @returns {Promise<Record<string, unknown>>} Effective permissions object with source info
   * @author Prince Jadiya
   */
  async getMyPermissions(
    userId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const client = this.supabaseAdmin.getClient();

    // Check if user is org admin/owner
    const orgMemberResult = await client
      .from('organization_members')
      .select('role')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    const orgRole = (orgMemberResult.data as { role: string } | null)?.role;

    if (orgRole === 'owner' || orgRole === 'admin') {
      return {
        source: 'organization_role',
        organization_role: orgRole,
        space_role: null,
        is_full_access: true,
        permissions: {},
      };
    }

    // Get space membership
    const memberResult = await client
      .from('space_members')
      .select('*')
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();

    const member = memberResult.data as SpaceMember | null;

    if (!member) {
      return {
        source: 'none',
        organization_role: orgRole ?? null,
        space_role: null,
        is_full_access: false,
        permissions: {},
      };
    }

    return {
      source: 'space_member',
      organization_role: orgRole ?? null,
      space_role: member.space_role,
      is_full_access: member.space_role === 'owner',
      permissions: member.permissions ?? {},
    };
  }

  async getUserSpacePermissions(
    userId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<{
    isMember: boolean;
    spaceRole: string | null;
    globalRole: string | null;
    permissions: Record<string, boolean>;
  }> {
    const client = this.supabaseAdmin.getClient();
    await this.assertSpaceInOrganization(spaceId, organizationId);

    // 1. Org role
    const { data: orgMember } = await client
      .from('organization_members')
      .select('role')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    const globalRole = (orgMember as { role: string } | null)?.role ?? null;

    // 2. Org owner/admin → full access from base role
    if (globalRole === 'owner' || globalRole === 'admin') {
      const roleKey = globalRole === 'owner' ? 'owner' : 'admin';
      return {
        isMember: true,
        spaceRole: roleKey,
        globalRole,
        permissions: normalizeSpacePermissions({
          ...SPACE_ROLE_BASE_PERMISSIONS[roleKey],
        }),
      };
    }

    // 3. Direct space membership
    const { data: member } = await client
      .from('space_members')
      .select('space_role, permissions')
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();

    if (!member) {
      return { isMember: false, spaceRole: null, globalRole, permissions: {} };
    }

    const spaceRole = (member as { space_role: string | null }).space_role;
    const roleKey = this.resolveRoleKey(spaceRole);

    // 4. Start with base permissions
    const base: Record<string, boolean> = {
      ...SPACE_ROLE_BASE_PERMISSIONS[roleKey],
    };

    // 5. Apply space_permissions table overrides (can_ columns)
    const { data: spacePerms } = await client
      .from('space_permissions')
      .select('*')
      .eq('space_id', spaceId)
      .or(
        `and(target_type.eq.user,target_id.eq.${userId}),and(target_type.eq.base_role,target_id.eq.${roleKey})`,
      );

    for (const row of (spacePerms ?? []) as Record<string, unknown>[]) {
      for (const [col, val] of Object.entries(row)) {
        if (col.startsWith('can_') && typeof val === 'boolean') {
          base[col.slice(4)] = val;
        }
      }
    }

    //  Apply space_module_permissions overrides (the module CRUD matrix).
    //     Without this, module toggles saved in Space Settings never reach the
    //     effective permissions this endpoint returns, so per-role module
    //     overrides silently do nothing (and the identical body triggers 304s).
    //     Keys are stored can_-prefixed; strip it to match flat perm keys.
    //     base_role rows are applied before user rows so a user-specific
    //     override wins over the role default.
    const { data: modulePerms } = await client
      .from('space_module_permissions')
      .select('target_type, target_id, permissions')
      .eq('space_id', spaceId)
      .or(
        `and(target_type.eq.user,target_id.eq.${userId}),and(target_type.eq.base_role,target_id.eq.${roleKey})`,
      );

    const orderedModulePerms = (
      (modulePerms ?? []) as {
        target_type: string;
        target_id: string | null;
        permissions: Record<string, unknown> | null;
      }[]
    ).sort((a, b) =>
      a.target_type === b.target_type
        ? 0
        : a.target_type === 'base_role'
          ? -1
          : 1,
    );

    for (const row of orderedModulePerms) {
      if (!row.permissions) continue;
      for (const [key, val] of Object.entries(row.permissions)) {
        if (typeof val === 'boolean') {
          base[key.startsWith('can_') ? key.slice(4) : key] = val;
        }
      }
    }

    // 6. Merge member-level permissions column
    const memberPerms = (
      member as { permissions: Record<string, boolean> | null }
    ).permissions;
    if (memberPerms) {
      for (const [k, v] of Object.entries(memberPerms)) {
        if (typeof v === 'boolean') base[k] = v;
      }
    }

    // Same org-level grants SpacePermissionsGuard accepts.
    for (const [spaceKey, orgKey] of Object.entries(
      ORG_GRANTED_SPACE_PERMISSIONS,
    )) {
      if (
        base[spaceKey] !== true &&
        (await this.permissionsService?.checkPermission(
          userId,
          organizationId,
          orgKey,
        ))
      ) {
        base[spaceKey] = true;
      }
    }

    // Test Management keys come from the same per-space decision the API makes.
    if (this.permissionsService) {
      try {
        Object.assign(
          base,
          (
            await this.permissionsService.resolveTestManagementPermissions(
              userId,
              organizationId,
              spaceId,
            )
          ).permissions,
        );
      } catch (error) {
        this.logger.warn(
          `Test Management permissions not resolved for space ${spaceId}: ${(error as Error).message}`,
        );

        for (const key of TEST_MANAGEMENT_PERMISSION_KEYS) base[key] = false;
      }
    }

    return {
      isMember: true,
      spaceRole,
      globalRole,
      permissions: normalizeSpacePermissions(base),
    };
  }

  private resolveRoleKey(spaceRole: string | null | undefined): string {
    if (!spaceRole) return 'viewer';
    if (spaceRole === 'owner') return 'owner';
    if (spaceRole === 'admin' || spaceRole === 'space_admin') return 'admin';
    if (spaceRole === 'member') return 'member';
    return 'viewer';
  }

  private async assertSpaceInOrganization(
    spaceId: string,
    orgId?: string,
  ): Promise<Space> {
    if (!orgId) {
      return { id: spaceId, organization_id: '' } as Space;
    }

    return this.getSpaceById(spaceId, orgId);
  }

  // ── Space Invitations ──────────────────────────────────────────────────

  /**
   * Returns pending invitations for a space.
   *
   * @param {string} spaceId - Space UUID
   * @returns {Promise<SpaceInvitation[]>} Array of pending invitations
   * @author Prince Jadiya
   */
  async getSpaceInvitations(spaceId: string): Promise<SpaceInvitation[]> {
    const client = this.supabaseAdmin.getClient();

    const result = await client
      .from('invitations')
      .select('*')
      .eq('space_id', spaceId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (result.error) {
      this.logger.error(
        `Failed to get space invitations: ${result.error.message}`,
      );
      throw new InternalServerErrorException('Failed to get space invitations');
    }

    return (result.data ?? []) as SpaceInvitation[];
  }

  /**
   * Bulk-invites users to a space. For each user: validates existence, org membership,
   * no existing space membership, and no pending invite. Creates invitation records.
   *
   * @param {string} spaceId - Space UUID
   * @param {string} orgId - Organization UUID
   * @param {string} invitedBy - User UUID of the inviter
   * @param {SpaceInvitationUserDto[]} users - Users to invite
   * @returns {Promise<{ created: Record<string, unknown>[]; errors: Record<string, unknown>[] }>}
   * @author Prince Jadiya
   */
  async createSpaceInvitations(
    spaceId: string,
    orgId: string,
    invitedBy: string,
    users: SpaceInvitationUserDto[],
  ): Promise<{
    created: Record<string, unknown>[];
    errors: Record<string, unknown>[];
  }> {
    const client = this.supabaseAdmin.getClient();
    const created: Record<string, unknown>[] = [];
    const errors: Record<string, unknown>[] = [];

    // Dedup user_ids
    const uniqueUserIds = [...new Set(users.map((u) => u.user_id))];
    const dedupedUsers = uniqueUserIds.map(
      (uid) => users.find((u) => u.user_id === uid)!,
    );

    // Check space is not archived + fetch space name
    const spaceResult = await client
      .from('spaces')
      .select('is_archived, name, key')
      .eq('id', spaceId)
      .single();
    if (
      spaceResult.data &&
      (spaceResult.data as { is_archived: boolean }).is_archived
    ) {
      throw new BadRequestException('Cannot invite to an archived space');
    }
    const spaceName =
      (spaceResult.data as { name?: string } | null)?.name ?? 'this space';
    const spaceKey = (spaceResult.data as { key?: string } | null)?.key ?? null;

    // Fetch org name and inviter name once for email sending
    const [orgResult, inviterResult] = await Promise.all([
      client.from('organizations').select('name').eq('id', orgId).maybeSingle(),
      client
        .from('users')
        .select('first_name, last_name')
        .eq('id', invitedBy)
        .maybeSingle(),
    ]);
    const organizationName =
      (orgResult.data as { name?: string } | null)?.name ?? 'the organization';
    const inviterData = inviterResult.data as {
      first_name?: string;
      last_name?: string;
    } | null;
    const inviterName = inviterData
      ? `${inviterData.first_name ?? ''} ${inviterData.last_name ?? ''}`.trim()
      : 'A team member';
    const frontendUrl = (
      process.env.AUTH_URL ||
      process.env.FRONTEND_URL ||
      'http://localhost:3000'
    ).replace(/\/$/, '');

    for (const userEntry of dedupedUsers) {
      try {
        // Self-invite check
        if (userEntry.user_id === invitedBy) {
          errors.push({
            user_id: userEntry.user_id,
            reason: 'cannot_invite_self',
          });
          continue;
        }

        // Validate user exists.
        // Org membership is tracked in organization_members, not users.organization_id.
        // Read the user row for identity and active-state only; perform a
        // separate organization_members lookup for the membership check below.
        const userResult = await client
          .from('users')
          .select('id, email, first_name, last_name, is_active')
          .eq('id', userEntry.user_id)
          .maybeSingle();

        const userData = userResult.data as {
          id: string;
          email: string;
          first_name: string;
          last_name: string;
          is_active: boolean;
        } | null;

        if (!userData) {
          errors.push({
            user_id: userEntry.user_id,
            reason: 'User not found',
          });
          continue;
        }

        // Check user is active
        if (userData.is_active === false) {
          errors.push({
            user_id: userEntry.user_id,
            reason: 'user_not_active',
          });
          continue;
        }

        // Validate user is org member via organization_members table
        const orgMembershipResult = await client
          .from('organization_members')
          .select('id')
          .eq('organization_id', orgId)
          .eq('user_id', userEntry.user_id)
          .maybeSingle();

        if (!orgMembershipResult.data) {
          errors.push({
            user_id: userEntry.user_id,
            reason: 'User is not a member of this organization',
          });
          continue;
        }

        // Check not already a space member
        const existingMemberResult = await client
          .from('space_members')
          .select('id')
          .eq('space_id', spaceId)
          .eq('user_id', userEntry.user_id)
          .eq('is_active', true)
          .maybeSingle();

        if (existingMemberResult.data) {
          errors.push({
            user_id: userEntry.user_id,
            reason: 'User is already a member of this space',
          });
          continue;
        }

        // Check implicit access via group/role-based membership
        const implicitMemberResult = await client
          .from('space_members')
          .select('id, member_type, group_id, role_id')
          .eq('space_id', spaceId)
          .eq('is_active', true)
          .in('member_type', ['group', 'role']);

        if (implicitMemberResult.data && implicitMemberResult.data.length > 0) {
          // Check if user belongs to any group or role that grants implicit access
          let hasImplicit = false;

          for (const implicitMember of implicitMemberResult.data as {
            id: string;
            member_type: string;
            group_id?: string;
            role_id?: string;
          }[]) {
            if (
              implicitMember.member_type === 'group' &&
              implicitMember.group_id
            ) {
              const groupCheck = await client
                .from('group_members')
                .select('id')
                .eq('group_id', implicitMember.group_id)
                .eq('user_id', userEntry.user_id)
                .maybeSingle();
              if (groupCheck.data) {
                hasImplicit = true;
                break;
              }
            }
            if (
              implicitMember.member_type === 'role' &&
              implicitMember.role_id
            ) {
              const roleCheck = await client
                .from('user_role_assignments')
                .select('id')
                .eq('role_id', implicitMember.role_id)
                .eq('user_id', userEntry.user_id)
                .maybeSingle();
              if (roleCheck.data) {
                hasImplicit = true;
                break;
              }
            }
          }

          if (hasImplicit) {
            errors.push({
              user_id: userEntry.user_id,
              reason: 'User already has implicit access to this space',
            });
            continue;
          }
        }

        // Check no pending invite
        const existingInviteResult = await client
          .from('invitations')
          .select('id')
          .eq('space_id', spaceId)
          .eq('email', userData.email)
          .eq('status', 'pending')
          .maybeSingle();

        if (existingInviteResult.data) {
          errors.push({
            user_id: userEntry.user_id,
            reason: 'User already has a pending invitation to this space',
          });
          continue;
        }

        // Seat limit (licensing audit D1): a space invite for someone who is
        // not yet an active org member makes them a member on acceptance, so
        // it takes a seat now (pending invites count as seats).
        const seatError = await this.seatErrorForNewMember(
          client,
          orgId,
          userEntry.user_id,
        );
        if (seatError) {
          errors.push({ user_id: userEntry.user_id, reason: seatError });
          continue;
        }

        // Create invitation
        const token = randomBytes(32).toString('hex');
        const insertResult = await client
          .from('invitations')
          .insert({
            organization_id: orgId,
            invited_by: invitedBy,
            email: userData.email,
            role: 'member',
            first_name: userData.first_name ?? '',
            last_name: userData.last_name ?? '',
            token,
            status: 'pending',
            space_id: spaceId,
            space_role: userEntry.space_role,
            space_permissions: userEntry.space_permissions || {},
            custom_role_id: userEntry.custom_role_id ?? null,
            expires_at: new Date(
              Date.now() + 7 * 24 * 60 * 60 * 1000,
            ).toISOString(),
          })
          .select('*')
          .single();

        if (insertResult.error || !insertResult.data) {
          errors.push({
            user_id: userEntry.user_id,
            reason: `Failed to create invitation: ${insertResult.error?.message ?? 'Unknown error'}`,
          });
          continue;
        }

        const invitation = insertResult.data as Record<string, unknown>;
        created.push({
          user_id: userEntry.user_id,
          invitation_id: invitation.id,
          email: userData.email,
        });

        // Fire automation event for space-level invite so automations with
        // the "User invited" trigger (app.user.invited) fire for this space.
        void this.outboxService?.write(orgId, spaceId, 'app.user.invited', {
          user: {
            id: userEntry.user_id,
            email: userData.email,
            name: `${userData.first_name ?? ''} ${userData.last_name ?? ''}`.trim(),
          },
          email: userData.email,
          emailDomain: userData.email.split('@')[1] ?? '',
          role: userEntry.space_role ?? 'member',
          organization_id: orgId,
          invitation_id: invitation.id as string,
          space_id: spaceId,
        });

        // Create in-app notification so the invitee sees the bell prompt
        const notificationResult = (await client
          .from('notifications')
          .insert({
            organization_id: orgId,
            user_id: userEntry.user_id,
            type: 'space_invitation',
            title: `You've been invited to ${spaceName}`,
            body: `${inviterName} invited you to join "${spaceName}" as ${userEntry.space_role ?? 'member'}.`,
            is_read: false,
            action_status: 'pending',
            reference_type: 'invitation',
            reference_id: invitation.id as string,
            metadata: {
              space_id: spaceId,
              space_key: spaceKey,
              space_name: spaceName,
              invited_by: invitedBy,
              space_role: userEntry.space_role ?? 'member',
            },
          })
          .select()
          .single()) as {
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        };
        const { data: notifRow, error: notifErr } = notificationResult;

        if (notifErr) {
          this.logger.error(
            `Failed to create invitation notification: ${notifErr.message}`,
          );
        } else if (notifRow) {
          void this.notificationsBroadcast?.broadcastNotification(notifRow);
        }

        // Send invitation email (fire-and-forget), gated by the invitee's
        // per-type Email preference.
        void this.maybeSendSpaceInvitationEmail(
          userData.email,
          userEntry.user_id,
          orgId,
          {
            invitationLink: `${frontendUrl}/auth/accept-invitation?token=${token}`,
            organizationName,
            spaceName,
            firstName: userData.first_name ?? '',
            spaceRole: userEntry.space_role ?? 'member',
            inviterName,
            expiresAt: invitation.expires_at as string,
          },
        );
      } catch (e) {
        errors.push({
          user_id: userEntry.user_id,
          reason: `Unexpected error: ${(e as Error).message}`,
        });
      }
    }

    void this.auditLogsService.logAction(
      orgId,
      invitedBy,
      'space_invitation',
      spaceId,
      'create',
      { created_count: created.length, error_count: errors.length },
    );

    return { created, errors };
  }

  /**
   * Resends a space invitation by generating a new token and extending the expiry.
   *
   * @param {string} spaceId - Space UUID
   * @param {string} invitationId - Invitation UUID
   * @param {string} orgId - Organization UUID (for ownership verification)
   * @returns {Promise<SpaceInvitation>} The updated invitation
   * @throws {NotFoundException} When invitation not found
   * @throws {BadRequestException} When invitation does not belong to this space or is not pending
   * @author Prince Jadiya
   */
  async resendSpaceInvitation(
    spaceId: string,
    invitationId: string,
    orgId: string,
  ): Promise<SpaceInvitation> {
    const client = this.supabaseAdmin.getClient();

    // 1. Fetch existing invitation
    const fetchResult = (await client
      .from('invitations')
      .select('*')
      .eq('id', invitationId)
      .single()) as {
      data: SpaceInvitation | null;
      error: { message: string } | null;
    };

    if (fetchResult.error || !fetchResult.data) {
      throw new NotFoundException('Invitation not found');
    }

    const existing = fetchResult.data;

    // 2. Validate ownership and state
    if (existing.space_id !== spaceId) {
      throw new BadRequestException('Invitation does not belong to this space');
    }

    if (existing.organization_id !== orgId) {
      throw new ForbiddenException(
        'Cannot resend invitation from another organization',
      );
    }

    if (existing.status === 'accepted') {
      throw new BadRequestException('Cannot resend an accepted invitation');
    }

    if (existing.status !== 'pending') {
      throw new BadRequestException('Invitation is not pending');
    }

    // 3. Revoke the old invitation
    await client
      .from('invitations')
      .update({ status: 'revoked' })
      .eq('id', invitationId);

    // 4. Revoke any other pending invitations for the same email + space.
    // Space invitees are existing organization users, so resending must never
    // delete their Supabase Auth account.
    const { data: duplicates } = await client
      .from('invitations')
      .select('id')
      .eq('email', existing.email)
      .eq('space_id', spaceId)
      .eq('status', 'pending');

    if (duplicates && duplicates.length > 0) {
      const duplicateIds = (duplicates as { id: string }[]).map((r) => r.id);
      await client
        .from('invitations')
        .update({ status: 'revoked' })
        .in('id', duplicateIds);
    }

    // 5. Create new invitation with fresh token and expiry
    const newToken = randomBytes(32).toString('hex');
    const newExpiry = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const insertResult = (await client
      .from('invitations')
      .insert({
        organization_id: existing.organization_id,
        invited_by: existing.invited_by,
        email: existing.email,
        role: existing.role,
        first_name: existing.first_name,
        last_name: existing.last_name,
        token: newToken,
        status: 'pending',
        space_id: existing.space_id,
        space_role: existing.space_role,
        space_permissions: existing.space_permissions,
        custom_role_id: existing.custom_role_id,
        expires_at: newExpiry,
      })
      .select('*')
      .single()) as {
      data: SpaceInvitation | null;
      error: { message: string } | null;
    };

    if (insertResult.error || !insertResult.data) {
      this.logger.error(
        `Failed to resend invitation: ${insertResult.error?.message ?? 'No data'}`,
      );
      throw new InternalServerErrorException('Failed to resend invitation');
    }

    const newInv = insertResult.data;

    const [orgResult, spaceResult, inviterResult] = await Promise.all([
      client
        .from('organizations')
        .select('name')
        .eq('id', newInv.organization_id)
        .maybeSingle(),
      client.from('spaces').select('name').eq('id', spaceId).maybeSingle(),
      client
        .from('users')
        .select('first_name, last_name')
        .eq('id', newInv.invited_by)
        .maybeSingle(),
    ]);

    const organizationName =
      (orgResult.data as { name?: string } | null)?.name ?? 'the organization';
    const spaceName =
      (spaceResult.data as { name?: string } | null)?.name ?? 'this space';
    const inviterData = inviterResult.data as {
      first_name?: string | null;
      last_name?: string | null;
    } | null;
    const inviterName = inviterData
      ? `${inviterData.first_name ?? ''} ${inviterData.last_name ?? ''}`.trim()
      : 'A team member';
    const frontendUrl = (
      process.env.AUTH_URL ||
      process.env.FRONTEND_URL ||
      'http://localhost:3000'
    ).replace(/\/$/, '');

    // Resolve the invitee so the resend email honours their Email preference.
    const { data: inviteeRow } = await client
      .from('users')
      .select('id')
      .eq('email', newInv.email)
      .maybeSingle();
    const inviteeUserId = (inviteeRow as { id?: string } | null)?.id ?? null;

    void this.maybeSendSpaceInvitationEmail(
      newInv.email,
      inviteeUserId,
      newInv.organization_id,
      {
        invitationLink: `${frontendUrl}/auth/accept-invitation?token=${newInv.token}`,
        organizationName,
        spaceName,
        firstName: newInv.first_name ?? '',
        spaceRole: newInv.space_role ?? 'member',
        inviterName: inviterName || 'A team member',
        expiresAt: newInv.expires_at,
      },
    );

    // Re-point the existing notification at the new invitation so the bell
    // prompt resolves correctly. If none exists yet, create it.
    const { data: existingNotif } = await client
      .from('notifications')
      .select('id')
      .eq('reference_type', 'invitation')
      .eq('reference_id', invitationId)
      .maybeSingle();

    if (existingNotif) {
      await client
        .from('notifications')
        .update({
          reference_id: newInv.id,
          action_status: 'pending',
          is_read: false,
        })
        .eq('id', (existingNotif as { id: string }).id);
    } else {
      // Notification was never created (e.g., invitation predates this fix) — create it now
      const { data: invitedUser } = await client
        .from('users')
        .select('id')
        .eq('email', newInv.email)
        .maybeSingle();

      if (invitedUser) {
        const { data: inviteNotif } = (await client
          .from('notifications')
          .insert({
            organization_id: newInv.organization_id,
            user_id: (invitedUser as { id: string }).id,
            type: 'space_invitation',
            title: `You've been invited to a space`,
            body: `You have a pending space invitation.`,
            is_read: false,
            action_status: 'pending',
            reference_type: 'invitation',
            reference_id: newInv.id,
            metadata: { space_id: newInv.space_id },
          })
          .select()
          .maybeSingle()) as {
          data: Record<string, unknown> | null;
          error: unknown;
        };

        if (inviteNotif) {
          void this.notificationsBroadcast?.broadcastNotification(inviteNotif);
        }
      }
    }

    void this.auditLogsService.logAction(
      orgId,
      newInv.invited_by ?? '',
      'space_invitation',
      newInv.id,
      'update',
      {
        action: 'resend',
        space_id: spaceId,
        original_invitation_id: invitationId,
      },
    );

    return newInv;
  }

  /**
   * Revokes a space invitation by setting its status to 'revoked'.
   *
   * @param {string} spaceId - Space UUID
   * @param {string} invitationId - Invitation UUID
   * @returns {Promise<SpaceInvitation>} The revoked invitation
   * @throws {NotFoundException} When invitation not found
   * @throws {BadRequestException} When invitation does not belong to this space
   * @author Prince Jadiya
   */
  async revokeSpaceInvitation(
    spaceId: string,
    invitationId: string,
    actorUserId?: string,
  ): Promise<SpaceInvitation> {
    const client = this.supabaseAdmin.getClient();

    const fetchResult = await client
      .from('invitations')
      .select('*')
      .eq('id', invitationId)
      .single();

    const invitation = fetchResult.data as SpaceInvitation | null;

    if (fetchResult.error || !invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.space_id !== spaceId) {
      throw new BadRequestException('Invitation does not belong to this space');
    }

    const updateResult = await client
      .from('invitations')
      .update({ status: 'revoked' })
      .eq('id', invitationId)
      .select('*')
      .single();

    if (updateResult.error || !updateResult.data) {
      this.logger.error(
        `Failed to revoke invitation: ${updateResult.error?.message ?? 'No data'}`,
      );
      throw new InternalServerErrorException('Failed to revoke invitation');
    }

    const revoked = updateResult.data as SpaceInvitation;

    await client
      .from('notifications')
      .update({ action_status: 'dismissed' })
      .eq('reference_type', 'invitation')
      .eq('reference_id', invitationId);

    if (actorUserId) {
      void this.auditLogsService.logAction(
        revoked.organization_id,
        actorUserId,
        'space_invitation',
        revoked.id,
        'delete',
        { space_id: spaceId, action: 'revoke' },
      );
    }

    return revoked;
  }

  /**
   * Accepts a space invitation: validates ownership, adds user as space member,
   * and marks the invitation as accepted.
   *
   * @param {string} spaceId - Space UUID
   * @param {string} invitationId - Invitation UUID
   * @param {string} userId - Accepting user's UUID
   * @param {string} userEmail - Accepting user's email (must match invitation email)
   * @returns {Promise<{ success: boolean; member: SpaceMember }>}
   * @throws {NotFoundException} When invitation not found
   * @throws {BadRequestException} When invitation is invalid, expired, or email mismatch
   * @throws {ForbiddenException} When user's email does not match invitation email
   * @author Prince Jadiya
   */
  /**
   * Null when adding `userId` to the org needs no new seat (already an active
   * member) or a seat is available; otherwise the LIMIT_EXCEEDED message.
   */
  private async seatErrorForNewMember(
    client: ReturnType<SupabaseAdminService['getClient']>,
    orgId: string,
    userId: string,
  ): Promise<string | null> {
    if (!this.entitlementsService) return null;

    const { data: member } = await client
      .from('organization_members')
      .select('id, users!inner(is_active)')
      .eq('organization_id', orgId)
      .eq('user_id', userId)
      .eq('users.is_active', true)
      .maybeSingle();

    if (member) return null;

    try {
      await this.entitlementsService.assertSeatAvailable(orgId);

      return null;
    } catch (err) {
      if (err instanceof ForbiddenException) return err.message;
      throw err;
    }
  }

  async acceptSpaceInvitation(
    spaceId: string,
    invitationId: string,
    userId: string,
    userEmail: string,
  ): Promise<{ success: true; message: string }> {
    const client = this.supabaseAdmin.getClient();

    const fetchResult = await client
      .from('invitations')
      .select('*')
      .eq('id', invitationId)
      .single();

    const invitation = fetchResult.data as SpaceInvitation | null;

    if (fetchResult.error || !invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.space_id !== spaceId) {
      throw new BadRequestException('Invitation does not belong to this space');
    }

    if (invitation.status !== 'pending') {
      throw new BadRequestException('Invitation is no longer pending');
    }

    // Check expiry
    if (new Date(invitation.expires_at) < new Date()) {
      await client
        .from('invitations')
        .update({ status: 'expired' })
        .eq('id', invitationId);
      throw new BadRequestException('Invitation has expired');
    }

    // Verify email matches
    if (invitation.email.toLowerCase() !== userEmail.toLowerCase()) {
      throw new ForbiddenException(
        'This invitation is for a different email address',
      );
    }

    const userUpdate = await client
      .from('users')
      .update({ is_active: true })
      .eq('id', userId);

    if (userUpdate.error) {
      this.logger.error(
        `Failed to update user organization on space invite accept: ${userUpdate.error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to update user organization',
      );
    }

    const orgMember = await client.from('organization_members').upsert(
      {
        organization_id: invitation.organization_id,
        user_id: userId,
        role: invitation.role || 'member',
      },
      { onConflict: 'organization_id,user_id' },
    );

    if (orgMember.error) {
      this.logger.error(
        `Failed to upsert organization membership on space invite accept: ${orgMember.error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to add organization membership',
      );
    }

    // Check not already a member
    const existingMemberResult = await client
      .from('space_members')
      .select('id')
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();

    if (existingMemberResult.data) {
      throw new BadRequestException('You are already a member of this space');
    }

    // Add as space member
    const memberResult = await client
      .from('space_members')
      .insert({
        space_id: spaceId,
        member_type: 'user',
        user_id: userId,
        space_role: invitation.space_role || 'member',
        permissions: invitation.space_permissions ?? null,
        is_active: true,
        added_by: invitation.invited_by,
      })
      .select('*')
      .single();

    if (memberResult.error || !memberResult.data) {
      this.logger.error(
        `Failed to add space member on accept: ${memberResult.error?.message ?? 'No data'}`,
      );
      throw new InternalServerErrorException(
        'Failed to create space membership',
      );
    }

    // Upsert space_permissions if invitation has space_permissions
    const permsObj = invitation.space_permissions;
    if (permsObj && Object.keys(permsObj).length > 0) {
      const rawPerms: Record<string, boolean> = {};

      // Seed the File Explorer keys from the invitee's base space role first, so an
      // invitation payload that predates the module (or simply omits those keys) does
      // not write a row whose DEFAULT-false columns contradict the role. Explicit
      // values from the invitation still overwrite these below.
      const baseRolePerms =
        SPACE_ROLE_BASE_PERMISSIONS[invitation.space_role || 'member'] ?? {};

      for (const key of FILE_EXPLORER_PERMISSION_KEYS) {
        rawPerms[key] = baseRolePerms[key] === true;
      }

      for (const [key, value] of Object.entries(permsObj)) {
        if (typeof value !== 'boolean') continue;
        const flatKey = key.startsWith('can_') ? key.slice(4) : key;
        if (SPACE_PERMISSION_COLUMN_KEYS.has(flatKey))
          rawPerms[flatKey] = value;
      }
      const normalized = normalizeSpacePermissions(rawPerms);
      const permData: Record<string, unknown> = {
        space_id: spaceId,
        target_type: 'user',
        target_id: userId,
      };
      for (const [key, value] of Object.entries(normalized)) {
        if (SPACE_PERMISSION_COLUMN_KEYS.has(key))
          permData[`can_${key}`] = value;
      }

      const existingPerm = await client
        .from('space_permissions')
        .select('id')
        .eq('space_id', spaceId)
        .eq('target_type', 'user')
        .eq('target_id', userId)
        .maybeSingle();
      if (existingPerm.data) {
        await client
          .from('space_permissions')
          .update(permData)
          .eq('id', (existingPerm.data as { id: string }).id);
      } else {
        await client.from('space_permissions').insert(permData);
      }
    }

    // Assign custom role if present on invitation (upsert to avoid duplicates)
    if (invitation.custom_role_id) {
      try {
        await client.from('user_role_assignments').upsert(
          {
            organization_id: invitation.organization_id,
            user_id: userId,
            role_id: invitation.custom_role_id,
          },
          { onConflict: 'organization_id,user_id,role_id' },
        );
      } catch (e) {
        this.logger.error(
          `Failed to assign custom role: ${(e as Error).message}`,
        );
      }
    }

    // Mark invitation as accepted
    await client
      .from('invitations')
      .update({
        status: 'accepted',
        accepted_at: new Date().toISOString(),
      })
      .eq('id', invitationId);

    // Sync notification status
    try {
      const notifResult = await client
        .from('notifications')
        .select('id')
        .eq('reference_type', 'invitation')
        .eq('reference_id', invitationId)
        .maybeSingle();
      if (notifResult.data) {
        await client
          .from('notifications')
          .update({ action_status: 'accepted' })
          .eq('id', (notifResult.data as { id: string }).id);
      }
    } catch (e) {
      this.logger.warn('Failed to sync notification status:', e);
    }

    void this.auditLogsService.logAction(
      invitation.organization_id,
      userId,
      'space_invitation',
      invitationId,
      'update',
      { space_id: spaceId, action: 'accept', accepted_by_email: userEmail },
    );

    return { success: true, message: 'Invitation accepted' };
  }

  // ── Module Permission Overrides ─────────────────────────────────────────

  /**
   * Lists every space_module_permissions row for a space.
   *
   * @param {string} spaceId - Space UUID
   * @returns {Promise<Record<string, unknown>[]>} Override rows
   */
  async listModulePermissions(
    spaceId: string,
    orgId?: string,
  ): Promise<Record<string, unknown>[]> {
    const client = this.supabaseAdmin.getClient();
    await this.assertSpaceInOrganization(spaceId, orgId);

    const { data, error } = await client
      .from('space_module_permissions')
      .select('*')
      .eq('space_id', spaceId);

    if (error) {
      this.logger.error(`Failed to list module permissions: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to list module permissions',
      );
    }

    return (data ?? []) as Record<string, unknown>[];
  }

  /**
   * Bulk-upserts module permission overrides for a space.
   *
   * Body shape mirrors the legacy Next.js endpoint:
   * `{ "<targetType>:<targetId>": { <permKey>: bool|null, ... }, ... }`.
   *
   * Behavior:
   *   - `value === null` deletes the key from JSONB (fall back to global).
   *   - When the resulting JSONB has no keys, the row is deleted entirely.
   *   - Unknown `permKey` values (not in `MODULE_PERMISSION_KEYS_SET`) are
   *     silently ignored — defense-in-depth against the JSONB column being
   *     used as a generic dump.
   *
   * @param {string} spaceId - Space UUID
   * @param {Record<string, Record<string, boolean | null>>} overrides - Bulk overrides
   * @param {string} actorUserId - Acting user (for audit)
   * @returns {Promise<number>} Number of `(target_type, target_id)` pairs touched
   */
  async saveModulePermissions(
    spaceId: string,
    overrides: Record<string, Record<string, boolean | null>>,
    actorUserId: string,
    orgId?: string,
  ): Promise<number> {
    const client = this.supabaseAdmin.getClient();
    await this.assertSpaceInOrganization(spaceId, orgId);
    let touched = 0;

    for (const [targetKey, permChanges] of Object.entries(overrides)) {
      if (!permChanges || typeof permChanges !== 'object') continue;

      const [targetType, ...targetIdParts] = targetKey.split(':');
      const targetId = targetIdParts.join(':');

      if (!targetType || !targetId) continue;
      if (!ALLOWED_TARGET_TYPES_SET.has(targetType)) continue;

      // Fetch existing row so we can merge (the JSONB column accumulates).
      const existingPermRow = (await client
        .from('space_module_permissions')
        .select('*')
        .eq('space_id', spaceId)
        .eq('target_type', targetType)
        .eq('target_id', targetId)
        .maybeSingle()) as {
        data: { permissions: Record<string, boolean> } | null;
        error: { message: string } | null;
      };

      const currentPerms: Record<string, boolean> = existingPermRow.data
        ?.permissions
        ? { ...existingPermRow.data.permissions }
        : {};

      for (const [key, value] of Object.entries(permChanges)) {
        if (!MODULE_PERMISSION_KEYS_SET.has(key)) continue;
        if (value === null) {
          delete currentPerms[key];
        } else if (typeof value === 'boolean') {
          currentPerms[key] = value;
        }
      }

      if (Object.keys(currentPerms).length === 0 && existingPermRow.data) {
        // No keys remaining — delete the row entirely so the global default applies.
        await client
          .from('space_module_permissions')
          .delete()
          .eq('space_id', spaceId)
          .eq('target_type', targetType)
          .eq('target_id', targetId);
      } else if (Object.keys(currentPerms).length > 0) {
        await client.from('space_module_permissions').upsert(
          {
            space_id: spaceId,
            target_type: targetType,
            target_id: targetId,
            permissions: currentPerms,
          },
          { onConflict: 'space_id,target_type,target_id' },
        );
      }

      touched++;
    }

    // Saved overrides apply on the next request instead of after the permission cache expires.
    if (orgId) this.permissionsService?.bustOrg(orgId);

    void this.auditOnMember(spaceId, actorUserId, spaceId, 'update', {
      action: 'save_module_permissions',
      touched,
    });

    return touched;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Generates a unique space key from the space name.
   * Takes the first 6 alphanumeric characters uppercased. Falls back to a random 4-char hex string.
   *
   * @param {string} name - Space name
   * @returns {string} 2-8 character uppercase key
   */
  private generateKey(name: string): string {
    const base = name
      .replace(/[^a-zA-Z0-9]/g, '')
      .substring(0, 6)
      .toUpperCase();
    if (base.length >= 2) return base;
    // Fallback: random 4-char key
    return randomBytes(2).toString('hex').toUpperCase().substring(0, 4);
  }
}
