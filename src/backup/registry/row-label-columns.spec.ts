/**
 * @fileoverview The report must never fall back to showing a raw identifier.
 *
 * `id=3116c309-169b-4c70-a065-cc209cd0b6c5` is a true answer to "which row" and a useless one to
 * "which record". These tests lock the three tiers that keep it off the screen: a name where the
 * table has one, a description where it does not, and a generic scan for anything unclassified.
 */

import {
  buildRowLabel,
  ROW_LABEL_COLUMNS,
  ROW_PARENT_REFS,
} from './row-label-columns';

describe('naming a row', () => {
  it('gives a task its key AND its summary', () => {
    // The whole point: `TASK-104` alone is a lookup instruction, not an answer.
    expect(
      buildRowLabel('tasks', {
        id: 'x',
        key: 'TASK-104',
        summary: 'Migrate the reporting database',
      }),
    ).toBe('TASK-104 · Migrate the reporting database');
  });

  it('does not print a slug next to the title it was derived from', () => {
    expect(
      buildRowLabel('wiki_pages', {
        id: 'x',
        slug: 'release-process',
        title: 'Release process',
      }),
    ).toBe('Release process');
  });

  it('falls back to whichever half is present', () => {
    expect(buildRowLabel('tasks', { key: 'TASK-9', summary: null })).toBe(
      'TASK-9',
    );
    expect(
      buildRowLabel('tasks', { key: null, summary: 'Only a summary' }),
    ).toBe('Only a summary');
  });
});

describe('describing a row that has no name', () => {
  it('describes a history entry by what changed', () => {
    expect(
      buildRowLabel('task_history', {
        id: 'x',
        task_id: 'y',
        action: 'updated',
        field_name: 'status',
        changed_at: '2026-08-07T00:00:00Z',
      }),
    ).toBe('updated · status');
  });

  it('describes a comment by what it says', () => {
    expect(
      buildRowLabel('task_comments', { id: 'x', content: 'Looks good to me' }),
    ).toBe('Looks good to me');
  });

  it('describes a membership by its role', () => {
    expect(
      buildRowLabel('space_members', {
        id: 'x',
        space_id: 'y',
        user_id: 'z',
        space_role: 'admin',
        member_type: 'direct',
      }),
    ).toBe('admin · direct');
  });

  it('truncates prose rather than filling the cell with it', () => {
    const long = 'x'.repeat(200);
    const label = buildRowLabel('task_comments', { content: long });

    expect(label!.length).toBeLessThanOrEqual(60);
    expect(label!.endsWith('…')).toBe(true);
  });
});

describe('a table nobody has classified', () => {
  it('still says something rather than nothing', () => {
    expect(
      buildRowLabel('some_future_table', {
        id: '3116c309-169b-4c70-a065-cc209cd0b6c5',
        organization_id: 'org',
        created_at: '2026-08-07T00:00:00Z',
        status: 'active',
        kind: 'weekly',
      }),
    ).toBe('active · weekly');
  });

  it('never offers an id, a foreign key or a timestamp as the description', () => {
    expect(
      buildRowLabel('some_future_table', {
        id: '3116c309-169b-4c70-a065-cc209cd0b6c5',
        task_id: 'aaaa',
        created_at: '2026-08-07T00:00:00Z',
        updated_by: 'bbbb',
      }),
    ).toBeNull();
  });

  it('never surfaces a secret the payload redactor would have hidden', () => {
    expect(
      buildRowLabel('some_future_table', {
        id: 'x',
        api_token: 'super-secret-value',
        client_secret: 'also-secret',
      }),
    ).toBeNull();
  });

  it('returns null rather than an empty string for a row with nothing readable', () => {
    expect(
      buildRowLabel('some_future_table', { id: 'x', payload: { a: 1 } }),
    ).toBeNull();
  });
});

describe('the map itself', () => {
  it('lists an identifier before the title it qualifies', () => {
    // Order is meaning here: "TASK-104 · Migrate DB", never "Migrate DB · TASK-104".
    for (const [table, columns] of Object.entries(ROW_LABEL_COLUMNS)) {
      const idIndex = columns.findIndex((c) => c === 'key' || c === 'code');

      if (idIndex >= 0) {
        expect({ table, idIndex }).toEqual({ table, idIndex: 0 });
      }
    }
  });
});

/**
 * Naming a child after its parent.
 *
 * "submitted" is true of every form submission ever made. Which FORM it was submitted to is the
 * only thing that distinguishes one from another, and it is one foreign key away — resolvable
 * without a query because the planner restores parents first.
 */
describe('naming a row after its parent', () => {
  const index = new Map<string, Map<string, string>>([
    ['form_builder', new Map([['form-1', 'Onboarding Form']])],
    [
      'tasks',
      new Map([['task-1', 'NEWSPACE-T88 · Migrate the reporting database']]),
    ],
  ]);

  const lookup = (table: string, id: string) =>
    index.get(table)?.get(id) ?? null;

  it('names a form submission after its form', () => {
    expect(
      buildRowLabel(
        'form_builder_submissions',
        { id: 's1', form_id: 'form-1', status: 'submitted' },
        lookup,
      ),
    ).toBe('Onboarding Form · submitted');
  });

  it('names a history entry after its task', () => {
    expect(
      buildRowLabel(
        'task_history',
        {
          id: 'h1',
          task_id: 'task-1',
          action: 'updated',
          field_name: 'status',
        },
        lookup,
      ),
    ).toBe('NEWSPACE-T88 · Migrate the reporting database · updated · status');
  });

  it('falls back to describing itself when the parent was not restored', () => {
    expect(
      buildRowLabel(
        'form_builder_submissions',
        { id: 's1', form_id: 'form-missing', status: 'submitted' },
        lookup,
      ),
    ).toBe('submitted');
  });

  it('works without an index at all', () => {
    expect(
      buildRowLabel('form_builder_submissions', {
        id: 's1',
        form_id: 'form-1',
        status: 'submitted',
      }),
    ).toBe('submitted');
  });

  it('does not prepend a parent to a row that already has its own name', () => {
    // A task has a key and a summary. Naming it after something else would be noise.
    expect(
      buildRowLabel(
        'tasks',
        { id: 't', key: 'T-1', summary: 'Real name' },
        lookup,
      ),
    ).toBe('T-1 · Real name');
  });
});

/**
 * Anything belonging to a task is identified by that task first.
 *
 * Seventeen tables carry a foreign key to `tasks`. `design.pdf` could belong to any of four hundred
 * of them; `NEWSPACE-T88 · design.pdf` is an answer.
 */
describe('task-related rows carry the task key', () => {
  const index = new Map<string, Map<string, string>>([
    [
      'tasks',
      new Map([['task-1', 'NEWSPACE-T88 · Migrate the reporting database']]),
    ],
  ]);

  const lookup = (table: string, id: string) =>
    index.get(table)?.get(id) ?? null;

  it('prefixes a row that already has its own name', () => {
    // The parent is not merely a fallback: an attachment HAS a file name and still needs the task.
    expect(
      buildRowLabel(
        'task_attachments',
        { id: 'a1', task_id: 'task-1', file_name: 'design.pdf' },
        lookup,
      ),
    ).toBe('NEWSPACE-T88 · Migrate the reporting database · design.pdf');
  });

  it('covers time entries, reminders and rankings alike', () => {
    for (const table of [
      'time_entries',
      'task_reminders',
      'board_issue_ranking',
    ]) {
      const label = buildRowLabel(
        table,
        { id: 'x', task_id: 'task-1' },
        lookup,
      );

      expect({
        table,
        startsWithKey: label?.startsWith('NEWSPACE-T88') ?? false,
      }).toEqual({
        table,
        startsWithKey: true,
      });
    }
  });

  it('does not prefix a task with its own parent task', () => {
    // tasks.parent_task_id is deliberately not a parent ref — a task already names itself.
    expect(
      buildRowLabel(
        'tasks',
        { id: 't', parent_task_id: 'task-1', key: 'T-2', summary: 'Child' },
        lookup,
      ),
    ).toBe('T-2 · Child');
  });
});

/**
 * A record with two parents needs both.
 *
 * `form_builder_submissions` is the only table in the map with two foreign keys worth naming, and
 * it is the reason ROW_PARENT_REFS holds a list rather than a single ref. Dropping either one loses
 * a real answer: without the form the record is anonymous, without the task it silently breaks the
 * rule that anything related to a task shows the task key.
 */
describe('a row with more than one parent', () => {
  const index = new Map<string, Map<string, string>>([
    ['form_builder', new Map([['form-1', 'Onboarding Form']])],
    [
      'tasks',
      new Map([['task-1', 'NEWSPACE-T88 · Migrate the reporting database']]),
    ],
  ]);

  const lookup = (table: string, id: string) =>
    index.get(table)?.get(id) ?? null;

  it('names a submission after its form AND its task', () => {
    expect(
      buildRowLabel(
        'form_builder_submissions',
        { id: 's1', form_id: 'form-1', task_id: 'task-1', status: 'submitted' },
        lookup,
      ),
    ).toBe(
      'Onboarding Form · NEWSPACE-T88 · Migrate the reporting database · submitted',
    );
  });

  it('reads as it always did when the submission has no task', () => {
    // task_id is nullable and most submissions have none. This is the no-regression case.
    expect(
      buildRowLabel(
        'form_builder_submissions',
        { id: 's1', form_id: 'form-1', task_id: null, status: 'submitted' },
        lookup,
      ),
    ).toBe('Onboarding Form · submitted');
  });

  it('still shows the task key when the form itself was not restored', () => {
    // One parent missing must not suppress the other — the loop skips, it does not give up.
    expect(
      buildRowLabel(
        'form_builder_submissions',
        {
          id: 's1',
          form_id: 'form-gone',
          task_id: 'task-1',
          status: 'submitted',
        },
        lookup,
      ),
    ).toBe('NEWSPACE-T88 · Migrate the reporting database · submitted');
  });
});

/**
 * Locks ROW_PARENT_REFS against a snapshot of the live catalog.
 *
 * The rule this file exists to serve is "anything related to a task shows the task key". A rule
 * that is enforced by remembering to add a line is not enforced at all: `form_builder_submissions`
 * was already in the map — pointed at `form_builder` — and so LOOKED covered while showing no task
 * key for the 48 submissions in this installation's report that carry one.
 *
 * TASK_FK_CHILDREN is every foreign key referencing `public.tasks`, taken from the live catalog on
 * 2026-08-07 with:
 *
 *   select c.conrelid::regclass::text as child_table, a.attname as fk_column
 *     from pg_constraint c
 *     join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
 *     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
 *    where c.contype = 'f' and c.confrelid = 'public.tasks'::regclass
 *      and c.connamespace = 'public'::regnamespace
 *    order by 1, 2;
 *
 * A migration that adds a table hanging off `tasks` has to refresh this snapshot, and refreshing it
 * forces whoever added the table to decide whether its records show the task key. That is the whole
 * point: the test fails loudly rather than letting a new table quietly lose its key.
 */
describe('every table that hangs off a task is covered', () => {
  const TASK_FK_CHILDREN: readonly { table: string; column: string }[] = [
    { table: 'active_timers', column: 'task_id' },
    { table: 'ai_wiki_generations', column: 'task_id' },
    { table: 'asset_object_task_links', column: 'task_id' },
    { table: 'board_issue_ranking', column: 'task_id' },
    { table: 'form_builder_submissions', column: 'task_id' },
    { table: 'plan_items_deprecated', column: 'linked_task_id' },
    { table: 'plan_risks', column: 'task_id' },
    { table: 'plan_tasks', column: 'task_id' },
    { table: 'portfolio_management_letters', column: 'linked_task_id' },
    { table: 'task_attachments', column: 'task_id' },
    { table: 'task_comments', column: 'task_id' },
    { table: 'task_history', column: 'task_id' },
    { table: 'task_reminders', column: 'task_id' },
    { table: 'task_resource_allocations', column: 'task_id' },
    { table: 'tasks', column: 'parent_task_id' },
    { table: 'test_cases', column: 'task_id' },
    { table: 'test_executions', column: 'task_id' },
    { table: 'test_plans', column: 'task_id' },
    { table: 'test_preconditions', column: 'task_id' },
    { table: 'test_sets', column: 'task_id' },
    { table: 'test_ticket_links', column: 'task_id' },
    { table: 'time_entries', column: 'task_id' },
    { table: 'workflow_outbox', column: 'task_id' },
  ];

  /**
   * Tables that reference `tasks` and deliberately do NOT carry the key.
   *
   * Only one, and it is not an oversight: a task already prints its own key and summary, so
   * prefixing it with its parent task's would say the same kind of thing twice.
   */
  // A precondition prints its own key and title; its optional ticket would repeat the same identity.
  const DELIBERATELY_UNCOVERED = new Set(['tasks', 'test_preconditions']);

  it.each(TASK_FK_CHILDREN)(
    '$table.$column resolves to the task',
    ({ table, column }) => {
      if (DELIBERATELY_UNCOVERED.has(table)) {
        expect(
          (ROW_PARENT_REFS[table] ?? []).some((r) => r.table === 'tasks'),
        ).toBe(false);

        return;
      }

      const refs = ROW_PARENT_REFS[table] ?? [];
      const toTask = refs.find((r) => r.table === 'tasks');

      // Reported as an object so a failure names the table instead of saying "expected true".
      expect({ table, column: toTask?.column }).toEqual({ table, column });
    },
  );

  it('points every ref at the column the catalog actually has', () => {
    // A wrong column name fails silently as "(no name)" rather than loudly as an error, which is
    // the class of defect this whole file was written to stop.
    const byTable = new Map(
      TASK_FK_CHILDREN.map((c) => [c.table, c.column] as const),
    );

    for (const [table, refs] of Object.entries(ROW_PARENT_REFS)) {
      for (const ref of refs.filter((r) => r.table === 'tasks')) {
        expect({ table, column: ref.column }).toEqual({
          table,
          column: byTable.get(table),
        });
      }
    }
  });
});

/**
 * Anything belonging to a form is identified by that form.
 *
 * The same rule as the task lock above, for the same reason. A form field is named by its label, and
 * labels repeat: a report of eighteen restored fields read "Short Text, Short Text, Yes / No, Phone"
 * with nothing to say which form any of them came from. Two of them belonged to different forms.
 *
 * FORM_BUILDER_TABLES is every `form_builder*` table the component registry can put in a report,
 * taken from COMPONENT_REGISTRY on 2026-08-10. A migration that adds one has to refresh this list,
 * and refreshing it forces whoever added it to decide whether its rows name their form.
 */
describe('form rows carry the form they belong to', () => {
  const FORM_BUILDER_TABLES = [
    'form_builder',
    'form_builder_approval_steps',
    'form_builder_approvals',
    'form_builder_assignments',
    'form_builder_fields',
    'form_builder_integration_deliveries',
    'form_builder_integrations',
    'form_builder_orders',
    'form_builder_payment_configs',
    'form_builder_submissions',
    'form_builder_webhook_deliveries',
    'form_builder_webhooks',
  ];

  /**
   * Scoped to a SPACE, not to a form — it has no `form_id` column at all, so there is no form to
   * name. Listed rather than silently skipped: the next person to read the failure above needs to
   * know this one is deliberate.
   */
  const NOT_FORM_SCOPED = new Set(['form_builder_payment_configs']);

  /** Follows refs until a form is reached, so a two-hop chain counts. */
  const reachesForm = (table: string, seen = new Set<string>()): boolean => {
    if (table === 'form_builder') {
      return true;
    }

    if (seen.has(table)) {
      return false;
    }

    seen.add(table);

    return (ROW_PARENT_REFS[table] ?? []).some((ref) =>
      reachesForm(ref.table, seen),
    );
  };

  it.each(FORM_BUILDER_TABLES)('%s can be traced to its form', (table) => {
    if (table === 'form_builder' || NOT_FORM_SCOPED.has(table)) {
      return;
    }

    expect({ table, reachesForm: reachesForm(table) }).toEqual({
      table,
      reachesForm: true,
    });
  });

  it('names a field after its form, key first', () => {
    // The key, not just the name: this installation has two forms both called `t1`, so the name
    // alone still produced two identical rows.
    const index = new Map<string, Map<string, string>>([
      ['form_builder', new Map([['form-5', 'FORM-5 · t1']])],
    ]);

    const label = buildRowLabel(
      'form_builder_fields',
      { id: 'f1', form_id: 'form-5', label: 'Short Text' },
      (table, id) => index.get(table)?.get(id) ?? null,
    );

    expect(label).toBe('FORM-5 · t1 · Short Text');
  });

  it('names a webhook and an integration after their form', () => {
    const lookup = () => 'FORM-1 · form-builder-01';

    expect(
      buildRowLabel(
        'form_builder_webhooks',
        {
          id: 'w1',
          form_id: 'form-1',
          provider: 'slack',
          url: 'https://hooks.example/abc',
        },
        lookup,
      ),
    ).toBe('FORM-1 · form-builder-01 · slack · https://hooks.example/abc');

    expect(
      buildRowLabel(
        'form_builder_integrations',
        { id: 'i1', form_id: 'form-1', provider: 'zapier' },
        lookup,
      ),
    ).toBe('FORM-1 · form-builder-01 · zapier');
  });

  it('never puts a webhook secret in the label', () => {
    // The columns sit right beside `provider` and `url`, so the denylist is the only thing keeping
    // them out of a report an operator can export to CSV.
    const label = buildRowLabel('form_builder_webhooks', {
      id: 'w1',
      provider: 'slack',
      url: 'https://hooks.example/abc',
      secret_encrypted: 'super-secret-value',
      secret_iv: 'iv-value',
    });

    expect(label).not.toContain('super-secret-value');
    expect(label).not.toContain('iv-value');
  });
});

describe('test records are named by their ticket', () => {
  const lookup = (table: string, id: string) =>
    table === 'tasks' && id === 'ticket-1' ? 'SK-T7 · Login works' : null;

  it('reads the key and name from the ticket', () => {
    expect(
      buildRowLabel(
        'test_cases',
        { id: 'c1', task_id: 'ticket-1', test_type: 'manual' },
        lookup,
      ),
    ).toBe('SK-T7 · Login works · manual');

    expect(
      buildRowLabel(
        'test_executions',
        {
          id: 'e1',
          task_id: 'ticket-1',
          environment: 'staging',
          source: 'manual',
        },
        lookup,
      ),
    ).toBe('SK-T7 · Login works · staging · manual');
  });

  it.each(['test_sets', 'test_plans'])(
    'never shows the archived flag of %s as its description',
    (table) => {
      const label = buildRowLabel(
        table,
        {
          id: 'r1',
          task_id: 'ticket-1',
          is_archived: false,
          created_at: '2026-10-01T00:00:00Z',
        },
        lookup,
      );

      expect(label).toBe('SK-T7 · Login works · 2026-10-01T00:00:00Z');
    },
  );

  it.each(['test_cases', 'test_sets', 'test_plans', 'test_executions'])(
    'names no removed column for %s',
    (table) => {
      expect(ROW_LABEL_COLUMNS[table]).toBeUndefined();
    },
  );
});

describe('Test Management names that never show a secret', () => {
  it('names a precondition by its own key and title', () => {
    expect(
      buildRowLabel('test_preconditions', {
        id: 'p1',
        key: 'NEWSPACE-PC1',
        title: 'Account exists',
        task_id: 't1',
      }),
    ).toBe('NEWSPACE-PC1 · Account exists');
  });

  it('names an API key and its token without the hash', () => {
    expect(
      buildRowLabel('test_management_api_keys', {
        id: 'k1',
        name: 'CI pipeline',
        token_prefix: 'tm_ab',
        token_hash: 'hash-value',
      }),
    ).toBe('CI pipeline');

    expect(
      buildRowLabel(
        'test_management_api_tokens',
        {
          id: 'x1',
          key_id: 'k1',
          token_hash: 'hash-value',
          expires_at: '2026-11-20T00:00:00Z',
        },
        (table, id) =>
          table === 'test_management_api_keys' && id === 'k1'
            ? 'CI pipeline'
            : null,
      ),
    ).toBe('CI pipeline · 2026-11-20T00:00:00Z');
  });

  it('names a CI server without its secret', () => {
    expect(
      buildRowLabel('ci_servers', {
        id: 's1',
        name: 'Jenkins',
        encrypted_secret: 'secret-value',
        encryption_iv: 'iv-value',
      }),
    ).toBe('Jenkins');
  });
});

describe('automation names', () => {
  it('names a run after its setting, with its number and status', () => {
    expect(
      buildRowLabel(
        'test_automation_runs',
        { id: 'r1', config_id: 'c1', run_no: 3, status: 'DONE' },
        (table, id) =>
          table === 'test_automation_configs' && id === 'c1' ? 'Nightly' : null,
      ),
    ).toBe('Nightly · 3 · DONE');
  });

  it('names a custom image by its address', () => {
    expect(
      buildRowLabel('test_automation_user_images', {
        id: 'i1',
        image_ref: 'docker.io/library/node@sha256:abc',
        digest: 'sha256:abc',
      }),
    ).toBe('docker.io/library/node@sha256:abc');
  });
});
