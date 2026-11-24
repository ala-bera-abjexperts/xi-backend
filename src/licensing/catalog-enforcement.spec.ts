/**
 * @fileoverview Asserts that every sellable catalog key actually enforces
 * something, or is explicitly recorded as not enforcing.
 * @module licensing/catalog-enforcement.spec
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * A catalog key that gates nothing is sellable on paper and free in practice.
 * At the time of the audit, 19 of 33 keys enforced nothing anywhere in the
 * backend, including seven premium ones (custom roles, user groups, audit logs,
 * AI assist, branding, integrations, advanced permissions) and four whole
 * modules with real controllers (Automations, File Explorer, Migration,
 * Resource Planning).
 *
 * Nothing failed when a key enforced nothing, which is why so many did. This
 * test makes the omission loud, and forces every exception to carry a reason.
 *
 * Scope note: it only checks `@RequireFeature` usage, which is the boolean gate.
 * `limit_*` keys are enforced by counting, not by a guard, so they are exempt
 * here and tracked separately.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FEATURE_CATALOG } from './feature-catalog';

const SRC = resolve(__dirname, '..');

/**
 * Keys that legitimately enforce nothing via `@RequireFeature`, each with the
 * reason. Anything added here is effectively free, so a bad entry is a revenue
 * hole rather than a test failure.
 */
const NOT_GUARD_ENFORCED: Record<string, string> = {
  // Free tier: everyone gets these, so there is nothing to withhold.
  module_spaces: 'always-on; force-injected true by licensing.service',
  module_tasks: 'free tier',
  module_help_center: 'free tier',

  // Free tier, deliberately ungated after these shipped guarded and 403'd tenants
  // whose plan simply did not name the key. The catalog defaults them to true as
  // well, so nothing withholds them at any layer.
  //
  // feature_ai_assist was gated by the same commit and is deliberately NOT here:
  // it stays premium, and three tests rely on it as the example of a feature a
  // lapsed licence really does withhold.
  feature_audit_logs:
    'free tier; an audit trail must stay readable even when a licence lapses, so it is not withholdable',
  feature_custom_roles: 'free tier',
  feature_user_groups: 'free tier',
  // NOTE: module_resource_planning is free tier but IS guarded, so it is
  // deliberately absent from this list. A free-tier key can still carry a
  // @RequireFeature: the guard simply passes for everyone. Listing it here
  // would wrongly assert that it enforces nothing.

  // Enforced, but by a different mechanism than @RequireFeature.
  module_partners:
    'enforced by @RequirePartner + PartnerGuard across the partner controllers',

  // No backend surface exists to gate.
  module_apps: 'no src/apps/ module exists; frontend placeholder only',
  module_robot:
    'no backend controller; Robot is a space module served by the frontend and RLS',

  // Deliberately ungated, with reasons recorded at the call sites.
  feature_advanced_permissions:
    'would have to gate PermissionsController, which serves /permissions/effective and /permissions/menu on every page load; gating it would 403 every user in an unentitled tenant',
  feature_impersonation_target:
    'read by the impersonation flow as a target-side opt-in, not a route gate',
};

/** Every `@RequireFeature('...')` key used anywhere under src/. */
function guardedKeys(dir: string, out = new Set<string>()): Set<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      guardedKeys(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      const src = readFileSync(full, 'utf-8');

      for (const m of src.matchAll(/RequireFeature\(\s*'([a-z_]+)'/g)) {
        out.add(m[1]);
      }
    }
  }

  return out;
}

describe('catalog keys actually enforce something', () => {
  const used = guardedKeys(SRC);

  it('finds a realistic set of guarded keys', () => {
    // Guards against the walker returning nothing and passing vacuously.
    expect(used.size).toBeGreaterThan(10);
  });

  it('has no boolean module key that gates nothing without a recorded reason', () => {
    const unenforced = FEATURE_CATALOG.filter(
      (e) =>
        e.category === 'modules' &&
        !used.has(e.key) &&
        !(e.key in NOT_GUARD_ENFORCED),
    )
      .map((e) => e.key)
      .sort();

    // Named so a failure says WHICH module is sellable but free.
    expect(unenforced).toEqual([]);
  });

  it('has no premium non-module key that gates nothing without a recorded reason', () => {
    const unenforced = FEATURE_CATALOG.filter(
      (e) =>
        e.category !== 'modules' &&
        e.type === 'boolean' &&
        e.suggestedForFreePlan === false &&
        !used.has(e.key) &&
        !(e.key in NOT_GUARD_ENFORCED),
    )
      .map((e) => e.key)
      .sort();

    expect(unenforced).toEqual([]);
  });

  it('has no stale exception: every exempted key is still unguarded', () => {
    // If a key gains a @RequireFeature, its exemption is obsolete and should be
    // deleted rather than left implying the key is unenforced.
    const stale = Object.keys(NOT_GUARD_ENFORCED)
      .filter((k) => used.has(k))
      .sort();

    expect(stale).toEqual([]);
  });

  it('exempts only keys that exist in the catalog', () => {
    const catalogKeys = new Set(FEATURE_CATALOG.map((e) => e.key));
    const unknown = Object.keys(NOT_GUARD_ENFORCED)
      .filter((k) => !catalogKeys.has(k))
      .sort();

    expect(unknown).toEqual([]);
  });

  it('uses no @RequireFeature key that is missing from the catalog', () => {
    const catalogKeys = new Set(FEATURE_CATALOG.map((e) => e.key));
    const typos = [...used].filter((k) => !catalogKeys.has(k)).sort();

    // A typo here is silent: entitlements.has() returns false for an unknown
    // key, so the route would be permanently unreachable.
    expect(typos).toEqual([]);
  });
});
