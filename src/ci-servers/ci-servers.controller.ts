/**
 * @fileoverview Admin API behind Tenant Configuration > Integrations for Jenkins servers.
 * Owners and admins only, licence-gated like the Git integrations. Global prefix is `api/v1`.
 * @module src/ci-servers/ci-servers.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireRoles } from '../auth/decorators/require-roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { CiServersService } from './ci-servers.service';
import { CreateCiServerDto, UpdateCiServerDto } from './dto/ci-server.dto';

@RequireFeature('feature_external_integrations')
@ApiTags('CI Servers')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@RequireRoles('admin', 'owner')
@Controller('ci-servers')
export class CiServersController {
  constructor(private readonly servers: CiServersService) {}

  @Get()
  @ApiOperation({ summary: "The organization's Jenkins servers" })
  list(@CurrentUser() user: RequestUser) {
    return this.servers.listForOrg(user.organizationId);
  }

  @Post()
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'Connect a Jenkins server' })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateCiServerDto) {
    return this.servers.create(user.organizationId, user.userId, dto);
  }

  @Put(':id')
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'Change name, address, user name or token' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCiServerDto,
  ) {
    return this.servers.update(user.organizationId, id, user.userId, dto);
  }

  @Delete(':id')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a server no CI job uses' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.servers.remove(user.organizationId, id, user.userId);
  }

  @Post(':id/test')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in to the server with the saved token' })
  test(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.servers.test(user.organizationId, id, user.userId);
  }

  @Get(':id/jobs')
  @ApiOperation({ summary: 'Jobs and folders on the server' })
  jobs(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.servers.listJobs(user.organizationId, id);
  }
}
