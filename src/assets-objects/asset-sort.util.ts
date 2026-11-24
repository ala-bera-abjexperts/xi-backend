/**
 * Shared sort handling for the asset schema list and the object-type tree.
 *
 * The column name reaches PostgREST's `.order()`, so it is matched against an allow-list rather
 * than passed through — an unchecked value here would let a caller order by, or inject around,
 * an arbitrary column.
 */

export type AssetSortField =
  | 'name'
  | 'created_at'
  | 'updated_at'
  | 'sort_order';
export type AssetSortDirection = 'asc' | 'desc';

export interface AssetSort {
  field: AssetSortField;
  ascending: boolean;
}

const ALLOWED_FIELDS: readonly AssetSortField[] = [
  'name',
  'created_at',
  'updated_at',
  'sort_order',
];

/**
 * Returns null when nothing usable was supplied, so each caller keeps its own historical default
 * instead of this helper inventing one — the schema list and the type tree order differently.
 *
 * An unrecognised field is treated as absent rather than throwing: a stale bookmark or an older
 * client should fall back to the default ordering, not fail the request.
 */
export function normalizeAssetSort(
  field?: string,
  direction?: string,
): AssetSort | null {
  if (!field) return null;

  const match = ALLOWED_FIELDS.find((f) => f === field);

  if (!match) return null;

  return { field: match, ascending: direction !== 'desc' };
}
