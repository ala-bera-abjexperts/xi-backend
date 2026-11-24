/**
 * @fileoverview On-Prem Updates feature module. Imported by AppModule ONLY when
 * IS_ON_PREMISE is truthy, so none of these routes/providers exist in the SaaS
 * build. Provides the controller, the sidecar HTTP client, the service (SSE +
 * masking), and the defense-in-depth OnPremGuard. ConfigService is global.
 * @module src/on-prem-updates/on-prem-updates.module
 */
import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OnPremUpdatesController } from './on-prem-updates.controller';
import { OnPremUpdatesService } from './on-prem-updates.service';
import { UpdaterClientService } from './updater-client.service';
import { OnPremUpdateNoticeCron } from './on-prem-update-notice.cron';
import { OnPremGuard } from './guards/on-prem.guard';

@Module({
  // NotificationsModule supplies the broadcast + email services the daily notice uses.
  // SupabaseAdminService and OnPremiseTenantService come from @Global() modules.
  imports: [AuditLogsModule, NotificationsModule],
  controllers: [OnPremUpdatesController],
  providers: [
    OnPremUpdatesService,
    UpdaterClientService,
    OnPremGuard,
    // Registering the cron HERE is what keeps it on-premise-only: this module is imported by
    // AppModule solely when IS_ON_PREMISE is truthy, so the SaaS build never instantiates it and
    // the @Cron is never scheduled.
    OnPremUpdateNoticeCron,
  ],
  // Reused by OnPremConfigModule (Server configuration talks to the same sidecar).
  exports: [UpdaterClientService, OnPremGuard],
})
export class OnPremUpdatesModule {}
