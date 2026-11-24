import { Module } from '@nestjs/common';

import { OrganizationModulesModule } from '../../organization-modules/organization-modules.module';
import { PermissionsModule } from '../../permissions/permissions.module';
import { TestManagementAccessService } from './test-management-access.service';
import { TestManagementAttachmentAccessService } from './test-management-attachment-access.service';

/** Kept small so other modules (attachments later) can check access without importing all of Test Management. */
@Module({
  imports: [OrganizationModulesModule, PermissionsModule],
  providers: [
    TestManagementAccessService,
    TestManagementAttachmentAccessService,
  ],
  exports: [TestManagementAccessService, TestManagementAttachmentAccessService],
})
export class TestManagementAccessModule {}
