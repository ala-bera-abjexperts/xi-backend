/**
 * Confluence-parity node contract.
 *
 * Every construct the Confluence importer emits must satisfy TWO backend guarantees, and each one
 * fails in a different, silent way if missed:
 *
 *   1. `validateTipTapDoc` accepts it — an unknown node type is REJECTED outright, so a missing
 *      NODE_SPECS entry does not degrade the node, it fails the entire page write with a 400.
 *   2. `tiptapToPlainText` extracts its text — this feeds `wiki_pages.content_text`, which feeds the
 *      generated `search_vector`. A node whose text is not projected is invisible to search even
 *      though a reader can plainly see it on the page.
 *
 * The counts in the table below are the real census of the customer's Confluence space (339 pages),
 * so this list is not speculative — every entry is content that actually has to survive.
 */

// jsdom cannot load in this jest env, and `tiptap-sanitizer` pulls it in transitively via
// `sanitize-rich-text`. The rest of the suite mocks it exactly this way (see
// sanitize-wiki-content.spec.ts). None of the assertions below depend on DOMPurify behaviour —
// they test the node/attr contract and the plain-text projection.
jest.mock('./sanitize-rich-text', () => ({
  sanitizeRichText: (v: string | null | undefined) =>
    v == null ? null : String(v),
}));

import { validateTipTapDoc } from './tiptap-sanitizer';
import { tiptapToPlainText } from '../../wiki/wiki-content.util';

/** A minimal doc wrapping the node under test. */
const doc = (...content: unknown[]) => JSON.stringify({ type: 'doc', content });

const para = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

describe('Confluence parity — TipTap node contract', () => {
  describe('every parity node is accepted by the write gate', () => {
    const cases: { name: string; node: unknown }[] = [
      {
        name: 'date',
        node: { type: 'date', attrs: { timestamp: '1760400000000' } },
      },
      {
        name: 'status',
        node: { type: 'status', attrs: { text: 'IN PROGRESS', color: 'blue' } },
      },
      {
        name: 'inlineCard',
        node: {
          type: 'inlineCard',
          attrs: { url: 'https://example.com/x', title: 'Spec' },
        },
      },
      {
        name: 'mediaInline',
        node: {
          type: 'mediaInline',
          attrs: {
            src: 'https://cdn.example.com/a.png',
            name: 'a.png',
            mime: 'image/png',
          },
        },
      },
      {
        name: 'decisionList/decisionItem',
        node: {
          type: 'decisionList',
          content: [
            {
              type: 'decisionItem',
              attrs: { state: 'DECIDED' },
              content: [para('Ship on Friday')],
            },
          ],
        },
      },
      {
        name: 'caption',
        node: {
          type: 'caption',
          content: [{ type: 'text', text: 'Figure 1' }],
        },
      },
      {
        name: 'pageTree',
        node: { type: 'pageTree', attrs: { depth: 3 } },
      },
      { name: 'attachmentsList', node: { type: 'attachmentsList', attrs: {} } },
      {
        name: 'recentlyUpdated',
        node: { type: 'recentlyUpdated', attrs: { limit: 10 } },
      },
      {
        name: 'changeHistory',
        node: { type: 'changeHistory', attrs: { limit: 25 } },
      },
      {
        name: 'pageTreeSearch',
        node: {
          type: 'pageTreeSearch',
          attrs: {
            rootPageId: '11111111-2222-4333-8444-555555555555',
            mode: 'searchResults',
            query: 'release notes',
          },
        },
      },
      {
        name: 'spaceDetails',
        node: { type: 'spaceDetails', attrs: { width: '75%' } },
      },
      {
        name: 'userList',
        node: { type: 'userList', attrs: { groups: ['engineering'] } },
      },
      {
        name: 'userProfile',
        node: {
          type: 'userProfile',
          attrs: { userKey: 'source-user-7', userName: 'Ada Lovelace' },
        },
      },
      {
        name: 'profilePicture',
        node: {
          type: 'profilePicture',
          attrs: { userKey: 'source-user-7', userName: 'Ada Lovelace' },
        },
      },
      {
        name: 'popularLabels',
        node: {
          type: 'popularLabels',
          attrs: { count: 20, spaceKey: 'ENG', style: 'heatmap' },
        },
      },
      {
        name: 'createSpaceButton',
        node: {
          type: 'createSpaceButton',
          attrs: {
            size: 'small',
            sourceName: 'create-space-button',
            sourceParams: { size: 'small' },
          },
        },
      },
      {
        name: 'excerpt',
        node: {
          type: 'excerpt',
          attrs: {
            hidden: true,
            name: 'summary',
            sourceParams: { hidden: 'true', name: 'summary' },
          },
          content: [para('Reusable summary')],
        },
      },
      {
        name: 'includePage',
        node: {
          type: 'includePage',
          attrs: {
            pageId: '11111111-2222-4333-8444-555555555555',
            title: 'Reusable content',
            targetSpaceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            targetSpaceKey: 'ENG',
            sourceParams: { pageId: 'source-17' },
            sourceReference: {
              title: 'Reusable content',
              sourceId: 'source-17',
              sourceSpaceKey: 'ENG',
            },
          },
        },
      },
      {
        name: 'excerptInclude',
        node: {
          type: 'excerptInclude',
          attrs: {
            pageId: '11111111-2222-4333-8444-555555555555',
            title: 'Reusable content',
            excerptName: 'summary',
            nopanel: true,
            sourceParams: { excerpt: 'summary', nopanel: 'true' },
          },
        },
      },
      {
        name: 'unresolved includePage',
        node: { type: 'includePage', attrs: {} },
      },
      {
        name: 'unresolved excerptInclude',
        node: { type: 'excerptInclude', attrs: {} },
      },
      {
        name: 'contentProperties',
        node: {
          type: 'contentProperties',
          attrs: {
            propertyId: 'release',
            hidden: true,
            rows: [{ key: 'Status', value: 'Ready' }],
            sourceParams: { id: 'release', hidden: 'true' },
            sourceBody: '[{"type":"table"}]',
          },
        },
      },
      {
        name: 'contentPropertiesReport',
        node: {
          type: 'contentPropertiesReport',
          attrs: {
            label: 'release-notes',
            propertyId: 'release',
            titleColumn: 'Document',
            columns: ['Status'],
            limit: 20,
            sourceParams: { labels: 'release-notes' },
          },
        },
      },
      {
        name: 'chart',
        node: {
          type: 'chart',
          attrs: { type: 'bar', title: 'Delivery status', legend: true },
          content: [
            {
              type: 'table',
              content: [
                {
                  type: 'tableRow',
                  content: [
                    {
                      type: 'tableHeader',
                      content: [para('Team')],
                    },
                    {
                      type: 'tableHeader',
                      content: [para('Done')],
                    },
                  ],
                },
                {
                  type: 'tableRow',
                  content: [
                    {
                      type: 'tableCell',
                      content: [para('Platform')],
                    },
                    {
                      type: 'tableCell',
                      content: [para('4')],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      {
        name: 'gallery',
        node: {
          type: 'gallery',
          attrs: {
            title: 'Screenshots',
            sort: 'name',
            include: ['Alpha.png'],
            captions: true,
          },
        },
      },
      {
        name: 'contributors',
        node: { type: 'contributors', attrs: { limit: 5 } },
      },
      {
        name: 'externalMacro',
        node: {
          type: 'externalMacro',
          attrs: {
            name: 'azure-devops-macro-wiki',
            params: { query: 'AB#123' },
          },
          content: [para('fallback body')],
        },
      },
    ];

    it.each(cases)('accepts $name', ({ node }) => {
      expect(() => validateTipTapDoc(doc(node))).not.toThrow();
    });

    it('rejects an unsupported create-space button size', () => {
      expect(() =>
        validateTipTapDoc(
          doc({ type: 'createSpaceButton', attrs: { size: 'huge' } }),
        ),
      ).toThrow();
    });
  });

  describe('content properties validate their bounded structured attrs', () => {
    it.each([
      { type: 'contentProperties', attrs: { rows: [{ key: 'Status' }] } },
      { type: 'contentProperties', attrs: { rows: 'Status=Ready' } },
      {
        type: 'contentPropertiesReport',
        attrs: { label: 'release-notes', limit: 31 },
      },
      {
        type: 'contentPropertiesReport',
        attrs: { sourceParams: { labels: 42 } },
      },
    ])('rejects malformed attrs %#', (node) => {
      expect(() => validateTipTapDoc(doc(node))).toThrow();
    });

    it('accepts the normalized modified sort and rejects unknown sorts', () => {
      expect(() =>
        validateTipTapDoc(
          doc({
            type: 'contentPropertiesReport',
            attrs: { sortBy: 'modified' },
          }),
        ),
      ).not.toThrow();
      expect(() =>
        validateTipTapDoc(
          doc({
            type: 'contentPropertiesReport',
            attrs: { sortBy: 'created' },
          }),
        ),
      ).toThrow();
    });
  });

  describe('imported macro provenance and previews stay bounded', () => {
    it('accepts deterministic heading anchors and local Draw.io previews', () => {
      expect(() =>
        validateTipTapDoc(
          doc(
            {
              type: 'heading',
              attrs: { level: 2, id: 'release-notes-2' },
              content: [{ type: 'text', text: 'Release notes' }],
            },
            {
              type: 'drawioDiagram',
              attrs: {
                xml: '<mxfile><diagram>diagram</diagram></mxfile>',
                preview:
                  '/storage/v1/object/public/wiki-attachments/space/page/diagram.drawio.png',
              },
            },
          ),
        ),
      ).not.toThrow();
    });

    it('rejects unsafe heading anchors and keeps remote Draw.io previews out of storage', () => {
      expect(() =>
        validateTipTapDoc(
          doc({ type: 'heading', attrs: { level: 2, id: 'bad anchor!' } }),
        ),
      ).toThrow();

      // The remote preview is DROPPED rather than rejected: it still never
      // reaches storage, but a decorative attr must not destroy the document it
      // sits in (see `orDrop` in tiptap-sanitizer). The diagram itself survives.
      const validated = validateTipTapDoc(
        doc({
          type: 'drawioDiagram',
          attrs: {
            xml: '<mxfile><diagram>diagram</diagram></mxfile>',
            preview: 'https://example.test/diagram.png',
          },
        }),
      );

      expect(validated.json).not.toContain('example.test');
      expect(validated.json).toContain('<mxfile>');
    });

    it('preserves bounded file-macro provenance', () => {
      const validated = validateTipTapDoc(
        doc({
          type: 'fileAttachment',
          attrs: {
            name: 'Plan.docx',
            sourceMacro: 'viewdoc',
            sourceParams: { filename: 'Plan.docx' },
            sourceBody: 'legacy wrapper',
          },
        }),
      );

      expect(validated.doc.content?.[0].attrs).toMatchObject({
        sourceParams: { filename: 'Plan.docx' },
        sourceBody: 'legacy wrapper',
      });
    });
  });

  describe('callout covers Confluence’s full panel set', () => {
    // The original enum was info|warning|success|danger; Confluence also has note, tip and custom.
    it.each(['info', 'warning', 'success', 'danger', 'note', 'tip', 'custom'])(
      'accepts variant %s',
      (variant) => {
        expect(() =>
          validateTipTapDoc(
            doc({
              type: 'callout',
              attrs: { variant },
              content: [para('body')],
            }),
          ),
        ).not.toThrow();
      },
    );

    it('rejects a variant outside the set rather than storing it', () => {
      expect(() =>
        validateTipTapDoc(
          doc({
            type: 'callout',
            attrs: { variant: 'nope' },
            content: [para('x')],
          }),
        ),
      ).toThrow();
    });

    it('accepts safe custom panel colors and bounded border presentation', () => {
      expect(() =>
        validateTipTapDoc(
          doc({
            type: 'callout',
            attrs: {
              variant: 'custom',
              title: 'ADDITIONAL MACROS',
              backgroundColor: '#f7f8f9',
              borderColor: '#091e4224',
              borderStyle: 'solid',
              borderWidth: 2,
              titleBackgroundColor: '#dfe1e6',
              titleColor: '#172b4d',
            },
            content: [para('body')],
          }),
        ),
      ).not.toThrow();
    });

    it('rejects unsupported custom panel border presentation', () => {
      expect(() =>
        validateTipTapDoc(
          doc({
            type: 'callout',
            attrs: {
              variant: 'custom',
              borderStyle: 'groove',
              borderWidth: 99,
            },
            content: [para('body')],
          }),
        ),
      ).toThrow();
    });
  });

  it('accepts the imported placeholder signal on a user mention', () => {
    expect(() =>
      validateTipTapDoc(
        doc({
          type: 'paragraph',
          content: [
            {
              type: 'userMention',
              attrs: {
                userId: '99999999-8888-4777-8666-555555555555',
                userName: 'Christian Kienzl',
                isPlaceholder: true,
              },
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  describe('indentation and alignment survive as block attrs', () => {
    // ADF models these as MARKS, but they are block properties; carrying them as attrs is both
    // correct for TipTap and avoids inventing marks that apply to inline content.
    it('accepts indent + textAlign on paragraph and heading', () => {
      expect(() =>
        validateTipTapDoc(
          doc(
            {
              type: 'paragraph',
              attrs: { indent: 3, textAlign: 'center' },
              content: [{ type: 'text', text: 'a' }],
            },
            {
              type: 'heading',
              attrs: { level: 2, indent: 1, textAlign: 'right' },
              content: [{ type: 'text', text: 'b' }],
            },
          ),
        ),
      ).not.toThrow();
    });
  });

  describe('text reaches content_text (and therefore search)', () => {
    it('projects a status lozenge', () => {
      const text = tiptapToPlainText(
        doc({
          type: 'paragraph',
          content: [
            { type: 'status', attrs: { text: 'BLOCKED', color: 'red' } },
          ],
        }),
      );

      expect(text).toContain('BLOCKED');
    });

    it('projects chart and gallery titles', () => {
      const text = tiptapToPlainText(
        doc(
          {
            type: 'chart',
            attrs: { title: 'Delivery status' },
            content: [
              {
                type: 'table',
                content: [
                  {
                    type: 'tableRow',
                    content: [
                      {
                        type: 'tableHeader',
                        content: [para('Team')],
                      },
                      {
                        type: 'tableHeader',
                        content: [para('Done')],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          { type: 'gallery', attrs: { title: 'Screenshots' } },
        ),
      );

      expect(text).toContain('Delivery status');
      expect(text).toContain('Screenshots');
      expect(text).toContain('Team');
    });

    it('projects a date lozenge as an ISO date', () => {
      const text = tiptapToPlainText(
        doc({
          type: 'paragraph',
          content: [{ type: 'date', attrs: { timestamp: '1760400000000' } }],
        }),
      );

      expect(text).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('projects a smart-link title', () => {
      const text = tiptapToPlainText(
        doc({
          type: 'paragraph',
          content: [
            {
              type: 'inlineCard',
              attrs: { url: 'https://example.com', title: 'Runbook' },
            },
          ],
        }),
      );

      expect(text).toContain('Runbook');
    });

    it('projects decision text', () => {
      const text = tiptapToPlainText(
        doc({
          type: 'decisionList',
          content: [
            {
              type: 'decisionItem',
              attrs: { state: 'DECIDED' },
              content: [para('Adopt the new provider')],
            },
          ],
        }),
      );

      expect(text).toContain('Adopt the new provider');
    });

    it('projects an inline attachment name', () => {
      const text = tiptapToPlainText(
        doc({
          type: 'paragraph',
          content: [
            {
              type: 'mediaInline',
              attrs: { name: 'budget.xlsx', mime: 'application/vnd.ms-excel' },
            },
          ],
        }),
      );

      expect(text).toContain('budget.xlsx');
    });

    it('projects a caption and an image alt', () => {
      const text = tiptapToPlainText(
        doc(
          {
            type: 'paragraph',
            content: [
              {
                type: 'image',
                attrs: { src: 'https://x/y.png', alt: 'Architecture' },
              },
            ],
          },
          {
            type: 'caption',
            content: [{ type: 'text', text: 'System overview' }],
          },
        ),
      );

      expect(text).toContain('Architecture');
      expect(text).toContain('System overview');
    });

    it('keeps the external macro name so the page is still findable', () => {
      const text = tiptapToPlainText(
        doc({
          type: 'externalMacro',
          attrs: { name: 'azure-devops-macro-wiki' },
          content: [para('body')],
        }),
      );

      expect(text).toContain('azure-devops-macro-wiki');
      expect(text).toContain('body');
    });

    it('projects excerpt source text and stable include titles', () => {
      const text = tiptapToPlainText(
        doc(
          {
            type: 'excerpt',
            attrs: { hidden: true, name: 'summary' },
            content: [para('Reusable summary')],
          },
          {
            type: 'includePage',
            attrs: {
              pageId: '11111111-2222-4333-8444-555555555555',
              title: 'Shared runbook',
            },
          },
        ),
      );

      expect(text).toContain('Reusable summary');
      expect(text).toContain('Shared runbook');
    });

    it('separates adjacent decision items instead of running them together', () => {
      const text = tiptapToPlainText(
        doc({
          type: 'decisionList',
          content: [
            { type: 'decisionItem', content: [para('First')] },
            { type: 'decisionItem', content: [para('Second')] },
          ],
        }),
      );

      expect(text).not.toContain('FirstSecond');
    });

    it('projects searchable native-report parameters', () => {
      const text = tiptapToPlainText(
        doc(
          {
            type: 'pageTreeSearch',
            attrs: { mode: 'searchResults', query: 'release notes' },
          },
          { type: 'userList', attrs: { groups: ['engineering', 'design'] } },
          {
            type: 'userProfile',
            attrs: { userName: 'Ada Lovelace' },
          },
          {
            type: 'profilePicture',
            attrs: { userName: 'Ada Lovelace' },
          },
        ),
      );

      expect(text).toContain('release notes');
      expect(text).toContain('engineering design');
      expect(text).toContain('Ada Lovelace');
    });

    it('projects the imported create-space action name', () => {
      expect(
        tiptapToPlainText(
          doc({
            type: 'createSpaceButton',
            attrs: { sourceName: 'create-space-button', size: 'large' },
          }),
        ),
      ).toContain('create-space-button');
    });

    it('projects content property keys, values, and report scope', () => {
      const text = tiptapToPlainText(
        doc(
          {
            type: 'contentProperties',
            attrs: { rows: [{ key: 'Status', value: 'Ready' }] },
          },
          {
            type: 'contentPropertiesReport',
            attrs: { label: 'release-notes', columns: ['Status'] },
          },
        ),
      );

      expect(text).toContain('Status Ready');
      expect(text).toContain('release-notes Status');
    });
  });
});
