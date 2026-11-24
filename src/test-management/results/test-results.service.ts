import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../access/test-management-access.service';
import type {
  AttemptStarted,
  AttemptUpdated,
  NewAttemptDto,
  PreconditionResults,
  PreconditionResultSaved,
  RunStatus,
  SetAttemptStatusDto,
  SetPreconditionResultDto,
  SetStepResultDto,
  StepResultSaved,
  StepStatus,
  UpdateAttemptDto,
} from '../dto/test-execution.dto';
import {
  notFound,
  tmDbError,
  tmRpcError,
  type TmRpcError,
} from '../test-management-errors';

const MANAGE = 'manage_test_runs';
const EXECUTE = 'execute_tests';

interface SubmitResult {
  changed: boolean;
  step_status: StepStatus;
  attempt_status: RunStatus;
  status_overridden: boolean;
}

/** Step results, attempt comment and time, status modes and Reset/Merge re-runs. */
@Injectable()
export class TestResultsService {
  private readonly logger = new Logger(TestResultsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly permissions: PermissionsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async submitStepResult(
    user: RequestUser,
    spaceId: string,
    attemptId: string,
    snapshotStepId: string,
    dto: SetStepResultDto,
  ): Promise<StepResultSaved> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // Only the texts the caller sent are checked; older callers keep the status-only check.
    const expectedText: Record<string, string | null> = {};

    if (dto.expected_actual_result !== undefined) {
      expectedText.actual_result = dto.expected_actual_result;
    }

    if (dto.expected_comment !== undefined) {
      expectedText.comment = dto.expected_comment;
    }

    const result = await this.rpc<SubmitResult>(
      'tm_submit_step_result',
      {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_attempt_id: attemptId,
        p_snapshot_step_id: snapshotStepId,
        p_status: dto.status,
        p_actual_result: dto.actual_result,
        p_comment: dto.comment,
        p_expected_status: dto.expected_status,
        p_enforce_assignee: await this.enforceAssignee(user, spaceId),
        ...(Object.keys(expectedText).length > 0
          ? { p_expected_text: expectedText }
          : {}),
      },
      'save step result',
    );

    if (result.changed) {
      void this.audit(user, spaceId, attemptId, {
        action: 'step_result',
        step_id: snapshotStepId,
        status: result.step_status,
      });
    }

    return {
      changed: result.changed,
      step_status: result.step_status,
      attempt_status: result.attempt_status,
      status_overridden: result.status_overridden,
    };
  }

  async preconditionResults(
    organizationId: string,
    spaceId: string,
    attemptId: string,
  ): Promise<PreconditionResults> {
    await this.access.assertAvailable(organizationId, spaceId);

    const { data, error } = await this.client
      .from('test_run_attempts')
      .select('precondition_results')
      .eq('id', attemptId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle<{ precondition_results: PreconditionResults['results'] }>();

    if (error) throw tmDbError(this.logger, 'load precondition results', error);
    if (!data) throw notFound();

    return { attempt_id: attemptId, results: data.precondition_results };
  }

  /** Never changes the result of the run itself; the screen only warns. */
  async submitPreconditionResult(
    user: RequestUser,
    spaceId: string,
    attemptId: string,
    preconditionId: string,
    dto: SetPreconditionResultDto,
  ): Promise<PreconditionResultSaved> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const result = await this.rpc<PreconditionResultSaved>(
      'tm_submit_precondition_result',
      {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_attempt_id: attemptId,
        p_precondition_id: preconditionId,
        p_status: dto.status,
        p_expected_status: dto.expected_status,
        p_enforce_assignee: await this.enforceAssignee(user, spaceId),
      },
      'save precondition result',
    );

    if (result.changed) {
      void this.audit(user, spaceId, attemptId, {
        action: 'precondition_result',
        precondition_id: preconditionId,
        status: result.status,
      });
    }

    return result;
  }

  async updateAttempt(
    user: RequestUser,
    spaceId: string,
    attemptId: string,
    dto: UpdateAttemptDto,
  ): Promise<AttemptUpdated> {
    const patch: Record<string, unknown> = {};

    if (dto.comment !== undefined) patch.comment = dto.comment;
    if (dto.actual_minutes !== undefined) {
      patch.actual_minutes = dto.actual_minutes;
    }

    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Provide a comment or the actual time to update',
      });
    }

    const result = await this.rpc<AttemptUpdated>(
      'tm_update_attempt',
      {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_attempt_id: attemptId,
        p_patch: patch,
        p_enforce_assignee: await this.enforceAssignee(user, spaceId),
      },
      'update attempt',
    );

    if (result.changed) {
      void this.audit(user, spaceId, attemptId, {
        action: 'attempt_details',
        fields: Object.keys(patch),
      });
    }

    return result;
  }

  /** Override and abort need manage_test_runs; a manual status (case without steps) is also open to testers. */
  async setStatus(
    user: RequestUser,
    spaceId: string,
    attemptId: string,
    dto: SetAttemptStatusDto,
  ): Promise<AttemptUpdated> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const canManage = await this.permissions.hasSpacePermission(
      user.userId,
      user.organizationId,
      spaceId,
      MANAGE,
    );

    if (dto.status_mode !== 'manual' && !canManage) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Only test run managers can override or abort an attempt',
      });
    }

    if (
      dto.status_mode === 'manual' &&
      !canManage &&
      !(await this.permissions.hasSpacePermission(
        user.userId,
        user.organizationId,
        spaceId,
        EXECUTE,
      ))
    ) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'You cannot record results in this space',
      });
    }

    // The reason is kept in the audit log only; the database refuses unknown patch keys.
    const patch: Record<string, unknown> = { status_mode: dto.status_mode };

    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.expected_status !== undefined) {
      patch.expected_status = dto.expected_status;
    }

    const result = await this.rpc<AttemptUpdated>(
      'tm_update_attempt',
      {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_attempt_id: attemptId,
        p_patch: patch,
        p_enforce_assignee: canManage
          ? false
          : await this.enforceAssignee(user, spaceId),
      },
      'set attempt status',
    );

    if (result.changed) {
      void this.audit(user, spaceId, attemptId, {
        action: `status_${dto.status_mode}`,
        status: result.status,
        reason: dto.reason ?? null,
      });
    }

    return result;
  }

  /** Reset or Merge; refused while the case is archived (R7). */
  async startAttempt(
    user: RequestUser,
    spaceId: string,
    runId: string,
    dto: NewAttemptDto,
  ): Promise<AttemptStarted> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const { data, error } = await this.client
      .from('test_runs')
      .select('id, case_id, case:test_cases!test_runs_case_fkey(is_archived)')
      .eq('id', runId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error)
      throw tmDbError(this.logger, 'load run for a new attempt', error);
    if (!data) throw notFound();

    // An archived case is read-only; a deprecated one may still be re-run.
    if (
      (data as unknown as { case: { is_archived: boolean } | null }).case
        ?.is_archived
    ) {
      throw new ConflictException({
        code: 'ARCHIVED',
        message:
          'The test case is archived. Restore it before starting a new attempt.',

        // The case id tells this apart from an archived execution, as on create.
        data: { case_id: (data as unknown as { case_id: string }).case_id },
      });
    }

    const result = await this.rpc<AttemptStarted & { changed: boolean }>(
      'tm_start_attempt',
      {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_run_id: runId,
        p_kind: dto.mode,
        p_expected_attempt_no: dto.expected_attempt_no,
      },
      'start attempt',
    );

    void this.audit(
      user,
      spaceId,
      result.attempt_id,
      {
        action: `attempt_${dto.mode}`,
        run_id: runId,
        attempt_no: result.attempt_no,
        carried_steps: result.carried_steps,
      },
      'create',
    );

    return {
      attempt_id: result.attempt_id,
      attempt_no: result.attempt_no,
      status: result.status,
      carried_steps: result.carried_steps,
    };
  }

  /** Assignee-only binds testers; managers and org owners/admins may always write. */
  private async enforceAssignee(
    user: RequestUser,
    spaceId: string,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from('test_management_space_settings')
      .select('assignee_only')
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error)
      throw tmDbError(this.logger, 'read assignee-only setting', error);

    // No settings row means the default: off.
    if (!(data as { assignee_only: boolean } | null)?.assignee_only) {
      return false;
    }

    const [canManage, isAdmin] = await Promise.all([
      this.permissions.hasSpacePermission(
        user.userId,
        user.organizationId,
        spaceId,
        MANAGE,
      ),
      this.permissions.isAdminOrOwner(user.userId, user.organizationId),
    ]);

    return !canManage && !isAdmin;
  }

  private async rpc<T>(
    name: string,
    args: Record<string, unknown>,
    action: string,
  ): Promise<T> {
    const { data, error } = (await this.client.rpc(name, args)) as {
      data: T | null;
      error: TmRpcError | null;
    };

    if (error) throw tmRpcError(this.logger, action, error);
    if (data === null) throw notFound();

    return data;
  }

  private audit(
    user: RequestUser,
    spaceId: string,
    attemptId: string,
    changes: Record<string, unknown>,
    action: 'create' | 'update' = 'update',
  ) {
    return this.auditLogs.logActionForRequest(
      user,
      'test_run_attempt',
      attemptId,
      action,
      { space_id: spaceId, ...changes },
    );
  }
}
