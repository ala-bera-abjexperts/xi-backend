import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { TaskSidebarPreferencesController } from './task-sidebar-preferences.controller';
import { TaskSidebarPreferencesService } from './task-sidebar-preferences.service';

@Module({
  imports: [AuditLogsModule, PermissionsModule],
  controllers: [TaskSidebarPreferencesController],
  providers: [TaskSidebarPreferencesService],
})
export class TaskSidebarPreferencesModule {}
