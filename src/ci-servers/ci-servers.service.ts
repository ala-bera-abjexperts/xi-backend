/**
 * @fileoverview An organization's Jenkins servers (Tenant Configuration > Integrations): one saved address,
 * user name and API token each, which Test Management CI jobs on that server sign in with.
 *
 * The admin client bypasses RLS, so every query filters on `organization_id`. The encrypted token columns
 * never leave this service; responses carry `has_token: true` only.
 * @module src/ci-servers/ci-servers.service
 */

import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { assertPublicHttpUrl } from '../common/security/ssrf-guard';
import { decryptApiKey, encryptApiKey } from '../lib/crypto/encryption';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { GithubActionsError } from '../test-management/automation/test-automation-github.client';
import {
  readToolJson,
  tokenSecrets,
  type CiToolAccess,
} from '../test-management/automation/test-automation-gitlab.client';
import type { CreateCiServerDto, UpdateCiServerDto } from './dto/ci-server.dto';
import {
  basicAuthorization,
  flattenJobs,
  isJobUrlOf,
  JOBS_TREE,
  normalizeJenkinsUrl,
  type IJenkinsJob,
} from './jenkins-api';

const TABLE = 'ci_servers';
const CONFIGS = 'test_automation_configs';
const UNIQUE_VIOLATION = '23505';
const REASON_LIMIT = 500;
const PUBLIC_COLUMNS =
  'id, provider, name, base_url, username, status, status_reason, last_tested_at, created_at, updated_at';

export type CiServerStatus = 'active' | 'needs_attention';

export interface ICiServerDto {
  id: string;
  provider: 'jenkins';
  name: string;
  base_url: string;
  username: string;
  status: CiServerStatus;
  status_reason: string | null;
  last_tested_at: string | null;
  created_at: string;
  updated_at: string;
  has_token: true;
}

/** The stored row, encrypted token included: for server-side use only, never a response. */
export interface ICiServerRow extends Omit<ICiServerDto, 'has_token'> {
  organization_id: string;
  encrypted_secret: string;
  encryption_iv: string;
  encryption_tag: string;
}

export type CiServerFailureCode =
  | 'CI_ACCESS_UNAVAILABLE'
  | 'CI_TOOL_UNAVAILABLE';

export interface ICiServerTestResult {
  ok: boolean;
  status: CiServerStatus;
  reason: string | null;
  code?: CiServerFailureCode;
}

type PublicRow = Omit<ICiServerDto, 'has_token'>;

function badRequest(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}

function trimmed(value: string, code: string, label: string): string {
  const text = value.trim();

  if (!text) throw badRequest(code, `${label} is required`);

  return text;
}

function toDto(row: PublicRow): ICiServerDto {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    base_url: row.base_url,
    username: row.username,
    status: row.status,
    status_reason: row.status_reason,
    last_tested_at: row.last_tested_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_token: true,
  };
}

function failureCode(error: unknown): CiServerFailureCode {
  return error instanceof GithubActionsError &&
    (error.status === 401 || error.status === 403)
    ? 'CI_ACCESS_UNAVAILABLE'
    : 'CI_TOOL_UNAVAILABLE';
}

function failureReason(error: unknown): string {
  if (failureCode(error) === 'CI_ACCESS_UNAVAILABLE')
    return 'Jenkins refused the user name or API token';

  return error instanceof Error
    ? error.message
    : 'Jenkins could not be reached';
}

@Injectable()
export class CiServersService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly audit: AuditLogsService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** The organization's servers, without secrets. */
  async listForOrg(organizationId: string): Promise<ICiServerDto[]> {
    const { data, error } = await this.db
      .from(TABLE)
      .select(PUBLIC_COLUMNS)
      .eq('organization_id', organizationId)
      .order('name');

    if (error) throw new InternalServerErrorException(error.message);

    return ((data ?? []) as PublicRow[]).map(toDto);
  }

  /** The server a Jenkins job address belongs to (longest base address wins), or null. Carries the encrypted token. */
  async findForJobUrl(
    organizationId: string,
    url: string,
  ): Promise<ICiServerRow | null> {
    const { data, error } = await this.db
      .from(TABLE)
      .select('*')
      .eq('organization_id', organizationId);

    if (error) throw new InternalServerErrorException(error.message);

    return (
      ((data ?? []) as ICiServerRow[])
        .filter((server) => isJobUrlOf(server.base_url, url))
        .sort((a, b) => b.base_url.length - a.base_url.length)[0] ?? null
    );
  }

  /** One server of this organization with its encrypted token; null when it has no such server. */
  async rowFor(
    organizationId: string,
    id: string,
  ): Promise<ICiServerRow | null> {
    try {
      return await this.getRow(organizationId, id);
    } catch (error) {
      if (error instanceof NotFoundException) return null;

      throw error;
    }
  }

  /** The `Authorization` header value for calls to this server. */
  authorizationFor(server: ICiServerRow): string {
    const token = decryptApiKey(
      server.encrypted_secret,
      server.encryption_iv,
      server.encryption_tag,
    );

    return basicAuthorization(server.username, token);
  }

  /** Flags a server whose sign-in or address stopped working. */
  async markNeedsAttention(
    organizationId: string,
    id: string,
    reason: string,
  ): Promise<void> {
    await this.saveStatus(organizationId, id, {
      status: 'needs_attention',
      status_reason: reason.slice(0, REASON_LIMIT),
    });
  }

  /** The server's jobs and folders, two levels deep. */
  async listJobs(organizationId: string, id: string): Promise<IJenkinsJob[]> {
    const server = await this.getRow(organizationId, id);
    const access = this.access(server);
    let answer: unknown;

    try {
      answer = await readToolJson<unknown>(
        access,
        `${server.base_url}/api/json?tree=${JOBS_TREE}`,
      );
    } catch (error) {
      throw this.toolFailure(error);
    }

    const jobs = flattenJobs(server.base_url, answer);
    const listed = (answer as { jobs?: unknown } | null)?.jobs;

    // Jenkins builds job links from its own configured address; if that differs, every job would vanish silently.
    if (!jobs.length && Array.isArray(listed) && listed.length)
      throw new ConflictException({
        code: 'ROOT_URL_MISMATCH',
        message: `Jenkins lists its jobs under another address. Set Manage Jenkins > System > Jenkins URL to ${server.base_url}`,
      });

    return jobs;
  }

  async create(
    organizationId: string,
    userId: string,
    dto: CreateCiServerDto,
  ): Promise<ICiServerDto> {
    const name = trimmed(dto.name, 'INVALID_NAME', 'Name');
    const username = trimmed(dto.username, 'INVALID_USERNAME', 'User name');
    const baseUrl = await this.checkedBaseUrl(dto.base_url);
    const secret = encryptApiKey(
      trimmed(dto.api_token, 'INVALID_TOKEN', 'API token'),
    );

    const { data, error } = await this.db
      .from(TABLE)
      .insert({
        organization_id: organizationId,
        provider: 'jenkins',
        name,
        base_url: baseUrl,
        username,
        encrypted_secret: secret.encrypted,
        encryption_iv: secret.iv,
        encryption_tag: secret.tag,
        created_by: userId,
        updated_by: userId,
      })
      .select(PUBLIC_COLUMNS)
      .single();

    if (error) throw this.writeFailure(error, baseUrl);

    const server = data as PublicRow;

    void this.audit.logAction(
      organizationId,
      userId,
      'ci_server',
      server.id,
      'create',
      {
        event: 'ci_server_added',
        provider: 'jenkins',
        name,
        base_url: baseUrl,
      },
    );

    return toDto(server);
  }

  async update(
    organizationId: string,
    id: string,
    userId: string,
    dto: UpdateCiServerDto,
  ): Promise<ICiServerDto> {
    const current = await this.getRow(organizationId, id);
    const patch: Record<string, string> = {
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };
    const changed: string[] = [];

    if (dto.name !== undefined) {
      patch.name = trimmed(dto.name, 'INVALID_NAME', 'Name');
      changed.push('name');
    }

    if (dto.base_url !== undefined) {
      const baseUrl = await this.checkedBaseUrl(dto.base_url);

      if (baseUrl !== current.base_url) {
        await this.assertNotInUse(organizationId, current.base_url);
        patch.base_url = baseUrl;
        changed.push('base_url');
      }
    }

    if (dto.username !== undefined) {
      patch.username = trimmed(dto.username, 'INVALID_USERNAME', 'User name');
      changed.push('username');
    }

    if (dto.api_token !== undefined) {
      const secret = encryptApiKey(
        trimmed(dto.api_token, 'INVALID_TOKEN', 'API token'),
      );

      patch.encrypted_secret = secret.encrypted;
      patch.encryption_iv = secret.iv;
      patch.encryption_tag = secret.tag;
      changed.push('api_token');
    }

    const { data, error } = await this.db
      .from(TABLE)
      .update(patch)
      .eq('organization_id', organizationId)
      .eq('id', id)
      .select(PUBLIC_COLUMNS)
      .single();

    if (error)
      throw this.writeFailure(error, patch.base_url ?? current.base_url);

    const server = data as PublicRow;

    void this.audit.logAction(
      organizationId,
      userId,
      'ci_server',
      id,
      'update',
      { event: 'ci_server_changed', changed, base_url: server.base_url },
    );

    return toDto(server);
  }

  /** @throws {ConflictException} SERVER_IN_USE while a CI job setting points at this server. */
  async remove(
    organizationId: string,
    id: string,
    userId: string,
  ): Promise<void> {
    const server = await this.getRow(organizationId, id);

    await this.assertNotInUse(organizationId, server.base_url);

    const { error } = await this.db
      .from(TABLE)
      .delete()
      .eq('organization_id', organizationId)
      .eq('id', id);

    if (error) throw new InternalServerErrorException(error.message);

    void this.audit.logAction(
      organizationId,
      userId,
      'ci_server',
      id,
      'delete',
      {
        event: 'ci_server_removed',
        name: server.name,
        base_url: server.base_url,
      },
    );
  }

  /** Signs in as the saved user; passes only when Jenkins names that same user. */
  async test(
    organizationId: string,
    id: string,
    userId: string,
  ): Promise<ICiServerTestResult> {
    const server = await this.getRow(organizationId, id);
    const access = this.access(server);
    let result: ICiServerTestResult;

    try {
      const me = await readToolJson<{ id?: unknown }>(
        access,
        `${server.base_url}/me/api/json`,
      );

      result =
        typeof me?.id === 'string' &&
        me.id.toLowerCase() === server.username.toLowerCase()
          ? { ok: true, status: 'active', reason: null }
          : {
              ok: false,
              status: 'needs_attention',
              reason: 'Jenkins did not sign in as the saved user name',
              code: 'CI_ACCESS_UNAVAILABLE',
            };
    } catch (error) {
      result = {
        ok: false,
        status: 'needs_attention',
        reason: failureReason(error).slice(0, REASON_LIMIT),
        code: failureCode(error),
      };
    }

    await this.saveStatus(
      organizationId,
      id,
      result.ok
        ? {
            status: 'active',
            status_reason: null,
            last_tested_at: new Date().toISOString(),
          }
        : { status: 'needs_attention', status_reason: result.reason },
    );

    void this.audit.logAction(
      organizationId,
      userId,
      'ci_server',
      id,
      'update',
      { event: 'ci_server_tested', ok: result.ok, code: result.code ?? null },
    );

    return result;
  }

  private async getRow(
    organizationId: string,
    id: string,
  ): Promise<ICiServerRow> {
    const { data, error } = await this.db
      .from(TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle<ICiServerRow>();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data)
      throw new NotFoundException({
        code: 'SERVER_NOT_FOUND',
        message: 'CI server not found',
      });

    return data;
  }

  private async checkedBaseUrl(raw: string): Promise<string> {
    const baseUrl = normalizeJenkinsUrl(raw);

    if (!baseUrl)
      throw badRequest(
        'INVALID_URL',
        'Use an https:// address without a user name, query or hash',
      );

    try {
      await assertPublicHttpUrl(baseUrl);
    } catch {
      throw badRequest(
        'BLOCKED_HOST',
        'The address must be a public host that can be resolved',
      );
    }

    return baseUrl;
  }

  /** Read-only: the names of active CI job settings whose address is on `baseUrl`. */
  private async assertNotInUse(
    organizationId: string,
    baseUrl: string,
  ): Promise<void> {
    const { data, error } = await this.db
      .from(CONFIGS)
      .select('id, name, ci_url')
      .eq('organization_id', organizationId)
      .eq('kind', 'ci_job')
      .is('archived_at', null);

    if (error) throw new InternalServerErrorException(error.message);

    // Filtered here, not with LIKE, so `_` or `%` in a path can't widen the match.
    const jobs = (
      (data ?? []) as { id: string; name: string; ci_url: string | null }[]
    )
      .filter((row) => row.ci_url && isJobUrlOf(baseUrl, row.ci_url))
      .map((row) => row.name);

    if (jobs.length)
      throw new ConflictException({
        code: 'SERVER_IN_USE',
        message: `Used by CI jobs: ${jobs.join(', ')}`,
        jobs,
      });
  }

  private async saveStatus(
    organizationId: string,
    id: string,
    patch: Record<string, string | null>,
  ): Promise<void> {
    const { error } = await this.db
      .from(TABLE)
      .update(patch)
      .eq('organization_id', organizationId)
      .eq('id', id);

    if (error) throw new InternalServerErrorException(error.message);
  }

  private access(server: ICiServerRow): CiToolAccess {
    const authorization = this.authorizationFor(server);

    return {
      origin: new URL(server.base_url).origin,
      base: server.base_url,
      label: 'Jenkins',
      headers: { authorization, accept: 'application/json' },
      secrets: tokenSecrets(authorization),
    };
  }

  private writeFailure(
    error: { code?: string; message: string },
    baseUrl: string,
  ): HttpException {
    return error.code === UNIQUE_VIOLATION
      ? new ConflictException({
          code: 'DUPLICATE_SERVER',
          message: `${baseUrl} is already connected`,
        })
      : new InternalServerErrorException(error.message);
  }

  // A rejected token isn't an outage, so the screen asks for a working one instead of a retry.
  private toolFailure(error: unknown): HttpException {
    return failureCode(error) === 'CI_ACCESS_UNAVAILABLE'
      ? new ConflictException({
          code: 'CI_ACCESS_UNAVAILABLE',
          message: failureReason(error),
        })
      : new ServiceUnavailableException({
          code: 'CI_TOOL_UNAVAILABLE',
          message: failureReason(error),
        });
  }
}
