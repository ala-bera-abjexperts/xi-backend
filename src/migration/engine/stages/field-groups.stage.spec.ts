/**
 * Stale-crosswalk tests for the field_groups stage: a `custom_field` mapping whose custom_fields
 * row was deleted after an earlier run must be dropped before `addFieldsToGroupBatch`, which
 * otherwise rejects the whole batch with a 400 the worker retries until the item goes dead.
 */
import { FieldGroupsStage } from './field-groups.stage';
import { CUSTOM_FIELD_ENTITY } from './custom-fields.stage';
import { ISSUE_TYPE_ENTITY } from './issue-type.stage';
import {
  MigrationItemError,
  type MigrationRunItemRow,
  type StageContext,
} from './stage.interface';
import type { FieldGroupsService } from '../../../custom-fields/field-groups.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';

const FIELD_ROWS = [
  { source_id: 'cf-1', metadata: { custom_field_id: 'uuid-live' } },
  { source_id: 'cf-2', metadata: { custom_field_id: 'uuid-stale' } },
  // Another project on the same connection — never seeded in this run.
  { source_id: 'cf-other', metadata: { custom_field_id: 'uuid-other' } },
];
const RUN_FIELD_REFS = [{ source_ref: 'cf-1' }, { source_ref: 'cf-2' }];
const LEVEL_ROWS = [{ target_id: 'story' }, { target_id: 'other-project-level' }];

function makeCtx(): StageContext {
  return {
    orgId: 'org-1',
    dryRun: false,
    job: { id: 'job-1', connection_id: 'conn-1', source_ref: 'PROJ' },
    run: { id: 'run-1', created_by: 'user-1', config_snapshot: {} },
    entityMap: {
      getTarget: jest
        .fn()
        .mockResolvedValue({ status: 'mapped', target_id: 'space-1' }),
      recordMapping: jest.fn(),
    },
    // Not a Jira adapter → resolveGroups takes the single fallback group.
    getAdapter: jest.fn().mockResolvedValue({ product: 'confluence' }),
    log: jest.fn(),
  } as unknown as StageContext;
}

/** Thenable query builder: every filter chains, awaiting resolves the table's result. */
function makeDb(customFields: { data: unknown; error: unknown }) {
  const results: Record<string, (entityType?: string) => unknown> = {
    migration_entity_map: (entityType) => ({
      data:
        entityType === CUSTOM_FIELD_ENTITY
          ? FIELD_ROWS
          : entityType === ISSUE_TYPE_ENTITY
            ? LEVEL_ROWS
            : [],
      error: null,
    }),
    migration_run_items: () => ({ data: RUN_FIELD_REFS, error: null }),
    task_hierarchy_configurations: () => ({
      data: [{ config: { levels: [{ id: 'story' }] } }],
      error: null,
    }),
    custom_fields: () => customFields,
    field_groups: () => ({ data: { id: 'group-1' }, error: null }),
  };

  return {
    from: (table: string) => {
      let entityType: string | undefined;
      const result = () => Promise.resolve(results[table](entityType));
      const query = {
        select: () => query,
        in: () => query,
        or: () => query,
        limit: () => query,
        eq: (col: string, value: string) => {
          if (col === 'entity_type') entityType = value;
          return query;
        },
        maybeSingle: result,
        then: (
          resolve: (v: unknown) => unknown,
          reject: (e: unknown) => unknown,
        ) => result().then(resolve, reject),
      };

      return query;
    },
  };
}

function makeStage(customFields: { data: unknown; error: unknown }) {
  const fieldGroupsService = {
    addFieldsToGroupBatch: jest.fn().mockResolvedValue([]),
    assignGroupToLevel: jest.fn(),
    create: jest.fn(),
  };
  const stage = new FieldGroupsStage(
    fieldGroupsService as unknown as FieldGroupsService,
    {
      getClient: () => makeDb(customFields),
    } as unknown as SupabaseAdminService,
  );

  return { stage, fieldGroupsService };
}

const ITEM = { source_ref: 'fieldgroup:PROJ' } as MigrationRunItemRow;

describe('FieldGroupsStage stale custom-field mappings', () => {
  it('drops stale ids so the batch only receives live custom fields', async () => {
    const { stage, fieldGroupsService } = makeStage({
      data: [{ id: 'uuid-live' }],
      error: null,
    });
    const ctx = makeCtx();

    const outcome = await stage.processItem(ctx, ITEM);

    expect(outcome.kind).toBe('created');
    expect(fieldGroupsService.addFieldsToGroupBatch).toHaveBeenCalledWith(
      'group-1',
      [{ custom_field_id: 'uuid-live', sort_order: 0 }],
      'org-1',
      'user-1',
    );
    expect(ctx.log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('ignored 1 stale'),
      { sourceIds: ['cf-2'] },
    );
  });

  it('scopes fields to this run and levels to the target space', async () => {
    const { stage, fieldGroupsService } = makeStage({
      data: [{ id: 'uuid-live' }, { id: 'uuid-other' }],
      error: null,
    });

    await stage.processItem(makeCtx(), ITEM);

    // `cf-other` belongs to another project on the same connection.
    expect(fieldGroupsService.addFieldsToGroupBatch).toHaveBeenCalledWith(
      'group-1',
      [{ custom_field_id: 'uuid-live', sort_order: 0 }],
      'org-1',
      'user-1',
    );
    expect(fieldGroupsService.assignGroupToLevel).toHaveBeenCalledTimes(1);
    expect(fieldGroupsService.assignGroupToLevel).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ hierarchy_level_id: 'story' }),
      'user-1',
    );
  });

  it('skips when every mapping is stale', async () => {
    const { stage, fieldGroupsService } = makeStage({ data: [], error: null });

    const outcome = await stage.processItem(makeCtx(), ITEM);

    expect(outcome.kind).toBe('skipped');
    expect(fieldGroupsService.addFieldsToGroupBatch).not.toHaveBeenCalled();
  });

  it('classifies an existence-check error as transient', async () => {
    const { stage } = makeStage({ data: null, error: { message: 'boom' } });

    const err = await stage
      .processItem(makeCtx(), ITEM)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MigrationItemError);
    expect((err as MigrationItemError).errorClass).toBe('transient');
  });
});
