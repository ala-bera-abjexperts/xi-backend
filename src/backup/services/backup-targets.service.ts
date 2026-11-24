/**
 * @fileoverview CRUD for backup targets. Credentials are write-only.
 * @module src/backup/services/backup-targets.service
 *
 * The service-role client bypasses RLS, so every query carries an explicit
 * .eq('organization_id', organizationId) taken from the authenticated user — never from the body.
 * Single-row reads go through getRow(), which is also the 404 gate.
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
import type { CreateBackupTargetDto } from '../dto/create-backup-target.dto';
import type { RotateTargetSecretDto } from '../dto/rotate-target-secret.dto';
import type { UpdateBackupTargetDto } from '../dto/update-backup-target.dto';
import type { BackupTargetSecretDto } from '../dto/backup-target-secret.dto';
import {
  AUTH_METHODS_BY_TARGET_TYPE,
  type BackupAuthMethod,
  type BackupTargetSecret,
  type BackupTargetType,
} from '../types/backup-target-secret.type';
import type { TargetVerifyResult } from '../adapters/backup-target-adapter.interface';
import { SftpTargetAdapter } from '../adapters/sftp/sftp.adapter';
import {
  resolveSftpHost,
  SftpHostError,
} from '../adapters/sftp/sftp-host-resolver';
import { BackupSecretsService } from './backup-secrets.service';

const TABLE = 'backup_targets';
const ARTIFACTS_TABLE = 'backup_artifacts';

/** Archives currently stored on a target. */
interface ArchiveStats {
  count: number;
  bytes: number;
}

const EMPTY_ARCHIVE_STATS: ArchiveStats = { count: 0, bytes: 0 };
const SCHEMES_TABLE = 'backup_schemes';

/** Whole-operation budget for a connection test, above the adapter's own handshake timeout. */
const TEST_DEADLINE_MS = 30_000;

/** last_test_error is a UI string, not a log. Keep it readable and bounded. */
const MAX_TEST_ERROR_CHARS = 500;

/** Stored row. Internal — never returned; toResponse() is the only projection. */
interface BackupTargetRow {
  id: string;
  organization_id: string;
  name: string;
  target_type: BackupTargetType;
  auth_method: BackupAuthMethod;
  config: Record<string, unknown>;
  secret_encrypted: string | null;
  secret_iv: string | null;
  secret_tag: string | null;
  key_fingerprint: string | null;
  is_enabled: boolean;
  is_revoked: boolean;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BackupTargetResponse {
  id: string;
  name: string;
  target_type: BackupTargetType;
  auth_method: BackupAuthMethod;
  config: Record<string, unknown>;
  masked_secret: string;
  key_fingerprint: string | null;
  /** False means AI_ENCRYPTION_SECRET was rotated and this target must be re-entered. */
  key_fingerprint_matches_server: boolean;
  is_enabled: boolean;
  is_revoked: boolean;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  last_used_at: string | null;
  scheme_count: number;
  /** Archives stored on this target right now (uploaded or verified, not deleted). */
  archive_count: number;
  /** Total size of those archives, in bytes. */
  archive_bytes: number;
  created_at: string;
  updated_at: string;
}

/** The service-role client is untyped, so single-row results are cast at the call site. */
interface DbSingle<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

@Injectable()
export class BackupTargetsService {
  private readonly logger = new Logger(BackupTargetsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly secrets: BackupSecretsService,
    private readonly sftpAdapter: SftpTargetAdapter,
    @Optional() private readonly auditLogsService?: AuditLogsService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async list(organizationId: string): Promise<BackupTargetResponse[]> {
    this.assertOrganization(organizationId);

    const { data, error } = await this.db
      .from(TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new BadRequestException(
        `Failed to list backup targets: ${error.message}`,
      );
    }

    const rows = (data ?? []) as BackupTargetRow[];

    // Two batched aggregates rather than a query per card.
    const [counts, archives] = await Promise.all([
      this.schemeCounts(organizationId),
      this.archiveStats(organizationId),
    ]);

    return rows.map((row) =>
      this.toResponse(
        row,
        counts.get(row.id) ?? 0,
        archives.get(row.id) ?? EMPTY_ARCHIVE_STATS,
      ),
    );
  }

  async get(organizationId: string, id: string): Promise<BackupTargetResponse> {
    const row = await this.getRow(organizationId, id);
    const [schemeCount, archives] = await Promise.all([
      this.schemeCount(organizationId, id),
      this.archiveStatsFor(organizationId, id),
    ]);

    return this.toResponse(row, schemeCount, archives);
  }

  async create(
    organizationId: string,
    userId: string,
    dto: CreateBackupTargetDto,
  ): Promise<BackupTargetResponse> {
    this.assertOrganization(organizationId);
    this.assertShapeMatchesType(dto.target_type, dto.auth_method, dto);

    const config = this.buildConfig(dto.target_type, dto);

    await this.assertHostAllowed(dto.target_type, config);

    const sealed = this.secrets.sealTargetSecret(
      this.buildSecretBundle(dto.auth_method, dto.secret),
    );

    const { data, error } = (await this.db
      .from(TABLE)
      .insert({
        organization_id: organizationId,
        name: dto.name,
        target_type: dto.target_type,
        auth_method: dto.auth_method,
        config,
        ...sealed,
        created_by: userId,
        updated_by: userId,
      })
      .select('*')
      .single()) as DbSingle<BackupTargetRow>;

    if (error) {
      throw this.mapWriteError(error, dto.name);
    }

    const row = data as BackupTargetRow;

    this.writeAudit(organizationId, userId, row.id, 'create', {
      name: row.name,
      target_type: row.target_type,
      auth_method: row.auth_method,
    });

    // A target is a sanctioned whole-tenant export path, so its creation is announced to every
    // owner rather than only audited.
    void this.notifyOrganizationOwners(
      organizationId,
      userId,
      row.id,
      'Backup target added',
      `A backup target "${row.name}" was added. Backups sent there leave this system.`,
    ).catch((err: Error) =>
      this.logger.warn(
        `Owner notification failed for target ${row.id}: ${err.message}`,
      ),
    );

    return this.toResponse(row, 0);
  }

  async update(
    organizationId: string,
    id: string,
    userId: string,
    dto: UpdateBackupTargetDto,
  ): Promise<BackupTargetResponse> {
    const existing = await this.getRow(organizationId, id);
    const patch: Record<string, unknown> = { updated_by: userId };

    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.is_enabled !== undefined) patch.is_enabled = dto.is_enabled;

    if (dto.sftp || dto.sharepoint) {
      // The config block must still match the target's own type.
      this.assertShapeMatchesType(
        existing.target_type,
        existing.auth_method,
        dto,
      );
      const config = this.buildConfig(existing.target_type, dto);

      await this.assertHostAllowed(existing.target_type, config);
      patch.config = config;
    }

    const { data, error } = (await this.db
      .from(TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single()) as DbSingle<BackupTargetRow>;

    if (error) {
      throw this.mapWriteError(error, dto.name ?? existing.name);
    }

    const row = data as BackupTargetRow;

    this.writeAudit(organizationId, userId, id, 'update', {
      fields: Object.keys(patch),
    });

    return this.toResponse(row, await this.schemeCount(organizationId, id));
  }

  /** The only way to change stored credentials. Clears the last-test result so it cannot lie. */
  async rotateSecret(
    organizationId: string,
    id: string,
    userId: string,
    dto: RotateTargetSecretDto,
  ): Promise<BackupTargetResponse> {
    const existing = await this.getRow(organizationId, id);
    const authMethod = dto.auth_method ?? existing.auth_method;

    this.assertAuthMethodForType(existing.target_type, authMethod);

    const sealed = this.secrets.sealTargetSecret(
      this.buildSecretBundle(authMethod, dto.secret),
    );

    const { data, error } = (await this.db
      .from(TABLE)
      .update({
        ...sealed,
        auth_method: authMethod,
        last_tested_at: null,
        last_test_ok: null,
        last_test_error: null,
        updated_by: userId,
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single()) as DbSingle<BackupTargetRow>;

    if (error) {
      throw this.mapWriteError(error, existing.name);
    }

    const row = data as BackupTargetRow;

    this.writeAudit(organizationId, userId, id, 'update', {
      secret_replaced: true,
      auth_method: authMethod,
    });

    void this.notifyOrganizationOwners(
      organizationId,
      userId,
      id,
      'Backup credentials replaced',
      `The credentials for backup target "${row.name}" were replaced.`,
    ).catch((err: Error) =>
      this.logger.warn(
        `Owner notification failed for target ${id}: ${err.message}`,
      ),
    );

    return this.toResponse(row, await this.schemeCount(organizationId, id));
  }

  async remove(
    organizationId: string,
    id: string,
    userId: string,
  ): Promise<{ success: true }> {
    const existing = await this.getRow(organizationId, id);

    const { error } = await this.db
      .from(TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) {
      // 23503: a scheme still references this target (ON DELETE RESTRICT).
      if (error.code === '23503') {
        throw new ConflictException(
          'This target is still used by a backup scheme and cannot be deleted',
        );
      }

      throw new BadRequestException(
        `Failed to delete backup target: ${error.message}`,
      );
    }

    this.writeAudit(organizationId, userId, id, 'delete', {
      name: existing.name,
    });

    return { success: true };
  }

  /** Decrypts the stored bundle for an adapter. Never called from a controller. */
  async openSecret(
    organizationId: string,
    id: string,
  ): Promise<BackupTargetSecret> {
    const row = await this.getRow(organizationId, id);

    return this.secrets.openTargetSecret(row);
  }

  /**
   * Connect to the target and prove the configured directory is writable.
   *
   * The outcome is recorded on the row whether it passed or failed, so a failure is visible in the
   * list rather than only in a toast the admin has already dismissed.
   */
  async testConnection(
    organizationId: string,
    userId: string,
    id: string,
  ): Promise<BackupTargetResponse> {
    const row = await this.getRow(organizationId, id);

    if (row.is_revoked) {
      throw new BadRequestException(
        'This target has been revoked. Re-enter its credentials before testing it.',
      );
    }

    const result = await this.runVerify(organizationId, row);

    const { data, error } = (await this.db
      .from(TABLE)
      .update({
        last_tested_at: new Date().toISOString(),
        last_test_ok: result.ok,
        last_test_error: result.ok
          ? null
          : (result.error ?? 'The connection failed.').slice(
              0,
              MAX_TEST_ERROR_CHARS,
            ),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single()) as DbSingle<BackupTargetRow>;

    if (error) {
      throw new BadRequestException(
        `Failed to record the test result: ${error.message}`,
      );
    }

    this.writeAudit(organizationId, userId, id, 'backup', {
      operation: 'test_connection',
      ok: result.ok,
      latency_ms: result.latencyMs ?? null,
    });

    return this.toResponse(
      data as BackupTargetRow,
      await this.schemeCount(organizationId, id),
    );
  }

  /**
   * Picks the adapter and turns anything it throws into a result.
   *
   * Decryption is the case that matters: openTargetSecret throws when AI_ENCRYPTION_SECRET has been
   * rotated, and letting that escape would surface a 500 instead of the one message that tells the
   * admin what to actually do.
   */
  private async runVerify(
    organizationId: string,
    row: BackupTargetRow,
  ): Promise<TargetVerifyResult> {
    if (row.target_type !== 'sftp') {
      return {
        ok: false,
        error:
          'Testing a SharePoint target is not available yet. It can be saved, but not verified.',
      };
    }

    try {
      const secret = this.secrets.openTargetSecret(row);

      return await this.sftpAdapter.verify({
        targetId: row.id,
        organizationId,
        config: row.config ?? {},
        secret,
        deadlineAt: new Date(Date.now() + TEST_DEADLINE_MS),
      });
    } catch (error) {
      const message = (error as Error).message;

      this.logger.warn(`Target ${row.id} verify failed: ${message}`);

      return { ok: false, error: message };
    }
  }

  /**
   * Refuses a host that resolves anywhere internal, at save time.
   *
   * The same check runs again immediately before every connect. Doing it here as well turns a
   * blocked host into a form error the admin can fix, instead of a target that saves cleanly and
   * then fails every test forever.
   */
  private async assertHostAllowed(
    targetType: BackupTargetType,
    config: Record<string, unknown>,
  ): Promise<void> {
    if (targetType !== 'sftp') {
      return;
    }

    const host = typeof config.host === 'string' ? config.host : '';
    const port = Number(config.port ?? 22);

    if (!host) {
      return; // Shape validation owns the missing-field message.
    }

    try {
      await resolveSftpHost(host, port);
    } catch (error) {
      if (error instanceof SftpHostError) {
        // A name that does not resolve yet is not a reason to refuse the save — DNS may be added
        // later, and the connection test is where that surfaces. Only an internal address is fatal.
        if (error.code === 'dns_not_found') {
          return;
        }

        throw new BadRequestException(error.message);
      }

      throw error;
    }
  }

  private toResponse(
    row: BackupTargetRow,
    schemeCount: number,
    // Defaults to zero for write responses (create/rotate), where the caller invalidates and
    // refetches the list immediately anyway.
    archives: ArchiveStats = EMPTY_ARCHIVE_STATS,
  ): BackupTargetResponse {
    return {
      id: row.id,
      name: row.name,
      target_type: row.target_type,
      auth_method: row.auth_method,
      config: row.config ?? {},
      masked_secret: this.secrets.maskSecret(row.secret_encrypted),
      key_fingerprint: row.key_fingerprint,
      key_fingerprint_matches_server: this.secrets.fingerprintMatchesServer(
        row.key_fingerprint,
      ),
      is_enabled: row.is_enabled,
      is_revoked: row.is_revoked,
      last_tested_at: row.last_tested_at,
      last_test_ok: row.last_test_ok,
      last_test_error: row.last_test_error,
      last_used_at: row.last_used_at,
      scheme_count: schemeCount,
      archive_count: archives.count,
      archive_bytes: archives.bytes,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** Single-row read plus the 404 gate. Every public method that touches one row starts here. */
  private async getRow(
    organizationId: string,
    id: string,
  ): Promise<BackupTargetRow> {
    this.assertOrganization(organizationId);

    const { data, error } = (await this.db
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle()) as DbSingle<BackupTargetRow>;

    if (error) {
      throw new BadRequestException(
        `Failed to load backup target: ${error.message}`,
      );
    }

    // 404 rather than 403 for another org's id, so the response cannot confirm it exists.
    if (!data) {
      throw new NotFoundException('Backup target not found');
    }

    return data;
  }

  /**
   * How many archives are actually sitting on each target, and how much space they take.
   *
   * Counts only what a restore could really use: uploaded or verified, and not yet deleted. A run
   * that failed mid-upload leaves a `pending` row, and reporting that as a stored backup is exactly
   * the false reassurance a backup product must not give.
   */
  private async archiveStats(
    organizationId: string,
  ): Promise<Map<string, ArchiveStats>> {
    const stats = new Map<string, ArchiveStats>();

    const { data, error } = await this.db
      .from(ARTIFACTS_TABLE)
      .select('target_id, byte_size')
      .eq('organization_id', organizationId)
      .in('upload_state', ['uploaded', 'verified'])
      .is('deleted_at', null);

    if (error) {
      this.logger.warn(`Failed to count archives per target: ${error.message}`);

      return stats;
    }

    for (const row of (data ?? []) as {
      target_id: string;
      byte_size: number | null;
    }[]) {
      const current = stats.get(row.target_id) ?? { count: 0, bytes: 0 };

      stats.set(row.target_id, {
        count: current.count + 1,
        bytes: current.bytes + (row.byte_size ?? 0),
      });
    }

    return stats;
  }

  private async archiveStatsFor(
    organizationId: string,
    targetId: string,
  ): Promise<ArchiveStats> {
    const all = await this.archiveStats(organizationId);

    return all.get(targetId) ?? EMPTY_ARCHIVE_STATS;
  }

  private async schemeCounts(
    organizationId: string,
  ): Promise<Map<string, number>> {
    const { data, error } = await this.db
      .from(SCHEMES_TABLE)
      .select('target_id')
      .eq('organization_id', organizationId);

    const counts = new Map<string, number>();

    if (error) {
      this.logger.warn(`Failed to count schemes per target: ${error.message}`);

      return counts;
    }

    for (const row of (data ?? []) as { target_id: string }[]) {
      counts.set(row.target_id, (counts.get(row.target_id) ?? 0) + 1);
    }

    return counts;
  }

  private async schemeCount(
    organizationId: string,
    targetId: string,
  ): Promise<number> {
    const { count, error } = await this.db
      .from(SCHEMES_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('target_id', targetId);

    if (error) {
      this.logger.warn(
        `Failed to count schemes for target ${targetId}: ${error.message}`,
      );

      return 0;
    }

    return count ?? 0;
  }

  /** Mirrors backup_targets_auth_matches_type_check so a mismatch is a 400, not a 23514-derived 500. */
  private assertShapeMatchesType(
    targetType: BackupTargetType,
    authMethod: BackupAuthMethod,
    dto: { sftp?: unknown; sharepoint?: unknown },
  ): void {
    if (targetType === 'sftp' && !dto.sftp) {
      throw new BadRequestException(
        'An SFTP target requires an `sftp` configuration block',
      );
    }

    if (targetType === 'sharepoint' && !dto.sharepoint) {
      throw new BadRequestException(
        'A SharePoint target requires a `sharepoint` configuration block',
      );
    }

    this.assertAuthMethodForType(targetType, authMethod);
  }

  private assertAuthMethodForType(
    targetType: BackupTargetType,
    authMethod: BackupAuthMethod,
  ): void {
    if (!AUTH_METHODS_BY_TARGET_TYPE[targetType].includes(authMethod)) {
      throw new BadRequestException(
        `auth_method "${authMethod}" is not valid for target_type "${targetType}"`,
      );
    }
  }

  private buildConfig(
    targetType: BackupTargetType,
    dto: { sftp?: unknown; sharepoint?: unknown },
  ): Record<string, unknown> {
    const block = targetType === 'sftp' ? dto.sftp : dto.sharepoint;

    return (block ?? {}) as Record<string, unknown>;
  }

  /**
   * Picks the fields the auth method actually needs and rejects a bundle missing any of them.
   * class-validator cannot express this because the required set depends on a sibling property.
   */
  private buildSecretBundle(
    authMethod: BackupAuthMethod,
    secret: BackupTargetSecretDto,
  ): BackupTargetSecret {
    const require = (value: string | undefined, field: string): string => {
      if (!value) {
        throw new BadRequestException(
          `secret.${field} is required for auth_method "${authMethod}"`,
        );
      }

      return value;
    };

    switch (authMethod) {
      case 'sftp_password':
        return {
          auth_method: authMethod,
          password: require(secret.password, 'password'),
        };

      case 'sftp_private_key':
        return {
          auth_method: authMethod,
          private_key: require(secret.private_key, 'private_key'),
          ...(secret.passphrase ? { passphrase: secret.passphrase } : {}),
        };

      case 'graph_client_secret':
        return {
          auth_method: authMethod,
          tenant_id: require(secret.tenant_id, 'tenant_id'),
          client_id: require(secret.client_id, 'client_id'),
          client_secret: require(secret.client_secret, 'client_secret'),
        };

      case 'graph_certificate':
        return {
          auth_method: authMethod,
          tenant_id: require(secret.tenant_id, 'tenant_id'),
          client_id: require(secret.client_id, 'client_id'),
          private_key: require(secret.private_key, 'private_key'),
          thumbprint: require(secret.thumbprint, 'thumbprint'),
        };

      default:
        throw new BadRequestException(
          `Unsupported auth_method "${authMethod as string}"`,
        );
    }
  }

  private mapWriteError(
    error: { code?: string; message: string },
    name: string,
  ): BadRequestException | ConflictException {
    if (error.code === '23505') {
      return new ConflictException(
        `A backup target named "${name}" already exists`,
      );
    }

    return new BadRequestException(
      `Failed to save backup target: ${error.message}`,
    );
  }

  /** Empty during onboarding. Guard before any tenant-scoped query. */
  private assertOrganization(organizationId: string): void {
    if (!organizationId) {
      throw new BadRequestException('No active organization');
    }
  }

  private writeAudit(
    organizationId: string,
    userId: string,
    entityId: string,
    action: 'create' | 'update' | 'delete' | 'backup',
    changes: Record<string, unknown>,
  ): void {
    void this.auditLogsService
      ?.logAction(
        organizationId,
        userId,
        'backup_target',
        entityId,
        action,
        changes,
      )
      .catch((err: Error) =>
        this.logger.warn(`Audit write failed: ${err.message}`),
      );
  }

  /** Inserts one notification per org owner. Failure never fails the request. */
  private async notifyOrganizationOwners(
    organizationId: string,
    actorUserId: string,
    targetId: string,
    title: string,
    body: string,
  ): Promise<void> {
    const { data, error } = await this.db
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', organizationId)
      .eq('role', 'owner');

    if (error || !data?.length) {
      return;
    }

    const rows = (data as { user_id: string }[])
      .filter((member) => member.user_id !== actorUserId)
      .map((member) => ({
        organization_id: organizationId,
        user_id: member.user_id,
        type: 'backup_target_changed',
        title,
        body,
        reference_type: 'backup_target',
        reference_id: targetId,
      }));

    if (!rows.length) {
      return;
    }

    await this.db.from('notifications').insert(rows);
  }
}
