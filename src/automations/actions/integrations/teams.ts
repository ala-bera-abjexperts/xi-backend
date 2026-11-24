import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';
import { integrationFetch } from './http-utils';

export const teamsSendMessage: ActionDefinition = {
  kind: 'integration.teams.send_message',
  category: 'integration',
  type: 'action',
  label: { en: 'Send Teams message', de: 'Teams-Nachricht senden' },
  description: {
    en: 'Posts a message to a Microsoft Teams channel',
    de: 'Sendet eine Nachricht an einen Microsoft Teams Kanal',
  },
  icon: 'bx-message-square',
  requiresConnection: 'teams',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z
      .string()
      .uuid()
      .optional()
      .describe('Leave blank to use your default connected account'),
    teamId: z.string().min(1).describe('The Microsoft Teams team'),
    channelId: z.string().min(1).describe('The channel to post to'),
    title: z
      .string()
      .max(200)
      .optional()
      .describe('Optional message subject / importance label'),
    message: z
      .string()
      .min(1)
      .max(28000)
      .describe(
        'Message text. Use {{ trigger.field }} for dynamic values. HTML supported',
      ),
  }),
  outputSchema: z.object({ ok: z.boolean(), messageId: z.string().optional() }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      teamId: string;
      channelId: string;
      title?: string;
      message: string;
    };

    const conn = await ctx.resolveConnection(
      'teams' as never,
      conf.connectionId,
    );
    if (!conn.decryptedSecret?.trim())
      throw new Error(
        'Microsoft Teams connection token is empty — revoke and re-save the connection',
      );

    const content = conf.title
      ? `<strong>${conf.title}</strong><br>${conf.message}`
      : conf.message;

    const res = await integrationFetch(
      `https://graph.microsoft.com/v1.0/teams/${conf.teamId}/channels/${conf.channelId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${conn.decryptedSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: { contentType: 'html', content } }),
      },
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      throw new Error(
        `Teams Graph API error (${res.status}): ${body.error?.message ?? res.statusText}`,
      );
    }

    const data = (await res.json()) as { id?: string };

    return { ok: true, messageId: data.id };
  },
};
