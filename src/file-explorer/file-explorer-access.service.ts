/**
 * @fileoverview The single authorisation choke-point for every File Explorer node access.
 * ALL controllers and service paths that touch a node MUST call resolveEffectivePermission
 * before returning data. No scattered checks allowed.
 *
 *
 *   0. Org gate — cross-tenant → deny immediately.
 *   1. Space path — call PermissionsService.getUserSpacePermissions; union its grants.
 *   1b. Guard-equivalent grant — PermissionsService.resolveSpaceBaseGrant, the same rule
 *       SpacePermissionsGuard applies, so a node-level route can never deny a user the
 *       guard already admitted for listing.
 *   2+3. Direct + ancestor user shares in one IN query; union grants; read-time expiry.
 *
 * @module src/file-explorer/file-explorer-access.service
 */

import { Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { spaceGrantAllows } from '../permissions/models/space-permissions.model';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { IFeNode } from './interfaces/fe-node.interface';
import type { IFeShare } from './interfaces/fe-share.interface';

export interface FeEffectivePermission {
  canView: boolean;
  canCreate: boolean;
  canDelete: boolean;
}

const DENY: FeEffectivePermission = {
  canView: false,
  canCreate: false,
  canDelete: false,
};

@Injectable()
export class FileExplorerAccessService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly perms: PermissionsService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Resolve the effective permission for a single node.
   * Returns DENY (not throw) on access failure — callers throw NotFoundException.
   * Requires node.ancestor_ids to be populated (from Migration C).
   */
  async resolveEffectivePermission(
    user: RequestUser,
    node: IFeNode,
  ): Promise<FeEffectivePermission> {
    // 0. Hard org gate — never cross tenants regardless of shares.
    if (node.organization_id !== user.organizationId) return DENY;

    let canView = false;
    let canCreate = false;
    let canDelete = false;

    // 1. Space path (membership + space permission). This layer can GRANT beyond the
    // base role via space_permissions / space_module_permissions overrides, so it is
    // still consulted — but it can never be the reason for a denial (see 1b).
    const sp = await this.perms.getUserSpacePermissions(
      user.userId,
      user.organizationId,
      node.space_id,
    );

    if (sp?.isMember) {
      canView ||= sp.permissions['view_file_explorer'] === true;
      canCreate ||= sp.permissions['create_file_explorer'] === true;
      canDelete ||= sp.permissions['delete_file_explorer'] === true;
    }

    // 1b. Guard-equivalent grant — the same verdict SpacePermissionsGuard reached when
    // it admitted the listing request that produced this node id.
    //
    // Two production-only divergences make this necessary, and both deny users who can
    // demonstrably see the file in the listing:
    //   * getUserSpacePermissions filters space_members by member_type='user', which
    //     excludes rows created before that column existed (they carry NULL).
    //   * it merges the whole space_permissions row over the base role, and
    //     can_view_file_explorer is a DEFAULT false column added after the table
    //     shipped — so ALTER TABLE backfilled `false` onto every pre-existing row. That
    //     false is indistinguishable from "never configured" and must not authorise.
    // The guard consults neither, which is why listing works while every node-level
    // route 404s. Union, never subtract: this can only widen access to match the guard.
    if (!canView || !canCreate || !canDelete) {
      const grant = await this.perms.resolveSpaceBaseGrant(
        user.userId,
        user.organizationId,
        node.space_id,
      );

      canView ||= spaceGrantAllows(grant, 'view_file_explorer');
      canCreate ||= spaceGrantAllows(grant, 'create_file_explorer');
      canDelete ||= spaceGrantAllows(grant, 'delete_file_explorer');
    }

    // Short-circuit: full access already granted — skip the share lookup.
    if (canView && canCreate && canDelete) {
      return { canView, canCreate, canDelete };
    }

    // 2 + 3. Direct share on the node + inherited shares from ancestor folders.
    // One query covers both by searching node_id IN [nodeId, ...ancestorIds].
    const ids = [node.id, ...(node.ancestor_ids ?? [])];
    const sharesResult = await this.db
      .from('fe_shares')
      .select('can_view, can_create, can_delete, expires_at')
      .eq('share_type', 'user')
      .eq('shared_with_id', user.userId)
      .eq('is_active', true)
      .in('node_id', ids);

    const now = Date.now();

    for (const s of sharesResult.data ?? []) {
      // Read-time expiry check.
      if (s.expires_at && new Date(s.expires_at).getTime() <= now) continue;

      canView ||= s.can_view;
      canCreate ||= s.can_create;
      canDelete ||= s.can_delete;
    }

    return { canView, canCreate, canDelete };
  }

  /**
   * Batched resolution for a listing page: resolve the parent folder's inherited
   * grant once, then one query for direct shares on all children.
   * Never resolves children individually — no O(n × depth) queries.
   */
  async resolveForListing(
    user: RequestUser,
    parent: IFeNode | null,
    children: IFeNode[],
  ): Promise<Map<string, FeEffectivePermission>> {
    const result = new Map<string, FeEffectivePermission>();

    if (children.length === 0) return result;

    // Org gate.
    const orgId = children[0].organization_id;

    if (orgId !== user.organizationId) {
      children.forEach((c) => result.set(c.id, DENY));

      return result;
    }

    // Space path — resolve once for the parent's space.
    const spaceId = children[0].space_id;
    const sp = await this.perms.getUserSpacePermissions(
      user.userId,
      user.organizationId,
      spaceId,
    );

    const spacePerm: FeEffectivePermission = sp?.isMember
      ? {
          canView: sp.permissions['view_file_explorer'] === true,
          canCreate: sp.permissions['create_file_explorer'] === true,
          canDelete: sp.permissions['delete_file_explorer'] === true,
        }
      : DENY;

    // Ancestor-inherited grant from the parent folder (if any).
    let parentInherited: FeEffectivePermission = DENY;

    if (parent) {
      const parentIds = [parent.id, ...(parent.ancestor_ids ?? [])];
      const parentSharesResult = await this.db
        .from('fe_shares')
        .select('can_view, can_create, can_delete, expires_at')
        .eq('share_type', 'user')
        .eq('shared_with_id', user.userId)
        .eq('is_active', true)
        .in('node_id', parentIds);

      const now = Date.now();

      parentInherited = { canView: false, canCreate: false, canDelete: false };

      for (const s of parentSharesResult.data ?? []) {
        if (s.expires_at && new Date(s.expires_at).getTime() <= now) continue;

        parentInherited.canView ||= s.can_view;
        parentInherited.canCreate ||= s.can_create;
        parentInherited.canDelete ||= s.can_delete;
      }
    }

    // Direct shares on each child — one IN query.
    const childIds = children.map((c) => c.id);
    const directSharesResult = await this.db
      .from('fe_shares')
      .select('node_id, can_view, can_create, can_delete, expires_at')
      .eq('share_type', 'user')
      .eq('shared_with_id', user.userId)
      .eq('is_active', true)
      .in('node_id', childIds);

    const now = Date.now();
    const directMap = new Map<string, FeEffectivePermission>();

    for (const s of directSharesResult.data ?? []) {
      if (s.expires_at && new Date(s.expires_at).getTime() <= now) continue;

      const existing = directMap.get(s.node_id) ?? {
        canView: false,
        canCreate: false,
        canDelete: false,
      };

      directMap.set(s.node_id, {
        canView: existing.canView || s.can_view,
        canCreate: existing.canCreate || s.can_create,
        canDelete: existing.canDelete || s.can_delete,
      });
    }

    // Union per child: space ∪ parent-inherited ∪ direct.
    for (const child of children) {
      const direct = directMap.get(child.id) ?? DENY;

      result.set(child.id, {
        canView: spacePerm.canView || parentInherited.canView || direct.canView,
        canCreate:
          spacePerm.canCreate || parentInherited.canCreate || direct.canCreate,
        canDelete:
          spacePerm.canDelete || parentInherited.canDelete || direct.canDelete,
      });
    }

    return result;
  }

  /**
   * Resolve public link share by token. Does NOT check password — caller handles that.
   * Returns null if the token is invalid, revoked, or expired (callers 404).
   */
  async resolvePublicShare(
    token: string,
  ): Promise<{ share: IFeShare; node: IFeNode } | null> {
    const shareResult = await this.db
      .from('fe_shares')
      .select('*')
      .eq('token', token)
      .eq('share_type', 'link')
      .eq('is_active', true)
      .maybeSingle();

    if (!shareResult.data) return null;

    const share = shareResult.data as IFeShare;

    // Read-time expiry.
    if (
      share.expires_at &&
      new Date(share.expires_at).getTime() <= Date.now()
    ) {
      return null;
    }

    const nodeResult = await this.db
      .from('fe_nodes')
      .select('*')
      .eq('id', share.node_id)
      .eq('is_deleted', false)
      .maybeSingle();

    if (!nodeResult.data) return null;

    return { share, node: nodeResult.data as IFeNode };
  }
}
