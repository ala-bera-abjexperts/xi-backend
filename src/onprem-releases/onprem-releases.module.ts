import { Module } from '@nestjs/common';
import { OnpremReleasesController } from './onprem-releases.controller';
import { OnpremReleasesService } from './onprem-releases.service';
import { OnpremLicenseService } from './onprem-license.service';
import { OnpremInstallationsService } from './onprem-installations.service';
import { AdminOnpremInstallationsController } from './admin-onprem-installations.controller';
import { LicensingModule } from '../licensing/licensing.module';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';

/**
 * Isolated, additive module that serves the on-prem "latest release" manifest.
 * Registered unconditionally (the SaaS hosts the manifest), but touches no existing
 * module/route/table. SupabaseModule is @Global, so no import is needed here.
 */
@Module({
  imports: [LicensingModule],
  controllers: [OnpremReleasesController, AdminOnpremInstallationsController],
  providers: [
    OnpremReleasesService,
    OnpremLicenseService,
    OnpremInstallationsService,
    SuperAdminGuard,
  ],
  exports: [OnpremInstallationsService],
})
export class OnpremReleasesModule {}
