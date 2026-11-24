/**
 * @fileoverview Pull requests / merge requests on a task (tickets 4, 5): the Development section, link by pasted
 * address, and unlink. Viewing needs `can_view_tasks`, changing needs `can_edit_tasks` (org grant
 * or the task's space grant, resolved by PermissionsGuard from `/tasks/:id`). Licence-gated.
 * Global prefix is `api/v1`.
 * @module src/git-integrations/git-pull-requests.controller
 */

import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { LinkPullRequestDto } from './git-integrations.dto';
import type { IProviderPullRequest } from './git-integrations.types';
import { parsePullRequestUrl } from './git-integrations.util';
import { GitProvidersRegistry } from './git-providers.registry';
import {
  GitPullRequestsService,
  mapToServerHost,
} from './git-pull-requests.service';
import { GitServersService } from './git-servers.service';

@RequireFeature('feature_external_integrations')
@ApiTags('Git Pull Requests')
@ApiBearerAuth()
@Controller('tasks')
export class GitPullRequestsController {
  private readonly logger = new Logger(GitPullRequestsController.name);

  constructor(
    private readonly pullRequests: GitPullRequestsService,
    private readonly providers: GitProvidersRegistry,
    private readonly servers: GitServersService,
  ) {}

  @Get(':id/development')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({
    summary:
      'Development section: linked pull requests, branches without a pull request, subtask count',
  })
  development(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.pullRequests.getDevelopment(user.organizationId, id);
  }

  /**
   * Error messages (codes): `invalid_url` 400, `repository_not_connected` 422,
   * `pull_request_not_found` 404, `provider_unavailable` 502.
   * @returns `linked` false when it was already linked. The client refetches the Development section.
   */
  @Post(':id/pull-requests')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_tasks')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Link a pull request / merge request by its address',
  })
  async link(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkPullRequestDto,
  ) {
    // Ticket 11: an address on one of the organization's own servers (current or previous address,
    // GitLab relative root) is read with the server's stable host key.
    const onServer = mapToServerHost(
      dto.url,
      await this.servers.list(user.organizationId),
    );
    const parsed = parsePullRequestUrl(onServer ?? dto.url);

    if (!parsed) throw new BadRequestException('invalid_url');

    await this.pullRequests.assertTask(user.organizationId, id);

    const adapter = this.providers.get(parsed.provider);

    // The built-in app's own flag; an own server is checked when its app is resolved.
    if (!onServer && !adapter.isConfigured())
      throw new UnprocessableEntityException('repository_not_connected');

    const { connection, repository } = await this.pullRequests.findLinkTarget(
      user.organizationId,
      parsed,
    );

    await this.pullRequests.assertRepositoryInSpace(
      user.organizationId,
      id,
      repository.id,
    );
    // Read before the sync: if the key is in the pull request, the sync links it automatically and
    // the user's explicit link must still turn it into a (sticky) manual link with a history entry.
    const before = await this.pullRequests.linkState(
      user.organizationId,
      id,
      repository,
      parsed.number,
    );

    let pr: IProviderPullRequest;

    try {
      pr = await adapter.fetchPullRequest(
        connection,
        repository,
        parsed.number,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;

      this.logger.warn(
        `fetch ${parsed.provider} ${repository.full_name}#${parsed.number}: ${error instanceof Error ? error.message : error}`,
      );
      throw new BadGatewayException('provider_unavailable');
    }

    const { pullRequestId } = await this.pullRequests.sync(repository, pr);
    const linked = before !== 'linked';

    if (linked)
      await this.pullRequests.linkManual(user, id, pullRequestId, {
        provider: parsed.provider,
        repository: repository.full_name,
        repositoryId: repository.id,
        pr,
      });

    return { linked };
  }

  @Delete(':id/pull-requests/:pullRequestId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_tasks')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Unlink a pull request from the task (it stays unlinked)',
  })
  async unlink(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('pullRequestId', ParseUUIDPipe) pullRequestId: string,
  ): Promise<void> {
    await this.pullRequests.unlink(user, id, pullRequestId);
  }
}
