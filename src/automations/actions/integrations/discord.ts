import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';
import { integrationFetch } from './http-utils';

export const discordPostWebhook: ActionDefinition = {
  kind: 'integration.discord.post_webhook',
  category: 'integration',
  type: 'action',
  label: { en: 'Post Discord message', de: 'Discord-Nachricht senden' },
  description: {
    en: 'Posts a message to a Discord channel via a webhook URL',
    de: 'Sendet eine Nachricht an einen Discord-Kanal über eine Webhook-URL',
  },
  icon: 'bx-message-square-dots',
  requiresConnection: 'discord',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    content: z.string().min(1).max(2000),
    username: z.string().max(80).optional(),
    avatarUrl: z.string().url().optional(),
    embeds: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    messageId: z.string().optional(),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      content: string;
      username?: string;
      avatarUrl?: string;
      embeds?: Record<string, unknown>[];
    };

    const conn = await ctx.resolveConnection('discord', conf.connectionId);
    const webhookUrl = conn.decryptedSecret;

    if (
      !webhookUrl.startsWith('https://discord.com/api/webhooks/') &&
      !webhookUrl.startsWith('https://discordapp.com/api/webhooks/')
    ) {
      throw new Error(
        'Invalid Discord webhook URL — must start with https://discord.com/api/webhooks/',
      );
    }

    const body: Record<string, unknown> = { content: conf.content };

    if (conf.username) body.username = conf.username;
    if (conf.avatarUrl) body.avatar_url = conf.avatarUrl;
    if (conf.embeds?.length) body.embeds = conf.embeds;

    const res = await integrationFetch(`${webhookUrl}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as {
        message?: string;
        code?: number;
      };

      throw new Error(
        `Discord webhook error (${res.status}): ${err.message ?? res.statusText}`,
      );
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };

    return { ok: true, messageId: data.id };
  },
};
