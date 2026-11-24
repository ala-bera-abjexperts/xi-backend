import { Module } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service';
import { LicenseStatusCron } from './license-status.cron';
import { LicensingAdminController } from './licensing-admin.controller';
import { LicensingController } from './licensing.controller';
import { LicensingRepository } from './licensing.repository';
import { LicensingService } from './licensing.service';

/**
 * Licensing subsystem — exposes two route groups:
 *   - `LicensingController`        → /licensing/*           (tenant owners)
 *   - `LicensingAdminController`   → /admin/licensing/*     (platform Super Admins)
 *
 * Both controllers were previously defined but NOT registered here, so every
 * route 404'd at runtime. Adding them to `controllers` is the actual wiring.
 *
 * Guards used by these controllers (`SuperAdminGuard`, `RolesGuard`) only need
 * `Reflector` and `SupabaseAdminService` — both globally available via
 * `@Global() SupabaseModule` — so no extra imports are required.
 */
@Module({
  controllers: [LicensingController, LicensingAdminController],
  providers: [
    LicensingService,
    LicensingRepository,
    EntitlementsService,
    LicenseStatusCron,
  ],
  exports: [LicensingService, EntitlementsService],
})
export class LicensingModule {}
