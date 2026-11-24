/**
 * @fileoverview NestJS module that provides the {@link UsersService} for querying user profiles
 * from the `public.users` table. Exported for use by auth and other feature modules.
 * @module src/users/users.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { PreferencesService } from './preferences.service';
import { PreferencesController } from './preferences.controller';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';

/**
 * Module that registers and exports {@link UsersService}, {@link PreferencesService},
 * {@link UsersController}, and {@link PreferencesController}.
 *
 * Imported by modules that need to look up user profiles (e.g., AuthModule, InvitationsModule).
 *
 * @example
 * // Import in another module:
 * @Module({ imports: [UsersModule] })
 * export class AuthModule {}
 */
@Module({
  imports: [AuditLogsModule, PermissionsModule],
  controllers: [UsersController, PreferencesController],
  providers: [UsersService, PreferencesService],
  exports: [UsersService, PreferencesService],
})
export class UsersModule {}
