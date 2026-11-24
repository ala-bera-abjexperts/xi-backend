/**
 * P6 issue-body mapper tests (pure — no jsdom, no DI).
 *
 * Every issue in the live SDP census (100/100 sampled of 9,826) carries a description, so this is
 * the single highest-traffic content path in the Jira track. The failure mode to prevent is the
 * project's recurring one: content that vanishes, or degrades, with no log.
 */

import type { RawBody } from '../model/normalized';
import { describeLoss, issueDescriptionToHtml } from './issue-body.mapper';

const wiki = (value: string, renderedHtml?: string): RawBody => ({
  format: 'wiki',
  value,
  ...(renderedHtml ? { renderedHtml } : {}),
});

describe('P6 issue body mapper', () => {
  describe("prefers the source's own rendered HTML", () => {
    it('uses renderedHtml over the raw wiki markup (Jira renders its own markup best)', () => {
      const body = wiki(
        'h1. Titel\n*fett*',
        '<h1>Titel</h1><p><b>fett</b></p>',
      );

      expect(issueDescriptionToHtml(body)).toBe(
        '<h1>Titel</h1><p><b>fett</b></p>',
      );
    });

    it('matches the real SDP shape: plain text raw + <p>-wrapped rendered', () => {
      // Verbatim from the live census (SDP-9826).
      const raw =
        'Ticket-Nummer: 10000\n\nDies ist eine detaillierte Beschreibung.';
      const rendered =
        '<p>Ticket-Nummer: 10000</p>\n\n<p>Dies ist eine detaillierte Beschreibung.</p>';

      expect(issueDescriptionToHtml(wiki(raw, rendered))).toBe(rendered);
      expect(describeLoss(wiki(raw, rendered))).toBeUndefined();
    });

    it('ignores a blank renderedHtml and falls back rather than emitting emptiness', () => {
      expect(issueDescriptionToHtml(wiki('real text', '   '))).toBe(
        '<p>real text</p>',
      );
    });
  });

  describe('no description → undefined, never an empty artifact', () => {
    it('returns undefined for a missing body (SDP-1 has none)', () => {
      expect(issueDescriptionToHtml(undefined)).toBeUndefined();
      expect(describeLoss(undefined)).toBeUndefined();
    });

    it('returns undefined for whitespace-only wiki markup', () => {
      expect(issueDescriptionToHtml(wiki('   \n\n  '))).toBeUndefined();
    });
  });

  describe('wiki markup with NO rendered HTML degrades honestly and says so', () => {
    it('emits paragraphs, escapes HTML, and never dumps raw markup', () => {
      const html = issueDescriptionToHtml(
        wiki('Erste Zeile\n\nZweite <b>Zeile</b>'),
      );

      expect(html).toBe(
        '<p>Erste Zeile</p>\n<p>Zweite &lt;b&gt;Zeile&lt;/b&gt;</p>',
      );
    });

    it('turns single newlines into <br /> inside a paragraph', () => {
      expect(issueDescriptionToHtml(wiki('a\nb'))).toBe('<p>a<br />b</p>');
    });

    it('REPORTS the loss — markup was not interpreted', () => {
      expect(describeLoss(wiki('{code}x{code}'))).toMatch(/not interpreted/i);
    });

    it('does not report loss when the source rendered it for us', () => {
      expect(
        describeLoss(wiki('{code}x{code}', '<pre>x</pre>')),
      ).toBeUndefined();
    });
  });

  describe('flags fidelity loss instead of losing content silently', () => {
    it('keeps a Server rendered-HTML table and reports no loss (TasksService allows tables)', () => {
      const body = wiki(
        '|a|b|',
        '<table><tr><td>a</td><td>b</td></tr></table>',
      );

      // TasksService sanitizes with `allowTables`, so the grid reaches the task editor intact.
      // Nothing is lost, so nothing should be logged — a false loss note is noise in migration_logs.
      expect(issueDescriptionToHtml(body)).toContain('<table>');
      expect(describeLoss(body)).toBeUndefined();
    });

    it('converts a Cloud ADF body to HTML (no longer dropped)', () => {
      const adf: RawBody = {
        format: 'adf',
        value: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Hello world' }],
            },
          ],
        },
      };

      expect(issueDescriptionToHtml(adf)).toBe('<p>Hello world</p>');
      expect(describeLoss(adf)).toBeUndefined();
    });

    it('preserves ADF inline formatting (bold) through the converter', () => {
      const adf: RawBody = {
        format: 'adf',
        value: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'plain ' },
                {
                  type: 'text',
                  text: 'bold',
                  marks: [{ type: 'strong' }],
                },
              ],
            },
          ],
        },
      };

      const html = issueDescriptionToHtml(adf);

      expect(html).toContain('bold');
      expect(html).toMatch(/<(strong|b)>bold<\/(strong|b)>/);
    });

    it('returns undefined for an empty ADF doc, never an empty artifact', () => {
      const adf: RawBody = {
        format: 'adf',
        value: { type: 'doc', version: 1, content: [] },
      };

      expect(issueDescriptionToHtml(adf)).toBeUndefined();
      expect(describeLoss(adf)).toBeUndefined();
    });

    it('converts an ADF table to a real table and reports no loss', () => {
      const cell = (t: string) => ({
        type: 'tableCell',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
      });
      const adf: RawBody = {
        format: 'adf',
        value: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'table',
              content: [{ type: 'tableRow', content: [cell('a'), cell('b')] }],
            },
          ],
        },
      };

      const html = issueDescriptionToHtml(adf) ?? '';

      expect(html).toContain('<table>');
      expect(html).toContain('<td>');
      expect(html).toContain('a');
      expect(html).toContain('b');
      expect(describeLoss(adf)).toBeUndefined();
    });

    it('renders an ADF tableHeader cell as <th>, in any row', () => {
      const cell = (t: string, header = false) => ({
        type: header ? 'tableHeader' : 'tableCell',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
      });
      const adf: RawBody = {
        format: 'adf',
        value: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'table',
              content: [
                {
                  type: 'tableRow',
                  content: [cell('h1', true), cell('h2', true)],
                },
                // `header` is decided per CELL, so a mid-table header row still renders <th>.
                { type: 'tableRow', content: [cell('mid', true), cell('b')] },
              ],
            },
          ],
        },
      };

      const html = issueDescriptionToHtml(adf) ?? '';

      // Cell content is wrapped in a paragraph, matching what the TipTap table nodes emit.
      expect(html).toContain('<th><p>h1</p></th>');
      expect(html).toContain('<th><p>mid</p></th>');
      expect(html).toContain('<td><p>b</p></td>');
    });

    it('still uses ADF renderedHtml when the source supplied it', () => {
      const adf: RawBody = {
        format: 'adf',
        value: { type: 'doc' },
        renderedHtml: '<p>hi</p>',
      };

      expect(issueDescriptionToHtml(adf)).toBe('<p>hi</p>');
      expect(describeLoss(adf)).toBeUndefined();
    });
  });

  it('passes pre-rendered html format straight through', () => {
    expect(issueDescriptionToHtml({ format: 'html', value: '<p>x</p>' })).toBe(
      '<p>x</p>',
    );
  });
});
