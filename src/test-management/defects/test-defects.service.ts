import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TasksMineWriteService } from '../../tasks/tasks-mine-write.service';
import { TasksService } from '../../tasks/tasks.service';
import { TestManagementAccessService } from '../access/test-management-access.service';
import {
  otherSpaceTicket,
  TaskVisibilityService,
} from '../common/task-visibility.service';
import {
  compareTicketKeys,
  plainTextToTicketHtml,
  ticketEmbed,
  ticketName,
} from '../common/ticket-keys';
import type {
  CreateDefectDto,
  CreatedDefectTask,
  DefectCreated,
  LinkDefectDto,
  RunDefectLink,
  TaskDefectRun,
  TaskDefectsQueryDto,
  TaskDefectsSortField,
} from '../dto/test-defect.dto';
import type { RunStatus } from '../dto/test-execution.dto';
import { executionArchivedError } from '../executions/test-executions.service';
import {
  notFound,
  tmDbError,
  tmRpcError,
  type TmRpcError,
} from '../test-management-errors';

const EXECUTE = 'execute_tests';
const MANAGE = 'manage_test_runs';
const CREATE_TASKS = 'create_tasks';

const TASK_DEFECT_COMPARE: Record<
  TaskDefectsSortField,
  (a: TaskDefectRun, b: TaskDefectRun) => number
> = {
  case_key: (a, b) => compareTicketKeys(a.case_key, b.case_key),
  execution_key: (a, b) => compareTicketKeys(a.execution_key, b.execution_key),
  attempt: (a, b) => (a.attempt_no ?? 0) - (b.attempt_no ?? 0),
  status: (a, b) => a.status.localeCompare(b.status),
};

const LINK_COLUMNS = 'id, task_id, attempt_no, created_at';
const TASK_DEFECT_LIMIT = 500;

// All attempts come along because PostgREST cannot join on current_attempt_no.
const TASK_DEFECT_SELECT =
  'attempt_no, created_at, run:test_runs!test_ticket_links_run_fkey(id, current_attempt_no, ' +
  `case:test_cases!test_runs_case_fkey(${ticketEmbed('test_cases')}), ` +
  `execution:test_executions!test_runs_execution_fkey(id, ${ticketEmbed('test_executions')}), ` +
  'attempts:test_run_attempts!test_run_attempts_run_fkey(attempt_no, status))';

interface TaskDefectRow {
  attempt_no: number | null;
  created_at: string;
  run: {
    id: string;
    current_attempt_no: number;
    case: { task: { key: string; summary: string } } | null;
    execution: {
      id: string;
      task: { key: string; summary: string };
    } | null;
    attempts: { attempt_no: number; status: RunStatus }[];
  } | null;
}

interface RunRow {
  id: string;
  current_attempt_no: number;
  assignee_id: string | null;
  execution: { is_archived: boolean } | null;
}

interface SettingsRow {
  assignee_only: boolean | null;
  defect_task_type_id: string | null;
}

/** A write answer; replayed means the link already existed, so the controller answers 200. */
export interface DefectWrite<T> {
  replayed: boolean;
  body: T;
}

/** Defect links between runs and tickets: link, unlink, and create a ticket then link it. */
@Injectable()
export class TestDefectsService {
  private readonly logger = new Logger(TestDefectsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly permissions: PermissionsService,
    private readonly orgModules: OrganizationModulesService,
    private readonly tasks: TasksService,
    private readonly tasksWrite: TasksMineWriteService,
    private readonly visibility: TaskVisibilityService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async link(
    user: RequestUser,
    spaceId: string,
    runId: string,
    dto: LinkDefectDto,
  ): Promise<DefectWrite<RunDefectLink>> {
    const { run } = await this.prepare(user, spaceId, runId);

    // Missing, foreign and hidden tickets get the same 404.
    const visible = await this.visibility.visibleTasks(user, [dto.task_id]);

    if (!visible.has(dto.task_id)) throw notFound();
    if (visible.get(dto.task_id)?.spaceId !== spaceId) throw otherSpaceTicket();

    const { data, error } = await this.insertLink(user, spaceId, run, {
      task_id: dto.task_id,
    });

    if (
      error?.code === '23505' &&
      error.message.includes('test_ticket_links_run_task_key')
    ) {
      const existing = await this.findLink(
        user.organizationId,
        spaceId,
        runId,
        'task_id',
        dto.task_id,
      );

      if (existing) return { replayed: true, body: existing };
    }

    // The trigger raises P0002 when the ticket belongs to another org.
    if (error?.code === 'P0002') throw notFound();
    if (error) throw tmDbError(this.logger, 'link defect', error);

    this.audit(user, spaceId, runId, {
      action: 'link_defect',
      task_id: dto.task_id,
    });

    return { replayed: false, body: data as RunDefectLink };
  }

  /** Runs of this space that list the ticket as a defect; a ticket the caller cannot see gets the same 404. */
  async listForTask(
    user: RequestUser,
    spaceId: string,
    taskId: string,
    query?: TaskDefectsQueryDto,
  ): Promise<{ items: TaskDefectRun[] }> {
    await this.access.assertAvailable(user.organizationId, spaceId);

    const visible = await this.visibility.visibleTasks(user, [taskId]);

    if (!visible.has(taskId)) throw notFound();

    // Run rows only, so defects linked to cases, sets or plans cannot use up the limit.
    const { data, error } = await this.client
      .from('test_ticket_links')
      .select(TASK_DEFECT_SELECT)
      .eq('link_type', 'defect')
      .not('run_id', 'is', null)
      .eq('task_id', taskId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .order('created_at', { ascending: false })
      .limit(TASK_DEFECT_LIMIT);

    if (error) throw tmDbError(this.logger, 'load ticket defects', error);

    const items = ((data ?? []) as unknown as TaskDefectRow[]).flatMap(
      (row): TaskDefectRun[] => {
        const run = row.run;

        if (!run) return [];

        const current = run.attempts.find(
          (attempt) => attempt.attempt_no === run.current_attempt_no,
        );

        return [
          {
            run_id: run.id,
            case_key: run.case?.task.key ?? '',
            case_title: ticketName(run.case?.task.summary ?? ''),
            execution_id: run.execution?.id ?? '',
            execution_key: run.execution?.task.key ?? '',
            execution_name: ticketName(run.execution?.task.summary ?? ''),
            attempt_no: row.attempt_no,
            status: current?.status ?? 'TODO',
            linked_at: row.created_at,
          },
        ];
      },
    );

    // Sorted only on request, so the default order stays newest link first.
    if (query?.sortBy) {
      const compare = TASK_DEFECT_COMPARE[query.sortBy];
      const dir = query.sortDir === 'desc' ? -1 : 1;

      items.sort((a, b) => compare(a, b) * dir);
    }

    return { items };
  }

  /** Allowed even when the ticket is no longer visible to the caller. */
  async unlink(
    user: RequestUser,
    spaceId: string,
    runId: string,
    taskId: string,
  ): Promise<void> {
    await this.prepare(user, spaceId, runId);

    const { data, error } = await this.client
      .from('test_ticket_links')
      .delete()
      .eq('run_id', runId)
      .eq('task_id', taskId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .select('id');

    if (error) throw tmDbError(this.logger, 'unlink defect', error);
    if (!data?.length) throw notFound();

    this.audit(user, spaceId, runId, {
      action: 'unlink_defect',
      task_id: taskId,
    });
  }

  /** Creates the ticket in the run's own space; request_id makes a resend return the first result. */
  async create(
    user: RequestUser,
    spaceId: string,
    runId: string,
    dto: CreateDefectDto,
  ): Promise<DefectWrite<DefectCreated>> {
    const organizationId = user.organizationId;
    const { run, settings } = await this.prepare(user, spaceId, runId);
    const typeId = settings?.defect_task_type_id ?? null;
    const types = typeId
      ? await this.tasks.getActiveTaskTypesForSpace(organizationId, spaceId)
      : [];

    if (!typeId || !types.some((type) => type.id === typeId)) {
      throw tmRpcError(this.logger, 'create defect', {
        code: 'TM010',
        message: 'No valid defect ticket type is set for this space',
      });
    }

    const [tenantOn, spaceOn] = await Promise.all([
      this.orgModules.isEnabled(organizationId, 'tasks'),
      this.orgModules.isSpaceModuleEnabled(organizationId, spaceId, 'tasks'),
    ]);

    if (!tenantOn || !spaceOn) {
      throw new ForbiddenException({
        code: 'MODULE_DISABLED',
        message: 'Tasks is not enabled in this space',
      });
    }

    if (!(await this.has(user, spaceId, CREATE_TASKS))) {
      throw this.forbidden('You cannot create tickets in this space');
    }

    const prior = await this.findLink(
      organizationId,
      spaceId,
      runId,
      'request_id',
      dto.request_id,
    );

    if (prior) return this.replay(user, prior);

    const task = await this.createTicket(user, spaceId, dto, typeId);
    const link = { task_id: task.id, request_id: dto.request_id };
    let failure: TmRpcError | null = null;

    // One retry: the ticket exists already, so losing the link is worth a second try.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { data, error } = await this.insertLink(user, spaceId, run, link);

      if (!error) {
        this.audit(user, spaceId, runId, {
          action: 'create_defect',
          task_id: task.id,
          request_id: dto.request_id,
        });

        return {
          replayed: false,
          body: { linked: true, link: data as RunDefectLink, task },
        };
      }

      failure = error;

      // A parallel resend linked its own ticket first; ours stays unlinked and is kept in the audit.
      if (
        error.code === '23505' &&
        error.message.includes('test_ticket_links_run_request_key')
      ) {
        const existing = await this.findLink(
          organizationId,
          spaceId,
          runId,
          'request_id',
          dto.request_id,
        );

        if (existing) {
          this.audit(user, spaceId, runId, {
            action: 'create_defect',
            task_id: existing.task_id,
            request_id: dto.request_id,
            unlinked_task_id: task.id,
          });

          return this.replay(user, existing);
        }
      }
    }

    this.logger.warn(
      `Created ticket ${task.id} but could not link it to run ${runId} [${failure?.code ?? 'no code'}]: ${failure?.message ?? ''}`,
    );
    this.audit(user, spaceId, runId, {
      action: 'create_defect',
      task_id: task.id,
      request_id: dto.request_id,
      linked: false,
    });

    return { replayed: false, body: { linked: false, task } };
  }

  /** Checks shared by every write, in this order. */
  private async prepare(
    user: RequestUser,
    spaceId: string,
    runId: string,
  ): Promise<{ run: RunRow; settings: SettingsRow | null }> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const { data, error } = await this.client
      .from('test_runs')
      .select(
        'id, current_attempt_no, assignee_id, execution:test_executions!test_runs_execution_fkey(is_archived)',
      )
      .eq('id', runId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load run for defects', error);
    if (!data) throw notFound();

    const run = data as unknown as RunRow;

    if (!(await this.has(user, spaceId, EXECUTE))) {
      throw this.forbidden('You cannot change defects of runs in this space');
    }

    const { data: settingsData, error: settingsError } = await this.client
      .from('test_management_space_settings')
      .select('assignee_only, defect_task_type_id')
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (settingsError) {
      throw tmDbError(this.logger, 'read defect settings', settingsError);
    }

    const settings = settingsData as SettingsRow | null;

    // Same rule as result writes: managers and org owners/admins are exempt.
    if (settings?.assignee_only && run.assignee_id !== user.userId) {
      const [canManage, isAdmin] = await Promise.all([
        this.has(user, spaceId, MANAGE),
        this.permissions.isAdminOrOwner(user.userId, user.organizationId),
      ]);

      if (!canManage && !isAdmin) {
        throw tmRpcError(this.logger, 'change defects', {
          code: 'TM011',
          message: '',
        });
      }
    }

    if (run.execution?.is_archived) throw executionArchivedError();

    return { run, settings };
  }

  private async createTicket(
    user: RequestUser,
    spaceId: string,
    dto: CreateDefectDto,
    taskTypeId: string,
  ): Promise<CreatedDefectTask> {
    try {
      const { task } = await this.tasksWrite.createTask(user, {
        spaceIdOrKey: spaceId,
        summary: dto.summary,

        // The dialog sends plain text and the ticket shows rich text, so it is escaped here.
        description: plainTextToTicketHtml(dto.description) || undefined,
        priority: dto.priority,
        taskTypeId,
      });

      return { id: task.id, key: task.key ?? '', summary: task.summary };
    } catch (error) {
      // The ticket service answers every denial with 404; here the run is known, so it is a 403.
      if (error instanceof NotFoundException) {
        throw this.forbidden('You cannot create tickets in this space');
      }

      throw error;
    }
  }

  private insertLink(
    user: RequestUser,
    spaceId: string,
    run: RunRow,
    fields: { task_id: string; request_id?: string },
  ) {
    return this.client
      .from('test_ticket_links')
      .insert({
        organization_id: user.organizationId,
        space_id: spaceId,
        link_type: 'defect',
        run_id: run.id,
        attempt_no: run.current_attempt_no,
        created_by: user.userId,
        ...fields,
      })
      .select(LINK_COLUMNS)
      .single() as unknown as PromiseLike<{
      data: RunDefectLink | null;
      error: TmRpcError | null;
    }>;
  }

  private async findLink(
    organizationId: string,
    spaceId: string,
    runId: string,
    column: 'task_id' | 'request_id',
    value: string,
  ): Promise<RunDefectLink | null> {
    const { data, error } = await this.client
      .from('test_ticket_links')
      .select(LINK_COLUMNS)
      .eq('run_id', runId)
      .eq(column, value)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load defect link', error);

    return data as RunDefectLink | null;
  }

  private async replay(
    user: RequestUser,
    link: RunDefectLink,
  ): Promise<DefectWrite<DefectCreated>> {
    return {
      replayed: true,
      body: {
        linked: true,
        link,
        task: await this.taskRef(user, link.task_id),
      },
    };
  }

  /** Key and summary for a replay; read from the ticket itself when the caller can no longer see it. */
  private async taskRef(
    user: RequestUser,
    taskId: string,
  ): Promise<CreatedDefectTask> {
    const item = (await this.visibility.visibleTasks(user, [taskId])).get(
      taskId,
    );

    if (item) return { id: item.id, key: item.key, summary: item.summary };

    const { data, error } = await this.client
      .from('tasks')
      .select('key, summary')
      .eq('id', taskId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load defect ticket', error);

    const row = data as { key: string | null; summary: string | null } | null;

    return { id: taskId, key: row?.key ?? '', summary: row?.summary ?? '' };
  }

  private has(user: RequestUser, spaceId: string, key: string) {
    return this.permissions.hasSpacePermission(
      user.userId,
      user.organizationId,
      spaceId,
      key,
    );
  }

  private forbidden(message: string) {
    return new ForbiddenException({ code: 'FORBIDDEN', message });
  }

  private audit(
    user: RequestUser,
    spaceId: string,
    runId: string,
    changes: Record<string, unknown>,
  ) {
    void this.auditLogs.logActionForRequest(user, 'test_run', runId, 'update', {
      space_id: spaceId,
      ...changes,
    });
  }
}
