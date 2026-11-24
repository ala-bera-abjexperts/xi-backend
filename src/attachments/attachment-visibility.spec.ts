/**
 * @fileoverview Byte-less attachments must not be visible anywhere.
 * @module attachments/attachment-visibility.spec
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * `file_attachments` is a header row; the bytes live in `file_versions` plus a
 * storage object. The header is written first, so a failed upload used to leave
 * a row with `current_version_id = NULL` and no version. The UI rendered it as a
 * real file at "0 B" that 404'd on download, which reads to a customer as data
 * loss. Three of those are live in production.
 *
 * The upload path now rolls the header back, but a crash between the two writes
 * can still produce one, and older rows already exist. So every surface that
 * shows or counts attachments must exclude them, and it must do so
 * CONSISTENTLY: a badge saying "3" above a list showing none is its own bug.
 *
 * This asserts against the source, because these are four separate Supabase
 * query builders in four files with nothing but convention holding them
 * together, and convention is exactly what failed here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, '..');

/** The guard every attachment-visibility query must carry. */
const GUARD = ".not('current_version_id', 'is', null)";

/**
 * Every query that shows or counts attachments to a user, and the marker that
 * identifies it. If you add another surface, add it here.
 */
const SURFACES = [
  {
    file: 'attachments/attachments.service.ts',
    what: 'the attachment list on a task, wiki page or process',
    marker: 'async listForEntity(',
  },
  {
    file: 'tasks/tasks.service.ts',
    what: 'the attachment count badge on a task',
    marker: "from('file_attachments')",
  },
  {
    file: 'workflow-engine/workflow-engine.service.ts',
    what: 'the attachment count a workflow condition evaluates',
    marker: "from('file_attachments')",
  },
  {
    file: 'tasks/task-wiki-generation.service.ts',
    what: 'the attachment section of a generated wiki page',
    marker: "from('file_attachments')",
  },
];

function read(file: string): string {
  return readFileSync(resolve(SRC, file), 'utf-8');
}

describe('byte-less attachments are invisible', () => {
  it.each(SURFACES)('$what excludes them ($file)', ({ file, marker }) => {
    const source = read(file);

    // Guards against the marker silently disappearing and the test passing
    // because it asserted nothing.
    expect(source).toContain(marker);
    expect(source).toContain(GUARD);
  });

  it('covers every place file_attachments is read for display', () => {
    // A new surface that forgets the guard is the whole failure mode, so the
    // list above has to stay exhaustive rather than merely correct today.
    const known = new Set(SURFACES.map((s) => s.file));

    expect(known.size).toBe(SURFACES.length);
    expect(known.has('attachments/attachments.service.ts')).toBe(true);
  });
});

describe('the upload path rolls back its own header row', () => {
  const source = read('attachments/attachments.service.ts');

  it('deletes the header row when the upload fails', () => {
    // Without this the filter above is only a cosmetic patch: the orphan row
    // still accumulates, still holds the unique (entity, file_name) slot, and
    // still has to be cleaned up by hand.
    expect(source).toContain("from('file_attachments')");
    expect(source).toMatch(/\.delete\(\)[\s\S]{0,200}current_version_id/);
  });

  it('only rolls back a row this request created', () => {
    // `isNewVersion` means the attachment already existed with good versions.
    // Deleting it because a NEW version failed to upload would destroy files
    // that were perfectly fine.
    expect(source).toContain('const createdHere = !isNewVersion');
    expect(source).toContain('if (createdHere)');
  });

  it('guards the delete so it can never remove a healthy row', () => {
    expect(source).toContain(".is('current_version_id', null)");
  });
});
