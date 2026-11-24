/**
 * @fileoverview Tests for moving archived rows into another organization.
 * @module src/backup/engine/restore-id-remapper.spec
 *
 * What matters here is what must NOT survive the move. A restore cannot be rolled back, and once
 * ids are regenerated nothing looks like a duplicate any more — so a row that carries a reference
 * back to the organization it came from is not a cosmetic defect, it is one tenant's data pointing
 * into another's with no constraint anywhere that would object.
 */

import {
  belongsToArchiveOrganization,
  createRemapState,
  CROSS_ORG_REMAP_SPECS,
  CROSS_ORG_TABLE_ORDER,
  crossOrgRestorableTables,
  entityMapKey,
  mapId,
  remapJson,
  remapJsonKeys,
  remapRow,
  remapSpecFor,
  seedIds,
  type RemapPlan,
  type RemapState,
} from './restore-id-remapper';
import { tableEntry } from '../registry/component-registry';

const SOURCE_ORG = '9de67ec3-1111-2222-3333-444444444444';
const TARGET_ORG = 'c3096d27-5555-6666-7777-888888888888';
const DESTINATION_SPACE = '11111111-aaaa-bbbb-cccc-222222222222';
const SOURCE_SPACE = '33333333-dddd-eeee-ffff-444444444444';

function planWith(
  config: Record<string, Record<string, string>> = {},
): RemapPlan {
  return {
    archiveOrganizationId: SOURCE_ORG,
    targetOrganizationId: TARGET_ORG,
    destinationSpaceId: DESTINATION_SPACE,
    config: new Map(
      Object.entries(config).map(([column, pairs]) => [
        column,
        new Map(Object.entries(pairs)),
      ]),
    ),
  };
}

/**
 * A move into another space of the SAME organization.
 *
 * The case the form_builder and wiki specs were added for, and the one `planWith` does not
 * describe: `targetOrganizationId` equals `archiveOrganizationId`, which is what
 * `backup-restore.service.ts` calls a `spaceMove`. It matters because that is when a preserved id
 * genuinely collides — the row it belongs to is still sitting in the source space of the same
 * tenant — rather than merely belonging to somebody else.
 */
function spaceMovePlan(
  config: Record<string, Record<string, string>> = {},
): RemapPlan {
  return { ...planWith(config), targetOrganizationId: SOURCE_ORG };
}

/** An archived row of a space-scoped table, with the tenancy every spec checks. */
function archived(row: Record<string, unknown>): Record<string, unknown> {
  return {
    organization_id: SOURCE_ORG,
    space_id: SOURCE_SPACE,
    ...row,
  };
}

describe('the table order', () => {
  /**
   * `task_relationships` declares no foreign key to `tasks`, so the registry's dependency levels
   * put it at 2 — ahead of tasks at 5. Writing it first would look at an id map that is still empty.
   */
  it('writes tasks before anything that references them', () => {
    const order = [...CROSS_ORG_TABLE_ORDER];

    expect(order.indexOf('tasks')).toBeLessThan(order.indexOf('task_comments'));
    expect(order.indexOf('tasks')).toBeLessThan(order.indexOf('task_history'));
    expect(order.indexOf('tasks')).toBeLessThan(
      order.indexOf('task_relationships'),
    );
  });
});

describe('minting ids', () => {
  it('answers the same id every time it is asked', () => {
    const state = createRemapState();
    const first = mapId('old-1', state);

    expect(mapId('old-1', state)).toBe(first);
  });

  it('gives different rows different ids', () => {
    const state = createRemapState();

    expect(mapId('old-1', state)).not.toBe(mapId('old-2', state));
  });
});

describe('moving a task', () => {
  it('rewrites the organization and the space, and never keeps the source ones', () => {
    const state = createRemapState();

    const outcome = remapRow(
      {
        id: 'task-1',
        organization_id: SOURCE_ORG,
        space_id: 'a-space-in-the-source-org',
        summary: 'unchanged',
      },
      CROSS_ORG_REMAP_SPECS.tasks,
      planWith(),
      state,
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.organization_id).toBe(TARGET_ORG);
    expect(outcome.row.space_id).toBe(DESTINATION_SPACE);
    expect(outcome.row.id).not.toBe('task-1');
    expect(outcome.row.summary).toBe('unchanged');
  });

  /**
   * `tasks.key` encodes the space it was created in (`NEWSPACE-T93`), which names nothing in the
   * destination. Nulled so `task_key_trigger` issues a correct one there — the trigger fires only
   * when the key is null, so leaving it set silently keeps the wrong prefix.
   */
  it('clears the key so the destination issues its own', () => {
    const outcome = remapRow(
      { id: 'task-1', organization_id: SOURCE_ORG, key: 'NEWSPACE-T93' },
      CROSS_ORG_REMAP_SPECS.tasks,
      planWith(),
      createRemapState(),
    );

    expect(outcome.kind === 'insert' && outcome.row.key).toBeNull();
  });

  /**
   * The archive is a file in whatever order it was written, so a child can precede its parent.
   * Without the pre-scan the parent has no id yet and would be quietly cleared — the hierarchy
   * flattens and nothing says so.
   */
  it('resolves a parent that appears LATER in the archive', () => {
    const state = createRemapState();

    // The pre-scan reads the whole table first. The child is first in the file, the parent second.
    seedIds([{ id: 'child' }, { id: 'parent' }], state);

    const outcome = remapRow(
      { id: 'child', organization_id: SOURCE_ORG, parent_task_id: 'parent' },
      CROSS_ORG_REMAP_SPECS.tasks,
      planWith(),
      state,
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.parent_task_id).toBe(state.ids.get('parent'));
    expect(outcome.row.parent_task_id).not.toBe('parent');
    expect(outcome.clearedColumns).not.toContain('parent_task_id');
  });

  it('reports a parent that is genuinely absent rather than dropping the task', () => {
    const outcome = remapRow(
      {
        id: 'child',
        organization_id: SOURCE_ORG,
        parent_task_id: 'a-task-not-in-this-archive',
      },
      CROSS_ORG_REMAP_SPECS.tasks,
      planWith(),
      createRemapState(),
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    // Top-level in the destination, and counted so the flattening is visible.
    expect(outcome.row.parent_task_id).toBeNull();
    expect(outcome.clearedColumns).toContain('parent_task_id');
  });
});

describe('per-organization configuration', () => {
  it('repoints a status at the destination organization row', () => {
    const outcome = remapRow(
      { id: 'task-1', organization_id: SOURCE_ORG, status_id: 'source-open' },
      CROSS_ORG_REMAP_SPECS.tasks,
      planWith({ status_id: { 'source-open': 'target-open' } }),
      createRemapState(),
    );

    expect(outcome.kind === 'insert' && outcome.row.status_id).toBe(
      'target-open',
    );
  });

  /**
   * A business process is space-scoped and is never created on the destination's behalf, so an
   * unmatched one clears the column. The source id must NOT survive: it resolves — the row is still
   * there, owned by the other tenant — which is exactly the silent cross-tenant pointer this exists
   * to prevent.
   */
  it('clears an unmatched process rather than leaving the source id in place', () => {
    const outcome = remapRow(
      {
        id: 'task-1',
        organization_id: SOURCE_ORG,
        process_id: 'a-process-only-the-source-has',
      },
      CROSS_ORG_REMAP_SPECS.tasks,
      planWith(),
      createRemapState(),
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.process_id).toBeNull();
    expect(outcome.clearedColumns).toContain('process_id');
  });

  it('refuses a relationship whose relation type could not be matched', () => {
    const state = createRemapState();

    seedIds([{ id: 'task-a' }, { id: 'task-b' }], state);

    const outcome = remapRow(
      {
        id: 'rel-1',
        organization_id: SOURCE_ORG,
        source_type: 'task',
        source_id: 'task-a',
        target_type: 'task',
        target_id: 'task-b',
        relation_type_id: 'unmatched',
      },
      CROSS_ORG_REMAP_SPECS.task_relationships,
      planWith(),
      state,
    );

    expect(outcome.kind === 'skip' && outcome.reason).toBe('unmatched_config');
  });
});

describe('references with no foreign key behind them', () => {
  it('repoints a task-to-task link at both new ids', () => {
    const state = createRemapState();

    seedIds([{ id: 'task-a' }, { id: 'task-b' }], state);

    const outcome = remapRow(
      {
        id: 'rel-1',
        organization_id: SOURCE_ORG,
        source_type: 'task',
        source_id: 'task-a',
        target_type: 'task',
        target_id: 'task-b',
        relation_type_id: 'source-blocks',
      },
      CROSS_ORG_REMAP_SPECS.task_relationships,
      planWith({ relation_type_id: { 'source-blocks': 'target-blocks' } }),
      state,
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.source_id).toBe(state.ids.get('task-a'));
    expect(outcome.row.target_id).toBe(state.ids.get('task-b'));
    expect(outcome.row.source_id).not.toBe('task-a');
  });

  /**
   * The same table links tasks to wiki pages and asset items. Those rows are not in this restore,
   * so there is no new id to point at — and the archived one belongs to the source tenant.
   */
  it('refuses a link that points at something this restore does not carry', () => {
    const state = createRemapState();

    seedIds([{ id: 'task-a' }], state);

    const outcome = remapRow(
      {
        id: 'rel-1',
        organization_id: SOURCE_ORG,
        source_type: 'task',
        source_id: 'task-a',
        target_type: 'wiki_page',
        target_id: 'some-wiki-page',
        relation_type_id: 'source-relates',
      },
      CROSS_ORG_REMAP_SPECS.task_relationships,
      planWith({ relation_type_id: { 'source-relates': 'target-relates' } }),
      state,
    );

    expect(outcome.kind).toBe('skip');

    if (outcome.kind !== 'skip') return;

    expect(outcome.reason).toBe('unsupported_reference_type');
    expect(outcome.detail).toContain('wiki_page');
  });

  it('drops a comment whose task did not make it', () => {
    const outcome = remapRow(
      {
        id: 'comment-1',
        organization_id: SOURCE_ORG,
        task_id: 'a-task-that-was-refused',
      },
      CROSS_ORG_REMAP_SPECS.task_comments,
      planWith(),
      createRemapState(),
    );

    expect(outcome.kind === 'skip' && outcome.reason).toBe(
      'unmapped_reference',
    );
  });
});

describe('ids buried in jsonb', () => {
  it('rewrites an id the map knows, at any depth', () => {
    const state = createRemapState();

    seedIds([{ id: 'task-a' }], state);

    const remapped = remapJson(
      { nested: { list: ['task-a', 'untouched'] } },
      state,
    ) as { nested: { list: string[] } };

    expect(remapped.nested.list[0]).toBe(state.ids.get('task-a'));
    expect(remapped.nested.list[1]).toBe('untouched');
  });

  /**
   * Only ids this restore actually minted are replaced. A uuid the map does not know may be a user
   * id or a custom-field id, and a wrong guess inside a jsonb blob is invisible.
   */
  it('leaves a uuid it does not recognise alone', () => {
    const state = createRemapState();
    const stranger = 'ffffffff-0000-0000-0000-000000000000';

    expect(remapJson({ assign_users: [stranger] }, state)).toEqual({
      assign_users: [stranger],
    });
  });

  it('rewrites the task id inside a history entry but not its display text', () => {
    const state = createRemapState();

    seedIds([{ id: 'task-a' }], state);

    const outcome = remapRow(
      {
        id: 'history-1',
        organization_id: SOURCE_ORG,
        task_id: 'task-a',
        new_value: { id: 'task-a', key: 'NEWSPACE-T93', summary: 'a task' },
      },
      CROSS_ORG_REMAP_SPECS.task_history,
      planWith(),
      state,
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    const value = outcome.row.new_value as Record<string, unknown>;

    expect(value.id).toBe(state.ids.get('task-a'));

    // Display text describing what the field held, not a reference. Rewriting it would be a guess.
    expect(value.key).toBe('NEWSPACE-T93');
  });
});

describe('the tenant check does not disappear, it changes target', () => {
  it('accepts a row belonging to the archive organization', () => {
    expect(
      belongsToArchiveOrganization(
        { organization_id: SOURCE_ORG },
        CROSS_ORG_REMAP_SPECS.tasks,
        planWith(),
      ),
    ).toBe(true);
  });

  /**
   * An archive can hold a row that was never the source organization's — a tampered file, or a bug
   * upstream. Rewriting that into the destination would move data nobody agreed to move.
   */
  it('refuses a row from some third organization', () => {
    expect(
      belongsToArchiveOrganization(
        { organization_id: 'a-completely-different-tenant' },
        CROSS_ORG_REMAP_SPECS.tasks,
        planWith(),
      ),
    ).toBe(false);
  });

  it('refuses a row with no organization at all', () => {
    expect(
      belongsToArchiveOrganization(
        { organization_id: null },
        CROSS_ORG_REMAP_SPECS.tasks,
        planWith(),
      ),
    ).toBe(false);
  });
});

describe('the form tables are ordered by dependency, not by declared foreign keys', () => {
  const order = [...CROSS_ORG_TABLE_ORDER] as string[];

  it('writes a form before everything that references it', () => {
    for (const child of [
      'form_builder_submissions',
      'form_builder_approvals',
      'form_builder_assignments',
      'form_builder_orders',
    ]) {
      expect(order.indexOf('form_builder')).toBeLessThan(order.indexOf(child));
    }
  });

  it('writes a submission before the rows that hang off one', () => {
    for (const child of [
      'form_builder_approvals',
      'form_builder_orders',
      'form_builder_webhook_deliveries',
      'form_builder_integration_deliveries',
    ]) {
      expect(order.indexOf('form_builder_submissions')).toBeLessThan(
        order.indexOf(child),
      );
    }
  });

  /**
   * `form_builder_submissions.task_id` points at `tasks`, so tasks have to exist in the map first.
   * The registry happens to agree here — levels 5 and 6 — but agreement by accident is worth an
   * assertion, because the level is derived from a foreign key graph and this list is not.
   */
  it('writes tasks before the submissions that may reference them', () => {
    expect(order.indexOf('tasks')).toBeLessThan(
      order.indexOf('form_builder_submissions'),
    );
  });

  /**
   * `form_builder_orders` declares NO foreign keys at all — `pg_constraint` returns nothing for it
   * — so its registry `insertLevel` is 1, ahead of `form_builder` at 3. This list is the record of
   * what the order should be; the planner does not read it yet.
   */
  it('places the order table after the form it has no foreign key to', () => {
    expect(order.indexOf('form_builder')).toBeLessThan(
      order.indexOf('form_builder_orders'),
    );
  });
});

describe('moving a form and its submissions into another space', () => {
  it('gives the form a new identity and stamps the destination space', () => {
    const outcome = remapRow(
      archived({ id: 'form-1', name: 'Onboarding', settings: {} }),
      CROSS_ORG_REMAP_SPECS.form_builder,
      spaceMovePlan(),
      createRemapState(),
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    // A same-organization move is exactly where a preserved id collides: the form it belongs to is
    // still sitting in the source space of the same tenant.
    expect(outcome.row.id).not.toBe('form-1');
    expect(outcome.row.space_id).toBe(DESTINATION_SPACE);
    expect(outcome.row.space_id).not.toBe(SOURCE_SPACE);
    expect(outcome.row.name).toBe('Onboarding');
  });

  /**
   * The opposite of `tasks.key`, and the reason both are asserted.
   *
   * A task's key is nulled so `task_key_trigger` reissues it. A form's key is allocated by an RPC
   * the application calls, and no trigger on `form_builder` touches it — nulling would leave the
   * restored form keyless forever.
   */
  it('keeps the form key, because nothing in the database would issue another', () => {
    const outcome = remapRow(
      archived({ id: 'form-1', form_key: 'FORM-7' }),
      CROSS_ORG_REMAP_SPECS.form_builder,
      spaceMovePlan(),
      createRemapState(),
    );

    expect(outcome.kind === 'insert' && outcome.row.form_key).toBe('FORM-7');
  });

  it('points a submission at the remapped form, never at the archived one', () => {
    const state = createRemapState();

    const form = remapRow(
      archived({ id: 'form-1' }),
      CROSS_ORG_REMAP_SPECS.form_builder,
      spaceMovePlan(),
      state,
    );

    const outcome = remapRow(
      archived({ id: 'sub-1', form_id: 'form-1', data: {} }),
      CROSS_ORG_REMAP_SPECS.form_builder_submissions,
      spaceMovePlan(),
      state,
    );

    expect(form.kind).toBe('insert');
    expect(outcome.kind).toBe('insert');

    if (form.kind !== 'insert' || outcome.kind !== 'insert') return;

    expect(outcome.row.id).not.toBe('sub-1');
    expect(outcome.row.space_id).toBe(DESTINATION_SPACE);
    expect(outcome.row.form_id).toBe(form.row.id);
    expect(outcome.row.form_id).not.toBe('form-1');
  });

  it('points a form version at the remapped form, never at the source-space form', () => {
    const entry = tableEntry('form_builder_versions');

    expect(entry).toBeDefined();

    if (!entry) return;

    const spec = remapSpecFor('form_builder_versions', entry, false);

    expect(spec).toBeDefined();

    if (!spec) return;

    const state = createRemapState();
    const form = remapRow(
      archived({ id: 'form-1' }),
      CROSS_ORG_REMAP_SPECS.form_builder,
      spaceMovePlan(),
      state,
    );
    const outcome = remapRow(
      archived({ id: 'version-1', form_id: 'form-1', version_number: 8 }),
      spec,
      spaceMovePlan(),
      state,
    );

    expect(form.kind).toBe('insert');
    expect(outcome.kind).toBe('insert');

    if (form.kind !== 'insert' || outcome.kind !== 'insert') return;

    expect(outcome.row.id).not.toBe('version-1');
    expect(outcome.row.space_id).toBe(DESTINATION_SPACE);
    expect(outcome.row.form_id).toBe(form.row.id);
    expect(outcome.row.form_id).not.toBe('form-1');
  });

  /**
   * The reference this table exists to get right. `task_id` is nullable and names a task in the
   * space the submission came from; if the restore is not carrying tasks there is no new id, and
   * keeping the archived one is a live pointer out of the destination space.
   */
  it('clears a task the restore is not carrying rather than pointing out of the space', () => {
    const state = createRemapState();

    seedIds([{ id: 'form-1' }], state);

    const outcome = remapRow(
      archived({
        id: 'sub-1',
        form_id: 'form-1',
        task_id: 'a-task-still-in-the-source-space',
      }),
      CROSS_ORG_REMAP_SPECS.form_builder_submissions,
      spaceMovePlan(),
      state,
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.task_id).toBeNull();
    expect(outcome.clearedColumns).toContain('task_id');
  });

  it('repoints a submission at its task when the restore does carry it', () => {
    const state = createRemapState();

    seedIds([{ id: 'task-a' }], state);
    seedIds([{ id: 'form-1' }], state);

    const outcome = remapRow(
      archived({ id: 'sub-1', form_id: 'form-1', task_id: 'task-a' }),
      CROSS_ORG_REMAP_SPECS.form_builder_submissions,
      spaceMovePlan(),
      state,
    );

    expect(outcome.kind === 'insert' && outcome.row.task_id).toBe(
      state.ids.get('task-a'),
    );
  });

  /**
   * A null optional reference is not a missing one. Nothing to map, nothing to clear, and the row
   * moves — an order created at checkout has no submission attached until the payment settles.
   */
  it('moves a row whose optional reference is null, and reports nothing cleared', () => {
    const state = createRemapState();

    seedIds([{ id: 'form-1' }], state);

    const outcome = remapRow(
      archived({
        id: 'order-1',
        form_id: 'form-1',
        submission_id: null,
        line_items: [],
      }),
      CROSS_ORG_REMAP_SPECS.form_builder_orders,
      spaceMovePlan(),
      state,
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.submission_id).toBeNull();
    expect(outcome.clearedColumns).toEqual([]);
    expect(outcome.row.space_id).toBe(DESTINATION_SPACE);
  });

  it('points an approval at both the remapped form and the remapped submission', () => {
    const state = createRemapState();

    seedIds([{ id: 'form-1' }, { id: 'sub-1' }], state);

    const outcome = remapRow(
      archived({ id: 'appr-1', form_id: 'form-1', submission_id: 'sub-1' }),
      CROSS_ORG_REMAP_SPECS.form_builder_approvals,
      spaceMovePlan(),
      state,
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.form_id).toBe(state.ids.get('form-1'));
    expect(outcome.row.submission_id).toBe(state.ids.get('sub-1'));
  });

  it('points an order at the remapped submission', () => {
    const state = createRemapState();

    seedIds([{ id: 'form-1' }, { id: 'sub-1' }], state);

    const outcome = remapRow(
      archived({ id: 'order-1', form_id: 'form-1', submission_id: 'sub-1' }),
      CROSS_ORG_REMAP_SPECS.form_builder_orders,
      spaceMovePlan(),
      state,
    );

    expect(outcome.kind === 'insert' && outcome.row.submission_id).toBe(
      state.ids.get('sub-1'),
    );
  });

  it('drops an approval step whose approval did not make it', () => {
    const outcome = remapRow(
      archived({ id: 'step-1', approval_id: 'an-approval-that-was-refused' }),
      CROSS_ORG_REMAP_SPECS.form_builder_approval_steps,
      spaceMovePlan(),
      createRemapState(),
    );

    expect(outcome.kind === 'skip' && outcome.reason).toBe(
      'unmapped_reference',
    );
  });
});

/**
 * The two tables this change knowingly does NOT make restorable.
 *
 * `form_builder_webhooks` and `form_builder_integrations` hold encrypted endpoint credentials, and
 * this map is what `RestoreApprovalsService` derives the cross-organization allow-list from, so
 * covering them is a decision for a person. Until then their delivery records cannot move — and the
 * point of these tests is that they FAIL LOUDLY rather than arriving pointed at the source space.
 */
describe('delivery records, whose webhook and integration are not carried', () => {
  it('refuses a webhook delivery rather than pointing it at the source space', () => {
    const state = createRemapState();

    seedIds([{ id: 'sub-1' }], state);

    const outcome = remapRow(
      archived({
        id: 'del-1',
        webhook_id: 'a-webhook-in-the-source-space',
        submission_id: 'sub-1',
      }),
      CROSS_ORG_REMAP_SPECS.form_builder_webhook_deliveries,
      spaceMovePlan(),
      state,
    );

    expect(outcome.kind).toBe('skip');

    if (outcome.kind !== 'skip') return;

    expect(outcome.reason).toBe('unmapped_reference');
    expect(outcome.detail).toContain('webhook_id');
  });

  it('refuses an integration delivery for the same reason', () => {
    const outcome = remapRow(
      archived({
        id: 'del-2',
        integration_id: 'an-integration-in-the-source-space',
        submission_id: null,
      }),
      CROSS_ORG_REMAP_SPECS.form_builder_integration_deliveries,
      spaceMovePlan(),
      createRemapState(),
    );

    expect(outcome.kind).toBe('skip');

    if (outcome.kind !== 'skip') return;

    expect(outcome.detail).toContain('integration_id');
  });
});

describe('moving a wiki page', () => {
  /**
   * `parent_id` is self-referencing, so the same pre-scan `tasks.parent_task_id` needs applies —
   * and it applies automatically, because the writer runs `seedIds` for any spec with a reference
   * that has no type column and whose name starts with `parent`.
   */
  it('resolves a parent page that appears LATER in the archive', () => {
    const state = createRemapState();

    seedIds([{ id: 'child' }, { id: 'parent' }], state);

    const outcome = remapRow(
      archived({ id: 'child', parent_id: 'parent', slug: 'child-page' }),
      CROSS_ORG_REMAP_SPECS.wiki_pages,
      spaceMovePlan(),
      state,
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.parent_id).toBe(state.ids.get('parent'));
    expect(outcome.row.parent_id).not.toBe('parent');
    expect(outcome.clearedColumns).not.toContain('parent_id');
  });

  /**
   * `path` is the ancestor chain as page ids in text form. The BEFORE INSERT trigger recomputes it,
   * so this is belt and braces — but the archived value names SOURCE pages, and a chain of those
   * surviving into the destination is precisely the kind of invisible pointer this module exists to
   * stop.
   */
  it('clears the ancestor path so the destination recomputes its own', () => {
    const outcome = remapRow(
      archived({ id: 'page-1', path: ['page-0', 'page-1'], level: 1 }),
      CROSS_ORG_REMAP_SPECS.wiki_pages,
      spaceMovePlan(),
      createRemapState(),
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.path).toBeNull();

    // `level` is a depth, not a reference, and the same trigger derives it. Left alone.
    expect(outcome.row.level).toBe(1);
  });

  it('clears a category the destination space has no equivalent for', () => {
    const outcome = remapRow(
      archived({ id: 'page-1', category_id: 'a-category-of-the-source-space' }),
      CROSS_ORG_REMAP_SPECS.wiki_pages,
      spaceMovePlan(),
      createRemapState(),
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.category_id).toBeNull();
    expect(outcome.clearedColumns).toContain('category_id');
  });

  it('repoints a category the plan did manage to match', () => {
    const outcome = remapRow(
      archived({ id: 'page-1', category_id: 'source-guides' }),
      CROSS_ORG_REMAP_SPECS.wiki_pages,
      spaceMovePlan({ category_id: { 'source-guides': 'destination-guides' } }),
      createRemapState(),
    );

    expect(outcome.kind === 'insert' && outcome.row.category_id).toBe(
      'destination-guides',
    );
  });

  it('clears an AI generation record the restore is not carrying', () => {
    const outcome = remapRow(
      archived({ id: 'page-1', ai_generation_id: 'gen-1' }),
      CROSS_ORG_REMAP_SPECS.wiki_pages,
      spaceMovePlan(),
      createRemapState(),
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.ai_generation_id).toBeNull();
    expect(outcome.clearedColumns).toContain('ai_generation_id');
  });

  it('repoints a whiteboard link row at the restored board', () => {
    const state = createRemapState();

    seedIds([{ id: 'board-1' }], state);

    const outcome = remapRow(
      archived({ id: 'page-1', whiteboard_id: 'board-1' }),
      CROSS_ORG_REMAP_SPECS.wiki_pages,
      spaceMovePlan(),
      state,
    );

    expect(outcome.kind === 'insert' && outcome.row.whiteboard_id).toBe(
      state.ids.get('board-1'),
    );
  });

  it('turns a whiteboard link row into a plain page when the board is not restored', () => {
    const outcome = remapRow(
      archived({ id: 'page-1', whiteboard_id: 'board-1' }),
      CROSS_ORG_REMAP_SPECS.wiki_pages,
      spaceMovePlan(),
      createRemapState(),
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.whiteboard_id).toBeNull();
    expect(outcome.clearedColumns).toContain('whiteboard_id');
  });
});

// =============================================================================================
// Restoring the same archive twice
// =============================================================================================

/** What one pass over an archive did, in the terms the writer reports. */
interface PassResult {
  inserted: { table: string; sourceId: string }[];
  alreadyThere: { table: string; sourceId: string }[];
  refused: { table: string; sourceId: string; reason: string }[];
}

/**
 * One restore pass, mirroring `restore-table-writer.service.ts` step for step.
 *
 * Deliberately a re-implementation of the writer's SEQUENCE rather than a call into it: the
 * property under test belongs to the engine — an id is minted only for a row the entity map has
 * never seen — and proving it here keeps it provable without a database, an archive or a Nest
 * container. The three steps that matter, in the writer's order:
 *
 *   1. the pre-scan (`seedIds`) for a table whose spec has a self-referencing parent column,
 *   2. the already-restored lookup on `entityMapKey(table, sourceId)`, BEFORE `remapRow`,
 *   3. `state.minted` collected only for rows that actually landed.
 *
 * If the writer's order ever changes, this stops describing it — which is itself worth knowing.
 */
function restorePass(
  archive: Record<string, Record<string, unknown>[]>,
  plan: RemapPlan,
  state: RemapState,
): PassResult {
  const result: PassResult = { inserted: [], alreadyThere: [], refused: [] };

  for (const table of CROSS_ORG_TABLE_ORDER) {
    const rows = archive[table];
    const spec = CROSS_ORG_REMAP_SPECS[table];

    if (!rows || !spec) {
      continue;
    }

    // The writer's own condition for running the pre-scan.
    if (
      spec.rowReferences.some(
        (ref) => !ref.typeColumn && ref.column.startsWith('parent'),
      )
    ) {
      seedIds(rows, state);
    }

    for (const row of rows) {
      const sourceId = row.id as string;

      if (state.alreadyRestored.has(entityMapKey(table, sourceId))) {
        result.alreadyThere.push({ table, sourceId });
        continue;
      }

      const moved = remapRow(row, spec, plan, state);

      if (moved.kind === 'skip') {
        result.refused.push({ table, sourceId, reason: moved.reason });
        continue;
      }

      // Recorded only once the row has landed, exactly as `rememberMinted` does — a pair recorded
      // at mint time would make the next run skip a row that is not there.
      state.minted.push({
        table,
        sourceId,
        destinationId: moved.row.id as string,
      });
      result.inserted.push({ table, sourceId });
    }
  }

  return result;
}

/** `restore_entity_map`, in memory: what an applying run persists when it finishes. */
function persist(state: RemapState, into: Map<string, string>): void {
  for (const pair of state.minted) {
    into.set(entityMapKey(pair.table, pair.sourceId), pair.destinationId);
  }
}

describe('restoring the same archive twice into the same space', () => {
  const ARCHIVE: Record<string, Record<string, unknown>[]> = {
    form_builder: [archived({ id: 'form-1', name: 'Onboarding' })],
    form_builder_submissions: [
      archived({ id: 'sub-1', form_id: 'form-1', data: {} }),
      archived({ id: 'sub-2', form_id: 'form-1', data: {} }),
    ],
    form_builder_approvals: [
      archived({ id: 'appr-1', form_id: 'form-1', submission_id: 'sub-1' }),
    ],
    form_builder_approval_steps: [
      archived({ id: 'step-1', approval_id: 'appr-1' }),
    ],
    form_builder_orders: [
      archived({ id: 'order-1', form_id: 'form-1', submission_id: 'sub-2' }),
    ],
    wiki_pages: [
      archived({ id: 'page-child', parent_id: 'page-root' }),
      archived({ id: 'page-root', parent_id: null }),
    ],
  };

  const ROW_COUNT = Object.values(ARCHIVE).reduce(
    (total, rows) => total + rows.length,
    0,
  );

  /**
   * The whole point. Ids are regenerated, so nothing in the destination looks like a duplicate of
   * anything — not the primary key, which is new by construction, and not a natural key either. A
   * second run that consulted neither would insert a complete second copy of the archive and no
   * constraint anywhere would object.
   */
  it('inserts nothing the second time, and reports every row as already there', () => {
    const entityMap = new Map<string, string>();
    const firstState = createRemapState();
    const first = restorePass(ARCHIVE, spaceMovePlan(), firstState);

    expect(first.inserted).toHaveLength(ROW_COUNT);
    expect(first.refused).toEqual([]);

    // What an APPLYING run persists when it finishes: the pairs it wrote, and nothing else.
    persist(firstState, entityMap);

    expect(entityMap.size).toBe(ROW_COUNT);

    const second = restorePass(
      ARCHIVE,
      spaceMovePlan(),
      createRemapState(entityMap),
    );

    expect(second.inserted).toEqual([]);
    expect(second.alreadyThere).toHaveLength(ROW_COUNT);
    expect(second.refused).toEqual([]);
  });

  /**
   * A dry run is the one thing that must NOT be recorded.
   *
   * It mints ids and writes none of them, so persisting its map would leave the apply that follows
   * finding every row already mapped and restoring nothing — a preview that silently disarms the
   * operation it is previewing. Modelled as "the pass ran, its pairs were not persisted".
   */
  it('is not disarmed by a preview that minted ids and wrote none', () => {
    const entityMap = new Map<string, string>();
    const preview = createRemapState();

    restorePass(ARCHIVE, spaceMovePlan(), preview);

    // Nothing persisted — the preview's `minted` never reaches `restore_entity_map`.
    const apply = createRemapState(entityMap);
    const applied = restorePass(ARCHIVE, spaceMovePlan(), apply);

    expect(applied.inserted).toHaveLength(ROW_COUNT);
    expect(applied.alreadyThere).toEqual([]);
  });

  /**
   * A run that mints an id it does not use must not record it. The pre-scan mints an id for EVERY
   * wiki page before a single one is written, including pages an earlier run already restored — so
   * a run that recorded what it minted rather than what it wrote would map a page to an id that is
   * not in the database, and the run after that would skip a page that was never there.
   */
  it('records only the rows it actually wrote, never the ones it merely minted', () => {
    const state = createRemapState();
    const pass = restorePass(ARCHIVE, spaceMovePlan(), state);

    // The pre-scan minted ids for both wiki pages before either was remapped, so the rename table
    // is always at least as large as what was written.
    expect(state.ids.size).toBeGreaterThanOrEqual(state.minted.length);
    expect(state.minted).toHaveLength(pass.inserted.length);

    for (const pair of state.minted) {
      expect(pair.destinationId).not.toBe(pair.sourceId);
    }
  });

  /**
   * A first run that got half way through — and the limit this used to have, now closed.
   *
   * The rows that landed are recognised and not written again; that property is unchanged and is
   * still asserted first. What changed is their CHILDREN. `alreadyRestored` is keyed
   * `"<table> <sourceId>"` while `ids`, the within-run rename table, is keyed by the raw id, so a
   * child looking up a parent an EARLIER run wrote used to find nothing and be refused
   * `unmapped_reference` — visibly and counted, but refused. This test asserted that refusal and
   * named the fix: give the reference its `referencesTable`, which is the composite key the map is
   * keyed by. Eighteen hand-written references now carry it, so the second lookup can run.
   *
   * The cost of leaving it was not theoretical: on a real repeat restore `form_builder` was
   * correctly recognised as already present and its 12 assignments and 6 orders were then thrown
   * away for pointing at it.
   *
   * What did NOT change is the other direction. A child whose parent is genuinely outside the run
   * is still refused, because `keepReferencesOutsideRun` is opt-in and no hand-written spec takes
   * it — see the webhook and integration delivery tests, where keeping the archived id would mean
   * arriving pointed at a credential in the space the rows came from.
   */
  it('recognises what an earlier run wrote, and now restores the rest under it', () => {
    const entityMap = new Map<string, string>();
    const firstState = createRemapState();

    restorePass(
      { form_builder: ARCHIVE.form_builder },
      spaceMovePlan(),
      firstState,
    );
    persist(firstState, entityMap);

    const second = restorePass(
      { form_builder: ARCHIVE.form_builder, ...ARCHIVE },
      spaceMovePlan(),
      createRemapState(entityMap),
    );

    expect(second.alreadyThere).toEqual([
      { table: 'form_builder', sourceId: 'form-1' },
    ]);

    // The form is not written a second time under a second id...
    expect(second.inserted.map((row) => row.sourceId)).not.toContain('form-1');

    // ...and its submissions are no longer thrown away for pointing at it. This is the whole fix:
    // the parent is in the entity map, so the child resolves through it instead of being refused.
    expect(
      second.refused.filter((row) => row.table === 'form_builder_submissions'),
    ).toEqual([]);

    expect(
      second.inserted
        .filter((row) => row.table === 'form_builder_submissions')
        .map((row) => row.sourceId)
        .sort(),
    ).toEqual(['sub-1', 'sub-2']);
  });

  /**
   * The composite key is what makes the map safe across tables. `restore_entity_map` is keyed on
   * (table, source id), and two tables can legitimately hold the same uuid — a form and the
   * submission of it cannot, but nothing in the schema forbids it, and an id-only key would make
   * one table's restore silently suppress another's.
   */
  it('keys the map by table as well as by id', () => {
    const entityMap = new Map<string, string>([
      [entityMapKey('form_builder', 'shared-id'), 'already-there'],
    ]);

    const state = createRemapState(entityMap);

    const outcome = restorePass(
      {
        form_builder: [archived({ id: 'shared-id' })],
        wiki_pages: [archived({ id: 'shared-id' })],
      },
      spaceMovePlan(),
      state,
    );

    expect(outcome.alreadyThere).toEqual([
      { table: 'form_builder', sourceId: 'shared-id' },
    ]);
    expect(outcome.inserted).toEqual([
      { table: 'wiki_pages', sourceId: 'shared-id' },
    ]);
  });
});

/**
 * A table whose tenancy comes through its PARENT rather than a column of its own must still be
 * re-keyable into another space.
 *
 * `remapSpecFor` used to refuse any table without a `tenantColumn`, which caught `automation_versions`
 * — its organization is reached through `automations`, not stored on the row. Refusing it meant its
 * rows were skipped `other_space`, so the ids they would have been given never existed, so every
 * `automation_run` pointing at a version was dropped `unmapped_reference` and every row pointing at
 * the automation was dropped `missing_parent`. One guard, hundreds of rows, and nothing in the run
 * report named the guard as the cause.
 *
 * The guard now also requires that the table does NOT live in a space. That fix had no test, which is
 * how it would have been undone by the next person tidying the condition.
 */
describe('remapSpecFor: parent-scoped tables are still movable', () => {
  const entryFor = (table: string) => {
    const entry = tableEntry(table);

    if (!entry) {
      throw new Error(`${table} is not in the registry`);
    }

    return entry;
  };

  it('gives automation_versions a spec despite it having no tenant column', () => {
    const entry = entryFor('automation_versions');

    // The precondition that makes this test meaningful: if the registry ever gives this table its
    // own tenant column, the guard stops being the thing under test.
    expect(entry.tenantColumn).toBeNull();
    expect(entry.spaceScope.kind).toBe('own');

    expect(remapSpecFor('automation_versions', entry, false)).toBeDefined();
    expect(remapSpecFor('automation_versions', entry, true)).toBeDefined();
  });

  it('still refuses a table that has neither a tenant column nor a space', () => {
    // The other half of the guard, so a fix for the above cannot be written as "always return a
    // spec". A genuinely global row shared by every tenant must keep its archived id.
    expect(
      remapSpecFor(
        'anything_global',
        { tenantColumn: null, spaceScope: { kind: 'organization' } },
        true,
      ),
    ).toBeUndefined();
  });

  it('never re-keys the spaces table itself', () => {
    // The destination space is CHOSEN, never minted.
    expect(
      remapSpecFor(
        'spaces',
        { tenantColumn: 'organization_id', spaceScope: { kind: 'self' } },
        true,
      ),
    ).toBeUndefined();
  });
});

describe('a Site Studio page follows its funnel across organizations', () => {
  // `site_studio_pages.funnel_id` is a real foreign key and IS declared in the FK graph, but this
  // map is written by hand and the table had no entry — so a page kept pointing at the funnel it
  // came FROM. `idx_site_studio_pages_funnel_path` then refused it as a duplicate of the SOURCE
  // organization's own page, which is the only thing that stopped a page being written into
  // another tenant's funnel.

  const entry = {
    tenantColumn: 'organization_id' as const,
    spaceScope: { kind: 'organization' as const },
  };

  it('has a remap spec at all', () => {
    expect(remapSpecFor('site_studio_pages', entry, true)).toBeDefined();
  });

  it('repoints funnel_id at the funnel this restore wrote', () => {
    const spec = remapSpecFor('site_studio_pages', entry, true);

    expect(spec?.rowReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column: 'funnel_id',
          referencesTable: 'site_studio_funnels',
        }),
      ]),
    );
  });

  it('treats the funnel as required, so an orphan page is refused rather than left aimed at the source', () => {
    // Optional would be worse than the bug: a cleared funnel_id violates NOT NULL, and a kept one
    // points out of the destination organization.
    const spec = remapSpecFor('site_studio_pages', entry, true);
    const funnel = spec?.rowReferences.find(
      (reference) => reference.column === 'funnel_id',
    );

    expect(funnel?.required).toBe(true);
  });
});

/**
 * Restoring into another organization WITHOUT choosing a destination space.
 *
 * The archived spaces are minted in the destination and every space-scoped row follows its own space
 * across, instead of all of them being folded onto one space the operator picked. What matters here
 * is the boundary between the two modes: folding must keep answering exactly what it answered
 * before, because it is the only mode that has ever run.
 */
describe('recreating the archived spaces instead of folding onto one', () => {
  const SPACES_ENTRY = {
    tenantColumn: 'organization_id',
    spaceScope: { kind: 'self' },
  } as const;

  /** A cross-organization plan with no destination space — the mode under test. */
  function recreatePlan(): RemapPlan {
    return {
      ...planWith(),
      destinationSpaceId: null,
      recreateSpaces: true,
    };
  }

  function tasksEntry() {
    const entry = tableEntry('tasks');

    if (!entry) {
      throw new Error('tasks is not in the registry');
    }

    return entry;
  }

  it('gives spaces a spec when recreating, and still refuses one when folding', () => {
    expect(remapSpecFor('spaces', SPACES_ENTRY, true, true)).toBeDefined();

    // The half that must not move. Folding onto a chosen space may never mint a new space id.
    expect(remapSpecFor('spaces', SPACES_ENTRY, true)).toBeUndefined();
    expect(remapSpecFor('spaces', SPACES_ENTRY, true, false)).toBeUndefined();
  });

  it('gives the spaces spec no space column, because a space is not IN a space', () => {
    // If this ever gained one, `remapRow` would try to repoint a space at another space and the
    // recreated row would be written with a `space_id` column the table does not have.
    expect(remapSpecFor('spaces', SPACES_ENTRY, true, true)?.spaceColumn).toBe(
      undefined,
    );
  });

  it('adds spaces to the movable set only for the recreating question', () => {
    // The picker and the approval gate both read this, and they must be asked the same way — the
    // picker offering what the gate refuses is a documented past failure of this exact pairing.
    expect(crossOrgRestorableTables().has('spaces')).toBe(false);
    expect(crossOrgRestorableTables(true).has('spaces')).toBe(true);
  });

  it('repoints a row at the space this run recreated', () => {
    const state = createRemapState();
    const plan = recreatePlan();

    // The space lands first — `orderForInsert` guarantees it — so its mapping is already there.
    const recreatedSpace = mapId(SOURCE_SPACE, state);

    const outcome = remapRow(
      archived({ id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'A task' }),
      remapSpecFor('tasks', tasksEntry(), true, true) as never,
      plan,
      state,
    );

    expect(outcome.kind).toBe('insert');
    expect((outcome as { row: Record<string, unknown> }).row.space_id).toBe(
      recreatedSpace,
    );

    // Not the source space, which belongs to the other tenant.
    expect((outcome as { row: Record<string, unknown> }).row.space_id).not.toBe(
      SOURCE_SPACE,
    );
  });

  it('leaves an organization-level row unconfined to any recreated space', () => {
    // A NULL space column means the row belongs to the whole organization — a shared task status,
    // an org-wide custom field. Writing a recreated space id here would confine a tenant-wide
    // default to one space.
    const state = createRemapState();

    mapId(SOURCE_SPACE, state);

    const outcome = remapRow(
      {
        organization_id: SOURCE_ORG,
        space_id: null,
        id: 'aaaaaaaa-0000-0000-0000-000000000002',
      },
      remapSpecFor('tasks', tasksEntry(), true, true) as never,
      recreatePlan(),
      state,
    );

    expect(outcome.kind).toBe('insert');
    expect(
      (outcome as { row: Record<string, unknown> }).row.space_id,
    ).toBeNull();
  });

  it('refuses a row whose space was never recreated rather than writing a stale id', () => {
    // Reachable when Spaces was left out of the selection. Minting here instead would point the row
    // at a space that does not exist — a foreign key violation for the ~95 tables that have one, and
    // silent corruption for the five that do not.
    const outcome = remapRow(
      archived({ id: 'aaaaaaaa-0000-0000-0000-000000000003' }),
      remapSpecFor('tasks', tasksEntry(), true, true) as never,
      recreatePlan(),
      createRemapState(),
    );

    expect(outcome).toMatchObject({
      kind: 'skip',
      reason: 'unmapped_reference',
      referencesTable: 'spaces',
    });
  });

  it('still folds every row onto the chosen space when one was chosen', () => {
    // The regression that matters most: the mode that has always run must be untouched.
    const state = createRemapState();

    mapId(SOURCE_SPACE, state);

    const outcome = remapRow(
      archived({ id: 'aaaaaaaa-0000-0000-0000-000000000004' }),
      remapSpecFor('tasks', tasksEntry(), true) as never,
      planWith(),
      state,
    );

    expect(outcome.kind).toBe('insert');
    expect((outcome as { row: Record<string, unknown> }).row.space_id).toBe(
      DESTINATION_SPACE,
    );
  });
});

describe('test records whose key and name live on the ticket', () => {
  it.each(['test_cases', 'test_sets', 'test_plans', 'test_executions'])(
    'moves %s onto the new ticket without writing removed columns',
    (table) => {
      const entry = tableEntry(table);

      if (!entry) throw new Error(`${table} is not in the registry`);

      const state = createRemapState();
      const newTicketId = mapId('ticket-1', state);
      const outcome = remapRow(
        archived({ id: 'record-1', task_id: 'ticket-1' }),
        remapSpecFor(table, entry, false) as never,
        spaceMovePlan(),
        state,
      );

      expect(outcome.kind).toBe('insert');

      if (outcome.kind !== 'insert') return;

      expect(outcome.row.task_id).toBe(newTicketId);
      expect(outcome.row).not.toHaveProperty('key');
      expect(outcome.row).not.toHaveProperty('key_number');
    },
  );
});

describe('Test Management ids no foreign key describes', () => {
  function moved(
    table: string,
    row: Record<string, unknown>,
    state: RemapState,
  ) {
    const entry = tableEntry(table);

    if (!entry) throw new Error(`${table} is not in the registry`);

    return remapRow(
      archived(row),
      remapSpecFor(table, entry, false) as never,
      spaceMovePlan(),
      state,
    );
  }

  it('points a test case at its preconditions’ new ids and keeps an unknown one', () => {
    const state = createRemapState();
    const newPrecondition = mapId('pre-1', state);
    const outcome = moved(
      'test_cases',
      { id: 'c1', task_id: 't1', precondition_ids: ['pre-1', 'gone'] },
      state,
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.precondition_ids).toEqual([newPrecondition, 'gone']);
  });

  it('rewrites the ids in an attempt’s snapshot and the keys of its precondition results', () => {
    const state = createRemapState();
    const newPrecondition = mapId('pre-1', state);
    const outcome = moved(
      'test_run_attempts',
      {
        id: 'a1',
        run_id: 'r1',
        snapshot: { linked_preconditions: [[{ id: 'pre-1', key: 'OLD-PC1' }]] },
        precondition_results: {
          'pre-1': { status: 'PASS', executed_by: 'user-1' },
        },
      },
      state,
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.snapshot).toEqual({
      linked_preconditions: [[{ id: newPrecondition, key: 'OLD-PC1' }]],
    });
    expect(outcome.row.precondition_results).toEqual({
      [newPrecondition]: { status: 'PASS', executed_by: 'user-1' },
    });
  });

  it.each([null, [], 'text', 7])(
    'leaves %p unchanged when it is not an object keyed by id',
    (value) => {
      expect(remapJsonKeys(value, createRemapState())).toEqual(value);
    },
  );

  it('lets the destination space issue a precondition’s key', () => {
    const outcome = moved(
      'test_preconditions',
      { id: 'p1', key: 'OLD-PC3', key_number: 3, title: 'Account exists' },
      createRemapState(),
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.key).toBeNull();
    expect(outcome.row.key_number).toBeNull();
  });

  it('moves evidence with its test case', () => {
    const state = createRemapState();
    const newCase = mapId('case-1', state);
    const outcome = moved(
      'file_attachments',
      { id: 'f1', entity_type: 'test_case', entity_id: 'case-1' },
      state,
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.entity_id).toBe(newCase);
  });

  it.each([
    'ci_servers',
    'test_management_api_keys',
    'test_management_api_tokens',
  ])('never moves %s into another organization', (table) => {
    const entry = tableEntry(table);

    expect(entry).not.toBeNull();
    expect(remapSpecFor(table, entry as never, true)).toBeUndefined();
  });
});

describe('a ticket created from a support request', () => {
  it('arrives in another space as a plain ticket, since its request still belongs to the original', () => {
    const outcome = remapRow(
      archived({
        id: 'task-from-request',
        key: 'SRC-T9',
        support_request_origin_id: 'request-1',
        summary: 'From the portal',
      }),
      CROSS_ORG_REMAP_SPECS.tasks,
      spaceMovePlan(),
      createRemapState(),
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.support_request_origin_id).toBeNull();
    expect(outcome.row.summary).toBe('From the portal');
  });
});

describe('automation records', () => {
  function moved(
    table: string,
    row: Record<string, unknown>,
    plan: RemapPlan,
    state: RemapState,
  ) {
    const entry = tableEntry(table);

    if (!entry) throw new Error(`${table} is not in the registry`);

    return remapRow(
      archived(row),
      remapSpecFor(
        table,
        entry,
        plan.targetOrganizationId !== plan.archiveOrganizationId,
      ) as never,
      plan,
      state,
    );
  }

  it('gives a copied run a new request id, since request ids are unique everywhere', () => {
    const state = createRemapState();
    const newCase = mapId('case-1', state);
    const outcome = moved(
      'test_automation_runs',
      {
        id: 'run-1',
        request_id: 'request-1',
        status: 'REQUESTED',
        result_summary: { case_id: 'case-1' },
      },
      spaceMovePlan(),
      state,
    );

    expect(outcome.kind).toBe('insert');

    if (outcome.kind !== 'insert') return;

    expect(outcome.row.request_id).not.toBe('request-1');
    expect(outcome.row.status).toBe('REQUESTED');
    expect(outcome.row.result_summary).toEqual({ case_id: newCase });
  });

  it('keeps an automation setting’s secrets in its own organization and clears them in another', () => {
    const row = {
      id: 'config-1',
      name: 'Nightly',
      secrets_enc: 'secret-value',
      ci_headers_enc: 'header-value',
    };
    const sameOrg = moved(
      'test_automation_configs',
      row,
      spaceMovePlan(),
      createRemapState(),
    );
    const otherOrg = moved(
      'test_automation_configs',
      row,
      planWith(),
      createRemapState(),
    );

    expect(sameOrg.kind).toBe('insert');
    expect(otherOrg.kind).toBe('insert');

    if (sameOrg.kind !== 'insert' || otherOrg.kind !== 'insert') return;

    expect(sameOrg.row.secrets_enc).toBe('secret-value');
    expect(otherOrg.row.secrets_enc).toBeNull();
    expect(otherOrg.row.ci_headers_enc).toBeNull();
  });
});
