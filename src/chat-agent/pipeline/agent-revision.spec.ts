import {
  asksNewPage,
  carriedOverrides,
  isChangeRequest,
  isUndo,
  rehandle,
  type RunHandles,
} from './agent-revision';
import type { WikiBlock } from './agent-wiki-render';

const block = (b: Partial<WikiBlock> & Pick<WikiBlock, 'type'>): WikiBlock => ({
  level: null,
  text: null,
  title: null,
  items: [],
  rows: [],
  variant: null,
  language: null,
  refs: [],
  labels: [],
  ...b,
});

describe('agent-revision (1.17)', () => {
  it.each([
    ['add a risks section', true],
    ['make the budget a pie chart', true],
    ['make it shorter', true],
    ['rename it to Launch plan', true],
    ['füge einen Abschnitt zu Risiken hinzu', true],
    ['mach es kürzer', true],
    ['übersetze die Seite auf Deutsch', true],
    ['what did we decide?', false],
    ['thanks!', false],
  ])('"%s" is a change request: %s', (request, expected) => {
    expect(isChangeRequest(request)).toBe(expected);
  });

  it('tells a new page and an undo from a change', () => {
    expect(asksNewPage('create another page for the risks')).toBe(true);
    expect(asksNewPage('erstelle eine neue Seite')).toBe(true);
    expect(asksNewPage('add a risks section to the page')).toBe(false);
    expect(isUndo('undo that')).toBe(true);
    expect(isUndo('mach das rückgängig')).toBe(true);
    expect(isUndo('add a section')).toBe(false);
  });

  const old: RunHandles = {
    messages: { m3: 'msg-a', m4: 'msg-gone' },
    people: {
      P2: { userId: 'u-raj', name: 'Rajbha Manek' },
      P3: { userId: 'u-left', name: 'Ala Bera' },
    },
    tasks: { T1: { key: 'AMBER-T25' } },
    pages: { W1: { id: 'pg-vpn' }, W2: { id: 'pg-hidden' } },
    items: { i2: 2, i3: 3 },
  };
  const next: RunHandles = {
    messages: { m9: 'msg-a' },
    people: { P1: { userId: 'u-raj', name: 'Rajbha Manek' } },
    tasks: {},
    pages: { W1: { id: 'pg-vpn' } },
  };

  it('shows the old page in the handles of the new run, and leaves out what it cannot reference', () => {
    const out = rehandle(
      [
        block({ type: 'paragraph', text: 'Owner @P2, with @P3 [m3][m4].' }),
        block({ type: 'task_cards', refs: ['T1', 'i2', 'i3', 'AMBER-T30'] }),
        block({ type: 'include_page', refs: ['W1'] }),
        block({ type: 'include_page', refs: ['W2'] }),
        block({
          type: 'table',
          rows: [
            ['Who', 'Source'],
            ['@P2', '[m3]'],
          ],
        }),
      ],
      old,
      next,
      new Map([[2, 'AMBER-T41']]),
    );
    expect(out[0].text).toBe('Owner @P1, with Ala Bera [m9].');
    expect(out[1].refs).toEqual(['AMBER-T25', 'AMBER-T41', 'AMBER-T30']);
    expect(out[2].refs).toEqual(['W1']);
    expect(out).toHaveLength(4); // the page the new run cannot reference is gone
    expect(out[3].rows[1]).toEqual(['@P1', '[m9]']);
  });

  it('keeps the card edits, except the field the request sets itself', () => {
    const edits = { title: 'Launch plan', space: 'sp-1', publish: true };
    expect(carriedOverrides(edits, 'add a risks section')).toEqual(edits);
    expect(carriedOverrides(edits, 'rename it to Go-live plan')).toEqual({
      space: 'sp-1',
      publish: true,
    });
    expect(carriedOverrides(edits, 'leave it as a draft')).toEqual({
      title: 'Launch plan',
      space: 'sp-1',
    });
    expect(carriedOverrides(null, 'x')).toEqual({});
  });
});
