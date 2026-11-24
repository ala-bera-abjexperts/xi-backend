import { SlaResultsService } from './sla-results.service';
const user: any = { userId: 'u', organizationId: 'o' };
function setup() {
  const tables: any = {
    sla_metrics: [
      { id: 'm', field_id: 'f', custom_fields: { name: 'First response' } },
    ],
    sla_task_streams: { sequence: 0, processed_sequence: 0 },
    sla_cycles: [],
  };
  const errors: any = {};
  const client: any = {
    from: (table: string) => {
      const q: any = {
        then: (resolve: any) =>
          Promise.resolve({ data: tables[table], error: errors[table] }).then(
            resolve,
          ),
      };
      for (const method of [
        'select',
        'in',
        'eq',
        'order',
        'limit',
        'range',
        'maybeSingle',
      ])
        q[method] = jest.fn().mockReturnValue(q);
      return q;
    },
  };
  const access: any = {
    authorizeTask: jest
      .fn()
      .mockResolvedValue({ organization_id: 'o', space_id: 's' }),
  };
  return {
    service: new SlaResultsService({ getClient: () => client } as any, access),
    tables,
    errors,
    access,
  };
}
const completed: any = {
  id: 'c',
  metric_id: 'm',
  cycle_number: 1,
  lifecycle: 'completed',
  outcome: 'met',
  target_ms: 1000,
  elapsed_ms: 500,
  deadline_at: null,
  started_at: new Date(0).toISOString(),
  completed_at: new Date(500).toISOString(),
  updated_at: new Date(500).toISOString(),
  state: { error: null, paused: false, calendar: null },
};
describe('SLA result visibility and states', () => {
  it('empty result is not applicable, batch deduplicates task IDs', async () => {
    const { service, access } = setup();
    const result = await service.batch(user, ['t', 't']);
    expect(result.t[0]).toMatchObject({
      field_id: 'f',
      lifecycle: 'not_applicable',
      outcome: 'pending',
    });
    expect(access.authorizeTask).toHaveBeenCalledTimes(1);
  });
  it('completed result preserves independent outcome and duration', async () => {
    const { service, tables } = setup();
    tables.sla_cycles = [completed];
    expect((await service.task(user, 't'))[0]).toMatchObject({
      lifecycle: 'completed',
      outcome: 'met',
      elapsed_ms: 500,
      remaining_ms: 500,
      cycle_id: 'c',
    });
  });
  it('processing errors are visibly invalid and pending', async () => {
    const { service, tables } = setup();
    tables.sla_task_streams = {
      sequence: 2,
      processed_sequence: 1,
      processing_error: 'Invalid rule',
    };
    const result = (await service.task(user, 't'))[0];
    expect(result).toMatchObject({
      lifecycle: 'invalid',
      error: 'Invalid rule',
      pending: true,
    });
  });
  it('inaccessible tasks never query result data', async () => {
    const { service, access } = setup();
    access.authorizeTask.mockRejectedValue(new Error('denied'));
    await expect(service.task(user, 't')).rejects.toThrow('denied');
  });
  it('database errors do not become empty success', async () => {
    const { service, errors } = setup();
    errors.sla_metrics = { message: 'offline' };
    await expect(service.task(user, 't')).rejects.toThrow('unavailable');
    delete errors.sla_metrics;
    errors.sla_task_streams = { message: 'offline' };
    await expect(service.task(user, 't')).rejects.toThrow('unavailable');
    delete errors.sla_task_streams;
    errors.sla_cycles = { message: 'offline' };
    await expect(service.task(user, 't')).rejects.toThrow('unavailable');
  });
  it('history includes completion timestamps without generic truncation', async () => {
    const { service, tables } = setup();
    tables.sla_cycles = [completed];
    expect((await service.history(user, 't'))[0]).toMatchObject({
      completed_at: completed.completed_at,
      field_id: 'f',
    });
  });
});

describe('SLA public result contract', () => {
  it.each([false, true])(
    'maps active lifecycle and signed overdue duration paused=%j',
    async (paused) => {
      const { service, tables } = setup();
      tables.sla_cycles = [
        {
          ...completed,
          lifecycle: 'active',
          outcome: 'breached',
          elapsed_ms: 1500,
          state: {
            ...completed.state,
            paused,
            elapsed_ms: 1500,
            running_since: null,
          },
        },
      ];
      expect((await service.task(user, 't'))[0]).toMatchObject({
        lifecycle: paused ? 'paused' : 'running',
        outcome: 'breached',
        remaining_ms: -500,
        field_name: 'First response',
      });
    },
  );
  it('returns pending outcome independently of running lifecycle', async () => {
    const { service, tables } = setup();
    tables.sla_cycles = [
      {
        ...completed,
        lifecycle: 'active',
        outcome: null,
        state: { ...completed.state, elapsed_ms: 500, running_since: null },
      },
    ];
    expect((await service.task(user, 't'))[0]).toMatchObject({
      lifecycle: 'running',
      outcome: 'pending',
    });
  });
  it('resolves metric and selected calendar names with history', async () => {
    const { service, tables } = setup();
    tables.sla_cycles = [
      {
        ...completed,
        state: {
          ...completed.state,
          goal_id: 'g',
          terms: {
            config: { goals: [{ id: 'g', calendar_revision_id: 'r' }] },
          },
        },
      },
    ];
    tables.sla_calendar_revisions = [
      { id: 'r', sla_calendars: { name: 'Support hours' } },
    ];
    expect((await service.history(user, 't'))[0]).toMatchObject({
      field_name: 'First response',
      calendar_name: 'Support hours',
    });
  });
});
