import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';
import { integrationFetch } from './http-utils';

export const trelloCreateCard: ActionDefinition = {
  kind: 'integration.trello.create_card',
  category: 'integration',
  type: 'action',
  label: { en: 'Create Trello Card', de: 'Trello-Karte erstellen' },
  description: {
    en: 'Creates a card in a Trello list',
    de: 'Erstellt eine Karte in einer Trello-Liste',
  },
  icon: 'bx-credit-card',
  requiresConnection: 'trello',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    listId: z.string().min(1),
    name: z.string().min(1),
    desc: z.string().optional(),
    due: z.string().optional(),
  }),
  outputSchema: z.object({ id: z.string(), shortUrl: z.string() }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      listId: string;
      name: string;
      desc?: string;
      due?: string;
    };

    const conn = await ctx.resolveConnection('trello', conf.connectionId);
    const apiKey = (conn.metadata.api_key as string | undefined) ?? '';

    if (!apiKey)
      throw new Error(
        'Trello connection is missing API key — re-save the connection',
      );

    const url = new URL('https://api.trello.com/1/cards');

    url.searchParams.set('key', apiKey);
    url.searchParams.set('token', conn.decryptedSecret);

    const body: Record<string, unknown> = {
      idList: conf.listId,
      name: conf.name,
    };

    if (conf.desc) body.desc = conf.desc;
    if (conf.due) body.due = conf.due;

    const res = await integrationFetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json()) as { id?: string; shortUrl?: string };

    if (!res.ok)
      throw new Error(`Trello API error (${res.status}): ${res.statusText}`);

    return { id: json.id!, shortUrl: json.shortUrl! };
  },
};
