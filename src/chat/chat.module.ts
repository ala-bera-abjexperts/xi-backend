/**
 * @fileoverview Chat module (XE-T353): conversations, messages, notifications,
 * realtime signals and object cards.
 * Database layer: risk-management-app/supabase/migrations/2026092812*_chat_* and
 * 20260929120100_chat_core_functions.sql. SupabaseModule is global.
 * Must never import AttachmentsModule: AttachmentsModule imports this one.
 * @module src/chat/chat.module
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { WikiModule } from '../wiki/wiki.module';
import { ChatAccessService } from './chat-access.service';
import { ChatConversationsController } from './chat-conversations.controller';
import { ChatConversationsService } from './chat-conversations.service';
import { ChatMessagesController } from './chat-messages.controller';
import { ChatMessagesService } from './chat-messages.service';
import { ChatNotificationsController } from './chat-notifications.controller';
import { ChatNotificationsService } from './chat-notifications.service';
import { ChatRealtimeService } from './chat-realtime.service';
import { ChatRefsService } from './chat-refs.service';

@Module({
  imports: [
    PermissionsModule,
    NotificationsModule,
    // The email fallback of chat notifications. ScheduleModule (the minute sweep) is
    // registered once in AppModule.
    MailModule,
    // Page-level restrictions for wiki object cards. WikiModule does not import chat.
    WikiModule,
    // Local registration: ChatRealtimeService signs with an explicit secret + HS256.
    JwtModule.register({}),
  ],
  controllers: [
    ChatConversationsController,
    ChatMessagesController,
    ChatNotificationsController,
  ],
  providers: [
    ChatAccessService,
    ChatConversationsService,
    ChatMessagesService,
    ChatNotificationsService,
    ChatRealtimeService,
    ChatRefsService,
  ],
  // ChatAgentModule (Robert) builds on these. It imports this module, never the
  // other way round.
  exports: [
    ChatAccessService,
    ChatConversationsService,
    ChatMessagesService,
    ChatRealtimeService,
    ChatRefsService,
  ],
})
export class ChatModule {}
