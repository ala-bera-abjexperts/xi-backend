/**
 * @fileoverview Asserts that every controller in the tree is actually reachable
 * from the application's module graph.
 * @module app-module-coverage.spec
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * `SwimlanesModule`, `CardFieldsModule` and `QuickFiltersModule` each had a
 * controller, a service, DTOs and a passing spec, and were imported nowhere. So
 * their routes never existed, and every frontend call to
 * `/boards/:id/swimlanes`, `/card-fields`, `/quick-filters` and
 * `/user-state/quick-filters` 404'd in production.
 *
 * Nothing caught it. The unit specs construct controllers directly
 * (`new SwimlanesController(service)`), so they never touch the Nest graph, and
 * a green suite actively hid the outage.
 *
 * This test closes that gap by comparing two things that should never disagree:
 * the controller files ON DISK, and the controllers REACHABLE from AppModule.
 *
 * It is deliberately a static analysis rather than a Nest bootstrap. Booting
 * AppModule would need Supabase, a JWT secret and the scheduler, which makes it
 * an integration test that cannot run in CI without infrastructure. Reading the
 * import graph needs nothing and fails for exactly the right reason.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname);

/**
 * Controllers that are intentionally NOT in the root graph.
 *
 * Keep this list short and justified. Anything here is invisible at runtime, so
 * an unjustified entry is an outage waiting to be re-introduced.
 */
const INTENTIONALLY_UNREGISTERED = new Set<string>([
  // Registered conditionally: app.module.ts spreads these only when
  // IS_ON_PREMISE is truthy, so on a SaaS build they are correctly absent.
  'on-prem-updates/on-prem-updates.controller.ts',
  'on-prem-license/on-prem-license.controller.ts',
]);

/**
 * Extracts the body of a `<label>: [ ... ]` array with balanced brackets.
 *
 * A plain `/imports:\s*\[([^\]]*)\]/` is wrong here: app.module.ts's imports
 * array contains nested arrays (`ConfigModule.forRoot({ envFilePath: ['.env'] })`
 * and the `...(IS_ON_PREMISE ? [A, B] : [])` spread), so a non-greedy scan stops
 * at the first inner `]` and silently truncates the list. That made an earlier
 * version of this spec report 155 false orphans.
 */
function arrayBody(src: string, label: string): string {
  const start = new RegExp(`${label}\\s*:\\s*\\[`).exec(src);

  if (!start) return '';

  let depth = 1;
  let i = start.index + start[0].length;
  const from = i;

  while (i < src.length && depth > 0) {
    const ch = src[i];

    if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
    i += 1;
  }

  return src.slice(from, i - 1);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (entry.endsWith('.controller.ts')) {
      out.push(full);
    }
  }

  return out;
}

/** Exported controller class names declared in a file. */
function controllerClasses(file: string): string[] {
  const src = readFileSync(file, 'utf-8');

  return [...src.matchAll(/export\s+class\s+(\w*Controller)\b/g)].map(
    (m) => m[1],
  );
}

/**
 * Every module file transitively reachable from AppModule.
 *
 * Follows the `imports: [...]` ARRAY, not the file's `import` statements. That
 * distinction is the whole test: an unused `import { XModule } from ...` line
 * registers nothing, and a first version of this walker that followed import
 * statements happily reported a module as reachable after it had been removed
 * from the array. It passed its own negative control for the wrong reason.
 *
 * So: read the class names inside `imports: [...]`, then resolve each name to a
 * file using that file's own import statements.
 */
function reachableModuleFiles(): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(SRC, 'app.module.ts')];

  while (queue.length) {
    const file = queue.pop() as string;

    if (seen.has(file)) continue;
    seen.add(file);

    let src: string;

    try {
      src = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    // Class name -> module file, from this file's import statements.
    const pathOf = new Map<string, string>();

    for (const m of src.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*'(\.[^']+\.module)'/g,
    )) {
      const target = resolve(file, '..', `${m[2]}.ts`);

      for (const name of m[1].split(',')) {
        const clean = name.trim();

        if (clean) pathOf.set(clean, target);
      }
    }

    // Only the modules actually listed in `imports: [...]` count.
    const importsBlock = arrayBody(src, 'imports');

    for (const m of importsBlock.matchAll(/(\w*Module)\b/g)) {
      const target = pathOf.get(m[1]);

      if (target) queue.push(target);
    }
  }

  return seen;
}

describe('every controller is reachable from AppModule', () => {
  const moduleFiles = reachableModuleFiles();

  // The union of `controllers: [...]` arrays across every reachable module.
  const registered = new Set<string>();

  for (const file of moduleFiles) {
    let src: string;

    try {
      src = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    const block = arrayBody(src, 'controllers');

    for (const name of block.matchAll(/(\w*Controller)\b/g)) {
      registered.add(name[1]);
    }
  }

  it('resolves a realistic module graph', () => {
    // Guards against the walker silently finding nothing and making the real
    // assertion below pass vacuously.
    expect(moduleFiles.size).toBeGreaterThan(50);
    expect(registered.size).toBeGreaterThan(100);
  });

  it('has no controller file that the graph never registers', () => {
    const orphans: string[] = [];

    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);

      if (INTENTIONALLY_UNREGISTERED.has(rel)) continue;

      const classes = controllerClasses(file);

      if (classes.length === 0) continue;

      // A file is covered when at least one of its controller classes is
      // registered. Files declaring several (e.g. heatmap declares a legacy
      // compatibility controller alongside the main one) are reported per class
      // below rather than here.
      if (!classes.some((c) => registered.has(c))) {
        orphans.push(`${rel} (${classes.join(', ')})`);
      }
    }

    // Named explicitly so a failure says WHICH module was forgotten, which is
    // the whole point: the previous failure mode was silence.
    expect(orphans).toEqual([]);
  });

  it('registers every individual controller class, not just one per file', () => {
    const missed: string[] = [];

    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);

      if (INTENTIONALLY_UNREGISTERED.has(rel)) continue;

      for (const cls of controllerClasses(file)) {
        if (!registered.has(cls)) missed.push(`${cls} (${rel})`);
      }
    }

    expect(missed.sort()).toEqual([]);
  });
});
