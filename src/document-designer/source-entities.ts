/**
 * @fileoverview Registry of the space modules a document template can export.
 * `source_entity` values are the `space_modules.module_type` enum labels, so a
 * template's source is the module itself — no second vocabulary to map.
 *
 * `filterSourceType` is the split that matters: modules the saved-filters query
 * engine has a table config for are selected THROUGH it (it enforces per-user
 * space permissions). The rest have no engine support, so the resolver reads
 * their table directly and must scope by `viewPermission` itself — the
 * service-role client bypasses RLS.
 * @module src/document-designer/source-entities
 */

import type { DocumentSourceEntity } from './template-definition/template-definition.types';

export interface IDocumentSourceEntityConfig {
  key: DocumentSourceEntity;
  /** Table the module's records live in. */
  table: string;
  /** `space_permissions` key (`can_` prefix stripped) gating VIEW access. */
  viewPermission: string;
  /**
   * `source_type` the saved-filters engine accepts, or `null` when the module
   * has no engine table config (read directly, see module header).
   */
  filterSourceType: 'tasks' | 'processes' | 'wiki' | 'lists' | null;
  /** Column carrying the human-readable title. */
  titleColumn: string;
  /** Column carrying the human-readable key, when the module has one. */
  keyColumn: string | null;
  /**
   * Engine-backed modules only: the rule field an explicit-ids export scope is
   * translated into. The engine's field allowlist has no universal `id` entry,
   * so `'key'` means "look the keys up first, then filter by key"; `'id'` means
   * the entity maps `id` directly; `null` means an ids scope is unsupported and
   * is rejected rather than silently returning nothing.
   */
  engineIdRuleField: 'key' | 'id' | null;
  /** `custom_fields.contexts` value, or `null` when the module has none. */
  customFieldContext: string | null;
  /** `entityType` handed to the condition evaluator / render context. */
  itemEntityType: string;
  /**
   * Extra equality filters applied on top of the standard org/space scoping in
   * `selectDirect` (e.g. excluding non-leaf rows or soft-deleted rows a table
   * mixes in with the exportable ones). `undefined` for every entity that
   * doesn't need this — `selectDirect`'s query is unchanged when absent.
   */
  extraFilter?: Record<string, unknown>;
}

export const DOCUMENT_SOURCE_ENTITY_CONFIGS: IDocumentSourceEntityConfig[] = [
  {
    key: 'tasks',
    table: 'tasks',
    viewPermission: 'view_tasks',
    filterSourceType: 'tasks',
    titleColumn: 'summary',
    keyColumn: 'key',
    engineIdRuleField: 'key',
    customFieldContext: 'task',
    itemEntityType: 'task',
  },
  {
    key: 'processes',
    table: 'business_processes',
    viewPermission: 'view_processes',
    filterSourceType: 'processes',
    titleColumn: 'title',
    keyColumn: 'key',
    engineIdRuleField: 'key',
    customFieldContext: 'process',
    itemEntityType: 'process',
  },
  {
    key: 'wiki',
    table: 'wiki_pages',
    viewPermission: 'view_wiki_pages',
    filterSourceType: 'wiki',
    titleColumn: 'title',
    // wiki_pages has no `key` column — the slug is the readable identifier.
    keyColumn: 'slug',
    engineIdRuleField: 'id',
    customFieldContext: null,
    itemEntityType: 'wiki_page',
  },
  {
    key: 'lists',
    table: 'asset_items',
    viewPermission: 'view_lists',
    filterSourceType: 'lists',
    titleColumn: 'title',
    keyColumn: null,
    engineIdRuleField: null,
    customFieldContext: 'list_item',
    itemEntityType: 'list_item',
  },
  {
    key: 'dashboards',
    table: 'dashboards',
    viewPermission: 'view_dashboards',
    filterSourceType: null,
    titleColumn: 'name',
    keyColumn: null,
    engineIdRuleField: null,
    customFieldContext: null,
    itemEntityType: 'dashboard',
  },
  {
    key: 'boards',
    table: 'boards',
    viewPermission: 'view_boards',
    filterSourceType: null,
    titleColumn: 'name',
    keyColumn: 'board_key',
    engineIdRuleField: null,
    customFieldContext: null,
    itemEntityType: 'board',
  },
  {
    key: 'plans',
    table: 'plans',
    viewPermission: 'view_plans',
    filterSourceType: null,
    titleColumn: 'name',
    keyColumn: 'plan_key',
    engineIdRuleField: null,
    customFieldContext: null,
    itemEntityType: 'plan',
  },
  {
    key: 'automations',
    table: 'automations',
    viewPermission: 'view_automations',
    filterSourceType: null,
    titleColumn: 'name',
    keyColumn: null,
    engineIdRuleField: null,
    customFieldContext: null,
    itemEntityType: 'automation',
  },
  {
    key: 'assets',
    table: 'asset_objects',
    viewPermission: 'view_assets',
    filterSourceType: null,
    titleColumn: 'name',
    keyColumn: 'object_key',
    engineIdRuleField: null,
    customFieldContext: null,
    itemEntityType: 'asset_object',
  },
  {
    key: 'file_explorer',
    table: 'fe_nodes',
    viewPermission: 'view_file_explorer',
    filterSourceType: null,
    titleColumn: 'name',
    keyColumn: null,
    engineIdRuleField: null,
    customFieldContext: null,
    itemEntityType: 'file',
    extraFilter: { node_type: 'file', is_deleted: false },
  },
  {
    key: 'form_builder',
    table: 'form_builder',
    viewPermission: 'view_forms',
    filterSourceType: null,
    titleColumn: 'name',
    keyColumn: 'form_key',
    engineIdRuleField: null,
    customFieldContext: null,
    itemEntityType: 'form',
  },
];

export const DOCUMENT_SOURCE_ENTITIES: DocumentSourceEntity[] =
  DOCUMENT_SOURCE_ENTITY_CONFIGS.map((config) => config.key);

const BY_KEY = new Map<string, IDocumentSourceEntityConfig>(
  DOCUMENT_SOURCE_ENTITY_CONFIGS.map((config) => [config.key, config]),
);

export function isDocumentSourceEntity(
  value: unknown,
): value is DocumentSourceEntity {
  return typeof value === 'string' && BY_KEY.has(value);
}

/** Config for `key`, or `undefined` when it is not a known source entity. */
export function findSourceEntityConfig(
  key: string,
): IDocumentSourceEntityConfig | undefined {
  return BY_KEY.get(key);
}

/**
 * Config for `key`. Callers past DTO validation can rely on the key existing;
 * the throw is a guard against an out-of-band value (e.g. a row written before
 * a module was retired).
 */
export function getSourceEntityConfig(
  key: string,
): IDocumentSourceEntityConfig {
  const config = BY_KEY.get(key);
  if (!config) throw new Error(`Unknown document source entity '${key}'`);

  return config;
}
