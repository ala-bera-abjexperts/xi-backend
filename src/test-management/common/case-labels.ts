import type { Logger } from '@nestjs/common';

import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { tmDbError } from '../test-management-errors';

type AdminClient = ReturnType<SupabaseAdminService['getClient']>;

// perCase mirrors test_cases_labels_check; a label is one word.
export const TEST_CASE_LABEL_LIMITS = { perCase: 50, length: 100 } as const;

const ID_CHUNK = 100;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/g;

/** Trimmed, without a leading @, spaces turned into _, cut to length, without duplicates, at most 50. */
export function cleanLabels(values: readonly unknown[]): string[] {
  const labels = values
    .filter((v): v is string => typeof v === 'string')
    .map((v) =>
      v
        .replace(CONTROL, '')
        .trim()
        .replace(/^@+/, '')
        .replace(/\s+/g, '_')
        .slice(0, TEST_CASE_LABEL_LIMITS.length),
    )
    .filter((v) => v !== '');

  return [...new Set(labels)].slice(0, TEST_CASE_LABEL_LIMITS.perCase);
}

/** Adds labels to active cases of the space; labels already there stay. */
export async function addCaseLabels(
  client: AdminClient,
  logger: Logger,
  organizationId: string,
  spaceId: string,
  actorId: string,
  entries: { caseId: string; labels: string[] }[],
): Promise<void> {
  const wanted = new Map<string, string[]>();

  for (const entry of entries) {
    const labels = cleanLabels(entry.labels);

    if (labels.length === 0) continue;

    wanted.set(entry.caseId, [...(wanted.get(entry.caseId) ?? []), ...labels]);
  }

  const ids = [...wanted.keys()];

  // Cases ending with the same labels are written together.
  const groups = new Map<string, { labels: string[]; ids: string[] }>();

  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await client
      .from('test_cases')
      .select('id, labels')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_archived', false)
      .in('id', ids.slice(i, i + ID_CHUNK));

    if (error) throw tmDbError(logger, 'load case labels', error);

    for (const row of (data ?? []) as {
      id: string;
      labels: string[] | null;
    }[]) {
      const current = row.labels ?? [];
      const next = cleanLabels([...current, ...(wanted.get(row.id) ?? [])]);

      if (next.length === current.length) continue;

      const key = JSON.stringify(next);
      const group = groups.get(key) ?? { labels: next, ids: [] };

      group.ids.push(row.id);
      groups.set(key, group);
    }
  }

  for (const group of groups.values()) {
    for (let i = 0; i < group.ids.length; i += ID_CHUNK) {
      const { error } = await client
        .from('test_cases')
        .update({ labels: group.labels, updated_by: actorId })
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .eq('is_archived', false)
        .in('id', group.ids.slice(i, i + ID_CHUNK));

      if (error) throw tmDbError(logger, 'save case labels', error);
    }
  }
}
