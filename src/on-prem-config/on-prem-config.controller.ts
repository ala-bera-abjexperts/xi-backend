/**
 * @fileoverview REST API for the on-prem Server configuration screen. Only exists on a
 * self-hosted stack (the module is omitted in SaaS) and only for org owners/admins,
 * with the same guards as /system-updates. Job progress is read through the existing
 * /system-updates/status|logs|stream endpoints.
 * @module src/on-prem-config/on-prem-config.controller
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireRoles } from '../auth/decorators/require-roles.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { OnPremGuard } from '../on-prem-updates/guards/on-prem.guard';
import { ApplyServerConfigDto } from './dto/apply-server-config.dto';
import { OnPremConfigService } from './on-prem-config.service';

@ApiTags('On-Prem Server Configuration')
@ApiBearerAuth()
@UseGuards(OnPremGuard, RolesGuard)
@RequireRoles('owner', 'admin')
@ImpersonationBlocked()
@Controller('system-config')
export class OnPremConfigController {
  constructor(private readonly service: OnPremConfigService) {}

  @Get()
  @ApiOperation({
    summary:
      'Server configuration (catalog, effective values, sources; secrets masked), or {available:false, reason}',
  })
  getConfig() {
    return this.service.getConfig();
  }

  @Post('apply')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Apply a configuration change (recreates affected services, auto-rollback on failure)',
  })
  apply(@CurrentUser() user: RequestUser, @Body() dto: ApplyServerConfigDto) {
    return this.service.apply(user, dto);
  }
}
