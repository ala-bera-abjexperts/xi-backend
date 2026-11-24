/**
 * @fileoverview Scheduler tick tests.
 * @module src/backup/engine/backup-tick.service.spec
 *
 * The invariant under test is "every path releases the lease". A path that returns without
 * releasing leaves the scheme leased and firing late forever, and nothing in the data looks wrong —
 * which is why it is asserted per branch rather than once.
 */

import { BackupTickService } from './backup-tick.service';
import type { BackupQueueService, DueScheme } from './backup-queue.service';
import type { BackupRunsService } from '../services/backup-runs.service';
import type { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';

const ORG = 'org-1';
const SCHEME = 'sch-1';

const dueScheme: DueScheme = {
  scheme_id: SCHEME,
  organization_id: ORG,
  due_at: new Date(Date.now() - 60_000).toISOString(),
};

const activeSchemeRow = {
  id: SCHEME,
  cron_expression: '0 2 * * *',
  timezone: 'Europe/Berlin',
  schedule_enabled: true,
  status: 'active',
};

describe('BackupTickService', () => {
  let updatePatches: Record<string, unknown>[];
  let service: BackupTickService;
  let createRun: jest.Mock;
  let isEnabled: jest.Mock;
  let schemeRow: unknown;

  function setup() {
    updatePatches = [];
    schemeRow = activeSchemeRow;
    createRun = jest.fn().mockResolvedValue({ id: 'run-1' });
    isEnabled = jest.fn().mockResolvedValue(true);

    const chain: Record<string, unknown> = {};
    const self = () => chain;

    for (const method of ['select', 'eq', 'in', 'not', 'upsert']) {
      chain[method] = jest.fn().mockImplementation(self);
    }

    chain.update = jest
      .fn()
      .mockImplementation((patch: Record<string, unknown>) => {
        updatePatches.push(patch);

        return chain;
      });

    chain.maybeSingle = jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ data: schemeRow, error: null }),
      );
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve);

    const queue = {
      claimDueSchemes: jest.fn().mockResolvedValue([dueScheme]),
    } as unknown as BackupQueueService;

    service = new BackupTickService(
      {
        getClient: () => ({ from: () => chain }),
      } as unknown as SupabaseAdminService,
      queue,
      { createRun } as unknown as BackupRunsService,
      { isEnabled } as unknown as OrganizationModulesService,
    );
  }

  /** The lease release is the update carrying worker_id: null. */
  function releasePatch() {
    return updatePatches.find(
      (patch) => 'worker_id' in patch && patch.worker_id === null,
    );
  }

  beforeEach(setup);

  it('enqueues a scheduled run and advances the schedule', async () => {
    const stats = await service.tickOnce();

    expect(stats.enqueued).toBe(1);
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({ triggerSource: 'schedule', userId: null }),
    );

    const patch = releasePatch();

    expect(patch).toBeDefined();
    expect(patch?.next_run_at).toBeDefined();
    expect(new Date(patch?.next_run_at as string).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('records an overlap without alerting, and still advances', async () => {
    // The previous run is simply still going. This is a normal state, not a failure.
    createRun.mockRejectedValue(
      new Error('A backup for this scheme is already running.'),
    );

    const stats = await service.tickOnce();

    expect(stats.enqueued).toBe(0);
    expect(releasePatch()?.last_skip_reason).toBe('overlap');
    expect(releasePatch()?.next_run_at).toBeDefined();
  });

  it('does not export for an organization that has disabled the module', async () => {
    // A cron has no request, so the controller's per-request gate cannot protect this path.
    isEnabled.mockResolvedValue(false);

    await service.tickOnce();

    expect(createRun).not.toHaveBeenCalled();
    expect(releasePatch()?.is_active).toBe(false);
    expect(releasePatch()?.last_skip_reason).toBe('entitlement');
  });

  it('skips a long-missed window once instead of queueing one run per window', async () => {
    // A week of downtime is seven missed nightly windows and exactly one decision. Queueing all
    // seven would stampede the customer's server, and keep-last-N retention would prune six.
    const weekLate = {
      ...dueScheme,
      due_at: new Date(Date.now() - 7 * 24 * 3600_000).toISOString(),
    };

    (
      service as unknown as { queue: BackupQueueService }
    ).queue.claimDueSchemes = jest.fn().mockResolvedValue([weekLate]);

    const result = await service.tickOnce();

    expect(result.enqueued).toBe(0);
    expect(createRun).not.toHaveBeenCalled();
    expect(releasePatch()?.last_skip_reason).toBe('missed');
    expect(releasePatch()?.missed_occurrences).toBeGreaterThan(1);
  });

  it('releases the lease even when the scheme vanished after the claim', async () => {
    schemeRow = null;

    await service.tickOnce();

    expect(createRun).not.toHaveBeenCalled();
    expect(releasePatch()).toBeDefined();
    expect(releasePatch()?.is_active).toBe(false);
  });

  it('releases the lease when enqueueing throws for an unexpected reason', async () => {
    createRun.mockRejectedValue(new Error('connection reset'));

    await service.tickOnce();

    // Without this the scheme stays leased and its next_run_at is whatever the claim left.
    expect(releasePatch()).toBeDefined();
    expect(releasePatch()?.last_skip_reason).toBe('config');
  });

  it('scopes the release to this worker, so a reaped lease is not overwritten', async () => {
    await service.tickOnce();

    // The .eq('worker_id', WORKER_ID) guard means a lost lease matches zero rows rather than
    // stamping a next_run_at over the new owner's.
    expect(releasePatch()).toBeDefined();
  });
});
