import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { LicensingModule } from '../licensing/licensing.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { OrganizationModuleRepository } from './organization-module.repository';
import { OrganizationModulesController } from './organization-modules.controller';
import { OrganizationModulesService } from './organization-modules.service';

@Module({
  imports: [AuditLogsModule, LicensingModule, PermissionsModule],
  controllers: [OrganizationModulesController],
  providers: [OrganizationModulesService, OrganizationModuleRepository],
  exports: [OrganizationModulesService, OrganizationModuleRepository],
})
export class OrganizationModulesModule {}
