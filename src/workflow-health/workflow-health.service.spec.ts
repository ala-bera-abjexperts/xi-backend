/**
 * @fileoverview Unit tests for WorkflowHealthService's reference resolution —
 * the query that decides whether a dangling-ref check fires.
 * @module src/workflow-health/workflow-health.service.spec
 * @author Prince Jadiya
 */
import { WorkflowHealthService } from './workflow-health.service';

import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { HandlerRegistryService } from '../workflow-engine/handlers/handler-registry.service';
import type { IRuleReference } from '../workflow-engine/handlers/handler.types';

/** Records every filter applied, and resolves like a PostgREST builder. */
function buildChain(rows: Array<{ id: string }>) {
  const orFilters: string[] = [];
  const chain: Record<string, unknown> = { orFilters };
  const self = () => chain;

  chain.select = jest.fn(self);
  chain.in = jest.fn(self);
  chain.eq = jest.fn(self);
  chain.or = jest.fn((filter: string) => {
    orFilters.push(filter);

    return chain;
  });
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve);

  return chain;
}

describe('WorkflowHealthService.resolveValidRefs', () => {
  let service: WorkflowHealthService;
  let chains: Record<string, ReturnType<typeof buildChain>>;
  let from: jest.Mock;

  const SOFT_DELETE_FILTER = 'is_deleted.is.null,is_deleted.eq.false';

  beforeEach(() => {
    chains = {};
    from = jest.fn((table: string) => {
      chains[table] ??= buildChain([{ id: 'live-1' }]);

      return chains[table];
    });

    service = new WorkflowHealthService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {} as unknown as HandlerRegistryService,
    );
  });

  const resolve = (refs: IRuleReference[]) =>
    (
      service as unknown as {
        resolveValidRefs: (
          orgId: string,
          refs: IRuleReference[],
        ) => Promise<Record<string, Set<string>>>;
      }
    ).resolveValidRefs('org-1', refs);

  it('excludes soft-deleted rows for every soft-deleting ref table', async () => {
    await resolve([
      { kind: 'field', id: 'f1' },
      { kind: 'field_group', id: 'fg1' },
      { kind: 'group', id: 'g1' },
      { kind: 'role', id: 'r1' },
    ] as IRuleReference[]);

    for (const table of [
      'custom_fields',
      'field_groups',
      'user_groups',
      'custom_roles',
    ]) {
      expect(chains[table].orFilters).toEqual([SOFT_DELETE_FILTER]);
    }
  });

  it('does NOT filter tables that have no is_deleted column', async () => {
    await resolve([
      { kind: 'user', id: 'u1' },
      { kind: 'resolution', id: 'res1' },
      { kind: 'category', id: 'c1' },
    ] as IRuleReference[]);

    for (const table of ['users', 'resolutions', 'status_categories']) {
      expect(chains[table].orFilters).toEqual([]);
      expect(chains[table].or).not.toHaveBeenCalled();
    }
  });

  it('reports a soft-deleted field as absent, so the check can fire', async () => {
    // The row exists but is soft-deleted, so the filtered query returns nothing.
    chains['custom_fields'] = buildChain([]);

    const out = await resolve([
      { kind: 'field', id: 'deleted-field' },
    ] as IRuleReference[]);

    expect(out['field'].has('deleted-field')).toBe(false);
  });
});
