/**
 * CF-B macro-registry unit tests (pure — no jsdom/sanitizer import, which Jest can't transform;
 * the whitelist-diff + sanitizer gate runs via the standalone `cf-b-whitelist-diff` harness).
 */

import type { CirNode, ParsedMacro } from './canonical-ir';
import { renderMacro } from './macros/macro-registry';

const macro = (name: string, over: Partial<ParsedMacro> = {}): ParsedMacro => ({
  name,
  params: {},
  richBody: [],
  plainBody: '',
  ...over,
});

describe('CF-B macro registry', () => {
  it('maps info → panel with variant + title + body', () => {
    const body: CirNode[] = [
      { type: 'paragraph', children: [{ type: 'text', text: 'hi' }] },
    ];
    const node = renderMacro(
      macro('info', { params: { title: 'Heads up' }, richBody: body }),
      {},
    );

    expect(node).toEqual({
      type: 'panel',
      variant: 'info',
      title: 'Heads up',
      children: body,
    });
  });

  it('maps code → codeBlock from the plain-text body', () => {
    const node = renderMacro(
      macro('code', { params: { language: 'ts' }, plainBody: 'const x = 1' }),
      {},
    );

    expect(node).toEqual({
      type: 'codeBlock',
      language: 'ts',
      text: 'const x = 1',
    });
  });

  it('maps status → status chip with normalised colour', () => {
    const node = renderMacro(
      macro('status', { params: { title: 'DONE', colour: 'Green' } }),
      {},
    );

    expect(node).toEqual({ type: 'status', text: 'DONE', color: 'green' });
  });

  it('maps expand → expand container', () => {
    const node = renderMacro(
      macro('expand', { params: { title: 'More' } }),
      {},
    );

    expect(node).toMatchObject({ type: 'expand', title: 'More' });
  });

  it('maps toc → a marker (resolved later)', () => {
    expect(renderMacro(macro('toc'), {})).toEqual({ type: 'tocMarker' });
  });

  it('maps attachments → a marker (resolved later)', () => {
    expect(renderMacro(macro('attachments'), {})).toEqual({
      type: 'attachmentsMacro',
    });
  });

  it('drops anchor (invisible target)', () => {
    expect(renderMacro(macro('anchor'), {})).toBeNull();
  });

  it('maps the named source anchor to a local fragment target', () => {
    expect(
      renderMacro(macro('anchor', { params: { '': 'ANCHOR' } }), {}),
    ).toEqual({
      type: 'anchor',
      name: 'ANCHOR',
    });
  });

  it('excerpt keeps its visible body inside a live source node', () => {
    const body: CirNode[] = [
      { type: 'paragraph', children: [{ type: 'text', text: 'kept' }] },
    ];

    expect(renderMacro(macro('excerpt', { richBody: body }), {})).toEqual({
      type: 'excerpt',
      hidden: false,
      sourceParams: {},
      children: body,
    });
  });

  it('children flags for relink when no child links are injected', () => {
    let flagged = false;
    const node = renderMacro(macro('children'), {
      markNeedsRelink: () => (flagged = true),
    });

    expect(flagged).toBe(true);
    expect(node).toEqual({
      type: 'externalMacro',
      name: 'children',
      params: {},
    });
  });

  it('children renders the native live page tree after the page exists locally', () => {
    const node = renderMacro(macro('children'), {
      currentPageId: 'b6a64cb7-befe-4538-9a31-6b89377ff0c1',
    });

    expect(node).toEqual({
      type: 'liveMacro',
      kind: 'pageTree',
      params: { rootPageId: 'b6a64cb7-befe-4538-9a31-6b89377ff0c1' },
    });
  });

  it.each([
    ['space-attachments', 'spaceAttachments'],
    ['spaces', 'spacesList'],
    ['livesearch', 'liveSearch'],
    ['contributors-summary', 'contributorsSummary'],
  ])('maps %s to its native live Wiki node', (name, kind) => {
    expect(renderMacro(macro(name), {})).toEqual({
      type: 'liveMacro',
      kind,
      params: {},
    });
  });

  it.each([
    ['change-history', 'changeHistory', { limit: '25' }],
    ['pagetreesearch', 'pageTreeSearch', {}],
    ['index', 'pageTreeSearch', {}],
    ['pageindex', 'pageTreeSearch', {}],
    ['search', 'pageTreeSearch', { query: 'release notes' }],
    ['search-results', 'pageTreeSearch', { queryString: 'release notes' }],
    ['space-details', 'spaceDetails', { width: '75%' }],
    ['user-list', 'userList', { groups: 'engineering, design' }],
    ['user-profile', 'userProfile', { user: 'Ada Lovelace' }],
    ['profile-picture', 'profilePicture', { user: 'Ada Lovelace' }],
    ['popular-labels', 'popularLabels', { count: '20', style: 'heatmap' }],
  ])('maps %s to the %s native node', (name, kind, params) => {
    const node = renderMacro(macro(name, { params }), {});

    expect(node).toMatchObject({ type: 'liveMacro', kind });
  });

  it.each([
    ['create-space-button', {}, 'large'],
    ['createspacebutton', { size: 'small' }, 'small'],
  ])(
    'maps bodyless %s to the native permission-aware action',
    (name, params, size) => {
      expect(renderMacro(macro(name, { params }), {})).toEqual({
        type: 'createSpaceButton',
        size,
        sourceName: name,
        sourceParams: params,
      });
    },
  );

  it.each([
    [{ size: 'huge' }, [], ''],
    [{ width: '50px' }, [], ''],
    [{ size: 'small' }, [{ type: 'paragraph', children: [] }], ''],
    [{ size: 'small' }, [], 'unexpected body'],
  ])(
    'keeps unsupported create-space-button payloads as fidelity cards',
    (params, richBody, plainBody) => {
      const rendered = renderMacro(
        macro('create-space-button', { params, richBody, plainBody }),
        {},
      );
      const card = {
        type: 'externalMacro',
        name: 'create-space-button',
        params,
      };

      expect(rendered).toEqual(
        richBody.length
          ? [card, ...richBody]
          : plainBody.trim()
            ? [card, { type: 'codeBlock', text: plainBody }]
            : card,
      );
    },
  );

  it.each([
    ['pagetreesearch', { root: 'Release notes' }],
    ['pagetreesearch', { rootPageId: '1836449793' }],
    ['change-history', { limit: '-1' }],
    ['popular-labels', { style: 'rainbow' }],
    ['space-details', { width: '75%', secret: 'keep-me' }],
  ])(
    'preserves unsafe or unsupported %s parameters on a fidelity card',
    (name, params) => {
      expect(renderMacro(macro(name, { params }), {})).toEqual({
        type: 'externalMacro',
        name,
        params,
      });
    },
  );

  it('keeps the standalone column body in a one-column layout', () => {
    const body: CirNode[] = [
      { type: 'paragraph', children: [{ type: 'text', text: 'column body' }] },
    ];

    expect(renderMacro(macro('column', { richBody: body }), {})).toEqual({
      type: 'layout',
      columns: [body],
    });
  });

  it('keeps a valid classic column width when its sibling uses the default', () => {
    const left: CirNode[] = [
      { type: 'paragraph', children: [{ type: 'text', text: 'left' }] },
    ];
    const right: CirNode[] = [
      { type: 'paragraph', children: [{ type: 'text', text: 'right' }] },
    ];

    expect(
      renderMacro(
        macro('section', {
          richBody: [
            { type: 'layout', columns: [left], widths: [30] },
            { type: 'layout', columns: [right] },
          ],
        }),
        {},
      ),
    ).toEqual({
      type: 'layout',
      columns: [left, right],
      widths: [30, undefined],
    });
  });

  it('keeps safe custom panel presentation parameters', () => {
    const body: CirNode[] = [
      { type: 'paragraph', children: [{ type: 'text', text: 'panel body' }] },
    ];

    expect(
      renderMacro(
        macro('panel', {
          params: {
            title: 'ADDITIONAL MACROS',
            bgColor: '#f7f8f9',
            borderColor: '#091e4224',
            borderStyle: 'solid',
            borderWidth: '2px',
            titleBGColor: '#dfe1e6',
            titleColor: '#172b4d',
          },
          richBody: body,
        }),
        {},
      ),
    ).toEqual({
      type: 'panel',
      variant: 'custom',
      title: 'ADDITIONAL MACROS',
      backgroundColor: '#f7f8f9',
      borderColor: '#091e4224',
      borderStyle: 'solid',
      borderWidth: 2,
      titleBackgroundColor: '#dfe1e6',
      titleColor: '#172b4d',
      children: body,
    });
  });

  it('drops unsafe custom panel CSS values before they reach TipTap', () => {
    expect(
      renderMacro(
        macro('panel', {
          params: {
            bgColor: 'url(javascript:alert(1))',
            borderStyle: 'expression(alert(1))',
            borderWidth: '999px',
          },
        }),
        {},
      ),
    ).toEqual({
      type: 'panel',
      variant: 'custom',
      children: [],
    });
  });

  it('keeps the source note title, variant, and body', () => {
    const body: CirNode[] = [
      { type: 'paragraph', children: [{ type: 'text', text: 'note body' }] },
    ];

    expect(
      renderMacro(
        macro('note', { params: { title: 'Hinweis' }, richBody: body }),
        {},
      ),
    ).toEqual({
      type: 'panel',
      variant: 'note',
      title: 'Hinweis',
      children: body,
    });
  });

  it('keeps excerpt content as a named, optionally-hidden live source block', () => {
    const body: CirNode[] = [
      { type: 'paragraph', children: [{ type: 'text', text: 'shared' }] },
    ];

    expect(
      renderMacro(
        macro('excerpt', {
          params: { hidden: 'true', name: 'summary', future: 'kept' },
          richBody: body,
        }),
        {},
      ),
    ).toEqual({
      type: 'excerpt',
      hidden: true,
      name: 'summary',
      sourceParams: { hidden: 'true', name: 'summary', future: 'kept' },
      children: body,
    });
  });

  it('resolves include page by stable source id into a live node', () => {
    const sourceId = 'source-page-17';
    const target = {
      pageId: 'b6a64cb7-befe-4538-9a31-6b89377ff0c1',
      title: 'ADDITIONAL MACROS',
      url: '/spaces/APMIS1/wiki/page-1',
      targetSpaceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      targetSpaceKey: 'APMIS1',
    };

    expect(
      renderMacro(macro('include', { params: { pageId: sourceId } }), {
        includePages: { [sourceId]: target },
      }),
    ).toEqual({
      type: 'includePage',
      pageId: target.pageId,
      title: target.title,
      targetSpaceId: target.targetSpaceId,
      targetSpaceKey: target.targetSpaceKey,
      sourceParams: { pageId: sourceId },
    });
  });

  it('excerpt include preserves its live target, name, and panel setting', () => {
    const node = renderMacro(
      macro('excerpt-include', {
        params: {
          '': 'APMIS1:ADDITIONAL MACROS',
          excerpt: 'summary',
          nopanel: 'true',
        },
      }),
      {
        currentSourceSpaceKey: 'DEFAULT',
        includePages: {
          ['APMIS1\u0000ADDITIONAL MACROS']: {
            pageId: 'b6a64cb7-befe-4538-9a31-6b89377ff0c1',
            title: 'ADDITIONAL MACROS',
            url: '/spaces/APMIS1/wiki/page-1',
          },
        },
      },
    );

    expect(node).toEqual({
      type: 'excerptInclude',
      pageId: 'b6a64cb7-befe-4538-9a31-6b89377ff0c1',
      title: 'ADDITIONAL MACROS',
      excerptName: 'summary',
      nopanel: true,
      sourceParams: {
        '': 'APMIS1:ADDITIONAL MACROS',
        excerpt: 'summary',
        nopanel: 'true',
      },
    });
  });

  it('unknown macro → externalMacro card that preserves the body + logs lossy', () => {
    const logs: string[] = [];
    const body: CirNode[] = [
      { type: 'paragraph', children: [{ type: 'text', text: 'kept' }] },
    ];
    const out = renderMacro(macro('made-up-macro', { richBody: body }), {
      log: (m) => logs.push(m),
    });

    expect(Array.isArray(out)).toBe(true);
    expect((out as CirNode[])[0]).toMatchObject({
      type: 'externalMacro',
      name: 'made-up-macro',
    });
    expect(JSON.stringify(out)).toContain('kept');
    expect(logs.length).toBeGreaterThan(0);
  });

  describe('macros that were losing a file reference', () => {
    it('multimedia → media/file, so the attachment still resolves', () => {
      // MUST be a `media` node: attachment resolution walks `media` only, so a
      // bespoke node type would never have its filename mapped to a Storage URL.
      const node = renderMacro(
        macro('multimedia', { params: { name: 'demo.mp4' } }),
        {},
      );

      expect(node).toMatchObject({
        type: 'media',
        kind: 'file',
        filename: 'demo.mp4',
      });
    });

    it('chart with table data → native chart node preserving the source params', () => {
      const body: CirNode[] = [
        {
          type: 'table',
          rows: [
            {
              cells: [
                { header: true, children: [{ type: 'text', text: 'Team' }] },
                { header: true, children: [{ type: 'text', text: 'Done' }] },
              ],
            },
          ],
        },
      ];
      const out = renderMacro(
        macro('chart', {
          params: {
            type: 'bar',
            title: 'Delivery status',
            attachment: 'sales.png',
          },
          richBody: body,
        }),
        {},
      );

      expect(out).toMatchObject({
        type: 'chart',
        chartType: 'bar',
        title: 'Delivery status',
        sourceParams: {
          type: 'bar',
          title: 'Delivery status',
          attachment: 'sales.png',
        },
        children: body,
      });
    });

    it('chart with no native table keeps the generated attachment reachable', () => {
      const body: CirNode[] = [
        { type: 'paragraph', children: [{ type: 'text', text: 'Q1 42' }] },
      ];
      const out = renderMacro(
        macro('chart', { params: { attachment: 'sales.png' }, richBody: body }),
        {},
      ) as CirNode[];

      expect(out[0]).toMatchObject({
        type: 'media',
        kind: 'file',
        filename: 'sales.png',
      });
      expect(JSON.stringify(out)).toContain('Q1 42');
    });

    it('chart with no table or generated attachment falls back losslessly', () => {
      const logs: { message: string; meta?: Record<string, unknown> }[] = [];
      const out = renderMacro(
        macro('chart', { params: { type: 'pie' }, richBody: [] }),
        { log: (message, meta) => logs.push({ message, meta }) },
      );

      expect(out).toEqual({
        type: 'externalMacro',
        name: 'chart',
        params: { type: 'pie' },
      });
      expect(logs).toContainEqual({
        message: 'macro rendered as unsupported placeholder',
        meta: {
          macroName: 'chart',
          reason:
            'chart has no native table data or generated attachment to resolve',
        },
      });
    });

    it('html → raw, which becomes the sanitized rawHtml node', () => {
      const node = renderMacro(
        macro('html', { plainBody: '<b>hallo</b>' }),
        {},
      );

      expect(node).toMatchObject({ type: 'raw', html: '<b>hallo</b>' });
    });
  });

  it('maps contentbylabel to a native live macro and retains label/space parameters', () => {
    expect(
      renderMacro(
        macro('contentbylabel', { params: { spaces: 'DEV', labels: 'api' } }),
        {},
      ),
    ).toEqual({
      type: 'liveMacro',
      kind: 'contentByLabel',
      params: { spaces: 'DEV', labels: 'api' },
    });
  });

  it('keeps an unconfigured contentbylabel macro visible instead of querying every page', () => {
    expect(
      renderMacro(macro('contentbylabel', { params: { spaces: 'DEV' } }), {}),
    ).toEqual({
      type: 'externalMacro',
      name: 'contentbylabel',
      params: { spaces: 'DEV' },
    });
  });

  describe('macros found unmapped against the live customer space', () => {
    it.each(['viewdoc', 'viewpdf', 'viewppt', 'viewxls'])(
      'maps legacy %s viewers to a local file attachment',
      (name) => {
        expect(
          renderMacro(macro(name, { params: { name: 'report.pdf' } }), {}),
        ).toEqual({
          type: 'media',
          kind: 'file',
          filename: 'report.pdf',
          sourceMacro: name,
          sourceParams: { name: 'report.pdf' },
          sourceBody: '',
        });
      },
    );

    it('maps drawio AND drawio-sketch to a real diagram node', () => {
      for (const name of ['drawio', 'drawio-sketch', 'gliffy']) {
        expect(
          renderMacro(
            macro(name, { params: { diagramName: 'Architecture.drawio' } }),
            {},
          ),
        ).toEqual({
          type: 'diagram',
          name: 'Architecture.drawio',
          macroName: name,
        });
      }
    });

    it('falls back to diagramDisplayName, which is all drawio-sketch carries', () => {
      const node = renderMacro(
        macro('drawio-sketch', {
          params: { diagramDisplayName: 'Bluhm Systeme Zuordnung' },
        }),
        {},
      ) as { name?: string };

      expect(node.name).toBe('Bluhm Systeme Zuordnung');
    });

    it('keeps an unnamed diagram as a named fidelity card', () => {
      expect(renderMacro(macro('drawio'), {})).toEqual({
        type: 'externalMacro',
        name: 'drawio',
        params: {},
      });
    });

    it.each(['details', 'page-properties'])(
      '%s maps a lossless vertical metadata table',
      (name) => {
        const body: CirNode[] = [
          {
            type: 'table',
            rows: [
              {
                cells: [
                  {
                    header: true,
                    children: [
                      {
                        type: 'paragraph',
                        children: [{ type: 'text', text: 'Status' }],
                      },
                    ],
                  },
                  {
                    header: false,
                    children: [
                      {
                        type: 'paragraph',
                        children: [{ type: 'text', text: 'Ready' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ];

        expect(
          renderMacro(
            macro(name, {
              params: { id: 'release', hidden: 'true' },
              richBody: body,
            }),
            {},
          ),
        ).toEqual({
          type: 'contentProperties',
          propertyId: 'release',
          hidden: true,
          rows: [{ key: 'Status', value: 'Ready' }],
          sourceParams: { id: 'release', hidden: 'true' },
          sourceBody: JSON.stringify(body),
        });
      },
    );

    it('maps a lossless horizontal Page Properties table', () => {
      const body: CirNode[] = [
        {
          type: 'table',
          rows: [
            {
              cells: [
                {
                  header: true,
                  children: [
                    {
                      type: 'paragraph',
                      children: [{ type: 'text', text: 'Owner' }],
                    },
                  ],
                },
                {
                  header: true,
                  children: [
                    {
                      type: 'paragraph',
                      children: [{ type: 'text', text: 'Due' }],
                    },
                  ],
                },
              ],
            },
            {
              cells: [
                {
                  header: false,
                  children: [
                    {
                      type: 'paragraph',
                      children: [{ type: 'text', text: 'Ada' }],
                    },
                  ],
                },
                {
                  header: false,
                  children: [
                    {
                      type: 'paragraph',
                      children: [{ type: 'text', text: 'Friday' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ];

      expect(
        renderMacro(macro('details', { richBody: body }), {}),
      ).toMatchObject({
        type: 'contentProperties',
        rows: [
          { key: 'Owner', value: 'Ada' },
          { key: 'Due', value: 'Friday' },
        ],
      });
    });

    it('maps formatted Page Properties values while preserving the source body', () => {
      const logs: { message: string; meta?: Record<string, unknown> }[] = [];
      const body: CirNode[] = [
        {
          type: 'table',
          rows: [
            {
              cells: [
                {
                  header: true,
                  children: [
                    {
                      type: 'paragraph',
                      children: [
                        { type: 'text', text: 'Status', marks: ['strong'] },
                      ],
                    },
                  ],
                },
                {
                  header: false,
                  children: [
                    {
                      type: 'paragraph',
                      children: [{ type: 'status', text: 'READY' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ];

      expect(
        renderMacro(
          macro('details', { params: { id: 'release' }, richBody: body }),
          { log: (message, meta) => logs.push({ message, meta }) },
        ),
      ).toMatchObject({
        type: 'contentProperties',
        propertyId: 'release',
        rows: [{ key: 'Status', value: 'READY' }],
        sourceBody: JSON.stringify(body),
      });
      expect(logs).toEqual([]);
    });

    it.each(['detailssummary', 'page-properties-report'])(
      '%s maps a label-scoped report without broadening its query',
      (name) => {
        expect(
          renderMacro(
            macro(name, {
              params: {
                cql: 'label = "release-notes"',
                id: 'release',
                headings: 'Status,"Target, date"',
                firstcolumn: 'Document',
                pageSize: '20',
              },
            }),
            {},
          ),
        ).toEqual({
          type: 'contentPropertiesReport',
          label: 'release-notes',
          propertyId: 'release',
          columns: ['Status', 'Target, date'],
          titleColumn: 'Document',
          limit: 20,
          sourceParams: {
            cql: 'label = "release-notes"',
            id: 'release',
            headings: 'Status,"Target, date"',
            firstcolumn: 'Document',
            pageSize: '20',
          },
        });
      },
    );

    it.each([
      [{}, 'content properties report has no single valid label'],
      [
        { labels: 'one,two' },
        'content properties report has no single valid label',
      ],
      [
        { labels: 'one', sortBy: 'Status' },
        'content properties report parameters are invalid',
      ],
      [
        { cql: 'label = "one" AND space = "ENG"' },
        'content properties report has no single valid label',
      ],
      [
        { labels: 'one', pageSize: '31' },
        'content properties report parameters are invalid',
      ],
    ])('keeps an unsafe report query as a fidelity card', (params, reason) => {
      const logs: { message: string; meta?: Record<string, unknown> }[] = [];

      expect(
        renderMacro(macro('detailssummary', { params }), {
          log: (message, meta) => logs.push({ message, meta }),
        }),
      ).toEqual({ type: 'externalMacro', name: 'detailssummary', params });
      expect(logs).toContainEqual({
        message: 'macro rendered as unsupported placeholder',
        meta: { macroName: 'detailssummary', reason },
      });
    });

    it('reproduces live macros as live nodes carrying their params', () => {
      expect(
        renderMacro(macro('pagetree', { params: { depth: '3' } }), {}),
      ).toEqual({
        type: 'liveMacro',
        kind: 'pageTree',
        params: { depth: '3' },
      });
      expect(renderMacro(macro('recently-updated'), {})).toMatchObject({
        kind: 'recentlyUpdated',
      });
      expect(renderMacro(macro('contributors'), {})).toMatchObject({
        kind: 'contributors',
      });
      expect(renderMacro(macro('tasks-report-macro'), {})).toMatchObject({
        kind: 'taskReport',
      });
    });

    it.each([
      ['recently-used-labels', 'recentlyUsedLabels'],
      ['related-labels', 'relatedLabels'],
      ['content-by-user', 'contentByUser'],
      ['recently-updated-dashboard', 'recentlyUpdatedDashboard'],
      ['content-report-table', 'contentReportTable'],
      ['decision-report', 'decisionReport'],
      ['navmap', 'navigationMap'],
    ])(
      'maps %s to the native report node with exact provenance',
      (name, kind) => {
        expect(
          renderMacro(
            macro(name, {
              params: { labels: 'security', maxResults: '20' },
            }),
            {},
          ),
        ).toEqual({
          type: 'liveMacro',
          kind,
          params: { labels: 'security', maxResults: '20' },
          sourceName: name,
          sourceParams: { labels: 'security', maxResults: '20' },
          sourceBody: '',
        });
      },
    );

    it('preserves a vendor app macro’s parameters verbatim on an external card', () => {
      for (const name of [
        'project-linker',
        'azure-devops-macro-wiki',
        'appsplus-microsoft-onedrive-macro',
      ]) {
        expect(renderMacro(macro(name, { params: { a: '1' } }), {})).toEqual({
          type: 'externalMacro',
          name,
          params: { a: '1' },
        });
      }
    });

    it('leaves `children` on the relink path — a live tree would lose the real page links', () => {
      const node = renderMacro(macro('children'), {
        childPages: undefined,
      });

      // Not a liveMacro: `childrenHandler` resolves actual migrated page URLs in the relink pass.
      expect(node).toEqual({
        type: 'externalMacro',
        name: 'children',
        params: {},
      });
    });
  });

  describe('lossless compatibility cards', () => {
    it.each([
      ['roadmap', 'dynamic output has no native XI node'],
      ['widget', 'iframe/widget provider or body is not supported safely'],
    ])(
      '%s preserves its exact params and text body instead of an italic placeholder',
      (name, reason) => {
        const logs: { message: string; meta?: Record<string, unknown> }[] = [];
        const out = renderMacro(
          macro(name, {
            params: { space: 'ENG', mode: 'compact' },
            plainBody: 'source configuration',
          }),
          { log: (message, meta) => logs.push({ message, meta }) },
        ) as CirNode[];

        expect(out[0]).toEqual({
          type: 'externalMacro',
          name,
          params: { space: 'ENG', mode: 'compact' },
        });
        expect(out[1]).toEqual({
          type: 'codeBlock',
          text: 'source configuration',
        });
        expect(logs).toContainEqual({
          message: 'macro rendered as unsupported placeholder',
          meta: {
            macroName: name,
            reason,
          },
        });
      },
    );

    it('gallery maps to the native attachment gallery when it stays on the current page', () => {
      expect(
        renderMacro(
          macro('gallery', {
            params: {
              title: 'Screenshots',
              include: 'Alpha.png, Beta.png',
              sort: 'name',
              reverse: 'true',
              columns: '3',
            },
          }),
          {},
        ),
      ).toEqual({
        type: 'gallery',
        title: 'Screenshots',
        include: ['Alpha.png', 'Beta.png'],
        sort: 'name',
        reverse: true,
        columns: 3,
        sourceParams: {
          title: 'Screenshots',
          include: 'Alpha.png, Beta.png',
          sort: 'name',
          reverse: 'true',
          columns: '3',
        },
      });
    });

    it('gallery targeting another source page stays a fidelity card', () => {
      const logs: { message: string; meta?: Record<string, unknown> }[] = [];

      expect(
        renderMacro(
          macro('gallery', { params: { page: 'Design assets', columns: '3' } }),
          { log: (message, meta) => logs.push({ message, meta }) },
        ),
      ).toEqual({
        type: 'externalMacro',
        name: 'gallery',
        params: { page: 'Design assets', columns: '3' },
      });

      expect(logs).toContainEqual({
        message: 'macro rendered as unsupported placeholder',
        meta: {
          macroName: 'gallery',
          reason: 'gallery targets a non-local attachment source page',
        },
      });
    });

    it('keeps a Jira filter as an external card rather than reducing it to text', () => {
      const logs: { message: string; meta?: Record<string, unknown> }[] = [];
      const body: CirNode[] = [
        {
          type: 'paragraph',
          children: [{ type: 'text', text: 'Saved filter' }],
        },
      ];
      const out = renderMacro(
        macro('jira', {
          params: {
            jqlQuery: 'project = XI ORDER BY updated DESC',
            columns: 'key,summary',
          },
          richBody: body,
        }),
        { log: (message, meta) => logs.push({ message, meta }) },
      ) as CirNode[];

      expect(out[0]).toEqual({
        type: 'externalMacro',
        name: 'jira',
        params: {
          jqlQuery: 'project = XI ORDER BY updated DESC',
          columns: 'key,summary',
        },
      });
      expect(out.slice(1)).toEqual(body);
      expect(logs).toContainEqual({
        message: 'macro rendered as unsupported placeholder',
        meta: {
          macroName: 'jira',
          reason: 'Jira filter/query cannot be safely remapped',
        },
      });
    });

    it.each(['jira', 'jiraissues', 'jira-issues', 'jira-work-items'])(
      '%s keeps a single issue key as a resolvable CIR reference',
      (name) => {
        let needsRelink = false;

        expect(
          renderMacro(
            macro(name, { params: { key: 'XI-42', columns: 'key,summary' } }),
            {
              sourceBaseUrl: 'https://jira.example.test/',
              markNeedsRelink: () => (needsRelink = true),
            },
          ),
        ).toEqual({
          type: 'jiraIssue',
          key: 'XI-42',
          macroName: name,
          params: { key: 'XI-42', columns: 'key,summary' },
          sourceUrl: 'https://jira.example.test/browse/XI-42',
          children: [],
        });
        expect(needsRelink).toBe(true);
      },
    );

    it.each([
      'jira-chart',
      'jirachart',
      'jira-timeline',
      'advanced-roadmaps',
      'portfolio-for-jira-plan',
      'roadmap',
      'roadmap-planner',
      'assets',
      'assets-data',
    ])(
      '%s preserves exact configuration for explicit editor remapping',
      (name) => {
        expect(
          renderMacro(
            macro(name, {
              params: { sourceId: 'legacy-7', query: 'project = XI' },
              plainBody: 'source body',
            }),
            {},
          ),
        ).toEqual([
          {
            type: 'externalMacro',
            name,
            params: { sourceId: 'legacy-7', query: 'project = XI' },
          },
          { type: 'codeBlock', text: 'source body' },
        ]);
      },
    );

    it('does not query an invalid Jira key or emit an unsafe source URL', () => {
      expect(
        renderMacro(macro('jira', { params: { key: '../admin' } }), {
          sourceBaseUrl: 'javascript:alert(1)',
        }),
      ).toEqual({
        type: 'externalMacro',
        name: 'jira',
        params: { key: '../admin' },
      });
    });

    it('logs an unresolved profile macro through its supplied context', () => {
      const logs: { message: string; meta?: Record<string, unknown> }[] = [];

      expect(
        renderMacro(
          macro('profile', { params: { display: 'Former employee' } }),
          { log: (message, meta) => logs.push({ message, meta }) },
        ),
      ).toEqual({
        type: 'externalMacro',
        name: 'profile',
        params: { display: 'Former employee' },
      });
      expect(logs).toContainEqual({
        message: 'macro rendered as unsupported placeholder',
        meta: {
          macroName: 'profile',
          reason:
            'native userProfile mapping cannot preserve the complete source payload',
        },
      });
    });

    it('keeps a legacy Jira issues filter as an external card', () => {
      const out = renderMacro(
        macro('jiraissues', {
          params: {
            url: 'https://jira.example.test/sr/jira.issueviews:searchrequest-1/temp/SearchRequest.html',
          },
        }),
        {},
      );

      expect(out).toEqual({
        type: 'externalMacro',
        name: 'jiraissues',
        params: {
          url: 'https://jira.example.test/sr/jira.issueviews:searchrequest-1/temp/SearchRequest.html',
        },
      });
    });

    it('preserves vendor macro bodies as well as their parameters', () => {
      const body: CirNode[] = [
        {
          type: 'paragraph',
          children: [{ type: 'text', text: 'Vendor body' }],
        },
      ];
      const out = renderMacro(
        macro('project-linker', { params: { project: 'XI' }, richBody: body }),
        {},
      ) as CirNode[];

      expect(out).toEqual([
        {
          type: 'externalMacro',
          name: 'project-linker',
          params: { project: 'XI' },
        },
        ...body,
      ]);
    });

    it('keeps an unnamed diagram macro as a fidelity card with its source parameters', () => {
      const out = renderMacro(
        macro('drawio', {
          params: { revision: '7' },
          plainBody: 'diagram source',
        }),
        {},
      ) as CirNode[];

      expect(out).toEqual([
        { type: 'externalMacro', name: 'drawio', params: { revision: '7' } },
        { type: 'codeBlock', text: 'diagram source' },
      ]);
    });
  });
});
