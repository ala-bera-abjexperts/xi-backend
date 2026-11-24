/**
 * @fileoverview NestJS module for the invitations feature. Wires together the invitations
 * controller, service, and dependencies (mail and permissions modules).
 * @module src/invitations/invitations.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { AutomationsModule } from '../automations/automations.module';
import { SpacesModule } from '../spaces/spaces.module';
import { UserGroupsModule } from '../user-groups/user-groups.module';
import { LicensingModule } from '../licensing/licensing.module';
import { MailModule } from '../mail/mail.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

/**
 * Feature module for invitation management.
 *
 * Imports:
 * - `MailModule` -- for sending invitation and space invitation emails
 * - `PermissionsModule` -- for the {@link PermissionsGuard} used on protected endpoints
 *
 * @example
 * // Import in AppModule:
 * @Module({ imports: [InvitationsModule] })
 * export class AppModule {}
 */
@Module({
  imports: [
    MailModule,
    PermissionsModule,
    AuditLogsModule,
    AutomationsModule,
    // Supplies EntitlementsService for the warn-only seat-limit check.
    LicensingModule,
    // Grant a claimed migration placeholder its project roles and groups (XE-T682).
    SpacesModule,
    UserGroupsModule,
  ],
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
