/**
 * @fileoverview NestJS module for resolutions.
 * @module src/resolutions/resolutions.module
 * @author Rajbha Manek
 */
import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ResolutionsService } from './resolutions.service';
import { ResolutionsController } from './resolutions.controller';

@Module({
  imports: [PermissionsModule, UsersModule, AuditLogsModule],
  controllers: [ResolutionsController],
  providers: [ResolutionsService],
  exports: [ResolutionsService],
})
export class ResolutionsModule {}
