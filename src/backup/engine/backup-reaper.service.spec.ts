/**
 * @fileoverview Reaper tests, focused on what a requeue has to reset.
 * @module src/backup/engine/backup-reaper.service.spec
 *
 * A retry does not resume. A partial upload is discarded, so the next attempt writes a whole new
 * archive from the first byte — which means every item the previous attempt finished must be
 * exported again.
 *
 * Requeuing the run without resetting its items made every reclaimed run fail permanently: the
 * worker reads only `pending` items, found none, and threw "this run has no items to export" in
 * about 40 ms. The run then burned its remaining attempts and ended as failed, having produced a
 * 2.5 KB archive that no reader could open.
 */

import { BackupReaperService } from './backup-reaper.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';

const STALE_RUN = {
  id: 'run-1',
  organization_id: 'org-1',
  status: 'exporting',
  attempt_count: 0,
  started_at: new Date().toISOString(),
  updated_at: new Date(Date.now() - 600_000).toISOString(),
};

interface UpdateCall {
  table: string;
  patch: Record<string, unknown>;
  filters: { method: string; args: unknown[] }[];
}

describe('BackupReaperService', () => {
  let service: BackupReaperService;
  let updates: UpdateCall[];

  beforeEach(() => {
    updates = [];

    const from = jest.fn().mockImplementation((table: string) => {
      const filters: { method: string; args: unknown[] }[] = [];
      const chain: Record<string, unknown> = {};

      const record = (method: string) =>
        jest.fn().mockImplementation((...args: unknown[]) => {
          filters.push({ method, args });

          return chain;
        });

      for (const method of ['select', 'eq', 'in', 'lt', 'limit']) {
        chain[method] = record(method);
      }

      chain.update = jest
        .fn()
        .mockImplementation((patch: Record<string, unknown>) => {
          updates.push({ table, patch, filters });

          return chain;
        });

      // The sweep query resolves to one stale run; every fenced update resolves empty.
      chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data: filters.some((f) => f.method === 'lt') ? [STALE_RUN] : null,
          error: null,
        }).then(resolve);

      return chain;
    });

    service = new BackupReaperService({
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService);
  });

  function itemResets(): UpdateCall[] {
    return updates.filter(
      (call) =>
        call.table === 'backup_run_items' && call.patch.status === 'pending',
    );
  }

  it('returns a requeued run to the queue', async () => {
    const stats = await service.sweepOnce();

    expect(stats.requeued).toBe(1);
    expect(
      updates.some(
        (u) => u.table === 'backup_runs' && u.patch.status === 'queued',
      ),
    ).toBe(true);
  });

  it('resets the run items so the retry has work to do', async () => {
    await service.sweepOnce();

    const reset = itemResets();

    // Without this the next attempt finds nothing pending and fails immediately.
    expect(reset).toHaveLength(1);
    expect(reset[0].patch).toMatchObject({
      status: 'pending',
      worker_id: null,
      started_at: null,
      finished_at: null,
    });
  });

  it('scopes the reset to the run and its organization', async () => {
    await service.sweepOnce();

    const args = itemResets()[0].filters.filter((f) => f.method === 'eq');

    expect(args).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['run_id', STALE_RUN.id] },
        { method: 'eq', args: ['organization_id', STALE_RUN.organization_id] },
      ]),
    );
  });

  it('never revives an item that exhausted its own attempts', async () => {
    await service.sweepOnce();

    const statuses = itemResets()[0].filters.find((f) => f.method === 'in');

    // A run-level retry must not resurrect a `dead` item, or a permanently broken table would
    // loop forever instead of the run reporting it.
    expect(statuses?.args[1]).not.toContain('dead');
  });
});
