import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

@Injectable()
export class SlaAccessService {
  constructor(
    private readonly db: SupabaseAdminService,
    private readonly permissions: PermissionsService,
  ) {}

  async authorizeSpace(
    user: RequestUser,
    organizationId: string,
    spaceId: string,
    permission: string,
  ): Promise<void> {
    const { data, error } = await this.db
      .getClient()
      .from('spaces')
      .select('id,organization_id,is_archived,is_active')
      .eq('id', spaceId)
      .maybeSingle();
    if (error) throw new ForbiddenException('Unable to verify space access');
    if (
      !data ||
      data.is_archived === true ||
      data.is_active === false ||
      data.organization_id !== organizationId ||
      data.organization_id !== user.organizationId
    )
      throw new NotFoundException('Space not found');
    const grant = await this.permissions.getUserSpacePermissions(
      user.userId,
      data.organization_id,
      data.id,
    );
    if (!grant.isMember || grant.permissions[permission] !== true)
      throw new ForbiddenException('Insufficient space permissions');
  }

  async authorizeTask(
    user: RequestUser,
    taskId: string,
    permission = 'view_sla',
  ): Promise<Record<string, any>> {
    const { data, error } = await this.db
      .getClient()
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .maybeSingle();
    if (error) throw new ForbiddenException('Unable to verify task access');
    if (!data || data.organization_id !== user.organizationId)
      throw new NotFoundException('Task not found');
    await this.authorizeSpace(
      user,
      data.organization_id,
      data.space_id,
      'view_tasks',
    );
    if (permission !== 'view_tasks')
      await this.authorizeSpace(
        user,
        data.organization_id,
        data.space_id,
        permission,
      );
    return data;
  }
}
