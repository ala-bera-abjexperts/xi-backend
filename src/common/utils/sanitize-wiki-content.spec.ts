// Mock the DOMPurify-backed sanitizer (jsdom can't load in this jest env — the
// rest of the suite mocks it the same way). The stand-in strips <script> blocks
// and on*=... handlers so we can assert BOTH that HTML-bearing fields are
// sanitized AND that structural/URL fields are left untouched by our walker.
jest.mock('./sanitize-rich-text', () => ({
  sanitizeRichText: (v: string | null | undefined) =>
    v == null
      ? null
      : String(v)
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/\s+on\w+=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ''),
}));

import { sanitizeWikiContentForStorage } from './sanitize-wiki-content';

describe('sanitizeWikiContentForStorage', () => {
  it('sanitizes html-format content, keeping safe markup', () => {
    const out = sanitizeWikiContentForStorage(
      '<b>hello</b><img src=x onerror=alert(1)><script>a()</script>',
      'html',
    );

    expect(out).toContain('<b>hello</b>');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('<script>');
  });

  it('sanitizes Editor.js HTML fields while preserving structure', () => {
    const doc = {
      time: 123,
      version: '2.30.0',
      blocks: [
        {
          id: 'a',
          type: 'paragraph',
          data: { text: '<b>ok</b><img src=x onerror=alert(1)>' },
        },
        { id: 'b', type: 'raw', data: { html: '<div onclick="s()">x</div>' } },
        {
          id: 'c',
          type: 'header',
          data: { text: 'T <script>b()</script>', level: 2 },
        },
      ],
    };

    const out = JSON.parse(
      sanitizeWikiContentForStorage(JSON.stringify(doc), 'editorjs'),
    );
    const asStr = JSON.stringify(out);

    expect(asStr).not.toMatch(/onerror|onclick|<script>/);
    expect(out.blocks[0].data.text).toContain('<b>ok</b>');
    expect(out.blocks[2].data.level).toBe(2); // structural field untouched
    expect(out.blocks.map((b: { type: string }) => b.type)).toEqual([
      'paragraph',
      'raw',
      'header',
    ]);
    expect(out.time).toBe(123);
    expect(out.version).toBe('2.30.0');
  });

  it('does NOT touch structural/URL fields (no accidental mangling)', () => {
    const doc = {
      blocks: [
        {
          type: 'linkTool',
          data: {
            link: 'https://ex.com/p?a=1&b=2',
            meta: { title: 'Hi & Bye' },
          },
        },
        {
          type: 'image',
          data: {
            file: { url: 'https://cdn/x.png?w=1&h=2' },
            caption: '<i>cap</i>',
          },
        },
      ],
    };

    const out = JSON.parse(
      sanitizeWikiContentForStorage(JSON.stringify(doc), 'editorjs'),
    );

    expect(out.blocks[0].data.link).toBe('https://ex.com/p?a=1&b=2');
    expect(out.blocks[0].data.meta.title).toBe('Hi & Bye');
    expect(out.blocks[1].data.file.url).toBe('https://cdn/x.png?w=1&h=2');
    expect(out.blocks[1].data.caption).toContain('<i>cap</i>');
  });

  it('sanitizes nested list items and table cells', () => {
    const doc = {
      blocks: [
        {
          type: 'list',
          data: {
            items: [
              '<img src=x onerror=a()>a',
              {
                content: '<b>b</b><script>x</script>',
                items: ['<img src=y onerror=h()>c'],
              },
            ],
          },
        },
        {
          type: 'table',
          data: { content: [['<b>cell</b>', '<img src=x onerror=boom()>']] },
        },
      ],
    };

    const json = sanitizeWikiContentForStorage(JSON.stringify(doc), 'editorjs');

    expect(json).not.toMatch(/onerror|<script>/);
    expect(json).toContain('<b>cell</b>');
  });

  it('returns non-Editor.js JSON unchanged', () => {
    const weird = JSON.stringify({ foo: 'bar', n: 1 });

    expect(sanitizeWikiContentForStorage(weird, 'editorjs')).toBe(weird);
  });

  it('degrades to HTML sanitization when editorjs content is not valid JSON', () => {
    const out = sanitizeWikiContentForStorage(
      '<p onmouseover=evil()>hi</p>',
      'editorjs',
    );

    expect(out).toContain('hi');
    expect(out).not.toContain('onmouseover');
  });

  it('passes through empty/nullish safely', () => {
    expect(sanitizeWikiContentForStorage('', 'editorjs')).toBe('');
    expect(sanitizeWikiContentForStorage(null, 'html')).toBe('');
    expect(sanitizeWikiContentForStorage(undefined, 'editorjs')).toBe('');
  });
});
