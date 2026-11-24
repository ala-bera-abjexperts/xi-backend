/**
 * @fileoverview Tests for the archived-id → live-id map.
 * @module src/backup/services/restore-entity-map.service.spec
 *
 * This table is what makes a space-changing restore repeatable. The properties that matter are
 * mostly about what it refuses to claim: an unreadable map must not read as "nothing has been
 * restored", because that answer would re-insert a whole space under fresh ids.
 */

import { RestoreEntityMapService, keyOf } from './restore-entity-map.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';

const ORG = '9de67ec3-1111-2222-3333-444444444444';
const SPACE = '4b2eb6d0-bc26-4e3f-83b6-4c717a946eda';
const RUN = 'aaaaaaaa-0000-0000-0000-000000000000';

interface Insert {
  table: string;
  rows: Record<string, unknown>[];
}

/**
 * A client whose paged reads are scripted, and whose inserts are recorded.
 *
 * `pages` is consumed one `range()` at a time so the paging loop can be driven honestly — a single
 * unbounded select would hide the truncation this service exists to avoid.
 */
function clientFor(
  pages: Record<string, unknown>[][] = [[]],
  options: {
    selectError?: string;
    insertError?: { message: string; code?: string };
  } = {},
) {
  const inserts: Insert[] = [];
  let page = 0;

  const from = jest.fn().mockImplementation((table: string) => ({
    select: () => ({
      eq: () => ({
        eq: () => ({
          order: () => ({
            range: () =>
              Promise.resolve(
                options.selectError
                  ? { data: null, error: { message: options.selectError } }
                  : { data: pages[page++] ?? [], error: null },
              ),
          }),
        }),
      }),
    }),
    insert: (rows: Record<string, unknown>[]) => {
      inserts.push({ table, rows });

      return Promise.resolve({ error: options.insertError ?? null });
    },
  }));

  return {
    service: new RestoreEntityMapService({
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService),
    inserts,
    from,
  };
}

function mapping(table: string, source: string, destination: string) {
  return { table_name: table, source_id: source, destination_id: destination };
}

describe('loading what an earlier restore wrote', () => {
  it('keys each mapping by table and source id', async () => {
    const { service } = clientFor([
      [
        mapping('tasks', 't1', 'new-1'),
        mapping('task_history', 'h1', 'new-h1'),
      ],
    ]);

    const map = await service.load(ORG, SPACE);

    expect(map!.get(keyOf('tasks', 't1'))).toBe('new-1');
    expect(map!.get(keyOf('task_history', 'h1'))).toBe('new-h1');
  });

  it('keeps the same source id apart across tables', async () => {
    // Two tables may legitimately hold the same id, and collapsing them would make one restore
    // skip rows the other wrote.
    const { service } = clientFor([
      [
        mapping('tasks', 'shared', 'a'),
        mapping('task_comments', 'shared', 'b'),
      ],
    ]);

    const map = await service.load(ORG, SPACE);

    expect(map!.get(keyOf('tasks', 'shared'))).toBe('a');
    expect(map!.get(keyOf('task_comments', 'shared'))).toBe('b');
  });

  it('returns an empty map when nothing has been restored into this space yet', async () => {
    const { service } = clientFor([[]]);

    const map = await service.load(ORG, SPACE);

    expect(map).not.toBeNull();
    expect(map!.size).toBe(0);
  });

  it('returns null when the map could not be read, rather than claiming it is empty', async () => {
    // The distinction the whole service turns on. "Unknown" must not be read as "nothing has been
    // restored", or the run would re-insert a space's worth of rows under new ids.
    const { service } = clientFor([[]], { selectError: 'connection reset' });

    expect(await service.load(ORG, SPACE)).toBeNull();
  });
});

describe('recording what an apply wrote', () => {
  it('writes one row per pair, carrying the run that produced it', async () => {
    const { service, inserts } = clientFor();

    await service.record(ORG, SPACE, RUN, [
      { table: 'tasks', sourceId: 't1', destinationId: 'new-1' },
    ]);

    expect(inserts).toHaveLength(1);
    expect(inserts[0].rows[0]).toEqual({
      organization_id: ORG,
      space_id: SPACE,
      table_name: 'tasks',
      source_id: 't1',
      destination_id: 'new-1',
      restore_run_id: RUN,
    });
  });

  it('writes nothing when there is nothing to record', async () => {
    const { service, inserts } = clientFor();

    await service.record(ORG, SPACE, RUN, []);

    expect(inserts).toHaveLength(0);
  });

  it('batches a large set rather than sending one enormous request', async () => {
    const { service, inserts } = clientFor();

    await service.record(
      ORG,
      SPACE,
      RUN,
      Array.from({ length: 450 }, (_, index) => ({
        table: 'tasks',
        sourceId: `t${index}`,
        destinationId: `n${index}`,
      })),
    );

    expect(inserts.length).toBeGreaterThan(1);
    expect(inserts.reduce((total, call) => total + call.rows.length, 0)).toBe(
      450,
    );
  });

  it('ignores a duplicate-key error, because the pair is already recorded', async () => {
    // A retried apply re-records what it already wrote. That is the desired end state, not a fault.
    const { service } = clientFor([[]], {
      insertError: { message: 'duplicate key', code: '23505' },
    });

    // Zero left unrecorded: the pair IS in the table, so a repeat run will still recognise the row.
    await expect(
      service.record(ORG, SPACE, RUN, [
        { table: 'tasks', sourceId: 't1', destinationId: 'new-1' },
      ]),
    ).resolves.toBe(0);
  });

  it('never throws when recording fails, because the rows are already restored', async () => {
    // Turning a bookkeeping failure into a failed restore would be a worse outcome than the one it
    // reports — the data is in the destination either way. But it is no longer silent: the count of
    // pairs that could not be written comes back so the caller can say so on the run, because those
    // are exactly the rows a second apply would insert again.
    const { service } = clientFor([[]], {
      insertError: { message: 'permission denied' },
    });

    await expect(
      service.record(ORG, SPACE, RUN, [
        { table: 'tasks', sourceId: 't1', destinationId: 'new-1' },
      ]),
    ).resolves.toBe(1);
  });
});
