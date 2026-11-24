/**
 * @fileoverview Unit tests for save-time rule reference validation — a
 * workflow must not save a rule pointing at a soft-deleted entity.
 * @module src/workflow-engine/handlers/rule-reference-validation.spec
 * @author Prince Jadiya
 */
import { UnprocessableEntityException } from '@nestjs/common';

import { assertRuleReferencesInOrganization } from './rule-reference-validation';

import type { IRuleReference } from './handler.types';

function buildChain(rows: Array<Record<string, string>>) {
  const orFilters: string[] = [];
  const chain: Record<string, unknown> = { orFilters };
  const self = () => chain;

  chain.select = jest.fn(self);
  chain.eq = jest.fn(self);
  chain.in = jest.fn(self);
  chain.or = jest.fn((filter: string) => {
    orFilters.push(filter);

    return chain;
  });
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve);

  return chain;
}

describe('assertRuleReferencesInOrganization', () => {
  const SOFT_DELETE_FILTER = 'is_deleted.is.null,is_deleted.eq.false';

  let chains: Record<string, ReturnType<typeof buildChain>>;
  let client: { from: jest.Mock };

  const stub = (table: string, rows: Array<Record<string, string>>) => {
    chains[table] = buildChain(rows);
  };

  beforeEach(() => {
    chains = {};
    client = {
      from: jest.fn((table: string) => {
        chains[table] ??= buildChain([]);

        return chains[table];
      }),
    };
  });

  const run = (refs: IRuleReference[]) =>
    assertRuleReferencesInOrganization(client, 'org-1', refs);

  it('excludes soft-deleted rows for soft-deleting ref tables', async () => {
    stub('custom_fields', [{ id: 'f1' }]);
    stub('user_groups', [{ id: 'g1' }]);

    await run([
      { kind: 'field', id: 'f1' },
      { kind: 'group', id: 'g1' },
    ] as IRuleReference[]);

    expect(chains['custom_fields'].orFilters).toEqual([SOFT_DELETE_FILTER]);
    expect(chains['user_groups'].orFilters).toEqual([SOFT_DELETE_FILTER]);
  });

  it('does NOT filter tables that have no is_deleted column', async () => {
    stub('organization_members', [{ user_id: 'u1' }]);
    stub('task_statuses', [{ id: 's1' }]);

    await run([
      { kind: 'user', id: 'u1' },
      { kind: 'status', id: 's1' },
    ] as IRuleReference[]);

    expect(chains['organization_members'].or).not.toHaveBeenCalled();
    expect(chains['task_statuses'].or).not.toHaveBeenCalled();
  });

  it('rejects a save whose rule points at a soft-deleted field', async () => {
    // Filtered out by the is_deleted guard, so the lookup returns nothing.
    stub('custom_fields', []);

    await expect(
      run([{ kind: 'field', id: 'deleted-field' }] as IRuleReference[]),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
