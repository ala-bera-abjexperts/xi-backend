/**
 * @fileoverview The half of the preflight that has to ask the database.
 * @module src/backup/engine/restore-preflight.service
 *
 * `restore-planner.ts` decides what a restore is allowed to attempt from the
 * registry alone. This asks the live database the one question the registry
 * cannot answer: is the destination actually empty?
 *
 * That check is what makes id-preserving restore safe. Archived rows keep their
 * original primary keys, so a destination that already holds rows would either
 * collide on the key or — worse, where the key differs — quietly produce two
 * generations of the same data side by side. Refusing is the only honest
 * outcome, and it has to happen before the first insert because a restore
 * cannot be rolled back.
 *
 * Counting rather than trusting `count(*)` from the archive is deliberate: the
 * archive describes what WAS, and the only number that matters here is what IS.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';

/**
 * A client shaped like the one `SupabaseAdminService` hands out.
 *
 * The counts have to come from the database that is about to be written to, not from this one, or
 * the "is it already occupied" answer describes the wrong instance entirely.
 */
export type PreflightClient = ReturnType<SupabaseAdminService['getClient']>;
import { tableEntry } from '../registry/component-registry';
import type { ComponentTable } from '../registry/component-registry';

export interface DestinationCheck {
  table: string;
  liveRowCount: number;
  empty: boolean;
  /** Set when the count could not be taken at all. Never treated as "empty". */
  error?: string;
  /**
   * False when a space was chosen but this count could not be narrowed to it.
   *
   * The count then describes the whole organization while the run will only write into one space,
   * so the two are answering different questions. Recorded rather than hidden: a disagreement
   * between what preflight measured and what the writer will do should be visible, and the
   * alternative — turning an embed the database rejected into a blocked restore — would fail every
   * per-space run over a query detail the operator cannot act on.
   */
  spaceNarrowed?: boolean;
}

export interface DestinationReport {
  checks: DestinationCheck[];
  /** Tables that already hold rows. */
  occupied: string[];
  /** Tables whose count failed. Always blocking — an unknown count is not zero. */
  unknown: string[];
  /**
   * True when every destination is empty.
   *
   * This is a statement about emptiness, NOT the gate on the run. `resolveRestoreSet` decides that,
   * because occupancy means different things for a table the operator chose and for a parent that
   * only has to exist. A count that FAILED is fatal either way.
   */
  canProceed: boolean;
}

@Injectable()
export class RestorePreflightService {
  private readonly logger = new Logger(RestorePreflightService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Counts what the destination already holds for each table.
   *
   * A table that cannot be counted is reported as `unknown` and blocks the
   * restore. Treating a failed count as zero is how a restore overwrites live
   * data it never saw — the one outcome this whole check exists to prevent.
   */
  async checkDestination(
    organizationId: string,
    tables: string[],
    client?: PreflightClient,
    spaceId?: string,
  ): Promise<DestinationReport> {
    const checks: DestinationCheck[] = [];

    for (const table of tables) {
      checks.push(await this.countOne(organizationId, table, client, spaceId));
    }

    const occupied = checks
      .filter((c) => !c.error && !c.empty)
      .map((c) => c.table);
    const unknown = checks.filter((c) => c.error).map((c) => c.table);

    return {
      checks,
      occupied,
      unknown,
      canProceed: occupied.length === 0 && unknown.length === 0,
    };
  }

  /**
   * Rows this organization already has in one table.
   *
   * `head: true` with an exact count asks for the number without transferring a
   * single row, so this stays cheap across a large selection.
   */
  private async countOne(
    organizationId: string,
    table: string,
    client?: PreflightClient,
    spaceId?: string,
  ): Promise<DestinationCheck> {
    const entry = tableEntry(table);

    if (!entry) {
      return {
        table,
        liveRowCount: 0,
        empty: false,
        error: `${table} is not in the backup registry, so its contents cannot be checked.`,
      };
    }

    try {
      const narrowed = await this.runCount(
        entry,
        organizationId,
        table,
        client,
        spaceId,
      );

      // A rejected embed degrades to the count this method took before it could narrow by space,
      // rather than blocking. That is today's behaviour for these tables, so it cannot be a
      // regression — while turning it into `unknown` would block every per-space restore on a
      // query detail. The disagreement is recorded instead.
      if (
        narrowed.error &&
        narrowed.narrowedBySpace &&
        isEmbedError(narrowed.error)
      ) {
        this.logger.warn(
          `Could not narrow the ${table} count to one space (${narrowed.error}); ` +
            'counting the whole organization instead.',
        );

        const whole = await this.runCount(entry, organizationId, table, client);

        if (!whole.error) {
          return {
            table,
            liveRowCount: whole.count,
            empty: whole.count === 0,
            spaceNarrowed: false,
          };
        }
      }

      if (narrowed.error) {
        return {
          table,
          liveRowCount: 0,
          empty: false,
          error: narrowed.error,
        };
      }

      return {
        table,
        liveRowCount: narrowed.count,
        empty: narrowed.count === 0,
        ...(spaceId ? { spaceNarrowed: narrowed.narrowedBySpace } : {}),
      };
    } catch (err) {
      // An exception is not an empty table either.
      this.logger.warn(
        `Could not count ${table} before restore: ${(err as Error).message}`,
      );

      return {
        table,
        liveRowCount: 0,
        empty: false,
        error: (err as Error).message,
      };
    }
  }

  /**
   * One count, narrowed by tenant and — when a space was chosen — by space.
   *
   * Both narrowings may need the same parent embedded, and PostgREST will not accept the same table
   * embedded twice, so they are collected first and emitted as ONE embed selecting both columns.
   * All seven tables that inherit tenancy from a parent inherit their space from the same parent,
   * which the registry spec asserts, so this is the common case rather than a corner.
   *
   * @param spaceId Omit to count the whole organization, which is also the degraded retry.
   */
  private async runCount(
    entry: ComponentTable,
    organizationId: string,
    table: string,
    client?: PreflightClient,
    spaceId?: string,
  ): Promise<{ count: number; error?: string; narrowedBySpace: boolean }> {
    /** Embedded parent -> the columns needed from it. Keyed by table AND fk hint. */
    const embeds = new Map<string, Set<string>>();
    const filters: [string, string][] = [];

    const embed = (parentTable: string, column: string, needed: string) => {
      // The `!column` hint names which foreign key to join on. Without it PostgREST rejects the
      // embed with PGRST201 wherever the parent also points back at the child, which is true of
      // three of the seven parent-scoped tables.
      const key = `${parentTable}!${column}`;

      const columns = embeds.get(key) ?? new Set<string>();

      columns.add(needed);
      embeds.set(key, columns);
    };

    if (entry.tenantColumn) {
      filters.push([entry.tenantColumn, organizationId]);
    } else if (entry.parentScope) {
      // A parent-scoped table has no tenant column of its own, so it is narrowed through an inner
      // embed of its parent — the same mechanism the exporter uses to read it in the first place.
      // Preflight has to agree with the exporter here: a table the exporter can read but preflight
      // cannot is a restore that fails after the archive is already open.
      embed(
        entry.parentScope.parentTable,
        entry.parentScope.column,
        entry.parentScope.parentTenantColumn,
      );
      filters.push([
        `${entry.parentScope.parentTable}.${entry.parentScope.parentTenantColumn}`,
        organizationId,
      ]);
    }

    // Narrowed to the same space the restore is narrowed to, and by the same rule the writer will
    // apply row by row. Without this the question asked is "does this tenant hold any rows at all"
    // while the run would only ever write into one space — so restoring into an empty space of a
    // populated tenant was refused as "already present".
    let narrowedBySpace = false;

    if (spaceId) {
      const scope = entry.spaceScope;

      switch (scope.kind) {
        // Not in any space. Filtering it by one would report every organization-level table as
        // empty and wave through a destination that is not.
        case 'organization':
          break;

        case 'own':
          filters.push([scope.column, spaceId]);
          narrowedBySpace = true;
          break;

        // `spaces` IS the list of spaces: the one row that matters is the one whose id is the space.
        case 'self':
          filters.push(['id', spaceId]);
          narrowedBySpace = true;
          break;

        case 'parent':
          embed(
            scope.scope.parentTable,
            scope.scope.column,
            scope.scope.parentSpaceColumn,
          );
          filters.push([
            `${scope.scope.parentTable}.${scope.scope.parentSpaceColumn}`,
            spaceId,
          ]);
          narrowedBySpace = true;
          break;
      }
    }

    const select = [
      'id',
      ...[...embeds.entries()].map(
        ([key, columns]) => `${key}!inner(${[...columns].join(',')})`,
      ),
    ].join(', ');

    // `head: true` with an exact count asks for the number without transferring a single row.
    let query = (client ?? this.db)
      .from(table)
      .select(select, { count: 'exact', head: true });

    for (const [column, value] of filters) {
      query = query.eq(column, value);
    }

    const { count, error } = await query;

    return {
      count: count ?? 0,
      ...(error ? { error: error.message } : {}),
      narrowedBySpace,
    };
  }
}

/**
 * An error that means the embed itself was rejected, rather than the count failing.
 *
 * PGRST200 is an unknown relationship, PGRST201 an ambiguous one, 42P01 a missing relation. Matched
 * on the message because PostgREST returns the code inside it and the shape the client surfaces
 * varies by version.
 */
function isEmbedError(message: string): boolean {
  return /PGRST200|PGRST201|42P01|could not find a relationship/i.test(message);
}
