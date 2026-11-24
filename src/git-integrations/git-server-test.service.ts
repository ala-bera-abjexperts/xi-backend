/**
 * @fileoverview "Test connection" for an organization's own Git server, and the server half of the
 * 5-minute health check (ticket 11).
 *
 * Both directions are checked:
 * - XISUITE → server: address policy, reachability + TLS, version, the app's credentials, GitHub's
 *   webhook settings.
 * - Server → XISUITE: a real event is sent back (GitHub redelivers the App's newest delivery, GitLab runs
 *   a project hook test) and we wait until it arrives (`git_servers.last_webhook_at`).
 *
 * Every check returns a stable `code`; the frontend renders the explanation and the fix. `detail` is the
 * raw message from Node / GitHub / GitLab, kept short.
 * @module src/git-integrations/git-server-test.service
 */

import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { lookup } from 'dns';
import { isIP } from 'net';
import { promisify } from 'util';

import { isBlockedAddress } from '../common/security/ssrf-guard';
import {
  describeFetchFailure,
  fetchFailureCode,
  isTlsChainFailure,
} from '../common/utils/fetch-failure.util';
import { GithubApiError, GithubAppClient } from './github/github-app.client';
import { GitlabApiError, GitlabClient } from './gitlab/gitlab.client';
import { GitlabIntegrationService } from './gitlab/gitlab-integration.service';
import type {
  IGitApp,
  IGitServerCheck,
  IGitServerRow,
  IGitServerTestResult,
} from './git-integrations.types';
import {
  GitServerAddressError,
  assertServerAddress,
} from './git-server-address.util';
import { GitServersService, isAppComplete } from './git-servers.service';

const dnsLookup = promisify(lookup);

/** Minimum versions (D1). Older: a warning, never a block. */
export const MIN_VERSION = { github: '3.12', gitlab: '16.0' } as const;

/** How long the test waits for the server's event to arrive. */
const INBOUND_WAIT_MS = 10_000;
const INBOUND_POLL_MS = 1_000;
/** One test per server per this interval (per instance). */
const TEST_INTERVAL_MS = 10_000;
/** GitHub: the server needs attention when this many newest deliveries all failed. */
const FAILED_DELIVERIES = 3;
const MAX_DETAIL = 300;

function short(text: string | null | undefined): string | undefined {
  return text ? text.slice(0, MAX_DETAIL) : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? describeFetchFailure(error) : String(error);
}

function skipped(key: IGitServerCheck['key']): IGitServerCheck {
  return { key, result: 'skipped', code: 'blocked_by_previous' };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "3.14.2" ≥ "3.12"? Unknown or unparsable versions count as supported. */
export function meetsVersion(version: string | null, minimum: string): boolean {
  const parse = (value: string) =>
    (/^(\d+)\.(\d+)/.exec(value) ?? []).slice(1).map(Number);
  const [major, minor] = version ? parse(version) : [];
  const [minMajor, minMinor] = parse(minimum);

  if (major === undefined || Number.isNaN(major)) return true;

  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * A failed request to the server as a stable code. Certificate problems are told apart, because only an
 * untrusted chain is fixed by `extra-ca.pem`; an expired or wrong-name certificate is not.
 */
export function classifyReachError(error: unknown): string {
  if (error instanceof GitServerAddressError) return error.code;
  if (error instanceof GithubApiError || error instanceof GitlabApiError)
    return error.status >= 300 && error.status < 400
      ? 'redirected'
      : 'unexpected_response';

  const code = fetchFailureCode(error);
  const name = error instanceof Error ? error.name : '';

  if (code === 'CERT_HAS_EXPIRED') return 'tls_expired';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'tls_name_mismatch';
  if (isTlsChainFailure(error)) return 'tls_untrusted';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_not_found';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT'
  )
    return 'timeout';
  if (code === 'EPROTO' || code === 'ERR_SSL_WRONG_VERSION_NUMBER')
    return 'tls_handshake_failed';

  return 'unreachable';
}

@Injectable()
export class GitServerTestService {
  private readonly logger = new Logger(GitServerTestService.name);
  private readonly lastRun = new Map<string, number>();

  constructor(
    private readonly servers: GitServersService,
    private readonly github: GithubAppClient,
    private readonly gitlab: GitlabClient,
    private readonly gitlabIntegration: GitlabIntegrationService,
  ) {}

  /**
   * Runs every check for one server of `organizationId`, stores the result and returns it.
   * @throws {HttpException} 429 'test_too_soon' when the same server was tested in the last 10 s.
   */
  async test(
    organizationId: string,
    serverId: string,
  ): Promise<IGitServerTestResult> {
    let server = await this.servers.get(organizationId, serverId);
    const last = this.lastRun.get(server.id);

    if (last && Date.now() - last < TEST_INTERVAL_MS)
      throw new HttpException(
        {
          code: 'test_too_soon',
          message: 'Wait a few seconds before testing again',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    this.lastRun.set(server.id, Date.now());

    const checks: IGitServerCheck[] = [];
    const app = this.servers.toApp(server);
    let version: string | null = null;

    // 1. Address policy
    const address = await this.checkAddress(app);

    checks.push(address);

    // 2. Reach + TLS, 3. version
    let reachable = false;

    if (address.result !== 'error') {
      const reach = await this.checkReach(app);

      checks.push(reach.check);
      reachable = reach.check.result !== 'error';
      version = reach.version;
      checks.push(this.versionCheck(app, reach.version, reachable));
    } else {
      checks.push(skipped('reach'), skipped('version'));
    }

    // 4. Credentials (a GitHub App's slug is read from GitHub here)
    let credentialsOk = false;

    if (reachable) {
      const credentials = await this.checkCredentials(server, app);

      checks.push(credentials);
      credentialsOk = credentials.result !== 'error';
      if (credentialsOk)
        server = await this.servers.get(organizationId, serverId);
    } else {
      checks.push(skipped('credentials'));
    }

    const ready = reachable && credentialsOk;
    const current = this.servers.toApp(server);

    // 5. GitHub webhook settings, 6. an event from the server
    if (app.provider === 'github') {
      checks.push(
        ready
          ? await this.checkGithubHookSettings(current)
          : skipped('webhook_settings'),
      );
      checks.push(
        ready
          ? await this.checkGithubInbound(server, current)
          : skipped('inbound'),
      );
    } else {
      checks.push(
        ready ? await this.checkGitlabInbound(server) : skipped('inbound'),
      );
    }

    // 7. Can a Git server reach XISUITE's address at all?
    checks.push(await this.checkPublicUrl(app));

    const result: IGitServerTestResult = {
      ok: !checks.some((check) => check.result === 'error'),
      checkedAt: new Date().toISOString(),
      version,
      checks,
    };

    await this.servers.saveTest(server, result);
    if (result.ok) await this.servers.setStatus(server, 'active', null, null);

    return result;
  }

  // ---------------------------------------------------------------------------
  // Checks
  // ---------------------------------------------------------------------------

  private async checkAddress(app: IGitApp): Promise<IGitServerCheck> {
    try {
      await assertServerAddress(app.webUrl, this.servers.onPremise);
    } catch (error) {
      return {
        key: 'address',
        result: 'error',
        code: classifyReachError(error),
        detail: short(errorText(error)),
      };
    }

    if (app.webUrl.startsWith('http:'))
      return { key: 'address', result: 'warning', code: 'http_insecure' };

    return { key: 'address', result: 'ok', code: 'ok' };
  }

  private async checkReach(
    app: IGitApp,
  ): Promise<{ check: IGitServerCheck; version: string | null }> {
    try {
      if (app.provider === 'github') {
        const meta = await this.github.getMeta(app);

        return {
          check: { key: 'reach', result: 'ok', code: 'ok' },
          version: meta.installed_version ?? null,
        };
      }

      const probe = await this.gitlab.probeVersion(app);

      if (!probe.isGitlab)
        return {
          check: {
            key: 'reach',
            result: 'error',
            code: 'not_gitlab',
            detail: `HTTP ${probe.status} from ${app.apiUrl}/version`,
          },
          version: null,
        };

      return {
        check: { key: 'reach', result: 'ok', code: 'ok' },
        version: probe.version,
      };
    } catch (error) {
      let code = classifyReachError(error);

      // It answered, but not like GitHub (`/meta` is public on github.com and every GHES).
      if (code === 'unexpected_response' && app.provider === 'github')
        code = 'not_github';

      return {
        check: {
          key: 'reach',
          result: 'error',
          code,
          detail: short(errorText(error)),
        },
        version: null,
      };
    }
  }

  private versionCheck(
    app: IGitApp,
    version: string | null,
    reachable: boolean,
  ): IGitServerCheck {
    if (!reachable) return skipped('version');
    // github.com itself has no version; GitLab tells its version only to a signed-in caller.
    if (!version)
      return {
        key: 'version',
        result: 'skipped',
        code: app.provider === 'gitlab' ? 'version_unknown' : 'version_cloud',
      };

    const minimum = MIN_VERSION[app.provider];

    return meetsVersion(version, minimum)
      ? { key: 'version', result: 'ok', code: 'ok', detail: version }
      : {
          key: 'version',
          result: 'warning',
          code: 'version_unsupported',
          detail: `${version} < ${minimum}`,
        };
  }

  private async checkCredentials(
    server: IGitServerRow,
    app: IGitApp,
  ): Promise<IGitServerCheck> {
    const redirectUri = `${this.servers.publicApiUrl}/git-integrations/${app.provider}/callback`;

    if (app.provider === 'github') {
      if (!app.appId || !app.privateKey)
        return { key: 'credentials', result: 'error', code: 'missing_app_key' };

      try {
        this.github.appJwt(app);
      } catch (error) {
        return {
          key: 'credentials',
          result: 'error',
          code: 'private_key_invalid',
          detail: short(errorText(error)),
        };
      }

      try {
        const ghApp = await this.github.getApp(app);

        if (ghApp.slug) await this.servers.saveSlug(server, ghApp.slug);
      } catch (error) {
        return {
          key: 'credentials',
          result: 'error',
          // 401 (key does not match the App ID) or 404 (no such App) — or a transport error.
          code:
            error instanceof GithubApiError &&
            (error.status < 300 || error.status >= 400)
              ? 'app_id_or_key_invalid'
              : classifyReachError(error),
          detail: short(errorText(error)),
        };
      }
    }

    if (!app.clientId || !app.clientSecret)
      return { key: 'credentials', result: 'error', code: 'missing_client' };

    try {
      const verdict =
        app.provider === 'github'
          ? await this.github.checkOAuthClient(app, redirectUri)
          : await this.gitlab.checkOAuthClient(app, redirectUri);

      if (verdict === 'client_invalid')
        return { key: 'credentials', result: 'error', code: 'client_invalid' };
      if (verdict === 'unknown')
        return {
          key: 'credentials',
          result: 'warning',
          code: 'client_unverified',
        };
    } catch (error) {
      return {
        key: 'credentials',
        result: 'warning',
        code: 'client_unverified',
        detail: short(errorText(error)),
      };
    }

    return { key: 'credentials', result: 'ok', code: 'ok' };
  }

  private async checkGithubHookSettings(
    app: IGitApp,
  ): Promise<IGitServerCheck> {
    const expected = this.servers.githubWebhookUrl(app.serverId!);

    try {
      const config = await this.github.getHookConfig(app);

      if (!config.url)
        return {
          key: 'webhook_settings',
          result: 'error',
          code: 'webhook_inactive',
          detail: `expected ${expected}`,
        };
      if (config.url.replace(/\/$/, '') !== expected)
        return {
          key: 'webhook_settings',
          result: 'error',
          code: 'webhook_url_mismatch',
          detail: short(`configured ${config.url}, expected ${expected}`),
        };
      if (config.content_type && config.content_type !== 'json')
        return {
          key: 'webhook_settings',
          result: 'error',
          code: 'webhook_content_type',
          detail: config.content_type,
        };
      // GitHub masks a set secret as "********" and returns nothing when there is none.
      if (!config.secret)
        return {
          key: 'webhook_settings',
          result: 'error',
          code: 'webhook_secret_missing',
        };

      return { key: 'webhook_settings', result: 'ok', code: 'ok' };
    } catch (error) {
      return {
        key: 'webhook_settings',
        result: 'warning',
        code: 'webhook_settings_unreadable',
        detail: short(errorText(error)),
      };
    }
  }

  /** GitHub: redeliver the App's newest delivery (normally the `ping` sent at creation) and wait for it. */
  private async checkGithubInbound(
    server: IGitServerRow,
    app: IGitApp,
  ): Promise<IGitServerCheck> {
    let newest: Awaited<
      ReturnType<GithubAppClient['listHookDeliveries']>
    >[number];

    try {
      [newest] = await this.github.listHookDeliveries(app, 1);
    } catch (error) {
      return {
        key: 'inbound',
        result: 'warning',
        code: 'deliveries_unreadable',
        detail: short(errorText(error)),
      };
    }

    if (!newest)
      return { key: 'inbound', result: 'warning', code: 'no_delivery_yet' };

    try {
      await this.servers.resetWebhookTouch(server);
      await this.github.redeliver(app, newest.id);
    } catch (error) {
      return {
        key: 'inbound',
        result: 'warning',
        code: 'redelivery_failed',
        detail: short(errorText(error)),
      };
    }

    if (await this.waitForEvent(server))
      return { key: 'inbound', result: 'ok', code: 'ok' };

    // What GitHub saw when it tried, e.g. "Couldn't connect to server" or "Invalid HTTP Response: 401".
    let status: string | undefined;

    try {
      const [latest] = await this.github.listHookDeliveries(app, 1);

      if (latest) status = `${latest.status} (${latest.status_code})`;
    } catch {
      // The explanation stays generic.
    }

    return {
      key: 'inbound',
      result: 'error',
      code: 'webhook_not_received',
      detail: short(status),
    };
  }

  /** GitLab: run a project hook test (GitLab sends it synchronously and reports its own error). */
  private async checkGitlabInbound(
    server: IGitServerRow,
  ): Promise<IGitServerCheck> {
    await this.servers.resetWebhookTouch(server);

    const outcome = await this.gitlabIntegration.testInboundHook(
      server.organization_id,
      server.host,
    );

    if (outcome.result === 'no_project')
      return { key: 'inbound', result: 'warning', code: 'no_project_yet' };
    if (outcome.result === 'blocked')
      return {
        key: 'inbound',
        result: 'error',
        code: 'local_network_blocked',
        detail: short(outcome.detail),
      };
    if (outcome.result === 'failed')
      return {
        key: 'inbound',
        result: 'error',
        code: 'webhook_failed',
        detail: short(outcome.detail),
      };

    return (await this.waitForEvent(server))
      ? { key: 'inbound', result: 'ok', code: 'ok' }
      : { key: 'inbound', result: 'error', code: 'webhook_not_received' };
  }

  private async waitForEvent(server: IGitServerRow): Promise<boolean> {
    for (let waited = 0; waited < INBOUND_WAIT_MS; waited += INBOUND_POLL_MS) {
      await sleep(INBOUND_POLL_MS);

      if (await this.servers.lastWebhookAt(server.organization_id, server.id))
        return true;
    }

    return false;
  }

  /**
   * XISUITE's own public address: localhost / http in SaaS means no Git server can reach it. On-premise a
   * private address is normal, but a GitLab then has to allow requests to the local network.
   */
  private async checkPublicUrl(app: IGitApp): Promise<IGitServerCheck> {
    const detail = this.servers.publicApiUrl;
    let url: URL;

    try {
      url = new URL(detail);
    } catch {
      return { key: 'public_url', result: 'error', code: 'public_url_invalid' };
    }

    let addresses: string[];

    try {
      addresses = isIP(url.hostname)
        ? [url.hostname]
        : (await dnsLookup(url.hostname, { all: true })).map(
            (entry) => entry.address,
          );
    } catch {
      return {
        key: 'public_url',
        result: 'warning',
        code: 'public_url_unresolvable',
        detail,
      };
    }

    const isPrivate = addresses.some((address) => isBlockedAddress(address));

    if (!this.servers.onPremise && (isPrivate || url.protocol === 'http:'))
      return {
        key: 'public_url',
        result: 'warning',
        code: 'public_url_unreachable',
        detail,
      };
    if (app.provider === 'gitlab' && isPrivate)
      return {
        key: 'public_url',
        result: 'warning',
        code: 'gitlab_local_network_needed',
        detail,
      };

    return { key: 'public_url', result: 'ok', code: 'ok', detail };
  }

  // ---------------------------------------------------------------------------
  // Health (5-minute cron)
  // ---------------------------------------------------------------------------

  /**
   * Every configured server: XISUITE → server reachability, and whether the server's events still arrive
   * (GitHub's delivery log, GitLab's hook alert status). Flips `needs_attention` / `active` through the
   * conditional {@link GitServersService.setStatus}, so several instances notify once.
   */
  async checkServers(): Promise<void> {
    let servers: IGitServerRow[];

    try {
      servers = await this.servers.listAll();
    } catch (error) {
      this.logger.warn(`server health: ${errorText(error)}`);

      return;
    }

    for (const server of servers) {
      try {
        await this.checkServer(server);
      } catch (error) {
        this.logger.warn(`server health ${server.id}: ${errorText(error)}`);
      }
    }
  }

  private async checkServer(server: IGitServerRow): Promise<void> {
    const app = this.servers.toApp(server);

    // A server still being set up in the wizard has nothing to watch yet.
    if (!isAppComplete(app)) return;

    try {
      await assertServerAddress(app.webUrl, this.servers.onPremise);

      if (app.provider === 'github') {
        await this.github.getMeta(app);
      } else if (!(await this.gitlab.probeVersion(app)).isGitlab) {
        return this.servers.setStatus(
          server,
          'needs_attention',
          'not_gitlab',
          app.apiUrl,
        );
      }
    } catch (error) {
      return this.servers.setStatus(
        server,
        'needs_attention',
        classifyReachError(error),
        errorText(error),
      );
    }

    const failing = await this.inboundFailure(server, app);

    if (failing)
      return this.servers.setStatus(
        server,
        'needs_attention',
        'webhook_failing',
        failing,
      );

    await this.servers.setStatus(server, 'active', null, null);
  }

  /** Why the server's events stopped arriving, or null. Read errors never flag a server. */
  private async inboundFailure(
    server: IGitServerRow,
    app: IGitApp,
  ): Promise<string | null> {
    if (app.provider === 'github') {
      try {
        const deliveries = await this.github.listHookDeliveries(
          app,
          FAILED_DELIVERIES,
        );
        const failed = (delivery: { status_code: number }) =>
          delivery.status_code === 0 || delivery.status_code >= 400;

        return deliveries.length >= FAILED_DELIVERIES &&
          deliveries.every(failed)
          ? `${deliveries[0].status} (${deliveries[0].status_code})`
          : null;
      } catch (error) {
        this.logger.debug(`deliveries ${server.id}: ${errorText(error)}`);

        return null;
      }
    }

    // Every hook still recorded as disabled counts, not only this tick's batch (no active/attention flapping).
    const { failing, failingTotal } =
      await this.gitlabIntegration.checkHookAlerts(
        server.organization_id,
        server.host,
      );

    if (!failing.length) return null;

    const listed = failing
      .slice(0, 5)
      .map((repo) => `${repo.fullName}: ${repo.alertStatus}`)
      .join(', ');
    const more = failingTotal - Math.min(failing.length, 5);

    return more > 0 ? `${listed} (+${more})` : listed;
  }
}
