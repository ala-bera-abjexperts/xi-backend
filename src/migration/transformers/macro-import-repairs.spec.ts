jest.mock('../../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) =>
    value == null ? null : String(value),
}));

import {
  collectRefs,
  type CirDoc,
  type CirNode,
  type ParsedMacro,
} from './canonical-ir';
import { cirToTipTap, type TipTapNode } from './cir-to-tiptap';
import { ContentTransformService } from './content-transform.service';
import { renderMacro } from './macros/macro-registry';
import { validateTipTapDoc } from '../../common/utils/tiptap-sanitizer';

const macro = (name: string, params: Record<string, string>): ParsedMacro => ({
  name,
  params,
  richBody: [],
  plainBody: '',
});

const resolved = (attachments = new Map<string, string>()) => ({
  users: new Map(),
  pages: new Map(),
  attachments,
  jiraIssues: new Map(),
  nativeTables: true,
});

const findAll = (node: TipTapNode, type: string): TipTapNode[] => [
  ...(node.type === type ? [node] : []),
  ...(node.content ?? []).flatMap((child) => findAll(child, type)),
];

const expectValid = (node: TipTapNode) =>
  expect(() => validateTipTapDoc(JSON.stringify(node))).not.toThrow();

const nativeNode = (value: ReturnType<typeof renderMacro>): CirNode => {
  if (!value || Array.isArray(value)) throw new Error('expected native node');

  return value;
};

describe('MACROLAB legacy macro repairs', () => {
  it.each([
    ['labels-list', 'labelsList'],
    ['listlabels', 'labelsList'],
    ['userlister', 'userList'],
    ['taskreport', 'taskReport'],
  ])('maps %s to the existing native %s node', (name, kind) => {
    expect(renderMacro(macro(name, {}), {})).toMatchObject({
      type: 'liveMacro',
      kind,
      sourceName: name,
      sourceParams: {},
    });
  });

  it('serializes repaired aliases with their original provenance', () => {
    const out = cirToTipTap(
      {
        type: 'doc',
        children: [
          nativeNode(
            renderMacro(
              macro('labels-list', {
                style: 'table',
                excludedLabels: 'internal',
              }),
              {},
            ),
          ),
          nativeNode(
            renderMacro(macro('userlister', { groups: 'engineering' }), {}),
          ),
          nativeNode(
            renderMacro(macro('taskreport', { maxResults: '12' }), {}),
          ),
        ],
      },
      resolved(),
    );

    expect(findAll(out, 'labelsList')[0]?.attrs).toMatchObject({
      excludedLabels: ['internal'],
      sourceName: 'labels-list',
      sourceParams: { style: 'table', excludedLabels: 'internal' },
    });
    expect(findAll(out, 'userList')[0]?.attrs).toMatchObject({
      groups: ['engineering'],
      sourceName: 'userlister',
      sourceParams: { groups: 'engineering' },
    });
    expect(findAll(out, 'taskReport')[0]?.attrs).toMatchObject({
      limit: 12,
      sourceName: 'taskreport',
      sourceParams: { maxResults: '12' },
    });
    expectValid(out);
  });

  it('normalizes legacy report parameters without losing source provenance', () => {
    expect(renderMacro(macro('change-history', { max: '25' }), {})).toEqual({
      type: 'liveMacro',
      kind: 'changeHistory',
      params: { limit: '25' },
      sourceName: 'change-history',
      sourceParams: { max: '25' },
      sourceBody: '',
    });
    expect(
      renderMacro(macro('space-details', { id: 'spacedetails' }), {}),
    ).toMatchObject({
      type: 'liveMacro',
      kind: 'spaceDetails',
      params: {},
      sourceParams: { id: 'spacedetails' },
    });
    expect(
      renderMacro(macro('popular-labels', { style: 'table' }), {}),
    ).toMatchObject({
      type: 'liveMacro',
      kind: 'popularLabels',
      params: { style: 'list' },
      sourceParams: { style: 'table' },
    });
  });

  it.each([
    ['change-history', { limit: '10', max: '25' }],
    ['change-history', { max: '0' }],
    ['space-details', { id: `bad\u0000id` }],
    ['popular-labels', { style: 'rainbow' }],
  ])('keeps malformed %s parameters on a fidelity card', (name, params) => {
    expect(renderMacro(macro(name, params), {})).toEqual({
      type: 'externalMacro',
      name,
      params,
    });
  });

  it('accepts the source details layouts and normalizes Modified sorting', () => {
    const table = {
      type: 'table' as const,
      rows: [
        {
          cells: [
            {
              header: true,
              children: [{ type: 'text' as const, text: 'Status' }],
            },
            {
              header: false,
              children: [{ type: 'text' as const, text: 'Ready' }],
            },
          ],
        },
      ],
    };

    expect(
      renderMacro(
        {
          ...macro('details', { layout: 'table' }),
          richBody: [table],
        },
        {},
      ),
    ).toMatchObject({
      type: 'contentProperties',
      rows: [{ key: 'Status', value: 'Ready' }],
      sourceParams: { layout: 'table' },
    });

    const report = renderMacro(
      macro('detailssummary', {
        label: 'release-notes',
        sortBy: 'Modified',
        headings: 'Status,"Target ""date"""',
      }),
      {},
    );

    expect(report).toMatchObject({
      type: 'contentPropertiesReport',
      label: 'release-notes',
      sortBy: 'modified',
      columns: ['Status', 'Target "date"'],
      sourceParams: {
        label: 'release-notes',
        sortBy: 'Modified',
        headings: 'Status,"Target ""date"""',
      },
    });
    if (!report || Array.isArray(report))
      throw new Error('expected report node');

    const serialized = cirToTipTap(
      { type: 'doc', children: [report] },
      resolved(),
    );

    expect(
      findAll(serialized, 'contentPropertiesReport')[0]?.attrs?.sortBy,
    ).toBe('modified');
    expectValid(serialized);
  });

  it('preserves a bodied properties report instead of broadening it', () => {
    const rendered = renderMacro(
      {
        ...macro('detailssummary', { label: 'release-notes' }),
        richBody: [
          {
            type: 'paragraph',
            children: [{ type: 'text', text: 'Source-only body' }],
          },
        ],
      },
      {},
    );

    expect(Array.isArray(rendered) ? rendered[0] : rendered).toMatchObject({
      type: 'externalMacro',
      name: 'detailssummary',
      params: { label: 'release-notes' },
    });
  });

  it('maps semantic values in the MACROLAB Page Properties table', () => {
    const richBody: CirDoc['children'] = [
      {
        type: 'table',
        rows: [
          {
            cells: [
              {
                header: true,
                children: [{ type: 'text', text: 'Owner', marks: ['strong'] }],
              },
              {
                header: false,
                children: [
                  {
                    type: 'paragraph',
                    children: [
                      { type: 'userMention', sourceId: 'source-user' },
                    ],
                  },
                ],
              },
            ],
          },
          {
            cells: [
              { header: true, children: [{ type: 'text', text: 'Status' }] },
              {
                header: false,
                children: [{ type: 'status', text: 'Active', color: 'green' }],
              },
            ],
          },
          {
            cells: [
              { header: true, children: [{ type: 'text', text: 'Due date' }] },
              {
                header: false,
                children: [{ type: 'date', timestamp: '1780185600000' }],
              },
            ],
          },
        ],
      },
    ];

    expect(
      renderMacro(
        {
          ...macro('details', { layout: 'table', id: 'propsdemo' }),
          richBody,
        },
        {},
      ),
    ).toMatchObject({
      type: 'contentProperties',
      rows: [
        { key: 'Owner', value: 'User' },
        { key: 'Status', value: 'Active' },
        { key: 'Due date', value: '2026-05-31' },
      ],
      sourceBody: JSON.stringify(richBody),
    });
  });

  it('flattens linked Page Properties values and hard breaks', () => {
    const richBody: CirDoc['children'] = [
      {
        type: 'table',
        rows: [
          {
            cells: [
              { header: true, children: [{ type: 'text', text: 'Reference' }] },
              {
                header: false,
                children: [
                  {
                    type: 'paragraph',
                    children: [
                      {
                        type: 'link',
                        href: '#source',
                        children: [
                          {
                            type: 'pageLink',
                            pageSourceId: 'source-page',
                            text: 'Source page',
                          },
                        ],
                      },
                      { type: 'text', text: ' · ' },
                      {
                        type: 'inlineCard',
                        url: 'https://example.test/runbook',
                        title: 'Runbook',
                      },
                      { type: 'hardBreak' },
                      { type: 'text', text: 'Phase 2' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(
      renderMacro({ ...macro('details', { layout: 'table' }), richBody }, {}),
    ).toMatchObject({
      type: 'contentProperties',
      rows: [{ key: 'Reference', value: 'Source page · Runbook\nPhase 2' }],
      sourceBody: JSON.stringify(richBody),
    });
  });

  it.each([
    { params: { layout: 'table' }, plainBody: 'unexpected', richBody: [] },
    { params: { layout: 'grid' }, plainBody: '', richBody: [] },
    { params: {}, plainBody: '', richBody: [] },
    {
      params: {},
      plainBody: '',
      richBody: [{ type: 'table' as const, rows: [] }],
    },
    {
      params: {},
      plainBody: '',
      richBody: [
        {
          type: 'table' as const,
          rows: [
            {
              cells: [
                {
                  header: true,
                  colspan: 2,
                  children: [{ type: 'text' as const, text: 'Key' }],
                },
                {
                  header: false,
                  children: [{ type: 'text' as const, text: 'Value' }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      params: {},
      plainBody: '',
      richBody: [
        {
          type: 'table' as const,
          rows: [
            {
              cells: [
                {
                  header: true,
                  children: [{ type: 'text' as const, text: 'Key' }],
                },
                {
                  header: false,
                  children: [{ type: 'panel' as const, children: [] }],
                },
              ],
            },
          ],
        },
      ],
    },
  ])('fails closed for malformed Page Properties payload %#', (payload) => {
    const rendered = renderMacro(
      {
        ...macro('details', payload.params),
        plainBody: payload.plainBody,
        richBody: payload.richBody,
      },
      {},
    );

    expect(Array.isArray(rendered) ? rendered[0] : rendered).toMatchObject({
      type: 'externalMacro',
      name: 'details',
    });
  });

  it('keeps an unconfigured profile on the native empty-state path', () => {
    expect(renderMacro(macro('profile', {}), {})).toMatchObject({
      type: 'liveMacro',
      kind: 'userProfile',
      params: {},
      sourceName: 'profile',
      sourceParams: {},
    });
  });

  it('maps a configured profile without inventing a local identity', () => {
    expect(
      renderMacro(macro('profile', { userkey: 'legacy-user-key' }), {}),
    ).toMatchObject({
      type: 'liveMacro',
      kind: 'userProfile',
      params: { userKey: 'legacy-user-key' },
      sourceName: 'profile',
      sourceParams: { userkey: 'legacy-user-key' },
    });
  });

  it('keeps legacy user macros exact when identity is missing or configured', () => {
    expect(renderMacro(macro('user', {}), {})).toMatchObject({
      type: 'externalMacro',
      name: 'user',
      params: {},
    });
    expect(
      renderMacro(macro('user', { account_id: 'legacy-account' }), {}),
    ).toEqual({
      type: 'userMention',
      sourceId: 'legacy-account',
    });
  });

  it.each(['include', 'excerpt-include'])(
    'preserves unresolved %s and requests the guarded relink pass',
    (name) => {
      let needsRelink = false;
      const params = { '': 'Missing page' };

      expect(
        renderMacro(macro(name, params), {
          markNeedsRelink: () => {
            needsRelink = true;
          },
        }),
      ).toEqual({ type: 'externalMacro', name, params });
      expect(needsRelink).toBe(true);
    },
  );

  it('preserves loose section content and does not invent empty columns', () => {
    const loose: CirNode = {
      type: 'paragraph',
      children: [{ type: 'text', text: 'Loose' }],
    };

    expect(
      renderMacro({ ...macro('section', {}), richBody: [loose] }, {}),
    ).toEqual([loose]);
    expect(
      renderMacro(
        {
          ...macro('section', {}),
          richBody: [
            loose,
            {
              type: 'layout',
              columns: [[{ type: 'paragraph', children: [] }]],
            },
          ],
        },
        {},
      ),
    ).toMatchObject({
      type: 'layout',
      columns: [[loose], [{ type: 'paragraph', children: [] }]],
    });
  });

  it('repairs navigation and related-label aliases at the target attr boundary', () => {
    const out = cirToTipTap(
      {
        type: 'doc',
        children: [
          {
            type: 'liveMacro',
            kind: 'navigationMap',
            params: {
              labels: 'macro-test',
              mapTitle: 'Macro index',
              cellWidth: '140',
            },
          },
          {
            type: 'liveMacro',
            kind: 'relatedLabels',
            params: { label: 'one, two' },
          },
        ],
      },
      resolved(),
    );

    expect(findAll(out, 'navigationMap')[0]?.attrs).toMatchObject({
      label: 'macro-test',
      title: 'Macro index',
      cellWidth: '140px',
    });
    expect(findAll(out, 'relatedLabels')[0]?.attrs?.labels).toEqual([
      'one',
      'two',
    ]);
    expectValid(out);
  });

  it('drops unsafe navigation dimensions instead of exposing CSS text', () => {
    const out = cirToTipTap(
      {
        type: 'doc',
        children: [
          {
            type: 'liveMacro',
            kind: 'navigationMap',
            params: { label: 'macro-test', cellWidth: 'url(javascript:1)' },
          },
        ],
      },
      resolved(),
    );

    expect(findAll(out, 'navigationMap')[0]?.attrs?.cellWidth).toBeUndefined();
  });

  it.each([
    [
      'viewdoc',
      'AttachmentResourceIdentifier[attachment=17,filename=Spec.docx]',
    ],
    [
      'viewppt',
      'AttachmentResourceIdentifier[attachment=18,filename=Deck.pptx]',
    ],
    [
      'viewxls',
      'AttachmentResourceIdentifier[attachment=19,filename=Model.xlsx]',
    ],
  ])('unwraps the %s attachment resource identifier', (name, filename) => {
    expect(renderMacro(macro(name, { filename }), {})).toMatchObject({
      type: 'media',
      kind: 'file',
      filename: filename.match(/filename=([^\]]+)/)?.[1],
      sourceMacro: name,
      sourceParams: { filename },
    });
  });

  it('accepts the unnamed multimedia attachment parameter', () => {
    expect(
      renderMacro(macro('multimedia', { '': 'demo.mp4' }), {}),
    ).toMatchObject({
      type: 'media',
      kind: 'file',
      filename: 'demo.mp4',
      sourceMacro: 'multimedia',
      sourceParams: { '': 'demo.mp4' },
    });
  });

  it('keeps viewer provenance after attachment crosswalk resolution', () => {
    const source = nativeNode(
      renderMacro(
        macro('viewdoc', {
          filename:
            'AttachmentResourceIdentifier[attachment=17,filename=Spec.docx]',
        }),
        {},
      ),
    );
    const out = cirToTipTap(
      { type: 'doc', children: [source] },
      resolved(
        new Map([
          [
            'Spec.docx',
            '/storage/v1/object/public/wiki-attachments/page/Spec.docx',
          ],
        ]),
      ),
    );

    expect(findAll(out, 'fileAttachment')[0]?.attrs).toMatchObject({
      name: 'Spec.docx',
      sourceMacro: 'viewdoc',
      sourceParams: {
        filename:
          'AttachmentResourceIdentifier[attachment=17,filename=Spec.docx]',
      },
      sourceBody: '',
      localAttachment: true,
    });
    expectValid(out);
  });

  it.each([
    ['viewdoc', { filename: 'AttachmentResourceIdentifier[attachment=17]' }],
    ['multimedia', { url: 'javascript:alert(1)' }],
  ])(
    'keeps malformed %s file references on a fidelity card',
    (name, params) => {
      expect(renderMacro(macro(name, params), {})).toEqual({
        type: 'externalMacro',
        name,
        params,
      });
    },
  );

  it('collects and serializes a migrated draw.io PNG preview', () => {
    const doc: CirDoc = {
      type: 'doc',
      children: [
        {
          type: 'diagram',
          name: 'Architecture.drawio',
          xml: '<mxfile><diagram>x</diagram></mxfile>',
        },
      ],
    };

    expect([...collectRefs(doc).attachmentFilenames]).toEqual([
      'Architecture.drawio.png',
    ]);
    const serialized = cirToTipTap(
      doc,
      resolved(
        new Map([
          [
            'Architecture.drawio.png',
            '/storage/v1/object/public/wiki-attachments/page/Architecture.drawio.png',
          ],
        ]),
      ),
    );

    expect(findAll(serialized, 'drawioDiagram')[0]?.attrs).toMatchObject({
      preview:
        '/storage/v1/object/public/wiki-attachments/page/Architecture.drawio.png',
    });
    expectValid(serialized);
  });

  it('keeps editable Draw.io XML when no preview attachment was mapped', () => {
    const serialized = cirToTipTap(
      {
        type: 'doc',
        children: [
          {
            type: 'diagram',
            name: 'Source-only.drawio',
            xml: '<mxfile><diagram>x</diagram></mxfile>',
          },
        ],
      },
      resolved(),
    );
    const attrs = findAll(serialized, 'drawioDiagram')[0]?.attrs;

    expect(attrs).toMatchObject({
      xml: '<mxfile><diagram>x</diagram></mxfile>',
      caption: 'Source-only.drawio',
    });
    expect(attrs?.preview).toBeUndefined();
    expectValid(serialized);
  });

  it('never broadens an untranslatable Jira query', () => {
    const params = { jqlQuery: 'project = XI ORDER BY updated DESC' };

    expect(renderMacro(macro('jiraissues', params), {})).toEqual({
      type: 'externalMacro',
      name: 'jiraissues',
      params,
    });
  });

  it('preserves source content when a bodyless handler cannot build a node', () => {
    const body: CirNode = {
      type: 'paragraph',
      children: [{ type: 'text', text: 'Unexpected anchor body' }],
    };

    expect(
      renderMacro({ ...macro('anchor', {}), richBody: [body] }, {}),
    ).toEqual([{ type: 'externalMacro', name: 'anchor', params: {} }, body]);
  });
});

describe('Confluence TOC repair', () => {
  it('preserves a live outline and deterministic duplicate-safe heading ids', async () => {
    const service = new ContentTransformService({} as never);
    const result = await service.renderBodyAsTipTap(
      {
        format: 'storage',
        value:
          '<ac:structured-macro ac:name="toc"/>' +
          '<h2>Alpha</h2><h3>Child</h3><h2>Alpha</h2><h4>Über &amp; Maß</h4>',
      },
      { orgId: 'org-1', connectionId: 'connection-1' },
    );
    const out = JSON.parse(result.content) as TipTapNode;
    const headings = findAll(out, 'heading');
    const links = findAll(out, 'text').filter((node) =>
      node.marks?.some((mark) => mark.type === 'link'),
    );

    expect(headings.map((heading) => heading.attrs?.id)).toEqual([
      'alpha',
      'child',
      'alpha-2',
      'über-maß',
    ]);
    expect(links).toHaveLength(0);
    expect(findAll(out, 'confluenceToc')).toHaveLength(1);
    expectValid(out);
  });
});
