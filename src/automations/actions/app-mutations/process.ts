import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';

const BLOCKED_KEYS = new Set([
  'id',
  'organization_id',
  'space_id',
  'created_by',
]);

export const processUpdate: ActionDefinition = {
  kind: 'app.process.update',
  category: 'app_mutation',
  type: 'action',
  label: { en: 'Update process', de: 'Prozess aktualisieren' },
  description: {
    en: 'Updates fields on an existing business process',
    de: 'Aktualisiert Felder eines vorhandenen Geschäftsprozesses',
  },
  icon: 'bx-git-branch',
  inputSchema: z.unknown(),
  configSchema: z.object({
    processId: z.string().min(1),
    fields: z.record(z.string(), z.unknown()),
  }),
  outputSchema: z.object({
    process: z.object({
      id: z.string(),
      name: z.string(),
      space_id: z.string(),
    }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      processId: string;
      fields: Record<string, unknown>;
    };

    const patch: Record<string, unknown> = { updated_by: ctx.actingUserId };

    for (const [k, v] of Object.entries(conf.fields)) {
      if (!BLOCKED_KEYS.has(k)) patch[k] = v;
    }

    if (Object.keys(patch).length <= 1) {
      throw new Error('processUpdate: no valid fields to update');
    }

    const { data, error } = await ctx.supabase
      .from('business_processes')
      .update(patch)
      .eq('id', conf.processId)
      .eq('organization_id', ctx.organizationId)
      .select('id, title, space_id')
      .single();

    if (error) throw new Error(`Failed to update process: ${error.message}`);

    const row = data as { id: string; title: string; space_id: string };

    return { process: { id: row.id, name: row.title, space_id: row.space_id } };
  },
};

export const riskUpdate: ActionDefinition = {
  kind: 'app.risk.update',
  category: 'app_mutation',
  type: 'action',
  label: { en: 'Update risk score', de: 'Risikobewertung aktualisieren' },
  description: {
    en: 'Sets the risk score on a business process',
    de: 'Setzt die Risikobewertung eines Geschäftsprozesses',
  },
  icon: 'bx-error-alt',
  inputSchema: z.unknown(),
  configSchema: z.object({
    processId: z.string().min(1),
    score: z.number().min(0).max(100),
    notes: z.string().optional(),
  }),
  outputSchema: z.object({
    process: z.object({
      id: z.string(),
      name: z.string(),
      risk_score: z.number(),
    }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as { processId: string; score: number; notes?: string };

    const patch: Record<string, unknown> = {
      risk_score: conf.score,
      updated_by: ctx.actingUserId,
    };

    if (conf.notes !== undefined) patch.risk_notes = conf.notes;

    const { data, error } = await ctx.supabase
      .from('business_processes')
      .update(patch)
      .eq('id', conf.processId)
      .eq('organization_id', ctx.organizationId)
      .select('id, title, risk_score')
      .single();

    if (error) throw new Error(`Failed to update risk score: ${error.message}`);

    const row = data as { id: string; title: string; risk_score: number };

    return {
      process: {
        id: row.id,
        name: row.title,
        risk_score: row.risk_score ?? conf.score,
      },
    };
  },
};
