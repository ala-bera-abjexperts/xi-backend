/**
 * @fileoverview Keeps the three frontend menu-permission lists in agreement.
 * @module permissions/menu-permission-registry.spec
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * Three lists decide menu visibility, and all three carry a comment saying they
 * must stay in sync:
 *
 *   1. MENU_PERMISSION_MAP   hooks/useMenuVisibility.ts        (the live check)
 *   2. MENU_ITEMS            MenuPermissionsTab.tsx            (the admin UI)
 *   3. the legacy map        services/permission.service.ts    (legacy path)
 *
 * They had drifted in every direction: `gdpr` was in 2 and 3 but not 1, so
 * `isMenuItemVisible('gdpr')` hit the `undefined` branch and failed OPEN;
 * `portfolios`, `site_studio`, `resource_planning` and `settings.workflows` were
 * in 1 only, so the permission was enforced but no admin could configure it.
 *
 * The invariant asserted here is deliberately narrow: every key that MAPS TO A
 * PERMISSION in list 1 must appear in lists 2 and 3 with the SAME permission.
 * Keys mapped to `null` (dashboard, profile, notifications, filters,
 * help_center) are always-visible by design and are not configurable, so they
 * are exempt.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FE = resolve(process.cwd(), '..', 'risk-management-app', 'src');

const MAP_FILE = resolve(FE, 'hooks', 'useMenuVisibility.ts');
const ITEMS_FILE = resolve(
  FE,
  'views',
  'settings',
  'access',
  'MenuPermissionsTab',
  'MenuPermissionsTab.tsx',
);
const LEGACY_FILE = resolve(FE, 'services', 'permission.service.ts');

/** `key: 'can_x'` or `key: null` entries of MENU_PERMISSION_MAP. */
function parseMap(source: string): Map<string, string | null> {
  const body = /MENU_PERMISSION_MAP[^=]*=\s*\{([\s\S]*?)\n\}/.exec(source)?.[1];
  const out = new Map<string, string | null>();

  if (!body) return out;

  for (const m of body.matchAll(
    /^\s*'?([A-Za-z_][\w.]*)'?\s*:\s*(?:'(can_[a-z_]+)'|null)/gm,
  )) {
    out.set(m[1], m[2] ?? null);
  }

  return out;
}

/** `menuKey: 'x', permission: 'can_y'` pairs from MENU_ITEMS. */
function parseItems(source: string): Map<string, string | null> {
  const out = new Map<string, string | null>();

  for (const m of source.matchAll(
    /menuKey:\s*'([\w.]+)',\s*\n?\s*permission:\s*(?:'(can_[a-z_]+)'|null)/g,
  )) {
    out.set(m[1], m[2] ?? null);
  }

  return out;
}

/** `key: effective_permissions.can_x ?? false` pairs from the legacy map. */
function parseLegacy(source: string): Map<string, string | null> {
  const body =
    /const menuMap: Record<string, boolean> = \{([\s\S]*?)\n {6}\}/.exec(
      source,
    )?.[1];
  const out = new Map<string, string | null>();

  if (!body) return out;

  for (const m of body.matchAll(
    /^\s*'?([A-Za-z_][\w.]*)'?\s*:\s*(?:effective_permissions\.(can_[a-z_]+)|true)/gm,
  )) {
    out.set(m[1], m[2] ?? null);
  }

  return out;
}

const present =
  existsSync(MAP_FILE) && existsSync(ITEMS_FILE) && existsSync(LEGACY_FILE);
const describeIfSibling = present ? describe : describe.skip;

describeIfSibling('menu permission registry parity', () => {
  const map = parseMap(readFileSync(MAP_FILE, 'utf-8'));
  const items = parseItems(readFileSync(ITEMS_FILE, 'utf-8'));
  const legacy = parseLegacy(readFileSync(LEGACY_FILE, 'utf-8'));

  /** Keys that genuinely gate on a permission. `null` entries are exempt. */
  const gated = [...map.entries()].filter(([, perm]) => perm !== null);

  it('parses all three lists', () => {
    // Guards against a parser returning empty and passing vacuously.
    expect(map.size).toBeGreaterThan(15);
    expect(items.size).toBeGreaterThan(10);
    expect(legacy.size).toBeGreaterThan(10);
    expect(gated.length).toBeGreaterThan(10);
  });

  it('has every permission-gated key in the admin UI list', () => {
    const missing = gated
      .filter(([key]) => !items.has(key))
      .map(([key]) => key)
      .sort();

    // A key here is enforced but not configurable by an admin.
    expect(missing).toEqual([]);
  });

  it('has every permission-gated key in the legacy map', () => {
    const missing = gated
      .filter(([key]) => !legacy.has(key))
      .map(([key]) => key)
      .sort();

    expect(missing).toEqual([]);
  });

  it('uses the same permission for a key in all three lists', () => {
    const conflicts: string[] = [];

    for (const [key, perm] of gated) {
      if (items.has(key) && items.get(key) !== perm) {
        conflicts.push(`${key}: map=${perm} adminUI=${items.get(key)}`);
      }

      if (legacy.has(key) && legacy.get(key) !== perm) {
        conflicts.push(`${key}: map=${perm} legacy=${legacy.get(key)}`);
      }
    }

    expect(conflicts.sort()).toEqual([]);
  });

  it('maps every key the sidebar actually queries, so none fails open', () => {
    // `isMenuItemVisible` returns true when the key is absent from the map
    // (`requiredPermission === undefined`), so an unmapped key is invisible
    // fail-open rather than an error. These are the keys queried in components.
    for (const key of [
      'filters',
      'help_center',
      'gdpr',
      'dashboards',
      'portfolios',
      'site_studio',
      'settings',
      'test_management',
    ]) {
      expect(map.has(key)).toBe(true);
    }
  });
});
