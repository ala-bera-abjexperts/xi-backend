import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';
import { integrationFetch } from './http-utils';

export const githubCreateIssue: ActionDefinition = {
  kind: 'integration.github.create_issue',
  category: 'integration',
  type: 'action',
  label: { en: 'Create GitHub issue', de: 'GitHub-Issue erstellen' },
  description: {
    en: 'Creates a new issue in a GitHub repository',
    de: 'Erstellt ein neues Issue in einem GitHub-Repository',
  },
  icon: 'bx-bxl-github',
  requiresConnection: 'github',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    owner: z.string().min(1),
    repo: z.string().min(1),
    title: z.string().min(1).max(256),
    body: z.string().max(65536).optional(),
    labels: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    number: z.number(),
    url: z.string(),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      owner: string;
      repo: string;
      title: string;
      body?: string;
      labels?: string[];
    };

    const conn = await ctx.resolveConnection('github', conf.connectionId);
    if (!conn.decryptedSecret?.trim())
      throw new Error(
        'GitHub connection token is empty — revoke and re-save the connection',
      );

    const SAFE_SLUG = /^[a-zA-Z0-9._-]{1,100}$/;
    if (!SAFE_SLUG.test(conf.owner))
      throw new Error(
        'Invalid GitHub owner — use only letters, numbers, hyphens, dots',
      );
    if (!SAFE_SLUG.test(conf.repo))
      throw new Error(
        'Invalid GitHub repo — use only letters, numbers, hyphens, dots',
      );
    if (!conf.title?.trim())
      throw new Error(
        'GitHub issue title is empty after template substitution. ' +
          'Check that the template variable (e.g. {{ trigger.body.title }}) exists in the webhook payload.',
      );

    const res = await integrationFetch(
      `https://api.github.com/repos/${conf.owner}/${conf.repo}/issues`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${conn.decryptedSecret}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: conf.title,
          body: conf.body ?? '',
          labels: conf.labels ?? [],
        }),
      },
      30_000,
    );

    if (!res.ok) {
      const err = (await res.json()) as {
        message?: string;
        errors?: Array<{ field?: string; value?: string; code?: string }>;
      };
      const detail = err.errors?.length
        ? ` — ${err.errors.map((e) => [e.field, e.value, e.code].filter(Boolean).join(' ')).join(', ')}`
        : '';
      throw new Error(
        `GitHub API error: ${err.message ?? res.statusText}${detail} (${res.status})`,
      );
    }

    const data = (await res.json()) as { number: number; html_url: string };
    return { number: data.number, url: data.html_url };
  },
};
