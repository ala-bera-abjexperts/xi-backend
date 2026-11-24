import { FilterQueryEngine } from './filter-query-engine';

describe('FilterQueryEngine', () => {
  const tableConfig = {
    tableName: 'tasks',
    selectColumns: '*',
    spaceColumn: 'space_id',
    fieldMapping: {
      title: 'summary',
    },
  };

  it('quotes ILIKE OR patterns so text values cannot add predicates', () => {
    const engine = new FilterQueryEngine({} as never);
    const condition = (
      engine as unknown as {
        ruleToFilterString: (...args: unknown[]) => string | null;
      }
    ).ruleToFilterString(
      {
        field: 'title',
        operator: 'contains',
        value: 'risk),id.neq.injected',
      },
      tableConfig,
      'user-1',
    );

    expect(condition).toBe('summary.ilike."%risk),id.neq.injected%"');
  });

  it('turns invalid custom-field OR predicates into an impossible match', () => {
    const engine = new FilterQueryEngine({} as never);
    const condition = (
      engine as unknown as {
        ruleToFilterString: (...args: unknown[]) => string | null;
      }
    ).ruleToFilterString(
      {
        field: 'cf_risk),id.neq.injected',
        operator: 'contains',
        value: 'open',
      },
      tableConfig,
      'user-1',
      {},
    );

    expect(condition).toBe('id.eq.00000000-0000-0000-0000-000000000000');
  });
});

/**
 * XE-T587 — the Type column showed a dash in every custom (saved-view) task list.
 *
 * `task_type` is not a column: it is synthesized from `task_hierarchy_configurations`. The
 * ordinary task read path enriches it, this engine did not, so every surface fed by a saved
 * view rendered `-`. These pin the enrichment and its two fallbacks.
 */
describe('FilterQueryEngine.enrichWithTaskTypes (XE-T587)', () => {
  const configRows = [
    {
      space_id: null,
      config: { levels: [{ id: 'task', name: 'Task', icon: 'check' }] },
    },
    {
      space_id: 'space-1',
      config: {
        levels: [
          { id: 'incident', name: 'Incident', color: '#f00', icon: 'bug' },
        ],
      },
    },
  ];

  const engineWith = (rows: typeof configRows) =>
    new FilterQueryEngine({
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve({ data: rows, error: null }),
        }),
      }),
    } as never);

  const enrich = (engine: FilterQueryEngine, rows: Record<string, any>[]) =>
    (
      engine as unknown as {
        enrichWithTaskTypes: (
          r: Record<string, any>[],
          org: string,
        ) => Promise<Record<string, any>[]>;
      }
    ).enrichWithTaskTypes(rows, 'org-1');

  it("resolves a task type from its own space's config", async () => {
    const [row] = await enrich(engineWith(configRows), [
      { id: 't1', space_id: 'space-1', task_type_id: 'incident' },
    ]);

    expect(row.task_type).toMatchObject({
      id: 'incident',
      name: 'Incident',
      icon: 'bug',
    });
  });

  it('falls back to the org-level default for a space with no config', async () => {
    const [row] = await enrich(engineWith(configRows), [
      { id: 't2', space_id: 'space-other', task_type_id: 'task' },
    ]);

    expect(row.task_type).toMatchObject({ id: 'task', name: 'Task' });
  });

  it('degrades an unknown id to a capitalized label rather than a dash', async () => {
    const [row] = await enrich(engineWith(configRows), [
      { id: 't3', space_id: 'space-1', task_type_id: 'epic' },
    ]);

    expect(row.task_type).toMatchObject({ id: 'epic', name: 'Epic' });
  });

  it('leaves task_type null only when the task genuinely has no type id', async () => {
    const [row] = await enrich(engineWith(configRows), [
      { id: 't4', space_id: 'space-1', task_type_id: null },
    ]);

    expect(row.task_type).toBeNull();
  });

  it('preserves every original field on the row', async () => {
    const [row] = await enrich(engineWith(configRows), [
      { id: 't5', space_id: 'space-1', task_type_id: 'incident', summary: 'x' },
    ]);

    expect(row).toMatchObject({ id: 't5', summary: 'x' });
  });
});

/**
 * XE-T532 — "Linked to" (task→task links, either direction) and the Parent
 * key resolution it now shares via `resolveEntityKeysToIds`.
 */
describe('FilterQueryEngine linked_to (XE-T532)', () => {
  const IMPOSSIBLE = 'id.eq.00000000-0000-0000-0000-000000000000';
  const U1 = '11111111-1111-1111-1111-111111111111';
  const U2 = '22222222-2222-2222-2222-222222222222';
  const U3 = '33333333-3333-3333-3333-333333333333';
  const T11 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  type Priv = {
    ruleToFilterString: (...args: unknown[]) => string | null;
    applyRule: (...args: unknown[]) => unknown;
    applyRuleGroup: (...args: unknown[]) => unknown;
    getTableConfig: (entityType: string) => unknown;
    resolveLinkedTasksForEntity: (
      group: unknown,
      entityType: string,
      org: string,
    ) => Promise<Map<string, Set<string>>>;
    resolveParentKeysForEntity: (
      group: unknown,
      entityType: string,
      org: string,
    ) => Promise<Map<string, string | null>>;
  };

  const priv = (engine: FilterQueryEngine) => engine as unknown as Priv;
  const engine = new FilterQueryEngine({} as never);
  const tasks = priv(engine).getTableConfig('tasks');
  const linked = new Map([
    ['XSD-T11', new Set([U1, U2])],
    ['XSD-T12', new Set([U2, U3])],
    [T11, new Set([U3])],
  ]);

  const str = (operator: string, value: unknown, table = tasks) =>
    priv(engine).ruleToFilterString(
      { field: 'linked_to', operator, value },
      table,
      'user-1',
      undefined,
      undefined,
      undefined,
      linked,
    );

  /** Chainable fake PostgREST builder that records every call. */
  function recorder() {
    const calls: [string, ...unknown[]][] = [];
    const q: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ['eq', 'in', 'not', 'or', 'ilike']) {
      q[m] = (...a: unknown[]) => {
        calls.push([m, ...a]);
        return q;
      };
    }
    return { q, calls };
  }

  describe('ruleToFilterString', () => {
    it('unions ids for a comma string and dedupes', () => {
      expect(str('in', 'XSD-T11, xsd-t12')).toBe(`id.in.(${U1},${U2},${U3})`);
    });

    it('negates for notIn and neq', () => {
      expect(str('notIn', 'XSD-T11')).toBe(`id.not.in.(${U1},${U2})`);
      expect(str('neq', 'XSD-T11')).toBe(`id.not.in.(${U1},${U2})`);
    });

    it('unknown key: in matches nothing, notIn is a tautology (not null)', () => {
      expect(str('in', 'XSD-T99')).toBe(IMPOSSIBLE);
      expect(str('notIn', 'XSD-T99')).toBe('id.not.is.null');
    });

    it('empty value: in matches nothing, notIn matches everything', () => {
      expect(str('in', '')).toBe(IMPOSSIBLE);
      expect(str('notIn', null)).toBe('id.not.is.null');
    });

    it('accepts an uppercase UUID', () => {
      expect(str('in', T11.toUpperCase())).toBe(`id.in.(${U3})`);
    });

    it('ignores {recursive}', () => {
      expect(str('in', { keys: ['XSD-T11'], recursive: true })).toBe(
        `id.in.(${U1},${U2})`,
      );
    });

    it('never emits `not.<column>` (PostgREST allows `not.` only before and/or)', () => {
      for (const operator of ['in', 'notIn', 'neq']) {
        for (const value of ['XSD-T11', 'XSD-T99', '', null]) {
          expect(str(operator, value)).not.toMatch(
            /(^|[(,])not\.(?!and\(|or\()/,
          );
        }
      }
    });

    it('is impossible for processes (unmapped field)', () => {
      expect(
        str('in', 'XSD-T11', priv(engine).getTableConfig('processes')),
      ).toBe(IMPOSSIBLE);
    });
  });

  describe('applyRule', () => {
    const apply = (operator: string, value: unknown) => {
      const { q, calls } = recorder();
      const result = priv(engine).applyRule(
        q,
        { field: 'linked_to', operator, value },
        tasks,
        'user-1',
        undefined,
        undefined,
        undefined,
        linked,
      );
      return { result, calls, q };
    };

    it('filters ids with in / not in', () => {
      expect(apply('in', ['XSD-T11']).calls).toEqual([['in', 'id', [U1, U2]]]);
      expect(apply('notIn', 'XSD-T11').calls).toEqual([
        ['not', 'id', 'in', `(${U1},${U2})`],
      ]);
    });

    it('unknown key: in impossible, notIn no-op', () => {
      expect(apply('in', 'XSD-T99').calls).toEqual([
        ['eq', 'id', '00000000-0000-0000-0000-000000000000'],
      ]);
      const noop = apply('notIn', 'XSD-T99');
      expect(noop.calls).toEqual([]);
      expect(noop.result).toBe(noop.q);
    });
  });

  describe('applyRuleGroup', () => {
    const run = (group: unknown) => {
      const { q, calls } = recorder();
      priv(engine).applyRuleGroup(
        q,
        group,
        tasks,
        'user-1',
        undefined,
        undefined,
        undefined,
        linked,
      );
      return calls;
    };
    const linkRule = { field: 'linked_to', operator: 'in', value: 'XSD-T11' };

    it('AND: applies the rule directly', () => {
      expect(run({ combinator: 'and', rules: [linkRule] })).toEqual([
        ['in', 'id', [U1, U2]],
      ]);
    });

    it('nested OR: forwards the links into the filter string', () => {
      expect(
        run({
          combinator: 'and',
          rules: [
            {
              combinator: 'or',
              rules: [
                linkRule,
                { field: 'linked_to', operator: 'notIn', value: 'XSD-T99' },
              ],
            },
          ],
        }),
      ).toEqual([['or', `or(id.in.(${U1},${U2}),id.not.is.null)`]]);
    });

    it('NOT group around a negated rule stays valid PostgREST', () => {
      expect(
        run({
          combinator: 'and',
          not: true,
          rules: [
            { field: 'linked_to', operator: 'notIn', value: 'XSD-T11' },
            { field: 'linked_to', operator: 'notIn', value: 'XSD-T99' },
          ],
        }),
      ).toEqual([['or', `not.and(id.not.in.(${U1},${U2}),id.not.is.null)`]]);
    });

    it('NOT group: negates the resolved ids', () => {
      expect(run({ combinator: 'and', not: true, rules: [linkRule] })).toEqual([
        ['or', `not.and(id.in.(${U1},${U2}))`],
      ]);
    });
  });

  /** Fake supabase: `tasks` key lookup and `task_relationships` in both directions. */
  function fakeSupabase() {
    const calls: {
      table: string;
      eqs: Record<string, unknown>;
      inCol: string;
      inVals: string[];
    }[] = [];
    const client = {
      from: (table: string) => {
        const call = {
          table,
          eqs: {} as Record<string, unknown>,
          inCol: '',
          inVals: [] as string[],
        };
        calls.push(call);
        const chain = {
          select: () => chain,
          eq: (c: string, v: unknown) => {
            call.eqs[c] = v;
            return chain;
          },
          in: (c: string, v: string[]) => {
            call.inCol = c;
            call.inVals = v;
            return chain;
          },
          then: (ok: (v: unknown) => unknown) => {
            let data: unknown[] = [];
            if (table === 'tasks')
              data = [{ id: T11, key: 'XSD-T11' }].filter((r) =>
                call.inVals.includes(r.key),
              );
            else if (call.inCol === 'source_id')
              data = [{ source_id: T11, target_id: U2 }];
            else data = [{ source_id: U1, target_id: T11 }];
            return Promise.resolve({ data, error: null }).then(ok);
          },
        };
        return chain;
      },
    };
    return { client, calls };
  }

  describe('resolveLinkedTasksForEntity', () => {
    const group = {
      combinator: 'and',
      rules: [
        { field: 'status', operator: 'eq', value: 'open' },
        {
          combinator: 'or',
          rules: [{ field: 'linked_to', operator: 'in', value: 'xsd-t11' }],
        },
      ],
    };

    it('resolves keys, then unions task→task links in both directions', async () => {
      const { client, calls } = fakeSupabase();
      const result = await priv(
        new FilterQueryEngine(client as never),
      ).resolveLinkedTasksForEntity(group, 'tasks', 'org-1');

      expect([...(result.get('XSD-T11') ?? [])].sort()).toEqual([U1, U2]);
      expect(calls[0]).toMatchObject({
        table: 'tasks',
        inCol: 'key',
        inVals: ['XSD-T11'],
        eqs: { organization_id: 'org-1' },
      });
      const rel = calls.filter((c) => c.table === 'task_relationships');
      expect(rel.map((c) => c.inCol).sort()).toEqual([
        'source_id',
        'target_id',
      ]);
      for (const c of rel) {
        expect(c.eqs).toMatchObject({
          organization_id: 'org-1',
          source_type: 'task',
          target_type: 'task',
        });
      }
    });

    it('makes no queries for processes', async () => {
      const { client, calls } = fakeSupabase();
      const result = await priv(
        new FilterQueryEngine(client as never),
      ).resolveLinkedTasksForEntity(group, 'processes', 'org-1');

      expect(result.size).toBe(0);
      expect(calls).toHaveLength(0);
    });
  });

  describe('parent (backfilled, pins the shared key resolution)', () => {
    it('translates a parent key to its id in the filter string', () => {
      const condition = priv(engine).ruleToFilterString(
        { field: 'parent', operator: 'in', value: 'XSD-T11' },
        tasks,
        'user-1',
        undefined,
        new Map([['XSD-T11', T11]]),
      );

      expect(condition).toBe(`parent_task_id.in.(${T11})`);
    });

    it('maps UUIDs to themselves and keys through one org-scoped query', async () => {
      const { client, calls } = fakeSupabase();
      const map = await priv(
        new FilterQueryEngine(client as never),
      ).resolveParentKeysForEntity(
        {
          combinator: 'and',
          rules: [{ field: 'parent', operator: 'in', value: `XSD-T11,${U2}` }],
        },
        'tasks',
        'org-1',
      );

      expect(map.get(U2)).toBe(U2);
      expect(map.get('XSD-T11')).toBe(T11);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        table: 'tasks',
        inCol: 'key',
        inVals: ['XSD-T11'],
        eqs: { organization_id: 'org-1' },
      });
    });
  });
});

/** Ticket 10: the virtual `development` field over the git computed fields. */
describe('FilterQueryEngine development (ticket 10)', () => {
  const IMPOSSIBLE = 'id.eq.00000000-0000-0000-0000-000000000000';
  type Priv = {
    ruleToFilterString: (...args: unknown[]) => string | null;
    applyRule: (...args: unknown[]) => unknown;
    applyRuleGroup: (...args: unknown[]) => unknown;
    getTableConfig: (entityType: string) => {
      selectColumns: string;
      fieldMapping: Record<string, string>;
    };
    executeForEntityType: (
      entityType: string,
      params: unknown,
      exactPage?: boolean,
    ) => Promise<{ data: unknown[]; count: number }>;
  };
  const engine = new FilterQueryEngine({} as never) as unknown as Priv;
  const tasks = engine.getTableConfig('tasks');

  function recorder() {
    const calls: [string, ...unknown[]][] = [];
    const q: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ['eq', 'in', 'not', 'or', 'ilike']) {
      q[m] = (...a: unknown[]) => {
        calls.push([m, ...a]);
        return q;
      };
    }
    return { q, calls };
  }
  const apply = (operator: string, value: unknown) => {
    const { q, calls } = recorder();
    const result = engine.applyRule(
      q,
      { field: 'development', operator, value },
      tasks,
      'user-1',
    );
    return { calls, noop: result === q };
  };
  const str = (operator: string, value: unknown, table: unknown = tasks) =>
    engine.ruleToFilterString(
      { field: 'development', operator, value },
      table,
      'user-1',
    );

  it('is virtual: not a mapped column, and the task select carries the git fields only when licensed', () => {
    expect(tasks.fieldMapping.development).toBeUndefined();
    expect(tasks.selectColumns).not.toContain('git_');
    expect(engine.getTableConfig('tasks', true).selectColumns).toContain(
      'git_pr_count, git_open_pr_count, git_merged_pr_count, git_build_state',
    );
    for (const other of ['processes', 'lists', 'wiki']) {
      expect(engine.getTableConfig(other, true).selectColumns).not.toContain(
        'git_',
      );
    }
  });

  describe('applyRule', () => {
    it('eq applies the condition', () => {
      expect(apply('eq', 'build_failing').calls).toEqual([
        ['or', 'git_build_state.eq.failed'],
      ]);
    });

    it('neq applies the negated condition', () => {
      expect(apply('neq', 'build_failing').calls).toEqual([
        ['or', 'or(git_build_state.is.null,git_build_state.neq.failed)'],
      ]);
    });

    it('in ORs the conditions (array or comma string), dropping unknown values', () => {
      const expected = [['or', 'git_pr_count.gt.0,git_open_pr_count.gt.0']];
      expect(apply('in', ['has_pr', 'pr_open', 'bogus']).calls).toEqual(
        expected,
      );
      expect(apply('in', 'has_pr, pr_open').calls).toEqual(expected);
    });

    it('notIn ANDs the negated conditions', () => {
      expect(apply('notIn', ['no_pr', 'pr_merged']).calls).toEqual([
        ['or', 'git_pr_count.gt.0'],
        ['or', 'git_merged_pr_count.eq.0'],
      ]);
    });

    it('invalid values: positive matches nothing, negating is a no-op', () => {
      expect(apply('eq', 'bogus').calls).toEqual([
        ['eq', 'id', '00000000-0000-0000-0000-000000000000'],
      ]);
      expect(apply('in', []).calls).toEqual([
        ['eq', 'id', '00000000-0000-0000-0000-000000000000'],
      ]);
      expect(apply('notIn', 'bogus')).toEqual({ calls: [], noop: true });
    });

    it('other operators (null, contains) fail closed', () => {
      expect(apply('null', null).calls).toEqual([
        ['eq', 'id', '00000000-0000-0000-0000-000000000000'],
      ]);
      expect(apply('contains', 'has_pr').calls).toEqual([
        ['eq', 'id', '00000000-0000-0000-0000-000000000000'],
      ]);
    });
  });

  describe('ruleToFilterString (OR groups)', () => {
    it('single value: the bare condition', () => {
      expect(str('eq', 'no_pr')).toBe('git_pr_count.eq.0');
      expect(str('neq', 'build_failing')).toBe(
        'or(git_build_state.is.null,git_build_state.neq.failed)',
      );
    });

    it('several values: or(...) for in, and(...) for notIn', () => {
      expect(str('in', ['has_pr', 'build_failing'])).toBe(
        'or(git_pr_count.gt.0,git_build_state.eq.failed)',
      );
      expect(str('notIn', ['has_pr', 'pr_open'])).toBe(
        'and(git_pr_count.eq.0,git_open_pr_count.eq.0)',
      );
    });

    it('invalid: impossible for positive, tautology for negating', () => {
      expect(str('in', 'bogus')).toBe(IMPOSSIBLE);
      expect(str('notIn', 'bogus')).toBe('id.not.is.null');
    });

    it('is impossible for non-task entities', () => {
      expect(str('eq', 'has_pr', engine.getTableConfig('processes'))).toBe(
        IMPOSSIBLE,
      );
    });

    it('works inside a nested OR group', () => {
      const { q, calls } = recorder();
      engine.applyRuleGroup(
        q,
        {
          combinator: 'and',
          rules: [
            {
              combinator: 'or',
              rules: [
                { field: 'development', operator: 'eq', value: 'pr_open' },
                { field: 'development', operator: 'neq', value: 'has_pr' },
              ],
            },
          ],
        },
        tasks,
        'user-1',
      );
      expect(calls).toEqual([
        ['or', 'or(git_open_pr_count.gt.0,git_pr_count.eq.0)'],
      ]);
    });
  });
});

/** Over-fetches past PostgREST's 1000-row cap are read in 1000-row ranges, not silently cut. */
describe('FilterQueryEngine over-fetch past the row cap', () => {
  it('reads page * pageSize rows in 1000-row ranges ordered by id', async () => {
    const ranges: [number, number][] = [];
    const orders: string[] = [];
    const total = 1500;
    const supabase = {
      from: () => {
        let range: [number, number] = [0, 0];
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'or', 'not', 'limit'])
          chain[m] = () => chain;
        chain.order = (col: string) => {
          orders.push(col);
          return chain;
        };
        chain.range = (from: number, to: number) => {
          range = [from, to];
          ranges.push(range);
          return chain;
        };
        chain.then = (ok: (v: unknown) => unknown) => {
          const n = Math.max(0, Math.min(range[1], total - 1) - range[0] + 1);
          const data = Array.from({ length: n }, (_, i) => ({
            id: `p-${range[0] + i}`,
          }));
          return Promise.resolve({ data, error: null, count: total }).then(ok);
        };
        return chain;
      },
    };
    const engine = new FilterQueryEngine(supabase as never) as unknown as {
      executeForEntityType: (
        e: string,
        p: unknown,
        exact?: boolean,
      ) => Promise<{ data: unknown[]; count: number }>;
    };

    const result = await engine.executeForEntityType(
      'processes',
      {
        query: { combinator: 'and', rules: [] },
        source_type: 'spaces',
        source_space_ids: [],
        source_entity_types: [],
        organizationId: 'org-1',
        userId: 'user-1',
        page: 2,
        pageSize: 1000,
      },
      false,
    );

    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(orders).toEqual(['id', 'id']);
    expect(result.data).toHaveLength(1500);
    expect(result.count).toBe(1500);
  });
});
