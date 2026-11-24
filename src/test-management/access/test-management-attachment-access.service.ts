import { ForbiddenException, Injectable, Logger } from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { RunStatus } from '../dto/test-execution.dto';
import { notFound, tmDbError, tmRpcError } from '../test-management-errors';
import { TestManagementAccessService } from './test-management-access.service';

export const TEST_MANAGEMENT_ATTACHMENT_TYPES = [
  'test_case',
  'test_run_attempt',
  'test_execution',
  'test_step',
] as const;

export type TestManagementAttachmentType =
  (typeof TEST_MANAGEMENT_ATTACHMENT_TYPES)[number];

export type AttachmentAction = 'view' | 'upload' | 'delete';

export function isTestManagementAttachmentType(
  entityType: string,
): entityType is TestManagementAttachmentType {
  return (TEST_MANAGEMENT_ATTACHMENT_TYPES as readonly string[]).includes(
    entityType,
  );
}

const VIEW = 'view_tests';
const EDIT = 'edit_tests';
const EXECUTE = 'execute_tests';
const MANAGE = 'manage_test_runs';

interface AttemptRow {
  space_id: string;
  attempt_no: number;
  status: RunStatus;
  run: {
    current_attempt_no: number;
    assignee_id: string | null;
    execution: { is_archived: boolean } | null;
  } | null;
}

interface ArchivableRow {
  space_id: string;
  is_archived: boolean;
}

/**
 * Who may list, upload or delete Test Management evidence (test cases, attempts, executions).
 * Used by AttachmentsService; every check fails closed and the database API never sees these rows.
 */
@Injectable()
export class TestManagementAttachmentAccessService {
  private readonly logger = new Logger(
    TestManagementAttachmentAccessService.name,
  );

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly permissions: PermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async resolveAttachmentAccess(
    user: RequestUser,
    entityType: TestManagementAttachmentType,
    entityId: string,
    action: AttachmentAction,
  ): Promise<{
    organizationId: string;
    spaceId: string;
    ownerId: null;
  }> {
    const organizationId = user.organizationId;

    if (!organizationId) throw notFound();

    const spaceId =
      entityType === 'test_run_attempt'
        ? await this.checkAttempt(user, entityId, action)
        : entityType === 'test_step'
          ? await this.checkStep(user, entityId, action)
          : await this.checkArchivable(user, entityType, entityId, action);

    return { organizationId, spaceId, ownerId: null };
  }

  private async checkArchivable(
    user: RequestUser,
    entityType: 'test_case' | 'test_execution',
    entityId: string,
    action: AttachmentAction,
  ): Promise<string> {
    const table = entityType === 'test_case' ? 'test_cases' : 'test_executions';
    const { data, error } = await this.client
      .from(table)
      .select('space_id, is_archived')
      .eq('id', entityId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load evidence owner', error);
    if (!data) throw notFound();

    const row = data as ArchivableRow;

    await this.access.assertAvailable(user.organizationId, row.space_id, {
      write: action !== 'view',
    });

    const key =
      action === 'view'
        ? VIEW
        : entityType === 'test_case'
          ? EDIT
          : action === 'upload'
            ? EXECUTE
            : MANAGE;

    await this.requirePermission(user, row.space_id, key);

    if (action !== 'view' && row.is_archived) {
      throw tmRpcError(this.logger, 'change evidence', {
        code: 'TM004',
        message:
          entityType === 'test_case'
            ? 'The test case is archived. Restore it first.'
            : 'The test execution is archived. Restore it first.',
      });
    }

    return row.space_id;
  }

  // Step files follow the rules of the case that holds the step.
  private async checkStep(
    user: RequestUser,
    stepId: string,
    action: AttachmentAction,
  ): Promise<string> {
    const { data, error } = await this.client
      .from('test_cases')
      .select('id')
      .eq('organization_id', user.organizationId)
      // A JSON string, so jsonb containment gets a JSON literal and not a Postgres array.
      .filter('steps', 'cs', JSON.stringify([{ id: stepId }]))
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load step owner', error);
    if (!data) throw notFound();

    return this.checkArchivable(
      user,
      'test_case',
      (data as { id: string }).id,
      action,
    );
  }

  private async checkAttempt(
    user: RequestUser,
    attemptId: string,
    action: AttachmentAction,
  ): Promise<string> {
    const { data, error } = await this.client
      .from('test_run_attempts')
      .select(
        'space_id, attempt_no, status, ' +
          'run:test_runs!test_run_attempts_run_fkey(current_attempt_no, assignee_id, ' +
          'execution:test_executions!test_runs_execution_fkey(is_archived))',
      )
      .eq('id', attemptId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load evidence attempt', error);

    const row = data as unknown as AttemptRow | null;

    if (!row?.run?.execution) throw notFound();

    await this.access.assertAvailable(user.organizationId, row.space_id, {
      write: action !== 'view',
    });

    if (action === 'view') {
      await this.requirePermission(user, row.space_id, VIEW);

      return row.space_id;
    }

    const [canExecute, canManage] = await Promise.all([
      this.has(user, row.space_id, EXECUTE),
      this.has(user, row.space_id, MANAGE),
    ]);
    const allowed = action === 'upload' ? canExecute : canExecute || canManage;

    if (!allowed) throw this.forbidden();

    if (
      !canManage &&
      row.run.assignee_id !== user.userId &&
      (await this.assigneeOnly(user, row.space_id))
    ) {
      throw tmRpcError(this.logger, 'change evidence', {
        code: 'TM011',
        message: '',
      });
    }

    if (row.run.execution.is_archived) {
      throw tmRpcError(this.logger, 'change evidence', {
        code: 'TM004',
        message: 'The test execution is archived. Restore it first.',
      });
    }

    // Earlier and aborted attempts are history: nobody adds or removes their evidence.
    if (row.attempt_no !== row.run.current_attempt_no) {
      throw tmRpcError(this.logger, 'change evidence', {
        code: 'TM003',
        message: '',
      });
    }

    if (row.status === 'ABORTED') {
      throw tmRpcError(this.logger, 'change evidence', {
        code: 'TM012',
        message: '',
      });
    }

    return row.space_id;
  }

  /** Same rule as result writes: when the space turns assignee-only on, org owners/admins are still exempt. */
  private async assigneeOnly(
    user: RequestUser,
    spaceId: string,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from('test_management_space_settings')
      .select('assignee_only')
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error) {
      throw tmDbError(this.logger, 'read assignee-only setting', error);
    }

    // No settings row means the default: off.
    if (!(data as { assignee_only: boolean } | null)?.assignee_only) {
      return false;
    }

    return !(await this.permissions.isAdminOrOwner(
      user.userId,
      user.organizationId,
    ));
  }

  private has(user: RequestUser, spaceId: string, key: string) {
    return this.permissions.hasSpacePermission(
      user.userId,
      user.organizationId,
      spaceId,
      key,
    );
  }

  private async requirePermission(
    user: RequestUser,
    spaceId: string,
    key: string,
  ): Promise<void> {
    if (!(await this.has(user, spaceId, key))) throw this.forbidden();
  }

  private forbidden() {
    return new ForbiddenException({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this evidence',
    });
  }
}
