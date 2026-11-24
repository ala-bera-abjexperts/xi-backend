import { confluenceSourcePageUrl, PageMapper } from '../mappers/page.mapper';
import { ContentTransformService } from './content-transform.service';
import { renderMacro } from './macros/macro-registry';
import { validateTipTapDoc } from '../../common/utils/tiptap-sanitizer';

describe('external feed macro fidelity', () => {
  const service = new ContentTransformService({} as never);
  const sourcePageUrl =
    'https://wiki.example.test/confluence/pages/viewpage.action?pageId=42';
  const ctx = {
    orgId: 'org',
    connectionId: 'connection',
    sourceBaseUrl: 'https://wiki.example.test/confluence',
    sourcePageUrl,
  };

  it.each(['ac:structured-macro', 'ac:macro'])(
    'renders %s feed references and native TOC without losing source data',
    async (tag) => {
      const body = {
        format: 'storage' as const,
        value: `<h1>Outline</h1><${tag} ac:name="table-of-contents"/><${tag} ac:name="blog-posts"><ac:parameter ac:name="labels">news</ac:parameter><ac:rich-text-body><p>Blog body</p></ac:rich-text-body></${tag}><${tag} ac:name="rss"><ac:parameter ac:name="url">http://feeds.example.test/news.xml</ac:parameter><ac:parameter ac:name="max">7</ac:parameter></${tag}>`,
      };
      const rendered = await service.renderBodyAsTipTap(body, ctx);
      const content = validateTipTapDoc(rendered.content).json;
      expect(rendered.needsRelink).toBe(false);
      expect(() => validateTipTapDoc(content)).not.toThrow();
      expect(content).toContain('"type":"confluenceToc"');
      expect(content).not.toContain('table-of-contents (external macro)');
      expect(content).toContain('"type":"blogPosts"');
      expect(content).toContain('"sourceName":"blog-posts"');
      expect(content).toContain('"type":"rssFeed"');
      expect(content).toContain('Blog body');
      expect(content).toContain('"labels":"news"');
      expect(content).toContain('"max":"7"');
    },
  );

  it.each(['https://status.atlassian.com/history.rss', 'javascript:alert(1)'])(
    'preserves nested RSS URL reference %s',
    async (url) => {
      const { content } = await service.renderBodyAsTipTap(
        {
          format: 'storage',
          value: `<ac:structured-macro ac:name="rss"><ac:parameter ac:name="url"><ri:url ri:value="${url}"/></ac:parameter></ac:structured-macro>`,
        },
        ctx,
      );
      const canonical = validateTipTapDoc(content).json;
      expect(canonical).toContain(`"url":"${url}"`);
      if (url.startsWith('https:'))
        expect(canonical).toContain(`"url":"${url}"`);
      else expect(canonical).not.toContain('"type":"link"');
    },
  );

  it('renders ADF feed macros and logs their external dependency', async () => {
    const log = jest.fn();
    const body = {
      format: 'adf' as const,
      value: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'Outline' }],
          },
          { type: 'extension', attrs: { extensionKey: 'table-of-contents' } },
          {
            type: 'bodiedExtension',
            attrs: {
              extensionKey: 'blog-posts',
              parameters: { macroParams: { labels: { value: 'news' } } },
            },
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'ADF blog body' }],
              },
            ],
          },
          {
            type: 'extension',
            attrs: {
              extensionKey: 'rss',
              parameters: {
                macroParams: {
                  url: { value: 'https://feeds.example.test/rss' },
                  custom: { value: 'preserved' },
                },
              },
            },
          },
        ],
      },
    };
    const { content } = await service.renderBodyAsTipTap(body, { ...ctx, log });
    expect(() => validateTipTapDoc(content)).not.toThrow();
    expect(content).toContain('"type":"rssFeed"');
    expect(content).toContain('"type":"blogPosts"');
    expect(content).toContain('"type":"confluenceToc"');
    expect(content).toContain('ADF blog body');
    expect(content).toContain('"custom":"preserved"');
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        macroName: 'rss',
        reason: expect.stringContaining('Unsupported parameters'),
      }),
    );
  });

  it('retains references, parameters and bodies through the real HTML sanitizer', async () => {
    const { html } = await service.renderBody(
      {
        format: 'storage',
        value:
          '<ac:macro ac:name="rss"><ac:parameter ac:name="url">https://feeds.test/rss</ac:parameter><ac:parameter ac:name="custom">keep &amp; preserve</ac:parameter><ac:rich-text-body><p>Body <strong>retained</strong></p></ac:rich-text-body></ac:macro>',
      },
      ctx,
    );
    expect(html).toContain('href="https://feeds.test/rss"');
    expect(html).toContain('RSS feed (external)');
    expect(html).toContain('custom');
    expect(html).toContain('preserve');
    expect(html).toContain('<strong>retained</strong>');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,bad',
    '//evil.test/rss',
    'https://user:secret@feeds.example.test/rss',
  ])('keeps unsafe URL as inert source parameters: %s', (url) => {
    const out = renderMacro(
      {
        name: 'rss',
        params: { url },
        richBody: [],
        plainBody: 'original body',
      },
      {},
    );
    expect(out).toEqual([
      { type: 'externalMacro', name: 'rss', params: { url } },
      { type: 'codeBlock', text: 'original body' },
    ]);
  });

  it.each(['ac:structured-macro', 'ac:macro', 'adf'])(
    'preserves static text through %s and the canonical serializer',
    async (format) => {
      const body =
        format === 'adf'
          ? {
              format: 'adf' as const,
              value: {
                type: 'doc',
                version: 1,
                content: [
                  { type: 'extension', attrs: { extensionKey: 'cheese' } },
                  {
                    type: 'extension',
                    attrs: {
                      extensionKey: 'loremipsum',
                      parameters: { macroParams: { '': { value: '2' } } },
                    },
                  },
                ],
              },
            }
          : {
              format: 'storage' as const,
              value: `<${format} ac:name="cheese"/><${format} ac:name="loremipsum"><ac:parameter ac:name="">2</ac:parameter></${format}>`,
            };
      const result = await service.renderBodyAsTipTap(body, ctx);
      const content = validateTipTapDoc(result.content).json;
      expect(content).toContain('I like cheese!');
      expect(content).toContain('Lorem ipsum dolor sit amet');
      expect(content).toContain('Ut ligula.');
      expect(content).not.toContain('externalMacro');
    },
  );

  it('renders the Server static macros as native text with its paragraph limits', () => {
    const macro = (name: string, params: Record<string, string> = {}) => ({
      name,
      params,
      richBody: [],
      plainBody: '',
    });
    expect(renderMacro(macro('cheese'), {})).toEqual({
      type: 'paragraph',
      children: [{ type: 'text', text: 'I like cheese!' }],
    });
    for (const [input, count] of [
      ['', 3],
      ['2', 2],
      ['100', 30],
      ['0', 3],
      ['-1', 3],
      ['bad', 3],
    ] as const) {
      const result = renderMacro(
        macro('loremipsum', { '': input }),
        {},
      ) as Array<{ children: Array<{ text: string }> }>;
      expect(result).toHaveLength(count);
      expect(result[0].children[0].text).toContain(
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
      );
    }
  });

  it.each(['cheese', 'loremipsum'])('preserves unsupported %s', (name) => {
    expect(
      renderMacro(
        { name, params: { count: '3' }, richBody: [], plainBody: 'keep me' },
        {},
      ),
    ).toEqual([
      { type: 'externalMacro', name, params: { count: '3' } },
      { type: 'codeBlock', text: 'keep me' },
    ]);
  });
});

describe('source page URL context', () => {
  it.each([
    [
      'https://wiki.test/confluence/',
      false,
      'https://wiki.test/confluence/pages/viewpage.action?pageId=42',
    ],
    [
      'https://wiki.test/',
      true,
      'https://wiki.test/wiki/pages/viewpage.action?pageId=42',
    ],
    [
      'https://wiki.test/wiki/',
      true,
      'https://wiki.test/wiki/pages/viewpage.action?pageId=42',
    ],
    [
      'https://user:secret@wiki.test/confluence?token=secret#fragment',
      false,
      'https://wiki.test/confluence/pages/viewpage.action?pageId=42',
    ],
    ['javascript:bad', false, undefined],
  ])('normalizes %s without credentials', (base, cloud, expected) => {
    expect(confluenceSourcePageUrl(base, '42', cloud)).toBe(expected);
  });

  it('passes the same source URL to page and excerpt renderers', async () => {
    const renderBodyAsTipTap = jest
      .fn()
      .mockResolvedValue({ content: '{}', needsRelink: false });
    const renderExcerptAsTipTap = jest.fn().mockResolvedValue(null);
    const mapper = new PageMapper(
      {} as never,
      { renderBodyAsTipTap, renderExcerptAsTipTap } as never,
    );
    const adapter = {
      product: 'confluence',
      deployment: 'cloud',
      getPageBody: jest
        .fn()
        .mockResolvedValue({ format: 'storage', value: '' }),
      listSpaces: jest.fn(),
      listPages: jest.fn(),
    };
    await mapper.renderTipTap(
      {
        orgId: 'org',
        run: {},
        job: { connection_id: 'connection', source_ref: 'SPACE', options: {} },
        getAdapter: async () => adapter,
        getSourceBaseUrl: async () => 'https://wiki.test/wiki',
        log: jest.fn(),
      } as never,
      { sourceId: '42', bodyFormat: 'storage' } as never,
    );
    for (const render of [renderBodyAsTipTap, renderExcerptAsTipTap])
      expect(render).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sourcePageUrl:
            'https://wiki.test/wiki/pages/viewpage.action?pageId=42',
        }),
      );
  });

  it('keeps blog source references in excerpts', async () => {
    const service = new ContentTransformService({} as never);
    const content = await service.renderExcerptAsTipTap(
      {
        format: 'storage',
        value:
          '<ac:structured-macro ac:name="excerpt"><ac:rich-text-body><ac:structured-macro ac:name="blog-posts"/></ac:rich-text-body></ac:structured-macro>',
      },
      {
        orgId: 'org',
        connectionId: 'connection',
        sourcePageUrl: 'https://wiki.test/wiki/pages/viewpage.action?pageId=42',
      },
    );
    expect(validateTipTapDoc(content).json).toContain('"type":"blogPosts"');
  });
});
