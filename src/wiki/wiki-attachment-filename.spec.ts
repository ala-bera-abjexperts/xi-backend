// wiki.service transitively imports sanitize-rich-text, which pulls in jsdom (ESM) that ts-jest
// cannot transform. Stub the sanitizer (identity), matching wiki.controller.spec.ts.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import { WikiService } from './wiki.service';

/**
 * Non-ASCII attachment filenames, for BOTH ingress paths.
 *
 * `WikiService.createAttachment` is the single funnel: the browser reaches it through
 * `FileInterceptor` (whose multer decoding is fixed by MultipartEncodingModule), and the Atlassian
 * migration reaches it by hand-building a Multer-shaped object in
 * `migration/engine/stages/page-attachments.stage.ts`:
 *
 *     const file = { buffer, originalname: attachment.filename, mimetype, size, ... }
 *     await this.wiki.createAttachment(wikiPageId, spaceId, file, actingUser)
 *
 * So a migrated attachment never passes through multer at all. Pinning the behaviour here covers
 * both routes at once, and guarantees the two halves stay consistent:
 *
 *   * `file_name`  keeps the filename EXACTLY as given (umlauts, CJK, emoji) — it is what the user
 *     reads in the UI.
 *   * the storage KEY is ASCII-sanitised — a raw umlaut reaches Supabase Storage verbatim and the
 *     upload fails outright.
 */
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const SPACE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

interface Captured {
  storagePath?: string;
  contentType?: string;
  bytes?: Buffer;
  storagePaths?: string[];
  failAtUpload?: number;
  removed?: string[];
  inserted?: Record<string, unknown>;
}

function buildService(captured: Captured) {
  const uploader = {
    upload: jest.fn(
      (path: string, bytes: Buffer, options: { contentType: string }) => {
        captured.contentType = options.contentType;
        captured.bytes = bytes;
        captured.storagePath = path;
        captured.storagePaths = [...(captured.storagePaths ?? []), path];
        return Promise.resolve({
          error:
            captured.failAtUpload === captured.storagePaths.length
              ? { message: 'preview write failed' }
              : null,
        });
      },
    ),
    remove: jest.fn((paths: string[]) => {
      captured.removed = paths;
      return Promise.resolve({ error: null });
    }),
    // Mirrors storage-js: a `download` option becomes a ?download= query on the public URL.
    getPublicUrl: (path: string, options?: { download?: string }) => ({
      data: {
        publicUrl:
          `https://storage.test/${path}` +
          (options?.download
            ? `?download=${encodeURIComponent(options.download)}`
            : ''),
      },
    }),
  };

  const client = {
    storage: { from: () => uploader },
    from: (table: string) => {
      if (table === 'wiki_pages') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: { id: PAGE_ID, space_id: SPACE_ID },
                    error: null,
                  }),
              }),
            }),
          }),
        };
      }

      // wiki_page_attachments. createAttachment now looks up the newest existing version of
      // the filename before inserting (XE-T542), so this branch answers both shapes:
      // `.select(...).eq().eq().order().limit().maybeSingle()` → no prior version, and the
      // insert. `.update(...)` is only reached when a prior version exists.
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }),
        }),
        update: () => ({
          eq: () => ({
            eq: () => ({
              neq: () => Promise.resolve({ error: null }),
            }),
          }),
        }),
        insert: (row: Record<string, unknown>) => {
          captured.inserted = row;

          return {
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: 'att-1', ...row },
                  error: null,
                }),
            }),
          };
        },
      };
    },
  };

  return new WikiService(
    { getClient: () => client } as never,
    {} as never,
    {} as never,
  );
}

/** Exactly the object the migration stage hands to createAttachment. */
function migrationFile(filename: string) {
  return {
    buffer: Buffer.from('%PDF-1.4'),
    originalname: filename,
    mimetype: 'application/pdf',
    size: 8,
    fieldname: 'file',
    encoding: '7bit',
  } as Express.Multer.File;
}

describe('WikiService.createAttachment — non-ASCII filenames', () => {
  it('keeps the German filename from the bug report intact, with an ASCII storage key', async () => {
    const captured: Captured = {};
    const service = buildService(captured);
    const filename = 'Mag Eckschlager Gründung XISUITE GmbH.pdf';

    await service.createAttachment(
      PAGE_ID,
      SPACE_ID,
      migrationFile(filename),
      USER_ID,
    );

    // Display name: byte-for-byte, no mojibake.
    expect(captured.inserted?.file_name).toBe(filename);
    expect(String(captured.inserted?.file_name)).not.toContain('Ã');

    // Storage key: ASCII only, so Supabase Storage accepts it.
    expect(captured.storagePath).toBeDefined();
    expect(captured.storagePath).toMatch(/^wiki\/[0-9a-f-]+\/\d+-[\w.-]+$/);
    // eslint-disable-next-line no-control-regex
    expect(captured.storagePath).not.toMatch(/[^\x00-\x7F]/);
    // storageSafeFileName folds accents to base letters (ü → u), keeping the key readable.
    expect(captured.storagePath).toContain('Grundung');
  });

  it.each([
    ['umlauts', 'Übersicht Größe.pdf'],
    ['cyrillic', 'отчёт.pdf'],
    ['cjk', '報告書.pdf'],
    ['emoji', 'Bericht 🗓.pdf'],
    ['french accents', 'Résumé café.pdf'],
  ])(
    'preserves %s in file_name while keeping the key ASCII',
    async (_label, filename) => {
      const captured: Captured = {};
      const service = buildService(captured);

      await service.createAttachment(
        PAGE_ID,
        SPACE_ID,
        migrationFile(filename),
        USER_ID,
      );

      expect(captured.inserted?.file_name).toBe(filename);
      // eslint-disable-next-line no-control-regex
      expect(captured.storagePath).not.toMatch(/[^\x00-\x7F]/);
    },
  );

  it('keeps the extension so the stored key stays recognisable', async () => {
    const captured: Captured = {};
    const service = buildService(captured);

    await service.createAttachment(
      PAGE_ID,
      SPACE_ID,
      migrationFile('Jahresabschluss Prüfung.pdf'),
      USER_ID,
    );

    expect(captured.storagePath?.endsWith('.pdf')).toBe(true);
  });

  /**
   * `storageSafeFileName` folds accents to base letters (ü → u, ö → o), so `Grüße.pdf` and
   * `Größe.pdf` now stay distinguishable in the bucket (`Gru_e.pdf` vs `Gro_e.pdf` — only `ß`,
   * which has no decomposition, becomes `_`). Key uniqueness still comes from the `Date.now()`
   * prefix, and `upsert: false` errors on a genuine collision rather than overwriting.
   */
  it('keeps distinct accented names distinguishable in the sanitised key', async () => {
    const a: Captured = {};
    const b: Captured = {};

    await buildService(a).createAttachment(
      PAGE_ID,
      SPACE_ID,
      migrationFile('Grüße.pdf'),
      USER_ID,
    );
    await buildService(b).createAttachment(
      PAGE_ID,
      SPACE_ID,
      migrationFile('Größe.pdf'),
      USER_ID,
    );

    expect(a.storagePath?.split('-').pop()).toBe('Gru_e.pdf');
    expect(b.storagePath?.split('-').pop()).toBe('Gro_e.pdf');

    // The display names stay byte-for-byte intact, which is what the user actually sees.
    expect(a.inserted?.file_name).toBe('Grüße.pdf');
    expect(b.inserted?.file_name).toBe('Größe.pdf');
  });

  it('stores a clean public URL without a download disposition', async () => {
    // The stored URL is what page previews (PDF iframes) and attachments lists render.
    // A `?download=` disposition baked into it made every page open download the file
    // instead of rendering it inline. The original name still reaches the user: the row
    // keeps `file_name`, and the frontend appends `?download=<file_name>` at click time
    // on the explicit download action (Storage honors the query param cross-origin).
    const captured: Captured = {};
    const service = buildService(captured);

    const row = (await service.createAttachment(
      PAGE_ID,
      SPACE_ID,
      migrationFile('Überblick.pdf'),
      USER_ID,
    )) as { file_path: string; file_name: string };

    expect(row.file_path).not.toContain('download=');
    expect(row.file_path).toBe(`https://storage.test/${captured.storagePath}`);
    expect(row.file_name).toBe('Überblick.pdf');
  });

  it('stores a canonical migration calendar date when supplied', async () => {
    const captured: Captured = {};

    await buildService(captured).createAttachment(
      PAGE_ID,
      SPACE_ID,
      migrationFile('source-dated.pdf'),
      USER_ID,
      '2024-02-29T00:00:00.000Z',
    );

    expect(captured.inserted?.created_at).toBe('2024-02-29T00:00:00.000Z');
  });

  it('stores a derived preview beside a migrated legacy DOC while preserving its original row', async () => {
    const captured: Captured = {};
    await buildService(captured).createAttachment(
      PAGE_ID,
      SPACE_ID,
      {
        ...migrationFile('legacy.doc'),
        mimetype: 'application/msword',
      } as never,
      USER_ID,
      undefined,
      {
        buffer: Buffer.from('PK\x03\x04preview'),
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: 'legacy.docx',
      },
    );

    expect(captured.storagePaths).toHaveLength(2);
    expect(captured.inserted?.file_path).toContain('legacy.doc');
    expect(captured.inserted?.preview_file_path).toContain('legacy.docx');
  });

  it('removes the original object if the newly-created preview cannot be uploaded', async () => {
    const captured: Captured = { failAtUpload: 2 };
    await expect(
      buildService(captured).createAttachment(
        PAGE_ID,
        SPACE_ID,
        migrationFile('legacy.doc'),
        USER_ID,
        undefined,
        {
          buffer: Buffer.from('PK\x03\x04preview'),
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          filename: 'legacy.docx',
        },
      ),
    ).rejects.toThrow('Preview storage upload failed');

    expect(captured.removed).toEqual([captured.storagePaths?.[0]]);
    expect(captured.inserted).toBeUndefined();
  });

  it('leaves created_at to the database default for a normal upload', async () => {
    const captured: Captured = {};

    await buildService(captured).createAttachment(
      PAGE_ID,
      SPACE_ID,
      migrationFile('normal-upload.pdf'),
      USER_ID,
    );

    expect(captured.inserted).not.toHaveProperty('created_at');
  });
});

it.each([
  [
    'report.xls',
    'Application/Vnd.Ms-Excel; charset=utf-8',
    'application/vnd.ms-excel',
  ],
  [
    'report.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  ['report.xls', 'invalid content type', 'application/octet-stream'],
  ['image.svg', ' IMAGE/SVG+XML; charset=utf-8 ', 'application/octet-stream'],
])(
  'normalizes current attachment %s without changing bytes',
  async (filename, mime, expected) => {
    const captured: Captured = {};
    const bytes = Buffer.from([0, 255, 17, 128]);
    await buildService(captured).createAttachment(
      PAGE_ID,
      SPACE_ID,
      {
        ...migrationFile(filename),
        buffer: bytes,
        mimetype: mime,
      } as never,
      USER_ID,
    );
    expect(captured.contentType).toBe(expected);
    expect(captured.bytes).toBe(bytes);
    expect(captured.inserted?.file_name).toBe(filename);
  },
);
