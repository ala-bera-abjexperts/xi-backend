/**
 * @fileoverview NestJS module for status categories.
 * @module src/status-categories/status-categories.module
 * @author Rajbha Manek
 */
import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { StatusCategoriesService } from './status-categories.service';
import { StatusCategoriesController } from './status-categories.controller';

@Module({
  imports: [PermissionsModule, UsersModule, AuditLogsModule],
  controllers: [StatusCategoriesController],
  providers: [StatusCategoriesService],
  exports: [StatusCategoriesService],
})
export class StatusCategoriesModule {}
