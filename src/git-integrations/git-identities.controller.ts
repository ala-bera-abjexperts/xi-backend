/**
 * @fileoverview The signed-in person's own GitHub / GitLab link (user profile > Connected accounts).
 *
 * Any member may call these, but only for themselves: the user always comes from the session,
 * never from the request. Not licence-gated: a link only says who someone is and gives no access.
 * Connect and disconnect are blocked while impersonating, so an administrator cannot attach their
 * own Git account to somebody else. Global prefix is `api/v1`.
 * @module src/git-integrations/git-identities.controller
 */

import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { GitIdentitiesService } from './git-identities.service';
import { GIT_PROVIDERS, type GitProvider } from './git-integrations.types';
import type { GitIdentityReturnPage } from './git-integrations.util';

function providerParam(value: string): GitProvider {
  if (!(GIT_PROVIDERS as readonly string[]).includes(value)) {
    throw new BadRequestException(`Unknown provider "${value}"`);
  }

  return value as GitProvider;
}

@ApiTags('Git Identities')
@ApiBearerAuth()
@Controller('git-identities')
export class GitIdentitiesController {
  constructor(private readonly identities: GitIdentitiesService) {}

  @Get('me')
  @ApiOperation({
    summary:
      "My linked GitHub / GitLab accounts: built-in apps plus this organization's own servers",
  })
  me(@CurrentUser() user: RequestUser) {
    return this.identities.listMine(user.userId, user.organizationId);
  }

  @Get(':provider/connect')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Where to send me to link my GitHub / GitLab account',
  })
  async connect(
    @CurrentUser() user: RequestUser,
    @Param('provider') provider: string,
    @Query('return_to') returnTo?: string,
    @Query('from') from?: string,
    @Query('serverId', new ParseUUIDPipe({ optional: true })) serverId?: string,
  ) {
    const page: GitIdentityReturnPage =
      from === 'integrations' ? 'integrations' : 'profile';

    return {
      url: await this.identities.connectUrl(
        providerParam(provider),
        user.userId,
        user.organizationId,
        returnTo,
        page,
        serverId,
      ),
    };
  }

  @Delete(':provider')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unlink my GitHub / GitLab account' })
  async disconnect(
    @CurrentUser() user: RequestUser,
    @Param('provider') provider: string,
    @Query('serverId', new ParseUUIDPipe({ optional: true })) serverId?: string,
  ): Promise<void> {
    await this.identities.unlink(
      user.userId,
      user.organizationId,
      providerParam(provider),
      serverId,
    );
  }
}
