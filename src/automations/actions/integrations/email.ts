import nodemailer from 'nodemailer';
import { z } from 'zod';

import type { ActionDefinition } from '../types';

export const emailSend: ActionDefinition = {
  kind: 'integration.email.send',
  category: 'integration',
  type: 'action',
  label: { en: 'Send email', de: 'E-Mail senden' },
  description: {
    en: 'Sends an email via SMTP (configured via SMTP_HOST / EMAIL_FROM / EMAIL_PASS env vars)',
    de: 'Sendet eine E-Mail über SMTP',
  },
  icon: 'bx-envelope',
  inputSchema: z.unknown(),
  configSchema: z
    .object({
      to: z
        .array(z.string().email())
        .min(1)
        .describe(
          'Recipient email addresses — type and press Enter to add each one',
        ),
      cc: z
        .array(z.string().email())
        .optional()
        .describe('CC recipients — optional'),
      bcc: z
        .array(z.string().email())
        .optional()
        .describe('BCC recipients — optional, hidden from other recipients'),
      subject: z
        .string()
        .min(1)
        .max(200)
        .describe(
          'Email subject line. Use {{ trigger.field }} or {{ customFields.myField }} for dynamic values',
        ),
      bodyText: z
        .string()
        .optional()
        .describe(
          'Plain-text body — supports {{ trigger.* }} template variables',
        ),
      bodyHtml: z
        .string()
        .optional()
        .describe('HTML body. Use {{ trigger.* }} for dynamic values'),
      fromName: z
        .string()
        .optional()
        .describe(
          'Display name shown as the sender — e.g. "My App Notifications"',
        ),
    })
    .refine(
      (v) => v.bodyText || v.bodyHtml,
      'Either bodyText or bodyHtml is required',
    ),
  outputSchema: z.object({ ok: z.boolean(), messageId: z.string() }),
  handler: async (config) => {
    const conf = config as {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      bodyText?: string;
      bodyHtml?: string;
      fromName?: string;
    };

    const host = process.env.SMTP_HOST;
    const user = process.env.EMAIL_FROM;
    const pass = process.env.EMAIL_PASS;

    if (!host || !user || !pass) {
      throw new Error(
        'SMTP_HOST, EMAIL_FROM and EMAIL_PASS environment variables are required to send email',
      );
    }

    const port = parseInt(process.env.SMTP_PORT ?? '587', 10);
    const secure = port === 465;

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    const from = conf.fromName ? `${conf.fromName} <${user}>` : user;

    const info = await transporter.sendMail({
      from,
      to: conf.to,
      cc: conf.cc,
      bcc: conf.bcc,
      subject: conf.subject,
      text: conf.bodyText,
      html: conf.bodyHtml,
    });

    return { ok: true, messageId: info.messageId };
  },
};
