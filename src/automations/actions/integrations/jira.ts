import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';
import { integrationFetch } from './http-utils';

export const jiraCreateIssue: ActionDefinition = {
  kind: 'integration.jira.create_issue',
  category: 'integration',
  type: 'action',
  label: { en: 'Create Jira issue', de: 'Jira-Issue erstellen' },
  description: {
    en: 'Creates a new issue in a Jira Cloud project',
    de: 'Erstellt ein neues Issue in einem Jira Cloud-Projekt',
  },
  icon: 'bx-bug',
  requiresConnection: 'jira',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    projectKey: z.string().min(1),
    summary: z.string().min(1).max(255),
    description: z.string().max(32768).optional(),
    issueType: z.string().default('Task'),
  }),
  outputSchema: z.object({
    id: z.string(),
    key: z.string(),
    url: z.string(),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      projectKey: string;
      summary: string;
      description?: string;
      issueType?: string;
    };

    const conn = await ctx.resolveConnection('jira', conf.connectionId);
    if (!conn.decryptedSecret?.trim())
      throw new Error(
        'Jira connection API token is empty — revoke and re-save the connection',
      );
    const meta = conn.metadata as Record<string, string>;
    const domain = (meta.domain ?? meta.base_url ?? '')
      .replace(/^https?:\/\//i, '')
      .replace(/\/$/, '');
    const baseUrl = `https://${domain}`;

    const body: Record<string, unknown> = {
      fields: {
        project: { key: conf.projectKey },
        summary: conf.summary,
        issuetype: { name: conf.issueType ?? 'Task' },
      },
    };

    if (conf.description) {
      (body.fields as Record<string, unknown>).description = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: conf.description }],
          },
        ],
      };
    }

    const credentials = Buffer.from(
      `${meta.email}:${conn.decryptedSecret}`,
    ).toString('base64');

    const res = await integrationFetch(`${baseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = (await res.json()) as {
        errorMessages?: string[];
        errors?: Record<string, string>;
      };
      const msg =
        err.errorMessages?.[0] ??
        Object.values(err.errors ?? {})[0] ??
        res.statusText;
      throw new Error(`Jira API error: ${msg} (${res.status})`);
    }

    const data = (await res.json()) as { id: string; key: string };
    return { id: data.id, key: data.key, url: `${baseUrl}/browse/${data.key}` };
  },
};
