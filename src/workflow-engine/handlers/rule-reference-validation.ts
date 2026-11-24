/**
 * @fileoverview Shared validation for external references collected from
 * workflow rule configs.
 * @module src/workflow-engine/handlers/rule-reference-validation
 * @author Rajbha Manek
 */

import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';

import type { IRuleReference } from './handler.types';

interface RuleReferenceLookupResult {
  data: Array<Record<string, string>> | null;
  error: { message: string } | null;
}

interface RuleReferenceQuery extends PromiseLike<RuleReferenceLookupResult> {
  or(filter: string): RuleReferenceQuery;
}

interface RuleReferenceClient {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        in(column: string, values: string[]): RuleReferenceQuery;
      };
    };
  };
}

// kind -> table to verify the referenced UUID against. `null` means the
// reference is not a UUID (permission keys, etc.) and no DB lookup applies.
const REFERENCE_TABLE_MAP: Record<
  IRuleReference['kind'],
  { table: string; idColumn: string } | null
> = {
  field: { table: 'custom_fields', idColumn: 'id' },
  field_group: { table: 'field_groups', idColumn: 'id' },
  // `users` has no organization_id column — org membership lives in
  // organization_members(organization_id, user_id), whose user_id FKs to
  // users.id (the same id space rule user-references use). Verify there.
  user: { table: 'organization_members', idColumn: 'user_id' },
  group: { table: 'user_groups', idColumn: 'id' },
  role: { table: 'custom_roles', idColumn: 'id' },
  status: { table: 'task_statuses', idColumn: 'id' },
  resolution: { table: 'resolutions', idColumn: 'id' },
  category: { table: 'status_categories', idColumn: 'id' },
  // Permissions are string keys (e.g. 'can_edit_tasks'), not UUIDs.
  permission: null,
};

// Tables above that soft-delete rather than hard-delete. A soft-deleted row
// keeps its `id`, so without this filter a workflow can be saved pointing at a
// deleted field and pass validation. Kept in sync with the same set in
// workflow-health.service.ts, which applies the identical guard at lint time.
// The other REFERENCE_TABLE_MAP tables have no `is_deleted` column at all.
const SOFT_DELETE_REF_TABLES = new Set([
  'custom_fields',
  'field_groups',
  'user_groups',
  'custom_roles',
]);

/**
 * Batch-verify every rule reference belongs to the calling organization.
 *
 * @param client - Supabase client used for read checks.
 * @param organizationId - Organization boundary for referenced entities.
 * @param refs - References returned by rule handlers.
 * @throws BadRequestException when a lookup query fails.
 * @throws UnprocessableEntityException when a referenced entity is missing or
 * belongs to another organization.
 */
export async function assertRuleReferencesInOrganization(
  client: unknown,
  organizationId: string,
  refs: IRuleReference[],
): Promise<void> {
  if (refs.length === 0) return;
  const lookupClient = client as RuleReferenceClient;

  const byKind = new Map<IRuleReference['kind'], Set<string>>();

  for (const ref of refs) {
    const set = byKind.get(ref.kind) ?? new Set<string>();

    set.add(ref.id);
    byKind.set(ref.kind, set);
  }

  const missing: { kind: string; id: string }[] = [];

  for (const [kind, idSet] of byKind) {
    const map = REFERENCE_TABLE_MAP[kind];

    if (!map) continue;
    const { table, idColumn } = map;
    const ids = Array.from(idSet);
    let q = lookupClient
      .from(table)
      .select(idColumn)
      .eq('organization_id', organizationId)
      .in(idColumn, ids);

    // `is_deleted` is nullable, so match the house idiom rather than
    // `.eq(false)` — a NULL row under `.eq(false)` would drop out and be
    // rejected as missing, blocking a save that is actually valid.
    if (SOFT_DELETE_REF_TABLES.has(table)) {
      q = q.or('is_deleted.is.null,is_deleted.eq.false');
    }
    const r = await q;

    if (r.error) throw new BadRequestException(r.error.message);
    const found = new Set(
      (r.data ?? []).map((x: Record<string, string>) => x[idColumn]),
    );

    for (const id of ids) {
      if (!found.has(id)) missing.push({ kind, id });
    }
  }

  if (missing.length > 0) {
    throw new UnprocessableEntityException({
      message: 'Rule references entities not in your organization',
      data: { missing },
    });
  }
}
