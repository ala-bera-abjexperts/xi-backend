/**
 * @fileoverview Guards the invariant that every space permission a role preset
 * grants can actually be persisted somewhere.
 * @module permissions/models/space-permissions.coverage.spec
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * A space permission can be written down one of two paths, and each has its own
 * whitelist that silently drops anything not on it:
 *
 *   1. `space_permissions` columns  -> SPACE_PERMISSION_COLUMN_KEYS
 *   2. `space_module_permissions`   -> MODULE_PERMISSION_KEYS  (JSONB)
 *      (spaces.service.ts: `if (!MODULE_PERMISSION_KEYS_SET.has(key)) continue;`)
 *
 * So a key that a role preset grants but that appears in NEITHER whitelist can
 * never be persisted: the column keeps its `DEFAULT false` while the preset says
 * `true`, and nothing errors.
 *
 * That had happened to 29 real columns (all of Plans, Boards, Automations and
 * Form Builder, plus service principals) and, separately, to the five File
 * Explorer keys on the JSONB path. It is the same failure mode that
 * `resolveSpaceBaseGrant` was introduced to work around, and it is completely
 * silent.
 *
 * The invariant is deliberately the UNION of the two paths. An earlier version
 * of this test asserted the column path alone and failed on 50 keys that are
 * legitimately JSONB-only (the per-module comment / attachment / export
 * sub-permissions such as `add_comments_wiki`), which have no column by design.
 */

import { MODULE_PERMISSION_KEYS } from './module-permission-keys';
import {
  SPACE_PERMISSION_COLUMN_KEYS,
  SPACE_ROLE_BASE_PERMISSIONS,
} from './space-permissions.model';

/** Both whitelists are compared unprefixed; presets use either convention. */
const strip = (key: string): string =>
  key.startsWith('can_') ? key.slice(4) : key;

/**
 * Space-MANAGEMENT permissions, as opposed to module permissions. They are
 * intentionally role-derived only: there is no per-space override path for
 * them, and `spaceGrantAllows` short-circuits admins before they are consulted.
 * Listed explicitly so the exemption is a decision rather than a silent gap.
 */
const ROLE_ONLY_BY_DESIGN = new Set([
  'invite_members',
  'manage_custom_roles',
  'manage_module_permissions',
  'view_module_permissions',
]);

const WRITABLE = new Set<string>([
  ...SPACE_PERMISSION_COLUMN_KEYS,
  ...MODULE_PERMISSION_KEYS.map(strip),
]);

describe('space permission write coverage', () => {
  const roles = Object.keys(SPACE_ROLE_BASE_PERMISSIONS);

  it('has presets and whitelists to check', () => {
    // Guards against every assertion below passing vacuously if an export moves.
    expect(roles.length).toBeGreaterThan(0);
    expect(SPACE_PERMISSION_COLUMN_KEYS.size).toBeGreaterThan(50);
    expect(MODULE_PERMISSION_KEYS.length).toBeGreaterThan(100);
  });

  it.each(roles)(
    'every permission the %s preset grants is persistable',
    (role) => {
      const preset = SPACE_ROLE_BASE_PERMISSIONS[role];

      const unwritable = Object.keys(preset)
        .filter((key) => preset[key] === true)
        .map(strip)
        .filter((key) => !WRITABLE.has(key) && !ROLE_ONLY_BY_DESIGN.has(key))
        .sort();

      // Named explicitly so a failure says WHICH permission would be lost.
      expect(unwritable).toEqual([]);
    },
  );

  it('keeps the four role-only exemptions genuinely unwritable', () => {
    // If one of these ever gains a column or a JSONB entry, the exemption is
    // stale and should be removed rather than left masking a real gap.
    for (const key of ROLE_ONLY_BY_DESIGN) {
      expect(WRITABLE.has(key)).toBe(false);
    }
  });

  it('can write the previously-dropped blocks through the COLUMN path', () => {
    // Deliberately asserts SPACE_PERMISSION_COLUMN_KEYS, not the union.
    //
    // The two paths are different tables with different writers: the column
    // path is what invitation-accept seeds onto `space_permissions`, while the
    // JSONB path is a separate per-space override on `space_module_permissions`.
    // Most of these keys exist on BOTH, so asserting the union here would pass
    // even with the column whitelist regressed, which is exactly the bug that
    // left 29 columns stuck at DEFAULT false.
    for (const key of [
      'view_plans',
      'create_plans',
      'view_boards',
      'view_automations',
      'publish_automations',
      'manage_automation_connections',
      'create_service_principals',
      'view_forms',
      'submit_forms',
      'view_form_responses',
      'export_form_responses',
      'view_file_explorer',
    ]) {
      expect(SPACE_PERMISSION_COLUMN_KEYS.has(key)).toBe(true);
    }
  });

  it('keeps the column whitelist aligned with the real table width', () => {
    // `public.space_permissions` has 111 boolean columns. A unit test cannot
    // reach Postgres, so this pins the count as a tripwire: if someone adds a
    // column and forgets the whitelist (or vice versa), this drifts. Re-check
    // with:
    //   select count(*) from information_schema.columns
    //    where table_schema='public' and table_name='space_permissions'
    //      and data_type='boolean';
    // 118 = 114 + 4 whiteboards columns (migration
    // 20260925120200_whiteboards_permissions_and_modules.sql).
    expect(SPACE_PERMISSION_COLUMN_KEYS.size).toBe(118);
  });

  it('holds no `can_` prefixed keys in the column whitelist', () => {
    // A prefixed entry would never match a column name and would silently fail
    // the `has()` gate in every writer.
    expect(
      [...SPACE_PERMISSION_COLUMN_KEYS].filter((k) => k.startsWith('can_')),
    ).toEqual([]);
  });
});
