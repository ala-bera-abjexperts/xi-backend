import {
  loadSlaRuleOptions,
  parseTicketNumberSearch,
} from './sla-rule-options';

function client(results: unknown[]) {
  const chains: any[] = [];
  const db = {
    from: jest.fn(() => {
      const result = results.shift();
      const chain: any = {
        then: (resolve: any) => Promise.resolve(result).then(resolve),
      };
      for (const method of [
        'select',
        'eq',
        'or',
        'in',
        'ilike',
        'order',
        'limit',
        'maybeSingle',
      ])
        chain[method] = jest.fn(() => chain);
      chains.push(chain);
      return chain;
    }),
  };
  return { db: db as never, chains };
}
const ok = (data: unknown) => ({ data, error: null });

describe('SLA reference choices', () => {
  it('accepts exact bigint ticket searches and excludes overflow and arbitrary expressions', () => {
    expect(parseTicketNumberSearch('# 00042')).toBe('42');
    expect(parseTicketNumberSearch('9223372036854775807')).toBe(
      '9223372036854775807',
    );
    expect(parseTicketNumberSearch('9223372036854775808')).toBeNull();
    expect(parseTicketNumberSearch('12%')).toBeNull();
  });

  it('scopes status choices and hydrates selected values outside search', async () => {
    const m = client([
      ok([{ id: 'a', key: 'open', name: 'Open' }]),
      ok([
        {
          id: '00000000-0000-4000-8000-000000000001',
          key: 'done',
          name: 'Done',
        },
      ]),
    ]);
    const result = await loadSlaRuleOptions(
      m.db,
      'o',
      's',
      'status_id',
      [],
      'Op%',
      ['00000000-0000-4000-8000-000000000001', 'foreign'],
    );
    expect(result).toEqual({
      options: [
        { name: 'a', label: 'Open' },
        { name: '00000000-0000-4000-8000-000000000001', label: 'Done' },
        { name: 'foreign', label: 'Unavailable selection', unavailable: true },
      ],
      hasMore: false,
    });
    expect(m.chains[0].eq).toHaveBeenCalledWith('organization_id', 'o');
    expect(m.chains[0].or).toHaveBeenCalledWith(
      'space_id.is.null,space_id.eq.s',
    );
    expect(m.chains[0].ilike).toHaveBeenCalledWith('name', '%Op\\%%');
    expect(m.chains[1].in).toHaveBeenCalledWith('id', [
      '00000000-0000-4000-8000-000000000001',
    ]);
  });
  it('reports overflow and never pretends a truncated set is complete', async () => {
    const m = client([
      ok(
        Array.from({ length: 51 }, (_, i) => ({
          id: String(i),
          key: String(i),
          name: `Priority ${i}`,
        })),
      ),
    ]);
    const result = await loadSlaRuleOptions(
      m.db,
      'o',
      's',
      'priority',
      [],
      '',
      [],
    );
    expect(result.options).toHaveLength(50);
    expect(result.hasMore).toBe(true);
    expect(m.chains[0].limit).toHaveBeenCalledWith(51);
  });
  it('preserves custom option values and stale selections', async () => {
    const m = client([]);
    expect(
      await loadSlaRuleOptions(
        m.db,
        'o',
        's',
        'cf_f',
        [
          {
            id: 'f',
            field_type: 'select',
            options: [{ value: 'gold', label: 'Gold support' }],
          },
        ],
        'gold',
        ['deleted'],
      ),
    ).toEqual({
      options: [
        { name: 'gold', label: 'Gold support' },
        { name: 'deleted', label: 'Unavailable selection', unavailable: true },
      ],
      hasMore: false,
    });
  });
  it('limits users to organization membership and searches names and email', async () => {
    const m = client([
      ok([
        {
          users: {
            id: 'person',
            first_name: 'Priya',
            last_name: 'Shah',
            email: 'priya@example.test',
          },
        },
      ]),
      ok([]),
      ok([]),
    ]);
    expect(
      (await loadSlaRuleOptions(m.db, 'o', 's', 'assigned_to', [], 'Priya', []))
        .options,
    ).toEqual([{ name: 'person', label: 'Priya Shah (priya@example.test)' }]);
    for (const chain of m.chains)
      expect(chain.eq).toHaveBeenCalledWith('organization_id', 'o');
    expect(m.chains[0].ilike).toHaveBeenCalledWith(
      'users.first_name',
      '%Priya%',
    );
    expect(m.chains[2].ilike).toHaveBeenCalledWith('users.email', '%Priya%');
  });
  it('searches task keys and summaries within the requested space', async () => {
    const m = client([
      ok([{ id: 't', key: 'CS-T1', summary: 'Printer unavailable' }]),
      ok([]),
    ]);
    expect(
      (
        await loadSlaRuleOptions(
          m.db,
          'o',
          's',
          'parent_task_id',
          [],
          'Printer',
          [],
        )
      ).options,
    ).toEqual([{ name: 't', label: 'CS-T1: Printer unavailable' }]);
    for (const chain of m.chains) {
      expect(chain.eq).toHaveBeenCalledWith('space_id', 's');
      expect(chain.eq).toHaveBeenCalledWith('is_archived', false);
    }
  });
  it('returns ticket labels and filters by owning tenant and space', async () => {
    const m = client([
      ok([{ id: 'r', ticket_number: 'SUP-1', subject: 'Access issue' }]),
    ]);
    expect(
      (await loadSlaRuleOptions(m.db, 'o', 's', 'request_id', [], '', []))
        .options,
    ).toEqual([{ name: 'r', label: 'SUP-1: Access issue' }]);
    expect(m.chains[0].eq).toHaveBeenCalledWith('space_id', 's');
    expect(m.chains[0].eq).toHaveBeenCalledWith('organization_id', 'o');
  });
  it('uses bigint equality for request ticket numbers and subject-only textual search', async () => {
    const m = client([
      ok([{ id: 'r', ticket_number: 42, subject: 'Access issue' }]),
      ok([]),
    ]);
    expect(
      (await loadSlaRuleOptions(m.db, 'o', 's', 'request_id', [], '#42', []))
        .options,
    ).toEqual([{ name: 'r', label: '42: Access issue' }]);
    expect(m.chains[0].eq).toHaveBeenCalledWith('ticket_number', '42');
    for (const chain of m.chains)
      expect(chain.ilike).not.toHaveBeenCalledWith(
        'ticket_number',
        expect.anything(),
      );
    const text = client([ok([])]);
    await loadSlaRuleOptions(text.db, 'o', 's', 'request_id', [], 'Access', []);
    expect(text.chains).toHaveLength(1);
    expect(text.chains[0].ilike).toHaveBeenCalledWith('subject', '%Access%');
  });
  it('uses configured task types and built-in defaults for unconfigured spaces', async () => {
    const configured = client([
      ok({
        config: {
          levels: [
            { id: 'incident', name: 'Incident' },
            { id: 'old', name: 'Old', is_active: false },
          ],
        },
      }),
    ]);
    expect(
      (
        await loadSlaRuleOptions(
          configured.db,
          'o',
          's',
          'task_type_id',
          [],
          '',
          [],
        )
      ).options,
    ).toEqual([{ name: 'incident', label: 'Incident' }]);
    const defaults = await loadSlaRuleOptions(
      client([ok(null)]).db,
      'o',
      's',
      'task_type_id',
      [],
      'task',
      [],
    );
    expect(defaults.options.some((option) => option.name === 'task')).toBe(
      true,
    );
  });
  it('fails closed on storage errors and unsupported fields', async () => {
    await expect(
      loadSlaRuleOptions(
        client([{ error: { message: 'sensitive' }, data: null }]).db,
        'o',
        's',
        'status',
        [],
        '',
        [],
      ),
    ).rejects.toThrow('Unable to load');
    await expect(
      loadSlaRuleOptions(client([]).db, 'o', 's', 'board_id', [], '', []),
    ).rejects.toThrow('Unsupported');
  });
});
