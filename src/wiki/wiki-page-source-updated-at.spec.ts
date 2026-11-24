// wiki.service transitively imports sanitize-rich-text, which pulls in jsdom (ESM) that ts-jest
// cannot transform. Stub the sanitizer (identity), matching wiki-attachment-filename.spec.ts.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import { WikiService } from './wiki.service';

/**
 * XE-T552 — a migrated wiki page showed "Updated: <import time>" instead of the source page's
 * last-modified date.
 *
 * `updated_at` cannot carry the source date: `handle_updated_at()` is a shared BEFORE UPDATE
 * trigger that unconditionally sets it to NOW(), and several Confluence stages update the page
 * after `pages` inserts it. So the date lands in a dedicated `source_updated_at` column, passed
 * as a service option rather than a DTO field, so the public create endpoint cannot set it.
 */
const SPACE_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '33333333-3333-4333-8333-333333333333';

interface Captured {
  inserted?: Record<string, unknown>;
}

function buildService(captured: Captured) {
  const client = {
    // createPage writes twice: the page row, then an audit_logs row. Capture only the page,
    // otherwise the audit insert overwrites it.
    from: (table: string) => ({
      // ensureUniqueSlug probes for an existing slug — report "free".
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          limit: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
      insert: (row: Record<string, unknown>) => {
        if (table === 'wiki_pages') captured.inserted = row;

        return {
          select: () => ({
            single: () =>
              Promise.resolve({
                data: { id: 'page-1', title: row.title, is_published: false },
                error: null,
              }),
          }),
        };
      },
    }),
  };

  return new WikiService(
    { getClient: () => client } as never,
    {} as never,
    { assertKeysAllowed: () => Promise.resolve() } as never,
  );
}

const dto = {
  space_id: SPACE_ID,
  title: 'Diverse Formulare und Vorlagen',
  content: JSON.stringify({ type: 'doc', content: [] }),
  content_format: 'tiptap',
} as never;

describe('WikiService.createPage — source_updated_at (XE-T552)', () => {
  it('writes the source last-modified instant when the migration supplies one', async () => {
    const captured: Captured = {};
    const service = buildService(captured);

    await service.createPage(dto, ORG_ID, USER_ID, {
      sourceUpdatedAt: '2026-04-22T09:15:30.000Z',
    });

    expect(captured.inserted?.source_updated_at).toBe(
      '2026-04-22T09:15:30.000Z',
    );
  });

  it('keeps the full instant rather than truncating to a calendar day', async () => {
    // The wiki meta line renders with toLocaleString(); a day-truncated value (the shape
    // canonicalSourceAttachmentDate produces for attachments) would show every migrated page
    // as modified at 00:00.
    const captured: Captured = {};
    const service = buildService(captured);

    await service.createPage(dto, ORG_ID, USER_ID, {
      sourceUpdatedAt: '2026-04-22T09:15:30.000Z',
    });

    expect(captured.inserted?.source_updated_at).not.toMatch(
      /T00:00:00\.000Z$/,
    );
  });

  it('omits the column entirely for a page created in XISUITE', async () => {
    const captured: Captured = {};
    const service = buildService(captured);

    await service.createPage(dto, ORG_ID, USER_ID);

    expect(captured.inserted).not.toHaveProperty('source_updated_at');
  });

  it('never lets updated_at be set from the migration — the trigger owns it', async () => {
    const captured: Captured = {};
    const service = buildService(captured);

    await service.createPage(dto, ORG_ID, USER_ID, {
      sourceUpdatedAt: '2026-04-22T09:15:30.000Z',
    });

    expect(captured.inserted).not.toHaveProperty('updated_at');
  });

  it('rejects a non-date value instead of writing garbage', async () => {
    const captured: Captured = {};
    const service = buildService(captured);

    await expect(
      service.createPage(dto, ORG_ID, USER_ID, {
        sourceUpdatedAt: 'last Tuesday',
      }),
    ).rejects.toThrow(/ISO-8601/);

    expect(captured.inserted).toBeUndefined();
  });
});
