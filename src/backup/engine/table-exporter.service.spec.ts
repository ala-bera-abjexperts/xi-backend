/**
 * @fileoverview Tests for the table reader.
 * @module src/backup/engine/table-exporter.service.spec
 *
 * This file exists because the exporter had no tests at all, and the thing that broke was the one
 * thing no test looked at: the shape of the PostgREST `select` string. A parent-scoped table was
 * embedded without naming which foreign key to join on, PostgREST answered 300/PGRST201, and every
 * run that reached `automation_versions` died there. The select string is therefore pinned here as
 * a literal — a comparison that reads as over-specific until you have watched the generic version
 * take out the whole feature.
 *
 * The second property under test is that a short page is never mistaken for a finished table.
 * PostgREST truncates at its row cap with an ordinary 200, so silent incompleteness is the failure
 * mode that matters: an archive missing most of its rows still checksums, still writes a manifest,
 * and is only discovered during a restore.
 */

import {
  BackupTruncationError,
  EXPORT_PAGE_SIZE,
  TableExporterService,
} from './table-exporter.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';

interface Page {
  data: Record<string, unknown>[];
  count?: number;
  error?: { message: string };
}

/** Records every select/filter the exporter issues, and replays scripted pages in order. */
function clientFor(pages: Page[]) {
  const selects: string[] = [];
  const filters: { method: string; args: unknown[] }[] = [];
  let page = 0;

  const from = jest.fn().mockImplementation(() => {
    const chain: Record<string, unknown> = {};

    chain.select = jest.fn().mockImplementation((columns: string) => {
      selects.push(columns);

      return chain;
    });

    for (const method of ['eq', 'order', 'gt', 'range']) {
      chain[method] = jest.fn().mockImplementation((...args: unknown[]) => {
        filters.push({ method, args });

        return chain;
      });
    }

    // `limit` is always last, so it is the one that resolves.
    chain.limit = jest.fn().mockImplementation(() => {
      const current = pages[page] ?? { data: [] };

      page += 1;

      return Promise.resolve({
        data: current.data,
        count: current.count ?? current.data.length,
        error: current.error ?? null,
      });
    });

    return chain;
  });

  return {
    service: new TableExporterService({
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService),
    selects,
    filters,
  };
}

/** Drains the generator so the assertions can look at what it asked for. */
async function drain(
  generator: AsyncGenerator<Record<string, unknown>[], unknown>,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];

  for await (const chunk of generator) {
    rows.push(...chunk);
  }

  return rows;
}

/** A page of exactly EXPORT_PAGE_SIZE rows, so the exporter pages again rather than stopping. */
function fullPage(from: number): Record<string, unknown>[] {
  return Array.from({ length: EXPORT_PAGE_SIZE }, (_unused, index) => ({
    id: `id-${from + index}`,
  }));
}

describe('TableExporterService', () => {
  describe('tenant scoping', () => {
    it('selects everything and filters on the table own tenant column', async () => {
      const { service, selects, filters } = clientFor([
        { data: [{ id: 'a' }], count: 1 },
      ]);

      await drain(service.exportTable('tasks', 'org-1', 'organization_id'));

      expect(selects[0]).toBe('*');
      expect(filters[0]).toEqual({
        method: 'eq',
        args: ['organization_id', 'org-1'],
      });
    });

    it('names the foreign key when embedding a parent, so the embed is unambiguous', async () => {
      // The regression. `automations` points back at `automation_versions` through both
      // current_version_id and published_version_id, so three relationships link the two tables and
      // an unhinted embed is rejected outright.
      const { service, selects, filters } = clientFor([
        { data: [{ id: 'a' }], count: 1 },
      ]);

      await drain(
        service.exportTable('automation_versions', 'org-1', null, {
          parentTable: 'automations',
          parentTenantColumn: 'organization_id',
          parentColumn: 'automation_id',
        }),
      );

      expect(selects[0]).toBe(
        '*, automations!automation_id!inner(organization_id)',
      );

      // The hint picks the relationship; it does not rename the embed. The filter still addresses
      // the parent by table name, and `clean` still strips it by table name.
      expect(filters[0]).toEqual({
        method: 'eq',
        args: ['automations.organization_id', 'org-1'],
      });
    });

    it('strips the embedded parent, so the archive holds the table as it exists', async () => {
      // The embed is a join artefact. Leaving it in would put a key in the archive that the table
      // does not have, and the insert restoring that row would fail on the unknown column.
      const { service } = clientFor([
        {
          data: [
            {
              id: 'a',
              automation_id: 'x',
              automations: { organization_id: 'org-1' },
            },
          ],
          count: 1,
        },
      ]);

      const rows = await drain(
        service.exportTable('automation_versions', 'org-1', null, {
          parentTable: 'automations',
          parentTenantColumn: 'organization_id',
          parentColumn: 'automation_id',
        }),
      );

      expect(rows).toEqual([{ id: 'a', automation_id: 'x' }]);
    });

    it('refuses a table with neither a tenant column nor a parent, rather than guessing', async () => {
      // Falling back to organization_id would fail with a 42703; falling back to no filter would
      // read every tenant's rows into one organization's archive.
      const { service } = clientFor([{ data: [] }]);

      await expect(
        drain(service.exportTable('orphan_table', 'org-1', null)),
      ).rejects.toThrow('cannot be exported safely');
    });
  });

  describe('paging', () => {
    it('treats a short first page as the whole table, costing one request', async () => {
      const { service, selects } = clientFor([
        { data: [{ id: 'a' }, { id: 'b' }], count: 2 },
      ]);

      const rows = await drain(
        service.exportTable('tasks', 'org-1', 'organization_id'),
      );

      expect(rows).toHaveLength(2);
      expect(selects).toHaveLength(1);
    });

    it('returns nothing for an empty table without paging further', async () => {
      const { service, selects } = clientFor([{ data: [], count: 0 }]);

      const rows = await drain(
        service.exportTable('tasks', 'org-1', 'organization_id'),
      );

      expect(rows).toHaveLength(0);
      expect(selects).toHaveLength(1);
    });

    it('pages on the ordering key rather than an offset window', async () => {
      const { service, filters } = clientFor([
        { data: fullPage(0), count: EXPORT_PAGE_SIZE + 1 },
        { data: [{ id: 'id-500' }], count: EXPORT_PAGE_SIZE + 1 },
      ]);

      const rows = await drain(
        service.exportTable('tasks', 'org-1', 'organization_id'),
      );

      expect(rows).toHaveLength(EXPORT_PAGE_SIZE + 1);

      // Keyset, not `.range()` — an offset window shifts under concurrent inserts and silently
      // skips or duplicates rows.
      const cursor = filters.find((filter) => filter.method === 'gt');

      expect(cursor).toEqual({
        method: 'gt',
        args: ['id', `id-${EXPORT_PAGE_SIZE - 1}`],
      });
      expect(filters.some((filter) => filter.method === 'range')).toBe(false);
    });

    it('fails the run when a non-final page comes back short', async () => {
      // The whole point of the reconciliation: a truncated read must abort rather than produce an
      // archive that looks complete and is not.
      const { service } = clientFor([
        { data: fullPage(0), count: EXPORT_PAGE_SIZE + 10 },
        { data: [{ id: 'id-500' }], count: EXPORT_PAGE_SIZE + 10 },
      ]);

      await expect(
        drain(service.exportTable('tasks', 'org-1', 'organization_id')),
      ).rejects.toThrow(BackupTruncationError);
    });
  });

  describe('failures', () => {
    it('names the table in a read failure, so the run says where it died', async () => {
      const { service } = clientFor([
        {
          data: [],
          error: {
            message: 'Could not embed because more than one relationship',
          },
        },
      ]);

      await expect(
        drain(
          service.exportTable(
            'automation_versions',
            'org-1',
            'organization_id',
          ),
        ),
      ).rejects.toThrow('Failed to read automation_versions');
    });

    it('refuses a table with no ordering key, which cannot be paged deterministically', async () => {
      const { service } = clientFor([{ data: [] }]);

      await expect(
        drain(
          service.exportTable(
            'tasks',
            'org-1',
            'organization_id',
            undefined,
            [],
          ),
        ),
      ).rejects.toThrow('no ordering key');
    });
  });
});
