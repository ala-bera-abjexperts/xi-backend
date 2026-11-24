import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { OrganizationModulesModule } from '../organization-modules/organization-modules.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { WikiModule } from '../wiki/wiki.module';
import { WhiteboardLiveController } from './whiteboard-live.controller';
import { WhiteboardLiveService } from './whiteboard-live.service';
import { WhiteboardsController } from './whiteboards.controller';
import { WhiteboardsService } from './whiteboards.service';

@Module({
  // SupabaseModule is @Global(). PermissionsModule backs SpacePermissionsGuard. WikiModule: the
  // board's Share setting is its link row's page ACL (WikiPermissionsService); forwardRef because
  // WikiModule imports this module for the link rows.
  imports: [
    AuditLogsModule,
    OrganizationModulesModule,
    PermissionsModule,
    forwardRef(() => WikiModule),
    // Local registration (no global secret): the live channel token is signed with an explicit
    // secret + HS256, as WikiModule does for the wiki's collab channel.
    JwtModule.register({}),
  ],
  controllers: [WhiteboardsController, WhiteboardLiveController],
  providers: [WhiteboardsService, WhiteboardLiveService],
  // The wiki tree creates and deletes boards through it (link rows); board comments (wiki comments
  // on the link row) ping the board's live channel through WhiteboardLiveService.
  exports: [WhiteboardsService, WhiteboardLiveService],
})
export class WhiteboardsModule {}
