/**
 * Transpiler tests (pure — no DI, no jsdom).
 *
 * The primary cases are the LIVE board filters seeded on the KAN board at 167.233.94.130:8080 —
 * every swimlane and quick filter that exists there appears here with its exact JQL, so the unit
 * suite and the live migration prove the same set. The context mirrors the real crosswalk content
 * for the KAN migration (status keys, priority keys, the two real users, the Compliance Category
 * text field).
 *
 * Dialect facts asserted here are pinned to real code, not invented:
 *  - board:  KanbanBoard.tsx — keys for status/priority, bag-key custom fields, camelCase
 *            relative tokens, reporter fails closed, arrays never CSV.
 *  - filters: filter-query-engine.ts — status_id/priority_id UUIDs, cf_-prefixed fields,
 *            snake_case tokens.
 */

import { buildTranspileContext } from './transpile-context.builder';
import { transpileJql, type TranspileContext } from './jql-transpiler.util';

const row = (
  source_id: string,
  target_id: string,
  metadata: Record<string, unknown>,
  source_key: string | null = null,
  status = 'mapped',
) => ({ source_id, target_id, metadata, source_key, status });

/** Mirrors the live KAN crosswalk. */
function kanContext(): TranspileContext {
  return buildTranspileContext({
    projectKey: 'KAN',
    projectName: 'KANBAN',
    statusRows: [
      row('10002', 'uuid-backlog', { key: 'backlog', name: 'Backlog' }),
      row('10003', 'uuid-selected', {
        key: 'selected_for_development',
        name: 'Selected for Development',
      }),
      row('3', 'uuid-progress', { key: 'in_progress', name: 'In Progress' }),
      row('10001', 'uuid-done', { key: 'done', name: 'Done' }),
    ],
    priorityRows: [
      // Ranks mirror the live crosswalk: 0 = Highest, smaller = more urgent.
      row('1', 'uuid-highest', { key: 'highest', name: 'Highest', rank: 0 }),
      row('2', 'uuid-high', { key: 'high', name: 'High', rank: 1 }),
      row('3', 'uuid-medium', { key: 'medium', name: 'Medium', rank: 2 }),
      row('4', 'uuid-low', { key: 'low', name: 'Low', rank: 3 }),
      row('5', 'uuid-lowest', { key: 'lowest', name: 'Lowest', rank: 4 }),
    ],
    issueTypeRows: [
      row('10004', 'type-bug', {}, 'Bug'),
      row('10002', 'type-task', {}, 'Task'),
      row('10003', 'type-subtask', {}, 'Sub-task'),
    ],
    userRows: [
      row('christian.kienzl', 'uuid-christian', {
        source_id: 'christian.kienzl',
        display_name: 'Christian Kienzl',
        email: 'c.kienzl@o-range.at',
      }),
      row(
        'rajbha_manek',
        'uuid-rajbha',
        {
          source_id: 'rajbha_manek',
          display_name: 'Rajbha Manek',
          email: 'rajbha.manek@yopmail.com',
        },
        null,
        'placeholder',
      ),
    ],
    customFieldRows: [
      row('customfield_10200', 'cf_customfield_10200', {
        outcome: 'custom_field',
        field_key: 'cf_customfield_10200',
        field_type: 'number',
        name: 'Story Points',
      }),
      row('customfield_10138', 'cf_customfield_10138', {
        outcome: 'custom_field',
        field_key: 'cf_customfield_10138',
        // 'string' is what field-type.registry emits for a Jira textfield — the live value.
        field_type: 'string',
        name: 'Compliance Category',
      }),
    ],
  });
}

describe('the LIVE KAN board fixtures — translatable set', () => {
  const ctx = kanContext();

  it('Expedite swimlane: priority = Highest', () => {
    const out = transpileJql('priority = Highest', ctx, 'swimlane');

    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [{ field: 'priority', operator: 'eq', value: 'highest' }],
      },
    });
    expect(out.filters).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [
          { field: 'priority_id', operator: 'eq', value: 'uuid-highest' },
        ],
      },
    });
  });

  it('Urgent bug intake: priority in (Highest, High) AND type = Bug', () => {
    const out = transpileJql(
      'priority in (Highest, High) AND type = Bug',
      ctx,
      'swimlane',
    );

    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [
          { field: 'priority', operator: 'in', value: ['highest', 'high'] },
          { field: 'task_type_id', operator: 'eq', value: 'type-bug' },
        ],
      },
    });
    expect(out.filters.ok).toBe(true);
  });

  it('Review pipeline: parens + OR + NOT group', () => {
    const out = transpileJql(
      '(status = "In Progress" OR status = "Selected for Development") AND NOT (labels = tech-debt)',
      ctx,
      'swimlane',
    );

    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [
          {
            combinator: 'or',
            rules: [
              { field: 'status', operator: 'eq', value: 'in_progress' },
              {
                field: 'status',
                operator: 'eq',
                value: 'selected_for_development',
              },
            ],
          },
          {
            combinator: 'and',
            not: true,
            rules: [{ field: 'labels', operator: 'in', value: ['tech-debt'] }],
          },
        ],
      },
    });
  });

  it('Compliance follow ups: quoted custom field ~ + startOfMonth()', () => {
    const out = transpileJql(
      '"Compliance Category" ~ "Data" AND created >= startOfMonth()',
      ctx,
      'swimlane',
    );

    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [
          // Board: the evaluator reads custom_field_values[<bag key>] directly.
          {
            field: 'cf_customfield_10138',
            operator: 'contains',
            value: 'Data',
          },
          // `startOfMonth()` is a cutoff (comparison against the start-of-month INSTANT), the same
          // object in both dialects — no more per-engine preset token.
          {
            field: 'created_at',
            operator: 'relative',
            value: { kind: 'cutoff', anchor: 'start_of_month', op: 'gte' },
          },
        ],
      },
    });
    expect(out.filters).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [
          // Filters: the engine wants cf_ + field_key and strips one prefix.
          {
            field: 'cf_cf_customfield_10138',
            operator: 'contains',
            value: 'Data',
          },
          {
            field: 'created_at',
            operator: 'relative',
            value: { kind: 'cutoff', anchor: 'start_of_month', op: 'gte' },
          },
        ],
      },
    });
  });

  it('My open work: assignee = currentUser() AND status != Done', () => {
    const out = transpileJql(
      'assignee = currentUser() AND status != Done',
      ctx,
      'quickfilter',
    );

    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [
          { field: 'assigned_to', operator: 'currentUser', value: null },
          { field: 'status', operator: 'neq', value: 'done' },
        ],
      },
    });
  });

  it('Only My Issues: assignee = currentUser()', () => {
    const out = transpileJql('assignee = currentUser()', ctx, 'quickfilter');

    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [{ field: 'assigned_to', operator: 'currentUser', value: null }],
      },
    });
  });

  it('Hot or customer facing: labels in (...) OR priority = Highest', () => {
    const out = transpileJql(
      'labels in (regression, billing) OR priority = Highest',
      ctx,
      'quickfilter',
    );

    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'or',
        rules: [
          {
            field: 'labels',
            operator: 'in',
            value: ['regression', 'billing'],
          },
          { field: 'priority', operator: 'eq', value: 'highest' },
        ],
      },
    });
    // Labels now translate in the filters engine too: it compiles jsonb containment predicates
    // (applyJsonbArrayRule), so the clause is no longer board-only.
    expect(out.filters).toEqual({
      ok: true,
      query: {
        combinator: 'or',
        rules: [
          {
            field: 'labels',
            operator: 'in',
            value: ['regression', 'billing'],
          },
          { field: 'priority_id', operator: 'eq', value: 'uuid-highest' },
        ],
      },
    });
  });

  it('Untriaged: assignee IS EMPTY AND status = Backlog', () => {
    const out = transpileJql(
      'assignee IS EMPTY AND status = Backlog',
      ctx,
      'quickfilter',
    );

    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [
          { field: 'assigned_to', operator: 'null', value: null },
          { field: 'status', operator: 'eq', value: 'backlog' },
        ],
      },
    });
  });

  it('Fresh this week: startOfWeek() now translates in BOTH dialects (shared cutoff)', () => {
    const out = transpileJql(
      'created >= startOfWeek() AND type in (Bug, Task)',
      ctx,
      'quickfilter',
    );

    const expected = {
      ok: true,
      query: {
        combinator: 'and',
        rules: [
          {
            field: 'created_at',
            operator: 'relative',
            value: { kind: 'cutoff', anchor: 'start_of_week', op: 'gte' },
          },
          {
            field: 'task_type_id',
            operator: 'in',
            value: ['type-bug', 'type-task'],
          },
        ],
      },
    };

    expect(out.board).toEqual(expected);
    // The filters engine no longer lacks a this-week token — the cutoff is engine-independent.
    expect(out.filters).toEqual(expected);
  });

  it('Data protection items: cf[10138] ~ "Data Protection"', () => {
    const out = transpileJql(
      'cf[10138] ~ "Data Protection"',
      ctx,
      'quickfilter',
    );

    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [
          {
            field: 'cf_customfield_10138',
            operator: 'contains',
            value: 'Data Protection',
          },
        ],
      },
    });
  });

  it('Recent invoice work: summary ~ "invoice" AND updated >= -7d', () => {
    const out = transpileJql(
      'summary ~ "invoice" AND updated >= -7d',
      ctx,
      'quickfilter',
    );

    const expected = {
      ok: true,
      query: {
        combinator: 'and',
        rules: [
          { field: 'title', operator: 'contains', value: 'invoice' },
          // `-7d` is an instant cutoff (now − 7 days = −10080 minutes), identical in both dialects.
          {
            field: 'updated_at',
            operator: 'relative',
            value: {
              kind: 'cutoff',
              anchor: 'now',
              offsetMinutes: -10080,
              op: 'gte',
            },
          },
        ],
      },
    };

    expect(out.board).toEqual(expected);
    expect(out.filters).toEqual(expected);
  });
});

describe('the LIVE KAN board fixtures — designed fallbacks', () => {
  const ctx = kanContext();

  it('Escalation history: status WAS "In Progress" now translates for the board dialect', () => {
    const out = transpileJql('status WAS "In Progress"', ctx, 'swimlane');

    // `was` matches the status DISPLAY name stored in task_history; the board evaluator reads each
    // task's loaded status_history. Board-only: the filters engine has no history query surface.
    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [{ field: 'status', operator: 'was', value: 'In Progress' }],
      },
    });
    expect(out.filters.ok).toBe(false);
    expect((out.filters as { reason: string }).reason).toContain(
      'status-history',
    );
  });

  it('Release scope: fixVersion in unreleasedVersions() stays verbatim', () => {
    const out = transpileJql(
      'fixVersion in unreleasedVersions()',
      ctx,
      'quickfilter',
    );

    expect(out.board.ok).toBe(false);
    expect((out.board as { reason: string }).reason).toContain('fixversion');
  });

  it('Recently Updated: updatedDate >= -1d now translates as an exact cutoff', () => {
    // -1d is a rolling 24h cutoff (now − 1 day). It used to fall back because the only relative
    // vocabulary was day-bucket presets; the shared cutoff object expresses it exactly, so this row
    // is no longer a fallback.
    const out = transpileJql('updatedDate >= -1d', ctx, 'quickfilter');

    const expected = {
      ok: true,
      query: {
        combinator: 'and',
        rules: [
          {
            field: 'updated_at',
            operator: 'relative',
            value: {
              kind: 'cutoff',
              anchor: 'now',
              offsetMinutes: -1440,
              op: 'gte',
            },
          },
        ],
      },
    };

    expect(out.board).toEqual(expected);
    expect(out.filters).toEqual(expected);
  });
});

describe('all-or-nothing: one bad conjunct fails the WHOLE query', () => {
  const ctx = kanContext();

  it('a translatable AND an untranslatable clause falls back entirely', () => {
    const out = transpileJql(
      'priority = Highest AND fixVersion in unreleasedVersions()',
      ctx,
      'quickfilter',
    );

    expect(out.board.ok).toBe(false);
  });

  it('an unmigrated status name falls back rather than guessing', () => {
    const out = transpileJql('status = "Waiting for Legal"', ctx, 'swimlane');

    expect(out.board.ok).toBe(false);
    expect((out.board as { reason: string }).reason).toContain(
      'Waiting for Legal',
    );
  });

  it('an unknown user falls back', () => {
    expect(
      transpileJql('assignee = "m.mustermann"', ctx, 'quickfilter').board.ok,
    ).toBe(false);
  });

  it('reporter now translates in BOTH dialects (the board joins reporter into its rows)', () => {
    const out = transpileJql(
      'reporter = "christian.kienzl"',
      ctx,
      'quickfilter',
    );

    const expected = {
      ok: true,
      query: {
        combinator: 'and',
        rules: [{ field: 'reporter', operator: 'eq', value: 'uuid-christian' }],
      },
    };

    expect(out.board).toEqual(expected);
    expect(out.filters).toEqual(expected);
  });
});

describe('membership-neutral strips', () => {
  const ctx = kanContext();

  it('ORDER BY is stripped and recorded', () => {
    const out = transpileJql(
      'priority = Highest ORDER BY created DESC',
      ctx,
      'swimlane',
    );

    expect(out.board.ok).toBe(true);
    expect(out.stripped.join(' ')).toContain('ORDER BY created DESC');
  });

  it('a tautological project conjunct is stripped', () => {
    const out = transpileJql(
      'project = KAN AND priority = Highest',
      ctx,
      'swimlane',
    );

    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [{ field: 'priority', operator: 'eq', value: 'highest' }],
      },
    });
    expect(out.stripped.join(' ')).toContain('project');
  });

  it('project by NAME strips too', () => {
    expect(
      transpileJql('project = KANBAN AND priority = Highest', ctx, 'swimlane')
        .board.ok,
    ).toBe(true);
  });

  it('a DIFFERENT project falls back — the query is not about this space', () => {
    expect(
      transpileJql('project = SDP AND priority = Highest', ctx, 'swimlane')
        .board.ok,
    ).toBe(false);
  });

  it('a project clause inside OR falls back — dropping it would change membership', () => {
    expect(
      transpileJql('project = KAN OR priority = Highest', ctx, 'swimlane').board
        .ok,
    ).toBe(false);
  });

  it('a query that reduces to match-everything fails for a SWIMLANE (renders empty there)', () => {
    const out = transpileJql('project = KAN', ctx, 'swimlane');

    expect(out.board.ok).toBe(false);
    expect((out.board as { reason: string }).reason).toContain(
      'match-everything',
    );
  });

  it('the same reduction is fine for a QUICK FILTER (empty rules match all there)', () => {
    const out = transpileJql('project = KAN', ctx, 'quickfilter');

    expect(out.board).toEqual({
      ok: true,
      query: { combinator: 'and', rules: [] },
    });
  });
});

describe('semantic edges', () => {
  const ctx = kanContext();

  it('assignee != currentUser() wraps in a not-group (no negated operator exists)', () => {
    const out = transpileJql('assignee != currentUser()', ctx, 'quickfilter');

    // The not-group IS the root — a wrapper around it would be redundant nesting.
    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        not: true,
        rules: [{ field: 'assigned_to', operator: 'currentUser', value: null }],
      },
    });
  });

  it('users resolve by username, display name, and email alike', () => {
    for (const alias of [
      'rajbha_manek',
      'Rajbha Manek',
      'rajbha.manek@yopmail.com',
    ]) {
      const out = transpileJql(`assignee = "${alias}"`, ctx, 'quickfilter');

      expect(out.board).toEqual({
        ok: true,
        query: {
          combinator: 'and',
          rules: [
            { field: 'assigned_to', operator: 'eq', value: 'uuid-rajbha' },
          ],
        },
      });
    }
  });

  it('an AMBIGUOUS display name falls back rather than guessing', () => {
    const ambiguous = buildTranspileContext({
      projectKey: 'KAN',
      statusRows: [],
      priorityRows: [],
      issueTypeRows: [],
      userRows: [
        row('a.smith', 'uuid-a', {
          source_id: 'a.smith',
          display_name: 'Alex Smith',
        }),
        row('al.smith', 'uuid-b', {
          source_id: 'al.smith',
          display_name: 'Alex Smith',
        }),
      ],
      customFieldRows: [],
    });
    const out = transpileJql(
      'assignee = "Alex Smith"',
      ambiguous,
      'quickfilter',
    );

    expect(out.board.ok).toBe(false);
    expect((out.board as { reason: string }).reason).toContain('ambiguous');
  });

  it('status values resolve by KEY as well as name', () => {
    const out = transpileJql('status = in_progress', ctx, 'swimlane');

    expect(out.board.ok).toBe(true);
  });

  it('multi-values are ARRAYS, never CSV strings (board toCmpArr does not split)', () => {
    const out = transpileJql(
      'labels in (regression, billing)',
      ctx,
      'quickfilter',
    );
    if (!out.board.ok) throw new Error('expected board translation to succeed');

    const rule = out.board.query.rules[0] as { value: unknown };

    expect(Array.isArray(rule.value)).toBe(true);
  });

  it('absolute date comparisons pass through as ISO', () => {
    const out = transpileJql('created >= "2026-07-01"', ctx, 'quickfilter');

    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [{ field: 'created_at', operator: 'gte', value: '2026-07-01' }],
      },
    });
  });

  it('absolute date EQUALITY translates in both dialects as a half-open day range', () => {
    const out = transpileJql('due = "2026-08-01"', ctx, 'quickfilter');

    // Day-granular equality is the half-open interval [day, next-day), exact and engine-independent
    // (both engines evaluate gte/lt on dates the same way).
    const expected = {
      ok: true,
      query: {
        combinator: 'and',
        rules: [
          { field: 'due_date', operator: 'gte', value: '2026-08-01T00:00:00' },
          { field: 'due_date', operator: 'lt', value: '2026-08-02T00:00:00' },
        ],
      },
    };

    expect(out.board).toEqual(expected);
    expect(out.filters).toEqual(expected);
  });

  it('absolute date INEQUALITY translates as the complement of the day range', () => {
    const out = transpileJql('due != "2026-08-01"', ctx, 'quickfilter');

    const expected = {
      ok: true,
      query: {
        combinator: 'or',
        rules: [
          { field: 'due_date', operator: 'lt', value: '2026-08-01T00:00:00' },
          { field: 'due_date', operator: 'gte', value: '2026-08-02T00:00:00' },
        ],
      },
    };

    expect(out.board).toEqual(expected);
    expect(out.filters).toEqual(expected);
  });

  it('relative cutoffs on DUE dates now translate (an instant comparison, not a window)', () => {
    const out = transpileJql('due >= -7d', ctx, 'quickfilter');

    const expected = {
      ok: true,
      query: {
        combinator: 'and',
        rules: [
          {
            field: 'due_date',
            operator: 'relative',
            value: {
              kind: 'cutoff',
              anchor: 'now',
              offsetMinutes: -10080,
              op: 'gte',
            },
          },
        ],
      },
    };

    expect(out.board).toEqual(expected);
    expect(out.filters).toEqual(expected);
  });

  it('labels = x means "x among the labels" — emitted as single-element in', () => {
    const out = transpileJql('labels = billing', ctx, 'quickfilter');

    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [{ field: 'labels', operator: 'in', value: ['billing'] }],
      },
    });
  });

  it('field = EMPTY normalizes to the null operator', () => {
    const out = transpileJql('assignee = EMPTY', ctx, 'quickfilter');

    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [{ field: 'assigned_to', operator: 'null', value: null }],
      },
    });
  });

  it('every rule carries a value KEY even when null (assertValidQuery requires its presence)', () => {
    const out = transpileJql(
      'assignee IS EMPTY AND labels IS NOT EMPTY',
      ctx,
      'quickfilter',
    );
    if (!out.board.ok) throw new Error('expected board translation to succeed');

    for (const rule of out.board.query.rules) {
      expect(Object.prototype.hasOwnProperty.call(rule, 'value')).toBe(true);
    }
  });

  it('never throws on garbage — malformed input reports a reason', () => {
    for (const junk of [
      '',
      '   ',
      'status =',
      '= Highest',
      'status = "unterminated',
      'priority in (',
      'AND AND AND',
      'status ==== x',
      'ORDER BY created',
    ]) {
      const out = transpileJql(junk, ctx, 'quickfilter');

      expect(out.board.ok).toBe(false);
      expect((out.board as { reason: string }).reason.length).toBeGreaterThan(
        0,
      );
    }
  });
});

describe("the client's JQL reference — every row translated or refused BY NAME", () => {
  const ctx = kanContext();

  const reasonOf = (jql: string): string => {
    const out = transpileJql(jql, ctx, 'quickfilter');

    if (out.board.ok) throw new Error(`expected fallback for: ${jql}`);

    return out.board.reason;
  };

  describe('ordered priority comparisons (the one real addition)', () => {
    it('priority > High expands to the exact more-urgent set', () => {
      const out = transpileJql('priority > High', ctx, 'quickfilter');

      expect(out.board).toEqual({
        ok: true,
        query: {
          combinator: 'and',
          rules: [{ field: 'priority', operator: 'in', value: ['highest'] }],
        },
      });
      expect(out.filters).toEqual({
        ok: true,
        query: {
          combinator: 'and',
          rules: [
            { field: 'priority_id', operator: 'in', value: ['uuid-highest'] },
          ],
        },
      });
    });

    it('priority >= High includes the pivot', () => {
      const out = transpileJql('priority >= High', ctx, 'quickfilter');

      if (!out.board.ok) throw new Error('expected translation');

      expect(out.board.query.rules[0]).toEqual({
        field: 'priority',
        operator: 'in',
        value: ['highest', 'high'],
      });
    });

    it('priority < Medium selects the LESS urgent side', () => {
      const out = transpileJql('priority < Medium', ctx, 'quickfilter');

      if (!out.board.ok) throw new Error('expected translation');

      expect(out.board.query.rules[0]).toEqual({
        field: 'priority',
        operator: 'in',
        value: ['low', 'lowest'],
      });
    });

    it('priority > Highest matches nothing and refuses rather than emitting a dead rule', () => {
      expect(reasonOf('priority > Highest')).toContain(
        'matches no migrated priority',
      );
    });

    it('status > "In Progress" still refuses — JQL itself forbids status ordering', () => {
      expect(reasonOf('status > "In Progress"')).toContain('not translatable');
    });
  });

  describe('history predicates (section 2)', () => {
    it('status WAS NOT "Done" translates to a wasNot rule (board dialect)', () => {
      const out = transpileJql('status WAS NOT "Done"', ctx, 'quickfilter');

      expect(out.board).toEqual({
        ok: true,
        query: {
          combinator: 'and',
          rules: [{ field: 'status', operator: 'wasNot', value: 'Done' }],
        },
      });
      expect(out.filters.ok).toBe(false);
    });

    it('status WAS IN (…) translates to a was rule with an array (any-of)', () => {
      const out = transpileJql(
        'status WAS IN ("In Progress", "Done")',
        ctx,
        'quickfilter',
      );

      expect(
        (out.board as { query: { rules: unknown[] } }).query.rules[0],
      ).toEqual({
        field: 'status',
        operator: 'was',
        value: ['In Progress', 'Done'],
      });
    });

    it('a time-qualified WAS refuses (predicate has no equivalent)', () => {
      expect(
        reasonOf('status WAS "In Progress" BEFORE "2026-01-01"'),
      ).toContain('time-qualified');
    });

    it('WAS on a non-status field refuses (only status history is queryable)', () => {
      expect(reasonOf('assignee WAS "christian.kienzl"')).toContain(
        'only translatable for status',
      );
    });

    it.each([
      ['status CHANGED TO "Done" AFTER -7d'],
      ['assignee CHANGED DURING ("2026-01-01", "2026-06-30")'],
    ])('%s (CHANGED) stays verbatim with the clause in the reason', (jql) => {
      expect(reasonOf(jql)).toContain('WAS/CHANGED');
    });
  });

  describe('fields with a named refusal (section 3)', () => {
    it('description names both engines', () => {
      expect(reasonOf('description ~ "invoice"')).toContain(
        'neither the board evaluator nor the filters engine',
      );
    });

    it('resolution names the migrated-but-unqueryable story', () => {
      expect(reasonOf('resolution = Done')).toContain(
        'resolutions migrate onto tasks',
      );
    });

    it('sprint names the missing engine field', () => {
      expect(reasonOf('sprint in openSprints()')).toContain(
        'neither query engine exposes a sprint field',
      );
    });

    it('issuekey names the key re-issue', () => {
      expect(reasonOf('issuekey = KAN-5')).toContain('re-issued by XISUITE');
      expect(reasonOf('key in (KAN-5, KAN-6)')).toContain(
        're-issued by XISUITE',
      );
    });
  });

  describe('functions (section 4)', () => {
    it('membersOf() refuses with the live-vs-frozen reason', () => {
      expect(
        reasonOf('assignee in membersOf("jira-administrators")'),
      ).toContain('freeze');
      expect(reasonOf('assignee = membersOf("jira-administrators")')).toContain(
        'freeze',
      );
    });

    it('now() translates to a now-anchored cutoff (both dialects)', () => {
      const out = transpileJql('created <= now()', ctx, 'quickfilter');

      const expected = {
        ok: true,
        query: {
          combinator: 'and',
          rules: [
            {
              field: 'created_at',
              operator: 'relative',
              value: { kind: 'cutoff', anchor: 'now', op: 'lte' },
            },
          ],
        },
      };

      expect(out.board).toEqual(expected);
      expect(out.filters).toEqual(expected);
    });

    it('endOfDay() translates to an end-of-day cutoff on a due date', () => {
      const out = transpileJql('due <= endOfDay()', ctx, 'quickfilter');

      const expected = {
        ok: true,
        query: {
          combinator: 'and',
          rules: [
            {
              field: 'due_date',
              operator: 'relative',
              value: { kind: 'cutoff', anchor: 'end_of_day', op: 'lte' },
            },
          ],
        },
      };

      expect(out.board).toEqual(expected);
      expect(out.filters).toEqual(expected);
    });

    it('a bare function with no operator still refuses (parser error surfaces)', () => {
      expect(reasonOf('linkedIssues("KAN-1")').toLowerCase()).toContain(
        'expected an operator',
      );
    });

    it('watchedIssues() and issueHistory() refuse (no watcher/history query surface)', () => {
      expect(reasonOf('issuekey in watchedIssues()').length).toBeGreaterThan(0);
      expect(reasonOf('issuekey in issueHistory()').length).toBeGreaterThan(0);
    });
  });

  describe("the reference's two worked examples (section 5)", () => {
    it('example 1 for the MIGRATED project: strips project + ORDER BY, translates the rest', () => {
      const out = transpileJql(
        'project = "KAN" AND status = "In Progress" AND assignee = currentUser() ORDER BY created DESC',
        ctx,
        'quickfilter',
      );

      expect(out.board).toEqual({
        ok: true,
        query: {
          combinator: 'and',
          rules: [
            { field: 'status', operator: 'eq', value: 'in_progress' },
            { field: 'assigned_to', operator: 'currentUser', value: null },
          ],
        },
      });
      expect(out.stripped.join(' ')).toContain('ORDER BY created DESC');
      expect(out.stripped.join(' ')).toContain('project');
    });

    it('example 1 for a DIFFERENT project ("WEB") refuses whole-query', () => {
      expect(
        reasonOf(
          'project = "WEB" AND status = "In Progress" AND assignee = currentUser()',
        ),
      ).toContain('DIFFERENT project');
    });

    it('example 2: the CHANGED clause fails the whole query, killing the valid half too', () => {
      expect(
        reasonOf('status CHANGED TO "Done" AFTER -7d AND "Story Points" > 5'),
      ).toContain('WAS/CHANGED');
    });

    it('the valid half alone translates: "Story Points" > 5 as a number field', () => {
      const out = transpileJql('"Story Points" > 5', ctx, 'quickfilter');

      expect(out.board).toEqual({
        ok: true,
        query: {
          combinator: 'and',
          rules: [{ field: 'cf_customfield_10200', operator: 'gt', value: 5 }],
        },
      });
    });
  });

  describe('parser edges the reference implies', () => {
    it('mixed precedence: a AND b OR c parses as (a AND b) OR c', () => {
      const out = transpileJql(
        'priority = Highest AND type = Bug OR status = Done',
        ctx,
        'quickfilter',
      );

      if (!out.board.ok) throw new Error('expected translation');

      expect(out.board.query.combinator).toBe('or');
      expect(out.board.query.rules).toHaveLength(2);
      expect(
        (out.board.query.rules[0] as { combinator: string }).combinator,
      ).toBe('and');
    });

    it('a quoted value containing a comma stays ONE array element', () => {
      const out = transpileJql('labels = "a,b"', ctx, 'quickfilter');

      if (!out.board.ok) throw new Error('expected translation');

      expect(out.board.query.rules[0]).toEqual({
        field: 'labels',
        operator: 'in',
        value: ['a,b'],
      });
    });

    it('escaped quotes inside strings survive lexing', () => {
      const out = transpileJql(
        'summary ~ "the \\"archive\\" bucket"',
        ctx,
        'quickfilter',
      );

      if (!out.board.ok) throw new Error('expected translation');

      expect(out.board.query.rules[0]).toEqual({
        field: 'title',
        operator: 'contains',
        value: 'the "archive" bucket',
      });
    });
  });
});

describe('relative-date general classes (beyond the KAN corpus)', () => {
  const ctx = kanContext();

  const relValue = (jql: string): unknown => {
    const out = transpileJql(jql, ctx, 'quickfilter');

    if (!out.board.ok) throw new Error(`expected translation for: ${jql}`);

    return (out.board.query.rules[0] as { value: unknown }).value;
  };

  it('non-day durations resolve to their minute offset (`-4h`)', () => {
    expect(relValue('updated >= -4h')).toEqual({
      kind: 'cutoff',
      anchor: 'now',
      offsetMinutes: -240,
      op: 'gte',
    });
  });

  it('a quoted multi-atom duration sums its atoms (`"-1w -2d"`)', () => {
    expect(relValue('updated >= "-1w -2d"')).toEqual({
      kind: 'cutoff',
      anchor: 'now',
      offsetMinutes: -(7 * 1440) - 2 * 1440,
      op: 'gte',
    });
  });

  it('a bare-integer anchor argument is a CALENDAR shift, not minutes (`startOfMonth(-1)`)', () => {
    expect(relValue('created >= startOfMonth(-1)')).toEqual({
      kind: 'cutoff',
      anchor: 'start_of_month',
      periods: -1,
      op: 'gte',
    });
  });

  it('a duration anchor argument is a FIXED shift (`startOfDay("-3d")`)', () => {
    expect(relValue('created >= startOfDay("-3d")')).toEqual({
      kind: 'cutoff',
      anchor: 'start_of_day',
      offsetMinutes: -3 * 1440,
      op: 'gte',
    });
  });

  it('endOfMonth() / endOfYear() resolve to their end anchors', () => {
    expect(relValue('due <= endOfMonth()')).toEqual({
      kind: 'cutoff',
      anchor: 'end_of_month',
      op: 'lte',
    });
    expect(relValue('due <= endOfYear()')).toEqual({
      kind: 'cutoff',
      anchor: 'end_of_year',
      op: 'lte',
    });
  });

  it('every range operator folds into the cutoff (`<`, `>`, `<=`, `>=`)', () => {
    expect((relValue('updated < startOfDay()') as { op: string }).op).toBe(
      'lt',
    );
    expect((relValue('updated > startOfDay()') as { op: string }).op).toBe(
      'gt',
    );
    expect((relValue('updated <= startOfDay()') as { op: string }).op).toBe(
      'lte',
    );
  });

  it('equality against a relative instant refuses (needs a range operator)', () => {
    const out = transpileJql('updated = -7d', ctx, 'quickfilter');

    expect(out.board.ok).toBe(false);
    expect((out.board as { reason: string }).reason).toContain(
      'range operator',
    );
  });
});

describe('single-select / radio custom fields (option label → stored id)', () => {
  const optionCtx = buildTranspileContext({
    projectKey: 'KAN',
    statusRows: [],
    priorityRows: [],
    issueTypeRows: [],
    userRows: [],
    customFieldRows: [
      row('customfield_10300', 'sel-target', {
        outcome: 'custom_field',
        field_key: 'cf_customfield_10300',
        field_type: 'select',
        name: 'Region',
      }),
      row('customfield_10301', 'radio-target', {
        outcome: 'custom_field',
        field_key: 'cf_customfield_10301',
        field_type: 'radio',
        name: 'Tier',
      }),
      row('customfield_10302', 'ms-target', {
        outcome: 'custom_field',
        field_key: 'cf_customfield_10302',
        field_type: 'multiselect',
        name: 'Tags',
      }),
      row('customfield_10303', 'noopt-target', {
        outcome: 'custom_field',
        field_key: 'cf_customfield_10303',
        field_type: 'select',
        name: 'Unloaded',
      }),
    ],
    customFieldOptions: {
      'sel-target': [
        { value: 'opt-eu', label: 'EU' },
        { value: 'opt-us', label: 'US' },
      ],
      'radio-target': [
        { value: 'opt-gold', label: 'Gold' },
        { value: 'opt-silver', label: 'Silver' },
      ],
    },
  });

  it('a select `=` clause emits the option ID the bag stores, in both dialects', () => {
    const out = transpileJql('cf[10300] = "EU"', optionCtx, 'quickfilter');

    expect(out.board).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [
          { field: 'cf_customfield_10300', operator: 'eq', value: 'opt-eu' },
        ],
      },
    });
    expect(out.filters).toEqual({
      ok: true,
      query: {
        combinator: 'and',
        rules: [
          { field: 'cf_cf_customfield_10300', operator: 'eq', value: 'opt-eu' },
        ],
      },
    });
  });

  it('a select `in` list maps every label to its id', () => {
    const out = transpileJql(
      'cf[10300] in ("EU", "US")',
      optionCtx,
      'quickfilter',
    );

    expect(out.board.ok).toBe(true);
    expect(
      (out.board as { query: { rules: unknown[] } }).query.rules[0],
    ).toEqual({
      field: 'cf_customfield_10300',
      operator: 'in',
      value: ['opt-eu', 'opt-us'],
    });
  });

  it('a radio field resolves the same way (single stored option id)', () => {
    const out = transpileJql('cf[10301] = "Gold"', optionCtx, 'quickfilter');

    expect(
      (out.board as { query: { rules: unknown[] } }).query.rules[0],
    ).toEqual({
      field: 'cf_customfield_10301',
      operator: 'eq',
      value: 'opt-gold',
    });
  });

  it('an unknown option label refuses rather than emitting a dead id', () => {
    const out = transpileJql('cf[10300] = "APAC"', optionCtx, 'quickfilter');

    expect(out.board.ok).toBe(false);
    expect((out.board as { reason: string }).reason).toContain('not an option');
  });

  it('a select field whose options never loaded refuses (no label→id map)', () => {
    const out = transpileJql(
      'cf[10303] = "Anything"',
      optionCtx,
      'quickfilter',
    );

    expect(out.board.ok).toBe(false);
    expect((out.board as { reason: string }).reason).toContain('not an option');
  });

  it('multiselect refuses with the specific multi-value-bag reason', () => {
    const out = transpileJql('cf[10302] = "urgent"', optionCtx, 'quickfilter');

    expect(out.board.ok).toBe(false);
    expect((out.board as { reason: string }).reason).toContain('element-wise');
  });
});
