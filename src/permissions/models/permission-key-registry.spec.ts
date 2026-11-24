/**
 * @fileoverview Keeps the organization-level permission registry honest.
 * @module permissions/models/permission-key-registry.spec
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * `@RequirePermissions('...')` takes a bare string. Nothing checks that the
 * string names a permission that exists, so a typo or an invented key produces
 * a route that denies EVERY user, silently, with a generic 403 — there is no
 * startup error and no log line.
 *
 * That had already happened. `can_manage_tasks` guarded the three task-reminder
 * routes and was declared in no interface, no base-role preset, and no custom
 * role in any database. `hasPermission()` returns `permissions[key] === true`,
 * so it resolved `undefined` for everybody including the organization owner,
 * and the space-level fallback reads `space_members.permissions`, which is `{}`
 * on every row. Creating, editing and deleting a task reminder was impossible
 * for all users. It now requires `can_edit_tasks`, the key its sibling task
 * mutations already use.
 *
 * The four invariants below make each step of that failure impossible to
 * reintroduce.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DEFAULT_PERMISSIONS_BY_ROLE } from './access-control.model';
import { MODULE_PERMISSION_KEYS } from './module-permission-keys';
import { SPACE_ROLE_BASE_PERMISSIONS } from './space-permissions.model';

const BACKEND_SRC = resolve(__dirname, '..', '..');
const MODEL_FILE = join(__dirname, 'access-control.model.ts');
const FRONTEND_MODEL = resolve(
  process.cwd(),
  '..',
  'risk-management-app',
  'src',
  'models',
  'access-control.model.ts',
);

/**
 * Partner Portal keys are granted exclusively by the system "Backoffice" custom
 * role that partner provisioning mints, never by a base-role preset. Putting
 * them in a preset would hand partner permissions to every owner and admin in
 * every tenant, partner or not. The model says so in a comment; this makes it
 * an assertion.
 */
const GRANTED_ONLY_BY_CUSTOM_ROLE = /^can_(view|manage)_partner_/;

/**
 * Pre-existing, deliberate disagreements between the org-tier default and the
 * space-tier grant for the SAME key. Every one of these predates this spec and
 * changing any of them changes live authorization, so they are frozen, not
 * fixed. The shape is intentional in each case:
 *
 *  - a space viewer may comment, an org viewer may not;
 *  - a space member may export, an org member may not;
 *  - an org admin may delete configuration objects, a space admin may not.
 *
 * The test asserts this list is EXHAUSTIVE and CURRENT: a new disagreement
 * fails, and so does an entry that no longer disagrees.
 */
const TIER_DISAGREEMENTS_BY_DESIGN = [
  'admin can_delete_priorities',
  'admin can_delete_statuses',
  'admin can_delete_hierarchy',
  'admin can_delete_boards',
  'admin can_delete_plans',
  'member can_export_data_processes',
  'member can_export_data_tasks',
  'member can_export_data_wiki',
  'member can_export_data_lists',
  'member can_export_data_dashboards',
  'member can_export_data_robot',
  'member can_export_data_gdpr',
  'member can_edit_notifications',
  'member can_export_data_plans',
  'viewer can_add_comments_processes',
  'viewer can_add_comments_tasks',
  'viewer can_add_comments_wiki',
  'viewer can_add_comments_lists',
  'viewer can_add_comments_dashboards',
  'viewer can_add_comments_robot',
  'viewer can_add_comments_gdpr',
  'viewer can_add_comments_plans',
].sort();

/** Every `.ts` file under the backend src tree, excluding specs. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;

    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      acc.push(full);
    }
  }

  return acc;
}

/** Permission strings passed to `@RequirePermissions(...)` anywhere in src. */
function requiredPermissionKeys(): Map<string, string[]> {
  const out = new Map<string, string[]>();

  for (const file of sourceFiles(BACKEND_SRC)) {
    const source = readFileSync(file, 'utf-8');

    if (!source.includes('@RequirePermissions')) continue;

    // The decorator accepts a string, an array, and an options object, so take
    // the whole argument list and pull every quoted can_* out of it.
    for (const call of source.matchAll(/@RequirePermissions\(([^)]*)\)/g)) {
      for (const key of call[1].matchAll(/'(can_[a-z_]+)'/g)) {
        const where = out.get(key[1]) ?? [];

        where.push(file.slice(BACKEND_SRC.length + 1));
        out.set(key[1], where);
      }
    }
  }

  return out;
}

/** Keys declared on the `IPermissionsObject` interface (types vanish at runtime). */
function declaredKeys(source: string): Set<string> {
  const body = /export interface IPermissionsObject \{([\s\S]*?)\n\}/.exec(
    source,
  )?.[1];

  return new Set(
    [...(body ?? '').matchAll(/^ {2}(can_[a-z_]+)\??:/gm)].map((m) => m[1]),
  );
}

/** Keys declared on the frontend's `permissionsObjectSchema`. */
function frontendKeys(source: string): Set<string> {
  const body =
    /export const permissionsObjectSchema = z\.object\(\{([\s\S]*?)\n\}\)/.exec(
      source,
    )?.[1];

  return new Set(
    [...(body ?? '').matchAll(/^ {2}(can_[a-z_]+):/gm)].map((m) => m[1]),
  );
}

describe('organization permission key registry', () => {
  const declared = declaredKeys(readFileSync(MODEL_FILE, 'utf-8'));
  const required = requiredPermissionKeys();
  const presets = Object.values(DEFAULT_PERMISSIONS_BY_ROLE) as Record<
    string,
    boolean | undefined
  >[];

  it('parses the registry (guards against a vacuous pass)', () => {
    expect(declared.size).toBeGreaterThan(150);
    expect(required.size).toBeGreaterThan(50);
    expect(presets).toHaveLength(4);

    // The parsers must actually work, not just return empty sets.
    expect(declared.has('can_view_tasks')).toBe(true);
    expect(required.has('can_view_tasks')).toBe(true);
  });

  it('declares every key that a route requires', () => {
    const undeclared = [...required.entries()]
      .filter(([key]) => !declared.has(key))
      .map(([key, files]) => `${key} (${files.join(', ')})`)
      .sort();

    // An undeclared key denies every user on every route that requires it.
    expect(undeclared).toEqual([]);
  });

  it('grants every required key to at least one base role', () => {
    const ungranted = [...required.entries()]
      .filter(([key]) => !GRANTED_ONLY_BY_CUSTOM_ROLE.test(key))
      .filter(([key]) => !presets.some((p) => p[key] === true))
      .map(([key, files]) => `${key} (${files.join(', ')})`)
      .sort();

    // Declared but granted by nothing is the same 403 as undeclared, one step
    // further along.
    expect(ungranted).toEqual([]);
  });

  it('keeps the partner exemption honest', () => {
    // If a partner key ever lands in a preset, the comment in the model that
    // says it never does has become a lie, and every owner in every tenant
    // silently gained partner access.
    const leaked = [...declared]
      .filter((key) => GRANTED_ONLY_BY_CUSTOM_ROLE.test(key))
      .filter((key) => presets.some((p) => p[key] !== undefined))
      .sort();

    expect(leaked).toEqual([]);
  });

  it('declares every space-tier key at the org tier', () => {
    // The org tier holds the DEFAULT that a space_permissions row overrides.
    // A space key with no org counterpart resolves `undefined` for every user
    // who has no explicit space row, which is most of them.
    const missing = MODULE_PERMISSION_KEYS.filter(
      (key) => !declared.has(key),
    ).sort();

    expect(missing).toEqual([]);
  });

  it('agrees with the space tier except where documented', () => {
    const found: string[] = [];

    for (const role of ['owner', 'admin', 'member', 'viewer']) {
      const org = DEFAULT_PERMISSIONS_BY_ROLE[role] as Record<
        string,
        boolean | undefined
      >;
      const space = SPACE_ROLE_BASE_PERMISSIONS[role];

      for (const [flat, spaceValue] of Object.entries(space)) {
        const orgValue = org[`can_${flat}`];

        if (orgValue === undefined) continue;
        if (orgValue !== spaceValue) found.push(`${role} can_${flat}`);
      }
    }

    // Exhaustive AND current: a new disagreement fails, and so does a listed
    // exception that has since been reconciled.
    expect(found.sort()).toEqual(TIER_DISAGREEMENTS_BY_DESIGN);
  });
});

const describeIfSibling = existsSync(FRONTEND_MODEL) ? describe : describe.skip;

describeIfSibling('org permission parity with the frontend model', () => {
  const backend = declaredKeys(readFileSync(MODEL_FILE, 'utf-8'));
  const frontend = frontendKeys(readFileSync(FRONTEND_MODEL, 'utf-8'));

  it('parses both models', () => {
    expect(backend.size).toBeGreaterThan(150);
    expect(frontend.size).toBeGreaterThan(150);
  });

  it('declares the same keys on both sides', () => {
    // The frontend decides what the admin UI can configure and what the client
    // gates on; the backend decides what is enforced. A key on one side only is
    // either an unconfigurable rule or a control that changes nothing.
    expect([...backend].filter((k) => !frontend.has(k)).sort()).toEqual([]);
    expect([...frontend].filter((k) => !backend.has(k)).sort()).toEqual([]);
  });
});
