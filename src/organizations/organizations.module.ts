/**
 * @fileoverview NestJS module that registers the {@link OrganizationsService} and
 * {@link OrganizationsController} for organization management and branding.
 * @module src/organizations/organizations.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { UsersModule } from '../users/users.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

/**
 * Module that provides organization management and branding endpoints.
 *
 * Imports:
 * - `UsersModule` -- provides {@link UsersService} for user profile lookups during onboarding
 *
 * @example
 * // Import in AppModule:
 * @Module({ imports: [OrganizationsModule] })
 * export class AppModule {}
 */
@Module({
  imports: [UsersModule, AuditLogsModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
