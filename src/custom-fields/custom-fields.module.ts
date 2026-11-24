/**
 * @fileoverview NestJS module for the Custom Fields + Field Groups feature.
 * @module src/custom-fields/custom-fields.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { LicensingModule } from '../licensing/licensing.module';
import { CustomFieldsService } from './custom-fields.service';
import { CustomFieldsController } from './custom-fields.controller';
import { FieldGroupsService } from './field-groups.service';
import { FieldGroupsController } from './field-groups.controller';

/**
 * Module registering the custom fields + field groups services and
 * controllers.
 *
 * Imports {@link PermissionsModule} so `PermissionsGuard` can resolve
 * `can_manage_custom_fields` on write endpoints.
 */
@Module({
  imports: [
    PermissionsModule,
    UsersModule,
    AuditLogsModule,
    // Supplies EntitlementsService for the warn-only field-limit check.
    LicensingModule,
  ],
  controllers: [CustomFieldsController, FieldGroupsController],
  providers: [CustomFieldsService, FieldGroupsService],
  exports: [CustomFieldsService, FieldGroupsService],
})
export class CustomFieldsModule {}
