/**
 * @fileoverview Wiki page-level permission service (Wiki 2.0 model).
 *
 * Permission model (open-by-default + restriction levels):
 *  - Space admins / org admins-owners always have FULL access ('admin').
 *  - The page creator has FULL access ('creator'), capped by the space baseline.
 *  - With NO permission rows anywhere on the page or its ancestor chain, the
 *    user's SPACE-LEVEL wiki permissions apply ('space_default') — this is the
 *    open-by-default flip from the legacy closed-by-default model.
 *  - The GOVERNING level is the nearest level (page first, then ancestors
 *    nearest → root) that has ANY permission rows. Rows at the governing level
 *    fully decide the outcome:
 *      · no entry matches the user → DENY all ('restricted_no_match')
 *      · matching entries are OR-merged (most permissive wins), then ANDed
 *        with the space baseline ('page_rule' when the governing level is the
 *        page itself, 'inherited_rule' when it is an ancestor).
 *  - can_create (create child pages) derives from can_edit.
 *
 * Every decision can be returned as a full {@link PermissionDecisionTrace}
 * for the permission-inspector UI (why do I / does X have access?).
 * @module src/wiki/wiki-permissions.service
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { SPACE_ROLE_BASE_PERMISSIONS } from '../permissions/models/space-permissions.model';
import { WikiCollabBroadcastService } from './wiki-collab-broadcast.service';
import type { SetPagePermissionsDto } from './dto/set-page-permissions.dto';

interface PermissionRow {
  entity_type: string;
  entity_id: string;
  can_view: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

interface PermissionRowWithPage extends PermissionRow {
  wiki_page_id: string;
}

export interface EffectivePermission {
  can_view: boolean;
  can_edit: boolean;
  can_delete: boolean;
  /** Derived from can_edit — create child pages under this page. */
  can_create: boolean;
}

/** Where a permission decision came from. */
export type PermissionDecisionSource =
  | 'admin'
  | 'creator'
  | 'space_default'
  | 'page_rule'
  | 'inherited_rule'
  | 'restricted_no_match'
  /** Target (group) has no space access at all — nothing to inherit. */
  | 'no_access';

/** One permission entry that matched the user at the governing level. */
export interface MatchedPermissionEntry {
  entity_type: string;
  entity_id: string;
  entity_name?: string;
  can_view: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

/** Full explanation of a page permission decision. */
export interface PermissionDecisionTrace {
  decision: EffectivePermission;
  source: PermissionDecisionSource;
  /** Page whose rows decided the outcome (null for admin/creator/space_default). */
  decidedAtPageId: string | null;
  decidedAtPageTitle: string | null;
  /** True when the deciding rows live on an ancestor, not the page itself. */
  inheritedFromAncestor: boolean;
  matchedEntries: MatchedPermissionEntry[];
  spaceBaseline: EffectivePermission;
  /** Page ids checked, page-first then ancestors nearest → root. */
  chainChecked: string[];
  /** Page ids in the chain that carry permission rows (restriction levels). */
  restrictedLevels: string[];
}

/** Actor performing a permission mutation (for audit logging). */
export interface PermissionActor {
  userId: string;
  organizationId: string;
}

const FULL_PERMISSION: EffectivePermission = {
  can_view: true,
  can_edit: true,
  can_delete: true,
  can_create: true,
};

const NO_PERMISSION: EffectivePermission = {
  can_view: false,
  can_edit: false,
  can_delete: false,
  can_create: false,
};

/** A grant can never exceed the space baseline — AND the two together. */
function capToBaseline(
  decision: EffectivePermission,
  baseline: EffectivePermission,
): EffectivePermission {
  return {
    can_view: decision.can_view && baseline.can_view,
    can_edit: decision.can_edit && baseline.can_edit,
    can_delete: decision.can_delete && baseline.can_delete,
    can_create: decision.can_create && baseline.can_create,
  };
}

/** Hard cap on members evaluated by the effective-access matrix. */
const MATRIX_MEMBER_CAP = 100;

/** Space-role precedence for picking a group's strongest membership row. */
const SPACE_ROLE_RANK: Record<string, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

/** The four wiki space-permission keys a group baseline is derived from. */
const WIKI_BASELINE_KEYS = [
  'view_wiki_pages',
  'edit_wiki_pages',
  'delete_wiki_pages',
  'create_wiki_pages',
] as const;

/** The four space keys a page's baseline reads, by capability. */
interface BaselineKeys {
  view: string;
  edit: string;
  delete: string;
  create: string;
}

const WIKI_SPACE_KEYS: BaselineKeys = {
  view: 'view_wiki_pages',
  edit: 'edit_wiki_pages',
  delete: 'delete_wiki_pages',
  create: 'create_wiki_pages',
};

/**
 * A whiteboard link row stands for the board, so its baseline is the Whiteboards keys: the board
 * API checks those (not the wiki ones), and the access dialog must report what it enforces.
 */
const WHITEBOARD_SPACE_KEYS: BaselineKeys = {
  view: 'view_whiteboards',
  edit: 'edit_whiteboards',
  delete: 'delete_whiteboards',
  create: 'create_whiteboards',
};

function baselineKeysFor(page: {
  whiteboard_id?: string | null;
}): BaselineKeys {
  return page.whiteboard_id ? WHITEBOARD_SPACE_KEYS : WIKI_SPACE_KEYS;
}

@Injectable()
export class WikiPermissionsService {
  private static readonly PERMISSIONS = 'wiki_page_permissions';
  private static readonly PAGES = 'wiki_pages';
  private static readonly AUDIT_LOGS = 'audit_logs';

  private readonly logger = new Logger(WikiPermissionsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissionsService: PermissionsService,
    private readonly collabBroadcast: WikiCollabBroadcastService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ── Read ────────────────────────────────────────────────────────────────

  async getPagePermissions(
    pageId: string,
    spaceId: string,
  ): Promise<unknown[]> {
    const { data: page } = await this.client
      .from(WikiPermissionsService.PAGES)
      .select('id, created_by')
      .eq('id', pageId)
      .eq('space_id', spaceId)
      .single();
    if (!page) throw new NotFoundException(`Page ${pageId} not found`);

    const { data, error } = await this.client
      .from(WikiPermissionsService.PERMISSIONS)
      .select('*')
      .eq('wiki_page_id', pageId);
    if (error) throw new BadRequestException(error.message);

    const rows = (data ?? []) as {
      entity_type: string;
      entity_id: string;
      [key: string]: unknown;
    }[];

    if (rows.length === 0) return [];

    return this.decorateEntities(rows);
  }

  /** Attach entity_name / entity_avatar_url display data to permission rows. */
  private async decorateEntities<
    T extends { entity_type: string; entity_id: string },
  >(rows: T[]): Promise<(T & { entity_name: string })[]> {
    const userIds = rows
      .filter((r) => r.entity_type === 'user')
      .map((r) => r.entity_id);
    const roleIds = rows
      .filter((r) => r.entity_type === 'role')
      .map((r) => r.entity_id);
    const groupIds = rows
      .filter((r) => r.entity_type === 'group')
      .map((r) => r.entity_id);

    const [usersRes, rolesRes, groupsRes] = await Promise.all([
      userIds.length
        ? this.client
            .from('users')
            .select('id, first_name, last_name, email, avatar_url')
            .in('id', userIds)
        : { data: [] },
      roleIds.length
        ? this.client.from('custom_roles').select('id, name').in('id', roleIds)
        : { data: [] },
      groupIds.length
        ? this.client.from('user_groups').select('id, name').in('id', groupIds)
        : { data: [] },
    ]);

    type UserRow = {
      id: string;
      first_name?: string | null;
      last_name?: string | null;
      email?: string | null;
      avatar_url?: string | null;
    };
    type NameRow = { id: string; name: string };

    const userMap = new Map<string, UserRow>(
      ((usersRes.data ?? []) as UserRow[]).map((u) => [u.id, u]),
    );
    const roleMap = new Map<string, string>(
      ((rolesRes.data ?? []) as NameRow[]).map((r) => [r.id, r.name]),
    );
    const groupMap = new Map<string, string>(
      ((groupsRes.data ?? []) as NameRow[]).map((g) => [g.id, g.name]),
    );

    return rows.map((row) => {
      if (row.entity_type === 'user') {
        const u = userMap.get(row.entity_id);
        const fullName = u
          ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() ||
            u.email ||
            row.entity_id
          : row.entity_id;
        return {
          ...row,
          entity_name: fullName,
          entity_avatar_url: u?.avatar_url ?? null,
        };
      }
      if (row.entity_type === 'role') {
        return {
          ...row,
          entity_name: roleMap.get(row.entity_id) ?? row.entity_id,
          entity_avatar_url: null,
        };
      }
      if (row.entity_type === 'group') {
        return {
          ...row,
          entity_name: groupMap.get(row.entity_id) ?? row.entity_id,
          entity_avatar_url: null,
        };
      }
      return { ...row, entity_name: row.entity_id, entity_avatar_url: null };
    });
  }

  // ── User context ─────────────────────────────────────────────────────────

  async resolveUserContext(
    userId: string,
    spaceId: string,
  ): Promise<{ roleIds: string[]; groupIds: string[]; isSpaceAdmin: boolean }> {
    const roleIds: string[] = [];

    const { data: membership } = await this.client
      .from('space_members')
      .select('space_role, role_id')
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .maybeSingle();

    let isSpaceAdmin =
      membership?.space_role === 'admin' || membership?.space_role === 'owner';

    if (membership?.role_id) roleIds.push(membership.role_id as string);

    const { data: roleAssignments } = await this.client
      .from('user_role_assignments')
      .select('role_id')
      .eq('user_id', userId);
    for (const ra of roleAssignments ?? []) {
      const rid = (ra as { role_id: string }).role_id;
      if (!roleIds.includes(rid)) roleIds.push(rid);
    }

    const { data: groupMemberships } = await this.client
      .from('user_group_members')
      .select('group_id')
      .eq('user_id', userId);
    const groupIds = (groupMemberships ?? []).map(
      (g) => (g as { group_id: string }).group_id,
    );

    if (!isSpaceAdmin) {
      // Org admins/owners are treated as space admins, but ONLY within the
      // space's own org — filter by organization_id so the RLS-bypassing
      // service-role client can't leak admin across tenants. Fail closed when
      // the org can't be resolved.
      const orgId = await this.resolveSpaceOrganizationId(spaceId);

      if (orgId) {
        const { data: orgMembership } = await this.client
          .from('organization_members')
          .select('role')
          .eq('organization_id', orgId)
          .eq('user_id', userId)
          .maybeSingle();

        if (
          orgMembership?.role === 'admin' ||
          orgMembership?.role === 'owner'
        ) {
          isSpaceAdmin = true;
        }
      }
    }

    return { roleIds, groupIds, isSpaceAdmin };
  }

  // ── Space baseline ─────────────────────────────────────────────────────────

  /**
   * Resolves the user's SPACE-LEVEL wiki permission baseline (the open-by-
   * default fallback and the AND-cap applied on top of page-rule grants).
   * Reuses PermissionsService.getUserSpacePermissions — the same resolver the
   * SpacePermissionsGuard uses — so RBAC is never reimplemented here.
   *
   * @param userId - public.users.id
   * @param spaceId - Space UUID
   * @param organizationId - Org UUID; resolved from the space when omitted.
   */
  async getSpaceBaseline(
    userId: string,
    spaceId: string,
    organizationId?: string,
    keys: BaselineKeys = WIKI_SPACE_KEYS,
  ): Promise<EffectivePermission> {
    const orgId =
      organizationId ?? (await this.resolveSpaceOrganizationId(spaceId));

    if (!orgId) return { ...NO_PERMISSION };

    const resolved = await this.permissionsService.getUserSpacePermissions(
      userId,
      orgId,
      spaceId,
    );

    if (!resolved.isMember) return { ...NO_PERMISSION };

    const perms = resolved.permissions;
    const canView = perms[keys.view] === true;
    const canEdit = perms[keys.edit] === true;
    const canDelete =
      perms[keys.delete] !== undefined ? perms[keys.delete] === true : canEdit;
    const canCreate = perms[keys.create] === true;

    return {
      can_view: canView,
      can_edit: canEdit,
      can_delete: canDelete,
      can_create: canCreate,
    };
  }

  /** Org id of a space (or null when the space does not exist). */
  private async resolveSpaceOrganizationId(
    spaceId: string,
  ): Promise<string | null> {
    const { data } = await this.client
      .from('spaces')
      .select('organization_id')
      .eq('id', spaceId)
      .maybeSingle();

    return (
      (data as { organization_id?: string } | null)?.organization_id ?? null
    );
  }

  // ── Core permission resolution ────────────────────────────────────────────

  /**
   * Resolves the effective permission for a user on a page WITH the full
   * decision trace (source, governing level, matched entries, baseline).
   *
   * @throws NotFoundException when the page is not in the space.
   */
  async resolveWithTrace(
    userId: string,
    pageId: string,
    spaceId: string,
  ): Promise<PermissionDecisionTrace> {
    const ctx = await this.resolveUserContext(userId, spaceId);

    const { data: page } = await this.client
      .from(WikiPermissionsService.PAGES)
      .select('path, created_by, title, organization_id, whiteboard_id')
      .eq('id', pageId)
      .eq('space_id', spaceId)
      .maybeSingle();

    if (!page) throw new NotFoundException(`Page ${pageId} not found`);

    const pageRow = page as {
      created_by?: string | null;
      path?: string[] | null;
      title?: string | null;
      organization_id?: string | null;
      whiteboard_id?: string | null;
    };
    const path: string[] = pageRow.path ?? [];
    const chainChecked = [pageId, ...[...path].reverse()];

    if (ctx.isSpaceAdmin) {
      return {
        decision: { ...FULL_PERMISSION },
        source: 'admin',
        decidedAtPageId: null,
        decidedAtPageTitle: null,
        inheritedFromAncestor: false,
        matchedEntries: [],
        spaceBaseline: { ...FULL_PERMISSION },
        chainChecked,
        restrictedLevels: [],
      };
    }

    const spaceBaseline = await this.getSpaceBaseline(
      userId,
      spaceId,
      pageRow.organization_id ?? undefined,
      baselineKeysFor(pageRow),
    );

    if (pageRow.created_by && pageRow.created_by === userId) {
      return {
        decision: capToBaseline(FULL_PERMISSION, spaceBaseline),
        source: 'creator',
        decidedAtPageId: null,
        decidedAtPageTitle: null,
        inheritedFromAncestor: false,
        matchedEntries: [],
        spaceBaseline,
        chainChecked,
        restrictedLevels: [],
      };
    }

    // Batch-load all permission rows for this page + ancestors in one query.
    const chainIds = [pageId, ...path];
    const { data: allRows } = await this.client
      .from(WikiPermissionsService.PERMISSIONS)
      .select(
        'wiki_page_id, entity_type, entity_id, can_view, can_edit, can_delete',
      )
      .in('wiki_page_id', chainIds);

    const rowsByPage = new Map<string, PermissionRow[]>();
    for (const row of (allRows ?? []) as PermissionRowWithPage[]) {
      const list = rowsByPage.get(row.wiki_page_id) ?? [];
      list.push(row);
      rowsByPage.set(row.wiki_page_id, list);
    }

    const restrictedLevels = chainChecked.filter(
      (id) => (rowsByPage.get(id) ?? []).length > 0,
    );

    // Governing level = nearest level with ANY rows (page first, then
    // ancestors nearest → root). No governing level ⇒ space baseline (the
    // open-by-default flip).
    const governingId = chainChecked.find(
      (id) => (rowsByPage.get(id) ?? []).length > 0,
    );

    if (!governingId) {
      return {
        decision: { ...spaceBaseline },
        source: 'space_default',
        decidedAtPageId: null,
        decidedAtPageTitle: null,
        inheritedFromAncestor: false,
        matchedEntries: [],
        spaceBaseline,
        chainChecked,
        restrictedLevels,
      };
    }

    const governingRows = rowsByPage.get(governingId) ?? [];
    const matching = governingRows.filter((r) =>
      this.rowMatchesUser(r, userId, ctx.roleIds, ctx.groupIds),
    );
    const decidedAtPageTitle =
      governingId === pageId
        ? (pageRow.title ?? null)
        : await this.lookupPageTitle(governingId);

    if (matching.length === 0) {
      // The governing level restricts access and none of its entries match
      // this user — deny everything.
      return {
        decision: { ...NO_PERMISSION },
        source: 'restricted_no_match',
        decidedAtPageId: governingId,
        decidedAtPageTitle,
        inheritedFromAncestor: governingId !== pageId,
        matchedEntries: [],
        spaceBaseline,
        chainChecked,
        restrictedLevels,
      };
    }

    // OR-merge of matched entries (most permissive), capped by the baseline.
    const grant = {
      can_view: matching.some((r) => r.can_view),
      can_edit: matching.some((r) => r.can_edit),
      can_delete: matching.some((r) => r.can_delete),
    };
    const finalEdit = grant.can_edit && spaceBaseline.can_edit;
    const decision: EffectivePermission = {
      can_view: grant.can_view && spaceBaseline.can_view,
      can_edit: finalEdit,
      can_delete: grant.can_delete && spaceBaseline.can_delete,
      // Creating a child page needs the space create right, not only edit
      can_create: finalEdit && spaceBaseline.can_create,
    };

    const matchedEntries = await this.decorateEntities(
      matching.map((r) => ({ ...r })),
    );

    return {
      decision,
      source: governingId === pageId ? 'page_rule' : 'inherited_rule',
      decidedAtPageId: governingId,
      decidedAtPageTitle,
      inheritedFromAncestor: governingId !== pageId,
      matchedEntries,
      spaceBaseline,
      chainChecked,
      restrictedLevels,
    };
  }

  /**
   * Effective permission for a user on a page (thin wrapper over
   * {@link resolveWithTrace}; kept so wiki-mine / MCP callers stay working).
   */
  async getEffectivePermission(
    userId: string,
    pageId: string,
    spaceId: string,
  ): Promise<EffectivePermission> {
    const trace = await this.resolveWithTrace(userId, pageId, spaceId);

    return trace.decision;
  }

  private rowMatchesUser(
    row: PermissionRow,
    userId: string,
    roleIds: string[],
    groupIds: string[],
  ): boolean {
    return (
      (row.entity_type === 'user' && row.entity_id === userId) ||
      (row.entity_type === 'role' && roleIds.includes(row.entity_id)) ||
      (row.entity_type === 'group' && groupIds.includes(row.entity_id))
    );
  }

  /** The space permission that grants viewing this page (Whiteboards keys for a board row). */
  private async spaceViewKey(pageId: string): Promise<string> {
    const { data } = await this.client
      .from(WikiPermissionsService.PAGES)
      .select('whiteboard_id')
      .eq('id', pageId)
      .maybeSingle();

    return baselineKeysFor(
      (data as { whiteboard_id?: string | null } | null) ?? {},
    ).view;
  }

  private async lookupPageTitle(pageId: string): Promise<string | null> {
    const { data } = await this.client
      .from(WikiPermissionsService.PAGES)
      .select('title')
      .eq('id', pageId)
      .maybeSingle();

    return (data as { title?: string } | null)?.title ?? null;
  }

  // ── Guards ───────────────────────────────────────────────────────────────

  /**
   * Throws ForbiddenException if the user lacks the required permission on the page.
   * Called by controller endpoints on every mutating and read operation.
   */
  async assertPageAccess(
    pageId: string,
    userId: string,
    spaceId: string,
    requiredPerm: 'can_view' | 'can_edit' | 'can_delete' | 'can_create',
  ): Promise<void> {
    await this.assertPageAccessWithTrace(pageId, userId, spaceId, requiredPerm);
  }

  /**
   * Same gate as {@link assertPageAccess} but returns the full decision trace
   * on success, so callers needing capabilities avoid a second resolution.
   */
  async assertPageAccessWithTrace(
    pageId: string,
    userId: string,
    spaceId: string,
    requiredPerm: 'can_view' | 'can_edit' | 'can_delete' | 'can_create',
  ): Promise<PermissionDecisionTrace> {
    const trace = await this.resolveWithTrace(userId, pageId, spaceId);

    if (!trace.decision[requiredPerm]) {
      const labels: Record<string, string> = {
        can_view: 'view',
        can_edit: 'edit',
        can_delete: 'delete',
        can_create: 'create pages under',
      };
      throw new ForbiddenException(
        `You do not have permission to ${labels[requiredPerm]} this page`,
      );
    }

    return trace;
  }

  /**
   * Throws ForbiddenException when the user may not create pages at the space
   * root. The space guard admits on RBAC alone, so the module matrix the UI
   * reads is re-checked here to keep the button and the API in agreement.
   *
   * @param userId - public.users.id
   * @param spaceId - Space UUID
   * @param organizationId - Org UUID; resolved from the space when omitted.
   */
  async assertSpaceCanCreate(
    userId: string,
    spaceId: string,
    organizationId?: string,
  ): Promise<void> {
    const ctx = await this.resolveUserContext(userId, spaceId);

    if (ctx.isSpaceAdmin) return;

    const baseline = await this.getSpaceBaseline(
      userId,
      spaceId,
      organizationId,
    );

    if (baseline.can_create !== true) {
      throw new ForbiddenException(
        'You do not have permission to create pages in this space',
      );
    }
  }

  async isCreatorOrAdmin(
    pageId: string,
    userId: string,
    spaceId: string,
  ): Promise<boolean> {
    const { data: page } = await this.client
      .from(WikiPermissionsService.PAGES)
      .select('created_by')
      .eq('id', pageId)
      .maybeSingle();

    if ((page as { created_by?: string } | null)?.created_by === userId)
      return true;

    const { data: spaceMember } = await this.client
      .from('space_members')
      .select('space_role')
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .maybeSingle();

    if (
      spaceMember?.space_role === 'admin' ||
      spaceMember?.space_role === 'owner'
    )
      return true;

    // Org admins/owners qualify, but ONLY within the space's own org — the
    // service-role client bypasses RLS, so filter by organization_id to block
    // cross-tenant escalation. Fail closed when the org can't be resolved.
    const orgId = await this.resolveSpaceOrganizationId(spaceId);

    if (!orgId) return false;

    const { data: orgMember } = await this.client
      .from('organization_members')
      .select('role')
      .eq('organization_id', orgId)
      .eq('user_id', userId)
      .maybeSingle();

    return orgMember?.role === 'admin' || orgMember?.role === 'owner';
  }

  // ── Bulk list filter ───────────────────────────────────────────────────────

  /**
   * Filter a page list to only pages the user can view. Applies the same
   * open-by-default resolution as {@link resolveWithTrace}: the space baseline
   * is computed ONCE per user+space; a page with no rows anywhere in its chain
   * is visible iff the baseline grants can_view.
   *
   * Constant DB round-trips regardless of list size (rows are batch-loaded
   * in chunks of 100 ids).
   */
  async filterAccessiblePages(
    pages: unknown[],
    userId: string,
    spaceId: string,
  ): Promise<unknown[]> {
    if (pages.length === 0) return [];

    const ctx = await this.resolveUserContext(userId, spaceId);
    if (ctx.isSpaceAdmin) return pages;

    const spaceBaseline = await this.getSpaceBaseline(userId, spaceId);

    type PageRow = {
      id: string;
      created_by?: string | null;
      path?: string[] | null;
    };
    const typed = pages as PageRow[];

    // Collect all unique IDs (pages + every ancestor referenced in any path)
    const allIds = new Set<string>();
    for (const p of typed) {
      allIds.add(p.id);
      for (const anc of p.path ?? []) allIds.add(anc);
    }

    // Batch into chunks of 100 to avoid URI-too-long (same pattern as getSpacePermissionsMap)
    const BATCH_SIZE = 100;
    const idsArr = [...allIds];
    const permBatches: any[] = [];
    for (let i = 0; i < idsArr.length; i += BATCH_SIZE) {
      permBatches.push(
        this.client
          .from(WikiPermissionsService.PERMISSIONS)
          .select(
            'wiki_page_id, entity_type, entity_id, can_view, can_edit, can_delete',
          )
          .in('wiki_page_id', idsArr.slice(i, i + BATCH_SIZE)),
      );
    }
    const permResults = await Promise.all(permBatches);
    const allPermsFlat: PermissionRowWithPage[] = [];
    for (const { data: batchData, error: batchError } of permResults) {
      if (batchError)
        throw new BadRequestException(
          (batchError as { message: string }).message,
        );
      if (batchData)
        allPermsFlat.push(...(batchData as PermissionRowWithPage[]));
    }

    const rowsByPage = new Map<string, PermissionRow[]>();
    for (const row of allPermsFlat) {
      const list = rowsByPage.get(row.wiki_page_id) ?? [];
      list.push(row);
      rowsByPage.set(row.wiki_page_id, list);
    }

    return typed.filter((page) => {
      // Creator always sees their own pages
      if (page.created_by && page.created_by === userId) return true;

      const chain = [page.id, ...[...(page.path ?? [])].reverse()];
      const governingId = chain.find(
        (id) => (rowsByPage.get(id) ?? []).length > 0,
      );

      // No rows anywhere in the chain — open by default via space baseline.
      if (!governingId) return spaceBaseline.can_view;

      const matching = (rowsByPage.get(governingId) ?? []).filter((r) =>
        this.rowMatchesUser(r, userId, ctx.roleIds, ctx.groupIds),
      );

      if (matching.length === 0) return false;

      return matching.some((r) => r.can_view) && spaceBaseline.can_view;
    });
  }

  /**
   * Page-level access to whiteboards through their wiki link rows (the wiki Share dialog writes
   * those rows). Same governing-level rule as {@link resolveWithTrace}, but WITHOUT the wiki
   * space baseline: the board endpoints already require the whiteboard space keys, and a member
   * with whiteboard but no wiki rights must not lose boards they could open before.
   *
   * Only RESTRICTED boards are in the result. A board that is absent (no link row, no rows
   * anywhere in its chain, or the caller is admin / link-row creator) keeps the space-level
   * behaviour, so boards nobody shared behave exactly as before.
   */
  async resolveBoardAccess(
    userId: string,
    spaceId: string,
    whiteboardIds: string[],
  ): Promise<Map<string, Omit<EffectivePermission, 'can_create'>>> {
    const result = new Map<string, Omit<EffectivePermission, 'can_create'>>();

    if (whiteboardIds.length === 0) return result;

    type LinkRow = {
      id: string;
      whiteboard_id: string;
      created_by: string | null;
      path: string[] | null;
    };

    const BATCH_SIZE = 100;
    const links: LinkRow[] = [];

    for (let i = 0; i < whiteboardIds.length; i += BATCH_SIZE) {
      const { data, error } = await this.client
        .from(WikiPermissionsService.PAGES)
        .select('id, whiteboard_id, created_by, path')
        .eq('space_id', spaceId)
        .in('whiteboard_id', whiteboardIds.slice(i, i + BATCH_SIZE));

      // Fail closed: an unreadable ACL must not fall back to "open".
      if (error) throw new BadRequestException(error.message);
      links.push(...((data ?? []) as LinkRow[]));
    }

    if (links.length === 0) return result;

    const idsArr = [
      ...new Set(links.flatMap((l) => [l.id, ...(l.path ?? [])])),
    ];
    const rowsByPage = new Map<string, PermissionRow[]>();

    for (let i = 0; i < idsArr.length; i += BATCH_SIZE) {
      const { data, error } = await this.client
        .from(WikiPermissionsService.PERMISSIONS)
        .select(
          'wiki_page_id, entity_type, entity_id, can_view, can_edit, can_delete',
        )
        .in('wiki_page_id', idsArr.slice(i, i + BATCH_SIZE));

      if (error) throw new BadRequestException(error.message);

      for (const row of (data ?? []) as PermissionRowWithPage[]) {
        const list = rowsByPage.get(row.wiki_page_id) ?? [];
        list.push(row);
        rowsByPage.set(row.wiki_page_id, list);
      }
    }

    // Nothing restricted anywhere: skip the membership lookups.
    if (rowsByPage.size === 0) return result;

    const ctx = await this.resolveUserContext(userId, spaceId);
    if (ctx.isSpaceAdmin) return result;

    for (const link of links) {
      if (link.created_by && link.created_by === userId) continue;

      const chain = [link.id, ...[...(link.path ?? [])].reverse()];
      const governingId = chain.find(
        (id) => (rowsByPage.get(id) ?? []).length > 0,
      );

      if (!governingId) continue;

      const matching = (rowsByPage.get(governingId) ?? []).filter((r) =>
        this.rowMatchesUser(r, userId, ctx.roleIds, ctx.groupIds),
      );
      const canEdit = matching.some((r) => r.can_edit);
      const canDelete = matching.some((r) => r.can_delete);

      result.set(link.whiteboard_id, {
        // Edit/delete imply view, as setPagePermissions normalises on write
        can_view: matching.some((r) => r.can_view) || canEdit || canDelete,
        can_edit: canEdit,
        can_delete: canDelete,
      });
    }

    return result;
  }

  // ── Write ────────────────────────────────────────────────────────────────

  /**
   * Replaces the explicit permission rows on a page, audit-logging the
   * {granted, revoked, modified} diff and broadcasting `permissions_changed`
   * on the page's collab channel (best-effort).
   */
  async setPagePermissions(
    pageId: string,
    spaceId: string,
    dto: SetPagePermissionsDto,
    actor: PermissionActor,
  ): Promise<unknown[]> {
    const { data: page } = await this.client
      .from(WikiPermissionsService.PAGES)
      .select('id, created_by, parent_id')
      .eq('id', pageId)
      .eq('space_id', spaceId)
      .single();
    if (!page) throw new NotFoundException(`Page ${pageId} not found`);

    const createdBy = (page as { created_by?: string | null }).created_by;

    // Snapshot old rows for the audit diff.
    const { data: oldRowsData } = await this.client
      .from(WikiPermissionsService.PERMISSIONS)
      .select('entity_type, entity_id, can_view, can_edit, can_delete')
      .eq('wiki_page_id', pageId);
    const oldRows = (oldRowsData ?? []) as PermissionRow[];

    // Normalize: can_edit or can_delete implies can_view
    const normalized = dto.permissions.map((p) => ({
      ...p,
      can_view: p.can_view || p.can_edit || p.can_delete,
    }));

    // Auto-ensure creator always retains full access (add silently if missing)
    if (createdBy) {
      const idx = normalized.findIndex(
        (p) => p.entity_type === 'user' && p.entity_id === createdBy,
      );
      if (idx === -1) {
        normalized.push({
          entity_type: 'user',
          entity_id: createdBy,
          can_view: true,
          can_edit: true,
          can_delete: true,
        });
      } else {
        normalized[idx] = {
          ...normalized[idx],
          can_view: true,
          can_edit: true,
          can_delete: true,
        };
      }
    }

    // Replace all explicit permissions for this page atomically
    const { error: delErr } = await this.client
      .from(WikiPermissionsService.PERMISSIONS)
      .delete()
      .eq('wiki_page_id', pageId);
    if (delErr) throw new BadRequestException(delErr.message);

    const { data, error } = await this.client
      .from(WikiPermissionsService.PERMISSIONS)
      .insert(
        normalized.map((p) => ({
          wiki_page_id: pageId,
          entity_type: p.entity_type,
          entity_id: p.entity_id,
          can_view: p.can_view,
          can_edit: p.can_edit,
          can_delete: p.can_delete,
        })),
      )
      .select('*');
    if (error) throw new BadRequestException(error.message);

    // Mark page as having custom permissions
    await this.client
      .from(WikiPermissionsService.PAGES)
      .update({ has_custom_permissions: true })
      .eq('id', pageId);

    const diff = this.diffPermissionRows(oldRows, normalized);

    this.logPermissionAudit(actor, pageId, {
      page_id: pageId,
      space_id: spaceId,
      ...diff,
    });

    void this.collabBroadcast
      .broadcastControl(pageId, 'permissions_changed', {
        pageId,
        spaceId,
        changedBy: actor.userId,
      })
      .catch(() => undefined);

    return (data ?? []) as unknown[];
  }

  /**
   * Clears all custom permission rows on a page (reverts it to open-by-default
   * inheritance), audit-logging the revoked entries.
   */
  async clearPagePermissions(
    pageId: string,
    spaceId: string,
    actor: PermissionActor,
  ): Promise<void> {
    const { data: page } = await this.client
      .from(WikiPermissionsService.PAGES)
      .select('id')
      .eq('id', pageId)
      .eq('space_id', spaceId)
      .single();
    if (!page) throw new NotFoundException(`Page ${pageId} not found`);

    const { data: oldRowsData } = await this.client
      .from(WikiPermissionsService.PERMISSIONS)
      .select('entity_type, entity_id, can_view, can_edit, can_delete')
      .eq('wiki_page_id', pageId);
    const oldRows = (oldRowsData ?? []) as PermissionRow[];

    const { error } = await this.client
      .from(WikiPermissionsService.PERMISSIONS)
      .delete()
      .eq('wiki_page_id', pageId);
    if (error) throw new BadRequestException(error.message);

    await this.client
      .from(WikiPermissionsService.PAGES)
      .update({ has_custom_permissions: false })
      .eq('id', pageId);

    this.logPermissionAudit(actor, pageId, {
      page_id: pageId,
      space_id: spaceId,
      granted: [],
      revoked: oldRows,
      modified: [],
      cleared: true,
    });

    void this.collabBroadcast
      .broadcastControl(pageId, 'permissions_changed', {
        pageId,
        spaceId,
        changedBy: actor.userId,
        cleared: true,
      })
      .catch(() => undefined);
  }

  /** Compute the {granted, revoked, modified} diff between two row sets. */
  private diffPermissionRows(
    oldRows: PermissionRow[],
    newRows: PermissionRow[],
  ): {
    granted: PermissionRow[];
    revoked: PermissionRow[];
    modified: {
      entity_type: string;
      entity_id: string;
      from: PermissionRow;
      to: PermissionRow;
    }[];
  } {
    const key = (r: PermissionRow) => `${r.entity_type}:${r.entity_id}`;
    const oldMap = new Map(oldRows.map((r) => [key(r), r]));
    const newMap = new Map(newRows.map((r) => [key(r), r]));

    const granted = newRows.filter((r) => !oldMap.has(key(r)));
    const revoked = oldRows.filter((r) => !newMap.has(key(r)));
    const modified: {
      entity_type: string;
      entity_id: string;
      from: PermissionRow;
      to: PermissionRow;
    }[] = [];

    for (const r of newRows) {
      const prev = oldMap.get(key(r));
      if (
        prev &&
        (prev.can_view !== r.can_view ||
          prev.can_edit !== r.can_edit ||
          prev.can_delete !== r.can_delete)
      ) {
        modified.push({
          entity_type: r.entity_type,
          entity_id: r.entity_id,
          from: prev,
          to: r,
        });
      }
    }

    return { granted, revoked, modified };
  }

  /** Fire-and-forget audit_logs insert for permission changes. */
  private logPermissionAudit(
    actor: PermissionActor,
    pageId: string,
    changes: Record<string, unknown>,
  ): void {
    if (!actor.organizationId) {
      // Requirement: "log all permission changes" — a missing org id means we
      // cannot attribute the audit row, so surface it rather than dropping it.
      this.logger.error(
        `Skipped wiki permission audit for page ${pageId}: actor has no organizationId`,
      );

      return;
    }

    // Fire-and-forget for latency, but never SILENT: a failed audit insert is
    // logged (Supabase insert resolves { error } instead of throwing).
    void this.client
      .from(WikiPermissionsService.AUDIT_LOGS)
      .insert({
        organization_id: actor.organizationId,
        user_id: actor.userId,
        entity_type: 'wiki_page_permission',
        entity_id: pageId,
        action: 'permission_change',
        changes,
      })
      .then(({ error }) => {
        if (error) {
          this.logger.error(
            `Failed to write wiki permission audit for page ${pageId}: ${error.message}`,
          );
        }
      });
  }

  // ── Access inspector ───────────────────────────────────────────────────────

  /**
   * Runs the decision trace for `targetUserId` on a page and — when the user
   * is denied — returns actionable grant suggestions for the admin UI.
   */
  async getGrantSuggestions(
    pageId: string,
    spaceId: string,
    targetUserId: string,
  ): Promise<{
    hasAccess: boolean;
    trace: PermissionDecisionTrace;
    suggestions: Record<string, unknown>[];
  }> {
    const trace = await this.resolveWithTrace(targetUserId, pageId, spaceId);

    if (trace.decision.can_view) {
      return { hasAccess: true, trace, suggestions: [] };
    }

    const suggestions: Record<string, unknown>[] = [];

    // Denied by the space baseline (no view permission / non-member).
    if (!trace.spaceBaseline.can_view) {
      const permission = await this.spaceViewKey(pageId);

      suggestions.push({
        type: 'grant_space_permission',
        spaceId,
        permission,
        reason: `The user lacks the ${permission} space permission (or is not a space member).`,
      });
    }

    // Denied at a restriction level — offer a direct page grant plus
    // membership in any group already granted view at that level.
    if (trace.decidedAtPageId) {
      suggestions.push({
        type: 'add_page_permission',
        pageId: trace.decidedAtPageId,
        pageTitle: trace.decidedAtPageTitle,
        entity_type: 'user',
        entity_id: targetUserId,
        grant: { can_view: true, can_edit: false, can_delete: false },
        reason:
          trace.source === 'restricted_no_match'
            ? 'The governing restriction level has no entry matching this user.'
            : 'The matching entries at the governing level do not grant view.',
      });

      const { data: levelRows } = await this.client
        .from(WikiPermissionsService.PERMISSIONS)
        .select('entity_type, entity_id, can_view, can_edit, can_delete')
        .eq('wiki_page_id', trace.decidedAtPageId);

      const viewGroups = ((levelRows ?? []) as PermissionRow[]).filter(
        (r) => r.entity_type === 'group' && r.can_view,
      );

      if (viewGroups.length > 0) {
        const { data: groups } = await this.client
          .from('user_groups')
          .select('id, name')
          .in(
            'id',
            viewGroups.map((g) => g.entity_id),
          );
        const nameById = new Map(
          ((groups ?? []) as { id: string; name: string }[]).map((g) => [
            g.id,
            g.name,
          ]),
        );

        for (const g of viewGroups) {
          suggestions.push({
            type: 'add_to_group',
            groupId: g.entity_id,
            groupName: nameById.get(g.entity_id) ?? g.entity_id,
            reason:
              'This group is already granted view at the governing restriction level.',
          });
        }
      }
    }

    return { hasAccess: false, trace, suggestions };
  }

  // ── Group access inspector ─────────────────────────────────────────────────

  /**
   * Space-level wiki baseline for a GROUP entity (the AND-cap applied on top of
   * page-rule grants). A group has NO baseline access unless it is an active
   * `member_type='group'` space member; when it is, the baseline is derived
   * from its strongest membership's space_role (via
   * {@link SPACE_ROLE_BASE_PERMISSIONS}) overlaid with the group's own
   * permission object and any per-membership permission overrides. This is an
   * advisory baseline for the inspector — enforcement is always per-user.
   */
  private async getGroupSpaceBaseline(
    groupId: string,
    spaceId: string,
    keys: BaselineKeys = WIKI_SPACE_KEYS,
  ): Promise<{ baseline: EffectivePermission; isMember: boolean }> {
    const { data: memberships } = await this.client
      .from('space_members')
      .select('space_role, permissions')
      .eq('space_id', spaceId)
      .eq('member_type', 'group')
      .eq('group_id', groupId)
      .eq('is_active', true);

    const rows = (memberships ?? []) as {
      space_role: string | null;
      permissions: Record<string, unknown> | null;
    }[];

    if (rows.length === 0) {
      return { baseline: { ...NO_PERMISSION }, isMember: false };
    }

    // Strongest space_role among the group's membership rows sets the base.
    let roleKey = 'viewer';

    for (const row of rows) {
      const candidate = this.normalizeGroupSpaceRole(row.space_role);

      if (SPACE_ROLE_RANK[candidate] > SPACE_ROLE_RANK[roleKey]) {
        roleKey = candidate;
      }
    }

    const base = SPACE_ROLE_BASE_PERMISSIONS[roleKey] ?? {};
    const keyList = [keys.view, keys.edit, keys.delete, keys.create];
    const perms: Record<string, boolean> = Object.fromEntries(
      keyList.map((k) => [k, base[k] === true]),
    );

    const { data: groupRow } = await this.client
      .from('user_groups')
      .select('permissions')
      .eq('id', groupId)
      .maybeSingle();

    this.overlayWikiBaselineKeys(
      perms,
      (groupRow as { permissions?: Record<string, unknown> } | null)
        ?.permissions,
      keyList,
    );

    for (const row of rows)
      this.overlayWikiBaselineKeys(perms, row.permissions, keyList);

    return {
      baseline: {
        can_view: perms[keys.view],
        can_edit: perms[keys.edit],
        can_delete: perms[keys.delete],
        can_create: perms[keys.create],
      },
      isMember: true,
    };
  }

  /** Map a raw space_role string onto a base-permission key (mirrors RBAC). */
  private normalizeGroupSpaceRole(
    role: string | null | undefined,
  ): 'owner' | 'admin' | 'member' | 'viewer' {
    if (role === 'owner') return 'owner';
    if (role === 'admin' || role === 'space_admin') return 'admin';
    if (role === 'member') return 'member';

    return 'viewer';
  }

  /** Overlay boolean baseline keys (`can_`-prefixed or flat) onto target. */
  private overlayWikiBaselineKeys(
    target: Record<string, boolean>,
    source: Record<string, unknown> | null | undefined,
    keyList: readonly string[] = WIKI_BASELINE_KEYS,
  ): void {
    if (!source) return;

    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== 'boolean') continue;

      const norm = key.startsWith('can_') ? key.slice(4) : key;

      if (keyList.includes(norm)) {
        target[norm] = value;
      }
    }
  }

  /**
   * Decision trace for a GROUP on a page (mirrors {@link resolveWithTrace} but
   * for a group entity). Groups are never admin/creator; the outcome is the
   * group's ACL match at the governing level, capped by its space baseline.
   * Source is 'no_access' when the group is not a space member at all.
   *
   * @throws NotFoundException when the page is not in the space.
   */
  async resolveGroupTrace(
    groupId: string,
    pageId: string,
    spaceId: string,
  ): Promise<PermissionDecisionTrace> {
    const { data: page } = await this.client
      .from(WikiPermissionsService.PAGES)
      .select('path, title, whiteboard_id')
      .eq('id', pageId)
      .eq('space_id', spaceId)
      .maybeSingle();

    if (!page) throw new NotFoundException(`Page ${pageId} not found`);

    const pageRow = page as {
      path?: string[] | null;
      title?: string | null;
      whiteboard_id?: string | null;
    };
    const path: string[] = pageRow.path ?? [];
    const chainChecked = [pageId, ...[...path].reverse()];

    const { baseline, isMember } = await this.getGroupSpaceBaseline(
      groupId,
      spaceId,
      baselineKeysFor(pageRow),
    );

    if (!isMember) {
      // Not a space member — no baseline to inherit and no rule can grant
      // access (every grant is AND-capped by the baseline).
      return {
        decision: { ...NO_PERMISSION },
        source: 'no_access',
        decidedAtPageId: null,
        decidedAtPageTitle: null,
        inheritedFromAncestor: false,
        matchedEntries: [],
        spaceBaseline: baseline,
        chainChecked,
        restrictedLevels: [],
      };
    }

    const chainIds = [pageId, ...path];
    const { data: allRows } = await this.client
      .from(WikiPermissionsService.PERMISSIONS)
      .select(
        'wiki_page_id, entity_type, entity_id, can_view, can_edit, can_delete',
      )
      .in('wiki_page_id', chainIds);

    const rowsByPage = new Map<string, PermissionRow[]>();

    for (const row of (allRows ?? []) as PermissionRowWithPage[]) {
      const list = rowsByPage.get(row.wiki_page_id) ?? [];

      list.push(row);
      rowsByPage.set(row.wiki_page_id, list);
    }

    const restrictedLevels = chainChecked.filter(
      (id) => (rowsByPage.get(id) ?? []).length > 0,
    );
    const governingId = chainChecked.find(
      (id) => (rowsByPage.get(id) ?? []).length > 0,
    );

    if (!governingId) {
      return {
        decision: { ...baseline },
        source: 'space_default',
        decidedAtPageId: null,
        decidedAtPageTitle: null,
        inheritedFromAncestor: false,
        matchedEntries: [],
        spaceBaseline: baseline,
        chainChecked,
        restrictedLevels,
      };
    }

    const governingRows = rowsByPage.get(governingId) ?? [];
    const matching = governingRows.filter(
      (r) => r.entity_type === 'group' && r.entity_id === groupId,
    );
    const decidedAtPageTitle =
      governingId === pageId
        ? (pageRow.title ?? null)
        : await this.lookupPageTitle(governingId);

    if (matching.length === 0) {
      return {
        decision: { ...NO_PERMISSION },
        source: 'restricted_no_match',
        decidedAtPageId: governingId,
        decidedAtPageTitle,
        inheritedFromAncestor: governingId !== pageId,
        matchedEntries: [],
        spaceBaseline: baseline,
        chainChecked,
        restrictedLevels,
      };
    }

    const grant = {
      can_view: matching.some((r) => r.can_view),
      can_edit: matching.some((r) => r.can_edit),
      can_delete: matching.some((r) => r.can_delete),
    };
    const finalEdit = grant.can_edit && baseline.can_edit;
    const decision: EffectivePermission = {
      can_view: grant.can_view && baseline.can_view,
      can_edit: finalEdit,
      can_delete: grant.can_delete && baseline.can_delete,
      // Creating a child page needs the space create right, not only edit
      can_create: finalEdit && baseline.can_create,
    };
    const matchedEntries = await this.decorateEntities(
      matching.map((r) => ({ ...r })),
    );

    return {
      decision,
      source: governingId === pageId ? 'page_rule' : 'inherited_rule',
      decidedAtPageId: governingId,
      decidedAtPageTitle,
      inheritedFromAncestor: governingId !== pageId,
      matchedEntries,
      spaceBaseline: baseline,
      chainChecked,
      restrictedLevels,
    };
  }

  /**
   * Group counterpart to {@link getGrantSuggestions}: traces a GROUP's access
   * and, when denied, returns the same-shaped grant suggestions (grant the
   * space permission and/or add a page permission for the group).
   */
  async getGroupGrantSuggestions(
    pageId: string,
    spaceId: string,
    groupId: string,
  ): Promise<{
    hasAccess: boolean;
    trace: PermissionDecisionTrace;
    suggestions: Record<string, unknown>[];
  }> {
    const trace = await this.resolveGroupTrace(groupId, pageId, spaceId);

    if (trace.decision.can_view) {
      return { hasAccess: true, trace, suggestions: [] };
    }

    const suggestions: Record<string, unknown>[] = [];

    if (!trace.spaceBaseline.can_view) {
      const permission = await this.spaceViewKey(pageId);

      suggestions.push({
        type: 'grant_space_permission',
        spaceId,
        entity_type: 'group',
        entity_id: groupId,
        permission,
        reason: `The group lacks the ${permission} space permission (or is not a space member).`,
      });
    }

    if (trace.decidedAtPageId) {
      suggestions.push({
        type: 'add_page_permission',
        pageId: trace.decidedAtPageId,
        pageTitle: trace.decidedAtPageTitle,
        entity_type: 'group',
        entity_id: groupId,
        grant: { can_view: true, can_edit: false, can_delete: false },
        reason:
          trace.source === 'restricted_no_match'
            ? 'The governing restriction level has no entry matching this group.'
            : 'The matching entries at the governing level do not grant view.',
      });
    }

    return { hasAccess: false, trace, suggestions };
  }

  /**
   * Effective-access matrix for a page: every active space member (user) and
   * every group with space access, each with its decision + source.
   *
   * Batched: one chain-rows load + one member/group load + batched display
   * lookups; per-user space baselines are resolved in parallel and the member
   * set is capped at {@link MATRIX_MEMBER_CAP}.
   */
  async getEffectiveAccessMatrix(
    pageId: string,
    spaceId: string,
  ): Promise<{
    users: Record<string, unknown>[];
    groups: Record<string, unknown>[];
    truncated: boolean;
  }> {
    const { data: page } = await this.client
      .from(WikiPermissionsService.PAGES)
      .select('path, created_by, title, organization_id, whiteboard_id')
      .eq('id', pageId)
      .eq('space_id', spaceId)
      .maybeSingle();

    if (!page) throw new NotFoundException(`Page ${pageId} not found`);

    const pageRow = page as {
      created_by?: string | null;
      path?: string[] | null;
      organization_id?: string | null;
      whiteboard_id?: string | null;
    };
    const path = pageRow.path ?? [];
    const chain = [pageId, ...[...path].reverse()];
    const orgId = pageRow.organization_id ?? null;

    // One rows load for the whole chain.
    const { data: allRows } = await this.client
      .from(WikiPermissionsService.PERMISSIONS)
      .select(
        'wiki_page_id, entity_type, entity_id, can_view, can_edit, can_delete',
      )
      .in('wiki_page_id', [pageId, ...path]);

    const rowsByPage = new Map<string, PermissionRow[]>();
    for (const row of (allRows ?? []) as PermissionRowWithPage[]) {
      const list = rowsByPage.get(row.wiki_page_id) ?? [];
      list.push(row);
      rowsByPage.set(row.wiki_page_id, list);
    }
    const governingId = chain.find(
      (id) => (rowsByPage.get(id) ?? []).length > 0,
    );
    const governingRows = governingId
      ? (rowsByPage.get(governingId) ?? [])
      : [];

    // One member/group load.
    const { data: memberRows } = await this.client
      .from('space_members')
      .select('user_id, group_id, member_type, space_role, role_id, is_active')
      .eq('space_id', spaceId)
      .eq('is_active', true);

    const members = ((memberRows ?? []) as Record<string, unknown>[]).filter(
      (m) => m['member_type'] === 'user' && m['user_id'],
    );
    const groupMembers = (
      (memberRows ?? []) as Record<string, unknown>[]
    ).filter((m) => m['member_type'] === 'group' && m['group_id']);

    const truncated = members.length > MATRIX_MEMBER_CAP;
    const cappedMembers = members.slice(0, MATRIX_MEMBER_CAP);
    const userIds = cappedMembers.map((m) => m['user_id'] as string);

    // Batched context loads for all users at once.
    const [usersRes, orgRolesRes, groupMemRes, roleAssignRes] =
      await Promise.all([
        userIds.length
          ? this.client
              .from('users')
              .select('id, first_name, last_name, email, avatar_url')
              .in('id', userIds)
          : { data: [] },
        userIds.length && orgId
          ? this.client
              .from('organization_members')
              .select('user_id, role')
              .eq('organization_id', orgId)
              .in('user_id', userIds)
          : { data: [] },
        userIds.length
          ? this.client
              .from('user_group_members')
              .select('user_id, group_id')
              .in('user_id', userIds)
          : { data: [] },
        userIds.length
          ? this.client
              .from('user_role_assignments')
              .select('user_id, role_id')
              .in('user_id', userIds)
          : { data: [] },
      ]);

    const userById = new Map(
      ((usersRes.data ?? []) as Record<string, unknown>[]).map((u) => [
        u['id'] as string,
        u,
      ]),
    );
    const orgRoleByUser = new Map(
      ((orgRolesRes.data ?? []) as Record<string, unknown>[]).map((r) => [
        r['user_id'] as string,
        r['role'] as string,
      ]),
    );
    const groupsByUser = new Map<string, string[]>();
    for (const gm of (groupMemRes.data ?? []) as Record<string, unknown>[]) {
      const uid = gm['user_id'] as string;
      const list = groupsByUser.get(uid) ?? [];
      list.push(gm['group_id'] as string);
      groupsByUser.set(uid, list);
    }
    const rolesByUser = new Map<string, string[]>();
    for (const ra of (roleAssignRes.data ?? []) as Record<string, unknown>[]) {
      const uid = ra['user_id'] as string;
      const list = rolesByUser.get(uid) ?? [];
      list.push(ra['role_id'] as string);
      rolesByUser.set(uid, list);
    }

    // Per-user baselines in parallel (bounded by the member cap).
    const baselines = await Promise.all(
      cappedMembers.map((m) =>
        this.getSpaceBaseline(
          m['user_id'] as string,
          spaceId,
          orgId ?? undefined,
          baselineKeysFor(pageRow),
        ).catch(() => ({ ...NO_PERMISSION })),
      ),
    );

    const users = cappedMembers.map((m, i) => {
      const uid = m['user_id'] as string;
      const spaceRole = m['space_role'] as string | null;
      const orgRole = orgRoleByUser.get(uid) ?? null;
      const isAdmin =
        spaceRole === 'admin' ||
        spaceRole === 'owner' ||
        orgRole === 'admin' ||
        orgRole === 'owner';
      const u = userById.get(uid) ?? {};
      const display = {
        entity_type: 'user',
        entity_id: uid,
        entity_name:
          `${(u['first_name'] as string) ?? ''} ${(u['last_name'] as string) ?? ''}`.trim() ||
          ((u['email'] as string) ?? uid),
        entity_avatar_url: (u['avatar_url'] as string) ?? null,
      };

      if (isAdmin) {
        return {
          ...display,
          decision: { ...FULL_PERMISSION },
          source: 'admin' as PermissionDecisionSource,
        };
      }

      if (pageRow.created_by && pageRow.created_by === uid) {
        return {
          ...display,
          decision: capToBaseline(FULL_PERMISSION, baselines[i]),
          source: 'creator' as PermissionDecisionSource,
        };
      }

      const baseline = baselines[i];

      if (!governingId) {
        return {
          ...display,
          decision: { ...baseline },
          source: 'space_default' as PermissionDecisionSource,
        };
      }

      const roleIds = [
        ...(m['role_id'] ? [m['role_id'] as string] : []),
        ...(rolesByUser.get(uid) ?? []),
      ];
      const groupIds = groupsByUser.get(uid) ?? [];
      const matching = governingRows.filter((r) =>
        this.rowMatchesUser(r, uid, roleIds, groupIds),
      );

      if (matching.length === 0) {
        return {
          ...display,
          decision: { ...NO_PERMISSION },
          source: 'restricted_no_match' as PermissionDecisionSource,
        };
      }

      const finalEdit = matching.some((r) => r.can_edit) && baseline.can_edit;

      return {
        ...display,
        decision: {
          can_view: matching.some((r) => r.can_view) && baseline.can_view,
          can_edit: finalEdit,
          can_delete: matching.some((r) => r.can_delete) && baseline.can_delete,
          // Creating a child page needs the space create right, not only edit
          can_create: finalEdit && baseline.can_create,
        },
        source: (governingId === pageId
          ? 'page_rule'
          : 'inherited_rule') as PermissionDecisionSource,
      };
    });

    // Groups with space access — evaluated as entities against the governing
    // level (the space baseline is user-specific and not applied here).
    const matrixGroupIds = groupMembers.map((g) => g['group_id'] as string);
    const { data: groupNames } = matrixGroupIds.length
      ? await this.client
          .from('user_groups')
          .select('id, name')
          .in('id', matrixGroupIds)
      : { data: [] };
    const groupNameById = new Map(
      ((groupNames ?? []) as { id: string; name: string }[]).map((g) => [
        g.id,
        g.name,
      ]),
    );

    const groups = matrixGroupIds.map((gid) => {
      const display = {
        entity_type: 'group',
        entity_id: gid,
        entity_name: groupNameById.get(gid) ?? gid,
      };

      if (!governingId) {
        return {
          ...display,
          decision: null,
          source: 'space_default' as PermissionDecisionSource,
        };
      }

      const matching = governingRows.filter(
        (r) => r.entity_type === 'group' && r.entity_id === gid,
      );

      if (matching.length === 0) {
        return {
          ...display,
          decision: { ...NO_PERMISSION },
          source: 'restricted_no_match' as PermissionDecisionSource,
        };
      }

      const canEdit = matching.some((r) => r.can_edit);

      return {
        ...display,
        decision: {
          can_view: matching.some((r) => r.can_view),
          can_edit: canEdit,
          can_delete: matching.some((r) => r.can_delete),
          can_create: canEdit,
        },
        source: (governingId === pageId
          ? 'page_rule'
          : 'inherited_rule') as PermissionDecisionSource,
      };
    });

    return { users, groups, truncated };
  }

  // ── Bulk space permissions map ────────────────────────────────────────────

  /**
   * Returns all wiki_page_permissions rows for a space keyed by wiki_page_id.
   * Shape: { [pageId]: PermissionRow[] }
   * Used by the frontend to filter the sidebar tree without per-page fetches.
   */
  async getSpacePermissionsMap(
    spaceId: string,
  ): Promise<Record<string, PermissionRow[]>> {
    // Fetch all page IDs for the space in one query
    const { data: pages, error: pagesError } = await this.client
      .from(WikiPermissionsService.PAGES)
      .select('id')
      .eq('space_id', spaceId);

    if (pagesError) throw new BadRequestException(pagesError.message);
    if (!pages || pages.length === 0) return {};

    const pageIds = (pages as { id: string }[]).map((p) => p.id);

    // Batch into chunks of 100 to avoid URI-too-long when spaces have 1000+ pages
    const BATCH_SIZE = 100;
    const batches: any[] = [];

    for (let i = 0; i < pageIds.length; i += BATCH_SIZE) {
      batches.push(
        this.client
          .from(WikiPermissionsService.PERMISSIONS)
          .select(
            'wiki_page_id, entity_type, entity_id, can_view, can_edit, can_delete',
          )
          .in('wiki_page_id', pageIds.slice(i, i + BATCH_SIZE)),
      );
    }

    const results = await Promise.all(batches);
    const allRows: (PermissionRow & { wiki_page_id: string })[] = [];

    for (const { data: batchData, error: batchError } of results) {
      if (batchError)
        throw new BadRequestException(
          (batchError as { message: string }).message,
        );
      if (batchData)
        allRows.push(
          ...(batchData as (PermissionRow & { wiki_page_id: string })[]),
        );
    }

    const map: Record<string, PermissionRow[]> = {};

    for (const row of allRows) {
      if (!map[row.wiki_page_id]) map[row.wiki_page_id] = [];
      map[row.wiki_page_id].push({
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        can_view: row.can_view,
        can_edit: row.can_edit,
        can_delete: row.can_delete,
      });
    }

    return map;
  }

  /**
   * True when the space has at least one page carrying custom permission rows
   * (cheap existence probe used by ACL-aware pagination).
   */
  async spaceHasRestrictedPages(spaceId: string): Promise<boolean> {
    const { data } = await this.client
      .from(WikiPermissionsService.PAGES)
      .select('id')
      .eq('space_id', spaceId)
      .eq('has_custom_permissions', true)
      .limit(1);

    return ((data ?? []) as unknown[]).length > 0;
  }
}
