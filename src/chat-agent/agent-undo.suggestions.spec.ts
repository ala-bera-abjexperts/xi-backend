/**
 * Robert 1.23: Undo of a suggestion. Each kind is undoable; who may undo it is asked on its plan now
 * (edit; a baseline: the plan's admin level); only the suggestion's own row goes, in the database.
 */
import { AgentUndoRulesService, UNDOABLE_KINDS } from './agent-undo-rules.service';
import { AgentUndoService, deepestFirst } from './agent-undo.service';
import type { AgentActionRow } from './agent-runs.repository';

const user = { userId: 'me', organizationId: 'org-1' } as never;
const target = (kind: string, planId = 'plan-1') => ({ kind, entity_id: `e-${kind}`, resolved: { create: { planId } } });

describe('Undo of suggestions (1.23)', () => {
  const plan = { id: 'plan-1' };
  let plans: Record<string, jest.Mock>;
  let rules: AgentUndoRulesService;

  beforeEach(() => {
    plans = {
      planById: jest.fn((_u: unknown, id: string) => Promise.resolve(id === 'plan-1' ? plan : null)),
      canEdit: jest.fn().mockResolvedValue(true),
      canDelete: jest.fn().mockResolvedValue(false),
    };
    rules = new AgentUndoRulesService({ getClient: () => ({}) } as never, {} as never, undefined, plans as never);
  });

  it('every suggestion kind can be undone', () => {
    for (const k of ['plan_dependency', 'plan_dates', 'plan_risk', 'plan_stakeholder', 'plan_baseline']) expect(UNDOABLE_KINDS.has(k)).toBe(true);
  });

  it('edit rights on the plan now; a baseline needs the plan admin level, as a person deleting one', async () => {
    expect(await rules.mayDelete(user, target('plan_risk'))).toBe(true);
    expect(await rules.mayDelete(user, target('plan_dates'))).toBe(true);
    expect(await rules.mayDelete(user, target('plan_baseline'))).toBe(false);
    plans.canDelete.mockResolvedValue(true);
    expect(await rules.mayDelete(user, target('plan_baseline'))).toBe(true);
    plans.canEdit.mockResolvedValue(false);
    expect(await rules.mayDelete(user, target('plan_stakeholder'))).toBe(false);
    // The plan is gone: the blockers say so (gone), not the rights.
    expect(await rules.mayDelete(user, target('plan_risk', 'plan-gone'))).toBe(true);
    // A card without its plan is never undone blind.
    expect(await rules.mayDelete(user, { kind: 'plan_risk', entity_id: 'x' })).toBe(false);
  });

  it('only the suggestion goes, through its own database Undo; never a task Undo', async () => {
    const runs = {
      undoPlanSuggestion: jest.fn().mockResolvedValue({ deleted: true, blockers: [] }),
      undoTask: jest.fn(),
    };
    const service = new AgentUndoService({ getClient: () => ({}) } as never, runs as never, {} as never, {} as never, {} as never);
    for (const kind of ['plan_dependency', 'plan_dates', 'plan_risk', 'plan_stakeholder', 'plan_baseline'])
      await (service as unknown as { compensate: (u: unknown, a: unknown) => Promise<unknown> }).compensate(user, {
        kind,
        entity_id: `e-${kind}`,
        organization_id: 'org-1',
        executed_at: '2026-11-13T10:00:00Z',
        run_id: 'run-1',
      });
    expect(runs.undoTask).not.toHaveBeenCalled();
    expect(runs.undoPlanSuggestion.mock.calls.map((c) => [c[0].kind, c[0].entityId])).toEqual([
      ['plan_dependency', 'e-plan_dependency'],
      ['plan_dates', 'e-plan_dates'],
      ['plan_risk', 'e-plan_risk'],
      ['plan_stakeholder', 'e-plan_stakeholder'],
      ['plan_baseline', 'e-plan_baseline'],
    ]);
  });

  it('Undo all takes the baseline first, then dates, then dependencies (the reverse of Confirm)', () => {
    const a = (ordinal: number, kind: string) => ({ ordinal, kind, depends_on: null }) as unknown as AgentActionRow;
    const rows = [a(1, 'plan_risk'), a(2, 'plan_dependency'), a(3, 'plan_dates'), a(4, 'plan_baseline')];
    expect(deepestFirst(rows, rows).map((r) => r.kind)).toEqual(['plan_baseline', 'plan_dates', 'plan_dependency', 'plan_risk']);
  });
});
