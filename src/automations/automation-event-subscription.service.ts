// Automation event subscriptions — create and manage app-event-based triggers.

import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { IAutomationEventSubscription } from './interfaces/automation.interface';

export type SubscriptionUpsertInput = Omit<
  IAutomationEventSubscription,
  'id' | 'created_at'
>;

@Injectable()
export class AutomationEventSubscriptionService {
  private readonly logger = new Logger(AutomationEventSubscriptionService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async upsert(input: SubscriptionUpsertInput): Promise<void> {
    const { error } = await this.db
      .from('automation_event_subscriptions')
      .upsert(input, { onConflict: 'automation_id,event_kind' });

    if (error) {
      this.logger.error(`upsert failed: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to upsert automation event subscription',
      );
    }
  }

  async deactivateByAutomation(automationId: string): Promise<void> {
    const { error } = await this.db
      .from('automation_event_subscriptions')
      .update({ is_active: false })
      .eq('automation_id', automationId);

    if (error) {
      this.logger.error(`deactivate failed: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to deactivate automation event subscription',
      );
    }
  }

  async activateByAutomation(automationId: string): Promise<void> {
    const { error } = await this.db
      .from('automation_event_subscriptions')
      .update({ is_active: true })
      .eq('automation_id', automationId);

    if (error) {
      this.logger.error(`activate failed: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to activate automation event subscription',
      );
    }
  }

  async deleteByAutomation(automationId: string): Promise<void> {
    const { error } = await this.db
      .from('automation_event_subscriptions')
      .delete()
      .eq('automation_id', automationId);

    if (error) {
      this.logger.error(`deleteByAutomation failed: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to delete automation event subscription',
      );
    }
  }
}
