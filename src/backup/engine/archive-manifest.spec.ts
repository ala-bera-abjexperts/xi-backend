/**
 * @fileoverview Tests for the archive README and manifest.
 * @module src/backup/engine/archive-manifest.spec
 *
 * These exist because of a real support question: "I selected SQL but the backup is NDJSON." It was
 * not — the SQL was one folder away in `export/` — but nothing inside the archive said so. The
 * assertions below are mostly about whether the archive answers that question by itself.
 *
 * The other half is honesty: a manifest that reports success over a partial archive turns a
 * visibly incomplete backup into an invisibly incomplete one.
 */

import {
  buildManifest,
  buildReadme,
  type ManifestInput,
} from './archive-manifest';

const BASE: ManifestInput = {
  runId: 'run-1',
  organizationId: 'org-1',
  schemeVersion: 3,
  formats: ['sql'],
  encrypted: true,
  createdAt: new Date('2026-08-04T14:00:29.868Z'),
  tables: [
    {
      table: 'tasks',
      rows: 200,
      members: [
        {
          name: 'data/03-tasks.sql',
          format: 'sql' as const,
          sha256: 'a'.repeat(64),
        },
      ],
      status: 'succeeded',
    },
    {
      table: 'spaces',
      rows: 51,
      members: [
        {
          name: 'data/02-spaces.sql',
          format: 'sql' as const,
          sha256: 'b'.repeat(64),
        },
      ],
      status: 'succeeded',
    },
  ],
  filesCopied: 0,
  missingObjects: [],
};

function manifestOf(input: ManifestInput): Record<string, unknown> {
  return JSON.parse(buildManifest(input)) as Record<string, unknown>;
}

describe('archive README', () => {
  it('describes exactly one layer, in the chosen format', () => {
    const readme = buildReadme(BASE);

    // One layer. `export/` no longer exists — an archive holds the format that was selected and
    // nothing else, which is the whole point of this file.
    expect(readme).toContain('data/');
    expect(readme).not.toContain('export/');
    expect(readme).toMatch(/One \.sql file per table/);
    expect(readme).toMatch(/the only copy in this archive/);
  });

  it('gives the psql command for a SQL archive', () => {
    expect(buildReadme(BASE)).toContain(
      'for f in data/*.sql; do psql -f "$f"; done',
    );
  });

  it('says a SQL archive can be restored by the app', () => {
    const readme = buildReadme(BASE);

    // SQL used to be the format that could not be read back, which made the default archive an
    // export rather than a restore point. sql.reader.ts changed that, and the README has to say so
    // — an operator mid-incident should not be told to reach for psql when they need not.
    expect(readme).toContain('HOW TO RESTORE THIS');
    expect(readme).toMatch(/can read this archive directly/);
    expect(readme).not.toMatch(/cannot read this archive/);
  });

  it('says plainly that a CSV archive cannot be restored by the app', () => {
    const readme = buildReadme({ ...BASE, formats: ['csv'] });

    // Someone recovering from an incident must not discover this halfway through.
    expect(readme).toContain('HOW TO RESTORE THIS');
    expect(readme).toMatch(/cannot read this archive/);
    expect(readme).toMatch(/choose NDJSON or JSON/);
  });

  it('says a NDJSON archive can be restored by the app', () => {
    const readme = buildReadme({ ...BASE, formats: ['ndjson'] });

    expect(readme).toMatch(/can read this archive directly/);
    expect(readme).not.toMatch(/cannot read this archive/);
  });

  it('mentions no export layer when NDJSON was chosen', () => {
    const readme = buildReadme({ ...BASE, formats: ['ndjson'] });

    // There is no export/ folder in that archive, so describing one would be a lie.
    expect(readme).not.toContain('export/');
    expect(readme).toContain('data/');
  });

  it('points an encrypted archive at the download flow that can open it', () => {
    const readme = buildReadme(BASE);

    // The CLI this used to name no longer exists. A README that tells an operator to run a command
    // the product does not ship is worse than saying nothing, because it reads as a dead end.
    expect(readme).toContain('Browse archives');
    expect(readme).toContain('passphrase');
    expect(readme).not.toContain('backup:decrypt');
  });

  it('says nothing about decryption on a plain archive', () => {
    expect(buildReadme({ ...BASE, encrypted: false })).not.toContain(
      'ENCRYPTION',
    );
  });

  it('warns loudly when a table did not export cleanly', () => {
    const readme = buildReadme({
      ...BASE,
      tables: [
        ...BASE.tables,
        { table: 'wiki_pages', rows: 0, members: [], status: 'failed' },
      ],
    });

    expect(readme).toContain('WARNING');
    expect(readme).toContain('wiki_pages');
    expect(readme).toContain('incomplete');
  });

  it('reports files that a row referenced but storage did not hold', () => {
    const readme = buildReadme({
      ...BASE,
      filesCopied: 11,
      missingObjects: ['org/file-explorer/gone.pdf'],
    });

    expect(readme).toContain('files/');
    expect(readme).toContain('INCOMPLETE');
    expect(readme).toContain('not a fault in the backup');
  });
});

describe('archive manifest.json', () => {
  it('names the single layer and its format explicitly', () => {
    const manifest = manifestOf(BASE);

    expect(manifest.layer).toBe('data/');
    expect(manifest.format).toBe('sql');
    // The two-layer fields are gone; a reader still expecting them must fail, not guess.
    expect(manifest.restore_layer).toBeUndefined();
    expect(manifest.readable_layer).toBeUndefined();
  });

  it('flags restorability rather than leaving it to be inferred', () => {
    // A reader must never infer this from the file extension.
    expect(manifestOf(BASE).app_restorable).toBe(true);
    expect(manifestOf({ ...BASE, formats: ['csv'] }).app_restorable).toBe(
      false,
    );
    expect(manifestOf({ ...BASE, formats: ['ndjson'] }).app_restorable).toBe(
      true,
    );
    expect(manifestOf({ ...BASE, formats: ['json'] }).app_restorable).toBe(
      true,
    );
    expect(manifestOf({ ...BASE, formats: ['csv'] }).app_restorable).toBe(
      false,
    );
    expect(manifestOf({ ...BASE, formats: ['xlsx'] }).app_restorable).toBe(
      false,
    );
  });

  it('totals rows from the recorded tables, never from a separate counter', () => {
    const manifest = manifestOf(BASE);

    // Derived, so it cannot disagree with the per-table list beside it.
    expect(manifest.row_count).toBe(251);
    expect(manifest.table_count).toBe(2);
  });

  it('carries each table checksum for verification', () => {
    const tables = manifestOf(BASE).tables as {
      members: { sha256: string }[];
    }[];

    expect(tables.map((t) => t.members[0].sha256)).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
    ]);
  });

  it('records a checksum per layer, not per table', () => {
    const manifest = manifestOf({
      ...BASE,
      formats: ['sql', 'ndjson'],
      tables: [
        {
          table: 'tasks',
          rows: 200,
          members: [
            {
              name: 'data/03-tasks.sql',
              format: 'sql' as const,
              sha256: 'a'.repeat(64),
            },
            {
              name: 'data/tasks.ndjson',
              format: 'ndjson' as const,
              sha256: 'c'.repeat(64),
            },
          ],
          status: 'succeeded',
        },
      ],
    });

    const tables = manifest.tables as {
      members: { name: string; sha256: string }[];
    }[];

    // A restore verifies the member it actually opens, so each layer needs its own digest —
    // one per table would be ambiguous the moment data/ holds two copies.
    expect(tables[0].members.map((m) => m.name)).toEqual([
      'data/03-tasks.sql',
      'data/tasks.ndjson',
    ]);
    expect(new Set(tables[0].members.map((m) => m.sha256)).size).toBe(2);
  });

  it('counts tables and rows once however many layers there are', () => {
    const single = manifestOf(BASE);
    const layered = manifestOf({
      ...BASE,
      formats: ['sql', 'ndjson', 'csv'],
      tables: BASE.tables.map((table) => ({
        ...table,
        members: [
          ...table.members,
          {
            name: `data/${table.table}.ndjson`,
            format: 'ndjson' as const,
            sha256: 'd'.repeat(64),
          },
          {
            name: `data/${table.table}.csv`,
            format: 'csv' as const,
            sha256: 'e'.repeat(64),
          },
        ],
      })),
    });

    // Three layers of two tables is still two tables and the same rows. Flattening members into
    // one entry each would have reported six tables and triple the rows.
    expect(layered.table_count).toBe(single.table_count);
    expect(layered.row_count).toBe(single.row_count);
  });

  it('names every layer, and the restorable one as the scalar format', () => {
    const manifest = manifestOf({ ...BASE, formats: ['csv', 'ndjson'] });

    expect(manifest.formats).toEqual(['csv', 'ndjson']);
    expect(manifest.app_restorable).toBe(true);

    // A reader written before archives could hold several layers takes this scalar and decides
    // from it alone. Naming the readable layer means it accepts an archive it can actually read,
    // rather than judging the whole file by its first, unreadable layer.
    expect(manifest.format).toBe('ndjson');
  });

  it('records a failed table as failed', () => {
    const manifest = manifestOf({
      ...BASE,
      tables: [{ table: 'tasks', rows: 0, members: [], status: 'failed' }],
    });
    const tables = manifest.tables as { status: string }[];

    expect(tables[0].status).toBe('failed');
  });

  it('caps the missing-object list but keeps the true count', () => {
    const many = Array.from({ length: 250 }, (_, i) => `org/missing-${i}.pdf`);
    const manifest = manifestOf({ ...BASE, missingObjects: many });

    // A tenant with a systemic problem must not turn its manifest into megabytes of paths.
    expect((manifest.missing_objects as string[]).length).toBe(100);
    expect(manifest.missing_object_count).toBe(250);
  });

  it('is valid JSON ending in a newline', () => {
    const text = buildManifest(BASE);

    expect(text.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(text) as unknown).not.toThrow();
  });
});
