/**
 * @fileoverview NestJS module for relation types.
 * @module src/relation-types/relation-types.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { RelationTypesService } from './relation-types.service';
import { RelationTypesController } from './relation-types.controller';

@Module({
  imports: [PermissionsModule, UsersModule, AuditLogsModule],
  controllers: [RelationTypesController],
  providers: [RelationTypesService],
  exports: [RelationTypesService],
})
export class RelationTypesModule {}
