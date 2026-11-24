/**
 * Colour handling in the Wiki 2.0 write gate.
 *
 * Regression cover for the bug that destroyed user data on every save: the
 * frontend stores table-cell tints as hex, but CSSOM re-serializes
 * `element.style.backgroundColor` as `rgb(254, 226, 226)`. Copy/pasting a table
 * painted with the editor's own `#fee2e2` swatch therefore produced an rgb()
 * value, the old strict `hexColor()` validator threw a BadRequestException, and
 * the ENTIRE page write 400ed — so `wiki_pages.content` was never updated.
 *
 * The contract now: colours are COERCED to canonical hex, or silently DROPPED.
 * Structural violations (unknown node types, wrong content shape) must STILL
 * reject — that check is what keeps schema drift visible.
 */

// jsdom cannot load in this jest env, and `tiptap-sanitizer` pulls it in
// transitively via `sanitize-rich-text`. The rest of the suite mocks it exactly
// this way (see sanitize-wiki-content.spec.ts / tiptap-confluence-parity.spec.ts).
jest.mock('./sanitize-rich-text', () => ({
  sanitizeRichText: jest.fn((v: string | null | undefined) =>
    v == null ? null : String(v),
  ),
}));

import { BadRequestException } from '@nestjs/common';

import {
  normalizeCssColor,
  TipTapValidationError,
  validateTipTapDoc,
} from './tiptap-sanitizer';

/** A doc with a single one-cell table whose cell carries `backgroundColor`. */
const tableDoc = (backgroundColor: unknown) =>
  JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                attrs: { colspan: 1, rowspan: 1, backgroundColor },
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

const cellAttrs = (json: string): Record<string, unknown> | undefined => {
  const { doc } = validateTipTapDoc(json);
  const table = (doc.content as Record<string, unknown>[])[0];
  const row = (table.content as Record<string, unknown>[])[0];
  const cell = (row.content as Record<string, unknown>[])[0];

  return cell.attrs as Record<string, unknown> | undefined;
};

describe('fileAttachment preview URL', () => {
  it('retains the validated migration-only preview URL', () => {
    const { doc } = validateTipTapDoc(
      JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'fileAttachment',
            attrs: {
              url: 'https://storage.test/original.doc',
              previewUrl: 'https://storage.test/preview.docx',
              name: 'original.doc',
            },
          },
        ],
      }),
    );

    expect((doc.content[0].attrs as Record<string, unknown>).previewUrl).toBe(
      'https://storage.test/preview.docx',
    );
  });
});

describe('normalizeCssColor', () => {
  describe('hex passthrough', () => {
    it.each([
      ['#f00', '#f00'],
      ['#f00a', '#f00a'],
      ['#fee2e2', '#fee2e2'],
      ['#fee2e280', '#fee2e280'],
      ['#FEE2E2', '#fee2e2'],
      ['  #FEE2E2  ', '#fee2e2'],
    ])('keeps %s as %s', (input, expected) => {
      expect(normalizeCssColor(input)).toBe(expected);
    });

    it.each(['#ff', '#fffff', '#fffffff', '#gggggg', 'fee2e2'])(
      'drops malformed hex %s',
      (input) => {
        expect(normalizeCssColor(input)).toBeUndefined();
      },
    );
  });

  describe('rgb() / rgba()', () => {
    it('converts the CSSOM serialization of every editor swatch', () => {
      // TableCellMenu CELL_COLORS, as the DOM hands them back after a paste.
      expect(normalizeCssColor('rgb(254, 226, 226)')).toBe('#fee2e2');
      expect(normalizeCssColor('rgb(255, 237, 213)')).toBe('#ffedd5');
      expect(normalizeCssColor('rgb(254, 249, 195)')).toBe('#fef9c3');
      expect(normalizeCssColor('rgb(220, 252, 231)')).toBe('#dcfce7');
      expect(normalizeCssColor('rgb(219, 234, 254)')).toBe('#dbeafe');
      expect(normalizeCssColor('rgb(237, 233, 254)')).toBe('#ede9fe');
      expect(normalizeCssColor('rgb(243, 244, 246)')).toBe('#f3f4f6');
    });

    it('tolerates case and stray whitespace', () => {
      expect(normalizeCssColor('  RGB( 254 , 226 , 226 )  ')).toBe('#fee2e2');
    });

    it('converts rgba() with alpha', () => {
      expect(normalizeCssColor('rgba(255, 0, 0, 0.5)')).toBe('#ff000080');
      expect(normalizeCssColor('rgba(255, 0, 0, .5)')).toBe('#ff000080');
    });

    it('omits a fully opaque alpha', () => {
      expect(normalizeCssColor('rgba(255, 0, 0, 1)')).toBe('#ff0000');
    });

    it('keeps a fully transparent alpha', () => {
      expect(normalizeCssColor('rgba(0, 0, 0, 0)')).toBe('#00000000');
    });

    it('converts space-separated (modern) syntax', () => {
      expect(normalizeCssColor('rgb(254 226 226)')).toBe('#fee2e2');
      expect(normalizeCssColor('rgb(255 0 0 / 0.5)')).toBe('#ff000080');
      expect(normalizeCssColor('rgb(255 0 0 / 50%)')).toBe('#ff000080');
    });

    it('converts percentage channels', () => {
      expect(normalizeCssColor('rgb(100%, 0%, 0%)')).toBe('#ff0000');
      expect(normalizeCssColor('rgb(100% 0% 0% / 100%)')).toBe('#ff0000');
    });

    it('rounds fractional channels', () => {
      expect(normalizeCssColor('rgb(0.4, 254.6, 128.5)')).toBe('#00ff81');
    });

    it('clamps out-of-range values instead of dropping them', () => {
      expect(normalizeCssColor('rgb(300, -20, 0)')).toBe('#ff0000');
      expect(normalizeCssColor('rgba(0, 0, 0, 5)')).toBe('#000000');
    });

    it.each([
      'rgb(255, 0)',
      'rgb(255, 0, 0, 0, 0)',
      'rgb(255 0 0 / 0.5 / 0.5)',
      'rgb(a, b, c)',
      'rgb()',
      'rgb(255, 0, 0',
      'hsl(0, 100%, 50%)',
      'color(display-p3 1 0 0)',
    ])('drops unparseable colour function %s', (input) => {
      expect(normalizeCssColor(input)).toBeUndefined();
    });
  });

  describe('named colours', () => {
    it.each([
      ['red', '#ff0000'],
      ['white', '#ffffff'],
      ['black', '#000000'],
      ['rebeccapurple', '#663399'],
      ['gray', '#808080'],
      ['grey', '#808080'],
      ['darkslategray', '#2f4f4f'],
      ['darkslategrey', '#2f4f4f'],
      ['CornflowerBlue', '#6495ed'],
    ])('resolves %s to %s', (input, expected) => {
      expect(normalizeCssColor(input)).toBe(expected);
    });

    it.each(['notacolour', 'bluish', 'reddish'])(
      'drops unknown name %s',
      (input) => {
        expect(normalizeCssColor(input)).toBeUndefined();
      },
    );
  });

  describe('keywords', () => {
    it('maps transparent to fully transparent black', () => {
      expect(normalizeCssColor('transparent')).toBe('#00000000');
      expect(normalizeCssColor('TRANSPARENT')).toBe('#00000000');
    });

    it.each([
      'currentColor',
      'currentcolor',
      'inherit',
      'initial',
      'unset',
      'revert',
      'none',
    ])('drops the unresolvable keyword %s', (input) => {
      expect(normalizeCssColor(input)).toBeUndefined();
    });
  });

  describe('non-values', () => {
    it.each<[string, unknown]>([
      ['empty string', ''],
      ['whitespace', '   '],
      ['null', null],
      ['undefined', undefined],
      ['number', 0],
      ['large number', 16711680],
      ['boolean', true],
      ['object', { backgroundColor: '#fee2e2' }],
      ['array', ['#fee2e2']],
      ['garbage', 'javascript:alert(1)'],
      ['css injection', '#fee2e2; background: url(x)'],
    ])('drops %s', (_label, input) => {
      expect(normalizeCssColor(input)).toBeUndefined();
    });

    it('drops an absurdly long value without scanning it', () => {
      expect(normalizeCssColor('a'.repeat(100_000))).toBeUndefined();
    });
  });

  /**
   * The named-colour table used to be a plain `Object.fromEntries(…)`, so it
   * inherited from `Object.prototype` and a bare `NAMED_COLORS[value]` lookup
   * resolved prototype members: `normalizeCssColor('__proto__')` returned
   * `Object.prototype` and `normalizeCssColor('constructor')` returned the
   * `Object` FUNCTION — both violating the declared `string | undefined` return
   * type and writing a non-string into a stored `backgroundColor` attr.
   *
   * The `typeof` assertion is the load-bearing one: a future regression of this
   * shape yields a truthy non-string, which a differently-shaped leak (function,
   * array) could sneak past a bare `toBeUndefined()`.
   */
  describe('prototype-chain keys', () => {
    it.each([
      '__proto__',
      'constructor',
      'prototype',
      'tostring',
      'valueof',
      'hasownproperty',
    ])('returns undefined (never a prototype member) for %s', (key) => {
      const result = normalizeCssColor(key);

      expect(result).toBeUndefined();
      expect(typeof result === 'string' || result == null).toBe(true);
    });

    it.each([
      '__PROTO__',
      'Constructor',
      '  __proto__  ',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'propertyIsEnumerable',
      'isPrototypeOf',
      'toLocaleString',
    ])('is not fooled by the cased/padded variant %s either', (key) => {
      const result = normalizeCssColor(key);

      expect(result).toBeUndefined();
      expect(typeof result === 'string' || result == null).toBe(true);
    });

    it('never returns a non-string for any input shape', () => {
      const inputs: unknown[] = [
        '__proto__',
        'constructor',
        'prototype',
        'red',
        'rgb(1, 2, 3)',
        'transparent',
        '#fee2e2',
        'notacolour',
        '',
        null,
        undefined,
        42,
        {},
        [],
      ];

      for (const input of inputs) {
        const result = normalizeCssColor(input);

        expect(typeof result === 'string' || result === undefined).toBe(true);
      }
    });

    it('drops a prototype-chain colour attr instead of storing an object', () => {
      // The live path: `<td data-bg-color="__proto__">` in pasted HTML.
      for (const key of ['__proto__', 'constructor', 'prototype']) {
        expect(() => validateTipTapDoc(tableDoc(key))).not.toThrow();
        expect(cellAttrs(tableDoc(key))).toEqual({ colspan: 1, rowspan: 1 });
      }
    });
  });

  it('is idempotent', () => {
    for (const input of [
      'rgb(254, 226, 226)',
      'rgba(255, 0, 0, 0.5)',
      'red',
      'transparent',
      '#f00',
    ]) {
      const once = normalizeCssColor(input);

      expect(normalizeCssColor(once)).toBe(once);
    }
  });
});

describe('validateTipTapDoc — colour attributes never fail a write', () => {
  it('accepts the rgb() a copy/pasted coloured table produces', () => {
    // The exact payload from the bug report: our own #fee2e2 swatch, round
    // tripped through the DOM. This used to throw
    // "Invalid TipTap document at $.content[…].attrs.backgroundColor".
    expect(() =>
      validateTipTapDoc(tableDoc('rgb(254, 226, 226)')),
    ).not.toThrow();
    expect(cellAttrs(tableDoc('rgb(254, 226, 226)'))).toEqual({
      colspan: 1,
      rowspan: 1,
      backgroundColor: '#fee2e2',
    });
  });

  it('keeps a hex colour untouched', () => {
    expect(cellAttrs(tableDoc('#fee2e2'))?.backgroundColor).toBe('#fee2e2');
  });

  it.each<[string, unknown]>([
    ['empty string', ''],
    ['transparent-ish garbage', 'not-a-colour'],
    ['currentColor', 'currentColor'],
    ['a number', 42],
    ['an object', { r: 1 }],
    ['null', null],
    ['undefined', undefined],
  ])('drops %s instead of rejecting the document', (_label, value) => {
    expect(() => validateTipTapDoc(tableDoc(value))).not.toThrow();

    const attrs = cellAttrs(tableDoc(value));

    expect(attrs).toEqual({ colspan: 1, rowspan: 1 });
  });

  it('coerces callout backgroundColor', () => {
    const { doc } = validateTipTapDoc(
      JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'callout',
            attrs: { variant: 'info', backgroundColor: 'rgb(220, 252, 231)' },
            content: [{ type: 'paragraph' }],
          },
        ],
      }),
    );

    const callout = (doc.content as Record<string, unknown>[])[0];

    expect((callout.attrs as Record<string, unknown>).backgroundColor).toBe(
      '#dcfce7',
    );
  });

  it('coerces the highlight and textStyle mark colours', () => {
    const { doc } = validateTipTapDoc(
      JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'x',
                marks: [
                  { type: 'highlight', attrs: { color: 'yellow' } },
                  { type: 'textStyle', attrs: { color: 'rgb(0, 0, 0)' } },
                ],
              },
            ],
          },
        ],
      }),
    );

    const paragraph = (doc.content as Record<string, unknown>[])[0];
    const text = (paragraph.content as Record<string, unknown>[])[0];
    const marks = text.marks as Record<string, unknown>[];

    expect((marks[0].attrs as Record<string, unknown>).color).toBe('#ffff00');
    expect((marks[1].attrs as Record<string, unknown>).color).toBe('#000000');
  });

  it('drops an unparseable mark colour but keeps the mark', () => {
    const { doc } = validateTipTapDoc(
      JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'x',
                marks: [{ type: 'highlight', attrs: { color: 'chartruse' } }],
              },
            ],
          },
        ],
      }),
    );

    const paragraph = (doc.content as Record<string, unknown>[])[0];
    const text = (paragraph.content as Record<string, unknown>[])[0];

    expect(text.marks).toEqual([{ type: 'highlight' }]);
  });
});

describe('validateTipTapDoc — whiteboard embed', () => {
  it('accepts a whiteboardEmbed and keeps its config, stripping unknown attrs', () => {
    const config = {
      whiteboardId: '11111111-1111-4111-8111-111111111111',
      spaceId: '22222222-2222-4222-8222-222222222222',
      name: 'Sprint räume ✏️',
    };
    const { doc } = validateTipTapDoc(
      JSON.stringify({
        type: 'doc',
        content: [{ type: 'whiteboardEmbed', attrs: { config, onclick: 'x' } }],
      }),
    );

    expect((doc.content as Record<string, unknown>[])[0]).toEqual({
      type: 'whiteboardEmbed',
      attrs: { config },
    });
  });

  it('accepts an unconfigured whiteboardEmbed (just inserted)', () => {
    expect(() =>
      validateTipTapDoc(
        JSON.stringify({ type: 'doc', content: [{ type: 'whiteboardEmbed' }] }),
      ),
    ).not.toThrow();
  });
});

describe('validateTipTapDoc — structural violations still reject', () => {
  it('rejects an unknown node type', () => {
    expect(() =>
      validateTipTapDoc(
        JSON.stringify({ type: 'doc', content: [{ type: 'quantumBlock' }] }),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects an unknown mark type', () => {
    expect(() =>
      validateTipTapDoc(
        JSON.stringify({
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'x', marks: [{ type: 'blink' }] },
              ],
            },
          ],
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects content on a node that cannot have it', () => {
    expect(() =>
      validateTipTapDoc(
        JSON.stringify({
          type: 'doc',
          content: [{ type: 'horizontalRule', content: [] }],
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects a non-doc root', () => {
    expect(() =>
      validateTipTapDoc(JSON.stringify({ type: 'paragraph' })),
    ).toThrow(BadRequestException);
  });

  it('rejects an unsafe URL on a node whose attr is REQUIRED (image.src)', () => {
    // Proof that `url()` is unchanged: leniency is scoped to the link MARK only.
    // An image without a usable src is a broken node, so it still fails loudly.
    expect(() =>
      validateTipTapDoc(
        JSON.stringify({
          type: 'doc',
          content: [{ type: 'image', attrs: { src: 'javascript:alert(1)' } }],
        }),
      ),
    ).toThrow(BadRequestException);
  });

  it('throws TipTapValidationError, not a bare BadRequestException', () => {
    // The migration queue keys off this subclass to classify the failure
    // `permanent`; a bare BadRequestException would be retried to exhaustion.
    expect(() =>
      validateTipTapDoc(JSON.stringify({ type: 'paragraph' })),
    ).toThrow(TipTapValidationError);
  });
});

/**
 * Link hrefs: a bad one DROPS THE MARK, it never fails the document.
 *
 * Regression cover for the Confluence import that cost a customer 214 of 216
 * pages: Word-exported bookmark anchors (`<a name="_Toc123">`) reached this gate
 * as `href: ''`, and rejecting an empty href threw away the ENTIRE page. Same
 * rule as colours above — a bad value must not destroy a user's document.
 */
describe('validateTipTapDoc — link marks degrade instead of rejecting', () => {
  /** A one-paragraph doc whose single text node carries a link mark. */
  const linkDoc = (attrs: unknown) =>
    JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Kapitel 3',
              marks: [{ type: 'link', attrs }],
            },
          ],
        },
      ],
    });

  const marksOf = (json: string) => {
    const doc = JSON.parse(json) as {
      content: { content: { marks?: unknown[] }[] }[];
    };

    return doc.content[0].content[0].marks;
  };

  it.each([
    ['empty string', { href: '' }],
    ['whitespace only', { href: '   ' }],
    ['missing href', { target: '_blank' }],
    ['non-string href', { href: 42 }],
    ['over 4096 chars', { href: `https://e.com/${'a'.repeat(4097)}` }],
    ['javascript: scheme', { href: 'javascript:alert(1)' }],
    ['control-char evasion', { href: 'java\tscript:alert(1)' }],
    ['data: URL', { href: 'data:text/html,<script>alert(1)</script>' }],
  ])('drops the mark and keeps the text — %s', (_label, attrs) => {
    const result = validateTipTapDoc(linkDoc(attrs));

    // The text always survives: the reader loses nothing.
    expect(result.json).toContain('Kapitel 3');
    // The unusable link is gone rather than stored.
    expect(marksOf(result.json)).toBeUndefined();
  });

  it('never stores a dropped javascript: payload anywhere in the document', () => {
    const result = validateTipTapDoc(linkDoc({ href: 'javascript:alert(1)' }));

    expect(result.json).not.toContain('javascript:');
    expect(result.json).not.toContain('alert(1)');
  });

  it.each([
    ['absolute https', 'https://example.com/a?b=1'],
    ['in-page anchor', '#abschnitt-3'],
    ['app-relative', '/spaces/DEV/pages/1'],
    ['scheme-less relative', 'docs/page'],
    ['mailto', 'mailto:info@example.com'],
    ['tel', 'tel:+4312345678'],
  ])('keeps a valid link untouched — %s', (_label, href) => {
    const result = validateTipTapDoc(linkDoc({ href }));
    const marks = marksOf(result.json) as { attrs: Record<string, string> }[];

    expect(marks).toHaveLength(1);
    expect(marks[0].attrs.href).toBe(href);
    // rel is forced on every surviving link regardless of input.
    expect(marks[0].attrs.rel).toBe('noopener noreferrer nofollow');
  });

  it('drops only the bad mark, leaving sibling marks on the same text node', () => {
    const result = validateTipTapDoc(
      JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Kapitel 3',
                marks: [
                  { type: 'bold' },
                  { type: 'link', attrs: { href: '' } },
                ],
              },
            ],
          },
        ],
      }),
    );
    const marks = marksOf(result.json) as { type: string }[];

    expect(marks).toHaveLength(1);
    expect(marks[0].type).toBe('bold');
  });
});

/**
 * Two attrs the editor produces that the validator used to refuse, each of
 * which made the page unsaveable for good — the same failure shape as the
 * colour bug above: one bad attr rejects the WHOLE document, so the write never
 * lands and the user just sees "save failed" forever.
 */
describe('editor-produced attrs the gate must accept', () => {
  const imageDoc = (width: unknown) =>
    JSON.stringify({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'https://example.com/a.png', width } },
      ],
    });

  it('accepts the percentage string the resize grip writes', () => {
    // ResizableImage: updateAttributes({ width: `${percent}%` })
    const { doc } = validateTipTapDoc(imageDoc('85%'));

    expect((doc.content as any[])[0].attrs.width).toBe('85%');
  });

  it('still accepts an integer pixel width', () => {
    const { doc } = validateTipTapDoc(imageDoc(640));

    expect((doc.content as any[])[0].attrs.width).toBe(640);
  });

  it('still rejects a width that is neither', () => {
    expect(() => validateTipTapDoc(imageDoc('wide'))).toThrow(
      TipTapValidationError,
    );
    expect(() => validateTipTapDoc(imageDoc('250%'))).toThrow(
      TipTapValidationError,
    );
  });

  it('accepts an as-yet-undrawn diagram', () => {
    // The slash command inserts `xml: null` and the node view renders an
    // "Empty diagram" placeholder until someone draws one.
    const empty = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'drawioDiagram',
          attrs: { xml: null, preview: null, caption: null },
        },
      ],
    });

    expect(() => validateTipTapDoc(empty)).not.toThrow();
  });

  it('still rejects a drawio payload that is not an mxfile or SVG data URI', () => {
    const bad = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'drawioDiagram', attrs: { xml: '<script>x</script>' } },
      ],
    });

    expect(() => validateTipTapDoc(bad)).toThrow(TipTapValidationError);
  });
});

/**
 * `wikiLink.pageId` is a REQUIRED uuid, so a link with no target fails the whole
 * document — the third instance of that class after image width and drawio xml.
 * The editor's "[[ ... Create" row used to produce exactly this.
 */
describe('wikiLink targets', () => {
  const linkDoc = (attrs: Record<string, unknown>) =>
    JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'wikiLink', attrs }] }],
    });

  const realId = '11111111-2222-4333-8444-555555555555';

  it('rejects a link with no page id', () => {
    expect(() =>
      validateTipTapDoc(linkDoc({ pageId: null, pageTitle: 'New page' })),
    ).toThrow(TipTapValidationError);
  });

  it('accepts a link to a real page', () => {
    expect(() =>
      validateTipTapDoc(linkDoc({ pageId: realId, pageTitle: 'On-call' })),
    ).not.toThrow();
  });

  it('round-trips `exists` so broken-link styling survives a save', () => {
    const { doc } = validateTipTapDoc(
      linkDoc({ pageId: realId, pageTitle: 'Deleted page', exists: false }),
    );
    const link = (doc.content as any[])[0].content[0];

    expect(link.attrs.exists).toBe(false);
  });

  it('round-trips a migrated Confluence fragment on a real page link', () => {
    const { doc } = validateTipTapDoc(
      linkDoc({
        pageId: realId,
        pageTitle: 'AM Topics',
        spaceKey: 'APMIS',
        fragment: 'release-notes',
      }),
    );
    const link = (doc.content as any[])[0].content[0];

    expect(link.attrs.fragment).toBe('release-notes');
  });
});

/**
 * The diagram editor exports its thumbnail inline — it uploads nothing — so
 * `drawioDiagram.preview` arrives as a `data:` URI. It used to be validated by
 * `localCarouselImageAttr()`, which only admits a local wiki-attachments URL, so
 * every diagram a user actually drew produced a preview the gate refused. One
 * rejected attr fails the whole document, which made the page unsaveable from
 * the moment a diagram was drawn.
 */
describe('drawioDiagram preview', () => {
  const doc = (preview: unknown) => ({
    type: 'doc',
    content: [
      {
        type: 'drawioDiagram',
        attrs: { xml: '<mxfile><diagram>abc</diagram></mxfile>', preview },
      },
    ],
  });

  const pngPreview = `data:image/png;base64,${'A'.repeat(64)}`;

  it('accepts the inline PNG the editor produces', () => {
    expect(() => validateTipTapDoc(doc(pngPreview))).not.toThrow();
  });

  it('accepts a JPEG preview', () => {
    expect(() =>
      validateTipTapDoc(doc(`data:image/jpeg;base64,${'B'.repeat(32)}`)),
    ).not.toThrow();
  });

  it('still accepts a local attachment URL', () => {
    expect(() =>
      validateTipTapDoc(
        doc('/storage/v1/object/public/wiki-attachments/wiki/a/b.png'),
      ),
    ).not.toThrow();
  });

  // The preview is decoration; `xml` is the payload. Every rejection below is
  // therefore a DROP — an unstorable preview must not cost the user the page it
  // sits on, and every one of these values still fails to reach storage.
  const previewOf = (input: unknown) => {
    const out = validateTipTapDoc(doc(input)).doc as unknown as {
      content: { attrs?: Record<string, unknown> }[];
    };

    return {
      preview: out.content[0].attrs?.preview,
      xml: out.content[0].attrs?.xml,
    };
  };

  it('DROPS an SVG data URI — script-capable, and it goes into an img src', () => {
    // Every diagram drawn before this release exported `xmlsvg`. Rejecting would
    // brick those pages forever; the diagram source has to survive the drop.
    const { preview, xml } = previewOf(
      `data:image/svg+xml;base64,${'C'.repeat(32)}`,
    );

    expect(preview).toBeUndefined();
    expect(xml).toBe('<mxfile><diagram>abc</diagram></mxfile>');
  });

  it('drops a remote image URL', () => {
    expect(previewOf('https://evil.example/x.png').preview).toBeUndefined();
  });

  it('drops an oversized inline preview', () => {
    expect(
      previewOf(`data:image/png;base64,${'A'.repeat(2_000_001)}`).preview,
    ).toBeUndefined();
  });

  it('never lets a bad preview reject the document around it', () => {
    expect(() =>
      validateTipTapDoc({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'keep me' }] },
          {
            type: 'drawioDiagram',
            attrs: { xml: '<mxfile/>', preview: 'javascript:alert(1)' },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('still allows a diagram that has never been drawn', () => {
    expect(() =>
      validateTipTapDoc({
        type: 'doc',
        content: [{ type: 'drawioDiagram', attrs: { xml: null } }],
      }),
    ).not.toThrow();
  });
});

describe('rawHtml sanitisation', () => {
  it('sanitises with allowTables — the wiki editor renders tables', () => {
    // Every other wiki write path passes `{ allowTables: true }`; this one did
    // not, so a table pasted into the Raw HTML macro rendered in the editor and
    // came back from the server as one run-on line of cell text.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sanitizeRichText } = require('./sanitize-rich-text') as {
      sanitizeRichText: jest.Mock;
    };

    sanitizeRichText.mockClear();

    validateTipTapDoc({
      type: 'doc',
      content: [
        {
          type: 'rawHtml',
          attrs: { html: '<table><tr><td>x</td></tr></table>' },
        },
      ],
    });

    expect(sanitizeRichText).toHaveBeenCalledWith(
      '<table><tr><td>x</td></tr></table>',
      { allowTables: true },
    );
  });
});

describe('contentPropertiesReport.sortBy', () => {
  const doc = (sortBy: string) => ({
    type: 'doc',
    content: [
      { type: 'contentPropertiesReport', attrs: { label: 'runbook', sortBy } },
    ],
  });

  // The node's own default is 'title' and its config select offers Title |
  // Modified. Admitting only 'modified' rejected the macro the instant it was
  // inserted, and a rejected attr fails the WHOLE document — so inserting this
  // macro silently discarded every other unsaved edit on the page.
  it.each(['title', 'modified'])(
    'accepts %s — both values the editor emits',
    (sortBy) => {
      expect(() => validateTipTapDoc(doc(sortBy))).not.toThrow();
    },
  );

  it('still rejects a value the editor cannot produce', () => {
    expect(() => validateTipTapDoc(doc('created'))).toThrow(/expected one of/);
  });
});
