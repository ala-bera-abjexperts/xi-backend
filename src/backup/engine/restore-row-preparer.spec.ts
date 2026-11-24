/**
 * @fileoverview Tests for the row rules.
 * @module src/backup/engine/restore-row-preparer.spec
 *
 * These are the rules that decide whether a restore corrupts data, so most of what is asserted here
 * is what does NOT happen: a tenant id is not rewritten, a timestamp is not regenerated, a number is
 * not reformatted, a missing user does not become a sentinel.
 */

import {
  tableEntry,
  type ComponentTable,
} from '../registry/component-registry';
import {
  batchesOf,
  classifyInsertError,
  prepareRow,
  rowKeyOf,
} from './restore-row-preparer';

const ORG = '9de67ec3-1111-2222-3333-444444444444';
const OTHER_ORG = 'cecb176b-9999-8888-7777-666666666666';
const USER = '11111111-2222-3333-4444-555555555555';
const GONE = '99999999-9999-9999-9999-999999999999';

/** A registry entry shaped for one test, defaulting to something realistic. */
function entryFor(overrides: Partial<ComponentTable> = {}): ComponentTable {
  return {
    table: 'tasks',
    tenantColumn: 'organization_id',

    // Organization-level by default so a test that says nothing about space behaves as it did
    // before the space filter existed. Tests that care override it.
    spaceScope: { kind: 'organization' },
    tier: 'content',
    component: 'tasks',
    insertLevel: 5,
    requires: [],
    restoreByDefault: true,
    conflictPolicy: 'skip',
    userFkPolicy: {},
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    entry: entryFor(),
    organizationId: ORG,
    generatedColumns: [],
    knownUsers: new Set([USER]),
    ...overrides,
  } as Parameters<typeof prepareRow>[1];
}

describe('tenant boundary', () => {
  it('accepts a row belonging to the organization being restored', () => {
    const outcome = prepareRow({ id: 't1', organization_id: ORG }, context());

    expect(outcome.kind).toBe('insert');
  });

  it('refuses a row belonging to another organization', () => {
    const outcome = prepareRow(
      { id: 't1', organization_id: OTHER_ORG },
      context(),
    );

    expect(outcome.kind).toBe('skip');
    expect(outcome.kind === 'skip' && outcome.reason).toBe('foreign_tenant');
  });

  it('does NOT rewrite the tenant id to make the row fit', () => {
    // The single most important assertion in this file. Rewriting organization_id is the
    // cross-tenant migration the design refuses: the row would still point at the source tenant
    // through every jsonb and uuid[] column no remapper can see.
    const outcome = prepareRow(
      { id: 't1', organization_id: OTHER_ORG },
      context(),
    );

    expect(outcome.kind).toBe('skip');
    expect(outcome).not.toHaveProperty('row');
  });

  it('refuses a row with no tenant column value rather than assuming one', () => {
    const outcome = prepareRow({ id: 't1' }, context());

    expect(outcome.kind === 'skip' && outcome.reason).toBe('missing_tenant');
  });

  it('names the offending organization so the refusal is diagnosable', () => {
    const outcome = prepareRow(
      { id: 't1', organization_id: OTHER_ORG },
      context(),
    );

    expect(outcome.kind === 'skip' && outcome.detail).toContain(OTHER_ORG);
  });

  it('honours the seven tables that spell the column without an underscore', () => {
    const outcome = prepareRow(
      { id: 'g1', organizationid: ORG },
      context({ entry: entryFor({ tenantColumn: 'organizationid' }) }),
    );

    expect(outcome.kind).toBe('insert');
  });

  it('lets a parent-scoped table through, since its tenancy is the parent FK', () => {
    // fe_versions has no tenant column at all. Its organization is decided by the fe_nodes row it
    // points at, which either exists here or fails the foreign key.
    const outcome = prepareRow(
      { id: 'v1', node_id: 'n1' },
      context({
        entry: entryFor({
          table: 'fe_versions',
          tenantColumn: null,
          parentScope: {
            column: 'node_id',
            parentTable: 'fe_nodes',
            parentTenantColumn: 'organization_id',
          },
        }),
      }),
    );

    expect(outcome.kind).toBe('insert');
  });
});

describe('generated columns', () => {
  it('strips a column Postgres computes', () => {
    // Sending a GENERATED ALWAYS AS STORED column is an error, not an override: Postgres rejects
    // the whole row.
    const outcome = prepareRow(
      {
        id: 'p1',
        organization_id: ORG,
        customer_company: 'ACME',
        customer_company_normalized: 'acme',
      },
      context({ generatedColumns: ['customer_company_normalized'] }),
    );

    expect(outcome.kind).toBe('insert');
    expect(outcome.kind === 'insert' && outcome.row).not.toHaveProperty(
      'customer_company_normalized',
    );
    expect(outcome.kind === 'insert' && outcome.row.customer_company).toBe(
      'ACME',
    );
  });

  it('does not mutate the row it was given', () => {
    const source = {
      id: 'p1',
      organization_id: ORG,
      customer_company_normalized: 'acme',
    };

    prepareRow(
      source,
      context({ generatedColumns: ['customer_company_normalized'] }),
    );

    expect(source.customer_company_normalized).toBe('acme');
  });
});

describe('user foreign keys', () => {
  const nullable = entryFor({ userFkPolicy: { created_by: 'set_null' } });
  const required = entryFor({ userFkPolicy: { created_by: 'skip_row' } });

  it('keeps a user who still exists', () => {
    const outcome = prepareRow(
      { id: 't1', organization_id: ORG, created_by: USER },
      context({ entry: nullable }),
    );

    expect(outcome.kind === 'insert' && outcome.row.created_by).toBe(USER);
    expect(outcome.kind === 'insert' && outcome.nulledUserColumns).toEqual([]);
  });

  it('nulls a nullable reference to a user who is gone, and counts it', () => {
    const outcome = prepareRow(
      { id: 't1', organization_id: ORG, created_by: GONE },
      context({ entry: nullable }),
    );

    expect(outcome.kind === 'insert' && outcome.row.created_by).toBeNull();
    expect(outcome.kind === 'insert' && outcome.nulledUserColumns).toEqual([
      'created_by',
    ]);
  });

  it('drops the row when the column cannot be empty', () => {
    const outcome = prepareRow(
      { id: 't1', organization_id: ORG, created_by: GONE },
      context({ entry: required }),
    );

    expect(outcome.kind === 'skip' && outcome.reason).toBe('missing_user');
  });

  it('never substitutes a sentinel user', () => {
    // Inventing a user to satisfy an FK attributes someone else's work to them.
    const outcome = prepareRow(
      { id: 't1', organization_id: ORG, created_by: GONE },
      context({ entry: nullable }),
    );

    expect(outcome.kind === 'insert' && outcome.row.created_by).toBeNull();
    expect(outcome.kind === 'insert' && outcome.row.created_by).not.toBe(USER);
  });

  it('leaves an already-null reference alone', () => {
    const outcome = prepareRow(
      { id: 't1', organization_id: ORG, created_by: null },
      context({ entry: required }),
    );

    // Null was already valid; it is not a missing user.
    expect(outcome.kind).toBe('insert');
  });

  it('makes NO user decision when the user list was not loaded', () => {
    // A null set means "not checked". Treating it as "no users exist" would null or drop every
    // user reference in the archive, which is the worst possible reading of missing information.
    const outcome = prepareRow(
      { id: 't1', organization_id: ORG, created_by: GONE },
      context({ entry: required, knownUsers: null }),
    );

    expect(outcome.kind).toBe('insert');
    expect(outcome.kind === 'insert' && outcome.row.created_by).toBe(GONE);
  });

  it('applies each column its own policy', () => {
    const outcome = prepareRow(
      {
        id: 't1',
        organization_id: ORG,
        created_by: GONE,
        assigned_to: GONE,
      },
      context({
        entry: entryFor({
          userFkPolicy: { created_by: 'set_null', assigned_to: 'set_null' },
        }),
      }),
    );

    expect(
      outcome.kind === 'insert' && outcome.nulledUserColumns.sort(),
    ).toEqual(['assigned_to', 'created_by']);
  });
});

describe('values are passed through untouched', () => {
  it('does not regenerate timestamps', () => {
    // A restore that stamps created_at with the restore time destroys the history it exists to
    // bring back.
    const outcome = prepareRow(
      {
        id: 't1',
        organization_id: ORG,
        created_at: '2024-03-01T09:15:00.000Z',
        updated_at: '2024-06-11T17:42:13.128Z',
      },
      context(),
    );

    expect(outcome.kind === 'insert' && outcome.row.created_at).toBe(
      '2024-03-01T09:15:00.000Z',
    );
    expect(outcome.kind === 'insert' && outcome.row.updated_at).toBe(
      '2024-06-11T17:42:13.128Z',
    );
  });

  it('leaves a numeric string as a string', () => {
    const outcome = prepareRow(
      { id: 'i1', organization_id: ORG, amount: '1234.50' },
      context(),
    );

    expect(outcome.kind === 'insert' && outcome.row.amount).toBe('1234.50');
    expect(outcome.kind === 'insert' && typeof outcome.row.amount).toBe(
      'string',
    );
  });

  it('preserves nested structure rather than flattening it', () => {
    const custom = { fields: { rating: 5 }, tags: ['a', 'b'] };
    const outcome = prepareRow(
      { id: 't1', organization_id: ORG, custom_field_values: custom },
      context(),
    );

    expect(
      outcome.kind === 'insert' && outcome.row.custom_field_values,
    ).toEqual(custom);
  });

  it('keeps an empty string distinct from null', () => {
    const outcome = prepareRow(
      { id: 't1', organization_id: ORG, description: '', notes: null },
      context(),
    );

    expect(outcome.kind === 'insert' && outcome.row.description).toBe('');
    expect(outcome.kind === 'insert' && outcome.row.notes).toBeNull();
  });
});

describe('malformed input', () => {
  it('refuses something that is not a row', () => {
    expect(prepareRow(['not', 'a', 'row'], context()).kind).toBe('skip');
    expect(prepareRow(null, context()).kind).toBe('skip');
    expect(prepareRow('a string', context()).kind).toBe('skip');
  });

  it('refuses a tenant column holding something that is not an id', () => {
    // `String({})` is "[object Object]", which would be compared against a real organization id and
    // fail for the wrong reason. Treating it as absent says what actually happened.
    const outcome = prepareRow(
      { id: 't1', organization_id: { nested: true } },
      context(),
    );

    expect(outcome.kind === 'skip' && outcome.reason).toBe('missing_tenant');
  });

  it('applies the user policy to a corrupt user reference', () => {
    // An object in a user FK column can never match a real user, so it is handled exactly like a
    // user who is gone rather than being sent to the database to fail there.
    const outcome = prepareRow(
      { id: 't1', organization_id: ORG, created_by: { oops: 1 } },
      context({
        entry: entryFor({ userFkPolicy: { created_by: 'set_null' } }),
      }),
    );

    expect(outcome.kind === 'insert' && outcome.row.created_by).toBeNull();
  });
});

describe('rowKeyOf', () => {
  it('reports the id so a refusal can be traced to a row', () => {
    expect(rowKeyOf({ id: 't1' }, entryFor())).toBe('id=t1');
  });

  it('uses the composite key for a table with no id', () => {
    // Six tables are keyed by something other than id; reporting "id=undefined" for those is worse
    // than reporting nothing.
    const entry = entryFor({ orderBy: ['organization_id', 'schema_id'] });

    expect(rowKeyOf({ organization_id: ORG, schema_id: 's1' }, entry)).toBe(
      `organization_id=${ORG},schema_id=s1`,
    );
  });

  it('returns null when there is nothing to report', () => {
    expect(rowKeyOf({}, entryFor())).toBeNull();
  });
});

describe('classifyInsertError', () => {
  it('treats a duplicate as a row-level skip, so a resume can continue', () => {
    const result = classifyInsertError('23505');

    expect(result.conflictClass).toBe('duplicate');
    expect(result.rowLevel).toBe(true);
  });

  it('names a NOT NULL column added since the archive was written', () => {
    // 850 such columns exist live. Without this the failure reads as a generic database error at
    // row 40 000 rather than as schema drift.
    const result = classifyInsertError('23502');

    expect(result.conflictClass).toBe('missing_required_column');
    // Every row has the same shape, so retrying the rest of the table is pointless.
    expect(result.rowLevel).toBe(false);
  });

  it('stops the table on schema drift rather than retrying every row', () => {
    expect(classifyInsertError('42703').rowLevel).toBe(false);
    expect(classifyInsertError('PGRST204').conflictClass).toBe('schema_drift');
  });

  it('treats a missing parent as a row-level skip', () => {
    expect(classifyInsertError('23503').conflictClass).toBe('missing_parent');
  });

  it('fails closed on a code it does not recognise', () => {
    const result = classifyInsertError('XX000');

    // An unknown failure must not be assumed survivable — continuing through one is how a restore
    // reports success over a table that never landed.
    expect(result.conflictClass).toBe('unknown');
    expect(result.rowLevel).toBe(false);
  });

  it('fails closed on a missing code', () => {
    expect(classifyInsertError(null).rowLevel).toBe(false);
    expect(classifyInsertError(undefined).conflictClass).toBe('unknown');
  });
});

describe('batchesOf', () => {
  it('splits rows so one table is never one request', () => {
    expect(batchesOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for no rows', () => {
    expect(batchesOf([], 100)).toEqual([]);
  });

  it('refuses a batch size that would loop forever', () => {
    expect(() => batchesOf([1, 2], 0)).toThrow(/at least 1/);
  });
});

describe('against the real registry', () => {
  it('uses the live userFkPolicy for a real table', () => {
    const entry = tableEntry('tasks');

    expect(entry).toBeDefined();

    const outcome = prepareRow(
      { id: 't1', organization_id: ORG },
      context({ entry }),
    );

    expect(outcome.kind).toBe('insert');
  });

  it('refuses a foreign row for a real table', () => {
    const outcome = prepareRow(
      { id: 't1', organization_id: OTHER_ORG },
      context({ entry: tableEntry('tasks') }),
    );

    expect(outcome.kind === 'skip' && outcome.reason).toBe('foreign_tenant');
  });
});

/**
 * The space filter.
 *
 * Four questions, not one. The old code asked only "does this row's space column match?" and let
 * every table without such a column through, which silently covered three unrelated cases and is
 * why a restore scoped to one space wrote another space's rows.
 */
describe('the space filter', () => {
  const SPACE = '4b2eb6d0-bc26-4e3f-83b6-4c717a946eda';
  const OTHER_SPACE = '3a77676c-f982-4402-8752-096e58c05988';

  describe('when no space was chosen', () => {
    // The all-spaces path must be untouched by any of this. Asserted for every kind, because the
    // guard that protects it is a single early return and a regression there is invisible.
    it.each([
      ['organization', { kind: 'organization' } as const],
      ['own', { kind: 'own', column: 'space_id', whenNull: 'refuse' } as const],
      ['self', { kind: 'self' } as const],
      [
        'parent',
        {
          kind: 'parent',
          scope: {
            column: 'task_id',
            parentTable: 'tasks',
            parentSpaceColumn: 'space_id',
            whenNull: 'refuse',
          },
        } as const,
      ],
    ])('restores a %s-scoped row untouched', (_name, spaceScope) => {
      const outcome = prepareRow(
        { id: 't1', organization_id: ORG, space_id: OTHER_SPACE, task_id: 'x' },
        context({ entry: entryFor({ spaceScope }) }),
      );

      expect(outcome.kind).toBe('insert');
    });
  });

  describe('an organization-level table', () => {
    it('is restored whole, because it is not in any space', () => {
      // Site Studio, branding, roles. The operator asked for one space; these belong to the
      // organization, and narrowing them would restore almost nothing.
      const outcome = prepareRow(
        { id: 'f1', organization_id: ORG },
        context({
          entry: entryFor({ spaceScope: { kind: 'organization' } }),
          spaceId: SPACE,
        }),
      );

      expect(outcome.kind).toBe('insert');
    });
  });

  describe('a table with its own space column', () => {
    const entry = entryFor({
      spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    });

    it('restores a row in the chosen space', () => {
      const outcome = prepareRow(
        { id: 't1', organization_id: ORG, space_id: SPACE },
        context({ entry, spaceId: SPACE }),
      );

      expect(outcome.kind).toBe('insert');
    });

    it('refuses a row in another space', () => {
      const outcome = prepareRow(
        { id: 't1', organization_id: ORG, space_id: OTHER_SPACE },
        context({ entry, spaceId: SPACE }),
      );

      expect(outcome.kind).toBe('skip');
      expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
    });

    it('refuses a NULL space when the policy says refuse', () => {
      const outcome = prepareRow(
        { id: 't1', organization_id: ORG, space_id: null },
        context({ entry, spaceId: SPACE }),
      );

      expect(outcome.kind).toBe('skip');
      expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
    });

    it('restores a NULL space when the policy says it is organization-wide', () => {
      // Fifteen tables have a nullable space column where NULL means an org-wide default — a shared
      // task status, an org-wide custom field. Those are exactly what the chosen space's rows point
      // at, so a policy of 'organization' keeps them rather than orphaning the references.
      const outcome = prepareRow(
        { id: 's1', organization_id: ORG, space_id: null },
        context({
          entry: entryFor({
            spaceScope: {
              kind: 'own',
              column: 'space_id',
              whenNull: 'organization',
            },
          }),
          spaceId: SPACE,
        }),
      );

      expect(outcome.kind).toBe('insert');
    });
  });

  describe('the spaces table itself', () => {
    const entry = entryFor({ table: 'spaces', spaceScope: { kind: 'self' } });

    it('restores the one row that IS the chosen space', () => {
      const outcome = prepareRow(
        { id: SPACE, organization_id: ORG },
        context({ entry, spaceId: SPACE }),
      );

      expect(outcome.kind).toBe('insert');
    });

    it('refuses every other space', () => {
      // The regression that made this necessary: `spaces` has no space column, so the filter never
      // fired and a restore scoped to one space recreated all three of the tenant's spaces.
      const outcome = prepareRow(
        { id: OTHER_SPACE, organization_id: ORG },
        context({ entry, spaceId: SPACE }),
      );

      expect(outcome.kind).toBe('skip');
      expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
    });
  });

  describe('a table whose space comes from its parent', () => {
    const entry = entryFor({
      table: 'task_comments',
      spaceScope: {
        kind: 'parent',
        scope: {
          column: 'task_id',
          parentTable: 'tasks',
          parentSpaceColumn: 'space_id',
          whenNull: 'refuse',
        },
      },
    });

    it('restores a row whose parent is in the chosen space', () => {
      const outcome = prepareRow(
        { id: 'c1', organization_id: ORG, task_id: 'in-space' },
        context({
          entry,
          spaceId: SPACE,
          inSpaceParentIds: new Set(['in-space']),
        }),
      );

      expect(outcome.kind).toBe('insert');
    });

    it('refuses a row whose parent is in another space', () => {
      // This is the 99 task_history rows. They carry no space of their own, so nothing refused them
      // and they were written into a restore scoped to a space they do not belong to.
      const outcome = prepareRow(
        { id: 'c1', organization_id: ORG, task_id: 'elsewhere' },
        context({
          entry,
          spaceId: SPACE,
          inSpaceParentIds: new Set(['in-space']),
        }),
      );

      expect(outcome.kind).toBe('skip');
      expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
    });

    it('refuses every row when the parent set could not be established', () => {
      // Fails CLOSED. "We could not tell which rows qualify" and "they all qualify" read the same
      // to an insert and opposite to an operator, and guessing the permissive one is the bug.
      const outcome = prepareRow(
        { id: 'c1', organization_id: ORG, task_id: 'in-space' },
        context({ entry, spaceId: SPACE, inSpaceParentIds: null }),
      );

      expect(outcome.kind).toBe('skip');
      expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
    });

    it('refuses a NULL parent reference when the policy says refuse', () => {
      const outcome = prepareRow(
        { id: 'c1', organization_id: ORG, task_id: null },
        context({
          entry,
          spaceId: SPACE,
          inSpaceParentIds: new Set(['in-space']),
        }),
      );

      expect(outcome.kind).toBe('skip');
      expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
    });
  });

  it('reports every space refusal as other_space, whatever the reason', () => {
    // The writer counts `otherSpaceRows`, summarises them once per table, and downgrades a fully
    // filtered table to `skipped` rather than `succeeded` — all three key off this one literal.
    const kinds = [
      {
        entry: entryFor({
          spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
        }),
        row: { id: 'a', organization_id: ORG, space_id: OTHER_SPACE },
        ctx: {},
      },
      {
        entry: entryFor({ table: 'spaces', spaceScope: { kind: 'self' } }),
        row: { id: OTHER_SPACE, organization_id: ORG },
        ctx: {},
      },
      {
        entry: entryFor({
          table: 'task_comments',
          spaceScope: {
            kind: 'parent',
            scope: {
              column: 'task_id',
              parentTable: 'tasks',
              parentSpaceColumn: 'space_id',
              whenNull: 'refuse',
            },
          },
        }),
        row: { id: 'c', organization_id: ORG, task_id: 'elsewhere' },
        ctx: { inSpaceParentIds: new Set<string>() },
      },
    ];

    for (const { entry, row, ctx } of kinds) {
      const outcome = prepareRow(
        row,
        context({ entry, spaceId: SPACE, ...ctx }),
      );

      expect(outcome.kind).toBe('skip');
      expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
    }
  });
});

/**
 * The space filter.
 *
 * Four questions, not one. The old code asked only "does this row's space column match?" and let
 * every table without such a column through, which silently covered three unrelated cases: tables
 * that genuinely have no space, tables whose space is on the row they point at, and `spaces` itself.
 */
describe('the space filter', () => {
  const SPACE = '4b2eb6d0-bc26-4e3f-83b6-4c717a946eda';
  const OTHER_SPACE = '3a77676c-f982-4402-8752-096e58c05988';

  const parentEntry = entryFor({
    table: 'task_comments',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'task_id',
        parentTable: 'tasks',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
  });

  // The all-spaces path must be untouched by any of this. Asserted for every kind, because what
  // protects it is a single early return and a regression there would be invisible.
  it.each([
    ['organization', { kind: 'organization' } as const],
    ['own', { kind: 'own', column: 'space_id', whenNull: 'refuse' } as const],
    ['self', { kind: 'self' } as const],
  ])(
    'restores a %s-scoped row untouched when no space was chosen',
    (_name, spaceScope) => {
      const outcome = prepareRow(
        { id: 't1', organization_id: ORG, space_id: OTHER_SPACE },
        context({ entry: entryFor({ spaceScope }) }),
      );

      expect(outcome.kind).toBe('insert');
    },
  );

  it('restores a parent-scoped row untouched when no space was chosen', () => {
    const outcome = prepareRow(
      { id: 'c1', organization_id: ORG, task_id: 'anything' },
      context({ entry: parentEntry }),
    );

    expect(outcome.kind).toBe('insert');
  });

  it('restores an organization-level table whole, because it is not in any space', () => {
    // Site Studio, branding, roles. The operator asked for one space; these belong to the
    // organization, and narrowing them would restore almost nothing.
    const outcome = prepareRow(
      { id: 'f1', organization_id: ORG },
      context({
        entry: entryFor({ spaceScope: { kind: 'organization' } }),
        spaceId: SPACE,
      }),
    );

    expect(outcome.kind).toBe('insert');
  });

  describe('a table with its own space column', () => {
    const entry = entryFor({
      spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
    });

    it('restores a row in the chosen space', () => {
      const outcome = prepareRow(
        { id: 't1', organization_id: ORG, space_id: SPACE },
        context({ entry, spaceId: SPACE }),
      );

      expect(outcome.kind).toBe('insert');
    });

    it('refuses a row in another space', () => {
      const outcome = prepareRow(
        { id: 't1', organization_id: ORG, space_id: OTHER_SPACE },
        context({ entry, spaceId: SPACE }),
      );

      expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
    });

    it('refuses a NULL space when the policy says refuse', () => {
      const outcome = prepareRow(
        { id: 't1', organization_id: ORG, space_id: null },
        context({ entry, spaceId: SPACE }),
      );

      expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
    });

    it('restores a NULL space when the policy calls it organization-wide', () => {
      // Fifteen tables have a nullable space column where NULL means an org-wide default — a shared
      // task status, an org-wide custom field. Those are what the chosen space's rows point AT, so
      // this policy keeps them rather than orphaning every status_id in the restore.
      const outcome = prepareRow(
        { id: 's1', organization_id: ORG, space_id: null },
        context({
          entry: entryFor({
            spaceScope: {
              kind: 'own',
              column: 'space_id',
              whenNull: 'organization',
            },
          }),
          spaceId: SPACE,
        }),
      );

      expect(outcome.kind).toBe('insert');
    });
  });

  describe('the spaces table itself', () => {
    const entry = entryFor({ table: 'spaces', spaceScope: { kind: 'self' } });

    it('restores the one row that IS the chosen space', () => {
      const outcome = prepareRow(
        { id: SPACE, organization_id: ORG },
        context({ entry, spaceId: SPACE }),
      );

      expect(outcome.kind).toBe('insert');
    });

    it('refuses every other space', () => {
      // The regression this exists for: `spaces` has no space column, so nothing refused it and a
      // restore scoped to one space recreated all three of the tenant's spaces.
      const outcome = prepareRow(
        { id: OTHER_SPACE, organization_id: ORG },
        context({ entry, spaceId: SPACE }),
      );

      expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
    });
  });

  describe('a table whose space comes from its parent', () => {
    it('restores a row whose parent is in the chosen space', () => {
      const outcome = prepareRow(
        { id: 'c1', organization_id: ORG, task_id: 'in-space' },
        context({
          entry: parentEntry,
          spaceId: SPACE,
          inSpaceParentIds: new Set(['in-space']),
        }),
      );

      expect(outcome.kind).toBe('insert');
    });

    it('refuses a row whose parent is in another space', () => {
      // These are the 99 task_history rows. They carry no space of their own, so nothing refused
      // them and they were written by a restore scoped to a space they do not belong to.
      const outcome = prepareRow(
        { id: 'c1', organization_id: ORG, task_id: 'elsewhere' },
        context({
          entry: parentEntry,
          spaceId: SPACE,
          inSpaceParentIds: new Set(['in-space']),
        }),
      );

      expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
    });

    it('refuses every row when the parent set could not be established', () => {
      // Fails CLOSED. "We could not tell which rows qualify" and "they all qualify" read the same
      // to an insert and opposite to an operator; guessing the permissive one is the original bug.
      const outcome = prepareRow(
        { id: 'c1', organization_id: ORG, task_id: 'in-space' },
        context({ entry: parentEntry, spaceId: SPACE, inSpaceParentIds: null }),
      );

      expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
    });

    it('refuses a NULL parent reference when the policy says refuse', () => {
      const outcome = prepareRow(
        { id: 'c1', organization_id: ORG, task_id: null },
        context({
          entry: parentEntry,
          spaceId: SPACE,
          inSpaceParentIds: new Set(['in-space']),
        }),
      );

      expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
    });
  });

  it('reports every space refusal as other_space, whichever kind refused it', () => {
    // The writer counts `otherSpaceRows`, summarises them once per table, and downgrades a fully
    // filtered table to `skipped` rather than `succeeded` — all three key off this one literal.
    const cases = [
      {
        entry: entryFor({
          spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
        }),
        row: { id: 'a', organization_id: ORG, space_id: OTHER_SPACE },
        extra: {},
      },
      {
        entry: entryFor({ table: 'spaces', spaceScope: { kind: 'self' } }),
        row: { id: OTHER_SPACE, organization_id: ORG },
        extra: {},
      },
      {
        entry: parentEntry,
        row: { id: 'c', organization_id: ORG, task_id: 'elsewhere' },
        extra: { inSpaceParentIds: new Set<string>() },
      },
    ];

    for (const { entry, row, extra } of cases) {
      const outcome = prepareRow(
        row,
        context({ entry, spaceId: SPACE, ...extra }),
      );

      expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
    }
  });
});

/**
 * Moving rows INTO a space they were not in.
 *
 * The opposite operation to the filter above: rather than refusing a row from another space, the
 * restore takes it and puts it in the one that was chosen. Not every row is moving, though, and
 * telling those apart is the whole of this rule — an organization-wide task status is not in any
 * space and is restored exactly as it is, while a task is and needs a new identity first.
 */
describe('restoring into a destination space', () => {
  const DESTINATION = '4b2eb6d0-bc26-4e3f-83b6-4c717a946eda';
  const ELSEWHERE = '3a77676c-f982-4402-8752-096e58c05988';

  const spaceScoped = entryFor({
    spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
  });

  const parentScoped = entryFor({
    table: 'task_comments',
    spaceScope: {
      kind: 'parent',
      scope: {
        column: 'task_id',
        parentTable: 'tasks',
        parentSpaceColumn: 'space_id',
        whenNull: 'refuse',
      },
    },
  });

  it('accepts a row from another space when the run can move it', () => {
    // The behaviour that was asked for: the archive holds this task under a different space, and
    // choosing a destination restores it there rather than refusing it.
    const outcome = prepareRow(
      { id: 't1', organization_id: ORG, space_id: ELSEWHERE },
      context({
        entry: spaceScoped,
        destinationSpaceId: DESTINATION,
        canRescope: true,
      }),
    );

    expect(outcome.kind).toBe('insert');
  });

  it('does not stamp the destination space onto the row itself', () => {
    // Re-scoping is the remapper's job, and it happens after this — together with minting the new
    // id the moved row needs. Writing the space here without a new id would insert a row that
    // collides with the one still living in the space it came from.
    const outcome = prepareRow(
      { id: 't1', organization_id: ORG, space_id: ELSEWHERE },
      context({
        entry: spaceScoped,
        destinationSpaceId: DESTINATION,
        canRescope: true,
      }),
    );

    expect(outcome.kind === 'insert' && outcome.row.space_id).toBe(ELSEWHERE);
  });

  it('refuses a space-scoped row the run cannot move', () => {
    // No rewrite spec, so the row would be inserted still carrying the source space's id and its
    // old key — visibly in the destination, and still pointing at where it came from.
    const outcome = prepareRow(
      { id: 't1', organization_id: ORG, space_id: ELSEWHERE },
      context({
        entry: spaceScoped,
        destinationSpaceId: DESTINATION,
        canRescope: false,
      }),
    );

    expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
  });

  it('restores an organization-wide row of a space-scoped table unchanged, and does not move it', () => {
    // `task_statuses`, `task_priorities`, `status_categories` and `task_status_transitions` are
    // 100% NULL-space in the live database — every row is an organization default. Refusing the
    // TABLE for want of a rewrite spec would throw all of them away for no reason, and moving them
    // would turn a shared status into a space-private one.
    const outcome = prepareRow(
      { id: 's1', organization_id: ORG, space_id: null },
      context({
        entry: spaceScoped,
        destinationSpaceId: DESTINATION,
        canRescope: false,
      }),
    );

    expect(outcome.kind).toBe('insert');
    expect(outcome.kind === 'insert' && outcome.row.space_id).toBeNull();
  });

  it('restores an organization-level table whole', () => {
    const outcome = prepareRow(
      { id: 'f1', organization_id: ORG },
      context({
        entry: entryFor({ spaceScope: { kind: 'organization' } }),
        destinationSpaceId: DESTINATION,
        canRescope: false,
      }),
    );

    expect(outcome.kind).toBe('insert');
  });

  it('refuses the archived space row, because the destination already exists', () => {
    // The destination was chosen from a list of live spaces, so there is nothing to create.
    const outcome = prepareRow(
      { id: ELSEWHERE, organization_id: ORG },
      context({
        entry: entryFor({ table: 'spaces', spaceScope: { kind: 'self' } }),
        destinationSpaceId: DESTINATION,
        canRescope: false,
      }),
    );

    expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
  });

  it('treats a child with no parent reference as not being in a space', () => {
    // Nothing names a space for it, so there is nothing to move — and refusing it would lose a row
    // for a question that was never asked of it.
    const outcome = prepareRow(
      { id: 'c1', organization_id: ORG, task_id: null },
      context({
        entry: parentScoped,
        destinationSpaceId: DESTINATION,
        canRescope: false,
      }),
    );

    expect(outcome.kind).toBe('insert');
  });

  it('refuses a child whose parent names a space when the run cannot move it', () => {
    const outcome = prepareRow(
      { id: 'c1', organization_id: ORG, task_id: 'task-1' },
      context({
        entry: parentScoped,
        destinationSpaceId: DESTINATION,
        canRescope: false,
      }),
    );

    expect(outcome.kind === 'skip' && outcome.reason).toBe('other_space');
  });

  it('changes nothing when no destination space was chosen', () => {
    // The whole rule is behind a single guard. A regression there would silently re-scope every
    // ordinary restore, so it is asserted rather than assumed.
    for (const entry of [
      spaceScoped,
      parentScoped,
      entryFor({ spaceScope: { kind: 'organization' } }),
      entryFor({ table: 'spaces', spaceScope: { kind: 'self' } }),
    ]) {
      const outcome = prepareRow(
        { id: 'x1', organization_id: ORG, space_id: ELSEWHERE, task_id: 'p1' },
        context({ entry, canRescope: false }),
      );

      expect(outcome.kind).toBe('insert');
    }
  });
});

/**
 * Columns whose uniqueness is GLOBAL.
 *
 * `automations.webhook_token` is unique across the whole table — the index carries no
 * organization_id and no space_id. Re-scoping mints a fresh uuid, so a PRIMARY KEY collision is
 * impossible, which leaves that one index as the only thing a restored automation can hit. The
 * archived token still belongs to the row it came from, Postgres answers 23505, and the engine
 * files it under `duplicate`: "already present" reported into an empty destination space.
 *
 * The automation is then never written and 116 dependent rows fail 23503 — 13 automation_versions,
 * 95 automation_runs, 8 automation_event_subscriptions — every time, because the token is copied
 * verbatim on each retry.
 */
describe('globally unique columns', () => {
  const automations = () =>
    context({ entry: entryFor({ table: 'automations' }) });

  it('does not carry an automation webhook token into the destination', () => {
    const outcome = prepareRow(
      {
        id: 'a1',
        organization_id: ORG,
        name: 'teest',
        webhook_token: 'tok_the_original_still_holds_this',
      },
      automations(),
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    // Stripped, not nulled, so any column default still applies.
    expect('webhook_token' in outcome.row).toBe(false);
    expect(outcome.reissuedColumns).toEqual(['webhook_token']);
  });

  it('removes one column rather than sanitising the row', () => {
    const outcome = prepareRow(
      { id: 'a1', organization_id: ORG, name: 'teest', is_enabled: true },
      automations(),
    );

    if (outcome.kind !== 'insert') return;

    expect(outcome.row).toEqual({
      id: 'a1',
      organization_id: ORG,
      name: 'teest',
      is_enabled: true,
    });
  });

  it('reports nothing when the archive predates the column', () => {
    const outcome = prepareRow(
      { id: 'a1', organization_id: ORG, name: 'teest' },
      automations(),
    );

    if (outcome.kind !== 'insert') return;

    expect(outcome.reissuedColumns).toEqual([]);
  });

  it('leaves a same-named column on another table alone', () => {
    const outcome = prepareRow(
      { id: 't1', organization_id: ORG, webhook_token: 'not-unique-here' },
      context({ entry: entryFor({ table: 'tasks' }) }),
    );

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.webhook_token).toBe('not-unique-here');
    expect(outcome.reissuedColumns).toEqual([]);
  });

  it('preserves the primary key, so a genuine repeat restore is still skipped', () => {
    // The one way this could duplicate data: if clearing the token let a true re-run insert a second
    // copy. It cannot — the id is untouched, so a repeat collides on automations_pkey as it always did.
    const outcome = prepareRow(
      { id: 'a1', organization_id: ORG, webhook_token: 'tok' },
      automations(),
    );

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.id).toBe('a1');
  });
});

/**
 * The remedy offered must be one the operator can actually carry out.
 *
 * "Restore without choosing a destination space" is impossible cross-organization — a destination
 * space is mandatory there — so the old wording sent operators round a loop they could not exit.
 */
describe('unmovable rows offer a reachable remedy', () => {
  const outbox = (crossOrganization: boolean) =>
    prepareRow(
      { id: '1', organization_id: ORG, space_id: 'space-a' },
      context({
        entry: entryFor({
          table: 'automation_event_outbox',
          spaceScope: { kind: 'own', column: 'space_id', whenNull: 'refuse' },
        }),
        destinationSpaceId: 'space-b',
        crossOrganization,
      }),
    );

  it('tells a same-organization operator to clear the destination space', () => {
    const outcome = outbox(false);

    expect(outcome.kind).toBe('skip');

    if (outcome.kind !== 'skip') return;

    expect(outcome.detail).toContain('without choosing a destination space');
  });

  it('never says that cross-organization, where a destination space is mandatory', () => {
    const outcome = outbox(true);

    if (outcome.kind !== 'skip') return;

    expect(outcome.detail).not.toContain(
      'without choosing a destination space',
    );
    expect(outcome.detail).toContain('always needs a destination space');
  });
});

/**
 * A CHECK the destination refuses, and the shared wording that goes with dropping a row.
 *
 * Both were found in the same failed restore: `form_builder_assignments` lost all 6 of its rows and
 * `partner_leads` all 4, to a constraint neither table could satisfy once the restore had nulled a
 * user column the constraint depended on.
 */
describe('a row the destination refuses on a CHECK', () => {
  it('fails that row alone rather than the whole table', () => {
    // It had no case and fell to `unknown`, which is not row-level — so ONE offending row aborted
    // every other row of its table. A CHECK is by definition a statement about THIS row's values;
    // the next row may well satisfy it.
    const result = classifyInsertError('23514');

    expect(result.conflictClass).toBe('invalid_value');
    expect(result.rowLevel).toBe(true);
  });

  it('leaves the shape faults fatal, which is what they are', () => {
    // The distinction this rests on: a missing column or a GENERATED ALWAYS key is true of every
    // row in the table, so retrying the rest is pointless. Asserted here so widening 23514 cannot
    // drift into widening these.
    expect(classifyInsertError('23502').rowLevel).toBe(false);
    expect(classifyInsertError('42703').rowLevel).toBe(false);
    expect(classifyInsertError('428C9').rowLevel).toBe(false);
  });
});

/**
 * The sentence a dropped row carries, and why it stopped naming the column.
 *
 * `skip_row` was written when every table using it had a NOT NULL user column, so its detail said
 * "the column cannot be empty". That became false the moment `form_builder_assignments`
 * .assignee_user_id joined them: the column IS nullable. What cannot happen there is it and
 * `assignee_role` both being empty — `(assignee_user_id IS NOT NULL) <> (assignee_role IS NOT NULL)`.
 */
describe('what a dropped row says about itself', () => {
  const dropped = entryFor({ userFkPolicy: { assignee_user_id: 'skip_row' } });

  it('blames the row, not the column, so it is true of both shapes', () => {
    const outcome = prepareRow(
      { id: 'a1', organization_id: ORG, assignee_user_id: GONE },
      context({ entry: dropped }),
    );

    expect(outcome.kind).toBe('skip');

    if (outcome.kind !== 'skip') return;

    expect(outcome.reason).toBe('missing_user');
    expect(outcome.detail).toContain('assignee_user_id');
    expect(outcome.detail).toContain('cannot be written without them');

    // The claim that was false for a nullable column. Asserted so it cannot come back.
    expect(outcome.detail).not.toContain('cannot be empty');
  });
});

/**
 * Columns that collide only across a TENANT boundary, and must survive a move within one.
 *
 * `site_studio_funnels.preview_subdomain` and `.sub_domain_name` are unique across the whole
 * installation — the indexes carry no `organization_id` — so a funnel copied into another
 * organization was refused as a duplicate against rows that organization had never seen. Eleven
 * funnels on a real restore, and eleven `site_studio_pages` behind them.
 */
describe('globally-unique columns across an organization boundary', () => {
  const funnel = () => ({
    id: 'funnel-1',
    organization_id: ORG,
    space_id: 'space-1',
    preview_subdomain: 'acme-preview',
    sub_domain_name: 'acme',
  });

  const funnelEntry = entryFor({ table: 'site_studio_funnels' });

  it('strips the subdomains when the rows change organization', () => {
    const outcome = prepareRow(
      funnel(),
      context({ entry: funnelEntry, crossOrganization: true }),
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    // Deleted, not nulled: both are nullable with no default, and a funnel that arrives without a
    // public address is simply one that has not been published in its new tenant yet.
    expect('preview_subdomain' in outcome.row).toBe(false);
    expect('sub_domain_name' in outcome.row).toBe(false);
    expect(outcome.reissuedColumns).toEqual(
      expect.arrayContaining(['preview_subdomain', 'sub_domain_name']),
    );
  });

  /**
   * The half that makes the gate necessary.
   *
   * Within one organization the subdomain is still this funnel's own address. Stripping it on a
   * space move would take a working site off the air to avoid a collision that exists only because
   * the operator asked for a copy.
   */
  it('leaves them alone on a move inside one organization', () => {
    const outcome = prepareRow(
      funnel(),
      context({ entry: funnelEntry, crossOrganization: false }),
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.preview_subdomain).toBe('acme-preview');
    expect(outcome.row.sub_domain_name).toBe('acme');
  });

  it('keeps the always-stripped columns unconditional', () => {
    // `automations.webhook_token` collides with ITSELF whatever the destination, so it is not gated
    // and must not become gated. Asserted with `crossOrganization: false`, where a gate would show.
    const outcome = prepareRow(
      { id: 'a1', organization_id: ORG, webhook_token: 'tok-1' },
      context({
        entry: entryFor({ table: 'automations' }),
        crossOrganization: false,
      }),
    );

    expect(outcome.kind === 'insert' && 'webhook_token' in outcome.row).toBe(
      false,
    );
  });
});

/**
 * A share aimed at somebody who is not in the destination organization.
 *
 * `fe_shares_user_needs_target` is `CHECK (share_type = 'link' OR shared_with_id IS NOT NULL)`, so
 * nulling the recipient of a user-targeted share leaves neither half satisfied — ten rows failed
 * exactly this way on a real cross-organization restore.
 */
describe('a file share whose recipient is gone', () => {
  // The policy is stated here rather than taken from `entryFor`'s synthetic default, which carries
  // an empty `userFkPolicy`. That the REGISTRY actually says `skip_row` is asserted separately, in
  // `component-registry.spec.ts` — these two together cover the wiring and the mechanism.
  const shareEntry = entryFor({
    table: 'fe_shares',
    userFkPolicy: { shared_by: 'set_null', shared_with_id: 'skip_row' },
  });

  it('drops a user-targeted share rather than failing its CHECK', () => {
    const outcome = prepareRow(
      {
        id: 'share-1',
        organization_id: ORG,
        share_type: 'user',
        shared_with_id: GONE,
      },
      context({ entry: shareEntry }),
    );

    expect(outcome.kind).toBe('skip');

    if (outcome.kind !== 'skip') return;

    expect(outcome.reason).toBe('missing_user');
    expect(outcome.detail).toContain('shared_with_id');
  });

  it('still restores a link share, which needs no recipient at all', () => {
    // `share_type = 'link'` satisfies the constraint on its own. Dropping these too would lose rows
    // that were never affected by the missing user.
    const outcome = prepareRow(
      {
        id: 'share-2',
        organization_id: ORG,
        share_type: 'link',
        shared_with_id: null,
      },
      context({ entry: shareEntry }),
    );

    expect(outcome.kind).toBe('insert');
  });
});

describe('keep_required: a user FK on a column with no null to fall back to', () => {
  // `notifications.user_id` and `form_builder_approval_steps.approver_user_id` are NOT NULL and
  // name people who may not be members of the destination. Dropping those rows lost 56 records on
  // a real cross-organization restore; nulling them is not available at all.

  const STRANGER = '11111111-2222-3333-4444-555555555555';

  const keepRequired = () =>
    context({
      entry: entryFor({ userFkPolicy: { user_id: 'keep_required' } }),
    });

  it('keeps an id belonging to somebody who is not a member here', () => {
    const outcome = prepareRow(
      { id: 'n1', organization_id: ORG, user_id: STRANGER },
      keepRequired(),
    );

    expect(outcome.kind).toBe('insert');

    // Held exactly as archived. The FK points at `users`, which is global, so a user who still
    // exists satisfies it from any organization.
    expect(outcome.kind === 'insert' && outcome.row.user_id).toBe(STRANGER);
  });

  it('never nulls the column, which is the whole reason it is not set_null', () => {
    // Nulling a NOT NULL column answers 23502, which `classifyInsertError` reports as
    // `missing_required_column` with rowLevel FALSE — one row would abandon the entire table.
    const outcome = prepareRow(
      { id: 'n1', organization_id: ORG, user_id: STRANGER },
      keepRequired(),
    );

    expect(outcome.kind === 'insert' && outcome.row.user_id).not.toBeNull();
    expect(outcome.kind === 'insert' && outcome.nulledUserColumns).toEqual([]);
  });

  it('skips the row when the value is not a usable id, rather than nulling it', () => {
    // A jsonb object where a uuid belongs. `keep` would fall through and null the column here,
    // which on a NOT NULL column costs the whole table. This costs one row.
    const outcome = prepareRow(
      { id: 'n1', organization_id: ORG, user_id: { nested: 'object' } },
      keepRequired(),
    );

    expect(outcome.kind).toBe('skip');
    expect(outcome.kind === 'skip' && outcome.reason).toBe('missing_user');
  });

  it('leaves a member’s id alone, exactly as before', () => {
    const outcome = prepareRow(
      { id: 'n1', organization_id: ORG, user_id: USER },
      keepRequired(),
    );

    expect(outcome.kind).toBe('insert');
    expect(outcome.kind === 'insert' && outcome.row.user_id).toBe(USER);
  });

  it('leaves a null alone rather than treating it as unusable', () => {
    // An absent optional reference is not a corrupt one, and the loop skips null before any policy
    // is consulted. Asserted so a future change to the guard cannot start dropping these rows.
    const outcome = prepareRow(
      { id: 'n1', organization_id: ORG, user_id: null },
      keepRequired(),
    );

    expect(outcome.kind).toBe('insert');
  });
});
