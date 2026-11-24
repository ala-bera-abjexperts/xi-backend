import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';

const HUBSPOT_CONTACTS_URL = 'https://api.hubapi.com/crm/v3/objects/contacts';

export const hubspotFetchOrCreateContact: ActionDefinition = {
  kind: 'integration.hubspot.fetch_or_create_contact',
  category: 'integration',
  type: 'action',
  label: {
    en: 'Fetch or Create HubSpot Contact',
    de: 'HubSpot-Kontakt abrufen oder erstellen',
  },
  description: {
    en: 'Looks up a contact by email in HubSpot. Returns the existing contact if found, otherwise creates a new one.',
    de: 'Sucht einen Kontakt per E-Mail in HubSpot. Gibt den vorhandenen Kontakt zurück oder erstellt einen neuen.',
  },
  icon: 'bx-user-check',
  requiresConnection: 'hubspot',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    email: z.string().email(),
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    phone: z.string().max(40).optional(),
    company: z.string().max(255).optional(),
    notes: z.string().max(2000).optional(),
  }),
  outputSchema: z.object({
    id: z.string(),
    email: z.string(),
    created: z.boolean(),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      email: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
      company?: string;
      notes?: string;
    };

    const conn = await ctx.resolveConnection('hubspot', conf.connectionId);
    const bearer = `Bearer ${conn.decryptedSecret}`;

    // Search for existing contact by email
    const searchRes = await fetch(`${HUBSPOT_CONTACTS_URL}/search`, {
      method: 'POST',
      headers: { Authorization: bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              { propertyName: 'email', operator: 'EQ', value: conf.email },
            ],
          },
        ],
        properties: ['email', 'firstname', 'lastname'],
        limit: 1,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!searchRes.ok) {
      const err = (await searchRes.json()) as { message?: string };
      throw new Error(
        `HubSpot search error (${searchRes.status}): ${err.message ?? 'Unknown error'}`,
      );
    }

    const searchData = (await searchRes.json()) as {
      total: number;
      results: Array<{ id: string; properties: { email: string } }>;
    };

    if (searchData.total > 0 && searchData.results[0]) {
      const existing = searchData.results[0];

      return {
        id: existing.id,
        email: existing.properties.email ?? conf.email,
        created: false,
      };
    }

    // Contact not found — create a new one
    const properties: Record<string, string> = { email: conf.email };
    if (conf.firstName) properties['firstname'] = conf.firstName;
    if (conf.lastName) properties['lastname'] = conf.lastName;
    if (conf.phone) properties['phone'] = conf.phone;
    if (conf.company) properties['company'] = conf.company;
    // hs_note_status is not a standard HubSpot contact property — notes are
    // stored via the Engagements API. Skip silently if notes are provided.

    const createRes = await fetch(HUBSPOT_CONTACTS_URL, {
      method: 'POST',
      headers: { Authorization: bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties }),
      signal: AbortSignal.timeout(30_000),
    });

    const createData = (await createRes.json()) as {
      id?: string;
      properties?: { email: string };
      message?: string;
      status?: string;
    };

    if (!createRes.ok) {
      throw new Error(
        `HubSpot API error (${createRes.status}): ${createData.message ?? createData.status ?? 'Unknown error'}`,
      );
    }

    return {
      id: createData.id!,
      email: createData.properties?.email ?? conf.email,
      created: true,
    };
  },
};
