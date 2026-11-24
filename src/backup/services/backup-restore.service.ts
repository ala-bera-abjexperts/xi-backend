/**
 * @fileoverview The restore run lifecycle — the only writer of the three restore tables.
 * @module src/backup/services/backup-restore.service
 *
 * A restore is always two runs. The first is a dry run: it opens the archive, verifies it, plans
 * against the live destination and writes down exactly what it WOULD do. The second applies that
 * plan, and cannot exist without it — `restore_runs_requires_dry_run` enforces that in SQL, so
 * "apply without previewing" is impossible at the database rather than merely discouraged in code.
 *
 * ## Why the work happens after the response
 *
 * Opening an archive means an SFTP download; applying one means reading and inserting every row.
 * Neither fits inside an HTTP request. The controller gets a run id back immediately and the UI
 * polls it, exactly as backup runs already work.
 *
 * The honest limitation: a backend restart mid-restore leaves the run marked `restoring`, because
 * there is no reaper for restores yet. `worker_id` and `lease_until` are written so one can be added
 * without a migration.
 *
 * ## What this deliberately does not do
 *
 * It does not decrypt, plan, or decide anything about a row. Decryption and passphrase verification
 * are `BackupArchivesService.openForDownload`; what may be restored is `restore-planner.ts`; what a
 * row becomes is `restore-row-preparer.ts`; the writes are `restore-table-writer.service.ts`. This
 * file sequences them and records what happened.
 *
 * The passphrase is never stored. It arrives with the request, lives for the run, and is asked for
 * again on apply — the same contract as the download dialog.
 */

import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  buildRowLabel,
  ROW_PARENT_REFS,
  type ParentLabelLookup,
} from '../registry/row-label-columns';
import { ArchiveReaderService } from '../engine/archive-reader.service';
import type { ArchiveHeader } from '../crypto/archive-cipher';
import {
  type ArchiveIdentity,
  RestoreArchiveCacheService,
} from '../engine/restore-archive-cache.service';
import {
  planRestore,
  resolveRestoreSet,
  type DestinationFact,
  type ResolvedPlan,
} from '../engine/restore-planner';
import { tableEntry } from '../registry/component-registry';
import {
  RestorePreflightService,
  type PreflightClient,
} from '../engine/restore-preflight.service';
import {
  RestoreTableWriterService,
  type RestoreConflictRecord,
  type RestoreRunRecord,
  type WriteClient,
} from '../engine/restore-table-writer.service';
import {
  createRemapState,
  type RemapPlan,
  type RemapState,
} from '../engine/restore-id-remapper';
import { isBackupFileFormat } from '../engine/writers/table-writer';
import { SpaceParentIndex } from '../engine/restore-space-scope';
import type { SpaceParentFallbackClient } from '../engine/restore-space-scope';
import { BackupArchivesService } from './backup-archives.service';
import { RestoreDestinationsService } from './restore-destinations.service';
import { RestoreEntityMapService } from './restore-entity-map.service';
import {
  fingerprintSelection,
  RestoreApprovalsService,
} from './restore-approvals.service';

const RUNS_TABLE = 'restore_runs';
const ITEMS_TABLE = 'restore_run_items';
const CONFLICTS_TABLE = 'restore_conflicts';
const RECORDS_TABLE = 'restore_run_records';

/** Report records per insert request. Same 10 MB body ceiling the writer batches against. */
const RECORD_INSERT_CHUNK = 500;

/**
 * How many refused-reference records `enrichMissingParents` reads to count what a missing component
 * cost.
 *
 * Bounded because this runs on every preview and only needs proportions an operator will act on:
 * "445 rows across 6 tables" and "450 000 rows across 6 tables" lead to the same decision. The per-row
 * detail is already in `restore_run_records` for anyone who wants it.
 *
 * a flat cap, not a GROUP BY — PostgREST cannot aggregate, and an RPC for a warning count
 * is more machinery than the warning is worth. Revisit if a run ever needs an exact total above this.
 */
const MISSING_PARENT_SCAN_LIMIT = 20000;

/**
 * Whether `restore_run_records.references_table` exists in the database yet.
 *
 * FLIP TO `true` THE MOMENT `20260813160000_restore_records_references_table.sql` IS APPLIED, and
 * delete this constant on the next pass through here.
 *
 * It exists because writing a column the schema does not have is not a degraded feature, it is a
 * total outage of a working one: PostgREST rejects the whole INSERT, so EVERY per-row record is lost
 * — a restore then reports "recorded no individual rows" while its table counts look normal, which
 * is precisely the failure this flag now prevents. Code and column have to land together, and until
 * they do the safe half is the one that writes nothing.
 *
 * While false: records are written exactly as they were before this feature, and the per-component
 * skip reporting stays dormant rather than guessing.
 */
const REFERENCES_TABLE_COLUMN_APPLIED = true;

/**
 * Live rows read per table when naming records after the fact.
 *
 * The controller clamps a page to 200 records, so the CHILD fetch cannot exceed that. The PARENT
 * fetch can: a link table names both of its ends, and when both ends are the same table one page of
 * 200 records asks for up to 400 distinct parents — `task_status_transitions` (two columns into
 * `task_statuses`), `asset_item_relations`, `asset_object_references`. At 200 the tail was silently
 * sliced off and roughly half of those rows came back one-sided or unnamed.
 *
 * So: the page clamp times the largest number of refs any one table points at a single parent, plus
 * headroom. Still a backstop against a hand-crafted request rather than a number a real page meets.
 */
const LABEL_LOOKUP_LIMIT = 500;

/**
 * How many table names a "another restore is already running" message spells out.
 *
 * The message exists to tell an operator WHICH restore is in their way, and a forty-table list
 * pasted into an error is unreadable. The remainder is counted rather than dropped — see the call
 * site, which appends "and N more" — so a restore of forty tables can never read as one of five.
 */
const MAX_TABLES_IN_CONFLICT = 5;

/**
 * How many runs keep their per-row records.
 *
 * Runs, items and conflicts are kept forever — they are small and they are the audit trail. Only
 * the records are pruned, because they are the part that carries copies of tenant rows.
 */
const RECORD_RETENTION_RUNS = 20;
const MEMBERS_TABLE = 'organization_members';
const SPACES_TABLE = 'spaces';

type RestoreReportConflictRow = Record<string, unknown>;

interface RestoreRecordFilterQuery<T> {
  eq(column: string, value: unknown): T;
  in(column: string, values: readonly unknown[]): T;
  or(filters: string): T;
}

/**
 * Ceiling on the `tables` filter. A run holds a few hundred tables at most, and the list travels
 * in the query string — an unbounded one is a way to hand PostgREST an arbitrarily long `IN`.
 * Over the cap the filter is dropped rather than truncated: a silently narrowed result is worse
 * than an unnarrowed one, because the caller cannot tell it happened.
 */
const MAX_RECORD_TABLE_FILTER = 200;

/** Statuses that mean a run still holds the organization's single restore slot. */
const IN_FLIGHT = [
  'queued',
  'downloading',
  'decrypting',
  'validating',
  'planning',
  'awaiting_confirmation',
  'restoring',
] as const;

/**
 * How long a working run may sit without progressing before it is treated as abandoned.
 *
 * Restores have no lease and `max_attempts` is 1, so nothing reclaims a run whose worker went away
 * — a deploy, a crash, a dev-server restart mid-download. The run keeps a status like `downloading`
 * for ever, and because that status is IN_FLIGHT it holds the organization's single restore slot:
 * every later attempt is refused with "another restore is already running", naming a run that is
 * never going to finish. Observed exactly that way, stuck 46 minutes with no error and no rows.
 *
 * Thirty minutes is far past any real run here (seconds to a few minutes) and well short of the
 * point where an operator would give up and start deleting rows by hand.
 *
 * `awaiting_confirmation` is deliberately NOT subject to this. It is a finished preview waiting on
 * a person, and a person is allowed to take an afternoon; it already has its own message telling
 * them to apply or discard.
 */
const ABANDONED_AFTER_MS = 30 * 60 * 1000;

/**
 * How often a running restore asks whether it has been cancelled.
 *
 * The check is a database read, and the loop reaches it between every table and every insert batch —
 * on a 169-table restore that is hundreds of reads if left unthrottled, against per-item bookkeeping
 * measured at ~7.5 ms and a whole export that finishes in under four seconds. Two seconds is far
 * below anything an operator perceives as unresponsive and turns those hundreds of reads into a
 * handful.
 */
const CANCEL_CHECK_INTERVAL_MS = 2_000;

/**
 * What a reclaimed run says about itself.
 *
 * Shared by the write and by the in-memory projection in `reclaimStalled`, so the list cannot
 * describe a row in words the database never stored.
 */
/** 118883687 → "113.4 MB". Binary units, matching how every other size in this module reads. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, exponent);

  return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}

const ABANDONED_RUN_MESSAGE =
  'The process running this restore ended before it finished. No further rows were written. ' +
  'Start the restore again.';

/** Conflict rows written per run. One systemic problem must not write a million. */
const MAX_PERSISTED_CONFLICTS = 2_000;

export interface StartRestoreInput {
  targetId: string;
  artifactId: string;
  tables: string[];
  passphrase?: string;
  /** Where to write. Absent means this instance and this organization. */
  destinationId?: string;
  /**
   * The organization the caller believes they are restoring into.
   *
   * Compared against the session and refused on a mismatch — never used to choose a destination.
   * Absent means "no expectation", which is how every run created before this existed behaves.
   */
  expectedOrganizationId?: string;
  /**
   * Restore only rows that were in this space IN THE ARCHIVE.
   *
   * A source filter, not a destination. The two were one field once, and filling it with a space
   * belonging to the organization being restored INTO is what silently discarded every
   * space-scoped row: no archived row could ever carry it.
   */
  spaceId?: string;
  /**
   * The space in the target organization the rows should land in.
   *
   * Only meaningful for a cross-organization restore, where the archived space belongs to a tenant
   * the destination knows nothing about and must be rewritten.
   */
  destinationSpaceId?: string;
  /**
   * The organization the rows are written into. Absent means "the one that owns the run".
   *
   * Resolved from an approval on the server, never taken from the caller — the caller only ever
   * states an expectation, which is checked against the approval.
   */
  targetOrganizationId?: string;
  /** The consent this run proceeds on. Required whenever the target differs from the owner. */
  approvalRequestId?: string;
  /**
   * The preview this apply descends from, when there is one.
   *
   * Only used to find the archive that preview already downloaded, so the backup target is not asked
   * for the same 113 MB twice. Absent on a preview, and on an apply whose preview predates the cache
   * — both simply download.
   */
  dryRunOfId?: string;
  /**
   * Whether identity-tier tables were asked for AND authorised.
   *
   * Authorisation is the controller's — `can_restore_identity` is checked before this is ever set,
   * and re-checked at apply. Absent means "no identity data", which is what every run did before
   * the tier could be picked, so the default path is unchanged.
   */
  includeIdentity?: boolean;

  /**
   * Let per-space configuration in the archive replace the destination's own.
   *
   * Absent means the destination keeps what it has, which is what every run did before this
   * existed — so the default path is unchanged and nothing is overwritten unless it is asked for.
   */
  replaceExistingConfig?: boolean;
}

export interface RestoreRunRow {
  id: string;
  organization_id: string;
  mode: string;
  status: string;
  phase_detail: string | null;

  /**
   * Free-form run options. Carries `archive_cached` when this run's archive is still in the cache,
   * so the UI can offer a download link without minting a signed URL on every poll.
   */
  options?: Record<string, unknown> | null;
  selection: Record<string, unknown>;
  refusal_reason: string | null;
  planned_row_count: number;
  inserted_row_count: number;
  skipped_row_count: number;
  failed_row_count: number;
  conflict_count: number;
  artifact_id: string | null;
  dry_run_of_id: string | null;
  error_class: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;

  /**
   * Last time anything about the run changed — every `setStatus` bumps it.
   *
   * Optional because not every path that builds one of these selects it, but `list()` does: it is
   * the progress heartbeat `hasStalled` reads to tell a slow restore from an abandoned one.
   */
  updated_at?: string | null;

  /**
   * The archive this restore read from, embedded by `list()`.
   *
   * Null when the archive row has been pruned, or on the paths that do not embed it. Present so the
   * report can be organised by backup — a uuid names nothing to the person reading the screen.
   */
  artifact?: {
    remote_path: string;
    byte_size: number | null;
    created_at: string;
  } | null;
}

/**
 * One row of the per-record report, as the API returns it.
 *
 * `row_label` is nullable and is filled in after the fact when the writer could not produce one —
 * see `hydrateMissingLabels`.
 */
export interface RestoreRecordRow {
  id: number;
  table_name: string;
  row_pk: string | null;
  row_label: string | null;
  outcome: string;
  reason_code: string | null;
  reason_detail: string | null;
  /**
   * The table a refused reference pointed at. Null unless the refusal knew one.
   *
   * OPTIONAL, not just nullable: rows are read with `select('*')`, so until
   * `20260813160000_restore_records_references_table.sql` is applied the property is absent rather
   * than null. Typing it as always-present would be a lie the compiler would then help spread.
   */
  references_table?: string | null;
  archived_row: Record<string, unknown> | null;
  live_row: Record<string, unknown> | null;
  pass: number;
  created_at: string;
}

@Injectable()
export class BackupRestoreService {
  private readonly logger = new Logger(BackupRestoreService.name);

  /**
   * Runs whose per-table report could not be written, by run id.
   *
   * Held here rather than passed down because `setItem` is called from several depths and the
   * failure has to reach the one place that finalises the run. Entries are removed as the run ends,
   * so this cannot grow: a run that never reaches the terminal branch has already failed harder than
   * this, and the process holding the set is the one running it.
   */
  private readonly itemUpdateFailures = new Set<string>();

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly archives: BackupArchivesService,
    private readonly reader: ArchiveReaderService,
    private readonly preflight: RestorePreflightService,
    private readonly writer: RestoreTableWriterService,
    private readonly destinations: RestoreDestinationsService,
    private readonly approvals: RestoreApprovalsService,
    private readonly entityMap: RestoreEntityMapService,
    private readonly archiveCache: RestoreArchiveCacheService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Starts a dry run and returns immediately.
   *
   * Nothing is written to the tenant's data by a dry run — it reads the archive, applies every rule
   * and records the counts it would have produced.
   */
  async createDryRun(
    organizationId: string,
    userId: string,
    input: StartRestoreInput,
  ): Promise<{ id: string }> {
    if (!input.tables.length) {
      throw new BadRequestException('Choose at least one table to restore.');
    }

    // Resolved BEFORE the in-flight probe and the insert. A request that cannot succeed must not
    // consume the organization's single restore slot, and must not leave a row in the history
    // describing a run that never started.
    const destination = await this.resolveDestination(organizationId, input);

    // A cross-organization restore with NO destination space recreates the archived spaces.
    //
    // This used to be refused outright, and the reason was `restore_entity_map`. Re-keying mints a
    // fresh id for every row, which destroys the only thing that makes an ordinary restore
    // repeatable — the primary-key collision the second run would otherwise hit — and that table
    // takes over the job. It was keyed on (organization_id, space_id, table_name, source_id) with
    // `space_id` NOT NULL, so without a space there was nothing to record against. `record()`
    // tolerates its own write failures, so such a run would have appeared to succeed while writing
    // no mapping at all, and applying the same archive again would have inserted a second copy of
    // every row with nothing able to object.
    //
    // `space_id` is now nullable, with uniqueness split across two partial indexes so the spaceless
    // half is still deduplicated rather than silently exempt (a plain nullable column under the old
    // constraint would have been exempt — Postgres treats NULLs as distinct). The refusal below is
    // therefore narrower than it was, not removed.
    //
    // What remains refused is a selection that CANNOT land. Recreating means every space-scoped row
    // follows its own space across, and the only thing that can carry a space across is the `spaces`
    // table itself. Left out, `remapRow` refuses those rows one at a time as `unmapped_reference` —
    // a correct answer arrived at far too late, after an approval, an archive read and a dry run.
    // Asked here instead, before the run consumes the organization's single slot.
    //
    // Organization-level tables are exempt because they genuinely need no space: a shared task
    // status or an org-wide custom field is not in one. A space-scoped table holding only
    // organization-level rows (a null space column) also restores fine, but that is a fact about the
    // DATA and cannot be known before reading the archive, so the check stays on the declared scope.
    if (
      destination.targetOrganizationId !== organizationId &&
      !input.destinationSpaceId
    ) {
      // Written as an explicit comparison rather than `?.kind !== 'organization'`, which reads the
      // same and is not: an unknown table gives `undefined`, and `undefined !== 'organization'` is
      // true, so a typo in the selection would demand Spaces for a table nobody can restore. Unknown
      // names are rejected further in; this check should simply have no opinion about them.
      const needsSpaces = input.tables.some((table) => {
        const scope = tableEntry(table)?.spaceScope.kind;

        return scope !== undefined && scope !== 'organization';
      });

      if (needsSpaces && !input.tables.includes('spaces')) {
        throw new BadRequestException(
          'Include Spaces in the selection, or choose a destination space. Restoring into another ' +
            'organization without a destination space recreates the archived spaces there, and the ' +
            'rows that live in a space have nowhere to go unless the spaces come with them.',
        );
      }
    }

    await this.assertNoRunInFlight(organizationId);

    const id = await this.insertRun({
      organization_id: organizationId,
      target_organization_id: destination.targetOrganizationId,
      approval_request_id: destination.approvalRequestId,
      mode: 'dry_run',
      status: 'queued',
      artifact_id: input.artifactId,
      selection: {
        target_id: input.targetId,
        tables: input.tables,
        destination_id: input.destinationId ?? null,
        expected_organization_id: input.expectedOrganizationId ?? null,
        target_organization_id: destination.targetOrganizationId,
        approval_request_id: destination.approvalRequestId,
        space_id: input.spaceId ?? null,
        destination_space_id: input.destinationSpaceId ?? null,
        include_identity: input.includeIdentity ?? false,
        // Defaulted HERE, not at the point of use. This is what the run stores, and apply reads
        // its answer back out of `selection` — so a default applied later sees `false` rather than
        // `undefined` and can never fire. It only ever acts when the restore remaps spaces; a
        // plain same-organization re-run has no remap and is untouched.
        replace_existing_config: input.replaceExistingConfig ?? true,
      },
      destination_id: input.destinationId ?? null,
      // Requested and approved are recorded separately because they answer different questions
      // later: what the operator asked for, and what the permission check allowed. They agree here
      // only because the controller refuses the request outright when they would not.
      identity_restore_requested: input.includeIdentity ?? false,
      identity_restore_approved: input.includeIdentity ?? false,
      created_by: userId,
      max_attempts: 1,
    });

    this.launch(
      id,
      organizationId,
      {
        ...input,
        // Resolved above from the approval, never taken from the request body.
        targetOrganizationId: destination.targetOrganizationId,
        approvalRequestId: destination.approvalRequestId ?? undefined,
      },
      true,
    );

    return { id };
  }

  /**
   * Applies a dry run that has already succeeded.
   *
   * The plan is re-derived from the archive rather than replayed from the preview, so a change to
   * the destination between preview and apply is seen rather than assumed away.
   */
  async apply(
    organizationId: string,
    userId: string,
    dryRunId: string,
    passphrase?: string,
    /**
     * Whether the caller still holds `can_restore_identity`, re-resolved by the controller.
     *
     * Defaults to false so a caller that does not ask the question cannot apply an identity
     * restore by omission — the only way through is to have checked and passed.
     */
    identityAllowed = false,
  ): Promise<{ id: string }> {
    const dryRun = await this.getRun(organizationId, dryRunId);

    if (dryRun.mode !== 'dry_run') {
      throw new BadRequestException(
        'This run is not a preview, so it cannot be applied.',
      );
    }

    if (dryRun.status !== 'awaiting_confirmation') {
      throw new BadRequestException(
        `This preview is ${dryRun.status}, so there is nothing to apply. Run a new preview.`,
      );
    }

    // The preview being applied is itself `awaiting_confirmation`, which is an IN_FLIGHT status —
    // so probing without excluding it made apply refuse every time with "a restore is already in
    // progress", naming the run the caller had just asked to continue.
    await this.assertNoRunInFlight(organizationId, dryRunId);

    const selection = dryRun.selection as {
      target_id?: string;
      tables?: string[];
      destination_id?: string | null;
      expected_organization_id?: string | null;
      target_organization_id?: string | null;
      approval_request_id?: string | null;
      space_id?: string | null;
      destination_space_id?: string | null;
      include_identity?: boolean | null;
      replace_existing_config?: boolean | null;
    };

    // Refused rather than downgraded. Silently dropping the identity tables would apply something
    // other than what the preview described and what the operator confirmed, and the counts they
    // were shown would no longer be the counts they get.
    if (selection.include_identity && !identityAllowed) {
      throw new ForbiddenException(
        'This preview includes identity data — roles, memberships and the like — and you no longer ' +
          'have the "restore identity" permission. Run a new preview without those areas.',
      );
    }

    if (!selection.target_id || !selection.tables?.length) {
      throw new BadRequestException(
        'This preview did not record what it was going to restore, so it cannot be applied.',
      );
    }

    // Defence in depth, re-asked at apply because a preview is confirmed by a person minutes or
    // hours after it was planned.
    //
    // What is checked is that a preview aimed at ANOTHER organization carries the consent that
    // allowed it — NOT that it aims at this one. Aiming elsewhere is the entire point once an
    // approval exists, and comparing the target against the session was a rule left over from when
    // cross-organization restores were refused outright. It rejected every approved apply.
    //
    // Absent target means "this run writes into its own organization", which is every run created
    // before the field existed.
    const applyTarget = selection.target_organization_id ?? organizationId;

    if (applyTarget !== organizationId && !selection.approval_request_id) {
      throw new BadRequestException(
        'This preview writes into another organization but carries no approval, so it cannot be ' +
          'applied. Ask that organization to approve it, then run a new preview.',
      );
    }

    // A cross-organization apply spends its approval here, before a single row is written. One
    // approval authorises one restore; claiming it conditionally on it still being `approved` means
    // two applies racing for the same consent end with exactly one of them holding it.
    if (selection.approval_request_id) {
      const claimed = await this.approvals.consume(
        selection.approval_request_id,
        dryRunId,
      );

      if (!claimed) {
        throw new BadRequestException(
          'The approval for this restore is no longer usable — it may have been withdrawn, or ' +
            'already spent on another restore. Ask for a new one.',
        );
      }
    }

    // Retired BEFORE the merge row is written. `restore_runs_one_active_per_org` is a partial unique
    // index on organization_id that also covers `awaiting_confirmation`, so leaving the preview at
    // that status makes the insert below a duplicate-key error — the second, independent reason an
    // apply could never start. The preview's own work did succeed, which is what this records.
    await this.setStatus(dryRunId, 'succeeded');

    let id: string;

    try {
      id = await this.insertRun({
        organization_id: organizationId,
        // Carried from the preview, never re-supplied: the operator confirmed a destination and a
        // consent, not a fresh choice of either.
        target_organization_id:
          selection.target_organization_id ?? organizationId,
        approval_request_id: selection.approval_request_id ?? null,
        mode: 'merge',
        status: 'queued',
        artifact_id: dryRun.artifact_id,
        destination_id: selection.destination_id ?? null,
        // The SQL CHECK requires this for any non-dry-run row, so an apply can only ever descend
        // from a preview.
        dry_run_of_id: dryRunId,
        selection: dryRun.selection,
        // Carried from the preview, like the destination and the approval above. The check that
        // allowed it has just been re-run against this caller.
        identity_restore_requested: Boolean(selection.include_identity),
        identity_restore_approved: Boolean(selection.include_identity),
        created_by: userId,
        confirmed_by: userId,
        confirmed_at: new Date().toISOString(),
        max_attempts: 1,
      });
    } catch (err) {
      // The preview was retired a moment ago to clear the partial unique index. If the merge row
      // never got written, putting it back is what keeps the operator able to try again — leaving
      // it `succeeded` would strand a preview that was never applied.
      await this.setStatus(dryRunId, 'awaiting_confirmation').catch(
        () => undefined,
      );

      throw err;
    }

    this.launch(
      id,
      organizationId,
      {
        targetId: selection.target_id,
        artifactId: dryRun.artifact_id as string,
        tables: selection.tables,
        passphrase,
        // Carried from the preview so the apply writes where the preview said it would. Re-read
        // rather than re-supplied: the operator confirmed a destination, not a new choice.
        destinationId: selection.destination_id ?? undefined,
        spaceId: selection.space_id ?? undefined,
        destinationSpaceId: selection.destination_space_id ?? undefined,
        targetOrganizationId: selection.target_organization_id ?? undefined,
        approvalRequestId: selection.approval_request_id ?? undefined,
        includeIdentity: Boolean(selection.include_identity),
        replaceExistingConfig: Boolean(selection.replace_existing_config),
        // Lets the apply read the archive the preview cached instead of downloading it again.
        dryRunOfId: dryRunId,
      },
      false,
    );

    return { id };
  }

  /**
   * Runs for this organization, newest first, each carrying the backup it came from.
   *
   * The embed is what lets the report be organised by BACKUP rather than by restore. Two restores
   * an hour apart from the same archive are one story to an operator and two unrelated rows without
   * it — and `artifact_id` on its own is a uuid, which names nothing to the person reading it.
   *
   * A left join, not an inner one: `artifact_id` is nullable, and a restore whose archive row has
   * since been pruned must still appear in its own history rather than silently vanishing.
   */
  async list(organizationId: string, limit = 50): Promise<RestoreRunRow[]> {
    const { data, error } = (await this.db
      .from(RUNS_TABLE)
      .select(
        '*, artifact:backup_artifacts(remote_path, byte_size, created_at)',
      )
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(limit)) as unknown as {
      data: RestoreRunRow[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Failed to list restores: ${error.message}`,
      );
    }

    // Reclaiming only when someone STARTS a restore is too late to be useful: the run sits at
    // `Downloading` on the screen for as long as nobody tries again, which is exactly when an
    // operator is staring at it wondering whether to wait. This list is polled every few seconds,
    // so healing here is what actually clears it.
    return this.reclaimStalled(data ?? []);
  }

  /**
   * Fails any run whose worker never came back, and returns the list already showing that.
   *
   * The returned rows are corrected in memory as well as in the database. Without that the screen
   * would keep showing `Downloading` until the NEXT poll, which reads as the fix not working.
   *
   * Best-effort by construction: `reclaimAbandonedRun` swallows its own errors, and a row that
   * could not be written is still returned unchanged rather than misreported as failed. Listing
   * restores must never fail because a tidy-up did.
   */
  private async reclaimStalled(
    runs: RestoreRunRow[],
  ): Promise<RestoreRunRow[]> {
    const stalled = runs.filter(
      (run) =>
        (IN_FLIGHT as readonly string[]).includes(run.status) &&
        this.hasStalled(run),
    );

    if (!stalled.length) {
      return runs;
    }

    const reclaimed = new Set<string>();

    // Added only when the write actually landed. Marking every attempt reclaimed made this screen
    // report a run as failed while the row was still `downloading` and still holding the
    // organization's restore slot — so the list said the problem was over, and every new restore
    // was refused by the database. A tidy-up that failed must look like one.
    for (const run of stalled) {
      if (await this.reclaimAbandonedRun(run.id)) {
        reclaimed.add(run.id);
      }
    }

    return runs.map((run) =>
      reclaimed.has(run.id)
        ? {
            ...run,
            status: 'failed',
            error_class: 'transient',
            error_message: ABANDONED_RUN_MESSAGE,
            finished_at: new Date().toISOString(),
          }
        : run,
    );
  }

  /**
   * One run with its per-table items and the conflicts it recorded.
   *
   * ## Why the conflicts are read in three queries rather than one
   *
   * This used to be `.order('id').limit(500)` — the first 500 conflicts chronologically. On a run
   * with thousands of duplicates that is 500 rows of "already present, left unchanged" and not one
   * error, because errors are written whenever they happen and duplicates are written constantly.
   * The screen said everything was fine while the failures sat below the cut-off.
   *
   * Sorting by severity does NOT fix it, and is worse than leaving it alone: `severity` is a text
   * column, so `order('severity', { ascending: false })` sorts ALPHABETICALLY and yields
   * warning, info, error — pushing errors to the very end, which is the opposite of the intent.
   * (Ascending happens to give error, info, warning, but relying on alphabetical luck for an
   * ordering that matters is how the next person reintroduces the bug when a severity is added.)
   *
   * Three bounded queries give each severity its own budget, so no severity can be starved by the
   * volume of another. It also needs no index on `severity`, which is unindexed — the two existing
   * indexes are on (restore_run_id, created_at) and (restore_run_id, conflict_class).
   */
  async detail(organizationId: string, id: string) {
    const run = await this.getRun(organizationId, id);

    const conflictsBySeverity = (severity: string, limit: number) =>
      this.db
        .from(CONFLICTS_TABLE)
        .select('*')
        .eq('organization_id', organizationId)
        .eq('restore_run_id', id)
        .eq('severity', severity)
        .order('id', { ascending: true })
        .limit(limit);

    const [
      { data: items },
      { data: errors },
      { data: warnings },
      { data: infos },
      { count: conflictTotal },
    ] = await Promise.all([
      this.db
        .from(ITEMS_TABLE)
        .select('*')
        .eq('organization_id', organizationId)
        .eq('restore_run_id', id)
        .order('dependency_level', { ascending: true }),
      conflictsBySeverity('error', 200),
      conflictsBySeverity('warning', 200),
      conflictsBySeverity('info', 100),
      this.db
        .from(CONFLICTS_TABLE)
        .select('*', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('restore_run_id', id),
    ]);

    // Most severe first, so a truncated render shows the things that need acting on.
    const conflicts = [
      ...((errors ?? []) as RestoreReportConflictRow[]),
      ...((warnings ?? []) as RestoreReportConflictRow[]),
      ...((infos ?? []) as RestoreReportConflictRow[]),
    ];

    return {
      run,
      items: items ?? [],
      conflicts,

      // What the caller is NOT being shown. Without this the UI cannot tell "5 conflicts" from
      // "500 of 12 000 conflicts", and silently presenting the second as the first is the whole
      // class of defect this endpoint keeps producing.
      conflict_total: conflictTotal ?? conflicts.length,
    };
  }

  /**
   * Fires the run without making the caller wait for it.
   *
   * The rejection handler is not optional: an unhandled rejection from a detached promise takes the
   * process down, which would turn one failed restore into an outage.
   */
  private launch(
    id: string,
    organizationId: string,
    input: StartRestoreInput,
    dryRun: boolean,
  ): void {
    void this.execute(id, organizationId, input, dryRun).catch((err: Error) => {
      this.logger.error(`Restore ${id} failed: ${err.message}`, err.stack);
    });
  }

  /** The whole run: open, verify, plan, then write or not. */
  private async execute(
    id: string,
    organizationId: string,
    input: StartRestoreInput,
    dryRun: boolean,
  ): Promise<void> {
    const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;

    await this.setStatus(id, 'downloading', {
      worker_id: workerId,
      started_at: new Date().toISOString(),
      attempt_count: 1,
    });

    let archive: Awaited<ReturnType<ArchiveReaderService['open']>> | null =
      null;

    // Decides whether the archive is worth caching when this run ends: only a run that actually
    // pulled it from the backup target has anything new to store.
    let cameFromCache = false;

    // Captured from the download so the cache can keep the means to re-check the passphrase later.
    // Carries no secret — the data key inside is wrapped. Null for an unencrypted archive.
    let downloadedHeader: ArchiveHeader | null = null;
    let downloadedEncrypted = false;

    // Declared out here because the cache write in `finally` needs it too. Both null until the
    // artifact is read, which is the pre-checksum case the cache treats as "trust it".
    let archiveIdentity: ArchiveIdentity = { sha256: null, byteSize: null };

    try {
      // Reuses the download path in full: the passphrase is verified against the archive header
      // before a byte is transferred, and the recorded encryption state is cross-checked.
      // The size the progress below is measured against. Read from the artifact record rather than
      // the stream, which cannot know its own length. Null is fine — the report then says how much
      // has arrived without claiming to know how much is left, which is still far better than the
      // silence this replaced.
      // `sha256` comes along for the cache: it is what tells a reusable copy from one made before
      // the file on the target was replaced.
      const { data: sized } = (await this.db
        .from('backup_artifacts')
        .select('byte_size, sha256')
        .eq('id', input.artifactId)
        .maybeSingle()) as unknown as {
        data: { byte_size: number | null; sha256: string | null } | null;
      };

      const archiveBytes = sized?.byte_size ?? null;

      archiveIdentity = {
        sha256: sized?.sha256 ?? null,
        byteSize: archiveBytes,
      };

      // Refused BEFORE a byte is transferred.
      //
      // Reading an archive spools the whole file to local disk — a zip keeps its directory at the
      // end, so nothing can be read until all of it has arrived — and the spool limit is therefore
      // only hit at the very end of the download. An archive too large to open was spent on in
      // full, over the network, and only then told it never had a chance. The size is recorded on
      // the artifact, so the answer is knowable up front.
      //
      // A null size means the record predates the column; those are attempted as before, and the
      // spool limit still catches them at the end. Guessing "too big" from an unknown size would
      // refuse archives that are perfectly fine.
      if (archiveBytes !== null && archiveBytes > this.reader.maxArchiveBytes) {
        await this.refuse(
          id,
          `This archive is ${formatBytes(archiveBytes)}, and this server can read archives up to ` +
            `${formatBytes(this.reader.maxArchiveBytes)}. Nothing was downloaded. Raise ` +
            'BACKUP_SPOOL_MAX_BYTES and give the server disk to match, or restore from a smaller ' +
            'archive.',
        );

        return;
      }

      // Read the archive from storage rather than pulling the whole file from the backup target
      // again. A 113 MB archive over SFTP is minutes of transfer, and it was being spent on every
      // run that touched the archive — the preview always, and the apply too unless it descended
      // from that exact preview.
      //
      // Null whenever there is nothing usable to reuse: never cached, expired, or no longer matching
      // the artifact. All of those fall through to the download below, which is what always
      // happened.
      const entry = await this.archiveCache.lookup(
        organizationId,
        input.artifactId,
        archiveIdentity,
      );

      if (entry) {
        // The passphrase is proven against the archive's own stored header before anything is read.
        // `openForDownload` is the only other place it is ever checked, and this path skips it — so
        // without this, holding `can_restore_backups` would be enough to restore an encrypted
        // archive without knowing its passphrase. Refuses the run rather than falling through to the
        // target: a wrong passphrase is a wrong passphrase either way, and downloading 113 MB to say
        // so again would be worse.
        try {
          await this.archiveCache.verifyPassphrase(entry, input.passphrase);
        } catch (err) {
          await this.refuse(id, (err as Error).message);

          return;
        }

        const cached = await this.archiveCache.open(entry);

        if (cached) {
          await this.setStatus(id, 'validating', {
            phase_detail: 'Reading the archive from storage',
          });

          try {
            archive = await this.reader.open(cached, id);
            cameFromCache = true;
          } catch (err) {
            // A cache must never be able to break a restore that would otherwise have worked. A
            // half-written or corrupted object is thrown away and the target is used instead.
            this.logger.warn(
              `Restore ${id}: the cached archive could not be read (${(err as Error).message}), ` +
                'so it was discarded and will be downloaded from the backup target.',
            );
            await this.archiveCache.discard(organizationId, input.artifactId);
          }
        }
      }

      // An apply whose preview cached under the previous run-keyed scheme. Only reachable for a
      // preview/apply pair that was already in flight when artifact keying shipped; it costs one
      // lookup and saves that pair a full re-download.
      if (!archive && input.dryRunOfId) {
        const legacy = await this.archiveCache.fetchLegacy(
          organizationId,
          input.dryRunOfId,
        );

        if (legacy) {
          await this.setStatus(id, 'validating', {
            phase_detail: 'Reading the archive the preview already downloaded',
          });

          try {
            archive = await this.reader.open(legacy, id);
            cameFromCache = true;
          } catch (err) {
            this.logger.warn(
              `Restore ${id}: the preview's cached archive could not be read ` +
                `(${(err as Error).message}), so it will be downloaded from the backup target.`,
            );
          }
        }
      }

      if (!archive) {
        const opened = await this.archives.openForDownload(
          organizationId,
          input.targetId,
          input.artifactId,
          input.passphrase,
        );

        // `decrypted` is true exactly when the archive was encrypted on the target, so it is also
        // the answer to "will a cache hit need the passphrase gate?".
        downloadedHeader = opened.header;
        downloadedEncrypted = opened.decrypted;

        await this.setStatus(id, 'validating');

        // Reported into `phase_detail`, which is a text column that has always existed on a restore
        // run and has always been null. Reading a large archive is the longest silent stretch of a
        // restore — a 113 MB file spent minutes here saying nothing, which reads as a hang and was
        // cancelled by hand three times — and this is the only place that knows how far it has got.
        //
        // Writes are throttled by the reader, and each one is fire-and-forget: progress reporting must
        // never be able to fail the restore it is describing.
        archive = await this.reader.open(opened.stream, id, (progress) => {
          // Named for the work actually being done. These two are wildly different in cost — pulling
          // a 113 MB archive across the world is minutes, opening the zip and indexing its directory
          // is under a second — and calling the transfer "reading" pointed every question about the
          // wait at the wrong step.
          const detail =
            progress.phase === 'downloading'
              ? archiveBytes
                ? `Downloading the archive — ${formatBytes(progress.bytes)} of ${formatBytes(archiveBytes)}`
                : `Downloading the archive — ${formatBytes(progress.bytes)} so far`
              : `Reading the archive — ${progress.tables.length} table(s)`;

          void this.db
            .from(RUNS_TABLE)
            .update({ phase_detail: detail })
            .eq('id', id)
            .then(undefined, () => undefined);
        });
      }

      await this.setStatus(id, 'planning');

      // Resolved before planning, because the counts that decide whether the restore may proceed
      // have to come from the database about to be written to, not from this one.
      const destination = await this.destinations.resolve(
        organizationId,
        input.destinationId ?? null,
      );

      // Writing into a DIFFERENT organization needs every archived id rewritten, and this engine
      // preserves ids by design. Refused rather than attempted: the rows carry the source
      // organization's id, so every one of them would be turned away as a foreign tenant and the
      // run would finish reporting a confident zero.
      //
      // Enforced on the APPLY only. A preview writes nothing, so letting it run is how the operator
      // finds out what a cross-organization restore would involve — refusing at preview would hide
      // the answer behind the question.
      if (!dryRun && destination.organizationId !== organizationId) {
        await this.refuse(
          id,
          'This destination writes into a different organization. The archived rows carry the ' +
            'ids of the organization they came from, and a restore preserves ids rather than ' +
            'rewriting them, so nothing would land where you expect. Restore into the same ' +
            'organization on another instance instead.',
        );

        return;
      }

      // Where the rows are actually going. Absent means this run writes into its own
      // organization, which is every run created before cross-organization restores existed.
      const targetOrganizationId = input.targetOrganizationId ?? organizationId;
      const crossOrganization = targetOrganizationId !== organizationId;

      // The archive's own organization, which is what a moved row must have belonged to. Falls back
      // to the run's owner for archives written before the manifest recorded one — safe because
      // `getArtifact` already scoped the lookup by organization.
      const archiveOrganizationId =
        archive.manifest?.organizationId ?? organizationId;

      /**
       * A move INTO a space within the same organization.
       *
       * The same machinery as a cross-organization restore and for the same reason: the archived
       * rows keep the ids of the rows still living in the space they came from, so writing them
       * anywhere else means minting new ones. `targetOrganizationId` is unchanged here, which is
       * what keeps the tenant check comparing against the right organization.
       */
      const spaceMove = Boolean(!crossOrganization && input.destinationSpaceId);

      /**
       * A cross-organization restore that RECREATES the archived spaces instead of folding onto one.
       *
       * The absence of a destination space IS the mode, rather than a separate flag on the request.
       * That is deliberate and it is safe only because the guard in `createDryRun` made the absence
       * unreachable until now: every cross-organization run that exists today has a space, so no
       * stored request, approval or run row can be re-read as this mode by accident.
       *
       * Same-organization runs are untouched. Without a destination space they are not re-keying
       * anything — the rows go back where they came from, ids and all — which is the one case that
       * has never needed a space and still does not.
       */
      const recreateSpaces = crossOrganization && !input.destinationSpaceId;

      // Seeded so a repeat of the same restore recognises what it already wrote. Read even on a dry
      // run, so the preview reports the same skips the apply will perform — but never WRITTEN by a
      // dry run, or the apply that followed would find everything mapped and restore nothing.
      let alreadyRestored = new Map<string, string>();

      if (crossOrganization || spaceMove) {
        const loaded = await this.entityMap.load(
          targetOrganizationId,
          input.destinationSpaceId ?? null,
          destination.client as never,
        );

        // `load` answers null for a READ FAILURE, which is not the same as "nothing has been
        // restored here yet" — and its own documentation says so. Treating the two alike was a
        // guess in the one direction that cannot be walked back: an empty map means every row is
        // unmapped, so a single transient error on this read would re-key and re-insert an entire
        // space under fresh ids. Refusing the run costs an operator a retry; guessing costs them a
        // duplicated tenant.
        if (!loaded) {
          throw new Error(
            'Could not read what has already been restored into this space, so the restore was ' +
              'stopped before it could write a second copy of anything. Try again.',
          );
        }

        alreadyRestored = loaded;
      }

      const remap =
        crossOrganization || spaceMove
          ? {
              plan: await this.buildRemapPlan(
                id,
                organizationId,
                archiveOrganizationId,
                targetOrganizationId,
                input.destinationSpaceId ?? null,
                recreateSpaces,
              ),
              state: createRemapState(alreadyRestored),
            }
          : undefined;

      /*
       * Identity data does not cross a tenant boundary, and until now nothing on the SERVER said so.
       *
       * `refuseTable` only asks whether identity was approved, never whether this restore is leaving
       * the organization. `remapSpecFor` never looks at `tier` at all, so every identity table is
       * re-keyable and reaches `CROSS_ORG_SUPPORTED_TABLES`. The only thing standing between an
       * approved cross-organization restore and org A's memberships landing in org B was the wizard
       * choosing not to send `include_identity` alongside a foreign destination — a client-side
       * omission, which is not a boundary.
       *
       * Enforced HERE rather than in `refuseTable` deliberately: that function is asserted to agree
       * with the registry's `tableRestoreRefusal`, which is built at module load and cannot know
       * where any particular restore is going. A request-scoped condition inside it would break that
       * mirror. This is the nearest point at which `crossOrganization` and the table list are both
       * in scope, and it runs on dry-run and apply alike because both arrive through here.
       *
       * `refuse`, not `throw`: this runs inside `execute`, which `launch` fires without awaiting and
       * whose only error handling is a log line. Throwing here would leave the run parked in a
       * non-terminal status until the reaper noticed, which reads as a hang rather than a refusal.
       * The operator-facing 400 for this is raised earlier and synchronously, by
       * `RestoreApprovalsService.create` — a cross-organization restore cannot reach here without
       * passing that gate first. This is the backstop for anything that does.
       */
      // Identity across a tenant boundary is now decided by CONSENT rather than refused outright,
      // and the consent is checked before this point: `resolveDestination` requires a live approval
      // whose `selection_fingerprint` matches this selection, and that fingerprint now includes
      // `include_identity`. An approval granted without identity therefore hashes differently from a
      // run that carries it and simply does not match, which is the same refusal this block used to
      // make — except it is made by the thing the owner actually agreed to.
      //
      // The blanket check that stood here is deliberately gone rather than left as belt-and-braces:
      // it refused every cross-organization identity restore unconditionally, so keeping it would
      // have made the approval unhonourable and turned an owner's yes into a silent no.

      const resolved = await this.plan(
        id,
        organizationId,
        input.tables,
        archive,
        dryRun,
        destination.client,
        input.spaceId,
        // Occupancy has to be asked about the tenant being written into, not the one asking.
        targetOrganizationId,
        crossOrganization,
        input.destinationSpaceId,
        input.includeIdentity,
      );

      if (!resolved) {
        return;
      }

      if (dryRun) {
        await this.runTables(id, organizationId, archive, resolved, true, {
          client: destination.client,
          spaceId: input.spaceId,
          targetOrganizationId,
          remap,
          replaceExistingConfig: input.replaceExistingConfig,
        });

        // After the tables run, because it counts what they refused — the whole point is that this
        // is measured rather than predicted. Before `awaiting_confirmation`, because that status is
        // what puts the preview in front of the operator to decide on.
        await this.enrichMissingParents(id, organizationId);

        await this.setStatus(id, 'awaiting_confirmation', {
          finished_at: new Date().toISOString(),
        });

        return;
      }

      await this.setStatus(id, 'restoring');
      await this.runTables(id, organizationId, archive, resolved, false, {
        client: destination.client,
        spaceId: input.spaceId,
        targetOrganizationId,
        remap,
        replaceExistingConfig: input.replaceExistingConfig,
      });

      // Recorded ONLY here, on the applying run, and only for rows that actually landed. A dry run
      // reaches the branch above and returns without ever getting here — were a preview to record,
      // the apply that followed would find every row already mapped and restore nothing at all.
      if (remap?.state.minted.length) {
        const unrecorded = await this.entityMap.record(
          targetOrganizationId,
          input.destinationSpaceId ?? null,
          id,
          remap.state.minted,
          destination.client as never,
        );

        // The rows landed, so this is not a failure — but it is not a clean success either, and the
        // difference matters the next time somebody applies this archive. Those particular rows are
        // no longer recognisable as already-restored, so a repeat would insert them again. Said on
        // the run, where the operator will see it, rather than only in a server log.
        if (unrecorded > 0) {
          await this.setStatus(id, 'partially_completed', {
            finished_at: new Date().toISOString(),
            error_class: 'transient',
            error_message:
              `Everything was restored, but ${unrecorded} row mapping(s) could not be recorded. ` +
              'Applying this archive again would insert those rows a second time — check the ' +
              'destination before repeating this restore.',
          });

          return;
        }
      }
    } catch (err) {
      await this.failRun(id, err as Error);
    } finally {
      // Cache what this run pulled from the backup target, so the next restore of this archive reads
      // it from storage instead of downloading it again.
      //
      // Three conditions, each for its own reason:
      //
      //   - `archive` — nothing to upload if the archive never opened.
      //   - `!cameFromCache` — a run that read from the cache would be re-uploading the bytes it just
      //     read.
      //   - not `cancelled` — spending minutes uploading for a restore the operator stopped is
      //     exactly the wrong trade.
      //
      // A run that FAILED after opening the archive still caches it: the bytes are good, and the
      // retry that follows is precisely who benefits.
      //
      // Cached BEFORE the spool is freed, because the upload streams from that very file.
      const finalStatus = await this.statusOf(id);

      if (archive && !cameFromCache && finalStatus !== 'cancelled') {
        const cached = await this.archiveCache.store({
          organizationId,
          artifactId: input.artifactId,
          localPath: archive.spoolPath,
          isEncrypted: downloadedEncrypted,
          header: downloadedHeader,
          identity: archiveIdentity,
        });

        // Recorded so the UI knows a download link exists without minting a signed URL on every
        // poll. `options` rather than a new column: it is jsonb, it is already on the row, and this
        // is a fact about one run rather than something anything queries across runs.
        //
        // Written on exactly the same runs as before — a preview awaiting confirmation — even though
        // the cache itself is now much broader. This update REPLACES the whole `options` object
        // rather than merging into it, so widening the set of runs it touches would widen an
        // existing bug along with it.
        if (cached && dryRun && finalStatus === 'awaiting_confirmation') {
          await this.db
            .from(RUNS_TABLE)
            .update({ options: { archive_cached: true } })
            .eq('id', id)
            .then(undefined, () => undefined);
        }
      }

      // Frees the spooled copy of the archive. Without it a handful of restores fills the disk.
      await archive?.close();

      // The cached archive is deliberately NOT discarded here.
      //
      // It used to be, because it was keyed by the preview run and therefore useful to exactly one
      // apply. Keyed by artifact it is what the next restore of this backup file reads instead of
      // downloading it again, so deleting it at the end of every restore would mean it never hit.
      // Its lifetime is now the TTL — enforced by `lookup` on the read path and by the reaper — which
      // is what keeps a decrypted archive from lingering indefinitely.
    }
  }

  /**
   * A download link for the archive this restore read, when it is still cached.
   *
   * The archive was already fetched from the backup target once, so offering it from here costs
   * nothing extra and saves an operator going back to the target to see what they just restored
   * from. Null when the run predates the cache, its upload failed, or the object has been cleaned
   * up — the caller shows nothing rather than a link that 404s.
   *
   * Scoped by organization through `getRun`, so one tenant cannot mint a link to another's archive.
   */
  async archiveUrl(
    organizationId: string,
    id: string,
  ): Promise<{ url: string | null }> {
    const run = await this.getRun(organizationId, id);
    const artifactId = run.artifact_id;

    if (artifactId) {
      const url = await this.archiveCache.signedUrl(organizationId, artifactId);

      if (url) {
        return { url };
      }
    }

    // Falls back to the previous run-keyed object, so a link on a run from before artifact keying
    // still resolves while that object is alive. An apply read the preview's copy, so the link
    // belongs to whichever run actually uploaded it.
    const owner = run.dry_run_of_id ?? id;

    return { url: await this.archiveCache.signedUrl(organizationId, owner) };
  }

  /** The current status of a run, or null when it has gone. Used to decide whether to keep a spool. */
  private async statusOf(id: string): Promise<string | null> {
    const { data } = (await this.db
      .from(RUNS_TABLE)
      .select('status')
      .eq('id', id)
      .maybeSingle()) as unknown as { data: { status: string } | null };

    return data?.status ?? null;
  }

  /**
   * Plans the run, or refuses it.
   *
   * @returns The resolved plan, or null when the run has already been marked refused.
   */
  private async plan(
    id: string,
    organizationId: string,
    tables: string[],
    archive: NonNullable<Awaited<ReturnType<ArchiveReaderService['open']>>>,
    dryRun: boolean,
    client?: PreflightClient,
    spaceId?: string,
    targetOrganizationId?: string,
    crossOrganization = false,
    /** Where the rows will land, when the run is moving them into a space they were not in. */
    destinationSpaceId?: string,
    /**
     * Whether `refuseTable()` should let the identity tier through.
     *
     * Defaults to false, so every existing caller and every run created before the tier could be
     * picked plans exactly as it did — identity refused, one refusal per table.
     */
    identityApproved = false,
  ): Promise<ResolvedPlan | null> {
    const manifest = archive.manifest;

    // The format of the member the reader will actually open, NOT what the manifest calls the
    // archive. An archive may hold several layers — `data/00-tasks.sql` beside `data/tasks.ndjson`
    // — and its manifest names only one of them. Deciding from that scalar would refuse a mixed
    // archive whose manifest says `sql` even though the NDJSON layer beside it reads perfectly.
    const format =
      archive.restorableFormat ?? manifest?.format ?? archive.format;

    if (!format || !isBackupFileFormat(format)) {
      await this.refuse(
        id,
        'This archive does not say what format it holds, so it cannot be read back.',
      );

      return null;
    }

    // G3: the planner is pure and never sees the archive, so this is the only place a selected
    // table can be checked against what the file actually holds. Without it a table selected but
    // absent yields zero rows and reports success — "restored 0 rows" passing for a real restore.
    const inArchive = new Set(archive.tables.map((entry) => entry.table));
    const absent = tables.filter((table) => !inArchive.has(table));

    if (absent.length) {
      await this.refuse(
        id,
        `This archive does not contain ${absent.join(', ')}, so ${
          absent.length === 1 ? 'it was' : 'they were'
        } not restored. Choose an archive that holds it, or deselect it.`,
      );

      return null;
    }

    // An archive that names its organization is compared against the session. One that does NOT is
    // a different situation entirely, and used to be collapsed into the same value: `?? ''` never
    // equals a UUID, so every manifest-less archive was reported as belonging to another tenant —
    // a refusal describing a problem that did not exist. Archives written before the worker gained
    // its manifest branch have no `manifest.json` at all, which made them permanently unrestorable.
    //
    // Falling back to the session organization is safe because the archive was already fetched
    // through `getArtifact`, which scopes the lookup by BOTH `organization_id` and `target_id`
    // (`backup-archives.service.ts`). An archive that opens is, by record, this organization's. The
    // real cross-tenant check is unaffected: a genuinely foreign archive carries a manifest naming
    // its own organization, and is still compared and still refused.
    const archiveOrganizationId = manifest?.organizationId ?? organizationId;
    const tenantUnprovable = !manifest?.organizationId;

    // Same derivation as the run that produced this plan, and deliberately the same shape: a
    // cross-organization restore with no destination space is recreating the archived spaces.
    const recreateSpaces = crossOrganization && !destinationSpaceId;

    const plan = planRestore({
      selection: tables,
      availableTables: [...inArchive],
      includeAvailableDependencies: !crossOrganization,
      recreateSpaces,
      format,
      archiveOrganizationId,
      // Remapping makes a foreign archive legitimate — every row is given a new identity and
      // repointed at the destination — so the planner is told the archive matches. Without this it
      // refuses the very restore the approval authorised.
      sessionOrganizationId: crossOrganization
        ? archiveOrganizationId
        : organizationId,
      identityApproved,
      // A preview describes a cross-organization archive instead of refusing it. Nothing is
      // written, and the apply is still stopped by the same comparison.
      previewOnly: dryRun,
    });

    if (!plan.canProceed) {
      await this.refuse(
        id,
        plan.refusals.map((refusal) => refusal.detail).join(' '),
      );

      return null;
    }

    // Accepting an archive whose tenant could not be read from the file is a judgement, so it is
    // stated rather than assumed. Recorded even on an apply, because this is the one fact that
    // separates "trusted the file" from "trusted the database record".
    const notes = [...(plan.notes ?? [])];

    if (tenantUnprovable) {
      notes.push({
        code: 'tenant_unprovable',
        detail:
          'This archive carries no organization id of its own — it was written before the backup ' +
          'engine recorded one. It was accepted because this database lists it as belonging to ' +
          'this organization, but that could not be confirmed from the file itself.',
      });
    }

    await this.recordPlanNotes(id, organizationId, notes);

    const report = await this.preflight.checkDestination(
      targetOrganizationId ?? organizationId,
      plan.tables.map((planned) => planned.table),
      client,
      // The occupancy question has to be asked about the same slice the run will WRITE INTO, which
      // is not always the one it reads from. A restore moving rows into a space asks about the
      // destination; without that it would count the whole organization — 409 tasks against an
      // empty destination space — and refuse the run as "already present".
      destinationSpaceId ?? spaceId,
    );

    const resolved = resolveRestoreSet(
      plan,
      report.checks as DestinationFact[],
      recreateSpaces,
    );

    if (!resolved.canProceed) {
      await this.refuse(
        id,
        resolved.blocked.length
          ? resolved.blocked.map((entry) => entry.detail).join(' ')
          : 'Everything selected is already present, so there is nothing to restore.',
      );

      return null;
    }

    await this.seedItems(id, organizationId, resolved);

    // What the destination already holds. Computed by `resolveRestoreSet` and, until now, discarded.
    await this.recordPlanWarnings(id, organizationId, resolved.warnings);

    // G2: `restore_runs` has no column for a warning list, so the missing parents are written as
    // conflict rows. Every value here sits inside the table's existing CHECK constraints, and they
    // surface in the conflicts list the wizard already renders.
    await this.recordMissingParents(
      id,
      organizationId,
      plan.missingParentComponents,
    );

    return resolved;
  }

  /**
   * Records what the plan allowed through but wants said out loud.
   *
   * Currently one thing: a preview of an archive from another organization. It is written where the
   * wizard already looks, because a preview that came back clean and then an apply that refuses is
   * the sequence an operator has no way to make sense of.
   *
   * Inserted directly rather than through `recordConflicts`, for the same reason
   * `recordMissingParents` is — `RestoreConflictRecord` requires a table name, and this belongs to
   * the run rather than to any one table.
   */
  private async recordPlanNotes(
    id: string,
    organizationId: string,
    notes: { code: string; detail: string }[],
  ): Promise<void> {
    if (!notes.length) {
      return;
    }

    const { error } = await this.db.from(CONFLICTS_TABLE).insert(
      notes.map((note) => ({
        organization_id: organizationId,
        restore_run_id: id,
        conflict_class: 'missing_parent_component',
        severity: 'warning',
        table_name: null,
        resolution: 'skipped',
        detail: note.detail,
        context: { code: note.code },
      })),
    );

    if (error) {
      // Losing the note must not lose the preview.
      this.logger.warn(`Could not record plan notes: ${error.message}`);
    }
  }

  /**
   * Records what the planner already worked out about the destination's current contents.
   *
   * `resolveRestoreSet` produces these warnings — "task_history already holds 127 row(s); rows that
   * are already there are left exactly as they are" — and they used to be computed and dropped on
   * the floor. That is what made a preview read as a promise: it said 127 rows would be added
   * without the sentence explaining that 127 rows are already sitting there, so an apply that added
   * none of them looked like a malfunction rather than the predicted outcome.
   *
   * Deliberately NOT `missing_parent_component`: the wizard routes that class into its missing-parent
   * chips, and an occupancy warning is not a missing parent. Anything else lands in the row-conflict
   * list, which is where this belongs.
   */
  private async recordPlanWarnings(
    id: string,
    organizationId: string,
    warnings: { code: string; table: string; detail: string }[],
  ): Promise<void> {
    if (!warnings.length) {
      return;
    }

    const { error } = (await this.db.from(CONFLICTS_TABLE).insert(
      warnings.map((warning) => ({
        organization_id: organizationId,
        restore_run_id: id,
        conflict_class: warning.code,
        severity: 'info',
        table_name: warning.table,
        resolution: 'skipped',
        detail: warning.detail,
        context: { code: warning.code },
      })),
    )) as unknown as { error: { message: string } | null };

    if (error) {
      // Losing the explanation must not lose the run it explains.
      this.logger.warn(
        `Restore ${id}: could not record plan warnings: ${error.message}`,
      );
    }
  }

  /**
   * Records the parent components this restore is NOT bringing along.
   *
   * A restore now writes exactly what was selected, so a row pointing at something absent is
   * skipped. Saying which parents are missing BEFORE the run turns those skips from a mystery into
   * an expected consequence of the choice.
   */
  private async recordMissingParents(
    id: string,
    organizationId: string,
    components: string[],
  ): Promise<void> {
    if (!components.length) {
      return;
    }

    const { error } = await this.db.from(CONFLICTS_TABLE).insert(
      components.map((component) => ({
        organization_id: organizationId,
        restore_run_id: id,
        conflict_class: 'missing_parent_component',
        severity: 'warning',
        // No single table owns this: it is a statement about the selection as a whole.
        table_name: null,
        resolution: 'skipped',
        detail:
          `${component} is not part of this restore. Rows that refer to something in it will be ` +
          'skipped unless it is already in your database.',
        context: { component },
      })),
    );

    if (error) {
      // Losing the warning must not lose the restore.
      this.logger.warn(
        `Restore ${id}: could not record missing parents: ${error.message}`,
      );
    }
  }

  /**
   * Replace the generic missing-parent warnings with what this run actually measured.
   *
   * `recordMissingParents` writes one warning per component the registry says is absent, and it says
   * the same sentence whether that costs nothing or costs every row selected. Ten of them render
   * identically, which is how a selection that restored zero of 445 rows looked like a normal run.
   *
   * This counts the refusals instead of predicting them. Every row refused for a reference the run
   * could not resolve now records the table it was pointing at (`references_table`, set by the
   * remapper at the moment it refuses), so the component is looked up from the target rather than
   * inferred from `requires` — which declares dependencies that do not exist — or from the generated
   * FK graph — which is missing live constraints. It is also the only approach that survives a
   * polymorphic column, where the target depends on the row's own type.
   *
   * A component with nothing measured against it keeps its quiet generic warning. That is what stops
   * this turning every restore into a wall of blockers: on the run that prompted this, one of the ten
   * had rows behind it.
   *
   * Best-effort throughout. Losing a warning must not lose the restore — the same rule
   * `recordMissingParents` follows.
   */
  private async enrichMissingParents(
    id: string,
    organizationId: string,
  ): Promise<void> {
    // Nothing to count from until the column exists. Checked here rather than left to fail on the
    // query so a preview does not log a warning on every run for a condition that is known and
    // deliberate — see REFERENCES_TABLE_COLUMN_APPLIED.
    if (!REFERENCES_TABLE_COLUMN_APPLIED) {
      return;
    }

    const { data: refused, error: readError } = await this.db
      .from(RECORDS_TABLE)
      .select('table_name, references_table')
      .eq('restore_run_id', id)
      .eq('organization_id', organizationId)
      .eq('outcome', 'skipped')
      .not('references_table', 'is', null)
      .limit(MISSING_PARENT_SCAN_LIMIT);

    if (readError) {
      this.logger.warn(
        `Restore ${id}: could not read refused references: ${readError.message}`,
      );

      return;
    }

    if (!refused?.length) {
      return;
    }

    // component -> (source table -> rows refused because of it)
    const byComponent = new Map<string, Map<string, number>>();

    for (const row of refused as {
      table_name: string;
      references_table: string;
    }[]) {
      const component = tableEntry(row.references_table)?.component;

      if (!component) {
        continue;
      }

      const tables = byComponent.get(component) ?? new Map<string, number>();

      tables.set(row.table_name, (tables.get(row.table_name) ?? 0) + 1);
      byComponent.set(component, tables);
    }

    if (!byComponent.size) {
      return;
    }

    const { data: conflicts, error: conflictError } = await this.db
      .from(CONFLICTS_TABLE)
      .select('id, context')
      .eq('restore_run_id', id)
      .eq('conflict_class', 'missing_parent_component');

    if (conflictError || !conflicts?.length) {
      return;
    }

    for (const conflict of conflicts as {
      id: string;
      context: { component?: string } | null;
    }[]) {
      const component = conflict.context?.component;
      const tables = component ? byComponent.get(component) : undefined;

      if (!component || !tables) {
        continue;
      }

      const affectedTables = [...tables.entries()]
        .map(([table, rows]) => ({ table, rows }))
        .sort((left, right) => right.rows - left.rows);

      const rowsAtRisk = affectedTables.reduce(
        (total, entry) => total + entry.rows,
        0,
      );

      // `detail` is rewritten too, not just `context`, so a client reading only the sentence still
      // gets the number. The shape of `context` stays one row per component — the wizard renders one
      // chip per row off a scalar `context.component`, and changing that cardinality would duplicate
      // the chip per affected table.
      const { error } = await this.db
        .from(CONFLICTS_TABLE)
        .update({
          detail:
            `${component} is not part of this restore. ${rowsAtRisk} row(s) across ` +
            `${affectedTables.length} table(s) were skipped because of it.`,
          context: { component, affectedTables, rowsAtRisk },
        })
        .eq('id', conflict.id);

      if (error) {
        this.logger.warn(
          `Restore ${id}: could not enrich missing parent ${component}: ${error.message}`,
        );
      }
    }
  }

  /** One `restore_run_items` row per table, so the UI can show progress table by table. */
  private async seedItems(
    id: string,
    organizationId: string,
    resolved: ResolvedPlan,
  ): Promise<void> {
    const rows = resolved.tables.map((table) => ({
      organization_id: organizationId,
      restore_run_id: id,
      tier: table.tier,
      component_key: table.component,
      table_name: table.table,
      dependency_level: table.insertLevel,
      pass: 1,
      item_kind: 'table',
      status: 'pending',
    }));

    if (!rows.length) {
      return;
    }

    const { error } = await this.db.from(ITEMS_TABLE).insert(rows);

    if (error) {
      throw new Error(
        `Could not record what this restore is going to do: ${error.message}`,
      );
    }
  }

  /** Walks the tables parents-first, updating each item as it finishes. */
  private async runTables(
    id: string,
    organizationId: string,
    archive: NonNullable<Awaited<ReturnType<ArchiveReaderService['open']>>>,
    resolved: ResolvedPlan,
    dryRun: boolean,
    write: {
      client?: WriteClient;
      spaceId?: string;
      targetOrganizationId?: string;
      remap?: { plan: RemapPlan; state: RemapState };

      /** Let per-space configuration in the archive replace the destination's own. */
      replaceExistingConfig?: boolean;
    } = {},
  ): Promise<void> {
    // Members of the organization being WRITTEN INTO. `users` is a shared table, so a source-org
    // user id in `created_by` satisfies the foreign key in the destination and nothing errors —
    // the destination would quietly hold rows attributed to people who are not its members.
    // Read from the instance that actually holds them. `write.client` is the destination client the
    // writer already uses; without it this asked THIS server for another instance's members and got
    // an empty set back, which reads as "nobody here is a member".
    const knownUsers = await this.loadUsers(
      write.targetOrganizationId ?? organizationId,
      write.client,
    );

    // What this run is re-keying, recorded once before any table is written.
    //
    // It is what lets an unmapped reference be read correctly. A reference into a table THIS run is
    // writing has been given a new id, so no mapping means the row would point back at where it came
    // from. A reference to a table the run is not touching is a different thing entirely: that row
    // never moved and still answers to the archived id, so keeping it is right. Without this the two
    // were indistinguishable, and every reference to a table outside the restore dropped its row.
    if (write.remap) {
      for (const table of resolved.tables) {
        write.remap.state.tablesInRun.add(table.table);
      }
    }

    // One per run, so `tasks` — the space parent of seven tables — is scanned once rather than
    // seven times. Never built for a cross-organization run: there the space is a DESTINATION the
    // rows are moved into, not a filter on which of them qualify.
    const spaceParents =
      write.spaceId && !write.remap
        ? new SpaceParentIndex(
            archive,
            organizationId,
            write.spaceId,
            write.client as SpaceParentFallbackClient | undefined,
          )
        : undefined;

    let planned = 0;
    let inserted = 0;
    let skipped = 0;
    let failed = 0;
    let conflicts = 0;
    let anyFailure = false;

    /**
     * Row labels accumulated across the run, so a child can be named after its parent.
     *
     * One index for the whole run rather than one per table, because that is the point: a form
     * submission is labelled from the form it belongs to, which was restored earlier at a lower
     * dependency level.
     */
    const labelIndex = new Map<string, Map<string, string>>();

    /** Shared by the table loop and the writer's batch loop, so one throttle covers both. */
    const isCancelled = this.cancellationProbe(id);

    let stoppedByCancel = false;

    for (const table of resolved.tables) {
      // Checked BEFORE the item is marked running, so a cancelled run does not leave a table sitting
      // at `running` for ever. Tables never reached keep their initial `pending`, which is the honest
      // record: they were not attempted.
      if (await isCancelled()) {
        stoppedByCancel = true;

        this.logger.log(
          `Restore ${id}: cancelled, stopping before ${table.table}.`,
        );

        break;
      }

      await this.setItem(id, table.table, { status: 'running' });

      const result = await this.writer.restoreTable({
        archive,
        planned: table,
        organizationId,
        knownUsers,
        dryRun,

        // The same probe the loop above uses, so one throttle covers both checkpoints. Without this
        // a cancel could only take effect between tables, which does nothing for the case that
        // actually takes time: a single table holding most of the rows.
        shouldStop: isCancelled,
        onProgress: (counts) =>
          this.reportTableProgress(id, table.table, counts, {
            planned,
            inserted,
            skipped,
            failed,
            conflicts,
          }),
        client: write.client,
        spaceId: write.spaceId,
        spaceParents,
        remap: write.remap,
        labelIndex,

        // Only ever true when the operator ticked it. Read from the run's own selection, so an
        // apply cannot acquire it that its dry run did not preview.
        replaceExistingConfig: write.replaceExistingConfig ?? false,
      });

      planned += result.plannedRows;
      inserted += result.insertedRows;
      skipped += result.skippedRows;
      failed += result.failedRows;
      conflicts += result.conflicts.length;
      anyFailure ||= result.status === 'failed' || result.failedRows > 0;

      await this.setItem(id, table.table, {
        status: result.status,
        planned_row_count: result.plannedRows,
        inserted_row_count: result.insertedRows,
        skipped_row_count: result.skippedRows,
        failed_row_count: result.failedRows,
        error_message: result.errorMessage ?? null,

        // Why nothing was restored, where the counts alone cannot say. Null for a table that
        // restored rows and for one that failed — the first needs no explanation and the second
        // gives its own through `error_message`.
        outcome_reason: result.outcomeReason ?? null,
        finished_at: new Date().toISOString(),
      });

      await this.recordConflicts(id, organizationId, result.conflicts);
      await this.recordRunRecords(id, organizationId, result.records);

      // A cap that was hit is stated, not swallowed. The pre-existing conflict cap dropped rows
      // with no counter and no log, which is why a run with one systemic problem was
      // indistinguishable from a clean one.
      if (result.truncatedConflicts > 0 || result.truncatedRecords > 0) {
        this.logger.warn(
          `Restore ${id}: ${table.table} exceeded report caps — ` +
            `${result.truncatedConflicts} conflict(s) and ${result.truncatedRecords} record(s) not stored`,
        );
      }

      // Counters are rolled up per table rather than at the end, so a run that dies halfway still
      // shows what it managed to do.
      await this.setStatus(id, dryRun ? 'planning' : 'restoring', {
        planned_row_count: planned,
        inserted_row_count: inserted,
        skipped_row_count: skipped,
        failed_row_count: failed,
        conflict_count: conflicts,
      });
    }

    // `setStatus` refuses a cancelled run, so the table it was stopped in never reached the totals.
    await this.recordCancelledTotals(id, {
      planned,
      inserted,
      skipped,
      failed,
      conflicts,
    });

    if (dryRun) {
      return;
    }

    // An apply that read rows and wrote none of them is not a success, whatever the reason. Nothing
    // failed in the sense this method used to mean — no exception, no rejected insert — yet the
    // operator's data is exactly where it was, and `succeeded` is the word that made a restore which
    // did nothing look like one that worked.
    //
    // `planned > 0` keeps a run whose selected tables are genuinely empty out of this: there was
    // nothing to write, so writing nothing is the right outcome rather than a disappointing one.
    //
    // This is a RUN-level judgement only. The per-table rule in `restore-table-writer.service.ts`
    // deliberately still calls an all-duplicate table `succeeded` — re-running a restore is a
    // legitimate idempotent operation — but at the run level it is worth an amber, because the
    // operator asked for rows to appear and none did.
    const wroteNothing = inserted === 0 && planned > 0;

    // A cancelled run satisfies `wroteNothing` by construction whenever it was stopped before it
    // inserted anything — and filing "this restore read rows and kept none" against a run the
    // operator deliberately stopped would be the report accusing them of a problem they caused on
    // purpose. The terminal status is skipped for the same reason: `cancelled` is the outcome, and
    // while `setStatus`'s guard would refuse the overwrite anyway, not asking is clearer than
    // relying on it.
    if (stoppedByCancel) {
      this.logger.log(
        `Restore ${id}: stopped after ${inserted} rows; leaving it cancelled.`,
      );

      return;
    }

    if (wroteNothing) {
      await this.recordNothingWritten(id, organizationId, {
        planned,
        skipped,
        failed,
      });
    }

    // A report that could not be written says so, rather than presenting itself as complete.
    //
    // The rows landed and the totals above are right, so this is not a failed restore — but the
    // per-table breakdown is missing or partial, and an operator reading "succeeded" over a table
    // list that is empty has no way to tell that from a restore which genuinely did nothing.
    if (this.itemUpdateFailures.has(id)) {
      await this.setStatus(id, 'partially_completed', {
        finished_at: new Date().toISOString(),
        error_message:
          'The rows were restored, but the per-table report could not be written, so the table ' +
          'breakdown for this run is incomplete. The totals above are accurate.',
      });

      this.itemUpdateFailures.delete(id);
      await this.pruneOldRunRecords(organizationId);

      return;
    }

    await this.setStatus(
      id,
      anyFailure || wroteNothing ? 'partially_completed' : 'succeeded',
      { finished_at: new Date().toISOString() },
    );

    // After the run is terminal, never before: a prune that ran first could delete the records of
    // the run currently being written if the retention window were ever misconfigured to zero.
    await this.pruneOldRunRecords(organizationId);
  }

  /**
   * Says out loud that an apply wrote nothing, next to the reasons it did not.
   *
   * The amber status tells the operator something is off; this tells them what. Written as a
   * conflict rather than into `refusal_reason` because the run was not refused — it ran, read every
   * row, and kept none — and because the wizard already renders conflicts.
   */
  private async recordNothingWritten(
    id: string,
    organizationId: string,
    counts: { planned: number; skipped: number; failed: number },
  ): Promise<void> {
    const detail =
      `Nothing was written. ${counts.planned} row(s) were read from the archive, ` +
      `${counts.skipped} were skipped and ${counts.failed} failed. The reasons are listed above — ` +
      'commonly the rows are already present, or a space filter excluded them.';

    const { error } = (await this.db.from(CONFLICTS_TABLE).insert({
      organization_id: organizationId,
      restore_run_id: id,
      conflict_class: 'nothing_written',
      severity: 'warning',
      resolution: 'skipped',
      detail,
      context: { code: 'nothing_written', ...counts },
    })) as unknown as { error: { message: string } | null };

    // Same contract as `recordConflicts`: failing to explain a restore must not fail it.
    if (error) {
      this.logger.warn(
        `Restore ${id}: could not record the nothing-written note: ${error.message}`,
      );
    }
  }

  /**
   * Per-organization configuration a moved row has to be repointed at.
   *
   * Each organization owns its own statuses, priorities and so on, with its own ids — so a task
   * carrying the source's "In Review" id means nothing in the destination. Matched by natural key
   * instead, and created there when absent, so no task is refused for want of a lookup value.
   *
   * `business_processes` is the exception. It is space-scoped and is a real object rather than a
   * lookup value, so it is never created on the destination's behalf: an unmatched process leaves
   * the task without one.
   */
  private static readonly REMAP_CONFIG = [
    {
      column: 'status_id',
      table: 'task_statuses',
      keys: ['key', 'name'],
      create: true,
    },
    {
      column: 'priority_id',
      table: 'task_priorities',
      keys: ['key', 'name'],
      create: true,
    },
    {
      column: 'resolution_id',
      table: 'resolutions',
      keys: ['key', 'name'],
      create: true,
    },
    {
      column: 'relation_type_id',
      table: 'relation_types',
      keys: ['name'],
      create: true,
    },
    {
      column: 'process_id',
      table: 'business_processes',
      keys: ['key'],
      create: false,
    },
  ] as const;

  /**
   * Works out what every configuration id in the archive becomes in the destination.
   *
   * Read from the DATABASE, not the archive: the source organization's own rows are still sitting
   * there, so the mapping can be built once up front instead of discovered row by row.
   *
   * A row created in the destination is recorded as a conflict. Adding a status to somebody else's
   * organization is a side effect of restoring, and one they should be able to see afterwards
   * rather than find later.
   */
  private async buildRemapPlan(
    runId: string,
    ownerOrganizationId: string,
    archiveOrganizationId: string,
    targetOrganizationId: string,
    destinationSpaceId: string | null,
    recreateSpaces: boolean,
  ): Promise<RemapPlan> {
    const config = new Map<string, Map<string, string>>();
    const notes: { code: string; detail: string }[] = [];

    for (const spec of BackupRestoreService.REMAP_CONFIG) {
      const [source, target] = await Promise.all([
        this.loadConfigRows(spec.table, archiveOrganizationId),
        this.loadConfigRows(spec.table, targetOrganizationId),
      ]);

      // Natural key → the destination's id. Lower-cased because "In Review" and "in review" are the
      // same status to a person, and a case difference here would create a duplicate.
      const byNaturalKey = new Map<string, string>();

      for (const row of target) {
        for (const key of spec.keys) {
          const value = row[key];

          if (typeof value === 'string' && value) {
            byNaturalKey.set(`${key}:${value.toLowerCase()}`, row.id as string);
          }
        }
      }

      const mapping = new Map<string, string>();
      let created = 0;

      for (const row of source) {
        let matched: string | undefined;

        for (const key of spec.keys) {
          const value = row[key];

          if (typeof value === 'string' && value) {
            matched = byNaturalKey.get(`${key}:${value.toLowerCase()}`);

            if (matched) {
              break;
            }
          }
        }

        if (!matched && spec.create) {
          matched = await this.cloneConfigRow(
            spec.table,
            row,
            targetOrganizationId,
          );

          if (matched) {
            created += 1;
          }
        }

        if (matched) {
          mapping.set(row.id as string, matched);
        }
      }

      config.set(spec.column, mapping);

      if (created) {
        notes.push({
          code: 'configuration_created',
          detail:
            `${created} ${spec.table} row(s) did not exist in the destination organization and ` +
            'were created there so the restored rows had something to point at.',
        });
      }
    }

    await this.recordPlanNotes(runId, ownerOrganizationId, notes);

    return {
      archiveOrganizationId,
      targetOrganizationId,
      destinationSpaceId,
      recreateSpaces,
      config,
    };
  }

  /** Every configuration row an organization owns, whole, so a clone can copy what it needs. */
  private async loadConfigRows(
    table: string,
    organizationId: string,
  ): Promise<Record<string, unknown>[]> {
    const { data } = (await this.db
      .from(table)
      .select('*')
      .eq('organization_id', organizationId)) as unknown as {
      data: Record<string, unknown>[] | null;
    };

    return data ?? [];
  }

  /**
   * Copies one configuration row into the destination organization.
   *
   * The whole row is copied minus its identity and its scoping, rather than a hand-picked list of
   * columns: these tables carry NOT NULL columns this code has no reason to know about, and a
   * partial insert would fail on the first one somebody adds.
   *
   * `space_id` is dropped rather than repointed — the destination organization gets an org-wide
   * value, which is how every one of these rows is scoped today.
   */
  private async cloneConfigRow(
    table: string,
    source: Record<string, unknown>,
    targetOrganizationId: string,
  ): Promise<string | undefined> {
    const payload: Record<string, unknown> = { ...source };

    delete payload.id;
    delete payload.created_at;
    delete payload.updated_at;
    payload.organization_id = targetOrganizationId;
    payload.space_id = null;

    const { data, error } = (await this.db
      .from(table)
      .insert(payload)
      .select('id')
      .maybeSingle()) as unknown as {
      data: { id: string } | null;
      error: { message: string } | null;
    };

    if (error || !data) {
      // Not fatal: the row it would have served is cleared and counted instead of the whole
      // restore failing over a lookup value.
      this.logger.warn(
        `Could not create a ${table} row in ${targetOrganizationId}: ${error?.message ?? 'no row returned'}`,
      );

      return undefined;
    }

    return data.id;
  }

  /**
   * Users who exist in this organization, for the user-FK policy.
   *
   * PAGED, and it has to be. PostgREST is configured with `max_rows = 1000` (`supabase/config.toml`)
   * and a truncated response is an ordinary HTTP 200 — nothing above it can tell a full page from a
   * short one. A single unbounded request therefore returns an arbitrary 1000 members on any org
   * larger than that, and every member outside the window reads as "no longer in this organization":
   * their rows silently dropped by `skip_row` or nulled by `set_null`. Worse, the request carries no
   * `ORDER BY`, so the truncated subset need not even be the same one on the dry run and the apply —
   * a preview that promised a row, and an apply that discarded it.
   *
   * `table-exporter.service.ts` documents this exact hazard and defends against it the same way; the
   * pattern is copied rather than reinvented. Ordering by `user_id` makes the pages disjoint and the
   * result reproducible, and a short page is the only reliable end-of-data signal.
   */
  private async loadUsers(
    organizationId: string,

    // The instance holding that organization. Omitted for a same-organization restore, where the
    // destination IS this server — but a cross-organization one is required to target a DIFFERENT
    // Supabase, and asking this server for the other instance's members returns an EMPTY set, not
    // null. `prepareRow` reads null as "make no user decision" and empty as "nobody is a member",
    // so the two are opposites: every `skip_row` column dropped its row and every `set_null` column
    // was nulled, across all 176 tables, on every cross-instance restore.
    client?: WriteClient,
  ): Promise<Set<string> | null> {
    const PAGE = 500;
    const members = new Set<string>();

    let after: string | null = null;

    for (;;) {
      let query = (client ?? this.db)
        .from(MEMBERS_TABLE)
        .select('user_id')
        .eq('organization_id', organizationId)
        .order('user_id', { ascending: true })
        .limit(PAGE);

      // Keyset rather than `.range()`: an offset re-reads from the top each time, so a membership
      // written mid-restore shifts every later page and drops a row out of the window entirely.
      if (after) {
        query = query.gt('user_id', after);
      }

      const { data, error } = (await query) as unknown as {
        data: { user_id: string | null }[] | null;
        error: { message: string } | null;
      };

      if (error || !data) {
        // Null means "not checked", which the row rules read as "make no user decision". Returning
        // an empty set instead would null or drop every user reference in the archive. Returning a
        // PARTIAL set would be worse still — it looks like an answer.
        this.logger.warn(
          `Could not load the member list; user references will be left as they are: ${
            error?.message ?? 'no rows'
          }`,
        );

        return null;
      }

      for (const row of data) {
        if (row.user_id) {
          members.add(row.user_id);
        }
      }

      if (data.length < PAGE) {
        return members;
      }

      // `user_id` is nullable, and a null cannot be a keyset cursor — the next page would restart
      // from the beginning and loop for ever. Stopping here is safe: nulls sort last under
      // `ascending`, so a null in the final slot means there is nothing after it to read.
      const last = data[data.length - 1]?.user_id;

      if (!last) {
        return members;
      }

      after = last;
    }
  }

  /** Writes what was skipped and why. Capped, and the cap is logged rather than silent. */
  private async recordConflicts(
    id: string,
    organizationId: string,
    conflicts: RestoreConflictRecord[],
  ): Promise<void> {
    if (!conflicts.length) {
      return;
    }

    const capped = conflicts.slice(0, MAX_PERSISTED_CONFLICTS);

    if (capped.length < conflicts.length) {
      this.logger.warn(
        `Restore ${id}: recorded ${capped.length} of ${conflicts.length} conflicts for ${conflicts[0].table}`,
      );
    }

    const { error } = await this.db.from(CONFLICTS_TABLE).insert(
      capped.map((conflict) => ({
        organization_id: organizationId,
        restore_run_id: id,
        conflict_class: conflict.conflictClass,
        severity: conflict.severity,
        table_name: conflict.table,
        column_name: conflict.columnName ?? null,
        row_pk: conflict.rowKey,
        resolution: conflict.resolution,
        // `detail`, never `message`: the global ResponseInterceptor hoists a `message` key out of
        // any payload it wraps, which would silently empty this column in every API response.
        detail: conflict.detail,
      })),
    );

    if (error) {
      // A failure to record why a row was skipped must not fail the restore that skipped it.
      this.logger.warn(
        `Restore ${id}: could not record conflicts: ${error.message}`,
      );
    }
  }

  /**
   * One page of per-row records, plus the per-table and per-outcome tallies the report groups by.
   *
   * The tallies come from a separate aggregate rather than from the page, because a page of 50 rows
   * cannot tell you that a table skipped 4 000 — and a summary computed from a page is exactly the
   * kind of confidently wrong number this whole feature exists to remove.
   */
  async listRecords(
    organizationId: string,
    id: string,
    filters: {
      table?: string;

      /**
       * Restrict to this set of tables, on top of `table`.
       *
       * The Results screen groups tables by outcome (restored / partly restored / skipped /
       * failed) and needs the record list to match the group the operator is looking at. Without
       * it the list is filtered by row outcome ALONE, so the "Skipped" tab also lists the skipped
       * rows of every partly-restored table — rows whose table is not in the tab.
       */
      tables?: string[];
      outcome?: string;
      reason?: string;
      search?: string;
      page: number;
      pageSize: number;
    },
  ) {
    // Proves the run belongs to this organization before anything reads its records. The records
    // table carries its own organization_id and every query below filters on it, but a caller who
    // can name another tenant's run id should get a 404 from here rather than an empty page.
    const run = await this.getRun(organizationId, id);

    const applyFilters = <T extends RestoreRecordFilterQuery<T>>(
      query: T,
    ): T => {
      let next = query;

      if (filters.table) {
        next = next.eq('table_name', filters.table);
      }

      // Applied ALONGSIDE `table`, not instead of it: both narrow, and the intersection is the
      // honest answer if a caller sends both. An empty list is ignored rather than passed to
      // `in()`, where it would match nothing and read as "this run has no records".
      if (
        filters.tables?.length &&
        filters.tables.length <= MAX_RECORD_TABLE_FILTER
      ) {
        next = next.in('table_name', filters.tables);
      }

      if (filters.outcome) {
        next = next.eq('outcome', filters.outcome);
      }

      if (filters.reason) {
        next = next.eq('reason_code', filters.reason);
      }

      if (filters.search) {
        // Escape the PostgREST `or` separators. A comma or a parenthesis in the search box would
        // otherwise be read as filter syntax rather than as text the operator typed.
        const safe = filters.search.replace(/[,()]/g, ' ');

        next = next.or(`row_pk.ilike.%${safe}%,row_label.ilike.%${safe}%`);
      }

      return next;
    };

    const from = (filters.page - 1) * filters.pageSize;

    const [{ data, error }, { count }] = await Promise.all([
      applyFilters(
        this.db
          .from(RECORDS_TABLE)
          .select('*')
          .eq('organization_id', organizationId)
          .eq('restore_run_id', id),
      )
        // Deterministic: outcome groups the eye, table groups the data, id breaks the tie. Without
        // the final id a paged read can repeat or skip rows across page boundaries.
        .order('table_name', { ascending: true })
        .order('outcome', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + filters.pageSize - 1),
      applyFilters(
        this.db
          .from(RECORDS_TABLE)
          .select('*', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .eq('restore_run_id', id),
      ),
    ]);

    if (error) {
      throw new BadRequestException(
        `Could not read the restore report: ${error.message}`,
      );
    }

    const records = await this.hydrateMissingLabels(
      organizationId,
      (data ?? []) as RestoreRecordRow[],
    );

    return {
      run_id: run.id,
      records,
      page: filters.page,
      page_size: filters.pageSize,
      total: count ?? 0,
    };
  }

  /**
   * Names the records the writer could not name, by reading the rows back out of the destination.
   *
   * A RESTORED row stores no payload — it is live in the destination, and a second copy would
   * duplicate tenant data — so there is nothing on the record itself to build a label from. That is
   * the right storage decision and the wrong reading experience: every restored row rendered as
   * "(no name)", which is the least useful thing a report can say.
   *
   * But "restored" means the row IS there. So it is fetched back, and named from the live row using
   * exactly the same rules the writer would have used. Records written before the labelling rules
   * improved get the same treatment, which is why this is not simply a bug fixed at capture time:
   * it repairs history rather than only the future.
   *
   * A row that was SKIPPED before it was ever written has no live row to fetch — but it does have
   * its archived payload, which is the only surviving description of exactly the rows an operator
   * is most likely to ask about. So the payload is the fallback source, and the label comes out the
   * same way it would have at write time, task key and all.
   *
   * Bounded by the page, which the controller clamps to 200. Three tiers at most — the rows, their
   * parents, their parents' parents — one round trip per table in each, and none at all when the
   * page is already labelled.
   *
   * Best-effort throughout: a label is a convenience, and a report that fails to load because a
   * name could not be resolved is worse than one that says "(no name)".
   */
  private async hydrateMissingLabels(
    organizationId: string,
    records: RestoreRecordRow[],
  ): Promise<RestoreRecordRow[]> {
    /**
     * A record worth re-deriving: unnamed, OR named without the parent it should carry.
     *
     * `!row_label` alone is not the test, and assuming it was is how the task key went missing in
     * the ordinary case. `buildRowLabel` returns the row's OWN name when the parent cannot be
     * resolved — a perfectly non-null `'Looks good to me'` for a comment whose task was not part of
     * the run. `planRestore` adds no dependencies by design, so restoring `task_comments` without
     * `tasks` selected is the normal outcome of picking one table, not an edge case. Filtering on
     * null would freeze every one of those rows at their degraded label on every future page load,
     * even though the parent is sitting in the destination waiting to be read.
     *
     * So any table with a parent ref is revisited. The stored label is only ever replaced by a
     * better one — see the map at the end, which keeps what it has when re-derivation yields null.
     */
    const improvable = records.filter(
      (r) => !r.row_label || ROW_PARENT_REFS[r.table_name],
    );

    if (!improvable.length) {
      return records;
    }

    /** `id=<uuid>` is what `rowKeyOf` writes for the single-column keys this can resolve. */
    const idOf = (rowPk: string | null): string | null => {
      if (!rowPk?.startsWith('id=')) {
        return null;
      }

      const id = rowPk.slice(3);

      // A composite key contains a second `col=` segment; those are not resolvable by a single
      // `.in('id', ...)` and are left unnamed rather than guessed at.
      return id.includes('=') ? null : id;
    };

    const byTable = new Map<string, Set<string>>();

    for (const record of improvable) {
      const id = idOf(record.row_pk);

      if (!id) {
        continue;
      }

      const ids = byTable.get(record.table_name);

      if (ids) {
        ids.add(id);
      } else {
        byTable.set(record.table_name, new Set([id]));
      }
    }

    const liveRows = await this.fetchRowsByTable(organizationId, byTable);

    /**
     * The row a record's label is built from: the live one if it is there, else the archived one.
     *
     * The live row is preferred because it is the truth about what is in the destination now. But a
     * row that was SKIPPED before it was ever written — `missing_parent`, `foreign_tenant`,
     * `unmapped_reference` — has no live row at all, and reading only from the destination gave
     * those records no label and no task key despite their payload carrying both. The payload is
     * the only surviving description of exactly the rows the operator most needs to ask about.
     *
     * Restored rows store no payload, so this cannot mask a live row with a stale copy: whenever
     * `archived_row` is present, the row was not written.
     */
    const labelSourceFor = (
      record: RestoreRecordRow,
    ): Record<string, unknown> | null => {
      const id = idOf(record.row_pk);
      const live = id ? liveRows.get(record.table_name)?.get(id) : undefined;

      return live ?? record.archived_row ?? null;
    };

    // Parents, so a child can carry its task key. Read from whichever source will name the record,
    // and from EVERY parent the table has — a form submission is named after its form and, when it
    // has one, its task.
    const parentIds = new Map<string, Set<string>>();

    for (const record of improvable) {
      const row = labelSourceFor(record);

      if (!row) {
        continue;
      }

      collectParentIds(record.table_name, row, parentIds);
    }

    const parentRows = await this.fetchRowsByTable(organizationId, parentIds);

    /**
     * One more tier — the parents' own parents — and then the chain stops.
     *
     * Labelling a parent with no lookup of its own names it after nothing but itself, and a
     * submission's own fields say `submitted`. So a webhook delivery read `submitted · delivered`
     * here while the WRITE path, which labels in dependency order and therefore has every ancestor
     * already in its index, rendered `Onboarding Form · NEWSPACE-T88 · … · submitted · delivered`
     * for that same row. Two engines disagreeing about one row is worse than either answer alone:
     * the operator cannot tell which screen is lying.
     *
     * Deliberately ONE extra tier rather than a walk that follows refs until they run out. Two hops
     * covers the whole of ROW_PARENT_REFS — nothing in it is three deep — and a fixed depth costs
     * one round trip per grandparent table on a page that has any and nothing at all on a page that
     * does not, where a walk would fan out unboundedly the day someone adds a deeper ref, or spin
     * on a cyclic one. Grandparents are labelled with no lookup, which is what ends it.
     */
    const grandparentIds = new Map<string, Set<string>>();

    for (const [table, rows] of parentRows) {
      for (const row of rows.values()) {
        collectParentIds(table, row, grandparentIds);
      }
    }

    const grandparentLabels = labelRowsByTable(
      await this.fetchRowsByTable(organizationId, grandparentIds),
    );

    const lookupGrandparent = (table: string, id: string) =>
      grandparentLabels.get(table)?.get(id) ?? null;

    const parentLabels = labelRowsByTable(parentRows, lookupGrandparent);

    const lookupParent = (table: string, id: string) =>
      parentLabels.get(table)?.get(id) ?? null;

    return records.map((record) => {
      // Already named, and nothing a parent could add to it.
      if (record.row_label && !ROW_PARENT_REFS[record.table_name]) {
        return record;
      }

      const row = labelSourceFor(record);

      if (!row) {
        return record;
      }

      const rebuilt = buildRowLabel(record.table_name, row, lookupParent);

      // Nothing to say at all — a payload clamped past the column that named it, a row with no
      // readable field. The stored label, degraded as it may be, is the best answer there is.
      if (!rebuilt) {
        return record;
      }

      if (!record.row_label) {
        return { ...record, row_label: rebuilt };
      }

      // An UNNAMED record takes whatever re-derivation produces. A NAMED one only gives up its
      // label for a strictly better one, and "better" here means exactly one thing: a parent got
      // resolved that the stored label does not have.
      //
      // Without this test the repair runs backwards in a real case. A comment stored as
      // `NEWSPACE-T88 · … · Looks good to me` whose task has since been deleted re-derives to the
      // bare `Looks good to me` — non-null, so the naive version overwrites, and the report quietly
      // loses the key it is the whole point of this method to carry. Deleting a task must not erase
      // the record of which task a restored comment belonged to.
      //
      // The comparison is against the same row labelled with NO lookup, so it costs one pure call
      // and no I/O.
      const withoutParent = buildRowLabel(record.table_name, row);

      return rebuilt === withoutParent
        ? record
        : { ...record, row_label: rebuilt };
    });
  }

  /**
   * Reads one tier of rows — every table in parallel — keyed by table and then by id.
   *
   * The ids arrive already grouped by table because the cost that matters is round trips, not rows:
   * a page of two hundred comments on one task must read `tasks` once, not two hundred times. An
   * empty group reads nothing, which is why a page with no parents to resolve costs nothing extra.
   *
   * A table whose rows all failed to read is omitted rather than stored empty, so a caller cannot
   * accidentally distinguish "read nothing" from "did not read".
   */
  private async fetchRowsByTable(
    organizationId: string,
    idsByTable: Map<string, Set<string>>,
  ): Promise<Map<string, Map<string, Record<string, unknown>>>> {
    const out = new Map<string, Map<string, Record<string, unknown>>>();

    await Promise.all(
      [...idsByTable.entries()].map(async ([table, ids]) => {
        const rows = await this.fetchLiveRows(organizationId, table, [...ids]);

        if (rows.size > 0) {
          out.set(table, rows);
        }
      }),
    );

    return out;
  }

  /**
   * Reads live rows by id, scoped to the organization.
   *
   * The organization filter is not decoration: this runs on the service-role client, which bypasses
   * RLS, and the ids come from a report the caller chose. Without it, naming a record would be a
   * way to read a row out of another tenant.
   *
   * Returns an empty map on any failure — including a table that no longer exists, which is exactly
   * what a report about an old restore may well reference.
   */
  private async fetchLiveRows(
    organizationId: string,
    table: string,
    ids: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();

    if (!ids.length) {
      return out;
    }

    try {
      const { data, error } = (await this.db
        .from(table)
        .select('*')
        .eq('organization_id', organizationId)
        .in('id', ids.slice(0, LABEL_LOOKUP_LIMIT))) as unknown as {
        data: Record<string, unknown>[] | null;
        error: { message: string } | null;
      };

      if (error || !data) {
        return out;
      }

      for (const row of data) {
        const id = row['id'];

        if (typeof id === 'string') {
          out.set(id, row);
        }
      }
    } catch {
      // A table without an organization_id column, a dropped table, a type mismatch. None of these
      // should cost the caller their report.
      return out;
    }

    return out;
  }

  /**
   * Writes the per-row report records for one table.
   *
   * Best-effort, exactly like `recordConflicts` and for the same reason: these rows explain a
   * restore, they are not part of it. Losing them costs the operator an explanation; failing the
   * run over them would cost the operator their data.
   *
   * Inserted in chunks because a single table can produce tens of thousands of records and
   * PostgREST takes a 10 MB body — the same ceiling the writer batches inserts against.
   */
  private async recordRunRecords(
    id: string,
    organizationId: string,
    records: RestoreRunRecord[],
  ): Promise<void> {
    if (!records.length) {
      return;
    }

    for (let start = 0; start < records.length; start += RECORD_INSERT_CHUNK) {
      const chunk = records.slice(start, start + RECORD_INSERT_CHUNK);

      const { error } = await this.db.from(RECORDS_TABLE).insert(
        chunk.map((record) => ({
          organization_id: organizationId,
          restore_run_id: id,
          table_name: record.table,
          row_pk: record.rowPk,
          row_label: record.rowLabel,
          outcome: record.outcome,
          reason_code: record.reasonCode ?? null,
          // `detail`, never `message`: the ResponseInterceptor hoists a `message` key out of any
          // payload it wraps, which would silently empty this column in every API response.
          reason_detail: record.reasonDetail ?? null,
          // What the refused reference pointed at. Null for every outcome that is not a refused
          // reference, which is most of them. Omitted entirely until the column exists — including
          // an unknown column fails the whole insert and loses every record in the chunk.
          ...(REFERENCES_TABLE_COLUMN_APPLIED
            ? { references_table: record.referencesTable ?? null }
            : {}),
          archived_row: record.archivedRow ?? null,
          live_row: record.liveRow ?? null,
          pass: record.pass,
        })),
      );

      if (error) {
        this.logger.warn(
          `Restore ${id}: could not record run records: ${error.message}`,
        );

        // One rejected chunk does not mean the next will be rejected — a unique-constraint
        // collision is per-row — so the loop continues rather than abandoning the whole table.
        continue;
      }
    }
  }

  /**
   * Deletes report records for all but the most recent runs of an organization.
   *
   * Only the RECORDS are pruned. `restore_runs` and `restore_run_items` are counts and status, a
   * few hundred bytes per run, and they are the audit trail — losing them would mean a restore that
   * happened could no longer be shown to have happened. The records are the bulky part and the part
   * that duplicates tenant content, so they are the part with a lifetime.
   *
   * Runs on completion rather than on a schedule because the module has no restore-side cron at
   * all: the three existing @Cron jobs are backup tick, worker and reaper. Adding one just to
   * delete rows would be more moving parts than the problem needs.
   *
   * Best-effort. A restore that succeeded must not be reported as failed because a cleanup did not.
   */
  private async pruneOldRunRecords(organizationId: string): Promise<void> {
    try {
      const { data: keep, error: keepError } = await this.db
        .from(RUNS_TABLE)
        .select('id')
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false })
        .limit(RECORD_RETENTION_RUNS);

      if (keepError || !keep?.length) {
        return;
      }

      const keepIds = keep.map((row: { id: string }) => row.id);

      const { error } = await this.db
        .from(RECORDS_TABLE)
        .delete()
        .eq('organization_id', organizationId)
        .not('restore_run_id', 'in', `(${keepIds.join(',')})`);

      if (error) {
        this.logger.warn(
          `Could not prune restore run records for ${organizationId}: ${error.message}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Could not prune restore run records for ${organizationId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * @param exceptId A run that does not count against the slot — the preview an apply is
   *   continuing. Without it, apply probes for in-flight runs and finds the very row it was asked
   *   to act on.
   */
  private async assertNoRunInFlight(
    organizationId: string,
    exceptId?: string,
  ): Promise<void> {
    // `selection` comes along because it is the only table list that exists for the whole life of a
    // run. Items are created by the planner, so a run still queued, downloading or validating has
    // none at all — which is exactly when this guard fires most often.
    let query = this.db
      .from(RUNS_TABLE)
      .select('id, status, selection, updated_at, started_at, created_at')
      .eq('organization_id', organizationId)
      .in('status', IN_FLIGHT as unknown as string[]);

    if (exceptId) {
      query = query.neq('id', exceptId);
    }

    // More than one, where the old code took the first it found. A single abandoned run must not be
    // able to hide a genuinely live one behind it once the abandoned one is reclaimed below.
    const { data } = (await query.limit(10)) as unknown as {
      data:
        | {
            id: string;
            status: string;
            selection: { tables?: string[] } | null;
            updated_at: string | null;
            started_at: string | null;
            created_at: string | null;
          }[]
        | null;
    };

    if (!data?.length) {
      return;
    }

    // A run whose worker is gone keeps its status for ever and holds the slot with it. Reclaim
    // those first, then decide the conflict on what is actually still working.
    const stalled = data.filter((run) => this.hasStalled(run));
    const abandoned: typeof stalled = [];

    // Only a run that WAS released stops counting against the slot. Assuming the reclaim worked is
    // what turned a recoverable situation into an unrecoverable one: the write was refused, the row
    // kept its in-flight status, this guard concluded there was nothing blocking, and the insert
    // below then died on the partial unique index — handing the operator a raw constraint name
    // instead of the conflict message sitting a few lines further down.
    for (const run of stalled) {
      if (await this.reclaimAbandonedRun(run.id)) {
        abandoned.push(run);
      }
    }

    const live = data.filter((run) => !abandoned.includes(run));

    if (!live.length) {
      return;
    }

    // `awaiting_confirmation` is in flight in the sense that it owns the slot, but it is not doing
    // anything — it is a finished preview waiting on a person. Saying "wait for it to finish" is
    // then wrong twice over: it HAS finished, and waiting will never clear it. An abandoned preview
    // used to hold the slot for ever, because closing the wizard has no way to release it.
    const blocking = live[0];

    if (blocking.status === 'awaiting_confirmation') {
      throw new ConflictException(
        'A preview is already waiting for your confirmation. Apply it, or discard it, before ' +
          'starting another.',
      );
    }

    // The TABLES the blocking run is on. "In progress" spans reading the archive through writing the
    // last table, and naming what it is actually working on is the difference between waiting a
    // moment and realising something is stuck. `restore_runs.phase_detail` is null on every row
    // here, so it comes from the items, which is where per-table progress is recorded.
    const running = await this.runningTablesOf(organizationId, blocking.id);

    // Otherwise what it is ABOUT to write. Items are created by the planner, so a run still queued,
    // downloading or validating has none — and that is precisely when this guard fires most, which
    // is why naming only the running ones left the message with no tables at all. `selection.tables`
    // is written when the run is created, so it is there for the whole of its life.
    const planned = Array.isArray(blocking.selection?.tables)
      ? blocking.selection.tables.filter(
          (table): table is string =>
            typeof table === 'string' && table.length > 0,
        )
      : [];

    const tables = running.length ? running : planned;
    const shown = tables.slice(0, MAX_TABLES_IN_CONFLICT);
    const rest = tables.length - shown.length;

    // Counted rather than truncated silently: a restore of forty tables must not read as a restore
    // of twenty.
    const listed =
      rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');

    throw new ConflictException(
      tables.length
        ? `A restore is already in progress for this organization (${
            running.length ? 'currently restoring' : 'restoring'
          } ${listed}). Wait for it to finish.`
        : 'A restore is already in progress for this organization. Wait for it to finish.',
    );
  }

  /**
   * Whether a run has stopped making progress for long enough to call it abandoned.
   *
   * Progress is `updated_at`, which every `setStatus` bumps — so a slow but living run keeps
   * refreshing it and is never reclaimed, however long it legitimately takes. The fallbacks matter
   * for a run that failed before its first status write: without them a row with a null
   * `updated_at` would look infinitely stale on one reading and infinitely fresh on the other.
   *
   * A run with no usable timestamp at all is treated as LIVE, not abandoned. Reclaiming is
   * destructive to a running restore, and "we cannot tell" must never resolve to "kill it".
   */
  private hasStalled(run: {
    status: string;
    updated_at?: string | null;
    started_at: string | null;
    created_at: string | null;
  }): boolean {
    // A finished preview waiting on a person is not stalled, however long it waits.
    if (run.status === 'awaiting_confirmation') {
      return false;
    }

    const stamp = run.updated_at ?? run.started_at ?? run.created_at;

    if (!stamp) {
      return false;
    }

    const last = Date.parse(stamp);

    if (Number.isNaN(last)) {
      return false;
    }

    return Date.now() - last > ABANDONED_AFTER_MS;
  }

  /**
   * Closes out a run whose worker never came back, so the slot is free again.
   *
   * The `.in('status', IN_FLIGHT)` on the update is a compare-and-set, not decoration: between the
   * read above and this write the real worker may have come back and finished. Without it this
   * would overwrite a succeeded run with a failure and lose its counts. With it, the update simply
   * matches nothing and the live outcome stands.
   *
   * Best-effort in that a failure must not stop the caller — but it MUST be reported, because a
   * reclaim that silently did nothing is worse than one that never ran. The caller decides what to
   * do with `false`; what it must not do is assume the slot is free.
   *
   * @returns whether the row actually left the in-flight set.
   */
  private async reclaimAbandonedRun(id: string): Promise<boolean> {
    try {
      // `error` is READ, not discarded. supabase-js resolves a rejected statement as `{ error }`
      // rather than throwing — nothing here uses `.throwOnError()` — so ignoring the return value
      // makes a refused write indistinguishable from a successful one. That is exactly what
      // happened: `error_class` was set to 'worker_lost', which `restore_runs_error_class_check`
      // does not allow, Postgres refused the whole UPDATE, and this method logged success anyway.
      // The run kept its in-flight status, kept the organization's only restore slot, and every
      // later attempt died on the partial unique index instead — for 66 hours, with the list screen
      // showing it as failed the entire time.
      const { error } = (await this.db
        .from(RUNS_TABLE)
        .update({
          status: 'failed',
          // One of the nine values the CHECK constraint permits. A vanished worker is not the
          // operator's fault and the same restore will usually work on a retry, which is what
          // `transient` means here; the specifics belong in the message, which is free text.
          error_class: 'transient',
          error_message: ABANDONED_RUN_MESSAGE,
          finished_at: new Date().toISOString(),
        })
        .eq('id', id)
        // Compare-and-set, not decoration: between the read above and this write the real worker may
        // have come back and finished. Without it this would overwrite a succeeded run with a
        // failure and lose its counts. With it, the update simply matches nothing.
        .in('status', IN_FLIGHT as unknown as string[])) as unknown as {
        error: { message: string } | null;
      };

      if (error) {
        this.logger.error(
          `Could not reclaim abandoned restore run ${id}: ${error.message}`,
        );

        return false;
      }

      this.logger.warn(
        `Reclaimed restore run ${id}: no progress for over ${Math.round(
          ABANDONED_AFTER_MS / 60_000,
        )} minutes, worker presumed gone.`,
      );

      return true;
    } catch (error) {
      this.logger.error(
        `Could not reclaim abandoned restore run ${id}: ${String(error)}`,
      );

      return false;
    }
  }

  /**
   * The tables a blocking restore is currently writing.
   *
   * Plural because a run writes several at once — the engine leases a batch of items per pass, so
   * naming only the first would be arbitrary and would read as "stuck on one table" when it is not.
   *
   * Capped so a wide restore cannot turn a 409 into a paragraph; the count that follows says how
   * many were left out.
   *
   * Best effort by design: this runs only to build an error message, so a failure here must not
   * replace the 409 the caller is owed with a 500. Returns nothing and the message simply says less.
   */
  private async runningTablesOf(
    organizationId: string,
    restoreRunId: string,
  ): Promise<string[]> {
    try {
      const { data } = (await this.db
        .from('restore_run_items')
        .select('table_name')
        .eq('organization_id', organizationId)
        .eq('restore_run_id', restoreRunId)
        .eq('status', 'running')
        .order('table_name', { ascending: true })
        .limit(20)) as unknown as {
        data: { table_name: string | null }[] | null;
      };

      return (data ?? [])
        .map((row) => row.table_name)
        .filter((name): name is string => Boolean(name));
    } catch {
      return [];
    }
  }

  /**
   * Works out which organization this run writes into, and whether it is allowed to.
   *
   * Same organization is the ordinary case and needs no consent. A different one is only permitted
   * on an approval that is still valid RIGHT NOW: approved, unexpired, unconsumed, and covering
   * this exact selection. Every one of those is re-checked here rather than trusted from the moment
   * the owner clicked approve, because a person answers minutes or days later and memberships,
   * expiry and the chosen tables can all have moved since.
   *
   * @throws BadRequestException when the aim is wrong, or right but unapproved.
   */
  private async resolveDestination(
    organizationId: string,
    input: StartRestoreInput,
  ): Promise<{
    targetOrganizationId: string;
    approvalRequestId: string | null;
  }> {
    const expected = input.expectedOrganizationId ?? organizationId;
    const crossOrganization = expected !== organizationId;

    if (crossOrganization) {
      const approval = await this.approvals.findUsableApproval(
        organizationId,
        expected,
        input.artifactId,
        fingerprintSelection({
          tables: input.tables,
          sourceSpaceId: input.spaceId,
          destinationSpaceId: input.destinationSpaceId,

          // Carried so an approval granted for content cannot be consumed by a run that also moves
          // memberships: the two hash differently and `findUsableApproval` will not match.
          includeIdentity: input.includeIdentity,
        }),
      );

      if (!approval) {
        throw new BadRequestException(
          'Restoring into another organization needs that organization to approve it first, and ' +
            'no live approval covers this archive and this selection. Send a request, or check ' +
            'that what you have chosen still matches what was approved.',
        );
      }

      // The destination space is re-read from the approval rather than from the request body: the
      // owner approved rows landing in a particular space, not merely in their organization.
      const approvedSelection = approval.selection as {
        destination_space_id?: string | null;
      };

      if (
        approvedSelection.destination_space_id &&
        approvedSelection.destination_space_id !== input.destinationSpaceId
      ) {
        throw new BadRequestException(
          'This restore is aimed at a different space than the one that was approved.',
        );
      }

      await this.assertSpaceBelongsTo(input.destinationSpaceId, expected);

      return {
        targetOrganizationId: expected,
        approvalRequestId: approval.id,
      };
    }

    // Same-organization restore. `spaceId` is a SOURCE filter here, so it must name a space of this
    // organization — a space from anywhere else matches no archived row and would refuse every one
    // of them, one at a time, while the run finished green.
    //
    // Skipped for a remote destination: those spaces live in the other database, and checking them
    // against this table would reject the one cross-instance configuration that works.
    if (input.spaceId && !input.destinationId) {
      await this.assertSpaceBelongsTo(input.spaceId, organizationId);
    }

    return { targetOrganizationId: organizationId, approvalRequestId: null };
  }

  /**
   * Refuses a space that is not in the organization it is being used against.
   *
   * An archived space is deliberately still allowed: restoring into one is the operator's call, and
   * refusing it here would be a new silent failure in place of the one being fixed.
   */
  private async assertSpaceBelongsTo(
    spaceId: string | undefined,
    organizationId: string,
  ): Promise<void> {
    if (!spaceId) {
      return;
    }

    const { data } = (await this.db
      .from(SPACES_TABLE)
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle()) as unknown as { data: { id: string } | null };

    if (!data) {
      throw new BadRequestException(
        'That space is not in the organization this restore writes into, so no archived row could ' +
          'ever belong to it. Choose a space of that organization, or restore every space.',
      );
    }
  }

  /**
   * Abandons a preview that will not be applied, releasing the organization's restore slot.
   *
   * A dry run writes nothing, so discarding one destroys no data — it only gives up the right to
   * apply that particular plan. Without this a preview left unconfirmed blocks every later restore
   * with a 409 and no way out of it from the UI.
   */
  async discardDryRun(
    organizationId: string,
    id: string,
  ): Promise<{ id: string; status: string }> {
    const run = await this.getRun(organizationId, id);

    if (run.mode !== 'dry_run') {
      throw new BadRequestException(
        'Only a preview can be discarded. A restore that has begun writing is not undone by ' +
          'cancelling it.',
      );
    }

    if (run.status !== 'awaiting_confirmation') {
      throw new BadRequestException(
        `This preview is ${run.status}, so there is nothing to discard.`,
      );
    }

    await this.setStatus(id, 'cancelled', {
      finished_at: new Date().toISOString(),
    });

    // The cached archive is NOT discarded here.
    //
    // It used to be: keyed by the preview run, throwing the preview away meant its copy could never
    // be read again. Keyed by the artifact it belongs to every restore of that backup file, so
    // deleting it because one operator abandoned one preview would make the next restore re-download
    // an archive that is sitting right there. Its lifetime is the TTL instead.
    //
    // The legacy run-keyed object, if this preview predates artifact keying, is still removed — that
    // one really is this run's and nothing else can read it.
    await this.archiveCache.discardLegacy(organizationId, id);

    return { id, status: 'cancelled' };
  }

  /**
   * Stops a restore that is still working, and frees the organization's restore slot.
   *
   * Distinct from `discardDryRun`, which only ever applied to a preview waiting on a decision. This
   * one is for a run that is actually doing something — or that has stopped doing anything without
   * saying so, which is the case an operator hits when a restore hangs and every later attempt is
   * refused with a 409.
   *
   * ## Cancelling does not undo
   *
   * Restore is INSERT-only and there is no rollback: rows already written stay written, and their
   * counts stay on the run because they are the record of what landed. This stops further writing;
   * it does not reverse what has happened.
   *
   * ## Cooperative, so not instant
   *
   * The running loop notices at its next checkpoint — between tables, and between insert batches
   * inside a table. A run wedged with no code executing reaches no checkpoint at all, so nothing can
   * stop the loop itself; what this still does, and what the operator actually needs, is release the
   * slot immediately and make sure the wedged run can never overwrite this verdict later.
   */
  async cancelRun(
    organizationId: string,
    id: string,
  ): Promise<{ id: string; status: string }> {
    const run = await this.getRun(organizationId, id);

    if (!(IN_FLIGHT as readonly string[]).includes(run.status)) {
      throw new BadRequestException(
        `This restore is already ${run.status}, so there is nothing to cancel.`,
      );
    }

    // `.in('status', IN_FLIGHT)` rather than a bare id match: the run may finish in the moment
    // between the read above and this write. A finished restore must keep its real outcome — the
    // alternative is a succeeded run relabelled as cancelled, which would misreport what happened to
    // the operator's data. Whoever gets there first wins, and both answers are true.
    const { data, error } = (await this.db
      .from(RUNS_TABLE)
      .update({
        status: 'cancelled',
        phase_detail: 'cancelled by an operator',
        finished_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .in('status', IN_FLIGHT as unknown as string[])
      .select('id')) as unknown as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Could not cancel this restore: ${error.message}`,
      );
    }

    if (!data?.length) {
      // Nothing matched, so the run reached a terminal status first. Reported rather than thrown:
      // the operator asked for it to stop and it has stopped, which is the outcome they wanted.
      this.logger.log(
        `Restore ${id}: cancel arrived after the run had already finished.`,
      );

      const settled = await this.getRun(organizationId, id);

      return { id, status: settled.status };
    }

    this.logger.log(`Restore ${id}: cancelled by an operator.`);

    return { id, status: 'cancelled' };
  }

  /**
   * A throttled "has this been cancelled?" probe for the run loop.
   *
   * Returns a closure rather than a bare method so the throttle state lives for one run. The loop
   * calls it between every table and every insert batch, and on a 169-table restore an unthrottled
   * read would roughly double the per-item bookkeeping — measured at ~7.5 ms an item, against a
   * whole export that completes in under four seconds.
   *
   * Fails OPEN: a probe that cannot read the row answers "not cancelled" and the restore carries on.
   * A transient database blip must not silently abandon a restore half way through.
   */
  private cancellationProbe(id: string): () => Promise<boolean> {
    let lastCheckedAt = 0;
    let cancelled = false;

    return async () => {
      if (cancelled) {
        return true;
      }

      const now = Date.now();

      if (now - lastCheckedAt < CANCEL_CHECK_INTERVAL_MS) {
        return false;
      }

      lastCheckedAt = now;

      const { data, error } = (await this.db
        .from(RUNS_TABLE)
        .select('status')
        .eq('id', id)
        .maybeSingle()) as unknown as {
        data: { status: string } | null;
        error: { message: string } | null;
      };

      if (error || !data) {
        return false;
      }

      cancelled = data.status === 'cancelled';

      return cancelled;
    };
  }

  private async insertRun(row: Record<string, unknown>): Promise<string> {
    const { data, error } = (await this.db
      .from(RUNS_TABLE)
      .insert(row)
      .select('id')
      .single()) as unknown as {
      data: { id: string } | null;
      error: { message: string; code?: string } | null;
    };

    if (error || !data) {
      // `restore_runs_one_active_per_org` and `_one_active_per_target` are the database half of the
      // one-restore-at-a-time rule that `assertNoRunInFlight` enforces in application code. Reaching
      // here means the two disagreed — a race between two requests, or a run the guard could not
      // clear — and either way the honest answer is the same 409 the guard would have given. It was
      // previously pasted into a 400 verbatim, so an operator was shown a unique-index name and left
      // to work out that it meant "something else is running".
      if (error?.code === '23505') {
        throw new ConflictException(
          'A restore is already in progress for this organization. Wait for it to finish, or ' +
            'discard the preview that is waiting for confirmation.',
        );
      }

      throw new BadRequestException(
        `Could not start the restore: ${error?.message ?? 'no row returned'}`,
      );
    }

    return data.id;
  }

  private async getRun(
    organizationId: string,
    id: string,
  ): Promise<RestoreRunRow> {
    const { data, error } = (await this.db
      .from(RUNS_TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle()) as unknown as {
      data: RestoreRunRow | null;
      error: { message: string } | null;
    };

    if (error || !data) {
      throw new NotFoundException('Restore not found');
    }

    return data;
  }

  /**
   * Moves a run to a new status — unless an operator has cancelled it.
   *
   * `.neq('status', 'cancelled')` is a compare-and-set, and it is the single line that makes
   * cancellation stick. There are thirteen callers of this method, and four of them write a TERMINAL
   * status (`partially_completed`, `succeeded`, `failed`, `refused`). Without the guard, a run
   * cancelled mid-flight would finish unwinding and then overwrite `cancelled` with its own verdict:
   * the operator would watch the row flip back and conclude the button does nothing.
   *
   * It also makes a late-waking zombie harmless. A run wedged inside one table reaches no checkpoint,
   * so cancelling it cannot stop the loop — but whatever that loop tries to write afterwards lands on
   * zero rows.
   *
   * Cancellation is deliberately the ONLY absorbing state. Every other transition still overwrites
   * freely, because a run legitimately moves failed-to-nothing but never cancelled-to-anything.
   */
  private async setStatus(
    id: string,
    status: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const { error } = await this.db
      .from(RUNS_TABLE)
      .update({ status, ...extra })
      .eq('id', id)
      .neq('status', 'cancelled');

    if (error) {
      this.logger.warn(
        `Restore ${id}: could not set status ${status}: ${error.message}`,
      );
    }
  }

  /**
   * Mid-table progress: the item's counts so far, and run counters that refresh `updated_at`.
   * The run update only matches an in-flight run, so it never revives a cancelled or failed one.
   */
  private async reportTableProgress(
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
  ): Promise<void> {
    const [item, run] = await Promise.all([
      this.db
        .from(ITEMS_TABLE)
        .update({
          planned_row_count: counts.planned,
          inserted_row_count: counts.inserted,
          skipped_row_count: counts.skipped,
          failed_row_count: counts.failed,
        })
        .eq('restore_run_id', id)
        .eq('table_name', table),
      this.db
        .from(RUNS_TABLE)
        .update({
          planned_row_count: before.planned + counts.planned,
          inserted_row_count: before.inserted + counts.inserted,
          skipped_row_count: before.skipped + counts.skipped,
          failed_row_count: before.failed + counts.failed,
          conflict_count: before.conflicts,
        })
        .eq('id', id)
        .in('status', IN_FLIGHT as unknown as string[]),
    ]);
    const error = item.error ?? run.error;

    if (error) {
      this.logger.warn(
        `Restore ${id}: progress for ${table} not recorded: ${error.message}`,
      );
    }
  }

  /** Final counters for a cancelled run. Matches nothing on any other run. */
  private async recordCancelledTotals(
    id: string,
    totals: {
      planned: number;
      inserted: number;
      skipped: number;
      failed: number;
      conflicts: number;
    },
  ): Promise<void> {
    const { error } = await this.db
      .from(RUNS_TABLE)
      .update({
        planned_row_count: totals.planned,
        inserted_row_count: totals.inserted,
        skipped_row_count: totals.skipped,
        failed_row_count: totals.failed,
        conflict_count: totals.conflicts,
      })
      .eq('id', id)
      .eq('status', 'cancelled');

    if (error) {
      this.logger.warn(
        `Restore ${id}: totals of the cancelled run not recorded: ${error.message}`,
      );
    }
  }

  private async setItem(
    id: string,
    table: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.db
      .from(ITEMS_TABLE)
      .update(patch)
      .eq('restore_run_id', id)
      .eq('table_name', table);

    if (!error) {
      return;
    }

    /**
     * LOUD, and deliberately not a warning any more.
     *
     * This is the per-table report. When it fails, the rows are still written and the run-level
     * counters are still right — so the restore looks entirely successful while every table sits at
     * `running` with zero counts, and the results screen, which builds its table list from these
     * rows, shows nothing at all.
     *
     * That is not hypothetical. A column was added to this patch ahead of the migration that creates
     * it; PostgREST rejected the whole UPDATE for an unknown column, this swallowed it as a warning,
     * and all 148 tables of a real restore reported as never having run — 8,949 rows written, none
     * of them attributable to a table.
     *
     * Still not thrown. Rows have already landed by this point and abandoning the run would lose the
     * report for every table after this one as well, which is the fault this is trying to make
     * visible. It is recorded on the run instead, so a report that cannot be trusted says so.
     */
    this.logger.error(
      `Restore ${id}: could not record the outcome of ${table}: ${error.message}. ` +
        'The rows are written but this table will not appear correctly in the report.',
    );

    this.itemUpdateFailures.add(id);
  }

  /** A run that may not happen. Distinct from a failure — nothing went wrong. */
  private async refuse(id: string, reason: string): Promise<void> {
    await this.setStatus(id, 'refused', {
      refusal_reason: reason,
      finished_at: new Date().toISOString(),
    });
  }

  private async failRun(id: string, err: Error): Promise<void> {
    await this.setStatus(id, 'failed', {
      error_class: classifyRunError(err),
      error_message: err.message,
      finished_at: new Date().toISOString(),
    });
  }
}

/**
 * Adds one row's parent ids to `sink`, grouped by the table they live in.
 *
 * Grouped, because the ids are only ever used to ask a table for a set of rows, and asking once per
 * child row is the difference between one read and two hundred.
 *
 * EVERY ref the table declares is followed, not just the first: a form submission is named after
 * its form AND, when it has one, its task, and a link table is named after both of its ends. A ref
 * the row does not carry — `task_id` is null on most submissions — is simply absent, which the
 * label builder renders as one fewer part rather than as a gap.
 */
function collectParentIds(
  table: string,
  row: Record<string, unknown>,
  sink: Map<string, Set<string>>,
): void {
  for (const ref of ROW_PARENT_REFS[table] ?? []) {
    const id = row[ref.column];

    if (typeof id !== 'string' || id.length === 0) {
      continue;
    }

    const ids = sink.get(ref.table);

    if (ids) {
      ids.add(id);
    } else {
      sink.set(ref.table, new Set([id]));
    }
  }
}

/**
 * Names a tier of fetched rows, keeping only the ones that could be named.
 *
 * A null label is dropped rather than recorded, because the lookup this feeds treats a missing
 * entry as "this parent cannot be named" and skips it — and "we looked and it has no name" means
 * exactly the same thing to the reader. Storing the null would only invite a caller to tell the two
 * apart and print something for a row that has nothing to say.
 *
 * `lookupParent` is what makes this recursive-looking without being recursive: pass one and the
 * rows are named after their own parents, omit it and the chain stops here. `hydrateMissingLabels`
 * omits it on the deepest tier it reads, and that omission IS the depth bound.
 */
function labelRowsByTable(
  rowsByTable: Map<string, Map<string, Record<string, unknown>>>,
  lookupParent?: ParentLabelLookup,
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();

  for (const [table, rows] of rowsByTable) {
    const labels = new Map<string, string>();

    for (const [id, row] of rows) {
      const label = buildRowLabel(table, row, lookupParent);

      if (label) {
        labels.set(id, label);
      }
    }

    if (labels.size > 0) {
      out.set(table, labels);
    }
  }

  return out;
}

/** Which of `restore_runs.error_class` this failure is. */
function classifyRunError(err: Error): string {
  const message = err.message.toLowerCase();

  if (err.name === 'ArchiveCipherError' || message.includes('passphrase')) {
    return 'crypto';
  }

  if (err.name === 'ArchiveReadError') {
    return 'permanent';
  }

  if (message.includes('timed out') || message.includes('econn')) {
    return 'transient';
  }

  return 'permanent';
}
