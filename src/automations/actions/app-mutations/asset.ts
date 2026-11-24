import { storageSafeFileName } from '../../../common/upload-filename';
import { UPLOAD_LIMITS } from '../../../common/upload-limits';
import nodemailer from 'nodemailer';
import { z } from 'zod';

import { assertPublicHttpUrl } from '../../../common/security/ssrf-guard';
import type { ActionDefinition, ExecutionContext } from '../types';

const emailOrTemplate = z
  .string()
  .refine((v) => v.includes('{{') || (v.includes('@') && v.includes('.')), {
    message: 'Invalid email address',
  });

const isEmailOrTemplate = (s: string) =>
  s.includes('{{') || (s.includes('@') && s.includes('.'));

const coerceEmailArray = (v: unknown): unknown => {
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && isEmailOrTemplate(s));
  }

  if (Array.isArray(v)) {
    return (v as unknown[]).filter(
      (s) =>
        typeof s === 'string' && s.trim() !== '' && isEmailOrTemplate(s.trim()),
    );
  }

  return [];
};

function buildAssetEmailHtml(asset: Record<string, unknown>): string {
  const name =
    (asset['name'] as string | null) ??
    (asset['title'] as string | null) ??
    '(unnamed)';

  const schemaName = (asset['schema_name'] as string | null) ?? '';

  const typeName = (asset['type_name'] as string | null) ?? '';

  const createdAt = asset['created_at']
    ? new Date(asset['created_at'] as string).toLocaleString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

  // Core detail rows
  const detailRows: string[] = [];

  const addRow = (label: string, value: string) => {
    detailRows.push(`
      <tr>
        <td style="padding:14px 20px;width:140px;font-size:11px;font-weight:700;color:#696CFF;text-transform:uppercase;letter-spacing:0.08em;white-space:nowrap;border-bottom:1px solid #F3F4F6">${escHtml(label)}</td>
        <td style="padding:14px 20px;font-size:14px;color:#2B2C40;font-weight:500;border-bottom:1px solid #F3F4F6">${escHtml(value)}</td>
      </tr>`);
  };

  addRow('Name', name);
  if (schemaName) addRow('Schema', schemaName);
  if (typeName) addRow('Type', typeName);
  if (createdAt) addRow('Created', createdAt);

  // Attribute values section
  let attributeSection = '';
  const cfv = asset['attribute_values'];

  if (cfv && typeof cfv === 'object' && !Array.isArray(cfv)) {
    const entries = Object.entries(cfv as Record<string, unknown>).filter(
      ([, v]) => v !== null && v !== undefined && v !== '',
    );

    if (entries.length > 0) {
      const attrRows = entries
        .map(([key, value]) => {
          const displayVal =
            typeof value === 'object'
              ? JSON.stringify(value)
              : String(value as string | number | boolean);

          const label = key
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase());

          return `
          <tr>
            <td style="padding:12px 20px;width:140px;font-size:11px;font-weight:700;color:#696CFF;text-transform:uppercase;letter-spacing:0.08em;white-space:nowrap;border-bottom:1px solid #F3F4F6">${escHtml(label)}</td>
            <td style="padding:12px 20px;font-size:14px;color:#2B2C40;font-weight:500;border-bottom:1px solid #F3F4F6">${escHtml(displayVal)}</td>
          </tr>`;
        })
        .join('');

      attributeSection = `
        <tr>
          <td colspan="2" style="padding:12px 20px;background:#F5F5F9;border-top:2px solid #E5E7EB;border-bottom:1px solid #E5E7EB">
            <span style="font-size:10px;font-weight:700;color:#696CFF;text-transform:uppercase;letter-spacing:0.1em">Attributes</span>
          </td>
        </tr>
        ${attrRows}`;
    }
  }

  const initial = escHtml(name.charAt(0).toUpperCase());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#F5F5F9;font-family:'Public Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">

  <!-- HEADER BAND: full width dark -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#232333">
    <tr>
      <td align="center" style="padding:36px 24px 32px">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px">
          <tr>
            <td>
              <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px">
                <tr>
                  <td style="background:rgba(105,108,255,0.18);border-radius:6px;padding:5px 12px">
                    <span style="font-size:11px;font-weight:700;color:#696CFF;letter-spacing:0.1em;text-transform:uppercase">XiSuite Automation</span>
                  </td>
                </tr>
              </table>
              <h1 style="margin:0 0 8px;font-size:26px;font-weight:700;color:#ffffff;line-height:1.25;letter-spacing:-0.01em">Asset Notification</h1>
              <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.45);line-height:1.5">A new asset has been created and shared with you.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

  <!-- ACCENT LINE: full-width primary stripe -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td height="4" style="background:#696CFF;font-size:0;line-height:0">&nbsp;</td>
    </tr>
  </table>

  <!-- BODY BAND: full width white -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff">
    <tr>
      <td align="center" style="padding:36px 24px 32px">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px">

          <!-- Asset Identity -->
          <tr>
            <td style="padding-bottom:28px">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle">
                    <div style="width:48px;height:48px;border-radius:12px;background:#696CFF;text-align:center;line-height:48px;display:inline-block">
                      <span style="font-size:22px;font-weight:700;color:#ffffff">${initial}</span>
                    </div>
                  </td>
                  <td style="vertical-align:middle;padding-left:16px">
                    <div style="font-size:11px;font-weight:600;color:#696CFF;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:3px">Asset Name</div>
                    <div style="font-size:22px;font-weight:700;color:#2B2C40;letter-spacing:-0.01em">${escHtml(name)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Details Table -->
          <tr>
            <td>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #E5E7EB;border-radius:10px;overflow:hidden">
                <tr>
                  <td colspan="2" style="padding:12px 20px;background:#F5F5F9;border-bottom:1px solid #E5E7EB">
                    <span style="font-size:10px;font-weight:700;color:#696CFF;text-transform:uppercase;letter-spacing:0.1em">Details</span>
                  </td>
                </tr>
                ${detailRows.join('')}
                ${attributeSection}
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

  <!-- FOOTER BAND: full width -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F5F9;border-top:1px solid #E5E7EB">
    <tr>
      <td align="center" style="padding:20px 24px">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px">
          <tr>
            <td>
              <p style="margin:0;font-size:12px;color:#9CA3AF;line-height:1.7">
                This notification was sent automatically by <strong style="color:#696CFF;font-weight:600">XiSuite Automation</strong>.<br/>
                You are receiving this because you are subscribed to asset notifications.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const assetSendDetailsEmail: ActionDefinition = {
  kind: 'app.asset_object.send_details_email',
  category: 'app_mutation',
  type: 'action',
  label: {
    en: 'Send asset details with email',
    de: 'Asset-Details per E-Mail senden',
  },
  description: {
    en: 'Fetches asset details from the database and sends them as a formatted email',
    de: 'Ruft Asset-Details aus der Datenbank ab und sendet sie als formatierten E-Mail',
  },
  icon: 'bx-envelope',
  inputSchema: z.unknown(),
  configSchema: z.object({
    assetId: z
      .string()
      .min(1)
      .describe(
        'Asset UUID — use {{ trigger.asset_id }} to pick it up from the automation trigger',
      ),
    to: z
      .preprocess(coerceEmailArray, z.array(emailOrTemplate).min(1))
      .describe(
        'Recipient email addresses — type and press Enter to add each one',
      ),
    cc: z
      .preprocess(coerceEmailArray, z.array(emailOrTemplate))
      .optional()
      .describe('CC recipients — optional'),
    bcc: z
      .preprocess(coerceEmailArray, z.array(emailOrTemplate))
      .optional()
      .describe('BCC recipients — optional'),
    subject: z
      .string()
      .max(200)
      .optional()
      .describe('Email subject — leave blank to use "Asset Details: {name}"'),
    fromName: z.string().optional().describe('Display name shown as sender'),
  }),
  outputSchema: z.object({ ok: z.boolean(), messageId: z.string() }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    console.log('asset.send_details_email', { config, input: _input });
    const conf = config as {
      assetId: string;
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      fromName?: string;
    };

    try {
      // Try asset_objects first (primary system), then asset_items (legacy)
      let asset: Record<string, unknown> | null = null;

      const { data: objData, error: objErr } = await ctx.supabase
        .from('asset_objects')
        .select(
          `id, name, attribute_values, object_type_id, schema_id, created_at,
           object_type:asset_object_types(name),
           schema:asset_object_schemas(name)`,
        )
        .eq('id', conf.assetId)
        .eq('organization_id', ctx.organizationId)
        .maybeSingle();

      if (objErr) {
        throw new Error(`Failed to fetch asset object: ${objErr.message}`);
      }

      if (objData) {
        const row = objData as Record<string, unknown>;
        const typeRow = row['object_type'] as Record<string, unknown> | null;
        const schemaRow = row['schema'] as Record<string, unknown> | null;

        asset = {
          ...row,
          type_name: typeRow?.['name'] ?? null,
          schema_name: schemaRow?.['name'] ?? null,
        };
      } else {
        const { data: itemData, error: itemErr } = await ctx.supabase
          .from('asset_items')
          .select('id, title, schema_id, created_at, asset_schemas(name)')
          .eq('id', conf.assetId)
          .eq('organization_id', ctx.organizationId)
          .maybeSingle();

        if (itemErr) {
          throw new Error(`Failed to fetch asset item: ${itemErr.message}`);
        }

        if (itemData) {
          const row = itemData as Record<string, unknown>;

          const schemaRow = row['asset_schemas'] as Record<
            string,
            unknown
          > | null;

          asset = {
            ...row,
            name: row['title'],
            schema_name: schemaRow?.['name'] ?? null,
          };
        }
      }

      if (!asset) {
        throw new Error(
          `Asset ${conf.assetId} not found in organization ${ctx.organizationId}`,
        );
      }

      const host = process.env.SMTP_HOST;
      const user = process.env.EMAIL_FROM;
      const pass = process.env.EMAIL_PASS;

      if (!host || !user || !pass) {
        throw new Error(
          'SMTP_HOST, EMAIL_FROM and EMAIL_PASS environment variables are required to send email',
        );
      }

      const assetName =
        (asset['name'] as string | null) ??
        (asset['title'] as string | null) ??
        'Asset';

      const subject = conf.subject || `Asset Details: ${assetName}`;
      const port = parseInt(process.env.SMTP_PORT ?? '587', 10);
      const secure = port === 465;

      const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
      });

      const from = conf.fromName ? `${conf.fromName} <${user}>` : user;

      const info = await transporter.sendMail({
        from,
        to: conf.to,
        cc: conf.cc,
        bcc: conf.bcc,
        subject,
        html: buildAssetEmailHtml(asset),
      });

      return { ok: true, messageId: info.messageId };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      ctx.logger.error(`[asset.send_details_email] failed: ${message}`, {
        assetId: conf.assetId,
      });
      throw new Error(`Failed to send asset details email: ${message}`);
    }
  },
};

export const assetObjectCreate: ActionDefinition = {
  kind: 'app.asset_object.create',
  category: 'app_mutation',
  type: 'action',
  label: { en: 'Create Asset Object', de: 'Asset-Objekt erstellen' },
  description: {
    en: 'Creates a new asset object in the given schema/type',
    de: 'Erstellt ein neues Asset-Objekt im angegebenen Schema/Typ',
  },
  icon: 'bx-cube-alt',
  inputSchema: z.unknown(),
  configSchema: z.object({
    schemaId: z.string().min(1),
    objectTypeId: z.string().min(1),
    name: z.string().min(1).max(255),
    description: z.string().optional(),
    attributeValues: z.record(z.string(), z.any()).optional(),
  }),
  outputSchema: z.object({
    asset: z.object({
      id: z.string().uuid(),
      object_key: z.string().nullable(),
      name: z.string(),
    }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      schemaId: string;
      objectTypeId: string;
      name: string;
      description?: string;
      attributeValues?: Record<string, unknown>;
    };

    const insert: Record<string, unknown> = {
      schema_id: conf.schemaId,
      object_type_id: conf.objectTypeId,
      name: conf.name,
      space_id: ctx.spaceId,
      organization_id: ctx.organizationId,
      created_by: ctx.actingUserId,
      updated_by: ctx.actingUserId,
    };

    if (conf.description !== undefined) insert.description = conf.description;
    if (conf.attributeValues) insert.attribute_values = conf.attributeValues;

    const { data, error } = await ctx.supabase
      .from('asset_objects')
      .insert(insert)
      .select('id, object_key, name')
      .single();

    if (error)
      throw new Error(`Failed to create asset object: ${error.message}`);

    const row = data as {
      id: string;
      object_key: string | null;
      name: string;
    };

    return {
      asset: { id: row.id, object_key: row.object_key, name: row.name },
    };
  },
};

export const assetObjectUpdate: ActionDefinition = {
  kind: 'app.asset_object.update',
  category: 'app_mutation',
  type: 'action',
  label: { en: 'Update Asset Object', de: 'Asset-Objekt aktualisieren' },
  description: {
    en: 'Updates fields on an existing asset object',
    de: 'Aktualisiert Felder eines vorhandenen Asset-Objekts',
  },
  icon: 'bx-cube',
  inputSchema: z.unknown(),
  configSchema: z.object({
    assetId: z
      .string()
      .min(1)
      .describe(
        'Asset UUID — use {{ trigger.asset_id }} to pick it up from the automation trigger',
      ),
    name: z.string().optional(),
    description: z.string().optional(),
    attributeValues: z.record(z.string(), z.any()).optional(),
  }),
  outputSchema: z.object({
    asset: z.object({ id: z.string().uuid(), name: z.string() }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      assetId: string;
      name?: string;
      description?: string;
      attributeValues?: Record<string, unknown>;
    };

    const patch: Record<string, unknown> = { updated_by: ctx.actingUserId };

    if (conf.name !== undefined) patch.name = conf.name;
    if (conf.description !== undefined) patch.description = conf.description;
    if (conf.attributeValues !== undefined)
      patch.attribute_values = conf.attributeValues;

    if (Object.keys(patch).length === 1) {
      throw new Error(
        'Update Asset Object: at least one field must be specified',
      );
    }

    const { data, error } = await ctx.supabase
      .from('asset_objects')
      .update(patch)
      .eq('id', conf.assetId)
      .eq('organization_id', ctx.organizationId)
      .select('id, name')
      .single();

    if (error)
      throw new Error(`Failed to update asset object: ${error.message}`);

    const row = data as { id: string; name: string };

    return { asset: { id: row.id, name: row.name } };
  },
};

export const assetObjectDelete: ActionDefinition = {
  kind: 'app.asset_object.delete',
  category: 'app_mutation',
  type: 'action',
  label: { en: 'Delete Asset Object', de: 'Asset-Objekt löschen' },
  description: {
    en: 'Permanently deletes an asset object',
    de: 'Löscht ein Asset-Objekt endgültig',
  },
  icon: 'bx-trash',
  inputSchema: z.unknown(),
  configSchema: z.object({
    assetId: z
      .string()
      .min(1)
      .describe(
        'Asset UUID — use {{ trigger.asset_id }} to pick it up from the automation trigger',
      ),
  }),
  outputSchema: z.object({ ok: z.boolean(), asset_id: z.string().uuid() }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as { assetId: string };

    const { error } = await ctx.supabase
      .from('asset_objects')
      .delete()
      .eq('id', conf.assetId)
      .eq('organization_id', ctx.organizationId);

    if (error)
      throw new Error(`Failed to delete asset object: ${error.message}`);

    return { ok: true, asset_id: conf.assetId };
  },
};

export const assetObjectChangeType: ActionDefinition = {
  kind: 'app.asset_object.change_type',
  category: 'app_mutation',
  type: 'action',
  label: { en: 'Change Asset Object type', de: 'Asset-Objekttyp ändern' },
  description: {
    en: 'Reassigns an asset object to a different object type',
    de: 'Weist einem Asset-Objekt einen anderen Objekttyp zu',
  },
  icon: 'bx-transfer',
  inputSchema: z.unknown(),
  configSchema: z.object({
    assetId: z
      .string()
      .min(1)
      .describe(
        'Asset UUID — use {{ trigger.asset_id }} to pick it up from the automation trigger',
      ),
    newObjectTypeId: z.string().min(1),
  }),
  outputSchema: z.object({
    asset: z.object({
      id: z.string().uuid(),
      object_type_id: z.string().uuid(),
    }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as { assetId: string; newObjectTypeId: string };

    const { data, error } = await ctx.supabase
      .from('asset_objects')
      .update({
        object_type_id: conf.newObjectTypeId,
        updated_by: ctx.actingUserId,
      })
      .eq('id', conf.assetId)
      .eq('organization_id', ctx.organizationId)
      .select('id, object_type_id')
      .single();

    if (error)
      throw new Error(`Failed to change asset object type: ${error.message}`);

    const row = data as { id: string; object_type_id: string };

    return { asset: { id: row.id, object_type_id: row.object_type_id } };
  },
};

export const assetObjectAddComment: ActionDefinition = {
  kind: 'app.asset_object.add_comment',
  category: 'app_mutation',
  type: 'action',
  label: {
    en: 'Add Asset Object comment',
    de: 'Asset-Objekt-Kommentar hinzufügen',
  },
  description: {
    en: 'Posts a comment on an asset object',
    de: 'Fügt einen Kommentar zu einem Asset-Objekt hinzu',
  },
  icon: 'bx-comment-add',
  inputSchema: z.unknown(),
  configSchema: z.object({
    assetId: z
      .string()
      .min(1)
      .describe(
        'Asset UUID — use {{ trigger.asset_id }} to pick it up from the automation trigger',
      ),
    body: z.string().min(1).max(5000),
  }),
  outputSchema: z.object({
    comment: z.object({
      id: z.string().uuid(),
      body: z.string(),
      asset_id: z.string().uuid(),
    }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as { assetId: string; body: string };

    const { data, error } = await ctx.supabase
      .from('asset_object_comments')
      .insert({
        object_id: conf.assetId,
        space_id: ctx.spaceId,
        organization_id: ctx.organizationId,
        content: conf.body,
        created_by: ctx.actingUserId,
      })
      .select('id, content, object_id')
      .single();

    if (error) throw new Error(`Failed to add comment: ${error.message}`);

    const row = data as { id: string; content: string; object_id: string };

    return {
      comment: { id: row.id, body: row.content, asset_id: row.object_id },
    };
  },
};

const ATTACHMENT_MAX_SIZE_BYTES = UPLOAD_LIMITS.ATTACHMENT;

export const assetObjectAddAttachment: ActionDefinition = {
  kind: 'app.asset_object.add_attachment',
  category: 'app_mutation',
  type: 'action',
  label: {
    en: 'Add Asset Object attachment',
    de: 'Asset-Objekt-Anhang hinzufügen',
  },
  description: {
    en: 'Downloads a file from a URL and attaches it to an asset object',
    de: 'Lädt eine Datei von einer URL herunter und hängt sie an ein Asset-Objekt an',
  },
  icon: 'bx-paperclip',
  inputSchema: z.unknown(),
  configSchema: z.object({
    assetId: z
      .string()
      .min(1)
      .describe(
        'Asset UUID — use {{ trigger.asset_id }} to pick it up from the automation trigger',
      ),
    fileUrl: z
      .string()
      .url()
      .describe('Publicly reachable URL of the file to attach'),
    fileName: z
      .string()
      .max(255)
      .optional()
      .describe('Leave blank to derive from the URL'),
  }),
  outputSchema: z.object({
    attachment: z.object({
      id: z.string().uuid(),
      file_name: z.string(),
    }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      assetId: string;
      fileUrl: string;
      fileName?: string;
    };

    const { data: assetRow, error: assetErr } = await ctx.supabase
      .from('asset_objects')
      .select('schema_id')
      .eq('id', conf.assetId)
      .eq('organization_id', ctx.organizationId)
      .maybeSingle();

    if (assetErr)
      throw new Error(`Failed to look up asset object: ${assetErr.message}`);
    if (!assetRow) throw new Error(`Asset object ${conf.assetId} not found`);

    const schemaId = (assetRow as { schema_id: string }).schema_id;

    let response: Response;

    // SECURITY (H8): validate the user-supplied URL is a public HTTP(S) target
    // before fetching — blocks SSRF to cloud metadata (169.254.169.254),
    // localhost, and private/link-local ranges. Throws on a blocked/malformed URL.
    await assertPublicHttpUrl(conf.fileUrl);

    try {
      response = await fetch(conf.fileUrl, {
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new Error(
        `Failed to download file from URL: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      throw new Error(`Failed to download file: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > ATTACHMENT_MAX_SIZE_BYTES) {
      throw new Error('File exceeds maximum size of 50 MB');
    }

    const contentType =
      response.headers.get('content-type') ?? 'application/octet-stream';
    const urlName =
      conf.fileUrl.split('/').pop()?.split('?')[0] || 'attachment';
    const fileName = conf.fileName || urlName;
    const sanitizedName = storageSafeFileName(fileName);

    // Determine the next version number for this filename, same as the manual upload path.
    const { data: existingRows, error: versionErr } = await ctx.supabase
      .from('asset_object_attachments')
      .select('version_number')
      .eq('object_id', conf.assetId)
      .eq('organization_id', ctx.organizationId)
      .eq('file_name', fileName)
      .order('version_number', { ascending: false })
      .limit(1);

    if (versionErr)
      throw new Error(
        `Failed to determine file version: ${versionErr.message}`,
      );

    const existing = (existingRows ?? []) as Record<string, unknown>[];
    const nextVersion =
      existing.length > 0
        ? ((existing[0]['version_number'] as number) ?? 0) + 1
        : 1;

    const filePath = `${ctx.organizationId}/${conf.assetId}/${Date.now()}-v${nextVersion}-${sanitizedName}`;

    const { error: uploadError } = await ctx.supabase.storage
      .from('asset-object-attachments')
      .upload(filePath, buffer, { contentType, upsert: false });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    const { data, error } = await ctx.supabase
      .from('asset_object_attachments')
      .insert({
        object_id: conf.assetId,
        schema_id: schemaId,
        space_id: ctx.spaceId,
        organization_id: ctx.organizationId,
        file_name: fileName,
        file_path: filePath,
        file_size: buffer.length,
        mime_type: contentType,
        uploaded_by: ctx.actingUserId,
        version_number: nextVersion,
      })
      .select('id, file_name')
      .single();

    if (error) {
      await ctx.supabase.storage
        .from('asset-object-attachments')
        .remove([filePath]);
      throw new Error(`Failed to save attachment metadata: ${error.message}`);
    }

    const row = data as { id: string; file_name: string };

    return { attachment: { id: row.id, file_name: row.file_name } };
  },
};
