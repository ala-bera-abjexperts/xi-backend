/**
 * @fileoverview Integrity of the generated foreign-key graph.
 * @module src/backup/registry/restore-fk-graph.spec
 *
 * The graph is generated, so these tests are not about whether the edges are right — the database
 * decided that. They are about the two ways a generated file goes wrong later: it drifts out of step
 * with the registry it is supposed to describe, and someone reads it as an instruction rather than a
 * description.
 */

import { COMPONENT_REGISTRY } from './component-registry';
import {
  RESTORE_FK_GRAPH,
  fkEdgesFor,
  isReferencedTable,
} from './restore-fk-graph';

const REGISTRY_TABLES = new Set(COMPONENT_REGISTRY.map((entry) => entry.table));

describe('restore FK graph', () => {
  it('only describes tables the registry can restore', () => {
    // An edge naming a table the registry does not know is drift: either the graph was regenerated
    // against a newer schema than the registry, or a table was dropped from the registry and its
    // edges left behind. Either way a remap would look up a table nothing will ever write.
    const unknown = RESTORE_FK_GRAPH.filter(
      (edge) =>
        !REGISTRY_TABLES.has(edge.table) ||
        !REGISTRY_TABLES.has(edge.references),
    );

    expect(unknown).toEqual([]);
  });

  it('indexes every edge exactly once', () => {
    const indexed = [...REGISTRY_TABLES].reduce(
      (total, table) => total + fkEdgesFor(table).length,
      0,
    );

    expect(indexed).toBe(RESTORE_FK_GRAPH.length);
  });

  it('answers with an empty list for a table that references nothing', () => {
    // Not an error and not a special case — most leaf tables carry no reference into another
    // restorable table at all, and the caller must be able to ask without checking first.
    expect(fkEdgesFor('no_such_table')).toEqual([]);
  });

  /**
   * The trap this file's header warns about, pinned as a test so it cannot be forgotten.
   *
   * `spaces` is restorable, so `space_id` looks exactly like any other reference into the restore
   * set. It is not one: the destination space is chosen by the operator, so the space column is
   * ASSIGNED, never looked up here. A future change that walks these edges blindly would silently
   * re-point every row at whatever id happened to be minted for a space.
   */
  it('still contains space_id edges, which the consumer must assign rather than remap', () => {
    const spaceEdges = RESTORE_FK_GRAPH.filter(
      (edge) => edge.references === 'spaces',
    );

    expect(spaceEdges.length).toBeGreaterThan(0);
    expect(
      spaceEdges.some(
        (edge) => edge.table === 'form_builder' && edge.column === 'space_id',
      ),
    ).toBe(true);
  });

  it('records the self-references that have to be seeded before their table is written', () => {
    // A row pointing at another row of its own table cannot be resolved by insert order, so these
    // are the cases `seedIds` has to mint ids for up front. Insert-then-update is not an option:
    // `tasks_history_trigger` fires on UPDATE and would manufacture a history row per task.
    const selfReferences = RESTORE_FK_GRAPH.filter(
      (edge) => edge.table === edge.references,
    );

    expect(selfReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'tasks', column: 'parent_task_id' }),
        expect.objectContaining({ table: 'wiki_pages', column: 'parent_id' }),
        expect.objectContaining({
          table: 'business_processes',
          column: 'parent_id',
        }),
      ]),
    );
  });

  /**
   * The tables from the run that restored 0 of 305 rows.
   *
   * Each was refused `other_space` for want of a hand-written spec, or `unmapped_reference` because
   * its parent had been. Their edges are what lets that be derived instead of hand-listed, so if
   * these ever vanish from the graph the original bug is back.
   */
  it('carries the references the failing restore needed', () => {
    const edge = (table: string, column: string) =>
      fkEdgesFor(table).find((entry) => entry.column === column);

    expect(edge('form_builder_fields', 'form_id')).toMatchObject({
      references: 'form_builder',
      required: true,
    });
    expect(edge('form_builder_webhooks', 'form_id')).toMatchObject({
      references: 'form_builder',
      required: true,
    });
    expect(edge('form_builder_integrations', 'form_id')).toMatchObject({
      references: 'form_builder',
      required: true,
    });
    expect(edge('form_builder_webhook_deliveries', 'webhook_id')).toMatchObject(
      { references: 'form_builder_webhooks', required: true },
    );
    expect(
      edge('form_builder_integration_deliveries', 'integration_id'),
    ).toMatchObject({
      references: 'form_builder_integrations',
      required: true,
    });
    expect(
      edge('automation_event_subscriptions', 'automation_id'),
    ).toMatchObject({ references: 'automations', required: true });
  });

  it.each(['test_cases', 'test_sets', 'test_plans', 'test_executions'])(
    'makes the ticket a required parent of %s',
    (table) => {
      expect(
        fkEdgesFor(table).find((edge) => edge.column === 'task_id'),
      ).toMatchObject({ references: 'tasks', required: true });
    },
  );

  it.each(['test_cases', 'test_sets', 'test_plans', 'test_executions'])(
    'lets %s follow its folder, which is optional',
    (table) => {
      expect(
        fkEdgesFor(table).find((edge) => edge.column === 'folder_id'),
      ).toMatchObject({ references: 'test_folders', required: false });
    },
  );

  it('keeps a precondition without a ticket, and a token only with its key', () => {
    expect(
      fkEdgesFor('test_preconditions').find((e) => e.column === 'task_id'),
    ).toMatchObject({ references: 'tasks', required: false });
    expect(
      fkEdgesFor('test_management_api_tokens').find(
        (e) => e.column === 'key_id',
      ),
    ).toMatchObject({ references: 'test_management_api_keys', required: true });
  });

  it('knows which tables are pointed at, so re-keying one is known to orphan others', () => {
    expect(isReferencedTable('form_builder')).toBe(true);
    expect(isReferencedTable('tasks')).toBe(true);

    // A leaf: nothing refers to a delivery row, so re-keying one cannot break anything else.
    expect(isReferencedTable('form_builder_webhook_deliveries')).toBe(false);
  });
});
