import type { SupabaseClient } from '@supabase/supabase-js';
import { claimCronSlot, releaseCronSlot } from './cron-claim';

type Result = { data?: unknown; error?: { message: string } | null };

/** Chainable fake: every builder call is recorded; awaiting a chain yields the next result. */
function fakeDb(results: Result[]) {
  const calls: Array<{ op: string; args: unknown[] }[]> = [];
  const db = {
    from: () => {
      const chain: { op: string; args: unknown[] }[] = [];
      calls.push(chain);
      const builder: Record<string, unknown> = {};
      for (const op of ['update', 'upsert', 'eq', 'lte', 'select']) {
        builder[op] = (...args: unknown[]) => {
          chain.push({ op, args });
          return builder;
        };
      }
      builder.then = (resolve: (r: Result) => void) =>
        resolve(results.shift() ?? { data: [], error: null });
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

describe('claimCronSlot', () => {
  it('wins on the compare-and-swap update', async () => {
    const { db, calls } = fakeDb([{ data: [{ job_name: 'j' }], error: null }]);

    const stamp = await claimCronSlot(db, 'j', 60_000);

    expect(stamp).toEqual(expect.any(String));
    expect(calls).toHaveLength(1);
    expect(calls[0].map((c) => c.op)).toEqual([
      'update',
      'eq',
      'lte',
      'select',
    ]);
  });

  it('wins by inserting the first row', async () => {
    const { db, calls } = fakeDb([
      { data: [], error: null },
      { data: [{ job_name: 'j' }], error: null },
    ]);

    expect(await claimCronSlot(db, 'j', 60_000)).toEqual(expect.any(String));
    expect(calls[1][0]).toEqual({
      op: 'upsert',
      args: [
        { job_name: 'j', last_run_at: expect.any(String) as unknown },
        { onConflict: 'job_name', ignoreDuplicates: true },
      ],
    });
  });

  it('loses when the row is held and already exists', async () => {
    const { db } = fakeDb([
      { data: [], error: null },
      { data: [], error: null },
    ]);

    expect(await claimCronSlot(db, 'j', 60_000)).toBeNull();
  });

  it('fails closed on a database error', async () => {
    const { db } = fakeDb([{ data: null, error: { message: 'boom' } }]);

    expect(await claimCronSlot(db, 'j', 60_000)).toBeNull();
  });
});

describe('releaseCronSlot', () => {
  it('is fenced on the stamp it was given', async () => {
    const { db, calls } = fakeDb([{ error: null }]);

    await releaseCronSlot(db, 'j', 'STAMP');

    expect(calls[0]).toEqual([
      { op: 'update', args: [{ last_run_at: '1970-01-01T00:00:00.000Z' }] },
      { op: 'eq', args: ['job_name', 'j'] },
      { op: 'eq', args: ['last_run_at', 'STAMP'] },
    ]);
  });
});
