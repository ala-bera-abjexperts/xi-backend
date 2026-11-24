/** @fileoverview Enqueues durable rows into the workflow_outbox table for the drain processor. @module src/workflow-outbox/workflow-outbox.service @author Rajbha Manek */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';

/** The discriminator values the drain processor recognises. */
export type OutboxRuleType =
  | 'send_notification'
  | 'trigger_webhook'
  | 'fire_event';

/** Arguments for enqueueing a single outbox row. */
export interface EnqueueOutboxArgs {
  organizationId: string;
  taskId: string;
  transitionId: string | null;
  ruleType: OutboxRuleType;
  payload: Record<string, unknown>;
}

/**
 * Service responsible for inserting outbox rows. Kept intentionally tiny — the
 * heavy lifting happens in the cron processor and per-rule dispatchers.
 */
@Injectable()
export class WorkflowOutboxService {
  private static readonly TABLE = 'workflow_outbox';

  private readonly logger = new Logger(WorkflowOutboxService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Insert one outbox row to be drained by the cron processor. The row starts
   * as `status='pending'` with `next_attempt_at=now()` so the next tick can
   * pick it up.
   *
   * @returns The new row's id so callers can audit-log the enqueue.
   */
  async enqueue(args: EnqueueOutboxArgs): Promise<{ id: string }> {
    const row = {
      organization_id: args.organizationId,
      task_id: args.taskId,
      transition_id: args.transitionId,
      rule_type: args.ruleType,
      payload: args.payload,
      status: 'pending' as const,
      attempt_count: 0,
      next_attempt_at: new Date().toISOString(),
    };

    const { data, error } = await this.client
      .from(WorkflowOutboxService.TABLE)
      .insert(row)
      .select('id')
      .single();

    if (error) {
      this.logger.error(
        `Failed to enqueue workflow_outbox row: ${error.message}`,
      );
      throw new BadRequestException(error.message);
    }

    return { id: (data as { id: string }).id };
  }
}
