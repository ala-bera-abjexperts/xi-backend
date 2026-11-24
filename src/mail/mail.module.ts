/**
 * @fileoverview NestJS module that provides the {@link MailService} for sending transactional emails.
 * Exported for use by auth and invitation modules that need to deliver OTPs, password resets,
 * and invitation emails.
 * @module src/mail/mail.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { EmailTemplateService } from './email-template.service';

/**
 * Module that registers and exports {@link MailService} and {@link EmailTemplateService}.
 * Relies on the globally-provided {@link SupabaseAdminService} (for per-org branding).
 *
 * @example
 * // Import in another module:
 * @Module({ imports: [MailModule] })
 * export class AuthModule {}
 */
@Module({
  providers: [MailService, EmailTemplateService],
  exports: [MailService, EmailTemplateService],
})
export class MailModule {}
