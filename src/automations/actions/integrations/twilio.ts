import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';

export const twilioSendSms: ActionDefinition = {
  kind: 'integration.twilio.send_sms',
  category: 'integration',
  type: 'action',
  label: { en: 'Send SMS via Twilio', de: 'SMS über Twilio senden' },
  description: {
    en: 'Sends an SMS message via the Twilio API',
    de: 'Sendet eine SMS-Nachricht über die Twilio-API',
  },
  icon: 'bx-mobile',
  requiresConnection: 'twilio',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    to: z.string().min(1),
    from: z.string().min(1),
    body: z.string().max(1600),
  }),
  outputSchema: z.object({ sid: z.string(), status: z.string() }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      to: string;
      from: string;
      body: string;
    };

    const conn = await ctx.resolveConnection('twilio', conf.connectionId);
    const accountSid =
      (conn.metadata as Record<string, string>)?.account_sid ?? '';

    if (!accountSid) {
      throw new Error('Twilio connection is missing account_sid metadata');
    }

    const authToken = conn.decryptedSecret;
    const params = new URLSearchParams({
      To: conf.to,
      From: conf.from,
      Body: conf.body,
    });

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!res.ok) {
      const err = (await res.json()) as { message?: string };

      throw new Error(`Twilio API error: ${err.message ?? res.statusText}`);
    }

    const data = (await res.json()) as { sid: string; status: string };

    return { sid: data.sid, status: data.status };
  },
};
