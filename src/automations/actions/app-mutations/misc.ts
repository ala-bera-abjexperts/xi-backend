import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';

export const notificationCreate: ActionDefinition = {
  kind: 'app.notification.create',
  category: 'app_mutation',
  type: 'action',
  label: { en: 'Create notification', de: 'Benachrichtigung erstellen' },
  description: {
    en: 'Sends an in-app notification to a user',
    de: 'Sendet eine In-App-Benachrichtigung an einen Benutzer',
  },
  icon: 'bx-bell',
  inputSchema: z.unknown(),
  configSchema: z.object({
    userId: z.string().min(1),
    type: z.string().min(1),
    title: z.string().min(1),
    body: z.string().optional(),
    referenceType: z.string().optional(),
    referenceId: z.string().optional(),
  }),
  outputSchema: z.object({
    notification: z.object({
      id: z.string().uuid(),
      type: z.string(),
      title: z.string(),
    }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      userId: string;
      type: string;
      title: string;
      body?: string;
      referenceType?: string;
      referenceId?: string;
    };

    // Resolve "self" sentinel to the acting user at execution time.
    // Throws when there is no acting user (service-account / scheduled run) so
    // the automation run step is marked failed with a descriptive message rather
    // than silently inserting a notification with no recipient.
    const targetUserId =
      conf.userId === 'self' ? (ctx.actingUserId ?? null) : conf.userId;

    if (!targetUserId) {
      throw new Error(
        'app.notification.create: userId is "self" but there is no acting user ' +
          'in this execution context (scheduled or service-account trigger). ' +
          'Use a specific userId or add a condition to prevent this action from ' +
          'running when there is no acting user.',
      );
    }

    const insert: Record<string, unknown> = {
      organization_id: ctx.organizationId,
      user_id: targetUserId,
      type: conf.type,
      title: conf.title,
    };

    if (conf.body !== undefined) insert.body = conf.body;
    if (conf.referenceType !== undefined)
      insert.reference_type = conf.referenceType;
    if (conf.referenceId !== undefined) insert.reference_id = conf.referenceId;

    const { data, error } = await ctx.supabase
      .from('notifications')
      .insert(insert)
      .select('*')
      .single();

    if (error)
      throw new Error(`Failed to create notification: ${error.message}`);

    ctx.broadcastNotification?.(data as Record<string, unknown>);

    const row = data as { id: string; type: string; title: string };

    return { notification: { id: row.id, type: row.type, title: row.title } };
  },
};

export const auditLog: ActionDefinition = {
  kind: 'app.audit.log',
  category: 'app_mutation',
  type: 'action',
  label: { en: 'Write audit log', de: 'Audit-Log schreiben' },
  description: {
    en: 'Writes an entry to the audit log',
    de: 'Schreibt einen Eintrag in das Audit-Log',
  },
  icon: 'bx-clipboard',
  inputSchema: z.unknown(),
  configSchema: z.object({
    entityType: z.string().optional(),
    entityId: z.string().optional(),
    action: z.string().min(1),
    changesField: z.string().optional(),
    changesValue: z.string().optional(),
  }),
  outputSchema: z.object({
    log: z.object({
      id: z.string().uuid(),
      entity_type: z.string().nullable(),
      action: z.string(),
    }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      entityType?: string;
      entityId?: string;
      action: string;
      changesField?: string;
      changesValue?: string;
    };

    const insert: Record<string, unknown> = {
      organization_id: ctx.organizationId,
      user_id: ctx.actingUserId ?? null,
      // entity_type is NOT NULL in the DB — fall back to 'automation' when omitted
      entity_type: conf.entityType ?? 'automation',
      action: conf.action,
    };

    if (conf.entityId !== undefined) insert.entity_id = conf.entityId;

    if (conf.changesField) {
      insert.changes = { [conf.changesField]: conf.changesValue ?? null };
    }

    const { data, error } = await ctx.supabase
      .from('audit_logs')
      .insert(insert)
      .select('id, entity_type, action')
      .single();

    if (error) throw new Error(`Failed to write audit log: ${error.message}`);

    const row = data as {
      id: string;
      entity_type: string | null;
      action: string;
    };

    return {
      log: { id: row.id, entity_type: row.entity_type, action: row.action },
    };
  },
};
