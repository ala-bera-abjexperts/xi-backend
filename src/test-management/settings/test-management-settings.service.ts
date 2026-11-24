import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TaskHierarchyConfigService } from '../../task-hierarchy-config/task-hierarchy-config.service';
import { TestManagementAccessService } from '../access/test-management-access.service';
import {
  KIND_TYPE_COLUMNS,
  readTestTaskTypes,
} from '../common/test-task-types';
import type {
  TestManagementSettingsResponseDto,
  UpdateTestManagementSettingsDto,
} from '../dto/test-management-settings.dto';
import {
  TEST_STATUSES,
  type TestStatusResponseDto,
} from '../dto/test-status.dto';
import { tmDbError } from '../test-management-errors';
import type { ApprovalSettings } from '../automation/custom-images/approval/rules/approval-rules';
import { CustomImageApprovalService } from '../automation/custom-images/approval/service/custom-image-approval.service';

const SETTINGS_COLUMNS =
  'assignee_only, coverable_task_type_ids, defect_task_type_id, case_task_type_id, set_task_type_id, plan_task_type_id, execution_task_type_id, precondition_task_type_id, test_types, requirement_link_task_type_ids';

// The task type chosen for each test kind; a type may serve only one kind.
const KIND_FIELDS = KIND_TYPE_COLUMNS;

type KindField = (typeof KIND_FIELDS)[number];

// Each starting type in task_type_defaults fills one of the mapping columns.
const KIND_FIELD_BY_KIND: Record<string, KindField> = {
  cases: 'case_task_type_id',
  sets: 'set_task_type_id',
  plans: 'plan_task_type_id',
  executions: 'execution_task_type_id',
  preconditions: 'precondition_task_type_id',
};

// Test Management's case type name.
const CASE_TYPE_NAME = 'Test cases';

interface TaskTypeDefault {
  kind: string;
  id: string;
  name: string;
  name_i18n?: Record<string, string>;
  color?: string;
  icon?: string;
  sort_order?: number;
}

type TicketTypeRow = Partial<Record<KindField, string | null>> & {
  task_type_defaults: TaskTypeDefault[];
};

type SettingsChanges = Partial<
  Pick<
    TestManagementSettingsResponseDto,
    | 'assignee_only'
    | 'coverable_task_type_ids'
    | 'defect_task_type_id'
    | 'requirement_link_task_type_ids'
    | 'image_approval_required'
    | 'image_approval_rule'
    | 'image_approval_approvers'
  >
>;

type TraceabilityField =
  | 'coverable_task_type_ids'
  | 'defect_task_type_id'
  | 'requirement_link_task_type_ids';

@Injectable()
export class TestManagementSettingsService {
  private readonly logger = new Logger(TestManagementSettingsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly auditLogs: AuditLogsService,
    // Optional so unit tests can build the service without it.
    @Optional() private readonly taskHierarchy?: TaskHierarchyConfigService,
    @Optional() private readonly imageApprovals?: CustomImageApprovalService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getSettings(
    organizationId: string,
    spaceId: string,
  ): Promise<TestManagementSettingsResponseDto> {
    await this.access.assertAvailable(organizationId, spaceId);

    const settings = await this.readSettings(organizationId, spaceId);

    if (!this.taskHierarchy || KIND_FIELDS.every((field) => settings[field])) {
      return this.withApproval(organizationId, spaceId, settings);
    }

    // A space whose type mapping went missing gets it back the first time its settings are read.
    try {
      await this.syncTaskTypes(organizationId, spaceId, true, null);

      return this.withApproval(
        organizationId,
        spaceId,
        await this.readSettings(organizationId, spaceId),
      );
    } catch (error) {
      this.logger.warn(
        `Could not restore the test task types of space ${spaceId}: ${error instanceof Error ? error.message : String(error)}`,
      );

      return this.withApproval(organizationId, spaceId, settings);
    }
  }

  /** Adds the custom image approval choice once its columns exist; read apart so a missing column breaks nothing. */
  private async withApproval(
    organizationId: string,
    spaceId: string,
    settings: TestManagementSettingsResponseDto,
  ): Promise<TestManagementSettingsResponseDto> {
    const approvals = this.imageApprovals;
    const approval = await approvals?.settingsIfAvailable(
      organizationId,
      spaceId,
    );

    if (!approvals || !approval) return settings;

    return {
      ...settings,
      image_approval_required: approval.required,
      image_approval_rule: approval.rule,
      ...(approval.approversColumn && {
        image_approval_approvers: approval.approvers,
      }),
      // Warns the screen when nobody could approve an admin's image.
      ...(approval.required && {
        image_approval_has_owners: await approvals.hasOwners(
          organizationId,
          spaceId,
        ),
      }),
    };
  }

  /** Only space owners and admins, or organisation owners and admins, change the approval choice. */
  private async checkApprovalChanges(
    user: RequestUser,
    spaceId: string,
    changes: SettingsChanges,
  ): Promise<ApprovalSettings | null> {
    const sent =
      changes.image_approval_required !== undefined ||
      changes.image_approval_rule !== undefined ||
      changes.image_approval_approvers !== undefined;

    if (!sent) return null;

    const before = this.imageApprovals
      ? await this.imageApprovals.settingsIfAvailable(
          user.organizationId,
          spaceId,
        )
      : null;

    if (
      !this.imageApprovals ||
      !before ||
      (changes.image_approval_approvers !== undefined &&
        !before.approversColumn)
    ) {
      throw new BadRequestException({
        code: 'IMAGE_APPROVAL_UNAVAILABLE',
        message: 'Custom image approval is not available yet on this server',
      });
    }

    const approversChanged =
      (changes.image_approval_approvers ?? before.approvers) !==
      before.approvers;

    // Only owners choose who approves, so an admin can't make themselves an approver.
    if (
      approversChanged &&
      !(await this.imageApprovals.canChooseApprovers(user, spaceId))
    ) {
      throw new ForbiddenException({
        code: 'APPROVAL_SETTINGS_FORBIDDEN',
        message: 'Only space owners can change who approves custom images',
      });
    }

    const changed =
      approversChanged ||
      (changes.image_approval_required ?? before.required) !==
        before.required ||
      (changes.image_approval_rule ?? before.rule) !== before.rule;

    // Sending the saved values again is fine for anyone who may edit settings.
    if (changed && !(await this.imageApprovals.canManage(user, spaceId))) {
      throw new ForbiddenException({
        code: 'APPROVAL_SETTINGS_FORBIDDEN',
        message:
          'Only space owners and admins can change custom image approval',
      });
    }

    return before;
  }

  /** Switched on: images in use are asked about; a new rule or approver choice is applied to waiting requests. Never fails the save. */
  private afterApprovalSaved(
    user: RequestUser,
    spaceId: string,
    before: ApprovalSettings,
    saved: TestManagementSettingsResponseDto,
  ): void {
    const approvals = this.imageApprovals;

    if (!approvals || !saved.image_approval_required) return;

    const ruleChanged =
      before.rule !== saved.image_approval_rule ||
      before.approvers !== (saved.image_approval_approvers ?? 'owners');

    if (before.required && !ruleChanged) return;

    const job = before.required
      ? approvals.refreshWaiting(user.organizationId, spaceId)
      : approvals.requestForSpace(user.organizationId, spaceId);

    void job.catch((error: unknown) =>
      this.logger.warn(
        `Image approval follow-up for space ${spaceId} failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  private async readSettings(
    organizationId: string,
    spaceId: string,
  ): Promise<TestManagementSettingsResponseDto> {
    const { data, error } = await this.client
      .from('test_management_space_settings')
      .select(SETTINGS_COLUMNS)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load settings', error);

    return toSettings(data as TestManagementSettingsResponseDto | null);
  }

  /** Writes only the fields sent; requirement and defect types are checked against the space's ticket types. */
  async updateSettings(
    user: RequestUser,
    spaceId: string,
    dto: UpdateTestManagementSettingsDto,
  ): Promise<TestManagementSettingsResponseDto> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // The validation pipe sets every declared field, so a field not sent is undefined.
    const changes: SettingsChanges = {};

    if (dto.assignee_only !== undefined)
      changes.assignee_only = dto.assignee_only;
    if (dto.coverable_task_type_ids !== undefined)
      changes.coverable_task_type_ids = dto.coverable_task_type_ids;
    if (dto.defect_task_type_id !== undefined)
      changes.defect_task_type_id = dto.defect_task_type_id;
    if (dto.requirement_link_task_type_ids !== undefined)
      changes.requirement_link_task_type_ids =
        dto.requirement_link_task_type_ids;
    if (dto.image_approval_required !== undefined)
      changes.image_approval_required = dto.image_approval_required;
    if (dto.image_approval_rule !== undefined)
      changes.image_approval_rule = dto.image_approval_rule;
    if (dto.image_approval_approvers !== undefined)
      changes.image_approval_approvers = dto.image_approval_approvers;

    if (Object.keys(changes).length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Send at least one setting',
      });
    }

    if (
      changes.coverable_task_type_ids !== undefined ||
      changes.defect_task_type_id !== undefined ||
      changes.requirement_link_task_type_ids !== undefined
    ) {
      await this.assertTraceabilityTypes(user.organizationId, spaceId, changes);
    }

    const approvalBefore = await this.checkApprovalChanges(
      user,
      spaceId,
      changes,
    );

    const { data, error } = await this.client
      .from('test_management_space_settings')
      .upsert(
        {
          space_id: spaceId,
          organization_id: user.organizationId,
          ...changes,
          updated_by: user.userId,
        },
        { onConflict: 'space_id' },
      )
      .select(SETTINGS_COLUMNS)
      .single();

    if (error) throw tmDbError(this.logger, 'save settings', error);

    void this.auditLogs.logActionForRequest(
      user,
      'test_management_settings',
      spaceId,
      'update',
      changes,
    );

    const saved = await this.withApproval(
      user.organizationId,
      spaceId,
      toSettings(data as TestManagementSettingsResponseDto),
    );

    if (approvalBefore) {
      this.afterApprovalSaved(user, spaceId, approvalBefore, saved);
    }

    return saved;
  }

  /** A type must be active (or already saved in that field), never a test ticket type, and the defect type is never a requirement type. */
  private async assertTraceabilityTypes(
    organizationId: string,
    spaceId: string,
    changes: SettingsChanges,
  ): Promise<void> {
    if (!this.taskHierarchy) {
      throw new InternalServerErrorException(
        'Task hierarchy configuration service is unavailable',
      );
    }

    const [types, saved] = await Promise.all([
      this.taskHierarchy.getActiveTypes(organizationId, spaceId),
      this.readSettings(organizationId, spaceId),
    ]);
    const activeIds = new Set(types.map((type) => type.id));
    const testIds = new Set(
      KIND_FIELDS.map((field) => saved[field]).filter((id): id is string =>
        Boolean(id),
      ),
    );

    const check = (
      field: TraceabilityField,
      ids: string[],
      kept: (string | null)[],
    ) => {
      const unknown = ids.filter(
        (id) => !activeIds.has(id) && !kept.includes(id),
      );

      if (unknown.length > 0)
        throw invalidTypes(field, unknown, 'Unknown or inactive ticket type');

      const test = ids.filter((id) => testIds.has(id));

      // Test Management tickets may be linked as requirements, but never counted as one.
      if (test.length > 0 && field !== 'requirement_link_task_type_ids') {
        throw invalidTypes(
          field,
          test,
          'A Test Management ticket type cannot be a requirement or defect type',
        );
      }
    };

    if (changes.coverable_task_type_ids) {
      check(
        'coverable_task_type_ids',
        changes.coverable_task_type_ids,
        saved.coverable_task_type_ids,
      );
    }

    if (changes.defect_task_type_id) {
      check(
        'defect_task_type_id',
        [changes.defect_task_type_id],
        [saved.defect_task_type_id],
      );
    }

    if (changes.requirement_link_task_type_ids) {
      check(
        'requirement_link_task_type_ids',
        changes.requirement_link_task_type_ids,
        saved.requirement_link_task_type_ids,
      );
    }
  }

  /** The status vocabulary is fixed in the schema (CHECK lists), so it is served from code. */
  async listStatuses(
    organizationId: string,
    spaceId: string,
  ): Promise<TestStatusResponseDto[]> {
    await this.access.assertAvailable(organizationId, spaceId);

    return [...TEST_STATUSES];
  }

  /** Adds the test task types when the module is switched on and deactivates them when it is switched off. */
  async syncTaskTypes(
    organizationId: string,
    spaceId: string,
    enabled: boolean,
    userId: string | null,
  ): Promise<void> {
    if (!this.taskHierarchy) {
      throw new InternalServerErrorException(
        'Task hierarchy configuration service is unavailable',
      );
    }

    const columns = `${KIND_FIELDS.join(', ')}, task_type_defaults`;
    const stored = await this.client
      .from('test_management_space_settings')
      .select(columns)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle<TicketTypeRow>();

    if (stored.error) {
      throw tmDbError(this.logger, 'load settings', stored.error);
    }
    if (!stored.data && !enabled) return;

    // A new settings row picks up the starting task types from the column default.
    let row = stored.data;
    if (!row) {
      const created = await this.client
        .from('test_management_space_settings')
        .insert({
          space_id: spaceId,
          organization_id: organizationId,
          updated_by: userId,
        })
        .select(columns)
        .single<TicketTypeRow>();

      if (created.error) {
        throw tmDbError(this.logger, 'create settings', created.error);
      }
      row = created.data;
    }

    const saved = row;
    const types = saved.task_type_defaults
      .filter((type) => KIND_FIELD_BY_KIND[type.kind])
      .map(({ kind, ...level }) => ({
        key: KIND_FIELD_BY_KIND[kind],
        currentId: saved[KIND_FIELD_BY_KIND[kind]] ?? null,
        level:
          kind === 'cases'
            ? {
                ...level,
                name: CASE_TYPE_NAME,
                name_i18n: { ...level.name_i18n, de: 'Testfälle' },
              }
            : level,
        renameFrom: kind === 'cases' ? ['Test case', 'Test'] : undefined,
      }));
    const ids = await this.taskHierarchy.ensureTaskTypes(
      organizationId,
      spaceId,
      types,
      enabled,
      userId,
    );
    const changes = Object.fromEntries(
      Object.entries(ids).filter(
        ([field, id]) => saved[field as KindField] !== id,
      ),
    );

    if (Object.keys(changes).length === 0) return;

    const { error } = await this.client
      .from('test_management_space_settings')
      .update({ ...changes, updated_by: userId })
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (error) throw tmDbError(this.logger, 'save settings', error);
  }

  /** Task type ids the space uses for test kinds; no module check, because templates read it while the module is off. */
  async mappedTaskTypeIds(
    organizationId: string,
    spaceId: string,
  ): Promise<string[]> {
    const { types, error } = await readTestTaskTypes(
      this.client,
      organizationId,
      spaceId,
    );

    if (error) throw tmDbError(this.logger, 'load settings', error);

    return [...types.keys()];
  }
}

function invalidTypes(
  field: TraceabilityField,
  ids: string[],
  message: string,
): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_FAILED',
    message,
    data: { field, task_type_ids: ids },
  });
}

function toSettings(
  row: TestManagementSettingsResponseDto | null,
): TestManagementSettingsResponseDto {
  return {
    assignee_only: row?.assignee_only ?? false,
    coverable_task_type_ids: row?.coverable_task_type_ids ?? [],
    defect_task_type_id: row?.defect_task_type_id ?? null,
    case_task_type_id: row?.case_task_type_id ?? null,
    set_task_type_id: row?.set_task_type_id ?? null,
    plan_task_type_id: row?.plan_task_type_id ?? null,
    execution_task_type_id: row?.execution_task_type_id ?? null,
    precondition_task_type_id: row?.precondition_task_type_id ?? null,
    test_types: row?.test_types ?? [],
    requirement_link_task_type_ids: row?.requirement_link_task_type_ids ?? [],
  };
}
