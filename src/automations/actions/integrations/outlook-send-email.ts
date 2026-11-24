import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';
import { integrationFetch } from './http-utils';

const toRecipients = (csv: string) =>
  csv
    .split(',')
    .map((e) => ({ emailAddress: { address: e.trim() } }))
    .filter((r) => r.emailAddress.address.length > 0);

export const outlookSendEmail: ActionDefinition = {
  kind: 'integration.outlook.send_email',
  category: 'integration',
  type: 'action',
  label: { en: 'Send Outlook email', de: 'Outlook-E-Mail senden' },
  description: {
    en: 'Sends an email via Microsoft Outlook / Office 365',
    de: 'Sendet eine E-Mail über Microsoft Outlook / Office 365',
  },
  icon: 'bx-envelope',
  requiresConnection: 'outlook',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    to: z
      .string()
      .min(1)
      .describe('Recipient email address(es), comma-separated'),
    subject: z.string().min(1).max(998),
    body: z.string().min(1),
    cc: z.string().optional(),
    isHtml: z.boolean().default(true),
  }),
  outputSchema: z.object({ ok: z.boolean() }),

  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      to: string;
      subject: string;
      body: string;
      cc?: string;
      isHtml: boolean;
    };

    const conn = await ctx.resolveConnection(
      'outlook' as never,
      conf.connectionId,
    );

    if (!conn.decryptedSecret?.trim()) {
      throw new Error(
        'Outlook connection token is empty — re-authorize the connection',
      );
    }

    const payload = {
      message: {
        subject: conf.subject,
        body: {
          contentType: conf.isHtml ? 'html' : 'text',
          content: conf.body,
        },
        toRecipients: toRecipients(conf.to),
        ccRecipients: conf.cc ? toRecipients(conf.cc) : [],
      },
      saveToSentItems: true,
    };

    const res = await integrationFetch(
      'https://graph.microsoft.com/v1.0/me/sendMail',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${conn.decryptedSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );

    if (!res.ok) {
      const wwwAuth = res.headers.get('WWW-Authenticate') ?? '';
      const errBody = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      let msg: string;

      if (typeof errBody.error === 'object' && errBody.error !== null) {
        const e = errBody.error as { code?: string; message?: string };
        msg = [e.code, e.message].filter(Boolean).join(': ') || res.statusText;
      } else if (typeof errBody.error === 'string') {
        msg = errBody.error;
      } else if (typeof errBody.message === 'string') {
        msg = errBody.message;
      } else {
        msg = res.statusText;
      }

      const detail = wwwAuth ? ` [${wwwAuth.slice(0, 300)}]` : '';

      if (res.status === 401) {
        throw new Error(
          `Outlook 401 Unauthorized: ${msg}${detail}. ` +
            'The connected account must have an Exchange/Outlook mailbox ' +
            '(@outlook.com, @hotmail.com, @live.com, or Microsoft 365). ' +
            'Gmail-linked Microsoft accounts cannot send email via Graph API — reconnect with a valid Outlook account.',
        );
      }

      throw new Error(
        `Outlook Graph API error (${res.status}): ${msg}${detail}`,
      );
    }

    // sendMail returns HTTP 202 Accepted with no response body
    return { ok: true };
  },
};
