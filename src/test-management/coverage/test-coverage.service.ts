import { Injectable, Logger, Optional } from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TaskHierarchyConfigService } from '../../task-hierarchy-config/task-hierarchy-config.service';
import type { TaskPickerItem } from '../../tasks/task-picker/task-picker.service';
import { TestManagementAccessService } from '../access/test-management-access.service';
import { TaskVisibilityService } from '../common/task-visibility.service';
import { KIND_TYPE_COLUMNS } from '../common/test-task-types';
import {
  COVERAGE_STATUSES,
  TEST_COVERAGE_LIMITS,
  type CoverageQueryDto,
  type CoveragePage,
  type CoverageRow,
  type CoverageStatus,
  type CoverageTotals,
} from '../dto/test-coverage.dto';
import type { TestManagementSettingsResponseDto } from '../dto/test-management-settings.dto';
import { TestManagementSettingsService } from '../settings/test-management-settings.service';
import {
  notFound,
  tmDbError,
  tmRpcError,
  type TmRpcError,
} from '../test-management-errors';

interface CoverageDbRow {
  task_id: string;
  task_key: string;
  task_summary: string;
  task_type_id: string | null;
  status: CoverageStatus;
  counted: number;
  totals: CoverageTotals;
  case_ids: string[];
}

interface TicketTypeRow {
  id: string;
  key: string;
  summary: string;
  task_type_id: string | null;
}

/** Same shape as a database row for a ticket that no test case covers. */
function uncoveredRow(ticket: TicketTypeRow): CoverageDbRow {
  return {
    task_id: ticket.id,
    task_key: ticket.key,
    task_summary: ticket.summary,
    task_type_id: ticket.task_type_id,
    status: 'UNCOVERED',
    counted: 0,
    totals: { fail: 0, blocked: 0, not_run: 0, pass: 0, not_applicable: 0 },
    case_ids: [],
  };
}

/** Requirement coverage of a space or plan, with ticket details only for tickets the caller may see. */
@Injectable()
export class TestCoverageService {
  private readonly logger = new Logger(TestCoverageService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly settings: TestManagementSettingsService,
    private readonly visibility: TaskVisibilityService,
    private readonly permissions: PermissionsService,
    private readonly orgModules: OrganizationModulesService,
    @Optional() private readonly taskHierarchy?: TaskHierarchyConfigService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async coverage(
    user: RequestUser,
    spaceId: string,
    query: CoverageQueryDto,
  ): Promise<CoveragePage> {
    const organizationId = user.organizationId;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;

    await this.access.assertAvailable(organizationId, spaceId);

    const [settings, caseTasks, canListUnlinked, ticket] = await Promise.all([
      this.settings.getSettings(organizationId, spaceId),
      query.caseId
        ? this.caseTaskIds(organizationId, spaceId, query.caseId)
        : Promise.resolve(null),
      query.includeUncovered
        ? this.canViewSpaceTickets(user, spaceId)
        : Promise.resolve(false),
      query.taskId
        ? this.spaceTicket(organizationId, spaceId, query.taskId)
        : Promise.resolve(null),
    ]);

    const requirementTypes = await this.requirementTypeIds(
      organizationId,
      spaceId,
      settings,
    );

    if (requirementTypes === null) {
      return {
        items: [],
        total: 0,
        page,
        pageSize,
        status_totals: Object.fromEntries(
          COVERAGE_STATUSES.map((status) => [status, 0]),
        ) as Record<CoverageStatus, number>,
        truncated: false,
        uncovered_hidden: query.includeUncovered === true && !canListUnlinked,
      };
    }

    // One ticket still loads the whole space's coverage and filters it here;
    // add a p_task_id parameter to tm_requirement_coverage if that gets slow.
    // One database call, so every row comes from the same snapshot.
    const { data, error } = (await this.client.rpc('tm_requirement_coverage', {
      p_organization_id: organizationId,
      p_space_id: spaceId,
      p_plan_id: query.planId ?? null,
      p_coverable_type_ids: requirementTypes,
      p_include_unlinked: canListUnlinked,
      p_exclude_execution_id: null,
    })) as { data: CoverageDbRow[] | null; error: TmRpcError | null };

    if (error) throw tmRpcError(this.logger, 'load coverage', error);

    const all = data ?? [];
    const truncated = all.length >= TEST_COVERAGE_LIMITS.rows;
    let scoped = caseTasks
      ? all.filter((row) => caseTasks.has(row.task_id))
      : all;

    if (ticket) {
      scoped = scoped.filter((row) => row.task_id === ticket.id);

      // A counted ticket without links gets no row from the database, so it is reported as uncovered here.
      const counted =
        requirementTypes.length === 0 ||
        (ticket.task_type_id !== null &&
          requirementTypes.includes(ticket.task_type_id));

      if (scoped.length === 0 && !truncated && counted) {
        scoped = [uncoveredRow(ticket)];
      }
    }

    const visible = await this.visibility.visibleTasks(
      user,
      scoped.map((row) => row.task_id),
    );

    // Hidden tickets go last, by id, so their place in the key order reveals nothing.
    const ordered = [
      ...scoped.filter((row) => visible.has(row.task_id)),
      ...scoped
        .filter((row) => !visible.has(row.task_id))
        .sort((a, b) => a.task_id.localeCompare(b.task_id)),
    ];
    const statusTotals = Object.fromEntries(
      COVERAGE_STATUSES.map((status) => [status, 0]),
    ) as Record<CoverageStatus, number>;

    for (const row of ordered) statusTotals[row.status] += 1;

    const filtered = query.status
      ? ordered.filter((row) => row.status === query.status)
      : ordered;

    return {
      items: filtered
        .slice((page - 1) * pageSize, page * pageSize)
        .map((row) => toCoverageRow(row, visible.get(row.task_id))),
      total: filtered.length,
      page,
      pageSize,
      status_totals: statusTotals,
      truncated,
      uncovered_hidden: query.includeUncovered === true && !canListUnlinked,
    };
  }

  /** An empty requirement list means every type except the test types, so test tickets never count as requirements. Null means nothing counts. */
  private async requirementTypeIds(
    organizationId: string,
    spaceId: string,
    settings: TestManagementSettingsResponseDto,
  ): Promise<string[] | null> {
    if (settings.coverable_task_type_ids.length > 0)
      return settings.coverable_task_type_ids;

    const testTypes = new Set(
      KIND_TYPE_COLUMNS.map((column) => settings[column]).filter(
        (id): id is string => Boolean(id),
      ),
    );

    if (testTypes.size === 0 || !this.taskHierarchy) return [];

    const { config } = await this.taskHierarchy.getConfig(
      organizationId,
      spaceId,
    );

    // Defect tickets are found by tests, so they never count as requirements.
    const ids = config.levels
      .map((level) => level.id)
      .filter(
        (id) => !testTypes.has(id) && id !== settings.defect_task_type_id,
      );

    return ids.length > 0 ? ids : null;
  }

  /** Tickets linked directly to the test case as requirements. */
  private async caseTaskIds(
    organizationId: string,
    spaceId: string,
    caseId: string,
  ): Promise<Set<string>> {
    const [found, links] = await Promise.all([
      this.client
        .from('test_cases')
        .select('id')
        .eq('id', caseId)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .maybeSingle(),
      this.client
        .from('test_ticket_links')
        .select('task_id')
        .eq('case_id', caseId)
        .eq('link_type', 'requirement')
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .range(0, TEST_COVERAGE_LIMITS.rows - 1),
    ]);

    if (found.error)
      throw tmDbError(this.logger, 'load test case', found.error);
    if (!found.data) throw notFound();
    if (links.error) {
      throw tmDbError(this.logger, 'load requirement links', links.error);
    }

    return new Set(
      ((links.data ?? []) as { task_id: string }[]).map((row) => row.task_id),
    );
  }

  /** The ticket asked for, which must belong to this space. */
  private async spaceTicket(
    organizationId: string,
    spaceId: string,
    taskId: string,
  ): Promise<TicketTypeRow> {
    const { data, error } = await this.client
      .from('tasks')
      .select('id, key, summary, task_type_id')
      .eq('id', taskId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load ticket', error);
    if (!data) throw notFound();

    return data as TicketTypeRow;
  }

  /** Unlinked tickets are listed only to callers who can view tickets of this space. */
  private async canViewSpaceTickets(
    user: RequestUser,
    spaceId: string,
  ): Promise<boolean> {
    const organizationId = user.organizationId;
    const [tenantOn, spaceOn, isAdmin] = await Promise.all([
      this.orgModules.isEnabled(organizationId, 'tasks'),
      this.orgModules.isSpaceModuleEnabled(organizationId, spaceId, 'tasks'),
      this.permissions.isAdminOrOwner(user.userId, organizationId),
    ]);

    if (!tenantOn || !spaceOn) return false;

    return (
      isAdmin ||
      this.permissions.hasSpacePermission(
        user.userId,
        organizationId,
        spaceId,
        'view_tasks',
      )
    );
  }
}

function toCoverageRow(
  row: CoverageDbRow,
  item: TaskPickerItem | undefined,
): CoverageRow {
  const base = {
    task_id: row.task_id,
    status: row.status,
    counted: row.counted,
    totals: row.totals,
    case_ids: row.case_ids,
  };

  return item
    ? {
        ...base,
        restricted: false,
        key: item.key,
        summary: item.summary,
        task_type_id: row.task_type_id,
        space_key: item.spaceKey,
      }
    : { ...base, restricted: true };
}
