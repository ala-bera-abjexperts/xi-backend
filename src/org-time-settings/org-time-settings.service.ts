import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { UpsertOrgTimeSettingsDto } from './dto/upsert-org-time-settings.dto';

export interface OrgTimeSettings {
  id: string;
  organization_id: string;
  reminder_enabled: boolean;
  reminder_time: string;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class OrgTimeSettingsService {
  private static readonly TABLE = 'organization_time_settings';

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  async getSettings(organizationId: string): Promise<OrgTimeSettings | null> {
    if (!organizationId) return null;

    const result = (await this.client
      .from(OrgTimeSettingsService.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .maybeSingle()) as {
      data: OrgTimeSettings | null;
      error: { message: string } | null;
    };

    if (result.error)
      throw new InternalServerErrorException(result.error.message);

    return result.data;
  }

  async upsertSettings(
    organizationId: string,
    userId: string,
    dto: UpsertOrgTimeSettingsDto,
  ): Promise<OrgTimeSettings> {
    if (!organizationId)
      throw new BadRequestException('User has no organization');

    const result2 = (await this.client
      .from(OrgTimeSettingsService.TABLE)
      .upsert(
        {
          organization_id: organizationId,
          reminder_enabled: dto.reminder_enabled,
          reminder_time: dto.reminder_time,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id' },
      )
      .select('*')
      .single()) as {
      data: OrgTimeSettings | null;
      error: { message: string } | null;
    };

    const { data, error } = result2;

    if (error) throw new BadRequestException(error.message);

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'organization_time_settings',
      (data as OrgTimeSettings).id,
      'update',
      {
        reminder_enabled: dto.reminder_enabled,
        reminder_time: dto.reminder_time,
      },
    );

    return data as OrgTimeSettings;
  }
}
