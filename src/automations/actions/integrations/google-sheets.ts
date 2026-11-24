import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';
import { integrationFetch } from './http-utils';
import { unpackStoredSecret } from '../../../lib/crypto/encryption';

async function getAccessToken(conn: {
  decryptedSecret: string;
  metadata: Record<string, unknown>;
}): Promise<string> {
  const refreshToken = unpackStoredSecret(
    (conn.metadata as Record<string, string>).refresh_token,
  );

  if (!refreshToken) return conn.decryptedSecret;

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    refresh_token: refreshToken,
  });

  const res = await integrationFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = (await res.json()) as {
      error?: string;
      error_description?: string;
    };

    throw new Error(
      `Google token refresh failed: ${err.error_description ?? err.error ?? res.statusText}`,
    );
  }

  const data = (await res.json()) as { access_token: string };

  return data.access_token;
}

export const googleSheetsAppendRow: ActionDefinition = {
  kind: 'integration.google_sheets.append_row',
  category: 'integration',
  type: 'action',
  label: {
    en: 'Append row to Google Sheet',
    de: 'Zeile in Google Sheet einfügen',
  },
  description: {
    en: 'Appends a new row to a Google Spreadsheet',
    de: 'Fügt eine neue Zeile in eine Google-Tabelle ein',
  },
  icon: 'bx-table',
  requiresConnection: 'google_sheets',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    spreadsheetId: z.string().min(1),
    range: z.string().min(1),
    values: z.string().min(1),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    updatedRange: z.string(),
    updatedRows: z.number(),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      spreadsheetId: string;
      range: string;
      values: string;
    };

    const conn = await ctx.resolveConnection(
      'google_sheets',
      conf.connectionId,
    );
    if (!conn.decryptedSecret?.trim())
      throw new Error(
        'Google Sheets connection token is empty — revoke and re-authorize the connection',
      );
    const accessToken = await getAccessToken(conn);

    // `values` is either a JSON array of strings (written by the per-column
    // GoogleSheetsRowValuesMapper UI, one entry per sheet column, comma-safe) or a legacy
    // comma-delimited string (nodes configured before that mapper existed). Try JSON first
    // and only fall back to the old split-on-comma behavior when it isn't a JSON array, so
    // already-configured nodes keep running exactly as before.
    let parsedValues: string[];

    try {
      const asJson: unknown = JSON.parse(conf.values);

      parsedValues = Array.isArray(asJson)
        ? asJson.map((v) => String(v ?? ''))
        : conf.values.split(',').map((v) => v.trim());
    } catch {
      parsedValues = conf.values.split(',').map((v) => v.trim());
    }

    const encodedRange = encodeURIComponent(conf.range);
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${conf.spreadsheetId}/values/${encodedRange}:append` +
      `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const res = await integrationFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [parsedValues] }),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };

      throw new Error(
        `Google Sheets API error (${res.status}): ${err.error?.message ?? res.statusText}`,
      );
    }

    const data = (await res.json()) as {
      updates?: {
        updatedRange?: string;
        updatedRows?: number;
      };
    };

    return {
      ok: true,
      updatedRange: data.updates?.updatedRange ?? conf.range,
      updatedRows: data.updates?.updatedRows ?? 1,
    };
  },
};
