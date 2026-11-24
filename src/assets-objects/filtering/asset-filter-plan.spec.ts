import { BadRequestException } from '@nestjs/common';

import { buildAssetFilterFields } from './asset-filter-fields';
import {
  buildFilterPlan,
  evaluateGroupInMemory,
  evaluateRuleInMemory,
} from './asset-filter-plan';

const ATTRS = [
  { field_key: 'cpu', data_type: 'integer', id: 'a-cpu', options: null },
  { field_key: 'env', data_type: 'text', id: 'a-env', options: null },
  { field_key: 'owner', data_type: 'user', id: 'a-owner', options: null },
  { field_key: 'team', data_type: 'user_multi', id: 'a-team', options: null },
  {
    field_key: 'rack',
    data_type: 'object_reference',
    id: 'a-rack',
    options: null,
  },
  {
    field_key: 'total',
    data_type: 'formula',
    id: 'a-total',
    options: { formula: 'cpu * 2', result_type: 'integer' },
  },
];

const FIELDS = buildAssetFilterFields(ATTRS);

const g = (combinator: 'and' | 'or', rules: any[]) => ({ combinator, rules });

const TARGET = '11111111-1111-1111-1111-111111111111';

describe('buildFilterPlan — execution mode', () => {
  it('uses SQL when every rule is expressible', () => {
    const plan = buildFilterPlan(
      g('and', [{ field: 'attr_cpu', operator: 'gt', value: 8 }]),
      FIELDS,
    );

    expect(plan?.mode).toBe('sql');
    expect(plan?.embed).toBeNull();
    expect(plan?.fragments).toEqual(['attribute_values->cpu.gt.8']);
  });

  it('embeds a single positive reference rule under AND', () => {
    const plan = buildFilterPlan(
      g('and', [{ field: 'attr_rack', operator: 'eq', value: TARGET }]),
      FIELDS,
    );

    expect(plan?.mode).toBe('sql');
    expect(plan?.embed).toEqual({
      attributeId: 'a-rack',
      targetObjectId: TARGET,
    });
    // The reference rule must NOT also appear as a fragment.
    expect(plan?.fragments).toEqual([]);
  });

  it('keeps other rules as fragments alongside the embed', () => {
    const plan = buildFilterPlan(
      g('and', [
        { field: 'attr_rack', operator: 'eq', value: TARGET },
        { field: 'attr_cpu', operator: 'gt', value: 8 },
      ]),
      FIELDS,
    );

    expect(plan?.mode).toBe('sql');
    expect(plan?.embed).not.toBeNull();
    expect(plan?.fragments).toEqual(['attribute_values->cpu.gt.8']);
  });

  it('falls back to memory for a formula rule', () => {
    const plan = buildFilterPlan(
      g('and', [{ field: 'attr_total', operator: 'gt', value: 10 }]),
      FIELDS,
    );

    expect(plan?.mode).toBe('memory');
    expect(plan?.fragments).toEqual([]);
    expect(plan?.memoryRules).toHaveLength(1);
  });

  // ── THE OR TRAP ───────────────────────────────────────────────────────────
  it('forces the ENTIRE group into memory when OR contains a formula rule', () => {
    // Pre-filtering with SQL under OR would drop rows the formula rule alone
    // should have matched — and the result would look perfectly plausible.
    const plan = buildFilterPlan(
      g('or', [
        { field: 'attr_cpu', operator: 'gt', value: 8 },
        { field: 'attr_total', operator: 'gt', value: 10 },
      ]),
      FIELDS,
    );

    expect(plan?.mode).toBe('memory');
    expect(plan?.fragments).toEqual([]);
    // BOTH rules must be evaluated in memory, not just the formula one.
    expect(plan?.memoryRules).toHaveLength(2);
  });

  it('forces memory when OR contains a reference rule', () => {
    const plan = buildFilterPlan(
      g('or', [
        { field: 'attr_cpu', operator: 'gt', value: 8 },
        { field: 'attr_rack', operator: 'eq', value: TARGET },
      ]),
      FIELDS,
    );

    expect(plan?.mode).toBe('memory');
    expect(plan?.embed).toBeNull();
    expect(plan?.memoryRules).toHaveLength(2);
  });

  it('falls back to memory for a NEGATIVE reference rule', () => {
    // `!inner` cannot express "has no such reference".
    const plan = buildFilterPlan(
      g('and', [{ field: 'attr_rack', operator: 'isEmpty' }]),
      FIELDS,
    );

    expect(plan?.mode).toBe('memory');
    expect(plan?.embed).toBeNull();
  });

  it('falls back to memory for TWO reference rules', () => {
    // Two embeds would intersect at the child level, not the parent.
    const plan = buildFilterPlan(
      g('and', [
        { field: 'attr_rack', operator: 'eq', value: TARGET },
        { field: 'attr_rack', operator: 'eq', value: TARGET },
      ]),
      FIELDS,
    );

    expect(plan?.mode).toBe('memory');
    expect(plan?.embed).toBeNull();
  });

  it('rejects a reference rule with no target', () => {
    expect(() =>
      buildFilterPlan(
        g('and', [{ field: 'attr_rack', operator: 'eq', value: '' }]),
        FIELDS,
      ),
    ).toThrow(BadRequestException);
  });

  it('returns null for an empty or absent group', () => {
    expect(buildFilterPlan(null, FIELDS)).toBeNull();
    expect(buildFilterPlan(g('and', []), FIELDS)).toBeNull();
  });
});

describe('in-memory evaluation', () => {
  const row = (attrs: Record<string, unknown>, extra = {}) => ({
    name: 'srv-a',
    attribute_values: attrs,
    ...extra,
  });

  it('compares formula results numerically per result_type', () => {
    // result_type integer => numeric, so 10 > 9 (not the text "10" < "9").
    const r = row({ total: 10 });

    expect(
      evaluateRuleInMemory(
        r,
        { field: 'attr_total', operator: 'gt', value: 9 },
        FIELDS,
      ),
    ).toBe(true);
    expect(
      evaluateRuleInMemory(
        r,
        { field: 'attr_total', operator: 'lt', value: 9 },
        FIELDS,
      ),
    ).toBe(false);
  });

  it('never satisfies an ordinal comparison for a null formula value', () => {
    // A formula that threw yields null; SQL NULL comparisons are never true.
    const r = row({ total: null });

    for (const op of ['gt', 'gte', 'lt', 'lte']) {
      expect(
        evaluateRuleInMemory(
          r,
          { field: 'attr_total', operator: op, value: 1 },
          FIELDS,
        ),
      ).toBe(false);
    }
  });

  it('treats a missing key and an explicit null as empty', () => {
    expect(
      evaluateRuleInMemory(
        row({}),
        { field: 'attr_env', operator: 'isEmpty' },
        FIELDS,
      ),
    ).toBe(true);
    expect(
      evaluateRuleInMemory(
        row({ env: null }),
        { field: 'attr_env', operator: 'isEmpty' },
        FIELDS,
      ),
    ).toBe(true);
    expect(
      evaluateRuleInMemory(
        row({ env: '' }),
        { field: 'attr_env', operator: 'isEmpty' },
        FIELDS,
      ),
    ).toBe(true);
    expect(
      evaluateRuleInMemory(
        row({ env: 'prod' }),
        { field: 'attr_env', operator: 'isEmpty' },
        FIELDS,
      ),
    ).toBe(false);
  });

  it('treats an empty array as empty for multi-value fields', () => {
    expect(
      evaluateRuleInMemory(
        row({ team: [] }),
        { field: 'attr_team', operator: 'isEmpty' },
        FIELDS,
      ),
    ).toBe(true);
  });

  it('matches user IDs, and user_multi by membership', () => {
    const uid = '22222222-2222-2222-2222-222222222222';

    expect(
      evaluateRuleInMemory(
        row({ owner: uid }),
        { field: 'attr_owner', operator: 'eq', value: uid },
        FIELDS,
      ),
    ).toBe(true);
    expect(
      evaluateRuleInMemory(
        row({ team: [uid] }),
        { field: 'attr_team', operator: 'contains', value: uid },
        FIELDS,
      ),
    ).toBe(true);
    expect(
      evaluateRuleInMemory(
        row({ team: [] }),
        { field: 'attr_team', operator: 'contains', value: uid },
        FIELDS,
      ),
    ).toBe(false);
  });

  it('is case-insensitive for contains, matching SQL ilike', () => {
    expect(
      evaluateRuleInMemory(
        row({ env: 'PROD' }),
        { field: 'attr_env', operator: 'contains', value: 'pro' },
        FIELDS,
      ),
    ).toBe(true);
  });

  it('filters on real columns as well as attributes', () => {
    expect(
      evaluateRuleInMemory(
        row({}),
        { field: 'name', operator: 'contains', value: 'srv' },
        FIELDS,
      ),
    ).toBe(true);
  });

  it('applies and/or correctly, and treats an empty group as a no-op', () => {
    const r = row({ cpu: 10, env: 'prod' });

    const rules = [
      { field: 'attr_cpu', operator: 'gt', value: 100 },
      { field: 'attr_env', operator: 'eq', value: 'prod' },
    ];

    expect(evaluateGroupInMemory(r, rules, 'and', FIELDS)).toBe(false);
    expect(evaluateGroupInMemory(r, rules, 'or', FIELDS)).toBe(true);
    expect(evaluateGroupInMemory(r, [], 'and', FIELDS)).toBe(true);
  });

  it('handles between with reversed or malformed bounds safely', () => {
    const r = row({ cpu: 5 });

    expect(
      evaluateRuleInMemory(
        r,
        { field: 'attr_cpu', operator: 'between', value: [1, 9] },
        FIELDS,
      ),
    ).toBe(true);
    expect(
      evaluateRuleInMemory(
        r,
        { field: 'attr_cpu', operator: 'between', value: [9, 1] },
        FIELDS,
      ),
    ).toBe(false);
    expect(
      evaluateRuleInMemory(
        r,
        { field: 'attr_cpu', operator: 'between', value: [1] },
        FIELDS,
      ),
    ).toBe(false);
  });

  describe('reference rules use target IDs, not enriched names', () => {
    // REGRESSION: enrichment merges references into attribute_values as target
    // NAMES (["rack-1"]) while the rule carries the target's UUID. Comparing
    // those two always failed, so any AND group containing a reference rule
    // returned zero rows — even when every condition genuinely matched.
    const RACK_1 = '33333333-3333-3333-3333-333333333333';
    const RACK_2 = '44444444-4444-4444-4444-444444444444';

    const srvB = {
      id: 'obj-b',
      name: 'srv-b',
      // Note the NAME here — this is what enrichment leaves behind.
      attribute_values: { cpu: 10, total: 20, rack: ['rack-1'] },
    };

    const index = new Map([[`obj-b:a-rack`, new Set([RACK_1])]]);

    it('matches when the referenced target id is present', () => {
      expect(
        evaluateRuleInMemory(
          srvB,
          { field: 'attr_rack', operator: 'eq', value: RACK_1 },
          FIELDS,
          index,
        ),
      ).toBe(true);
    });

    it('does not match a different target', () => {
      expect(
        evaluateRuleInMemory(
          srvB,
          { field: 'attr_rack', operator: 'eq', value: RACK_2 },
          FIELDS,
          index,
        ),
      ).toBe(false);
    });

    it('treats an object with no reference row as empty', () => {
      expect(
        evaluateRuleInMemory(
          { id: 'obj-d', attribute_values: {} },
          { field: 'attr_rack', operator: 'isEmpty' },
          FIELDS,
          index,
        ),
      ).toBe(true);
    });

    it('the exact reported case: rack=rack-1 AND cpu>9 AND double_cpu>15 matches srv-b', () => {
      const rules = [
        { field: 'attr_rack', operator: 'eq', value: RACK_1 },
        { field: 'attr_cpu', operator: 'gt', value: 9 },
        { field: 'attr_total', operator: 'gt', value: 15 },
      ];

      expect(evaluateGroupInMemory(srvB, rules, 'and', FIELDS, index)).toBe(
        true,
      );
    });

    it('srv-a (cpu 9) is correctly excluded by the same group', () => {
      const srvA = {
        id: 'obj-a',
        attribute_values: { cpu: 9, total: 18, rack: ['rack-1'] },
      };

      const rules = [
        { field: 'attr_rack', operator: 'eq', value: RACK_1 },
        { field: 'attr_cpu', operator: 'gt', value: 9 },
        { field: 'attr_total', operator: 'gt', value: 15 },
      ];

      expect(
        evaluateGroupInMemory(
          srvA,
          rules,
          'and',
          FIELDS,
          new Map([['obj-a:a-rack', new Set([RACK_1])]]),
        ),
      ).toBe(false);
    });
  });

  it('fails closed on an unknown operator', () => {
    expect(
      evaluateRuleInMemory(
        row({ cpu: 1 }),
        { field: 'attr_cpu', operator: 'nope', value: 1 },
        FIELDS,
      ),
    ).toBe(false);
  });
});
