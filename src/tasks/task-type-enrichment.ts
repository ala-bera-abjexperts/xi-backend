import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Attach a resolved `task_type` object to each task row (XE-T587).
 *
 * Mirrors the enrichment the ordinary task read path performs, so a task rendered from a
 * saved view shows the same name, icon and colour as one rendered from the standard table.
 * A space with no config of its own falls back to the org-level default; an id that matches
 * no configured level degrades to a capitalized id rather than a dash.
 */
export async function enrichWithTaskTypes(
  client: SupabaseClient<any, any>,
  rows: Record<string, any>[],
  organizationId: string,
): Promise<Record<string, any>[]> {
  const spaceIds = [
    ...new Set(
      rows
        .map((row) => row.space_id as string | null)
        .filter((id): id is string => !!id),
    ),
  ];

  if (spaceIds.length === 0) return rows;

  const { data: configRows } = await client
    .from('task_hierarchy_configurations')
    .select('space_id, config')
    .eq('organization_id', organizationId);

  const all = (configRows ?? []) as {
    space_id: string | null;
    config: unknown;
  }[];

  const orgDefault = all.find((row) => row.space_id === null)?.config;
  const bySpace = new Map(
    all
      .filter((row) => row.space_id !== null)
      .map((row) => [row.space_id as string, row.config]),
  );

  return rows.map((row) => {
    const config = (bySpace.get(row.space_id as string) ?? orgDefault) as
      | { levels?: { id?: string }[] }
      | undefined;

    const taskTypeId = row.task_type_id as string | null;

    const match = config?.levels?.find((level) => level.id === taskTypeId);

    return {
      ...row,
      task_type:
        match ??
        (taskTypeId
          ? {
              id: taskTypeId,
              name: taskTypeId.charAt(0).toUpperCase() + taskTypeId.slice(1),
              color: null,
              text_color: null,
              icon: null,
            }
          : null),
    };
  });
}
