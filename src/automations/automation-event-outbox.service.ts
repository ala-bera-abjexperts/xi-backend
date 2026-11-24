// Automation event outbox — write app events for the tick's outbox relay.

import { Injectable, Logger, Optional } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AutomationCronService } from './automation-cron.service';

/** The task fields shared by every `app.task.status_changed` producer. */
export interface TaskStatusChangedSnapshot {
  id: string;
  key: string;
  summary: string;
  status: string | null;
  status_id: string | null;
  priority: string | null;
  assigned_to: string | null;
  space_id: string | null;
}

@Injectable()
export class AutomationEventOutboxService {
  private readonly logger = new Logger(AutomationEventOutboxService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly cronService?: AutomationCronService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Writes one event row to `automation_event_outbox`.
   *
   * Always call fire-and-forget: `void this.outboxService.write(...)` so a
   * write failure never blocks the primary operation that produced the event.
   */
  async write(
    organizationId: string,
    spaceId: string | null,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.db.from('automation_event_outbox').insert({
      organization_id: organizationId,
      space_id: spaceId,
      kind,
      payload,
      occurred_at: new Date().toISOString(),
    });

    if (error) {
      this.logger.warn(`outbox write failed [${kind}]: ${error.message}`);
    } else {
      this.cronService?.triggerImmediately();
    }
  }

  /**
   * Publishes the canonical task-status event. Keep the payload here so every
   * status writer gives automations the same contract.
   */
  emitTaskStatusChanged(
    organizationId: string,
    before: Pick<TaskStatusChangedSnapshot, 'status' | 'status_id'>,
    after: TaskStatusChangedSnapshot,
    userId: string,
  ): void {
    void this.write(organizationId, after.space_id, 'app.task.status_changed', {
      task: {
        id: after.id,
        key: after.key,
        summary: after.summary,
        status: after.status,
        priority: after.priority,
        assigned_to: after.assigned_to,
        space_id: after.space_id,
        organization_id: organizationId,
      },
      previousStatus: before.status,
      newStatus: after.status,
      task_id: after.id,
      task_key: after.key,
      space_id: after.space_id,
      old_status_id: before.status_id,
      // Alias matching the trigger-config key `previousStatusId` (snake-cased
      // by the filter matcher): the flat filter loop compares config keys to
      // payload keys, so `previousStatusId` could never match `old_status_id`
      // and a "from status" filter silently never fired.
      previous_status_id: before.status_id,
      new_status_id: after.status_id,
      updated_by: userId,
    });
  }

  /**
   * Publishes the workflow-scoped arrival event.
   *
   * Deliberately separate from `emitTaskStatusChanged`, which fires for a status change by ANY
   * route — a direct edit, a bulk update, a board drag. This one is emitted only by the workflow
   * engine, so an automation on it means "the workflow moved this task here", not merely "the
   * status is now that". Both fire on a workflow transition; that is expected, and an admin picks
   * whichever question they are actually asking.
   *
   * Options object rather than positionals: seven arguments in a row is unreadable at the call
   * site and easy to transpose.
   */
  emitWorkflowStatusReached(input: {
    organizationId: string;
    before: Pick<TaskStatusChangedSnapshot, 'status' | 'status_id'>;
    after: TaskStatusChangedSnapshot;
    workflow: { id: string; name: string };
    transition: { id: string; name: string; to_node_id: string | null };

    /** Resolved destination status — see the call site for why this is not `after.status_id`. */
    newStatusId: string;
    userId: string;
  }): void {
    const {
      organizationId,
      before,
      after,
      workflow,
      transition,
      newStatusId,
      userId,
    } = input;

    void this.write(
      organizationId,
      after.space_id,
      'app.workflow.status_reached',
      {
        task: {
          id: after.id,
          key: after.key,
          summary: after.summary,
          status: after.status,
          priority: after.priority,
          assigned_to: after.assigned_to,
          space_id: after.space_id,
          organization_id: organizationId,
        },
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        transition_id: transition.id,
        transition_name: transition.name,
        to_node_id: transition.to_node_id,
        previous_status: before.status,
        new_status: after.status,
        old_status_id: before.status_id,
        new_status_id: newStatusId,
        task_id: after.id,
        task_key: after.key,
        space_id: after.space_id,
        updated_by: userId,
      },
    );
  }
}
