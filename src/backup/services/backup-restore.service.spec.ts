/**
 * @fileoverview Tests for the restore run lifecycle.
 * @module src/backup/services/backup-restore.service.spec
 *
 * What matters here is what CANNOT be started. A restore cannot be rolled back, so every guard that
 * stops one from beginning is worth more than anything that happens after it does.
 *
 * The exception is the report at the end, which is covered just as closely for the opposite reason:
 * it is the only account of what a restore did, and a report that names a row wrongly is worse than
 * one that admits it cannot name it at all.
 */

import { BadRequestException, ConflictException } from '@nestjs/common';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { ArchiveReaderService } from '../engine/archive-reader.service';
import type { RestorePreflightService } from '../engine/restore-preflight.service';
import type { RestoreTableWriterService } from '../engine/restore-table-writer.service';
import type { BackupArchivesService } from './backup-archives.service';
import type { RestoreDestinationsService } from './restore-destinations.service';
import type { RestoreApprovalsService } from './restore-approvals.service';
import type { RestoreEntityMapService } from './restore-entity-map.service';
import type { RestoreArchiveCacheService } from '../engine/restore-archive-cache.service';
import {
  BackupRestoreService,
  type RestoreRecordRow,
} from './backup-restore.service';

const ORG = '9de67ec3-1111-2222-3333-444444444444';
const OTHER_ORG = 'cecb176b-9999-8888-7777-666666666666';
const USER = '11111111-2222-3333-4444-555555555555';

interface Scripted {
  /** Rows the in-flight probe finds. */
  inFlight?: { id: string }[];
  /** The row `getRun` resolves to. */
  run?: Record<string, unknown> | null;
  /** Rows captured by insert, in order. */
  inserted?: Record<string, unknown>[];
  /** Patches captured by update, in order — how a run's status transitions are observed. */
  updates?: Record<string, unknown>[];
  /** The approval `findUsableApproval` resolves to. Absent means there is none, which is the default. */
  approval?: Record<string, unknown> | null;
  /** The report records one page of `listRecords` reads. */
  records?: RestoreRecordRow[];
  /**
   * What the destination holds, by table — everything `fetchLiveRows` can find.
   *
   * A table absent from here holds nothing, which is how both "the parent was never restored" and
   * "the row is gone" are said: the labeller cannot tell those apart either, and must not.
   */
  live?: Record<string, Record<string, unknown>[]>;
  /** Every table `from()` was asked for, in order — how a needless round trip is observed. */
  reads?: string[];
}

/**
 * The rows a table answers with.
 *
 * Kept per table rather than as one list because naming a record reads a child, its parent and its
 * grandparent from three different tables in a single call, and a shared list would let a row be
 * found under a table it does not belong to — which is the one mistake a tenant-scoped lookup must
 * never make look correct.
 */
function rowsFor(scripted: Scripted, table: string): unknown[] {
  if (table === 'restore_runs') {
    return scripted.inFlight ?? [];
  }

  if (table === 'restore_run_records') {
    return scripted.records ?? [];
  }

  return scripted.live?.[table] ?? [];
}

/**
 * A Supabase double covering only what this service touches.
 *
 * `select()` is thenable so `await from(...).select(...)` resolves, while still chaining `.eq`,
 * `.in`, `.limit`, `.order` and `.maybeSingle` the way the real builder does.
 */
function clientFor(scripted: Scripted) {
  const inserted = scripted.inserted ?? [];
  const updates = scripted.updates ?? [];
  const reads = scripted.reads ?? [];

  const from = jest.fn().mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};

    // Recorded before anything narrows it, so a test can assert that a table was never asked about
    // at all. "Did not read it" is a real behaviour here: an already-named page must cost nothing.
    reads.push(table);

    // Mutable, and read lazily by the thenable below, so `.neq` genuinely narrows the result the
    // way PostgREST does. A no-op `.neq` would let the in-flight probe's self-exclusion look
    // correct in a test while doing nothing against the real database.
    let rows: unknown[] = rowsFor(scripted, table);

    const thenable = {
      then: (resolve: (value: unknown) => unknown) =>
        // `count` beside `data`, because a paged read asks the same builder for both and takes the
        // count from the half that carries `head: true`.
        Promise.resolve({ data: rows, error: null, count: rows.length }).then(
          resolve,
        ),
    };

    chain.select = jest.fn().mockReturnValue(chain);
    chain.eq = jest.fn().mockReturnValue(chain);
    chain.neq = jest
      .fn()
      .mockImplementation((column: string, value: unknown) => {
        rows = rows.filter(
          (row) => (row as Record<string, unknown>)[column] !== value,
        );

        return chain;
      });
    chain.in = jest.fn().mockReturnValue(chain);
    chain.or = jest.fn().mockReturnValue(chain);
    chain.order = jest.fn().mockReturnValue(chain);
    chain.limit = jest.fn().mockReturnValue(chain);
    chain.range = jest.fn().mockReturnValue(chain);
    chain.update = jest.fn().mockImplementation((patch: unknown) => {
      updates.push(patch as Record<string, unknown>);

      return chain;
    });
    chain.maybeSingle = jest
      .fn()
      .mockResolvedValue({ data: scripted.run ?? null, error: null });
    chain.single = jest
      .fn()
      .mockResolvedValue({ data: { id: 'new-run' }, error: null });
    chain.insert = jest.fn().mockImplementation((row: unknown) => {
      inserted.push(row as Record<string, unknown>);

      return chain;
    });
    chain.then = thenable.then;

    return chain;
  });

  return { getClient: () => ({ from }) } as unknown as SupabaseAdminService;
}

/**
 * The archive cache, stubbed out.
 *
 * It only ever accelerates a restore — a miss means download from the target, which is what these
 * tests exercise. `fetch` returning null therefore keeps every existing case on exactly the path it
 * was written for.
 */
/**
 * A cache that never has anything, which is the case these tests care about: every one of them is
 * about what a restore does, and a miss is what makes it take the path they assert on.
 *
 * `lookup` returning null is the whole contract — the restore then downloads from the target exactly
 * as it did before the cache existed.
 */
function archiveCacheDouble() {
  return {
    lookup: jest.fn().mockResolvedValue(null),
    open: jest.fn().mockResolvedValue(null),
    verifyPassphrase: jest.fn().mockResolvedValue(undefined),
    fetchLegacy: jest.fn().mockResolvedValue(null),
    store: jest.fn().mockResolvedValue(false),
    discard: jest.fn().mockResolvedValue(undefined),
    discardLegacy: jest.fn().mockResolvedValue(undefined),
  } as unknown as RestoreArchiveCacheService;
}

/** The service with every collaborator stubbed — none of them run in these tests. */
function serviceWith(scripted: Scripted) {
  return new BackupRestoreService(
    clientFor(scripted),
    {
      openForDownload: jest.fn().mockRejectedValue(new Error('not reached')),
    } as unknown as BackupArchivesService,
    { open: jest.fn() } as unknown as ArchiveReaderService,
    { checkDestination: jest.fn() } as unknown as RestorePreflightService,
    { restoreTable: jest.fn() } as unknown as RestoreTableWriterService,
    { resolve: jest.fn() } as unknown as RestoreDestinationsService,
    approvalsDouble(scripted),
    // Only consulted for a space-changing restore; these tests never make one.
    {
      load: jest.fn().mockResolvedValue(new Map()),
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as RestoreEntityMapService,
    archiveCacheDouble(),
  );
}

/**
 * The approvals service as these tests need it.
 *
 * `findUsableApproval` answers null by default, which is the honest default: a cross-organization
 * restore is refused unless an approval genuinely exists. `scripted.approval` supplies one.
 */
function approvalsDouble(scripted: Scripted) {
  return {
    findUsableApproval: jest.fn().mockResolvedValue(scripted.approval ?? null),
    consume: jest.fn().mockResolvedValue(true),
  } as unknown as RestoreApprovalsService;
}

/**
 * A service whose collaborators all answer, so `execute()` can be driven end to end.
 *
 * `serviceWith` above deliberately stubs `openForDownload` to reject, which stops every one of its
 * tests before the archive is opened. Planning needs the opposite.
 */
function runnableService(
  scripted: Scripted,
  archive: Record<string, unknown>,
  preflight: RestorePreflightService = {
    // Answers for whatever tables it is asked about. Returning an empty `checks` array instead
    // makes every table "could not be checked", which `resolveRestoreSet` treats as blocking — a
    // refusal that would mask the one being tested here.
    checkDestination: jest
      .fn()
      .mockImplementation((_org: string, tables: string[]) => ({
        checks: tables.map((table) => ({
          table,
          liveRowCount: 0,
          empty: true,
        })),
        occupied: [],
        unknown: [],
      })),
  } as unknown as RestorePreflightService,
) {
  return new BackupRestoreService(
    clientFor(scripted),
    {
      openForDownload: jest.fn().mockResolvedValue({ stream: {} }),
    } as unknown as BackupArchivesService,
    {
      open: jest.fn().mockResolvedValue(archive),
    } as unknown as ArchiveReaderService,
    preflight,
    {
      restoreTable: jest.fn().mockResolvedValue({
        table: 'task_comments',
        status: 'succeeded',
        plannedRows: 0,
        insertedRows: 0,
        skippedRows: 0,
        failedRows: 0,
        conflicts: [],
        nulledUserColumns: {},
      }),
    } as unknown as RestoreTableWriterService,
    {
      resolve: jest.fn().mockResolvedValue({
        client: undefined,
        organizationId: ORG,
        isThisInstance: true,
        name: 'This instance',
      }),
    } as unknown as RestoreDestinationsService,
    approvalsDouble(scripted),
    // Only consulted for a space-changing restore; these tests never make one.
    {
      load: jest.fn().mockResolvedValue(new Map()),
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as RestoreEntityMapService,
    archiveCacheDouble(),
  );
}

/** An opened archive as `ArchiveReaderService.open` returns one. */
function archiveWith(manifest: Record<string, unknown> | null) {
  return {
    manifest,
    format: 'ndjson',
    restorableFormat: 'ndjson',
    tables: [{ table: 'task_comments', extension: 'ndjson' }],
    readTable: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

const AWAITING = {
  id: 'dry-1',
  organization_id: ORG,
  mode: 'dry_run',
  status: 'awaiting_confirmation',
  artifact_id: 'artifact-1',
  selection: { target_id: 'target-1', tables: ['task_comments'] },
};

describe('starting a preview', () => {
  it('refuses an empty selection rather than starting an empty run', async () => {
    const service = serviceWith({});

    // "Restored 0 tables" reported as success is how an empty restore passes for a real one.
    await expect(
      service.createDryRun(ORG, USER, {
        targetId: 'target-1',
        artifactId: 'artifact-1',
        tables: [],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses when a restore is already running for this organization', async () => {
    const service = serviceWith({ inFlight: [{ id: 'busy' }] });

    await expect(
      service.createDryRun(ORG, USER, {
        targetId: 'target-1',
        artifactId: 'artifact-1',
        tables: ['tasks'],
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('records the run as a dry run, so nothing can be written under it', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({ inserted });

    await service.createDryRun(ORG, USER, {
      targetId: 'target-1',
      artifactId: 'artifact-1',
      tables: ['task_comments'],
    });

    expect(inserted[0].mode).toBe('dry_run');
    expect(inserted[0].organization_id).toBe(ORG);
  });

  it('never stores the passphrase on the run', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({ inserted });

    await service.createDryRun(ORG, USER, {
      targetId: 'target-1',
      artifactId: 'artifact-1',
      tables: ['task_comments'],
      passphrase: 'correct horse battery staple',
    });

    // A passphrase on a run row is a passphrase in every backup of that table, and in every
    // support export of it.
    expect(JSON.stringify(inserted[0])).not.toContain('correct horse');
  });

  it('remembers what was selected, so apply restores the same thing', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({ inserted });

    await service.createDryRun(ORG, USER, {
      targetId: 'target-1',
      artifactId: 'artifact-1',
      tables: ['task_comments'],
    });

    // Every null is recorded rather than omitted: `apply` re-derives where to write from this
    // object, and an absent key there is indistinguishable from a preview taken before the fields
    // existed. Writing them explicitly makes "this restore chose the default" a stated fact.
    expect(inserted[0].selection).toEqual({
      target_id: 'target-1',
      tables: ['task_comments'],
      destination_id: null,
      expected_organization_id: null,
      target_organization_id: ORG,
      approval_request_id: null,
      space_id: null,
      destination_space_id: null,
      // False rather than absent for the reason above: `apply` reads this to decide whether the
      // identity tables the preview planned are still authorised, and an absent key would have to
      // be guessed at.
      include_identity: false,

      // TRUE by default, unlike every other option here. A per-space configuration has nowhere
      // else to go when a restore folds spaces together — `UNIQUE (organization_id, space_id)`
      // holds one row — so defaulting it off meant that configuration was simply never restored.
      //
      // Recorded rather than defaulted at the point of use: apply reads its answer back out of
      // this object, so a default applied later would see `false` and never fire. An operator who
      // unticks the box sends an explicit `false`, which lands here and is honoured.
      replace_existing_config: true,
    });
  });

  it('honours an explicit request not to replace existing configuration', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({ inserted });

    await service.createDryRun(ORG, USER, {
      targetId: 'target-1',
      artifactId: 'artifact-1',
      tables: ['task_comments'],
      replaceExistingConfig: false,
    });

    expect(
      (inserted[0].selection as Record<string, unknown>)
        .replace_existing_config,
    ).toBe(false);
  });

  /**
   * The organization picker used to change only which organization's spaces were offered. Picking
   * another one left the restore writing into the session's tenant, where every archived row
   * matched nothing, and the run finished green over zero rows written. It is now permitted, but
   * only on consent from the organization being written into.
   */
  it('refuses a restore aimed at another organization with no approval', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({ inserted, approval: null });

    await expect(
      service.createDryRun(ORG, USER, {
        targetId: 'target-1',
        artifactId: 'artifact-1',
        tables: ['task_comments'],
        expectedOrganizationId: 'a-different-organization',
        destinationSpaceId: 'space-1',
      }),
    ).rejects.toThrow(BadRequestException);

    // Refused before anything is recorded, so a request that could never work leaves no run in the
    // history and does not consume the organization's single restore slot.
    expect(inserted).toEqual([]);
  });

  /**
   * With consent, the run records BOTH organizations: the one that owns it and the one it writes
   * into. A run row that cannot say where it wrote is a run nobody can audit afterwards.
   */
  it('allows a restore into another organization on an approval, and records both', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({
      inserted,
      // Also answers the destination-space lookup, which the double returns for any maybeSingle.
      run: { id: 'space-1' },
      approval: {
        id: 'approval-1',
        selection: { destination_space_id: 'space-1' },
      },
    });

    await service.createDryRun(ORG, USER, {
      targetId: 'target-1',
      artifactId: 'artifact-1',
      tables: ['tasks'],
      expectedOrganizationId: 'a-different-organization',
      destinationSpaceId: 'space-1',
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0].target_organization_id).toBe('a-different-organization');
    expect(inserted[0].approval_request_id).toBe('approval-1');
  });

  /**
   * Re-keying is what makes a cross-organization restore possible, and it is also what makes it
   * unrepeatable: every row gets a new id, so the primary-key collision that quietly makes an
   * ordinary restore idempotent never happens. `restore_entity_map` takes over that job and is keyed
   * on (organization, space, table, source id) with a NOT NULL space. Without a destination space
   * there is nothing to key against, and `record` tolerates its own write failures — so the run
   * would look successful while storing no mapping at all, and applying the same archive again
   * would insert a second copy of an entire tenant with nothing able to object.
   */
  it('refuses a cross-organization restore with no destination space', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({
      inserted,
      approval: { id: 'approval-1', selection: {} },
    });

    await expect(
      service.createDryRun(ORG, USER, {
        targetId: 'target-1',
        artifactId: 'artifact-1',
        tables: ['tasks'],
        expectedOrganizationId: 'a-different-organization',
      }),
    ).rejects.toThrow(BadRequestException);

    // Refused before the run row exists, so it cannot hold the organization's restore slot either.
    expect(inserted).toHaveLength(0);
  });

  /**
   * An approval authorises rows landing in a particular space, not merely in an organization.
   * Aiming somewhere else afterwards is a different act and needs a different approval.
   */
  it('refuses a cross-organization restore aimed at an unapproved space', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({
      inserted,
      run: { id: 'space-1' },
      approval: {
        id: 'approval-1',
        selection: { destination_space_id: 'space-1' },
      },
    });

    await expect(
      service.createDryRun(ORG, USER, {
        targetId: 'target-1',
        artifactId: 'artifact-1',
        tables: ['tasks'],
        expectedOrganizationId: 'a-different-organization',
        destinationSpaceId: 'a-space-nobody-approved',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(inserted).toEqual([]);
  });

  it('accepts the session organization stated explicitly', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({ inserted });

    await service.createDryRun(ORG, USER, {
      targetId: 'target-1',
      artifactId: 'artifact-1',
      tables: ['task_comments'],
      expectedOrganizationId: ORG,
    });

    expect(inserted).toHaveLength(1);
    expect(
      (inserted[0].selection as { expected_organization_id: string })
        .expected_organization_id,
    ).toBe(ORG);
  });

  /**
   * A space of another tenant matches no archived row, so `refuseOtherSpace` used to throw every
   * space-scoped row away one at a time and the run still finished green. `scripted.run` is what the
   * double answers `maybeSingle` with for any table, so leaving it unset is "no such space here".
   */
  it('refuses a space that is not in the organization being restored into', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({ inserted });

    await expect(
      service.createDryRun(ORG, USER, {
        targetId: 'target-1',
        artifactId: 'artifact-1',
        tables: ['task_comments'],
        spaceId: 'a-space-of-another-organization',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(inserted).toEqual([]);
  });

  it('accepts a space that is in the organization being restored into', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({ inserted, run: { id: 'space-1' } });

    await service.createDryRun(ORG, USER, {
      targetId: 'target-1',
      artifactId: 'artifact-1',
      tables: ['task_comments'],
      spaceId: 'space-1',
    });

    expect(inserted).toHaveLength(1);
  });

  /**
   * A remote destination's spaces live in the OTHER database, so checking one against this instance
   * would reject the single cross-instance configuration that does work.
   */
  it('does not check the space locally when writing to another instance', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({ inserted });

    await service.createDryRun(ORG, USER, {
      targetId: 'target-1',
      artifactId: 'artifact-1',
      tables: ['task_comments'],
      spaceId: 'a-space-on-the-other-instance',
      destinationId: 'destination-1',
    });

    expect(inserted).toHaveLength(1);
  });
});

describe('applying a preview', () => {
  it('refuses to apply a preview that has not finished', async () => {
    const service = serviceWith({
      run: { ...AWAITING, status: 'planning' },
    });

    await expect(service.apply(ORG, USER, 'dry-1')).rejects.toThrow(
      /is planning, so there is nothing to apply/,
    );
  });

  it('refuses to apply a preview that was refused', async () => {
    const service = serviceWith({ run: { ...AWAITING, status: 'refused' } });

    await expect(service.apply(ORG, USER, 'dry-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  /**
   * Regression. The apply used to reject any preview whose expected organization was not the
   * session's — a rule left over from when a cross-organization restore was refused outright. Once
   * an approval could authorise one, that rule rejected every approved apply with "this preview was
   * aimed at a different organization", which is the entire point of having asked.
   */
  it('applies a preview aimed at another organization when it carries an approval', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({
      inserted,
      run: {
        ...AWAITING,
        selection: {
          target_id: 'target-1',
          tables: ['tasks'],
          target_organization_id: 'a-different-organization',
          approval_request_id: 'approval-1',
        },
      },
    });

    await service.apply(ORG, USER, 'dry-1');

    const merge = inserted.find((row) => row.mode === 'merge');

    expect(merge).toBeDefined();
    expect(merge?.target_organization_id).toBe('a-different-organization');
    expect(merge?.approval_request_id).toBe('approval-1');
  });

  /** The check that remains: aiming elsewhere is fine, doing it without consent is not. */
  it('refuses a preview aimed at another organization with no approval on it', async () => {
    const service = serviceWith({
      run: {
        ...AWAITING,
        selection: {
          target_id: 'target-1',
          tables: ['tasks'],
          target_organization_id: 'a-different-organization',
          approval_request_id: null,
        },
      },
    });

    await expect(service.apply(ORG, USER, 'dry-1')).rejects.toThrow(
      /carries no approval/,
    );
  });

  it('refuses to apply something that is not a preview', async () => {
    // Applying an apply would run the same restore twice.
    const service = serviceWith({
      run: { ...AWAITING, mode: 'merge', status: 'awaiting_confirmation' },
    });

    await expect(service.apply(ORG, USER, 'dry-1')).rejects.toThrow(
      /not a preview/,
    );
  });

  it('links the apply to its preview, which the SQL CHECK requires', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({ run: AWAITING, inserted });

    await service.apply(ORG, USER, 'dry-1', 'pass');

    // restore_runs_requires_dry_run makes apply-without-a-preview impossible at the database. This
    // asserts the service satisfies it rather than relying on the insert failing.
    expect(inserted[0].dry_run_of_id).toBe('dry-1');
    expect(inserted[0].mode).toBe('merge');
  });

  it('carries the preview selection forward rather than taking a new one', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({ run: AWAITING, inserted });

    await service.apply(ORG, USER, 'dry-1', 'pass');

    // Apply takes no table list of its own: what was previewed is what is applied.
    expect(inserted[0].selection).toEqual(AWAITING.selection);
  });

  it('records who confirmed it', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({ run: AWAITING, inserted });

    await service.apply(ORG, USER, 'dry-1', 'pass');

    expect(inserted[0].confirmed_by).toBe(USER);
    expect(inserted[0].confirmed_at).toBeDefined();
  });

  it('does not store the passphrase on the apply run either', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({ run: AWAITING, inserted });

    await service.apply(ORG, USER, 'dry-1', 'correct horse battery staple');

    expect(JSON.stringify(inserted[0])).not.toContain('correct horse');
  });

  it('refuses a preview whose selection was never recorded', async () => {
    const service = serviceWith({
      run: { ...AWAITING, selection: {} },
    });

    await expect(service.apply(ORG, USER, 'dry-1')).rejects.toThrow(
      /did not record what it was going to restore/,
    );
  });

  it('refuses when another restore is already in flight', async () => {
    const service = serviceWith({ run: AWAITING, inFlight: [{ id: 'busy' }] });

    await expect(service.apply(ORG, USER, 'dry-1')).rejects.toThrow(
      ConflictException,
    );
  });

  /**
   * The preview being applied is itself `awaiting_confirmation`, which is an IN_FLIGHT status. An
   * unfiltered probe therefore found the run the caller had just asked to continue and refused it,
   * making apply impossible for every archive in every organization.
   *
   * The double answers the same rows for every `restore_runs` select, so `inFlight` here stands in
   * for "the probe sees the preview" — which is exactly what the real query returned.
   */
  it('applies a preview even though that preview is itself in flight', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = serviceWith({
      run: AWAITING,
      inFlight: [{ id: 'dry-1' }],
      inserted,
    });

    await expect(service.apply(ORG, USER, 'dry-1')).resolves.toEqual({
      id: 'new-run',
    });
    expect(inserted[0]).toMatchObject({
      mode: 'merge',
      dry_run_of_id: 'dry-1',
    });
  });
});

/**
 * The archive's own organization id, and what happens when it has none.
 *
 * This is the regression that shipped: `manifest?.organizationId ?? ''` collapsed "no manifest" into
 * "another tenant's archive", so every archive written before the engine recorded a manifest was
 * refused with a message describing a problem that did not exist. Neither half of the comparison was
 * covered by a test.
 */
describe('deciding which organization an archive belongs to', () => {
  /** Drives the private run body directly — `launch()` is fire-and-forget, so it cannot be awaited. */
  const execute = (service: BackupRestoreService, archiveId = 'artifact-1') =>
    (
      service as unknown as {
        execute: (
          id: string,
          organizationId: string,
          input: Record<string, unknown>,
          dryRun: boolean,
        ) => Promise<void>;
      }
    ).execute(
      'run-1',
      ORG,
      {
        targetId: 'target-1',
        artifactId: archiveId,
        tables: ['task_comments'],
      },
      true,
    );

  it('does not refuse an archive that carries no manifest', async () => {
    const updates: Record<string, unknown>[] = [];
    const service = runnableService({ updates }, archiveWith(null));

    await execute(service);

    // The artifact was already fetched under this organization's scope, so the database record is
    // the authority when the file cannot speak for itself.
    const refusals = updates.filter((patch) => patch.status === 'refused');

    expect(refusals).toEqual([]);
  });

  it('records why a manifest-less archive was accepted, rather than accepting it silently', async () => {
    const inserted: Record<string, unknown>[] = [];
    const service = runnableService({ inserted }, archiveWith(null));

    await execute(service);

    // `recordPlanNotes` inserts an ARRAY of conflict rows in one call, so the captured entry is
    // itself an array — searching the whole capture avoids depending on that shape.
    expect(JSON.stringify(inserted)).toContain('tenant_unprovable');
    expect(JSON.stringify(inserted)).toContain('no organization id of its own');
  });

  it('still refuses an archive whose manifest names a different organization', async () => {
    const updates: Record<string, unknown>[] = [];
    const service = runnableService(
      { updates },
      archiveWith({ organizationId: 'ffffffff-0000-0000-0000-000000000000' }),
    );

    // Applied, not previewed — a preview deliberately reports this instead of refusing.
    await (
      service as unknown as {
        execute: (
          id: string,
          organizationId: string,
          input: Record<string, unknown>,
          dryRun: boolean,
        ) => Promise<void>;
      }
    ).execute(
      'run-1',
      ORG,
      {
        targetId: 'target-1',
        artifactId: 'artifact-1',
        tables: ['task_comments'],
      },
      false,
    );

    const refused = updates.find((patch) => patch.status === 'refused');

    expect(refused).toBeDefined();
    expect(String(refused?.refusal_reason)).toMatch(/different organization/);
  });

  it('accepts an archive whose manifest names this organization', async () => {
    const updates: Record<string, unknown>[] = [];
    const service = runnableService(
      { updates },
      archiveWith({ organizationId: ORG }),
    );

    await execute(service);

    expect(updates.filter((patch) => patch.status === 'refused')).toEqual([]);
  });
});

describe('planning the destination slice', () => {
  it('checks the selected destination space even for cross-organization previews', async () => {
    const checkDestination = jest
      .fn()
      .mockImplementation((_org: string, tables: string[]) => ({
        checks: tables.map((table) => ({
          table,
          liveRowCount: 0,
          empty: true,
        })),
        occupied: [],
        unknown: [],
      }));
    const preflight = {
      checkDestination,
    } as unknown as RestorePreflightService;
    const service = runnableService({}, archiveWith(null), preflight);

    await (
      service as unknown as {
        plan: (
          id: string,
          organizationId: string,
          tables: string[],
          archive: Record<string, unknown>,
          dryRun: boolean,
          client: unknown,
          spaceId: string | undefined,
          targetOrganizationId: string,
          crossOrganization: boolean,
          destinationSpaceId: string,
          includeIdentity: boolean,
        ) => Promise<unknown>;
      }
    ).plan(
      'run-1',
      ORG,
      ['task_comments'],
      archiveWith(null),
      true,
      undefined,
      undefined,
      OTHER_ORG,
      true,
      'space-target',
      false,
    );

    expect(checkDestination).toHaveBeenCalledWith(
      OTHER_ORG,
      ['task_comments'],
      undefined,
      'space-target',
    );
  });
});

/**
 * Naming the rows on the report page.
 *
 * The label is the whole readable surface of a restore: an operator scanning 4 000 skipped rows is
 * looking for a task key, not a uuid. It is also the one number-free thing on the page that can be
 * WRONG rather than merely missing — a comment shown without its task reads as if it belonged to
 * nothing, and the same row rendered differently by the writer and by this page tells the operator
 * that one of the two screens is lying without saying which.
 *
 * So these cover the three ways a name is found (live row, archived payload, parent chain), and the
 * one rule that governs all of them: a stored label may only ever be replaced by a better one.
 */
describe('naming the rows in a report', () => {
  const RUN = { id: 'run-1', organization_id: ORG };

  /** A task in the destination. `key` AND `summary` — the key alone is a lookup instruction. */
  const TASK = {
    id: 'task-1',
    key: 'NEWSPACE-T88',
    summary: 'Vendor onboarding',
  };

  const FORM = { id: 'form-1', name: 'Onboarding Form' };

  /** A submission whose own fields say `submitted`, as every submission's do. */
  const SUBMISSION = {
    id: 'submission-1',
    form_id: 'form-1',
    task_id: 'task-1',
    status: 'submitted',
  };

  const TASK_LABEL = 'NEWSPACE-T88 · Vendor onboarding';
  const SUBMISSION_LABEL = `Onboarding Form · ${TASK_LABEL} · submitted`;

  /** One record as the writer stored it. Only the fields the labeller reads are interesting. */
  function record(over: Partial<RestoreRecordRow>): RestoreRecordRow {
    return {
      id: 1,
      table_name: 'tasks',
      row_pk: 'id=task-1',
      row_label: null,
      outcome: 'restored',
      reason_code: null,
      reason_detail: null,
      archived_row: null,
      live_row: null,
      pass: 1,
      created_at: '2026-08-07T09:00:00.000Z',
      ...over,
    };
  }

  /** The first page of a report — the only door to the labeller. */
  const firstPage = (service: BackupRestoreService) =>
    service.listRecords(ORG, 'run-1', { page: 1, pageSize: 50 });

  /**
   * A RESTORED record stores no copy of its row — the row is live, and a second copy would
   * duplicate tenant data — so the only place a name can come from is the destination itself.
   */
  it('names a restored row from the row now in the destination', async () => {
    const service = serviceWith({
      run: RUN,
      records: [record({ table_name: 'tasks', row_pk: 'id=task-1' })],
      live: { tasks: [TASK] },
    });

    const { records } = await firstPage(service);

    expect(records[0].row_label).toBe(TASK_LABEL);
  });

  /**
   * A row skipped BEFORE it was ever written has no live row to read back, and those are precisely
   * the rows an operator opens the report to ask about. Reading only from the destination left
   * every one of them anonymous while its payload sat on the record carrying the answer.
   */
  it('names a skipped row from its archived payload, which is the only copy left', async () => {
    const service = serviceWith({
      run: RUN,
      records: [
        record({
          table_name: 'tasks',
          row_pk: 'id=task-9',
          outcome: 'skipped',
          reason_code: 'missing_parent',
          archived_row: {
            id: 'task-9',
            key: 'NEWSPACE-T99',
            summary: 'Rejected by the tenant guard',
          },
        }),
      ],
      // Nothing under `tasks`: the row was refused, so the destination never received it.
      live: {},
    });

    const { records } = await firstPage(service);

    expect(records[0].row_label).toBe(
      'NEWSPACE-T99 · Rejected by the tenant guard',
    );
  });

  /**
   * The behaviour the whole method exists for, and the one a null check would have skipped.
   *
   * `buildRowLabel` returns the row's OWN words when the parent was not part of the run — a
   * perfectly non-null `'Looks good to me'` — and restoring `task_comments` without `tasks` is the
   * ordinary result of picking one table, not an edge case. Re-deriving only null labels would
   * freeze every such row at its degraded form forever, with the task sitting in the destination
   * waiting to be read.
   */
  it('upgrades a stored label that is missing the task it belongs to', async () => {
    const service = serviceWith({
      run: RUN,
      records: [
        record({
          table_name: 'task_comments',
          row_pk: 'id=comment-1',
          row_label: 'Looks good to me',
        }),
      ],
      live: {
        task_comments: [
          { id: 'comment-1', task_id: 'task-1', content: 'Looks good to me' },
        ],
        tasks: [TASK],
      },
    });

    const { records } = await firstPage(service);

    expect(records[0].row_label).toBe(`${TASK_LABEL} · Looks good to me`);
  });

  /**
   * Deleting a task must not erase the record of which task a restored comment belonged to.
   *
   * This is the case that makes "only ever an upgrade" a real rule rather than a hopeful comment.
   * The comment still has text of its own, so re-derivation succeeds and returns a NON-NULL
   * `'Looks good to me'` — and a naive `rebuilt ? rebuilt : stored` overwrites with it, silently
   * dropping the very key this method exists to carry. The stored label is the only surviving
   * evidence of the link once the task is gone.
   */
  it('does not strip the task from a stored label when the task has since been deleted', async () => {
    const service = serviceWith({
      run: RUN,
      records: [
        record({
          table_name: 'task_comments',
          row_pk: 'id=comment-1',
          row_label: `${TASK_LABEL} · Looks good to me`,
        }),
      ],
      live: {
        task_comments: [
          { id: 'comment-1', task_id: 'task-1', content: 'Looks good to me' },
        ],

        // The task is gone from the destination. The comment survives it.
        tasks: [],
      },
    });

    const { records } = await firstPage(service);

    expect(records[0].row_label).toBe(`${TASK_LABEL} · Looks good to me`);
  });

  /**
   * The other half of that rule. Re-derivation is allowed to improve a label and never to spend it:
   * a transition whose two statuses have since gone from the destination can say nothing at all
   * about itself — it has no text column, only the ids it joins — so the label written when they
   * were still there is the best answer that will ever exist for that row.
   */
  it('keeps the stored label when the parents can no longer be resolved', async () => {
    const service = serviceWith({
      run: RUN,
      records: [
        record({
          table_name: 'task_status_transitions',
          row_pk: 'id=transition-1',
          row_label: 'To Do · In Progress',
        }),
      ],
      live: {
        task_status_transitions: [
          {
            id: 'transition-1',
            task_id: 'task-1',
            from_status_id: 'status-1',
            to_status_id: 'status-2',
            created_at: '2026-08-01T00:00:00.000Z',
          },
        ],
        // No `task_statuses`: both ends of the join have been deleted since the restore ran.
      },
    });

    const { records } = await firstPage(service);

    expect(records[0].row_label).toBe('To Do · In Progress');
  });

  /** A restored row deleted afterwards has neither source. Its stored label is all there is. */
  it('keeps the stored label when the row itself is gone', async () => {
    const service = serviceWith({
      run: RUN,
      records: [
        record({
          table_name: 'task_comments',
          row_pk: 'id=comment-2',
          row_label: `${TASK_LABEL} · Deleted since the restore`,
        }),
      ],
      // The task is still there; the comment is not, and a restored record carries no payload.
      live: { tasks: [TASK] },
    });

    const { records } = await firstPage(service);

    expect(records[0].row_label).toBe(
      `${TASK_LABEL} · Deleted since the restore`,
    );
  });

  /**
   * `ROW_PARENT_REFS` holds a LIST, and a submission needs both entries: the form says what the
   * record is, the task says what it belongs to. Resolving only the first would silently break the
   * rule the labels are built on — anything related to a task shows the task key.
   */
  it('names a submission after both of its parents, not the first one it finds', async () => {
    const service = serviceWith({
      run: RUN,
      records: [
        record({
          table_name: 'form_builder_submissions',
          row_pk: 'id=submission-1',
        }),
      ],
      live: {
        form_builder_submissions: [SUBMISSION],
        form_builder: [FORM],
        tasks: [TASK],
      },
    });

    const { records } = await firstPage(service);

    expect(records[0].row_label).toBe(SUBMISSION_LABEL);
  });

  /**
   * Two hops, because the report and the writer must describe one row the same way.
   *
   * A delivery hangs off a submission, and a submission is anonymous until its own form and task
   * are resolved. With parents labelled in isolation this page said `form.submitted · delivered`
   * for a row the write path rendered in full — two engines, two answers, and no way for the
   * operator to know which one to believe.
   */
  it('names a delivery through its grandparents, so the page agrees with the writer', async () => {
    const reads: string[] = [];
    const service = serviceWith({
      run: RUN,
      reads,
      records: [
        record({
          id: 1,
          table_name: 'form_builder_webhook_deliveries',
          row_pk: 'id=delivery-1',
          row_label: 'form.submitted · delivered',
        }),
        record({
          id: 2,
          table_name: 'form_builder_webhook_deliveries',
          row_pk: 'id=delivery-2',
          row_label: 'form.submitted · failed',
        }),
      ],
      live: {
        form_builder_webhook_deliveries: [
          {
            id: 'delivery-1',
            submission_id: 'submission-1',
            event: 'form.submitted',
            status: 'delivered',
          },
          {
            id: 'delivery-2',
            submission_id: 'submission-1',
            event: 'form.submitted',
            status: 'failed',
          },
        ],
        form_builder_submissions: [SUBMISSION],
        form_builder: [FORM],
        tasks: [TASK],
      },
    });

    const { records } = await firstPage(service);

    expect(records.map((row) => row.row_label)).toEqual([
      `${SUBMISSION_LABEL} · form.submitted · delivered`,
      `${SUBMISSION_LABEL} · form.submitted · failed`,
    ]);

    // The extra tier is a tier, not a walk: one read per table for the whole page, however many
    // records share an ancestor. Two deliveries pointing at one submission must cost one read.
    expect(
      reads.filter((table) => table === 'form_builder_submissions'),
    ).toHaveLength(1);
    expect(reads.filter((table) => table === 'tasks')).toHaveLength(1);
  });

  /**
   * The cheap path, asserted as a cost rather than only as a value. A page of already-named rows
   * from a table with no parents has nothing to gain from a round trip, and 200 of them would be
   * 200 rows read back to produce the labels the page already had.
   */
  it('leaves an already-named row alone rather than reading it back', async () => {
    const reads: string[] = [];
    const service = serviceWith({
      run: RUN,
      reads,
      records: [
        record({
          table_name: 'tasks',
          row_pk: 'id=task-1',
          row_label: TASK_LABEL,
        }),
      ],
      // Renamed since the restore, so a label that was re-derived would be visibly different.
      live: { tasks: [{ ...TASK, summary: 'Renamed after the restore' }] },
    });

    const { records } = await firstPage(service);

    expect(records[0].row_label).toBe(TASK_LABEL);
    expect(reads).not.toContain('tasks');
  });
});

/**
 * Reclaiming a run whose worker never came back.
 *
 * This path had no tests, and that is exactly how it stayed broken for 66 hours in production: the
 * reclaim wrote `error_class: 'worker_lost'`, a value `restore_runs_error_class_check` forbids, so
 * Postgres refused the UPDATE. supabase-js reports a refused statement through `{ error }` rather
 * than throwing, the return value was discarded, and the method logged success. The run kept its
 * in-flight status and the organization's only restore slot with it, while the list screen showed
 * it as failed — so every later restore died on a unique index that nothing could clear.
 *
 * A mocked client cannot enforce a CHECK constraint, so the constraint is restated here as the set
 * of values the database actually accepts. That is the whole point: it fails if someone invents a
 * new class in TypeScript without adding it to the migration.
 */
describe('BackupRestoreService reclaim', () => {
  /** Exactly what `restore_runs_error_class_check` permits. */
  const ALLOWED_ERROR_CLASSES = [
    'transient',
    'permanent',
    'schema_drift',
    'key_mismatch',
    'privilege',
    'cascade_refusal',
    'conflict',
    'config',
    'crypto',
  ];

  /** Stalled far past ABANDONED_AFTER_MS, so `hasStalled` is unambiguous. */
  const stalledRow = () => ({
    id: 'stuck',
    status: 'downloading',
    selection: { tables: ['tasks'] },
    updated_at: new Date(Date.now() - 66 * 60 * 60 * 1000).toISOString(),
    started_at: null,
    created_at: null,
  });

  const dryRun = (service: BackupRestoreService) =>
    service.createDryRun(ORG, USER, {
      targetId: 'target-1',
      artifactId: 'artifact-1',
      tables: ['tasks'],
    });

  it('reclaims with an error_class the database will accept', async () => {
    const updates: Record<string, unknown>[] = [];

    await dryRun(serviceWith({ inFlight: [stalledRow()], updates }));

    const reclaim = updates.find((patch) => patch.status === 'failed');

    expect(reclaim).toBeDefined();
    expect(ALLOWED_ERROR_CLASSES).toContain(reclaim?.error_class);
  });

  /**
   * A double whose UPDATE is refused and whose INSERT can be given a Postgres code, which the
   * shared one cannot express — it answers success to everything.
   */
  function failingClient(options: {
    updateError?: { message: string };
    insertError?: { message: string; code?: string };
    inFlight?: Record<string, unknown>[];
  }) {
    const from = jest.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      const rows = options.inFlight ?? [];

      let refused = false;

      chain.select = jest.fn().mockReturnValue(chain);
      chain.eq = jest.fn().mockReturnValue(chain);
      chain.neq = jest.fn().mockReturnValue(chain);
      chain.in = jest.fn().mockReturnValue(chain);
      chain.or = jest.fn().mockReturnValue(chain);
      chain.order = jest.fn().mockReturnValue(chain);
      chain.limit = jest.fn().mockReturnValue(chain);
      chain.range = jest.fn().mockReturnValue(chain);
      chain.maybeSingle = jest
        .fn()
        .mockResolvedValue({ data: null, error: null });

      chain.update = jest.fn().mockImplementation(() => {
        refused = Boolean(options.updateError);

        return chain;
      });

      chain.insert = jest.fn().mockReturnValue(chain);

      chain.single = jest
        .fn()
        .mockResolvedValue(
          options.insertError
            ? { data: null, error: options.insertError }
            : { data: { id: 'new-run' }, error: null },
        );

      chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(
          refused
            ? { data: null, error: options.updateError, count: 0 }
            : { data: rows, error: null, count: rows.length },
        ).then(resolve);

      return chain;
    });

    return { getClient: () => ({ from }) } as unknown as SupabaseAdminService;
  }

  function serviceOn(client: SupabaseAdminService) {
    return new BackupRestoreService(
      client,
      {
        openForDownload: jest.fn().mockRejectedValue(new Error('not reached')),
      } as unknown as BackupArchivesService,
      { open: jest.fn() } as unknown as ArchiveReaderService,
      { checkDestination: jest.fn() } as unknown as RestorePreflightService,
      { restoreTable: jest.fn() } as unknown as RestoreTableWriterService,
      { resolve: jest.fn() } as unknown as RestoreDestinationsService,
      {
        findUsableApproval: jest.fn().mockResolvedValue(null),
        consume: jest.fn().mockResolvedValue(true),
      } as unknown as RestoreApprovalsService,
      {
        load: jest.fn().mockResolvedValue(new Map()),
        record: jest.fn().mockResolvedValue(undefined),
      } as unknown as RestoreEntityMapService,
      archiveCacheDouble(),
    );
  }

  it('keeps a run blocking when its reclaim was refused', async () => {
    // The slot is still held, so the honest answer is the conflict — not a pass through to an
    // insert that the database is certain to reject with a constraint name.
    const service = serviceOn(
      failingClient({
        inFlight: [stalledRow()],
        updateError: { message: 'violates check constraint' },
      }),
    );

    await expect(dryRun(service)).rejects.toThrow(ConflictException);
  });

  it('turns a duplicate-active-restore insert into a conflict, never a raw constraint name', async () => {
    const service = serviceOn(
      failingClient({
        insertError: {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "restore_runs_one_active_per_org"',
        },
      }),
    );

    await expect(dryRun(service)).rejects.toThrow(ConflictException);

    // The index name is an implementation detail; an operator can act on "something else is
    // running" and cannot act on this.
    await expect(dryRun(service)).rejects.not.toThrow(
      /restore_runs_one_active_per_org/,
    );
  });
});

/**
 * Stopping a restore that is already running.
 *
 * The guard that matters is not "does it write cancelled" — it is that a run which has already
 * finished keeps the outcome it actually had. A succeeded restore relabelled as cancelled would
 * misreport what happened to the operator's data, which is the one thing this module exists to
 * never do.
 */
describe('cancelling a restore', () => {
  const inFlightRun = {
    id: 'run-1',
    organization_id: ORG,
    mode: 'merge',
    status: 'restoring',
  };

  it('marks a running restore cancelled and stamps when it stopped', async () => {
    const updates: Record<string, unknown>[] = [];

    const service = serviceWith({
      run: inFlightRun,
      // The row the conditional update matches, i.e. the run was still in flight when it landed.
      inFlight: [{ id: 'run-1' }],
      updates,
    });

    const result = await service.cancelRun(ORG, 'run-1');

    expect(result.status).toBe('cancelled');
    expect(updates[0]).toMatchObject({ status: 'cancelled' });
    expect(updates[0].finished_at).toEqual(expect.any(String));
  });

  it('refuses a restore that has already finished', async () => {
    const updates: Record<string, unknown>[] = [];

    const service = serviceWith({
      run: { ...inFlightRun, status: 'succeeded' },
      updates,
    });

    await expect(service.cancelRun(ORG, 'run-1')).rejects.toThrow(
      /already succeeded/,
    );

    // Nothing written at all: a finished run must not even be touched.
    expect(updates).toHaveLength(0);
  });

  it('does not resurrect a run that finished while the cancel was in flight', async () => {
    // `run` still reads as in flight, but the conditional update matches nothing — which is exactly
    // what happens when the run reaches a terminal status between the read and the write.
    const service = serviceWith({
      run: inFlightRun,
      inFlight: [],
    });

    const result = await service.cancelRun(ORG, 'run-1');

    // Reports what the run actually settled on rather than claiming a cancellation that lost.
    expect(result.status).not.toBe('cancelled');
  });
});

/**
 * Progress while one large table runs.
 *
 * The run row used to change only between tables, so a long table looked dead to the wizard and to
 * the abandoned-run check alike.
 */
describe('progress inside a table', () => {
  interface ProgressPrivate {
    db: { from: jest.Mock };
    reportTableProgress(
      id: string,
      table: string,
      counts: {
        planned: number;
        inserted: number;
        skipped: number;
        failed: number;
      },
      before: {
        planned: number;
        inserted: number;
        skipped: number;
        failed: number;
        conflicts: number;
      },
    ): Promise<void>;
    recordCancelledTotals(
      id: string,
      totals: {
        planned: number;
        inserted: number;
        skipped: number;
        failed: number;
        conflicts: number;
      },
    ): Promise<void>;
  }

  it('records the table counts so far and adds them to the run totals, only while the run is in flight', async () => {
    const updates: Record<string, unknown>[] = [];
    const service = serviceWith({ updates }) as unknown as ProgressPrivate;

    await service.reportTableProgress(
      'run-1',
      'tasks',
      { planned: 500, inserted: 400, skipped: 90, failed: 10 },
      { planned: 883, inserted: 531, skipped: 352, failed: 0, conflicts: 3 },
    );

    expect(updates[0]).toEqual({
      planned_row_count: 500,
      inserted_row_count: 400,
      skipped_row_count: 90,
      failed_row_count: 10,
    });
    expect(updates[1]).toEqual({
      planned_row_count: 1383,
      inserted_row_count: 931,
      skipped_row_count: 442,
      failed_row_count: 10,
      conflict_count: 3,
    });

    // A cancelled or reclaimed run must not be brought back by a late progress report.
    const runChain = service.db.from.mock.results[1].value as {
      in: jest.Mock<unknown, [string, string[]]>;
    };
    const statuses = runChain.in.mock.calls[0][1];

    expect(runChain.in).toHaveBeenCalledWith('status', expect.any(Array));
    expect(statuses).toEqual(expect.arrayContaining(['planning', 'restoring']));
    expect(statuses).not.toContain('cancelled');
    expect(statuses).not.toContain('failed');
  });

  it('writes a cancelled run its final totals without touching its status', async () => {
    const updates: Record<string, unknown>[] = [];
    const service = serviceWith({ updates }) as unknown as ProgressPrivate;

    await service.recordCancelledTotals('run-1', {
      planned: 28_500,
      inserted: 28_947,
      skipped: 434,
      failed: 2,
      conflicts: 5,
    });

    expect(updates).toEqual([
      {
        planned_row_count: 28_500,
        inserted_row_count: 28_947,
        skipped_row_count: 434,
        failed_row_count: 2,
        conflict_count: 5,
      },
    ]);

    const chain = service.db.from.mock.results[0].value as { eq: jest.Mock };

    expect(chain.eq).toHaveBeenCalledWith('status', 'cancelled');
  });
});
