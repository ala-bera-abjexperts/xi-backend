import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { FileExplorerAccessService } from '../file-explorer/file-explorer-access.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { IFeNode } from '../file-explorer/interfaces/fe-node.interface';
import {
  isTestManagementAttachmentType,
  TestManagementAttachmentAccessService,
} from '../test-management/access/test-management-attachment-access.service';
import type {
  AttachmentEntityType,
  SpaceAttachmentEntityType,
} from './dto/list-attachments-query.dto';

const SELECT_LINK_WITH_NODE = `
  *,
  node:fe_nodes(*)
`;

const ENTITY_TABLE_MAP: Record<
  SpaceAttachmentEntityType,
  { table: string; spaceCol: string; orgCol: string; ownerCol?: string }
> = {
  task: { table: 'tasks', spaceCol: 'space_id', orgCol: 'organization_id' },
  process: {
    table: 'business_processes',
    spaceCol: 'space_id',
    orgCol: 'organization_id',
  },
  wiki_page: {
    table: 'wiki_pages',
    spaceCol: 'space_id',
    orgCol: 'organization_id',
  },
  asset_item: {
    table: 'asset_items',
    spaceCol: 'space_id',
    orgCol: 'organization_id',
  },
  space_gdpr_record: {
    table: 'space_gdpr_records',
    spaceCol: 'spaceid',
    orgCol: 'organizationid',
  },
  support_request: {
    table: 'support_requests',
    spaceCol: 'space_id',
    orgCol: 'organization_id',
    ownerCol: 'created_by',
  },
  asset_object: {
    table: 'asset_objects',
    spaceCol: 'space_id',
    orgCol: 'organization_id',
  },
};

const ENTITY_PERMISSION_MAP: Record<
  SpaceAttachmentEntityType,
  { view: string; upload: string; delete: string }
> = {
  task: {
    view: 'view_tasks',
    upload: 'add_attachments_tasks',
    delete: 'delete_attachments_tasks',
  },
  process: {
    view: 'view_processes',
    upload: 'add_attachments_processes',
    delete: 'delete_attachments_processes',
  },
  wiki_page: {
    view: 'view_wiki_pages',
    upload: 'add_attachments_wiki',
    delete: 'delete_attachments_wiki',
  },
  asset_item: {
    view: 'view_lists',
    upload: 'add_attachments_lists',
    delete: 'delete_attachments_lists',
  },
  space_gdpr_record: {
    view: 'view_gdpr',
    upload: 'add_attachments_gdpr',
    delete: 'delete_attachments_gdpr',
  },
  support_request: {
    view: 'support_request_owner',
    upload: 'support_request_owner',
    delete: 'support_request_owner',
  },
  asset_object: {
    view: 'view_assets',
    upload: 'edit_assets',
    delete: 'edit_assets',
  },
};

interface EntityContext {
  organizationId: string;
  spaceId: string | null;
  ownerId: string | null;
}

export interface EntityFileLink {
  id: string;
  organization_id: string;
  space_id: string;
  entity_type: AttachmentEntityType;
  entity_id: string;
  node_id: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  node?: IFeNode | null;
}

@Injectable()
export class EntityFileLinksService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissionsService: PermissionsService,
    private readonly fileExplorerAccess: FileExplorerAccessService,
    /** Test Management evidence access; absent = those links fail closed (403). */
    @Optional()
    private readonly testManagementAccess?: TestManagementAttachmentAccessService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async listForEntity(args: {
    user: RequestUser;
    entityType: AttachmentEntityType;
    entityId: string;
  }): Promise<EntityFileLink[]> {
    const ctx = await this.verifyAndResolve({
      ...args,
      action: 'view',
    });

    const { data, error } = (await this.client
      .from('entity_file_links')
      .select(SELECT_LINK_WITH_NODE)
      .eq('organization_id', ctx.organizationId)
      .eq('entity_type', args.entityType)
      .eq('entity_id', args.entityId)
      .order('created_at', { ascending: false })) as {
      data: EntityFileLink[] | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);

    const rows = data ?? [];
    const visible: EntityFileLink[] = [];

    for (const row of rows) {
      const node = row.node;

      if (
        !node ||
        node.is_deleted ||
        node.organization_id !== ctx.organizationId
      ) {
        continue;
      }

      const permission =
        await this.fileExplorerAccess.resolveEffectivePermission(
          args.user,
          node,
        );

      if (permission.canView) {
        visible.push(row);
      }
    }

    return visible;
  }

  async create(args: {
    user: RequestUser;
    entityType: AttachmentEntityType;
    entityId: string;
    nodeId: string;
  }): Promise<EntityFileLink> {
    const ctx = await this.verifyAndResolve({
      user: args.user,
      entityType: args.entityType,
      entityId: args.entityId,
      action: 'upload',
    });

    if (!ctx.spaceId) {
      throw new BadRequestException(
        'File Explorer links require a space-scoped entity',
      );
    }

    const node = await this.findAccessibleNode(args.user, args.nodeId);

    if (
      node.organization_id !== ctx.organizationId ||
      node.space_id !== ctx.spaceId
    ) {
      throw new BadRequestException(
        'Can only link File Explorer items from the same space',
      );
    }

    const input = {
      organization_id: ctx.organizationId,
      space_id: ctx.spaceId,
      entity_type: args.entityType,
      entity_id: args.entityId,
      node_id: args.nodeId,
      created_by: args.user.userId,
    };

    const { data, error } = (await this.client
      .from('entity_file_links')
      .insert(input)
      .select(SELECT_LINK_WITH_NODE)
      .single()) as {
      data: EntityFileLink | null;
      error: { code?: string; message: string } | null;
    };

    if (error) {
      if (this.isUniqueConflict(error)) {
        const existing = await this.findByEntityAndNode({
          organizationId: ctx.organizationId,
          entityType: args.entityType,
          entityId: args.entityId,
          nodeId: args.nodeId,
        });

        if (existing) return existing;
      }

      throw new BadRequestException(error.message);
    }

    if (!data) {
      throw new BadRequestException('Failed to link File Explorer item');
    }

    return data;
  }

  async remove(args: {
    user: RequestUser;
    linkId: string;
  }): Promise<{ success: true }> {
    const link = await this.findById(args.linkId);

    await this.verifyAndResolve({
      user: args.user,
      entityType: link.entity_type,
      entityId: link.entity_id,
      action: 'delete',
    });

    const { error } = await this.client
      .from('entity_file_links')
      .delete()
      .eq('id', args.linkId);

    if (error) throw new BadRequestException(error.message);

    return { success: true };
  }

  private async verifyAndResolve(args: {
    user: RequestUser;
    entityType: AttachmentEntityType;
    entityId: string;
    action: 'view' | 'upload' | 'delete';
  }): Promise<EntityContext> {
    if (args.entityType === 'chat_message') {
      throw new BadRequestException(
        'File Explorer links are not supported for chat messages',
      );
    }

    // Test Management evidence follows the module's own permission and lifecycle rules.
    if (isTestManagementAttachmentType(args.entityType)) {
      if (!this.testManagementAccess) {
        throw new ForbiddenException(
          'Test Management permissions are unavailable; refusing file link access',
        );
      }

      return this.testManagementAccess.resolveAttachmentAccess(
        args.user,
        args.entityType,
        args.entityId,
        args.action,
      );
    }

    const ctx = await this.resolveEntityContext(args.entityType, args.entityId);

    if (!ctx || ctx.organizationId !== args.user.organizationId) {
      throw new NotFoundException(`${args.entityType} not found`);
    }

    if (args.entityType === 'support_request') {
      if (ctx.ownerId === args.user.userId || this.isOrgPower(args.user, ctx)) {
        return ctx;
      }

      throw new ForbiddenException(
        `You do not have permission to ${args.action} file links`,
      );
    }

    if (!ctx.spaceId) {
      throw new ForbiddenException('Entity is not associated with a space');
    }

    // Org owners/admins always pass, mirroring SpacePermissionsGuard's
    // unconditional admin/owner bypass that protects every other asset-object
    // (and task/process/wiki/...) endpoint, and matching the isOrgPower bypass
    // the support_request branch above already applies. Without this, an org
    // owner/admin who is an explicit low-role space member (e.g. viewer) would
    // be blocked from linking files here while still being allowed to manage
    // the same entity's regular attachments — an inconsistency, not intent.
    if (this.isOrgPower(args.user, ctx)) {
      return ctx;
    }

    const permissions = await this.permissionsService.getUserSpacePermissions(
      args.user.userId,
      args.user.organizationId,
      ctx.spaceId,
    );
    const permissionKey = ENTITY_PERMISSION_MAP[args.entityType][args.action];

    if (
      !permissions.isMember ||
      permissions.permissions[permissionKey] !== true
    ) {
      throw new ForbiddenException(
        `You do not have permission to ${args.action} file links`,
      );
    }

    return ctx;
  }

  private async resolveEntityContext(
    entityType: SpaceAttachmentEntityType,
    entityId: string,
  ): Promise<EntityContext | null> {
    const meta = ENTITY_TABLE_MAP[entityType];
    const ownerSelect = meta.ownerCol ? `, ${meta.ownerCol}` : '';
    const { data, error } = await this.client
      .from(meta.table)
      .select(`${meta.spaceCol}, ${meta.orgCol}${ownerSelect}`)
      .eq('id', entityId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) return null;

    const row = data as unknown as Record<string, string | null>;

    return {
      organizationId: row[meta.orgCol] as string,
      spaceId: row[meta.spaceCol] ?? null,
      ownerId: meta.ownerCol ? (row[meta.ownerCol] ?? null) : null,
    };
  }

  private async findAccessibleNode(
    user: RequestUser,
    nodeId: string,
  ): Promise<IFeNode> {
    const nodeResult = (await this.client
      .from('fe_nodes')
      .select('*')
      .eq('id', nodeId)
      .eq('is_deleted', false)
      .maybeSingle()) as {
      data: IFeNode | null;
      error: { message: string } | null;
    };

    if (nodeResult.error) {
      throw new BadRequestException(nodeResult.error.message);
    }

    if (!nodeResult.data) {
      throw new NotFoundException('File Explorer item not found');
    }

    const node = nodeResult.data;
    const permission = await this.fileExplorerAccess.resolveEffectivePermission(
      user,
      node,
    );

    if (!permission.canView) {
      throw new NotFoundException('File Explorer item not found');
    }

    return node;
  }

  private async findByEntityAndNode(args: {
    organizationId: string;
    entityType: AttachmentEntityType;
    entityId: string;
    nodeId: string;
  }): Promise<EntityFileLink | null> {
    const { data, error } = (await this.client
      .from('entity_file_links')
      .select(SELECT_LINK_WITH_NODE)
      .eq('organization_id', args.organizationId)
      .eq('entity_type', args.entityType)
      .eq('entity_id', args.entityId)
      .eq('node_id', args.nodeId)
      .maybeSingle()) as {
      data: EntityFileLink | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);

    return data ?? null;
  }

  private async findById(linkId: string): Promise<EntityFileLink> {
    const { data, error } = (await this.client
      .from('entity_file_links')
      .select(SELECT_LINK_WITH_NODE)
      .eq('id', linkId)
      .maybeSingle()) as {
      data: EntityFileLink | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('File link not found');

    return data;
  }

  private isOrgPower(user: RequestUser, ctx: EntityContext): boolean {
    const membership = user.memberships?.find(
      (member) => member.organizationId === ctx.organizationId,
    );

    return membership?.role === 'owner' || membership?.role === 'admin';
  }

  private isUniqueConflict(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;

    const error = err as {
      code?: string;
      statusCode?: string | number;
      message?: string;
    };

    if (error.code === '23505') return true;

    const status =
      typeof error.statusCode === 'string'
        ? Number.parseInt(error.statusCode, 10)
        : error.statusCode;

    if (status === 409) return true;

    return (
      typeof error.message === 'string' &&
      /already exists|duplicate/i.test(error.message)
    );
  }
}
