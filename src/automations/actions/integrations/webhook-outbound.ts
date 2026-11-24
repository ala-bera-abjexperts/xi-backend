import { promises as dns } from 'dns';

import { z } from 'zod';

import type { ActionDefinition } from '../types';

const PRIVATE_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fe80:/i,
];

async function isPublicHttps(
  url: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== 'https:') {
      return { ok: false, reason: 'Only HTTPS URLs are allowed' };
    }

    const hostname = parsed.hostname;
    let addresses: string[] = [];
    try {
      addresses = await dns.resolve4(hostname);
    } catch {
      addresses = [];
    }
    const ip = addresses[0];

    if (!ip) {
      return { ok: false, reason: `Cannot resolve hostname: ${hostname}` };
    }

    if (PRIVATE_RANGES.some((r) => r.test(ip))) {
      return {
        ok: false,
        reason: `Resolved IP ${ip} is in a private range (SSRF blocked)`,
      };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'URL validation failed',
    };
  }
}

export const webhookOutbound: ActionDefinition = {
  kind: 'integration.webhook.outbound',
  category: 'integration',
  type: 'action',
  label: { en: 'Call webhook URL', de: 'Webhook-URL aufrufen' },
  description: {
    en: 'Makes an HTTP request to an external public HTTPS URL',
    de: 'Führt eine HTTP-Anfrage an eine externe öffentliche HTTPS-URL durch',
  },
  icon: 'bx-link',
  inputSchema: z.unknown(),
  configSchema: z.object({
    url: z
      .string()
      .url()
      .describe('HTTPS URL to call — must be a public HTTPS endpoint'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
      .default('POST')
      .describe('HTTP method to use'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('Extra request headers as JSON — e.g. {"X-Api-Key":"abc123"}'),
    body: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional()
      .describe(
        'Request body — JSON object or raw string. Use {{ trigger.field }} for dynamic values',
      ),
    timeoutMs: z
      .number()
      .min(1000)
      .max(30000)
      .default(10000)
      .describe('Request timeout in milliseconds (1000–30000)'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    status: z.number(),
    body: z.unknown(),
  }),
  handler: async (config) => {
    const conf = config as {
      url: string;
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      headers?: Record<string, string>;
      body?: unknown;
      timeoutMs?: number;
    };

    const guard = await isPublicHttps(conf.url);

    if (!guard.ok) throw new Error(`URL rejected: ${guard.reason}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), conf.timeoutMs ?? 10000);

    try {
      const bodyContent =
        conf.body === undefined
          ? undefined
          : typeof conf.body === 'string'
            ? conf.body
            : JSON.stringify(conf.body);

      const res = await fetch(conf.url, {
        method: conf.method ?? 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'AutomationEngine/1.0',
          ...(conf.headers ?? {}),
        },
        body: bodyContent,
        signal: controller.signal,
      });

      const contentType = res.headers.get('content-type') ?? '';
      const body: unknown = contentType.includes('application/json')
        ? await (res.json() as Promise<unknown>).catch(() => null)
        : await res.text().catch(() => null);

      if (!res.ok) {
        throw new Error(
          `Webhook returned ${res.status}: ${JSON.stringify(body)?.slice(0, 200)}`,
        );
      }

      return { ok: true, status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  },
};
