import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { SaveTaskSidebarPreferencesDto } from './dto/save-task-sidebar-preferences.dto';
import {
  TASK_SIDEBAR_SETTINGS_KEY,
  getTaskSidebarViewId,
  toTaskSidebarConfig,
  type TaskSidebarConfig,
} from './task-sidebar-preferences.constants';

interface SpaceRow {
  id: string;
  organization_id: string;
  settings: Record<string, unknown> | null;
}

export interface TaskSidebarPreferencesResponse {
  space_id: string;
  default_config: TaskSidebarConfig;
  user_config: TaskSidebarConfig | null;
  effective_config: TaskSidebarConfig;
  is_personalized: boolean;
  can_manage_default: boolean;
}

@Injectable()
export class TaskSidebarPreferencesService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissionsService: PermissionsService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  async getPreferences(
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<TaskSidebarPreferencesResponse> {
    const space = await this.getSpaceOrThrow(spaceId, organizationId);
    const defaultConfig = this.readDefaultConfig(space.settings);
    const userConfig = await this.readUserConfig(
      spaceId,
      organizationId,
      userId,
    );

    return {
      space_id: spaceId,
      default_config: defaultConfig,
      user_config: userConfig,
      effective_config: userConfig ?? defaultConfig,
      is_personalized: Boolean(userConfig),
      can_manage_default: await this.canManageDefault(
        spaceId,
        organizationId,
        userId,
      ),
    };
  }

  async saveUserPreferences(
    spaceId: string,
    organizationId: string,
    userId: string,
    dto: SaveTaskSidebarPreferencesDto,
  ): Promise<TaskSidebarPreferencesResponse> {
    await this.getSpaceOrThrow(spaceId, organizationId);

    const client = this.supabaseAdmin.getClient();
    const config = toTaskSidebarConfig(dto.properties);
    const { error } = await client.from('user_column_preferences').upsert(
      {
        user_id: userId,
        organization_id: organizationId,
        view_id: getTaskSidebarViewId(spaceId),
        column_config: config.properties,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,organization_id,view_id' },
    );

    if (error) {
      throw new BadRequestException('Failed to save task sidebar preferences');
    }

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'user_preference',
      userId,
      'update',
      { action: 'save_task_sidebar_preferences', space_id: spaceId },
    );

    return this.getPreferences(spaceId, organizationId, userId);
  }

  async resetUserPreferences(
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<TaskSidebarPreferencesResponse> {
    await this.getSpaceOrThrow(spaceId, organizationId);

    const client = this.supabaseAdmin.getClient();
    const { error } = await client
      .from('user_column_preferences')
      .delete()
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .eq('view_id', getTaskSidebarViewId(spaceId));

    if (error) {
      throw new BadRequestException('Failed to reset task sidebar preferences');
    }

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'user_preference',
      userId,
      'delete',
      { action: 'reset_task_sidebar_preferences', space_id: spaceId },
    );

    return this.getPreferences(spaceId, organizationId, userId);
  }

  async saveDefaultPreferences(
    spaceId: string,
    organizationId: string,
    userId: string,
    dto: SaveTaskSidebarPreferencesDto,
  ): Promise<TaskSidebarPreferencesResponse> {
    const space = await this.getSpaceOrThrow(spaceId, organizationId);
    const settings = {
      ...(space.settings ?? {}),
      [TASK_SIDEBAR_SETTINGS_KEY]: toTaskSidebarConfig(dto.properties),
    };

    await this.updateSpaceSettings(spaceId, organizationId, settings);

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'space',
      spaceId,
      'update',
      { action: 'save_task_sidebar_default' },
    );

    return this.getPreferences(spaceId, organizationId, userId);
  }

  async resetDefaultPreferences(
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<TaskSidebarPreferencesResponse> {
    const space = await this.getSpaceOrThrow(spaceId, organizationId);
    const settings = { ...(space.settings ?? {}) };

    delete settings[TASK_SIDEBAR_SETTINGS_KEY];

    await this.updateSpaceSettings(spaceId, organizationId, settings);

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'space',
      spaceId,
      'update',
      { action: 'reset_task_sidebar_default' },
    );

    return this.getPreferences(spaceId, organizationId, userId);
  }

  private async getSpaceOrThrow(
    spaceId: string,
    organizationId: string,
  ): Promise<SpaceRow> {
    const client = this.supabaseAdmin.getClient();
    const { data, error } = await client
      .from('spaces')
      .select('id, organization_id, settings')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException('Failed to load space');
    }

    if (!data) {
      throw new NotFoundException('Space not found');
    }

    return data as SpaceRow;
  }

  private async readUserConfig(
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<TaskSidebarConfig | null> {
    const client = this.supabaseAdmin.getClient();
    const { data, error } = await client
      .from('user_column_preferences')
      .select('column_config')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .eq('view_id', getTaskSidebarViewId(spaceId))
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        'Failed to load task sidebar preferences',
      );
    }

    if (!data) return null;

    return toTaskSidebarConfig(
      (data as { column_config?: unknown }).column_config,
    );
  }

  private readDefaultConfig(
    settings: Record<string, unknown> | null,
  ): TaskSidebarConfig {
    const taskSidebarSettings = settings?.[TASK_SIDEBAR_SETTINGS_KEY] as
      | { properties?: unknown }
      | undefined;

    return toTaskSidebarConfig(taskSidebarSettings?.properties);
  }

  private async updateSpaceSettings(
    spaceId: string,
    organizationId: string,
    settings: Record<string, unknown>,
  ): Promise<void> {
    const client = this.supabaseAdmin.getClient();
    const { error } = await client
      .from('spaces')
      .update({ settings, updated_at: new Date().toISOString() })
      .eq('id', spaceId)
      .eq('organization_id', organizationId);

    if (error) {
      throw new BadRequestException('Failed to save task sidebar default');
    }
  }

  private async canManageDefault(
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<boolean> {
    const permissions = await this.permissionsService.getUserSpacePermissions(
      userId,
      organizationId,
      spaceId,
    );

    return permissions.permissions['edit_space_settings'] === true;
  }
}
