/**
 * @fileoverview Confluence storage-XHTML anchors that carry no usable href.
 *
 * Regression cover for the import that cost a customer 214 of their 216 pages.
 * Word-exported documents pasted into Confluence are full of BOOKMARK TARGETS —
 * `<a name="_Toc123">Kapitel 3</a>` — which are anchors with no `href` at all.
 * The parser defaulted the missing attribute to `''` and emitted a link node
 * anyway; `validateTipTapDoc` refuses an empty href, and it refuses the WHOLE
 * document, so a single such anchor failed the entire page write.
 *
 * The contract now: an anchor with nothing to point at contributes its TEXT and
 * no link. Asserted at the storage layer because that is the shape the customer's
 * Confluence actually served — the CIR and write-gate layers are covered by
 * `cir-to-tiptap.spec.ts` and `tiptap-sanitizer.spec.ts` respectively.
 * @module src/migration/transformers/storage-anchor.spec
 */

// jsdom loads fine here, but `tiptap-sanitizer` pulls in `sanitize-rich-text`,
// which the rest of the suite mocks exactly this way.
jest.mock('../../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (v: string | null | undefined) =>
    v == null ? null : String(v),
}));

import { storageToCir } from './storage-format-to-html';
import { cirToTipTap } from './cir-to-tiptap';
import type { CirResolved } from './cir-serializer';
import { validateTipTapDoc } from '../../common/utils/tiptap-sanitizer';

const hooks = { onMacro: () => null };

const resolved: CirResolved = {
  users: new Map(),
  pages: new Map(),
  attachments: new Map(),
  nativeTables: true,
};

/** storage XHTML → CIR → TipTap → the real write gate. */
const migrate = (xhtml: string) =>
  validateTipTapDoc(
    JSON.stringify(cirToTipTap(storageToCir(xhtml, hooks), resolved)),
  ).json;

describe('storage anchors without a usable href', () => {
  it('keeps the text of a Word bookmark target and emits no link', () => {
    const out = migrate('<p><a name="_Toc123">Kapitel 3</a></p>');

    expect(out).toContain('Kapitel 3');
    expect(out).not.toContain('"type":"link"');
  });

  it.each([
    ['no href attribute', '<a name="_Toc1">Kapitel 3</a>'],
    ['empty href', '<a href="">Kapitel 3</a>'],
    ['whitespace-only href', '<a href="   ">Kapitel 3</a>'],
  ])('does not fail the page — %s', (_label, anchor) => {
    // The whole point: this must not throw. Before the fix each of these took
    // the entire page down with it.
    const out = migrate(`<p>vor ${anchor} nach</p>`);

    expect(out).toContain('Kapitel 3');
    // Surrounding prose is untouched on both sides.
    expect(out).toContain('vor ');
    expect(out).toContain(' nach');
  });

  it('still emits a real link when the anchor HAS an href', () => {
    const out = migrate('<p><a href="https://example.com">hier</a></p>');

    expect(out).toContain('"type":"link"');
    expect(out).toContain('https://example.com');
    expect(out).toContain('hier');
  });

  it.each([
    ['in-page anchor', '#abschnitt-3'],
    ['space-relative', '/display/DEV/Seite'],
    ['mailto', 'mailto:info@example.com'],
  ])('leaves a valid non-http href alone — %s', (_label, href) => {
    const out = migrate(`<p><a href="${href}">Link</a></p>`);

    expect(out).toContain(href);
  });

  it('survives a page whose every paragraph carries a bookmark anchor', () => {
    // The customer's shape: the construct was on nearly every page, which is why
    // the failure looked like "the whole space is too big to migrate".
    const body = Array.from(
      { length: 50 },
      (_, i) => `<p><a name="_Toc${i}">Abschnitt ${i}</a> Inhalt ${i}</p>`,
    ).join('');
    const out = migrate(body);

    expect(out).toContain('Abschnitt 0');
    expect(out).toContain('Abschnitt 49');
    expect(out).not.toContain('"type":"link"');
  });
});
