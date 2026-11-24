import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { McpSettingsController } from './mcp-settings.controller';
import { McpSettingsRepository } from './mcp-settings.repository';
import { McpSettingsService } from './mcp-settings.service';

@Module({
  imports: [AuditLogsModule, PermissionsModule],
  controllers: [McpSettingsController],
  providers: [McpSettingsService, McpSettingsRepository],
  exports: [McpSettingsService],
})
export class McpSettingsModule {}
