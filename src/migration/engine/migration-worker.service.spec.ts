import { AtlassianRequestError } from '../adapters/http/atlassian-http-client';
import type { MigrationConnectionsService } from '../services/migration-connections.service';
import type { MigrationEntityMapService } from '../services/migration-entity-map.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { MigrationQueueService } from './migration-queue.service';
import type { StageRegistry } from './stages/stage.registry';
import type {
  ItemOutcome,
  MigrationJobContext,
  MigrationRunItemRow,
  MigrationRunRow,
  StageContext,
} from './stages/stage.interface';
import {
  MigrationWorkerService,
  type WorkerStats,
} from './migration-worker.service';

interface WorkerInternals {
  routeError(
    item: MigrationRunItemRow,
    run: MigrationRunRow,
    error: unknown,
    stats: WorkerStats,
  ): Promise<boolean>;
  loadRuns(items: MigrationRunItemRow[]): Promise<Map<string, MigrationRunRow>>;
  loadJobs(runs: MigrationRunRow[]): Promise<Map<string, MigrationJobContext>>;
}

describe('MigrationWorkerService source failures', () => {
  it('routes an Atlassian 5xx through the bounded source-failure path', async () => {
    const queue = {
      failSourceItem: jest.fn().mockResolvedValue(true),
      failItem: jest.fn().mockResolvedValue(true),
      log: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MigrationWorkerService(
      { getClient: jest.fn() } as unknown as SupabaseAdminService,
      queue as unknown as MigrationQueueService,
      {} as StageRegistry,
      {} as MigrationConnectionsService,
      {} as MigrationEntityMapService,
    );
    const leasedItem = item('item-1', 'run-1', 'XMQ-1');
    const migrationRun = run('run-1', 'job-1', 'connection-1');
    const stats: WorkerStats = {
      leased: 1,
      succeeded: 0,
      skipped: 0,
      blocked: 0,
      failed: 0,
      produced: 0,
    };
    const error = new AtlassianRequestError('GET failed with 500', 500);

    await (service as unknown as WorkerInternals).routeError(
      leasedItem,
      migrationRun,
      error,
      stats,
    );

    expect(queue.failSourceItem).toHaveBeenCalledWith(
      leasedItem,
      migrationRun,
      error.message,
    );
    expect(queue.failItem).not.toHaveBeenCalled();
    expect(stats.failed).toBe(1);
  });

  it('releases same-connection siblings after a 5xx and continues other connections', async () => {
    const items = [
      item('item-1', 'run-1', 'A-1'),
      item('item-2', 'run-1', 'A-2'),
      item('item-3', 'run-2', 'B-1'),
    ];
    const queue = {
      leaseItems: jest.fn().mockResolvedValue(items),
      failSourceItem: jest.fn().mockResolvedValue(true),
      failItem: jest.fn().mockResolvedValue(true),
      releaseItem: jest.fn().mockResolvedValue(true),
      completeItem: jest.fn().mockResolvedValue(true),
      log: jest.fn().mockResolvedValue(undefined),
    };
    const handler = {
      processItem: jest.fn(
        (
          _ctx: StageContext,
          leased: MigrationRunItemRow,
        ): Promise<ItemOutcome> => {
          if (leased.id === 'item-1') {
            return Promise.reject(
              new AtlassianRequestError('source overloaded', 500),
            );
          }

          return Promise.resolve({
            kind: 'created',
            targetId: `target-${leased.id}`,
          });
        },
      ),
    };
    const service = new MigrationWorkerService(
      { getClient: jest.fn() } as unknown as SupabaseAdminService,
      queue as unknown as MigrationQueueService,
      { get: jest.fn().mockReturnValue(handler) } as unknown as StageRegistry,
      {
        buildAdapter: jest.fn(),
        getBaseUrl: jest.fn(),
      } as unknown as MigrationConnectionsService,
      { isGateOpen: jest.fn() } as unknown as MigrationEntityMapService,
    );
    const run1 = run('run-1', 'job-1', 'connection-1');
    const run2 = run('run-2', 'job-2', 'connection-2');

    const internals = service as unknown as WorkerInternals;

    jest.spyOn(internals, 'loadRuns').mockResolvedValue(
      new Map([
        ['run-1', run1],
        ['run-2', run2],
      ]),
    );
    jest.spyOn(internals, 'loadJobs').mockResolvedValue(
      new Map([
        ['job-1', job('job-1', 'connection-1')],
        ['job-2', job('job-2', 'connection-2')],
      ]),
    );

    const stats = await service.runWorkerLoop('worker-1');

    expect(handler.processItem).toHaveBeenCalledTimes(2);
    expect(queue.releaseItem).toHaveBeenCalledWith(items[1]);
    expect(queue.completeItem).toHaveBeenCalledTimes(1);
    expect(queue.completeItem).toHaveBeenCalledWith(
      items[2],
      'succeeded',
      'target-item-3',
      expect.any(Number),
    );
    expect(stats).toMatchObject({ leased: 3, failed: 1, succeeded: 1 });
  });
});

function item(
  id: string,
  runId: string,
  sourceRef: string,
): MigrationRunItemRow {
  return {
    id,
    organization_id: 'org-1',
    run_id: runId,
    stage: 'issues',
    stage_order: 13,
    entity_type: 'issue',
    item_kind: 'entity',
    source_ref: sourceRef,
    parent_source_ref: null,
    payload: null,
    status: 'running',
    retry_count: 0,
    max_attempts: 8,
    next_retry_at: null,
    wakeup_at: null,
    lease_until: new Date().toISOString(),
    worker_id: 'worker-1',
    checkpoint: null,
    target_id: null,
    error_class: null,
    error_message: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    created_at: new Date().toISOString(),
  };
}

function run(id: string, jobId: string, connectionId: string): MigrationRunRow {
  return {
    id,
    organization_id: 'org-1',
    job_id: jobId,
    connection_id: connectionId,
    mode: 'live',
    status: 'running',
    current_stage: 'issues',
    stage_index: 13,
    config_snapshot: {},
    totals: {},
    correlation_id: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    error_message: null,
    created_by: null,
    created_at: new Date().toISOString(),
  };
}

function job(id: string, connectionId: string): MigrationJobContext {
  return {
    id,
    connection_id: connectionId,
    source_kind: 'jira_project',
    source_ref: 'XMQ',
    target_space_id: 'space-1',
    scope: {},
    options: {},
  };
}

describe.each(['live', 'dry_run'] as const)(
  'required Jira identity stop (%s)',
  (mode) => {
    it.each([401, 403])(
      'fails the run before content and releases leased siblings on HTTP %s',
      async (status) => {
        const items = [
          {
            ...item('users', 'run-1', ''),
            stage: 'users',
            item_kind: 'collection' as const,
          },
          item('issue', 'run-1', 'A-1'),
        ];
        const migrationRun = { ...run('run-1', 'job-1', 'connection-1'), mode };
        const query = {
          update: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ error: null }).then(resolve),
        };
        const queue = {
          leaseItems: jest.fn().mockResolvedValue(items),
          releaseItem: jest.fn(),
          failItem: jest.fn(),
          log: jest.fn(),
        };
        const handler = {
          produce: jest
            .fn()
            .mockRejectedValue(
              new AtlassianRequestError(
                'Required endpoint /rest/api/2/project/DEMO/role denied; check credentials',
                status,
              ),
            ),
          processItem: jest.fn(),
        };
        const service = new MigrationWorkerService(
          {
            getClient: () => ({ from: () => query }),
          } as unknown as SupabaseAdminService,
          queue as unknown as MigrationQueueService,
          { get: () => handler } as unknown as StageRegistry,
          {} as MigrationConnectionsService,
          {} as MigrationEntityMapService,
        );
        const internals = service as unknown as WorkerInternals;
        jest
          .spyOn(internals, 'loadRuns')
          .mockResolvedValue(new Map([['run-1', migrationRun]]));
        jest
          .spyOn(internals, 'loadJobs')
          .mockResolvedValue(
            new Map([['job-1', job('job-1', 'connection-1')]]),
          );
        await service.runWorkerLoop('worker');
        expect(query.update).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'failed',
            error_message: expect.stringContaining('/project/DEMO/role'),
          }),
        );
        expect(queue.releaseItem).toHaveBeenCalledWith(items[1]);
        expect(handler.processItem).not.toHaveBeenCalled();
        expect(queue.failItem).toHaveBeenCalledWith(
          items[0],
          'permanent',
          expect.any(String),
        );
      },
    );
  },
);

describe('failed parent gate', () => {
  it('never imports a child while its parent has no usable mapping', async () => {
    const child = {
      ...item('child', 'run-1', 'A-2'),
      parent_source_ref: 'A-1',
    };
    const queue = {
      leaseItems: jest.fn().mockResolvedValue([child]),
      blockItem: jest.fn(),
    };
    const handler = { processItem: jest.fn() };
    const entityMap = { isGateOpen: jest.fn().mockResolvedValue(false) };
    const service = new MigrationWorkerService(
      {} as SupabaseAdminService,
      queue as unknown as MigrationQueueService,
      { get: () => handler } as unknown as StageRegistry,
      {} as MigrationConnectionsService,
      entityMap as unknown as MigrationEntityMapService,
    );
    const internals = service as unknown as WorkerInternals;
    jest
      .spyOn(internals, 'loadRuns')
      .mockResolvedValue(
        new Map([['run-1', run('run-1', 'job-1', 'connection-1')]]),
      );
    jest
      .spyOn(internals, 'loadJobs')
      .mockResolvedValue(new Map([['job-1', job('job-1', 'connection-1')]]));
    await service.runWorkerLoop('worker');
    expect(handler.processItem).not.toHaveBeenCalled();
    expect(queue.blockItem).toHaveBeenCalledWith(child, 'issue', 'A-1');
  });
});
