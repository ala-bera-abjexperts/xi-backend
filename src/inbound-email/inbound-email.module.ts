// Inbound email → ticket ingestion.
//
// Lives outside AutomationsModule on purpose: the ticket-creating action needs
// TasksService, and TasksModule already imports AutomationsModule — registering
// it there would be a circular dependency. Same shape as the Document Designer
// action, which self-registers from its own module.

import { Module } from '@nestjs/common';
import { AutomationsModule } from '../automations/automations.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { TasksModule } from '../tasks/tasks.module';
import { MailboxPollService } from './mailbox-poll.service';
import { InboundEmailCronService } from './inbound-email-cron.service';
import { CreateTicketFromEmailAction } from './create-ticket-from-email.action';
import { GraphTokenService } from './graph-token.service';
import { InboundEmailController } from './inbound-email.controller';
import { InboundEmailService } from './inbound-email.service';

// SupabaseModule is @Global, so it needs no explicit import here.
// Importing both TasksModule and AutomationsModule is safe: TasksModule already
// depends on AutomationsModule, and nothing depends on this module.
// AttachmentsModule is safe for the same reason — it imports neither TasksModule nor this one, so
// adding it here closes no cycle. It provides AttachmentsService for email attachment import.
@Module({
  imports: [
    AutomationsModule,
    AttachmentsModule,
    // For the inbound-email view's space-permission check.
    PermissionsModule,
    TasksModule,
  ],
  controllers: [InboundEmailController],
  providers: [
    GraphTokenService,
    MailboxPollService,
    InboundEmailCronService,
    CreateTicketFromEmailAction,
    InboundEmailService,
  ],
  exports: [MailboxPollService],
})
export class InboundEmailModule {}
