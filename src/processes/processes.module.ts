/**
 * @fileoverview NestJS module for ISMS business processes.
 * @module src/processes/processes.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { AgentOriginModule } from '../chat-agent/agent-origin.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AutomationsModule } from '../automations/automations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProcessesService } from './processes.service';
import { ProcessAttachmentsService } from './processes-attachments.service';
import { ProcessesController } from './processes.controller';
import { ProcessesSpacesCompatController } from './processes-spaces-compat.controller';

@Module({
  imports: [
    AgentOriginModule,
    PermissionsModule,
    UsersModule,
    AuditLogsModule,
    AutomationsModule,
    NotificationsModule,
  ],
  controllers: [ProcessesController, ProcessesSpacesCompatController],
  providers: [ProcessesService, ProcessAttachmentsService],
  exports: [ProcessesService, ProcessAttachmentsService],
})
export class ProcessesModule {}
