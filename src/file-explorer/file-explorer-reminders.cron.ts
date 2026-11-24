/**
 * @fileoverview Cron job that dispatches due file-explorer reminders.
 * Fires every minute, claims up to 50 due reminders atomically (optimistic mark-as-sent
 * before processing), and sends in-app notifications and/or emails.
 * @module src/file-explorer/file-explorer-reminders.cron
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { MailService } from '../mail/mail.service';
import { NotificationEmailService } from '../notifications/notification-email.service';

@Injectable()
export class FileExplorerRemindersCron {
  private readonly logger = new Logger(FileExplorerRemindersCron.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly mail: MailService,
    @Optional()
    private readonly notificationEmail?: NotificationEmailService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  @Cron('0 * * * * *') // every minute at the :00 second
  async dispatchDueReminders(): Promise<void> {
    const now = new Date().toISOString();

    // 1. Find candidate due reminders.
    const { data: candidates } = await this.db
      .from('fe_reminders')
      .select('id')
      .eq('is_sent', false)
      .lte('remind_at', now)
      .limit(50);

    if (!candidates?.length) return;

    const ids = candidates.map((r: any) => r.id as string);

    // 2. Atomically CLAIM only the rows that are still unsent. The `.eq('is_sent', false)`
    //    guard makes the claim safe across overlapping ticks / multiple instances — a second
    //    runner sees 0 rows for the same ids (no double-send). Only the rows RETURNED here are
    //    owned by this run; we also fetch the joined node for the is_deleted check.
    const { data: claimed } = await this.db
      .from('fe_reminders')
      .update({ is_sent: true, sent_at: now })
      .in('id', ids)
      .eq('is_sent', false)
      .select('*, fe_nodes(is_deleted, name, organization_id)');

    if (!claimed?.length) return;

    for (const r of claimed) {
      const node = r.fe_nodes;

      // Skip reminders on soft-deleted nodes — leave them claimed (sent) so they don't retry.
      if (!node || node.is_deleted) continue;

      // At-least-once delivery: if ANY requested channel fails, release the claim so the
      // reminder retries next tick (for 'both' this may re-deliver the succeeded channel —
      // an acceptable trade-off vs. silently losing the reminder).
      let delivered = true;

      // In-app notification.
      if (r.reminder_type === 'in_app' || r.reminder_type === 'both') {
        const { error } = await this.db.from('notifications').insert({
          organization_id: r.organization_id,
          user_id: r.user_id,
          type: 'file_explorer_reminder',
          title: `Reminder: ${node.name}`,
          body: r.message ?? `You set a reminder for "${node.name}"`,
          reference_type: 'file_explorer_node',
          reference_id: r.node_id,
          metadata: {},
          is_read: false,
        });

        if (error) {
          delivered = false;
          this.logger.error(
            `Failed to create notification for reminder ${r.id}: ${error.message}`,
          );
        }
      }

      // Email notification.
      if (r.reminder_type === 'email' || r.reminder_type === 'both') {
        // Honour the recipient's per-type Email preference. An intentional
        // opt-out is NOT a delivery failure — skip without releasing the claim
        // (otherwise the reminder would retry forever). Fails OPEN if the pref
        // service isn't wired.
        const emailEnabled = this.notificationEmail
          ? await this.notificationEmail.isEmailEnabled(
              r.user_id,
              r.organization_id,
              'file_explorer_reminder',
            )
          : true;

        if (emailEnabled) {
          const { data: user } = await this.db
            .from('users')
            .select('email, first_name, language')
            .eq('id', r.user_id)
            .maybeSingle();

          if (user?.email) {
            try {
              // Rendered through the branded notification template so reminder
              // emails carry the tenant's logo/colour, the recipient's locale,
              // and a personalized greeting instead of a bare title/body.
              await this.mail.sendNotification(
                user.email,
                {
                  title: `Reminder: ${node.name}`,
                  body:
                    r.message ?? `You have a reminder due for "${node.name}".`,
                  subject: `Reminder: ${node.name}`,
                  recipientName: user.first_name ?? undefined,
                },
                { organizationId: r.organization_id, locale: user.language },
              );
            } catch (e: any) {
              delivered = false;
              this.logger.error(
                `Failed to send reminder email for ${r.id}: ${e?.message}`,
              );
            }
          }
        }
      }

      // Release the claim on delivery failure so it is retried on a later tick.
      if (!delivered) {
        await this.db
          .from('fe_reminders')
          .update({ is_sent: false, sent_at: null })
          .eq('id', r.id);
      }
    }
  }
}
