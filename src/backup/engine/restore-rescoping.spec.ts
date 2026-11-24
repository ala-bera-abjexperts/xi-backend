/**
 * @fileoverview Deriving what may move into another space, and the order it must be written in.
 * @module src/backup/engine/restore-rescoping.spec
 *
 * These two behaviours used to be hand-maintained lists, and both were wrong in the same run: a
 * restore of 305 rows inserted none. 181 rows were refused `other_space` because their table was
 * missing from a thirteen-entry spec map, and 124 more were refused `unmapped_reference` because
 * `insertLevel` put children ahead of their parents. Neither list could be checked against anything.
 *
 * What replaces them is derived — from the registry's `spaceScope` and from a foreign-key graph
 * generated out of `pg_constraint` — so the tests below are about the derivation staying honest,
 * not about the contents of a list.
 */

import { COMPONENT_REGISTRY, tableEntry } from '../registry/component-registry';
import {
  CROSS_ORG_REMAP_SPECS,
  CROSS_ORG_TABLE_ORDER,
  crossOrgRestorableTables,
  remapSpecFor,
  createRemapState,
  remapRow,
  seedIds,
  type RemapPlan,
} from './restore-id-remapper';
import { buildRestoreComponentTree } from './restore-component-tree';
import { orderForInsert } from './restore-planner';
import { fkEdgesFor } from '../registry/restore-fk-graph';

/** The registry entry, which every one of these tables has. */
function entryFor(table: string) {
  const entry = tableEntry(table);

  if (!entry) {
    throw new Error(`${table} is not in the registry`);
  }

  return entry;
}

const specFor = (table: string, crossOrganization = false) =>
  remapSpecFor(table, entryFor(table), crossOrganization);

describe('deriving a remap spec', () => {
  it('prefers a hand-written spec, which carries what a foreign key cannot', () => {
    // `form_builder.settings` holds ids inside jsonb, and no constraint describes that. A derived
    // spec would silently drop it.
    expect(specFor('form_builder')).toBe(CROSS_ORG_REMAP_SPECS.form_builder);
  });

  it('derives one for a table nobody wrote a spec for', () => {
    // 18 of these were refused `other_space` in the failing run, purely for being absent from a map.
    const spec = specFor('form_builder_fields');

    expect(spec).toBeDefined();
    expect(spec?.spaceColumn).toBe('space_id');
    // `referencesTable` comes from the FK graph and is what lets an unmapped reference be told apart
    // from an invalid one — a target this run is re-keying versus one it is not touching at all.
    expect(spec?.rowReferences).toContainEqual({
      column: 'form_id',
      required: true,
      referencesTable: 'form_builder',
    });
  });

  it('never treats the space or the tenant as a reference to look up', () => {
    // Both are ASSIGNED from the destination. `spaces` is itself a restorable table, so `space_id`
    // otherwise looks exactly like any other reference into the restore set — and remapping it
    // would point every row at whatever id happened to be minted for a space.
    const columns = specFor('form_builder_fields')?.rowReferences.map(
      (reference) => reference.column,
    );

    expect(columns).not.toContain('space_id');
    expect(columns).not.toContain('organization_id');
  });

  it('leaves organization-level references alone', () => {
    // `boards.filter_id` points at `saved_filters`, which the registry scopes to the organization —
    // one filter, shared by every space in the tenant. An unmapped row reference is NULLED, so
    // treating it as one would quietly strip a restored board of its filter even though the filter
    // is still there and still ours. The hand-written specs say the same thing about statuses and
    // priorities by listing them under `configReferences` instead.
    //
    // Note this is decided by the TARGET's scope, not the column's name: `task_statuses` and
    // `custom_fields` look like lookups but are `{ kind: 'own' }`, genuinely space-scoped, and a
    // reference to one left behind must be cleared like any other.
    const columns = specFor('boards')?.rowReferences.map(
      (reference) => reference.column,
    );

    expect(columns).not.toContain('filter_id');
  });

  it('refuses to re-key organization-level rows on a move between spaces', () => {
    // `risk_configurations` is organization-scoped: the row is already correct and already shared,
    // so minting a new id for it would write a second copy of something nothing asked to duplicate.
    expect(specFor('risk_configurations', false)).toBeUndefined();
  });

  it('does re-key them when the tenant changes, where the old id belongs to somebody else', () => {
    expect(specFor('risk_configurations', true)).toBeDefined();
  });

  it('clears keys the destination reissues itself', () => {
    // `generate_board_key` only fires `IF NEW.board_key IS NULL`, so a copied key leaves the trigger
    // silent and collides on `idx_boards_key_unique (space_id, board_key)` — a new row id does
    // nothing to help. Same shape as `tasks.key`, which the hand-written spec already regenerates.
    expect(specFor('boards')?.regenerateColumns).toContain('board_key');
    expect(specFor('business_processes')?.regenerateColumns).toContain('key');

    // `asset_objects_key_unique (organization_id, schema_id, object_key)` has no space in it, so a
    // move into another space of the SAME organization landed on the original's key and the row was
    // skipped — a row the destination space did not have, lost to a duplicate report.
    expect(specFor('asset_objects')?.regenerateColumns).toContain('object_key');
  });

  it('clears those keys for BOTH kinds of move, not just a change of tenant', () => {
    // The two destinations a row can be folded into are another space of this organization and
    // another organization entirely. A carried key collides in both, so neither may keep it.
    for (const crossOrganization of [false, true]) {
      expect(
        specFor('asset_objects', crossOrganization)?.regenerateColumns,
      ).toContain('object_key');
      expect(specFor('boards', crossOrganization)?.regenerateColumns).toContain(
        'board_key',
      );
    }
  });
});

describe('insert order', () => {
  const planned = (levels: Record<string, number>) =>
    Object.entries(levels).map(([table, insertLevel]) => ({
      table,
      insertLevel,
    }));

  const order = (levels: Record<string, number>) =>
    orderForInsert(planned(levels) as never).map((entry) => entry.table);

  it('writes a parent before the child that points at it, whatever the registry level says', () => {
    // The exact inversion that refused all 5 orders: `form_builder_orders` at level 1, ahead of the
    // `form_builder` at 3 and the `form_builder_submissions` at 6 that its rows require.
    const sorted = order({
      form_builder_orders: 1,
      form_builder: 3,
      form_builder_submissions: 6,
    });

    expect(sorted.indexOf('form_builder')).toBeLessThan(
      sorted.indexOf('form_builder_orders'),
    );
    expect(sorted.indexOf('form_builder_submissions')).toBeLessThan(
      sorted.indexOf('form_builder_orders'),
    );
  });

  it('orders a table whose references the database does not enforce', () => {
    // `task_relationships.source_id` carries no foreign key at all, so no generated graph can see
    // it. Level 2 put it ahead of `tasks` at 5.
    const sorted = order({ task_relationships: 2, tasks: 5 });

    expect(sorted).toEqual(['tasks', 'task_relationships']);
  });

  it('orders a chain of three', () => {
    const sorted = order({
      form_builder_webhook_deliveries: 1,
      form_builder_webhooks: 1,
      form_builder: 3,
    });

    expect(sorted).toEqual([
      'form_builder',
      'form_builder_webhooks',
      'form_builder_webhook_deliveries',
    ]);
  });

  it('terminates on a cycle rather than recursing for ever', () => {
    // `wiki_pages` and `ai_generated_content` genuinely point at each other. The engine resolves
    // those with a nullable back-edge and a deferred second pass; ordering only has to not hang.
    expect(() =>
      order({ wiki_pages: 9, ai_generated_content: 1 }),
    ).not.toThrow();
    expect(order({ wiki_pages: 9, ai_generated_content: 1 })).toHaveLength(2);
  });

  it('leaves tables the graph cannot separate in their existing order', () => {
    // No dependency between them, so the registry level still decides — a change here must not
    // quietly rearrange tables it knows nothing about.
    expect(order({ boards: 3, risk_configurations: 1 })).toEqual([
      'risk_configurations',
      'boards',
    ]);
  });
});

/**
 * Encrypted credentials, and where they are allowed to end up.
 *
 * `form_builder_webhooks` and `form_builder_integrations` were kept out of re-scoping entirely
 * because they hold one — which also meant their 119 delivery rows could never be restored.
 * `form_builder_payment_configs` was never excluded at all; it simply had no spec, so nothing had
 * ever looked at it, and it holds TWO: a Stripe key that can take payments and a webhook signing
 * secret. Deriving specs from the schema makes all three movable at once, so this is the guard that
 * keeps the credentials from moving with them.
 */
describe('secrets crossing an organization boundary', () => {
  const secretsOf = (table: string, crossOrganization: boolean) =>
    remapSpecFor(table, entryFor(table), crossOrganization)
      ?.regenerateColumns ?? [];

  it('clears every credential column when the tenant changes', () => {
    expect(secretsOf('form_builder_payment_configs', true)).toEqual(
      expect.arrayContaining([
        'secret_encrypted',
        'secret_iv',
        'secret_tag',
        'webhook_secret_encrypted',
        'webhook_secret_iv',
        'webhook_secret_tag',
      ]),
    );
    expect(secretsOf('form_builder_webhooks', true)).toEqual(
      expect.arrayContaining(['secret_encrypted', 'secret_iv', 'secret_tag']),
    );
    expect(secretsOf('form_builder_integrations', true)).toEqual(
      expect.arrayContaining(['secret_encrypted', 'secret_iv', 'secret_tag']),
    );
  });

  it('keeps them on a move between spaces of the same organization', () => {
    // The secret has not left the tenant that owns it, and wiping it would break a working
    // integration to solve a problem that does not exist.
    expect(secretsOf('form_builder_payment_configs', false)).not.toContain(
      'secret_encrypted',
    );
    expect(secretsOf('form_builder_webhooks', false)).not.toContain(
      'secret_encrypted',
    );
  });

  it('does not clear anything it was not asked to on a table with no secrets', () => {
    expect(secretsOf('form_builder_fields', true)).toEqual([]);
    expect(secretsOf('boards', true)).toEqual(['board_key']);
  });
});

/**
 * Tables that are never carried into another space, and why each one is not.
 *
 * These were introduced by making re-scoping generic: deriving a spec from `spaceScope` quietly
 * began covering tables that must not move — ones the database numbers itself, and `spaces` itself.
 *
 * The reasons are genuinely different and are kept as separate constants so that neither can be
 * widened by a change aimed at the other.
 */
describe('what may not be re-keyed at all', () => {
  it('moves automation history instead of refusing it, now the hazard is neutralised', () => {
    // This test used to assert the opposite, and the refusal it pinned cost 44 rows on every single
    // space-move restore — reported as "Belongs to another space" against destinations that held
    // none of them, on ten consecutive runs.
    //
    // Two justifications were given for it. The mechanical one was simply false: `id` is
    // `bigint DEFAULT nextval(...)` with `attidentity = ''`, a plain default, so omitting the column
    // lets the destination assign one. The PRODUCT one was real — the relay drain selects
    // `relayed_at IS NULL` with no organization or space filter and matches subscriptions on the
    // row's OWN space_id, which re-scoping rewrites, so an unrelayed row would fire the destination
    // space's automations for real.
    //
    // What changed is that the hazard is now neutralised on the row rather than avoided by refusing
    // the table: `SEQUENCE_REKEYED_TABLES` guarantees `relayed_at` is non-null, which puts the row
    // permanently outside what that predicate can select.
    expect(specFor('automation_event_outbox', false)).toBeDefined();
    expect(specFor('automation_event_outbox', true)).toBeDefined();

    // Re-scoping is the whole point: the row has to arrive owning the destination's space and
    // tenant, and it has no other reference to repoint.
    expect(specFor('automation_event_outbox', false)?.spaceColumn).toBe(
      'space_id',
    );
    expect(specFor('automation_event_outbox', false)?.tenantColumn).toBe(
      'organization_id',
    );
    expect(specFor('automation_event_outbox', false)?.rowReferences).toEqual(
      [],
    );
  });

  it('refuses a table with no row id to reissue', () => {
    // `partner_document_sequences` has no `id` column at all — its key is
    // (organization_id, doc_type, year), so there is nothing for re-scoping to mint.
    expect(specFor('partner_document_sequences', false)).toBeUndefined();
    expect(specFor('partner_document_sequences', true)).toBeUndefined();
  });

  it('refuses a GENERATED ALWAYS identity column', () => {
    // `migration_logs.id` is GENERATED ALWAYS (verified: pg_attribute.attidentity = 'a'), so
    // PostgREST cannot write the key at all — every insert answers `428C9`.
    //
    // Load-bearing, not tidy: `migration_logs` has a tenantColumn, so once it moved out of the old
    // NON_UUID list it cleared every remaining guard in `remapSpecFor` and began returning a spec.
    // That would have silently added it to CROSS_ORG_SUPPORTED_TABLES — offering an owner an
    // approval for a table whose every row is guaranteed to fail.
    //
    // `support_requests` used to be asserted alongside it and no longer is, because the two are not
    // the same case. What is GENERATED ALWAYS there is `ticket_number`, not the key: the row's `id`
    // is a uuid that re-keys cleanly, so the column can simply be withheld and let the destination
    // assign a fresh number — which is what listing it in `GENERATED_COLUMNS` now does. A generated
    // PRIMARY KEY, as `migration_logs` has, cannot be withheld, because then there is no key.
    expect(specFor('migration_logs', false)).toBeUndefined();
    expect(specFor('migration_logs', true)).toBeUndefined();
  });

  it('never re-keys spaces itself', () => {
    // A destination space is CHOSEN by the operator. Minting a new id for it is the one outcome a
    // restore into a space must never produce. `refuseUnmovableRow` also rejects `kind: 'self'`
    // earlier, but the invariant belongs where the decision is made.
    expect(specFor('spaces', false)).toBeUndefined();
    expect(specFor('spaces', true)).toBeUndefined();
  });
});

/**
 * The cross-organization gate and the engine must describe the same set.
 *
 * `restore-approvals.service.ts` refuses a request naming a table the engine cannot move, so an
 * owner is never asked to approve something that would then be declined mid-run. That set was a
 * hand-kept copy of thirteen spec names and did not follow the engine when it began deriving specs
 * from the schema — so a cross-organization restore of `form_builder_fields` was refused at the
 * door by a rule that no longer described what the engine could do.
 */
describe('cross-organization gate', () => {
  it('permits exactly the tables the engine can rewrite', () => {
    const engineCanMove = COMPONENT_REGISTRY.filter((entry) =>
      remapSpecFor(entry.table, entry, true),
    ).map((entry) => entry.table);

    // The tables from the failing run, which the old thirteen-entry set excluded.
    expect(engineCanMove).toEqual(
      expect.arrayContaining([
        'form_builder_fields',
        'form_builder_webhooks',
        'form_builder_integrations',
        'automation_event_subscriptions',
        'form_builder_payment_configs',
      ]),
    );

    // And still excludes what cannot be moved, so widening the gate did not widen it blindly.
    expect(engineCanMove).not.toContain('spaces');

    // `automation_event_outbox` is deliberately no longer asserted out. Its key is a plain sequence
    // the destination reissues, and the re-fire hazard is neutralised on the row by
    // `SEQUENCE_REKEYED_TABLES`, so the engine genuinely can move it — and the gate and the picker,
    // which both read this derivation, should now offer it.
    expect(engineCanMove).toContain('automation_event_outbox');

    // Identity-column tables must stay out too. `migration_logs` is the one that would slip: it
    // carries a tenantColumn, so nothing else in `remapSpecFor` stops it, and admitting it here
    // would let an owner approve a cross-organization restore of a table that answers `428C9` to
    // every insert.
    expect(engineCanMove).not.toContain('migration_logs');
    expect(engineCanMove).not.toContain('partner_document_sequences');

    // `support_requests` moved INTO this set deliberately. Its `id` is a uuid, its only unique index
    // is that primary key, and `ticket_number` is withheld as a generated column, so the engine
    // genuinely can rewrite it. It was held back on a disclosure policy — a ticket names a person
    // and an incident — which the product owner has since reversed.
    expect(engineCanMove).toContain('support_requests');
  });

  /**
   * A credential that cannot be left behind keeps its row at home.
   *
   * `SECRET_COLUMNS` clears a secret by leaving the column out of the insert, which only works where
   * the column is nullable or defaulted. These four are `NOT NULL` with no default, so the row
   * cannot arrive inert — it either carries the source tenant's credential or fails to insert. They
   * are refused instead. Same-organization space moves are unaffected: the secret has not left the
   * tenant that owns it.
   */
  it('refuses tables whose secret cannot be cleared on the way across', () => {
    for (const table of [
      'ai_provider_configs',
      'automation_connections',
      'automation_oauth_states',
      'migration_connections',
    ]) {
      expect(specFor(table, true)).toBeUndefined();
    }

    // Same-organization is untouched. Only the two that live in a space are asserted here:
    // `ai_provider_configs` and `migration_connections` are organization-scoped, so they have no
    // spec on a space move either — for the unrelated reason that an org-level row does not move
    // between spaces at all.
    expect(specFor('automation_connections', false)).toBeDefined();
    expect(specFor('automation_oauth_states', false)).toBeDefined();
  });

  /**
   * The exhaustive statement. The assertions above name individual tables and would keep passing if
   * something new quietly stopped moving; this one fails the moment the set changes at all, which is
   * what makes it safe for the restore picker to be driven from it.
   */
  it('excludes exactly eleven tables and nothing else', () => {
    const refused = COMPONENT_REGISTRY.filter(
      (entry) => !remapSpecFor(entry.table, entry, true),
    ).map((entry) => entry.table);

    // Was nine, then eight. `automation_event_outbox` left when its key became reissuable and its
    // re-fire hazard was neutralised on the row — see `SEQUENCE_REKEYED_TABLES`.
    //
    // `support_requests` left next, and for a different kind of reason: nothing about it changed,
    // the policy did. It was withheld because a ticket names a person and an incident, which is a
    // disclosure decision rather than an engine limit — its `id` is a uuid, its only unique index is
    // that primary key, and `ticket_number` is withheld as a generated column. The product owner
    // reversed the decision, so it moves.
    //
    // Both are offerable in the picker and acceptable to the approval gate as a result: those read
    // this same derivation.
    //
    // Eleven with ci_servers and the two Test Management API key tables: NOT NULL credentials that
    // never cross into another organization (MANDATORY_SECRET_TABLES).
    expect([...refused].sort()).toEqual([
      'ai_provider_configs',
      'automation_connections',
      'automation_oauth_states',
      'ci_servers',
      'migration_connections',
      'migration_logs',
      'partner_document_sequences',
      'spaces',
      'test_management_api_keys',
      'test_management_api_tokens',

      // Newly registered, and refused here for a reason worth naming rather than absorbing: it has
      // no tenant column AND does not live in a space, so `remapSpecFor` treats it as global and
      // returns nothing. That guard is too coarse for a parent-scoped table — its `group_id` points
      // at `user_groups`, which IS re-keyed, so it could follow its parent. Registering it fixes the
      // same-organization bug it was added for (groups restoring EMPTY); making it movable is a
      // separate change to the guard.
      'user_group_members',
    ]);
  });

  /**
   * The gate and the picker must be the same set, or the drift this whole describe block exists to
   * prevent simply moves one layer up — which is exactly what happened: the wizard carried a
   * four-name literal while the engine moved 176 tables.
   */
  it('publishes the same set to the restore picker', () => {
    const published = new Set<string>();

    for (const tier of buildRestoreComponentTree().tiers) {
      for (const component of tier.components) {
        for (const [table, movable] of Object.entries(
          component.tableCrossOrgRestorable,
        )) {
          if (movable) {
            published.add(table);
          }
        }
      }
    }

    expect([...published].sort()).toEqual(
      [...crossOrgRestorableTables()].sort(),
    );
  });
});

/**
 * The documented order and the computed one must agree.
 *
 * `CROSS_ORG_TABLE_ORDER` is the readable statement of how these tables have to be written. It is no
 * longer an input — the planner derives depth from the FK graph — so without this it would be a
 * comment that slowly stops being true, which is exactly what it was before: it described the
 * refusals as expected behaviour long after they had become a bug.
 */
describe('documented order matches the planner', () => {
  it('never places a table before something it depends on', () => {
    const tables = [...CROSS_ORG_TABLE_ORDER];
    const sorted = orderForInsert(
      tables.map((table) => ({
        table,
        insertLevel: entryFor(table).insertLevel,
      })) as never,
    ).map((entry) => entry.table);

    for (const table of tables) {
      const parents = fkEdgesFor(table)
        .filter(
          (edge) =>
            edge.references !== table &&
            edge.references !== 'spaces' &&
            tables.includes(edge.references as (typeof tables)[number]),
        )
        .map((edge) => edge.references);

      for (const parent of parents) {
        expect(sorted.indexOf(parent)).toBeLessThan(sorted.indexOf(table));
      }
    }
  });
});

/**
 * A required reference to a table this restore is not carrying.
 *
 * This cost 103 rows on a real restore. `automation_runs.automation_id` and
 * `automation_event_subscriptions.automation_id` point at `automations`, which was not in the
 * archive — it lives in a different component and scheme selection is stored exactly as ticked. The
 * automations were never deleted though: every one of them was still in the database, in the space
 * the rows came from. Refusing the rows discarded them to protect a reference that was already
 * valid.
 */
describe('a required reference to a table outside the restore', () => {
  const SRC = 'org-src';
  const DST = 'org-dst';

  const planFor = (targetOrganizationId: string): RemapPlan => ({
    archiveOrganizationId: SRC,
    targetOrganizationId,
    destinationSpaceId: 'space-dst',
    config: new Map(),
  });

  const run = (
    row: Record<string, unknown>,
    tablesInRun: string[],
    org: string,
  ) =>
    remapRow(
      { organization_id: SRC, space_id: 'space-old', ...row },
      remapSpecFor(
        'automation_runs',
        entryFor('automation_runs'),
        org !== SRC,
      ) as never,
      planFor(org),
      createRemapState(new Map(), new Set(tablesInRun)),
    );

  it('keeps the archived id when the target is not being re-keyed, in the same organization', () => {
    // `automations` is not in the run, so nothing minted an id for it and nothing moved it. The row
    // it names is still there, under exactly this id.
    const outcome = run(
      { id: 'run-1', automation_id: 'auto-1', automation_version_id: 'ver-1' },
      ['automation_runs'],
      SRC,
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.automation_id).toBe('auto-1');
    expect(outcome.row.automation_version_id).toBe('ver-1');
    expect(outcome.row.id).not.toBe('run-1');
  });

  it('still refuses when the target IS being re-keyed but has no mapping', () => {
    // `automations` is in the run, so it was given a new id. Keeping the archived one would point
    // the restored row back at the space it came from — an ordering problem, not a valid reference.
    const outcome = run(
      { id: 'run-1', automation_id: 'auto-1', automation_version_id: 'ver-1' },
      ['automation_runs', 'automations'],
      SRC,
    );

    expect(outcome.kind).toBe('skip');

    if (outcome.kind !== 'skip') return;

    expect(outcome.reason).toBe('unmapped_reference');
  });

  it('still refuses across organizations, where the archived id belongs to somebody else', () => {
    // Nothing in the destination tenant answers to `auto-1`. Keeping it would either violate the
    // constraint or match an unrelated row that happens to share the id.
    const outcome = run(
      { id: 'run-1', automation_id: 'auto-1', automation_version_id: 'ver-1' },
      ['automation_runs'],
      DST,
    );

    expect(outcome.kind).toBe('skip');

    if (outcome.kind !== 'skip') return;

    expect(outcome.reason).toBe('unmapped_reference');
  });
});

/**
 * `file_attachments.entity_id` and `entity_file_links.entity_id`, which no foreign key describes.
 *
 * The failure these pin was reported as a success. A restore into an empty destination space marked
 * three attachments "Skipped — already present" and finished green, and the space held nothing of the
 * kind. `entity_id` is polymorphic, paired with `entity_type`, so `pg_constraint` returns no edge for
 * it and the derived spec never touched it: the row was written with a fresh `id` and the destination
 * `space_id` while still naming the task it hung off in the SOURCE space. Neither table scopes its
 * unique key — `UNIQUE (entity_type, entity_id, file_name)` has no `space_id` — so the insert collided
 * with the row it had been copied from, Postgres answered 23505, and the writer filed that under
 * `duplicate`.
 *
 * Two halves, and either alone still loses the rows. Without the remapping the id points at the source
 * space; without `LOGICAL_DEPENDENCIES` the attachments are written at level 3 ahead of tasks at 5, so
 * the mapping does not exist yet and every row is refused `unmapped_reference` instead.
 */
describe('polymorphic entity references', () => {
  const SRC = 'org-src';
  const DST = 'org-dst';

  const planFor = (targetOrganizationId: string): RemapPlan => ({
    archiveOrganizationId: SRC,
    targetOrganizationId,
    destinationSpaceId: 'space-dst',
    config: new Map(),
  });

  /** Mints an id for every seeded row first, as the writer does before a table is walked. */
  const run = (
    table: string,
    row: Record<string, unknown>,
    tablesInRun: string[],
    org: string,
    seeded: string[] = [],
  ) => {
    const state = createRemapState(new Map(), new Set(tablesInRun));

    seedIds(
      seeded.map((id) => ({ id })),
      state,
    );

    return {
      state,
      outcome: remapRow(
        { organization_id: SRC, space_id: 'space-old', ...row },
        remapSpecFor(table, entryFor(table), org !== SRC) as never,
        planFor(org),
        state,
      ),
    };
  };

  it('is written after the entities it names, whatever the registry level says', () => {
    // The second half of the bug. `file_attachments` sits at 3 and `entity_file_links` at 4, both
    // ahead of `tasks` at 5, so the mapping the remapping below depends on did not exist yet.
    const sorted = orderForInsert([
      { table: 'file_attachments', insertLevel: 3 },
      { table: 'entity_file_links', insertLevel: 4 },
      { table: 'tasks', insertLevel: 5 },
    ] as never).map((entry) => entry.table);

    expect(sorted.indexOf('tasks')).toBeLessThan(
      sorted.indexOf('file_attachments'),
    );
    expect(sorted.indexOf('tasks')).toBeLessThan(
      sorted.indexOf('entity_file_links'),
    );
  });

  it('repoints an attachment at the task this run re-keyed', () => {
    const { state, outcome } = run(
      'file_attachments',
      {
        id: 'attachment-1',
        entity_type: 'task',
        entity_id: 'task-1',
        file_name: 'download (1) (1).gif',
      },
      ['file_attachments', 'tasks'],
      SRC,
      ['task-1'],
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.entity_id).toBe(state.ids.get('task-1'));
    expect(outcome.row.entity_id).not.toBe('task-1');
  });

  it('resolves the target table per row, not per spec', () => {
    // The whole reason `typeToTable` exists rather than `mappableTypes`: one column, and the table it
    // names changes with `entity_type`. An asset object here, a task above, from the same spec.
    const { state, outcome } = run(
      'entity_file_links',
      {
        id: 'link-1',
        entity_type: 'asset_object',
        entity_id: 'object-1',
        node_id: 'node-1',
      },
      ['entity_file_links', 'asset_objects'],
      SRC,
      ['object-1'],
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.entity_id).toBe(state.ids.get('object-1'));
  });

  /**
   * The trap that made the obvious fix destructive.
   *
   * `gdpr_records` is organization-level and `restoreByDefault`, so a move between spaces of one
   * tenant does not re-key it — yet `tablesInRun` lists it like everything else the run is writing.
   * Asking only "is the target in the run" therefore found it present, found no mapping (there is
   * never going to be one), and dropped every GDPR attachment as a required reference that could not
   * be resolved. The question has to be whether the target is being RE-KEYED.
   */
  it('keeps the archived id for an entity the move does not re-key', () => {
    const { outcome } = run(
      'file_attachments',
      {
        id: 'attachment-1',
        entity_type: 'gdpr_record',
        entity_id: 'gdpr-1',
        file_name: 'consent.pdf',
      },
      ['file_attachments', 'gdpr_records'],
      SRC,
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.entity_id).toBe('gdpr-1');
  });

  it('keeps the archived id for an entity outside the restore entirely', () => {
    const { outcome } = run(
      'file_attachments',
      {
        id: 'attachment-1',
        entity_type: 'wiki_page',
        entity_id: 'page-1',
        file_name: 'diagram.png',
      },
      ['file_attachments'],
      SRC,
    );

    expect(outcome.kind === 'insert' && outcome.row.entity_id).toBe('page-1');
  });

  it('refuses across organizations, where the archived id is another tenant’s', () => {
    // Today this row is written with `entity_id` still naming the source tenant's task — the
    // cross-tenant pointer the remapper exists to prevent, arriving through the one column it could
    // not see.
    const { outcome } = run(
      'file_attachments',
      {
        id: 'attachment-1',
        entity_type: 'task',
        entity_id: 'task-1',
        file_name: 'download (1) (1).gif',
      },
      ['file_attachments'],
      DST,
    );

    expect(outcome.kind).toBe('skip');

    if (outcome.kind !== 'skip') return;

    expect(outcome.reason).toBe('unmapped_reference');
  });

  it('degrades rather than misbehaves on a type the map does not know', () => {
    // Unreachable while the CHECK constraints hold. If one gains a member ahead of the map, the row
    // takes the same path as a target outside the run instead of being silently mis-pointed.
    const { outcome } = run(
      'file_attachments',
      {
        id: 'attachment-1',
        entity_type: 'something_new',
        entity_id: 'thing-1',
        file_name: 'file.bin',
      },
      ['file_attachments', 'tasks'],
      SRC,
    );

    expect(outcome.kind === 'insert' && outcome.row.entity_id).toBe('thing-1');
  });

  it('adds the polymorphic column WITHOUT displacing what the FK graph supplies', () => {
    // A hand-written spec would have replaced the derived one wholesale and dropped these. The
    // registry is merged into the derived spec precisely so both survive.
    const columns = (table: string) =>
      specFor(table)?.rowReferences.map((reference) => reference.column);

    expect(columns('file_attachments')).toEqual(
      expect.arrayContaining(['current_version_id', 'entity_id']),
    );
    expect(columns('entity_file_links')).toEqual(
      expect.arrayContaining(['node_id', 'entity_id']),
    );
  });
});

/**
 * Resolving a parent an EARLIER run wrote, and the two places that must NOT start doing so.
 *
 * A repeat restore recognises rows it already wrote and skips them — correctly. Their children then
 * looked the parent up, found nothing, and were refused `unmapped_reference`: on a real run
 * `form_builder` was skipped as already present and its 12 assignments and 6 orders were discarded
 * for pointing at it. The lookup that closes this is keyed `"<table> <sourceId>"`, so it needs the
 * reference to name its table.
 */
describe('a parent restored by an earlier run', () => {
  it('names the table for every hand-written reference, matching the real foreign key', () => {
    // Checked against the GENERATED graph, not a second hand-written list — `restore-fk-graph.ts` is
    // produced from `pg_constraint`, so a renamed or mistyped target fails here instead of silently
    // resolving against a table that does not hold the row.
    for (const spec of Object.values(CROSS_ORG_REMAP_SPECS)) {
      const edges = fkEdgesFor(spec.table);

      // `form_builder_orders` carries no foreign keys at all — which is exactly why it also needs a
      // hand-maintained entry in `LOGICAL_DEPENDENCIES`. Nothing to check it against here.
      if (!edges.length) {
        continue;
      }

      for (const reference of spec.rowReferences) {
        // Polymorphic references name no single table by design.
        if (reference.typeColumn) {
          continue;
        }

        const edge = edges.find((e) => e.column === reference.column);

        if (!edge) {
          continue;
        }

        expect({
          column: reference.column,
          references: reference.referencesTable,
        }).toEqual({ column: reference.column, references: edge.references });
      }
    }
  });

  /**
   * Naming the table enables a SECOND thing, and that one is opt-in.
   *
   * `keepReferencesOutsideRun` decides whether a required reference may keep its archived id when
   * its target is not in the run. Derived tables take it — that is what let 95 `automation_runs`
   * land. Hand-written specs must not: `form_builder_webhook_deliveries` and
   * `form_builder_integration_deliveries` point at tables holding encrypted endpoint credentials
   * that this restore does not carry, and a delivery keeping its archived `webhook_id` would arrive
   * pointed at a credential in the space it came from.
   */
  it('does not let a hand-written spec keep a reference its run is not carrying', () => {
    for (const spec of Object.values(CROSS_ORG_REMAP_SPECS)) {
      expect({
        table: spec.table,
        keeps: Boolean(spec.keepReferencesOutsideRun),
      }).toEqual({ table: spec.table, keeps: false });
    }

    // Derived specs are the opposite, and stay that way.
    expect(specFor('automation_runs')?.keepReferencesOutsideRun).toBe(true);
  });

  /**
   * The hazard that the second condition closes, which pre-dates this change.
   *
   * `automation_runs` has a space column of its own, so re-scoping moves it into the destination and
   * a kept parent id is a link to something left behind — the documented concession. A table scoped
   * THROUGH its parent has no space of its own, so nothing moves it: keeping the parent id files the
   * row straight back under the SOURCE parent, with a fresh id and nothing to recognise it by. That
   * is a duplicate, not a preserved link, and 37 tables are scoped that way.
   */
  it('refuses rather than duplicating a row that has no space of its own', () => {
    const SRC = 'org-src';

    const plan: RemapPlan = {
      archiveOrganizationId: SRC,
      targetOrganizationId: SRC,
      destinationSpaceId: 'space-dst',
      config: new Map(),
    };

    const run = (table: string, row: Record<string, unknown>) =>
      remapRow(
        { organization_id: SRC, space_id: 'space-old', ...row },
        remapSpecFor(table, entryFor(table), false) as never,
        plan,
        createRemapState(new Map(), new Set([table])),
      );

    // Space of its own: keeps the archived automation_id and lands. Unchanged, and the reason this
    // branch exists at all.
    const own = run('automation_runs', {
      id: 'run-1',
      automation_id: 'auto-1',
      automation_version_id: 'ver-1',
    });

    expect(own.kind === 'insert' && own.row.automation_id).toBe('auto-1');

    // Scoped through its process: refused, because inserting it would write a second copy of the
    // comment under the process it already belongs to, in the space being restored FROM.
    const viaParent = run('process_comments', {
      id: 'comment-1',
      process_id: 'process-1',
    });

    expect(viaParent.kind).toBe('skip');

    if (viaParent.kind !== 'skip') return;

    expect(viaParent.reason).toBe('unmapped_reference');
  });
});
