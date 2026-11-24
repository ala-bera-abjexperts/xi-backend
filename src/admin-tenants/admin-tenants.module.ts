import { Module } from '@nestjs/common';

import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { LicensingModule } from '../licensing/licensing.module';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { PermissionsModule } from '../permissions/permissions.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { AdminController } from './admin.controller';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';

@Module({
  imports: [
    AuditLogsModule,
    LicensingModule,
    PermissionsModule,
    SupabaseModule,
  ],
  controllers: [AdminController, AdminTenantsController],
  providers: [AdminTenantsService, SuperAdminGuard],
})
export class AdminTenantsModule {}
