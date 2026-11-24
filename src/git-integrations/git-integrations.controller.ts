/**
 * @fileoverview Admin API behind Tenant Configuration > Integrations (GitHub, GitLab, Azure DevOps).
 *
 * Owners and admins only (RolesGuard) and licence-gated. Pages read from the database only;
 * providers are contacted on connect, on an explicit refresh, on saving a selection and by the
 * health check, so a slow or unavailable provider never breaks the page.
 * Global prefix is `api/v1`.
 * @module src/git-integrations/git-integrations.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireRoles } from '../auth/decorators/require-roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  ConnectAzureDevopsOrganizationDto,
  ConnectGithubInstallationDto,
  ConnectGitlabGroupDto,
  CreateGitServerDto,
  UpdateGitRepositoriesDto,
  UpdateGitServerDto,
  UpdateGitSettingsDto,
  UpdateGitBranchSettingsDto,
} from './git-integrations.dto';
import { GitIdentitiesService } from './git-identities.service';
import { GitIntegrationsService } from './git-integrations.service';
import type { GitProvider } from './git-integrations.types';
import { GitProvidersRegistry } from './git-providers.registry';
import { assertStateSecret } from './git-integrations.util';
import { GitServerTestService } from './git-server-test.service';
import { GitServersService, isAppComplete } from './git-servers.service';

/** `?serverId=` is optional everywhere: without it the built-in (cloud) app is meant. */
const OPTIONAL_UUID = new ParseUUIDPipe({ optional: true });

@RequireFeature('feature_external_integrations')
@ApiTags('Git Integrations')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@RequireRoles('admin', 'owner')
@Controller('git-integrations')
export class GitIntegrationsController {
  private readonly logger = new Logger(GitIntegrationsController.name);

  constructor(
    private readonly core: GitIntegrationsService,
    private readonly providers: GitProvidersRegistry,
    private readonly identities: GitIdentitiesService,
    private readonly servers: GitServersService,
    private readonly serverTests: GitServerTestService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'One status card per built-in provider' })
  async overview(@CurrentUser() user: RequestUser) {
    return this.core.getOverview(
      user.organizationId,
      this.providers.configured(),
      await this.ownHosts(user.organizationId),
    );
  }

  private async ownHosts(organizationId: string) {
    const servers = await this.servers.list(organizationId);
    const of = (provider: GitProvider) =>
      new Set(
        servers
          .filter((server) => server.provider === provider)
          .map((server) => server.host),
      );

    return {
      github: of('github'),
      gitlab: of('gitlab'),
      azure_devops: of('azure_devops'),
    };
  }

  // ---- Own servers (ticket 11; literal routes, before the generic :provider routes) -------------

  @Get('servers')
  @ApiOperation({ summary: "The organization's own Git servers" })
  listServers(@CurrentUser() user: RequestUser) {
    return this.servers.overview(user.organizationId);
  }

  @Post('servers')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Register a GitHub Enterprise Server or self-managed GitLab',
  })
  createServer(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateGitServerDto,
  ) {
    return this.servers.create(user.organizationId, user.userId, dto);
  }

  @Get('servers/:id')
  @ApiOperation({ summary: 'One own server' })
  getServer(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.servers.getDto(user.organizationId, id);
  }

  @Get('servers/:id/setup')
  @ImpersonationBlocked()
  @ApiOperation({
    summary:
      'The values to enter in the app registration on the server (includes the webhook secret)',
  })
  serverSetup(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.servers.setup(user.organizationId, id, user.userId);
  }

  @Patch('servers/:id')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Change name, address or app credentials (links are kept)',
  })
  updateServer(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGitServerDto,
  ) {
    return this.servers.update(user.organizationId, id, user.userId, dto);
  }

  @Post('servers/:id/webhook-secret')
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'Generate a new webhook secret (GitHub App)' })
  rotateServerWebhookSecret(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.servers.rotateWebhookSecret(
      user.organizationId,
      id,
      user.userId,
    );
  }

  @Post('servers/:id/test')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test connection in both directions' })
  async testServer(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const result = await this.serverTests.test(user.organizationId, id);

    this.servers.auditTest(user.organizationId, user.userId, id, result);

    return result;
  }

  @Delete('servers/:id')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a server without live connections' })
  async removeServer(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.servers.remove(user.organizationId, id, user.userId);
  }

  // ---- GitHub-specific (declared before the generic :provider routes) -----------------------

  @Get('github/pick')
  @ApiOperation({
    summary: 'Installations the signed-in GitHub user can connect',
  })
  githubPick(@CurrentUser() user: RequestUser, @Query('token') token: string) {
    assertStateSecret();

    return this.providers.github.getPick(user, token);
  }

  @Post('github/connections')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Connect a GitHub installation chosen from the pick list',
  })
  async githubConnect(
    @CurrentUser() user: RequestUser,
    @Body() dto: ConnectGithubInstallationDto,
  ) {
    assertStateSecret();
    await this.providers.github.connectInstallation(
      user,
      dto.token,
      dto.installationId,
    );

    return this.detail(user, 'github');
  }

  // ---- GitLab-specific ------------------------------------------------------------------------

  @Get('gitlab/credentials/:credentialId/groups')
  @ApiOperation({ summary: 'GitLab groups the authorizing user maintains' })
  gitlabGroups(
    @CurrentUser() user: RequestUser,
    @Param('credentialId', ParseUUIDPipe) credentialId: string,
    @Query('search') search?: string,
  ) {
    return this.providers.gitlab.listGroups(
      user,
      credentialId,
      search?.slice(0, 100),
    );
  }

  @Post('gitlab/connections')
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'Connect a GitLab group' })
  async gitlabConnect(
    @CurrentUser() user: RequestUser,
    @Body() dto: ConnectGitlabGroupDto,
  ) {
    await this.providers.gitlab.connectGroup(
      user,
      dto.credentialId,
      dto.groupId,
    );

    return this.detail(user, 'gitlab');
  }

  // ---- Azure DevOps-specific ------------------------------------------------------------------

  @Get('azure_devops/credentials/:credentialId/organizations')
  @ApiOperation({
    summary: 'Azure DevOps organizations of the person who signed in',
  })
  azureDevopsOrganizations(
    @CurrentUser() user: RequestUser,
    @Param('credentialId', ParseUUIDPipe) credentialId: string,
    @Query('search') search?: string,
  ) {
    return this.providers.azureDevops.listOrganizations(
      user,
      credentialId,
      search?.slice(0, 100),
    );
  }

  @Post('azure_devops/connections')
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'Connect an Azure DevOps organization' })
  async azureDevopsConnect(
    @CurrentUser() user: RequestUser,
    @Body() dto: ConnectAzureDevopsOrganizationDto,
  ) {
    await this.providers.azureDevops.connectOrganization(
      user,
      dto.credentialId,
      dto.organizationId,
    );

    return this.detail(user, 'azure_devops');
  }

  // ---- Per connection -------------------------------------------------------------------------

  @Get('connections/:id/repositories')
  @ApiOperation({
    summary:
      'Repositories of a connection (refresh=true re-reads the provider)',
  })
  async repositories(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('refresh') refresh?: string,
  ) {
    const connection = await this.core.getConnection(user.organizationId, id);
    let stale = false;

    if (refresh === 'true' && connection.status !== 'disconnected') {
      try {
        await this.providers
          .get(connection.provider)
          .refreshRepositories(connection);
      } catch (error) {
        // Show the last known list instead of failing the dialog.
        stale = true;
        this.logger.warn(
          `refreshRepositories ${id}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    return this.core.getRepositoriesDto(user.organizationId, id, stale);
  }

  @Put('connections/:id/repositories')
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'Choose all or selected repositories' })
  async updateRepositories(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGitRepositoriesDto,
  ) {
    const { connection, enabled, disabled } = await this.core.updateSelection(
      user.organizationId,
      id,
      dto.selection,
      dto.enabledIds,
      user.userId,
    );

    if (enabled.length || disabled.length) {
      try {
        // Per-repository failures (e.g. no Maintainer rights on a GitLab project) are stored on
        // the repository row by the provider; this only catches a total failure.
        await this.providers
          .get(connection.provider)
          .applyRepositorySelection(connection, enabled, disabled);
      } catch (error) {
        this.logger.warn(
          `applyRepositorySelection ${id}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    return this.core.getRepositoriesDto(user.organizationId, id, false);
  }

  @Get('connections/:id/reconnect')
  @ImpersonationBlocked()
  @ApiOperation({
    summary:
      'Where to send the admin to restore a connection that needs attention',
  })
  async reconnect(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('return_to') returnTo?: string,
  ) {
    assertStateSecret();
    const connection = await this.core.getConnection(user.organizationId, id);

    return {
      url: await this.providers
        .get(connection.provider)
        .connectUrl(user.userId, user.organizationId, returnTo, connection.id),
    };
  }

  @Delete('connections/:id')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disconnect (history on tasks stays)' })
  async disconnect(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    const connection = await this.core.disconnect(
      user.organizationId,
      id,
      user.userId,
    );

    try {
      await this.providers.get(connection.provider).onDisconnect(connection);
    } catch (error) {
      this.logger.warn(
        `onDisconnect ${id}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ---- Branch naming convention (organization-wide, ticket 3) ----------------------------------

  @Get('branch-settings')
  @ApiOperation({ summary: "The organization's branch naming convention" })
  branchSettings(@CurrentUser() user: RequestUser) {
    return this.core.getBranchSettings(user.organizationId);
  }

  @Put('branch-settings')
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'Set the branch naming convention for everyone' })
  updateBranchSettings(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateGitBranchSettingsDto,
  ) {
    return this.core.updateBranchSettings(
      user.organizationId,
      { prefix: dto.prefix, keyCase: dto.keyCase },
      user.userId,
    );
  }

  // ---- Generic per provider (last, so the literal routes above win) ---------------------------

  @Get(':provider')
  @ApiOperation({
    summary: 'Provider detail page: connections, settings, legacy connections',
  })
  async detail(
    @CurrentUser() user: RequestUser,
    @Param('provider') provider: string,
    @Query('serverId', OPTIONAL_UUID) serverId?: string,
  ) {
    const adapter = this.providers.get(provider);
    const manageUrl = (connection: Parameters<typeof adapter.manageUrl>[0]) =>
      adapter.manageUrl(connection);

    if (serverId) {
      const server = await this.servers.get(user.organizationId, serverId);

      if (server.provider !== adapter.provider)
        throw new NotFoundException('Git server not found');

      return this.core.getDetail(
        user.organizationId,
        adapter.provider,
        isAppComplete(this.servers.toApp(server)),
        manageUrl,
        { only: server.host },
      );
    }

    return this.core.getDetail(
      user.organizationId,
      adapter.provider,
      adapter.isConfigured(),
      manageUrl,
      { exclude: (await this.ownHosts(user.organizationId))[adapter.provider] },
    );
  }

  @Get(':provider/connect')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Where to send the admin to connect a new account / group',
  })
  async connect(
    @CurrentUser() user: RequestUser,
    @Param('provider') provider: string,
    @Query('return_to') returnTo?: string,
    @Query('serverId', OPTIONAL_UUID) serverId?: string,
  ) {
    assertStateSecret();

    return {
      url: await this.providers
        .get(provider)
        .connectUrl(
          user.userId,
          user.organizationId,
          returnTo,
          undefined,
          serverId,
        ),
    };
  }

  @Put(':provider/settings')
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'Org-wide pull request and commit settings' })
  updateSettings(
    @CurrentUser() user: RequestUser,
    @Param('provider') provider: string,
    @Body() dto: UpdateGitSettingsDto,
  ) {
    const adapter = this.providers.get(provider);

    return this.core.updateSettings(
      user.organizationId,
      adapter.provider,
      dto,
      user.userId,
    );
  }

  @Get(':provider/members')
  @ApiOperation({
    summary: 'Members of this organization who linked a personal account',
  })
  linkedMembers(
    @CurrentUser() user: RequestUser,
    @Param('provider') provider: string,
    @Query('serverId', OPTIONAL_UUID) serverId?: string,
  ) {
    return this.identities.listLinkedMembers(
      user.organizationId,
      this.providers.get(provider).provider,
      serverId,
    );
  }

  @Delete(':provider/members/:userId')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove a member's wrong personal-account link" })
  async removeMemberLink(
    @CurrentUser() user: RequestUser,
    @Param('provider') provider: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
    @Query('serverId', OPTIONAL_UUID) serverId?: string,
  ): Promise<void> {
    await this.identities.removeMemberLink(
      user.organizationId,
      user.userId,
      this.providers.get(provider).provider,
      targetUserId,
      serverId,
    );
  }
}
