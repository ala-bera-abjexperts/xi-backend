import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { RequireSuperAdmin } from '../auth/decorators/require-super-admin.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { OnpremReleasesService } from './onprem-releases.service';
import { OnpremLicenseService } from './onprem-license.service';
import { LicenseCheckDto } from './dto/license-check.dto';
import { PublishReleaseDto } from './dto/publish-release.dto';

@ApiTags('onprem-releases')
@Controller('onprem')
export class OnpremReleasesController {
  private readonly logger = new Logger(OnpremReleasesController.name);

  constructor(
    private readonly service: OnpremReleasesService,
    private readonly licenseService: OnpremLicenseService,
  ) {}

  /**
   * PUBLIC: latest on-prem release for each client's updater (update-agent.sh) to
   * discover updates. Returns { version: null } when nothing is published yet.
   * Optional ?org=&current= are accepted (future per-client targeting) and ignored.
   */
  @Public()
  @Get('release')
  async getLatest(
    @Query('channel') channel?: string,
    @Headers('x-activation-code') activationCode?: string,
  ) {
    // Licence-gated updates (audit O8). The updater sidecar lives in a separate
    // deployer repo and does not send the header yet, so it stays OPTIONAL for
    // now: present = enforced, absent = served with a log line. Make it
    // required once the deployer sends it.
    if (activationCode) {
      if (!(await this.licenseService.isActivationCodeLive(activationCode))) {
        throw new ForbiddenException(
          'This installation is not licensed to receive updates',
        );
      }
    } else {
      this.logger.log('release manifest requested without an activation code');
    }

    return this.service.getLatest(channel || 'stable');
  }

  /**
   * PUBLIC in the anonymous-auth sense, but NOT unauthenticated: the activation
   * code in the body IS the credential, and it is the only thing that maps a
   * caller to a tenant. There is no session here because an on-prem box has no
   * SaaS user to log in as.
   *
   * Always returns 200 with a signed artifact, including for an unrecognised
   * code (status `unknown`). Distinguishable HTTP failures would let a customer
   * suppress a "locked" answer by blocking the response and make it look like a
   * network outage, which the box is required to tolerate.
   */
  @Public()
  @Post('license/check')
  checkLicense(@Body() dto: LicenseCheckDto) {
    return this.licenseService.issue({
      activationCode: dto.activationCode,
      nonce: dto.nonce ?? null,
      release: dto.release ?? null,
      hostInfo: dto.hostInfo ?? null,
      installationId: dto.installationId ?? null,
      fingerprint: dto.fingerprint ?? null,
      publicKey: dto.publicKey ?? null,
      usage: dto.usage
        ? { ...dto.usage, version: dto.usage.version ?? null }
        : null,
    });
  }

  /**
   * Vendor (platform super admin) only: publish a release (called by
   * scripts/publish-release.sh with a SUPER ADMIN token). A tenant owner/admin
   * must never be able to push an update manifest to every on-prem customer.
   */
  @ImpersonationBlocked()
  @RequireSuperAdmin()
  @UseGuards(SuperAdminGuard)
  @Post('release')
  publish(@CurrentUser() user: RequestUser, @Body() dto: PublishReleaseDto) {
    return this.service.publish(dto, user?.userId);
  }
}
