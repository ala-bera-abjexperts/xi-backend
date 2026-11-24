import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { UpsertUserTimeSettingsDto } from './dto/upsert-user-time-settings.dto';

export interface UserTimeSettings {
  id: string;
  user_id: string;
  reminder_enabled: boolean;
  reminder_time: string;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class UserTimeSettingsService {
  private static readonly TABLE = 'user_time_settings';

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  async getSettings(userId: string): Promise<UserTimeSettings | null> {
    const utsGet = (await this.client
      .from(UserTimeSettingsService.TABLE)
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()) as {
      data: UserTimeSettings | null;
      error: { message: string } | null;
    };

    if (utsGet.error)
      throw new InternalServerErrorException(utsGet.error.message);

    return utsGet.data;
  }

  async upsertSettings(
    userId: string,
    organizationId: string,
    dto: UpsertUserTimeSettingsDto,
  ): Promise<UserTimeSettings> {
    const utsUpsert = (await this.client
      .from(UserTimeSettingsService.TABLE)
      .upsert(
        {
          user_id: userId,
          reminder_enabled: dto.reminder_enabled,
          reminder_time: dto.reminder_time,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      )
      .select('*')
      .single()) as {
      data: UserTimeSettings | null;
      error: { message: string } | null;
    };
    const { data, error } = utsUpsert;

    if (error) throw new BadRequestException(error.message);

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'user_time_settings',
      (data as UserTimeSettings).id,
      'update',
      {
        reminder_enabled: dto.reminder_enabled,
        reminder_time: dto.reminder_time,
      },
    );

    return data as UserTimeSettings;
  }
}
