import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import type { CreateTimeEntryDto } from './dto/create-time-entry.dto';
import type { UpdateTimeEntryDto } from './dto/update-time-entry.dto';

export interface TimeEntry {
  id: string;
  task_id: string;
  user_id: string;
  organization_id: string;
  duration_minutes: number;
  started_at: string | null;
  logged_at: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface TimeEntryWithUser extends TimeEntry {
  user?: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string;
    avatar_url: string | null;
  } | null;
  task?: {
    id: string;
    key: string;
    summary: string;
    status: string | null;
  } | null;
}

const USER_SELECT =
  'user:users!time_entries_user_id_fkey(id, first_name, last_name, email, avatar_url)';
const TASK_SELECT =
  'task:tasks!time_entries_task_id_fkey(id, key, summary, status)';
const FULL_SELECT = `*, ${USER_SELECT}`;
const WITH_TASK_SELECT = `*, ${USER_SELECT}, ${TASK_SELECT}`;

@Injectable()
export class TimeEntriesService {
  private static readonly TABLE = 'time_entries';

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
    @Optional() private readonly outboxService?: AutomationEventOutboxService,
  ) {}

  async getEntriesForTask(
    taskId: string,
    organizationId: string,
  ): Promise<TimeEntryWithUser[]> {
    const { data, error } = await this.client
      .from(TimeEntriesService.TABLE)
      .select(FULL_SELECT)
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      .order('logged_at', { ascending: false });

    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as TimeEntryWithUser[];
  }

  async getEntriesForUser(
    userId: string,
    organizationId: string,
  ): Promise<TimeEntryWithUser[]> {
    const { data, error } = await this.client
      .from(TimeEntriesService.TABLE)
      .select(WITH_TASK_SELECT)
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .order('logged_at', { ascending: false });

    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as TimeEntryWithUser[];
  }

  async createEntry(
    dto: CreateTimeEntryDto,
    userId: string,
    organizationId: string,
  ): Promise<TimeEntryWithUser> {
    const taskId = dto.task_id ?? dto.taskId;
    if (!taskId) throw new BadRequestException('task_id is required');

    await this.assertTaskInOrganization(taskId, organizationId);

    const teInsert = (await this.client
      .from(TimeEntriesService.TABLE)
      .insert({
        task_id: taskId,
        user_id: userId,
        organization_id: organizationId,
        duration_minutes: dto.duration_minutes,
        note: dto.note ?? null,
        started_at: dto.started_at ?? null,
        logged_at: dto.logged_at ?? new Date().toISOString(),
      })
      .select(FULL_SELECT)
      .single()) as {
      data: TimeEntryWithUser | null;
      error: { message: string } | null;
    };
    const { data, error } = teInsert;

    if (error) throw new BadRequestException(error.message);

    await this.syncActualTime(taskId);

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'time_entry',
      (data as TimeEntryWithUser).id,
      'create',
      {
        task_id: taskId,
        duration_minutes: dto.duration_minutes,
        logged_at: dto.logged_at ?? null,
      },
    );

    // Emit automation event for time logged
    void (async () => {
      const taskRes = await this.client
        .from('tasks')
        .select('key, summary, status, priority, assigned_to, space_id')
        .eq('id', taskId)
        .maybeSingle();
      const t = taskRes.data as {
        key?: string;
        summary?: string;
        status?: string;
        priority?: string;
        assigned_to?: string | null;
        space_id?: string;
      } | null;

      void this.outboxService?.write(
        organizationId,
        t?.space_id ?? null,
        'app.task.time_logged',
        {
          task: {
            id: taskId,
            key: t?.key ?? '',
            summary: t?.summary ?? '',
            status: t?.status ?? '',
            priority: t?.priority ?? '',
            assigned_to: t?.assigned_to ?? null,
            space_id: t?.space_id ?? '',
            organization_id: organizationId,
          },
          task_id: taskId,
          timeEntry: {
            id: (data as TimeEntryWithUser).id,
            duration_minutes: dto.duration_minutes,
            description: dto.note ?? null,
            logged_at: dto.logged_at ?? new Date().toISOString(),
          },
          space_id: t?.space_id ?? null,
        },
      );
    })();

    return data as TimeEntryWithUser;
  }

  async updateEntry(
    id: string,
    dto: UpdateTimeEntryDto,
    userId: string,
  ): Promise<TimeEntryWithUser> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundException('Time entry not found');
    if (existing.user_id !== userId)
      throw new ForbiddenException('Time entry not found');

    const updatePayload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (dto.duration_minutes !== undefined)
      updatePayload.duration_minutes = dto.duration_minutes;
    if (dto.note !== undefined) updatePayload.note = dto.note;
    if (dto.logged_at !== undefined) updatePayload.logged_at = dto.logged_at;

    const teUpdate = (await this.client
      .from(TimeEntriesService.TABLE)
      .update(updatePayload)
      .eq('id', id)
      .select(FULL_SELECT)
      .single()) as {
      data: TimeEntryWithUser | null;
      error: { message: string } | null;
    };
    const { data, error } = teUpdate;

    if (error) throw new BadRequestException(error.message);

    await this.syncActualTime(existing.task_id);

    void this.auditLogsService.logAction(
      existing.organization_id,
      userId,
      'time_entry',
      id,
      'update',
      {
        duration_minutes: dto.duration_minutes,
        logged_at: dto.logged_at,
        note_changed: dto.note !== undefined,
      },
    );

    return data as TimeEntryWithUser;
  }

  async deleteEntry(id: string, userId: string): Promise<void> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundException('Time entry not found');
    if (existing.user_id !== userId)
      throw new ForbiddenException('Time entry not found');

    const { error } = await this.client
      .from(TimeEntriesService.TABLE)
      .delete()
      .eq('id', id);

    if (error) throw new BadRequestException(error.message);

    await this.syncActualTime(existing.task_id);

    void this.auditLogsService.logAction(
      existing.organization_id,
      userId,
      'time_entry',
      id,
      'delete',
      {
        task_id: existing.task_id,
        duration_minutes: existing.duration_minutes,
      },
    );
  }

  private async findById(id: string): Promise<TimeEntry | null> {
    const teFindResult = (await this.client
      .from(TimeEntriesService.TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle()) as {
      data: TimeEntry | null;
      error: { message: string } | null;
    };

    if (teFindResult.error)
      throw new InternalServerErrorException(teFindResult.error.message);
    return teFindResult.data;
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

  private async syncActualTime(taskId: string): Promise<void> {
    try {
      const { data } = await this.client
        .from(TimeEntriesService.TABLE)
        .select('duration_minutes')
        .eq('task_id', taskId);

      const total = (data ?? []).reduce(
        (acc, row) => acc + ((row.duration_minutes as number) ?? 0),
        0,
      );

      await this.client
        .from('tasks')
        .update({ actual_time: total })
        .eq('id', taskId);
    } catch {
      // Non-critical: log but don't fail the main operation
    }
  }
}
