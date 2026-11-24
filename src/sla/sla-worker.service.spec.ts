import { SlaWorkerService } from './sla-worker.service';
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
const config = {
  version: 1,
  cycle_mode: 'once',
  fulfillment: 'condition',
  start: null,
  pause: {
    combinator: 'and',
    rules: [{ field: 'status', operator: '=', value: 'paused' }],
  },
  stop: {
    combinator: 'and',
    rules: [{ field: 'status', operator: '=', value: 'done' }],
  },
  goals: [
    { id: 'g', filter: null, target_ms: 1000, calendar_revision_id: 'c' },
  ],
  field_metadata: [{ id: 'status', type: 'string' }],
};
const e = (sequence: number, ms: number, status = 'open') => ({
  sequence,
  kind: 'task_changed',
  task_id: 't',
  organization_id: 'o',
  effective_at: new Date(ms).toISOString(),
  before_snapshot: {},
  after_snapshot: {
    space_id: 's',
    scope_active: true,
    is_completed: false,
    status,
  },
  metric_revisions: [{ metric_id: 'm', revision_id: 'r', enabled: true }],
});
function setup(events: any[] = []) {
  const tables: any = {
    sla_cycles: [],
    sla_task_events: events,
    sla_metric_revisions: [{ id: 'r', metric_id: 'm', space_id: 's', config }],
    sla_calendar_revisions: [{ id: 'c', config: calendar }],
    sla_metrics: [],
  };
  const chains: any = {};
  const client: any = {
    from: jest.fn((table: string) => {
      const q: any = {
        then: (resolve: any) =>
          Promise.resolve({ data: tables[table] ?? [], error: null }).then(
            resolve,
          ),
      };
      for (const method of [
        'select',
        'eq',
        'gt',
        'order',
        'limit',
        'in',
        'update',
        'range',
      ])
        q[method] = jest.fn().mockReturnValue(q);
      chains[table] = q;
      return q;
    }),
    rpc: jest.fn().mockResolvedValue({ data: true, error: null }),
  };
  return {
    worker: new SlaWorkerService({ getClient: () => client } as any),
    client,
    tables,
    chains,
  };
}
const stream = {
  task_id: 't',
  processed_sequence: 0,
  sequence: 3,
  lease_token: 'lease',
};
describe('durable SLA worker', () => {
  it('replays pause/completion in sequence and atomically checkpoints once', async () => {
    const { worker, client } = setup([
      e(1, 0),
      e(2, 500, 'paused'),
      e(3, 5000, 'done'),
    ]);
    await worker.processStream(stream);
    const [name, args] = client.rpc.mock.calls.at(-1);
    expect(name).toBe('sla_commit_stream');
    expect(args.p_expected_sequence).toBe(0);
    expect(args.p_processed_sequence).toBe(3);
    expect(args.p_token).toBe('lease');
    expect(args.p_cycles[0]).toMatchObject({
      lifecycle: 'completed',
      elapsed_ms: 500,
      outcome: 'met',
    });
  });
  it('refuses out of order/gapped streams without checkpoint', async () => {
    const { worker, client } = setup([e(2, 0)]);
    await expect(worker.processStream(stream)).rejects.toThrow('sequence gap');
    expect(client.rpc).not.toHaveBeenCalled();
  });
  it('CAS failure leaves replay retryable', async () => {
    const { worker, client } = setup([e(1, 0)]);
    client.rpc.mockResolvedValue({ data: false, error: null });
    await expect(worker.processStream(stream)).rejects.toThrow('lease changed');
  });
  it('deadline tick projects frozen checkpoint without double counting', async () => {
    const { worker, client, tables } = setup([e(1, 0)]);
    const time = jest.spyOn(Date, 'now').mockReturnValue(2000);
    await worker.processStream(stream);
    tables.sla_cycles = client.rpc.mock.calls.at(-1)[1].p_cycles;
    tables.sla_task_events = [];
    await worker.processStream({ ...stream, processed_sequence: 1 });
    const cycle = client.rpc.mock.calls.at(-1)[1].p_cycles[0];
    expect(cycle.elapsed_ms).toBe(2000);
    expect(cycle.state.elapsed_ms).toBe(0);
    expect(cycle.outcome).toBe('breached');
    time.mockRestore();
  });
  it('missing immutable revision refuses progress', async () => {
    const { worker, tables } = setup([e(1, 0)]);
    tables.sla_metric_revisions = [];
    tables.sla_metrics = [{ id: 'm' }];
    await expect(worker.processStream(stream)).rejects.toThrow(
      'revision is missing',
    );
  });
  it('tick resumes activation and publishes visible processing error', async () => {
    const { worker, client, tables, chains } = setup([e(2, 0)]);
    tables.sla_metrics = [{ id: 'm' }];
    client.rpc.mockImplementation(async (name: string) => ({
      data: name === 'sla_claim_streams' ? [stream] : true,
      error: null,
    }));
    await worker.tick();
    expect(client.rpc).toHaveBeenCalledWith('sla_recover_workflows');
    expect(client.rpc).toHaveBeenCalledWith('sla_resume_metric_activation', {
      p_metric_id: 'm',
      p_batch_size: 500,
    });
    expect(chains.sla_task_streams.update).toHaveBeenCalledWith(
      expect.objectContaining({ processing_error: 'SLA event sequence gap' }),
    );
  });
  it('skips a tick that overlaps one still in flight', async () => {
    const { worker, client } = setup();
    client.rpc.mockResolvedValue({ data: [], error: null });
    let release: (v: unknown) => void = () => {};
    client.rpc.mockReturnValueOnce(
      new Promise((res) => {
        release = res;
      }),
    );
    const first = worker.tick();
    await worker.tick();
    expect(client.rpc).toHaveBeenCalledTimes(1);
    release({ data: [], error: null });
    await first;
    // guard released — the next tick runs
    const calls = client.rpc.mock.calls.length;
    await worker.tick();
    expect(client.rpc.mock.calls.length).toBeGreaterThan(calls);
  });
  it('claim errors do not process', async () => {
    const { worker, client } = setup();
    client.rpc.mockResolvedValue({ error: { message: 'offline' } });
    await worker.tick();
    expect(client.rpc).not.toHaveBeenCalledWith(
      'sla_commit_stream',
      expect.anything(),
    );
  });
});

describe('SLA deleted reference recovery', () => {
  it('surfaces deleted frozen field references even without a new task edit', async () => {
    const { worker, client, tables } = setup([e(1, 0)]);
    await worker.processStream(stream);
    const cycle = client.rpc.mock.calls.at(-1)[1].p_cycles[0];
    cycle.state.terms.config = {
      ...cycle.state.terms.config,
      start: {
        combinator: 'and',
        rules: [{ field: 'cf_abc', operator: 'null' }],
      },
    };
    tables.sla_cycles = [cycle];
    tables.sla_task_events = [];
    tables.custom_fields = [{ id: 'abc', is_deleted: true }];
    await worker.processStream({ ...stream, processed_sequence: 1 });
    expect(client.rpc.mock.calls.at(-1)[1].p_cycles[0]).toMatchObject({
      lifecycle: 'invalid',
      outcome: null,
      state: { error: 'SLA condition references a deleted custom field' },
    });
    tables.custom_fields = [{ id: 'abc', is_deleted: false }];
    await expect(
      worker.processStream({ ...stream, processed_sequence: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe('independent worker metrics', () => {
  it('commits healthy deadline breach while marking deleted-reference metric invalid', async () => {
    const { worker, client, tables } = setup([e(1, 0)]);
    await worker.processStream(stream);
    const healthy = client.rpc.mock.calls.at(-1)[1].p_cycles[0];
    const bad = {
      ...healthy,
      id: 'bad-cycle',
      metric_id: 'bad',
      state: {
        ...healthy.state,
        terms: {
          ...healthy.state.terms,
          metric_id: 'bad',
          config: {
            ...healthy.state.terms.config,
            start: {
              combinator: 'and',
              rules: [{ field: 'cf_abc', operator: 'null' }],
            },
          },
        },
      },
    };
    tables.sla_cycles = [bad, healthy];
    tables.sla_task_events = [];
    tables.custom_fields = [];
    const time = jest.spyOn(Date, 'now').mockReturnValue(2000);
    await worker.processStream({ ...stream, processed_sequence: 1 });
    time.mockRestore();
    const saved = client.rpc.mock.calls.at(-1)[1];
    expect(saved.p_processed_sequence).toBe(1);
    expect(saved.p_cycles.find((c) => c.metric_id === 'bad')).toMatchObject({
      lifecycle: 'invalid',
      outcome: null,
    });
    expect(saved.p_cycles.find((c) => c.metric_id === 'm')).toMatchObject({
      lifecycle: 'active',
      outcome: 'breached',
    });
  });
});

describe('retained task after old metric deletion', () => {
  it('skips only verified absent metric and processes healthy references', async () => {
    const captured = e(1, 0);
    captured.metric_revisions = [
      { metric_id: 'deleted', revision_id: 'deleted-revision', enabled: true },
      ...captured.metric_revisions,
    ];
    const { worker, client, tables } = setup([captured]);
    tables.sla_metrics = [{ id: 'm' }];
    await worker.processStream(stream);
    const committed = client.rpc.mock.calls.at(-1)[1];
    expect(committed.p_processed_sequence).toBe(1);
    expect(committed.p_cycles).toHaveLength(1);
    expect(committed.p_cycles[0]).toMatchObject({
      metric_id: 'm',
      lifecycle: 'active',
    });
  });
  it('cancels an existing old-space cycle while healthy new metric enrolls', async () => {
    const { worker, client, tables } = setup([e(1, 0)]);
    await worker.processStream(stream);
    const old = client.rpc.mock.calls.at(-1)[1].p_cycles[0];
    tables.sla_cycles = [
      {
        ...old,
        space_id: 'old',
        metric_id: 'deleted',
        state: {
          ...old.state,
          terms: { ...old.state.terms, space_id: 'old', metric_id: 'deleted' },
        },
      },
    ];
    const moved = e(2, 500);
    moved.metric_revisions = [
      { metric_id: 'deleted', revision_id: 'deleted-revision', enabled: false },
      ...moved.metric_revisions,
    ];
    tables.sla_task_events = [moved];
    tables.sla_metrics = [{ id: 'm' }];
    await worker.processStream({ ...stream, processed_sequence: 1 });
    const cycles = client.rpc.mock.calls.at(-1)[1].p_cycles;
    expect(cycles.find((c) => c.metric_id === 'deleted').lifecycle).toBe(
      'cancelled',
    );
    expect(cycles.find((c) => c.metric_id === 'm').lifecycle).toBe('active');
  });
});
describe('missing revision lookup failure', () => {
  it('does not mistake a failed metric read for retention deletion', async () => {
    const { worker, client, tables } = setup([e(1, 0)]);
    tables.sla_metric_revisions = [];
    const original = client.from.getMockImplementation();
    client.from.mockImplementation((table: string) => {
      const query = original(table);
      if (table === 'sla_metrics')
        query.then = (resolve: any) =>
          Promise.resolve({ data: null, error: { message: 'offline' } }).then(
            resolve,
          );
      return query;
    });
    await expect(worker.processStream(stream)).rejects.toThrow(
      'Unable to verify missing SLA metric revisions',
    );
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
