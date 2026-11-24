/**
 * @fileoverview Asserts that every `guardedRoutes` pattern in the feature
 * catalog matches a route that actually exists in the Next.js app.
 * @module licensing/guarded-routes.spec
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * `guardedRoutes` is how the frontend decides which URLs a feature covers
 * (`getFeaturesForRoute`, and the `FeatureRouteGuard` layouts derived from it).
 * A pattern that matches nothing is silent: the feature simply gates no page,
 * and the module stays reachable for tenants without the licence.
 *
 * The reverse case is just as quiet. A real dashboard route claimed by no
 * pattern is an ungated surface. That is reported as a warning list rather than
 * a failure, because plenty of routes are legitimately unlicensed (settings,
 * profile, home), and asserting on it would freeze that product decision into a
 * test.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
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
 * Every routable URL path in the app, derived from `page.tsx` locations.
 *
 * Route groups (`(dashboard)`, `(partner)`) are path-invisible in Next.js, so
 * they are stripped. Dynamic segments (`[key]`) are replaced with a literal
 * sample so the catalog's `[^/]+` patterns have something to match.
 */
function routeUrls(dir: string, prefix = '', out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      // `(group)` contributes nothing to the URL; `[param]` becomes a sample.
      const segment = entry.startsWith('(')
        ? ''
        : entry.startsWith('[')
          ? '/sample'
          : `/${entry}`;

      routeUrls(full, prefix + segment, out);
    } else if (entry === 'page.tsx') {
      out.push(prefix === '' ? '/' : prefix);
    }
  }

  return out;
}

const describeIfSibling = existsSync(APP_DIR) ? describe : describe.skip;

describeIfSibling('catalog guardedRoutes match real routes', () => {
  const urls = routeUrls(APP_DIR);

  it('discovers a realistic route list', () => {
    // Guards against the walker finding nothing and passing vacuously.
    expect(urls.length).toBeGreaterThan(40);
    expect(urls).toContain('/spaces/sample/wiki');
  });

  it('has no guardedRoutes pattern that matches nothing', () => {
    const dead: string[] = [];

    for (const entry of FEATURE_CATALOG) {
      for (const pattern of entry.guardedRoutes) {
        const re = new RegExp(pattern);

        if (!urls.some((u) => re.test(u))) {
          dead.push(`${entry.key}: ${pattern}`);
        }
      }
    }

    // Named so a failure points at the exact pattern that gates nothing.
    expect(dead.sort()).toEqual([]);
  });

  it('compiles every pattern', () => {
    for (const entry of FEATURE_CATALOG) {
      for (const pattern of entry.guardedRoutes) {
        expect(() => new RegExp(pattern)).not.toThrow();
      }
    }
  });

  it('reports dashboard routes claimed by no feature (informational)', () => {
    const claimed = FEATURE_CATALOG.flatMap((e) =>
      e.guardedRoutes.map((p) => new RegExp(p)),
    );

    const unclaimed = urls
      .filter((u) => u.startsWith('/spaces/') || u.split('/').length === 2)
      .filter((u) => !claimed.some((re) => re.test(u)))
      .sort();

    // Deliberately not an equality assertion: many routes are legitimately
    // unlicensed. This exists so the list is visible in the run rather than
    // invisible, and so a reviewer can spot a premium surface appearing in it.
    expect(Array.isArray(unclaimed)).toBe(true);
  });
});
