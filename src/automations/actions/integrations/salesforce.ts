import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';

export const salesforceCreateLead: ActionDefinition = {
  kind: 'integration.salesforce.create_lead',
  category: 'integration',
  type: 'action',
  label: { en: 'Create Salesforce Lead', de: 'Salesforce-Lead erstellen' },
  description: {
    en: 'Creates a lead record in Salesforce CRM',
    de: 'Erstellt einen Lead-Datensatz in Salesforce CRM',
  },
  icon: 'bx-user-plus',
  requiresConnection: 'salesforce',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    firstName: z.string().max(80).optional(),
    lastName: z.string().max(80),
    company: z.string().max(255),
    email: z.string().email().optional(),
    phone: z.string().max(40).optional(),
    description: z.string().max(1000).optional(),
  }),
  outputSchema: z.object({
    id: z.string(),
    success: z.boolean(),
    duplicate: z.boolean().optional(),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      firstName?: string;
      lastName: string;
      company: string;
      email?: string;
      phone?: string;
      description?: string;
    };

    const conn = await ctx.resolveConnection('salesforce', conf.connectionId);
    const instanceUrl = (
      (conn.metadata as Record<string, string>)?.instanceUrl ?? ''
    ).replace(/\/+$/, '');

    if (!instanceUrl) {
      throw new Error('Salesforce connection is missing instanceUrl metadata');
    }

    const body: Record<string, string> = {
      LastName: conf.lastName,
      Company: conf.company,
    };

    if (conf.firstName) body['FirstName'] = conf.firstName;
    if (conf.email) body['Email'] = conf.email;
    if (conf.phone) body['Phone'] = conf.phone;
    if (conf.description) body['Description'] = conf.description;

    const res = await fetch(
      `${instanceUrl}/services/data/v58.0/sobjects/Lead`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${conn.decryptedSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
    );

    const data = (await res.json()) as {
      id?: string;
      success?: boolean;
      errors?: Array<{
        errorCode?: string;
        message?: string;
        duplicateResult?: {
          allowSave?: boolean;
          matchResults?: Array<{
            matchRecords?: Array<{ record?: { Id?: string } }>;
          }>;
        };
      }>;
    };

    if (!res.ok || !data.success) {
      // Duplicate detected — return the existing record instead of failing
      const dupError = data.errors?.find(
        (e) => e.errorCode === 'DUPLICATES_DETECTED',
      );

      if (dupError?.duplicateResult) {
        const existingId =
          dupError.duplicateResult.matchResults?.[0]?.matchRecords?.[0]?.record
            ?.Id;

        if (existingId) {
          return { id: existingId, success: true, duplicate: true };
        }
      }

      const errDetail = Array.isArray(data.errors)
        ? data.errors
            .map((e) => `${e.errorCode ?? ''}: ${e.message ?? ''}`)
            .join('; ')
        : JSON.stringify(data);

      throw new Error(`Salesforce API error (${res.status}): ${errDetail}`);
    }

    return { id: data.id!, success: true, duplicate: false };
  },
};
