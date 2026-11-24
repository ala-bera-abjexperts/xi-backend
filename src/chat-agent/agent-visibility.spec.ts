import {
  canViewRun,
  MAX_SHARED_RUN_MEMBERS,
  runVisibility,
} from './agent-visibility';

describe('runVisibility', () => {
  const base = {
    conversationKind: 'group' as const,
    isAgentDm: false,
    memberCount: 3,
    refused: false,
  };

  it('shares runs in space channels, DMs and the Robert chat, whatever the size', () => {
    expect(
      runVisibility({ ...base, conversationKind: 'space', memberCount: 900 }),
    ).toBe('conversation');
    expect(runVisibility({ ...base, conversationKind: 'dm' })).toBe(
      'conversation',
    );
    expect(
      runVisibility({ ...base, conversationKind: 'dm', isAgentDm: true }),
    ).toBe('conversation');
  });

  it('shares runs in a group of at most 50 members', () => {
    expect(
      runVisibility({ ...base, memberCount: MAX_SHARED_RUN_MEMBERS }),
    ).toBe('conversation');
  });

  it('keeps runs private in a larger group', () => {
    expect(
      runVisibility({ ...base, memberCount: MAX_SHARED_RUN_MEMBERS + 1 }),
    ).toBe('invoker');
  });

  it('keeps a refused run with its invoker everywhere', () => {
    for (const conversationKind of ['space', 'dm', 'group'] as const) {
      expect(runVisibility({ ...base, conversationKind, refused: true })).toBe(
        'invoker',
      );
    }
  });
});

describe('canViewRun', () => {
  const base = {
    viewerId: 'v',
    invokerId: 'i',
    visibility: 'conversation' as const,
    status: 'completed' as const,
    viewerCanRead: true,
    viewerHistoryFromSeq: 0,
    contextMinSeq: 10,
  };

  it('always gives the invoker the full view', () => {
    expect(
      canViewRun({
        ...base,
        viewerId: 'i',
        visibility: 'invoker',
        viewerCanRead: false,
        viewerHistoryFromSeq: 99,
      }),
    ).toBe('full');
    expect(canViewRun({ ...base, viewerId: 'i', status: 'refused' })).toBe(
      'full',
    );
  });

  it('gives a member who sees all context the full view of a shared run', () => {
    expect(canViewRun(base)).toBe('full');
    expect(canViewRun({ ...base, viewerHistoryFromSeq: 9 })).toBe('full');
    expect(canViewRun({ ...base, contextMinSeq: null })).toBe('full');
  });

  it('gives a "from now on" member the stub when the context reaches before their cut-off', () => {
    expect(canViewRun({ ...base, viewerHistoryFromSeq: 10 })).toBe('stub');
    expect(canViewRun({ ...base, viewerHistoryFromSeq: 50 })).toBe('stub');
  });

  it('gives others the stub of a private or still pending run', () => {
    expect(canViewRun({ ...base, visibility: 'invoker' })).toBe('stub');
    expect(canViewRun({ ...base, visibility: 'pending' })).toBe('stub');
  });

  it('shows a refused run to nobody but the invoker', () => {
    expect(canViewRun({ ...base, status: 'refused' })).toBe('none');
  });

  it('shows nothing to a viewer who cannot read the conversation', () => {
    expect(canViewRun({ ...base, viewerCanRead: false })).toBe('none');
  });

  it('never treats a missing invoker as a match', () => {
    expect(
      canViewRun({ ...base, invokerId: null, visibility: 'invoker' }),
    ).toBe('stub');
  });
});
