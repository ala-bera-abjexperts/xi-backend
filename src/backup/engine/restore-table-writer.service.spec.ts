/**
 * @fileoverview Tests for the only code in this module that writes restored data.
 * @module src/backup/engine/restore-table-writer.service.spec
 *
 * Two properties carry most of the weight. A restore never UPDATES — a row already present is
 * counted and left alone, because every `updated_at` trigger is BEFORE UPDATE and would rewrite the
 * history the restore exists to recover. And every suppressed row is counted, because an uncounted
 * skip is indistinguishable from data loss: the operator reads "succeeded" over a table that is
 * quietly missing rows.
 */

import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { OpenedArchive } from './archive-reader.service';
import type { PlannedTable } from './restore-planner';
import {
  parseConflictKey,
  RestoreTableWriterService,
} from './restore-table-writer.service';
import { createRemapState, entityMapKey } from './restore-id-remapper';
import type { RemapPlan, RemapState } from './restore-id-remapper';

const ORG = '9de67ec3-1111-2222-3333-444444444444';
const OTHER_ORG = 'cecb176b-9999-8888-7777-666666666666';

interface InsertCall {
  table: string;
  rows: Record<string, unknown>[];
}

type InsertFailure = {
  code: string;
  message: string;
  details?: string;
} | null;

/**
 * A Supabase client that records every insert and can be scripted to fail.
 *
 * `fail` is consulted per call with the rows it was given, so a test can fail one row inside a
 * batch and watch the individual retry isolate it.
 *
 * `selectRows` scripts the read side. It exists because the writer looks up the live row a
 * duplicate collided with, and a client with no `select` made that path unreachable — the lookup
 * threw, the writer swallowed it as best-effort, and two methods went untested by construction.
 * The chain returns itself so `.eq()`/`.ilike()` compose, and `.limit()` resolves.
 */
function clientRecording(
  calls: InsertCall[],
  fail: (rows: Record<string, unknown>[]) => InsertFailure = () => null,
  selectRows: Record<string, unknown>[] = [],
  updates: { table: string; payload: Record<string, unknown> }[] = [],
) {
  const from = jest.fn().mockImplementation((table: string) => ({
    insert: (rows: Record<string, unknown>[]) => {
      calls.push({ table, rows });

      return Promise.resolve({ error: fail(rows) });
    },
    select: () => {
      const chain = {
        eq: () => chain,
        ilike: () => chain,
        limit: () => Promise.resolve({ data: selectRows, error: null }),
      };

      return chain;
    },
    // Records the one UPDATE a restore can issue, so a test can prove it happened — or did not.
    update: (payload: Record<string, unknown>) => {
      const chain = {
        eq: () => chain,
        then: (resolve: (value: { error: null }) => unknown) => {
          updates.push({ table, payload });

          return Promise.resolve({ error: null }).then(resolve);
        },
      };

      return chain;
    },
  }));

  return {
    client: { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
    from,
  };
}

/** An archive that yields the given rows for one table. */
function archiveOf(
  rows: Record<string, unknown>[],
  batchRows = 500,
): OpenedArchive {
  return {
    manifest: null,
    format: 'ndjson',
    tables: [
      { table: 'tasks', entryName: 'data/tasks.ndjson', uncompressedSize: 1 },
    ],
    rejectedEntries: [],
    verifyTable: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *readTable() {
      for (let index = 0; index < rows.length; index += batchRows) {
        yield rows.slice(index, index + batchRows);
      }
    },
    close: jest.fn(),
  } as unknown as OpenedArchive;
}

/** An archive whose member fails verification. */
function damagedArchive(message: string): OpenedArchive {
  return {
    manifest: null,
    format: 'ndjson',
    tables: [],
    rejectedEntries: [],
    verifyTable: jest.fn(),
    // A generator that only throws is exactly what the reader does when a checksum fails: it
    // verifies before yielding, so nothing is ever produced.
    // eslint-disable-next-line @typescript-eslint/require-await, require-yield
    async *readTable() {
      throw new Error(message);
    },
    close: jest.fn(),
  } as unknown as OpenedArchive;
}

const PLANNED: PlannedTable = {
  table: 'tasks',
  component: 'tasks',
  tier: 'content',
  insertLevel: 5,
  generatedColumns: [],
  addedAsDependency: false,
};

function taskRows(count: number, organizationId = ORG) {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index + 1}`,
    organization_id: organizationId,
    title: `Task ${index + 1}`,
  }));
}

function inputFor(
  archive: OpenedArchive,
  overrides: Partial<
    Parameters<RestoreTableWriterService['restoreTable']>[0]
  > = {},
) {
  return {
    archive,
    planned: PLANNED,
    organizationId: ORG,
    knownUsers: null,
    dryRun: false,
    ...overrides,
  };
}

describe('the happy path', () => {
  it('inserts every row and reports the count', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));

    expect(result.status).toBe('succeeded');
    expect(result.insertedRows).toBe(3);
    expect(result.plannedRows).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].rows).toHaveLength(3);
  });

  it('preserves the archived primary keys rather than letting the database assign new ones', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(inputFor(archiveOf(taskRows(2))));

    // Id preservation is what makes the restore a restore. Dropping ids would produce a copy of
    // the data with every cross-reference broken.
    expect(calls[0].rows.map((row) => row.id)).toEqual(['t1', 't2']);
  });

  it('batches a large table rather than sending one enormous request', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(taskRows(450))),
    );

    expect(result.insertedRows).toBe(450);
    // 200 per request, so a 200 000-row table is never one 10 MB body.
    expect(calls.map((call) => call.rows.length)).toEqual([200, 200, 50]);
  });

  it('reports an empty table as skipped rather than succeeded', async () => {
    const { client } = clientRecording([]);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf([])));

    expect(result.status).toBe('skipped');
    expect(result.plannedRows).toBe(0);
  });
});

describe('never updates', () => {
  it('uses insert, and issues no upsert or update', async () => {
    const calls: InsertCall[] = [];
    const updates: { table: string; payload: Record<string, unknown> }[] = [];
    const { client, from } = clientRecording(calls, () => null, [], updates);
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(inputFor(archiveOf(taskRows(2))));

    const builder = from.mock.results[0].value as Record<string, unknown>;

    // Every updated_at trigger is BEFORE UPDATE. An upsert here would rewrite the history the
    // restore exists to bring back.
    expect(builder.upsert).toBeUndefined();
    expect(typeof builder.insert).toBe('function');

    // Asserted on what was CALLED, not on what the client happens to expose. `update` is now
    // reachable — one narrowly-scoped opt-in lets archived per-space configuration replace the
    // destination's own — so proving the method absent would no longer prove the invariant. That
    // nothing issued one is the invariant, and it holds for every restore that did not ask.
    expect(updates).toHaveLength(0);
  });

  it('counts an already-present row as skipped and leaves it alone', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, (rows) =>
      rows.some((row) => row.id === 't2')
        ? { code: '23505', message: 'duplicate key value' }
        : null,
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));

    expect(result.insertedRows).toBe(2);
    expect(result.skippedRows).toBe(1);
    expect(result.failedRows).toBe(0);
    expect(result.status).toBe('succeeded');
  });

  it('records the duplicate rather than passing over it silently', async () => {
    const { client } = clientRecording([], (rows) =>
      rows.some((row) => row.id === 't2')
        ? { code: '23505', message: 'duplicate key value' }
        : null,
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));
    const conflict = result.conflicts.find(
      (candidate) => candidate.conflictClass === 'duplicate',
    );

    // An uncounted DO NOTHING is indistinguishable from data loss.
    expect(conflict).toBeDefined();
    expect(conflict?.rowKey).toBe('id=t2');
    expect(conflict?.resolution).toBe('skipped');
  });
});

describe('a failed batch is isolated', () => {
  it('retries the batch one row at a time so good rows still land', async () => {
    const calls: InsertCall[] = [];

    // A bad value rather than a foreign key: this test is about batch ISOLATION, and a missing
    // parent now defers to the table's second pass instead of failing, which would prove nothing
    // here. `22P02` is row-fatal in one pass, so it still isolates the one bad row.
    const { client } = clientRecording(calls, (rows) =>
      rows.some((row) => row.id === 't2')
        ? { code: '22P02', message: 'invalid input syntax for type uuid' }
        : null,
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));

    // Reporting three failures because of one bad row would be false, and would hide the two that
    // were fine.
    expect(result.insertedRows).toBe(2);
    expect(result.failedRows).toBe(1);
    expect(result.status).toBe('partial');
  });

  it('names the row that failed', async () => {
    const { client } = clientRecording([], (rows) =>
      rows.some((row) => row.id === 't2')
        ? { code: '23503', message: 'tasks_space_id_fkey' }
        : null,
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));
    const conflict = result.conflicts.find(
      (candidate) => candidate.conflictClass === 'missing_parent',
    );

    expect(conflict?.rowKey).toBe('id=t2');
    expect(conflict?.detail).toContain('tasks_space_id_fkey');
  });

  it('stops the table on schema drift instead of retrying every row', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, () => ({
      code: '23502',
      message: 'null value in column "priority" violates not-null constraint',
    }));
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(taskRows(400))),
    );

    // A NOT NULL column added since the archive was written fails every row identically. Retrying
    // 400 of them one at a time would be 400 pointless requests.
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('missing_required_column');
    expect(calls).toHaveLength(1);
  });

  it('stops the table on an unrecognised error rather than assuming it is survivable', async () => {
    const { client } = clientRecording([], () => ({
      code: 'XX000',
      message: 'internal error',
    }));
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(5))));

    expect(result.status).toBe('failed');
  });
});

describe('rows the rules refuse', () => {
  it('never sends a row belonging to another organization', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const rows = [...taskRows(2), ...taskRows(1, OTHER_ORG)];
    const result = await service.restoreTable(inputFor(archiveOf(rows)));

    // The service role bypasses RLS, so this check is the only thing between a tampered archive
    // and one tenant's rows landing in another's.
    expect(calls[0].rows).toHaveLength(2);
    expect(calls[0].rows.every((row) => row.organization_id === ORG)).toBe(
      true,
    );
    expect(result.skippedRows).toBe(1);
  });

  it('raises a foreign row as an error, not a note', async () => {
    const { client } = clientRecording([]);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(taskRows(1, OTHER_ORG))),
    );

    const conflict = result.conflicts[0];

    expect(conflict.severity).toBe('error');
    expect(conflict.resolution).toBe('refused');
  });

  it('counts a refused row as planned, so the totals still add up', async () => {
    const { client } = clientRecording([]);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf([...taskRows(2), ...taskRows(1, OTHER_ORG)])),
    );

    expect(result.plannedRows).toBe(3);
    expect(result.insertedRows + result.skippedRows + result.failedRows).toBe(
      3,
    );
  });

  it('caps recorded conflicts so one systemic problem cannot write a million rows', async () => {
    const { client } = clientRecording([]);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(taskRows(50, OTHER_ORG)), { maxConflicts: 10 }),
    );

    expect(result.conflicts).toHaveLength(10);
    // The COUNT is still complete even though the detail is capped.
    expect(result.skippedRows).toBe(50);
  });
});

describe('dry run', () => {
  it('writes nothing at all', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(
      inputFor(archiveOf(taskRows(10)), { dryRun: true }),
    );

    expect(calls).toHaveLength(0);
  });

  it('produces the counts the real run would, through the same code', async () => {
    const { client } = clientRecording([]);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf([...taskRows(4), ...taskRows(1, OTHER_ORG)]), {
        dryRun: true,
      }),
    );

    // A preview computed by a different code path is a guess. This one applies every rule the
    // real run applies and stops just short of the insert.
    expect(result.plannedRows).toBe(5);
    expect(result.insertedRows).toBe(4);
    expect(result.skippedRows).toBe(1);
  });
});

describe('user references', () => {
  const withUsers: PlannedTable = { ...PLANNED, table: 'task_comments' };

  it('counts each nulled column so the loss is visible', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const rows = [
      {
        id: 'c1',
        organization_id: ORG,
        created_by: '99999999-9999-9999-9999-999999999999',
      },
    ];

    const result = await service.restoreTable(
      inputFor(archiveOf(rows), {
        planned: withUsers,
        knownUsers: new Set<string>(),
      }),
    );

    // task_comments.created_by is set_null in the live registry, so this is unconditional. A
    // guarded assertion here would pass silently the day the policy changed.
    expect(result.nulledUserColumns.created_by).toBe(1);
    expect(
      result.conflicts.some(
        (conflict) => conflict.resolution === 'degraded_to_null',
      ),
    ).toBe(true);
    expect(result.insertedRows).toBe(1);
  });

  it('sends the row with the reference emptied, not with it intact', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(
      inputFor(
        archiveOf([
          {
            id: 'c1',
            organization_id: ORG,
            created_by: '99999999-9999-9999-9999-999999999999',
          },
        ]),
        { planned: withUsers, knownUsers: new Set<string>() },
      ),
    );

    expect(calls[0].rows[0].created_by).toBeNull();
  });

  it('leaves the reference alone when the user list was not loaded', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(
      inputFor(
        archiveOf([{ id: 'c1', organization_id: ORG, created_by: 'u-1' }]),
        { planned: withUsers, knownUsers: null },
      ),
    );

    // null means "not checked", which must never be read as "no users exist".
    expect(calls[0].rows[0].created_by).toBe('u-1');
  });
});

describe('a damaged archive', () => {
  it('fails the table with the reason the reader gave, not a generic error', async () => {
    const { client } = clientRecording([]);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(damagedArchive('The tasks member does not match the checksum')),
    );

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('does not match the checksum');
  });

  it('writes nothing when verification fails', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(inputFor(damagedArchive('damaged')));

    expect(calls).toHaveLength(0);
  });
});

describe('a table the registry does not know', () => {
  it('refuses rather than trusting its caller', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(taskRows(1)), {
        planned: { ...PLANNED, table: 'not_a_real_table' },
      }),
    );

    expect(result.status).toBe('failed');
    expect(calls).toHaveLength(0);
  });
});

describe('a parent that is not there', () => {
  /** Fails the named rows on their first attempt only, succeeding on any retry. */
  function failFirstTime(ids: string[]) {
    const attempted = new Set<string>();

    return (rows: Record<string, unknown>[]): InsertFailure => {
      const target = rows.find((row) => ids.includes(row.id as string));

      if (!target) {
        return null;
      }

      const key = target.id as string;

      if (attempted.has(key)) {
        return null;
      }

      attempted.add(key);

      return { code: '23503', message: 'tasks_parent_id_fkey' };
    };
  }

  it('counts an unresolvable parent as SKIPPED, not failed', async () => {
    // Once dependencies are no longer dragged in, a missing parent is the ordinary outcome of
    // restoring one table. Reporting it as a failure would paint every correct restore red.
    const { client } = clientRecording([], (rows) =>
      rows.some((row) => row.id === 't2')
        ? { code: '23503', message: 'tasks_space_id_fkey' }
        : null,
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));

    expect(result.skippedRows).toBe(1);
    expect(result.failedRows).toBe(0);
    expect(result.status).toBe('succeeded');
  });

  it('records it as a warning the operator can act on', async () => {
    const { client } = clientRecording([], (rows) =>
      rows.some((row) => row.id === 't2')
        ? { code: '23503', message: 'tasks_space_id_fkey' }
        : null,
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));
    const conflict = result.conflicts.find(
      (candidate) => candidate.conflictClass === 'missing_parent',
    );

    expect(conflict?.severity).toBe('warning');
    expect(conflict?.resolution).toBe('skipped');
    expect(conflict?.rowKey).toBe('id=t2');
  });

  it('rescues a row whose parent was simply read later in the file', async () => {
    // A sub-task above its parent in the archive, or either half of a cycle. The second pass runs
    // once the whole table is in, by which point the parent exists.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, failFirstTime(['t1']));
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));

    expect(result.insertedRows).toBe(3);
    expect(result.skippedRows).toBe(0);
    expect(result.failedRows).toBe(0);
    expect(result.status).toBe('succeeded');
  });

  it('counts a still-unresolved row exactly once', async () => {
    // It fails in the first pass and again in the retry. Counting both would report two lost rows
    // where there is one.
    const { client } = clientRecording([], (rows) =>
      rows.some((row) => row.id === 't2')
        ? { code: '23503', message: 'tasks_space_id_fkey' }
        : null,
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));

    expect(result.plannedRows).toBe(3);
    expect(result.insertedRows + result.skippedRows + result.failedRows).toBe(
      3,
    );
    expect(
      result.conflicts.filter((c) => c.conflictClass === 'missing_parent'),
    ).toHaveLength(1);
  });

  it('still fails loudly on an error that is not a missing parent', async () => {
    const { client } = clientRecording([], (rows) =>
      rows.some((row) => row.id === 't2')
        ? { code: '22P02', message: 'invalid input syntax for type uuid' }
        : null,
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));

    expect(result.failedRows).toBe(1);
    expect(result.status).toBe('partial');
  });

  it('does not retry anything during a dry run', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, failFirstTime(['t1']));
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(
      inputFor(archiveOf(taskRows(3)), { dryRun: true }),
    );

    expect(calls).toHaveLength(0);
  });
});

/**
 * The space filter, and the outcome it used to hide.
 *
 * Rows outside the chosen space are deliberately not recorded one by one — thousands of them would
 * bury the real conflicts. Recording NOTHING, though, left a restore that wrote no rows reporting
 * itself as a plain success with an empty conflict list, which is indistinguishable from data that
 * silently vanished.
 */
describe('restoring into one space', () => {
  const SPACE_A = 'aaaaaaaa-0000-0000-0000-000000000000';
  const SPACE_B = 'bbbbbbbb-0000-0000-0000-000000000000';

  const rowsInSpaces = (spaces: string[]) =>
    spaces.map((space, index) => ({
      id: `t${index + 1}`,
      organization_id: ORG,
      space_id: space,
      title: `Task ${index + 1}`,
    }));

  it('writes only the rows of the chosen space', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(rowsInSpaces([SPACE_A, SPACE_B, SPACE_A])), {
        spaceId: SPACE_A,
      }),
    );

    expect(result.insertedRows).toBe(2);
    expect(result.otherSpaceRows).toBe(1);
  });

  it('summarises the filtered rows once per table rather than once per row', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(rowsInSpaces([SPACE_B, SPACE_B, SPACE_B, SPACE_A])), {
        spaceId: SPACE_A,
      }),
    );

    const summaries = result.conflicts.filter((conflict) =>
      conflict.detail.includes('different space'),
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0].detail).toContain('3 row(s)');
  });

  it('does not report a fully filtered table as succeeded', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(rowsInSpaces([SPACE_B, SPACE_B])), {
        spaceId: SPACE_A,
      }),
    );

    // `succeeded` over zero written rows is the outcome that looked like a working restore.
    expect(result.status).toBe('skipped');
    expect(result.insertedRows).toBe(0);
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  it('leaves an unfiltered restore completely unchanged', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(rowsInSpaces([SPACE_A, SPACE_B]))),
    );

    expect(result.insertedRows).toBe(2);
    expect(result.otherSpaceRows).toBe(0);
    expect(result.status).toBe('succeeded');
  });
});

/**
 * Restoring a table whose space is on the row it points at.
 *
 * `task_comments` carries no space column. Until the parent index existed nothing could tell which
 * space one belonged to, so a restore narrowed to one space wrote every comment in the tenant —
 * the same defect that put 99 `task_history` rows into a space they do not belong to.
 */
describe('restoring a parent-scoped table into one space', () => {
  const SPACE_A = 'aaaaaaaa-0000-0000-0000-000000000000';
  const SPACE_B = 'bbbbbbbb-0000-0000-0000-000000000000';

  const COMMENTS: PlannedTable = {
    table: 'task_comments',
    component: 'tasks',
    tier: 'content',
    insertLevel: 6,
    generatedColumns: [],
    addedAsDependency: false,
  };

  /** An archive holding several named tables, so a child can be read after its parent. */
  function multiArchive(
    tables: Record<string, Record<string, unknown>[]>,
  ): OpenedArchive {
    return {
      manifest: null,
      format: 'ndjson',
      restorableFormat: 'ndjson',
      tables: Object.keys(tables).map((table) => ({
        table,
        entryName: `data/${table}.ndjson`,
        extension: 'ndjson' as const,
        uncompressedSize: 1,
      })),
      rejectedEntries: [],
      verifyTable: jest.fn(),
      // eslint-disable-next-line @typescript-eslint/require-await
      async *readTable(table: string) {
        yield tables[table] ?? [];
      },
      close: jest.fn(),
    } as unknown as OpenedArchive;
  }

  const tasksInSpaces = () => [
    { id: 'task-a', organization_id: ORG, space_id: SPACE_A },
    { id: 'task-b', organization_id: ORG, space_id: SPACE_B },
  ];

  const commentsOnBoth = () => [
    { id: 'c1', organization_id: ORG, task_id: 'task-a', body: 'kept' },
    { id: 'c2', organization_id: ORG, task_id: 'task-b', body: 'dropped' },
  ];

  it('writes only the comments whose task is in the chosen space', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(
        multiArchive({
          tasks: tasksInSpaces(),
          task_comments: commentsOnBoth(),
        }),
        { planned: COMMENTS, spaceId: SPACE_A },
      ),
    );

    const written = calls.flatMap((call) => call.rows.map((row) => row.id));

    expect(written).toEqual(['c1']);
    expect(result.insertedRows).toBe(1);
    expect(result.otherSpaceRows).toBe(1);
  });

  it('FAILS the table when the parent cannot be found, rather than writing it unfiltered', async () => {
    // The most important assertion here. "Which rows qualify could not be established" and "they all
    // qualify" read the same to an insert and opposite to an operator; the permissive reading is
    // the original bug, and a silent `skipped` would hide it just as well.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(multiArchive({ task_comments: commentsOnBoth() }), {
        planned: COMMENTS,
        spaceId: SPACE_A,
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('tasks');
    expect(calls).toHaveLength(0);
  });

  it('reports a fully filtered table as skipped, not succeeded', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(
        multiArchive({
          tasks: tasksInSpaces(),
          task_comments: [
            { id: 'c2', organization_id: ORG, task_id: 'task-b' },
          ],
        }),
        { planned: COMMENTS, spaceId: SPACE_A },
      ),
    );

    expect(result.status).toBe('skipped');
    expect(result.insertedRows).toBe(0);
    expect(result.otherSpaceRows).toBe(1);
  });

  it('summarises the filtered rows once per table, not once per row', async () => {
    const { client } = clientRecording([]);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(
        multiArchive({
          tasks: tasksInSpaces(),
          task_comments: [
            { id: 'c2', organization_id: ORG, task_id: 'task-b' },
            { id: 'c3', organization_id: ORG, task_id: 'task-b' },
            { id: 'c4', organization_id: ORG, task_id: 'task-b' },
          ],
        }),
        { planned: COMMENTS, spaceId: SPACE_A },
      ),
    );

    const summaries = result.conflicts.filter((conflict) =>
      conflict.detail.includes('3 row(s)'),
    );

    expect(summaries).toHaveLength(1);
  });

  it('writes every comment and never reads the parent when no space was chosen', async () => {
    // The all-spaces path must not pay for a scan it does not need, and must not change what it
    // writes. Both are asserted, because a regression in either is invisible from the counts alone.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const readTable = jest.fn();
    const archive = multiArchive({
      tasks: tasksInSpaces(),
      task_comments: commentsOnBoth(),
    });
    const originalReadTable = archive.readTable.bind(
      archive,
    ) as OpenedArchive['readTable'];

    archive.readTable = function (table: string, batch?: number) {
      readTable(table);

      return originalReadTable(table, batch);
    };

    const result = await service.restoreTable(
      inputFor(archive, { planned: COMMENTS }),
    );

    expect(result.insertedRows).toBe(2);
    expect(readTable).not.toHaveBeenCalledWith('tasks');
  });
});

/**
 * The per-row report records.
 *
 * These guard the four things that make the report honest rather than merely present: that a dry
 * run never claims an outcome it did not observe, that a deferred row is reported once rather than
 * twice, that a space-filtered row is nameable, and that a cap says so instead of silently dropping.
 */
describe('report records', () => {
  const SPACE_A = 'aaaaaaaa-0000-0000-0000-000000000000';
  const SPACE_B = 'bbbbbbbb-0000-0000-0000-000000000000';

  it('records every inserted row as restored', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));

    expect(result.records).toHaveLength(3);
    expect(result.records.every((r) => r.outcome === 'restored')).toBe(true);
    expect(result.records.map((r) => r.rowPk)).toEqual([
      'id=t1',
      'id=t2',
      'id=t3',
    ]);
  });

  it('carries no payload for a restored row', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(2))));

    // The row is live in the destination; a second copy here would duplicate tenant data.
    expect(result.records.every((r) => !r.archivedRow)).toBe(true);
  });

  it('never claims a row was restored during a dry run', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(taskRows(4)), { dryRun: true }),
    );

    // A dry run increments insertedRows without contacting the database, so it cannot have SEEN an
    // insert succeed. Recording one would invent an outcome — the exact defect that let a preview
    // promise 122 rows and the apply write zero.
    expect(result.insertedRows).toBe(4);
    expect(result.records.filter((r) => r.outcome === 'restored')).toHaveLength(
      0,
    );
    expect(calls).toHaveLength(0);
  });

  it('still records the skips a dry run genuinely observed', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const rows = [
      { id: 't1', organization_id: ORG, space_id: SPACE_A, title: 'A' },
      { id: 't2', organization_id: ORG, space_id: SPACE_B, title: 'B' },
    ];

    const result = await service.restoreTable(
      inputFor(archiveOf(rows), { dryRun: true, spaceId: SPACE_A }),
    );

    // prepareRow reaches the same verdict with or without a write, so this one IS observed.
    const skipped = result.records.filter((r) => r.outcome === 'skipped');

    expect(skipped).toHaveLength(1);
    expect(skipped[0].reasonCode).toBe('other_space');
  });

  it('names the individual rows left out by the space filter', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const rows = [
      { id: 't1', organization_id: ORG, space_id: SPACE_B, title: 'A' },
      { id: 't2', organization_id: ORG, space_id: SPACE_B, title: 'B' },
      { id: 't3', organization_id: ORG, space_id: SPACE_A, title: 'C' },
    ];

    const result = await service.restoreTable(
      inputFor(archiveOf(rows), { spaceId: SPACE_A }),
    );

    const filtered = result.records.filter(
      (r) => r.reasonCode === 'other_space',
    );

    // The conflict side still summarises once per table; the record side names each row. Before
    // this, "which record was left out because of the space filter" had no answer at all.
    expect(filtered).toHaveLength(2);
    expect(filtered.map((r) => r.rowPk).sort()).toEqual(['id=t1', 'id=t2']);
    expect(filtered.every((r) => r.archivedRow)).toBe(true);
  });

  it('reports a row whose parent never arrives exactly once', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, () => ({
      code: '23503',
      message: 'insert or update violates foreign key constraint',
    }));

    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(1))));

    // Deferred in pass one, judged in pass two. A record emitted at BOTH sites would double-count
    // the same row in the report while the run counters said one.
    const forRow = result.records.filter((r) => r.rowPk === 'id=t1');

    expect(forRow).toHaveLength(1);
    expect(forRow[0].outcome).toBe('skipped');
    expect(forRow[0].reasonCode).toBe('missing_parent');
    expect(forRow[0].pass).toBe(2);
  });

  it('counts the records a cap refused instead of dropping them silently', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(taskRows(5)), { maxRecords: 2 }),
    );

    expect(result.records).toHaveLength(2);
    expect(result.truncatedRecords).toBe(3);
  });

  it('counts the conflicts a cap refused instead of dropping them silently', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const foreign = Array.from({ length: 4 }, (_, index) => ({
      id: `t${index + 1}`,
      organization_id: 'ffffffff-0000-0000-0000-000000000000',
      title: `Task ${index + 1}`,
    }));

    const result = await service.restoreTable(
      inputFor(archiveOf(foreign), { maxConflicts: 1 }),
    );

    expect(result.conflicts).toHaveLength(1);
    expect(result.truncatedConflicts).toBeGreaterThan(0);
  });

  it('redacts secret-named columns out of a stored payload', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const rows = [
      {
        id: 't1',
        organization_id: 'ffffffff-0000-0000-0000-000000000000',
        title: 'A',
        api_token: 'super-secret-value',
      },
    ];

    const result = await service.restoreTable(inputFor(archiveOf(rows)));

    const record = result.records.find((r) => r.rowPk === 'id=t1');

    expect(record?.archivedRow?.api_token).toBe('[redacted]');
    expect(JSON.stringify(record?.archivedRow)).not.toContain(
      'super-secret-value',
    );
  });
});

/**
 * Moving rows into a space within the same organization.
 *
 * The archive's tasks still exist in the space they were captured from and own their ids there, so
 * writing them into a second space means minting new ones. That is the same machinery a
 * cross-organization restore uses — the difference is that the tenant does not change, and that a
 * table with no rewrite spec refuses only its space-scoped ROWS rather than the whole table.
 */
describe('moving rows into another space in the same organization', () => {
  const DESTINATION = 'aaaaaaaa-0000-0000-0000-000000000000';
  const ELSEWHERE = 'bbbbbbbb-0000-0000-0000-000000000000';

  const movePlan = (): RemapPlan => ({
    archiveOrganizationId: ORG,
    // Unchanged: this is a space move, not a tenant move. That is what keeps the tenant check
    // comparing against the right organization.
    targetOrganizationId: ORG,
    destinationSpaceId: DESTINATION,
    config: new Map(),
  });

  const archivedTasks = () => [
    { id: 't1', organization_id: ORG, space_id: ELSEWHERE, key: 'NEWSPACE-T1' },
    { id: 't2', organization_id: ORG, space_id: ELSEWHERE, key: 'NEWSPACE-T2' },
  ];

  it('writes the rows with NEW ids, so they do not collide with the originals', async () => {
    // The reason ids cannot simply be preserved: t1 and t2 are still live in the space they came
    // from. Re-using their ids would be two primary-key collisions and nothing restored.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(archivedTasks()), {
        spaceId: null,
        remap: { plan: movePlan(), state: createRemapState() },
      }),
    );

    const written = calls.flatMap((call) => call.rows);

    expect(result.insertedRows).toBe(2);
    expect(written.map((row) => row.id)).not.toContain('t1');
    expect(written.map((row) => row.id)).not.toContain('t2');
  });

  it('puts them in the destination space', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(
      inputFor(archiveOf(archivedTasks()), {
        spaceId: null,
        remap: { plan: movePlan(), state: createRemapState() },
      }),
    );

    for (const row of calls.flatMap((call) => call.rows)) {
      expect(row.space_id).toBe(DESTINATION);
    }
  });

  it('clears the key so the destination space generates its own', async () => {
    // `generate_task_key` builds the key from the space it is inserted into, and only fires when
    // the column is null. Keeping NEWSPACE-T1 would leave a row in one space keyed for another.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(
      inputFor(archiveOf(archivedTasks()), {
        spaceId: null,
        remap: { plan: movePlan(), state: createRemapState() },
      }),
    );

    for (const row of calls.flatMap((call) => call.rows)) {
      expect(row.key).toBeNull();
    }
  });

  it('never rewrites the organization, because the tenant is not what is moving', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(
      inputFor(archiveOf(archivedTasks()), {
        spaceId: null,
        remap: { plan: movePlan(), state: createRemapState() },
      }),
    );

    for (const row of calls.flatMap((call) => call.rows)) {
      expect(row.organization_id).toBe(ORG);
    }
  });

  it('skips a row an earlier restore already wrote into this space', async () => {
    // The whole point of the entity map. Without it a second run would mint a second set of ids and
    // produce a second copy of everything, because nothing else could recognise the row.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(archivedTasks()), {
        spaceId: null,
        remap: {
          plan: movePlan(),
          state: createRemapState(
            new Map([[entityMapKey('tasks', 't1'), 'already-there']]),
          ),
        },
      }),
    );

    expect(calls.flatMap((call) => call.rows)).toHaveLength(1);
    expect(result.skippedRows).toBe(1);
  });

  it('inserts nothing at all when everything was already restored', async () => {
    // Running the same restore twice is a no-op, not a doubling.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(archivedTasks()), {
        spaceId: null,
        remap: {
          plan: movePlan(),
          state: createRemapState(
            new Map([
              [entityMapKey('tasks', 't1'), 'already-1'],
              [entityMapKey('tasks', 't2'), 'already-2'],
            ]),
          ),
        },
      }),
    );

    expect(calls).toHaveLength(0);
    expect(result.insertedRows).toBe(0);
    expect(result.skippedRows).toBe(2);
  });

  it('remembers what it wrote, so the next run can skip it', async () => {
    const state = createRemapState();
    const { client } = clientRecording([]);
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(
      inputFor(archiveOf(archivedTasks()), {
        spaceId: null,
        remap: { plan: movePlan(), state },
      }),
    );

    expect(state.minted.map((pair) => pair.sourceId).sort()).toEqual([
      't1',
      't2',
    ]);
    expect(state.minted.every((pair) => pair.table === 'tasks')).toBe(true);
  });

  it('records nothing for a row that failed to insert', async () => {
    // A pair recorded for a row that is not there would make the next run skip it forever.
    const state = createRemapState();
    const { client } = clientRecording([], () => ({
      code: '23502',
      message: 'null value in column "title"',
    }));
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(
      inputFor(archiveOf(archivedTasks()), {
        spaceId: null,
        remap: { plan: movePlan(), state },
      }),
    );

    expect(state.minted).toHaveLength(0);
  });
});

/**
 * Labels are read from the ARCHIVE, not from what is about to be inserted.
 *
 * `prepareRow` strips generated columns, and on `tasks` that includes `key` — it is reissued on
 * insert from `task_key_sequences`. Labelling the prepared row produced "(no name)" for all 291
 * restored tasks of a real run, while the 388 skipped ones came out correctly, because the skip
 * path already used the archived row. These lock both paths to the same source.
 */
describe('record labels survive the insert', () => {
  const PLANNED_WITH_GENERATED = {
    ...PLANNED,
    table: 'tasks',
    generatedColumns: ['key'],
  };

  it('labels a restored row from the archive, not from the stripped row', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const rows = [
      {
        id: 't1',
        organization_id: ORG,
        key: 'NEWSPACE-T88',
        summary: 'Migrate the reporting database',
      },
    ];

    const result = await service.restoreTable(
      inputFor(archiveOf(rows), { planned: PLANNED_WITH_GENERATED }),
    );

    const record = result.records.find((r) => r.outcome === 'restored');

    // The generated column never reaches the database...
    expect(calls[0].rows[0]).not.toHaveProperty('key');

    // ...but it still names the record.
    expect(record?.rowLabel).toBe(
      'NEWSPACE-T88 · Migrate the reporting database',
    );
  });

  it('labels a skipped row from the archive too, so both paths agree', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const rows = [
      {
        id: 't1',
        organization_id: 'ffffffff-0000-0000-0000-000000000000',
        key: 'NEWSPACE-T4',
        summary: 'Belongs elsewhere',
      },
    ];

    const result = await service.restoreTable(
      inputFor(archiveOf(rows), { planned: PLANNED_WITH_GENERATED }),
    );

    expect(result.records[0]?.rowLabel).toBe('NEWSPACE-T4 · Belongs elsewhere');
  });
});

/**
 * A destination that behaves like a table with a unique index.
 *
 * An id it already holds is refused with 23505; one it does not is accepted and remembered. That is
 * the whole of the writer's duplicate detection on an id-preserving restore — it never inspects a
 * key itself, it attempts the INSERT and reads the code back — so a destination that actually
 * enforces uniqueness is the only honest way to test it.
 *
 * A colliding row refuses the WHOLE batch and none of it lands, because PostgREST sends a batch as
 * one statement. That is what the writer's row-by-row fallback exists to untangle, so the fake has
 * to reproduce it rather than fail rows selectively.
 */
function destinationHolding(
  live: Set<string>,
  calls: InsertCall[],
  scripted: (rows: Record<string, unknown>[]) => InsertFailure = () => null,
) {
  return clientRecording(calls, (rows) => {
    const failure = scripted(rows);

    if (failure) {
      return failure;
    }

    if (rows.some((row) => live.has(row.id as string))) {
      return {
        code: '23505',
        message: 'duplicate key value violates unique constraint "tasks_pkey"',
      };
    }

    for (const row of rows) {
      live.add(row.id as string);
    }

    return null;
  });
}

/**
 * Running the same archive into the same destination twice.
 *
 * The requirement is blunt — a restore must not write a row that is already there — and previews
 * are ALWAYS followed by an apply from the same archive, so a second run over a destination that
 * already holds the rows is the normal case rather than an unusual one.
 */
describe('applying the same archive twice', () => {
  it('inserts the rows once and skips them on the second apply', async () => {
    const live = new Set<string>();
    const firstCalls: InsertCall[] = [];
    const secondCalls: InsertCall[] = [];

    const first = await new RestoreTableWriterService(
      destinationHolding(live, firstCalls).client,
    ).restoreTable(inputFor(archiveOf(taskRows(3))));

    const second = await new RestoreTableWriterService(
      destinationHolding(live, secondCalls).client,
    ).restoreTable(inputFor(archiveOf(taskRows(3))));

    expect(first.insertedRows).toBe(3);
    expect(second.insertedRows).toBe(0);
    expect(second.skippedRows).toBe(3);

    // Three rows went in, three rows are there. The count is the assertion — everything else is
    // reporting, and a report is not what the operator is protected by.
    expect(live.size).toBe(3);
  });

  it('reports the second apply as duplicates rather than as damage', async () => {
    const live = new Set<string>();

    await new RestoreTableWriterService(
      destinationHolding(live, []).client,
    ).restoreTable(inputFor(archiveOf(taskRows(3))));

    const second = await new RestoreTableWriterService(
      destinationHolding(live, []).client,
    ).restoreTable(inputFor(archiveOf(taskRows(3))));

    // An idempotent re-run is a correct outcome, not a failed one. Painting it red would train the
    // operator to ignore the colour.
    expect(second.status).toBe('succeeded');
    expect(second.failedRows).toBe(0);
    expect(
      second.records.every(
        (record) =>
          record.outcome === 'skipped' && record.reasonCode === 'duplicate',
      ),
    ).toBe(true);
    expect(second.records).toHaveLength(3);
  });

  it('writes the rows when the preview that ran first wrote nothing', async () => {
    // The preview is a dry run against the same destination. If it left anything behind, the apply
    // that follows would find its own rows already present and restore nothing at all.
    const live = new Set<string>();

    const preview = await new RestoreTableWriterService(
      destinationHolding(live, []).client,
    ).restoreTable(inputFor(archiveOf(taskRows(3)), { dryRun: true }));

    const apply = await new RestoreTableWriterService(
      destinationHolding(live, []).client,
    ).restoreTable(inputFor(archiveOf(taskRows(3))));

    expect(preview.insertedRows).toBe(3);
    expect(live.size).toBe(3);
    expect(apply.insertedRows).toBe(3);
    expect(apply.skippedRows).toBe(0);
  });

  it('does not double-write a row that only landed on the second pass', async () => {
    // The deferred row is the one at risk: it fails its foreign key in pass one and is inserted in
    // pass two. Counting it in both, or attempting it again after it landed, would put two copies
    // of it in the destination.
    const live = new Set<string>();
    const calls: InsertCall[] = [];
    const attempts = new Map<unknown, number>();

    const service = new RestoreTableWriterService(
      destinationHolding(live, calls, (rows) => {
        const target = rows.find((row) => row.id === 't2');

        if (!target) {
          return null;
        }

        const seen = (attempts.get(target.id) ?? 0) + 1;

        attempts.set(target.id, seen);

        // The batch, then the row alone — both before its parent exists. Pass two runs after the
        // rest of the table is in, and succeeds.
        return seen <= 2
          ? { code: '23503', message: 'tasks_parent_task_id_fkey' }
          : null;
      }).client,
    );

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));

    expect(result.insertedRows).toBe(3);
    expect(result.plannedRows).toBe(3);
    expect(live.size).toBe(3);
  });
});

/**
 * What a unique violation must and must not do.
 *
 * 23505 is the one error the writer treats as an expected outcome rather than a fault, so its
 * handling has to be exact: the row is skipped, the rest of the chunk is still attempted, and
 * nothing about it is reported as a failure.
 */
describe('a unique violation from the database', () => {
  it('skips only the colliding row and still attempts the rest of the chunk', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, (rows) =>
      rows.some((row) => row.id === 't2')
        ? {
            code: '23505',
            message: 'duplicate key value violates unique constraint',
          }
        : null,
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));

    // The batch, then all three rows individually. Stopping at the duplicate would abandon t3,
    // which had nothing wrong with it.
    expect(calls.map((call) => call.rows.length)).toEqual([3, 1, 1, 1]);
    expect(result.insertedRows).toBe(2);
    expect(result.skippedRows).toBe(1);
    expect(result.failedRows).toBe(0);
    expect(result.status).toBe('succeeded');
    expect(result.errorMessage).toBeUndefined();
  });

  it('reaches the same verdict every time it sees the same code', async () => {
    // Deterministic by construction: the class comes from the SQLSTATE alone, never from parsing
    // the message, so a reworded Postgres error cannot change what happens to the row.
    const messages = [
      'duplicate key value violates unique constraint "tasks_pkey"',
      'duplicate key value violates unique constraint "tasks_org_key_unique"',
      'ERROR: duplicate key value',
    ];

    for (const message of messages) {
      const { client } = clientRecording([], (rows) =>
        rows.some((row) => row.id === 't2') ? { code: '23505', message } : null,
      );
      const service = new RestoreTableWriterService(client);

      const result = await service.restoreTable(
        inputFor(archiveOf(taskRows(3))),
      );
      const conflict = result.conflicts.find(
        (candidate) => candidate.rowKey === 'id=t2',
      );

      expect(result.skippedRows).toBe(1);
      expect(result.failedRows).toBe(0);
      expect(conflict?.conflictClass).toBe('duplicate');
      expect(conflict?.resolution).toBe('skipped');
    }
  });

  it('catches a NATURAL-key collision as a duplicate, not as a failure', async () => {
    // The writer asks the database rather than comparing keys itself, so any unique index answers
    // with the same 23505 — whether it guards the primary key or a natural one. That is the only
    // way a row whose id was regenerated can ever be recognised as already present.
    const { client } = clientRecording([], (rows) =>
      rows.some((row) => row.title === 'Task 2')
        ? {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "tasks_organization_id_title_key"',
          }
        : null,
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));

    expect(result.skippedRows).toBe(1);
    expect(result.failedRows).toBe(0);
    expect(
      result.records.find((record) => record.rowPk === 'id=t2')?.reasonCode,
    ).toBe('duplicate');
  });
});

/**
 * Repeating a restore that REGENERATES ids.
 *
 * This is where duplicate prevention is at its most fragile, and it is worth being explicit about
 * why. Choosing a destination space mints a new uuid for every row and nulls `tasks.key` so the
 * destination reissues it — so the same logical row arrives with a primary key nothing has seen and
 * a natural key nothing can match. The database has no constraint left to refuse it with, and 23505
 * will never fire. The entity map is not one safeguard among several here; it is the only one.
 */
describe('applying the same space move twice', () => {
  const DESTINATION = 'aaaaaaaa-0000-0000-0000-000000000000';
  const ELSEWHERE = 'bbbbbbbb-0000-0000-0000-000000000000';

  const movePlan = (): RemapPlan => ({
    archiveOrganizationId: ORG,
    targetOrganizationId: ORG,
    destinationSpaceId: DESTINATION,
    config: new Map(),
  });

  /** A sub-task sitting ABOVE its parent in the file, which is how a row comes to be deferred. */
  const archivedTasks = () => [
    {
      id: 't1',
      organization_id: ORG,
      space_id: ELSEWHERE,
      key: 'OLD-T1',
      parent_task_id: 't2',
    },
    {
      id: 't2',
      organization_id: ORG,
      space_id: ELSEWHERE,
      key: 'OLD-T2',
      parent_task_id: null,
    },
  ];

  /** What `restore_entity_map` holds after a run, keyed the way the writer asks for it. */
  const mapAfter = (state: RemapState) =>
    new Map(
      state.minted.map((pair) => [
        entityMapKey(pair.table, pair.sourceId),
        pair.destinationId,
      ]),
    );

  /**
   * Refuses the child while its parent is still missing.
   *
   * Two refusals, not one: the batch fails, then the row fails alone, and only then is it held for
   * the second pass. Failing once would let the individual retry succeed and never exercise the
   * deferred path at all.
   */
  function parentNotYetThere() {
    const attempts = new Map<unknown, number>();

    return (rows: Record<string, unknown>[]): InsertFailure => {
      const child = rows.find((row) => row.parent_task_id);

      if (!child) {
        return null;
      }

      const seen = (attempts.get(child.id) ?? 0) + 1;

      attempts.set(child.id, seen);

      return seen <= 2
        ? { code: '23503', message: 'tasks_parent_task_id_fkey' }
        : null;
    };
  }

  it('writes nothing on a second apply of a clean run', async () => {
    const state = createRemapState();

    await new RestoreTableWriterService(
      clientRecording([]).client,
    ).restoreTable(
      inputFor(archiveOf(archivedTasks()), {
        spaceId: null,
        remap: { plan: movePlan(), state },
      }),
    );

    const secondCalls: InsertCall[] = [];
    const repeat = await new RestoreTableWriterService(
      clientRecording(secondCalls).client,
    ).restoreTable(
      inputFor(archiveOf(archivedTasks()), {
        spaceId: null,
        remap: { plan: movePlan(), state: createRemapState(mapAfter(state)) },
      }),
    );

    expect(secondCalls).toHaveLength(0);
    expect(repeat.insertedRows).toBe(0);
    expect(repeat.skippedRows).toBe(2);
  });

  it('maps a row that only landed on the second pass', async () => {
    // The hole this closes. `rememberMinted` ran for pass one and not for pass two, so a deferred
    // row was written and never recorded — and a deferred row is the ORDINARY case here, since a
    // sub-task whose parent sits further down the file fails its foreign key by design.
    const state = createRemapState();
    const { client } = clientRecording([], parentNotYetThere());
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(archivedTasks()), {
        spaceId: null,
        remap: { plan: movePlan(), state },
      }),
    );

    expect(result.insertedRows).toBe(2);

    // Both rows landed, so both mappings must exist. Only the parent's did.
    expect(state.minted.map((pair) => pair.sourceId).sort()).toEqual([
      't1',
      't2',
    ]);
  });

  it('does not write a deferred row again when the same archive is applied twice', async () => {
    const first = createRemapState();

    await new RestoreTableWriterService(
      clientRecording([], parentNotYetThere()).client,
    ).restoreTable(
      inputFor(archiveOf(archivedTasks()), {
        spaceId: null,
        remap: { plan: movePlan(), state: first },
      }),
    );

    const secondCalls: InsertCall[] = [];
    const repeat = await new RestoreTableWriterService(
      clientRecording(secondCalls).client,
    ).restoreTable(
      inputFor(archiveOf(archivedTasks()), {
        spaceId: null,
        remap: { plan: movePlan(), state: createRemapState(mapAfter(first)) },
      }),
    );

    // Not one insert. There is no unique constraint that could have stopped these: a fresh uuid and
    // a regenerated key look like a brand new row to the database.
    expect(secondCalls).toHaveLength(0);
    expect(repeat.insertedRows).toBe(0);
    expect(repeat.skippedRows).toBe(2);
    expect(
      repeat.records.every((record) => record.reasonCode === 'duplicate'),
    ).toBe(true);
  });

  it('still writes a deferred row that never landed', async () => {
    // The other direction, and the one that must not be traded away for the fix above: a row that
    // failed BOTH passes was never written, so recording it would make every later apply skip a row
    // that is not there.
    const state = createRemapState();
    const { client } = clientRecording([], (rows) =>
      rows.some((row) => row.parent_task_id)
        ? { code: '23503', message: 'tasks_parent_task_id_fkey' }
        : null,
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(archivedTasks()), {
        spaceId: null,
        remap: { plan: movePlan(), state },
      }),
    );

    expect(result.insertedRows).toBe(1);
    expect(result.skippedRows).toBe(1);
    expect(state.minted.map((pair) => pair.sourceId)).toEqual(['t2']);
  });
});

/**
 * The row lands, and the dropped value is reported.
 *
 * Dropping `automations.webhook_token` is what lets the automation insert at all. Dropping it
 * silently would trade one invisible failure for another.
 */
describe('globally unique columns are reported', () => {
  const AUTOMATIONS = { ...PLANNED, table: 'automations' };

  it('inserts the row and records one info conflict naming the column', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(
        archiveOf([
          {
            id: 'a1',
            organization_id: ORG,
            name: 'teest',
            webhook_token: 'tok-1',
          },
        ]),
        { planned: AUTOMATIONS },
      ),
    );

    expect(result.insertedRows).toBe(1);
    expect(calls[0].rows[0]).not.toHaveProperty('webhook_token');

    const reported = result.conflicts.filter(
      (conflict) => conflict.columnName === 'webhook_token',
    );

    expect(reported).toHaveLength(1);
    expect(reported[0].severity).toBe('info');
  });

  it('says nothing when the archive had no token', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf([{ id: 'a1', organization_id: ORG, name: 'teest' }]), {
        planned: AUTOMATIONS,
      }),
    );

    expect(
      result.conflicts.filter((c) => c.columnName === 'webhook_token'),
    ).toHaveLength(0);
  });
});

/**
 * `automation_event_outbox` — a key the DESTINATION assigns, and the hazard that made that unsafe.
 *
 * The refusal these replace cost 44 rows on every space-move restore, reported as "Belongs to
 * another space" against destinations that held none of them, on ten consecutive runs. Two things
 * had to be true before it could be lifted, and both are pinned here: the archived `id` must not
 * reach the database, so the sequence issues a fresh one; and `relayed_at` must never arrive null,
 * because the relay drain polls every two seconds on exactly that predicate with no tenant filter
 * and matches subscriptions against the row's own `space_id` — which re-scoping has just rewritten.
 */
describe('a table whose key the destination assigns', () => {
  const DESTINATION = 'aaaaaaaa-0000-0000-0000-000000000000';
  const ELSEWHERE = 'bbbbbbbb-0000-0000-0000-000000000000';

  const OUTBOX: PlannedTable = {
    table: 'automation_event_outbox',
    component: 'automation_runs',
    tier: 'content',
    insertLevel: 3,
    generatedColumns: [],
    addedAsDependency: false,
  };

  const movePlan = (): RemapPlan => ({
    archiveOrganizationId: ORG,
    targetOrganizationId: ORG,
    destinationSpaceId: DESTINATION,
    config: new Map(),
  });

  /** One delivered event and one that never was — the two cases that must diverge. */
  const archivedOutbox = () => [
    {
      id: 41,
      organization_id: ORG,
      space_id: ELSEWHERE,
      kind: 'app.task.updated',
      payload: {},
      occurred_at: '2026-08-04T11:58:56.934Z',
      relayed_at: '2026-08-04T11:58:58.000Z',
    },
    {
      id: 42,
      organization_id: ORG,
      space_id: ELSEWHERE,
      kind: 'app.task.attachment_added',
      payload: {},
      occurred_at: '2026-08-04T12:00:00.000Z',
      relayed_at: null,
    },
  ];

  const writeOutbox = async (
    calls: InsertCall[],
    overrides: Partial<
      Parameters<RestoreTableWriterService['restoreTable']>[0]
    > = {},
    fail?: (rows: Record<string, unknown>[]) => InsertFailure,
  ) => {
    const { client } = clientRecording(calls, fail);
    const service = new RestoreTableWriterService(client);

    return service.restoreTable(
      inputFor(archiveOf(archivedOutbox()), {
        planned: OUTBOX,
        spaceId: null,
        remap: { plan: movePlan(), state: createRemapState() },
        ...overrides,
      }),
    );
  };

  it('omits the archived key so the destination sequence issues one', async () => {
    const calls: InsertCall[] = [];
    const result = await writeOutbox(calls);

    const written = calls.flatMap((call) => call.rows);

    expect(result.insertedRows).toBe(2);
    expect(written).toHaveLength(2);

    // Not "a different id" — absent. A bigint column cannot take the uuid re-scoping mints, and an
    // explicit null is a 23502 against a NOT NULL column, so the only thing that works is silence.
    for (const row of written) {
      expect('id' in row).toBe(false);
      expect(row.space_id).toBe(DESTINATION);
    }
  });

  /**
   * The regression that would have been invisible.
   *
   * A restore back into the SAME space builds no remap, and there the archived id is exactly what
   * has to be sent: an existing row answers 23505 and is recognised as already present. Reissue it
   * and there is no constraint left to refuse anything, so every row lands a second time and the
   * report calls it a clean restore.
   */
  it('KEEPS the archived key when the run is not re-keying at all', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(
      inputFor(archiveOf(archivedOutbox()), { planned: OUTBOX }),
    );

    expect(calls.flatMap((call) => call.rows).map((row) => row.id)).toEqual([
      41, 42,
    ]);
  });

  it('omits the key on the per-row retry too, not just the batch', async () => {
    // A chunk that fails once is re-sent a row at a time through a different call site. Stripping
    // only in the batch path would quietly put the archived key back the moment anything went wrong.
    const calls: InsertCall[] = [];

    await writeOutbox(calls, {}, (rows) =>
      rows.length > 1 ? { code: '23505', message: 'duplicate key' } : null,
    );

    const retries = calls.filter((call) => call.rows.length === 1);

    expect(retries).not.toHaveLength(0);

    for (const call of retries) {
      expect('id' in call.rows[0]).toBe(false);
    }
  });

  it('stamps an undelivered event so it cannot fire in the destination', async () => {
    const calls: InsertCall[] = [];

    await writeOutbox(calls);

    const written = calls.flatMap((call) => call.rows);
    const delivered = written.find((row) => row.kind === 'app.task.updated');
    const undelivered = written.find(
      (row) => row.kind === 'app.task.attachment_added',
    );

    // Untouched where the archive already had an answer — this is history, not a rewrite.
    expect(delivered?.relayed_at).toBe('2026-08-04T11:58:58.000Z');

    // Filled in where it did not, which is what puts the row outside `relayed_at IS NULL` for good.
    expect(undelivered?.relayed_at).toEqual(expect.any(String));
    expect(undelivered?.relayed_at).not.toBeNull();
  });

  it('says so in the report, without inventing a reason code', async () => {
    const calls: InsertCall[] = [];
    const result = await writeOutbox(calls);

    const stamped = result.records.find(
      (record) => record.rowLabel === 'app.task.attachment_added',
    );

    expect(stamped?.outcome).toBe('restored');
    expect(stamped?.reasonCode).toBeUndefined();
    expect(stamped?.reasonDetail).toContain('marked as delivered');

    // The row that needed no stamp says nothing at all.
    const untouched = result.records.find(
      (record) => record.rowLabel === 'app.task.updated',
    );

    expect(untouched?.reasonDetail).toBeUndefined();
  });

  it('records the pair under the SOURCE key, with no id it did not observe', async () => {
    const calls: InsertCall[] = [];
    const state = createRemapState();

    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(
      inputFor(archiveOf(archivedOutbox()), {
        planned: OUTBOX,
        spaceId: null,
        remap: { plan: movePlan(), state },
      }),
    );

    // Idempotency keys on source_id, which is the whole reason a blind insert is still enough here.
    expect(state.minted.map((pair) => pair.sourceId).sort()).toEqual([
      '41',
      '42',
    ]);

    // And the destination side is honest about being unobserved rather than echoing the archived id,
    // which would read exactly like a preserved key.
    for (const pair of state.minted) {
      expect(pair.destinationId).toBe('sequence-assigned');
    }
  });

  it('skips a row an earlier run already restored into this space', async () => {
    const calls: InsertCall[] = [];
    const state = createRemapState(
      new Map([[entityMapKey('automation_event_outbox', '41'), 'whatever']]),
    );

    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(archivedOutbox()), {
        planned: OUTBOX,
        spaceId: null,
        remap: { plan: movePlan(), state },
      }),
    );

    // Repeating a restore cannot duplicate. Without the entity map there is nothing else that could
    // recognise these rows: the key is reissued, and the table has no other unique constraint.
    expect(result.skippedRows).toBe(1);
    expect(result.insertedRows).toBe(1);
    expect(calls.flatMap((call) => call.rows)).toHaveLength(1);

    const skipped = result.records.find(
      (record) => record.outcome === 'skipped',
    );

    expect(skipped?.reasonCode).toBe('duplicate');
    expect(skipped?.reasonDetail).toBe('Already restored into this space.');
  });
});

/**
 * Why a table restored nothing — the sentence the report could not previously produce.
 *
 * A restore of 147 selected tables displayed 50. The other 97 were archived correctly and held zero
 * rows, so they wrote no per-row records, and the results screen builds its table list from exactly
 * those records. They rendered as absence: `workflows` read as missing when it was merely empty.
 *
 * The counts cannot answer it on their own, which is the whole reason this exists.
 */
describe('the reason a table produced nothing', () => {
  it('says the archive held no rows, rather than saying nothing', () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    return service.restoreTable(inputFor(archiveOf([]))).then((result) => {
      expect(result.status).toBe('skipped');
      expect(result.plannedRows).toBe(0);
      expect(result.outcomeReason).toBe('archive_empty');
    });
  });

  it('says every row was already here when that is what happened', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, () => ({
      code: '23505',
      message: 'duplicate key value violates unique constraint "tasks_pkey"',
    }));
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));

    expect(result.insertedRows).toBe(0);
    expect(result.duplicateRows).toBe(3);
    expect(result.outcomeReason).toBe('already_present');

    // Still `succeeded`: a repeat restore finding its rows already there is the system working.
    expect(result.status).toBe('succeeded');
  });

  /**
   * The reason `duplicateRows` had to exist at all.
   *
   * `skippedRows` is an AGGREGATE — duplicates, missing parents, missing users and space-filtered
   * rows in one number. Reading "already present" off `insertedRows === 0 && skippedRows > 0` would
   * tell an operator their data was safely already in the destination when in fact every row of the
   * table had been dropped for want of its parent. That is the confident falsehood this whole
   * change exists to stop telling.
   */
  it('does NOT claim rows were already here when their parent was missing', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, () => ({
      code: '23503',
      message:
        'insert or update violates foreign key constraint "tasks_space_id_fkey"',
    }));
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(3))));

    expect(result.insertedRows).toBe(0);
    expect(result.skippedRows).toBe(3);

    // The aggregate says "3 skipped" exactly as it would for three duplicates. The discriminator
    // does not.
    expect(result.duplicateRows).toBe(0);
    expect(result.status).toBe('skipped');
    expect(result.outcomeReason).toBe('missing_parent');
  });

  it('says the rows could not map a required parent before insert', async () => {
    const submissions: PlannedTable = {
      table: 'form_builder_submissions',
      component: 'form_submissions',
      tier: 'content',
      insertLevel: 6,
      generatedColumns: [],
      addedAsDependency: false,
    };
    const rows = [
      {
        id: 'sub-1',
        organization_id: ORG,
        space_id: 'source-space',
        form_id: 'form-1',
        data: {},
      },
    ];
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);
    const state = createRemapState(
      new Map(),
      new Set(['form_builder', 'form_builder_submissions']),
    );

    const result = await service.restoreTable(
      inputFor(archiveOf(rows), {
        planned: submissions,
        remap: {
          plan: {
            archiveOrganizationId: ORG,
            targetOrganizationId: ORG,
            destinationSpaceId: 'destination-space',
            config: new Map(),
          },
          state,
        },
      }),
    );

    expect(result.insertedRows).toBe(0);
    expect(result.skippedRows).toBe(1);
    expect(result.status).toBe('skipped');
    expect(result.outcomeReason).toBe('unmapped_reference');
    expect(calls).toHaveLength(0);
  });

  it('says the rows belong to another space when the filter took all of them', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const rows = taskRows(2).map((row) => ({
      ...row,
      space_id: 'other-space',
    }));

    // These rows name a different space, so every one is refused against the chosen space.
    const result = await service.restoreTable(
      inputFor(archiveOf(rows), {
        spaceId: 'aaaaaaaa-0000-0000-0000-000000000000',
      }),
    );

    expect(result.insertedRows).toBe(0);
    expect(result.otherSpaceRows).toBe(2);
    expect(result.outcomeReason).toBe('other_space');
  });

  it('leaves the reason unset for a table that actually restored', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(2))));

    expect(result.insertedRows).toBe(2);

    // Nothing to explain. A failed table is the same: `errorMessage` already says what happened.
    expect(result.outcomeReason).toBeUndefined();
  });
});

describe('reading the key a unique violation collided on', () => {
  // The DETAIL line is the only place the conflicting VALUE appears — `message` names the
  // constraint and nothing else — so this is what makes "already exists" checkable instead of
  // merely asserted.

  it('unwraps an expression index, which is the shape the form slug uses', () => {
    // `form_builder_public_slug_uq` is `UNIQUE (lower(public_slug))`. Reading only bare column
    // names would blind exactly the case this was written for.
    expect(
      parseConflictKey(
        'Key (lower(public_slug))=(test-anonymous-form) already exists.',
      ),
    ).toEqual({
      columns: [{ column: 'public_slug', caseInsensitive: true }],
      values: ['test-anonymous-form'],
    });
  });

  it('reads a composite key in order', () => {
    expect(
      parseConflictKey(
        'Key (organization_id, name)=(org-1, blocks) already exists.',
      ),
    ).toEqual({
      columns: [
        { column: 'organization_id', caseInsensitive: false },
        { column: 'name', caseInsensitive: false },
      ],
      values: ['org-1', 'blocks'],
    });
  });

  it('refuses a value containing the separator rather than pairing it wrongly', () => {
    // "Smith, John" splits into two, so the lists disagree and every column after it would be
    // matched to a fragment of somebody else's value — then queried with.
    expect(
      parseConflictKey(
        'Key (organization_id, name)=(org-1, Smith, John) already exists.',
      ),
    ).toBeNull();
  });

  it('refuses an expression it cannot turn back into a column', () => {
    expect(
      parseConflictKey('Key (coalesce(a, b))=(x) already exists.'),
    ).toBeNull();
  });

  it('returns null for a detail that is not a unique violation', () => {
    expect(parseConflictKey(null)).toBeNull();
    expect(
      parseConflictKey('Key (id)=(1) is still referenced from table "child".'),
    ).toBeNull();
  });
});

describe('carrying a form into another organization', () => {
  const FORM_PLANNED: PlannedTable = {
    table: 'form_builder',
    component: 'forms',
    tier: 'content',
    insertLevel: 5,
    generatedColumns: [],
    addedAsDependency: false,
  };

  const crossOrgPlan = (): RemapPlan => ({
    archiveOrganizationId: ORG,
    targetOrganizationId: OTHER_ORG,
    destinationSpaceId: 'aaaaaaaa-0000-0000-0000-000000000000',
    config: new Map(),
  });

  const formArchive = () =>
    archiveOf([
      { id: 'f1', organization_id: ORG, public_slug: 'test-anonymous-form' },
    ]);

  const slugRefusal = () => ({
    code: '23505',
    message:
      'duplicate key value violates unique constraint "form_builder_public_slug_uq"',
  });

  /** Fails only while the row still carries a slug, so the retry with it emptied succeeds. */
  const failWhileSlugPresent = (rows: Record<string, unknown>[]) =>
    rows.some((row) => row.public_slug) ? slugRefusal() : null;

  it('gives up the slug rather than the form', async () => {
    // The bug this covers: a public form URL is one namespace product-wide, so the SOURCE
    // organization holding that slug refused the row — and the destination, which had no such
    // form at all, was told it already existed. The form and everything under it were dropped
    // over a URL.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, failWhileSlugPresent);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(formArchive(), {
        planned: FORM_PLANNED,
        spaceId: null,
        remap: { plan: crossOrgPlan(), state: createRemapState() },
      }),
    );

    expect(result.insertedRows).toBe(1);
    expect(result.skippedRows).toBe(0);

    // Batch, single retry, then the retry with the slug emptied.
    expect(calls).toHaveLength(3);
    expect(calls[2].rows[0].public_slug).toBeNull();
  });

  it('says the slug was emptied instead of reporting nothing', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, failWhileSlugPresent);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(formArchive(), {
        planned: FORM_PLANNED,
        spaceId: null,
        remap: { plan: crossOrgPlan(), state: createRemapState() },
      }),
    );

    const degraded = result.conflicts.filter(
      (conflict) => conflict.resolution === 'degraded_to_null',
    );

    expect(degraded).toHaveLength(1);
    expect(degraded[0].columnName).toBe('public_slug');
  });

  it('leaves a same-organization restore exactly as it was', async () => {
    // No remap means a re-run into the same organization, where the collision is the row's own
    // record of itself. Emptying that would strip a live form's URL.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, () => slugRefusal());
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(formArchive(), { planned: FORM_PLANNED }),
    );

    expect(result.insertedRows).toBe(0);
    expect(result.skippedRows).toBe(1);

    // Batch and the single retry. No third attempt.
    expect(calls).toHaveLength(2);
  });

  it('gives up the slug on a space move rather than losing the form', async () => {
    // A space move mints a NEW form, so the slug blocking it belongs to a DIFFERENT row — the
    // original, which is untouched and keeps its URL. Only the copy being written is rewritten.
    //
    // This is the case the old cross-organization-only gate got wrong: it treated a space move as
    // "one organization, one namespace" and skipped, which lost a form the destination space did
    // not have. Contrast the test above — a re-run has NO remap, the archived row IS the live row,
    // and giving up the value there would insert a second copy with its URL stripped off.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, (rows) =>
      rows.some((row) => row.public_slug) ? slugRefusal() : null,
    );
    const service = new RestoreTableWriterService(client);

    const samePlan: RemapPlan = {
      archiveOrganizationId: ORG,
      targetOrganizationId: ORG,
      destinationSpaceId: 'aaaaaaaa-0000-0000-0000-000000000000',
      config: new Map(),
    };

    const result = await service.restoreTable(
      inputFor(formArchive(), {
        planned: FORM_PLANNED,
        spaceId: null,
        remap: { plan: samePlan, state: createRemapState() },
      }),
    );

    expect(result.insertedRows).toBe(1);
    expect(result.skippedRows).toBe(0);
    expect(calls[2].rows[0].public_slug).toBeNull();
  });

  it('still skips when a DIFFERENT index refuses the row', async () => {
    // Only the one named index is answered by giving up a value. Everything else means what it
    // says, and a row refused for another reason must not lose a column over it.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, () => ({
      code: '23505',
      message:
        'duplicate key value violates unique constraint "form_builder_pkey"',
    }));
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(formArchive(), {
        planned: FORM_PLANNED,
        spaceId: null,
        remap: { plan: crossOrgPlan(), state: createRemapState() },
      }),
    );

    expect(result.skippedRows).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('reports the original refusal when the retry is refused too', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, () => slugRefusal());
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(formArchive(), {
        planned: FORM_PLANNED,
        spaceId: null,
        remap: { plan: crossOrgPlan(), state: createRemapState() },
      }),
    );

    // Attempted once and no more; the row is skipped as it always was.
    expect(calls).toHaveLength(3);
    expect(result.insertedRows).toBe(0);
    expect(result.skippedRows).toBe(1);
  });

  it('writes nothing during a dry run', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, failWhileSlugPresent);
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(
      inputFor(formArchive(), {
        planned: FORM_PLANNED,
        spaceId: null,
        dryRun: true,
        remap: { plan: crossOrgPlan(), state: createRemapState() },
      }),
    );

    expect(calls).toHaveLength(0);
  });
});

describe('pointing a duplicate at the row that blocked it', () => {
  // These two methods could not run before: `conflict` was set on the row outcome and dropped at
  // the hand-off into the record, so the lookup had no key and the mapping had no live row. Both
  // are exercised here for the first time.

  const DESTINATION_SPACE = 'aaaaaaaa-0000-0000-0000-000000000000';

  const crossOrgPlan = (): RemapPlan => ({
    archiveOrganizationId: ORG,
    targetOrganizationId: OTHER_ORG,
    destinationSpaceId: DESTINATION_SPACE,
    config: new Map(),
  });

  /** A `23505` carrying the DETAIL line Postgres puts the offending key in. */
  const duplicateWithKey = () => ({
    code: '23505',
    message:
      'duplicate key value violates unique constraint "tasks_org_title_uq"',
    details: 'Key (organization_id, title)=(x, Task 1) already exists.',
  });

  const liveRowIn = (
    organizationId: string,
    spaceId: string = DESTINATION_SPACE,
  ) => [
    {
      id: 'live-1',
      organization_id: organizationId,
      space_id: spaceId,
      title: 'Task 1',
    },
  ];

  const spaceMovePlan = (): RemapPlan => ({
    archiveOrganizationId: ORG,
    targetOrganizationId: ORG,
    destinationSpaceId: DESTINATION_SPACE,
    config: new Map(),
  });

  it('attaches the live row it collided with, which used to be reported as nothing', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(
      calls,
      () => duplicateWithKey(),
      liveRowIn(OTHER_ORG),
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(taskRows(1)), {
        spaceId: null,
        remap: { plan: crossOrgPlan(), state: createRemapState() },
      }),
    );

    const duplicate = result.records.find(
      (record) => record.reasonCode === 'duplicate',
    );

    expect(duplicate?.liveRow).toMatchObject({ id: 'live-1' });
  });

  it('records the mapping so a later child can find the existing parent', async () => {
    // The whole point. A parent already present used to leave its children with no address, and
    // they were skipped as `missing_parent` — eighty-three of them in the run that prompted this.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(
      calls,
      () => duplicateWithKey(),
      liveRowIn(OTHER_ORG),
    );
    const service = new RestoreTableWriterService(client);
    const state: RemapState = createRemapState();

    await service.restoreTable(
      inputFor(archiveOf(taskRows(1)), {
        spaceId: null,
        remap: { plan: crossOrgPlan(), state },
      }),
    );

    // In memory, so children LATER IN THIS RUN resolve. `alreadyRestored` is loaded once before the
    // first table is written and never re-read, so a database row alone would fix nothing today.
    expect([...state.ids.values()]).toContain('live-1');

    // And queued for the caller to persist, alongside everything else this run minted.
    expect(state.minted.some((pair) => pair.destinationId === 'live-1')).toBe(
      true,
    );
  });

  it('refuses to map when the blocking row belongs to another organization', async () => {
    // Mapping here would hand this restore's children to a different tenant's row — worse than the
    // skip it would replace.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(
      calls,
      () => duplicateWithKey(),
      liveRowIn('99999999-9999-9999-9999-999999999999'),
    );
    const service = new RestoreTableWriterService(client);
    const state: RemapState = createRemapState();

    const result = await service.restoreTable(
      inputFor(archiveOf(taskRows(1)), {
        spaceId: null,
        remap: { plan: crossOrgPlan(), state },
      }),
    );

    expect(state.minted).toHaveLength(0);
    expect(
      result.records.some(
        (record) => record.reasonCode === 'duplicate_foreign_tenant',
      ),
    ).toBe(true);
  });

  it('refuses to map when the blocking row belongs to another space in the target organization', async () => {
    const otherSpace = 'bbbbbbbb-0000-0000-0000-000000000000';
    const calls: InsertCall[] = [];
    const { client } = clientRecording(
      calls,
      () => duplicateWithKey(),
      liveRowIn(ORG, otherSpace),
    );
    const service = new RestoreTableWriterService(client);
    const state: RemapState = createRemapState();

    const result = await service.restoreTable(
      inputFor(archiveOf(taskRows(1)), {
        spaceId: null,
        remap: { plan: spaceMovePlan(), state },
      }),
    );

    expect(state.minted.some((pair) => pair.destinationId === 'live-1')).toBe(
      false,
    );
    expect(
      result.records.some(
        (record) => record.reasonCode === 'duplicate_outside_target_scope',
      ),
    ).toBe(true);
    expect(result.duplicateRows).toBe(0);
    expect(result.outcomeReason).not.toBe('already_present');
  });

  it('refuses to map when the key matched more than one row', async () => {
    // Two matches means the key did not identify one row, so nothing about it can be trusted.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, () => duplicateWithKey(), [
      { id: 'live-1', organization_id: OTHER_ORG },
      { id: 'live-2', organization_id: OTHER_ORG },
    ]);
    const service = new RestoreTableWriterService(client);
    const state: RemapState = createRemapState();

    const result = await service.restoreTable(
      inputFor(archiveOf(taskRows(1)), {
        spaceId: null,
        remap: { plan: crossOrgPlan(), state },
      }),
    );

    expect(state.minted).toHaveLength(0);
    expect(
      result.records.find((record) => record.reasonCode === 'duplicate')
        ?.liveRow,
    ).toBeUndefined();
  });

  it('falls back to the old behaviour when the driver sends no DETAIL', async () => {
    // Without the key there is nothing to look up by, so the row keeps the plain skip it has
    // always had rather than a guess.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(
      calls,
      () => ({
        code: '23505',
        message: 'duplicate key value violates unique constraint "tasks_pkey"',
      }),
      liveRowIn(OTHER_ORG),
    );
    const service = new RestoreTableWriterService(client);
    const state: RemapState = createRemapState();

    const result = await service.restoreTable(
      inputFor(archiveOf(taskRows(1)), {
        spaceId: null,
        remap: { plan: crossOrgPlan(), state },
      }),
    );

    expect(state.minted).toHaveLength(0);
    expect(result.skippedRows).toBe(1);
  });

  it('does nothing at all on a same-organization restore', async () => {
    // No remap: the archived id IS the live id, so there is nothing to forward.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(
      calls,
      () => duplicateWithKey(),
      liveRowIn(ORG),
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(inputFor(archiveOf(taskRows(1))));

    expect(result.skippedRows).toBe(1);
  });

  it('writes no mapping during a dry run', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(
      calls,
      () => duplicateWithKey(),
      liveRowIn(OTHER_ORG),
    );
    const service = new RestoreTableWriterService(client);
    const state: RemapState = createRemapState();

    await service.restoreTable(
      inputFor(archiveOf(taskRows(1)), {
        spaceId: null,
        dryRun: true,
        remap: { plan: crossOrgPlan(), state },
      }),
    );

    expect(state.minted).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('reports an organization-wide row that already exists as shared, not as a duplicate', async () => {
    const image = {
      id: 'image-1',
      organization_id: ORG,
      image_ref: 'docker.io/library/node@sha256:abc',
    };
    const calls: InsertCall[] = [];
    const { client } = clientRecording(
      calls,
      () => ({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "test_automation_user_images_pkey"',
        details: 'Key (id)=(image-1) already exists.',
      }),
      [image],
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf([image]), {
        planned: {
          ...PLANNED,
          table: 'test_automation_user_images',
          component: 'test_automation',
          tier: 'configuration',
        },
        spaceId: null,
      }),
    );

    const record = result.records.find(
      (candidate) => candidate.rowPk === 'id=image-1',
    );

    expect(record?.reasonCode).toBe('duplicate_shared');
    expect(record?.reasonDetail).toContain('shared by the whole organization');
    expect(result.failedRows).toBe(0);
  });
});

describe('a NOT NULL column that another organization already uses', () => {
  // `partner_public_listings.slug` is NOT NULL, so emptying it the way a form slug is emptied
  // would trade a 23505 for a 23502 and restore nothing. It is suffixed instead.

  const LISTING_PLANNED: PlannedTable = {
    table: 'partner_public_listings',
    component: 'partner',
    tier: 'content',
    insertLevel: 5,
    generatedColumns: [],
    addedAsDependency: false,
  };

  const crossOrgPlan = (): RemapPlan => ({
    archiveOrganizationId: ORG,
    targetOrganizationId: OTHER_ORG,
    destinationSpaceId: 'aaaaaaaa-0000-0000-0000-000000000000',
    config: new Map(),
  });

  const listingArchive = () =>
    archiveOf([{ id: 'l1', organization_id: ORG, slug: 'acme' }]);

  const slugRefusal = () => ({
    code: '23505',
    message:
      'duplicate key value violates unique constraint "partner_public_listings_slug_uidx"',
  });

  it('restores the listing under a derived slug instead of dropping it', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, (rows) =>
      rows.some((row) => row.slug === 'acme') ? slugRefusal() : null,
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(listingArchive(), {
        planned: LISTING_PLANNED,
        spaceId: null,
        remap: { plan: crossOrgPlan(), state: createRemapState() },
      }),
    );

    expect(result.insertedRows).toBe(1);

    // Never nulled: the column does not allow it.
    expect(calls[2].rows[0].slug).not.toBeNull();

    // Derived from the destination organization, so it is the same on every re-run.
    expect(calls[2].rows[0].slug).toBe(`acme-${OTHER_ORG.split('-')[0]}`);
  });

  it('produces the same slug on a second run, so a re-restore is a real duplicate', async () => {
    // The value must not be random. If it were, restoring the same archive twice would insert a
    // second near-identical listing rather than reporting the first one as already present.
    const first: InsertCall[] = [];
    const second: InsertCall[] = [];

    for (const calls of [first, second]) {
      const { client } = clientRecording(calls, (rows) =>
        rows.some((row) => row.slug === 'acme') ? slugRefusal() : null,
      );
      const service = new RestoreTableWriterService(client);

      await service.restoreTable(
        inputFor(listingArchive(), {
          planned: LISTING_PLANNED,
          spaceId: null,
          remap: { plan: crossOrgPlan(), state: createRemapState() },
        }),
      );
    }

    expect(first[2].rows[0].slug).toBe(second[2].rows[0].slug);
  });
});

describe('configuration whose space was folded into another', () => {
  // `task_hierarchy_configurations` is UNIQUE (organization_id, space_id). Restoring across
  // organizations rewrites the space id, so two source spaces can land on one destination space
  // and the second row collides — with a row it has nothing to do with.

  const CONFIG_PLANNED: PlannedTable = {
    table: 'task_hierarchy_configurations',
    component: 'hierarchy',
    tier: 'configuration',
    insertLevel: 5,
    generatedColumns: [],
    addedAsDependency: false,
  };

  const ARCHIVED_SPACE = '3a77676c-0000-0000-0000-000000000000';
  const LIVE_SPACE = '6d884f22-0000-0000-0000-000000000000';

  it('says the space was folded, not that the row already existed', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(
      calls,
      () => ({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "task_hierarchy_config_unique_org_space"',
        details: `Key (organization_id, space_id)=(${OTHER_ORG}, ${LIVE_SPACE}) already exists.`,
      }),
      // The row occupying the slot belongs to the destination, but to a DIFFERENT space than the
      // archived row came from.
      [{ id: 'live-1', organization_id: OTHER_ORG, space_id: LIVE_SPACE }],
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(
        archiveOf([
          { id: 'c1', organization_id: ORG, space_id: ARCHIVED_SPACE },
        ]),
        {
          planned: CONFIG_PLANNED,
          spaceId: null,
          remap: {
            plan: {
              archiveOrganizationId: ORG,
              targetOrganizationId: OTHER_ORG,
              destinationSpaceId: LIVE_SPACE,
              config: new Map(),
            },
            state: createRemapState(),
          },
        },
      ),
    );

    expect(
      result.records.some(
        (record) => record.reasonCode === 'duplicate_space_collapsed',
      ),
    ).toBe(true);
  });

  it('leaves the existing configuration untouched', async () => {
    // A restore has never UPDATEd, and must not start here: every `updated_at` trigger is BEFORE
    // UPDATE and would rewrite the history the restore exists to recover.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(
      calls,
      () => ({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "task_hierarchy_config_unique_org_space"',
        details: `Key (organization_id, space_id)=(${OTHER_ORG}, ${LIVE_SPACE}) already exists.`,
      }),
      [{ id: 'live-1', organization_id: OTHER_ORG, space_id: LIVE_SPACE }],
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(
        archiveOf([
          { id: 'c1', organization_id: ORG, space_id: ARCHIVED_SPACE },
        ]),
        {
          planned: CONFIG_PLANNED,
          spaceId: null,
          remap: {
            plan: {
              archiveOrganizationId: ORG,
              targetOrganizationId: OTHER_ORG,
              destinationSpaceId: LIVE_SPACE,
              config: new Map(),
            },
            state: createRemapState(),
          },
        },
      ),
    );

    expect(result.insertedRows).toBe(0);
    expect(result.skippedRows).toBe(1);

    // Only the batch and its single retry. Nothing was rewritten.
    expect(calls).toHaveLength(2);
  });

  it('still reports a plain duplicate when the space is the same', async () => {
    // Same space means it really is the row the operator already has, and the wording must not
    // blame a fold that did not happen.
    const calls: InsertCall[] = [];
    const { client } = clientRecording(
      calls,
      () => ({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "task_hierarchy_config_unique_org_space"',
        details: `Key (organization_id, space_id)=(${OTHER_ORG}, ${LIVE_SPACE}) already exists.`,
      }),
      [{ id: 'live-1', organization_id: OTHER_ORG, space_id: LIVE_SPACE }],
    );
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(
        archiveOf([{ id: 'c1', organization_id: ORG, space_id: LIVE_SPACE }]),
        {
          planned: CONFIG_PLANNED,
          spaceId: null,
          remap: {
            plan: {
              archiveOrganizationId: ORG,
              targetOrganizationId: OTHER_ORG,
              destinationSpaceId: LIVE_SPACE,
              config: new Map(),
            },
            state: createRemapState(),
          },
        },
      ),
    );

    expect(
      result.records.some((record) => record.reasonCode === 'duplicate'),
    ).toBe(true);
    expect(
      result.records.some(
        (record) => record.reasonCode === 'duplicate_space_collapsed',
      ),
    ).toBe(false);
  });
});

describe('letting the archive replace per-space configuration', () => {
  // Restoring a four-space organization into a one-space organization folds every source space
  // onto the destination's single space. `UNIQUE (organization_id, space_id)` then allows only one
  // configuration there, and the destination's own — which it may have been using for weeks — wins
  // by default. This is the opt-in that lets the archive win instead, and it is the only place a
  // restore writes over a row that was already present.

  const CONFIG_PLANNED: PlannedTable = {
    table: 'task_hierarchy_configurations',
    component: 'hierarchy',
    tier: 'configuration',
    insertLevel: 5,
    generatedColumns: [],
    addedAsDependency: false,
  };

  const DEST_SPACE = '6d884f22-0000-0000-0000-000000000000';

  const crossOrgPlan = (): RemapPlan => ({
    archiveOrganizationId: ORG,
    targetOrganizationId: OTHER_ORG,
    destinationSpaceId: DEST_SPACE,
    config: new Map(),
  });

  const occupied = () => ({
    code: '23505',
    message:
      'duplicate key value violates unique constraint "task_hierarchy_config_unique_org_space"',
  });

  const configArchive = () =>
    archiveOf([
      {
        id: 'c1',
        organization_id: ORG,
        space_id: DEST_SPACE,
        created_at: '2026-01-01T00:00:00Z',
        levels: 'from-archive',
      },
    ]);

  const runWith = async (
    replaceExistingConfig: boolean,
    updates: { table: string; payload: Record<string, unknown> }[],
  ) => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, () => occupied(), [], updates);
    const service = new RestoreTableWriterService(client);

    return service.restoreTable(
      inputFor(configArchive(), {
        planned: CONFIG_PLANNED,
        spaceId: null,
        replaceExistingConfig,
        remap: { plan: crossOrgPlan(), state: createRemapState() },
      }),
    );
  };

  it('leaves the destination alone unless it is asked', async () => {
    // The default, and the behaviour every restore had before this option existed.
    const updates: { table: string; payload: Record<string, unknown> }[] = [];
    const result = await runWith(false, updates);

    expect(updates).toHaveLength(0);
    expect(result.skippedRows).toBe(1);
    expect(result.insertedRows).toBe(0);
  });

  it('replaces the configuration when it is asked', async () => {
    const updates: { table: string; payload: Record<string, unknown> }[] = [];
    const result = await runWith(true, updates);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe('task_hierarchy_configurations');
    expect(updates[0].payload.levels).toBe('from-archive');
    expect(result.insertedRows).toBe(1);
    expect(result.skippedRows).toBe(0);
  });

  it('keeps the destination row identity, so nothing pointing at it is orphaned', async () => {
    // `id` and `created_at` are deliberately not written: the row being replaced keeps its own
    // identity and age, and only its configuration changes.
    const updates: { table: string; payload: Record<string, unknown> }[] = [];

    await runWith(true, updates);

    expect(updates[0].payload).not.toHaveProperty('id');
    expect(updates[0].payload).not.toHaveProperty('created_at');
  });

  it('does nothing for a table outside the allowlist', async () => {
    // Overwriting is destructive, so it is granted table by table rather than by rule. `tasks` is
    // not configuration and must keep skipping however the option is set.
    const updates: { table: string; payload: Record<string, unknown> }[] = [];
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, () => occupied(), [], updates);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archiveOf(taskRows(1)), {
        spaceId: null,
        replaceExistingConfig: true,
        remap: { plan: crossOrgPlan(), state: createRemapState() },
      }),
    );

    expect(updates).toHaveLength(0);
    expect(result.skippedRows).toBe(1);
  });

  it('does nothing on a same-organization restore', async () => {
    // Same organization is a re-run, not a fold: the collision is the row's own record of itself,
    // and overwriting would rewrite a row with a copy of itself and bump every updated_at.
    const updates: { table: string; payload: Record<string, unknown> }[] = [];
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, () => occupied(), [], updates);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(configArchive(), {
        planned: CONFIG_PLANNED,
        replaceExistingConfig: true,
      }),
    );

    expect(updates).toHaveLength(0);
    expect(result.skippedRows).toBe(1);
  });

  it('writes nothing during a dry run', async () => {
    const updates: { table: string; payload: Record<string, unknown> }[] = [];
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, () => occupied(), [], updates);
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(
      inputFor(configArchive(), {
        planned: CONFIG_PLANNED,
        spaceId: null,
        dryRun: true,
        replaceExistingConfig: true,
        remap: { plan: crossOrgPlan(), state: createRemapState() },
      }),
    );

    expect(updates).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe('an address whose customer already has a primary one', () => {
  // `partner_customer_addresses_one_primary_uidx` is `UNIQUE (customer_id) WHERE is_primary`. The
  // archived address was primary for its own customer; the destination's customer already has one.
  // The flag is what collides, not the address — so the address is restored demoted rather than
  // dropped, and the primary somebody already chose keeps its place.

  const ADDRESS_PLANNED: PlannedTable = {
    table: 'partner_customer_addresses',
    component: 'partner',
    tier: 'content',
    insertLevel: 5,
    generatedColumns: [],
    addedAsDependency: false,
  };

  const crossOrgPlan = (): RemapPlan => ({
    archiveOrganizationId: ORG,
    targetOrganizationId: OTHER_ORG,
    destinationSpaceId: 'aaaaaaaa-0000-0000-0000-000000000000',
    config: new Map(),
  });

  const archive = () =>
    archiveOf([{ id: 'a1', organization_id: ORG, is_primary: true }]);

  const primaryTaken = (rows: Record<string, unknown>[]) =>
    rows.some((row) => row.is_primary === true)
      ? {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "partner_customer_addresses_one_primary_uidx"',
        }
      : null;

  it('restores the address with the flag cleared rather than dropping it', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, primaryTaken);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archive(), {
        planned: ADDRESS_PLANNED,
        spaceId: null,
        remap: { plan: crossOrgPlan(), state: createRemapState() },
      }),
    );

    expect(result.insertedRows).toBe(1);
    expect(result.skippedRows).toBe(0);

    // False, not null — the column is NOT NULL, so emptying it would trade 23505 for 23502.
    expect(calls[2].rows[0].is_primary).toBe(false);
  });

  it('says the address was demoted rather than reporting a bare duplicate', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, primaryTaken);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archive(), {
        planned: ADDRESS_PLANNED,
        spaceId: null,
        remap: { plan: crossOrgPlan(), state: createRemapState() },
      }),
    );

    const degraded = result.conflicts.filter(
      (conflict) => conflict.resolution === 'degraded_to_null',
    );

    expect(degraded).toHaveLength(1);
    expect(degraded[0].columnName).toBe('is_primary');
  });

  it('leaves a same-organization restore alone', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, primaryTaken);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archive(), { planned: ADDRESS_PLANNED }),
    );

    expect(result.skippedRows).toBe(1);
    expect(calls).toHaveLength(2);
  });
});

describe('a customer another partner already actively owns', () => {
  // `partner_customers_one_active_partner_uidx` is
  // `UNIQUE (customer_organization_id) WHERE status = 'active' AND NOT is_deleted` — one partner
  // actively owns a customer organization, product-wide, and this index is the only thing in the
  // stack enforcing it.
  //
  // Cross-organization the row arrives with `organization_id` rewritten to the destination but
  // `customer_organization_id` untouched, because it names a customer rather than a tenant and
  // there is nothing to remap it to. It therefore collides with whichever OTHER partner holds that
  // customer, and the whole row used to be skipped: reported "Name taken by another organization"
  // and lost. The active claim is what collides, so the claim is what is given up.

  const CUSTOMER_PLANNED: PlannedTable = {
    table: 'partner_customers',
    component: 'partner',
    tier: 'content',
    insertLevel: 2,
    generatedColumns: [],
    addedAsDependency: false,
  };

  const CUSTOMER_ORG = 'd41d8cd9-1111-2222-3333-444444444444';

  const crossOrgPlan = (): RemapPlan => ({
    archiveOrganizationId: ORG,
    targetOrganizationId: OTHER_ORG,
    destinationSpaceId: 'aaaaaaaa-0000-0000-0000-000000000000',
    config: new Map(),
  });

  const archive = () =>
    archiveOf([
      {
        id: 'pc1',
        organization_id: ORG,
        customer_organization_id: CUSTOMER_ORG,
        status: 'active',
        is_deleted: false,
      },
    ]);

  const claimTaken = (rows: Record<string, unknown>[]) =>
    rows.some((row) => row.status === 'active')
      ? {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "partner_customers_one_active_partner_uidx"',
        }
      : null;

  it('restores the customer demoted rather than skipping the row', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, claimTaken);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archive(), {
        planned: CUSTOMER_PLANNED,
        spaceId: null,
        remap: { plan: crossOrgPlan(), state: createRemapState() },
      }),
    );

    expect(result.insertedRows).toBe(1);
    expect(result.skippedRows).toBe(0);

    // NOT NULL text constrained to `prospect|active|inactive`, so neither emptying nor suffixing
    // applies — anything outside that set trades a 23505 for a 23514.
    expect(calls[2].rows[0].status).toBe('inactive');
  });

  it('keeps the customer itself intact while giving up only the claim', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, claimTaken);
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(
      inputFor(archive(), {
        planned: CUSTOMER_PLANNED,
        spaceId: null,
        remap: { plan: crossOrgPlan(), state: createRemapState() },
      }),
    );

    // This asymmetry is the whole cause of the collision, so it is asserted rather than assumed:
    // `id` is reissued because the row is being written under a new key, while
    // `customer_organization_id` names a customer rather than a tenant and has nothing to remap to,
    // so it survives verbatim and lands on whatever the destination already had.
    expect(calls[2].rows[0].customer_organization_id).toBe(CUSTOMER_ORG);
    expect(calls[2].rows[0].id).not.toBe('pc1');
  });

  it('says the claim was given up rather than reporting a bare duplicate', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, claimTaken);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archive(), {
        planned: CUSTOMER_PLANNED,
        spaceId: null,
        remap: { plan: crossOrgPlan(), state: createRemapState() },
      }),
    );

    const degraded = result.conflicts.filter(
      (conflict) => conflict.resolution === 'degraded_to_null',
    );

    expect(degraded).toHaveLength(1);
    expect(degraded[0].columnName).toBe('status');
    expect(degraded[0].detail).toContain('inactive');
  });

  it('leaves a same-organization restore alone', async () => {
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, claimTaken);
    const service = new RestoreTableWriterService(client);

    // Same-organization is a re-run: the collision is the row's own record of itself, and demoting
    // it would deactivate a live partner's customer.
    const result = await service.restoreTable(
      inputFor(archive(), { planned: CUSTOMER_PLANNED }),
    );

    expect(result.skippedRows).toBe(1);
    expect(calls).toHaveLength(2);
  });
});

describe('replacing configuration on a space move inside one organization', () => {
  // A space move folds spaces exactly as a cross-organization restore does — `space_id` is
  // rewritten either way, so a per-space configuration can land on a slot another space already
  // holds. Refusing it because the two organizations happen to match would leave the same row
  // unrestorable for the same reason.

  const CONFIG_PLANNED: PlannedTable = {
    table: 'form_builder_payment_configs',
    component: 'forms',
    tier: 'configuration',
    insertLevel: 5,
    generatedColumns: [],
    addedAsDependency: false,
  };

  const FROM_SPACE = '6fce6951-0000-0000-0000-000000000000';
  const TO_SPACE = '8616b7f4-0000-0000-0000-000000000000';

  /** Same organization on both sides — only the space differs. */
  const spaceMovePlan = (): RemapPlan => ({
    archiveOrganizationId: ORG,
    targetOrganizationId: ORG,
    destinationSpaceId: TO_SPACE,
    config: new Map(),
  });

  const occupied = () => ({
    code: '23505',
    message:
      'duplicate key value violates unique constraint "uq_form_builder_payment_config_org_space"',
  });

  const archive = () =>
    archiveOf([{ id: 'p1', organization_id: ORG, space_id: FROM_SPACE }]);

  it('replaces the destination space configuration when asked', async () => {
    const updates: { table: string; payload: Record<string, unknown> }[] = [];
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, () => occupied(), [], updates);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archive(), {
        planned: CONFIG_PLANNED,
        spaceId: null,
        replaceExistingConfig: true,
        remap: { plan: spaceMovePlan(), state: createRemapState() },
      }),
    );

    expect(updates).toHaveLength(1);
    expect(result.insertedRows).toBe(1);
    expect(result.skippedRows).toBe(0);
  });

  it('still leaves it alone unless asked', async () => {
    const updates: { table: string; payload: Record<string, unknown> }[] = [];
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, () => occupied(), [], updates);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archive(), {
        planned: CONFIG_PLANNED,
        spaceId: null,
        replaceExistingConfig: false,
        remap: { plan: spaceMovePlan(), state: createRemapState() },
      }),
    );

    expect(updates).toHaveLength(0);
    expect(result.skippedRows).toBe(1);
  });

  it('never touches a plain re-run, which has no remap at all', async () => {
    // Nothing is being moved: the archived row IS the live row, and overwriting would rewrite it
    // with a copy of itself and bump every updated_at.
    const updates: { table: string; payload: Record<string, unknown> }[] = [];
    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls, () => occupied(), [], updates);
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(
      inputFor(archive(), {
        planned: CONFIG_PLANNED,
        replaceExistingConfig: true,
      }),
    );

    expect(updates).toHaveLength(0);
    expect(result.skippedRows).toBe(1);
  });
});

/**
 * Task keys on a space move.
 *
 * The key trigger finds the next number by scanning every task in the space, once per inserted
 * row. Minting the keys from a reserved block of the space counter keeps that scan off the restore.
 */
describe('minting task keys from the space counter on a space move', () => {
  const DESTINATION = 'aaaaaaaa-0000-0000-0000-000000000000';
  const ELSEWHERE = 'bbbbbbbb-0000-0000-0000-000000000000';

  const movePlan = (): RemapPlan => ({
    archiveOrganizationId: ORG,
    targetOrganizationId: ORG,
    destinationSpaceId: DESTINATION,
    config: new Map(),
  });

  const archivedTasks = () => [
    { id: 't1', organization_id: ORG, space_id: ELSEWHERE, key: 'NEWSPACE-T1' },
    { id: 't2', organization_id: ORG, space_id: ELSEWHERE, key: 'NEWSPACE-T2' },
  ];

  /** Client with a space key and a key counter. `casMisses` simulates tasks created meanwhile. */
  function keyMintingClient(options: {
    spaceKey?: string | null;
    lastNumber?: number | null;
    casMisses?: number;
    readError?: boolean;
    fail?: (rows: Record<string, unknown>[]) => InsertFailure;
  }) {
    const calls: InsertCall[] = [];
    const claims: Record<string, unknown>[] = [];
    let last = options.lastNumber === undefined ? 100 : options.lastNumber;
    let misses = options.casMisses ?? 0;
    const spaceKey =
      options.spaceKey === undefined ? 'BACK01' : options.spaceKey;

    const from = jest.fn().mockImplementation((table: string) => ({
      insert: (rows: Record<string, unknown>[]) => {
        calls.push({ table, rows });

        return Promise.resolve({ error: options.fail?.(rows) ?? null });
      },
      select: () => {
        const chain = {
          eq: () => chain,
          ilike: () => chain,
          limit: () => Promise.resolve({ data: [], error: null }),
          maybeSingle: () => {
            if (options.readError) {
              return Promise.resolve({
                data: null,
                error: { message: 'boom' },
              });
            }

            if (table === 'spaces') {
              return Promise.resolve({
                data: spaceKey === null ? null : { key: spaceKey },
                error: null,
              });
            }

            return Promise.resolve({
              data: last === null ? null : { last_number: last },
              error: null,
            });
          },
        };

        return chain;
      },
      update: (payload: Record<string, unknown>) => {
        const chain = {
          eq: () => chain,
          select: () => {
            claims.push(payload);

            if (misses > 0) {
              misses -= 1;
              last = (last ?? 0) + 1;

              return Promise.resolve({ data: [], error: null });
            }

            last = payload.last_number as number;

            return Promise.resolve({
              data: [{ space_id: DESTINATION }],
              error: null,
            });
          },
        };

        return chain;
      },
    }));

    return {
      client: {
        getClient: () => ({ from }),
      } as unknown as SupabaseAdminService,
      calls,
      claims,
    };
  }

  const moveInput = (overrides = {}) =>
    inputFor(archiveOf(archivedTasks()), {
      spaceId: null,
      remap: { plan: movePlan(), state: createRemapState() },
      ...overrides,
    });

  it('gives each moved task the next keys of the destination space and inserts them in one batch', async () => {
    const { client, calls, claims } = keyMintingClient({ lastNumber: 100 });
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(moveInput());
    const written = calls.flatMap((call) => call.rows);

    expect(result.insertedRows).toBe(2);
    expect(calls).toHaveLength(1);
    expect(written.map((row) => row.key)).toEqual([
      'BACK01-T101',
      'BACK01-T102',
    ]);
    expect(claims).toEqual([expect.objectContaining({ last_number: 102 })]);
  });

  it('retries the reservation when a task was created in the space meanwhile', async () => {
    const { client, calls, claims } = keyMintingClient({
      lastNumber: 100,
      casMisses: 1,
    });
    const service = new RestoreTableWriterService(client);

    await service.restoreTable(moveInput());

    expect(calls.flatMap((call) => call.rows).map((row) => row.key)).toEqual([
      'BACK01-T102',
      'BACK01-T103',
    ]);
    expect(claims).toHaveLength(2);
  });

  it('leaves the keys to the database when the space has no counter yet', async () => {
    const { client, calls, claims } = keyMintingClient({ lastNumber: null });
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(moveInput());

    expect(result.insertedRows).toBe(2);
    expect(claims).toHaveLength(0);

    for (const row of calls.flatMap((call) => call.rows)) {
      expect(row.key).toBeNull();
    }
  });

  it('leaves the keys to the database when the space or counter cannot be read', async () => {
    for (const options of [{ readError: true }, { spaceKey: null }]) {
      const { client, calls, claims } = keyMintingClient(options);
      const service = new RestoreTableWriterService(client);

      await service.restoreTable(moveInput());

      expect(claims).toHaveLength(0);

      for (const row of calls.flatMap((call) => call.rows)) {
        expect(row.key).toBeNull();
      }
    }
  });

  it('mints nothing on a restore into the same space or on a preview', async () => {
    const same = keyMintingClient({});

    await new RestoreTableWriterService(same.client).restoreTable(
      inputFor(archiveOf(archivedTasks())),
    );

    expect(same.claims).toHaveLength(0);
    expect(
      same.calls.flatMap((call) => call.rows).map((row) => row.key),
    ).toEqual(['NEWSPACE-T1', 'NEWSPACE-T2']);

    const preview = keyMintingClient({});

    await new RestoreTableWriterService(preview.client).restoreTable(
      moveInput({ dryRun: true }),
    );

    expect(preview.claims).toHaveLength(0);
    expect(preview.calls).toHaveLength(0);
  });

  it('hands a key that is already taken back to the database and says so', async () => {
    const taken = {
      code: '23505',
      message:
        'duplicate key value violates unique constraint "idx_tasks_key_unique"',
    };
    const { client, calls } = keyMintingClient({
      lastNumber: 100,
      fail: (rows) =>
        rows.some((row) => row.key === 'BACK01-T101') ? taken : null,
    });
    const service = new RestoreTableWriterService(client);

    const result = await service.restoreTable(moveInput());
    const resent = calls.filter(
      (call) => call.rows.length === 1 && call.rows[0].key === null,
    );

    expect(result.insertedRows).toBe(2);
    expect(result.failedRows).toBe(0);
    expect(resent).toHaveLength(1);
    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          columnName: 'key',
          detail:
            'The task key was already taken in this space, so the task was given the next free key.',
        }),
      ]),
    );
  });
});

describe('progress while a large table runs', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports the counts so far between read batches', async () => {
    let now = 0;

    jest.spyOn(Date, 'now').mockImplementation(() => (now += 6_000));

    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);
    const onProgress = jest.fn().mockResolvedValue(undefined);

    const result = await service.restoreTable(
      inputFor(archiveOf(taskRows(1500)), { onProgress }),
    );

    expect(result.insertedRows).toBe(1500);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenLastCalledWith({
      planned: 1000,
      inserted: 1000,
      skipped: 0,
      failed: 0,
    });
  });

  it('stays quiet when the table finishes inside the reporting interval', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);

    const calls: InsertCall[] = [];
    const { client } = clientRecording(calls);
    const service = new RestoreTableWriterService(client);
    const onProgress = jest.fn().mockResolvedValue(undefined);

    await service.restoreTable(
      inputFor(archiveOf(taskRows(1500)), { onProgress }),
    );

    expect(onProgress).not.toHaveBeenCalled();
  });
});
