import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';

export const planCreate: ActionDefinition = {
  kind: 'app.plan.create',
  category: 'app_mutation',
  type: 'action',
  label: { en: 'Create plan', de: 'Plan erstellen' },
  description: {
    en: 'Creates a new plan in the specified space',
    de: 'Erstellt einen neuen Plan im angegebenen Bereich',
  },
  icon: 'bx-calendar-plus',
  inputSchema: z.unknown(),
  configSchema: z.object({
    spaceId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  }),
  outputSchema: z.object({
    plan: z.object({
      id: z.string().uuid(),
      name: z.string(),
      space_id: z.string(),
    }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      spaceId: string;
      name: string;
      description?: string;
      startDate?: string;
      endDate?: string;
    };

    const insert: Record<string, unknown> = {
      space_id: conf.spaceId,
      organization_id: ctx.organizationId,
      name: conf.name,
      status: 'draft',
      plan_type: 'waterfall',
      progress: 0,
      sort_order: 0,
      currency: 'EUR',
      settings: {},
      created_by: ctx.actingUserId,
    };

    if (conf.description) insert.description = conf.description;
    if (conf.startDate) insert.start_date = conf.startDate;
    if (conf.endDate) insert.end_date = conf.endDate;

    const { data, error } = await ctx.supabase
      .from('plans')
      .insert(insert)
      .select('id, name, space_id')
      .single();

    if (error) throw new Error(`Failed to create plan: ${error.message}`);

    const row = data as { id: string; name: string; space_id: string };

    return { plan: { id: row.id, name: row.name, space_id: row.space_id } };
  },
};
