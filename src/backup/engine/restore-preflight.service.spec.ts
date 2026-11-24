/**
 * @fileoverview Tests for the destination-empty check.
 * @module src/backup/engine/restore-preflight.service.spec
 *
 * The property under test is that this check FAILS CLOSED. Archived rows keep
 * their original primary keys, so restoring into a table that already holds data
 * either collides or silently doubles it — and a restore cannot be undone. Every
 * uncertain answer here must therefore block, never wave the restore through.
 */

import { RestorePreflightService } from './restore-preflight.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';

/** Builds a client whose count per table is scripted, including failures. */
function clientFor(counts: Record<string, number | { error: string }>) {
  const from = jest.fn().mockImplementation((table: string) => {
    const scripted = counts[table];
    const chain: Record<string, unknown> = {};

    chain.select = jest.fn().mockReturnValue(chain);
    chain.eq = jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          typeof scripted === 'object'
            ? { count: null, error: { message: scripted.error } }
            : { count: scripted ?? 0, error: null },
        ),
      );

    return chain;
  });

  return { getClient: () => ({ from }) } as unknown as SupabaseAdminService;
}

describe('RestorePreflightService', () => {
  it('lets a restore proceed when every destination table is empty', async () => {
    const service = new RestorePreflightService(
      clientFor({ tasks: 0, task_comments: 0 }),
    );

    const report = await service.checkDestination('org-1', [
      'tasks',
      'task_comments',
    ]);

    expect(report.canProceed).toBe(true);
    expect(report.occupied).toEqual([]);
    expect(report.unknown).toEqual([]);
  });

  it('blocks and names a table that already holds rows', async () => {
    const service = new RestorePreflightService(
      clientFor({ tasks: 126, task_comments: 0 }),
    );

    const report = await service.checkDestination('org-1', [
      'tasks',
      'task_comments',
    ]);

    // Archived rows keep their primary keys, so this would collide or double.
    expect(report.canProceed).toBe(false);
    expect(report.occupied).toEqual(['tasks']);
  });

  it('reports the live count so the refusal is actionable', async () => {
    const service = new RestorePreflightService(clientFor({ tasks: 126 }));

    const report = await service.checkDestination('org-1', ['tasks']);
    const check = report.checks.find((c) => c.table === 'tasks');

    // "tasks is not empty" is not useful; "tasks holds 126 rows" is.
    expect(check?.liveRowCount).toBe(126);
    expect(check?.empty).toBe(false);
  });

  it('BLOCKS when a count fails — an unknown count is not zero', async () => {
    const service = new RestorePreflightService(
      clientFor({ tasks: { error: 'permission denied' } }),
    );

    const report = await service.checkDestination('org-1', ['tasks']);

    // Treating a failed count as empty is how a restore overwrites live data it
    // never saw. This is the single most important assertion in the file.
    expect(report.canProceed).toBe(false);
    expect(report.unknown).toEqual(['tasks']);
    expect(report.checks[0].empty).toBe(false);
  });

  it('never reports a failed count as an empty table', async () => {
    const service = new RestorePreflightService(
      clientFor({ tasks: { error: 'network' } }),
    );

    const report = await service.checkDestination('org-1', ['tasks']);

    expect(report.occupied).not.toContain('tasks');
    expect(report.checks[0].error).toBe('network');
    expect(report.checks[0].empty).toBe(false);
  });

  it('blocks a table that is not in the registry rather than skipping it', async () => {
    const service = new RestorePreflightService(clientFor({}));

    const report = await service.checkDestination('org-1', ['not_a_table']);

    // Silently ignoring an unknown table would let it through unchecked.
    expect(report.canProceed).toBe(false);
    expect(report.unknown).toEqual(['not_a_table']);
  });

  it('narrows a parent-scoped table through its parent, not a tenant column', async () => {
    // fe_versions has no organization_id — it is reached through fe_nodes. A
    // count that ignored that would either error or count every tenant's rows.
    const from = jest.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};

      chain.select = jest.fn().mockReturnValue(chain);
      chain.eq = jest.fn().mockResolvedValue({ count: 0, error: null });

      return chain;
    });

    const service = new RestorePreflightService({
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService);

    await service.checkDestination('org-1', ['fe_versions']);

    const chain = from.mock.results[0].value as {
      select: { mock: { calls: string[][] } };
      eq: { mock: { calls: string[][] } };
    };

    // The FK column is named between the table and `!inner`. fe_nodes points back at fe_versions
    // through current_version_id, so an unhinted `fe_nodes!inner` is ambiguous and PostgREST
    // answers 300/PGRST201 instead of a count.
    expect(chain.select.mock.calls[0][0]).toContain('fe_nodes!node_id!inner');

    // The hint does not rename the embed, so the filter still addresses the parent by table name.
    expect(chain.eq.mock.calls[0][0]).toBe('fe_nodes.organization_id');
  });

  it('checks every table even after one has already failed', async () => {
    const service = new RestorePreflightService(
      clientFor({ tasks: 5, task_comments: 3 }),
    );

    const report = await service.checkDestination('org-1', [
      'tasks',
      'task_comments',
    ]);

    // The operator should see the whole picture in one pass, not fix them singly.
    expect(report.occupied.sort()).toEqual(['task_comments', 'tasks']);
  });
});

/**
 * Narrowing the count to one space.
 *
 * The count has to ask the same question the writer will answer row by row, or the two disagree:
 * counting the whole organization while the run writes into one space is what refused a restore
 * into an empty space of a populated tenant as "already present".
 */
describe('narrowing to one space', () => {
  const SPACE = '4b2eb6d0-bc26-4e3f-83b6-4c717a946eda';

  /**
   * A chainable double that records the select string and every filter applied.
   *
   * Results are scripted per CALL, not per table, because the degrade path queries the same table
   * twice and the whole point of it is that the second attempt succeeds where the first did not.
   */
  function recordingClient(...results: { count?: number; error?: string }[]) {
    const calls: { select: string; filters: [string, string][] }[] = [];

    const from = jest.fn().mockImplementation(() => {
      const seen: { select: string; filters: [string, string][] } = {
        select: '',
        filters: [],
      };

      const attempt = calls.length;

      calls.push(seen);

      const result = results[attempt] ?? results[results.length - 1] ?? {};

      const chain: Record<string, unknown> = {
        select: jest.fn().mockImplementation((select: string) => {
          seen.select = select;

          return chain;
        }),
        eq: jest.fn().mockImplementation((column: string, value: string) => {
          seen.filters.push([column, value]);

          return chain;
        }),
        // Awaited only once every filter has been applied.
        then: (resolve: (value: unknown) => unknown) =>
          resolve(
            result.error
              ? { count: null, error: { message: result.error } }
              : { count: result.count ?? 0, error: null },
          ),
      };

      return chain;
    });

    return {
      service: new RestorePreflightService({
        getClient: () => ({ from }),
      } as unknown as SupabaseAdminService),
      calls,
    };
  }

  it('narrows a table with its own space column', async () => {
    const { service, calls } = recordingClient({ count: 0 });

    await service.checkDestination('org-1', ['tasks'], undefined, SPACE);

    expect(calls[0].filters).toEqual([
      ['organization_id', 'org-1'],
      ['space_id', SPACE],
    ]);
  });

  it('narrows `spaces` to the one row that IS the space', async () => {
    // Without this the count answers "does this tenant have any spaces", which is always yes, so a
    // restore of one space was permanently reported as already present.
    const { service, calls } = recordingClient({ count: 0 });

    await service.checkDestination('org-1', ['spaces'], undefined, SPACE);

    expect(calls[0].filters).toEqual([
      ['organization_id', 'org-1'],
      ['id', SPACE],
    ]);
  });

  it('narrows a parent-scoped table through an embed of its parent', async () => {
    const { service, calls } = recordingClient({ count: 0 });

    await service.checkDestination(
      'org-1',
      ['task_comments'],
      undefined,
      SPACE,
    );

    expect(calls[0].select).toContain('tasks!task_id!inner(');
    expect(calls[0].select).toContain('space_id');
    expect(calls[0].filters).toContainEqual(['tasks.space_id', SPACE]);
  });

  it('emits ONE embed when tenancy and space come from the same parent', async () => {
    // PostgREST will not accept the same table embedded twice. All seven tables that inherit
    // tenancy from a parent inherit their space from that same parent, so the merge is the rule
    // rather than the exception.
    const { service, calls } = recordingClient({ count: 0 });

    await service.checkDestination('org-1', ['fe_versions'], undefined, SPACE);

    expect(calls[0].select.match(/fe_nodes!/g)).toHaveLength(1);
    expect(calls[0].select).toContain('organization_id');
    expect(calls[0].select).toContain('space_id');
    expect(calls[0].filters).toContainEqual(['fe_nodes.space_id', SPACE]);
    expect(calls[0].filters).toContainEqual([
      'fe_nodes.organization_id',
      'org-1',
    ]);
  });

  it('does not narrow an organization-level table', async () => {
    // Site Studio is not in any space. Filtering it by one would report it empty and wave through
    // a destination that is not.
    const { service, calls } = recordingClient({ count: 0 });

    await service.checkDestination(
      'org-1',
      ['site_studio_funnels'],
      undefined,
      SPACE,
    );

    expect(calls[0].filters).toEqual([['organization_id', 'org-1']]);
  });

  it('degrades to the organization-wide count when the embed is rejected', async () => {
    // Today these tables are counted tenant-wide and nothing blocks, so falling back cannot be a
    // regression — while turning a query detail into `unknown` would block every per-space restore.
    const { service, calls } = recordingClient(
      { error: 'PGRST200 could not find a relationship' },
      { count: 0 },
    );

    const report = await service.checkDestination(
      'org-1',
      ['task_comments'],
      undefined,
      SPACE,
    );

    // Tried narrowed, then again without the space.
    expect(calls).toHaveLength(2);
    expect(calls[1].filters).toEqual([['organization_id', 'org-1']]);
    expect(report.unknown).toEqual([]);
    expect(report.checks[0].spaceNarrowed).toBe(false);
  });

  it('still blocks when the count fails for a reason that is not the embed', async () => {
    // Degrading is for a rejected join, not for a database that cannot answer. An unknown count is
    // never zero.
    const { service } = recordingClient({ error: 'connection reset' });

    const report = await service.checkDestination(
      'org-1',
      ['tasks'],
      undefined,
      SPACE,
    );

    expect(report.unknown).toEqual(['tasks']);
    expect(report.canProceed).toBe(false);
  });

  it('leaves an unnarrowed count exactly as it was when no space is chosen', async () => {
    const { service, calls } = recordingClient({ count: 0 });

    await service.checkDestination('org-1', ['tasks']);

    expect(calls[0].filters).toEqual([['organization_id', 'org-1']]);
    expect(calls[0].select).toBe('id');
  });
});
