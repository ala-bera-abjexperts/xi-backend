/**
 * @fileoverview Tests for the parent-space index.
 * @module src/backup/engine/restore-space-scope.spec
 *
 * The rule under test is narrow and the consequences of getting it wrong are not: this set decides
 * which rows of 36 tables a per-space restore writes. Too permissive and another space's rows land
 * in the chosen one — the defect this exists to fix. Too strict and a legitimate restore silently
 * loses data. Most of what is asserted here is therefore which rows are NOT in the set, and that an
 * unanswerable question returns null rather than an empty set.
 */

import type { OpenedArchive } from './archive-reader.service';
import type { SpaceParentScope } from '../registry/component-registry';
import {
  MAX_PARENT_IDS,
  SpaceParentIndex,
  SpaceParentIndexError,
} from './restore-space-scope';

const ORG = '9de67ec3-1111-2222-3333-444444444444';
const OTHER_ORG = 'cecb176b-9999-8888-7777-666666666666';
const SPACE = '4b2eb6d0-bc26-4e3f-83b6-4c717a946eda';
const OTHER_SPACE = '3a77676c-f982-4402-8752-096e58c05988';

const SCOPE: SpaceParentScope = {
  column: 'task_id',
  parentTable: 'tasks',
  parentSpaceColumn: 'space_id',
  whenNull: 'refuse',
};

/**
 * An archive holding the named tables.
 *
 * `readTable` is a jest.fn so the memoisation test can count calls — scanning `tasks` once for all
 * seven of its children is the difference between one re-hash of the member and seven.
 */
function archiveOf(
  tables: Record<string, Record<string, unknown>[]>,
): OpenedArchive & { readCalls: jest.Mock } {
  const readCalls = jest.fn();

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
      readCalls(table);
      yield tables[table] ?? [];
    },
    close: jest.fn(),
    readCalls,
  } as unknown as OpenedArchive & { readCalls: jest.Mock };
}

function task(
  id: string,
  organizationId = ORG,
  spaceId: string | null = SPACE,
) {
  return { id, organization_id: organizationId, space_id: spaceId };
}

describe('reading the parent from the archive', () => {
  it('keeps only the parents that are in the chosen space', async () => {
    const archive = archiveOf({
      tasks: [task('in'), task('out', ORG, OTHER_SPACE)],
    });

    const ids = await new SpaceParentIndex(archive, ORG, SPACE).idsInSpace(
      SCOPE,
    );

    expect([...ids!]).toEqual(['in']);
  });

  it('excludes a parent belonging to another organization', async () => {
    // This is what makes "the parent was refused, so its children are too" fall out of one rule
    // rather than needing a second pass: a foreign-tenant parent never enters the set, so every
    // child pointing at it is refused for having an unknown space.
    const archive = archiveOf({
      tasks: [task('ours'), task('theirs', OTHER_ORG)],
    });

    const ids = await new SpaceParentIndex(archive, ORG, SPACE).idsInSpace(
      SCOPE,
    );

    expect([...ids!]).toEqual(['ours']);
  });

  it('excludes a parent whose space is NULL', async () => {
    const archive = archiveOf({ tasks: [task('a'), task('b', ORG, null)] });

    const ids = await new SpaceParentIndex(archive, ORG, SPACE).idsInSpace(
      SCOPE,
    );

    expect([...ids!]).toEqual(['a']);
  });

  it('keeps a parent that carries no tenant column of its own', async () => {
    // A parent scoped through ITS parent has no organization_id to check. It is still narrowed by
    // space here, and the tenant check it does get is the one its own table performs when written.
    const archive = archiveOf({
      tasks: [
        { id: 'a', space_id: SPACE },
        { id: 'b', space_id: OTHER_SPACE },
      ],
    });

    const ids = await new SpaceParentIndex(archive, ORG, SPACE).idsInSpace(
      SCOPE,
    );

    expect([...ids!]).toEqual(['a']);
  });

  it('returns an empty set rather than null when the parent has no rows in the space', async () => {
    // Empty and unknown are different answers. Empty means "no children qualify", which is a real
    // and correct outcome; null means "we could not tell", which must fail the table instead.
    const archive = archiveOf({ tasks: [task('x', ORG, OTHER_SPACE)] });

    const ids = await new SpaceParentIndex(archive, ORG, SPACE).idsInSpace(
      SCOPE,
    );

    expect(ids).not.toBeNull();
    expect(ids!.size).toBe(0);
  });

  it('reads the parent once however many children ask for it', async () => {
    // `tasks` is the space parent of seven tables. Reading it seven times would re-verify and
    // re-hash the whole member each time.
    const archive = archiveOf({ tasks: [task('a')] });
    const index = new SpaceParentIndex(archive, ORG, SPACE);

    await Promise.all([
      index.idsInSpace(SCOPE),
      index.idsInSpace(SCOPE),
      index.idsInSpace(SCOPE),
    ]);
    await index.idsInSpace(SCOPE);

    expect(archive.readCalls).toHaveBeenCalledTimes(1);
  });

  it('refuses a set larger than it can hold rather than exhausting the heap', async () => {
    const archive = archiveOf({ tasks: [] });

    // Yields one row past the cap without materialising a million objects first.
    (archive as unknown as { readTable: unknown }).readTable =
      // eslint-disable-next-line @typescript-eslint/require-await
      async function* () {
        const batch: Record<string, unknown>[] = [];

        for (let index = 0; index <= MAX_PARENT_IDS; index += 1) {
          batch.push(task(`t${index}`));

          if (batch.length === 5000) {
            yield batch.splice(0, batch.length);
          }
        }

        yield batch;
      };

    await expect(
      new SpaceParentIndex(archive, ORG, SPACE).idsInSpace(SCOPE),
    ).rejects.toBeInstanceOf(SpaceParentIndexError);
  });
});

describe('when the archive does not hold the parent', () => {
  const withoutTasks = () => archiveOf({ task_comments: [] });

  it('returns null, so the caller fails the table instead of writing it unfiltered', async () => {
    const ids = await new SpaceParentIndex(
      withoutTasks(),
      ORG,
      SPACE,
    ).idsInSpace(SCOPE);

    expect(ids).toBeNull();
  });

  it('falls back to the destination when one was supplied', async () => {
    const eq2 = jest
      .fn()
      .mockResolvedValue({ data: [{ id: 'live' }], error: null });
    const client = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({ eq: eq2 }),
        }),
      }),
    };

    const ids = await new SpaceParentIndex(
      withoutTasks(),
      ORG,
      SPACE,
      client,
    ).idsInSpace(SCOPE);

    expect([...ids!]).toEqual(['live']);
    expect(client.from).toHaveBeenCalledWith('tasks');
    expect(eq2).toHaveBeenCalledWith('space_id', SPACE);
  });

  it('returns null when the destination cannot answer', async () => {
    // A destination that errored is "unknown", not "empty". Treating an error as an empty set would
    // silently refuse every child row and report the table as cleanly filtered.
    const client = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest
              .fn()
              .mockResolvedValue({ data: null, error: { message: 'nope' } }),
          }),
        }),
      }),
    };

    const ids = await new SpaceParentIndex(
      withoutTasks(),
      ORG,
      SPACE,
      client,
    ).idsInSpace(SCOPE);

    expect(ids).toBeNull();
  });

  it('returns null when the destination throws', async () => {
    const client = {
      from: jest.fn().mockImplementation(() => {
        throw new Error('connection reset');
      }),
    };

    const ids = await new SpaceParentIndex(
      withoutTasks(),
      ORG,
      SPACE,
      client as never,
    ).idsInSpace(SCOPE);

    expect(ids).toBeNull();
  });
});
