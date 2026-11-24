/**
 * @fileoverview Task→task link lookups shared by the three "Linked to" filter
 * engines (XE-T532): the saved-filter SQL engine, the board view payload and
 * the automation trigger filter.
 *
 * Links count in either direction and for every relation type (a type cannot be
 * deleted while in use, and the relationships panel shows them all, so the
 * filter agrees with the panel). Only `task`→`task` rows are read, always
 * org-scoped. Lookups never throw: a failed chunk is logged and skipped, so a
 * filter degrades to fewer matches instead of failing the whole request.
 *
 * Also holds the per-request view check for a relationship's task/process side
 * (XE-T532 #4), shared by task relationships and wiki page links.
 *
 * @module src/tasks/task-links.util
 * @author Prince Jadiya
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PermissionsService } from '../permissions/permissions.service';

/** Ids per `.in()` request — large lists must never travel in one URL. */
const CHUNK_SIZE = 100;

function chunks(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    out.push(ids.slice(i, i + CHUNK_SIZE));
  }
  return out;
}

/**
 * Ids of the tasks each of `taskIds` is linked to, either direction.
 * Self-links are dropped; tasks with no links are absent from the map.
 */
export async function fetchLinkedTaskIds(
  client: SupabaseClient<any, any>,
  organizationId: string,
  taskIds: string[],
): Promise<Map<string, Set<string>>> {
  const wanted = new Set(taskIds);
  const result = new Map<string, Set<string>>();

  const add = (from: string, to: string) => {
    if (from === to || !wanted.has(from)) return;
    let set = result.get(from);
    if (!set) result.set(from, (set = new Set()));
    set.add(to);
  };

  for (const chunk of chunks(taskIds)) {
    const query = (column: 'source_id' | 'target_id') =>
      client
        .from('task_relationships')
        .select('source_id, target_id')
        .eq('organization_id', organizationId)
        .eq('source_type', 'task')
        .eq('target_type', 'task')
        .in(column, chunk);

    const responses = await Promise.all([
      query('source_id'),
      query('target_id'),
    ]);

    for (const { data, error } of responses) {
      if (error) {
        console.warn('Task link lookup failed for a chunk', error);
        continue;
      }
      for (const row of (data ?? []) as {
        source_id: string;
        target_id: string;
      }[]) {
        add(row.source_id, row.target_id);
        add(row.target_id, row.source_id);
      }
    }
  }

  return result;
}

/**
 * Keys of the given task ids, org-scoped; optionally only tasks whose space
 * (null = org-level) passes `include` (callers that show keys to a viewer pass
 * a {@link createLinkViewCheck}).
 */
export async function fetchTaskKeys(
  client: SupabaseClient<any, any>,
  organizationId: string,
  ids: string[],
  include?: (spaceId: string | null) => Promise<boolean>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  for (const chunk of chunks(ids)) {
    const { data, error } = await client
      .from('tasks')
      .select('id, key, space_id')
      .eq('organization_id', organizationId)
      .in('id', chunk);
    if (error) {
      console.warn('Task key lookup failed for a chunk', error);
      continue;
    }
    for (const row of (data ?? []) as {
      id: string;
      key: string | null;
      space_id: string | null;
    }[]) {
      if (row.key && (!include || (await include(row.space_id)))) {
        result.set(row.id, row.key);
      }
    }
  }

  return result;
}

type LinkViewPermissions = Pick<
  PermissionsService,
  'getUserSpacePermissions' | 'getUserEffectivePermissions'
>;

/**
 * Returns "may this viewer see a linked task/process in `spaceId`?". A space
 * side needs membership plus the space view permission; an org-level side (no
 * space) follows org `can_view_tasks`, as `resolveAccessibleTaskSpaceIds` does.
 * Lookups are cached per space for the life of the returned function. No
 * viewer, no permission service or a failed (logged) lookup answers false,
 * i.e. fails closed.
 */
export function createLinkViewCheck(
  permissions: LinkViewPermissions | undefined,
  organizationId: string,
  userId: string | undefined,
): (
  spaceId: string | null,
  permission: 'view_tasks' | 'view_processes',
) => Promise<boolean> {
  const bySpace = new Map<
    string,
    Promise<Awaited<
      ReturnType<LinkViewPermissions['getUserSpacePermissions']>
    > | null>
  >();
  let orgLevel: Promise<boolean> | undefined;

  return async (spaceId, permission) => {
    if (!permissions || !userId) return false;
    if (!spaceId) {
      orgLevel ??= permissions
        .getUserEffectivePermissions(userId, organizationId)
        .then((r) => r.effective_permissions?.can_view_tasks === true)
        .catch((error: unknown) => {
          console.warn('Link view check: org permission lookup failed', error);
          return false;
        });
      return orgLevel;
    }
    let resolved = bySpace.get(spaceId);
    if (!resolved) {
      resolved = permissions
        .getUserSpacePermissions(userId, organizationId, spaceId)
        .catch((error: unknown) => {
          console.warn(
            `Link view check: space ${spaceId} permission lookup failed`,
            error,
          );
          return null;
        });
      bySpace.set(spaceId, resolved);
    }
    const r = await resolved;
    return !!r && r.isMember && r.permissions[permission] === true;
  };
}
