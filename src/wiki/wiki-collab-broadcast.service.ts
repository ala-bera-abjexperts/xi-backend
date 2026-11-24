/**
 * @fileoverview Fire-and-forget Supabase Realtime broadcast helper for wiki
 * collaboration control events (`wiki-collab:<pageId>` topics).
 *
 * Mirrors the mechanics of `notifications-broadcast.service.ts` (service-role
 * REST broadcast) but is implemented locally in the wiki module to avoid
 * cross-module edits, and marks each message `private: true` because the
 * `wiki-collab:*` channels are authorized per-user via the `wiki_topics` JWT
 * claim (realtime.messages RLS), not open broadcast channels.
 * @module src/wiki/wiki-collab-broadcast.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WikiCollabBroadcastService {
  private readonly logger = new Logger(WikiCollabBroadcastService.name);
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
   * Broadcasts a control event on the page's private collab channel.
   * Best-effort: failures are logged and swallowed (never blocks the caller).
   *
   * @param pageId - Wiki page UUID (topic becomes `wiki-collab:<pageId>`).
   * @param event - Event name (e.g. `permissions_changed`, `session_ended`).
   * @param payload - JSON-serializable payload.
   */
  async broadcastControl(
    pageId: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!pageId || !this.supabaseUrl || !this.serviceRoleKey) return;

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
              topic: `wiki-collab:${pageId}`,
              event,
              payload,
              private: true,
            },
          ],
        }),
      });

      if (!res.ok) {
        this.logger.warn(
          `[Broadcast] HTTP ${res.status} for wiki-collab:${pageId} (${event})`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[Broadcast] Failed for wiki-collab:${pageId} (${event}):`,
        err,
      );
    }
  }
}
