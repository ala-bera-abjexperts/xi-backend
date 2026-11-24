/**
 * @fileoverview Stage registry + canonical stage ordering.
 *
 * The run plan is the CANONICAL order filtered to the stages that actually have a
 * registered handler — so as P3–P11 land their handlers, plans extend automatically
 * with zero engine changes. Until any real stage exists, the plan falls back to the
 * `probe` no-op stage so the engine loop is exercisable end-to-end.
 *
 * The canonical orders are valid topological linearizations of the dependency DAGs
 * in `tasks/migration-tool/12-phase-2-run-engine-and-orchestrator.md` — a linear
 * `stage_index` progression over them respects every dependency edge.
 */

import { Injectable } from '@nestjs/common';
import type { IStageHandler } from './stage.interface';

export const PROBE_STAGE = 'probe';

/**
 * Canonical entries whose ABSENCE does not mean entities were skipped — so they must not drag a run
 * down to `partially_completed` (see `missingFor`).
 *
 * - `macros`: there is no macros stage and none is needed. Macros are rendered INLINE while a page
 *   is created — `PageMapper.createPage` → `ContentTransformService.renderBody` → `renderMacro`
 *   (and again on the `page_attachments` / `page_relink` re-render passes). The canonical entry is
 *   vestigial; the work genuinely happens.
 * - `verify`: source-vs-target reconciliation + report (P11). Reporting, not migrating — its absence
 *   means we didn't double-check the counts, not that data is missing.
 *
 * Everything else in a STAGE_ORDER migrates entities: if it has no handler, those entities did not
 * arrive, and the run must say so.
 */
const NON_ENTITY_STAGES: ReadonlySet<string> = new Set(['macros', 'verify']);
/** Present in the canonical map for documentation, but deliberately selected only by repairPlanFor. */
const REPAIR_ONLY_STAGES: ReadonlySet<string> = new Set([
  'confluence_page_hierarchy',
  'confluence_page_repair',
]);

/** Jira project DAG, topologically linearized (P3–P7 + P11 handlers). */
export const JIRA_STAGE_ORDER: readonly string[] = [
  'users',
  // Directly after `users` (members resolve through the user crosswalk) and before `roles`
  // (group actors become live space members through the group crosswalk). Org-scoped, so no
  // dependency on `space`.
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
  // Watcher relations depend on both migrated issues and existing mapped users.
  'watchers',
  'boards',
  // MUST follow `boards` and precede `sprints`: a card is a `board_issue_ranking` row, and sprint
  // membership UPDATES those rows (moveTasksToSprint matches zero rows and silently no-ops if the
  // card was never added). Without this stage the board renders its columns with no cards at all.
  'board_cards',
  'sprints',
  'links',
  'comments',
  'attachments',
  // Source Jira URLs embedded in descriptions/comments can only be repointed after their
  // attachment crosswalk rows exist. Keep this before history so all task content is complete
  // before the terminal audit trail is imported.
  'jira_attachment_relink',
  // Last of the entity stages: history describes what happened to an issue, so it needs the task
  // (and its users) already mapped. Placed after attachments so a failure here cannot cost content.
  'history',
  'verify',
];

/** Confluence space DAG, topologically linearized (P9–P10 + P11 handlers). */
export const CONFLUENCE_STAGE_ORDER: readonly string[] = [
  'users',
  'confluence_space',
  'pages',
  // Page and space watches depend on the target space and page crosswalks.
  'confluence_watchers',
  'page_attachments',
  // No-op for ordinary runs. Dedicated repair runs re-render already mapped pages here.
  'confluence_page_repair',
  // Repair-only: restores the page tree (folders, blog containers, parents, sibling order). After
  // page repair: every tree write moves `updated_at`, which page repair reads as a user edit.
  'confluence_page_hierarchy',
  'page_relink',
  // After page_relink: revisions reuse the page and attachment crosswalks, and the current body
  // must already be final before the trigger-created version row is renumbered to the source's
  // latest. Mirrors where the Jira order puts `history`.
  'page_history',
  'page_labels',
  'page_comments',
  'page_restrictions',
  'macros',
  'verify',
];

@Injectable()
export class StageRegistry {
  private readonly handlers = new Map<string, IStageHandler>();

  register(handler: IStageHandler): void {
    if (this.handlers.has(handler.stage)) {
      throw new Error(`Stage handler "${handler.stage}" is already registered`);
    }

    this.handlers.set(handler.stage, handler);
  }

  get(stage: string): IStageHandler | undefined {
    return this.handlers.get(stage);
  }

  has(stage: string): boolean {
    return this.handlers.has(stage);
  }

  /**
   * Ordered stage plan for a job kind: canonical order filtered to registered
   * handlers; falls back to the probe stage while no real handlers exist.
   */
  planFor(sourceKind: 'jira_project' | 'confluence_space'): string[] {
    const canonical =
      sourceKind === 'jira_project' ? JIRA_STAGE_ORDER : CONFLUENCE_STAGE_ORDER;
    const registered = canonical.filter(
      (stage) => this.handlers.has(stage) && !REPAIR_ONLY_STAGES.has(stage),
    );

    if (registered.length > 0) return registered;

    return this.handlers.has(PROBE_STAGE) ? [PROBE_STAGE] : [];
  }

  /** A Jira repair replays the full registered plan; Confluence has a dedicated narrow repair. */
  repairPlanFor(sourceKind: 'jira_project' | 'confluence_space'): string[] {
    if (sourceKind === 'jira_project') return this.planFor(sourceKind);

    const requested = [
      'users',
      // Must precede page_history: this is where an attachment imported before the history stage
      // existed gets its source id backfilled, and without that its versions are unreachable.
      'page_attachments',
      'confluence_page_repair',
      // After page repair, never before: a tree write moves `updated_at`, and page repair skips any
      // page updated after the source import as user-edited.
      'confluence_page_hierarchy',
      // Gap-filling only. Every revision already in the crosswalk is adopted untouched, and a page
      // the user has edited since import keeps its own numbering.
      'page_history',
      'verify',
    ];

    return requested.filter((stage) => this.handlers.has(stage));
  }

  /**
   * Canonical stages this build has NO handler for — i.e. the work a run of this kind will NOT do.
   *
   * `planFor` filters silently, which is what lets a new stage auto-join the plan the moment it
   * registers. The cost is that a run can complete its whole (short) plan without ever touching the
   * entities a user actually cares about — a Jira run today runs users→issue_types and never reaches
   * `issues`, yet has zero failures and so would finalize as `succeeded`. That is a migration tool
   * reporting success while having migrated no issues.
   *
   * The plan stays permissive; callers use this to be HONEST about what was skipped
   * (`MigrationRunsService.start` freezes it into the snapshot; the tick refuses to call such a run
   * `succeeded`).
   */
  missingFor(sourceKind: 'jira_project' | 'confluence_space'): string[] {
    const canonical =
      sourceKind === 'jira_project' ? JIRA_STAGE_ORDER : CONFLUENCE_STAGE_ORDER;

    return canonical.filter(
      (stage) =>
        !this.handlers.has(stage) &&
        !NON_ENTITY_STAGES.has(stage) &&
        !REPAIR_ONLY_STAGES.has(stage),
    );
  }
}
