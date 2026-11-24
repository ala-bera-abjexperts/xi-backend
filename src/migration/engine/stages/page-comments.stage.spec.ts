/**
 * `page_comments` — ADF body flattening and inline anchoring.
 *
 * The comment body is rich ADF at the source but `wiki_page_comments.content` is plain text, so the
 * flattening is the whole fidelity story. And an inline comment's position CANNOT be carried across:
 * Confluence anchors on its own marker id plus character offsets, both of which the ADF to TipTap
 * transform invalidates, so the anchor keeps the selected TEXT instead.
 */

jest.mock('../../mappers/page.mapper', () => ({ PAGE_ENTITY: 'page' }));
// `WikiCommentsService` reaches sanitize-rich-text → jsdom, which this jest environment cannot load
// as ESM. Mocked exactly as the rest of the suite does; the flattener under test is pure.
jest.mock('../../../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (v: string | null | undefined) =>
    v == null ? null : String(v),
}));

import { adfToPlainText, buildAnchor } from './page-comments.stage';

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const t = (text: string) => ({ type: 'text', text });

describe('adfToPlainText', () => {
  it('reads a simple comment body', () => {
    expect(adfToPlainText(doc(para(t('Bitte hier praezisieren.'))))).toBe(
      'Bitte hier praezisieren.',
    );
  });

  it('accepts the JSON STRING the v2 API actually returns', () => {
    // `body.atlas_doc_format.value` is a string, not an object; parsing it here is not optional.
    expect(adfToPlainText(JSON.stringify(doc(para(t('aus dem String')))))).toBe(
      'aus dem String',
    );
  });

  it('keeps paragraphs apart instead of running them into one sentence', () => {
    const out = adfToPlainText(
      doc(para(t('Erste Zeile.')), para(t('Zweite Zeile.'))),
    );

    expect(out).toBe('Erste Zeile.\nZweite Zeile.');
  });

  it('pulls text out of nested lists and tables', () => {
    const out = adfToPlainText(
      doc({
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [para(t('Punkt eins'))] },
          { type: 'listItem', content: [para(t('Punkt zwei'))] },
        ],
      }),
    );

    expect(out).toContain('Punkt eins');
    expect(out).toContain('Punkt zwei');
  });

  it('keeps emoji and status labels, which live in attrs rather than a text child', () => {
    const out = adfToPlainText(
      doc(
        para(
          { type: 'emoji', attrs: { shortName: ':check:', text: '✅' } },
          t(' '),
          { type: 'status', attrs: { text: 'ERLEDIGT', color: 'green' } },
        ),
      ),
    );

    expect(out).toContain('✅');
    expect(out).toContain('ERLEDIGT');
  });

  it('returns empty for an unparseable or absent body rather than throwing', () => {
    // A comment that cannot be read must not fail the whole item; the stage skips empty bodies.
    expect(adfToPlainText('{not json')).toBe('');
    expect(adfToPlainText(undefined)).toBe('');
    expect(adfToPlainText(null)).toBe('');
  });

  it('collapses runaway blank lines from empty paragraphs', () => {
    const out = adfToPlainText(
      doc(para(t('oben')), para(), para(), para(), para(t('unten'))),
    );

    expect(out).toBe('oben\n\nunten');
  });
});

describe('buildAnchor', () => {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('emits the exact shape validateAnchor demands', () => {
    // A live run failed 14 of 15 comments on "anchor.type must be 'text-range'" because this shape
    // was guessed rather than read off the validator.
    const a = buildAnchor({
      selection: 'Ausgangslage',
      markerRef: '0a1db78a-4628-49a1-999e-27908f4974fb',
    });

    expect(a).toEqual({
      type: 'text-range',
      threadId: '0a1db78a-4628-49a1-999e-27908f4974fb',
      quotedText: 'Ausgangslage',
    });
  });

  it("reuses Confluence's inlineMarkerRef as the threadId, so a re-run maps to the same thread", () => {
    const ref = '0a1db78a-4628-49a1-999e-27908f4974fb';

    expect(buildAnchor({ selection: 'x', markerRef: ref }).threadId).toBe(ref);
    expect(buildAnchor({ selection: 'x', markerRef: ref }).threadId).toBe(ref);
  });

  it('generates a UUID when the marker is missing or not a UUID', () => {
    // `validateAnchor` rejects a non-UUID threadId outright, which would fail the whole comment.
    for (const markerRef of [undefined, 'not-a-uuid', '']) {
      const a = buildAnchor({ selection: 'x', markerRef });

      expect(String(a.threadId)).toMatch(UUID_RE);
    }
  });

  it('truncates quotedText to the 500 chars the validator allows', () => {
    const a = buildAnchor({ selection: 'a'.repeat(900) });

    expect(String(a.quotedText)).toHaveLength(500);
  });
});
