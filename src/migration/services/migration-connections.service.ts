/**
 * @fileoverview CRUD + connectivity testing for migration source connections.
 *
 * Credentials are encrypted at rest (AES-256-GCM via the shared `encryptApiKey`) into
 * `encrypted_secret`/`encryption_iv`/`encryption_tag` — mirroring `AutomationConnectionsService`.
 * The plaintext secret is NEVER returned; responses carry a `masked_secret`. All reads/writes are
 * hand-scoped by `organization_id` because the service-role client bypasses RLS.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { decryptApiKey, encryptApiKey } from '../../lib/crypto/encryption';
import { SourceAdapterFactory } from '../adapters/source-adapter.factory';
import type {
  ISourceAdapter,
  SourceAuthType,
  SourceDeployment,
  SourceProduct,
  TestConnectionResult,
} from '../adapters/source-adapter.interface';
import type { CreateConnectionDto } from '../dto/create-connection.dto';
import type { UpdateConnectionDto } from '../dto/update-connection.dto';
import type { TestConnectionDto } from '../dto/test-connection.dto';

const TABLE = 'migration_connections';

/** Mask the ciphertext for display (first 4 + dots + last 2), mirroring the automations pattern. */
function maskSecret(value: string | null | undefined): string {
  if (!value) return '••••••••';

  if (value.length <= 4) return '••••';

  return value.slice(0, 4) + '••••••••' + value.slice(-2);
}

export interface MigrationConnectionResponse {
  id: string;
  name: string;
  product: string;
  deployment: string | null;
  base_url: string;
  auth_type: string;
  auth_username: string | null;
  masked_secret: string;
  metadata: Record<string, unknown>;
  is_revoked: boolean;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Active Jira connection whose origin is safe to treat as a migration source. */
export interface JiraOriginConnection {
  id: string;
  baseUrl: string;
  origin: string;
}

/**
 * Shape of a `migration_connections` row. The service-role client is untyped (returns `any`),
 * so reads are cast to this interface — after which all downstream access is type-checked.
 */
interface MigrationConnectionRow {
  id: string;
  organization_id: string;
  name: string;
  product: SourceProduct;
  deployment: SourceDeployment | null;
  base_url: string;
  auth_type: SourceAuthType;
  auth_username: string | null;
  encrypted_secret: string;
  encryption_iv: string;
  encryption_tag: string;
  metadata: Record<string, unknown> | null;
  is_revoked: boolean;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  last_used_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class MigrationConnectionsService {
  private readonly logger = new Logger(MigrationConnectionsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly adapterFactory: SourceAdapterFactory,
    @Optional() private readonly auditLogsService?: AuditLogsService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  private toResponse(row: MigrationConnectionRow): MigrationConnectionResponse {
    return {
      id: row.id,
      name: row.name,
      product: row.product,
      deployment: row.deployment ?? null,
      base_url: row.base_url,
      auth_type: row.auth_type,
      auth_username: row.auth_username ?? null,
      masked_secret: maskSecret(row.encrypted_secret),
      metadata: row.metadata ?? {},
      is_revoked: row.is_revoked === true,
      last_tested_at: row.last_tested_at ?? null,
      last_test_ok: row.last_test_ok ?? null,
      last_test_error: row.last_test_error ?? null,
      last_used_at: row.last_used_at ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async list(orgId: string): Promise<MigrationConnectionResponse[]> {
    const { data, error } = (await this.db
      .from(TABLE)
      .select('*')
      .eq('organization_id', orgId)
      .eq('is_revoked', false)
      .order('created_at', { ascending: false })) as {
      data: MigrationConnectionRow[] | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(
        `Failed to list connections: ${error.message}`,
      );

    return (data ?? []).map((row) => this.toResponse(row));
  }

  async get(orgId: string, id: string): Promise<MigrationConnectionResponse> {
    const row = await this.getRow(orgId, id);

    return this.toResponse(row);
  }

  /**
   * The exact configured URL is migration render context, not a public connection response.
   * Keeping its path matters for Server installations mounted below `/jira` or `/confluence`.
   */
  async getBaseUrl(orgId: string, id: string): Promise<string | null> {
    const { data, error } = (await this.db
      .from(TABLE)
      .select('base_url')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()) as {
      data: { base_url: string | null } | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Failed to load connection URL: ${error.message}`,
      );
    }

    return data?.base_url ?? null;
  }

  /**
   * Finds active Jira sources by URL origin without exposing credentials. A source URL can be
   * relinked only when this returns exactly one connection for the organization.
   */
  async findActiveJiraConnectionsByOrigin(
    orgId: string,
    sourceUrl: string,
  ): Promise<JiraOriginConnection[]> {
    const origin = this.normalizedOrigin(sourceUrl);

    if (!origin) return [];

    const { data, error } = (await this.db
      .from(TABLE)
      .select('id, base_url')
      .eq('organization_id', orgId)
      .eq('product', 'jira')
      .eq('is_revoked', false)) as {
      data: { id: string; base_url: string | null }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Failed to list Jira connections: ${error.message}`,
      );
    }

    return (data ?? []).flatMap((row) => {
      const connectionOrigin = this.normalizedOrigin(row.base_url);

      return connectionOrigin === origin && row.base_url
        ? [{ id: row.id, baseUrl: row.base_url, origin: connectionOrigin }]
        : [];
    });
  }

  private async getRow(
    orgId: string,
    id: string,
  ): Promise<MigrationConnectionRow> {
    const { data, error } = (await this.db
      .from(TABLE)
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()) as {
      data: MigrationConnectionRow | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(
        `Failed to load connection: ${error.message}`,
      );
    if (!data) throw new NotFoundException('Migration connection not found');

    return data;
  }

  async create(
    orgId: string,
    userId: string,
    dto: CreateConnectionDto,
  ): Promise<MigrationConnectionResponse> {
    this.assertUsernameForBasic(dto.auth_type, dto.auth_username);

    const enc = encryptApiKey(dto.secret);
    const now = new Date().toISOString();

    const { data, error } = (await this.db
      .from(TABLE)
      .insert({
        organization_id: orgId,
        name: dto.name,
        product: dto.product,
        base_url: dto.base_url,
        auth_type: dto.auth_type,
        auth_username: dto.auth_username ?? null,
        encrypted_secret: enc.encrypted,
        encryption_iv: enc.iv,
        encryption_tag: enc.tag,
        metadata: {
          allow_insecure_http: dto.allow_insecure_http === true,
          allow_private_networks: dto.allow_private_networks === true,
        },
        is_revoked: false,
        created_by: userId,
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .single()) as {
      data: MigrationConnectionRow | null;
      error: { message: string; code?: string } | null;
    };

    if (error) {
      if (error.code === '23505')
        throw new ConflictException(
          `A connection named "${dto.name}" already exists`,
        );

      throw new BadRequestException(
        `Failed to create connection: ${error.message}`,
      );
    }

    const row = data as MigrationConnectionRow;

    void this.auditLogsService
      ?.logAction(orgId, userId, 'migration_connection', row.id, 'create', {
        product: dto.product,
      })
      .catch((err: unknown) =>
        this.logger.warn(`Audit write failed: ${(err as Error).message}`),
      );

    return this.toResponse(row);
  }

  async update(
    orgId: string,
    id: string,
    userId: string,
    dto: UpdateConnectionDto,
  ): Promise<MigrationConnectionResponse> {
    const existing = await this.getRow(orgId, id);
    const nextAuthType = dto.auth_type ?? existing.auth_type;
    const nextUsername =
      dto.auth_username !== undefined
        ? dto.auth_username
        : existing.auth_username;

    this.assertUsernameForBasic(nextAuthType, nextUsername);

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.base_url !== undefined) patch.base_url = dto.base_url;
    if (dto.auth_type !== undefined) patch.auth_type = dto.auth_type;
    if (dto.auth_username !== undefined)
      patch.auth_username = dto.auth_username;

    if (dto.secret !== undefined) {
      const enc = encryptApiKey(dto.secret);

      patch.encrypted_secret = enc.encrypted;
      patch.encryption_iv = enc.iv;
      patch.encryption_tag = enc.tag;
    }

    // Changing the target or credentials invalidates any previous test result —
    // otherwise the UI keeps showing "Connected" for an untested configuration.
    if (
      dto.base_url !== undefined ||
      dto.auth_type !== undefined ||
      dto.auth_username !== undefined ||
      dto.secret !== undefined
    ) {
      patch.last_tested_at = null;
      patch.last_test_ok = null;
      patch.last_test_error = null;

      if (dto.base_url !== undefined) patch.deployment = null;
    }

    if (
      dto.allow_insecure_http !== undefined ||
      dto.allow_private_networks !== undefined
    ) {
      const meta = existing.metadata ?? {};

      patch.metadata = {
        ...meta,
        ...(dto.allow_insecure_http !== undefined
          ? { allow_insecure_http: dto.allow_insecure_http }
          : {}),
        ...(dto.allow_private_networks !== undefined
          ? { allow_private_networks: dto.allow_private_networks }
          : {}),
      };
    }

    const { data, error } = (await this.db
      .from(TABLE)
      .update(patch)
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single()) as {
      data: MigrationConnectionRow | null;
      error: { message: string; code?: string } | null;
    };

    if (error) {
      if (error.code === '23505')
        throw new ConflictException(
          `A connection named "${dto.name}" already exists`,
        );

      throw new BadRequestException(
        `Failed to update connection: ${error.message}`,
      );
    }

    return this.toResponse(data as MigrationConnectionRow);
  }

  async remove(
    orgId: string,
    id: string,
    userId: string,
  ): Promise<{ success: true }> {
    await this.getRow(orgId, id);

    const { error } = await this.db
      .from(TABLE)
      .delete()
      .eq('organization_id', orgId)
      .eq('id', id);

    if (error)
      throw new BadRequestException(
        `Failed to delete connection: ${error.message}`,
      );

    void this.auditLogsService
      ?.logAction(orgId, userId, 'migration_connection', id, 'delete', {})
      .catch(() => {});

    return { success: true };
  }

  /**
   * Build a ready-to-use source adapter for a saved connection (org-scoped fetch +
   * decrypt + SSRF-validated). The single entry point other migration services
   * (discovery, run engine) use — they never touch credentials themselves.
   */
  async buildAdapter(orgId: string, id: string): Promise<ISourceAdapter> {
    const row = await this.getRow(orgId, id);

    if (row.is_revoked) {
      throw new BadRequestException('This connection has been revoked');
    }

    const secret = this.decryptRow(row);
    const meta = row.metadata ?? {};

    return this.adapterFactory.create({
      product: row.product,
      deployment: row.deployment,
      baseUrl: row.base_url,
      authType: row.auth_type,
      authUsername: row.auth_username,
      secret,
      allowInsecureHttp: meta.allow_insecure_http === true,
      allowPrivateNetworks: meta.allow_private_networks === true,
    });
  }

  /** Test a saved connection; persists detected deployment/version + last_test_* on the row. */
  async testSaved(orgId: string, id: string): Promise<TestConnectionResult> {
    const row = await this.getRow(orgId, id);
    const secret = this.decryptRow(row);
    const meta = row.metadata ?? {};

    const result = await this.runTest({
      product: row.product,
      baseUrl: row.base_url,
      authType: row.auth_type,
      authUsername: row.auth_username,
      secret,
      allowInsecureHttp: meta.allow_insecure_http === true,
      allowPrivateNetworks: meta.allow_private_networks === true,
    });

    const patch: Record<string, unknown> = {
      last_tested_at: new Date().toISOString(),
      last_test_ok: result.ok,
      last_test_error: result.ok ? null : (result.error ?? 'Connection failed'),
      updated_at: new Date().toISOString(),
    };

    if (result.ok) {
      patch.deployment = result.deployment;
      patch.metadata = {
        ...meta,
        server_version: result.version,
        deploymentType: result.deployment,
      };
    }

    const { error } = await this.db
      .from(TABLE)
      .update(patch)
      .eq('organization_id', orgId)
      .eq('id', id);

    if (error)
      this.logger.warn(
        `Failed to persist test result for ${id}: ${error.message}`,
      );

    return result;
  }

  /** Ad-hoc test with credentials supplied inline (wizard "Test connection" before save). Not persisted. */
  async testAdHoc(dto: TestConnectionDto): Promise<TestConnectionResult> {
    this.assertUsernameForBasic(dto.auth_type, dto.auth_username);

    return this.runTest({
      product: dto.product,
      baseUrl: dto.base_url,
      authType: dto.auth_type,
      authUsername: dto.auth_username,
      secret: dto.secret,
      allowInsecureHttp: dto.allow_insecure_http === true,
      allowPrivateNetworks: dto.allow_private_networks === true,
    });
  }

  private async runTest(ctx: {
    product: 'jira' | 'confluence';
    baseUrl: string;
    authType: 'basic' | 'pat' | 'oauth';
    authUsername?: string | null;
    secret: string;
    allowInsecureHttp: boolean;
    allowPrivateNetworks: boolean;
  }): Promise<TestConnectionResult> {
    const fallbackDeployment = /\.atlassian\.net$/i.test(
      this.safeHostname(ctx.baseUrl),
    )
      ? 'cloud'
      : 'server';

    try {
      const adapter = await this.adapterFactory.create({
        product: ctx.product,
        baseUrl: ctx.baseUrl,
        authType: ctx.authType,
        authUsername: ctx.authUsername,
        secret: ctx.secret,
        allowInsecureHttp: ctx.allowInsecureHttp,
        allowPrivateNetworks: ctx.allowPrivateNetworks,
      });

      return await adapter.testConnection();
    } catch (err) {
      // SSRF rejection / detection failure / auth strategy error.
      return {
        ok: false,
        deployment: fallbackDeployment,
        version: '',
        user: '',
        error: (err as Error).message,
      };
    }
  }

  private safeHostname(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  private normalizedOrigin(url: string | null | undefined): string | null {
    if (!url) return null;

    try {
      const parsed = new URL(url);

      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? parsed.origin
        : null;
    } catch {
      return null;
    }
  }

  private decryptRow(row: MigrationConnectionRow): string {
    try {
      return decryptApiKey(
        row.encrypted_secret,
        row.encryption_iv,
        row.encryption_tag,
      );
    } catch (err) {
      this.logger.error(
        `Decryption failed for connection ${row.id}: ${(err as Error).message}`,
      );
      throw new InternalServerErrorException(
        'Failed to decrypt connection secret — re-save the connection',
      );
    }
  }

  private assertUsernameForBasic(
    authType: string,
    username?: string | null,
  ): void {
    if (authType === 'basic' && !username) {
      throw new BadRequestException(
        'Basic auth requires a username (email for Cloud, username for Server)',
      );
    }
  }
}
