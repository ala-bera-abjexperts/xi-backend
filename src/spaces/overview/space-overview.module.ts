/**
 * @fileoverview Registers the space overview endpoint.
 * @module src/spaces/overview/space-overview.module
 */

import { Module } from '@nestjs/common';
import { SpacesModule } from '../spaces.module';
import { PermissionsModule } from '../../permissions/permissions.module';
import { LicensingModule } from '../../licensing/licensing.module';
import { OrganizationModulesModule } from '../../organization-modules/organization-modules.module';
import { WikiModule } from '../../wiki/wiki.module';
import { AssetsObjectsModule } from '../../assets-objects/assets-objects.module';
import { DashboardsModule } from '../../dashboards/dashboards.module';
import { FileExplorerModule } from '../../file-explorer/file-explorer.module';
import { SpaceOverviewController } from './space-overview.controller';
import { SpaceOverviewService } from './space-overview.service';

@Module({
  imports: [
    SpacesModule,
    PermissionsModule,
    LicensingModule,
    OrganizationModulesModule,
    WikiModule,
    AssetsObjectsModule,
    DashboardsModule,
    FileExplorerModule,
  ],
  controllers: [SpaceOverviewController],
  providers: [SpaceOverviewService],
})
export class SpaceOverviewModule {}
