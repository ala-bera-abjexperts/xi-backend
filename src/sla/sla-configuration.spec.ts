import {
  buildSlaFieldMetadata,
  validateMetricConfiguration,
  SlaConfigurationService,
} from './sla-configuration.service';
const empty = { combinator: 'and', rules: [] };
const config = {
  cycle_mode: 'on_reopen',
  fulfillment: 'condition',
  start: null,
  pause: null,
  stop: {
    combinator: 'and',
    rules: [{ field: 'status', operator: '=', value: 'done' }],
  },
  goals: [
    { id: 'g', filter: null, target_ms: 3600000, calendar_revision_id: 'c' },
  ],
};
describe('SLA configuration', () => {
  it('freezes resolved deterministic metadata and validates goal references', () => {
    const metadata = buildSlaFieldMetadata([
      { id: 'x', field_type: 'number' },
      { id: 'y', field_type: 'sla_time' },
    ]);
    expect(metadata.some((f) => f.id === 'cf_y')).toBe(false);
    const result = validateMetricConfiguration(
      config,
      metadata,
      new Set(['c']),
    );
    expect(result.field_metadata).toEqual(metadata);
    expect(() =>
      validateMetricConfiguration(
        {
          ...config,
          goals: [{ ...config.goals[0], calendar_revision_id: 'outside' }],
        },
        metadata,
        new Set(['c']),
      ),
    ).toThrow();
  });
  it('rejects invalid filters, durations, and recursive or injected metadata', () => {
    for (const patch of [
      {
        start: {
          combinator: 'and',
          rules: [{ field: 'current_user', operator: '=', value: 'x' }],
        },
      },
      { goals: [{ ...config.goals[0], target_ms: 0 }] },
      { field_metadata: [] },
      { fulfillment: 'other' },
    ])
      expect(() =>
        validateMetricConfiguration(
          { ...config, ...patch },
          buildSlaFieldMetadata([]),
          new Set(['c']),
        ),
      ).toThrow();
  });
  it('authorizes before exposing calendar data', async () => {
    const access = {
      authorizeSpace: jest.fn().mockRejectedValue(new Error('denied')),
    };
    const db = { getClient: jest.fn() };
    const service = new SlaConfigurationService(db as never, access as never);
    await expect(
      service.calendars({ organizationId: 'o' } as never, 's'),
    ).rejects.toThrow('denied');
    expect(db.getClient).not.toHaveBeenCalled();
  });
});

describe('SLA configuration persistence boundary', () => {
  const user = { organizationId: 'o' } as never;
  const field = {
    id: 'f',
    field_type: 'sla_time',
    scope: 'space',
    space_id: 's',
  };
  const metric = { id: 'm', current_revision_id: 'r', enabled: false };
  const calendar = {
    timezone: 'UTC',
    weekly: { 1: [{ startMinute: 480, endMinute: 1020 }] },
    holidays: [],
  };
  function mock(
    results: unknown[],
    rpcResult: unknown = {
      data: { id: 'c', current_revision_id: 'r' },
      error: null,
    },
  ) {
    const calls: string[] = [];
    const client = {
      from: jest.fn((table: string) => {
        calls.push(table);
        const result = results.shift();
        const chain: any = {
          then: (resolve: Function) =>
            Promise.resolve(result).then(resolve as never),
        };
        for (const key of [
          'returns',
          'select',
          'eq',
          'or',
          'order',
          'in',
          'update',
          'single',
          'maybeSingle',
        ])
          chain[key] = jest.fn(() => chain);
        return chain;
      }),
      rpc: jest.fn().mockResolvedValue(rpcResult),
    };
    const access = { authorizeSpace: jest.fn().mockResolvedValue(undefined) };
    return {
      service: new SlaConfigurationService(
        { getClient: () => client } as never,
        access as never,
      ),
      client,
      calls,
      access,
    };
  }
  const ok = (data: unknown) => ({ data, error: null });
  it('lists immutable calendar snapshots and updates with revision CAS', async () => {
    const list = mock([
      ok([{ id: 'c', current_revision_id: 'r' }]),
      ok([{ id: 'r', config: calendar }]),
    ]);
    expect(await list.service.calendars(user, 's')).toEqual([
      { id: 'c', current_revision_id: 'r', revision: 'r', config: calendar },
    ]);
    const save = mock([ok({ space_id: 's' })]);
    expect(
      (
        await save.service.saveCalendar(user, null, 'c', {
          name: 'Week',
          config: calendar,
          expected_revision: 'old',
        })
      ).revision,
    ).toBe('r');
    expect(save.client.rpc).toHaveBeenCalledWith(
      'sla_save_calendar',
      expect.objectContaining({
        p_calendar: 'c',
        p_expected_revision: 'old',
        p_org: 'o',
        p_space: 's',
      }),
    );
  });
  it('rejects stale changes and invalid calendars before writes', async () => {
    const stale = mock([], { data: null, error: { code: '40001' } });
    await expect(
      stale.service.saveCalendar(user, 's', null, {
        name: 'Week',
        config: calendar,
      }),
    ).rejects.toThrow('reload');
    for (const dto of [
      { name: '', config: calendar },
      { name: 'Week', config: {} },
    ]) {
      const m = mock([]);
      await expect(
        m.service.saveCalendar(user, 's', null, dto),
      ).rejects.toThrow();
      expect(m.client.rpc).not.toHaveBeenCalled();
    }
    await expect(
      mock([ok(null)]).service.saveCalendar(user, null, 'x', {
        name: 'Week',
        config: calendar,
      }),
    ).rejects.toThrow('not found');
  });
  it('saves frozen terms without activation and hides internal metadata from round trips', async () => {
    const m = mock([
      ok(field),
      ok([]),
      ok([{ id: 'c' }]),
      ok(field),
      ok(metric),
      ok({ config: { ...config, field_metadata: [] } }),
    ]);
    const result = await m.service.saveMetric(user, 'f', {
      config,
      expected_revision: 'old',
    });
    expect(result?.config).toEqual(config);
    expect(m.client.rpc).toHaveBeenCalledTimes(1);
    expect(m.client.rpc).toHaveBeenCalledWith(
      'sla_save_metric',
      expect.objectContaining({
        p_expected_revision: 'old',
        p_config: expect.objectContaining({
          field_metadata: expect.any(Array),
        }),
      }),
    );
  });
  it('activates explicitly, and disables without replacing frozen revisions', async () => {
    for (const enabled of [true, false]) {
      const results = [
        ok(field),
        ok(metric),
        ok({ config }),

        ok(field),
        ok({ ...metric, enabled }),
        ok({ config }),
      ];
      const m = mock(results);
      expect(
        (await m.service.setEnabled(user, 'f', enabled, 'r'))?.enabled,
      ).toBe(enabled);
      expect(m.client.rpc).toHaveBeenCalledWith('sla_set_metric_enabled', {
        p_metric_id: 'm',
        p_expected_revision: 'r',
        p_enabled: enabled,
      });
    }
  });
  it('rejects stale activation revisions without changing enabled state', async () => {
    const m = mock([ok(field), ok(metric), ok({ config })], {
      data: null,
      error: { code: '40001' },
    });
    await expect(
      m.service.setEnabled(user, 'f', true, 'stale'),
    ).rejects.toThrow('reload');
    expect(m.client.rpc).toHaveBeenCalledWith('sla_set_metric_enabled', {
      p_metric_id: 'm',
      p_expected_revision: 'stale',
      p_enabled: true,
    });
  });
  it('rejects missing fields and unsaved activation; surfaces storage failures', async () => {
    await expect(mock([ok(null)]).service.getMetric(user, 'f')).rejects.toThrow(
      'not found',
    );
    await expect(
      mock([ok(field), ok(null)]).service.setEnabled(user, 'f', true, 'r'),
    ).rejects.toThrow('Save');
    await expect(
      mock([{ error: { code: 'XX000' }, data: null }]).service.calendars(
        user,
        's',
      ),
    ).rejects.toThrow('Unable');
    await expect(
      mock([], { error: { code: '22023' } }).service.saveCalendar(
        user,
        's',
        null,
        { name: 'Week', config: calendar },
      ),
    ).rejects.toThrow('Invalid');
  });
  it('checks permissions before reference lookup and rejects malformed queries', async () => {
    const denied = mock([]);
    denied.access.authorizeSpace.mockRejectedValue(new Error('denied'));
    await expect(
      denied.service.ruleOptions(user, 's', 'status'),
    ).rejects.toThrow('denied');
    expect(denied.client.from).not.toHaveBeenCalled();
    await expect(
      mock([]).service.ruleOptions(user, 's', 'status', 'x'.repeat(201)),
    ).rejects.toThrow('Invalid');
    await expect(
      mock([]).service.ruleOptions(
        user,
        's',
        'status',
        '',
        Array.from({ length: 101 }, (_, i) => String(i)).join(','),
      ),
    ).rejects.toThrow('Too many');
    await expect(
      mock([ok([])]).service.ruleOptions(user, 's', 'board_id'),
    ).rejects.toThrow('Unsupported');
  });
  it('hydrates comma-containing choice values without splitting them', async () => {
    const m = mock([
      ok([
        {
          id: 'f',
          name: 'Team',
          field_type: 'select',
          contexts: ['task'],
          options: [{ value: 'Sales, Support', label: 'Customer team' }],
        },
      ]),
    ]);
    expect(
      await m.service.ruleOptions(
        user,
        's',
        'cf_f',
        'none',
        '["Sales, Support"]',
      ),
    ).toEqual({
      options: [{ name: 'Sales, Support', label: 'Customer team' }],
      hasMore: false,
    });
    await expect(
      mock([]).service.ruleOptions(user, 's', 'status', '', '[null]'),
    ).rejects.toThrow('Invalid');
    await expect(
      mock([]).service.ruleOptions(user, 's', 'status', '', '['),
    ).rejects.toThrow('Invalid');
  });
  it('requires task visibility and publication access before exposing request subjects', async () => {
    const m = mock([ok([])]);
    m.access.authorizeSpace
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('denied'));
    await expect(
      m.service.ruleOptions(user, 's', 'request_id'),
    ).rejects.toThrow('denied');
    expect(m.access.authorizeSpace).toHaveBeenNthCalledWith(
      2,
      user,
      'o',
      's',
      'view_tasks',
    );
    expect(m.access.authorizeSpace).toHaveBeenNthCalledWith(
      3,
      user,
      'o',
      's',
      'publish_customer_replies',
    );
    expect(m.calls).toEqual(['custom_fields']);
  });
  it('offers only task-compatible resolved fields and rejects cross-space goals', async () => {
    const m = mock([
      ok([
        { id: 'x', name: 'Amount', field_type: 'number', contexts: ['task'] },
        { id: 'y', field_type: 'text', contexts: ['wiki'] },
      ]),
    ]);
    const definitions = await m.service.ruleFields(user, 's');
    expect(definitions.find((f) => f.name === 'cf_x')?.label).toBe('Amount');
    expect(definitions.find((f) => f.name === 'priority')).toMatchObject({
      inputType: 'sla-reference',
      spaceId: 's',
    });
    expect(definitions.some((f) => f.name === 'cf_y')).toBe(false);
    await expect(
      mock([ok(field), ok([]), ok([])]).service.saveMetric(user, 'f', {
        config,
      }),
    ).rejects.toThrow('out-of-scope');
    expect(await mock([ok([])]).service.calendars(user, 's')).toEqual([]);
  });
});

describe('SLA field authoring contract', () => {
  it('does not advertise uncaptured board or sprint memberships', () => {
    const fields = buildSlaFieldMetadata([]).map((field) => field.id);
    expect(fields).not.toContain('board_id');
    expect(fields).not.toContain('sprint_id');
  });
});
