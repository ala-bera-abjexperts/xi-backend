import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';
import { integrationFetch } from './http-utils';

export const notionCreatePage: ActionDefinition = {
  kind: 'integration.notion.create_page',
  category: 'integration',
  type: 'action',
  label: { en: 'Create Notion page', de: 'Notion-Seite erstellen' },
  description: {
    en: 'Creates a new page in a Notion database',
    de: 'Erstellt eine neue Seite in einer Notion-Datenbank',
  },
  icon: 'bx-note',
  requiresConnection: 'notion',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    databaseId: z.string().min(1),
    properties: z.string().min(1),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    pageId: z.string(),
    pageUrl: z.string(),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      databaseId: string;
      properties: string;
    };

    const conn = await ctx.resolveConnection(
      'notion' as never,
      conf.connectionId,
    );
    if (!conn.decryptedSecret?.trim())
      throw new Error(
        'Notion connection token is empty — revoke and re-save the connection',
      );

    let parsedProperties: Record<string, unknown>;
    try {
      parsedProperties = JSON.parse(conf.properties) as Record<string, unknown>;
    } catch {
      throw new Error(
        'Page Properties is not valid JSON. Example: {"Name":{"title":[{"text":{"content":"My page"}}]}}',
      );
    }

    const res = await integrationFetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${conn.decryptedSecret}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        parent: { database_id: conf.databaseId },
        properties: parsedProperties,
      }),
    });

    if (!res.ok) {
      const data = (await res.json()) as { message?: string; code?: string };
      throw new Error(
        `Notion API error (${res.status}): ${data.message ?? res.statusText}`,
      );
    }

    const page = (await res.json()) as {
      id: string;
      url: string;
    };

    return {
      ok: true,
      pageId: page.id,
      pageUrl: page.url,
    };
  },
};
