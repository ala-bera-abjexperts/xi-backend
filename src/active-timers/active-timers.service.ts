import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { TimeEntriesService } from '../time-entries/time-entries.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

export interface ActiveTimer {
  id: string;
  user_id: string;
  task_id: string;
  organization_id: string;
  started_at: string;
}

@Injectable()
export class ActiveTimersService {
  private static readonly TABLE = 'active_timers';

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly timeEntriesService: TimeEntriesService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  async getTimer(userId: string): Promise<ActiveTimer | null> {
    const { data, error } = (await this.client
      .from(ActiveTimersService.TABLE)
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()) as {
      data: ActiveTimer | null;
      error: { message: string } | null;
    };

    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  async startTimer(
    userId: string,
    taskId: string,
    organizationId: string,
  ): Promise<ActiveTimer> {
    const existing = await this.getTimer(userId);

    if (existing) {
      if (existing.task_id === taskId) return existing;
      throw new ConflictException(
        'You already have a timer running on another task. Stop it first.',
      );
    }

    await this.assertTaskInOrganization(taskId, organizationId);

    const { data, error } = (await this.client
      .from(ActiveTimersService.TABLE)
      .insert({
        user_id: userId,
        task_id: taskId,
        organization_id: organizationId,
      })
      .select('*')
      .single()) as { data: ActiveTimer; error: { message: string } | null };

    if (error) throw new BadRequestException(error.message);

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'active_timer',
      data.id,
      'create',
      { task_id: taskId },
    );

    return data;
  }

  async stopTimer(
    timerId: string,
    userId: string,
    organizationId: string,
    note?: string,
  ) {
    const timer = await this.getTimer(userId);

    if (!timer || timer.id !== timerId) {
      throw new NotFoundException('Active timer not found');
    }

    const durationMinutes = Math.max(
      1,
      Math.round((Date.now() - new Date(timer.started_at).getTime()) / 60000),
    );

    const entry = await this.timeEntriesService.createEntry(
      {
        task_id: timer.task_id,
        duration_minutes: durationMinutes,
        started_at: timer.started_at,
        logged_at: new Date().toISOString(),
        note: note ?? null,
      },
      userId,
      organizationId,
    );

    const { error } = await this.client
      .from(ActiveTimersService.TABLE)
      .delete()
      .eq('id', timer.id);

    if (error) throw new BadRequestException(error.message);

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'active_timer',
      timer.id,
      'delete',
      {
        task_id: timer.task_id,
        time_entry_id: (entry as { id?: string }).id,
      },
    );

    return entry;
  }

  private async assertTaskInOrganization(
    taskId: string,
    organizationId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('tasks')
      .select('id')
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new BadRequestException('Task not found');
  }
}
