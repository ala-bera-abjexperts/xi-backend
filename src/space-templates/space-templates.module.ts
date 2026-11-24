import { Module } from '@nestjs/common';
import { LicensingModule } from '../licensing/licensing.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { TestManagementModule } from '../test-management/test-management.module';
import { SpaceTemplatesService } from './space-templates.service';
import { SpaceTemplatesController } from './space-templates.controller';

@Module({
  // LicensingModule: RP entitlement check when capturing/applying templates.
  // TestManagementModule: test task types are left out on capture and added on apply.
  imports: [PermissionsModule, LicensingModule, TestManagementModule],
  controllers: [SpaceTemplatesController],
  providers: [SpaceTemplatesService],
  exports: [SpaceTemplatesService],
})
export class SpaceTemplatesModule {}
