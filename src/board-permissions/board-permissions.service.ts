import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { GrantBoardPermissionDto } from './dto/grant-board-permission.dto';
import { BoardPermissionLevel } from './dto/grant-board-permission.dto';
import type { UpdateBoardPermissionDto } from './dto/update-board-permission.dto';

const TABLE = 'board_permissions';

@Injectable()
export class BoardPermissionsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissionsService: PermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async verifyBoard(
    boardId: string,
    organizationId: string,
  ): Promise<{ id: string; space_id: string }> {
    const { data, error } = await this.client
      .from('boards')
      .select('id, space_id')
      .eq('id', boardId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Board not found');
    return data as { id: string; space_id: string };
  }

  private async assertBoardAdmin(
    boardId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const board = await this.verifyBoard(boardId, organizationId);

    const resolved = await this.permissionsService.getUserSpacePermissions(
      userId,
      organizationId,
      board.space_id,
    );

    if (resolved.permissions['delete_boards'] === true) return;

    const { data: permission, error } = await this.client
      .from(TABLE)
      .select('permission_level')
      .eq('board_id', boardId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (
      (permission as { permission_level?: string } | null)?.permission_level ===
      'admin'
    ) {
      return;
    }

    throw new ForbiddenException(
      'You do not have admin permission on this board',
    );
  }

  async getAll(
    boardId: string,
    organizationId: string,
    actorUserId: string,
  ): Promise<{ data: Record<string, unknown>[]; count: number }> {
    await this.assertBoardAdmin(boardId, organizationId, actorUserId);

    const { data, error } = await this.client
      .from(TABLE)
      .select(
        `*, user:users!board_permissions_user_id_fkey (id, first_name, last_name, email, avatar_url)`,
      )
      .eq('board_id', boardId);

    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    return { data: rows, count: rows.length };
  }

  async grant(
    boardId: string,
    organizationId: string,
    dto: GrantBoardPermissionDto,
    actorUserId?: string,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    if (!actorUserId) throw new ForbiddenException('Permission denied');
    await this.assertBoardAdmin(boardId, organizationId, actorUserId);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        board_id: boardId,
        user_id: dto.user_id,
        permission_level: dto.permission_level ?? BoardPermissionLevel.VIEW,
      })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    const permission = data as Record<string, unknown>;
    void this.logAudit(
      organizationId,
      actorUserId,
      permission.id as string,
      'create',
      {
        scope: 'board_permission',
        board_id: boardId,
        user_id: dto.user_id,
        permission_level: dto.permission_level ?? BoardPermissionLevel.VIEW,
      },
    );
    return { data: permission, success: true };
  }

  async update(
    permissionId: string,
    boardId: string,
    organizationId: string,
    dto: UpdateBoardPermissionDto,
    actorUserId?: string,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    if (!actorUserId) throw new ForbiddenException('Permission denied');
    await this.assertBoardAdmin(boardId, organizationId, actorUserId);

    const { data: existing, error: findError } = await this.client
      .from(TABLE)
      .select('id')
      .eq('id', permissionId)
      .eq('board_id', boardId)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Permission not found');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({
        permission_level: dto.permission_level,
        updated_at: new Date().toISOString(),
      })
      .eq('id', permissionId)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    const permission = data as Record<string, unknown>;
    void this.logAudit(organizationId, actorUserId, permissionId, 'update', {
      scope: 'board_permission',
      board_id: boardId,
      permission_level: dto.permission_level,
    });
    return { data: permission, success: true };
  }

  async revoke(
    permissionId: string,
    boardId: string,
    organizationId: string,
    actorUserId?: string,
  ): Promise<{ success: true; message: string }> {
    if (!actorUserId) throw new ForbiddenException('Permission denied');
    await this.assertBoardAdmin(boardId, organizationId, actorUserId);

    const { data: existing, error: findError } = await this.client
      .from(TABLE)
      .select('id')
      .eq('id', permissionId)
      .eq('board_id', boardId)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Permission not found');

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', permissionId);

    if (error) throw new BadRequestException(error.message);
    void this.logAudit(organizationId, actorUserId, permissionId, 'delete', {
      scope: 'board_permission',
      board_id: boardId,
    });
    return { success: true, message: 'Permission revoked' };
  }

  private async logAudit(
    organizationId: string,
    actorUserId: string | undefined,
    entityId: string,
    action: 'create' | 'update' | 'delete',
    changes: Record<string, unknown>,
  ): Promise<void> {
    if (!actorUserId) return;

    try {
      await this.client.from('audit_logs').insert({
        organization_id: organizationId,
        user_id: actorUserId,
        entity_type: 'permission',
        entity_id: entityId,
        action,
        changes,
      });
    } catch {
      // Audit is best-effort and must not break board permission mutations.
    }
  }
}
