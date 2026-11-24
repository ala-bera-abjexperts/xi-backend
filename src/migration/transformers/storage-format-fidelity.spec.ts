/** Confluence Server storage-XHTML fidelity regressions. */

jest.mock('../../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (v: string | null | undefined) =>
    v == null ? null : String(v),
}));

import { validateTipTapDoc } from '../../common/utils/tiptap-sanitizer';
import { pageReferenceKey } from './canonical-ir';
import { storageToCir } from './storage-format-to-html';
import { cirToTipTap, type TipTapNode } from './cir-to-tiptap';
import { renderMacro } from './macros/macro-registry';

const PAGE_ID = '11111111-2222-4333-8444-555555555555';
const hooks = { onMacro: () => null };

function find(node: TipTapNode, type: string): TipTapNode | undefined {
  if (node.type === type) return node;

  for (const child of node.content ?? []) {
    const hit = find(child, type);

    if (hit) return hit;
  }

  return undefined;
}

describe('Confluence Server storage fidelity', () => {
  it('accepts the legacy Server ri:username mention identity', () => {
    const cir = storageToCir(
      '<p><ac:link><ri:user ri:username="christian.kienzl"/></ac:link></p>',
      hooks,
    );
    const paragraph = cir.children[0];

    if (paragraph?.type !== 'paragraph') throw new Error('expected paragraph');
    expect(paragraph.children[0]).toMatchObject({
      type: 'userMention',
      sourceId: 'christian.kienzl',
    });
  });

  it.each([
    ['two_equal', [50, 50]],
    ['two_left_sidebar', [30, 70]],
    ['two_right_sidebar', [70, 30]],
    ['three_equal', [33, 34, 33]],
    ['three_with_sidebars', [20, 60, 20]],
  ])('keeps modern %s layout proportions', (type, widths) => {
    const cells = widths
      .map((_, index) => `<ac:layout-cell><p>c${index}</p></ac:layout-cell>`)
      .join('');
    const cir = storageToCir(
      `<ac:layout><ac:layout-section ac:type="${type}">${cells}</ac:layout-section></ac:layout>`,
      hooks,
    );

    expect(cir.children[0]).toMatchObject({ type: 'layout', widths });
  });

  it('keeps a safe imported image alignment', () => {
    const cir = storageToCir(
      '<ac:image ac:align="right"><ri:attachment ri:filename="diagram.png"/></ac:image>',
      hooks,
    );
    const paragraph = cir.children[0];

    if (paragraph?.type !== 'paragraph') throw new Error('expected paragraph');
    expect(paragraph.children[0]).toMatchObject({
      type: 'media',
      filename: 'diagram.png',
      align: 'right',
    });
  });

  it('does not invent widths or alignment for unknown source values', () => {
    const cir = storageToCir(
      '<ac:layout><ac:layout-section ac:type="future_layout"><ac:layout-cell><p>a</p></ac:layout-cell><ac:layout-cell><p>b</p></ac:layout-cell></ac:layout-section></ac:layout>' +
        '<ac:image ac:align="sideways"><ri:attachment ri:filename="diagram.png"/></ac:image>',
      hooks,
    );

    expect(cir.children[0]).toMatchObject({ type: 'layout' });
    expect(cir.children[0]).not.toHaveProperty('widths');
    const imageParagraph = cir.children[1];

    if (imageParagraph?.type !== 'paragraph')
      throw new Error('expected paragraph');
    expect(imageParagraph.children[0]).not.toHaveProperty('align');
  });

  it('keeps classic section column percentages', () => {
    const cir = storageToCir(
      '<ac:structured-macro ac:name="section"><ac:rich-text-body>' +
        '<ac:structured-macro ac:name="column"><ac:parameter ac:name="width">30%</ac:parameter><ac:rich-text-body><p>left</p></ac:rich-text-body></ac:structured-macro>' +
        '<ac:structured-macro ac:name="column"><ac:parameter ac:name="width">70%</ac:parameter><ac:rich-text-body><p>right</p></ac:rich-text-body></ac:structured-macro>' +
        '</ac:rich-text-body></ac:structured-macro>',
      { onMacro: (parsed) => renderMacro(parsed, {}) },
    );

    expect(cir.children[0]).toMatchObject({
      type: 'layout',
      widths: [30, 70],
    });
  });

  it('keeps title + source-space page refs, anchors, and resolved target route attrs', () => {
    const cir = storageToCir(
      '<p><ac:link ac:anchor="release-notes"><ri:page ri:content-title="SNMP" ri:space-key="EDV"/><ac:link-body>SNMP</ac:link-body></ac:link></p>',
      hooks,
    );
    const paragraph = cir.children[0];

    if (paragraph?.type !== 'paragraph') throw new Error('expected paragraph');
    const pageLink = paragraph.children[0];

    expect(pageLink).toMatchObject({
      type: 'pageLink',
      pageSourceId: 'SNMP',
      sourceSpaceKey: 'EDV',
      fragment: 'release-notes',
    });

    const out = cirToTipTap(cir, {
      users: new Map(),
      attachments: new Map(),
      nativeTables: true,
      pages: new Map([
        [
          pageReferenceKey('SNMP', 'EDV'),
          {
            pageId: PAGE_ID,
            pageSlug: 'snmp',
            spaceKey: 'EDV',
            title: 'SNMP',
          },
        ],
      ]),
    });

    expect(find(out, 'wikiLink')?.attrs).toMatchObject({
      pageId: PAGE_ID,
      pageSlug: 'snmp',
      spaceKey: 'EDV',
      pageTitle: 'SNMP',
      fragment: 'release-notes',
    });
    expect(() => validateTipTapDoc(JSON.stringify(out))).not.toThrow();
  });

  it('keeps the APMIS-style list, formatting, anchor target, and anchored page link together', () => {
    const cir = storageToCir(
      '<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">release-notes</ac:parameter></ac:structured-macro>' +
        '<h2>AM Topics</h2>' +
        '<ul><li><strong>Policy</strong> <em>notes</em><ol start="2"><li>Nested step</li></ol></li></ul>' +
        '<p><ac:link ac:anchor="release-notes"><ri:page ri:content-title="AM Topics" ri:space-key="APMIS"/><ac:link-body>Read more</ac:link-body></ac:link></p>',
      { onMacro: (macro) => renderMacro(macro, {}) },
    );
    const out = cirToTipTap(cir, {
      users: new Map(),
      attachments: new Map(),
      nativeTables: true,
      pages: new Map([
        [
          pageReferenceKey('AM Topics', 'APMIS'),
          {
            pageId: PAGE_ID,
            pageSlug: 'am-topics',
            spaceKey: 'APMIS',
            title: 'AM Topics',
          },
        ],
      ]),
    });
    const json = JSON.stringify(out);

    expect(json).toContain('confluenceAnchor');
    expect(json).toContain('bulletList');
    expect(json).toContain('orderedList');
    expect(json).toContain('"bold"');
    expect(json).toContain('"italic"');
    expect(find(out, 'wikiLink')?.attrs).toMatchObject({
      pageId: PAGE_ID,
      fragment: 'release-notes',
    });
    expect(() => validateTipTapDoc(json)).not.toThrow();
  });

  it('keeps an attachment link as resolvable file media', () => {
    const cir = storageToCir(
      '<p><ac:link><ri:attachment ri:filename="Network.pdf"/><ac:plain-text-link-body>Network plan</ac:plain-text-link-body></ac:link></p>',
      hooks,
    );
    const out = cirToTipTap(cir, {
      users: new Map(),
      pages: new Map(),
      nativeTables: true,
      attachments: new Map([
        ['Network.pdf', '/api/v1/attachments/file-1/download'],
      ]),
    });

    expect(find(out, 'fileAttachment')?.attrs).toMatchObject({
      name: 'Network.pdf',
      url: '/api/v1/attachments/file-1/download',
    });
    expect(() => validateTipTapDoc(JSON.stringify(out))).not.toThrow();
  });

  it('retains safe span colors and drops CSS that is not a color value', () => {
    const cir = storageToCir(
      '<p><span style="color: rgb(255, 0, 0)">red</span><span style="color: url(javascript:alert(1))">unsafe</span></p>',
      hooks,
    );
    const out = cirToTipTap(cir, {
      users: new Map(),
      pages: new Map(),
      attachments: new Map(),
      nativeTables: true,
    });
    const textNodes = (find(out, 'paragraph')?.content ?? []).filter(
      (node) => node.type === 'text',
    );

    expect(textNodes[0].marks).toEqual([
      { type: 'textStyle', attrs: { color: 'rgb(255, 0, 0)' } },
    ]);
    expect(textNodes[1].marks).toBeUndefined();
    expect(validateTipTapDoc(JSON.stringify(out)).json).toContain('#ff0000');
  });

  it('keeps links and colors on inline elements that sit directly inside list items', () => {
    // Real-world shape from the APMIS "AM Topics" page: bare anchors and
    // coloured spans as DIRECT children of <li>. The block-level walker used to
    // treat them as containers, so their link/color semantics were dropped.
    const cir = storageToCir(
      '<ul>' +
        '<li><a href="https://google.com">Link 1</a></li>' +
        '<li><a href="https://google.com">Link 2</a> Left</li>' +
        '<li><span style="color: rgb(255,0,0);">colors in listing red</span></li>' +
        '<li><span style="color: rgb(255,0,0);"><a href="https://google.com">color and link</a></span></li>' +
        '</ul>',
      hooks,
    );
    const out = cirToTipTap(cir, {
      users: new Map(),
      pages: new Map(),
      attachments: new Map(),
      nativeTables: true,
    });
    const list = out.content?.[0];

    expect(list?.type).toBe('bulletList');

    const items = list?.content ?? [];
    const firstItemText = items[0]?.content?.[0]?.content?.[0];

    expect(firstItemText?.marks?.[0]?.type).toBe('link');
    expect(firstItemText?.marks?.[0]?.attrs?.href).toBe('https://google.com');

    // Trailing text after the anchor stays outside the link.
    const secondItemRuns = items[1]?.content?.[0]?.content ?? [];

    expect(secondItemRuns[0]?.marks?.[0]?.type).toBe('link');
    expect(secondItemRuns[1]?.text).toBe(' Left');

    // Colour survives on its own.
    const colourRun = items[2]?.content?.[0]?.content?.[0];

    expect(colourRun?.marks?.[0]).toMatchObject({
      type: 'textStyle',
      attrs: { color: 'rgb(255,0,0)' },
    });

    // Colour + link combine (link mark from the anchor, colour from the span).
    const bothRun = items[3]?.content?.[0]?.content?.[0];
    const bothTypes = (bothRun?.marks ?? []).map((m: TipTapNode) => m.type);

    expect(bothTypes).toEqual(expect.arrayContaining(['link', 'textStyle']));
    expect(() => validateTipTapDoc(JSON.stringify(out))).not.toThrow();
  });

  it('retains Confluence h5/h6 and subscript/superscript formatting', () => {
    const cir = storageToCir(
      '<h5>Heading five</h5><h6>Heading six</h6><p><sub>low</sub><sup>high</sup></p>',
      hooks,
    );
    const out = cirToTipTap(cir, {
      users: new Map(),
      pages: new Map(),
      attachments: new Map(),
      nativeTables: true,
    });
    const headings = (out.content ?? []).filter(
      (node) => node.type === 'heading',
    );
    const marks = (find(out, 'paragraph')?.content ?? [])
      .filter((node) => node.type === 'text')
      .map((node) => node.marks?.[0]?.type);

    expect(headings.map((node) => node.attrs?.level)).toEqual([5, 6]);
    expect(marks).toEqual(['subscript', 'superscript']);
    expect(() => validateTipTapDoc(JSON.stringify(out))).not.toThrow();
  });

  it('keeps a self-closed Confluence task date even when HTML parsing adopts whitespace', () => {
    const cir = storageToCir(
      '<ac:task-list><ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>Follow up <time datetime="2026-08-21" />&nbsp;</ac:task-body></ac:task></ac:task-list>',
      hooks,
    );
    const out = cirToTipTap(cir, {
      users: new Map(),
      pages: new Map(),
      attachments: new Map(),
      nativeTables: true,
    });

    expect(find(out, 'date')?.attrs?.timestamp).toBe(
      String(Date.parse('2026-08-21')),
    );
    expect(() => validateTipTapDoc(JSON.stringify(out))).not.toThrow();
  });

  it('keeps every self-closed date in a paragraph, including one followed by more text', () => {
    // HTML mode ignores `/>` on <time>, so the rest of the block used to be swallowed as the
    // date element's children and only the FIRST text run kept its date. The parser now expands
    // self-closed `time` elements before parsing, exactly like the namespaced tags.
    const cir = storageToCir(
      '<p>Kick-off <time datetime="2026-09-01" />, review due <time datetime="2026-09-15" />.</p>',
      hooks,
    );
    const paragraph = cir.children[0];

    if (paragraph?.type !== 'paragraph') throw new Error('expected paragraph');

    const dates = paragraph.children.filter((node) => node.type === 'date');
    const text = paragraph.children
      .filter((node) => node.type === 'text')
      .map((node) => node.text)
      .join('');

    expect(dates.map((node) => node.timestamp)).toEqual([
      String(Date.parse('2026-09-01')),
      String(Date.parse('2026-09-15')),
    ]);
    expect(text).toBe('Kick-off , review due .');
  });

  it('resolves classic section/column macros nested as direct children', () => {
    // Confluence storage nests `column` macros DIRECTLY under `section` — there is no
    // rich-text-body wrapper. They used to be dropped, so the whole section vanished.
    const cir = storageToCir(
      '<ac:structured-macro ac:name="section" ac:schema-version="1">' +
        '<ac:parameter ac:name="border">true</ac:parameter>' +
        '<ac:structured-macro ac:name="column" ac:schema-version="1"><ac:parameter ac:name="width">33%</ac:parameter><ac:rich-text-body><p>Tier 1</p></ac:rich-text-body></ac:structured-macro>' +
        '<ac:structured-macro ac:name="column" ac:schema-version="1"><ac:parameter ac:name="width">33%</ac:parameter><ac:rich-text-body><p>Tier 2</p></ac:rich-text-body></ac:structured-macro>' +
        '<ac:structured-macro ac:name="column" ac:schema-version="1"><ac:parameter ac:name="width">34%</ac:parameter><ac:rich-text-body><p>Tier 3</p></ac:rich-text-body></ac:structured-macro>' +
        '</ac:structured-macro>',
      { onMacro: (macro) => renderMacro(macro, undefined) },
    );

    expect(cir.children[0]).toMatchObject({
      type: 'layout',
      widths: [33, 33, 34],
    });

    if (cir.children[0]?.type !== 'layout') throw new Error('expected layout');
    expect(cir.children[0].columns).toHaveLength(3);

    const out = cirToTipTap(cir, {
      users: new Map(),
      pages: new Map(),
      attachments: new Map(),
      nativeTables: true,
    });

    expect(out.content?.[0]?.type).toBe('columnList');
    expect(out.content?.[0]?.content).toHaveLength(3);
    expect(() => validateTipTapDoc(JSON.stringify(out))).not.toThrow();
  });

  it('retains ordered-list starts and nested list order', () => {
    const cir = storageToCir(
      '<ol start="3"><li>third<ol start="8"><li>eighth</li></ol></li><li>fourth</li></ol>',
      hooks,
    );
    const out = cirToTipTap(cir, {
      users: new Map(),
      pages: new Map(),
      attachments: new Map(),
      nativeTables: true,
    });
    const outer = find(out, 'orderedList');
    const nested = outer?.content?.[0]?.content?.find(
      (node) => node.type === 'orderedList',
    );

    expect(outer?.attrs?.start).toBe(3);
    expect(nested?.attrs?.start).toBe(8);
    expect(() => validateTipTapDoc(JSON.stringify(out))).not.toThrow();
  });

  it('dispatches legacy macros instead of leaking their parameter text', () => {
    const onMacro = jest.fn(() => null);

    storageToCir(
      '<ac:macro ac:name="listlabels"><ac:parameter ac:name="excludedLabels">kb-how-to-article,kb-troubleshooting-article</ac:parameter></ac:macro>',
      { onMacro },
    );

    expect(onMacro).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'listlabels',
        params: {
          excludedLabels: 'kb-how-to-article,kb-troubleshooting-article',
        },
      }),
    );
  });

  it('preserves nested page macro parameters and named Confluence emoticons', () => {
    const onMacro = jest.fn(() => null);
    const cir = storageToCir(
      '<p><ac:emoticon ac:name="thumbs-up"/></p><ac:structured-macro ac:name="excerpt-include"><ac:parameter ac:name=""><ac:link><ri:page ri:content-title="ADDITIONAL MACROS"/></ac:link></ac:parameter></ac:structured-macro>',
      { onMacro },
    );
    const paragraph = cir.children[0];

    expect(paragraph).toMatchObject({
      type: 'paragraph',
      children: [{ type: 'text', text: '👍' }],
    });
    expect(onMacro).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'excerpt-include',
        params: { '': 'ADDITIONAL MACROS' },
      }),
    );
  });

  it('preserves include target content id and space without changing its legacy title param', () => {
    const onMacro = jest.fn(() => null);

    storageToCir(
      '<ac:structured-macro ac:name="include"><ac:parameter ac:name=""><ri:page ri:content-id="456" ri:content-title="Runbook" ri:space-key="OPS"/></ac:parameter></ac:structured-macro>',
      { onMacro },
    );

    expect(onMacro).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'include',
        params: { '': 'Runbook' },
        pageReference: {
          title: 'Runbook',
          sourceId: '456',
          sourceSpaceKey: 'OPS',
        },
      }),
    );
  });
});
