/**
 * Robert 1.23: what the worker does with suggestions before any card exists: the same suggestion
 * once, never again when it was proposed or created here, the caps per kind (D2), and never under a
 * card of the same answer.
 */
import {
  capSuggestions,
  planHomes,
  processOwner,
  SUGGESTION_CAPS,
  suggestionKey,
  withoutEarlierSuggestions,
} from './agent-run-worker.service';

const person = (said: string | null = null) => ({ said, participant: null, is_requester: false });
const i = (kind: string, over: Record<string, unknown> = {}) =>
  ({ ref: 'i1', kind, title: '', plan: 'Q4 Security', parent: { item: null, key: null, said: null }, space: null, assignee: person(), owner: person(), ...over }) as never;

describe('suggestionKey', () => {
  it('what makes two suggestions the same', () => {
    expect(suggestionKey(i('plan_risk', { title: ' Supplier  Delay ' }))).toBe(suggestionKey(i('plan_risk', { title: 'supplier delay' })));
    expect(suggestionKey(i('plan_risk', { title: 'A' }))).not.toBe(suggestionKey(i('plan_stakeholder', { title: 'A' })));
    // Two items are linked once, whichever way round.
    expect(suggestionKey(i('plan_dependency', { predecessor: { key: 'a-1', said: null }, successor: { key: 'A-2', said: null } }))).toBe(
      suggestionKey(i('plan_dependency', { predecessor: { key: 'A-2', said: null }, successor: { key: 'A-1', said: null } })),
    );
    expect(suggestionKey(i('plan_dates', { task: { key: 'a-3', said: null } }))).toBe('dates|A-3');
    expect(suggestionKey(i('plan_link', { task: { key: 'a-4', said: null } }))).toMatch(/^link\|/);
    expect(suggestionKey(i('task', { title: 'A' }))).toBeNull();
    expect(suggestionKey(i('plan_baseline', { title: '' }))).toBeNull();
  });
});

describe('withoutEarlierSuggestions (same request twice)', () => {
  it('leaves out what is in this answer twice and what was proposed or created here; links too (1.22.1 fix)', () => {
    const intents = [
      i('plan_risk', { title: 'Supplier delay' }),
      i('plan_risk', { title: 'supplier delay' }),
      i('plan_risk', { title: 'Budget cut' }),
      i('plan_link', { task: { key: 'A-9', said: null } }),
      i('task', { title: 'Supplier delay' }),
    ];
    const earlier = [{ match: suggestionKey(i('plan_risk', { title: 'Budget cut' })) as string }, { match: suggestionKey(i('plan_link', { task: { key: 'A-9', said: null } })) as string }, {}];
    const out = withoutEarlierSuggestions(intents, earlier);
    expect(out.dropped).toBe(3);
    expect(out.intents.map((x: { kind: string; title: string }) => `${x.kind}:${x.title}`)).toEqual(['plan_risk:Supplier delay', 'task:Supplier delay']);
  });
});

describe('capSuggestions (D2)', () => {
  it('at most 15 risks, 10 stakeholders, 30 dependencies, 50 dated items, one baseline; then the run cap', () => {
    expect(SUGGESTION_CAPS).toEqual({ plan_risk: 15, plan_stakeholder: 10, plan_dependency: 30, plan_dates: 50, plan_baseline: 1 });
    const many = [
      ...Array.from({ length: 20 }, () => ({ kind: 'plan_risk' })),
      ...Array.from({ length: 12 }, () => ({ kind: 'plan_stakeholder' })),
      { kind: 'plan_baseline' },
      { kind: 'plan_baseline' },
      { kind: 'task' },
    ];
    const out = capSuggestions(many, 50);
    expect(out.intents.filter((x) => x.kind === 'plan_risk')).toHaveLength(15);
    expect(out.intents.filter((x) => x.kind === 'plan_stakeholder')).toHaveLength(10);
    expect(out.intents.filter((x) => x.kind === 'plan_baseline')).toHaveLength(1);
    expect(out.cut).toBe(8);
    expect(capSuggestions(Array.from({ length: 60 }, () => ({ kind: 'plan_dates' })), 50)).toMatchObject({ cut: 10 });
  });
});

describe('homes and owners', () => {
  it('a suggestion never hangs under a plan or space of the same answer', () => {
    const homes = planHomes([
      i('space', { ref: 's1', title: 'New space' }),
      i('plan', { ref: 'p1', title: 'New' }),
      i('plan_risk', { ref: 'r1', title: 'X' }),
      i('plan_item', { ref: 'x1', plan: null }),
    ]);
    expect(homes.has('r1')).toBe(false);
    expect(homes.get('x1')).toBe('p1');
  });

  it('the owner of a risk and the person of a stakeholder come from owner', () => {
    expect(processOwner(i('plan_risk', { owner: person('Anna') }))).toMatchObject({ said: 'Anna' });
    expect(processOwner(i('plan_stakeholder', { owner: person('Ben') }))).toMatchObject({ said: 'Ben' });
  });
});
