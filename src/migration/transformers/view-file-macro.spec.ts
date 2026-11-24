/**
 * @fileoverview Unit tests for the Confluence `view-file` macro (XE-T456).
 *
 * `view-file` embeds one attached document (PDF, Office doc, zip) as a download card.
 * Before this handler existed it fell through to the unsupported branch and imported
 * pages showed the literal text `[Unsupported macro: view-file]`.
 *
 * Two things are load-bearing and easy to regress, so both are asserted here:
 *
 * 1. It emits a `media` node, NOT a bespoke node type. `collectRefs` only harvests
 *    `attachmentFilenames` from `media`, and `resolveRefs` is skipped entirely when that
 *    set is empty — a custom type would never get its filename mapped to a Storage URL,
 *    and the card would render permanently unresolved.
 * 2. `kind: 'file'` distinguishes it from an image so the serializers emit a download
 *    card instead of an <img> for a PDF.
 *
 * @module src/migration/transformers/view-file-macro.spec
 */

import type { CirDoc, ParsedMacro } from './canonical-ir';
import { collectRefs } from './canonical-ir';
import { renderMacro } from './macros/macro-registry';
import { cirToTipTap } from './cir-to-tiptap';
import { cirToHtml, type CirResolved } from './cir-serializer';

/** A resolved crosswalk, as the attachments stage would supply it. */
const resolvedWith = (entries: [string, string][]): CirResolved => ({
  users: new Map(),
  pages: new Map(),
  attachments: new Map(entries),
  nativeTables: true,
});

const docFrom = (macroName: string, params: Record<string, string>): CirDoc =>
  ({
    children: [renderMacro(macro(macroName, { params }), {})],
  }) as unknown as CirDoc;

const macro = (name: string, over: Partial<ParsedMacro> = {}): ParsedMacro => ({
  name,
  params: {},
  richBody: [],
  plainBody: '',
  ...over,
});

describe('view-file macro', () => {
  it('maps an attachment filename to a file-kind media node', () => {
    const node = renderMacro(
      macro('view-file', { params: { name: 'Spec.pdf' } }),
      {},
    );

    expect(node).toEqual({
      type: 'media',
      kind: 'file',
      filename: 'Spec.pdf',
      sourceMacro: 'view-file',
      sourceParams: { name: 'Spec.pdf' },
      sourceBody: '',
    });
  });

  it('no longer renders the unsupported placeholder', () => {
    const node = renderMacro(
      macro('view-file', { params: { name: 'Spec.pdf' } }),
      {},
    );

    expect(JSON.stringify(node)).not.toContain('Unsupported macro');
  });

  it('registers the filename for attachment resolution', () => {
    // The whole point of reusing `media`: without this the crosswalk lookup never runs.
    const node = renderMacro(
      macro('view-file', { params: { name: 'Spec.pdf' } }),
      {},
    );

    const doc = { children: [node] } as unknown as CirDoc;

    expect([...collectRefs(doc).attachmentFilenames]).toEqual(['Spec.pdf']);
  });

  it('supports the external-url variant', () => {
    const node = renderMacro(
      macro('view-file', { params: { url: 'https://example.com/a.pdf' } }),
      {},
    );

    expect(node).toEqual({
      type: 'media',
      kind: 'file',
      src: 'https://example.com/a.pdf',
      sourceMacro: 'view-file',
      sourceParams: { url: 'https://example.com/a.pdf' },
      sourceBody: '',
    });
  });

  it.each(['viewdoc', 'viewpdf', 'viewppt', 'viewxls'] as const)(
    'keeps the source viewer macro kind for %s',
    (name) => {
      expect(
        renderMacro(macro(name, { params: { name: 'report.pdf' } }), {}),
      ).toMatchObject({
        sourceMacro: name,
      });
    },
  );

  it('handles filenames with spaces and unicode', () => {
    const node = renderMacro(
      macro('view-file', {
        params: { name: 'Jahresbericht 2026 – Übersicht.pdf' },
      }),
      {},
    );

    expect(node).toMatchObject({
      kind: 'file',
      filename: 'Jahresbericht 2026 – Übersicht.pdf',
    });
  });

  it('keeps an unidentifiable file macro as a fidelity card', () => {
    expect(renderMacro(macro('view-file'), {})).toEqual({
      type: 'externalMacro',
      name: 'view-file',
      params: {},
    });
  });

  it('leaves a genuinely unknown macro on the unsupported fallback', () => {
    // Guards against a registry edit that accidentally swallows everything.
    const node = renderMacro(macro('totally-unknown-macro'), {});

    expect(JSON.stringify(node)).toContain('externalMacro');
    expect(JSON.stringify(node)).toContain('totally-unknown-macro');
  });

  // End-to-end: the ticket is only fixed if the reader sees a working file, so assert the
  // rendered output rather than stopping at the CIR node.
  describe('rendered output', () => {
    const STORAGE_URL = 'https://storage.example.com/wiki/Spec.pdf';

    it('renders a fileAttachment node carrying the migrated URL', () => {
      const doc = cirToTipTap(
        docFrom('view-file', { name: 'Spec.pdf' }),
        resolvedWith([['Spec.pdf', STORAGE_URL]]),
      );

      expect(JSON.stringify(doc)).toContain('fileAttachment');
      expect(JSON.stringify(doc)).toContain(STORAGE_URL);
      expect(JSON.stringify(doc)).toContain('view-file');
      expect(JSON.stringify(doc)).toContain('localAttachment');
      // Must not degrade into an image — that was the whole point of `kind: 'file'`.
      expect(JSON.stringify(doc)).not.toContain('"type":"image"');
    });

    it('derives a mime type so an imported card matches one inserted via /file', () => {
      // The card only renders its caption line when size or mime is present, and an import
      // never carries a size — so without this an imported card looks different from an
      // authored one.
      const doc = cirToTipTap(
        docFrom('view-file', { name: 'Spec.pdf' }),
        resolvedWith([['Spec.pdf', STORAGE_URL]]),
      );

      expect(JSON.stringify(doc)).toContain('application/pdf');
    });

    it('does not mark an external viewer URL as previewable local content', () => {
      const doc = cirToTipTap(
        docFrom('viewpdf', { url: 'https://example.com/Spec.pdf' }),
        resolvedWith([]),
      );

      expect(JSON.stringify(doc)).toContain('sourceMacro');
      expect(JSON.stringify(doc)).not.toContain('localAttachment');
    });

    it('leaves mime null for an unrecognised extension rather than guessing', () => {
      const doc = cirToTipTap(
        docFrom('view-file', { name: 'archive.weirdext' }),
        resolvedWith([['archive.weirdext', STORAGE_URL]]),
      );

      expect(JSON.stringify(doc)).toContain('fileAttachment');
      expect(JSON.stringify(doc)).not.toContain('octet-stream');
    });

    it('degrades to a file placeholder when the attachment is not migrated yet', () => {
      // Two-pass import: the page renders before its attachments exist. Must not crash,
      // and must not claim the PDF was an image.
      const doc = cirToTipTap(
        docFrom('view-file', { name: 'Missing.pdf' }),
        resolvedWith([]),
      );

      expect(JSON.stringify(doc)).toContain('[File: Missing.pdf]');
      expect(JSON.stringify(doc)).not.toContain('[Image:');
    });

    it('renders a download link rather than an image element on the HTML path', () => {
      const html = cirToHtml(
        docFrom('view-file', { name: 'Spec.pdf' }),
        resolvedWith([['Spec.pdf', STORAGE_URL]]),
      );

      expect(html).toContain('<a href=');
      expect(html).toContain('download');
      expect(html).not.toContain('<img');
    });
  });

  /**
   * XE-T535 — migrated pages kept raw `[File: FB-M_*.docx]` text.
   *
   * The placeholder itself is a correct fallback: on the first pass the page renders before
   * `page_attachments` has ingested anything, so nothing resolves. The bug was that nothing
   * guaranteed a second pass. `page_relink` only re-seeds pages flagged `needs_relink`, and an
   * unresolved ATTACHMENT never set that flag — only cross-page macros and source-URL links did.
   * A page whose per-attachment re-render did not fire kept the placeholder forever.
   *
   * These pin the input that now drives the flag: a Word attachment must be harvested into
   * `attachmentFilenames` (so it can be reported unresolved), and must resolve to a real file
   * card once the crosswalk has it.
   */
  describe('Word attachments feed the unresolved-reference set (XE-T535)', () => {
    const DOCX = 'FB-M_Aenderung_Anlagenbuchung.docx';
    const DOCX_URL = 'https://storage.example.com/wiki/FB-M_Aenderung.docx';

    /** Exactly the expression content-transform uses to compute unresolvedAttachmentRefs. */
    const unresolvedRefs = (doc: CirDoc, resolved: CirResolved) =>
      [...collectRefs(doc).attachmentFilenames].filter(
        (filename) => !resolved.attachments.has(filename),
      );

    it('harvests a .docx filename so it can be reported unresolved', () => {
      const doc = docFrom('view-file', { name: DOCX });

      expect(collectRefs(doc).attachmentFilenames.has(DOCX)).toBe(true);
      expect(unresolvedRefs(doc, resolvedWith([]))).toEqual([DOCX]);
    });

    it('reports nothing unresolved once the attachment is in the crosswalk', () => {
      const doc = docFrom('view-file', { name: DOCX });

      expect(unresolvedRefs(doc, resolvedWith([[DOCX, DOCX_URL]]))).toEqual([]);
    });

    it('renders a working file reference for a Word document, not the raw placeholder', () => {
      const doc = cirToTipTap(
        docFrom('view-file', { name: DOCX }),
        resolvedWith([[DOCX, DOCX_URL]]),
      );
      const json = JSON.stringify(doc);

      expect(json).toContain('fileAttachment');
      expect(json).toContain(DOCX_URL);
      expect(json).not.toContain(`[File: ${DOCX}]`);
      // The docx MIME must be the document type, not the .dotx template type (XE-T489).
      expect(json).toContain('wordprocessingml.document');
      expect(json).not.toContain('wordprocessingml.template');
    });

    it('still reports the ref as unresolved on the first pass, before ingestion', () => {
      const doc = docFrom('view-file', { name: DOCX });

      // This is the state the `pages` stage sees — and what must now flag needs_relink so
      // `page_relink` re-renders the page after `page_attachments` runs.
      expect(unresolvedRefs(doc, resolvedWith([])).length).toBeGreaterThan(0);
    });
  });
});
