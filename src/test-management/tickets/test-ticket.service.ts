import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  TEST_ESTIMATE_MAX,
  TEST_TICKET_CREATED_EVENT,
  TEST_TICKET_DELETING_EVENT,
  TEST_TICKET_UPDATED_EVENT,
  ticketTextForCase,
} from '../../tasks/test-ticket-events';
// Payloads in @OnEvent signatures must be type-only imports under isolatedModules.
import type {
  TestTicketCreatedEvent,
  TestTicketDeletingEvent,
  TestTicketUpdatedEvent,
} from '../../tasks/test-ticket-events';
import { removeEvidenceFiles } from '../common/evidence-storage';
import { countRunResults, hasResults } from '../common/run-results';
import {
  tmDbError,
  tmRpcError,
  type TmRpcError,
} from '../test-management-errors';

interface LinkedCaseRow {
  id: string;
  objective: string | null;
  estimate_minutes: number | null;
  revision: number;
  is_archived: boolean;
}

// Same rule as the title CHECK: trimmed, 1..255 characters (code points, not UTF-16 units).
function recordTitle(summary: string): string {
  return Array.from(summary.trim()).slice(0, 255).join('').trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The ticket's description and estimate, when it has them, start the new test case.
function createdCaseText(
  event: TestTicketCreatedEvent,
): Record<string, unknown> {
  const objective = ticketTextForCase(event.description);
  const estimate = event.estimatedTime;

  return {
    ...(objective ? { objective } : {}),
    ...(estimate !== null &&
    estimate !== undefined &&
    estimate <= TEST_ESTIMATE_MAX
      ? { estimate_minutes: estimate }
      : {}),
  };
}

/** Gives a new test case ticket its test case, linked by task_id. */
@Injectable()
export class TestTicketService {
  private readonly logger = new Logger(TestTicketService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  @OnEvent(TEST_TICKET_CREATED_EVENT)
  async onCreated(event: TestTicketCreatedEvent): Promise<void> {
    if (
      event.kind !== 'case_task_type_id' &&
      event.kind !== 'set_task_type_id' &&
      event.kind !== 'plan_task_type_id' &&
      event.kind !== 'precondition_task_type_id'
    ) {
      this.logger.debug(
        `No test record for ${event.kind} ticket ${event.taskId}`,
      );

      return;
    }

    try {
      if (event.kind === 'set_task_type_id') await this.createLinkedSet(event);
      else if (event.kind === 'plan_task_type_id') {
        await this.createLinkedPlan(event);
      } else if (event.kind === 'precondition_task_type_id') {
        await this.createLinkedPrecondition(event);
      } else await this.createLinkedCase(event);
    } catch (error) {
      this.logger.warn(
        `Could not create the test record of ticket ${event.taskId}: ${errorMessage(error)}`,
      );
    }
  }

  private async createLinkedCase(event: TestTicketCreatedEvent): Promise<void> {
    if (await this.findLinkedCase(event.organizationId, event.taskId)) return;

    const { data, error } = await this.client
      .from('test_cases')
      .insert({
        organization_id: event.organizationId,
        space_id: event.spaceId,
        task_id: event.taskId,
        ...createdCaseText(event),
        created_by: event.userId,
        updated_by: event.userId,
      })
      .select('id')
      .single<{ id: string }>();

    // Another listener run linked the ticket first.
    if (
      error?.code === '23505' &&
      (await this.findLinkedCase(event.organizationId, event.taskId))
    ) {
      return;
    }

    if (error) throw tmDbError(this.logger, 'create test_cases record', error);

    const { error: historyError } = await this.client
      .from('test_case_history')
      .insert({
        organization_id: event.organizationId,
        space_id: event.spaceId,
        case_id: data.id,
        revision: 1,
        change_kind: 'created',
        changed_by: event.userId,
      });

    if (historyError) {
      throw tmDbError(this.logger, 'write test case history', historyError);
    }
  }

  private async findLinkedCase(
    organizationId: string,
    taskId: string,
  ): Promise<{ id: string } | null> {
    const { data, error } = await this.client
      .from('test_cases')
      .select('id')
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      .maybeSingle<{ id: string }>();

    if (error) throw tmDbError(this.logger, 'read test_cases by ticket', error);

    return data;
  }

  // The name, description and key are read from the ticket.
  private async createLinkedSet(event: TestTicketCreatedEvent): Promise<void> {
    if (await this.findLinkedSet(event.organizationId, event.taskId)) return;

    const { error } = await this.client.from('test_sets').insert({
      organization_id: event.organizationId,
      space_id: event.spaceId,
      task_id: event.taskId,
      created_by: event.userId,
      updated_by: event.userId,
    });

    // Another listener run linked the ticket first.
    if (
      error?.code === '23505' &&
      (await this.findLinkedSet(event.organizationId, event.taskId))
    ) {
      return;
    }

    if (error) throw tmDbError(this.logger, 'create test_sets record', error);
  }

  private async createLinkedPrecondition(
    event: TestTicketCreatedEvent,
  ): Promise<void> {
    if (await this.findLinkedPrecondition(event.organizationId, event.taskId)) {
      return;
    }

    const { error } = await this.client.from('test_preconditions').insert({
      organization_id: event.organizationId,
      space_id: event.spaceId,
      task_id: event.taskId,
      title: recordTitle(event.summary),
      created_by: event.userId,
      updated_by: event.userId,
    });

    // Another listener run linked the ticket first.
    if (
      error?.code === '23505' &&
      (await this.findLinkedPrecondition(event.organizationId, event.taskId))
    ) {
      return;
    }

    if (error) {
      throw tmDbError(this.logger, 'create test_preconditions record', error);
    }
  }

  private async findLinkedPrecondition(
    organizationId: string,
    taskId: string,
  ): Promise<{ id: string } | null> {
    const { data, error } = await this.client
      .from('test_preconditions')
      .select('id')
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      .maybeSingle<{ id: string }>();

    if (error) {
      throw tmDbError(this.logger, 'read test_preconditions by ticket', error);
    }

    return data;
  }

  private async findLinkedSet(
    organizationId: string,
    taskId: string,
  ): Promise<{ id: string } | null> {
    const { data, error } = await this.client
      .from('test_sets')
      .select('id')
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      .maybeSingle<{ id: string }>();

    if (error) throw tmDbError(this.logger, 'read test_sets by ticket', error);

    return data;
  }

  // Errors stop the ticket delete, so a plan with results keeps its ticket.
  @OnEvent(TEST_TICKET_DELETING_EVENT, { suppressErrors: false })
  async onTicketDeleting(event: TestTicketDeletingEvent): Promise<void> {
    await this.refuseCaseWithRuns(event);

    const { data: plan, error } = await this.client
      .from('test_plans')
      .select('id, space_id')
      .eq('task_id', event.taskId)
      .eq('organization_id', event.organizationId)
      .maybeSingle<{ id: string; space_id: string }>();

    if (error) throw tmDbError(this.logger, 'read test_plans by ticket', error);
    if (!plan) return this.onExecutionTicketDeleting(event);

    const results = await countRunResults(
      this.client,
      this.logger,
      event.organizationId,
      plan.space_id,
      { planId: plan.id },
    );

    if (results > 0) {
      throw hasResults(
        "This ticket's test plan has execution results, so the ticket cannot be deleted. Archive the plan instead.",
        results,
      );
    }

    const { error: deleteError } = await this.client
      .from('test_plans')
      .delete()
      .eq('id', plan.id)
      .eq('organization_id', event.organizationId);

    if (deleteError) {
      throw tmDbError(this.logger, 'delete test plan of ticket', deleteError);
    }
  }

  // The database would remove the runs with the case, so a ticket delete is refused here first.
  private async refuseCaseWithRuns(
    event: TestTicketDeletingEvent,
  ): Promise<void> {
    const linked = await this.findLinkedCase(
      event.organizationId,
      event.taskId,
    );

    if (!linked) return;

    const { count, error } = await this.client
      .from('test_runs')
      .select('id', { count: 'exact', head: true })
      .eq('case_id', linked.id)
      .eq('organization_id', event.organizationId);

    if (error) throw tmDbError(this.logger, 'count test case runs', error);

    if ((count ?? 0) > 0) {
      throw new ConflictException(
        "This ticket's test case has execution results, so the ticket cannot be deleted.",
      );
    }
  }

  // Errors reach the ticket update, which then puts the ticket back.
  @OnEvent(TEST_TICKET_UPDATED_EVENT, { suppressErrors: false })
  async onTicketUpdated(event: TestTicketUpdatedEvent): Promise<void> {
    if (event.kind === 'case_task_type_id') await this.updateLinkedCase(event);
    else if (event.kind === 'set_task_type_id') {
      await this.touchLinkedRecord('test_sets', event);
    } else if (event.kind === 'plan_task_type_id') {
      await this.touchLinkedRecord('test_plans', event);
    } else if (event.kind === 'execution_task_type_id') {
      await this.touchLinkedRecord('test_executions', event);
    } else if (event.kind === 'precondition_task_type_id') {
      await this.updateLinkedPrecondition(event);
    }
  }

  // A run execution keeps its ticket; one that never ran goes with it.
  private async onExecutionTicketDeleting(
    event: TestTicketDeletingEvent,
  ): Promise<void> {
    const { data: execution, error } = await this.client
      .from('test_executions')
      .select('id, space_id')
      .eq('task_id', event.taskId)
      .eq('organization_id', event.organizationId)
      .maybeSingle<{ id: string; space_id: string }>();

    if (error) {
      throw tmDbError(this.logger, 'read test_executions by ticket', error);
    }

    if (!execution) return;

    const results = await countRunResults(
      this.client,
      this.logger,
      event.organizationId,
      execution.space_id,
      { executionId: execution.id },
    );

    if (results > 0) {
      throw hasResults(
        "This ticket's test execution has execution results, so the ticket cannot be deleted. Archive the execution instead.",
        results,
      );
    }

    // The function also removes the rows of the files, which have no foreign key to the execution.
    const { data, error: deleteError } = (await this.client.rpc(
      'tm_delete_execution',
      {
        p_organization_id: event.organizationId,
        p_space_id: execution.space_id,
        p_actor_id: event.userId,
        p_execution_id: execution.id,
        p_dry_run: false,
      },
    )) as {
      data: { storage_paths?: string[] } | null;
      error: TmRpcError | null;
    };

    if (deleteError) {
      throw tmRpcError(
        this.logger,
        'delete test execution of ticket',
        deleteError,
      );
    }

    await removeEvidenceFiles(
      this.client,
      this.logger,
      data?.storage_paths ?? [],
      `Test execution ${execution.id} ticket delete`,
    );
  }

  // The record reads its fields from the ticket; this only keeps its "last updated" right, so a failure can't undo the edit.
  private async touchLinkedRecord(
    table: 'test_sets' | 'test_plans' | 'test_executions',
    event: TestTicketUpdatedEvent,
  ): Promise<void> {
    const { error } = await this.client
      .from(table)
      .update({ updated_by: event.userId })
      .eq('task_id', event.taskId)
      .eq('organization_id', event.organizationId);

    if (error) {
      this.logger.warn(
        `Last updated of ${table} record of ticket ${event.taskId} not saved: ${error.message}`,
      );
    }
  }

  // Only the title is shared; an archived record or an echo of its own rename writes nothing.
  private async updateLinkedPrecondition(
    event: TestTicketUpdatedEvent,
  ): Promise<void> {
    const { summary } = event.changes;

    if (summary === undefined) return;

    const { data: record, error } = await this.client
      .from('test_preconditions')
      .select('id, title, is_archived')
      .eq('task_id', event.taskId)
      .eq('space_id', event.spaceId)
      .eq('organization_id', event.organizationId)
      .maybeSingle<{ id: string; title: string; is_archived: boolean }>();

    if (error) throw tmDbError(this.logger, 'read linked precondition', error);

    const title = recordTitle(summary);

    if (!record || record.is_archived || title === record.title) return;

    const { error: updateError } = await this.client
      .from('test_preconditions')
      .update({ title, updated_by: event.userId })
      .eq('id', record.id)
      .eq('organization_id', event.organizationId);

    if (updateError) {
      throw tmDbError(this.logger, 'update linked precondition', updateError);
    }
  }

  private async updateLinkedCase(event: TestTicketUpdatedEvent): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const { data: record, error } = await this.client
        .from('test_cases')
        .select('id, objective, estimate_minutes, revision, is_archived')
        .eq('task_id', event.taskId)
        .eq('space_id', event.spaceId)
        .eq('organization_id', event.organizationId)
        .maybeSingle<LinkedCaseRow>();

      if (error) throw tmDbError(this.logger, 'read linked test case', error);
      if (!record) return;

      const patch = caseChanges(event, record);

      if (Object.keys(patch).length === 0) {
        await this.recordCaseRename(event, record.id);

        return;
      }

      // The update function refuses archived cases, but both sides must still match.
      if (record.is_archived) {
        await this.updateArchivedCase(event, record, patch);
        await this.recordCaseRename(event, record.id);

        return;
      }

      const { error: rpcError } = (await this.client.rpc('tm_update_case', {
        p_organization_id: event.organizationId,
        p_space_id: event.spaceId,
        p_actor_id: event.userId,
        p_case_id: record.id,
        p_expected_revision: record.revision,
        p_patch: patch,
      })) as { error: TmRpcError | null };

      if (!rpcError) {
        await this.recordCaseRename(event, record.id);

        return;
      }

      // Someone saved the case in between: read it again once.
      if (rpcError.code === 'TM001' && attempt === 0) continue;

      throw tmRpcError(this.logger, 'update linked test case', rpcError);
    }
  }

  // Runs notice a changed test case through its revision, and History shows the rename; a failure only logs, as the ticket already changed.
  private async recordCaseRename(
    event: TestTicketUpdatedEvent,
    caseId: string,
  ): Promise<void> {
    const to = event.changes.summary?.trim();
    const from = event.changes.previousSummary?.trim();

    if (to === undefined || to === from) return;

    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { data: current, error: readError } = await this.client
          .from('test_cases')
          .select('revision')
          .eq('id', caseId)
          .eq('organization_id', event.organizationId)
          .maybeSingle<{ revision: number }>();

        if (readError) throw new Error(readError.message);
        if (!current) return;

        const revision = current.revision + 1;
        const { data, error } = await this.client
          .from('test_cases')
          .update({ revision, updated_by: event.userId })
          .eq('id', caseId)
          .eq('organization_id', event.organizationId)
          .eq('revision', current.revision)
          .select('id');

        if (error) throw new Error(error.message);

        // Someone saved the case in between: read it again once.
        if (!data?.length) continue;

        const { error: historyError } = await this.client
          .from('test_case_history')
          .insert({
            organization_id: event.organizationId,
            space_id: event.spaceId,
            case_id: caseId,
            revision,
            change_kind: 'updated',
            changes: { title: { from: from ?? null, to } },
            changed_by: event.userId,
          });

        if (historyError) throw new Error(historyError.message);

        return;
      }

      this.logger.warn(
        `Rename of test case ${caseId} not recorded: it kept changing`,
      );
    } catch (error) {
      this.logger.warn(
        `Rename of test case ${caseId} not recorded: ${errorMessage(error)}`,
      );
    }
  }

  private async updateArchivedCase(
    event: TestTicketUpdatedEvent,
    record: LinkedCaseRow,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const revision = record.revision + 1;
    const { data, error } = await this.client
      .from('test_cases')
      .update({ ...patch, revision, updated_by: event.userId })
      .eq('id', record.id)
      .eq('organization_id', event.organizationId)
      .eq('revision', record.revision)
      .select('id');

    if (error) throw tmDbError(this.logger, 'update archived test case', error);

    if (!data?.length) {
      throw new ConflictException({
        code: 'REVISION_CONFLICT',
        message: 'This test case was changed by someone else. Try again.',
      });
    }

    // Same history row the update function writes.
    const changes = Object.fromEntries(
      Object.entries(patch).map(([field, to]) => [
        field,
        { from: record[field as keyof LinkedCaseRow] ?? null, to },
      ]),
    );
    const { error: historyError } = await this.client
      .from('test_case_history')
      .insert({
        organization_id: event.organizationId,
        space_id: event.spaceId,
        case_id: record.id,
        revision,
        change_kind: 'updated',
        changes,
        changed_by: event.userId,
      });

    // Both sides already match; a missing history row is only logged.
    if (historyError) {
      this.logger.warn(
        `History of test case ${record.id} not written: ${historyError.message}`,
      );
    }
  }

  // The name, description, dates and key are read from the ticket.
  private async createLinkedPlan(event: TestTicketCreatedEvent): Promise<void> {
    if (await this.findLinkedPlan(event.organizationId, event.taskId)) return;

    const { error } = await this.client.from('test_plans').insert({
      organization_id: event.organizationId,
      space_id: event.spaceId,
      task_id: event.taskId,
      created_by: event.userId,
      updated_by: event.userId,
    });

    // Another listener run linked the ticket first.
    if (
      error?.code === '23505' &&
      (await this.findLinkedPlan(event.organizationId, event.taskId))
    ) {
      return;
    }

    if (error) throw tmDbError(this.logger, 'create test_plans record', error);
  }

  private async findLinkedPlan(
    organizationId: string,
    taskId: string,
  ): Promise<{ id: string } | null> {
    const { data, error } = await this.client
      .from('test_plans')
      .select('id')
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      .maybeSingle<{ id: string }>();

    if (error) throw tmDbError(this.logger, 'read test_plans by ticket', error);

    return data;
  }
}

// Only the fields that really differ, so an echo of the case's own change writes nothing.
function caseChanges(
  event: TestTicketUpdatedEvent,
  record: LinkedCaseRow,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const { description, estimatedTime } = event.changes;

  if (description !== undefined) {
    const objective = ticketTextForCase(description);

    if (objective !== record.objective) patch.objective = objective;
  }

  if (
    estimatedTime !== undefined &&
    estimatedTime !== record.estimate_minutes
  ) {
    patch.estimate_minutes = estimatedTime;
  }

  return patch;
}
