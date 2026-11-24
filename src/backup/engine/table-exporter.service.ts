/**
 * @fileoverview Reads one table out of PostgREST, completely, or fails the run.
 * @module src/backup/engine/table-exporter.service
 *
 * This file exists because of one fact: PostgREST is configured with `max_rows = 1000`, and a
 * truncated response is an ordinary **HTTP 200**. Nothing above PostgREST can tell a full page from
 * a truncated one. A naive exporter therefore writes 1,000 rows per table, computes a correct
 * checksum over those 1,000 rows, writes a valid manifest, and reports success — handing the
 * customer an archive missing most of their data, discovered only during a restore.
 *
 * Three rules make that impossible:
 *   1. `count: 'exact'` on every page, so a total is always known.
 *   2. Keyset paging, never `.range()` — an offset window shifts under concurrent inserts and
 *      silently skips or duplicates rows.
 *   3. A short page that is not the final page ABORTS the run. Not a warning, not a retry: the run
 *      is cheap to repeat and a silently incomplete archive is not.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';

/** Stays under the PostgREST cap with room to spare; the cap is verified at run start. */
export const EXPORT_PAGE_SIZE = 500;

/**
 * How a table without its own tenant column is narrowed, mirroring ParentScope in the registry.
 *
 * PostgREST can filter on an embedded parent with `!inner`, so this needs no RPC: the embed acts as
 * a join and the filter applies to the parent's column. The embedded object is stripped from every
 * row before it is written, so the archive contains the table as it exists and not a joined shape
 * that a restore would fail to insert.
 */
export interface ParentScopeFilter {
  parentTable: string;
  parentTenantColumn: string;

  /**
   * The FK column on THIS table that points at the parent — `automation_versions.automation_id`.
   *
   * Load-bearing, not decorative. PostgREST refuses an embed it cannot resolve to exactly one
   * relationship (PGRST201), and three of these seven tables are linked to their parent by more
   * than one foreign key: `automations` points back at `automation_versions` through both
   * `current_version_id` and `published_version_id`, so `automations!inner(...)` is ambiguous and
   * the whole run dies on that table. Naming the originating column disambiguates it.
   */
  parentColumn: string;
}

/** Raised when a page comes back short and it is not the last page. */
export class BackupTruncationError extends Error {
  constructor(table: string, expected: number, received: number) {
    super(
      `${table} returned ${received} rows for a non-final page of ${expected}. ` +
        'The archive would be silently incomplete, so the run was failed.',
    );
    this.name = 'BackupTruncationError';
  }
}

export interface TableExportResult {
  table: string;
  rowsWritten: number;
  rowsExpected: number;
}

@Injectable()
export class TableExporterService {
  private readonly logger = new Logger(TableExporterService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Streams a table's rows for one organization, page by page, in `id` order.
   *
   * Ordered by `id` because it is unique and total. `created_at` alone has ties — bulk-imported rows
   * routinely share a millisecond — and a tie spanning a page boundary skips or repeats rows.
   */
  async *exportTable(
    table: string,
    organizationId: string,
    tenantColumn: string | null = 'organization_id',
    parentScope?: ParentScopeFilter,
    orderBy: string[] = ['id'],
  ): AsyncGenerator<Record<string, unknown>[], TableExportResult> {
    const scope = this.scopeFor(table, tenantColumn, parentScope);

    if (!orderBy.length) {
      throw new Error(
        `${table} has no ordering key, so its rows cannot be paged deterministically.`,
      );
    }

    // The first page is fetched outside the loop because it is the only one that needs a count.
    // Asking for `count: 'exact'` on every page re-runs a full COUNT(*) over the same predicate
    // once per page — the same table counted again and again — which is what made a single large
    // table slow. Splitting it also keeps the loop's types free of a nullable total.
    let firstQuery = this.db
      .from(table)
      .select(scope.select, { count: 'exact' })
      .eq(scope.filterColumn, organizationId);

    for (const column of orderBy) {
      firstQuery = firstQuery.order(column, { ascending: true });
    }

    const first = await firstQuery.limit(EXPORT_PAGE_SIZE);

    if (first.error) {
      throw new Error(`Failed to read ${table}: ${first.error.message}`);
    }

    const firstRows = scope.clean(
      (first.data ?? []) as unknown as Record<string, unknown>[],
    );

    if (!firstRows.length) {
      return { table, rowsWritten: 0, rowsExpected: 0 };
    }

    yield firstRows;

    let emitted = firstRows.length;

    // A first page shorter than the limit IS the whole table: PostgREST only truncates at its cap,
    // and assertPageSizeIsSafe() has proven the cap is at least our page size. So the common case —
    // a small table — costs one request and needs no further paging.
    if (firstRows.length < EXPORT_PAGE_SIZE) {
      return { table, rowsWritten: emitted, rowsExpected: emitted };
    }

    const total = first.count ?? emitted;

    // Keyset paging needs a single column that is unique across the rows being exported. With a
    // composite key there is no one column to compare, so those tables fall back to offset paging.
    // That is safe here only because the reconciliation below turns a window that shifted under a
    // concurrent write into a failed run rather than a silently short archive.
    const keysetColumn = orderBy.length === 1 ? orderBy[0] : null;
    let cursor = keysetColumn
      ? this.cursorFrom(firstRows, table, keysetColumn)
      : null;

    while (emitted < total) {
      let query = this.db
        .from(table)
        .select(scope.select)
        .eq(scope.filterColumn, organizationId);

      if (keysetColumn && cursor !== null) {
        query = query.gt(keysetColumn, cursor);
      } else {
        query = query.range(emitted, emitted + EXPORT_PAGE_SIZE - 1);
      }

      for (const column of orderBy) {
        query = query.order(column, { ascending: true });
      }

      const { data, error } = await query.limit(EXPORT_PAGE_SIZE);

      if (error) {
        throw new Error(`Failed to read ${table}: ${error.message}`);
      }

      const rows = scope.clean(
        (data ?? []) as unknown as Record<string, unknown>[],
      );

      if (!rows.length) {
        break;
      }

      const expected = Math.min(EXPORT_PAGE_SIZE, total - emitted);

      if (rows.length < expected) {
        throw new BackupTruncationError(table, expected, rows.length);
      }

      yield rows;
      emitted += rows.length;

      if (keysetColumn) {
        cursor = this.cursorFrom(rows, table, keysetColumn);
      }
    }

    // Reconciliation: what the server said the total was must equal what we actually wrote.
    if (emitted !== total) {
      throw new BackupTruncationError(table, total, emitted);
    }

    return { table, rowsWritten: emitted, rowsExpected: total };
  }

  /**
   * Builds the select clause and tenant filter for one table.
   *
   * A table with its own tenant column filters on it directly. One without filters through an
   * `!inner` embed of its parent, which PostgREST executes as a join — so `fe_versions` is narrowed
   * by `fe_nodes.organization_id` without a subquery or an RPC.
   *
   * The embed comes back as a nested object on every row, so `clean` strips it. Leaving it in would
   * put a column in the archive that does not exist on the table, and a restore inserting that row
   * would fail on the unknown key.
   */
  private scopeFor(
    table: string,
    tenantColumn: string | null,
    parentScope?: ParentScopeFilter,
  ): {
    select: string;
    filterColumn: string;
    clean: (rows: Record<string, unknown>[]) => Record<string, unknown>[];
  } {
    if (tenantColumn) {
      return {
        select: '*',
        filterColumn: tenantColumn,
        clean: (rows) => rows,
      };
    }

    if (!parentScope) {
      // Refused rather than guessed. Falling back to `organization_id` on a table that has none
      // would fail with a PostgREST 42703; falling back to no filter at all would export every
      // tenant's rows into one organization's archive.
      throw new Error(
        `${table} has no tenant column and no parent scope, so it cannot be exported safely.`,
      );
    }

    const { parentTable, parentTenantColumn, parentColumn } = parentScope;

    return {
      // The `!${parentColumn}` hint names WHICH foreign key to join on. Without it PostgREST
      // returns 300/PGRST201 for any table its parent also points back at — verified against the
      // live schema for automation_versions (3 FK paths), fe_versions and file_versions (2 each).
      //
      // The hint does not rename the embed: the response key is still the parent table, which is
      // what `clean` below deletes and what `filterColumn` filters on. Verified against PostgREST,
      // because if that were not true both would break silently rather than loudly.
      select: `*, ${parentTable}!${parentColumn}!inner(${parentTenantColumn})`,
      filterColumn: `${parentTable}.${parentTenantColumn}`,
      clean: (rows) =>
        rows.map((row) => {
          const rest = { ...row };

          // The embed is a join artefact, not a column. Leaving it in would put a key in the
          // archive that the table does not have, and the insert restoring it would fail.
          delete rest[parentTable];

          return rest;
        }),
    };
  }

  /**
   * The keyset cursor for the next page. Throws rather than risk a silent partial export.
   *
   * Accepts numbers as well as strings: the ordering key is whatever the table's primary key is,
   * and not every one of those is a uuid. Null is refused outright — a nullable cursor column
   * would make `.gt()` skip rows without any error.
   */
  private cursorFrom(
    rows: Record<string, unknown>[],
    table: string,
    column: string,
  ): string | number {
    const last = rows[rows.length - 1]?.[column];

    if (typeof last !== 'string' && typeof last !== 'number') {
      throw new Error(
        `${table}.${column} is not a usable paging cursor (got ${last === null ? 'null' : typeof last}); ` +
          'cannot export it safely.',
      );
    }

    return last;
  }

  /**
   * Confirms the server's row cap is above our page size before a single row is exported.
   *
   * If someone lowers `max_rows` below EXPORT_PAGE_SIZE, every page would come back short and the
   * run would fail late and confusingly. Better to refuse at the start with a clear reason.
   */
  async assertPageSizeIsSafe(probeTable = 'backup_run_items'): Promise<number> {
    const { count, error } = await this.db
      .from(probeTable)
      .select('id', { count: 'exact', head: true });

    if (error) {
      this.logger.warn(`Could not probe the row cap: ${error.message}`);

      return EXPORT_PAGE_SIZE;
    }

    const available = count ?? 0;

    // Only meaningful when the probe table holds more rows than a page; otherwise a short read
    // proves nothing about the cap.
    if (available <= EXPORT_PAGE_SIZE) {
      return EXPORT_PAGE_SIZE;
    }

    const { data, error: pageError } = await this.db
      .from(probeTable)
      .select('id')
      .limit(EXPORT_PAGE_SIZE);

    if (pageError) {
      this.logger.warn(`Could not probe the row cap: ${pageError.message}`);

      return EXPORT_PAGE_SIZE;
    }

    const returned = (data ?? []).length;

    if (returned < EXPORT_PAGE_SIZE) {
      // The server truncates below our page size. Every "short page" would then be ambiguous —
      // genuinely fewer rows, or silently cut off — so refuse before exporting anything.
      throw new Error(
        `The database returns at most ${returned} rows per request, below the export page size of ` +
          `${EXPORT_PAGE_SIZE}. Raise PostgREST's max_rows, or lower EXPORT_PAGE_SIZE, before running a backup.`,
      );
    }

    return returned;
  }
}
