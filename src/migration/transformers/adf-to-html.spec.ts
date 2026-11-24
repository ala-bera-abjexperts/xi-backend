/**
 * ADF → CIR. Confluence CLOUD pages are always ADF, so this parser is the entire front door for a
 * Cloud migration — and it had no test coverage at all.
 *
 * Each case below pins a defect found against the customer's real space (339 pages), with the live
 * count noted. They are regression guards, not hypotheticals: before these fixes the constructs were
 * dropped or degraded SILENTLY — no error, no lossy log — which is the worst failure mode for a
 * migration because the run reports success.
 */

import { adfToCir } from './adf-to-html';
import type { CirNode } from './canonical-ir';
import type { ParsedMacro } from './canonical-ir';

/** Collect the macros the parser hands to the registry, and echo a marker node back. */
function harness() {
  const seen: ParsedMacro[] = [];
  const logs: string[] = [];

  return {
    seen,
    logs,
    hooks: {
      onMacro: (macro: ParsedMacro): CirNode => {
        seen.push(macro);

        return { type: 'text', text: `<macro:${macro.name}>` };
      },
      log: (message: string) => void logs.push(message),
    },
  };
}

const parse = (adf: unknown) => adfToCir(adf, harness().hooks);

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const para = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

/** Find the first node of `type` anywhere in a CIR tree. */
function find(nodes: CirNode[], type: string): any {
  for (const n of nodes) {
    if (n.type === type) return n;

    const kids: CirNode[] =
      (n as any).children ??
      (n as any).items?.flatMap((i: any) => i.children ?? i) ??
      (n as any).columns?.flat() ??
      [];
    const hit = find(kids, type);

    if (hit) return hit;
  }

  return undefined;
}

const types = (nodes: CirNode[]): string[] => {
  const out: string[] = [];

  const walk = (ns: CirNode[]) => {
    for (const n of ns) {
      out.push(n.type);
      walk(
        (n as any).children ??
          (n as any).items?.flatMap((i: any) => i.children ?? i) ??
          (n as any).columns?.flat() ??
          [],
      );
    }
  };

  walk(nodes);

  return out;
};

describe('adfToCir — Confluence Cloud fidelity', () => {
  describe('decisions (199 in the live space)', () => {
    it('keeps decision items instead of dropping them entirely', () => {
      const cir = parse(
        doc({
          type: 'decisionList',
          content: [
            {
              type: 'decisionItem',
              attrs: { state: 'DECIDED' },
              content: [{ type: 'text', text: 'Use Postgres' }],
            },
            {
              type: 'decisionItem',
              attrs: { state: 'UNDECIDED' },
              content: [{ type: 'text', text: 'Vendor TBD' }],
            },
          ],
        }),
      );
      const list = find(cir.children, 'decisionList');

      expect(list).toBeDefined();
      expect(list.items).toHaveLength(2);
      expect(list.items[0].decided).toBe(true);
      expect(list.items[1].decided).toBe(false);
      expect(JSON.stringify(cir)).toContain('Use Postgres');
    });
  });

  describe('layouts', () => {
    it('preserves a two-column layout as columns, not one flattened stream', () => {
      const cir = parse(
        doc({
          type: 'layoutSection',
          content: [
            { type: 'layoutColumn', content: [para('left')] },
            { type: 'layoutColumn', content: [para('right')] },
          ],
        }),
      );
      const layout = find(cir.children, 'layout');

      expect(layout).toBeDefined();
      expect(layout.columns).toHaveLength(2);
    });

    it('inlines a single full-width column rather than wrapping it needlessly', () => {
      const cir = parse(
        doc({
          type: 'layoutSection',
          content: [{ type: 'layoutColumn', content: [para('only')] }],
        }),
      );

      expect(types(cir.children)).not.toContain('layout');
      expect(JSON.stringify(cir)).toContain('only');
    });
  });

  describe('expand', () => {
    it('carries the title, which the generic recursion used to discard', () => {
      const cir = parse(
        doc({
          type: 'expand',
          attrs: { title: 'Runbook steps' },
          content: [para('body')],
        }),
      );
      const expand = find(cir.children, 'expand');

      expect(expand?.title).toBe('Runbook steps');
      expect(JSON.stringify(cir)).toContain('body');
    });

    it('handles nestedExpand the same way', () => {
      const cir = parse(
        doc({
          type: 'nestedExpand',
          attrs: { title: 'Inner' },
          content: [para('x')],
        }),
      );

      expect(find(cir.children, 'expand')?.title).toBe('Inner');
    });
  });

  describe('status (14 in the live space)', () => {
    it('keeps the colour instead of degrading to bold text', () => {
      const cir = parse(
        doc({
          type: 'paragraph',
          content: [
            { type: 'status', attrs: { text: 'BLOCKED', color: 'Red' } },
          ],
        }),
      );
      const status = find(cir.children, 'status');

      expect(status).toBeDefined();
      expect(status.text).toBe('BLOCKED');
      expect(status.color).toBe('red');
    });
  });

  describe('inline extensions', () => {
    it('routes an inline macro through the registry instead of dropping it', () => {
      const h = harness();
      const cir = adfToCir(
        doc({
          type: 'paragraph',
          content: [
            { type: 'text', text: 'before ' },
            { type: 'inlineExtension', attrs: { extensionKey: 'pagetree' } },
          ],
        }),
        h.hooks,
      );

      expect(h.seen.map((m) => m.name)).toContain('pagetree');
      expect(JSON.stringify(cir)).toContain('<macro:pagetree>');
    });
  });

  describe('macro bodies', () => {
    it('collects plain-text body from DESCENDANTS, not just the top level', () => {
      // ADF wraps a macro body in paragraphs, which have no `.text` of their own — reading one level
      // deep made plainBody always '' and emptied every code macro.
      const h = harness();

      adfToCir(
        doc({
          type: 'bodiedExtension',
          attrs: { extensionKey: 'code' },
          content: [para('const a = 1')],
        }),
        h.hooks,
      );

      expect(h.seen[0]?.plainBody).toContain('const a = 1');
    });

    it('still exposes macro parameters', () => {
      const h = harness();

      adfToCir(
        doc({
          type: 'extension',
          attrs: {
            extensionKey: 'attachments',
            parameters: { macroParams: { upload: { value: 'false' } } },
          },
        }),
        h.hooks,
      );

      expect(h.seen[0]?.params).toEqual({ upload: 'false' });
    });
  });

  describe('media (230 in the live space)', () => {
    it('carries the Media Services id so the attachment crosswalk can resolve it', () => {
      const cir = parse(
        doc({
          type: 'mediaSingle',
          content: [
            {
              type: 'media',
              attrs: {
                type: 'file',
                id: 'b62385d0-a4d4-45e8-9152-b7466153133c',
                alt: 'shot.png',
              },
            },
          ],
        }),
      );
      const media = find(cir.children, 'media');

      // `filename` is the crosswalk lookup key; it must be the fileId, which is what ADF gives us.
      expect(media.filename).toBe('b62385d0-a4d4-45e8-9152-b7466153133c');
    });

    it('uses the direct URL for external media', () => {
      const cir = parse(
        doc({
          type: 'mediaSingle',
          content: [
            {
              type: 'media',
              attrs: { type: 'external', url: 'https://x/y.png' },
            },
          ],
        }),
      );

      expect(find(cir.children, 'media').src).toBe('https://x/y.png');
    });

    it('handles inline media rather than dropping it', () => {
      const cir = parse(
        doc({
          type: 'paragraph',
          content: [
            { type: 'mediaInline', attrs: { type: 'file', id: 'abc-123' } },
          ],
        }),
      );

      expect(types(cir.children)).toContain('media');
    });
  });

  describe('caption', () => {
    it('keeps a media caption', () => {
      const cir = parse(
        doc({
          type: 'caption',
          content: [{ type: 'text', text: 'Figure 1: topology' }],
        }),
      );

      expect(find(cir.children, 'caption')).toBeDefined();
      expect(JSON.stringify(cir)).toContain('Figure 1: topology');
    });
  });

  describe('constructs that already worked keep working', () => {
    it('parses panels, tables, task lists, code and rules', () => {
      const cir = parse(
        doc(
          {
            type: 'panel',
            attrs: { panelType: 'info' },
            content: [para('note')],
          },
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [{ type: 'tableHeader', content: [para('H')] }],
              },
            ],
          },
          {
            type: 'taskList',
            content: [
              {
                type: 'taskItem',
                attrs: { state: 'DONE' },
                content: [{ type: 'text', text: 'done' }],
              },
            ],
          },
          {
            type: 'codeBlock',
            attrs: { language: 'ts' },
            content: [{ type: 'text', text: 'x' }],
          },
          { type: 'rule' },
        ),
      );
      const found = types(cir.children);

      expect(found).toEqual(
        expect.arrayContaining([
          'panel',
          'table',
          'taskList',
          'codeBlock',
          'rule',
        ]),
      );
      expect(find(cir.children, 'taskList').items[0].checked).toBe(true);
    });
  });

  describe('constructs that were degraded to plain text or dropped', () => {
    it('keeps a date as a real date node, not an ISO string (200 in the live space)', () => {
      const cir = parse(
        doc({
          type: 'paragraph',
          content: [{ type: 'date', attrs: { timestamp: '1735689600000' } }],
        }),
      );
      const date = find(cir.children, 'date');

      // The epoch-ms STRING is kept as ADF emits it — parsing to a formatted date here would lock in
      // one locale and lose the round-trip.
      expect(date?.timestamp).toBe('1735689600000');
    });

    it('keeps an inlineCard as a smart-link chip (33 in the live space)', () => {
      const cir = parse(
        doc({
          type: 'paragraph',
          content: [
            { type: 'inlineCard', attrs: { url: 'https://example.com/x' } },
          ],
        }),
      );

      expect(find(cir.children, 'inlineCard')?.url).toBe(
        'https://example.com/x',
      );
    });

    it('marks mediaInline as inline so the TipTap serializer cannot drop it (17 in the live space)', () => {
      const cir = parse(
        doc({
          type: 'paragraph',
          content: [
            { type: 'mediaInline', attrs: { type: 'file', id: 'abc-123' } },
          ],
        }),
      );

      expect(find(cir.children, 'media')?.inline).toBe(true);
    });

    it('does NOT mark block media as inline', () => {
      const cir = parse(
        doc({
          type: 'mediaSingle',
          content: [{ type: 'media', attrs: { type: 'file', id: 'abc-123' } }],
        }),
      );

      expect(find(cir.children, 'media')?.inline).toBe(false);
    });

    it('reads the textColor mark, which the valueless mark map could not hold (4 in the live space)', () => {
      const cir = parse(
        doc({
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'red',
              marks: [{ type: 'textColor', attrs: { color: '#ff0000' } }],
            },
          ],
        }),
      );

      expect(find(cir.children, 'text')?.color).toBe('#ff0000');
    });

    it('reads indentation and alignment, which ADF models as BLOCK marks (25 + 2 in the live space)', () => {
      // The generic mark loop only runs for text nodes, so before `blockFormat` both were dropped
      // with no error and no lossy log.
      const cir = parse(
        doc({
          type: 'paragraph',
          content: [{ type: 'text', text: 'x' }],
          marks: [
            { type: 'indentation', attrs: { level: 2 } },
            { type: 'alignment', attrs: { align: 'center' } },
          ],
        }),
      );
      const para = find(cir.children, 'paragraph');

      expect(para?.indent).toBe(2);
      expect(para?.align).toBe('center');
    });

    it('ignores an alignment value outside the known set', () => {
      const cir = parse(
        doc({
          type: 'paragraph',
          content: [{ type: 'text', text: 'x' }],
          marks: [{ type: 'alignment', attrs: { align: 'sideways' } }],
        }),
      );

      expect(find(cir.children, 'paragraph')?.align).toBeUndefined();
    });

    it('emits emoji as its unicode character, which renders identically and stays searchable', () => {
      const cir = parse(
        doc({
          type: 'paragraph',
          content: [
            { type: 'emoji', attrs: { text: '\u2705', shortName: ':check:' } },
          ],
        }),
      );

      expect(JSON.stringify(cir)).toContain('\u2705');
    });

    /**
     * Atlassian ships `emoji.attrs.text` ALREADY ESCAPED for most non-BMP emoji: the attribute holds
     * the twelve literal characters `\ud83d\uddd3`, not \ud83d\uddd3. Reading it raw put that escape text into
     * the migrated page \u2014 203 of 350 pages in the customer's space, 848 nodes. Live shape:
     * {"type":"emoji","attrs":{"id":"1f5d3","text":"\\uD83D\\uDDD3","shortName":":calendar_spiral:"}}
     */
    it('decodes the pre-escaped emoji text Atlassian ships, not the literal escape', () => {
      const cir = parse(
        doc({
          type: 'heading',
          attrs: { level: 2 },
          content: [
            {
              type: 'emoji',
              attrs: {
                id: '1f5d3',
                text: '\\uD83D\\uDDD3',
                shortName: ':calendar_spiral:',
              },
            },
            { type: 'text', text: ' Datum' },
          ],
        }),
      );

      const json = JSON.stringify(cir);

      expect(json).toContain('\u{1F5D3}');
      expect(json).not.toContain('uD83D');
    });

    it('leaves an emoji that already arrived decoded untouched (mixed in one doc)', () => {
      // The same field is inconsistent in real data, so both forms occur side by side.
      const cir = parse(
        doc({
          type: 'paragraph',
          content: [
            { type: 'emoji', attrs: { id: '2705', text: '\u2705' } },
            {
              type: 'emoji',
              attrs: { id: '1f465', text: '\\uD83D\\uDC65' },
            },
          ],
        }),
      );

      const json = JSON.stringify(cir);

      expect(json).toContain('\u2705');
      expect(json).toContain('\u{1F465}');
      expect(json).not.toContain('uD83D');
    });

    it('keeps an Atlassian custom emoji readable instead of emitting garbage', () => {
      const cir = parse(
        doc({
          type: 'paragraph',
          content: [
            {
              type: 'emoji',
              attrs: { id: 'atlassian-plus', text: ':plus:' },
            },
          ],
        }),
      );

      expect(JSON.stringify(cir)).toContain(':plus:');
    });
  });
});
