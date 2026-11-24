/**
 * @fileoverview Keeps the space module registry aligned across the database
 * enum, the backend constant and the two frontend lists.
 * @module spaces/space-module-types.parity.spec
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * A space module has to appear in four places to work end to end:
 *
 *   1. the Postgres enum `public.space_module_type`   (constrains the column)
 *   2. SPACE_MODULE_TYPES here                        (backend allow-list)
 *   3. SpaceModuleTypeEnum in space.model.ts          (frontend zod parse)
 *   4. SPACE_MODULE_INFO in space.model.ts            (frontend label + toggle)
 *
 * Nothing compared them, and they had drifted: `ai_wiki` exists in the enum and
 * in none of the others, so a row carrying it fails the frontend's zod parse and
 * renders nothing.
 *
 * A jest test cannot reach Postgres, so item 1 is pinned by the count assertion
 * below plus the documented query in space-module-types.ts. Items 2-4 are
 * compared directly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ACTIVE_SPACE_MODULE_TYPES,
  INERT_SPACE_MODULE_TYPES,
  SPACE_MODULE_TYPES,
} from './space-module-types';

const FRONTEND_MODEL = resolve(
  process.cwd(),
  '..',
  'risk-management-app',
  'src',
  'models',
  'space.model.ts',
);

/** Values of the frontend `SpaceModuleTypeEnum` zod enum. */
function parseZodEnum(source: string): string[] {
  const body = /SpaceModuleTypeEnum\s*=\s*z\.enum\(\[(.*?)\]\)/s.exec(
    source,
  )?.[1];

  return body ? [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
}

/** Top-level keys of the frontend `SPACE_MODULE_INFO` record. */
function parseModuleInfoKeys(source: string): string[] {
  const start = source.indexOf('SPACE_MODULE_INFO');

  if (start === -1) return [];

  // Each entry is `  <key>: {` at exactly two spaces of indentation.
  // Only up to the record's closing brace: later declarations in the file have two-space keys too.
  const rest = source.slice(start);
  const body = rest.slice(0, rest.indexOf('\n}'));

  return [...body.matchAll(/^ {2}([a-z_]+):\s*\{/gm)].map((m) => m[1]);
}

const describeIfSibling = existsSync(FRONTEND_MODEL) ? describe : describe.skip;

describeIfSibling('space module type registry parity', () => {
  const source = readFileSync(FRONTEND_MODEL, 'utf-8');
  const zodValues = parseZodEnum(source);
  const infoKeys = parseModuleInfoKeys(source);

  it('parses non-trivial lists from the frontend model', () => {
    // Guards against a parser returning [] and making everything below pass
    // vacuously, which is how two earlier specs in this codebase went green
    // while asserting nothing.
    expect(zodValues.length).toBeGreaterThan(10);
    expect(infoKeys.length).toBeGreaterThan(10);
  });

  it('pins the database enum size', () => {
    // The enum is the source of truth and cannot be read from a unit test.
    // If a label is added or removed in a migration, update SPACE_MODULE_TYPES
    // and this count together. Re-check with:
    //   select count(*) from pg_type t join pg_enum e on e.enumtypid=t.oid
    //    where t.typname='space_module_type';
    // 17 = 16 + `whiteboards` (migration 20260925120000_space_module_whiteboards_enum.sql).
    // 18 = 17 + `calendar` (migration 20261010120000_space_module_calendar_enum.sql).
    // 19 = 18 + `test_management`.
    // 20 = 19 + `development` (migration 20261030120000_space_module_development_enum.sql).
    expect(SPACE_MODULE_TYPES.length).toBe(20);
  });

  it('matches the frontend zod enum on the active types', () => {
    expect([...zodValues].sort()).toEqual(
      [...ACTIVE_SPACE_MODULE_TYPES].sort(),
    );
  });

  it('matches SPACE_MODULE_INFO on the active types', () => {
    // A type in the zod enum but missing from SPACE_MODULE_INFO parses fine and
    // then renders nothing, because SpaceModuleItem returns null on missing info.
    expect([...infoKeys].sort()).toEqual([...ACTIVE_SPACE_MODULE_TYPES].sort());
  });

  it('keeps every inert type genuinely absent from the frontend', () => {
    // If `ai_wiki` ever gains frontend support, it stops being inert and should
    // be removed from INERT_SPACE_MODULE_TYPES rather than left masking a real
    // registry gap.
    for (const inert of INERT_SPACE_MODULE_TYPES) {
      expect(zodValues).not.toContain(inert);
      expect(infoKeys).not.toContain(inert);
    }
  });

  it('has no duplicate entries', () => {
    expect(new Set(SPACE_MODULE_TYPES).size).toBe(SPACE_MODULE_TYPES.length);
    expect(new Set(zodValues).size).toBe(zodValues.length);
    expect(new Set(infoKeys).size).toBe(infoKeys.length);
  });
});
