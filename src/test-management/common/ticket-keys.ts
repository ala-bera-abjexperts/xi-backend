import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  type Logger,
} from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { htmlToPlainText } from '../../chat/chat-html';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { CreateTaskDto } from '../../tasks/dto/create-task.dto';
import type { TasksService } from '../../tasks/tasks.service';
import { notFound, tmDbError } from '../test-management-errors';
import { kindTaskTypeId, type KindTypeColumn } from './test-task-types';

type AdminClient = ReturnType<SupabaseAdminService['getClient']>;

/** What creating a test record through its ticket needs. */
export interface RecordTicketDeps {
  client: AdminClient;
  logger: Logger;
  tasks?: TasksService;
  permissions?: PermissionsService;
}

export type TicketRecordTable =
  | 'test_cases'
  | 'test_sets'
  | 'test_plans'
  | 'test_executions';

/** Reads a record's ticket; inner so search filters on the ticket also narrow the records and their count. */
export function ticketEmbed(
  table: TicketRecordTable,
  fields = 'key, summary',
): string {
  return `task:tasks!${table}_task_id_fkey!inner(${fields})`;
}

/** Searches the ticket key and summary; pass it to `.or()` with `referencedTable: 'task'`. */
export function ticketSearchFilter(search: string): string {
  return `key.ilike.${search},summary.ilike.${search}`;
}

/** The number at the end of a ticket key, for the `key_number` the API still returns. */
export function ticketKeyNumber(key: string | null | undefined): number {
  const match = key ? /(\d+)$/.exec(key) : null;

  return match ? Number(match[1]) : 0;
}

/** Orders ticket keys by their trailing number, then by text. */
export function compareTicketKeys(a: string, b: string): number {
  return ticketKeyNumber(a) - ticketKeyNumber(b) || a.localeCompare(b);
}

/** A record's key fields, all taken from its ticket. */
export function ticketKeyFields(key: string): {
  key: string;
  key_number: number;
  task_key: string;
} {
  return { key, key_number: ticketKeyNumber(key), task_key: key };
}

/** Summaries can hold outer spaces; record names and titles never show them. */
export function ticketName(summary: string): string {
  return summary.trim();
}

/** Rich text for sets and plans; an empty editor value counts as no description. */
export function ticketRichText(
  description: string | null | undefined,
): string | null {
  const text = description?.trim();

  return !text || text === '<p></p>' ? null : (description as string);
}

/** Executions show a plain text description, while their ticket holds rich text. */
export function ticketPlainText(
  description: string | null | undefined,
): string | null {
  return htmlToPlainText(description) || null;
}

/** Plain text as ticket rich text: everything is escaped, so text like `<4 items` stays text. */
export function plainTextToTicketHtml(text: string | null | undefined): string {
  if (!text) return '';

  const escape = (line: string) =>
    line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return text
    .split('\n')
    .map((line) => `<p>${escape(line)}</p>`)
    .join('');
}

/** Checked before a ticket is made, so a missing folder never leaves a ticket behind. */
export async function assertRecordFolder(
  client: AdminClient,
  logger: Logger,
  organizationId: string,
  spaceId: string,
  folderId: string,
): Promise<void> {
  const { data, error } = await client
    .from('test_folders')
    .select('id')
    .eq('id', folderId)
    .eq('space_id', spaceId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) throw tmDbError(logger, 'load test folder', error);
  if (!data) throw notFound({ folder_id: folderId });
}

/** Makes the ticket a new test record needs; refuses when the user can't create tasks or the space has no test type. */
export async function createRecordTicket(
  deps: RecordTicketDeps,
  user: RequestUser,
  spaceId: string,
  kind: KindTypeColumn,
  fields: Pick<CreateTaskDto, 'summary'> &
    Partial<
      Pick<
        CreateTaskDto,
        'description' | 'estimated_time' | 'start_date' | 'due_date'
      >
    >,
): Promise<{ id: string; key: string | null }> {
  if (!deps.tasks || !deps.permissions) {
    throw new Error('Tickets are not available');
  }

  // TasksService.create does not check rights itself; the tasks controller does.
  const allowed = await deps.permissions.checkPermission(
    user.userId,
    user.organizationId,
    'can_create_tasks',
  );

  if (!allowed) {
    throw new ForbiddenException({
      code: 'TICKET_CREATE_FORBIDDEN',
      message: 'You need permission to create tasks to add this test record.',
    });
  }

  const typeId = await kindTaskTypeId(
    deps.client,
    deps.logger,
    user.organizationId,
    spaceId,
    kind,
  );

  if (!typeId) {
    throw new BadRequestException({
      code: 'TICKET_TYPE_MISSING',
      message: 'This space has no task type set up for this test record.',
    });
  }

  // Every caller sits behind a Test Management route that already checked the right ("Run now" needs only execute).
  const created = await deps.tasks.create(
    user.organizationId,
    user.userId,
    { ...fields, space_id: spaceId, task_type_id: typeId },
    { testRightChecked: true },
  );

  return { id: created.id, key: created.key ?? null };
}

/** Runs the steps after a new ticket; when one fails the ticket goes too, so nothing half-saved stays. */
export async function completeNewTicket<T>(
  deps: RecordTicketDeps,
  user: RequestUser,
  taskId: string,
  steps: () => Promise<T>,
): Promise<T> {
  try {
    return await steps();
  } catch (error) {
    await removeNewTicket(deps, user, taskId);

    throw error;
  }
}

/** Removes a ticket this request created; a failure is logged because the caller's error matters more. */
export async function removeNewTicket(
  deps: RecordTicketDeps,
  user: RequestUser,
  taskId: string,
): Promise<void> {
  try {
    await deps.tasks?.delete(taskId, user.organizationId, user.userId, {
      testRecordDeleted: true,
    });
  } catch (error) {
    deps.logger.error(
      `New ticket ${taskId} could not be removed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The record the ticket listener just created; missing means the listener failed and logged why. */
export async function loadNewRecord<Row extends { id: string }>(
  client: AdminClient,
  logger: Logger,
  table: TicketRecordTable,
  organizationId: string,
  taskId: string,
  columns = 'id',
): Promise<Row> {
  const { data, error } = await client
    .from(table)
    .select(columns)
    .eq('task_id', taskId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) throw tmDbError(logger, `read new ${table} record`, error);

  if (!data) {
    throw new InternalServerErrorException({
      code: 'RECORD_NOT_CREATED',
      message: 'The test record could not be created. Try again.',
    });
  }

  return data as unknown as Row;
}
