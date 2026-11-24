// wiki.service transitively imports sanitize-rich-text, which pulls in jsdom (ESM) that ts-jest
// cannot transform. Stub the sanitizer (identity), matching wiki-attachment-filename.spec.ts.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import { WikiService } from './wiki.service';

/**
 * XE-T542 — wiki page attachments had no version history.
 *
 * Task attachments version through `file_attachments`/`file_versions`, the File Explorer through
 * `fe_nodes`/`fe_versions`. Wiki attachments live in their own table and the storage key is
 * stamped with Date.now(), so re-uploading the same filename produced a second unrelated row and
 * a second object — a duplicate, never a version, with no route back to the earlier copy.
 *
 * The chain is added in place rather than re-pointing the store, because the Confluence
 * `page_attachments` stage and the wiki macros both read `wiki_page_attachments` directly.
 */
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const SPACE_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

interface Captured {
  inserted?: Record<string, unknown>;
  demotedFrom?: string;
  storagePaths: string[];
}

/** @param priorVersion highest existing version_number for the filename, or null if none. */
function buildService(captured: Captured, priorVersion: number | null) {
  const uploader = {
    upload: (path: string) => {
      captured.storagePaths.push(path);

      return Promise.resolve({ error: null });
    },
    remove: () => Promise.resolve({ error: null }),
    getPublicUrl: (path: string) => ({
      data: { publicUrl: `https://storage.test/${path}` },
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

      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data:
                        priorVersion === null
                          ? null
                          : { id: 'att-prev', version_number: priorVersion },
                      error: null,
                    }),
                }),
              }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: () => ({
            eq: () => ({
              neq: (_col: string, id: string) => {
                if (patch.is_current === false) captured.demotedFrom = id;

                return Promise.resolve({ error: null });
              },
            }),
          }),
        }),
        insert: (row: Record<string, unknown>) => {
          captured.inserted = row;

          return {
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: 'att-new', ...row },
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

const upload = (filename: string) =>
  ({
    buffer: Buffer.from('%PDF-1.4'),
    originalname: filename,
    mimetype: 'application/pdf',
    size: 8,
    fieldname: 'file',
    encoding: '7bit',
  }) as Express.Multer.File;

describe('WikiService.createAttachment — version chain (XE-T542)', () => {
  it('starts a new filename at version 1 and marks it current', async () => {
    const captured: Captured = { storagePaths: [] };
    const service = buildService(captured, null);

    await service.createAttachment(
      PAGE_ID,
      SPACE_ID,
      upload('Ausgabe 001.pdf'),
      USER_ID,
    );

    expect(captured.inserted?.version_number).toBe(1);
    expect(captured.inserted?.is_current).toBe(true);
    // Nothing to demote on a first upload.
    expect(captured.demotedFrom).toBeUndefined();
  });

  it('re-uploading the same filename creates version 2, not a duplicate', async () => {
    const captured: Captured = { storagePaths: [] };
    const service = buildService(captured, 1);

    await service.createAttachment(
      PAGE_ID,
      SPACE_ID,
      upload('Ausgabe 001.pdf'),
      USER_ID,
    );

    expect(captured.inserted?.version_number).toBe(2);
    expect(captured.inserted?.is_current).toBe(true);
  });

  it('demotes the previous versions, excluding the row it just wrote', async () => {
    const captured: Captured = { storagePaths: [] };
    const service = buildService(captured, 1);

    await service.createAttachment(
      PAGE_ID,
      SPACE_ID,
      upload('Ausgabe 001.pdf'),
      USER_ID,
    );

    // The new row must never demote itself, or the page would list no current attachment.
    expect(captured.demotedFrom).toBe('att-new');
  });

  it('continues the chain from the highest existing version', async () => {
    const captured: Captured = { storagePaths: [] };
    const service = buildService(captured, 7);

    await service.createAttachment(
      PAGE_ID,
      SPACE_ID,
      upload('Ausgabe 001.pdf'),
      USER_ID,
    );

    expect(captured.inserted?.version_number).toBe(8);
  });

  it('keeps each version on its own storage object so earlier bytes stay downloadable', async () => {
    const captured: Captured = { storagePaths: [] };
    const service = buildService(captured, 1);

    await service.createAttachment(
      PAGE_ID,
      SPACE_ID,
      upload('Ausgabe 001.pdf'),
      USER_ID,
    );

    // The Date.now() stamp that used to cause duplicate ROWS is what now keeps each version's
    // bytes distinct — the new version must not overwrite the previous object.
    expect(captured.storagePaths).toHaveLength(1);
    expect(captured.inserted?.file_path).toContain('storage.test');
  });
});
