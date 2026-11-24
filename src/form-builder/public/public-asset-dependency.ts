import type { SupabaseClient } from '@supabase/supabase-js';

// Keep in lockstep with the frontend `src/views/form-builder/public/public-asset-dependency.ts`.

/** The only dependency detail served publicly: the parent FORM field key, never schema/type ids. */
export const ASSET_DEPENDS_ON_RULE = 'asset_depends_on_field';

export interface PublicAssetOption {
  label: string;
  value: string;

  // Served parent options this option is linked to (dependent fields only).
  parent_ids?: string[];
}

/** Served options per field key, plus the parent field key each dependent field narrows by. */
export type PublicAssetOptions = Map<string, PublicAssetOption[]> & {
  dependsOn?: Map<string, string>;
};

export interface IAssetDependency {
  sourceKey: string;
  via: string;
  direction: 'child_to_parent' | 'parent_to_child';
}

const isAssetType = (type: string) =>
  type === 'asset' || type === 'asset_multi';

/** A usable `depends_on`: both halves are needed, exactly as the in-app buildAssetQuery requires. */
export function readAssetDependency(
  cfg: Record<string, unknown> | undefined,
): IAssetDependency | null {
  const dep = cfg?.depends_on as Record<string, unknown> | undefined;
  const sourceKey =
    typeof dep?.source_field_key === 'string' ? dep.source_field_key : '';
  const via =
    typeof dep?.via_attribute_key === 'string' ? dep.via_attribute_key : '';

  if (!sourceKey || !via) return null;

  return {
    sourceKey,
    via,
    direction:
      dep?.direction === 'parent_to_child'
        ? 'parent_to_child'
        : 'child_to_parent',
  };
}

/**
 * Parent object ids per option id, linked through the `via` reference attribute — the same link the
 * picker's `attr_<via>` / `refby_<via>` filter follows. Two queries per field; null when a lookup failed.
 */
export async function loadAssetParentIds(
  client: SupabaseClient<any, any>,
  scope: { organizationId: string; spaceId: string; schemaId: string },
  dependency: IAssetDependency,
  optionIds: string[],
): Promise<Map<string, string[]> | null> {
  const links = new Map<string, string[]>();

  if (!optionIds.length) return links;

  // Scoped like the picker's filterable fields: the child's schema, org and space.
  const { data: attrs, error: attrError } = await client
    .from('asset_object_type_attributes')
    .select('id')
    .eq('organization_id', scope.organizationId)
    .eq('space_id', scope.spaceId)
    .eq('schema_id', scope.schemaId)
    .eq('field_key', dependency.via);

  if (attrError) return null;

  const attributeIds = ((attrs ?? []) as Array<{ id: string }>).map(
    (a) => a.id,
  );

  if (!attributeIds.length) return links;

  // child_to_parent: the option holds the reference; parent_to_child: the parent does.
  const optionIsSource = dependency.direction === 'child_to_parent';
  const { data: refs, error: refError } = await client
    .from('asset_object_references')
    .select('source_object_id, target_object_id')
    .eq('organization_id', scope.organizationId)
    .eq('space_id', scope.spaceId)
    .in('attribute_id', attributeIds)
    .in(optionIsSource ? 'source_object_id' : 'target_object_id', optionIds);

  if (refError) return null;

  for (const ref of (refs ?? []) as Array<{
    source_object_id: string;
    target_object_id: string;
  }>) {
    const option = optionIsSource ? ref.source_object_id : ref.target_object_id;
    const parent = optionIsSource ? ref.target_object_id : ref.source_object_id;

    links.set(option, [...(links.get(option) ?? []), parent]);
  }

  return links;
}

/** Rules to sanitize for a public asset field: the computed parent key replaces any stored value. */
export function withAssetDependsOnRule(
  rules: unknown,
  field: { field_key: string; field_type: string },
  assetOptions?: PublicAssetOptions,
): unknown {
  if (!isAssetType(field.field_type)) return rules;

  const parentKey = assetOptions?.dependsOn?.get(field.field_key);
  const isObject =
    !!rules && typeof rules === 'object' && !Array.isArray(rules);

  if (!parentKey) {
    if (!isObject || !(ASSET_DEPENDS_ON_RULE in rules)) return rules;

    const copy = { ...(rules as Record<string, unknown>) };

    delete copy[ASSET_DEPENDS_ON_RULE];

    return copy;
  }

  return {
    ...(isObject ? (rules as Record<string, unknown>) : {}),
    [ASSET_DEPENDS_ON_RULE]: parentKey,
  };
}

/**
 * Removes dependent asset answers not linked to the submitted parent answer, down the chain.
 * Mutates `clean`; returns how many answers were dropped.
 */
export function dropUnlinkedAssetAnswers(
  clean: Record<string, unknown>,
  assetOptions: PublicAssetOptions,
): number {
  let dropped = 0;
  let changed = true;

  // Repeat so a dropped parent also drops a child checked before it.
  while (changed) {
    changed = false;

    for (const [key, sourceKey] of assetOptions.dependsOn ?? []) {
      if (!(key in clean)) continue;

      const parent = clean[sourceKey];
      const ids = Array.isArray(clean[key]) ? clean[key] : [clean[key]];
      const options = assetOptions.get(key) ?? [];
      const linked =
        typeof parent === 'string' &&
        ids.every((id) =>
          options.some(
            (o) => o.value === id && !!o.parent_ids?.includes(parent),
          ),
        );

      if (linked) continue;

      delete clean[key];
      dropped++;
      changed = true;
    }
  }

  return dropped;
}
