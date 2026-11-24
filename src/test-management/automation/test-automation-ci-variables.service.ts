import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import {
  CiServersService,
  type ICiServerDto,
  type ICiServerRow,
} from '../../ci-servers/ci-servers.service';
import { assertPublicHttpUrl } from '../../common/security/ssrf-guard';
import { TestManagementAccessService } from '../access/test-management-access.service';
import { TestManagementApiKeysService } from '../api-keys/test-management-api-keys.service';
import type {
  SaveApiKeyInCiDto,
  SendCiVariablesDto,
  SendCiVariablesResult,
  TestAutomationConfig,
  TestAutomationGitRepository,
} from '../dto/test-automation.dto';
import type { TestManagementApiKey } from '../dto/test-management-api-key.dto';
import { safeHttpsRequest, type CiRequestResult } from './safe-https-request';
import { TestAutomationConfigsService } from './test-automation-configs.service';
import {
  GitlabConnectionError,
  TestAutomationGitService,
  type ConnectedMatch,
  type GitlabMatch,
} from './test-automation-git.service';
import { putRepositoryVariable } from './test-automation-github.client';
import {
  ciToolFetch,
  gitlabBearerAccess,
  tokenSecrets,
  type CiToolAccess,
} from './test-automation-gitlab.client';

// The names the CI snippets read.
const KEY_NAME = 'XISUITE_TM_KEY';
const URL_NAME = 'XISUITE_URL';
const JENKINS_ID = 'xisuite-tm-key';
const KEY_PREFIX = 'CI · ';
const NAME_LIMIT = 100;

type Target =
  | { provider: 'github'; match: ConnectedMatch; manualUrl?: string }
  | { provider: 'gitlab'; access: CiToolAccess; projectUrl: string }
  | { provider: 'jenkins'; access: CiToolAccess };

const ok = (result: CiRequestResult): boolean =>
  !result.failure &&
  result.status !== undefined &&
  result.status >= 200 &&
  result.status < 300;

const xml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

function notConnected(message?: string): BadRequestException {
  return new BadRequestException({
    code: 'NOT_CONNECTED',
    message:
      message ??
      'Send to CI works only for a job that uses a connected GitHub, GitLab or Jenkins account',
  });
}

/** Puts a Test Management API key into the CI tool of a connected job, so its pipeline can upload results. */
@Injectable()
export class TestAutomationCiVariablesService {
  private readonly logger = new Logger(TestAutomationCiVariablesService.name);

  // per process only; several API instances would need a database lock.
  private readonly running = new Set<string>();

  constructor(
    private readonly access: TestManagementAccessService,
    private readonly configs: TestAutomationConfigsService,
    private readonly git: TestAutomationGitService,
    private readonly ciServers: CiServersService,
    private readonly apiKeys: TestManagementApiKeysService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async send(
    user: RequestUser,
    spaceId: string,
    configId: string,
    dto: SendCiVariablesDto,
  ): Promise<SendCiVariablesResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const config = await this.configs.get(user, spaceId, configId);

    if (config.archived_at) {
      throw new ConflictException({
        code: 'ARCHIVED',
        message: 'The automation setting is archived',
      });
    }

    if (config.kind !== 'ci_job' || !config.ci_url) {
      throw new BadRequestException({
        code: 'NOT_A_CI_JOB',
        message:
          config.kind !== 'ci_job'
            ? 'This setting runs tests on the runner, not in a CI tool'
            : 'This setting has no CI address',
      });
    }

    if (this.running.has(config.id)) {
      throw new ConflictException({
        code: 'IN_PROGRESS',
        message: 'Send to CI is already running for this job',
      });
    }

    this.running.add(config.id);

    try {
      return await this.sendOnce(user, spaceId, config, dto);
    } finally {
      this.running.delete(config.id);
    }
  }

  private async sendOnce(
    user: RequestUser,
    spaceId: string,
    config: TestAutomationConfig,
    dto: SendCiVariablesDto,
  ): Promise<SendCiVariablesResult> {
    // Looked up before the key exists, so a missing connection leaves no key behind.
    const target = await this.target(user.organizationId, config);

    return this.deliver(
      user,
      target,
      config.name,
      config.id,
      dto,
      (written, key) => ({
        entityType: 'test_automation_config',
        entityId: config.id,
        action: 'update',
        details: {
          event: 'ci_variables_sent',
          provider: target.provider,
          written,
          api_key_id: key.id,
          token_prefix: key.token_prefix,
          space_id: spaceId,
        },
      }),
    );
  }

  /** What the API keys card offers: connected GitHub and GitLab repositories, and Jenkins servers when licensed. */
  async targets(
    organizationId: string,
    user?: RequestUser,
  ): Promise<{
    repositories: TestAutomationGitRepository[];
    servers: ICiServerDto[];
  }> {
    const [repositories, licensed, keyEndings] = await Promise.all([
      this.git.connectedRepositories(organizationId),
      this.git.externalIntegrationsLicensed(organizationId),
      user ? this.activeCardKeyEndings(user) : new Set<string>(),
    ]);

    // A target that already holds an active key from this card is not offered again.
    const hasKey = (id: string) => keyEndings.has(` · ${id.slice(0, 8)}`);
    const servers = licensed
      ? await this.ciServers.listForOrg(organizationId)
      : [];

    return {
      repositories: repositories.filter(
        (repository) =>
          (repository.provider === 'github' ||
            repository.provider === 'gitlab') &&
          !hasKey(repository.id),
      ),
      servers: servers.filter((server) => !hasKey(server.id)),
    };
  }

  /** Name endings (" · " and a target id's first 8 characters) of the active keys saved in CI targets. */
  private async activeCardKeyEndings(user: RequestUser): Promise<Set<string>> {
    try {
      const keys = await this.apiKeys
        .list(user, true)
        .catch((error: unknown) => {
          if (error instanceof ForbiddenException) {
            return this.apiKeys.list(user, false);
          }

          throw error;
        });

      return new Set(
        keys
          .filter((key) => key.name.startsWith(KEY_PREFIX) && !key.expired)
          .map((key) => key.name.slice(key.name.lastIndexOf(' · '))),
      );
    } catch (error) {
      // Listing failed: every target stays offered rather than none.
      this.logger.warn(
        `CI API keys could not be listed for the target list: ${error instanceof Error ? error.message : String(error)}`,
      );

      return new Set();
    }
  }

  /** Creates a key and puts it into a connected repository or Jenkins server picked on the API keys card. */
  async sendToTarget(
    user: RequestUser,
    dto: SaveApiKeyInCiDto,
  ): Promise<SendCiVariablesResult> {
    const { provider, target_id: targetId, ...keyDto } = dto;
    const lock = `${provider}:${targetId}`;

    if (this.running.has(lock)) {
      throw new ConflictException({
        code: 'IN_PROGRESS',
        message: 'Send to CI is already running for this target',
      });
    }

    this.running.add(lock);

    try {
      const { target, label } = await this.targetById(
        user.organizationId,
        provider,
        targetId,
      );

      return await this.deliver(
        user,
        target,
        label,
        targetId,
        keyDto,
        (written, key) => ({
          entityType: 'test_management_api_key',
          entityId: key.id,
          action: 'create',
          details: {
            event: 'ci_key_saved',
            provider,
            written,
            target_id: targetId,
            token_prefix: key.token_prefix,
          },
        }),
      );
    } finally {
      this.running.delete(lock);
    }
  }

  /** Creates the key, writes it into the tool, then removes the earlier key made for the same owner. */
  private async deliver(
    user: RequestUser,
    target: Target,
    label: string,
    ownerId: string,
    dto: SendCiVariablesDto,
    audit: (
      written: string[],
      key: { id: string; token_prefix: string },
    ) => {
      entityType: string;
      entityId: string;
      action: 'create' | 'update';
      details: Record<string, unknown>;
    },
  ): Promise<SendCiVariablesResult> {
    const suffix = ` · ${ownerId.slice(0, 8)}`;
    const name = `${KEY_PREFIX}${label.slice(0, NAME_LIMIT - KEY_PREFIX.length - suffix.length)}${suffix}`;
    const { token, api_key } = await this.apiKeys.create(user, {
      ...dto,
      name,
    });
    const baseUrl = process.env.PUBLIC_API_URL ?? process.env.APP_URL ?? '';
    const written: string[] = [];
    const skipped: SendCiVariablesResult['skipped'] = [];
    let failure: CiRequestResult | null = null;

    try {
      if (target.provider === 'gitlab') {
        if (!baseUrl) {
          skipped.push({
            name: URL_NAME,
            reason: 'The server address is not set on this server',
          });
        }

        // The address goes first: if the key then fails, the job still has its old key.
        const variables: [string, string, boolean][] = [
          ...(baseUrl
            ? [[URL_NAME, baseUrl, false] as [string, string, boolean]]
            : []),
          [KEY_NAME, token, true],
        ];

        for (const [key, value, masked] of variables) {
          failure = await this.gitlabVariable(target, key, value, masked);

          if (failure) break;

          written.push(key);
        }
      } else if (target.provider === 'jenkins') {
        failure = await this.jenkinsCredential(target.access, token);

        if (!failure) written.push(JENKINS_ID);

        skipped.push({
          name: URL_NAME,
          reason:
            'Jenkins has no API for global variables; set it on the job or the agent',
        });
      } else {
        // GitHub only takes encrypted secrets, so the key is saved as a repository variable.
        const access = await this.git.actionsAccess(target.match);

        if (!baseUrl) {
          skipped.push({
            name: URL_NAME,
            reason: 'The server address is not set on this server',
          });
        }

        // The address goes first: if the key then fails, the job still has its old key.
        const variables: [string, string][] = [
          ...(baseUrl ? [[URL_NAME, baseUrl] as [string, string]] : []),
          [KEY_NAME, token],
        ];

        for (const [key, value] of variables) {
          const status = await putRepositoryVariable(access, key, value);

          if (status < 200 || status >= 300) {
            failure = { status, body: '' };

            break;
          }

          written.push(key);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Send to CI could not reach the CI tool: ${error instanceof Error ? error.message : String(error)}`,
      );
      failure = { body: '', failure: 'CI_UNREACHABLE' };
    }

    if (failure) {
      await this.revokeNew(user, api_key.id);

      throw this.refused(target.provider, failure);
    }

    const previous = await this.revokePrevious(user, api_key.id, suffix);
    const entry = audit(written, api_key);

    void this.auditLogs.logActionForRequest(
      user,
      entry.entityType,
      entry.entityId,
      entry.action,
      entry.details,
    );

    return {
      provider: target.provider,
      written,
      skipped,
      api_key: {
        id: api_key.id,
        name: api_key.name,
        token_prefix: api_key.token_prefix,
        expires_at: api_key.expires_at,
      },
      ...(target.provider === 'github' &&
        target.manualUrl && { manual_url: target.manualUrl }),
      previous,
    };
  }

  /** The CI tool and the access to write with; only a job started through a connection has one. */
  private async target(
    organizationId: string,
    config: TestAutomationConfig,
  ): Promise<Target> {
    const connected = config.ci_connected;
    const ciUrl = config.ci_url ?? '';

    if (connected && !connected.provider) {
      const found = await this.git.ciConnection(organizationId, ciUrl);

      if (found?.state === 'connected') {
        const page = found.match.repository.web_url?.replace(/\/+$/, '');

        return {
          provider: 'github',
          match: found.match,
          ...(page && { manualUrl: `${page}/settings/variables/actions` }),
        };
      }
    }

    if (connected?.provider === 'gitlab') {
      const match = await this.git.gitlabCiConnection(organizationId, ciUrl);

      if (match && match !== 'unavailable') {
        return this.gitlabTarget(organizationId, match);
      }
    }

    if (connected?.provider === 'jenkins') {
      const server = await this.ciServers.findForJobUrl(organizationId, ciUrl);

      if (server) return this.jenkinsTarget(server);
    }

    throw notConnected();
  }

  /** A repository or Jenkins server of this organization, picked by id; anything else counts as not connected. */
  private async targetById(
    organizationId: string,
    provider: SaveApiKeyInCiDto['provider'],
    id: string,
  ): Promise<{ target: Target; label: string }> {
    if (provider === 'github') {
      const found = await this.git.findRepositoryById(organizationId, id);

      if (found.state === 'connected') {
        const page = found.repository.web_url?.replace(/\/+$/, '');

        return {
          target: {
            provider: 'github',
            match: found,
            ...(page && { manualUrl: `${page}/settings/variables/actions` }),
          },
          label: found.repository.full_name,
        };
      }
    } else if (provider === 'gitlab') {
      const match = await this.git.gitlabRepositoryById(organizationId, id);

      if (match) {
        return {
          target: await this.gitlabTarget(organizationId, match),
          label: match.repository.full_name,
        };
      }
    } else if (await this.git.externalIntegrationsLicensed(organizationId)) {
      const server = await this.ciServers.rowFor(organizationId, id);

      if (server) {
        return { target: this.jenkinsTarget(server), label: server.name };
      }
    }

    throw notConnected(
      'Pick a repository or Jenkins server that is connected under Integrations',
    );
  }

  private async gitlabTarget(
    organizationId: string,
    match: GitlabMatch,
  ): Promise<Target> {
    let token: string;

    try {
      token = await this.git.gitlabToken(organizationId, match.connection);
    } catch (error) {
      if (error instanceof GitlabConnectionError) {
        throw notConnected(error.message);
      }

      throw error;
    }

    return {
      provider: 'gitlab',
      access: gitlabBearerAccess(match.app.apiUrl, token),
      projectUrl: `${match.app.apiUrl}/projects/${match.repository.external_id}`,
    };
  }

  private jenkinsTarget(server: ICiServerRow): Target {
    const authorization = this.ciServers.authorizationFor(server);

    return {
      provider: 'jenkins',
      access: {
        origin: new URL(server.base_url).origin,
        base: server.base_url,
        label: 'Jenkins',
        headers: {
          authorization,
          accept: 'application/json',
          'user-agent': 'XISUITE-Test-Management',
        },
        secrets: tokenSecrets(authorization),
      },
    };
  }

  // Only to the tool's own public host, like every other call with its login.
  private async write(
    access: CiToolAccess,
    url: string,
    method: 'POST' | 'PUT',
    contentType: string,
    body: string,
  ): Promise<CiRequestResult> {
    try {
      if (new URL(url).origin !== access.origin) throw new Error('off host');
      await assertPublicHttpUrl(url);
    } catch {
      return { body: '', failure: 'CI_BLOCKED_HOST' };
    }

    return safeHttpsRequest(
      url,
      method,
      { ...access.headers, 'content-type': contentType },
      body,
    );
  }

  /** Null when the project variable was created or updated; otherwise GitLab's answer. */
  private async gitlabVariable(
    target: Extract<Target, { provider: 'gitlab' }>,
    key: string,
    value: string,
    masked: boolean,
  ): Promise<CiRequestResult | null> {
    const created = await this.write(
      target.access,
      `${target.projectUrl}/variables`,
      'POST',
      'application/json',
      JSON.stringify({
        key,
        value,
        masked,
        protected: false,
        variable_type: 'env_var',
        environment_scope: '*',
      }),
    );

    if (ok(created)) return null;
    if (created.status !== 400 || !/already been taken/i.test(created.body)) {
      return created;
    }

    const updated = await this.write(
      target.access,
      `${target.projectUrl}/variables/${key}?filter%5Benvironment_scope%5D=*`,
      'PUT',
      'application/json',
      JSON.stringify({ value, masked, protected: false }),
    );

    return ok(updated) ? null : updated;
  }

  /** Null when the system credential holds the key and reads back; otherwise Jenkins's answer. */
  private async jenkinsCredential(
    access: CiToolAccess,
    token: string,
  ): Promise<CiRequestResult | null> {
    const store = `${access.base}/credentials/store/system/domain/_`;
    const credential = `${store}/credential/${JENKINS_ID}`;
    const description = 'Test Management API key for CI uploads';
    const before = await this.jenkinsStatus(access, credential);

    if (before !== 200 && before !== 404) return { status: before, body: '' };

    const sent =
      before === 200
        ? await this.write(
            access,
            `${credential}/config.xml`,
            'POST',
            'application/xml',
            '<org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl>' +
              `<scope>GLOBAL</scope><id>${xml(JENKINS_ID)}</id>` +
              `<description>${xml(description)}</description><secret>${xml(token)}</secret>` +
              '</org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl>',
          )
        : await this.write(
            access,
            `${store}/createCredentials`,
            'POST',
            'application/x-www-form-urlencoded',
            `json=${encodeURIComponent(
              JSON.stringify({
                '': '0',
                credentials: {
                  scope: 'GLOBAL',
                  id: JENKINS_ID,
                  secret: token,
                  description,
                  $class:
                    'org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl',
                },
              }),
            )}`,
          );

    // Jenkins answers a saved form with a redirect.
    if (sent.failure || ![200, 201, 302, 303].includes(sent.status ?? 0)) {
      return sent;
    }

    const after = await this.jenkinsStatus(access, credential);

    return after === 200 ? null : { status: after, body: '' };
  }

  private async jenkinsStatus(
    access: CiToolAccess,
    credential: string,
  ): Promise<number> {
    const response = await ciToolFetch(access, `${credential}/api/json`, 'GET');

    await response.body?.cancel();

    return response.status;
  }

  /** Tool replies are never echoed back, so no secret can travel in the message. */
  private refused(
    provider: Target['provider'],
    result: CiRequestResult,
  ): HttpException {
    const label =
      provider === 'gitlab'
        ? 'GitLab'
        : provider === 'github'
          ? 'GitHub'
          : 'Jenkins';
    const status = result.status;

    if (provider === 'gitlab' && status === 400 && /mask/i.test(result.body)) {
      return new ConflictException({
        code: 'CI_SECRET_WRITE_REFUSED',
        message:
          'GitLab refused to mask the variable value, so it was not saved',
      });
    }

    if (
      provider === 'github' &&
      (status === 401 || status === 403 || status === 404)
    ) {
      return new ConflictException({
        code: 'CI_SECRET_WRITE_REFUSED',
        message:
          "GitHub refused the variable. Give the XISUITE GitHub App 'Variables: Read and write' permission and accept it on the installation",
      });
    }

    if (status === 401 || status === 403) {
      return new ConflictException({
        code: 'CI_SECRET_WRITE_REFUSED',
        message:
          provider === 'gitlab'
            ? 'GitLab refused the variable. The connected GitLab user needs the Maintainer role on the project'
            : 'Jenkins refused the credential. The connected Jenkins user needs the Credentials Create and Update permissions',
      });
    }

    return new ServiceUnavailableException({
      code: 'CI_TOOL_UNAVAILABLE',
      message: status
        ? `${label} could not save the API key (answered ${status})`
        : `${label} could not be reached`,
    });
  }

  private async revokeNew(user: RequestUser, keyId: string): Promise<void> {
    try {
      await this.apiKeys.revoke(user, keyId);
    } catch (error) {
      this.logger.error(
        `The unused CI API key ${keyId} could not be revoked: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Keys of earlier sends for this job; keys the caller may not revoke are named, not removed. */
  private async revokePrevious(
    user: RequestUser,
    newKeyId: string,
    suffix: string,
  ): Promise<SendCiVariablesResult['previous']> {
    const previous: SendCiVariablesResult['previous'] = {
      revoked: 0,
      kept: [],
    };
    let keys: TestManagementApiKey[];

    try {
      keys = await this.apiKeys.list(user, true).catch((error: unknown) => {
        if (error instanceof ForbiddenException) {
          return this.apiKeys.list(user, false);
        }

        throw error;
      });
    } catch (error) {
      this.logger.warn(
        `Earlier CI API keys could not be listed: ${error instanceof Error ? error.message : String(error)}`,
      );

      return previous;
    }

    for (const key of keys) {
      if (
        key.id === newKeyId ||
        !key.name.startsWith(KEY_PREFIX) ||
        !key.name.endsWith(suffix)
      ) {
        continue;
      }

      try {
        await this.apiKeys.revoke(user, key.id);
        previous.revoked += 1;
      } catch (error) {
        if (
          !(error instanceof NotFoundException) &&
          !(error instanceof ForbiddenException)
        ) {
          this.logger.warn(
            `Earlier CI API key ${key.id} could not be revoked: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        previous.kept.push(key.owner?.name ?? key.owner?.email ?? key.name);
      }
    }

    return previous;
  }
}
