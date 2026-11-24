import {
  reduceSlaEvent,
  projectCycle,
  SlaMetricTerms,
  SlaEvent,
} from './sla-engine';
const calendar = {
  timezone: 'UTC',
  weekly: Object.fromEntries(
    [0, 1, 2, 3, 4, 5, 6].map((d) => [
      d,
      [{ startMinute: 0, endMinute: 1440 }],
    ]),
  ),
  holidays: [],
};
const match = {
  combinator: 'and' as const,
  rules: [{ field: 'status', operator: '=', value: 'done' }],
};
const terms: SlaMetricTerms = {
  metric_id: 'm',
  revision_id: 'r',
  space_id: 's',
  enabled: true,
  config: {
    version: 1,
    cycle_mode: 'on_reopen',
    fulfillment: 'condition',
    start: null,
    pause: null,
    stop: match,
    goals: [
      { id: 'g', filter: null, target_ms: 1000, calendar_revision_id: 'c' },
    ],
  },
  calendars: { c: calendar },
  metadata: [{ id: 'status', type: 'string' }],
};
const event = (ms: number, status = 'open', before = 'open'): SlaEvent => ({
  task_id: 't',
  organization_id: 'o',
  kind: 'task_changed',
  effective_at: new Date(ms).toISOString(),
  before_snapshot: {
    status: before,
    is_completed: before === 'done',
    space_id: 's',
    scope_active: true,
  },
  after_snapshot: {
    status,
    is_completed: status === 'done',
    space_id: 's',
    scope_active: true,
  },
});
describe('SLA lifecycle', () => {
  it('enrolls at capture and exactly target is met', () => {
    let c = reduceSlaEvent([], event(1000), [terms]);
    c = reduceSlaEvent(c, event(2000, 'done'), [terms]);
    expect(c[0].lifecycle).toBe('completed');
    expect(c[0].elapsed_ms).toBe(1000);
    expect(c[0].outcome).toBe('met');
  });
  it('never manufactures already stopped zero success', () =>
    expect(reduceSlaEvent([], event(1000, 'done'), [terms])).toEqual([]));
  it('detects deadline without task edits', () => {
    const c = reduceSlaEvent([], event(1000), [terms])[0];
    expect(projectCycle(c, 2001).outcome).toBe('breached');
    expect(c.state.elapsed_ms).toBe(0);
  });
  it('reopens completed only, preserves history and frozen terms', () => {
    let c = reduceSlaEvent([], event(1000), [terms]);
    c = reduceSlaEvent(c, event(2000, 'done'), [{ ...terms, enabled: false }]);
    expect(c[0].lifecycle).toBe('completed');
    c = reduceSlaEvent(c, event(3000, 'open', 'done'), [terms]);
    expect(c).toHaveLength(2);
    expect(c[1].cycle_number).toBe(2);
  });
  it('cancels scope exit before stop', () => {
    const c = reduceSlaEvent([], event(1000), [terms]);
    const e = event(2000, 'done');
    e.after_snapshot.scope_active = false;
    expect(reduceSlaEvent(c, e, [terms])[0].lifecycle).toBe('cancelled');
  });
});
describe('SLA frozen conditions and replay', () => {
  it('excludes pauses, stop while paused wins', () => {
    const pause = {
      combinator: 'and' as const,
      rules: [{ field: 'status', operator: '=', value: 'paused' }],
    };
    const t = { ...terms, config: { ...terms.config, pause } };
    let c = reduceSlaEvent([], event(0), [t]);
    c = reduceSlaEvent(c, event(500, 'paused'), [t]);
    expect(c[0].state.paused).toBe(true);
    c = reduceSlaEvent(c, event(5000, 'done', 'paused'), [t]);
    expect(c[0].elapsed_ms).toBe(500);
    expect(c[0].outcome).toBe('met');
  });
  it('resumes and keeps original target after revision changes', () => {
    const pause = {
      combinator: 'and' as const,
      rules: [{ field: 'status', operator: '=', value: 'paused' }],
    };
    const t = { ...terms, config: { ...terms.config, pause } };
    let c = reduceSlaEvent([], event(0), [t]);
    c = reduceSlaEvent(c, event(500, 'paused'), [t]);
    c = reduceSlaEvent(c, event(5000), [{ ...t, revision_id: 'new' }]);
    c = reduceSlaEvent(c, event(5501, 'done'), [t]);
    expect(c[0].elapsed_ms).toBe(1001);
    expect(c[0].outcome).toBe('breached');
    expect(c[0].metric_revision_id).toBe('r');
  });
  it('disabled prevents enrollment but scope reentry after cancellation works', () => {
    expect(
      reduceSlaEvent([], event(0), [{ ...terms, enabled: false }]),
    ).toEqual([]);
    let c = reduceSlaEvent([], event(0), [terms]);
    const e = event(100);
    e.after_snapshot.scope_active = false;
    c = reduceSlaEvent(c, e, [terms]);
    c = reduceSlaEvent(c, event(200), [terms]);
    expect(c[1].lifecycle).toBe('active');
  });
  it('missing request stays not applicable and publication cannot create zero cycle', () => {
    const t = {
      ...terms,
      config: {
        ...terms.config,
        fulfillment: 'customer_reply' as const,
        cycle_mode: 'once' as const,
        stop: null,
      },
    };
    let c = reduceSlaEvent([], event(0), [t]);
    expect(c[0].lifecycle).toBe('not_applicable');
    c = reduceSlaEvent(c, event(100), [t]);
    expect(c).toHaveLength(1);
    const e = event(200);
    e.after_snapshot.request_id = 'req';
    c = reduceSlaEvent(c, e, [t]);
    expect(c[1].lifecycle).toBe('active');
    const reply = { ...event(400), kind: 'customer_reply_published' };
    reply.after_snapshot.request_id = 'req';
    reply.after_snapshot.reply_evidence_id = 'evidence';
    c = reduceSlaEvent(c, reply, [t]);
    expect(c[1].lifecycle).toBe('completed');
    expect(reduceSlaEvent(c, event(500), [t])).toHaveLength(2);
    expect(reduceSlaEvent([], reply, [t])).toHaveLength(0);
  });
  it('invalid config and timestamps fail closed', () => {
    expect(() =>
      reduceSlaEvent([], { ...event(0), effective_at: 'invalid' }, [terms]),
    ).toThrow();
    expect(
      reduceSlaEvent([], event(0), [{ ...terms, calendars: {} }])[0],
    ).toMatchObject({
      lifecycle: 'invalid',
      outcome: null,
      state: { error: 'SLA calendar revision is missing' },
    });
  });
  it('does not reenroll ordinary edits after completion', () => {
    let c = reduceSlaEvent([], event(0), [terms]);
    c = reduceSlaEvent(c, event(100, 'done'), [terms]);
    expect(reduceSlaEvent(c, event(200), [terms])).toHaveLength(1);
  });
});
describe('SLA cached projection', () => {
  it('keeps exact deadline fixed beyond breach and subsequent edits', () => {
    let c = reduceSlaEvent([], event(0), [terms]);
    expect(c[0].deadline_at).toBe(new Date(1000).toISOString());
    c = [projectCycle(c[0], 2000)];
    expect(c[0].deadline_at).toBe(new Date(1000).toISOString());
    c = reduceSlaEvent(c, event(3000), [terms]);
    expect(projectCycle(c[0], 4000).deadline_at).toBe(
      new Date(1000).toISOString(),
    );
  });
  it('does not reuse projected future elapsed for older captured pause', () => {
    let c = reduceSlaEvent([], event(0), [terms]);
    c = [projectCycle(c[0], 5000)];
    c = reduceSlaEvent(c, event(500, 'done'), [terms]);
    expect(c[0].elapsed_ms).toBe(500);
    expect(c[0].outcome).toBe('met');
  });
  it('resumes bounded deadline horizon search', () => {
    const far = {
      ...terms,
      config: {
        ...terms.config,
        goals: [{ ...terms.config.goals[0], target_ms: 400 * 86400000 }],
      },
    };
    let c = reduceSlaEvent([], event(0), [far])[0];
    expect(c.state.deadline_pending).toBe(true);
    expect(c.state.deadline_search_at).toBe(366 * 86400000);
    c = projectCycle(c, 1000);
    expect(c.state.deadline_pending).toBe(false);
    expect(c.deadline_at).toBe(new Date(400 * 86400000).toISOString());
  });
  it('deletion cancels without poisoning stream', () => {
    const c = reduceSlaEvent([], event(0), [terms]);
    expect(
      reduceSlaEvent(c, { ...event(100), after_snapshot: null as any }, [
        terms,
      ])[0].lifecycle,
    ).toBe('cancelled');
  });
});
describe('SLA broken references', () => {
  it('does not let missing custom field satisfy an is-null predicate', () => {
    const t = {
      ...terms,
      metadata: [...terms.metadata, { id: 'cf_abc', type: 'string' as const }],
      config: {
        ...terms.config,
        start: {
          combinator: 'and' as const,
          rules: [{ field: 'cf_abc', operator: 'null' }],
        },
      },
    };
    expect(reduceSlaEvent([], event(0), [t])[0]).toMatchObject({
      lifecycle: 'invalid',
      outcome: null,
      state: { error: 'SLA condition references an unavailable custom field' },
    });
    const e = event(0);
    e.after_snapshot.cf_abc = null;
    expect(reduceSlaEvent([], e, [t])[0].lifecycle).toBe('active');
  });
});

describe('independent metric errors', () => {
  it('isolates invalid goal calendar while healthy metric enrolls and completes', () => {
    const invalid = { ...terms, metric_id: 'bad', calendars: {} };
    let c = reduceSlaEvent([], event(0), [invalid, terms]);
    expect(c.find((c) => c.metric_id === 'bad')?.lifecycle).toBe('invalid');
    expect(c.find((c) => c.metric_id === 'm')?.lifecycle).toBe('active');
    c = reduceSlaEvent(c, { ...event(500, 'done'), id: 'stop' }, [
      invalid,
      terms,
    ]);
    expect(c.find((c) => c.metric_id === 'm')?.outcome).toBe('met');
    expect(c.filter((c) => c.metric_id === 'bad')).toHaveLength(1);
  });
  it('invalid stop rule does not suppress healthy customer reply fulfillment', () => {
    const reply = {
      ...terms,
      metric_id: 'reply',
      config: {
        ...terms.config,
        fulfillment: 'customer_reply' as const,
        stop: null,
      },
    };
    const opened = event(0);
    opened.after_snapshot.request_id = 'req';
    let c = reduceSlaEvent([], opened, [terms, reply]);
    c = c.map((c) =>
      c.metric_id === 'm'
        ? {
            ...c,
            state: {
              ...c.state,
              terms: {
                ...c.state.terms,
                config: {
                  ...c.state.terms.config,
                  stop: {
                    combinator: 'and',
                    rules: [
                      { field: 'unsupported', operator: '=', value: 'x' },
                    ],
                  },
                },
              },
            },
          }
        : c,
    );
    const publication = {
      ...event(500),
      id: 'publication',
      kind: 'customer_reply_published',
    };
    publication.after_snapshot.reply_evidence_id = 'evidence';
    publication.after_snapshot.request_id = 'req';
    c = reduceSlaEvent(c, publication, [terms, reply]);
    expect(c.find((c) => c.metric_id === 'm')).toMatchObject({
      lifecycle: 'invalid',
      outcome: null,
      state: { error_event_id: 'publication' },
    });
    expect(c.find((c) => c.metric_id === 'reply')).toMatchObject({
      lifecycle: 'completed',
      outcome: 'met',
    });
  });
});

describe('request unlink lifecycle', () => {
  it.each([false, true])(
    'cancels lost requester linkage paused=%j and allows fresh link',
    (paused) => {
      const reply = {
        ...terms,
        config: {
          ...terms.config,
          fulfillment: 'customer_reply' as const,
          cycle_mode: 'once' as const,
          stop: null,
          pause: paused
            ? {
                combinator: 'and' as const,
                rules: [{ field: 'status', operator: '=', value: 'open' }],
              }
            : null,
        },
      };
      const linked = event(0);
      linked.after_snapshot.request_id = 'req';
      let cycles = reduceSlaEvent([], linked, [reply]);
      cycles = reduceSlaEvent(
        cycles,
        { ...event(500), kind: 'request_unlinked' },
        [reply],
      );
      expect(cycles[0]).toMatchObject({
        lifecycle: 'cancelled',
        outcome: null,
        state: { not_applicable_reason: 'request_unlinked' },
      });
      const relink = event(1000);
      relink.after_snapshot.request_id = 'req';
      cycles = reduceSlaEvent(cycles, relink, [reply]);
      expect(cycles[1]).toMatchObject({
        lifecycle: 'active',
        started_at: relink.effective_at,
      });
    },
  );
});
