import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { OrganizationAuthProviderRepository } from './organization-auth-provider.repository';
import { OrganizationAuthProvidersController } from './organization-auth-providers.controller';
import { OrganizationAuthProvidersService } from './organization-auth-providers.service';

@Module({
  imports: [AuditLogsModule, PermissionsModule],
  controllers: [OrganizationAuthProvidersController],
  providers: [
    OrganizationAuthProvidersService,
    OrganizationAuthProviderRepository,
  ],
  exports: [
    OrganizationAuthProvidersService,
    OrganizationAuthProviderRepository,
  ],
})
export class OrganizationAuthProvidersModule {}
