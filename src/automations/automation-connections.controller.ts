// Automation connections controller — OAuth start/callback, manual credentials, and resource pickers.

import { randomBytes, createHash } from 'crypto';

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Logger,
  Param,
  Query,
  Body,
  Res,
  UseGuards,
  BadRequestException,
  BadGatewayException,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import { AutomationConnectionsService } from './automation-connections.service';
import { packSecretForStorage } from '../lib/crypto/encryption';

@Controller('automations/connections')
export class AutomationConnectionsController {
  private readonly logger = new Logger(AutomationConnectionsController.name);

  constructor(
    private readonly connectionsService: AutomationConnectionsService,
  ) {}

  // List all active connections for a space
  @Get()
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async listConnections(@Query('spaceId') spaceId: string) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    const data = await this.connectionsService.listForSpace(spaceId);

    return { data };
  }

  // Health check a connection's stored credential (token / API key / OAuth) live against the provider.
  @Get(':id/check')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async checkConnection(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    const data = await this.connectionsService.checkStatus(id, spaceId);

    return { data };
  }

  // Revoke a connection
  @Delete(':connectionId')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_manage_automation_connections')
  async revokeConnection(
    @Param('connectionId') connectionId: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    await this.connectionsService.revoke(connectionId, spaceId);

    return { data: { ok: true } };
  }

  // Edit a manual connection in place. The account identity is immutable — see service.update().
  @Patch(':connectionId')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_manage_automation_connections')
  async updateConnection(
    @Param('connectionId') connectionId: string,
    @Query('spaceId') spaceId: string,
    @Body()
    body: {
      displayName?: string;
      metadata?: Record<string, unknown>;
      secret?: string;
    },
    @CurrentUser() user: RequestUser,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');

    const data = await this.connectionsService.update({
      connectionId,
      spaceId,
      organizationId: user.organizationId,
      displayName: body.displayName,
      metadata: body.metadata,
      secret: body.secret,
    });

    return { data };
  }

  // Save a manual API key / credential connection
  @Post('manual')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_manage_automation_connections')
  async createManualConnection(
    @Body()
    body: {
      spaceId: string;
      provider: string;
      displayName: string;
      secret: string;
      metadata?: Record<string, unknown>;
    },
    @CurrentUser() user: RequestUser,
  ) {
    if (!body.spaceId) throw new BadRequestException('spaceId is required');
    if (!body.provider) throw new BadRequestException('provider is required');
    if (!body.displayName)
      throw new BadRequestException('displayName is required');
    if (!body.secret) throw new BadRequestException('secret is required');

    const data = await this.connectionsService.create({
      spaceId: body.spaceId,
      organizationId: user.organizationId,
      provider: body.provider,
      displayName: body.displayName,
      secret: body.secret,
      metadata: body.metadata,
      createdBy: user.userId,
      // The mailbox address IS this connection's account identity. Storing it
      // makes the (space, provider, account) unique key real — otherwise a NULL
      // lets every re-submit create a duplicate — and it is what the inbound
      // poller compares against to detect the mailbox talking to itself.
      externalAccountId:
        body.provider === 'ms_graph_mailbox'
          ? ((body.metadata?.mailboxAddress as string | undefined)?.trim() ??
            null)
          : null,
    });

    return { data };
  }

  // Validate an unsaved API-key credential live against the provider (no persistence).
  // Param-less on purpose: SpacePermissionsGuard resolves the space from body.spaceId (a `:id`
  // segment would be mistaken for the spaceId). Powers the "Test connection" button.
  @Post('validate')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_manage_automation_connections')
  async validateConnection(
    @Body()
    body: {
      spaceId: string;
      provider: string;
      secret: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    if (!body.spaceId) throw new BadRequestException('spaceId is required');
    if (!body.provider) throw new BadRequestException('provider is required');
    if (!body.secret) throw new BadRequestException('secret is required');

    const data = await this.connectionsService.validateCredential(
      body.provider,
      body.secret,
      body.metadata,
    );

    return { data };
  }

  // List Slack channels
  @Get(':id/slack-channels')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async listSlackChannels(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');

    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);

    const res = await fetch(
      'https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200&exclude_archived=true',
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!res.ok) {
      throw new BadGatewayException(`Slack API returned ${res.status}`);
    }

    const json = (await res.json()) as {
      ok: boolean;
      error?: string;
      channels?: Array<{ id: string; name: string; is_private: boolean }>;
    };

    if (!json.ok) {
      throw new BadGatewayException(
        `Slack API error: ${json.error ?? 'unknown'}`,
      );
    }

    const data = (json.channels ?? [])
      .map((c) => ({ id: c.id, name: c.name, isPrivate: c.is_private }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { data };
  }

  // List Slack workspace members
  @Get(':id/slack-users')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async listSlackUsers(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');

    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);

    const res = await fetch('https://slack.com/api/users.list?limit=200', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new BadGatewayException('Failed to fetch Slack users');
    }

    const json = (await res.json()) as {
      ok: boolean;
      error?: string;
      members?: Array<{
        id: string;
        name: string;
        real_name?: string;
        is_bot: boolean;
        deleted: boolean;
        is_app_user: boolean;
      }>;
    };

    if (!json.ok) {
      throw new BadGatewayException(json.error ?? 'Slack API error');
    }

    const data = (json.members ?? [])
      .filter(
        (m) =>
          !m.is_bot && !m.deleted && !m.is_app_user && m.id !== 'USLACKBOT',
      )
      .map((m) => ({
        id: m.id,
        label: m.real_name ? `${m.real_name} (@${m.name})` : `@${m.name}`,
      }));

    return { data };
  }

  // List GitHub repositories
  @Get(':id/github-repos')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async listGithubRepos(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');

    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);

    const res = await fetch(
      'https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      const detail = errJson.message || res.statusText;

      throw new BadGatewayException(
        `GitHub API error (${res.status}): ${detail}`,
      );
    }

    const repos = (await res.json()) as Array<{
      full_name: string;
      name: string;
      owner: { login: string };
      private: boolean;
    }>;

    const data = repos.map((r) => ({
      fullName: r.full_name,
      name: r.name,
      owner: r.owner.login,
      isPrivate: r.private,
    }));

    return { data };
  }

  // List Jira projects
  @Get(':id/jira-projects')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async listJiraProjects(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');

    const [apiToken, meta] = await Promise.all([
      this.connectionsService.getDecryptedSecret(id, spaceId),
      this.connectionsService.getConnectionMetadata(id, spaceId),
    ]);

    let domain = meta['domain'] || meta['base_url'] || '';

    domain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const email = meta['email'] || '';

    if (!domain || !email) {
      throw new BadRequestException(
        'Jira connection is missing domain or email — re-save the connection',
      );
    }

    const basicAuth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    const res = await fetch(
      `https://${domain}/rest/api/3/project/search?maxResults=50`,
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          Accept: 'application/json',
        },
      },
    );

    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as {
        errorMessages?: string[];
      };
      const detail = errJson.errorMessages?.[0] || res.statusText;

      throw new BadGatewayException(
        `Jira API error (${res.status}): ${detail}`,
      );
    }

    const json = (await res.json()) as {
      values?: Array<{ key: string; name: string; id: string }>;
    };

    const data = (json.values ?? []).map((p) => ({
      key: p.key,
      name: p.name,
      id: p.id,
    }));

    return { data };
  }

  // List Jira issue types for a project
  @Get(':id/jira-issue-types')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async listJiraIssueTypes(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
    @Query('projectKey') projectKey: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    if (!projectKey) throw new BadRequestException('projectKey is required');

    const [apiToken, meta] = await Promise.all([
      this.connectionsService.getDecryptedSecret(id, spaceId),
      this.connectionsService.getConnectionMetadata(id, spaceId),
    ]);

    let domain = meta['domain'] || meta['base_url'] || '';

    domain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const email = meta['email'] || '';

    if (!domain || !email) {
      throw new BadRequestException(
        'Jira connection is missing domain or email — re-save the connection',
      );
    }

    const basicAuth = Buffer.from(`${email}:${apiToken}`).toString('base64');

    const res = await fetch(
      `https://${domain}/rest/api/3/project/${encodeURIComponent(projectKey)}`,
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          Accept: 'application/json',
        },
      },
    );

    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as {
        errorMessages?: string[];
      };
      const detail = errJson.errorMessages?.[0] || res.statusText;

      throw new BadGatewayException(
        `Jira API error (${res.status}): ${detail}`,
      );
    }

    const json = (await res.json()) as {
      issueTypes?: Array<{ id: string; name: string; subtask: boolean }>;
    };

    const data = (json.issueTypes ?? [])
      .filter((t) => !t.subtask)
      .map((t) => ({ id: t.id, name: t.name }));

    return { data };
  }

  // List GitHub labels for a repository
  @Get(':id/github-labels')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async listGithubLabels(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
    @Query('owner') owner: string,
    @Query('repo') repo: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    if (!owner || !repo)
      throw new BadRequestException('owner and repo are required');

    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);

    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      const detail = errJson.message || res.statusText;

      throw new BadGatewayException(
        `GitHub API error (${res.status}): ${detail}`,
      );
    }

    const json = (await res.json()) as Array<{ name: string; color: string }>;
    const data = json.map((l) => ({ name: l.name, color: l.color }));

    return { data };
  }

  // List Google Calendars
  @Get(':id/google-calendars')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async listGoogleCalendars(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');

    const token = await this.connectionsService.getGoogleAccessToken(
      id,
      undefined,
      spaceId,
    );

    const res = await fetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer',
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };

      throw new BadGatewayException(
        errJson.error?.message ?? 'Failed to fetch calendars',
      );
    }

    const json = (await res.json()) as {
      items?: Array<{ id: string; summary: string; primary?: boolean }>;
    };

    const data = (json.items ?? []).map((c) => ({
      id: c.id,
      label: `${c.summary}${c.primary ? ' (primary)' : ''}`,
      primary: !!c.primary,
    }));

    return { data };
  }

  // List Notion databases
  @Get(':id/notion-databases')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async listNotionDatabases(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');

    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);

    const res = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        filter: { property: 'object', value: 'database' },
        page_size: 50,
      }),
    });

    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as {
        message?: string;
      };

      throw new BadGatewayException(
        `Notion API error (${res.status}): ${errJson.message ?? res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      results?: Array<{
        id: string;
        title?: Array<{ plain_text?: string }>;
      }>;
    };

    const data = (json.results ?? []).map((db) => ({
      id: db.id,
      name: db.title?.[0]?.plain_text ?? 'Untitled',
    }));

    return { data };
  }

  // List properties of a Notion database
  @Get(':id/notion-database-properties')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async listNotionDatabaseProperties(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
    @Query('databaseId') databaseId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    if (!databaseId) throw new BadRequestException('databaseId is required');

    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);

    const res = await fetch(
      `https://api.notion.com/v1/databases/${databaseId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': '2022-06-28',
        },
      },
    );

    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as {
        message?: string;
      };

      throw new BadGatewayException(
        `Notion API error (${res.status}): ${errJson.message ?? res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      properties?: Record<
        string,
        {
          id: string;
          name: string;
          type: string;
          select?: { options: Array<{ name: string; color: string }> };
          multi_select?: { options: Array<{ name: string; color: string }> };
        }
      >;
    };

    const data = Object.values(json.properties ?? {}).map((p) => ({
      name: p.name,
      type: p.type,
      options: p.select?.options ?? p.multi_select?.options ?? [],
    }));

    return { data };
  }

  // List Linear teams
  @Get(':id/linear-teams')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async listLinearTeams(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');

    const apiKey = await this.connectionsService.getDecryptedSecret(
      id,
      spaceId,
    );

    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: '{ teams { nodes { id name key } } }' }),
    });

    if (!res.ok) {
      throw new BadGatewayException(
        `Linear API error (${res.status}): ${res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      data?: {
        teams?: { nodes?: Array<{ id: string; name: string; key: string }> };
      };
      errors?: Array<{ message?: string }>;
    };

    if (json.errors?.length) {
      throw new BadGatewayException(
        `Linear API error: ${json.errors[0]?.message ?? 'unknown'}`,
      );
    }

    const data = (json.data?.teams?.nodes ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      key: t.key,
    }));

    return { data };
  }

  // List Microsoft Teams joined by the connected account
  @Get(':id/teams-teams')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async listTeamsTeams(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');

    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);

    const res = await fetch('https://graph.microsoft.com/v1.0/me/joinedTeams', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok) {
      const json = (await res.json()) as {
        value?: Array<{ id: string; displayName: string }>;
      };

      return {
        data: (json.value ?? []).map((t) => ({
          id: t.id,
          name: t.displayName,
        })),
      };
    }

    // 403 = tenant Conditional Access blocks GetUserGroupsRequest — try memberOf fallback
    if (res.status === 403) {
      const fallback = await fetch(
        'https://graph.microsoft.com/v1.0/me/memberOf/microsoft.graph.group' +
          "?$filter=resourceProvisioningOptions/Any(x:x eq 'Team')&$select=id,displayName&$count=true",
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ConsistencyLevel: 'eventual',
          },
        },
      );

      if (fallback.ok) {
        const json = (await fallback.json()) as {
          value?: Array<{ id: string; displayName: string }>;
        };

        return {
          data: (json.value ?? []).map((t) => ({
            id: t.id,
            name: t.displayName,
          })),
        };
      }

      return { data: [] };
    }

    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };

    throw new BadGatewayException(
      `Microsoft Graph error (${res.status}): ${body.error?.message ?? res.statusText}`,
    );
  }

  // List channels in a Microsoft Teams team
  @Get(':id/teams-channels')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async listTeamsChannels(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
    @Query('teamId') teamId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    if (!teamId) throw new BadRequestException('teamId is required');

    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);

    const res = await fetch(
      `https://graph.microsoft.com/v1.0/teams/${teamId}/channels`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };

      throw new BadGatewayException(
        `Microsoft Graph error (${res.status}): ${body.error?.message ?? res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      value?: Array<{ id: string; displayName: string }>;
    };

    return {
      data: (json.value ?? []).map((c) => ({ id: c.id, name: c.displayName })),
    };
  }

  // Start OAuth flow for a provider
  @Post('oauth/start/:provider')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_manage_automation_connections')
  async oauthStart(
    @Param('provider') provider: string,
    @Body()
    body: {
      spaceId?: string;
      spaceKey?: string;
      returnTo?: string;
      origin?: string;
    },
    @CurrentUser() user: RequestUser,
  ) {
    const supported = [
      'slack',
      'google_calendar',
      'google_sheets',
      'google_drive',
      'notion',
      'teams',
      'discord',
      'outlook',
      'salesforce',
    ];

    if (!supported.includes(provider)) {
      throw new BadRequestException(`Unsupported OAuth provider: ${provider}`);
    }

    if (!body.spaceId) throw new BadRequestException('spaceId is required');

    const stateToken = randomBytes(32).toString('base64url');
    const apiUrl =
      process.env.AUTOMATIONS_PUBLIC_API_URL ??
      process.env.PUBLIC_API_URL ??
      'http://localhost:3001/api/v1';
    const returnTo =
      body.returnTo ??
      (body.spaceKey
        ? `/spaces/${body.spaceKey}/automations/connections`
        : '/');

    // The tenant subdomain the flow was actually started from (sent by the frontend as
    // window.location.origin), so the callback can send the browser back there instead of
    // the single static APP_URL. Validated before being trusted as a redirect target — never
    // persist an unchecked client-supplied value that later gets used for a 302 Location.
    const appOrigin = this.connectionsService.isKnownAppOrigin(body.origin)
      ? body.origin!
      : null;

    await this.connectionsService.createOAuthState({
      stateToken,
      userId: user.userId,
      spaceId: body.spaceId,
      organizationId: user.organizationId,
      provider,
      returnTo,
      appOrigin,
    });

    let redirectUrl: string;

    if (provider === 'slack') {
      const cb = `${apiUrl}/auth/callback/automation-slack`;

      redirectUrl =
        `https://slack.com/oauth/v2/authorize` +
        `?client_id=${process.env.SLACK_CLIENT_ID ?? ''}` +
        `&scope=chat:write,channels:read,groups:read,users:read,im:write` +
        `&redirect_uri=${encodeURIComponent(cb)}` +
        `&state=${stateToken}`;
    } else if (provider === 'notion') {
      const cb = `${apiUrl}/auth/callback/automation-notion`;

      redirectUrl =
        `https://api.notion.com/v1/oauth/authorize` +
        `?client_id=${process.env.NOTION_CLIENT_ID ?? ''}` +
        `&response_type=code` +
        `&owner=user` +
        `&redirect_uri=${encodeURIComponent(cb)}` +
        `&state=${stateToken}`;
    } else if (provider === 'teams') {
      const tenantId = process.env.AZURE_TENANT_ID ?? 'common';
      const cb = `${apiUrl}/automations/connections/oauth/callback/teams`;
      const teamsScopes = encodeURIComponent(
        'openid profile email offline_access' +
          ' https://graph.microsoft.com/ChannelMessage.Send' +
          ' https://graph.microsoft.com/Team.ReadBasic.All' +
          ' https://graph.microsoft.com/Channel.ReadBasic.All',
      );

      redirectUrl =
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize` +
        `?client_id=${process.env.AZURE_CLIENT_ID ?? ''}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(cb)}` +
        `&scope=${teamsScopes}` +
        `&state=${stateToken}` +
        `&response_mode=query`;
    } else if (provider === 'google_sheets') {
      const cb = `${apiUrl}/automations/connections/oauth/callback/google_sheets`;
      const scopes = encodeURIComponent(
        'openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly',
      );

      redirectUrl =
        `https://accounts.google.com/o/oauth2/v2/auth` +
        `?client_id=${process.env.GOOGLE_CLIENT_ID ?? ''}` +
        `&response_type=code` +
        `&scope=${scopes}` +
        `&access_type=offline` +
        `&prompt=consent` +
        `&redirect_uri=${encodeURIComponent(cb)}` +
        `&state=${stateToken}`;
    } else if (provider === 'google_drive') {
      const cb = `${apiUrl}/automations/connections/oauth/callback/google_drive`;
      const scopes = encodeURIComponent(
        'openid email profile https://www.googleapis.com/auth/drive.readonly',
      );

      redirectUrl =
        `https://accounts.google.com/o/oauth2/v2/auth` +
        `?client_id=${process.env.GOOGLE_CLIENT_ID ?? ''}` +
        `&response_type=code` +
        `&scope=${scopes}` +
        `&access_type=offline` +
        `&prompt=consent` +
        `&redirect_uri=${encodeURIComponent(cb)}` +
        `&state=${stateToken}`;
    } else if (provider === 'discord') {
      const cb = `${apiUrl}/automations/connections/oauth/callback/discord`;

      redirectUrl =
        `https://discord.com/oauth2/authorize` +
        `?client_id=${process.env.DISCORD_CLIENT_ID ?? ''}` +
        `&response_type=code` +
        `&scope=webhook.incoming` +
        `&redirect_uri=${encodeURIComponent(cb)}` +
        `&state=${stateToken}`;
    } else if (provider === 'outlook') {
      const tenantId = process.env.AZURE_TENANT_ID ?? 'common';
      const cb = `${apiUrl}/automations/connections/oauth/callback/outlook`;
      const outlookScopes = encodeURIComponent(
        'openid profile email offline_access Mail.Send',
      );

      redirectUrl =
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize` +
        `?client_id=${process.env.AZURE_CLIENT_ID ?? ''}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(cb)}` +
        `&scope=${outlookScopes}` +
        `&state=${stateToken}` +
        `&response_mode=query` +
        `&prompt=consent`;
    } else if (provider === 'salesforce') {
      const cb = `${apiUrl}/automations/connections/oauth/callback/salesforce`;
      const scopes = encodeURIComponent(
        'api refresh_token offline_access openid profile email',
      );

      // PKCE — generate verifier + challenge (required by Salesforce Connected Apps)
      const codeVerifier = randomBytes(48).toString('base64url');
      const codeChallenge = createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');

      await this.connectionsService.storePkceVerifier(stateToken, codeVerifier);

      redirectUrl =
        `https://login.salesforce.com/services/oauth2/authorize` +
        `?response_type=code` +
        `&client_id=${process.env.SALESFORCE_CLIENT_ID ?? ''}` +
        `&redirect_uri=${encodeURIComponent(cb)}` +
        `&scope=${scopes}` +
        `&state=${stateToken}` +
        `&code_challenge=${codeChallenge}` +
        `&code_challenge_method=S256` +
        `&prompt=consent`;
    } else {
      const cb = `${apiUrl}/auth/callback/automation-google`;
      const scopes = encodeURIComponent(
        'openid email profile https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events',
      );

      redirectUrl =
        `https://accounts.google.com/o/oauth2/v2/auth` +
        `?client_id=${process.env.GOOGLE_CLIENT_ID ?? ''}` +
        `&response_type=code` +
        `&scope=${scopes}` +
        `&access_type=offline` +
        `&prompt=consent` +
        `&redirect_uri=${encodeURIComponent(cb)}` +
        `&state=${stateToken}`;
    }

    return { redirectUrl };
  }

  // Slack OAuth callback
  @Public()
  @Get('oauth/callback/slack')
  async slackCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const apiUrl =
      process.env.AUTOMATIONS_PUBLIC_API_URL ??
      process.env.PUBLIC_API_URL ??
      'http://localhost:3001/api/v1';

    if (!code || !state) {
      res.redirect(`${appUrl}/error?msg=missing+code+or+state`);

      return;
    }

    const row = await this.connectionsService.consumeOAuthState(state);

    if (!row) {
      res.redirect(`${appUrl}/error?msg=invalid+state`);

      return;
    }
    if (new Date(row.expires_at) < new Date()) {
      res.redirect(`${appUrl}/error?msg=state+expired`);

      return;
    }
    if (row.consumed_at) {
      res.redirect(`${appUrl}/error?msg=state+already+used`);

      return;
    }
    if (row.provider !== 'slack') {
      res.redirect(`${appUrl}/error?msg=provider+mismatch`);

      return;
    }

    const cb = `${apiUrl}/automations/connections/oauth/callback/slack`;

    const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID ?? '',
        client_secret: process.env.SLACK_CLIENT_SECRET ?? '',
        code,
        redirect_uri: cb,
      }),
    });

    const tokenData = (await tokenRes.json()) as {
      ok: boolean;
      error?: string;
      access_token?: string;
      team?: { id: string; name: string };
      bot_user_id?: string;
      scope?: string;
      authed_user?: { id: string };
    };

    if (!tokenData.ok) {
      res.redirect(`${appUrl}/error?msg=slack+token+exchange+failed`);

      return;
    }

    const { access_token, team, bot_user_id, scope, authed_user } = tokenData;

    await this.connectionsService.upsertOAuthConnection({
      stateId: row.id,
      organizationId: row.organization_id,
      spaceId: row.space_id,
      provider: 'slack',
      displayName: team?.name ?? 'Slack',
      externalAccountId: team?.id ?? null,
      secret: access_token!,
      metadata: {
        team_name: team?.name,
        scopes: scope?.split(','),
        bot_user_id,
        authed_user_id: authed_user?.id,
      },
      createdBy: row.user_id,
    });

    // Redirect to this connection's own automations/connections page rather than trusting
    // return_to end-to-end — spaceId is validated/required at flow start, so resolving the
    // slug fresh here is more robust than depending on a frontend-supplied spaceKey.
    const spaceKey = await this.connectionsService.getSpaceKey(row.space_id);
    const target = spaceKey
      ? `/spaces/${spaceKey}/automations/connections`
      : (row.return_to ?? '/');
    const base = row.app_origin ?? appUrl;

    this.logger.log(
      `OAuth connect success — redirecting to ${base}${target} (spaceId=${row.space_id}, resolvedSpaceKey=${spaceKey ?? 'null'}, appOrigin=${row.app_origin ?? 'null'})`,
    );
    res.redirect(302, `${base}${target}`);
  }

  // Discord OAuth callback
  @Public()
  @Get('oauth/callback/discord')
  async discordCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const apiUrl =
      process.env.AUTOMATIONS_PUBLIC_API_URL ??
      process.env.PUBLIC_API_URL ??
      'http://localhost:3001/api/v1';

    if (!code || !state) {
      res.redirect(`${appUrl}/error?msg=missing+code+or+state`);

      return;
    }

    const row = await this.connectionsService.consumeOAuthState(state);

    if (!row) {
      res.redirect(`${appUrl}/error?msg=invalid+state`);

      return;
    }
    if (new Date(row.expires_at) < new Date()) {
      res.redirect(`${appUrl}/error?msg=state+expired`);

      return;
    }
    if (row.consumed_at) {
      res.redirect(`${appUrl}/error?msg=state+already+used`);

      return;
    }
    if (row.provider !== 'discord') {
      res.redirect(`${appUrl}/error?msg=provider+mismatch`);

      return;
    }

    const cb = `${apiUrl}/automations/connections/oauth/callback/discord`;

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID ?? '',
        client_secret: process.env.DISCORD_CLIENT_SECRET ?? '',
        grant_type: 'authorization_code',
        code,
        redirect_uri: cb,
      }),
    });

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      scope?: string;
      webhook?: {
        id: string;
        url: string;
        name: string;
        channel_id: string;
        guild_id?: string;
        guild?: { id: string; name: string };
      };
      error?: string;
    };

    if (!tokenData.webhook?.url) {
      console.error(
        `Discord token exchange failed: ${JSON.stringify(tokenData)}`,
      );
      res.redirect(`${appUrl}/error?msg=discord+token+exchange+failed`);

      return;
    }

    const { webhook } = tokenData;
    const displayName = webhook.guild?.name
      ? `${webhook.guild.name} — ${webhook.name}`
      : webhook.name;

    await this.connectionsService.upsertOAuthConnection({
      stateId: row.id,
      organizationId: row.organization_id,
      spaceId: row.space_id,
      provider: 'discord',
      displayName,
      externalAccountId: webhook.id,
      secret: webhook.url,
      metadata: {
        webhook_id: webhook.id,
        webhook_name: webhook.name,
        channel_id: webhook.channel_id,
        guild_id: webhook.guild_id ?? null,
        guild_name: webhook.guild?.name ?? null,
      },
      createdBy: row.user_id,
    });

    // Redirect to this connection's own automations/connections page rather than trusting
    // return_to end-to-end — spaceId is validated/required at flow start, so resolving the
    // slug fresh here is more robust than depending on a frontend-supplied spaceKey.
    const spaceKey = await this.connectionsService.getSpaceKey(row.space_id);
    const target = spaceKey
      ? `/spaces/${spaceKey}/automations/connections`
      : (row.return_to ?? '/');
    const base = row.app_origin ?? appUrl;

    this.logger.log(
      `OAuth connect success — redirecting to ${base}${target} (spaceId=${row.space_id}, resolvedSpaceKey=${spaceKey ?? 'null'}, appOrigin=${row.app_origin ?? 'null'})`,
    );
    res.redirect(302, `${base}${target}`);
  }

  // Google Calendar OAuth callback
  @Public()
  @Get('oauth/callback/google_calendar')
  async googleCalendarCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const apiUrl =
      process.env.AUTOMATIONS_PUBLIC_API_URL ??
      process.env.PUBLIC_API_URL ??
      'http://localhost:3001/api/v1';

    if (!code || !state) {
      res.redirect(`${appUrl}/error?msg=missing+code+or+state`);

      return;
    }

    const row = await this.connectionsService.consumeOAuthState(state);

    if (!row) {
      res.redirect(`${appUrl}/error?msg=invalid+state`);

      return;
    }
    if (new Date(row.expires_at) < new Date()) {
      res.redirect(`${appUrl}/error?msg=state+expired`);

      return;
    }
    if (row.consumed_at) {
      res.redirect(`${appUrl}/error?msg=state+already+used`);

      return;
    }
    if (row.provider !== 'google_calendar') {
      res.redirect(`${appUrl}/error?msg=provider+mismatch`);

      return;
    }

    const cb = `${apiUrl}/automations/connections/oauth/callback/google_calendar`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        grant_type: 'authorization_code',
        code,
        redirect_uri: cb,
      }),
    });

    if (!tokenRes.ok) {
      res.redirect(`${appUrl}/error?msg=google+token+exchange+failed`);

      return;
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      scope?: string;
      expires_in?: number;
    };

    const userRes = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      },
    );
    const userData = userRes.ok
      ? ((await userRes.json()) as {
          id?: string;
          email?: string;
          name?: string;
        })
      : {};

    await this.connectionsService.upsertOAuthConnection({
      stateId: row.id,
      organizationId: row.organization_id,
      spaceId: row.space_id,
      provider: 'google_calendar',
      displayName: userData.name ?? userData.email ?? 'Google Calendar',
      externalAccountId: userData.id ?? null,
      secret: tokenData.access_token,
      metadata: {
        email: userData.email,
        refresh_token: tokenData.refresh_token
          ? packSecretForStorage(tokenData.refresh_token)
          : null,
        scope: tokenData.scope,
        token_expires_at: tokenData.expires_in
          ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
          : null,
      },
      createdBy: row.user_id,
    });

    // Redirect to this connection's own automations/connections page rather than trusting
    // return_to end-to-end — spaceId is validated/required at flow start, so resolving the
    // slug fresh here is more robust than depending on a frontend-supplied spaceKey.
    const spaceKey = await this.connectionsService.getSpaceKey(row.space_id);
    const target = spaceKey
      ? `/spaces/${spaceKey}/automations/connections`
      : (row.return_to ?? '/');
    const base = row.app_origin ?? appUrl;

    this.logger.log(
      `OAuth connect success — redirecting to ${base}${target} (spaceId=${row.space_id}, resolvedSpaceKey=${spaceKey ?? 'null'}, appOrigin=${row.app_origin ?? 'null'})`,
    );
    res.redirect(302, `${base}${target}`);
  }

  // Microsoft Teams OAuth callback
  @Public()
  @Get('oauth/callback/teams')
  async teamsCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const apiUrl =
      process.env.AUTOMATIONS_PUBLIC_API_URL ??
      process.env.PUBLIC_API_URL ??
      'http://localhost:3001/api/v1';

    if (!code || !state) {
      res.redirect(`${appUrl}/error?msg=missing+code+or+state`);

      return;
    }

    const row = await this.connectionsService.consumeOAuthState(state);

    if (!row) {
      res.redirect(`${appUrl}/error?msg=invalid+state`);

      return;
    }
    if (new Date(row.expires_at) < new Date()) {
      res.redirect(`${appUrl}/error?msg=state+expired`);

      return;
    }
    if (row.consumed_at) {
      res.redirect(`${appUrl}/error?msg=state+already+used`);

      return;
    }
    if (row.provider !== 'teams') {
      res.redirect(`${appUrl}/error?msg=provider+mismatch`);

      return;
    }

    const tenantId = process.env.AZURE_TENANT_ID ?? 'common';
    const cb = `${apiUrl}/automations/connections/oauth/callback/teams`;

    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.AZURE_CLIENT_ID ?? '',
          client_secret: process.env.AZURE_CLIENT_SECRET ?? '',
          grant_type: 'authorization_code',
          code,
          redirect_uri: cb,
        }),
      },
    );

    if (!tokenRes.ok) {
      res.redirect(`${appUrl}/error?msg=teams+token+exchange+failed`);

      return;
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = profileRes.ok
      ? ((await profileRes.json()) as {
          id?: string;
          mail?: string;
          displayName?: string;
        })
      : {};

    await this.connectionsService.upsertOAuthConnection({
      stateId: row.id,
      organizationId: row.organization_id,
      spaceId: row.space_id,
      provider: 'teams',
      displayName: profile.displayName ?? profile.mail ?? 'Microsoft Teams',
      externalAccountId: profile.id ?? null,
      secret: tokenData.access_token,
      metadata: {
        userId: profile.id,
        mail: profile.mail,
        displayName: profile.displayName,
        refresh_token: tokenData.refresh_token
          ? packSecretForStorage(tokenData.refresh_token)
          : null,
        token_expires_at: tokenData.expires_in
          ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
          : null,
      },
      createdBy: row.user_id,
    });

    // Redirect to this connection's own automations/connections page rather than trusting
    // return_to end-to-end — spaceId is validated/required at flow start, so resolving the
    // slug fresh here is more robust than depending on a frontend-supplied spaceKey.
    const spaceKey = await this.connectionsService.getSpaceKey(row.space_id);
    const target = spaceKey
      ? `/spaces/${spaceKey}/automations/connections`
      : (row.return_to ?? '/');
    const base = row.app_origin ?? appUrl;

    this.logger.log(
      `OAuth connect success — redirecting to ${base}${target} (spaceId=${row.space_id}, resolvedSpaceKey=${spaceKey ?? 'null'}, appOrigin=${row.app_origin ?? 'null'})`,
    );
    res.redirect(302, `${base}${target}`);
  }

  // Microsoft Outlook OAuth callback
  @Public()
  @Get('oauth/callback/outlook')
  async outlookCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const apiUrl =
      process.env.AUTOMATIONS_PUBLIC_API_URL ??
      process.env.PUBLIC_API_URL ??
      'http://localhost:3001/api/v1';

    if (!code || !state) {
      res.redirect(`${appUrl}/error?msg=missing+code+or+state`);

      return;
    }

    const row = await this.connectionsService.consumeOAuthState(state);

    if (!row) {
      res.redirect(`${appUrl}/error?msg=invalid+state`);

      return;
    }
    if (new Date(row.expires_at) < new Date()) {
      res.redirect(`${appUrl}/error?msg=state+expired`);

      return;
    }
    if (row.consumed_at) {
      res.redirect(`${appUrl}/error?msg=state+already+used`);

      return;
    }
    if (row.provider !== 'outlook') {
      res.redirect(`${appUrl}/error?msg=provider+mismatch`);

      return;
    }

    const tenantId = process.env.AZURE_TENANT_ID ?? 'common';
    const cb = `${apiUrl}/automations/connections/oauth/callback/outlook`;

    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.AZURE_CLIENT_ID ?? '',
          client_secret: process.env.AZURE_CLIENT_SECRET ?? '',
          grant_type: 'authorization_code',
          code,
          redirect_uri: cb,
        }),
      },
    );

    if (!tokenRes.ok) {
      res.redirect(`${appUrl}/error?msg=outlook+token+exchange+failed`);

      return;
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };

    const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = profileRes.ok
      ? ((await profileRes.json()) as {
          id?: string;
          mail?: string;
          displayName?: string;
        })
      : {};

    await this.connectionsService.upsertOAuthConnection({
      stateId: row.id,
      organizationId: row.organization_id,
      spaceId: row.space_id,
      provider: 'outlook',
      displayName: profile.displayName ?? profile.mail ?? 'Microsoft Outlook',
      externalAccountId: profile.id ?? null,
      secret: tokenData.access_token,
      metadata: {
        userId: profile.id,
        mail: profile.mail,
        displayName: profile.displayName,
        refresh_token: tokenData.refresh_token
          ? packSecretForStorage(tokenData.refresh_token)
          : null,
        scope: tokenData.scope ?? null,
        token_expires_at: tokenData.expires_in
          ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
          : null,
      },
      createdBy: row.user_id,
    });

    // Redirect to this connection's own automations/connections page rather than trusting
    // return_to end-to-end — spaceId is validated/required at flow start, so resolving the
    // slug fresh here is more robust than depending on a frontend-supplied spaceKey.
    const spaceKey = await this.connectionsService.getSpaceKey(row.space_id);
    const target = spaceKey
      ? `/spaces/${spaceKey}/automations/connections`
      : (row.return_to ?? '/');
    const base = row.app_origin ?? appUrl;

    this.logger.log(
      `OAuth connect success — redirecting to ${base}${target} (spaceId=${row.space_id}, resolvedSpaceKey=${spaceKey ?? 'null'}, appOrigin=${row.app_origin ?? 'null'})`,
    );
    res.redirect(302, `${base}${target}`);
  }

  // List ClickUp spaces across all accessible workspaces
  @Get(':id/clickup-spaces')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getClickUpSpaces(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);
    const headers = {
      Authorization: token,
      'Content-Type': 'application/json',
    };
    const teamsRes = await fetch('https://api.clickup.com/api/v2/team', {
      headers,
    });

    if (!teamsRes.ok)
      throw new BadGatewayException(`ClickUp API returned ${teamsRes.status}`);
    const teamsJson = (await teamsRes.json()) as {
      teams?: Array<{ id: string; name: string }>;
    };
    const teams = teamsJson.teams ?? [];
    const spacesPerTeam = await Promise.all(
      teams.map(async (team) => {
        const res = await fetch(
          `https://api.clickup.com/api/v2/team/${team.id}/space?archived=false`,
          { headers },
        );

        if (!res.ok) return [];
        const json = (await res.json()) as {
          spaces?: Array<{ id: string; name: string }>;
        };

        return (json.spaces ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          teamId: team.id,
          teamName: team.name,
        }));
      }),
    );

    return { data: spacesPerTeam.flat() };
  }

  // List ClickUp lists within a space
  @Get(':id/clickup-lists')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getClickUpLists(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
    @Query('clickupSpaceId') clickupSpaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    if (!clickupSpaceId)
      throw new BadRequestException('clickupSpaceId is required');
    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);
    const headers = {
      Authorization: token,
      'Content-Type': 'application/json',
    };
    const [listsRes, foldersRes] = await Promise.all([
      fetch(
        `https://api.clickup.com/api/v2/space/${clickupSpaceId}/list?archived=false`,
        { headers },
      ),
      fetch(
        `https://api.clickup.com/api/v2/space/${clickupSpaceId}/folder?archived=false`,
        { headers },
      ),
    ]);

    if (!listsRes.ok || !foldersRes.ok)
      throw new BadGatewayException('ClickUp API error fetching lists');
    const listsJson = (await listsRes.json()) as {
      lists?: Array<{ id: string; name: string }>;
    };
    const foldersJson = (await foldersRes.json()) as {
      folders?: Array<{ id: string; name: string }>;
    };
    const folderlessLists = (listsJson.lists ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      folderName: null as string | null,
    }));
    const folderListsArrays = await Promise.all(
      (foldersJson.folders ?? []).map(async (folder) => {
        const res = await fetch(
          `https://api.clickup.com/api/v2/folder/${folder.id}/list?archived=false`,
          { headers },
        );

        if (!res.ok) return [];
        const json = (await res.json()) as {
          lists?: Array<{ id: string; name: string }>;
        };

        return (json.lists ?? []).map((l) => ({
          id: l.id,
          name: l.name,
          folderName: folder.name,
        }));
      }),
    );

    return { data: [...folderlessLists, ...folderListsArrays.flat()] };
  }

  // List custom field definitions for a ClickUp list
  @Get(':id/clickup-list-fields')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getClickUpListFields(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
    @Query('listId') listId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    if (!listId) throw new BadRequestException('listId is required');

    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);
    const res = await fetch(
      `https://api.clickup.com/api/v2/list/${listId}/field`,
      { headers: { Authorization: token } },
    );

    if (!res.ok) {
      throw new BadGatewayException(
        `ClickUp API error (${res.status}): could not load custom fields`,
      );
    }

    const json = (await res.json()) as {
      fields?: Array<{
        id: string;
        name: string;
        type: string;
        type_config?: {
          options?: Array<{ id: string; name: string }>;
        };
      }>;
    };

    return {
      data: (json.fields ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        options: f.type_config?.options ?? [],
      })),
    };
  }

  // List Asana workspaces
  @Get(':id/asana-workspaces')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getAsanaWorkspaces(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);
    const res = await fetch(
      'https://app.asana.com/api/1.0/workspaces?opt_fields=gid,name',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      },
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        errors?: Array<{ message?: string }>;
      };

      throw new BadGatewayException(
        `Asana API error (${res.status}): ${body.errors?.[0]?.message ?? res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      data?: Array<{ gid: string; name: string }>;
    };

    return {
      data: (json.data ?? []).map((w) => ({ id: w.gid, name: w.name })),
    };
  }

  // List Asana projects, optionally filtered by workspace
  @Get(':id/asana-projects')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getAsanaProjects(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };

    if (workspaceId) {
      const pRes = await fetch(
        `https://app.asana.com/api/1.0/projects?workspace=${encodeURIComponent(workspaceId)}&opt_fields=gid,name&limit=50`,
        { headers },
      );

      if (!pRes.ok) {
        const body = (await pRes.json().catch(() => ({}))) as {
          errors?: Array<{ message?: string }>;
        };

        throw new BadGatewayException(
          `Asana API error (${pRes.status}): ${body.errors?.[0]?.message ?? pRes.statusText}`,
        );
      }

      const pJson = (await pRes.json()) as {
        data?: Array<{ gid: string; name: string }>;
      };

      return {
        data: (pJson.data ?? []).map((p) => ({ id: p.gid, name: p.name })),
      };
    }

    const wsRes = await fetch(
      'https://app.asana.com/api/1.0/workspaces?opt_fields=gid,name',
      { headers },
    );

    if (!wsRes.ok) {
      const body = (await wsRes.json().catch(() => ({}))) as {
        errors?: Array<{ message?: string }>;
      };

      throw new BadGatewayException(
        `Asana API error (${wsRes.status}): ${body.errors?.[0]?.message ?? wsRes.statusText}`,
      );
    }

    const wsJson = (await wsRes.json()) as {
      data?: Array<{ gid: string; name: string }>;
    };
    const workspaces = (wsJson.data ?? []).slice(0, 3);

    if (!workspaces.length) return { data: [] };
    const results = await Promise.all(
      workspaces.map(async (ws) => {
        try {
          const pRes = await fetch(
            `https://app.asana.com/api/1.0/projects?workspace=${ws.gid}&opt_fields=gid,name&limit=50`,
            { headers },
          );

          if (!pRes.ok) return [];
          const pJson = (await pRes.json()) as {
            data?: Array<{ gid: string; name: string }>;
          };

          return (pJson.data ?? []).map((p) => ({
            id: p.gid,
            name: p.name,
            workspace: ws.name,
          }));
        } catch {
          return [];
        }
      }),
    );

    return { data: results.flat() };
  }

  // List custom field definitions for an Asana project
  @Get(':id/asana-custom-fields')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getAsanaCustomFields(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
    @Query('projectId') projectId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    if (!projectId) throw new BadRequestException('projectId is required');

    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);
    const res = await fetch(
      `https://app.asana.com/api/1.0/projects/${projectId}/custom_field_settings?opt_fields=custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.enum_options.gid,custom_field.enum_options.name`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      },
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        errors?: Array<{ message?: string }>;
      };

      throw new BadGatewayException(
        `Asana API error (${res.status}): ${body.errors?.[0]?.message ?? res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      data?: Array<{
        custom_field?: {
          gid: string;
          name: string;
          resource_subtype?: string;
          enum_options?: Array<{ gid: string; name: string }>;
        };
      }>;
    };

    return {
      data: (json.data ?? [])
        .map((setting) => setting.custom_field)
        .filter((f): f is NonNullable<typeof f> => !!f)
        .map((f) => ({
          id: f.gid,
          name: f.name,
          type: f.resource_subtype ?? 'text',
          options: (f.enum_options ?? []).map((o) => ({
            id: o.gid,
            name: o.name,
          })),
        })),
    };
  }

  // List Asana tasks in a project
  @Get(':id/asana-tasks')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getAsanaTasks(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
    @Query('projectId') projectId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    if (!projectId) throw new BadRequestException('projectId is required');
    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);
    const res = await fetch(
      `https://app.asana.com/api/1.0/tasks?project=${encodeURIComponent(projectId)}&opt_fields=gid,name&limit=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      },
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        errors?: Array<{ message?: string }>;
      };

      throw new BadGatewayException(
        `Asana API error (${res.status}): ${body.errors?.[0]?.message ?? res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      data?: Array<{ gid: string; name: string }>;
    };

    return {
      data: (json.data ?? []).map((t) => ({ id: t.gid, name: t.name })),
    };
  }

  // List Asana workspace members
  @Get(':id/asana-members')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getAsanaMembers(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
    @Query('workspaceId') workspaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    if (!workspaceId) throw new BadRequestException('workspaceId is required');
    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);
    const res = await fetch(
      `https://app.asana.com/api/1.0/workspaces/${encodeURIComponent(workspaceId)}/users?opt_fields=gid,name,email`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      },
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        errors?: Array<{ message?: string }>;
      };

      throw new BadGatewayException(
        `Asana API error (${res.status}): ${body.errors?.[0]?.message ?? res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      data?: Array<{ gid: string; name: string; email?: string }>;
    };

    return {
      data: (json.data ?? []).map((u) => ({
        id: u.gid,
        name: u.name,
        email: u.email ?? null,
      })),
    };
  }

  // List open Trello boards
  @Get(':id/trello-boards')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getTrelloBoards(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    const [token, metadata] = await Promise.all([
      this.connectionsService.getDecryptedSecret(id, spaceId),
      this.connectionsService.getConnectionMetadata(id, spaceId),
    ]);
    const apiKey = metadata.api_key ?? '';

    if (!apiKey)
      throw new BadRequestException(
        'Trello connection is missing API key — re-save the connection',
      );
    const url = new URL('https://api.trello.com/1/members/me/boards');

    url.searchParams.set('fields', 'id,name');
    url.searchParams.set('filter', 'open');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('token', token);
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);

      throw new BadGatewayException(
        `Trello API error (${res.status}): ${detail}`,
      );
    }

    const json = (await res.json()) as Array<{ id: string; name: string }>;

    return { data: json.map((b) => ({ id: b.id, name: b.name })) };
  }

  // List open Trello lists in a board
  @Get(':id/trello-lists')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getTrelloLists(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
    @Query('boardId') boardId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    if (!boardId) throw new BadRequestException('boardId is required');
    const [token, metadata] = await Promise.all([
      this.connectionsService.getDecryptedSecret(id, spaceId),
      this.connectionsService.getConnectionMetadata(id, spaceId),
    ]);
    const apiKey = metadata.api_key ?? '';

    if (!apiKey)
      throw new BadRequestException(
        'Trello connection is missing API key — re-save the connection',
      );
    const url = new URL(`https://api.trello.com/1/boards/${boardId}/lists`);

    url.searchParams.set('fields', 'id,name');
    url.searchParams.set('filter', 'open');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('token', token);
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);

      throw new BadGatewayException(
        `Trello API error (${res.status}): ${detail}`,
      );
    }

    const json = (await res.json()) as Array<{ id: string; name: string }>;

    return { data: json.map((l) => ({ id: l.id, name: l.name })) };
  }

  // List Google Sheets spreadsheets
  @Get(':id/google-sheets-spreadsheets')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getGoogleSheetsSpreadsheets(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');

    const token = await this.connectionsService.getGoogleAccessToken(
      id,
      'google_sheets',
    );
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.spreadsheet%27&fields=files(id%2Cname)&pageSize=100`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };

      throw new BadGatewayException(
        `Google Drive API error (${res.status}): ${body.error?.message ?? res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      files?: Array<{ id: string; name: string }>;
    };

    return {
      data: (json.files ?? []).map((f) => ({ id: f.id, name: f.name })),
    };
  }

  // List sheet tabs in a Google Spreadsheet
  @Get(':id/google-sheets-sheet-names')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getGoogleSheetsSheetNames(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
    @Query('spreadsheetId') spreadsheetId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    if (!spreadsheetId)
      throw new BadRequestException('spreadsheetId is required');

    const token = await this.connectionsService.getGoogleAccessToken(
      id,
      'google_sheets',
    );
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId%2Ctitle))`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };

      throw new BadGatewayException(
        `Google Sheets API error (${res.status}): ${body.error?.message ?? res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
    };

    return {
      data: (json.sheets ?? []).map((s) => ({
        id: String(s.properties?.sheetId ?? ''),
        name: s.properties?.title ?? '',
      })),
    };
  }

  // List the header row (column names) of a sheet tab
  @Get(':id/google-sheets-columns')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getGoogleSheetsColumns(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
    @Query('spreadsheetId') spreadsheetId: string,
    @Query('range') range: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    if (!spreadsheetId)
      throw new BadRequestException('spreadsheetId is required');
    if (!range) throw new BadRequestException('range is required');

    const token = await this.connectionsService.getGoogleAccessToken(
      id,
      'google_sheets',
    );
    const encodedRange = encodeURIComponent(`${range}!1:1`);
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedRange}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };

      throw new BadGatewayException(
        `Google Sheets API error (${res.status}): ${body.error?.message ?? res.statusText}`,
      );
    }

    const json = (await res.json()) as { values?: string[][] };
    const headerRow = json.values?.[0] ?? [];

    return {
      data: headerRow.map((name, i) => ({
        id: String(i),
        name: name || `Column ${i + 1}`,
      })),
    };
  }

  // List Google Drive folders
  @Get(':id/google-drive-folders')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getGoogleDriveFolders(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');

    const token = await this.connectionsService.getGoogleAccessToken(
      id,
      'google_drive',
    );

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.folder%27%20and%20trashed%3Dfalse&fields=files(id%2Cname)&pageSize=100&orderBy=name`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };

      throw new BadGatewayException(
        `Google Drive API error (${res.status}): ${body.error?.message ?? res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      files?: Array<{ id: string; name: string }>;
    };

    return {
      data: (json.files ?? []).map((f) => ({ id: f.id, name: f.name })),
    };
  }

  // List Airtable bases
  @Get(':id/airtable-bases')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getAirtableBases(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');

    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);
    const res = await fetch('https://api.airtable.com/v0/meta/bases', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };

      throw new BadGatewayException(
        `Airtable API error (${res.status}): ${body.error?.message ?? res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      bases?: Array<{ id: string; name: string }>;
    };

    return {
      data: (json.bases ?? []).map((b) => ({ id: b.id, name: b.name })),
    };
  }

  // List tables in an Airtable base
  @Get(':id/airtable-tables')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async getAirtableTables(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
    @Query('baseId') baseId: string,
    @Query('includeFields') includeFields?: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    if (!baseId) throw new BadRequestException('baseId is required');

    const token = await this.connectionsService.getDecryptedSecret(id, spaceId);
    const res = await fetch(
      `https://api.airtable.com/v0/meta/bases/${baseId}/tables`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };

      throw new BadGatewayException(
        `Airtable API error (${res.status}): ${body.error?.message ?? res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      tables?: Array<{
        id: string;
        name: string;
        fields?: Array<{
          id: string;
          name: string;
          type: string;
          description?: string;
          options?: {
            choices?: Array<{ id: string; name: string; color?: string }>;
          };
        }>;
      }>;
    };

    const withFields = includeFields === 'true';

    return {
      data: (json.tables ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        ...(withFields && t.fields
          ? {
              fields: t.fields.map((f) => ({
                id: f.id,
                name: f.name,
                type: f.type,
                description: f.description,
                options: f.options,
              })),
            }
          : {}),
      })),
    };
  }

  // Google Sheets OAuth callback
  @Public()
  @Get('oauth/callback/google_sheets')
  async googleSheetsCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const apiUrl =
      process.env.AUTOMATIONS_PUBLIC_API_URL ??
      process.env.PUBLIC_API_URL ??
      'http://localhost:3001/api/v1';

    if (!code || !state) {
      res.redirect(`${appUrl}/error?msg=missing+code+or+state`);

      return;
    }

    const row = await this.connectionsService.consumeOAuthState(state);

    if (!row) {
      res.redirect(`${appUrl}/error?msg=invalid+state`);

      return;
    }
    if (new Date(row.expires_at) < new Date()) {
      res.redirect(`${appUrl}/error?msg=state+expired`);

      return;
    }
    if (row.consumed_at) {
      res.redirect(`${appUrl}/error?msg=state+already+used`);

      return;
    }
    if (row.provider !== 'google_sheets') {
      res.redirect(`${appUrl}/error?msg=provider+mismatch`);

      return;
    }

    const cb = `${apiUrl}/automations/connections/oauth/callback/google_sheets`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        grant_type: 'authorization_code',
        code,
        redirect_uri: cb,
      }),
    });

    if (!tokenRes.ok) {
      res.redirect(`${appUrl}/error?msg=google+token+exchange+failed`);

      return;
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      scope?: string;
      expires_in?: number;
    };

    const userRes = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      },
    );
    const userData = userRes.ok
      ? ((await userRes.json()) as {
          id?: string;
          email?: string;
          name?: string;
        })
      : {};

    await this.connectionsService.upsertOAuthConnection({
      stateId: row.id,
      organizationId: row.organization_id,
      spaceId: row.space_id,
      provider: 'google_sheets',
      displayName: userData.name ?? userData.email ?? 'Google Sheets',
      externalAccountId: userData.id ?? null,
      secret: tokenData.access_token,
      metadata: {
        email: userData.email,
        refresh_token: tokenData.refresh_token
          ? packSecretForStorage(tokenData.refresh_token)
          : null,
        scope: tokenData.scope,
        token_expires_at: tokenData.expires_in
          ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
          : null,
      },
      createdBy: row.user_id,
    });

    // Redirect to this connection's own automations/connections page rather than trusting
    // return_to end-to-end — spaceId is validated/required at flow start, so resolving the
    // slug fresh here is more robust than depending on a frontend-supplied spaceKey.
    const spaceKey = await this.connectionsService.getSpaceKey(row.space_id);
    const target = spaceKey
      ? `/spaces/${spaceKey}/automations/connections`
      : (row.return_to ?? '/');
    const base = row.app_origin ?? appUrl;

    this.logger.log(
      `OAuth connect success — redirecting to ${base}${target} (spaceId=${row.space_id}, resolvedSpaceKey=${spaceKey ?? 'null'}, appOrigin=${row.app_origin ?? 'null'})`,
    );
    res.redirect(302, `${base}${target}`);
  }

  // Google Drive OAuth callback
  @Public()
  @Get('oauth/callback/google_drive')
  async googleDriveCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const apiUrl =
      process.env.AUTOMATIONS_PUBLIC_API_URL ??
      process.env.PUBLIC_API_URL ??
      'http://localhost:3001/api/v1';

    if (!code || !state) {
      res.redirect(`${appUrl}/error?msg=missing+code+or+state`);

      return;
    }

    const row = await this.connectionsService.consumeOAuthState(state);

    if (!row) {
      res.redirect(`${appUrl}/error?msg=invalid+state`);

      return;
    }
    if (new Date(row.expires_at) < new Date()) {
      res.redirect(`${appUrl}/error?msg=state+expired`);

      return;
    }
    if (row.consumed_at) {
      res.redirect(`${appUrl}/error?msg=state+already+used`);

      return;
    }
    if (row.provider !== 'google_drive') {
      res.redirect(`${appUrl}/error?msg=provider+mismatch`);

      return;
    }

    const cb = `${apiUrl}/automations/connections/oauth/callback/google_drive`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        grant_type: 'authorization_code',
        code,
        redirect_uri: cb,
      }),
    });

    if (!tokenRes.ok) {
      res.redirect(`${appUrl}/error?msg=google+token+exchange+failed`);

      return;
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      scope?: string;
      expires_in?: number;
    };

    const userRes = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      },
    );
    const userData = userRes.ok
      ? ((await userRes.json()) as {
          id?: string;
          email?: string;
          name?: string;
        })
      : {};

    await this.connectionsService.upsertOAuthConnection({
      stateId: row.id,
      organizationId: row.organization_id,
      spaceId: row.space_id,
      provider: 'google_drive',
      displayName: userData.name ?? userData.email ?? 'Google Drive',
      externalAccountId: userData.id ?? null,
      secret: tokenData.access_token,
      metadata: {
        email: userData.email,
        refresh_token: tokenData.refresh_token
          ? packSecretForStorage(tokenData.refresh_token)
          : null,
        scope: tokenData.scope,
        token_expires_at: tokenData.expires_in
          ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
          : null,
      },
      createdBy: row.user_id,
    });

    // Redirect to this connection's own automations/connections page rather than trusting
    // return_to end-to-end — spaceId is validated/required at flow start, so resolving the
    // slug fresh here is more robust than depending on a frontend-supplied spaceKey.
    const spaceKey = await this.connectionsService.getSpaceKey(row.space_id);
    const target = spaceKey
      ? `/spaces/${spaceKey}/automations/connections`
      : (row.return_to ?? '/');
    const base = row.app_origin ?? appUrl;

    this.logger.log(
      `OAuth connect success — redirecting to ${base}${target} (spaceId=${row.space_id}, resolvedSpaceKey=${spaceKey ?? 'null'}, appOrigin=${row.app_origin ?? 'null'})`,
    );
    res.redirect(302, `${base}${target}`);
  }

  // Salesforce OAuth callback
  @Public()
  @Get('oauth/callback/salesforce')
  async salesforceCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const apiUrl =
      process.env.AUTOMATIONS_PUBLIC_API_URL ??
      process.env.PUBLIC_API_URL ??
      'http://localhost:3001/api/v1';

    if (!code || !state) {
      res.redirect(`${appUrl}/error?msg=missing+code+or+state`);

      return;
    }

    const row = await this.connectionsService.consumeOAuthState(state);

    if (!row) {
      res.redirect(`${appUrl}/error?msg=invalid+state`);
      return;
    }
    if (new Date(row.expires_at) < new Date()) {
      res.redirect(`${appUrl}/error?msg=state+expired`);
      return;
    }
    if (row.consumed_at) {
      res.redirect(`${appUrl}/error?msg=state+already+used`);
      return;
    }
    if (row.provider !== 'salesforce') {
      res.redirect(`${appUrl}/error?msg=provider+mismatch`);
      return;
    }

    const cb = `${apiUrl}/automations/connections/oauth/callback/salesforce`;
    const codeVerifier =
      await this.connectionsService.consumePkceVerifier(state);

    const tokenParams: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: process.env.SALESFORCE_CLIENT_ID ?? '',
      client_secret: process.env.SALESFORCE_CLIENT_SECRET ?? '',
      code,
      redirect_uri: cb,
    };

    if (codeVerifier) tokenParams['code_verifier'] = codeVerifier;

    const tokenRes = await fetch(
      'https://login.salesforce.com/services/oauth2/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(tokenParams),
      },
    );

    if (!tokenRes.ok) {
      res.redirect(`${appUrl}/error?msg=salesforce+token+exchange+failed`);

      return;
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      instance_url: string;
      id?: string;
      scope?: string;
    };

    let displayName = 'Salesforce';
    let externalAccountId: string | null = null;

    if (tokenData.id) {
      try {
        const idRes = await fetch(tokenData.id, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });

        if (idRes.ok) {
          const idData = (await idRes.json()) as {
            display_name?: string;
            username?: string;
            user_id?: string;
          };

          displayName = idData.display_name ?? idData.username ?? 'Salesforce';
          externalAccountId = idData.user_id ?? null;
        }
      } catch {
        // fall through with defaults
      }
    }

    await this.connectionsService.upsertOAuthConnection({
      stateId: row.id,
      organizationId: row.organization_id,
      spaceId: row.space_id,
      provider: 'salesforce',
      displayName,
      externalAccountId,
      secret: tokenData.access_token,
      metadata: {
        instanceUrl: tokenData.instance_url,
        refresh_token: tokenData.refresh_token
          ? packSecretForStorage(tokenData.refresh_token)
          : null,
        scope: tokenData.scope,
        identity_url: tokenData.id,
      },
      createdBy: row.user_id,
    });

    // Redirect to this connection's own automations/connections page rather than trusting
    // return_to end-to-end — spaceId is validated/required at flow start, so resolving the
    // slug fresh here is more robust than depending on a frontend-supplied spaceKey.
    const spaceKey = await this.connectionsService.getSpaceKey(row.space_id);
    const target = spaceKey
      ? `/spaces/${spaceKey}/automations/connections`
      : (row.return_to ?? '/');
    const base = row.app_origin ?? appUrl;

    this.logger.log(
      `OAuth connect success — redirecting to ${base}${target} (spaceId=${row.space_id}, resolvedSpaceKey=${spaceKey ?? 'null'}, appOrigin=${row.app_origin ?? 'null'})`,
    );
    res.redirect(302, `${base}${target}`);
  }

  // List Twilio incoming phone numbers for the "From" picker
  @Get(':id/twilio-numbers')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  async listTwilioNumbers(
    @Param('id') id: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');

    const meta = await this.connectionsService.getConnectionMetadata(
      id,
      spaceId,
    );
    const accountSid = meta?.account_sid ?? '';

    if (!accountSid) {
      throw new BadRequestException(
        'Twilio connection is missing account_sid metadata — re-create the connection with account_sid in metadata',
      );
    }

    const authToken = await this.connectionsService.getDecryptedSecret(
      id,
      spaceId,
    );

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PageSize=50`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) {
      throw new BadGatewayException(`Twilio API returned ${res.status}`);
    }

    const json = (await res.json()) as {
      incoming_phone_numbers?: Array<{
        phone_number: string;
        friendly_name: string;
        sid: string;
      }>;
    };

    const data = (json.incoming_phone_numbers ?? []).map((n) => ({
      id: n.phone_number,
      name: `${n.friendly_name} (${n.phone_number})`,
      phoneNumber: n.phone_number,
    }));

    return { data };
  }
}
