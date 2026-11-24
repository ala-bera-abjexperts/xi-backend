import type { SupabaseClient } from '@supabase/supabase-js';

// Keep in lockstep with the frontend `src/models/asset-field-config.model.ts` resolveInheritedAssetConfig.

const CUSTOM_TASK_FIELD_RE = /^custom:([A-Za-z0-9_-]+)$/;

const isAssetType = (type: unknown) =>
  type === 'asset' || type === 'asset_multi';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export interface IAssetConfigField {
  field_key: string;
  field_type: string;
  validation_rules?: unknown;
}

export interface IAssetCustomField extends IAssetConfigField {
  space_id?: string | null;
  is_active?: boolean | null;
  is_deleted?: boolean | null;
  contexts?: unknown;
}

export interface IInheritedAssetConfig {
  config: Record<string, unknown> | undefined;
  inherited: boolean;
  customField?: IAssetCustomField;
  droppedDependencyKey?: string;
}

interface IInheritContext {
  customFields: IAssetCustomField[];
  integrationEnabled: boolean;
  targetSpaceId?: string | null;
}

function ownConfig(
  field: IAssetConfigField,
): Record<string, unknown> | undefined {
  const asset = asRecord(field.validation_rules).asset;

  return asset && typeof asset === 'object' && !Array.isArray(asset)
    ? (asset as Record<string, unknown>)
    : undefined;
}

function mappedCustomKey(field: IAssetConfigField): string | null {
  const taskField = asRecord(field.validation_rules).task_field;
  const match =
    typeof taskField === 'string' ? CUSTOM_TASK_FIELD_RE.exec(taskField) : null;

  return match ? match[1] : null;
}

/**
 * The asset config a form element really uses: a mapped asset custom field's config is
 * authoritative while ticket integration is on; otherwise the element's own config stands.
 */
export function resolveInheritedAssetConfig(
  input: IInheritContext & {
    field: IAssetConfigField;
    fields: IAssetConfigField[];
  },
): IInheritedAssetConfig {
  const { field, fields, customFields, integrationEnabled, targetSpaceId } =
    input;
  const own: IInheritedAssetConfig = {
    config: ownConfig(field),
    inherited: false,
  };
  const key =
    isAssetType(field.field_type) && integrationEnabled
      ? mappedCustomKey(field)
      : null;

  if (!key) return own;

  const live = customFields.filter(
    (row) =>
      row.field_key === key &&
      row.is_active !== false &&
      row.is_deleted !== true,
  );
  const customField =
    live.find((row) => !!targetSpaceId && row.space_id === targetSpaceId) ??
    live.find((row) => row.space_id == null);
  const cfConfig =
    customField && isAssetType(customField.field_type)
      ? ownConfig(customField)
      : undefined;

  if (!customField || !cfConfig?.schema_id) return own;

  const config: Record<string, unknown> = {
    ...cfConfig,
    space_id: cfConfig.space_id || targetSpaceId || undefined,
  };
  const result: IInheritedAssetConfig = {
    config,
    inherited: true,
    customField,
  };

  if (!cfConfig.depends_on) return result;

  // The custom field's parent is another custom field; follow the form element mapped to it.
  const dependsOn = asRecord(cfConfig.depends_on);
  const sourceKey =
    typeof dependsOn.source_field_key === 'string'
      ? dependsOn.source_field_key
      : '';
  let parent: IAssetConfigField | undefined;

  for (const other of fields) {
    if (
      sourceKey &&
      other.field_key !== field.field_key &&
      asRecord(other.validation_rules).task_field === `custom:${sourceKey}`
    )
      parent = other;
  }

  if (parent?.field_type === 'asset') {
    config.depends_on = { ...dependsOn, source_field_key: parent.field_key };
  } else {
    delete config.depends_on;
    result.droppedDependencyKey = sourceKey;
  }

  return result;
}

/** The fields with every inherited asset config applied; untouched fields keep their identity. */
export function applyInheritedAssetConfigs<T extends IAssetConfigField>(
  fields: T[],
  context: IInheritContext & { lookupFields?: IAssetConfigField[] },
): T[] {
  return fields.map((field) => {
    const resolved = resolveInheritedAssetConfig({
      ...context,
      field,
      fields: context.lookupFields ?? fields,
    });

    if (!resolved.inherited) return field;

    return {
      ...field,
      validation_rules: {
        ...asRecord(field.validation_rules),
        asset: resolved.config,
      },
    };
  });
}

/**
 * Loads the custom fields asset elements are mapped to — no query unless one is mapped and
 * integration is on. Null when the lookup failed.
 */
export async function loadInheritableAssetCustomFields(
  client: SupabaseClient<any, any>,
  orgId: string,
  targetSpaceId: string | null | undefined,
  fields: IAssetConfigField[],
  integrationEnabled: boolean,
): Promise<IAssetCustomField[] | null> {
  const keys = integrationEnabled
    ? [
        ...new Set(
          fields
            .filter((field) => isAssetType(field.field_type))
            .map(mappedCustomKey)
            .filter((key): key is string => !!key),
        ),
      ]
    : [];

  if (!keys.length) return [];

  const { data, error } = await client
    .from('custom_fields')
    .select(
      'field_key, field_type, validation_rules, space_id, is_active, is_deleted, contexts',
    )
    .eq('organization_id', orgId)
    .in('field_key', keys);

  if (error) return null;

  // Only the org-wide row and the target space's own row can apply.
  return ((data ?? []) as IAssetCustomField[]).filter(
    (row) => row.space_id == null || row.space_id === targetSpaceId,
  );
}
