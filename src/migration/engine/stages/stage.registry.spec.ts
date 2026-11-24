/**
 * StageRegistry unit tests (pure — no DI).
 *
 * The behaviour under test is the anti-silent-success rule: `planFor` deliberately filters the
 * canonical order down to REGISTERED handlers (so a new stage auto-joins the plan the moment it
 * registers), and the cost of that convenience is that a run can drain its whole short plan without
 * touching the entities anyone cares about. `missingFor` is what keeps the run honest.
 */

import {
  CONFLUENCE_STAGE_ORDER,
  JIRA_STAGE_ORDER,
  PROBE_STAGE,
  StageRegistry,
} from './stage.registry';
import type {
  IStageHandler,
  ItemOutcome,
  ProduceResult,
} from './stage.interface';

const handler = (stage: string): IStageHandler => ({
  stage,
  produce: (): Promise<ProduceResult> =>
    Promise.resolve({ items: [], nextCheckpoint: null, done: true }),
  processItem: (): Promise<ItemOutcome> =>
    Promise.resolve({ kind: 'skipped' as const }),
});

const registryWith = (stages: string[]): StageRegistry => {
  const r = new StageRegistry();

  for (const s of stages) r.register(handler(s));

  return r;
};

describe('StageRegistry', () => {
  describe('register / planFor', () => {
    it('rejects a duplicate stage registration', () => {
      const r = registryWith(['users']);

      expect(() => r.register(handler('users'))).toThrow(/already registered/i);
    });

    it('orders the plan by the canonical order, not registration order', () => {
      const r = registryWith(['issue_types', 'users', 'space']);

      expect(r.planFor('jira_project')).toEqual([
        'users',
        'space',
        'issue_types',
      ]);
    });

    it('runs attachment relinking only after attachments and comments exist', () => {
      const plan = registryWith([
        'jira_attachment_relink',
        'attachments',
        'comments',
      ]).planFor('jira_project');

      expect(plan).toEqual([
        'comments',
        'attachments',
        'jira_attachment_relink',
      ]);
    });

    it('falls back to the probe stage only when no real handler exists', () => {
      const r = registryWith([PROBE_STAGE]);

      expect(r.planFor('jira_project')).toEqual([PROBE_STAGE]);
    });

    it('never selects the probe once a real stage is registered', () => {
      const r = registryWith([PROBE_STAGE, 'users']);

      expect(r.planFor('jira_project')).toEqual(['users']);
    });

    it('returns an empty plan when nothing at all is registered', () => {
      expect(new StageRegistry().planFor('jira_project')).toEqual([]);
    });

    it('replays every registered Jira stage and keeps Confluence repairs targeted', () => {
      const r = registryWith([
        'users',
        'attachments',
        'jira_attachment_relink',
        'page_attachments',
        'confluence_page_repair',
        'confluence_page_hierarchy',
        'page_relink',
        'page_history',
        'verify',
      ]);

      expect(r.repairPlanFor('jira_project')).toEqual([
        'users',
        'attachments',
        'jira_attachment_relink',
        'verify',
      ]);
      // page_history joins the repair plan so a repair BACKFILLS missing revisions and binaries.
      // It must come after page_attachments, which is where an attachment imported before the
      // history stage existed gets the source id its versions are keyed by.
      expect(r.repairPlanFor('confluence_space')).toEqual([
        'users',
        'page_attachments',
        'confluence_page_repair',
        'confluence_page_hierarchy',
        'page_history',
        'verify',
      ]);
    });
  });

  describe('missingFor — the anti-silent-success signal', () => {
    it('reports entity stages that have no handler', () => {
      const r = registryWith(['users', 'space']);
      const missing = r.missingFor('jira_project');

      expect(missing).toContain('issues');
      expect(missing).toContain('custom_fields');
      expect(missing).not.toContain('users');
    });

    it('does NOT report `verify` — reporting is not migrating', () => {
      const r = registryWith(
        [...JIRA_STAGE_ORDER].filter((s) => s !== 'verify'),
      );

      expect(r.missingFor('jira_project')).toEqual([]);
    });

    it('does NOT report `macros` — macros render inline during page creation', () => {
      // Regression guard for the live Confluence track: the canonical `macros` entry is vestigial
      // (PageMapper.createPage → ContentTransformService.renderBody → renderMacro does the work).
      // Counting it as missing would flip a genuinely complete Confluence import from `succeeded`
      // to `partially_completed` and make the tool lie in the other direction.
      const r = registryWith([
        'users',
        'confluence_space',
        'pages',
        'confluence_watchers',
        'page_attachments',
        'page_relink',
        'page_history',
        'page_labels',
        'page_comments',
        'page_restrictions',
      ]);

      expect(r.missingFor('confluence_space')).toEqual([]);
    });

    it('TODAY: the real Confluence handler set reports nothing missing (import is complete)', () => {
      const r = registryWith([
        'users',
        'confluence_space',
        'pages',
        'confluence_watchers',
        'page_attachments',
        'page_relink',
        'page_history',
        'page_labels',
        'page_comments',
        'page_restrictions',
        'verify',
      ]);

      // `verify` now has a handler, so the live Confluence plan gained a terminal reconciliation
      // step. `macros` never joins the plan and never counts as missing — it renders inline during
      // page creation (PageMapper → ContentTransformService.renderBody → renderMacro).
      expect(r.planFor('confluence_space')).toEqual([
        'users',
        'confluence_space',
        'pages',
        'confluence_watchers',
        'page_attachments',
        'page_relink',
        'page_history',
        'page_labels',
        'page_comments',
        'page_restrictions',
        'verify',
      ]);
      expect(r.missingFor('confluence_space')).toEqual([]);
    });

    it('TODAY: every canonical Jira stage has a handler — the run may finally claim `succeeded`', () => {
      // The real registered set as of P7 completion. This is the assertion that flips the Jira track
      // from "reports succeeded having migrated 0 issues" to honest: nothing canonical is skipped.
      const r = registryWith([
        'users',
        'groups',
        'space',
        'roles',
        'status_categories',
        'task_statuses',
        'priorities',
        'resolutions',
        'issue_types',
        'custom_fields',
        'field_groups',
        'workflows',
        'workflow_assignments',
        'issues',
        'watchers',
        'boards',
        'board_cards',
        'sprints',
        'links',
        'comments',
        'attachments',
        'jira_attachment_relink',
        'history',
        'verify',
      ]);

      expect(r.planFor('jira_project')).toEqual([...JIRA_STAGE_ORDER]);
      expect(r.missingFor('jira_project')).toEqual([]);
    });

    it('runs relationship watchers only after their target resources exist', () => {
      expect(JIRA_STAGE_ORDER.indexOf('watchers')).toBe(
        JIRA_STAGE_ORDER.indexOf('issues') + 1,
      );
      expect(CONFLUENCE_STAGE_ORDER.indexOf('confluence_watchers')).toBe(
        CONFLUENCE_STAGE_ORDER.indexOf('pages') + 1,
      );
    });

    it('board_cards is an ENTITY stage — its absence must drag a run to partially_completed', () => {
      // Regression guard for the bug that started this: boards existed, cards did not, and the run
      // still said `succeeded` while every board rendered empty. If `board_cards` ever loses its
      // handler, the run must say so rather than quietly ship empty boards again.
      const r = registryWith(
        [...JIRA_STAGE_ORDER].filter((s) => s !== 'board_cards'),
      );

      expect(r.missingFor('jira_project')).toEqual(['board_cards']);
    });

    it('a partial build still reports its gap (guards the regression this whole rule exists for)', () => {
      const r = registryWith(['users', 'space', 'issues']);

      // Drop the issue-bearing stages and the signal must come back — otherwise a future refactor
      // could silently re-introduce "succeeded with nothing migrated".
      expect(r.missingFor('jira_project')).toContain('boards');
      expect(r.missingFor('jira_project')).toContain('comments');
      expect(r.missingFor('jira_project')).toContain('attachments');
    });

    it('keeps confluence_page_hierarchy out of normal plans and after page repair', () => {
      const r = registryWith([...CONFLUENCE_STAGE_ORDER]);

      expect(r.planFor('confluence_space')).not.toContain(
        'confluence_page_hierarchy',
      );
      expect(r.missingFor('confluence_space')).toEqual([]);
      // Tree writes move `updated_at`; ahead of page repair they would read as user edits.
      expect(CONFLUENCE_STAGE_ORDER.indexOf('confluence_page_repair') + 1).toBe(
        CONFLUENCE_STAGE_ORDER.indexOf('confluence_page_hierarchy'),
      );
    });

    it('reports nothing missing once every entity stage is registered', () => {
      const r = registryWith([...JIRA_STAGE_ORDER]);

      expect(r.missingFor('jira_project')).toEqual([]);
      expect(r.planFor('jira_project')).toEqual([...JIRA_STAGE_ORDER]);
    });

    it('only ever reports stages from the canonical order for that kind', () => {
      const r = registryWith(['users']);

      for (const stage of r.missingFor('confluence_space')) {
        expect(CONFLUENCE_STAGE_ORDER).toContain(stage);
      }
    });
  });
});
