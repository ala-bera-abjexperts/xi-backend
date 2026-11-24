/**
 * @fileoverview Single source of truth for WHICH custom fields a space's wiki
 * accepts values for.
 *
 * Wiki custom-field availability is governed by `wiki_field_assignments`
 * (space-scoped), NOT by `custom_fields.contexts` (org-wide). The read path is
 * `FieldGroupsService.getWikiAssignments` / `flattenWikiAssignments`
 * (frontend `useWikiFieldAssignments.ts`); keep the three in sync.
 *
 * Historical note: this replaces a `contexts.includes('wiki')` gate that could
 * never pass — nothing in the product ever writes 'wiki' into that column, so
 * every custom-field save on a wiki page was rejected.
 *
 * @module src/wiki/wiki-field-keys.service
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

/** Shape of the trimmed assignment rows this resolver selects. */
interface AssignmentKeyRow {
  assignment_type: 'group' | 'field';
  custom_field?: { field_key: string } | null;
  field_group?: {
    fields?: Array<{ custom_field?: { field_key: string } | null }> | null;
  } | null;
}

@Injectable()
export class WikiFieldKeysService {
  private static readonly ASSIGNMENTS = 'wiki_field_assignments';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Every custom-field `field_key` reachable from a space's wiki field
   * assignments — standalone assignments plus the members of assigned groups.
   *
   * Deliberately does NOT filter `is_hidden` / `is_active` / `is_deleted`.
   * Those are *display* filters; applying them to a write gate would lock a
   * user out of saving unrelated fields whenever an admin hides or deactivates
   * one. (It also sidesteps the `.eq('is_deleted', false)` NULL-blindness that
   * the old gate had.)
   *
   * @returns The set of accepted keys. Empty when the space has no assignments.
   */
  async getAssignedFieldKeys(
    organizationId: string,
    spaceId: string,
  ): Promise<Set<string>> {
    const keys = new Set<string>();

    if (!organizationId || !spaceId) return keys;

    const { data, error } = await this.client
      .from(WikiFieldKeysService.ASSIGNMENTS)
      .select(
        'assignment_type, custom_field:custom_fields(field_key), field_group:field_groups(fields:field_group_fields(custom_field:custom_fields(field_key)))',
      )
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId);
    if (error) throw new BadRequestException(error.message);

    for (const row of (data ?? []) as unknown as AssignmentKeyRow[]) {
      if (row.custom_field?.field_key) keys.add(row.custom_field.field_key);

      for (const member of row.field_group?.fields ?? []) {
        if (member.custom_field?.field_key) {
          keys.add(member.custom_field.field_key);
        }
      }
    }

    return keys;
  }

  /**
   * Rejects keys that are neither assigned to this space's wiki nor already
   * persisted on the row being written.
   *
   * `tolerated` (the keys already stored on the page) is what stops a single
   * stale key from permanently 400-ing every unrelated edit: callers PUT the
   * full value map, so without it one un-assigned legacy field would block the
   * whole page forever. The map can therefore only ever shrink toward legality.
   *
   * NOTE: if a cross-space page-move endpoint is ever added, this rule already
   * does the right thing — stored values keep saving, new values follow the
   * target space's assignments.
   *
   * @param label Noun used in the error message ('keys' vs 'sort key').
   */
  async assertKeysAllowed(
    organizationId: string,
    spaceId: string,
    keys: string[],
    tolerated?: Iterable<string>,
    label = 'keys',
  ): Promise<void> {
    if (keys.length === 0) return;

    const allowed = await this.getAssignedFieldKeys(organizationId, spaceId);
    const toleratedSet = new Set(tolerated ?? []);
    const unknown = keys.filter(
      (key) => !allowed.has(key) && !toleratedSet.has(key),
    );

    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown wiki custom field ${label} for this space: ${unknown.join(', ')}. ` +
          `Assign the field to this space's wiki before saving values.`,
      );
    }
  }
}
