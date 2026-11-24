/**
 * @fileoverview Fire-and-forget Supabase Realtime broadcast service.
 * Sends a broadcast to the user's personal channel when a notification is inserted.
 * Uses the service role key so no browser JWT is needed on the receiver side.
 * @module src/notifications/notifications-broadcast.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class NotificationsBroadcastService {
  private readonly logger = new Logger(NotificationsBroadcastService.name);
  private readonly supabaseUrl: string;
  private readonly serviceRoleKey: string;

  constructor(private readonly configService: ConfigService) {
    this.supabaseUrl = this.configService
      .get<string>('SUPABASE_URL', '')
      .replace(/\/$/, '');
    this.serviceRoleKey = this.configService.get<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
      '',
    );
  }

  /**
   * Broadcasts a notification to the recipient's personal Realtime channel.
   *
   * The frontend subscribes to `user-notifications:<userId>` as a public
   * broadcast channel — no Supabase browser session is required to receive it.
   * This bypasses the RLS issues that prevent `postgres_changes` from working
   * when the app uses a custom HttpOnly auth cookie instead of sb-* session cookies.
   *
   * @param notification - Full notification row (must contain `user_id`)
   */
  async broadcastNotification(
    notification: Record<string, unknown>,
  ): Promise<void> {
    const userId = notification['user_id'] as string | undefined;

    if (!userId || !this.supabaseUrl || !this.serviceRoleKey) return;

    try {
      const res = await fetch(`${this.supabaseUrl}/realtime/v1/api/broadcast`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.serviceRoleKey}`,
          apikey: this.serviceRoleKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              topic: `user-notifications:${userId}`,
              event: 'new_notification',
              payload: { notification },
            },
          ],
        }),
      });

      if (!res.ok) {
        this.logger.warn(`[Broadcast] HTTP ${res.status} for user ${userId}`);
      }
    } catch (err) {
      this.logger.error(`[Broadcast] Failed for user ${userId}:`, err);
    }
  }
}
