import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { fetchAllRows } from '../../common/utils/fetch-all-rows';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../access/test-management-access.service';
import type {
  CreateTestFolderDto,
  TestFolder,
  UpdateTestFolderDto,
} from '../dto/test-folder.dto';
import {
  notFound,
  tmDbError,
  tmRpcError,
  type TmRpcError,
} from '../test-management-errors';

// The embedded counts are filtered to active items by the is_archived filters on each embed.
const FOLDER_COLUMNS_WITHOUT_POSITION =
  'id, parent_id, name, created_at, updated_at, test_cases(count), test_sets!test_sets_folder_fkey(count), test_plans!test_plans_folder_fkey(count)';

const FOLDER_COLUMNS = `${FOLDER_COLUMNS_WITHOUT_POSITION}, position`;

type CountRows = { count: number }[] | null;

type FolderRow = Omit<
  TestFolder,
  'case_count' | 'set_count' | 'plan_count' | 'execution_count' | 'position'
> & {
  position?: number | null;
  test_cases: CountRows;
  test_sets: CountRows;
  test_plans: CountRows;
};

function toFolder(
  { test_cases, test_sets, test_plans, ...folder }: FolderRow,
  executionCount = 0,
): TestFolder {
  return {
    ...folder,
    position: folder.position ?? null,
    case_count: test_cases?.[0]?.count ?? 0,
    set_count: test_sets?.[0]?.count ?? 0,
    plan_count: test_plans?.[0]?.count ?? 0,
    execution_count: executionCount,
  };
}

// Folders placed by drag and drop come first in their order; the others follow by name.
function folderOrder(a: TestFolder, b: TestFolder): number {
  if (a.position !== null && b.position !== null && a.position !== b.position) {
    return a.position - b.position;
  }

  if (a.position !== null && b.position === null) return -1;
  if (a.position === null && b.position !== null) return 1;

  return a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' });
}

// A database without the executions folder column (or the folder position column) answers 42703, or PGRST204 from
// the schema cache.
const MISSING_COLUMN = new Set(['42703', 'PGRST204']);

/** Folder tree of a space; writes go through tm_* functions that lock the tree and check depth and cycles. */
@Injectable()
export class TestFoldersService {
  private readonly logger = new Logger(TestFoldersService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async rpc<T>(
    fn: string,
    args: Record<string, unknown>,
    action: string,
  ): Promise<T> {
    const { data, error } = (await this.client.rpc(fn, args)) as {
      data: T;
      error: TmRpcError | null;
    };

    if (error) throw tmRpcError(this.logger, action, error);

    return data;
  }

  async list(organizationId: string, spaceId: string): Promise<TestFolder[]> {
    await this.access.assertAvailable(organizationId, spaceId);

    // The tree needs every folder, so read past the API row limit in pages; ordering by id keeps pages stable.
    const { rows } = await fetchAllRows(async (from, to) => {
      const read = (columns: string) =>
        this.client
          .from('test_folders')
          .select(columns)
          .eq('space_id', spaceId)
          .eq('organization_id', organizationId)
          .eq('test_cases.is_archived', false)
          .eq('test_sets.is_archived', false)
          .eq('test_plans.is_archived', false)
          .order('id')
          .range(from, to);

      let page = await read(FOLDER_COLUMNS);

      // Before the folder order migration there is no position column; the tree then reads in name order.
      if (page.error && MISSING_COLUMN.has(page.error.code)) {
        page = await read(FOLDER_COLUMNS_WITHOUT_POSITION);
      }

      if (page.error)
        throw tmDbError(this.logger, 'list test folders', page.error);

      return page;
    }, Infinity);

    const executions = await this.executionCounts(organizationId, spaceId);

    return (rows as unknown as FolderRow[])
      .map((row) => toFolder(row, executions.get(row.id) ?? 0))
      .sort(folderOrder);
  }

  async create(
    user: RequestUser,
    spaceId: string,
    dto: CreateTestFolderDto,
  ): Promise<TestFolder> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const parentId = dto.parent_id ?? null;
    const result = await this.rpc<{ id: string }>(
      'tm_save_folder',
      {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_folder_id: null,
        p_parent_id: parentId,
        p_name: dto.name,
      },
      'create test folder',
    );

    void this.auditLogs.logActionForRequest(
      user,
      'test_folder',
      result.id,
      'create',
      { name: dto.name, parent_id: parentId, space_id: spaceId },
    );

    return this.load(user.organizationId, spaceId, result.id);
  }

  async update(
    user: RequestUser,
    spaceId: string,
    folderId: string,
    dto: UpdateTestFolderDto,
  ): Promise<TestFolder> {
    if (
      dto.name === undefined &&
      dto.parent_id === undefined &&
      dto.sibling_order === undefined
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Provide a name or a parent_id',
      });
    }

    if (dto.name !== undefined && dto.sibling_order !== undefined) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Rename and reorder a folder in separate requests',
      });
    }

    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // tm_save_folder treats a null parent as the root, so a rename alone must pass the current parent.
    const parentId =
      dto.parent_id !== undefined
        ? dto.parent_id
        : (await this.load(user.organizationId, spaceId, folderId)).parent_id;

    // A drop above or below another folder moves it when needed and saves the order of its new sister folders.
    if (dto.sibling_order !== undefined) {
      await this.rpc<{ changed: boolean }>(
        'tm_place_folder',
        {
          p_organization_id: user.organizationId,
          p_space_id: spaceId,
          p_actor_id: user.userId,
          p_folder_id: folderId,
          p_parent_id: parentId,
          p_order: dto.sibling_order,
        },
        'reorder test folder',
      );

      void this.auditLogs.logActionForRequest(
        user,
        'test_folder',
        folderId,
        'update',
        {
          space_id: spaceId,
          parent_id: dto.parent_id,
          sibling_order: dto.sibling_order,
        },
      );

      return this.load(user.organizationId, spaceId, folderId);
    }

    const result = await this.rpc<{ changed: boolean }>(
      'tm_save_folder',
      {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_folder_id: folderId,
        p_parent_id: parentId,
        p_name: dto.name ?? null,
      },
      'update test folder',
    );

    if (result.changed) {
      void this.auditLogs.logActionForRequest(
        user,
        'test_folder',
        folderId,
        'update',
        { space_id: spaceId, name: dto.name, parent_id: dto.parent_id },
      );
    }

    return this.load(user.organizationId, spaceId, folderId);
  }

  /** Only empty folders can be deleted (409 FOLDER_NOT_EMPTY otherwise). */
  async remove(
    user: RequestUser,
    spaceId: string,
    folderId: string,
  ): Promise<void> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    await this.rpc<{ changed: boolean }>(
      'tm_delete_folder',
      {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_folder_id: folderId,
      },
      'delete test folder',
    );

    void this.auditLogs.logActionForRequest(
      user,
      'test_folder',
      folderId,
      'delete',
      { space_id: spaceId },
    );
  }

  private async load(
    organizationId: string,
    spaceId: string,
    folderId: string,
  ): Promise<TestFolder> {
    const read = (columns: string) =>
      this.client
        .from('test_folders')
        .select(columns)
        .eq('id', folderId)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .eq('test_cases.is_archived', false)
        .eq('test_sets.is_archived', false)
        .eq('test_plans.is_archived', false)
        .maybeSingle();

    let result = await read(FOLDER_COLUMNS);

    // Same fallback as the list, for a database without the folder order migration.
    if (result.error && MISSING_COLUMN.has(result.error.code)) {
      result = await read(FOLDER_COLUMNS_WITHOUT_POSITION);
    }

    const { data, error } = result;

    if (error) throw tmDbError(this.logger, 'load test folder', error);
    if (!data) throw notFound();

    const executions = await this.executionCounts(
      organizationId,
      spaceId,
      folderId,
    );

    return toFolder(
      data as unknown as FolderRow,
      executions.get(folderId) ?? 0,
    );
  }

  /** Active test executions per folder, read apart from the folder embeds so a missing column never fails the tree. */
  private async executionCounts(
    organizationId: string,
    spaceId: string,
    folderId?: string,
  ): Promise<Map<string, number>> {
    const { rows } = await fetchAllRows<{ folder_id: string }>(
      async (from, to) => {
        let query = this.client
          .from('test_executions')
          .select('folder_id')
          .eq('space_id', spaceId)
          .eq('organization_id', organizationId)
          .eq('is_archived', false)
          .not('folder_id', 'is', null);

        if (folderId) query = query.eq('folder_id', folderId);

        const page = await query.order('id').range(from, to);

        if (page.error && MISSING_COLUMN.has(page.error.code)) {
          return { data: [], error: null };
        }

        if (page.error) {
          throw tmDbError(this.logger, 'count folder executions', page.error);
        }

        return { data: page.data as { folder_id: string }[], error: null };
      },
      Infinity,
    );

    const counts = new Map<string, number>();

    for (const row of rows) {
      counts.set(row.folder_id, (counts.get(row.folder_id) ?? 0) + 1);
    }

    return counts;
  }
}
