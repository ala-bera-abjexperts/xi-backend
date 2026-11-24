import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';
import { integrationFetch } from './http-utils';

export const asanaCreateTask: ActionDefinition = {
  kind: 'integration.asana.create_task',
  category: 'integration',
  type: 'action',
  label: { en: 'Create Asana Task', de: 'Asana-Aufgabe erstellen' },
  description: {
    en: 'Creates a task in an Asana project',
    de: 'Erstellt eine Aufgabe in einem Asana-Projekt',
  },
  icon: 'bx-task',
  requiresConnection: 'asana',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    workspaceId: z.string().min(1),
    projectId: z.string().optional(),
    name: z.string().min(1),
    notes: z.string().optional(),
    assignee: z.string().optional(),
    dueDate: z.string().optional(),
    customFields: z.string().optional(),
  }),
  outputSchema: z.object({
    gid: z.string(),
    permalink_url: z.string().optional(),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      workspaceId: string;
      projectId?: string;
      name: string;
      notes?: string;
      assignee?: string;
      dueDate?: string;
      customFields?: string;
    };

    const conn = await ctx.resolveConnection('asana', conf.connectionId);
    if (!conn.decryptedSecret?.trim())
      throw new Error(
        'Asana connection secret is empty — revoke and re-save the connection',
      );

    // Asana due_on requires YYYY-MM-DD; dueDate may be a full ISO datetime string
    const due_on = conf.dueDate ? conf.dueDate.slice(0, 10) : undefined;

    const body: Record<string, unknown> = {
      workspace: conf.workspaceId,
      name: conf.name,
    };

    if (conf.projectId) body.projects = [conf.projectId];
    if (conf.notes) body.notes = conf.notes;
    if (conf.assignee) body.assignee = conf.assignee;
    if (due_on) body.due_on = due_on;

    // customFields is stored as a JSON array of Asana's own custom_field_settings entry
    // shape ({gid,value} / {gid,multi_enum_values}); Asana's task-create API instead wants
    // an object keyed by field gid, so convert here. Values are stored as strings by the form
    // builder, but Asana requires each in its native type — number fields want a real number
    // (else "Value must be a number"-style rejection) and date fields want a YYYY-MM-DD string —
    // so coerce by the field's real resource_subtype, fetched only when a string value is present.
    if (conf.customFields) {
      try {
        const entries = JSON.parse(conf.customFields) as Array<{
          gid?: string;
          value?: string;
          multi_enum_values?: string[];
        }>;

        const valid = Array.isArray(entries)
          ? entries.filter((e) => !!e?.gid)
          : [];

        if (valid.length > 0) {
          const needsTypes = valid.some(
            (e) =>
              !Array.isArray(e.multi_enum_values) &&
              typeof e.value === 'string' &&
              e.value.trim() !== '',
          );

          let subtypeByGid = new Map<string, string>();

          if (needsTypes && conf.projectId) {
            try {
              const fRes = await integrationFetch(
                `https://app.asana.com/api/1.0/projects/${conf.projectId}/custom_field_settings?opt_fields=custom_field.gid,custom_field.resource_subtype`,
                {
                  headers: {
                    Authorization: `Bearer ${conn.decryptedSecret}`,
                    Accept: 'application/json',
                  },
                },
              );
              const fJson = (await fRes.json()) as {
                data?: Array<{
                  custom_field?: { gid: string; resource_subtype?: string };
                }>;
              };

              subtypeByGid = new Map(
                (fJson.data ?? [])
                  .map((s) => s.custom_field)
                  .filter((cf): cf is NonNullable<typeof cf> => !!cf)
                  .map((cf) => [cf.gid, cf.resource_subtype ?? 'text']),
              );
            } catch {
              // Best-effort — if types can't be loaded, fall back to passthrough strings.
            }
          }

          const customFieldsObj: Record<string, unknown> = {};

          for (const entry of valid) {
            const gid = entry.gid as string;

            if (Array.isArray(entry.multi_enum_values)) {
              customFieldsObj[gid] = entry.multi_enum_values;
              continue;
            }

            const raw = entry.value;
            const isStr = typeof raw === 'string' && raw.trim() !== '';
            const subtype = subtypeByGid.get(gid);

            if (subtype === 'number' && isStr) {
              const n = Number(raw);

              customFieldsObj[gid] = Number.isFinite(n) ? n : raw;
            } else if (subtype === 'date' && isStr) {
              const ms = Date.parse(raw);

              customFieldsObj[gid] = Number.isFinite(ms)
                ? new Date(ms).toISOString().slice(0, 10)
                : raw;
            } else {
              customFieldsObj[gid] = raw;
            }
          }

          if (Object.keys(customFieldsObj).length > 0) {
            body.custom_fields = customFieldsObj;
          }
        }
      } catch {
        // Malformed JSON — skip silently rather than failing the whole task creation
        // over an optional field.
      }
    }

    const res = await integrationFetch('https://app.asana.com/api/1.0/tasks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${conn.decryptedSecret}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ data: body }),
    });

    const json = (await res.json()) as {
      data?: { gid: string; permalink_url?: string };
      errors?: Array<{ message: string }>;
    };

    if (!res.ok)
      throw new Error(
        `Asana API error (${res.status}): ${json.errors?.[0]?.message ?? res.statusText}`,
      );

    return { gid: json.data!.gid, permalink_url: json.data!.permalink_url };
  },
};
