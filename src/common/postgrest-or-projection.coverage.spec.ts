/**
 * @fileoverview Guards a PostgREST rule that fails silently and catastrophically.
 * @module src/common/postgrest-or-projection.coverage
 * @author Prince Jadiya
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * On a MUTATION (`.update()` / `.delete()`), PostgREST resolves a logical tree —
 * `.or(...)` / `.and(...)` — against the RETURNING projection rather than the
 * plain WHERE clause. A column named in the tree but absent from `.select(...)`
 * is therefore unresolvable, and Postgres rejects the entire statement with
 * `42703: column <table>.<col> does not exist` — for a column that plainly does
 * exist. Simple filters (`.eq()`, `.lt()`) are unaffected, and SELECTs are
 * unaffected, so nothing about the schema or the read path hints at the problem.
 *
 * This cost the wiki collab snapshot writer every single save: the claim query
 * paired `.or('active_session_id...')` with `.select('seq')`, so the CAS update
 * always errored, the error was reported to clients as a bogus SEQ_CONFLICT
 * quoting their own seq, and editors silently never persisted.
 *
 * The rule: any column referenced inside `.or()` on a mutation chain must appear
 * in that chain's `.select()` (or the chain must project `*`).
 */
describe('PostgREST: .or() on a mutation must project its filter columns', () => {
  const SRC = path.join(__dirname, '..');

  function collectSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') collectSourceFiles(full, out);
      } else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts')
      ) {
        out.push(full);
      }
    }

    return out;
  }

  /** Comments routinely quote the very snippets this scan looks for. */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
  }

  it('never pairs .or() with a projection missing one of its columns', () => {
    const offenders: string[] = [];

    for (const file of collectSourceFiles(SRC)) {
      const source = stripComments(fs.readFileSync(file, 'utf-8'));
      const mutation = /\.(?:update|delete)\(/g;
      let match: RegExpExecArray | null;

      while ((match = mutation.exec(source)) !== null) {
        const end = source.indexOf(';', match.index);

        if (end === -1) continue;

        const chain = source.slice(match.index, end);

        if (!chain.includes('.or(')) continue;

        const columns = [
          ...chain.matchAll(/([a-z_]+)\.(?:eq|is|lt|gt|lte|gte|neq|in)\./g),
        ].map((m) => m[1]);

        if (columns.length === 0) continue;

        const select = /\.select\(\s*'([^']*)'/.exec(chain);
        const projected = select
          ? new Set(select[1].split(',').map((c) => c.trim()))
          : new Set(chain.includes('.select(') ? ['*'] : []);

        // No `.select()` at all means no RETURNING projection to clash with.
        if (projected.size === 0 || projected.has('*')) continue;

        const missing = [...new Set(columns)].filter((c) => !projected.has(c));

        if (missing.length > 0) {
          offenders.push(
            `${path.relative(SRC, file)}: .or() filters on [${missing.join(', ')}] ` +
              `but .select() projects only [${[...projected].join(', ')}]`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
