import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';
import { integrationFetch } from './http-utils';

export const clickupCreateTask: ActionDefinition = {
  kind: 'integration.clickup.create_task',
  category: 'integration',
  type: 'action',
  label: { en: 'Create ClickUp Task', de: 'ClickUp-Aufgabe erstellen' },
  description: {
    en: 'Creates a task in a ClickUp list',
    de: 'Erstellt eine Aufgabe in einer ClickUp-Liste',
  },
  icon: 'bx-task',
  requiresConnection: 'clickup',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    listId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    priority: z.enum(['1', '2', '3', '4']).optional(),
    customFields: z.string().optional(),
  }),
  outputSchema: z.object({ id: z.string(), url: z.string() }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      listId: string;
      name: string;
      description?: string;
      priority?: string;
      customFields?: string;
    };

    const conn = await ctx.resolveConnection('clickup', conf.connectionId);
    if (!conn.decryptedSecret?.trim())
      throw new Error(
        'ClickUp connection secret is empty — revoke and re-save the connection',
      );

    const body: Record<string, unknown> = { name: conf.name };

    if (conf.description) body.description = conf.description;
    if (conf.priority) body.priority = parseInt(conf.priority, 10);

    // customFields is a JSON array of {id, value}. ClickUp requires each value in its field's
    // native JSON type — number/currency/rating want a real number (not "5" → "Value must be a
    // number"), and date wants a Unix epoch in ms (not an ISO string). The form builder stores
    // everything as a string, so coerce by the field's real ClickUp type. Types are only fetched
    // when at least one string value is present (i.e. a coercion could be needed).
    if (conf.customFields) {
      try {
        const entries = JSON.parse(conf.customFields) as Array<{
          id?: string;
          value?: unknown;
        }>;

        const valid = Array.isArray(entries)
          ? entries.filter((e) => !!e?.id)
          : [];

        if (valid.length > 0) {
          const NUMERIC = new Set([
            'number',
            'currency',
            'money',
            'rating',
            'emoji',
          ]);
          const needsTypes = valid.some(
            (e) => typeof e.value === 'string' && e.value.trim() !== '',
          );

          let typeById = new Map<string, string>();

          if (needsTypes) {
            try {
              const fieldsRes = await integrationFetch(
                `https://api.clickup.com/api/v2/list/${conf.listId}/field`,
                { headers: { Authorization: conn.decryptedSecret } },
              );
              const fieldsJson = (await fieldsRes.json()) as {
                fields?: Array<{ id: string; type: string }>;
              };

              typeById = new Map(
                (fieldsJson.fields ?? []).map((f) => [f.id, f.type]),
              );
            } catch {
              // Best-effort — if field types can't be loaded, fall back to passthrough.
            }
          }

          body.custom_fields = valid
            .map((e) => {
              const type = typeById.get(e.id as string);
              const isStr =
                typeof e.value === 'string' && e.value.trim() !== '';

              // Automatic progress is computed by ClickUp and rejects any write — drop it so it
              // can't 400 the whole task (the user's value is ignored, matching ClickUp's read-only
              // behavior).
              if (type === 'automatic_progress') return null;

              if (type && NUMERIC.has(type) && isStr) {
                const n = Number(e.value);

                return { id: e.id, value: Number.isFinite(n) ? n : e.value };
              }

              // Manual progress wants { current: <number> } (ClickUp: "value must be an object with
              // the current value of the progress").
              if (type === 'manual_progress' && isStr) {
                const n = Number(e.value);

                return Number.isFinite(n)
                  ? { id: e.id, value: { current: n } }
                  : null;
              }

              if (type === 'date' && isStr) {
                const ms = Date.parse(e.value as string);

                return { id: e.id, value: Number.isFinite(ms) ? ms : e.value };
              }

              return { id: e.id, value: e.value };
            })
            .filter((e): e is NonNullable<typeof e> => e !== null);
        }
      } catch {
        // Malformed JSON — skip silently rather than failing the whole task creation
        // over an optional field.
      }
    }

    const res = await integrationFetch(
      `https://api.clickup.com/api/v2/list/${conf.listId}/task`,
      {
        method: 'POST',
        headers: {
          Authorization: conn.decryptedSecret,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    const json = (await res.json()) as {
      id?: string;
      url?: string;
      err?: string;
    };

    if (!res.ok)
      throw new Error(
        `ClickUp API error (${res.status}): ${json.err ?? res.statusText}`,
      );

    return { id: json.id!, url: json.url! };
  },
};
