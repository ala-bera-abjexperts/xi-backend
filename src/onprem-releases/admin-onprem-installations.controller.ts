/**
 * @fileoverview Super admin view of every on-prem installation (partner-sold
 * and direct XISUITE customers): status, check-ins, usage, and the actions to
 * activate/deactivate, rotate codes, reset the bound box and issue offline
 * licence files.
 * @module onprem-releases/admin-onprem-installations.controller
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireSuperAdmin } from '../auth/decorators/require-super-admin.decorator';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  CreateOnpremInstallDto,
  OfflineLicenseDto,
  UpdateOnpremInstallDto,
} from './dto/onprem-installations.dto';
import {
  OnpremInstallationsService,
  type OnpremScope,
} from './onprem-installations.service';
import { OnpremLicenseService } from './onprem-license.service';

const SA: OnpremScope = { kind: 'super_admin' };

@ApiTags('Admin On-Prem Installations')
@ApiBearerAuth()
@ImpersonationBlocked()
@RequireSuperAdmin()
@UseGuards(SuperAdminGuard)
@Controller('admin/onprem-installations')
export class AdminOnpremInstallationsController {
  constructor(
    private readonly installs: OnpremInstallationsService,
    private readonly licenses: OnpremLicenseService,
  ) {}

  @Get()
  list() {
    return this.installs.list(SA);
  }

  /** Whether this deployment can sign licences that on-prem boxes accept. */
  @Get('health')
  health() {
    return { signing: this.licenses.signingStatus() };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateOnpremInstallDto,
  ) {
    return this.installs.create(SA, user.userId, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOnpremInstallDto,
  ) {
    return this.installs.update(SA, user.userId, id, dto);
  }

  @Post(':id/rotate-code')
  @HttpCode(HttpStatus.OK)
  rotate(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.installs.rotateCode(SA, user.userId, id);
  }

  @Post(':id/reset-fingerprint')
  @HttpCode(HttpStatus.OK)
  reset(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.installs.resetFingerprint(SA, user.userId, id);
  }

  @Post(':id/offline-license')
  @HttpCode(HttpStatus.OK)
  offline(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OfflineLicenseDto,
  ) {
    return this.installs.offlineLicense(SA, id, dto.request);
  }
}
