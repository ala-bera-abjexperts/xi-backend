import { ForbiddenException, type Logger } from '@nestjs/common';

import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestRecordBulkArchiveResult } from '../dto/test-set.dto';
import { tmDbError } from '../test-management-errors';
import { ticketEmbed, type TicketRecordTable } from './ticket-keys';

type AdminClient = ReturnType<SupabaseAdminService['getClient']>;

type ArchivableTable =
  | Exclude<TicketRecordTable, 'test_cases'>
  | 'test_preconditions';

// Preconditions keep their own key and may have no ticket; the others read the key from their ticket.
function keyColumns(table: ArchivableTable): string {
  return table === 'test_preconditions'
    ? 'key, task:tasks!test_preconditions_task_id_fkey(key)'
    : ticketEmbed(table, 'key');
}

/**
 * Archives or restores the selected records one at a time through the record's own setArchived(), so each keeps
 * its audit entry. Records already in that state, or not in this space, are skipped and listed.
 */
export async function bulkSetArchived(options: {
  client: AdminClient;
  logger: Logger;
  table: ArchivableTable;
  organizationId: string;
  spaceId: string;
  ids: string[];
  archived: boolean;
  setArchived: (id: string) => Promise<unknown>;
}): Promise<TestRecordBulkArchiveResult> {
  const { client, logger, table, organizationId, spaceId, ids, archived } =
    options;

  // Only this space's records get a key; any other id is reported as not found.
  const { data, error } = await client
    .from(table)
    .select(`id, is_archived, ${keyColumns(table)}`)
    .in('id', ids)
    .eq('space_id', spaceId)
    .eq('organization_id', organizationId);

  if (error) throw tmDbError(logger, `load ${table} to change`, error);

  const rows = new Map(
    (
      (data ?? []) as unknown as {
        id: string;
        is_archived: boolean;
        key?: string;
        task: { key: string } | null;
      }[]
    ).map((row) => [
      row.id,
      { is_archived: row.is_archived, key: row.task?.key ?? row.key ?? '' },
    ]),
  );
  const result: TestRecordBulkArchiveResult = {
    changed: false,
    updated: [],
    skipped: [],
  };
  const skip = (
    id: string,
    reason: TestRecordBulkArchiveResult['skipped'][number]['reason'],
  ) =>
    result.skipped.push({
      id,
      key: rows.get(id)?.key ?? '',
      reason: rows.has(id) ? reason : 'not_found',
    });

  for (const [index, id] of ids.entries()) {
    const row = rows.get(id);

    if (!row) {
      skip(id, 'not_found');
      continue;
    }

    if (row.is_archived === archived) {
      skip(id, 'already_in_state');
      continue;
    }

    try {
      await options.setArchived(id);
      result.updated.push({ id, key: row.key });
    } catch (caught) {
      // Without write access every remaining record would fail the same way.
      if (caught instanceof ForbiddenException) {
        ids.slice(index).forEach((rest) => skip(rest, 'failed'));
        break;
      }

      logger.warn(
        `Bulk ${archived ? 'archive' : 'restore'} of ${table} ${id} failed: ${(caught as Error).message}`,
      );
      skip(id, 'failed');
    }
  }

  result.changed = result.updated.length > 0;

  return result;
}
