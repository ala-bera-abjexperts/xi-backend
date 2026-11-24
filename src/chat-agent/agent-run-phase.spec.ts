import { proposalPhase } from './agent-run-phase';
import type { AgentActionStatus } from './agent-runs.repository';

const a = (status: AgentActionStatus, confirmable = true) => ({
  status,
  confirmable,
});

describe('proposalPhase', () => {
  it.each([
    [
      'executing wins over everything',
      [a('executing'), a('proposed', false)],
      'executing',
    ],
    [
      'an open card that cannot be confirmed',
      [a('proposed'), a('proposed', false)],
      'needs_input',
    ],
    [
      'a failed card waiting for Retry counts as open',
      [a('executed'), a('failed', false)],
      'needs_input',
    ],
    ['open cards', [a('proposed'), a('cancelled')], 'proposed'],
    [
      'a retryable failure beside a created task',
      [a('executed'), a('failed')],
      'proposed',
    ],
    ['all created', [a('executed'), a('executed')], 'done'],
    ['created beside cancelled', [a('executed'), a('cancelled')], 'partial'],
    ['created beside expired', [a('executed'), a('expired')], 'partial'],
    ['all expired', [a('expired'), a('expired')], 'expired'],
    ['expired beside cancelled', [a('expired'), a('cancelled')], 'cancelled'],
    ['all cancelled', [a('cancelled')], 'cancelled'],
  ])('%s', (_name, actions, phase) => {
    expect(proposalPhase(actions)).toBe(phase);
  });

  describe('undo (1.21)', () => {
    const of = (...statuses: AgentActionStatus[]) =>
      proposalPhase(statuses.map((status) => ({ status, confirmable: true })));

    it('shows work in progress while an undo runs', () => {
      expect(of('executed', 'undoing')).toBe('executing');
    });
    it('is undone when nothing stayed, also beside a cancelled card', () => {
      expect(of('undone', 'undone')).toBe('undone');
      expect(of('undone', 'cancelled')).toBe('undone');
    });
    it('is partly undone when something stayed', () => {
      expect(of('undone', 'executed')).toBe('partly_undone');
    });
    it('a card still open wins', () => {
      expect(of('undone', 'proposed')).toBe('proposed');
    });
  });
});
