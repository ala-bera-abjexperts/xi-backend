import { createHash } from 'crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';

const TEMPLATES_TABLE = 'document_templates';

// Keep at most this many versions per template; older ones are pruned on capture.
const RETENTION = 100;

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

type TemplateRow = {
  id: string;
  name: string | null;
  description: string | null;
  mode: string | null;
  source_entity: string | null;
  definition: Record<string, unknown> | null;
};

type VersionRow = {
  id: string;
  version_number: number;
  name: string | null;
  description: string | null;
  mode: string | null;
  source_entity: string | null;
  definition_snapshot: Record<string, unknown>;
  content_hash?: string | null;
  created_at: string;
  created_by: string | null;
};

/**
 * Append-only version history for document templates. Snapshots the template
 * (meta + definition) into `document_template_versions`; restore re-applies a
 * snapshot to the live row with a single version-locked UPDATE (the DB trigger
 * bumps `document_templates.version`).
 *
 * Capture is best-effort — it must never break the save it hangs off.
 */
@Injectable()
export class DocumentTemplateVersionsService {
  private readonly logger = new Logger(DocumentTemplateVersionsService.name);

  private static readonly TABLE_NAME = 'document_template_versions';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Snapshot the current live template as a new version. Best-effort — NEVER
   * throws: a versioning failure must never break the save it hangs off.
   * Deduped against ALL existing versions' content hash unless `force` (the
   * manual "Save version"). Returns the inserted row, or null when skipped.
   */
  async captureVersion(
    templateId: string,
    organizationId: string,
    userId: string,
    options: { force?: boolean } = {},
  ): Promise<Record<string, unknown> | null> {
    try {
      const templateResult = (await this.client
        .from(TEMPLATES_TABLE)
        .select('id, name, description, mode, source_entity, definition')
        .eq('id', templateId)
        .eq('organization_id', organizationId)
        .maybeSingle()) as { data: TemplateRow | null };

      const template = templateResult.data;

      if (!template) return null;

      const snapshot = {
        name: template.name,
        description: template.description,
        mode: template.mode,
        source_entity: template.source_entity,
        definition: template.definition ?? {},
      };

      const contentHash = createHash('sha256')
        .update(JSON.stringify(canonicalize(snapshot)))
        .digest('hex');

      if (!options.force) {
        // Deduped against EVERY version of this template, not just the newest one. Comparing only against
        // the newest missed the case this exists for: restore v4 while v6 is newest, press Save, and
        // the hash differs from v6 so a v7 gets written that is byte-identical to v4. Saving content
        // that is already in the history should never add a row, whichever row it matches.
        const duplicateResult = (await this.client
          .from(DocumentTemplateVersionsService.TABLE_NAME)
          .select('id')
          .eq('template_id', templateId)
          .eq('organization_id', organizationId)
          .eq('content_hash', contentHash)
          .limit(1)
          .maybeSingle()) as { data: { id: string } | null };

        if (duplicateResult.data) {
          return null; // this exact content is already a version — nothing new to record
        }
      }

      let inserted: Record<string, unknown> | null = null;

      // Insert with a fresh sequential number; the UNIQUE(template_id, version_number)
      // guards the rare concurrent-capture race — retry once.
      for (let attempt = 0; attempt < 2; attempt++) {
        const maxResult = (await this.client
          .from(DocumentTemplateVersionsService.TABLE_NAME)
          .select('version_number')
          .eq('template_id', templateId)
          .order('version_number', { ascending: false })
          .limit(1)
          .maybeSingle()) as { data: { version_number: number } | null };

        const nextNumber = (maxResult.data?.version_number ?? 0) + 1;

        const insertResult = (await this.client
          .from(DocumentTemplateVersionsService.TABLE_NAME)
          .insert({
            template_id: templateId,
            organization_id: organizationId,
            version_number: nextNumber,
            name: snapshot.name,
            description: snapshot.description,
            mode: snapshot.mode,
            source_entity: snapshot.source_entity,
            definition_snapshot: snapshot.definition,
            content_hash: contentHash,
            created_by: userId,
          })
          .select()
          .maybeSingle()) as {
          data: Record<string, unknown> | null;
          error: { code?: string; message: string } | null;
        };

        if (!insertResult.error) {
          inserted = insertResult.data;

          break;
        }
        if (insertResult.error.code !== '23505' || attempt === 1) {
          throw new Error(insertResult.error.message);
        }
      }

      await this.pruneOld(templateId);

      return inserted;
    } catch (err) {
      // Best-effort: log and swallow so the surrounding save always succeeds.
      this.logger.warn(
        `captureVersion failed for template ${templateId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );

      return null;
    }
  }

  /** Keep only the most recent RETENTION versions for a template. Best-effort. */
  private async pruneOld(templateId: string): Promise<void> {
    const staleResult = (await this.client
      .from(DocumentTemplateVersionsService.TABLE_NAME)
      .select('id')
      .eq('template_id', templateId)
      .order('created_at', { ascending: false })
      .range(RETENTION, RETENTION + 999)) as { data: { id: string }[] | null };

    const stale = (staleResult.data ?? []).map((r) => r.id);

    if (stale.length === 0) return;

    await this.client
      .from(DocumentTemplateVersionsService.TABLE_NAME)
      .delete()
      .in('id', stale);
  }

  /** Version rows for a template (newest first), WITHOUT the heavy definition_snapshot. */
  async listVersions(templateId: string, organizationId: string) {
    const listResult = (await this.client
      .from(DocumentTemplateVersionsService.TABLE_NAME)
      .select(
        'id, version_number, name, description, mode, source_entity, content_hash, created_by, created_at',
      )
      .eq('template_id', templateId)
      .eq('organization_id', organizationId)
      .order('version_number', { ascending: false })) as {
      data: Omit<VersionRow, 'definition_snapshot'>[] | null;
      error: { message: string } | null;
    };

    if (listResult.error)
      throw new BadRequestException(listResult.error.message);

    const rows = listResult.data ?? [];

    const actorIds = [
      ...new Set(rows.map((r) => r.created_by).filter(Boolean)),
    ] as string[];
    const actorsById = new Map<
      string,
      { id: string; first_name: string; last_name: string; email: string }
    >();

    if (actorIds.length > 0) {
      const usersResult = (await this.client
        .from('users')
        .select('id, first_name, last_name, email')
        .in('id', actorIds)) as {
        data:
          | {
              id: string;
              first_name: string;
              last_name: string;
              email: string;
            }[]
          | null;
      };

      for (const u of usersResult.data ?? []) actorsById.set(u.id, u);
    }

    return rows.map((r) => ({
      id: r.id,
      version_number: r.version_number,
      name: r.name,
      description: r.description,
      mode: r.mode,
      source_entity: r.source_entity,
      created_at: r.created_at,
      actor: r.created_by ? (actorsById.get(r.created_by) ?? null) : null,
    }));
  }

  /** One version WITH its definition_snapshot (for the read-only preview). */
  async getVersion(
    templateId: string,
    versionId: string,
    organizationId: string,
  ): Promise<VersionRow> {
    const result = (await this.client
      .from(DocumentTemplateVersionsService.TABLE_NAME)
      .select(
        'id, version_number, name, description, mode, source_entity, definition_snapshot, created_at, created_by',
      )
      .eq('id', versionId)
      .eq('template_id', templateId)
      .eq('organization_id', organizationId)
      .maybeSingle()) as {
      data: VersionRow | null;
      error: { message: string } | null;
    };

    if (result.error) throw new BadRequestException(result.error.message);
    if (!result.data) throw new NotFoundException('Version not found');

    return result.data;
  }

  /**
   * Restore a version onto the live template with a single version-locked
   * UPDATE (the DB trigger bumps `document_templates.version`, so a concurrent
   * edit between read and restore makes this a 409 instead of a silent
   * overwrite).
   *
   * NO captureVersion here, deliberately — restoring is a READ of history, not
   * an edit of it (matches the form-builder behaviour).
   */
  async restoreVersion(
    templateId: string,
    versionId: string,
    organizationId: string,
    userId: string,
    expectedVersion: number,
  ) {
    // 404 early if the version is gone (clearer than the update's race guard).
    const version = await this.getVersion(
      templateId,
      versionId,
      organizationId,
    );

    // captureVersion stores the definition DIRECTLY in definition_snapshot
    // (not wrapped as { definition }), so unwrap defensively for both shapes.
    const snapshot = version.definition_snapshot as {
      definition?: Record<string, unknown>;
    } | null;

    const snapshotDefinition = (snapshot?.definition ??
      snapshot ??
      {}) as Record<string, unknown>;

    // The snapshot's mode column can be null on legacy rows — fall back to the
    // live template's mode so the columns never disagree after a restore.
    const liveResult = (await this.client
      .from(TEMPLATES_TABLE)
      .select('mode')
      .eq('id', templateId)
      .eq('organization_id', organizationId)
      .maybeSingle()) as { data: { mode: string | null } | null };

    const nextMode = version.mode ?? liveResult.data?.mode ?? null;

    const updateResult = (await this.client
      .from(TEMPLATES_TABLE)
      .update({
        definition: snapshotDefinition,
        mode: nextMode,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', templateId)
      .eq('organization_id', organizationId)
      .eq('version', expectedVersion)
      .eq('is_archived', false)
      .select()
      .maybeSingle()) as {
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    };

    if (updateResult.error) {
      throw new BadRequestException(updateResult.error.message);
    }
    if (!updateResult.data) {
      throw new ConflictException(
        'Stale version — reload the template and retry',
      );
    }

    return updateResult.data;
  }
}
