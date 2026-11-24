/**
 * @fileoverview Asserts that every org module type is bound to a catalog feature
 * key, so no module can silently opt out of licensing.
 * @module organization-modules/module-catalog-mapping.spec
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * The entitlement check in `OrganizationModulesService.setEnabled` is written as:
 *
 *     if (enabled) {
 *       const featureKey = MODULE_TYPE_TO_FEATURE_KEY[moduleType];
 *       if (featureKey) { ...check entitlement... }
 *     }
 *
 * so licensing is opt-in PER MODULE. The map used to hold two entries out of
 * sixteen, which meant fourteen module types skipped the check entirely: a
 * tenant admin could enable wiki, boards, tasks, risk, gdpr, plans, lists,
 * processes, dashboards, robot or automations with no licence, and `isEnabled`
 * never consulted entitlements for them either.
 *
 * Nothing failed when a module was left out, which is precisely why fourteen
 * were. This test makes omission loud.
 */

import { FEATURE_CATALOG } from '../licensing/feature-catalog';
import {
  ALLOWED_ORGANIZATION_MODULES,
  MODULE_TYPE_TO_FEATURE_KEY,
} from './organization-modules.service';

/**
 * Module types deliberately NOT bound to a catalog key.
 *
 * Empty on purpose. Adding an entry here means that module can be switched on
 * without a licence, so each one needs a stated reason.
 */
const INTENTIONALLY_UNLICENSED = new Set<string>([
  // Backup & Restore. Every one of its eight controllers carries
  // @RequireFeature('module_backup'), so FeatureGuard — not this map — is the
  // enforcement boundary, and an unentitled tenant is 403'd on every backup
  // route regardless of the toggle. Mapping it here would consult entitlements
  // twice per call with two different failure messages, and would flip the
  // absent-row default from OFF to ON, contradicting the Modules tab switch
  // (`defaultOff: true`). So the toggle can be flipped without a licence, but
  // flipping it grants no access.
  'backup',
]);

describe('org module type to catalog key mapping', () => {
  const catalogKeys = new Set(FEATURE_CATALOG.map((e) => e.key));

  it('has a realistic catalog and module list', () => {
    // Guards against the assertions below passing vacuously if an export moves.
    expect(catalogKeys.size).toBeGreaterThan(30);
    expect(ALLOWED_ORGANIZATION_MODULES.length).toBeGreaterThan(10);
  });

  it('binds every allowed module type to a catalog key', () => {
    const unmapped = ALLOWED_ORGANIZATION_MODULES.filter(
      (type) =>
        !MODULE_TYPE_TO_FEATURE_KEY[type] &&
        !INTENTIONALLY_UNLICENSED.has(type),
    ).sort();

    // Named so a failure says WHICH module would skip the licence check.
    expect(unmapped).toEqual([]);
  });

  it('maps every module type to a key that actually exists in the catalog', () => {
    const dangling = Object.entries(MODULE_TYPE_TO_FEATURE_KEY)
      .filter(([, key]) => key && !catalogKeys.has(key))
      .map(([type, key]) => `${type} -> ${key}`)
      .sort();

    // A typo here is worse than no mapping: `entitlements.has()` returns false
    // for an unknown key, so the module would be permanently unavailable.
    expect(dangling).toEqual([]);
  });

  it('does not map two module types to the same key', () => {
    // `robot` and `automations` are separate products and must stay separately
    // licensable; collapsing them would make one un-sellable.
    const byKey = new Map<string, string[]>();

    for (const [type, key] of Object.entries(MODULE_TYPE_TO_FEATURE_KEY)) {
      if (!key) continue;
      byKey.set(key, [...(byKey.get(key) ?? []), type]);
    }

    const shared = [...byKey.entries()]
      .filter(([, types]) => types.length > 1)
      .map(([key, types]) => `${key} <- ${types.sort().join(', ')}`)
      .sort();

    expect(shared).toEqual([]);
  });

  it('maps robot and automations to different keys', () => {
    expect(MODULE_TYPE_TO_FEATURE_KEY.robot).toBe('module_robot');
    expect(MODULE_TYPE_TO_FEATURE_KEY.automations).toBe('module_automations');
  });
});
