/**
 * @fileoverview What the task page needs for "Copy git branch name" (ticket 3), readable by every
 * member: whether the organization uses Git at all (button hidden otherwise), its naming convention,
 * and the caller's own linked Git logins (for the `{username}` prefix and the "link your account"
 * hint). Reveals nothing about other members or about the connections themselves.
 * Global prefix is `api/v1`.
 * @module src/git-integrations/git-branch.controller
 */

import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { GitIdentitiesService } from './git-identities.service';
import { GitIntegrationsService } from './git-integrations.service';
import type { GitProvider } from './git-integrations.types';

@ApiTags('Git Branch')
@ApiBearerAuth()
@Controller('git-branch')
export class GitBranchController {
  constructor(
    private readonly core: GitIntegrationsService,
    private readonly identities: GitIdentitiesService,
  ) {}

  @Get('config')
  @ApiOperation({
    summary: 'Branch naming convention and whether this organization uses Git',
  })
  async config(@CurrentUser() user: RequestUser) {
    const [connectedProviders, settings, mine, everConnected] =
      await Promise.all([
        this.core.connectedProviders(user.organizationId),
        this.core.getBranchSettings(user.organizationId),
        this.identities.listMine(user.userId),
        this.core.everConnected(user.organizationId),
      ]);

    const login = (provider: GitProvider) =>
      mine.find((entry) => entry.provider === provider)?.identity?.login ??
      null;

    return {
      enabled: connectedProviders.length > 0,
      // Ticket 5: the Development section keeps showing old links after a disconnect.
      everConnected,
      prefix: settings.prefix,
      keyCase: settings.keyCase,
      connectedProviders,
      linked: {
        github: login('github'),
        gitlab: login('gitlab'),
        azure_devops: login('azure_devops'),
      },
    };
  }
}
