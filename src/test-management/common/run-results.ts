import { ConflictException, type Logger } from '@nestjs/common';

import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { tmDbError } from '../test-management-errors';

type AdminClient = ReturnType<SupabaseAdminService['getClient']>;

/**
 * Attempts that have been started or finished (any status but TODO) in one execution or in every execution
 * of one plan. Anything above zero means the item has been run and is kept; it can only be archived.
 */
export async function countRunResults(
  client: AdminClient,
  logger: Logger,
  organizationId: string,
  spaceId: string,
  scope: { executionId: string } | { planId: string },
): Promise<number> {
  let query = client
    .from('test_run_attempts')
    .select(
      'id, run:test_runs!test_run_attempts_run_fkey!inner(execution_id, execution:test_executions!test_runs_execution_fkey!inner(plan_id))',
      { count: 'exact', head: true },
    )
    .eq('space_id', spaceId)
    .eq('organization_id', organizationId)
    .neq('status', 'TODO');

  query =
    'executionId' in scope
      ? query.eq('run.execution_id', scope.executionId)
      : query.eq('run.execution.plan_id', scope.planId);

  const { count, error } = await query;

  if (error) throw tmDbError(logger, 'count run results', error);

  return count ?? 0;
}

export function hasResults(
  message: string,
  results: number,
): ConflictException {
  return new ConflictException({
    code: 'HAS_RESULTS',
    message,
    data: { results },
  });
}
