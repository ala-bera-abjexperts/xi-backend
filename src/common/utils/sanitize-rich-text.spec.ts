/**
 * @fileoverview Behavioural tests for `sanitizeRichText` — deliberately UNMOCKED.
 *
 * Almost every other suite `jest.mock`s this module to an identity function so it can assert what a
 * service passed in. That leaves the sanitizer itself untested, which is the wrong thing to leave
 * untested: it is the boundary that decides what stored HTML a browser will execute. This suite
 * runs the real DOMPurify over the real jsdom window (jsdom is whitelisted in the Jest
 * `transformIgnorePatterns` allow-list, so it loads under ts-jest).
 *
 * The `allowTables` default matters as much as the opt-in: it is what keeps tables out of GDPR,
 * SiteStudio, wiki comments and the Editor.js wiki storage path. A future change that widens the
 * default instead of passing the option at one call site must fail here.
 *
 * @module src/common/utils/sanitize-rich-text.spec
 */

import { sanitizeRichText } from './sanitize-rich-text';

const TABLE = [
  '<table>',
  '<thead><tr><th colspan="2">Head</th></tr></thead>',
  '<tbody><tr><td rowspan="2">a</td><td></td></tr></tbody>',
  '</table>',
].join('');

describe('sanitizeRichText', () => {
  describe('table markup', () => {
    it('keeps the grid, headers and spans when allowTables is set', () => {
      const out = sanitizeRichText(TABLE, { allowTables: true }) ?? '';

      expect(out).toContain('<table>');
      expect(out).toContain('<thead>');
      expect(out).toContain('<tbody>');
      expect(out).toContain('<th colspan="2">');
      expect(out).toContain('<td rowspan="2">');
    });

    it('preserves an empty cell rather than collapsing the row', () => {
      const out = sanitizeRichText(TABLE, { allowTables: true }) ?? '';

      // TipTap emits <td><p></p></td> for an untouched cell; either shape must survive, because a
      // dropped empty cell shifts every following cell one column to the left.
      expect(out).toContain('<td></td>');
      expect(
        sanitizeRichText('<table><tr><td><p></p></td></tr></table>', {
          allowTables: true,
        }),
      ).toContain('<td><p></p></td>');
    });

    it('keeps multiple tables, and tables mixed with lists and images', () => {
      const html = `${TABLE}<ul><li>one</li></ul>${TABLE}<p><img src="/api/v1/attachments/x/download" alt="a"></p>`;
      const out = sanitizeRichText(html, { allowTables: true }) ?? '';

      expect(out.match(/<table>/g)).toHaveLength(2);
      expect(out).toContain('<li>one</li>');
      expect(out).toContain('<img');
    });

    it('DROPS table markup by default', () => {
      // The load-bearing assertion for every surface that has NOT opted in.
      const out = sanitizeRichText(TABLE) ?? '';

      expect(out).not.toContain('<table');
      expect(out).not.toContain('<td');
      expect(out).not.toContain('colspan');
      expect(out).toBe('a');
    });

    it('destroys HEADER text under the default policy, not just the grid', () => {
      // Worth pinning explicitly, because it is the part that was previously mis-described as
      // "the cell text is preserved, only the layout is lost". Body cells are indeed kept as bare
      // text, but <thead>/<th> content is dropped OUTRIGHT — so before `allowTables`, every Jira
      // table's header row was silently deleted, not merely flattened.
      expect(sanitizeRichText(TABLE)).not.toContain('Head');
      expect(
        sanitizeRichText('<table><tr><td>a</td><td>b</td></tr></table>'),
      ).toBe('ab');
    });

    it('leaves non-table rich text byte-identical whether or not tables are allowed', () => {
      const html =
        '<p><strong>b</strong> <em>i</em></p><ul><li>x</li></ul><a href="https://x.test">l</a>';

      expect(sanitizeRichText(html, { allowTables: true })).toBe(
        sanitizeRichText(html),
      );
    });
  });

  describe('still hostile to everything else when tables are allowed', () => {
    it.each([
      [
        'script tag',
        '<table><tr><td><script>alert(1)</script></td></tr></table>',
        'alert(1)',
      ],
      [
        'event handler',
        '<table><tr><td onclick="steal()">x</td></tr></table>',
        'onclick',
      ],
      [
        'javascript: URI',
        '<table><tr><td><a href="javascript:alert(1)">x</a></td></tr></table>',
        'javascript:',
      ],
      [
        'inline style',
        '<table><tr><td style="background:url(x)">x</td></tr></table>',
        'style',
      ],
      [
        'data attribute',
        '<table><tr><td data-evil="1">x</td></tr></table>',
        'data-evil',
      ],
      [
        'iframe',
        '<table><tr><td><iframe src="https://evil.test"></iframe></td></tr></table>',
        '<iframe',
      ],
      [
        'col width style',
        '<table><colgroup><col style="width:120px"></colgroup></table>',
        'width:120px',
      ],
    ])('strips a %s inside a table cell', (_label, input, forbidden) => {
      const out = sanitizeRichText(input, { allowTables: true }) ?? '';

      expect(out).not.toContain(forbidden);
    });

    it('keeps the cell itself while stripping the dangerous attribute', () => {
      const out =
        sanitizeRichText(
          '<table><tr><td onclick="x()">keep</td></tr></table>',
          {
            allowTables: true,
          },
        ) ?? '';

      expect(out).toContain('<td>keep</td>');
    });
  });

  describe('malformed source markup', () => {
    it('produces well-formed output from a cell with no row', () => {
      const out =
        sanitizeRichText('<td>orphan</td>', { allowTables: true }) ?? '';

      // HTML5 foster-parenting drops the stray cell wrapper but never loses the text.
      expect(out).toContain('orphan');
      expect(out).not.toContain('</table>');
    });

    it('closes an unclosed table', () => {
      const out =
        sanitizeRichText('<table><tr><td>a', { allowTables: true }) ?? '';

      expect(out).toContain('<table>');
      expect(out).toContain('a');
      expect(out.match(/<table>/g)).toHaveLength(1);
      expect(out).toContain('</table>');
    });

    it('keeps a nested table as a nested table', () => {
      const out =
        sanitizeRichText(
          '<table><tr><td><table><tr><td>inner</td></tr></table></td></tr></table>',
          { allowTables: true },
        ) ?? '';

      expect(out.match(/<table>/g)).toHaveLength(2);
      expect(out).toContain('inner');
    });
  });

  describe('image thumbnails (XE-T684)', () => {
    it('keeps the thumbnail flag on an image', () => {
      expect(
        sanitizeRichText(
          '<p><img src="https://cdn.test/a.png" alt="a.png" data-thumbnail="true"></p>',
        ),
      ).toContain('data-thumbnail="true"');
    });

    it('still drops data attributes that are not on the list', () => {
      const out = sanitizeRichText(
        '<p><img src="https://cdn.test/a.png" data-thumbnail="true" data-evil="x"></p>',
      );

      expect(out).toContain('data-thumbnail="true"');
      expect(out).not.toContain('data-evil');
    });
  });

  describe('contract', () => {
    it('returns null for null/undefined and passes empty string through', () => {
      expect(sanitizeRichText(null)).toBeNull();
      expect(sanitizeRichText(undefined)).toBeNull();
      expect(sanitizeRichText('')).toBe('');
    });
  });
});
