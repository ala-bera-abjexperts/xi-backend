import { BadRequestException, type Logger } from '@nestjs/common';
import type { PostgrestError } from '@supabase/supabase-js';

import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { tmDbError } from '../test-management-errors';

type AdminClient = ReturnType<SupabaseAdminService['getClient']>;

// Settings columns holding the task type used for each test kind.
export const KIND_TYPE_COLUMNS = [
  'case_task_type_id',
  'set_task_type_id',
  'plan_task_type_id',
  'execution_task_type_id',
  'precondition_task_type_id',
] as const;

export type KindTypeColumn = (typeof KIND_TYPE_COLUMNS)[number];

/** Test task types of a space by id; empty when Test Management was never set up there. */
export async function readTestTaskTypes(
  client: AdminClient,
  organizationId: string,
  spaceId: string,
): Promise<{
  types: Map<string, KindTypeColumn>;
  error: PostgrestError | null;
}> {
  const { data, error } = await client
    .from('test_management_space_settings')
    .select(KIND_TYPE_COLUMNS.join(', '))
    .eq('space_id', spaceId)
    .eq('organization_id', organizationId)
    .maybeSingle<Partial<Record<KindTypeColumn, string | null>>>();
  const types = new Map<string, KindTypeColumn>();

  // Columns not migrated yet: no space has test types, so hierarchy saves must keep working.
  if (error?.code === '42703') return { types, error: null };

  for (const column of KIND_TYPE_COLUMNS) {
    const id = data?.[column];

    if (id) types.set(id, column);
  }

  return { types, error };
}

/** Task type the space uses for a test kind; null means the space has none, so no record can be created. */
export async function kindTaskTypeId(
  client: AdminClient,
  logger: Logger,
  organizationId: string,
  spaceId: string,
  kind: KindTypeColumn,
): Promise<string | null> {
  const { types, error } = await readTestTaskTypes(
    client,
    organizationId,
    spaceId,
  );

  if (error) throw tmDbError(logger, 'load settings', error);

  for (const [id, mapped] of types) if (mapped === kind) return id;

  return null;
}

// Every space has this type, even before its settings are saved.
const DEFAULT_TEST_TYPE = 'manual';

/** Refuses a test type id the space does not have. */
export async function assertKnownTestType(
  client: AdminClient,
  logger: Logger,
  organizationId: string,
  spaceId: string,
  testType: string,
): Promise<void> {
  const { data, error } = await client
    .from('test_management_space_settings')
    .select('test_types')
    .eq('space_id', spaceId)
    .eq('organization_id', organizationId)
    .maybeSingle<{ test_types: { id: string }[] | null }>();

  if (error) throw tmDbError(logger, 'load test types', error);

  const ids = new Set([
    DEFAULT_TEST_TYPE,
    ...(data?.test_types ?? []).map((type) => type.id),
  ]);

  if (!ids.has(testType)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'Unknown test type',
      field: 'test_type',
    });
  }
}

/** Right needed to create a ticket of each test kind; plans and executions belong to run management. */
export const KIND_CREATE_PERMISSION: Record<KindTypeColumn, string> = {
  case_task_type_id: 'create_tests',
  set_task_type_id: 'create_tests',
  precondition_task_type_id: 'create_tests',
  plan_task_type_id: 'manage_test_runs',
  execution_task_type_id: 'manage_test_runs',
};

/** Right needed to change the shared fields of a ticket of each test kind. */
export const KIND_EDIT_PERMISSION: Record<KindTypeColumn, string> = {
  case_task_type_id: 'edit_tests',
  set_task_type_id: 'edit_tests',
  precondition_task_type_id: 'edit_tests',
  plan_task_type_id: 'manage_test_runs',
  execution_task_type_id: 'manage_test_runs',
};
