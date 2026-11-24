/**
 * @fileoverview NestJS module that provides the {@link PermissionsService} for resolving
 * effective user permissions based on base roles, custom roles, and group memberships.
 * @module src/permissions/permissions.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { PermissionsController } from './permissions.controller';

/**
 * Module that registers and exports {@link PermissionsService}.
 * Exposes HTTP endpoints via {@link PermissionsController}.
 *
 * Imported by modules that need permission checking (e.g., InvitationsModule, guard providers).
 *
 * @example
 * // Import in another module:
 * @Module({ imports: [PermissionsModule] })
 * export class InvitationsModule {}
 */
@Module({
  controllers: [PermissionsController],
  providers: [PermissionsService],
  exports: [PermissionsService],
})
export class PermissionsModule {}
