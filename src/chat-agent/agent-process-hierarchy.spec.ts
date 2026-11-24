import { parentsFirst } from './agent-run-worker.service';
import { placeProcess, promptLevels, type ProcessLevel } from './pipeline/agent-kinds';

const level = (id: string, requestType: string, parentLevelId: string | null, allowedChildren: string[] = []): ProcessLevel => ({
  id,
  requestType,
  parentLevelId,
  allowedChildren,
});

// The ladder as the local organization has it.
const LADDER = [
  level('gp', 'Geschäftsprozessbewertung', null, ['prozess', 'schwach']),
  level('prozess', 'Prozessbewertung', 'gp', ['service', 'schwach', 'group2']),
  level('service', 'Servicebewertung', 'prozess', ['group', 'asset', 'schwach']),
  level('group', 'Assetgroup', 'service', ['asset', 'schwach']),
  level('asset', 'Assetbewertung', 'group', ['schwach']),
  level('schwach', 'Schwachstelle', null, ['massnahme']),
  level('massnahme', 'Maßnahme', 'schwach'),
  level('risiko', 'Risiko', null, ['asset']),
  level('group2', 'Assetgroup', 'prozess', ['service']),
];

describe('placeProcess: a process in the level ladder', () => {
  it('walks the whole ladder from the top to a Maßnahme', () => {
    const chain = ['Geschäftsprozessbewertung', 'Prozessbewertung', 'Servicebewertung', 'Assetgroup', 'Assetbewertung', 'Schwachstelle', 'Maßnahme'];
    let parent: { levelId: string | null; requestType: string } | null = null;
    for (const requestType of chain) {
      const placed = placeProcess(LADDER, parent, requestType);
      expect(placed.problem).toBeUndefined();
      expect(placed.levelId).toBeTruthy();
      parent = { levelId: placed.levelId, requestType };
    }
    expect(parent?.levelId).toBe('massnahme');
  });

  it('takes the level allowed under this parent when a type has two', () => {
    expect(placeProcess(LADDER, { levelId: 'prozess', requestType: 'Prozessbewertung' }, 'Assetgroup').levelId).toBe('group2');
    expect(placeProcess(LADDER, { levelId: 'service', requestType: 'Servicebewertung' }, 'Assetgroup').levelId).toBe('group');
  });

  it('refuses a child the parent does not allow, and offers what it does', () => {
    const placed = placeProcess(LADDER, { levelId: 'risiko', requestType: 'Risiko' }, 'Risiko');
    expect(placed.problem).toBe('level_not_allowed');
    expect(placed.levelId).toBeNull();
    expect(placed.allowed).toEqual(['Assetbewertung']);
  });

  it('refuses a type that cannot stand at the top, and offers what can', () => {
    const placed = placeProcess(LADDER, null, 'Servicebewertung');
    expect(placed.problem).toBe('level_needs_parent');
    expect(placed.allowed).toEqual(['Geschäftsprozessbewertung', 'Schwachstelle', 'Risiko']);
    expect(placeProcess(LADDER, null, 'Schwachstelle').problem).toBeUndefined();
  });

  it('gives a child without a type the first level allowed under its parent', () => {
    const placed = placeProcess(LADDER, { levelId: 'gp', requestType: 'Geschäftsprozessbewertung' }, null);
    expect(placed).toMatchObject({ requestType: 'Prozessbewertung', levelId: 'prozess' });
  });

  it('never guesses the type of a process at the top', () => {
    const placed = placeProcess(LADDER, null, null);
    expect(placed.requestType).toBeUndefined();
    expect(placed.problem).toBeUndefined();
  });

  it('finds a parent without a level by its type', () => {
    expect(placeProcess(LADDER, { levelId: null, requestType: 'Prozessbewertung' }, 'Servicebewertung').levelId).toBe('service');
  });

  it('checks nothing when the organization has no ladder', () => {
    expect(placeProcess([], null, 'Servicebewertung')).toEqual({ levelId: null, allowed: [] });
  });
});

describe('promptLevels: what the model reads', () => {
  it('names each type once, with the types allowed under it', () => {
    const levels = promptLevels(LADDER);
    expect(levels.filter((l) => l.type === 'Assetgroup')).toHaveLength(1);
    expect(levels.find((l) => l.type === 'Assetgroup')?.children).toEqual(['Assetbewertung', 'Schwachstelle', 'Servicebewertung']);
    expect(levels.find((l) => l.type === 'Schwachstelle')).toEqual({ type: 'Schwachstelle', root: true, children: ['Maßnahme'] });
    expect(levels.find((l) => l.type === 'Servicebewertung')?.root).toBe(false);
  });
});

describe('parentsFirst: the order of a tree', () => {
  const item = (ref: string, kind: string, parent: string | null = null) => ({ ref, kind, parent: { item: parent } });

  it('moves a main process before what hangs under it, however deep', () => {
    const out = parentsFirst([item('c', 'process', 'b'), item('b', 'process', 'a'), item('a', 'process'), item('t', 'task', 'c')]);
    expect(out.map((i) => i.ref)).toEqual(['a', 'b', 'c', 't']);
  });

  it('keeps the order of what is already right', () => {
    const given = [item('a', 'process'), item('b', 'process', 'a'), item('c', 'process', 'a')];
    expect(parentsFirst(given).map((i) => i.ref)).toEqual(['a', 'b', 'c']);
  });

  it('survives a loop and keeps every item', () => {
    const out = parentsFirst([item('a', 'process', 'b'), item('b', 'process', 'a'), item('s', 'process', 's')]);
    expect(out.map((i) => i.ref).sort()).toEqual(['a', 'b', 's']);
  });
});
