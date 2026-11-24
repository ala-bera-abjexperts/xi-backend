import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AiAutomationModule } from '../ai-automation/ai-automation.module';
import { AiConfigController } from './ai-config.controller';
import { AiConfigService } from './ai-config.service';

@Module({
  // AiAutomationModule for TenantAiService; it does not import this module back.
  imports: [UsersModule, AuditLogsModule, AiAutomationModule],
  controllers: [AiConfigController],
  providers: [AiConfigService],
  exports: [AiConfigService],
})
export class AiConfigModule {}
