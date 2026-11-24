import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';
import { integrationFetch } from './http-utils';

export const linearCreateIssue: ActionDefinition = {
  kind: 'integration.linear.create_issue',
  category: 'integration',
  type: 'action',
  label: { en: 'Create Linear issue', de: 'Linear-Issue erstellen' },
  description: {
    en: 'Creates a new issue in a Linear team',
    de: 'Erstellt ein neues Issue in einem Linear-Team',
  },
  icon: 'bx-git-pull-request',
  requiresConnection: 'linear',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    teamId: z.string().min(1),
    title: z.string().min(1).max(500),
    description: z.string().max(5000).optional(),
    priority: z.enum(['0', '1', '2', '3', '4']).default('0'),
  }),
  outputSchema: z.object({
    id: z.string(),
    identifier: z.string(),
    url: z.string(),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      teamId: string;
      title: string;
      description?: string;
      priority?: string;
    };

    const conn = await ctx.resolveConnection(
      'linear' as never,
      conf.connectionId,
    );
    if (!conn.decryptedSecret?.trim())
      throw new Error(
        'Linear connection API key is empty — revoke and re-save the connection',
      );

    const mutation = `
      mutation CreateIssue($teamId: String!, $title: String!, $description: String, $priority: Int) {
        issueCreate(input: { teamId: $teamId, title: $title, description: $description, priority: $priority }) {
          success
          issue { id identifier url }
        }
      }
    `;

    const res = await integrationFetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        Authorization: conn.decryptedSecret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          teamId: conf.teamId,
          title: conf.title,
          description: conf.description ?? undefined,
          priority: conf.priority ? parseInt(conf.priority, 10) : 0,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Linear API error (${res.status}): ${res.statusText}`);
    }

    const json = (await res.json()) as {
      data?: {
        issueCreate?: {
          success: boolean;
          issue?: { id: string; identifier: string; url: string };
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (json.errors?.length) {
      throw new Error(
        `Linear API error: ${json.errors[0]?.message ?? 'unknown'}`,
      );
    }

    const issue = json.data?.issueCreate?.issue;
    if (!issue)
      throw new Error('Linear issue creation failed — no issue returned');

    return { id: issue.id, identifier: issue.identifier, url: issue.url };
  },
};
