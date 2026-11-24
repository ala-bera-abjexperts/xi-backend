/**
 * @fileoverview Asserts that every catalog key claiming routes is actually
 * enforced by a FeatureRouteGuard layout in the Next.js app.
 * @module licensing/route-guard-coverage.spec
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * `guardedRoutes` says which URLs a feature covers, but nothing makes that claim
 * true. Enforcement comes from a `layout.tsx` wrapping the route in
 * `<FeatureRouteGuard feature='...'>`, written by hand per route.
 *
 * `module_spaces` and `module_help_center` both claimed routes and had no guard
 * file at all, so the two broadest claims in the catalog enforced nothing. That
 * is invisible: the catalog looks complete, the UI renders, and the feature is
 * simply free.
 *
 * The companion `guarded-routes.spec.ts` checks the opposite direction (that a
 * pattern matches a real route). This one checks the claim is enforced.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FEATURE_CATALOG } from './feature-catalog';

const APP_DIR = resolve(
  process.cwd(),
  '..',
  'risk-management-app',
  'src',
  'app',
);

/**
 * Keys that claim routes but deliberately have no guard layout, with reasons.
 * An entry here means the route is reachable without the entitlement.
 */
const NO_GUARD_BY_DESIGN: Record<string, string> = {};

/** Every feature key referenced by a `<FeatureRouteGuard feature='...'>`. */
function guardedFeatures(dir: string, out = new Set<string>()): Set<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      guardedFeatures(full, out);
    } else if (entry === 'layout.tsx' || entry === 'page.tsx') {
      const src = readFileSync(full, 'utf-8');

      for (const m of src.matchAll(
        /<FeatureRouteGuard\s+feature=['"]([a-z_]+)['"]/g,
      )) {
        out.add(m[1]);
      }
    }
  }

  return out;
}

const describeIfSibling = existsSync(APP_DIR) ? describe : describe.skip;

describeIfSibling('every route-claiming catalog key has a guard', () => {
  const guarded = guardedFeatures(APP_DIR);

  it('finds a realistic set of guarded features', () => {
    // Guards against the walker returning nothing and passing vacuously.
    expect(guarded.size).toBeGreaterThan(15);
  });

  it('guards every key that declares guardedRoutes', () => {
    const unguarded = FEATURE_CATALOG.filter(
      (e) =>
        e.guardedRoutes.length > 0 &&
        !guarded.has(e.key) &&
        !(e.key in NO_GUARD_BY_DESIGN),
    )
      .map((e) => e.key)
      .sort();

    // Named so a failure says WHICH feature claims a route it does not enforce.
    expect(unguarded).toEqual([]);
  });

  it('has no guard referencing a key that is not in the catalog', () => {
    const catalogKeys = new Set(FEATURE_CATALOG.map((e) => e.key));
    const unknown = [...guarded].filter((k) => !catalogKeys.has(k)).sort();

    // A typo is silent: entitlements.features[key] is undefined, which
    // FeatureRouteGuard treats as not-entitled, so the page would render the
    // upgrade prompt permanently.
    expect(unknown).toEqual([]);
  });

  it('has no stale exception', () => {
    const stale = Object.keys(NO_GUARD_BY_DESIGN)
      .filter((k) => guarded.has(k))
      .sort();

    expect(stale).toEqual([]);
  });
});
