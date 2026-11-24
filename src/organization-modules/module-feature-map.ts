/**
 * @fileoverview The org-module allow-list and its binding to catalog feature keys.
 * @module organization-modules/module-feature-map
 *
 * Author: Prince Jadiya
 *
 * WHY THIS IS A LEAF FILE
 * These two constants used to live in `organization-modules.service.ts`, which
 * imports `EntitlementsService`. Anything in `src/licensing/` that wanted the
 * mapping therefore had to import a module that imports licensing, i.e. a cycle.
 * With decorators and Nest's DI that resolves to `undefined` at class-definition
 * time rather than a clean error, so the map is kept here with no imports of its
 * own and re-exported from the service for existing callers.
 */

export const ALLOWED_ORGANIZATION_MODULES = [
  // Org-level features (license-gated):
  'portfolio',
  'document_designer',
  'resource_planning',
  'calendar',
  // Space-level modules. Most now HAVE a catalog feature key; whether the
  // entitlement is consulted depends on MODULE_TYPE_TO_FEATURE_KEY below, not
  // on this list.
  'dashboards',
  'tasks',
  'boards',
  'wiki',
  'lists',
  'plans',
  'processes',
  'assets',
  'risk',
  'gdpr',
  'robot',
  'automations',
  'file_explorer',
  // The tenant-config Modules tab has always rendered a Form Builder switch
  // (ModulesTab.tsx) but this list omitted it, so assertAllowedModule threw
  // BadRequestException('Unknown module_type') and the toggle 400'd.
  'form_builder',
  'whiteboards',
  'test_management',
  'migration',
  // Deliberately absent from MODULE_TYPE_TO_FEATURE_KEY below: @RequireFeature('module_backup')
  // on every backup controller already denies unentitled tenants, and mapping it here would
  // consult entitlements twice with two different failure messages. Keeping it unmapped also
  // means an absent row reads as OFF, which is what the Modules tab switch assumes
  // (`defaultOff: true`). The exemption is recorded in module-catalog-mapping.spec.ts.
  'backup',
] as const;

export type OrganizationModuleType =
  (typeof ALLOWED_ORGANIZATION_MODULES)[number];

/**
 * Maps the legacy `organization_modules.module_type` values to the
 * corresponding catalog `feature_key`. The licensing layer is authoritative;
 * the legacy toggle can additionally DENY but never GRANT.
 *
 * Every module type is mapped, `resource_planning` included, so `isEnabled`
 * never takes its legacy (unlicensed) fallback path for a known type.
 */
// Exported so module-catalog-mapping.spec.ts can assert that every module type
// is bound. The check in setEnabled() is `if (featureKey)`, so an omission here
// silently disables licensing for that module rather than failing.
export const MODULE_TYPE_TO_FEATURE_KEY: Partial<
  Record<OrganizationModuleType | 'development', string>
> = {
  // A space module only, with no organization switch: listed so the space_modules filter licenses it
  // with the same feature that guards the Git endpoints it shows.
  development: 'feature_external_integrations',

  // Every module type now maps to its catalog key.
  //
  // This map used to hold two entries. That was not a small gap: the entitlement
  // check in setEnabled() is wrapped in `if (featureKey)`, so it is opt-in PER
  // MODULE, and 14 of 16 had opted out by omission. A tenant admin could enable
  // wiki, boards, tasks, risk, gdpr, plans, lists, processes, dashboards, robot
  // or automations with no licence at all, and isEnabled() never consulted
  // entitlements for them either.
  //
  // `robot` and `automations` deliberately map to DIFFERENT keys: Robot is the
  // space-level module, Automations is the workflow engine with its own 10
  // controllers. They previously shared `module_robot`.
  //
  // Naming note: the module type `assets` maps to `module_assets`, which gates
  // src/assets-objects/ (the CMDB). The directory src/assets/ is the LISTS
  // module and is gated by `module_lists`. See both module headers.
  portfolio: 'module_portfolios',
  document_designer: 'module_document_designer',
  calendar: 'module_calendar',
  resource_planning: 'module_resource_planning',
  dashboards: 'module_dashboards',
  tasks: 'module_tasks',
  boards: 'module_boards',
  wiki: 'module_wiki',
  lists: 'module_lists',
  plans: 'module_plans',
  processes: 'module_processes',
  assets: 'module_assets',
  risk: 'module_risk',
  gdpr: 'module_gdpr',
  robot: 'module_robot',
  automations: 'module_automations',
  file_explorer: 'module_file_explorer',
  form_builder: 'module_form_builder',
  whiteboards: 'module_whiteboards',
  test_management: 'module_test_management',
  migration: 'module_migration',
};
