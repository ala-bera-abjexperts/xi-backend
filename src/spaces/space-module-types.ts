/**
 * @fileoverview The allow-list of space module types, mirroring the Postgres
 * enum `public.space_module_type`.
 * @module spaces/space-module-types
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * `space_modules.module_type` is constrained by a Postgres enum, and until now
 * that enum had NO representation in backend code at all. Every other module
 * registry has one (`ALLOWED_ORGANIZATION_MODULES` for org modules,
 * `FEATURE_CATALOG` for licensing, `MODULE_PERMISSION_KEYS` for per-space
 * permissions), so space modules were the one registry that could drift from
 * the database and from the frontend with nothing to compare against.
 *
 * Adding a value here does NOT add it to the database. The enum is the source of
 * truth; this list mirrors it so the mismatch can be asserted in a test rather
 * than discovered in production.
 */

/**
 * Every label in `public.space_module_type`, in enum order.
 *
 * Verified against the live schema:
 *   select e.enumlabel from pg_type t join pg_enum e on e.enumtypid = t.oid
 *    where t.typname = 'space_module_type' order by e.enumsortorder;
 */
export const SPACE_MODULE_TYPES = [
  'dashboards',
  'processes',
  'tasks',
  'wiki',
  'lists',
  'robot',
  'gdpr',
  'risk',
  'boards',
  'plans',
  'ai_wiki',
  'automations',
  'file_explorer',
  'assets',
  'form_builder',
  'resource_planning',
  'calendar',
  'whiteboards',
  'test_management',
  'development',
] as const;

export type SpaceModuleType = (typeof SPACE_MODULE_TYPES)[number];

/**
 * Enum labels that exist in the database but are NOT a real product module.
 *
 * `ai_wiki` is in the enum and nowhere else: no frontend `SPACE_MODULE_INFO`
 * entry, no zod value, no route, no permission key, no catalog key, and it is
 * not seeded by `create_default_space_modules`. A row carrying it would fail
 * the frontend's `spaceModuleSchema` parse and render nothing.
 *
 * It is listed here rather than quietly ignored so the divergence is a recorded
 * decision. Removing a Postgres enum label is disruptive (it requires recreating
 * the type), so the label is left in place and simply treated as inert.
 */
export const INERT_SPACE_MODULE_TYPES: readonly SpaceModuleType[] = ['ai_wiki'];

/**
 * The space module types that are actually usable: enum labels minus the inert
 * ones. This is what should be compared against the frontend registry and what
 * any new validation should accept.
 */
export const ACTIVE_SPACE_MODULE_TYPES: readonly SpaceModuleType[] =
  SPACE_MODULE_TYPES.filter((t) => !INERT_SPACE_MODULE_TYPES.includes(t));

export const ACTIVE_SPACE_MODULE_TYPES_SET: ReadonlySet<string> = new Set(
  ACTIVE_SPACE_MODULE_TYPES,
);
