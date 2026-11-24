import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { PermissionsModule } from '../../permissions/permissions.module';
import { DomainsController } from './domains.controller';
import { DomainsService } from './domains.service';
import { SiteStudioDomainsCron } from './site-studio-domains.cron';
import { SiteStudioServingService } from './site-studio-serving.service';
import { VercelDomainsService } from './vercel-domains.service';

@Module({
  imports: [PermissionsModule, AuditLogsModule],
  controllers: [DomainsController],
  providers: [
    DomainsService,
    VercelDomainsService,
    SiteStudioDomainsCron,
    SiteStudioServingService,
  ],
  // Exported so the public plane's on-demand-TLS gate can share the same cached
  // probe rather than opening its own connections.
  exports: [SiteStudioServingService],
})
export class DomainsModule {}
