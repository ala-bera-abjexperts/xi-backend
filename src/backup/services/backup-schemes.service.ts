/**
 * @fileoverview CRUD for backup schemes.
 * @module src/backup/services/backup-schemes.service
 *
 * Same tenancy discipline as targets: the service-role client bypasses RLS, so every query carries
 * .eq('organization_id', organizationId) from the authenticated user, and single-row reads go
 * through getRow(), which is the 404 gate.
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
import type {
  CreateBackupSchemeDto,
  BackupSchemeStatus,
} from '../dto/create-backup-scheme.dto';
import type { UpdateBackupSchemeDto } from '../dto/update-backup-scheme.dto';
import {
  isKnownComponent,
  selectionHasSecrets,
} from '../registry/component-registry';
import {
  assertScheduleValid,
  BackupScheduleService,
  computeNextRunAt,
} from './backup-schedule.service';
import { BackupSecretsService } from './backup-secrets.service';

const TABLE = 'backup_schemes';
const TARGETS_TABLE = 'backup_targets';
const RUNS_TABLE = 'backup_runs';

interface BackupSchemeRow {
  id: string;
  organization_id: string;
  target_id: string;
  name: string;
  description: string | null;
  selection: Record<string, unknown>;
  options: Record<string, unknown>;
  include_binary_files: boolean;
  include_identity: boolean;
  encrypt_archive: boolean;
  archive_passphrase_encrypted: string | null;
  key_fingerprint: string | null;
  scheme_version: number;
  schedule_enabled: boolean;
  cron_expression: string | null;
  timezone: string;
  retention_count: number | null;
  retention_days: number | null;
  status: BackupSchemeStatus;
  last_run_at: string | null;
  last_run_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface BackupSchemeResponse extends Omit<
  BackupSchemeRow,
  'archive_passphrase_encrypted' | 'organization_id'
> {
  has_passphrase: boolean;
  key_fingerprint_matches_server: boolean;
  next_run_at: string | null;
}

/** The service-role client is untyped, so single-row results are cast at the call site. */
interface DbSingle<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

@Injectable()
export class BackupSchemesService {
  private readonly logger = new Logger(BackupSchemesService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly secrets: BackupSecretsService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
    // Optional for the same reason as the audit writer: the specs construct this service directly,
    // and a missing schedule row is self-healing — the tick reconciles it.
    @Optional() private readonly scheduleService?: BackupScheduleService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async list(organizationId: string): Promise<BackupSchemeResponse[]> {
    this.assertOrganization(organizationId);

    const { data, error } = await this.db
      .from(TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new BadRequestException(
        `Failed to list backup schemes: ${error.message}`,
      );
    }

    const rows = (data ?? []) as BackupSchemeRow[];

    // One batched read rather than one per row — the list is the hot path in Tenant Config.
    const nextRuns = this.scheduleService
      ? await this.scheduleService.nextRunByScheme(
          organizationId,
          rows.map((row) => row.id),
        )
      : {};

    return rows.map((row) =>
      this.toResponse(row, row.id in nextRuns ? nextRuns[row.id] : undefined),
    );
  }

  async get(organizationId: string, id: string): Promise<BackupSchemeResponse> {
    const row = await this.getRow(organizationId, id);

    return this.toResponse(row, await this.readNextRun(organizationId, id));
  }

  async create(
    organizationId: string,
    userId: string,
    dto: CreateBackupSchemeDto,
  ): Promise<BackupSchemeResponse> {
    this.assertOrganization(organizationId);
    await this.assertTargetBelongsToOrg(organizationId, dto.target_id);
    this.assertComponentsKnown(dto.selection.components);

    // Stored EXACTLY as it was ticked. This used to be widened through `componentsWithParents`, so
    // choosing `tasks` silently saved six components and backed up twenty tables — and because the
    // widened list was what got written, reopening the scheme showed six ticked and the operator's
    // real choice was gone for good.
    //
    // The restore half already works this way: `buildRestorePlan` sets `addedAsDependency: false`
    // for everything and REPORTS absent parents as `missingParentComponents` rather than quietly
    // adding them. Capture now matches that. An archive narrower than its foreign keys is a thing
    // the operator asked for and can see, which is the difference that matters.
    const selection = dto.selection;

    const timezone = dto.timezone ?? 'UTC';
    const scheduleEnabled = dto.schedule_enabled ?? false;

    this.assertSchedule(scheduleEnabled, dto.cron_expression, timezone);

    // encrypt_archive defaults true, and the DB requires the full passphrase trio whenever it is
    // true, so the passphrase has to arrive with this request.
    const encryptArchive = dto.encrypt_archive ?? true;

    // Checked on exactly what was ticked. While the selection was being widened behind the
    // operator's back this had to run on the widened list — a silently added parent could be a
    // component holding credentials, and leaving encryption off would then have written those
    // credentials in clear. Nothing is added any more, so the honest question is the only one left:
    // did the operator choose a component that stores secrets?
    this.assertEncryptionAllowed(encryptArchive, selection.components);
    const sealed = this.sealPassphraseOrThrow(
      encryptArchive,
      dto.archive_passphrase,
    );

    const { data, error } = (await this.db
      .from(TABLE)
      .insert({
        organization_id: organizationId,
        target_id: dto.target_id,
        name: dto.name,
        description: dto.description ?? null,
        selection: selection as unknown as Record<string, unknown>,
        options: (dto.options ?? {}) as unknown as Record<string, unknown>,
        include_binary_files: selection.tiers.binary_files,
        include_identity: selection.tiers.identity,
        encrypt_archive: encryptArchive,
        ...sealed,
        schedule_enabled: scheduleEnabled,
        cron_expression: dto.cron_expression ?? null,
        timezone,
        retention_count: dto.retention_count ?? null,
        retention_days: dto.retention_days ?? null,
        status: dto.status ?? 'draft',
        created_by: userId,
        updated_by: userId,
      })
      .select('*')
      .single()) as DbSingle<BackupSchemeRow>;

    if (error) {
      throw this.mapWriteError(error, dto.name);
    }

    const row = data as BackupSchemeRow;

    this.writeAudit(organizationId, userId, row.id, 'create', {
      name: row.name,
      target_id: row.target_id,
    });

    // After the scheme row, never before: the scheme is the record of truth, and a failed state
    // write is recoverable (the tick reconciles) while a failed scheme write is not.
    await this.syncScheduleState(row);

    return this.toResponse(row, await this.readNextRun(organizationId, row.id));
  }

  async update(
    organizationId: string,
    id: string,
    userId: string,
    dto: UpdateBackupSchemeDto,
  ): Promise<BackupSchemeResponse> {
    const existing = await this.getRow(organizationId, id);
    const patch: Record<string, unknown> = { updated_by: userId };

    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.retention_count !== undefined)
      patch.retention_count = dto.retention_count;
    if (dto.retention_days !== undefined)
      patch.retention_days = dto.retention_days;
    if (dto.status !== undefined) patch.status = dto.status;

    if (dto.target_id !== undefined) {
      await this.assertTargetBelongsToOrg(organizationId, dto.target_id);
      patch.target_id = dto.target_id;
    }

    if (dto.selection !== undefined) {
      this.assertComponentsKnown(dto.selection.components);

      // Verbatim, exactly as in create(). Editing a scheme must be able to NARROW it — while this
      // widened the list, unticking a component that some other component required simply put it
      // straight back, and the selection could only ever grow.
      const selection = dto.selection;

      this.assertEncryptionAllowed(
        existing.encrypt_archive,
        selection.components,
      );
      patch.selection = selection as unknown as Record<string, unknown>;
      patch.include_binary_files = selection.tiers.binary_files;
      patch.include_identity = selection.tiers.identity;
    }

    if (dto.options !== undefined) {
      patch.options = dto.options as unknown as Record<string, unknown>;
    }

    // A run freezes the scheme it started from, so any change to what or how must move the version.
    if (dto.selection !== undefined || dto.options !== undefined) {
      patch.scheme_version = existing.scheme_version + 1;
    }

    const scheduleEnabled = dto.schedule_enabled ?? existing.schedule_enabled;
    const cronExpression =
      dto.cron_expression !== undefined
        ? dto.cron_expression
        : existing.cron_expression;
    const timezone = dto.timezone ?? existing.timezone;

    if (
      dto.schedule_enabled !== undefined ||
      dto.cron_expression !== undefined ||
      dto.timezone !== undefined
    ) {
      this.assertSchedule(
        scheduleEnabled,
        cronExpression ?? undefined,
        timezone,
      );
      patch.schedule_enabled = scheduleEnabled;
      patch.cron_expression = cronExpression;
      patch.timezone = timezone;
    }

    const { data, error } = (await this.db
      .from(TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single()) as DbSingle<BackupSchemeRow>;

    if (error) {
      throw this.mapWriteError(error, dto.name ?? existing.name);
    }

    this.writeAudit(organizationId, userId, id, 'update', {
      fields: Object.keys(patch),
    });

    const updated = data as BackupSchemeRow;

    // Covers the PATCH {status:'active'} path too, which predates the activate route and would
    // otherwise leave a scheme active with no state row — invisible to the scheduler forever.
    await this.syncScheduleState(updated);

    return this.toResponse(updated, await this.readNextRun(organizationId, id));
  }

  /**
   * Moves a scheme between draft/active/paused and re-syncs the scheduler's view of it.
   *
   * Activation is deliberately its own verb rather than a PATCH field: it is the moment a scheme
   * starts exporting the tenant on a timer, and it deserves an explicit audit entry.
   */
  async setStatus(
    organizationId: string,
    id: string,
    userId: string,
    status: BackupSchemeStatus,
  ): Promise<BackupSchemeResponse> {
    const existing = await this.getRow(organizationId, id);

    if (status === 'active') {
      this.assertActivatable(existing);
    }

    const { data, error } = (await this.db
      .from(TABLE)
      .update({ status, updated_by: userId })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single()) as DbSingle<BackupSchemeRow>;

    if (error) {
      throw new BadRequestException(
        `Failed to change the scheme status: ${error.message}`,
      );
    }

    this.writeAudit(organizationId, userId, id, 'update', {
      status_changed: { from: existing.status, to: status },
    });

    const updated = data as BackupSchemeRow;

    await this.syncScheduleState(updated);

    return this.toResponse(updated, await this.readNextRun(organizationId, id));
  }

  /**
   * Preconditions for putting a scheme on a timer.
   *
   * These are checked here rather than at save time because a draft is allowed to be incomplete —
   * the point of activation is that it is the moment incompleteness stops being acceptable.
   */
  private assertActivatable(row: BackupSchemeRow): void {
    if (row.schedule_enabled) {
      // Re-validated on the stored values: a scheme saved before the timezone check tightened, or
      // edited directly in the database, must not reach the scheduler.
      this.assertSchedule(true, row.cron_expression ?? undefined, row.timezone);
    }

    if (
      row.encrypt_archive &&
      !this.secrets.fingerprintMatchesServer(row.key_fingerprint)
    ) {
      // The passphrase was sealed with a different AI_ENCRYPTION_SECRET, so nothing can unwrap it.
      // Left unchecked, every nightly run would fail at packaging with a crypto error.
      throw new ConflictException(
        'The archive passphrase for this scheme was encrypted with a different server key. ' +
          'Replace the passphrase before activating it.',
      );
    }
  }

  /** Replaces the archive passphrase. Safe while the scheme has no runs to re-wrap. */
  async rotatePassphrase(
    organizationId: string,
    id: string,
    userId: string,
    passphrase: string,
  ): Promise<{ success: true; key_fingerprint: string }> {
    await this.getRow(organizationId, id);

    const runCount = await this.runCount(organizationId, id);

    if (runCount > 0) {
      throw new ConflictException(
        'This scheme already has runs. Rotating the passphrase would orphan their archives.',
      );
    }

    const sealed = this.secrets.sealSchemePassphrase(passphrase);

    const { error } = await this.db
      .from(TABLE)
      .update({ ...sealed, encrypt_archive: true, updated_by: userId })
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) {
      throw new BadRequestException(
        `Failed to rotate the passphrase: ${error.message}`,
      );
    }

    this.writeAudit(organizationId, userId, id, 'update', {
      passphrase_rotated: true,
    });

    return { success: true, key_fingerprint: sealed.key_fingerprint };
  }

  /** Refuses while runs exist — their archives would lose the definition that produced them. */
  async remove(
    organizationId: string,
    id: string,
    userId: string,
  ): Promise<{ success: true }> {
    const existing = await this.getRow(organizationId, id);
    const runCount = await this.runCount(organizationId, id);

    if (runCount > 0) {
      throw new ConflictException(
        'This scheme has retained runs. Archive it instead of deleting it.',
      );
    }

    const { error } = await this.db
      .from(TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) {
      throw new BadRequestException(
        `Failed to delete backup scheme: ${error.message}`,
      );
    }

    this.writeAudit(organizationId, userId, id, 'delete', {
      name: existing.name,
    });

    return { success: true };
  }

  private toResponse(
    row: BackupSchemeRow,
    nextRunAt?: string | null,
  ): BackupSchemeResponse {
    const { archive_passphrase_encrypted, organization_id, ...rest } = row;

    void organization_id;

    return {
      ...rest,
      has_passphrase: Boolean(archive_passphrase_encrypted),
      key_fingerprint_matches_server: this.secrets.fingerprintMatchesServer(
        row.key_fingerprint,
      ),
      next_run_at: this.resolveNextRun(row, nextRunAt),
    };
  }

  /**
   * What the UI shows under "next run".
   *
   * The scheduler owns the real value. Falling back to a freshly computed preview is only correct
   * while no state row exists yet; once one does, showing a computed time would contradict what
   * actually fires after a DST shift or a skipped window.
   */
  private resolveNextRun(
    row: BackupSchemeRow,
    stateValue?: string | null,
  ): string | null {
    const willFire =
      row.schedule_enabled && row.cron_expression && row.status === 'active';

    if (!willFire) {
      return null;
    }

    if (stateValue !== undefined) {
      return stateValue;
    }

    try {
      return computeNextRunAt(
        {
          cronExpression: row.cron_expression as string,
          timezone: row.timezone,
        },
        new Date(),
      ).toISOString();
    } catch {
      return null;
    }
  }

  /** Mirrors the scheme onto the row the scheduler actually reads. */
  private async syncScheduleState(row: BackupSchemeRow): Promise<void> {
    await this.scheduleService?.upsertState({
      schemeId: row.id,
      organizationId: row.organization_id,
      scheduleEnabled: row.schedule_enabled,
      status: row.status,
      cronExpression: row.cron_expression,
      timezone: row.timezone,
    });
  }

  private async readNextRun(
    organizationId: string,
    schemeId: string,
  ): Promise<string | null | undefined> {
    if (!this.scheduleService) {
      return undefined;
    }

    const map = await this.scheduleService.nextRunByScheme(organizationId, [
      schemeId,
    ]);

    return schemeId in map ? map[schemeId] : undefined;
  }

  private async getRow(
    organizationId: string,
    id: string,
  ): Promise<BackupSchemeRow> {
    this.assertOrganization(organizationId);

    const { data, error } = (await this.db
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle()) as DbSingle<BackupSchemeRow>;

    if (error) {
      throw new BadRequestException(
        `Failed to load backup scheme: ${error.message}`,
      );
    }

    if (!data) {
      throw new NotFoundException('Backup scheme not found');
    }

    return data;
  }

  /** A target id from the body is never trusted — it must resolve inside the caller's own org. */
  private async assertTargetBelongsToOrg(
    organizationId: string,
    targetId: string,
  ): Promise<void> {
    const { data, error } = await this.db
      .from(TARGETS_TABLE)
      .select('id')
      .eq('id', targetId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) {
      throw new BadRequestException(
        `Failed to resolve the backup target: ${error.message}`,
      );
    }

    if (!data) {
      throw new NotFoundException('Backup target not found');
    }
  }

  /**
   * An unencrypted archive of a credential-bearing component is a credential dump. The frontend
   * disables the switch, but the frontend is not the control — this is.
   */
  private assertEncryptionAllowed(
    encryptArchive: boolean,
    components: string[],
  ): void {
    if (!encryptArchive && selectionHasSecrets(components)) {
      throw new BadRequestException(
        'Archive encryption cannot be switched off: the selection contains components that store credentials',
      );
    }
  }

  private assertComponentsKnown(components: string[]): void {
    const unknown = components.filter(
      (component) => !isKnownComponent(component),
    );

    if (unknown.length) {
      throw new BadRequestException(
        `Unknown backup component(s): ${unknown.join(', ')}`,
      );
    }
  }

  private assertSchedule(
    scheduleEnabled: boolean,
    cronExpression: string | undefined,
    timezone: string,
  ): void {
    if (!scheduleEnabled) {
      return;
    }

    if (!cronExpression) {
      throw new BadRequestException(
        'A scheduled scheme requires a cron_expression',
      );
    }

    // Delegated so the zone is validated by actually advancing the iterator. parse() alone accepts
    // 'Europe/Berlin ' and 'GMT+2' and only throws later, inside the scheduler at 02:00.
    assertScheduleValid({ cronExpression, timezone });
  }

  private sealPassphraseOrThrow(
    encryptArchive: boolean,
    passphrase: string | undefined,
  ): Record<string, unknown> {
    if (!encryptArchive) {
      return {};
    }

    if (!passphrase) {
      throw new BadRequestException(
        'An encrypted scheme requires archive_passphrase. Without it no archive it produces can be restored.',
      );
    }

    return this.secrets.sealSchemePassphrase(passphrase) as unknown as Record<
      string,
      unknown
    >;
  }

  private async runCount(
    organizationId: string,
    schemeId: string,
  ): Promise<number> {
    const { count, error } = await this.db
      .from(RUNS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('scheme_id', schemeId);

    if (error) {
      // Fails CLOSED. This count is the only guard in remove() and rotatePassphrase(); returning 0
      // on a transient error would let a scheme with history be deleted, and backup_runs cascades
      // into backup_artifacts — orphaning every archive already sitting on the remote target, where
      // retention iterates the ledger and so could never find them again.
      throw new BadRequestException(
        `Could not verify the run history for this scheme: ${error.message}`,
      );
    }

    return count ?? 0;
  }

  private mapWriteError(
    error: { code?: string; message: string },
    name: string,
  ): BadRequestException | ConflictException {
    if (error.code === '23505') {
      return new ConflictException(
        `A backup scheme named "${name}" already exists`,
      );
    }

    return new BadRequestException(
      `Failed to save backup scheme: ${error.message}`,
    );
  }

  private assertOrganization(organizationId: string): void {
    if (!organizationId) {
      throw new BadRequestException('No active organization');
    }
  }

  private writeAudit(
    organizationId: string,
    userId: string,
    entityId: string,
    action: 'create' | 'update' | 'delete',
    changes: Record<string, unknown>,
  ): void {
    void this.auditLogsService
      ?.logAction(
        organizationId,
        userId,
        'backup_scheme',
        entityId,
        action,
        changes,
      )
      .catch((err: Error) =>
        this.logger.warn(`Audit write failed: ${err.message}`),
      );
  }
}
