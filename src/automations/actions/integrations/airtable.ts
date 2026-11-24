import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';
import { integrationFetch } from './http-utils';

const AIRTABLE_BASE = 'https://api.airtable.com';

type FieldMapping = { field: string; value: string };

function buildFields(mappings: FieldMapping[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  for (const m of mappings) {
    if (m.field) fields[m.field] = m.value;
  }

  return fields;
}

export const airtableAction: ActionDefinition = {
  kind: 'integration.airtable.create_record',
  category: 'integration',
  type: 'action',
  label: { en: 'Airtable record action', de: 'Airtable-Datensatz-Aktion' },
  description: {
    en: 'Create, update, get, list, delete or upsert Airtable records',
    de: 'Airtable-Datensätze erstellen, aktualisieren, abrufen, auflisten, löschen oder upserten',
  },
  icon: 'bx-grid-alt',
  requiresConnection: 'airtable',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    actionType: z
      .enum([
        'create_record',
        'update_record',
        'get_record',
        'list_records',
        'delete_record',
        'upsert_record',
      ])
      .default('create_record'),
    baseId: z.string().min(1),
    tableIdOrName: z.string().min(1),
    fieldMappings: z
      .array(z.object({ field: z.string(), value: z.string() }))
      .optional(),
    recordId: z.string().optional(),
    fieldsToMergeOn: z.array(z.string()).optional(),
    filterByFormula: z.string().optional(),
    maxRecords: z.number().int().min(1).max(100).default(10),
    view: z.string().optional(),
    typecast: z.boolean().optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    recordId: z.string().optional(),
    records: z.array(z.record(z.string(), z.unknown())).optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    deleted: z.boolean().optional(),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      actionType: string;
      baseId: string;
      tableIdOrName: string;
      fieldMappings?: FieldMapping[];
      recordId?: string;
      fieldsToMergeOn?: string[];
      filterByFormula?: string;
      maxRecords?: number;
      view?: string;
      typecast?: boolean;
    };

    const conn = await ctx.resolveConnection('airtable', conf.connectionId);
    if (!conn.decryptedSecret?.trim())
      throw new Error(
        'Airtable connection secret is empty — revoke and re-save the connection',
      );
    const token = conn.decryptedSecret;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const base = `${AIRTABLE_BASE}/v0/${conf.baseId}/${encodeURIComponent(conf.tableIdOrName)}`;

    switch (conf.actionType) {
      case 'create_record': {
        const fields = buildFields(conf.fieldMappings ?? []);
        const body: Record<string, unknown> = { fields };

        if (conf.typecast) body.typecast = true;

        const res = await integrationFetch(base, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };

          throw new Error(
            `Airtable API error (${res.status}): ${err.error?.message ?? res.statusText}`,
          );
        }

        const data = (await res.json()) as {
          id?: string;
          fields?: Record<string, unknown>;
        };

        return { ok: true, recordId: data.id, fields: data.fields };
      }

      case 'update_record': {
        if (!conf.recordId) throw new Error('update_record requires recordId');

        const fields = buildFields(conf.fieldMappings ?? []);
        const body: Record<string, unknown> = { fields };

        if (conf.typecast) body.typecast = true;

        const res = await integrationFetch(`${base}/${conf.recordId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };

          throw new Error(
            `Airtable API error (${res.status}): ${err.error?.message ?? res.statusText}`,
          );
        }

        const data = (await res.json()) as {
          id?: string;
          fields?: Record<string, unknown>;
        };

        return { ok: true, recordId: data.id, fields: data.fields };
      }

      case 'get_record': {
        if (!conf.recordId) throw new Error('get_record requires recordId');

        const res = await integrationFetch(`${base}/${conf.recordId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };

          throw new Error(
            `Airtable API error (${res.status}): ${err.error?.message ?? res.statusText}`,
          );
        }

        const data = (await res.json()) as {
          id?: string;
          fields?: Record<string, unknown>;
        };

        return { ok: true, recordId: data.id, fields: data.fields };
      }

      case 'list_records': {
        const url = new URL(base);

        if (conf.filterByFormula)
          url.searchParams.set('filterByFormula', conf.filterByFormula);
        if (conf.maxRecords)
          url.searchParams.set('maxRecords', String(conf.maxRecords));
        if (conf.view) url.searchParams.set('view', conf.view);

        const res = await integrationFetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };

          throw new Error(
            `Airtable API error (${res.status}): ${err.error?.message ?? res.statusText}`,
          );
        }

        const data = (await res.json()) as {
          records?: Array<{ id?: string; fields?: Record<string, unknown> }>;
        };

        return {
          ok: true,
          records: (data.records ?? []).map((r) => ({ id: r.id, ...r.fields })),
        };
      }

      case 'delete_record': {
        if (!conf.recordId) throw new Error('delete_record requires recordId');

        const res = await integrationFetch(`${base}/${conf.recordId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };

          throw new Error(
            `Airtable API error (${res.status}): ${err.error?.message ?? res.statusText}`,
          );
        }

        const data = (await res.json()) as { deleted?: boolean; id?: string };

        return { ok: true, recordId: data.id, deleted: data.deleted };
      }

      case 'upsert_record': {
        if (!conf.fieldsToMergeOn?.length) {
          throw new Error('upsert_record requires fieldsToMergeOn');
        }

        const fields = buildFields(conf.fieldMappings ?? []);
        const body: Record<string, unknown> = {
          records: [{ fields }],
          performUpsert: { fieldsToMergeOn: conf.fieldsToMergeOn },
        };

        if (conf.typecast) body.typecast = true;

        const res = await integrationFetch(base, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };

          throw new Error(
            `Airtable API error (${res.status}): ${err.error?.message ?? res.statusText}`,
          );
        }

        const data = (await res.json()) as {
          createdRecords?: string[];
          updatedRecords?: string[];
          records?: Array<{ id?: string; fields?: Record<string, unknown> }>;
        };

        const firstRecord = data.records?.[0];

        return {
          ok: true,
          recordId: firstRecord?.id,
          fields: firstRecord?.fields,
          records: (data.records ?? []).map((r) => ({ id: r.id, ...r.fields })),
        };
      }

      default:
        throw new Error(`Unknown Airtable actionType: ${conf.actionType}`);
    }
  },
};
