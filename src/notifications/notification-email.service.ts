/**
 * @fileoverview Best-effort service that sends a branded email alongside an
 * in-app notification. Called fire-and-forget by the human-facing notification
 * creators right after they broadcast. It resolves each recipient's email/name/
 * locale, honours the per-type email preference, builds a CTA deep link, and
 * renders through the shared branded notification template via {@link MailService}.
 *
 * Contract: it MUST NEVER throw. A missing recipient email, a disabled
 * preference, an invalid address, an SMTP failure, or a render error must never
 * break the task/comment/upload/letter operation that triggered the notification.
 * @module src/notifications/notification-email.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MailService } from '../mail/mail.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  GIT_NOTIFICATION_DEFAULTS,
  type GitNotificationType,
  gitNotificationText,
  isGitNotificationType,
} from './git-notifications';
import { buildNotificationPath, tenantBaseUrl } from './notification-link.util';

/** Minimal shape the email path reads from an inserted notification row. */
interface NotificationLike {
  organization_id?: string | null;
  user_id?: string | null;
  type?: string | null;
  title?: string | null;
  body?: string | null;
  reference_type?: string | null;
  reference_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Maps an actual notification `type` to the preference key that gates its email.
 * The set of keys here IS the allowlist of emailable types — any type not listed
 * (e.g. `workflowTransition`, `file_explorer_reminder`, `space_invitation`, or an
 * automation's arbitrary type) is skipped, which also protects the paths that
 * already send their own email from being double-sent.
 *
 * `chat_mention`, `chat_dm` and `chat_summary` must stay OUT: this path emails at
 * once and with the notification body, while chat sends one delayed email without
 * any message text (ChatNotificationsService).
 */
const PREFERENCE_KEY_BY_TYPE: Record<string, string> = {
  task_mention: 'task_mention',
  comment_mention: 'comment_mention',
  attachment_checkout_message: 'attachment_checkout_message',
  management_letter_assigned: 'management_letter',
  management_letter_rejected: 'management_letter',
  wiki_review_requested: 'wiki_review',
  wiki_review_decided: 'wiki_review',
  // On-premise only: the daily "a new release is available" notice to organization owners.
  // Listing it here is what makes the email actually send — an unlisted type is silently
  // skipped, which would leave the in-app bell as the only signal.
  system_update_available: 'system_update',
  watcher_updates: 'watcher_updates',
  // Git integration ticket 9: development events (type = preference key).
  git_pr_merged: 'git_pr_merged',
  git_build_failed: 'git_build_failed',
  git_build_fixed: 'git_build_fixed',
  git_pr_linked: 'git_pr_linked',
  // Test Management custom image approval: asked and decided share one switch.
  custom_image_approval_requested: 'custom_image_approval',
  custom_image_approval_decided: 'custom_image_approval',
};

/** Returns the value only if it is a non-empty string. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

@Injectable()
export class NotificationEmailService {
  private readonly logger = new Logger(NotificationEmailService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Sends a branded notification email for each inserted row, best-effort.
   * Batches the recipient + preference lookups; sends one email per row. NEVER
   * throws — every failure is logged and swallowed so the triggering request is
   * unaffected.
   *
   * @param rows - the notification rows returned from the creator's `.insert().select()`
   */
  async emailForNotifications(
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {
    try {
      const candidates = (rows ?? [])
        .filter((r): r is Record<string, unknown> => !!r)
        .map((r) => r as NotificationLike)
        .filter((n) => n.user_id && this.isEmailableType(n.type));

      if (candidates.length === 0) return;

      const userIds = [...new Set(candidates.map((n) => n.user_id as string))];
      const orgIds = [
        ...new Set(
          candidates
            .map((n) => n.organization_id)
            .filter((id): id is string => !!id),
        ),
      ];

      const [{ data: userRows }, { data: prefRows }, { data: orgRows }] =
        await Promise.all([
          this.client
            .from('users')
            .select('id, email, first_name, language')
            .in('id', userIds),
          this.client
            .from('notification_preferences')
            .select('user_id, organization_id, notification_type, email')
            .in('user_id', userIds)
            .in('organization_id', orgIds.length > 0 ? orgIds : ['']),
          this.client
            .from('organizations')
            .select('id, slug')
            .in('id', orgIds.length > 0 ? orgIds : ['']),
        ]);

      // Links go to the org's own host; `app.` drops the deep path (XE-T728).
      const slugByOrg = new Map(
        ((orgRows ?? []) as Array<{ id: string; slug: string | null }>).map(
          (o) => [o.id, o.slug],
        ),
      );

      const userById = new Map<
        string,
        {
          email: string | null;
          firstName: string | null;
          locale: string | null;
        }
      >();
      for (const u of (userRows ?? []) as Array<{
        id: string;
        email: string | null;
        first_name: string | null;
        language: string | null;
      }>) {
        userById.set(u.id, {
          email: u.email,
          firstName: u.first_name,
          locale: u.language,
        });
      }

      // Email preference keyed on `${userId}:${orgId}:${prefType}` (org-scoped).
      const emailPrefByKey = new Map<string, boolean>();
      for (const p of (prefRows ?? []) as Array<{
        user_id: string;
        organization_id: string;
        notification_type: string;
        email: boolean;
      }>) {
        emailPrefByKey.set(
          `${p.user_id}:${p.organization_id}:${p.notification_type}`,
          p.email,
        );
      }

      const appUrl = (
        this.configService.get<string>('appUrl') || 'http://localhost:3000'
      ).replace(/\/+$/, '');

      for (const n of candidates) {
        // One bad recipient must not abort the rest of the batch.
        try {
          const user = userById.get(n.user_id as string);
          if (!user?.email) continue;

          const prefKey = this.preferenceKey(n.type as string);
          const emailEnabled =
            emailPrefByKey.get(
              `${n.user_id as string}:${n.organization_id as string}:${prefKey}`,
            ) ?? this.emailDefault(prefKey);
          if (!emailEnabled) continue;

          const relativePath = buildNotificationPath(
            n.reference_type,
            n.reference_id,
            n.metadata,
          );
          const ctaUrl = relativePath
            ? `${tenantBaseUrl(appUrl, slugByOrg.get(n.organization_id as string))}${relativePath}`
            : undefined;
          // Git notifications are written in the recipient's language; the stored text is the English fallback.
          const git = isGitNotificationType(n.type)
            ? this.gitText(n.type, n.metadata, user.locale)
            : null;
          const title = git?.title ?? str(n.title) ?? 'Notification';

          await this.mailService.sendNotification(
            user.email,
            {
              title,
              body: git?.body ?? str(n.body),
              subject: title,
              recipientName: user.firstName ?? undefined,
              ctaUrl,
              ...(git?.linkUrl
                ? { secondaryUrl: git.linkUrl, secondaryLabel: git.linkLabel }
                : {}),
            },
            { organizationId: n.organization_id ?? null, locale: user.locale },
          );
        } catch (err) {
          this.logger.error(
            `Failed to email notification to user ${String(n.user_id)}: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      // Absolute backstop — this method must never surface to the caller.
      this.logger.error(
        `emailForNotifications failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Whether a user has the EMAIL channel enabled for a notification type in an
   * org. Used by the paths that send their own (non-generic) email — space
   * invitations and file-explorer reminders — so they honour the same per-type
   * Email toggle shown in the preferences UI.
   *
   * Defaults to `true` (send) when no preference row exists, and fails OPEN
   * (returns `true`) on any lookup error, so a transient DB issue can never
   * silently suppress an important email.
   */
  async isEmailEnabled(
    userId: string,
    organizationId: string,
    notificationType: string,
  ): Promise<boolean> {
    try {
      const { data } = await this.client
        .from('notification_preferences')
        .select('email')
        .eq('user_id', userId)
        .eq('organization_id', organizationId)
        .eq('notification_type', this.preferenceKey(notificationType))
        .maybeSingle();

      return (
        (data as { email?: boolean } | null)?.email ??
        this.emailDefault(this.preferenceKey(notificationType))
      );
    } catch (err) {
      this.logger.error(
        `isEmailEnabled lookup failed for user ${userId}: ${(err as Error).message}`,
      );

      return true;
    }
  }

  /** Ticket 9: a git notification's title, body and provider link in `locale` (English fallback). */
  gitText(
    type: GitNotificationType,
    metadata: Record<string, unknown> | null | undefined,
    locale: string | null | undefined,
  ): ReturnType<typeof gitNotificationText> {
    return gitNotificationText(
      (key, vars) => this.mailService.translate(locale, key, vars),
      type,
      metadata,
    );
  }

  /** Email when no preference row exists: on, except for the git types that default it off. */
  private emailDefault(prefKey: string): boolean {
    return isGitNotificationType(prefKey)
      ? GIT_NOTIFICATION_DEFAULTS[prefKey].email
      : true;
  }

  private isEmailableType(type: unknown): boolean {
    return typeof type === 'string' && type in PREFERENCE_KEY_BY_TYPE;
  }

  private preferenceKey(type: string): string {
    return PREFERENCE_KEY_BY_TYPE[type] ?? type;
  }
}
