/**
 * @fileoverview Worker tests, focused on the heartbeat.
 * @module src/backup/engine/backup-worker.service.spec
 *
 * The heartbeat is the difference between a backup product that works and one that only appears to.
 * The reaper reclaims any in-flight run whose `backup_runs.updated_at` is older than
 * RUN_STALE_AFTER_MS, and the export loop writes only to `backup_run_items` — a table the reaper
 * never reads. Without a heartbeat every export lasting over five minutes was reclaimed as
 * abandoned and eventually failed, which is why no full-database backup had ever completed while
 * every small one looked perfectly healthy.
 *
 * These tests therefore assert the heartbeat FIRES during long work, is FENCED, and STOPS. A
 * heartbeat that fired but was unfenced would be worse than none: it would keep a run alive after
 * the reaper had already handed it to another worker.
 */

import { HEARTBEAT_INTERVAL_MS, WORKER_ID } from '../backup.constants';
import { BackupWorkerService } from './backup-worker.service';
import type { BackupArchiveCipherService } from '../services/backup-archive-cipher.service';
import type { BackupSecretsService } from '../services/backup-secrets.service';
import type { BackupSpoolService } from './backup-spool.service';
import type { BackupStorageService } from './backup-storage.service';
import type { SftpTargetAdapter } from '../adapters/sftp/sftp.adapter';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TableExporterService } from './table-exporter.service';

/** Mirrors RUN_STALE_AFTER_MS. Duplicated so the ratio assertion fails if either value moves. */
const RUN_STALE_AFTER_MS = 300_000;

const RUN = {
  id: 'run-1',
  organization_id: 'org-1',
  scheme_id: 'sch-1',
  target_id: 'tgt-1',
  target_config_snapshot: {},
};

const TARGET = {
  id: 'tgt-1',
  target_type: 'sftp',
  config: { host: 'sftp.example.com' },
  secret_encrypted: 'x',
  secret_iv: 'y',
  secret_tag: 'z',
  key_fingerprint: 'f',
};

const ITEM = {
  id: 'item-1',
  component_key: 'tasks',
  table_name: 'tasks',
  item_kind: 'table',
  sequence: 0,
};

interface UpdateCall {
  table: string;
  patch: Record<string, unknown>;
  filters: { method: string; args: unknown[] }[];
}

describe('BackupWorkerService heartbeat', () => {
  let service: BackupWorkerService;
  let updates: UpdateCall[];

  /** Holds the run open at preflight, standing in for a long export. */
  let releaseWork: () => void;

  function setup() {
    updates = [];

    const work = new Promise<number>((resolve) => {
      releaseWork = () => resolve(500);
    });

    const from = jest.fn().mockImplementation((table: string) => {
      const filters: { method: string; args: unknown[] }[] = [];
      const chain: Record<string, unknown> = {};

      const record = (method: string) =>
        jest.fn().mockImplementation((...args: unknown[]) => {
          filters.push({ method, args });

          return chain;
        });

      for (const method of ['select', 'eq', 'in', 'order', 'limit']) {
        chain[method] = record(method);
      }

      chain.update = jest
        .fn()
        .mockImplementation((patch: Record<string, unknown>) => {
          updates.push({ table, patch, filters });

          return chain;
        });

      chain.insert = jest.fn().mockResolvedValue({ error: null });

      chain.maybeSingle = jest.fn().mockImplementation(() =>
        Promise.resolve({
          data: table === 'backup_targets' ? TARGET : RUN,
          error: null,
        }),
      );

      // An awaited builder that never calls maybeSingle() — how pendingItems and the fenced
      // updates both terminate.
      chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data: table === 'backup_run_items' ? [ITEM] : null,
          error: null,
        }).then(resolve);

      return chain;
    });

    service = new BackupWorkerService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {
        // Stands in for the long part of a real run — the export loop over 170 tables.
        assertPageSizeIsSafe: jest.fn().mockReturnValue(work),
      } as unknown as TableExporterService,
      {
        openTargetSecret: jest
          .fn()
          .mockReturnValue({ auth_method: 'sftp_password', password: 'pw' }),
      } as unknown as BackupSecretsService,
      {
        verify: jest.fn().mockResolvedValue({ ok: true }),
      } as unknown as SftpTargetAdapter,
      {
        createEncryptor: jest.fn().mockResolvedValue(null),
      } as unknown as BackupArchiveCipherService,
      {
        // Sixth dependency, added with the spooled export formats. Only probe() is reached from
        // the worker; it must resolve, or execute() rejects before the heartbeat under test starts.
        probe: jest.fn().mockResolvedValue(undefined),
      } as unknown as BackupSpoolService,
      // Seventh dependency. Never reached by these tests — the run is held in preflight — but the
      // constructor takes it, and omitting it was a type error that only ts-jest's disabled
      // diagnostics were hiding.
      {} as unknown as BackupStorageService,
    );
  }

  beforeEach(() => {
    jest.useFakeTimers();
    setup();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Only the heartbeat patches carry both of these; the claim patch has no `updated_at`. */
  function heartbeats(): UpdateCall[] {
    return updates.filter(
      (call) =>
        call.table === 'backup_runs' &&
        'lease_until' in call.patch &&
        'updated_at' in call.patch,
    );
  }

  it('touches the run repeatedly while work is still in progress', async () => {
    const draining = service.drainOnce();

    // The run is held open, exactly as a 170-table export holds it open for far longer than the
    // reaper's five-minute window. This is the scenario that used to kill every full backup.
    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);

    expect(heartbeats().length).toBeGreaterThanOrEqual(3);

    releaseWork();
    await draining;
  });

  it('fences every heartbeat on this worker AND an in-flight status', async () => {
    const draining = service.drainOnce();

    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    const beat = heartbeats()[0];

    releaseWork();
    await draining;

    expect(beat).toBeDefined();

    const worker = beat.filters.find(
      (f) => f.method === 'eq' && f.args[0] === 'worker_id',
    );
    const status = beat.filters.find(
      (f) => f.method === 'in' && f.args[0] === 'status',
    );

    // Unfenced, a heartbeat would keep a run alive that the reaper had already reassigned, and
    // could revive one that had just finished.
    expect(worker?.args[1]).toBe(WORKER_ID);
    expect(status).toBeDefined();
  });

  it('stops once the run is over, so a finished run never looks alive', async () => {
    releaseWork();
    await service.drainOnce();

    const afterRun = heartbeats().length;

    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5);

    expect(heartbeats().length).toBe(afterRun);
  });

  it('renews well inside the staleness window', () => {
    // Guards the ratio, not the wall-clock values: the reaper's window must fit several heartbeats
    // so a single slow write cannot get a live run reclaimed.
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(RUN_STALE_AFTER_MS / 4);
  });
});
