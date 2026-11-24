import { createHash } from 'crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';

const VERSIONS_TABLE = 'form_builder_versions';
const FORMS_TABLE = 'form_builder';
const FIELDS_TABLE = 'form_builder_fields';

// Keep at most this many versions per form; older ones are pruned on capture.
const RETENTION = 100;

// The field columns a version snapshot stores — exactly the set
// `replace_form_builder_fields` / `restore_form_builder_version` read back
// (`f->>'field_key'` …), so a restored field round-trips to what was saved.
const SNAPSHOT_FIELD_KEYS = [
  'field_key',
  'field_type',
  'label',
  'label_i18n',
  'placeholder',
  'help_text',
  'description',
  'required',
  'options',
  'validation_rules',
  'default_value',
  'conditional_logic',
  'calculation',
  'page_index',
  'section',
  'column_span',
  'sort_order',
  'is_hidden',
  'read_only',
] as const;

/** Recursively sort object keys so JSON.stringify is order-independent → stable hash. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonicalize(obj[k]);

        return acc;
      }, {});
  }

  return value;
}

type FormRow = {
  id: string;
  name: string | null;
  description: string | null;
  icon: string | null;
  status: string | null;
  settings: Record<string, unknown> | null;
  version: number;
};

type FieldRow = Record<string, unknown> & { sort_order?: number };

/**
 * Append-only version history for form-builder forms. Snapshots the whole form
 * (meta + settings + all fields) into `form_builder_versions`; restore re-applies
 * a snapshot to the live form via the `restore_form_builder_version` RPC.
 *
 * Depends only on the Supabase client — capture reads the live tables, restore is
 * a single RPC — so there is no dependency on the fields service (no cycle).
 */
@Injectable()
export class FormBuilderVersionsService {
  private readonly logger = new Logger(FormBuilderVersionsService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Snapshot the current live form as a new version. Best-effort — NEVER throws:
   * a versioning failure must never break the save it hangs off. Deduped against
   * the latest version's content hash unless `force` (the manual "Save version").
   */
  async captureVersion(
    formId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    try {
      const { data: formData } = await this.client
        .from(FORMS_TABLE)
        .select('id, name, description, icon, status, settings, version')
        .eq('id', formId)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .eq('is_deleted', false)
        .maybeSingle();

      if (!formData) return;

      const form = formData as unknown as FormRow;

      const { data: fieldsData } = await this.client
        .from(FIELDS_TABLE)
        .select('*')
        .eq('form_id', formId)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .order('sort_order', { ascending: true });

      const fieldsSnapshot = ((fieldsData ?? []) as FieldRow[]).map((row) => {
        const picked: Record<string, unknown> = {};

        for (const key of SNAPSHOT_FIELD_KEYS) picked[key] = row[key] ?? null;

        return picked;
      });

      const contentHash = createHash('sha256')
        .update(
          JSON.stringify(
            canonicalize({
              name: form.name,
              description: form.description,
              icon: form.icon,
              settings: form.settings ?? {},
              fields: fieldsSnapshot,
            }),
          ),
        )
        .digest('hex');

      if (!opts.force) {
        // Deduped against EVERY version of this form, not just the newest one. Comparing only against
        // the newest missed the case this exists for: restore v4 while v6 is newest, press Save, and
        // the hash differs from v6 so a v7 gets written that is byte-identical to v4. Saving content
        // that is already in the history should never add a row, whichever row it matches.
        const { data: duplicate } = await this.client
          .from(VERSIONS_TABLE)
          .select('id')
          .eq('form_id', formId)
          .eq('space_id', spaceId)
          .eq('organization_id', organizationId)
          .eq('content_hash', contentHash)
          .limit(1)
          .maybeSingle();

        if (duplicate) {
          return; // this exact content is already a version — nothing new to record
        }
      }

      // Insert with a fresh sequential number; the UNIQUE(form_id, version_number)
      // guards the rare concurrent-capture race — retry once.
      for (let attempt = 0; attempt < 2; attempt++) {
        const { data: maxRow } = await this.client
          .from(VERSIONS_TABLE)
          .select('version_number')
          .eq('form_id', formId)
          .order('version_number', { ascending: false })
          .limit(1)
          .maybeSingle();

        const nextNumber =
          ((maxRow as { version_number: number } | null)?.version_number ?? 0) +
          1;

        const { error } = await this.client.from(VERSIONS_TABLE).insert({
          form_id: formId,
          organization_id: organizationId,
          space_id: spaceId,
          version_number: nextNumber,
          form_version: form.version,
          name: form.name,
          description: form.description,
          icon: form.icon,
          status: form.status,
          settings: form.settings ?? {},
          fields_snapshot: fieldsSnapshot,
          content_hash: contentHash,
          created_by: userId,
        });

        if (!error) break;
        if (error.code !== '23505' || attempt === 1) throw error;
      }

      await this.pruneOld(formId);
    } catch (err) {
      // Best-effort: log and swallow so the surrounding save always succeeds.
      this.logger.warn(
        `captureVersion failed for form ${formId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  /** Keep only the most recent RETENTION versions for a form. Best-effort. */
  private async pruneOld(formId: string): Promise<void> {
    const { data } = await this.client
      .from(VERSIONS_TABLE)
      .select('id')
      .eq('form_id', formId)
      .order('created_at', { ascending: false })
      .range(RETENTION, RETENTION + 999);

    const stale = ((data ?? []) as { id: string }[]).map((r) => r.id);

    if (stale.length === 0) return;

    await this.client.from(VERSIONS_TABLE).delete().in('id', stale);
  }

  /** Version rows for a form (newest first), WITHOUT the heavy fields_snapshot. */
  async list(formId: string, spaceId: string, organizationId: string) {
    const { data, error } = await this.client
      .from(VERSIONS_TABLE)
      .select('id, version_number, form_version, name, created_at, created_by')
      .eq('form_id', formId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('version_number', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    const rows = (data ?? []) as Array<{
      id: string;
      version_number: number;
      form_version: number | null;
      name: string | null;
      created_at: string;
      created_by: string | null;
    }>;

    const actorIds = [
      ...new Set(rows.map((r) => r.created_by).filter(Boolean)),
    ] as string[];
    const actorsById = new Map<
      string,
      { id: string; first_name: string; last_name: string; email: string }
    >();

    if (actorIds.length > 0) {
      const { data: users } = await this.client
        .from('users')
        .select('id, first_name, last_name, email')
        .in('id', actorIds);

      for (const u of (users ?? []) as Array<{
        id: string;
        first_name: string;
        last_name: string;
        email: string;
      }>) {
        actorsById.set(u.id, u);
      }
    }

    return rows.map((r) => ({
      id: r.id,
      version: r.version_number,
      form_version: r.form_version,
      name: r.name,
      created_at: r.created_at,
      actor: r.created_by ? (actorsById.get(r.created_by) ?? null) : null,
    }));
  }

  /** One version WITH its fields_snapshot (for the read-only preview). */
  async getOne(
    formId: string,
    versionId: string,
    spaceId: string,
    organizationId: string,
  ) {
    const { data, error } = await this.client
      .from(VERSIONS_TABLE)
      .select(
        'id, version_number, name, description, icon, settings, fields_snapshot, created_at, created_by',
      )
      .eq('id', versionId)
      .eq('form_id', formId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Version not found');

    const row = data as {
      id: string;
      version_number: number;
      name: string | null;
      description: string | null;
      icon: string | null;
      settings: Record<string, unknown> | null;
      fields_snapshot: unknown[];
      created_at: string;
      created_by: string | null;
    };

    return {
      id: row.id,
      version: row.version_number,
      name: row.name,
      description: row.description,
      icon: row.icon,
      settings: row.settings ?? {},
      fields: row.fields_snapshot ?? [],
      created_at: row.created_at,
    };
  }

  /**
   * Restore a version onto the live form (content only — the RPC never touches
   * status/is_template), then record the restored state as a new version so the
   * history stays append-only and reversible.
   */
  async restore(
    formId: string,
    versionId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
    expectedVersion: number,
  ) {
    // 404 early if the version is gone (clearer than the RPC's race guard).
    await this.getOne(formId, versionId, spaceId, organizationId);

    const { data, error } = (await this.client.rpc(
      'restore_form_builder_version',
      {
        p_form_id: formId,
        p_version_id: versionId,
        p_space_id: spaceId,
        p_organization_id: organizationId,
        p_user_id: userId,
        p_expected_version: expectedVersion,
      },
    )) as {
      data: Record<string, unknown> | null;
      error: { code?: string; message: string } | null;
    };

    if (error) {
      if (error.code === 'P0001' || /version/i.test(error.message))
        throw new ConflictException(
          'Stale version — reload the builder and retry',
        );
      if (error.code === 'PGRST116')
        throw new NotFoundException('Form not found');
      throw new BadRequestException(error.message);
    }

    // NO captureVersion here, deliberately. Restoring is a READ of history, not an edit of it:
    // selecting v4 loads v4 into the builder and leaves the list exactly as it was, so v5/v6 stay
    // available to select afterwards. Capturing on restore made the list grow by one every time a
    // user browsed a version, each new row a duplicate of the one they had just selected, and with
    // RETENTION = 100 that churn eventually evicted the oldest real versions.
    //
    // History is still captured on every SAVE (form-builder-fields.controller.ts), so edits made
    // after a restore are recorded as normal.

    return data;
  }
}
