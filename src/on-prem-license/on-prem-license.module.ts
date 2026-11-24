/**
 * @fileoverview On-premise licence enforcement. Registered by ABSENCE in SaaS.
 * @module on-prem-license/on-prem-license.module
 *
 * Author: Prince Jadiya
 *
 * Imported only when IS_ON_PREMISE is truthy (see app.module.ts), following the
 * same pattern as OnPremUpdatesModule: the feature is invisible on SaaS because
 * the module is never constructed, not because a runtime flag hides it. That is
 * what keeps the hard constraint "SaaS behaviour must not change" structural
 * rather than a matter of care.
 */

import { Module, OnModuleInit } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EntitlementsService } from '../licensing/entitlements.service';
import { LicensingModule } from '../licensing/licensing.module';
import { OnPremLicenseController } from './on-prem-license.controller';
import { OnpremLicenseCron } from './onprem-license.cron';
import { OnpremLicensePollService } from './onprem-license-poll.service';
import { OnpremLicenseStateRepository } from './onprem-license-state.repository';
import { OnpremLicenseStateService } from './onprem-license.service';
import { OnPremGuard } from '../on-prem-updates/guards/on-prem.guard';
import { LicenseReadOnlyGuard } from './license-read-only.guard';

@Module({
  imports: [LicensingModule],
  controllers: [OnPremLicenseController],
  providers: [
    OnpremLicenseStateRepository,
    OnpremLicenseStateService,
    OnpremLicensePollService,
    OnpremLicenseCron,
    OnPremGuard,
    // Global, but only on on-prem builds (this module is imported only when
    // IS_ON_PREMISE): refuses writes once the licence grace is over.
    { provide: APP_GUARD, useClass: LicenseReadOnlyGuard },
  ],
  exports: [OnpremLicenseStateService],
})
export class OnPremLicenseModule implements OnModuleInit {
  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly state: OnpremLicenseStateService,
  ) {}

  /**
   * Hands the entitlements resolver a lock gate. Because this module is only
   * constructed when IS_ON_PREMISE is truthy, nothing registers on SaaS and the
   * SaaS resolution path is untouched.
   */
  onModuleInit(): void {
    this.entitlements.registerOnPremGate(async () => {
      const s = await this.state.current();

      return {
        entitled: s.entitled,
        readOnly: s.readOnly,
        snapshot: OnpremLicenseStateService.snapshotOf(s.payload),
      };
    });
  }
}
