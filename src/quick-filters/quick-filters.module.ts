import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { QuickFiltersController } from './quick-filters.controller';
import { QuickFiltersUserStateController } from './quick-filters-user-state.controller';
import { QuickFiltersService } from './quick-filters.service';

@Module({
  imports: [PermissionsModule, UsersModule, AuditLogsModule],
  controllers: [QuickFiltersController, QuickFiltersUserStateController],
  providers: [QuickFiltersService],
  exports: [QuickFiltersService],
})
export class QuickFiltersModule {}
