/**
 * CIR → TipTap serializer.
 *
 * The single most important assertion here is the round-trip one: whatever this serializer emits must
 * be ACCEPTED by `validateTipTapDoc`. That validator rejects unknown node/mark types outright, so a
 * drift between the two would not degrade a page — it would fail the entire import with a 400. Every
 * construct below is one the customer's Confluence space actually contains.
 */

// jsdom cannot load under jest here; `tiptap-sanitizer` pulls it in via `sanitize-rich-text`.
// Mocked exactly as the rest of the suite does (see common/utils/sanitize-wiki-content.spec.ts).
jest.mock('../../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (v: string | null | undefined) =>
    v == null ? null : String(v),
}));

import { cirToTipTap } from './cir-to-tiptap';
import type { TipTapNode } from './cir-to-tiptap';
import type { CirDoc, CirNode } from './canonical-ir';
import { cirToHtml, type CirResolved } from './cir-serializer';
import { validateTipTapDoc } from '../../common/utils/tiptap-sanitizer';

const PAGE_UUID = '11111111-2222-4333-8444-555555555555';
const USER_UUID = '99999999-8888-4777-8666-555555555555';

const resolved = (over: Partial<CirResolved> = {}): CirResolved => ({
  users: new Map(),
  pages: new Map(),
  attachments: new Map(),
  jiraIssues: new Map(),
  nativeTables: true,
  ...over,
});

const doc = (...children: CirNode[]): CirDoc => ({ type: 'doc', children });
const t = (text: string): CirNode => ({ type: 'text', text });
const p = (text: string): CirNode => ({
  type: 'paragraph',
  children: [t(text)],
});

/** Collect every node type present in a TipTap doc. */
function typesIn(node: TipTapNode, acc: string[] = []): string[] {
  acc.push(node.type);
  for (const c of node.content ?? []) typesIn(c, acc);

  return acc;
}

function find(node: TipTapNode, type: string): TipTapNode | undefined {
  if (node.type === type) return node;
  for (const c of node.content ?? []) {
    const hit = find(c, type);

    if (hit) return hit;
  }

  return undefined;
}

/** The gate every migrated page must pass. */
const expectValid = (out: TipTapNode) =>
  expect(() => validateTipTapDoc(JSON.stringify(out))).not.toThrow();

describe('cirToTipTap', () => {
  it('always produces a doc the write gate accepts, even when empty', () => {
    const out = cirToTipTap(doc(), resolved());

    expect(out.type).toBe('doc');
    // A doc with no children is invalid in the TipTap schema; we always emit one paragraph.
    expect(out.content?.length).toBeGreaterThan(0);
    expectValid(out);
  });

  it('keeps Confluence anchor destinations so fragment links remain usable', () => {
    const out = cirToTipTap(
      doc({ type: 'anchor', name: 'release-notes' }),
      resolved(),
    );

    expect(find(out, 'confluenceAnchor')?.attrs).toEqual({
      name: 'release-notes',
    });
    expectValid(out);
  });

  it('maps panels onto callout variants, including Confluence-only note/tip', () => {
    for (const [variant, expected] of [
      ['info', 'info'],
      ['note', 'note'],
      ['tip', 'tip'],
      ['warning', 'warning'],
      ['error', 'danger'],
      ['success', 'success'],
    ] as const) {
      const out = cirToTipTap(
        doc({ type: 'panel', variant, title: 'T', children: [p('body')] }),
        resolved(),
      );

      expect(find(out, 'callout')?.attrs?.variant).toBe(expected);
      expectValid(out);
    }
  });

  it('keeps safe custom panel presentation attrs on the callout', () => {
    const out = cirToTipTap(
      doc({
        type: 'panel',
        variant: 'custom',
        title: 'ADDITIONAL MACROS',
        backgroundColor: '#f7f8f9',
        borderColor: '#091e4224',
        borderStyle: 'solid',
        borderWidth: 2,
        titleBackgroundColor: '#dfe1e6',
        titleColor: '#172b4d',
        children: [p('body')],
      }),
      resolved(),
    );

    expect(find(out, 'callout')?.attrs).toMatchObject({
      variant: 'custom',
      title: 'ADDITIONAL MACROS',
      backgroundColor: '#f7f8f9',
      borderColor: '#091e4224',
      borderStyle: 'solid',
      borderWidth: 2,
      titleBackgroundColor: '#dfe1e6',
      titleColor: '#172b4d',
    });
    expectValid(out);
  });

  it('emits a real horizontalRule instead of the HTML path’s faked divider', () => {
    const out = cirToTipTap(doc({ type: 'rule' }), resolved());

    expect(typesIn(out)).toContain('horizontalRule');
    expectValid(out);
  });

  it('emits a real details/summary disclosure for an expand macro', () => {
    const out = cirToTipTap(
      doc({ type: 'expand', title: 'More', children: [p('hidden')] }),
      resolved(),
    );
    const types = typesIn(out);

    expect(types).toEqual(
      expect.arrayContaining(['details', 'detailsSummary', 'detailsContent']),
    );
    expectValid(out);
  });

  it('serializes live excerpt and include nodes without freezing target content', () => {
    const out = cirToTipTap(
      doc(
        {
          type: 'excerpt',
          hidden: true,
          name: 'summary',
          sourceParams: { hidden: 'true', name: 'summary' },
          children: [p('source body')],
        },
        {
          type: 'includePage',
          pageId: PAGE_UUID,
          title: 'Source page',
          targetSpaceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          targetSpaceKey: 'OPS',
          sourceParams: { pageId: 'source-17' },
        },
        {
          type: 'excerptInclude',
          pageId: PAGE_UUID,
          title: 'Source page',
          excerptName: 'summary',
          nopanel: true,
          sourceParams: { excerpt: 'summary', nopanel: 'true' },
        },
      ),
      resolved(),
    );

    expect(find(out, 'excerpt')).toMatchObject({
      attrs: { hidden: true, name: 'summary' },
    });
    expect(find(out, 'includePage')).toMatchObject({
      attrs: {
        pageId: PAGE_UUID,
        title: 'Source page',
        targetSpaceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        targetSpaceKey: 'OPS',
      },
    });
    expect(find(out, 'excerptInclude')).toMatchObject({
      attrs: {
        pageId: PAGE_UUID,
        title: 'Source page',
        excerptName: 'summary',
        nopanel: true,
      },
    });
    expectValid(out);
  });

  it('maps a layout to columnList/column so multi-column pages keep their shape', () => {
    const out = cirToTipTap(
      doc({ type: 'layout', columns: [[p('left')], [p('right')]] }),
      resolved(),
    );

    expect(find(out, 'columnList')?.content).toHaveLength(2);
    expectValid(out);
  });

  it('maps imported layout proportions onto column widths', () => {
    const out = cirToTipTap(
      doc({
        type: 'layout',
        columns: [[p('left')], [p('right')]],
        widths: [30, 70],
      }),
      resolved(),
    );

    expect(
      find(out, 'columnList')?.content?.map((column) => column.attrs),
    ).toEqual([{ width: 30 }, { width: 70 }]);
    expectValid(out);
  });

  it('keeps layout proportions in the legacy HTML serializer', () => {
    const html = cirToHtml(
      doc({
        type: 'layout',
        columns: [[p('left')], [p('right')]],
        widths: [30, 70],
      }),
      resolved(),
    );

    expect(html).toContain('<table class="xi-layout" width="100%">');
    expect(html).toContain('<td class="xi-col" width="30%">');
    expect(html).toContain('<td class="xi-col" width="70%">');
  });

  it('keeps tables as real table nodes with colspan/rowspan', () => {
    const out = cirToTipTap(
      doc({
        type: 'table',
        rows: [
          {
            cells: [
              { header: true, children: [t('H')], colspan: 2 },
              { header: false, children: [t('C')], rowspan: 3 },
            ],
          },
        ],
      }),
      resolved(),
    );

    expect(find(out, 'tableHeader')?.attrs?.colspan).toBe(2);
    expect(find(out, 'tableCell')?.attrs?.rowspan).toBe(3);
    expectValid(out);
  });

  it('wraps inline cell content in a paragraph (block containers need block children)', () => {
    const out = cirToTipTap(
      doc({
        type: 'table',
        rows: [{ cells: [{ header: false, children: [t('bare text')] }] }],
      }),
      resolved(),
    );

    expect(find(out, 'tableCell')?.content?.[0]?.type).toBe('paragraph');
    expectValid(out);
  });

  it('converts CIR marks to TipTap mark names and carries links', () => {
    const out = cirToTipTap(
      doc({
        type: 'paragraph',
        children: [
          {
            type: 'text',
            text: 'x',
            marks: ['strong', 'em'],
            link: 'https://e.com',
          },
        ],
      }),
      resolved(),
    );
    const node = find(out, 'text');
    const names = (node?.marks ?? []).map((m) => m.type);

    expect(names).toEqual(expect.arrayContaining(['bold', 'italic', 'link']));
    expectValid(out);
  });

  it('resolves a status lozenge colour and falls back to neutral for unknown colours', () => {
    const ok = cirToTipTap(
      doc({ type: 'status', text: 'DONE', color: 'Green' }),
      resolved(),
    );

    expect(find(ok, 'status')?.attrs?.color).toBe('green');

    const odd = cirToTipTap(
      doc({ type: 'status', text: 'X', color: 'chartreuse' }),
      resolved(),
    );

    expect(find(odd, 'status')?.attrs?.color).toBe('neutral');
    expectValid(ok);
    expectValid(odd);
  });

  describe('references degrade to text rather than emitting an invalid attr', () => {
    it('emits userMention when the author resolved to a real UUID', () => {
      const out = cirToTipTap(
        doc({
          type: 'paragraph',
          children: [{ type: 'userMention', sourceId: 'acc-1' }],
        }),
        resolved({
          users: new Map([
            ['acc-1', { userId: USER_UUID, displayName: 'Rajbha' }],
          ]),
        }),
      );

      expect(find(out, 'userMention')?.attrs?.userId).toBe(USER_UUID);
      expectValid(out);
    });

    it('falls back to @name text when the author is unresolved', () => {
      const out = cirToTipTap(
        doc({
          type: 'paragraph',
          children: [
            { type: 'userMention', sourceId: 'ghost', displayName: 'Ada' },
          ],
        }),
        resolved(),
      );

      expect(typesIn(out)).not.toContain('userMention');
      expect(find(out, 'text')?.text).toBe('@Ada');
      expectValid(out);
    });

    it('uses an honest label when an unresolved author has no display name', () => {
      const out = cirToTipTap(
        doc({
          type: 'paragraph',
          children: [{ type: 'userMention', sourceId: 'ghost' }],
        }),
        resolved(),
      );

      expect(find(out, 'text')?.text).toBe('@Unknown Confluence user');
      expectValid(out);
      expect(
        cirToHtml(
          doc({
            type: 'paragraph',
            children: [{ type: 'userMention', sourceId: 'ghost' }],
          }),
          resolved(),
        ),
      ).toContain('@Unknown Confluence user');
    });

    it('marks a resolved placeholder user without losing the recovered name', () => {
      const users = new Map([
        [
          'legacy-user',
          {
            userId: USER_UUID,
            displayName: 'Christian Kienzl',
            isPlaceholder: true,
          },
        ],
      ]);
      const out = cirToTipTap(
        doc({
          type: 'paragraph',
          children: [{ type: 'userMention', sourceId: 'legacy-user' }],
        }),
        resolved({ users }),
      );

      expect(find(out, 'userMention')?.attrs).toMatchObject({
        userName: 'Christian Kienzl',
        isPlaceholder: true,
      });
      expectValid(out);
      expect(
        cirToHtml(
          doc({
            type: 'paragraph',
            children: [{ type: 'userMention', sourceId: 'legacy-user' }],
          }),
          resolved({ users }),
        ),
      ).toContain(
        'Imported Confluence user is not an active organization member',
      );
    });

    it('emits wikiLink for a resolved page and plain text otherwise', () => {
      const hit = cirToTipTap(
        doc({
          type: 'paragraph',
          children: [
            {
              type: 'pageLink',
              pageSourceId: 'Runbook',
              fragment: 'release-notes',
            },
          ],
        }),
        resolved({
          pages: new Map([
            ['Runbook', { url: `/wiki/${PAGE_UUID}`, title: 'Runbook' }],
          ]),
        }),
      );

      expect(find(hit, 'wikiLink')?.attrs?.pageId).toBe(PAGE_UUID);
      expect(find(hit, 'wikiLink')?.attrs?.fragment).toBe('release-notes');
      expectValid(hit);

      const miss = cirToTipTap(
        doc({
          type: 'paragraph',
          children: [{ type: 'pageLink', pageSourceId: 'Gone', text: 'Gone' }],
        }),
        resolved(),
      );

      expect(typesIn(miss)).not.toContain('wikiLink');
      expectValid(miss);
    });
  });

  describe('media', () => {
    it('carries a mapped legacy Word preview URL without changing its original download URL', () => {
      const out = cirToTipTap(
        doc({ type: 'media', kind: 'file', filename: 'legacy.doc' }),
        resolved({
          attachments: new Map([['legacy.doc', 'https://cdn/x/legacy.doc']]),
          attachmentPreviews: new Map([
            ['legacy.doc', 'https://cdn/x/legacy-preview.docx'],
          ]),
        }),
      );

      const attachment = find(out, 'fileAttachment');
      expect(attachment?.attrs?.url).toBe('https://cdn/x/legacy.doc');
      expect(attachment?.attrs?.previewUrl).toBe(
        'https://cdn/x/legacy-preview.docx',
      );
      expectValid(out);
    });

    it('resolves an attachment filename through the crosswalk to a real image', () => {
      const out = cirToTipTap(
        doc({
          type: 'media',
          kind: 'image',
          filename: 'a.png',
          alt: 'A',
          width: '240px',
        }),
        resolved({ attachments: new Map([['a.png', 'https://cdn/x/a.png']]) }),
      );
      const img = find(out, 'image');

      expect(img?.attrs?.src).toBe('https://cdn/x/a.png');
      expect(img?.attrs?.width).toBe(240);
      expectValid(out);
    });

    it('keeps imported image alignment', () => {
      const out = cirToTipTap(
        doc({
          type: 'media',
          kind: 'image',
          src: 'https://cdn/x/a.png',
          align: 'right',
        }),
        resolved(),
      );

      expect(find(out, 'image')?.attrs?.textAlign).toBe('right');
      expectValid(out);
    });

    it('keeps block image alignment in the legacy HTML serializer', () => {
      const html = cirToHtml(
        doc({
          type: 'media',
          kind: 'image',
          src: 'https://cdn/x/a.png',
          align: 'right',
        }),
        resolved(),
      );

      expect(html).toBe('<p align="right"><img src="https://cdn/x/a.png"></p>');
    });

    it('does not nest paragraphs around an aligned image in mixed content', () => {
      const html = cirToHtml(
        doc({
          type: 'paragraph',
          children: [
            t('before'),
            {
              type: 'media',
              kind: 'image',
              src: 'https://cdn/x/a.png',
              align: 'center',
            },
            t('after'),
          ],
        }),
        resolved(),
      );

      expect(html).toBe(
        'before<p align="center"><img src="https://cdn/x/a.png"></p>after',
      );
      expect(html).not.toContain('<p>before<p');
    });

    it('degrades an unresolved attachment to a visible placeholder, not a broken image', () => {
      const out = cirToTipTap(
        doc({ type: 'media', kind: 'image', filename: 'missing.png' }),
        resolved(),
      );

      expect(typesIn(out)).not.toContain('image');
      expect(JSON.stringify(out)).toContain('[Image: missing.png]');
      expectValid(out);
    });
  });

  it('turns an unknown macro into a labelled card instead of dropping it', () => {
    const out = cirToTipTap(
      doc({ type: 'macroDeferred', name: 'jira-chart' }),
      resolved(),
    );

    expect(find(out, 'externalMacro')?.attrs?.name).toBe('jira-chart');
    expectValid(out);
  });

  it('maps a Jira issue only when its exact migration crosswalk resolves', () => {
    const issue: CirNode = {
      type: 'jiraIssue',
      key: 'XI-42',
      macroName: 'jira',
      params: { key: 'XI-42', columns: 'key,summary' },
      sourceUrl: 'https://jira.example.test/browse/XI-42',
      children: [],
    };
    const mapped = cirToTipTap(
      doc(issue),
      resolved({ jiraIssues: new Map([['XI-42', { taskKey: 'ENG-9' }]]) }),
    );
    const unresolved = cirToTipTap(doc(issue), resolved());

    expect(find(mapped, 'taskCard')?.attrs).toEqual({
      config: {
        taskKey: 'ENG-9',
        sourceMacro: 'jira',
        sourceParams: { key: 'XI-42', columns: 'key,summary' },
        sourceBody: '[]',
        sourceUrl: 'https://jira.example.test/browse/XI-42',
      },
    });
    expect(find(unresolved, 'externalMacro')?.attrs).toEqual({
      name: 'jira',
      params: { key: 'XI-42', columns: 'key,summary' },
      sourceUrl: 'https://jira.example.test/browse/XI-42',
    });
    expectValid(mapped);
    expectValid(unresolved);
  });

  it('turns the attachments macro into a live attachmentsList node', () => {
    const out = cirToTipTap(doc({ type: 'attachmentsMacro' }), resolved());

    expect(typesIn(out)).toContain('attachmentsList');
    expectValid(out);
  });

  it('serializes a native chart macro to the editable chart node', () => {
    const out = cirToTipTap(
      doc({
        type: 'chart',
        chartType: 'bar',
        title: 'Delivery status',
        sourceParams: { attachment: 'sales.png' },
        children: [
          {
            type: 'table',
            rows: [
              {
                cells: [
                  { header: true, children: [t('Team')] },
                  { header: true, children: [t('Done')] },
                ],
              },
            ],
          },
        ],
      }),
      resolved(),
    );

    expect(find(out, 'chart')?.attrs).toMatchObject({
      type: 'bar',
      title: 'Delivery status',
      sourceParams: { attachment: 'sales.png' },
    });
    expect(find(out, 'chart')?.content?.[0]?.type).toBe('table');
    expectValid(out);
  });

  it('serializes a native gallery macro to the attachment gallery node', () => {
    const out = cirToTipTap(
      doc({
        type: 'gallery',
        title: 'Screenshots',
        columns: 3,
        include: ['Alpha.png'],
        sort: 'name',
        reverse: true,
        sourceParams: { include: 'Alpha.png' },
      }),
      resolved(),
    );

    expect(find(out, 'gallery')?.attrs).toMatchObject({
      title: 'Screenshots',
      columns: 3,
      include: ['Alpha.png'],
      sort: 'name',
      reverse: true,
      sourceParams: { include: 'Alpha.png' },
    });
    expectValid(out);
  });

  it('serializes the Confluence tasks report as a native live node', () => {
    const out = cirToTipTap(
      doc({
        type: 'liveMacro',
        kind: 'taskReport',
        params: { maxResults: '25' },
      }),
      resolved(),
    );

    expect(find(out, 'taskReport')?.attrs).toEqual({ limit: 25 });
    expectValid(out);
  });

  it('serializes content-by-label as a bounded, space-scoped native node', () => {
    const out = cirToTipTap(
      doc({
        type: 'liveMacro',
        kind: 'contentByLabel',
        params: {
          labels: 'runbook, security',
          spaces: 'EDV, ITPFM',
          maxResults: '200',
        },
      }),
      resolved(),
    );

    expect(find(out, 'contentByLabel')?.attrs).toEqual({
      labels: ['runbook', 'security'],
      spaceKeys: ['EDV', 'ITPFM'],
      limit: 50,
    });
    expectValid(out);
  });

  it('retains Confluence heading levels through level six', () => {
    const out = cirToTipTap(
      doc({ type: 'heading', level: 6, children: [t('deep')] }),
      resolved(),
    );

    expect(find(out, 'heading')?.attrs?.level).toBe(6);
    expectValid(out);
  });

  it('keeps task list checked state', () => {
    const out = cirToTipTap(
      doc({
        type: 'taskList',
        items: [
          { checked: true, children: [p('done')] },
          { checked: false, children: [p('todo')] },
        ],
      }),
      resolved(),
    );

    expect(find(out, 'taskItem')?.attrs?.checked).toBe(true);
    expectValid(out);
  });

  it('produces a validator-accepted doc for a realistic mixed page', () => {
    const out = cirToTipTap(
      doc(
        { type: 'heading', level: 2, children: [t('Meeting notes')] },
        { type: 'panel', variant: 'info', children: [p('Context')] },
        {
          type: 'table',
          rows: [{ cells: [{ header: true, children: [t('Topic')] }] }],
        },
        {
          type: 'taskList',
          items: [{ checked: false, children: [p('Follow up')] }],
        },
        { type: 'status', text: 'IN PROGRESS', color: 'blue' },
        { type: 'rule' },
        { type: 'codeBlock', language: 'ts', text: 'const a = 1' },
      ),
      resolved(),
    );

    expectValid(out);
    expect(typesIn(out)).toEqual(
      expect.arrayContaining([
        'heading',
        'callout',
        'table',
        'taskList',
        'status',
        'horizontalRule',
        'codeBlock',
      ]),
    );
  });

  describe('drawio diagrams (6 in the live space)', () => {
    const MXFILE =
      '<mxfile host="app.diagrams.net"><diagram>x</diagram></mxfile>';

    it('emits the native drawioDiagram node once the mxfile is resolved', () => {
      // Wiki 2.0 already had this node; the importer used to emit a text placeholder instead, so the
      // drawing was lost even though the target could hold it.
      const out = cirToTipTap(
        doc({ type: 'diagram', name: 'Architecture.drawio', xml: MXFILE }),
        resolved(),
      );
      const node = find(out, 'drawioDiagram');

      expect(node?.attrs?.xml).toBe(MXFILE);
      expect(node?.attrs?.caption).toBe('Architecture.drawio');
      expectValid(out);
    });

    it('degrades to a NAMED placeholder when the mxfile could not be read', () => {
      // `drawioDiagram.attrs.xml` is required, so emitting the node without it would be rejected by
      // the write gate and fail the entire page — the placeholder keeps the page importable.
      const out = cirToTipTap(
        doc({ type: 'diagram', name: 'Architecture.drawio' }),
        resolved(),
      );

      expect(find(out, 'drawioDiagram')).toBeUndefined();
      expect(JSON.stringify(out)).toContain('[Diagram: Architecture.drawio]');
      expectValid(out);
    });

    it('rejects a payload that is not an mxfile, rather than writing an unopenable page', () => {
      expect(() =>
        validateTipTapDoc(
          JSON.stringify({
            type: 'doc',
            content: [
              { type: 'drawioDiagram', attrs: { xml: 'not a diagram' } },
            ],
          }),
        ),
      ).toThrow();
    });
  });

  describe('chart and gallery are block-level', () => {
    // Both were missing from BLOCK_TYPES, so `asBlocks` gathered them into the surrounding
    // paragraph — invalid TipTap content that made the editor throw
    // `RangeError: Invalid content for node type paragraph` on every open.
    it('keeps a chart after a paragraph as a sibling block, not a paragraph child', () => {
      const out = cirToTipTap(
        doc(p('Pie Chart'), {
          type: 'chart',
          chartType: 'pie',
          title: 'Incident Share',
          children: [p('Tier,Findings')],
        }),
        resolved(),
      );
      const chart = find(out, 'chart');

      expect(chart).toBeDefined();
      expect(chart?.attrs?.title).toBe('Incident Share');

      const paragraph = out.content?.find((n) => n.type === 'paragraph');

      expect((paragraph?.content ?? []).some((n) => n.type === 'chart')).toBe(
        false,
      );
      expectValid(out);
    });

    it('keeps a gallery as a top-level block', () => {
      const out = cirToTipTap(
        doc({ type: 'gallery', columns: 3, sourceParams: { columns: '3' } }),
        resolved(),
      );
      const gallery = find(out, 'gallery');

      expect(gallery).toBeDefined();
      expect(out.content?.[0]?.type).toBe('gallery');
      expectValid(out);
    });
  });

  describe('live macro parameter fidelity', () => {
    it('derives contentByLabel labels from the Confluence 8+ cql parameter', () => {
      // Server 8 writes `cql` instead of the classic `labels`; without this the macro degraded
      // to a fidelity card even though the target node could host it natively.
      const out = cirToTipTap(
        doc({
          type: 'liveMacro',
          kind: 'contentByLabel',
          params: { cql: 'label = "macro-test"', max: '20' },
        }),
        resolved(),
      );
      const node = find(out, 'contentByLabel');

      expect(node?.attrs?.labels).toEqual(['macro-test']);
      expectValid(out);
    });

    it('derives contentByLabel labels from a cql `label in (...)` clause', () => {
      const out = cirToTipTap(
        doc({
          type: 'liveMacro',
          kind: 'contentByLabel',
          params: { cql: 'label in ("alpha", "beta") and space = DEMO' },
        }),
        resolved(),
      );

      expect(find(out, 'contentByLabel')?.attrs?.labels).toEqual([
        'alpha',
        'beta',
      ]);
      expectValid(out);
    });

    it('maps content-report-table label parameters to the native labels attr', () => {
      // Without the mapping the node landed with no labels and rendered "No labels configured".
      const out = cirToTipTap(
        doc({
          type: 'liveMacro',
          kind: 'contentReportTable',
          params: { label: 'macro-test', maxResults: '15' },
        }),
        resolved(),
      );
      const node = find(out, 'contentReportTable');

      expect(node?.attrs?.labels).toEqual(['macro-test']);
      expect(node?.attrs?.limit).toBe(15);
      expectValid(out);
    });
  });

  describe('constructs that used to be dropped or flattened', () => {
    it('emits mediaInline for inline media instead of losing it to the inline guard', () => {
      // A block `image` inside a paragraph is filtered out by `asInline`. That is exactly how all 17
      // inline images in the customer's space disappeared, with no error and no lossy log.
      const out = cirToTipTap(
        doc({
          type: 'paragraph',
          children: [
            { type: 'text', text: 'see ' },
            {
              type: 'media',
              kind: 'image',
              inline: true,
              filename: 'shot.png',
            },
          ],
        }),
        resolved({
          attachments: new Map([['shot.png', 'https://cdn/shot.png']]),
        }),
      );

      expect(find(out, 'mediaInline')?.attrs?.src).toBe('https://cdn/shot.png');
      expectValid(out);
    });

    it('still emits a BLOCK image for block media', () => {
      const out = cirToTipTap(
        doc({ type: 'media', kind: 'image', filename: 'shot.png' }),
        resolved({
          attachments: new Map([['shot.png', 'https://cdn/shot.png']]),
        }),
      );

      expect(find(out, 'image')).toBeDefined();
      expect(find(out, 'mediaInline')).toBeUndefined();
      expectValid(out);
    });

    it('splits a paragraph around a block macro instead of dropping it', () => {
      const out = cirToTipTap(
        doc({
          type: 'paragraph',
          children: [
            { type: 'text', text: 'before ' },
            {
              type: 'liveMacro',
              kind: 'pageTree',
              params: { rootPageId: 'b6a64cb7-befe-4538-9a31-6b89377ff0c1' },
            },
            { type: 'text', text: ' after' },
          ],
        }),
        resolved(),
      );

      expect(out.content?.map((node) => node.type)).toEqual([
        'paragraph',
        'pageTree',
        'paragraph',
      ]);
      expectValid(out);
    });

    it('emits a date lozenge', () => {
      const out = cirToTipTap(
        doc({ type: 'date', timestamp: '1735689600000' }),
        resolved(),
      );

      expect(find(out, 'date')?.attrs?.timestamp).toBe('1735689600000');
      expectValid(out);
    });

    it('emits an inlineCard chip', () => {
      const out = cirToTipTap(
        doc({ type: 'inlineCard', url: 'https://example.com/x' }),
        resolved(),
      );

      expect(find(out, 'inlineCard')?.attrs?.url).toBe('https://example.com/x');
      expectValid(out);
    });

    it('carries indent and alignment as BLOCK attrs on paragraph and heading', () => {
      const out = cirToTipTap(
        doc(
          { type: 'paragraph', children: [t('a')], indent: 2, align: 'center' },
          {
            type: 'heading',
            level: 2,
            children: [t('b')],
            indent: 1,
            align: 'right',
          },
        ),
        resolved(),
      );

      expect(find(out, 'paragraph')?.attrs).toMatchObject({
        indent: 2,
        textAlign: 'center',
      });
      expect(find(out, 'heading')?.attrs).toMatchObject({
        level: 2,
        indent: 1,
        textAlign: 'right',
      });
      expectValid(out);
    });

    it('does not emit a textAlign attr for the default left alignment', () => {
      const out = cirToTipTap(
        doc({ type: 'paragraph', children: [t('a')], align: 'left' }),
        resolved(),
      );

      expect(find(out, 'paragraph')?.attrs?.textAlign).toBeUndefined();
      expectValid(out);
    });

    it('carries a text colour as a textStyle mark', () => {
      const out = cirToTipTap(
        doc({
          type: 'paragraph',
          children: [{ type: 'text', text: 'x', color: '#ff0000' }],
        }),
        resolved(),
      );

      expect(JSON.stringify(out)).toContain('"textStyle"');
      expectValid(out);
    });

    it('reproduces live macros as live nodes rather than placeholder text', () => {
      const out = cirToTipTap(
        doc(
          { type: 'liveMacro', kind: 'pageTree', params: { depth: '3' } },
          { type: 'liveMacro', kind: 'recentlyUpdated', params: { max: '5' } },
          { type: 'liveMacro', kind: 'contributors', params: {} },
        ),
        resolved(),
      );

      expect(find(out, 'pageTree')?.attrs?.depth).toBe(3);
      expect(find(out, 'recentlyUpdated')?.attrs?.limit).toBe(5);
      expect(find(out, 'contributors')).toBeDefined();
      expectValid(out);
    });

    it('normalises native report macro parameters into their TipTap contracts', () => {
      const out = cirToTipTap(
        doc(
          { type: 'liveMacro', kind: 'changeHistory', params: { limit: '75' } },
          {
            type: 'liveMacro',
            kind: 'pageTreeSearch',
            params: { mode: 'searchResults', query: 'release notes' },
          },
          { type: 'liveMacro', kind: 'spaceDetails', params: { width: '75%' } },
          {
            type: 'liveMacro',
            kind: 'userList',
            params: { groups: 'engineering, design' },
          },
          {
            type: 'liveMacro',
            kind: 'userProfile',
            params: { userName: 'Ada Lovelace', userKey: 'source-user-7' },
          },
          {
            type: 'liveMacro',
            kind: 'profilePicture',
            params: { userName: 'Ada Lovelace', userKey: 'source-user-7' },
          },
          {
            type: 'liveMacro',
            kind: 'popularLabels',
            params: { count: '20', spaceKey: 'ENG', style: 'heatmap' },
          },
        ),
        resolved(),
      );

      expect(find(out, 'changeHistory')?.attrs).toEqual({ limit: 75 });
      expect(find(out, 'pageTreeSearch')?.attrs).toEqual({
        mode: 'searchResults',
        query: 'release notes',
      });
      expect(find(out, 'spaceDetails')?.attrs).toEqual({ width: '75%' });
      expect(find(out, 'userList')?.attrs).toEqual({
        groups: ['engineering', 'design'],
      });
      expect(find(out, 'userProfile')?.attrs).toEqual({
        userKey: 'source-user-7',
        userName: 'Ada Lovelace',
      });
      expect(find(out, 'profilePicture')?.attrs).toEqual({
        userKey: 'source-user-7',
        userName: 'Ada Lovelace',
      });
      expect(find(out, 'popularLabels')?.attrs).toEqual({
        count: 20,
        spaceKey: 'ENG',
        style: 'heatmap',
      });
      expectValid(out);
    });

    it('normalises the remaining report macros and retains source provenance', () => {
      const source = {
        sourceName: 'content-report-table',
        sourceParams: { labels: 'security,review', maxResults: '25' },
        sourceBody: '',
      };
      const out = cirToTipTap(
        doc(
          {
            type: 'liveMacro',
            kind: 'recentlyUsedLabels',
            params: { count: '10', scope: 'space', style: 'table' },
            ...source,
          },
          {
            type: 'liveMacro',
            kind: 'relatedLabels',
            params: { labels: 'security,review' },
            ...source,
          },
          {
            type: 'liveMacro',
            kind: 'contentByUser',
            params: { name: 'legacy-user' },
            ...source,
          },
          {
            type: 'liveMacro',
            kind: 'recentlyUpdatedDashboard',
            params: {
              spaces: 'ENG',
              types: 'page',
              labels: 'security',
              users: 'source-user',
            },
            ...source,
          },
          {
            type: 'liveMacro',
            kind: 'contentReportTable',
            params: {
              labels: 'security,review',
              spaces: 'ENG',
              maxResults: '25',
            },
            ...source,
          },
          {
            type: 'liveMacro',
            kind: 'decisionReport',
            params: { labels: 'architecture', maxResults: '30' },
            ...source,
          },
          {
            type: 'liveMacro',
            kind: 'navigationMap',
            params: {
              label: 'security',
              title: 'Security',
              wrapAfter: '4',
              cellWidth: '90%',
            },
            ...source,
          },
        ),
        resolved(),
      );

      expect(find(out, 'recentlyUsedLabels')?.attrs).toMatchObject({
        count: 10,
        scope: 'space',
        style: 'table',
      });
      expect(find(out, 'relatedLabels')?.attrs?.labels).toEqual([
        'security',
        'review',
      ]);
      expect(find(out, 'contentByUser')?.attrs?.userName).toBe('legacy-user');
      expect(find(out, 'recentlyUpdatedDashboard')?.attrs).toMatchObject({
        spaceKeys: ['ENG'],
        types: ['page'],
        labels: ['security'],
        users: ['source-user'],
      });
      expect(find(out, 'contentReportTable')?.attrs).toMatchObject({
        labels: ['security', 'review'],
        spaceKeys: ['ENG'],
        limit: 25,
        sourceName: 'content-report-table',
        sourceParams: source.sourceParams,
        sourceBody: '',
      });
      expect(find(out, 'decisionReport')?.attrs).toMatchObject({
        labels: ['architecture'],
        limit: 30,
      });
      expect(find(out, 'navigationMap')?.attrs).toMatchObject({
        label: 'security',
        title: 'Security',
        wrapAfter: 4,
        cellWidth: '90%',
      });
      expectValid(out);
    });

    it('serializes the create-space action with constrained size and source provenance', () => {
      const source = doc({
        type: 'createSpaceButton',
        size: 'small',
        sourceName: 'create-space-button',
        sourceParams: { size: 'small' },
      });
      const out = cirToTipTap(source, resolved());

      expect(find(out, 'createSpaceButton')?.attrs).toEqual({
        size: 'small',
        sourceName: 'create-space-button',
        sourceParams: { size: 'small' },
      });
      expectValid(out);
      expect(cirToHtml(source, resolved())).toBe('');
    });

    it('keeps existing report caps while allowing 100 change-history rows', () => {
      const out = cirToTipTap(
        doc(
          {
            type: 'liveMacro',
            kind: 'changeHistory',
            params: { limit: '100' },
          },
          {
            type: 'liveMacro',
            kind: 'recentlyUpdated',
            params: { limit: '75' },
          },
        ),
        resolved(),
      );

      expect(find(out, 'changeHistory')?.attrs?.limit).toBe(100);
      expect(find(out, 'recentlyUpdated')?.attrs?.limit).toBe(50);
      expectValid(out);
    });

    it('serializes content properties and their report without dropping provenance', () => {
      const sourceParams = { id: 'release', hidden: 'true' };
      const out = cirToTipTap(
        doc(
          {
            type: 'contentProperties',
            propertyId: 'release',
            hidden: true,
            rows: [{ key: 'Status', value: 'Ready' }],
            sourceParams,
            sourceBody: '[{"type":"table"}]',
          },
          {
            type: 'contentPropertiesReport',
            label: 'release-notes',
            propertyId: 'release',
            columns: ['Status'],
            titleColumn: 'Document',
            limit: 20,
            sourceParams: { labels: 'release-notes' },
          },
        ),
        resolved(),
      );

      expect(find(out, 'contentProperties')?.attrs).toEqual({
        propertyId: 'release',
        hidden: true,
        rows: [{ key: 'Status', value: 'Ready' }],
        sourceParams,
        sourceBody: '[{"type":"table"}]',
      });
      expect(find(out, 'contentPropertiesReport')?.attrs).toEqual({
        label: 'release-notes',
        propertyId: 'release',
        columns: ['Status'],
        titleColumn: 'Document',
        limit: 20,
        sourceParams: { labels: 'release-notes' },
      });
      expectValid(out);
    });

    it('does NOT pass Confluence ids into attrs the validator requires to be UUIDs', () => {
      // `pageTree.rootPageId` is a uuid() attr; handing it a numeric Confluence id would fail the
      // whole page write rather than the single node.
      const out = cirToTipTap(
        doc({
          type: 'liveMacro',
          kind: 'pageTree',
          params: { root: '1836449793' },
        }),
        resolved(),
      );

      expect(find(out, 'pageTree')?.attrs?.rootPageId).toBeUndefined();
      expectValid(out);
    });

    it('uses the local page id as the root of a migrated children tree', () => {
      const out = cirToTipTap(
        doc({
          type: 'liveMacro',
          kind: 'pageTree',
          params: { rootPageId: 'b6a64cb7-befe-4538-9a31-6b89377ff0c1' },
        }),
        resolved(),
      );

      expect(find(out, 'pageTree')?.attrs?.rootPageId).toBe(
        'b6a64cb7-befe-4538-9a31-6b89377ff0c1',
      );
      expectValid(out);
    });

    it('preserves every parameter of a vendor macro on an externalMacro card', () => {
      const out = cirToTipTap(
        doc({
          type: 'externalMacro',
          name: 'azure-devops-macro-wiki',
          params: { org: 'acme', project: 'x' },
        }),
        resolved(),
      );
      const card = find(out, 'externalMacro');

      expect(card?.attrs?.name).toBe('azure-devops-macro-wiki');
      expect(card?.attrs?.params).toEqual({ org: 'acme', project: 'x' });
      expectValid(out);
    });
  });

  describe('a block node that arrives inside an inline run', () => {
    it('promotes it to a sibling instead of dropping it', () => {
      // Confluence allows an `inlineExtension` inside a paragraph, and every `pagetree` macro in the
      // customer's space is shaped that way. `asInline` used to drop the resulting block node, so all
      // 4 live page trees vanished with no error and no lossy log.
      const out = cirToTipTap(
        doc({
          type: 'paragraph',
          children: [
            t('before '),
            { type: 'liveMacro', kind: 'pageTree', params: {} },
            t(' after'),
          ],
        }),
        resolved(),
      );

      expect(find(out, 'pageTree')).toBeDefined();
      // The surrounding prose survives on both sides of the promoted block.
      expect(JSON.stringify(out)).toContain('before ');
      expect(JSON.stringify(out)).toContain(' after');
      expectValid(out);
    });

    it('keeps the paragraph attrs on the paragraph parts only', () => {
      const out = cirToTipTap(
        doc({
          type: 'paragraph',
          indent: 2,
          children: [
            t('x'),
            { type: 'liveMacro', kind: 'contributors', params: {} },
          ],
        }),
        resolved(),
      );

      expect(find(out, 'paragraph')?.attrs?.indent).toBe(2);
      expect(find(out, 'contributors')?.attrs?.indent).toBeUndefined();
      expectValid(out);
    });
  });

  /**
   * The customer-reported failure, end to end.
   *
   * A German Confluence space full of Word-exported bookmark anchors
   * (`<a name="_Toc123">`) produced link nodes with an empty href. The write gate
   * refuses an empty href, and it refuses the WHOLE document, so 214 of 216
   * pages failed with `Invalid TipTap document at …marks[0].attrs.href`.
   */
  describe('anchors that carry no usable href', () => {
    it('renders a bookmark anchor as text, and the doc still validates', () => {
      const out = cirToTipTap(
        doc({
          type: 'paragraph',
          children: [{ type: 'link', href: '', children: [t('Kapitel 3')] }],
        }),
        resolved(),
      );

      expect(JSON.stringify(out)).toContain('Kapitel 3');
      // No link mark should survive with an unusable href.
      expect(JSON.stringify(out)).not.toContain('"href":""');
      expectValid(out);
    });

    it.each([
      ['empty', ''],
      ['whitespace only', '   '],
      ['javascript scheme', 'javascript:alert(1)'],
      ['over 4096 chars', `https://e.com/${'a'.repeat(4097)}`],
    ])('never fails the whole document — %s href', (_label, href) => {
      const out = cirToTipTap(
        doc({
          type: 'paragraph',
          children: [{ type: 'link', href, children: [t('Kapitel 3')] }],
        }),
        resolved(),
      );

      // The text always survives; only the unusable link is lost.
      expect(JSON.stringify(out)).toContain('Kapitel 3');
      expectValid(out);
    });

    it('still emits a real link when the href IS usable', () => {
      const out = cirToTipTap(
        doc({
          type: 'paragraph',
          children: [
            {
              type: 'link',
              href: 'https://example.com',
              children: [t('hier')],
            },
          ],
        }),
        resolved(),
      );

      expect(JSON.stringify(out)).toContain('https://example.com');
      expectValid(out);
    });
  });
});
