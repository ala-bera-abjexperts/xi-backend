/**
 * @fileoverview NestJS module for the Wiki feature — pages, versions,
 * comments, attachments, links, labels, page-level permissions, realtime
 * collaboration, review workflow, and full-text search (Wiki 2.0).
 * @module src/wiki/wiki.module
 */

import { forwardRef, Module } from '@nestjs/common';
import { AgentOriginModule } from '../chat-agent/agent-origin.module';
import { JwtModule } from '@nestjs/jwt';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { AutomationsModule } from '../automations/automations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WatchersModule } from '../watchers/watchers.module';
import { WhiteboardsModule } from '../whiteboards/whiteboards.module';
import { WikiService } from './wiki.service';
import { WikiFieldKeysService } from './wiki-field-keys.service';
import { WikiLabelsService } from './wiki-labels.service';
import { WikiPermissionsService } from './wiki-permissions.service';
import { WikiCommentsService } from './wiki-comments.service';
import { WikiCollabService } from './wiki-collab.service';
import { WikiCollabBroadcastService } from './wiki-collab-broadcast.service';
import { WikiWorkflowService } from './wiki-workflow.service';
import { WikiSearchService } from './wiki-search.service';
import { WikiMineService } from './wiki-mine.service';
import { WikiMineWriteService } from './wiki-mine-write.service';
import { WikiController } from './wiki.controller';
import { WhiteboardDetailsController } from './whiteboard-details.controller';
import { WhiteboardDetailsService } from './whiteboard-details.service';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { WikiGlobalController } from './wiki-global.controller';
import { WikiLabelsController } from './wiki-labels.controller';
import { WikiTemplatesController } from './wiki-templates.controller';
import { WikiTemplatesService } from './wiki-templates.service';
import { WikiCollabController } from './wiki-collab.controller';
import { WikiWorkflowController } from './wiki-workflow.controller';
import { WikiMineController } from './wiki-mine.controller';
import { WikiMineWriteController } from './wiki-mine-write.controller';
import { WikiMacroController } from './macros/wiki-macro.controller';
import { WikiMacroRepository } from './macros/wiki-macro.repository';
import { WikiMacroService } from './macros/wiki-macro.service';

@Module({
  imports: [
    AgentOriginModule,
    PermissionsModule,
    AuditLogsModule,
    UsersModule,
    AutomationsModule,
    NotificationsModule,
    forwardRef(() => WatchersModule),
    // Whiteboard link rows in the tree (create/delete the board behind them). forwardRef: the
    // whiteboards module reads the link rows' ACL through WikiPermissionsService.
    forwardRef(() => WhiteboardsModule),
    // Local registration (no global secret): WikiCollabService signs the
    // Realtime channel JWTs with an explicit secret + HS256.
    JwtModule.register({}),
  ],
  controllers: [
    WikiController,
    WikiGlobalController,
    WikiLabelsController,
    WikiTemplatesController,
    // Realtime co-editing (token/snapshot/heartbeat).
    WikiCollabController,
    // Review/approval workflow (settings + transitions).
    WikiWorkflowController,
    // MCP-facing member-space + page-ACL constrained reads.
    WikiMineController,
    // MCP-facing member-space + page-ACL constrained writes.
    WikiMineWriteController,
    WikiMacroController,
    // The whiteboard Details panel (board routes that write through the wiki services).
    WhiteboardDetailsController,
  ],
  providers: [
    WikiService,
    // Resolves which custom fields a space's wiki accepts (shared by the page
    // write path and the search sort gate).
    WikiFieldKeysService,
    WikiLabelsService,
    WikiTemplatesService,
    WikiPermissionsService,
    WikiCommentsService,
    WikiCollabService,
    WikiCollabBroadcastService,
    WikiWorkflowService,
    WikiSearchService,
    WikiMineService,
    WikiMineWriteService,
    WikiMacroService,
    WikiMacroRepository,
    WhiteboardDetailsService,
  ],
  // `WikiCommentsService` is exported for the migration's `page_comments` stage, which goes through
  // the service rather than writing `wiki_page_comments` directly.
  exports: [
    WikiService,
    WikiLabelsService,
    WikiPermissionsService,
    WikiCommentsService,
    // Robert (chat-agent) creates pages as the invoker and reads their pages.
    WikiMineService,
    WikiMineWriteService,
    WikiWorkflowService,
  ],
})
export class WikiModule {}
