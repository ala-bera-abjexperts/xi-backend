// (jest mock assertions on class methods are a known unbound-method false
// positive — same disable used by users/workflow-engine controller specs)

import type { ConfigService } from '@nestjs/config';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { DocumentExportsCleanupService } from './document-exports-cleanup.service';

interface TableCall {
  table: string;
  operations: Array<{ method: string; args: unknown[] }>;
}

/**
 * Minimal chainable supabase-js double: every builder method returns the
 * chain; awaiting the chain resolves the next queued response for its table.
 * All calls are recorded for assertions.
 */
function createDbMock(queues: Record<string, Array<Record<string, unknown>>>) {
  const calls: TableCall[] = [];
  const storageRemove = jest.fn().mockResolvedValue({ data: [], error: null });

  const from = jest.fn((table: string) => {
    const record: TableCall = { table, operations: [] };
    calls.push(record);

    const response = queues[table]?.shift() ?? { data: null, error: null };

    const chain: Record<string, unknown> = {};
    const chainMethod =
      (method: string) =>
      (...args: unknown[]) => {
        record.operations.push({ method, args });

        return chain;
      };

    for (const method of [
      'select',
      'eq',
      'not',
      'lt',
      'lte',
      'limit',
      'update',
      'delete',
      'in',
      'upsert',
    ]) {
      chain[method] = chainMethod(method);
    }
    chain['maybeSingle'] = (...args: unknown[]) => {
      record.operations.push({ method: 'maybeSingle', args });

      return Promise.resolve(response);
    };
    chain['then'] = (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (err: unknown) => unknown,
    ) => Promise.resolve(response).then(onFulfilled, onRejected);

    return chain;
  });

  const client = {
    from,
    storage: {
      from: jest.fn().mockReturnValue({ remove: storageRemove }),
    },
  };

  return { client, calls, storageRemove, from };
}

function buildService(
  queues: Record<string, Array<Record<string, unknown>>>,
  env: Record<string, string | undefined> = {},
) {
  const db = createDbMock(queues);
  const supabaseAdmin = {
    getClient: jest.fn().mockReturnValue(db.client),
  } as unknown as SupabaseAdminService;
  const configService = {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;

  const service = new DocumentExportsCleanupService(
    supabaseAdmin,
    configService,
  );

  return { service, ...db };
}

function opsFor(calls: TableCall[], table: string, method: string) {
  return calls
    .filter((call) => call.table === table)
    .flatMap((call) => call.operations)
    .filter((op) => op.method === method);
}

describe('DocumentExportsCleanupService', () => {
  it('honors the cron_run_state gate — no work when it ran within 23h', async () => {
    const { service, calls } = buildService({
      cron_run_state: [
        { data: [], error: null }, // CAS: held by a run within 23h
        { data: [], error: null }, // insert: row already exists
      ],
    });

    await service.run();

    expect(calls.filter((c) => c.table === 'document_exports')).toHaveLength(0);
    // Only the claim attempt touched the gate — no release, nothing ran.
    expect(opsFor(calls, 'cron_run_state', 'update')).toHaveLength(1);
  });

  it('runs when the last execution is older than 23h and re-stamps the gate', async () => {
    const { service, calls } = buildService({
      cron_run_state: [
        { data: [{ job_name: 'document_exports_cleanup' }], error: null }, // CAS wins
      ],
      document_exports: [
        { data: [], error: null }, // pass 1 select — nothing to purge
        { data: [], error: null }, // pass 2 select — nothing to delete
      ],
    });

    await service.run();

    const lte = opsFor(calls, 'cron_run_state', 'lte');
    expect(lte).toHaveLength(1);
    // The claim's cut-off is the 23 h window.
    const cutoff = Date.parse(lte[0].args[1] as string);
    expect(Math.abs(cutoff - (Date.now() - 23 * 60 * 60 * 1000))).toBeLessThan(
      10_000,
    );
    expect(opsFor(calls, 'cron_run_state', 'eq')[0].args).toEqual([
      'job_name',
      'document_exports_cleanup',
    ]);
  });

  it('removes expired files from storage and nulls file_path', async () => {
    const { service, calls, storageRemove } = buildService({
      cron_run_state: [
        { data: [], error: null }, // no previous run: CAS moves nothing
        { data: [{ job_name: 'document_exports_cleanup' }], error: null }, // insert wins
      ],
      document_exports: [
        {
          data: [
            { id: 'e1', file_path: 'org-1/e1/report.pdf' },
            { id: 'e2', file_path: 'org-1/e2/report.docx' },
          ],
          error: null,
        }, // pass 1 select (2 < 100 → single batch)
        { data: null, error: null }, // pass 1 update
        { data: [], error: null }, // pass 2 select
      ],
    });

    await service.run();

    expect(storageRemove).toHaveBeenCalledWith([
      'org-1/e1/report.pdf',
      'org-1/e2/report.docx',
    ]);

    const updates = opsFor(calls, 'document_exports', 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].args[0]).toEqual({ file_path: null });

    const ins = opsFor(calls, 'document_exports', 'in');
    expect(ins[0].args).toEqual(['id', ['e1', 'e2']]);
  });

  it('deletes history rows older than 180 days', async () => {
    const { service, calls } = buildService({
      cron_run_state: [
        { data: [], error: null },
        { data: [{ job_name: 'document_exports_cleanup' }], error: null },
      ],
      document_exports: [
        { data: [], error: null }, // pass 1 — no files to purge
        {
          data: [{ id: 'old-1', file_path: null }],
          error: null,
        }, // pass 2 select
        { data: null, error: null }, // pass 2 delete
      ],
    });

    await service.run();

    const deletes = opsFor(calls, 'document_exports', 'delete');
    expect(deletes).toHaveLength(1);

    const ins = opsFor(calls, 'document_exports', 'in');
    expect(ins[ins.length - 1].args).toEqual(['id', ['old-1']]);
  });

  it('respects DOCUMENT_EXPORT_RETENTION_DAYS for the file cutoff', async () => {
    const { service, calls } = buildService(
      {
        cron_run_state: [
          { data: [], error: null },
          { data: [{ job_name: 'document_exports_cleanup' }], error: null },
        ],
        document_exports: [
          { data: [], error: null },
          { data: [], error: null },
        ],
      },
      { DOCUMENT_EXPORT_RETENTION_DAYS: '7' },
    );

    await service.run();

    const lts = opsFor(calls, 'document_exports', 'lt');
    const fileCutoff = new Date(lts[0].args[1] as string).getTime();
    const expected = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(fileCutoff - expected)).toBeLessThan(10_000);
  });

  it('logs batch failures, stops that pass, and still stamps the gate (retries next day)', async () => {
    const { service, calls, storageRemove } = buildService({
      cron_run_state: [
        { data: [], error: null },
        { data: [{ job_name: 'document_exports_cleanup' }], error: null },
      ],
      document_exports: [
        { data: null, error: { message: 'query exploded' } }, // pass 1 fails
        { data: [], error: null }, // pass 2 select still runs
      ],
    });

    await service.run();

    // The failed pass never reached storage; the sweep completed and the gate
    // was stamped so the next daily run retries the batch.
    expect(storageRemove).not.toHaveBeenCalled();
    expect(opsFor(calls, 'cron_run_state', 'upsert')).toHaveLength(1);
  });
});
