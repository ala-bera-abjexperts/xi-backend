import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { AttachmentsStage } from './attachments.stage';
import { CommentsStage } from './comments.stage';
import { ConfluenceSpaceStage } from './confluence-space.stage';
import { IssuesStage } from './issues.stage';
import { SpaceStage } from './space.stage';
import {
  MigrationItemError,
  type MigrationRunItemRow,
  type StageContext,
} from './stage.interface';

const stale = {
  status: 'mapped',
  target_id: 'deleted-target',
  target_table: 'spaces',
  job_id: 'original-job',
  metadata: {},
};

function context(
  getTarget: (entityType: string) => unknown,
  targetSpaceId: string | null = null,
): StageContext {
  const entityMap = {
    getTarget: jest.fn(
      (_org: string, _connection: string, entityType: string) =>
        getTarget(entityType),
    ),
    getExistingTarget: jest.fn().mockResolvedValue(null),
    recoverStaleSpaceMappings: jest.fn().mockResolvedValue(undefined),
    recordMapping: jest.fn().mockResolvedValue(undefined),
  };

  return {
    orgId: 'org-1',
    dryRun: false,
    job: {
      id: 'job-1',
      connection_id: 'connection-1',
      source_kind: 'jira_project',
      source_ref: 'PROJ',
      target_space_id: targetSpaceId,
      scope: {},
      options: {},
    },
    run: {
      id: 'run-1',
      organization_id: 'org-1',
      job_id: 'job-1',
      connection_id: 'connection-1',
      mode: 'live',
      status: 'running',
      current_stage: null,
      stage_index: 0,
      config_snapshot: {},
      totals: {},
      correlation_id: null,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      error_message: null,
      created_by: 'actor-1',
      created_at: '2026-09-02T00:00:00.000Z',
    },
    entityMap: entityMap as never,
    getAdapter: jest.fn(),
    log: jest.fn().mockResolvedValue(undefined),
  };
}

function item(payload: Record<string, unknown>): MigrationRunItemRow {
  return { payload } as MigrationRunItemRow;
}

function spacesDb(rows: { id: string }[] = []) {
  return {
    from: (table: string) => {
      if (table !== 'spaces') throw new Error(`unexpected table ${table}`);
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: () => Promise.resolve({ data: rows, error: null }),
      };
      return chain;
    },
  };
}

describe('Jira stale crosswalk recovery', () => {
  it('recreates an auto-created space and replaces its stale crosswalk', async () => {
    const spaces = {
      createSpace: jest.fn().mockResolvedValue({ id: 'space-new' }),
    };
    const stage = new SpaceStage(
      spaces as never,
      {
        getClient: () => spacesDb(),
      } as unknown as SupabaseAdminService,
    );
    const ctx = context((entityType) =>
      entityType === 'space' ? stale : null,
    );

    await expect(
      stage.processItem(
        ctx,
        item({ sourceId: '10000', key: 'PROJ', name: 'Project' }),
      ),
    ).resolves.toEqual({
      kind: 'created',
      targetId: 'space-new',
      targetTable: 'spaces',
    });
    const entityMap = ctx.entityMap as unknown as {
      recoverStaleSpaceMappings: jest.Mock;
      recordMapping: jest.Mock;
    };
    expect(spaces.createSpace).toHaveBeenCalledTimes(1);
    expect(entityMap.recoverStaleSpaceMappings).toHaveBeenCalledWith(
      'org-1',
      'connection-1',
      'original-job',
    );
    expect(entityMap.recordMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'space',
        sourceId: 'PROJ',
        targetId: 'space-new',
        status: 'mapped',
      }),
    );
  });

  it('does not invalidate project mappings during a dry run', async () => {
    const stage = new SpaceStage(
      { createSpace: jest.fn() } as never,
      {
        getClient: () => spacesDb(),
      } as unknown as SupabaseAdminService,
    );
    const ctx = context((entityType) =>
      entityType === 'space' ? stale : null,
    );
    (ctx as unknown as { dryRun: boolean }).dryRun = true;

    await expect(
      stage.processItem(
        ctx,
        item({ sourceId: '10000', key: 'PROJ', name: 'Project' }),
      ),
    ).resolves.toEqual({ kind: 'planned' });
    const entityMap = ctx.entityMap as unknown as {
      recoverStaleSpaceMappings: jest.Mock;
    };
    expect(entityMap.recoverStaleSpaceMappings).not.toHaveBeenCalled();
  });

  it('fails when the explicitly selected target space was deleted', async () => {
    const stage = new SpaceStage(
      { createSpace: jest.fn() } as never,
      {
        getClient: () => spacesDb(),
      } as unknown as SupabaseAdminService,
    );
    const ctx = context(
      (entityType) => (entityType === 'space' ? stale : null),
      'selected-space',
    );

    await expect(
      stage.processItem(
        ctx,
        item({ sourceId: '10000', key: 'PROJ', name: 'Project' }),
      ),
    ).rejects.toMatchObject<Partial<MigrationItemError>>({
      errorClass: 'permanent',
      message: "The job's target space no longer exists in this organization",
    });
  });

  it('fails when an adopted target was deleted and SET NULL cleared the job target', async () => {
    const stage = new SpaceStage(
      { createSpace: jest.fn() } as never,
      {
        getClient: () => spacesDb(),
      } as unknown as SupabaseAdminService,
    );
    const ctx = context((entityType) =>
      entityType === 'space' ? { ...stale, metadata: { adopted: true } } : null,
    );

    await expect(
      stage.processItem(
        ctx,
        item({ sourceId: '10000', key: 'PROJ', name: 'Project' }),
      ),
    ).rejects.toThrow(/selected target space.*no longer exists/i);
    expect(
      (
        ctx.entityMap as unknown as {
          recoverStaleSpaceMappings: jest.Mock;
        }
      ).recoverStaleSpaceMappings,
    ).not.toHaveBeenCalled();
  });

  it('does not skip an issue whose mapped task was deleted', async () => {
    const stage = new IssuesStage({} as never);
    const ctx = context((entityType) =>
      entityType === 'issue' ? { ...stale, target_table: 'tasks' } : null,
    );

    await expect(
      stage.processItem(ctx, item({ sourceId: '10001', key: 'PROJ-1' })),
    ).resolves.toEqual({
      kind: 'blocked',
      waitingFor: { entityType: 'space', sourceId: 'PROJ' },
    });
  });

  it('does not skip a comment whose mapped comment row was deleted', async () => {
    const stage = new CommentsStage({
      getClient: () => ({ from: jest.fn() }),
    } as unknown as SupabaseAdminService);
    const ctx = context((entityType) =>
      entityType === 'comment'
        ? { ...stale, target_table: 'task_comments' }
        : null,
    );

    await expect(
      stage.processItem(
        ctx,
        item({
          issueSourceId: '10001',
          issueKey: 'PROJ-1',
          comment: { sourceId: '20001', body: 'Still needed' },
        }),
      ),
    ).resolves.toEqual({
      kind: 'blocked',
      waitingFor: { entityType: 'issue', sourceId: '10001' },
    });
  });

  it('does not skip an attachment whose mapped attachment row was deleted', async () => {
    const stage = new AttachmentsStage({
      getClient: () => ({ from: jest.fn() }),
    } as unknown as SupabaseAdminService);
    const ctx = context((entityType) =>
      entityType === 'attachment'
        ? { ...stale, target_table: 'file_attachments' }
        : null,
    );

    await expect(
      stage.processItem(
        ctx,
        item({
          issueSourceId: '10001',
          issueKey: 'PROJ-1',
          attachment: {
            sourceId: '30001',
            filename: 'evidence.pdf',
            downloadUrl: '/secure/attachment/30001/evidence.pdf',
          },
        }),
      ),
    ).resolves.toEqual({
      kind: 'blocked',
      waitingFor: { entityType: 'issue', sourceId: '10001' },
    });
  });
});

describe('Confluence stale crosswalk recovery', () => {
  const sourceSpace = {
    sourceId: 'source-space-1',
    key: 'DOCS',
    name: 'Documentation',
    description: 'Customer documentation',
  };

  function confluenceContext(inspection: {
    mapping: typeof stale | null;
    state: 'unmapped' | 'planned' | 'active' | 'archived' | 'missing';
  }): StageContext {
    const ctx = context(() => null);
    Object.assign(ctx.job, {
      source_kind: 'confluence_space',
      source_ref: 'DOCS',
    });
    Object.assign(ctx.entityMap as object, {
      inspectSpaceTarget: jest.fn().mockResolvedValue(inspection),
      recoverStaleConfluenceSpaceMappings: jest
        .fn()
        .mockResolvedValue(undefined),
    });
    return ctx;
  }

  it('reuses an active mapped space without creating or invalidating anything', async () => {
    const spaces = { createSpace: jest.fn() };
    const stage = new ConfluenceSpaceStage(
      spaces as never,
      { getClient: () => spacesDb() } as unknown as SupabaseAdminService,
    );
    const ctx = confluenceContext({
      mapping: { ...stale, target_id: 'space-live' },
      state: 'active',
    });

    await expect(stage.processItem(ctx, item(sourceSpace))).resolves.toEqual({
      kind: 'skipped',
      reason: 'space already mapped',
      targetId: 'space-live',
    });
    expect(spaces.createSpace).not.toHaveBeenCalled();
    expect(
      (
        ctx.entityMap as unknown as {
          recoverStaleConfluenceSpaceMappings: jest.Mock;
        }
      ).recoverStaleConfluenceSpaceMappings,
    ).not.toHaveBeenCalled();
  });

  it('fails actionably when the mapped space is archived', async () => {
    const stage = new ConfluenceSpaceStage(
      { createSpace: jest.fn() } as never,
      { getClient: () => spacesDb() } as unknown as SupabaseAdminService,
    );
    const ctx = confluenceContext({ mapping: stale, state: 'archived' });

    await expect(stage.processItem(ctx, item(sourceSpace))).rejects.toThrow(
      /archived.*restore.*permanently delete/i,
    );
    expect(
      (
        ctx.entityMap as unknown as {
          recoverStaleConfluenceSpaceMappings: jest.Mock;
        }
      ).recoverStaleConfluenceSpaceMappings,
    ).not.toHaveBeenCalled();
  });

  it('invalidates only this source space mappings before recreating a deleted auto-created space', async () => {
    const spaces = {
      createSpace: jest.fn().mockResolvedValue({ id: 'space-new' }),
    };
    const stage = new ConfluenceSpaceStage(
      spaces as never,
      { getClient: () => spacesDb() } as unknown as SupabaseAdminService,
    );
    const ctx = confluenceContext({ mapping: stale, state: 'missing' });

    await expect(stage.processItem(ctx, item(sourceSpace))).resolves.toEqual({
      kind: 'created',
      targetId: 'space-new',
      targetTable: 'spaces',
    });
    expect(
      (
        ctx.entityMap as unknown as {
          recoverStaleConfluenceSpaceMappings: jest.Mock;
        }
      ).recoverStaleConfluenceSpaceMappings,
    ).toHaveBeenCalledWith('org-1', 'connection-1', 'DOCS', 'deleted-target');
  });

  it('does not recreate a deleted adopted space after target_space_id was set null', async () => {
    const stage = new ConfluenceSpaceStage(
      { createSpace: jest.fn() } as never,
      { getClient: () => spacesDb() } as unknown as SupabaseAdminService,
    );
    const ctx = confluenceContext({
      mapping: { ...stale, metadata: { adopted: true } },
      state: 'missing',
    });

    await expect(stage.processItem(ctx, item(sourceSpace))).rejects.toThrow(
      /selected target space.*no longer exists/i,
    );
    expect(
      (
        ctx.entityMap as unknown as {
          recoverStaleConfluenceSpaceMappings: jest.Mock;
        }
      ).recoverStaleConfluenceSpaceMappings,
    ).not.toHaveBeenCalled();
  });

  it('does not invalidate or overwrite stale mappings during a dry run', async () => {
    const stage = new ConfluenceSpaceStage(
      { createSpace: jest.fn() } as never,
      { getClient: () => spacesDb() } as unknown as SupabaseAdminService,
    );
    const ctx = confluenceContext({ mapping: stale, state: 'missing' });
    (ctx as unknown as { dryRun: boolean }).dryRun = true;

    await expect(stage.processItem(ctx, item(sourceSpace))).resolves.toEqual({
      kind: 'planned',
    });
    const entityMap = ctx.entityMap as unknown as {
      recoverStaleConfluenceSpaceMappings: jest.Mock;
      recordMapping: jest.Mock;
    };
    expect(
      entityMap.recoverStaleConfluenceSpaceMappings,
    ).not.toHaveBeenCalled();
    expect(entityMap.recordMapping).not.toHaveBeenCalled();
  });
});
