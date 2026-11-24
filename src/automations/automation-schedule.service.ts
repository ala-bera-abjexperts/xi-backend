// Automation schedules — create and manage cron-based automation triggers.

import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { CronExpressionParser } from 'cron-parser';
import type { IAutomationSchedule } from './interfaces/automation.interface';

function computeNextRun(
  cronExpression: string,
  timezone: string,
  after: Date,
): Date {
  const interval = CronExpressionParser.parse(cronExpression, {
    currentDate: after,
    tz: timezone,
  });
  return interval.next().toDate();
}

export interface ScheduleUpsertInput {
  automation_id: string;
  space_id: string;
  cron_expression: string;
  timezone: string;
  next_run_at: string;
  is_active: boolean;
}

@Injectable()
export class AutomationScheduleService {
  private readonly logger = new Logger(AutomationScheduleService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async getByAutomation(
    automationId: string,
  ): Promise<IAutomationSchedule | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.db
      .from('automation_schedules')
      .select('*')
      .eq('automation_id', automationId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      this.logger.error(`getByAutomation failed: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to get automation schedule',
      );
    }

    return data as IAutomationSchedule | null;
  }

  async upsert(input: ScheduleUpsertInput): Promise<IAutomationSchedule> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.db
      .from('automation_schedules')
      .upsert(input, { onConflict: 'automation_id' })
      .select('*')
      .single();

    if (error || !data) {
      this.logger.error(`upsert failed: ${error?.message}`);
      throw new InternalServerErrorException(
        'Failed to upsert automation schedule',
      );
    }

    return data as IAutomationSchedule;
  }

  async deactivate(automationId: string): Promise<void> {
    const { error } = await this.db
      .from('automation_schedules')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('automation_id', automationId);

    if (error) {
      this.logger.error(`deactivate failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to deactivate schedule');
    }
  }

  async activate(automationId: string): Promise<void> {
    const schedule = await this.getByAutomation(automationId);

    if (!schedule)
      throw new NotFoundException('No schedule found for this automation');

    const nextRunAt = computeNextRun(
      schedule.cron_expression,
      schedule.timezone,
      new Date(),
    );

    const { error } = await this.db
      .from('automation_schedules')
      .update({
        is_active: true,
        next_run_at: nextRunAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('automation_id', automationId);

    if (error) {
      this.logger.error(`activate failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to activate schedule');
    }
  }

  async findDue(): Promise<IAutomationSchedule[]> {
    const { data, error } = await this.db
      .from('automation_schedules')
      .select('*')
      .eq('is_active', true)
      .lte('next_run_at', new Date().toISOString());

    if (error) {
      this.logger.error(`findDue failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to find due schedules');
    }

    return (data ?? []) as IAutomationSchedule[];
  }

  async updateNextRunAt(id: string, nextRunAt: Date): Promise<void> {
    const { error } = await this.db
      .from('automation_schedules')
      .update({
        next_run_at: nextRunAt.toISOString(),
        last_run_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      this.logger.error(`updateNextRunAt failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to update next run time');
    }
  }
}
