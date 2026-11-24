/**
 * @fileoverview Enforces that the backend and frontend module-permission key
 * lists stay identical.
 * @module permissions/models/module-permission-keys.parity.spec
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * `module-permission-keys.ts` carries a header saying it "Mirrors
 * src/models/space-module-permission.model.ts on the Next.js side — keep both in
 * sync, or drift will cause the backend to silently drop keys." That was exactly
 * what happened: the frontend defined five `can_*_file_explorer` keys the
 * backend did not, and `SpacesService.setModulePermissionOverrides` skips any
 * key missing from MODULE_PERMISSION_KEYS_SET without erroring:
 *
 *     if (!MODULE_PERMISSION_KEYS_SET.has(key)) continue;   // spaces.service.ts
 *
 * So an admin configuring per-space File Explorer permissions had the change
 * accepted by the UI, sent to the API, and silently discarded. In the other
 * direction the backend held seven portfolio / resource-planning keys the
 * frontend never offered, so they were storable but unmanageable.
 *
 * A comment cannot enforce a cross-repo invariant. This test can.
 *
 * Skips (rather than fails) when the sibling checkout is absent, because a
 * missing repo is an environment condition, not a defect.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MODULE_PERMISSION_KEYS } from './module-permission-keys';

const FRONTEND_MIRROR = resolve(
  process.cwd(),
  '..',
  'risk-management-app',
  'src',
  'models',
  'space-module-permission.model.ts',
);

/**
 * Pulls the key list out of the frontend source.
 *
 * Parsed rather than imported: the frontend is a separate pnpm project with its
 * own tsconfig and path aliases, so importing it from the backend's Jest would
 * drag in that toolchain. The list is plain string literals, so a scoped regex
 * over the array body is sufficient.
 */
function parseFrontendKeys(source: string): string[] {
  const body = /MODULE_PERMISSION_KEYS\s*=\s*\[(.*?)\]\s*as const/s.exec(
    source,
  )?.[1];

  if (!body) return [];

  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const describeIfSibling = existsSync(FRONTEND_MIRROR)
  ? describe
  : describe.skip;

describeIfSibling('module permission key parity (backend vs frontend)', () => {
  const frontendKeys = parseFrontendKeys(
    readFileSync(FRONTEND_MIRROR, 'utf-8'),
  );

  it('parses a non-trivial list from the frontend mirror', () => {
    // Guards against the parser silently returning [] and making every
    // assertion below vacuously pass.
    expect(frontendKeys.length).toBeGreaterThan(100);
  });

  it('has the same key set on both sides', () => {
    const backend = [...MODULE_PERMISSION_KEYS].sort();
    const frontend = [...frontendKeys].sort();

    // Sorted arrays so a failure names the offending keys directly rather than
    // just reporting a length mismatch.
    expect(frontend).toEqual(backend);
  });

  it('covers File Explorer, the drift that caused silent permission loss', () => {
    for (const key of [
      'can_view_file_explorer',
      'can_create_file_explorer',
      'can_edit_file_explorer',
      'can_delete_file_explorer',
      'can_share_file_explorer',
    ]) {
      expect(MODULE_PERMISSION_KEYS).toContain(key);
      expect(frontendKeys).toContain(key);
    }
  });

  it('has no duplicate keys on either side', () => {
    expect(new Set(MODULE_PERMISSION_KEYS).size).toBe(
      MODULE_PERMISSION_KEYS.length,
    );
    expect(new Set(frontendKeys).size).toBe(frontendKeys.length);
  });
});
