/**
 * @fileoverview Development module, per space: which of the tenant's repositories a space shows.
 * Tenant Config > Integrations keeps managing connections and the tenant's repository selection; a
 * space can only pick from that set. Space admins (the same grant as the module toggle) read and save:
 * the list names every repository of the tenant, private ones included, so viewing a space is not enough.
 * @module src/git-integrations/git-space-repositories.controller
 */

import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { UpdateSpaceGitRepositoriesDto } from './git-integrations.dto';
import { GitIntegrationsService } from './git-integrations.service';
import type { ISpaceGitRepositoriesDto } from './git-integrations.types';

/** `:spaceId`, never `:id`: SpacePermissionsGuard reads the space from it. */
@ApiTags('Git Integrations')
@ApiBearerAuth()
@RequireFeature('feature_external_integrations')
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/development/repositories')
export class GitSpaceRepositoriesController {
  constructor(private readonly core: GitIntegrationsService) {}

  @Get()
  @RequireSpacePermission('edit_space_modules', ['can_edit_space_modules'])
  @ApiOperation({
    summary: "The tenant's repositories and which of them the space shows",
  })
  get(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ): Promise<ISpaceGitRepositoriesDto> {
    return this.core.getSpaceRepositoriesDto(user.organizationId, spaceId);
  }

  @Put()
  @ImpersonationBlocked()
  @RequireSpacePermission('edit_space_modules', ['can_edit_space_modules'])
  @ApiOperation({
    summary: "Replace the space's repositories (409 when changed meanwhile)",
  })
  put(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: UpdateSpaceGitRepositoriesDto,
  ): Promise<ISpaceGitRepositoriesDto> {
    return this.core.setSpaceRepositories(
      user.organizationId,
      spaceId,
      user.userId,
      dto.repositoryIds,
      dto.expectedRepositoryIds,
    );
  }
}
