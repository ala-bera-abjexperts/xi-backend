/**
 * @fileoverview Enforces that the backend and frontend feature catalogs stay
 * identical, and that the free tier has exactly one definition.
 * @module licensing/feature-catalog.parity.spec
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * Both `xisuite-backend/src/licensing/feature-catalog.ts` and
 * `risk-management-app/src/lib/licensing/feature-catalog.ts` carry a header
 * saying they MUST be identical and that "a pre-build sync script will automate
 * this in a later phase". That script was never written, and the two copies
 * drifted: `module_assets` existed only in the backend (so a locked tenant would
 * be 403'd by FeatureGuard while the UI showed the module and UpgradePrompt
 * rendered the raw key), and the frontend kept a stale
 * `limit_storage_per_user_mb` that the backend had renamed.
 *
 * A comment cannot enforce a cross-repo invariant. This test can.
 *
 * It reads the frontend file from the sibling checkout by path. If the sibling
 * is absent (someone cloned only the backend) the test SKIPS rather than fails,
 * because a missing repo is an environment condition, not a defect.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FEATURE_CATALOG } from './feature-catalog';

// The old sibling path resolved to
// which never exists, so this whole
// suite silently `describe.skip`ped and catalog drift went unnoticed.
const FRONTEND_CATALOG = resolve(
  process.cwd(),
  '..',
  'risk-management-app',
  'src',
  'lib',
  'licensing',
  'feature-catalog.ts',
);

/**
 * Extracts `key` -> {type, defaultValue, suggestedForFreePlan} from the
 * frontend catalog source.
 *
 * Parsed rather than imported: the frontend is a separate pnpm project with its
 * own tsconfig and path aliases, so importing it from the backend's Jest would
 * drag in that whole toolchain. The fields compared are all simple literals, so
 * a scoped regex over each object block is sufficient and has no runtime cost.
 */
/**
 * Reads the string literals of a `guardedRoutes: [ ... ]` array, tolerating `]`
 * inside the patterns by tracking whether the cursor is inside a quote.
 */
function extractRoutes(block: string): string[] {
  const m = /\bguardedRoutes:\s*\[/.exec(block);

  if (!m) return [];

  const out: string[] = [];
  let i = m.index + m[0].length;
  let current: string | null = null;

  while (i < block.length) {
    const ch = block[i];

    if (current !== null) {
      if (ch === "'") {
        out.push(current);
        current = null;
      } else {
        current += ch;
      }
    } else if (ch === "'") {
      current = '';
    } else if (ch === ']') {
      break;
    }

    i += 1;
  }

  return out;
}

function parseFrontendCatalog(
  source: string,
): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();

  // Split on entry boundaries: every entry starts with `key: '...'`.
  const blocks = source.split(/\bkey:\s*'/).slice(1);

  for (const block of blocks) {
    const key = block.slice(0, block.indexOf("'"));
    const type = /\btype:\s*'([a-z]+)'/.exec(block)?.[1];
    const freePlan = /\bsuggestedForFreePlan:\s*(true|false)/.exec(block)?.[1];

    // `guardedRoutes` entries also contain quotes; only real catalog entries
    // carry a `type` AND a `suggestedForFreePlan`, so this filters noise out.
    if (!type || !freePlan) continue;

    const category = /\bcategory:\s*'([a-z]+)'/.exec(block)?.[1] ?? '';
    // defaultValue is boolean | number | string | null. Captured as raw text so
    // `false` and `0` stay distinguishable and no coercion is needed.
    const defaultValue =
      /\bdefaultValue:\s*([^,\n]+)/.exec(block)?.[1]?.trim() ?? '';
    const sidebar =
      /\bguardedSidebarSection:\s*([^,\n]+)/.exec(block)?.[1]?.trim() ?? '';
    // Normalise the routes array to a stable comparable string.
    //
    // Scanned quote-aware rather than with /\[([^\]]*)\]/, because the route
    // patterns are regexes that themselves contain `]` (e.g.
    // `^/spaces/[^/]+/assets(/.*)?$`). A naive character class stops at the
    // first `]` INSIDE the pattern and silently truncates the array, which made
    // an earlier version of this spec report every multi-route key as a
    // mismatch.
    const routes = extractRoutes(block).join('|');

    out.set(key, {
      type,
      freePlan,
      category,
      defaultValue,
      sidebar,
      routes,
    });
  }

  return out;
}

/** Same shape, derived from the backend catalog, for a like-for-like compare. */
function backendShape(
  entry: (typeof FEATURE_CATALOG)[number],
): Record<string, string> {
  return {
    type: entry.type,
    freePlan: String(entry.suggestedForFreePlan),
    category: entry.category,
    // JSON.stringify rather than String(): `defaultValue` is typed
    // `boolean | number | string | Record<string, unknown> | null`, so a json
    // feature would stringify to "[object Object]" and compare equal to any
    // other object. Single quotes match how the frontend source writes literals.
    defaultValue: JSON.stringify(entry.defaultValue).replace(/"/g, "'"),
    sidebar:
      entry.guardedSidebarSection === null
        ? 'null'
        : `'${entry.guardedSidebarSection}'`,
    routes: entry.guardedRoutes.join('|'),
  };
}

const describeIfSibling = existsSync(FRONTEND_CATALOG)
  ? describe
  : describe.skip;

describeIfSibling('feature catalog parity (backend vs frontend)', () => {
  const frontend = parseFrontendCatalog(
    readFileSync(FRONTEND_CATALOG, 'utf-8'),
  );

  it('has the same key set in both catalogs', () => {
    const backendKeys = FEATURE_CATALOG.map((e) => e.key).sort();
    const frontendKeys = [...frontend.keys()].sort();

    // Reported as sorted arrays so a failure names the offending keys directly.
    expect(frontendKeys).toEqual(backendKeys);
  });

  it('agrees on EVERY compared field, not just the key set', () => {
    // Previously this spec asserted only key, type and suggestedForFreePlan.
    // category, defaultValue, guardedRoutes and guardedSidebarSection could all
    // drift undetected, and guardedRoutes drift is the one that silently stops
    // a route being gated in the UI.
    const mismatches: string[] = [];

    for (const entry of FEATURE_CATALOG) {
      const fe = frontend.get(entry.key);

      if (!fe) continue; // the key-set test above owns this failure.

      const be = backendShape(entry);

      for (const field of Object.keys(be)) {
        if (be[field] !== fe[field]) {
          mismatches.push(
            `${entry.key}.${field}: backend=${be[field]} frontend=${fe[field]}`,
          );
        }
      }
    }

    // Named per field so a failure points at the exact divergence.
    expect(mismatches.sort()).toEqual([]);
  });

  it('defines a non-empty free tier that excludes premium modules', () => {
    const free = FEATURE_CATALOG.filter((e) => e.suggestedForFreePlan).map(
      (e) => e.key,
    );

    expect(free.length).toBeGreaterThan(0);
    // Sanity anchors: a free tier that included these would defeat the lock.
    expect(free).not.toContain('module_site_studio');
    expect(free).not.toContain('module_portfolios');
    expect(free).not.toContain('feature_ai_assist');
  });
});
