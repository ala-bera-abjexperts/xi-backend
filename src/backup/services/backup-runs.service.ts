/**
 * @fileoverview Run lifecycle — creation, listing, cancellation.
 * @module src/backup/services/backup-runs.service
 *
 * All three trigger paths (schedule, credentialed endpoint, manual "Backup now") funnel through
 * createRun. They differ only in `trigger_source` and in who is allowed to call them; nothing about
 * the run itself changes, so there is exactly one place where a run can be born.
 *
 * The run freezes what it needs at creation: selection, options, target config and scheme_version.
 * The engine never re-reads the scheme, so editing a scheme mid-run cannot change that run.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { ORG_CONCURRENT_RUN_LIMIT } from '../backup.constants';
import { STORAGE_SOURCES } from '../engine/backup-storage.service';
import { orderForInsert } from '../engine/restore-planner';
import {
  SECRET_BEARING_COMPONENTS,
  tableEntry,
  tablesForComponent,
} from '../registry/component-registry';
import { fkEdgesFor } from '../registry/restore-fk-graph';
import {
  DEFAULT_FILE_FORMAT,
  type BackupFileFormat,
} from '../engine/writers/table-writer';

const RUNS_TABLE = 'backup_runs';
const ITEMS_TABLE = 'backup_run_items';
const SCHEMES_TABLE = 'backup_schemes';
const TARGETS_TABLE = 'backup_targets';

const BACKUP_PARENT_DEPENDENCIES: Record<string, string[]> = {
  form_builder_orders: ['form_builder', 'form_builder_submissions'],
  form_builder_webhook_deliveries: ['form_builder_submissions'],
  form_builder_integration_deliveries: ['form_builder_submissions'],
};

const IMPLICIT_BACKUP_PARENT_TABLES = new Set([
  'organizations',
  'spaces',
  'users',
]);

/**
 * Columns safe to return to a browser.
 *
 * Never `select('*')` on backup_runs. The row carries `dek_wrapped`, `dek_iv` and `dek_tag` — the
 * per-run data key. It is wrapped by the scheme KEK so it is not directly usable, but sending it to
 * a client would put key material in the query cache, in devtools and in memory for no reason at
 * all. The snapshots and manifest are withheld here too: nothing renders them and they are large.
 */
const RUN_LIST_COLUMNS = [
  'id',
  'scheme_id',
  'target_id',
  'trigger_source',
  'status',
  'phase_detail',
  'scheme_version',
  'archive_bytes',
  'row_count',
  'table_count',
  'attempt_count',
  'max_attempts',
  'queued_at',
  'started_at',
  'finished_at',
  'duration_ms',
  'error_class',
  'error_message',
  'created_by',
  'created_at',
  'updated_at',
].join(', ');

/**
 * What the list query actually reads.
 *
 * `dek_wrapped` is fetched but NEVER returned: it is read only to answer "was this archive
 * encrypted?", and the wrapped key is stripped before the response is assembled. Deriving the
 * boolean here rather than sending the fingerprint keeps every `dek_*` value server-side.
 */
const RUN_LIST_QUERY_COLUMNS = [
  RUN_LIST_COLUMNS,
  'dek_wrapped',
  // The scheme's NAME, so a run says which backup it came from. `scheme_id` alone is a uuid an
  // admin cannot recognise, and the runs list shows several schemes interleaved.
  //
  // Aliased to `scheme`, and flattened to `scheme_name` before the response is assembled, so the
  // shape the client sees stays flat like every other column here. The `!scheme_id` hint names the
  // foreign key: only one links these two tables today, but an unhinted embed is exactly what broke
  // the exporter when a second relationship appeared.
  'scheme:backup_schemes!scheme_id(name)',
  // The target's NAME, for the same reason and by the same route. A run says where the archive was
  // written as well as which backup produced it; an organization with several targets cannot tell
  // those apart from a uuid.
  'target:backup_targets!target_id(name)',
].join(', ');

/**
 * Detail adds the frozen inputs an admin needs to explain what a run did — still no `dek_*`.
 * `key_fingerprint` IS included: a fingerprint is not a secret, and it is what tells an admin the
 * archive was sealed with a key the server no longer holds.
 */
const RUN_DETAIL_COLUMNS = [
  RUN_LIST_COLUMNS,
  'selection_snapshot',
  'options_snapshot',
  'target_config_snapshot',
  'manifest',
  'warnings',
  'schema_fingerprint',
  'archive_sha256',
  'key_fingerprint',
  'secrets_excluded',
  'correlation_id',
  'retention_expires_at',
].join(', ');

/** Statuses that mean "this run still occupies its scheme's single active slot". */
export const IN_FLIGHT_STATUSES = [
  'queued',
  'preflight',
  'exporting',
  'packaging',
  'uploading',
  'verifying',
] as const;

export type BackupTriggerSource =
  | 'manual'
  | 'schedule'
  | 'endpoint'
  | 'retention_probe';

export interface BackupRunItemPlan {
  tier: string;
  component_key: string;
  table_name: string | null;
  item_kind: 'table' | 'storage_prefix' | 'manifest' | 'volume';
  sequence: number;
  space_id?: string | null;
}

interface BackupRunItemPlanDetails {
  items: BackupRunItemPlan[];
  addedDependencyTables: string[];
  addedDependencyComponents: string[];
}

/** Item statuses that are finished, whatever the outcome. */
const SETTLED_ITEM_STATUSES = ['succeeded', 'skipped', 'failed', 'dead'];

/**
 * What a progress bar needs, without shipping 172 item rows per poll.
 *
 * `done` counts every settled item including failures — it measures how far the run has got, not
 * how well it went. `failed` is reported separately so the UI can colour the bar rather than
 * quietly presenting a half-broken run as progress.
 */
export interface RunProgress {
  total: number;
  done: number;
  failed: number;
  running: number;
  percent: number;
  /** The table currently being exported, for "Exporting tasks…". Null when nothing is running. */
  current: string | null;
}

/** Spread before mutating — this is shared across every run in a response. */
const EMPTY_PROGRESS: RunProgress = {
  total: 0,
  done: 0,
  failed: 0,
  running: 0,
  percent: 0,
  current: null,
};

export interface CreateRunOptions {
  organizationId: string;
  schemeId: string;
  triggerSource: BackupTriggerSource;
  userId?: string | null;
  triggerCredentialId?: string | null;
  idempotencyKey?: string | null;
  requestSha256?: string | null;
  correlationId?: string | null;

  /**
   * Overrides the scheme's export formats for this run only.
   *
   * Set by the "Backup now" dialog, which sends every format the operator ticked. Omitted by
   * scheduled and endpoint runs, which take whatever the scheme is configured for.
   */
  fileFormats?: BackupFileFormat[];
}

interface SchemeRow {
  id: string;
  organization_id: string;
  target_id: string;
  name: string;
  selection: { components?: string[]; tiers?: Record<string, boolean> };
  options: Record<string, unknown>;
  scheme_version: number;
  status: string;
  encrypt_archive: boolean;
}

interface TargetRow {
  id: string;
  target_type: string;
  auth_method: string;
  config: Record<string, unknown> | null;
  is_enabled: boolean;
  is_revoked: boolean;
}

interface DbError {
  message: string;
  code?: string;
  details?: string;
}

function backupParentTablesFor(table: string): string[] {
  if (!table.startsWith('form_builder_')) {
    return [];
  }

  const declared = fkEdgesFor(table)
    .filter((edge) => edge.required)
    .map((edge) => edge.references);
  const logical = BACKUP_PARENT_DEPENDENCIES[table] ?? [];

  return [...new Set([...declared, ...logical])].filter(
    (parent) =>
      parent !== table &&
      !IMPLICIT_BACKUP_PARENT_TABLES.has(parent) &&
      Boolean(tableEntry(parent)),
  );
}

function backupDependencyTables(selection: string[]): Set<string> {
  const wanted = new Set(selection);
  const dependencies = new Set<string>();
  const queue = [...selection];

  while (queue.length) {
    const table = queue.shift() as string;

    for (const parent of backupParentTablesFor(table)) {
      if (wanted.has(parent)) {
        continue;
      }

      const entry = tableEntry(parent);

      if (!entry || entry.tier === 'identity') {
        continue;
      }

      wanted.add(parent);
      dependencies.add(parent);
      queue.push(parent);
    }
  }

  return dependencies;
}

@Injectable()
export class BackupRunsService {
  private readonly logger = new Logger(BackupRunsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Expands a scheme's selection into the ordered unit list a run executes.
   *
   * Parents strictly before children (insertLevel), because the same order is what makes the
   * archive restorable. `sequence` is a single monotonic counter across the whole run rather than a
   * per-component ordinal — that is what keeps the unit key unique when one component contributes
   * several units.
   */
  buildItemPlan(components: string[]): BackupRunItemPlan[] {
    return this.buildItemPlanDetails(components).items;
  }

  private buildItemPlanDetails(components: string[]): BackupRunItemPlanDetails {
    const selectedComponents = new Set(components);
    const selectedEntries = components.flatMap((component) =>
      tablesForComponent(component),
    );
    const selectedTables = selectedEntries.map((entry) => entry.table);
    const dependencyTables = backupDependencyTables(selectedTables);
    const seen = new Set<string>();
    const byTable = new Map(
      selectedEntries.map((entry) => [entry.table, entry] as const),
    );

    for (const table of dependencyTables) {
      const entry = tableEntry(table);

      if (entry) {
        byTable.set(entry.table, entry);
      }
    }

    const tables = orderForInsert(
      [...byTable.values()].map((entry) => ({
        table: entry.table,
        component: entry.component,
        tier: entry.tier,
        insertLevel: entry.insertLevel,
        generatedColumns: [],
        addedAsDependency: dependencyTables.has(entry.table),
      })),
    )
      .map((planned) => byTable.get(planned.table))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .filter((entry) => {
        const key = `${entry.component}::${entry.table}`;

        if (seen.has(key)) {
          return false;
        }

        seen.add(key);

        return true;
      });

    const plan: BackupRunItemPlan[] = tables.map((entry, index) => ({
      tier: entry.tier,
      component_key: entry.component,
      table_name: entry.table,
      item_kind: 'table',
      sequence: index,
    }));

    // One unit per component that stores files, AFTER every table. The object list is read from
    // the version tables, so those rows have to be exported first — bytes whose metadata is
    // missing cannot be restored, and copying them first would only widen the window in which an
    // interrupted run holds one without the other.
    for (const component of new Set(tables.map((entry) => entry.component))) {
      if (!STORAGE_SOURCES.some((source) => source.component === component)) {
        continue;
      }

      plan.push({
        tier: 'binary_files',
        component_key: component,
        table_name: null,
        item_kind: 'storage_prefix',
        sequence: plan.length,
      });
    }

    // The manifest is written last because it carries the final counts, and read first on restore
    // via the ZIP central directory.
    plan.push({
      tier: 'configuration',
      component_key: '__manifest__',
      table_name: null,
      item_kind: 'manifest',
      sequence: plan.length,
    });

    const dependencyEntries = [...dependencyTables]
      .map((table) => tableEntry(table))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    return {
      items: plan,
      addedDependencyTables: dependencyEntries.map((entry) => entry.table),
      addedDependencyComponents: [
        ...new Set(
          dependencyEntries
            .map((entry) => entry.component)
            .filter((component) => !selectedComponents.has(component)),
        ),
      ],
    };
  }

  /**
   * Creates a queued run and its items in one transaction.
   *
   * @throws ConflictException when the scheme already has a run in flight, or the organization is
   *   at its concurrent-run limit.
   */
  /**
   * The formats this run will write, in order.
   *
   * The request wins, then the scheme's own list, then the scheme's legacy scalar, then the
   * product default. Duplicates are collapsed: the same format twice would write the same member
   * twice and hand archiver two entries of one name.
   */
  private resolveFormats(
    requested: BackupFileFormat[] | undefined,
    schemeOptions: Record<string, unknown> | undefined,
  ): BackupFileFormat[] {
    const fromScheme = Array.isArray(schemeOptions?.file_formats)
      ? (schemeOptions.file_formats as BackupFileFormat[])
      : schemeOptions?.file_format
        ? [schemeOptions.file_format as BackupFileFormat]
        : [];

    const chosen = requested?.length ? requested : fromScheme;

    return [...new Set(chosen)].length
      ? [...new Set(chosen)]
      : [DEFAULT_FILE_FORMAT];
  }

  async createRun(options: CreateRunOptions): Promise<{ id: string }> {
    const { organizationId, schemeId, triggerSource } = options;
    const scheme = await this.loadScheme(organizationId, schemeId);
    const target = await this.loadTarget(organizationId, scheme.target_id);

    if (!target.is_enabled || target.is_revoked) {
      throw new ConflictException(
        'The target for this scheme is disabled or revoked. Re-enable it before running a backup.',
      );
    }

    const components = scheme.selection?.components ?? [];

    if (!components.length) {
      throw new BadRequestException(
        'This scheme selects nothing to back up. Edit the scheme and choose at least one component.',
      );
    }

    const formats = this.resolveFormats(options.fileFormats, scheme.options);
    const planDetails = this.buildItemPlanDetails(components);
    this.assertDependencyEncryption(scheme, planDetails);
    const plan = planDetails.items;

    await this.assertOrgCapacity(organizationId);

    const { data, error } = (await this.db.rpc('create_backup_run', {
      p_organization_id: organizationId,
      p_scheme_id: schemeId,
      p_target_id: scheme.target_id,
      p_trigger_source: triggerSource,
      p_scheme_version: scheme.scheme_version,
      p_selection_snapshot: scheme.selection ?? {},
      // The chosen formats are merged into the FROZEN snapshot, not read from the scheme at
      // execution time — a scheme edited while a run is queued must not change what that run
      // produces. Falls back to the scheme default, then to SQL.
      p_options_snapshot: {
        ...(scheme.options ?? {}),
        // Both are written. `file_formats` is what the worker reads; the scalar stays so anything
        // reading a run the old way — the archives list, an older deploy mid-rollout — still sees
        // a format rather than nothing. It names the first layer.
        file_format: formats[0],
        file_formats: formats,
      },
      // Connection details only. The secret trio is never copied into a run, so a run row can be
      // read by anyone who can read runs without leaking the credential.
      p_target_config_snapshot: {
        id: target.id,
        target_type: target.target_type,
        auth_method: target.auth_method,
        config: target.config ?? {},
      },
      p_items: plan,
      p_created_by: options.userId ?? null,
      p_trigger_credential_id: options.triggerCredentialId ?? null,
      p_trigger_idempotency_key: options.idempotencyKey ?? null,
      p_trigger_request_sha256: options.requestSha256 ?? null,
      p_correlation_id: options.correlationId ?? null,
    })) as unknown as { data: string | null; error: DbError | null };

    if (error) {
      throw this.mapCreateError(error, schemeId);
    }

    if (!data) {
      throw new BadRequestException('The backup run could not be created');
    }

    this.writeAudit(organizationId, options.userId ?? null, data, {
      scheme_id: schemeId,
      trigger_source: triggerSource,
      item_count: plan.length,
    });

    return { id: data };
  }

  private assertDependencyEncryption(
    scheme: SchemeRow,
    plan: BackupRunItemPlanDetails,
  ): void {
    if (scheme.encrypt_archive || !plan.addedDependencyComponents.length) {
      return;
    }

    const secretComponents = plan.addedDependencyComponents.filter(
      (component) =>
        (SECRET_BEARING_COMPONENTS as readonly string[]).includes(component),
    );

    if (!secretComponents.length) {
      return;
    }

    throw new ConflictException(
      'This backup needs parent tables from credential-bearing components to make the selected ' +
        `rows restorable (${secretComponents.join(', ')}). Enable archive encryption before running it.`,
    );
  }

  /**
   * Turns a database error into the response the caller expects.
   *
   * 23505 from `backup_runs_one_active_per_scheme` is designed control flow, not a fault: it is how
   * two racing triggers are reduced to one run. Swallowing it would let a second run start.
   */
  private mapCreateError(error: DbError, schemeId: string): Error {
    const message = error.message ?? '';

    if (error.code === '23505' || message.includes('one_active_per_scheme')) {
      return new ConflictException(
        'A backup for this scheme is already running. Wait for it to finish, or cancel it first.',
      );
    }

    if (message.includes('at least one item')) {
      return new BadRequestException(
        'This scheme resolved to no backup work. Check its component selection.',
      );
    }

    if (error.code === 'PGRST202' || /does not exist/i.test(message)) {
      return new BadRequestException(
        'The backup scheduler migration has not been applied yet.',
      );
    }

    this.logger.error(
      `create_backup_run failed for scheme ${schemeId}: ${message}`,
    );

    return new BadRequestException(
      `Failed to start the backup run: ${message}`,
    );
  }

  /** One in-flight run per organization keeps a fleet from stampeding one customer's server. */
  private async assertOrgCapacity(organizationId: string): Promise<void> {
    const { count, error } = await this.db
      .from(RUNS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .in('status', IN_FLIGHT_STATUSES as unknown as string[]);

    if (error) {
      // Fails closed: an unverifiable count must not authorise a second concurrent export.
      throw new BadRequestException(
        `Could not check for running backups: ${error.message}`,
      );
    }

    if ((count ?? 0) >= ORG_CONCURRENT_RUN_LIMIT) {
      throw new ConflictException(
        'Another backup is already running for this organization.',
      );
    }
  }

  async list(
    organizationId: string,
    filters: { schemeId?: string; status?: string; limit?: number } = {},
  ): Promise<unknown[]> {
    let query = this.db
      .from(RUNS_TABLE)
      .select(RUN_LIST_QUERY_COLUMNS)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(Math.min(filters.limit ?? 50, 200));

    if (filters.schemeId) {
      query = query.eq('scheme_id', filters.schemeId);
    }

    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    const { data, error } = await query;

    if (error) {
      throw new BadRequestException(
        `Failed to list backup runs: ${error.message}`,
      );
    }

    const runs = (data ?? []) as unknown as {
      id: string;
      dek_wrapped: string | null;
      scheme: { name: string } | null;
      target: { name: string } | null;
    }[];
    const progress = await this.progressFor(
      organizationId,
      runs.map((run) => run.id),
    );

    // dek_wrapped is destructured out here and goes no further. A run carries a wrapped key only
    // when its archive was sealed, so its presence is the honest answer to "is this encrypted?".
    //
    // `scheme` is destructured out for a different reason: it is a join artefact, and flattening it
    // to `scheme_name` keeps the run shape flat rather than making every consumer reach through a
    // nested object that exists only because of how the row was read.
    return runs.map(({ dek_wrapped, scheme, target, ...run }) => ({
      ...run,
      // Null when the scheme has since been deleted. The run and its archive outlive it, so this
      // has to render as "unknown", never crash the list.
      scheme_name: scheme?.name ?? null,
      // Same for a deleted target: the archive it holds is still on that server, and a run that
      // cannot name where it wrote is worse than one that says the target is gone.
      target_name: target?.name ?? null,
      is_encrypted: dek_wrapped !== null,
      progress: progress.get(run.id) ?? EMPTY_PROGRESS,
    }));
  }

  /**
   * Per-run item tallies, in one query for the whole page of runs.
   *
   * Reading the item rows rather than a SQL aggregate keeps this on PostgREST without another RPC;
   * the row count is bounded by the page limit times the registry size, and only non-terminal runs
   * are ever polled.
   */
  private async progressFor(
    organizationId: string,
    runIds: string[],
  ): Promise<Map<string, RunProgress>> {
    const byRun = new Map<string, RunProgress>();

    if (!runIds.length) {
      return byRun;
    }

    const { data, error } = (await this.db
      .from(ITEMS_TABLE)
      .select('run_id, status, table_name, component_key')
      .eq('organization_id', organizationId)
      .in('run_id', runIds)) as unknown as {
      data:
        | {
            run_id: string;
            status: string;
            table_name: string | null;
            component_key: string;
          }[]
        | null;
      error: DbError | null;
    };

    if (error) {
      this.logger.warn(`Failed to read run progress: ${error.message}`);

      return byRun;
    }

    for (const item of data ?? []) {
      const current = byRun.get(item.run_id) ?? { ...EMPTY_PROGRESS };

      current.total += 1;

      if (SETTLED_ITEM_STATUSES.includes(item.status)) {
        current.done += 1;
      }

      if (item.status === 'failed' || item.status === 'dead') {
        current.failed += 1;
      }

      if (item.status === 'running') {
        current.running += 1;
        current.current = item.table_name ?? item.component_key;
      }

      byRun.set(item.run_id, current);
    }

    for (const progress of byRun.values()) {
      progress.percent =
        progress.total > 0
          ? Math.round((progress.done / progress.total) * 100)
          : 0;
    }

    return byRun;
  }

  async get(organizationId: string, runId: string): Promise<unknown> {
    return this.getRow(organizationId, runId);
  }

  async listItems(organizationId: string, runId: string): Promise<unknown[]> {
    // Through the run, so a run id from another organization 404s before any item is read.
    await this.getRow(organizationId, runId);

    // '*' is deliberate here, unlike on backup_runs: an item row holds progress counters and a
    // paging checkpoint, no key material and no secrets.
    const { data, error } = await this.db
      .from(ITEMS_TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('run_id', runId)
      .order('sequence', { ascending: true });

    if (error) {
      throw new BadRequestException(
        `Failed to list run items: ${error.message}`,
      );
    }

    return (data ?? []) as unknown[];
  }

  /**
   * Marks a run cancelled.
   *
   * Cancellation is not an error, so `error_class` stays null. The worker notices between steps;
   * cancelling also frees the scheme's active slot, which makes this the escape hatch for a run
   * that is wedged for any other reason.
   */
  async cancel(
    organizationId: string,
    runId: string,
    userId: string,
  ): Promise<{ success: true }> {
    const run = (await this.getRow(organizationId, runId)) as {
      id: string;
      status: string;
    };

    if (!(IN_FLIGHT_STATUSES as readonly string[]).includes(run.status)) {
      throw new ConflictException(
        `This run is already ${run.status} and cannot be cancelled.`,
      );
    }

    const { error } = await this.db
      .from(RUNS_TABLE)
      .update({
        status: 'cancelled',
        phase_detail: 'cancelled_by_user',
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId)
      .eq('organization_id', organizationId)
      // Conditional on the status we read, so a run that reached a terminal state in the meantime
      // is not dragged back out of it.
      .in('status', IN_FLIGHT_STATUSES as unknown as string[]);

    if (error) {
      throw new BadRequestException(
        `Failed to cancel the backup run: ${error.message}`,
      );
    }

    this.writeAudit(organizationId, userId, runId, { cancelled: true });

    return { success: true };
  }

  private async getRow(
    organizationId: string,
    runId: string,
  ): Promise<unknown> {
    const { data, error } = (await this.db
      .from(RUNS_TABLE)
      .select(RUN_DETAIL_COLUMNS)
      .eq('id', runId)
      .eq('organization_id', organizationId)
      .maybeSingle()) as unknown as {
      data: unknown;
      error: DbError | null;
    };

    if (error && error.code !== 'PGRST116') {
      throw new BadRequestException(
        `Failed to load the backup run: ${error.message}`,
      );
    }

    if (!data) {
      // 404 rather than 403: a 403 would confirm the id exists in another organization.
      throw new NotFoundException('Backup run not found');
    }

    return data;
  }

  private async loadScheme(
    organizationId: string,
    schemeId: string,
  ): Promise<SchemeRow> {
    // Named columns, not '*': the scheme row carries the archive passphrase ciphertext, and there
    // is no reason to pull it into memory just to read a version number.
    const { data, error } = (await this.db
      .from(SCHEMES_TABLE)
      .select(
        'id, organization_id, target_id, name, selection, options, scheme_version, status, encrypt_archive',
      )
      .eq('id', schemeId)
      .eq('organization_id', organizationId)
      .maybeSingle()) as unknown as {
      data: SchemeRow | null;
      error: DbError | null;
    };

    if (error && error.code !== 'PGRST116') {
      throw new BadRequestException(
        `Failed to load the backup scheme: ${error.message}`,
      );
    }

    if (!data) {
      throw new NotFoundException('Backup scheme not found');
    }

    return data;
  }

  private async loadTarget(
    organizationId: string,
    targetId: string,
  ): Promise<TargetRow> {
    const { data, error } = (await this.db
      .from(TARGETS_TABLE)
      .select('id, target_type, auth_method, config, is_enabled, is_revoked')
      .eq('id', targetId)
      .eq('organization_id', organizationId)
      .maybeSingle()) as unknown as {
      data: TargetRow | null;
      error: DbError | null;
    };

    if (error && error.code !== 'PGRST116') {
      throw new BadRequestException(
        `Failed to load the backup target: ${error.message}`,
      );
    }

    if (!data) {
      throw new NotFoundException('Backup target not found');
    }

    return data;
  }

  private writeAudit(
    organizationId: string,
    userId: string | null,
    runId: string,
    changes: Record<string, unknown>,
  ): void {
    // A scheduled or endpoint run has no acting user, so it is attributed to the system.
    const write = userId
      ? this.auditLogsService?.logAction(
          organizationId,
          userId,
          'backup_run',
          runId,
          'create',
          changes,
        )
      : this.auditLogsService?.logSystemAction(
          organizationId,
          'backup_run',
          runId,
          'create',
          changes,
        );

    void write?.catch((err: Error) =>
      this.logger.warn(`Audit write failed: ${err.message}`),
    );
  }
}
