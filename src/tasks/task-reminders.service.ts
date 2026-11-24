import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { CreateTaskReminderDto } from './dto/create-task-reminder.dto';
import type { UpdateTaskReminderDto } from './dto/update-task-reminder.dto';

const TABLE = 'task_reminders';

@Injectable()
export class TaskRemindersService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getReminders(
    taskId: string,
  ): Promise<{ data: Record<string, unknown>[]; count: number }> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('task_id', taskId)
      .order('remind_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    return { data: rows, count: rows.length };
  }

  async createReminder(
    taskId: string,
    userId: string,
    dto: CreateTaskReminderDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    if (new Date(dto.remind_at) <= new Date()) {
      throw new BadRequestException('Reminder date must be in the future');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        task_id: taskId,
        user_id: userId,
        remind_at: dto.remind_at,
        reminder_type: dto.reminder_type ?? 'email',
        message: dto.message ?? null,
      })
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to create reminder',
      );
    }

    return { data: data as Record<string, unknown>, success: true };
  }

  async updateReminder(
    reminderId: string,
    taskId: string,
    dto: UpdateTaskReminderDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    if (dto.remind_at && new Date(dto.remind_at) <= new Date()) {
      throw new BadRequestException('Reminder date must be in the future');
    }

    const existing = await this.getById(reminderId, taskId);
    if (!existing) throw new NotFoundException('Reminder not found');

    const patch: Record<string, unknown> = {};
    if (dto.remind_at !== undefined) patch['remind_at'] = dto.remind_at;
    if (dto.reminder_type !== undefined)
      patch['reminder_type'] = dto.reminder_type;
    if (dto.message !== undefined) patch['message'] = dto.message;
    if (dto.is_sent !== undefined) patch['is_sent'] = dto.is_sent;
    if (dto.sent_at !== undefined) patch['sent_at'] = dto.sent_at;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('At least one field must be provided');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', reminderId)
      .eq('task_id', taskId)
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to update reminder',
      );
    }

    return { data: data as Record<string, unknown>, success: true };
  }

  async deleteReminder(
    reminderId: string,
    taskId: string,
  ): Promise<{ success: true; message: string }> {
    const existing = await this.getById(reminderId, taskId);
    if (!existing) throw new NotFoundException('Reminder not found');

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', reminderId)
      .eq('task_id', taskId);

    if (error) throw new BadRequestException(error.message);
    return { success: true, message: 'Reminder deleted successfully' };
  }

  private async getById(reminderId: string, taskId: string) {
    const { data } = await this.client
      .from(TABLE)
      .select('id')
      .eq('id', reminderId)
      .eq('task_id', taskId)
      .maybeSingle();
    return data;
  }
}
