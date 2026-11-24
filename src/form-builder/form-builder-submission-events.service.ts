import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import {
  FORM_APPROVAL_COMPLETED_EVENT,
  FormBuilderApprovalsService,
} from './form-builder-approvals.service';
// Type-only: both are used solely as annotations, and `ApprovalCompletedEvent` appears in an
// @OnEvent-decorated signature — under isolatedModules + emitDecoratorMetadata that requires `import type`.
import type {
  ApprovalCompletedEvent,
  SubmissionForApproval,
} from './form-builder-approvals.service';
import { FormBuilderWebhookDispatcherService } from './form-builder-webhook-dispatcher.service';
import { FormBuilderIntegrationDispatcherService } from './form-builder-integration-dispatcher.service';
import { FormBuilderTaskCreatorService } from './form-builder-task-creator.service';

const SUBMISSIONS_TABLE = 'form_builder_submissions';

// Emitted by the Stripe webhook (StripeService) after it flips a paid form_builder draft to
// submitted. The webhook cannot call into the form-builder module directly (that would be a
// circular module dependency — see StripeService), so it emits this decoupled event and we
// self-hydrate the submission here.
export const FORM_SUBMISSION_FINALIZED_EVENT =
  'form_builder.submission.finalized';

export interface SubmissionFinalizedEvent {
  submissionId: string;
}

// The single "a submission became final" seam. dispatch() is called directly by the two
// form-builder-owned submit paths (authenticated create + paid finalize); the Stripe webhook
// path arrives via the @OnEvent handler. Both approval-start and webhook-enqueue are
// idempotent, so firing more than once for a submission can never duplicate.
@Injectable()
export class FormBuilderSubmissionEventsService {
  private readonly logger = new Logger(FormBuilderSubmissionEventsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly approvals: FormBuilderApprovalsService,
    private readonly webhooks: FormBuilderWebhookDispatcherService,
    private readonly integrations: FormBuilderIntegrationDispatcherService,
    private readonly taskCreator: FormBuilderTaskCreatorService,

    // Optional so a wiring gap (or the automations module being absent) degrades to "no automation
    // trigger" rather than breaking the submit path.
    @Optional()
    private readonly automationOutbox?: AutomationEventOutboxService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Stamp the task-creation outcome on a submission row. Used for the 'pending_approval' deferral
   * written here in dispatch(); the immediate/deferred create paths write their own outcomes inside
   * FormBuilderTaskCreatorService. Best-effort — its own failure is logged, never thrown.
   */
  private async recordTaskCreationOutcome(
    submissionId: string,
    status: 'created' | 'skipped' | 'failed' | 'pending_approval',
    detail: string | null,
  ): Promise<void> {
    const { error } = await this.client
      .from(SUBMISSIONS_TABLE)
      .update({ task_creation_status: status, task_creation_detail: detail })
      .eq('id', submissionId);

    if (error) {
      this.logger.warn(
        `failed to record task-creation outcome for submission ${submissionId}: ${error.message}`,
      );
    }
  }

  // A task fill creates a ticket only while the integration is on; off stays silent, as before.
  private async maybeCreateTicketForTaskFill(
    row: Record<string, unknown>,
  ): Promise<void> {
    const id = row.id as string | undefined;
    const formId = row.form_id as string | undefined;
    const orgId = row.organization_id as string | undefined;

    // 'skipped' was stamped at insert because the Tasks switch is off.
    if (!id || !formId || !orgId || row.task_creation_status === 'skipped')
      return;

    const { data: form } = await this.client
      .from('form_builder')
      .select('settings')
      .eq('id', formId)
      .maybeSingle();

    const settings = (
      form as { settings?: Record<string, unknown> | null } | null
    )?.settings;
    const integration = (settings?.task_integration ?? {}) as Record<
      string,
      unknown
    >;

    if (!integration.enabled || !integration.target_space_id) return;

    // The creator guards on task_creation_status, so a re-dispatch never makes a second ticket.
    await this.taskCreator.maybeCreateTask(
      formId,
      orgId,
      (row.submitted_by as string | null) ?? null,
      (row.data as Record<string, unknown> | null) ?? {},
      id,
      { hostTaskLinked: true },
    );
  }

  // Best-effort — never throws into the submit path. Takes a full submission row (as returned
  // by the insert/flip) and derives its own tenant scope from the row's columns.
  async dispatch(submissionRow: Record<string, unknown>): Promise<void> {
    try {
      if (submissionRow.is_test === true) return;

      // Already linked to a task: an inline fill ON a task. Only its ticket may be created;
      // approvals, webhooks, integrations and automations stay standalone-only.
      if (submissionRow.task_id) {
        await this.maybeCreateTicketForTaskFill(submissionRow);

        return;
      }

      const spaceId = submissionRow.space_id as string | undefined;
      const orgId = submissionRow.organization_id as string | undefined;
      const id = submissionRow.id as string | undefined;
      const formId = submissionRow.form_id as string | undefined;

      if (!spaceId || !orgId || !id || !formId) return;

      const submission: SubmissionForApproval = {
        id,
        form_id: formId,
        space_id: spaceId,
        organization_id: orgId,
        submitted_by: (submissionRow.submitted_by as string | null) ?? null,
        data: (submissionRow.data as Record<string, unknown> | null) ?? {},
      };
      const ctx = { spaceId, orgId };

      const approvalStarted = await this.approvals.startApproval(
        submission,
        ctx,
      );

      // Outbound webhooks / integrations are independent side-effects. Each is wrapped so a failure
      // in either can NOT abort dispatch before task creation runs (previously an enqueue throw fell
      // through to dispatch's catch and the task was silently never created).
      try {
        await this.webhooks.enqueue(
          { id, form_id: formId },
          'submission.created',
          ctx,
        );
      } catch (err) {
        this.logger.warn(
          `webhook enqueue failed for submission ${id}: ${(err as Error)?.message ?? err}`,
        );
      }

      try {
        await this.integrations.enqueue(
          { id, form_id: formId },
          'submission.created',
          ctx,
        );
      } catch (err) {
        this.logger.warn(
          `integration enqueue failed for submission ${id}: ${(err as Error)?.message ?? err}`,
        );
      }

      // When an approval is pending, defer task creation until the final layer approves (see
      // handleApprovalCompleted) and record the deferral so the owner sees it is awaiting approval
      // rather than a silent no-task. Otherwise create the task immediately, as before.
      // Skipped at insert (this surface's ticket switch is off): keep that outcome, create nothing.
      if (submissionRow.task_creation_status === 'skipped') {
        this.logger.debug(
          `submission ${id}: ticket creation is off for its surface`,
        );
      } else if (approvalStarted) {
        await this.recordTaskCreationOutcome(
          id,
          'pending_approval',
          'Awaiting approval before the task is created',
        );
      } else {
        await this.taskCreator.maybeCreateTask(
          formId,
          orgId,
          submission.submitted_by,
          submission.data ?? {},
          id,
        );
      }

      // Publish an automation event so a "Form submitted" trigger can fire (→ e.g. send the data to
      // an external REST API via the outbound-webhook action). Fire-and-forget in its own catch so a
      // failed outbox write can never affect the four consumers above or the submit path. `is_test`
      // was already skipped at the top of dispatch(). Top-level `formId` is the deterministic filter
      // target; optional columns are read defensively (`?? null`) since `submissionRow` may come from
      // a narrower `.select()` on either insert path.
      if (this.automationOutbox) {
        void this.automationOutbox
          .write(orgId, spaceId, 'app.form.submitted', {
            formId,
            spaceId,
            organizationId: orgId,
            submission: {
              id,
              form_id: formId,
              submitted_by: submission.submitted_by,
              status: (submissionRow.status as string | undefined) ?? null,
              created_at:
                (submissionRow.created_at as string | undefined) ?? null,
              data: submission.data ?? {},
              field_snapshot: submissionRow.field_snapshot ?? null,
            },
          })
          .catch((err: unknown) =>
            this.logger.warn(
              `form.submitted automation emit failed: ${(err as Error)?.message ?? err}`,
            ),
          );
      }
    } catch (err) {
      this.logger.warn(
        `submission dispatch failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  @OnEvent(FORM_SUBMISSION_FINALIZED_EVENT, { async: true })
  async handleFinalized(payload: SubmissionFinalizedEvent): Promise<void> {
    try {
      if (!payload?.submissionId) return;

      const { data, error } = await this.client
        .from(SUBMISSIONS_TABLE)
        .select(
          'id, form_id, space_id, organization_id, submitted_by, data, is_test, status, task_creation_status',
        )
        .eq('id', payload.submissionId)
        .maybeSingle();

      if (error || !data) return;

      const row = data as Record<string, unknown>;

      // only dispatch a genuinely-final, non-test submission.
      if (row.status !== 'submitted' || row.is_test === true) return;

      await this.dispatch(row);
    } catch (err) {
      this.logger.warn(
        `handleFinalized failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  // Fired by FormBuilderApprovalsService when the final approval layer approves. Creates the task
  // that was deferred at submit time. Task-only — does NOT re-run dispatch()/startApproval.
  @OnEvent(FORM_APPROVAL_COMPLETED_EVENT, { async: true })
  async handleApprovalCompleted(
    payload: ApprovalCompletedEvent,
  ): Promise<void> {
    try {
      if (!payload?.submissionId) return;

      const { data, error } = await this.client
        .from(SUBMISSIONS_TABLE)
        .select(
          'id, form_id, space_id, organization_id, submitted_by, data, is_test, status, task_id, task_creation_status',
        )
        .eq('id', payload.submissionId)
        .maybeSingle();

      if (error || !data) return;

      const row = data as Record<string, unknown>;

      // Idempotent + safe: skip test/non-final rows and anything that already has a task.
      if (row.is_test === true || row.status !== 'submitted' || row.task_id)
        return;

      // Its surface's ticket switch was off at submit time.
      if (row.task_creation_status === 'skipped') return;

      await this.taskCreator.maybeCreateTask(
        row.form_id as string,
        row.organization_id as string,
        (row.submitted_by as string | null) ?? null,
        (row.data as Record<string, unknown> | null) ?? {},
        row.id as string,
      );
    } catch (err) {
      this.logger.warn(
        `handleApprovalCompleted failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }
}
