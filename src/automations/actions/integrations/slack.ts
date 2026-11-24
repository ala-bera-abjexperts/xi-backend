import { z } from 'zod';

import type {
  ActionDefinition,
  ExecutionContext,
  SubmissionMediaItem,
} from '../types';
import { integrationFetch } from './http-utils';

/**
 * Uploads one image to Slack with the external-upload flow (getUploadURLExternal -> PUT bytes ->
 * completeUploadExternal), which is what replaced the retired files.upload endpoint.
 *
 * Requires the `files:write` scope on the Slack app; without it step 1 returns a Slack error and the
 * caller logs it and moves on.
 */
async function uploadFileToSlack(args: {
  token: string;
  channelId: string;
  threadTs?: string;
  media: SubmissionMediaItem;
}): Promise<void> {
  const { token, channelId, threadTs, media } = args;

  const params = new URLSearchParams({
    filename: media.filename,
    length: String(media.bytes.length),
  });

  const reserve = (await integrationFetch(
    `https://slack.com/api/files.getUploadURLExternal?${params.toString()}`,
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
  ).then((r) => r.json())) as {
    ok: boolean;
    upload_url?: string;
    file_id?: string;
    error?: string;
  };

  if (!reserve.ok || !reserve.upload_url || !reserve.file_id)
    throw new Error(
      `files.getUploadURLExternal failed: ${reserve.error ?? 'unknown'}` +
        (reserve.error === 'missing_scope'
          ? ' — add the files:write scope to the Slack app'
          : ''),
    );

  // Slack's upload URL takes the raw bytes, no auth header.
  const put = await integrationFetch(reserve.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': media.mimeType },
    // Uint8Array rather than Buffer — Buffer is not a BodyInit under this lib config.
    body: new Uint8Array(media.bytes),
  });

  if (!put.ok) throw new Error(`file byte upload failed: HTTP ${put.status}`);

  const completeBody: Record<string, unknown> = {
    files: [{ id: reserve.file_id, title: media.filename }],
    channel_id: channelId,
  };

  if (threadTs) completeBody.thread_ts = threadTs;

  const complete = (await integrationFetch(
    'https://slack.com/api/files.completeUploadExternal',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(completeBody),
    },
  ).then((r) => r.json())) as { ok: boolean; error?: string };

  if (!complete.ok)
    throw new Error(
      `files.completeUploadExternal failed: ${complete.error ?? 'unknown'}`,
    );
}

export const slackSendMessage: ActionDefinition = {
  kind: 'integration.slack.send_message',
  category: 'integration',
  type: 'action',
  label: { en: 'Send Slack message', de: 'Slack-Nachricht senden' },
  description: {
    en: 'Posts a message to a Slack channel via your connected workspace',
    de: 'Sendet eine Nachricht an einen Slack-Kanal über Ihren verbundenen Arbeitsbereich',
  },
  icon: 'bx-hash',
  requiresConnection: 'slack',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    recipientType: z
      .enum(['public_channel', 'private_channel', 'user'])
      .default('public_channel'),
    channelId: z.string().optional(),
    userId: z.string().optional(),
    text: z.string().min(1).max(4000),
    threadTs: z.string().optional(),
    replyBroadcast: z.boolean().optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    ts: z.string().optional(),
    channel: z.string(),
    recipientUserId: z.string().optional(),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      recipientType?: 'public_channel' | 'private_channel' | 'user';
      channelId?: string;
      userId?: string;
      text: string;
      threadTs?: string;
      replyBroadcast?: boolean;
    };

    const conn = await ctx.resolveConnection('slack', conf.connectionId);
    if (!conn.decryptedSecret?.trim())
      throw new Error(
        'Slack connection token is empty — revoke and re-save the connection',
      );
    const token = conn.decryptedSecret;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const isDm = conf.recipientType === 'user';
    let resolvedChannelId: string;

    if (isDm) {
      if (!conf.userId?.trim())
        throw new Error(
          'Slack DM requires a recipient user — set the Recipient field.',
        );

      const openRes = await integrationFetch(
        'https://slack.com/api/conversations.open',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ users: conf.userId }),
        },
      ).then(
        (r) =>
          r.json() as Promise<{
            ok: boolean;
            channel?: { id: string };
            error?: string;
          }>,
      );

      if (!openRes.ok) {
        throw new Error(
          `Failed to open DM with user ${conf.userId}: ${openRes.error ?? 'unknown'}. ` +
            `Ensure the Slack app has the im:write scope.`,
        );
      }

      resolvedChannelId = openRes.channel!.id;
    } else {
      if (!conf.channelId?.trim())
        throw new Error(
          'Slack message requires a channel — set the Channel field.',
        );
      resolvedChannelId = conf.channelId;
    }

    const msgBody: Record<string, unknown> = {
      channel: resolvedChannelId,
      text: conf.text,
    };
    if (conf.threadTs) msgBody.thread_ts = conf.threadTs;
    if (conf.replyBroadcast && conf.threadTs) msgBody.reply_broadcast = true;

    const post = () =>
      integrationFetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers,
        body: JSON.stringify(msgBody),
      }).then(
        (r) =>
          r.json() as Promise<{
            ok: boolean;
            error?: string;
            ts?: string;
            channel?: string;
          }>,
      );

    let data = await post();

    // Bot not in channel — try auto-joining (channel messages only)
    if (!isDm && !data.ok && data.error === 'not_in_channel') {
      const join = await integrationFetch(
        'https://slack.com/api/conversations.join',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ channel: resolvedChannelId }),
        },
      ).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>);

      if (join.ok) {
        data = await post();
      } else {
        throw new Error(
          `Slack bot is not in channel ${resolvedChannelId} and could not auto-join (${join.error ?? 'unknown'}). ` +
            `Invite the bot with /invite @BotName or add chat:write.public + channels:join scopes.`,
        );
      }
    }

    if (!data.ok)
      throw new Error(`Slack API error: ${data.error ?? 'unknown'}`);

    // Photo/signature answers ride along as real Slack files, threaded under the message, so the
    // picture is visible rather than a link. Bytes are uploaded directly, which is also why this
    // works against a local stack — Slack never has to reach our storage host.
    //
    // Best-effort: a failed upload (missing files:write scope, oversized image) must not fail a
    // message that already posted successfully.
    for (const media of ctx.submissionMedia ?? []) {
      try {
        await uploadFileToSlack({
          token,
          channelId: resolvedChannelId,
          threadTs: data.ts,
          media,
        });
      } catch (err: unknown) {
        ctx.logger.error(
          `Slack file upload failed for ${media.filename}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return {
      ok: true,
      ts: data.ts,
      channel: data.channel ?? resolvedChannelId,
      recipientUserId: isDm ? conf.userId : undefined,
    };
  },
};
