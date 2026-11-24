import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

const VALID_TYPES = [
  'space_invitation',
  'task_mention',
  'comment_mention',
  'attachment_checkout_message',
  'file_explorer_reminder',
  'management_letter',
  'wiki_review',
  // On-premise only. Harmless in the cloud: no notification of this type is ever created there,
  // so the preference simply never applies.
  'system_update',
  // camelCase, unlike its siblings, because it is the literal `notifications.type`
  // written by the workflow send_notification dispatcher — matching it exactly
  // avoids a type-to-key translation layer for a 1:1 mapping.
  'workflowTransition',
  'watcher_updates',
  'calendar_reminder',
  // Chat (XE-T353). chat_mention also gates thread replies. Their email is the
  // delayed, content-free one of the chat sweep, never the immediate one.
  'chat_mention',
  'chat_dm',
  // Git integration ticket 9 (src/notifications/git-notifications.ts).
  'git_pr_merged',
  'git_build_failed',
  'git_build_fixed',
  'git_pr_linked',
  // Test Management: a custom Docker image waits for approval, or was decided.
  'custom_image_approval',
] as const;

export type NotificationPreferenceType = (typeof VALID_TYPES)[number];

/**
 * Upserts one channel toggle (or both) for a notification type. Each channel is
 * optional so the client can flip just `in_app` or just `email` without having
 * to resend the other — the service preserves any channel omitted here.
 */
export class UpsertNotificationPreferenceDto {
  @ApiProperty({ enum: VALID_TYPES })
  @IsString()
  @IsIn(VALID_TYPES)
  notification_type: NotificationPreferenceType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  in_app?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  email?: boolean;
}

export interface NotificationPreferenceRow {
  notification_type: string;
  in_app: boolean;
  email: boolean;
}

/** Per-type channel toggles returned to the frontend. */
export interface NotificationChannelPrefs {
  inApp: boolean;
  email: boolean;
}

/** Merged preferences map returned to the frontend */
export type NotificationPreferencesMap = Record<
  string,
  NotificationChannelPrefs
>;
