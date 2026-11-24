/**
 * @fileoverview Unit tests for AssetObjectsService.list — reference display
 * consistency (a stored reference copy with no edge must not render) and
 * attribute sorting in SQL.
 * @module src/assets-objects/asset-objects.service.spec
 * @author Prince Jadiya
 */
import { AssetObjectsService } from './asset-objects.service';

import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { AssetObjectHistoryService } from './asset-object-history.service';
import type { AssetObjectTypesService } from './asset-object-types.service';
import type { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';

interface Call {
  method: string;
  args: unknown[];
}

interface Chain {
  table: string;
  calls: Call[];
}

type Resolver = (
  table: string,
  calls: Call[],
) => { data: unknown; error: unknown; count?: number };

/**
 * Supabase stand-in: every builder method is recorded and returns the chain;
 * awaiting it resolves through `resolver`, which sees the recorded filters.
 */
function makeClient(resolver: Resolver) {
  const chains: Chain[] = [];

  const from = jest.fn((table: string) => {
    const rec: Chain = { table, calls: [] };

    chains.push(rec);

    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop !== 'string') return undefined;

          if (prop === 'then') {
            return (
              onFulfilled: (v: unknown) => unknown,
              onRejected: (e: unknown) => unknown,
            ) =>
              Promise.resolve(resolver(table, rec.calls)).then(
                onFulfilled,
                onRejected,
              );
          }

          return (...args: unknown[]) => {
            rec.calls.push({ method: prop, args });

            return proxy;
          };
        },
      },
    );

    return proxy;
  });

  return { client: { from }, chains };
}

const hasEq = (calls: Call[], column: string, value?: unknown) =>
  calls.some(
    (c) =>
      c.method === 'eq' &&
      c.args[0] === column &&
      (value === undefined || c.args[1] === value),
  );

describe('AssetObjectsService.list', () => {
  const TYPE_SERVER = 'type-server';
  const TYPE_VENDOR_TEXT = 'type-contract';

  let chains: Chain[];

  function service(resolver: Resolver) {
    const made = makeClient(resolver);

    chains = made.chains;

    return new AssetObjectsService(
      { getClient: () => made.client } as unknown as SupabaseAdminService,
      {} as AssetObjectHistoryService,
      {} as AssetObjectTypesService,
      {} as AutomationEventOutboxService,
    );
  }

  /** Resolver for a page of objects, its edges, and its attribute definitions. */
  function page(opts: {
    objects: Record<string, unknown>[];
    edges?: Record<string, unknown>[];
    refAttrs?: { object_type_id: string; field_key: string }[];
    schemaAttrs?: Record<string, unknown>[];
  }): Resolver {
    return (table, calls) => {
      if (table === 'asset_objects') {
        return { data: opts.objects, error: null, count: opts.objects.length };
      }

      if (table === 'asset_object_references') {
        return { data: opts.edges ?? [], error: null };
      }

      if (table === 'asset_object_type_attributes') {
        if (hasEq(calls, 'data_type', 'object_reference')) {
          return { data: opts.refAttrs ?? [], error: null };
        }

        // resolveFilterableFields reads the whole schema's attributes.
        if (hasEq(calls, 'schema_id')) {
          return { data: opts.schemaAttrs ?? [], error: null };
        }

        return { data: [], error: null }; // formula attributes
      }

      return { data: [], error: null };
    };
  }

  const list = (svc: AssetObjectsService, sortField = 'created_at') =>
    svc.list(
      'schema-1',
      undefined,
      'space-1',
      'org-1',
      'user-1',
      1,
      50,
      sortField as never,
      'asc',
    );

  describe('reference values without an edge', () => {
    it('drops a stale reference copy even when another reference field on the object has an edge', async () => {
      // The live XSD case: `vendor` still shows a name in the stored copy but
      // has no edge, while `owner` on the same object does have one.
      const svc = service(
        page({
          objects: [
            {
              id: 'obj-1',
              object_type_id: TYPE_SERVER,
              attribute_values: {
                vendor: ['Microsoft'],
                owner: ['Old owner'],
                hostname: 'srv-01',
              },
            },
          ],
          edges: [
            {
              source_object_id: 'obj-1',
              attribute: { field_key: 'owner' },
              target_object: { name: 'Current owner' },
            },
          ],
          refAttrs: [
            { object_type_id: TYPE_SERVER, field_key: 'vendor' },
            { object_type_id: TYPE_SERVER, field_key: 'owner' },
          ],
        }),
      );

      const { data } = await list(svc);
      const values = data[0]['attribute_values'] as Record<string, unknown>;

      expect(values).not.toHaveProperty('vendor');
      expect(values['owner']).toEqual(['Current owner']);
      expect(values['hostname']).toBe('srv-01');
    });

    it('drops a stale reference copy when the page has no edges at all', async () => {
      const svc = service(
        page({
          objects: [
            {
              id: 'obj-1',
              object_type_id: TYPE_SERVER,
              attribute_values: { vendor: ['Microsoft'] },
            },
          ],
          refAttrs: [{ object_type_id: TYPE_SERVER, field_key: 'vendor' }],
        }),
      );

      const { data } = await list(svc);

      expect(data[0]['attribute_values']).not.toHaveProperty('vendor');
    });

    it('never clears a same-named key that is plain text on another type', async () => {
      // `vendor` is a reference on Server but a text attribute on Contract.
      const svc = service(
        page({
          objects: [
            {
              id: 'obj-2',
              object_type_id: TYPE_VENDOR_TEXT,
              attribute_values: { vendor: 'Acme Ltd' },
            },
          ],
          refAttrs: [{ object_type_id: TYPE_SERVER, field_key: 'vendor' }],
        }),
      );

      const { data } = await list(svc);

      expect(data[0]['attribute_values']).toEqual({ vendor: 'Acme Ltd' });
    });
  });

  describe('attribute sort', () => {
    const objects = [
      { id: 'obj-1', object_type_id: TYPE_SERVER, attribute_values: {} },
    ];

    const schemaAttrs = [
      { id: 'a-host', field_key: 'hostname', data_type: 'text', options: null },
      {
        id: 'a-vendor',
        field_key: 'vendor',
        data_type: 'object_reference',
        options: null,
      },
    ];

    const objectsChain = () => chains.find((c) => c.table === 'asset_objects')!;

    const orders = () =>
      objectsChain()
        .calls.filter((c) => c.method === 'order')
        .map((c) => c.args);

    it('orders in SQL on the stored value, with a stable tie-breaker', async () => {
      const svc = service(page({ objects, schemaAttrs }));

      await list(svc, 'attr_hostname');

      expect(orders()).toEqual([
        ['attribute_values->>hostname', { ascending: true, nullsFirst: false }],
        ['id', { ascending: true }],
      ]);
      expect(objectsChain().calls).toContainEqual({
        method: 'range',
        args: [0, 49],
      });
    });

    it('falls back to the default column for an attribute that cannot be sorted in SQL', async () => {
      const svc = service(page({ objects, schemaAttrs }));

      await list(svc, 'attr_vendor');

      expect(orders()).toEqual([['created_at', { ascending: true }]]);
    });

    it('falls back to the default column for an unknown attribute', async () => {
      const svc = service(page({ objects, schemaAttrs }));

      await list(svc, 'attr_does_not_exist');

      expect(orders()).toEqual([['created_at', { ascending: true }]]);
    });

    it('leaves a base-column sort unchanged and skips the attribute lookup', async () => {
      const svc = service(page({ objects, schemaAttrs }));

      await list(svc, 'updated_at');

      expect(orders()).toEqual([['updated_at', { ascending: true }]]);

      const schemaLookup = chains.some(
        (c) =>
          c.table === 'asset_object_type_attributes' &&
          hasEq(c.calls, 'schema_id'),
      );

      expect(schemaLookup).toBe(false);
    });
  });
});
