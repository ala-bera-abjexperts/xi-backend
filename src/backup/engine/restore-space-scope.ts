/**
 * @fileoverview Which rows of a parent table are in the space being restored.
 * @module src/backup/engine/restore-space-scope
 *
 * Thirty-six tables carry no space of their own. `task_comments` has a `task_id`; the space is on
 * the task. Until this existed the engine had no way to turn one into the other, so those tables
 * were written whatever space the operator chose — a restore scoped to one space wrote 99
 * `task_history` rows belonging to another, and every archived space of the tenant came back.
 *
 * The set is built from the ARCHIVE, not from the destination. Three reasons, in order of how badly
 * each alternative fails:
 *
 *   * On a fresh restore the destination is empty, so asking it "which tasks are in this space"
 *     answers "none" and would discard every child row in the archive.
 *   * The archive always holds every space of the organization — the exporter filters on
 *     `organization_id` and nothing else — so the parent's rows are in the file whether or not the
 *     operator selected the parent table.
 *   * Reading a table is not restoring it, so this does not touch the planner's "restore only what
 *     was selected" contract. `task_comments` alone stays a legal selection.
 *
 * The destination is consulted only as a fallback, for an archive that genuinely lacks the parent.
 *
 * Failure is never silent and never permissive: a set that cannot be established fails the table
 * rather than letting its rows through, because "we could not tell" and "they all qualify" are the
 * same sentence to an insert and opposite sentences to an operator.
 */

import type { OpenedArchive } from './archive-reader.service';
import type { SpaceParentScope } from '../registry/component-registry';

/** Rows read per batch during a parent scan. Matches the write path's read size. */
const SCAN_BATCH_ROWS = 500;

/**
 * Above this many in-space parent ids the set is refused rather than allowed to exhaust the heap.
 *
 * A named failure an operator can act on beats an out-of-memory kill part-way through a restore
 * that cannot be rolled back.
 */
export const MAX_PARENT_IDS = 1_000_000;

export class SpaceParentIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpaceParentIndexError';
  }
}

/** A destination client, narrowed to the one call this module makes. */
export interface SpaceParentFallbackClient {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        eq(
          column: string,
          value: string,
        ): PromiseLike<{
          data: Record<string, unknown>[] | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
}

/** A value that is an id, or null when it is absent or not scalar. */
function scalarId(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  return null;
}

/**
 * The ids of the parent rows that are in the chosen space, so a child table can be filtered.
 *
 * One instance per restore run. `tasks` is the space parent of seven tables and is scanned once,
 * not seven times.
 */
export class SpaceParentIndex {
  private readonly cache = new Map<string, ReadonlySet<string> | null>();

  /**
   * Scans already running, keyed by parent table.
   *
   * `runTables` is serial today, but `lease_restore_run_items` exists and someone will parallelise
   * it. Deduping concurrent scans costs three lines now and prevents seven redundant re-hashes of
   * `tasks` later.
   */
  private readonly inFlight = new Map<
    string,
    Promise<ReadonlySet<string> | null>
  >();

  constructor(
    private readonly archive: OpenedArchive,
    private readonly organizationId: string,
    private readonly spaceId: string,
    /** Consulted only when the archive does not contain the parent at all. */
    private readonly fallback?: SpaceParentFallbackClient,
  ) {}

  /**
   * @returns The in-space parent ids, or null when they could not be established at all — which the
   *   caller must treat as "fail this table", never as "no rows match".
   * @throws SpaceParentIndexError when the set would exceed {@link MAX_PARENT_IDS}.
   */
  async idsInSpace(
    scope: SpaceParentScope,
  ): Promise<ReadonlySet<string> | null> {
    const parent = scope.parentTable;
    const cached = this.cache.get(parent);

    if (cached !== undefined) {
      return cached;
    }

    const running = this.inFlight.get(parent);

    if (running) {
      return running;
    }

    const scan = this.resolve(scope)
      .then((ids) => {
        this.cache.set(parent, ids);

        return ids;
      })
      .finally(() => {
        this.inFlight.delete(parent);
      });

    this.inFlight.set(parent, scan);

    return scan;
  }

  private async resolve(
    scope: SpaceParentScope,
  ): Promise<ReadonlySet<string> | null> {
    const inArchive = this.archive.tables.some(
      (entry) => entry.table === scope.parentTable,
    );

    return inArchive ? this.fromArchive(scope) : this.fromDestination(scope);
  }

  /**
   * The parent's rows as the archive holds them, keeping only those that would themselves be
   * accepted.
   *
   * Tenant AND space, because a parent refused for belonging to another organization must not lend
   * its space to a child. That one rule is what makes "the parent was refused, so the child is too"
   * fall out rather than needing its own pass.
   *
   * Deliberately does NOT apply the user-FK policy. A parent dropped for a missing user leaves the
   * child failing its foreign key, which the existing deferred/`missing_parent` path already reports
   * correctly — and keeping this scan to two columns keeps one rule in one place.
   */
  private async fromArchive(
    scope: SpaceParentScope,
  ): Promise<ReadonlySet<string>> {
    const ids = new Set<string>();

    for await (const batch of this.archive.readTable(
      scope.parentTable,
      SCAN_BATCH_ROWS,
    )) {
      for (const row of batch) {
        const id = scalarId(row['id']);

        if (id === null) {
          continue;
        }

        const tenant =
          scalarId(row['organization_id']) ?? scalarId(row['organizationid']);

        // A parent with no tenant column of its own reaches tenancy through its own parent. It is
        // still narrowed by space here, and the tenant check it does get is the one its own table
        // performs when it is written.
        if (tenant !== null && tenant !== this.organizationId) {
          continue;
        }

        if (scalarId(row[scope.parentSpaceColumn]) !== this.spaceId) {
          continue;
        }

        ids.add(id);

        if (ids.size > MAX_PARENT_IDS) {
          throw new SpaceParentIndexError(
            `${scope.parentTable} has more than ${MAX_PARENT_IDS.toLocaleString('en-US')} rows in the chosen space, ` +
              'which is more than this restore can hold in memory to filter its children by. ' +
              'Restore without narrowing to a space, or restore the parent table on its own first.',
          );
        }
      }
    }

    return ids;
  }

  /**
   * The parent's rows as the DESTINATION holds them.
   *
   * Only for an archive that does not contain the parent at all. Useless on a fresh restore, where
   * the destination is empty and this correctly returns an empty set rather than a null — an empty
   * destination genuinely has no in-space parents, so the children genuinely have nothing to attach
   * to, and refusing them is right.
   */
  private async fromDestination(
    scope: SpaceParentScope,
  ): Promise<ReadonlySet<string> | null> {
    if (!this.fallback) {
      return null;
    }

    try {
      const { data, error } = await this.fallback
        .from(scope.parentTable)
        .select('id')
        .eq('organization_id', this.organizationId)
        .eq(scope.parentSpaceColumn, this.spaceId);

      if (error || !data) {
        return null;
      }

      const ids = new Set<string>();

      for (const row of data) {
        const id = scalarId(row['id']);

        if (id !== null) {
          ids.add(id);
        }
      }

      return ids;
    } catch {
      // A destination that cannot answer is "unknown", not "empty". The caller fails the table.
      return null;
    }
  }
}
