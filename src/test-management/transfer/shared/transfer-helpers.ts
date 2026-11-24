import {
  BadRequestException,
  ForbiddenException,
  type HttpException,
  type Logger,
} from '@nestjs/common';

import type { RequestUser } from '../../../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../../../permissions/permissions.service';
import { kindTaskTypeId } from '../../common/test-task-types';
import {
  tmDbError,
  tmRpcError,
  type TmRpcError,
} from '../../test-management-errors';

export interface FolderNode {
  id: string;
  parent_id: string | null;
  name: string;
}

export function fileError(
  message: string,
  data?: Record<string, unknown>,
  code = 'VALIDATION_FAILED',
): BadRequestException {
  return new BadRequestException({
    code,
    message,
    ...(data && { data }),
  });
}

/** Full path of every folder, segments joined by '/' (folder names cannot contain '/'). */
export function folderPaths(folders: FolderNode[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();

  const pathOf = (id: string, seen: Set<string>): string => {
    const known = paths.get(id);

    if (known !== undefined) return known;

    const folder = byId.get(id);

    // A missing parent or a loop ends the chain instead of recursing forever.
    if (!folder || seen.has(id)) return '';

    seen.add(id);

    const parent = folder.parent_id ? pathOf(folder.parent_id, seen) : '';
    const path = parent ? `${parent}/${folder.name}` : folder.name;

    paths.set(id, path);

    return path;
  };

  for (const folder of folders) pathOf(folder.id, new Set());

  return paths;
}

const TICKET_SETUP_CODES = ['TICKET_TYPE_MISSING', 'TICKET_DEFAULTS_MISSING'];

/** New cases get tickets, so they need the right to create tasks and a ticket type; checked before anything is saved. */
export async function assertCaseTicketsAllowed(
  client: Parameters<typeof kindTaskTypeId>[0],
  logger: Logger,
  permissions: PermissionsService,
  user: RequestUser,
  spaceId: string,
): Promise<void> {
  const allowed = await permissions.checkPermission(
    user.userId,
    user.organizationId,
    'can_create_tasks',
  );

  if (!allowed) {
    throw new ForbiddenException({
      code: 'TICKET_CREATE_FORBIDDEN',
      message: 'You need permission to create tasks to import new test cases.',
    });
  }

  const typeId = await kindTaskTypeId(
    client,
    logger,
    user.organizationId,
    spaceId,
    'case_task_type_id',
  );

  if (!typeId) {
    throw new BadRequestException({
      code: 'TICKET_TYPE_MISSING',
      message: 'This space has no task type set up for test cases.',
    });
  }

  // Checked here too, because the import function only finds out after preconditions were saved.
  const defaultExists = async (
    table: 'task_statuses' | 'task_priorities',
    key: string,
  ) => {
    const { data, error } = await client
      .from(table)
      .select('id')
      .eq('organization_id', user.organizationId)
      .or(`space_id.eq.${spaceId},space_id.is.null`)
      .eq('key', key)
      .eq('is_active', true)
      .limit(1);

    if (error) throw tmDbError(logger, 'check ticket defaults', error);

    return (data ?? []).length > 0;
  };

  if (
    !(await defaultExists('task_statuses', 'open')) ||
    !(await defaultExists('task_priorities', 'medium'))
  ) {
    throw new BadRequestException({
      code: 'TICKET_DEFAULTS_MISSING',
      message:
        'This space has no open status or no medium priority for new tickets.',
    });
  }
}

/** Like tmRpcError, but a space without ticket settings answers with its own code so the screens can name it. */
export function caseImportError(
  logger: Logger,
  action: string,
  error: TmRpcError,
): HttpException {
  const mapped = tmRpcError(logger, action, error);
  const { data, message } = mapped.getResponse() as {
    data?: { code?: string };
    message?: string;
  };

  return error.code === '22023' && TICKET_SETUP_CODES.includes(data?.code ?? '')
    ? new BadRequestException({ code: data?.code, message })
    : mapped;
}
